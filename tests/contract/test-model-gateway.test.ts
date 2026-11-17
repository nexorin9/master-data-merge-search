/**
 * ModelGateway 请求协议 / 配置面契约测试（Task 19）。
 *
 * 断言：请求体含 response_format + messages；结构化 content 被正确解析；
 * base_url / api_key / model / timeout 全部取自 config；chat 打
 * `${base_url}/v1/chat/completions` 且带 `Authorization: Bearer <apiKey>`；
 * buildRequest 使用 config.llm.model；maskedApiKey 只记掩码。
 * 全程 vi.stubGlobal('fetch') 替身，零真实网络。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestConfig, type AppConfig } from '@shared/config'
import {
  createModelGateway,
  makeMergeRequestBody,
  maskedApiKey,
  type ChatCompletionRequest,
  type GatewayResult,
  type ChatCompletionResponse,
} from '@core/model/model-gateway'
import type { ContextSnapshotEntry } from '@core/types'
import { baseCandidate } from '../fixtures/gate-helpers'

const config: AppConfig = createTestConfig({
  llm: {
    baseUrl: 'http://llm.test/api',
    apiKey: 'sk-abcdefgh',
    model: 'gateway-model-A',
    timeoutMs: 12345,
    maxRetries: 1,
    concurrency: 2,
  },
})

const snapshot: ContextSnapshotEntry[] = [
  {
    key: 'masterdata', text: '阿莫西林胶囊 0.25g*12片', domain: 'drug',
    record_id: 'MD-0001', query_term: '阿莫西林', matched_field: 'name',
    ingested_at: 1000, snapshot_version: 'v1',
  },
]

const jsonSchema = {
  name: 'merge_conclusion',
  schema: { type: 'object', properties: { action: { type: 'string' } } },
}

function okResponse(content = '{"action":"merge","target_code":"XJ7000000000001"}'): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 22 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function simpleRequest(): ChatCompletionRequest {
  return {
    model: 'gateway-model-A',
    messages: [{ role: 'user', content: 'hello' }],
    response_format: { type: 'json_object' },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ModelGateway 请求协议与配置面（Task 19）', () => {
  it('makeMergeRequestBody 无 schema → response_format=json_object，且含 system/user 两条 messages', () => {
    const body = makeMergeRequestBody(baseCandidate(), snapshot, 'm-1')
    expect(body.model).toBe('m-1')
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(body.messages[0].content).toContain('归并评审')
    const user = body.messages[1].content
    expect(user).toContain('[Context]')
    expect(user).toContain('MD-0001')
    expect(user).toContain('C-0001')
    expect(user).toContain('[本批归并请求]')
  })

  it('makeMergeRequestBody 带 jsonSchema → response_format=json_schema 且回传 schema', () => {
    const body = makeMergeRequestBody(baseCandidate(), snapshot, 'm-2', jsonSchema)
    expect(body.model).toBe('m-2')
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: jsonSchema })
  })

  it('gateway.config 完全来自 createTestConfig 的 llm 段', () => {
    const gw = createModelGateway(config)
    expect(gw.config.baseUrl).toBe('http://llm.test/api')
    expect(gw.config.apiKey).toBe('sk-abcdefgh')
    expect(gw.config.model).toBe('gateway-model-A')
    expect(gw.config.timeoutMs).toBe(12345)
    expect(gw.config.maxRetries).toBe(1)
    expect(gw.config.concurrency).toBe(2)
  })

  it('buildRequest 使用 config.llm.model，并透传 jsonSchema', () => {
    const gw = createModelGateway(config)
    const req = gw.buildRequest(baseCandidate(), snapshot)
    expect(req.model).toBe(config.llm.model)
    expect(req.model).toBe('gateway-model-A')
    const withSchema = gw.buildRequest(baseCandidate(), snapshot, jsonSchema)
    expect(withSchema.response_format).toEqual({ type: 'json_schema', json_schema: jsonSchema })
  })

  it('chat POST 到 ${base_url}/v1/chat/completions，带 Bearer 凭据与 JSON body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return okResponse()
    })
    vi.stubGlobal('fetch', fetchMock)

    const gw = createModelGateway(config)
    const req = simpleRequest()
    const r: GatewayResult<ChatCompletionResponse> = await gw.chat(req)

    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://llm.test/api/v1/chat/completions')
    expect(calls[0].init.method).toBe('POST')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers.Authorization).toBe('Bearer sk-abcdefgh')
    const sent = JSON.parse(calls[0].init.body as string) as ChatCompletionRequest
    expect(sent).toEqual(req)
  })

  it('chat 解析结构化 content / finish_reason / usage，attempt=1', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse('{"action":"uncertain"}')))
    const gw = createModelGateway(config)
    const r = await gw.chat(simpleRequest())
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('期望成功')
    expect(r.data.content).toBe('{"action":"uncertain"}')
    expect(r.data.finish_reason).toBe('stop')
    expect(r.data.usage).toEqual({ prompt_tokens: 11, completion_tokens: 22 })
    expect(r.attempt).toBe(1)
  })

  it('base_url 末尾斜杠被规整，端点不出现重复斜杠', async () => {
    let seen = ''
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { seen = url; return okResponse() }))
    const gw = createModelGateway(createTestConfig({ llm: { baseUrl: 'http://llm.test/api///' } }))
    await gw.chat(simpleRequest())
    expect(seen).toBe('http://llm.test/api/v1/chat/completions')
  })

  it('超时来自配置：请求携带合并后的 signal（AbortSignal.timeout）', async () => {
    let seenSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seenSignal = init.signal ?? undefined
      return okResponse()
    }))
    const gw = createModelGateway(config)
    await gw.chat(simpleRequest())
    expect(seenSignal).toBeDefined()
    expect(seenSignal?.aborted).toBe(false)
  })

  it('maskedApiKey 只记掩码，不含明文（长键与短键）', () => {
    expect(maskedApiKey(config)).toBe('sk-a****gh')
    expect(maskedApiKey(config)).not.toContain('sk-abcdefgh')
    expect(maskedApiKey(config)).toContain('****')
    const shortKey = maskedApiKey(createTestConfig({ llm: { apiKey: 'abc' } }))
    expect(shortKey).toBe('ab****')
  })
})
