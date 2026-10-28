# `web/e2e/helpers/multiblock/` —— 多方块无头断言包

本目录只做测试，不改 `web/src/`。格式契约见 [docs/contracts/format-multiblock-doc.md](../../../../docs/contracts/format-multiblock-doc.md)。

## 1. 运行

```powershell
cd web
npm run test:e2e:multiblock            # 全部 multiblock spec
npx playwright test multiblock-channel-traversal.spec.ts
npx playwright test multiblock-real-acceptance.spec.ts --retries=0
```

| 变量 | 作用 |
|---|---|
| `MB_REAL_EXPORTS_DIR` | 真实产物目录（绝对路径，或相对仓库根 / 进程 CWD 的路径） |
| `LIGHTNING_REAL_FIXTURES_DIR` | 树外真实夹具根；`frameDoc` 从中读 `structuredata/structuredata-exported-envelope.json` |

缺产物时的行为由 `web/e2e/real-artifact-gate.ts` 决定：`multiblock-real-acceptance.spec.ts` 缺 `*.multiblock.json` 产物、`multiblock-falsification.spec.ts` 与 `multiblock-frame-regression.spec.ts` 缺 StructureData 真实信封时，这些 spec 从本次收集排除，并在启动横幅与 `web/test-results/e2e-exclusions.json` 中登记；产物就绪时自动纳入，且必须通过。

判据框架：合成 fixture 的几何在视口里不可见（相机取景与遮挡裁剪的几何属性），因此遍历类用例的通过判据是 `cellGrid` 级（`data-mb-variant`、`data-mb-dims`、与参考展开网格逐格一致），像素只作诊断。真实导出产物的几何可见，像素断言在那里作为门禁，阈值与判定函数见 `multiblock-real-acceptance.spec.ts`。

覆盖口径：`desktop-chrome` 跑精简集 `reducedTraversal(file)`，由内容互异类代表、轴跃迁见证与逐档覆盖三类成员守住分辨力，省略者逐条配对到等价成员；`assertReducedTraversal` 自证这三条不变量。`mobile-chrome` 跑抽样子集（取值三档 × Tier 首尾 × 运行态）。真实产物验收在 desktop 跑全量声明组合、mobile 跑固定抽样。

## 2. 文件

| 文件 | 作用 |
|---|---|
| `harness.ts` | 入口挂载、IO 接管、公开观测读取、DOM 事件注入、等待原语（含 `readContentMesh` / `waitForMeshGeneration` / `waitForRenderMatch`） |
| `channels.ts` | 通道面板选择器与 `readChannelPanel` / `setTier` / `setChannelValue` / `setRunstate` / `drivePanel` / `pollComboSettled` |
| `panelContract.ts` | 面板 UI 级钉死期望（滑杆条数、标签、范围、Not set、Tier 域与抽样、运行态顺序） |
| `contract.ts` | 三份合成 fixture 的文档声明级钉死契约与内存篡改工具 |
| `referenceGrids.ts` | 参考展开网格读入、调色板下标到方块签名的对齐、逐格 diff |
| `realExports.ts` | 真实产物目录解析、读入、声明级期望枚举、像素对照组构造、展开校验文件与逐格 diff |
| `reducedTraversal.ts` | 精简遍历集的构造与自证 |
| `pixels.ts` | 截图非空判据、16×16 像素签名与差异判据 |
| `pictureStats.ts` | 视口画面统计（截图在页面内解码，只回统计标量） |
| `frameDoc.ts` | 「帧为主」多帧样例合成器（从真实 StructureData 信封派生，模块 import 期零 IO） |
| `readyBudget.ts` | ready 等待预算的纯策略 |
| `index.ts` | helper 出口（`export *`） |
| `../../../e2e/multiblock-fixture-load.spec.ts` | fixture 加载与形态判别 |
| `../../../e2e/multiblock-frame-regression.spec.ts` | 帧播放与分层预览语义回归 |
| `../../../e2e/multiblock-falsification.spec.ts` | 断言有效性证伪（篡改注入副本，管线必须报错） |
| `../../../e2e/multiblock-channel-panel.spec.ts` | 面板声明一致性 |
| `../../../e2e/multiblock-channel-traversal.spec.ts` | 组合遍历：变体键、尺寸、逐格 diff、尺寸方向、像素诊断 |
| `../../../e2e/multiblock-channel-illegal.spec.ts` | 非法组合行为（取值裁剪、Tier 吸附、耦合限制、Not set 回落） |
| `../../../e2e/multiblock-real-acceptance.spec.ts` | 真实产物验收：声明一致性、组合遍历、像素门禁、逐格 diff、证伪 |

## 3. 公开观测点

全部观测经 `window.__vm__`（`WorkbenchRoot.vue` 声明的测试观测面）与生产 DOM，不读私有字段。

