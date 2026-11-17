<script setup lang="ts">
/**
 * 真正评审台：顶栏 / 降级条 / 左候选列表 / 右详情 / 右侧追问 / 底部操作 / toast。
 * 1280 宽三区；≤1023 宽两区（详情与追问上下排列，列表收进抽屉）。
 * 加载 / 空 / 错误三态各有可读文案与下一步动作；node SSR 不触碰 window/document。
 */
import { computed, onMounted, ref, watch } from 'vue'
import type {
  Action,
  BatchSummary,
  CandidateRecord,
  FollowupSession,
  FollowupTurn,
  MergeConclusion,
  WriteReceipt,
} from '../core/types'
import { bridge } from './services/bridge'
import BaseButton from './components/base/BaseButton.vue'
import CandidateCard from './components/CandidateCard.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import DegradeBanner from './components/DegradeBanner.vue'
import EvidenceTable from './components/EvidenceTable.vue'
import FieldCompare from './components/FieldCompare.vue'
import ReceiptList from './components/ReceiptList.vue'
import SessionPane from './components/SessionPane.vue'
import StatusBar from './components/StatusBar.vue'
import ToastStack from './components/ToastStack.vue'

type Phase = 'loading' | 'empty' | 'error' | 'ready'
type EmptyKind = 'no-candidates' | 'zero-hit' | 'filtered-empty'
type ErrorKind = 'retrieval' | 'model' | 'writeback'
type ToastKind = 'success' | 'failed' | 'info'
interface ToastItem {
  id: string
  kind: ToastKind
  message: string
}
interface WritebackSuggestion {
  candidate_id: string
  action: Action
  target_code: string | null
  rationale: string
  idempotency_key: string
}

const props = withDefaults(
  defineProps<{
    phase?: Phase
    emptyKind?: EmptyKind
    errorKind?: ErrorKind
    errorMessage?: string
    candidates?: CandidateRecord[]
    conclusions?: Record<string, MergeConclusion>
    sessions?: Record<string, FollowupSession>
    receipts?: WriteReceipt[]
    batchSummary?: BatchSummary | null
    batchLabel?: string
    degraded?: boolean
    degradedReason?: string
    progress?: { evaluated: number; total: number } | null
  }>(),
  {
    phase: 'loading',
    emptyKind: 'no-candidates',
    errorKind: 'retrieval',
    errorMessage: '',
    candidates: () => [],
    conclusions: () => ({}),
    sessions: () => ({}),
    receipts: () => [],
    batchSummary: null,
    batchLabel: '',
    degraded: false,
    degradedReason: '',
    progress: null,
  },
)

// ── 数据状态：props 注入（SSR / 嵌入）与 bridge 拉取（运行态）共用 ──
const candidateList = ref<CandidateRecord[]>([...props.candidates])
const conclusionMap = ref<Record<string, MergeConclusion>>({ ...props.conclusions })
const sessionMap = ref<Record<string, FollowupSession>>({ ...props.sessions })
const receiptList = ref<WriteReceipt[]>([...props.receipts])
const summary = ref<BatchSummary | null>(props.batchSummary)
const phase = ref<Phase>(props.phase)
const runtimeMessage = ref('')
const degraded = ref(props.degraded)
const batchLabel = ref(props.batchLabel)

watch(() => props.candidates, (list) => { candidateList.value = [...list] })
watch(() => props.conclusions, (map) => { conclusionMap.value = { ...map } })
watch(() => props.sessions, (map) => { sessionMap.value = { ...map } })
watch(() => props.receipts, (list) => { receiptList.value = [...list] })
watch(() => props.batchSummary, (value) => { summary.value = value })
watch(() => props.phase, (value) => { phase.value = value })
watch(() => props.degraded, (value) => { degraded.value = value })
watch(() => props.batchLabel, (value) => { batchLabel.value = value })

// ── 交互状态 ──
const selectedId = ref('')
const drawerOpen = ref(false)
const confirmOpen = ref(false)
const asking = ref(false)
const submitting = ref(false)
const exporting = ref(false)
const retrying = ref<string[]>([])
const writebackError = ref('')
const reviewedIds = ref<Set<string>>(new Set())
const toasts = ref<ToastItem[]>([])
let toastSeq = 0

