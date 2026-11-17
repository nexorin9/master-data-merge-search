/**
 * 主进程 IPC 白名单注册（Task 52）。
 *
 * 契约：
 *   - 只按 IPC_CHANNELS 七条白名单注册 ipcMain.handle，未注册通道在 preload 侧即被拒，
 *     这里再次以 isIpcChannel 兜底，绝不动态转发任意通道；
 *   - 参数只接受可结构化克隆的 JSON 值（含中文与超长字符串），函数 / symbol / bigint /
 *     undefined / NaN / Infinity / 循环引用一律拒绝；
 *   - 返回值递归剥离凭据键（api_key / token / authorization / bearer 等），不下发密钥；
 *   - handler 内异常转 {ok:false, code, message}，message 不含堆栈。
 *
 * 可测性：业务分发与注册逻辑均为纯函数（createIpcDispatcher / registerIpcChannels），
 * electron 的 ipcMain 通过依赖注入传入，node 测试不需要真起 GUI。
 */
import { ipcMain } from 'electron'
import {
  IPC_CHANNELS,
  isIpcChannel,
  type IpcChannel,
  type LocalRpcResponse,
} from '../shared/ipc-contract'

/** 通道处理函数，由主进程注入业务实现。 */
export type IpcHandler = (payload: unknown) => unknown | Promise<unknown>

/** IPC 通道 → 处理函数映射。 */
export type IpcHandlers = Partial<Record<IpcChannel, IpcHandler>>

/** 可注册到 ipcMain.handle 的最小接口（Electron 真实对象满足它）。 */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, payload: unknown) => unknown): void
}

/** 凭据键名特征：命中即整字段剔除（与渲染层 bridge 同口径）。 */
const CREDENTIAL_KEY =
  /api[_-]?key|api[_-]?token|(^|[_-])token($|[_-])|authorization|secret|password|credential|bearer/i

export function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY.test(key)
}

/** 递归剥离凭据键，返回可结构化克隆的纯数据；循环引用以标记串代替。 */
export function stripCredentials(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    if (Array.isArray(value)) {
      const out = value.map((item) => stripCredentials(item, seen))
      seen.delete(value)
      return out
    }
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isCredentialKey(key)) continue
      out[key] = stripCredentials(item, seen)
    }
    seen.delete(value)
    return out
  }
  // function / symbol / bigint / undefined → 不进入响应
  return undefined
}

/**
 * 判定是否为可结构化克隆的 JSON 值。
 * 允许：null / 布尔 / 有限数 / 字符串 / Date / 数组 / 纯对象（递归）。
 * 拒绝：undefined / 函数 / symbol / bigint / NaN / Infinity / 循环引用 / 类实例。
 */
export function isClonableJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (value instanceof Date) return true
  if (typeof value !== 'object') return false // undefined / function / symbol / bigint
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

/** 异常 → 不含堆栈的安全消息。 */
function safeMessage(error: unknown, fallback = 'IPC 处理失败'): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const first = raw.split(/\r?\n/)[0].replace(/^\s*\w*(?:Error)?\s*:\s*/i, '').trim()
  return first ? first.slice(0, 300) : fallback
}

/** 分发一次调用：白名单校验 → 参数校验 → handler → 返回值脱敏 → 结构化结果。 */
export async function dispatchIpc(
  handlers: IpcHandlers,
  channel: unknown,
  payload: unknown,
): Promise<LocalRpcResponse> {
  if (!isIpcChannel(channel)) {
    return {
      ok: false,
      code: 'CHANNEL_REJECTED',
      message: `未注册通道被拒：${String(channel)} 不在白名单中`,
    }
  }
  if (!isClonableJson(payload)) {
    return { ok: false, code: 'BAD_PAYLOAD', message: '参数不是可结构化克隆的 JSON 值' }
  }
  const handler = handlers[channel]
  if (!handler) {
    return { ok: false, code: 'NO_HANDLER', message: `通道 ${channel} 未注册处理函数` }
  }
  try {
    const data = await handler(payload)
    return { ok: true, data: stripCredentials(data) as LocalRpcResponse['data'] }
  } catch (error) {
    return { ok: false, code: 'HANDLER_ERROR', message: safeMessage(error) }
  }
}

/**
 * 按 IPC_CHANNELS 白名单注册 ipcMain.handle；返回实际注册的通道列表。
 * 未注册通道不建立任何 handler（preload 侧亦会拒绝转发）。
 */
export function registerIpcChannels(
  handlers: IpcHandlers,
  main: IpcMainLike = ipcMain,
): IpcChannel[] {
  for (const channel of IPC_CHANNELS) {
    main.handle(channel, (_event: unknown, payload: unknown) => dispatchIpc(handlers, channel, payload))
  }
  return [...IPC_CHANNELS]
}
