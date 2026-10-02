# P0.2 三族部件接口反射可达性探针 —— 结果报告

> **任务**：《non-full-cube-parts-plan.md》§2 P0.2。验证 AE2 / EnderIO / FMP 三族的
> 「枚举格内部件 + 取每部件盒（视觉+碰撞）+ 取部件物品身份」在**运行时纯反射**下可行，
> 并记录坐标系归一化参数。**全部结论附真实运行的探针输出**（运行方式与输出位置见 §6）。
>
> **探针代码**（新增、默认不激活）：`mod/gtnh/src/main/java/com/lightning/mod/client/meshcapture/parts/probe/`
> —— `PartsProbeAutomation`（游戏内无人值守入口，触发文件 `sde_parts_probe.json` 不存在时零行为变化）、
> `PartsProbePlacement`（服务端真实放置三族组合，走各族自己的添加路径 + 正常网络同步）、
> `Ae2PartProbe` / `EnderIoPartProbe` / `FmpPartProbe`（客户端反射读取，纯 `java.lang.reflect`，
> 不引用任何目标 mod 的编译期类型）、`PartsProbeReflect`（反射/JSON 工具）。
> 唯一挂钩点：`SdeClientAutomationTickHandler` 新增一个默认不激活的分支。
> **运行**：`pwsh -File scripts/multiblock-pipeline/run-parts-probe.ps1 -Label <label>`
> （输出归档 `scripts/multiblock-pipeline/.out/<label>/parts-probe-dump.json`）。
>
> **运行记录**：`p02-run-1` 退出码 2（AE2 放置踩 Guava Optional 反射坑，见 §1.5 坑 #1，已修）；
> **`p02-run-2` 退出码 0，三族全绿**：AE2 4 部件（2/2 格）、EnderIO 7 部件（2/2 格）、FMP 2 部件（1/1 格），
> 三族 errors[] 全空。

---

## 1. AE2（Applied Energistics 2）

### 1.1 反射调用链（逐跳，全部实测可达）

| 环节 | 调用链 | 结论 |
|------|--------|------|
| 找方块 | `Block.blockRegistry` 按类名 `appeng.block.networking.BlockCableBus` 扫描 | ✅（不依赖注册名拼写） |
| 造部件组合 | `AEApi.instance().definitions().parts().cableGlass().stack(AEColor.Transparent,1)` / `parts().toggleBus().maybeStack(1).get()` → ItemStack；`world.setBlock(cableBusBlock)` → `TileCableBus#addPart(ItemStack, ForgeDirection, EntityPlayer)`（player 可为 null） | ✅ 服务端放置经正常同步到客户端 |
| 枚举部件 | `mc.theWorld.getTileEntity(x,y,z)` → `TileCableBus#getPart(ForgeDirection)` × `ForgeDirection.values()`（UNKNOWN=中心线缆，6 面=挂载部件）。**注意客户端 tile 实际类是生成的 layer 子类**（实测 `appeng.parts.layers.LayerIEnergyConnected_TileCableBus`），反射 `getMethod` 照常可达 | ✅ |
| 每部件盒 | `part.getBoxes(IPartCollisionHelper)`；helper 用 `appeng.parts.BusCollisionHelper` 的**公开构造器** `(List<AxisAlignedBB>, ForgeDirection side, Entity, boolean visual)`，`visual=true/false` 各一遍 ⇒ 视觉盒/碰撞盒分别取得 | ✅ |
| 原始坐标系实测 | 用 `java.lang.reflect.Proxy` 实现 `IPartCollisionHelper`，先记录 `addBox` 的原始 0–16 像素参数再委托真实 helper ⇒ 一次调用拿「原始像素盒 + 归一化盒 + 局部轴映射」三份 | ✅ |
| 物品身份 | `part.getItemStack(PartItemStack.World)` → ItemStack → `Item.itemRegistry.getNameForObject` + `stack.getDisplayName()` | ✅ |
| 整格对照 | `TileCableBus#getSelectedBoundingBoxesFromPool(World,x,y,z,Entity,boolean visual)`（`ICustomCollision`，AEBaseBlock 高亮/碰撞实际走的路径，含 facade） | ✅ |

