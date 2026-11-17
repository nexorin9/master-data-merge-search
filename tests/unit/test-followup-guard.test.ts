import { describe, expect, it } from 'vitest'
import { guardFollowupAnswer } from '@core/followup/guard'
import { createSessionStore } from '@core/followup/session-store'
import type { EvidenceItem, MasterDataRecord, MergeConclusion } from '@core/types'

const NOW = '2026-11-10T10:00:00.000Z'
const SNAPSHOT: MasterDataRecord[] = [
  makeRecord('MD-0001'),
  makeRecord('MD-0002', 'CODE-0002'),
]

function makeRecord(recordId: string, code = 'CODE-0001'): MasterDataRecord {
  return {
    code,
    record_id: recordId,
    domain: 'drug',
    name: '阿莫西林胶囊',
    spec: '0.25g*12片',
    dosage_form: '胶囊剂',
    unit: '盒',
    insurance_code: 'XJ7000000000001',
    status: '启用',
    version: 'v1',
  }
}

function makeEvidence(over: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    record_id: 'MD-0001',
    field: 'spec',
    candidate_value: '0.25g*12片',
    matched_value: '0.25g*12片',
    ...over,
  }
}

function makeConclusion(over: Partial<MergeConclusion> = {}): MergeConclusion {
  return {
    candidate_id: 'C-1',
    domain: 'drug',
    action: 'merge',
    target_code: 'CODE-0001',
    confidence: 0.9,
    rationale: '规格与医保码一致',
    evidence: [makeEvidence()],
    uncertain_reason: null,
    missing_fields: [],
    degraded: false,
    source: 'model',
    ...over,
  }
}

function setupStore() {
  const store = createSessionStore({ now: () => NOW })
  const conclusion = makeConclusion()
  store.open({
    conclusion,
    snapshot_version: 'snap-1',
    snapshot: SNAPSHOT,
    master_data_version: 'v1',
  })
  return { store, conclusion }
}

