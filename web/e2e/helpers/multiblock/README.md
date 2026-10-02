# T2.6 无头渲染断言管线 —— harness 说明（第一阶段：骨架；第二阶段：通道滑杆全组合遍历）

> 计划依据：`docs/plan/multiblock-channel-renderer-plan.md` §T2.6、§5 Phase 3（E 管线的 web 半环）。
> 本目录只做**测试**，不改 `web/src/`。运行：`cd web && npm run test:e2e:multiblock`。
>
> **第二阶段判据框架（调度者裁决）**：合成 fixture 的视觉不可见是**几何属性问题**，不是链路问题，
> 因此 **cellGrid 级断言为通过判据**（`data-mb-variant` / `data-mb-dims` / 逐格 diff），
> **像素断言只诊断记录、不作门禁**（门禁留给 T3.1 的真实导出产物）。

## 1. 文件

| 文件 | 作用 |
|------|------|
| `helpers/multiblock/harness.ts` | 入口挂载、IO 接管（场景注入）、公开观测读取、DOM 事件注入、等待原语 |
| `helpers/multiblock/pixels.ts` | 截图非空断言（像素级）+ 像素签名/差异判据（「结构真的变了」的机器判据） |
| `helpers/multiblock/contract.ts` | 三份多方块 fixture 的**文档声明级**钉死契约 + 断言谓词 + 只读读取/内存篡改工具 |
| `helpers/multiblock/panelContract.ts` | **第二阶段新增**：**面板 UI 级**钉死期望（滑杆条数/标签/范围/Not set/Tier 域/运行态）+ 期望组合枚举 + 尺寸方向契约 |
| `helpers/multiblock/referenceGrids.ts` | **第二阶段新增**：552 份参考展开网格的读入、**调色板下标 → 方块签名**对齐、逐格 diff、缺文件就地补生成 |
| `helpers/multiblock/frameDoc.ts` | 「帧为主」多帧样例合成器（仓库现有样例都是单帧） |
| `helpers/multiblock/channels.ts` | 通道面板选择器 + `readChannelPanel` / `setTier` / `setChannelValue` / `setRunstate` / `openChannelTabReady` / **`drivePanel`（批量驱动）** |
| `../../multiblock-fixture-load.spec.ts` | 多方块 fixture 加载断言（不依赖通道 UI） |
| `../../multiblock-frame-regression.spec.ts` | 帧播放 / 分层预览语义回归（T3.4 复用） |
| `../../multiblock-falsification.spec.ts` | 断言有效性证伪（篡改注入副本 → 管线必须变红；含第二阶段 **indexTable 逐格证伪**） |
| `../../multiblock-channel-panel.spec.ts` | **第二阶段**：面板声明一致性（3 份 fixture × 条数/标签/范围/Not set/Tier 域/运行态） |
| `../../multiblock-channel-traversal.spec.ts` | **第二阶段**：全组合遍历（desktop 552 / mobile 抽样）+ 逐格 diff + 尺寸方向 + 像素诊断 |
| `../../multiblock-channel-illegal.spec.ts` | **第二阶段**：非法组合行为（域外夹取 / Tier 吸附 / 耦合 clamp / Not set 回落） |

## 2. 零替身五原则的落点

1. **入口挂载**：`gotoWorkbench(page)` 打开 `/`（`index.html` → `main-dev.ts` → `DevApp.vue` → 完整 `WorkbenchRoot.vue`）。不挂测试壳、不 import 内部模块拼装。
2. **DOM 事件注入**：`setSliderValue()` 在真实 `<input type=range>` 上设值并派发 `input`/`change`；`pressSliderKey()` 用真实键盘（`Home` 等）驱动；tab 用真实 `click()`。滑杆 → Vue `@change` → `ctx.getOperators().exec(...)`，与真人操作同路径，不跳过监听器、不直接调 operator。
3. **IO 接管**：`injectSceneDocument(page, json, fileName)` 构造 `File` 后调用 `ctx.getOperators().exec('OPERATOR_OPEN_SCENE', { file })` —— 这就是**生产代码自己的入口**（`WorkbenchViewport.vue#onDrop` 对拖入的 .json 走同一 operator、同一 `file` 属性）。因此**没有为测试新开 src 侧后门**；仓库 fixture 原件永不被改写（篡改只发生在测试内存的注入副本上）。
4. **公开观测**：见下表。
5. **零替身**：全程生产类实例，无 Mock/Fake/Stub，无测试专用 URL 参数。

