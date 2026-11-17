/**
 * 数据获取层 fixtures 契约测试（Task 20）。
 *
 * 本测试只读取已生成的 fixtures 与脚本源码做结构 / schema / 幂等依据校验，
 * 不在生产测试里重新执行 Python 覆盖文件（避免测试相互污染与副作用）。
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as v from 'valibot'
import { CandidateSchema, MasterDataRecordSchema } from '@core/schema'
import { DOMAINS } from '@core/types'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const corpusDir = resolve(projectRoot, 'tests/fixtures/corpus')
const fixturePath = (name: string): string => resolve(corpusDir, name)
const readFixture = (name: string): string => readFileSync(fixturePath(name), 'utf8')
const readJson = (name: string): any => JSON.parse(readFixture(name))
const sha256 = (name: string): string =>
  createHash('sha256').update(readFileSync(fixturePath(name))).digest('hex')

const CATEGORIES = ['同义改名', '同名异规格', '换单位', '停用码', '医保码错配'] as const
const DOMAIN_SET = new Set<string>(DOMAINS)
const STATUSES = new Set<string>(['启用', '停用'])

const master: any[] = readJson('master-data.json')
const candidates: any[] = readJson('candidates.json')
const manifest: any = readJson('MANIFEST.json')
const scriptSource: string = readFileSync(resolve(projectRoot, 'scripts/fetch_corpus.py'), 'utf8')

const categoryOf = (candidate: any): string => String(candidate.source_note).split('|')[0]

describe('语料规模契约', () => {
  it('master-data.json 条数 >= 300 且与 MANIFEST 记录一致', () => {
    expect(master.length).toBeGreaterThanOrEqual(300)
    expect(master.length).toBe(manifest.counts.master_data)
  })

  it('candidates.json 条数 >= 150 且与 MANIFEST 记录一致', () => {
    expect(candidates.length).toBeGreaterThanOrEqual(150)
    expect(candidates.length).toBe(manifest.counts.candidates)
  })

  it('5 类干扰候选每类 >= 30 且类别集合精确无多余', () => {
    const counts = new Map<string, number>()
    for (const candidate of candidates) {
      const category = categoryOf(candidate)
      counts.set(category, (counts.get(category) ?? 0) + 1)
    }
    for (const category of CATEGORIES) {
      expect(counts.get(category) ?? 0, `类别「${category}」不足 30 条`).toBeGreaterThanOrEqual(30)
    }
    expect(new Set(counts.keys())).toEqual(new Set<string>(CATEGORIES))
  })
})

describe('字段 schema 合法性（严格对齐 src/core）', () => {
  it('每条主数据：必填位齐全、domain 合法、status 合法、version 形如 vN', () => {
    const required = ['code', 'record_id', 'domain', 'name', 'spec', 'dosage_form', 'unit',
      'insurance_code', 'status', 'version']
    for (const record of master) {
      for (const field of required) {
        expect(record[field], `${record.record_id} 缺字段 ${field}`).toBeTruthy()
      }
      expect(DOMAIN_SET.has(record.domain), `非法 domain: ${record.domain}`).toBe(true)
      expect(STATUSES.has(record.status), `非法 status: ${record.status}`).toBe(true)
      expect(record.version).toMatch(/^v\d+$/)
      // 用项目自身的 valibot schema 做运行时形状校验，确保与引擎口径同源
      expect(v.safeParse(MasterDataRecordSchema, record).success, `${record.record_id} 未过 schema`).toBe(true)
    }
  })

  it('每条候选：必填位齐全、domain 合法、来源标记为 synthetic-simulator、注明类别', () => {
    const required = ['candidate_id', 'domain', 'name', 'spec', 'dosage_form', 'unit',
      'insurance_code', 'submit_source', 'submitted_at', 'source', 'source_note']
    for (const candidate of candidates) {
      for (const field of required) {
        expect(candidate[field], `${candidate.candidate_id} 缺字段 ${field}`).toBeTruthy()
      }
      expect(DOMAIN_SET.has(candidate.domain), `非法 domain: ${candidate.domain}`).toBe(true)
      expect(candidate.source).toBe('synthetic-simulator')
      expect(CATEGORIES).toContain(categoryOf(candidate) as (typeof CATEGORIES)[number])
      expect(v.safeParse(CandidateSchema, candidate).success, `${candidate.candidate_id} 未过 schema`).toBe(true)
    }
  })

  it('主数据含足量停用码与全部合法域，可支撑 5 类干扰对照', () => {
    const inactive = master.filter((r) => r.status === '停用')
    expect(inactive.length).toBeGreaterThanOrEqual(30)
    expect(new Set(master.map((r) => r.domain))).toEqual(DOMAIN_SET)
    // 主键类字段不重复，避免人为制造多义污染
    expect(new Set(master.map((r) => r.record_id)).size).toBe(master.length)
    expect(new Set(master.map((r) => r.insurance_code)).size).toBe(master.length)
  })
})

describe('MANIFEST 可核对产出', () => {
  it('记录来源、生成方式、条数、字段校验结果与 5 类分布', () => {
    expect(manifest.source).toBe('synthetic-simulator')
    expect(manifest.generation_method).toContain('三级降级')
    expect(manifest.counts.total).toBe(master.length + candidates.length)
    expect(manifest.counts.total).toBeGreaterThanOrEqual(450)
    expect(manifest.field_validation.master_data.result).toBe('pass')
    expect(manifest.field_validation.candidates.result).toBe('pass')
    for (const category of CATEGORIES) {
      expect(manifest.category_distribution[category].count).toBeGreaterThanOrEqual(30)
      expect(manifest.category_distribution[category].source).toBe('synthetic-simulator')
    }
  })

  it('写明三级降级原因（含仿真器来源与降级理由）', () => {
    const reasons: string[] = manifest.degradation.reasons
    expect(manifest.degradation.final_source).toBe('synthetic-simulator')
    expect(manifest.degradation.final_tier).toBe(3)
    expect(reasons.length).toBeGreaterThanOrEqual(3)
    expect(reasons.join('\n')).toContain('仿真器')
    expect(reasons.some((r) => r.includes('本地官方药品目录文件不存在'))).toBe(true)
    expect(reasons.some((r) => r.includes('联网下载'))).toBe(true)
  })
})

describe('可重跑且幂等（不重跑 Python 的实现依据）', () => {
  it('MANIFEST 有 deterministic_seed，且脚本源码含固定种子与笛卡尔组合逻辑', () => {
    expect(manifest.deterministic_seed).toBe(20240433)
    expect(scriptSource).toContain('DETERMINISTIC_SEED')
    expect(scriptSource).toContain('random.Random(DETERMINISTIC_SEED)')
    expect(scriptSource).toContain('for name_index in range(len(names))')
    expect(scriptSource).toContain('rng.shuffle(combos)')
    // 不使用易变当前时间，保证 submitted_at / generated_at 重跑一致
    expect(scriptSource).not.toContain('datetime.now()')
  })

  it('fixtures 字节与 MANIFEST 记录的 sha256 一致（结构一致性，未重跑覆盖）', () => {
    const recorded = manifest.field_validation.file_sha256
    expect(sha256('master-data.json')).toBe(recorded['master-data.json'])
    expect(sha256('candidates.json')).toBe(recorded['candidates.json'])
    expect(manifest.record_index.master_data_record_ids.length).toBe(master.length)
    expect(new Set(manifest.record_index.master_data_record_ids)).toEqual(
      new Set(master.map((r) => r.record_id)),
    )
  })
})
