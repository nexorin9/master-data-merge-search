import { describe, expect, it } from 'vitest'
import { compactSession } from '@core/followup/compaction'
import { guardFollowupAnswer } from '@core/followup/guard'
import { createSessionStore } from '@core/followup/session-store'
import type { DiffSummary, EvidenceItem, MasterDataRecord, MergeConclusion } from '@core/types'

const NOW = '2026-11-10T09:00:00.000Z'

/** 8 条互不重复、与候选相关的实质追问。 */
const SUBSTANTIVE_QUESTIONS = [
  '为什么不并到 MD-A1？',
  '规格字段为什么判定冲突？',
  '医保码一致但单位不同怎么办？',
  '名称相近但剂型不同如何处理？',
  '停用记录能否作为并入目标？',
  '关键字段缺失时为什么存疑？',
  '同一医保码出现两条怎么选？',
  '版本冲突依据是哪一条规则？',
]

function makeRecord(over: Partial<MasterDataRecord> = {}): MasterDataRecord {
  return {
    code: 'CODE-A1',
    record_id: 'MD-A1',
    domain: 'drug',
    name: '阿莫西林胶囊',
    spec: '0.25g*12片',
    dosage_form: '胶囊剂',
    unit: '盒',
    insurance_code: 'XJ7000000000001',
    status: '启用',
    version: 'v1',
    ...over,
  }
}

function makeEvidence(over: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    record_id: 'MD-A1',
    field: 'spec',
    candidate_value: '0.25g*12片',
    matched_value: '0.25g*12片',
    ...over,
  }
}

function makeFieldDiffs(): DiffSummary {
  return {
    diffs: [
      { field: 'spec', candidate_value: '0.25g*12片', matched_value: '0.25g*12片', equal: true, kind: 'exact' },
      { field: 'insurance_code', candidate_value: 'XJ7000000000001', matched_value: 'XJ7000000000001', equal: true, kind: 'exact' },
      { field: 'unit', candidate_value: '盒', matched_value: '支', equal: false, kind: 'conflict' },
    ],
    counts: { exact: 2, normalized: 0, conflict: 1, missing: 0, absent: 0 },
    conflict_fields: ['unit'],
  }
}

function makeConclusion(): MergeConclusion {
  return {
    candidate_id: 'C-A',
    domain: 'drug',
    action: 'merge',
    target_code: 'CODE-A1',
    confidence: 0.9,
    rationale: '候选甲理由',
    evidence: [makeEvidence()],
    uncertain_reason: null,
    missing_fields: [],
    degraded: false,
    source: 'model',
    field_diffs: makeFieldDiffs(),
  }
}

/** 11 轮：8 实质 + 1 闲聊 + 1 重复提问 + 1 无关措辞，超过阈值 8。 */
function setup() {
  const store = createSessionStore({ now: () => NOW })
  const snapshot = [
    makeRecord(),
    makeRecord({ record_id: 'MD-A2', code: 'CODE-A2' }),
  ]
  const conclusion = makeConclusion()
  store.open({ conclusion, snapshot_version: 'snap-1', snapshot, master_data_version: 'v1' })

  SUBSTANTIVE_QUESTIONS.forEach((question, index) => {
    store.addTurn('C-A', {
      question,
      answer: `依据第 ${index + 1} 条证据说明`,
      referenced_record_ids: ['MD-A1'],
      evidence: [makeEvidence()],
      model_call_id: `call-${index + 1}`,
    }, { masterDataVersionOf: () => 'v1' })
  })
  // 闲聊（整条短问句命中模式表）。
  store.addTurn('C-A', { question: '你好', answer: '您好' }, { masterDataVersionOf: () => 'v1' })
  // 重复提问：归一化后与第 1 条实质问题相同。
  store.addTurn('C-A', {
    question: '为什么不并到MD-A1',
    answer: '重复提问的应答',
    evidence: [makeEvidence()],
  }, { masterDataVersionOf: () => 'v1' })
  // 与当前候选无关的措辞。
  store.addTurn('C-A', {
    question: '顺便问下另一个候选的收费项目编码',
    answer: '改天再说',
  }, { masterDataVersionOf: () => 'v1' })

  return { store, conclusion, snapshot }
}

