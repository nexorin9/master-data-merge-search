import { describe, expect, it, vi } from 'vitest'
import type {
  CandidateRecord, MasterDataRecord, MergeConclusion, ModelCallLog,
} from '@core/types'
import { evaluateCandidate } from '@core/engine/merge-engine'
import { createReplayLedger } from '@core/writeback/idempotency'
import { inMemoryRetriever } from '../../scripts/run-merge'
import {
  BLOCKED_REPLAY_FETCH,
  createOfflineConfig,
  masterDataVersion,
  replayToText,
  runReplay,
  type ReplayCorpus,
  type ReplayDeps,
  type ReplayWriter,
} from '../../src/cli/replay'
import {
  buildExportCsv,
  EXPORT_CSV_COLUMNS,
  exportToText,
  runExport,
  toExportSheetRow,
  type ExportWriterInput,
  type SuggestionExportRow,
} from '../../src/cli/export'
import { dispatch, parseArgs } from '../../src/cli/index'

const FIXED_NOW = '2026-11-10T09:00:00.000Z'
const clock = (): string => FIXED_NOW

/** 空主数据池 → no-match 闸门 → create，确定性且不进入模型阶段。 */
const CANDIDATE: CandidateRecord = {
  candidate_id: 'CAND-CLI-001',
  domain: 'drug',
  name: '测试药',
  spec: '10mg*7片',
  dosage_form: '片剂',
  unit: '盒',
  insurance_code: 'XJCLI0000000001',
}
const CORPUS: ReplayCorpus = { candidates: [CANDIDATE], masterData: [] }

/** 额外一层保险：如果误入模型阶段，测试立即失败而不是触网。 */
const NO_NETWORK: typeof fetch = async () => {
  throw new Error('测试禁止真实网络请求')
}

function replayDeps(overrides: Partial<ReplayDeps> = {}): ReplayDeps {
  return {
    config: createOfflineConfig(),
    corpus: CORPUS,
    retrieve: inMemoryRetriever(CORPUS.masterData),
    now: clock,
    fetchImpl: NO_NETWORK,
    ...overrides,
  }
}

function fakeWriter() {
  return vi.fn(async (_candidateId: string, _body: unknown, _key: string) => ({
    ok: true as const,
    status: 200,
    data: { accepted: true },
  }))
}

const FIXED_CONCLUSION: MergeConclusion = {
  candidate_id: 'CAND-CLI-001',
  domain: 'drug',
  action: 'merge',
  target_code: 'MD-0001',
  confidence: 0.92,
  rationale: '规格与医保码唯一命中，建议归并',
  evidence: [{
    record_id: 'MD-0001', field: 'spec',
    candidate_value: '10mg*7片', matched_value: '10mg*7片',
  }],
  uncertain_reason: null,
  missing_fields: [],
  degraded: false,
  decided_at: FIXED_NOW,
}

const FIXED_CALL_LOG: ModelCallLog = {
  model_call_id: 'mc-fixed-001',
  candidate_id: 'CAND-CLI-001',
  model: 'merge-model-v1',
  base_url: 'https://llm.example.test',
  prompt_hash: 'prompt-hash-fixed',
  input_tokens: 120,
  output_tokens: 40,
  latency_ms: 0,
  finish_reason: 'stop',
  schema_valid: true,
  degraded_reason: null,
  api_key_masked: 'llm****ef',
  created_at: FIXED_NOW,
}

function cleanRow(candidateId: string, batchId = 'B-001', confirmedBy = 'system'): SuggestionExportRow {
  return {
    batch_id: batchId,
    candidate_id: candidateId,
    action: 'merge',
    target_code: 'MD-0001',
    rationale: '规格与医保码唯一命中，建议归并',
    evidence: [{
      record_id: 'MD-0001', field: 'spec',
      candidate_value: '10mg*7片', matched_value: '10mg*7片',
    }],
    confirmed_by: confirmedBy,
    receipt_status: 'success',
  }
}

/** 按 input 顺序给的三行；导出会按批次稳定排序并重排固定序号。 */
const CLEAN_ROWS: SuggestionExportRow[] = [
  cleanRow('CAND-2', 'B-002'),
  cleanRow('CAND-1', 'B-001'),
  {
    ...cleanRow('CAND-3', 'B-001'),
    action: 'uncertain',
    target_code: null,
    rationale: '多义命中',
    receipt_status: '',
  },
]

