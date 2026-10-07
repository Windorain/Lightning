# 场景文件格式契约（lightning.scene-file）

> **归属**：Gitea #102（收口T5，契约 1.6）。本文件是**产物格式**的权威定义，与导出代码同生共死
> （#96 §9「`docs/` 只留与代码同生共死的契约（场景文件格式、端点与错误码、观测记录）」）。
> **不是**传输层文档：Envelope 的 `payloadEncoding` 只是**包装**，包装里面才是本文定义的场景文件。
> **上游判据**：#96 §6.1（场景文件、多帧形态）、§10 C1/C2/C3。
>
> 改动本文必须与以下代码同 PR：
> `core/session/ExportSceneWriter.java`（形态与合并的**唯一**实现）、
> `client/export/SceneEnvelopeBuilder.java`（信封化与字段搬运）、
> `client/meshcapture/MeshCaptureService.java`（烘焙，`geometryPhase` 与调色板口径）、
> `client/controlplane/mc/export/ExportSceneAction.java`（cp 通道）。

---

## 1. 范围

本契约定义**一份场景文件**（一个 JSON 文档）的形态。它有且只有两种顶层形态：

| 形态 | 判别式 | 一句话 |
|---|---|---|
| **World（多帧）** | 顶层有 `frames`（数组） | 一个结构 + N 帧；**N=1 也是这一形态** |
| **Structure（裸单结构）** | 顶层无 `frames`，有 `geometryPhase` + `cellGrid` + `blockPalette` | 单帧的裸 `StructureData` |

**判别式是 `frames` 的存在性**，不是帧数。这条是硬约定：消费方（工作台/Wiki）据此选解析路径
（`web/src/render/data/bundleResolve.ts` 的 `isWorldDocument`、`web/src/context/parsers/builtinParsers.ts`）。

---

## 2. 形态口径（R1-3：口径唯一）

### 2.1 三种形态选择（`shape` 参数 / `ExportSceneWriter.Shape`）

| 取值 | 规则 | 谁用 |
|---|---|---|
| `world` | 恒 `{id,mode,frames[],playback}`；**单帧即 N=1 的多帧文档** | **cp 通道 `export.scene` 的默认** |
| `structure` | 恒裸单结构（该帧的 scan/baked 根）；**仅允许单帧** | cp 通道显式指定（需要裸 `StructureData` 的消费方） |
| `auto` | 旧隐函数：`{0}` → 裸单结构；否则 → World | **仅命令通道 `/sde export`**（逐字节保留既有行为） |

### 2.2 为什么必须显式化（搬迁前的缺陷）

搬迁前 `ExportSession.exportToFile()` 的形态判据是**帧号的隐函数**：

```java
if (frameJson.size() == 1 && frameJson.containsKey(0)) { /* 裸单结构 */ }
else { /* World 多帧 */ }
```

后果：`/sde setframe 5` 之后 `record` 一次（**N=1 但键=5**）会走 World 分支。调用方**无法从参数预知**
产物是哪种文件，于是「C1 单场景文件」与「C2 多帧」可能各自绿却是两种不同文件（假绿）。

### 2.3 两态的实质差异（不只是「形态不同」）

`MeshCaptureService.finalizeStructureJson` 的两条分支**不是同一条代码路径**：

| | World 分支 | 裸单结构分支 |
|---|---|---|
| 入口 | `root.has("frames")` | `root.has("geometryPhase") && "scan"` |
| 逐帧烘焙 | 对每帧的 `structure` 调 `finalizeSingleStructure` | 对根调 `finalizeSingleStructure` |
| **跨帧调色板提升** | **做** `liftBlockPaletteToRoot`（内容签名去重、`cellGrid` 重映射为全局下标、移除帧内 `blockPalette`） | **不做** |
| `materialPalette` | 提到根级（跨帧共享一张） | 在该帧/根上 |
| `tooltipPalette` / `cellTooltipGrid` | `integrateSdeCellNotesWorldRoot` 产根级 `tooltipPalette` + 逐帧 `cellTooltipGrid` | `integrateSdeCellNotesSingleBakedRoot` 产根级两者 |

**因此两态不可互替**：`shape:"structure"` 的产物没有跨帧调色板提升，它是「只有一帧时的裸形态」。
需要跨帧共享调色板的消费方必须用 `world`。本契约把这条写死，避免后来者以为两者只差一个 `frames` 包装。

