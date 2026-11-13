# 0015 — 能力感知派生＋四项 UI 修正（v0.0.4 未发布原地）

日期：2026-11-14 ｜ 状态：用户批准 ｜ 关联：[0014](2026-11-derived-default-mapping.md)、[0007](2026-11-byname-mapping-b.md) ｜ 取代：0014 决策 1 的序数槽位、0007 决策 7 的五轨行

## 背景

用户实测五问：① 恢复默认按钮在 defaults 态设计性隐藏＋两按钮确认链复杂（要求单按钮常驻）；② 行尾 × 删除弹层溢出设置页（应挂序号悬停、宽度让给模型框）；③ 候选清单行"一大一小"两行渲染（坐实是我们自己 RowNameCell 的 label+sub 双 span，内部 0.2.2 起既有，非宿主引入）；④ 子窗口徽章 `strata/Qwen3.8-Flash-Next-NVFP4` 被 `maxWidth:240` 截断；⑤ 派生只按候选**顺序**取位（尾部增删只动 F 族），要求按候选**能力**指派。

宿主元数据调研（0.2.2-rc.3 asar 直扫＋官方仓库）：`contextWindow` 官方双型号同值 1M（零区分度）；**价格被宿主刻意置零（NO_COST）不可得**；真实可用信号＝`reasoning.efforts` 梯子结构（架构级同源——wire 的 reasoning 本出自 resolveModelInfo）＋`description` 文本（现役 adapter 事实同源：deepseek 两路同汇 catalogModelInfo、pi-ai 两路皆无；结构上无保证——分层记录，仅作 tie-break）。rc.3 兼容快查：namesOf／agent/inbox/claimed／agent.model.select／resolveModelInfo／subagent 工具 schema 全在位。

独立二审：3🔴（R1 评分定义域缺口／R2 两侧候选集合不对称／R3 归一化脏态回归）＋7🟡，全部吸收。

## 决策

### 1. 能力评分派生（取代序数槽位）

`capabilityScore(candidate)` 字典序 **[topTierRank, activeTierCount, descHint]**：

- **topTierRank**＝active（非 off/none）档在公认梯子 `off<minimal<low<medium<high<xhigh<max` 的最高位。**无 active on-ladder 档（off-ladder-only 词表或 efforts 缺失）＝固定 floor**，排在所有 on-ladder 模型之后——与"无档位模型可作候选、物化 ''"的既有语义兼容（floor 模型永居 F 族除非全并列）（R1）。
- **activeTierCount**＝非 off/none 档数——**明示为 tie-break 而非能力信号**（更丰富的梯子给 mid 意图更多物化空间；"档多≠更强"的反例已知，故只破并列不改主序）（Y-4）。
- **descHint**＝description 正则 `/higher cost|stronger|premium|quality/i` 记 +1、`/fast|flash|lite|cheap/i` 记 −1，**求和可相消**；缺失/非英文→0。**仅破并列**——description 非结构性同源（现役事实同源、未来 adapter 可分叉），降级为末键使潜在分叉不影响主序（Y-1）。

**槽位指派**：候选按评分**降序稳定排序（并列保持候选清单存储序＝用户偏好 tie-break）**→ S=首位（最强）、B=`max(1, floor((n-1)/2))` 上中位、F=末位（最弱/最快代理）。任何候选增删改**全表重评**——"清单尾部追加更强模型→review 族换到它"（用户判别点）。

**同源约束（R2 裁定）**：两侧候选集合统一为 **priority 逐字**——客户端停止单方面过滤 available（过滤是客户端自引的；未可用派生行已有 routeNotListed/catalogHit 展示路径）；评分输入两侧同源（efforts 架构级；description 事实级）。分叉测试覆盖"候选含未编目模型"（运行时 resolveModelInfo 仍可给 floor 模型 efforts——deepseek 未编目型号有全梯，两侧输入都以运行时目录为准时不分叉；客户端以 wire 目录为准，未编目＝efforts 缺失＝floor——两侧 floor 位置一致）。

**限制如实声明**：元数据相同的模型（如同词表两个 qwen）不可区分，行为与序数版一致（存储序）；价格维度不可实现（宿主置零）；能力元数据质量取决于部署方目录；逃生门＝custom 模式。上游改进方向（不属本插件）：wire 暴露 contextWindow/modalities。

### 2. 恢复默认单按钮常驻

- 渲染门 `!byNameLocked`（defaults＋custom 两态都显示；钉定锁定）。点击直接 `resetNameMapDefaults()`——**只改 draft，不保存即撤销（安全屏障）**；title 明示"将清空全部自定义行，保存后生效"。
- 删 resetArmed 确认链与 resetConfirm/resetCancel 键。附带收益：defaults-on＋手编存量行的 degraded 态下按钮不再消失（原 `!nameMapDefaults` 门把清 degraded 的入口也藏了）。

### 3. 删除挂序号 chip＋四轨行

- RemoveMenu 增 trigger 槽：序号 chip 包进锚 span（悬停开＋点击固定＋外点/Esc 关，RowNameCell 同构几何——锚首列、弹层右扩不溢出）。
- nameMap 行 grid 五轨→四轨（chip/关键词/模型/档位），1fr 模型轨自然加宽；removeTriggerStyle 删除；**取代 0007 决策 7 的五轨设计**（Y-5）。

### 4. 候选行单行化

RowNameCell 双 span（label 13px＋sub 11px provider/model id）坍缩为单行 label（不可用时后缀"· 不可用"），完整 id 进 title；routeSubStyle 删除。**取舍记录**：行高一致化＋宽度诉求 vs 原始 id 从可见面退到 title——用户终审确认点；同名 modelName 双 provider 仍可区分（providerName 在 label）。

### 5. 徽章放宽

`badgeStyle.maxWidth` 240→360；双段 ellipsis＋flexShrink 链保留为窄窗兜底；title 已有全文。

### 6. #sync 双侧归一化（R3）

value 与 draft 在同一边界（#sync）一起过 `resolveNameMapDefaults`——缺键文档打开即 clean（无幻影脏态）且 effectiveNameMap=派生；保存只在真实编辑后出现。

## 不动面

语义档位物化（0014 d1／mid 上中位）、copy-on-write、R1 spread 门控、三时机重派生、respectExplicit、统一保存、上限 32。
