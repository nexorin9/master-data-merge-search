<script setup lang="ts">
/**
 * 基础按钮：四态（hover / active / disabled / loading）。
 * 语义色一律经 token 变量引用，本文件不含任何色值字面量。
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'create' | 'uncertain' | 'danger' | 'neutral'
    size?: 'sm' | 'md'
    disabled?: boolean
    loading?: boolean
    block?: boolean
    type?: 'button' | 'submit' | 'reset'
  }>(),
  { variant: 'primary', size: 'md', disabled: false, loading: false, block: false, type: 'button' },
)

const emit = defineEmits<{ click: [event: MouseEvent] }>()

const isDisabled = computed(() => props.disabled || props.loading)

function onClick(event: MouseEvent): void {
  if (isDisabled.value) return
  emit('click', event)
}
</script>

<template>
  <button
    class="base-button"
    :class="[
      `base-button--${variant}`,
      `base-button--${size}`,
      { 'is-block': block, 'is-disabled': isDisabled, 'is-loading': loading },
    ]"
    :type="type"
    :disabled="isDisabled"
    :aria-busy="loading || undefined"
    @click="onClick"
  >
    <span v-if="loading" class="base-button__spinner" aria-hidden="true" />
    <span class="base-button__label"><slot /></span>
  </button>
</template>

<style scoped>
.base-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  border: var(--border-width) solid transparent;
  border-radius: var(--radius-overlay);
  font-weight: var(--font-weight-medium);
  white-space: nowrap;
  transition: background var(--transition-fast), border-color var(--transition-fast),
    box-shadow var(--transition-fast), opacity var(--transition-fast);
}

.base-button--sm {
  height: var(--control-height-sm);
  padding: 0 var(--space-2);
  font-size: var(--font-size-xs);
}

.base-button--md {
  height: var(--control-height-md);
  padding: 0 var(--space-4);
  font-size: var(--font-size-sm);
}

.base-button.is-block {
  width: 100%;
}

/* active 态：按下时轻微下沉 */
.base-button:not(.is-disabled):active {
  transform: translateY(1px);
}

/* disabled 与 loading 共用视觉弱化，loading 额外禁点 */
.base-button.is-disabled {
  opacity: var(--opacity-disabled);
  cursor: not-allowed;
  box-shadow: none;
  transform: none;
}

.base-button__label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.base-button__spinner {
  width: 12px;
  height: 12px;
  flex: none;
  border: 2px solid var(--color-loading-track);
  border-top-color: currentcolor;
  border-radius: var(--radius-pill);
  animation: token-spin 700ms linear infinite;
}

/* 主色 = 并入 */
.base-button--primary {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: var(--color-text-inverse);
}
.base-button--primary:hover:not(.is-disabled) {
  background: var(--color-primary-hover);
  border-color: var(--color-primary-hover);
}
.base-button--primary:active:not(.is-disabled) {
  background: var(--color-primary-active);
  border-color: var(--color-primary-active);
}
.base-button--primary.is-disabled {
  background: var(--color-primary-disabled);
  border-color: var(--color-primary-disabled);
  color: var(--color-text-inverse);
}

/* 新建绿 */
.base-button--create {
  background: var(--color-action-create);
  border-color: var(--color-action-create);
  color: var(--color-text-inverse);
}
.base-button--create:hover:not(.is-disabled) {
  background: var(--color-action-create-hover);
  border-color: var(--color-action-create-hover);
}
.base-button--create:active:not(.is-disabled) {
  background: var(--color-action-create);
}
.base-button--create.is-disabled {
  background: var(--color-disabled-bg);
  border-color: var(--color-disabled-border);
  color: var(--color-disabled-text);
}

/* 存疑琥珀 */
.base-button--uncertain {
  background: var(--color-action-uncertain);
  border-color: var(--color-action-uncertain);
  color: var(--color-text-inverse);
}
.base-button--uncertain:hover:not(.is-disabled) {
  background: var(--color-action-uncertain-hover);
  border-color: var(--color-action-uncertain-hover);
}
.base-button--uncertain:active:not(.is-disabled) {
  background: var(--color-action-uncertain);
}
.base-button--uncertain.is-disabled {
  background: var(--color-disabled-bg);
  border-color: var(--color-disabled-border);
  color: var(--color-disabled-text);
}

/* 失败红：破坏性操作 */
.base-button--danger {
  background: var(--color-action-failed);
  border-color: var(--color-action-failed);
  color: var(--color-text-inverse);
}
.base-button--danger:hover:not(.is-disabled) {
  background: var(--color-action-failed-hover);
  border-color: var(--color-action-failed-hover);
}
.base-button--danger:active:not(.is-disabled) {
  background: var(--color-action-failed);
}
.base-button--danger.is-disabled {
  background: var(--color-disabled-bg);
  border-color: var(--color-disabled-border);
  color: var(--color-disabled-text);
}

/* 中性：次要对冲操作 */
.base-button--neutral {
  background: var(--color-surface-panel);
  border-color: var(--color-border-strong);
  color: var(--color-text-primary);
}
.base-button--neutral:hover:not(.is-disabled) {
  background: var(--color-hover-bg);
  border-color: var(--color-primary);
}
.base-button--neutral:active:not(.is-disabled) {
  background: var(--color-active-bg);
}
.base-button--neutral.is-disabled {
  background: var(--color-disabled-bg);
  border-color: var(--color-disabled-border);
  color: var(--color-disabled-text);
}
</style>
