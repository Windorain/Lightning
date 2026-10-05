# Lightning 非满方块（部件）支持 — 执行计划

> **读者**：下游调度者代理。你负责并发调度子代理执行编码任务、把控全局质量与验收。
> **依据**：《Lightning 需求与设计方向说明书 — 非满方块（部件）支持：悬停说明 + 精确物品计数》（下称《需求书》）。本计划不重复《需求书》的论证，只将其翻译为可执行任务、依赖关系与自检标准。
> **铁律**：凡《需求书》标记【硬约束】的条目，调度者把关时**逐条核对，不得妥协**；标记【留白】的条目由执行方拍板，但**必须在代码或文档中留下决策记录**。
> **前置资产**：本计划复用多方块轮已建成的自动化验收管线（游戏内自动导出 + Playwright 无头断言，见 `docs/plan/multiblock-channel-renderer-plan.md` T1.6/T2.6）。本轮只估**增量**：oracle 生成器 + 新断言包 + 测试结构定义，管线骨架不重造。

---

## 0. 交付总览与完成定义

| # | 交付 | 完成定义（实现侧自检标准） |
|---|------|---------------------------|
| A | 场景文件表达部件 | 文件能表达「宿主方块 + 格内 N 部件」；满方块/单盒非满/多部件混存互不影响；每部件五要素齐全（格内定位、跨格类型键、空间盒、显示名+说明、物品身份）；盒带来源四元组（族/兜底与否/视觉或碰撞/档位）；无部件信息 = 行为与今天完全一致 |
| B | 悬停说明到部件 | 指向同格不同部件得到不同说明；命中判定区分部件不只到格；满方块与单盒非满悬停行为不劣化；说明优先级链（物品说明 → 部件自定义 → 宿主回退）任何情况有话说；逐格说明保留为人工叠加层 |
| C | 精确计数 + 可配置统计栏 | 统计到部件粒度，单位是**可合成物品**；默认口径 = 部件物品清单；"宿主清单"（旧口径）保留为可选视图；三级配置（文档默认/文档覆盖/查看者本地）；图标与名称取部件物品 |
| D | 接口式架构 | 新接一族 = **注册一个提供者**，不动核心流程；同格多族结果可合并且标识不冲突；缺接口/反射失败**静默降级**继续导出；三档兜底（族权威 → 通用盒 → 几何推断）每档记录来源；**单盒族零 mod 代码全覆盖**（slab/火把/箱子/栅栏） |
| E | 自动化验收增量 | oracle 由建造脚本同步产出；测试结构经"建造 → 自动导出 → L1 文件断言 → L2 无头渲染断言"全自动验证；断言注入 `acceptance-report.json`；含证伪测试 |

**已拍板事项（用户指令）**：真·缺 mod 场景**不做**——目标环境默认 GTNH 全量装载。降级能力用**提供者开关/反射失败注入**模拟验证，不建精简实例环境。

**验收口径说明**：《需求书》§7 声明"本轮不出验收口径"。上表是实现侧自检线；最终验收口径以用户后续指令为准，调度者届时需补齐并转化为管线断言。

---

## 1. 阶段划分与依赖图

```
Phase 0 探针与契约（串行为主）
  P0.1 部件数据现状盘点（上一轮"同一份数据"在哪、什么形态）
  P0.2 三族接口反射可达性探针（AE2 / EnderIO / FMP）
  P0.3 单盒通用路径验证（原版 API 覆盖 slab/火把/箱子/栅栏）
       └──────────┬──────────┘
                  ▼
  P0.4 部件数据契约定稿（提供者契约 + 文件表达 + oracle 格式）
                  ├──→ 手工 fixture（含部件数据的场景文件）
                  ▼
Phase 1 mod 侧                    Phase 2 web 侧（靠 fixture 并行）
  P1.1 提供者框架+注册表+三档兜底    P2.1 部件数据解析与运行时模型
  P1.2 单盒通用提供者               P2.2 悬停命中到部件 + 说明优先级链
  P1.3 AE2 提供者 ┐                 P2.3 统计引擎（物品粒度+三级配置+三视图）
  P1.4 EnderIO 提供者 ┼ 并行        P2.4 统计栏 UI + 配置入口
  P1.5 FMP 提供者 ┘                 P2.5 E2E 断言包（接入既有管线）
  P1.6 几何推断兜底（升格 partDetect 思路到 mod 侧快照）
  P1.7 导出集成（部件数据+说明+物品身份+统计默认值落盘）
  P1.8 测试结构建造器 + oracle 生成器
       └────────────┬───────────────┘
                    ▼
Phase 3 集成与验收（E 管线驱动，零人工）
  P3.1 测试结构全链路自动验收（建造→导出→L1+L2 断言）
  P3.2 向后兼容与既有行为回归
  P3.3 降级与兜底档验证（提供者开关模拟）
  P3.4 证伪测试（篡改 oracle → 管线必红）
```

**并发关键**：P0.4 定稿后产出**手工构造的含部件数据 fixture**，Phase 2 全部基于 fixture 开发，不等 Phase 1。P1.3/P1.4/P1.5 三个族提供者互相独立，可三个子代理并行。

