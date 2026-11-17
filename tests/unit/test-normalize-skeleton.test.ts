/**
 * 字段映射与规范化五模块骨架单测（Task 5 验收文件）。
 *
 * 覆盖 step 3 三项断言：映射表缺字段 → 抛错并指出缺失字段名；映射文件缺失 →
 * 明确错误；normalize 各模块入口可调用并返回最小结果。等价性 / 脏数据 / 边界
 * 的深入用例由 test-encoding / test-spec / test-pinyin / test-field-map 承担，
 * 本文件只守「骨架入口在真实语料上可调用且返回约定形状」这一层。
 */
import { describe, expect, it } from 'vitest'
import {
  assertMapCovers,
  FieldMapError,
  loadFieldMap,
  loadValidatedFieldMap,
  REQUIRED_CANDIDATE_FIELDS,
} from '@core/retrieval/field-map'
import { normalizeText, decodeBytes, containsRareCjk } from '@core/normalize/encoding'
import { normalizeWidth, widthEqual, toFullWidth, toHalfWidth } from '@core/normalize/width'
import {
  isUnitMismatch,
  loadUnitAliasTable,
  lookupUnit,
  normalizeUnit,
  unitsConvertible,
} from '@core/normalize/unit'
import { equivalentSpec, parseSpec } from '@core/normalize/spec'
import { initialCandidates, pinyinInitials, pinyinCandidateStrings } from '@core/normalize/pinyin'

describe('Task 5 字段映射表骨架', () => {
  it('默认映射表可载入并覆盖候选必需字段', () => {
    const map = loadValidatedFieldMap()
    expect(map['药品名称']).toBe('name')
    assertMapCovers(map, REQUIRED_CANDIDATE_FIELDS)
  })

  it('映射表缺字段 → 抛 FieldMapError 并逐项指出缺失的内部字段名', () => {
    try {
      assertMapCovers({ 通用名: 'name' }, REQUIRED_CANDIDATE_FIELDS)
      throw new Error('应当抛错')
    } catch (err) {
      expect(err).toBeInstanceOf(FieldMapError)
      const e = err as FieldMapError
      expect(e.missingFields).toContain('candidate_id')
      expect(e.missingFields).toContain('domain')
      expect(e.message).toContain('candidate_id')
    }
  })

  it('映射文件缺失 → 明确错误（不是静默默认映射兜底）', () => {
    expect(() => loadFieldMap('/nonexistent/nope.json')).toThrow(FieldMapError)
    expect(() => loadFieldMap('/nonexistent/nope.json')).toThrow(/不存在/)
  })
})

describe('Task 5 规范化五模块骨架入口', () => {
  it('encoding：normalizeText / decodeBytes 返回三态形状，UTF-8 优先', () => {
    const normalized = normalizeText('阿莫西林')
    expect(normalized).toMatchObject({ text: '阿莫西林', encoding_used: 'utf-8', decoded_ok: true })
    expect(normalized.flags).toEqual([])
    const bytes = new TextEncoder().encode('阿莫西林胶囊')
    const decoded = decodeBytes(bytes)
    expect(decoded.decoded_ok).toBe(true)
    expect(decoded.encoding_used).toBe('utf-8')
    expect(decoded.text).toBe('阿莫西林胶囊')
  })

  it('encoding：生僻字保留、不可打印行被标记（入口可调用）', () => {
    expect(containsRareCjk('㗊')).toBe(true)
    expect(containsRareCjk('普通')).toBe(false)
    expect(normalizeText('\u200B\u200B').flags).toContain('unprintable')
  })

  it('width：全半角归一入口可调用，归一后等价', () => {
    expect(toHalfWidth('（０．９）')).toBe('(0.9)')
    expect(toFullWidth('(0.9)')).toBe('（０．９）')
    expect(normalizeWidth('０．９')).toBe('0.9')
    expect(widthEqual('（ ）０．９', '( )0.9')).toBe(true)
  })

  it('unit：别名表可读取、查表归一与同类换算入口可调用', () => {
    const table = loadUnitAliasTable()
    expect(Object.keys(table)).toContain('mass')
    expect(lookupUnit('毫克', table)).toMatchObject({ unit: 'mg', dimension: 'mass', known: true })
    expect(normalizeUnit(0.25, 'g', table)).toMatchObject({ value: 0.25, unit: 'g', dimension: 'mass' })
    expect(unitsConvertible('mg', 'g', table)).toBe(true)
    // 跨维度不换算（把「支」当「片」的防线）。
    expect(isUnitMismatch('支', '片', table)).toBe(true)
  })

  it('spec：parseSpec 返回结构化形状，等价判定与拒收入口可调用', () => {
    const parsed = parseSpec('0.25g*12片')
    expect(parsed).toMatchObject({
      original: '0.25g*12片', strength: 0.25, strength_unit: 'g',
      pack_count: 12, pack_unit: '片', parse_ok: true,
    })
    expect(equivalentSpec('0.25g*12片', '250mg*12片')).toBe(true)
    const bad = parseSpec('乱写规格')
    expect(bad.parse_ok).toBe(false)
    expect(bad.flags).toContain('parse_error')
  })

  it('pinyin：首字母取词、多音候选与候选串入口可调用', () => {
    const initials = pinyinInitials('阿莫西林胶囊')
    expect(initials).toHaveLength('阿莫西林胶囊'.length)
    expect(initials).toMatch(/^[a-z]+$/)
    // 多音字「阿」保留候选集合，不静默只取一个。
    expect(initialCandidates('阿').length).toBeGreaterThan(1)
    expect(pinyinCandidateStrings('阿莫').length).toBeGreaterThanOrEqual(1)
  })
})