// ── 分组 / 计数 / 分页 ──
type GroupKey = 'pending' | 'suggested' | 'uncertain'
const GROUP_VIEW: ReadonlyArray<{ key: GroupKey; label: string }> = [
  { key: 'pending', label: '待评' },
  { key: 'suggested', label: '已建议' },
  { key: 'uncertain', label: '存疑' },
]
const PAGE_SIZE = 50

function groupOf(candidateId: string): GroupKey {
  const conclusion = conclusionMap.value[candidateId]
  if (!conclusion) return 'pending'
  return conclusion.action === 'uncertain' ? 'uncertain' : 'suggested'
}

const groups = computed(() => {
  const result: Record<GroupKey, CandidateRecord[]> = { pending: [], suggested: [], uncertain: [] }
  for (const candidate of candidateList.value) {
    result[groupOf(candidate.candidate_id)].push(candidate)
  }
  return result
})

const counts = computed(() => ({
  pending: groups.value.pending.length,
  suggested: groups.value.suggested.length,
  uncertain: groups.value.uncertain.length,
}))

const total = computed(() => candidateList.value.length)
const paged = computed(() => total.value > 100)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const page = ref(1)

const orderedList = computed(() => [
  ...groups.value.pending,
  ...groups.value.suggested,
  ...groups.value.uncertain,
])

const visibleList = computed(() => {
  if (!paged.value) return orderedList.value
  const start = (page.value - 1) * PAGE_SIZE
  return orderedList.value.slice(start, start + PAGE_SIZE)
})

const visibleGroups = computed(() => {
  const ids = new Set(visibleList.value.map((candidate) => candidate.candidate_id))
  return {
    pending: groups.value.pending.filter((candidate) => ids.has(candidate.candidate_id)),
    suggested: groups.value.suggested.filter((candidate) => ids.has(candidate.candidate_id)),
    uncertain: groups.value.uncertain.filter((candidate) => ids.has(candidate.candidate_id)),
  }
})

// 选中项始终落在当前列表内；immediate 只写本地 ref，SSR 无副作用
watch(
  orderedList,
  (list) => {
    if (!list.some((candidate) => candidate.candidate_id === selectedId.value)) {
      selectedId.value = list[0]?.candidate_id ?? ''
    }
  },
  { immediate: true },
)

const selectedCandidate = computed(
  () => candidateList.value.find((candidate) => candidate.candidate_id === selectedId.value) ?? null,
)
const selectedConclusion = computed(() => conclusionMap.value[selectedId.value] ?? null)
const selectedSession = computed(() => sessionMap.value[selectedId.value] ?? null)
const uncertainUnreviewed = computed(
  () => selectedConclusion.value?.action === 'uncertain' && !reviewedIds.value.has(selectedId.value),
)

// ── 待写回建议：只列已出结论且非存疑的候选 ──
const suggestionList = computed<WritebackSuggestion[]>(() =>
  candidateList.value
    .map((candidate) => ({ candidate, conclusion: conclusionMap.value[candidate.candidate_id] }))
    .filter(
      (entry): entry is { candidate: CandidateRecord; conclusion: MergeConclusion } =>
        Boolean(entry.conclusion) && entry.conclusion.action !== 'uncertain',
    )
    .map(({ candidate, conclusion }) => ({
      candidate_id: candidate.candidate_id,
      action: conclusion.action,
      target_code: conclusion.target_code,
      rationale: conclusion.rationale,
      idempotency_key: `${candidate.candidate_id}:${conclusion.action}:${conclusion.target_code ?? 'new'}`,
    })),
)

const canWriteback = computed(
  () => !degraded.value && phase.value === 'ready' && suggestionList.value.length > 0,
)

