import { describe, expect, it, vi } from 'vitest'
import {
  createGuardedSink,
  emptyHitTypeCounts,
  enforcePiiBeforeWrite,
  guardedWorkspaceWrite,
  maskText,
  scanBatch,
  scanRow,
  type PersistState,
} from '@core/audit/pii-guard'
import type { PiiHitType } from '@core/types'

const ID18 = '110101199003072316'
const ID18_X = '11010119900307231X'
const ID15 = '110101900307231'
const PHONE = '13800138000'

function expectHit(row: Record<string, unknown>, type: PiiHitType): void {
  const verdict = scanRow(row)
  expect(verdict.ok, `应命中 ${type}`).toBe(false)
  if (!verdict.ok) {
    expect(verdict.rejected_by).toBe('pii_guard')
    expect(verdict.hits.some((h) => h.type === type)).toBe(true)
    for (const hit of verdict.hits) {
      expect(hit.field).toBeTruthy()
      expect(hit.value_preview).toBeTruthy()
    }
  }
}

describe('隐私形状闸门（Task 38）', () => {
  it('18 位身份证形态（含 X 结尾）被拒且绝不落盘', () => {
    expectHit({ id_no: ID18 }, 'id_card')
    expectHit({ id_no: ID18_X }, 'id_card')
    const write = vi.fn()
    const result = enforcePiiBeforeWrite([{ code: 'XP000123' }, { id_no: ID18 }], write)
    expect(result.ok).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('15 位旧版身份证形态被拒', () => {
    expectHit({ legacy_id: ID15 }, 'id_card')
  })

  it('11 位手机号（1[3-9] 开头）命中 phone，嵌入中文文本同样识别', () => {
    expectHit({ phone: PHONE }, 'phone')
    expectHit({ note: `联系电话${PHONE}转接` }, 'phone')
    // 非 1[3-9] 开头、位数不足或夹在编码内部不得命中。
    expect(scanRow({ phone: '12800138000' }).ok).toBe(true)
    expect(scanRow({ phone: '1380013800' }).ok).toBe(true)
    expect(scanRow({ code: `XJ${PHONE}` }).ok).toBe(true)
  })

  it('姓名/患者字段配上非纯代码值命中 name_field，纯编码值放行', () => {
    expectHit({ 姓名: '张三' }, 'name_field')
    expectHit({ 患者姓名: '李四' }, 'name_field')
    expectHit({ 病人: '王五' }, 'name_field')
    expectHit({ 联系人: '赵六' }, 'name_field')
    expect(scanRow({ 姓名: 'XP000123' }).ok).toBe(true)
    // 裸 name 字段（药品名入库列）不得误报。
    expect(scanRow({ name: '阿莫西林胶囊' }).ok).toBe(true)
  })

  it('患者号形态值与住院号字段命中 patient_id', () => {
    expectHit({ ref: 'HZ20240001' }, 'patient_id')
    expectHit({ ref: 'MRN-12345678' }, 'patient_id')
    expectHit({ 住院号: '张' }, 'patient_id')
    // 纯编码形态的住院号不误报。
    expect(scanRow({ 住院号: 'XP000123' }).ok).toBe(true)
  })

  it('常见药品编码/名称/规格/剂型/单位零误报', () => {
    const samples = [
      'XP000123', 'XJ7000000000001', 'YP009988', 'H10950001', 'H20040321',
      '国药准字H10950233', '0.25g*12片', '250mg*24粒', '5mg', '10ml:0.1g',
      '阿莫西林胶囊', '注射用头孢曲松钠', '维生素C片', '片剂', '硬胶囊',
      '颗粒剂', '盒', '支', '瓶', '袋',
    ]
    for (const sample of samples) {
      for (const field of ['code', 'name', 'spec', 'dosage_form', 'unit', 'insurance_code']) {
        const verdict = scanRow({ [field]: sample })
        expect(verdict.ok, `误报：${field}=${sample}`).toBe(true)
      }
    }
  })

  it('value_preview 只保留掩码，绝不回显完整证件号 / 手机号', () => {
    const verdict = scanRow({ id_no: ID18, phone: PHONE, 姓名: '张三' })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      for (const hit of verdict.hits) {
        expect(hit.value_preview).toContain('*')
        expect(hit.value_preview).not.toBe(ID18)
        expect(hit.value_preview).not.toBe(PHONE)
        expect(hit.value_preview.length).toBeLessThanOrEqual(12)
      }
      const idHit = verdict.hits.find((h) => h.type === 'id_card')!
      const phoneHit = verdict.hits.find((h) => h.type === 'phone')!
      expect(idHit.value_preview).toMatch(/^\d{2}\*{6}\d{2}$/)
      expect(phoneHit.value_preview).toMatch(/^\d{2}\*{6}\d{2}$/)
    }
    expect(maskText(ID18)).not.toContain(ID18)
  })

  it('scanBatch 的 rejected_count / hit_type_counts 精确，单行被拒不阻断其余行', () => {
    const rows: Array<Record<string, unknown>> = [
      { code: 'XP000123' },              // 0 干净
      { id_no: ID18 },                   // 1 id_card
      { contact: PHONE },                // 2 phone
      { 姓名: '张三' },                  // 3 name_field
      { code: 'XJ7000000000001' },       // 4 干净
      { ref: 'HZ20240001' },             // 5 patient_id
      { legacy_id: ID15 },               // 6 id_card
    ]
    const batch = scanBatch(rows)
    expect(batch.accepted).toEqual([0, 4])
    expect(batch.acceptedRows).toHaveLength(2)
    expect(batch.rejected_count).toBe(5)
    expect(batch.rejected.map((r) => r.index)).toEqual([1, 2, 3, 5, 6])
    expect(batch.hit_type_counts).toEqual({
      id_card: 2, phone: 1, name_field: 1, patient_id: 1,
    })
    for (const rejected of batch.rejected) {
      expect(rejected.verdict.ok).toBe(false)
      if (!rejected.verdict.ok) {
        expect(rejected.verdict.rejected_by).toBe('pii_guard')
        expect(rejected.verdict.hits[0]!.type).toBeTruthy()
        expect(rejected.verdict.hits[0]!.field).toBeTruthy()
      }
    }

    // 被拒行不进入工作区，干净行照常写入：单条脏数据不阻断整批后续。
    const write = vi.fn()
    const gate = enforcePiiBeforeWrite(batch.acceptedRows, write)
    expect(gate.ok).toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]![0]).toHaveLength(2)
  })

  it('绕过路径被工作区落盘层拦下：guarded sink 与 workspace 包装器均拒绝直写', () => {
    const sink = vi.fn()
    const guarded = createGuardedSink(sink)
    const direct = guarded([{ id: 'C-1', 姓名: '张三' }])
    expect(direct.ok).toBe(false)
    expect(sink).not.toHaveBeenCalled()

    const write = vi.fn()
    const workspace = { write }
    const dirtyState: PersistState = {
      audit_chain: [],
      suggestions: { 'S-1': { code: 'XP000123' }, 'S-2': { 姓名: '张三' } },
    }
    const blocked = guardedWorkspaceWrite(workspace, dirtyState)
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) {
      expect(blocked.rejected_by).toBe('pii_guard')
      expect(blocked.rejected[0]!.verdict.hits.some((h) => h.type === 'name_field')).toBe(true)
    }
    expect(write).not.toHaveBeenCalled()

    // 干净 state 才允许落盘。
    const cleanState: PersistState = {
      audit_chain: [{ seq: 1, candidate_id: 'C-1', target_code: 'XJ7000000000001' }],
      suggestions: { 'S-1': { code: 'XP000123' } },
    }
    expect(guardedWorkspaceWrite(workspace, cleanState).ok).toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('空批次与空计数表行为稳定，纯数字短编码不误报', () => {
    expect(scanBatch([])).toEqual({
      accepted: [], acceptedRows: [], rejected: [], rejected_count: 0,
      hit_type_counts: emptyHitTypeCounts(),
    })
    for (const code of ['1', '12', '123', '1234', '12345', '0', '000123']) {
      expect(scanRow({ code }).ok, `短编码误报：${code}`).toBe(true)
    }
    expect(emptyHitTypeCounts()).toEqual({
      id_card: 0, phone: 0, name_field: 0, patient_id: 0,
    })
  })
})
