/**
 * 主数据归并检索系统 · 领域类型地契。
 *
 * 全部 core 模块与 renderer / cli / main 共用本文件定义的类型，任何模块不得
 * 私自另立同义结构。字段命名与 spec.md §2 最小数据格式逐字段对齐：
 *   - 候选批次读入候选字段
 *   - 已有主数据记录字段
 *   - 归并结论（模型产出 + 规则层附加字段）
 */

/** 候选与主数据的四个域。 */
export type Domain = 'drug' | 'fee_item' | 'department' | 'exam'

export const DOMAINS: readonly Domain[] = ['drug', 'fee_item', 'department', 'exam'] as const

/** 主数据记录的业务状态。 */
export type RecordStatus = '启用' | '停用'

/** 三态归并动作。 */
export type Action = 'create' | 'merge' | 'uncertain'

/** 存疑原因枚举（spec.md §2）：模型产出 + 规则层兜底齐备。 */
export type UncertainReason =
  | '多义命中'
  | '关键字段缺失'
  | '无近似项'
  | '版本冲突'
  | '模型输出不合法'
  | '检索失败'
  | '模型不可用'
  | '命中记录均已停用'
  | null

/** 字段级对照的种类。 */
export type DiffKind = 'exact' | 'normalized' | 'conflict' | 'missing' | 'absent'

/** 候选批次读入记录（spec.md §2）。必填位与可选位分开标注。 */
export interface CandidateRecord {
  candidate_id: string
  domain: Domain
  name: string
  spec?: string
  dosage_form?: string
  unit?: string
  insurance_code?: string
  submit_source?: string
  submitted_at?: string
  /** 候选提交时携带的基准版本，用于版本冲突判定；可缺省。 */
  version?: string
  /** 数据获取层的来源标记（synthetic-simulator / 公开目录 / 实连）。 */
  source?: string
  /** 数据获取层的来源文件与降级原因。 */
  source_note?: string
}

/** 已有主数据记录（spec.md §2）。 */
export interface MasterDataRecord {
  code: string
  record_id: string
  domain: Domain
  name: string
  spec?: string
  dosage_form?: string
  unit?: string
  insurance_code?: string
  status: RecordStatus
  version: string
}

/** 逐字段证据条目。模型产四要素，规则层回填 evidence_mismatch / model_matched_value。 */
export interface EvidenceItem {
  record_id: string
  field: string
  candidate_value: string
  matched_value: string
  /** 规则层：matched_value 与主数据实际值不一致时为 true。 */
  evidence_mismatch?: boolean
  /** 规则层：保留模型原值供对比。 */
  model_matched_value?: string
  /** 规则层：本条被识别为冲突命中 / 停用命中。 */
  conflict_hit?: boolean
  excluded_hit?: boolean
}

/** 字段级对照结果（供渲染层并排展示，渲染层不重算）。 */
export interface FieldDiff {
  field: string
  candidate_value: string | null
  matched_value: string | null
  equal: boolean
  kind: DiffKind
}

export interface DiffSummary {
  diffs: FieldDiff[]
  counts: Record<DiffKind, number>
  conflict_fields: string[]
}

/** 归并结论：模型产出字段 + 规则层附加字段。 */
export interface MergeConclusion {
  candidate_id: string
  domain: Domain
  action: Action
  target_code: string | null
  confidence: number
  rationale: string
  evidence: EvidenceItem[]
  uncertain_reason: UncertainReason
  /** 规则层附加（spec.md §2）。 */
  missing_fields: string[]
  excluded_status?: RecordStatus
  degraded: boolean
  degraded_reason?: string
  capped_from?: number
  capped_by?: string
  /** 规则层：本次结论引用的检索快照 record_id 集合。 */
  retrieved_record_ids?: string[]
  /** 规则层：结论写入来源（model / 人工指定 / degrade）。 */
  source?: 'model' | 'human' | 'degrade'
  /** 规则层：置信度被阈值或缺失字段封顶的原因说明。 */
  reason_fallback?: string
  /** 规则层：统计字段（检索失败 / 域不匹配排除计数等）。 */
  statistics?: ConclusionStatistics
  /** 多义命中的全部记录（供 UI 并排）。 */
  ambiguous_records?: MasterDataRecord[]
  /** 版本冲突 / 停用排除的明细说明。 */
  excluded_records?: Array<{ record_id: string; code: string; reason: string }>
  /** 字段级对照摘要（供 UI 复用同一口径）。 */
  field_diffs?: DiffSummary
  /** 决策时刻（ISO）。 */
  decided_at?: string
}

export interface ConclusionStatistics {
  /** 检索返回的原始命中条数。 */
  raw_hit_count?: number
  /** 因域不匹配被排除的条数。 */
  domain_mismatch_excluded?: number
  /** 因停用被排除的条数。 */
  status_excluded?: number
  /** 越界引用条数。 */
  out_of_snapshot_refs?: number
}

/** 模型输出（validator 之前的结构化结论，尚未经规则层归一）。 */
export interface RawModelConclusion {
  action: Action
  target_code: string | null
  confidence: number
  rationale: string
  evidence: EvidenceItem[]
  uncertain_reason: UncertainReason
}

/** 复合键计算结果。 */
export type CompositeKeyResult =
  | { status: 'ok'; key: string }
  | { status: 'missing'; missing_keys: string[] }

