# P0.3 单盒通用路径验证 —— 结果报告

> **任务**：《non-full-cube-parts-plan.md》§2 P0.3。验证「盒 ≠ 整格」判定 + 原版 API 在
> **零 mod 特定代码**下覆盖 slab（上/下半）、火把、箱子、栅栏的盒、说明、计数。
> **全部结论附真实运行的探针输出**（运行方式与输出位置见 §6），三轮迭代运行，不是纸上阅读。
>
> **探针代码**（复用 P0.2 基建，新增/最小扩展）：
> `mod/gtnh/src/main/java/com/lightning/mod/client/meshcapture/parts/probe/SingleBoxProbe.java`（新增，
> 判定函数 + 三种盒 + 物品身份，纯原版编译期 API 客户端读取）；
> `PartsProbePlacement#placeSingleBox`（新增 11 场景放置，纯 `world.setBlock(x,y,z,block,meta,3)`）；
> `PartsProbeAutomation`（新增触发标志 `singleBox` + 探针分支 + 必收族条件化，**默认关闭，
> 不带 `-SingleBox` 的 P0.2 行为逐字节不变**）；
> `run-parts-probe.ps1`（新增 `-SingleBox` 开关，写入触发文件 `singleBox=true`）。
>
> **运行记录**：
>
> | 运行 | 退出码 | 结果 |
> |------|--------|------|
> | p03-run-1 | 0（singlebox 7/11） | 发现 1.7.10 取盒纪律坑（§2.1）：选择/碰撞单盒内部**不**调 `setBlockBoundsBasedOnState`，拿到共享单例陈旧 bounds（相邻两 slab 盒互串、栅栏盒滞后一格） |
> | p03-run-2 | 0（singlebox 9/11） | 修正调用纪律后盒值全部正确；发现「选择盒+碰撞盒」判定仍误判四向栅栏（§1.2） |
> | **p03-run-3** | **0（singlebox 10/11）** | **终版判定全对**：石头=整格（快速否定），其余 10 格全部判为非满且盒正确；errors[] 全空 |

（10/11 即满分：11 格中石头对照格 partCount=0 是判定函数的正确输出，不是失败。）

---

## 1. 判定函数结论

### 1.1 终版判定（p03-run-3 实证，11/11 场景正确）

```java
boolean isFullCube(Block block, World world, int x, int y, int z) {
    block.setBlockBoundsBasedOnState(world, x, y, z);              // 1.7.10 纪律：必须先调（§2.1）
    AxisAlignedBB sel = block.getSelectedBoundingBoxFromPool(world, x, y, z);
    block.setBlockBoundsBasedOnState(world, x, y, z);
    AxisAlignedBB col = block.getCollisionBoundingBoxFromPool(world, x, y, z);
    return block.renderAsNormalBlock()                              // 条件①
        && equalsBox(sel, x, y, z, x+1, y+1, z+1)                   // 条件②：视觉盒 == 整格
        && equalsBox(col, x, y, z, x+1, y+1, z+1);                  // 条件③：碰撞盒 == 整格（null ⇒ false）
}
```

实测判定矩阵（p03-run-3 dump 原值）：

| 场景 | ① renderAsNormalBlock | ② 选择盒==整格 | ③ 碰撞盒==整格 | **终版判定** | 期望 |
|------|:---:|:---:|:---:|:---:|:---:|
| 石头（对照） | ✅ | ✅ | ✅ | **整格** ✅ | 整格（快速否定路径成立） |
| 下半 slab (meta 0) | ❌ | ❌ | ❌ | 非满 ✅ | 非满 |
| 上半 slab (meta 8) | ❌ | ❌ | ❌ | 非满 ✅ | 非满 |
| 地面火把 (meta 5) | ❌ | **✅ ⚠** | ❌（null） | 非满 ✅ | 非满 |
| 挂墙火把 (meta 1) | ❌ | **✅ ⚠** | ❌（null） | 非满 ✅ | 非满 |
| 栅栏·孤立 | ❌ | ❌ | ❌ | 非满 ✅ | 非满 |
| 栅栏·东西连 | ❌ | ❌ | ❌ | 非满 ✅ | 非满 |
| 栅栏·四向连 | ❌ | **✅ ⚠** | **✅ ⚠** | 非满 ✅ | 非满 |
| 箱子·单 | ❌ | ❌ | ❌ | 非满 ✅ | 非满 |
| 箱子·双（西/东） | ❌ | ❌ | ❌ | 非满 ✅ | 非满 |

### 1.2 两个更松变体的实测反例（为什么三条件缺一不可）

