<script setup lang="ts">
/**
 * 基础表格：四态（hover 行 / active 选中行 / disabled 行 / loading 骨架）。
 * 通过列定义 + 作用域插槽 cell-<key> 自定义单元格；不重算数据。
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    columns?: Array<{ key: string; label: string; mono?: boolean; width?: string }>
    rows?: Array<Record<string, unknown>>
    rowKey?: string
    selectedKey?: string | null
    loading?: boolean
    disabled?: boolean
    emptyText?: string
  }>(),
  {
    columns: () => [],
    rows: () => [],
    rowKey: '',
    selectedKey: null,
    loading: false,
    disabled: false,
    emptyText: '暂无数据',
  },
)

const emit = defineEmits<{ 'row-click': [row: Record<string, unknown>] }>()

/** 纯文本兜底：null / undefined 统一显示占位破折号。 */
function formatCell(value: unknown): string {
  return value === null || value === undefined || value === '' ? '—' : String(value)
}

function keyOf(row: Record<string, unknown>, index: number): string {
  return String(props.rowKey ? (row[props.rowKey] ?? index) : index)
}

function classOf(row: Record<string, unknown>, index: number): Array<string | Record<string, boolean>> {
  const key = keyOf(row, index)
  return [
    String(row.__rowClass ?? ''),
    {
      'is-active': props.selectedKey !== null && key === String(props.selectedKey),
      'is-disabled': props.disabled || Boolean(row.__disabled),
    },
  ]
}

const showBody = computed(() => !props.loading && props.rows.length > 0)

function onRowClick(row: Record<string, unknown>): void {
  if (props.disabled || props.loading || row.__disabled) return
  emit('row-click', row)
}
</script>

<template>
  <div
    class="base-table"
    :class="{ 'is-loading': loading, 'is-disabled': disabled }"
    :aria-busy="loading || undefined"
  >
    <table class="base-table__table">
      <thead class="base-table__head">
        <tr>
          <th
            v-for="column in columns"
            :key="column.key"
            class="base-table__th"
            :class="{ mono: column.mono }"
            :style="column.width ? { width: column.width } : undefined"
            scope="col"
          >
            {{ column.label }}
          </th>
        </tr>
      </thead>
      <tbody v-if="showBody" class="base-table__body">
        <tr
          v-for="(row, index) in rows"
          :key="keyOf(row, index)"
          class="base-table__row"
          :class="classOf(row, index)"
          @click="onRowClick(row)"
        >
          <td
            v-for="column in columns"
            :key="column.key"
            class="base-table__td"
            :class="{ mono: column.mono }"
          >
            <slot
              :name="`cell-${column.key}`"
              :row="row"
              :value="row[column.key]"
              :column="column"
            >{{ formatCell(row[column.key]) }}</slot>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="loading" class="base-table__loading" role="status">
      <span class="base-table__spinner" aria-hidden="true" />
      <span>正在加载数据…</span>
      <div class="base-table__skeleton" aria-hidden="true">
        <span v-for="n in 3" :key="n" class="base-table__skeleton-row" />
      </div>
    </div>
    <p v-else-if="!rows.length" class="base-table__empty">{{ emptyText }}</p>
  </div>
</template>

<style scoped>
.base-table {
  width: 100%;
  overflow: hidden;
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-card);
  background: var(--color-surface-panel);
  box-shadow: var(--shadow-card);
}

.base-table__table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.base-table__th {
  padding: var(--space-2) var(--space-3);
  background: var(--color-surface-muted);
  border-bottom: var(--border-width) solid var(--color-border);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  text-align: left;
  word-break: break-word;
}

.base-table__td {
  padding: var(--space-2) var(--space-3);
  border-bottom: var(--border-width) solid var(--color-border);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  overflow-wrap: anywhere;
  vertical-align: top;
}

.base-table__row:last-child .base-table__td {
  border-bottom: none;
}

/* 等宽列 */
.mono {
  font-family: var(--font-family-mono);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
  letter-spacing: var(--letter-spacing-mono);
}

/* hover 态 */
.base-table__row:hover:not(.is-disabled) {
  background: var(--color-hover-row);
}

/* active 态：按下 */
.base-table__row:active:not(.is-disabled) {
  background: var(--color-active-bg);
}

/* active 态：选中行 */
.base-table__row.is-active {
  background: var(--color-active-row);
  box-shadow: inset 3px 0 0 var(--color-primary);
}

/* disabled 态 */
.base-table__row.is-disabled {
  opacity: var(--opacity-disabled);
  cursor: not-allowed;
}

/* evidence_mismatch 失败行 */
.base-table__row.is-mismatch {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}
.base-table__row.is-mismatch .base-table__td {
  color: var(--color-danger);
}

.base-table__loading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.base-table__spinner {
  width: 13px;
  height: 13px;
  border: 2px solid var(--color-loading-track);
  border-top-color: var(--color-loading-indicator);
  border-radius: var(--radius-pill);
  animation: token-spin 700ms linear infinite;
}

.base-table__skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
}

.base-table__skeleton-row {
  height: 10px;
  border-radius: var(--radius-pill);
  background: var(--color-skeleton);
  animation: token-pulse 1200ms ease-in-out infinite;
}

.base-table__empty {
  margin: 0;
  padding: var(--space-5);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  text-align: center;
}
</style>
