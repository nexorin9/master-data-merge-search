/**
 * 渲染层组件 SSR 测试（node 环境，无 jsdom）。
 * 用 @vue/server-renderer 的 renderToString 真实渲染组件并断言 HTML 输出，
 * 覆盖三态标签、字段对照、证据不一致、禁用态文案、确认框 0 选中提示等。
 */
import { describe, expect, it } from 'vitest'
import { createSSRApp, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIELD_DIFF_ORDER } from '@core/constants'
import type {
  BatchSummary,
  CandidateRecord,
  EvidenceItem,
  FieldDiff,
  FollowupTurn,
  MasterDataRecord,
  MergeConclusion,
  WriteReceipt,
} from '@core/types'

import App from '../../src/renderer/App.vue'
import BaseButton from '../../src/renderer/components/base/BaseButton.vue'
import BaseInput from '../../src/renderer/components/base/BaseInput.vue'
import BaseModal from '../../src/renderer/components/base/BaseModal.vue'
import BaseSelect from '../../src/renderer/components/base/BaseSelect.vue'
import BaseTable from '../../src/renderer/components/base/BaseTable.vue'
import BaseTag from '../../src/renderer/components/base/BaseTag.vue'
import CandidateCard from '../../src/renderer/components/CandidateCard.vue'
import ConfirmDialog from '../../src/renderer/components/ConfirmDialog.vue'
import DegradeBanner from '../../src/renderer/components/DegradeBanner.vue'
import EvidenceTable from '../../src/renderer/components/EvidenceTable.vue'
import FieldCompare from '../../src/renderer/components/FieldCompare.vue'
import ReceiptList from '../../src/renderer/components/ReceiptList.vue'
import SessionPane from '../../src/renderer/components/SessionPane.vue'
import StatusBar from '../../src/renderer/components/StatusBar.vue'
import ToastStack from '../../src/renderer/components/ToastStack.vue'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string): string => readFileSync(resolve(projectRoot, relative), 'utf8')

function render(component: Component, props: Record<string, unknown> = {}): Promise<string> {
  return renderToString(createSSRApp(component, props))
}

/** 去掉 SSR 注释锚点与标签，得到可比对的纯文本。 */
function textOf(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 从 HTML 中定位含指定文案的按钮开标签，用于断言 disabled 等属性。 */
function buttonWithText(html: string, needle: string): string | null {
  for (const match of html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)) {
    if (textOf(match[0]).includes(needle)) return match[0]
  }
  return null
}

function rowAttrs(html: string, field: string): string {
  return html.match(new RegExp(`<div[^>]*data-field="${field}"[^>]*>`))?.[0] ?? ''
}

// ── 固定样例数据（不依赖 fixtures 文件，驱动确定性渲染）──
const candidate: CandidateRecord = {
  candidate_id: 'CAND-DEMO-001',
  domain: 'drug',
  name: '先锋四号',
  spec: '100ml*1瓶',
  dosage_form: '口服溶液剂',
  unit: '瓶',
  insurance_code: 'XJ7000000000146',
}

const secondCandidate: CandidateRecord = {
  candidate_id: 'CAND-DEMO-002',
  domain: 'drug',
  name: '待评候选',
  spec: '10mg*7片',
  unit: '盒',
}

const target: MasterDataRecord = {
  code: 'YP000147',
  record_id: 'MD-000147',
  domain: 'drug',
  name: '头孢氨苄',
  spec: '100ml*1瓶',
  dosage_form: '口服溶液剂',
  unit: '瓶',
  status: '启用',
  version: 'v1',
}

const diffs: FieldDiff[] = [
  { field: 'unit', candidate_value: '瓶', matched_value: '瓶', equal: true, kind: 'exact' },
  {
    field: 'insurance_code',
    candidate_value: 'XJ7000000000146',
    matched_value: 'XJ7000000000999',
    equal: false,
    kind: 'conflict',
  },
  {
    field: 'name',
    candidate_value: '先锋四号',
    matched_value: '头孢氨苄',
    equal: false,
    kind: 'normalized',
  },
  { field: 'spec', candidate_value: null, matched_value: '100ml*1瓶', equal: false, kind: 'missing' },
  {
    field: 'dosage_form',
    candidate_value: '口服溶液剂',
    matched_value: null,
    equal: false,
    kind: 'absent',
  },
]

