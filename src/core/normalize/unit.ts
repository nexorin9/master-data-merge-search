/**
 * 计量单位别名归一（Task 18）。
 *
 * 质量（mg/g/μg/kg）、含量（片/粒/袋/支/瓶/盒）、体积（ml/l）、时间等维度
 * 分组；别名表外置为可配置 JSON，不硬编码在引擎里。**跨维度一律不换算**并
 * 标记 unit_mismatch，避免把「支」当成「片」。同类换算（mg↔g）做实。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { normalizeWidth } from './width'
import type { NormalizedUnit } from '../types'

interface UnitAliasTable {
  [dimension: string]: Record<string, string[]>
}

let cachedTable: UnitAliasTable | null = null

/** 读取并缓存单位别名表（默认 config/unit-alias.json，可注入路径）。 */
export function loadUnitAliasTable(path?: string): UnitAliasTable {
  if (cachedTable && !path) return cachedTable
  const file = path ?? resolve(process.cwd(), 'config/unit-alias.json')
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as UnitAliasTable
  const table: UnitAliasTable = {}
  for (const [dimension, group] of Object.entries(parsed)) {
    if (dimension.startsWith('$') || typeof group !== 'object') continue
    table[dimension] = group
  }
  if (!path) cachedTable = table
  return table
}

/** 测试用：重置缓存。 */
export function resetUnitAliasCache(): void {
  cachedTable = null
}

/**
 * 查别名 → 归一标准单位 + 维度。
 * 大小写不敏感、全半角折叠；别名表外查不到时保留原值，dimension=unknown。
 */
export function lookupUnit(
  rawUnit: string,
  table: UnitAliasTable = loadUnitAliasTable(),
): { unit: string; dimension: string; known: boolean } {
  const u = normalizeWidth(rawUnit).trim().toLowerCase()
  for (const [dimension, group] of Object.entries(table)) {
    for (const [standard, aliases] of Object.entries(group)) {
      if (aliases.some((a) => normalizeWidth(a).toLowerCase() === u) || standard.toLowerCase() === u) {
        return { unit: standard, dimension, known: true }
      }
    }
  }
  return { unit: u, dimension: 'unknown', known: false }
}

/** 归一「数值 + 单位」；无法解析数值时 value=null 并标 parse_error。 */
export function normalizeUnit(value: string | number, unit: string, table?: UnitAliasTable): NormalizedUnit {
  const t = table ?? loadUnitAliasTable()
  const flags: string[] = []
  const num = typeof value === 'number' ? value : Number.parseFloat(normalizeWidth(value))
  if (typeof value === 'string' && (!Number.isFinite(num) || value.trim() === '')) flags.push('parse_error')
  const { unit: standardUnit, dimension, known } = lookupUnit(unit, t)
  if (!known) flags.push('unit_unknown')
  return { value: Number.isFinite(num) ? num : null, unit: standardUnit, dimension, flags }
}

/** 同类单位基准换算系数（换算到该维度基准单位）。 */
const TO_BASE: Record<string, Record<string, number>> = {
  mass: { 'μg': 0.001, 'mg': 1, 'g': 1000, 'kg': 1_000_000 }, // 基准 mg
  volume: { 'ml': 1, 'l': 1000 }, // 基准 ml
  time: { 'min': 1, 'h': 60, 'd': 1440 }, // 基准 min
}

/** 同类单位是否可换算（同维度且都在系数表内）。 */
export function unitsConvertible(a: string, b: string, table?: UnitAliasTable): boolean {
  const t = table ?? loadUnitAliasTable()
  const ua = lookupUnit(a, t)
  const ub = lookupUnit(b, t)
  if (ua.dimension !== ub.dimension) return false
  const factors = TO_BASE[ua.dimension]
  return !!factors && ua.unit in factors && ub.unit in factors
}

/**
 * 同类单位换算：把 (value, unit) 换算到目标单位。
 * 跨维度或未知单位返回 null 并调用方标 unit_mismatch。
 */
export function convertUnit(
  value: number,
  fromUnit: string,
  toUnit: string,
  table?: UnitAliasTable,
): number | null {
  const t = table ?? loadUnitAliasTable()
  const fa = lookupUnit(fromUnit, t)
  const fb = lookupUnit(toUnit, t)
  if (fa.dimension !== fb.dimension) return null
  const factors = TO_BASE[fa.dimension]
  if (!factors || !(fa.unit in factors) || !(fb.unit in factors)) return null
  return (value * factors[fa.unit]) / factors[fb.unit]
}

/** 两个单位是否冲突：跨维度或不同标准单位。 */
export function isUnitMismatch(a: string, b: string, table?: UnitAliasTable): boolean {
  const t = table ?? loadUnitAliasTable()
  const ua = lookupUnit(a, t)
  const ub = lookupUnit(b, t)
  return ua.dimension !== ub.dimension || ua.unit !== ub.unit
}
