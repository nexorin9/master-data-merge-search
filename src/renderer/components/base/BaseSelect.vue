<script setup lang="ts">
/**
 * 基础下拉选择：四态（hover / active / disabled / loading）。
 * 选项由 props 注入，组件不自行拉取数据。
 */
withDefaults(
  defineProps<{
    modelValue?: string
    options?: Array<{ value: string; label: string }>
    placeholder?: string
    disabled?: boolean
    loading?: boolean
    ariaLabel?: string
  }>(),
  {
    modelValue: '',
    options: () => [],
    placeholder: '请选择',
    disabled: false,
    loading: false,
    ariaLabel: '',
  },
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

function onChange(event: Event): void {
  emit('update:modelValue', (event.target as HTMLSelectElement).value)
}
</script>

<template>
  <span
    class="base-select"
    :class="{ 'is-disabled': disabled || loading, 'is-loading': loading }"
  >
    <select
      class="base-select__control"
      :value="modelValue"
      :disabled="disabled || loading"
      :aria-label="ariaLabel || undefined"
      :aria-busy="loading || undefined"
      @change="onChange"
    >
      <option value="" disabled>{{ placeholder }}</option>
      <option v-for="option in options" :key="option.value" :value="option.value">
        {{ option.label }}
      </option>
    </select>
    <span v-if="loading" class="base-select__spinner" aria-hidden="true" />
  </span>
</template>

<style scoped>
.base-select {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 100%;
}

.base-select__control {
  width: 100%;
  height: var(--control-height-md);
  padding: 0 var(--space-7) 0 var(--space-3);
  border: var(--border-width) solid var(--color-border-strong);
  border-radius: var(--radius-overlay);
  background: var(--color-surface-panel);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  outline: none;
  cursor: pointer;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast),
    background var(--transition-fast);
}

/* hover 态 */
.base-select:not(.is-disabled):hover .base-select__control {
  border-color: var(--color-primary);
}

/* active 态：展开聚焦 */
.base-select:not(.is-disabled):focus-within .base-select__control {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-focus-ring);
}

/* active 态：按下 */
.base-select:not(.is-disabled):active .base-select__control {
  border-color: var(--color-primary-active);
}

/* disabled / loading 态 */
.base-select.is-disabled .base-select__control {
  background: var(--color-disabled-bg);
  border-color: var(--color-disabled-border);
  color: var(--color-disabled-text);
  cursor: not-allowed;
}

.base-select.is-loading .base-select__control {
  cursor: progress;
}

.base-select__spinner {
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