### 2.4 默认口径（cp 通道）

**cp 通道默认 `shape:"world"`** ⇒ C1 与 C2 产出的是**同一种文件**、共用一条消费方解析路径。
这是派发裁决 5「口径唯一」的落地选择：统一到多帧文档，而不是保留两态。

---

## 3. World 形态字段表

顶层（**Plain 明文**形态；Envelope 化见 §5）：

| 字段 | 类型 | 必填 | 口径 |
|---|---|---|---|
| `id` | string | 是 | `structureId`（`/sde setstructureid` 或 `export.scene` 的快照） |
| `mode` | string | 是 | 恒 `"multiblock"`（历史命名，与多方块数据集无关） |
| `label` | string | 是 | 显示名；缺省 = `id` |
| `author` | string | 是 | 最近一次 `record` 的玩家名；从未 record 时 `"server"` |
| `gtnhVersion` | string | 是 | 最近一次 `record` 时的 GTNH 版本串；可为空串 |
| `description` | string \| null | 是 | 恒 `null`（既有行为；不写 `null` 会让消费方把「没描述」与「键不存在」混淆） |
| `tooltipPalette` | array | 是 | 逐格说明的字符串池；无说明时**空数组**（不是缺省） |
| `frames` | array | 是 | 见下 |
| `playback` | object | 是 | `{loop:false, defaultFrameIndex:0}` |
| `materialPalette` | array | 烘焙后 | 跨帧共享的材质表（由烘焙产出） |
| `blockPalette` | array | 烘焙后 | 跨帧共享的方块表（由 `liftBlockPaletteToRoot` 产出） |
| `textureBlobs` | object | 烘焙后 | 纹理 blob（`TextureBlobEmbedder`） |
| `provenance` | object | **仅 cp 通道** | 见 §6 |
| `exportId` | string | **仅 cp 通道** | 见 §6 |

`frames[]` 的每一项：

| 字段 | 类型 | 必填 | 口径 |
|---|---|---|---|
| `index` | int | 是 | 帧号（≥0）。**帧序恒按 `index` 升序**（`TreeMap` 语义），与录制顺序无关 |
| `structure` | object | 是 | 该帧的 scan/baked 结构（烘焙后就地修改） |
| `exportId` | string | **仅 cp 通道** | 与根级 `exportId` **必须一致**（C3 判据） |

### 3.1 `playback`（既定事实，非缺陷）

```json
{ "loop": false, "defaultFrameIndex": 0 }
```

- `loop` **硬编码 `false`**：这是既定事实（#96 §6.1 明写「不作为本期缺陷」）。播放功能留作以后立项。
- `defaultFrameIndex` 恒 `0`。**本期不实现、不验收播放**，只看帧数据正确可用。
- 契约 1.6 **不**新增播放相关字段（#96 §11「范围外：播放功能」）。

---

## 4. Structure 形态字段表

裸单结构 = 该帧烘焙后的 `StructureData` 根。核心字段：

| 字段 | 类型 | 口径 |
|---|---|---|
| `geometryPhase` | string | `"scan"`（中间态，未烘焙）\| `"baked"`（终态，可渲染） |
| `id` / `label` / `author` / `gtnhVersion` | string | 同 §3 |
| `cellGrid` | array | `[z][row][col]` 的整数下标网格，指向 `blockPalette` |
| `blockPalette` | array | 条目 `{registryId, meta, renderMode, geometry, occludesAdjacentFaces, nbt, tooltip}` |
| `cellTooltipGrid` | array | 逐格 tooltip 下标（-1 = 无）；**恒写出**（#81 成对 idioms） |
| `tooltipPalette` | array | 逐格说明字符串池 |
| `materialPalette` | array | 材质表 |
| `textureBlobs` | object | 纹理 blob |
| `provenance` / `exportId` | object / string | **仅 cp 通道**（§6） |

**烘焙终态的硬约束**：`cellTypes` 与 `worldGrid` 是 **scan 中间态专有**字段，烘焙后**必须消失**
（`finalizeSingleStructure` 的 `structure.remove("cellTypes")` / `remove("worldGrid")`）。
消费方（`web/src/render/data/bundleResolve.ts:44`）会拒绝带它们的「终态」。

