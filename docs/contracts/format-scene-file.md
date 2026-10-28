# 场景文件格式契约

本文件定义场景文件正文的字段、形态与捕获语义。容器形式（Plain / Envelope）、载荷编码与 proto schema 见[运行时 JSON 与协议](../protocol.md)；多方块文档见[多方块文档格式契约](format-multiblock-doc.md)；部件与物品索引见[部件与物品索引契约](format-parts-contract.md)。

## 1. 正文形态与判别

一份场景文件是一个 JSON 对象，正文只有两种产物形态：

| 形态 | 判别式 | 内容 |
|---|---|---|
| **World** | 顶层 `frames` 是数组 | 一个结构 + N 帧；N=1 也是 World |
| **Structure** | 顶层无 `frames`，且 `geometryPhase` 为 `"scan"`/`"baked"` 或 `cellGrid` 是数组 | 单帧的裸 `StructureData` |

在两种产物形态之间，**World 的判别式是 `frames` 的存在性**，不是帧数，也不是 `id` 是否存在：单帧或缺 `id` 不改变 World 判别；缺少 `frames` 才进入 Structure。多方块与 V2Plain 文档另行判别，见下。

读取侧的形态判别统一由 `web/src/adapters/files/legacyShape.ts` 的 `classifyShape` 给出，判定顺序是判据的一部分：

| 顺序 | 判别结果 | 判据 |
|---|---|---|
| 1 | `multiblock` | 根级或信封 `meta` 的 `documentShape === "multiblock"` |
| 2 | `v2plain` | `format_version === "2.0"` 且 `frames` 是数组 |
| 3 | `world` | `frames` 是数组（不满足前两项） |
| 4 | `structure` | 无 `frames`，且 `geometryPhase` 为 `"scan"`/`"baked"` 或 `cellGrid` 是数组 |
| 5 | `unknown` | 其余 |

- 多方块形态的字段与判别细则见[多方块文档格式契约](format-multiblock-doc.md) §2。
- `format_version: "2.0"` 是编辑器 V2Plain 文档的标记；V2Plain 即使带 `frames` 也不判为 World，其字段由 V2Plain 解析器定义，不属于本文件的产物形态。
- `web/src/render/data/bundleResolve.ts` 的 `isWorldDocument` 另要求 `id` 为字符串，并排除 `format_version` 文档。该函数只服务 `render/data` 的渲染判别，不作为格式判别依据。

## 2. World 形态字段

顶层字段：

| 字段 | 类型 | 必填 | 口径 |
|---|---|---|---|
| `id` | string | 是 | 结构标识（`structureId`） |
| `mode` | string | 是 | 恒 `"multiblock"`；与文档是否含多方块声明无关 |
| `label` | string | 是 | 显示名；缺省等于 `id` |
| `author` | string | 是 | 最近一次录制的玩家名；从未录制为 `"server"` |
| `gtnhVersion` | string | 是 | GTNH 整合包版本；未知为空串 |
| `gtVersion` | string | 是 | GregTech 版本；未知为空串 |
| `description` | string \| null | 是 | 恒 `null` |
| `tooltipPalette` | array | 是 | 逐格说明字符串池；无说明时为空数组 |
| `frames` | array | 是 | 帧清单，见下 |
| `playback` | object | 是 | 见 §2.2 |
| `materialPalette` | array | 烘焙后 | 跨帧共享的材质表，条目见 §4.2 |
| `blockPalette` | array | 烘焙后 | 跨帧共享的方块表，条目见 §4.1 |
| `textureBlobs` | array | 烘焙后 | Base64 PNG 池，见 §4.3 |
| `provenance` | object | 仅导出动作写入 | 见 §6 |
| `exportId` | string | 仅导出动作写入 | 见 §6 |

部件相关根级字段（`partIconTextures`、`itemIndex`）由[部件与物品索引契约](format-parts-contract.md)定义；无部件数据时这些键不出现。

`frames[]` 的每一项：

| 字段 | 类型 | 必填 | 口径 |
|---|---|---|---|
| `index` | int | 是 | 帧号（≥0）；帧序按 `index` 升序，与录制顺序无关 |
| `structure` | object | 是 | 该帧的 scan/baked 结构，字段见 §3 |
| `exportId` | string | 仅导出动作写入 | 与根级 `exportId` 相等 |

### 2.1 两个版本字段

| 字段 | 回答 | 取值 |
|---|---|---|
| `gtnhVersion` | 产物来自哪个 GTNH 整合包版本 | 整合包声明版本；取不到时为空串，不得写入 GregTech 版本 |
| `gtVersion` | 产物来自哪个 GregTech 版本 | `gregtech` 声明版本；缺席时为空串 |