const evidenceMismatch: EvidenceItem = {
  record_id: 'MD-000147',
  field: 'insurance_code',
  candidate_value: 'XJ7000000000146',
  matched_value: 'XJ7000000000999',
  evidence_mismatch: true,
  model_matched_value: 'XJ7000000000146',
}

const evidenceNormal: EvidenceItem = {
  record_id: 'MD-000148',
  field: 'name',
  candidate_value: '先锋四号',
  matched_value: '头孢氨苄',
}

const conclusion: MergeConclusion = {
  candidate_id: 'CAND-DEMO-001',
  domain: 'drug',
  action: 'merge',
  target_code: 'YP000147',
  confidence: 0.92,
  rationale: '医保码唯一命中，规格与剂型归一后相同',
  evidence: [evidenceMismatch, evidenceNormal],
  uncertain_reason: null,
  missing_fields: [],
  degraded: false,
  field_diffs: {
    diffs,
    counts: { exact: 2, normalized: 1, conflict: 1, missing: 1, absent: 1 },
    conflict_fields: ['insurance_code'],
  },
}

const turns: FollowupTurn[] = [
  {
    question: '为什么不并到 MD-000148？',
    answer: '该记录医保码段不匹配，已被规则层排除。',
    referenced_record_ids: ['MD-000147', 'MD-000148'],
    evidence: [evidenceNormal],
    model_call_id: 'mc-demo-001',
    asked_action: 'merge',
    refreshed: false,
    at: '2024-07-01T08:00:00+08:00',
  },
]

const receipts: WriteReceipt[] = [
  {
    candidate_id: 'CAND-1',
    status: 'success',
    idempotency_key: 'key-11111111',
    created_at: '2024-07-01T08:00:00+08:00',
  },
  {
    candidate_id: 'CAND-2',
    status: 'skipped',
    idempotency_key: 'key-22222222',
    created_at: '2024-07-01T08:01:00+08:00',
  },
  {
    candidate_id: 'CAND-3',
    status: 'failed',
    idempotency_key: 'key-33333333',
    reason: 'duplicate_hash',
    readable_reason: '已存在同哈希建议，跳过写入',
    created_at: '2024-07-01T08:02:00+08:00',
  },
]

const batchSummary: BatchSummary = {
  batch_id: 'BATCH-DEMO-001',
  total: 3,
  succeeded: 1,
  skipped: 1,
  failed: 1,
  failures: [
    { candidate_id: 'CAND-3', kind: 'duplicate', readable_reason: '已存在同哈希建议' },
  ],
  elapsed_ms: 120,
}

const suggestions = [
  {
    candidate_id: 'CAND-1',
    action: 'merge' as const,
    target_code: 'YP000001',
    rationale: '医保码唯一命中',
    idempotency_key: 'abcdef1234567890',
  },
  {
    candidate_id: 'CAND-2',
    action: 'create' as const,
    target_code: null,
    rationale: '无近似项，建议新建',
  },
  {
    candidate_id: 'CAND-3',
    action: 'merge' as const,
    target_code: 'YP000003',
    rationale: '归一后相同',
  },
]

