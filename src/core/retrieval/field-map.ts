/**
 * 字段映射表（Task 5）。
 *
 * 院内 MDM 字段名各院不一，用外置 JSON 映射表把院内字段名映射到内部规范
 * 字段名（spec.md §2）。**映射缺字段时显式报错并列出缺哪个字段**，不静默用
 * 默认映射兜底；映射文件缺失也报明确错误。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FieldMap } from '../types'

/** 内部规范字段全集（spec.md §2）。 */
export const INTERNAL_FIELDS = [
  'candidate_id', 'domain', 'name', 'spec', 'dosage_form', 'unit',
  'insurance_code', 'submit_source', 'submitted_at', 'status', 'version',
  'record_id', 'code',
] as const

/** 候选读入必须能映射到的字段。 */
export const REQUIRED_CANDIDATE_FIELDS = ['candidate_id', 'domain', 'name'] as const
/** 主数据记录必须能映射到的字段。 */
export const REQUIRED_MASTERDATA_FIELDS = ['code', 'record_id', 'domain', 'name', 'status'] as const

export class FieldMapError extends Error {
  constructor(message: string, readonly missingFields: string[] = []) {
    super(message)
    this.name = 'FieldMapError'
  }
}

function here(): string {
  // ESM/CJS 混合下 fileURLToPath 可能抛，回落到 cwd。
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    return process.cwd()
  }
}

/** 解析映射文件路径：优先给定路径，其次进程 cwd，再次相对本文件回溯到项目根。 */
export function resolveMapPath(mapPath?: string, cwd = process.cwd()): string {
  if (mapPath) {
    if (resolve(mapPath).startsWith('/') && existsSync(mapPath)) return resolve(mapPath)
    const fromCwd = resolve(cwd, mapPath)
    if (existsSync(fromCwd)) return fromCwd
    return fromCwd
  }
  const fromCwd = resolve(cwd, 'config/mdm-field-map.json')
  if (existsSync(fromCwd)) return fromCwd
  // src/core/retrieval/ → 项目根 config/
  const fromSrc = resolve(here(), '../../../config/mdm-field-map.json')
  if (existsSync(fromSrc)) return fromSrc
  return fromCwd
}

/** 载入映射表（过滤 $ 注释键）。 */
export function loadFieldMap(mapPath?: string, cwd = process.cwd()): FieldMap {
  const path = resolveMapPath(mapPath, cwd)
  if (!existsSync(path)) {
    throw new FieldMapError(`字段映射文件不存在：${path}。请检查 MDM_FIELD_MAP 指向的路径。`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new FieldMapError(`字段映射文件不是合法 JSON：${path}。${err instanceof Error ? err.message : ''}`)
  }
  const map: FieldMap = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (k.startsWith('$') || typeof v !== 'string') continue
    map[k] = v
  }
  return map
}

/** 单字段名映射：院内名 → 内部名；映射不到返回 null。 */
export function mapField(hospitalField: string, map: FieldMap): string | null {
  return map[hospitalField] ?? null
}

/**
 * 校验映射表能覆盖指定的内部字段集；缺字段时抛 FieldMapError 并逐项列出。
 */
export function assertMapCovers(
  map: FieldMap,
  required: readonly string[],
  label = '映射表',
): void {
  const mapped = new Set(Object.values(map))
  const missing = required.filter((field) => !mapped.has(field))
  if (missing.length > 0) {
    throw new FieldMapError(
      `${label}缺少必要字段映射（内部字段名）：${missing.join('、')}。请在映射表补充对应院内字段名。`,
      missing,
    )
  }
}

/**
 * 把一条院内原始记录（院内字段名为键）映射为内部规范字段记录。
 * 映射不到的院内字段被忽略；required 未覆盖时报错。
 */
export function applyFieldMap<R extends Record<string, unknown>>(
  raw: R,
  map: FieldMap,
  required: readonly string[] = REQUIRED_CANDIDATE_FIELDS,
): Record<string, unknown> {
  assertMapCovers(map, required)
  const out: Record<string, unknown> = {}
  for (const [hospitalField, value] of Object.entries(raw)) {
    const internal = map[hospitalField]
    if (internal) out[internal] = value
  }
  const missingInRecord = required.filter((field) => out[field] === undefined)
  if (missingInRecord.length > 0) {
    throw new FieldMapError(
      `记录字段缺失：映射后仍缺 ${missingInRecord.join('、')}。原始字段：${Object.keys(raw).join(', ')}`,
      missingInRecord,
    )
  }
  return out
}

/** 载入并自检：候选 + 主数据两类必需字段都覆盖。 */
export function loadValidatedFieldMap(mapPath?: string, cwd = process.cwd()): FieldMap {
  const map = loadFieldMap(mapPath, cwd)
  assertMapCovers(map, REQUIRED_CANDIDATE_FIELDS, '候选字段映射')
  assertMapCovers(map, REQUIRED_MASTERDATA_FIELDS, '主数据字段映射')
  return map
}

// join 供外部拼接默认路径使用，避免重复 import node:path。
export { join }
