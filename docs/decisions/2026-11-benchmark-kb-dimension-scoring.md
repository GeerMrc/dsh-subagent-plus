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
- **A-1 裁定：unknown 哨兵对 S/B/F 一律最后备选**（缺收录的新旗舰不会被推去接 test/qa；F 槽命中 unknown 时"未收录"标注可见）。**A-6：estimated 不参与 argmax/argmin 胜出，仅作 B 排序中位填充；全池皆 estimated 时降级允许胜出**（无人可胜出时的必要兜底——首版快照 text 源宕机时 webdev/agentic 锚条目正走此路径；运行时 estimated 以"coding 维缺失"重算，不读构建期标志）。
- 并列逐槽规则：**S/B 取清单前者、F 取清单后者**（与 0015 行为连续）；F 并列前置 FAST_HINT 破序。新不变量明示：**三族独立择优、同模型可现于多族、无跨族包含保证**（n=2 时 B 必与 S 或 F 撞槽——行为与 0015 同为撞槽但对象可随权重序翻转，defaults 头行提示）。
- 复合键：族分 → topTierRank → activeTierCount → descHint → 清单序；效力意图（top/mid/lowest 于所选模型自身梯子物化）不变；**KB 强但梯子档低者拿 S＋其自身最高档**（effort 是模型内旋钮非跨模型标度）。

### 3. L2 用户导入导出闭环

- **导出**（Team 区按钮；**形态已被 3a 修订**：schema 2、单一英文 prompt、candidates 全目录逐条）：JSON 调研包 {schema, candidates＋匹配状态, dimensions, prompt}；**范围＝宿主完整模型目录而非当前候选清单（Z8 修正，用户裁定 2026-11-14）**——评估语料是配置无关的持久资产：今天导入的全目录评分，未来任何时候把某模型加进候选清单即刻生效，零重复调研；上限随之 64→256。prompt **诱出分布位置判断**（"0-100 表达相对当前主流模型总体的位置：50≈主流中位、70≈前四分之一、90≈前 10%"——B-1 量纲裁定）＋内嵌输出 schema＋"依据公开基准与社区实测评分"指示；下载/剪贴板；仅含模型名无隐私。**节制面记录**：单次调研不追求"全社区所有最新模型"（数百模型的单次评分质量坍塌）——全社区动态性由 L0 内置快照＋L1 远端同步（下版）承担。
- **导入**（三层校验）：schema 层（0-100 边界＋条数≤64，schemastery）；导入器语义层（同 model 重复**拒**＋逐条即时反馈匹配结果〔命中/别名命中/未命中仍存〕＋全维度缺省拒＋asOf=调研执行日期默认当日可改、产出模型自报来源降级 note 不可核验）；运行时容错层（手编 yml 坏条目**逐条丢弃＋degraded warn 不 brick**——overrides 是辅助评分数据非路由结构；重复 last-wins＋warn）。
- 存储：`config.capabilityOverrides`（volatile 数组；**存原始字符串**、读取期渐进匹配；**键语义已被 3a 修订**：(provider, model) 对——generic 行跨 provider 生效，qualified 行限定单路由）；统一保存 → 既有 commit→rederive 链路即时生效。
- **优先级链（维度级）：L2 override > L0 KB > 0.5 填充 > 哨兵**（全缺触发）；换算＝**0-100 /100 线性映射、不重归一**（重归一会抹掉用户给的相对差）＋残余校准偏差声明（不同产出模型刻度漂移）＋UI 显示评分来源（内置快照日期/导入 asOf）。
- overrides UI：列表常驻匹配状态徽标（随候选增删实时重算）＋逐条删除＋清空（＝回 L0）。

### 3a. provider 路由感知与调研包硬化（Z10/Z11，2026-11-14 用户两轮裁定）

**原则**：能力＝模型内在属性（同模型多路由默认共享 generic 评分——容灾对/配额分摊正确且零重复劳动）；**provider 限定行**（override 带 provider）为逃生门——中转/量化/配额差异可对单路由单独评分并压过 generic；多供应商路由始终是候选清单一等公民。Z9 的"导出按模型折叠"被撤销（目录保真优先）。

