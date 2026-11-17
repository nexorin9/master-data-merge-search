import { describe, expect, it, vi } from 'vitest'
import { REQUIRED_KEYS } from '@shared/config'
import {
  DOCTOR_PROBE_SENTINEL,
  DOCTOR_SUGGESTIONS,
  runDoctor,
  type DoctorDeps,
  type DoctorProbe,
  type DoctorProbeInit,
} from '../../src/cli/doctor'
import { dispatch, parseArgs } from '../../src/cli/index'

const FIXED_NOW = '2026-11-10T09:00:00.000Z'

/** 全为假值，绝不出现真实凭据。 */
const FULL_ENV: Record<string, string> = {
  MDM_BASE_URL: 'https://mdm.example.test',
  MDM_API_TOKEN: 'mdm-fake-token-abcdef',
  LLM_BASE_URL: 'https://llm.example.test',
  LLM_API_KEY: 'llm-fake-key-abcdef',
  LLM_MODEL: 'merge-model-v1',
}

/** 覆盖候选/主数据必需内部字段的合法映射。 */
const VALID_FIELD_MAP = JSON.stringify({
  候选编号: 'candidate_id',
  域: 'domain',
  名称: 'name',
  药品编码: 'code',
  记录编号: 'record_id',
  状态: 'status',
})

const healthyProbe: DoctorProbe = async () => ({ status: 200, latency_ms: 7 })

function baseDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    env: FULL_ENV,
    now: () => FIXED_NOW,
    probe: healthyProbe,
    readFieldMap: () => VALID_FIELD_MAP,
    ...overrides,
  }
}

