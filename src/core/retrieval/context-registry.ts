/**
 * 上下文入册与分桶（Task 7）。
 *
 * 复用源产品 createContextRegistry 语义：按 sourceKey 分桶、replace-self /
 * append-self 两种策略、snapshot() 深克隆（structuredClone 语义）、历史上限
 * 400 条。桶改为 masterdata:drug / :fee_item / :department / :exam + 候选桶。
 * 上下文平铺渲染（不用 XML 包裹，避免弱模型照抄包裹符）。
 */
import { CONFIG_HISTORY_LIMIT } from '../constants'
import type { ContextEntry, ContextSnapshotEntry, Domain, IngestStrategy } from '../types'

export interface ContextRegistry {
  ingest(sourceKey: string, entries: ContextEntry[], strategy?: IngestStrategy): void
  snapshot(sourceKey?: string): ContextSnapshotEntry[]
  bucketKeys(): string[]
  historyLimit: number
}

/** 生成快照版本 id（递增计数 + 桶名，便于追问会话引用版本）。 */
function createVersionCounter(): () => string {
  let n = 0
  return () => `snap-${++n}`
}

export function createContextRegistry(options: { historyLimit?: number } = {}): ContextRegistry {
  const historyLimit = options.historyLimit ?? CONFIG_HISTORY_LIMIT
  const buckets = new Map<string, ContextEntry[]>()
  const nextVersion = createVersionCounter()

  function ingest(sourceKey: string, entries: ContextEntry[], strategy: IngestStrategy = 'append-self'): void {
    const existing = buckets.get(sourceKey) ?? []
    const incoming = entries.map((e) => ({ ...e, ingested_at: e.ingested_at || Date.now() }))
    let merged: ContextEntry[]
    if (strategy === 'replace-self') {
      merged = incoming
    } else {
      merged = [...existing, ...incoming]
    }
    // 超限按入桶时间淘汰最旧条目，保留最新 historyLimit 条。
    if (merged.length > historyLimit) {
      merged = merged
        .slice()
        .sort((a, b) => a.ingested_at - b.ingested_at)
        .slice(merged.length - historyLimit)
    }
    buckets.set(sourceKey, merged)
  }

  function snapshot(sourceKey?: string): ContextSnapshotEntry[] {
    const version = nextVersion()
    const keys = sourceKey ? [sourceKey] : [...buckets.keys()]
    const out: ContextSnapshotEntry[] = []
    for (const key of keys) {
      const entries = buckets.get(key) ?? []
      // 深克隆：改快照返回值不影响 registry 内部。
      for (const e of structuredClone(entries)) {
        out.push({ ...e, snapshot_version: version })
      }
    }
    return out
  }

  return {
    ingest,
    snapshot,
    bucketKeys: () => [...buckets.keys()],
    historyLimit,
  }
}

/** 桶名：按 domain 分桶，候选批次单独一桶。 */
export function contextBucketName(domain: Domain | 'candidate'): string {
  return `masterdata:${domain}`
}