### 1.2 坐标系（实测）

- **原始**：`IPartCollisionHelper#addBox` 的输入是 **0–16 像素、挂载面局部坐标**（接口 javadoc 原文
  "expects 0.0 - 16.0 block coords"）。局部轴 → 世界轴的映射由 helper 的 `getWorldX/Y/Z()` 给出
  （`BusCollisionHelper` 按挂载面 switch 构造，局部 Z = 挂载面外法线方向）。
- **归一化**：`BusCollisionHelper#addBox` 内部做 `px/16` + 局部轴基变换（`BusCollisionHelper.java` L95–134），
  输出已是 **0–1 方块局部、标准 MC 朝向（Y-up）**，与 web 侧约定一致。
- **实测证据**（p02-run-2，存储总线挂 UP 面）：原始像素盒 `[3,3,15 → 13,13,16]` 等 3 个
  （局部 Z 朝 UP），轴映射 `localX→EAST, localY→SOUTH, localZ→UP`，归一化后
  `[0.1875,0.9375,0.1875 → 0.8125,1.0,0.8125]`——正确落在方块顶面。
- **建议**：提供者直接复用 `BusCollisionHelper` 的输出（0–1 方块局部），**不要**自己重做像素→方块变换；
  若要保留原始像素信息（调试/证伪用），照探针的 Proxy 手法在 `addBox` 入口截获即可。

### 1.3 视觉盒 vs 碰撞盒

**两者都能拿到，且必须分开拿。** 同一 `part.getBoxes(helper)` 入口，helper 的 `visual` 标志经
`isBBCollision()` 反馈给部件（如 `PartCable#getBoxes` 按此决定是否加连接段盒）。
AEBaseBlock 的「只框光标所指部件」= 对 `getSelectedBoundingBoxesFromPool(visual=true)` 的全套盒逐个
raytrace 取最近命中（`AEBaseBlock.java` L213–279），碰撞走 `visual=false`（同方法 L262–275 与
`addCollisionBoxesToList` L188–209）。本探针组合的部件两盒恰好一致（线缆芯/面板/总线），但接口语义上
允许不同（facade、连接段），**只拿碰撞盒是已知坑，提供者必须两遍都跑**。

### 1.4 物品身份来源

`IPart#getItemStack(PartItemStack)`（enum：`Pick/Break/Wrench/Network/World`）。探针用 `World`。
实测三部件同 item 不同 damage（**类型键必须含 damage**）：
`appliedenergistics2:item.ItemMultiPart:16` = 'ME Glass Cable - Fluix'、`:80` = 'ME Toggle Bus'、
`:220` = 'ME Storage Bus'。

### 1.5 缺口与坑记录

1. **Guava Optional 反射坑**（p02-run-1 实证）：`maybeStack()` 返回 `com.google.common.base.Optional`，
   其实现类 `Present` 是 package-private —— 对运行时类 `getMethod("isPresent")` 抛
   `IllegalAccessException`。**反射调用必须打在公共抽象类 `com.google.common.base.Optional` 上**。
   P1.3 提供者同样写法。
2. facade（伪装板）不在 `getPart` 枚举里，需另走 `IFacadeContainer#getFacade(side)`
   （`CableBusContainer#getFacadeContainer`）。本轮探针未放 facade，P1.3 提供者需补此一跳。
3. 升级卡（importBus 等 NBT 内容）不在 `getItemStack(World)` 里体现；计数到升级卡粒度需解析部件 NBT
   （`IPart#writeToNBT`），标记为 P1.3 开放项。
4. **保真度说明**：探针组合的相邻两格线缆在 60 tick 内未形成跨格连接段（客户端只见芯盒
   `[6,6,6→10,10,10]`px；格内部件 stub 正常）。疑似服务端 grid 连接形成/同步时机问题，
   不影响每部件盒获取机制的验证；P1.8 验收结构走真实建造通道时应复核连接段盒是否出现
   （EnderIO 对照组跨格连接段**正常**出现，见 §2.6）。

