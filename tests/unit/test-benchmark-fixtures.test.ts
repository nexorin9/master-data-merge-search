/**
 * 基准集口径可支撑性测试（Task 13 基准侧）。
 *
 * 断言：从 candidates.json 按 source_note 分类的 5 类干扰齐全、规模达标、
 * 每条候选都能在主数据里定位到「应并 / 不应并」的对照记录，且期望方向完备，
 * 可被 gate-cases 与人工标注基准集（expected.json）复用。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACTIONS, buildExpected, validateExpected } from '../../scripts/validate_benchmark'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const corpusDir = resolve(projectRoot, 'tests/fixtures/corpus')
const readJson = (name: string): any =>
  JSON.parse(readFileSync(resolve(corpusDir, name), 'utf8'))

const master: any[] = readJson('master-data.json')
const candidates: any[] = readJson('candidates.json')
const manifest: any = readJson('MANIFEST.json')

/** Task 49 人工标注基准集与闸门口径；与语料夹具共用同一份真相。 */
const fixturesDir = resolve(projectRoot, 'tests/fixtures')
const expectedPath = resolve(fixturesDir, 'benchmark/expected.json')
const readFixtureJson = (relative: string): any =>
  JSON.parse(readFileSync(resolve(fixturesDir, relative), 'utf8'))
const expected: any = readFixtureJson('benchmark/expected.json')
const gateCases: any = readFixtureJson('gate-cases.json')
const benchmarkCorpus = { master, candidates, manifest }

const CATEGORIES = ['同义改名', '同名异规格', '换单位', '停用码', '医保码错配'] as const
type Category = (typeof CATEGORIES)[number]

/** 各干扰类别的确定期望方向，是人工标注基准集的口径来源。 */
const CATEGORY_EXPECT: Record<Category, 'merge' | 'non-merge' | 'uncertain'> = {
  同义改名: 'merge',
  同名异规格: 'non-merge',
  换单位: 'merge',
  停用码: 'uncertain',
  医保码错配: 'non-merge',
}

interface ParsedCandidate {
  candidateId: string
  category: string
  counterpart: string | null
  expectation: string | null
  note: string
}

/** 从 source_note 解析类别 / 对照记录 / 期望方向，缺项即暴露为 null。 */
const parseNote = (candidate: any): ParsedCandidate => {
  const parts = String(candidate.source_note).split('|')
  const field = (prefix: string): string | null => {
    const hit = parts.find((p) => p.startsWith(prefix))
    return hit ? hit.slice(prefix.length) : null
  }
  return {
    candidateId: candidate.candidate_id,
    category: parts[0],
    counterpart: field('对照记录='),
    expectation: field('期望='),
    note: field('说明=') ?? '',
  }
}

const parsed: ParsedCandidate[] = candidates.map(parseNote)
const masterById = new Map<string, any>(master.map((r) => [r.record_id, r]))
const byCategory = new Map<string, ParsedCandidate[]>()
for (const item of parsed) {
  byCategory.set(item.category, [...(byCategory.get(item.category) ?? []), item])
}

describe('基准集规模与类别分布', () => {
  it('按 source_note 分类，5 类干扰齐全且每类 >= 30 条', () => {
    expect([...byCategory.keys()].sort()).toEqual([...CATEGORIES].sort())
    for (const category of CATEGORIES) {
      expect(byCategory.get(category)!.length, `类别「${category}」不足 30 条`).toBeGreaterThanOrEqual(30)
    }
  })

  it('基准集总量 >= 450（主数据 >= 300 + 候选 >= 150）且与 MANIFEST 对齐', () => {
    expect(master.length).toBeGreaterThanOrEqual(300)
    expect(candidates.length).toBeGreaterThanOrEqual(150)
    expect(master.length + candidates.length).toBeGreaterThanOrEqual(450)
    expect(manifest.counts.master_data).toBe(master.length)
    expect(manifest.counts.candidates).toBe(candidates.length)
    expect(manifest.counts.total).toBe(master.length + candidates.length)
  })
})

