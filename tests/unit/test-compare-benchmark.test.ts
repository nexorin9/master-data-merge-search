/**
 * 基准对照报告单测（Task 51）。
 *
 * 全部 node 环境、无 jsdom、无网络。指标公式与门禁分支用小夹具直接验证；
 * 全量 160 条只注入预计算的路径B 结论（不重跑 320 次引擎降级调用）。
 * 报告产物写到系统临时目录并在用例结束时清理，不污染受控文件清单。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CandidateRecord, MasterDataRecord } from '@core/types'
import { baselineConclude } from '@core/engine/baseline'
import {
  CODE_RULES_STATUS,
  EXIT_CODE_BY_VERDICT,
  FIXED_NOW,
  HONEST_DEGRADE_STATEMENT,
  compareAll,
  isHit,
  isMiss,
  isWrongMerge,
  readDatasetMeta,
  readExpected,
  renderCodeRulesCheck,
  renderJson,
  renderMarkdown,
  runCompare,
  toCsv,
  type BenchmarkAnnotation,
  type PathAResult,
  type PathBResult,
} from '../../scripts/compare_benchmark'
import { loadCorpus } from '../../scripts/run-merge'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const readJson = (relative: string): any =>
  JSON.parse(readFileSync(resolve(projectRoot, relative), 'utf8'))

/**
 * 7 条手工夹具，刻意覆盖四种判定：
 *   命中 A1/A4/A7；路径A 错误归并 A3/A5；路径A 漏并 A2/A6；存疑 A6（路径A）/ A1,A5,A7（路径B）。
 * ambiguous_top_hits 只在 A3 为 2，用于验证多义误判数只算「多义且错误归并」。
 */
function fixture(): {
  annotations: BenchmarkAnnotation[]
  candidates: CandidateRecord[]
  masterData: MasterDataRecord[]
  pathA: PathAResult[]
  pathB: PathBResult[]
} {
  const annotations: BenchmarkAnnotation[] = [
    { candidate_id: 'A1', category: '同义改名', expected_action: 'merge', expected_target_code: 'M001' },
    { candidate_id: 'A2', category: '同义改名', expected_action: 'merge', expected_target_code: 'M002' },
    { candidate_id: 'A3', category: '同名异规格', expected_action: 'create', expected_target_code: null },
    { candidate_id: 'A4', category: '医保码错配', expected_action: 'create', expected_target_code: null },
    {
      candidate_id: 'A5', category: '停用码', expected_action: 'uncertain',
      expected_target_code: null, expected_reason: '命中记录均已停用',
    },
    { candidate_id: 'A6', category: '同义改名', expected_action: 'merge', expected_target_code: 'M003' },
    { candidate_id: 'A7', category: '医保码错配', expected_action: 'create', expected_target_code: null },
  ]
  const candidates: CandidateRecord[] = annotations.map((a, i) => ({
    candidate_id: a.candidate_id,
    domain: 'drug',
    name: `候选${i + 1}`,
    spec: '0.25g*12片',
    dosage_form: '片剂',
    unit: '盒',
    insurance_code: 'XJ7000000000001',
    source: 'synthetic-simulator',
  }))
  const masterData: MasterDataRecord[] = ['M001', 'M002', 'M003'].map((code, i) => ({
    code,
    record_id: `MD-TEST-${i + 1}`,
    domain: 'drug',
    name: `主数据${code}`,
    spec: '0.25g*12片',
    dosage_form: '片剂',
    unit: '盒',
    insurance_code: 'XJ7000000000001',
    status: '启用',
    version: 'v1',
  }))
  const pathA: PathAResult[] = [
    { candidate_id: 'A1', action: 'merge', target_code: 'M001', ambiguous_top_hits: 1 },
    { candidate_id: 'A2', action: 'merge', target_code: 'M999', ambiguous_top_hits: 1 },
    { candidate_id: 'A3', action: 'merge', target_code: 'M001', ambiguous_top_hits: 2 },
    { candidate_id: 'A4', action: 'create', target_code: null, ambiguous_top_hits: 0 },
    { candidate_id: 'A5', action: 'merge', target_code: 'M002', ambiguous_top_hits: 1 },
    { candidate_id: 'A6', action: 'uncertain', target_code: null, ambiguous_top_hits: 0 },
    { candidate_id: 'A7', action: 'create', target_code: null, ambiguous_top_hits: 0 },
  ]
  const pathB: PathBResult[] = [
    { candidate_id: 'A1', action: 'uncertain', target_code: null, degraded: false },
    { candidate_id: 'A2', action: 'merge', target_code: 'M002', degraded: false },
    { candidate_id: 'A3', action: 'create', target_code: null, degraded: false },
    { candidate_id: 'A4', action: 'merge', target_code: 'M001', degraded: false },
    { candidate_id: 'A5', action: 'uncertain', target_code: null, degraded: false },
    { candidate_id: 'A6', action: 'merge', target_code: 'M003', degraded: false },
    { candidate_id: 'A7', action: 'uncertain', target_code: null, degraded: false },
  ]
  return { annotations, candidates, masterData, pathA, pathB }
}

