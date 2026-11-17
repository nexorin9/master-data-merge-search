/**
 * h3 本机服务单测（Task 51）。
 *
 * 真实在 127.0.0.1 起随机端口服务并 fetch，断言：
 *   - 两次 start 返回同一地址（幂等）；stop 后可再 start；
 *   - 七条白名单路由可调用，未注册路由 404 {ok:false,code:NOT_FOUND}；
 *   - handler 异常转结构化错误、message 不含堆栈；
 *   - 来源非回环被拒（注入 resolveRemoteAddress 伪造成公网地址）；
 *   - 返回值凭据剥离。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  channelToPath,
  createLocalServer,
  isLoopbackAddress,
  toSafeMessage,
  type LocalServer,
  type LocalServerHandlers,
} from '../../src/main/local-server'
import { IPC_CHANNELS } from '@shared/ipc-contract'

const servers: LocalServer[] = []

function silent() {
  return { logger: () => {} }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()))
  vi.restoreAllMocks()
})

async function start(handlers: LocalServerHandlers, deps = {}): Promise<LocalServer> {
  const server = createLocalServer(handlers, { ...silent(), ...deps })
  servers.push(server)
  await server.start()
  return server
}

async function postJson(url: string, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

describe('本机 h3 服务', () => {
  it('两次 start 返回同一地址，仅监听 127.0.0.1', async () => {
    const server = await start({})
    const a1 = server.getAddress()!
    const a2 = await server.start()
    expect(a2).toEqual(a1)
    expect(a1.host).toBe('127.0.0.1')
    expect(a1.url).toBe(`http://127.0.0.1:${a1.port}`)
    expect(a1.port).toBeGreaterThan(0)
  })

  it('stop 后可再次 start，地址仍是回环', async () => {
    const server = createLocalServer({}, silent())
    servers.push(server)
    const first = await server.start()
    await server.stop()
    expect(server.getAddress()).toBeNull()
    const second = await server.start()
    expect(second.host).toBe('127.0.0.1')
    expect(second.port).toBeGreaterThan(0)
    expect(second.url).toContain('127.0.0.1')
    void first
  })

  it('七条白名单路由全部可达，调用注入的 handler 拿到结构化结果', async () => {
    const calls: string[] = []
    const handlers: LocalServerHandlers = {}
    for (const channel of IPC_CHANNELS) {
      handlers[channel] = (payload) => {
        calls.push(channel)
        return { channel, received: payload }
      }
    }
    const server = await start(handlers)
    for (const channel of IPC_CHANNELS) {
      const res = await postJson(server.getAddress()!.url, channelToPath(channel), { k: channel })
      expect(res.status).toBe(200)
      expect(res.json.ok).toBe(true)
      expect(res.json.data.channel).toBe(channel)
      expect(res.json.data.received).toEqual({ k: channel })
    }
    expect(calls).toHaveLength(IPC_CHANNELS.length)
  })

  it('未注册路由一律 404 {ok:false,code:NOT_FOUND}', async () => {
    const server = await start({})
    const res = await fetch(`${server.getAddress()!.url}/local/arbitrary/exec`)
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('handler 异常转结构化错误，message 不含堆栈与 at 帧', async () => {
    const server = await start({
      'candidate:evaluate': () => {
        throw new Error('引擎炸了\n    at /secret/path/index.js:88:3\n    at Object.<anonymous>')
      },
    })
    const res = await postJson(server.getAddress()!.url, channelToPath('candidate:evaluate'), {})
    expect(res.status).toBe(500)
    expect(res.json.ok).toBe(false)
    expect(res.json.code).toBe('HANDLER_ERROR')
    expect(res.json.message).toContain('引擎炸了')
    expect(res.json.message).not.toContain('    at ')
    expect(res.json.message).not.toContain('/secret/path')
  })

  it('来源非回环被拒（403 FORBIDDEN），不进入业务 handler', async () => {
    const handler = vi.fn(() => ({ touched: true }))
    const server = await start(
      { 'batch:list': handler },
      { resolveRemoteAddress: () => '203.0.113.9' },
    )
    const res = await postJson(server.getAddress()!.url, channelToPath('batch:list'), {})
    expect(res.status).toBe(403)
    expect(res.json).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('返回值递归剥离凭据键，不回显 token', async () => {
    const server = await start({
      'conclusion:get': () => ({
        ok: true,
        nested: { api_key: 'sk_live_should_not_leak', status: 'ok' },
        authorization: 'Bearer abc',
      }),
    })
    const res = await postJson(server.getAddress()!.url, channelToPath('conclusion:get'), {})
    expect(res.json.ok).toBe(true)
    expect(JSON.stringify(res.json)).not.toContain('sk_live_should_not_leak')
    expect(JSON.stringify(res.json)).not.toContain('Bearer abc')
    expect(res.json.data.nested.status).toBe('ok')
  })

  it('缺失 handler 的通道返回 NO_HANDLER 结构化错误', async () => {
    const server = await start({})
    const res = await postJson(server.getAddress()!.url, channelToPath('suggestion:export'), {})
    expect(res.status).toBe(501)
    expect(res.json).toMatchObject({ ok: false, code: 'NO_HANDLER' })
  })

  it('isLoopbackAddress 识别各种回环与非回环地址', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.255.255.255')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('192.168.1.10')).toBe(false)
    expect(isLoopbackAddress('203.0.113.9')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })

  it('toSafeMessage 去掉 Error 前缀与换行，只留首行', () => {
    expect(toSafeMessage(new Error('引擎不可用\n at stack'))).toBe('引擎不可用')
    expect(toSafeMessage('plain')).toBe('plain')
    expect(toSafeMessage(undefined, '兜底')).toBe('兜底')
  })
})
