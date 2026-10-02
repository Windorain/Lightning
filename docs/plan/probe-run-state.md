# T0.3 运行态可达性探针

> **任务**：`multiblock-channel-renderer-plan.md` T0.3 —— 回答《需求书》风险 1：能否在假世界（DummyWorld + FakePlayer）里让 GT 多方块
> **真实进入"运行中"态**（活动纹理 / TESR 活动表现 / 部件展开），并捕获两态几何差异作为证据。
> **结论口径**：本文把"运行态"拆成三层分别给结论（渲染表现 / 状态机派生 / 配方真实运行），不含糊其辞。
> **证据落盘**：`mod/gtnh/run/client/runstate_probe/run-0001/`、`run-0002/`（JSON，含两态签名、材质直方图、逐格差异与样本）。
> **触发方式**：`<mcDataDir>/sde_runstate_probe.json` 存在 → `gradlew runClient` → 全自动跑完并自行退出（零人工交互）。

---

## 0. 结论（TL;DR）

| # | 问题 | 结论 | 证据 |
|---|------|------|------|
| 1 | 假世界是否满足 `onPostTick` 的**服务端门槛**（`isServerSide()`）？ | **可达** | `dummyWorldIsRemote=false`；`errorDisplayID` 从 0 变 127（该字段只在服务端分支被写）→ `serverBranchExecuted=true`（run-0001/0002 两态探针，两台目标一致） |
| 2 | 能否让活动态**由运行态机派生**出来？ | **可达** | 把 `checkRecipe` 成功时写入的同一 public 字段 `mMaxProgresstime` 依次置 `0 → 200 → 0`，每步跑一 tick `onPostTick`，`isActive()` 实测 `false → true → false`（两台目标一致）；即 `setActive(mMaxProgresstime > 0)` 派生链在假世界成立 |
| 3 | 活动态是否**真实改变烘焙几何**？ | **可达（活动纹理轴）** | 待机/运行两态签名不同，差异集中在控制器所在格：EBF `+2/-2 = 4` 个四边形；ExoFoundry `+2/-2 = 4`。材质直方图差异**恰好**是 `OVERLAY_FRONT_*`（inactive）↔ `OVERLAY_FRONT_*_ACTIVE` 与各自的 `_GLOW` |
| 4 | **TESR 活动表现**是否可达/可捕获？ | **部分可达：TESR 被调用，但几何拿不到** | 控制器 TE 有 special renderer（`BaseMetaTileEntityRenderer`）且 `MTEExoFoundry implements IMTERenderer`（`renderTESR` 以 `isActive()` 为门槛）；但两态下"动态扩展顶点录制"的四边形数均为 **0** —— 该 TESR 走 shader/VAO + 延迟后处理（`PostProcessingManager`），不经过 Tessellator，因此本仓库基于 Tessellator 的捕获机制**看不到它** |
| 5 | **部件展开**（由运行态生成/展开的附属渲染几何）是否可达？ | **探针范围内不可达**（需真实配方运行） | GT5U 全库只有 1 台多方块控制器实现 `IMTERenderer`（`MTEExoFoundry`）；其余"部件"（`RenderingTileEntityWormhole/Laser/Blackhole/NanoForge`）都是机器**运行中**才创建的附属渲染方块，`construct`/`checkStructure` 阶段不存在 |
| 6 | "**结构成形**（`mMachine=true`）+ 真实配方在跑"？ | **未达成（部分可达）** | EBF 结构被真实放置（34 格）、线圈档位实测 `LV`、静音仓/维护仓/能量仓/输出仓各 1 个被 GT 自己的舱口清单接受、`getStructureErrors()` 为空，但 pinned 版 `checkMachine` 仍返回 `false` → `mMachine` 始终 `false`（`structureCheckTick=-1`）。**运行态是靠"状态机 + 显式驱动量"到达的，不是靠配方在跑** —— 见 §4 |

