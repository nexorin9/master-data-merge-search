/**
 * 全半角统一（Task 17）。
 *
 * 全角 ASCII（U+FF01–U+FF5E）映射到半角（U+0021–U+007E），全角空格
 * （U+3000）映射到半角空格。归一后 '（ ）０．９' 与 '( )0.9' 必须相等。
 * 只做宽度折叠，不改语义；括号、句点、数字保持原字符语义。
 */

const FULLWIDTH_ASCII_START = 0xff01
const FULLWIDTH_ASCII_END = 0xff5e
const ASCII_START = 0x21
const FULLWIDTH_SPACE = 0x3000
const HALFWIDTH_SPACE = 0x20

/** 全角 → 半角。CJK 汉字与其他 Unicode 原样保留。 */
export function toHalfWidth(input: string): string {
  let out = ''
  for (const ch of input) {
    const code = ch.codePointAt(0)!
    if (code === FULLWIDTH_SPACE) {
      out += String.fromCharCode(HALFWIDTH_SPACE)
    } else if (code >= FULLWIDTH_ASCII_START && code <= FULLWIDTH_ASCII_END) {
      out += String.fromCharCode(code - FULLWIDTH_ASCII_START + ASCII_START)
    } else {
      out += ch
    }
  }
  return out
}

/** 半角 ASCII 可打印字符 → 全角。用于需要全角输出的对照展示。 */
export function toFullWidth(input: string): string {
  let out = ''
  for (const ch of input) {
    const code = ch.codePointAt(0)!
    if (code === HALFWIDTH_SPACE) {
      out += String.fromCharCode(FULLWIDTH_SPACE)
    } else if (code >= ASCII_START && code <= 0x7e) {
      out += String.fromCharCode(code - ASCII_START + FULLWIDTH_ASCII_START)
    } else {
      out += ch
    }
  }
  return out
}

/** 宽度归一：统一折叠为半角，供后续比较键使用。 */
export function normalizeWidth(input: string): string {
  return toHalfWidth(input)
}

/** 归一后比较：全半角混写视为等价。 */
export function widthEqual(a: string, b: string): boolean {
  return normalizeWidth(a) === normalizeWidth(b)
}