两字段在同一次探测中读出，在所有导出装配路径上成对填写。缺 `gtVersion` 表示 GT 版本未知：消费方按未知/空串处理，不得回退读取 `gtnhVersion` 或其它字段推断；缺键不构成解析失败。

### 2.2 `playback`

```json
{ "loop": false, "defaultFrameIndex": 0 }
```

`loop` 恒为 `false`，`defaultFrameIndex` 恒为 `0`；场景的多帧自动播放未实现，消费方只读取帧数据。

## 3. Structure 形态字段

裸单结构是某一帧烘焙后的 `StructureData` 根：

| 字段 | 类型 | 口径 |
|---|---|---|
| `geometryPhase` | string | `"scan"`（中间态）或 `"baked"`（终态） |
| `mode` | string | 恒 `"multiblock"` |
| `id` / `label` / `author` / `gtnhVersion` / `gtVersion` | string | 同 §2 |
| `source` | object | 扫描来源说明 `{note}` |
| `scanBounds` | object | 扫描起点 `{minX, maxY, minZ}` |
| `cellGrid` | array | `[z][row][col]` 的整数下标网格，指向 `blockPalette` |
| `blockPalette` | array | 方块表，条目见 §4.1 |
| `cellTooltipGrid` | array | 逐格说明下标（-1 = 无），与 `tooltipPalette` 成对；无说明时仍写出 |
| `tooltipPalette` | array | 逐格说明字符串池 |
| `materialPalette` | array | 材质表，条目见 §4.2 |
| `textureBlobs` | array | Base64 PNG 池，见 §4.3 |
| `captureWorld` | object | 录制时的世界身份 `{folder, dimension}`，见 §5.1 |
| `captureStats` | object | 捕获统计（烘焙后写入），见 §5.3 |
| `provenance` / `exportId` | object / string | 仅导出动作写入，见 §6 |

`cellGrid` 的下标含义固定为 `[zSlice][row][column]`，**row 0 = 顶部**；场景坐标为右手 Y-up，换算为 `x = column`、`y = rowCount - 1 - row`、`z = zSlice`。数学约定见[几何与坐标数学契约](web-kernel-geometry-contract.md)。

部件字段（`cellPartsGrid`、`partLists`、`partIconTextures`、`itemIndex` 与 `blockPalette[].hostItem`）由[部件与物品索引契约](format-parts-contract.md)定义；无部件数据时这些键不出现。

### 3.1 烘焙终态约束

`geometryPhase: "baked"` 的结构必须满足：

1. 不含 `cellTypes` 与 `worldGrid`；这两个字段只属于 `scan` 中间态。
2. `blockPalette` 与 `cellGrid` 都是数组。

校验入口是 `web/src/adapters/files/legacyShape.ts` 的 `checkBakedTerminal` 与 `checkDocumentTerminal`；后者对裸结构根与 World 的每个 `frames[].structure` 执行同一判据。缺陷码：

| 缺陷码 | 条件 |
|---|---|
| `BakedTerminalCarriesScanField` | `baked` 结构仍带 `cellTypes` 或 `worldGrid` |
| `BakedTerminalMissingPalette` | `baked` 结构缺 `blockPalette` 或 `cellGrid` |
| `GeometryPhaseUnknown` | `geometryPhase` 缺失或不是 `scan`/`baked` |

`scan` 是合法中间态，不产生缺陷；缺失或未知相位按 `GeometryPhaseUnknown` 处理，不得当作 `baked`。`terminalDefectError` 把首个缺陷映射为结构化错误，消费方据此显式拒绝。

scan 中间态专有字段：

- `cellTypes`：扫描身份表，条目含 `registryId`、`meta`，可选 `facing`、`tileNbtB64`、`tileRenderStateFormat`、`tileRenderStateB64`。
- `worldGrid`：与 `cellGrid` 同形的世界坐标网格，指向 `cellTypes`。
- `sdeCellNotes`：逐格备注对象；烘焙时并入 `tooltipPalette` / `cellTooltipGrid` 后移除。

这三个字段在 `baked` 终态中不出现。

### 3.2 条目内重复四边形

同一 `blockPalette` 条目的 `geometry.quads` 不含全字段完全相同的重复四边形。烘焙在条目几何生成处按全字段比较抑制重复并保留首个：quad 的键恰为 `materialIndex` + `vertices`，顶点的键恰为 `x/y/z/u/v/brightness/color`，字段按 JSON 原文逐字比较。键集多出字段、字段类型不符或读数异常时整份放行；不同材质、UV、亮度、颜色或顶点顺序的四边形一律保留。抑制数量只写日志，不新增产物字段。

