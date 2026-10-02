# 修复：multiblock 导出产物的 `thumbnailPNG` 不确定性（幂等硬约束的根治）

> **任务**：multiblock 导出管线的幂等性缺陷（T1.6 自检 1 独立复跑时擒获）——产物与展开校验文件里的
> `thumbnailPNG` 是 GPU 渲染的方块缩略图，**跨运行像素不稳定**，使「逐字节幂等」与「跨运行内容签名对齐」
> 两条硬判据变成碰运气。
> **裁决（已定）**：multiblock 导出路径**不再产出 `thumbnailPNG`**（主产物调色板条目 + 展开校验文件一律不写）。
> **写范围**：`client/multiblock/`、`client/meshcapture/`（本次未改动）、`scripts/multiblock-pipeline/`、
> `scripts/multiblock-encode/`、`docs/plan/`。
> **禁止改动**：`web/`、`protocol/`、`CommandSde.java`、既有 `/sde export`（wiki）路径行为。未 `git commit`。

---

## 1. 结论摘要

| 项 | 修复前 | 修复后 |
|---|---|---|
| 主产物 `<slug>.multiblock.json` 内层 `blockPalette[].thumbnailPNG` | 有（QFT 14 条条目里 13 条，28,067 B） | **0 条**（构造处已切断，见 §4） |
| 展开校验文件 `expanded/*.json` 的 `palette.signatures` | 含整段缩略图 base64（258 处，占文件 22.1%） | **0 处** |
| 跨运行逐字节一致 | **碰运气**（同输入两次运行，9/14 条条目缩略图不同） | **5 次运行 5/5 产物 + 35/35 展开文件逐字节一致**（§7.1） |
| 主产物总体积（5 台） | 444,336 B | **319,164 B（−28.2%）** |
| 展开校验文件总体积 | 1,774,932 字符 | **1,376,796 字符（−22.4%）** |
| 数据集 `palette.json` 体积 | 631,885 字符（缩略图占 17.2%） | **521,901 字符（−17.4%）** |
| 捕获阶段耗时 | 115.1 s（4 份修复前归档区间 115.1–139.4 s） | 123.0 s（修复后 5 次区间 123.0–152.0 s）：**无实测收益，落在运行间噪声内** |
| `/sde export`（wiki）产物的缩略图 | 有（2,467 B） | **一字不动**：修复前 2 次 + 修复后 1 次共 3 次运行产物 SHA-256 完全相同（§5） |

---

## 2. 根因（证据确凿）

1. **实证**：`scripts/multiblock-pipeline/.out/t16-idem-1` vs `t16-idem-2`（同一输入、同配置的两次无人值守运行）
   的 QFT 主产物内层 JSON，**剥离 `thumbnailPNG` 后逐字节一致**；未剥离时 9/14 条条目的缩略图不同。
   展开校验文件同样**只**在 `thumbnailPNG` 上不同（3/7 签名条目），`cellGrid`/`dims` 完全一致。
2. **机理**：`thumbnailPNG` 由 `BlockThumbnailRenderer.renderToBase64PNG(block, meta)`（`client/export/`）
   在游戏渲染管线里把一个方块渲染成图标再编码 PNG —— 像素结果依赖 GL 状态、图集状态与浮点路径，
   **不是确定性函数**，因此同一输入的两次运行可以给出不同字节。
3. **破坏面**（三条，全部是硬判据）：
   * **产物逐字节幂等**（计划 §6「导出产物字节一致」、T1.6 自检 1）：T1.6 当时的通过是**碰运气**；
   * **跨运行内容签名对齐**（T3.3）：展开校验文件的 `palette.signatures` = `canonicalJson(条目全文)`，
     缩略图在里面 → 跨运行的签名天然随机破裂；
   * **体积**：T0.1 §8 F3 已量化 `thumbnailPNG` 是「元数据里的隐藏纹理」（真实产物 67 条 / 62,750 B，
     平均 936 B/条，未压缩占 4.7%；键名另计 1,005 B），多方块全量导出会把它乘以方块状态数。

---

## 3. 裁决与理由

**multiblock 导出路径不再产出 `thumbnailPNG`**：

1. **幂等是计划硬约束**（§6「导出产物字节一致」），而 GPU 渲染像素**本质不确定**——两者不可兼得，
   幂等优先；
