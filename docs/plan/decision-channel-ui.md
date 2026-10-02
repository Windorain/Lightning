# 通道 UI 与两端接线 —— 决策记录（T2.4 + T2.5）

> **归属**：`multiblock-channel-renderer-plan.md` §9 留白 **#4「UI 组件改造方式（新 tab vs 复用现有 tab 容器）」**，
> 以及 §T2.5「装配状态的管理位置（视口本地状态 vs 文档级状态）由你拍板」。
> **上游契约**：[format-multiblock-doc.md](format-multiblock-doc.md)（通道声明、取值域含"未设置"、`viewerSemantics`）。
> **实现**：`web/src/shared/viewport/{ViewportFrameLayerDock,MultiblockChannelPanel.vue,useMultiblockChannels.ts,multiblockChannelUi.ts,dockTabs.ts,EmbedViewport.vue}` +
> `web/src/workbench/components/WorkbenchViewport.vue`。
> **状态**：已实现并自检通过（vitest 114 绿 / `npm run build:web` 通过 / vue-tsc 仅 4 个既有基线错误 /
> 真实 dev 服务器 + Chromium 双端手测全绿）。

---

## 1. 留白 #4：UI 改造方式 —— **新增第三个 tab「通道」**（不改帧控制/分层预览容器）

**拍板**：`ViewportFrameLayerDock.vue` 的 tab 行新增 `通道`（`data-dock-tab="channels"`），面板内容由新叶子组件
`MultiblockChannelPanel.vue` 承载；`frame` / `layer` 两个 tab 的模板、状态、样式一字未改，三者互斥显示。

**理由**：

1. **硬约束「与帧控制/分层预览互不干扰」的最强落实方式是物理隔离**：三者各自独立面板，互斥挂载；
   若把滑杆塞进现有帧控制面板，帧播放控件与通道滑杆会争抢同一行空间（两个面板现有高度 40/48px 固定）。
2. **通道面板的内容是"文件声明驱动"的**：条数 = 声明条数，可能 1 条也可能十几条，天然需要"高可变高度"的容器；
   独立面板可以只给自己放宽高度（`max-height: 152px` + 内部滚动），不牵动既有两栏的固定高度与移动端布局。
3. **显隐条件是文档形态**（`documentShape === "multiblock"`），与两个既有 tab 的显隐条件（多帧 / feature 开关）正交；
   独立 tab 让"帧为主文档 ⇒ 通道 tab 不出现"成为一条 `v-if`，不需要在任何既有面板里加分支。
4. **不重复造 Layer 滑杆**：分层预览 tab 原样保留，通道面板内不含任何 Layer 控件（DOM 断言：通道面板内无 `.wm-layer-bar`）。

**被否方案**：把滑杆并入「帧控制」面板（互斥性靠内部条件渲染维持，高度争抢、显隐条件纠缠，且帧为主文档下帧控制面板可能不存在 ⇒ 还得再开一个挂载点）。

### 1.1 tab 可用性/默认/回落：两端共用一份纯逻辑

`dockTabs.ts`（纯函数）集中 `availableDockTabs` / `defaultDockTab` / `resolveDockTab`，优先级顺序 = **通道 → 帧控制 → 分层预览**：

| 文档形态 | 可用 tab（Embed：`features` 全开，Workbench 恒开） | 默认 tab |
|---|---|---|
| 帧为主 · 多帧 | `frame, layer` | `frame`（既有行为不变） |
| 帧为主 · 单帧 | `layer` | `layer`（既有行为不变） |
| **多方块为主** | `channels, frame, layer` | **`channels`** |

- **默认只作用于"首次挂载"**：同一会话内切换文档不强制跳 tab（尊重用户当前选择），通道 tab 始终可见可点。
- `resolveDockTab` 保证文档形态切换后不残留空 panel（用户在 `channels` 时加载帧为主文档 → 自动落到 `frame`/`layer`）。
- **嵌入端不新增 `View3DFeatures` 开关**：通道切换是契约级能力（T2.5 硬约束"Embed 只读查看器同样可用通道切换"），
  且 `View3DFeatures` 属 `web/src/viewer/`（T2.4/T2.5 写范围之外）。⇒ 通道 tab 只由**文档形态**驱动，
  `features.frameControls/layerBar` 全关时它依然出现（单测覆盖）。