## 4. 调色板与纹理

### 4.1 `blockPalette[]`

| 字段 | 类型 | 口径 |
|---|---|---|
| `registryId` | string | 方块注册名 |
| `meta` | int | 方块 metadata；GT 机器格为扫描值 |
| `renderMode` | string | `BakedModel`（真实捕获）或 `CapturePlaceholder`（显式占位） |
| `geometry` | object | `{encoding, quads[]}`；编码为 `bakedQuadsJsonV1` |
| `occludesAdjacentFaces` | bool | 是否遮挡相邻面；占位条目恒 `false` |
| `nbt` | object \| null | 方块实体 NBT |
| `tooltip` | array | 该方块条目的说明行 |
| `captureIssue` | object | 仅占位条目，见 §5.3 |
| `hostItem` | object | 仅含部件文档；`{registry, damage}`，由部件契约定义 |

`blockPalette[0]` 恒为空气。同一条目只存一份几何。

### 4.2 `materialPalette[]`

| 字段 | 类型 | 口径 |
|---|---|---|
| `locator` | string | 纹理定位符 |
| `kind` | string | 材质种类；动画材质为 `animated` |
| `blend` | string | `opaque` / `cutout` / `translucent`；每条材质都应声明，缺席表示产物未知，消费方回退为 `opaque` |
| `atlas` | string \| null | `blocks` / `items`；`null` 表示独立文件纹理 |
| `linear` | bool | 线性采样 |
| `useMipmaps` | bool | mipmap 开关 |
| `animation` | object | 动画材质帧信息；仅 `animated` 条目 |
| `textureBlobIndex` | int | 指向 `textureBlobs` 的下标 |

`blend` 判定：

| 条件 | 取值 |
|---|---|
| 渲染 pass > 0 | `translucent` |
| pass 0 且非不透明立方体 | `cutout` |
| pass 0 且不透明立方体 | `opaque` |

同一纹理在不同 `blend` 下是两条材质；`blend` 参与材质槽位缓存键。

### 4.3 `textureBlobs[]`

`textureBlobs` 是 Base64 PNG 字符串数组，按下标被 `materialPalette[].textureBlobIndex` 引用；相同 PNG 字节只存一份。没有材质表时写出一个占位 PNG，保持数组非空。

每个 blob 表示**该四边形对应面**的完整像素，不是定位符所指资源的原件。横向多面子图带按下列规则裁列：

1. 磁盘 PNG 与 sprite 对账；同时满足「命中含 `:面号` 的材质键」「`pngHeight == iconHeight`」「`iconWidth == iconHeight`」「`pngWidth > iconWidth` 且整除」时判为横向多面带，只保留第 `faceIndex % count` 列（`count = pngWidth / iconWidth`）。
2. `count == 2` 时列号取 `faceIndex / 6`。
3. 竖向动画条整条保留；其余情形原样返回，字节不变。
4. 裁切是逐像素搬运，不缩放、不重采样。
5. 拿不到面号时不裁切（不默认取第 0 列）。

实现入口为 `client/export/TextureStripCrop` 与 `TextureBlobEmbedder`，判据为 `TextureStripCropTest`。`blockPalette` 条目不携带 `thumbnailPNG`。

## 5. 捕获语义

### 5.1 录制世界

每帧的产物内容是该帧**录制时刻**的世界状态，与导出时刻的活动世界无关。帧 JSON 在录制时写入：

```jsonc
"captureWorld": { "folder": "存档目录名", "dimension": 0 }
```

`folder` 取不到时如实写 `null`。导出时在烘焙之前把全部选中帧的 `captureWorld` 与活动世界逐字段比较；不是同一身份、或 `folder` 不可解析，即显式失败，**不写任何产物**。逐帧明细产物的 `provenance.captureWorld` 与帧内字段同源。

### 5.2 按扫描身份烘焙

烘焙逐格以扫描身份（`cellTypes[ti]` 的 `registryId`/`meta`/`tileNbt`）决定保留哪些格、用什么身份渲染，不回查活动世界来决定身份。判定：

| 扫描身份 | 活动世界该坐标 | 结果 |
|---|---|---|
| 空气 | 任意 | `SCAN_AIR`：无内容可保留 |
| 方块 A | 空气 | `KEEP_SCAN_IDENTITY`：按扫描身份保留 |
| 方块 A | 方块 A | `KEEP_SCAN_IDENTITY` |
| 方块 A | 非空气的方块 B | `WORLD_MISMATCH`：显式失败 |
| 认不出的注册名 | 任意 | `SCAN_UNRESOLVED`：显式失败 |

