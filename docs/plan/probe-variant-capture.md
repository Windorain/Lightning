# T1.3 变体构建 + 几何捕获 — 报告

> **任务**：`multiblock-channel-renderer-plan.md` T1.3 —— 按「通道取值 / 总 Tier / 运行态」驱动假世界构建，逐变体捕获烘焙几何，
> 产出供 T1.4 因子化编码的**变体几何数据集**。
> **证据落盘**：`mod/gtnh/run/client/variant_capture/run-0014/`（证据 A）与 `run-0015/`（证据 B）；另有 `run-0009/…run-0013/`
> 五次早期运行（含 spotless 前的产物，用于跨 jar 复核）。`latest.json` = 最近一次 `report.json` 副本。
> **触发方式**：`<mcDataDir>/sde_variant_capture.json` 存在 → `gradlew runClient` → 跑完自动落盘并 `Minecraft.shutdown()`（零人工交互）。
> **上位依据**：[multiblock-channel-renderer-plan.md](multiblock-channel-renderer-plan.md) T1.3；
> [probe-run-state.md](probe-run-state.md)（T0.3 运行态机制与坑）；[probe-multiblock-scan.md](probe-multiblock-scan.md)（T1.2 事实层）；
> [probe-channels.md](probe-channels.md)（T0.4 R4/R5）；[format-multiblock-doc.md](format-multiblock-doc.md)（T0.5 契约）；
> [decision-deps-route.md](decision-deps-route.md)（T0.2 依赖路线）。

---

## 0. 结论（TL;DR）

| 项 | 数字 / 结论 |
|----|-------------|
| 代表机 | **4 台**：`MTEElectricBlastFurnace`（替换型通道，任务点名机）、`MTEDistillationTower`（尺寸型通道）、`MTEBrickedBlastFurnace`（仅总 Tier）、`MTEQuantumForceTransformer`（真·多通道替换型） |
| 变体规模 | **842 变体** = 420 + 220 + 2 + 200；**421 次真实构建**（每单元两态共用一次构建）；**842 次逐变体捕获** |
| 失败清单 | **0 条**（`report.json.failures = []`；静默跳过 = 失败，本实现没有静默路径） |
| 全局调色板 | **47 条**（含 air）；覆盖 33 个不同 `registryId:meta`；`internCalls 6229` / 去重丢弃 **6183** 次（**99.25%**）；引用事件 **214,806** 次 → 同一方块状态的烘焙几何全数据集只存一份 |
| 纹理嵌入 | `materialPalette` 56 条、`textureBlobs` 51 个（`TextureBlobEmbedder` 既有机制） |
| 布局/取值断言 | A1 替换型通道**逐取值**核对（EBF 13 项 / QFT 6 项，全 pass，差异位置 100% 命中 T1.2 独立探测的预期方块）；A2「未设置 → 回落总 Tier」对照 28 组全 pass；A3 尺寸规则 10/10 pass；A4 实例新鲜度 421/421 pass；A5 状态键验证 0 不稳定 |
| 两态差异事实 | **421 对 (idle, active) 全部不同**，且差异**恰好 1 格**（控制器所在格）：`registryId:meta` 相同、几何签名不同 → `materialSwapOnly = true`、`structuralDiffPairs = 0`（与 T0.3 裁决、契约 §7.4 的 `geometryDelta:false` + `texture-material-swap` 一致） |
| 运行态驱动方式 | EBF/DT/QFT 走**真实状态机**（`onPostTick` 服务端分支 + `setActive(mMaxProgresstime > 0)` 派生，全部 `assertionPassed=true`）；BBF **走公开逃生门**并在产物里标注原因（它继承 `MetaTileEntity`，公开面没有进度字段） |
| 可重复性 | `run-0014` vs `run-0015`：4 个机器文件**逐字节一致**、`palette.json` **逐字节一致**、842/842 变体 (布局签名｜几何签名) 一致、`signatureComparison.allMatch = true` |
| 跨 jar 复核 | `run-0009`（spotless 前）与 `run-0012`（spotless 后）机器文件逐字节一致 → 格式化未改变行为 |
| 耗时 | 捕获工作本身 **66–147 s**（`totals.elapsedMs`；随机器负载波动），`runClient` 全程（启动 → 捕获 → 退出）约 2m10s–3m30s |
| `gradlew build` | **通过**（含 `spotlessJavaCheck`） |

---

## 1. 运行环境与版本锚点

| 项 | 值 | 来源 |
|----|-----|------|
| Minecraft / Forge | 1.7.10 / 10.13.4.1614 | `report.json.environment` |
| GT5-Unofficial | `MC1710`（`5.09.52.283`） | `report.json.environment["mod.gregtech"]` |
| StructureLib | `1.4.28` | 同上 |
| Lightning | `0.2`（开发档） | 同上 |
| 输入事实层 | `multiblock_scan/run-0002/machines.json`（T1.2 最近一次扫描） | `report.json.environment.factsFile` |
| 运行模式 | `world=none`（主菜单态 + 自带 `ProbeDummyWorld`，不进真实存档） | 与 T0.3/T1.2 同因，见 [probe-run-state.md §4.4](probe-run-state.md) |
| 依赖变更 | **无**（复用 T0.2/T0.3 已引入的 compileOnly 集：GT5U / StructureLib / GTNHLib / ModularUI2 / AE2） | §10 |

---

## 2. 无人值守管线

```
sde_variant_capture.json 存在
  → SdeClientAutomationTickHandler#onClientTick（T1.2 已挂好的接管点）
  → MultiblockScanAutomation.isRequested/tick 分派（+3 行，纯新增；两个触发文件都不存在时零行为）
  → VariantCaptureAutomation（等主菜单 + 60 tick 静置）
  → VariantCaptureRunner.run(Minecraft)：逐台 → 逐变体 构建/驱动/捕获 → 落盘 → 与上一次运行比对
  → Minecraft.shutdown()
```

