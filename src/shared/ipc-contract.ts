/**
 * 渲染层 ↔ 主进程 白名单 IPC 契约（Task 12 / 51 / 52 共用）。
 *
 * preload 只暴露本清单内的 invoke 通道；renderer/services/bridge.ts 只经
 * window.reviewDesk.invoke 调用本清单通道；本机 h3 服务按同清单注册路由。
 * 三处共用同一份常量，杜绝「两处各算一套」。
 */

export const IPC_CHANNELS = [
  'batch:list',
  'candidate:evaluate',
  'conclusion:get',
  'suggestion:submit',
  'followup:ask',
  'suggestion:export',
  'tray:check-new',
] as const

export type IpcChannel = (typeof IPC_CHANNELS)[number]

export function isIpcChannel(value: unknown): value is IpcChannel {
  return typeof value === 'string' && (IPC_CHANNELS as readonly string[]).includes(value)
}

/** preload 暴露给渲染层的 API 形状。 */
export interface ReviewDeskBridge {
  invoke: (channel: IpcChannel, payload?: unknown) => Promise<unknown>
}

declare global {
  interface Window {
    reviewDesk?: ReviewDeskBridge
  }
}

/** 统一响应包（路由内异常一律转此形状，message 不含堆栈）。 */
export interface LocalRpcResponse<T = unknown> {
  ok: boolean
  data?: T
  code?: string
  message?: string
}