## 3. 公开观测点清单

| 观测点 | 读法 | 用途 |
|--------|------|------|
| `window.__vm__` | `WorkbenchRoot.vue` 显式声明「测试层通过 `window.__vm__` 访问公开观测面」；`__vm_ready__` 为就绪标志 | 全部观测入口 |
| 文档形态 | `ctx.getDoc().value.isMultiblock` | 帧为主 / 多方块为主判别（互斥） |
| 通道清单 | `doc.multiblockChannels` → `{key, enumName, id, name, kind, min, max, slider, domain:{lo,hi}, slot}` | 通道条数/标签/取值域（第二阶段滑杆断言的基础） |
| 运行态 | `doc.multiblockRunstates` → `{id, name, materialSwap}` | 运行态数与呈现名 |
| 变体 / 规则 / 帧声明 | `doc.multiblockVariants` / `multiblockRules` / `multiblockFrames` | 变体数（432/12/108）、规则数、一变体一帧 |
| 骨架（格级） | `doc.multiblock.decl.backbone.sizeSteps[i].cellGrid` | Phase 1 唯一可公开观测的**逐格**数据 |
| 契约内层原文 | `doc.multiblockSource` | 装配器输入就绪性 + 与 `decl` 逐格一致性交叉校验 |
| 总 Tier 域 | `doc.multiblock.decl.totalTierDomain` | `{min,max,default}` |
| 帧数据 | `doc.frames[i].grid` → `{depth,height,width,count()}` | 帧为主文档的「当前帧数据」 |
| 当前帧 / 图层 | `ctx.getCurrentFrameIndex().value` / `ctx.getLayerWorldY().value` | 帧切换与分层预览语义 |
| 渲染网格 | `ctx.viewports.get('r-viewport').definition.value` → `{cellGrid, blockPalette}` | **T3.3「web 装配 vs mod 导出逐格 diff」的 web 侧输入**（与 DRW 用同一份 `StructureDefinition`） |
| DOM | `.vp-dock__tab`、`.vp-dock__tab-status`（`帧 i/N` / `层 X`）、`input[aria-label^="当前帧"]`、`#wm-layer-range`、`.wm-wfp-controls .nei-ctrl-btn`（`aria-pressed`）、`.vc-viewport canvas` | UI 语义与布局断言 |
| 截图 | `page.screenshot()` / `locator.screenshot()` | 证据链 + 非空 + 差异判据 |

> 注意：`ctx.viewports.get(id).layerPreview` 是 **attach 时刻的快照**（`attachViewport` 只写一次），不要拿它当图层模式的观测点；用 `ctx.getLayerWorldY()` + dock 的 `层` 标签。

## 4. 截图非空断言（阈值与实测）

统计在**浏览器侧**解码（Playwright 的 PNG 以 data URL 交回页面，用 `Image`+`2D canvas` 取像素），
因此 Node 侧不需要 `pngjs`/`sharp`（仓库无这些依赖）。

判据（三条「与」关系，任一不满足即判空）：

| 判据 | 门限 | 理由 |
|------|------|------|
| `uniqueColors`（5bit/通道量化） | ≥ 32 | 真实帧实测 300～800；纯色=1、双色=2。门限比退化工况高 16 倍、比实测低一个数量级 |
| `stdDevLuma` | ≥ 3（0..255） | 纯色 σ=0；实测 20～34 |
| `nonBlackRatio`（luma>16 占比） | ≥ 0.02 | 实测 0.977～0.9998；只拦「整幅几乎全黑」（WebGL 上下文丢失 / mesh 未构建 / 黑帧） |

实测样本（`screenshots/multiblock/*.png` 为证据）：

| 场景 | uniqueColors | stdDevLuma | nonBlackRatio |
|------|--------------|-----------|---------------|
| 整页（桌面 1280×800） | 711～714 | 33.7～33.8 | 0.9998 |
| 视口（桌面 978×628，真实几何） | 495～497 | 27.45 | 0.988 |
| 视口（窄 250×1526） | 808 | 27.11 | 0.9985 |
| 纯色画布（证伪） | 1 | 0.000 | 0 |