// ── 三态文案 ──
const EMPTY_VIEW: Record<EmptyKind, { title: string; hint: string; action: string }> = {
  'no-candidates': {
    title: '未取到候选批次',
    hint: '本机工作区尚无待评审数据，请重新拉取候选池。',
    action: '重新拉取',
  },
  'zero-hit': {
    title: '本批检索零命中',
    hint: '没有可对照的主数据记录，建议转人工或补充检索词后再评。',
    action: '转人工处理',
  },
  'filtered-empty': {
    title: '当前筛选结果为空',
    hint: '请更换筛选条件或清除筛选后重试。',
    action: '清除筛选',
  },
}

const ERROR_VIEW: Record<ErrorKind, { title: string; hint: string }> = {
  retrieval: { title: '检索失败', hint: '院内主数据接口不可用，可重试或按规则降级继续评审。' },
  model: { title: '模型不可达', hint: '本批结论无法生成，可稍后重试或转人工处理。' },
  writeback: { title: '写回失败', hint: '建议未写入 MDM 候选池，可重试或转人工处理。' },
}

const emptyView = computed(() => EMPTY_VIEW[props.emptyKind])
const errorView = computed(() => ERROR_VIEW[props.errorKind])

/** 错误文案只保留中文可读信息，杜绝英文堆栈外泄。 */
function sanitizeError(message: string): string {
  const firstLine = message.split('\n')[0]?.trim() ?? ''
  if (!firstLine) return errorView.value.hint
  if (/Error:|TypeError|ReferenceError|\bat\s+\S+\s*\(|\S+\.ts:\d+:\d+/.test(firstLine)) {
    return errorView.value.hint
  }
  return firstLine
}

const readableError = computed(() =>
  sanitizeError(runtimeMessage.value || props.errorMessage || errorView.value.hint),
)

const loadingText = computed(() => {
  if (props.progress && props.progress.total > 0) {
    return `正在比对院内主数据（已评 ${props.progress.evaluated} / 共 ${props.progress.total}），请稍候…`
  }
  return '正在比对院内主数据，拉取候选批次与结论…'
})

const effectiveBatchLabel = computed(
  () => batchLabel.value || `本批共 ${total.value} 条候选 · 本机工作区`,
)

// ── toast ──
function pushToast(kind: ToastKind, message: string): void {
  toasts.value.push({ id: `toast-${++toastSeq}`, kind, message })
}

function dismissToast(id: string): void {
  toasts.value = toasts.value.filter((toast) => toast.id !== id)
}

// ── 业务动作：全部经 bridge 白名单 ──
interface BatchPayload {
  candidates?: CandidateRecord[]
  conclusions?: Record<string, MergeConclusion>
  sessions?: Record<string, FollowupSession>
  receipts?: WriteReceipt[]
  summary?: BatchSummary
  label?: string
}

async function loadBatch(): Promise<void> {
  phase.value = 'loading'
  writebackError.value = ''
  const response = await bridge.batchList<BatchPayload>()
  if (response.ok && response.data) {
    if (response.data.candidates?.length) candidateList.value = response.data.candidates
    if (response.data.conclusions) conclusionMap.value = response.data.conclusions
    if (response.data.sessions) sessionMap.value = response.data.sessions
    if (response.data.receipts) receiptList.value = response.data.receipts
    if (response.data.summary) summary.value = response.data.summary
    if (response.data.label) batchLabel.value = response.data.label
    phase.value = candidateList.value.length ? 'ready' : 'empty'
    return
  }
  runtimeMessage.value = response.message ?? ''
  phase.value = response.code === 'BRIDGE_UNAVAILABLE' ? 'empty' : 'error'
  pushToast('info', '本机服务尚未返回候选，可点击空态中的动作重试')
}

function onEmptyAction(): void {
  if (props.emptyKind === 'filtered-empty') {
    pushToast('info', '已清除筛选条件')
    phase.value = 'ready'
    return
  }
  void loadBatch()
}

function onDegradeContinue(): void {
  degraded.value = true
  phase.value = 'ready'
  pushToast('info', '已按规则排序继续评审，此时不可写回')
}

function onToHuman(): void {
  pushToast('info', '已标记转人工，请在候选详情中补充复核记录')
}

function selectCandidate(candidateId: string): void {
  selectedId.value = candidateId
  drawerOpen.value = false
}

function openFollowup(candidateId: string): void {
  selectedId.value = candidateId
  reviewedIds.value = new Set(reviewedIds.value).add(candidateId)
}

async function onAsk(question: string): Promise<void> {
  if (asking.value || !question.trim() || !selectedId.value) return
  asking.value = true
  const candidateId = selectedId.value
  try {
    const response = await bridge.askFollowup<FollowupTurn>({
      candidate_id: candidateId,
      question,
    })
    if (response.ok && response.data) {
      const turn = response.data
      const existing = sessionMap.value[candidateId]
      if (existing) {
        sessionMap.value[candidateId] = { ...existing, turns: [...existing.turns, turn] }
      } else if (conclusionMap.value[candidateId]) {
        sessionMap.value[candidateId] = {
          candidate_id: candidateId,
          snapshot_version: '',
          conclusion: conclusionMap.value[candidateId]!,
          turns: [turn],
          discarded_count: 0,
          updated_at: turn.at,
        }
      }
      pushToast('success', '追问已记录')
    } else {
      pushToast('failed', `追问失败：${response.message ?? '请重试'}`)
    }
  } finally {
    asking.value = false
  }
}

function openConfirm(): void {
  if (degraded.value) {
    pushToast('failed', '降级模式下不可写回主数据平台')
    return
  }
  writebackError.value = ''
  confirmOpen.value = true
}

async function onConfirm(candidateIds: string[]): Promise<void> {
  // 二次校验：空请求体一条都不写
  if (candidateIds.length === 0 || degraded.value) return
  submitting.value = true
  confirmOpen.value = false
  try {
    const response = await bridge.submitSuggestion<{
      receipts?: WriteReceipt[]
      summary?: BatchSummary
    }>({ candidate_ids: candidateIds, writeback_mode: 'suggestion-only' })
    if (response.ok && response.data) {
      receiptList.value = response.data.receipts ?? []
      summary.value = response.data.summary ?? null
      const failures = receiptList.value.filter((receipt) => receipt.status === 'failed')
      pushToast(
        failures.length ? 'failed' : 'success',
        failures.length ? `写回完成，${failures.length} 条失败，请查看逐条回执` : '写回完成，请查看逐条回执',
      )
    } else {
      writebackError.value = response.message ?? '写回失败，请重试'
      pushToast('failed', `写回失败：${writebackError.value}`)
    }
  } finally {
    submitting.value = false
  }
}

async function onRetry(candidateId: string): Promise<void> {
  if (retrying.value.includes(candidateId)) return
  retrying.value = [...retrying.value, candidateId]
  try {
    const response = await bridge.submitSuggestion<{ receipt?: WriteReceipt }>({
      candidate_ids: [candidateId],
      retry: true,
    })
    if (response.ok && response.data?.receipt) {
      receiptList.value = receiptList.value.map((receipt) =>
        receipt.candidate_id === candidateId ? response.data!.receipt! : receipt,
      )
      pushToast('success', `${candidateId} 已重新提交`)
    } else {
      pushToast('failed', `重试失败：${response.message ?? '请转人工处理'}`)
    }
  } finally {
    retrying.value = retrying.value.filter((id) => id !== candidateId)
  }
}

async function onCopy(recordId: string): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(recordId)
    }
    pushToast('success', `已复制记录 ${recordId}`)
  } catch {
    pushToast('failed', '复制失败，请手动选择记录 ID 复制')
  }
}

