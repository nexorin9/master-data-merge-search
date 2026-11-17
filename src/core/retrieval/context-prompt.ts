/**
 * 上下文渲染进 prompt（Task 7）。
 *
 * 复用源产品 formatContextPromptText 行为：渲染 `[Context]` 平铺段
 * （每行 `- <key>: <text>`），**不使用 <context> 类 XML 包裹符**（弱模型会
 * 照抄包裹符）。文案改为院内主数据 + 候选字段。
 */
import type { ContextSnapshotEntry, CandidateRecord } from '../types'

/** 渲染单条上下文条目为一行。 */
function renderEntry(entry: ContextSnapshotEntry): string {
  const key = entry.record_id
    ? `${entry.key}#${entry.record_id}`
    : entry.key
  const source = entry.query_term ? ` [召回:${entry.query_term}]` : ''
  const text = entry.text.replace(/\s*\n\s*/g, ' ').trim()
  return `- ${key}: ${text}${source}`
}

/** 把快照渲染成 [Context] 平铺段。空快照返回空串。 */
export function formatContextPromptText(entries: ContextSnapshotEntry[]): string {
  if (entries.length === 0) return ''
  return ['[Context]', ...entries.map(renderEntry)].join('\n')
}

/** 组装本轮归并请求 turn：上下文段 + 请求说明 + 候选字段。 */
export function buildMergeRequestTurn(
  snapshot: ContextSnapshotEntry[],
  candidate: CandidateRecord,
): string {
  const contextBlock = formatContextPromptText(snapshot)
  const candidateLine = [
    `候选编号=${candidate.candidate_id}`,
    `域=${candidate.domain}`,
    `名称=${candidate.name}`,
    candidate.spec ? `规格=${candidate.spec}` : '',
    candidate.dosage_form ? `剂型=${candidate.dosage_form}` : '',
    candidate.unit ? `单位=${candidate.unit}` : '',
    candidate.insurance_code ? `医保码=${candidate.insurance_code}` : '',
  ].filter(Boolean).join('；')

  const sections = [
    contextBlock,
    '[本批归并请求]',
    `- 待评候选: ${candidateLine}`,
    '- 请判定：新建(create) / 并入(merge，给目标编码) / 存疑(uncertain，给原因)',
    '- 逐字段给证据：record_id、field、候选值、命中值；只引用上方 [Context] 内的记录',
  ].filter((s) => s.length > 0)
  return sections.join('\n')
}

/** 断言不含 XML 包裹符（对照测试用）。 */
export function hasXmlWrapper(text: string): boolean {
  return /<(context|contexts|evidence|conclusion)[ >]/i.test(text)
}