**阈值有效性已证伪**：`multiblock-falsification.spec.ts` 用页面内生成的纯色 PNG 走同一断言路径，必须被拒。

## 5. 「结构真的变了」判据（第二阶段 / T3.1 的相邻取值差异）

`readPixelSignature()` 把截图压成 16×16 灰度均值向量；`signatureDiff()` 给出
`{meanAbs, maxAbs, changedCells, changedCellRatio}`。

正向判据用**两条独立证人**（`expectSignificantPixelChange`）：

- `maxAbs > 8`（单格亮度差）
- `changedCellRatio > 0.01`（至少 256 格里 3 格）

实测分离度（ALL → 单层 Y=0，隐藏 167/173 格）：

| 视口 | 重复截图（噪声地板） | 真实结构变化 |
|------|--------------------|-------------|
| 桌面 978×628 | meanAbs 0.0085 / maxAbs 2.10 / 变化格 **0** | meanAbs 4.52 / maxAbs 76.02 / 变化格 38 |
| 窄 250×1526 | meanAbs 0.0027 / maxAbs 0.66 / 变化格 **0** | meanAbs 0.45 / maxAbs 20.15 / 变化格 5 |

窄视口下均值被大片同色背景稀释到 **0.45（低于 0.5 的均值门限）**，所以正向判据**不看均值**，
只看向量与单格幅度；均值门限只用于「重复截图必须一致」的负向判据。

## 6. 第二阶段（通道滑杆遍历）—— 已执行的设计与实测口径

### 6.1 选择器与驱动原语（T2.4 作者显式声明，本阶段固化）

| 选择器 | 含义 |
|--------|------|
| `[data-dock-tab="channels"]` | Dock 上的「通道」tab（`openChannelTab` / `openChannelTabReady`） |
| `[data-mb-panel="channels"]` | 面板根：`data-mb-display-name` / `-variant` / `-dims` / `-tier` / `-tier-min` / `-tier-max` / `-tier-samples` / `-runstate` |
| `input[data-mb-tier]` | Tier 滑杆（`min..max` 来自声明；只监听 `@input`；`data-mb-tier-samples` 给已声明抽样） |
| `input[data-mb-channel="<key>"]` | 通道滑杆（`0..domain.hi`，`0` = `Not set`；只监听 `@input`） |
| `[data-mb-tier-value]` / `[data-mb-channel-value="<key>"]` | 数值文本（`0` → `Not set`） |
| `select[data-mb-runstate-select]` + `option[data-mb-runstate-id]` | 运行态切换（`@change`） |
| `[data-mb-notices] [data-mb-notice]` | 只提示不拒绝的提示（软约束 / 回落 / 夹取） |

驱动原语（全部经真实 DOM 事件，不直接调 operator）：

| 原语 | 用途 |
|------|------|
| `drivePanel(page, {tier?, values?, runstate?})` | **批量**驱动（一次 CDP 往返）：Tier → 各通道 → 运行态，只派发改动过的控件 |
| `setTier` / `setChannelValue` / `setRunstate` | 单控件驱动（非法组合用例逐个驱动时用） |
| `waitForRenderMatch(probe, timeout)` | 轮询渲染定义直到**逐格 diff 归零**（装配异步：`revision++` → `watch(flush:'post')` → `loadStructureAndResources` → `rebuildContentMesh`） |
| `readRenderedDefinition(page)` | 读回渲染定义**原样**内容（`cellGrid` + 原始 `blockPalette`），签名对齐在 Node 侧做 |

### 6.2 ⚠️ 驱动通道面板的两个坑（实测踩到，已固化为原语行为）

1. **`drivePanel` 必须把 DOM 滑杆的值写回"模型当前值"**。Tier 滑杆**吸附**已声明抽样
   （`snapTierToSample`），而 `setTier` 在"吸附后与当前模型值相同"时**直接 return、不 commit**——
   此时 Vue 不会重渲染，DOM 里就留着你刚写进去的**原始输入值**。下一次派发 `input` 时
   处理函数读到的是这个**陈旧输入**（实测表现为"请求 tier=2 却被吸附到 14"）。
   所以 `drivePanel` 在派发后把 `el.value` 复位为 `data-mb-tier`
   /`[data-mb-channel-value]` 的当前模型值；真人拖动走的是原生 value 变化路径，不受影响。