> **对风险 1 的判定**："运行态"轴的**渲染可达性**成立（活动纹理 = 可达；状态机派生链 = 可达），**不构成"不可达"**。
> 但有两条**明确拿不到**的表现：① 经 shader/VAO + 延迟后处理的 TESR 几何（`MTEExoFoundry` 的环）；② 由真实配方运行才生成的附属渲染方块（虫洞/激光/黑洞/纳米锻炉）。
> ③「结构成形 + 配方运行」这条最"实"的路径在探针预算内未走通（原因定位到 `checkPiece`，见 §4.3 遗留项）。

---

## 1. 结论一句话（给调度者）

**可达（渲染/状态机轴可达，活动纹理两态几何差异已实测并有两次运行一致的签名）；TESR 活动表现"调用得到、几何拿不到"；由真实配方运行才出现的附属渲染部件在探针范围内不可达。**

---

## 2. 探针做了什么（实现要点）

代码位置：`mod/gtnh/src/main/java/com/lightning/mod/client/multiblock/`（新包，T1.1 的基础设施雏形）。

| 文件 | 职责 |
|------|------|
| `ProbeDummyWorld.java` | 假世界：`extends World`，方块/元数据/TE 全部落在本地 Map（不落盘、不触碰真实存档）；`isRemote=false`（= GT 眼里的服务端侧）。内含 `ProbeChunkProvider` / `ProbeSaveHandler`。另有 `placedPositions()`/`blocksPlaced()` 供确定序遍历与"结构还在长吗"的判据 |
| `ProbeFakePlayer.java` | 假玩家：真实构造钩子 `ItemStack#onItemUse` 与自动放置都需要一个 `EntityPlayer` |
| `ProbeTarget.java` | 目标解析：按**类名**在 `GregTechAPI.METATILEENTITIES` 里取运行时注册实例（不硬编码 meta id）；默认目标集 = EBF + ExoFoundry |
| `MultiblockWorldBuilder.java` | ① `ItemStack#onItemUse(stack, FAKE_PLAYER, dummyWorld, x,y,z, 0, …)` 真实放控制器；② `IConstructable#construct(trigger, hintsOnly=false)` 真实建结构（走 `placeBlock` 通道，符合 T0.4 R4）；③ **舱口骨架搜索**；④ readiness 快照 |
| `RunStateDriver.java` | ① 真实 TE 更新路径 `TileEntity#updateEntity()`×3（GT 的 `CommonBaseMetaTileEntity#updateEntity()` 是 `final`，内部即 `updateEntityProfiled()` → `onPostTick`）；② 运行态机本体循环 `onPostTick`×115（跑满 `mStartUpCheck` 100 的启动计数，让 `checkStructure` 真实执行）；③ **派生关系实验**（`mMaxProgresstime` 0→200→0） |
| `StateGeometryCapture.java` | 两态烘焙几何：复用 `TessellatorCaptureState` + `BlockPrimaryCaptureRegistry` + `MeshCaptureBlockPostRenderRegistry` + `MaterialKeyResolver`，**对假世界**逐格捕获；产出内容签名与逐格差异 |
| `RunStateProbe.java` | 单台目标的编排 → 结果 JSON（世界事实 / 运行态 trace / 两态 / 差异 / TESR） |
| `RunStateProbeRunner.java` | 多目标运行、文件布局、**与上一次运行的签名自动比对**（可重复性的机器判据） |
| `RunStateProbeAutomation.java` | 无人值守入口：触发文件 → 等主菜单 → 跑探针 → 落盘 → `Minecraft.shutdown()` |

触发挂接（最小改动，`client/automation/`）：`SdeClientAutomationTickHandler#onClientTick` 顶部加一个「触发文件存在则接管本 tick」的分支；
并把原本私有的自动进档逻辑抽成 `public static joinFirstSingleplayerWorld(Minecraft)` 供探针复用（`first-save` 模式用）。
**触发文件不存在时该分支不产生任何行为**，因此既有 `/sde export` 与既有自动化路径不受影响。

### 2.1 舱口骨架搜索（探针顺带产出的可复用设施）