- **两段式解析**：qualified 精确对趟 → generic 趟（层优先绝对压过数组顺序）；qualified 行整行替换（缺维度回落 KB，不回落 generic 行）；不外溢其他 provider 路由。
- **导入合并语义（修订 B-3）**：真实调研回传实证评估器无视"一行一模型"契约仍重复输出——重复行按 (归一 provider, canonical model) 对**自动合并 last-wins**＋反馈明示，不再整包拒；generic 与 qualified 行并存；重导入替换 generic 行、**保留手编 qualified 行**。
- **单一英文 prompt（语言决策证据）**：judge 语言偏置（arXiv:2505.12201, EMNLP 2025）＋指令遵循随远离英语衰减（M-IFEval/CIF-Bench/MaXIFE）＋Qwen3 英文提示下偶发中文泄漏；中文模型英文结构化提示无系统性降质——prompt_zh/prompt_en 折叠为单一 canonical 英文 prompt。输出契约硬化：恰好 N 对象（计数写死）＋清单顺序＋自包含（禁 same as above/同上/ditto）＋note ≤120 字符纯文本禁引用标记＋完成前自检（计数约束是文献公认最脆弱类，故导入合并为程序侧兜底）。schema bump 2。
- **匹配收敛**：matchOverrideRoute 单一谓词（candidate > kb > none > route-miss）统一导入反馈/列表徽章/导出标注三处；qualified 行对完整目录精确对匹配，未命中＝route-miss 徽章（拼错 provider 可见）。
- copyConfig 对 capabilityOverrides 行级深拷贝（Za：删除 splice 共享引用致永不落盘的既有 bug）。
- **S 轮交付审计修复（2026-11-14）**：spread 转录通知链按 ADR 0010 M6 补实现（R-1）；pinned 默认休眠提示（R-2）；B 槽 unknown known-池中位（A-1 三槽完整）；未收录行级标注（Y-2）；五区徽标兑现（决策 4 完成）；导出包形态识别回退（Y-4）；advisory 非阻塞层（Y-5）；claimed 健康检查（Y-6）；estimated 披露＋prompt 接地/校准条款（Y-7）。**多阶段调研协议婉拒**：同模型自审＝伪独立、显著增加破坏 JSON-only 约束风险、真实回传已合规——以两条单阶段条款（benchmark recall + anti-compression）替代。
- **围栏子句（2026-11-17 修订）**：输出契约增补"整个 JSON 数组包在单个 ```json 围栏内、围栏外无任何内容"——三真实会话取证：模型对包裹格式不稳定（同提示词两次裸 JSON→DSH 渲染纯文本无复制键、一次围栏→代码卡片可一键复制；DeepSeek 网页端有 JSON 自动高亮兜底故恒正常）；DSH 渲染器严格按 markdown，无围栏即无代码卡。围栏＝渲染/复制确定性，非内容契约变化（内容三次均合规）；导入端 J1/J2 已兼容围栏，双保险。
- **徽标占位统一（2026-11-17 Q）**：评分来源行的命中徽标缩为统一短 chip（候选命中/知识库命中/未命中/路由未命中），完整语义移入悬停 title（新增 4 个 *Title 键）——原"未命中（仍将存储，按模型 id 参与匹配）"等长文撑破行栅格。实现期自伤两例被语言守卫当场拦下：双语同值的 placeholder 被去重逻辑误删、恢复时误插键名形态——守卫即防线。
- **可见交叉验证（2026-11-17 R3，会话 fb461bc8 取证精化）**：R2 双源子句遵循最弱（8 行 note 仅 1 个 single-source 标记；抽检 note 实际单源未标）——根因＝**成功不留痕的不对称验证**（两源达标无输出痕迹、仅失败才标）＋"each score"粒度过重被静默 economize。R3 三点联动：①印证粒度放宽为**每模型 ≥2 独立来源**（可达成的诚实标准）；②**每行 note 强制尾缀 (2src)/(1src)**（达标与未达标都留痕、逐行可审计——与围栏子句同设计哲学：可见的强制包装）；③终检扩展（数对象数＋每行 note 都带来源标记）。如实上限：标记使声称可审计、不机械证明双核已做——硬保证待 L1 远端同步（社区维护评审快照）。
- **过程纪律三子句（2026-11-17 R2）**：①搜索义务**能力条件化**（有工具＝必须逐模型先搜后评，无工具＝自知评分＋note 标 `(no-search)`）——会话取证显示"搜不搜"逐次漂移且与同模型 74-75 vs 62-64 的分差直接相关；②**双源印证**（≥2 独立可信来源；单源标 `(single-source)`）——把可信交叉验证落成可见标记而非空话；③**逐模型流程**（按清单序：取证→冲突裁决→评分→note，全部完成才输出）。刻意不加：指定网站清单（机械照抄且易失效）、固定分数锚点表（引入偏置）、过程表演指令（耗 token 不增质）。跨次分数方差为 LLM 评分固有属性——子句收敛行为路径不消灭方差，UI 校准提示仍为正确预期管理。
- **归类声明**：prompt 是**导出数据**（调研任务产物），非插件 UI 文案——不属 locale 字典管辖（locale 纪律只约束产品界面文字）；其语言选择属数据格式决策（上文证据）。
- **合并反馈**：导入 flash 文案携带合并计数（已导入 N 行·自动合并 M 行重复）；重导入遇同对 qualified 行＝草稿感知 last-wins（新行替换旧行、计入合并反馈），不产生 save-blocking 的 repeats 状态。

