/**
 * 配置加载与凭据位单测（Task 2 验收文件）。
 *
 * 覆盖 step 6「缺失 MDM_API_TOKEN 时配置加载以明确错误提示并非零退出」，
 * 以及凭据位必填校验、strict 诊断模式、.env 解析与补位、密钥掩码、
 * 测试配置覆盖与映射表绝对路径解析。全部 node 环境、无网络、不读真实 .env。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ConfigError,
  createTestConfig,
  loadConfig,
  maskSecret,
  parseEnvFile,
  REQUIRED_KEYS,
  resolveFieldMapPath,
} from '@shared/config'

/** 一份齐备的凭据位（占位值，非真实密钥）。 */
function fullEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    MDM_BASE_URL: 'http://127.0.0.1:9000/',
    MDM_API_TOKEN: 'mdm-placeholder-token',
    MDM_TIMEOUT_MS: '12345',
    MDM_FIELD_MAP: './config/mdm-field-map.json',
    LLM_BASE_URL: 'http://127.0.0.1:9001/',
    LLM_API_KEY: 'llm-placeholder-key',
    LLM_MODEL: 'qwen-test',
    LLM_TIMEOUT_MS: '45000',
    LLM_MAX_RETRIES: '2',
    LLM_CONCURRENCY: '3',
    ...overrides,
  }
}

describe('Task 2 配置加载与必填凭据位', () => {
  it('必填凭据位清单恰为五项，且含 MDM_API_TOKEN', () => {
    expect([...REQUIRED_KEYS].sort()).toEqual(
      ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'MDM_API_TOKEN', 'MDM_BASE_URL'].sort(),
    )
    expect(REQUIRED_KEYS).toContain('MDM_API_TOKEN')
  })

  it('齐备凭据位 → 正常返回；尾斜杠剥离、数值位解析、映射表路径保留', () => {
    const cfg = loadConfig(fullEnv())
    expect(cfg.mdm.baseUrl).toBe('http://127.0.0.1:9000')
    expect(cfg.llm.baseUrl).toBe('http://127.0.0.1:9001')
    expect(cfg.mdm.timeoutMs).toBe(12345)
    expect(cfg.llm.timeoutMs).toBe(45000)
    expect(cfg.llm.maxRetries).toBe(2)
    expect(cfg.llm.concurrency).toBe(3)
    expect(cfg.mdm.fieldMapPath).toBe('./config/mdm-field-map.json')
  })

  it('缺 MDM_API_TOKEN → 抛 ConfigError，明确列缺失项（可诊断非零退出）', () => {
    const env = fullEnv()
    delete env.MDM_API_TOKEN
    try {
      loadConfig(env)
      throw new Error('应当抛 ConfigError')
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError)
      const e = err as ConfigError
      expect(e.missing).toContain('MDM_API_TOKEN')
      expect(e.missing).toHaveLength(1)
      expect(e.message).toContain('缺少必填凭据位')
      expect(e.message).toContain('MDM_API_TOKEN')
      expect(e.message).toContain('.env.example')
    }
  })

  it('多个凭据位缺失 → 一次列全，不静默用默认值兜底', () => {
    const e = fullEnv()
    for (const key of ['MDM_API_TOKEN', 'LLM_API_KEY', 'LLM_MODEL']) delete e[key]
    try {
      loadConfig(e)
      throw new Error('应当抛 ConfigError')
    } catch (err) {
      const ce = err as ConfigError
      expect(ce.missing.sort()).toEqual(['LLM_API_KEY', 'LLM_MODEL', 'MDM_API_TOKEN'].sort())
    }
  })

  it('空串或纯空白凭据位同样视为缺失', () => {
    const env = fullEnv({ MDM_API_TOKEN: '   ' })
    expect(() => loadConfig(env)).toThrow(ConfigError)
    expect(() => loadConfig(env)).toThrow(/MDM_API_TOKEN/)
  })

  it('strict:false 诊断模式 → 不抛错，返回空值配置（供 doctor 体检逐项报告）', () => {
    const cfg = loadConfig({}, { strict: false })
    expect(cfg.mdm.apiToken).toBe('')
    expect(cfg.llm.apiKey).toBe('')
    // 数值位非法/缺失仍回落安全默认，不让诊断模式产生 NaN。
    expect(cfg.mdm.timeoutMs).toBe(15000)
    expect(cfg.llm.timeoutMs).toBe(30000)
    expect(cfg.llm.maxRetries).toBe(1)
    expect(cfg.llm.concurrency).toBe(4)
  })

  it('非正整数数值位回落默认，不产生 NaN 或 0 并发', () => {
    const cfg = loadConfig(fullEnv({
      MDM_TIMEOUT_MS: 'abc',
      LLM_TIMEOUT_MS: '-5',
      LLM_MAX_RETRIES: '0',
      LLM_CONCURRENCY: 'x',
    }))
    expect(cfg.mdm.timeoutMs).toBe(15000)
    expect(cfg.llm.timeoutMs).toBe(30000)
    expect(cfg.llm.maxRetries).toBe(1)
    expect(cfg.llm.concurrency).toBe(4)
  })
})