### 1.6 探针输出样例（p02-run-2 节选，组合：玻璃线缆 + 切換总线(NORTH) + 存储总线(UP)）

```json
"tileClass": "appeng.parts.layers.LayerIEnergyConnected_TileCableBus", "partCount": 3
parts:
  - slot=UNKNOWN part=PartCableGlass  item=appliedenergistics2:item.ItemMultiPart:16  'ME Glass Cable - Fluix'
  - slot=NORTH   part=PartToggleBus   item=appliedenergistics2:item.ItemMultiPart:80  'ME Toggle Bus'
  - slot=UP      part=PartStorageBus  item=appliedenergistics2:item.ItemMultiPart:220 'ME Storage Bus'

线缆（UNKNOWN）visual:
  rawPixelBoxes:    [[6,6,6,10,10,10],[6,10,6,10,12,10],[6,6,5,10,10,6]]   ← 0–16 像素，含 2 个格内部件 stub
  blockLocalBoxes:  [[0.375,0.375,0.375,0.625,0.625,0.625],[0.375,0.625,0.375,0.625,0.75,0.625],
                     [0.375,0.375,0.3125,0.625,0.625,0.375]]                 ← BusCollisionHelper 归一化 0–1
  localFrameAxes:   {localX→EAST, localY→UP, localZ→SOUTH, isBBCollision=false}

切換总线（NORTH）visual:
  rawPixelBoxes:    [[6,6,11,10,10,16]]
  blockLocalBoxes:  [[0.375,0.375,0.0,0.625,0.625,0.3125]]                   ← 正确落在北侧面
  localFrameAxes:   {localX→WEST, localY→UP, localZ→NORTH}                   ← 局部轴随挂载面而变（实证）

存储总线（UP）visual:
  rawPixelBoxes:    [[3,3,15,13,13,16],[2,2,14,14,14,15],[5,5,12,11,11,14]]
  blockLocalBoxes:  [[0.1875,0.9375,0.1875,0.8125,1.0,0.8125],[0.125,0.875,0.125,0.875,0.9375,0.875],
                     [0.3125,0.75,0.3125,0.6875,0.875,0.6875]]               ← 正确落在顶面
  localFrameAxes:   {localX→EAST, localY→SOUTH, localZ→UP}

wholeTileBoxes: visual=7, collision=7（= 3+1+3，逐部件之和，与整格 ICustomCollision 路径一致）
```

---

## 2. EnderIO

### 2.1 反射调用链（逐跳，全部实测可达）

| 环节 | 调用链 | 结论 |
|------|--------|------|
| 找方块 | `Block.blockRegistry` 按类名 `crazypants.enderio.conduit.BlockConduitBundle` 扫描 | ✅ |
| 造导管组合 | `crazypants.enderio.EnderIO` 公开静态字段 `itemPowerConduit/itemItemConduit/itemLiquidConduit/itemRedstoneConduit/itemMEConduit` → `item.createConduit(stack, player)`（`IConduitItem`）→ `world.setBlock(blockConduitBundle)` → `TileConduitBundle#addConduit(IConduit)`。**注意**：`AbstractItemConduit#onItemUse` 的放置逻辑包在 `if (!world.isRemote)` 里（L66–118），客户端侧直接 onItemUse **不会**落世界——必须走服务端（探针即如此） | ✅ |
| 枚举部件 | `tile.getConduits()` → `Collection<IConduit>`；`conduit.getBaseConduitType()` → 类型键（接口 Class） | ✅ |
| 每部件盒 | `conduit.getCollidableComponents()` → `Collection<CollidableComponent>`；字段 `conduitType`/`bound`/`dir`/`data`。**实测重要发现**：per-conduit 列表**只含连接段**（dir=面方向），**芯盒（dir=UNKNOWN）不在其中**——芯盒由 `addConduitCores` 注入 **tile 级** `getCollidableComponents()`/`getConnectors()`；无连接的导管 per-conduit 列表**为空**（实测 liquid/redstone/ME = 0 个组件，芯盒只在 tile 级出现）。⇒ 正确取法 = tile 级组件按 `conduitType` 归属到导管 + per-conduit 连接段 | ✅ |
| 整格几何 | `tile.getCollidableComponents()`（各导管芯+段+连接器）、`tile.getConnectors()` | ✅ |
| 物品身份 | `conduit.createItem()` → ItemStack（实现类按 subtype 组 stack） | ✅ |