async function onCheckNewBatch(): Promise<void> {
  const response = await bridge.checkNewBatch()
  pushToast(
    response.ok ? 'success' : 'failed',
    response.ok ? '已检查新批次' : `检查失败：${response.message ?? '请重试'}`,
  )
  if (response.ok) void loadBatch()
}

async function onExport(): Promise<void> {
  exporting.value = true
  try {
    const response = await bridge.exportSuggestion({
      candidate_ids: suggestionList.value.map((item) => item.candidate_id),
    })
    pushToast(
      response.ok ? 'success' : 'failed',
      response.ok ? '建议已导出' : `导出失败：${response.message ?? '请重试'}`,
    )
  } finally {
    exporting.value = false
  }
}

// 运行态首次进入拉批次；node SSR 不会执行 onMounted
onMounted(() => {
  void loadBatch()
})
</script>

<template>
  <div class="review-desk">
    <StatusBar
      :pending="counts.pending"
      :suggested="counts.suggested"
      :uncertain="counts.uncertain"
      :batch-label="effectiveBatchLabel"
    />
    <button class="review-desk__drawer-toggle" type="button" @click="drawerOpen = !drawerOpen">
      候选列表（{{ total }}）
    </button>

    <DegradeBanner :degraded="degraded" :reason="degradedReason" />

    <main class="review-desk__main">
      <!-- 左：候选卡片流 -->
      <aside class="review-desk__list" :class="{ 'is-open': drawerOpen }" aria-label="候选列表">
        <div class="review-desk__list-head">
          <h2 class="review-desk__list-title">候选卡片流</h2>
          <span class="review-desk__list-count mono">共 {{ total }} 条</span>
        </div>

        <template v-if="phase === 'ready' && orderedList.length">
          <section
            v-for="group in GROUP_VIEW"
            :key="group.key"
            class="review-desk__group"
          >
            <h3 class="review-desk__group-title">
              {{ group.label }}
              <span class="mono">{{ counts[group.key] }}</span>
            </h3>
            <div class="review-desk__cards">
              <CandidateCard
                v-for="candidate in visibleGroups[group.key]"
                :key="candidate.candidate_id"
                :candidate="candidate"
                :conclusion="conclusionMap[candidate.candidate_id] ?? null"
                :selected="candidate.candidate_id === selectedId"
                @select="selectCandidate"
                @copy="onCopy"
                @followup="openFollowup"
              />
              <p v-if="!visibleGroups[group.key].length" class="review-desk__group-empty">
                当前页没有{{ group.label }}条目
              </p>
            </div>
          </section>

          <nav v-if="paged" class="review-desk__pagination" aria-label="候选分页">
            <BaseButton size="sm" variant="neutral" :disabled="page <= 1" @click="page -= 1">
              上一页
            </BaseButton>
            <span class="mono">第 {{ page }} / {{ totalPages }} 页 · 每页 {{ PAGE_SIZE }} 条</span>
            <BaseButton
              size="sm"
              variant="neutral"
              :disabled="page >= totalPages"
              @click="page += 1"
            >
              下一页
            </BaseButton>
          </nav>
        </template>

        <div v-else-if="phase === 'loading'" class="review-desk__loading" role="status">
          <p class="review-desk__state-text">{{ loadingText }}</p>
          <div v-for="n in 3" :key="n" class="review-desk__skeleton-card" aria-hidden="true">
            <span class="review-desk__skeleton-line" />
            <span class="review-desk__skeleton-line is-short" />
            <span class="review-desk__skeleton-line" />
          </div>
        </div>

        <div v-else-if="phase === 'empty'" class="review-desk__blank">
          <p class="review-desk__state-title">{{ emptyView.title }}</p>
          <p class="review-desk__state-text">{{ emptyView.hint }}</p>
          <BaseButton variant="primary" size="sm" @click="onEmptyAction">
            {{ emptyView.action }}
          </BaseButton>
        </div>

        <div v-else-if="phase === 'error'" class="review-desk__state-error" role="alert">
          <p class="review-desk__state-title is-danger">{{ errorView.title }}</p>
          <p class="review-desk__state-text">{{ readableError }}</p>
          <div class="review-desk__error-actions">
            <BaseButton variant="primary" size="sm" @click="onEmptyAction">重试</BaseButton>
            <BaseButton variant="neutral" size="sm" @click="onDegradeContinue">降级继续</BaseButton>
            <BaseButton variant="neutral" size="sm" @click="onToHuman">转人工</BaseButton>
          </div>
        </div>

        <div v-else class="review-desk__blank">
          <p class="review-desk__state-title">候选列表为空</p>
          <p class="review-desk__state-text">请检查批次文件或重新拉取。</p>
          <BaseButton variant="primary" size="sm" @click="onEmptyAction">重新拉取</BaseButton>
        </div>
      </aside>
      <div
        v-if="drawerOpen"
        class="review-desk__drawer-scrim"
        aria-hidden="true"
        @click="drawerOpen = false"
      />

      <!-- 中：详情对照 -->
      <section class="review-desk__detail" aria-label="候选详情">
        <header class="review-desk__detail-head">
          <h2 class="review-desk__section-title">详情对照</h2>
          <code v-if="selectedCandidate" class="review-desk__detail-id mono">
            {{ selectedCandidate.candidate_id }} · {{ selectedCandidate.name }}
          </code>
        </header>

        <template v-if="phase === 'ready' && selectedCandidate">
          <CandidateCard
            :candidate="selectedCandidate"
            :conclusion="selectedConclusion"
            :selected="true"
            @copy="onCopy"
            @followup="openFollowup(selectedCandidate.candidate_id)"
          />
          <FieldCompare :summary="selectedConclusion?.field_diffs ?? null" />
          <EvidenceTable :evidence="selectedConclusion?.evidence ?? []" />
          <p v-if="!selectedConclusion" class="review-desk__detail-hint">
            该候选尚无归并结论，请等待评估或转人工处理。
          </p>
          <p v-if="selectedConclusion?.rationale" class="review-desk__rationale">
            归并理由：{{ selectedConclusion.rationale }}
          </p>
        </template>
        <div v-else class="review-desk__detail-blank">
          <p class="review-desk__state-text">
            {{ phase === 'loading' ? '正在比对院内主数据，详情稍后呈现…' : '选中左侧候选后显示字段对照与证据。' }}
          </p>
        </div>
      </section>

      <!-- 右：追问栏 -->
      <SessionPane
        :turns="selectedSession?.turns ?? []"
        :degraded="degraded"
        :uncertain-unreviewed="uncertainUnreviewed"
        :has-conclusion="Boolean(selectedConclusion)"
        :loading="asking"
        :candidate-id="selectedId"
        @ask="onAsk"
      />
    </main>

    <!-- 底部操作区 -->
    <footer class="review-desk__actions">
      <BaseButton variant="neutral" :disabled="submitting" @click="onCheckNewBatch">
        检查新批次
      </BaseButton>
      <BaseButton
        variant="neutral"
        :disabled="submitting || !suggestionList.length"
        :loading="exporting"
        @click="onExport"
      >
        导出建议
      </BaseButton>
      <span class="review-desk__actions-hint">可写回建议 {{ suggestionList.length }} 条 · 只写建议不推进状态</span>
      <BaseButton
        variant="primary"
        :disabled="!canWriteback"
        :loading="submitting"
        @click="openConfirm"
      >
        写回主数据平台
      </BaseButton>
    </footer>

    <section v-if="receiptList.length" class="review-desk__receipts" aria-label="写回回执">
      <ReceiptList
        :receipts="receiptList"
        :summary="summary"
        :retrying-ids="retrying"
        @retry="onRetry"
      />
    </section>

    <ConfirmDialog
      :open="confirmOpen"
      :suggestions="suggestionList"
      :submitting="submitting"
      :error="writebackError"
      @confirm="onConfirm"
      @cancel="confirmOpen = false"
    />
    <ToastStack :toasts="toasts" @dismiss="dismissToast" />
  </div>
