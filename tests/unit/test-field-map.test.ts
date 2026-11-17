import { describe, expect, it } from 'vitest'
import {
  applyFieldMap, assertMapCovers, FieldMapError, loadFieldMap, loadValidatedFieldMap, mapField,
  resolveMapPath,
} from '@core/retrieval/field-map'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('字段映射表（Task 5）', () => {
  it('默认映射文件可载入且覆盖候选与主数据必需字段', () => {
    const map = loadValidatedFieldMap()
    expect(mapField('药品名称', map)).toBe('name')
    expect(mapField('医保编码', map)).toBe('insurance_code')
    expect(mapField('不存在的列', map)).toBeNull()
  })

  it('映射表缺字段 → 抛 FieldMapError 并指出缺失字段名', () => {
    const map = { 药品名称: 'name' }
    try {
      assertMapCovers(map, ['candidate_id', 'domain', 'name'], '测试')
      throw new Error('应当抛错')
    } catch (err) {
      expect(err).toBeInstanceOf(FieldMapError)
      const e = err as FieldMapError
      expect(e.missingFields).toContain('candidate_id')
      expect(e.missingFields).toContain('domain')
      expect(e.message).toContain('candidate_id')
    }
  })

  it('映射文件缺失 → 明确错误', () => {
    expect(() => loadFieldMap('/nonexistent/nope.json')).toThrow(/不存在/)
    expect(() => loadFieldMap('/nonexistent/nope.json')).toThrow(FieldMapError)
  })

  it('映射文件非法 JSON → 明确错误', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fm-'))
    const p = join(dir, 'bad.json')
    writeFileSync(p, '{not json')
    expect(() => loadFieldMap(p)).toThrow(/合法 JSON/)
  })

  it('applyFieldMap 把院内列名转为内部字段', () => {
    const map = loadValidatedFieldMap()
    const out = applyFieldMap(
      { 候选编号: 'C-1', 业务域: 'drug', 通用名: '阿莫西林', 规格: '0.25g*12片', 医保编码: 'XJ1' },
      map,
    )
    expect(out).toMatchObject({
      candidate_id: 'C-1', domain: 'drug', name: '阿莫西林', spec: '0.25g*12片', insurance_code: 'XJ1',
    })
  })

  it('applyFieldMap 记录缺必需字段 → 报错列名', () => {
    const map = loadValidatedFieldMap()
    expect(() => applyFieldMap({ 通用名: '阿莫西林' }, map)).toThrow(FieldMapError)
  })

  it('resolveMapPath 默认路径指向 config/mdm-field-map.json', () => {
    const p = resolveMapPath(undefined, process.cwd())
    expect(p).toMatch(/config\/mdm-field-map\.json$/)
  })
})