2. **web 3D 渲染不用 per-block 缩略图**：纹理由 `textureBlobs` 承载，缩略图只服务 UI 预览，
   而多方块文档本轮**没有消费者**（`web/e2e/helpers/multiblock/referenceGrids.ts` 只用
   `cellGrid` + 条目内容签名，不读缩略图）；
3. **附带体积收益**（T0.1 F3）：见 §8；
4. **与 T1.3 排除 NBT/tooltip 同口径**（`probe-variant-capture.md` §13 开放项 1：让同一几何分裂成多条
   的东西不进产物）——缩略图属于同一类「与几何内容无关、且不稳定」的字段。

**若将来需要缩略图**：必须改用**确定性软件光栅**（纯 CPU、固定材质/光照/视角，字节可复现）另行立项，
且**不得**再进主产物条目（应走独立 blob 池或独立导出文件）——已登记为开放项（§10 第 1 条）。

---

## 4. 修复点清单（文件:行为）

| # | 文件 | 行为 |
|---|---|---|
| 1 | `client/multiblock/GeometryPalette.java` | **唯一写入点切断**：`intern(...)` 删除缩略图分支与 `Block` 形参（不再触碰任何 GPU 状态），条目形状恒为 `{registryId, meta, renderMode, geometry, occludesAdjacentFaces, nbt, tooltip}`；新增机器可读常量 `EMITS_THUMBNAIL_PNG = false`，并写进 `statsJson()`（`thumbnailPNG` + `thumbnailPNGPolicy`），使「产物无缩略图」可被判据核对 |
| 2 | `client/multiblock/VariantGeometryBakery.java` | `captureOne` 调用点同步（不再传 `Block`） |
| 3 | `config/SdeMultiblockConfig.java` | 删除 `includeThumbnails` 配置项与其 cfg 读取；类注释记录「已移除 + 旧键静默忽略」 |
| 4 | `client/multiblock/VariantCaptureRunner.java` | 删除 `Config.includeThumbnails`、触发文件解析分支；`new GeometryPalette()` 无参构造；`configJson` 仍保留 `includeThumbnails` 键但恒为 `false`（下游读者不炸）；数据集 `notes` 增加一条自述 |
| 5 | `client/multiblock/MultiblockExportRunner.java` | `cap.includeThumbnails` 赋值删除；导出报告的配置回显写 `includeThumbnails=false` + `thumbnailPNGPolicy` |
| 6 | `client/multiblock/VariantCaptureAutomation.java` | 触发文件示例注释同步（不再有 `includeThumbnails`） |
| 7 | `client/meshcapture/` | **零改动**（`MeshCaptureService` L601 的缩略图分支是 `/sde export` 的，必须原样保留；见 §5） |

**展开校验文件侧（第 1 项的必然结果，无需额外代码）**：
`MultiblockExpandedVerifier.buildSampleDoc` 的 `palette.signatures` = `canonicalJson(palette.json 里的条目)`，
`palette.labels` = `registryId`/`meta` 人读标签（**从来没有**缩略图参与）。条目不再带缩略图 ⇒
签名自动变干净、跨运行稳定。实测：修复后展开文件的 `thumbnailPNG` 出现次数 = **0**（§7.3）。

**校验工具侧：`scripts/multiblock-pipeline/` 与 `scripts/multiblock-encode/` 的代码一行未改**（`git status` 实证：
两目录下只有 `.out/` 归档变化，源码零改动）。理由：这两个工具**没有任何** `thumbnailPNG` 专用逻辑，
它们的内容签名 = `lib.mjs#entrySignature` = 条目全文 `canonicalJson`；**对缩略图敏感是「全文签名」的固有性质**，
而根因已在**源头**（条目构造处）切断，所以工具不需要"同步口径"。这一判断用**负对照**实证（§7.4 末行）：
把数据集里的缩略图单独删掉，校验器立刻报 1672/1672 变体不一致 —— 证明它确实敏感、且证明
「同年代成对使用」是唯一正确口径（混用需另行立项，§10-4）。

> **口径说明**：本次**没有**改 `canonicalJson`/`entrySignature` 的定义（仍与
> `lib.mjs#canonicalJson`、`web/.../referenceGrids.canonicalJson` 逐字符同口径），改的是**条目本身**。
> 这样避免在四方（mod / lib.mjs / pipeline 校验器 / web e2e）之间制造第二套签名口径。

---

## 5. 范围红线：`/sde export`（wiki）不受影响

### 5.1 代码路径隔离（结构性证据）

