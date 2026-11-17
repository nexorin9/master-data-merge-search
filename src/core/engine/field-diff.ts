/**
 * 字段级对照 diff 结构（Task 27）。
 *
 * 输入候选与一条命中主数据，输出逐字段对照数组
 * [{field, candidate_value, matched_value, equal, kind}]，kind：
 *   exact      完全一致
 *   normalized 规范化后一致（如 0.25g*12片 与 0.25g×12片 / 250mg≡0.25g）
 *   conflict   规范化后仍冲突（如 0.25g vs 0.5g）
 *   missing    候选缺该字段
 *   absent     主数据缺该字段
 * 关键字段顺序固定（insurance_code → name → spec → dosage_form → unit），
 * 其余排后；顺序由配置项定义，不依赖对象键序。diff 摘要 counts 与
 * conflict_fields 供引擎判定与 UI 摘要复用同一口径。
 */
import { FIELD_DIFF_ORDER } from '../constants'
import { equivalentSpec } from '../normalize/spec'
import { normalizeText } from '../normalize/encoding'
import { normalizeWidth } from '../normalize/width'
import { lookupUnit } from '../normalize/unit'
import type {
  CandidateRecord, DiffKind, DiffSummary, FieldDiff, MasterDataRecord,
} from '../types'

/** 参与对照的字段全集 + 顺序。 */
const ALL_FIELDS = [
  'insurance_code', 'name', 'spec', 'dosage_form', 'unit', 'code', 'status', 'version', 'record_id',
]

/** 展示字段顺序：关键字段在固定顺序位，其余按 ALL_FIELDS 排后。 */
export function orderedFields(): string[] {
  const head: string[] = [...FIELD_DIFF_ORDER]
  const tail = ALL_FIELDS.filter((f) => !head.includes(f))
  return [...head, ...tail]
}

/** 规范化后的文本比较键（宽度 + 不可见字符 + 空白）。 */
function normalizedText(value: string): string {
  return normalizeText(value).text.replace(/\s+/g, '').toLowerCase()
}

/** 判定单字段 kind。 */
export function classifyField(field: string, candidateValue: string, matchedValue: string): {
  kind: DiffKind
  equal: boolean
} {
  const c = candidateValue.trim()
  const m = matchedValue.trim()
  if (c === m) return { kind: 'exact', equal: true }

  if (field === 'spec' && equivalentSpec(c, m)) return { kind: 'normalized', equal: true }
  if (field === 'unit') {
    const cu = lookupUnit(c)
    const mu = lookupUnit(m)
    if (cu.known && mu.known && cu.dimension === mu.dimension && cu.unit === mu.unit) {
      return { kind: 'normalized', equal: true }
    }
    return { kind: 'conflict', equal: false }
  }
  if (field === 'name' || field === 'insurance_code' || field === 'dosage_form' || field === 'code') {
    if (normalizedText(c) === normalizedText(m)) return { kind: 'normalized', equal: true }
  }
  return { kind: 'conflict', equal: false }
}

/** 生成字段对照数组（顺序固定）。 */
export function buildFieldDiffs(
  candidate: CandidateRecord,
  record: MasterDataRecord,
): FieldDiff[] {
  const fields = orderedFields()
  const diffs: FieldDiff[] = []
  for (const field of fields) {
    const cRaw = (candidate as unknown as Record<string, unknown>)[field]
    const mRaw = (record as unknown as Record<string, unknown>)[field]
    const c = typeof cRaw === 'string' ? cRaw : ''
    const m = typeof mRaw === 'string' ? mRaw : ''
    const cMissing = !c || c.trim() === ''
    const mMissing = !m || m.trim() === ''

    let diff: FieldDiff
    if (cMissing && mMissing) {
      diff = { field, candidate_value: null, matched_value: null, equal: true, kind: 'exact' }
    } else if (cMissing) {
      diff = { field, candidate_value: null, matched_value: m, equal: false, kind: 'missing' }
    } else if (mMissing) {
      diff = { field, candidate_value: c, matched_value: null, equal: false, kind: 'absent' }
    } else {
      const { kind, equal } = classifyField(field, c, m)
      diff = { field, candidate_value: c, matched_value: m, equal, kind }
    }
    diffs.push(diff)
  }
  return diffs
}

/** 生成对照摘要：各 kind 条数 + 冲突字段列表。 */
export function summarizeDiffs(diffs: FieldDiff[]): DiffSummary {
  const counts: Record<DiffKind, number> = { exact: 0, normalized: 0, conflict: 0, missing: 0, absent: 0 }
  const conflict_fields: string[] = []
  for (const d of diffs) {
    counts[d.kind] += 1
    if (d.kind === 'conflict') conflict_fields.push(d.field)
  }
  return { diffs, counts, conflict_fields }
}

/** 一步构建候选 vs 命中记录的完整对照摘要。 */
export function compareFields(candidate: CandidateRecord, record: MasterDataRecord): DiffSummary {
  return summarizeDiffs(buildFieldDiffs(candidate, record))
}

// normalizeWidth 供未来扩展对照（当前经 normalizedText 间接使用），re-export 保持口径一致。
export { normalizeWidth }
