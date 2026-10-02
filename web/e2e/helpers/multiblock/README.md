# T2.6 无头渲染断言管线 —— harness 说明（第一阶段：骨架）

> 计划依据：`docs/plan/multiblock-channel-renderer-plan.md` §T2.6、§5 Phase 3（E 管线的 web 半环）。
> 本目录只做**测试**，不改 `web/src/`。运行：`cd web && npm run test:e2e:multiblock`。

## 1. 文件

| 文件 | 作用 |
|------|------|
| `helpers/multiblock/harness.ts` | 入口挂载、IO 接管（场景注入）、公开观测读取、DOM 事件注入、等待原语 |
| `helpers/multiblock/pixels.ts` | 截图非空断言（像素级）+ 像素签名/差异判据（「结构真的变了」的机器判据） |
| `helpers/multiblock/contract.ts` | 三份多方块 fixture 的**钉死契约**（期望值硬编码）+ 断言谓词 + 只读读取/内存篡改工具 |
| `helpers/multiblock/frameDoc.ts` | 「帧为主」多帧样例合成器（仓库现有样例都是单帧） |
| `helpers/multiblock/channels.ts` | **第二阶段接口预留**：通道面板选择器 + `readChannelPanel` / `setTier` / `setChannelValue` / `setRunstate` |
| `../../multiblock-fixture-load.spec.ts` | 多方块 fixture 加载断言（不依赖通道 UI） |
| `../../multiblock-frame-regression.spec.ts` | 帧播放 / 分层预览语义回归（T3.4 复用） |
| `../../multiblock-falsification.spec.ts` | 断言有效性证伪（篡改注入副本 → 管线必须变红） |

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

## 6. 第二阶段（通道滑杆遍历）的接口预留

第二阶段不需要新增基础设施，直接组合既有能力。**选择器已由 T2.4 作者在
`web/src/shared/viewport/MultiblockChannelPanel.vue` 文件头显式声明为「T2.6 无头断言用的稳定观测选择器」**，
`channels.ts` 把它们固化为常量与薄封装：

| 选择器 | 含义 |
|--------|------|
| `[data-dock-tab="channels"]` | Dock 上的「通道」tab（`openChannelTab(page)`） |
| `[data-mb-panel="channels"]` | 面板根：`data-mb-display-name` / `-variant` / `-dims` / `-tier` / `-tier-min` / `-tier-max` / `-runstate` |
| `input[data-mb-tier]` | Tier 滑杆（`min..max` 来自声明；只监听 `@input`） |
| `input[data-mb-channel="<key>"]` | 通道滑杆（`0..domain.hi`，`0` = `Not set`；只监听 `@input`） |
| `[data-mb-tier-value]` / `[data-mb-channel-value="<key>"]` | 数值文本（`0` → `Not set`） |
| `select[data-mb-runstate-select]` + `option[data-mb-runstate-id]` | 运行态切换（`@change`） |
| `[data-mb-notices] [data-mb-notice]` | 只提示不拒绝的提示（软约束 / 回落 / 夹取） |

```ts
await gotoWorkbench(page)
await injectSceneDocumentOk(page, fx.envelope, c.file)
const doc = await readDocObservation(page)      // 通道清单 + 取值域（0 = "Not set"）
expectDeclaration(doc, c)                        // 声明级契约
await openChannelTab(page)
const panel = await readChannelPanel(page)       // UI 忠实反映文件声明（含 variantKey / dims / notices）

for (const combo of combos) {
  await setTier(page, combo.tier)                        // 或 setChannelValue/setRunstate
  for (const [k, v] of Object.entries(combo.values)) await setChannelValue(page, k, v)
  await waitForMeshIdle(page, TIER_SLIDER)               // meshBusy → 滑杆 disabled → 重新可交互即装配结束
  const cap = await captureEvidence(page, page.locator(VIEWPORT_CANVAS), label, shotPath)
  expectSignificantPixelChange(prev.signature, cap.signature, label)   // 相邻取值必须真的变
  prev = cap
  const grid = await readRenderedGrid(page)              // T3.3 逐格 diff 的 web 侧输入
}
```

**本阶段已验证**（一次性探针，未固化为断言，避免与并行开发耦合）：
`openChannelTab` / `readChannelPanel` / `setTier` / `setChannelValue` / `setRunstate` 三份 fixture 全部可用；
EBF `height=0`(`Not set`)→`3×2×3`、`height=1`→`3×1×3`、`height=5`→`3×5×3`，
tier-only `tier=1`→`1×3×1`、`tier=3`→`1×5×1`，
lsc 的 clamp 提示（`取值夹取：capacitor 14 → 2`）如实呈现 —— 声明 → 滑杆 → 装配 → `dims`/`variantKey` 全链路通。

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
