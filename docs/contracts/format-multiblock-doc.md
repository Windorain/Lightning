# 多方块文档格式契约

本文件定义「一份文件 = 一台多方块」的正文格式：尺寸型通道决定的骨架、按引用复用的差异规则表、全部变体的声明清单，以及把这些声明绑定起来的场景清单。容器形式、载荷编码与 proto schema 见[运行时 JSON 与协议](../protocol.md)；场景字段与调色板条目的公共定义见[场景文件格式契约](format-scene-file.md)。

## 1. 术语与轴

| 轴 | 承载 | 作用 |
|---|---|---|
| 尺寸型通道 | `multiblock.backbone.sizeSteps` | 选择骨架阶，决定结构有几层/几片 |
| 替换型通道 | `multiblock.rules` | 决定某位置的方块身份；取值域含「未设置」 |
| 运行态 | `multiblock.runstates` + 运行态相位规则 | 只描述纹理/材质层差异 |

总 Tier 是「总通道」，与具名通道同构，但没有 `id`/`enum`。

**变体**是一次通道取值、总 Tier 与运行态的组合。**场景**是变体的存储原语：一个变体至少一个场景，通常恰好一个。场景是变体配置集合，不是时间轴，不参与播放。

文件格式的键名是 `frames`。适配器在边界上把它翻译为领域场景清单（`adapters/files/multiblockDeclaration#sceneOf`），格式兼容与领域语义分离。

## 2. 形态判别

| 字段 | 位置 | 取值 | 含义 |
|---|---|---|---|
| `documentShape` | 信封 `meta`，或裸体根级 | `"multiblock"` 或省略 | `"multiblock"` = 多方块为主；省略 = 帧为主 |
| `multiblockCount` | 内层 body | `1` | 一份文件只承载一台多方块 |
| `multiblock` | 内层 body | object | 声明主体，见 §4 |

判别入口是 `web/src/context/parsers/multiblockDocument.ts#isMultiblockShapeDocument`：只检查形态键（根级 `documentShape` 优先，其次 `meta.documentShape`）。形态判别先于 V2Plain 与 World，因为多方块文档也带 `format_version: "2.0"` 与 `frames`。

解析期硬断言（`parseMultiblockDeclaration`）：

| 断言 | 违反时 |
|---|---|
| `documentShape === "multiblock"` 时内层存在 `multiblock` 对象 | 解析失败 |
| `multiblockCount === 1` | 解析失败 |
| 内层不得有根级 `cellGrid` | 解析失败 |
| `frames` 非空，且每个 `variant` 已声明、规则引用已声明 | 解析失败 |

形态省略时，文档按帧为主解析，不受本文件约束。

## 3. 内层 body

```jsonc
{
  "schemaVersion": 1,
  "multiblockCount": 1,
  "multiblock": { },
  "blockPalette": [ ],
  "materialPalette": [ ],
  "textureBlobs": [ ],
  "tooltipPalette": [ ],
  "frames": [ ]
}
```

- `blockPalette` 是根级唯一一份，内容为所有变体装配结果的并集；条目字段见[场景文件格式契约](format-scene-file.md) §4.1。
- `materialPalette` 与 `textureBlobs` 的字段与像素语义见[场景文件格式契约](format-scene-file.md) §4.2、§4.3。
- `frames` 是场景清单，见 §5.3。
- 内层不得出现根级 `cellGrid`。

## 4. `multiblock` 对象

### 4.1 结构

```jsonc
"multiblock": {
  "id": "gregtech:metaTileEntity_electricBlastFurnace",
  "displayName": "Electric Blast Furnace",
  "sourceClass": "gregtech.api.metatileentity.implementations.MTEElectricBlastFurnace",
  "hasScopeOverlap": false,
  "scopeOverlapNote": "…",
  "totalTierDomain": { "min": 1, "max": 14, "default": 2, "source": "probed" },
  "tierSample": [1, 2, 14],
  "channels": [ ],
  "runstates": [ ],
  "couplingMode": "none",
  "couplings": [ ],
  "notes": [ { "kind": "note", "text": "…", "source": "…" } ],
  "viewerSemantics": { },
  "paletteSource": "union-all-variants",
  "geometryEncoding": "bakedQuadsJsonV1",
  "opsLegend": { "<legend id>": "说明" },
  "backbone": { },
  "rules": [ ],
  "variants": [ ]
}
```

