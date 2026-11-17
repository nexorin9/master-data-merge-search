/**
 * MDM 正式对接层 · 三端点客户端（spec.md §5）。
 *
 * 三个端点：
 *   - GET  {MDM_BASE_URL}/api/v1/master-data-candidates?status=pending&cursor=
 *   - GET  {MDM_BASE_URL}/api/v1/master-data?domain={domain}&q={q}
 *   - POST {MDM_BASE_URL}/api/v1/master-data-candidates/{candidateId}/merge-suggestions
 *
 * 约束（硬）：
 *   1. 所有请求带 Authorization: Bearer $MDM_API_TOKEN（取自 AppConfig，绝不硬编码）；
 *   2. 写建议带 Idempotency-Key: sha256(candidate_id｜actionHash)；
 *   3. 超时取 config.mdm.timeoutMs，用 AbortSignal.timeout；
 *   4. 出站用 Node 全局 fetch，不引第三方 HTTP 库；
 *   5. 凭据缺失时工厂启动即抛 ConfigError；
 *   6. 方法永不抛裸字符串，一律返回结构化结果 {ok, data?, status?, error?, code?}；
 *   7. 写回回执三态：success / skipped（409 或 200+existing）/ failed（4xx 不重试）。
 */
import { createHash } from 'node:crypto'
import { ConfigError, type AppConfig } from '../../shared/config'
import type {
  Action,
  CandidateRecord,
  EvidenceItem,
  MasterDataRecord,
  ReceiptStatus,
  WriteReceipt,
} from '../types'

/** 内部规范字段：写建议 body 的证据项（逐字段对齐 spec.md §5，剔除规则层附加位）。 */
export interface SuggestionEvidenceWire {
  record_id: string
  field: string
  candidate_value: string
  matched_value: string
}

/** 写建议 body 的内部规范形状（领域字段直接复用 types.ts）。 */
export interface MergeSuggestionBody {
  action: Action
  target_code: string | null
  rationale: string
  evidence: EvidenceItem[]
  confidence: number
}

/** 所有端点共用的结构化结果：成功带 data，失败带 status/error/code，绝不抛裸串。 */
export interface MdmResult<T = unknown> {
  ok: boolean
  data?: T
  status?: number
  error?: string
  code?: string
  /** 写建议专用回执；读端点不携带。 */
  receipt?: WriteReceipt
}

/** 读候选分页结果。 */
export interface CandidatePage {
  candidates: CandidateRecord[]
  next_cursor: string | null
}

