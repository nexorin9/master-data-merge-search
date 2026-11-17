/**
 * 运维 CLI · doctor（只读凭据 + 端点体检，Task 52）。
 *
 * 纪律（硬）：
 *   1. 全程只读：4 个探测（3 个 MDM 端点 + 1 个模型端点）**一律 GET**，
 *      绝不 POST/PUT/PATCH/DELETE，绝不发送任何业务数据；
 *   2. 第 3 个 MDM 端点就是写建议端点，doctor 只对它做 GET 可达性探测，
 *      路径里的 candidate id 是固定占位符 __doctor_readonly_probe__，
 *      期望 HTTP 405（Method Not Allowed）反而证明路由存在；
 *   3. 模型 /v1/chat/completions 标准做法是 POST，doctor 仍用 GET 做只读
 *      可达性探测；405 视为「端点可达」，但结构化输出能力无法由只读 GET
 *      证明，结论里明确标注需实跑模型确认；
 *   4. 网络出口是注入端口 probe(url, init)，测试永不触网；默认实现用 Node
 *      全局 fetch，仅在 CLI 真实运行时调用；
 *   5. 所有输出（含 JSON）只含掩码后的密钥，绝不回显完整令牌/密钥。
 *
 * 失败分类固定五类，每类附一条可执行的中文建议：
 *   凭据缺失 / 端点不可达 / 认证失败 / 字段映射文件缺失或格式错 /
 *   模型端点不支持结构化输出。
 */
import { readFileSync } from 'node:fs'
import type { AppConfig } from '../shared/config'
import {
  loadConfig, maskSecret, parseEnvFile, REQUIRED_KEYS, resolveFieldMapPath,
} from '../shared/config'
import {
  assertMapCovers, REQUIRED_CANDIDATE_FIELDS, REQUIRED_MASTERDATA_FIELDS,
} from '../core/retrieval/field-map'
import type { FieldMap } from '../core/types'

/** 探测用途标记：固定占位候选 id，绝非业务数据。 */
export const DOCTOR_PROBE_SENTINEL = '__doctor_readonly_probe__'

/** 注入的只读探测端口。method 被类型锁死为 GET。 */
export interface DoctorProbeInit extends Pick<RequestInit, 'method' | 'headers' | 'signal'> {
  method: 'GET'
}

export interface DoctorProbeResult {
  status?: number
  latency_ms: number
  error?: string
}

export type DoctorProbe = (url: string, init: DoctorProbeInit) => Promise<DoctorProbeResult>

/** 字段映射读取端口：返回文件原文，抛错即视为缺失/不可读。 */
export type DoctorReadFieldMap = (path: string) => string

export interface DoctorDeps {
  /** 环境变量（缺省 process.env）。 */
  env?: Record<string, string | undefined>
  /** 已预解析的 .env 值，优先级低于 env。 */
  envFileValues?: Record<string, string>
  /** .env 文件路径；给出时用 config.parseEnvFile 预解析，不给则不读盘。 */
  envFile?: string
  /** 已构造好的配置（给出时跳过 loadConfig）。 */
  config?: AppConfig
  /** 固定时钟，用于 JSON 的 generated_at。 */
  now?: () => string
  /** 只读探测端口（测试必注入）。 */
  probe?: DoctorProbe
  /** 探测超时（毫秒），默认取配置中的 timeoutMs。 */
  probeTimeoutMs?: number
  /** 字段映射读取端口（测试必注入）。 */
  readFieldMap?: DoctorReadFieldMap
  /** 覆盖字段映射路径（测试可指向 tmpdir 的不存在文件）。 */
  fieldMapPath?: string
}

/** 五种必须修复项，代码即中文分类名。 */
export type DoctorIssueCode =
  | '凭据缺失'
  | '端点不可达'
  | '认证失败'
  | '字段映射文件缺失或格式错'
  | '模型端点不支持结构化输出'

/** 每类一个可执行的中文建议。 */
export const DOCTOR_SUGGESTIONS: Record<DoctorIssueCode, string> = {
  凭据缺失: '请在 .env 或环境变量中逐项补齐缺失的凭据位（见 .env.example），再重新运行 doctor。',
  端点不可达: '检查 MDM_BASE_URL / LLM_BASE_URL 是否正确、服务是否已启动，以及 MDM_TIMEOUT_MS / LLM_TIMEOUT_MS 超时设置。',
  认证失败: '请确认访问令牌/密钥（MDM_API_TOKEN / LLM_API_KEY）未过期且具备读取权限，更新 .env 后重跑 doctor。',
  字段映射文件缺失或格式错: '检查 MDM_FIELD_MAP 指向的文件是否存在、是否为合法 JSON，并覆盖候选/主数据必需内部字段（candidate_id/domain/name/code/record_id/status）。',
  模型端点不支持结构化输出: '确认 LLM_BASE_URL 指向 OpenAI 兼容的 /v1/chat/completions 且 LLM_MODEL 支持 response_format=json_schema；否则引擎会降级为 json_object 并本地校验。',
}

