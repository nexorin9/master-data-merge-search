/**
 * 字面相似度基线（Task 50）。
 *
 * Excel 模糊比对大致就是这一套。把基线做成可跑的确定性实现，才能量化
 * 「检索增强 + 模型」到底多带来了什么。四级确定性召回：
 *   ① 医保码精确匹配
 *   ② 规格单位归一后精确匹配（等价规格 + 同名）
 *   ③ 拼音首字母匹配
 *   ④ 字面相似度（BM25）
 * 排序按命中层级（1→4）再按相似度降序；同层同分按 record_id 稳定排序。
 * 结论取排序首条作为建议目标并给固定基线置信度，**不产生自然语言理由**
 * （这正是它与模型路径的差别）。基线的固有缺陷是只按排序取首条，故记录
 * 命中条数供对拍统计「多义被基线误并」的占比。
 */
import { pinyinInitials } from '../normalize/pinyin'
import { normalizeWidth } from '../normalize/width'
import { equivalentSpec } from '../normalize/spec'
import { normalizeText } from '../normalize/encoding'
import type { CandidateRecord, MasterDataRecord } from '../types'

export type BaselineLevel = 1 | 2 | 3 | 4

export interface BaselineHit {
  record: MasterDataRecord
  level: BaselineLevel
  score: number
  matched_by: string
}

/** 层级 → 固定基线置信度（Task 50 口径：医保码 0.95、拼音 0.5）。 */
export const BASELINE_CONFIDENCE: Record<BaselineLevel, number> = {
  1: 0.95,
  2: 0.8,
  3: 0.5,
  4: 0.4,
}

/** 规整文本：宽度归一 + 不可见字符 + 空白剥离 + 小写。 */
function norm(value: string): string {
  return normalizeText(normalizeWidth(value)).text.replace(/\s+/g, '').toLowerCase()
}

/** 规格等价：用 equivalentSpec 的真实口径（0.25g*12片 ≡ 250mg*12片）。 */
function specEqual(a: string, b: string): boolean {
  if (!a || !b) return false
  try {
    return equivalentSpec(a, b)
  } catch {
    return norm(a) === norm(b)
  }
}

/** 单位归一比较：同维度同类单位视为相等（盒/瓶等包装单位按字面）。 */
function unitEqual(a: string | undefined, b: string | undefined): boolean {
  const na = (a ?? '').trim()
  const nb = (b ?? '').trim()
  return na === nb || (!!na && !!nb && norm(na) === norm(nb))
}

/** BM25 字面相似（确定性的简化实现：k1=1.5, b=0.75，中文按字切分）。 */
export function bm25(query: string, corpus: string[]): number {
  const tokenize = (s: string): string[] => [...norm(s)].filter((c) => c.length > 0)
  const q = tokenize(query)
  if (q.length === 0 || corpus.length === 0) return 0

  const docs = corpus.map(tokenize)
  const avgdl = docs.reduce((sum, d) => sum + d.length, 0) / docs.length
  const df = new Map<string, number>()
  for (const doc of docs) {
    for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1)
  }
  const k1 = 1.5
  const b = 0.75
  const N = docs.length
  let total = 0
  for (const doc of docs) {
    const tf = new Map<string, number>()
    for (const term of doc) tf.set(term, (tf.get(term) ?? 0) + 1)
    let score = 0
    for (const term of new Set(q)) {
      const f = tf.get(term) ?? 0
      if (f === 0) continue
      const idf = Math.log(1 + (N - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5))
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (doc.length / (avgdl || 1))))
    }
    total += score
  }
  // 取 corpus 中第一条作为 query 的目标文档分数（调用方逐条传单文档）。
  return total
}

/**
 * 单条候选对单条记录的字面相似度（返回 0–1 归一值）。
 * 只比名称文本：规格相同但名称完全不同的两条不应被判为「字面相似」，
 * 否则任何共享同一规格的编码都会互相召回，基线就失去区分力。
 * 稳定、无随机、无时间依赖（Jaccard 型字符重合度）。
 */
