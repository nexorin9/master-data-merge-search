/**
 * 结构化输出与 schema 校验（Task 29）。
 *
 * 模型必须吐结构化归并结论。默认 response_format=json_schema；端点返回 400
 * 且提示不支持时自动降级为 json_object 并在调用元数据记
 * degraded_reason=json_schema_unsupported。本地 valibot 校验不合法时重试 1 次
 * （带校验错误摘要进提示），仍失败判模型失败转人工，绝不把不合规文本当结论。
 */
import * as v from 'valibot'
import { CONFIG_RATIONALE_MAX_LENGTH } from '../constants'
import type { EvidenceItem, RawModelConclusion, UncertainReason } from '../types'

const VALID_ACTIONS = ['create', 'merge', 'uncertain']
const VALID_REASONS = [
  '多义命中', '关键字段缺失', '无近似项', '版本冲突', '模型输出不合法',
  '检索失败', '模型不可用', '命中记录均已停用',
]

/** 证据四要素 schema。 */
export const EvidenceWireSchema = v.object({
  record_id: v.string(),
  field: v.string(),
  candidate_value: v.string(),
  matched_value: v.string(),
})

/** 模型结论 schema（严格形状）。 */
export const RawConclusionSchema = v.object({
  action: v.picklist(VALID_ACTIONS as [string, ...string[]]),
  target_code: v.nullable(v.string()),
  confidence: v.number(),
  rationale: v.string(),
  evidence: v.array(EvidenceWireSchema),
  uncertain_reason: v.nullable(v.picklist(VALID_REASONS as [string, ...string[]])),
})

export interface ValidationResult {
  ok: boolean
  conclusion?: RawModelConclusion
  errors: string[]
}

/** 从模型 content 解析 JSON（容忍 ```json 包裹）。 */
export function parseModelJson(content: string): { ok: boolean; value?: unknown; error?: string } {
  let text = content.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)
  if (fence) text = fence[1].trim()
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (err) {
    return { ok: false, error: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * 校验模型结论 schema + 业务一致性。返回 errors 列表（空即合法）。
 * action=merge 必须 target_code；action=create 必须 target_code 空；
 * action=uncertain 必须 uncertain_reason；rationale≤120 字；evidence≥1 且四要素齐。
 */
export function validateConclusion(value: unknown): ValidationResult {
  const parsed = parseModelJson(typeof value === 'string' ? value : JSON.stringify(value))
  if (!parsed.ok) return { ok: false, errors: [parsed.error!] }

  const result = v.safeParse(RawConclusionSchema, parsed.value)
  if (!result.success) {
    const errors = result.issues.map((i) => `${(i.path ?? []).map((p) => (typeof p.key === 'string' ? p.key : '')).join('.')}: ${i.message}`)
    return { ok: false, errors }
  }
  const c = result.output as unknown as RawModelConclusion
  const errors: string[] = []

  if (c.confidence < 0 || c.confidence > 1) errors.push('confidence 不在 0–1 区间')
  if ([...c.rationale].length > CONFIG_RATIONALE_MAX_LENGTH) {
    errors.push(`rationale 超过 ${CONFIG_RATIONALE_MAX_LENGTH} 字`)
  }
  if (c.action === 'merge' && (!c.target_code || c.target_code.trim() === '')) {
    errors.push('action=merge 必须有 target_code')
  }
  if (c.action === 'create' && c.target_code) {
    errors.push('action=create 时 target_code 必须为空')
  }
  if (c.action === 'uncertain' && !c.uncertain_reason) {
    errors.push('action=uncertain 必须有 uncertain_reason')
  }
  if (c.evidence.length < 1) errors.push('evidence 至少 1 条')
  for (const [i, e] of c.evidence.entries()) {
    if (!e.record_id || !e.field || e.candidate_value === undefined || e.matched_value === undefined) {
      errors.push(`evidence[${i}] 缺四要素（record_id/field/candidate_value/matched_value）`)
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, conclusion: c, errors: [] }
}

/** 校验失败摘要（注入重试提示）。 */
export function validationErrorSummary(errors: string[]): string {
  return `上次输出未通过 schema 校验，请修正：${errors.slice(0, 5).join('；')}`
}

/** 判定端点 400 响应是否为「不支持 json_schema」。 */
export function needsSchemaDowngrade(status: number, body: string): boolean {
  return status === 400 && /json_schema|response_format|unsupported|not support/i.test(body)
}

/** evidence 四要素类型守卫（供证据链层复用）。 */
export function hasEvidenceQuartet(e: Partial<EvidenceItem>): e is EvidenceItem {
  return !!e.record_id && !!e.field && typeof e.candidate_value === 'string' && typeof e.matched_value === 'string'
}

export type { UncertainReason }