### 2.2 坐标系（实测）

- `CollidableComponent#bound` 是 `com.enderio.core.client.render.BoundingBox`（public final float
  minX..maxZ），**原生即 0–1 方块局部、标准 MC 朝向**，无需归一化。
- 实测证据（5 导管同格）：多导管芯盒按 `Offsets` 系统**互相错开**——能量芯
  `[0.41,0.23,0.41→0.59,0.41,0.59]`、流体芯 `[0.23,0.41,0.41→0.41,0.59,0.59]`、ME 芯
  `[0.41,0.59,0.59→0.59,0.77,0.77]`。这直接证明「同格多部件各有独立盒」在 EnderIO 是数据自带的。

### 2.3 视觉盒 vs 碰撞盒

**EnderIO 只有一套几何源。** `BlockConduitBundle#addCollisionBoxesToList`（L869–905）直接把
`CollidableComponent#bound` 逐个作碰撞盒；`getSelectedBoundingBoxFromPool`（L909–975，选择高亮=视觉盒）
对 raytrace 命中的**同一个** `bound` 做 `scale(1.09)`（连接器段则平移 0.0125 + 按轴放大 0.7）。
⇒ 视觉盒可从碰撞盒**确定性推导**（bound×1.09），不存在独立第二套盒；提供者只取
`CollidableComponent` 即可两全，但**来源标记应记为「碰撞派生视觉」**。

### 2.4 物品身份来源

`IConduit#createItem()`（`IConduit.java` L27）。实测五种导管身份齐全：
`EnderIO:itemPowerConduit:0` 'Energy Conduit'、`:itemItemConduit:0` 'Item Conduit'、
`:itemLiquidConduit:0` 'Fluid Conduit'、`:itemRedstoneConduit:0` 'Redstone Conduit'、
`:itemMEConduit:0` 'ME Conduit'。

### 2.5 缺口记录

- facade（`TileConduitBundle#getFacadeId`）是**整格**属性不是部件，探针已记录其存在（本组合无 facade）。
- 连接器（`conduitType==null` 的组件，如实测 `data=ConduitConnectorType:INTERNAL` 的束内连接器、
  以及红石 `ColorController` 颜色控制头）不是独立物品，计数时应按 `conduitType==null` 或 data 过滤，
  归属到导管本体。P1.4 需处理。
- `dir` 为面方向的组件是**连接段**（连向邻居的臂）：一个导管 = 1 芯 + N 段，契约侧
  「每部件允许多子盒」正好覆盖。

### 2.6 探针输出样例（p02-run-2 节选，组合：一格 5 导管束 + 相邻格 power/item）