describe('每条候选的对照可能（人工标注基础）', () => {
  it('每条候选都能定位主数据对照记录，无悬空引用且候选 id 唯一', () => {
    expect(new Set(parsed.map((p) => p.candidateId)).size).toBe(candidates.length)
    for (const item of parsed) {
      expect(item.counterpart, `${item.candidateId} 缺对照记录`).toBeTruthy()
      expect(masterById.has(item.counterpart!), `${item.candidateId} 对照记录 ${item.counterpart} 不存在`).toBe(true)
    }
  })

  it('每条候选标注完整：类别、期望方向、说明均非空，可被校验脚本发现缺标注', () => {
    for (const item of parsed) {
      expect(CATEGORIES).toContain(item.category as Category)
      expect(['merge', 'non-merge', 'uncertain']).toContain(item.expectation)
      expect(item.note.length, `${item.candidateId} 缺说明`).toBeGreaterThan(0)
    }
    // 人为注入缺标注行时，上述解析会失败 —— 证明校验口径可发现缺标注
    const broken = parseNote({ candidate_id: 'CAND-BROKEN', source_note: '同义改名|说明=缺对照与期望' })
    expect(broken.counterpart).toBeNull()
    expect(broken.expectation).toBeNull()
  })

  it('期望方向与类别口径逐条一致，且覆盖 merge / non-merge / uncertain 三态', () => {
    const directions = new Set<string>()
    for (const item of parsed) {
      const expected = CATEGORY_EXPECT[item.category as Category]
      expect(item.expectation, `${item.candidateId} 期望方向与类别不符`).toBe(expected)
      directions.add(item.expectation!)
    }
    expect(directions).toEqual(new Set(['merge', 'non-merge', 'uncertain']))
    // 不应并的两类（同名异规格 / 医保码错配）确实是错误归并率的主要防线
    expect(byCategory.get('同名异规格')!.every((i) => i.expectation === 'non-merge')).toBe(true)
    expect(byCategory.get('医保码错配')!.every((i) => i.expectation === 'non-merge')).toBe(true)
  })
})

describe('gate-cases 复用口径', () => {
  it('gate-case 会复用的 5 类齐全，期望方向分布吻合 MANIFEST', () => {
    expect([...manifest.benchmark_support.gate_case_categories].sort()).toEqual([...CATEGORIES].sort())
    const expectedDirections = manifest.benchmark_support.expected_directions
    expect(expectedDirections.merge).toBeGreaterThanOrEqual(60)
    expect(expectedDirections['non-merge']).toBeGreaterThanOrEqual(60)
    expect(expectedDirections.uncertain).toBeGreaterThanOrEqual(30)
    const actual = {
      merge: parsed.filter((p) => p.expectation === 'merge').length,
      'non-merge': parsed.filter((p) => p.expectation === 'non-merge').length,
      uncertain: parsed.filter((p) => p.expectation === 'uncertain').length,
    }
    expect(actual).toEqual(expectedDirections)
  })

  it('MANIFEST 记录索引逐条覆盖主数据与候选，可支撑 expected.json 全量标注', () => {
    expect(new Set(manifest.record_index.master_data_record_ids)).toEqual(
      new Set(master.map((r) => r.record_id)),
    )
    for (const category of CATEGORIES) {
      const indexed: string[] = manifest.record_index.candidate_ids_by_category[category]
      expect(indexed.length).toBe(byCategory.get(category)!.length)
      expect(new Set(indexed)).toEqual(new Set(byCategory.get(category)!.map((i) => i.candidateId)))
      expect(manifest.category_distribution[category].expected_direction).toBe(CATEGORY_EXPECT[category])
    }
  })
})

// ---------------------------------------------------------------------------
// Task 49：人工标注基准集 expected.json 与纯校验函数
// ---------------------------------------------------------------------------

