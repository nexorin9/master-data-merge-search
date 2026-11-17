/**
 * 编码与字符层规范化（Task 17）。
 *
 * 真实院内导出表常见 GBK/UTF-8 混编、全半角混用、零宽字符、BOM、软连字符
 * 与生僻字。本模块：UTF-8 优先、失败按 GBK/GB18030 回退；逐行返回
 * decoded / encoding_used / decoded_ok 三态；**无法可靠解码的行显式标记**
 * 而不是静默变成乱码（静默乱码会污染复合键，导致错误归并）。
 *
 * Node 22 的 TextDecoder 原生支持 gbk / gb18030（已实测）。
 */
import { normalizeWidth } from './width'
import type { DecodedLine } from '../types'

/** 需要在比较前剔除的不可见 / 格式字符。 */
const ZERO_WIDTH_OR_FORMAT = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF\u00AD]/g

/** 仅含不可打印字符（控制字符、零宽、空白）视为脏行。 */
const PRINTABLE = /[\u0020-\u007E\u00A0-\uFFFF]/

export interface DecodeOptions {
  /** 是否执行宽度折叠，默认 true。 */
  normalizeWidth?: boolean
}

/** UTF-8 致命解码；失败返回 null（不返回猜测结果）。 */
function tryUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** GB18030 解码（兼容 GBK）。某些字节在 gb18030 下也可能非法，同样致命判定。 */
function tryGb18030(bytes: Uint8Array): { text: string; ok: boolean } {
  try {
    const text = new TextDecoder('gb18030', { fatal: true }).decode(bytes)
    return { text, ok: true }
  } catch {
    // 致命模式失败时退回非致命，但标记 decoded_ok=false，交由上层转人工。
    const text = new TextDecoder('gb18030', { fatal: false }).decode(bytes)
    return { text, ok: false }
  }
}

/** 剔除零宽 / BOM / 软连字符与控制字符，保留 CJK 扩展区生僻字。 */
export function stripInvisibles(text: string): string {
  return text.replace(ZERO_WIDTH_OR_FORMAT, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

/** 判定是否仅含不可打印字符（脏行）。 */
export function isUnprintable(text: string): boolean {
  const stripped = stripInvisibles(text).trim()
  return stripped.length === 0 || !PRINTABLE.test(stripped)
}

/**
 * 解码单段字节，返回三态。不可靠解码 decoded_ok=false 且 flags 含 mojibake，
 * 不把乱码当正常字符串返回给上层参与归并（上层据此转人工）。
 */
export function decodeBytes(bytes: Uint8Array, options: DecodeOptions = {}): DecodedLine {
  const doWidth = options.normalizeWidth ?? true
  const utf8 = tryUtf8(bytes)
  let text: string
  let encoding_used: DecodedLine['encoding_used']
  let decoded_ok: boolean
  const flags: string[] = []

  if (utf8 !== null) {
    text = utf8
    encoding_used = 'utf-8'
    decoded_ok = true
  } else {
    const gb = tryGb18030(bytes)
    text = gb.text
    // GB18030 能解但 UTF-8 解不了：属正常 GBK 回退，仍记为成功；
    // 只有致命解码失败退回的非致命结果才标 mojibake。
    encoding_used = 'gb18030'
    decoded_ok = gb.ok
    if (!gb.ok) flags.push('mojibake')
  }

  text = stripInvisibles(text)
  if (doWidth) text = normalizeWidth(text)
  if (isUnprintable(text)) flags.push('unprintable')
  if (text.length === 0) flags.push('empty')

  return { text, encoding_used, decoded_ok, flags }
}

/** 解码文本（已是 string 的场景）：剔除不可见字符 + 宽度归一 + 脏行标记。 */
export function normalizeText(input: string, options: DecodeOptions = {}): DecodedLine {
  const doWidth = options.normalizeWidth ?? true
  let text = stripInvisibles(input)
  if (doWidth) text = normalizeWidth(text)
  const flags: string[] = []
  if (isUnprintable(text)) flags.push('unprintable')
  if (text.length === 0) flags.push('empty')
  return { text, encoding_used: 'utf-8', decoded_ok: true, flags }
}

/**
 * 按行解码（多字节流按 \n 切分字节后再逐行判定编码）。
 * 混编场景下不同行可能用不同编码，逐行判定比整段判定更稳。
 */
export function decodeLines(bytes: Uint8Array, options: DecodeOptions = {}): DecodedLine[] {
  const lines: Uint8Array[] = []
  let start = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      lines.push(bytes.subarray(start, i))
      start = i + 1
    }
  }
  if (start < bytes.length) lines.push(bytes.subarray(start))
  return lines.map((line) => decodeBytes(line, options))
}

/** 是否含生僻字（CJK 扩展区 A–G）：保留，不剔除。 */
export function containsRareCjk(text: string): boolean {
  // 用大括号码点转义：\u20000 会被解析成 \u2000 + '0'，必须写作 \u{20000}。
  return /[\u3400-\u4DBF\u{20000}-\u{2FFFF}]/u.test(text)
}
