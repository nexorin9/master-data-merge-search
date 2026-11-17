/**
 * ModelGateway 错误分类与重试矩阵契约测试（Task 20 / 28）。
 *
 * classifyError 覆盖 429 / 4xx / 5xx / 网络 / 超时 / 取消；
 * chatWithRetry 以 vi.stubGlobal('fetch') 打重试矩阵：
 *   - 429 尊重 Retry-After（断言实际 sleep 时长取自该头）
 *   - 4xx（429 除外）不重试，只打一次
 *   - 网络错误退避重试一次后仍失败
 *   - 5xx 首次失败、重试成功
 *   - 超时 / 取消不再重试
 * 任何失败都 ok:false + degraded_reason 非空 + 绝不携带成功 content。
 *
 * 确定性：仅把「已知重试退避值」的 setTimeout 压缩到 0ms 并记录其毫秒数，
 * 其余定时器（含 vitest 测试超时）原样委托真实 setTimeout。零真实网络。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestConfig, type AppConfig } from '@shared/config'
import {
  classifyError,
  createModelGateway,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type GatewayResult,
} from '@core/model/model-gateway'

const config: AppConfig = createTestConfig({
  llm: {
    baseUrl: 'http://llm.test',
    apiKey: 'k',
    model: 'm',
    timeoutMs: 30000,
    maxRetries: 1,
    concurrency: 1,
  },
})

const request: ChatCompletionRequest = {
  model: 'm',
  messages: [{ role: 'user', content: 'x' }],
  response_format: { type: 'json_object' },
}

function responseOk(content = '{"action":"merge"}'): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}
function responseStatus(status: number, headers?: Record<string, string>): Response {
  return new Response('err', { status, headers })
}

const realSetTimeout = globalThis.setTimeout.bind(globalThis)

/**
 * 运行可能触发退避 sleep 的异步函数：记录所有 setTimeout 请求毫秒数，
 * 并把「已知退避值」压缩到 0ms（快且确定），其他定时器原样委托。
 */
function withRecordedRetries<T>(fastDelays: number[], fn: () => Promise<T>): { run: Promise<T>; delays: number[] } {
  const delays: number[] = []
  const fast = new Set(fastDelays)
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
    ((handler: (...a: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
      if (typeof handler === 'function' && typeof timeout === 'number') delays.push(timeout)
      const wait = typeof timeout === 'number' && fast.has(timeout) ? 0 : timeout
      return realSetTimeout(handler, wait, ...args)
    }) as unknown as typeof setTimeout,
  )
  const run = fn().finally(() => spy.mockRestore())
  return { run, delays }
}

