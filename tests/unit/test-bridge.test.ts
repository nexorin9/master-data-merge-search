/**
 * 渲染层 bridge 契约测试（node 环境）。
 * 断言：只经白名单通道、未注册通道被拒、入参可结构化克隆、凭据不下发且不回显。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  IPC_CHANNELS,
  isIpcChannel,
  type IpcChannel,
} from '@shared/ipc-contract'
import {
  METHOD_CHANNELS,
  bridge,
  createReviewDeskBridge,
  isCredentialKey,
} from '../../src/renderer/services/bridge'

function makeBridge(response: unknown = { ok: true, data: {} }) {
  const calls: Array<{ channel: IpcChannel; payload: unknown }> = []
  const invoke = vi.fn(
    async (channel: IpcChannel, payload?: unknown): Promise<unknown> => {
      calls.push({ channel, payload })
      return response
    },
  )
  return { service: createReviewDeskBridge(invoke), calls, invoke }
}

describe('渲染层 bridge 白名单契约', () => {
  it('六个业务方法与检查新批次只经白名单通道调用', async () => {
    const { service, calls, invoke } = makeBridge()
    await service.batchList()
    await service.evaluateCandidate({ c: 1 })
    await service.getConclusion({ c: 2 })
    await service.submitSuggestion({ c: 3 })
    await service.askFollowup({ c: 4 })
    await service.exportSuggestion({ c: 5 })
    await service.checkNewBatch()

    expect(invoke).toHaveBeenCalledTimes(7)
    expect(calls.map((call) => call.channel)).toEqual([...Object.values(METHOD_CHANNELS)])
    for (const call of calls) {
      expect(isIpcChannel(call.channel), `${call.channel} 不在白名单`).toBe(true)
      expect(IPC_CHANNELS).toContain(call.channel)
    }
    expect(METHOD_CHANNELS).toMatchObject({
      batchList: 'batch:list',
      evaluateCandidate: 'candidate:evaluate',
      getConclusion: 'conclusion:get',
      submitSuggestion: 'suggestion:submit',
      askFollowup: 'followup:ask',
      exportSuggestion: 'suggestion:export',
      checkNewBatch: 'tray:check-new',
    })
  })

  it('未注册通道被拒绝且不触达 invoke', async () => {
    const { service, invoke } = makeBridge()
    await expect(service.invokeByChannel('fs:read')).rejects.toThrow(/未注册通道/)
    await expect(service.invokeByChannel(123)).rejects.toThrow(/未注册通道/)
    await expect(service.invokeByChannel(undefined)).rejects.toThrow(/未注册通道/)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('凭据字段不下发，幂等键与统计字段不受影响', async () => {
    const { service, calls } = makeBridge()
    await service.batchList({
      candidate_id: 'CAND-X',
      apiKey: 'LEAK-APIKEY',
      apiToken: 'LEAK-APITOKEN',
      MDM_API_TOKEN: 'LEAK-MDM',
      authorization: 'Bearer LEAK-AUTH',
      token: 'LEAK-TOKEN',
      secret: 'LEAK-SECRET',
      idempotency_key: 'CAND-X:merge:YP1',
      input_tokens: 12,
      output_tokens: 34,
    })
    const sent = calls[0]?.payload as Record<string, unknown>
    expect(sent).toEqual({
      candidate_id: 'CAND-X',
      idempotency_key: 'CAND-X:merge:YP1',
      input_tokens: 12,
      output_tokens: 34,
    })
    expect(JSON.stringify(sent)).not.toContain('LEAK')
  })

  it('入参统一转成可结构化克隆的纯数据：剔除函数/循环引用/未定义，Date 转 ISO', async () => {
    const { service, calls } = makeBridge()
    const circular: Record<string, unknown> = { name: 'loop' }
    circular.self = circular
    await service.getConclusion({
      candidate_id: 'CAND-Y',
      fn: () => 1,
      undef: undefined,
      sym: Symbol('s'),
      big: 10n,
      when: new Date('2024-07-01T00:00:00.000Z'),
      nested: circular,
      badNumber: Number.NaN,
    })
    const sent = calls[0]?.payload as Record<string, unknown>
    expect(() => structuredClone(sent)).not.toThrow()
    expect(sent).not.toHaveProperty('fn')
    expect(sent).not.toHaveProperty('undef')
    expect(sent).not.toHaveProperty('sym')
    expect(sent).not.toHaveProperty('big')
    expect(sent.when).toBe('2024-07-01T00:00:00.000Z')
    expect((sent.nested as Record<string, unknown>).self).toBeUndefined()
    expect(sent.badNumber).toBeNull()
  })

  it('返回值剥离凭据字段，不含任何凭据字面量且保留业务数据', async () => {
    const { service } = makeBridge({
      ok: true,
      data: {
        candidate_id: 'CAND-Z',
        apiKey: 'SECRET-1',
        MDM_API_TOKEN: 'SECRET-2',
        authorization: 'Bearer SECRET-3',
        api_key_masked: 'SECRET-4',
        nested: { secret: 'SECRET-5', safe: 'visible' },
      },
    })
    const result = await service.getConclusion<{
      candidate_id: string
      nested: { safe: string }
    }>({ candidate_id: 'CAND-Z' })

    expect(result.ok).toBe(true)
    expect(result.data?.candidate_id).toBe('CAND-Z')
    expect(result.data?.nested.safe).toBe('visible')

    const json = JSON.stringify(result)
    for (const literal of ['SECRET-1', 'SECRET-2', 'SECRET-3', 'SECRET-4', 'SECRET-5']) {
      expect(json, `返回值含凭据字面量 ${literal}`).not.toContain(literal)
    }
    for (const key of ['apiKey', 'MDM_API_TOKEN', 'authorization', 'api_key_masked', 'secret']) {
      expect(json, `返回值含凭据字段 ${key}`).not.toContain(key)
    }
    expect((result.data as unknown as Record<string, unknown>).apiKey).toBeUndefined()
  })

  it('node SSR 无 window 时返回可读的 bridge 未就绪响应，不抛异常', async () => {
    const result = await bridge.batchList()
    expect(result.ok).toBe(false)
    expect(result.code).toBe('BRIDGE_UNAVAILABLE')
    expect(result.message).toContain('本机服务未就绪')
  })

  it('调用不修改原入参对象，传给 invoke 的是独立副本', async () => {
    const { service, calls } = makeBridge()
    const payload = { candidate_id: 'CAND-M', nested: { a: 1, b: [1, 2] } }
    const before = JSON.stringify(payload)
    await service.evaluateCandidate(payload)
    expect(JSON.stringify(payload)).toBe(before)
    expect(calls[0]?.payload).not.toBe(payload)
    expect((calls[0]?.payload as { nested: unknown }).nested).not.toBe(payload.nested)
  })

  it('LocalRpcResponse 形状透传；invoke 异常转可读失败；非对象响应被拒', async () => {
    const { service } = makeBridge({ ok: false, code: 'E_RETRIEVAL', message: '检索失败，请重试' })
    expect(await service.batchList()).toEqual({
      ok: false,
      code: 'E_RETRIEVAL',
      message: '检索失败，请重试',
    })

    const failing = createReviewDeskBridge(async () => {
      throw new Error('boom')
    })
    const failed = await failing.checkNewBatch()
    expect(failed.ok).toBe(false)
    expect(failed.code).toBe('BRIDGE_INVOKE_FAILED')
    expect(failed.message).toBe('boom')

    const { service: badService } = makeBridge('not-an-object')
    const bad = await badService.batchList()
    expect(bad.ok).toBe(false)
    expect(bad.code).toBe('BRIDGE_BAD_RESPONSE')
  })

  it('凭据识别不误杀幂等键与 token 统计字段', () => {
    expect(isCredentialKey('apiKey')).toBe(true)
    expect(isCredentialKey('LLM_API_KEY')).toBe(true)
    expect(isCredentialKey('MDM_API_TOKEN')).toBe(true)
    expect(isCredentialKey('authorization')).toBe(true)
    expect(isCredentialKey('token')).toBe(true)
    expect(isCredentialKey('api_key_masked')).toBe(true)
    expect(isCredentialKey('idempotency_key')).toBe(false)
    expect(isCredentialKey('input_tokens')).toBe(false)
    expect(isCredentialKey('output_tokens')).toBe(false)
    expect(isCredentialKey('candidate_id')).toBe(false)
  })
})
