# 0016 — 三维度基准 KB＋角色族加权评分＋L2 导入导出闭环（取代 0015 的评分与排序面）

日期：2026-11-14 ｜ 状态：用户批准（v0.0.4 未发布原地）｜ 关联：[0015](2026-11-capability-derivation.md)、[0014](2026-11-derived-default-mapping.md) ｜ L1 远端同步留位下版

## 取代/存活清单

**取代**：
- 0015 决策 1 的评分输入（efforts/description 结构信号＋名称信号方案）：能力真值改为**外部基准 KB**；efforts 梯子档/档数/description 降为 KB 并列时的 tie-break 链（0015 全部 tie-break 资产保留）
- 0015 的单一能力序：改为**角色族×维度加权**（三族独立排序）
- 名称信号比较器（曾在 0015 修订稿中提议、被调研证伪）：**未实现即废**

**存活**：0014 全部（派生默认/copy-on-write/R1 门控/三时机重派生）、0015 的 mid 梯子语义、渐进匹配的"剥后缀"管线（从排序信号降级为 **KB 匹配辅助**）。

## 背景（四轮调研＋三轮对抗二审）

用户三轮质疑全部被实证确认：① "27B 参数压过 flash 变体词"被证伪——deepseek-v4.1-flash（激活 8-16B）显著强于 Qwen3.8-27B（AA v5.0.1 40vs20、DeepSWE 77.0vs42.2），同族反例 Qwen3.8-Flash-Next（6B 激活）压过 27B 稠密（29vs20）——**跨族名称规则不可靠、同族参数规则仅中等强度，唯一可靠锚点＝外部基准**；② 单一能力指数不足——需前端/通用编码/Agent 三维度（社区证据：Gemini 系=前端强、Claude 系=规划重构强、Terminal-Bench 类信号驱动 agent 选型）；③ 版本绑定快照陈旧——三层评分来源（用户裁定：本次 L0＋L2，L1 下版）。

## 决策

### 1. 三维度基准 KB（L0，内置快照）

- **数据源**（全部可再分发，NOTICES 署名）：LMArena leaderboard-dataset（CC-BY-4.0；text/coding＋webdev＋agent 子集一站三维度）＋Aider polyglot（Apache-2.0）＋BigCodeBench（Apache-2.0）＋τ-bench（MIT）＋ByteDance Web-Bench（Apache-2.0）。**排除**：LiveCodeBench（CC BY-SA 传染）、tbench.ai/vals.ai/DesignArena/Copilot Arena/GAIA（无再分发许可）、AA 指数（需商业授权）、OpenRouter 用量/价格（许可暴露面，仅构建期参考）。
- **构建**：`scripts/build-capability-kb.mjs` 手跑；生成物 `src/capability-kb.ts` 入库（GENERATED 头＋确定性输出：排序键＋定点小数）；CI 零网络；变换函数 fixture 单测；KB 不变量测试（键唯一/权重和/日期在场）＋序列化 <40KB 预算。
- **四维分** {overall, coding, webdev, agentic}＝各源 **rank-fraction 百分位**（归一总体＝构建时全源榜单全体，非 KB 子集）；**缺段=0.5 中位固定填充、不重归一**（缺席证据不得反超已证实能力——R-1 反例红测：缺 coding 者不得凭重归一胜三段齐全者）；缺主锚段（coding）→ **estimated** 标。
- **渐进匹配**（R-2）：原样 exact→alias→**每剥一层后缀重试**（量化/日期/新鲜度逐层）→家族回退（releaseDate 取 max、最长保留词干优先，不解析版本号）；多别名 normalize 冲突→构建期 fail-loud；**provider（strata/sz 等部署名）绝不参与匹配，仅作用于 model id**；完全 miss＝unknown。

### 2. 角色族×维度加权（每族独立排序）

- 族权重＝**带方向依据的 opinionated defaults**（方向引社区证据；数字为设计常量，改即改 ADR，不开 config）：
  - S 质量把关（review/audit/verif/plan）：coding .45 / overall .25 / agentic .20 / webdev .10
  - B 执行构建（research/dev/build/execute/write/design）：coding .40 / overall .30 / webdev .20 / agentic .10
  - F 不设权重
- 槽位：**S=argmax(w_S·dims)**；**B=w_B 序上中位**；**F=argmin(w_S·dims)**——明示 F 选的是"S 权重下能力最弱者"，是成本/延迟的**间接代理**（宿主无价格信号），非延迟排序。
- **A-1 裁定：unknown 哨兵对 S/B/F 一律最后备选**（缺收录的新旗舰不会被推去接 test/qa；F 槽命中 unknown 时"未收录"标注可见）。**A-6：estimated 不参与 argmax/argmin 胜出**，仅作 B 排序中位填充。
- 并列逐槽规则：**S/B 取清单前者、F 取清单后者**（与 0015 行为连续）；F 并列前置 FAST_HINT 破序。新不变量明示：**三族独立择优、同模型可现于多族、无跨族包含保证**（n=2 时 B 必与 S 或 F 撞槽——行为与 0015 同为撞槽但对象可随权重序翻转，defaults 头行提示）。
- 复合键：族分 → topTierRank → activeTierCount → descHint → 清单序；效力意图（top/mid/lowest 于所选模型自身梯子物化）不变；**KB 强但梯子档低者拿 S＋其自身最高档**（effort 是模型内旋钮非跨模型标度）。