`meta` 取扫描值；渲染使用活动 world 的 `RenderBlocks`/TE/贴图。副本 TE 由扫描 NBT 创建，活动 TE 只提供坐标与多部件判定，可为 `null`。

### 5.3 捕获统计与占位

存在方块但捕获不到几何的格必须显式裁决，不得静默写成空气。

`renderMode: "CapturePlaceholder"` 的条目写入占位几何（占满整格的立方体，六面取该方块各面的图集贴图），并带 `captureIssue`：

| 字段 | 口径 |
|---|---|
| `reason` | `no_observable_geometry`（几何只存在于显示列表或直接 GL 调用）或 `zero_produce`（该格无产出） |
| `source` | `tesr` 或 `block` |
| `renderer` | 该格特殊渲染器类名；该格无 TE 时不写 |

占位条目的 `occludesAdjacentFaces` 恒为 `false`，且不参与部件推断。合法为空的格（例如无 attachment 的转运器）不产生占位条目，只计入 `captureStats`。

`captureStats` 字段：

| 字段 | 口径 |
|---|---|
| `cellsWithBlock` | 扫描身份非空气的格数 |
| `bakedCells` | 真实烘出几何的格数（不含占位） |
| `placeholderCells` | 判为占位的格数 |
| `declaredEmptyCells` | 判为合法为空的格数 |
| `lostCells` | `cellsWithBlock - bakedCells - placeholderCells - declaredEmptyCells`；非 0 表示记账有漏 |
| `channels` | 逐格几何来源计数：`BLOCK`（静态批次）、`TESR`（TESR 相位）、`NONE`（无几何，含占位） |

烘焙开关 `-Dsde.capturePlaceholder=log|placeholder|off`（默认 `placeholder`）：`placeholder` 写入占位几何；`log` 只裁决与记账，不写占位几何；`off` 不产生占位（0 产出即空气）。

## 6. `provenance` 与 `exportId`

这两个字段只由导出动作写入；未写入时，产物正文不含它们。

```jsonc
{
  "schema": "lightning.scene-export-provenance/1",
  "exportId": "<runId>#<name>",
  "runId": "<runId>",
  "shape": "world",
  "bufferGeneration": 12,
  "inSession": true,
  "recordedFrames": [0, 1, 2],
  "frameSha256": { "0": "…", "1": "…", "2": "…" },
  "selection": { },
  "captureWorld": { "folder": "world", "dimension": 0 },
  "frameIndex": 1
}
```

- `frameSha256` 的值是该帧进入缓冲时 JSON 文本的 UTF-8 字节 sha256，即缓冲内的 `scan` 中间态，不是落盘后的烘焙正文。
- `frameIndex` 只出现在逐帧明细产物中。

一致性约束：

1. 全部 `frames[].exportId` 彼此相等，且等于根级 `exportId`。
2. `provenance.recordedFrames` 与 `provenance.frameSha256` 的键集相同，且是 `frames[].index` 的超集。
3. `provenance.frameSha256[f]` 等于该帧在缓冲快照中的逐帧哈希。
4. `provenance.captureWorld` 与帧内 `captureWorld` 表示同一身份。

这些字段描述一次导出所取的缓冲快照；不同导出的帧不得拼接后共用一份 `provenance`。

## 7. 复算入口

| 面 | 实现 |
|---|---|
| World 合并与序列化 | `mod/gtnh/src/main/java/com/lightning/mod/core/session/ExportSceneWriter.java` 的 `buildDocument` / `serialize` |
| 信封化 | `mod/gtnh/src/main/java/com/lightning/mod/client/export/SceneEnvelopeBuilder.java`（容器细节见[运行时 JSON 与协议](../protocol.md)） |
| 烘焙、调色板提升与捕获统计 | `mod/gtnh/src/main/java/com/lightning/mod/client/meshcapture/MeshCaptureService.java` 的 `finalizeStructureJson` / `finalizeSingleStructure` |
| 形态判别与终态校验 | `web/src/adapters/files/legacyShape.ts` 的 `classifyShape` / `checkDocumentTerminal` |
| 纯 JVM 形态与确定性 | `mod/gtnh/src/test/java/com/lightning/mod/core/session/ExportSceneWriterTest.java` |
| 发布字段与 `playback` | `web/src/adapters/files/__tests__/publishFormat.test.ts` |
| 轴序与 `cellGrid` 换算 | `web/src/adapters/files/__tests__/axisProfileConformance.test.ts` |
