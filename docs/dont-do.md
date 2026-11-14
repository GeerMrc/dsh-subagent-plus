# Dont-Do — 负向教训清单（准入：踩坑 → RCA → 系统性确认）

## 打包与安装

- **同版本号重打包/降级安装**：pnpm store 按 version 缓存，`rm node_modules/<pkg> + pnpm install` 可能装回旧副本——必须 bump 版本，或 `pnpm store prune + rm -rf node_modules + pnpm install --force`，并用 **grep 安装产物内容**（非仅 MD5 对比本地 lib）确认。（2026-10-26 v0.2.5 事故：本地 lib 新、安装副本旧，MD5 对比两旧同值。）
- **缺 `dsh.bundle.patch` 清单**：官方插件管理器报"这个包没有声明组合包"并在下次 reconcile 时把包从 bundles 剔除，插件静默卸载。（v0.1.0 事故。）
- **`@deepseek-ai/dsh-llm` 放 dependencies**：装出与宿主不同的第二实例——放 peerDependencies（范围 `>=0.2.0-rc.1 <0.3.0`），profile 内解析到宿主自身副本。

## 配置与迁移

- **settings 命名空间 = profile patch 行 id**：改名（包名/行 id）时必须同步手改 patch 行 id+name（config 块逐字节保留即零丢失），漏改则旧行成孤儿（boot 时静默忽略）。
- **发布前删内部治理文档**（计划/审核过程记录）：公开树只留最终态；历史在本地 archive 分支留档。

## UI 交互

- **悬停弹窗与触发器之间禁止任何间隙**：margin 是无属死区，鼠标跨过即触发 mouseleave 关闭弹窗（漂移感根因）。
- **"悬停开 + 单击 toggle"是反直觉组合**：单击应固定弹窗（外部点击/Esc/动作后关闭）。
- **React 受控 select 的快照同一性**：useSyncExternalStore 依赖快照引用变化——原地修改状态字段不触发重渲，必须重建状态对象。
- **类方法直传事件回调丢 this**：控制器公开动作一律箭头函数类属性。

## 发布链

- **首推 workflow 与 tag 同批不触发**（GitHub 限制）：先推 main 再推 tag。
- **npm 裸名被反抢注政策拒**（与既有包过近）：走 scope 分发 + 裸名 tarball 双名模式（参照 dsh-websearch `scripts/pack.mjs`）；banner id/patch 行/name 导出保持裸名。
- **`npm publish` 裸参数被解析为 GitHub spec**：必须 `./` 前缀 + 显式 `--registry https://registry.npmjs.org`。

## E2E 与宿主组合（v0.3.0 接管轮沉淀）

- **patch 行的 config 是整对象覆写，不是逐字段合并**：后层只写 `modelSelectionSettings: false` 会抹掉前层的 `provider`/`toolName`（激活报 `$.provider missing`）。跨层改 config 必须携带完整目标 config。
- **standing `tool-subagent` 行不认 preset 作用域选项**：`modelSelectionSettings: true` 只在 preset 内合法；headless 组合给 standing 行配上它直接激活失败，模型退化走 fork/workflow 委派——测试组合要按 base bundle 语义配置。
- **源码启动的宿主对 `setBundleEnabled` 不热重组**（写 manifest + pnpm 移除都执行了，运行中组合不变）：E2E 里"禁用即官方回归"的断言必须按"重启后回归"设计；生产桌面的 hmr 即时性需实机另验。
- **UI 断言字符串先核单复数**：官方插件页条目是 "View Subagent"（单数）——正则按复数写导致 E3a 假阴性，差点误判"官方页未回归"。
- **web-app 专属行在 headless 组合里不存在**：`subagent-model-selection-settings` 行由 web-app bundle 插入；headless E2E 需要它时用 `--patch` overlay `insert` 补行（profile 层的 config 行无法配置"更晚层才插入"的行）。

## 发布门（v0.3.1 轮沉淀）

- **tag 推送 = 发布动作本身**：release.yml 由 `v*` tag 触发并在数秒内 `npm publish`——0.3.0 在 AGENTS.md 人工实测门写入前 7 分钟被 tag 推送泄漏上 npm（latest 事后拨回 0.0.2，包体无法撤回）。推 tag 前必须逐字核对人工实测门条件；"先推 tag 再补验证"不存在。事后处置三选一（保留/deprecate/unpublish）只能由用户本人决策，执行侧不得代行。
- **版本线以 registry 为准，不以本地认知为准**：发版决策前先 `npm view <pkg> versions` 实测——本轮计划原定 0.0.3，实测发现 0.3.0 已面世后改为 0.3.1 续接（低于已发布版本的号在任何 semver 区间下都无法安装覆盖）。（后续：2026-10-29 用户裁定 [ADR 0004](decisions/2026-10-29-product-line-is-0.0.x.md)——产品线固定 0.0.x，0.3.0 定性为误发孤儿包、不走续接；但"发版前先实测 registry"这一步本身仍然必须。括注里的绝对化表述按 0.0.x caret 锁 patch 位的语义理解。）

