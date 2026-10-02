# T1.2 多方块枚举 + 通道/等级探测 — 探测报告

> **任务**：`multiblock-channel-renderer-plan.md` T1.2 —— 枚举全部 GT 多方块（`IConstructable`），探测每台的总 Tier 域、
> 通道清单、每通道最大取值，产出结构化数据文件供 T1.3/T1.4 消费。
> **证据落盘**：`mod/gtnh/run/client/multiblock_scan/run-0001|run-0002/`（JSON）+ `latest.json`。
> **触发方式**：`<mcDataDir>/sde_multiblock_scan.json` 存在 → `gradlew runClient` → 全自动跑完并自行退出（零人工交互）。
> **上位依据**：[multiblock-channel-renderer-plan.md](multiblock-channel-renderer-plan.md) §3 T1.2、§10 勘误；
> [probe-channels.md](probe-channels.md)（T0.4，通道语义 + R6）；[probe-run-state.md](probe-run-state.md)（T0.3，设施与坑）；
> [decision-deps-route.md](decision-deps-route.md)（T0.2，依赖路线）。

---

## 0. 结论摘要（TL;DR）

| 项 | 数字 / 结论 |
|----|-------------|
| 枚举到的多方块 | **221**（`METATILEENTITIES` 非 null 槽位 3000 → `∩ IConstructable` = 221） |
| 探测成功 | **221 / 221**，**失败 0** |
| 有具名通道的多方块 | **67 台**（最多 4 通道：`MTEMultiAutoclave`/`MTEChemicalPlant`；共 **99 条**「多方块 × 通道」记录） |
| **仅总 Tier（无具名通道）** | **154 台**（占 70%；这是 T2.4「无具名通道只显示 Tier 滑杆」的真实样本池） |
| 出现的通道键（`{enumName,id}` 双键） | **23**（22 个 id；`casing` 一条 id 对应 3 个枚举名，见 §4） |
| 通道分类分布 | 替换型 **89**、尺寸型 **10**、舱口布局型 **0**（本环境没有机器走到 `gt_hatch`，见 §7.3） |
| 取值域来源 | `probed` 87、`source-table` 11、`fallback(registry)` 1、`fallback` **0** |
| 总 Tier 域 | 1..47 实测稳定；1 台（`MTENeutronActivator`）在 64 截断（`probed-capped`） |
| 两次运行一致性 | `machines.json` **逐字节相同**（751,876 B，SHA-256 `439c4355…`），`enumeration.json`/`registry.json` 亦逐字节相同 |
| `gradlew build` | 通过（含 spotless） |
| 探测耗时 | 单轮 3.4–3.5 s（不含 ~55 s 的 `runClient` 启动） |

---

## 1. 运行环境与版本锚点

本报告的全部数字只在下列环境上成立（落盘于 `run-*/environment.json`）：

| 项 | 值 | 来源 |
|----|----|------|
| Minecraft | 1.7.10 / Forge | `environment.json` |
| GT5-Unofficial | `5.09.52.283`（mod 版本串显示 `MC1710`；`gradle.properties#gtnhRun.gt5Version`） | `dependencies.gradle` + `environment.json` |
| StructureLib | `1.4.28` | `environment.json#mod.structurelib` |
| Lightning | `0.2`（开发档） | `environment.json#mod.lightning` |
| `METATILEENTITIES` 槽位 | 32766（非 null **3000**） | `environment.json#metatileEntitySlots` / `summary.json#referenceImplementationComparison` |
| 通道注册表条目数 | **26**（30 条枚举常量 → 26 个不同 id 中有登记项的；见 §7.2） | `environment.json#registryChannelCount` |
| 运行模式 | `world=none`（主菜单态运行，自带假世界，不进真实存档） | 同 T0.3 的处置，理由见 [probe-run-state.md](probe-run-state.md) §4.4 |

**注意**：`D:\Github\GTNH\GT5-Unofficial`（源码 HEAD）与 pinned `5.09.52.283` **不是同一个版本**。本报告涉及的
members 均已用 pinned jar 的 `javap` 复核（§7.1），凡引用源码行号的地方都注明是「读取点」而非「pinned 字节码偏移」。

---

## 2. 无人值守管线

### 2.1 触发与接管

```jsonc
// <mcDataDir>/sde_multiblock_scan.json
{
  "channels": true,            // 是否探测通道（默认 true）
  "tiers": true,               // 是否探测总 Tier（默认 true）
  "limit": -1,                 // 只探测前 N 台（-1 = 全量）
  "onlyClasses": ["MTEElectricBlastFurnace"],   // 只探测指定类（简单名或全限定名）
  "perMachineBudgetMs": 30000, // 单台预算
  "globalBudgetMs": 900000,    // 整轮预算
  "exit": true,                // 跑完自动 Minecraft.shutdown()
  "cleanupTrigger": true       // 跑完删除触发文件
}
```

流程：触发文件存在 → `SdeClientAutomationTickHandler#onClientTick` 顶部接管本 tick → 等主菜单 + 60 tick 静置 →
`MultiblockScanRunner.run()` → 落盘 → `Minecraft.shutdown()`。**触发文件不存在时该分支零行为**，既有
`/sde export` 与 T0.3 探针路径不受影响（T1.2 分支排在 T0.3 分支之前，两者互斥）。

### 2.2 复用的既有设施（T0.3，未重造）

| 复用 | 说明 |
|------|------|
| `ProbeDummyWorld` | 假世界（`World` 构造器 → `isRemote=false`，GT 眼里的服务端侧）。T1.2 **小改一处**，见 §7.4 |
| `ProbeFakePlayer` | 真实构造钩子（`ItemStack#onItemUse`）需要的玩家 |
| `MultiblockWorldBuilder.PLACE_*` | 控制器放置坐标常量 |

### 2.3 新增类（全部在 `mod/gtnh/src/main/java/com/lightning/mod/client/multiblock/`）