```json
"tileClass": "crazypants.enderio.conduit.TileConduitBundle", "partCount": 5
parts（getConduits() 枚举 + createItem() 身份）:
  - crazypants.enderio.conduit.power.IPowerConduit     EnderIO:itemPowerConduit:0    'Energy Conduit'
  - crazypants.enderio.conduit.item.IItemConduit       EnderIO:itemItemConduit:0     'Item Conduit'
  - crazypants.enderio.conduit.liquid.ILiquidConduit   EnderIO:itemLiquidConduit:0   'Fluid Conduit'
  - crazypants.enderio.conduit.redstone.IRedstoneConduit EnderIO:itemRedstoneConduit:0 'Redstone Conduit'
  - crazypants.enderio.conduit.me.IMEConduit           EnderIO:itemMEConduit:0       'ME Conduit'

per-conduit collidableComponents（能量导管，2 个——都是连接段，无芯！）:
  {conduitType: IPowerConduit, dir: EAST, bound: [0.59,0.23,0.41 → 1.0,0.41,0.59]}     ← 连向相邻格的臂
  {conduitType: IPowerConduit, dir: EAST, data: "ColorController", bound: [0.874,0.248,0.428 → 0.946,0.392,0.572]}
per-conduit collidableComponents（流体/红石/ME）: []  ← 无连接 = 空列表（芯盒在 tile 级）

tile 级 wholeTileCollidableComponents（节选）:
  {IPowerConduit,  dir: UNKNOWN, bound: [0.41,0.23,0.41 → 0.59,0.41,0.59]}   ← 能量芯（addConduitCores 注入）
  {IItemConduit,   dir: UNKNOWN, bound: [0.41,0.41,0.59 → 0.59,0.59,0.77]}   ← 物品芯（Offsets 错开）
  {ILiquidConduit, dir: UNKNOWN, bound: [0.23,0.41,0.41 → 0.41,0.59,0.59]}   ← 流体芯
  {IPowerConduit,  dir: EAST,    bound: [0.59,0.23,0.41 → 1.0,0.41,0.59]}    ← 跨格连接段（同步正常）
  {null(connector), dir: UNKNOWN, data: ConduitConnectorType:INTERNAL, bound: [0.221,0.221,0.405 → 0.599,0.599,0.594]}
```

---

## 3. FMP（ForgeMultipart / ForgeMicroblock）

### 3.1 反射调用链（逐跳，全部实测可达）

| 环节 | 调用链 | 结论 |
|------|--------|------|
| 方块 | `Block.blockRegistry.getObject("ForgeMultipart:block")`（注册名固定）；**注意** `BlockMultipart` 是普通 `Block`（非 BlockContainer），裸 `world.setBlock` **不会**造 Tile——必须走 `TileMultipart.addPart` 入口（内部 `MultipartGenerator.addPart`：放容器方块+造 Tile+发同步包） | ✅ |
| 造微方块组合 | `MicroMaterialRegistry$.MODULE$.materialID("stone")` → `CommonMicroClass$.MODULE$.classes()[0]`（FaceMicroClass；face=0/hollow=1/corner=2/edge=3，`DefaultContent.scala`）→ `create(false, materialId)` → `setShape(size, slot)` → `TileMultipart$.MODULE$.addPart(World, BlockCoord, TMultiPart)` | ✅ Scala object 一律 `Class.forName("...$").getField("MODULE$")` |
| 枚举部件 | `tile.jPartList()` → `java.util.List<TMultiPart>`（Scala `def jPartList` 编译为同名 JVM 方法）。客户端 tile 实测为生成的 mixin 子类 `TileMultipart_cmp$$1`，部件为 `Microblock_cmp$$1` | ✅ |
| 槽位 | `part.getSlot()`（TSlottedPart）→ 0–26 对应 `PartMap` 27 规范槽位（0–5 面、6 中心、7–14 角、15–26 边）；实测 slab→0/BOTTOM、panel→1/TOP，`PartMap.values()[slot].name()` 反查成功 | ✅ |
| 每部件盒 | `part.getSubParts()` → `Iterable<IndexedCuboid6>`（视觉/高亮盒，含 `data` 命中索引）；`part.getCollisionBoxes()` → `Iterable<Cuboid6>`；`Cuboid6.min/max`（`Vector3`，public double x/y/z） | ✅ |
| 物品身份 | `part.getDrops()` → `Iterable<ItemStack>`；damage 编码 = `size \| (classId << 8)`，材料在 stack NBT `mat` 键 | ✅ |
| 材料名 | `MicroMaterialRegistry$.MODULE$.materialName(int)` / `materialID(String)` / `getIdMap()` | ✅ |

### 3.2 坐标系（实测）

