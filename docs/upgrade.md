# 升级与发布手册

## §1 安装方式对照

| 方式 | 命令/操作 | 适用 |
|---|---|---|
| `dsh plugin add`（tarball） | `dsh plugin --profile desktop add /path/to/dsh-subagent-plus-<ver>.tgz` | 常规升级；自动维护依赖键与 bundles 数组 |
| `dsh plugin add`（npm） | `dsh plugin --profile desktop add dsh-subagent-plus@<ver>` | 有 npm 时的标准路径 |
| file: 依赖 | profile `package.json` 依赖键 + `dsh.profile.bundles` 数组同名条目 + `pnpm install` | 脚本化/离线 |
| 源码 | clone → `pnpm install && pnpm run pack:artifact` → 走 tarball | 开发者 |

## §2 生产升级 runbook（五步）

1. 备份：`cp ~/.dsh/profiles/desktop/{package.json,cordis.patch.yml} ~/`（或带日期后缀）。
2. 依赖行换新版本（或 `dsh plugin add`）；**版本回退（高→低）或同版本换包**需 `rm -rf node_modules/dsh-subagent-plus && pnpm install --force`。
3. 重启桌面端。
4. 验收冒烟：设置页正常回显既有配置；派一个子 Agent 看转录提示/徽章；`--dump-config` 核对插件条目。
5. 回滚（分钟级）：还原两个备份文件 → 重装旧 tarball → 重启。

## §3 宿主（DSH）升级适配

上游发布新版本后执行三步检测：① bump devDependencies 到新版本 → ② `pnpm run typecheck` → ③ `pnpm test`（含真实 cordis waterfall 冒烟）。任一步失败即契约漂移，按报错修对应半边；再跑一次隔离 E2E（docs/e2e-manual.md）。

## §6 发布链失败恢复（§4–§5 预留）

**标准发布链（v0.0.4 起，OIDC 信任发布）**：发布日在 npmjs.com 包 Settings → Trusted publishing 绑定 GitHub Actions（owner=GeerMrc / repo=dsh-subagent-plus / workflow=release.yml / 开启 Allow npm publish；**绑定 2 天内未首发即过期**）→ 推 main → 单独推 tag → CI 四门＋GitHub Release（附 tgz）＋**npm publish（OIDC，无 token）** → registry 三验：`npm view` versions/latest、`dist.shasum` 与本地 tarball 逐字节一致、新旧 tarball HTTP 200。

**OIDC 发布失败（ENEEDAUTH/E403）排查序**：workflow 文件名大小写与扩展名精确一致（release.yml）；`id-token: write` 在位；runner 为 GitHub 托管（自托管不支持）；`package.json` `repository.url` 与仓库精确一致；npm ≥ 11.5.1 / Node ≥ 22.14（workflow 已内置升级步）。**绑定不可编辑**——字段写错只能删除重建（重建会刷新 2 天首发窗口）；每包最多 10 个绑定。

| 中断态 | 恢复 |
|---|---|
| build/pack 失败 | 修复后**删除远端 tag 重推**（同 tag 重推不重跑） |
| release create 瞬时失败 | Actions 页面 Re-run——**注意 Re-run 会重跑整个 job 含 npm publish**：版本可能已在库（上次实际成功/在途事务已定稿），先 `npm view` 核实再决定 Re-run 或直接收工 |
| npm 上架失败（OIDC 或终端） | OIDC 侧按上方排查序；人工兜底（Release 已建，仅缺 npm）：用户终端 `npm publish ./dist-artifacts/<pkg>.tgz --registry https://registry.npmjs.org --access public`（npm ≥ 11.7＋通行密钥 Touch ID；**token 短时效——报 E404 假象＝`npm whoami` 验 token、失效重新 `npm login` 后立即发布**；多为认证/风控时按 dont-do「npm 认证与删除」冷却 24-72h） |
| 已发布需改内容 | bump 版本重走全链；**禁止** force 覆写已发布版本 |

**首批推送事故预防**：workflow 文件首次出现在远端时，同批推送的 tag 不触发 workflow——先推 main（workflow 落库），再单独推 tag；`npm pack --pack-destination` 要求目标目录存在（打包脚本已内置 mkdir）；`npm publish` 参数必须带 `./` 前缀（裸含斜杠名会被解析为 GitHub spec）。