</template>

<style scoped>
.review-desk {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 100vw;
  min-height: 100vh;
  overflow-x: hidden;
  background: var(--color-surface-base);
  color: var(--color-text-primary);
  font-family: var(--font-family-ui);
}

.review-desk__drawer-toggle {
  display: none;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-2) var(--space-4) 0;
  padding: var(--space-2) var(--space-3);
  border: var(--border-width) solid var(--color-border-strong);
  border-radius: var(--radius-overlay);
  background: var(--color-surface-panel);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
}

.review-desk__drawer-toggle:hover {
  background: var(--color-hover-bg);
  border-color: var(--color-primary);
}

.review-desk__drawer-toggle:active {
  background: var(--color-active-bg);
}

/* 1280 三区：列表 / 详情 / 追问 */
.review-desk__main {
  display: grid;
  grid-template-columns: minmax(320px, 1fr) minmax(420px, 1.3fr) minmax(280px, 0.9fr);
  gap: var(--space-4);
  flex: 1;
  min-height: 0;
  padding: var(--space-4) var(--space-5);
  overflow: hidden;
}

.review-desk__main > * {
  min-width: 0;
}

.review-desk__list,
.review-desk__detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-3);
  background: var(--color-surface-panel);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
}

.review-desk__list-head,
.review-desk__detail-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.review-desk__list-title,
.review-desk__section-title {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
}

