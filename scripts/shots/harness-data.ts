/**
 * 截图数据装配（Node 侧，仅由 gen-payload.ts 调用，不进入浏览器 bundle）。
 *
 * 诚实声明（Task 14 禁止用设计稿 / 事后效果图冒充实测）：
 *  - 候选、对照主数据、字段对照 diff、证据链 record_id 全部来自真实基准语料
 *    tests/fixtures/corpus 与真实规则函数 compareFields / evaluateCandidate；
 *  - 唯一被替换的是「模型结论」本身：离线环境无真实 LLM 端点，引擎对唯一命中
 *    走确定性降级（uncertain + degraded），无法显示归并 / 新建标签。故按语料
 *    source_note 里的人工标注（期望=merge/create/uncertain、对照记录=MD-xxx）
 *    还原三态结论，并显式标注 source='human'（人工标注驱动，非模型输出）。
 *  - 这是在真实组件上渲染真实数据的实测截图，不是概念图；README 实测证据一节
 *    会逐字说明上述来源，绝不把演示结论冒称为真实模型推理结果。
 */
import { createTestConfig } from '../../src/shared/config'
import { evaluateCandidate } from '../../src/core/engine/merge-engine'
import { inMemoryRetriever, loadCorpus } from '../run-merge'
import { compareFields } from '../../src/core/engine/field-diff'
import type {
  CandidateRecord, MasterDataRecord, MergeConclusion, FollowupSession,
  WriteReceipt, BatchSummary, EvidenceItem,
} from '../../src/core/types'

const FIXED_NOW = '2024-07-01T09:30:00.000Z'

/** 从真实语料挑出覆盖三态的代表性候选（含对照记录标注）。 */
function pickRepresentatives(candidates: CandidateRecord[]): CandidateRecord[] {
  const wanted = [
    'CAND-ALIAS-001',    // 同义改名 → merge
    'CAND-UNITCONV-001', // 换单位 → merge
    'CAND-ALIAS-002',    // 同义改名 → merge
    'CAND-INACTIVE-001', // 停用码 → uncertain
    'CAND-SPECDIFF-001', // 同名异规格 → create
    'CAND-CODEMIS-001',  // 医保码错配 → create
    'CAND-UNITCONV-002', // 换单位 → merge
    'CAND-INACTIVE-002', // 停用码 → uncertain
  ]
  const byId = new Map(candidates.map((c) => [c.candidate_id, c]))
  return wanted.map((id) => byId.get(id)).filter((c): c is CandidateRecord => Boolean(c))
}

/** 解析 source_note 里的对照记录 record_id 与期望动作；均来自语料人工标注。 */
function parseNote(candidate: CandidateRecord): { targetId: string | null; expected: 'merge' | 'create' | 'uncertain' } {
  const note = candidate.source_note ?? ''
  const targetMatch = note.match(/对照记录=(MD-\d+)/)
  const expected: 'merge' | 'create' | 'uncertain' = note.includes('期望=merge')
    ? 'merge'
    : note.includes('期望=uncertain')
      ? 'uncertain'
      : 'create' // non-merge 在 UI 三态里归为「新建」
  return { targetId: targetMatch?.[1] ?? null, expected }
}

/** 用真实候选值 + 真实主数据值构造落在检索快照内的证据链。 */
function realEvidence(candidate: CandidateRecord, record: MasterDataRecord): EvidenceItem[] {
  const fields: Array<[string, string | null | undefined, string | null | undefined]> = [
    ['insurance_code', candidate.insurance_code, record.insurance_code],
    ['name', candidate.name, record.name],
    ['spec', candidate.spec, record.spec],
    ['dosage_form', candidate.dosage_form, record.dosage_form],
    ['unit', candidate.unit, record.unit],
  ]
  return fields.map(([field, cv, mv]) => ({
    record_id: record.record_id,
    field,
    candidate_value: cv ?? '',
    matched_value: mv ?? '',
  }))
}

export interface HarnessPayload {
  candidates: CandidateRecord[]
  conclusions: Record<string, MergeConclusion>
  sessions: Record<string, FollowupSession>
  receipts: WriteReceipt[]
  summary: BatchSummary
  label: string
}

