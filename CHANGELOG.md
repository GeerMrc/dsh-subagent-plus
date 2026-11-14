# Changelog

## v0.0.4 (2026-11-11) — Team（角色关键词 → 路由）· agent.model.select() 架构 · 默认映射安装即生效（ADR 0006-0014，未发布）

- feat(team-map)!: **角色关键词子串匹配（ADR 0008）**：设置卡「Team（角色关键词 → 路由）」
  分区（≤32 行），队友名包含关键词即命中（最长优先）；未命中走策略链。
- feat(team-map)!: **agent.model.select() 架构迁移（ADR 0010）**：路由在子智能体创建时经
  官方 API 选定（0.2.2+ 正规通道），替代已禁用的 agent/request 瀑布改写。健康降级在步边界
  生效（宿主禁止步中换路）。异常封堵：创建监听器内任何错误降级不冒泡（防回滚子代理创建）。
- feat(team-map): **双源名字解析（ADR 0012）**：0.2.0 宿主 roster/tryMembership → 0.2.2+
  宿主 `subagents.namesOf`（含 UNAUTHORIZED 创建窗口吞错）；`agent/inbox/claimed`
  确定性挂钩补选（步准备捕获 selection 之前）。
- feat(defaults)!: **默认映射安装即生效（ADR 0011→0016）**：12 行跨领域映射由候选清单按**三维度
  基准评分**派生（内置 KB 快照：LMArena text/coding＋webdev＋agent 子集 CC-BY-4.0、Aider polyglot
  Apache-2.0；rank-fraction；缺段 0.5 中位不重归一；角色族独立权重三族独立排序；未收录＝三槽最后
  备选），候选增删改全表重评＋adapter 自愈，仅 spread 策略生效（R1 门控）；编辑即 copy-on-write
  物化为自定义＋「恢复默认」常驻单按钮（禁用态内联灰显）；`nameMapDefaults` 缺省按存量迁移
  （#sync 双侧同边界归一化）。**名称猜能力（"27B 压 flash"）被实证证伪并废弃**——
  deepseek-v4.1-flash（激活 8-16B）显著强于 Qwen3.8-27B（AA 40vs20/DeepSWE 77vs42），
  同族 Flash-Next(6B激活) 亦压过 27B 稠密。取代起步按钮形态。
- feat(evaluation)!: **能力评估导入导出闭环（ADR 0016 d3，L2）**：「导出调研任务」生成候选清单＋
  双语分布位置判断提示词的 JSON 包；「导入评估」三层校验（schema 0-100 边界＋条数≤64 / 导入器
  语义——重复拒＋逐条命中反馈＋全空拒＋asOf=调研执行日 / 运行时容错——手编坏行降级不 brick）；
  `capabilityOverrides` 维度级覆盖 KB（0-100 线性 /100）；导入行列表/逐条删除/清空回退；
  评分来源与快照日期页内可见。L1 远端自动同步留位下版（LiteLLM 模式四件套）。**Z10/Z11 修正（用户两轮裁定）**：评分层
  provider 路由感知——同模型多供应商接入为一等公民（generic 评分共享＋provider 限定行逃生门、
  两段式解析、整行替换、不外溢）；导出 candidates 恢复全目录逐条（Z9 折叠撤销）；调研包改
  **单一英文 canonical prompt**＋输出契约硬化（恰好 N/自包含/禁同上/禁引用标记/自检；语言决策
  证据入 ADR）；导入重复行**自动合并**（真实回传实证修订 B-3 拒绝裁定）＋重导入保留手编限定行；
  匹配实现三处收敛＋route-miss 徽章；copyConfig 深拷修复 overrides 删除从不落盘的既有 bug。
  **Z8 修正（用户裁定）**：导出范围从候选清单
  扩至宿主完整模型目录（评估语料配置无关——导入的全目录评分在模型日后加入候选时即刻生效，
  零重复调研），上限 64→256；单次调研不追求全社区覆盖（质量坍塌），全社区动态性由 L0 快照＋
  L1 远端同步承担。