/** MDM 客户端工厂返回值。 */
export interface MdmClient {
  getCandidates(status?: string, cursor?: string): Promise<MdmResult<CandidatePage>>
  getMasterData(domain: string, q: string): Promise<MdmResult<MasterDataRecord[]>>
  postMergeSuggestion(
    candidateId: string,
    body: MergeSuggestionBody,
    idempotencyKey?: string,
  ): Promise<MdmResult<Record<string, unknown>>>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把证据项收敛为 spec.md §5 的四字段线格式（顺序固定，供哈希与 body 共用）。 */
function toWireEvidence(evidence: EvidenceItem[]): SuggestionEvidenceWire[] {
  return evidence.map((item) => ({
    record_id: item.record_id,
    field: item.field,
    candidate_value: item.candidate_value,
    matched_value: item.matched_value,
  }))
}

/** 规范化 body：字段顺序固定，保证 actionHash 与线上 body 逐字段一致。 */
function toWireBody(body: MergeSuggestionBody): Record<string, unknown> {
  return {
    action: body.action,
    target_code: body.target_code,
    rationale: body.rationale,
    evidence: toWireEvidence(body.evidence),
    confidence: body.confidence,
  }
}

/** actionHash = sha256(规范化 body)；Idempotency-Key = sha256(candidate_id｜actionHash)。 */
export function computeIdempotencyKey(candidateId: string, body: MergeSuggestionBody): string {
  const actionHash = createHash('sha256').update(JSON.stringify(toWireBody(body))).digest('hex')
  return createHash('sha256').update(`${candidateId}｜${actionHash}`).digest('hex')
}

/** 从 MDM 响应里提取一条可读错误，绝不回显请求头 / 凭据。 */
function extractError(raw: unknown, fallback: string): string {
  if (isPlainObject(raw)) {
    const candidate = raw.message ?? raw.error ?? raw.detail
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.slice(0, 500)
  }
  return fallback
}

/** 传输层失败（网络 / 超时），结构可直接透传为任意 MdmResult<T>。 */
interface TransportError {
  ok: false
  code: string
  error: string
  status?: number
}

/** 一次 HTTP 往返的内部结果：成功拿回状态码与包体，或直接是传输层失败。 */
type RequestOutcome = { ok: true; status: number; raw: unknown } | TransportError

/** 网络类错误（含超时）结构化；不在此处重试，退避与重试矩阵交给上层写回簇。 */
function toNetworkResult(error: unknown, timeoutMs: number): TransportError {
  const name = (error as { name?: string } | null)?.name
  const message = error instanceof Error ? error.message : String(error)
  const isTimeout =
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    /timeout|aborted/i.test(message)
  return {
    ok: false,
    code: isTimeout ? 'MDM_TIMEOUT' : 'MDM_NETWORK',
    error: `${isTimeout ? `请求超时（${timeoutMs}ms）` : '网络错误'}：${message.slice(0, 300)}`,
  }
}

/** 写建议回执三态分类：409 或 200+existing 标记视为 skipped。 */
export function classifyWriteReceipt(status: number, raw: unknown): ReceiptStatus {
  if (status === 409) return 'skipped'
  if (status < 200 || status >= 300) return 'failed'
  if (isPlainObject(raw)) {
    const duplicate =
      raw.existing === true ||
      raw.duplicate === true ||
      raw.skipped === true ||
      raw.status === 'existing' ||
      raw.status === 'skipped'
    if (duplicate) return 'skipped'
  }
  return 'success'
}

/**
 * 创建 MDM 客户端。baseUrl / apiToken 缺失即抛 ConfigError（启动即失败，不静默兜底）。
 */
export function createMdmClient(config: AppConfig): MdmClient {
  const { baseUrl, apiToken, timeoutMs } = config.mdm
  const missing: string[] = []
  if (!baseUrl || baseUrl.trim() === '') missing.push('MDM_BASE_URL')
  if (!apiToken || apiToken.trim() === '') missing.push('MDM_API_TOKEN')
  if (missing.length > 0) {
    throw new ConfigError(`MDM 客户端缺少必填凭据位：${missing.join('、')}`, missing)
  }

  const authorization = `Bearer ${apiToken}`

  /** 统一发出请求，网络类异常转为结构化错误；HTTP 层交给各端点按语义分类。 */
  async function doRequest(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown; extraHeaders?: Record<string, string> },
  ): Promise<RequestOutcome> {
    const headers: Record<string, string> = {
      Authorization: authorization,
      ...(init.extraHeaders ?? {}),
    }
    let body: string | undefined
    if (init.method === 'POST') {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(init.body ?? {})
    }
    let response: Response
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: init.method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      return toNetworkResult(error, timeoutMs)
    }