| 证据 | 结果 |
|---|---|
| 全 mod 内 `BlockThumbnailRenderer.renderToBase64PNG` 调用点 | 修复前 2 处：`MeshCaptureService:601`（`/sde export` 路径）+ `GeometryPalette:133`（multiblock 路径）；**修复后仅剩 `MeshCaptureService:601` 一处**，即 wiki 路径原样 |
| `MeshCaptureService.java` / `MeshCaptureClient.java` / `BlockThumbnailRenderer.java` / `SceneEnvelopeBuilder.java` / `CommandSde.java` / `ExportSession.java` / `PacketEnrichExportedSceneHandler.java` | `git diff --name-only` 里**全部不出现**（未改动一个字节） |
| `GeometryPalette` 被 multiblock 包以外引用 | **无**（`grep` 全 mod 源码，仅 `client/multiblock/` 内 4 个文件引用） |
| 本次改动的 Java 文件全集 | `client/multiblock/` 5 个 + `config/SdeMultiblockConfig.java`（+ 另一会话既有的 `client/automation/SdeClientAutomationTickHandler.java`，非本次修复内容） |

### 5.2 实测（字节级）：修复前 2 次 + 修复后 1 次，`/sde export` 产物完全相同

复现方式（零人工交互）：`run/client/config/lightning.cfg` 开 `autoLoadFirstSingleplayerWorld=true` +
指令文件 `sde_export_smoke.txt`（`/sde start` → `setname/setstructureid` → `tp 964 3 -933`（把脚下方块
落在地面方块上，选区位确定且非空气）→ `sde pos1/pos2` → `record` → `export` → 5×`sde status` 留出
客户端 enrichment 的 tick），然后 `gradlew runClientSdePipeline`。

| 运行 | 二进制 | 产物文件 SHA-256 | 内层 payload SHA-256 | 文件字节 | `blockPalette` 条目 | 条目含 `thumbnailPNG` | 缩略图 base64 字节 |
|---|---|---|---|---|---|---|---|
| ① 修复前 | 见 §5.3 | `85cabb40fbce7b57…` | `ccab55777e470b9d…` | 5,578 | 2（air@0, grass@0） | 1（grass） | 2,467 |
| ② 修复前 | 同上 | `85cabb40fbce7b57…` | `ccab55777e470b9d…` | 5,578 | 同上 | 同上 | 2,467 |
| ③ 修复后 | 本修复 | `85cabb40fbce7b57…` | `ccab55777e470b9d…` | 5,578 | 同上 | 同上 | 2,467 |

**结论**：三次运行的产物**逐字节相同**（含 `thumbnailPNG` 的 2,467 字节 base64），
即「修复前 2 次」证明 `_sde export_` 本身在该固定选区下是可复现的，第三次（修复后）与它们完全相同
⇒ **本次修复对 `/sde export` 零影响**。条目形状与字段顺序也与既有产物一致
（`registryId,meta,thumbnailPNG,renderMode,geometry,occludesAdjacentFaces,tooltip`）。

### 5.3 证据文件（`scripts/multiblock-pipeline/.out/fix-thumb/`，`.gitignore` 已覆盖）

| 文件 | 说明 |
|---|---|
| `sde_export_smoke.prefix-1.json` / `sde_export_smoke.prefix-2.json` | 修复前两次 `/sde export` 产物（含缩略图） |
| `sde_export_smoke.postfix.json` | 修复后同选区 `/sde export` 产物 |
| `sde-export-prefix-1.log` / `sde-export-prefix-2.log` / `sde-export-postfix.log` | 三次运行的完整客户端日志（含 `compileJava` 与 `Teleported Developer to 964.5,3.5,-932.5`） |
| `sde-export-before.log` / `sde_export_smoke.before.json` | **探索性**首轮（选区落在空气：只有 air 条目、747 B、无缩略图），保留以说明"选区必须非空气"这条前置 |
| `sde-export-tpprobe.log` / `sde_export_smoke.tpprobe.json` | **探索性**第二轮（`commandDelayTicks=0` 导致客户端 enrichment 来不及跑、产物退回服务端 scan 形态 646 B），保留以说明 §5.2 里"5×`sde status` 留 tick"的由来 |
| `decode-export.mjs` / `strip-thumb.mjs` / `table.mjs` | 抓取/汇总工具：解信封报告缩略图字节数与 SHA-256；删缩略图做负对照；把 N 次 `pipeline-result.json` 汇成幂等矩阵 |
| `idempotency-table.md` | 5 次运行的产物/展开文件 SHA-256 全量矩阵（§7.1 的机器生成版） |
| `validation-report.new.txt` / `verify-expanded.new.txt` | T0.5 契约校验器与展开逐格 diff 的原始输出 |
| `gradle-build.log` / `gradle-spotless.log` | `gradlew build`（含一次 spotless 失败）与 `spotlessApply` 的原始日志 |
| `legacy/` / `new-encoded/` / `negative-control/` | T1.4 校验的输入副本与负对照（不污染既有归档） |
| `thumbnail-fix.patch` | 本次源码改动的完整 patch（供复核） |
| `before/t16-idem-1`、`before/t16-idem-2` | 修复前（含缩略图）的完整 T1.6 归档副本，用于体积/耗时对照 |
| `fixed-src/` | 修复后 6 个 Java 文件的备份（用于「回退到修复前跑基线」时快速还原） |