## 产品叙事自洽性（R7 轮沉淀，2026-10-30）

- **"文档与实现一致" ≠ "产品模型对用户自洽"**：R6 审核把所有文案对齐到了当时的实现（部分接管+双桥接），逐条"一致"但整体叙事自相矛盾（"完整替代"却保留官方清单桥接；"100% 接管"却有三种关法）。两轮用户实测连续命中。产品级审核必须加一个独立镜头：**让一个不知道内部实现的用户读三句话——装了以后谁在管路由？怎么关？空配置会怎样？**三句话答不出唯一答案即存在叙事分歧。
- **决策留下的"兼容承诺"要随产品演进重新审**：v0.0.2 `enabled:false` 零迁移承诺（ADR 0002 D1）在二元化裁定后成为叙事负担——软开关的存在本身制造了第三态。兼容承诺不是永恒义务，推翻时要走 ADR 并把翻转写进升级注记（0005 先例）。

## npm 认证与删除（0.3.0 物理移除轮沉淀，2026-11-02）

- **npm 2026-01 起彻底关闭新 TOTP 注册**（官方 staff 在 community discussion #182325 确认 "users can no longer config new TOTP 2fa methods"）：账号 2FA 页没有"验证器应用"入口是设计而非故障，别再找；现行唯一体系是通行密钥/安全密钥（WebAuthn，仅网页端配置）。
- **恢复码不能当 `--otp` 用**：64 位 hex 恢复码实测被 EOTP 拒绝；恢复码只用于网页端账号自救（丢第二因子时登录）。
- **发布/删除类写操作的正解 = npm ≥ 11.7 ＋ 通行密钥浏览器审批**：命令在**用户交互终端**执行 → 打印/弹开 `https://www.npmjs.com/auth/cli/<id>` → Touch ID 确认 → 终端自动继续，全程零动态码。npm < 11.7 或无 TTY 环境（agent shell）直接 EOTP 退出，打印的 URL 随进程消亡、转交他人无效。node 20 下 `npm i -g npm@11` 可升到 11.21.1。
- **bypass-2FA granular token 别为发布而建**：对 unpublish 类操作当场被拒；2026-07-31 起敏感操作（建删 token/包权限等）受限；**2027-01 起失去直接发布资格**。CI 无人值守发布的官方替代是 trusted publishing（OIDC）。
- **连续敏感操作触发账号临时冻结**（"temporarily suspended due to a recent security-sensitive action"，写操作 403、读操作不受影响、包对外服务不受影响）：实测多次 unpublish 失败＋建 token＋2FA 开关切换后触发，约 24-72h 自动解除；冻结期间任何触碰都可能重置冷却——失败后停手，隔天再试。
- **72h 窗口不是铁截止**：发布 72h 后单版本 unpublish 仍可行（前提包 0 依赖方）；网页端无删除入口，物理删除只有 CLI unpublish 与工单（https://www.npmjs.com/support）两条路。
- **npmjs 操作必须显式 `--registry https://registry.npmjs.org`**（本机默认 npmmirror）。
- **聊天截图通道把图片压到 ~562px**：整页截图里的二维码不可解码；传二维码/密钥必须 Cmd+Shift+4 紧裁二维码块或直接复制文本。
- **CI 发布链的 token 有效期检查**：release.yml 的 `secrets.NPM_TOKEN` 指向的令牌可能已被账号清理（2026-11 用户清理过）；且该类 token 2027-01 失去直接发布资格。每次发 tag 前先确认 secret 指向的令牌仍存在有效；2026-12 前完成 trusted publishing（OIDC）迁移或改走人工终端发布。（处置：v0.0.3 当轮删除 NPM_TOKEN 自动 publish、走用户终端 Touch ID 发布；v0.0.4 起切换 **trusted publishing（OIDC）**恢复全自动——绑定须发布日当天建（2 天内未首发即过期）、workflow 需 `id-token: write`＋npm ≥ 11.5.1；人工终端通道保留为兜底。）
- **npm 网页登录 token 是短时效的**（v0.0.3 发布实测，2026-11-06）：11-02 login 的 token 四天后 `npm whoami` 401 失效；**死 token 的 publish 报 E404 "could not be found or you do not have permission"（权限遮蔽假象）而非 401**——勿误判为包归属/权限问题，先 `npm whoami` 验 token，失效就重新 `npm login`（浏览器 Touch ID）后**立即**在同终端发布。
- **publish 撞上在途事务报 E409 "Cannot publish over previously staged version"**：同版本有发布事务已上传未定稿（另一终端在跑/浏览器仪式刚完成在收尾）。勿盲目重试——等几秒用 `npm view <pkg> versions dist-tags --json` 查最终态（注意 **curl 裸查 packument 可能命中 CDN 陈旧缓存**，以带凭证的 npm view 为准），成功则收工，未成功再排查。
- **发布验证三验以 npm view ＋ shasum 对物为准**：`dist.shasum` 与本地 tarball 的 shasum 逐字节一致才能确认"上的是这份产物"；tarball HTTP 200 与版本清单作旁证。

