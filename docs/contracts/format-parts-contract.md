# 部件与物品索引契约

本文件定义非满方块（部件）在场景文件中的载荷形状、坐标、编辑跟随与物品索引表。容器形式与信封字段搬运见[运行时 JSON 与协议](../protocol.md)；场景级字段与调色板条目见[场景文件格式契约](format-scene-file.md)。

## 1. 范围与判定

部件数据由导出路径产出，只覆盖非满方块。满方块格不产生部件：`renderAsNormalBlock()` 为真，且选择盒与碰撞盒都是整格时，该格走无部件的既有路径。其余格进入提供者流水线（§7）。

文件中没有部件字段时，解析、渲染、编辑行为与无部件文件一致；无部件数据不产生 `cellPartsGrid`、`partLists`、`partIconTextures`、`itemIndex`，`blockPalette` 条目也不带 `hostItem`。

## 2. 载荷格式

部件数据是「格级索引 + 根级池」，结构根上成对出现：

```jsonc
{
  "blockPalette": [ ],
  "cellGrid": [ ],
  "cellPartsGrid": [
    [[-1, 0, -1]]
  ],
  "partLists": [
    [ ]
  ]
}
```

- `cellPartsGrid` 与 `cellGrid` 同形同下标 `[z][row][column]`，值为 `partLists` 下标；`-1` 表示该格无部件。
- `partLists` 是部件列表池；同一内容列表跨格共享一份下标（§2.1）。
- `cellPartsGrid` 缺省或全为 `-1` 时，该结构没有部件。
- 满方块格的 `cellPartsGrid` 恒为 `-1`；非满格有产出时写入部件下标，无产出时仍为 `-1`。
- World 文档中，`cellPartsGrid` 与 `partLists` 位于每个 `frames[].structure` 根，形状与单结构一致。

文档根级字段：

| 字段 | 口径 |
|---|---|
| `partIconTextures` | `{ <iconKey>: <base64 PNG> }`；`iconKey` 与物品身份键同键；仅当文档含部件且至少渲染出一个图标时写入 |
| `itemIndex` | 物品索引表，见 §9；跨帧共享一份，仅当文档含条目时写入 |

`partIconTextures` 中 FMP 材料变体使用基础物品图标：NBT 判别值是字符串键，无法据此重建 NBT 物品栈。

### 2.1 `partLists` 去重

同一部件列表（local id 序列、类型键、盒、物品身份全部一致）在多格出现时只存一份。签名输入为 `localId`、`typeKey`、`boxes`、`items`；`displayName`、`tooltip`、`properties` 不参与签名。盒是逐格快照，签名因此能区分邻居形态。去重只承诺同一次导出内稳定。

## 3. PartRecord

```jsonc
{
  "localId": "ae2:UP",
  "typeKey": "appliedenergistics2:item.ItemMultiPart:220",
  "boxes": [
    { "min": [0.375, 0.0, 0.0], "max": [0.625, 0.625, 0.3125], "kind": "visual" },
    { "min": [0.375, 0.0, 0.0], "max": [0.625, 0.625, 0.3125], "kind": "collision" }
  ],
  "displayName": "ME Storage Bus",
  "tooltip": ["ME Storage Bus", "…"],
  "items": [
    {
      "registry": "appliedenergistics2:item.ItemMultiPart",
      "damage": 220,
      "count": 1,
      "nbtDiscriminator": "mat=…",
      "display": "ME Storage Bus"
    }
  ],
  "source": {
    "family": "ae2",
    "fallback": false,
    "boxProvenance": "both",
    "tier": 1
  },
  "properties": { }
}
```

