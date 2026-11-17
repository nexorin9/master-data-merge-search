/**
 * 检索结果入桶与快照裁剪策略（Task 26）。
 *
 * 每个 domain 一个桶；候选批次单独一桶；入桶默认 append-self；快照历史上限
 * 400 条，超限按入桶时间淘汰最旧。跨批对照开关决定是否把上一批命中注入本批。
 * 快照条目保留来源（domain / record_id / 检索词 / 命中字段），供证据链引用。
 */
import { CONFIG_CROSS_BATCH_COMPARE, CONFIG_HISTORY_LIMIT } from '../constants'
import { createContextRegistry, contextBucketName } from './context-registry'
import type {
  ContextEntry, ContextSnapshotEntry, CandidateRecord, Domain, IngestStrategy, MasterDataRecord,
} from '../types'

export interface ContextBucket {
  ingestDomain(domain: Domain, records: MasterDataRecord[], queryTerms: string[]): void
  ingestCandidate(candidate: CandidateRecord): void
  snapshot(): ContextSnapshotEntry[]
  setCrossBatch(enabled: boolean): void
  isCrossBatchEnabled(): boolean
}

/** 主数据记录 → 带来源追溯的上下文条目。 */
export function recordToContextEntry(
  record: MasterDataRecord,
  queryTerms: string[],
  ingestedAt: number,
): ContextEntry {
  // 命中字段：第一条非空且能与检索词对上的字段。
  const matchedField = queryTerms.find((q) => q && (
    record.insurance_code === q || record.name === q || record.code === q
  )) ? 'name/insurance_code' : 'name'
  return {
    key: contextBucketName(record.domain),
    text: [
      `编码=${record.code}`, `名称=${record.name}`,
      record.spec ? `规格=${record.spec}` : '',
      record.dosage_form ? `剂型=${record.dosage_form}` : '',
      record.unit ? `单位=${record.unit}` : '',
      record.insurance_code ? `医保码=${record.insurance_code}` : '',
      `状态=${record.status}`, `版本=${record.version}`,
    ].filter(Boolean).join('；'),
    domain: record.domain,
    record_id: record.record_id,
    query_term: queryTerms[0] ?? '',
    matched_field: matchedField,
    ingested_at: ingestedAt,
  }
}

/** 候选 → 上下文条目（候选批次桶）。 */
export function candidateToContextEntry(candidate: CandidateRecord, ingestedAt: number): ContextEntry {
  return {
    key: contextBucketName('candidate'),
    text: `${candidate.name}｜${candidate.spec ?? ''}｜${candidate.insurance_code ?? ''}`,
    domain: candidate.domain,
    record_id: candidate.candidate_id,
    ingested_at: ingestedAt,
  }
}

export function createContextBucket(
  options: {
    historyLimit?: number
    crossBatch?: boolean
    strategy?: IngestStrategy
    now?: () => number
  } = {},
): ContextBucket {
  const registry = createContextRegistry({ historyLimit: options.historyLimit ?? CONFIG_HISTORY_LIMIT })
  let crossBatch = options.crossBatch ?? CONFIG_CROSS_BATCH_COMPARE
  const strategy = options.strategy ?? 'append-self'
  const clock = options.now ?? (() => Date.now())

  return {
    ingestDomain(domain, records, queryTerms) {
      // 关闭跨批对照时本批用 replace-self（上一批不注入）；否则 append-self。
      const effective: IngestStrategy = crossBatch ? strategy : 'replace-self'
      registry.ingest(
        contextBucketName(domain),
        records.map((r) => recordToContextEntry(r, queryTerms, clock())),
        effective,
      )
    },
    ingestCandidate(candidate) {
      registry.ingest(contextBucketName('candidate'), [candidateToContextEntry(candidate, clock())], 'append-self')
    },
    snapshot() {
      // 关跨批时只取当前批（每桶最新 historyLimit 内已被 replace 清掉旧批），
      // 开跨批时全桶快照。两种情形都通过 registry 的 snapshot 深克隆返回。
      return registry.snapshot()
    },
    setCrossBatch(enabled) { crossBatch = enabled },
    isCrossBatchEnabled() { return crossBatch },
  }
}
