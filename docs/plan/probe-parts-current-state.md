# P0.1 探针：部件数据现状盘点（probe-parts-current-state）

> **任务**：《non-full-cube-parts-plan.md》§2 P0.1。纯阅读盘点，未改动任何代码。
> **分支**：feat/non-full-cube-parts。
> **结论自检**：每个"已有"结论附 文件:行号。

---

## 结论先行

**P1 各任务的起点是"地基半成品 + 楼体真空白"。** 上一轮"部件盒"方向**没有留下任何 mod 侧导出实现**：导出链路的调色板条目、扫描层 cellTypes、三套捕获策略里都没有部件字段，全仓检索不到任何 PartProvider/部件盒/物品身份的落盘代码。现存的是三类"半成品地基"：① proto 里预留但两端生成代码均缺席、且本身缺盒与物品身份字段的 `BlockPart`/`PartRef`/`StatsTemplate`；② web 侧两处从未被读写的 `parts: []` 占位（但 round-trip 机制意外能把未来的部件字段原样带过）；③ web 侧 `partDetect.ts` + `pure/aabb.ts` 的纯几何推断（只服务注解框工具，不落盘）。mod 侧真正的资产是"策略+注册表"范式与 FMP/AE2 反射先例——形状对了，内容全缺。因此 P1.1（提供者框架）是**新写**而非续写；P1.3–P1.5 可站在反射先例的肩膀上；P1.6 的几何推断思路需要从 web 侧**移植**而非接入。

---

## 一、已有（附行号证据）

### 1.1 mod 侧导出链路

**调色板条目（无任何部件字段）** — `MeshCaptureService.java` L580–624，每条目恰好 9 个字段：

```java
p.addProperty("registryId", r.registryId);            // L585
p.addProperty("meta", r.meta);                        // L586
p.addProperty("facing", r.facing);                    // L587–589（可选）
p.add("nbt", ...);                                    // L590–597（可选）
p.addProperty("thumbnailPNG", thumbB64);              // L601–604（可选）
p.addProperty("renderMode", "BakedModel");            // L609
p.add("geometry", ...);                               // L610（bakedQuadsJsonV1）
p.addProperty("occludesAdjacentFaces", ...);          // L611–614（= b.isOpaqueCube()，L559）
p.add("tooltip", ttArr);                              // L615–622
```

**没有** `parts` / 部件盒 / 物品身份 / 来源标记任何一项。tooltip 落盘即 L615–622，来源是**宿主方块** ItemStack 的 `stack.getTooltip`（L426–446：按 cellType 构造 `new ItemStack(b, 1, vs.meta)` 取 NEI 风格说明，失败静默 L443–445）。

**逐格说明网格** — `MeshCaptureService.java` L628–636：`cellTooltipGrid` 全部初始化为 -1 落盘；文本池由 `integrateSdeCellNotesWorldRoot` 把 scan 期 `sdeCellNotes` 并入根级 `tooltipPalette`（L232–265，pool 写入 L255；单结构路径 L375）。-1 语义 = 无人工说明（web 侧 `TOOLTIP_GRID_NONE = -1`，`web/src/render/schema/types.ts` L112）。

**扫描层（无部件概念）** — `core/scan/StructureScan.java`：cellTypes 条目只有 `registryId`/`meta`/`facing`/`tileNbtB64` 四字段（L83–101），一格一个调色板下标（L56–64）。扫描层是纯体素逻辑态，**无几何、无盒、无部件**。

**三套 Strategy+Registry（范式资产，内容均与部件语义无关）**：