---

## 2. Phase 0：探针与契约（阻断性，先行）

### P0.1 部件数据现状盘点

- **目标**：《需求书》§1 称"部件盒与上一轮已下发执行的方向是同一份数据"——但 mod 侧检索不到任何 part provider 实现。必须盘清：部件盒目前到底以什么形态存在（仅 `web/src/workbench/tools/partDetect.ts` 几何推断？还是导出链路已有字段？），本轮是在什么地基上盖楼。
- **做法**：通读导出链路（`MeshCaptureService` 调色板条目 L580–624、`StructureScan` cellTypes）、web 侧 `grid.ts` L158 `parts: []` 占位与 `runtimeDocument.ts` L419、proto 预留字段（`plain_v2.proto` L45–55 `BlockPart`、L117–125 `PartRef`、L138+ `StatsTemplate`），输出"现状地图"。
- **产出**：`docs/plan/probe-parts-current-state.md`：已有/缺失/可复用三栏清单。
- **写范围**：`docs/plan/`。
- **自检**：每个"已有"结论附代码行号；明确回答"P1 各任务的起点是真空白还是半成品"。

### P0.2 三族接口反射可达性探针

- **目标**：验证 AE2 / EnderIO / FMP 三族的部件枚举 + 盒获取在**运行时反射**下可行，并记录坐标系归一化参数。
- **参考锚点**（《需求书》附录 A，均已核实存在）：
  - AE2：`appeng/api/parts/IPart.java`、`IBoxProvider.java`、`IPartCollisionHelper.java`、`SelectedPart.java`；`appeng/helpers/ICustomCollision.java`（**视觉/碰撞盒之分在此**）；`appeng/parts/CableBusContainer.java`、`appeng/block/AEBaseBlock.java`（"只框光标所指部件"）
  - EnderIO：`crazypants/enderio/conduit/geom/CollidableComponent.java`、`ConduitGeometryUtil.java`、`TileConduitBundle.java`、`BlockConduitBundle.java`
  - FMP：`codechicken/multipart/TMultiPart.scala`（`getCollisionBoxes`/`getSubParts`）、`PartMap.java`（27 规范槽位）、`TileMultipart.scala`
- **必须回答**：
  1. 各族"枚举格内部件 + 取每部件盒 + 取部件物品身份"的反射调用链是否完整（缺一环即记录）；
  2. 坐标系差异：AE2 为 0–16 像素挂载面局部坐标、FMP 为 0–1 方块局部坐标 —— 归一化到哪个统一空间（建议 0–1 方块局部，Y-up 与 web 侧一致）；
  3. **视觉盒与碰撞盒是否都能拿到**（只拿碰撞盒 = §8.4 像素级不一致的坑）；
  4. 部件 → 可合成物品的映射来源（AE2 Part 的 ItemStack、EnderIO conduit 物品、FMP microblock 物品）。
- **产出**：`docs/plan/probe-family-apis.md`：每族一页（调用链、坐标系、缺口、物品身份来源）。
- **写范围**：探针代码（临时）、`docs/plan/`。
- **自检**：每族有一段真实运行的探针代码 + 输出样例，不是纸上阅读。

### P0.3 单盒通用路径验证

- **目标**：验证"盒 ≠ 整格"判定 + 原版 API 能在**零 mod 代码**下覆盖 slab（上/下半）、火把、箱子、栅栏的盒、说明、计数。
- **参考锚点**：`Block#setBlockBoundsBasedOnState` + `Block#getSelectedBoundingBoxFromPool`（视觉盒）、`Block#getCollisionBoundingBoxFromPool`（碰撞盒）、`Block#addCollisionBoxesToList`（多盒）。
- **必须验证**：盒**依赖邻居与方块状态**（栅栏连接形态、箱子合并）⇒ 盒是导出时快照（§8.2），探针中构造带邻居的场景确认盒随之变化。
- **产出**：`docs/plan/probe-single-box.md`：四代表方块的盒数值 + 邻居影响证据。
- **写范围**：探针代码、`docs/plan/`。
- **自检**：判定函数对满方块返回"整格"（走快速否定路径），对四代表返回正确非整格盒。

### P0.4 部件数据契约定稿（核心留白，本阶段拍板）

- **前置**：P0.1–P0.3 全部完成。
- **目标**：定稿三份契约：① 提供者接口契约（mod 侧）；② 文件中的部件表达（单一数据源，盒/说明/计数共用）；③ oracle JSON 格式（验收用）。
- **必须满足**（逐条核对《需求书》§3、§6）：
  1. 一格 = 宿主 + N 部件；满方块/单盒/多部件混存；无部件信息 ⇒ 与今天行为完全一致；
  2. 部件五要素：格内定位（local id，面/槽/序号）、跨格类型键（type key，合并键）、空间盒（允许多子盒）、显示名+说明、物品身份（无则显式标"无"）；
  3. 盒带来源四元组：族 / 是否兜底 / **视觉或碰撞** / 档位；
  4. **local id 必须族内命名空间隔离**（如 `ae2:center cable`、`fmp:edge_3`）——同格多族合并不冲突是本轮最高技术风险，契约层面必须解决，不得留给实现自由发挥；
  5. proto 处置：启用并视需要扩展 `plain_v2.proto` 已预留的 `BlockPart`/`PartRef`/`StatsTemplate`（注意 `BlockPart` 当前**缺盒字段与物品身份字段**，必须扩展）；改动后 `npm run protocol:gen` 两端同步；
  6. 判定标准：盒 = 整格 ⇒ 走现有路径零改动；盒 ≠ 整格 ⇒ 带盒（§6 建议，采纳为契约）；
  7. oracle 格式：按格列出期望部件（local id、类型键、物品身份、盒档位），按物品列出期望计数 —— 由 P1.8 建造器生成、P2.5/P3.1 断言消费。
