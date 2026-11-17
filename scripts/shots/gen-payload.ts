/**
 * Node 侧截图数据生成器（Task 14）。
 *
 * 在 Node 环境跑「真实基准语料 → 真实内存检索 → 真实归并引擎」，把结构化结果
 * 序列化为 scripts/shots/payload.json，供浏览器 harness 以纯数据方式导入。
 * 这样做的关键目的：把 node:fs / node:path / node:crypto 等 Node builtins 全部
 * 挡在浏览器 bundle 之外——浏览器侧只 import 真实 App.vue 与这个 JSON。
 *
 * 离线环境无真实模型端点，引擎对「唯一命中」类候选会走确定性降级。为了让
 * 截图覆盖三态，harness-data.ts 在保留真实检索快照、证据链、字段对照的前提
 * 下，把模型结论位置替换为规则层确定性结论，并如实标注 source。README 的
 * 实测证据小节会明确说明这一点，不把演示数据冒称为真实模型输出。
 *
 * 用法：pnpm tsx scripts/shots/gen-payload.ts
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { buildPayload } from './harness-data'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, 'payload.json')

async function main(): Promise<void> {
  const payload = await buildPayload()
  writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8')
  const actions = Object.values(payload.conclusions).map((c) => c.action).join(',')
  process.stdout.write(
    `payload 已生成：${OUT}\n` +
    `  候选 ${payload.candidates.length} 条 / 结论 ${Object.keys(payload.conclusions).length} 条 / ` +
    `追问会话 ${Object.keys(payload.sessions).length} / 回执 ${payload.receipts.length} 条\n` +
    `  三态动作序列：${actions}\n`,
  )
}

main().catch((err) => {
  process.stderr.write(`gen-payload 失败：${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exit(1)
})