const FIXTURE_DATASET = {
  manifest_version: '1.0',
  source: 'synthetic-simulator',
  deterministic_seed: 20240433,
  expected_version: 1,
  generated_at: FIXED_NOW,
}

describe('Task 51 指标公式', () => {
  it('命中 / 错误归并 / 漏并 / 存疑 四项计数与比率按样本量 N 计算', () => {
    const f = fixture()
    const report = compareAll(
      f.annotations, f.candidates, f.masterData, f.pathA, f.pathB,
      { now: () => FIXED_NOW, modelConfigured: true, dataset: FIXTURE_DATASET },
    )

    expect(report.样本量).toBe(7)
    expect(report.数据集版本.master_data_count).toBe(3)
    expect(report.数据集版本.candidate_count).toBe(7)
    expect(report.样本构成).toEqual({ 期望归并: 3, 期望非归并: 4, 期望存疑: 1 })

    // 路径A：命中 A1/A4/A7；错误归并 A3/A5；漏并 A2/A6；存疑 A6
    expect([report.路径A.命中数, report.路径A.错误归并数, report.路径A.漏并数, report.路径A.存疑数])
      .toEqual([3, 2, 2, 1])
    expect([report.路径A.命中率, report.路径A.错误归并率, report.路径A.漏并率, report.路径A.存疑率])
      .toEqual([0.428571, 0.285714, 0.285714, 0.142857])
    expect(report.路径A.多义误判数).toBe(1)

    // 路径B：命中 A2/A3/A5/A6；错误归并 A4；漏并 A1；存疑 A1/A5/A7
    expect([report.路径B.命中数, report.路径B.错误归并数, report.路径B.漏并数, report.路径B.存疑数])
      .toEqual([4, 1, 1, 3])
    expect([report.路径B.命中率, report.路径B.错误归并率, report.路径B.漏并率, report.路径B.存疑率])
      .toEqual([0.571429, 0.142857, 0.142857, 0.428571])
  })

  it('逐条判定函数：命中要求 action 与 target_code 双匹配（含同为 null）', () => {
    const f = fixture()
    const a1 = f.annotations[0]
    expect(isHit(a1, { action: 'merge', target_code: 'M001' })).toBe(true)
    expect(isHit(a1, { action: 'merge', target_code: 'M999' })).toBe(false)
    expect(isHit(a1, { action: 'uncertain', target_code: 'M001' })).toBe(false)
    expect(isHit(f.annotations[2], { action: 'create', target_code: null })).toBe(true)
    expect(isHit(f.annotations[2], { action: 'create', target_code: '' })).toBe(true)
    expect(isWrongMerge(f.annotations[2], { action: 'merge', target_code: 'M001' })).toBe(true)
    expect(isWrongMerge(f.annotations[2], { action: 'merge', target_code: '' })).toBe(false)
    expect(isWrongMerge(a1, { action: 'merge', target_code: 'M999' })).toBe(false)
    expect(isMiss(a1, { action: 'merge', target_code: 'M999' })).toBe(true)
    expect(isMiss(a1, { action: 'uncertain', target_code: null })).toBe(true)
    expect(isMiss(f.annotations[2], { action: 'merge', target_code: 'M001' })).toBe(false)
  })

  it('diffs 只含未命中行，full_matrix 含全部行，且两路差异逐条记录', () => {
    const f = fixture()
    const report = compareAll(
      f.annotations, f.candidates, f.masterData, f.pathA, f.pathB,
      { modelConfigured: true, dataset: FIXTURE_DATASET },
    )
    expect(report.逐条差异.full_matrix).toHaveLength(7)
    expect(report.逐条差异.diff_count).toBe(7)
    expect(report.逐条差异.diffs.map((row) => row.candidate_id))
      .toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'])
    const a3 = report.逐条差异.full_matrix.find((row) => row.candidate_id === 'A3')!
    expect(a3.pathA_wrong_merge).toBe(true)
    expect(a3.pathB_wrong_merge).toBe(false)
    expect(a3.expected_code_resolved).toBe(true)
    expect(report.逐条差异.full_matrix.every((row) => row.expected_code_resolved)).toBe(true)
  })
})