| 观测点 | 读法 | 用途 |
|---|---|---|
| 文档载入与帧数 | `ctx.hasLoadedDocument()`、`ctx.frameDeclarations()` | 就绪判定与帧声明 |
| 文档 id 与形态键 | `ctx.plainForSave().plain` | 形态判别 |
| 多方块声明 | `ctx.kernelMultiblockBody().declaration` | 通道、运行态、变体、规则、骨架逐格、总 Tier 域、帧声明 |
| 契约内层 body | `ctx.kernelSourceRoot()` | 与声明做内容级同一性校验（`declarationMatchesSource` / `backboneMatchesSource`） |
| 逐帧网格 | `ctx.kernelGrid(i)` | 帧为主文档的当前帧数据 |
| 渲染定义 | `ctx.viewports.get("r-viewport").definition.value` → `{cellGrid, blockPalette}` | 逐格比对的 Web 侧输入 |
| 内容 mesh | `ctx.viewports.get("r-viewport").contentGroup.value` → mesh 数 / 顶点数 / 三角形数 / 世代 uuid | 判定装配到 mesh 重建是否完成 |
| 通道面板 | `[data-mb-panel="channels"]` 上的 `data-mb-variant` / `-dims` / `-tier` / `-runstate` 与数值文本 | 面板模型值与组合落定 |
| 帧与层控件 | `input.nei-slider__range[aria-label^="当前帧"]`、`#wm-layer-range`、`.vp-dock__tab-status` | 帧切换与分层预览语义 |
| 截图 | `page.screenshot()` / `locator.screenshot()` 经 `readPixelStats` / `readPixelSignature` | 证据链、非空判据、像素差异判据 |

`ctx.viewports.get(id).layerPreview` 是 attach 时刻的快照，不作为图层模式观测点；图层用 `ctx.getLayerWorldY()` 与 dock 的层标签。通道面板不输出 `data-mb-declared`，组合是否已声明由面板变体键与逐格 diff 共同判定。

## 4. 逐格对齐

坐标朝向：两侧同一口径 `cellGrid[z][row][x]`，`row 0` 为结构顶部，世界 Y = `height - 1 - row`；比对不做翻转或转置。

下标空间：两侧不同。参考侧下标指向并集调色板（合成 fixture 为 fixture 的并集，真实产物为 `_dataset/run-NNNN/palette.json`），渲染侧下标指向 `_gridToV2` 按本组合重编号后的调色板。比对先把两侧映射为内容签名，再逐格比较：

| 口径 | 定义 | 是否门禁 |
|---|---|---|
| `idMeta` | `name:meta`（registryId 去命名空间，`air` 归一为空串） | 是 |
| `full` | 参考侧取文件内联的 `canonicalJson(entry)` 原文，渲染侧取 `canonicalJson(渲染调色板条目)`；`air` 同样归一 | 真实产物上同为门禁，合成 fixture 上作诊断旁证 |

硬失败条件：参考网格用到、但内联签名表里没有的下标；文件 `palette.labels[i]` 与 `signatures[i]` 解析出的身份不一致。另有幻影方块护栏：渲染调色板的每个非空条目必须能从参考签名集合派生，且下标 0 必须是 air。失败信息给出坐标、两侧下标与两侧调色板条目（`describeRealGridDiff`）。

## 5. 真实导出产物

产物目录缺省为 `mod/gtnh/run/client/sde_multiblock_exports`，可被 `MB_REAL_EXPORTS_DIR` 接管。读取路径：

```text
<产物目录>/
  <slug>.multiblock.json                     # 主产物，base64(gzip(json)) 信封
  expanded/_manifest.json                     # 展开抽样清单（lightning.multiblock.expanded/1）
  expanded/<slug>.multiblock__<variant>.json  # 展开校验文件（逐格 ground truth）
  _dataset/run-NNNN/palette.json              # 全局并集调色板（展开文件的签名空间）
```

缺产物、缺清单或缺展开文件一律抛错并给出再生命令，不静默跳过；`产物目录与清单完整性` 用例把这条语义做成断言（指向不存在或空目录必须抛错）。

期望值来源与边界：组合集合、骨架尺寸、通道条数与取值域、运行态、软约束提示都从产物 JSON 的声明节派生，并以面板属性与解析结果为独立互证；断言目标是「面板与解析器忠实呈现文件声明」，不是「文件本身正确」。逐格内容的参考基线是 mod 侧独立导出的展开校验文件，不在 web 进程内重算。

**当前没有可用的再生产入口**：`npm run acceptance:multiblock`（`scripts/acceptance/run-acceptance.ps1`）的导出步骤调用 `scripts/multiblock-pipeline/run-pipeline.ps1`，该脚本不在仓内，因此该命令显式失败、不产出真实件；同一脚本的负对照步骤同理。真实产物只能来自既有归档，用 `MB_REAL_EXPORTS_DIR` 指向它。仓内的离线替代只有 `node scripts/multiblock-pipeline/verify-expanded.mjs <产物目录>`（校验既有展开文件与装配的一致性）与 `node scripts/multiblock-fixtures/validate-multiblock-fixtures.mjs <文件...>`（契约与全组合装配校验），两者都不生成真实导出件。
