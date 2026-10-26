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