触发文件字段（全部可选，`VariantCaptureRunner.Config`）：

```jsonc
{
  "machines": [],              // 目标机（simpleName 或 fqcn）；空 = 4 台默认代表机
  "limitPerMachine": -1,       // 调试：每台只跑前 N 个 (tier × 取值组合) 单元
  "maxVariantsPerMachine": 2000,   // 超限时按契约 §9.4 的 tierSample 语义抽样并写进产物 notes
  "verifyPositionsPerKey": 8,  // 状态键位置无关性的抽样验证格数
  "fullVerifyUpTo": 24,        // 位置数 ≤ 该值的状态键逐格验证
  "includeThumbnails": true,
  "embedTextures": true,
  "factsPath": "",             // 覆盖 T1.2 machines.json 路径
  "exit": true, "cleanupTrigger": true
}
```

复现命令（PowerShell，注意 UTF-8 无 BOM）：

```powershell
cd mod\gtnh
Set-Content -Path run\client\sde_variant_capture.json -Value '{"exit":true,"cleanupTrigger":true}' -Encoding utf8NoBOM
.\gradlew.bat runClient        # 全程零点击；产物在 run\client\variant_capture\run-NNNN\
```

---

## 3. 代表机选择与一处事实勘误

计划 T1.3 的验收集是「a. 多通道替换型 / b. 含尺寸型通道 / c. 仅总 Tier」。任务书对 a 举的例子是
`MTEElectricBlastFurnace（coil + glass）`。**该说法在 pinned 5.09.52.283 上不成立**：T1.2 的 `machines.json` 实测
EBF 只有 **1 条具名通道**（`HEATING_COIL/coil`，max 14），没有 `glass`。

处置（不外推、不编造）：

| # | 机器 | 角色 | 具名通道（T1.2 事实） | 变体数 | 备注 |
|---|------|------|----------------------|-------:|------|
| a1 | `MTEElectricBlastFurnace` | 任务点名机（**替换型通道**） | `coil` 0..14 | 420 | 活动纹理两态代表（T0.3 已实测 4 个四边形差异） |
| a2 | `MTEQuantumForceTransformer` | **真·多通道替换型**（补 a 的类别覆盖） | `manipulator` 0..4、`shielding` 0..4 | 200 | 全 221 台里唯一「2 条替换型通道且组合积 ≤ 25」的机器 → **全合法组合、零抽样** |
| b | `MTEDistillationTower` | **尺寸型通道** | `height`（`getValueClamped(trigger,3,12)`） | 220 | 尺寸型定骨架 → 替换型/运行态叠加的装配顺序载体 |
| c | `MTEBrickedBlastFurnace` | **仅总 Tier** | 无具名通道 | 2 | 结构 35 格、最大总 Tier = 1 |

**为什么不用 `MTELapotronicSuperCapacitor`/`MTEAssemblyLine`/`MTEChemicalPlant`**：它们的组合积分别是 20064 / 494 / 5400，
再乘 tierSample 与两态后远超 2000 变体/台的上限，必须抽样——而本任务的硬要求是「全合法取值组合」。因此 b 选
`MTEDistillationTower`（组合积 11 × 10 = 110，全量覆盖），LSC 交给 T1.5/T1.6 的全量导出（它们允许抽样与分片）。

**tierSample 策略**：4 台全部走**全量 `1..maxTotalTier`**（14 / 10 / 1 / 4），无一台触发抽样，`tierSamplePolicy = "full"`。

---

## 4. 变体空间与键口径（与契约 §5.1/§5.2 对齐）

| 机器 | 通道域（声明值） | tierSample | 运行态 | 变体数 = ∏(max+1) × \|tier\| × 2 |
|------|------------------|-----------|--------|----------------------------------|
| EBF | `coil` 0..14（15） | 1..14（14） | idle/active | 15 × 14 × 2 = **420** |
| DT | `height` 0..10（11） | 1..10（10） | idle/active | 11 × 10 × 2 = **220** |
| BBF | —（1） | 1（1） | idle/active | 1 × 1 × 2 = **2** |
| QFT | `manipulator` 0..4、`shielding` 0..4（25） | 1..4（4） | idle/active | 25 × 4 × 2 = **200** |

- **`0` = 契约的「未设置」**：`values` 里写 0，构建时不写 `channels` 子标签 → GT `ChannelDataAccessor#getChannelData`
  回落到 `stackSize`（总 Tier）。`variants[].effective` 就是按契约 §5.2 解析出来的有效值，T1.4 可以用它交叉验证自己的 RESOLVE 实现。
- **键**严格按契约 §5.1 派生：`<通道key>:<声明值>` 按 `channels` 顺序 `|` 连接，再追加 `tt:<总Tier>`、`runstate:<id>`。
  例：`coil:0|tt:1|runstate:idle`、`manipulator:3|shielding:2|tt:4|runstate:active`、`tt:1|runstate:idle`（无具名通道）。

---

## 5. 构建：通道取值注入、实例状态、尺寸型骨架、舱口

### 5.1 通道取值注入只走 placeBlock/spawnHint（T0.4 R4）

```java
// MultiblockWorldBuilder#triggerWithChannels
ItemStack trigger = new ItemStack(StructureLibAPI.getDefaultHologramItem(), totalTier);  // 主通道 = 总 Tier
for (通道 id, 声明值 k) if (k > 0) ChannelDataAccessor.setChannelData(trigger, id, k);
build = MultiblockWorldBuilder.build(target, trigger, hatchPlanCache);
//   → onItemUse 放控制器 → IConstructable#construct(trigger, hintsOnly=false) → 走 placeBlock
```

