<script setup lang="ts">
/**
 * 写回确认框：逐条列出待写回建议，默认全不勾选；
 * 勾 0 条时提交按钮禁用、请求体为空条目；提交前再次校验。
 * 二次确认明示：只写建议、不推进候选状态，未勾选一条都不写。
 */
import { computed, ref, watch } from 'vue'
import type { Action } from '../../core/types'
import BaseButton from './base/BaseButton.vue'
import BaseModal from './base/BaseModal.vue'
import BaseTag from './base/BaseTag.vue'

interface Suggestion {
  candidate_id: string
  action: Action
  target_code: string | null
  rationale: string
  idempotency_key?: string
}

const props = withDefaults(
  defineProps<{
    open?: boolean
    suggestions?: Suggestion[]
    submitting?: boolean
    error?: string
  }>(),
  { open: false, suggestions: () => [], submitting: false, error: '' },
)

const emit = defineEmits<{
  confirm: [candidateIds: string[]]
  cancel: []
}>()

/** 默认全不勾选：只有显式勾选的 id 才会进入请求体。 */
const selected = ref<string[]>([])

// 建议集合变化时剔除已不存在的选中项，避免脏 id 被写回
watch(
  () => props.suggestions,
  (list) => {
    const ids = new Set(list.map((item) => item.candidate_id))
    selected.value = selected.value.filter((id) => ids.has(id))
  },
)

const selectedCount = computed(() => selected.value.length)
const totalCount = computed(() => props.suggestions.length)
const canSubmit = computed(() => selectedCount.value > 0 && !props.submitting)

function isChecked(id: string): boolean {
  return selected.value.includes(id)
}

function onToggle(id: string, event: Event): void {
  if (props.submitting) return
  const checked = (event.target as HTMLInputElement).checked
  const next = new Set(selected.value)
  if (checked) next.add(id)
  else next.delete(id)
  // 保持与 suggestions 同序，请求体顺序稳定
  selected.value = props.suggestions
    .map((item) => item.candidate_id)
    .filter((candidateId) => next.has(candidateId))
}

function actionLabel(action: Action): string {
  return action === 'create' ? '新建' : action === 'merge' ? '并入' : '存疑'
}

function actionTone(action: Action): 'create' | 'merge' | 'uncertain' {
  return action === 'create' ? 'create' : action === 'merge' ? 'merge' : 'uncertain'
}

function submit(): void {
  // 未勾选一条都不写：请求体为空则直接拦截
  if (selected.value.length === 0 || props.submitting) return
  emit('confirm', [...selected.value])
}
</script>

<template>
  <div
    class="confirm-dialog"
    :data-writeback-count="selectedCount"
    :data-total-count="totalCount"
  >
    <BaseModal
      :open="open"
      title="写回主数据平台 · 二次确认"
      width="720px"
      :loading="submitting"
      @close="emit('cancel')"
    >
      <p class="confirm-dialog__notice" role="note">
        二次确认：本次<strong>只写建议不推进状态</strong>——仅向 MDM 候选池写入建议记录，
        <strong>不会推进候选状态</strong>；未勾选的条目一条都不写。
      </p>

      <div class="confirm-dialog__toolbar">
        <span class="confirm-dialog__counter">
          已选 <strong class="mono">{{ selectedCount }}</strong> 条 / 共
          <strong class="mono">{{ totalCount }}</strong> 条
        </span>
        <span class="confirm-dialog__hint">逐条勾选需要写回的建议</span>
      </div>

      <ul v-if="suggestions.length" class="confirm-dialog__list">
        <li v-for="item in suggestions" :key="item.candidate_id" class="confirm-dialog__item">
          <label class="confirm-dialog__label">
            <input
              class="confirm-dialog__checkbox"
              type="checkbox"
              :checked="isChecked(item.candidate_id)"
              :disabled="submitting"
              @change="onToggle(item.candidate_id, $event)"
            />
            <code class="confirm-dialog__candidate-id mono">{{ item.candidate_id }}</code>
            <BaseTag :tone="actionTone(item.action)" size="sm">{{ actionLabel(item.action) }}</BaseTag>
            <span class="confirm-dialog__target">
              目标 <code class="mono">{{ item.target_code ?? '—' }}</code>
            </span>
            <span class="confirm-dialog__rationale">{{ item.rationale }}</span>
            <span v-if="item.idempotency_key" class="confirm-dialog__idempotency mono">
              幂等键 {{ item.idempotency_key.slice(0, 8) }}
            </span>
          </label>
        </li>
      </ul>
      <p v-else class="confirm-dialog__empty">当前没有可写回的建议，请先完成候选评估。</p>

      <p v-if="error" class="confirm-dialog__error" role="alert">{{ error }}</p>

      <template #footer>
        <BaseButton variant="neutral" :disabled="submitting" @click="emit('cancel')">取消</BaseButton>
        <BaseButton
          variant="primary"
          :disabled="!canSubmit"
          :loading="submitting"
          @click="submit"
        >
          确认写回（{{ selectedCount }} 条）
        </BaseButton>
      </template>
    </BaseModal>
  </div>
</template>

<style scoped>
.confirm-dialog__notice {
  margin: 0 0 var(--space-3);
  padding: var(--space-3);
  background: var(--color-primary-soft);
  border: var(--border-width) solid var(--color-primary-border);
  border-radius: var(--radius-overlay);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
}

.confirm-dialog__notice strong {
  color: var(--color-primary);
}

.confirm-dialog__toolbar {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  padding-bottom: var(--space-2);
  border-bottom: var(--border-width) solid var(--color-border);
  font-size: var(--font-size-sm);
}

.confirm-dialog__hint {
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.confirm-dialog__list {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 46vh;
  overflow-y: auto;
}

.confirm-dialog__item {
  border-bottom: var(--border-width) solid var(--color-border);
}

.confirm-dialog__item:last-child {
  border-bottom: none;
}

.confirm-dialog__label {
  display: grid;
  grid-template-columns: auto 140px 52px 1fr;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-3) var(--space-2);
  cursor: pointer;
  transition: background var(--transition-fast);
}

.confirm-dialog__label:hover {
  background: var(--color-hover-row);
}

.confirm-dialog__label:focus-within {
  background: var(--color-active-row);
}

.confirm-dialog__checkbox {
  width: 16px;
  height: 16px;
  accent-color: var(--color-primary);
  cursor: pointer;
}

.confirm-dialog__candidate-id {
  font-size: var(--font-size-xs);
  color: var(--color-text-primary);
}

.confirm-dialog__target {
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.confirm-dialog__rationale {
  grid-column: 2 / -1;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  overflow-wrap: anywhere;
}

.confirm-dialog__idempotency {
  grid-column: 2 / -1;
  color: var(--color-text-placeholder);
  font-size: var(--font-size-xs);
}

.confirm-dialog__empty,
.confirm-dialog__error {
  margin: var(--space-4) 0;
  font-size: var(--font-size-sm);
  text-align: center;
}

.confirm-dialog__empty {
  color: var(--color-text-secondary);
}

.confirm-dialog__error {
  color: var(--color-danger);
}
</style>
