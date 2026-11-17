<script setup lang="ts">
/**
 * 基础标签：承载三态语义色（并入 / 新建 / 存疑）+ 失败态，四态齐备。
 * 默认 span 只展示；interactive=true 时渲染 button，支持键盘可达。
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    tone?: 'merge' | 'create' | 'uncertain' | 'failed' | 'neutral'
    size?: 'sm' | 'md'
    interactive?: boolean
    active?: boolean
    disabled?: boolean
    loading?: boolean
  }>(),
  {
    tone: 'neutral',
    size: 'sm',
    interactive: false,
    active: false,
    disabled: false,
    loading: false,
  },
)

const emit = defineEmits<{ click: [] }>()

const isDisabled = computed(() => props.disabled || props.loading)
const tag = computed(() => (props.interactive ? 'button' : 'span'))

function onClick(): void {
  if (!props.interactive || isDisabled.value) return
  emit('click')
}
</script>

<template>
  <component
    :is="tag"
    class="base-tag"
    :class="[
      `base-tag--${tone}`,
      `base-tag--${size}`,
      { 'is-active': active, 'is-disabled': isDisabled, 'is-loading': loading },
    ]"
    :type="interactive ? 'button' : undefined"
    :disabled="interactive ? isDisabled : undefined"
    :aria-busy="loading || undefined"
    @click="onClick"
  >
    <span v-if="loading" class="base-tag__spinner" aria-hidden="true" />
    <slot />
  </component>
</template>

<style scoped>
.base-tag {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  border: var(--border-width) solid transparent;
  border-radius: var(--radius-pill);
  font-weight: var(--font-weight-medium);
  line-height: var(--line-height-tight);
  white-space: nowrap;
  transition: background var(--transition-fast), border-color var(--transition-fast),
    color var(--transition-fast), opacity var(--transition-fast);
}

.base-tag--sm {
  padding: 2px var(--space-2);
  font-size: var(--font-size-xs);
}

.base-tag--md {
  padding: var(--space-1) var(--space-3);
  font-size: var(--font-size-sm);
}

/* active 态：选中加深 */
.base-tag.is-active {
  font-weight: var(--font-weight-semibold);
  box-shadow: 0 0 0 2px var(--color-focus-ring);
}

/* disabled / loading 态 */
.base-tag.is-disabled {
  opacity: var(--opacity-disabled);
  cursor: not-allowed;
}

/* active 态：按下 */
button.base-tag:active:not(.is-disabled) {
  transform: translateY(1px);
}

.base-tag[role='button'],
button.base-tag {
  cursor: pointer;
}

.base-tag__spinner {
  width: 10px;
  height: 10px;
  flex: none;
  border: 2px solid var(--color-loading-track);
  border-top-color: currentcolor;
  border-radius: var(--radius-pill);
  animation: token-spin 700ms linear infinite;
}

/* 并入 = 主色 */
.base-tag--merge {
  background: var(--color-action-merge-soft);
  border-color: var(--color-primary-border);
  color: var(--color-action-merge);
}
.base-tag--merge:hover:not(.is-disabled) {
  border-color: var(--color-action-merge);
}
.base-tag--merge.is-active {
  background: var(--color-action-merge);
  color: var(--color-text-inverse);
}

/* 新建绿 */
.base-tag--create {
  background: var(--color-action-create-soft);
  border-color: var(--color-action-create);
  color: var(--color-action-create);
}
.base-tag--create:hover:not(.is-disabled) {
  border-color: var(--color-action-create-hover);
}
.base-tag--create.is-active {
  background: var(--color-action-create);
  color: var(--color-text-inverse);
}

/* 存疑琥珀 */
.base-tag--uncertain {
  background: var(--color-action-uncertain-soft);
  border-color: var(--color-action-uncertain);
  color: var(--color-action-uncertain);
}
.base-tag--uncertain:hover:not(.is-disabled) {
  border-color: var(--color-action-uncertain-hover);
}
.base-tag--uncertain.is-active {
  background: var(--color-action-uncertain);
  color: var(--color-text-inverse);
}

/* 失败红 */
.base-tag--failed {
  background: var(--color-action-failed-soft);
  border-color: var(--color-action-failed);
  color: var(--color-action-failed);
}
.base-tag--failed:hover:not(.is-disabled) {
  border-color: var(--color-action-failed-hover);
}
.base-tag--failed.is-active {
  background: var(--color-action-failed);
  color: var(--color-text-inverse);
}

/* 中性 */
.base-tag--neutral {
  background: var(--color-surface-muted);
  border-color: var(--color-border);
  color: var(--color-text-secondary);
}
.base-tag--neutral:hover:not(.is-disabled) {
  border-color: var(--color-border-strong);
}
.base-tag--neutral.is-active {
  background: var(--color-active-bg);
  color: var(--color-text-primary);
}
</style>