| 字段 | 必填 | 口径 |
|---|---|---|
| `localId` | 是 | 格内定位，`<族前缀>:<族内定位符>`，见 §4 |
| `typeKey` | 是 | 跨格类型键，由物品身份导出，见 §5 |
| `boxes` | 是 | 空间盒数组，至少一项，见 §6 |
| `displayName` | 是 | 游戏内显示名 |
| `tooltip` | 是 | 说明行，导出时生成完毕 |
| `items` | 是 | 物品身份数组；空数组是显式「无」 |
| `source` | 是 | 来源四元组，见 §7 |
| `properties` | 否 | 族特有补充信息；强契约字段不得放入 |

## 4. `localId` 命名空间

格式为 `<族前缀>:<族内定位符>`，族前缀等于 `source.family`。

| 族 | `localId` 形态 | 依据 |
|---|---|---|
| `ae2` | `ae2:<FACE>`（`NORTH`…`UP`）；中心线缆 `ae2:UNKNOWN`；伪装板 `ae2:facade:<FACE>` | AE2 部件挂载面枚举 |
| `eio` | `eio:<ConduitType 简单名>` | `getBaseConduitType()` |
| `fmp` | `fmp:slot<N>`（PartMap 0–26）；无槽部件 `fmp:part<枚举序号>` | `getSlot()` |
| `generic` | `generic:0`（单盒通用档一格一个部件） | 通用档 |
| `inferred` | `inferred:<岛序号>` | 几何推断分区序号 |

同格多族合并时各带前缀。同格出现重复 `localId` 时，追加 `#2`、`#3` 序号，并在导出日志记录。

## 5. `typeKey` 与 `items`

计数单位是可合成物品。`typeKey` 由物品身份导出：

| 族 | `typeKey` | 说明 |
|---|---|---|
| `ae2` | `registry:damage` | 同一 item 的不同 damage 是不同物品 |
| `eio` | `registry:damage` | 连接器 `conduitType == null` 不是独立物品，不发射部件 |
| `fmp` | `registry:damage#mat=<材料串>` | 材料名是别名，权威身份是 NBT `mat` 串；`nbtDiscriminator` 同形 |
| `generic` | drop 身份：`getItemDropped` registry + `damageDropped`；无掉落时回退宿主方块 `registry:meta` | 不是方块 meta |
| `inferred` | 宿主 drop 身份；无掉落时回退宿主方块 `registry:meta` | 推断档无更细信息 |

一部件不等于一物品：`items` 是数组，FMP `size>1` 微方块的 `getDrops()` 可拆多件，逐条写入并保留 `count`。没有可合成物品的部件写 `items: []`（显式「无」）。EnderIO 连接器不发射部件，其几何归导管本体。

## 6. 盒坐标与取盒

### 6.1 坐标系

盒坐标为 **0–1 方块局部、MC 标准朝向、Y-up**：

- AE2 原生 0–16 像素挂载面坐标，经 `BusCollisionHelper` 归一化，不做自建变换。
- EnderIO、FMP 与原版原生即 0–1。
- 原版 `getSelectedBoundingBoxFromPool` 返回世界坐标，归一化时减去格坐标。

### 6.2 取盒

1.7.10 的 `getSelectedBoundingBoxFromPool` 与 `getCollisionBoundingBoxFromPool` 内部不调用 `setBlockBoundsBasedOnState`。任何取盒前必须显式调用 `setBlockBoundsBasedOnState(world, x, y, z)`。

碰撞盒枚举的 mask 必须放宽到整格上方一格，以收齐高 1.5 的栅栏杆：

```java
AxisAlignedBB mask = AxisAlignedBB.getBoundingBox(x, y, z, x + 1, y + 2, z + 1);
block.addCollisionBoxesToList(world, x, y, z, mask, boxes, null);
```

### 6.3 越界

盒允许超出 `[0,1]³`，如实记录，不裁剪。消费方的命中判定与呈现必须容忍越界值。

### 6.4 视觉盒与碰撞盒

两盒都取；`boxProvenance` 标记来源：