describe('人工标注基准集 expected.json', () => {
  it('文件存在且可解析，含 version / source / annotation_method / dataset_ref / counts / annotations', () => {
    expect(existsSync(expectedPath), 'expected.json 不存在').toBe(true)
    expect(expected).toBeTypeOf('object')
    expect(expected).not.toBeNull()
    expect(Array.isArray(expected.annotations)).toBe(true)
    expect(expected.version, '缺 version').toBeGreaterThan(0)
    expect(typeof expected.source, '缺 source').toBe('string')
    expect(expected.source.length).toBeGreaterThan(0)
    expect(typeof expected.annotation_method, '缺 annotation_method').toBe('string')
    expect(expected.annotation_method.length).toBeGreaterThan(0)
    expect(expected.dataset_ref, '缺 dataset_ref').toBeTypeOf('object')
    expect(expected.counts, '缺 counts').toBeTypeOf('object')
  })

  it('标注总数等于候选总数 160，且 counts.total 同步', () => {
    expect(candidates.length).toBe(160)
    expect(expected.annotations.length).toBe(candidates.length)
    expect(expected.counts.total).toBe(expected.annotations.length)
  })

  it('5 类干扰类别齐全且每类标注 >= 30', () => {
    const distribution = new Map<string, number>()
    for (const annotation of expected.annotations) {
      distribution.set(annotation.category, (distribution.get(annotation.category) ?? 0) + 1)
    }
    expect([...distribution.keys()].sort()).toEqual([...CATEGORIES].sort())
    for (const category of CATEGORIES) {
      expect(distribution.get(category)!, `类别「${category}」标注不足 30`).toBeGreaterThanOrEqual(30)
      expect(expected.counts.by_category[category]).toBe(distribution.get(category))
    }
  })

  it('每条候选恰好标注一次，且无缺失或空的 expected_action', () => {
    const annotatedIds = expected.annotations.map((a: any) => a.candidate_id)
    expect(new Set(annotatedIds).size, '存在重复 candidate_id').toBe(annotatedIds.length)
    expect(new Set(annotatedIds)).toEqual(new Set(candidates.map((c: any) => c.candidate_id)))
    for (const annotation of expected.annotations) {
      expect(typeof annotation.expected_action, `${annotation.candidate_id} 缺 expected_action`).toBe('string')
      expect(annotation.expected_action.length, `${annotation.candidate_id} 的 expected_action 为空`).toBeGreaterThan(0)
    }
  })

  it('所有 merge 标注的 expected_target_code 都能在主数据中解析', () => {
    const codes = new Set(master.map((r: any) => r.code))
    const merges = expected.annotations.filter((a: any) => a.expected_action === 'merge')
    expect(merges.length).toBeGreaterThan(0)
    for (const annotation of merges) {
      expect(typeof annotation.expected_target_code).toBe('string')
      expect(codes.has(annotation.expected_target_code), `${annotation.candidate_id} 目标码无法解析`).toBe(true)
    }
    for (const annotation of expected.annotations) {
      if (annotation.expected_action !== 'merge') {
        expect(annotation.expected_target_code, `${annotation.candidate_id} 非 merge 却登记了目标码`).toBeNull()
      }
    }
  })

  it('expected_action 词表合法（create / merge / uncertain）', () => {
    for (const annotation of expected.annotations) {
      expect(ACTIONS, `${annotation.candidate_id} 动作非法`).toContain(annotation.expected_action)
    }
    expect(new Set(expected.annotations.map((a: any) => a.expected_action))).toEqual(
      new Set(['create', 'merge', 'uncertain']),
    )
  })

  it('uncertain 行带词表内存疑理由，其余行理由为 null', () => {
    const reasons = new Set<string>()
    for (const annotation of expected.annotations) {
      if (annotation.expected_action === 'uncertain') {
        expect(typeof annotation.expected_reason, `${annotation.candidate_id} 缺存疑理由`).toBe('string')
        expect(annotation.expected_reason.length).toBeGreaterThan(0)
        reasons.add(annotation.expected_reason)
      } else {
        expect(annotation.expected_reason).toBeNull()
      }
    }
    expect([...reasons]).toEqual(['命中记录均已停用'])
  })
})