.review-desk__list-count,
.review-desk__detail-id {
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  overflow-wrap: anywhere;
}

.review-desk__group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.review-desk__group-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  text-transform: none;
}

.review-desk__group-title .mono {
  color: var(--color-primary);
}

.review-desk__cards {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.review-desk__group-empty {
  margin: 0;
  padding: var(--space-3);
  color: var(--color-text-placeholder);
  font-size: var(--font-size-xs);
  text-align: center;
}

.review-desk__pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

/* 加载 / 空 / 错误三态 */
.review-desk__loading,
.review-desk__blank,
.review-desk__state-error,
.review-desk__detail-blank {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  align-items: flex-start;
}

.review-desk__blank,
.review-desk__state-error,
.review-desk__detail-blank {
  padding: var(--space-6) var(--space-4);
  text-align: left;
}

.review-desk__state-title {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
}

.review-desk__state-title.is-danger {
  color: var(--color-danger);
}

.review-desk__state-text {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  overflow-wrap: anywhere;
}

.review-desk__error-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.review-desk__skeleton-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-card);
  background: var(--color-surface-base);
}

.review-desk__skeleton-line {
  height: 10px;
  border-radius: var(--radius-pill);
  background: var(--color-skeleton);
  animation: token-pulse 1200ms ease-in-out infinite;
}