describe('Task 51 放量阈值判定', () => {
  it('错误归并数 > 0 时结论「不放量」并列出每个错误归并 candidate_id', () => {
    const f = fixture()
    const report = compareAll(
      f.annotations, f.candidates, f.masterData, f.pathA, f.pathB,
      { modelConfigured: true, dataset: FIXTURE_DATASET },
    )
    expect(report.路径A.错误归并率).toBeGreaterThan(0)
    expect(report.路径A.结论).toBe('不放量')
    expect(report.路径A.错误归并候选).toEqual(['A3', 'A5'])
    expect(report.路径B.结论).toBe('不放量')
    expect(report.路径B.错误归并候选).toEqual(['A4'])
    expect(report.模型路径实连).toBe(true)
    expect(report.退出码).toBe(1)
  })

  it('错误归并数 = 0 时结论「允许人工灰度(仍需人工确认)」', () => {
    const f = fixture()
    const pathA: PathAResult[] = f.annotations.map((a) => ({
      candidate_id: a.candidate_id, action: a.expected_action,
      target_code: a.expected_target_code, ambiguous_top_hits: 0,
    }))
    const pathB: PathBResult[] = f.annotations.map((a) => ({
      candidate_id: a.candidate_id, action: a.expected_action,
      target_code: a.expected_target_code, degraded: false,
    }))
    const report = compareAll(
      f.annotations, f.candidates, f.masterData, pathA, pathB,
      { modelConfigured: true, dataset: FIXTURE_DATASET },
    )
    expect(report.路径A.错误归并数).toBe(0)
    expect(report.路径B.错误归并数).toBe(0)
    expect(report.路径A.结论).toBe('允许人工灰度(仍需人工确认)')
    expect(report.路径B.结论).toBe('允许人工灰度(仍需人工确认)')
    expect(report.退出码).toBe(2)
  })

  it('退出码区分「未验证」「不放量」「允许人工灰度」三种结论', () => {
    expect(EXIT_CODE_BY_VERDICT['未验证']).toBe(0)
    expect(EXIT_CODE_BY_VERDICT['不放量']).toBe(1)
    expect(EXIT_CODE_BY_VERDICT['允许人工灰度(仍需人工确认)']).toBe(2)
  })
})