---

## 2. T2.5 拍板：装配状态 = **视口本地状态**（不写文档、不写 `ctx.main`）

**拍板**：`{totalTier, values, runstate}` 三个取值由 `useMultiblockChannels(ctx)` 每个视口各持一份（`ref`），
Embed 与 Workbench 调用**同一个 composable**，因此两端行为一致（无形态分支）。

**理由**：

1. **写文档的代价不可接受**：走 `ctx.main.replaceDoc(...)` 会 `structEpoch++` → DRW `rebuildAll()`（含纹理缓存 dispose + 重新解码 PNG）、
   并且 `wikiEditSummary` 按 `serialize()` 比对判定"文档已修改"——拖一下滑杆就把文档标脏。
2. **文档级状态需要 `ctx.main` / `runtime/main.ts`**，都在本任务写范围之外；且"同文件同取值"的可复现性由 `assembleSelection` 的纯函数性质保证，
   不需要把选择持久化到文档。
3. **已验证不冲突**：当前只有一个 Workbench 视口 + 一个 Embed 视口实例（`WorkbenchRoot.vue` 单实例、`EmbedRoot.vue` 单实例），
   视口本地状态不会出现"两个视口对同一文档给出不同装配"的可见矛盾。

### 2.1 渲染接线（**T2.5 的核心**：多方块文档 `frame.grid` 恒为 `null`）

```
{totalTier, values, runstate}
  → assembleForSelection(doc, state)     // T2.2 装配器（守卫 decl.variantByKey，异常不穿透）
  → buildMultiblockRenderView(doc, grid) // 渲染视图文档：装配 Grid 放进首帧（及当前帧下标）
  → DRW 的 docRef（useViewportRuntime 的 docOverride）
  → doc.serialize() → resolveRenderBundle → structureDefinition
  → drw.loadStructureAndResources() + drw.rebuildContentMesh()（取值变更时）
```

三个关键点（都写进了代码注释）：

1. **只能是"渲染视图文档"**：DRW 只吃 `doc.serialize()`；对 `format_version:"2.0"` 文档
   `resolveRenderBundle` 解析的是**顶层展开（首帧 `structure`）**，而多方块文档的帧没有网格 ⇒
   必须把装配出的 `Grid` 放到首帧（同时放到当前帧下标，兼容将来"按当前帧解析"的实现）。
2. **刻意不携带 `multiblock` 节点（也不携带 `_extra`）**：`serialize()` 会优先写入多方块根级 `blockPalette`
   （**并集调色板**，下标是并集下标），而首帧 `structure.blockPalette` 是 `_gridToV2` 依据"装配网格里实际出现的方块"
   **重编号**后的调色板；两者混用会让 `cellGrid` 指向错误条目 —— **静默渲染错方块**。
   不携带多方块节点 ⇒ 顶层只有首帧 structure 一份自洽的 `cellGrid + blockPalette`。
   （单测把这条钉死：逐格比对"装配结果 vs 渲染解析结果"的方块签名，并断言根级调色板不是并集调色板。）
3. **重建走既有公开接口**：`loadStructureAndResources()`（重新解析文档 ⇒ 刷新 `structureDefinition`，纹理缓存复用）
   + `rebuildContentMesh()`（重建 mesh），并用 `watch` 链式串行化；**不 bump `structEpoch`、不 `rebuildAll`**（避免纹理重解码）。

`revision` 只在**取值被用户改动**时自增（文档切换由 `structEpoch` 的 `rebuildAll` 覆盖），避免两条重建链并发。
帧为主文档下 `renderDoc` 返回**原文档对象本身** ⇒ 渲染路径行为零变化。

### 2.2 顺带修正：`vpSlot.definition` 实时同步