- **从未调用 `getBlocksToPlace`** 来建变体（那是 T1.2 的取值域枚举路径，T0.4 R4 明确不换通道）。
- 代码级证据：`VariantCaptureRunner`/`VariantGeometryBakery` 里没有任何 `getBlocksToPlace` 引用；唯一入口是 `construct`。
- **行为级证据（最强）**：A1 断言把「真实构建结果」与「T1.2 另一次独立探测的预期方块表」逐格对齐 ——
  EBF `coil` 的 14 个取值、QFT 两条通道各 3 个取值，差异位置**全部**命中预期方块状态（§8.3）。

### 5.2 实例状态复位（T0.4 R5）：每变体都是全新 MTE 实例

`onItemUse` 走 `CommonBaseMetaTileEntity#createNewMetatileEntity` → `METATILEENTITIES[id].newMetaEntity(this)`，
即每个变体拿到**全新实例**（pinned jar `javap` 实证 `MTEElectricBlastFurnace#newMetaEntity` 返回 `new MTEElectricBlastFurnace(...)`）。
因此 `construct()` 不可能读到上一个变体残留的实例状态——这比「逐字段复位」更强，且是**可断言**的：

- 每个变体记录 `controllerInstanceOrdinal` 与 `controllerInstanceReused`；
- 机器级断言 **A4.fresh-instance**：`构建次数 == 不同实例数 && 复用次数 == 0` →
  EBF 210/210、DT 110/110、BBF 1/1、QFT 100/100，**复用 0 次**，全 pass。
- 若将来某台机器的 `newMetaEntity` 返回 `this`（不新建），A4 会立刻变红。

### 5.3 尺寸型通道：先定骨架，再叠加（契约 §5.4 的装配顺序）

尺寸型通道由 GT 在 `construct` 内部经 `getValueClamped` 读取（`MTEDistillationTower#construct` 用它决定片数），
所以「尺寸型 → 骨干」这一步天然发生在真实构建里；替换型通道与运行态是同一构建内的注入与驱动。
**实测校验（A3）**：DT 的 `height` 取值 1..10 → 结构 y 尺寸 3..12，逐值 +1，10/10 命中
`min(min+max−1, k+min−1)`（T1.2 §4.7 的 1 基偏移语义）。

### 5.4 舱口骨架：真实搜索 + 形状键缓存（性能优化，带校验）

`construct` 不放舱口（舱口元素的 `placeBlock` 只写 hint），T0.3 的做法是「逐舱口类型 × 逐候选位置试放 + `checkStructure`」
（EBF 实测 183 次 `checkStructure`）。T1.3 保留该搜索，但**按形状键缓存搜索结果**：

- 形状键 = 已放置坐标集合的内容签名（替换型通道不改变形状，因此同形状可复用计划）；
- 命中缓存时按计划真实 `onItemUse` 放舱口，然后用 **GT 自己的公开舱口清单**核对 8 个计数，一致才接受；否则回滚并退回全量搜索；
- 实测：421 次构建里 **309 次命中缓存、仅 11 次全量搜索**（`totals.hatchPlanCacheHits/Stores`）。

**这不是「合成几何」**：缓存的是「哪些位置被 GT 接受」这一搜索结论，几何仍然来自真实构建后的逐格捕获。

---

## 6. 运行态驱动：两态、断言与 `activeMechanism`

机制与 T0.3 完全一致（同一组 public 字段 + 同一道公开逃生门），只是按变体执行：

1. **真实 TE 更新路径** `TileEntity#updateEntity()` ×3（服务端分支证据：`errorDisplayID` 变化）；
2. **运行态机本体** `IMetaTileEntity#onPostTick(base, tick)` 循环（`MTEMultiBlockBase` 额外在 `mMachine` 或自我停工处提前停止）；
3. **进态三行** `mProgresstime = 0; mMaxProgresstime = <0 | 200>; onPostTick(...)`，**断言 `isActive()`** 后才捕获；
4. **逃生门** `IGregTechTileEntity#setActive(boolean)` 仅在断言失败或该机公开面无进度字段时使用，并写明原因。

| 机器 | `activeMechanism`（421 个 active 变体的直方图） | 断言通过 |
|------|--------------------------------------------------|---------|
| EBF | `onPostTick 服务端分支：setActive(mMaxProgresstime > 0)` ×210 | 210/210 |
| DT | 同上 ×110 | 110/110 |
| QFT | 同上 ×100 | 100/100 |
| BBF | `公开逃生门 IGregTechTileEntity#setActive(boolean)（IMachineProgress）：本机不是 MTEMultiBlockBase：公开面没有进度字段可写（不引入反射），无法用状态机派生` ×1 | 1/1 |

- **BBF 的处置必须说清**：`MTEBrickedBlastFurnace extends MetaTileEntity`（不是 `MTEMultiBlockBase`），它的
  `mMaxProgresstime`/`mMachine` 是**自己的** public 字段，但不在 `IMetaTileEntity`/`IGregTechTileEntity` 公开接口上。
  本任务**不引入第 5 处反射**（`decision-deps-route.md` 的受控反射内核只有 4 处，且该文件不在写范围内），
  因此走公开逃生门并把原因写进 `variants[].runState.escapeHatchReason` 与 `activeMechanism`。
  它的 `drive()` 仍然真实跑了 140 tick 的 `onPostTick`（`checkMachine` 已被调用），只是无法从公开面注入进度。
- **附带事实**：两态捕获都在**同一个已构建世界**上完成（先 idle 再 active），所以「两态差异」不掺杂重建噪声。

---

## 7. 几何捕获与全局调色板

### 7.1 逐格捕获原语（全部复用既有设施）

每个非空气位置都走 `MeshCaptureService#finalizeSingleStructure` 的同一套原语：

