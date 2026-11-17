/**
 * 隐私形状闸门（Task 38）。
 *
 * 纯「形状」判定，不做语义理解：按值的外观识别证件号 / 电话 / 患者号，按
 * 字段名 + 值形状识别姓名类字段。所有命中项的 value_preview 均为掩码，绝不
 * 回显完整证件号 / 手机号。纯编码（XP000123 / XJ7000000000001）、药品名、
 * 规格串、剂型、单位必须零误报。
 *
 * 判定边界：数值形状要求「整个字母数字 token 恰好等于目标形状」（用
 * (?<![0-9A-Za-z]) 与 (?![0-9A-Za-z]) 夹住），这样 64 位十六进制哈希、
 * 带字母前缀的药品编码都不会因内部恰好含有 11/15/18 位数字子串而误报，
 * 同时中文文本里「身份证号：110101…」这类嵌入形态仍能被识别。
 *
 * 落盘前强制（workspace 第二遍）：本任务不得修改 src/main/workspace.ts，
 * 故以包装器形式提供接线点——调用方在 Workspace.write / appendAudit 落盘前，
 * 把待持久化 state 交给 guardedWorkspaceWrite(workspace, state) 或把行集合交给
 * enforcePiiBeforeWrite(rows, writeFn)；闸门一旦命中即拒绝调用底层 sink，
 * 保证被拒的行不进入 workspace / 检索 / 审计。
 */
import type { PiiHit, PiiHitType, PiiVerdict } from '../types'

/** 四种命中类型（顺序固定，便于统计）。 */
export const PII_HIT_TYPES: readonly PiiHitType[] = ['id_card', 'phone', 'name_field', 'patient_id']

/** 命中类型计数表。 */
export type HitTypeCounts = Record<PiiHitType, number>

export function emptyHitTypeCounts(): HitTypeCounts {
  return { id_card: 0, phone: 0, name_field: 0, patient_id: 0 }
}

/** 被拒条目：索引 + 原始行 + 判定（含 rejected_by / 命中类型 / 字段名）。 */
export interface RejectedRow {
  index: number
  row: Record<string, unknown>
  verdict: Extract<PiiVerdict, { ok: false }>
}

/** 批量扫描结果：accepted 为放行行索引，rejected 为被拒明细，二者互不影响。 */
export interface BatchScanResult {
  accepted: number[]
  acceptedRows: Record<string, unknown>[]
  rejected: RejectedRow[]
  rejected_count: number
  hit_type_counts: HitTypeCounts
}

/** 底层写口。 */
export type WriteSink<R> = (rows: R[]) => unknown

/** 闸门结果：成功放行并写入，或被隐私闸门拒绝（未触碰 sink）。 */
export type GuardResult =
  | { ok: true; written: number; result: unknown }
  | { ok: false; rejected_by: 'pii_guard'; written: 0; reason: string; rejected: RejectedRow[] }

// ── 值形状（整个字母数字 token 恰好命中，避免长编码/哈希内部子串误报） ──
const ID_18 = /(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])/
const ID_15 = /(?<![0-9A-Za-z])\d{15}(?![0-9A-Za-z])/
const PHONE = /(?<![0-9A-Za-z])1[3-9]\d{9}(?![0-9A-Za-z])/
const PATIENT_ID_VALUE =
  /(?<![0-9A-Za-z])(?:HZ|ZY|MZ|BR|BL|BA|JZ|PAT|MRN|住院号?|患者号?|病历号?|病案号?|门诊号?|就诊号?)[-_]?\d{4,}(?![0-9A-Za-z])/i

// ── 字段名（锚定到完整 token，禁止匹配裸 name / drug_name 等） ──
const NAME_FIELD_PATTERN =
  /(?:^|[_\-])(?:患者姓名|病人姓名|联系人姓名|家属姓名|监护人姓名|患者名称|病人名称|姓名|联系人|患者|病人|家属|监护人|确认人|确认者|审核人|操作人|创建人|导出人|经办人|patient[_\-]?name|contact[_\-]?name|real[_\-]?name|full[_\-]?name|confirmed[_\-]?by|exported[_\-]?by|created[_\-]?by|operator|reviewer)(?:$|[_\-])/i
const PATIENT_ID_FIELD_PATTERN =
  /(?:^|[_\-])(?:住院流水号|住院号|病历号|病案号|就诊号|门诊号|患者编号|病人编号|患者id|病人id|patient[_\-]?id|mrn|visit[_\-]?id|admission[_\-]?no|inpatient[_\-]?no)(?:$|[_\-])/i

interface FieldValue {
  field: string
  text: string
}

/** 递归摊平行：对象用嵌套键名，数组沿用父键名，基本值转字符串。 */
function collectFieldValues(row: Record<string, unknown>): FieldValue[] {
  const out: FieldValue[] = []
  const walk = (field: string, value: unknown): void => {
    if (value === null || value === undefined) return
    if (Array.isArray(value)) {
      for (const item of value) walk(field, item)
      return
    }
    if (typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        walk(key, child)
      }
      return
    }
    out.push({ field, text: String(value) })
  }
  for (const [field, value] of Object.entries(row)) walk(field, value)
  return out
}

/**
 * 是否「纯编码」：字母打头的 ASCII 编码，或 1~5 位短数字。
 * 纯编码不触发「字段名 + 非编码值」规则，是零误报的核心。
 */
function isPureSafeCode(raw: string): boolean {
  const s = raw.trim()
  if (s === '') return true
  return /^[A-Za-z][A-Za-z0-9_\-./:]*$/.test(s) || /^\d{1,5}$/.test(s)
}