- **同时产出**：至少 2 份手工 fixture（一个含 AE2 多部件格的文件、一个单盒+满方块混存的文件），供 Phase 2 开发。
- **产出**：`docs/contracts/format-parts-contract.md` + fixture + proto 扩展（如需）。
- **写范围**：`docs/plan/`、fixture 目录、`protocol/`。
- **自检**：fixture 被 P2.1 解析通过后定稿；契约逐条打勾《需求书》§3.1–3.5。

---

## 3. Phase 1：mod 侧

> 全部任务完成后须 `npm run build:mod:gtnh` 通过。

### P1.1 提供者框架 + 注册表 + 三档兜底

- **目标**：按 P0.4 契约实现部件提供者框架：`PartProvider` 接口 + `PartProviderRegistry`，沿用仓库既有"策略 + 注册表"风格（参照 `meshcapture/primary|postrender|finish` 三套 `*Strategy` + `*Registry` 的命名与容错风格），**不引入新范式**。
- **硬约束核对**：
  - 多提供者同格结果**合并**，local id 命名空间隔离；
  - 任何提供者抛异常/反射失败 ⇒ 捕获、记录、静默降级，**绝不中断导出**（§6.3）；
  - 三档兜底流水线：族权威 → 通用盒（P1.2）→ 几何推断（P1.6），每档结果带来源标记；
  - 满方块快速否定路径：盒 = 整格 ⇒ 零开销直接跳过；未命中提供者零额外开销；结果可缓存。
- **挂载点**：客户端捕获路径（§8.1：权威盒接口仅客户端可用）。
- **依赖**：P0.4。
- **写范围**：`mod/gtnh/src/main/java/com/lightning/mod/client/meshcapture/`（建议新子包 `parts/`，执行方可调整）。
- **自检**：注册一个空提供者，导出行为与基线字节一致；注册一个必抛异常的提供者，导出照常完成且日志有记录。

### P1.2 单盒通用提供者

- **目标**：实现第二档"通用盒"——对**任何**非满方块用原版 API 取盒（视觉盒优先、碰撞盒另存），零 mod 特定代码覆盖 slab/火把/箱子/栅栏。
- **硬约束**：盒为导出时快照（邻居影响已按 P0.3 结论处理）；此类方块物品身份 = 方块物品本身（天然正确）。
- **依赖**：P1.1、P0.3。
- **写范围**：同 `parts/` 子包。
- **自检**：P0.3 的四代表方块全部得到正确盒与说明；满方块不被误命中。

### P1.3 / P1.4 / P1.5 三族权威提供者（并行）

- **P1.3 AE2**：`CableBusContainer` 枚举部件 → `IBoxProvider`/`IPartCollisionHelper` 取盒（**视觉/碰撞都取**）→ 部件 ItemStack 作物品身份与说明来源。参考 `AEBaseBlock` 的"只框光标所指部件"与 `SelectedPart` 的命中语义。
- **P1.4 EnderIO**：`TileConduitBundle` 聚合 → `CollidableComponent`（类型+盒+方向）→ conduit 物品身份。注意其与 Immibis/FMP 微方块同格共存的情形（与 P1.5 结果合并验证）。
- **P1.5 FMP**：`TileMultipart`/`PartMap` 27 槽位 → `TMultiPart.getCollisionBoxes`/`getSubParts` → microblock 物品身份；覆盖"一个微方块跨多格"的表达（§5.4）。
- **共同硬约束**：全部反射接入（§8.3，目标 mod 无编译期 API；复用多方块轮 T0.2 的依赖路线结论，不重新论证）；反射断点逐个 try-catch 降级；坐标系按 P0.2 结论归一化；命名尊重游戏内显示名（§2 硬约束）。
- **依赖**：P1.1、P0.2；三者互相独立，**可并行**。
- **写范围**：同 `parts/` 子包，每族一个文件/子包，互不重叠。
- **自检**：各族在探针结构上导出的部件清单与 P0.2 探针记录一致。

### P1.6 几何推断兜底（第三档）

- **目标**：把 `web/src/workbench/tools/partDetect.ts` + `web/src/pure/aabb.ts` 的几何推断思路**搬到 mod 侧导出时执行**（盒必须是快照，web 端不得重算），作为永远有结果的最后兜底。
- **硬约束**：结果必须标注 `inferred` 档位（§6.4）；**不得**在前两档有结果时使用；已知误判（贴合部件并一）在交付说明中声明。
- **依赖**：P1.1。
- **写范围**：同 `parts/` 子包。
- **自检**：对一个无任何提供者命中的非满方块，推断盒落盘且来源标记正确。