- feat(effort): **语义档位意图（ADR 0013 d1＋0014 修订）**：档位按模型实际档位表物化（梯子
  off<minimal<low<medium<high<xhigh<max，off/none 不自动选，全不在梯子按目录顺序，偶数上中位）；
  B 族改 **mid**（qwen 三族 Xhigh/Medium/Low——"medium 呢"的答案；zai 系 B=High 为有意识升档），
  各家供应商词表差异无字面 id 依赖。修复 D1：qwen 系上旧模板全部静默降默认、效果与意图相反。
- fix(config): **respectExplicit 死开关复活（ADR 0013 d4，二审 P-18）**：0010 迁移漏接导致
  UI/locale 承诺的行为运行时零引用；现于 agent/created、步边界、inbox/claimed 三处接回
  `explicitRouteOf`——显式指派（创建路由≠父路由）优先于关键词映射与策略链（钉定除外）。
- fix(ship): **交付级审计修复（S 轮，全面用户旅程审计 2🔴+7🟡+11🟢）**——🔴R-1 spread 转录通知链
  补实现（策略指派/步边界换路双语文案，e2e Flow A/B 通过标准首次有运行时背书）；🔴R-2 新装默认
  （钉定）下"未配置按名映射"反事实文案改"默认映射休眠＋激活路径"，README 补前提；Y-1 B 槽
  unknown 例外（known 池内取中位，A-1 对三槽完整成立）；Y-2 未收录行级悬停标注（死键复活）；
  Y-3 五区待保存徽标补齐（共享 anyFieldDirty 谓词与 fieldOps 同口径）；Y-4 导出剪贴板回退陷阱
  （包形态识别＋本地化提示）；Y-5 nameMapDefaults+存量行从阻塞 degraded 改非阻塞 advisory；
  Y-6 inbox/claimed 尊重路由冷却；Y-7 estimated 泛滥现状披露＋调研 prompt 增接地/校准两条款
  （完整多阶段协议婉拒，取舍记录 ADR）。G 项：strategy.md 版本头/日志串、README 路由限定行、
  导出日期本地化。
- fix(ux): **交互反馈统一（事件瞬态/状态常驻分界）**——页脚"已保存"3 秒自动消失（定时器
  卫生：新保存重启窗口/dispose 清除；失败冲突仍常驻）；导出/导入/恢复默认改**按钮级动态反馈**
  （文案瞬时替换＋边框脉冲，reduced-motion 降级纯文字），移除突兀的段落式反馈行与硬编码
  "→ clipboard"；导入被拒逐条原因移入导入面板内；limits 区双份"已保存"chip 删除；Info ⓘ
  双实现合并；死 locale 键清理。
- fix(ui): 行内模型下拉去重（用户截图命中）；悬空行显示位修复；关键词框 140→96/模型框填满
  弹性轨；删除移至**序号 chip 悬停**（行尾 × 越界；五轨→四轨）；候选行单行渲染；子窗口徽章
  maxWidth 240→360（长 id 截断）；**恢复默认按钮伪下拉修复**（误用 dsmp-select 样式带下拉箭头
  外观＋纯默认态点击零反馈——改专用按钮样式＋禁用态内联灰显＋title 说明）；Team 区**待保存徽标**
  （分区脏态即改即现，免滚底）；恢复默认后分区即时反馈（徽标出现＋按钮回禁用双信号）。
- feat(cap): nameMap 上限 16→32（ADR 0013 d5；原 16 对齐的官方 roster 已随 0.2.2-rc.2 删除，
  起步配置 12 行＋存量手工行需合并空间）。
- feat(guard): 客户端/宿主边界守卫（任意 import 形态＋宿主包名集）。
- docs: README 双语、settings/strategy 手册、ADR 0006-0013、dont-do 两条沉淀
  （跨 provider 硬编码字面档位 id／配置承诺须随迁移审计运行时引用）。
- 留待：DOM 渲染级测试仍为既有技术债；命名预设集（多套映射＋切换）与 per-workspace
  覆盖为后续方向（ADR 0014 不做面）；auto-save 页级改造不做（全页统一保存为既有架构）。

