/**
 * 运维 CLI 调度器（Task 52 / 53）：doctor / replay / export。
 *
 * 用法：
 *   pnpm doctor --json
 *   pnpm replay --candidate CAND-0001 [--write] [--json] [--out 路径]
 *   pnpm export --in outputs/sample-batch/suggestions.json --out outputs/report [--json]
 *
 * 解析与分发都是纯函数：parseArgs / dispatch 不碰 process.exitCode，也不自动
 * 执行子命令；只有 main() 写 stdout/stderr 并设置退出码。main() 用 isMain 守卫，
 * 测试 import 本模块不会触网、不写盘、不改进程状态。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppConfig } from '../shared/config'
import { loadConfig, parseEnvFile, REQUIRED_KEYS } from '../shared/config'
import { createMdmClient } from '../core/retrieval/mdm-client'
import {
  runDoctor, type DoctorProbe, type DoctorReadFieldMap,
} from './doctor'
import {
  BLOCKED_REPLAY_FETCH, createOfflineConfig, runReplay, replayToText, type ReplayDeps,
} from './replay'
import {
  exportToText, runExport, type ExportDeps, type SuggestionExportRow,
} from './export'

export type CliCommand = 'doctor' | 'replay' | 'export' | 'help' | 'unknown'

export interface CliArgs {
  command: CliCommand
  json: boolean
  write: boolean
  out?: string
  candidate?: string
  input?: string
  envFile?: string
  batch?: string
  raw: string[]
}

export interface DispatchResult {
  exitCode: number
  stdout: string
  stderr: string
  /** --json 时的机器可读 JSON（与 stdout 去掉末尾换行后一致）。 */
  json?: string
}

export type CliOutputWriter = (path: string, content: string) => void

/** 默认文件输出口：仅 main/dispatch 显式带 --out 时调用。 */
export const fileOutputWriter: CliOutputWriter = (path, content) => {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, `${content}\n`, 'utf8')
}

export interface DispatchPorts {
  env?: Record<string, string | undefined>
  now?: () => string
  /** doctor 只读探测端口。 */
  probe?: DoctorProbe
  /** doctor 字段映射读取端口。 */
  readFieldMap?: DoctorReadFieldMap
  /** 模型阶段 fetch 端口。 */
  fetchImpl?: typeof fetch
  /** replay 依赖覆盖（config/corpus/retrieve/evaluate/writer 等）。 */
  replayDeps?: Partial<ReplayDeps>
  /** export 依赖覆盖（writer/out/batchId 等）。 */
  exportDeps?: Partial<ExportDeps>
  /** export 输入行：优先于 --in 读盘，测试用假行。 */
  exportRows?: SuggestionExportRow[]
  /** --in 的读取端口（测试注入，默认读 JSON 文件）。 */
  readExportRows?: (path: string) => SuggestionExportRow[] | Promise<SuggestionExportRow[]>
  /** --out 的写入端口（测试注入，默认写文件）。 */
  writeOutput?: CliOutputWriter
}

export const CLI_USAGE = [
  '用法：',
  '  doctor                              只读体检凭据与端点（--json 输出机器可读报告）',
  '  replay --candidate <id> [--write]   重放单条候选归并（默认只读，--write 需过确认与幂等闸门）',
  '  export --in <建议JSON> --out <路径> 导出归并建议 sheet（JSON / CSV / TXT）',
  '通用参数：--json  --write[=true|false]  --out <路径>  --candidate <id>  --env-file <路径>',
].join('\n')