> 注：`/sde export` 的选区依赖「玩家脚下方块」，而本环境的无头客户端不接受服务端 `tp` 的
> **旋转**（`/tp x y z yaw pitch` 不生效，`hpos1/hpos2` 因此恒为「未指向方块」），
> 但 `/tp x y z` 自身有效 —— 用「把脚落进地面方块」的方式构造确定性非空气选区，见上表。

---

## 6. 内容签名口径核查（要求 2）

`canonicalJson` 对齐用的签名共四处，逐一核查是否含**其他**易变字段：

| 签名 | 计算式 | 参与的字段 | 是否含易变字段 |
|---|---|---|---|
| 去重键（`GeometryPalette.intern`） | `CaptureToolkit.signatureOfState(registryId, meta, null, geometry, null)` → `fullEqualitySignature` | `registryId` + `meta` + 几何签名（4 位小数量化 → 四边形内顶点排序 → 四边形间排序 → SHA-256/Base64）；`tileNbt`/`tooltip` 传 `null` **不参与** | 否（几何由确定性烘焙产生；材质下标来自跨变体共享的 `MaterialTable`，顺序由变体顺序决定，跨运行稳定——5 次运行哈希一致已证） |
| 数据集聚合哈希（`paletteContentSha256`） | `index + "|" + entry.signature` 逐条连接后 SHA-256 | 同上 | 否 |
| 展开校验文件 `palette.signatures` | `MultiblockExpandedVerifier.canonical(条目全文)`（对象键排序、数组保序，与 `lib.mjs#canonicalJson` 逐字符对齐） | **修复前含 `thumbnailPNG`** → 已被本修复从条目里去掉；其余字段 `registryId/meta/renderMode(常量)/geometry/occludesAdjacentFaces/nbt(恒 null)/tooltip(恒 [])` | 修复后否（修复前：**是**，这就是根因） |
| `palette.labels` | `name@meta`（去 namespaced 前缀） | `registryId` + `meta` | 否 |

**`tooltip` 特别核查**：multiblock 路径的条目 `tooltip` 恒为 `[]`、`nbt` 恒为 `null`
（`GeometryPalette.intern` 硬写），且**不参与**去重签名 —— 与本修复无关，不存在第二处易变字段。
（T1.5/T1.6 若将来补 `tooltipPalette`，按 `probe-variant-capture.md` §13 开放项 1 的要求**必须同步改去重口径**，
那是独立的立项。）

**跨年代（含缩略图 vs 不含缩略图）产物的口径**：`entrySignature` 仍是「条目全文 canonical」，因此
**修复前产物只能与修复前的数据集对齐**（T1.4 的三组既有产物+数据集是同年份对，见 §7.4，全部全绿）；
跨年代混用（旧产物 + 新数据集）不在支持范围内 —— 管线每轮**同时重建数据集与产物**，所以生产路径
不会出现混用；T3.3 的 web 装配也总是拿**同一次运行**的产物与展开文件。

---

## 7. 验证

### 7.1 幂等：5 次无人值守运行，主产物 + 展开校验文件逐字节一致

5 次运行 = `npm run multiblock:selfcheck` 的两次（`t16-idem-1/2`）+ 追加两轮（`t16fix-i3/i4`）+
`spotlessApply`（纯换行）后的终验一轮（`t16fix-i5`），全部同一世界、同一范围（默认验收子集 5 台）、
同一配置、**每轮先复位产物目录**（`run-pipeline.ps1` 的既有行为，见 `probe-export-pipeline.md` §6.4）。