```
TessellatorCaptureState.beginBlock(...) → Tetssellator.startDrawingQuads()
  → BlockPrimaryCaptureRegistry.dispatch(...)            （主批次）
  → tess.draw()
  → MeshCaptureBlockPostRenderRegistry.dispatch(...)     （后渲染/TESR）
  → tess.draw()；四边形为 0 时 renderBlockAsItem 兜底
→ TessellatorCaptureState.endBlock(inst)
→ CaptureToolkit.attachQuadMaterials(inst, textureMap, 全局材质表)   ← 材质下标全数据集稳定
→ CaptureToolkit.geometryOf(inst)                                   ← bakedQuadsJsonV1
```

与既有的唯一差异：捕获对象是 `ProbeDummyWorld`（`finalizeSingleStructure` 硬编码 `Minecraft.theWorld`）；
TESR 补画所需的 `renderViewEntity` 临时挂假玩家（T0.3 §4.4(3) 的处置）。

### 7.2 「逐格捕获」与「同状态共享」：一个必须验证的优化

一次性对 933 格结构逐格捕获要 ~16 s（`MaterialKeyResolver#resolveMidUv` 每四边形扫全图集 sprite），
842 变体不可能都这么做。因此引入**状态键 + 验证 + 锚定**：

- **状态键** = `registryId:meta | MTE 类名 | 激活位`。为什么必须有 MTE 类名：`gregtech:gt.blockmachines:0` 在
  数据集中有 **7 条**不同几何（静音仓/维护仓/能量仓/输入输出仓…，四边形数 7/8/9 各不同）——只按 `registryId:meta` 合并会串味。
- **验证**：位置数 ≤ `fullVerifyUpTo(24)` 的键**逐格验证**；更大的键**抽样 `verifyPositionsPerKey(8)` 格**验证；
  只有「同键所有被捕获位置给出同一条条目签名」才算 verified，否则标 unstable（含该键的变体一律逐格捕获）。
- **锚定**：即使键已 verified，**每个变体对每个键至少真实捕获 1 格**，并与已验证签名比对；不一致 → 该键立即标 unstable
  **并写进失败清单**（`StateKeyMismatch`）。
- 结果（`report.json.machines[].stateKeyVerification`）：

| 机器 | 已验证状态键 | 不稳定键 | 逐格变体 | 新键抽样变体 | 锚定变体 |
|------|------------:|--------:|---------:|-------------:|---------:|
| EBF | 21 | **0** | 1 | 14 | 405 |
| DT | 9 | **0** | 1 | 1 | 218 |
| BBF | 3 | **0** | 0 | 2 | 0 |
| QFT | 13 | **0** | 0 | 8 | 192 |

**「不得凭空合成」的落点**：任何变体的任何一格，其几何要么在本变体被真实捕获（锚定/抽样/逐格），要么取自
**本数据集内真实捕获并验证过**的同一状态键条目；数据集里没有任何一格来自猜测或程序化生成。

### 7.3 调色板：并集 + 内容签名全局去重（硬约束 2、3）

- 去重键 = `MeshCaptureService#fullEqualitySignature(registryId, meta, nbt=null, geometry, tooltip=null)`
  —— 与既有 `liftBlockPaletteToRoot` / `entryEqualitySignature` **同一套签名函数**（本任务把它提升为公共
  `CaptureToolkit`，见 §10），nbt/tooltip 传 `null` 表示不参与去重（原因见 §11 开放项 1）。
- 统计（`palette.json.stats`）：`paletteEntries 47`（含 air）、`internCalls 6229`、`duplicateCapturesSuppressed 6183`
  → **去重率 99.25%**；`referenceEvents 214806` = 「变体 × 位置」引用总数。
- **同状态只存一份**的机器判据：47 条条目覆盖 33 个不同 `registryId:meta`；多出来的条目只出现在 GT 机器方块上
  （`blockmachines:0` 7 条 = 不同舱口、`blockmachines:2` 6 条 = 4 台控制器 × 两态、`blockmachines:1` 3 条、
  `blockmachines:14` 2 条 = BBF 控制器两态）。按内容签名，它们**确实是不同的方块状态**（几何不同），
  且 `unreferencedEntries = 1`（只有 air）→ 没有任何「枚举到但用不到」的死条目。
- 条目形状与既有产物**完全同形**：`{registryId, meta, thumbnailPNG?, renderMode, geometry:{encoding:"bakedQuadsJsonV1", quads:[...]}, occludesAdjacentFaces, nbt:null, tooltip:[]}`，下标 0 恒为 air。

### 7.4 纹理嵌入

复用 `TextureBlobEmbedder#embedIntoDocument`：`materialPalette` 56 条 → `textureBlobs` 51 个 blob，
每条材质回填 `textureBlobIndex`；`materialIndex` 全数据集稳定（同一个 `CaptureToolkit.MaterialTable`）。

### 7.5 一个真实踩坑（留档，避免下游重犯）

第一版输出 `materialEntries = 1`、所有四边形 `materialIndex = 0`、材质定位串全是 `"unknown"`。
根因：`MaterialKeyResolver#applySpriteLocalToQuad` 把顶点 UV **就地**从图集坐标改写成 sprite 局部 `[0,1]` 并写回
`q.materialKey`；第一版为了算「T0.3 口径的四边形内容键」先调了一次它，随后 `attachMaterials` 又调了一次
——第二次把局部 UV 当图集 UV 去解析，于是全部退化成 `unknown`。**每个四边形只能调用它一次**（现已修，
`VariantGeometryBakery#captureOne` 里按「先挂材质 → 再用 `q.materialKey` 算内容键」的顺序）。

---

## 8. 断言体系与结果

断言全部**机器可读**地落在 `machines/<slug>.json#machineAssertions` 与 `report.json.failures`（任何 fail 都会进失败清单）。

