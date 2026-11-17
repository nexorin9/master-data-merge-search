/**
 * ModelGateway：单一可替换网关（Task 8 / 28）。
 *
 * OpenAI-compatible：base_url / api_key / model / timeout / max_retries /
 * concurrency 全配置化，业务层不直接耦合厂商 SDK。含超时、错误分类、重试
 * 矩阵与取消语义。任何失败都返回失败结果且 degraded_reason 非空，绝不返回
 * 空结论冒充成功；失败结果写回开关关闭。
 */
import type { AppConfig } from '../../shared/config'
import { maskSecret } from '../../shared/config'
import { buildMergeRequestTurn } from '../retrieval/context-prompt'
import type {
  CandidateRecord, ContextSnapshotEntry, MergeRequestTurn, ModelErrorKind, ModelErrorObject,
} from '../types'

/** 重试矩阵：网络错误与 5xx 退避重试，429 尊重 Retry-After，4xx（429 除外）不重试。 */
const RETRYABLE_KINDS: ModelErrorKind[] = ['network', 'server_error', 'rate_limit']

export interface ChatCompletionRequest {
  model: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  response_format?: unknown
  signal?: AbortSignal
}

export interface ChatCompletionResponse {
  content: string
  finish_reason: string
  usage?: { prompt_tokens: number; completion_tokens: number }
}

export type GatewayResult<T> =
  | { ok: true; data: T; attempt: number }
  | { ok: false; error: ModelErrorObject; attempt: number; degraded_reason: string }

export interface ModelGateway {
  readonly config: AppConfig['llm']
  buildRequest(candidate: CandidateRecord, snapshot: ContextSnapshotEntry[], jsonSchema?: unknown): ChatCompletionRequest
  chat(request: ChatCompletionRequest, signal?: AbortSignal): Promise<GatewayResult<ChatCompletionResponse>>
  chatWithRetry(request: ChatCompletionRequest, signal?: AbortSignal): Promise<GatewayResult<ChatCompletionResponse>>
}

/** 错误分类：不抛裸字符串，全部结构化。 */
export function classifyError(status: number | null, err?: unknown): ModelErrorObject {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  if (status === 429) return { kind: 'rate_limit', status: 429, retryable: true, message: '模型端点限流 (429)' }
  if (status !== null && status >= 500) {
    return { kind: 'server_error', status, retryable: true, message: `模型端点服务错误 (${status})` }
  }
  if (status !== null && status >= 400) {
    return { kind: 'client_error', status, retryable: false, message: `模型端点请求错误 (${status})` }
  }
  if (message.includes('abort') || message.includes('cancel')) {
    return { kind: 'cancelled', status: null, retryable: false, message: '请求已取消' }
  }
  if (message.includes('timeout') || message.includes('Timeout') || message.includes('aborted')) {
    return { kind: 'timeout', status: null, retryable: false, message: `模型调用超时：${message}` }
  }
  return { kind: 'network', status: null, retryable: true, message: `网络错误：${message || '请求失败'}` }
}