.review-desk__skeleton-line.is-short {
  width: 60%;
}

.review-desk__detail-hint,
.review-desk__rationale {
  margin: 0;
  padding: var(--space-3);
  border-radius: var(--radius-overlay);
  font-size: var(--font-size-sm);
  overflow-wrap: anywhere;
}

.review-desk__detail-hint {
  background: var(--color-action-uncertain-soft);
  color: var(--color-action-uncertain);
}

.review-desk__rationale {
  background: var(--color-surface-base);
  color: var(--color-text-secondary);
}

/* 底部操作区 */
.review-desk__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-5);
  background: var(--color-surface-panel);
  border-top: var(--border-width) solid var(--color-border);
}

.review-desk__actions-hint {
  margin-right: auto;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.review-desk__receipts {
  padding: 0 var(--space-5) var(--space-4);
}

.review-desk__drawer-scrim {
  display: none;
}

@media (max-width: 1023px) {
  /* 768 两区：详情与追问上下排列，列表收进抽屉 */
  .review-desk__drawer-toggle {
    display: inline-flex;
    align-self: flex-start;
  }

  .review-desk__main {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto;
    overflow-y: auto;
    padding: var(--space-3) var(--space-4);
  }

  .review-desk__list {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: var(--z-drawer);
    width: min(340px, 86vw);
    max-height: 100vh;
    border-radius: 0;
    box-shadow: var(--shadow-modal);
    transform: translateX(-100%);
    transition: transform var(--transition-fast);
  }

  .review-desk__list.is-open {
    transform: translateX(0);
  }

  .review-desk__drawer-scrim {
    display: block;
    position: fixed;
    inset: 0;
    z-index: calc(var(--z-drawer) - 1);
    background: var(--color-overlay);
  }

  .review-desk__detail,
  .review-desk__main > .session-pane {
    max-height: none;
    overflow-y: visible;
  }

  .review-desk__actions {
    padding: var(--space-3) var(--space-4);
  }

  .review-desk__receipts {
    padding: 0 var(--space-4) var(--space-3);
  }
}
</style>
