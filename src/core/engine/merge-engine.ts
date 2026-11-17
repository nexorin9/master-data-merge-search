/**
 * 归并判定接入 · 主路径编排（Task 3 / 27 / 19）。
 *
 * 把「检索结果 → 唯一性闸门 → 上下文装配 → ModelGateway 结构化归并 →
 * 证据链 → 三态结论」串成一条可跑的主路径，产出对齐 spec.md §2 的可核对结论。
 * 模型不可达 / 结构化校验失败时走降级入口，绝不产出可写回结论。
 *
 * 关键纪律：
 *   - 检索失败（retrieval_failed）显式报错并转 uncertain，绝不用空结果冒充无近似项；
 *   - 闸门（多义 / 缺字段 / 停用 / 版本冲突）判定优先于模型结论；
 *   - json_schema 端点不支持 → 降级 json_object + 本地校验；校验失败重试 1 次仍不过 → 转人工（降级）；
 *   - 证据越界引用一律拒绝出结论并记越界事件；
 *   - 任何降级结论 degraded=true 且在写回层被拒。
 */
import type { AppConfig } from '../../shared/config'
import { maskSecret } from '../../shared/config'
import type {
  CandidateRecord, MasterDataRecord, MergeConclusion, RawModelConclusion,
  ContextSnapshotEntry, RetrievalOutcome,
} from '../types'
import { decideByGate } from './gate-decision'
import { applyDecisionGates, conclusionFromModel } from './merge-decision'
import { buildEvidenceChain, rejectOutOfBounds } from './evidence'
import { makeDegradeConclusion, rejectWritebackIfDegraded, type DegradeReason } from './degrade'
import { compareFields } from './field-diff'
import { createModelGateway, type GatewayResult, type ChatCompletionResponse } from '../model/model-gateway'
import { MERGE_RESULT_JSON_SCHEMA, buildMergeProtocol, protocolPromptText } from '../model/merge-protocol'
import {
  parseModelJson, validateConclusion, validationErrorSummary, needsSchemaDowngrade,
} from '../model/merge-validator'
import { makeCallLog, promptHash as hashOf } from '../model/call-log'
import type { ModelCallLog } from '../types'
import { createContextBucket } from '../retrieval/context-bucket'
import type { RetrieverDeps } from '../retrieval/retriever'
import { createRetriever } from '../retrieval/retriever'

/** 引擎依赖：检索驱动 + 配置 + 可选时钟。全部注入，测试无需网络与 MDM。 */
export interface MergeEngineDeps {
  config: AppConfig
  retrieve: (candidate: CandidateRecord) => Promise<RetrievalOutcome>
  now?: () => string
}

export interface EvaluateResult {
  conclusion: MergeConclusion
  model_call_logs: ModelCallLog[]
  degraded: boolean
}

/** 从检索 outcome 取主数据池；失败返回 null（调用方据此显式报错）。 */
function poolOf(outcome: RetrievalOutcome): MasterDataRecord[] | null {
  return outcome.kind === 'retrieved_ok' ? outcome.records : null
}

/** 把检索记录入上下文桶并取快照（用于 prompt_hash 与协议视图）。 */
function snapshotOf(candidate: CandidateRecord, pool: MasterDataRecord[], nowMs: number): ContextSnapshotEntry[] {
  const bucket = createContextBucket({ crossBatch: false, now: () => nowMs })
  bucket.ingestDomain(candidate.domain, pool, [candidate.name, candidate.insurance_code ?? ''])
  return bucket.snapshot()
}

/** 检索失败结论：显式 uncertain + 统计，绝不给 create/merge。 */
function retrievalFailedConclusion(candidate: CandidateRecord, outcome: RetrievalOutcome): MergeConclusion {
  return {
    candidate_id: candidate.candidate_id,
    domain: candidate.domain,
    action: 'uncertain',
    target_code: null,
    confidence: 0,
    rationale: '',
    evidence: [],
    uncertain_reason: '检索失败',
    missing_fields: [],
    degraded: false,
    source: 'model',
    reason_fallback: outcome.kind === 'retrieval_failed'
      ? `检索失败（${outcome.endpoint} ${outcome.status ?? 'NETWORK'}）：${outcome.message}`
      : '检索失败',
    statistics: outcome.kind === 'retrieval_failed'
      ? { raw_hit_count: 0 }
      : { raw_hit_count: outcome.hits, domain_mismatch_excluded: outcome.domain_mismatch_excluded },
  }
}