/** 唯一性闸门判定出口。 */
export type GateOutcome =
  | { kind: 'unique'; record: MasterDataRecord }
  | { kind: 'ambiguous'; records: MasterDataRecord[] }
  | { kind: 'no-match' }
  | { kind: 'missing-fields'; missing_keys: string[] }

/** 检索结果：成功（0 条也算 ok）与失败在数据结构上就是两件事。 */
export type RetrievalOutcome =
  | { kind: 'retrieved_ok'; records: MasterDataRecord[]; hits: number; domain_mismatch_excluded: number }
  | { kind: 'retrieval_failed'; endpoint: string; status: number | null; retries: number; message: string }

/** 上下文条目（保留来源，供证据链追溯「从哪条检索词召回」）。 */
export interface ContextEntry {
  key: string
  text: string
  domain?: Domain
  record_id?: string
  query_term?: string
  matched_field?: string
  ingested_at: number
}

/** 上下文快照条目（snap 时附上版本 id）。 */
export interface ContextSnapshotEntry extends ContextEntry {
  snapshot_version: string
}

export type IngestStrategy = 'replace-self' | 'append-self'

/** 标记协议分段结果（证据 / 结论 / 存疑理由）。 */
export interface MarkerSegments {
  evidence: string
  conclusion: string
  uncertain_reason: string
}

/** 模型调用留痕（spec.md §4 安全审计行）。 */
export interface ModelCallLog {
  model_call_id: string
  candidate_id: string
  model: string
  base_url: string
  prompt_hash: string
  input_tokens: number
  output_tokens: number
  latency_ms: number
  finish_reason: string
  schema_valid: boolean
  degraded_reason: string | null
  api_key_masked: string
  created_at: string
}

/** 写回回执三态。 */
export type ReceiptStatus = 'success' | 'skipped' | 'failed'

export interface WriteReceipt {
  candidate_id: string
  status: ReceiptStatus
  idempotency_key: string
  reason?: string
  readable_reason?: string
  created_at: string
}

/** 批处理部分失败汇总。 */
export interface BatchSummary {
  batch_id: string
  total: number
  succeeded: number
  skipped: number
  failed: number
  failures: Array<{ candidate_id: string; kind: string; readable_reason: string }>
  elapsed_ms: number
}

/** 只增不改审计链条目。 */
export interface AuditEntry {
  seq: number
  ts: string
  candidate_id: string
  action: Action
  target_code: string | null
  evidence: EvidenceItem[]
  model_call_id: string | null
  prompt_hash: string
  retrieved_record_ids: string[]
  decided_at: string
  confirmed_by: string
  writeback_receipt: WriteReceipt | null
  prev_hash: string
  hash: string
  status: 'active' | 'revoked'
  supersedes?: string
  batch_id?: string
  confidence?: number
}

/** 隐私闸门命中类型。 */
export type PiiHitType = 'id_card' | 'phone' | 'name_field' | 'patient_id'

export interface PiiHit {
  field: string
  type: PiiHitType
  value_preview: string
}

/** 隐私闸门判定。 */
export type PiiVerdict =
  | { ok: true; hits: [] }
  | { ok: false; rejected_by: 'pii_guard'; hits: PiiHit[] }

/** 追问轮次。 */
export interface FollowupTurn {
  question: string
  answer: string
  referenced_record_ids: string[]
  evidence: EvidenceItem[]
  model_call_id: string | null
  asked_action: Action
  refreshed: boolean
  at: string
}

/** 追问会话（按 candidate_id 归属）。 */
export interface FollowupSession {
  candidate_id: string
  snapshot_version: string
  conclusion: MergeConclusion
  turns: FollowupTurn[]
  discarded_count: number
  updated_at: string
}

/** 模型网关错误分类。 */
export type ModelErrorKind = 'network' | 'timeout' | 'rate_limit' | 'client_error' | 'server_error' | 'cancelled'

export interface ModelErrorObject {
  kind: ModelErrorKind
  status: number | null
  retryable: boolean
  message: string
  retry_after_ms?: number
}

/** 本轮归并请求的上下文段 + 请求 turn。 */
export interface MergeRequestTurn {
  context_block: string
  request: string
  candidate: CandidateRecord
}

/** 规范化：解码三态。 */
export interface DecodedLine {
  text: string
  encoding_used: 'utf-8' | 'gbk' | 'gb18030'
  decoded_ok: boolean
  flags: string[]
}

/** 规范化：结构化规格。 */
export interface ParsedSpec {
  original: string
  strength: number | null
  strength_unit: string | null
  pack_count: number | null
  pack_unit: string | null
  normalized: string
  parse_ok: boolean
  flags: string[]
}

/** 规范化：单位归一。 */
export interface NormalizedUnit {
  value: number | null
  unit: string
  dimension: string
  flags: string[]
}

/** 检索词构造器输出（顺序固定）。 */
export interface QueryTerms {
  raw_name: string
  stripped_name: string
  pinyin_initials: string
  insurance_code: string
}

/** 字段映射表内容：院内字段名 → 内部规范字段名。 */
export type FieldMap = Record<string, string>

/** 本机工作区持久化状态（spec.md §10）。 */
export interface WorkspaceState {
  version: number
  batches: Record<string, unknown>
  suggestions: Record<string, unknown>
  receipts: Record<string, unknown>
  followups: Record<string, unknown>
  call_logs: ModelCallLog[]
  audit_chain: AuditEntry[]
  updated_at: string
}