### P1.7 导出集成

- **目标**：部件数据 + 统计默认值写入场景文件，接入既有导出链路。
- **要求**：
  - 部件说明按优先级链生成（物品说明 → 部件自定义 → 宿主回退），复用 `MeshCaptureService` L426–444 的 tooltip 生成机制（`stack.getTooltip`）；
  - 部件图标数据：物品图标嵌入纹理体系（复用 `TextureBlobEmbedder`），供 web 统计栏取部件物品图标；
  - 统计默认值（文档级）写入文件：`StatsTemplate` 默认 = 部件物品清单视图（§5 三级配置的"文档默认"层）；
  - 无部件的导出产物与基线**字节一致**（向后兼容硬证据）。
- **依赖**：P1.2–P1.6。
- **写范围**：`parts/` 子包 + `MeshCaptureService` 的少量扩展。
- **自检**：满方块-only 结构导出与 main 分支基线 diff = 0。

### P1.8 测试结构建造器 + oracle 生成器（E 增量核心）

- **目标**：程序化建造测试结构并**同步产出 oracle JSON**——ground truth 是构造的副产品，不靠人维护。
- **测试结构分区**（每区对应一组验收断言）：

  | 分区 | 内容 | 验收点 |
  |------|------|--------|
  | 满方块区 | 普通机器+外壳 | 向后兼容、快速否定路径 |
  | 单盒区 | slab（上/下半）、火把、箱子、栅栏 | 零 mod 代码全覆盖 |
  | AE2 区 | 线缆总线：N 线缆 + 成型/破坏面板 + 终端 + 伪装板 + 升级卡 | 权威盒、物品身份、"一部件≠一物品" |
  | EnderIO 区 | 多类型导管同格束 | 第二族提供者 |
  | FMP 区 | 微方块（含一块跨格） | 第三族 + 跨格表达 |
  | 叠加区 | **导管束 + 伪装板 + 微方块同格** | 多族合并、id 不冲突（最高风险） |
  | 退化区 | 同结构在提供者开关关闭后重导出 | 静默降级、档位标记 |
  | 变体区 | 异色线缆混放 | 计数键落到物品变体（§8.6） |

- **接入**：挂进既有游戏内自动导出管线（多方块轮 T1.6 资产），一条命令完成"进世界 → 建造 → 导出 → oracle 落盘"。
- **依赖**：P1.7。
- **写范围**：`client/automation/`（或新子包）、oracle 输出目录。
- **自检**：oracle 与导出文件自洽（建造 N 个部件 ⇒ 文件里 N 个部件）；重复运行产物字节一致。

---

## 4. Phase 2：web 侧

> 全部任务完成后须 `cd web && npx vitest run` 与 `npm run build:web` 通过。

### P2.1 部件数据解析与运行时模型

- **目标**：按 P0.4 契约解析部件数据；落地 `grid.ts` L158 / `runtimeDocument.ts` L419 的 `parts: []` 占位。
- **硬约束**：无部件字段的旧文件解析行为不变；round-trip 无损（含 `_extra` 兜底）；编辑路径仍只经 RuntimeDocument/Grid API（CLAUDE.md 纪律）。
- **依赖**：P0.4 fixture。
- **写范围**：`web/src/context/`、`web/src/render/schema/`（类型定义）。
- **自检**：fixture 解析通过；既有 `roundtrip.test.ts` 不红；新增部件 round-trip 测试。

### P2.2 悬停命中到部件 + 说明优先级链

- **目标**：raycast 命中从"格"细化到"部件盒"；tooltip 解析支持部件粒度。
- **硬约束**：
  - 同格不同部件 → 不同说明（§4.1）；命中判定区分部件（§4.2）；
  - 说明优先级链：部件物品说明 → 部件自定义 → 宿主回退（永远有话说）；
  - 逐格说明（`cellTooltipGrid`/`tooltipPalette`，`pure/tooltipResolution.ts`）保留为**可叠加人工补充**，不替代部件说明；
  - 满方块与单盒非满的既有悬停行为**不劣化**（回归断言锁定）；
  - 视觉难区分时显示部件归属（§4 建议）。
- **改动面**：`pure/tooltipResolution.ts`（纯函数扩展）、`embed/useEmbedTooltip.ts`、视口拾取链（`context/queries.ts` pickVoxel 附近）。纯函数先行，保持 `pure/` 无框架依赖的风格。
- **依赖**：P2.1。
- **写范围**：上述文件 + 新纯函数文件。
- **自检**：fixture 中同格两个部件投影位置各得到各自说明；满方块格 tooltip 与基线一致。

### P2.3 统计引擎（物品粒度 + 三级配置 + 三视图）