export interface DoctorIssue {
  code: DoctorIssueCode
  severity: 'must-fix'
  item: string
  message: string
  suggestion: string
}

export interface DoctorCheck {
  id: string
  kind: 'credential' | 'endpoint' | 'field_map'
  name: string
  ok: boolean
  /** 逐项中文结论。 */
  conclusion: string
  /** 中文来源说明。 */
  source: string
  /** 基础地址缺失时跳过探测（不重复计入 issue）。 */
  skipped?: boolean
  /** 凭据项：非密钥原值 / 密钥掩码值；绝不回显完整密钥。 */
  display_value?: string
  /** 端点项：只读探测的请求信息。 */
  url?: string
  method?: 'GET'
  status?: number
  latency_ms?: number
  error?: string
  classification?: DoctorIssueCode
  note?: string
}

export interface DoctorResult {
  command: 'doctor'
  ok: boolean
  exitCode: number
  generated_at: string
  checks: DoctorCheck[]
  issues: DoctorIssue[]
  issue_count: number
  summary: string
  /** 机器可读 JSON（--json 直接输出）。 */
  json: string
  /** 人类可读中文结论。 */
  text: string
  /** 与 json 字段等价；便于测试 JSON.parse(result.toJson())。 */
  toJson: () => string
}

interface EndpointSpec {
  id: string
  label: string
  /** 'mdm' 用 mdm.baseUrl + apiToken，'llm' 用 llm.baseUrl + apiKey。 */
  side: 'mdm' | 'llm'
  buildUrl: (base: string) => string
  isModel?: boolean
  note?: string
}

/** 4 个只读探测点：3 个 MDM 端点（含写端点，但只 GET）+ 1 个模型端点。 */
export const DOCTOR_ENDPOINTS: readonly EndpointSpec[] = [
  {
    id: 'mdm-candidates',
    label: 'MDM 候选列表端点',
    side: 'mdm',
    buildUrl: (base) => `${base}/api/v1/master-data-candidates?status=pending&cursor=`,
  },
  {
    id: 'mdm-master-data',
    label: 'MDM 主数据查询端点',
    side: 'mdm',
    buildUrl: (base) =>
      `${base}/api/v1/master-data?domain=drug&q=${encodeURIComponent(DOCTOR_PROBE_SENTINEL)}`,
  },
  {
    id: 'mdm-merge-suggestions',
    label: 'MDM 归并建议写端点（仅只读探测）',
    side: 'mdm',
    buildUrl: (base) =>
      `${base}/api/v1/master-data-candidates/${DOCTOR_PROBE_SENTINEL}/merge-suggestions`,
    note: '该端点是写建议端点；doctor 只用 GET 探测可达性，不发送业务数据、不做任何写入，405 表示路由存在且写方法被正确限制。',
  },
  {
    id: 'model-chat-completions',
    label: '模型对话完成端点（仅只读探测）',
    side: 'llm',
    isModel: true,
    buildUrl: (base) => `${base}/v1/chat/completions`,
    note: '标准 chat/completions 只接受 POST；doctor 用 GET 做只读可达性探测，405 视为可达，但结构化输出能力需实跑模型确认。',
  },
]

/** 摘要截断：不回显长错误体，也不让堆栈进报告。 */
function brief(text: string, max = 200): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stripUndefined(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v
  return out
}

/** 密钥位只用掩码展示，URL / 模型名可直接展示。 */
const SECRET_KEYS = new Set<string>(['MDM_API_TOKEN', 'LLM_API_KEY'])

function displayValue(key: string, raw: string): string {
  return SECRET_KEYS.has(key) ? maskSecret(raw) : raw
}

