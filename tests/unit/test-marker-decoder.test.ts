/**
 * 标记协议编解码对照测试（Task 22 / 30）。
 *
 * GOLDEN 源实现：
 *   /Users/kamini/Desktop/RUN/Agent-GIT-CLAUDE-gpt/projects/round_032_20261108_220804/
 *   github_ref/airi/packages/core-agent/src/runtime/llm-marker-parser.ts
 *   （createLlmMarkerParser.consume / end，经 useLlmmarkerParser 驱动）
 *
 * 该文件**未内置字面量 input→output 样例**，故把其状态机逐字转录为下方
 * goldenParse（oracle，含 tailLength 保留、转义还原顺序、未闭合标记 end() 行为），
 * 再断言本产品 tokenizeMarkers / decodeSegments / createStreamingDecoder 与之
 * 语义一致：literal/special 分流、转义还原、跨 chunk 边界、空段、
 * 缺结论段→解码失败、未识别 special 忽略、段名映射。
 *
 * 覆盖要点（源实现语义）：
 *   - 先 replaceAll(ESCAPED_TAG_OPEN) 再 replaceAll(ESCAPED_TAG_CLOSE)（顺序有语义）
 *   - 无标记区按 tailLength=5 保留尾部，end() 一次性 flush
 *   - inTag=true 时 end() **丢弃**未闭合 <| 之后的内容
 */
import { describe, expect, it } from 'vitest'
import {
  MARKER_SYNTAX,
  createStreamingDecoder,
  decodeSegments,
  tokenizeMarkers,
  type MarkerToken,
} from '@core/model/merge-decoder'

// ===== GOLDEN：逐字转录源实现的常量与状态机（独立于本产品实现）=====
const TAG_OPEN = '<|'
const TAG_CLOSE = '|>'
// 直接照抄源实现字面量，避免手工转义歧义
const ESCAPED_TAG_OPEN = '<{\'|\'}'
const ESCAPED_TAG_CLOSE = '{\'|\'}>'
const MIN_LITERAL_EMIT_LENGTH = 1
const TAIL_LENGTH = Math.max(TAG_OPEN.length - 1, ESCAPED_TAG_OPEN.length - 1) // max(1, 5) = 5

interface GoldenShape {
  literals: string
  specials: string[]
  unclosedDropped: boolean
}

/** 源 createLlmMarkerParser 的同步等价：逐 chunk consume，末尾 end()。 */
function goldenParse(chunks: string[]): GoldenShape {
  let buffer = ''
  let inTag = false
  const literals: string[] = []
  const specials: string[] = []

  const onLiteral = (value: string) => { if (value) literals.push(value) }
  const onSpecial = (value: string) => { specials.push(value) }

  const consume = (textPart: string): void => {
    buffer += textPart
    buffer = buffer.replaceAll(ESCAPED_TAG_OPEN, TAG_OPEN).replaceAll(ESCAPED_TAG_CLOSE, TAG_CLOSE)
    while (buffer.length > 0) {
      if (!inTag) {
        const openTagIndex = buffer.indexOf(TAG_OPEN)
        if (openTagIndex < 0) {
          if (buffer.length - TAIL_LENGTH >= MIN_LITERAL_EMIT_LENGTH) {
            onLiteral(buffer.slice(0, -TAIL_LENGTH))
            buffer = buffer.slice(-TAIL_LENGTH)
          }
          break
        }
        if (openTagIndex > 0) {
          onLiteral(buffer.slice(0, openTagIndex))
          buffer = buffer.slice(openTagIndex)
        }
        inTag = true
      } else {
        const closeTagIndex = buffer.indexOf(TAG_CLOSE)
        if (closeTagIndex < 0) break
        onSpecial(buffer.slice(0, closeTagIndex + TAG_CLOSE.length))
        buffer = buffer.slice(closeTagIndex + TAG_CLOSE.length)
        inTag = false
      }
    }
  }

  for (const chunk of chunks) consume(chunk)
  const unclosedDropped = inTag && buffer.length > 0
  if (!inTag && buffer.length > 0) {
    onLiteral(buffer)
    buffer = ''
  }
  return { literals: literals.join(''), specials, unclosedDropped }
}

