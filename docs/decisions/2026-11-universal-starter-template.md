# 0013 — 单一通用起步配置＋语义档位意图（取代 0011 模板面）

日期：2026-11-13 ｜ 状态：用户批准（v0.0.4 未发布原地补丁，纯功能重构，不动版本号）｜ 取代链：0008 决策 7 ← [0011](2026-11-role-templates.md) ← 本文

## 取代/存活清单

**取代**：
- 0011 决策 1（四场景模板定义）——四模板合并为单一通用起步配置
- 0011 决策 2 的 H5（无档位路由 effort 传 ''）——扩展为语义档位解析（无档位仍为 ''，但语义意图不再静默塌缩）
- 0011 决策 2 的 H4（容量预检单一数学）——改为按 replace/merge 分模式预检

**存活**：
- 0011 决策 3（确认三选：替换/合并/取消）
- 0011 决策 4（模板是对 draft 的一次性填充，应用后行与手动行同构——物化哲学）
- 0011 决策 5（不动面）
- 0010 全部（select() 架构）

## 背景

三路调研（官方仓库工具链定位／插件 17 项缺陷审计／社区经验）＋独立二审 23 项意见（5🔴 全部吸收）：

1. **D1（用户实测命中）**：模板硬编码 `'high'`/`'low'` 字面档位 id；qwen 系档位为 Off/Low/Medium/Xhigh（无 `high`）→ 全部 S 行静默降级为"默认"，而默认档可能是 low——"质量优先"模板实际效果与意图相反，UI 无任何提示。宿主契约：efforts 列表是 **adapter 首选展示顺序，不是强度顺序**（`LlmReasoningEffortInfo` JSDoc），且不支持的字面 id 透传后 `UNSUPPORTED_REASONING_EFFORT` 使路由进冷却。
2. **社区证据**：无成熟产品以场景化固化模板为主控制面（Amp 的模式捆绑 dial 已官方弃用，败给"正交旋钮＋策划默认"）；effort 分配共识 = reviewer/planner→强模型＋高档、executor→默认档、tester→快模型＋低档，"只配模型不配 effort→取模型默认档"有 Codex 先例；解析优先级惯例：显式 spawn 参数 > 声明式策略 > 全局默认。
3. **P-18（二审独立发现）**：`respectExplicit` 是死开关——UI/locale/config 承诺"尊重主智能体显式指派"，但 ADR 0010 迁移后 `src/index.ts` 引用数为 0；`explicitRouteOf` 纯函数（strategy.ts）及其测试存活未接。

## 决策

### 1. 语义档位意图

模板 effort 从字面 id 改为语义意图 `'top' | 'default' | 'lowest'`，应用时按路由实际档位表物化：

- **梯子优先**：按公认强度梯子 `off < low < medium < high < xhigh < max`（大小写不敏感）在 efforts 内排序取最高/最低。宿主 efforts 顺序是展示顺序非强度顺序（deepseek/qwen/zai 恰好递增，pi-ai 逐字透传第三方元数据不可假设），位置规则只能兜底。
- **位置兜底**：仅当档位 id 全不在梯子内时，退回"最后一个/第一个非 off 档"。
- `default` → `''`（absent → 宿主物化模型默认档；与 ADR 0010"缺省保持 absent"一致）。
- **无非 off 档（空数组或全 off，如 deepseek thinking-disabled 模型 `[Off]`）**→ 所有意图一律 `''`。
- off/none id 视为"关闭推理"标记不参与自动选择（'off' 有实例；'none' 预防性排除，未见实例）；手动行仍可选 off。
- 应用结果摘要显示"N 行档位意图未能物化"——拒绝静默降级（社区最大反模式）。
- 手动行不改：字面档位＋"默认"（正交旋钮）。

### 2. 单一通用起步配置（12 词干 × 3 家族）

