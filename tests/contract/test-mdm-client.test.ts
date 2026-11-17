/**
 * MDM 三端点正式客户端契约测试（Task 4 / spec.md §5）。
 *
 * 用本地 node:http 替身服务器起随机端口，逐字段断言：
 *   - 方法、路径、Bearer 凭据、Idempotency-Key、body 与 §5 一致；
 *   - 凭据缺失时 createMdmClient 启动即抛 ConfigError；
 *   - 写回回执三态（success / skipped / failed）与 4xx 不重试语义。
 * 替身只在本测试文件内，不进入产品默认路径。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigError, createTestConfig, type AppConfig } from '@shared/config'
import {
  classifyWriteReceipt,
  computeIdempotencyKey,
  createMdmClient,
  type MergeSuggestionBody,
} from '../../src/core/retrieval/mdm-client'

interface CapturedRequest {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: unknown
}

/** 测试替身：记录最近一次请求，按路径分派预设响应。 */
class MdmStub {
  readonly requests: CapturedRequest[] = []
  private responder: (req: IncomingMessage, res: ServerResponse, body: unknown) => void = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  }
  private server: Server | null = null
  baseUrl = ''

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        let body: unknown = undefined
        if (raw) {
          try {
            body = JSON.parse(raw)
          } catch {
            body = raw
          }
        }
        this.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
        this.responder(req, res, body)
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server = null
  }

  respondWith(fn: (req: IncomingMessage, res: ServerResponse, body: unknown) => void): void {
    this.responder = fn
  }

  last(): CapturedRequest {
    return this.requests[this.requests.length - 1]
  }
}

const TOKEN = 'mdt_live_secret_9f3ac1'
const TEST_BODY: MergeSuggestionBody = {
  action: 'merge',
  target_code: 'MD-000147',
  rationale: '商品名映射通用名，医保码唯一命中',
  confidence: 0.92,
  evidence: [
    {
      record_id: 'MD-000147',
      field: 'insurance_code',
      candidate_value: 'XJ7000000000146',
      matched_value: 'XJ7000000000146',
      evidence_mismatch: false, // 规则层附加位，不应进入线上 body
    },
  ],
}

