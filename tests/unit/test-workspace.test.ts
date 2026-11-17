/**
 * 本机 JSON 工作区单测（Task 2 验收文件）。
 *
 * 覆盖 step 5 三项断言：非法 schema → 状态 invalid 且带错误信息；autoHeal 后回到 ok；
 * 工作区读回快照为深克隆（改返回值不影响内部/磁盘）。并覆盖诊断四态
 * ok / missing / invalid / read-error、原子写、appendAudit / appendCallLog 只增。
 * 全部落在系统临时目录，用例结束清理，不污染受控文件清单。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  autoHeal,
  createWorkspace,
  emptyWorkspace,
  WORKSPACE_FILENAME,
  type Workspace,
} from '@main/workspace'
import type { AuditEntry, ModelCallLog, WorkspaceState } from '@core/types'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ws-'))
}

function validAudit(seq: number): AuditEntry {
  return {
    seq,
    ts: '2026-01-01T00:00:00.000Z',
    candidate_id: `CAND-${seq}`,
    action: 'merge',
    target_code: `M-${seq}`,
    evidence: [{ record_id: `MD-${seq}`, field: 'insurance_code', candidate_value: 'XJ1', matched_value: 'XJ1' }],
    model_call_id: `CALL-${seq}`,
    prompt_hash: `hash-${seq}`,
    retrieved_record_ids: [`MD-${seq}`],
    decided_at: '2026-01-01T00:00:00.000Z',
    confirmed_by: 'reviewer',
    writeback_receipt: null,
    prev_hash: '0',
    hash: `h-${seq}`,
    status: 'active',
  }
}

function validCallLog(n: number): ModelCallLog {
  return {
    model_call_id: `CALL-${n}`,
    candidate_id: `CAND-${n}`,
    model: 'test-model',
    base_url: 'http://127.0.0.1:1',
    prompt_hash: `prompt-${n}`,
    input_tokens: 10,
    output_tokens: 5,
    latency_ms: 12,
    finish_reason: 'stop',
    schema_valid: true,
    degraded_reason: null,
    api_key_masked: 'tes****ey',
    created_at: '2026-01-01T00:00:00.000Z',
  }
}

describe('Task 2 工作区诊断四态与 autoHeal', () => {
  it('空目录 → status=missing，state 为空工作区，healed=true', () => {
    const dir = tempDir()
    try {
      const ws = createWorkspace(dir)
      expect(ws.filePath).toBe(join(dir, WORKSPACE_FILENAME))
      const check = ws.check()
      expect(check.status).toBe('missing')
      expect(check.healed).toBe(true)
      expect(check.state.version).toBe(1)
      expect(check.state.audit_chain).toEqual([])
      expect(existsSync(ws.filePath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('合法状态写入后 → status=ok，healed=false，读回逐字段一致', () => {
    const dir = tempDir()
    try {
      const ws = createWorkspace(dir)
      const state = emptyWorkspace('2026-01-01T00:00:00.000Z')
      state.batches['batch-1'] = { total: 2 }
      ws.write(state)
      const check = ws.check()
      expect(check.status).toBe('ok')
      expect(check.healed).toBe(false)
      expect(check.error).toBeUndefined()
      expect(check.state.batches['batch-1']).toEqual({ total: 2 })
      expect(ws.read().version).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非法 schema（version 非 number）→ status=invalid 且带错误信息，state 已被 autoHeal', () => {
    const dir = tempDir()
    try {
      const ws = createWorkspace(dir)
      const broken = { ...emptyWorkspace(), version: 'not-a-number' }
      writeFileSync(ws.filePath, JSON.stringify(broken), 'utf8')
      const check = ws.check()
      expect(check.status).toBe('invalid')
      expect(check.healed).toBe(true)
      expect(typeof check.error).toBe('string')
      expect(check.error).toContain('schema 校验失败')
      expect(check.error).toContain('version')
      // autoHeal 已把非法 version 修回 1，可安全写回。
      expect(check.state.version).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('autoHeal 后回到 ok：把修复态写回磁盘，再次 check 变 ok', () => {
    const dir = tempDir()
    try {
      const ws = createWorkspace(dir)
      const broken = { ...emptyWorkspace(), version: 'bad', call_logs: 'not-array' }
      writeFileSync(ws.filePath, JSON.stringify(broken), 'utf8')
      expect(ws.check().status).toBe('invalid')
      // 用 autoHeal 结果修复并写回（模拟工作区层自愈流程）。
      const healed = autoHeal(broken) as WorkspaceState
      expect(healed.version).toBe(1)
      expect(healed.call_logs).toEqual([])
      ws.write(healed)
      const again = ws.check()
      expect(again.status).toBe('ok')
      expect(again.healed).toBe(false)
      expect(again.state.call_logs).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非法 JSON → status=read-error 且带解析错误，state 回落空工作区', () => {
    const dir = tempDir()
    try {
      const ws = createWorkspace(dir)
      writeFileSync(ws.filePath, '{not json', 'utf8')
      const check = ws.check()
      expect(check.status).toBe('read-error')
      expect(check.healed).toBe(true)
      expect(check.error).toContain('JSON 解析失败')
      expect(check.state.version).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Task 2 工作区只读快照与只增追加', () => {
  it('snapshot 为深克隆：改返回值不影响内部/磁盘状态', () => {
    const dir = tempDir()
    try {
      const ws = createWorkspace(dir)
      const state = emptyWorkspace()
      state.batches['b'] = { nested: { count: 1 } }
      state.audit_chain = [validAudit(1)]
      ws.write(state)

      const snap = ws.snapshot()
      expect(snap.batches['b']).toEqual({ nested: { count: 1 } })
      // 篡改快照的嵌套对象与数组。
      ;(snap.batches['b'] as { nested: { count: number } }).nested.count = 999
      snap.audit_chain[0].candidate_id = 'TAMPERED'
      snap.audit_chain.push(validAudit(2))

      // 再次 snapshot 与 read 都不受影响（snapshot 每次重新读盘并 structuredClone）。
      const snap2 = ws.snapshot()
      expect((snap2.batches['b'] as { nested: { count: number } }).nested.count).toBe(1)
      expect(snap2.audit_chain).toHaveLength(1)
      expect(snap2.audit_chain[0].candidate_id).toBe('CAND-1')
      expect(ws.read().audit_chain).toHaveLength(1)
      const onDisk = JSON.parse(readFileSync(ws.filePath, 'utf8')) as WorkspaceState
      expect(onDisk.audit_chain).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('write 为原子写：落盘文件是合法 JSON 且无残留 .tmp', () => {
    const dir = tempDir()
    try {
      const ws = createWorkspace(dir)
      ws.write(emptyWorkspace('2026-02-02T00:00:00.000Z'))
      expect(existsSync(ws.filePath)).toBe(true)
      expect(existsSync(`${ws.filePath}.tmp`)).toBe(false)
      expect(JSON.parse(readFileSync(ws.filePath, 'utf8')).updated_at).toBe('2026-02-02T00:00:00.000Z')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('appendAudit 只增：两次追加链长递增，旧条目不被改写', () => {
    const dir = tempDir()
    try {
      const ws = createWorkspace(dir)
      ws.appendAudit(validAudit(1))
      ws.appendAudit(validAudit(2))
      const chain = ws.read().audit_chain
      expect(chain.map((e) => e.seq)).toEqual([1, 2])
      expect(chain[0].candidate_id).toBe('CAND-1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('appendCallLog 只增：留痕可累积且审计链不受影响', () => {
    const dir = tempDir()
    try {
      const ws = createWorkspace(dir)
      ws.appendCallLog(validCallLog(1))
      ws.appendCallLog(validCallLog(2))
      const state = ws.read()
      expect(state.call_logs.map((l) => l.model_call_id)).toEqual(['CALL-1', 'CALL-2'])
      expect(state.audit_chain).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
