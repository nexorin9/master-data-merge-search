/**
 * 复合键计算（Task 6 / 22）。
 *
 * 复合键 = domain + 规格单位统一后的 (insurance_code ∧ spec ∧ dosage_form ∧
 * unit)。关键字段（spec / unit）缺失时返回 missing 而非拼串、不用空串兜底。
 * 归属唯一性由本规则确定性判定，不由模型自评。
 */
import { normalizedSpecKey } from '../normalize/spec'
import { normalizeText } from '../normalize/encoding'
import { lookupUnit } from '../normalize/unit'
import { REQUIRED_KEY_FIELDS } from '../constants'
import type { CandidateRecord, CompositeKeyResult, MasterDataRecord } from '../types'

/** 规格字段归一化：先做结构等价归一，失败时退回宽度/不可见字符归一。 */
function specKey(value: string | undefined): { value: string; parse_ok: boolean } {
  if (!value || value.trim() === '') return { value: '', parse_ok: false }
  const norm = normalizeText(value)
  if (norm.flags.includes('unprintable')) return { value: '', parse_ok: false }
  const result = normalizedSpecKey(norm.text)
  return { value: result.key || norm.text, parse_ok: result.parse_ok }
}

/** 单位字段归一：院内别名 → 标准单位；未知保留原值。 */
function unitKey(value: string | undefined): string {
  if (!value) return ''
  return lookupUnit(normalizeText(value).text).unit
}

/** 文本字段归一：宽度 + 不可见字符 + trim，去空白。 */
function textKey(value: string | undefined): string {
  if (!value) return ''
  return normalizeText(value).text.replace(/\s+/g, '')
}

/**
 * 计算候选的复合键。缺 spec 或 unit 时返回 status=missing 并列出缺失字段。
 */
export function computeCompositeKey(candidate: CandidateRecord): CompositeKeyResult {
  const missing_keys: string[] = []
  if (!candidate.spec || candidate.spec.trim() === '') missing_keys.push('spec')
  if (!candidate.unit || candidate.unit.trim() === '') missing_keys.push('unit')
  if (missing_keys.length > 0) return { status: 'missing', missing_keys }

  const sk = specKey(candidate.spec)
  const uk = unitKey(candidate.unit)
  const ic = textKey(candidate.insurance_code)
  const df = textKey(candidate.dosage_form)

  // 医保码是复合键的一部分；用竖线分隔避免字段值互相拼接产生歧义。
  const key = [
    candidate.domain,
    `ic=${ic}`,
    `spec=${sk.value}`,
    `df=${df}`,
    `unit=${uk}`,
  ].join('|')
  return { status: 'ok', key }
}

/** 计算主数据记录的复合键（字段形状与候选不同，统一走同一归一化口径）。 */
export function recordCompositeKey(record: MasterDataRecord): CompositeKeyResult {
  return computeCompositeKey({
    candidate_id: record.record_id,
    domain: record.domain,
    name: record.name,
    spec: record.spec,
    dosage_form: record.dosage_form,
    unit: record.unit,
    insurance_code: record.insurance_code,
  })
}

/** 缺哪些关键字段（supplement missing_keys，含 disinfect）。 */
export function missingKeyFields(candidate: CandidateRecord): string[] {
  const fields: string[] = []
  for (const f of REQUIRED_KEY_FIELDS) {
    const value = candidate[f as keyof CandidateRecord]
    if (typeof value !== 'string' || value.trim() === '') fields.push(f)
  }
  return fields
}
