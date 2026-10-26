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

## §6 发布链失败恢复

| 中断态 | 恢复 |
|---|---|
| build/pack 失败 | 修复后**删除远端 tag 重推**（同 tag 重推不重跑） |
| release create 瞬时失败 | Actions 页面 Re-run |
| Release 已建但 publish 失败 | `gh release delete <tag>` 后 Re-run；或手工 `npm publish ./dist-artifacts/<pkg>.tgz --registry https://registry.npmjs.org`（必须显式 --registry） |
| 已发布需改内容 | bump 版本重走全链；**禁止** force 覆写已发布版本 |

**首批推送事故预防**：workflow 文件首次出现在远端时，同批推送的 tag 不触发 workflow——先推 main（workflow 落库），再单独推 tag；`npm pack --pack-destination` 要求目标目录存在（打包脚本已内置 mkdir）；`npm publish` 参数必须带 `./` 前缀（裸含斜杠名会被解析为 GitHub spec）。