| 字段 | 必填 | 口径 |
|---|---|---|
| `id` | 是 | 稳定标识 |
| `displayName` | 是 | 多方块显示名 |
| `sourceClass` | 否 | 来源类全名，供诊断与比对 |
| `hasScopeOverlap` | 是 | 是否存在「一个位置由多通道共同决定」的例外 |
| `scopeOverlapNote` | `hasScopeOverlap=true` 时必填 | 说明例外区域 |
| `totalTierDomain` | 是 | `{min, max, default?, source?}` |
| `tierSample` | 是 | 文档实际声明的总 Tier 取值清单 |
| `channels` | 是 | 通道清单，可为空数组（仅总 Tier） |
| `runstates` | 是 | 运行态清单，单态也必须显式声明 |
| `couplingMode` | 是 | `"none"`（缺省）或 `"clamp"` |
| `couplings` | 是 | 通道耦合清单，可为空 |
| `notes` | 是 | 不参与装配的声明 |
| `viewerSemantics` | 是 | 呈现语义，见 §7.4 |
| `paletteSource` | 是 | 恒 `"union-all-variants"` |
| `geometryEncoding` | 是 | 全文件统一的几何编码 |
| `opsLegend` | 否 | 规则说明池 |
| `backbone` | 是 | 骨架，见 §4.4 |
| `rules` | 是 | 差异规则表，见 §4.5 |
| `variants` | 是 | 变体清单，见 §5.1 |

### 4.2 通道

```jsonc
{
  "enum": "HEATING_COIL",
  "id": "coil",
  "key": "coil",
  "name": "Coil",
  "kind": "replace",
  "slot": "coil-slot",
  "min": 1,
  "max": 3,
  "axis": "y",
  "unit": "layers",
  "valueSemantics": "clamped-offset",
  "domainSource": "game-lang",
  "domain": { "max": 3 }
}
```

| 字段 | 必填 | 口径 |
|---|---|---|
| `enum` | 是 | 枚举名；显式写 `null` 表示非枚举通道 |
| `id` | 是 | 游戏内通道 id |
| `key` | 是 | 文档内唯一键 |
| `name` | 是 | 呈现名，取声明值，不由 `id` 推导 |
| `kind` | 是 | `"size"`、`"replace"`、`"hatch"` |
| `slot` | 否 | 位置集合的说明名 |
| `min` / `max` | `size` 必填；`replace` 缺省为 1 / 域上界 | 有效取值下界/上界 |
| `axis` / `unit` | `size` 必填 | 尺寸作用轴与单位 |
| `valueSemantics` | `size` 必填 | 取值语义，例如 `clamped-offset` |
| `domainSource` | 是 | `"game-lang"` 或 `"probed"` |
| `domain.max` | 否 | 取值域上界；缺省等于总 Tier 域上界 |

规则：

1. 取值域恒为 `0..domain.max`，`0` 表示「未设置」。未设置的物理形态是该通道键不存在，其有效值回落到总 Tier。
2. 通道用 `{enum, id}` 双键消歧；同一多方块内 `id` 不得重复，`key` 与 `name` 也不得重复。
3. `hatch` 只表示舱口布局，不参与取值，不得出现在 `rules[].indexTable` 中。
4. 通道声明只描述取值域与角色；具体位置的方块身份由 §4.5 的规则表决定。

### 4.3 通道种类的装配角色

| `kind` | 装配角色 | 取值来源 | 规则表达 |
|---|---|---|---|
| `size` | 选择骨架阶 | `frame.stepIndex` | 不进入规则表 |
| `replace` | 写规则表内容 | 声明值经 §5.2 解析 | `rules[].indexTable` 或 `guard` |
| `hatch` | 不参与装配 | 无 | 无 |