`construct()` 只放机壳/线圈，**不放舱口**：`HatchElement`/`buildHatchAdder` 的 `placeBlock` 只写 hint（T0.4 §2.3.1 已记录）。
而 `MTEMultiBlockBase.checkStructure` 会拒绝缺舱口的结构（EBF 的 `'m'` 位由 `HatchElement.Muffler` 校验、`checkMachine` 又要求
`mMaintenanceHatches.size()==1`）。探针的做法：

```
对每种舱口类型（muffler → maintenance → energy → input/output hatch/bus → dynamo）依次：
  对结构包围盒内每个未占用坐标：
    清成空气 → 用该舱口的 getStackForm(1) 走 onItemUse 放上去 → multi.checkStructure(true, baseTile)
    若 multi.mMachine 变 true            → 完成
    否则若该类型在 GT 的公开舱口清单里 +1  → 保留该格，换下一种类型
    否则                                 → 回滚该格
```

判据用的是 **GT 自己的公开清单**（`mMufflerHatches` / `mMaintenanceHatches` / `mEnergyHatches` / `mInputHatches` /
`mOutputHatches` / `mInputBusses` / `mOutputBusses` / `mDynamoHatches`，全部 public），**不写 `mMachine` 字段**、不伪造状态。
EBF 实测结果：`muffler@8,67,9`、`maintenance@7,64,8`、`energy@9,64,8`、`output_hatch@7,67,8`（均在合法符号位，与 EBF 真实外形一致：静音仓在顶部、维护仓在底部环）。

---

## 3. 证据：两态几何对比

两次运行（`run-0001` / `run-0002`）+ 一次 spotless 格式化后的复跑（`run-0003`，签名全同），`worldMode=none`（主菜单态运行，探针自带假世界，不进真实存档）。
探针自身耗时 **759 ms / 677 ms / 701 ms**；`runClient` 全程（启动→探针→自动退出）约 **60–70 s**。

### 3.1 `MTEElectricBlastFurnace`（活动纹理代表，1 通道 coil）

结构：`construct(trigger, hintsOnly=false)` 真实放置 **34 格**（控制器 1 + 机壳 17 + 线圈 16），线圈档位实测 **LV**，
`hatchPlacements = muffler@8,67,9 | maintenance@7,64,8 | energy@9,64,8 | output_hatch@7,67,8`，
`getStructureErrors()` = **空**，`mMachine` = **false**（见 §4.3）。

| 项 | 待机（`mMaxProgresstime=0`） | 运行（`mMaxProgresstime=200`） |
|----|------------------------------|-------------------------------|
| `isActive()` 实测 | `false` | `true` |
| 捕获格数 / 四边形数 | 34 格 / **211** | 34 格 / **211** |
| 内容签名 | `MYxm8r/VE0FNSn8du0mKgNPOyL+2xiD6Z2GyDq/f/fg=` | `imfu5DpCOYR0fhyWQ5vYUzFeNNOT85/CTZUgmoqRL1U=` |
| 材质直方图（关键项） | `…HEATPROOFCASING:102`，`…COIL_CUPRONICKEL_BACKGROUND:96`，`OVERLAY_FRONT_ELECTRIC_BLAST_FURNACE:1`，`OVERLAY_FRONT_ELECTRIC_BLAST_FURNACE_GLOW:1` | 同上，但两条 overlay 变为 `OVERLAY_FRONT_ELECTRIC_BLAST_FURNACE_ACTIVE:1` + `…_ACTIVE_GLOW:1` |
| 动态扩展（TESR）四边形 | 0 | 0 |

差异：`changedPositions=1`（就是控制器 `8,64,8`），`addedQuads=2 / removedQuads=2 → differingQuads=4`，
`signaturesIdentical=false`。差异**只**出现在控制器正面（NORTH 朝向，`renderAllFaces=true` 下所有面都会被画）：
非 glow 覆盖层与 glow 覆盖层各换了贴图（glow 层亮度 `15728880` vs 普通层 `15728640`，也在签名里体现）。

### 3.2 `MTEExoFoundry`（TESR 代表，`implements IMTERenderer`）

结构：`structurePlan=NONE`（只放控制器，1 格）——因为它 15×55×15 的巨大结构对本问不必要，本机用来回答"TESR 活动表现"。