/** 构造 OpenAI-compatible 归并请求体（含分桶上下文注入本批归并请求 turn）。 */
export function makeMergeRequestBody(
  candidate: CandidateRecord,
  snapshot: ContextSnapshotEntry[],
  model: string,
  jsonSchema?: unknown,
): ChatCompletionRequest {
  const requestTurn = buildMergeRequestTurn(snapshot, candidate)
  const turn: MergeRequestTurn = { context_block: '', request: requestTurn, candidate }
  const body: ChatCompletionRequest = {
    model,
    messages: [
      {
        role: 'system',
        content: '你是院内主数据归并评审助手。只依据 [Context] 中的记录判定，输出归并建议 JSON。',
      },
      { role: 'user', content: turn.request },
    ],
  }
  body.response_format = jsonSchema
    ? { type: 'json_schema', json_schema: jsonSchema }
    : { type: 'json_object' }
  return body
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      const onAbort = () => { clearTimeout(timer); reject(new Error('aborted')) }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

export function createModelGateway(config: AppConfig): ModelGateway {
  const llm = config.llm
  const endpoint = `${llm.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`

  async function chat(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
  ): Promise<GatewayResult<ChatCompletionResponse>> {
    // 超时：取配置；调用方 signal 与之合并。
    const timeoutSignal = AbortSignal.timeout(llm.timeoutMs)
    const mergedSignal = signal
      ? AbortSignal.any([timeoutSignal, signal])
      : timeoutSignal

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${llm.apiKey}`,
        },
        body: JSON.stringify(request),
        signal: mergedSignal,
      })
      if (!res.ok) {
        let retryAfterMs: number | undefined
        if (res.status === 429) {
          const ra = res.headers.get('retry-after')
          if (ra) retryAfterMs = Number.parseInt(ra, 10) * 1000
        }
        // 读取响应体：端点「不支持 json_schema」的提示在 400 body 里，
        // 结构化输出层 needsSchemaDowngrade(status, body) 依赖它判定降级。
        // 只取摘要且不回显凭据；读取失败不阻断错误分类。
        let body = ''
        try { body = (await res.text()).slice(0, 800) } catch { /* 忽略空/不可读 body */ }
        const error = classifyError(res.status)
        error.message = body ? `${error.message}：${body}` : error.message
        if (retryAfterMs && Number.isFinite(retryAfterMs)) error.retry_after_ms = retryAfterMs
        return { ok: false, error, attempt: 1, degraded_reason: `model_http_${res.status}` }
      }
      const raw = await res.json() as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const choice = raw.choices?.[0]
      if (!choice?.message?.content) {
        return {
          ok: false,
          error: { kind: 'client_error', status: 200, retryable: false, message: '模型响应无 content' },
          attempt: 1,
          degraded_reason: 'model_empty_content',
        }
      }
      return {
        ok: true,
        data: {
          content: choice.message.content,
          finish_reason: choice.finish_reason ?? 'stop',
          usage: {
            prompt_tokens: raw.usage?.prompt_tokens ?? 0,
            completion_tokens: raw.usage?.completion_tokens ?? 0,
          },
        },
        attempt: 1,
      }
    } catch (err) {
      const error = classifyError(null, err)
      return { ok: false, error, attempt: 1, degraded_reason: `model_${error.kind}` }
    }
  }

  async function chatWithRetry(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
  ): Promise<GatewayResult<ChatCompletionResponse>> {
    let last: GatewayResult<ChatCompletionResponse> | null = null
    for (let attempt = 1; attempt <= llm.maxRetries + 1; attempt++) {
      if (signal?.aborted) {
        return {
          ok: false,
          error: { kind: 'cancelled', status: null, retryable: false, message: '请求已取消' },
          attempt,
          degraded_reason: 'model_cancelled',
        }
      }
      const result = await chat(request, signal)
      last = { ...result, attempt }
      if (result.ok) return last
      if (result.error.kind === 'cancelled') {
        return { ...result, attempt, degraded_reason: 'model_cancelled' }
      }
      const shouldRetry = result.error.retryable && RETRYABLE_KINDS.includes(result.error.kind) && attempt <= llm.maxRetries
      if (!shouldRetry) return { ...result, attempt, degraded_reason: result.degraded_reason }
      await sleep(result.error.retry_after_ms ?? 200 * 2 ** (attempt - 1), signal).catch(() => {})
    }
    return last ?? {
      ok: false,
      error: { kind: 'network', status: null, retryable: false, message: '模型调用失败' },
      attempt: 0,
      degraded_reason: 'model_unknown',
    }
  }

  return {
    config: llm,
    buildRequest: (candidate, snapshot, schema) => makeMergeRequestBody(candidate, snapshot, llm.model, schema),
    chat,
    chatWithRetry,
  }
}

/** 调用留痕里的密钥掩码（避免 api_key 全文落盘）。 */
export function maskedApiKey(config: AppConfig): string {
  return maskSecret(config.llm.apiKey)
}