/** 本产品 token 流 → 与 golden 可比的形状（special 保序，literal 拼接）。 */
function oursShape(fullText: string): { literals: string; specials: string[] } {
  const tokens = tokenizeMarkers(fullText)
  return {
    literals: tokens.filter((t) => t.type === 'literal').map((t) => t.value).join(''),
    specials: tokens.filter((t) => t.type === 'special').map((t) => t.value),
  }
}

function expectAgreeWithGolden(fullText: string, chunks: string[] = [fullText]): GoldenShape {
  const golden = goldenParse(chunks)
  expect(oursShape(fullText)).toEqual({ literals: golden.literals, specials: golden.specials })
  return golden
}

const escOpen = ESCAPED_TAG_OPEN
const escClose = ESCAPED_TAG_CLOSE

describe('标记协议 golden 对照（源：github_ref/airi/.../llm-marker-parser.ts）', () => {
  it('GOLDEN 常量：本产品 MARKER_SYNTAX 与源实现的转义/标记写法完全一致', () => {
    expect(MARKER_SYNTAX.TAG_OPEN).toBe(TAG_OPEN)
    expect(MARKER_SYNTAX.TAG_CLOSE).toBe(TAG_CLOSE)
    expect(MARKER_SYNTAX.ESCAPED_TAG_OPEN).toBe(ESCAPED_TAG_OPEN)
    expect(MARKER_SYNTAX.ESCAPED_TAG_CLOSE).toBe(ESCAPED_TAG_CLOSE)
  })

  it('GOLDEN 三段文档：证据 / 结论 / 存疑理由 的 literal、special 分流与源一致', () => {
    const text = '<|证据|>E1<|/证据|><|结论|>C1<|/结论|><|存疑理由|>R1<|/存疑理由|>'
    const golden = expectAgreeWithGolden(text)
    expect(golden.specials).toEqual([
      '<|证据|>', '<|/证据|>', '<|结论|>', '<|/结论|>', '<|存疑理由|>', '<|/存疑理由|>',
    ])
    expect(golden.literals).toBe('E1C1R1')

    const d = decodeSegments(text)
    expect(d.ok).toBe(true)
    expect(d.segments).toEqual({ evidence: 'E1', conclusion: 'C1', uncertain_reason: 'R1' })
  })

  it('GOLDEN 转义还原：先还原 ESCAPED_TAG_OPEN 再还原 ESCAPED_TAG_CLOSE，与源一致', () => {
    const text = `${escOpen}结论${escClose}内容`
    const golden = expectAgreeWithGolden(text)
    expect(golden.specials).toEqual(['<|结论|>'])
    expect(golden.literals).toBe('内容')

    const d = decodeSegments(text)
    expect(d.ok).toBe(true)
    expect(d.segments.conclusion).toBe('内容')
  })

  it('GOLDEN 跨 chunk：转义标记被切在 chunk 边界，源 tailLength 保留 + 本产品拼接后切段一致', () => {
    const text = `${escOpen}结论${escClose}内容`
    const chunks = [text.slice(0, 4), text.slice(4, 10), text.slice(10)]
    const golden = expectAgreeWithGolden(text, chunks)
    expect(golden.unclosedDropped).toBe(false)
    expect(golden.specials).toEqual(['<|结论|>'])

    const decoder = createStreamingDecoder()
    for (const c of chunks) decoder.feed(c)
    expect(decoder.fullText).toBe(text) // 拼接后再解码
    const d = decoder.end()
    expect(d.ok).toBe(true)
    expect(d.segments.conclusion).toBe('内容')
  })

  it('GOLDEN 跨 chunk：普通标记 <|结论|> 被切断，feed/end 后与源语义一致', () => {
    const text = '<|结论|>结论文本<|/结论|>'
    const chunks = ['<|结', '论|>结论', '文本<|/结论|>']
    const golden = expectAgreeWithGolden(text, chunks)
    expect(golden.specials).toEqual(['<|结论|>', '<|/结论|>'])

    const decoder = createStreamingDecoder()
    for (const c of chunks) decoder.feed(c)
    const d = decoder.end()
    expect(d.ok).toBe(true)
    expect(d.segments.conclusion).toBe('结论文本')
  })

  it('GOLDEN 未闭合的结束标记（有开标记、无 <|/结论|>）：两实现一致且解码成功', () => {
    const text = '<|结论|>仅开标记'
    const golden = expectAgreeWithGolden(text)
    expect(golden.unclosedDropped).toBe(false)
    expect(golden.specials).toEqual(['<|结论|>'])
    expect(golden.literals).toBe('仅开标记')

    const d = decodeSegments(text)
    expect(d.ok).toBe(true)
    expect(d.segments.conclusion).toBe('仅开标记')
  })

  it('GOLDEN 空段：证据段 / 存疑理由段为空，结论段仍有值', () => {
    const text = '<|证据|><|/证据|><|结论|>C1<|/结论|><|存疑理由|><|/存疑理由|>'
    const golden = expectAgreeWithGolden(text)
    expect(golden.literals).toBe('C1')

    const d = decodeSegments(text)
    expect(d.ok).toBe(true)
    expect(d.segments).toEqual({ evidence: '', conclusion: 'C1', uncertain_reason: '' })
  })

  it('GOLDEN 短纯文本（不足 tailLength）：源 end() flush，本一致', () => {
    const text = 'abc'
    expectAgreeWithGolden(text)
    const d = decodeSegments(text)
    expect(d.ok).toBe(true)
    expect(d.segments.conclusion).toBe('abc') // 无标记时整段当结论
  })

  it('literal / special 基本分流：段外文本不进入任何段', () => {
    const text = '前缀<|结论|>中间<|/结论|>后缀'
    expectAgreeWithGolden(text)
    const d = decodeSegments(text)
    expect(d.ok).toBe(true)
    expect(d.segments.conclusion).toBe('中间')
    expect(oursShape(text).specials).toEqual(['<|结论|>', '<|/结论|>'])
  })

  it('段名映射：证据→evidence、结论→conclusion、存疑理由→uncertain_reason；闭合标记复位', () => {
    const d = decodeSegments('<|结论|>C1<|/结论|><|证据|>E1<|/证据|><|存疑理由|>R1<|/存疑理由|>')
    expect(d.ok).toBe(true)
    expect(d.segments).toEqual({ evidence: 'E1', conclusion: 'C1', uncertain_reason: 'R1' })
    // 闭合标记后字面文本不再进入任何段
    const d2 = decodeSegments('<|结论|>C1<|/结论|>段外文本')
    expect(d2.segments.conclusion).toBe('C1')
  })

  it('未识别的 special 被忽略，不污染任何段', () => {
    const text = '<|结论|>C1<|/结论|><|瞎写标记|>不该出现<|/瞎写标记|>'
    expectAgreeWithGolden(text)
    const d = decodeSegments(text)
    expect(d.ok).toBe(true)
    expect(d.segments.conclusion).toBe('C1')
    expect(d.segments.evidence).toBe('')
    expect(d.segments.uncertain_reason).toBe('')
  })

  it('缺结论段 → ok:false 并给出错误（转人工）', () => {
    const d = decodeSegments('<|证据|>E1<|/证据|><|存疑理由|>R1<|/存疑理由|>')
    expect(d.ok).toBe(false)
    expect(d.error).toContain('缺结论段')
    expect(d.segments.conclusion).toBe('')
  })

  it('tokenizeMarkers 返回 literal/special token，special 含完整 <|…|>', () => {
    const tokens: MarkerToken[] = tokenizeMarkers('A<|结论|>B')
    expect(tokens.map((t) => t.type)).toEqual(['literal', 'special', 'literal'])
    expect(tokens.map((t) => t.value)).toEqual(['A', '<|结论|>', 'B'])
  })

  /**
   * 悬空未闭合的 <| 片段：GOLDEN 源实现 inTag=true 时 end() 丢弃尾部。
   * 本产品 merge-decoder.tokenizeMarkers 已按同一算法处理（从该 <| 起的尾部
   * 不产出 token），本用例以 golden 对照守住「未闭合标记处理行为一致」边界。
   */
  it('GOLDEN 悬空未闭合 <|：源 end() 丢弃尾部，本实现同样丢弃并与其一致', () => {
    const text = '<|结论|>C1<|/结论|><|悬空未闭合'
    const golden = expectAgreeWithGolden(text)
    expect(golden.unclosedDropped).toBe(true)
    expect(golden.literals).toBe('C1') // 源实现丢弃 <| 及之后内容
    expect(golden.specials).toEqual(['<|结论|>', '<|/结论|>'])

    const d = decodeSegments(text)
    expect(d.ok).toBe(true)
    expect(d.segments.conclusion).toBe('C1')
  })
})