### 3b. F 轮：模型 id 解析全面加固（2026-11-14 用户实测审计裁定）

**触发**：用户加入第三候选 `deepseek-flash`（官方目录显示名 DeepSeek-V4.1-Flash）后 Team 表无重派。269 条真实世界 id 实证审计＋两路桥接源调研：**"灾难"不成立于全 unknown 形态**（列表序回退 12 行契约锁定、不崩溃不空表），**成立于混合列表静默零分配**——1 个已收录候选占满全部行、未收录候选 0 行且运行时零告警。官方裸 id 命中率 80%（deepseek-flash 世代中缀缺口＝用户案例）、用户目录 62.5%、社区形态 68%。

- **d1 别名层（capability-scoring）**：`OFFICIAL_ID_STEMS` 人工核心表先于直查（`deepseek-flash→deepseek-v4.1-flash`、`k3→kimi-k3`；官方目录显示名与存储 id 分裂是匹配层隐形输入）；**版本分隔符归一** `(?<!\d)(\d)-(\d)(?![\w.])→点`（3-5≡3.5；lookaround 防 `4-32k`/`2-72b` 腐蚀与 `llama-3-8b`≠3.8）；**上下文后缀剥离** `\d+[km]`（k3-256k→k3；参数量 b 不剥——属官方 id）；**保守级联** curated→直查→全部逐层 strip-exact→变体扇出最长词干优先；**单 token 守卫**——裸厂牌永不扇出（首稿"逐层扇出"会把 deepseek 桥到 15 个族键，被独立审核否决）；KB 查找走规范化索引（WeakMap 缓存、构建期免迁移、键碰撞按最弱信号合并）。**运行期 vendor 折叠判死**：`deepseek/deepseek-r1` 官方连字符 vs `qwen/qwen-2.5-x` 官方缩并——同形输入相反正确输出，运行期不可判定；该 per-vendor 表即别名表→移交构建期（F4）。
- **d2 可见性契约（兜住全部 inherent 类）**：`kbStatusOf` 三态单谓词（anchored/known/unknown，override 救援感知）统一驱动——候选行"未收录"徽章（title 三态说明）、defaultsHint 下"{n} 个候选未收录"汇总行、estimatedAll 互斥（含 unknown 的清单不再宣称全 estimated）、行选 title/option 标注；**运行时 one-time-per-unknown-set warn**（混合列表排除候选时记录一次，全 unknown 不警告——回退是契约非缺陷）；导入 override 立即翻盘保留。
- **d3 槽位多样性**：B 中位撞 S 时从中位向两侧外步进取最近不同模型（等距取强侧）；**承诺仅当该槽自己的池含 ≥3 不同 canonical 模型**（2 候选/重复挂载维持撞位）；F 在去重池上重跑完整 reduce——**可互换判据＝canonical+S 族分+fast hint**（provider 限定行刻意分化的同模型双路由均存活，Zb 回归现场修复）；池归属：B 含 estimated（A-6 只辖 S/F），S/F 限定 anchored-else-known 不变。
- **F4 构建期 OR 交叉（修订 Y-5：别名入库、分数仍不入库）**：`--aliases-only` 免源重建合并别名（dims/键/KB_AS_OF/KB_SOURCES 字节保真——text 源中断期重建会丢已提交 coding 锚，故禁止全量重建路径）；匹配激进（全分隔符 squish＋碰撞 fail-loud 警告）桥接保守（运行期 canonicalize 已折叠的 slug 不加别名；**别名行只桥接精确查询、永不参与变体扇出**——独立复查 🟡#1：qwen/qwen-2.5-72b 不得经 strip→qwen-2.5 扇出吸收 coder-32B 别名的分数，扇出只看 KB 自有键）；`~` 路由器 alias_target 与描述反引号裸 id 仅打印为 curated 候选供人工审，绝不自动入表。当前 228 条 KB 上诚实上限＝2 对（qwen/qwen-2.5-coder-32b-instruct→缩并官方键、upstage/solar-pro4）。
- **验证**：用户真实场景纯函数钉子（三候选→review 族翻 deepseek-official/deepseek-flash max 档、三模型各占一席）＋装机终审五步。