describe('Task 2 .env 解析、补位与密钥掩码', () => {
  it('parseEnvFile 忽略注释与空行、剥离两侧引号、保留值内的等号', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-env-'))
    const file = join(dir, '.env')
    try {
      writeFileSync(file, [
        '# 注释行',
        '',
        'MDM_API_TOKEN = "quoted-token"',
        "LLM_MODEL='qwen-test'",
        'EXTRA_URL=http://x/?a=1&b=2',
      ].join('\n'), 'utf8')
      const parsed = parseEnvFile(file)
      expect(parsed.MDM_API_TOKEN).toBe('quoted-token')
      expect(parsed.LLM_MODEL).toBe('qwen-test')
      expect(parsed.EXTRA_URL).toBe('http://x/?a=1&b=2')
      expect(parsed['# 注释行']).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('parseEnvFile 指向不存在文件时返回空对象，不抛错', () => {
    expect(parseEnvFile('/nonexistent/.env')).toEqual({})
  })

  it('envFile 为进程缺失的键补位，且进程已有值优先不被覆盖', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-merge-'))
    const file = join(dir, '.env')
    try {
      writeFileSync(file, [
        'MDM_API_TOKEN=from-file',
        'LLM_API_KEY=from-file',
      ].join('\n'), 'utf8')
      // env 里没有的凭据位由 file 补齐；已有的 MDM_API_TOKEN 以 env 为准。
      const env = fullEnv({ MDM_API_TOKEN: 'from-env' })
      delete env.LLM_API_KEY
      const cfg = loadConfig(env, { envFile: file })
      expect(cfg.mdm.apiToken).toBe('from-env')
      expect(cfg.llm.apiKey).toBe('from-file')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('maskSecret 只保留前 4 位与末 2 位，短值特殊处理，空值返回空串', () => {
    expect(maskSecret('abcdefghij')).toBe('abcd****ij')
    expect(maskSecret('sk-1234567890')).toBe('sk-1****90')
    expect(maskSecret('abc')).toBe('ab****')
    expect(maskSecret('')).toBe('')
  })

  it('createTestConfig 带占位凭据并跳过必填校验，支持嵌套字段覆盖', () => {
    const cfg = createTestConfig({
      mdm: { baseUrl: 'http://127.0.0.1:7777' },
      llm: { model: 'override-model' },
    })
    expect(cfg.mdm.baseUrl).toBe('http://127.0.0.1:7777')
    expect(cfg.mdm.apiToken).toBe('test-token')
    expect(cfg.llm.model).toBe('override-model')
    expect(cfg.llm.apiKey).toBe('test-key')
  })

  it('resolveFieldMapPath 相对进程工作目录解析为绝对路径', () => {
    const cfg = loadConfig(fullEnv(), { strict: true })
    const p = resolveFieldMapPath(cfg)
    expect(p.startsWith('/')).toBe(true)
    expect(p).toContain('config/mdm-field-map.json')
  })
})