2. **不要"先批量驱动完再逐条断言"**。每个组合必须在**驱动后立刻**等收敛并断言；
   否则页面停在最后一个取值上，前面几条必然报"不收敛"（假红）。

### 6.3 覆盖矩阵与耗时实测（`--retries=0`，本机）

| project | fixture | 组合数 | 覆盖 | 格数 | 逐格 diff=0 | 总耗时 | ms/组合 | 收敛探测 |
|---------|---------|-------:|------|-----:|------------:|-------:|--------:|---------:|
| desktop-chrome | EBF（3 通道） | **432** | 全量 | 11448 | 432/432 | 277.6 s | 642.6 | 1.00 |
| desktop-chrome | tier-only | **12** | 全量 | 48 | 12/12 | 12.2 s | 1016.5 | 1.00 |
| desktop-chrome | LSC（作用域相交） | **108** | 全量 | 3078 | 108/108 | 100.9 s | 934.7 | 1.00 |
| desktop-chrome | **合计** | **552** | **全量** | **14574** | **552/552** | **≈391 s** | ≈708 | 1.00 |
| mobile-chrome | EBF | 18 | 抽样 | 468 | 18/18 | 27.5 s | 1526.3 | 1.00 |
| mobile-chrome | tier-only | 9 | 抽样 | 36 | 9/9 | 14.6 s | 1619.9 | 1.00 |
| mobile-chrome | LSC | 6 | 抽样 | 180 | 6/6 | 8.6 s | 1439.3 | 1.00 |
| mobile-chrome | **合计** | **33** | **抽样** | **684** | **33/33** | **≈51 s** | ≈1535 | 1.00 |

- 抽样规则（固定、可复现、不随机）：每 fixture 取 `全 0`（Not set 基线）/ `各通道有效下界` /
  `各通道域上界` 三组取值 × `tierSample` × 运行态集 → EBF 18 / tier-only 9 / LSC 6。
- 整个 multiblock 套件（两个 project、9 个 spec 文件）**6.8 min**；`npx playwright test --retries=0` 全绿。
- 截图策略：**每个 Tier 档位的第一条组合**截一张视口图（证据链跨档，实测 351 张共 5.1 MB），
  不为 552 个组合各存一张几乎完全相同的 PNG。
- 已做的性能优化：同文档内**渐进拖动**（每 fixture 只注入一次文档）+ `drivePanel` 批量驱动 +
  像素统计只在诊断用例做（不在 552 循环里做）。
- **开放优化**：EBF 全量实测 642.6 ms/组合，而 40 组合的小样本探针只有 ≈365 ms/组合
  （驱动 145 ms / 读格 38 ms / 截图 914 ms）。同页面连续跑数百个组合后单组合变慢的累积效应
  （疑似渲染器每轮重建的资源增长）未定位；552 全量仍在 7 min 量级，暂不阻塞验收。

### 6.4 逐格 diff（T3.3 预演）的对齐口径

参考基线 = `scripts/multiblock-fixtures/.out/expanded-fixtures/`（`--all --verify-grids` 落盘，
**552 份**，`.gitignore` 内可再生）。缺文件时 `snapshotOrFallbackReference()` 会用
**同一份冻结蓝本** `scripts/multiblock-fixtures/lib.mjs` 就地补生成（绝不静默跳过），
失败则抛错并给出确切再生命令。

**① 坐标朝向：两边同一口径，不做任何翻转。**

| 侧 | 形状 | 含义 |
|----|------|------|
| 参考（`lib.mjs` 的 `newGrid(w,h,d)` / `assembleVariant`） | `cellGrid[z][y][x]`，`[d,h,w]` | `row 0 = 结构顶部` |
| 渲染（`@/render/schema/types.ts` 的 `cellGrid[zSlice][row][column]`） | 同上，`[d,h,w]` | `row 0 = 结构顶部`（世界 Y = `structureRowToWorldY(row,h) = h-1-row`） |

`referenceGrids.ts` **不做 row/z 翻转或转置**：若两边朝向本来不一致，diff 会立刻变红——
这正是想要的（而不是被一段"看起来合理"的翻转掩盖）。

**② 调色板下标 → 方块签名：按内容派生，不假设两边编号相同。**