function stripUndefined(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 解析 process.argv 子集；不读环境变量、不写盘、不设退出码。 */
export function parseArgs(argv: string[]): CliArgs {
  const raw = [...argv]
  const head = argv[0]
  const command: CliCommand =
    head === 'doctor' || head === 'replay' || head === 'export'
      ? head
      : head === undefined || head === '--help' || head === '-h'
        ? 'help'
        : 'unknown'
  const result: CliArgs = { command, json: false, write: false, raw }
  const flags = command === 'doctor' || command === 'replay' || command === 'export'
    ? argv.slice(1)
    : argv

  for (let i = 0; i < flags.length; i += 1) {
    const token = flags[i]
    if (token === '--json') { result.json = true; continue }
    if (token === '--help' || token === '-h') { result.command = 'help'; continue }
    if (token === '--write') {
      const next = flags[i + 1]
      if (next === 'true' || next === 'false') { result.write = next === 'true'; i += 1 } else { result.write = true }
      continue
    }
    if (token.startsWith('--write=')) { result.write = token.slice('--write='.length) === 'true'; continue }

    const eq = token.indexOf('=')
    const name = eq >= 0 ? token.slice(0, eq) : token
    const inline = eq >= 0 ? token.slice(eq + 1) : undefined
    const takeValue = (): string | undefined => {
      if (inline !== undefined) return inline
      const next = flags[i + 1]
      if (next !== undefined && !next.startsWith('--')) { i += 1; return next }
      return undefined
    }
    switch (name) {
      case '--out': result.out = takeValue(); break
      case '--candidate': result.candidate = takeValue(); break
      case '--in': result.input = takeValue(); break
      case '--env-file': result.envFile = takeValue(); break
      case '--batch': result.batch = takeValue(); break
      default: break
    }
  }
  return result
}

/** 默认 --in 读取：接受 JSON 数组或 {suggestions:[...]}。 */
export function readSuggestionRows(path: string): SuggestionExportRow[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const list = Array.isArray(parsed)
    ? parsed
    : isPlainObject(parsed) && Array.isArray(parsed.suggestions)
      ? parsed.suggestions
      : []
  return list as SuggestionExportRow[]
}

interface RuntimeConfig {
  config: AppConfig
  fetchImpl: typeof fetch
  writer: ReplayDeps['writer']
}

/**
 * 运行时配置：凭据齐全才用真实配置 + 真实 fetch + 真实 MDM 写口；
 * 缺凭据时落回占位配置与阻断型 fetch/writer，保证离线零外联、零误写。
 */
function resolveRuntimeConfig(
  env: Record<string, string | undefined>,
  envFile: string | undefined,
  ports: DispatchPorts,
): RuntimeConfig {
  const envFileValues = envFile ? parseEnvFile(envFile) : {}
  const merged = { ...envFileValues, ...stripUndefined(env) }
  const complete = REQUIRED_KEYS.every((key) => (merged[key] ?? '').trim() !== '')
  if (!complete) {
    return {
      config: createOfflineConfig(),
      fetchImpl: ports.fetchImpl ?? BLOCKED_REPLAY_FETCH,
      writer: undefined,
    }
  }
  const config = loadConfig(merged, { strict: true })
  const client = createMdmClient(config)
  return {
    config,
    fetchImpl: ports.fetchImpl ?? globalThis.fetch,
    writer: (candidateId, body, key) => client.postMergeSuggestion(candidateId, body, key),
  }
}

/**
 * 纯分发：返回退出码与输出文本；由 main() 负责真正写 stdout 与设置 exitCode。
 * 退出码：0 正常 / 1 体检或导出被拒 / 2 参数错误。
 */
export async function dispatch(
  args: CliArgs,
  ports: DispatchPorts = {},
): Promise<DispatchResult> {
  const env = ports.env ?? process.env

  if (args.command === 'help') {
    return { exitCode: 0, stdout: `${CLI_USAGE}\n`, stderr: '' }
  }
  if (args.command === 'unknown') {
    return { exitCode: 2, stdout: '', stderr: `未知子命令：${args.raw[0] ?? ''}\n${CLI_USAGE}\n` }
  }

  if (args.command === 'doctor') {
    const result = await runDoctor({
      env,
      envFile: args.envFile,
      now: ports.now,
      probe: ports.probe,
      readFieldMap: ports.readFieldMap,
    })
    const output = args.json ? result.json : result.text
    return { exitCode: result.exitCode, stdout: `${output}\n`, stderr: '', json: result.json }
  }

  if (args.command === 'replay') {
    if (!args.candidate) {
      return { exitCode: 2, stdout: '', stderr: `replay 缺少 --candidate\n${CLI_USAGE}\n` }
    }
    const runtime = resolveRuntimeConfig(env, args.envFile, ports)
    const result = await runReplay(args.candidate, {
      config: runtime.config,
      fetchImpl: runtime.fetchImpl,
      writer: runtime.writer,
      now: ports.now,
      // --write 本身就是显式确认；库调用方仍须显式传 confirmed=true。
      write: args.write,
      confirmed: args.write,
      ...ports.replayDeps,
    })
    const output = args.json ? JSON.stringify(result, null, 2) : replayToText(result)
    if (args.out) (ports.writeOutput ?? fileOutputWriter)(args.out, output)
    const exitCode = !result.found || result.write_result?.status === 'failed' ? 1 : 0
    return { exitCode, stdout: `${output}\n`, stderr: '', json: args.json ? output : undefined }
  }

  // export
  let rows = ports.exportRows
  if (!rows && args.input) {
    const read = ports.readExportRows ?? readSuggestionRows
    rows = await read(args.input)
  }
  const sheetRows = rows ?? []
  const result = await runExport(sheetRows, {
    now: ports.now,
    batchId: args.batch,
    out: args.out,
    ...ports.exportDeps,
  })
  const output = args.json ? (result.json ?? JSON.stringify(result, null, 2)) : exportToText(result)
  const exitCode = result.ok ? 0 : 1
  return { exitCode, stdout: `${output}\n`, stderr: '', json: args.json ? output : undefined }
}

/** 真正的 CLI 入口；写 stdout / stderr 并设 process.exitCode。 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<DispatchResult> {
  const result = await dispatch(parseArgs(argv))
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exitCode = result.exitCode
  return result
}

// 仅作为主模块运行时执行 main（import 进测试时静默）。
const isMain = Boolean(
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url),
)
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`CLI 执行失败：${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  })
}