### 3c. G 轮：槽位占用链＋S 噪声带＋三层接管链＋同模型多入口分摊（2026-11-15 用户实测裁定）

**触发**：候选 [Flash-Next/27B/V4-Pro] 仅两模型占行（Flash-Next 0 行，27B 独占 8 行）；换 V4.1-Flash 则正常——分布取决于分数布局巧合。社区依据：LLM 网关 load-balance（同模型多 deployment 轮询）＋fallback-chain 为 HA 基线；调度器"软拓扑打散"（prefer distinct, never hard-fail）对应 ≥3 distinct 门。

- **占用链完备性原则**：槽位按选取顺序（S→B→F）必须感知全部前序占用者。F3 只修了 B 撞 S，F 撞 B 无人管即出货——用户"撞运气"体感属实。
- **G1 F 占用让位**：严格 argmin 的 canonical 撞 S/B 且去重池 ≥3 distinct → F 取未占用条目中最弱 S（同比较链）；门内未占用集恒非空。边界：Z10 降级重复红利仅存 2 canonical；≥3 时占用多样性胜出（降级副本 0 行）。
- **G2 S 噪声带（用户裁定）**：`NOISE_BAND=0.02`（同快照 estimated 条目间 rank-fraction 噪声量级）——S argmax 内非零亚带分差→清单顺序优先（带内跳过 legacyDiff）；**精确平局保留 Z7 结构链**（真平局非噪声）；带外严格。**不扩展到 B/F**（其碰撞逻辑消费严格分——独立审核 R-1 裁定）。非传递性（2×带内分布）为有意语义，钉子测试披露。客户端预览与宿主目录偏差由此更敏感（efforts/description 影响结构链），声明。
- **G3 三层接管链**：行路由不健康/未注册 → 下一健康候选（selectChildRoute over usableCandidates，仅 spread plan，镜像策略链分支）→ 兜底 → 各分支终末语义逐字保留。接管路由 memoize（冷却期单值，防轮询游标漂移；自身不健康即清；**每次新接管事件消耗一次共享轮询游标**——与真实 spread 指派共用选择池，接管本身即一次指派，声明为有意）；**接管路由失败计入冷却**（recordFailure 原只解析行/策略/pin/兜底 provider 的 model——中间层会持续服务于已死路由的缺口，测试现场抓出）；接管转录通知（byNameTakeoverNotice）＋兜底交接通知激活（byNameFallbackNotice 原为死导入）。兜底模型保留：终末级、可在清单外——与候选清单是互补三层而非重叠。设置页候选行下方 bench 提示行（badge-logic benchRouteLabelsOf）。
- **G4 同模型多入口行级分摊（用户补充范围）**：可互换兄弟（F3 去重键复用：canonical＋S 分＋fast hint）＝同一模型的部署副本（LiteLLM deployment 模式）——族内行轮转分摊（双入口 6+6/12、三入口 4/4/4；每行按各自路由档位表物化）；**槽位胜者领头并取奇数行**（Z7 结构链优先于清单序——list-order 轮转破坏 Z7 测试现场裁出）；余兄弟按清单序。qualified 分化路由不拆分（Z10 逃生门）。创建期 per-request 轮转否决（破坏 byName 确定性承诺）。HA 闭环：入口冷却 → 其行经 G3 中间层 → **健康同模兄弟为第一接管者** → 其余候选 → 兜底。
- **验证**：D13（场景 B 确定性三模型各占）/D14（链式接管分支持久化）/D15（双入口等权＋冷却兄弟接管）。

### 3d. H 轮：2 候选覆盖契约＋全排列不变量＋双消费先序（2026-11-15 用户实测裁定）

**触发**：[1.HH·27B, 2.ST·Flash-Next] 全 12 行落 27B、换序即正常——G2 回归：带内分差 .0105 令首列拿 S，2 候选 B 中位同模型，**≥3 门把最常见的 2 候选配置排除在多样性承诺外**（F3/G1"2 候选维持撞位"钉子）。场景 2（27B+V4-Pro 6/6）为噪声带裁定的既定后果，用户经"清单序 vs 策略分歧"疑虑澄清后裁定**保留噪声带**。

