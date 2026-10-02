# 部件数据契约（P0.4 定稿）

> **地位**：本文件是「非满方块（部件）支持」的**单一数据源契约**——盒、说明、计数三方共用同一份部件数据。
> 依据《non-full-cube-parts-plan.md》§2 P0.4，综合 P0.1（现状）、P0.2（三族反射）、P0.3（单盒原版）
> 三份探针的实证结论拍板。凡与本契约冲突的实现以本契约为准；契约未覆盖处按 §13 留白表登记后扩展。
>
> **范围**：部件数据由 **`/sde export` 导出路径**（含游戏内自动化导出）产出；multiblock 文档本轮
> **不携带** parts（其调色板走 GeometryPalette 独立链路，留待未来立项）。文件中**无部件字段 = 行为与
> 今天完全一致**（向后兼容硬约束）。

---

## 1. 判定与快速否定

**满方块判定（P0.3 终版三条件，11/11 场景实证）**：

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

**核心事实（P0.3 实证）**：盒依赖邻居与方块状态（栅栏连接形态、箱子合并），是**逐格快照**——
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
- World 多帧格式：`BlockInstance.parts`（proto 已预留）直接挂同 schema 的 PartRecord 数组，
  不走池化（该格式本就逐实例展开）。

### 2.1 partLists 去重

同一部件列表（local id 序列 + 类型键 + 盒 + 物品身份全部一致）在多格出现时只存一份
（内容签名去重，复用既有 `fullEqualitySignature` 思路）。典型命中：N 个孤立同向箱子、N 个同形态
导管束格。签名输入含盒数值（盒是快照，签名天然区分邻居形态）。**不做**跨版本/跨文件稳定性承诺。

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
                                       //   缺省 ⇒ web 以物品身份键作行 label——P2.3 裁决登记）
  ],
  "source": {                      // 来源四元组
    "family": "ae2",               //   族：ae2 | enderio | fmp | generic | inferred
    "fallback": false,             //   是否兜底（族权威 = false；generic/inferred = true）
    "boxProvenance": "both",       //   视觉或碰撞：both | collision-derived-visual | visual-only | collision-only | degenerate
    "tier": 1                      //   档位：1=族权威 2=通用盒 3=几何推断
  }
}
```

- 五要素缺一即契约违例（`items: []` 是"显式标无"，不是缺）。
- `properties`（proto 既有 map）保留为族特有补充信息的扩展点（如火把挂墙 meta、FMP 材料串），
  但**强契约字段不得藏进 properties**。

## 4. localId 命名空间（多族同格不冲突，本轮最高技术风险的契约解）

格式：`<族前缀>:<族内定位符>`。族前缀即 source.family。

| 族 | localId 形态 | 依据（探针实证） |
|----|--------------|------------------|
| ae2 | `ae2:<FACE>`（`NORTH`…`UP` 挂载面；中心线缆 `ae2:UNKNOWN`，与 AE2 枚举一致）；伪装板 `ae2:facade:<FACE>` | P0.2 §1：`getPart(ForgeDirection)` 枚举，facade 独立容器 |
| enderio | `eio:<ConduitType 接口简单名>`（如 `eio:IPowerConduit`） | P0.2 §2：`getBaseConduitType()` |
| fmp | `fmp:slot<N>`（N = PartMap 0–26 规范槽位）；无槽部件 `fmp:part<枚举序号>` | P0.2 §3：`getSlot()`（27 槽由此承载，**不扩展 direction 枚举**，留白 #12 拍板） |
| generic | `generic:0`（单盒通用档一格一个部件） | P0.3 |
| inferred | `inferred:<岛序号>`（几何推断岛） | P1.6 移植 aabb.ts 岛扩组 |

同格多族合并时各带前缀 ⇒ 不可能冲突。族内重复（如 EnderIO 同型导管理论上一格一个）若出现，
追加 `#2`、`#3` 序号并在导出日志记录。

## 5. 类型键（typeKey）与物品身份（items）

**计数单位 = 可合成物品（硬约束）**。typeKey 由物品身份导出，规则按族（全部探针实证）：

