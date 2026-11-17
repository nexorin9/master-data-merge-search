<script setup lang="ts">
/**
 * 右侧追问栏：追问历史 + 输入框；回答带证据时挂同一份 EvidenceTable。
 * 禁用规则：降级模式 / 存疑未复核 / 无结论，输入框禁用并显示原因；
 * 发送中进入 loading 且不可重复发送，空问题不发送。
 */
import { computed, ref } from 'vue'
import type { FollowupTurn } from '../../core/types'
import BaseButton from './base/BaseButton.vue'
import BaseInput from './base/BaseInput.vue'
import EvidenceTable from './EvidenceTable.vue'

const props = withDefaults(
  defineProps<{
    turns?: FollowupTurn[]
    disabled?: boolean
    disabledReason?: string
    loading?: boolean
    hasConclusion?: boolean
    degraded?: boolean
    uncertainUnreviewed?: boolean
    candidateId?: string
  }>(),
  {
    turns: () => [],
    disabled: false,
    disabledReason: '',
    loading: false,
    hasConclusion: false,
    degraded: false,
    uncertainUnreviewed: false,
    candidateId: '',
  },
)

const emit = defineEmits<{ ask: [question: string] }>()

const question = ref('')

/** 三种禁用情形给出不同原因，专员能分清「为何不能问」。 */
const blockedReason = computed(() => {
  if (props.degraded) return '降级模式下不可追问：模型不可用，全部结论待人工'
  if (props.uncertainUnreviewed) return '存疑项尚未人工复核，暂不可追问；请先复核结论'
  if (!props.hasConclusion) return '当前候选尚无结论，暂不可追问'
  if (props.disabled) return props.disabledReason || '追问暂不可用'
  return ''
})

const inputsDisabled = computed(() => Boolean(blockedReason.value) || props.loading)
const submitDisabled = computed(() => inputsDisabled.value || !question.value.trim())

function submit(): void {
  const text = question.value.trim()
  // 空问题不发送；发送中不可重复发送；禁用态不发送
  if (!text || props.loading || blockedReason.value) return
  emit('ask', text)
  question.value = ''
}
</script>

<template>
  <aside class="session-pane" aria-label="追问会话">
    <header class="session-pane__header">
      <h3 class="session-pane__title">追问会话</h3>
      <code v-if="candidateId" class="session-pane__candidate-id mono">{{ candidateId }}</code>
    </header>

    <p v-if="blockedReason" class="session-pane__blocked" role="status">{{ blockedReason }}</p>

    <div class="session-pane__history">
      <p v-if="!turns.length" class="session-pane__empty">
        尚无追问记录。可就本条候选的归并理由、命中出处或取舍提问，回答会附上证据。
      </p>
      <article v-for="(turn, index) in turns" :key="index" class="session-pane__turn">
        <p class="session-pane__question"><strong>问</strong>{{ turn.question }}</p>
        <p class="session-pane__answer"><strong>答</strong>{{ turn.answer }}</p>
        <div v-if="turn.referenced_record_ids.length" class="session-pane__refs">
          <span>出处</span>
          <code v-for="id in turn.referenced_record_ids" :key="id" class="mono">{{ id }}</code>
        </div>
        <EvidenceTable
          v-if="turn.evidence.length"
          :evidence="turn.evidence"
          caption="本轮回答引用的证据"
          compact
        />
      </article>
    </div>

    <form class="session-pane__composer" @submit.prevent="submit">
      <BaseInput
        v-model="question"
        :disabled="Boolean(blockedReason)"
        :loading="loading"
        placeholder="输入追问，回车发送"
        aria-label="追问输入框"
        @enter="submit"
      />
      <BaseButton
        type="submit"
        size="sm"
        variant="primary"
        :disabled="submitDisabled"
        :loading="loading"
      >
        发送
      </BaseButton>
    </form>
  </aside>
</template>

<style scoped>
.session-pane {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-height: 0;
  padding: var(--space-4);
  background: var(--color-surface-panel);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
}

.session-pane__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.session-pane__title {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
}

.session-pane__candidate-id {
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.session-pane__blocked {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  background: var(--color-action-uncertain-soft);
  border: var(--border-width) solid var(--color-action-uncertain);
  border-radius: var(--radius-overlay);
  color: var(--color-action-uncertain);
  font-size: var(--font-size-sm);
}

.session-pane__history {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  overflow-y: auto;
}

.session-pane__empty {
  margin: 0;
  padding: var(--space-4);
  background: var(--color-surface-base);
  border-radius: var(--radius-overlay);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.session-pane__turn {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-overlay);
}

.session-pane__question,
.session-pane__answer {
  margin: 0;
  font-size: var(--font-size-sm);
  overflow-wrap: anywhere;
}

.session-pane__question strong,
.session-pane__answer strong {
  display: inline-block;
  margin-right: var(--space-2);
  color: var(--color-text-secondary);
  font-weight: var(--font-weight-semibold);
}

.session-pane__answer {
  color: var(--color-text-primary);
}

.session-pane__refs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.session-pane__refs .mono {
  padding: 0 var(--space-1);
  border-bottom: 2px solid var(--color-primary);
  color: var(--color-primary);
}

.session-pane__composer {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: var(--border-width) solid var(--color-border);
}

.session-pane__composer > :first-child {
  flex: 1;
  min-width: 0;
}
</style>
