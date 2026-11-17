/**
 * 主干最窄端到端切片（Task 3）。
 *
 * 用基准语料跑「读候选 → 检索 → 归并 → 建议 JSON」全链路，断言产物落盘且
 * 每条建议对齐 spec.md §2（action/target_code/confidence/rationale/evidence[]，
 * 每条 evidence 带 record_id）。检索走内存驱动、模型走离线降级，全程无网络。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inMemoryRetriever, loadCorpus, runMerge, toSuggestionWire } from '../../scripts/run-merge'
import type { MergeConclusion } from '@core/types'

const FIXED_NOW = '2024-07-01T00:00:00.000Z'

describe('主干最窄端到端切片（Task 3）', () => {
  it('基准语料可读取：主数据 ≥300、候选 ≥150', () => {
    const { candidates, masterData } = loadCorpus()
    expect(masterData.length).toBeGreaterThanOrEqual(300)
    expect(candidates.length).toBeGreaterThanOrEqual(150)
  })

  it('内存检索驱动：域内召回，跨域记录不进入命中池', async () => {
    const { masterData } = loadCorpus()
    const retrieve = inMemoryRetriever(masterData)
    const candidate = {
      candidate_id: 'E2E-1', domain: 'drug' as const, name: '阿莫西林',
      spec: '0.25g*12片', dosage_form: '胶囊剂', unit: '盒', insurance_code: 'XJ7000000000001',
    }
    const outcome = await retrieve(candidate)
    expect(outcome.kind).toBe('retrieved_ok')
    if (outcome.kind === 'retrieved_ok') {
      expect(outcome.records.every((r) => r.domain === 'drug')).toBe(true)
    }
  })

  it('跑一条候选 → 建议 JSON 落盘且含 1 条建议，evidence[] 每条带 record_id', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'merge-slice-'))
    try {
      const r = await runMerge({ limit: 1, outDir, now: () => FIXED_NOW })
      expect(existsSync(r.outFile)).toBe(true)
      expect(r.suggestions).toHaveLength(1)
      const payload = JSON.parse(readFileSync(r.outFile, 'utf8'))
      expect(payload.total).toBe(1)
      expect(payload.suggestions).toHaveLength(1)
      const s = payload.suggestions[0]
      expect(['create', 'merge', 'uncertain']).toContain(s.action)
      expect(typeof s.confidence).toBe('number')
      expect(typeof s.rationale).toBe('string')
      expect(Array.isArray(s.evidence)).toBe(true)
      expect(s.evidence.every((e: { record_id: string }) => typeof e.record_id === 'string' && e.record_id.length > 0)).toBe(true)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('批量切片：8 条候选 → 8 条建议，动作计数与条数自洽，产物含样本量与降级标记', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'merge-slice-batch-'))
    try {
      const r = await runMerge({ limit: 8, outDir, now: () => FIXED_NOW })
      expect(r.suggestions).toHaveLength(8)
      const sum = Object.values(r.actionCounts).reduce((a, b) => a + b, 0)
      expect(sum).toBe(8)
      const payload = JSON.parse(readFileSync(r.outFile, 'utf8'))
      expect(payload.batch_id).toBe('sample-batch')
      expect(payload.total).toBe(8)
      expect(typeof payload.degraded_count).toBe('number')
      expect(typeof payload.note).toBe('string')
      // 离线降级诚实标注：degraded_count 与逐条 degraded 一致
      const degradedInRows = payload.suggestions.filter((s: { degraded: boolean }) => s.degraded).length
      expect(payload.degraded_count).toBe(degradedInRows)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('toSuggestionWire 收敛规则层附加字段：不泄漏凭据/统计，只保留 spec §2 线格式', () => {
    const conclusion: MergeConclusion = {
      candidate_id: 'C-1', domain: 'drug', action: 'merge', target_code: 'CODE-1',
      confidence: 0.91234, rationale: '唯一命中', uncertain_reason: null,
      evidence: [{ record_id: 'MD-1', field: 'insurance_code', candidate_value: 'X', matched_value: 'X', evidence_mismatch: false }],
      missing_fields: [], degraded: false, source: 'model',
      statistics: { raw_hit_count: 3 }, decided_at: FIXED_NOW,
    }
    const wire = toSuggestionWire(conclusion)
    expect(Object.keys(wire).sort()).toEqual([
      'action', 'candidate_id', 'confidence', 'decided_at', 'degraded',
      'domain', 'evidence', 'rationale', 'target_code', 'uncertain_reason',
    ].sort())
    expect(wire.confidence).toBe(0.9123)
    expect(wire.evidence[0]).toEqual({
      record_id: 'MD-1', field: 'insurance_code', candidate_value: 'X', matched_value: 'X',
    })
    expect(JSON.stringify(wire)).not.toContain('statistics')
    expect(JSON.stringify(wire)).not.toContain('api_key')
  })
})