describe('候选卡片与详情区 SSR', () => {
  it('CandidateCard 渲染三态标签与待评标签', async () => {
    for (const [action, label] of [
      ['create', '新建'],
      ['merge', '并入'],
      ['uncertain', '存疑'],
    ] as const) {
      const html = await render(CandidateCard, {
        candidate,
        conclusion: { ...conclusion, action },
      })
      expect(textOf(html), `action=${action}`).toContain(label)
    }
    const pendingHtml = await render(CandidateCard, { candidate })
    const pendingText = textOf(pendingHtml)
    expect(pendingText).toContain('待评')
    expect(pendingText).toContain('尚未评估，等待结论')
  })

  it('CandidateCard 呈现主键行、摘要行、置信度证据数、等宽 code/record_id 与复制按钮', async () => {
    const html = await render(CandidateCard, { candidate, conclusion, target })
    const text = textOf(html)
    expect(text).toContain('CAND-DEMO-001')
    expect(text).toContain('药品')
    expect(text).toContain('先锋四号')
    expect(text).toContain('建议并入目标 YP000147')
    expect(text).toContain('置信度 92%')
    expect(text).toContain('证据 2 条')
    expect(text).toContain('#YP000147')
    expect(text).toContain('MD-000147')
    expect(text).toContain('复制')
  })

  it('FieldCompare 按 FIELD_DIFF_ORDER 固定顺序并排，conflict 高亮且 missing/absent 显式标注', async () => {
    const html = await render(FieldCompare, { summary: conclusion.field_diffs })
    const fields = Array.from(html.matchAll(/data-field="([^"]+)"/g), (match) => match[1])
    expect(fields).toEqual([...FIELD_DIFF_ORDER])

    const text = textOf(html)
    expect(text).toContain('候选值')
    expect(text).toContain('命中值（主数据）')
    expect(text).toContain('候选缺该字段')
    expect(text).toContain('主数据无该字段')
    expect(text).toContain('归一后相同')

    // conflict 行高亮，exact / normalized 不高亮
    expect(rowAttrs(html, 'insurance_code')).toContain('data-kind="conflict"')
    expect(rowAttrs(html, 'insurance_code')).toContain('is-conflict')
    expect(rowAttrs(html, 'name')).toContain('data-kind="normalized"')
    expect(rowAttrs(html, 'name')).not.toContain('is-conflict')
    expect(rowAttrs(html, 'unit')).toContain('data-kind="exact"')
    expect(rowAttrs(html, 'unit')).not.toContain('is-conflict')
  })

  it('EvidenceTable 逐条列出证据，mismatch 行失败色并显示模型原值与主数据实际值', async () => {
    const html = await render(EvidenceTable, {
      evidence: [evidenceMismatch, evidenceNormal],
    })
    const text = textOf(html)
    expect(text).toContain('MD-000147')
    expect(text).toContain('MD-000148')
    expect(text).toContain('证据不一致')
    expect(text).toContain('模型原值')
    expect(text).toContain('主数据实际值')
    expect(text).toContain('XJ7000000000146')
    expect(text).toContain('XJ7000000000999')
    expect(html).toContain('is-mismatch')
  })

  it('EvidenceTable compact 窄栏用堆叠卡片保留四要素，不渲染定宽四列表头', async () => {
    const html = await render(EvidenceTable, {
      evidence: [evidenceMismatch, evidenceNormal],
      compact: true,
    })
    const text = textOf(html)
    // 四要素齐全：记录 ID / 字段 / 候选值 / 命中值
    expect(text).toContain('记录 ID')
    expect(text).toContain('候选值')
    expect(text).toContain('命中值')
    expect(text).toContain('MD-000147')
    expect(text).toContain('insurance_code')
    expect(text).toContain('XJ7000000000146')
    expect(text).toContain('头孢氨苄')
    // mismatch 的失败色与模型原值说明保留
    expect(text).toContain('证据不一致')
    expect(text).toContain('模型原值')
    expect(html).toContain('evidence-table__cards')
    expect(html).toContain('is-mismatch')
    // 窄栏不再出现定宽表格的「命中值 / 主数据实际值」表头（会被挤成竖排）
    expect(html).not.toContain('base-table__table')
  })

  it('SessionPane 降级模式禁用输入并显示原因，发送按钮不可点', async () => {
    const html = await render(SessionPane, { degraded: true, hasConclusion: true })
    const text = textOf(html)
    expect(text).toContain('降级模式下不可追问')
    expect(text).toContain('模型不可用，全部结论待人工')
    const sendButton = buttonWithText(html, '发送')
    expect(sendButton).toBeTruthy()
    expect(sendButton).toContain('disabled')
    expect(html).toMatch(/<input[^>]*disabled/)
  })

  it('SessionPane 存疑未复核与无结论分别禁用并给出不同原因', async () => {
    const unreviewed = textOf(
      await render(SessionPane, { uncertainUnreviewed: true, hasConclusion: true }),
    )
    expect(unreviewed).toContain('存疑项尚未人工复核')
    const noConclusion = textOf(await render(SessionPane, { hasConclusion: false }))
    expect(noConclusion).toContain('当前候选尚无结论')
  })

  it('SessionPane 追问历史带出处，回答含证据时挂 EvidenceTable', async () => {
    const html = await render(SessionPane, {
      hasConclusion: true,
      turns,
      candidateId: 'CAND-DEMO-001',
    })
    const text = textOf(html)
    expect(text).toContain('为什么不并到 MD-000148？')
    expect(text).toContain('该记录医保码段不匹配')
    expect(text).toContain('出处')
    expect(text).toContain('MD-000148')
    expect(text).toContain('本轮回答引用的证据')
    // EvidenceTable 已挂载：证据表头与条数出现，而非 CandidateCard 自身的字段对照
    expect(text).toContain('记录 ID')
    expect(text).toContain('共 1 条')
  })

  it('SessionPane 空问题不发送：初始发送按钮禁用且源码有空值拦截', async () => {
    const html = await render(SessionPane, { hasConclusion: true })
    const sendButton = buttonWithText(html, '发送')
    expect(sendButton).toContain('disabled')
    const source = read('src/renderer/components/SessionPane.vue')
    expect(source).toMatch(/if\s*\(!text[^)]*\)\s*return/)
  })

  it('DegradeBanner 命中降级时置顶提示不可写回，未降级时不渲染', async () => {
    const html = await render(DegradeBanner, {
      degraded: true,
      reason: '模型端点超时',
    })
    const text = textOf(html)
    expect(text).toContain('模型不可用，当前仅按规则排序，全部结论待人工')
    expect(text).toContain('此时不可写回')
    expect(text).toContain('降级原因：模型端点超时')
    expect(textOf(await render(DegradeBanner, { degraded: false }))).toBe('')
  })
})