两边下标空间不同：参考下标指向 fixture 的**并集调色板**（EBF 9 条），渲染下标指向
`_gridToV2` **重编号**后的调色板（只含该组合实际出现的方块；`buildMultiblockRenderView`
刻意不传并集调色板，否则下标错位 → 静默渲染错方块）。实测渲染调色板尺寸 **3/4/5**（随组合而变），
而参考并集恒为 9。

对齐方式 = 两边各自把"下标 → 签名"建表，再逐格比签名：

| 口径 | 定义 | 是否门禁 |
|------|------|---------|
| `idMeta` | `name:meta`（`registryId` 去命名空间；`air` → `''`） | **是（唯一门禁）** |
| `full` | `canonicalJson(entry)`（对象键排序、数组保序，与 `lib.mjs#entrySignature` 同口径），但 **`air` 同样归一为空串** | 否（更强的旁证，记录用） |

`full` 口径把 air 归一的原因：参考侧 air 是一条带 `geometry/tooltip/occludesAdjacentFaces`
的**完整条目**，渲染侧 air 只有 `{registryId:'air',meta:0}` —— 不归一的话每个含空气格的组合
都会"差异"，把真差异淹没（初版实测 LSC 108 个组合里 72 个假红，归一后 0）。

**③ 已知不可分辨项（必须如实声明，不得掩盖）：**

- **EBF 并集调色板 7/8**：`registryId@meta` 完全相同（`gregtech:gt.blockmachines@1000`），
  只有 tooltip（`"Electric Blast Furnace"` vs `"(running)"`）与 `nbt.activeFace` 不同。
  渲染侧经 `Grid`（`SlotBlock = {name, meta}`）**按 `name:meta` 归并**，两者必然合并成一条，
  且**归并后保留哪一条是不确定的**（实测保留的是第 8 条的 tooltip + `nbt`）。
  因此 EBF 上"运行态把 7 写成 8"这类**同 `name:meta` 互换**在本管线的 `idMeta` 口径下**不可分辨**；
  该盲区由 `web/src/context/__tests__/multiblockAssembler.test.ts`（比对并集**下标**，552 组合）
  兜住。遍历用例把 `full` 口径差异打成诊断日志，`idMeta` 口径才是门禁。
- 第二阶段的 552 组合 diff 实测 **full 与 idMeta 两个口径都是 552/552 = 0 差异**。
- 另有两条**只与"下标"有关、与身份无关**的护栏：渲染调色板的每个非空条目必须能从参考并集
  `name:meta` 集合派生（不得凭空出现方块身份），且下标 0 必须是 air。

### 6.5 面板声明一致性（交付 1）与尺寸方向（交付 3）

- 面板一致性：对 3 份 fixture 逐项硬编码断言（`panelContract.ts`）—— 滑杆条数 = 声明通道数
  （EBF 3 / tier-only 1 / LSC 3）、标签 = 呈现名（逐字）、范围 `0..domain.max`、
  `0` 显示 `Not set`、`data-mb-tier-min/max` = `totalTierDomain`、抽样清单 = `tierSample`、
  运行态选项（id + 呈现名 + 顺序）逐项一致、文件 `notes` 逐条呈现为 notice。
- 尺寸方向：EBF `height 1→5` 高度实测 **1 → 2 → 3 → 4 → 5**；
  tier-only `Tier 1→3` 高度实测 **3 → 4 → 5**（两个 project 一致）。
  断言除"逐档期望值"外另加"至少一档严格变大"（防"滑杆没接线也会绿"）。

### 6.6 非法组合行为（交付 5）实测

| 场景 | 实测行为 |
|------|---------|
| 域外取值 `coil=99` / `glass=99` / `height=99` | 滑杆被**浏览器原生**夹到 `3`/`2`/`5`，装配命中域内取值的参考网格（无夹取提示，因为域外值根本到不了装配器） |
| 域外取值 `coil=-7` | 滑杆夹到 `0`（显示 `Not set`）→ 装配期回落总 Tier=2 并按域夹取 → 命中 `coil:2` |
| Tier 未声明抽样 `3/7/13` | 滑杆**吸附**到已声明抽样 `2/2/14`，面板不出现"未声明→回落"提示；**UI 上不存在未声明的 Tier**（比"回落"更强的保证） |
| LSC 耦合违规 `capacitor=1, glass=2` | 被 clamp 成 `glass=1`，面板如实呈现 `耦合夹取：capacitor ge glass：2 → 1`；`capacitor=2,glass=1` 与 `capacitor=1,glass=1`（相等合法）均无耦合提示 |
| Not set 回落越域 `tt=14, capacitor=0/glass=0` | 面板如实呈现 `取值夹取：capacitor 14 → 2` 与 `取值夹取：glass 14 → 2` |