| 文件 | 行数 | 职责 |
|------|------|------|
| `MultiblockChannelProbe.java` | 1323 | 枚举 + 通道解析 + 取值域探测 + 尺寸/自定义通道的静态事实表 + 反射内核 |
| `MultiblockScanRunner.java` | 721 | 逐台编排、过滤/预算、6 份 JSON 落盘、跨运行比对、内容哈希 |
| `MultiblockTierEstimator.java` | 122 | 总 Tier 逐级 `construct` 试探（真实建造 + 布局签名收敛判据） |
| `MultiblockScanAutomation.java` | 135 | 无人值守入口：触发文件门控 → 等待主菜单 → 运行 → 退出 |
| `ScanJson.java` | 74 | JSON 工具（UTF-8 / 2 空格 / 不转义 HTML） |

**对既有类的改动（仅 2 处，均为最小侵入）**：
1. `client/automation/SdeClientAutomationTickHandler.java`：顶部加一个 `MultiblockScanAutomation.isRequested` 分支（+2 行 import）；
2. `ProbeDummyWorld.java`：新增 `mutationCount()`/`stateSignature()`/`beginTrace()`/`trace()`，并修正空气位重复写不计入变更（§7.4）。

---

## 3. 枚举

### 3.1 方法

```
GregTechAPI.METATILEENTITIES  (3000 个非 null 槽位)
  → filter(mte instanceof IConstructable)     ← 与 BlockRenderer6343 逐字一致的谓词
  → 221 台
```

每台记录：`mteId`（注册表下标，用于进程内定位）、`fqcn`、`simpleName`、`displayName`（`ItemStack#getDisplayName`）、
`localizedName`（`StatCollector.translateToLocal(item.getUnlocalizedName())`）、`isSurvivalConstructable`、
`hasStructureDefinition`、`structurePieceCount`、`distinctElementCount`、`elementClasses`。

**顺序确定性**：枚举顺序 = `METATILEENTITIES` 下标升序，因此 `machines.json` 的机器顺序跨运行稳定。

### 3.2 `IConstructableProvider` 的处理（结论：不重复计入）

任务要求「含 `IConstructableProvider`」。实测与代码核实：

- `IConstructableProvider` 由 `gregtech.api.metatileentity.BaseMetaTileEntity` 实现（`BaseMetaTileEntity.java:95`），
  其 `getConstructable()` 返回的就是同一批 `IMetaTileEntity`（`ConstructableUtility.java:60-61` 的用法）；
- `METATILEENTITIES` 里装的是 `IMetaTileEntity`，**没有一个是 `IConstructableProvider`**（实测计数 = 0）；
- 因此从注册表出发能拿到的「可构造多块」就是 §3.1 的 221 台，`IConstructableProvider` 是**基座侧**的同一集合，
  再展开一次只会让同一台机器出现两份。

`summary.json#referenceImplementationComparison.baseTileConstructableProviderCount = 0` 就是这个断言的落盘值。

### 3.3 与 BlockRenderer6343 `GTConstructableScan` 的同量级对比

| 项 | 本探测 | BlockRenderer6343 |
|----|--------|-------------------|
| 枚举谓词 | `METATILEENTITIES ∩ IConstructable` | **同一个**（`GTNEIMultiblockHandler.java:40-44` 的 `multiblocksList`） |
| 枚举数 | **221** | 同谓词 ⇒ 同值；**本环境未实测**（未装该 mod，见下） |
| 通道解析路径 | 元素链遍历 + **值校验的捕获字段读取** + 声明的静态事实表 | 元素链遍历 + 硬编码 `val$channel` 反射 |
| 通道 id 键 | `{enumName, id}` 双键 | 仅 `id` 字符串（`ConstructableData.java:25`，`casing` ×3 歧义） |
| 自定义元素直读通道 | **覆盖**（`field`，见 §5.4） | **不覆盖**（T0.4 R6 的已知缺陷） |
| 总 Tier 判据 | 逐级 `construct` + **布局内容签名**收敛 | 逐级 `construct` + 元素回调 `hasChanged` |

**为什么本环境给不出 BlockRenderer6343 的实测数字**：该 mod 不在 `dependencies.gradle` 的运行期清单里，
`runClient` 只装载 79 个 mod（其中不含 BlockRenderer6343），且 T1.2 的写范围不允许新增运行期依赖。
因此报告给出的是**同口径枚举数 + 全体注册数**（221 / 3000），而不是编造一个参考实现的数字。
差异原因分析（结构性，不依赖实测）：

1. **枚举数应当完全相等**：两边都是对同一个 `METATILEENTITIES` 数组套同一个 `instanceof IConstructable` 谓词，
   不存在任何额外过滤（BlockRenderer6343 的 `GTNEIMultiblockHandler` 静态块、本探测的 `enumerate()`），
   顺序也一致（数组下标升序）。若参考实现在同一 pack 上得到不同数字，**唯一可能是运行期 mod 集合不同**。
2. **通道清单的差异是预期内的、且方向明确**：参考实现会**漏**「不经 `withChannel` 包裹」的通道 —— 即
   `MTETankTFFT` 的 `field`（T0.4 R6 实测：BlockRenderer6343 无 `field` 通道）。本探测的
   `channelIdHistogram` 里有 `field=1`，这是**本探测相对参考实现多出来的那一条**。
3. **通道最大值的口径差异**：参考实现的 `channelMaxTierMap[id]` 的物理含义是「该通道 `allKnownTiers` 提示列表
   被枚举到的长度」（[probe-channels.md](probe-channels.md) §3.7）；本探测把它拆成两个字段
   `max`（最后一个**新档位**）与 `observedMax`（提示列表长度），因此对尾部有重复项的通道（`glass`/`coil` 等，
   见 §4.3）两者会差 2。**下游若要与参考实现对齐，用 `observedMax`；若要当滑杆刻度，用 `max`。**

---

## 4. 通道探测

### 4.1 数据源优先级（实际实现）

```
① 结构定义遍历（唯一能回答「这台机器用了哪些通道」的来源）
     withChannel 匿名类 → 读捕获字段里的通道 id（值校验，见 §4.2）→ 继续展开 backing
     LazyStructureElement → 反射 get(instance) → 继续展开
     onElementPass      → 读捕获字段里的内层元素 → 继续展开
     IStructureElementChain → 每个 fallback 都展开（OR 语义）
② ChannelDescription 注册表（权威取值域来源，T0.4 §3.7 方法 2）
     每个 (多方块 × 通道) 记录 registryItemCount / registryMaxValue / registryAgreement
     并在「本机观测不到取值域」时作为回落（domainSource = fallback(registry)）
③ 声明的静态事实表（尺寸型通道、无 getBlocksToPlace 的自定义元素）
     domainSource = source-table
```