| 项 | 待机 | 运行 |
|----|------|------|
| `isActive()` 实测 | `false` | `true` |
| 四边形数 | **8** | **8** |
| 内容签名 | `R9bp/d+Rad+Uy9hvYXj3APOn63WzX86oORKq0/miHJ4=` | `QXXViNp5TcUKUYUQT49iJfKlcS0vYY68VkHoKNHn39o=` |
| 材质 | `EXOFOUNDRY_CASING:6` + `OVERLAY_FRONT_EXOFOUNDRY:1` + `…_GLOW:1` | 同上，overlay 变为 `…_ACTIVE:1` + `…_ACTIVE_GLOW:1` |
| **动态扩展（TESR）四边形** | **0** | **0** |

TESR 事实链（全部落在结果 JSON 的 `tesr` 段）：
`controllerTileEntityClass = gregtech.api.metatileentity.BaseMetaTileEntity`、
`controllerTileEntityHasSpecialRenderer = true`（→ `TileEntitySpecialRendererPostRenderStrategy` 会真的调用 `renderTileEntityAt`）、
`metaTileImplementsIMTERenderer = true`（→ `BaseMetaTileEntityRenderer` 会转发到 `MTEExoFoundry#renderTESR`）、
其实现首行即 `if (!shouldRender || !getBaseMetaTileEntity().isActive()) return;`（源码 `MTEExoFoundry.java:913-916`）。
**即：TESR 的调用与门槛都成立，但它产生的几何不经 Tessellator**（`initializeRender()` 编译 GLSL、`PostProcessingManager.addDelayedRenderer`
把渲染推迟到 `RenderWorldLastEvent`），所以基于 Tessellator 的捕获在两种状态下都只能是 0 四边形 —— 这不是"状态没到"，是**捕获机制覆盖不到**。

### 3.3 可重复性（三次运行签名一致）

`run-0002/result.json → signatureComparison.allMatch = true`（对 run-0001），
`run-0003/result.json → signatureComparison.allMatch = true`（对 run-0002，且 run-0003 是 **spotless 格式化后重新编译的产物**）。逐台逐态：

| 目标 | 待机签名一致 | 运行签名一致 | 差异四边形数一致 |
|------|--------------|--------------|------------------|
| `MTEElectricBlastFurnace` | ✅ `MYxm8r/VE0FNSn8du0mKgNPOyL+2xiD6Z2GyDq/f/fg=` | ✅ `imfu5DpCOYR0fhyWQ5vYUzFeNNOT85/CTZUgmoqRL1U=` | ✅ 4 |
| `MTEExoFoundry` | ✅ `R9bp/d+Rad+Uy9hvYXj3APOn63WzX86oORKq0/miHJ4=` | ✅ `QXXViNp5TcUKUYUQT49iJfKlcS0vYY68VkHoKNHn39o=` | ✅ 4 |

两次签名（同一次运行内的两态，EBF）：
- 待机：`MYxm8r/VE0FNSn8du0mKgNPOyL+2xiD6Z2GyDq/f/fg=`
- 运行：`imfu5DpCOYR0fhyWQ5vYUzFeNNOT85/CTZUgmoqRL1U=`

### 3.4 落盘产物

```
mod/gtnh/run/client/runstate_probe/
  run-0001/
    mteelectricblastfurnace.json   # 世界事实 / 运行态 trace / 两态（含样本与材质直方图）/ 差异 / TESR
    mteexofoundry.json
    result.json                   # 本次汇总 + 与上一次运行的签名比对
  run-0002/…                      # 同上（result.json.signatureComparison 全绿）
  latest.json
```

---

## 4. 实现细节与坑（这些是 T1.1/T1.3 真正要复用的部分）

### 4.1 假世界满足服务端门槛的**实测**方式