describe('追问轮越界引用拒绝（Task 37）', () => {
  it('referenced_record_ids 引用快照外 record_id → 拒绝并记越界事件', () => {
    const conclusion = makeConclusion()
    const before = structuredClone(conclusion)
    const result = guardFollowupAnswer({
      question: '为什么不并到 MD-OUT-1？',
      answer: '那条更合适',
      referenced_record_ids: ['MD-0001', 'MD-OUT-1'],
      evidence: [makeEvidence()],
    }, { snapshot: SNAPSHOT, conclusion, now: () => NOW })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('回答引用了未检索的记录，已拒绝')
    expect(result.attach).toBeNull()
    expect(result.rationale).toBe('')
    expect(result.offending_record_ids).toEqual(['MD-OUT-1'])
    expect(result.out_of_bounds).toHaveLength(1)
    expect(result.out_of_bounds[0]).toMatchObject({
      candidate_id: 'C-1',
      record_id: 'MD-OUT-1',
      source: 'referenced_record_ids',
      at: NOW,
    })
    expect(conclusion).toEqual(before)
  })

  it('evidence 里的 record_id 越界 → 拒绝且事件 source 标明证据字段', () => {
    const result = guardFollowupAnswer({
      question: '依据是什么？',
      answer: '有证据',
      referenced_record_ids: ['MD-0001'],
      evidence: [makeEvidence(), makeEvidence({ record_id: 'MD-GHOST', field: 'name' })],
    }, { snapshot: SNAPSHOT, conclusion: makeConclusion(), now: () => NOW })

    expect(result.ok).toBe(false)
    expect(result.offending_record_ids).toEqual(['MD-GHOST'])
    expect(result.out_of_bounds).toHaveLength(1)
    expect(result.out_of_bounds[0].source).toBe('evidence:name')
    expect(result.out_of_bounds[0].record_id).toBe('MD-GHOST')
  })

  it('无证据答案 → 只回「无法给出依据」，不编理由；不完整证据同样拒绝', () => {
    const deps = { snapshot: SNAPSHOT, conclusion: makeConclusion(), now: () => NOW }
    const noEvidence = guardFollowupAnswer({
      question: '凭什么？',
      answer: '凭我感觉应该并入',
      referenced_record_ids: ['MD-0001'],
    }, deps)
    expect(noEvidence.ok).toBe(false)
    expect(noEvidence.reason).toBe('无法给出依据')
    expect(noEvidence.rationale).toBe('')
    expect(noEvidence.attach).toBeNull()
    expect(noEvidence.out_of_bounds).toEqual([])

    const incomplete = guardFollowupAnswer({
      question: '凭什么？',
      answer: '有证据',
      // 缺 matched_value，四要素不齐。
      evidence: [{ record_id: 'MD-0001', field: 'spec', candidate_value: '0.25g*12片' }] as EvidenceItem[],
    }, deps)
    expect(incomplete.ok).toBe(false)
    expect(incomplete.reason).toBe('无法给出依据')
    expect(incomplete.attach).toBeNull()
  })

  it('追问不得把主结论从 merge 改写成 create', () => {
    const conclusion = makeConclusion({ action: 'merge', target_code: 'CODE-0001' })
    const result = guardFollowupAnswer({
      question: '是不是该新建？',
      answer: '应改为新建更合适',
      proposed_action: 'create',
      referenced_record_ids: ['MD-0001'],
      evidence: [makeEvidence()],
    }, { snapshot: SNAPSHOT, conclusion, now: () => NOW })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('不得改写主结论')
    expect(result.attach).toBeNull()
    expect(result.conclusion.action).toBe('merge')
  })

  it('反向 create→merge 同样拒绝；答案正文里的「结论改为」也算改写尝试', () => {
    const created = makeConclusion({ action: 'create', target_code: null })
    const reverse = guardFollowupAnswer({
      question: '能并入吗？',
      answer: '建议并入这条',
      proposed_action: 'merge',
      evidence: [makeEvidence()],
    }, { snapshot: SNAPSHOT, conclusion: created, now: () => NOW })
    expect(reverse.ok).toBe(false)
    expect(reverse.reason).toContain('不得改写主结论')

    const merged = makeConclusion({ action: 'merge' })
    const byText = guardFollowupAnswer({
      question: '再确认一下',
      answer: '结论改为 create',
      evidence: [makeEvidence()],
    }, { snapshot: SNAPSHOT, conclusion: merged, now: () => NOW })
    expect(byText.ok).toBe(false)
    expect(byText.reason).toContain('不得改写主结论')

    // 否定式「不能改为」不误伤正常回答。
    const negated = guardFollowupAnswer({
      question: '能改成新建吗？',
      answer: '不能改为新建，仍应并入',
      evidence: [makeEvidence()],
    }, { snapshot: SNAPSHOT, conclusion: merged, now: () => NOW })
    expect(negated.ok).toBe(true)
  })

  it('正常答案带边界内证据 → 通过，返回可挂接的答案与证据', () => {
    const conclusion = makeConclusion()
    const result = guardFollowupAnswer({
      question: '为什么不并到另一条？',
      answer: '规格一致且医保码相同，因此维持并入结论',
      referenced_record_ids: ['MD-0001', 'MD-0002'],
      evidence: [
        makeEvidence(),
        makeEvidence({
          record_id: 'MD-0002',
          field: 'insurance_code',
          candidate_value: 'XJ7000000000001',
          matched_value: 'XJ7000000000001',
        }),
      ],
      model_call_id: 'call-ok',
    }, { snapshot: SNAPSHOT, conclusion, now: () => NOW })

    expect(result.ok).toBe(true)
    expect(result.reason).toBe('已通过越界与证据校验')
    expect(result.out_of_bounds).toEqual([])
    expect(result.attach).not.toBeNull()
    expect(result.attach!.question).toBe('为什么不并到另一条？')
    expect(result.attach!.referenced_record_ids).toEqual(['MD-0001', 'MD-0002'])
    expect(result.attach!.evidence).toHaveLength(2)
    expect(result.attach!.rationale).toBe(result.attach!.answer)
    expect(result.attach!.model_call_id).toBe('call-ok')
    expect(result.conclusion).toEqual(conclusion)
    expect(result.conclusion.action).toBe('merge')
  })

  it('多个引用混合有效 / 无效 → 拒绝并列出全部越界 id 与来源', () => {
    const result = guardFollowupAnswer({
      question: '为什么不并到那两条？',
      answer: '需要更多依据',
      referenced_record_ids: ['MD-0001', 'MD-OUT-A', 'MD-0002', 'MD-OUT-B'],
      evidence: [makeEvidence(), makeEvidence({ record_id: 'MD-OUT-C', field: 'name' })],
    }, { snapshot: SNAPSHOT, conclusion: makeConclusion(), now: () => NOW })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('回答引用了未检索的记录，已拒绝')
    expect(result.offending_record_ids).toEqual(['MD-OUT-A', 'MD-OUT-B', 'MD-OUT-C'])
    expect(result.out_of_bounds.map((event) => event.record_id))
      .toEqual(['MD-OUT-A', 'MD-OUT-B', 'MD-OUT-C'])
    expect(result.out_of_bounds.map((event) => event.source))
      .toEqual(['referenced_record_ids', 'referenced_record_ids', 'evidence:name'])
    expect(result.attach).toBeNull()
  })

  it('拒绝不改写已存结论，也不把答案写进证据链 / 追问轮', () => {
    const { store, conclusion } = setupStore()
    const stored = store.get('C-1')!
    const before = structuredClone(conclusion)
    const beforeEvidence = structuredClone(conclusion.evidence)

    const result = guardFollowupAnswer({
      question: '为什么不并到 MD-OUT？',
      answer: '应该改为新建',
      referenced_record_ids: ['MD-OUT'],
      evidence: [makeEvidence({ record_id: 'MD-OUT' })],
    }, {
      allowed_record_ids: store.allowedRecordIds('C-1'),
      conclusion: stored.conclusion,
      now: () => NOW,
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('回答引用了未检索的记录，已拒绝')
    expect(result.attach).toBeNull()
    // 传入的同一对象与仓库里的结论都保持原样。
    expect(stored.conclusion).toEqual(before)
    expect(result.conclusion).toEqual(before)
    expect(stored.conclusion.evidence).toEqual(beforeEvidence)
    expect(store.get('C-1')!.conclusion).toEqual(before)
    expect(store.get('C-1')!.conclusion.evidence).toEqual(beforeEvidence)
    expect(store.get('C-1')!.turns).toHaveLength(0)
  })
})