describe('Task 51 诚实降级', () => {
  it('路径B 全部 degraded 且未声明实连 → 结论「未验证」，报告逐字写出诚实降级声明', () => {
    const f = fixture()
    const pathB: PathBResult[] = f.pathB.map((row) => ({ ...row, degraded: true }))
    const report = compareAll(
      f.annotations, f.candidates, f.masterData, f.pathA, pathB,
      { now: () => FIXED_NOW, dataset: FIXTURE_DATASET },
    )
    expect(report.模型路径实连).toBe(false)
    expect(report.路径B.结论).toBe('未验证')
    expect(report.路径B.结论).not.toBe('不放量')
    expect(report.路径B.结论).not.toBe('允许人工灰度(仍需人工确认)')
    expect(report.诚实降级声明).toBe(HONEST_DEGRADE_STATEMENT)
    expect(report.路径B降级数).toBe(7)
    expect(report.路径B规则短路数).toBe(0)
    expect(report.退出码).toBe(0)
    expect(renderJson(report)).toContain('模型路径未实连，仅基线可核验')
    expect(renderMarkdown(report)).toContain('模型路径未实连，仅基线可核验')
    // 路径A 不受影响，仍是真实门禁结论
    expect(report.路径A.结论).toBe('不放量')
    expect(report.路径A.错误归并候选).toEqual(['A3', 'A5'])
  })

  it('混合降级（部分 degraded=false 的规则短路）在未实连时同样判「未验证」', () => {
    const f = fixture()
    const pathB: PathBResult[] = f.pathB.map((row, i) => ({
      ...row, degraded: i < 2,
    }))
    const report = compareAll(
      f.annotations, f.candidates, f.masterData, f.pathA, pathB,
      { dataset: FIXTURE_DATASET },
    )
    expect(report.路径B降级数).toBe(2)
    expect(report.路径B规则短路数).toBe(5)
    expect(report.路径B.错误归并数).toBe(1)
    expect(report.路径B.结论).toBe('未验证')
    expect(report.退出码).toBe(0)
    expect(renderMarkdown(report)).toContain('闸门/规则短路数：**5 / 7**')
  })

  it('即使声明 --model-configured，本批仍有 degraded 结论时也退回「未验证」', () => {
    const f = fixture()
    const pathB: PathBResult[] = f.pathB.map((row) => ({ ...row, degraded: true }))
    const report = compareAll(
      f.annotations, f.candidates, f.masterData, f.pathA, pathB,
      { modelConfigured: true, dataset: FIXTURE_DATASET },
    )
    expect(report.模型路径实连).toBe(false)
    expect(report.路径B.结论).toBe('未验证')
    expect(report.诚实降级声明).toBe(HONEST_DEGRADE_STATEMENT)
    expect(report.退出码).toBe(0)
  })
})

describe('Task 51 可复现与码制对照', () => {
  it('相同输入两次 compareAll 结果深度相等且 JSON 字节一致', () => {
    const f = fixture()
    const args = [
      f.annotations, f.candidates, f.masterData, f.pathA, f.pathB,
      { now: () => FIXED_NOW, modelConfigured: true, dataset: FIXTURE_DATASET },
    ] as const
    const first = compareAll(...args)
    const second = compareAll(...args)
    expect(second).toEqual(first)
    expect(renderJson(second)).toBe(renderJson(first))

    // 换固定时钟只改元数据，指标与逐条差异不变
    const shifted = compareAll(
      f.annotations, f.candidates, f.masterData, f.pathA, f.pathB,
      { now: () => '2000-01-01T00:00:00Z', modelConfigured: true, dataset: FIXTURE_DATASET },
    )
    expect(shifted.生成时间).toBe('2000-01-01T00:00:00Z')
    expect(shifted.路径A).toEqual(first.路径A)
    expect(shifted.路径B).toEqual(first.路径B)
    expect(shifted.逐条差异).toEqual(first.逐条差异)
  })

  it('码制报告声明 docx 缺失、未咨询、无符合性声称，并给出具体下一步', () => {
    const docx = resolve(
      projectRoot,
      'domain/corpus/dictionary/code_rules_15_医疗保障定点医疗机构等10项信息业务编码规则和方法共15项编码标准.docx',
    )
    expect(existsSync(docx)).toBe(false)

    const text = renderCodeRulesCheck()
    expect(text).toContain(CODE_RULES_STATUS)
    expect(text).toContain('不存在')
    expect(text).toContain('未咨询、未打开、未引用')
    expect(text).toContain('未据其判定符合性')
    expect(text).toContain('XJ + 13 位数字')
    expect(text).toContain('MANIFEST.json:157')
    expect(text).toContain('length < 8')
    expect(text).toContain('config/unit-alias.json')
    expect(text).toContain('dose_form')
    expect(text).toContain('具体下一步')
    expect(text).not.toContain('已对齐医保发')
    expect(text).not.toContain('已核验符合')
    expect(text).not.toContain('经权威确认')
  })
})