- feat(resolver)!: **模型 id 解析全面加固（F 轮，ADR 0016 3b，269-id 实证审计驱动）**：官方裸 id 别名表（`deepseek-flash`→V4.1-Flash 族——用户实测第三候选加入 Team 不重派的根因：官方目录显示名 DeepSeek-V4.1-Flash 与存储 id `deepseek-flash` 分裂，而 KB 全族键带版本中缀）；版本分隔符归一（点/连字符等价，带防 `4-32k`/`2-72b` 腐蚀守卫）；上下文后缀剥离（k3-256k→k3 族）；保守扇出级联＋**单 token 守卫**（裸厂牌永不桥接）；OpenRouter 构建期别名交叉（`--aliases-only` 免源重建、只桥接运行期折叠不了的 slug、OR 署名入 NOTICES）。
- feat(visibility): **未收录可见性契约**——kbStatusOf 三态统一驱动候选行"未收录"徽章、"N 个候选未收录"汇总行、estimatedAll 互斥、运行时混合列表一次性排除告警；导入评估对任意 id 立即翻盘（已收录并参与分配）。审计结论：全 unknown 清单照常 12 行分配（契约锁定），真正的坑是混合列表静默零分配——不再沉默。
- feat(strategy): **槽位多样性偏好**——B 中位撞 S 时向两侧外步进（等距取强侧，≥3 不同模型门）；F 在 canonical 去重池上重跑（可互换判据保护 provider 限定双路由）；用户三候选场景实测 review 族翻 deepseek-official/deepseek-flash（max 档）、三模型各占一席。

## v0.3.0 (2026-10-29) — 官方设置页接管（takeover surface）

- feat(takeover): 启用期间官方「子智能体」设置页（纯编辑面）经 bundle patch
  隐藏；禁用/卸载即整层移除、官方页面立即回归（hmr），配置值保留。弃用
  plugins.item 同 id 遮蔽方案（插件页清单层不去重，会双卡 + React key 冲突；
  依据与取舍见 docs/decisions/2026-10-29-takeover-surface.md，ADR 0001）。
- feat(takeover): 本插件设置页新增「官方子智能体设置（已接管）」卡：运行限制
  （maxDepth/maxActiveSubagents）与官方授权清单（enabled/allowedModels）两
  section 经 configForms **同键读写**官方命名空间——不复制运行时，单一事实
  源；授权清单语义重标注（逐次显式指派 / autoRoute 采纳 / 回落池）。
- feat(takeover): 任一官方命名空间失活仅对应 section 转 unavailable，接管卡
  不消失（T7）；失活时清除 stale draft（T7 测试发现的真缺陷）。
- fix(pin): 路由变更时丢弃继承的 maxTokens（**有意偏离官方语义**，README 已知
  行为）：继承预算按父模型容量设定，跨模型携带会溢出新模型上限且官方 runtime
  无 clamp；丢弃后 runtime 按新模型物化默认输出预算。effort-only 覆盖保留
  maxTokens。
- docs: README 双语接管语义章节/已知行为、docs/settings.md 页面结构与行为要
  点、ADR 0001（接管机制取舍、maxTokens 偏离声明、0.0.2→0.3.0 跳号理由）。
- 未达项/留待：插件页"不出现重复卡"与 fiber 生效/回归链路的真机断言归隔离
  E2E Flow E（发布前执行）；DOM 渲染级测试仍为既有技术债。

## v0.0.2 (2026-10-26)

- fix(review): the E1 regression test actually discriminates now — a mock
  llm lets the registration cache memoize, the adapter set drops the pinned
  provider, and after `llm/adapters-updated` the next child moves to the
  surviving route instead of pinning onto the gone one (the previous test
  passed even with the fix reverted).
- chore: iconButtonStyle dead export removed; ci.yml pinned to
  `contents: read`; AGENTS.md local-dev note reflects the npm-based
  production dependency; archived doc reference annotated; upgrade handbook
  section numbering closed.

## v0.0.1 (2026-10-26) — first public release

Public-release baseline of the standalone DeepSeek Harness plugin
`dsh-subagent-plus`. Version line restarts at v0.0.1; the internal
development numbers 0.1.0–0.2.5 (21 commits) are archived history and remain
below for reference — the v0.0.1 tree is content-identical to the internal
0.2.5 final plus the release-readiness pass:

- release readiness: dead code/keys removed (iconButtonStyle, badge.title,
  usableFallback deduplicated into the host hook), the registration cache now
  invalidates on `llm/adapters-updated` (a removed adapter no longer pins
  children onto a gone route), the unregistered-pin warning is prefixed and
  latched to one line per lifetime, the settings page explains an unreadable
  stored value instead of a permanent ellipsis, the amber identity rule is
  scoped to the official sibling popup's `role="tree"` container, and the
  catalogue wire type lives once (shared CatalogGroup).
