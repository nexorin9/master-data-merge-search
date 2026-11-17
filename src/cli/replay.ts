/**
 * 运维 CLI · replay（单条候选全量重放，Task 53）。
 *
 * 复用而非重写：
 *   - 语料读取 / 内存检索：scripts/run-merge.ts 的 loadCorpus / inMemoryRetriever；
 *   - 判定主路径：src/core/engine/merge-engine.ts 的 evaluateCandidate；
 *   - 对照基线：src/core/engine/baseline.ts 的 baselineConclude（Excel 式字面召回）；
 *   - 写回：src/core/writeback/suggestion-writer.ts 的 writeSuggestion，天然串起
 *     「确认闸门 → 降级闸门 → 重放账本幂等 → 隐私闸门 → 审计 → sink」。
 *
 * 只读纪律：write 默认 false，连写回编排都不进入；显式 --write 时才调用
 * writeSuggestion，且必须 confirmed=true 才可能触碰注入的 writer。
 * 网络出口是注入端口 fetchImpl / evaluate / retrieve，测试永不触网；
 * 缺省的 BLOCKED_REPLAY_FETCH 会以 503 拒绝模型阶段，保证库调用默认零外联。
 */
import { createHash } from 'node:crypto'
import type { AppConfig } from '../shared/config'
import { createTestConfig } from '../shared/config'
import type {
  CandidateRecord, EvidenceItem, MasterDataRecord, MergeConclusion, ModelCallLog,
  ReceiptStatus, RetrievalOutcome,
} from '../core/types'
import {
  evaluateCandidate, type EvaluateResult, type MergeEngineDeps,
} from '../core/engine/merge-engine'
import { baselineConclude } from '../core/engine/baseline'
import { createReplayLedger, type ReplayLedger, type SubmissionKind } from '../core/writeback/idempotency'
import type { FailureKind } from '../core/writeback/receipt'
import {
  writeSuggestion, type WritebackSink,
} from '../core/writeback/suggestion-writer'
import { inMemoryRetriever, loadCorpus } from '../../scripts/run-merge'

export interface ReplayCorpus {
  candidates: CandidateRecord[]
  masterData: MasterDataRecord[]
}

/** 离线占位配置：复用 createTestConfig，只把模型重试数压到 0（阻断型 fetch 下无需退避）。 */
export function createOfflineConfig(): AppConfig {
  const base = createTestConfig()
  return { ...base, llm: { ...base.llm, maxRetries: 0 } }
}

/** 写口与 writeback.WritebackSink 同签名：测试注入假件，绝不触网。 */
export type ReplayWriter = WritebackSink

export interface ReplayDeps {
  config?: AppConfig
  /** 语料读取端口（缺省 loadCorpus）。 */
  corpus?: ReplayCorpus
  /** 固定时钟注入点。 */
  now?: () => string
  /** 检索端口（缺省 inMemoryRetriever(corpus.masterData)）。 */
  retrieve?: (candidate: CandidateRecord) => Promise<RetrievalOutcome>
  /** 引擎端口（缺省 evaluateCandidate，即真正的主路径）。 */
  evaluate?: (candidate: CandidateRecord, deps: MergeEngineDeps) => Promise<EvaluateResult>
  /** 模型阶段 fetch 注入点；缺省用 BLOCKED_REPLAY_FETCH 阻断真实网络。 */
  fetchImpl?: typeof fetch
  /** 是否尝试写回。默认 false（只读）。 */
  write?: boolean
  /** 显式确认闸门；缺省跟随 write（--write 即显式确认），传 false 可验证拦截。 */
  confirmed?: boolean
  /** 写回 sink；仅 write=true 且确认通过后才可能被调用。 */
  writer?: ReplayWriter
  /** 共享重放账本（幂等）；缺省每次新建私有账本。 */
  replayLedger?: ReplayLedger
  /** 写回审计观测口。 */
  auditAppend?: (entry: unknown) => void
  /** 写回阶段轨迹观测口（confirm/degrade/replay/privacy/audit/sink）。 */
  trace?: (stage: string) => void
  batchId?: string
  confirmedBy?: string
  /** prompt / 协议版本标记；变化时结论可能不同。 */
  promptVersion?: string
  /** 主数据版本标记；缺省由 corpus.masterData 的内容哈希派生。 */
  masterDataVersion?: string
}

export interface ReplayWriteResult {
  status: ReceiptStatus
  idempotency_key: string
  submission_kind: SubmissionKind
  sink_calls: number
  kind: FailureKind
  reason?: string
  readable_reason?: string
}

export interface ReplayRetrievalSummary {
  kind: 'retrieved_ok' | 'retrieval_failed'
  hits: number
  domain_mismatch_excluded: number
  record_ids: string[]
  endpoint?: string
  status?: number | null
  message?: string
}