describe('MDM 正式客户端契约（spec.md §5）', () => {
  let stub: MdmStub
  let config: AppConfig

  beforeEach(async () => {
    stub = new MdmStub()
    await stub.start()
    config = createTestConfig()
    config.mdm.baseUrl = stub.baseUrl
    config.mdm.apiToken = TOKEN
    config.mdm.timeoutMs = 3000
  })

  afterEach(async () => {
    await stub.stop()
    vi.restoreAllMocks()
  })

  it('缺少 MDM_API_TOKEN 时 createMdmClient 启动即抛 ConfigError', () => {
    const bad = createTestConfig()
    bad.mdm.apiToken = ''
    expect(() => createMdmClient(bad)).toThrow(ConfigError)
    try {
      createMdmClient(bad)
    } catch (error) {
      expect((error as ConfigError).missing).toContain('MDM_API_TOKEN')
    }
  })

  it('缺少 MDM_BASE_URL 时启动即抛错', () => {
    const bad = createTestConfig()
    bad.mdm.baseUrl = ''
    expect(() => createMdmClient(bad)).toThrow(ConfigError)
  })

  it('getCandidates 逐字段对齐：GET 路径查询串 + Bearer 头', async () => {
    stub.respondWith((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ candidates: [{ candidate_id: 'C-1' }], next_cursor: 'cur-2' }))
    })
    const result = await createMdmClient(config).getCandidates('pending', 'cur-1')
    const req = stub.last()
    expect(req.method).toBe('GET')
    expect(req.url).toBe('/api/v1/master-data-candidates?status=pending&cursor=cur-1')
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.data?.next_cursor).toBe('cur-2')
    expect(result.data?.candidates).toHaveLength(1)
  })

  it('getCandidates 默认 status=pending、cursor 为空', async () => {
    stub.respondWith((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ candidates: [] }))
    })
    await createMdmClient(config).getCandidates()
    expect(stub.last().url).toBe('/api/v1/master-data-candidates?status=pending&cursor=')
  })

  it('getMasterData 逐字段对齐：GET domain/q 查询串 + Bearer 头，中文 q 被正确编码', async () => {
    stub.respondWith((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ records: [{ code: 'MD-1', record_id: 'R1' }] }))
    })
    const result = await createMdmClient(config).getMasterData('drug', '先锋四号')
    const req = stub.last()
    expect(req.method).toBe('GET')
    expect(req.url).toBe(
      `/api/v1/master-data?domain=drug&q=${encodeURIComponent('先锋四号')}`,
    )
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(result.data).toHaveLength(1)
  })

  it('postMergeSuggestion 逐字段对齐：POST 路径 + Bearer + Idempotency-Key + body 五字段', async () => {
    stub.respondWith((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ suggestion_id: 'S-1' }))
    })
    const key = computeIdempotencyKey('CAND-1', TEST_BODY)
    const result = await createMdmClient(config).postMergeSuggestion('CAND-1', TEST_BODY)
    const req = stub.last()
    expect(req.method).toBe('POST')
    expect(req.url).toBe('/api/v1/master-data-candidates/CAND-1/merge-suggestions')
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(req.headers['idempotency-key']).toBe(key)
    expect(req.body).toEqual({
      action: 'merge',
      target_code: 'MD-000147',
      rationale: TEST_BODY.rationale,
      evidence: [
        {
          record_id: 'MD-000147',
          field: 'insurance_code',
          candidate_value: 'XJ7000000000146',
          matched_value: 'XJ7000000000146',
        },
      ],
      confidence: 0.92,
    })
    // 规则层附加位不得外泄到线上 body
    expect((req.body as { evidence: unknown[] }).evidence[0]).not.toHaveProperty('evidence_mismatch')
    expect(result.receipt?.status).toBe('success')
    expect(result.receipt?.idempotency_key).toBe(key)
  })

  it('写建议使用调用方显式传入的 Idempotency-Key', async () => {
    stub.respondWith((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ suggestion_id: 'S-2' }))
    })
    await createMdmClient(config).postMergeSuggestion('CAND-2', TEST_BODY, 'explicit-key-xyz')
    expect(stub.last().headers['idempotency-key']).toBe('explicit-key-xyz')
  })

  it('Idempotency-Key 稳定：同 candidate + 同 body 得同键，body 变则键变', () => {
    const k1 = computeIdempotencyKey('C', TEST_BODY)
    const k2 = computeIdempotencyKey('C', { ...TEST_BODY })
    const k3 = computeIdempotencyKey('C', { ...TEST_BODY, confidence: 0.5 })
    const k4 = computeIdempotencyKey('D', TEST_BODY)
    expect(k1).toBe(k2)
    expect(k1).not.toBe(k3)
    expect(k1).not.toBe(k4)
    expect(k1).toMatch(/^[0-9a-f]{64}$/)
  })

  it('skipped 态一：MDM 返回 409 → receipt.status=skipped', async () => {
    stub.respondWith((_req, res) => {
      res.writeHead(409, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ reason: 'duplicate' }))
    })
    const result = await createMdmClient(config).postMergeSuggestion('CAND-3', TEST_BODY)
    expect(result.ok).toBe(true)
    expect(result.status).toBe(409)
    expect(result.receipt?.status).toBe('skipped')
    expect(result.receipt?.reason).toBe('duplicate')
  })

  it('skipped 态二：MDM 返回 200 + existing 标记 → skipped', async () => {
    stub.respondWith((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ existing: true }))
    })
    const result = await createMdmClient(config).postMergeSuggestion('CAND-4', TEST_BODY)
    expect(result.ok).toBe(true)
    expect(result.receipt?.status).toBe('skipped')
  })

  it('failed 态：4xx 返回结构化失败且不重试（只发一次请求）', async () => {
    let hits = 0
    stub.respondWith((_req, res) => {
      hits += 1
      res.writeHead(422, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: '候选状态不允许写回' }))
    })
    const result = await createMdmClient(config).postMergeSuggestion('CAND-5', TEST_BODY)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('MDM_CLIENT_ERROR')
    expect(result.receipt?.status).toBe('failed')
    expect(result.error).toContain('候选状态不允许写回')
    expect(hits).toBe(1)
  })

  it('读端点非 2xx 返回结构化失败，不抛异常', async () => {
    stub.respondWith((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: '上游不可用' }))
    })
    const result = await createMdmClient(config).getCandidates('pending', '')
    expect(result.ok).toBe(false)
    expect(result.status).toBe(503)
    expect(result.error).toContain('上游不可用')
  })

  it('classifyWriteReceipt 三态分类表', () => {
    expect(classifyWriteReceipt(201, {})).toBe('success')
    expect(classifyWriteReceipt(200, { existing: true })).toBe('skipped')
    expect(classifyWriteReceipt(409, {})).toBe('skipped')
    expect(classifyWriteReceipt(422, {})).toBe('failed')
    expect(classifyWriteReceipt(500, {})).toBe('failed')
  })
})
