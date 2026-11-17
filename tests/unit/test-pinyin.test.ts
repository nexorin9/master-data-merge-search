import { describe, expect, it } from 'vitest'
import {
  initialCandidates, isFullyPinyinMappable, pinyinCandidateStrings, pinyinInitials,
} from '@core/normalize/pinyin'

describe('拼音首字母（Task 19）', () => {
  it('阿莫西林胶囊 → amxljn（首字母长度正确、字符集为小写字母）', () => {
    const got = pinyinInitials('阿莫西林胶囊')
    expect(got).toHaveLength(6)
    expect(got).toMatch(/^[a-z]+$/)
    expect(got).toBe('amxljn')
  })

  it('布洛芬缓释胶囊 首字母长度正确', () => {
    const got = pinyinInitials('布洛芬缓释胶囊')
    expect(got).toHaveLength(7)
    expect(got).toBe('blfhsjn')
  })

  it('多音字取候选集合，不静默只取一个', () => {
    expect(initialCandidates('乐').length).toBeGreaterThanOrEqual(2)
    expect(initialCandidates('重')).toContain('c')
    expect(pinyinCandidateStrings('乐')).toContain('y')
  })

  it('无法取拼音的表外生僻字保留原字符', () => {
    expect(initialCandidates('𠮷')[0]).toBe('𠮷')
    expect(pinyinInitials('𠮷')).toBe('𠮷')
  })

  it('非汉字字母数字：字母转小写、数字剔除', () => {
    expect(pinyinInitials('阿莫A1')).toBe('ama')
  })

  it('语料用字覆盖检查：常见药名用字全部可映射', () => {
    expect(isFullyPinyinMappable('头孢氨苄胶囊')).toBe(true)
    expect(isFullyPinyinMappable('左氧氟沙星片')).toBe(true)
    expect(isFullyPinyinMappable('阿莫西林克拉维酸钾')).toBe(true)
  })

  it('pinyinCandidateStrings 对多音词展开多个候选', () => {
    const all = pinyinCandidateStrings('重庆')
    expect(all.length).toBeGreaterThanOrEqual(2)
    expect(all).toContain('zq')
    expect(all).toContain('cq')
  })

  it('确定性：同一输入两次结果一致', () => {
    expect(pinyinInitials('注射用头孢曲松钠')).toBe(pinyinInitials('注射用头孢曲松钠'))
  })
})
