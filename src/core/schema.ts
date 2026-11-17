/**
 * valibot 运行时 schema（spec.md §10 本机持久化 / §2 归并结论校验）。
 *
 * schema 只负责运行时形状校验；静态类型仍在 types.ts 手写，避免推导类型与
 * 领域类型互相牵制。校验后由调用方断言为对应领域类型。
 */
import * as v from 'valibot'

export const DomainSchema = v.picklist(['drug', 'fee_item', 'department', 'exam'])

export const ActionSchema = v.picklist(['create', 'merge', 'uncertain'])

export const RecordStatusSchema = v.picklist(['启用', '停用'])

export const UncertainReasonSchema = v.nullable(
  v.picklist([
    '多义命中',
    '关键字段缺失',
    '无近似项',
    '版本冲突',
    '模型输出不合法',
    '检索失败',
    '模型不可用',
    '命中记录均已停用',
  ]),
)

export const CandidateSchema = v.object({
  candidate_id: v.string(),
  domain: DomainSchema,
  name: v.string(),
  spec: v.optional(v.string()),
  dosage_form: v.optional(v.string()),
  unit: v.optional(v.string()),
  insurance_code: v.optional(v.string()),
  submit_source: v.optional(v.string()),
  submitted_at: v.optional(v.string()),
  version: v.optional(v.string()),
  source: v.optional(v.string()),
  source_note: v.optional(v.string()),
})

export const MasterDataRecordSchema = v.object({
  code: v.string(),
  record_id: v.string(),
  domain: DomainSchema,
  name: v.string(),
  spec: v.optional(v.string()),
  dosage_form: v.optional(v.string()),
  unit: v.optional(v.string()),
  insurance_code: v.optional(v.string()),
  status: RecordStatusSchema,
  version: v.string(),
})

export const EvidenceItemSchema = v.object({
  record_id: v.string(),
  field: v.string(),
  candidate_value: v.string(),
  matched_value: v.string(),
  evidence_mismatch: v.optional(v.boolean()),
  model_matched_value: v.optional(v.string()),
  conflict_hit: v.optional(v.boolean()),
  excluded_hit: v.optional(v.boolean()),
})

/** 归并结论 schema（merge-validator 复用；evidence 至少一条）。 */
export const MergeConclusionSchema = v.object({
  candidate_id: v.string(),
  domain: DomainSchema,
  action: ActionSchema,
  target_code: v.nullable(v.string()),
  confidence: v.number(),
  rationale: v.string(),
  evidence: v.pipe(v.array(EvidenceItemSchema), v.minLength(1)),
  uncertain_reason: UncertainReasonSchema,
  missing_fields: v.array(v.string()),
  excluded_status: v.optional(RecordStatusSchema),
  degraded: v.boolean(),
  degraded_reason: v.optional(v.string()),
  capped_from: v.optional(v.number()),
  capped_by: v.optional(v.string()),
  source: v.optional(v.picklist(['model', 'human', 'degrade'])),
  reason_fallback: v.optional(v.string()),
  decided_at: v.optional(v.string()),
})

/** 模型原始输出 schema（比结论更宽松，缺失字段交给 validator 补齐判定）。 */
export const RawModelConclusionSchema = v.object({
  action: ActionSchema,
  target_code: v.nullable(v.string()),
  confidence: v.number(),
  rationale: v.string(),
  evidence: v.array(EvidenceItemSchema),
  uncertain_reason: UncertainReasonSchema,
})

const ModelCallLogSchema = v.object({
  model_call_id: v.string(),
  candidate_id: v.string(),
  model: v.string(),
  base_url: v.string(),
  prompt_hash: v.string(),
  input_tokens: v.number(),
  output_tokens: v.number(),
  latency_ms: v.number(),
  finish_reason: v.string(),
  schema_valid: v.boolean(),
  degraded_reason: v.nullable(v.string()),
  api_key_masked: v.string(),
  created_at: v.string(),
})

const WriteReceiptSchema = v.object({
  candidate_id: v.string(),
  status: v.picklist(['success', 'skipped', 'failed']),
  idempotency_key: v.string(),
  reason: v.optional(v.string()),
  readable_reason: v.optional(v.string()),
  created_at: v.string(),
})

const AuditEntrySchema = v.object({
  seq: v.number(),
  ts: v.string(),
  candidate_id: v.string(),
  action: ActionSchema,
  target_code: v.nullable(v.string()),
  evidence: v.array(EvidenceItemSchema),
  model_call_id: v.nullable(v.string()),
  prompt_hash: v.string(),
  retrieved_record_ids: v.array(v.string()),
  decided_at: v.string(),
  confirmed_by: v.string(),
  writeback_receipt: v.nullable(WriteReceiptSchema),
  prev_hash: v.string(),
  hash: v.string(),
  status: v.picklist(['active', 'revoked']),
  supersedes: v.optional(v.string()),
  batch_id: v.optional(v.string()),
  confidence: v.optional(v.number()),
})

/** 本机工作区 schema（非法即报 invalid，触发 autoHeal）。 */
export const WorkspaceStateSchema = v.object({
  version: v.number(),
  batches: v.record(v.string(), v.unknown()),
  suggestions: v.record(v.string(), v.unknown()),
  receipts: v.record(v.string(), v.unknown()),
  followups: v.record(v.string(), v.unknown()),
  call_logs: v.array(ModelCallLogSchema),
  audit_chain: v.array(AuditEntrySchema),
  updated_at: v.string(),
})

/** schema 校验结果 unify：ok 携带数据，其他状态带诊断信息。 */
export type SchemaStatus = 'ok' | 'missing' | 'invalid' | 'read-error'