| 家族 | 关键词（词干，子串匹配） | 槽位＋档位意图 |
|---|---|---|
| 质量把关 | review, audit, verif, plan | S ＋ top |
| 执行构建 | research, dev, build, execute, write, design | B ＋ default |
| 快速验证 | test, qa | F ＋ lowest |

- **一张表服务所有 session**：开发 session 命中 review/dev/test，游戏 session 命中 design/write，研究 session 命中 research/plan；未命中名走策略链。无需按场景切换配置（场景化模板为反模式，Amp 先例）。
- 槽位自适应：1 条可用路由全部同路由按档位意图区分（并入原 T3 行为）；≥2 条按 S/B/F。
- **按钮门**：`byNameLocked || 可用路由数=0 || (可用路由数=1 且唯一路由无非 off 档)` → 单按钮禁用＋title 显示原因（不凭空消失）。UI 形态：下拉只放一项不合理 → 单按钮"填入通用起步配置"＋确认三选。
- **词干碰撞排查**（接受并记录）：`dev`⊆devops（同家族）、device-\*（误入 B 均衡档，可接受）；`test`⊆latest（latest-digest 类临场名误入 F 快档，代价低）；`verif`⊆verifier/verification；`build`⊆rebuild；`write`⊆copywrite。
- **模板行序 = 等长跨家族平局裁决序**（matchByKeyword 等长先现胜）：表序 review, audit, verif, plan, research, dev, build, execute, write, design, test, qa——质量把关家族（前置）赢得平局：`test-planner`→plan（S＋top）、`design-review-dev`→review（S＋top），均可辩护。
- 覆盖率宣称沿自 0011 的 28 人单工作区样本，未复测（记录为局限）。

### 3. 容量与反馈闭环

- 预检分模式：replace 恒查"模板行数 ≤ 上限"；merge 查"新增关键词数 ≤ 上限−现有行数"。merge 不可行而 replace 可行时仍进确认，merge 按钮禁用＋原因。
- **confirm 时点二次校验 = 完整前置条件重放**：模板 id 存在＋所选模式容量数学＋槽位可解析（可解析行数 ≥1 才允许 replace 清空存量）；任一不满足→拒绝且不动 draft。
- insufficient 返回结构化数字（needed/free），UI 渲染；未知模板 id 独立错误码（不再与容量不足复用）。

### 4. respectExplicit 复活（P-18 修复）

- agent/created 监听器接回 `explicitRouteOf`：`respectExplicit=true` 且检测到显式指派 → 跳过名字映射与策略链（对齐社区"显式 spawn > 声明策略"惯例）；`false`（默认）→ 名字映射无条件优先（治理定位不变）。
- 已知盲区（显式指派恰等于父当前路由时无法识别）维持既有 locale 声明。
- ADR 0010 迁移漏接的事实随本决策修复；教训沉淀 dont-do.md（配置承诺必须随迁移审计运行时引用）。

### 5. 行数上限 16 → 32

- 原依据失效：16 对齐官方 roster `DEFAULT_MAX_MEMBERS`，agent-team 已在 0.2.2-rc.2 删除。
- 新论证：通用模板 12 行＋存量手工行 merge 时 16 装不下，用户被迫 replace 丢存量。
- nameMap 首发即在本版，无已发布版本兼容负担。
- 改动面九处同步：strategy.ts 常量＋校验报错文案字面量、settings-controller 预检/断点、config.ts schema、locales byname.max 双语、README、strategy.spec/controller.spec 断言。

### 6. 物化 id 跨版本 stale 风险（记录）

应用时物化的字面档位 id 存进 nameMap；日后 adapter 更新档位集后存量 id 变 stale → 运行期 `UNSUPPORTED_REASONING_EFFORT` → sticky-route 冷却 → 兜底接管。既有缓解：设置页 stale-option 可见（effortOptions）。运行期按 catalog 过滤**不做**：物化行不再携带语义意图、无法重解析，逐请求校验成本高——记录为已知行为。

## 不动面

- 手动添加/编辑/删除、策略链、健康降级、冷却/兜底、ADR 0006-0010 语义面、服务端。