| 来源 | 取值 |
|---|---|
| AE2、FMP、原版单盒档两盒齐全 | `both` |
| EnderIO | `collision-derived-visual`（视觉盒 = 碰撞盒绕中心 ×1.09） |
| generic 只有一侧盒 | `visual-only` 或 `collision-only` |
| 档 3 几何推断（含火把类） | `visual-only` |
| 档 3 无可用几何 | `degenerate`（回退整格盒） |

`degenerate` 只表示推断档没有任何可用几何，不是火把类的同义词。

## 7. 来源与降级

`source` 四元组：

| 字段 | 取值 |
|---|---|
| `family` | `ae2` / `eio` / `fmp` / `generic` / `inferred` |
| `fallback` | 族权威为 `false`；`generic`/`inferred` 为 `true` |
| `boxProvenance` | 见 §6.4 |
| `tier` | `1` 族权威、`2` 通用盒、`3` 几何推断 |

提供者按档执行：

1. 档 1：全部命中的族提供者执行并合并结果；任一部件产出即完成。
2. 档 2：原版 API 取盒；有有效结果即完成，`family = generic`、`fallback = true`。
3. 档 3：几何推断，`family = inferred`、`fallback = true`；只有档 1、档 2 都没有结果时执行。

提供者抛异常或反射失败时捕获、记日志并跳过该提供者，导出不中断。`inferred` 不作为主来源。

## 8. 说明

`tooltip` 在导出时生成完毕，落盘为最终行。生成顺序：

1. 部件物品说明（`ItemStack.getTooltip`）。
2. 部件自定义说明（族接口预留；当前无实例）。
3. 宿主回退：宿主方块 tooltip 加部件定位后缀；`displayName` 缺省时为宿主显示名加定位后缀。

逐格人工说明（`cellTooltipGrid` / `tooltipPalette`）是叠加层：有逐格说明时优先显示，部件说明作为部件命中的回退。物品级说明见 §9，与 `PartRecord.tooltip` 同源生成、各自保留。

## 9. 物品索引表

`itemIndex` 是文档根级对象，键为物品身份键，值为条目：

```jsonc
{
  "minecraft:torch:0": {
    "display": "Torch",
    "tooltip": ["Torch"],
    "source": "part",
    "attribution": [
      { "source": "part", "frame": 0, "grid": [0, 1, 0], "localId": "generic:0" },
      { "source": "host", "frame": 0, "grid": [0, 1, 0] }
    ]
  }
}
```

| 字段 | 口径 |
|---|---|
| 键 | 物品身份键 `registry:damage[#nbt]` |
| `display` | 显示名；缺省等于键 |
| `tooltip` | 说明行；为空时至少写 `display` |
| `source` | 首条归属的来源；无归属为 `none` |
| `attribution` | 归属定位数组；空数组是显式「无对应」 |

`attribution` 条目：

| 字段 | 口径 |
|---|---|
| `source` | `part` / `host` / `family` |
| `frame` | 帧下标；单文件文档为 0，World 为 `frames[i].index` |
| `grid` | `[zSlice, row, column]`，与 `cellGrid`/`cellPartsGrid` 同下标 |
| `localId` | 仅 `source = "part"`：格内部件定位 |

归属分层，权威度由高到低：

1. `part`：`PartRecord.items[0]` 命中，定位到格与 `localId`。
2. `host`：该格宿主方块的物品身份（`Item.getItemFromBlock` 加方块 meta），只定位到格。映射数据同时写入 `blockPalette[]` 条目的 `hostItem: {registry, damage}`；无物品形态的方块不写该字段。
3. `family`：族特有规则（NBT/材料决定的对应）。当前规则注册表为空，不产生该来源条目。
4. 无规则命中时写 `attribution: []` 与 `source: "none"`，不猜。

约束：