`BaseTileEntity#isServerSide()` 的实现是 `!worldObj.isRemote`（源码 `BaseTileEntity.java:167-173`），`ProbeDummyWorld` 用 `World` 构造器建立 →
`isRemote=false`。但"字段推论"不等于"分支真的跑了"，所以探针用**只有服务端分支才有的副作用**来证明：
`MTEMultiBlockBase.onPostTick` 的服务端分支会写 `errorDisplayID`（`MTEMultiBlockBase.java:623-630`），客户端分支只 `startActivitySound()`。
实测 `errorDisplayIdBefore=0 → errorDisplayIdAfterRealPathTicks=127` → `serverBranchExecuted=true`。**两台目标两次运行都是这个结果。**

### 4.2 派生关系实测（不是"推测可达"）

`checkRecipe(ItemStack)` 成功时写 `mMaxProgresstime = processingLogic.getDuration()`（`MTEMultiBlockBase.java:1066`），
`onPostTick` 末尾 `setActive(mMaxProgresstime > 0)`（`:632`）。探针直接操纵这**同一个 public 字段**（`javap` 实证 public）：

```
idle      : mMaxProgresstime=0   → tick onPostTick → isActive()=false
running   : mMaxProgresstime=200 → tick onPostTick → isActive()=true
idle-again: mMaxProgresstime=0   → tick onPostTick → isActive()=false
```

即活动位确实由运行态机从该字段**派生**，而不是探针硬写 `setActive`（探针里另有逃生门 `IGregTechTileEntity#setActive`（`IMachineProgress`）
作为兜底，本次**两台目标都没用到**，`activeMechanism` 记录的均为 `onPostTick` 服务端分支）。
**边界**：`mMaxProgresstime` 是探针置的（模拟"配方已开始"），不是 `checkRecipe` 自己算出来的 —— 因为没有可用的能源/输入/配方环境（见 §4.3、§5）。

### 4.3 结构成形（`mMachine=true`）未达成：已缩小到 `checkPiece`

诊断（都记进了 JSON）：
- `nonAirBlocksAfterBuild=34`（控制器 1 + `'f'`环 8 + 线圈 16 + `'b'`环 8 + 静音仓 1；结构串里两个 `'-'` 位正确地保持空气）；
- 线圈：`coilLevelAfterSkeleton = LV`（`MTEAbstractMultiFurnace#getCoilLevel()`，公开方法）→ 线圈符号**通过**；
- 舱口：`muffler=1 maintenance=1 energy=1 outputHatch=1`（GT 自己的公开清单）→ 这四个符号**通过**；
- `getStructureErrors()`（public，`gregtech.api.enums.StructureError` 枚举集）**为空**；
- 但 `multi.mMachine == false`，且 115 次 `onPostTick` 里**从未**翻成 true（`structureCheckTick=-1`）。

用 `javap -c` 反查 pinned 版 `MTEMultiBlockBase.checkStructure`，`mMachine` 的唯一来源是 `checkMachine(base, mInventory[1])`；
pinned 版 `MTEElectricBlastFurnace.checkMachine` = `checkPiece(MAIN,1,3,0) && getCoilLevel()!=None && mMaintenanceHatches.size()==1`。
后两项实测通过、错误集为空 → **失败点落在 `checkPiece`**（某个符号位未通过），但探针没有做**位级**诊断，未能定位是哪一格。
→ 列为遗留项（§5 第 1 条），并给出可执行的下一步：对 `IStructureDefinition#check` 逐符号/逐位调用，或读 `structureErrorContext`。

### 4.4 三个必须知道的环境/机制坑（T1.6 会直接撞上）

1. **CoFH ASM 在找不到 MCP conf 时会弹 Swing 目录选择框，直接卡死启动且日志无输出。**
   `cofh.asm.LoadingPlugin.<clinit>` → `ObfMapping$MCPRemapper.confDirectoryGuess` → `JFileChooser.showDialog`（线程 dump 实证：
   Server/主线程停在 `java.awt.WaitDispatchSupport.enter`）。它的候选路径里有 `user.home/.gradle/caches/minecraft/net/minecraftforge/forge/<mc>-<forge>/unpacked/conf`，
   而本机 `GRADLE_USER_HOME=C:\gradle-cache`、`~/.gradle` 根本不存在 → 全部落空。
   **本机处置（环境侧，非仓库改动）**：建目录联接 `C:\Users\<user>\.gradle\caches\minecraft\net\minecraftforge\forge\1.7.10-10.13.4.1614[-1.7.10]\unpacked` → `C:\gradle-cache\...\unpacked`。
   → **T1.6 必须把这个前提写进管线前置检查**（或改用不依赖 CoFH conf 探测的路径），否则无人值守会在启动阶段静默挂住。
