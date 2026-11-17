<script setup lang="ts">
/**
 * 候选卡片：三态标签 + 主键行 + 摘要行 + 置信度/证据条数 + 主数据 code/record_id + 复制按钮。
 * 中段放 2 行精简并排对照，完整对照由 FieldCompare 在详情区承担。
 */
import { computed } from 'vue'
import type {
  Action,
  CandidateRecord,
  Domain,
  MasterDataRecord,
  MergeConclusion,
} from '../../core/types'
import BaseButton from './base/BaseButton.vue'
import BaseTag from './base/BaseTag.vue'

const props = withDefaults(
  defineProps<{
    candidate: CandidateRecord
    conclusion?: MergeConclusion | null
    target?: MasterDataRecord | null
    selected?: boolean
  }>(),
  { conclusion: null, target: null, selected: false },
)

const emit = defineEmits<{
  select: [candidateId: string]
  copy: [text: string]
  followup: [candidateId: string]
}>()

const DOMAIN_LABEL: Record<Domain, string> = {
  drug: '药品',
  fee_item: '诊疗项目',
  department: '科室',
  exam: '检查',
}

const ACTION_VIEW: Record<
  Action | 'pending',
  { label: string; tone: 'merge' | 'create' | 'uncertain' | 'neutral' }
> = {
  create: { label: '新建', tone: 'create' },
  merge: { label: '并入', tone: 'merge' },
  uncertain: { label: '存疑', tone: 'uncertain' },
  pending: { label: '待评', tone: 'neutral' },
}

const action = computed<Action | 'pending'>(() => props.conclusion?.action ?? 'pending')
const view = computed(() => ACTION_VIEW[action.value])
const evidenceCount = computed(() => props.conclusion?.evidence.length ?? 0)
const confidenceText = computed(() =>
  props.conclusion ? `${Math.round(props.conclusion.confidence * 100)}%` : '待评',
)

const summary = computed(() => {
  if (!props.conclusion) return '尚未评估，等待结论'
  if (props.conclusion.action === 'uncertain') {
    return `存疑：${props.conclusion.uncertain_reason ?? '待人工复核'}`
  }
  return `建议${props.conclusion.action === 'create' ? '新建' : '并入'}目标 ${props.conclusion.target_code ?? '未指定'}`
})

const codeText = computed(() => props.target?.code ?? props.conclusion?.target_code ?? '—')
const recordIdText = computed(
  () => props.target?.record_id ?? props.conclusion?.evidence[0]?.record_id ?? '—',
)
const canCopy = computed(() => recordIdText.value !== '—')

/** 精简并排对照：取字段级对照前两行，conflict 用失败色高亮。 */
const peekRows = computed(() => (props.conclusion?.field_diffs?.diffs ?? []).slice(0, 2))

function displayValue(value: string | null, kind: string, side: 'candidate' | 'matched'): string {
  if (value === null) {
    return side === 'candidate' && kind === 'missing'
      ? '候选缺该字段'
      : side === 'matched' && kind === 'absent'
        ? '主数据无该字段'
        : '—'
  }
  return value
}
</script>