describe('运维 CLI · doctor（Task 52）', () => {
  it('逐项检查 5 个凭据位，缺失项一条一条列出并给来源说明', async () => {
    const env = { ...FULL_ENV, MDM_API_TOKEN: '', LLM_API_KEY: '', LLM_MODEL: '' }
    const r = await runDoctor(baseDeps({ env }))

    expect(r.issues.filter((i) => i.code === '凭据缺失').map((i) => i.item)).toEqual([
      'MDM_API_TOKEN', 'LLM_API_KEY', 'LLM_MODEL',
    ])
    const credentialChecks = r.checks.filter((c) => c.kind === 'credential')
    expect(credentialChecks.map((c) => c.name)).toEqual([...REQUIRED_KEYS])
    expect(credentialChecks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      'MDM_API_TOKEN', 'LLM_API_KEY', 'LLM_MODEL',
    ])
    // 每一项都有中文结论与来源说明
    expect(credentialChecks.every((c) => c.conclusion.length > 0 && c.source.length > 0)).toBe(true)
    expect(credentialChecks.find((c) => c.name === 'MDM_API_TOKEN')?.source).toContain('未设置')
    expect(r.exitCode).toBe(1)
  })

  it('401 归类为认证失败并给出可执行建议', async () => {
    const r = await runDoctor(baseDeps({
      probe: async () => ({ status: 401, latency_ms: 12, error: 'Unauthorized' }),
    }))

    const authIssues = r.issues.filter((i) => i.code === '认证失败')
    expect(authIssues).toHaveLength(4)
    expect(authIssues[0]!.suggestion).toBe(DOCTOR_SUGGESTIONS['认证失败'])
    expect(authIssues[0]!.suggestion).toContain('令牌')
    expect(authIssues[0]!.suggestion).toContain('MDM_API_TOKEN')
    expect(r.checks.filter((c) => c.kind === 'endpoint').every((c) => c.status === 401)).toBe(true)
  })

  it('--json 输出可 JSON.parse，toJson 与 json 字段一致，dispatch 的 stdout 也是纯 JSON', async () => {
    const env = { ...FULL_ENV, LLM_MODEL: '' }
    const r = await runDoctor(baseDeps({ env }))
    const parsed = JSON.parse(r.json)

    expect(parsed.command).toBe('doctor')
    expect(parsed.ok).toBe(false)
    expect(parsed.exitCode).toBe(1)
    expect(parsed.generated_at).toBe(FIXED_NOW)
    expect(Array.isArray(parsed.checks)).toBe(true)
    expect(Array.isArray(parsed.issues)).toBe(true)
    expect(JSON.parse(r.toJson())).toEqual(parsed)

    const args = parseArgs(['doctor', '--json'])
    expect(args.command).toBe('doctor')
    expect(args.json).toBe(true)
    const dispatched = await dispatch(args, {
      env,
      now: () => FIXED_NOW,
      probe: healthyProbe,
      readFieldMap: () => VALID_FIELD_MAP,
    })
    expect(JSON.parse(dispatched.stdout.trim())).toEqual(parsed)
    expect(dispatched.exitCode).toBe(1)
  })

  it('全程零写入：4 个探测全是 GET，写端点也只用 GET 探测', async () => {
    const calls: Array<{ url: string; init: DoctorProbeInit }> = []
    const probe: DoctorProbe = async (url, init) => {
      calls.push({ url, init })
      return { status: 200, latency_ms: 5 }
    }
    const r = await runDoctor(baseDeps({ probe }))

    // 3 个 MDM 端点 + 1 个模型端点，各探测一次
    expect(calls).toHaveLength(4)
    expect(calls.every((c) => c.init.method === 'GET')).toBe(true)
    expect(calls.every((c) => !['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.init.method))).toBe(true)
    const writeEndpointCalls = calls.filter((c) => c.url.includes('/merge-suggestions'))
    expect(writeEndpointCalls).toHaveLength(1)
    expect(writeEndpointCalls[0]!.init.method).toBe('GET')
    // 探测 URL 只带固定占位符，绝不含业务数据
    expect(calls.some((c) => c.url.includes(DOCTOR_PROBE_SENTINEL))).toBe(true)
    expect(calls.every((c) => !c.url.includes('XJ7000000000001'))).toBe(true)
    expect(r.exitCode).toBe(0)
  })

  it('端点不可达归类，并记录状态/延迟/错误摘要', async () => {
    const r = await runDoctor(baseDeps({
      probe: async () => ({ status: 0, latency_ms: 42, error: 'ECONNREFUSED 127.0.0.1:1' }),
    }))

    const unreachable = r.issues.filter((i) => i.code === '端点不可达')
    expect(unreachable).toHaveLength(4)
    expect(unreachable[0]!.suggestion).toBe(DOCTOR_SUGGESTIONS['端点不可达'])
    expect(unreachable[0]!.suggestion).toContain('MDM_BASE_URL')
    const endpointChecks = r.checks.filter((c) => c.kind === 'endpoint')
    expect(endpointChecks.every((c) => c.status === 0 && c.latency_ms === 42)).toBe(true)
    expect(endpointChecks.every((c) => (c.error ?? '').includes('ECONNREFUSED'))).toBe(true)
  })

  it('全部健康时 exitCode 为 0，且 JSON 不含完整密钥', async () => {
    const probe = vi.fn(async () => ({ status: 200, latency_ms: 3 }))
    const r = await runDoctor(baseDeps({ probe }))

    expect(probe).toHaveBeenCalledTimes(4)
    expect(r.ok).toBe(true)
    expect(r.exitCode).toBe(0)
    expect(r.issues).toEqual([])
    expect(r.checks).toHaveLength(10) // 5 凭据 + 4 端点 + 1 字段映射
    expect(r.text).toContain('健康')
    expect(r.json).not.toContain(FULL_ENV.MDM_API_TOKEN!)
    expect(r.json).not.toContain(FULL_ENV.LLM_API_KEY!)
    expect(r.checks.find((c) => c.kind === 'credential' && c.name === 'MDM_API_TOKEN')?.display_value)
      .toContain('****')
  })

  it('字段映射文件缺失归类为「字段映射文件缺失或格式错」', async () => {
    const r = await runDoctor(baseDeps({
      readFieldMap: () => {
        throw new Error("ENOENT: no such file or directory, open '/tmp/not-exist-field-map.json'")
      },
    }))

    const issue = r.issues.find((i) => i.code === '字段映射文件缺失或格式错')
    expect(issue).toBeDefined()
    expect(issue!.item).toBe('MDM_FIELD_MAP')
    expect(issue!.suggestion).toContain('MDM_FIELD_MAP')
    expect(issue!.message).toContain('文件缺失')
    const check = r.checks.find((c) => c.kind === 'field_map')!
    expect(check.ok).toBe(false)
    expect(check.conclusion).toContain('不可用')
    expect(r.exitCode).toBe(1)
  })

  it('字段映射不是合法 JSON、或缺少必需内部字段，同样归类且不误报健康', async () => {
    const badJson = await runDoctor(baseDeps({ readFieldMap: () => '{not json' }))
    expect(badJson.issues.some((i) => i.code === '字段映射文件缺失或格式错' && i.message.includes('JSON 格式'))).toBe(true)

    const incomplete = await runDoctor(baseDeps({
      readFieldMap: () => JSON.stringify({ 名称: 'name' }),
    }))
    const issue = incomplete.issues.find((i) => i.code === '字段映射文件缺失或格式错')
    expect(issue).toBeDefined()
    expect(issue!.message).toContain('必需字段映射缺失')
    expect(incomplete.exitCode).toBe(1)
  })

  it('模型端点 404 归类为「模型端点不支持结构化输出」并给模型侧建议', async () => {
    const probe: DoctorProbe = async (url) => ({
      status: url.endsWith('/v1/chat/completions') ? 404 : 200,
      latency_ms: 8,
    })
    const r = await runDoctor(baseDeps({ probe }))

    const issue = r.issues.find((i) => i.code === '模型端点不支持结构化输出')
    expect(issue).toBeDefined()
    expect(issue!.suggestion).toBe(DOCTOR_SUGGESTIONS['模型端点不支持结构化输出'])
    expect(issue!.suggestion).toContain('response_format')
    expect(r.checks.find((c) => c.id === 'endpoint:model-chat-completions')?.status).toBe(404)
    expect(r.exitCode).toBe(1)
  })

  it('模型端点返回 405 视为可达，并提示只读探测无法证明结构化输出能力', async () => {
    const probe: DoctorProbe = async (url) => ({
      status: url.endsWith('/v1/chat/completions') ? 405 : 200,
      latency_ms: 4,
    })
    const r = await runDoctor(baseDeps({ probe }))

    expect(r.ok).toBe(true)
    expect(r.exitCode).toBe(0)
    expect(r.checks.find((c) => c.id === 'endpoint:model-chat-completions')?.note)
      .toContain('结构化输出能力')
  })
})