2. **进"有缺失模组的既有存档"会与 FML 的确认框互锁，并且确认后会改写该存档。**
   `StartupQuery.confirm`（`Loader.fireMissingMappingEvent` → `GameData.processIdRematches`）在客户端弹确认框，
   Server 线程 `CountDownLatch.await`，而 `Minecraft.launchIntegratedServer` 又在 Client 线程 `Thread.sleep` 等世界 → **互等死锁**
   （线程 dump 实证两侧栈）。本环境首个存档 `test` 含缺失模组（BloodArsenal 等）的 ID rematch；就算应答了，客户端随后还会因
   `dimension 180` 的 provider 不存在而崩溃。
   → **T1.6 的"自动进世界"必须**：① 用 `-Dfml.queryResult=confirm` 自动应答（FML 支持该属性，`javap` 实证字符串 `fml.queryResult`）；
   ② 优先**新建/使用干净的专用世界**，不要加载玩家存档；③ 明确世界选择策略（`SaveFormatComparator` 排序的首个存档不一定可用）。
   → 本探针据此把默认模式定为 `world=none`（主菜单态运行，探针自带假世界）。
3. **主菜单态下 TESR 补画会因 `renderViewEntity == null` 抛 NPE 被整条吞掉。**
   `TileEntitySpecialRendererPostRenderStrategy` → `VanillaTileEntityRenderEnvironment.cacheActiveRenderInfo` →
   `TileEntityRendererDispatcher#cacheActiveRenderInfo`，1.7.10 的实现会解引用该实体（`prevRotationYaw/rotationYaw/…`）。
   症状是日志一句 `TileEntitySpecialRendererPostRenderStrategy failed: null`，**没有任何几何**。
   探针的处置：捕获期间临时把 `mc.renderViewEntity` 指向假玩家，捕获结束立刻还原（`StateGeometryCapture.capture`）。
   修复后该策略 0 次失败，TESR 调用链真的跑起来了（也正因此才能给出 §3.2 的 0 四边形结论，而不是"没跑到"）。

### 4.5 依赖

`dependencies.gradle` 追加 **3 行显式 `compileOnly`**（`transitive=false`，与运行期解析版本锁步）：
`GTNHLib:0.9.62`、`ModularUI2:2.3.43-1.7.10`、`Applied-Energistics-2-Unofficial:rv3-beta-834-GTNH`。
原因：`transitive=false` 之后，GT5U 公开签名/接口继承链上的 `CapabilityProvider`（gtnhlib）、`IGuiHolder`（ModularUI2）、
`ICraftingIconProvider`（AE2）不在编译类路径上。已同步记录到 `decision-deps-route.md` §6.1。

---

## 5. 遗留问题与风险

