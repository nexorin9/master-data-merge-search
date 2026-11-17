<script setup lang="ts">
/**
 * 降级模式提示条：命中降级结论时置顶显示，明确此时不可写回。
 */
withDefaults(
  defineProps<{
    degraded?: boolean
    reason?: string
  }>(),
  { degraded: false, reason: '' },
)
</script>

<template>
  <div v-if="degraded" class="degrade-banner" role="alert">
    <span class="degrade-banner__mark" aria-hidden="true">!</span>
    <div class="degrade-banner__text">
      <p class="degrade-banner__title">模型不可用，当前仅按规则排序，全部结论待人工</p>
      <p v-if="reason" class="degrade-banner__reason">降级原因：{{ reason }}</p>
      <p class="degrade-banner__hint">此时不可写回主数据平台；请等待模型恢复或转人工处理。</p>
    </div>
  </div>
</template>

<style scoped>
.degrade-banner {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--color-action-uncertain-soft);
  border: var(--border-width) solid var(--color-action-uncertain);
  border-left: 3px solid var(--color-action-uncertain);
  border-radius: var(--radius-overlay);
  color: var(--color-action-uncertain);
}

.degrade-banner__mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: none;
  border: var(--border-width) solid var(--color-action-uncertain);
  border-radius: var(--radius-pill);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-bold);
  line-height: 1;
}

.degrade-banner__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.degrade-banner__text p {
  margin: 0;
  font-size: var(--font-size-sm);
}

.degrade-banner__title {
  font-weight: var(--font-weight-semibold);
}

.degrade-banner__reason,
.degrade-banner__hint {
  overflow-wrap: anywhere;
}
</style>