| 套 | 接口 / 注册表 | 已注册策略（注册行号） | 与非满方块/多部件渲染的关系 |
|----|---------------|------------------------|------------------------------|
| primary/ | `BlockPrimaryCaptureStrategy` + `BlockPrimaryCaptureRegistry` | `VanillaPrimaryBlockCaptureStrategy`（Registry L21，priority 10000，applies 恒 true） | 首命中即返回（Registry L38–43）；走 `renderBlockByRenderType`，捕获整格烘焙四边形，**不做部件区分** |
| postrender/ | `MeshCaptureBlockPostRenderStrategy` + `MeshCaptureBlockPostRenderRegistry` | `ForgeMultipartDynamicPostRenderStrategy`（L33，priority 1000）；`TileEntitySpecialRendererPostRenderStrategy`（L34，priority 2000） | **所有** applies=true 的都执行（L50–69）；补画 TESR/动态扩展层 |
| finish/ | `BlockCaptureFinishStrategy` + `BlockCaptureFinishRegistry` | `JabbaBarrelDedupFinisher`（L22，JABBA 桶面去重）；`SuppressPrimaryQuadsWhenExtensionPresentFinisher` **默认不注册**（其类注释 L14） | 捕获后四边形清洗 |

**FMP 先例** — `postrender/ForgeMultipartDynamicPostRenderStrategy.java`：
- 反射定位 `codechicken.multipart.TileMultipart`（L41、L307–330 多 ClassLoader 探测）；
- 通过 `jPartList`/`partList` 枚举格内部件（L332–356，含 Scala Seq 的 size/apply 处理 L373–399）——**但枚举部件的唯一目的是逐部件调 `renderDynamic` 补画动态四边形**（L96–108）；
- **捕获了什么**：FMP 动态层的顶点（混入整格 quads，经 `TessellatorCaptureState.beginDynamicExtensionVertexPhase` 打标 L89/L113）；
- **没捕获什么**：部件边界盒、部件类型/名称、部件物品身份、四边形→部件的归属关系（输出几何里没有 per-part 分组）。

**AE2 先例** — `MeshCaptureRenderPreparation.java`：Hook 注册表（L29–50）+ 内置 `ReflectiveThreadLocalRenderBlocksStateHook`，反射探测 `appeng.client.render.BusRenderHelper.instances/setPass`（L130–132）与 `BusRenderer.INSTANCE.getRenderer`（L138–140），同步 pass/renderAllFaces/blockAccess（L85–118）。**它自己什么都不捕获**——只是修渲染环境让 AE2 线缆总线 ISBRH 在离屏路径下产出四边形；不枚举部件、不取盒。另 `ForgeWorldRenderPassUtil.java` L12 注释提及 AE2 `BlockCableBus` AlphaPass 双 pass。

**FMP NBT 工具** — `MultipartNbtStateUtil.java`：反射迭代 `partList`、对每个 part 调 `load(NBTTagCompound)` 恢复 NBT swap 后的部件状态（L48–79），`isTileMultipart`（L39–42）。服务捕获保真，不导出部件数据。

**多方块轮 T1.3 资产（无部件/盒字段）**：
- `client/multiblock/GeometryPalette.java`：Entry 结构 L55–78（index/registryId/meta/json/signature/quadCount/referenceCount/referencedBy）；条目 JSON 形状恒为 `{registryId, meta, renderMode, geometry, occludesAdjacentFaces, nbt, tooltip}`（L142–149）——**无部件/盒字段**。
- `client/multiblock/VariantGeometryBakery.java`：产出全局调色板下标 cellGrid + 两个内容签名（类注释 L40–66）；状态键 = `registryId:meta | MTE 类名 | 激活位`（L64–65）。无部件。

### 1.2 web 侧