**为什么「只用注册表」不够**：注册表是**全局**的（同一张 `ChannelDescription#items` 被所有机器共用），
它答不出「哪台机器用了哪个通道」。**为什么「只做符号遍历」不够**：T0.4 R6 的自定义元素既没有
`withChannel` 包裹、又不实现 `getBlocksToPlace`（§5.4）。两条腿缺一不可，落盘时用 `discoverySource` +
`domainSource` 两个字段把「这条结论是怎么来的」显式记下来。

### 4.2 反射内核：参考实现的 `val$channel` 在这里会「响亮地」失败

参考实现 `StructureHacks.java:60` 硬编码 `ReflectionHelper.findField(channelElem.getClass(), "val$channel")`。
本探测**最初照搬了这个名字**，实测：

- 加载的 StructureLib 1.4.28 匿名类字段实际是 **`val$backing:IStructureElement` + `val$channel:String`**
  （**名字恰好一致**；`environment.json#reflectionKernelFacts` 有落盘证据）；
- 但同一套代码在「现代 javac + jabel」产物上会变成 `arg$1`/`arg$2`，硬编码名字届时会静默失效。

因此本探测改成**候选名 + 值校验**：依次读 `val$channel`、`arg$1..3`，取**第一个落在通道全集里的字符串**
（全集 = `GTStructureChannels` 的 30 个 id ∪ 注册表 key）。这既能在当前字节码上工作，又不会在字节码风格变化时
静默失效（最坏情况是记入 `unknownValueDependentElements`，而不是编造 id）。

`environment.json#reflectionKernelFacts` 落盘了自检事实，**`reflectionError` 为空 = 全部解析成功**：

```
withChannelClass=com.gtnewhorizon.structurelib.structure.StructureUtility$34;
  fields=val$backing:IStructureElement,val$channel:String
onElementPassClass=com.gtnewhorizon.structurelib.structure.StructureUtility$26;
  fields=val$element:IStructureElement,val$onCheckPass:Consumer
hatchElementClass=gregtech.api.util.HatchElementBuilder$1; fields=this$0:HatchElementBuilder
lazyClass=com.gtnewhorizon.structurelib.structure.LazyStructureElement; lazyGetResolved=true
```

> **对 [probe-channels.md](probe-channels.md) §3.7 方法 2 的回写**：T0.4 建议「首选 `ChannelDescription.getAll()/getItems()`，
> 因为它不依赖对匿名类做反射」。实测下来这句话要**分两半读**：注册表确实是**取值域**的权威源（本探测采纳了），
> 但**通道归属**（哪台机器用了哪个通道）只能从结构定义拿，注册表给不出。所以本探测的形态是
> 「**结构定义定归属 + 注册表定取值域 + 交叉核对**」，而不是二选一。§7.2 还发现注册表本身在本环境下只填充了 26/30。

### 4.3 取值域探测法与「提示列表长度 vs 有效档位」

**方法**（T0.4 §2.3.1 第 2 条的推论）：`ChannelDataAccessor.getChannelData` 在子通道键缺失时
**回落到 `masterStack.stackSize`**，所以令 `trigger.stackSize = k` 即等价于「该通道 = k」——无需真写 NBT 子通道。
对每个 `k = 1..64` 调一次 `element.getBlocksToPlace(instance, dummyWorld, 0,0,0, trigger, env)`，
记录返回的**参照方块集合指纹**（`itemId:meta`）。

- **早停**：连续 3 个取值给出同一集合即认为已进入夹取平台（GT 的 `getBlocksToPlace` 用 `Math.min` 夹取）。
- **`observedMax`** = 提示列表长度（观测到第几个取值才发现夹取平台）。
- **`max`** = 最后一个「**新档位**」的取值（即最后一个让参照方块集合发生变化的 k）。
- **`hintListHasTrailingRepeat`** = `observedMax > max`，表示提示列表尾部有与最后一档重复的项。

实测典型：`glass` → `max=37`、`observedMax=39`（第 38、39 项与第 37 项同方块）；
`coil` → `max=14`、`observedMax=16`。**T1.3 构造变体时 `k ∈ [max+1, observedMax]` 与 `k = max` give 同一几何**
（可以少采几个变体），但**滑杆刻度必须用 `max`**，否则会出现「滑到尽头结构不变」的空档。

**一处工程教训（已修正，留档）**：第一版把收敛判据写成「本次 `construct` 有没有写方块」，结果
**6 台机器永远停在 64 截断**。用变更轨迹定位（`totalTier.tierSecondTierTrace`）后确认：GT 的 `construct`
每一级都会**重新遍历整个结构**并把每个位置写成当级方块（`MTEBrickedBlastFurnace` 每级 4 次写入、
`MTEExtremeIndustrialGreenhouse` 每级 130 次写入），所以写入次数永远非零；**只有「布局是否与上一级相同」
才是收敛判据**。修正后 `MTEBrickedBlastFurnace` = 1、`MTEExtremeIndustrialGreenhouse` = 37、
`MTEBioVat` = 37、`MTESteamWasher` = 37、`MTEIndustrialWashPlant` = 1（全部符合预期）。

### 4.4 结果：全通道表（23 个 `{enumName,id}` 键）

`max` 列格式 `值×机器数`。`—` 表示该通道非替换型 / 无注册表条目。