### 4.4 骨架

```jsonc
"backbone": {
  "kind": "sizeSteps",
  "sizeChannel": "height",
  "sizeSteps": [
    {
      "channel": "height",
      "layers": 3,
      "w": 3,
      "hh": 3,
      "d": 3,
      "roles": { "casing": 1, "controllerFace": 8 },
      "cellGrid": [ [ [1, 1, 1], [1, 0, 1], [1, 1, 1] ] ]
    }
  ]
}
```

- `backbone.kind` 只允许 `"sizeSteps"`。
- `sizeChannel` 是单值，且必须是 `kind: "size"` 的通道。
- 阶数必须等于尺寸通道的域长度 `max - min + 1`；第 k 阶对应有效值 `min + k`。
- `sizeSteps[].cellGrid` 是只含骨架方块的完整布局，下标为 `[z][y][x]`，**row 0 = 顶部**；声明尺寸 `w`/`hh`/`d` 必须与网格实际形状一致。
- `sizeSteps[].roles` 是语义名到调色板下标的映射，供规则以 `indexRole` 查表。

### 4.5 差异规则表

规则只存一份，场景按 `id` 引用。

```jsonc
{
  "id": "glass.rod",
  "phase": "backbone",
  "legend": "glass.replace",
  "kind": "setCell",
  "guard": { "clauses": [ { "channel": "coil", "not": true, "value": 0 } ] },
  "index": 7,
  // 三选一：indexRole，或 channel + indexTable
  "indexAliases": { "1": 9, "2": 9 },
  "x": 1,
  "y": 1,
  "z": 1,
  "sel": { "x": 1, "y": [2, 4], "z": 1 }
}
```

| 字段 | 必填 | 口径 |
|---|---|---|
| `id` | 是 | 文件内唯一 |
| `phase` | 是 | `"backbone"`、`"replace"`、`"runstate"` |
| `legend` | 否 | 指向 `opsLegend` 的说明键 |
| `kind` | 是 | `"setCell"` 或 `"fill"` |
| `guard` | 否 | 生效条件，见 §4.5.3 |
| `index` | 三选一 | 常量下标；`0` 表示空气 |
| `indexRole` | 三选一 | 骨架角色名，取 `step.roles[名]` |
| `channel` + `indexTable` | 三选一 | 以有效取值为下标查表 |
| `indexAliases` | 否 | 写入前的整表下标替换 |
| `x` / `y` / `z` | `setCell` | 单格坐标；缺省为 0 |
| `sel` | `fill` | 区间选择器，见 §4.5.1 |

写入下标的取值优先级为 `indexTable` → `indexRole` → `index`；三者都缺或指向未定义项时装配失败。`indexTable` 必须带 `channel`，长度至少为 `domain.max + 1`，第 0 档即「未设置」分支。

#### 4.5.1 `fill` 的 `sel`

| 轴写法 | 含义 |
|---|---|
| 数字数组 | 逐层取一个坐标；长度不足时重复最后一个 |
| 数字 | 每层使用同一坐标 |
| 缺省 | 该轴全长 |

`sel.y` 的层数决定写入层数；`x`/`z` 的数组在每个写入层都展开。越界坐标跳过，不报错。`fill` 不做算术，不接受 `"h-2"` 一类表达式。

#### 4.5.2 `indexAliases`

`indexAliases` 在写入前对当前网格执行一次整表替换：值为 `v` 的格若在表中则改为 `aliases[v]`，否则保持。可用于调色板重编号与系统性换料。一条规则可以先替换、再执行 `fill` 或 `setCell`。

#### 4.5.3 `guard`

```jsonc
"guard": { "clauses": [ { "channel": "coil", "not": true, "value": 0 } ] }
```

- `clauses` 之间为 AND；`guard.not: true` 对整体取反；无 `clauses` 恒真。
- 单条 clause 的形式：`{value}`（等于）、`{not: true, value}`（不等于）、`{min}`（≥）、`{max}`（≤）。
- `guard` 只比较有效取值，不做算术；引用的通道必须已声明。

