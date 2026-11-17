/**
 * 规格表达式解析（Task 18）。
 *
 * 把「含量×包装」解析成结构化 {strength, strength_unit, pack_count,
 * pack_unit}，支持 '*' '×' 空格 '/' 四种分隔与全半角混用。无法解析或
 * pack_count 非正整数的规格**拒收**（parse_error），调用方必须转人工，
 * 不得默认为 1 片。归一后 '0.25g*12片' ≡ '0.25g×12片' ≡ '0.25 克 12 片'；
 * '0.25g*12片' 与 '0.5g*12片' 必须不等；'250mg*12片' ≡ '0.25g*12片'。
 */
import { normalizeWidth } from './width'
import { convertUnit, isUnitMismatch, normalizeUnit, resetUnitAliasCache } from './unit'
import type { ParsedSpec } from '../types'

/** 含量段：数值 + 可选质量/体积单位。 */
const STRENGTH_RE = /^(\d+(?:\.\d+)?)\s*(μg|ug|微克|毫克|mg|g|kg|克|千克|ml|毫升|l|升)?$/i
/** 包装段：正整数 + 可选计数单位。 */
const PACK_RE = /^(\d+)\s*(片|粒|袋|支|瓶|盒|管|丸|贴|个|份)?$/
/** 显式分隔符（星号 / 乘号 / 斜杠 / 间隔号）。 */
const EXPLICIT_SPLIT_RE = /[*×xX/／·]/

function reject(original: string, flag: string): ParsedSpec {
  return {
    original,
    strength: null,
    strength_unit: null,
    pack_count: null,
    pack_unit: null,
    normalized: '',
    parse_ok: false,
    flags: ['parse_error', flag],
  }
}

/** 归一含量单位到标准写法。 */
function canonicalStrengthUnit(raw: string | undefined): string {
  if (!raw) return ''
  const map: Record<string, string> = {
    μg: 'μg', ug: 'μg', 微克: 'μg',
    毫克: 'mg', mg: 'mg',
    克: 'g', g: 'g',
    千克: 'kg', kg: 'kg',
    毫升: 'ml', ml: 'ml',
    升: 'l', l: 'l',
  }
  return map[raw.toLowerCase()] ?? map[raw] ?? raw.toLowerCase()
}

/**
 * 解析规格表达式。返回 ParsedSpec；parse_ok=false 表示拒收。
 */
export function parseSpec(input: string, options: { separator?: RegExp } = {}): ParsedSpec {
  const original = input ?? ''
  const normalizedWidthText = normalizeWidth(original).trim()
  if (!normalizedWidthText) return reject(original, 'empty')

  // 优先按显式分隔符切；无显式分隔符时按「含量 包装」的空白切（仅接受恰好两段）。
  const splitter = options.separator ?? EXPLICIT_SPLIT_RE
  let parts: string[]
  if (normalizedWidthText.match(splitter)) {
    parts = normalizedWidthText.split(splitter).map((p) => p.trim()).filter((p) => p.length > 0)
  } else {
    const trimmed = normalizedWidthText.replace(/\s+/g, ' ').trim()
    const spaceParts = trimmed.split(' ').filter((p) => p.length > 0)
    // 形如「0.25 克 12 片」：把「数值 单位」与「数值 单位」两段合并（共 4 token）。
    if (spaceParts.length === 4 && /^\d/.test(spaceParts[0]) && /^\d/.test(spaceParts[2])) {
      parts = [`${spaceParts[0]}${spaceParts[1]}`, `${spaceParts[2]}${spaceParts[3]}`]
    } else if (spaceParts.length === 2) {
      parts = spaceParts
    } else {
      parts = spaceParts
    }
  }
  if (parts.length !== 2) return reject(original, 'segment_count')

  const sm = STRENGTH_RE.exec(parts[0])
  const pm = PACK_RE.exec(parts[1])
  if (!sm) return reject(original, 'strength_format')
  if (!pm) return reject(original, 'pack_format')

  const strength = Number.parseFloat(sm[1])
  const strengthUnit = canonicalStrengthUnit(sm[2])
  const packCount = Number.parseInt(pm[1], 10)
  const packUnit = pm[2] ?? ''
  if (!Number.isFinite(strength) || strength <= 0) return reject(original, 'strength_invalid')
  if (!Number.isInteger(packCount) || packCount <= 0) return reject(original, 'pack_invalid')

  const flags: string[] = []
  // 单段规格形如「1次」「1项」：无含量单位，视为非药品规格，仍可解析但标记。
  if (!strengthUnit) flags.push('no_strength_unit')

  return {
    original,
    strength,
    strength_unit: strengthUnit,
    pack_count: packCount,
    pack_unit: packUnit,
    normalized: `${strength}${strengthUnit}*${packCount}${packUnit}`,
    parse_ok: true,
    flags,
  }
}

/**
 * 规格等价判定：含量经同类单位换算后相等、包装计数与单位归一后相等。
 * 任一规格 parse_error 或跨维度单位冲突 → 不等价（不猜测）。
 */
export function equivalentSpec(a: string, b: string): boolean {
  const pa = parseSpec(a)
  const pb = parseSpec(b)
  if (!pa.parse_ok || !pb.parse_ok) return false
  if (pa.pack_count !== pb.pack_count) return false
  // 包装单位归一后必须相等（跨维度不换算）。两侧都缺包装单位视为相等；
  // 仅一侧有包装单位则不等价，避免把 null 传给 lookupUnit。
  if (pa.pack_unit === null || pb.pack_unit === null) {
    if (pa.pack_unit !== pb.pack_unit) return false
  } else if (isUnitMismatch(pa.pack_unit, pb.pack_unit)) {
    return false
  }
  // 含量单位：同类换算（mg↔g），跨维度不等价。
  if (pa.strength_unit === pb.strength_unit) {
    return pa.strength === pb.strength
  }
  const converted = convertUnit(pa.strength!, pa.strength_unit!, pb.strength_unit!)
  if (converted === null) return false
  // 浮点容差，避免 250mg→0.25g 的精度误差。
  return Math.abs(converted - pb.strength!) < 1e-9
}

/** 组合归一结果，供复合键使用：失败时返回原值规范化形式并带 parse_error。 */
export function normalizedSpecKey(input: string): { key: string; parse_ok: boolean; flags: string[] } {
  const p = parseSpec(input)
  if (!p.parse_ok) return { key: normalizeWidth(input).trim(), parse_ok: false, flags: p.flags }
  // 含量换算到基准单位（mg / ml），消除 mg↔g 差异。
  const { dimension } = normalizeUnit(p.strength!, p.strength_unit!)
  let strengthKey = `${p.strength}${p.strength_unit}`
  if (dimension === 'mass') strengthKey = `${convertUnit(p.strength!, p.strength_unit!, 'mg')}mg`
  else if (dimension === 'volume') strengthKey = `${convertUnit(p.strength!, p.strength_unit!, 'ml')}ml`
  return {
    key: `${strengthKey}*${p.pack_count}${p.pack_unit}`,
    parse_ok: true,
    flags: p.flags,
  }
}

// 便于测试重置单位别名缓存（re-export）。
export { resetUnitAliasCache }