/** 默认探测实现：只在真实 CLI 运行；读状态不读包体，天然不写。 */
export const fetchDoctorProbe: DoctorProbe = async (url, init) => {
  const started = Date.now()
  try {
    const response = await fetch(url, init)
    return { status: response.status, latency_ms: Date.now() - started }
  } catch (err) {
    return {
      status: 0,
      latency_ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

interface ProbeVerdict {
  ok: boolean
  classification?: DoctorIssueCode
  note?: string
}

/** 失败分类：401/403 优先，模型端点 404 或错误体提到 schema → 结构化输出不支持。 */
export function classifyDoctorProbe(
  spec: EndpointSpec,
  result: DoctorProbeResult,
): ProbeVerdict {
  const status = result.status ?? 0
  const error = result.error ? brief(result.error) : undefined
  const noStatus = !Number.isFinite(status) || status <= 0
  if (noStatus) {
    return { ok: false, classification: '端点不可达', note: error ? `网络/超时：${error}` : '端点不可达（无 HTTP 状态）' }
  }
  if (status === 401 || status === 403) {
    return { ok: false, classification: '认证失败', note: `HTTP ${status}：令牌/密钥被拒绝` }
  }
  const schemaHint = /json_schema|response_format|structured[ _-]?output|不支持结构化/i.test(error ?? '')
  if (spec.isModel && (status === 404 || schemaHint)) {
    return {
      ok: false,
      classification: '模型端点不支持结构化输出',
      note: status === 404 ? 'HTTP 404：模型路径不存在或该模型未提供结构化输出能力' : `HTTP ${status}：${error}`,
    }
  }
  if ((status >= 200 && status < 300) || status === 405) {
    const note = status === 405
      ? 'HTTP 405：只读 GET 被拒绝，说明端点可达；写/结构化输出能力未被只读探测验证'
      : `HTTP ${status}：只读探测成功`
    return { ok: true, note: [spec.note, note].filter(Boolean).join(' ') }
  }
  return {
    ok: false,
    classification: '端点不可达',
    note: [spec.note, `HTTP ${status}：${error ?? '端点返回不可健康状态'}`].filter(Boolean).join(' '),
  }
}

function issueOf(code: DoctorIssueCode, item: string, message: string): DoctorIssue {
  return { code, severity: 'must-fix', item, message: brief(message, 300), suggestion: DOCTOR_SUGGESTIONS[code] }
}

/** 解析并自检字段映射（复用 field-map 的覆盖断言，读取口由 deps 注入）。 */
function checkFieldMap(
  config: AppConfig,
  deps: DoctorDeps,
): { ok: boolean; conclusion: string; source: string; detail?: string } {
  const path = deps.fieldMapPath ?? resolveFieldMapPath(config)
  const source = `来自配置 MDM_FIELD_MAP（解析后路径：${path}）`
  const read = deps.readFieldMap ?? ((p: string) => readFileSync(p, 'utf8'))
  try {
    const raw = read(path)
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      return {
        ok: false,
        conclusion: '字段映射文件不可用：不是合法 JSON',
        source,
        detail: `JSON 格式错误：${err instanceof Error ? err.message : String(err)}`,
      }
    }
    if (!isPlainObject(parsed)) {
      return { ok: false, conclusion: '字段映射文件不可用：根节点不是对象', source, detail: 'JSON 根节点必须是「院内字段名 → 内部字段名」对象' }
    }
    const map: FieldMap = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (key.startsWith('$') || typeof value !== 'string') continue
      map[key] = value
    }
    assertMapCovers(map, REQUIRED_CANDIDATE_FIELDS, '候选字段映射')
    assertMapCovers(map, REQUIRED_MASTERDATA_FIELDS, '主数据字段映射')
    return { ok: true, conclusion: '字段映射文件存在且为合法 JSON，必需内部字段均已覆盖', source }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const missing = /不存在|ENOENT|no such file/i.test(message)
    const detail = missing ? `文件缺失：${message}` : `必需字段映射缺失或格式错：${message}`
    return { ok: false, conclusion: `字段映射文件不可用：${brief(detail, 120)}`, source, detail }
  }
}

function humanText(result: Omit<DoctorResult, 'json' | 'toJson' | 'text'>): string {
  const lines: string[] = [`doctor 体检结论：${result.ok ? '健康' : '不健康'}（${result.generated_at}）`, '凭据位：']
  for (const check of result.checks.filter((c) => c.kind === 'credential')) {
    lines.push(`  - ${check.name}：${check.conclusion}；${check.source}`)
  }
  lines.push('端点只读探测：')
  for (const check of result.checks.filter((c) => c.kind === 'endpoint')) {
    const detail = check.skipped
      ? '已跳过'
      : `HTTP ${check.status ?? '—'} / ${check.latency_ms ?? 0}ms${check.error ? ` / ${check.error}` : ''}`
    lines.push(`  - ${check.name}：${detail}；${check.conclusion}${check.note ? `；${check.note}` : ''}`)
  }
  const field = result.checks.find((c) => c.kind === 'field_map')
  if (field) lines.push(`字段映射：${field.conclusion}；${field.source}`)
  lines.push(result.summary)
  for (const issue of result.issues) {
    lines.push(`  - [${issue.code}] ${issue.item}：${issue.message}`)
    lines.push(`    建议：${issue.suggestion}`)
  }
  return lines.join('\n')
}

/**
 * 纯函数式体检：所有配置、探测、读盘口、时钟均由 deps 注入。
 * 返回 ok / checks / issues / exitCode，并自带 JSON 与中文文本两种视图。
 */
export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorResult> {
  const now = deps.now ?? (() => new Date().toISOString())
  const generatedAt = now()
  const env = deps.env ?? process.env
  const envFileValues = deps.envFile
    ? parseEnvFile(deps.envFile)
    : (deps.envFileValues ?? {})
  const merged: Record<string, string | undefined> = { ...envFileValues, ...stripUndefined(env) }
  const config = deps.config ?? loadConfig(merged, { strict: false })
  const probe = deps.probe ?? fetchDoctorProbe
  const checks: DoctorCheck[] = []
  const issues: DoctorIssue[] = []

  // 1) 逐个凭据位检查（缺失项一条一条列，不合并）。
  for (const key of REQUIRED_KEYS) {
    const raw = merged[key] ?? ''
    const present = raw.trim() !== ''
    const fromEnv = (env[key] ?? '').trim() !== ''
    const source = present
      ? `来源：${fromEnv ? '环境变量' : '.env 文件'}（${displayValue(key, raw)}）`
      : '来源：未设置（环境变量与 .env 文件均未找到）'
    checks.push({
      id: `credential:${key}`,
      kind: 'credential',
      name: key,
      ok: present,
      conclusion: present ? '已设置' : '缺失',
      source,
      display_value: present ? displayValue(key, raw) : '',
    })
    if (!present) {
      issues.push(issueOf('凭据缺失', key, `必填凭据位 ${key} 未设置，无法完成体检或后续运行`))
    }
  }

  // 2) 4 个只读端点探测：统一 GET，绝不写入。
  for (const spec of DOCTOR_ENDPOINTS) {
    const base = spec.side === 'mdm' ? config.mdm.baseUrl : config.llm.baseUrl
    const token = spec.side === 'mdm' ? config.mdm.apiToken : config.llm.apiKey
    const checkId = `endpoint:${spec.id}`
    if (!base || base.trim() === '') {
      checks.push({
        id: checkId,
        kind: 'endpoint',
        name: spec.label,
        ok: false,
        skipped: true,
        conclusion: '基础地址缺失，已跳过只读探测（见凭据缺失项）',
        source: spec.side === 'mdm' ? '来自配置 MDM_BASE_URL' : '来自配置 LLM_BASE_URL',
        method: 'GET',
        note: spec.note,
      })
      continue
    }
    const url = spec.buildUrl(base)
    const init: DoctorProbeInit = {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(deps.probeTimeoutMs ?? (spec.side === 'mdm' ? config.mdm.timeoutMs : config.llm.timeoutMs)),
    }
    let result: DoctorProbeResult
    try {
      result = await probe(url, init)
    } catch (err) {
      result = { status: 0, latency_ms: 0, error: err instanceof Error ? err.message : String(err) }
    }
    const verdict = classifyDoctorProbe(spec, result)
    const error = result.error ? brief(result.error) : undefined
    checks.push({
      id: checkId,
      kind: 'endpoint',
      name: spec.label,
      ok: verdict.ok,
      conclusion: verdict.ok ? '端点可达' : `不可用：${verdict.classification ?? '端点不可达'}`,
      source: `只读探测 ${init.method} ${url}（Authorization 头仅携带注入配置的掩码值 ${maskSecret(token)}）`,
      url,
      method: 'GET',
      status: result.status,
      latency_ms: result.latency_ms,
      error,
      classification: verdict.classification,
      note: verdict.note ?? spec.note,
    })
    if (!verdict.ok && verdict.classification) {
      issues.push(issueOf(
        verdict.classification,
        spec.label,
        `${spec.label}（${url}）探测失败：${verdict.note ?? error ?? '未知错误'}`,
      ))
    }
  }

  // 3) 字段映射文件：复用 field-map 的覆盖自检，读取口注入。
  const field = checkFieldMap(config, deps)
  checks.push({
    id: 'field_map',
    kind: 'field_map',
    name: '字段映射文件',
    ok: field.ok,
    conclusion: field.conclusion,
    source: field.source,
  })
  if (!field.ok) {
    issues.push(issueOf('字段映射文件缺失或格式错', 'MDM_FIELD_MAP', field.detail ?? field.conclusion))
  }

  const ok = issues.length === 0
  const exitCode = ok ? 0 : 1
  const summary = ok
    ? '结论：全部凭据、只读端点与字段映射均健康，无必须修复项。'
    : `结论：不健康，共 ${issues.length} 项必须修复（${[...new Set(issues.map((i) => i.code))].join('、')}）。`
  const core = {
    command: 'doctor' as const,
    ok,
    exitCode,
    generated_at: generatedAt,
    checks,
    issues,
    issue_count: issues.length,
    summary,
  }
  const text = humanText(core)
  const json = JSON.stringify(core, null, 2)
  return { ...core, json, text, toJson: () => json }
}
