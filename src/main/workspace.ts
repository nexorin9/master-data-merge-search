/**
 * 本机 JSON 工作区（spec.md §8 / §10）。
 *
 * 落候选评估状态、建议哈希、回执、追问会话、审计链、模型调用记录。
 * valibot schema 校验：诊断状态 ok / missing / invalid / read-error，非法即
 * 报 invalid 并带错误信息 + autoHeal 修复，不静默吞。
 *
 * 路径默认取 Electron app.getPath('userData')；node 测试环境可注入 baseDir。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { safeParse } from 'valibot'
import { WorkspaceStateSchema } from '../core/schema'
import type { AuditEntry, ModelCallLog, WorkspaceState } from '../core/types'

export const WORKSPACE_FILENAME = 'workspace.json'

export type WorkspaceDiagnostic = 'ok' | 'missing' | 'invalid' | 'read-error'

export interface WorkspaceCheck {
  status: WorkspaceDiagnostic
  state: WorkspaceState
  error?: string
  healed: boolean
}

/** 空工作区默认状态（autoHeal 的修复目标）。 */
export function emptyWorkspace(now = new Date().toISOString()): WorkspaceState {
  return {
    version: 1,
    batches: {},
    suggestions: {},
    receipts: {},
    followups: {},
    call_logs: [],
    audit_chain: [],
    updated_at: now,
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 尽力修复：把缺字段补齐、类型错误的集合退回空值，保留可解析的合法片段。 */
export function autoHeal(raw: unknown, now = new Date().toISOString()): WorkspaceState {
  const base = emptyWorkspace(now)
  if (!isPlainObject(raw)) return base
  const pick = (key: string): Record<string, unknown> =>
    isPlainObject(raw[key]) ? (raw[key] as Record<string, unknown>) : {}
  const pickArray = <T>(key: string): T[] => (Array.isArray(raw[key]) ? (raw[key] as T[]) : [])
  return {
    version: typeof raw.version === 'number' ? raw.version : 1,
    batches: pick('batches'),
    suggestions: pick('suggestions'),
    receipts: pick('receipts'),
    followups: pick('followups'),
    call_logs: pickArray<ModelCallLog>('call_logs'),
    audit_chain: pickArray<AuditEntry>('audit_chain'),
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : now,
  }
}

export interface Workspace {
  readonly filePath: string
  /** 读取并校验；非法时 autoHeal 但返回 status=invalid，不静默。 */
  check(): WorkspaceCheck
  /** 读取当前状态（若不存在或非法，返回 autoHeal 后的状态）。 */
  read(): WorkspaceState
  /** 写回状态（原子写：先临时文件再 rename）。 */
  write(state: WorkspaceState): void
  /** 追加一条审计记录（只增不改）。 */
  appendAudit(entry: AuditEntry): void
  /** 追加一条模型调用留痕。 */
  appendCallLog(log: ModelCallLog): void
  /** 深克隆快照：改返回值不影响内部/磁盘状态。 */
  snapshot(): WorkspaceState
}

export function createWorkspace(baseDir: string): Workspace {
  const filePath = join(baseDir, WORKSPACE_FILENAME)

  function ensureDir(): void {
    const dir = dirname(filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  function load(): WorkspaceCheck {
    if (!existsSync(filePath)) {
      return { status: 'missing', state: emptyWorkspace(), healed: true }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const healed = autoHeal({})
      return { status: 'read-error', state: healed, error: `工作区 JSON 解析失败：${message}`, healed: true }
    }
    const result = safeParse(WorkspaceStateSchema, parsed)
    if (result.success) {
      return { status: 'ok', state: result.output as unknown as WorkspaceState, healed: false }
    }
    const first = result.issues[0]
    const path = first ? `.${(first.path ?? []).map((p) => (typeof p.key === 'string' ? p.key : String(p.key))).join('.')}` : ''
    const message = `工作区 schema 校验失败${path}：${first?.message ?? '形状非法'}`
    // autoHeal 修复但不静默：诊断仍为 invalid，由调用方决定提示用户。
    return { status: 'invalid', state: autoHeal(parsed), error: message, healed: true }
  }

  function write(state: WorkspaceState): void {
    ensureDir()
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, filePath)
  }

  return {
    filePath,
    check: load,
    read(): WorkspaceState {
      const { state } = load()
      return state
    },
    write,
    appendAudit(entry: AuditEntry): void {
      const state = load().state
      state.audit_chain.push(entry)
      state.updated_at = new Date().toISOString()
      write(state)
    },
    appendCallLog(log: ModelCallLog): void {
      const state = load().state
      state.call_logs.push(log)
      state.updated_at = new Date().toISOString()
      write(state)
    },
    snapshot(): WorkspaceState {
      // structuredClone 语义：改返回值不影响内部状态。
      return structuredClone(load().state)
    },
  }
}

/** 默认工作区目录：Electron 用 userData，否则用系统临时目录下的应用子目录。 */
export function defaultWorkspaceBaseDir(): string {
  try {
    // 动态 require 避免在 node 测试环境硬依赖 electron 运行时。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { app?: { getPath(name: string): string } }
    if (electron.app?.getPath) return electron.app.getPath('userData')
  } catch {
    // node 测试环境：electron 不可导入，回落到 tmpdir。
  }
  const { tmpdir } = require('node:os') as typeof import('node:os')
  return join(tmpdir(), 'master-data-merge-search')
}