- **目标**：重写 `render/interaction/blockStats.ts` 之上的统计能力（**旧函数保留**，宿主清单视图直接复用）。
- **硬约束**：
  - 计数单位 = 物品身份；一格多物算 N 件（§5.1/5.2）；
  - "一部件 ≠ 一物品"可表达：升级卡、伪装板、跨格微方块、变体（§5.4）；
  - 旧口径不删除：宿主清单 = 可选视图（§5.3）；
  - 三级配置：文档默认（文件内 `StatsTemplate`）→ 文档覆盖 → 查看者本地（localStorage 级，不影响他人）；
  - 规则能力（§5 建议）：分组键粒度（颜色/朝向/变体）、忽略表、系数换算、别名合并、宿主行开关、排序与分组标题。
- **建议**：统计计算做成 `pure/` 纯函数（输入 = 部件数据 + 规则，输出 = 清单行），UI 只负责呈现。
- **依赖**：P2.1。
- **写范围**：`web/src/pure/`（新统计引擎）、`web/src/render/interaction/`（适配）。
- **自检**：fixture 断言：默认视图 = 部件物品清单且数值正确；切宿主视图 = 旧 `countBlocksById` 结果一致。

### P2.4 统计栏 UI + 配置入口

- **目标**：`embed/components/BlockStatsSidebar.vue` 升级：默认部件物品清单、视图切换（部件物品/宿主/自定义分组）、**图标与名称取部件物品**（`render/interaction/blockIconCache.ts` 扩展部件物品图标）。
- **硬约束**：命名尊重游戏内显示名；旧文件（无部件）侧栏行为与今天一致；配置入口呈现三级来源（默认值来自文档这一事实要对用户可见）。
- **依赖**：P2.3。
- **写范围**：`web/src/embed/components/`、`web/src/render/interaction/blockIconCache.ts`、（如需）workbench 侧对应面板。
- **自检**：fixture 侧栏显示部件物品名与图标；切视图数值变化正确。

### P2.5 E2E 断言包（接入既有管线）

- **目标**：在多方块轮建成的 Playwright 无头管线（零替身五原则）中新增部件断言包，先基于 fixture 开发：
  - 悬停断言：固定正交相机，同格两个部件投影位各注入 pointer 事件，断言 DOM tooltip 分别为两部件事物名；
  - 统计断言：读侧栏 DOM 行与 oracle 精确比对；三视图切换断言；
  - 图标断言：侧栏行图标键 = 部件物品而非宿主；
  - 回归断言：满方块 tooltip/统计与基线一致。
- **依赖**：P2.2、P2.4。
- **写范围**：web 测试目录（既有多方块管线同处）。
- **自检**：fixture 断言全绿；篡改 fixture 一个计数 → 必红。

---

## 5. Phase 3：集成与验收（E 管线驱动，零人工）

> **总入口**：复用多方块轮验收命令骨架，新增部件套件（如 `npm run acceptance:parts`，名称执行方定）。调度者跑命令、读 `acceptance-report.json`、按 §6 清单逐项核对。

### P3.1 测试结构全链路自动验收

- **流程**：P1.8 建造+导出+oracle → L1 文件断言（部件五要素、来源四元组、混存、oracle 比对）→ L2 渲染断言（P2.5 断言包对真实导出文件重跑，替换 fixture）。
- **通过标准**：八个分区全部断言绿；叠加区同格三族部件清单完整且 id 无冲突。

### P3.2 向后兼容与既有行为回归

- **自动断言**：
  - 旧格式文件（无部件）加载后悬停/统计行为与基线一致；
  - 满方块-only 结构新导出与基线字节一致（P1.7 自检的管线级复验）；
  - 逐格说明（人工注解）叠加在部件说明之上正常生效；
  - `cd web && npx vitest run` 全绿；`npm run build:web`、`npm run build:mod:gtnh` 通过；
  - 多方块文档加载与通道切换不回归（共用渲染链路的交叉回归）。

### P3.3 降级与兜底档验证（提供者开关模拟）

- **流程**（**已拍板：不做真·缺 mod**，GTNH 默认全量环境）：
  - 配置关闭 AE2 提供者 → 重导出退化区 → 断言：导出正常完成、该格落通用盒档、来源标记正确、无报错中断；
  - 关闭全部族提供者 → 断言：落几何推断档且标 `inferred`；
  - 断言"推断永不当主来源"：权威可得时导出结果中无 `inferred` 盒。
- **通过标准**：三档来源标记在各场景下正确；任何降级路径不中断导出。

### P3.4 证伪测试

- 篡改 oracle 一个计数 / 敲掉测试结构一个部件重导出 / 把断言期望改成错误值 → 管线**必须红**。
- 注入必抛异常的假提供者 → 导出完成且降级记录落盘（证明容错不是摆设）。

---

## 6. 调度者把关清单（硬约束汇总）

**文件表达（A）**
- [ ] 一格 = 宿主 + N 部件；三方块类型混存互不影响
- [ ] 部件五要素齐全；物品身份缺失时显式标"无"
- [ ] 盒带来源四元组（族/兜底/视觉或碰撞/档位）
- [ ] 无部件信息 ⇒ 行为与今天完全一致（字节级证据）

**悬停（B）**
- [ ] 同格不同部件不同说明；命中判定到部件
- [ ] 优先级链完整，任何情况有话说；逐格说明保留为叠加层
- [ ] 满方块/单盒既有悬停行为零劣化

