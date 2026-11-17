<script setup lang="ts">
/**
 * toast 反馈：成功 3 秒自动消失；失败需手动关闭。
 * 计时器只在挂载后、且存在 window 的浏览器/Electron 环境启用，node SSR 不注册。
 */
import { onMounted, onUnmounted, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    toasts?: Array<{ id: string; kind: 'success' | 'failed' | 'info'; message: string }>
  }>(),
  { toasts: () => [] },
)

const emit = defineEmits<{ dismiss: [id: string] }>()

const scheduled = new Set<string>()
const timers: Array<ReturnType<typeof setTimeout>> = []

function scheduleSuccessDismiss(): void {
  if (typeof window === 'undefined') return
  for (const toast of props.toasts) {
    // 只给成功 toast 排程自动消失；failed / info 需专员手动关闭
    if (toast.kind !== 'success' || scheduled.has(toast.id)) continue
    scheduled.add(toast.id)
    const timer = setTimeout(() => {
      emit('dismiss', toast.id)
      scheduled.delete(toast.id)
    }, 3000)
    timers.push(timer)
  }
}

onMounted(scheduleSuccessDismiss)
watch(() => props.toasts, scheduleSuccessDismiss, { deep: true })
onUnmounted(() => {
  for (const timer of timers) clearTimeout(timer)
  timers.length = 0
  scheduled.clear()
})
</script>

<template>
  <div class="toast-stack" role="status" aria-live="polite" aria-label="操作反馈">
    <div
      v-for="toast in toasts"
      :key="toast.id"
      class="toast"
      :class="`toast--${toast.kind}`"
      :data-kind="toast.kind"
    >
      <span class="toast__dot" aria-hidden="true" />
      <span class="toast__message">{{ toast.message }}</span>
      <button
        class="toast__close"
        type="button"
        :aria-label="toast.kind === 'failed' ? '手动关闭失败提示' : '关闭提示'"
        @click="emit('dismiss', toast.id)"
      >
        ×
      </button>
    </div>
  </div>
</template>

<style scoped>
.toast-stack {
  position: fixed;
  right: var(--space-5);
  bottom: var(--space-5);
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: min(360px, calc(100vw - var(--space-5) * 2));
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--color-surface-panel);
  border: var(--border-width) solid var(--color-border);
  border-left: 3px solid var(--color-border-strong);
  border-radius: var(--radius-overlay);
  box-shadow: var(--shadow-overlay);
  font-size: var(--font-size-sm);
  pointer-events: auto;
}

.toast--success {
  border-left-color: var(--color-receipt-success);
  background: var(--color-success-soft);
}

.toast--failed {
  border-left-color: var(--color-receipt-failed);
  background: var(--color-danger-soft);
}

.toast--info {
  border-left-color: var(--color-primary);
  background: var(--color-primary-soft);
}

.toast__dot {
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: var(--radius-pill);
  flex: none;
  background: currentcolor;
}

.toast--success .toast__dot { color: var(--color-receipt-success); }
.toast--failed .toast__dot { color: var(--color-receipt-failed); }
.toast--info .toast__dot { color: var(--color-primary); }

.toast__message {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.toast--failed .toast__message {
  color: var(--color-danger);
}

.toast__close {
  flex: none;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: var(--border-width) solid transparent;
  border-radius: var(--radius-card);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-lg);
  line-height: 1;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.toast__close:hover:not(:disabled) {
  background: var(--color-active-bg);
  color: var(--color-text-primary);
}

.toast__close:active:not(:disabled) {
  background: var(--color-hover-bg);
}
</style>