`attachViewport` 只在挂载时快照一次 `slot.definition`，此后装配/换层/换帧都不会更新它 ——
`scenePickBase`、嵌入侧栏轮廓、`previewTitle` 读到的都是过期定义。两个视口各加一行
`watch(structureDefinition, d => { vpSlot.definition.value = d ?? null }, { flush:'post' })`，
使 `ctx.viewports.get(rid).definition.value` 成为**当前渲染网格的公开观测点**（T2.6/T3.3 直接用，无需私有后门）。

---

## 3. 面板语义（忠实展示文件声明，零业务猜测）

| 控件 | 来源 | 规则 |
|---|---|---|
| Tier 滑杆 | `decl.totalTierDomain` | 标签恒 `Tier`；`min=domain.min`、`max=domain.max`、`step=1`；值**吸附**到 `decl.tierSample`（最近值，并列取小） |
| 通道滑杆 ×N | `decl.channels.filter(c => c.slider)` | 标签 = `c.name`（**呈现名**，来自文件，非 `capitalize(id)`）；`0..c.domain.hi`；`0` 显示 `Not set` |
| 运行态切换 | `decl.runstates` | `<select>`，选项文本 = `name`（文件自带），value = `id`；单态也照实渲染 |
| 提示列表 | `decl.notes` + `report.clamped` + `report.warnings` | **只提示不拒绝**（契约 §5.2 推论 3）；异常被 UI 层捕获，不穿透 |

**为什么 Tier 吸附 `tierSample`**（T2.2 移交注意②）：未落在抽样里的 Tier 会被装配器回落最近抽样 + warning。
吸附后滑杆只停在**已声明**组合上 ⇒ 不产生由滑杆引起的回落提示；滑杆范围仍是 `1..最大总等级`（**硬约束字面满足**），
抽样位置以 `<datalist>` 呈现（人可见、机器可读 `data-mb-tier-samples`）。文档本身的瑕疵（如未覆盖组合）仍照实提示。

`size` 型通道的 `min`/`max`（有效取值区间）**只作观测/提示**，不改变滑杆范围（`0..domain.hi` 是硬约束）；
不以 `kind` 分支行为（零语义猜测）。

**布局**：通道面板按声明条数自动变高（`height:auto; min-height:40px(embed 48px); max-height:152px; overflow-y:auto`），
只影响该 tab 自身；帧控制/分层预览仍为 40/48px 固定高度。

**状态行顺序**：新增的 `通道 n · Tier t · <运行态>` 摘要（`[data-mb-status]`）放在既有 `帧`/`层` **之后**，
保证既有 `.vp-dock__stat` 的 `.first()` 语义不变（T2.6 harness 的 `readDockStatus` 依赖 `.vp-dock__stat` 首个元素）。

---

## 4. 已核实的限制与后续口径（给 T2.6 / T3.x）

1. **合成 fixture 的方块几何不是可视几何**：三份 fixture 的 `blockPalette[].geometry.quads` 顶点是
   **0..16（MC 像素单位）且每方块只有 2 个共面四边形**（实测：`firstVertex=(0,0,0)..(16,16,0)`，所有 fixture 同形）；
   真实 mod 导出（`web/e2e/fixtures/structuredata-exported-envelope.json` 实测）是 **0..1 单位、逐面绕组**。
   后果（已在 Chromium 内实测）：合成 fixture 的装配网格**确实进入了场景**（顶点 71/72 落在视锥内、
   `contentGroup` 有 2 个 mesh、定义尺寸与面板一致），但在生产材质（`side: FrontSide`）下被背面剔除 ⇒
   **视口看起来是空的**（浏览器内临时把 material 改成 DoubleSide 后立即出现两块大平面，证明是绕组/单位问题，不是接线问题）。
   ⇒ **T2.6/T3.x 不要在合成 fixture 上用"截图非空/相邻等级截图有差异"作为通过判据**；
   改用 `data-mb-dims` / `data-mb-variant` / `definition.cellGrid` / 方块统计行（DOM）等 cellGrid 级断言，
   像素证据留给 T1.6 的真实 `/sde multiblock` 产物（T3.1）。
