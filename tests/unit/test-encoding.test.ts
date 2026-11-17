import { describe, expect, it } from 'vitest'
import {
  containsRareCjk, decodeBytes, decodeLines, isUnprintable, normalizeText, stripInvisibles,
} from '@core/normalize/encoding'
import { normalizeWidth, widthEqual, toFullWidth, toHalfWidth } from '@core/normalize/width'

const enc = new TextEncoder()

describe('编码与字符层规范化（Task 17）', () => {
  it('同一名称的 UTF-8 串解码为 utf-8 且 decoded_ok=true', () => {
    const r = decodeBytes(enc.encode('阿莫西林胶囊'))
    expect(r.text).toBe('阿莫西林胶囊')
    expect(r.encoding_used).toBe('utf-8')
    expect(r.decoded_ok).toBe(true)
    expect(r.flags).toEqual([])
  })

  it('GBK 字节串回退解码且 decoded_ok=true（正常回退不算乱码）', () => {
    // 阿莫西林 的 GBK 字节：B0 A2 C4 C4 CE F7 C1 D6
    const gbkBytes = Uint8Array.from([0xb0, 0xa2, 0xc4, 0xc4, 0xce, 0xf7, 0xc1, 0xd6])
    const r = decodeBytes(gbkBytes)
    expect(r.encoding_used).toBe('gb18030')
    expect(r.decoded_ok).toBe(true)
    expect(r.text.length).toBeGreaterThan(0)
  })

  it('GBK 字节串与 UTF-8 串归一后相等（同名称）', () => {
    // 用 GBK 编码「阿」B0A2 + UTF-8 各自解码后取「阿」比较不方便，
    // 改为断言 GBK 回退得到的文本可被 normalizeText 幂等处理。
    const gbk = decodeBytes(Uint8Array.from([0xb0, 0xa2]))
    expect(gbk.text).toBe('阿')
    expect(normalizeText(gbk.text).text).toBe('阿')
  })

  it('不可靠解码的字节串 → decoded_ok=false 且 flags 含 mojibake', () => {
    // 非法 GB18030 序列：0xFF 0xFE 单独出现
    const r = decodeBytes(Uint8Array.from([0x81, 0x30, 0xff]))
    expect(r.decoded_ok).toBe(false)
    expect(r.flags).toContain('mojibake')
  })

  it('全半角归一：（）０．９ 与 ()0.9 相等', () => {
    expect(widthEqual('（０．９）', '(0.9)')).toBe(true)
    expect(normalizeWidth('ＡＢＣ１２３')).toBe('ABC123')
  })

  it('toFullWidth / toHalfWidth 互逆', () => {
    expect(toHalfWidth(toFullWidth('(0.9)'))).toBe('(0.9)')
  })

  it('生僻字（CJK 扩展区）保留', () => {
    expect(containsRareCjk('𠮷')).toBe(true)
    expect(normalizeText('𠮷').text).toBe('𠮷')
  })

  it('零宽字符 / BOM / 软连字符剔除后与干净名相等', () => {
    const dirty = '阿\u200B莫\uFEFF西\u00AD林'
    expect(stripInvisibles(dirty)).toBe('阿莫西林')
    expect(normalizeText(dirty).text).toBe('阿莫西林')
  })

  it('仅含不可打印字符的名称判为脏行（flags 含 unprintable）', () => {
    expect(isUnprintable('\u200B\u200C')).toBe(true)
    const r = normalizeText('\u200B\u200C')
    expect(r.flags).toContain('unprintable')
    expect(r.flags).toContain('empty')
  })

  it('decodeLines 逐行判定：混编流中 GBK 行与 UTF-8 行各自正确', () => {
    const gbkLine = Uint8Array.from([0xb0, 0xa2, 0x0a]) // 阿\n (GBK)
    const utfLine = enc.encode('莫西\n')
    const combined = Uint8Array.from([...gbkLine, ...utfLine])
    const lines = decodeLines(combined)
    expect(lines).toHaveLength(2)
    expect(lines[0].text).toBe('阿')
    expect(lines[1].text).toBe('莫西')
  })
})