- **覆盖契约（H1）**：B-walk 门与 F 占用门 **≥3→≥2 distinct canonical**——含 ≥2 不同模型即每个至少占一族；恰 2 个时 F 允许撞位（鸽洞，S/B 已覆盖两模型）；同模型双入口非覆盖对象（G4 分摊不变）；unknown 不承担覆盖义务（A-1 不变；Zb 红利在第三候选 unknown 时存活——实证复核）。两个撞位钉子由用户报告反裁定撤销。
- **门边界教训（dont-do）**：多样性门的边界必须从最高频用户配置（2 候选）倒推，不能从实现方便（≥3 有鸽洞优雅性）倒推——三轮后才被实测暴露。
- **全排列不变量（H2）**：coverage matrix spec——2-5 候选全排列×三池（shipped KB/双入口/全 unknown），不变量"占行不同模型数 ≡ min(3, D)"＋确定性＋行必引用清单路由；回退门值即红（含用户报告排列）。此套件在提交时即可拦截 F/G/H 三轮全部报告形态。
- **双消费先序（H3，用户疑虑收口）**：同一清单、两个消费方、先序无冲突——显式指定（respectExplicit）> Team 关键词行（物化意图档位）> 钉定 > 策略链（轮询/随机/优先级，无行档位）；带只影响 Team 派生的把关族归属，不触碰策略链；G3 接管消耗一次共享游标（已声明）不扰动普通子。组合配置钉子测试。
- **噪声带可见性（H4）**：Top-2 已知 S 分差落带内时设置页提示"评分接近（分差 .xxxx<0.02）：把关族按清单顺序归属，调整排序即可切换"（sBandGapOf 纯助手；NOISE_BAND 导出）——结果就地解释，不再读成 bug。
- **H7 复审反例修正（覆盖跨 A-6 池）**：独立复审以实测证伪"覆盖普遍成立"——1 锚定＋2 估计的混合在**所有排序**下第三模型 0 行（150/150 排列扫中）A-6 使 S/F 池锚定独占，单锚定池无法覆盖三模型。裁定：**F 的覆盖让位可跨入 known 集**（估计模型落 F 是兜底放置而非质量胜出；S 永远锚定严格——A-6 精确化为"管辖 S/F 池胜出"，不辖覆盖放置）；原 F3 钉子由反例撤销。噪声带提示同步池感知（仅锚定间/仅 known 间计 gap——对估计亚军承诺"调序可换"是假话，静默）；矩阵增锚定混合池。text 源恢复后锚定混合将成为常态，此修正先行落地。
- **KB text 源探测（2026-11-15）**：rows 端点仍报 "Job has been terminated due to a temporary spike"（3 次重试同错；webdev 672 行/agent 59 行健康）——全量重建无法恢复 coding 锚，债务留存；源恢复后重建将自然消解 .01 级分差病理（噪声带存在根因）。
- **债务闭环（2026-11-23，PH1）**：text 源 2026-11-17 恢复、稳定 5+ 天后执行全量重建——**as_of 2026-11-22，497 条**（原 228），coding 锚 65→**447**、overall 0→**408**、estimated 163→**50**；文本端点全量分页需限速（实测 ~2 req/s，页间 1500ms＋429 专用 20s 退避）；发射器别名瘦身（canonical 等于键的别名不落盘，零行为差）保 40KB 预算（51550→39686B）；快照钉子测试随新锚更新（场景 B 三模型全锚定后严格分序、噪声带对该组失效、gpt-5-medium 反超 gpt-5 (high) 等如实钉住）；OFFICIAL_ID_STEMS 两行均仍需（deepseek-flash/k3 未被新快照吸收）。
- **根因定性修正（2026-11-16，I 轮）**：/parquet 端点证实 **text config 的 config-parquet 转换任务在上游 FAILED**（failed 列表明列 text；其余 config 的 parquet 正常）——rows 的 "temporary spike" 措辞是症状不是根因，真实故障在上游转换管线，故自 2026-11-11 持续且**客户端无任何旁路**（rows 与 parquet 双断）。构建脚本已升级：text 源为空时自动追查 /parquet 并在日志报告根因；另设每日自动守望（工作区级，恢复即报，届时手动全量重建）。

### 3e. I 轮：设置页交互一致性＋KB 债务根因定性与守望（2026-11-16 用户裁定）

