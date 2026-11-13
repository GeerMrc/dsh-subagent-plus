# 0014 — 通用映射安装即默认派生（取代 0013 d2/d3，修订 d1）

日期：2026-11-13 ｜ 状态：用户批准（v0.0.4 未发布原地重构，纯功能，不动版本号）；决策 1 的序数槽位被 [0015](2026-11-capability-derivation.md) 取代（能力评分排序指派），其余存活 ｜ 关联：[0013](2026-11-universal-starter-template.md)、[0012](2026-11-dual-name-resolution.md)、[0010](2026-11-agent-model-select-migration.md)

## 取代/存活清单

**取代**：
- 0013 决策 2（单一通用起步配置的**按钮形态**：单按钮、确认三选、容量分模式预检、前置条件重放、applied/insufficient/unavailable 摘要、starterGate、ApplyTemplateResult）——全部删除，改为安装即默认派生
- 0013 决策 3（容量与反馈闭环）——随应用流程消失；32 上限存活（custom 行）
- 0013 决策 1 中 B 族 `default` 意图——改为 `mid`

**存活**：
- 0013 决策 1 骨架：语义档位意图＋梯子优先/位置兜底＋off/none 禁选＋无非 off 档→''（扩展 mid 与 minimal）
- 0013 决策 4（respectExplicit 复活）、决策 5（上限 32 与改动面）、决策 6（物化 id stale 已知行为——custom 物化行适用；defaults 派生行随目录自适应，stale 自愈）
- 0010 全部（select() 架构）、0012 全部（双源名字解析）、0008 匹配语义

## 背景

用户实测三张截图提出四问＋一条产品建议：
1. 档位 mix（xhigh／默认low／low）＋"medium 呢"——B 族 `default` 在 qwen 上物化 low 与 F 族撞档，medium 永不出现
2. **起步按钮是多余的一步**——应安装即默认，用户二次修改＋恢复默认入口；且"应用→未保存提醒"制造了两步保存感（核实：全页本就页脚单按钮统一保存，无任何 auto-save，候选清单同路）
3. 关键词框过宽/模型框过窄
4. 模型下拉重复（领头 currentLabel 选项与 listed 同名条目）
另：候选清单增删改时 Team 应动态自适应。

探查核实（agent 报告）：`listModels` 不含 reasoning，档位在 `resolveModelInfo`（官方 buildModelCatalog 先例）；schemastery 字段级 transform 无 sibling 访问，条件迁移默认必须放 materializeConfig 后处理且**新字段不能带 `.default()`**；派生行不入存储即绕过 validateStrategyConfig，合法性由派生构造自负（只从 priority 取路由＋固定合法词干）。

独立二审（R/Y/G 编号）：2🔴（R1 派生须按 spread 门控；R2 mid 规格补全）＋7🟡＋6🟢，全部吸收。

## 决策

### 1. 档位意图扩为 `top | mid | lowest`（'default' 从 union 删除）

- **mid＝onLadder 集梯子排序后的中位，偶数取上中位**（与 B 槽"2 条取第 2"先例同向）；全不在梯子→目录顺序中位同样向上取整；单 active 档＝该档；0 档→''
- 梯子扩为 `off < minimal < low < medium < high < xhigh < max`（minimal 为 pi-ai 类透传词表的声明性容纳）；off/none 仍禁选
- B 族（research/dev/build/execute/write/design）→mid：qwen 三族 xhigh/medium/low（回应用户"medium 呢"）；zai/deepseek 上 B=high
- **取舍记录**：偏离 0013 引用的"executor→默认档"社区共识（Codex 先例）——qwen 上 default 物化 low 与 F 族撞档是用户实测痛点，接受 zai 系 B 整体升档为代价；2 档模型上 mid 必与 top/lowest 同档（撞的是不同路由行，接受）
- 手动行不变：字面档位＋"默认"

### 2. derived defaults

- config 新增 `nameMapDefaults`（schema 无 `.default()`；materializeConfig 后处理：**缺失→nameMap 非空? false : true**，规则抽 strategy.ts 单函数共用——存量手编/已应用过模板的用户自动落 custom 零覆盖）
- 语义：true→effective nameMap＝派生（12 词干×S/B/F×top/mid/lowest，槽位/档位随候选清单与模型目录自适应）；false→存储行原样（空表=休眠，0006 存活）
- `true`＋非空存量行：派生胜出＋validateStrategyConfig **degraded 级警告**（"存量 nameMap 行被忽略"）；手编文档声明
- **R1 硬门：派生仅在 spread 策略下生效**（运行时按 live 配置、客户端按 draft.strategy 镜像；pinned 下派生休眠——否则凌驾钉定且 byNameLocked 锁死编辑入口）
- **运行时派生**：缓存全部放 apply() 闭包；`ctx.inject(['llm'])` 内启动首派生＋三时机重派生（boot/llm 服务就绪、settings 文档更新、llm/adapters-updated）——代数计数：in-flight 去重＋完成后校验代数防旧覆新＋adapters-updated 尾随 200ms 合并；effort 逐条 `resolveModelInfo`（try/catch 降级 ''，缓存随 adapters-updated 失效——adapter 改档位集后派生行**自愈**）；agent/created（async）await 在途派生 promise；inbox/claimed 同步监听只读缓存（未就绪=空表休眠，与今日空表语义一致）；decideByName 的 priority 守卫天然防御过期派生行（候选删掉→旧行 miss）
- 7 个消费点切 effective map：decideByName 早退/匹配/守卫、fork warn、recordFailure provider 守卫、inbox/claimed 早退、request-error routed 判定（派生行 provider 计入冷却与健康跟踪——期望行为，测试显式覆盖）
- **客户端**：SettingsUiState 增 effectiveNameMap 计算视图（draft.priority＋state.routes 本地派生，**不进 draft**——dirty 判定基于 value/draft JSON 比较，派生混入即永久 dirty）；**copy-on-write**：任一行编辑/添加→flip false＋物化派生行再应用编辑；custom 态 Team 标题右侧"恢复默认映射"按钮（内联确认"将替换全部自定义行"→清行＋flip true，走统一页脚保存）
- **memo 明示**：byNameDecisions 按子代理 memo——派生变更不重路由已决策子代理，与"保存对新决策立即生效"语义一致（明示决策而非巧合）
- 保存叙事：全页单按钮统一保存不变（候选清单同路）；不引入 auto-save（页级架构，非本轮）

### 3. UI 修正

- 下拉去重：listedHit 命中时不渲染领头 currentLabel 选项；dangling 行 value 置 ''（领头显示位真正生效）
- 宽度：nameInputStyle 140→96／minWidth 132→88（占位文案缩短）；nameMap 行 route select 行内 `width:'100%'` 填满 1fr 轨（共用的 routeSelectStyle 本体不动）

## 动态自适应

- defaults 模式：候选清单增/删/改/重排→派生即时重算（客户端每渲染；运行时三时机）；目录档位变化→adapters-updated 重派生自愈
- custom 模式：悬空行维持 0007 显式防御（structural 拒保存＋行内可见），**不静默改写用户数据**（决策：自定义即冻结快照，locale 提示"不再自适应"）
- 目录加载失败（catalogFailed）：客户端派生降级 efforts=''（仍从 priority 派 provider/model）；copy-on-write 时同样物化 ''（文档提示）

## 不动面

respectExplicit 语义（0013 d4）、健康降级/冷却、fork 排除、select() 架构、统一保存编排、上限 32。