function expectFailure(r: GatewayResult<ChatCompletionResponse>): void {
  expect(r.ok).toBe(false)
  if (r.ok) throw new Error('期望失败结果')
  expect(r.degraded_reason.length).toBeGreaterThan(0)
  expect(r.error.message.length).toBeGreaterThan(0)
  expect((r as { data?: unknown }).data).toBeUndefined() // 绝无成功 content
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('classifyError 错误分类（Task 20）', () => {
  it('429 → rate_limit，retryable=true', () => {
    const e = classifyError(429)
    expect(e.kind).toBe('rate_limit')
    expect(e.status).toBe(429)
    expect(e.retryable).toBe(true)
    expect(e.message).toContain('429')
    expect(e.message.length).toBeGreaterThan(0)
  })

  it('4xx（429 除外，如 400/404）→ client_error，非重试', () => {
    for (const status of [400, 404]) {
      const e = classifyError(status)
      expect(e.kind).toBe('client_error')
      expect(e.status).toBe(status)
      expect(e.retryable).toBe(false)
      expect(e.message.length).toBeGreaterThan(0)
    }
  })

  it('5xx（500/503）→ server_error，可重试', () => {
    for (const status of [500, 503]) {
      const e = classifyError(status)
      expect(e.kind).toBe('server_error')
      expect(e.status).toBe(status)
      expect(e.retryable).toBe(true)
    }
  })

  it('无状态码 + 网络异常 → network，可重试', () => {
    const e = classifyError(null, new Error('fetch failed'))
    expect(e.kind).toBe('network')
    expect(e.status).toBeNull()
    expect(e.retryable).toBe(true)
    expect(e.message).toContain('fetch failed')
  })

  it('超时（message 含 timeout）→ timeout，非重试', () => {
    const e = classifyError(null, new Error('timeout of 30000ms exceeded'))
    expect(e.kind).toBe('timeout')
    expect(e.status).toBeNull()
    expect(e.retryable).toBe(false)
    expect(e.message).toContain('超时')
  })

  it('取消（message 含 abort/cancel）→ cancelled，非重试', () => {
    const e1 = classifyError(null, new Error('aborted'))
    expect(e1.kind).toBe('cancelled')
    expect(e1.retryable).toBe(false)
    expect(e1.message).toBe('请求已取消')
    expect(classifyError(null, new Error('cancelled')).kind).toBe('cancelled')
  })
})

describe('chatWithRetry 重试矩阵（Task 28）', () => {
  it('429 + Retry-After: 1 尊重该头（sleep=1000ms 而非默认 200ms），重试后成功', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseStatus(429, { 'retry-after': '1' }))
      .mockImplementationOnce(async () => responseOk())
    vi.stubGlobal('fetch', fetchMock)
    const gw = createModelGateway(config)

    const { run, delays } = withRecordedRetries([1000], () => gw.chatWithRetry(request))
    const r = await run

    // 1000 只能来自 Retry-After=1 的解析值（默认退避是 200），证明尊重了该头
    expect(delays).toContain(1000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.attempt).toBe(2)
    expect(r.data.content).toBe('{"action":"merge"}')
  })

  it('429 单次 chat 把 Retry-After 解析进 error.retry_after_ms', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(responseStatus(429, { 'retry-after': '3' })))
    const r = await createModelGateway(config).chat(request)
    expectFailure(r)
    if (r.ok) throw new Error('unreachable')
    expect(r.error.kind).toBe('rate_limit')
    expect(r.error.retry_after_ms).toBe(3000)
  })

  it('4xx（404）不重试：fetch 只调用一次，直接失败', async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseStatus(404))
    vi.stubGlobal('fetch', fetchMock)
    const r = await createModelGateway(config).chatWithRetry(request)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expectFailure(r)
    if (r.ok) throw new Error('unreachable')
    expect(r.error.kind).toBe('client_error')
    expect(r.error.retryable).toBe(false)
    expect(r.attempt).toBe(1)
    expect(r.degraded_reason).toBe('model_http_404')
  })

  it('网络错误：退避重试一次后仍失败（共 2 次 fetch）', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('fetch failed'))
    vi.stubGlobal('fetch', fetchMock)
    const gw = createModelGateway(config)

    const { run, delays } = withRecordedRetries([200], () => gw.chatWithRetry(request))
    const r = await run

    expect(delays).toContain(200) // 默认退避 200 * 2^(1-1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expectFailure(r)
    if (r.ok) throw new Error('unreachable')
    expect(r.error.kind).toBe('network')
    expect(r.attempt).toBe(2)
    expect(r.degraded_reason).toBe('model_network')
  })

  it('5xx（503）首次失败、退避重试后成功', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseStatus(503))
      .mockImplementationOnce(async () => responseOk('{"action":"create","target_code":null}'))
    vi.stubGlobal('fetch', fetchMock)
    const gw = createModelGateway(config)

    const { run, delays } = withRecordedRetries([200], () => gw.chatWithRetry(request))
    const r = await run

    expect(delays).toContain(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.attempt).toBe(2)
    expect(r.data.content).toContain('create')
  })

  it('超时 → 不再重试（fetch 仅 1 次）', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('timeout exceeded'))
    vi.stubGlobal('fetch', fetchMock)
    const r = await createModelGateway(config).chatWithRetry(request)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expectFailure(r)
    if (r.ok) throw new Error('unreachable')
    expect(r.error.kind).toBe('timeout')
    expect(r.attempt).toBe(1)
    expect(r.degraded_reason).toBe('model_timeout')
  })

  it('取消 → 不再重试（fetch 仅 1 次）', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('aborted'))
    vi.stubGlobal('fetch', fetchMock)
    const r = await createModelGateway(config).chatWithRetry(request)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expectFailure(r)
    if (r.ok) throw new Error('unreachable')
    expect(r.error.kind).toBe('cancelled')
    expect(r.attempt).toBe(1)
    expect(r.degraded_reason).toBe('model_cancelled')
  })

  it('调用前 signal 已取消 → 零次 fetch，直接失败', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => responseOk())
    vi.stubGlobal('fetch', fetchMock)
    const ac = new AbortController()
    ac.abort()
    const r = await createModelGateway(config).chatWithRetry(request, ac.signal)

    expect(fetchMock).not.toHaveBeenCalled()
    expectFailure(r)
    if (r.ok) throw new Error('unreachable')
    expect(r.error.kind).toBe('cancelled')
    expect(r.degraded_reason).toBe('model_cancelled')
  })

  it('任何失败均 ok:false + degraded_reason 非空 + 绝无成功 content（逐类校验）', async () => {
    const cases: Array<{ status: number } | { reject: string }> = [
      { status: 400 }, { status: 429 }, { status: 500 },
      { reject: 'fetch failed' }, { reject: 'timeout' }, { reject: 'aborted' },
    ]
    for (const c of cases) {
      const fetchMock = 'status' in c
        ? vi.fn().mockResolvedValue(responseStatus(c.status))
        : vi.fn().mockRejectedValue(new Error(c.reject))
      vi.stubGlobal('fetch', fetchMock)
      const gw = createModelGateway(config)
      const { run } = withRecordedRetries([200], () => gw.chatWithRetry(request))
      expectFailure(await run)
    }
  })
})