| 运行标签 | status / exitCode | 变体 | 产物 | 产物总字节 | 展开文件 | 总耗时 s | 导出 s | 捕获 s |
|---|---|---|---|---|---|---|---|---|
| `t16-idem-1` | ok / 0 | 1262 | 5 | 319,164 | 35 | 132.7 | 124.2 | 123.0 |
| `t16-idem-2` | ok / 0 | 1262 | 5 | 319,164 | 35 | 146.3 | 139.1 | 137.9 |
| `t16fix-i3` | ok / 0 | 1262 | 5 | 319,164 | 35 | 148.5 | 140.8 | 139.6 |
| `t16fix-i4` | ok / 0 | 1262 | 5 | 319,164 | 35 | 131.8 | 124.5 | 123.3 |
| `t16fix-i5`（换行修复后终验） | ok / 0 | 1262 | 5 | 319,164 | 35 | 160.3 | 153.2 | 152.0 |

**主产物 SHA-256 矩阵**（跨 5 次运行相同）：

| 文件 | 字节 | SHA-256（前 16） | 一致 |
|---|---|---|---|
| `mteadvebf.multiblock.json` | 65,711 | `da919747b01f43e4` | ✅ |
| `mtebrickedblastfurnace.multiblock.json` | 58,169 | `259c05803d6bd2be` | ✅ |
| `mtedistillationtower.multiblock.json` | 63,312 | `22952d7eaf49deed` | ✅ |
| `mteelectricblastfurnace.multiblock.json` | 65,603 | `9a952df894faedd0` | ✅ |
| `mtequantumforcetransformer.multiblock.json` | 66,369 | `45625bb2894ab078` | ✅ |

**展开校验文件**：35 份 `expanded/*.json` 跨 5 次运行**逐一 SHA-256 相同**（全量矩阵见
`.out/fix-thumb/idempotency-table.md`）。

**`compare-runs.mjs` 退出码**：`idem-1 vs idem-2` = 0、`i3 vs i4` = 0、`idem-1 vs i3` = 0、
`idem-2 vs i4` = 0、`idem-1 vs i5` = 0、`idem-2 vs i5` = 0、`i4 vs i5` = 0（自检 1 是同一判定脚本，
见 §7.2）。**跨不同轮次、跨「换行修复前/后」的两两比对同样为 0** —— 这才排除了「幂等是碰运气」：
修复前同一脚本曾在独立复跑时抓到 9/14 条条目缩略图不同。

> 结果文件里的 `failureCount = 2` 是**修复前就存在**的已知项（T1.2 枚举 slug 碰撞被算作 T1.5 失败，
> `probe-export-pipeline.md` §7 开放项 2），与本修复无关：`status = ok`、`exitCode = 0`、产物齐全。

### 7.2 `npm run multiblock:selfcheck`（要求 a）

`selfcheck-report.json.allPassed = true`，6 项全 PASS：

| 检查 | 结果 |
|---|---|
| 自检1-run1 / run2 | 退出码 0 / 0 |
| **自检1-字节一致**（`compare-runs.mjs`） | 退出码 0：**产物 5/5 逐字节一致；展开校验文件 35/35 逐字节一致** |
| 自检2-退出码（故意失败） | 退出码 2，原因落盘 `MTENoSuchMachineT16 / UnknownMachine` |
| 自检3-逐格diff（`verify-expanded.mjs`） | 退出码 0：5 台 / 35 组合 / **43,749 格 diff = 0**（`full` 与 `idMeta` 两个口径都 0） |
| 自检4-耗时记录 | 记录了 2 次运行耗时 |

### 7.3 展开校验文件与调色板里 `thumbnailPNG` 出现次数 = 0（要求 1）

| 载体 | 修复前 | 修复后 |
|---|---|---|
| 主产物内层 JSON（QFT，14 条条目） | `thumbnailPNG` 13 条 / 28,067 B | **0 条 / 0 B** |
| `expanded/*.json`（36 文件） | 258 处 | **0 处** |
| `_dataset/run-0001/palette.json` | 56 条带缩略图（108,684 字符） | 仅 `stats` 里的常量与政策文案（`"thumbnailPNG": false` + `thumbnailPNGPolicy`，含 `"thumbnailPNG":"iVBOR` 的数据 = **0**） |

`palette.json` 自带机器可读自述，便于后续用判据核对而不是靠读代码：

