/**
 * 环境变量配置加载（spec.md §5 凭据位）。
 *
 * 全部凭据 MDM_* / LLM_* 只从环境变量读取，缺必填位即抛明确错误并退出，
 * 不得硬编码密钥或用默认值兜底。提供一个零依赖的极简 .env 解析器，
 * 避免为读 .env 引入新依赖（Node 22 也可用 --env-file，二选一即可）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface MdmConfig {
  baseUrl: string
  apiToken: string
  timeoutMs: number
  fieldMapPath: string
}

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
  maxRetries: number
  concurrency: number
}

export interface AppConfig {
  mdm: MdmConfig
  llm: LlmConfig
}

/** 必填凭据位。缺失时逐项报错，绝不静默兜底。 */
export const REQUIRED_KEYS = [
  'MDM_BASE_URL',
  'MDM_API_TOKEN',
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
] as const

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly missing: string[] = [],
  ) {
    super(message)
    this.name = 'ConfigError'
  }
}

function toInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** 极简 .env 解析：忽略 # 注释与空行，值两侧引号剥离，不覆盖已有环境变量。 */
export function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/**
 * 载入配置。env 可注入（测试友好）；若指定 envFile 且进程无对应键则补入。
 * 缺任一必填位抛 ConfigError，message 列出全部缺失项。
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  options: { envFile?: string; strict?: boolean } = {},
): AppConfig {
  let merged: Record<string, string | undefined> = { ...env }
  if (options.envFile && existsSync(options.envFile)) {
    const fileEnv = parseEnvFile(options.envFile)
    merged = { ...fileEnv, ...stripUndefined(env) }
  }

  const missing = REQUIRED_KEYS.filter((key) => !merged[key] || merged[key]!.trim() === '')
  const strict = options.strict ?? true
  if (strict && missing.length > 0) {
    throw new ConfigError(
      `缺少必填凭据位：${missing.join('、')}。请在 .env 或环境变量中补齐（见 .env.example）。`,
      [...missing],
    )
  }

  return {
    mdm: {
      baseUrl: (merged.MDM_BASE_URL ?? '').replace(/\/+$/, ''),
      apiToken: merged.MDM_API_TOKEN ?? '',
      timeoutMs: toInt(merged.MDM_TIMEOUT_MS, 15000),
      fieldMapPath: merged.MDM_FIELD_MAP || './config/mdm-field-map.json',
    },
    llm: {
      baseUrl: (merged.LLM_BASE_URL ?? '').replace(/\/+$/, ''),
      apiKey: merged.LLM_API_KEY ?? '',
      model: merged.LLM_MODEL ?? '',
      timeoutMs: toInt(merged.LLM_TIMEOUT_MS, 30000),
      maxRetries: toInt(merged.LLM_MAX_RETRIES, 1),
      concurrency: toInt(merged.LLM_CONCURRENCY, 4),
    },
  }
}

function stripUndefined(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v
  return out
}

/** 测试配置覆盖：允许只改嵌套对象的个别字段（实现本就是浅合并，类型应对齐）。 */
export interface TestConfigOverrides {
  mdm?: Partial<MdmConfig>
  llm?: Partial<LlmConfig>
}

/** 测试专用配置：带占位凭据，跳过必填校验。 */
export function createTestConfig(overrides: TestConfigOverrides = {}): AppConfig {
  const base = loadConfig({}, { strict: false })
  return {
    mdm: { ...base.mdm, baseUrl: 'http://127.0.0.1:1', apiToken: 'test-token', ...overrides.mdm },
    llm: {
      ...base.llm,
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'test-key',
      model: 'test-model',
      ...overrides.llm,
    },
  }
}

/** 密钥掩码：只记前 4 位与末 2 位，其余以 * 代替。 */
export function maskSecret(secret: string): string {
  if (!secret) return ''
  if (secret.length <= 6) return secret.slice(0, 2) + '****'
  return `${secret.slice(0, 4)}****${secret.slice(-2)}`
}

/** 解析 MDM_FIELD_MAP 路径为绝对路径（相对进程工作目录）。 */
export function resolveFieldMapPath(config: AppConfig): string {
  return resolve(process.cwd(), config.mdm.fieldMapPath)
}