describe('validateExpected 纯函数', () => {
  it('对已提交产物返回 ok，counts 与逐条分布自洽', () => {
    const result = validateExpected(expected, benchmarkCorpus, gateCases)
    expect(result.errors).toEqual([])
    expect(result.ok, result.errors.join('；')).toBe(true)
    expect(result.summary.total_annotations).toBe(160)
    expect(result.summary.total_candidates).toBe(160)
    expect(result.summary.merge_targets_resolved).toBe(64)
    expect(result.summary.gate_overlap_count).toBe(0)
    expect(result.summary.by_category).toEqual(expected.counts.by_category)
    expect(result.summary.by_action).toEqual(expected.counts.by_action)
    expect(result.report.join('\n')).toContain('校验通过')
  })

  it('buildExpected 可由语料确定性重建已提交产物', () => {
    expect(buildExpected(benchmarkCorpus)).toEqual(expected)
  })

  it('能发现人为删除的标注行', () => {
    const broken = { ...expected, annotations: expected.annotations.slice(1) }
    const result = validateExpected(broken, benchmarkCorpus, gateCases)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('缺标注行'))).toBe(true)
    expect(result.errors.some((e) => e.includes('标注总数 == 候选总数'))).toBe(true)
  })

  it('能发现被篡改的 merge 目标码（不存在 / 张冠李戴）', () => {
    const firstMerge = expected.annotations.find((a: any) => a.expected_action === 'merge')
    const otherCode = master.find((r: any) => r.code !== firstMerge.expected_target_code)!.code
    const replace = (code: string) => ({
      ...expected,
      annotations: expected.annotations.map((a: any) =>
        a.candidate_id === firstMerge.candidate_id ? { ...a, expected_target_code: code } : a,
      ),
    })
    const missingCode = validateExpected(replace('MD-NOT-EXIST'), benchmarkCorpus, gateCases)
    const wrongButValid = validateExpected(replace(otherCode), benchmarkCorpus, gateCases)
    expect(missingCode.ok).toBe(false)
    expect(missingCode.errors.some((e) => e.includes('无法在主数据 code 中解析'))).toBe(true)
    expect(wrongButValid.ok).toBe(false)
    expect(wrongButValid.errors.some((e) => e.includes('与对照记录解析结果不一致'))).toBe(true)
  })

  it('能发现与 gate-cases 类别口径冲突的动作', () => {
    const firstAlias = expected.annotations.find((a: any) => a.category === '同义改名')
    const broken = {
      ...expected,
      annotations: expected.annotations.map((a: any) =>
        a.candidate_id === firstAlias.candidate_id
          ? { ...a, expected_action: 'create', expected_target_code: null }
          : a,
      ),
    }
    const result = validateExpected(broken, benchmarkCorpus, gateCases)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('与类别「同义改名」口径') && e.includes('冲突'))).toBe(true)
  })

  it('能发现空 expected_action 与重复标注行', () => {
    const blank = {
      ...expected,
      annotations: expected.annotations.map((a: any, i: number) =>
        i === 0 ? { ...a, expected_action: '' } : a,
      ),
    }
    const duplicate = { ...expected, annotations: [...expected.annotations, expected.annotations[0]] }
    expect(
      validateExpected(blank, benchmarkCorpus, gateCases).errors.some((e) => e.includes('expected_action 缺失或为空')),
    ).toBe(true)
    expect(
      validateExpected(duplicate, benchmarkCorpus, gateCases).errors.some((e) => e.includes('条重复标注')),
    ).toBe(true)
  })
})
