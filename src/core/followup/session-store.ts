/**
 * 追问会话仓库（Task 35）。
 *
 * 会话严格按 candidate_id 归属：一条候选一份会话，保存首轮评估的结论、该次
 * 检索的快照版本 id、快照记录集，以及逐轮追问。追问默认复用首轮快照；仅当
 * 注入的版本解析器报告该候选的主数据版本变化时，才允许「重新检索」——由注入的
 * retrieve 假件返回新快照，绝不在此处触网。快照记录集留在会话上，供投影与
 * 越界闸门核对 record_id 边界。
 */
import { snapshotRecordIds } from '../engine/evidence'
import type { FollowupTurn, MasterDataRecord, MergeConclusion } from '../types'
import type { FollowupSession } from '../types'

/** 每条追问额外记住本轮依据的快照版本（领域类型 FollowupTurn 不含该字段）。 */
export interface TrackedFollowupTurn extends FollowupTurn {
  /** 本轮回答所依据的快照版本 id。 */
  snapshot_version: string
}

/**
 * 仓库内会话：在领域类型之外附带快照记录集与「首轮观察到的主数据版本」水位。
 * snapshot_records 只属于本候选，投影 / 压缩 / 越界闸门一律以它为边界。
 */
export interface StoredFollowupSession extends Omit<FollowupSession, 'turns'> {
  turns: TrackedFollowupTurn[]
  snapshot_records: MasterDataRecord[]
  master_data_version: string
}

/** 打开会话入参：既有结论 + 首轮快照。 */
export interface OpenSessionInput {
  conclusion: MergeConclusion
  snapshot_version: string
  snapshot: MasterDataRecord[]
  /** 首轮观察到的主数据版本；缺省时按快照记录内容生成确定性指纹。 */
  master_data_version?: string
}

/** 新增追问入参：时间戳、asked_action、快照版本由仓库补齐。 */
export interface AddTurnInput {
  question: string
  answer: string
  referenced_record_ids?: string[]
  evidence?: FollowupTurn['evidence']
  model_call_id?: string | null
}

/** 可注入的版本解析与按需重检依赖，全部为本地假件，不触网。 */
export interface SnapshotDeps {
  /** 该候选当前主数据版本；缺省视为与首轮一致（不刷新）。 */
  masterDataVersionOf?: (candidate_id: string) => string
  /** 版本变化时重新检索返回的快照；缺省则保留旧快照但仍标 refreshed。 */
  retrieve?: (candidate_id: string, version: string) => { snapshot_version: string; records: MasterDataRecord[] }
}

export interface FollowupSessionStore {
  /** 打开 / 注册会话；同一 candidate_id 重复打开返回原会话，不覆盖轮次。 */
  open(input: OpenSessionInput): StoredFollowupSession
  /** 追加一轮追问，返回新会话快照。 */
  addTurn(candidate_id: string, input: AddTurnInput, deps?: SnapshotDeps): StoredFollowupSession
  /** 按 candidate_id 取会话快照（深克隆，外部改动不影响仓库）。 */
  get(candidate_id: string): StoredFollowupSession | undefined
  /** 全部会话快照，按注册顺序稳定返回。 */
  list(): StoredFollowupSession[]
  /** 用压缩后的会话整体替换（仍按 candidate_id 归位）。 */
  replace(session: StoredFollowupSession): StoredFollowupSession
  /** 该候选快照允许的 record_id 集合。 */
  allowedRecordIds(candidate_id: string): Set<string>
}

/** 快照记录集 → 确定性版本指纹（排序后拼接 record_id@version）。 */
function snapshotFingerprint(records: MasterDataRecord[]): string {
  return records.map((r) => `${r.record_id}@${r.version}`).sort().join('|')
}

export function createSessionStore(options: { now?: () => string } = {}): FollowupSessionStore {
  const now = options.now ?? (() => new Date().toISOString())
  const sessions = new Map<string, StoredFollowupSession>()

  function open(input: OpenSessionInput): StoredFollowupSession {
    const id = input.conclusion.candidate_id
    if (!id) throw new Error('打开追问会话失败：结论缺少 candidate_id')
    const existing = sessions.get(id)
    if (existing) return structuredClone(existing)
    const session: StoredFollowupSession = {
      candidate_id: id,
      snapshot_version: input.snapshot_version,
      conclusion: structuredClone(input.conclusion),
      turns: [],
      discarded_count: 0,
      updated_at: now(),
      snapshot_records: structuredClone(input.snapshot),
      master_data_version: input.master_data_version ?? snapshotFingerprint(input.snapshot),
    }
    sessions.set(id, session)
    return structuredClone(session)
  }

  function requireSession(candidateId: string): StoredFollowupSession {
    const session = sessions.get(candidateId)
    if (!session) throw new Error(`追问会话不存在：${candidateId}`)
    return session
  }

  function addTurn(
    candidateId: string,
    input: AddTurnInput,
    deps: SnapshotDeps = {},
  ): StoredFollowupSession {
    const session = requireSession(candidateId)
    const versionOf = deps.masterDataVersionOf ?? (() => session.master_data_version)
    const currentVersion = versionOf(candidateId)
    let refreshed = false
    // 版本未变：直接复用首轮快照；版本变化：才允许重新检索并更新版本 + 记录集。
    if (currentVersion !== session.master_data_version) {
      refreshed = true
      if (deps.retrieve) {
        const next = deps.retrieve(candidateId, currentVersion)
        session.snapshot_version = next.snapshot_version
        session.snapshot_records = structuredClone(next.records)
      }
      session.master_data_version = currentVersion
    }
    const at = now()
    const turn: TrackedFollowupTurn = {
      question: input.question,
      answer: input.answer,
      referenced_record_ids: [...(input.referenced_record_ids ?? [])],
      evidence: structuredClone(input.evidence ?? []),
      model_call_id: input.model_call_id ?? null,
      // 被追问的 action 取自会话自己保存的结论，保证追问可追溯到具体结论。
      asked_action: session.conclusion.action,
      refreshed,
      at,
      snapshot_version: session.snapshot_version,
    }
    session.turns.push(turn)
    session.updated_at = at
    return structuredClone(session)
  }

  function replace(next: StoredFollowupSession): StoredFollowupSession {
    if (!next.candidate_id) throw new Error('替换追问会话失败：缺少 candidate_id')
    sessions.set(next.candidate_id, structuredClone(next))
    return structuredClone(sessions.get(next.candidate_id)!)
  }

  return {
    open,
    addTurn,
    get: (candidateId) => {
      const session = sessions.get(candidateId)
      return session ? structuredClone(session) : undefined
    },
    list: () => [...sessions.values()].map((session) => structuredClone(session)),
    replace,
    allowedRecordIds: (candidateId) => snapshotRecordIds(requireSession(candidateId).snapshot_records),
  }
}
