# 基准对照报告（Task 51）
报告类型：Task 51 基准对照报告（字面相似度基线 vs 检索增强 + 模型）
## 一、样本量与数据集版本
- 样本量：**160**
- 数据集版本：manifest_version=1.0；expected_version=1；source=synthetic-simulator；deterministic_seed=20240433
- 语料规模：主数据 320 条 / 候选 160 条；manifest.generated_at=2024-07-01T08:00:00+08:00
- 样本构成：期望归并 64 条；期望非归并 96 条（其中期望存疑 32 条）
- 固定时钟：2024-07-01T08:00:00+08:00；报告生成时间：2024-07-01T08:00:00+08:00
- 说明：路径A 与路径B 使用同一套标注、同一候选顺序；除报告元数据外不含任何时间/随机/外部网络输入。
## 二、指标口径（公式）
| 指标 | 公式 |
| --- | --- |
| 样本量 | N = 本次参与对拍的人工标注条数（expected.json.annotations 长度）。 |
| 命中率 | 命中 = 路径 action 与 expected_action 相等，且 target_code 与 expected_target_code 相等（含同为 null）。命中率 = 命中数 / N。 |
| 错误归并率 | 错误归并 = expected_action !== "merge" 且路径 action === "merge" 且 target_code 非空。错误归并率 = 错误归并数 / N。 |
| 漏并率 | 漏并 = expected_action === "merge" 且未命中（未给出 action=merge 且 target_code 正确的结论）。漏并率 = 漏并数 / N。 |
| 存疑率 | 存疑 = 路径 action === "uncertain"。存疑率 = 存疑数 / N。 |
| 多义误判数 | 仅路径A：baseline 的 ambiguous_top_hits > 1 且该行同时被判为错误归并的条数。 |
| 放量阈值 | 错误归并数 > 0 → 结论「不放量」并列出全部错误归并 candidate_id；错误归并数 = 0 → 结论「允许人工灰度(仍需人工确认)」；模型路径未实连 → 结论「未验证」，不套用前两条。 |
| 率值精度 | 各项率 = 计数 / N，保留 6 位小数（四舍五入）；计数为逐条累加，N=0 时率记为 0。 |
分母说明：四项率统一以样本量 N=160 为分母（期望归并 64 条、期望非归并 96 条、其中期望存疑 32 条）；不按类别或期望动作换分母。错误归并数若改以「期望非归并」为分母则是另一口径，本报告不采用。
## 三、路径 A · 字面相似度基线
| 指标 | 计数 | 比率 |
| --- | ---: | ---: |
| 命中率 | 64 | 0.4 |
| 错误归并率 | 96 | 0.6 |
| 漏并率 | 0 | 0 |
| 存疑率 | 0 | 0 |
| 多义误判数 | 32 | 不适用 |
- 放量阈值判定：**不放量**
- 全部错误归并 candidate_id（96 条）：
- `CAND-CODEMIS-001`、`CAND-CODEMIS-002`、`CAND-CODEMIS-003`、`CAND-CODEMIS-004`、`CAND-CODEMIS-005`、`CAND-CODEMIS-006`、`CAND-CODEMIS-007`、`CAND-CODEMIS-008`、`CAND-CODEMIS-009`、`CAND-CODEMIS-010`、`CAND-CODEMIS-011`、`CAND-CODEMIS-012`
- `CAND-CODEMIS-013`、`CAND-CODEMIS-014`、`CAND-CODEMIS-015`、`CAND-CODEMIS-016`、`CAND-CODEMIS-017`、`CAND-CODEMIS-018`、`CAND-CODEMIS-019`、`CAND-CODEMIS-020`、`CAND-CODEMIS-021`、`CAND-CODEMIS-022`、`CAND-CODEMIS-023`、`CAND-CODEMIS-024`
- `CAND-CODEMIS-025`、`CAND-CODEMIS-026`、`CAND-CODEMIS-027`、`CAND-CODEMIS-028`、`CAND-CODEMIS-029`、`CAND-CODEMIS-030`、`CAND-CODEMIS-031`、`CAND-CODEMIS-032`、`CAND-INACTIVE-001`、`CAND-INACTIVE-002`、`CAND-INACTIVE-003`、`CAND-INACTIVE-004`
- `CAND-INACTIVE-005`、`CAND-INACTIVE-006`、`CAND-INACTIVE-007`、`CAND-INACTIVE-008`、`CAND-INACTIVE-009`、`CAND-INACTIVE-010`、`CAND-INACTIVE-011`、`CAND-INACTIVE-012`、`CAND-INACTIVE-013`、`CAND-INACTIVE-014`、`CAND-INACTIVE-015`、`CAND-INACTIVE-016`
- `CAND-INACTIVE-017`、`CAND-INACTIVE-018`、`CAND-INACTIVE-019`、`CAND-INACTIVE-020`、`CAND-INACTIVE-021`、`CAND-INACTIVE-022`、`CAND-INACTIVE-023`、`CAND-INACTIVE-024`、`CAND-INACTIVE-025`、`CAND-INACTIVE-026`、`CAND-INACTIVE-027`、`CAND-INACTIVE-028`
- `CAND-INACTIVE-029`、`CAND-INACTIVE-030`、`CAND-INACTIVE-031`、`CAND-INACTIVE-032`、`CAND-SPECDIFF-001`、`CAND-SPECDIFF-002`、`CAND-SPECDIFF-003`、`CAND-SPECDIFF-004`、`CAND-SPECDIFF-005`、`CAND-SPECDIFF-006`、`CAND-SPECDIFF-007`、`CAND-SPECDIFF-008`
- `CAND-SPECDIFF-009`、`CAND-SPECDIFF-010`、`CAND-SPECDIFF-011`、`CAND-SPECDIFF-012`、`CAND-SPECDIFF-013`、`CAND-SPECDIFF-014`、`CAND-SPECDIFF-015`、`CAND-SPECDIFF-016`、`CAND-SPECDIFF-017`、`CAND-SPECDIFF-018`、`CAND-SPECDIFF-019`、`CAND-SPECDIFF-020`
- `CAND-SPECDIFF-021`、`CAND-SPECDIFF-022`、`CAND-SPECDIFF-023`、`CAND-SPECDIFF-024`、`CAND-SPECDIFF-025`、`CAND-SPECDIFF-026`、`CAND-SPECDIFF-027`、`CAND-SPECDIFF-028`、`CAND-SPECDIFF-029`、`CAND-SPECDIFF-030`、`CAND-SPECDIFF-031`、`CAND-SPECDIFF-032`
- 错误归并按类别分布：停用码 32 条；医保码错配 32 条；同名异规格 32 条
- 多义误判数的口径：基线 ambiguous_top_hits>1 且被错误归并；这些行仅按排序首条取目标，不区分规格/单位/停用/码错配。
- 口径提醒：期望动作本身为 merge 的行永远不计入错误归并，这类行若目标码不对只计漏并；因此「换单位」这类期望归并的语料不会出现在上面的错误归并清单里。
## 四、路径 B · 检索增强 + 模型
| 指标 | 计数 | 比率 |
| --- | ---: | ---: |
| 命中率 | 96 | 0.6 |
| 错误归并率 | 0 | 0 |
| 漏并率 | 64 | 0.4 |
| 存疑率 | 96 | 0.6 |
- 模型路径实连：**否**
- 降级结论数：**64 / 160**；闸门/规则短路数：**96 / 160**（这些行 degraded=false，但一样不来自模型实连）
- 放量阈值判定：**未验证**
- 全部错误归并 candidate_id（0 条）：
- 无
- 错误归并按类别分布：无
## 五、诚实降级声明
> 模型路径未实连，仅基线可核验
模型路径未实连，仅基线可核验；路径B 64/160 条为 degraded=true，其余 96 条为闸门/规则的确定性短路（degraded=false），同样不来自模型实连。基线指标不得当作模型路径结果。
注意：路径A 的错误归并率不得当作模型路径结果；未实连时路径B 的「未验证」不等于「放行」，也不等于「不放量」，退出码单独区分。
## 六、逐条差异
- 差异条数：**160**（diffs 数组仅含任一侧未命中的行）
- 全量矩阵：160 行，全部写入下方 CSV 与 JSON 的 full_matrix，保证可复现。
| candidate_id | 类别 | 期望 | 路径A | 路径B | 差异项 |
| --- | --- | --- | --- | --- | --- |
| CAND-ALIAS-001 | 同义改名 | merge → YP600146 | merge → YP600146 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-002 | 同义改名 | merge → YP600148 | merge → YP600148 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-003 | 同义改名 | merge → YP600149 | merge → YP600149 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-004 | 同义改名 | merge → YP600150 | merge → YP600150 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-005 | 同义改名 | merge → YP600152 | merge → YP600152 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-006 | 同义改名 | merge → YP600153 | merge → YP600153 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-007 | 同义改名 | merge → YP600154 | merge → YP600154 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-008 | 同义改名 | merge → YP600155 | merge → YP600155 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-009 | 同义改名 | merge → YP600156 | merge → YP600156 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-010 | 同义改名 | merge → YP600157 | merge → YP600157 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-011 | 同义改名 | merge → YP600162 | merge → YP600162 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-012 | 同义改名 | merge → YP600163 | merge → YP600163 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-013 | 同义改名 | merge → YP600164 | merge → YP600164 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-014 | 同义改名 | merge → YP600166 | merge → YP600166 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-015 | 同义改名 | merge → YP600168 | merge → YP600168 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-016 | 同义改名 | merge → YP600169 | merge → YP600169 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-017 | 同义改名 | merge → YP600170 | merge → YP600170 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-018 | 同义改名 | merge → YP600171 | merge → YP600171 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-019 | 同义改名 | merge → YP600174 | merge → YP600174 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-020 | 同义改名 | merge → YP600176 | merge → YP600176 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-021 | 同义改名 | merge → YP600179 | merge → YP600179 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-022 | 同义改名 | merge → YP600181 | merge → YP600181 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-023 | 同义改名 | merge → YP600182 | merge → YP600182 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-024 | 同义改名 | merge → YP600184 | merge → YP600184 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-025 | 同义改名 | merge → YP600185 | merge → YP600185 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-026 | 同义改名 | merge → YP600188 | merge → YP600188 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-027 | 同义改名 | merge → YP600189 | merge → YP600189 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-028 | 同义改名 | merge → YP600190 | merge → YP600190 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-029 | 同义改名 | merge → YP600192 | merge → YP600192 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-030 | 同义改名 | merge → YP600194 | merge → YP600194 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-031 | 同义改名 | merge → YP600195 | merge → YP600195 | uncertain → null | 路径B未命中（漏并） |
| CAND-ALIAS-032 | 同义改名 | merge → YP600196 | merge → YP600196 | uncertain → null | 路径B未命中（漏并） |
| CAND-CODEMIS-001 | 医保码错配 | create → null | merge → YP600036 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-002 | 医保码错配 | create → null | merge → YP600037 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-003 | 医保码错配 | create → null | merge → YP600038 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-004 | 医保码错配 | create → null | merge → YP600040 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-005 | 医保码错配 | create → null | merge → YP600041 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-006 | 医保码错配 | create → null | merge → YP600042 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-007 | 医保码错配 | create → null | merge → YP600043 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-008 | 医保码错配 | create → null | merge → YP600044 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-009 | 医保码错配 | create → null | merge → YP600045 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-010 | 医保码错配 | create → null | merge → YP600046 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-011 | 医保码错配 | create → null | merge → YP600048 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-012 | 医保码错配 | create → null | merge → YP600049 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-013 | 医保码错配 | create → null | merge → YP600050 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-014 | 医保码错配 | create → null | merge → YP600051 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-015 | 医保码错配 | create → null | merge → YP600052 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-016 | 医保码错配 | create → null | merge → YP600053 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-017 | 医保码错配 | create → null | merge → YP600054 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-018 | 医保码错配 | create → null | merge → YP600056 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-019 | 医保码错配 | create → null | merge → YP600057 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-020 | 医保码错配 | create → null | merge → YP600058 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-021 | 医保码错配 | create → null | merge → YP600059 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-022 | 医保码错配 | create → null | merge → YP600060 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-023 | 医保码错配 | create → null | merge → YP600061 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-024 | 医保码错配 | create → null | merge → YP600062 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-025 | 医保码错配 | create → null | merge → YP600064 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-026 | 医保码错配 | create → null | merge → YP600065 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-027 | 医保码错配 | create → null | merge → YP600066 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-028 | 医保码错配 | create → null | merge → YP600067 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-029 | 医保码错配 | create → null | merge → YP600068 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-030 | 医保码错配 | create → null | merge → YP600069 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-031 | 医保码错配 | create → null | merge → YP600070 | create → null | 路径A未命中（错误归并） |
| CAND-CODEMIS-032 | 医保码错配 | create → null | merge → YP600072 | create → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-001 | 停用码 | uncertain → null | merge → YP600007 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-002 | 停用码 | uncertain → null | merge → YP600015 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-003 | 停用码 | uncertain → null | merge → YP600023 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-004 | 停用码 | uncertain → null | merge → YP600031 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-005 | 停用码 | uncertain → null | merge → YP600039 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-006 | 停用码 | uncertain → null | merge → YP600047 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-007 | 停用码 | uncertain → null | merge → YP600055 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-008 | 停用码 | uncertain → null | merge → YP600063 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-009 | 停用码 | uncertain → null | merge → YP600071 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-010 | 停用码 | uncertain → null | merge → YP600079 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-011 | 停用码 | uncertain → null | merge → YP600087 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-012 | 停用码 | uncertain → null | merge → YP600095 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-013 | 停用码 | uncertain → null | merge → YP600103 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-014 | 停用码 | uncertain → null | merge → YP600111 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-015 | 停用码 | uncertain → null | merge → YP600119 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-016 | 停用码 | uncertain → null | merge → YP600127 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-017 | 停用码 | uncertain → null | merge → YP600135 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-018 | 停用码 | uncertain → null | merge → YP600143 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-019 | 停用码 | uncertain → null | merge → YP600151 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-020 | 停用码 | uncertain → null | merge → YP600159 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-021 | 停用码 | uncertain → null | merge → YP600167 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-022 | 停用码 | uncertain → null | merge → YP600175 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-023 | 停用码 | uncertain → null | merge → YP600183 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-024 | 停用码 | uncertain → null | merge → YP600191 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-025 | 停用码 | uncertain → null | merge → YP600199 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-026 | 停用码 | uncertain → null | merge → YP600207 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-027 | 停用码 | uncertain → null | merge → YP600215 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-028 | 停用码 | uncertain → null | merge → YP600223 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-029 | 停用码 | uncertain → null | merge → YP600231 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-030 | 停用码 | uncertain → null | merge → YP600239 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-031 | 停用码 | uncertain → null | merge → YP600247 | uncertain → null | 路径A未命中（错误归并） |
| CAND-INACTIVE-032 | 停用码 | uncertain → null | merge → YP600255 | uncertain → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-001 | 同名异规格 | create → null | merge → YP600000 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-002 | 同名异规格 | create → null | merge → YP600001 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-003 | 同名异规格 | create → null | merge → YP600002 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-004 | 同名异规格 | create → null | merge → YP600003 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-005 | 同名异规格 | create → null | merge → YP600004 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-006 | 同名异规格 | create → null | merge → YP600005 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-007 | 同名异规格 | create → null | merge → YP600006 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-008 | 同名异规格 | create → null | merge → YP600008 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-009 | 同名异规格 | create → null | merge → YP600009 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-010 | 同名异规格 | create → null | merge → YP600010 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-011 | 同名异规格 | create → null | merge → YP600011 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-012 | 同名异规格 | create → null | merge → YP600012 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-013 | 同名异规格 | create → null | merge → YP600013 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-014 | 同名异规格 | create → null | merge → YP600014 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-015 | 同名异规格 | create → null | merge → YP600016 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-016 | 同名异规格 | create → null | merge → YP600017 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-017 | 同名异规格 | create → null | merge → YP600018 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-018 | 同名异规格 | create → null | merge → YP600019 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-019 | 同名异规格 | create → null | merge → YP600020 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-020 | 同名异规格 | create → null | merge → YP600021 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-021 | 同名异规格 | create → null | merge → YP600022 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-022 | 同名异规格 | create → null | merge → YP600024 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-023 | 同名异规格 | create → null | merge → YP600025 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-024 | 同名异规格 | create → null | merge → YP600026 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-025 | 同名异规格 | create → null | merge → YP600027 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-026 | 同名异规格 | create → null | merge → YP600001 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-027 | 同名异规格 | create → null | merge → YP600022 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-028 | 同名异规格 | create → null | merge → YP600030 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-029 | 同名异规格 | create → null | merge → YP600032 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-030 | 同名异规格 | create → null | merge → YP600033 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-031 | 同名异规格 | create → null | merge → YP600027 | create → null | 路径A未命中（错误归并） |
| CAND-SPECDIFF-032 | 同名异规格 | create → null | merge → YP600035 | create → null | 路径A未命中（错误归并） |
| CAND-UNITCONV-001 | 换单位 | merge → YP600073 | merge → YP600073 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-002 | 换单位 | merge → YP600074 | merge → YP600074 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-003 | 换单位 | merge → YP600075 | merge → YP600075 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-004 | 换单位 | merge → YP600076 | merge → YP600076 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-005 | 换单位 | merge → YP600077 | merge → YP600077 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-006 | 换单位 | merge → YP600078 | merge → YP600078 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-007 | 换单位 | merge → YP600081 | merge → YP600081 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-008 | 换单位 | merge → YP600083 | merge → YP600083 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-009 | 换单位 | merge → YP600084 | merge → YP600084 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-010 | 换单位 | merge → YP600085 | merge → YP600085 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-011 | 换单位 | merge → YP600088 | merge → YP600088 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-012 | 换单位 | merge → YP600090 | merge → YP600090 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-013 | 换单位 | merge → YP600092 | merge → YP600092 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-014 | 换单位 | merge → YP600093 | merge → YP600093 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-015 | 换单位 | merge → YP600094 | merge → YP600094 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-016 | 换单位 | merge → YP600096 | merge → YP600096 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-017 | 换单位 | merge → YP600097 | merge → YP600097 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-018 | 换单位 | merge → YP600098 | merge → YP600098 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-019 | 换单位 | merge → YP600099 | merge → YP600099 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-020 | 换单位 | merge → YP600100 | merge → YP600100 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-021 | 换单位 | merge → YP600101 | merge → YP600101 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-022 | 换单位 | merge → YP600102 | merge → YP600102 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-023 | 换单位 | merge → YP600104 | merge → YP600104 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-024 | 换单位 | merge → YP600105 | merge → YP600105 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-025 | 换单位 | merge → YP600106 | merge → YP600106 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-026 | 换单位 | merge → YP600107 | merge → YP600107 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-027 | 换单位 | merge → YP600108 | merge → YP600108 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-028 | 换单位 | merge → YP600109 | merge → YP600109 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-029 | 换单位 | merge → YP600110 | merge → YP600110 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-030 | 换单位 | merge → YP600112 | merge → YP600112 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-031 | 换单位 | merge → YP600113 | merge → YP600113 | uncertain → null | 路径B未命中（漏并） |
| CAND-UNITCONV-032 | 换单位 | merge → YP600115 | merge → YP600115 | uncertain → null | 路径B未命中（漏并） |
### 全量矩阵（CSV）
```csv
candidate_id,category,expected_action,expected_target_code,pathA_action,pathA_target_code,pathA_hit,pathB_action,pathB_target_code,pathB_hit,pathA_wrong_merge,pathB_wrong_merge,pathA_miss,pathB_miss,pathB_degraded,expected_code_resolved
CAND-ALIAS-001,同义改名,merge,YP600146,merge,YP600146,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-002,同义改名,merge,YP600148,merge,YP600148,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-003,同义改名,merge,YP600149,merge,YP600149,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-004,同义改名,merge,YP600150,merge,YP600150,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-005,同义改名,merge,YP600152,merge,YP600152,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-006,同义改名,merge,YP600153,merge,YP600153,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-007,同义改名,merge,YP600154,merge,YP600154,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-008,同义改名,merge,YP600155,merge,YP600155,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-009,同义改名,merge,YP600156,merge,YP600156,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-010,同义改名,merge,YP600157,merge,YP600157,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-011,同义改名,merge,YP600162,merge,YP600162,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-012,同义改名,merge,YP600163,merge,YP600163,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-013,同义改名,merge,YP600164,merge,YP600164,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-014,同义改名,merge,YP600166,merge,YP600166,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-015,同义改名,merge,YP600168,merge,YP600168,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-016,同义改名,merge,YP600169,merge,YP600169,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-017,同义改名,merge,YP600170,merge,YP600170,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-018,同义改名,merge,YP600171,merge,YP600171,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-019,同义改名,merge,YP600174,merge,YP600174,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-020,同义改名,merge,YP600176,merge,YP600176,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-021,同义改名,merge,YP600179,merge,YP600179,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-022,同义改名,merge,YP600181,merge,YP600181,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-023,同义改名,merge,YP600182,merge,YP600182,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-024,同义改名,merge,YP600184,merge,YP600184,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-025,同义改名,merge,YP600185,merge,YP600185,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-026,同义改名,merge,YP600188,merge,YP600188,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-027,同义改名,merge,YP600189,merge,YP600189,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-028,同义改名,merge,YP600190,merge,YP600190,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-029,同义改名,merge,YP600192,merge,YP600192,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-030,同义改名,merge,YP600194,merge,YP600194,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-031,同义改名,merge,YP600195,merge,YP600195,true,uncertain,,false,false,false,false,true,true,true
CAND-ALIAS-032,同义改名,merge,YP600196,merge,YP600196,true,uncertain,,false,false,false,false,true,true,true
CAND-CODEMIS-001,医保码错配,create,,merge,YP600036,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-002,医保码错配,create,,merge,YP600037,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-003,医保码错配,create,,merge,YP600038,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-004,医保码错配,create,,merge,YP600040,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-005,医保码错配,create,,merge,YP600041,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-006,医保码错配,create,,merge,YP600042,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-007,医保码错配,create,,merge,YP600043,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-008,医保码错配,create,,merge,YP600044,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-009,医保码错配,create,,merge,YP600045,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-010,医保码错配,create,,merge,YP600046,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-011,医保码错配,create,,merge,YP600048,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-012,医保码错配,create,,merge,YP600049,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-013,医保码错配,create,,merge,YP600050,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-014,医保码错配,create,,merge,YP600051,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-015,医保码错配,create,,merge,YP600052,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-016,医保码错配,create,,merge,YP600053,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-017,医保码错配,create,,merge,YP600054,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-018,医保码错配,create,,merge,YP600056,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-019,医保码错配,create,,merge,YP600057,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-020,医保码错配,create,,merge,YP600058,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-021,医保码错配,create,,merge,YP600059,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-022,医保码错配,create,,merge,YP600060,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-023,医保码错配,create,,merge,YP600061,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-024,医保码错配,create,,merge,YP600062,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-025,医保码错配,create,,merge,YP600064,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-026,医保码错配,create,,merge,YP600065,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-027,医保码错配,create,,merge,YP600066,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-028,医保码错配,create,,merge,YP600067,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-029,医保码错配,create,,merge,YP600068,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-030,医保码错配,create,,merge,YP600069,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-031,医保码错配,create,,merge,YP600070,false,create,,true,true,false,false,false,false,true
CAND-CODEMIS-032,医保码错配,create,,merge,YP600072,false,create,,true,true,false,false,false,false,true
CAND-INACTIVE-001,停用码,uncertain,,merge,YP600007,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-002,停用码,uncertain,,merge,YP600015,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-003,停用码,uncertain,,merge,YP600023,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-004,停用码,uncertain,,merge,YP600031,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-005,停用码,uncertain,,merge,YP600039,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-006,停用码,uncertain,,merge,YP600047,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-007,停用码,uncertain,,merge,YP600055,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-008,停用码,uncertain,,merge,YP600063,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-009,停用码,uncertain,,merge,YP600071,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-010,停用码,uncertain,,merge,YP600079,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-011,停用码,uncertain,,merge,YP600087,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-012,停用码,uncertain,,merge,YP600095,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-013,停用码,uncertain,,merge,YP600103,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-014,停用码,uncertain,,merge,YP600111,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-015,停用码,uncertain,,merge,YP600119,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-016,停用码,uncertain,,merge,YP600127,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-017,停用码,uncertain,,merge,YP600135,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-018,停用码,uncertain,,merge,YP600143,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-019,停用码,uncertain,,merge,YP600151,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-020,停用码,uncertain,,merge,YP600159,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-021,停用码,uncertain,,merge,YP600167,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-022,停用码,uncertain,,merge,YP600175,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-023,停用码,uncertain,,merge,YP600183,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-024,停用码,uncertain,,merge,YP600191,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-025,停用码,uncertain,,merge,YP600199,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-026,停用码,uncertain,,merge,YP600207,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-027,停用码,uncertain,,merge,YP600215,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-028,停用码,uncertain,,merge,YP600223,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-029,停用码,uncertain,,merge,YP600231,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-030,停用码,uncertain,,merge,YP600239,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-031,停用码,uncertain,,merge,YP600247,false,uncertain,,true,true,false,false,false,false,true
CAND-INACTIVE-032,停用码,uncertain,,merge,YP600255,false,uncertain,,true,true,false,false,false,false,true
CAND-SPECDIFF-001,同名异规格,create,,merge,YP600000,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-002,同名异规格,create,,merge,YP600001,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-003,同名异规格,create,,merge,YP600002,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-004,同名异规格,create,,merge,YP600003,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-005,同名异规格,create,,merge,YP600004,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-006,同名异规格,create,,merge,YP600005,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-007,同名异规格,create,,merge,YP600006,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-008,同名异规格,create,,merge,YP600008,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-009,同名异规格,create,,merge,YP600009,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-010,同名异规格,create,,merge,YP600010,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-011,同名异规格,create,,merge,YP600011,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-012,同名异规格,create,,merge,YP600012,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-013,同名异规格,create,,merge,YP600013,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-014,同名异规格,create,,merge,YP600014,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-015,同名异规格,create,,merge,YP600016,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-016,同名异规格,create,,merge,YP600017,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-017,同名异规格,create,,merge,YP600018,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-018,同名异规格,create,,merge,YP600019,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-019,同名异规格,create,,merge,YP600020,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-020,同名异规格,create,,merge,YP600021,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-021,同名异规格,create,,merge,YP600022,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-022,同名异规格,create,,merge,YP600024,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-023,同名异规格,create,,merge,YP600025,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-024,同名异规格,create,,merge,YP600026,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-025,同名异规格,create,,merge,YP600027,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-026,同名异规格,create,,merge,YP600001,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-027,同名异规格,create,,merge,YP600022,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-028,同名异规格,create,,merge,YP600030,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-029,同名异规格,create,,merge,YP600032,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-030,同名异规格,create,,merge,YP600033,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-031,同名异规格,create,,merge,YP600027,false,create,,true,true,false,false,false,false,true
CAND-SPECDIFF-032,同名异规格,create,,merge,YP600035,false,create,,true,true,false,false,false,false,true
CAND-UNITCONV-001,换单位,merge,YP600073,merge,YP600073,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-002,换单位,merge,YP600074,merge,YP600074,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-003,换单位,merge,YP600075,merge,YP600075,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-004,换单位,merge,YP600076,merge,YP600076,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-005,换单位,merge,YP600077,merge,YP600077,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-006,换单位,merge,YP600078,merge,YP600078,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-007,换单位,merge,YP600081,merge,YP600081,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-008,换单位,merge,YP600083,merge,YP600083,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-009,换单位,merge,YP600084,merge,YP600084,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-010,换单位,merge,YP600085,merge,YP600085,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-011,换单位,merge,YP600088,merge,YP600088,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-012,换单位,merge,YP600090,merge,YP600090,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-013,换单位,merge,YP600092,merge,YP600092,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-014,换单位,merge,YP600093,merge,YP600093,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-015,换单位,merge,YP600094,merge,YP600094,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-016,换单位,merge,YP600096,merge,YP600096,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-017,换单位,merge,YP600097,merge,YP600097,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-018,换单位,merge,YP600098,merge,YP600098,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-019,换单位,merge,YP600099,merge,YP600099,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-020,换单位,merge,YP600100,merge,YP600100,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-021,换单位,merge,YP600101,merge,YP600101,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-022,换单位,merge,YP600102,merge,YP600102,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-023,换单位,merge,YP600104,merge,YP600104,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-024,换单位,merge,YP600105,merge,YP600105,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-025,换单位,merge,YP600106,merge,YP600106,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-026,换单位,merge,YP600107,merge,YP600107,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-027,换单位,merge,YP600108,merge,YP600108,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-028,换单位,merge,YP600109,merge,YP600109,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-029,换单位,merge,YP600110,merge,YP600110,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-030,换单位,merge,YP600112,merge,YP600112,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-031,换单位,merge,YP600113,merge,YP600113,true,uncertain,,false,false,false,false,true,true,true
CAND-UNITCONV-032,换单位,merge,YP600115,merge,YP600115,true,uncertain,,false,false,false,false,true,true,true
```
## 七、码制口径对照
- 状态：**未完成（权威码制文件缺失）**
- 报告路径：`reports/benchmark/code-rules-check.md`
- 摘要：参考 docx 在本环境不存在，未打开、未引用；本文只记录复合键实际使用的码制形状与归一实现，不声称符合权威标准。
## 八、放量阈值与退出码
| 路径 | 结论 | 退出码 |
| --- | --- | ---: |
| 路径A 字面相似度基线 | 不放量 | 不由基线决定 |
| 路径B 检索增强 + 模型 | 未验证 | 0 |
- 0：模型路径未验证（诚实降级，本批不放行也不认定不合格）
- 1：模型路径不放量（存在错误归并）
- 2：模型路径允许人工灰度(仍需人工确认)
## 九、复用模块说明（仅记录，未修改）
- 路径B 中 degraded=false 的条目来自闸门/规则的确定性短路（create 或 uncertain），不是模型实连输出；因此未实连时 路径B降级数 可以小于 样本量，但路径B 仍判未验证。
- 基线只按排序首条出结论，ambiguous_top_hits>1 时仍归并，这正是其错误归并率大于 0 的结构性原因。
- 指标计算只读取 action / target_code / degraded / ambiguous_top_hits；被引擎写入调用日志与延迟的墙钟时间不进入任何指标。
- 默认路径B 使用 createTestConfig() 的占位端点 http://127.0.0.1:1（不可达），只产生本地连接拒绝，不引入外部网络依赖，也不改变结论。