| 族 | typeKey 构成 | 依据 |
|----|--------------|------|
| ae2 | `registry:damage`（:16/:80/:220 同 item 不同 damage） | P0.2 §1.4 |
| enderio | `registry:damage`（conduit subtype；连接器 conduitType==null 不是物品，**不发射部件**） | P0.2 §2.4/2.5 |
| fmp | `registry:damage#mat=<材料串>`（同 damage 不同材料 = 不同物品；材料名是别名，权威身份 = NBT mat 串） | P0.2 §3.4/3.5 |
| generic | **drop 身份**：`getItemDropped` registry + `damageDropped`（**不是**方块 meta——上/下半 slab 同为 `stone_slab:0`，朝向 meta 坍缩） | P0.3 §5 |
| inferred | 宿主 drop 身份（推断档无更细信息） | — |

- **一部件 ≠ 一物品**（硬约束可表达）：`items` 是数组。FMP size>1 微方块 `getDrops()` 拆多件
  （实测 size=4 slab 掉 2 件）→ 多条目/带 count；AE2 升级卡不从 `getItemStack` 出，若解析 NBT 得到
  则作为附加 items 条目（P1.3 开放项）；EnderIO 连接器无物品 → 不发射（不是 `items: []`，而是
  不作为部件存在——它归属导管本体的盒，见 P0.2 §2.5）。
- `items: []`（显式无）仅用于：确认无对应可合成物品的部件（预留，本轮三族+单盒未出现实例）。

## 6. 盒坐标系与取盒纪律

### 6.1 统一空间（留白 #3 拍板）

**0–1 方块局部、MC 标准朝向（Y-up），与 web 侧一致**；三族与原版均可无损落入：

- AE2：原生 0–16 像素挂载面局部 ⇒ **复用 `BusCollisionHelper` 归一化**（px/16 + 基变换），
  禁止自做变换（P0.2 §1.2）。
- EnderIO / FMP / 原版：原生即 0–1 方块局部；原版 `getSelectedBoundingBoxFromPool` 返回
  **世界坐标**，归一化 = 减格坐标（P0.3 §2.2 实证）。

### 6.2 取盒纪律（P0.3 踩坑实证，违反即出陈旧盒）

1.7.10 基类 `getSelectedBoundingBoxFromPool`/`getCollisionBoundingBoxFromPool` **内部不调**
`setBlockBoundsBasedOnState`，直接读 Block 单例共享 bounds。**任何取盒前必须显式调**
`setBlockBoundsBasedOnState(world, x, y, z)`（游戏 `drawSelectionBox` 即如此）。

### 6.3 越界盒（留白 #13 拍板）

**允许超出 [0,1]³，如实记录，不裁剪**（实测：栅栏碰撞盒 maxY=1.5）。web 端命中判定与渲染
须容忍越界值（盒只用于悬停命中与统计，不进渲染网格）。

### 6.4 视觉盒与碰撞盒

两盒**都必须取**（探针三族+原版一致结论；只拿碰撞盒 = 像素级不一致的已知坑）。
`boxProvenance` 如实标记：AE2/FMP/原版 = `both`；EnderIO = `collision-derived-visual`
（单一几何源，视觉 = 碰撞 ×1.09 确定性推导）；火把类退化 = `degenerate`（见 §7.3）。

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
档 2 通用盒（P1.2）：原版 API 取盒（§6.2 纪律），零 mod 特定代码
   │ 有效结果？
   ├─是→ 完成（tier 2，family=generic，fallback=true）
   │否（§7.3 退化情形）
   ▼
档 3 几何推断（P1.6）：aabb.ts 思路的 mod 侧移植，永远有结果（tier 3，family=inferred，
   fallback=true，标注已知误判"贴合部件并一"）