```json
"thumbnailPNG": false,
"thumbnailPNGPolicy": "条目不含 thumbnailPNG：GPU 渲染的缩略图跨运行像素不稳定，会同时破坏产物逐字节幂等与跨运行内容签名对齐（docs/plan/fix-thumbnail-determinism.md）"
```

数据集 `report.json` 的 `notes` 也追加了一条同义自述，`config.includeThumbnails` 恒为 `false`。

### 7.4 T1.4 离线闭环 `verify-encoded.mjs`（要求 c）

| 情形 | 产物目录 | 数据集目录 | 结果 |
|---|---|---|---|
| 既有（T1.4 时代，**含缩略图**，同年份对） | `.out/lsc-real-encoded` | `.out/lsc-real` | 退出码 0：1672/1672 变体，diff 0 |
| 既有（同上） | `.out/lsc-real-wide-encoded` | `.out/lsc-real-wide` | 退出码 0：1152/1152，diff 0 |
| 既有（同上） | `.out/synth-overlap-encoded` | `.out/synth-overlap` | 退出码 0：576/576，diff 0 |
| **修复后新产物**（`factorize.ps1` 离线编码 `t16fix-i4` 的数据集） | `.out/fix-thumb/new-encoded` | `.out/t16fix-i4/exports/_dataset/run-0001` | 退出码 0：**1262/1262 变体，diff 0**（5 份文档） |
| **负对照**（隔离「缩略图」这一个变量） | `.out/lsc-real-encoded`（同上年份产物） | `.out/lsc-real` 的副本，**仅删掉 `thumbnailPNG` 成员**（68 → 0，JSON 仍合法、条目数 69 不变） | **退出码 1**：1672/1672 变体报「ground-truth 含产物调色板里不存在的方块状态（剪枝丢条目）」 |

**口径结论**：`verify-encoded.mjs` 的对齐判据是 `lib.mjs#entrySignature` = **条目全文 `canonicalJson`**，
因此它**对 `thumbnailPNG` 敏感**（负对照实测）。但这不影响本次回归：
* 既有产物与既有数据集是**同年份对**（两边都含缩略图），照旧全绿 → 无回归；
* 修复后产物与修复后数据集也是同年份对（两边都不含缩略图）→ 全绿；
* **跨年代混用不在支持范围**：管线每轮同时重建数据集与产物，生产路径不会混用（T3.3 的 web 装配同理，
  总是拿同一次运行的产物与展开文件）。本任务**刻意不改** `entrySignature` 的定义（否则要在
  mod / `lib.mjs` / 两个 pipeline 校验器 / web `referenceGrids` 之间引入第二套签名口径）——登记为开放项 §10-4。

### 7.5 `gradlew build`（要求 d）

| 步骤 | 结果 |
|---|---|
| 首次 `gradlew build` | **FAILED**：`spotlessJavaCheck` 报 2 个文件格式违规（`GeometryPalette.java`、`MultiblockExportRunner.java`，均本次新增代码） |
| `gradlew spotlessApply` | 只改了这 2 个文件，且**只把字符串拼接/方法参数的换行合并**（`Compare-Object` 实证：2 处，语义与字符串值完全不变） |
| 再次 `gradlew build` | **BUILD SUCCESSFUL（退出码 0）** |
| 收尾复验 | 换行修复后追加第 5 轮无人值守导出（`t16fix-i5`）并与前 4 轮哈希比对 → 产物/展开文件仍逐字节一致（§7.1） |

### 7.6 T0.5 契约校验器（要求 e）

`node scripts/multiblock-fixtures/validate-multiblock-fixtures.mjs <t16fix-i4/exports>/*.multiblock.json`
（5 份修复后产物）：**退出码 0，失败 0 / 警告 2** —— 与 `probe-export-pipeline.md` §8.2 记录的
修复前基线（失败 0 / 警告 2）完全一致。逐份报告的判据（`palette/dedup`、`palette/no-unused`、
`palette/encoding`、`variants/complete`、`assembly/all-variants`、`rules/*` …）全绿。
原始输出：`.out/fix-thumb/validation-report.new.txt`。

---

## 8. 体积 / 耗时收益（实测）

对照口径：同一世界、同一范围（默认验收子集 5 台 / 1262 变体）、同一配置；「修复前」= 归档副本
`.out/fix-thumb/before/t16-idem-1`（含缩略图的 T1.6 产物），「修复后」= `.out/t16-idem-1`。

### 8.1 体积（主产物）