### 4.6 尺寸轴的边界

`backbone.sizeChannel` 只允许一个尺寸型通道。`sizeSteps` 是扁平数组，阶数等于该通道的域长度；两个尺寸轴会把阶数变成乘积，不属于本格式。

## 5. 变体、场景与装配

### 5.1 变体清单

```jsonc
{
  "key": "height:3|coil:3|glass:0|tt:2|runstate:active",
  "totalTier": 2,
  "values": { "height": 3, "coil": 3, "glass": 0 },
  "runstate": "active"
}
```

变体键派生规则：按 `channels` 数组顺序把 `<通道key>:<声明值>` 用 `|` 连接，再依次追加 `tt:<总Tier>` 与 `runstate:<id>`。键中的值恒为声明值，未设置写 0。`variants` 内键不得重复，场景的 `variant` 必须命中已声明键。

总 Tier 必须进入键：通道未设置时有效值回落总 Tier，因此「全部通道未设置」在 `tt:1` 与 `tt:3` 下是两个不同变体。

### 5.2 有效值解析

装配第 0 步：

1. 总 Tier 按 `totalTierDomain` 夹取；不在 `tierSample` 中时，`assembleSelection` 回落到最近的已声明取值并记 warning。
2. 每个通道的声明值夹取到 `0..domain.max`（缺省上界为总 Tier 域上界）。
3. 声明值不大于 0（或未声明）时，有效值回落总 Tier；其余情况取声明值。
4. `couplingMode === "clamp"` 时按 §7.2 执行耦合夹取。

域夹取与耦合夹取都写入 `report.clamped`。尺寸型通道的 `min..max` 只用于取阶：`k = clamp(effective[sizeChannel], min, max) - min`；装配本身以 `frame.stepIndex` 为准，`stepIndexForEffective` 只用于诊断复核。

### 5.3 场景

```jsonc
{
  "index": 0,
  "variant": "height:3|coil:0|glass:0|tt:2|runstate:idle",
  "runstate": "idle",
  "stepIndex": 2,
  "rules": [ "coil.slot", "glass.rod", { "id": "runstate.face.h3.idle", "order": 0 } ],
  "label": "…",
  "durationMs": 0,
  "cellGrid": [ ]
}
```

| 字段 | 必填 | 口径 |
|---|---|---|
| `index` | 否 | 场景序号；缺省为数组下标 |
| `variant` | 是 | 变体主键 |
| `runstate` | 否 | 缺省取变体的运行态；不一致记 warning |
| `stepIndex` | 是 | 本场景使用的骨架阶，必须在阶数范围内 |
| `rules` | 是 | 有序规则引用；字符串形式按声明顺序，对象形式可用 `order` 指定顺序 |
| `label` | 否 | 显示标注 |
| `durationMs` | 否 | 不使用；场景没有时长 |
| `cellGrid` | 否 | 仅校验/取证用；生产产物不写 |

- 场景不得携带内联 `ops`；解析器把它判为硬失败。
- 场景的规则引用必须已声明；规则按 §5.4 的相位序与 `order` 应用。
- 场景清单不是时间轴：多方块文档的 `DocumentContent.frameAxis` 恒为空（`frameCount() === 0`），当前场景由通道取值决定，不由播放时间决定。

### 5.4 装配

`assembleSelection(doc, {totalTier, values, runstate})` 按当前选择装配：

1. 总 Tier 按域夹取，并对齐到 `tierSample`。
2. 通道声明值夹取到取值域；未声明通道的取值被忽略并记 warning。
3. 运行态未声明时回落到 `runstates[0]`。
4. 变体键未声明时回落到最近的已声明变体并记 warning；找不到可回落项才抛错。

`assembleVariant(doc, variantKey)` 只接受已声明变体；键未声明或该变体没有场景时抛错。

单场景装配：

