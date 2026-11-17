/**
 * 归并请求协议（Task 19 / 21）。
 *
 * 把「分桶上下文段 + 本批归并请求 turn」注入到模型请求，并提供结构化输出的
 * JSON Schema（response_format=json_schema）。源产品主路径
 * github_ref/airi/.../chat-orchestrator-runtime.ts 的 runtime-context 注入与
 * 流式 provider 调用，在此改写为「本批归并请求 turn」注入点。
 *
 * 协议要点：
 *   - 系统提示要求只依据 [Context] 判定、输出归并建议 JSON、证据只引用快照内记录；
 *   - 用户消息 = formatContextPromptText(snapshot) 平铺段 + 本批归并请求 turn；
 *   - 默认 response_format=json_schema；端点不支持时由调用方降级为 json_object
 *     （见 merge-validator.needsSchemaDowngrade），并在调用留痕里记 degraded_reason。
 */
import type { CandidateRecord, ContextSnapshotEntry } from '../types'
import { buildMergeRequestTurn, formatContextPromptText, hasXmlWrapper } from '../retrieval/context-prompt'

/** 归并结论的 JSON Schema（OpenAI-compatible response_format.json_schema.schema）。 */
export const MERGE_RESULT_JSON_SCHEMA = {
  name: 'merge_conclusion',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['create', 'merge', 'uncertain'] },
      target_code: { type: ['string', 'null'], description: 'action=merge 时必填，取 [Context] 内记录的 code' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      rationale: { type: 'string', maxLength: 120, description: '中文理由，不超过 120 字' },
      uncertain_reason: {
        type: ['string', 'null'],
        enum: [
          '多义命中', '关键字段缺失', '无近似项', '版本冲突', '模型输出不合法',
          '检索失败', '模型不可用', '命中记录均已停用', null,
        ],
      },
      evidence: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            record_id: { type: 'string', description: '必须来自 [Context] 内的记录' },
            field: { type: 'string', enum: ['insurance_code', 'name', 'spec', 'dosage_form', 'unit', 'code', 'status', 'version'] },
            candidate_value: { type: 'string' },
            matched_value: { type: 'string' },
          },
          required: ['record_id', 'field', 'candidate_value', 'matched_value'],
        },
      },
    },
    required: ['action', 'target_code', 'confidence', 'rationale', 'uncertain_reason', 'evidence'],
  },
} as const

/** 系统提示：把判定约束写死，弱模型也不易跑偏。 */
export const MERGE_SYSTEM_PROMPT = [
  '你是院内主数据归并评审助手。',
  '只依据 [Context] 中列出的已有主数据记录判定，不得引用未出现的记录。',
  '输出归并建议 JSON：action 取 create / merge / uncertain；',
  'action=merge 时 target_code 必填且必须取自 [Context] 内某条记录的 code；',
  'action=create 时 target_code 必须为空；action=uncertain 时须给 uncertain_reason；',
  'evidence[] 至少 1 条，每条给 record_id / field / 候选值 / 命中值，record_id 只能引用 [Context] 内的记录。',
  'rationale 为中文且不超过 120 字。',
].join('')

export interface MergeProtocolView {
  system: string
  user: string
  contextBlock: string
  requestTurn: string
  candidate: CandidateRecord
}

/** 构造归并协议视图（上下文段 + 本批请求 turn），不含 response_format。 */
export function buildMergeProtocol(candidate: CandidateRecord, snapshot: ContextSnapshotEntry[]): MergeProtocolView {
  const contextBlock = formatContextPromptText(snapshot)
  const requestTurn = buildMergeRequestTurn(snapshot, candidate)
  // 上下文已随请求 turn 内联（buildMergeRequestTurn 内部已渲染 formatContextPromptText）。
  // 这里单独保留 contextBlock 供调用留痕与 prompt_hash 使用，不重复拼接进 user。
  return {
    system: MERGE_SYSTEM_PROMPT,
    user: requestTurn,
    contextBlock,
    requestTurn,
    candidate,
  }
}

/**
 * 规整模型输出：容忍 ```json 围栏与前后空白，返回可 JSON.parse 的正文。
 * 与 merge-validator.parseModelJson 保持同一口径，供协议层单独使用。
 */
export function unwrapModelContent(content: string): string {
  const text = content.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)
  return (fence ? fence[1] : text).trim()
}

/** 协议自检：送出的用户消息不得含 XML 包裹符（弱模型会照抄）。 */
export function assertProtocolNoXml(view: MergeProtocolView): boolean {
  return !hasXmlWrapper(view.user) && !hasXmlWrapper(view.system)
}

/** 从快照提取用于 prompt_hash 的稳定提示词文本（上下文段 + 请求段）。 */
export function protocolPromptText(view: MergeProtocolView): string {
  return `${view.contextBlock}\n${view.requestTurn}`
}