```

### 7.2 合并与容错（硬约束）

- 档 1 多提供者同格结果**合并**为一个部件列表（postrender 式"全命中都执行"语义）。
- 任何提供者抛异常/反射失败 ⇒ **捕获、记日志、静默跳过该提供者**，导出绝不中断；
  降级记录落盘（导出日志 + 受影响格的 source 标记）。
- `inferred` **永不当主来源**：档 1/档 2 有结果时档 3 不执行（P3.3 断言锁定）。

### 7.3 退化情形（P0.3 火把缺口，留白 #14 拍板）

火把类方块（`renderAsNormalBlock()=false` 且选择盒==整格且碰撞盒为 null/空）：档 2 **不产出**，
直接落档 3 几何推断（其选择盒是整格，作为"通用盒"产出既无信息又误导；真实小柱几何只在渲染代码
里，由推断档从烘焙几何取）。挂墙朝向等状态信息进 `properties`（如 `facing=meta1`）。

## 8. 说明（tooltip）优先级链

**导出时生成完毕、落盘为最终行**（web 端只做展示选择，不重放生成逻辑）：

```
部件物品说明（部件 ItemStack.getTooltip，复用 MeshCaptureService L426–446 机制）
  → 部件自定义说明（族接口提供的专门文案，本轮三族无实例，预留）
  → 宿主回退（宿主方块 tooltip + 部件定位后缀，任何情况有话说）
```

web 侧逐格人工说明（`cellTooltipGrid`/`tooltipPalette`）保留为**叠加层**：有逐格说明时优先显示，
部件说明作为部件命中的回退——两条链不互相替代（详见 P2.2 实现契约）。

## 9. 统计默认值与 StatsEntry 扩展（留白 #11 拍板）

- 文档级默认写入 `statsTemplate`（挂到 V2 plain 文档根；proto `StatsTemplate` 已预留，
  web `V2PlainSceneDocument` 补挂载——P2.3 范围）：默认 = **部件物品清单视图**（typeKey 分组计数）。
- `StatsEntry` 增加可选 `part_type_key` 字段：部件视图的条目键 = typeKey；宿主视图的条目键沿用
  `block_state_id`。
- **三级配置存储（留白 #6 由 P2.3 定稿，登记）**：① 文档默认 = 文件内 `statsTemplate`（camelCase
  落盘权威，snake_case 仅旧数据读取回退；mode auto=部件视图 / custom=显式分组）；② 文档覆盖 =
  **新增可选根字段 `statsOverride`**（camelCase，形状 = StatsRules 层 JSON；随 `_extra` 兜底机制
  round-trip，写回由统计栏 UI 触发）；③ 查看者本地 = localStorage `lightning:stats:v1:<docId>`
  （schema 字段备迁移）。合并 = 字段级覆盖（本地 > 覆盖 > 默认 > 内建），规则键整体替换不深合并；
  逐字段来源（provenance）对 UI 可见（"默认值来自文档"这一事实必须可呈现）。
- **多帧 World 格式**：本轮只定义文档根级 `statsTemplate`；帧级统计配置不支持（登记为开放项）。
- 规则表达能力（分组键粒度/忽略表/系数换算/别名合并/宿主行开关/排序与分组标题）的 JSON 形状
  以 `web/src/pure/partStats.ts` 文件头登记为准（留白 #6 的实现侧全文）。

## 10. proto 扩展与 Java 落盘（留白 #4/#10 拍板）

### 10.1 拍板：proto 作契约文档扩展；序列化维持两侧手写（Java Gson / TS 手写类型）

依据（P0.1 实证）：mod 端零 protobuf 基建（构建无插件无依赖、Gson 手拼 JSON）；web 端解析器手写、
生成代码未被消费且未提交；`buf.gen.yaml` 仅 TS 插件。引入 Java 代码生成 = 为无消费者的新建构建
复杂度。**决策**：扩展 `plain_v2.proto` 作为规范 schema 文档；`npm run protocol:gen` 跑一次验证
可生成（不作提交物）；两侧手写实现与 proto 定义逐字段对齐。此口径替代计划 §6 工程纪律中
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
message PartItem { string registry = 1; int32 damage = 2; string nbt_discriminator = 3; int32 count = 4; }
message PartSource { string family = 1; bool fallback = 2; string box_provenance = 3; int32 tier = 4; }
message StatsEntry {
  string block_state_id = 1;
  string label_override = 2;
  string icon_source = 3;
  string part_type_key = 4;            // 新增（§9）
}
```

JSON 字段名按本契约 §3 的 camelCase 落盘（proto snake_case 为规范名，两侧手写实现各按其
语言习惯映射，映射表即本节两表）。