- **Team ⓘ 吸收模型态提示（I1）**："全缺 coding 主锚"与"噪声带分差"两行从正文迁入标题 ⓘ 动态合成（基础说明＋条件两条，'；' 连接——宿主 Tooltip 换行不保证）；kbUnknownSummary/benchHint 维持正文（配置状态行，未点名迁移）。
- **候选行操作锚序号（I2）**：IndexActionsCell（序号 chip 触发＋上移/下移/删除，边界无死按钮）取代锚在模型名上的 RowNameCell——候选清单与 Team 行对齐 ADR 0015 d3 的"删除/操作锚首列"约定；名称降纯单行（完整 id 入 title）；RowNameCell 与 nameTriggerStyle 随之删除。
- **J1 一键粘贴围栏容错（2026-11-16 用户真实回传取证）**：评估器输出以 ```json 围栏包裹，导入端裸 JSON.parse 误报——parseResearchPaste 纯函数剥围栏/识别整包/拒绝无效；真实回传 10/10 契约通过（S 轮硬化条款全部兑现，提示词无需再加强）。教训复刻：上轮"已容忍围栏"断言未经验证即写入汇报——引用既有行为必须 grep 证实现码。
- **J2 网页端回传容错（2026-11-16）**：评估器在网页聊天执行时的畸形形态（散文包裹/尾逗号/数值字符串/白名单解包/多块取末/截断专报）全部收口——候选链解析（原文→围栏块末→首末括号跨段）＋尾逗号清理＋有界强转；内容级刻意不猜（模型名不纠错，走既有可见反馈）。导入为整批全有或全无，畸形只产生逐条理由。
- **KB 债务（I3）**：见 3d 根因定性修正（config-parquet 上游 FAILED）；构建脚本 text 空源自动诊断＋工作区每日守望自动化（恢复即报→手动全量重建）。剩余债登记：L1 远端同步（下版）、DOM 渲染测试（UI 交互依赖人工 e2e D 系）；『G-2/3/8/9/11』条目已撤销——系早期会话沿用的编号，仓库内无定义出处、内容不可核实（登记表禁止无定义条目）；合并/发布前的独立发布前审计将重新生成带定义的编号清单。

### 3f. L 轮：locale 语言错位修复＋全字典守卫＋评分来源折叠化（2026-11-16 用户截图裁定）

- **locale 误写根因**：裸键名正则（count=1）的"en 替换"命中首个（zh）字典行——zh `clear/cleared` 被写成英文、en 留旧值；键 parity 测试测不出语言错位。修复＝值锚定替换（锚现值断言唯一）；**全字典语言守卫**（zh 每值含汉字，白名单仅双语 JSON 示例；en 每值无汉字）为机械防线。
- **评分来源折叠化**（用户排版一致性裁定）：旧块整块出现/消失＋堆叠 div＋悬浮 ×，与全页行栅格语言不符——重构为高级折叠同款（全宽 foldButton 头＋状态 chip（内置快照/N 条评估）＋旋转 chevron＋bordered 内容区）；默认收起、**导入成功自动展开**（导出回退路径不展开）；行＝listRowStyle 扩 5 轨（序号/模型/分数＋日期/匹配徽标/×）。**pinned 下折叠头照常渲染**（清空/删除为草稿层操作；隐藏会搁浅 Team 徽标——其脏判定含 capabilityOverrides）；折叠头不挂徽标（五区枚举不变）；单删除直接 × 按钮（RemoveMenu 为多动作而设）。
- **命名统一**：全仓「评估来源」→「评分来源」（与 UI 键一致）。

### 3g. M 轮：评分来源入列标题行（2026-11-16 用户实测裁定，取代 3f 折叠头方案）

- **3f 整宽折叠头被实测否决**：即便收起也把 12 行 Team 表下移——改为**标题行第 4 钮**（恢复默认/导出/导入之后，仅有评估或面板开着时渲染）＋同槽面板（与导入面板互斥，导入成功自动交换展开）。**搁浅态机**（独立计划复审 🔴）：按钮渲染条件 `sourceOpen || overrides>0`——清空/删末行/空数组导入把计数归零后面板仍可关（否则唯一开关消失成死面板）。
- **静态紧凑按钮**（用户裁定；悬停展开否决——布局抖动/触屏不可用/与本页静态语言不一致）；**动作簇 flexWrap**——EN 四钮实测超内宽，优雅落第二行而非裁切。pinned 下本钮照常渲染（3f 搁浅徽标裁定延续）。
- **N 轮终裁（用户裁定，取代两行式提案）**：M6 压缩后在 <~575px 面板仍两行（截图边界推断：L 轮 3 钮 ~530px 放得下、M 轮 4 钮 ~606px 换行、M6 ~575-590 仍换行 ⇒ 面板内宽 ~540-560）——**标题「Team（角色关键词 → 路由）」→「Team」**释放 ~160px（稳态 ~415px/闪现最坏 ~431px 从容单行）；完整语义由 ⓘ 悬停承载（双语 help 原文已含关键词→路由说明，零损失）；语言守卫白名单 +byname.title（双语同形拉丁产品名）；文档中特性描述性长名保留。
- **M6 单行收口（用户实测两行反馈）**：zh 面板宽下「待保存＋四钮」仍溢出——导出调研任务→**导出调研**（title 保留完整语义）、合并闪现文案紧凑化（已导入 {n}·合并 {m}——闪现期按钮曾膨胀 ~190px 强制换行）、四钮水平内边距 10→8px；flexWrap 保留为更窄窗口的优雅底线。
- 面板间距与导入面板逐值一致（gap 6＋borderTop 恢复）；sourceBundled 键退役（空态＝按钮缺席＋提示行）；sourceEmpty 移提示块。
- **重派生链入档（用户审核确认项）**：默认映射＋spread 下——导入应用即预览重派（#patch 每编辑重算 effectiveNameMap）；保存提交→settings/document-updated→onCommit→rederive 运行时全表重评；自定义行静态（设计如此）；运行中子代理下一步边界换路（ADR 0010）。

### 3h. O 轮：评分来源面板五项细节（2026-11-17 用户实测裁定）

- **O1 面板标题去重**：面板内左侧「评分来源」删除——标题行开关钮即面板身份；导入面板标题保留（唯一操作说明文案，非重复，独立复审明确不归一）。
- **O2 开关激活态**：`.dsmp-open` 类（bg-layer-4 底＋business 边框/文字，零新 token）＋**!important**——复审以真实 Chromium 实证：钮内联 background/border/color 三件套（resetButtonStyle→inputStyle）压掉普通类，激活态写了不渲染（`.dsmp-invalid` 先例）；该内联三件套同时也早已压掉这些钮的 hover 填充（resetButtonStyle 采用起即然，非本轮引入）。aria-expanded 为 disclosure 正确语义；代码路径无闪现/激活共存（导入成功即关面板），用户在 ≤2s 闪现期内重开面板则瞬时以闪现类优先、自我纠正。
- **O3 短标签**：清除钮 zh「一键清除」/en「Clear」（完整语义留 title）——**取代 K 轮长标签决定**（可发现性由全尺寸钮＋title 承载；K 轮 CHANGELOG 条目留史）；引用同步 settings.md:70＋e2e D8（sourceEmpty/D17 经复核不引用该标签，不在清单）。
- **O4 评估日期去重**：sharedAsOfOf（全行同日期→底部动作行左侧「评估日期：{date}」单显；混合/空→undefined 逐行回退）——混合日期为设计内常见路径（重导入保留限定行）；行内纯分数。
- **O5 标签行统一**：fieldLabelRowStyle（＝分配策略/兜底现状提取：row+center+wrap）＋标签簇（label[+Info][+badge] nowrap）；添加模型/添加映射补齐簇化与 wrap（不发明帮助文案）；高级折叠内部行（advancedTitleStyle 层级）不归一。

### 3i. P 轮：垂直节奏两档规范（2026-11-17 用户实测裁定，全量审计驱动）

**审计修正直觉**：添加模型行其实正确（顶层）；可见不对称全部源自 byname 块内嵌套——添加映射行携区块档（双倍 12px＋块内杂散发丝线，上 24px/下 44px 不对称）、两面板同携区块档、statusTextStyle 漏 margin:0、块内 gap 6 vs 兄弟区 8。

**两档规范**（先例＝advancedRowStyle 注释"区块内无分隔线"）：

| 档 | 样式 | 适用 |
|---|---|---|
| 区块档 | fieldRowStyle/fieldLabelRowStyle（12px 0＋发丝线） | 仅卡级分区间隔行：添加模型/分配策略/Team 块/兜底/高级折叠头 |
| 行内档 | inlineLabelRowStyle/面板基座（8px 0、无边框） | 区块内部一切行：添加映射、导入/评分面板、高级区内行 |
| 列表档 | listRowStyle 6px | 候选/映射/评估行（悬停区节奏，不动） |

- 面板无边框裁定：开态已由 .dsmp-open 承担（发丝线冗余）；面板替换的提示行从不带线；advanced-fold 先例。
- statusTextStyle 补 margin:0；byname 块内 gap 6→8（一条节奏规则）；**面板内部 gap 6 为有意的子单元密度**（与列表档同拍，复审钉明——非漏改）。
- **刻意不动**：列表行 6px、limits 行零内边距（网格 rowGap 8 覆盖）、28px limits→路由接缝、高级折叠页级位置（布局决策另行立项）。

### 3j. PH 轮：发布前加固（2026-11-23，对照姊妹插件 P1-P6 模式审计）

- **PH2 插件页文档分离（P2）**：locale/zh.json＋en.json（meta.detail → docs/plugin-page.{zh,en}.md 用户向双语文档，含"插件页开关＝唯一关闭入口"）；package.json exports/files 增 locale；README 双语顶部分工注记；契约测试锁 P2 路径规则＋存在性＋清单。
- **P1 kind 命名空间化（PH3）**：注入行 `source.kind` 由官方 `'model-selection'` 改为 `'dsh-subagent-plus/model-selection'`——原值属 harness 核心 producer（插件注入被归因于官方）；rc.5 起 custom kind 一等渲染。**落地方式＝MessageSourceMap 声明合并**（映射自带文档"merge-extensible sum type…each producer declares its own kind"，即本仓既有惯例），零 cast；直接改字串会被 dsh-llm 闭联合拒绝（977e5b6 曾提交坏 tsc，9d9eb3a 修正）。
- **PH1 KB 全量重建**：见 3d 债务闭环条目（497 条/锚 447/overall 408）。
- **PH6 发布守卫与 P6 对齐**：①`private: true` 回归（发布提交同批移除＋契约绊线测试同步移除——姊妹插件 runbook 阶段 B 纪律）；②**release-preflight**（纯函数＋薄 CLI）插入 release.yml **建 Release 之前**：tag↔版本一致、非 private、该版本未在 npm——误打 tag 在产生任何副作用前被拒（此前要到 `npm publish` 步才失败，而 Release/已建）；注册表不可读时**fail-closed**；CLI 端到端对真实树与真实注册表验证（private 树推 v0.0.4 → 拒；已发布 0.0.3 → 拒；干净 0.0.4 → 放行）；③旧宿主（无 agent.model）静默无路由 → 一次性 warn（P6 warn-only 补口）；④wall-clock 敏感测试（280ms 对 200ms 去抖仅 80ms 余量）改 vi.waitFor 轮询。
- **P7 files 白名单（2026-11-23，用户对照姊妹插件 patterns.md P7 复查发现）**：PH2 落地时 `"files": ["docs"]` 整目录入包——meta.detail 硬错未踩（plugin-page 文档确实进包）但**触犯 P7 头号禁忌**：16 份 ADR＋dont-do/e2e-manual/release-runbook（含 private/绊线操作细节）/upstream-feedback 草稿全部泄漏进公开 npm 包（tarball 实证，219KB）。修复＝**逐文件白名单**（plugin-page×2＋settings/strategy/upgrade——README 链接的产品手册保持可达；治理文档移出，包降至 151KB）；契约测试补齐 P7 事故根因的两半：静态（detail 目标须精确列于 files＋禁裸 `docs` 目录项＋白名单任何条目不得触及治理文档——模拟 npm 目录递归语义）＋ **tarball 内容物断言进 release.yml**（npm pack 后、建 Release 前：五个目标文件必须在包内、治理文档必须不在）。装机 docs/ 同步为包同款文件集。

- **whileServed 偏差（P6 无条件注册纪律）＝接受并记录**：settings.section 包裹在 `configForms.whileServed([NS])` 中，与 P6"无条件注册"相左。保留理由：本插件的设置卡**吸收了官方运行限制命名空间**（接管面，ADR 0003）——插件自身 ns 故障时若仍渲染整卡，已隐藏的官方页面数据将以 unavailable/陈旧态露出，违反接管语义；徽章位（conversation.input.right）**无条件注册**（不受影响）；逃生口始终存在（插件页开关＝唯一关闭入口；用户层 `disabled: false` patch）。官方面控制器自带 per-namespace T7 降级（ns 停止服务仅翻 unavailable 行，不闪回官方页）。

- **PH4 死代码清零**：①三个孤儿通知函数接入 pre-step（docs 早已承诺而运行时从未发出）——`pinFallbackNotice`（钉定子智能体落到兜底）、`pinSkippedNotice`／`byNameSkippedNotice`（路由未注册且无接管/兜底、仍运行并预期响亮失败）；②删除 `pinnedRoute`／`PinOverride` 遗留面（ADR 0010 已由 agent.model.select 取代，零运行时调用方）。**实现教训**：未注册判定必须在通知点**现查**（`routeRegistered` 对已注册路由走缓存）——首版用插件生命周期级 Set 记"未注册"且永不清理，路由恢复注册后会持续误报"跳过"；同一次接线还留了两处不可达子分支，均已在提交前拆除。

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
