/**
 * 模型调用留痕与按 candidate_id 反查（Task 34）。
 *
 * 任一归并结论都能回答「这是哪次模型调用、什么模型、用了什么上下文、校验过
 * 没有」。留痕含 model/base_url/prompt_hash/tokens/latency/finish_reason/
 * schema_valid/degraded_reason/candidate_id；api_key 只记掩码。
 * 留痕持久化由工作区承接（appendCallLog），本模块负责生成与反查索引。
 */
import { createHash } from 'node:crypto'
import type { ModelCallLog } from '../types'

/** 对实际发送的提示词做 sha256（上下文段 + 归并请求段）。 */
export function promptHash(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex')
}

/** 生成调用留痕条目。 */
export interface CallLogInput {
  candidate_id: string
  model: string
  base_url: string
  api_key_masked: string
  prompt: string
  input_tokens?: number
  output_tokens?: number
  latency_ms: number
  finish_reason: string
  schema_valid: boolean
  degraded_reason?: string | null
  now?: () => string
}

export function makeCallLog(input: CallLogInput): ModelCallLog {
  const seq = createHash('sha256')
    .update(`${input.candidate_id}|${input.prompt}|${input.latency_ms}`)
    .digest('hex')
    .slice(0, 16)
  return {
    model_call_id: `mc-${seq}`,
    candidate_id: input.candidate_id,
    model: input.model,
    base_url: input.base_url,
    prompt_hash: promptHash(input.prompt),
    input_tokens: input.input_tokens ?? 0,
    output_tokens: input.output_tokens ?? 0,
    latency_ms: input.latency_ms,
    finish_reason: input.finish_reason,
    schema_valid: input.schema_valid,
    degraded_reason: input.degraded_reason ?? null,
    api_key_masked: input.api_key_masked,
    created_at: (input.now ?? (() => new Date().toISOString()))(),
  }
}

/** 反查索引：按 candidate_id 取全部调用记录。 */
export function indexByCandidate(logs: ModelCallLog[]): Map<string, ModelCallLog[]> {
  const index = new Map<string, ModelCallLog[]>()
  for (const log of logs) {
    const list = index.get(log.candidate_id) ?? []
    list.push(log)
    index.set(log.candidate_id, list)
  }
  return index
}

/** 按 model_call_id 取回单条调用元数据。 */
export function findByCallId(logs: ModelCallLog[], modelCallId: string): ModelCallLog | undefined {
  return logs.find((l) => l.model_call_id === modelCallId)
}

/** 降级率统计：degraded_reason 非空的调用占比。 */
export function degradeRate(logs: ModelCallLog[]): number {
  if (logs.length === 0) return 0
  return logs.filter((l) => !!l.degraded_reason).length / logs.length
}

/** 敏感信息兜底：留痕内容不得含 api_key 全文。 */
export function assertNoSecret(logs: ModelCallLog[], secret: string): boolean {
  if (!secret) return true
  return !JSON.stringify(logs).includes(secret)
}