```
step = backbone.sizeSteps[scene.stepIndex]
grid = 深拷贝(step.cellGrid)          // 同阶可能被多个场景复用
for ref in scene.rules（按 phaseRank, order 稳定排序）:
    rule = rules[ref.id]
    if not guard(rule.guard, effective): continue
    if rule.indexAliases: 整表替换(grid, rule.indexAliases)
    index = indexTable[effective[channel]] / step.roles[indexRole] / index
    写入 setCell 的单格或 fill 的区间（越界跳过）
断言每个下标落在 [0, blockPalette.length)
```

相位序为 `backbone` → `replace` → `runstate`；尺寸型已由 `stepIndex` 完成。装配只做查表、索引、深拷贝、排序与区间写入，不读取通道 id 的语义，不引入游戏逻辑。装配结果的下标越界即抛错。

装配报告包含 `clamped`、`warnings`、`rulesApplied`、`opsApplied`；`rejections` 恒为空，非法组合只夹取或回落，不拒绝。

## 6. 调色板

### 6.1 规则

1. `blockPalette` 只在根级存一份，内容为全部变体装配结果中出现的方块状态的并集。
2. `blockPalette[0]` 恒为空气。
3. 按内容签名全局去重，签名口径与 `MeshCaptureService#fullEqualitySignature(registryId, meta, nbt=null, geometry, tooltip=null)` 相同；同一方块状态的几何全文件只存一份。
4. 不得出现从未被任何变体引用的条目；校验器对此报 warning。
5. 全文件使用 `multiblock.geometryEncoding` 声明的同一种几何编码，不得混用。

### 6.2 「未设置」不需要独立条目

「未设置」的位置由总 Tier 决定方块。`indexTable` 的第 0 档写出该位置在未设置时显示的内容，通常与第 1 档相同。不要为「未设置」造永远无法被引用的独立条目。

### 6.3 几何编码

`geometryEncoding` 取 `"bakedQuadsJsonV1"`；条目字段集合为 `{registryId, meta, renderMode, geometry, occludesAdjacentFaces, nbt, tooltip}`，字段语义见[场景文件格式契约](format-scene-file.md) §4.1。

多方块导出产物不携带 `thumbnailPNG`：渲染像素跨运行不稳定，会破坏逐字节幂等与签名对齐。

### 6.4 两套签名

| | 去重键 | 对齐签名 |
|---|---|---|
| 定义 | `MeshCaptureService#fullEqualitySignature(registryId, meta, nbt=null, geometry, tooltip=null)` | `entrySignature(entry)` = 条目全文的 `canonicalJson`（对象键排序、数组保序） |
| 覆盖字段 | `registryId`、`meta`、`geometrySignature` | 条目全部键，含 `renderMode`、`occludesAdjacentFaces`、`nbt`、`tooltip` |
| 用途 | 调色板合并同内容条目 | 展开校验文件的 `palette.signatures` 与产物调色板的跨下标比对 |

`canonicalJson` 在 mod 侧（`MultiblockExpandedVerifier#canonical`）、`scripts/multiblock-fixtures/lib.mjs#canonicalJson`、两个 pipeline 校验器与 `web/e2e/helpers/multiblock/referenceGrids.ts#canonicalJson` 中必须同口径。对齐签名取条目全文，因此展开校验文件必须与其产物来自同一轮导出。

## 7. 运行态与约束

### 7.1 运行态

```jsonc
"runstates": [
  { "id": "idle", "name": "Idle", "materialSwap": false },
  { "id": "active", "name": "Running", "materialSwap": true }
]
```

`id` 是稳定标识；`name` 是呈现名，由文件自带；`materialSwap` 声明本态差异是否只落在材质/纹理层。单态也必须显式声明。`runstates` 不得为空，`id` 不得重复。

### 7.2 通道耦合

```jsonc
"couplingMode": "clamp",
"couplings": [
  { "id": "capacitor-ge-glass", "a": "capacitor", "b": "glass", "requires": "ge", "kind": "value", "source": "…" }
]
```

`requires` 取 `ge`、`le`、`eq`，语义为 `effective[a] requires effective[b]`。违反时把 `effective[b]` 夹到满足条件为止，并写 `report.clamped`。`b` 是被夹取的一方；`couplings` 按数组顺序执行，可级联。`couplingMode` 为 `"none"` 时不执行耦合。