- docs: bilingual README (zh authoritative / en mirror), LICENSE, AGENTS.md
  (branch model, versioning, release gates), upgrade runbook with the
  release-chain failure-recovery table, dont-do lessons list.
- publishing: GitHub Actions release (tag-triggered, npm publish) and CI
  (typecheck/test/build on node 22/24).

## 0.2.5 (2026-10-26)

- polish(child-window identity, per user review): the `#N · label` header
  chip and the header-utilities badge are gone — which subagent window you
  are in now shows by hovering the lineage title, which tints the plugin's
  amber identity color (a page-lifetime style on the renderer's documented
  `[data-slot]` anchor seam; no hashed official selectors, no !important).
  The composer-side badge (provider/model · effort) stays as the single
  in-window model readout; one-shot read-only child windows fall back to the
  transcript notice.
- polish(settings): the page description drops to the settings-General row
  description size (12px/18px label-secondary, DeveloperToolsRow precedent)
  instead of the Models-page intro size.

## 0.2.4 (2026-10-26)

- feat(badge): the child-window badge now also names the reasoning effort the
  request actually carried — a two-segment render mirroring the official
  model trigger (amber `provider/model` main segment, caption-colored effort
  segment that shrinks first, 240px cap with ellipsis; title/aria stay the
  single `provider/model · effort` string). No effort on the request keeps
  the badge exactly as before.
- feat(identity chip): entering a child window shows `#N · label` beside the
  header title — which subtask this window is, N being its position in the
  parent's child catalog order (official SubagentHeaderLineage data chain;
  tooltip `第 N / 共 M 个子任务`). Registered additively on
  `conversation.session.header.actions` (order -25, beside the official
  catalog action at -30); nothing on top-level sessions, and a
  not-yet-loaded parent catalog degrades to the label alone.

## 0.2.3 (2026-10-26)

- fix(list rows): the name-anchored popover could not be reached reliably —
  a 4px margin between the name and the popover was a dead zone that closed
  it (mouseleave fired) before the pointer crossed, and clicking the name
  toggled closed what hovering had just opened. The popover now sits
  flush against the name (no dead zone), a click PINS it open (pointer-down
  elsewhere closes; Escape closes), and the action buttons carry larger hit
  areas — hover → move → click lands on the first try.

## 0.2.2 (2026-10-26)

- polish(list rows): the ⋯ trigger is gone — hovering (or clicking) the
  model NAME itself now reveals a compact horizontal action popover, so the
  row is just index · name · effort. The popover adapts to the row position:
  first row shows 下移+移除, last row 上移+移除, middle rows all three —
  a boundary row never renders a dead action. Two two-char text buttons in
  one line replace the multi-row menu card.

## 0.2.1 (2026-10-26)

- polish(list rows): the three always-on row buttons (up / down / remove)
  collapse into one ⋯ trigger revealed on row hover (and keyboard focus);
  its menu carries 上移/下移 (boundary items disabled) and a destructive
  删除 — no more dead arrows on the first/last rows and no dedicated
  remove column.
- polish(effort select): the default row is now just「默认」/「Default」—
  the closed box shrinks accordingly; hovering it (or any selected value)
  explains what it resolves to, e.g. 跟随模型默认档位（当前：Low）.

## 0.2.0 (2026-10-26)

- **renamed to `dsh-subagent-plus`** (the dsh-browser-plus product naming;
  no official `-plus` semantics). The whole identity family moves together —
  package name, cordis patch row id/name, client bundle banner id, plugin
  name export, settings namespace, locale namespace — pinned by a new
  `tests/manifest.spec.ts`. Upgrading an installed profile requires the
  three-line migration (dependency key, bundles entry, patch row id/name —
  the config block is preserved verbatim); same-version `file:` reinstalls
  are skipped, hence the 0.2.0 bump.