**`parts: []` 占位（两处，形状相同，均为兜底调色板条目）**：
- `web/src/context/grid.ts` L153–159：`setBlock` 为 paletteCache 播种 `{ registryId: 'minecraft:' + name, renderMode: 'BlockModel', parts: [] }`；
- `web/src/context/runtimeDocument.ts` L413–420：`_gridToV2` 序列化时 paletteCache 未命中则写同样的兜底条目（`parts: []` 在 L419）。
- 类型定义在 `web/src/pure/gridTypes.ts` L25–35：`PaletteEntryMeta { registryId; renderMode?; parts?: unknown[]; geometry?; ... }`——`parts` 是 `unknown[]`，**全仓没有任何代码读它或往里写有内容的值**（grep `\bparts\b` 确认）。
- 注意：烘焙调色板条目的正式 schema（`web/src/render/schema/types.ts` L188–198 `BakedModelPaletteEntry`）**没有** `parts` 字段。

**round-trip 意外通道（重要发现）**：`_fromV2CellGrid` 把原始调色板条目**整条**存进 paletteCache，键为 `'#'+index`（runtimeDocument.ts L441–451）；`blockKey` 对有 `paletteIndex` 的块也返回 `'#'+index`（`web/src/pure/string.ts` L32–35），`_gridToV2` 命中后 `{ ...meta }` 原样回写（L412–414）。**结论：未来 mod 在调色板条目里写 `parts` 字段，现有 web 序列化/反序列化会原样带过、不丢**——但不会被解释、不进渲染/统计/tooltip。

**几何推断（partDetect + aabb）**：
- `web/src/workbench/tools/partDetect.ts`：输入 = `StructureDefinition` + 格坐标（column/worldY/zSlice）+ 可选命中四边形下标/法线；解码该格调色板条目的 baked 几何（`decodeBakedGeometry`，L88–90），经纯函数扩"部件"后算 AABB；输出 `DetectedBounds { min, max, quadIndices, totalQuads }`（L17–22）。`detectPartBounds`（L70–118）/ `detectFaceBounds`（L129–181）。
- `web/src/pure/aabb.ts`：判定逻辑——标准四边形（4 顶点）→ 共享边（≥2 共点，阈值 0.01）**单跳**扩组（L173–205）；三角面/非标 → 共点 BFS 扩**整岛**（L135–168、L214–219）；法线匹配 `dot > 0.999`（L239）；`ensureMinThickness` 把平面盒撑到 0.1 厚（L264–291）。
- **已知误判**：贴合部件并一——凡共享顶点（≤0.01）的四边形会被 BFS 并成同一"部件岛"；法线回退无命中时退化为全部四边形（L242）；只在**单格**几何内推断，无跨格概念；纯几何、无语义（不知道哪一岛是"线缆"哪一岛是"面板"）。
- **数据流向**：唯一消费者是 `web/src/workbench/tools/boxTool.ts`（L4–5 import；L158/L160/L162 悬停盒计算），结果只进**注解框草稿的 min/max**（L172–178）。**不落盘为部件数据**，不进 tooltip/统计/拾取链。

**tooltip 解析（粒度 = 一格一条）**：
- `web/src/pure/tooltipResolution.ts` L32–52：`cellTooltipGrid[z][row][col]` → `tooltipPalette` 下标 → 单条字符串；sidebar 来源恒返回 `''`（L38）。
- `web/src/embed/useEmbedTooltip.ts`：`neiTooltipMap` 以 `registryId@meta` 为键、取**调色板条目**（宿主）tooltip（L23–34）；视口悬停优先逐格说明、空则回退宿主 NEI 首行（L64–84）。数据通路：`drw.tooltipPalette`（`web/src/runtime/drw.ts` L49）→ `useViewportRuntime` → `EmbedViewport` → `useEmbedTooltip`。
- 人工叠加层已存在：workbench `TooltipEditorPanel.vue`（逐格编辑 `cellTooltipGrid`/`tooltipPalette`，L34–40 读、L56–59 经 `OPERATOR_TOOLTIP_EDIT` 写）。