describe('Task 51 真实语料与产物', () => {
  it('真实基线把至少一条「同名异规格」或「医保码错配」候选错误归并', () => {
    const { candidates, masterData } = loadCorpus()
    const expected = readExpected()
    const byId = new Map(expected.annotations.map((a) => [a.candidate_id, a]))
    const specDiff = candidates.find((c) => c.candidate_id.startsWith('CAND-SPECDIFF-'))!
    const codeMis = candidates.find((c) => c.candidate_id.startsWith('CAND-CODEMIS-'))!

    for (const candidate of [specDiff, codeMis]) {
      const annotation = byId.get(candidate.candidate_id)!
      const baseline = baselineConclude(candidate, masterData)
      expect(baseline.action).toBe('merge')
      expect(baseline.target_code).not.toBeNull()
      expect(isWrongMerge(annotation, baseline)).toBe(true)
    }
    expect(String(specDiff.source_note)).toContain('同名异规格')
    expect(String(codeMis.source_note)).toContain('医保码错配')
  })

  it('注入预计算路径B 结论后，真实 160 条标注生成样本量=160 的报告', () => {
    const { candidates, masterData } = loadCorpus()
    const expected = readExpected()
    expect(expected.annotations).toHaveLength(160)

    // 路径A 是廉价确定性基线；路径B 注入「全量降级」假结论，避免单测里跑 160 次引擎
    const pathA = candidates.map((c) => baselineConclude(c, masterData))
    const pathB: PathBResult[] = candidates.map((c) => ({
      candidate_id: c.candidate_id, action: 'uncertain', target_code: null, degraded: true,
    }))
    const report = compareAll(
      expected.annotations, candidates, masterData, pathA, pathB,
      { now: () => FIXED_NOW, dataset: readDatasetMeta() },
    )

    expect(report.样本量).toBe(160)
    expect(report.数据集版本.deterministic_seed).toBe(20240433)
    expect(report.数据集版本.master_data_count).toBe(320)
    expect(report.逐条差异.full_matrix).toHaveLength(160)
    expect(report.逐条差异.full_matrix.every((row) => row.expected_code_resolved)).toBe(true)
    expect(report.路径A.错误归并数).toBeGreaterThan(0)
    expect(report.路径A.结论).toBe('不放量')
    expect(report.路径B.结论).toBe('未验证')
    expect(report.退出码).toBe(0)
    expect(readJson('tests/fixtures/benchmark/expected.json').counts.total).toBe(160)
  })

  it('可运行入口以固定 now 生成 JSON / MD / 码制报告（含全量矩阵 CSV）', async () => {
    const f = fixture()
    const tmp = mkdtempSync(join(tmpdir(), 'compare-benchmark-'))
    try {
      const result = await runCompare({
        annotations: f.annotations,
        candidates: f.candidates,
        masterData: f.masterData,
        pathAResults: f.pathA,
        pathBResults: f.pathB,
        now: () => FIXED_NOW,
        dataset: FIXTURE_DATASET,
        outDir: tmp,
      })

      expect(result.report.生成时间).toBe(FIXED_NOW)
      expect(result.report.固定时钟).toBe(FIXED_NOW)
      for (const file of [result.files.json, result.files.markdown, result.files.codeRules]) {
        expect(existsSync(file)).toBe(true)
      }

      const jsonText = readFileSync(result.files.json, 'utf8')
      const mdText = readFileSync(result.files.markdown, 'utf8')
      const rulesText = readFileSync(result.files.codeRules, 'utf8')
      expect(jsonText).toBe(renderJson(result.report))
      expect(JSON.parse(jsonText).样本量).toBe(7)

      for (const phrase of ['样本量', '命中率', '错误归并率', '漏并率', '存疑率', '逐条差异', '模型路径未实连，仅基线可核验']) {
        expect(jsonText).toContain(phrase)
        expect(mdText).toContain(phrase)
      }
      expect(rulesText).toContain(CODE_RULES_STATUS)

      const csv = toCsv(result.report)
      expect(csv.trimEnd().split('\n')).toHaveLength(8) // 表头 + 7 行
      expect(csv.split('\n')[0]).toContain('pathA_wrong_merge')
      expect(mdText).toContain(csv.trimEnd().split('\n')[0])
      expect(mdText).toContain('### 全量矩阵（CSV）')
      expect(result.exitCode).toBe(0) // 未声明端点实连 → 未验证 → 0
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