/** 从模型 content 解析 + 校验为 RawModelConclusion；失败返回错误摘要。 */
function parseValidated(content: string): { ok: true; conclusion: RawModelConclusion } | { ok: false; errors: string[] } {
  const parsed = parseModelJson(content)
  if (!parsed.ok) return { ok: false, errors: [parsed.error ?? 'JSON 解析失败'] }
  const validated = validateConclusion(parsed.value)
  if (!validated.ok) return { ok: false, errors: validated.errors }
  return { ok: true, conclusion: validated.conclusion! }
}

export interface ModelPhaseResult {
  kind: 'model' | 'degrade'
  raw?: RawModelConclusion
  degradeReason?: DegradeReason
  logs: ModelCallLog[]
  promptHash: string
  attempts: number
  schemaDowngraded: boolean
}

/**
 * 模型阶段：默认 json_schema；端点不支持 → json_object；schema 校验失败重试 1 次
 * （带校验错误摘要进提示）；仍失败 → 降级转人工。任何网络/超时/5xx 失败 → 降级。
 */
async function runModelPhase(
  config: AppConfig,
  candidate: CandidateRecord,
  pool: MasterDataRecord[],
  now: () => string,
): Promise<ModelPhaseResult> {
  const gateway = createModelGateway(config)
  const snapshot = snapshotOf(candidate, pool, Date.now())
  const view = buildMergeProtocol(candidate, snapshot)
  const prompt = protocolPromptText(view)
  const logs: ModelCallLog[] = []
  const started = Date.now()
  let schemaDowngraded = false
  let attempts = 0

  /** 发一次请求（含可选降级 response_format 与校验错误提示）。 */
  async function call(jsonSchema: unknown, errorHint?: string): Promise<GatewayResult<ChatCompletionResponse>> {
    const request = gateway.buildRequest(candidate, snapshot, jsonSchema)
    if (errorHint) {
      request.messages = [
        ...request.messages,
        { role: 'user', content: errorHint },
      ]
    }
    return gateway.chatWithRetry(request)
  }

  // 第一次：json_schema
  let res = await call(MERGE_RESULT_JSON_SCHEMA)
  attempts += 1

  // 端点不支持 json_schema → 降级 json_object 重试
  if (!res.ok && res.error.kind === 'client_error' && needsSchemaDowngrade(res.error.status ?? 0, res.error.message)) {
    schemaDowngraded = true
    res = await call(undefined) // 无 schema → json_object
    attempts += 1
  }

  // 网络/超时/5xx/429/cancelled 失败 → 降级
  if (!res.ok) {
    const reason: DegradeReason = res.error.kind === 'timeout' ? '超时' : '模型不可达'
    logs.push(makeCallLog({
      candidate_id: candidate.candidate_id,
      model: config.llm.model,
      base_url: config.llm.baseUrl,
      api_key_masked: maskSecret(config.llm.apiKey),
      prompt,
      latency_ms: Date.now() - started,
      finish_reason: 'failed',
      schema_valid: false,
      degraded_reason: res.degraded_reason,
      now,
    }))
    return { kind: 'degrade', degradeReason: reason, logs, promptHash: hashOf(prompt), attempts, schemaDowngraded }
  }

  // 解析 + 校验；失败重试 1 次（带错误摘要）；仍失败 → schema 校验失败降级
  let parsed = parseValidated(res.data.content)
  if (!parsed.ok) {
    const hint = validationErrorSummary(parsed.errors)
    const retry = await call(schemaDowngraded ? undefined : MERGE_RESULT_JSON_SCHEMA, hint)
    attempts += 1
    if (retry.ok) parsed = parseValidated(retry.data.content)
    if (!parsed.ok) {
      logs.push(makeCallLog({
        candidate_id: candidate.candidate_id,
        model: config.llm.model,
        base_url: config.llm.baseUrl,
        api_key_masked: maskSecret(config.llm.apiKey),
        prompt,
        latency_ms: Date.now() - started,
        finish_reason: 'schema_invalid',
        schema_valid: false,
        degraded_reason: 'schema 校验失败',
        now,
      }))
      return { kind: 'degrade', degradeReason: 'schema 校验失败', logs, promptHash: hashOf(prompt), attempts, schemaDowngraded }
    }
  }

  logs.push(makeCallLog({
    candidate_id: candidate.candidate_id,
    model: config.llm.model,
    base_url: config.llm.baseUrl,
    api_key_masked: maskSecret(config.llm.apiKey),
    prompt,
    input_tokens: res.data.usage?.prompt_tokens ?? 0,
    output_tokens: res.data.usage?.completion_tokens ?? 0,
    latency_ms: Date.now() - started,
    finish_reason: res.data.finish_reason,
    schema_valid: true,
    degraded_reason: schemaDowngraded ? 'json_schema_unsupported' : null,
    now,
  }))
  return { kind: 'model', raw: parsed.conclusion, logs, promptHash: hashOf(prompt), attempts, schemaDowngraded }
}