**统计计数（粒度 = 逐格 +1）**：
- `web/src/render/interaction/blockStats.ts` L19–38：`countBlocksById` 遍历体素体积，非空气格按 `registryId@meta` 键 +1；L43–53 `buildBlockStatsEntries` 排序出行。
- 图标来源：`web/src/render/interaction/blockIconCache.ts` L198–221——**宿主**调色板条目的 `thumbnailPNG`（Java 端 `renderBlockAsItem` 预渲染）优先，否则用宿主几何 WebGL 现烘（`buildSingleBlockPreviewFromBakedPalette` L227）。
- UI：`web/src/embed/components/BlockStatsSidebar.vue` 消费 `BlockStatRow[]` + `BlockIconCache`（L7–13），行键 = blockId，事件载荷 = blockId（L17–23）。

**拾取（命中粒度 = 格，但原始四边形信息已在手）**：`web/src/context/queries.ts` L74–88 `pickVoxel` 返回 `{ pos(格), block_state_id, quadIndex, normal, point }`——raycast 已精确到四边形，但没有任何"quadIndex → 部件身份"的解析，blockId 仍是宿主键。

### 1.3 protocol

`protocol/lightning/v2/plain_v2.proto` 预留消息完整引出见文末 §五。**生成代码现状**：
- `protocol/buf.gen.yaml` 只有**一个**插件（timostamm-protobuf-ts → `../web/src/render/proto`），**无 Java 插件**；
- `web/src/render/proto/` 目录在工作区**不存在**（生成物从未提交；`.gitignore` L26 忽略 `web/src/render/proto/lightning/v1/`）；
- mod 侧构建文件无任何 protobuf 依赖/插件（grep `protobuf|proto` 于 `mod/gtnh/*.gradle` 零命中）——**Java 端没有也不消费 proto 生成代码**，导出全靠 Gson 手拼 JSON；
- web 端实际使用的是手写镜像类型 `web/src/render/data/sceneDocumentV2.ts`：`V2PartRef`（L17）、`V2AnnotationBox.part_refs?`（L23）、`V2StatsEntry/Group/Template`（L40–50）——且 `V2PlainSceneDocument`（L66–89）**根本没挂 `stats_template`**；全仓除类型定义与 `compactSceneDocument.ts` L200 的 re-export 外，**无任何代码读写** PartRef/StatsTemplate/BlockPart（grep 确认）。

---

## 二、缺失（对照计划 §0 交付总览 A–E）

| # | 交付 | 现状缺口 |
|---|------|----------|
| A | 场景文件表达部件 | **全缺**。mod 导出条目无 parts 字段（§1.1）；web 正式 schema `BakedModelPaletteEntry` 无 parts；proto `BlockPart` 缺盒字段与物品身份字段且未生成/未消费；五要素（格内定位/类型键/空间盒/显示名+说明/物品身份）与来源四元组在文件里零表达。仅存的 `parts: []` 占位永远为空 |
| B | 悬停说明到部件 | **全缺**。tooltip 粒度 = 一格一条（cellTooltipGrid）+ 宿主 NEI 回退；无部件命中判定（pickVoxel 到格为止）、无优先级链。逐格人工说明层已存在，正好满足"保留为叠加层"的前提 |
| C | 精确计数 + 可配置统计栏 | **全缺**。统计 = 逐格 +1 的宿主清单（这将是未来"宿主清单"视图的现成实现）；无物品粒度、无三级配置、`StatsTemplate` 类型悬空未接 |
| D | 接口式架构 | **范式已有、实例全缺**。策略+注册表三套先例可直接照抄形状；但 `PartProvider`/`PartProviderRegistry`、三档兜底、来源标记、命名空间隔离、满方块快速否定全部不存在；EnderIO 在 mod 源码中**零出现**（grep `conduit` 无命中） |
| E | 自动化验收增量 | **骨架已有、部件增量全缺**。游戏内自动化 tick 存在（`client/automation/SdeClientAutomationTickHandler.java`）+ 多方块轮 `MultiblockExportAutomation`/`MultiblockPipelineAutomation` 等管线类可复用；部件 oracle/断言/fixture 为零 |