describe('确认框、回执、顶栏与 toast SSR', () => {
  it('ConfirmDialog 默认 0 选中：逐条勾选、已选 0/共 3、提交禁用、二次确认明示只写建议不推进状态', async () => {
    const html = await render(ConfirmDialog, { open: true, suggestions })
    expect(html).toContain('data-writeback-count="0"')
    expect(html).toContain('data-total-count="3"')
    const text = textOf(html)
    expect(text).toContain('已选 0 条 / 共 3 条')
    expect(text).toContain('只写建议不推进状态')
    expect(text).toContain('不会推进候选状态')
    expect(text).toContain('CAND-1')
    expect(text).toContain('CAND-2')
    expect(text).toContain('CAND-3')
    const submit = buttonWithText(html, '确认写回')
    expect(submit).toBeTruthy()
    expect(submit).toContain('disabled')
    // 默认全不勾选：没有 checked 的复选框
    expect(html).not.toMatch(/type="checkbox"[^>]*checked/)
  })

  it('ReceiptList 三态色、失败原因、单独重试按钮与批次摘要计数齐全', async () => {
    const html = await render(ReceiptList, { receipts, summary: batchSummary })
    const text = textOf(html)
    expect(text).toContain('BATCH-DEMO-001')
    expect(text).toContain('成功 1')
    expect(text).toContain('跳过 1')
    expect(text).toContain('失败 1')
    expect(text).toContain('已存在同哈希建议，跳过写入')
    expect(text).toContain('单独重试')
    expect(html).toContain('data-status="success"')
    expect(html).toContain('data-status="skipped"')
    expect(html).toContain('data-status="failed"')
  })

  it('StatusBar 展示待评/已建议/存疑三态计数与批次信息', async () => {
    const html = await render(StatusBar, {
      pending: 12,
      suggested: 8,
      uncertain: 3,
      batchLabel: 'BATCH-001',
    })
    const text = textOf(html)
    expect(text).toContain('待评 12')
    expect(text).toContain('已建议 8')
    expect(text).toContain('存疑 3')
    expect(text).toContain('BATCH-001')
  })

  it('ToastStack 成功/失败均渲染，失败需手动关闭，成功源码有 3 秒自动消失排程', async () => {
    const html = await render(ToastStack, {
      toasts: [
        { id: 't1', kind: 'success', message: '写回完成' },
        { id: 't2', kind: 'failed', message: '写回失败，请重试' },
      ],
    })
    const text = textOf(html)
    expect(text).toContain('写回完成')
    expect(text).toContain('写回失败，请重试')
    expect(html).toContain('data-kind="success"')
    expect(html).toContain('data-kind="failed"')
    expect(html).toContain('手动关闭失败提示')

    const source = read('src/renderer/components/ToastStack.vue')
    expect(source).toContain('3000')
    expect(source).toContain("toast.kind !== 'success'")
    expect(source).toContain("typeof window === 'undefined'")
  })
})