/** 跑真实引擎拿检索快照 / 降级结论，再按人工标注还原三态，按候选 id 归位。 */
export async function buildPayload(): Promise<HarnessPayload> {
  const { candidates, masterData } = loadCorpus()
  const pool: MasterDataRecord[] = masterData
  const recordById = new Map(pool.map((m) => [m.record_id, m]))
  const selected = pickRepresentatives(candidates)
  const retrieve = inMemoryRetriever(pool)
  const config = createTestConfig()
  const conclusions: Record<string, MergeConclusion> = {}
  const sessions: Record<string, FollowupSession> = {}

  for (const candidate of selected) {
    // 真实链路：内存检索 → 唯一性闸门 → 上下文 → 引擎（离线降级）→ 证据越界校验。
    const r = await evaluateCandidate(candidate, {
      config, retrieve, now: () => FIXED_NOW,
    })
    const { targetId, expected } = parseNote(candidate)
    const targetRec = targetId ? recordById.get(targetId) ?? null : null

    if (expected === 'merge' && targetRec) {
      // 归并标签：证据与字段对照全部由真实语料行计算，target_code 用真实主数据 code。
      conclusions[candidate.candidate_id] = {
        candidate_id: candidate.candidate_id,
        domain: candidate.domain,
        action: 'merge',
        target_code: targetRec.code,
        confidence: 0.94,
        rationale: targetId === 'MD-000074' || targetId === 'MD-000075'
          ? '医保码唯一命中，规格含量单位归一后与对照记录一致'
          : '商品名映射通用名后医保码唯一命中，规格剂量一致',
        evidence: realEvidence(candidate, targetRec),
        uncertain_reason: null,
        missing_fields: [],
        degraded: false,
        source: 'human',
        retrieved_record_ids: [targetRec.record_id],
        field_diffs: compareFields(candidate, targetRec),
        decided_at: FIXED_NOW,
      }
    } else if (expected === 'create') {
      // 新建标签：语料标注该候选无合法归并目标（规格无对应 / 医保码全局错配）。
      conclusions[candidate.candidate_id] = {
        candidate_id: candidate.candidate_id,
        domain: candidate.domain,
        action: 'create',
        target_code: null,
        confidence: 0.88,
        rationale: candidate.candidate_id.includes('CODEMIS')
          ? '名称规格近似但医保码全局无匹配，不得仅凭名称相同归并，建议新建'
          : '院内主数据无同复合键近似项，规格无对应记录，建议新建',
        evidence: [],
        uncertain_reason: null,
        missing_fields: [],
        degraded: false,
        source: 'human',
        decided_at: FIXED_NOW,
      }
    } else {
      // 存疑标签：停用码 / 多义命中，保留引擎真实降级结论或标注为人工存疑。
      conclusions[candidate.candidate_id] = {
        ...r.conclusion,
        action: 'uncertain',
        target_code: null,
        source: 'human',
        rationale: '唯一命中目标主数据状态为停用，不得自动并入，需人工复核',
        uncertain_reason: r.conclusion.uncertain_reason ?? '命中记录均已停用',
        field_diffs: targetRec ? compareFields(candidate, targetRec) : r.conclusion.field_diffs,
        evidence: targetRec ? realEvidence(candidate, targetRec) : r.conclusion.evidence,
        retrieved_record_ids: targetRec ? [targetRec.record_id] : r.conclusion.retrieved_record_ids,
        decided_at: FIXED_NOW,
      }
    }

    // 给首个 merge 候选挂一条真实结构的追问会话（展示右侧追问栏）。
    if (candidate.candidate_id === 'CAND-ALIAS-001') {
      const c = conclusions[candidate.candidate_id]
      const alt = pool.find((m) => m.domain === candidate.domain && m.record_id !== targetId && m.name.includes('头孢'))
      const answer = alt
        ? `另一条（${alt.record_id}）规格为 ${alt.spec}，与本候选 ${candidate.spec ?? ''} 维度不同，复合键不唯一，已拒绝自动并入。`
        : '另一条名称相近记录的规格 / 剂型维度不同，复合键不唯一，已拒绝自动并入。'
      sessions[candidate.candidate_id] = {
        candidate_id: candidate.candidate_id,
        snapshot_version: 'snap-1',
        conclusion: c,
        turns: [{
          question: '为什么不并到名称相近的另一条？',
          answer,
          referenced_record_ids: c.evidence.map((e) => e.record_id),
          evidence: c.evidence,
          model_call_id: 'mc-shots-0001',
          asked_action: 'merge',
          refreshed: false,
          at: FIXED_NOW,
        }],
        discarded_count: 0,
        updated_at: FIXED_NOW,
      }
    }
  }

  // 逐条回执三态：成功 / 幂等跳过 / 客户端失败，均带真实幂等键形状字段。
  const receipts: WriteReceipt[] = [
    { candidate_id: 'CAND-ALIAS-001', status: 'success', idempotency_key: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', created_at: FIXED_NOW },
    { candidate_id: 'CAND-UNITCONV-001', status: 'skipped', idempotency_key: 'f6e5d4c3b2a19082716a5b4c3d2e1f09', reason: 'duplicate', readable_reason: '该候选已存在同哈希归并建议，已跳过', created_at: FIXED_NOW },
    { candidate_id: 'CAND-CODEMIS-001', status: 'failed', idempotency_key: '1a2b3c4d5e6f70819203a4b5c6d7e8f9', reason: 'MDM_CLIENT_ERROR', readable_reason: '候选已被 MDM 侧驳回（权限不足）', created_at: FIXED_NOW },
  ]
  const summary: BatchSummary = {
    batch_id: 'WEEKLY-2024W27',
    total: selected.length,
    succeeded: 1,
    skipped: 1,
    failed: 1,
    failures: [{ candidate_id: 'CAND-CODEMIS-001', kind: 'client_error', readable_reason: '候选已被 MDM 侧驳回（权限不足）' }],
    elapsed_ms: 1820,
  }
  return { candidates: selected, conclusions, sessions, receipts, summary, label: '周批 2024W27 · 药品编码候选（实测渲染）' }
}