| ID | 断言 | 判据 | 结果 |
|----|------|------|------|
| A0 | 通道清单来源 | 来自 T1.2 `machines.json`（不重扫结构定义） | 4/4 pass |
| A1 | **替换型通道取值保真** | 取该通道 = k、其余 0、tier = 最小：与「该通道 = 1」的基线逐格差分，**差异位置必须全部是该取值在 T1.2 表里的预期方块状态** | EBF 13/13、QFT 6/6 pass |
| A2 | **未设置 → 回落总 Tier**（契约 §5.2） | 全通道未设置（tt=t）与全通道显式设为 t 的 `layoutSignature` 必须相同 | EBF 14 组、DT 10 组、QFT 4 组，全 pass |
| A3 | **尺寸规则** | 尺寸型通道取 k 时结构 y 尺寸 = `min(min+max−1, k+min−1)`（T1.2 §4.7） | DT 10/10 pass |
| A4 | **实例新鲜度**（T0.4 R5） | 构建次数 == 不同 MTE 实例数 && 复用 0 | 4/4 pass（421 次构建、421 个实例） |
| A5 | 状态键验证 | 逐格/抽样验证的统计与不稳定键清单（不稳定键 = 一律逐格捕获，不算失败但必须落盘） | 4/4 pass，不稳定键 0 |

### 8.3 A1 明细（最强的一条：真实构建 vs 独立探测）

EBF（基线 = `coil:1`，每个 k 的差异位置数恒为 16 = 线圈格数）：

| k | 预期（T1.2 `observedValues`） | 差异位置 | 命中 |
|---|------------------------------|---------:|-----:|
| 2..5 | `[901:1] [901:2] [901:3] [901:4]` | 16 each | 16/16 |
| 6..11 | `[901:9] [901:5] [901:6] [901:10] [901:7] [901:8]` | 16 each | 16/16 |
| 12..14 | `[901:11] [901:12] [901:13]` | 16 each | 16/16 |

QFT：`shielding` k2..k4 → 每档 142 个差异位置、`manipulator` k2..k4 → 每档 236 个，全部命中
`[1455:12..14]` / `[1455:8..10]`。

> 这条断言的意义：T1.2 的取值表是**另一次运行**、**另一条代码路径**（`getBlocksToPlace` 提示列表）得出的；
> 而这里是**真实 `construct` 的 `placeBlock` 结果**。两者逐格一致，同时证明了「注入通道正确」与「预期变体一致」。

---

## 9. 数据集字段设计（T1.4 消费接口）

### 9.1 目录布局

```
run/client/variant_capture/run-NNNN/
  manifest.json                 运行身份 + 配置 + 事实层路径（含耗时，不参与逐字节比对）
  machines/<slug>.json          每台机器的变体清单（下面 §9.2）
  palette.json                  全局 blockPalette + materialPalette + textureBlobs + 去重统计（§9.3）
  report.json                   汇总 + 失败清单 + 两态事实 + 跨运行比对 + 字段设计自述
run/client/variant_capture/latest.json    report.json 副本
```

### 9.2 `machines/<slug>.json`

```jsonc
{
  "schema": "lightning.multiblock.variant-capture/1",
  "machine": { "fqcn","simpleName","displayName","mteId","role","allowEscapeHatch" },
  "factsSource": "…/multiblock_scan/run-0002/machines.json",
  "channels": [{
    "enum": "HEATING_COIL", "id": "coil", "key": "coil", "name": "HEATING_COIL",  // 呈现名取枚举名（T0.4 §5.2）
    "kind": "replace",                       // replace | dimension | hatch
    "domain": { "min": 0, "max": 14 },       // 0 = 未设置（契约 §4.2 第 1 条）
    "max": 14, "observedMax": 16,
    "valueSemantics": "channel-data（0 = 未设置 → 回落总 Tier）",
    "domainSource": "probed", "discoverySource": "element-scan", "registryAgreement": "match",
    "expectedStates": [{ "value": 1, "blocksKey": "[901:0]", "expectedItemId": 901, "expectedMeta": 0, "expectedResolvable": true }],
    "notes": [ … ]
  }],
  "totalTierDomain": { "min": 1, "max": 14, "default": 1, "source": "probed" },
  "tierSample": [1,2,…,14], "tierSamplePolicy": "full(1..maxTotalTier)",
  "runstates": [ {"id":"idle","name":"Idle","materialSwap":false}, {"id":"active","name":"Running","materialSwap":true} ],
  "gridConvention": { "origin": "相对控制器坐标 (8,64,8) 的偏移", "cellGrid": "[z][row][x]，row 0 = 顶部", "value": "全局 blockPalette 下标，0 = 空气", "variantKey": "契约 §5.1" },
  "variants": [{
    "index": 0,
    "key": "coil:0|tt:1|runstate:idle",
    "values": { "coil": 0 },                 // 声明值（0 = 未设置）→ 直接照抄进契约 variant.values
    "effective": { "coil": 1 },              // 契约 §5.2 解析后的有效值（T1.4 可交叉验证自己的 RESOLVE）
    "totalTier": 1, "runstate": "idle",
    "layoutSignature": "…",                  // 坐标+方块+meta（ProbeDummyWorld#stateSignature 同口径）
    "geometrySignature": "…",                // 逐位置「调色板条目内容签名」聚合（与捕获模式无关，跨运行可比）
    "grid": { "origin": [dx,dy,dz], "size": [3,4,3], "cellGrid": [[[下标,…],…],…] },
    "paletteRefs": [1,2,3,4,5,6,7],
    "build": { "controllerPlaced","structureBuilt","blocksAfterConstruct","regularBlocks","quadCount",
               "captureMode","positionsCaptured","positionsShared","hatchPlan","shapeKey","hatchCandidateTries",
               "machineFormed","machineFormedKnown","isMultiBlockBase","selfDisabled",
               "controllerInstanceOrdinal","controllerInstanceReused","hatchPlacements":[…],"structureErrors":[…] },
    "runState": { "requestedActive","activeObserved","assertionPassed","mechanism","maxProgressTime","progressTime",
                  "errorDisplayId","stateMachineTicks","serverBranchExecuted","escapeHatchUsed","escapeHatchReason?" },
    "assertions": { "buildOk","stateAssertionOk","geometryCoverageOk","instanceFresh" },
    "warnings": [ … ]
  }],
  "variantSignatures": { "<variant key>": "<layoutSignature>|<geometrySignature>" },   // 跨运行比对的紧凑视图
  "stateKeyVerification": { … },              // §7.2 的验证统计 + 不稳定键清单
  "machineAssertions": [ … ], "replaceValueChecks": [ … ], "notes": [ … ]
}
```