**`geometryPhase` 与形态的关系**：`scan` 只出现在**中间态**（`/sde export` 服务端先写的那一份）；
cp 通道在**同一次动作内**完成扫描与烘焙，因此它的产物**恒为 `baked`**（§7）。

---

## 5. Envelope 包装（传输层，非本文格式）

cp 通道与命令通道的**默认**写出都是 Envelope：

```json
{
  "documentFormat": "Envelope",
  "payloadEncoding": "gzip+base64",
  "meta": { ...顶层元数据... },
  "payload": "<base64(gzip(inner JSON))>"
}
```

- `meta`：World 形态搬 `id/mode/label/author/gtnhVersion/structureId/description/modSource/playback/globalConfig/schemaVersion/documentShape/provenance/exportId`；Structure 形态搬 `geometryPhase/mode/id/label/author/gtnhVersion/structureId/description/modSource/globalConfig/source/axis/initialCamera/scanBounds/schemaVersion/provenance/exportId`。
- `inner`（`payload` 解压后）：World 形态是 `frames/materialPalette/blockPalette/textureBlobs/tooltipPalette/cellTooltipGrid/statsTemplate/partIconTextures/multiblock/multiblockCount`；Structure 形态是 `blockPalette/materialPalette/cellGrid/cellTooltipGrid/sdeCellNotes/textureBlobs/tooltipPalette/cellPartsGrid/partLists/statsTemplate/partIconTextures`。
- `copyIfPresent` 语义：**文档本来没有的键不会凭空出现** ⇒ 命令通道不写 `provenance`/`exportId`
  时，产物正文与搬迁前**逐字节一致**（有单测锁这一点）。

明文形态（`raw:true`）**不加包装**：根上多一个 `documentFormat: "Plain"`，其余就是本文 §3/§4 的文档。

### 5.1 比对口径（D2 / A3 的可复算要求）

**不得**做文件逐字节比对作为「一致性」判据：

1. gzip 头含 MTIME 字段（JDK 实现写 0，但不同实现不保证）；
2. cp 通道多了 `provenance`/`exportId`。

正确口径（`docs/control-plane/dual-channel-consistency.md` §2.2）：

```
比对值 = sha256( canonicalize( 解 Envelope → inner → 摘语义子树 ) )
```

「语义子树」对场景文件 = `frames[].structure`（World）或整个 inner（Structure）。

---

## 6. `provenance` / `exportId`（C3 机械判据）

**只由 cp 通道写**（`export.scene`）；命令通道不写 ⇒ 既有产物逐字节不变。

```jsonc
{
  "schema": "lightning.scene-export-provenance/1",
  "exportId": "<runId>#<name>",     // 本次导出的稳定标识
  "runId": "<runId>",               // 所属 cp run
  "shape": "world",                 // 产物形态
  "bufferGeneration": 12,           // 取快照时的缓冲世代号
  "inSession": true,                // 取快照时的会话开关
  "recordedFrames": [0,1,2],        // 快照里的全部已录帧号（升序）
  "frameSha256": { "0":"…", "1":"…", "2":"…" },  // 帧号 → 内容 sha256
  "selection": { …同 export.session.selection… },
  "frameIndex": 1                   // 仅逐帧明细产物（export/frames/F<n>.json）有
}
```

`frameSha256` 的哈希口径与 `export.session.frameSha256[]` **逐字一致**：
该帧**进入缓冲那一刻**的 JSON 文本的 UTF-8 字节（`Hashing.sha256HexUtf8`）——
注意哈希的是**缓冲内的 scan 中间态**，**不是**落盘后经烘焙的信封。

### 6.1 C3 判据（同会话同缓冲）

产物**合法** ⇔ 以下三条同时成立：

1. 全部 `frames[i].exportId` **彼此相等**，且等于根级 `exportId`；
2. `provenance.recordedFrames` 与 `provenance.frameSha256` 的键集合**相同**，且是 `frames[].index` 的超集；
3. `provenance.frameSha256[f]` 与导出前经 `export.session` 读到的 `frameSha256[recordedFrames.indexOf(f)]`
   **相等**（同源同序）。

**跨会话拼接判红**：`ExportSession` 是进程级单例，`frameJson` **从不因 `startSession`/`endSession` 清空**
（两个方法只翻一个 boolean）。因此「同会话」**不可由 `inSession` 判定**，只能靠：