| enumName / id | 分类 | 取值域来源 | max（×机器数） | 注册表全局 max | 一致性 |
|---|---|---|---|---|---|
| `BOROGLASS/glass` | replace | probed | 37×44 | 36 | machine-exceeds-registry（见 §7.2） |
| `HEATING_COIL/coil` | replace | probed | 14×15 | 14 | match |
| `ITEM_PIPE_CASING/item_pipe` | replace | probed | 8×6 | 8 | match |
| `STRUCTURE_HEIGHT/height` | **dimension** | source-table | 10×3, 13×1, 15×1, 47×1 | — | not-applicable |
| `STRUCTURE_LENGTH/length` | **dimension** | source-table | 12×2, 16×2 | — | not-applicable |
| `METAL_MACHINE_CASING/casing` | replace | probed | 3×1, 8×1, 15×1 | 15 | match / machine-subset |
| `TIER_MACHINE_CASING/machine_casing` | replace | probed | 9×1, 10×1 | 10 | machine-subset / match |
| `PIPE_CASING/pipe` | replace | probed | 3×1, 4×1 | 4 | match |
| `PRASS_UNIT_CASING/unit_casing` | replace | probed | 4×1, 5×1 | 6 | machine-subset |
| `PSS_CELL/cell` | replace | probed / fallback(registry) | 6×2 | 6 | match（**同一台机器两条**，见 §4.6） |
| `TFFT_FIELD/field` | replace | **source-table** | 10×1 | **0（无登记）** | registry-empty |
| `EIC_PISTON/piston_block` | replace | probed | 4×1 | **0（无登记）** | registry-empty |
| `SUPER_CHEST/super_chest` | replace | probed | 9×1 | **0（无登记）** | registry-empty |
| `COMPONENT_ASSEMBLYLINE_CASING/component_casing` | replace | probed | 14×1 | 14 | match |
| `LSC_CAPACITOR/capacitor` | replace | probed | 10×1 | 10 | match |
| `SOLENOID/solenoid` | replace | probed | 11×1 | 11 | match |
| `MAGNETIC_CHASSIS/chassis` | replace | probed | 3×1 | 3 | match |
| `SYNCHROTRON_ANTENNA/antenna` | replace | probed | 2×1 | 2 | match |
| `QFT_MANIPULATOR/manipulator` | replace | probed | 4×1 | 4 | match |
| `QFT_SHIELDING/shielding` | replace | probed | 4×1 | 4 | match |
| `EOH_COMPRESSION/spacetime_compression` | replace | probed | 9×1 | 9 | match |
| `EOH_STABILISATION/stabilisation` | replace | probed | 9×1 | 9 | match |
| `EOH_DILATION/time_dilation` | replace | probed | 9×1 | 9 | match |

**未出现在本次扫描的 7 个通道 id**：`gt_hatch`（见 §7.3）、`casing` 的两个别名枚举名（见 §4.5）、
以及 `PRASS_UNIT_CASING`/`TIER_CASING`/`ALCHEMICAL_CASING`/`construct`/`essentia_cell`/`coke_oven_casing`
（后 4 个 id 在本次 3000 槽位里没有机器使用 → 与 T0.4 §2.2 的「6 个无书面取值域」清单部分重合，属正常）。

### 4.5 `casing` ×3 的消歧（T0.4 §5.2 的落地）

三条枚举常量共用 id `casing`（`METAL_MACHINE_CASING` / `TIER_CASING` / `ALCHEMICAL_CASING`），共用一个
`ChannelDescription` 实例与同一张值表。本探测的处理：

1. 每条通道记录同时输出 **`enumName` + `id`**（双键），`machines.json` 的通道数组以 `{enumName,id}` 为语义键；
2. 逐元素探测取值域，**按出现顺序**把元素分派到候选枚举名，并把
   「该 id 有 N 个枚举名 / 本机有 M 个互不相同的元素 / 本条落在哪个枚举名」写进 `notes`；
3. `summary.json#distinctChannelKeys` 统计的是 `{enumName,id}` 键数（23），`channelIdHistogram` 统计的是 id（22）；
   两者差值 1 就来自 `casing` 的别名。

实测本环境**只有 `METAL_MACHINE_CASING/casing` 被实际使用**（3 台机器，`max` 各不相同：3 / 8 / 15），
`TIER_CASING`/`ALCHEMICAL_CASING` 没有任何机器使用 —— 与 T0.4 §2.4「无任一多方块同时使用 2 条」完全一致。

> **对 T1.5/T2.4 的建议**：UI 呈现名用 **enumName**（`METAL_MACHINE_CASING`），不要 `capitalize(id)`——
> 后者会继承 `casing` 歧义（T0.4 §5.2 第 2 条，参考实现的已知缺陷）。

### 4.6 重名消歧断言（探针侧）

要求 4「同一多方块内 id 重复即探测失败落盘」。本实现的处理是**比断言更细**的做法：

- **同一元素被多个符号/结构片段共享**（最常见）→ 记录合并为一条，`duplicateElementCount` 落盘说明（例如
  `MTETankTFFT` 的 `glass` 出现在两个结构片段里）；
- **同一 id 下存在多个互不相同的元素**（真正的歧义）→ 各自成条，`notes` 里写明「本机该 id 下有 N 个元素、
  候选枚举名 M 个、本条按出现顺序落在哪个枚举名」；
- **两台机器**的失败面不在这里：任何**异常**（解析/探测抛出）都进 `summary.json#failures`，**静默跳过 = 失败**。

**本次运行 `casing` 的实测归属**：

| 机器 | 归属 | max | 注册表 max | 一致性 |
|------|------|-----|-----------|--------|
| `MTEAlgaePondBase` | `METAL_MACHINE_CASING/casing` | 15 | 15 | match |
| `MTEChemicalPlant` | `METAL_MACHINE_CASING/casing` | 8 | 15 | machine-subset |
| `MTEEntropicProcessor` | `METAL_MACHINE_CASING/casing` | 3 | 15 | machine-subset |

### 4.7 §3.5 尺寸型通道的机器级口径（重要：与 T0.4 表格的差异）

T0.4 §3.5 给的是 `getValueClamped(trigger, min, max)` 的**实参**。本探测把它换算成**通道取值上界**
`maxValue = max − min + 1`（1 基偏移语义）：

| 机器 | 通道 | `getValueClamped(min,max)` | 通道 `min` | 通道值上界 `max` |
|------|------|---------------------------|-----------|------------------|
| `MTEDistillationTower` | height | 3..12 | 3 | **10** |
| `MTEMegaDistillTower` | height | 3..12 | 3 | **10** |
| `MTEAdvDistillationTower` | height | 3..12 | 3 | **10** |
| `MTEPowerSubStation` | height | 4..18 | 4 | **15** |
| `MTELapotronicSuperCapacitor` | height | 4..50 | 4 | **47** |
| `MTETankTFFT` | height | 4..16 | 4 | **13** |
| `MTEAssemblyLine` | length | 5..16 | 5 | **12** |
| `MTEAdvAssLine` | length | 5..16 | 5 | **12** |
| `MTEIndustrialCokeOven` | length | 1..16 | 1 | **16** |
| `MTENetworkSwitchAdv` | length | 1..16 | 1 | **16** |

