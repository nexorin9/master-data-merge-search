<script setup lang="ts">
/**
 * 基础模态层：四态（关闭按钮 hover / active / disabled / loading）。
 * 不使用 Teleport，避免 node SSR 缺少 document 时抛错；直接层叠在原地。
 */
const props = withDefaults(
  defineProps<{
    open?: boolean
    title?: string
    closable?: boolean
    disabled?: boolean
    loading?: boolean
    width?: string
  }>(),
  {
    open: false,
    title: '',
    closable: true,
    disabled: false,
    loading: false,
    width: '560px',
  },
)

const emit = defineEmits<{ close: [] }>()

function requestClose(): void {
  // loading / disabled 时禁止关闭，防止破坏性流程被打断
  if (props.loading || props.disabled || !props.closable) return
  emit('close')
}
</script>

<template>
  <div v-if="open" class="base-modal" :class="{ 'is-loading': loading }">
    <div class="base-modal__backdrop" aria-hidden="true" @click="requestClose" />
    <section
      class="base-modal__panel"
      :style="{ maxWidth: width }"
      role="dialog"
      aria-modal="true"
      :aria-label="title || undefined"
      :aria-busy="loading || undefined"
    >
      <header class="base-modal__header">
        <h2 class="base-modal__title">{{ title }}</h2>
        <button
          v-if="closable"
          class="base-modal__close"
          type="button"
          aria-label="关闭"
          :disabled="loading || disabled"
          @click="requestClose"
        >
          ×
        </button>
      </header>
      <div class="base-modal__body"><slot /></div>
      <footer v-if="$slots.footer" class="base-modal__footer"><slot name="footer" /></footer>
      <div v-if="loading" class="base-modal__loading" role="status">
        <span class="base-modal__spinner" aria-hidden="true" />
        正在处理…
      </div>
    </section>
  </div>
</template>

<style scoped>
.base-modal {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-5);
}

.base-modal__backdrop {
  position: absolute;
  inset: 0;
  background: var(--color-overlay);
}

.base-modal__panel {
  position: relative;
  z-index: var(--z-overlay);
  width: 100%;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  background: var(--color-surface-panel);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-modal);
  box-shadow: var(--shadow-modal);
  overflow: hidden;
}

.base-modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4);
  border-bottom: var(--border-width) solid var(--color-border);
}

.base-modal__title {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
}

.base-modal__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--control-height-md);
  height: var(--control-height-md);
  flex: none;
  border: var(--border-width) solid transparent;
  border-radius: var(--radius-overlay);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xl);
  line-height: 1;
  transition: background var(--transition-fast), color var(--transition-fast),
    border-color var(--transition-fast);
}

/* hover 态 */
.base-modal__close:hover:not(:disabled) {
  background: var(--color-hover-bg);
  color: var(--color-text-primary);
}

/* active 态 */
.base-modal__close:active:not(:disabled) {
  background: var(--color-active-bg);
}

/* disabled 态 */
.base-modal__close:disabled,
.base-modal.is-loading .base-modal__close {
  opacity: var(--opacity-disabled);
  cursor: not-allowed;
}

.base-modal__body {
  padding: var(--space-4);
  overflow-y: auto;
}

.base-modal__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-top: var(--border-width) solid var(--color-border);
  background: var(--color-surface-base);
}

.base-modal__loading {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  border-top: var(--border-width) solid var(--color-border);
}

.base-modal__spinner {
  width: 13px;
  height: 13px;
  border: 2px solid var(--color-loading-track);
  border-top-color: var(--color-loading-indicator);
  border-radius: var(--radius-pill);
  animation: token-spin 700ms linear infinite;
}
</style>