- **变体 A（仅选择盒）**：火把被误判为整格。MC1.7.10 的 `BlockTorch` **不覆写 bounds**——其选择盒
  就是整格 `[0,0,0→1,1,1]`（实测 `blockBoundsLocal` 在显式 `setBlockBoundsBasedOnState` 后仍是整格；
  游戏内 1.7.10 火把的线框高亮确实是整格）。靠碰撞盒（火把返回 `null`）或条件①排除。
- **变体 B（选择盒+碰撞盒）**：四向连接栅栏被误判为整格。其 `setBlockBoundsBasedOnState` 把
  x/z 都撑到 0→1，碰撞单盒也是整格（实测 `sel=[0,0,0,1,1,1]`、`colS=[0,0,0,1,1,1]`），
  但它的碰撞**多盒**是 2 根 1.5 高的杆。靠条件①（fence 的 `renderAsNormalBlock()=false`）排除。
- 条件①不会误伤透明满方块：玻璃/荧石类 `renderAsNormalBlock()=true`（源码基类行为），
  盒判定时仍走整格路径。`isOpaqueCube()` 也能排除火把/栅栏，但会把玻璃类误判为非满（假阴性，
  安全但多余）；`renderAsNormalBlock` 是更准确的"常规方块形状"判别器。

### 1.3 备选更严判定（记录备查）

「多盒枚举 == 恰好 1 个整格盒」也能正确分类全部 11 场景（火把多盒 0 个、四向栅栏 2 个），
但 `addCollisionBoxesToList` 要枚举列表，比三条件重，不适合快速否定路径。**推荐终版三条件。**

---

## 2. 原版 API 取盒结论（MC1.7.10 锚点）

### 2.1 ⚠ 取盒调用纪律（p03-run-1 踩出来的坑，P1.2 提供者必须遵守）

**`getSelectedBoundingBoxFromPool` 与 `getCollisionBoundingBoxFromPool`（基类版）内部不调
`setBlockBoundsBasedOnState`——它们直接读 Block 单例当前的 `minX..maxZ` 字段。** bounds 是
全类共享的可变状态，谁最后设置就是谁的值。p03-run-1 的实测惨状：相邻两 slab 的选择盒互相
串位（下半 slab 拿到上半盒）、栅栏选择盒滞后一个探针格、箱子拿到上一次游戏碰撞计算留下的
合并盒。游戏自己的 `drawSelectionBox` 就是先显式调 `setBlockBoundsBasedOnState(world,x,y,z)`
再取盒。**⇒ 提供者与判定函数必须在每次取盒前显式调 `setBlockBoundsBasedOnState`**（探针已封装
`selectedBox()/collisionBox()` 两个带纪律的入口）。

例外：`BlockFence#getCollisionBoundingBoxFromPool` 等部分覆写版内部会自己调——但统一先调无害。

### 2.2 坐标系（实测验证）

- **`getSelectedBoundingBoxFromPool` 返回世界坐标盒**：石头对照格实测 `[66,12,67 → 67,13,68]`
  = (x,y,z)→(x+1,y+1,z+1)，与格坐标精确吻合 ⇒ 归一化 = 减格坐标，假设验证成立。
- `getCollisionBoundingBoxFromPool` 同为世界坐标（火把返回 `null`）。
- `addCollisionBoxesToList` 产出的也是世界坐标盒；mask 参数是与盒做相交过滤的掩码，
  **要放宽到整格上方+1**（`[x,y,z→x+1,y+2,z+1]`），否则栅栏 1.5 高的盒会被过滤掉。
- **碰撞盒可以超出格界**：栅栏碰撞盒高 1.5（实测 maxY=1.5，契约须允许 >1 值或明确裁剪策略
  ——留白，P0.4 拍板；探针归一化时不裁剪、如实记录）。

### 2.3 四代表方块的三种盒（p03-run-3 实测，0–1 方块局部归一化，Y-up）