2. **编辑/拾取仍看文档网格**：`queries.ts` 的 `getFrameBlocks` / `gridCenterWorld` / `getBlockGeometry` 等读
   `doc.frame(i).grid`（多方块文档恒 `null`，均有 null 守卫）⇒ 多方块文档在本轮是**只读查看**：
   悬停 tooltip、选择描边、编辑操作符不作用于装配网格。若要打通，需把装配产物暴露到文档层（超出 T2.4/T2.5 写范围）。
3. **相机不随装配重新拟合**：通道变化只重建 mesh，不重跑 `OPERATOR_INIT_VIEWPORT_CAMERA`
   （与既有"换帧/换层不重新拟合"一致）。结构尺寸变化很大时用户可点「复位视角」重新框选。
4. **分层预览与装配高度**：`gridHeight` 取自 `structureDefinition` ⇒ 自动跟随装配网格；
   若装配后高度变小而 `layerWorldY` 仍停在旧高位，该层会显示为空（既有帧/层切换同款行为），本轮不做夹取。

---

## 5. 无头断言观测点（给 T2.6）

| 观测点 | 说明 |
|---|---|
| `[data-dock-tab="channels"｜"frame"｜"layer"]` | tab 按钮；`通道` tab 存在 ⇔ 多方块为主文档 |
| `.vp-dock__tab--active[data-dock-tab]` | 当前 tab |
| `[data-dock-panel="channels"]` | 通道面板容器（仅在通道 tab 激活时挂载） |
| `[data-mb-panel="channels"]` | 面板根：`data-mb-display-name` / `data-mb-variant` / `data-mb-dims` / `data-mb-tier` / `data-mb-tier-samples` / `data-mb-runstate` |
| `input[data-mb-tier]` | Tier 滑杆（`min`/`max`/`step`）；`[data-mb-tier-value]` 值文本 |
| `input[data-mb-channel="<key>"]` | 通道滑杆（`data-mb-channel-name` / `-kind` / `-hi` / `-eff-min` / `-eff-max`） |
| `[data-mb-channel-label="<key>"]` / `[data-mb-channel-value="<key>"]` | 通道标签 / 值文本（`0` → `Not set`） |
| `select[data-mb-runstate-select]` + `option[data-mb-runstate-id]` | 运行态切换 |
| `[data-mb-notices] [data-mb-notice]` | 提示列表（文件软约束 / 回落 / 夹取） |
| `[data-mb-status]` | tab 行状态摘要（通道条数 · Tier · 运行态呈现名） |
| `window.__vm__.viewports.get(<region>).definition.value` | **当前渲染定义**（`cellGrid` + `blockPalette`），即"装配网格"的公开观测点（`r-viewport` / `r-wiki-preview` / `r-embed`） |
| `window.__vm__.viewports.get(<region>).contentGroup.value` | 当前 mesh 组（可数 `children` / 顶点） |
| `window.__vm__.main.registries.parsers.detectAndParse(raw)` + `main.replaceDoc(doc)` | Workbench 侧 IO 接管（公开路径，无需新后门） |

驱动方式：对 `input[type=range]` 用 `el.value = '5'; el.dispatchEvent(new Event('input', { bubbles: true }))`；
`select` 用 `selectOption`。

### 5.1 与 T2.6 harness 的对接说明（其实测口径已核对）

- T2.6 的 `readRenderedGrid()` 读 `ctx.viewports.get('r-viewport').definition.value`，并注明
  "`slot.layerPreview` 是 attach 时刻快照"。**本任务把 `slot.definition` 变成实时**（§2.2 的一行 watch），
  于是 `readRenderedGrid()` 直接就是"当前装配网格"，T3.3 可据此逐格 diff（无需私有字段）。
- 驱动通道滑杆：`input[data-mb-tier]` / `input[data-mb-channel="<key>"]` / `select[data-mb-runstate-select]`；
  通道滑杆**不做 `meshBusy` 禁用**（连续拖动只排队重建，不会因 disabled 导致注入失败）；
  断言"装配已生效"请用 `[data-mb-panel]` 的 `data-mb-variant` / `data-mb-dims` 变化，
  或 `definition.cellGrid` 的形状/内容变化。
- tab 定位：新 tab 带 `data-dock-tab="channels"`；`.vp-dock__tab` 的文本匹配（`帧控制`/`分层预览`）不受影响。