<template>
  <article
    class="candidate-card"
    :class="[
      `candidate-card--${view.tone}`,
      { 'is-selected': selected },
    ]"
    :aria-selected="selected"
    tabindex="0"
    @click="emit('select', candidate.candidate_id)"
    @keydown.enter="emit('select', candidate.candidate_id)"
  >
    <div class="candidate-card__top">
      <BaseTag :tone="view.tone" size="md">
        {{ view.label }}
      </BaseTag>
      <div class="candidate-card__top-right">
        <span class="candidate-card__evidence-count">证据 {{ evidenceCount }} 条</span>
        <BaseButton size="sm" variant="neutral" @click.stop="emit('followup', candidate.candidate_id)">
          追问
        </BaseButton>
      </div>
    </div>

    <div class="candidate-card__key-row">
      <code class="candidate-card__candidate-id">{{ candidate.candidate_id }}</code>
      <span class="candidate-card__domain">{{ DOMAIN_LABEL[candidate.domain] }}</span>
      <strong class="candidate-card__name">{{ candidate.name }}</strong>
    </div>

    <p class="candidate-card__summary" :class="{ 'is-uncertain': action === 'uncertain' }">
      {{ summary }}
    </p>

    <div v-if="peekRows.length" class="candidate-card__peek">
      <div class="candidate-card__peek-head">
        <span>字段</span><span>候选值</span><span>命中值（主数据）</span>
      </div>
      <div
        v-for="diff in peekRows"
        :key="diff.field"
        class="candidate-card__peek-row"
        :class="{ 'is-conflict': diff.kind === 'conflict' }"
        :data-kind="diff.kind"
      >
        <span class="candidate-card__peek-field">{{ diff.field }}</span>
        <span class="mono">{{ displayValue(diff.candidate_value, diff.kind, 'candidate') }}</span>
        <span class="mono">{{ displayValue(diff.matched_value, diff.kind, 'matched') }}</span>
      </div>
    </div>

    <div class="candidate-card__meta">
      <span>置信度 <strong class="mono">{{ confidenceText }}</strong></span>
      <span>证据 <strong class="mono">{{ evidenceCount }}</strong> 条</span>
    </div>

    <div class="candidate-card__master-row">
      <span class="candidate-card__master-label">主数据</span>
      <code class="candidate-card__code">#{{ codeText }}</code>
      <span class="candidate-card__dot">·</span>
      <span class="candidate-card__master-label">记录</span>
      <code class="candidate-card__record-id">{{ recordIdText }}</code>
      <BaseButton
        size="sm"
        variant="neutral"
        :disabled="!canCopy"
        @click.stop="canCopy && emit('copy', recordIdText)"
      >
        复制
      </BaseButton>
    </div>
  </article>
</template>

<style scoped>
.candidate-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  background: var(--color-surface-panel);
  border: var(--border-width) solid var(--color-border);
  border-left: 3px solid var(--color-border-strong);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
  cursor: pointer;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast),
    transform var(--transition-fast);
}

.candidate-card:hover {
  box-shadow: var(--shadow-overlay);
}

.candidate-card:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.candidate-card.is-selected {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-focus-ring);
}

.candidate-card--merge { border-left-color: var(--color-action-merge); }
.candidate-card--create { border-left-color: var(--color-action-create); }
.candidate-card--uncertain { border-left-color: var(--color-action-uncertain); }
.candidate-card--neutral { border-left-color: var(--color-border-strong); }

.candidate-card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.candidate-card__top-right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.candidate-card__key-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.candidate-card__candidate-id {
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.candidate-card__domain {
  padding: 0 var(--space-1);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-pill);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.candidate-card__name {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
}

.candidate-card__summary {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.candidate-card__summary.is-uncertain {
  color: var(--color-action-uncertain);
}

/* 精简并排对照 */
.candidate-card__peek {
  display: grid;
  gap: 2px;
  padding: var(--space-2);
  border-radius: var(--radius-overlay);
  background: var(--color-surface-base);
}

.candidate-card__peek-head,
.candidate-card__peek-row {
  display: grid;
  grid-template-columns: 88px 1fr 1fr;
  gap: var(--space-2);
  padding: 2px var(--space-1);
  font-size: var(--font-size-xs);
}

.candidate-card__peek-head {
  color: var(--color-text-secondary);
  font-weight: var(--font-weight-medium);
}

.candidate-card__peek-row {
  color: var(--color-text-primary);
}

.candidate-card__peek-field {
  color: var(--color-text-secondary);
}

.candidate-card__peek-row.is-conflict {
  background: var(--color-danger-soft);
  border-radius: var(--radius-card);
  color: var(--color-danger);
}
.candidate-card__peek-row.is-conflict .mono {
  color: var(--color-danger);
}

/* 等宽对齐：候选主键、字段值 */
.candidate-card__peek-row .mono,
.candidate-card__code,
.candidate-card__record-id {
  overflow-wrap: anywhere;
}

.candidate-card__meta {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.candidate-card__meta strong {
  color: var(--color-text-primary);
}

.candidate-card__master-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: var(--border-width) dashed var(--color-border);
  font-size: var(--font-size-xs);
}

.candidate-card__master-label,
.candidate-card__dot {
  color: var(--color-text-secondary);
}

.candidate-card__code,
.candidate-card__record-id {
  color: var(--color-text-primary);
  font-size: var(--font-size-xs);
}

.candidate-card__master-row :deep(.base-button) {
  margin-left: auto;
}
</style>