### 9.3 `palette.json`

```jsonc
{
  "schema": "lightning.multiblock.variant-capture.palette/1",
  "encoding": "bakedQuadsJsonV1",
  "semantics": "所有变体捕获结果的并集，按内容签名全局去重；下标 0 恒为 air；同一方块状态的烘焙几何全数据集只存一份",
  "stats": { "paletteEntries","paletteEntriesExcludingAir","referencedEntries","unreferencedEntries",
             "referenceEvents","internCalls","duplicateCapturesSuppressed","dedupRatio","dedupKey",
             "geometryEncoding","materialEntries","textureBlobs","unreferencedEntryList" },
  "blockPalette": [ … ],        // 与既有产物同形；T1.4 直接作为契约 inner 的根级 blockPalette
  "materialPalette": [ … ],     // 复用 TextureBlobEmbedder；含 locator/atlas/kind/linear/useMipmaps/textureBlobIndex
  "textureBlobs": [ … ],        // base64 PNG
  "tooltipPalette": [],         // 本数据集不含 tooltip（见 §11 开放项 1）
  "paletteContentSha256": "…"   // 条目下标+内容签名的聚合哈希（跨运行一致性判据）
}
```

### 9.4 给 T1.4 的映射建议（我的数据 → 契约形态）

| 契约元素 | 从本数据集怎么来 |
|----------|------------------|
| `multiblock.channels[]` | 直接搬 `channels[]`（`domain` 已含 0；呈现名取 `enum`） |
| `totalTierDomain` / `tierSample` | 直接搬 |
| `runstates[]` | 直接搬；两态差异事实见 `report.json.runStateFacts` |
| `backbone.sizeSteps[]` | 按 `variants[].grid.size` 分组 → 每个尺寸一阶；阶的 `cellGrid` = 该阶变体网格里**去掉替换型/运行态位置**后的骨架（用同阶变体差分得到） |
| `rules[]` | 沿**单通道轴**差分同阶变体即可得到「哪些位置换成哪个调色板下标」；A1 的 `replaceValueChecks` 正是这条差分的实测样本 |
| 运行态相位规则 | idle/active 变体**只差控制器 1 格**（同 `registryId:meta`、两套下标）→ 一条 `setCell` 规则 + 两个下标 |
| `blockPalette` | `palette.json.blockPalette` 原样 |
| `materialPalette` / `textureBlobs` | `palette.json` 原样 |
| `variants[]` / `frames[]` | `variants[].key` 即契约键；`frames[].stepIndex` 由 `grid.size` 决定；`rules` 引用由差分得出 |
| 一致性自检 | T1.4 装配出的网格应与 `variants[].geometrySignature`、`paletteRefs` 逐格吻合 |

---

## 10. 对既有类的改动与写范围

**新增（全部在 `mod/gtnh/src/main/java/com/lightning/mod/client/multiblock/`）**：

| 文件 | 职责 |
|------|------|
| `VariantCaptureRunner.java` | 编排：变体枚举 → 构建 → 驱动 → 捕获 → 断言 → 落盘 → 跨运行比对 |
| `VariantGeometryBakery.java` | 逐格/锚定捕获、状态键与验证、`cellGrid` 与两类签名 |
| `GeometryPalette.java` | 全局调色板并集 + 内容签名去重 + 材质表 + 纹理嵌入 + 去重统计 |
| `VariantStateDriver.java` | 两态驱动 + `isActive()` 断言 + `activeMechanism`（含逃生门与原因） |
| `VariantMachineFacts.java` | 读 T1.2 `machines.json`（通道/取值表/总 Tier），尺寸规则换算 |
| `VariantCaptureAutomation.java` | 无人值守入口（触发文件 → 主菜单静置 → 跑 → 退出） |

**对既有类的小改（均可逐行说明）**：

1. `meshcapture/MeshCaptureService.java` —— **纯新增**一个公共嵌套类 `CaptureToolkit`（约 60 行），把
   「签名机制（`signatureOfGeometry/OfEntry/OfState`）」与「其直接依赖的条目构造原语（`airEntry/geometryOf/attachQuadMaterials/copy`）+ 全局材质表 `MaterialTable`」
   提升为公共工具，**零行为改动**（既有 private 方法一字未动，只是被转发）。这正是 T0.3 移交建议 #2 的要求：
   避免 `StateGeometryCapture` 那种「按同口径重写一份签名」的漂移。
2. `multiblock/MultiblockWorldBuilder.java` —— 新增 `build(target, trigger, hatchPlanCache)` 重载、
   `HatchPlan`/`HatchPlanCache`、`triggerWithChannels(...)`；`findHatchSkeleton` 拆成「缓存计划 + 校验」与
   「全量搜索」两条路；`BuildResult` 增加 `shapeKey`/`hatchPlanSource`/`metaTileInstanceHash`。
   **原 `build(ProbeTarget)` 语义不变**（内部委托新重载、`planCache=null`），T0.3 探针路径逐字节不受影响；
   另把「非 `MTEMultiBlockBase` 目标」从 `failure` 改成 note（T0.3 的两个目标都走不到这条分支，无回归）。
3. `multiblock/MultiblockScanAutomation.java` —— `isRequested` 多认一个触发文件、`tick` 顶部加 3 行分派。
   两个触发文件都不存在时行为与 T1.2 完全一致。
   （**为什么不去改 `client/automation/SdeClientAutomationTickHandler`**：那个文件不在 T1.3 写范围内；
   T1.2 已经把「触发文件 → 接管本 tick」的挂接点放在本包的 `MultiblockScanAutomation` 上，直接复用。）

