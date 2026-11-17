/**
 * 主进程内 h3 本机服务（Task 51）。
 *
 * 设计要点：
 *   - 只监听 127.0.0.1，端口随机（listen(0)），启动后回读实际端口；
 *   - 路由白名单 = IPC_CHANNELS 七条业务通道，一一映射为 h3 路由；未注册一律 404；
 *   - 业务处理函数由主进程注入（handlers 映射），本模块不耦合任何业务逻辑；
 *   - start / stop 用 async-mutex 串行化，幂等：重复 start 返回同一地址；stop 后可再 start；
 *   - 路由内异常统一转 {ok:false, code, message}，message 只留首行、不含堆栈；
 *   - 来源校验：只接受回环地址（127.0.0.0/8、::1、::ffff:127.x），否则 403；
 *   - 出站响应经密钥剥离，绝不把 Authorization / token 字面量回显。
 *
 * h3 v2.0.8 API 说明（已实测）：app 为 H3 实例，路由用 app.all/on/get/post 注册，
 * app.use(handler) 是全局中间件；toNodeListener(app) 适配 node:http createServer。
 */
import type { AddressInfo } from 'node:net'
import { createServer, type Server } from 'node:http'
import { Mutex } from 'async-mutex'
import {
  createApp,
  defineEventHandler,
  getQuery,
  readBody,
  setResponseStatus,
  toNodeListener,
  type H3Event,
} from 'h3'
import { IPC_CHANNELS, type IpcChannel, type LocalRpcResponse } from '../shared/ipc-contract'

/** 单个业务路由的处理函数：入参是已结构化克隆检查的 JSON payload。 */
export type LocalServerHandler = (payload: unknown) => unknown | Promise<unknown>

/** IPC_CHANNELS → 处理函数的映射，由主进程注入，缺失的通道调用时返回 NO_HANDLER。 */
export type LocalServerHandlers = Partial<Record<IpcChannel, LocalServerHandler>>

/** 可注入依赖：解析远端地址（测试可伪造成非回环）、日志（运维排障）。 */
export interface LocalServerDeps {
  /** 读取请求的来源地址；默认从 event.node.req.socket.remoteAddress。 */
  resolveRemoteAddress?: (event: H3Event) => string | undefined
  /** 启动 / 停止日志；默认 console.log，仅打印地址与端口，不含凭据。 */
  logger?: (line: string) => void
}

/** 本机服务对外句柄。 */
export interface LocalServer {
  /** 幂等启动；返回实际监听地址。重复调用返回同一地址。 */
  start(): Promise<LocalServerAddress>
  /** 幂等停止。 */
  stop(): Promise<void>
  /** 当前地址；未启动返回 null。 */
  getAddress(): LocalServerAddress | null
}

export interface LocalServerAddress {
  host: string
  port: number
  /** http://127.0.0.1:{port} */
  url: string
}

/** 通道名 → 路由路径。冒号替换为斜杠，点号保留在段内，形如 /local/batch/list。 */
export function channelToPath(channel: IpcChannel): string {
  return `/local/${channel.replace(':', '/')}`
}

/** 回环地址判定：IPv4 127.0.0.0/8、IPv6 ::1、IPv4-mapped ::ffff:127.x。 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const value = address.trim().toLowerCase()
  // IPv4-mapped IPv6：::ffff:127.0.0.1
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)
  if (mapped) return isLoopbackAddress(mapped[1])
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true
  const ipv4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(value)
  return ipv4 !== null
}

/** 异常 → 不含堆栈的安全首行消息（剥离 "Error:" 前缀、.at 帧、超长截断）。 */
export function toSafeMessage(error: unknown, fallback = '本机服务内部错误'): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const firstLine = raw
    .split(/\r?\n/)[0]
    .replace(/^\s*(?:[\w.]*Error|Error)\s*:\s*/i, '')
    .replace(/\s+at\s+.*$/i, '')
    .trim()
  if (!firstLine) return fallback
  return firstLine.slice(0, 300)
}

/** 从 h3 事件读取原始 Node 请求里的来源地址。 */
function defaultRemoteAddress(event: H3Event): string | undefined {
  const runtime = (event as unknown as {
    runtime?: { node?: { req?: { socket?: { remoteAddress?: string } } } }
    node?: { req?: { socket?: { remoteAddress?: string } } }
  })
  return runtime.runtime?.node?.req?.socket?.remoteAddress ?? runtime.node?.req?.socket?.remoteAddress
}

