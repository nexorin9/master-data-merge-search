/**
 * 主干最窄端到端入口（Task 3）。
 *
 * 一条命令跑完「读候选批次 → 检索院内主数据 → 归并判定 → 输出带逐字段证据的
 * 归并建议 JSON」，落盘到 outputs/<sample-batch>/suggestions.json。
 *
 * 检索库与候选批次来自数据获取任务产出的基准语料（tests/fixtures/corpus/），
 * 以内存检索驱动注入引擎；模型一等能力由归并引擎簇的 ModelGateway 提供，
 * 未配置真实端点时引擎自动走确定性降级路径（结论 uncertain + degraded，
 * 不写回），故本脚本在纯离线环境也能产出可核对产物，且诚实标注降级状态。
 *
 * 用法：
 *   pnpm tsx scripts/run-merge.ts                       # 默认跑前 N 条候选
 *   pnpm tsx scripts/run-merge.ts --limit 8             # 指定条数
 *   pnpm tsx scripts/run-merge.ts --out outputs/demo    # 指定输出目录
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestConfig } from '../src/shared/config'
import { evaluateCandidate } from '../src/core/engine/merge-engine'
import { buildQueryTerms, queryTermList } from '../src/core/normalize/query-builder'
import { pinyinInitials } from '../src/core/normalize/pinyin'
import type { CandidateRecord, MasterDataRecord, RetrievalOutcome, MergeConclusion } from '../src/core/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

export interface RunMergeOptions {
  limit?: number
  outDir?: string
  now?: () => string
}

export interface SuggestionWire {
  candidate_id: string
  domain: string
  action: MergeConclusion['action']
  target_code: string | null
  confidence: number
  rationale: string
  evidence: Array<{ record_id: string; field: string; candidate_value: string; matched_value: string }>
  uncertain_reason: MergeConclusion['uncertain_reason']
  degraded: boolean
  decided_at: string
}

/** 从语料文件读取候选与主数据。 */
export function loadCorpus(corpusDir = resolve(ROOT, 'tests/fixtures/corpus')): {
  candidates: CandidateRecord[]
  masterData: MasterDataRecord[]
} {
  const candidates = JSON.parse(readFileSync(resolve(corpusDir, 'candidates.json'), 'utf8')) as CandidateRecord[]
  const masterData = JSON.parse(readFileSync(resolve(corpusDir, 'master-data.json'), 'utf8')) as MasterDataRecord[]
  return { candidates, masterData }
}

/**
 * 内存检索驱动：按四路检索词对主数据做「域内 + 字段命中」召回。
 * 这是 Task 3 的过渡实现（下一个任务升级为 MDM 三端点正式契约），
 * 单条检索失败显式返回 retrieval_failed，不以空结果冒充无近似项。
 */
export function inMemoryRetriever(pool: MasterDataRecord[]): (c: CandidateRecord) => Promise<RetrievalOutcome> {
  return async (candidate) => {
    try {
      const terms = queryTermList(buildQueryTerms(candidate)).filter(Boolean)
      const byId = new Map<string, MasterDataRecord>()
      let domainMismatch = 0
      for (const record of pool) {
        if (record.domain !== candidate.domain) { domainMismatch += 1; continue }
        const haystack = [
          record.name, record.insurance_code, record.code,
          pinyinInitials(record.name ?? ''),
        ].join(' ').toLowerCase()
        if (terms.some((q) => haystack.includes(q.toLowerCase()))) byId.set(record.record_id, record)
      }
      const records = [...byId.values()]
      return { kind: 'retrieved_ok', records, hits: records.length, domain_mismatch_excluded: domainMismatch }
    } catch (err) {
      return {
        kind: 'retrieval_failed',
        endpoint: 'memory://corpus/master-data',
        status: null,
        retries: 0,
        message: err instanceof Error ? err.message : String(err),
      }
    }
  }
}

/** 把引擎结论收敛为 spec.md §2 的归并建议 JSON 线格式。 */
export function toSuggestionWire(c: MergeConclusion): SuggestionWire {
  return {
    candidate_id: c.candidate_id,
    domain: c.domain,
    action: c.action,
    target_code: c.target_code,
    confidence: Number(c.confidence.toFixed(4)),
    rationale: c.rationale,
    evidence: c.evidence.map((e) => ({
      record_id: e.record_id,
      field: e.field,
      candidate_value: e.candidate_value,
      matched_value: e.matched_value,
    })),
    uncertain_reason: c.uncertain_reason,
    degraded: c.degraded,
    decided_at: c.decided_at ?? '',
  }
}

export interface RunMergeResult {
  batchId: string
  outFile: string
  suggestions: SuggestionWire[]
  degradedCount: number
  actionCounts: Record<string, number>
}

/** 主流程：跑一批候选，落盘 suggestions.json，返回可断言摘要。 */
export async function runMerge(options: RunMergeOptions = {}): Promise<RunMergeResult> {
  const { candidates, masterData } = loadCorpus()
  const limit = Math.max(1, options.limit ?? 8)
  const batch = candidates.slice(0, limit)
  const batchId = 'sample-batch'
  const outDir = options.outDir ?? resolve(ROOT, 'outputs', batchId)
  const outFile = resolve(outDir, 'suggestions.json')
  const retrieve = inMemoryRetriever(masterData)
  const config = createTestConfig()

  const suggestions: SuggestionWire[] = []
  let degradedCount = 0
  const actionCounts: Record<string, number> = { create: 0, merge: 0, uncertain: 0 }

  for (const candidate of batch) {
    const result = await evaluateCandidate(candidate, {
      config,
      retrieve,
      now: options.now ?? (() => new Date().toISOString()),
    })
    suggestions.push(toSuggestionWire(result.conclusion))
    actionCounts[result.conclusion.action] = (actionCounts[result.conclusion.action] ?? 0) + 1
    if (result.degraded) degradedCount += 1
  }

  const payload = {
    batch_id: batchId,
    generated_at: (options.now ?? (() => new Date().toISOString()))(),
    source: 'tests/fixtures/corpus (synthetic-simulator)',
    model_endpoint: config.llm.baseUrl,
    note: '未配置真实模型端点时引擎走确定性降级，degraded=true 的结论只作待人工处理，不可写回',
    total: suggestions.length,
    action_counts: actionCounts,
    degraded_count: degradedCount,
    suggestions,
  }

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
  writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8')

  return { batchId, outFile, suggestions, degradedCount, actionCounts }
}

/** CLI 入口：被 `pnpm tsx scripts/run-merge.ts` 直接调用。 */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const limitIdx = args.indexOf('--limit')
  const outIdx = args.indexOf('--out')
  const options: RunMergeOptions = {
    limit: limitIdx >= 0 ? Number.parseInt(args[limitIdx + 1], 10) : 8,
    outDir: outIdx >= 0 ? resolve(ROOT, args[outIdx + 1]) : undefined,
  }
  const r = await runMerge(options)
  const counts = Object.entries(r.actionCounts).map(([k, v]) => `${k}=${v}`).join(' ')
  process.stdout.write(`归并切片完成：${r.suggestions.length} 条建议（${counts}），降级 ${r.degradedCount} 条\n`)
  process.stdout.write(`产物：${r.outFile}\n`)
}

// 仅当作为主模块运行时执行 main（import 进测试时静默）。
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`run-merge 失败：${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
