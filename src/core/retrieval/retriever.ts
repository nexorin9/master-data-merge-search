/**
 * 分域检索与「检索失败」显式报错（Task 25）。
 *
 * 最危险的静默错误是 MDM 读失败被当成「没有近似项」，于是系统把一条已有
 * 编码判成「新建」。本模块让 retrieval_failed 与 retrieved_ok（0 条也算 ok）
 * 在数据结构上就是两件事：失败抛显式错误并带端点、状态码、重试次数，绝不
 * 返回空数组；只有检索成功且 0 条命中才允许进入 create 判定。
 * 域不匹配记录排除并计数，计数写入结论统计字段供 UI 显示。
 */
import { buildQueryTerms, queryTermList } from '../normalize/query-builder'
import type { CandidateRecord, MasterDataRecord, RetrievalOutcome } from '../types'
import type { MdmClient, MdmResult } from './mdm-client'

export interface RetrieverOptions {
  /** 每条检索词最多取回多少条，默认 50。 */
  limit?: number
  /** 端点标签（错误信息里展示）。 */
  endpoint?: string
}

/** 检索驱动：注入一个符合 getMasterData 形状的函数（真实客户端或测试替身）。 */
export interface RetrieverDeps {
  getMasterData: (domain: string, q: string) => Promise<MdmResult<MasterDataRecord[]>>
}

export function createRetriever(deps: RetrieverDeps, options: RetrieverOptions = {}) {
  const endpoint = options.endpoint ?? 'GET /api/v1/master-data'
  /** 最近一次端点返回的状态码，供批量检索的异常兜底 reporting 使用（工厂级共享）。 */
  let lastStatus: number | null = null

  /** 单条候选的分域检索。失败立即抛显式错误，绝不返回空数组冒充无近似项。 */
  async function retrieve(candidate: CandidateRecord): Promise<RetrievalOutcome> {
    const terms = queryTermList(buildQueryTerms(candidate))
    const byRecordId = new Map<string, MasterDataRecord>()
    // 域不匹配按 record_id 去重计数：同一条记录被多条检索词召回只算一次。
    const domainMismatchIds = new Set<string>()

    for (const q of terms) {
      if (!q) continue // 空检索词跳过（如缺医保码）
      let result: MdmResult<MasterDataRecord[]>
      try {
        result = await deps.getMasterData(candidate.domain, q)
      } catch (err) {
        // 网络类异常（fetch 抛错 / AbortSignal 超时）：显式检索失败。
        return {
          kind: 'retrieval_failed',
          endpoint,
          status: null,
          retries: 0,
          message: `检索失败：${err instanceof Error ? err.message : String(err)}`,
        }
      }
      lastStatus = result.status ?? null
      if (!result.ok) {
        // 端点报错 / 非 200 / 认证失败：显式报「检索失败」，阻断结论。
        return {
          kind: 'retrieval_failed',
          endpoint,
          status: result.status ?? null,
          retries: 0,
          message: `检索失败：${result.code ?? 'HTTP_ERROR'} ${result.error ?? '端点返回失败'}`,
        }
      }
      for (const record of result.data ?? []) {
        if (record.domain !== candidate.domain) {
          domainMismatchIds.add(record.record_id)
          continue
        }
        byRecordId.set(record.record_id, record)
      }
    }

    const records = [...byRecordId.values()]
    return {
      kind: 'retrieved_ok',
      records,
      hits: records.length,
      domain_mismatch_excluded: domainMismatchIds.size,
    }
  }

  /** 批量检索：逐条独立，单条失败不阻断其余；返回逐条 outcome。 */
  async function retrieveBatch(
    candidates: CandidateRecord[],
  ): Promise<Array<{ candidate_id: string; outcome: RetrievalOutcome }>> {
    const results: Array<{ candidate_id: string; outcome: RetrievalOutcome }> = []
    for (const c of candidates) {
      try {
        results.push({ candidate_id: c.candidate_id, outcome: await retrieve(c) })
      } catch (err) {
        results.push({
          candidate_id: c.candidate_id,
          outcome: {
            kind: 'retrieval_failed',
            endpoint,
            status: lastStatus,
            retries: 0,
            message: `检索失败：${err instanceof Error ? err.message : String(err)}`,
          },
        })
      }
    }
    return results
  }

  return { retrieve, retrieveBatch }
}

/** 便捷工厂：直接从 MdmClient 适配。 */
export function retrieverFromMdmClient(client: MdmClient, options?: RetrieverOptions) {
  return createRetriever(
    { getMasterData: (domain, q) => client.getMasterData(domain, q) },
    options,
  )
}

/** 判定 outcome 是否允许进入 create 判定（唯一安全情形：retrieved_ok 且 0 条）。 */
export function allowsCreate(outcome: RetrievalOutcome): boolean {
  return outcome.kind === 'retrieved_ok' && outcome.hits === 0
}
