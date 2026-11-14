# 上游反馈草稿：llm-deepseek 目录 id/name 分裂使能力解析层失明（未提交）

> 状态：草稿。dsh-subagent-plus F 轮（ADR 0016 3b）定位的上游治本项；
> 按 release gate 需用户明示后才向 deepseek-harness 仓库提 issue。
> 目标仓库：deepseek-harness `packages/llm/llm-deepseek/src/models.ts`。

## 现象（用户实测）

桌面端模型目录显示 `DeepSeek · DeepSeek-V4.1-Flash`，用户把它加入
dsh-subagent-plus 候选清单后，Team（角色关键词 → 路由）默认映射不发生
任何重派——插件侧按能力评分派生时该候选解析为"未收录"。

## 根因（插件侧已实证）

`llm-deepseek/src/models.ts` 的目录条目是
`{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }`：

- **存储 id 是裸官方名 `deepseek-flash`**——不带世代中缀；
- **显示名却是 `DeepSeek-V41-Flash`**——带 V4.1；
- 任何以模型 id 为键的知识/基准层（LMArena 系条目键均为
  `deepseek-v4.1-flash(-max)` 形态）对裸 id 全部 miss。

同文件另一条目 `{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }`
id/name 一致，解析正常——两处命名约定互相不一致。

## 建议上游修复（任一即可，按偏好排序）

1. **id 补世代中缀**：`id: 'deepseek-v4.1-flash'`（与显示名和官方
   benchmark 命名一致；破坏面＝已存配置里的旧 id，需要迁移或兼容读取）。
2. **维持 id 不变、目录元数据增加 canonical/alias 字段**，供下游插件
   与知识层对齐（无破坏面）。

## 插件侧已做的兼容（过渡期）

dsh-subagent-plus v0.0.4 F 轮内置官方别名表
`OFFICIAL_ID_STEMS: { 'deepseek-flash': 'deepseek-v4.1-flash' }`
并配单测钉住——上游修复落地后该行应随 KB 快照重建退役（有 spec
不变量自动提示：别名表键一旦成为 KB 键即报警）。

## 附：解析层加固的完整结论（供上游参考）

269 条真实世界 id 的实证审计：官方裸 id 命中率 80%（唯一 miss 即本
案例）；KB/知识层桥接无法从显示名取信息（显示名从不进入请求路径），
**id 是唯一可靠输入**——id 命名稳定性因此是上游 API 的一部分。
