/**
 * 唯一性闸门判定入口（Task 6 / 21 / 22 / 23）。
 *
 * 复合键唯一性判定：命中 1 条放行（还要过停用/版本）、>1 判多义交多义出口、
 * =0 交检索层判无近似项；缺关键字段返回 missing-fields。
 * 医保码精确命中走确定性通道（不调模型）：唯一即直接给 merge 证据。
 *
 * 停用码排除：status=停用 的记录不进「可自动并入目标」集合，但仍进证据与
 * 冲突展示集合。版本冲突：候选携带基准版本与命中记录 version 不一致即拒答。
 */
import { computeCompositeKey, recordCompositeKey } from './composite-key'
import { detectAmbiguity } from './ambiguity'
import type { CandidateRecord, GateOutcome, MasterDataRecord } from '../types'

export interface GateContext {
  /** 候选携带的基准版本；缺省不触发版本冲突。 */
  baseVersion?: string
  /** 是否启用停用码排除，默认 true。 */
  excludeDisabled?: boolean
}

/**
 * 主判定：候选 + 同复合键的命中记录集合 → GateOutcome。
 *
 * 调用方（retriever / engine）负责先按复合键过滤 records 传入本函数。
 */
export function decideGate(
  candidate: CandidateRecord,
  matchedRecords: MasterDataRecord[],
  ctx: GateContext = {},
): GateOutcome {
  const key = computeCompositeKey(candidate)
  if (key.status === 'missing') {
    return { kind: 'missing-fields', missing_keys: key.missing_keys }
  }

  // 多义优先：命中数 >1 直接拒答（含停用+启用混合，不因停用被排除而降为单义）。
  if (matchedRecords.length > 1) {
    return { kind: 'ambiguous', records: matchedRecords }
  }
  if (matchedRecords.length === 0) {
    return { kind: 'no-match' }
  }

  const record = matchedRecords[0]

  // 停用码排除：唯一命中为停用码 → 不作自动并入目标。
  if ((ctx.excludeDisabled ?? true) && record.status === '停用') {
    return { kind: 'no-match' }
  }

  // 版本冲突：候选基准版本与命中 record.version 不一致 → 交上层转 uncertain。
  if (ctx.baseVersion && ctx.baseVersion !== record.version) {
    // 用 unique 出口记录唯一命中，但带 baseVersion 不符；上层据 record 判版本冲突。
    // 为了让上层能区分，这里约定 default：返回 unique 且在 record 上不改写；
    // 版本冲突由 checkVersionConflict 单独判定，engine 调用时组合。
    return { kind: 'unique', record }
  }

  return { kind: 'unique', record }
}

/** 独立版本冲突判定（engine 在 gate=unique 后调用）。 */
export function checkVersionConflict(
  candidate: CandidateRecord,
  record: MasterDataRecord,
): boolean {
  if (!candidate.version) return false
  return candidate.version !== record.version
}

/** 复合键命中过滤：从全量主数据里挑出与候选同复合键的记录。 */
export function filterByCompositeKey(
  candidate: CandidateRecord,
  pool: MasterDataRecord[],
): MasterDataRecord[] {
  const ck = computeCompositeKey(candidate)
  if (ck.status === 'missing') return []
  return pool.filter((r) => {
    const rk = recordCompositeKey(r)
    return rk.status === 'ok' && rk.key === ck.key
  })
}

/** 医保码唯一命中：确定性通道，返回唯一命中 record（若非唯一返回 null）。 */
export function insuranceCodeUniqueHit(
  candidate: CandidateRecord,
  pool: MasterDataRecord[],
): MasterDataRecord | null {
  const code = (candidate.insurance_code ?? '').trim()
  if (!code) return null
  // 域不匹配记录一律排除（fee_item 的医保码不能跨域命中 drug 候选）。
  const hits = pool.filter(
    (r) => r.domain === candidate.domain && (r.insurance_code ?? '').trim() === code,
  )
  return hits.length === 1 ? hits[0] : null
}

/** 带医保码优先的命中集合：医保码能唯一定位时直接用，否则用复合键。 */
export function resolveMatchedRecords(
  candidate: CandidateRecord,
  pool: MasterDataRecord[],
): MasterDataRecord[] {
  const byCode = insuranceCodeUniqueHit(candidate, pool)
  if (byCode) return [byCode]
  return filterByCompositeKey(candidate, pool)
}