| 产物 | 修复前 | 修复后 | 变化 |
|---|---:|---:|---:|
| `mteadvebf.multiblock.json` | 109,455 B | 65,711 B | −43,744 B（**−40.0%**） |
| `mtebrickedblastfurnace.multiblock.json` | 63,057 B | 58,169 B | −4,888 B（−7.8%） |
| `mtedistillationtower.multiblock.json` | 70,740 B | 63,312 B | −7,428 B（−10.5%） |
| `mteelectricblastfurnace.multiblock.json` | 109,231 B | 65,603 B | −43,628 B（**−39.9%**） |
| `mtequantumforcetransformer.multiblock.json` | 91,853 B | 66,369 B | −25,484 B（**−27.7%**） |
| **合计（5 份 gzip+base64 信封）** | **444,336 B** | **319,164 B** | **−125,172 B（−28.2%）** |

**为什么压缩后省得比缩略图原始占比多**：缩略图本身已是 PNG（gzip 视作不可压），
而同一份 JSON 的其余部分能压到 ~1/6。QFT 为例：内层 JSON 375,509 → 347,429 B
（差额 28,080 B ≈ 缩略图 28,067 B，1:1），而信封 91,853 → 66,369 B（省 25,484 B ≈ 1:1），
即**移除的每一字节缩略图几乎等量地省下最终产物体积**——这正是 T0.1 §8 F3 说的「元数据里的隐藏纹理」。

### 8.2 体积（数据集与展开校验文件）

| 载体 | 修复前 | 修复后 | 变化 |
|---|---:|---:|---:|
| `_dataset/run-0001/palette.json`（并集调色板，pretty-print） | 631,885 字符（缩略图 108,684 = 17.2%） | 521,901 字符 | −109,984（−17.4%） |
| `expanded/*.json`（35 份 + `_manifest.json`） | 1,774,932 字符（缩略图 392,460 = 22.1%） | 1,376,796 字符 | **−398,136（−22.4%）** |
| 其中 QFT 主产物内层 JSON | 375,509 B | 347,429 B | −28,080 B |

展开校验文件掉得最多：每份文件都要内联「本网格用到的下标 → 条目全文签名」，而签名里嵌着整张缩略图，
于是同一张缩略图在 **35 份文件里各存一遍**（258 处）——这也是修复前 T3.3 对齐判据最脆的地方。

### 8.3 耗时（诚实结论：无实测收益）

| 指标 | 修复前 | 修复后 | 结论 |
|---|---|---|---|
| 捕获阶段 `totals.elapsedMs` | 115.1 / 124.5 s（另两份归档 115.1 / 139.4 s） | 123.0 / 137.9 / 139.6 / 123.3 / 152.0 s | 区间重叠，**差异落在运行间噪声内** |
| 管线总耗时 | 132.7 s（`t16-idem-1`） | 131.8–160.3 s | 同上 |

**为什么没有速度收益**：本子集一次运行只渲染 **56** 次方块缩略图（= 调色板条目数，去重后），
相对 1262 个变体的构建/捕获（百秒量级）完全不成比例；预期节省 < 1 s，被 ±10% 的运行间抖动淹没。
**本修复的收益是判据正确性（幂等不再是碰运气）与体积，不是速度**——不夸大。

---

## 9. 修复前基线实测（`before/t16-idem-1`，含缩略图）

| 项 | 值 |
|---|---|
| 数据集 `_dataset/run-0001/palette.json` | 631,885 字符；57 条条目；其中 **56 条**带 `thumbnailPNG`；缩略图 base64 合计 **108,684 字符（17.2%）** |
| 展开校验文件（36 个 `.json`，含 `_manifest.json`） | 1,774,932 字符；`thumbnailPNG` 出现 **258 次**；内嵌缩略图 base64 合计 **392,460 字符（22.1%）** |
| 主产物（5 份 gzip+base64 信封） | 444,336 B（另一次运行 444,656 B，差异即缩略图像素差：**只有 320 B**，因为 PNG 已被 gzip 视作不可压） |

---

## 10. 开放项

