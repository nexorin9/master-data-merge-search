/**
 * preload 白名单桥（Task 52 / 契约 ipc-contract.ts）。
 *
 * 只向渲染层暴露 window.reviewDesk.invoke —— 对齐 ReviewDeskBridge：
 *   - 未注册通道直接抛错（异步拒绝），不静默返回 undefined、不转发任意通道；
 *   - 参数只接受可结构化克隆的 JSON 值（含中文与超长字符串），函数 / symbol /
 *     bigint / undefined / NaN / Infinity / 循环引用 / 类实例一律报错；
 *   - 返回值递归剥离凭据键，并把环境里的密钥字面量替换为 ****，绝不下发密钥；
 *   - 不暴露 fs / path / child_process / 任意 ipcRenderer 能力。
 *
 * 可测性：createReviewDeskBridgeApi 接受可注入的 transport 与 secrets，node 测试
 * 用 vi.mock('electron') 提供桩即可，不真起 Electron 窗口。
 */
import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_CHANNELS,
  isIpcChannel,
  type IpcChannel,
  type ReviewDeskBridge,
} from '../shared/ipc-contract'

/** 传输函数：真实环境走 ipcRenderer.invoke，测试注入假的。 */
export type InvokeTransport = (channel: string, payload: unknown) => Promise<unknown>

/** 凭据键名特征，命中即整字段剔除。 */
const CREDENTIAL_KEY =
  /api[_-]?key|api[_-]?token|(^|[_-])token($|[_-])|authorization|secret|password|credential|bearer/i

export function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY.test(key)
}

/** 可结构化克隆的 JSON 值判定（与 main/ipc-channels 同口径，preload 独立一份以隔离打包）。 */
export function isClonableJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (value instanceof Date) return true
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  try {
    const proto = Object.getPrototypeOf(value)
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return false
    for (const item of Object.values(value as Record<string, unknown>)) {
      if (!isClonableJson(item, seen)) return false
    }
    return true
  } finally {
    seen.delete(value)
  }
}

/** 收集环境中的密钥字面量，用于替换返回值里可能嵌入的密钥文本。 */
export function collectEnvironmentSecrets(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return Object.entries(env)
    .filter(([key, value]) => CREDENTIAL_KEY.test(key) && !!value && value.length >= 3)
    .map(([, value]) => value as string)
}

/**
 * 返回值脱敏：凭据键整字段剔除；其余字符串里出现的密钥字面量替换为 ****。
 * 循环引用与不可克隆值以标记串代替，保证交给渲染层的一定可结构化克隆。
 */
export function sanitizeResponse(
  value: unknown,
  secrets: readonly string[],
  seen = new Set<object>(),
): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    let out = value
    for (const secret of secrets) {
      if (secret) out = out.split(secret).join('****')
    }
    return out
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    if (Array.isArray(value)) {
      const out = value.map((item) => sanitizeResponse(item, secrets, seen))
      seen.delete(value)
      return out
    }
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isCredentialKey(key)) continue
      out[key] = sanitizeResponse(item, secrets, seen)
    }
    seen.delete(value)
    return out
  }
  return undefined
}

export interface ReviewDeskApi {
  invoke: (channel: unknown, payload?: unknown) => Promise<unknown>
}

/**
 * 创建暴露给渲染层的 API。transport 默认走 ipcRenderer.invoke（对齐 preload 通道转发）；
 * secrets 默认取环境变量里的密钥字面量，测试可注入。
 */
export function createReviewDeskBridgeApi(
  transport: InvokeTransport = (channel, payload) => ipcRenderer.invoke(channel, payload),
  secrets: readonly string[] = collectEnvironmentSecrets(),
): ReviewDeskApi {
  const invoke = async (channel: unknown, payload?: unknown): Promise<unknown> => {
    if (!isIpcChannel(channel)) {
      throw new Error(
        `未注册通道被拒：${String(channel)} 不在白名单 ${IPC_CHANNELS.join(', ')} 中`,
      )
    }
    if (payload !== undefined && !isClonableJson(payload)) {
      throw new Error('不可克隆参数：invoke 只接受可结构化克隆的 JSON 值')
    }
    const raw = await transport(channel as IpcChannel, payload ?? {})
    return sanitizeResponse(raw, secrets)
  }
  return { invoke }
}

/** 生产单例：仅暴露 invoke 一个方法，不含任何 Node 能力；类型对齐 ReviewDeskBridge。 */
export const reviewDeskApi: ReviewDeskBridge = createReviewDeskBridgeApi()

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('reviewDesk', reviewDeskApi)
} else {
  Object.defineProperty(globalThis, 'reviewDesk', { value: reviewDeskApi, configurable: true })
}
