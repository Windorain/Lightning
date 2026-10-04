# 部件 E2E 断言包 —— helpers/parts 说明（P2.5 fixture 包 + P3.1 真实导出包）

> 计划依据：`docs/plan/non-full-cube-parts-plan.md` §4 P2.5 + §5 P3.1；契约：`docs/plan/format-parts-contract.md`。
> 运行：
> ```powershell
> cd web
> npx playwright test parts-hover-stats.spec.ts parts-falsification.spec.ts --retries=0  # P2.5（fixture）
> npx playwright test parts-real-export.spec.ts --retries=0                               # P3.1（真实导出）
> ```
> P3.1 包需要产物：`PARTS_ACCEPTANCE_DIR=<归档>`（缺省取最近一次 `scripts/parts-acceptance/.out/*`；
> **缺失即显式失败**，不静默跳过）。两个 project 都跑；展开态统计交互为 desktop-only，理由见 §3。
> 本目录只做**测试**，不改 `web/src/`。零替身五原则与多方块轮完全一致
> （`helpers/multiblock/README.md` §2），此处只登记部件轮的增量口径。

## 1. 文件

| 文件 | 作用 |
|------|------|
| `helpers/parts/hover.ts` | Wiki 工作区切入（生产 WorkspaceTabs DOM click）、格内局部坐标 → 正交相机投影 → `pointermove` 注入、悬停状态/tooltip DOM 读取 |
| `helpers/parts/statsSidebar.ts` | 统计侧栏 DOM 读取（物品行键/图标键/**B-5 选中态 / 无对应标记 / 锚点 / 会话提示**、窄布局自愈展开、**稳定性等待**）、**B-5 点选驱动**（`clickStatsRow` / `clickStatsBlank` / `pressStatsEscape`）、**行图标槽 canvas** |
| `helpers/parts/fixtures.ts` | fixture 只读读取、内存深拷贝、**几何增强**（双绕组面追加）、textureBlobs 归一化、解析级部件观测（Grid API；含盒快照与 `properties`） |
| `helpers/parts/realExport.ts` | **P3.1**：真实产物/oracle 读入与定位（`PARTS_ACCEPTANCE_DIR`）、`grid:[zi,ri,ci]` 格映射、**探针候选点推导**、`probePartHover`/`probeAnyOfParts`、运行时定义根字段存活观测 |
| `../../parts-hover-stats.spec.ts` | P2.5 主断言包：加载解析 / 悬停 / 统计（物品清单 + 无对应标记）/ 图标键 / 无部件回归 |
| `../../parts-item-select-b5.spec.ts` | **B-5 主断言包**：点选物品行 → **生产描边通道** mask（部件级 / 并集 / 无对应不高亮 / 多选语义 / 证伪） |
| `../../parts-falsification.spec.ts` | P2.5 证伪：篡改计数 / displayName 的内存副本 → 对应断言必红 + 定向对照仍绿 |
| `../../parts-real-export.spec.ts` | **P3.1 主断言包（真实产物）**：加载渲染 / 解析级逐格与 oracle 一致 / 单盒区悬停 / AE2 同格多部件不同 tooltip / 满方块回归 / 统计与 `expectedCounts` 精确比对 / **F1F2 修复锁（正向）** / degraded_all 档位与统计 |

> **⚠️ 已移除 UI 的断言不留**（B-3 决策 C 移除了「视图切换工具条 / 视图按钮 / 配置来源徽标 /
> provenance 面板 / 宿主行」；B-4/B-5 接手物品行的悬停说明与点选）。本目录与三个 spec 中
> 面向这些 UI 的读取器与断言**已整套删除**（`switchStatsView` / `readProvenance` /
> `toolbar` / `viewButtons` / `pill` / `data-stats-row-kind`）——留着就是确定性坏断言。
> 现行可读面见 `statsSidebar.ts` 文件头。

## 2. 为什么经 Wiki 工作区（EmbedPreview）

部件 tooltip（`ToolTipBox`）与统计侧栏（`BlockStatsSidebar`）的生产宿主是
**EmbedViewport**；Workbench 预览视口不渲染这两个 DOM。`WorkbenchRoot` 的
Wiki 工作区内嵌生产 `EmbedPreview`（= EmbedViewport，特性开关来自
`embedPublish` 默认值：侧栏/标题栏开），因此断言路径 = WorkbenchRoot 挂载 →
`OPERATOR_OPEN_SCENE` 注入 → **生产 WorkspaceTabs 点击**切 Wiki 工作区 →
DOM 事件注入 → 公开观测（`ctx.viewports.get('r-wiki-preview')` /
`ctx.region('r-wiki-preview').state.hover` / 生产 DOM）。没有为测试新开任何
src 侧后门。

## 3. 已登记的口径与发现（全部已上报调度者）

1. **几何增强副本**（`fixtures.ts` 文件头）：悬停是真实 raycast，fixture 几何
   （含 c98351a 补全后）单绕组背向 init 相机、AE2 切换总线补面被最小体积规则
   判给线缆 —— 原件几何对悬停物理不可达。悬停用例注入**几何增强内存副本**
   （部件数据与原件逐字节一致，只追加双绕组命中面）；统计/回归用例注入原件。
   **P3.1 真实导出不需要增强**（几何来自 mod 捕获链，完整）——真实包的探针点是从
   导出文件自己的部件盒**派生**的候选序列，逐个试探到命中目标部件即止。
2. **textureBlobs 归一化**：fixture 与 minimal-v2 的 textureBlobs 是对象数组，
   渲染管线只认 string[]（multiblock README §7 开放项 4 的既有口径）——
   内存副本归一化后网格才能构建（悬停前提）；侧栏不受影响。真实导出的
   `textureBlobs` 已是 `string[]`，无需归一化。
3. **mobile 窄布局自动折叠振荡（实现发现，不代修）**：展开侧栏 → 嵌入根宽
   361→445px → profile tiny→narrow → 生产 watcher ~50ms 内再折叠。展开按钮
   在该带宽带自失效；窄布局折叠本身是 embed-mobile.spec 锁定的预期。
   因此**展开态统计交互（行文本 / B-5 点选）仅 desktop 跑**
   （`EXPANDED_SIDEBAR_DESKTOP_ONLY`），mobile 跑解析级 + 悬停（不依赖展开态）。
   P3.1 包同此口径（AE2 同格多部件需多轮候选试探，另记一条 desktop-only 理由）。
   **B-5 追加实测**：装配期重挂载会连 **EmbedViewport 自身**一起重建（`sidebarCollapsed`
   被重置即证据），视口侧的选择状态随之归零 ⇒ 过早驱动点选会被静默吞掉。故
   `waitStatsSidebarStable`（连续两次读数一致）是 `clickStatsRow` 的前置条件；
   B-5 主断言包用它在每次点选前越过该窗口。
4. **历史阻断（已闭环）**：深响应式 `ref` 下 `structuredClone` 遇 Vue Proxy 必炸
   （serialize/clone 对含部件文档全表面不可用）——本包擒获上报后由实现侧
   c98351a 修复（`deepCopyPlain` + `reactivePartsDoc.test.ts` 回归锁定）。
5. **P3.1 擒获的 F1/F2 已修复，偏差锁已翻转为正向锁**：
   - **F1（已修）**：真实导出是 `geometryPhase=baked` 的 StructureData，走 `StructureDataParser`；
     该解析器此前不透传**文档根级** `statsTemplate`/`statsOverride`/`partIconTextures`
     ⇒ 渲染定义根上没有文档默认统计层（契约 §9 第 1 级）⇒ 侧栏来源徽标 = "内建默认"。
     修复 = 三个**文档根级**键随 v2 根透传（与 structure 级的 `cellPartsGrid`/`partLists` 分层，
     `builtinParsers.ts#StructureDataParser`）；单元锁定见
     `web/src/context/__tests__/structureDataRootFields.test.ts`（含"旧文件零差异"与
     V2Plain `_extra` 链路核验）。fixture（V2Plain，未知根字段进 `_extra`）本就不受影响。
   - **F2（已修）**：`partIconTextures` 此前在 web 侧无消费接线（`EmbedViewport` 未把该根字段传给
     `BlockStatsSidebar`）⇒ 部件行图标只走宿主调色板回退（AE2/EnderIO/FMP 物品键非方块键 ⇒ 占位空槽）。
     修复 = **prop 传递**（`EmbedViewport.vue` 从渲染定义根读该字段 → `:part-icon-textures`；
     注入点沿用 P2.4 已建好的 `BlockStatsSidebar` watch → `BlockIconCache#setPartIconTextureSource`）。
   - **锁已翻转**：`parts-real-export.spec.ts` §C2 由"断言偏差状态"翻转为正向断言
     （徽标 = `document-default`、定义根字段与文件逐值一致、**有纹理来源的部件行图标槽必须渲染出
     canvas** —— `waitStatsRowIcons` 的生产 DOM 观测）。原本"实现修好时主动变红"的机制由此完成闭环。
   - **残留（新登记，本包写范围外不代修）**：FMP 三行的**行图标键**是 `...#mat=<材料串>`
     （= `part.typeKey`），而 `partIconTextures` 的键是**物品身份键** `...#<材料串>`
     （`PartItem.iconKey()`）⇒ 这三行取不到嵌入纹理，仍落回退/占位。以 finding `F2b` 写进
     `l2-observations.json`（不判红，不静默）。
6. **平面类部件零厚度盒（测量观察）**：AE2 破坏面板（`:300`）碰撞盒在 y/z 两轴零厚度
   （视觉盒有厚度）——平面语义的如实快照，非契约违例；盒判据 = "逐轴 min≤max + 非全轴退化"。
7. **格映射两套下标（实测擒获）**：oracle `grid:[zi,ri,ci]` 的行号是 `y-top-first`
   （自上而下），而页面 `Grid.partsAt` 的 `y` 是 Y-up（`y=0` = 底部）⇒
   `y = height - 1 - row`（`realExport.ts#gridApiPosOf`）；导出文件的 `cellPartsGrid`
   用的是 oracle 那一套。混用会让"格定位"整体错位（本包首轮实测）。

## 4. 反同义反复

**P2.5（fixture 包）**：期望值（部件名/localId/typeKey/计数/行键/图标键/provenance 迁移）
全部硬编码于 spec，不读被测文件；篡改内存副本 → 对应断言必红
（`parts-falsification.spec.ts`，含「红色来自断言而非解析失败」「定向对照仍绿」两条纪律）。

**P3.1（真实包）**：36 格 598 项不可能硬编码（等于把断言钉死在某一轮产物上），因此：
- 期望值 = oracle（mod 侧建造意图 + L1 逐格核对）+ 导出文件自身的部件数据，二者不互相替代；
- 硬编码锚点：`EXPECTED_COUNTS_ENTRIES=21` / `EXPECTED_COUNTS_TOTAL=61`（由 oracle 派生的行集必须吻合）；
- 交叉自检：AE2 同格多部件必须得到**两个不同的 tooltip**，且各自含自己的 displayName；
- 逐格一致性由 L1 内嵌 verifier（游戏内）与 `verify-oracle.mjs`（Node）**两个独立实现**各自断言，
  L2 只消费；证伪（篡改 oracle / 删部件 / 改计数）在 `scripts/parts-acceptance/falsification.mjs`。