---

## 三、可复用（资产清单）

| 资产 | 位置 | 复用方式建议 |
|------|------|--------------|
| 策略+注册表范式（含 priority 排序、CopyOnWriteArrayList、逐策略 try-catch 容错） | `meshcapture/primary|postrender|finish/*Registry.java`（如 BlockPrimaryCaptureRegistry L36–52） | P1.1 `PartProviderRegistry` 直接照抄；postrender 式"全部命中都执行"语义正好对应"多提供者同格合并" |
| 宿主 tooltip 生成 | `MeshCaptureService.java` L426–446（`stack.getTooltip` + 静默容错） | P1.7 部件说明优先级链的"物品说明"档：对部件 ItemStack 复用同一调用 |
| 内容签名去重 | `MeshCaptureService` CaptureToolkit（L649–659 类注释：`fullEqualitySignature` 等）；`GeometryPalette.intern`（L131–156） | 部件几何/条目去重；调色板并集机制 |
| FMP 反射工具箱 | `ForgeMultipartDynamicPostRenderStrategy`（多 ClassLoader 探测 L307–330、Scala Seq 适配 L373–399、`partList` 枚举 L332–356）；`MultipartNbtStateUtil`（part.load NBT L48–79） | P1.5 FMP 提供者的枚举与反射基建；反射断点逐个 try-catch 的写法已是仓库风格 |
| AE2 反射先例 | `MeshCaptureRenderPreparation`（Hook 注册 L46–50、BusRenderHelper/BusRenderer 反射 L130–147） | P1.3 AE2 提供者的反射接入与"缺 mod 静默空操作"写法 |
| 纹理嵌入 | `client/export/TextureBlobEmbedder`（GeometryPalette.embedTextures L182–190 已在用） | P1.7 部件物品图标嵌入 textureBlobs |
| 自动导出管线骨架 | `client/automation/SdeClientAutomationTickHandler.java` + `client/multiblock/*Automation.java` | P1.8 建造→导出→oracle 的挂点 |
| 几何推断纯函数 | `web/src/pure/aabb.ts`（共点/共边扩组、AABB、minThickness）；`web/src/workbench/tools/partDetect.ts`（几何解码 + 格定位） | P1.6 把**思路**（命中岛扩组 + AABB）移植到 mod 侧快照；web 侧 P2.2 也可继续用这些纯函数做部件盒命中 |
| 调色板 round-trip 透传 | `runtimeDocument.ts` L441–451 + `pure/string.ts` L32–35 | 未知调色板字段（未来 `parts`）序列化不丢——P2.1 只需补"解释"，不必担心"丢失" |
| 逐格人工说明层 | `TooltipEditorPanel.vue` + `pure/tooltipResolution.ts` + `metaEditOperators.ts` | B 交付"逐格说明保留为叠加层"的现成实现，无需改动 |
| 拾取原始信息 | `queries.ts` pickVoxel L81–87（quadIndex/normal/point 已返回） | P2.2 在其上加"quad→部件盒"解析即可，拾取链本身不用动 |
| 图标缓存双通道 | `blockIconCache.ts` L212–221（thumbnailPNG 优先）→ L227（WebGL 兜底） | P2.4 部件物品图标：为部件物品加新的 thumbnailPNG 来源即可复用缓存/订阅机制 |
| 宿主统计 | `blockStats.ts` `countBlocksById` | P2.3"宿主清单"旧口径视图原样保留（计划也要求旧函数保留） |

**排除项（名字像但无关）**：`web/src/util/wikiStructureData/*` 的 `isMultipartIndex`/`mergeMultipartIndex` 是 wiki 信封**分页**（multipart upload），与方块部件无关。

---

## 四、部件语义标识符三栏归并（全仓 grep "part" 结果）