**计数（C）**
- [ ] 单位 = 可合成物品；一格多物算 N 件
- [ ] 升级卡/伪装板/跨格微方块/变体的"一部件≠一物品"正确表达
- [ ] 宿主清单旧口径保留为可选视图；三级配置生效且互不乱序
- [ ] 图标与名称取部件物品；命名尊重游戏内显示名

**架构（D）**
- [ ] 新接一族 = 注册一个提供者，核心流程零改动（用一个示例提供者证明）
- [ ] 同格多族合并、local id 命名空间隔离
- [ ] 提供者异常/反射失败静默降级，导出绝不中断
- [ ] 三档兜底每档记录来源；推断永不当主来源
- [ ] slab/火把/箱子/栅栏零 mod 代码全覆盖
- [ ] 满方块快速否定路径；缺提供者零额外开销

**工程纪律**
- [ ] `npm run build:mod:gtnh` / `npm run build:web` / `cd web && npx vitest run` 通过
- [ ] proto 改动后 `npm run protocol:gen` 两端同步
- [ ] 不在 web 端重放游戏逻辑；盒为导出时快照、web 端不重算
- [ ] 证伪测试通过（篡改必红）；管线幂等（重复运行字节一致）

---

## 7. 风险登记与上报协议

| # | 风险 | 探针/验证 | 触发上报的条件 |
|---|------|-----------|----------------|
| 1 | 同格多族叠加的部件标识冲突（本轮最高技术风险） | P0.4 契约 + 叠加区断言 | 命名空间方案无法覆盖某族（如 FMP 槽位与 AE2 面语义冲突）→ 上报用户 |
| 2 | 三族接口坐标系/语义差异 | P0.2 | 某族关键环节反射不可得（如 EnderIO 盒需现场计算而非快照可取）→ 上报用户附探针证据 |
| 3 | 视觉盒客户端限定 + 邻居依赖 | P0.3 + P1.2 | 发现必须服务端取盒的场景 → 上报用户（当前假设：全部客户端可快照） |
| 4 | 计数边界 case（跨格微方块重复计数） | P2.3 + 变体区 | 跨格部件在"物品计数"口径下无法无歧义归属 → 上报用户裁定口径 |
| 5 | 旧文件兼容 | P3.2 | 任何基线 diff ≠ 0 且无法解释为纯新增 → 打回，不上报 |

**上报协议**：子代理卡在同一问题超过 2 轮、或触及上表触发条件、或需要违背任何【硬约束】才能推进时，调度者**停下该线并上报用户**，不得自行变通硬约束。

**进度汇报**：每个 Phase 结束、P0.4 契约拍板后，向用户汇报一次（含决策摘要 + 依据链接）。

---

## 8. 代码锚点速查

**本仓库（D:\Projects\Lightning）— mod 侧**

| 用途 | 位置 |
|------|------|
| tooltip 生成（宿主物品 `stack.getTooltip`） | `mod/gtnh/src/main/java/com/lightning/mod/client/meshcapture/MeshCaptureService.java` L426–444 |
| 调色板条目（tooltip 落盘 L615–622） | 同上 L580–624 |
| 逐格说明网格（cellTooltipGrid） | 同上 L628–636 |
| 策略+注册表风格先例（三套） | `client/meshcapture/primary/`、`postrender/`、`finish/`（`*Strategy` + `*Registry`） |
| AE2 渲染辅助反射先例 | `client/meshcapture/MeshCaptureRenderPreparation.java` |
| FMP 后渲染策略先例 | `client/meshcapture/postrender/ForgeMultipartDynamicPostRenderStrategy.java` |
| 依赖现状（运行时装载） | `mod/gtnh/dependencies.gradle` |
| 自动导出管线（多方块轮资产） | `client/automation/` + `docs/plan/multiblock-channel-renderer-plan.md` T1.6 |

**本仓库 — web 侧**

| 用途 | 位置 |
|------|------|
| 悬停 tooltip 解析（现一格一条） | `web/src/pure/tooltipResolution.ts`、`web/src/embed/useEmbedTooltip.ts` |
| 统计计数（现逐格 +1） | `web/src/render/interaction/blockStats.ts` |
| 统计栏 UI | `web/src/embed/components/BlockStatsSidebar.vue` |
| 图标缓存（现取宿主） | `web/src/render/interaction/blockIconCache.ts` |
| 几何推断（第三档思路来源） | `web/src/workbench/tools/partDetect.ts`、`web/src/pure/aabb.ts` |
| parts 占位（待落地） | `web/src/context/grid.ts` L158、`web/src/context/runtimeDocument.ts` L419 |
| 拾取链 | `web/src/context/queries.ts`（pickVoxel） |

**协议**

| 用途 | 位置 |
|------|------|
| 预留部件字段（缺盒/物品身份，需扩展） | `protocol/lightning/v2/plain_v2.proto` L45–55（`BlockPart`）、L117–125（`PartRef`）、L138+（`StatsTemplate`/`StatsGroup`/`StatsEntry`） |

**三族参考（GTNH 本地检出）**