/**
 * 评估单条候选：检索 → 闸门 → 模型/降级 → 证据链 → 三态结论。
 */
export async function evaluateCandidate(
  candidate: CandidateRecord,
  deps: MergeEngineDeps,
): Promise<EvaluateResult> {
  const now = deps.now ?? (() => new Date().toISOString())
  const outcome = await deps.retrieve(candidate)

  // 1) 检索失败：显式报错，绝不冒充无近似项
  if (outcome.kind === 'retrieval_failed') {
    return { conclusion: retrievalFailedConclusion(candidate, outcome), model_call_logs: [], degraded: false }
  }
  const pool = outcome.records

  // 2) 闸门判定（确定性，优先于模型）
  const gate = decideByGate(candidate, pool)

  // 3) 闸门已能定案的多义 / 缺字段：直接返回，不调模型（模型也无法改变规则裁决）
  if (gate.gate === 'ambiguous' || gate.gate === 'missing-fields' || gate.gate === 'dirty') {
    const c = { ...gate.conclusion, decided_at: now() }
    return { conclusion: c, model_call_logs: [], degraded: false }
  }

  // 4) 无近似项 / 全停用：闸门已给结论（create 或 停用 uncertain），交模型仅做确认会徒增成本，
  //    这里按确定性直接出结论（与 spec「医保码/复合键唯一命中走确定性通道」一致）。
  if (gate.gate === 'no-match') {
    const c = { ...gate.conclusion, decided_at: now() }
    return { conclusion: c, model_call_logs: [], degraded: false }
  }

  // 5) 唯一命中：装配上下文 → 调模型 → 证据链 → 三态守门
  const modelPhase = await runModelPhase(deps.config, candidate, pool, now)
  if (modelPhase.kind === 'degrade') {
    const { conclusion } = makeDegradeConclusion(
      candidate, pool, modelPhase.degradeReason ?? '模型不可达',
      { retries: modelPhase.attempts - 1, now },
    )
    conclusion.decided_at = now()
    return { conclusion, model_call_logs: modelPhase.logs, degraded: true }
  }

  const raw = modelPhase.raw!
  let conclusion = conclusionFromModel(candidate, raw)
  conclusion.decided_at = now()
  conclusion.retrieved_record_ids = pool.map((r) => r.record_id)

  // 证据链：越界拒绝 + 值回填 + 字段一致性
  const evidenceResult = buildEvidenceChain(raw.evidence, pool, candidate.candidate_id, { now })
  conclusion.evidence = evidenceResult.evidence
  conclusion = rejectOutOfBounds(conclusion, evidenceResult)
  conclusion.statistics = {
    ...conclusion.statistics,
    raw_hit_count: pool.length,
    out_of_snapshot_refs: evidenceResult.out_of_bounds.length,
  }
  if (evidenceResult.mismatches.length > 0) {
    conclusion.reason_fallback = conclusion.reason_fallback
      ?? `证据链回填 ${evidenceResult.mismatches.length} 条主数据实际值`
  }

  // 字段级对照摘要（供 UI 复用同一口径）
  const topRecord = gate.gate === 'unique' ? gate.matched[0] : undefined
  if (topRecord) conclusion.field_diffs = compareFields(candidate, topRecord)

  // 三态守门：闸门优先 + 置信度阈值 + 证据完整性 + reason 枚举
  const gateOutcome: import('../types').GateOutcome = { kind: 'unique', record: gate.matched[0] ?? pool[0] }
  conclusion = applyDecisionGates(conclusion, raw, {
    candidate,
    gate: gateOutcome,
    matched: gate.matched,
  })
  conclusion.decided_at = now()
  conclusion.source = 'model'

  // 写回闸门自检：任何结论在写回层还需再过一次；此处仅保证非模型结论不会误放行。
  void rejectWritebackIfDegraded(conclusion)

  return { conclusion, model_call_logs: modelPhase.logs, degraded: false }
}

/** 从 MDM 客户端构造检索函数的便捷工厂（Task 3 过渡实现 → 正式契约）。 */
export function retrieverFromDeps(deps: RetrieverDeps, options: { limit?: number } = {}) {
  const retriever = createRetriever(deps, options)
  return (candidate: CandidateRecord) => retriever.retrieve(candidate)
}
