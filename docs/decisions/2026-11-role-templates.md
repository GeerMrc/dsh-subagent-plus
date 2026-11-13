# 0011 — 角色模板一键配置

日期：2026-11-13 ｜ 状态：用户批准（v0.0.4 未发布原地补丁）｜ 取代：0008 决策 7 中"预置模板（不做）"｜ 决策 1/2 部分被 [0013](2026-11-universal-starter-template.md) 取代（2026-11-13：四模板→单通用配置、语义档位、分模式容量）；决策 3/4/5 存活

## 背景

用户实测确认 agent.model.select() 架构可用，但角色关键词需手动输入门槛高。深度调研（28 名队友样本＋社区共识＋量化研究＋UX 先例＋九维上下游兼容审核）确认一键模板可行且必要。9 个通用关键词覆盖实际队友 82%。

## 决策

### 1. 四模板定义（槽位制）

槽位声明路由需求，实际路由从候选清单按序位填充（不硬编码 provider/model）：
- S=候选清单第 1 位（用户偏好首位，通常最强）
- B=中位
- F=末位（通常最快/最便宜）

| 模板 | 显示条件 | 关键词→槽位＋effort |
|---|---|---|
| T1 质量优先 | ≥2 条路由 | reviewer/auditor/verifier/planner→S＋high；builder/dev/executor/research/tester→B |
| T2 三档分层 | ≥3 条路由 | 同 T1 的 S 组；builder/dev/executor/research→B；tester→F＋low |
| T3 同模分档 | 恰好 1 条路由＋有 efforts | 全部 9 词→唯一路由；S 组→high；B 组→默认；tester→low |
| T4 内容生产 | ≥2 条路由 | research/reviewer→S＋high；dev/builder/executor/render→B；tester→F |

### 2. 五硬化约束（来自九维兼容审核）

- H1：模板下拉三重禁用＝byNameLocked || 满 16 行 || 候选清单空（与手动添加完全一致）
- H2：路由目标解析自 listed 数组按序位映射（防 structural 拒保存）
- H3：关键词全部预验证 isValidKeyword（lower-kebab ≥2 字符 ≠lead）
- H4：应用前检查剩余容量（16−现有行≥模板所需行），不够时返回 insufficient-capacity
- H5：无档位路由的 effort 传 ''（避免 stale 存储值）

### 3. 确认对话框语义

非空表时选中模板→返回 confirm 状态→UI 显示 inline 三选（替换/合并/取消）。替换＝清空后应用；合并＝跳过同名关键词行、追加其余。空表直接应用。

### 4. 模板与手动添加的关系

模板只是对 draft 的一串既有 controller 调用（addNameRow＋setNameRowName＋setNameRowRoute＋setNameRowEffort）。应用后每行与手动添加的行完全无差别——可编辑、可删除、可追加。无"模板模式"标志、无锁定。

### 5. 不动面

服务端零改动。现有手动添加/编辑/删除完全不变。ADR 0006-0010 语义面不变。cordis.patch.yml 不动。
