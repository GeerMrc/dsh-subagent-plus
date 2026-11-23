# v0.0.4 发布日操作清单（Runbook）

> 发布日人工操作指引，**发布前须人工审核确认**（用户定夺），不自动执行。
> 版本纪律：v0.0.4 定档；合并/推送/发布均待用户明示。

## 前提条件

- 本地 HEAD = 发布提交（375 测试全绿、typecheck/build 0）
- `gh auth status` 已登录 `GeerMrc`
- 分支拓扑已核：`feat/v0.0.4-byname-map` 领先 `origin/main` 159 提交、落后 0（可无冲突快进）

## 阶段 A｜合并到 main（先推分支，再打 tag——同批推送不触发工作流）

```sh
# 用户批准后：
git checkout main && git merge --ff-only feat/v0.0.4-byname-map
git push origin main
```

## 阶段 B｜发布提交：移除 private:true ＋ 同批移除契约绊线

```sh
# 1. package.json 移除 "private": true
# 2. tests/manifest.spec.ts 移除 "stays private until the release commit" 断言
# 3. 全套测试绿（绊线漏删会在这里失败——仍在建 GitHub Release 之前）
pnpm test
# 4. 提交并推送 main
```

## 阶段 C｜OIDC 绑定（发布日创建，首次成功发布须在 2 天内）

npmjs.com → 包设置 → **Trusted Publishing** → 添加：
Owner `GeerMrc` / Repository `dsh-subagent-plus` / Workflow `release.yml`。

## 阶段 D｜打 tag 触发自动发布

```sh
git tag v0.0.4 && git push origin v0.0.4
```

工作流：**release-preflight（tag↔版本／非 private／未重复发布，注册表 fail-closed）**
→ 四门 → pack → GitHub Release（附 tarball）→ OIDC `npm publish`。

## 阶段 E｜发布后验证（三项）

```sh
npm view dsh-subagent-plus versions --json --registry https://registry.npmjs.org
npm view dsh-subagent-plus dist.shasum --registry https://registry.npmjs.org
shasum dist-artifacts/dsh-subagent-plus-0.0.4.tgz   # 与上对比
curl -sI https://registry.npmjs.org/dsh-subagent-plus/-/dsh-subagent-plus-0.0.4.tgz | head -1
```

## 失败恢复

- OIDC 发布失败（绑定过期/未建）：GitHub Release 已建——手动发布兜底见 docs/upgrade.md §6
  （用户交互终端＋Passkey；一切 npmjs 操作显式 `--registry https://registry.npmjs.org`）。
- pre-flight 拒绝：按报错修正后删 tag 重推（`git push origin :refs/tags/v0.0.4`）。

## 安全纪律

| 规则 | 原因 |
|---|---|
| 一切 npmjs 操作显式 `--registry` | 本机默认 npmmirror |
| 不建 bypass-2FA granular token | 2027-01 起失去发布资格 |
| 失败后停手隔天再试 | 连续敏感操作触发 24-72h 账号冻结 |
| 先推 main 再推 tag | 同批推送不触发工作流 |
| private 与绊线同批移除 | pre-flight＋pnpm test 双重拦截 |