| 已有（语义相关，真实存在） | 缺失（计划需要但不存在） | 可复用（形状/机制可借用） |
|---|---|---|
| proto `BlockPart`/`PartRef`/`StatsTemplate`/`StatsGroup`/`StatsEntry`（plain_v2.proto L45–55、L117–125、L138–153，未生成未消费） | mod 侧 `PartProvider`/`PartProviderRegistry`/parts 子包（零实现） | 三套 `*Strategy`/`*Registry` 容错范式 |
| web `PaletteEntryMeta.parts?: unknown[]`（gridTypes.ts L28）+ `parts: []` 占位（grid.ts L158、runtimeDocument.ts L419） | 导出文件任何部件字段（盒/类型键/物品身份/来源四元组） | `MultipartNbtStateUtil` partList 反射枚举 |
| web `partDetect.ts` + `pure/aabb.ts` 几何推断（仅服务注解框） | proto 生成代码（两端皆无；buf.gen.yaml 无 Java 插件） | `ForgeMultipartDynamicPostRenderStrategy` 反射工具箱 |
| mod `MultipartNbtStateUtil`/`ForgeMultipartDynamicPostRenderStrategy` 的 FMP part 枚举（只为渲染保真） | EnderIO conduit 任何代码（grep `conduit` mod 侧零命中） | `MeshCaptureRenderPreparation` AE2 反射 Hook |
| `MeshCaptureService` FMP TE 识别分支（L482–499 `teIsMultipart`） | AE2 `IPart`/`CableBusContainer` 语义层枚举（现有反射只碰渲染状态） | paletteCache 未知字段 round-trip 透传 |
| web `sceneDocumentV2.ts` `V2PartRef`/`V2Stats*` 手写类型（悬空） | 部件粒度 tooltip/统计/拾取/图标 | `blockIconCache` thumbnailPNG 通道、`blockStats` 宿主清单 |
| 逐格人工说明（cellTooltipGrid/tooltipPalette 全链路） | 测试 fixture/oracle/断言包 | 自动化 tick + 多方块导出管线骨架 |

---

## 五、proto 预留字段全录与缺口表

### 5.1 定义全录（plain_v2.proto）

```proto
message BlockInstance {                          // L41–47
  BlockPos pos = 1;
  string block_state_id = 2;
  map<string, string> nbt = 3;
  repeated BlockPart parts = 4;                  // v2 新增（L45）
  GuiState gui_state = 5;
}

message BlockPart {                              // L49–55
  string local_id = 1;                // 父块内唯一标识
  string part_tag = 2;                // 部件标记
  int32 direction = 3;                // -1=无, 0-5=DUNSWE, 6=CENTER
  map<string, string> properties = 4; // 部件属性
  string tooltip = 5;                 // 独立 tooltip
}

message AnnotationBox { ... repeated PartRef part_refs = 8; ... }   // L117

message PartRef {                                // L122–125
  BlockPos block_pos = 1;
  string part_local_id = 2;
}

message StatsTemplate {                          // L138–142
  string mode = 1;                    // "auto" | "custom"
  repeated StatsGroup groups = 2;
  bool show_others = 3;
}
message StatsGroup { string label = 1; repeated StatsEntry entries = 2; }   // L144–147
message StatsEntry {                             // L149–153
  string block_state_id = 1;
  string label_override = 2;
  string icon_source = 3;
}
```

### 5.2 逐字段可用性