export interface ReplayBaseline {
  action: string
  target_code: string | null
  confidence: number
  hit_count: number
  ambiguous_top_hits: number
}

export interface ReplayResult {
  candidate_id: string
  found: boolean
  conclusion: MergeConclusion | null
  /** 逐字段证据链（来自引擎结论，不另行重算）。 */
  evidence: EvidenceItem[]
  /** 模型调用元数据（来自引擎返回值，不另行重算）。 */
  model_call_logs: ModelCallLog[]
  degraded: boolean
  retrieval: ReplayRetrievalSummary | null
  baseline: ReplayBaseline | null
  context: {
    model: string
    prompt_version: string
    master_data_version: string
    decided_at: string
  }
  /** 可复现性声明：prompt 或主数据版本变化时结果可能不同。 */
  notes: string[]
  write_attempted: boolean
  write_result: ReplayWriteResult | null
  reason?: string
}

/** 缺省模型 fetch：只回 503，不触网；引擎据此走确定性降级。 */
export const BLOCKED_REPLAY_FETCH: typeof fetch = async () =>
  new Response(JSON.stringify({ error: 'replay 未注入模型 fetchImpl，已阻断真实网络请求' }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  })

/** 缺省写口：明确失败，绝不暗度陈仓地写向任何真实端点。 */
export const NOT_CONFIGURED_WRITER: ReplayWriter = async () => ({
  ok: false,
  code: 'WRITEBACK_NOT_CONFIGURED',
  error: 'replay 未注入 writer，已阻断真实网络写回',
})

/** 临时把全局 fetch 换成注入实现，引擎主路径结束后原样恢复。 */
async function withInjectedFetch<T>(
  fetchImpl: typeof fetch | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!fetchImpl) return run()
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

/** 主数据版本指纹：只包含影响判定的字段，逐条顺序稳定。 */
export function masterDataVersion(records: MasterDataRecord[]): string {
  const hash = createHash('sha256')
  for (const record of records) {
    hash.update(`${record.record_id}\u0000${record.code}\u0000${record.version}\u0000${record.status}\n`)
  }
  return hash.digest('hex').slice(0, 12)
}

function retrievalSummary(outcome: RetrievalOutcome): ReplayRetrievalSummary {
  if (outcome.kind === 'retrieval_failed') {
    return {
      kind: 'retrieval_failed',
      hits: 0,
      domain_mismatch_excluded: 0,
      record_ids: [],
      endpoint: outcome.endpoint,
      status: outcome.status,
      message: outcome.message,
    }
  }
  return {
    kind: 'retrieved_ok',
    hits: outcome.hits,
    domain_mismatch_excluded: outcome.domain_mismatch_excluded,
    record_ids: outcome.records.map((r) => r.record_id),
  }
}

/** 人类可读重放单（CLI 非 --json 输出）。 */
export function replayToText(result: ReplayResult): string {
  if (!result.found || !result.conclusion) {
    return `重放失败：语料中不存在候选 ${result.candidate_id}`
  }
  const c = result.conclusion
  const lines = [
    `重放候选：${result.candidate_id}（${c.domain}）`,
    `结论动作：${c.action} / 目标 code：${c.target_code ?? '—'} / 置信度：${c.confidence.toFixed(4)}`,
    `理由：${c.rationale || '—'}${c.reason_fallback ? `（兜底：${c.reason_fallback}）` : ''}`,
    `存疑原因：${c.uncertain_reason ?? '—'} / 降级：${result.degraded ? '是' : '否'}`,
    `逐字段证据（${result.evidence.length} 条）：`,
    ...result.evidence.map((e) => `  - ${e.record_id}.${e.field}: ${e.candidate_value} → ${e.matched_value}`),
    `模型调用元数据（${result.model_call_logs.length} 条）：`,
    ...result.model_call_logs.map((l) =>
      `  - ${l.model_call_id} / ${l.model} / prompt_hash=${l.prompt_hash} / ${l.finish_reason} / schema_valid=${l.schema_valid} / ${l.latency_ms}ms`,
    ),
    `对照基线：${result.baseline?.action ?? '—'} / ${result.baseline?.target_code ?? '—'}（命中 ${result.baseline?.hit_count ?? 0} 条）`,
    `可复现上下文：模型 ${result.context.model} / prompt ${result.context.prompt_version} / 主数据 ${result.context.master_data_version} / 时钟 ${result.context.decided_at}`,
    `写回：${result.write_attempted ? `已尝试（${result.write_result?.status ?? '—'}，sink 调用 ${result.write_result?.sink_calls ?? 0} 次）` : '未执行（只读）'}`,
    ...result.notes.map((n) => `注：${n}`),
  ]
  return lines.join('\n')
}

/**
 * 纯函数重放：检索 → 引擎主路径 → 证据链 / 模型调用元数据 → 可选的受闸写回。
 * 同输入（含注入的固定时钟、检索、fetch、语料）两次调用结果逐字段一致。
 */