describe('运维 CLI · replay（Task 53）', () => {
  it('默认只读：不进入写回编排，注入 writer 零调用', async () => {
    const writer = fakeWriter()
    const r = await runReplay('CAND-CLI-001', replayDeps({ writer }))

    expect(r.found).toBe(true)
    expect(r.conclusion?.action).toBe('create')
    expect(r.evidence).toEqual([])
    expect(r.model_call_logs).toEqual([])
    expect(r.write_attempted).toBe(false)
    expect(r.write_result).toBeNull()
    expect(writer).not.toHaveBeenCalled()
    expect(r.notes.some((n) => n.includes('默认只读'))).toBe(true)
  })

  it('--write=false 零写入；dispatch 解析后同样不触碰 writer', async () => {
    const args = parseArgs(['replay', '--candidate', 'CAND-CLI-001', '--write=false'])
    expect(args.command).toBe('replay')
    expect(args.candidate).toBe('CAND-CLI-001')
    expect(args.write).toBe(false)

    const writer = fakeWriter()
    const offline = await runReplay('CAND-CLI-001', replayDeps({ write: false, confirmed: true, writer }))
    expect(offline.write_attempted).toBe(false)
    expect(writer).not.toHaveBeenCalled()

    const dispatched = await dispatch(args, {
      env: {},
      now: clock,
      replayDeps: {
        corpus: CORPUS,
        retrieve: inMemoryRetriever(CORPUS.masterData),
        now: clock,
        fetchImpl: NO_NETWORK,
        writer,
      },
    })
    expect(dispatched.exitCode).toBe(0)
    expect(writer).not.toHaveBeenCalled()
  })

  it('--write=true 经确认闸门后路由到注入 writer，并带 64 位幂等键', async () => {
    const args = parseArgs(['replay', '--candidate', 'CAND-CLI-001', '--write'])
    expect(args.write).toBe(true)

    const writer = fakeWriter()
    const r = await runReplay('CAND-CLI-001', replayDeps({ write: true, confirmed: true, writer }))

    expect(r.write_attempted).toBe(true)
    expect(writer).toHaveBeenCalledTimes(1)
    expect(writer.mock.calls[0]![0]).toBe('CAND-CLI-001')
    expect(writer.mock.calls[0]![2]).toMatch(/^[0-9a-f]{64}$/)
    expect(r.write_result?.status).toBe('success')
    expect(r.write_result?.sink_calls).toBe(1)
    expect(r.write_result?.submission_kind).toBe('fresh')
    expect(r.write_result?.idempotency_key).toBe(writer.mock.calls[0]![2])
  })

  it('确认闸门默认关闭：write=true 但 confirmed=false 时 sink 零调用', async () => {
    const writer = fakeWriter()
    const r = await runReplay('CAND-CLI-001', replayDeps({ write: true, confirmed: false, writer }))

    expect(r.write_attempted).toBe(true)
    expect(writer).not.toHaveBeenCalled()
    expect(r.write_result?.status).toBe('skipped')
    expect(r.write_result?.sink_calls).toBe(0)
    expect(r.write_result?.kind).toBe('unconfirmed')
  })

  it('write=true 缺省即视为显式确认；writer 返回 void 时按已接受归一化', async () => {
    const writer = fakeWriter()
    const confirmedByFlag = await runReplay('CAND-CLI-001', replayDeps({ write: true, writer }))
    expect(writer).toHaveBeenCalledTimes(1)
    expect(confirmedByFlag.write_result?.status).toBe('success')

    const voidWriter = vi.fn(async () => undefined)
    const tolerated = await runReplay('CAND-CLI-001', replayDeps({
      write: true,
      writer: voidWriter as unknown as ReplayWriter,
    }))
    expect(voidWriter).toHaveBeenCalledTimes(1)
    expect(tolerated.write_result?.status).toBe('success')
  })

  it('共享重放账本保证同一结论二次写回走幂等跳过，不重复调 sink', async () => {
    const replayLedger = createReplayLedger({ now: clock })
    const writer = fakeWriter()
    const deps = replayDeps({ write: true, confirmed: true, writer, replayLedger })

    const first = await runReplay('CAND-CLI-001', deps)
    const second = await runReplay('CAND-CLI-001', deps)

    expect(first.write_result?.submission_kind).toBe('fresh')
    expect(second.write_result?.submission_kind).toBe('replay')
    expect(second.write_result?.status).toBe('skipped')
    expect(second.write_result?.sink_calls).toBe(0)
    expect(second.write_result?.idempotency_key).toBe(first.write_result?.idempotency_key)
    expect(writer).toHaveBeenCalledTimes(1)
  })

  it('重放结论逐字段等于直接调用 evaluateCandidate（同一引擎主路径）', async () => {
    const deps = replayDeps()
    const direct = await evaluateCandidate(CANDIDATE, {
      config: deps.config!,
      retrieve: deps.retrieve!,
      now: deps.now!,
    })
    const replayed = await runReplay('CAND-CLI-001', deps)

    expect(direct.model_call_logs).toEqual([]) // 闸门确定性定案，未触模型
    expect(replayed.conclusion).toEqual(direct.conclusion)
    expect(replayed.evidence).toEqual(direct.conclusion.evidence)
    expect(replayed.model_call_logs).toEqual(direct.model_call_logs)
    expect(replayed.degraded).toBe(direct.degraded)
  })

  it('同输入两次重放逐字段可复现，并声明版本绑定', async () => {
    const deps = replayDeps()
    const a = await runReplay('CAND-CLI-001', deps)
    const b = await runReplay('CAND-CLI-001', deps)

    expect(a).toEqual(b)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(a.context.decided_at).toBe(FIXED_NOW)
    expect(a.context.master_data_version).toBe(masterDataVersion(CORPUS.masterData))
    expect(a.notes.some((n) => n.includes('prompt 或主数据版本变化'))).toBe(true)
  })

  it('prompt / 主数据版本变化时，上下文与说明随之变化（结论可能不同）', async () => {
    const baseline = await runReplay('CAND-CLI-001', replayDeps())
    const versioned = await runReplay('CAND-CLI-001', replayDeps({
      promptVersion: 'merge-protocol-v2:merge-model-v1',
      masterDataVersion: 'master-data-v2',
    }))
    expect(versioned.context.prompt_version).toBe('merge-protocol-v2:merge-model-v1')
    expect(versioned.context.master_data_version).toBe('master-data-v2')
    expect(versioned.notes[0]).not.toBe(baseline.notes[0])

    // 主数据内容变化（这里加一条域外记录，仍走确定性闸门）也要被指纹捕获
    const changedPool: ReplayCorpus = {
      candidates: CORPUS.candidates,
      masterData: [{
        code: 'MD-NEW', record_id: 'MD-NEW', domain: 'exam',
        name: '无关记录', status: '启用', version: '2',
      } satisfies MasterDataRecord],
    }
    const changed = await runReplay('CAND-CLI-001', replayDeps({
      corpus: changedPool,
      retrieve: inMemoryRetriever(changedPool.masterData),
    }))
    expect(changed.context.master_data_version).not.toBe(baseline.context.master_data_version)
    expect(changed.write_attempted).toBe(false)
  })

  it('注入 evaluate 端口时，原样透出结论、证据链与模型调用元数据', async () => {
    const evaluate = vi.fn(async () => ({
      conclusion: FIXED_CONCLUSION,
      model_call_logs: [FIXED_CALL_LOG],
      degraded: false,
    }))
    const r = await runReplay('CAND-CLI-001', replayDeps({ evaluate }))

    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(r.conclusion).toEqual(FIXED_CONCLUSION)
    expect(r.evidence).toEqual(FIXED_CONCLUSION.evidence)
    expect(r.model_call_logs).toEqual([FIXED_CALL_LOG])
    const text = replayToText(r)
    expect(text).toContain('模型调用元数据（1 条）')
    expect(text).toContain('prompt-hash-fixed')
  })

  it('未知候选返回 found=false，dispatch 给出非零退出码', async () => {
    const r = await runReplay('CAND-NOT-EXIST', replayDeps())
    expect(r.found).toBe(false)
    expect(r.conclusion).toBeNull()
    expect(r.write_attempted).toBe(false)

    const dispatched = await dispatch(parseArgs(['replay', '--candidate', 'CAND-NOT-EXIST']), {
      env: {},
      now: clock,
      replayDeps: { corpus: CORPUS, retrieve: inMemoryRetriever(CORPUS.masterData), now: clock },
    })
    expect(dispatched.exitCode).toBe(1)
    expect(dispatched.stdout).toContain('CAND-NOT-EXIST')
  })

  it('dispatch --json 输出可解析的重放结果，且不误写', async () => {
    const writer = fakeWriter()
    const dispatched = await dispatch(
      parseArgs(['replay', '--candidate', 'CAND-CLI-001', '--json']),
      {
        env: {},
        now: clock,
        replayDeps: {
          corpus: CORPUS,
          retrieve: inMemoryRetriever(CORPUS.masterData),
          now: clock,
          fetchImpl: NO_NETWORK,
          writer,
        },
      },
    )
    expect(dispatched.exitCode).toBe(0)
    expect(JSON.parse(dispatched.json!)).toMatchObject({
      candidate_id: 'CAND-CLI-001', found: true, write_attempted: false,
    })
    expect(writer).not.toHaveBeenCalled()
  })

  it('缺省 fetch 端口是阻断型：库调用默认零外联，CLI 凭据齐全才注入真实 fetch', async () => {
    const direct = await runReplay('CAND-CLI-001', replayDeps({ fetchImpl: undefined }))
    expect(direct.found).toBe(true)
    expect(direct.write_attempted).toBe(false)
    expect(BLOCKED_REPLAY_FETCH).toBeTypeOf('function')
  })
})

