/**
 * 检索词构造器（Task 19）。
 *
 * 候选名常是院内商品名，检索需要「名称原文 / 去规格后名称 / 拼音首字母 /
 * 医保码」四路检索词才能召回。输出顺序固定，可被单测断言。
 */
import { pinyinInitials } from './pinyin'
import { normalizeWidth } from './width'
import type { CandidateRecord, QueryTerms } from '../types'

/** 规格 / 剂型 / 包装词：从名称里剥掉，得到「去规格后名称」。 */
const STRIP_TOKENS = [
  '片剂', '胶囊剂', '注射剂', '颗粒剂', '口服溶液剂', '散剂', '丸剂', '栓剂',
  '缓释胶囊', '缓释片', '分散片', '肠溶片', '咀嚼片', '泡腾片',
  '胶囊', '缓释', '分散', '肠溶', '咀嚼', '泡腾',
  '注射液', '口服液', '溶液', '颗粒', '冲剂',
  '片', '粒', '丸', '袋', '支', '瓶', '盒', '管', '贴', '剂',
]

/** 规格样式：0.25g*12片 / 250mg×12片 / 100ml*1瓶。函数内新建避免 g 标志 lastIndex 残留。 */
function specPattern(): RegExp {
  return /\d+(?:\.\d+)?\s*(?:mg|g|kg|μg|ug|微克|毫克|克|ml|毫升|l|升)?\s*[*×x/／·]\s*\d+\s*(?:片|粒|袋|支|瓶|盒|管|丸|贴)?/gi
}

/** 去掉规格表达式与包装 / 剂型词，得到核心名称。 */
export function stripName(name: string): string {
  let s = normalizeWidth(name)
  s = s.replace(specPattern(), '')
  // 长词优先剥离，避免「片」先于「缓释片」把词切碎。
  for (const token of STRIP_TOKENS) {
    s = s.split(token).join('')
  }
  return s.replace(/\s+/g, '').trim()
}

/** 构造固定顺序的四条检索词。 */
export function buildQueryTerms(candidate: CandidateRecord): QueryTerms {
  const raw = normalizeWidth(candidate.name ?? '').trim()
  const stripped = stripName(candidate.name ?? '')
  return {
    raw_name: raw,
    stripped_name: stripped,
    pinyin_initials: pinyinInitials(stripped || raw),
    insurance_code: (candidate.insurance_code ?? '').trim(),
  }
}

/** 检索词 → 稳定数组（顺序固定，供 retriever 与单测断言）。 */
export function queryTermList(terms: QueryTerms): string[] {
  return [terms.raw_name, terms.stripped_name, terms.pinyin_initials, terms.insurance_code]
}
