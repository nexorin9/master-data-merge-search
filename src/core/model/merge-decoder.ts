/**
 * 标记协议编解码（Task 30）。
 *
 * 源实现 github_ref/airi/packages/core-agent/src/runtime/llm-marker-parser.ts
 * 用 createLlmMarkerParser 把模型输出按 <|…|> 切成 literal / special，并把
 * 转义 <{'|'}> 还原为 <|。本模块**复用同一算法**（含跨 chunk 拼接、未闭合
 * 标记与空段处理行为），标记语义改写为本产品三段：证据 / 结论 / 存疑理由。
 *
 * 标记约定（本产品）：
 *   <|证据|> … <|/证据|>   → evidence 段（可空）
 *   <|结论|> … <|/结论|>   → conclusion 段（必需，缺失判解码失败转人工）
 *   <|存疑理由|> … <|/存疑理由|> → uncertain_reason 段（可空）
 * 段内文本为 literal；跨 chunk 切断的标记在拼接后再切段。
 */
import type { MarkerSegments } from '../types'

const TAG_OPEN = '<|'
const TAG_CLOSE = '|>'
const ESCAPED_TAG_OPEN = "<{'|'}"
const ESCAPED_TAG_CLOSE = "{'|'}>"

export interface MarkerToken {
  type: 'literal' | 'special'
  value: string
}

/**
 * 源算法等价实现：把整段文本切成 literal / special token 流。
 * special 为完整的 <|…|> 标记（含两端）；转义先还原再切分。
 */
export function tokenizeMarkers(input: string): MarkerToken[] {
  const tokens: MarkerToken[] = []
  const text = input
    .replaceAll(ESCAPED_TAG_OPEN, TAG_OPEN)
    .replaceAll(ESCAPED_TAG_CLOSE, TAG_CLOSE)
  let buffer = text

  while (buffer.length > 0) {
    const openIndex = buffer.indexOf(TAG_OPEN)
    if (openIndex < 0) {
      if (buffer.length > 0) tokens.push({ type: 'literal', value: buffer })
      break
    }
    if (openIndex > 0) tokens.push({ type: 'literal', value: buffer.slice(0, openIndex) })
    const closeIndex = buffer.indexOf(TAG_CLOSE, openIndex + TAG_OPEN.length)
    if (closeIndex < 0) {
      // 悬空未闭合的起始标记：源实现 consume 后 inTag=true，end() 不 flush，
      // 因此从该 <| 起的尾部被丢弃。此处保持一致，直接 break 且不产出 token。
      // openIndex 之前的字面文本已在上方入册，故结果与 golden end() 行为逐字一致。
      break
    }
    tokens.push({ type: 'special', value: buffer.slice(openIndex, closeIndex + TAG_CLOSE.length) })
    buffer = buffer.slice(closeIndex + TAG_CLOSE.length)
  }
  return tokens
}

/** 标记名 → 段名映射。 */
const SEGMENT_TAGS: Record<string, keyof MarkerSegments> = {
  '证据': 'evidence',
  '结论': 'conclusion',
  '存疑理由': 'uncertain_reason',
  // 兼容常见别名（英文/斜杠闭合标记归一）。
  '/证据': 'evidence', '/结论': 'conclusion', '/存疑理由': 'uncertain_reason',
}

/** 从 special token 取标记名。 */
function tagName(special: string): string {
  return special.slice(TAG_OPEN.length, -TAG_CLOSE.length).trim()
}

export interface DecodeResult {
  ok: boolean
  segments: MarkerSegments
  error?: string
}

/**
 * 解码三段。跨 chunk 场景由调用方先把所有 chunk 拼接后一次性传入，
 * 保证标记跨 chunk 切断时仍能正确切段（等价源实现 buffer 拼接行为）。
 */
export function decodeSegments(fullText: string): DecodeResult {
  const segments: MarkerSegments = { evidence: '', conclusion: '', uncertain_reason: '' }
  const tokens = tokenizeMarkers(fullText)
  let current: keyof MarkerSegments | null = null
  let sawConclusionTag = false

  for (const token of tokens) {
    if (token.type === 'special') {
      const name = tagName(token.value)
      const mapped = SEGMENT_TAGS[name]
      if (mapped && !name.startsWith('/')) {
        current = mapped
        if (mapped === 'conclusion') sawConclusionTag = true
      } else if (name.startsWith('/') && SEGMENT_TAGS[name]) {
        current = null
      }
      // 未识别的 special（如模型自造标记）：忽略，不污染段落。
      continue
    }
    if (current) segments[current] += token.value
  }

  // 缺结论段判解码失败并转人工；若模型未用标记但整段是纯文本，尝试整段当结论。
  if (!sawConclusionTag) {
    const literalOnly = tokens.filter((t) => t.type === 'literal').map((t) => t.value).join('').trim()
    if (literalOnly && tokens.every((t) => t.type === 'literal')) {
      segments.conclusion = literalOnly
    } else {
      return { ok: false, segments, error: '缺结论段，解码失败转人工' }
    }
  }
  return { ok: true, segments }
}

/** 流式解码器：逐 chunk feed，end() 后一次性解码（保证跨 chunk 标记拼接正确）。 */
export function createStreamingDecoder() {
  let chunks = ''
  return {
    feed(chunk: string): void { chunks += chunk },
    end(): DecodeResult { return decodeSegments(chunks) },
    get fullText(): string { return chunks },
  }
}

// re-export 常量供对照测试断言转义还原。
export const MARKER_SYNTAX = { TAG_OPEN, TAG_CLOSE, ESCAPED_TAG_OPEN, ESCAPED_TAG_CLOSE }
