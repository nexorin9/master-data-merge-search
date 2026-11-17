<script setup lang="ts">
/**
 * 基础输入框：四态（hover / active / disabled / loading）。
 * active 用 :focus-within 表达聚焦态，visible 焦点环继承 tokens.css。
 */
withDefaults(
  defineProps<{
    modelValue?: string
    placeholder?: string
    disabled?: boolean
    loading?: boolean
    readonly?: boolean
    invalid?: boolean
    type?: 'text' | 'search'
    ariaLabel?: string
  }>(),
  {
    modelValue: '',
    placeholder: '',
    disabled: false,
    loading: false,
    readonly: false,
    invalid: false,
    type: 'text',
    ariaLabel: '',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  enter: [value: string]
}>()

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    emit('enter', (event.target as HTMLInputElement).value)
  }
}
</script>

<template>
  <span
    class="base-input"
    :class="{
      'is-disabled': disabled || loading,
      'is-loading': loading,
      'is-invalid': invalid,
    }"
  >
    <input
      class="base-input__control"
      :type="type"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled || loading"
      :readonly="readonly"
      :aria-label="ariaLabel || undefined"
      :aria-invalid="invalid || undefined"
      :aria-busy="loading || undefined"
      @input="onInput"
      @keydown="onKeydown"
    />
    <span v-if="loading" class="base-input__spinner" aria-hidden="true" />
  </span>
</template>

<style scoped>
.base-input {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 100%;
}

.base-input__control {
  width: 100%;
  height: var(--control-height-md);
  padding: 0 var(--space-3);
  border: var(--border-width) solid var(--color-border-strong);
  border-radius: var(--radius-overlay);
  background: var(--color-surface-panel);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  outline: none;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast),
    background var(--transition-fast);
}

.base-input__control::placeholder {
  color: var(--color-text-placeholder);
}

/* hover 态 */
.base-input:not(.is-disabled):hover .base-input__control {
  border-color: var(--color-primary);
}

/* active 态：聚焦 */
.base-input:not(.is-disabled):focus-within .base-input__control {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-focus-ring);
}

/* active 态：按下 */
.base-input:not(.is-disabled):active .base-input__control {
  border-color: var(--color-primary-active);
}

/* disabled 态 */
.base-input.is-disabled .base-input__control {
  background: var(--color-disabled-bg);
  border-color: var(--color-disabled-border);
  color: var(--color-disabled-text);
  cursor: not-allowed;
}

/* loading 态：右侧转圈，不可编辑 */
.base-input.is-loading .base-input__control {
  padding-right: var(--space-7);
  cursor: progress;
}

.base-input.is-invalid .base-input__control {
  border-color: var(--color-danger);
}

.base-input__spinner {
  position: absolute;
  right: var(--space-3);
  width: 13px;
  height: 13px;
  border: 2px solid var(--color-loading-track);
  border-top-color: var(--color-loading-indicator);
  border-radius: var(--radius-pill);
  animation: token-spin 700ms linear infinite;
}
</style>