describe('基础组件四态与裸色值约束', () => {
  it('6 个基础组件均具备 hover / active / disabled / loading 四态样式', () => {
    for (const name of [
      'BaseButton',
      'BaseInput',
      'BaseSelect',
      'BaseTable',
      'BaseTag',
      'BaseModal',
    ]) {
      const source = read(`src/renderer/components/base/${name}.vue`)
      expect(source, `${name} 缺 hover`).toMatch(/:hover/)
      expect(source, `${name} 缺 active`).toMatch(/:active|is-active/)
      expect(source, `${name} 缺 disabled`).toMatch(/disabled|is-disabled/)
      expect(source, `${name} 缺 loading`).toMatch(/loading|is-loading/)
    }
  })

  it('基础组件 disabled/loading props 真实渲染为 disabled 与 aria-busy', async () => {
    const buttonHtml = await render(BaseButton, { disabled: true, loading: true })
    expect(buttonHtml).toContain('is-loading')
    expect(buttonHtml).toContain('aria-busy="true"')
    expect(buttonHtml).toContain('disabled')

    const inputHtml = await render(BaseInput, { disabled: true })
    expect(inputHtml).toMatch(/<input[^>]*disabled/)

    const selectHtml = await render(BaseSelect, { loading: true })
    expect(selectHtml).toContain('is-loading')
    expect(selectHtml).toMatch(/<select[^>]*disabled/)

    const tagHtml = await render(BaseTag, { tone: 'create', disabled: true })
    expect(tagHtml).toContain('is-disabled')
    expect(tagHtml).toContain('base-tag--create')

    const tableHtml = await render(BaseTable, {
      loading: true,
      columns: [{ key: 'id', label: 'ID' }],
    })
    expect(tableHtml).toContain('正在加载数据')

    const modalHtml = await render(BaseModal, { open: true, title: '确认写回' })
    expect(modalHtml).toContain('role="dialog"')
    expect(modalHtml).toContain('确认写回')
  })

  it('组件源码（tokens.css 除外）无 #RRGGBB 裸色值与 rgb/rgba/hsl 字面量', () => {
    const collect = (dir: string): string[] => {
      const files: string[] = []
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) files.push(...collect(full))
        else if (entry.isFile() && entry.name.endsWith('.vue')) files.push(full)
      }
      return files
    }
    const files = collect(resolve(projectRoot, 'src/renderer/components'))
    expect(files.length).toBeGreaterThanOrEqual(10)
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(source.match(/#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g), `${file} 含裸色值`).toBeNull()
      expect(source.match(/\brgba?\(/g), `${file} 含 rgb/rgba`).toBeNull()
      expect(source.match(/\bhsla?\(/g), `${file} 含 hsl/hsla`).toBeNull()
    }
  })
})

describe('App 评审台三态、分组分页与响应式 SSR', () => {
  it('加载态显示「正在比对院内主数据」与已评/总数进度', async () => {
    const html = await render(App, {
      phase: 'loading',
      progress: { evaluated: 3, total: 10 },
    })
    const text = textOf(html)
    expect(text).toContain('正在比对院内主数据')
    expect(text).toContain('已评 3 / 共 10')
    expect(html).toContain('review-desk__skeleton-card')
  })

  it('空态按未取到候选 / 零命中 / 筛选为空给出不同文案与下一步动作', async () => {
    const noCandidates = textOf(await render(App, { phase: 'empty', emptyKind: 'no-candidates' }))
    expect(noCandidates).toContain('未取到候选批次')
    expect(noCandidates).toContain('重新拉取')

    const zeroHit = textOf(await render(App, { phase: 'empty', emptyKind: 'zero-hit' }))
    expect(zeroHit).toContain('本批检索零命中')
    expect(zeroHit).toContain('转人工处理')

    const filtered = textOf(await render(App, { phase: 'empty', emptyKind: 'filtered-empty' }))
    expect(filtered).toContain('当前筛选结果为空')
    expect(filtered).toContain('清除筛选')
  })

  it('错误态分检索/模型/写回三类且错误文案不出现英文堆栈', async () => {
    const model = textOf(
      await render(App, {
        phase: 'error',
        errorKind: 'model',
        errorMessage: 'Error: ECONNRESET\n    at Server.request (/app/x.ts:12:3)',
      }),
    )
    expect(model).toContain('模型不可达')
    expect(model).not.toContain('Error:')
    expect(model).not.toContain('at Server')
    expect(textOf(await render(App, { phase: 'error', errorKind: 'retrieval' }))).toContain('检索失败')
    expect(textOf(await render(App, { phase: 'error', errorKind: 'writeback' }))).toContain('写回失败')
  })

  it('成形态渲染顶栏三区、分组候选、字段对照/证据与底部写回按钮', async () => {
    const html = await render(App, {
      phase: 'ready',
      candidates: [candidate, secondCandidate],
      conclusions: { 'CAND-DEMO-001': conclusion },
      batchLabel: 'BATCH-001',
    })
    const text = textOf(html)
    for (const label of [
      '主数据归并检索系统',
      'BATCH-001',
      '待评',
      '已建议',
      '存疑',
      '候选卡片流',
      '并入',
      '详情对照',
      '字段对照',
      '逐条证据',
      '追问会话',
      '写回主数据平台',
    ]) {
      expect(text, `缺少「${label}」`).toContain(label)
    }
  })

  it('降级模式下置顶提示且写回按钮禁用', async () => {
    const html = await render(App, {
      phase: 'ready',
      candidates: [candidate],
      conclusions: { 'CAND-DEMO-001': conclusion },
      degraded: true,
      degradedReason: '模型端点超时',
    })
    const text = textOf(html)
    expect(text).toContain('模型不可用，当前仅按规则排序，全部结论待人工')
    expect(text).toContain('此时不可写回')
    const writeback = buttonWithText(html, '写回主数据平台')
    expect(writeback).toBeTruthy()
    expect(writeback).toContain('disabled')
  })

  it('超过 100 条时每页 50 条分页，第一页只渲染 50 条列表卡片', async () => {
    const many: CandidateRecord[] = Array.from({ length: 120 }, (_, index) => ({
      candidate_id: `CAND-PAGE-${String(index + 1).padStart(3, '0')}`,
      domain: 'drug',
      name: `候选${index + 1}`,
    }))
    const html = await render(App, { phase: 'ready', candidates: many })
    // 列表 50 张 + 详情区 1 张
    expect((html.match(/class="candidate-card\b/g) ?? []).length).toBe(51)
    const text = textOf(html)
    expect(text).toContain('第 1 / 3 页')
    expect(text).toContain('每页 50 条')
    expect(text).toContain('共 120 条')
  })

  it('1280 三区 / 768 两区响应式写在样式里，无横向滚动且列表走抽屉', () => {
    const source = read('src/renderer/App.vue')
    expect(source).toMatch(/grid-template-columns:\s*minmax\(320px[^;]+;/)
    expect(source).toMatch(/@media\s*\(max-width:\s*1023px\)/)
    expect(source).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    expect(source).toMatch(/transform:\s*translateX\(-100%\)/)
    expect(source).toMatch(/overflow-x:\s*hidden/)
    expect(source).toMatch(/min-width:\s*0/)
  })
})