- feat(effort): per-model reasoning-effort selects. Picking a route into the
  pinned row, the fallback row, or a candidate list row now loads that
  model's own effort levels from the host catalogue (off/low/medium/xhigh
  for qwen-style, low/high/max for zai-style, none for non-reasoning models)
  as a dropdown: an always-present "Default (<name>)" row (empty value keeps
  the key omitted, the host materialises the model default), the model's
  levels by name, and a visible stale option when a stored id falls outside
  the current set (never silently rewritten; runtime validation owns
  rejecting it). Clearing a route clears its effort; switching keeps the
  stored id only while the new model still supports it. The two free-text
  effort inputs left the Advanced fold.

## 0.1.6 (2026-10-26)

- feat(settings page): an independent settings section (设置 → 子智能体模型
  策略) replaces manual cordis.patch.yml editing — strategy picker (pinned /
  round-robin / random / priority), ordered candidate list (add / remove /
  move up-down, capped at 5), fallback-model card, and an advanced fold
  (respectExplicit, showNotice, pinForkChildren, failOpen, autoRoute,
  cooldownMs). Visual conventions mirror the official settings page
  (13px/500 labels, 34px inputs, hairline separators, ⓘ click-to-expand
  help, reversed primary save button); model options come from the host
  catalogue. Saves land in the same profile-patch layer as manual edits,
  atomically behind the shared config form's revision fence.
- feat(hot config): every editable field is volatile — a committed settings
  change reaches the next child request without restarting the plugin and
  without resetting the health table, rotation cursor, or sticky decisions
  (LivePinConfig read-time evaluation; a materialization failure keeps the
  last good configuration).