| 字段 | 已可用？ | 说明 |
|------|----------|------|
| `BlockInstance.parts` | 定义在、**无人读写** | 挂载点正确（挂在方块实例上，一格 N 部件形状对） |
| `BlockPart.local_id` | 可用 | 对应五要素"格内定位"；但无命名空间隔离约束（契约 P0.4 需定 `ae2:`/`fmp:` 前缀规则） |
| `BlockPart.part_tag` | 可用（语义待定） | 可勉强充当跨格类型键，但字段名/语义需在 P0.4 拍板 |
| `BlockPart.direction` | 可用 | 面/槽定位（0–5 DUNSWE + 6 CENTER），与 AE2/FMP 槽位语义兼容；FMP 27 槽位表达不下，需 properties 兜底 |
| `BlockPart.properties` | 可用（万能兜底） | map<string,string>，可塞来源四元组等，但强契约字段不该藏这里 |
| `BlockPart.tooltip` | 可用 | 部件独立说明，优先级链的"部件自定义"档 |
| `PartRef.block_pos/part_local_id` | 可用 | 注解定向部件；目前 `V2AnnotationBox.part_refs` 有类型无消费 |
| `StatsTemplate.mode/groups/show_others` | 骨架可用 | 但 `V2PlainSceneDocument` 未挂 `stats_template`（sceneDocumentV2.ts L66–89），且条目键是 `block_state_id`——**块粒度，无部件引用**，需扩 `part_ref` 或允许 part 键 |
| `StatsEntry.label_override/icon_source` | 可用 | 与 C 交付规则能力部分对应 |

### 5.3 `BlockPart` 缺口（核实计划 §2 P0.4 第 5 条的说法——**属实**）

| 缺口 | 计划要求 | 现状 |
|------|----------|------|
| **空间盒** | 五要素之一：部件空间盒（允许多子盒），带来源四元组（族/兜底/视觉或碰撞/档位） | 无任何盒字段（无 AABB、无顶点、无多子盒） |
| **物品身份** | 五要素之一：部件 → 可合成物品（无则显式标"无"） | 无 item_id / item_stack 字段 |
| 类型键 | 跨格合并键（统计/去重用） | 仅 `part_tag` 可勉强充当，语义未定 |
| 显示名 | 与 tooltip 分离的短名 | 只有 `tooltip` 单字段 |
| 生成代码 | 两端同步 | **两端皆无**：buf.gen.yaml 只有 TS 插件且无 Java 插件；`web/src/render/proto/` 不存在；mod 端 Gson 手拼 JSON、不消费 proto——proto 扩展后还需决定 Java 侧落盘路径（继续 Gson 手拼 vs 新增 Java 生成），这是 P0.4 必须登记的决策 |

---

## 附：关键行号速查

**mod**：MeshCaptureService.java L426–446（宿主 tooltip 生成）、L482–499（FMP TE 识别）、L559（isOpaqueCube→occludesAdjacentFaces）、L580–624（调色板条目九字段）、L615–622（tooltip 落盘）、L628–636（cellTooltipGrid 全 -1）；StructureScan.java L83–101（cellTypes 四字段）；BlockPrimaryCaptureRegistry.java L21/L38–43；MeshCaptureBlockPostRenderRegistry.java L33–34/L50–69；BlockCaptureFinishRegistry.java L22；ForgeMultipartDynamicPostRenderStrategy.java L41/L96–108/L332–356；MeshCaptureRenderPreparation.java L130–147；MultipartNbtStateUtil.java L39–79；GeometryPalette.java L55–78/L131–156。

**web**：grid.ts L153–159；runtimeDocument.ts L413–420/L441–451；pure/gridTypes.ts L25–35；pure/string.ts L32–35；render/schema/types.ts L188–198；workbench/tools/partDetect.ts L70–181；pure/aabb.ts L173–219/L264–291；workbench/tools/boxTool.ts L156–163（唯一消费者）；pure/tooltipResolution.ts L32–52；embed/useEmbedTooltip.ts L23–34/L64–84；render/interaction/blockStats.ts L19–53；render/interaction/blockIconCache.ts L198–227；embed/components/BlockStatsSidebar.vue L7–23；context/queries.ts L74–88；render/data/sceneDocumentV2.ts L17/L40–50/L66–89。

**protocol**：plain_v2.proto L41–55/L117–125/L138–153；buf.gen.yaml L4–6（仅 TS 插件）；.gitignore L26。