### 7.3 缺省行为

| 情形 | 行为 |
|---|---|
| 未声明通道间约束 | `couplings: []` + `couplingMode: "none"`；各通道独立生效，不拒绝组合 |
| 已知约束但无法机器表达 | 写入 `notes[]`，不参与装配夹取 |
| 一个位置由多通道共同决定 | 该位置不进入骨架，整体由差异规则与 `guard` 表达；`hasScopeOverlap: true` |
| 通道取值超出声明域 | 夹取到域端，写 `report.clamped` |
| 尺寸型取值超出 `min..max` | 取阶时夹到 `max` |
| 无书面取值域 | 声明 `domainSource: "probed"` |

### 7.4 `viewerSemantics`

```jsonc
"viewerSemantics": {
  "frameIsVariant": true,
  "playback": "variant-frames",
  "layerPreview": "supported",
  "runstateCoverage": {
    "kind": "texture-material-swap",
    "geometryDelta": false,
    "tesr": "not-covered"
  }
}
```

运行态轴只承诺纹理/材质层差异。以下两类不在覆盖范围，也不得作为验收条件：

1. 经 shader/VAO 与延迟后处理的 TESR 活动几何。
2. 由真实配方运行才创建或展开的附属渲染方块。

`runstateCoverage.tesr` 恒为 `"not-covered"`；`geometryDelta` 恒为 `false`。

## 8. 与信封的组合

多方块 body 在容器中的位置：

- 信封 `meta.documentShape = "multiblock"`。
- 内层 body 增加 `multiblock` 与 `multiblockCount`，其余键沿用 §3。
- 容器字段、`payloadEncoding`、base64/gzip 读取顺序与 proto 政策见[运行时 JSON 与协议](../protocol.md)。

因子化发生在信封之前：先把变体集合整理为骨架、规则表、场景清单与并集调色板，再交给容器编码。

## 9. 校验入口

### 9.1 解析与校验

`web/src/context/parsers/multiblockDocument.ts#parseMultiblockDeclaration` 对内层 body 执行 §2 的形态断言与下列检查：

- `multiblock`、`totalTierDomain`、`channels`、`runstates`、`backbone`、`rules`、`variants`、`frames` 的结构与类型。
- 通道 `key`、`id`、`name` 不重复；`runstates` 非空且 `id` 不重复。
- `backbone.kind === "sizeSteps"`；`sizeChannel` 必须是尺寸型通道；`sizeSteps` 非空。
- 规则 `id` 不重复；`indexTable` 带 `channel` 且长度足够；`guard` 引用已声明通道。
- 变体键不重复；场景的 `variant`、规则引用、`stepIndex` 有效；场景不得带 `ops`。
- 内层不得有根级 `cellGrid`。

结构性错误抛 `MultiblockParseError`，消息带可定位原因。声明瑕疵（尺寸与网格不一致、未声明运行态、未引用变体、`legend` 未登记等）进入 `warnings`，不阻断加载。

### 9.2 fixture 校验器

```bash
node scripts/multiblock-fixtures/validate-multiblock-fixtures.mjs
node scripts/multiblock-fixtures/validate-multiblock-fixtures.mjs --verify-grids
node scripts/multiblock-fixtures/validate-multiblock-fixtures.mjs --all
```

- 默认执行格式校验与全组合装配。
- `--verify-grids` 把参考网格落到 `scripts/multiblock-fixtures/.out/` 并做确定性断言；该目录不是提交物。
- 退出码：`0` 全部通过；`1` 存在硬失败；`2` 找不到 fixture。

### 9.3 fixture

| 文件 | 覆盖 |
|---|---|
| `web/src/context/__tests__/fixtures/multiblock-ebf-2ch.json` | 尺寸型通道 + 两个替换型通道 + 两种运行态 |
| `web/src/context/__tests__/fixtures/multiblock-tier-only.json` | 仅总 Tier；无书面取值域的通道；单运行态 |
| `web/src/context/__tests__/fixtures/multiblock-lsc-overlap.json` | 作用域相交例外与 `clamp` 型耦合 |