**未改动**：`dependencies.gradle`（无新编译期符号）、`protocol/`、`web/`、`docs/plan/` 下其它文件；**未做 git commit**。

**产物**：`mod/gtnh/run/client/variant_capture/`（`run/` 已在 `mod/gtnh/.gitignore` 内，不入库）。

---

## 11. 可重复性证据

### 11.1 同一变体两次捕获，几何内容签名一致（硬约束）

`run-0014` vs `run-0015`（同一 jar、同一环境、先后两次无人值守运行）：

| 证据 | 结果 |
|------|------|
| `signatureComparison.allMatch` | **true** |
| 比对变体数 / 不一致数 | **842 / 0** |
| 4 个机器文件 SHA-256 | **两两逐字节一致**（`mteelectricblastfurnace.json` `08613a8e…`、`mtedistillationtower.json` `8938b102…`、`mtebrickedblastfurnace.json` `ec3869fc…`、`mtequantumforcetransformer.json` `eb0b3923…`） |
| `palette.json` | **逐字节一致**（`sha256 452a29be2905f2b717719850fa29a028b76017672dffcb7a80ec26865d998f59`） |
| `paletteContentSha256` | 两次均为 `e9377b6be15b8bf723c051143d71e9630be4ae3398e788e47828697c65bb2cc1` |
| 单轮耗时（会波动，非一致性判据） | 78.4 s（`run-0014`）／146.8 s（`run-0015`，同机另有构建任务） |

**跨 jar / 跨版本复核**（把「数据一致性」与「我改过的报告字段」分开）：

| 对比 | 结果 |
|------|------|
| `run-0009`（spotless 前编译） vs `run-0012`（spotless 后） | 机器文件**逐字节一致** → 代码格式化零行为影响 |
| `run-0013`（新计数口径 + 未格式化源码） vs `run-0014`（同口径 + 已格式化） | 4 个机器文件**逐字节一致** → 再次确认格式化无影响 |
| `run-0012` vs `run-0014` 的 EBF 机器文件 | 全文件**只差 3 行**（`fullCaptureVariants`/`sampledCaptureVariants` 计数与对应 A5 detail）——那是我**故意**改的计数分类口径；几何、签名、调色板、网格字段全部一致 |

### 11.2 同一方块状态在数据集中只存一份（去重统计）

| 项 | 值 |
|----|----|
| `internCalls`（变体 × 非空气位置的入库调用） | 6229 |
| `duplicateCapturesSuppressed`（同签名被去重掉的烘焙几何份数） | **6183** |
| `paletteEntries` / 非 air | **47 / 46** |
| `referenceEvents`（变体 × 位置引用总数） | **214,806** |
| `dedupRatio` | **99.25%** |
| `unreferencedEntries` | 1（只有 air） |

即：214,806 次引用最终只落在 47 条条目上，46 条非 air 条目条条被引用，没有重复保存、也没有死条目。

### 11.3 两态差异事实（不得编造，无差异也要记）

| 机器 | 对照对数 | 几何相同 | 几何不同 | 结构性差异 | 材质层差异 | 每对差异格数 |
|------|--------:|--------:|--------:|----------:|----------:|-------------:|
| EBF | 210 | 0 | 210 | **0** | 210 | 1（控制器） |
| DT | 110 | 0 | 110 | **0** | 110 | 1（控制器） |
| BBF | 1 | 0 | 1 | **0** | 1 | 1（控制器） |
| QFT | 100 | 0 | 100 | **0** | 100 | 1（控制器） |

示例（EBF `coil:0|tt:1`）：`z0/row3/x1: #5(gregtech:gt.blockmachines:2)[材质层]→#8(gregtech:gt.blockmachines:2)`。

**结论**：本轮运行态轴在 4 台机器上**全部**表现为「同一方块状态的两种贴图/材质」（`materialSwapOnly = true`），
没有任何一格出现结构性变化（`structuralDiffPairs = 0`）——与 T0.3 的裁决（只承诺纹理/材质层）和契约 §7.4 的
`runstateCoverage.geometryDelta = false` 一致。

---

## 12. 硬约束逐条核对（计划 T1.3 四条 + 本任务要求）

| # | 硬约束 | 落实位置 | 机器判据 | 结论 |
|---|--------|----------|----------|------|
| 1 | 几何真实可达，不得凭空合成 | `MultiblockWorldBuilder`（真实 `onItemUse` + `construct`）+ `VariantGeometryBakery`（逐格捕获） | 每个变体 `buildOk/geometryCoverageOk`；`captureMode`+`positionsCaptured` 落盘；0 个 `BlockWithoutGeometry` | ✅ |
| 2 | 调色板 = 所有变体并集，按内容签名去重（复用 `MeshCaptureService` 签名机制并提升为公共工具） | `GeometryPalette` + `MeshCaptureService.CaptureToolkit` | `paletteEntries 47` vs `internCalls 6229`；`dedupKey` 落盘；`unreferencedEntries=1`（air） | ✅ |
| 3 | 同一方块状态的烘焙几何全数据集只存一份 | 同上（内容签名全局唯一） | `duplicateCapturesSuppressed 6183`、`dedupRatio 99.25%`、`referenceEvents 214806` | ✅ |
| 4 | 运行态按 T0.3 结论真实驱动后捕获；断言 `isActive`；逃生门必须标注 | `VariantStateDriver` | 421/421 `assertionPassed`；`activeMechanism` 直方图（3 台走状态机、BBF 走逃生门并写明原因） | ✅ |
| 5 | 变体构建：注入只走 `placeBlock/spawnHint`；构建前复位实例状态；尺寸型先定骨架；布局签名断言 | §5.1–§5.4 | A1（19 项）/A2（28 组）/A3（10 项）/A4（421 次） | ✅ |
| 6 | 无人值守、可重复 | `VariantCaptureAutomation` + `MultiblockScanAutomation` 分派 | 7 次连续运行全自动、退出码 0；§11.1 的一致性表 | ✅ |
| 7 | `gradlew build` 通过 | — | `BUILD SUCCESSFUL`（含 `spotlessJavaCheck`） | ✅ |

