<script setup lang="ts">
/**
 * 逐条回执：成功=创建绿、跳过=主色、失败=失败红。
 * 失败行给出可读原因并支持单独重试；顶部批次摘要给三态计数。
 */
import type { BatchSummary, ReceiptStatus, WriteReceipt } from '../../core/types'
import BaseButton from './base/BaseButton.vue'
import BaseTag from './base/BaseTag.vue'

const props = withDefaults(
  defineProps<{
    receipts?: WriteReceipt[]
    summary?: BatchSummary | null
    retryingIds?: string[]
  }>(),
  { receipts: () => [], summary: null, retryingIds: () => [] },
)

const emit = defineEmits<{ retry: [candidateId: string] }>()

function labelOf(status: ReceiptStatus): string {
  return status === 'success' ? '成功' : status === 'skipped' ? '跳过' : '失败'
}

function toneOf(status: ReceiptStatus): 'create' | 'merge' | 'failed' {
  return status === 'success' ? 'create' : status === 'skipped' ? 'merge' : 'failed'
}

function reasonOf(receipt: WriteReceipt): string {
  return receipt.readable_reason ?? receipt.reason ?? '未知失败原因，请转人工处理'
}
</script>

<template>
  <section class="receipt-list" aria-label="逐条回执">
    <header class="receipt-list__head">
      <h3 class="receipt-list__title">逐条回执</h3>
      <code v-if="summary" class="receipt-list__batch mono">批次 {{ summary.batch_id }}</code>
    </header>

    <div v-if="summary" class="receipt-list__summary">
      <span>共 <strong class="mono">{{ summary.total }}</strong></span>
      <span class="receipt-list__stat is-success">成功 <strong class="mono">{{ summary.succeeded }}</strong></span>
      <span class="receipt-list__stat is-skipped">跳过 <strong class="mono">{{ summary.skipped }}</strong></span>
      <span class="receipt-list__stat is-failed">失败 <strong class="mono">{{ summary.failed }}</strong></span>
    </div>

    <ul v-if="receipts.length" class="receipt-list__items">
      <li
        v-for="receipt in receipts"
        :key="receipt.idempotency_key"
        class="receipt-list__item"
        :class="`is-${receipt.status}`"
        :data-status="receipt.status"
      >
        <BaseTag :tone="toneOf(receipt.status)" size="sm">{{ labelOf(receipt.status) }}</BaseTag>
        <code class="receipt-list__candidate mono">{{ receipt.candidate_id }}</code>
        <code class="receipt-list__key mono">{{ receipt.idempotency_key.slice(0, 8) }}</code>
        <span v-if="receipt.status === 'failed'" class="receipt-list__reason">
          {{ reasonOf(receipt) }}
        </span>
        <BaseButton
          v-if="receipt.status === 'failed'"
          size="sm"
          variant="danger"
          :loading="retryingIds.includes(receipt.candidate_id)"
          class="receipt-list__retry"
          @click="emit('retry', receipt.candidate_id)"
        >
          单独重试
        </BaseButton>
      </li>
    </ul>
    <p v-else class="receipt-list__empty">暂无回执。提交写回后会逐条显示成功 / 跳过 / 失败。</p>
  </section>
</template>

<style scoped>
.receipt-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.receipt-list__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
}

.receipt-list__title {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
}

.receipt-list__batch {
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.receipt-list__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-2) var(--space-3);
  background: var(--color-surface-muted);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-overlay);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.receipt-list__stat.is-success strong { color: var(--color-receipt-success); }
.receipt-list__stat.is-skipped strong { color: var(--color-receipt-skipped); }
.receipt-list__stat.is-failed strong { color: var(--color-receipt-failed); }

.receipt-list__items {
  margin: 0;
  padding: 0;
  list-style: none;
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-card);
  overflow: hidden;
}

.receipt-list__item {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: var(--border-width) solid var(--color-border);
  border-left: 3px solid var(--color-border-strong);
  font-size: var(--font-size-sm);
}

.receipt-list__item:last-child {
  border-bottom: none;
}

.receipt-list__item.is-success { border-left-color: var(--color-receipt-success); }
.receipt-list__item.is-skipped { border-left-color: var(--color-receipt-skipped); }
.receipt-list__item.is-failed {
  border-left-color: var(--color-receipt-failed);
  background: var(--color-danger-soft);
}

.receipt-list__candidate {
  font-size: var(--font-size-xs);
}

.receipt-list__key {
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.receipt-list__reason {
  flex: 1;
  min-width: 160px;
  color: var(--color-danger);
  font-size: var(--font-size-xs);
  overflow-wrap: anywhere;
}

.receipt-list__retry {
  margin-left: auto;
}

.receipt-list__empty {
  margin: 0;
  padding: var(--space-4);
  background: var(--color-surface-base);
  border-radius: var(--radius-overlay);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  text-align: center;
}
</style>