describe('运维 CLI · export（Task 53）', () => {
  it('CSV 固定列顺序与 audit-export 约定一致，按批次稳定排序并给固定序号', async () => {
    const r = await runExport(CLEAN_ROWS, { now: clock })

    expect(r.ok).toBe(true)
    expect(r.columns).toEqual(EXPORT_CSV_COLUMNS)
    const lines = r.csv!.split('\n')
    expect(lines).toHaveLength(CLEAN_ROWS.length + 1)
    expect(lines[0]).toBe('序号,批次,候选,结论动作,目标 code,理由,逐字段证据,确认人,回执状态')
    expect(lines[1]).toContain('1,B-001,CAND-1,merge,MD-0001')
    expect(lines[2]).toContain('2,B-001,CAND-3,uncertain')
    expect(lines[3]).toContain('3,B-002,CAND-2,merge')
    expect(r.groups).toEqual([
      { batch_id: 'B-001', count: 2, first_seq: 1, last_seq: 2 },
      { batch_id: 'B-002', count: 1, first_seq: 3, last_seq: 3 },
    ])
  })

  it('投影函数稳定：同一行两次投影逐字段相等', () => {
    const a = toExportSheetRow(cleanRow('CAND-1'), 1, 'B-001')
    const b = toExportSheetRow(cleanRow('CAND-1'), 1, 'B-001')
    expect(a).toEqual(b)
    expect(a['逐字段证据']).toContain('MD-0001.spec')
  })

  it('含姓名形态值的行整批拒绝，精确定位命中行且不回显完整姓名', async () => {
    const rows = [cleanRow('CAND-1'), cleanRow('CAND-2', 'B-001', '张三')]
    const writer = vi.fn(async (input: ExportWriterInput) => ({ json_file: `${input.out}.json` }))
    const r = await runExport(rows, { now: clock, out: '/tmp/should-not-be-written', writer })

    expect(r.ok).toBe(false)
    expect(r.json).toBeUndefined()
    expect(r.csv).toBeUndefined()
    expect(writer).not.toHaveBeenCalled()
    expect(r.rejected_rows).toHaveLength(1)
    expect(r.rejected_rows?.[0]).toMatchObject({
      index: 1, 序号: 2, 候选: 'CAND-2', candidate_id: 'CAND-2',
    })
    expect(r.rejected_rows?.[0].hits.some((h) => h.type === 'name_field')).toBe(true)
    expect(JSON.stringify(r.rejected_rows)).not.toContain('张三')
    expect(r.reason).toContain('隐私闸门')
  })

  it('证件号形态值同样整批拒绝，writer 零调用', async () => {
    const rows = [cleanRow('CAND-1'), {
      ...cleanRow('CAND-2'),
      note: '身份证号：110101199001011234',
    }]
    const writer = vi.fn(async (input: ExportWriterInput) => ({ json_file: `${input.out}.json` }))
    const r = await runExport(rows, { now: clock, writer })

    expect(r.ok).toBe(false)
    expect(r.rejected_rows?.[0].hits.some((h) => h.type === 'id_card')).toBe(true)
    expect(writer).not.toHaveBeenCalled()
  })

  it('干净导出同时产出 JSON 与 CSV，并经注入 writer 输出可读 sheet 文件', async () => {
    const writer = vi.fn(async (input: ExportWriterInput) => ({
      json_file: `${input.out}.json`,
      csv_file: `${input.out}.csv`,
      txt_file: `${input.out}.txt`,
      rows: input.sheet.length,
    }))
    const r = await runExport(CLEAN_ROWS, {
      now: clock, out: '/tmp/cli-export-demo', writer,
    })

    expect(r.ok).toBe(true)
    const parsed = JSON.parse(r.json!)
    expect(parsed).toMatchObject({ command: 'export', row_count: CLEAN_ROWS.length })
    expect(parsed.columns).toEqual([...EXPORT_CSV_COLUMNS])
    expect(parsed.rows[0].序号).toBe(1)
    expect(parsed.rows[0].候选).toBe('CAND-1')
    expect(r.csv).toContain('MD-0001')
    expect(writer).toHaveBeenCalledTimes(1)
    expect(writer.mock.calls[0]![0].out).toBe('/tmp/cli-export-demo')
    expect(writer.mock.calls[0]![0].txt).toContain('序号 ｜ 批次')
    expect(r.writer_result?.rows).toBe(CLEAN_ROWS.length)
    expect(exportToText(r)).toContain('导出完成')
  })

  it('CSV 安全转义：公式注入加前缀，逗号/引号按标准引号包裹', async () => {
    const r = await runExport([{
      ...cleanRow('CAND-1'),
      rationale: '=cmd|calc',
      evidence: 'a,b"c',
    }], { now: clock })

    expect(r.ok).toBe(true)
    expect(r.csv).toContain("'=cmd|calc")
    expect(r.csv).toContain('"a,b""c"')
    expect(buildExportCsv([toExportSheetRow(cleanRow('CAND-1'), 1, 'B-001')]).split('\n'))
      .toHaveLength(2)
  })

  it('兼容中文列名输入：投影与分组仍按固定列顺序产出', async () => {
    const rows = [{
      批次: '批次-A',
      候选: 'CAND-ZH-1',
      结论动作: 'merge',
      '目标 code': 'MD-ZH-1',
      理由: '唯一命中',
      逐字段证据: 'MD-ZH-1.spec: 10mg*7片 → 10mg*7片',
      确认人: 'system',
      回执状态: 'success',
    }]
    const r = await runExport(rows, { now: clock })

    expect(r.ok).toBe(true)
    expect(r.groups[0]?.batch_id).toBe('批次-A')
    const parsed = JSON.parse(r.json!)
    expect(parsed.rows[0]).toMatchObject({
      序号: 1, 批次: '批次-A', 候选: 'CAND-ZH-1', 结论动作: 'merge', '目标 code': 'MD-ZH-1',
    })
    expect(r.csv!.split('\n')[0]).toBe('序号,批次,候选,结论动作,目标 code,理由,逐字段证据,确认人,回执状态')
  })

  it('dispatch export --json 用注入行产出可解析 JSON，不读盘也不写盘', async () => {
    const args = parseArgs(['export', '--json', '--out', '/tmp/cli-export-dispatched'])
    expect(args.command).toBe('export')
    expect(args.json).toBe(true)
    expect(args.out).toBe('/tmp/cli-export-dispatched')

    const writer = vi.fn(async (input: ExportWriterInput) => ({ json_file: `${input.out}.json` }))
    const dispatched = await dispatch(args, {
      env: {},
      now: clock,
      exportRows: CLEAN_ROWS,
      exportDeps: { writer, now: clock },
    })

    expect(dispatched.exitCode).toBe(0)
    expect(JSON.parse(dispatched.json!)).toMatchObject({
      command: 'export', row_count: CLEAN_ROWS.length, batch_count: 2,
    })
    expect(writer).toHaveBeenCalledTimes(1)
  })
})