- **动作侧**：`export.scene` 在 `onBegin` 经 `ExportSession.bufferSnapshot()` 在**同一临界区**取走
  帧体 + 帧号 + 逐帧哈希 + 世代号 ⇒ 产物内部自洽（不会出现「帧体是新的、哈希是旧的」）；
- **调用方侧**：`expectFrames` 参数（显式声明这次导出应包含哪些帧）不符即 `CP-STATE-001`，
  带 `expected`/`actual`/`extra`/`missing`。

**负对照构造**（C3 判红的验收方式）：动作 A 录 F0..F2 并导出；动作 B（**跨次动作**）再录 F9；
B 导出时声明 `expectFrames:{frames:[0,1,2]}` ⇒ 判红（`extra:[9]`）。
**不要**用 `start`/`end` 之间构造负对照——缓冲不清空，那样构造不出「跨会话」。

---

## 7. 落点与产物纪律（C4 / C5）

| 通道 | 落点 | 登记 |
|---|---|---|
| cp `export.scene` | `<runDir>/export/<name>.json` + `<runDir>/export/frames/F<n>.json` | `manifest.json`（role `scene-export` / `scene-export-frame`） |
| 命令 `/sde export` | `<CWD>/structure_exports/<name>.json`（+ 客户端 enrich 覆盖写 `<mcDataDir>/structure_exports/`） | 由 `cmd.exec` **复制进它自己 run 的 `cmd-exec/`** 并登记（role `cmd-scene-file`） |

**单一归属（裁决 6）**：cp 通道**只**落 run 目录，**不写** CWD，**不写** `structure_exports/`。
老路径只服务尚未搬迁的命令通道，其删除归 #104。

**已知影响（如实登记）**：工作台 `ExportsListPanel`（`web/src/workbench/components/ExportsListPanel.vue`）
读的是 `structure_exports/`，因此**看不到 cp 通道产物**。C1 的验收口径相应改为
「经 `GET /cp/v1/artifacts/{runId}/{path}` 下载产物 → 喂给工作台/Wiki 解析器」
（动作结果里的 `downloadPath` 就是这个 URL）。

**确定性（A3）**：产物**正文不含**时间戳、`runId`、绝对路径。`provenance` 含 `runId`/`exportId`，
因此**两次运行的 cp 产物正文不相同**——A3 的比对必须锚定 §5.1 的语义子树，或两次都关掉 provenance
（本契约不提供该开关；命令通道天然不含它）。

---

## 8. 帧预算（C6）

`export.scene` 的两档预算，都在**扫描之前**算（选区尺寸 × 帧数即可推算体积），
超限一律 `CP-VALID-002` + `context.fields`，**不写任何产物**：

| 预算 | 参数 | 默认 | 绝对上限 | 超限行为 |
|---|---|---|---|---|
| 帧数 | `maxFrames` | 64 | 256 | `CP-VALID-002`；`context.fields[field=frames]` = 「实际 N 帧 > 上限 M（不静默截断）」 |
| 体素 | `maxCells` | 2,000,000 | 48³×64 | `CP-VALID-002`；单帧与总量分别校验 |

`context` 必含可复算口径：`frames` / `maxFrames` / `volumePerFrame` / `volumeTotal` / `maxCells` / `computed`
（算式文本）。**不静默截断、不写爆**（#96 §6.1）。

**为什么必须扫描前算**：`frameJson` 存的是每帧一份完整 scan JSON 字符串，导出瞬间内存约 3 倍膨胀
（帧字符串 + 帧对象树 + 合并文档）。256 帧 × 大型选区足以打爆堆（R2-2）。

---

## 9. 复算入口

- 形态与合并的**唯一**实现：`core/session/ExportSceneWriter.java`（`buildDocument` / `serialize`）；
- 信封化与字段搬运：`client/export/SceneEnvelopeBuilder.java`；
- 烘焙：`client/meshcapture/MeshCaptureService.finalizeStructureJson`（`frames` 分支 vs 单结构分支见 §2.3）；
- 消费方判别式：`web/src/render/data/bundleResolve.ts`（`isWorldDocument`）、
  `web/src/context/parsers/builtinParsers.ts`（`StructureDataParser.detect` / `WorldParser.detect`）；
- 单测（纯 JVM，可离线复算形态与确定性）：`core/session/ExportSceneWriterTest.java`。