export function literalSimilarity(candidate: CandidateRecord, record: MasterDataRecord): number {
  const a = norm(candidate.name ?? '')
  const b = norm(record.name ?? '')
  if (!a || !b) return 0
  const setA = new Set([...a])
  const setB = new Set([...b])
  const common = [...setA].filter((c) => setB.has(c)).length
  return common / Math.max(1, Math.max(setA.size, setB.size))
}

/** 判定单条 候选 vs 记录 的命中层级与分数；不命中返回 null。 */
export function classifyBaselineHit(candidate: CandidateRecord, record: MasterDataRecord): BaselineHit | null {
  if (candidate.domain !== record.domain) return null

  // ① 医保码精确
  if (candidate.insurance_code && record.insurance_code && candidate.insurance_code === record.insurance_code) {
    return { record, level: 1, score: 1, matched_by: '医保码精确匹配' }
  }

  // ② 规格单位归一后精确（同名 + 等价规格 + 同单位）
  if (
    candidate.name && record.name && norm(candidate.name) === norm(record.name) &&
    candidate.spec && record.spec && specEqual(candidate.spec, record.spec) &&
    unitEqual(candidate.unit, record.unit)
  ) {
    return { record, level: 2, score: 0.9, matched_by: '规格单位归一后精确' }
  }

  // ③ 拼音首字母匹配（名称首字母相同且非平凡）
  const cp = pinyinInitials(candidate.name ?? '')
  const rp = pinyinInitials(record.name ?? '')
  if (cp.length >= 2 && cp === rp) {
    return { record, level: 3, score: 0.6, matched_by: '拼音首字母匹配' }
  }

  // ④ 字面相似度（>0 即召回，按相似度排序）
  const sim = literalSimilarity(candidate, record)
  if (sim > 0) {
    return { record, level: 4, score: sim, matched_by: '字面相似' }
  }
  return null
}

export interface BaselineConclusion {
  candidate_id: string
  action: 'create' | 'merge'
  target_code: string | null
  confidence: number
  rationale: '' // 基线刻意不产出自然语言理由
  hit_count: number
  ambiguous_top_hits: number
  ranking: BaselineHit[]
}

/**
 * 基线结论：对单条候选在全量主数据池上跑四级召回，取排序首条。
 * 命中 0 条 → create；命中 ≥1 → merge 到首条（这是基线的固有缺陷：
 * 多义时仍取第一条，靠 ambiguous_top_hits 计数供对拍统计误并占比）。
 * 全程确定性：同输入两次结果逐字段一致。
 */
export function baselineConclude(candidate: CandidateRecord, pool: MasterDataRecord[]): BaselineConclusion {
  const ranking: BaselineHit[] = []
  for (const record of pool) {
    const hit = classifyBaselineHit(candidate, record)
    if (hit) ranking.push(hit)
  }
  // 层级升序 → 分数降序 → record_id 升序（稳定可复现）
  ranking.sort((a, b) =>
    a.level - b.level ||
    b.score - a.score ||
    a.record.record_id.localeCompare(b.record.record_id),
  )

  if (ranking.length === 0) {
    return {
      candidate_id: candidate.candidate_id,
      action: 'create',
      target_code: null,
      confidence: BASELINE_CONFIDENCE[1],
      rationale: '',
      hit_count: 0,
      ambiguous_top_hits: 0,
      ranking: [],
    }
  }

  const top = ranking[0]
  // 与首条同层级同分数的条数（基线多义误并统计口径）。
  const ambiguousTopHits = ranking.filter(
    (h) => h.level === top.level && Math.abs(h.score - top.score) < 1e-9,
  ).length
  return {
    candidate_id: candidate.candidate_id,
    action: 'merge',
    target_code: top.record.code,
    confidence: BASELINE_CONFIDENCE[top.level],
    rationale: '',
    hit_count: ranking.length,
    ambiguous_top_hits: ambiguousTopHits,
    ranking,
  }
}

/** 批量基线：逐条独立，顺序稳定。 */
export function baselineBatch(candidates: CandidateRecord[], pool: MasterDataRecord[]): BaselineConclusion[] {
  return candidates.map((c) => baselineConclude(c, pool))
}
