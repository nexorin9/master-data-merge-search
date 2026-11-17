# 运维 CLI 与可复现命令参考

本文是 README「命令 / API / 配置说明」的展开。桌面窗口是日常主入口；下列命令面向信息科运维排障、主管复核与交付自检。所有命令在 `master-data-merge-search/` 目录下执行。

## 三个运维子命令

### doctor · 凭据位与端点体检（只读）

```bash
pnpm doctor --json     # 机器可读结果，便于巡检脚本消费
pnpm doctor            # 人话结论：逐项列出凭据缺失 / 端点不可达 / 认证失败 / 模型不支持结构化输出
```

只读体检：不拉业务数据、不写任何数据、不发业务请求。只对每个端点做一次最小连通性探测并记录 HTTP 状态与耗时。退出码 0 表示体检通过，非 0 表示有必须处理的项。无凭据时逐条列出 `MDM_BASE_URL`、`MDM_API_TOKEN`、`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` 等缺失位。

### replay · 单条归并重放（默认不写回）

```bash
pnpm replay --candidate CAND-ALIAS-001                    # 只读重放：检索 → 闸门 → 归并 → 结论 + 证据 + 调用留痕
pnpm replay --candidate CAND-ALIAS-001 --write            # 显式落库，仍走确认门与幂等键（--candidate 为必填位）
```

replay 与桌面端复用同一个 `evaluateCandidate` 引擎与 `inMemoryRetriever` 检索驱动，不另起一套逻辑。同一候选 + 同一提示词哈希 → 结论一致；提示词或主数据版本变化时报告会提示结果可能不同。默认不写回，`--write` 才进入写回路径。

### export · 归并建议单导出（导出前过隐私闸门）

```bash
pnpm tsx scripts/run-merge.ts --limit 8 > /dev/null   # 先造 --in 输入：outputs/sample-batch/suggestions.json
pnpm export --in outputs/sample-batch/suggestions.json --out outputs/report
# 同批产出 outputs/report.json / report.csv / report.txt 三份；加 --batch 2026-W02 指定批次名
```

`--in` 接受建议 JSON 数组或 `{suggestions:[...]}`；`--out` 是不带扩展名的 basename，导出器一次写出 JSON / CSV / TXT 三份。内容为候选、结论、目标编码、理由、逐字段证据、确认人、回执状态；按批次分组、每条带序号，CSV 列序与审计链导出保持一致口径。导出前做姓名 / 证件号形态扫描，命中行逐条拒收，不整批阻塞。

## 骨架端到端切片

```bash
pnpm tsx scripts/run-merge.ts --limit 8                     # 读语料 → 检索 → 归并 → 落盘建议 JSON
# 产物：outputs/sample-batch/suggestions.json
```

未配置真实模型端点时引擎走确定性降级，产物中 `degraded=true` 的结论只作待人工处理、不可写回，并在 `note` 字段诚实标注。

## 基准对拍与放量阈值

```bash
pnpm tsx scripts/validate_benchmark.ts                      # 校验 160 条人工标注的完整性、分布与目标可解析
pnpm tsx scripts/compare_benchmark.ts                       # 同一基准集跑「字面基线」与「检索增强 + 模型」两条路径
# 产物：reports/benchmark/compare-report.json / .md、code-rules-check.md
```

指标口径：命中率（action 与目标 code 均正确）、错误归并率（期望非 merge 却给出 merge 且目标非空）、漏并率、存疑率、多义误判数。放量阈值：**错误归并率 > 0 → 不放量**并逐条列出错误归并明细；等于 0 → 允许进入人工灰度（仍需人工确认）。未配置模型端点时报告显式标注「模型路径未实连，仅基线可核验」，退出码与结论字段区分「不放量」与「未验证」，绝不拿基线数据冒充模型路径结论。权威码制 docx 不在本仓库内时，`code-rules-check.md` 如实标注「未完成（权威码制文件缺失）」，不编造条文。

同一输入连跑两次产出一致（误差 0），报告写明样本量与基准集版本。实测基线与报告见 `docs/examples.md` 与 `reports/benchmark/`。

## 真实截图采集（可复现）

```bash
pnpm exec tsx scripts/shots/gen-payload.ts                  # Node 侧真实语料 + 引擎 → scripts/shots/payload.json
pnpm exec vite build --config vite.shots.config.ts          # 真实 App.vue + 组件 + tokens.css 打成静态 SPA → .shots-build/
# 用本机静态服务托管 .shots-build/，再以 headless Chrome 1440px 视口逐视图截图：
#   ?view=desk|confirm|receipts|degraded  →  docs/screenshots/{desk,confirm,receipts,degraded}.png
```

截图 harness 只把真实渲染层组件与纯数据打进浏览器 bundle，不引入任何 Node builtins；`window.reviewDesk` 是只读替身，仅让真实 `onMounted → loadBatch()` 加载路径走通，不产生写调用。因为离线环境未配置真实模型端点，harness 按语料 `source_note` 的人工标注还原三态结论用于渲染真实界面，并在 README「实测证据」如实声明；托盘角标画面在本机无 Electron 二进制时不予伪造。

## 验收自检命令

```bash
pnpm install && pnpm build && pnpm test && pnpm typecheck   # 干净环境全绿
pnpm doctor --json                                          # 无凭据时输出合法 JSON 并非零退出
pnpm replay --candidate CAND-ALIAS-001                      # 复现单条，默认只读
pnpm export --in outputs/sample-batch/suggestions.json --out outputs/report  # 产出可读建议单
ls docs/screenshots/*.png | wc -l                          # ≥ 3 张真实截图
```
