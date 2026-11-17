/**
 * 写回退避重试与错误分类（Task 34）。
 *
 * 错误四分类：4xx 不可重试、5xx + 网络可退避重试、幂等跳过不是错误、超时只重试一次。
 * 全部用注入的 sleep（vi.fn）让退避瞬时完成并断言间隔；config 可注入覆盖默认
 * 500ms / factor 2 / maxAttempts 3；可读原因一律中文、无堆栈痕迹。
 */
import { describe, expect, it, vi } from 'vitest'
import type { MdmResult, MergeSuggestionBody } from '@core/retrieval/mdm-client'
import type { EvidenceItem, MergeConclusion } from '@core/types'
import {
  backoffDelayMs,
  classifyWriteResult,
  DEFAULT_BACKOFF,
  readableFailure,
  resolveBackoff,
  retryDecision,
  sanitizeReason,
  type BackoffConfig,
} from '@core/writeback/receipt'
import { writeSuggestion, type WritebackPorts } from '@core/writeback/suggestion-writer'
import { runWritebackBatch, type BatchPorts } from '@core/writeback/batch'

const NOW = '2026-11-10T10:00:00.000Z'
type SinkResult = MdmResult<Record<string, unknown>>

function makeConclusion(over: Partial<MergeConclusion> = {}): MergeConclusion {
  const evidence: EvidenceItem[] = [
    {
      record_id: 'MD-0001',
      field: 'spec',
      candidate_value: '0.25g*12片',
      matched_value: '0.25g*12片',
    },
  ]
  return {
    candidate_id: 'C-1',
    domain: 'drug',
    action: 'merge',
    target_code: 'CODE-0001',
    confidence: 0.9,
    rationale: '规格与医保码一致',
    evidence,
    uncertain_reason: null,
    missing_fields: [],
    degraded: false,
    decided_at: NOW,
    ...over,
  }
}

/** 按序返回预设结果，用尽后重复最后一项。 */
function sequenceSink(results: SinkResult[]) {
  let i = 0
  const fn = vi.fn(
    async (_id: string, _body: MergeSuggestionBody, _key: string): Promise<SinkResult> => {
      const result = results[Math.min(i, results.length - 1)]!
      i += 1
      return result
    },
  )
  return { fn }
}

function makePorts(over: Partial<WritebackPorts> = {}): WritebackPorts {
  return {
    sink: async () => ({ ok: true, status: 201, data: {} }),
    now: () => NOW,
    sleep: async () => {},
    ...over,
  }
}

