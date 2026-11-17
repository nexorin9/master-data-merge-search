import { describe, expect, it } from 'vitest'
import { createContextRegistry, contextBucketName } from '@core/retrieval/context-registry'
import type { ContextEntry } from '@core/types'

const entry = (key: string, text: string, at = 1): ContextEntry => ({ key, text, ingested_at: at })

describe('上下文分桶 registry（Task 7）', () => {
  it('两桶 ingest 后改 snapshot 返回值不影响内部', () => {
    const r = createContextRegistry()
    r.ingest('masterdata:drug', [entry('drug', '阿莫西林')])
    r.ingest('masterdata:exam', [entry('exam', '血常规')])
    const snap = r.snapshot()
    expect(snap).toHaveLength(2)
    snap[0].text = '被篡改'
    const again = r.snapshot()
    expect(again.some((e) => e.text === '被篡改')).toBe(false)
  })

  it('replace 覆盖、append 追加各自生效', () => {
    const r = createContextRegistry()
    r.ingest('b', [entry('b', 'A')], 'replace-self')
    r.ingest('b', [entry('b', 'B')], 'replace-self')
    expect(r.snapshot('b').map((e) => e.text)).toEqual(['B'])
    r.ingest('b', [entry('b', 'C')], 'append-self')
    expect(r.snapshot('b').map((e) => e.text)).toEqual(['B', 'C'])
  })

  it('历史上限：超过 400 条淘汰最旧', () => {
    const r = createContextRegistry({ historyLimit: 5 })
    r.ingest('b', [1, 2, 3, 4, 5, 6, 7].map((i) => entry('b', `${i}`, i)))
    const texts = r.snapshot('b').map((e) => e.text)
    expect(texts).toHaveLength(5)
    expect(texts).toEqual(['3', '4', '5', '6', '7'])
  })

  it('snapshot 带版本 id，桶名按 domain 生成', () => {
    const r = createContextRegistry()
    r.ingest('b', [entry('b', 'x')])
    const s = r.snapshot('b')
    expect(s[0].snapshot_version).toMatch(/^snap-\d+$/)
    expect(contextBucketName('drug')).toBe('masterdata:drug')
    expect(contextBucketName('candidate')).toBe('masterdata:candidate')
  })

  it('桶键可枚举', () => {
    const r = createContextRegistry()
    r.ingest('b1', [entry('b1', 'a')])
    r.ingest('b2', [entry('b2', 'b')])
    expect(r.bucketKeys().sort()).toEqual(['b1', 'b2'])
  })
})