| # | 项 | 影响 | 建议处置 |
|---|---|---|---|
| 1 | **缩略图能力在多路径被撤下（本路径）** | 多方块文档若有 UI 预览需求，需要缩略图 | 另行立项：**确定性软件光栅**（CPU、固定材质/光照/视角，字节可复现），且走独立 blob 池/独立文件，不进主产物条目 |
| 2 | **`thumbnailPNG` 在 `/sde export` 路径仍是不确定字节**（本次实测该固定选区下 3 次一致，但机理未变） | wiki 路径若将来也要"产物字节一致"判据，会撞同一面墙 | wiki 路径的需求是「可读预览」，不是逐字节幂等；若要收敛，复用开放项 1 的软件光栅 |
| 3 | **`docs/plan/format-multiblock-doc.md` §6.3 的 `thumbnailPNG` 政策（「按既有字段原样进条目、参与签名去重」）与本修复冲突** | 契约文档与实现不一致（该 doc 不在本任务写范围内，未改） | 由契约 owner 按本修复改写该节：多方块路径**不写**缩略图；或补一份「软件光栅缩略图」的独立规范 |
| 4 | **展开校验文件的 `palette.signatures` 是「条目全文 canonical」，跨年代（含/不含缩略图）不可对齐** | 旧归档产物与新归档展开文件混用会假红 | 若将来需要跨年代对照：把签名口径改成「排除渲染性字段」（需 mod + `lib.mjs` + 两处 pipeline 校验器 + web `referenceGrids` 同步改，即本任务刻意避免的第二套口径），或直接按年代分批对照 |
| 5 | **本修复只根治了「产物字节一致」三条障碍里的一条** | 另一条（T1.5 产物 `multiblock.notes` 里的自增 `run-NNNN` 引用）仍靠外层脚本「每轮复位产物目录」绕过 | 见 `probe-export-pipeline.md` §7 开放项 1；根治属 T1.5/T1.3 |

---

## 11. 复现命令

```bash
# ① 修复后：无人值守运行 + 两两哈希比对（selfcheck 含 2 次 + 失败演示；再补 3 次）
npm run multiblock:selfcheck
pwsh -File scripts/multiblock-pipeline/run-pipeline.ps1 -Label t16fix-i3
pwsh -File scripts/multiblock-pipeline/run-pipeline.ps1 -Label t16fix-i4
pwsh -File scripts/multiblock-pipeline/run-pipeline.ps1 -Label t16fix-i5   # spotlessApply 后的终验
node scripts/multiblock-pipeline/compare-runs.mjs .out/t16-idem-1/pipeline-result.json .out/t16fix-i3/pipeline-result.json
node scripts/multiblock-pipeline/compare-runs.mjs .out/t16-idem-2/pipeline-result.json .out/t16fix-i4/pipeline-result.json
node scripts/multiblock-pipeline/compare-runs.mjs .out/t16fix-i3/pipeline-result.json .out/t16fix-i4/pipeline-result.json
node scripts/multiblock-pipeline/compare-runs.mjs .out/t16fix-i4/pipeline-result.json .out/t16fix-i5/pipeline-result.json

# ①' 机器生成的 5 轮 SHA-256 全量矩阵
node scripts/multiblock-pipeline/.out/fix-thumb/table.mjs `
  .out/t16-idem-1/pipeline-result.json .out/t16-idem-2/pipeline-result.json `
  .out/t16fix-i3/pipeline-result.json .out/t16fix-i4/pipeline-result.json .out/t16fix-i5/pipeline-result.json

# ② 展开 vs 装配逐格 diff
node scripts/multiblock-pipeline/verify-expanded.mjs scripts/multiblock-pipeline/.out/t16fix-i4/exports

# ③ T1.4 离线闭环：既有产物（同年份对）+ 修复后新产物
node scripts/multiblock-encode/verify-encoded.mjs <legacyEncodedDir> <legacyDatasetDir>
pwsh -File scripts/multiblock-encode/factorize.ps1 -Dataset <新 exports>/_dataset/run-0001 -OutDir <newEncodedDir>
node scripts/multiblock-encode/verify-encoded.mjs <newEncodedDir> <新 exports>/_dataset/run-0001

# ④ 契约校验器（T0.5）对新产品
node scripts/multiblock-fixtures/validate-multiblock-fixtures.mjs <新 exports>/*.multiblock.json

# ⑤ /sde export 回归（3 次运行产物 SHA-256 相同；见 §5.2）
#    run/client/config/lightning.cfg: autoLoadFirstSingleplayerWorld=true
#    run/client/sde_export_smoke.txt: sde start / setname / setstructureid / tp 964 3 -933 /
#                                     sde pos1 / sde pos2 / sde record / sde export / sde status ×5
gradlew runClientSdePipeline        # 在 mod/gtnh/
node scripts/multiblock-pipeline/.out/fix-thumb/decode-export.mjs run/client/structure_exports/sde_export_smoke.json
```
