/**
 * 渲染层 → 本机服务调用封装（Task 12 / 44 白名单契约）。
 *
 * 硬约束：
 *  1. 只经 window.reviewDesk.invoke 调用，且只走 @shared/ipc-contract 白名单通道；
 *  2. 凭据（apiKey / apiToken / authorization 等）不下发，响应里的凭据字段也剥离；
 *  3. 入参统一转成可结构化克隆的纯数据，不含函数 / 循环引用 / 未定义字段；
 *  4. node SSR 无 window 时不抛错，返回可读的 bridge 未就绪响应。
 */
import {
  IPC_CHANNELS,
  isIpcChannel,
  type IpcChannel,
  type LocalRpcResponse,
  type ReviewDeskBridge,
} from '@shared/ipc-contract'

/** 凭据键名特征：命中即从入参与响应中剔除。幂等键 idempotency_key 不含 api 前缀，不受影响。 */
const CREDENTIAL_KEY =
  /api[_-]?key|api[_-]?token|(^|[_-_])token($|[_-_])|authorization|secret|password|credential|bearer/i

export function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY.test(key)
}

type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike }

/**
 * 递归裁剪为「可结构化克隆」的纯数据：
 *  - 函数 / symbol / bigint / undefined / 循环引用 → 丢弃；
 *  - Date → ISO 字符串；NaN / Infinity → null；
 *  - 凭据键名 → 整字段剔除（连带其值，杜绝凭据字面量外泄）。
 */
function toClonable(value: unknown, seen = new Set<object>()): JsonLike | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value instanceof Date) return value.toISOString()

  if (Array.isArray(value)) {
    if (seen.has(value)) return undefined
    seen.add(value)
    const out: JsonLike[] = []
    for (const item of value) {
      const cloned = toClonable(item, seen)
      if (cloned !== undefined) out.push(cloned)
    }
    seen.delete(value)
    return out
  }

  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    if (seen.has(object)) return undefined
    seen.add(object)
    const out: { [key: string]: JsonLike } = {}
    for (const [key, item] of Object.entries(object)) {
      if (isCredentialKey(key)) continue
      const cloned = toClonable(item, seen)
      if (cloned !== undefined) out[key] = cloned
    }
    seen.delete(object)
    return out
  }

  // function / symbol / bigint / undefined 一律不进入请求体
  return undefined
}

/** 六个业务方法 + 检查新批次，各自固定映射一条白名单通道。 */
export const METHOD_CHANNELS = {
  batchList: 'batch:list',
  evaluateCandidate: 'candidate:evaluate',
  getConclusion: 'conclusion:get',
  submitSuggestion: 'suggestion:submit',
  askFollowup: 'followup:ask',
  exportSuggestion: 'suggestion:export',
  checkNewBatch: 'tray:check-new',
} as const satisfies Record<string, IpcChannel>

/** 由 preload 注入的 invoke；SSR / 未就绪时返回可读失败，不抛异常。 */
const defaultInvoke: ReviewDeskBridge['invoke'] = async (channel, payload) => {
  if (typeof window === 'undefined' || !window.reviewDesk) {
    return {
      ok: false,
      code: 'BRIDGE_UNAVAILABLE',
      message: '本机服务未就绪，请在桌面评审台中打开应用后重试',
    }
  }
  return window.reviewDesk.invoke(channel, payload)
}

/**
 * 创建调用门面。可注入 invoke 便于测试；生产使用默认实现。
 * 所有方法都经 invokeByChannel，杜绝绕过白名单的直接调用。
 */
export function createReviewDeskBridge(invoke: ReviewDeskBridge['invoke']) {
  async function invokeByChannel<T = unknown>(
    channel: unknown,
    payload?: unknown,
  ): Promise<LocalRpcResponse<T>> {
    if (!isIpcChannel(channel)) {
      throw new Error(`未注册通道被拒：${String(channel)} 不在白名单 ${IPC_CHANNELS.join(', ')} 中`)
    }

    const safePayload = (toClonable(payload) ?? {}) as unknown as Record<string, JsonLike>

    let raw: unknown
    try {
      raw = await invoke(channel, safePayload)
    } catch (error) {
      return {
        ok: false,
        code: 'BRIDGE_INVOKE_FAILED',
        message: error instanceof Error ? error.message : '本机服务调用失败，请重试',
      }
    }

    const cleaned = toClonable(raw)
    if (!cleaned || typeof cleaned !== 'object' || Array.isArray(cleaned)) {
      return { ok: false, code: 'BRIDGE_BAD_RESPONSE', message: '本机服务返回了不可解析的响应' }
    }
    return cleaned as unknown as LocalRpcResponse<T>
  }

  return {
    invokeByChannel,
    batchList: <T = unknown>(payload?: unknown) =>
      invokeByChannel<T>(METHOD_CHANNELS.batchList, payload),
    evaluateCandidate: <T = unknown>(payload?: unknown) =>
      invokeByChannel<T>(METHOD_CHANNELS.evaluateCandidate, payload),
    getConclusion: <T = unknown>(payload?: unknown) =>
      invokeByChannel<T>(METHOD_CHANNELS.getConclusion, payload),
    submitSuggestion: <T = unknown>(payload?: unknown) =>
      invokeByChannel<T>(METHOD_CHANNELS.submitSuggestion, payload),
    askFollowup: <T = unknown>(payload?: unknown) =>
      invokeByChannel<T>(METHOD_CHANNELS.askFollowup, payload),
    exportSuggestion: <T = unknown>(payload?: unknown) =>
      invokeByChannel<T>(METHOD_CHANNELS.exportSuggestion, payload),
    checkNewBatch: <T = unknown>(payload?: unknown) =>
      invokeByChannel<T>(METHOD_CHANNELS.checkNewBatch, payload),
  }
}

export type ReviewDeskService = ReturnType<typeof createReviewDeskBridge>

/** 生产单例：渲染层业务代码统一 import 它，不直接接触 window.reviewDesk。 */
export const bridge = createReviewDeskBridge(defaultInvoke)
