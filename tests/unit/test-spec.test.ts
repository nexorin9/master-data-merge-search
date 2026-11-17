import { beforeEach, describe, expect, it } from 'vitest'
import {
  equivalentSpec, normalizedSpecKey, parseSpec, resetUnitAliasCache,
} from '@core/normalize/spec'
import {
  convertUnit, isUnitMismatch, lookupUnit, normalizeUnit, unitsConvertible,
} from '@core/normalize/unit'

describe('单位与规格解析（Task 18）', () => {
  beforeEach(() => resetUnitAliasCache())

  it('三种写法归一后等价：* / × / 空格 / 克', () => {
    expect(equivalentSpec('0.25g*12片', '0.25g×12片')).toBe(true)
    expect(equivalentSpec('0.25g*12片', '0.25 克 12 片')).toBe(true)
    expect(equivalentSpec('0.25g*12片', '0.25g/12片')).toBe(true)
  })

  it('含量不同必须不等：0.25g vs 0.5g', () => {
    expect(equivalentSpec('0.25g*12片', '0.5g*12片')).toBe(false)
  })

  it('跨单位同类换算：250mg*12片 ≡ 0.25g*12片', () => {
    expect(equivalentSpec('250mg*12片', '0.25g*12片')).toBe(true)
    expect(normalizedSpecKey('250mg*12片').key).toBe(normalizedSpecKey('0.25g*12片').key)
  })

  it('包装计数不同不等价', () => {
    expect(equivalentSpec('0.25g*12片', '0.25g*24片')).toBe(false)
  })

  it('单位别名归一：毫克→mg、微克→μg', () => {
    expect(lookupUnit('毫克').unit).toBe('mg')
    expect(lookupUnit('μ g').unit).toBe('μg')
    expect(lookupUnit('Ｇ').unit).toBe('g') // 全角
  })

  it('跨维度不换算并标记 unit_mismatch', () => {
    expect(unitsConvertible('mg', '片')).toBe(false)
    expect(unitsConvertible('mg', 'g')).toBe(true)
    expect(convertUnit(250, 'mg', 'g')).toBeCloseTo(0.25)
    expect(convertUnit(1, '支', '片')).toBeNull()
    expect(isUnitMismatch('支', '片')).toBe(true)
  })

  it('非法规格被拒收且 flags 含 parse_error', () => {
    const p = parseSpec('适量')
    expect(p.parse_ok).toBe(false)
    expect(p.flags).toContain('parse_error')
    expect(equivalentSpec('适量', '0.25g*12片')).toBe(false)
  })

  it('pack_count 非正整数的规格被拒收', () => {
    expect(parseSpec('0.25g*0片').parse_ok).toBe(false)
    expect(parseSpec('0.25g*abc片').parse_ok).toBe(false)
    expect(parseSpec('0.25g*12.5片').parse_ok).toBe(false)
  })

  it('结构化解析字段齐全', () => {
    const p = parseSpec('0.25g*12片')
    expect(p.parse_ok).toBe(true)
    expect(p.strength).toBe(0.25)
    expect(p.strength_unit).toBe('g')
    expect(p.pack_count).toBe(12)
    expect(p.pack_unit).toBe('片')
  })

  it('normalizeUnit 缺单位时标 unit_unknown，数值解析失败标 parse_error', () => {
    const r = normalizeUnit('abc', 'mg')
    expect(r.value).toBeNull()
    expect(r.flags).toContain('parse_error')
    const r2 = normalizeUnit('5', 'foo')
    expect(r2.flags).toContain('unit_unknown')
  })

  it('体积规格：100ml*1瓶 自等价', () => {
    expect(equivalentSpec('100ml*1瓶', '100 毫升 1 瓶')).toBe(true)
    expect(equivalentSpec('100ml*1瓶', '200ml*1瓶')).toBe(false)
  })
})