## 能力评估（v0.0.4 KB 轮沉淀，2026-11-14）

- **模型名猜能力被实证证伪**："有参数量≥16B 压过 flash 变体词"在 deepseek-v4.1-flash（激活 8-16B）显著强于 Qwen3.8-27B 的实证下方向全错；同族反例 Flash-Next(6B 激活)>27B 稠密连"同族同代参数可比"都不保——跨族能力比较唯一可靠锚点是外部基准，名称解析只配做 KB 匹配辅助。
- **缺证据≠优势**：缺段重归一（按可得段重新归一权重）会把"缺席 coding 证据"放大成反超"已证实 coding 能力"——固定权重＋缺段按中位 0.5 填充才是保守收缩。
- **量纲混合偏置**：用户导入的 0-100 绝对分与 KB 的 [0,1] rank-fraction 直接混合，会因 LLM 评分的 60-90 集中趋势系统性高估——导出 prompt 必须诱出分布位置判断（50≈中位/70≈前 1/4/90≈前 10%）＋/100 线性映射，并声明残余校准偏差。
- **编辑脚本的 print ≠ 落盘**：python str.replace 静默失配（锚文本与文件现文不一致）时脚本照常打印"已写入"——连续两次让提交信息虚报（V4 ADR 4a、V5c reduced-motion）。改后必须 grep **源文件或构建产物**确认目标文本真实存在，再写提交信息。
- **CSS 类打不过 inline 样式**：禁用态想用 `.cls:disabled{cursor:default}` 改变 inline `cursor:'pointer'` 永远失败（style attribute 特异性最高）——禁用态视觉一律内联展开（Switch 先例）。
- **官方目录显示名与存储 id 分裂是匹配层的隐形输入**：harness `llm-deepseek` 目录 `{id:'deepseek-flash', name:'DeepSeek-V41-Flash'}`——用户看到 V4.1，存储的是裸 `deepseek-flash`，而 KB 全族键带版本中缀→解析 miss→"加入候选不重派"被读成 bug。排查模型解析问题必须**以落盘配置里的原始 id 为准**（本审计第一版误诊即引用了用户列表里不存在的 id 形态，被用户当场驳回）。
- **被排除候选零提示＝用户把设计读成 bug**：A-1"未收录＝三槽最后备选"在有已收录候选时把未收录者排到 0 行——行为正确，但 UI 无徽章、日志无告警，用户视角＝功能坏了。任何"按规则排除"必须有可见性对应物（徽章/汇总/一次性告警至少其一），否则规则越正确越像缺陷。
- **占用链不完整＝多样性承诺漏角**：F3 只保护 B 撞 S，F 撞 B 无人管即出货——"同模型占两族、第三模型 0 行"在用户侧读成"分配坏了"。多样性规则必须按选取顺序对全部前序占用者完备，且每个消费方向逐一断言。
- **故障接管跳层＝中间资源闲置**：Team 行路由冷却直跳兜底，候选清单里不占行的候选全部闲置——用户感知为"兜底与候选清单功能重叠"。任何 N 层资源链上线时，逐层验证失败路径真的逐层下移（且中间层自身的失败要计入冷却——否则中间层会一直服务于死路由）。
- **多样性门的边界必须从最高频用户配置倒推**：≥3 distinct 门有鸽洞上的优雅性，却把最常见的 2 候选配置排除在覆盖承诺外——G2 噪声带一到位，2 候选×特定排序直接全表单模型（用户实测命中）。契约的边界条件要用用户最高频场景做首测（2 候选×双排序端到端），不是实现方便性。
- **同模型多入口不是重复候选而是部署副本**：负载分摊与故障接管都应把它们当作一组（可互换判据＝canonical＋分数＋fast hint；qualified override 刻意分化的才是主备）。轮转领头权由既有裁定链决定（Z7 结构链＞清单序），新功能不得静默改写旧契约——Z7 测试现场拦截了 list-order 轮转。
- **argmin 语境下"垫底哨兵"语义反转**：unknown 哨兵"排最后"在 argmax 下＝最后备选，在 argmin（选最弱）下＝首选！缺收录的新旗舰会被推去接 test/qa——哨兵语义必须对每个消费方向逐一裁定（三槽一律最后备选）。

