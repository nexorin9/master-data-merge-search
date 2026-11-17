import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { decideByGate } from '@core/engine/gate-decision'
import type { CandidateRecord, MasterDataRecord } from '@core/types'

interface GateCase {
  name: string
  category: string
  candidate: CandidateRecord
  pool: MasterDataRecord[]
  expected: { gate: string; action: string; target_code?: string; reason?: string }
}

const fixturePath = resolve(process.cwd(), 'tests/fixtures/gate-cases.json')
const cases = (JSON.parse(readFileSync(fixturePath, 'utf8')) as { cases: GateCase[] }).cases

describe('唯一性闸门边界用例集（Task 24）', () => {
  it('用例条数 ≥12 且覆盖全部要求类别', () => {
    expect(cases.length).toBeGreaterThanOrEqual(12)
    const cats = new Set(cases.map((c) => c.category))
    for (const cat of [
      '医保码唯一命中', '医保码多义命中', '同名异规格', '换单位', '同义改名',
      '缺 spec', '缺 unit', '停用码命中', '停用+启用混合', 'version 冲突',
      '超长名称', '脏行（乱码）', '医保码格式异常', '无近似项', '域不匹配',
    ]) {
      expect(cats.has(cat), `用例集缺少类别：${cat}`).toBe(true)
    }
  })

  it.each(cases)('$name → gate=$expected.gate action=$expected.action', (tc) => {
    const { gate, conclusion } = decideByGate(tc.candidate, tc.pool, {
      dirty: (tc.candidate as unknown as { _dirty?: boolean })._dirty,
    })
    expect(gate).toBe(tc.expected.gate)
    expect(conclusion.action).toBe(tc.expected.action)
    if (tc.expected.target_code) expect(conclusion.target_code).toBe(tc.expected.target_code)
    if (tc.expected.reason) expect(conclusion.uncertain_reason).toBe(tc.expected.reason)
    // 每条结论必须给 evidence（merge 至少 1 条带 record_id）。
    if (tc.expected.action === 'merge') {
      expect(conclusion.evidence.length).toBeGreaterThanOrEqual(1)
      expect(conclusion.evidence[0].record_id).toBeTruthy()
    }
  })

  it('用例集可被基准对拍复用：每条都有候选与期望', () => {
    for (const c of cases) {
      expect(c.candidate.candidate_id).toBeTruthy()
      expect(c.expected.action).toMatch(/^(create|merge|uncertain)$/)
    }
  })
})
