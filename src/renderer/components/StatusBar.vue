<script setup lang="ts">
/**
 * 顶栏：批次信息 + 三态计数（待评 / 已建议 / 存疑）。
 * 计数弱化呈现，不抢中间候选主区。
 */
withDefaults(
  defineProps<{
    pending?: number
    suggested?: number
    uncertain?: number
    batchLabel?: string
  }>(),
  { pending: 0, suggested: 0, uncertain: 0, batchLabel: '' },
)
</script>

<template>
  <header class="status-bar">
    <div class="status-bar__brand">
      <h1 class="status-bar__title">主数据归并检索系统</h1>
      <span class="status-bar__subtitle">评审台</span>
    </div>
    <span v-if="batchLabel" class="status-bar__batch mono">{{ batchLabel }}</span>
    <div class="status-bar__counts" aria-label="三态计数">
      <span class="status-bar__count is-pending">
        <i class="status-bar__dot" aria-hidden="true" />待评 <strong class="mono">{{ pending }}</strong>
      </span>
      <span class="status-bar__count is-suggested">
        <i class="status-bar__dot" aria-hidden="true" />已建议 <strong class="mono">{{ suggested }}</strong>
      </span>
      <span class="status-bar__count is-uncertain">
        <i class="status-bar__dot" aria-hidden="true" />存疑 <strong class="mono">{{ uncertain }}</strong>
      </span>
    </div>
  </header>
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3) var(--space-5);
  padding: var(--space-3) var(--space-5);
  background: var(--color-surface-panel);
  border-bottom: var(--border-width) solid var(--color-border);
}

.status-bar__brand {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.status-bar__title {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
}

.status-bar__subtitle {
  padding: 0 var(--space-2);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-pill);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.status-bar__batch {
  margin-right: auto;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.status-bar__counts {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-left: auto;
}

.status-bar__count {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.status-bar__count strong {
  color: var(--color-text-primary);
  font-size: var(--font-size-md);
}

.status-bar__dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-pill);
  flex: none;
}

.is-pending .status-bar__dot { background: var(--color-text-placeholder); }
.is-suggested .status-bar__dot { background: var(--color-action-merge); }
.is-uncertain .status-bar__dot { background: var(--color-action-uncertain); }
</style>