## 模板与配置承诺（v0.0.4 模板重构轮沉淀，2026-11-13）

- **行内弹层必须锚定在行首列或走 portal**：锚在末列的非 portal nowrap 弹层必然越过卡片右缘（×删除弹层溢出设置页，用户截图命中）——同构件换锚到首列（RowNameCell 先例）即消除。
- **常驻功能控件不做态驱动的消失**："恢复默认"按钮按 nameMapDefaults 态显隐，用户恢复保存后按钮消失、误以为功能丢失——常驻入口应两态可见（幂等态点击无害），语义进 title。
- **交付态默认优于向导按钮**："起步配置"单按钮＋确认三选＋容量预检＋未保存提醒，用户实测两连问"为什么要有这一步"——开箱即用的派生默认（derived defaults＋copy-on-write＋恢复默认入口）才是正解；预填式向导只该出现在默认值无法从环境推导时。

- **受控 select 的领头显示 option 必须与选项列表去重**：`<option value="">{currentLabel}</option>` 领头项在当前值 ∈ 列表时与同名条目重复（用户截图命中两个同名模型）；领头项只在 dangling/incomplete 显示位有意义，且 dangling 行 value 须置 '' 才真正显示。
- **删除门禁（如 starterGate）前先枚举它拦截的全部场景在新设计里的归宿**：0014 删 starterGate 时若不重新设计"pinned 下不派生"（R1），派生会凌驾钉定且编辑入口被 byNameLocked 锁死——门禁不是死代码清单，是场景清单。
- **schemastery 字段级 transform 无 sibling 访问**：条件迁移默认（"字段缺失时按另一字段取值"）不能写在字段 schema 上，也不能给字段 `.default()`（host 解析层吃掉"缺失"使迁移永不触发）——放 materializeConfig 后处理。
- **跨 provider 硬编码字面档位 id**：模板写死 `'high'`，qwen 系档位是 Off/Low/Medium/Xhigh（无 high）→ `#resolveEffort` 精确匹配静默降"默认"，默认档可能是 low——"质量优先"模板实际跑最低档，UI 无任何提示（用户实测命中，ADR 0013 决策 1）。跨 provider 的档位引用必须用**语义意图**（top/mid/lowest）按实际档位表解析；且宿主 efforts 顺序是 adapter 展示顺序**不是强度顺序**，"取末位=最高"只能在档位 id 全不在公认梯子时兜底。
- **配置承诺必须随架构迁移审计运行时引用**：ADR 0010 把模型改写从 agent/request 迁到 agent/created 时，`respectExplicit` 的运行时消费被一并删掉，但 UI 开关/locale/config JSDoc/docs 全部存活——对外承诺的行为成了死开关（`src/index.ts` 引用数为 0，二审 P-18 揪出）。删改任一执行路径前，grep 该路径消费的每个配置字段的引用数；UI/locale 承诺与运行时行为发版前必须对账。

## 客户端/宿主边界（v0.0.4 轮沉淀，2026-11-11 桌面启动崩溃 P0）

- **客户端半边禁止值导入 `src/config.js`**：config.js 顶部 `import z from '@deepseek-ai/schemastery'`——桌面 client-modules 加载器的模块表里没有它（构建期宿主外部件），值导入会把 require 拖进 client bundle → **整个 web boot 拒活**（v0.0.4 测试包实测崩溃，弹窗 "require(\"@deepseek-ai/schemastery\") missed the module table"）。**类型导入（`import type`）编译即擦除，安全**。宿主/客户端共享常量必须放 `strategy.js`/`pin.js` 这类零宿主依赖模块（`MAX_NAME_MAP_ENTRIES` 先例）。机械守卫：`tests/client-boundary.spec.ts` 双扫源码值导入＋成品 bundle 字符串。教训链：单测在 node 环境能解析 node_modules 故全绿——**此类边界只有真实桌面/隔离 E2E 能暴露，人工实测门不可省**。