| 场景 | 视觉盒（selected） | 碰撞单盒 | 碰撞多盒（数量） |
|------|------|------|------|
| 石头（对照） | `[0,0,0 → 1,1,1]` | `[0,0,0 → 1,1,1]` | 同左 ×1 |
| 下半 slab (meta 0) | `[0,0,0 → 1,0.5,1]` | 同左 | 同左 ×1 |
| 上半 slab (meta 8) | `[0,0.5,0 → 1,1,1]` | 同左 | 同左 ×1 |
| 地面火把 (meta 5) | **`[0,0,0 → 1,1,1]`（整格！）** | **`null`（无碰撞）** | **×0（空）** |
| 挂墙火把 (meta 1) | 同上（整格） | `null` | ×0（空） |
| 栅栏·孤立 | `[0.375,0,0.375 → 0.625,1,0.625]` | 同左 | `[0.375,0,0.375 → 0.625,1.5,0.625]` ×1 |
| 栅栏·东西连（三连之中） | `[0,0,0.375 → 1,1,0.625]` | 同左 | `[0,0,0.375 → 1,1.5,0.625]` ×1 |
| 栅栏·四向连（十字中心） | **`[0,0,0 → 1,1,1]`（整格！）** | **`[0,0,0 → 1,1,1]`（整格！）** | `[0.375,0,0 → 0.625,1.5,1]`（南北杆）+ `[0,0,0.375 → 1,1.5,0.625]`（东西杆）**×2** |
| 箱子·单 | `[0.0625,0,0.0625 → 0.9375,0.875,0.9375]` | 同左 | 同左 ×1 |
| 箱子·双（西半） | `[0.0625,0,0.0625 → 1,0.875,0.9375]` | 同左 | 同左 ×1 |
| 箱子·双（东半） | `[0,0,0.0625 → 0.9375,0.875,0.9375]` | 同左 | 同左 ×1 |

1.7.10 栅栏多盒逻辑（实测反推，与源码语义一致）：有南/北连接 ⇒ 加南北杆；有东/西连接
**或**南北皆无 ⇒ 加东西杆/中心柱。孤立=1 盒（柱）、单向连=1 盒（杆）、四向=2 盒（两杆，无独立柱盒）。

### 2.4 视觉盒 vs 碰撞盒

本组方块中：slab/箱子两者一致；栅栏「多盒高度 1.5 vs 选择盒高度 1.0」不同；火把两个极端
（视觉=整格、碰撞=无）。⇒ **三种盒都要取**，与 P0.2 三族结论一致。另注：栅栏选择盒（视觉）
不随 1.5 碰撞高度走，游戏内高亮线框确实只到 1.0。

---

## 3. 邻居/状态依赖证据（「盒 = 导出时快照」的核心论据）

### 3.1 栅栏三场景（同一个 `minecraft:fence`，仅邻居不同）

| 场景 | 视觉盒（0–1 局部） | 碰撞多盒数 | 多盒内容 |
|------|------|:---:|------|
| 孤立一根 | `[0.375,0,0.375 → 0.625,1,0.625]` | 1 | 中心柱（高 1.5） |
| 东西各接一根（三连之中） | x 向撑满：`[0,0,0.375 → 1,1,0.625]` | 1 | 东西杆 |
| 四向连接（十字中心） | **整格** `[0,0,0 → 1,1,1]` | **2** | 南北杆 + 东西杆 |

盒形状、盒数量都随邻居实时变化 ⇒ 同一方块在不同邻居形态下必须导出不同的盒，**盒只能是导出时
快照，web 端不得重算**（§8.2 论据成立）。且「四向栅栏选择盒=整格」同时证明：仅看选择盒会把它
错当满方块（§1.2 变体 B 反例）。

### 3.2 箱子两场景（相邻同向两箱自动合并）

| 场景 | 视觉盒 = 碰撞盒（0–1 局部） |
|------|------|
| 单箱 | `[0.0625,0,0.0625 → 0.9375,0.875,0.9375]`（四边内缩 1/16，高 7/8） |
| 双箱西半 | maxX 撑到格界：`[0.0625,0,0.0625 → 1,0.875,0.9375]` |
| 双箱东半 | minX 撑到格界：`[0,0,0.0625 → 0.9375,0.875,0.9375]` |

合并方向一侧的内缩消失 ⇒ 盒随邻居变化。注：放置时写 meta=2，探针读到 meta=3——
`BlockChest.onBlockAdded/unifyAdjacentChests` 会按周边不透明方块自动校正朝向 meta，
**方块 meta 本身也是世界状态的产物**，导出应读世界实际 meta（探针即是）。

### 3.3 slab / 火把（meta 驱动的状态变体）

- 下半 slab（meta 0）`[0,0,0→1,0.5,1]` vs 上半 slab（meta 8）`[0,0.5,0→1,1,1]`：
  meta bit 3（值 8）= 上下半标志，盒随 meta 翻转。
- 火把地面（meta 5）与挂墙（meta 1–4）：**三种盒无任何差异**（选择盒都是整格、碰撞都是空），
  朝向信息完全不在盒里（详见 §4 火把缺口）。

---

## 4. 缺口记录（P1.2/P0.4 须知）

1. **火把几何缺口（本探针最重要发现之一）**：1.7.10 `BlockTorch` 不设 bounds——原版三种盒 API
   对火把只能给出「整格视觉盒 + 无碰撞」，**真实的火把小柱几何（约 [0.4,0,0.4→0.6,0.6,0.6]）
   只存在于渲染代码里**。P1.2 通用盒档对火把只能落「选择盒=整格」或转交 P1.6 几何推断档。
   建议契约侧明确：单盒通用提供者对"选择盒==整格但 renderAsNormalBlock==false"的方块标记
   来源为「通用盒（退化）」，由 P1.6 推断档补精确几何。