## 11. oracle JSON 格式（验收用，P1.8 生成、P2.5/P3.1 消费）

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
- 盒数值本身**不进 oracle**（快照数值易受环境微扰）；oracle 断言 = 部件存在性 + localId/typeKey/
  物品计数 + 档位/盒数/来源；盒数值合理性由 L1 断言的范围校验（0–1 邻域、min<max、非退化）承担。
- 退化区（提供者开关关闭后重导出）oracle 由同一建造产物 + 期望档位变换生成。

## 12. 编辑语义（web 端，硬约束"不重算"的推论）

- 部件盒是导出时快照；web 端**任何编辑不触发盒重算**（无游戏逻辑可重放）。
- 删除宿主方块 ⇒ 其部件随之删除；移动方块 ⇒ 部件随宿主移动（盒可能因邻居变化而过期——
  如实呈现，不掩饰；刷新手段 = 重新导出）。
- 新建/手绘方块无部件数据 ⇒ 与旧文件行为一致（无 parts 即无部件）。
- round-trip：现有 paletteCache 机制会透传未知字段（P0.1 实证），但 `cellPartsGrid`/`partLists`
  是根级新字段，P2.1 必须显式实现其解析/序列化/编辑跟随，round-trip 无损（含 `_extra` 兜底）。

## 13. 留白拍板对照表（计划 §9 逐项闭环）

| # | 留白 | 拍板 | 位置 |
|---|------|------|------|
| 1 | 提供者契约形状 | PartProvider 接口 + Registry，postrender 式合并语义，§7 | §7 |
| 2 | localId 命名空间 | `<族>:<族内定位符>`，§4 表 | §4 |
| 3 | 统一盒坐标系 | 0–1 方块局部 Y-up | §6.1 |
| 4 | proto 扩展方案 | 字段号追加（boxes=6/items=7/display_name=8/source=9，part_type_key=4），线格式兼容旧生成代码 | §10.2 |
| 5 | 兜底默认取舍 | 永远降级（档 3 永远有结果），来源逐档标记 | §7.1 |
| 6 | 计数规则表达与三级配置存储 | **已定稿（P2.3）**：JSON StatsRules（非 DSL）；三级 = statsTemplate / statsOverride / localStorage；字段级覆盖+规则键整体替换 | §9 |
| 7 | 悬停/统计 UI 呈现细节 | → P2.2/P2.4 拍板登记 | §8/§9 |
| 8 | 几何推断 mod 侧执行位置 | → P1.6 拍板登记 | §7.1 |
| 9 | 验收命令名与 oracle 目录 | → P1.8+P2.5 对接拍板 | §11 |
| 10 | Java 落盘路径 | Gson 手写 + proto 作契约文档；protocol:gen 只验证可生成 | §10.1 |
| 11 | StatsEntry 部件键 | 新增 `part_type_key` 可选字段 | §9/§10.2 |
| 12 | FMP 27 槽位表达 | local_id 承载（`fmp:slot<N>`），不扩 direction 枚举 | §4 |
| 13 | 盒越界 | 允许，如实记录不裁剪 | §6.3 |
| 14 | 火把退化标记 | 档 2 不产出，落档 3；boxProvenance=degenerate 预留给档 2 边界情形 | §7.3 |
| 15 | 单盒计数键 | drop 身份（registry+damageDropped） | §5 |

## 14. fixture（P2 开发基座）

随本契约交付两份手工 fixture（V2 plain JSON，内容以 P0.2/P0.3 真实探针数据为蓝本）：

| fixture | 内容 | 覆盖 |
|---------|------|------|
| `web/e2e/fixtures/parts-ae2-multibox.v2.json` | AE2 线缆总线格（中心线缆 + NORTH 切换总线 + UP 存储总线，盒取自 p02-run-2 实测）+ 相邻满方块 | 多部件格、命名空间、视觉/碰撞双盒、typeKey 含 damage |
| `web/e2e/fixtures/parts-singlebox-mix.v2.json` | 下半 slab + 上半 slab + 石头（满方块对照，无 parts）+ 栅栏（1.5 高碰撞盒） | 单盒档、满方块混存、越界盒、drop 身份计数键（上下半同键） |

fixture 的 geometry 字段从简（最小合法 bakedQuadsJsonV1，部件验收不依赖宿主几何保真）；
fixture 被 P2.1 解析通过后本契约定稿生效。