- 键集等于文档全部部件的全部 `items[]` 条目；按键去重，键按字典序落盘。
- 归属按 `(source, frame, grid, localId)` 去重；同一命中跨帧重复出现不重复计入。
- `source` 由 `attribution` 首条重算；消费方不得信任文件里的同名字段。
- 空数组与「键不在表里」不同：前者是有数据的显式「无对应」，后者是无索引条目。
- 附加物品条目（`items[i>0]`）建条目，`display` 为物品身份键，`attribution` 为空。
- 反查索引只从 `itemIndex` 生成，不从 `partLists` 或 `cellGrid` 二次推导。

## 10. 编辑与往返

- 盒是导出时快照；编辑不触发盒重算。
- 删除宿主方块时其部件随之删除；移动方块时部件随宿主移动。邻居变化导致的盒过期如实保留，刷新手段是重新导出。
- 新建或手绘方块没有部件数据，行为与无部件文件一致。
- 明文文档的解析与序列化必须保留 `cellPartsGrid`、`partLists`、`partIconTextures`、`itemIndex` 与 `blockPalette[].hostItem`；这些字段随编辑后的文档重新序列化，缺失的字段不补占位。
- `cellPartsGrid` 的 `-1` 与空数组、`itemIndex` 的空归属数组分别是不同状态，不得在往返中合并。
- 经信封的字段搬运见[运行时 JSON 与协议](../protocol.md)。

## 11. 校验入口

| 面 | 入口 |
|---|---|
| 解析与往返 | `web/src/context/__tests__/partsRoundtrip.test.ts` |
| `itemIndex` 根级挂载 | `web/src/context/__tests__/itemIndexRootField.test.ts` |
| 反查索引 | `web/src/pure/__tests__/itemIndex.test.ts` |
| 物品行计数 | `web/src/pure/__tests__/partStats.test.ts` |
| oracle 基准 | `test/expected/parts-acceptance/` 下三份 JSON，schema 为 `lightning.parts-oracle/1` |
| oracle 消费 | `web/e2e/parts-real-export-evidence.spec.ts`（真实产物门控） |

oracle 文件形状：

```jsonc
{
  "schema": "lightning.parts-oracle/1",
  "structure": "parts-acceptance",
  "builtAtEpochMs": 0,
  "zones": ["full-cube", "single-box", "ae2", "enderio", "fmp", "overlay", "variants", "degraded"],
  "cells": [
    {
      "pos": [0, 0, 0],
      "host": "registry:meta",
      "expectFullCube": false,
      "zone": "ae2",
      "grid": [0, 0, 0],
      "parts": [
        { "localId": "ae2:UP", "typeKey": "…:220", "itemCount": 1, "boxTier": 1, "boxCount": 3, "boxProvenance": "both" }
      ]
    }
  ],
  "expectedCounts": [
    { "typeKey": "…", "display": "…", "count": 12 }
  ],
  "gridIndex": { "origin": [0, 0, 0], "size": [1, 1, 1], "rowAxis": "y-top-first" },
  "countsScope": "all-cells",
  "itemIndexScope": "exact",
  "itemIndex": { },
  "hostItems": { }
}
```

`gridIndex.rowAxis` 为 `y-top-first`；`cells[].grid` 是 `cellPartsGrid` 下标，供下游直接映射，不重算 `worldGrid`。`countsScope` 与 `itemIndexScope` 取 `all-cells` / `untransformed-cells-only` 或 `exact` / `untransformed-cells-only`，决定计数与键集是全集还是未变换格子集；`itemIndexRules` 登记 `display`/`tooltip` 回退、`source` 派生、归属分组与 `localId` 通配的比对口径。`itemIndex` 与 `hostItems` 分别是物品索引表和宿主级映射的期望值，完整清单以该目录 README 与文件本身为准。退化格的盒数、来源与岛序号不可静态预测，使用哨兵值 `boxCount: -1`、`boxProvenance: "*"`、`localId: "inferred:*"`，仍断言档位、族、`fallback` 与 `typeKey`。oracle 不写实时时间：`builtAtEpochMs` 恒为 0。