> **T0.4 §3.5 表格与本次落盘的差异**：T0.4 写 `MTEAdvAssLine` 长度 5..16、`MTENetworkSwitchAdv` 1..`MAX_LENGTH`。
> 本探测从**源码读取点**取实参（`MTENetworkSwitchAdv.java:147` 的 `MAX_LENGTH`），并在 pinned 版本上以求值结果落盘
> （12 / 16）。若 T1.3 需要精确值，请以本表（`source-table` + `min`）为准，T0.4 表格的 `min..max` 是同一事实的另一种写法。

**另外**：尺寸型通道**不绑定符号**（`.use()` 命中数 = 0），结构定义里看不到它。本探测用
「机器简单名 → 尺寸通道 id」的静态表补登记（`discoverySource = source-table(dimension-read-site)`），
`summary.json#channelKindHistogram.dimension = 10` 即这 10 条。

---

## 5. 总 Tier 探测

### 5.1 方法

```
在假世界里用 onItemUse 真放控制器（T0.3 的 MultiblockWorldBuilder 同一条构造钩子）
for tier = 0..64:
    holo.stackSize = tier + 1
    if (placed instanceof INEIPreviewModifier) onPreviewConstruct(holo)   // 每轮重灌通道数据（T0.4 R5）
    placed.construct(holo, hintsOnly = false)
    if (layoutSignature == previousSignature) break
maxTotalTier = tier
```

- **收敛判据 = 布局内容签名**（`ProbeDummyWorld#stateSignature`：坐标 + 方块 + meta 排序后 SHA-256），
  不是「本次有没有写方块」（§4.3 的教训）；
- **`onPreviewConstruct` 每轮都调**：`MTEIndustrialCokeOven#construct` 读实例状态 `getCoilTier()`（T0.4 R5），
  不重灌会导致同一 trigger 在不同调用顺序下给出不同几何；
- `RunnableMachineUpdate.setCurrentThreadEnabled(false)` 包裹全过程（与参考实现一致）。

### 5.2 结果分布

| `maxTotalTier` | 机器数 |
|---|---|
| 1 | 135 |
| 2 | 12 |
| 3 | 5 |
| 4 | 4 |
| 5 | 1 |
| 7 | 2 |
| 8 | 1 |
| 9 | 1 |
| 10 | 3 |
| 12 | 1 |
| 14 | 10 |
| 15 | 2 |
| 16 | 1 |
| 37 | 40 |
| 38 | 1 |
| 47 | 1 |
| 64（截断） | 1 |

- `tierSource` 分布：`probed-single`（=1）135、`probed` 85、`probed-capped` 1；
- **`maxTotalTier = 1` 是真实结论**（135 台机器的结构不随触发器变化，例如大型锅炉、涡轮、聚变计算机等），
  不是探测失败 —— 判据是「第 1 级与第 2 级布局签名相同」；
- 唯一截断：**`MTENeutronActivator`（64）**，其 `glass` 通道接受 1..37、结构对 glass 档位无夹取，
  需要 > 64 次构造才收敛。它在文件里标 `probed-capped` 并在 `notes` 里注明「已截断」。

### 5.3 抽查校验（与真实结构知识一致）

| 机器 | 探测值 | 对照 |
|------|--------|------|
| `MTEElectricBlastFurnace` | 14 | `coil` 通道 14 档 → 总 Tier = coil 档位数 ✓ |
| `MTEChemicalPlant` | 14 | `coil` 14 / `casing` 8 / `machine_casing` 9 / `pipe` 3，总 Tier 取最大 = 14 ✓ |
| `MTEDistillationTower` | 10 | 纯尺寸型：`height` 3..12 → 10 档 ✓ |
| `MTETankTFFT` | 37 | 由 `glass`（37）主导 ✓ |
| `MTELapotronicSuperCapacitor` | 47 | 由 `height`（4..50 → 47）主导 ✓ |
| `MTEAssemblyLine` | 37 | 由 `glass` 主导，`length` 12 ✓ |
| `MTEIndustrialCokeOven` | 2 | `length` 16，但**不带线圈时只走主通道**（T0.4 §4.1.1）→ 1..2 ✓ |
| `MTEBrickedBlastFurnace` | 1 | 原始结构，不随触发器变化 ✓ |

---

## 6. 产出数据文件（T1.3/T1.4 的输入）

目录：`mod/gtnh/run/client/multiblock_scan/<run-NNNN>/`（另有 `latest.json` = 最近一次 `summary.json` 副本）

| 文件 | 内容 | 是否跨运行逐字节稳定 |
|------|------|----------------------|
| `manifest.json` | 运行身份（runIndex / runDir / 起止 epoch / 预算开关） | 否（含时间戳） |
| `environment.json` | 运行环境事实（mod 版本、注册表条目数、`METATILEENTITIES` 槽位数、**反射内核自检事实**、重名 id 表） | 否（含时间戳） |
| `registry.json` | 权威通道注册表快照（`ChannelDescription.getAll()` → 每个 id 的 kind/enumNames/descriptions/itemCount/**maxRegisteredValue**/全部登记项排序表） | **是** |
| `enumeration.json` | 每台多块的枚举行（mteId/fqcn/显示名/本地化名/是否 ISurvivalConstructable/结构片段数/元素类名清单） | **是** |
| `machines.json` | **硬事实层**：每台多块的通道清单 + 总 Tier 域 + 观测序列 + 失败标记 + 备注 | **是**（SHA-256 落盘） |
| `summary.json` | 统计 + 分布直方图 + 不变量 + **失败清单** + 与上一轮的比对 + 参考实现同口径对比 | 否（含 elapsedMs/比对结果） |

### 6.1 `machines.json` 字段设计（下游消费视角）