/** 掩码预览：只露首尾，中间以星号遮蔽，绝不回显完整值。 */
export function maskText(text: string): string {
  const s = text.trim()
  if (s.length === 0) return ''
  if (s.length === 1) return '*'
  if (s.length <= 4) return s.slice(0, 1) + '*'.repeat(s.length - 1)
  return s.slice(0, 2) + '*'.repeat(Math.min(s.length - 4, 6)) + s.slice(-2)
}

/** 单行扫描：干净返回 ok:true；命中返回 rejected_by='pii_guard' + hits。 */
export function scanRow(row: Record<string, unknown>): PiiVerdict {
  const hitMap = new Map<string, PiiHit>()
  const push = (field: string, type: PiiHitType, preview: string): void => {
    const key = `${field}\u0000${type}`
    if (!hitMap.has(key)) hitMap.set(key, { field, type, value_preview: preview })
  }

  for (const { field, text } of collectFieldValues(row)) {
    const trimmed = text.trim()

    const idMatch = text.match(ID_18) ?? text.match(ID_15)
    if (idMatch) push(field, 'id_card', maskText(idMatch[0]))

    const phoneMatch = text.match(PHONE)
    if (phoneMatch) push(field, 'phone', maskText(phoneMatch[0]))

    const patientMatch = text.match(PATIENT_ID_VALUE)
    if (patientMatch) push(field, 'patient_id', maskText(patientMatch[0]))

    const safe = isPureSafeCode(trimmed)
    if (NAME_FIELD_PATTERN.test(field) && !safe) {
      push(field, 'name_field', maskText(trimmed))
    }
    if (
      PATIENT_ID_FIELD_PATTERN.test(field) &&
      !safe &&
      !hitMap.has(`${field}\u0000patient_id`)
    ) {
      push(field, 'patient_id', maskText(trimmed))
    }
  }

  const hits = Array.from(hitMap.values())
  if (hits.length === 0) return { ok: true, hits: [] }
  return { ok: false, rejected_by: 'pii_guard', hits }
}

/**
 * 批量扫描：单行命中只拒该行，不阻断其余行；rejected_count 与 hit_type_counts
 * 覆盖全部被拒行的全部命中。被拒行携带 rejected_by + 命中类型 + 字段名。
 */
export function scanBatch(rows: Array<Record<string, unknown>>): BatchScanResult {
  const accepted: number[] = []
  const acceptedRows: Array<Record<string, unknown>> = []
  const rejected: RejectedRow[] = []
  const hit_type_counts = emptyHitTypeCounts()

  rows.forEach((row, index) => {
    const verdict = scanRow(row)
    if (verdict.ok) {
      accepted.push(index)
      acceptedRows.push(row)
      return
    }
    rejected.push({ index, row, verdict })
    for (const hit of verdict.hits) hit_type_counts[hit.type] += 1
  })

  return {
    accepted,
    acceptedRows,
    rejected,
    rejected_count: rejected.length,
    hit_type_counts,
  }
}

/**
 * 落盘前强制闸门：先扫全批，任一行为脏即整批拒绝（返回 rejection），
 * 绝不调用 writeFn；仅全批干净时才把行交给底层 sink。
 */
export function enforcePiiBeforeWrite<R extends Record<string, unknown>>(
  rows: R[],
  writeFn: WriteSink<R>,
): GuardResult {
  const scan = scanBatch(rows)
  if (scan.rejected_count > 0) {
    return {
      ok: false,
      rejected_by: 'pii_guard',
      written: 0,
      reason: `隐私闸门拦截：${scan.rejected_count} 行命中个人信息，禁止写入工作区/检索/审计`,
      rejected: scan.rejected,
    }
  }
  const result = writeFn(rows)
  return { ok: true, written: rows.length, result }
}

/** 把一个底层写口包成受闸门保护的 sink（绕过业务层直写也会被拦下）。 */
export function createGuardedSink<R extends Record<string, unknown>>(
  writeFn: WriteSink<R>,
): (rows: R[]) => GuardResult {
  return (rows) => enforcePiiBeforeWrite(rows, writeFn)
}

/** 待落盘 state 的最小形状（对齐 WorkspaceState 的审计/建议集合）。 */
export interface PersistState {
  audit_chain?: unknown[]
  suggestions?: Record<string, unknown>
  [key: string]: unknown
}

/** 具备 write 的工作区最小接口。 */
export interface PersistWorkspace {
  write(state: PersistState): void
}

/**
 * workspace 第二遍接线点：把审计链条目与建议值摊成行做强制扫描，干净才调用
 * workspace.write。用法（在不得修改的 workspace.ts 之外接入）：
 *   guardedWorkspaceWrite(workspace, workspace.snapshot())
 * 这样即便有绕过路径直接调 write，只要统一走本包装器就会被闸门拦下。
 */
export function guardedWorkspaceWrite(
  workspace: PersistWorkspace,
  state: PersistState,
): GuardResult {
  const rows: Array<Record<string, unknown>> = []
  for (const entry of state.audit_chain ?? []) {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      rows.push(entry as Record<string, unknown>)
    }
  }
  if (state.suggestions !== null && typeof state.suggestions === 'object') {
    for (const value of Object.values(state.suggestions)) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        rows.push(value as Record<string, unknown>)
      }
    }
  }
  return enforcePiiBeforeWrite(rows, () => workspace.write(state))
}
