<script setup lang="ts">
/**
 * 字段对照：按 FIELD_DIFF_ORDER 固定顺序并排渲染「候选值 vs 命中值」。
 * FIELD_DIFF_ORDER 源出 @core/constants；此处用等价相对路径导入，
 * 以兼容 renderer 构建未配置 @core 别名（vitest 侧别名已配、测试对拍同一常量）。
 */
import { computed } from 'vue'
import { FIELD_DIFF_ORDER } from '../../core/constants'
import type { DiffSummary, FieldDiff } from '../../core/types'

const props = withDefaults(
  defineProps<{
    diffs?: FieldDiff[]
    summary?: DiffSummary | null
    title?: string
  }>(),
  { diffs: () => [], summary: null, title: '字段对照' },
)

const FIELD_LABEL: Record<string, string> = {
  insurance_code: '医保码',
  name: '名称',
  spec: '规格',
  dosage_form: '剂型',
  unit: '单位',
}

const ORDER = FIELD_DIFF_ORDER as readonly string[]

/** diffs 显式非空优先，否则回落到 summary（props 默认空数组不能被 ?? 误判为已提供）。 */
const source = computed<FieldDiff[]>(() =>
  props.diffs.length > 0 ? props.diffs : (props.summary?.diffs ?? []),
)

/** 固定字段顺序，order 内按定义排，其余排后；同序保持原相对顺序。 */
const ordered = computed(() =>
  [...source.value].sort((a, b) => {
    const ai = ORDER.indexOf(a.field)
    const bi = ORDER.indexOf(b.field)
    return (ai < 0 ? ORDER.length : ai) - (bi < 0 ? ORDER.length : bi)
  }),
)

function label(field: string): string {
  return FIELD_LABEL[field] ?? field
}

/** exact / normalized 不高亮；missing / absent 显式标注；conflict 由 class 高亮。 */
function valueText(diff: FieldDiff, side: 'candidate' | 'matched'): string {
  const value = side === 'candidate' ? diff.candidate_value : diff.matched_value
  if (value !== null) return value
  if (diff.kind === 'missing' && side === 'candidate') return '候选缺该字段'
  if (diff.kind === 'absent' && side === 'matched') return '主数据无该字段'
  return '—'
}
</script>

<template>
  <section class="field-compare" aria-label="字段对照">
    <div class="field-compare__head">
      <h3 class="field-compare__title">{{ title }}</h3>
      <span v-if="summary" class="field-compare__counts">
        命中 {{ summary.counts.exact + summary.counts.normalized }} ·
        冲突 <strong class="is-danger">{{ summary.counts.conflict }}</strong> ·
        缺失 {{ summary.counts.missing + summary.counts.absent }}
      </span>
    </div>

    <div v-if="ordered.length" class="field-compare__grid">
      <div class="field-compare__row field-compare__row--head">
        <span>字段</span><span>候选值</span><span>命中值（主数据）</span>
      </div>
      <div
        v-for="diff in ordered"
        :key="diff.field"
        class="field-compare__row"
        :class="`is-${diff.kind}`"
        :data-field="diff.field"
        :data-kind="diff.kind"
      >
        <span class="field-compare__field">
          {{ label(diff.field) }}
          <code class="field-compare__field-code">{{ diff.field }}</code>
        </span>
        <span class="field-compare__value mono" :class="{ 'is-marker': diff.candidate_value === null }">
          {{ valueText(diff, 'candidate') }}
          <small v-if="diff.kind === 'normalized'" class="field-compare__note">（归一后相同）</small>
        </span>
        <span class="field-compare__value mono" :class="{ 'is-marker': diff.matched_value === null }">
          {{ valueText(diff, 'matched') }}
        </span>
      </div>
    </div>

    <p v-else class="field-compare__empty">暂无字段对照，候选尚无结论或未产生比对结果。</p>
  </section>
</template>

<style scoped>
.field-compare {
  background: var(--color-surface-panel);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.field-compare__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: var(--border-width) solid var(--color-border);
}

.field-compare__title {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
}

.field-compare__counts {
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.is-danger {
  color: var(--color-danger);
}

.field-compare__grid {
  display: flex;
  flex-direction: column;
}

.field-compare__row {
  display: grid;
  grid-template-columns: 128px 1fr 1fr;
  gap: var(--space-3);
  align-items: start;
  padding: var(--space-2) var(--space-4);
  border-bottom: var(--border-width) solid var(--color-border);
  font-size: var(--font-size-sm);
  min-height: 24px;
}

.field-compare__row:last-child {
  border-bottom: none;
}

.field-compare__row--head {
  background: var(--color-surface-muted);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
}

.field-compare__row:hover:not(.field-compare__row--head) {
  background: var(--color-hover-row);
}

/* conflict 高亮为失败色 */
.field-compare__row.is-conflict {
  background: var(--color-danger-soft);
  box-shadow: inset 3px 0 0 var(--color-danger);
}
.field-compare__row.is-conflict .field-compare__value {
  color: var(--color-danger);
  font-weight: var(--font-weight-medium);
}

/* missing / absent 显式标注 */
.field-compare__row.is-missing .field-compare__value:first-of-type,
.field-compare__row.is-absent .field-compare__value:last-of-type {
  color: var(--color-action-uncertain);
}

.field-compare__field {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  color: var(--color-text-secondary);
}

.field-compare__field-code {
  color: var(--color-text-placeholder);
  font-size: var(--font-size-xs);
}

.field-compare__value {
  color: var(--color-text-primary);
  overflow-wrap: anywhere;
}

.field-compare__value.is-marker {
  color: var(--color-action-uncertain);
  font-style: normal;
}

.field-compare__note {
  display: block;
  color: var(--color-text-secondary);
  font-family: var(--font-family-ui);
  font-size: var(--font-size-xs);
}

.field-compare__empty {
  margin: 0;
  padding: var(--space-5);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  text-align: center;
}
</style>