| 族 | 关键定位 |
|----|----------|
| AE2（`D:\Github\GTNH\Applied-Energistics-2-Unofficial`） | `appeng/api/parts/IPart.java`、`IBoxProvider.java`、`IPartCollisionHelper.java`、`SelectedPart.java`；`appeng/helpers/ICustomCollision.java`（视觉/碰撞之分）；`appeng/parts/CableBusContainer.java`；`appeng/block/AEBaseBlock.java` |
| EnderIO（`D:\Github\GTNH\EnderIO`） | `crazypants/enderio/conduit/geom/CollidableComponent.java`、`ConduitGeometryUtil.java`、`TileConduitBundle.java`、`BlockConduitBundle.java` |
| FMP（`D:\Github\GTNH\ForgeMultipart`） | `codechicken/multipart/TMultiPart.scala`、`PartMap.java`（27 槽位）、`TileMultipart.scala`、`BlockMultipart.scala` |

---

## 9. 留白决策登记处

以下留白在执行中拍板后，**必须**把决策与理由追加到本文件对应条目下（或链接到 `docs/plan/decision-*.md`）：

1. 提供者契约形状、字段命名与序列化形式 → P0.4 产出
2. local id 命名空间编码方案（多族不冲突）→ P0.4 产出
3. 统一盒坐标系（建议 0–1 方块局部 Y-up）→ P0.2 结论确认
4. proto 扩展方案（`BlockPart` 增补盒/物品身份字段的方式，兼容旧生成代码）→ P0.4 产出
5. 兜底默认取舍（永远降级 vs 宁缺毋滥）→ P0.4 拍板
6. 计数规则表达方式与三级配置的存储细节 → **已定稿（P2.3）**：JSON StatsRules（非 DSL）；三级 = statsTemplate / statsOverride（新落盘字段）/ localStorage `lightning:stats:v1:<docId>`；字段级覆盖、规则键整体替换；全文见契约 §9 与 `web/src/pure/partStats.ts` 文件头
7. 悬停与统计栏 UI 呈现细节 → **已定稿**：悬停（P2.2，记录于 `web/src/pure/partHit.ts`/`tooltipResolution.ts` 文件头）= 两趟视觉优先命中 + 最小体积重叠取舍 + 「位于 <宿主>」归属标注；统计栏（P2.4，记录于 `web/src/embed/components/BlockStatsSidebar.vue` 文件头）= 部件模式工具条 + 来源徽标/逐字段 provenance 面板 + statsOverride 本轮只读 + 无部件 DOM 零新增退化
8. 几何推断在 mod 侧的执行位置（捕获流水线挂点）→ P1.6 拍板
9. 验收命令名与 oracle 输出目录 → **已定稿（P1.8）**：`npm run acceptance:parts`（= `scripts/parts-acceptance/run-acceptance.ps1`）；oracle canonical = `scripts/parts-acceptance/oracle/`（入库三件：full/degraded_ae2/degraded_all）；归档 `.out/<label>[-rN]/`（gitignore）
10. proto 扩展后的 Java 侧落盘路径：mod 端现用 Gson 手拼 JSON、不消费 proto 生成代码（P0.1 实证：buf.gen.yaml 仅 TS 插件、mod 构建无 protobuf 依赖、生成物两端皆未提交）→ P0.4 拍板（继续 Gson 手拼 + proto 作契约文档 vs 引入 Java 生成）
11. `StatsEntry` 条目键如何引用部件（现仅 `block_state_id`，块粒度）→ P0.4 拍板
12. FMP 27 槽位超出 `BlockPart.direction` 枚举（0–5+CENTER）的表达方案（properties 兜底 vs 扩展编码）→ P0.4 拍板
13. 部件盒超出 [0,1]³ 格界的表达（P0.3 实测：栅栏碰撞盒 maxY=1.5；探针如实记录不裁剪）→ P0.4 拍板（允许越界 vs 裁剪策略）
14. 火把类"选择盒==整格但 renderAsNormalBlock==false"的退化标记：真实几何只在渲染代码里，通用盒档只能落退化整格盒，精确几何交 P1.6 推断档 → P0.4 契约标记方式拍板
15. 单盒方块计数键取 drop 身份（registry+damageDropped）而非方块 meta（P0.3 实测：上/下半 slab 掉落同为 stone_slab:0；朝向 meta 均坍缩）→ P0.4 并入类型键定义

**探针基建开放项（P1.8 前置，P1.3–P1.5 已定位根因并给出解法）**：~~`sde_parts_probe_world` 跨轮不清理，FMP `addPart` 路径会跨轮堆积部件~~ **根因已查明（p13-run-1 实证）**：BlockMultipart 非 BlockContainer，裸 setBlockToAir 不移除 tile，且服务端静默清理不同步客户端 stale tile → 新一轮 addPart 同步包追加 ⇒ 翻倍。**解法 = 逐部件反射 `remPart`**（FMP 正常移除通道，removal 包同步两端），已在 PartsProbePlacement.placeFamilyPrep 实现并经 p13-run-2/3 幂等验证（稳定 2 部件）。P1.8 建造器/oracle 生成器的世界重置机制照此办理。

