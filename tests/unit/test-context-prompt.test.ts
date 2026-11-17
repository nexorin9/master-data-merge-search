import { describe, expect, it } from 'vitest'
import { buildMergeRequestTurn, formatContextPromptText, hasXmlWrapper } from '@core/retrieval/context-prompt'
import type { CandidateRecord, ContextSnapshotEntry } from '@core/types'

const snap = (text: string, recordId = 'MD-1'): ContextSnapshotEntry => ({
  key: 'masterdata:drug', text, record_id: recordId, query_term: '阿莫西林',
  ingested_at: 1, snapshot_version: 'snap-1',
})

const candidate: CandidateRecord = {
  candidate_id: 'C-1', domain: 'drug', name: '阿莫西林胶囊',
  spec: '0.25g*12片', dosage_form: '胶囊剂', unit: '盒', insurance_code: 'XJ1',
}

describe('上下文渲染（Task 7 对照测试）', () => {
  it('输出以 [Context] 开头，每行 - key: text', () => {
    const out = formatContextPromptText([snap('名称=阿莫西林')])
    expect(out.startsWith('[Context]')).toBe(true)
    expect(out).toContain('- masterdata:drug#MD-1: 名称=阿莫西林')
  })

  it('不含 XML 包裹符（弱模型会照抄）', () => {
    const out = formatContextPromptText([snap('x')])
    expect(hasXmlWrapper(out)).toBe(false)
    expect(out).not.toMatch(/<(context|evidence|conclusion)>/i)
  })

  it('空快照返回空串', () => {
    expect(formatContextPromptText([])).toBe('')
  })

  it('多行文本被压平为单行', () => {
    const out = formatContextPromptText([snap('第一行\n第二行')])
    // [Context] 段本身按行分隔，但单条条目内部不得含换行。
    const entryLine = out.split('\n').find((l) => l.startsWith('- '))!
    expect(entryLine).not.toMatch(/\n/)
    expect(entryLine).toContain('第一行 第二行')
  })

  it('归并请求 turn 含上下文段与候选字段，且只引用快照记录', () => {
    const turn = buildMergeRequestTurn([snap('名称=阿莫西林')], candidate)
    expect(turn).toContain('[Context]')
    expect(turn).toContain('[本批归并请求]')
    expect(turn).toContain('候选编号=C-1')
    expect(turn).toContain('只引用上方 [Context] 内的记录')
  })
})