参考装配器与信封读取在 `scripts/multiblock-fixtures/lib.mjs`。

## 10. 体积判据

本节给出当前可执行的体积判定式。记号、阈值与失败条件以 `scripts/multiblock-fixtures/validate-multiblock-fixtures.mjs` 与 `scripts/acceptance/volume-curve.mjs` 的实现为准。`scripts/volume-profile/volume-profile.mjs` 只做字节分桶；`scripts/acceptance/volume-doc.mjs` 只归档报告；`scripts/acceptance/build-report.mjs` 只汇总验收清单。这三者不产生本节判据。

### 10.1 记号与阈值

| 记号 | 定义 |
|---|---|
| `N` | 文档声明的变体数（`multiblock.variants.length`） |
| `S` | 轴展维度和：总 Tier 域长度 + Σ 通道域长度；R3 使用 `volume-curve` 的 `axisSpan`（尺寸型通道按 `hi - lo + 1`） |
| `G` | 解包后内层 body 的 JSON 经 gzip level 9 的字节数；不使用信封或 base64 字节 |
| `V` | `blockPalette` 的 JSON 字节 ×1 + 每个变体完整 `cellGrid` 的 JSON 字节之和；不含 `materialPalette` / `textureBlobs` / `tooltipPalette` |
| `κ` | `V / G` |

阈值来自 `CRITERION` 与 `VOLUME_CRITERION`：

| 常量 | 值 | 适用 |
|---|---|---|
| `λ` | 1.35 | R1、R3 |
| `r2Min` | 0.95 | R2 |
| `maxMarginalBytesPerVariant` | 2048 B/组合 | R2 的 `b` |
| `floorBytes` | 4096 B | R2 的 `constantDominated` / `smallEnough` 分支 |
| R2 点数 | 至少 3 点且至少 2 个不同 `N` | `volume-curve` 的 R2 适用条件 |

`minPoints: 4` 在两个脚本中都有声明，但当前判定未使用，不作为门槛。

fixture 校验器的 `axisSpan` 对每个通道取 `hi + 1`，不减去尺寸型通道的 `min`；R3 不在该校验器上执行，R3 的 `S` 口径以 `volume-curve` 的 `axisSpan` 为准。

### 10.2 fixture 校验器：R1 / R2

入口：

```bash
node scripts/multiblock-fixtures/validate-multiblock-fixtures.mjs --volume
```

输入是契约 fixture（`multiblock-ebf-2ch`、`multiblock-tier-only`、`multiblock-lsc-overlap`）。对每份 fixture，`scaleDocument` 把每个 `replace` 通道的域放大 `k = 1, 2, 4, 8` 倍，重新装配每个变体并测量。

- R1：对相邻点 `a → b`（`N` 递增），要求 `κ_b / κ_a ≥ 1/√1.35`。任一相邻点低于该值即失败。
- R2：最小二乘拟合 `G ≈ a + b·N`。
  - `r2 = R²`，`r2Ok = r2 ≥ 0.95`。
  - `marginalOk = b ≤ 2048`。
  - `variablePart = b · N_max`；`constantDominated = variablePart < 4096`；`smallEnough = max(G) ≤ 4096`。
  - `fitOk = constantDominated ? smallEnough : (r2Ok && variablePart ≥ 2·max(a, 0))`。
  - `pass = fitOk && marginalOk && 全部 R1 通过`。
  - 该校验器的 R2 闸门是 `2·max(a, 0)`，不是 `2·max(a, 4096)`；4096 只用于 `constantDominated` / `smallEnough` 分支。真实序列的 `gateRequired` 才是 `2·max(a, 4096)`（§10.3）。

失败条件：任一 R1 不通过、`fitOk` 为假、或 `marginalOk` 为假。该校验器不执行 R3；`--volume` 把每份 fixture 的结论写入 `report.volume[]`，`pass` 是该分项的结论。

### 10.3 真实编码器序列：R1 / R2 / R3