- `Cuboid6` **原生即 0–1 方块局部、标准 MC 朝向**（min/max 为 Vector3 double）。无需归一化。
- 实测：底半台阶 `[0,0,0 → 1,0.5,1]`、顶面板 `[0,0.75,0 → 1,1,1]`，与放置参数
  `setShape(4,0)`/`setShape(2,1)` 精确吻合。

### 3.3 视觉盒 vs 碰撞盒

**两个接口分开、都能拿到。** `BlockMultipart#addCollisionBoxesToList`（L197–216）用 `getCollisionBoxes`；
高亮经 raytrace 命中 `getSubParts` 的 `IndexedCuboid6`（`TMultiPart#collisionRayTrace` L81–98）。
对 `TCuboidPart`（微方块）默认实现两者同源（`getBounds`，`TCuboidPart.scala` L26–30）——
本组合实测三者（subParts/collisionBoxes/renderBounds）数值一致，但接口层允许不同
（非 CuboidPart 部件可分开覆写），**提供者必须两个都取**。

### 3.4 物品身份来源

`TMultiPart#getDrops()`（微方块实现：`Microblock#getDrops` L61–75，按尺寸拆 4/2/1 多件——
**「一部件 ≠ 一物品」的直接实证**）。实测：
`ForgeMicroblock:microblock:4` `{mat:"ProjRed|Exploration:projectred.exploration.stone"}` = 'Marble Slab'、
`ForgeMicroblock:microblock:2` `{mat:"TConstruct:GlassBlock"}` = 'Clear Glass Panel'。
⇒ **类型键 = registry + damage + NBT(mat)**，三者缺一不可（同 item 同 damage 不同材料=不同物品）。

### 3.5 缺口与坑记录

1. **材料名是别名解析**：`materialID("stone")` 实测解析到 id 0，其规范名是
   `ProjRed|Exploration:projectred.exploration.stone`（'Marble Slab'）——GTNH 环境里约 1800+ 材料、
   名字有别名。权威身份 = 部件实际 `material` id / NBT `mat` 串，**不要**假设 "stone"=原版石头。
2. `partMap(slot)` 在基类返回 null（真实实现在生成的 mixin 子类）——枚举用 `jPartList()`（探针路径），
   不按 27 槽轮询。
3. Scala 编译产物方法名：本轮用到的 `jPartList/getType/getSlot/getSubParts/getCollisionBoxes/getDrops/
   getMaterial/getSize/getShape/getRenderBounds/setShape/materialID/materialName/getIdMap/classes/create/addPart`
   **全部与源码 `def/val` 同名可达**（errors[] 为空）。
4. 跨格表达：FMP 一个部件始终属于一个 Tile（一格）；「一块跨格微方块」由「两格各有一个部件」表达，
   计数按部件物品累加即可——但 size>1 部件 getDrops 拆多件小物品的口径需 P0.4 裁定（风险表 #4）。

### 3.6 探针输出样例（p02-run-2 节选，组合：底半台阶 stone + 顶面板 glass 同格）

```json
"tileClass": "TileMultipart_cmp$$1", "partCount": 2
parts[0]: partClass=Microblock_cmp$$1, type=mcr_face, slot=0 (BOTTOM), materialId=0
          materialName=ProjRed|Exploration:projectred.exploration.stone, size=4, shape=0
          subParts(visual): [{box:[0,0,0,1,0.5,1], data:"0"}]
          collisionBoxes:   [{box:[0,0,0,1,0.5,1]}]
          drops: [{registry: "ForgeMicroblock:microblock", damage: 4,
                   nbt: {mat:"ProjRed|Exploration:projectred.exploration.stone"}, display: "Marble Slab"}]
parts[1]: type=mcr_face, slot=1 (TOP), materialId=28 (TConstruct:GlassBlock), size=2, shape=1
          subParts(visual): [{box:[0,0.75,0,1,1,1], data:"0"}]
          collisionBoxes:   [{box:[0,0.75,0,1,1,1]}]
          drops: [{registry: "ForgeMicroblock:microblock", damage: 2,
                   nbt: {mat:"TConstruct:GlassBlock"}, display: "Clear Glass Panel"}]
```

