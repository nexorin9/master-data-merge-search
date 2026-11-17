/**
 * 规则层常量。阈值与枚举集中定义，禁止在多个模块里硬编码同一数字。
 * 与 spec.md / plan.md 的默认值一致。
 */

/** 置信度阈值：低于此值转 uncertain。 */
export const CONFIG_CONFIDENCE_THRESHOLD = 0.75

/** 关键字段缺失时的置信度封顶值。 */
export const CONFIG_MISSING_FIELD_CAP = 0.5

/** 上下文每桶历史上限。 */
export const CONFIG_HISTORY_LIMIT = 400

/** 是否把上一批命中注入本批做跨批对照。 */
export const CONFIG_CROSS_BATCH_COMPARE = true

/** 理由文本最大长度（中文字符计）。 */
export const CONFIG_RATIONALE_MAX_LENGTH = 120

/** 模型网络错误 / 5xx 的默认重试上限。 */
export const CONFIG_LLM_MAX_RETRIES = 1

/** 单批候选默认并发上限。 */
export const CONFIG_LLM_CONCURRENCY = 4

/** MDM 默认超时（毫秒）。 */
export const CONFIG_MDM_TIMEOUT_MS = 15000

/** 模型默认超时（毫秒）。 */
export const CONFIG_LLM_TIMEOUT_MS = 30000

/** 写回退避：起始间隔 / 退避系数 / 最大次数。 */
export const CONFIG_WRITEBACK_BACKOFF_INITIAL_MS = 500
export const CONFIG_WRITEBACK_BACKOFF_FACTOR = 2
export const CONFIG_WRITEBACK_BACKOFF_MAX_ATTEMPTS = 3

/** 追问会话压缩阈值（轮次）。 */
export const CONFIG_FOLLOWUP_COMPACTION_TURNS = 8

/** 参与复合键的关键字段（顺序稳定）。 */
export const COMPOSITE_KEY_FIELDS = ['insurance_code', 'spec', 'dosage_form', 'unit'] as const

/** 缺任一即复合键不成立、强制存疑的字段。 */
export const REQUIRED_KEY_FIELDS = ['spec', 'unit'] as const

/** 字段级对照固定顺序（insurance_code → name → spec → dosage_form → unit，其余排后）。 */
export const FIELD_DIFF_ORDER = [
  'insurance_code',
  'name',
  'spec',
  'dosage_form',
  'unit',
] as const

/** uncertain_reason 合法枚举（用于 reason 兜底补齐）。 */
export const UNCERTAIN_REASON_PRIORITY = [
  '检索失败',
  '多义命中',
  '命中记录均已停用',
  '版本冲突',
  '关键字段缺失',
  '模型不可用',
  '模型输出不合法',
  '无近似项',
] as const

/** 三态动作集合。 */
export const ACTIONS = ['create', 'merge', 'uncertain'] as const

/** 上下文桶名。 */
export const CONTEXT_BUCKETS = {
  drug: 'masterdata:drug',
  fee_item: 'masterdata:fee_item',
  department: 'masterdata:department',
  exam: 'masterdata:exam',
  candidate: 'masterdata:candidate',
} as const

/** 标记协议分段名（源产品标记协议改写为本产品三段）。 */
export const MARKER_SEGMENTS = ['证据', '结论', '存疑理由'] as const

/** 项目子目录内相对路径。 */
export const PATHS = {
  fieldMap: 'config/mdm-field-map.json',
  unitAlias: 'config/unit-alias.json',
  corpus: 'tests/fixtures/corpus',
  gateCases: 'tests/fixtures/gate-cases.json',
  benchmark: 'tests/fixtures/benchmark',
  reports: 'reports/benchmark',
  outputs: 'outputs',
} as const