入口：

```bash
node scripts/acceptance/volume-curve.mjs --encoded <dir> \
  [--products <dir>] [--profile <json>] \
  [--contract-report <validation-report.json>] [--pipeline-result <json>]
```

输入是 `--encoded` 下 `control/` 的 `ctl-values-*` 与 `ctl-chan-*` 两组真实编码器对照序列（`encoder-values`、`encoder-channels`）。`extended` 中的全量域点只作参照，不参与 R1/R2/R3。`--contract-report` 读取 §10.2 的 `report.volume[]`；`--products` / `--profile` / `--pipeline-result` 只补充交付产物、字节分桶与捕获统计。

- R1：对 `N` 递增的相邻点，要求 `κ_b / κ_a ≥ 1/√1.35`；`N` 相同的点对跳过。全部点对都被跳过或没有点对时，状态为 `not-applicable`。
- R3：`spart = JSON(backbone) + JSON(rules) + JSON(blockPalette)` 的未压缩字节数；对相邻点要求 `spartGrowth ≤ 2·1.35·sGrowth`，其中 `sGrowth = S_b / S_a`。无点对时状态为 `not-applicable`。
- R2：至少 3 点且至少 2 个不同 `N`，否则 `not-applicable`。拟合同上：
  - `r2Ok = r2 ≥ 0.95`，`marginalOk = b ≤ 2048`。
  - `constantDominated = b·N_max < 4096`；`smallEnough = max(G) ≤ 4096`；`gateRequired = 2·max(a, 4096)`。
  - 判定顺序：
    1. `!r2Ok || !marginalOk` ⇒ `fail`。
    2. `constantDominated && smallEnough` ⇒ `pass`。
    3. `constantDominated && !smallEnough` ⇒ 补充判据通过时 `not-applicable`，否则 `fail`。
    4. `!constantDominated && variablePart ≥ gateRequired` ⇒ `pass`。
    5. 其余 ⇒ 补充判据通过时 `pass-with-caveat`，否则 `fail`。
  - 补充判据：每一对相邻点的边际 `(G_b - G_a)/(N_b - N_a) ≤ 0.9 × (b.gridBytes / b.N)`；且截距的至少 50% 来自 `materialPalette + textureBlobs + tooltipPalette` 的 gzip 池。

序列状态：任一 R1/R2/R3 为 `fail`，或 R2 为 `not-applicable` 且补充判据不通过 ⇒ `fail`；存在 `pass-with-caveat` 或 `not-applicable` ⇒ `pass-with-caveat`；否则 `pass`。

`contractKSequencePassed = report.volume[] 全部 pass`；未提供 `--contract-report` 时为 `null`。R2 的格式判定落在契约 k 序列：真实序列落在常数主导分支且不满足 `smallEnough` 时，R2 以 `not-applicable` 记录（需补充判据通过），并以 `contractKSequencePassed` 与补充判据共同承担结论。`volume-curve.verdict.status` 只汇总 encoder 序列状态，不并入 `contractKSequencePassed`。

### 10.4 编排与验收门禁

下列检查属于验收编排（`scripts/acceptance/lib/checklist.mjs`），不是格式判据：

| 检查 | 通过条件 | 失败条件 |
|---|---|---|
| `compress/volume-curve` | encoder 序列 ≥2；每条 R1 为 `pass`；每条 R3 为 `pass`；每条 R2 不为 `fail`；`contractKSequencePassed === true`；每条序列的 `marginalDeclarationBytesPerVariant < 128 B/组合` | 任一条件不满足 |
| `compress/no-expansion` | `frames[].ops` 为 0；生产 `frames[].cellGrid` 为 0；契约校验器 `frames/*` 通过；交付产物聚合 `κ = ΣV/ΣG ≥ 2.3` | 任一条件不满足 |

`build-report.mjs` 的 `verdict.status` 在任一 checklist 项为 `fail` 或 `not-run` 时判 `fail`，否则 `pass`；它不新增体积判据。`risk4`（调色板占比）只写入报告，不参与上述门禁。