| # | 项 | 影响 | 建议 |
|---|----|------|------|
| 1 | **`checkMachine` 失败点未定位**（`checkPiece` 返回 false，其余条件实测通过） | "成形机器 + 真实配方运行"这条最实的路径没走通；T1.3 若要求"运行态 = 配方在跑"，需要先解决 | T1.3 前加**位级诊断**：逐符号/逐位调用 `IStructureDefinition#check`（或读 `structureErrorContext`、对每个位置单独 check），把失败格打出来；也可先换一台舱口需求更简单、或结构更小的机器做对照组 |
| 2 | **配方未真实运行** | 运行态是"状态机 + 显式 `mMaxProgresstime`"到达的，不是"能源+输入+配方"到达的 | 若需要真配方：EBF 要输入总线物品 + 能量仓 EU + 温度匹配；建议在 T1.3 里为 1 台机器单独打通一次（可作为"运行态=真配方"的加固证据） |
| 3 | **TESR 几何捕获不到**（shader/VAO + 延迟后处理） | "TESR 活动表现"轴只能标"调用得到、几何拿不到" | 若必须捕获：需要为 `IMTERenderer`/`I3DGeometryRenderer` 追加**非 Tessellator** 的捕获策略（拦截 `renderAllVAO`/shader uniform 或读延迟渲染队列），这是独立工作量，建议单列任务；否则在 T1.3 里把该轴明确标为"不支持"并在文件格式中声明 |
| 4 | **附属渲染方块（部件展开）需要运行中才会创建** | wormhole/laser/blackhole/nanoforge 这类"部件"在 `construct`/`checkStructure` 阶段不存在 | 与 #2 绑定：真配方跑通后再评估；否则同样在格式/文档中显式声明不支持 |
| 5 | 探针只在**主菜单态**运行（不进世界） | 未验证"在世界内 + 探针世界"的共存（例如 `mc.theWorld` 非空时 TESR 的 `renderViewEntity` 本就不为空） | T1.6 打通"自动进干净世界"后，把 `world: first-save`（或新增 `fresh`）模式复跑一次探针，即可覆盖该组合 |
| 6 | 依赖锁步 | `GTNHLib` 版本来自运行期冲突解析（声明 0.9.20 → 实际 0.9.62） | 已写进 `dependencies.gradle` 注释；升级 GT5U 时按 `decision-deps-route.md §5.4` 同步核对 |
| 7 | `construct()` 读实例状态（T0.4 R5） | EBF 不受影响，但 `MTEIndustrialCokeOven` 等会 | 沿用 T0.4 结论：构造前显式设置相关字段；探针的 `construct` 前已固定 `setFrontFacing`，未做更一般的实例态复位 |

---

## 6. runClient 冒烟观察（同时覆盖 T0.2 §6.3-2 遗留项）

本次共跑了 4 次 `gradlew runClient`（3 次探针成功 + 1 次失败的进档尝试），观察如下：

- **编译期依赖路线未破坏运行期**：运行时类路径仍是 `runtimeOnlyNonPublishable` 那套（`GT5-Unofficial-5.09.52.283`、`StructureLib-1.4.28`、
  `NotEnoughItems-2.8.93`、`ModularUI2-2.3.43-1.7.10`、`AE2 rv3-beta-834-GTNH`、`GTNHLib-0.9.62`…），`compileOnly` 只增加编译期可见性；
  客户端正常装载 **79 个 mod** 并到达主菜单，`lightning` mod 正常加载（`lightning-0.3-dev.jar`）。
- **探针全自动**：主菜单 → 探针执行 → JSON 落盘 → `Minecraft.shutdown()` 自行退出，退出码 0，全程零点击。
- **既有 `/sde` 路径未受影响**：探针分支由触发文件门控（不存在时零行为）；`SdeClientAutomationTickHandler` 的原有逻辑（配置开关、
  指令文件、队列执行、退出）除"抽出静态进档方法"外一字未动；`SdeAutomationConfig` 未改动；`/sde export` 相关类（`CommandSde`、
  `SceneEnvelopeBuilder`、`MeshCaptureService`…）未被修改。
  **未做** `/sde export` 的端到端实跑：它需要选区/玩家交互，而本环境的可用存档存在 §4.4(2) 的缺失模组问题（进档会改写存档），
  故改为"结构性论证 + runClient 全量启动 + 产物 jar 否定性检查"，并在 §5 中留档。若调度者要求端到端 `/sde export` 回归，
  需先解决"干净世界"问题（T1.6 的同一问题）。
- **未发现新的崩溃/异常**：除上述环境坑（已处置）外，无 crash-report 由本次改动产生。

---

## 7. 交给 T1.1–T1.3 的移交建议

1. **直接复用本包**（`client/multiblock/`）：`ProbeDummyWorld` + `ProbeFakePlayer` 就是 T1.1 要的假世界；`MultiblockWorldBuilder` 的
   "真实控制器放置 + `construct(hintsOnly=false)` + 舱口骨架搜索"是 T1.2/T1.3 变体构建的骨架；`StateGeometryCapture` 是 T1.3 的几何捕获入口。
