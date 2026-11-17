/**
 * 模型调用留痕与反查单测（Task 26 / 34）。
 *
 * 覆盖：makeCallLog 字段完整性与缺省值、promptHash 随上下文变化、
 * indexByCandidate 分组、findByCallId 反查、degradeRate 统计、
 * assertNoSecret 敏感信息兜底（掩码/无密钥为 true、明文出现为 false）。
 * 全部纯函数，无需 fetch。
 */
import { describe, expect, it } from 'vitest'
import { maskSecret } from '@shared/config'
import {
  assertNoSecret,
  degradeRate,
  findByCallId,
  indexByCandidate,
  makeCallLog,
  promptHash,
  type CallLogInput,
} from '@core/model/call-log'
import type { ModelCallLog } from '@core/types'

const FIXED_NOW = () => 'T0'

function input(over: Partial<CallLogInput> = {}): CallLogInput {
  return {
    candidate_id: 'C-0001',
    model: 'test-model',
    base_url: 'http://llm.test',
    api_key_masked: 'test****ey',
    prompt: '[Context]\n- MD-0001\n[本批归并请求]\n- 候选 C-0001',
    input_tokens: 100,
    output_tokens: 40,
    latency_ms: 321,
    finish_reason: 'stop',
    schema_valid: true,
    degraded_reason: null,
    now: FIXED_NOW,
    ...over,
  }
}

describe('makeCallLog 与 promptHash（Task 26）', () => {
  it('makeCallLog：字段完整，model_call_id / prompt_hash / created_at 齐备', () => {
    const i = input()
    const log = makeCallLog(i)
    expect(log.model_call_id).toMatch(/^mc-[0-9a-f]{16}$/)
    expect(log.candidate_id).toBe('C-0001')
    expect(log.model).toBe('test-model')
    expect(log.base_url).toBe('http://llm.test')
    expect(log.api_key_masked).toBe('test****ey')
    expect(log.prompt_hash).toBe(promptHash(i.prompt))
    expect(log.input_tokens).toBe(100)
    expect(log.output_tokens).toBe(40)
    expect(log.latency_ms).toBe(321)
    expect(log.finish_reason).toBe('stop')
    expect(log.schema_valid).toBe(true)
    expect(log.degraded_reason).toBeNull()
    expect(log.created_at).toBe('T0')
  })

  it('makeCallLog：tokens 缺省为 0、degraded_reason 缺省为 null、created_at 缺省为 ISO 时间', () => {
    const log = makeCallLog(input({
      input_tokens: undefined, output_tokens: undefined, degraded_reason: undefined, now: undefined,
    }))
    expect(log.input_tokens).toBe(0)
    expect(log.output_tokens).toBe(0)
    expect(log.degraded_reason).toBeNull()
    expect(log.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('model_call_id 由 candidate_id|prompt|latency_ms 确定：相同输入稳定、改变即变', () => {
    const a = makeCallLog(input())
    const b = makeCallLog(input())
    expect(a.model_call_id).toBe(b.model_call_id)
    const c = makeCallLog(input({ latency_ms: 999 }))
    expect(c.model_call_id).not.toBe(a.model_call_id)
  })

  it('promptHash：sha256 十六进制串，同提示词稳定、上下文变化即变化', () => {
    const h = promptHash('ctx-A|req')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(promptHash('ctx-A|req')).toBe(h)
    expect(promptHash('ctx-B|req')).not.toBe(h) // 上下文段变化可被察觉
    expect(promptHash('ctx-A|req2')).not.toBe(h) // 请求段变化也可被察觉
  })
})

describe('反查索引与降级率（Task 26）', () => {
  function makeLogs(): ModelCallLog[] {
    return [
      makeCallLog(input({ candidate_id: 'C-1', latency_ms: 1, degraded_reason: null })),
      makeCallLog(input({ candidate_id: 'C-2', latency_ms: 2, degraded_reason: 'model_timeout' })),
      makeCallLog(input({ candidate_id: 'C-1', latency_ms: 3, degraded_reason: 'model_http_503' })),
    ]
  }

  it('indexByCandidate：按 candidate_id 分组，保留同组全部记录', () => {
    const index = indexByCandidate(makeLogs())
    expect([...index.keys()].sort()).toEqual(['C-1', 'C-2'])
    expect(index.get('C-1')).toHaveLength(2)
    expect(index.get('C-2')).toHaveLength(1)
    expect(index.get('C-404')).toBeUndefined()
  })

  it('findByCallId：按 model_call_id 取回单条，缺失返回 undefined', () => {
    const logs = makeLogs()
    expect(findByCallId(logs, logs[1].model_call_id)).toBe(logs[1])
    expect(findByCallId(logs, 'mc-not-exist')).toBeUndefined()
  })

  it('degradeRate：degraded_reason 非空占比；空列表为 0', () => {
    const logs = makeLogs()
    expect(degradeRate(logs)).toBeCloseTo(2 / 3)
    expect(degradeRate([logs[0]])).toBe(0)
    expect(degradeRate([])).toBe(0)
  })
})

describe('assertNoSecret 敏感信息兜底（Task 26）', () => {
  it('掩码 / 无密钥 / 空 secret → true', () => {
    const secret = 'sk-real-secret-key-1234'
    const log = makeCallLog(input({ api_key_masked: maskSecret(secret) }))
    expect(log.api_key_masked).not.toContain(secret)
    expect(assertNoSecret([log], secret)).toBe(true) // 只记掩码
    expect(assertNoSecret([log], '')).toBe(true) // 空 secret 直接放行
    expect(assertNoSecret([log], '无关字符串')).toBe(true)
  })

  it('明文密钥出现在任一留痕字段 → false', () => {
    const secret = 'sk-real-secret-key-1234'
    const masked = makeCallLog(input({ api_key_masked: maskSecret(secret) }))
    const leaked = makeCallLog(input({ candidate_id: 'C-2', api_key_masked: secret }))
    expect(assertNoSecret([masked, leaked], secret)).toBe(false)
    // 非 api_key 字段泄漏同样能被兜底捕获
    const leakedInReason = makeCallLog(input({ candidate_id: 'C-3', degraded_reason: secret }))
    expect(assertNoSecret([leakedInReason], secret)).toBe(false)
  })
})