- feat(fallback): an optional fallback route (`fallbackProvider` /
  `fallbackModel` / `fallbackReasoningEffort`, empty = off), independent of
  the candidate list, used when no candidate is usable (all cooling or
  unregistered — also the "empty list, single fixed model" entry, and the
  pinned strategy's no-pinned-route case). Failover still prefers the next
  healthy candidate; the fallback participates in health tracking; its
  transcript notice is `[model fallback: …]`.
- feat(anti-brick, review P0): structural problems (>5 routes, half-filled
  or repeated priority entries) still refuse to load, while cross-field
  combinations a settings page could persist (priority strategy with an
  empty list, half-filled or duplicate fallback) degrade with a warning
  instead of throwing — a persisted combination can no longer brick the
  plugin on the next host restart. The settings page blocks both classes
  through the same shared validation before writing.
- fix(review P1): save() now survives a rejecting mutate (transport down)
  instead of stranding the saving state; request-error recording is fully
  inert while disabled; a pinned-route failure attributes to the pinned
  model, never to a same-provider fallback.
- packaging: `dsh.client.inject` adds `@deepseek-ai/dsh-client-ui-settings`
  and `@deepseek-ai/dsh-api-remotes` (the settings shell and remote faces);
  a lean composition without them fails the whole client half loud, the
  same trade-off dsh-websearch makes.
- polish(ui, same 0.1.6): interaction and layout aligned with the
  dsh-websearch section — every ⓘ is a hover tooltip (Tooltip primitive +
  question icon, `dsh.client.external` adds ui-primitives), selects are
  compact auto-width boxes, switches are 36×20 green-when-on at row right
  edges, the takeover switch moved to the page header (status text became its
  aria/title), and the assignment-strategy row merged into the bottom of the
  single model card (pinned form titles the card 钉定路由). Page renamed
  子Agent增强 / Subagent Boost; dead locale keys removed; zh/en parity kept.
  Follow-up pass merges everything into ONE card — the fallback row sits
  right below the assignment-strategy row, and Advanced folds at the card's
  bottom behind a right-edge chevron (default collapsed); advanced rows are
  single compact lines with the explanation only in the ⓘ tooltip (the
  duplicated hint paragraph under each title is gone).
  Third pass: the header ⓘ is gone (the description line already carries it),
  the fallback-effort input moved into Advanced (shown only when a fallback
  is set), route selects show short labels in a capped box with the full
  route on hover (browser-plus translate pattern), and the advanced fold's
  rows lost their dividers — the fold header keeps the one boundary line.
  Fourth pass unifies the row rhythm: the pinned-route select joins the card
  header's right edge (identical to the fallback row), the add-model row
  becomes label-left/select-right, and both reasoning-effort inputs
  (pinned and fallback) live only inside Advanced behind clear titles —
  the puzzling bare "留空 = 跟随模型默认" box is gone from the main card.

## 0.1.5 (2026-10-25)

- feat(strategy): multi-route selection engine. New config `strategy`
  (`pinned` default, `round-robin`, `random`, `priority`), `priority` (ordered
  candidate routes; empty falls back to the official allowed-model list in its
  stored order), `respectExplicit` (default false) and `cooldownMs` (default
  120000; 0 disables health tracking). A spread strategy decides a child's
  route once on its first request and keeps it for the child's lifetime; the
  next child draws the next route. `pinned` keeps the exact v0.1.x behaviour,
  so an unchanged configuration behaves identically.
- feat(failover): route health. `agent/request-error` failures are classified
  by Harness code — transient (RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/
  EMPTY_RESPONSE) cools the exact route, credential/quota codes cool the whole
  provider, NO_ADAPTER/UNSUPPORTED_REASONING_EFFORT cool the route, request-
  shaped failures are ignored. The listener always delegates, so the official
  retry plugin keeps every retry decision; a retried request lands on the next
  healthy candidate (`request/header` records the change) and new children
  skip cooling routes. Sticky failures end the current child as before and
  only steer later children (decision D-3).
- feat(notice): spread strategies emit `[model assigned: … (strategy: …)]`
  once per child and `[model reassigned: route X is cooling down (CODE); …]`
  after a failover; notices are de-duplicated per child.
- docs: `docs/strategy.md` (decision matrix, recipes, known limits),
  `docs/v0.1.5-strategy-plan.md (archived)` (approved execution plan).

## 0.1.4 (2026-10-25)

- style(badge): drop the border/background chrome and mirror the official
  model-selector trigger geometry exactly (13px / 28px / transparent), so the
  badge reads as a native sibling in the composer row. Differentiation now
  rides on the text color alone: the stable amber state token
  `--dsw-alias-state-warn-primary` marks "this child runs a pinned model"
  at a glance. Read-only cursor kept; link/accent blue deliberately avoided
  so the badge never reads as clickable.

## 0.1.3 (2026-10-25)

- feat(badge): client half — read-only pinned-model badge on
  `conversation.input.right` (beside the official model selector) and
  `conversation.session.header.utilities` (header fallback for one-shot
  read-only child windows). Data: durable `modelSelection` projection
  (`lastUsed`, folded from `request/header`); top-level sessions and sessions
  without a readable route render nothing. Requires a web-app-class
  composition (the client entry binds `slots` + `locale`; a composition
  without them fails the web boot loud).
- feat(autoRoute): zero-config install — with `provider`/`model` unset and
  `autoRoute: true` (default), each child request adopts the FIRST route of
  the official subagent model-selection settings when they are enabled. The
  official list is a per-call allowlist, not a priority order; taking its
  first entry is a deterministic default only. Explicit configuration always
  wins; Hosts without the service (base/headless compositions) pin nothing.
- fix(packaging): `@deepseek-ai/dsh-llm` moved from an exact runtime
  dependency to `peerDependencies` (`>=0.2.0-rc.1 <0.3.0`) — inside a dsh
  profile the import resolves to the Host runtime's own copy, so a single
  module instance is guaranteed across Host upgrades.

## 0.1.2 (2026-10-25)

- feat(notice): add a visible one-line pinned-model notice to each child
  agent's transcript (config `showNotice`, default on). Hooks `agent/pre-step`,
  reuses the official `model-selection`/`notice` message source so the desktop
  renders it with the product's own collapsed notice row — the model a child
  window runs is now visible at first glance instead of inferred. One notice
  per child per pin target; none for top-level agents or (by default) fork
  children.

## 0.1.1 (2026-10-25)

- fix(packaging): declare `dsh.bundle.patch` in package.json. Without it the
  official plugin manager reports "这个包没有声明组合包，不能作为插件管理" and its
  reconcile step drops the package from `dsh.profile.bundles` on the next
  manager operation, silently unloading the plugin (observed in the wild when
  a plugin-page click triggered reconcile).

## 0.1.0 (2026-10-25)

- Initial release: pin all delegated child agents (subagent delegations and
  Agent Teams teammates) to one configured LLM route via the `agent/request`
  waterfall; top-level agents untouched; fork children excluded by default;
  fail-open on unregistered routes.
