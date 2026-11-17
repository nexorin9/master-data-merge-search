/**
 * IPC 白名单单测（Task 52）。
 *
 * node 环境用 vi.mock('electron') 提供 ipcMain / ipcRenderer / contextBridge 桩，
 * 不真起 GUI。断言：
 *   - 七条白名单通道可调用并拿到结果；非白名单通道被拒（preload 直接抛错）；
 *   - 返回值含凭据时不出现密钥字面量（键剥离 + 字面量替换）；
 *   - 不可克隆参数报错（main dispatcher 与 preload 双端）；
 *   - registerIpcChannels 只注册白名单通道。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// electron 桩：ipcMain.handle 记录注册；ipcRenderer.invoke / contextBridge 供 preload 用。
const registered = new Map<string, (event: unknown, payload: unknown) => unknown>()
const invokeMock = vi.fn(async (_channel: string, _payload: unknown) => ({ ok: true, data: {} }))
const exposeMock = vi.fn()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, payload: unknown) => unknown) => {
      registered.set(channel, listener)
    },
  },
  ipcRenderer: {
    invoke: (channel: string, payload: unknown) => invokeMock(channel, payload),
  },
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => exposeMock(key, api),
  },
}))

import { IPC_CHANNELS, type IpcChannel } from '@shared/ipc-contract'
import {
  dispatchIpc,
  isClonableJson,
  registerIpcChannels,
  stripCredentials,
  type IpcHandlers,
} from '../../src/main/ipc-channels'
import {
  collectEnvironmentSecrets,
  createReviewDeskBridgeApi,
  sanitizeResponse,
} from '../../src/preload/index'

function makeHandlers(value: unknown = { ok: true, data: { items: [1, 2] } }): IpcHandlers {
  const handlers = {} as IpcHandlers
  for (const channel of IPC_CHANNELS) handlers[channel] = () => value
  return handlers
}

beforeEach(() => {
  registered.clear()
  invokeMock.mockClear()
  exposeMock.mockClear()
  invokeMock.mockImplementation(async () => ({ ok: true, data: {} }))
})

describe('主进程 IPC 白名单', () => {
  it('registerIpcChannels 只按白名单注册七条通道', () => {
    const channels = registerIpcChannels(makeHandlers())
    expect(channels).toEqual([...IPC_CHANNELS])
    expect([...registered.keys()]).toEqual([...IPC_CHANNELS])
  })

  it('七条白名单通道均可调用并拿到结果', async () => {
    const payload = { ok: true, data: 'pong' }
    const handlers = makeHandlers(payload)
    for (const channel of IPC_CHANNELS) {
      const res = await dispatchIpc(handlers, channel, { q: '中文' })
      expect(res.ok).toBe(true)
      // dispatcher 把 handler 返回值包进 data（与 LocalRpcResponse 契约一致）
      expect(res.data).toEqual(payload)
    }
  })

  it('非白名单通道被拒（CHANNEL_REJECTED）', async () => {
    const res = await dispatchIpc(makeHandlers(), 'fs:readFile' as unknown as IpcChannel, {})
    expect(res.ok).toBe(false)
    expect(res.code).toBe('CHANNEL_REJECTED')
    expect(res.message).toContain('未注册通道被拒')
  })

  it('不可克隆参数报错（函数 / bigint / 循环引用 / NaN）', async () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    for (const bad of [() => {}, 10n, circular, Number.NaN, undefined]) {
      const res = await dispatchIpc(makeHandlers(), 'batch:list', bad)
      expect(res.ok).toBe(false)
      expect(res.code).toBe('BAD_PAYLOAD')
    }
  })

  it('可克隆值（含中文与超长字符串 / Date）通过校验', () => {
    expect(isClonableJson({ name: '中文', q: 'x'.repeat(100000) })).toBe(true)
    expect(isClonableJson(new Date())).toBe(true)
    expect(isClonableJson([1, 'a', null, { nested: true }])).toBe(true)
  })

  it('返回值含凭据键时不下发密钥字面量', async () => {
    // handler 返回裸业务对象（含凭据），dispatcher 负责包 {ok,data} 并脱敏。
    const handlers = makeHandlers({
      api_key: 'sk_main_secret_123',
      token: 'tk_abc',
      nested: { authorization: 'Bearer zz', keep: 'yes' },
      keep: 1,
    })
    const res = await dispatchIpc(handlers, 'batch:list', {})
    const json = JSON.stringify(res)
    expect(json).not.toContain('sk_main_secret_123')
    expect(json).not.toContain('tk_abc')
    expect(json).not.toContain('Bearer zz')
    expect(json).not.toContain('zz')
    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({ keep: 1, nested: { keep: 'yes' } })
  })

  it('handler 抛错转结构化错误，message 不含堆栈', async () => {
    const handlers = makeHandlers()
    handlers['batch:list'] = () => {
      throw new Error('boom\n at secret.js:1')
    }
    const res = await dispatchIpc(handlers, 'batch:list', {})
    expect(res.ok).toBe(false)
    expect(res.code).toBe('HANDLER_ERROR')
    expect(res.message).not.toContain(' at ')
  })

  it('stripCredentials 循环引用不炸，凭据键整字段剔除', () => {
    const obj: Record<string, any> = { api_token: 'SECRET', safe: 1 }
    obj.self = obj
    const out = stripCredentials(obj) as Record<string, any>
    expect(out).not.toHaveProperty('api_token')
    expect(out.safe).toBe(1)
    expect(out.self).toBe('[Circular]')
  })
})

describe('preload 白名单桥', () => {
  it('暴露的 API 只有 invoke 一个方法', () => {
    const api = createReviewDeskBridgeApi(async () => ({}), [])
    expect(Object.keys(api)).toEqual(['invoke'])
  })

  it('白名单通道可调用：经 transport 转发并拿到结果', async () => {
    invokeMock.mockResolvedValueOnce({ ok: true, data: { list: [1] } })
    const api = createReviewDeskBridgeApi(async (channel, payload) => invokeMock(channel, payload), [])
    const res = await api.invoke('batch:list', { status: 'pending' })
    expect(invokeMock).toHaveBeenCalledWith('batch:list', { status: 'pending' })
    expect(res).toMatchObject({ ok: true, data: { list: [1] } })
  })

  it('非白名单通道直接抛错，不转发到 transport', async () => {
    const transport = vi.fn(async () => ({}))
    const api = createReviewDeskBridgeApi(transport, [])
    await expect(api.invoke('child_process:exec' as never, {})).rejects.toThrow('未注册通道被拒')
    expect(transport).not.toHaveBeenCalled()
  })

  it('不可克隆参数报错，不转发', async () => {
    const transport = vi.fn(async () => ({}))
    const api = createReviewDeskBridgeApi(transport, [])
    const circular: Record<string, unknown> = {}
    circular.self = circular
    for (const bad of [() => {}, Symbol('x'), circular, Number.POSITIVE_INFINITY]) {
      await expect(api.invoke('batch:list', bad)).rejects.toThrow('不可克隆参数')
    }
    expect(transport).not.toHaveBeenCalled()
  })

  it('返回值含凭据时不出现密钥字面量（键剥离 + 已知环境密钥替换）', async () => {
    const SECRET = 'env_live_token_ABCDEFG'
    const transport = vi.fn(async () => ({
      ok: true,
      data: { apiKey: 'sk_should_drop', message: `上游返回包含 ${SECRET}` },
    }))
    const api = createReviewDeskBridgeApi(transport, [SECRET])
    const res = (await api.invoke('conclusion:get', {})) as { data: Record<string, string> }
    const json = JSON.stringify(res)
    expect(json).not.toContain('sk_should_drop')
    expect(json).not.toContain(SECRET)
    expect(res.data.message).toContain('****')
  })

  it('sanitizeResponse 剥离凭据键、替换字符串里的密钥、处理循环引用', () => {
    const out = sanitizeResponse(
      { token: 'LEAK', msg: 'a SECRETKEY b', list: [1, 2], circular: null as any },
      ['SECRETKEY'],
    ) as Record<string, any>
    expect(out).not.toHaveProperty('token')
    expect(out.msg).toBe('a **** b')
    expect(out.list).toEqual([1, 2])
  })

  it('collectEnvironmentSecrets 只收集凭据键名对应的值', () => {
    const secrets = collectEnvironmentSecrets({
      MDM_API_TOKEN: 'tok_12345',
      LLM_API_KEY: 'key_12345',
      NORMAL_VAR: 'not-a-secret',
    })
    expect(secrets).toEqual(expect.arrayContaining(['tok_12345', 'key_12345']))
    expect(secrets).not.toContain('not-a-secret')
  })
})