2. **把签名机制提升为公共工具**：`MeshCaptureService` 的 `geometrySignature`/`fullEqualitySignature` 是 private，探针按同口径重写了一份
   （`StateGeometryCapture.quadKey` + `sha256Base64`，4 位小数、四边形内顶点排序、四边形间排序）。建议 T1.3 把二者合并为一处 public 工具，
   避免两套签名长期漂移。
3. **运行态驱动接口固化**：T1.3 需要的"进入运行态"就三行 —— 置 `mProgresstime=0`、`mMaxProgresstime=<模拟时长>`、
   调一次 `onPostTick(base, tick)`；断言 `base.isActive()==true` 后再捕获。逃生门 `IGregTechTileEntity#setActive(boolean)` 仅在
   `mMachine==false`（结构未成形）时兜底，且必须在产物里标注用了哪条路（本探针的 `activeMechanism` 字段就是这么设计的）。
4. **TESR 轴先按"不支持"设计**：文件格式里为"运行态"留通道时，只承诺**纹理/材质层**的两态差异；对 shader/VAO 型 TESR 与
   运行中才生成的附属渲染方块，先在格式/文档里声明"不覆盖"，别把它塞进 T1.3 的完成定义。
5. **T1.6 请先读 §4.4**：CoFH conf 目录、FML `-Dfml.queryResult=confirm`、干净世界三件事不解决，"无人值守进世界"必然不稳。
6. **`client/multiblock/` 的类隔离仍然成立**：这些类只在触发文件存在时被加载；`client/automation/` 里的挂接不引用任何 GT 类型，
   因此 GT 缺席时不会 `NoClassDefFoundError`（与 `decision-deps-route.md §7` 的类隔离纪律一致）。

---

## 8. 附：关键代码位置（本仓 + 上游）

| 用途 | 位置 |
|------|------|
| 探针包 | `mod/gtnh/src/main/java/com/lightning/mod/client/multiblock/`（9 个类） |
| 触发挂接（最小改动） | `client/automation/SdeClientAutomationTickHandler.java`（顶部探针分支 + `joinFirstSingleplayerWorld` 改 public static） |
| 几何捕获/签名复用点 | `client/meshcapture/TessellatorCaptureState.java`、`…/primary/BlockPrimaryCaptureRegistry.java`、`…/postrender/MeshCaptureBlockPostRenderRegistry.java`、`…/MaterialKeyResolver.java`、`MeshCaptureService.java`（签名算法对齐） |
| 探针产物 | `mod/gtnh/run/client/runstate_probe/run-0001|run-0002/`（+ `latest.json`） |
| `onPostTick` 服务端分支 / 派生 | `GT5U …/MTEMultiBlockBase.java:598`、`:632`、`:644` |
| `isServerSide` 实现 | `GT5U …/BaseTileEntity.java:167-173` |
| `checkRecipe` 写 `mMaxProgresstime` | `GT5U …/MTEMultiBlockBase.java:1066` |
| `checkStructure` 的 `mMachine` 来源 | pinned `MTEMultiBlockBase.checkStructure`（`javap -c`：`checkMachine(...)` → `putfield mMachine`） |
| EBF 结构/校验/纹理三态 | `GT5U …/MTEElectricBlastFurnace.java:69-92`、`:158-181`、`:220-233` |
| ExoFoundry 的 TESR | `GT5U …/MTEExoFoundry.java:913-925`（`isActive()` 门槛）、`:1027+`（延迟渲染描述）、`BaseMetaTileEntityRenderer.java:11-16` |
| CoFH conf 目录探测（卡死点） | `cofh-core-…jar!/cofh/repack/codechicken/lib/asm/ObfMapping$MCPRemapper.confDirectoryGuess` |
| FML 自动应答属性 | `recompiled_minecraft-1.7.10.jar!/cpw/mods/fml/common/StartupQuery`（字符串 `fml.queryResult`，值 `confirm`/`cancel`） |