---

## 13. 开放项与风险

| # | 项 | 说明 | 建议处置 |
|---|----|------|---------|
| 1 | **数据集不含 tooltip 与 TE NBT** | `palette` 条目 `nbt:null`、`tooltip:[]`。原因：TE NBT 含坐标/进度（会让同一几何分裂成多条，破坏「同状态只存一份」）；主菜单态 `thePlayer == null` 使 `ItemStack#getTooltip` 不可靠。几何渲染不依赖这两者（web 端用烘焙几何） | T1.5/T1.6（世界内导出）若需要 tooltip，可在那里按状态补 `tooltipPalette`；此时**去重键必须同步改口径**，不能悄悄变 |
| 2 | **同一 `registryId:meta` 有多条条目（4 个 key、共 18 条）** | GT 机器方块的appearance由 MTE 决定（不同舱口/控制器两态/不同机器） | T1.4/T1.5 必须按**每格下标**携带（我的 `cellGrid` 已经如此），不要试图用 `registryId:meta` 反查条目 |
| 3 | **BBF 的「真配方运行」未打通** | 逃生门只点亮活动纹理；BBF 自身还会在 active 时往世界里放岩浆（源码 `MTEBrickedBlastFurnace#onPostTick` 326–340），该副作用需要 `mMaxProgresstime > 0`（无公开 setter）或真实输入 | 与 T0.3 遗留 #2 同源；若要覆盖，需在 T1.5/T1.6 里为 `MetaTileEntity` 系多方块单独打通配方路径（含反射决策） |
| 4 | **状态键位置无关性是「抽样验证」而非穷举** | 位置数 > 24 的键只验证 8 格（EBF 的键都 ≤ 16 → 逐格验证；DT/QFT 的大键走抽样） | 已把「抽样数、验证结果、不稳定键」全部落盘；若 T3.x 发现某格几何异常，可把 `verifyPositionsPerKey` 调到极大重跑（代价量级：QFT 单台从 ~18 s 涨到 ~30 min） |
| 5 | **数据集偏大** | `run-0014/` 约 21 MB，其中 QFT 的 `machines/*.json` 18.6 MB（pretty-print 的 `[z][row][x]` 数组逐元素一行） | 需要的话可加一个紧凑落盘开关（Gson 非 pretty 或行内化 `cellGrid`），预计缩到 3–4 MB；当前 `run/` 已 gitignore，不影响仓库 |
| 6 | **`fullCaptureVariants` 口径** | 「逐格变体」= 该变体没有任何位置共享；EBF/DT 各只有 1 个（首个变体），其余 815 个变体至少共享 1 格 | 报告里已把 `逐格/新键抽样/锚定` 三档分列，调度者按此核对优化作用面 |
| 7 | **`glass` 37 档的上界争议（T1.2 §7.2）** | 本任务未涉及含 `glass` 通道的代表机（组合积会爆），故未验证 | 由 T1.5/T1.6 在全量导出时按 T1.2 建议取 37 |
| 8 | **`mWorks`（isAllowedToWork）初值** | 实测假世界里新放机器的 `isAllowedToWork() == false`，因此运行态机循环在第 1 tick 即判定「自我停工」，进态完全依赖三行派生（`driveMs` 总计 < 0.1 s / 421 次构建） | 这是环境事实、已落盘（`build.selfDisabled`、`runState.stateMachineTicks`）；若将来某机 `mWorks` 初值为 true，循环会跑满 140 tick 并真实触发 `checkMachine`，行为仍正确（只是更慢） |
| 9 | **首版在 QFT 上跑到进程终止（已解决，但根因未定位）** | 首版实现是「每个变体全量逐格捕获 + 全量验证」：QFT 结构 933 格，一次逐格捕获 ~16 s，而每个 (manipulator, shielding) 组合都会引入新方块状态 → 100+ 次全量捕获。该轮 `runClient` 在 22 分钟后以 `BUILD FAILED` 结束，**日志无异常、无 crash-report、无 `hs_err_pid`**（疑似 JVM 被外部杀掉；我当时的输出被 `Select-String` 过滤，未留全量 gradle 日志） | 已通过 §7.2 的状态键抽样验证把单台降到 ~18 s，问题不再复现（后续 6 轮运行全部正常）；若要彻底定位，可在 CI 上重放首版实现并保留完整 stdout/stderr 与 JVM 指标 |

---

## 14. 附：关键代码位置

| 用途 | 位置 |
|------|------|
| T1.3 编排 | `client/multiblock/VariantCaptureRunner.java` |
| 捕获与状态键 | `client/multiblock/VariantGeometryBakery.java` |
| 调色板/去重/纹理 | `client/multiblock/GeometryPalette.java` |
| 运行态驱动 | `client/multiblock/VariantStateDriver.java` |
| T1.2 事实层读取 | `client/multiblock/VariantMachineFacts.java` |
| 无人值守入口 | `client/multiblock/VariantCaptureAutomation.java`（分派点：`MultiblockScanAutomation`） |
| 公共捕获工具（新增嵌套类） | `client/meshcapture/MeshCaptureService.java#CaptureToolkit` |
| 变体构建/舱口计划 | `client/multiblock/MultiblockWorldBuilder.java` |
| 触发文件 | `mod/gtnh/run/client/sde_variant_capture.json` |
| 产物 | `mod/gtnh/run/client/variant_capture/run-0014/`、`run-0015/`（+ `latest.json`） |