describe('写回退避重试与错误分类（Task 34）', () => {
  it('4xx 不重试、直接失败，可读原因清晰（403 → 权限不足）', async () => {
    const { fn: sink } = sequenceSink([{ ok: false, status: 403, error: '禁止写入' }])
    const sleep = vi.fn(async (_ms: number) => {})
    const result = await writeSuggestion(
      makeConclusion(),
      makePorts({ sink, sleep }),
      { confirmed: true },
    )
    expect(result.status).toBe('failed')
    expect(result.kind).toBe('client_4xx')
    expect(result.readable_reason).toContain('权限不足')
    expect(result.attempts).toBe(1)
    expect(result.sink_calls).toBe(1)
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('422 → 候选已被 MDM 侧驳回（中文可读原因，不重试）', async () => {
    const { fn: sink } = sequenceSink([{ ok: false, status: 422, error: '候选状态不允许写回' }])
    const result = await writeSuggestion(makeConclusion(), makePorts({ sink }), { confirmed: true })
    expect(result.status).toBe('failed')
    expect(result.readable_reason).toContain('驳回')
    expect(result.attempts).toBe(1)
  })

  it('5xx 退避后重试成功，仅等待一次默认 500ms', async () => {
    const { fn: sink } = sequenceSink([
      { ok: false, status: 503, error: '上游不可用' },
      { ok: true, status: 201, data: {} },
    ])
    const sleep = vi.fn(async (_ms: number) => {})
    const result = await writeSuggestion(makeConclusion(), makePorts({ sink, sleep }), { confirmed: true })
    expect(result.status).toBe('success')
    expect(result.attempts).toBe(2)
    expect(result.sink_calls).toBe(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep.mock.calls[0]![0]).toBe(500)
  })

  it('409 幂等跳过不是错误：不重试、记 skipped、不计失败', async () => {
    const { fn: sink } = sequenceSink([{ ok: true, status: 409, data: { reason: 'duplicate' } }])
    const sleep = vi.fn(async (_ms: number) => {})
    const result = await writeSuggestion(makeConclusion(), makePorts({ sink, sleep }), { confirmed: true })
    expect(result.status).toBe('skipped')
    expect(result.kind).toBe('idempotent_skip')
    expect(result.attempts).toBe(1)
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()

    const conclusions = Array.from({ length: 3 }, (_, i) => makeConclusion({ candidate_id: `C-${i}` }))
    const summary = await runWritebackBatch(
      conclusions,
      { sink: async () => ({ ok: true, status: 409, data: {} }), now: () => NOW },
      { concurrency: 1, confirmed: true },
    )
    expect(summary.succeeded).toBe(0)
    expect(summary.failed).toBe(0)
    expect(summary.skipped).toBe(3)
  })

  it('200 + existing 标记与自带三态 receipt 均归一化为 skipped，不重试', () => {
    expect(classifyWriteResult({ ok: true, status: 200, data: { existing: true } }).status).toBe('skipped')
    expect(classifyWriteResult({
      ok: true,
      status: 200,
      data: {},
      receipt: {
        candidate_id: 'C-1',
        status: 'skipped',
        idempotency_key: 'k',
        created_at: NOW,
      },
    }).kind).toBe('idempotent_skip')
  })

  it('超时只重试一次然后失败（2 次 sink、1 次退避）', async () => {
    const { fn: sink } = sequenceSink([{ ok: false, code: 'MDM_TIMEOUT', error: '请求超时（15000ms）' }])
    const sleep = vi.fn(async (_ms: number) => {})
    const result = await writeSuggestion(makeConclusion(), makePorts({ sink, sleep }), { confirmed: true })
    expect(result.status).toBe('failed')
    expect(result.kind).toBe('timeout')
    expect(result.readable_reason).toContain('超时')
    expect(result.attempts).toBe(2)
    expect(sink).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep.mock.calls[0]![0]).toBe(500)
  })

  it('网络错误可退避重试（首次失败后成功）', async () => {
    const { fn: sink } = sequenceSink([
      { ok: false, code: 'MDM_NETWORK', error: '网络错误：ECONNRESET' },
      { ok: true, status: 201, data: {} },
    ])
    const sleep = vi.fn(async (_ms: number) => {})
    const result = await writeSuggestion(makeConclusion(), makePorts({ sink, sleep }), { confirmed: true })
    expect(result.status).toBe('success')
    expect(result.failure_kind).toBeUndefined()
    expect(result.attempts).toBe(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('退避间隔严格遵循注入 config（initial=100 / factor=3 / max=4）', async () => {
    const config: BackoffConfig = { backoffInitialMs: 100, backoffFactor: 3, maxAttempts: 4 }
    const { fn: sink } = sequenceSink([{ ok: false, status: 500, error: '上游错误' }])
    const sleep = vi.fn(async (_ms: number) => {})
    const result = await writeSuggestion(
      makeConclusion(),
      makePorts({ sink, sleep, config }),
      { confirmed: true },
    )
    expect(result.status).toBe('failed')
    expect(sink).toHaveBeenCalledTimes(4)
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 300, 900])
    expect(resolveBackoff(config)).toEqual(config)
    expect(backoffDelayMs(1, config)).toBe(100)
    expect(backoffDelayMs(2, config)).toBe(300)
  })

  it('maxAttempts 尊重默认上限 3：三次尝试、两次退避后失败', async () => {
    const { fn: sink } = sequenceSink([{ ok: false, status: 502, error: '网关错误' }])
    const sleep = vi.fn(async (_ms: number) => {})
    const result = await writeSuggestion(makeConclusion(), makePorts({ sink, sleep }), { confirmed: true })
    expect(result.status).toBe('failed')
    expect(result.kind).toBe('server_5xx')
    expect(result.attempts).toBe(DEFAULT_BACKOFF.maxAttempts)
    expect(sink).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000])
    expect(retryDecision({ status: 'failed', kind: 'server_5xx', retryable: true }, 3, DEFAULT_BACKOFF).action).toBe('stop')
  })

  it('可读原因为中文且绝不含堆栈 / 文件行号', () => {
    const dirty = 'Error: boom\n    at foo (/repo/src/x.ts:9:9)\n  at bar'
    expect(sanitizeReason(dirty)).not.toMatch(/at\s+\S|\.ts:|\.js:|node_modules/)
    expect(readableFailure('client_4xx', 422, dirty)).not.toMatch(/at\s+\S|\.ts:|\.js:|node_modules/)
    expect(readableFailure('server_5xx', 500, dirty)).toContain('MDM 服务暂不可用')
    expect(readableFailure('network')).toContain('网络')
  })

  it('三态 receipt 自带的脏可读原因被丢弃，按分类重建干净中文原因', async () => {
    const dirty = '写回失败：Error: boom\n at foo (x.ts:1:1)'
    const sink = vi.fn(async (): Promise<SinkResult> => ({
      ok: false,
      status: 400,
      error: 'bad request',
      receipt: {
        candidate_id: 'C-1',
        status: 'failed',
        idempotency_key: 'k',
        reason: dirty,
        readable_reason: dirty,
        created_at: NOW,
      },
    }))
    const result = await writeSuggestion(makeConclusion(), makePorts({ sink }), { confirmed: true })
    expect(result.status).toBe('failed')
    expect(result.readable_reason).not.toMatch(/at\s+\S|\.ts:|\.js:|node_modules/)
    expect(result.readable_reason).toContain('MDM 拒绝写回')
    expect(result.reason ?? '').not.toMatch(/\.ts:|Error:|at\s+\S/)
  })
})
