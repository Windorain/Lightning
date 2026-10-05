# 部件数据契约

> **地位**：本文件是「非满方块（部件）支持」的**单一数据源契约**——盒、说明、计数三方共用同一份部件数据。
> 它与代码**同生共死**：改实现必须同 PR 改本文件；同一契约另有一份 Gitea Wiki 阅读镜像页，冲突时以本文件为准。
> 凡与本契约冲突的实现以本契约为准；契约未覆盖处按 §13 留白表登记后扩展。
>
> **治理注**：正文里的 `P0.x/P1.x/P2.x/P3.x` 一类编号属治理前的过程性计划/探针文档（计划与探针报告已按 #51 裁决
> 从仓库删除，原文见 issue #51 与 git 历史）。这些编号**已中性化**，只保留可长期追溯的锚点：`留白 #N`、
> Gitea issue/PR 号、`B-x` 工作包号。
>
> **本轮修订（部件轮·统计栏物品清单与部件级呈现）**：新增 §2.2 物品索引表；§9 三级配置/规则能力**已废弃**（决策 C）；
> §13 留白 #6/#11 相应标注取代，并新增 #18/#19/#20。取代依据：Issue
> [#5](http://127.0.0.1:3300/Lightning/lightning/issues/5) /
> [#6](http://127.0.0.1:3300/Lightning/lightning/issues/6) /
> [#7](http://127.0.0.1:3300/Lightning/lightning/issues/7)。
>
> **§2.2 字段命名/序列化定稿（B-2，2026-10-04）**：物品索引表的落盘形状（`itemIndex` 键与条目字段、
> `attribution` 的 `source/frame/grid/localId`、`source` 与归属的派生关系、层级枚举范围）与
> `blockPalette[].hostItem` 字段名已写入 §2.2，留白 #18 闭环。依据：Issue
> [#35](http://127.0.0.1:3300/Lightning/lightning/issues/35)。
>
> **本轮收尾（#40，2026-10-04）**：① §2.2 定稿核对完成（补记**行键 = 物品身份键的结构性保证**（B-3 起由
> `partItemKey(item)` 生成，非"巧合相等"）、**层③ 扩展接口 `AttributionRule` 的形状**、已知键拼写漂移指向
> [#48](http://127.0.0.1:3300/Lightning/lightning/issues/48)）；② §9 取代核对完成（决策 C 口径与"行键结构性保证"
> 已挂接，无残留矛盾）；③ B-5 两项拍板登记进 §13（留白 #19/#20）。
>
> **实现状态（务必与契约本身区分）**：§2.2 的 `itemIndex` 生成（mod `ItemIndexIntegrator`）、proto 消息
> （`ItemIndexEntry`/`ItemAttribution`/`HostItemIdentity`）与 web 反查索引（`web/src/pure/itemIndex.ts`）随
> `feat/parts-b2-item-index` 及其叠加分支落盘，**尚未合入 `main`**；本契约先行为准。`main` 现仍产出
> `statsTemplate`，按 §9 的兼容口径消费侧须**静默忽略**（不报错、不空栏）。
>
> **范围**：部件数据由 **`/sde export` 导出路径**（含游戏内自动化导出）产出；multiblock 文档本轮
> **不携带** parts（其调色板走 GeometryPalette 独立链路，留待未来立项）。文件中**无部件字段 = 行为与
> 今天完全一致**（向后兼容硬约束）。

---

## 1. 判定与快速否定

**满方块判定（终版三条件，11/11 场景实证）**：

```java
boolean isFullCube(Block block, World world, int x, int y, int z) {
    block.setBlockBoundsBasedOnState(world, x, y, z);   // 纪律：每次取盒前必须显式调（见 §6.2）
    AxisAlignedBB sel = block.getSelectedBoundingBoxFromPool(world, x, y, z);
    block.setBlockBoundsBasedOnState(world, x, y, z);
    AxisAlignedBB col = block.getCollisionBoundingBoxFromPool(world, x, y, z);
    return block.renderAsNormalBlock()
        && equalsBox(sel, x, y, z, x+1, y+1, z+1)
        && equalsBox(col, x, y, z, x+1, y+1, z+1);      // col == null ⇒ false
}
```

- 判定为满方块 ⇒ **走现有路径零改动**（不发射任何部件数据，零额外开销）。这是快速否定路径。
- 两个更松变体均有实测反例，**禁止采用**：仅选择盒 → 火把误判（`BlockTorch` 不设 bounds，选择盒即整格）；
  选择盒+碰撞盒 → 四向连接栅栏误判（选择/碰撞单盒都撑满整格，但碰撞多盒是 2 根杆）。
- 判定为非满 ⇒ 进入三档兜底流水线（§7）。

## 2. 文件表达（V2 plain/baked JSON）

**核心事实（探针实证）**：盒依赖邻居与方块状态（栅栏连接形态、箱子合并），是**逐格快照**——
不能挂在调色板条目上（同一条目不同格的盒不同）。因此部件数据采用**格级索引 + 根级池**，
完全仿照既有 `cellTooltipGrid` / `tooltipPalette` 成对 idioms：

```jsonc
{
  "blockPalette": [ /* 既有，不变 */ ],
  "cellGrid": [ /* 既有，不变：cellGrid[z][row][column] = 调色板下标 */ ],
  "cellPartsGrid": [   // 新增，可选；与 cellGrid 同形同下标 [z][row][column]
    [[ -1, 0, -1 ]]    //   值 = 根级 partLists 下标；PARTS_GRID_NONE = -1 表示该格无部件
  ],
  "partLists": [       // 新增，可选；部件列表池（同内容列表跨格共享一份，见 §2.1）
    [ /* PartRecord, PartRecord, ... */ ]
  ]
}
```

- `cellPartsGrid` 缺省或全 -1 ⇒ 与今天行为完全一致。
- 满方块格**必须**为 -1（判定路径保证）；非满格至少一个部件。
- **多帧 frames JSON**（V2 plain 家族的 World 包装，非 proto `WorldFrame` 线格式）：`cellPartsGrid`/
  `partLists` 落在**每个帧的 `structure` 根**，池化形状与单结构一致（已验证落盘；proto
  `BlockInstance.parts` 的非池化表述仅指 proto 线格式，不适用于 frames JSON 中间形态）。
- **部件图标**：文档根 `partIconTextures: { <iconKey>: <base64 PNG> }`，iconKey = 物品身份键
  `registry:damage[#nbt]`（与统计行 iconKey 同键）；仅当文档含部件数据时写入（无部件文件字节
  干净）。已知限制：FMP 材料变体图标 = 基础物品图标（nbtDiscriminator 是字符串键、无法重建
  NBT 栈）。
- World 多帧格式：`BlockInstance.parts`（proto 已预留）直接挂同 schema 的 PartRecord 数组，
  不走池化（该格式本就逐实例展开）。

### 2.1 partLists 去重

同一部件列表（local id 序列 + 类型键 + 盒 + 物品身份全部一致）在多格出现时只存一份
（内容签名去重，复用既有 `fullEqualitySignature` 思路）。典型命中：N 个孤立同向箱子、N 个同形态
导管束格。签名输入含盒数值（盒是快照，签名天然区分邻居形态）。**不做**跨版本/跨文件稳定性承诺。

### 2.2 物品索引表（itemIndex；部件轮·统计栏物品清单与部件级呈现新增）

**地位**：物品级说明与归属的**单一数据源**——左栏物品行悬停说明（[#5](http://127.0.0.1:3300/Lightning/lightning/issues/5)）与
点选高亮归属（[#7](http://127.0.0.1:3300/Lightning/lightning/issues/7)）共用本表，**不得**出现第二套键或第二条生成路径。

> **【本节字段命名/序列化已定稿（B-2，2026-10-04 回填）】** 本节此前只定语义、留字段细节；以下为
> B-2（Gitea [#35](http://127.0.0.1:3300/Lightning/lightning/issues/35)）实现的落盘形状，契约自此按此执行。
> 落盘权威 = camelCase；proto 规范名见 §10.2（`ItemIndexEntry`/`ItemAttribution`/`HostItemIdentity`，
> 仅作文档登记，无 Java 代码生成）。

```jsonc
{
  "itemIndex": {                 // 文档根级，跨帧共享（World 文档挂 World 根）；仅当文档含部件数据时写入（无部件文件字节干净）
    "minecraft:torch:0": {       // 键 = 物品身份键 registry:damage[#nbt]（同 §5 / PartItem / partItemKey）
      "display": "Torch",              // 显示名；缺省兜底 = 物品身份键本身
      "tooltip": ["Torch", "..."],     // 说明行 = 该物品的 ItemStack.getTooltip（§8 第一优先级，宿主回退之前）；空 ⇒ 至少 [display]
      "source": "part",                // 归属最终来源：part | host | family | none（派生汇总；见下）
      "attribution": [                 // 归属定位；**空数组 = 显式"无对应"**（字段必在，不省略）
        { "source": "part", "frame": 0, "grid": [zi, ri, ci], "localId": "generic:0" },
        { "source": "host", "frame": 0, "grid": [zi, ri, ci] }    // 无 localId 键 = 只定位到整格
      ]
    }
  },
  "blockPalette": [
    { /* ...既有... */ "hostItem": { "registry": "minecraft:torch", "damage": 0 } }  // 层② 映射数据（仅含部件文档写入）
  ]
}
```

- **键与去重**：与左栏行、`partIconTextures` 同一套物品身份键；键集 = 该文档全部部件的全部
  `items[]` 条目（`i≥0`，与 `partIconTextures` 一致）；按键去重（键按字典序落盘 = 跨帧稳定），
  归属按 `(source, frame, grid, localId)` 去重（同一命中跨帧重复出现不重复计入）。
- **`source` 与 `attribution` 的关系（硬约束）**：`source` = `attribution` 首条的 `source`；
  `attribution` 为空 ⇒ `source = "none"`。两者由导出侧**同源生成**；消费侧以 `attribution` 为权威
  （web 解析重算 `source`，不信任文件里的同名值）。于是"无对应"恒满足：`attribution: []` **且**
  `source: "none"` —— 这是**有数据的状态**（键存在），与"键不在表里"（旧文件 / 超范围物品）不同。
- **归属分层**（权威度由高到低；`attribution` 数组顺序即权威度）：
  ① **部件级** `part`：`PartRecord.items[0]` 命中 ⇒ `grid`（格下标 `[zSlice, row, column]`，与
  `cellGrid`/`cellPartsGrid` 同下标）+ `localId`（= `PartRecord.localId`，供部件级 mask）；
  ② **宿主级** `host`：方块自身物品身份（`Item.getItemFromBlock(block)` + damage，damage = 方块 meta，
  与既有 `new ItemStack(b, 1, vs.meta)` 同构造）⇒ 定位到格（只有 `grid`）。映射数据同时落盘到
  `blockPalette` 条目的 **`hostItem: { registry, damage }`**（无物品形态的方块字段缺席，不猜）；
  该层命中只对"已由层①建立索引项的键"枚举——同一 `(block, meta)` 恒同满方块判定，故某物品键的宿主格
  必为同方块同 meta 的部件格，枚举范围 = 进入部件采集的格；
  ③ **族特有** `family`：NBT/材料决定的对应（AE2 伪装板存被伪装方块、GT 机器物品、FMP 材料）：
  **本轮留扩展接口、不实现**（族规则注册表恒空）；后续实现只增来源值与归属条目，不动文件形状；
  ④ **兜底**——无规则命中 ⇒ 显式"无对应"（`attribution` 空 + 来源 `none`），**不猜**。
- **空值语义**：`tooltip` 为空时必须有可读兜底（至少 `display` 一行）；`display` 缺省 ⇒ 物品身份键本身；
  "无对应"是显式状态，不是缺数据。
- **与 `PartRecord.tooltip` 的分工**：各自保留、同源生成——两者都取部件在**宿主回退之前**的物品 tooltip
  （§8 第一优先级）；物品级说明**首见生效**去重（同一键跨格/跨帧只保留一份文案，避免同一物品两套文案），
  部件级说明服务视口悬停（§8 链），物品级说明服务左栏悬停；不做口径合并。
- **折叠/合并前提已消解**：统计规则能力已废弃（§9 决策 C），左栏行键恒等于物品身份键，
  本表查询不需要"折叠键 → 原始 iconKey"回退通道。
- **行键 = 物品身份键（结构性保证，B-3 定稿）**：本表键与左栏行键均由 `partItemKey(item)`
  （mod 侧 `PartItem.iconKey()`）**自同一字段生成**——行键由 `part.typeKey` 改为 `partItemKey(item)`，
  两者恒等**由代码路径保证**，不再依赖"部件身份恰好与 `typeKey` 重合"的不变量；`iconKey`/`partIconTextures`
  同步同键。据此 §9 "行键直通物品索引表"为结构性成立，而非巧合。
- **层③ 扩展接口形状（B-2 定稿，`ItemIndexIntegrator.AttributionRule`）**：族特有归属规则的接口形状与
  注册入口一并登记如下（**本轮注册表恒空**，导出行为与"没有层③"完全一致；落地族规则只增 `family` 来源的
  归属条目，不动文件形状）：
  - 嵌套接口 `ItemIndexIntegrator.AttributionRule`——`String family()`（规则标识，日志/探针留痕用）、
    `void attribute(Sink out, String itemKey, PartItem primary, PartRecord part, int zi, int ri, int ci)`
    （`out` = 该结构的物品索引汇聚器；`itemKey` = 主物品身份键；`primary` = `items[0]` 部件主物品；
    `part` = 部件记录；`zi/ri/ci` = 格下标）；
  - 规则经 `out.addFamilyAttribution(String itemKey, int zi, int ri, int ci, String localId)`
    （`localId` 可为 null）补 `source: "family"` 归属条目；
  - 注册/探针 API：`public static void registerRule(AttributionRule)`、`public static int ruleCount()`、
    `public static void clearRulesForProbe()`（生产路径不得调用）；规则抛异常被吞掉并跳过（§7.2 同口径）；
  - 类/文件：`mod/gtnh/src/main/java/com/lightning/mod/client/meshcapture/parts/ItemIndexIntegrator.java`
    （[#35](http://127.0.0.1:3300/Lightning/lightning/issues/35) / PR #43）。
- **已知键拼写漂移（指向 #48，不属本表形状）**：FMP 微方块 `nbtDiscriminator` 值的材料串形式与 web 侧行键
  取到的材料串形式可能不同 ⇒ 同一物品出现 `#mat=<A>`（本表键）与 `#mat=<B>`（行键）两套键、互查不到。
  已立跟进 [#48](http://127.0.0.1:3300/Lightning/lightning/issues/48)。分层归属与本节键生成口径不受影响。
- **附加物品条目（`items[i>0]`）**：本轮**不做独立说明与对应** ⇒ 仍建条目（左栏可能出行），
  但只带 `display` 兜底（= 该物品身份键）并显式 `source: "none"`；族规则落地后再补。
  （理由：#35 完成定义要求"给定任一左栏物品行键都能取到说明与（非空或显式为空的）归属"，
  而左栏行键集含附加条目键；不建条目会退化为"键不在表里"而非"显式无对应"。）
- **消费侧入口（web）**：`web/src/pure/itemIndex.ts` 的 `buildItemHitIndex(def)` 一次性建立
  "物品键 → 命中单元（部件 / 格）"反查索引（纯函数；**只从本表生成**，不从 `partLists`/`cellGrid`
  二次推导 —— 单一数据源硬约束）。

## 3. PartRecord schema（五要素 + 来源四元组）

```jsonc
{
  "localId": "ae2:UP",            // ① 格内定位（族内命名空间隔离，见 §4）
  "typeKey": "appliedenergistics2:item.ItemMultiPart:220",  // ② 跨格类型键（= 计数/合并键，见 §5）
  "boxes": [                       // ③ 空间盒（允许多子盒；坐标系见 §6）
    { "min": [0.375, 0.0, 0.0], "max": [0.625, 0.625, 0.3125], "kind": "visual" },
    { "min": [0.375, 0.0, 0.0], "max": [0.625, 0.625, 0.3125], "kind": "collision" }
  ],
  "displayName": "ME Storage Bus", // ④ 显示名（尊重游戏内显示名，硬约束）
  "tooltip": ["ME Storage Bus", "..."],  // ④ 说明行（按 §8 优先级链在导出时生成完毕）
  "items": [                       // ⑤ 物品身份（可合成物品；空数组 = 显式"无"）
    { "registry": "appliedenergistics2:item.ItemMultiPart", "damage": 220, "count": 1,
      "nbtDiscriminator": "mat=...",   // 可选：NBT 判别（FMP 材料串等；参与物品身份键）
      "display": "ME Storage Bus" }    // 可选：该物品条目的显示名（附加条目无部件级 displayName 时用；
                                       //   缺省 ⇒ web 以物品身份键作行 label）
  ],
  "source": {                      // 来源四元组
    "family": "ae2",               //   族：ae2 | eio | fmp | generic | inferred
                                   //   （实现统一前缀 `eio`；family=localId 前缀=开关族名三者同值自洽）
    "fallback": false,             //   是否兜底（族权威 = false；generic/inferred = true）
    "boxProvenance": "both",       //   视觉或碰撞：both | collision-derived-visual | visual-only | collision-only | degenerate（见 §6.4/§7.3）
    "tier": 1                      //   档位：1=族权威 2=通用盒 3=几何推断
  }
}
```

- 五要素缺一即契约违例（`items: []` 是"显式标无"，不是缺）。
- `properties`（proto 既有 map）保留为族特有补充信息的扩展点（如火把挂墙 meta、FMP 材料串），
  但**强契约字段不得藏进 properties**。

## 4. localId 命名空间（多族同格不冲突，本轮最高技术风险的契约解）

格式：`<族前缀>:<族内定位符>`。族前缀即 source.family。

| 族 | localId 形态 | 依据（实测） |
|----|--------------|------------------|
| ae2 | `ae2:<FACE>`（`NORTH`…`UP` 挂载面；中心线缆 `ae2:UNKNOWN`，与 AE2 枚举一致）；伪装板 `ae2:facade:<FACE>` | `getPart(ForgeDirection)` 枚举，facade 独立容器 |
| eio | `eio:<ConduitType 接口简单名>`（如 `eio:IPowerConduit`） | `getBaseConduitType()` |
| fmp | `fmp:slot<N>`（N = PartMap 0–26 规范槽位）；无槽部件 `fmp:part<枚举序号>` | `getSlot()`（27 槽由此承载，**不扩展 direction 枚举**，留白 #12 拍板） |
| generic | `generic:0`（单盒通用档一格一个部件） | 单盒档实现 |
| inferred | `inferred:<岛序号>`（几何推断岛） | 档 3 实现（移植既有 `aabb.ts` 岛扩组思路） |

同格多族合并时各带前缀 ⇒ 不可能冲突。族内重复（如 EnderIO 同型导管理论上一格一个）若出现，
追加 `#2`、`#3` 序号并在导出日志记录。

## 5. 类型键（typeKey）与物品身份（items）

**计数单位 = 可合成物品（硬约束）**。typeKey 由物品身份导出，规则按族（全部探针实证）：

| 族 | typeKey 构成 | 依据（实测） |
|----|--------------|------|
| ae2 | `registry:damage`（:16/:80/:220 同 item 不同 damage） | AE2 部件 API |
| eio | `registry:damage`（conduit subtype；连接器 conduitType==null 不是物品，**不发射部件**） | EnderIO conduit API |
| fmp | `registry:damage#mat=<材料串>`（同 damage 不同材料 = 不同物品；材料名是别名，权威身份 = NBT mat 串；`nbtDiscriminator` 字段值 = 同形键值串 `mat=<材料串>`，使物品身份键与 typeKey 一致） | FMP `PartMap`/`getDrops` |
| generic | **drop 身份**：`getItemDropped` registry + `damageDropped`（**不是**方块 meta——上/下半 slab 同为 `stone_slab:0`，朝向 meta 坍缩） | 原版 drop API |
| inferred | 宿主 drop 身份（推断档无更细信息） | 档 3 实现 |

- **一部件 ≠ 一物品**（硬约束可表达）：`items` 是数组。FMP size>1 微方块 `getDrops()` 拆多件
  （实测 size=4 slab 掉 2 件）→ 多条目/带 count；AE2 升级卡不从 `getItemStack` 出，若解析 NBT 得到
  则作为附加 items 条目（开放项）；EnderIO 连接器无物品 → 不发射（不是 `items: []`，而是
  不作为部件存在——它归属导管本体的盒）。
- `items: []`（显式无）仅用于：确认无对应可合成物品的部件（预留，本轮三族+单盒未出现实例）。

## 6. 盒坐标系与取盒纪律

### 6.1 统一空间（留白 #3 拍板）

**0–1 方块局部、MC 标准朝向（Y-up），与 web 侧一致**；三族与原版均可无损落入：

- AE2：原生 0–16 像素挂载面局部 ⇒ **复用 `BusCollisionHelper` 归一化**（px/16 + 基变换），
  禁止自做变换。
- EnderIO / FMP / 原版：原生即 0–1 方块局部；原版 `getSelectedBoundingBoxFromPool` 返回
  **世界坐标**，归一化 = 减格坐标（实测）。

### 6.2 取盒纪律（踩坑实证，违反即出陈旧盒）

1.7.10 基类 `getSelectedBoundingBoxFromPool`/`getCollisionBoundingBoxFromPool` **内部不调**
`setBlockBoundsBasedOnState`，直接读 Block 单例共享 bounds。**任何取盒前必须显式调**
`setBlockBoundsBasedOnState(world, x, y, z)`（游戏 `drawSelectionBox` 即如此）。

**碰撞多盒的 mask 必须放宽到整格上方 +1**（否则收不齐栅栏 1.5 高的杆）：

```java
AxisAlignedBB mask = AxisAlignedBB.getBoundingBox(x, y, z, x + 1, y + 2, z + 1);
block.addCollisionBoxesToList(world, x, y, z, mask, boxes, null);
```

`addCollisionBoxesToList` 只回传**与 mask 相交**的盒。四向连接栅栏的杆高达 **1.5**，
用整格 mask（`y..y+1`）会把上半段截掉、甚至整根丢失 ⇒ 多盒枚举不全 ⇒ 退化判定与"多盒是权威碰撞形态"
（§6.4）双双失效。两个实装点口径一致（探针与通用档各一处），改一处必须同时改另一处。

### 6.3 越界盒（留白 #13 拍板）

**允许超出 [0,1]³，如实记录，不裁剪**（实测：栅栏碰撞盒 maxY=1.5）。web 端命中判定与渲染
须容忍越界值（盒只用于悬停命中与统计，不进渲染网格）。

### 6.4 视觉盒与碰撞盒

两盒**都必须取**（探针三族+原版一致结论；只拿碰撞盒 = 像素级不一致的已知坑）。
`boxProvenance` 如实标记（**以代码实装为准**）：

| 来源 | 取值 |
|---|---|
| AE2 / FMP / 原版单盒档 | `both` |
| EnderIO | `collision-derived-visual`（单一几何源，视觉 = 碰撞 ×1.09 确定性推导） |
| 档 3 几何推断（含火把类落档 3） | `visual-only`（盒推断自视觉烘焙几何，无碰撞盒来源） |
| 档 3 无任何可用几何 | `degenerate`（整格推断盒兜底，§7.3） |

**`degenerate` 不是"火把类"的同义词**：火把类只是"档 2 不产出 ⇒ 落档 3"（§7.3），其 provenance 仍是
`visual-only`；`degenerate` 只在**档 3 连可用几何都没有**时出现（`InferredGeometryPartProvider` 的
整格盒兜底）。三处（本节 / §7.3 / §13 #14）按本表统一，不要再按旧口径引用。

## 7. 三档兜底流水线与合并规则

### 7.1 流水线（硬约束：永远降级，留白 #5 拍板）

```
格判定（§1 满方块？）─是→ 跳过（零开销）
   │否
   ▼
档 1 族权威：所有 applies 命中的 tier-1 提供者**全部执行、结果合并**（多族同格，§4 命名空间隔离）
   │ 任一部件产出？
   ├─是→ 完成（tier 标记 1；不再执行档 2/3）
   │否
   ▼
档 2 通用盒：原版 API 取盒（§6.2 纪律），零 mod 特定代码
   │ 有效结果？
   ├─是→ 完成（tier 2，family=generic，fallback=true）
   │否（§7.3 退化情形）
   ▼
档 3 几何推断：aabb.ts 思路的 mod 侧移植，永远有结果（tier 3，family=inferred，
   fallback=true，boxProvenance=visual-only / degenerate，标注已知误判"贴合部件并一"）
```

### 7.2 合并与容错（硬约束）

- 档 1 多提供者同格结果**合并**为一个部件列表（postrender 式"全命中都执行"语义）。
- 任何提供者抛异常/反射失败 ⇒ **捕获、记日志、静默跳过该提供者**，导出绝不中断；
  降级记录落盘（导出日志 + 受影响格的 source 标记）。
- `inferred` **永不当主来源**：档 1/档 2 有结果时档 3 不执行（验收断言锁定）。

### 7.3 退化情形（火把缺口，留白 #14 拍板）

火把类方块（`renderAsNormalBlock()=false` 且选择盒==整格且碰撞盒为 null/空）：档 2 **不产出**，
直接落档 3 几何推断（其选择盒是整格，作为"通用盒"产出既无信息又误导；真实小柱几何只在渲染代码
里，由推断档从烘焙几何取），此时 `boxProvenance = visual-only`。挂墙朝向等状态信息进
`properties`（如 `facing=meta1`）。**只有**档 3 拿不到任何可用几何时才产整格盒并标 `degenerate`
（§6.4）。

**原版 alpha 斜面真相（反编译 vanilla `renderTorchAtAngle` 实锤）**：火把类方块的四
个侧立面在 1.7.10 烘焙中本就画成**撑满整格的斜面四边形**，靠图标 PNG 的 alpha 透明像素裁剪只
显示细柱——捕获链与调色板无 bug。档 3 推断因此引入 **alpha 收紧**（`AlphaTightener`）：按材质
PNG alpha 掩码 + UV 仿射反算把四边形收紧到可见纹素区域后再算岛盒；不可收紧（多材质混合面/
TESR 动态层/磁盘无 PNG）⇒ 回退原始顶点盒（永远不更糟）。收紧后火把盒 = 棍柱量级（实证
`[0.3875,-0.05,0.3875→0.6125,0.675,0.6125]`）。岛扩组分组仍用原始顶点（aabb.ts 语义不动），
收紧只作用于盒计算。

## 8. 说明（tooltip）优先级链

**导出时生成完毕、落盘为最终行**（web 端只做展示选择，不重放生成逻辑）：

```
部件物品说明（部件 ItemStack.getTooltip，复用 MeshCaptureService L426–446 机制）
  → 部件自定义说明（族接口提供的专门文案，本轮三族无实例，预留）
  → 宿主回退（宿主方块 tooltip + 部件定位后缀，任何情况有话说）
```

web 侧逐格人工说明（`cellTooltipGrid`/`tooltipPalette`）保留为**叠加层**：有逐格说明时优先显示，
部件说明作为部件命中的回退——两条链不互相替代。物品级说明另走 §2.2 的 `itemIndex.tooltip`（同源生成、
首见生效去重）。

## 9. 统计默认值（已废弃 —— 部件轮·统计栏物品清单与部件级呈现决策 C）

> **【本节已被取代】** 原"三级配置 + JSON StatsRules"定型（文档默认 `statsTemplate` /
> 文档覆盖 `statsOverride` / 本机 localStorage 三层、字段级覆盖、十条规则键、
> 三视图语义）由里程碑 [部件轮·统计栏物品清单与部件级呈现](http://127.0.0.1:3300/Lightning/lightning/milestones) **决策 C 废止**。决策理由：
> 需求已变更为"左栏只展示物品"（[#6](http://127.0.0.1:3300/Lightning/lightning/issues/6)）；点选高亮（[#7](http://127.0.0.1:3300/Lightning/lightning/issues/7)）
> 要求行键直通物品索引表，而折叠/合并使行键 ≠ 物品身份键，给悬停说明与高亮归属两处
> 同时引入成员键集合的复杂度税；该能力无编辑 UI、零存量使用，保留代价与受益不对等。
>
> **新口径**：统计栏 = 纯物品清单——按物品身份键计数、数量口径 = 物品件数、固定排序
> （数量降序）、`items: []` 未计入提示；**无视图切换 UI、无规则能力、无宿主行**。
>
> **行键口径（B-3 起，结构性保证）**：左栏行键 = 物品身份键 `registry:damage[#nbt]`，且**由
> `partItemKey(item)` 直接生成**（mod 侧同源 `PartItem.iconKey()`）——行键 ≠ 物品身份键的折叠/合并
> 路径已随本节规则能力一并移除，故无"折叠键 → 原始键"回退通道，§2.2 的"任一左栏行键都能查到
> 说明与归属"由代码路径保证而非巧合（补充登记：[#36](http://127.0.0.1:3300/Lightning/lightning/issues/36) / PR #45）。
>
> **兼容口径（硬约束）**：旧文档携带的 `statsTemplate` / `statsOverride` 读取后
> **静默忽略**，不报错、不空栏；本机 `lightning:stats:v1:*` 键废弃（不再读写）；
> proto `StatsTemplate` / `StatsEntry.part_type_key` 字段保留线格式不删、**语义作废**。
>
> **取代范围**：本节全部、§10.2 中 StatsTemplate/StatsEntry 的语义、§13 留白 #6/#11，
> 以及治理前执行档案里"三视图/三级配置/规则能力/宿主清单可选保留"的交付描述。
> 原文见 git 历史（#51 治理前的 `docs/plan/format-parts-contract.md`）与 Gitea issue/PR。

## 10. proto 扩展与 Java 落盘（留白 #4/#10 拍板）

### 10.1 拍板：proto 作契约文档扩展；序列化维持两侧手写（Java Gson / TS 手写类型）

依据（实测）：mod 端零 protobuf 基建（构建无插件无依赖、Gson 手拼 JSON）；web 端解析器手写、
生成代码未被消费且未提交；`buf.gen.yaml` 仅 TS 插件。引入 Java 代码生成 = 为无消费者的新建构建
复杂度。**决策**：扩展 `plain_v2.proto` 作为规范 schema 文档；`npm run protocol:gen` 跑一次验证
可生成（不作提交物）；两侧手写实现与 proto 定义逐字段对齐。此口径替代治理前计划的工程纪律中
"protocol:gen 两端同步"的字面义（登记为裁决）。

### 10.2 proto 扩展形状

```proto
message BlockPart {
  string local_id = 1;                 // §4 命名空间形态
  string part_tag = 2;                 // 语义定稿 = typeKey（§5）；字段号/线格式不变
  int32 direction = 3;                 // 保留：AE2 面语义；FMP 槽位走 local_id（留白 #12）
  map<string, string> properties = 4;  // 族特有扩展点（§3）
  string tooltip = 5;                  // 说明首行/纯文本（完整行集走 JSON lines；proto 文档用途）
  repeated PartBox boxes = 6;          // 新增（§3③ §6）
  repeated PartItem items = 7;         // 新增（§3⑤ §5）
  string display_name = 8;             // 新增（§3④）
  PartSource source = 9;               // 新增（§3 来源四元组）
}
message PartBox { repeated double min = 1; repeated double max = 2; string kind = 3; }
message PartItem { string registry = 1; int32 damage = 2; string nbt_discriminator = 3; int32 count = 4; string display = 5; }
message PartSource { string family = 1; bool fallback = 2; string box_provenance = 3; int32 tier = 4; }
message StatsEntry {
  string block_state_id = 1;
  string label_override = 2;
  string icon_source = 3;
  string part_type_key = 4;            // 新增（§9）；§9 已废弃 ⇒ 字段保留线格式、语义作废
}
// 物品索引表（B-2，2026-10-04，§2.2）：仅作文档登记，不引入 Java 代码生成
message ItemIndexEntry {               // JSON: itemIndex[<物品身份键>]
  string display = 1;                  // JSON display（缺省回退 = 键本身）
  repeated string tooltip = 2;         // JSON tooltip（空 ⇒ 至少 display 一行）
  string source = 3;                   // JSON source："part" | "host" | "family" | "none"
  repeated ItemAttribution attribution = 4;  // JSON attribution（空数组 = 显式"无对应"）
}
message ItemAttribution {              // JSON: itemIndex[k].attribution[i]
  string source = 1;                   // "part" | "host" | "family"（层③本轮只留扩展接口）
  int32 frame = 2;                     // 帧下标（单文件 = 0；World = frames[i].index）
  repeated int32 grid = 3;             // [zSlice, row, column]（cellGrid/cellPartsGrid 同下标）
  string local_id = 4;                 // 仅 source="part"：格内部件定位
}
message HostItemIdentity {             // JSON: blockPalette[j].hostItem（层② 映射数据）
  string registry = 1;                 // Item.getItemFromBlock(block) 的注册名
  int32 damage = 2;                    // = 方块 meta
}
```

JSON 字段名按本契约 §3 的 camelCase 落盘（proto snake_case 为规范名，两侧手写实现各按其
语言习惯映射，映射表即本节两表）。`PartSource.family` 的落盘枚举值恒为
`ae2` / `eio` / `fmp` / `generic` / `inferred`（**proto 注释与旧文档里残留的 `enderio` 为历史写法，
一律按 `eio`**；§3/§4 的实现前缀同为 `eio`；字段号与线格式不变）。
`ItemIndexEntry`/`ItemAttribution`/`HostItemIdentity` 按本节形状定义，随
`feat/parts-b2-item-index` 落盘（`main` 尚未合入，见文件头"实现状态"）；生成物不入库（§10.1 口径）。

## 11. oracle JSON 格式（验收用：导出侧生成、验收侧消费）

```jsonc
{
  "schema": "lightning.parts-oracle/1",
  "structure": "parts-acceptance",
  "builtAtEpochMs": 0,
  "zones": ["full-cube", "single-box", "ae2", "enderio", "fmp", "overlay", "degraded", "variants"],
  "cells": [                     // 逐格期望（建造时已知的 ground truth）
    {
      "pos": [x, y, z],
      "host": "registry:meta",
      "expectFullCube": false,
      "parts": [
        { "localId": "ae2:UP", "typeKey": "...:220", "itemCount": 1,
          "boxTier": 1, "boxCount": 3, "boxProvenance": "both" }
      ]
    }
  ],
  "expectedCounts": [            // 按物品期望计数（统计断言基准）
    { "typeKey": "...", "display": "ME Glass Cable - Fluix", "count": 12 }
  ]
}
```

- ground truth 是建造的副产品（建造器知道放了什么），不靠人维护。
- **格映射通道**：导出文件 finalize 后不含 worldGrid ⇒ oracle 每格携带扩展字段
  `zone` + `grid: [zi, ri, ci]`（cellPartsGrid 下标），root 携带 `gridIndex: {origin, size, rowAxis}`——
  下游据此把 oracle pos 映射到导出文件下标，无需重算。
- **退化格哨兵语义**：退化档（＝**提供者开关关闭后重导出**的区，与 `boxProvenance="degenerate"` 不是
  同一个概念）的盒数/来源/档 3 岛序号静态不可预测 ⇒ 退化 oracle 对退化格使用哨兵值
  `boxCount=-1` / `boxProvenance="*"` / `localId="inferred:*"`（仍精确断言
  档位/族/fallback/typeKey）；退化轮 `expectedCounts` 只覆盖未退化格
  （root `countsScope=untransformed-cells-only`，验证器子集比对）。
- **幂等口径**：oracle `builtAtEpochMs` 恒写 0（跨轮字节一致）；真实时刻在运行结果文件。
- 盒数值本身**不进 oracle**（快照数值易受环境微扰）；oracle 断言 = 部件存在性 + localId/typeKey/
  物品计数 + 档位/盒数/来源；盒数值合理性由 L1 断言的范围校验（0–1 邻域、min<max、非退化）承担。
- 退化区（提供者开关关闭后重导出）oracle 由同一建造产物 + 期望档位变换生成。

**已知不确定源登记（实证）**：动画纹理物品图标（如 EnderIO 导管 .mcmeta 动画）的渲染帧随
游戏 tick 漂移 ⇒ `partIconTextures` 中动画图标的 base64 跨进程不确定。验收自动化在导出前把图集
动画精灵复位帧 0（限验收会话）保证幂等；长期方案（图标渲染确定性化）登记为开放项。
`BlockThumbnailRenderer` 对动画方块纹理有同款隐患（本结构未命中），一并登记。

## 12. 编辑语义（web 端，硬约束"不重算"的推论）

- 部件盒是导出时快照；web 端**任何编辑不触发盒重算**（无游戏逻辑可重放）。
- 删除宿主方块 ⇒ 其部件随之删除；移动方块 ⇒ 部件随宿主移动（盒可能因邻居变化而过期——
  如实呈现，不掩饰；刷新手段 = 重新导出）。
- 新建/手绘方块无部件数据 ⇒ 与旧文件行为一致（无 parts 即无部件）。
- round-trip：现有 paletteCache 机制会透传未知字段（实测），但 `cellPartsGrid`/`partLists`
  是根级新字段，web 侧必须显式实现其解析/序列化/编辑跟随，round-trip 无损（含 `_extra` 兜底）。
- §2.2 的 `itemIndex` 是文档根级新字段，同理须显式随编辑跟随（消费侧只读它，不从 `partLists` 二次推导）。

## 13. 留白拍板对照表（逐项闭环）

| # | 留白 | 拍板 | 位置 |
|---|------|------|------|
| 1 | 提供者契约形状 | PartProvider 接口 + Registry，postrender 式合并语义，§7 | §7 |
| 2 | localId 命名空间 | `<族>:<族内定位符>`，§4 表 | §4 |
| 3 | 统一盒坐标系 | 0–1 方块局部 Y-up | §6.1 |
| 4 | proto 扩展方案 | 字段号追加（boxes=6/items=7/display_name=8/source=9，part_type_key=4），线格式兼容旧生成代码 | §10.2 |
| 5 | 兜底默认取舍 | 永远降级（档 3 永远有结果），来源逐档标记 | §7.1 |
| 6 | 计数规则表达与三级配置存储 | **【已被取代：§9 决策 C】** ~~JSON StatsRules（非 DSL）；三级 = statsTemplate / statsOverride / localStorage；字段级覆盖+规则键整体替换~~ | §9 |
| 7 | 悬停/统计栏 UI 呈现细节 | 悬停优先级链仍有效（见 §8）；统计栏部分已由决策 C + [#5](http://127.0.0.1:3300/Lightning/lightning/issues/5)/[#6](http://127.0.0.1:3300/Lightning/lightning/issues/6)/[#7](http://127.0.0.1:3300/Lightning/lightning/issues/7) 取代——物品行悬停通道见 §2.2（B-4）；**选中态复用 `--selected` 数据位改集合语义（`selectedItemKeys`）+ 锚点强调条**、**"没有对应方块"提示 = 行内色点 + 会话提示行** 见留白 #19/#20 | §8/§9/§2.2 |
| 8 | 几何推断 mod 侧执行位置 | 已由 §7.1 的档 3 实现落定（`InferredGeometryPartProvider`） | §7.1 |
| 9 | 验收命令名与 oracle 目录 | 已由导出/验收对接落定（见 `scripts/parts-acceptance/`） | §11 |
| 10 | Java 落盘路径 | Gson 手写 + proto 作契约文档；protocol:gen 只验证可生成 | §10.1 |
| 11 | StatsEntry 部件键 | **【已被取代：§9 决策 C，proto 字段保留、语义作废】** | §9/§10.2 |
| 12 | FMP 27 槽位表达 | local_id 承载（`fmp:slot<N>`），不扩 direction 枚举 | §4 |
| 13 | 盒越界 | 允许，如实记录不裁剪 | §6.3 |
| 14 | 火把退化标记 | 档 2 不产出，落档 3（`boxProvenance=visual-only`）；`degenerate` = 档 3 **无任何可用几何**时的整格盒兜底，**非火把专属** | §6.4/§7.3 |
| 15 | 单盒计数键 | drop 身份（registry+damageDropped） | §5 |
| 16 | 部件图标落盘形状 | **已定稿**：文档根 `partIconTextures: {iconKey: base64PNG}`，仅含部件时写入；FMP 材料变体图标 = 基础物品图标（限制声明） | §2 |
| 17 | 原版 alpha 斜面几何（火把类） | **已定稿**：档 3 引入 alpha 收紧（AlphaTightener），不可收紧回退原始顶点盒；多材质/TESR 动态层不覆盖 | §7.3 |
| 18 | 物品索引表（`itemIndex`）的落盘形状与归属分层 | **已定稿（B-2，2026-10-04，[#35](http://127.0.0.1:3300/Lightning/lightning/issues/35) / PR #43）**：键 = 物品身份键；条目 `{display, tooltip, source, attribution[]}`；归属分层 part/host/family/none；层② 映射数据落 `blockPalette[].hostItem{registry,damage}`；层③ 仅留扩展接口（形状见 §2.2 `ItemIndexIntegrator.AttributionRule`）；**行键 = 物品身份键已为结构性保证（B-3：[#36](http://127.0.0.1:3300/Lightning/lightning/issues/36) / PR #45，行键由 `partItemKey(item)` 生成）** | §2.2 |
| 19 | 物品行选中态与多选语义（B-5） | **已定稿（B-5，2026-10-04，[#38](http://127.0.0.1:3300/Lightning/lightning/issues/38) / PR #49）**：选中态复用既有 `--selected` 数据位改集合语义（新 prop `selectedItemKeys: ReadonlySet<string>` 判定 `.nei-slot-row--selected` / `data-stats-selected`；旧路径单值 `selectedBlockId` 原样保留且不泄漏到物品行）；锚点行带强调条（`.nei-slot-row--anchor` + `data-stats-anchor`）；多选 = 经典文件选择语义（单击 / Ctrl / Shift / Ctrl+Shift / Esc·点空白清空；单击已选中行 = 单选该行不取消）；无对应项 = 行内色点标记（`.nei-slot-row--unresolved`）+ 会话提示行 `[data-stats-selection-notice]`（四类文案：无对应 / 归属不在当前帧 / 计划级截断 / 通道级收口 500）；相机聚焦本轮不做 | §2.2（键与归属）/§13 #20（提示行） |
| 20 | "没有对应方块"的呈现形式（B-5） | **已定稿（B-5，2026-10-04，[#38](http://127.0.0.1:3300/Lightning/lightning/issues/38) / PR #49）**：**行内色点 + 会话提示行（组合）**——行内 `.nei-slot-unresolved-dot`（6px 方形、`--nei-warn-text`、`title`/`aria-label` = "没有对应方块"，行加 `data-stats-unresolved="true"` + 左侧 2px 警示条，不改行内布局）；量的汇总走 `[data-stats-selection-notice]`（`role="status"`，侧栏行区顶部）。影响面：`BlockStatsSidebar` 新增 `itemIndex` / `selectionNotice` 两个 prop + 1 行 DOM + 行内 1 个 span；`EmbedViewport` 新增 1 个 computed；**旧文件路径零新增**（单测 + e2e 双向锁）。不塞进 TooltipBox 的理由：TooltipBox 是 hover 独占资源（B-4 正与物品说明共用） | §2.2/§13 #19 |

## 14. fixture（开发基座）

随本契约交付两份手工 fixture（V2 plain JSON，内容以真实探针数据为蓝本）：

| fixture | 内容 | 覆盖 |
|---------|------|------|
| `web/e2e/fixtures/parts-ae2-multibox.v2.json` | AE2 线缆总线格（中心线缆 + NORTH 切换总线 + UP 存储总线，盒取自实测）+ 相邻满方块 | 多部件格、命名空间、视觉/碰撞双盒、typeKey 含 damage |
| `web/e2e/fixtures/parts-singlebox-mix.v2.json` | 下半 slab + 上半 slab + 石头（满方块对照，无 parts）+ 栅栏（1.5 高碰撞盒） | 单盒档、满方块混存、越界盒、drop 身份计数键（上下半同键） |

fixture 的 geometry 字段从简（最小合法 bakedQuadsJsonV1，部件验收不依赖宿主几何保真），但**每个
部件盒内须有至少一个 raycast 可命中的面**（悬停 E2E 的物理可达性；验收实证后补全）；
fixture 被 web 解析器通过后本契约定稿生效。
