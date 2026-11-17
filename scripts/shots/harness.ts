/**
 * 截图 harness（Task 14）：挂载真实交付产物 src/renderer/App.vue 与全部子组件、
 * tokens.css，用 Node 侧真实语料 + 真实归并引擎生成的 payload.json 驱动三态。
 *
 * 关键设计（本次修复的两处真实缺陷）：
 *  1. 浏览器侧只 import 真实 App.vue + 纯 JSON，绝不 import harness-data/run-merge，
 *     否则 node:fs / node:path / node:crypto 会被 externalize 进浏览器 bundle，
 *     构建成功但运行时报「module externalized for browser compatibility」。
 *  2. App.vue 的 onMounted 会调用 bridge.batchList()。若 window.reviewDesk 缺失，
 *     bridge 返回 BRIDGE_UNAVAILABLE，loadBatch 会把 phase 覆盖成 empty，截图就
 *     只剩空态。这里注入一个只读的 window.reviewDesk 替身，让真实的
 *     「bridge → loadBatch → ready」运行路径走通；替身只回传 payload.json，
 *     不发任何写调用、不产生任何副作用。
 *
 * ?view=desk|confirm|receipts|degraded 切换四个真实画面；视口由外层 Chrome
 * --window-size 控制。渲染完成后置 window.__SHOTS_READY__ = true 供采集端轮询。
 */
import { createApp, nextTick } from 'vue'
import App from '../../src/renderer/App.vue'
import '../../src/renderer/styles/tokens.css'
import payload from './payload.json'

type ViewName = 'desk' | 'confirm' | 'receipts' | 'degraded'

const params = new URLSearchParams(location.search)
const rawView = params.get('view') ?? 'desk'
const view: ViewName = (['desk', 'confirm', 'receipts', 'degraded'] as const).includes(rawView as ViewName)
  ? (rawView as ViewName)
  : 'desk'

interface ReviewDeskLike {
  invoke: (channel: string, request?: unknown) => Promise<unknown>
}

/** receipts 视图同样裁短候选，保证 onMounted → loadBatch() 不会把 8 张卡再灌回来撑高页面。 */
const receiptsViewIds = new Set(payload.candidates.slice(0, 3).map((c) => c.candidate_id))
const shownCandidates = view === 'receipts' ? payload.candidates.slice(0, 3) : payload.candidates
const shownConclusions = view === 'receipts'
  ? Object.fromEntries(Object.entries(payload.conclusions).filter(([id]) => receiptsViewIds.has(id)))
  : payload.conclusions

/** 真实的 batch:list 响应体形状（与 App.vue 的 BatchPayload 对齐）。 */
const batchData = {
  candidates: shownCandidates,
  conclusions: shownConclusions,
  sessions: payload.sessions,
  receipts: view === 'receipts' ? payload.receipts : [],
  summary: view === 'receipts' ? payload.summary : null,
  label: payload.label,
}

/**
 * 只读 bridge 替身：仅供截图 harness 让真实 App 走通运行态加载路径。
 * 走白名单契约的同一批通道名，任何写/导出/追问通道都返回可读的拒绝，
 * 保证 harness 自身不产生业务副作用。
 */
const shotsBridge: ReviewDeskLike = {
  invoke: async (channel: string) => {
    if (channel === 'batch:list') return { ok: true, data: batchData }
    if (channel === 'tray:check-new') return { ok: true, data: { changed: false } }
    if (channel === 'followup:ask') {
      return { ok: false, code: 'SHOTS_READONLY', message: '截图 harness 为只读渲染，追问不经模型' }
    }
    if (channel === 'suggestion:submit') {
      return { ok: false, code: 'SHOTS_READONLY', message: '截图 harness 为只读渲染，不执行写回' }
    }
    if (channel === 'suggestion:export') {
      return { ok: false, code: 'SHOTS_READONLY', message: '截图 harness 为只读渲染，不导出文件' }
    }
    if (channel === 'candidate:evaluate' || channel === 'conclusion:get') {
      return { ok: false, code: 'SHOTS_READONLY', message: '截图 harness 不重新评估候选' }
    }
    return { ok: false, code: 'SHOTS_BAD_CHANNEL', message: `未注册通道：${channel}` }
  },
}

;(window as unknown as { reviewDesk: ReviewDeskLike }).reviewDesk = shotsBridge

async function main(): Promise<void> {
  const app = createApp(App, {
    phase: 'ready',
    candidates: shownCandidates,
    conclusions: shownConclusions,
    sessions: payload.sessions,
    batchLabel: payload.label,
    receipts: view === 'receipts' ? payload.receipts : [],
    batchSummary: view === 'receipts' ? payload.summary : null,
    degraded: view === 'degraded',
    degradedReason: view === 'degraded' ? '模型不可达（离线环境未配置 LLM 端点），本批仅按规则排序，不可写回' : '',
  })
  const root = document.getElementById('app')
  if (!root) throw new Error('#app 不存在')
  app.mount(root)

  // 等 onMounted → loadBatch() 走完（它把 phase 置回 ready），再决定是否点写回按钮。
  await nextTick()
  await new Promise<void>((resolve) => setTimeout(resolve, 60))
  await nextTick()

  // confirm 视图：真实点击「写回主数据平台」打开 ConfirmDialog（走 openConfirm），
  // 再勾选前两条建议，让「已选 N 条」计数与提交按钮呈现真实二次确认态。
  if (view === 'confirm') {
    const buttons = Array.from(root.querySelectorAll('button'))
    const writeBtn = buttons.find((b) => (b.textContent ?? '').includes('写回主数据平台')) as HTMLButtonElement | undefined
    if (writeBtn && !writeBtn.disabled) writeBtn.click()
    await nextTick()
    await new Promise<void>((resolve) => setTimeout(resolve, 60))
    const checkboxes = Array.from(root.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[]
    for (const cb of checkboxes.slice(0, 2)) cb.click()
    await nextTick()
  }

  // receipts 视图靠裁短候选（见上方 shownCandidates）让回执区自然落在单屏内，
  // 不做程序化滚动——headless Chrome 的整页截图对 scrollTo 取景不稳定。
  // degraded 视图：降级条置顶已可见，无需滚动。

  // 供采集端判定「真实渲染已完成」与布局诊断（截图取景用）。
  ;(window as unknown as { __SHOTS_READY__: boolean }).__SHOTS_READY__ = true
  document.documentElement.setAttribute('data-shots-view', view)
  document.documentElement.setAttribute('data-shots-ready', '1')
  const receiptsEl = root.querySelector('.review-desk__receipts') as HTMLElement | null
  document.documentElement.setAttribute('data-doc-height', String(document.documentElement.scrollHeight))
  document.documentElement.setAttribute('data-scroll-y', String(window.scrollY))
  document.documentElement.setAttribute(
    'data-receipts-top',
    String(receiptsEl ? Math.round(receiptsEl.getBoundingClientRect().top) : -1),
  )
}

void main().catch((err) => {
  const root = document.getElementById('app')
  if (root) root.textContent = `harness 渲染失败：${err instanceof Error ? err.message : String(err)}`
  console.error(err)
})