describe('追问会话压缩（Task 36）', () => {
  it('超阈值才压缩；压缩后结论（action/target_code/confidence/uncertain_reason）与 evidence[] 仍在', () => {
    const { store } = setup()
    const original = store.get('C-A')!
    expect(original.turns).toHaveLength(11)

    const compacted = compactSession(original)
    expect(compacted.conclusion.action).toBe(original.conclusion.action)
    expect(compacted.conclusion.target_code).toBe(original.conclusion.target_code)
    expect(compacted.conclusion.confidence).toBe(original.conclusion.confidence)
    expect(compacted.conclusion.uncertain_reason).toBe(original.conclusion.uncertain_reason)
    expect(compacted.conclusion.evidence).toEqual(original.conclusion.evidence)
    expect(compacted.conclusion.evidence.length).toBeGreaterThanOrEqual(1)
    expect(compacted.snapshot_records).toEqual(original.snapshot_records)

    // 阈值以下不压缩：轮次与计数原样保留。
    const small = compactSession({ ...original, turns: original.turns.slice(0, 2), discarded_count: 0 })
    expect(small.turns).toHaveLength(2)
    expect(small.discarded_count).toBe(0)
    expect(small.compaction.ratio).toBe(0)
  })

  it('闲聊被丢弃且 discarded_count / ratio 正确', () => {
    const { store } = setup()
    const compacted = compactSession(store.get('C-A')!)

    expect(compacted.turns).toHaveLength(8)
    expect(compacted.discarded_count).toBe(3)
    expect(compacted.compaction.discarded_count).toBe(3)
    expect(compacted.compaction.discarded_turns).toBe(3)
    expect(compacted.compaction.kept).toBe(8)
    expect(compacted.compaction.ratio).toBeCloseTo(3 / 11, 10)
    const questions = compacted.turns.map((t) => t.question)
    expect(questions).not.toContain('你好')
    expect(questions).not.toContain('顺便问下另一个候选的收费项目编码')

    // 压缩是视图变换，不回写仓库里的原会话。
    expect(store.get('C-A')!.turns).toHaveLength(11)
    expect(store.get('C-A')!.discarded_count).toBe(0)
  })

  it('两次压缩结果完全一致（幂等，且纯函数重复调用一致）', () => {
    const { store } = setup()
    const once = compactSession(store.get('C-A')!)
    const twice = compactSession(once)

    expect(twice).toEqual(once)
    expect(twice.turns.map((t) => t.question)).toEqual(once.turns.map((t) => t.question))
    expect(twice.compaction).toEqual(once.compaction)
    expect(twice.discarded_count).toBe(once.discarded_count)

    const again = compactSession(store.get('C-A')!)
    expect(again).toEqual(once)
  })

  it('压缩后仍可继续一次带证据的追问（经越界闸门校验）', () => {
    const { store } = setup()
    const compacted = compactSession(store.get('C-A')!)
    store.replace(compacted)

    const guarded = guardFollowupAnswer({
      question: '压缩后还能追问吗？',
      answer: '可以，医保码与规格都一致',
      referenced_record_ids: ['MD-A1'],
      evidence: [makeEvidence()],
      model_call_id: 'call-after',
    }, {
      allowed_record_ids: store.allowedRecordIds('C-A'),
      conclusion: compacted.conclusion,
    })
    expect(guarded.ok).toBe(true)
    expect(guarded.attach).not.toBeNull()
    expect(guarded.attach!.evidence).toHaveLength(1)

    const after = store.addTurn('C-A', {
      question: guarded.attach!.question,
      answer: guarded.attach!.answer,
      referenced_record_ids: guarded.attach!.referenced_record_ids,
      evidence: guarded.attach!.evidence,
      model_call_id: 'call-after',
    }, { masterDataVersionOf: () => 'v1' })

    expect(after.turns).toHaveLength(compacted.turns.length + 1)
    expect(after.turns.at(-1)!.evidence).toHaveLength(1)
    expect(after.turns.at(-1)!.evidence[0].record_id).toBe('MD-A1')
    expect(after.turns.at(-1)!.refreshed).toBe(false)
    expect(after.turns.at(-1)!.model_call_id).toBe('call-after')
  })

  it('关键字段对照摘要保留：field_diffs 与派生摘要都在', () => {
    const { store } = setup()
    const original = store.get('C-A')!
    const compacted = compactSession(original)

    expect(compacted.conclusion.field_diffs).toEqual(original.conclusion.field_diffs)
    expect(compacted.key_field_summary.entries.map((e) => e.field))
      .toEqual(['insurance_code', 'spec', 'unit'])
    expect(compacted.key_field_summary.conflict_fields).toEqual(['unit'])
    expect(compacted.key_field_summary.entries.find((e) => e.field === 'unit')!.matched_value).toBe('支')
  })

  it('结论无 field_diffs 时，从 evidence[] 确定性派生关键字段摘要', () => {
    const { store, conclusion } = setup()
    const original = store.get('C-A')!
    const withoutDiffs = {
      ...original,
      conclusion: { ...conclusion, field_diffs: undefined },
    }
    const compacted = compactSession(withoutDiffs)

    expect(compacted.key_field_summary.entries.map((e) => e.field)).toEqual(['spec'])
    expect(compacted.key_field_summary.entries[0]).toEqual({
      field: 'spec',
      candidate_value: '0.25g*12片',
      matched_value: '0.25g*12片',
      conflict: false,
    })
    expect(compacted.conclusion.evidence).toEqual(original.conclusion.evidence)
  })

  it('重复提问只保留首次出现的一轮', () => {
    const { store } = setup()
    const compacted = compactSession(store.get('C-A')!)

    expect(compacted.turns.map((t) => t.answer)).not.toContain('重复提问的应答')
    expect(compacted.turns.filter((t) => t.question.includes('为什么不并到'))).toHaveLength(1)
    expect(compacted.turns[0].question).toBe('为什么不并到 MD-A1？')
    expect(compacted.turns[0].model_call_id).toBe('call-1')
  })

  it('与当前候选无关的措辞及快照外 record_id 的整轮都被丢弃', () => {
    const { store } = setup()
    store.addTurn('C-A', {
      question: '为什么不并到 MD-FOREIGN？',
      answer: '那条不在快照里',
      referenced_record_ids: ['MD-FOREIGN'],
      evidence: [makeEvidence({ record_id: 'MD-FOREIGN' })],
    }, { masterDataVersionOf: () => 'v1' })

    const compacted = compactSession(store.get('C-A')!)
    const questions = compacted.turns.map((t) => t.question)
    expect(compacted.turns).toHaveLength(8)
    expect(compacted.discarded_count).toBe(4)
    expect(compacted.compaction.ratio).toBeCloseTo(4 / 12, 10)
    expect(questions).not.toContain('顺便问下另一个候选的收费项目编码')
    expect(questions.some((q) => q.includes('MD-FOREIGN'))).toBe(false)
  })
})
