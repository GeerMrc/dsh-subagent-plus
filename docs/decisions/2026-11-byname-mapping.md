# 0006 — 按名映射（队友名 → 路由）

日期：2026-11-10 ｜ 状态：用户三项拍板（2026-11-06~10）冻结，随 v0.0.4 实现 ｜ 关联：[0005](2026-10-30-binary-takeover.md)（二元接管）、R5 调研报告 07（/Volumes/IPFSJK/Zcode/temp/dsh-super-agent-analysis/reports/07-team-model-allocation-and-byname-design.md）

## 背景

官方 Team 的 `spawn_teammate` 无模型参数，队友一律继承 Lead 路由（R5 报告 07 §2）；本插件 v0.0.3 对 depth≥1 子代按单一策略统一改写——角色与模型无法精准匹配（用户 Iphone-Duo 实测痛点）。同类工具（Claude Code `model:` 字段、Codex TOML、ZCode frontmatter）均提供按名指定模型且默认继承。

## 决策

1. **独立槽位，不约束于候选清单**：新增顶层字段 `nameMap: [{ name, provider, model, reasoningEffort? }]`（volatile，上限 16 条，对齐官方 `DEFAULT_MAX_MEMBERS = 16`〔harness agent-team/src/index.ts:41；桌面 profile 覆写 8 属 profile 层收紧〕）。路由选择器数据源＝宿主模型目录（与候选清单同源），允许填清单之外的模型。与候选清单交集合法：命中者固定用该路由，未命中者按策略可能轮到同一路由，互不干扰——不违背 ADR 0005 的"候选清单为 spread 策略唯一来源"（映射属强制指派族，非 spread 池）。**匹配为进程级、跨 Team**：同名多 Team 各自命中同一行；死名（无存活队友匹配）永不匹配即休眠，不自动清理（跨 Team 同名与名字不可重用对映射表生命周期的影响，R5 报告 07 §6.9 指派本轮定案）。**未知名不告警**（对报告 07 §5.3"未命中告警"建议的刻意偏离：队友名存在性只有运行时才可知，"未命中"本身就是显式休眠态，告警只会制造噪声）。
2. **解析链（唯一、写死并写入文档）**：**按名命中 ＞ 策略（钉定或 spread 含 respectExplicit）＞ 兜底**。命中＝强制指派族（同钉定：不读 respectExplicit、无视成员手动选择）；未命中＝现行链逐字节不变。对 Claude Code（调用参数＞文件）与 Codex（文件＞调用参数）解析序相反的教训（R5 报告 07 §4），本插件单链明示、不做多层覆盖。
3. **无总开关、不进高级折叠区**：沿用 ADR 0005 二元哲学（软开关制造第三态，R7 教训）。映射表并入现有合并卡作为新子区（位置：候选清单区之后、兜底行之前）；**空表＝功能休眠（升级用户零行为变化）；删行即关闭**。刻意不做：清空全部按钮（全插件无 clear-all 先例）、行排序（映射无序语义）、per-call 覆盖槽、FORCE 型全局开关。
4. **健康与降级**：映射路由与候选/兜底共享同一张 RouteHealth 冷却表（同路由冷却两边同感）。**`agent/request-error` 的记账两门（`routed` 门与 provider 归因门）同步纳入 nameMap 路由**——否则清单外映射路由（本决策主打场景）失败永不入账，冷却承诺空转；provider 级粘性失败连带冷却同 provider 的全部映射行。命中路由冷却时镜像钉定行为（**pinFallback 暂避手法**：冷却/未注册暂避兜底、恢复即回映射路由；不引入 spread 的 failoverIfCooling 候选重选——按名无候选集）；兜底不可用则保持映射路由；路由未注册→failOpen warn（**按路由一次性**，镜像 unregisteredPinWarned）＋交兜底。
5. **agentTeams 可选消费**：守卫式 `ctx.get('agentTeams')`＋undefined 分支（J-3 定论：禁止 plugin 级硬 inject、禁止裸属性访问；**类型面照 SessionLike 先例做本地结构视图**（`tryMembership(agent): { name?: string } | undefined`），禁 any）。未装 Team 的 profile：映射功能休眠＋进程级一次性 warn latch；名字源＝`tryMembership(agent)?.name`。agentTeams 属 experimental pre-stable：上游破坏时同样静默休眠并 warn，行为文档化。
6. **粘住语义**：按名决策一经 memo **终身粘住（spread 语义）**——映射表变更（删行/改行）只影响**新决策点**，已决策子代不动；钉定路由编辑的"即时生效"不适用于按名（README 已知行为明示）。**fork 队友不被按名改写**：按名不越过 fork 排除（`pinForkChildren` 性能不变量——KV-cache 复用护栏，非路由偏好）；命中名落在 fork 排除子代时**一次性 warn**（文案含"开启 pinForkChildren 可启用"出路），不静默放过。
7. **校验（structural 拒载 / 即时提示二分）**：structural——表内重名、路由半填（provider/model 缺一）、名字格式非法（非 `^[a-z0-9]+(-[a-z0-9]+)*$`、超 64 字符、保留字 `lead`——非法格式永不匹配真实队友名，配置无意义故拒载）；即时红框＝同名行/非法名字在输入时以 `dsmp-invalid` 标红，保存被阻止时 `invalidStyle` 红字点名行号。
8. **notice**：`[按名指派 <name> → <provider>/<model>·<档位> ｜ assigned by name: …]` 双语单行；**无档位时省略"·<档位>"段**；去重沿用现有 WeakMap/决策内 Set 机制；受现有 `showNotice` 总开关管辖（关闭时完全不注入）。
9. **RISK-H1 追踪条款**：upstream 0.2.2+ 收紧 `agent/request` 契约将影响本功能载体通道（与 v0.0.3 同源风险，非本轮引入）；升级宿主前按 dont-do「npm 认证与删除」外的宿主升级三步流程实测，迁移路径＝官方正典 `agent.model.select()`（届时新 ADR）。

## UI 一致性（决策 3 落地规范）

新子区严格复用现有构件（复用清单存 `.zcode/v0.0.4/`，要点）：子区标题照 LimitsBlock 先例（h4＋`Info` 悬停）；行＝`indexChipStyle` 序号＋名字输入（`inputStyle`/`dsmp-input`）＋provider/model 原生 select（`routeSelectStyle`/`dsmp-select`）＋`EffortSelect`＋名称 Popover 删除（仅 remove 项）；空态 `hintStyle` 灰字；上限置灰；"＋ 添加映射"＝`foldButtonStyle` 基文字按钮。**不新增 CSS 文件**；新样式常量只进 settings-styles.ts；颜色全走 `--dsw-alias-*` token；locale 键组 `byname.*`（zh/en 双语，漏键编译报错）。

## 影响

- 配置面：新顶层 volatile 字段（自动进 fieldOps diff 与统一保存链）；设置页新子区；不触碰官方 limits 吸收面与守卫测试断言面。
- 行为面：仅"命中映射的子代"路由改变；Lead 与未命中子代零变化；fork 队友默认仍被放过（现行 `pinForkChildren` 语义不变——按名映射亦不越过 fork 排除，避免破坏 KV-cache 复用；文档明示）。
- 文档面：README 双语功能矩阵＋按名映射节＋已知行为；docs/settings.md、docs/strategy.md 解析链更新；CHANGELOG 0.0.4。