### 6.7 证伪（交付 6）

在既有 `multiblock-falsification.spec.ts` 内新增第二阶段用例：篡改 EBF `coil.slot` 的
`indexTable`（`[2,2,3,4]` → `[2,2,4,3]`，互换两项**内容不同**的表项），注入内存副本后驱动到
`height:5|coil:2|glass:2|tt:1|idle` → 逐格 diff **恰好 1 格**变红：
`(x=1,row=1,z=1)` 参考 `gt.blockcasings5:4`(Kanthal) vs 渲染 `gt.blockcasings5:5`(Nichrome)；
对照组 `coil=0`（未动的表项）与 `coil=1`（被互换两项**同值**）都必须仍为 0 差异（证明证伪是**定向**的）。

**选目标组合时踩的两个坑（已写进用例注释）**：`coil.slot` 是 `(x=1,y=1,z=1)` 的 `setCell`，
而 `row 0 = 顶部` —— `height=1`（3×1×3）时 `row=1` **越界**，规则被 `expandOp` 静默丢弃；
`height=2` 时该格又被同相位更靠后的运行态规则 `runstate.face.h2.idle` **覆盖**（后写者胜）。
只有 `height=5` 的组合里该格由 `coil.slot` 独占 —— 否则"证伪失败"其实是"目标选错"。

### 6.8 像素诊断（**非门禁**，供 T3.1 对照）

两个 project 的结论一致，且本轮 `meanAbs/maxAbs/变化格` 全为 **0.0000 / 0.00 / 0**：

| project | 重复截图（噪声地板，门禁） | `height 1→5` | `idle→active` | 视口 uniqueColors |
|---------|--------------------------|--------------|---------------|-------------------|
| desktop-chrome | 0 / 0 / 0 格 | 0 / 0 / 0 格 | 0 / 0 / 0 格 | 219（σ=13.03） |
| mobile-chrome | 0 / 0 / 0 格 | 0 / 0 / 0 格 | 0 / 0 / 0 格 | 273（σ=26.25） |

即：合成 fixture 上"换通道取值 / 换运行态"在视口像素上**完全不可观测**（与第一阶段开放项 1 一致，
且被本阶段在 552 组合尺度上再次确认）。**T3.1 的像素门禁只能建立在真实导出产物上**；
合成 fixture 的像素数据仅作对照基线（同视口的帧为主样例 uniqueColors 500+）。

## 7. 已知开放项

1. **多方块 fixture 的装配几何在视口里看不到内容（阻断第二阶段的像素判据）**。
   实测（桌面，EBF，`3×2×3` 装配 18 格）：`slot.contentGroup` 里确有 2 个 mesh / 24 个三角形
   （`visible=true`、`MeshBasicMaterial` 不透明、`map=true`、几何已在场景中），
   相机也是常规正交视角，但**截图与空场景等价**：
   - 换通道取值（`height` 0/1/5）、换运行态（idle/active）、换 Tier 都是 **0 格像素变化**
     （`signatureDiff = {meanAbs:0, maxAbs:0, changedCells:0}`）；
   - 视口 `uniqueColors` 恒为 219（≈ 纯背景 + UI chrome），而帧为主样例同视口为 495+。
   已知候选原因（需 T2.5/DRW 侧定位）：① 装配后相机未重取景 —— `orbitTarget = (7.5,7.5,7.5)`
   是 15³ 网格的中心，而装配结果只有 `3×2×3`；② fixture 每方块仅 2 个 quad + `occludesAdjacentFaces`
   导致 18 格只剩 24 个三角形，可能被裁掉大半；③ 装配产出的 mesh 与渲染场景的绑定。
   **影响**：第二阶段/T3.1 的「相邻取值截图必须有差异」在合成 fixture 上目前不可能通过。
   建议：优先定位 ①/③；在修复前，第二阶段可先用 `readRenderedGrid()` 做**定义级逐格断言**
   （T3.3 的 diff 判据本来就更强），或用 T1.6 的真实 `/sde multiblock` 产物做像素判据。