    const status = response.status
    let raw: unknown
    try {
      raw = await response.json()
    } catch {
      raw = undefined
    }
    return { ok: true, status, raw }
  }

  async function getCandidates(
    status: string = 'pending',
    cursor: string = '',
  ): Promise<MdmResult<CandidatePage>> {
    const query = `?status=${encodeURIComponent(status)}&cursor=${encodeURIComponent(cursor)}`
    const res = await doRequest(`/api/v1/master-data-candidates${query}`, { method: 'GET' })
    if (!res.ok) return res
    const { status: httpStatus, raw } = res
    if (httpStatus < 200 || httpStatus >= 300) {
      return {
        ok: false,
        status: httpStatus,
        code: 'MDM_HTTP_ERROR',
        error: extractError(raw, `读取候选失败（HTTP ${httpStatus}）`),
      }
    }
    const obj = isPlainObject(raw) ? raw : {}
    const list = Array.isArray(obj.candidates)
      ? obj.candidates
      : Array.isArray(obj.items)
        ? obj.items
        : []
    const next = obj.next_cursor ?? obj.cursor
    return {
      ok: true,
      status: httpStatus,
      data: {
        candidates: list as CandidateRecord[],
        next_cursor: typeof next === 'string' ? next : null,
      },
    }
  }

  async function getMasterData(domain: string, q: string): Promise<MdmResult<MasterDataRecord[]>> {
    const query = `?domain=${encodeURIComponent(domain)}&q=${encodeURIComponent(q)}`
    const res = await doRequest(`/api/v1/master-data${query}`, { method: 'GET' })
    if (!res.ok) return res
    const { status: httpStatus, raw } = res
    if (httpStatus < 200 || httpStatus >= 300) {
      return {
        ok: false,
        status: httpStatus,
        code: 'MDM_HTTP_ERROR',
        error: extractError(raw, `读取主数据失败（HTTP ${httpStatus}）`),
      }
    }
    const list = Array.isArray(raw)
      ? raw
      : isPlainObject(raw) && Array.isArray(raw.records)
        ? raw.records
        : isPlainObject(raw) && Array.isArray(raw.items)
          ? raw.items
          : []
    return { ok: true, status: httpStatus, data: list as MasterDataRecord[] }
  }

  async function postMergeSuggestion(
    candidateId: string,
    body: MergeSuggestionBody,
    idempotencyKey?: string,
  ): Promise<MdmResult<Record<string, unknown>>> {
    const key = idempotencyKey ?? computeIdempotencyKey(candidateId, body)
    const wire = toWireBody(body)
    const res = await doRequest(
      `/api/v1/master-data-candidates/${encodeURIComponent(candidateId)}/merge-suggestions`,
      {
        method: 'POST',
        body: wire,
        extraHeaders: { 'Idempotency-Key': key },
      },
    )
    const now = new Date().toISOString()
    const receipt = (state: ReceiptStatus, reason?: string): WriteReceipt => ({
      candidate_id: candidateId,
      status: state,
      idempotency_key: key,
      reason,
      readable_reason: reason
        ? state === 'skipped'
          ? '该候选已存在同哈希归并建议，已跳过'
          : `写回失败：${reason}`
        : undefined,
      created_at: now,
    })

    if (!res.ok) {
      return {
        ok: false,
        code: res.code,
        error: res.error,
        receipt: receipt('failed', res.error),
      }
    }
    const { status: httpStatus, raw } = res
    const state = classifyWriteReceipt(httpStatus, raw)
    const data = isPlainObject(raw) ? raw : {}
    if (state === 'success') {
      return { ok: true, status: httpStatus, data, receipt: receipt('success') }
    }
    if (state === 'skipped') {
      const reason = isPlainObject(raw) && typeof raw.reason === 'string' ? raw.reason : 'duplicate'
      return { ok: true, status: httpStatus, data, receipt: receipt('skipped', reason) }
    }
    // 4xx 不重试；5xx 归为失败，重试策略由写回簇统一承接。
    const error = extractError(raw, `写回建议失败（HTTP ${httpStatus}）`)
    return {
      ok: false,
      status: httpStatus,
      code: httpStatus >= 400 && httpStatus < 500 ? 'MDM_CLIENT_ERROR' : 'MDM_SERVER_ERROR',
      error,
      receipt: receipt('failed', error),
    }
  }

  return { getCandidates, getMasterData, postMergeSuggestion }
}
