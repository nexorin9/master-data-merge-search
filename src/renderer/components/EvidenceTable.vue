<script setup lang="ts">
/**
 * 证据表：逐条摊开 evidence 四要素，等宽字体呈现 record_id 与两侧取值。
 * evidence_mismatch 行以失败色标注，并同时给出模型原值与主数据实际值。
 */
import { computed } from 'vue'
import type { EvidenceItem } from '../../core/types'
import BaseTable from './base/BaseTable.vue'
import BaseTag from './base/BaseTag.vue'

const props = withDefaults(
  defineProps<{
    evidence?: EvidenceItem[]
    loading?: boolean
    emptyText?: string
    caption?: string
    /** 窄栏（追问栏）用堆叠卡片替代四列表格，避免定宽列把中文字挤成竖排。 */
    compact?: boolean
  }>(),
  {
    evidence: () => [],
    loading: false,
    emptyText: '本结论暂无逐条证据。',
    caption: '',
    compact: false,
  },
)

const columns: Array<{ key: string; label: string; mono?: boolean; width?: string }> = [
  { key: 'record_id', label: '记录 ID', mono: true, width: '150px' },
  { key: 'field', label: '字段', width: '120px' },
  { key: 'candidate_value', label: '候选值' },
  { key: 'matched_value', label: '命中值 / 主数据实际值' },
]

const rows = computed<Array<Record<string, unknown>>>(() =>
  props.evidence.map((item) => ({
    ...item,
    __rowClass: item.evidence_mismatch ? 'is-mismatch' : '',
  })),
)
</script>

<template>
  <section class="evidence-table" aria-label="证据表">
    <div class="evidence-table__head">
      <h3 class="evidence-table__title">{{ caption || '逐条证据' }}</h3>
      <span class="evidence-table__count mono">共 {{ evidence.length }} 条</span>
    </div>
    <!-- 宽区（详情对照）走定宽四列表格 -->
    <BaseTable
      v-if="!compact"
      :columns="columns"
      :rows="rows"
      :loading="loading"
      :empty-text="emptyText"
      row-key="record_id"
    >
      <template #cell-record_id="{ value }">
        <code class="evidence-table__record-id">{{ value ?? '—' }}</code>
      </template>
      <template #cell-field="{ row }">
        <span class="evidence-table__field mono">{{ row.field }}</span>
        <BaseTag v-if="row.conflict_hit" tone="failed" size="sm">冲突命中</BaseTag>
        <BaseTag v-if="row.excluded_hit" tone="neutral" size="sm">已排除</BaseTag>
      </template>
      <template #cell-candidate_value="{ value }">
        <code class="evidence-table__value mono">{{ value ?? '—' }}</code>
      </template>
      <template #cell-matched_value="{ row }">
        <div v-if="row.evidence_mismatch" class="evidence-table__mismatch">
          <BaseTag tone="failed" size="sm">证据不一致</BaseTag>
          <span>模型原值 <code class="mono">{{ row.model_matched_value ?? '—' }}</code></span>
          <span>主数据实际值 <code class="mono">{{ row.matched_value ?? '—' }}</code></span>
        </div>
        <code v-else class="evidence-table__value mono">{{ row.matched_value ?? '—' }}</code>
      </template>
    </BaseTable>

    <!-- 窄区（追问栏）走逐条堆叠卡片：四要素纵向排列，等宽值不挤成竖排 -->
    <div v-else-if="rows.length" class="evidence-table__cards">
      <article
        v-for="(row, index) in rows"
        :key="`${row.record_id}-${index}`"
        class="evidence-table__card"
        :class="{ 'is-mismatch': row.evidence_mismatch }"
      >
        <div class="evidence-table__card-head">
          <span class="evidence-table__card-key">记录 ID</span>
          <code class="evidence-table__record-id mono">{{ row.record_id ?? '—' }}</code>
          <span class="evidence-table__field mono">{{ row.field }}</span>
          <BaseTag v-if="row.conflict_hit" tone="failed" size="sm">冲突命中</BaseTag>
          <BaseTag v-if="row.excluded_hit" tone="neutral" size="sm">已排除</BaseTag>
        </div>
        <div class="evidence-table__card-pair">
          <span class="evidence-table__card-key">候选值</span>
          <code class="evidence-table__value mono">{{ row.candidate_value ?? '—' }}</code>
        </div>
        <div class="evidence-table__card-pair">
          <span class="evidence-table__card-key">命中值</span>
          <code class="evidence-table__value mono">{{ row.matched_value ?? '—' }}</code>
        </div>
        <div v-if="row.evidence_mismatch" class="evidence-table__mismatch">
          <BaseTag tone="failed" size="sm">证据不一致</BaseTag>
          <span>模型原值 <code class="mono">{{ row.model_matched_value ?? '—' }}</code></span>
        </div>
      </article>
    </div>
    <p v-else-if="!loading" class="evidence-table__cards-empty">{{ emptyText }}</p>
  </section>
</template>

<style scoped>
.evidence-table {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.evidence-table__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
}

.evidence-table__title {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
}

.evidence-table__count {
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.evidence-table__record-id,
.evidence-table__value,
.evidence-table__field {
  color: var(--color-text-primary);
  overflow-wrap: anywhere;
}

.evidence-table__field {
  display: inline-block;
  margin-right: var(--space-2);
  color: var(--color-text-secondary);
}

.evidence-table__mismatch {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-danger);
}

.evidence-table__mismatch .mono {
  color: var(--color-danger);
  font-weight: var(--font-weight-medium);
}

/* 窄栏堆叠卡片：每项一条，候选值 / 命中值纵向成对，杜绝定宽列挤压中文竖排 */
.evidence-table__cards {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.evidence-table__card {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-overlay);
  background: var(--color-surface-base);
}

.evidence-table__card.is-mismatch {
  border-color: var(--color-danger);
  background: var(--color-danger-soft);
}

.evidence-table__card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding-bottom: var(--space-1);
  border-bottom: var(--border-width) solid var(--color-border);
}

.evidence-table__card-pair {
  display: grid;
  grid-template-columns: 3.5em minmax(0, 1fr);
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}

.evidence-table__card-key {
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.evidence-table__card-pair .evidence-table__value {
  min-width: 0;
  overflow-wrap: anywhere;
}

.evidence-table__cards-empty {
  margin: 0;
  padding: var(--space-4);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  text-align: center;
}
</style>
