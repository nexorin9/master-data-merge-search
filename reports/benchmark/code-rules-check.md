# 码制口径对照（Task 51）

## 结论

- 对照状态：**未完成（权威码制文件缺失）**
- 权威码制文件在本环境不存在；本次**未咨询、未打开、未引用**该文件，也**未据其判定符合性**。
- 下文只记录本工程源码/配置/夹具中确实存在的码制形状与归一口径；不含来自权威 docx 的条文、页码、条款号或发布日期。

## 一、权威文件缺失（检索事实）

- 参考文档：`domain/corpus/dictionary/code_rules_15_医疗保障定点医疗机构等10项信息业务编码规则和方法共15项编码标准.docx`（医保发〔2019〕55号附件）。
- 检索范围 1：项目根目录。已执行 `find . -iname '*code_rules*' -o -iname '*.docx' | grep -v node_modules | sort`，结果 0 条。
- 检索范围 2：本回合目录 `/Users/kamini/Desktop/RUN/Agent-GIT-CLAUDE-gpt/projects/round_032_20261108_220804`。已执行 `find <回合目录> -iname '*.docx' -o -iname '*code_rules*'`，结果 0 条。
- 结论：该 docx 无法取得，因此码制符合性**未核验**；禁止把本文解读为已完成标准对齐。

## 二、复合键实际使用的码制形状（以源码为准，非权威核验）

### 2.1 医保码 insurance_code（drug 域）

- 数据集生成口径：`tests/fixtures/corpus/MANIFEST.json:157` 记载「官方医保码风格 15 位：类别前缀 XJ + 13 位数字；主数据段 7000…/5000…/4000…/3000…，错配段 9100…/9200…」。这是仿真器约定，不是权威标准条文。
- 工程实际强校验：仅 `src/core/engine/gate-decision.ts:58-70` 对 `drug` 域且非空医保码做「长度 < 8 → 格式异常、转人工存疑」，源码判据是 `insuranceCode.length < 8`（见该文件 `:60`）。**没有** `^XJ\d{13}$` 这类完整形状正则；长度 8–14 或含非数字的字符串不会因形状被拒。
- 复合键用法：`src/core/binding/composite-key.ts:44-56` 把 `textKey(insurance_code)` 拼成 `ic=...` 段；`textKey`（同文件 `:30-32`）经 `normalizeText`（`src/core/normalize/encoding.ts:92-101`）做宽度/不可见字符归一与去空白，不校验码制形状。
- 因此「XJ + 13 位」目前只是语料生成约定 + 过短拦截，不能据此声称已与任何医保编码标准对齐。

### 2.2 院内主数据编码 code

- 数据集生成口径：`tests/fixtures/corpus/MANIFEST.json:158` 记载 `drug=YP+6位`、`fee_item=FY+6位`、`department=KS+6位`、`exam=JC+6位`。
- 复合键与闸门**不解析** `code` 形状；`code` 只作为归并目标标识输出（`src/core/engine/baseline.ts:192`、`src/core/engine/gate-decision.ts:127`）。
- 该前缀规则同样来源于确定性仿真器，未与权威码制比对。

### 2.3 规格 spec / 剂型 dosage_form / 单位 unit

- `src/core/binding/composite-key.ts:15-21`：`spec` 走 `normalizedSpecKey`（`src/core/normalize/spec.ts:125-138`），含量按维度换算到 mg/ml 基准，包装计数与单位按别名归一。
- `src/core/normalize/spec.ts:107-122`：`equivalentSpec` 要求含量同类换算相等（如 250mg ≡ 0.25g）、包装计数相同、包装单位不得跨维度冲突；解析失败返回不等价，不猜测。
- `config/unit-alias.json:2` 明确「按维度分组，跨维度不换算」；维度含 `mass / count / volume / time / dose_form`（`dose_form` 分组见 `:29`）。同文件 `:3-11` 给出 mg/g/μg/kg 的质量别名，`:12-21` 给出片/粒/袋/支/瓶/盒等计数别名。
- `src/core/normalize/unit.ts:42-55`：`lookupUnit` 把别名映射到标准单位与维度，未命中保留原值并标 `dimension=unknown`；`:58-65` 的 `normalizeUnit` 对未知单位写 `unit_unknown`。
- 同文件 `:89-102` 的 `convertUnit` 只在同维度且系数表内换算；`:105-110` 的 `isUnitMismatch` 对跨维度或不同标准单位返回冲突。换算系数表见 `:69-73`（mass 基准 mg、volume 基准 ml、time 基准 min）。
- `unit` 字段归一：`src/core/binding/composite-key.ts:24-27` 用 `lookupUnit` 取标准单位后拼入复合键，未知值保留原样。
- `dosage_form` 字段：`src/core/binding/composite-key.ts:30-32` 的 `textKey` 只做文本归一与去空白，**未查别名表**。`config/unit-alias.json:29-36` 虽有 `dose_form` 分组，但复合键当前未直接使用它；这是已观察到、待人工确认的口径差异，本次只记录不修改源码。
- 基线路径另有一套实现：`src/core/engine/baseline.ts:43-58` 用 `equivalentSpec` 加字面 `unitEqual`，与复合键的 `normalizedSpecKey` 并非同一份代码。

## 三、未完成项与具体下一步

- 状态：未完成（权威码制文件缺失）。
1. 从权威渠道取得医保发〔2019〕55号附件原文，置于 `domain/corpus/dictionary/code_rules_15_医疗保障定点医疗机构等10项信息业务编码规则和方法共15项编码标准.docx`，并登记来源 URL、发布日期与文件哈希。
2. 逐条抽取「XJ + 13 位」、各域院内编码前缀、单位/剂型归一与跨维度禁止换算的条文，与本文第二节逐项对照，登记「一致 / 不一致 / 未覆盖」。
3. 重点核实两点：医保码是否应做 `^XJ\d{13}$` 完整校验；`dosage_form` 是否应按 `config/unit-alias.json` 的 `dose_form` 别名分组归一。
4. 对照完成并留存证据后，才可将状态改为「已完成」并在放量决策中引用；在此之前不得据此声称符合权威码制。

固定时钟：2024-07-01T08:00:00+08:00（仅用于报告元数据，不影响码制结论）。