export async function runReplay(
  candidateId: string,
  deps: ReplayDeps = {},
): Promise<ReplayResult> {
  const now = deps.now ?? (() => new Date().toISOString())
  const config = deps.config ?? createOfflineConfig()
  const corpus = deps.corpus ?? loadCorpus()
  const candidate = corpus.candidates.find((c) => c.candidate_id === candidateId)
  if (!candidate) {
    return {
      candidate_id: candidateId,
      found: false,
      conclusion: null,
      evidence: [],
      model_call_logs: [],
      degraded: false,
      retrieval: null,
      baseline: null,
      context: {
        model: config.llm.model,
        prompt_version: deps.promptVersion ?? `merge-protocol-v1:${config.llm.model}`,
        master_data_version: deps.masterDataVersion ?? masterDataVersion(corpus.masterData),
        decided_at: now(),
      },
      notes: ['语料中不存在该 candidate_id，未执行检索与判定。'],
      write_attempted: false,
      write_result: null,
      reason: '候选不存在',
    }
  }

  // 检索一次并把 outcome 缓存给引擎：基线与主路径看到同一快照，杜绝两次检索漂移。
  const retrieve = deps.retrieve ?? inMemoryRetriever(corpus.masterData)
  const outcome = await retrieve(candidate)
  const cachedRetrieve = async (): Promise<RetrievalOutcome> => outcome
  const engineDeps: MergeEngineDeps = { config, retrieve: cachedRetrieve, now }
  const evaluate = deps.evaluate ?? evaluateCandidate
  const evaluated = await withInjectedFetch(
    deps.fetchImpl ?? BLOCKED_REPLAY_FETCH,
    () => evaluate(candidate, engineDeps),
  )

  const pool = outcome.kind === 'retrieved_ok' ? outcome.records : []
  const base = baselineConclude(candidate, pool)
  const baseline: ReplayBaseline = {
    action: base.action,
    target_code: base.target_code,
    confidence: base.confidence,
    hit_count: base.hit_count,
    ambiguous_top_hits: base.ambiguous_top_hits,
  }
  const promptVersion = deps.promptVersion ?? `merge-protocol-v1:${config.llm.model}`
  const dataVersion = deps.masterDataVersion ?? masterDataVersion(corpus.masterData)
  const context = {
    model: config.llm.model,
    prompt_version: promptVersion,
    master_data_version: dataVersion,
    decided_at: evaluated.conclusion.decided_at ?? now(),
  }

  // 写回：默认不进入；进入时由 writeSuggestion 串起确认/降级/幂等/隐私/审计/sink。
  // --write 本身就是显式确认，故 confirmed 缺省跟随 write；显式传 false 可验证闸门拦截。
  let writeAttempted = false
  let writeResult: ReplayWriteResult | null = null
  if (deps.write === true) {
    writeAttempted = true
    const ledger = deps.replayLedger ?? createReplayLedger({ now })
    // 外部注入的写口是系统边界：void 返回按「已接受」归一化，避免下游读取 undefined 状态。
    const sink: WritebackSink = deps.writer
      ? async (...args) => {
        const result = await deps.writer!(...args)
        return result && typeof result === 'object'
          ? result
          : { ok: true, status: 200, data: {} }
      }
      : NOT_CONFIGURED_WRITER
    const written = await writeSuggestion(evaluated.conclusion, {
      sink,
      now,
      replayLedger: ledger,
      auditAppend: deps.auditAppend,
      trace: deps.trace,
    }, {
      confirmed: deps.confirmed ?? (deps.write === true),
      batchId: deps.batchId,
      confirmedBy: deps.confirmedBy,
    })
    writeResult = {
      status: written.status,
      idempotency_key: written.idempotency_key,
      submission_kind: written.submission_kind,
      sink_calls: written.sink_calls,
      kind: written.kind,
      reason: written.reason,
      readable_reason: written.readable_reason,
    }
  }

  const notes = [
    `结论与固定时钟 ${context.decided_at}、模型 ${context.model}、prompt 版本 ${promptVersion}、主数据版本 ${dataVersion} 绑定；若 prompt 或主数据版本变化，本次结论可能不同。`,
  ]
  if (evaluated.degraded) notes.push('本次引擎走降级路径，结论标记为 degraded，写回闸门会拒绝。')
  if (!writeAttempted) notes.push('默认只读：未执行任何写回。')

  return {
    candidate_id: candidateId,
    found: true,
    conclusion: evaluated.conclusion,
    evidence: evaluated.conclusion.evidence,
    model_call_logs: evaluated.model_call_logs,
    degraded: evaluated.degraded,
    retrieval: retrievalSummary(outcome),
    baseline,
    context,
    notes,
    write_attempted: writeAttempted,
    write_result: writeResult,
  }
}