2. **V2Plain 多帧文档的帧切换不重建网格**（既有实现）：`drwMeshPipeline` 的
   `isWorldDocument(plain)` 门对 `format_version === '2.0'` 恒为 false，
   而 `RuntimeDocument.serialize()` 永远写 `format_version: '2.0'`，
   因此 `ctx.getCurrentFrameIndex()` 会变、DOM 会变、播放会推进，但渲染定义仍停在帧 0。
   实测（桌面/窄视口一致）：切换后 `definition` 与帧 0 完全相同。
   本阶段据此**只断言「doc 当前帧变化 + DOM 状态 + 播放推进」**，不对渲染跟随设断言，
   并把实得值打进日志（`[T2.6] 帧切换后渲染定义诊断`）。若 T3.4 要求「帧切换几何真的变」，
   需先判定这是既有设计还是缺陷。
3. **窄视口下 Workbench 帧/层滑杆宽度被挤为 0**：`mobile-chrome`（Pixel 5，393 CSS px）时
   视口列宽约 250 px、高 1526 px，`input[type=range]` 的 `getBoundingClientRect().width === 0`
   → Playwright 判定 `hidden`。属既有窄布局限制，非 T2.6 引入。
   处理口径：功能断言（DOM 事件驱动 + 公开观测）在窄视口照跑；**可见性**断言只在
   `desktop-chrome` 上设；窄视口改为断言「滑杆仍有行高」并记录布局盒。
4. **`e2e/fixtures/minimal-v2.json` 不能渲染几何**：其 `textureBlobs` 是
   `{id,mime,dataBase64}[]` 对象数组，渲染侧 `rootTextureBlobs()` 只认 `string[]`，
   实测报 `[drw] buildBlockMesh Error: 纹理未预取: 0`。
   它仍可用于**形态判别**断言（帧为主 → 非多方块），但不能用于截图证据；
   帧回归样例因此改用真实导出信封 `structuredata-exported-envelope.json` 派生。
5. **`@types/node` 未安装**：`web/tsconfig.json` 只 include `src/**`，e2e 目录不在
   `vue-tsc` 范围内（既有 `obj-export.spec.ts` 同样如此）。因此 `node:fs` / `Buffer` /
   `import.meta.dirname` 在独立 `tsc` 下会报缺类型——属环境现状，不影响 Playwright 运行。
6. **Playwright 浏览器**：本机需 `cd web && npx playwright install chromium`
   （`chromium_headless_shell` 缺失时全量 e2e 会以 `Executable doesn't exist` 全红）。
7. **第二阶段补记 —— 面板不渲染 `data-mb-declared`**：`MultiblockChannelPanelModel` 有
   `declared` 语义（是否命中已声明组合），但组件**没有**把它输出成 DOM 属性，
   故 `readChannelPanel().declaredVariant` 实测恒为 `null`（不可观测）。
   本阶段改用两条可观测的等价证据：(a) 面板变体键与"期望声明键"逐字比对；
   (b) 552 个可达组合的渲染网格与**参考展开网格**逐格为 0 差异。
   若后续希望把"组合是否已声明"也纳入无头观测面，需要 T2.4 侧补一个 `data-mb-declared` 属性
   （属 `web/src/`，不在本阶段写范围内）。
8. **第二阶段补记 —— 合成 fixture 的渲染调色板是"按本组合实际出现方块重编号"的**：
   同一组合里 `_gridToV2` 只保留 `name:meta` 首次出现的条目，故 EBF 上并集调色板 7/8
   （同 `name:meta`，tooltip/nbt 不同）必然归并、且保留哪一条不确定。
   影响：逐格门禁只能用 `name:meta` 口径；**同 `name:meta` 的内容互换在该口径下不可分辨**
   （由 `web/src/context/__tests__/` 的下标级单测兜住）。
9. **第二阶段补记 —— 遍历的单组合耗时随组合数累积上升**：40 组合探针 ≈365 ms/组合，
   EBF 全量 432 组合实测 642.6 ms/组合（均含截图）。累积效应疑似渲染器每轮 mesh 重建的
   资源增长，未定位；552 全量仍在 7 min 量级（可用，但不理想）。
   如 Phase 3 需要进一步压缩，候选手段：把 552 组合分片到多个测试/worker（`fullyParallel`
   与 `workers` 当前为默认串行），或把 `loadStructureAndResources` 的重复资源解析纳入诊断。