2. **栅栏碰撞盒超格界**（maxY=1.5）：契约须允许部件盒超出 [0,1]³ 或规定裁剪（P0.4 留白）。
3. **火把朝向不可从盒恢复**：挂墙朝向（meta 1–4）需从方块 meta 另存（部件 local id/properties
   可承载），盒本身无差异。

---

## 5. 物品身份 / 显示名 / meta 变体结论

实测（p03-run-3 dump 原值）：

| 场景 | `new ItemStack(block,1,meta)` | `getItemDropped`+`damageDropped` |
|------|------|------|
| 石头 | `minecraft:stone:0` 'Stone' | `minecraft:cobblestone:0` 'Cobblestone'（掉落≠方块物品，石头特例） |
| 下半 slab (meta 0) | `minecraft:stone_slab:0` 'Stone Slab' | `minecraft:stone_slab:0` 'Stone Slab' |
| 上半 slab (meta 8) | `minecraft:stone_slab:8` 'Stone Slab' | `minecraft:stone_slab:0` 'Stone Slab' |
| 地面火把 (meta 5) | `minecraft:torch:5` 'Torch' | `minecraft:torch:0` 'Torch' |
| 挂墙火把 (meta 1) | `minecraft:torch:1` 'Torch' | `minecraft:torch:0` 'Torch' |
| 栅栏（全场景） | `minecraft:fence:0` 'Fence' | 同左 |
| 箱子（全场景） | `minecraft:chest:3` 'Chest' | `minecraft:chest:0` 'Chest' |

结论：

1. **此类方块物品身份 = 方块物品本身，显示名直接可得**（'Stone Slab'/'Torch'/'Chest'/'Fence'），
   计划假设成立。
2. **上/下半 slab 是同 item 不同方块状态，不是物品变体**：`damageDropped(meta)=meta&7`，
   上半（meta 8）与下半（meta 0）的掉落身份都是 `stone_slab:0` ⇒ 计数口径（可合成物品）下
   **两者计为同一物品**；「上半/下半」只是方块状态，计数键应取 **drop 身份
   （registry + damageDropped）而不是原始方块 meta**。
3. 同理火把朝向 meta（1–5）、箱子朝向 meta（2–5）在计数口径下都坍缩到 `torch:0`/`chest:0`——
   与 §8.6「计数键落到物品变体」的要求一致：**这些原版状态 meta 不构成物品变体**。
4. `ItemSlab` 显示名按 `meta&7` 取材质（meta 0/8 都是 'Stone Slab'），命名尊重游戏内显示名
   无额外工作。

---

## 6. 探针运行方式与输出位置

```powershell
pwsh -File scripts/multiblock-pipeline/run-parts-probe.ps1 -Label <label> -SingleBox
```

- 与 P0.2 同一管线（前置检查 → 触发文件 → `gradlew runClientSdePipeline` → 专用世界
  `sde_parts_probe_world` → 传送真实玩家 → 服务端放置 → 60 tick 同步 → 客户端读取 → 落盘退出），
  端到端约 1.1 min。`-SingleBox` 只是在触发文件加 `"singleBox":true`；不加时行为与 P0.2 完全一致。
- 单盒场景（11 格，基点 (64,12,64)，纯 `world.setBlock` 原版放置，无需任何 mod 入口）：
  - z=67 行：石头对照(66) ｜ 下半 slab(68) ｜ 上半 slab(69) ｜ 地面火把(71，y=11 垫脚石) ｜ 挂墙火把(74，附 73 石柱)
  - z=70 行：孤立栅栏(66) ｜ 东西三连栅栏(68–70，探中间 69) ｜ 四向十字栅栏(中心 73，臂 72/74/(73,69)/(73,71))
  - z=74 行：单箱(66) ｜ 双箱(69+70，两格都探)
- 结构化结果：`mod/gtnh/run/client/sde_parts_probe_result.json`；
  探针数据归档：`scripts/multiblock-pipeline/.out/<label>/parts-probe-dump.json`
  （`families.singlebox.blocks[]`，每格含 registryName/meta/三种盒（世界+局部）/blockBoundsLocal/
  三个判定变体/物品身份/errors）。
- 退出码与 P0.2 相同（0 = 全部必收族读到部件；启用 singleBox 时必收族 = ae2/enderio/fmp/singlebox）。

**本轮运行记录**：见文首表格。终版数据以 `p03-run-3` 归档为准。