/** 判定 payload 是否是可结构化克隆的 JSON 值（本机服务来自 HTTP body，天然安全，这里再兜底）。 */
function isClonableJson(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (value instanceof Date) return true
  if (Array.isArray(value)) return value.every(isClonableJson)
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).every(isClonableJson)
  }
  return false
}

/** 递归剥离凭据键，杜绝把 token / api_key 之类回显到响应。 */
function stripCredentials(value: unknown, seen = new Set<object>()): unknown {
  const credential = /api[_-]?key|api[_-]?token|(^|[_-])token($|[_-])|authorization|secret|password|bearer/i
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) {
    const out = value.map((item) => stripCredentials(item, seen))
    seen.delete(value)
    return out
  }
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (credential.test(key)) continue
    out[key] = stripCredentials(item, seen)
  }
  seen.delete(value)
  return out
}

/** 从请求里提取本通道的 JSON payload：POST/PUT/PATCH 读 body，其余读 query。 */
async function extractPayload(event: H3Event): Promise<unknown> {
  const method = (event.req.method ?? 'GET').toUpperCase()
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    const body = await readBody(event)
    return body === undefined ? {} : body
  }
  return getQuery(event)
}

/**
 * 创建本机服务。handlers 决定七条白名单路由各自的业务处理；不注入 handler 的通道
 * 仍注册路由（保证白名单形态一致），调用时返回 NO_HANDLER 结构化错误。
 */
export function createLocalServer(
  handlers: LocalServerHandlers,
  deps: LocalServerDeps = {},
): LocalServer {
  const mutex = new Mutex()
  const resolveRemote = deps.resolveRemoteAddress ?? defaultRemoteAddress
  const logger = deps.logger ?? ((line: string) => console.log(line))
  let server: Server | null = null
  let address: LocalServerAddress | null = null

  function buildApp() {
    const app = createApp()
    for (const channel of IPC_CHANNELS) {
      const path = channelToPath(channel)
      const handler = handlers[channel]
      app.all(
        path,
        defineEventHandler(async (event) => {
          // 来源校验：非本机回环一律拒绝，不进入业务处理。
          if (!isLoopbackAddress(resolveRemote(event))) {
            setResponseStatus(event, 403)
            return { ok: false, code: 'FORBIDDEN', message: '仅接受本机回环地址访问' }
          }
          try {
            const payload = await extractPayload(event)
            if (!isClonableJson(payload)) {
              setResponseStatus(event, 400)
              return { ok: false, code: 'BAD_PAYLOAD', message: '参数不是可结构化克隆的 JSON 值' }
            }
            if (!handler) {
              setResponseStatus(event, 501)
              return { ok: false, code: 'NO_HANDLER', message: `通道 ${channel} 未注册处理函数` }
            }
            const data = await handler(payload)
            const response: LocalRpcResponse = { ok: true, data: stripCredentials(data) }
            return response
          } catch (error) {
            setResponseStatus(event, 500)
            return { ok: false, code: 'HANDLER_ERROR', message: toSafeMessage(error) }
          }
        }),
      )
    }
    // 未注册路由一律 404，不提供任意执行入口。
    app.all(
      '/**',
      defineEventHandler((event) => {
        setResponseStatus(event, 404)
        return { ok: false, code: 'NOT_FOUND', message: '未注册的本机服务路由' }
      }),
    )
    return app
  }

  return {
    async start(): Promise<LocalServerAddress> {
      return mutex.runExclusive(async () => {
        if (server && address) return address
        const instance = createServer(toNodeListener(buildApp()))
        await new Promise<void>((resolve, reject) => {
          instance.once('error', reject)
          instance.listen(0, '127.0.0.1', () => {
            instance.off('error', reject)
            resolve()
          })
        })
        const port = (instance.address() as AddressInfo).port
        server = instance
        address = { host: '127.0.0.1', port, url: `http://127.0.0.1:${port}` }
        // 启动日志只含地址与端口，便于运维排障，不含任何凭据。
        logger(`[local-server] 已启动 ${address.url}（回环监听，${IPC_CHANNELS.length} 条白名单路由）`)
        return address
      })
    },

    async stop(): Promise<void> {
      return mutex.runExclusive(async () => {
        if (!server) return
        const instance = server
        server = null
        address = null
        await new Promise<void>((resolve, reject) => {
          instance.close((error) => (error ? reject(error) : resolve()))
        })
        logger('[local-server] 已停止')
      })
    },

    getAddress(): LocalServerAddress | null {
      return address
    },
  }
}