**风险 #1 闭环与叠加区裁决（P1.3–P1.5 实证后调度者拍板）**：GTNH 中三族 tile 互斥寄宿——真实"同格两族"在 ae2/eio/fmp 之间不存在（EnderIO 束只与 Immibis 微方块共存，Immibis 在三族范围外；AE2 总线被 FMP 转换后属 fmp 单族）。多族合并语义已由等价实验机器证明（真实 FmpPartProvider + 探针 tier-1 提供者同格合并出 3 部件、localId 命名空间零冲突、落档 1——p13-run-2 归档），契约 §4 命名空间方案的有效性成立。**P1.8 叠加区重定义**：不再追求字面"三族同格"，改为最大复杂度真实格组合（EnderIO 5 导管束含连接器与跨格段 / AE2 facade+线缆格 / FMP 多微方块格）+ 合并语义断言沿用等价实验；**不新增 Immibis 提供者**——若未来需要，按"新接一族 = 注册一个提供者"的架构承诺另行立项（本身即 D 交付的活证）。

**P2.5 实施登记（调度者复核采录）**：① 悬停用例采用**几何增强内存副本**口径（fixture 部件数据逐字节一致，仅追加双绕组命中面）——fixture 原件对 raycast 物理不可达的两根因（单绕组背向相机 FrontSide 剔除；补面与邻盒共边界被最小体积规则判走）已记录在 `web/e2e/helpers/parts/README.md`；**开放项（低优先级）**：fixture 原件改双绕组 + 独占边界面后悬停可去副本化。② **开放项（实现侧评估）**：mobile 窄布局自动折叠振荡——展开侧栏 → 根宽 361→445px → profile watcher ~50ms 内再折叠，展开按钮在该带宽自失效（MutationObserver 实证）；疑似折叠 watcher 未考虑用户手动展开意图，登记待评估，非本轮阻断。③ P2.5 开工探针擒获的 P2.1 生产阻断（深响应式 structuredClone）已由调度者亲修闭环（c98351a），断言包在修复后代码上全绿——零替身管线立功案例登记。

**P2.1 实施登记（调度者复核后采录）**：① statsTemplate 命名以 **camelCase（showOthers）为落盘权威**（契约 §10.2），snake_case（show_others）仅作旧数据读取回退——P2.3 消费时按此执行；② 根级 cellGrid/blockPalette 存在与本次已修复的 parts 字段同类的"首帧展开副本残留过期快照"隐患（**既有问题，非本轮引入**）——登记为开放项，是否同样按派生数据排除出 _extra 由后续立项裁定；③ `PaletteEntryMeta.parts?: unknown[]` 残留类型暂保留（未知字段 round-trip 透传通道），确认无消费后可清理（清理属可选优化，不阻塞）。

**事实勘误（调度者复核登记）**：P0.1 报告称"`web/src/render/proto/` 目录不存在"，实际目录存在但仅含空的 v1 残留子目录（无任何生成文件；.gitignore L26 仅忽略 `lightning/v1/`）——实质结论（生成代码两端皆无）不变。

**Phase 3 实施登记（调度者复核采录，p3-release/p3-idem8 两轮全绿：22/22 §6 清单机器判定 pass、跨轮 13 个数据产物逐字节一致）**：
- **编排拍板（P3 执行者，采录）**：`npm run acceptance:parts` = 14 阶段编排（退出码沿用多方块轮体系）；L2 消费同编排内 L1 新鲜归档；P3.4「敲掉部件」用导出侧等价注入；多方块交叉回归选 `multiblock-channel-traversal.spec.ts -g 尺寸变化方向` 单用例；「推断永不当主来源」为 scripts 侧静态判据；proto 同步以「契约字段在册」静态判据替代跑 protocol:gen（契约 §10.1 口径）；L1 默认 `-L1Runs 1` + 世界基线快照（绕开 F3）+ `-SyncWaitTicks 120`（F5 缓解）。
- **F1/F2 偏差（硬约束相关，派单修复）**：StructureDataParser 不透传 statsTemplate/statsOverride/partIconTextures（三级配置文档默认层对真实导出失效）；partIconTextures 无 EmbedViewport 消费接线（部件图标回退占位）——验收用例以偏差锁形式锁定当前行为，修复落地时翻转。
- **F3/F5 开放项（mod 侧时序偶发，用户裁决是否投入根治）**：F3 跨会话 FMP stale-tile 累积（验收世界第二次会话部件 3→6，remPart 通道非万无一失；编排以世界基线快照规避）；F5 AE2 线缆总线格偶发整格缺失（疑 chunkWaitTicks 硬编码 60 与客户端区块就绪竞争；编排以 SyncWaitTicks 120 缓解，根治 = 区块就绪前置条件化）。两处证据在验收报告 findings/。
- **测量登记**：M1 AE2 平面类部件碰撞盒零厚度轴 = 平面语义如实快照（判据按逐轴 min≤max+非全轴退化）；M2 契约文本 enderio→eio 已统一（调度者已改契约）；M4 从零生成验收世界产出无效 ⇒ -ResetWorld 默认关（复用既有世界+自动化清场重建）。