### 3. L2 用户导入导出闭环

- **导出**（Team 区按钮）：JSON 调研包 {schema:1, candidates＋KB 匹配状态, dimensions, prompt_zh/en}；prompt **诱出分布位置判断**（"0-100 表达相对当前主流模型总体的位置：50≈主流中位、70≈前四分之一、90≈前 10%"——B-1 量纲裁定）＋内嵌输出 schema；下载/剪贴板；仅含模型名无隐私。
- **导入**（三层校验）：schema 层（0-100 边界＋条数≤64，schemastery）；导入器语义层（同 model 重复**拒**＋逐条即时反馈匹配结果〔命中/别名命中/未命中仍存〕＋全维度缺省拒＋asOf=调研执行日期默认当日可改、产出模型自报来源降级 note 不可核验）；运行时容错层（手编 yml 坏条目**逐条丢弃＋degraded warn 不 brick**——overrides 是辅助评分数据非路由结构；重复 last-wins＋warn）。
- 存储：`config.capabilityOverrides`（volatile 数组；**存原始字符串**、读取期渐进匹配；model-only 键跨 provider 生效与 L0 对齐）；统一保存 → 既有 commit→rederive 链路即时生效。
- **优先级链（维度级）：L2 override > L0 KB > 0.5 填充 > 哨兵**（全缺触发）；换算＝**0-100 /100 线性映射、不重归一**（重归一会抹掉用户给的相对差）＋残余校准偏差声明（不同产出模型刻度漂移）＋UI 显示评分来源（内置快照日期/导入 asOf）。
- overrides UI：列表常驻匹配状态徽标（随候选增删实时重算）＋逐条删除＋清空（＝回 L0）。

### 4. UI 反馈修正（承接 0015 轮 P1/P2）

恢复默认按钮禁用态＝**内联展开** opacity .45＋cursor default（CSS 类打不过 inline cursor——P1 教训）；五区"待保存"徽标全函数分派（清单区＝priority+strategy+钉定三件；Team＝nameMap+nameMapDefaults；兜底行＝fallback×3；高级折叠头＝5 开关；limits）且徽标判定与 fieldOps **共用 JSON 比较助手**；defaultsHint 追加"（预览随草稿实时变化，保存后生效）"；"未收录"标注＋KB 快照日期进 ⓘ help。

### 5. 角色档位维持＋分歧记录（零行变更）

S 族＋top 维持——裁定基础＝**用户既定产品语义＋官方"高风险审查=最强"背书**，非"调研支持"；社区分歧如实记录：4 源独立把常驻 review 放中档（含对抗实测 Sonnet 找 bug 不输 Opus），主流是"按风险分档＋瀑布"——custom 模式即调整通道。

### 6. 首轮问题闭环表

| 项 | 处置 |
|---|---|
| R-1 缺段重归一偏置 | ✅ 决策 1（0.5 填充不重归一＋红测） |
| R-2 剥后缀丢更优命中 | ✅ 决策 1（渐进匹配＋红测 fixture） |
| R-3 known/unknown 比较器 | ✅ 决策 2（A-1 哨兵三槽最后备选） |
| Y-1 z 合成偏斜 | ✅ 改 rank-fraction＋全源总体 |
| Y-2 家族回退规则 | ✅ releaseDate max＋最长词干 |
| Y-3 别名冲突 | ✅ 构建 fail-loud＋不变量测试 |
| Y-4 provider 作用侧 | ✅ 决策 1 明文＋红测 |
| Y-5 OR 数据 | ✅ 不入库（构建期参考） |
| Y-6 NOTICES/files | ✅ 决策 1 |
| Y-7 徽标/fieldOps 分叉 | ✅ 决策 4（共用比较助手） |
| Y-8 KB 尺寸 | ✅ <40KB 预算测试 |
| A-1/A-2/A-3/A-4/A-5/A-6 | ✅ 决策 2 |
| B-1..B-9 | ✅ 决策 3 |

### 7. L1 留位（下版）

config kbUrl＋启动/手动拉取（pin tag/commit 非 main）＋完整性校验（最小条目数/shrink-ratio/字段白名单）＋失败回退 L0＋来源可观测＋offline 开关——LiteLLM 四件套与其 2026-02 静默回退事故为教材。

## 不动面

0014 全部、语义档位物化（0014 d1/0015 mid）、copy-on-write、R1 spread 门控、统一保存、上限 32、effort 意图。