---

## 4. 归一化结论（留白 #3 的拍板依据）

| 族 | 原生坐标系 | 归一化参数 | 视觉/碰撞盒 |
|----|-----------|-----------|------------|
| AE2 | 0–16 像素、**挂载面局部**（局部 Z = 面外法线，轴映射随面而变，实测 NORTH→{WEST,UP,NORTH}、UP→{EAST,SOUTH,UP}） | 复用 `BusCollisionHelper`：px/16 + 按 `getWorldX/Y/Z` 基变换 → 0–1 方块局部 Y-up | 两套都拿（同一 `getBoxes` 入口，`visual` 标志区分） |
| EnderIO | 0–1 方块局部 | 原样使用 | 单一几何源；视觉盒 = 碰撞盒 ×1.09（来源记「碰撞派生」）；芯盒在 tile 级、段在 per-conduit 级 |
| FMP | 0–1 方块局部 | 原样使用 | 两套都拿（`getSubParts` 视觉 / `getCollisionBoxes` 碰撞） |

⇒ **统一空间 = 0–1 方块局部、MC 标准朝向（Y-up）**，与 web 侧一致，三族均可无损落入。AE2 是唯一需要
变换的族，且官方 helper 类公开构造器可直接复用（不需要自己实现基变换）。

**类型键（跨格合并键）结论**：三族都必须含物品变体——AE2 = `registry+damage`
（实测 :16/:80/:220 同 item）；EnderIO = `registry+damage`（conduit subtype）；
FMP = `registry+damage+NBT(mat)`（同 damage 不同材料 = 不同物品）。

---

## 5. 放置通道结论（P1.8 建造器参考）

三族统一采用「**服务端世界真实放置 → 正常同步 → 客户端读取**」（mc.theWorld 与导出环境一致）：

- AE2：`world.setBlock(cableBusBlock)` + `TileCableBus#addPart(stack, side, player|null)`（= PartPlacement 服务端半环的最终落点）。
- EnderIO：`world.setBlock(blockConduitBundle)` + `item.createConduit(stack, player)` + `addConduit`
  （onItemUse 有 `!world.isRemote` 守卫，客户端直接调不落世界）。
- FMP：`TileMultipart$.addPart(world, pos, part)`（入口即含容器方块放置；裸 setBlock 不造 Tile）。

## 6. 探针运行方式与输出位置

```powershell
pwsh -File scripts/multiblock-pipeline/run-parts-probe.ps1 -Label <label>
```

- 流程：前置检查 → 写触发文件 `mod/gtnh/run/client/sde_parts_probe.json` → `gradlew runClientSdePipeline`
  → 游戏内自动进专用世界 `sde_parts_probe_world` → 传送真实玩家到基点 (64,12,64) → 服务端真实放置
  三族组合 → 等 60 tick 同步 → 客户端反射读取 → 落盘退出。
- 结构化结果：`mod/gtnh/run/client/sde_parts_probe_result.json`（status/exitCode/逐族部件数）。
- 探针数据：`mod/gtnh/run/client/sde_parts_probe_dump.json`；归档副本
  `scripts/multiblock-pipeline/.out/<label>/parts-probe-dump.json`（gitignore 目录）。
- 退出码：0 = 三族全部读到部件；2 = 至少一族没读到（细节在 dump errors[]）；3 = 管线级致命；4 = 外层编排失败。
- 每次运行端到端约 1.1 min（客户端启动到退出）。

**本轮运行记录**：

| 运行 | 退出码 | 结果 |
|------|--------|------|
| p02-run-1 | 2 | AE2 放置失败（Guava Optional 反射坑，§1.5#1）；EnderIO 7 部件、FMP 2 部件正常 |
| p02-run-2 | 0 | **三族全绿**：AE2 4 部件（2/2 格）、EnderIO 7 部件（2/2 格）、FMP 2 部件（1/1 格），errors[] 全空 |
