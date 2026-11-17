import { describe, expect, it, vi } from 'vitest'
import { projectSession } from '@core/followup/projection'
import { createSessionStore } from '@core/followup/session-store'
import type { EvidenceItem, MasterDataRecord, MergeConclusion } from '@core/types'

const NOW = '2026-11-10T08:00:00.000Z'

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

function makeConclusion(over: Partial<MergeConclusion> = {}): MergeConclusion {
  return {
    candidate_id: 'C-A',
    domain: 'drug',
    action: 'merge',
    target_code: 'CODE-A1',
    confidence: 0.92,
    rationale: '候选甲专属理由：规格与医保码一致',
    evidence: [makeEvidence()],
    uncertain_reason: null,
    missing_fields: [],
    degraded: false,
    source: 'model',
    ...over,
  }
}

function setup() {
  const store = createSessionStore({ now: () => NOW })
  const snapshot = [makeRecord()]
  const session = store.open({
    conclusion: makeConclusion(),
    snapshot_version: 'snap-1',
    snapshot,
    master_data_version: 'v1',
  })
  return { store, snapshot, session }
}

describe('追问会话投影与快照复用（Task 35）', () => {
  it('投影含已有结论（action/target_code/confidence/uncertain_reason）与证据链', () => {
    const { session } = setup()
    const view = projectSession(session, { now: () => NOW })

    expect(view.candidate_id).toBe('C-A')
    expect(view.conclusion.action).toBe('merge')
    expect(view.conclusion.target_code).toBe('CODE-A1')
    expect(view.conclusion.confidence).toBe(0.92)
    expect(view.conclusion.uncertain_reason).toBeNull()
    expect(view.evidence_chain).toEqual(session.conclusion.evidence)
    expect(view.evidence_chain[0].record_id).toBe('MD-A1')
    // 结论视图只留白名单字段，rationale 等自由文本一律不带。
    expect(Object.keys(view.conclusion)).not.toContain('rationale')
    expect('rationale' in view.conclusion).toBe(false)
  })

  it('投影不含另一候选的任何 record_id / 结论 / 专属文本', () => {
    const store = createSessionStore({ now: () => NOW })
    const a = store.open({
      conclusion: makeConclusion(),
      snapshot_version: 'snap-1',
      snapshot: [makeRecord()],
      master_data_version: 'v1',
    })
    const b = store.open({
      conclusion: makeConclusion({
        candidate_id: 'C-B',
        action: 'create',
        target_code: 'CODE-B9',
        rationale: '候选乙专属理由',
        evidence: [makeEvidence({
          record_id: 'MD-B9',
          field: 'name',
          candidate_value: '候选乙专属文本',
          matched_value: '候选乙专属文本',
        })],
      }),
      snapshot_version: 'snap-9',
      snapshot: [makeRecord({ record_id: 'MD-B9', code: 'CODE-B9', name: '候选乙专属文本' })],
      master_data_version: 'v1',
    })

    const serialized = JSON.stringify(projectSession(a, { now: () => NOW }))
    for (const foreign of ['MD-B9', 'C-B', 'CODE-B9', '候选乙专属']) {
      expect(serialized, `投影泄漏了其他候选内容：${foreign}`).not.toContain(foreign)
    }
    const viewA = projectSession(a, { now: () => NOW })
    expect(viewA.allowed_record_ids).toEqual(['MD-A1'])

    // 反向投影只看得见自己的内容，互不影响。
    const viewB = projectSession(b, { now: () => NOW })
    expect(viewB.conclusion.candidate_id).toBe('C-B')
    expect(viewB.conclusion.action).toBe('create')
    expect(viewB.evidence_chain[0].record_id).toBe('MD-B9')
  })

  it('投影按快照白名单过滤被污染的结论证据，越界 id 不进视图', () => {
    const store = createSessionStore({ now: () => NOW })
    const session = store.open({
      conclusion: makeConclusion({
        evidence: [
          makeEvidence(),
          makeEvidence({
            record_id: 'MD-OTHER',
            field: 'name',
            candidate_value: '他候选专属',
            matched_value: '他候选专属',
          }),
        ],
      }),
      snapshot_version: 'snap-1',
      snapshot: [makeRecord()],
      master_data_version: 'v1',
    })

    const view = projectSession(session, { now: () => NOW })
    expect(view.evidence_chain.map((e) => e.record_id)).toEqual(['MD-A1'])
    expect(view.dropped_evidence_count).toBe(1)
    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain('MD-OTHER')
    expect(serialized).not.toContain('他候选专属')
  })

  it('默认复用首轮快照版本：多轮追问不刷新，retrieve 未被调用', () => {
    const { store, session } = setup()
    const retrieve = vi.fn(() => ({
      snapshot_version: 'snap-2',
      records: [makeRecord({ version: 'v2' })],
    }))
    const deps = { masterDataVersionOf: () => 'v1', retrieve }

    const s1 = store.addTurn('C-A', {
      question: '为什么不并到另一条？',
      answer: '规格一致',
      referenced_record_ids: ['MD-A1'],
      evidence: [makeEvidence()],
      model_call_id: 'call-1',
    }, deps)
    const s2 = store.addTurn('C-A', {
      question: '第二个问题',
      answer: '医保码也一致',
      evidence: [makeEvidence()],
    }, deps)

    expect(s1.snapshot_version).toBe('snap-1')
    expect(s2.snapshot_version).toBe('snap-1')
    expect(s2.turns.map((t) => t.refreshed)).toEqual([false, false])
    expect(s2.turns.map((t) => t.snapshot_version)).toEqual(['snap-1', 'snap-1'])
    expect(retrieve).not.toHaveBeenCalled()
    // open / addTurn 返回的是快照，不改写外部已持有的会话引用。
    expect(session.turns).toHaveLength(0)
  })

  it('仅主数据版本变化才重新检索：refreshed=true 且更新快照版本与记录集', () => {
    const { store } = setup()
    const retrieve = vi.fn(() => ({
      snapshot_version: 'snap-2',
      records: [
        makeRecord({ version: 'v2' }),
        makeRecord({ record_id: 'MD-A2', code: 'CODE-A2', version: 'v2' }),
      ],
    }))
    const changed = { masterDataVersionOf: () => 'v2', retrieve }

    const s1 = store.addTurn('C-A', {
      question: '版本变了，还能并吗？',
      answer: '仍可并',
      evidence: [makeEvidence()],
    }, changed)
    expect(s1.snapshot_version).toBe('snap-2')
    expect(s1.master_data_version).toBe('v2')
    expect(s1.snapshot_records.map((r) => r.record_id)).toEqual(['MD-A1', 'MD-A2'])
    expect(s1.turns[0].refreshed).toBe(true)
    expect(s1.turns[0].snapshot_version).toBe('snap-2')
    expect(retrieve).toHaveBeenCalledTimes(1)
    expect(retrieve).toHaveBeenCalledWith('C-A', 'v2')

    // 版本稳定在 v2 后，后续追问继续复用新快照，不再触发重检。
    const s2 = store.addTurn('C-A', {
      question: '继续追问',
      answer: '依据新快照',
      evidence: [makeEvidence()],
    }, changed)
    expect(s2.turns[1].refreshed).toBe(false)
    expect(s2.turns[1].snapshot_version).toBe('snap-2')
    expect(retrieve).toHaveBeenCalledTimes(1)

    const view = projectSession(s2, { now: () => NOW })
    expect(view.snapshot_version).toBe('snap-2')
    expect(view.allowed_record_ids).toEqual(['MD-A1', 'MD-A2'])
  })

  it('追问轮可追溯：question / asked_action / model_call_id / at / snapshot_version', () => {
    const { store } = setup()
    const session = store.addTurn('C-A', {
      question: '为什么不并到 MD-A1？',
      answer: '因为规格一致',
      referenced_record_ids: ['MD-A1'],
      evidence: [makeEvidence()],
      model_call_id: 'call-42',
    }, { masterDataVersionOf: () => 'v1' })

    const turn = session.turns[0]
    expect(turn.question).toBe('为什么不并到 MD-A1？')
    expect(turn.asked_action).toBe('merge')
    expect(turn.model_call_id).toBe('call-42')
    expect(turn.at).toBe(NOW)
    expect(session.updated_at).toBe(NOW)
    expect(turn.snapshot_version).toBe('snap-1')
    expect(turn.refreshed).toBe(false)

    const view = projectSession(session, { now: () => NOW })
    expect(view.history).toHaveLength(1)
    expect(view.history[0].asked_action).toBe('merge')
    expect(view.history[0].model_call_id).toBe('call-42')
    expect(view.history[0].referenced_record_ids).toEqual(['MD-A1'])
  })

  it('会话严格按 candidate_id 归属；文本里的他候选 id 也被投影抹去', () => {
    const store = createSessionStore({ now: () => NOW })
    const a = store.open({
      conclusion: makeConclusion(),
      snapshot_version: 'snap-1',
      snapshot: [makeRecord()],
      master_data_version: 'v1',
    })
    store.open({
      conclusion: makeConclusion({
        candidate_id: 'C-B',
        evidence: [makeEvidence({ record_id: 'MD-B9' })],
      }),
      snapshot_version: 'snap-9',
      snapshot: [makeRecord({ record_id: 'MD-B9' })],
      master_data_version: 'v1',
    })
    expect(store.list().map((s) => s.candidate_id).sort()).toEqual(['C-A', 'C-B'])

    const polluted = store.addTurn('C-A', {
      question: '为什么不并到 MD-B9？C-B 那条呢？',
      answer: '普通回答',
      referenced_record_ids: ['MD-A1', 'MD-B9'],
      evidence: [makeEvidence()],
    }, { masterDataVersionOf: () => 'v1' })

    const viewA = projectSession(polluted, { now: () => NOW })
    const serialized = JSON.stringify(viewA)
    expect(serialized).not.toContain('MD-B9')
    expect(serialized).not.toContain('C-B')
    expect(viewA.history[0].question).toContain('[未检索记录]')
    expect(viewA.history[0].question).toContain('[其他候选]')
    expect(viewA.history[0].referenced_record_ids).toEqual(['MD-A1'])

    // 对 A 的追问完全不影响 B 的会话。
    expect(store.get('C-B')!.turns).toHaveLength(0)
    expect(() => store.addTurn('C-UNKNOWN', { question: 'x', answer: 'y' }))
      .toThrow(/追问会话不存在/)
  })
})
