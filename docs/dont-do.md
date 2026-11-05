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
- **CI 发布链的 token 有效期检查**：release.yml 的 `secrets.NPM_TOKEN` 指向的令牌可能已被账号清理（2026-11 用户清理过）；且该类 token 2027-01 失去直接发布资格。每次发 tag 前先确认 secret 指向的令牌仍存在有效；2026-12 前完成 trusted publishing（OIDC）迁移或改走人工终端发布。（处置：v0.0.3 起 release.yml 已删除 npm publish 步骤、改走用户终端 Touch ID 发布——2026-12 OIDC 迁移死线随之解除；若未来恢复 CI 无人值守发布再启用 OIDC。）