```jsonc
{
  "schema": "lightning.multiblock.probe.facts/1",
  "machines": [{
    "mteId": 1000,
    "fqcn": "gregtech...MTEElectricBlastFurnace",
    "simpleName": "MTEElectricBlastFurnace",
    "displayName": "Electric Blast Furnace",
    "localizedName": "gt.blockmachines.multimachine.blastfurnace",
    "isSurvivalConstructable": true,
    "hasStructureDefinition": true, "structurePieceCount": 1, "distinctElementCount": 8,
    "channels": [{
      "enumName": "HEATING_COIL",          // UI 唯一键（T0.4 §5.2 第 2 条）
      "id": "coil",                        // 游戏内语义 / 语言键 / ChannelDescription 查询
      "kind": "replace",                   // replace | dimension | hatch
      "discoverySource": "element-scan",   // 归属是怎么来的（见下）
      "domainSource": "probed",            // 取值域是怎么来的（见下）
      "elementClass": "cgs...StructureUtility$34",
      "max": 14,                           // ★滑杆上界：最后一个「新档位」
      "observedMax": 16,                   // 提示列表长度（含尾部重复项）
      "min": null,                         // 仅 dimension 型有值（1 基偏移语义）
      "observedBlockStateCount": 14,       // 观测到的不同方块状态数
      "hintListHasTrailingRepeat": true,   // observedMax > max
      "distinctValues": 14, "plateauReached": true,
      "registryItemCount": 14, "registryMaxValue": 14,
      "registryAgreement": "match",        // 见 §6.2
      "domainScope": "machine",            // machine | global-registry
      "observedValues": [ { "value": 1, "blockCount": 1, "blocksKey": "[901:0]" }, ... ],
      "notes": [ "..." ]
    }],
    "totalTier": {
      "maxTotalTier": 14,
      "tierSource": "probed",              // probed | probed-single | probed-capped | failed
      "tierAttempts": 15, "tierEstimateHitCap": false, "tierBlocksAtMax": 33,
      "tierMutationDeltas": [ 33, 1, 0 ],  // 诊断：逐级世界变更量
      "tierSecondTierTrace": [ "..." ]     // 诊断：tier=2 那次构造的具体方块变更
    },
    "channelProbeFailed": false,           // true 时另有 channelFailure
    "unknownValueDependentElements": [ "..." ],  // 值依赖触发器但归属未定的元素（见 §7.5）
    "notes": [ "..." ]
  }]
}
```

**字段命名约定**（写在 `notes` 里的自解释，下游不必反查本报告）：

| 字段 | 取值 | 含义 |
|------|------|------|
| `discoverySource` | `element-scan` | 元素链遍历（`withChannel`/嵌套链）解析出通道名 |
| | `element-scan(hatch-builder)` | 发现 `HatchElementBuilder` 造出的舱口元素 |
| | `source-table(dimension-read-site)` | 尺寸型通道，静态事实表 |
| | `explicit-map(custom-element)` | 无 `getBlocksToPlace` 的自定义通道元素（§5.4） |
| | `captured-field(custom-element)` | 元素自身持有可读通道 id |
| `domainSource` | `probed` | 本机真实枚举出的取值域 |
| | `source-table` | 声明的静态事实表（尺寸型 / 无 `getBlocksToPlace` 的自定义元素） |
| | `fallback(registry)` | 本机观测不到，回落注册表全局并集 |
| | `fallback` | 无任何来源（**本次运行 0 条**） |
| | `declared-boolean` | 布尔开关（`gt_hatch`） |
| `domainScope` | `machine` | `max` 是本机口径 |
| | `global-registry` | `max` 是全局注册表口径（本机观测不到时） |

### 6.2 `registryAgreement` 取值

| 值 | 含义 | 本次条数 |
|----|------|---------|
| `match` | 本机 `max` == 注册表全局 `max` | 35 |
| `machine-subset` | 本机 `max` < 注册表全局 `max`（**正常**：注册表是所有机器的并集） | 7 |
| `machine-exceeds-registry` | 本机 `max` > 注册表全局 `max`（**需复核**，本次全部是 `glass`，见 §7.2） | 44 |
| `registry-empty` | 注册表无该通道登记项（`piston_block`/`super_chest`/`field`） | 3 |
| `not-applicable` | 尺寸型 / 舱口型 | 10 |

### 6.3 失败清单（本次为空）

`summary.json#failures` 是数组，每项 `{fqcn, stage, exception, message, stackTraceHead}`，`stage ∈ {resolve, channels, tiers, budget}`。
**本次运行 `failureCount = 0`、`failures = []`**（两次运行皆然）。任何异常都不会被静默吞掉：
通道探测与总 Tier 探测各自 try/catch 并 append 到该数组，整轮崩溃另写 `failure-<epoch>.json`（含异常链 + 栈顶帧）。

---

## 7. 关键发现与坑（对 T1.3 的真实影响）

### 7.1 参考实现的 `val$channel` 反射在当前 StructureLib 上「恰好还能用」，但没有移植价值

见 §4.2。结论：**照抄参考实现的字段名是不可靠的**；本实现改成候选名 + 值校验，并把字段实况落盘
（`environment.json#reflectionKernelFacts`），升级 StructureLib 后一眼能看出断在哪。

### 7.2 注册表在本环境只填充了 26/30 个通道，且 `glass` 有一条「本机 > 全局」

- `ChannelDescription.getAll()` 实测 **26 条**，而 `GTStructureChannels` 有 **30 条常量**（26 个不同 id + `casing` ×3）。
  差集里有 `piston_block`/`super_chest`/`field`（`items` 为空，即**从未 `registerAsIndicator`**），
  它们出现在 `registryAgreement = registry-empty` 的 3 条上。
  → **T1.3 不能假定「注册表能给出全部通道的取值域」**，必须保留 `domainSource = source-table` 这条腿。
- **`glass`：本机 `max = 37`，注册表 `max = 36`，44 台机器全部如此。**
  本探测的 `observedValues` 显示第 37 个取值给出的方块与第 10 个取值相同（`[959:0]`），
  即**提示列表长度 37、尾部有重复项**，而注册表只登记了 36 项。
  结合 T0.4 R10 已登记的 `GlassTier` 内 `tierToGlass` 键冲突（`:208-209` 两条 `(tier=11, subtier=1)`），
  最可能的解释是**注册表漏登记/覆盖了一条玻璃**。
  → **对 T1.3 的处置建议**：`glass` 用 `max = 37`（37 是行为实证的上界，多出来的那一档与第 10 档同方块，
  不会造成几何错误）；若要与注册表对齐，请先在 TI 上补登 `glass` 的第 37 项，不要在下游悄悄减 1。

### 7.3 `gt_hatch` 在本次 221 台里一条都没出现 → 舱口元素识别需要复核

- 反射内核自检**成功**（`hatchElementClass=gregtech.api.util.HatchElementBuilder$1`，字段 `this$0` 已解析）；
- 但 `summary.json#channelKindHistogram` 里**没有 `hatch`**，即 221 台的元素链里一次都没遇到这个匿名类。

**这不是「没有舱口」**：GT 的舱口位置由 `HatchElementBuilder#buildAndChain(...)` 产生，而
`buildAndChain` 返回的是 `IStructureElementChain`；本探测会展开每个 fallback，理论上应当命中。
可能原因是 pinned 版本的 `buildAndChain` 在链里包了别的容器（例如 `onlyIf`/`LazyStructureElement`），
使实际元素类名不等于 `HatchElementBuilder$1`。

**影响评估：低。** `gt_hatch` 是布尔开关、**不生成滑杆**（T0.4 §3.6），T1.3 的变体轴只由
「替换型/尺寸型通道 + 总 Tier + 运行态」决定，缺它不影响几何。**但这是本次唯一一处「预期应当出现却没有出现」
的分类项**，建议在 T1.3 顺手用一条 `elementClassNames` 统计复核（`enumeration.json` 已落盘每台机器的
全部元素类名，离线即可筛查）。

### 7.4 `ProbeDummyWorld` 的一处真实修正（T0.3 设施遗留）

`setBlock(air)` 在「本来就是空气」的位置也会 `placementCount++`，导致
「对空气位反复 setBlock(air)」（GT 的舱口/占位元素会这样做）被误判成「世界还在变」。
修正后（空气位无变更则不计入）`MTEBrickedBlastFurnace` 等机器才得出正确总 Tier（§4.3）。
`blocksPlaced()` 的语义随之收紧为「**真正改变世界的 setBlock 次数**」，T0.3 探针只把它当诊断数值记录、
不参与判据，因此该修正对 T0.3 结论无影响。

### 7.5 `unknownValueDependentElements`：79 条「值依赖触发器但归属未定」的记录

`summary.json` 里这类记录共 **119 条**（分布在 74 台机器上），全部带**元素类名 + 观测上界 + 观测序列**。
它们**不是失败**，而是**诚实标注的未知**。本探测刻意**不按上界猜通道**：早期版本按「注册表上界唯一吻合」猜，
实测把 `item_pipe` 认成了 `chassis`（同一个 `StructureUtility$34` 匿名类被多个通道复用），是明显的假阳性——
该路径已删除。

典型三类：

| 元素 | 现象 | 判断 |
|------|------|------|
| `com.gtnewhorizon...StructureUtility$7` ×93 | 值依赖、无夹取平台或上界与注册表不唯一吻合 | `ofBlocksTiered` 的**未包裹副本**（同一通道已有 `withChannel` 副本被正确登记），**冗余记录，无信息损失** |
| `GTStructureUtility$7` ×15 | 上界 14，`[901:0..13]` 序列 | `GTStructureUtility#ofCoil` 的未包裹副本，同样冗余 |
| `MTELapotronicSuperCapacitor$CellElement` / `MTELapotronicSuperCapacitor$1` / `MTEChemicalPlant$1` / `GTPPMultiBlockBase$1` | 值依赖 | 自定义元素（T0.4 §3.4 的作用域相交实例正在此列），其通道已通过 `withChannel` 副本登记（`capacitor`/`casing`），冗余 |

→ **T1.3 的处置**：这些记录**不需要**转化为通道；但它们是「本机存在读通道的自定义元素」的直接证据，
`MTELapotronicSuperCapacitor`（T0.4 §3.4/§5.3 的作用域相交实例）应作为重点抽查机。

### 7.6 T0.4 R6 的落地：`TFFT_FIELD/field` 被正确识别

`MTETankTFFT$TFFTStorageFieldElement` 是**枚举**、实现 `IStructureElement`，并且（pinned jar `javap -c` 复核）
**没有实现 `getBlocksToPlace`**（继承默认返回 `null`），在结构定义里以 `INSTANCE` 直接 `addElement`。
两条自动路径（符号遍历 / 取值域探测）都覆盖不到，因此本探测用**显式映射 + 声明上界**：

```jsonc
{ "enumName": "TFFT_FIELD", "id": "field", "kind": "replace",
  "discoverySource": "explicit-map(custom-element)", "domainSource": "source-table",
  "max": 10, "min": null, "registryMaxValue": 0, "registryAgreement": "registry-empty",
  "notes": ["元素 `MTETankTFFT$TFFTStorageFieldElement` 不经 withChannel 包裹、且不实现 getBlocksToPlace，
             取值域与归属来自显式映射：getValueClamped(stack, 1, MTETankTFFT.Field.VALUES.length)，VALUES 长度 10",
            "注册表无该通道登记项，取值上界取声明值 10（依据：MTETankTFFT.Field.VALUES.length（T1..T10，pinned GT5U 5.09.52.283））"] }
```

与 T0.4 R6 的判断一致（BlockRenderer6343 **无** `field` 通道，本探测有），上界 10 与 pinned 版本的
`Field.VALUES`（T1..T10）吻合。

---

## 8. 可重复性证据（两次运行）

**运行序列**：`run-0001`（第一次）、`run-0002`（第二次），同一 jar、同一环境、先后两次 `gradlew runClient`，
每次都由触发文件门控全自动跑完并自动退出（退出码 0）。

| 证据 | 结果 |
|------|------|
| `run-0001/machines.json` vs `run-0002/machines.json` | **逐字节相同**（751,876 B） |
| `machines.json` SHA-256 | 两次均为 `439c4355d8632e29343b73eed394a55b0af36ba87271c1b7f4b36a63866614f6` |
| `enumeration.json` | 逐字节相同 |
| `registry.json` | 逐字节相同 |
| `run-0002/summary.json#signatureComparison` | `{ "previousRunIndex": 1, "machinesHashMatch": true, "enumeratedTotalMatch": true, "probedCountMatch": true }` |
| 枚举数 / 探测数 | 221 / 221（两次一致） |
| 失败数 | 0（两次一致） |
| 分布直方图（kind / domainSource / registryAgreement / id） | 两次逐字段一致 |
| 单轮耗时（会波动，非一致性判据） | 3541 ms / 3424 ms |

复现命令：

```powershell
# 1) 放触发文件（内容见 §2.1），注意 UTF-8 无 BOM
Set-Content -Path mod\gtnh\run\client\sde_multiblock_scan.json `
  -Value '{"channels":true,"tiers":true,"exit":true,"cleanupTrigger":true}' -Encoding utf8NoBOM
# 2) 无人值守跑两轮
cd mod\gtnh; .\gradlew.bat runClient
Set-Content -Path run\client\sde_multiblock_scan.json -Value '{...}' -Encoding utf8NoBOM
.\gradlew.bat runClient
# 3) 比对
Compare-Object (Get-Content run\client\multiblock_scan\run-0001\machines.json) `
               (Get-Content run\client\multiblock_scan\run-0002\machines.json)
```

**前置条件（T0.3 §4.4 的坑，T1.2 沿用）**：① CoFH ASM 需要 `~/.gradle/caches/minecraft/.../unpacked/conf`
目录联接（本机已建，否则启动阶段弹 Swing 目录框静默卡死）；② 本探测用 `world=none`（主菜单态），
**不进真实存档**，因此不触发 FML `StartupQuery` 互锁。

---

## 9. 构建与验证

| 检查 | 结果 |
|------|------|
| `gradlew build`（含 `spotlessJavaCheck`） | **通过**（`BUILD SUCCESSFUL`） |
| 两次 `gradlew runClient` | 退出码 0，自动退出 |
| `failureCount` | 0（两次） |
| 依赖变更 | **无**（§11 说明为什么本次不需要补 `compileOnly`） |
| 改动文件白名单 | 仅 `client/multiblock/`（新增 5 类 + 小改 `ProbeDummyWorld`）、`client/automation/SdeClientAutomationTickHandler.java`（+2 行 import +4 行分支）、本文件 |

---

## 10. 交接给 T1.3 / T1.4 的结论

1. **输入文件**：`run-*/machines.json`（硬事实层，逐字节可复现）+ `run-*/registry.json`（权威通道值表）。
   T1.3 应从 `machines.json` 读 `channels[]` 与 `totalTier`，**不要**自己再扫一遍结构定义。
2. **滑杆刻度用 `max`，变体采样可省 `max+1..observedMax`**（尾部重复项，§4.3）。
3. **尺寸型通道有 `min`**，且 `min` 是「值 1 对应的实际尺寸」，不是 1（§4.7）。装配顺序
   `尺寸型 → 骨干 → 替换型 → 运行态` 与 T0.4 §3.5 的结论一致，本探测的 `kind` 字段可直接用作分派键。
4. **`TFFT_FIELD/field` 已可用**（§7.6），上界 10；`MTETankTFFT` 的 `height` 上界 13。
5. **不需要为「未包裹的元素副本」建通道**（§7.5），它们是冗余记录；但 `MTELapotronicSuperCapacitor`
   仍是作用域相交的重点抽查机（它的 `LSC_CAPACITOR` 与 `BOROGLASS` 通过两个元素共同决定同一批位置，T0.4 §3.4 的作用域相交实例）。
6. **构造变体必须走 `placeBlock`/`spawnHint`**（T0.4 R4）——本探测只把 `getBlocksToPlace` 用于**取值域枚举**，
   两者边界已在代码注释里写明，T1.3 不要沿用本探测的取值路径去建变体。
7. **`glass` 的 37 档**：第 37 档与第 10 档同方块，采不采它几何都一样（§7.2）。
8. **`maxTotalTier = 1` 的 135 台**：如果 T1.5 的「只导出结构性组合」要裁剪，这批是天然的单变体集合。

---

## 11. 依赖与写范围

- **`dependencies.gradle` 未改动**。T1.2 用到的编译期符号全部落在 T0.2/T0.3 已经引入的
  `compileOnly` 集合内（GT5U / StructureLib / GTNHLib / ModularUI2 / AE2），未出现新的间接类型，
  因此无需在 [decision-deps-route.md](decision-deps-route.md) §6.1 追加记录。
- **未做 git commit**（写范围要求）。
- 触发文件与产物位于 `mod/gtnh/run/client/`（`run/` 是 gradle 运行目录，非源码树）。

---

## 12. 开放项与风险

| # | 项 | 说明 | 建议处置 |
|---|----|------|---------|
| 1 | **`glass` 本机上界 37 > 注册表 36** | 44 台机器全部如此；提示列表尾部有重复项（§7.2） | T1.3 用 37；若要双向对齐，需在 TI 上复核 `GlassTier` 的 `tierToGlass` 键冲突（T0.4 R10） |
| 2 | **`gt_hatch` 零命中** | 反射自检成功但 221 台里没遇到那个匿名类（§7.3） | 用 `enumeration.json#elementClasses` 离线筛查；**不影响几何**（布尔开关不生成滑杆） |
| 3 | **`MTENeutronActivator` 总 Tier 在 64 截断** | 其 glass 通道无夹取，需 >64 次构造（§5.2） | 若 T1.3 需要它，单独把 `MAX_TRIES` 提到 128 复跑该台（`onlyClasses` 已支持） |
| 4 | **`unknownValueDependentElements` 119 条** | 全部是诚实标注的未知，其中含作用域相交实例（§7.5） | T1.3 对 `MTELapotronicSuperCapacitor` 做重点抽查；其余按冗余处理（未包裹副本最多的是 `MTEMultiAutoclave`，4 条） |
| 5 | **注册表只填充 26/30 通道** | `field`/`piston_block`/`super_chest` 无登记项（§7.2） | 保留 `source-table` 这条腿；这 3 条已在文件中标 `registry-empty` |
| 6 | **T0.3 §4.4 的环境前置** | CoFH conf 目录联接是启动前提 | T1.6 必须把它写进管线前置检查（T0.3 已登记，此处重申） |
| 7 | **`casing` 归属按出现顺序分派** | 当前 3 台机器都只用了 `METAL_MACHINE_CASING`，无歧义（§4.5） | 若未来出现同机使用 2 条同 id 通道，`notes` + `duplicateElementCount` 会显式暴露，需人工裁决 |
| 8 | **探测耗时 3.4 s / 221 台** | 全量单轮 < 5 s，`runClient` 启动 ~55 s 是主要成本 | T1.6 若按子集迭代，用 `onlyClasses`/`limit` |

