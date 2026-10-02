# T0.4 通道语义调研（作用域 + 耦合）

> **任务**：回答《需求书》风险 2、3 —— 通道作用域是否不相交（因子化成立的物理依据）；耦合约束（等级一致性 / 大小关系）从哪里来。
> **产出物**：本文件。为 T0.5 文件格式契约定稿提供直接输入。
> **铁律遵守**：每条结论均带 `仓库:文件:行` 佐证。凡代码中不存在的约束，明确标注"不在代码中"并给出缺省行为建议，不臆造。

---

## 0. 结论摘要（TL;DR）

| 问题 | 结论 |
|------|------|
| 通道总数 | **30 条**，不是计划文档写的 27 条（见 §1.2，计划口径已过期） |
| 替换型 / 尺寸型 / 舱口布局型 | **27 / 2 / 1**（见 §2.2） |
| 重名 id | **只有 `casing` 重名，出现 3 次**（`METAL_MACHINE_CASING` / `TIER_CASING` / `ALCHEMICAL_CASING`）；无其他重名。但**派生影响面比"3 条"更大**：三条共用同一个语言描述键、同一个 indicator 注册命名空间（见 §2.4） |
| 作用域是否不相交 | **替换型通道两两不相交（结构性成立，可证明）**；`gt_hatch` 与其他通道语义正交；**尺寸型通道不参与"位置集合"划分，而是改变位置集合本身**。**发现 1 处真实相交实例**：`MTELapotronicSuperCapacitor`（见 §3.4），按风险 2 协议需为该机记录例外规则 |
| 耦合约束来源 | **三类，全部在代码中**：①构造期（`construct`/`survivalConstruct`）②检查期（`checkMachine`）③自动放置期（`survivalPlaceBlock`）。**主导模式不是"玻璃 ≤ 线圈"，而是"玻璃等级 ≥ 能量仓等级 / 绝对电压阈值"**（27+ 处）。最需要格式表达的是**尺寸型 × 替换型耦合**（`MTEIndustrialCokeOven`，见 §4.3） |

---

## 1. 调研范围与版本锚点

### 1.1 版本锚点（结论只在下列提交上成立）

| 仓库 | 路径 | 提交 | 日期 |
|------|------|------|------|
| GT5-Unofficial | `D:\Github\GTNH\GT5-Unofficial` | `83ee7f999b698b79a087407cb6c562520333d4ec`（`5.09.52.525-4-g83ee7f999b`） | 2026-05-19 |
| StructureLib | `D:\Github\GTNH\StructureLib` | `4e5a92aff76e36adfabc62408907178ee42b0fa8` | 2026-03-26 |
| BlockRenderer6343 | `D:\Github\GTNH\BlockRenderer6343` | `6bcdd3215be60c7f6481c27dd94317a34d71e750` | 2026-06-07 |

> **重要**：`StructureLib` 源码目录 `D:\Github\GTNH\StructureLib` 是**完整可读源码**，本次调研直接读取源码而非反编译，所有 StructureLib 结论均为源码级证据。`StructureUtility` 注释提到的 `docs/channels.md`（`StructureUtility.java:2819`）**在该仓库中不存在**——仓库只有 `README.md`（已核，无通道章节）。**通道语义没有权威书面规格，代码即规格。**

### 1.2 与计划文档的口径差异（需回写计划）

计划文档 `multiblock-channel-renderer-plan.md:91`、`:396` 写"通道定义全集，27 条"。实测：

- 枚举常量 **30 条**（`GTStructureChannels.java:25-54`）。
- **28 个不同 id**（30 常量 − 2 个重复的 `casing`）。
- 30 = 27 替换型 + 2 尺寸型 + 1 舱口布局型（§2.2）。计划的"27"疑似只数了替换型，或为旧版本枚举。**T0.5 与 T1.2 必须以运行时枚举为准，不得硬编码 30 或 27。**

**验证命令**（可复现）：

```powershell
$f='D:\Github\GTNH\GT5-Unofficial\src\main\java\gregtech\common\misc\GTStructureChannels.java'
$c=Get-Content $f; $c[24..54] | Where-Object { $_ -match '^\s+\w+\(' } |
  ForEach-Object { if ($_ -match '^\s+(\w+)\("([^"]+)"') { [pscustomobject]@{Enum=$Matches[1];Id=$Matches[2]} } } |
  ForEach-Object -Begin {$all=@()} -Process { $all += $_ } -End {
    "TOTAL=$($all.Count)"; "DISTINCT IDS=$(($all.Id | Sort-Object -Unique).Count)"
    $all | Group-Object Id | Where-Object Count -gt 1 | ForEach-Object { "$($_.Name) x$($_.Count): $(($_.Group.Enum) -join ', ')" } }
# 输出：TOTAL=30 / DISTINCT IDS=28 / casing x3: METAL_MACHINE_CASING, TIER_CASING, ALCHEMICAL_CASING
```

---

## 2. 通道定义全集（30 条）与分类

### 2.1 分类依据（不是猜的）

| 分类 | 判定依据（代码特征） |
|------|---------------------|
| **替换型** | 该通道被 `.use(<element>)` 包裹（`IStructureChannels.use` → `StructureUtility.withChannel`，`IStructureChannels.java:39-41`），或**自定义 `IStructureElement` 在 `spawnHint`/`placeBlock`/`getBlocksToPlace` 中直接读该通道**，用于决定"某位置的方块是谁" |
| **尺寸型** | 通道**从不**被 `.use()` 包裹（实测 `STRUCTURE_HEIGHT`/`STRUCTURE_LENGTH` 的 `use` 命中数 = 0），只在 `construct`/`survivalConstruct` 里通过 `getValueClamped(...)` 读取，用于决定"结构有几层/几片" |
| **舱口布局型** | 只读 `hasValue(trigger)` 布尔语义，不参与方块编号 |

判定 `.use()` 命中数的命令：

```powershell
$all = Get-ChildItem -Recurse -Filter *.java -Path D:\Github\GTNH\GT5-Unofficial\src | Select-Object -ExpandProperty FullName
Select-String -Path $all -Pattern 'GTStructureChannels\.STRUCTURE_HEIGHT' | Where-Object { $_.Line -match '\.use\(' }   # -> 0 命中
Select-String -Path $all -Pattern 'GTStructureChannels\.STRUCTURE_LENGTH' | Where-Object { $_.Line -match '\.use\(' }   # -> 0 命中
```

### 2.2 通道分类表（30 条全列）

`重名` 列：`★` 表示 id 重复。`取值域` 列：来自 `en_US.lang` 的 `channels.gregtech.<id>` 官方描述（`GT5-Unofficial/src/main/resources/assets/gregtech/lang/en_US.lang:2319-2340`）或代码；`—` 表示**无声明**。

| # | 枚举名 | id | 分类 | 取值域（语义） | 重名 | 声明来源 |
|---|--------|----|------|---------------|------|----------|
| 1 | `QFT_MANIPULATOR` | `manipulator` | 替换型 | 整数 1..4（1=Neutron Pulse Manipulator，4=SpaceTime Continuum Ripper） | | lang:2319 |
| 2 | `QFT_SHIELDING` | `shielding` | 替换型 | 整数 1..4 | | lang:2320 |
| 3 | `HEATING_COIL` | `coil` | 替换型 | 整数 1..14（1=Cupronickel Coil，14=Eternal Coil）→ `HeatingCoilLevel` 的 tier = 值−1 | | lang:2321 |
| 4 | `BOROGLASS` | `glass` | 替换型 | 整数 1..**动态**（≈35）：`GlassTier.getGlassList()` 的顺序下标 +1，**不是电压等级** | | lang:2322（"many tiers and many substitutes"，无范围） |
| 5 | `PRASS_UNIT_CASING` | `unit_casing` | 替换型 | 整数 1..5 | | lang:2324 |
| 6 | `METAL_MACHINE_CASING` | `casing` | 替换型 | 整数 1..N（`BlockCasings12` meta `i+10` → 值 `i+1`；化学厂动态注册） | ★ | lang:2323（"metallic machine casing"，**无范围**） |
| 7 | `TIER_MACHINE_CASING` | `machine_casing` | 替换型 | 整数 1..10 | | lang:2325 |
| 8 | `TIER_CASING` | `casing` | 替换型 | 整数 1..15（`CasingTier`：`sBlockCasings1` meta 0..9 → 1..10；`sBlockCasingsNH` meta 10..14 → 11..15） | ★ | 同上（与 #6 共用） |
| 9 | `SOLENOID` | `solenoid` | 替换型 | 整数 1..11 | | lang:2326 |
| 10 | `LSC_CAPACITOR` | `capacitor` | 替换型 | 整数 1..10 | | lang:2327 |
| 11 | `STRUCTURE_HEIGHT` | `height` | **尺寸型** | `getValueClamped(trigger, min, max)`，**min/max 随机器而变**（实测 3..12 / 4..18 / 4..50 / 3..12） | | lang:2328 |
| 12 | `STRUCTURE_LENGTH` | `length` | **尺寸型** | 同上（实测 1..16 / 5..16 / 1..N） | | lang:2329 |
| 13 | `PIPE_CASING` | `pipe` | 替换型 | 整数 1..4 | | lang:2330 |
| 14 | `ITEM_PIPE_CASING` | `item_pipe` | 替换型 | 整数 1..8 | | lang:2331 |
| 15 | `PSS_CELL` | `cell` | 替换型 | 整数 1..6 | | lang:2332 |
| 16 | `SYNCHROTRON_ANTENNA` | `antenna` | 替换型 | 整数 1..2 | | lang:2333 |
| 17 | `SE_MOTOR` | `motor` | 替换型 | 整数 1..5 | | lang:2334 |
| 18 | `EOH_COMPRESSION` | `spacetime_compression` | 替换型 | 整数 1..9 | | lang:2335 |
| 19 | `EOH_STABILISATION` | `stabilisation` | 替换型 | 整数 1..9 | | lang:2336 |
| 20 | `EOH_DILATION` | `time_dilation` | 替换型 | 整数 1..9 | | lang:2337 |
| 21 | `HATCH` | `gt_hatch` | **舱口布局型** | **布尔**（`hasValue`），值本身无语义；`exclusive()` 元素可绕过 | | lang:2338 |
| 22 | `TFFT_FIELD` | `field` | 替换型（**自定义 element 直读**） | 整数 1..`Field.VALUES.length` | | lang:2339（无范围） |
| 23 | `EIC_PISTON` | `piston_block` | 替换型 | **—（无声明）** | | 无 |
| 24 | `ALCHEMICAL_CASING` | `casing` | 替换型 | **—（无声明）** | ★ | lang:2323（与 #6/#8 共用） |
| 25 | `ALCHEMICAL_CONSTRUCT` | `construct` | 替换型 | **—（无声明）** | | 无 |
| 26 | `SUPER_CHEST` | `super_chest` | 替换型 | **—（无声明）** | | 无 |
| 27 | `MAGNETIC_CHASSIS` | `chassis` | 替换型 | 整数 1..3（`BlockCasingsFoundry.java:49-50`） | | 无 |
| 28 | `COMPONENT_ASSEMBLYLINE_CASING` | `component_casing` | 替换型 | 整数 1..14 | | lang:2340 |
| 29 | `LES_ESSENTIA_CELL` | `essentia_cell` | 替换型 | **—（无声明）** | | 无 |
| 30 | `COKE_OVEN_CASING` | `coke_oven_casing` | 替换型 | 整数 1..2（`GregtechMetaCasingBlocks.java:43-45`，meta 2..3 → 值 1..2） | | 无 |

**日志/语言侧证据**：`en_US.lang` 只有 **22 条** `channels.gregtech.*` 条目（`Select-String -Pattern '^channels\.gregtech\.' en_US.lang`），对应 **28 个不同 id** → **6 个 id 无任何书面描述**：`piston_block`、`construct`、`super_chest`、`chassis`、`essentia_cell`、`coke_oven_casing`。`casing` 只有 1 条语言条目，由 3 个常量共用（§2.4）。

`GTStructureChannels.register()`（`GTStructureChannels.java:81-88`）对每个常量调用 `registerChannelDescription(value.get(), ...)` —— **三条 `casing` 注册同一个键 `channels.gregtech.casing`**，值相同故无冲突，但也意味着**语言文件无法区分**这三条。

### 2.3 取值域语义：四种注入机制

通道值如何变成"哪个方块"，代码里共有 **4 种机制**。这直接决定 T0.5 格式要存什么。

**机制 A —— `withChannel` + `ofBlocksTiered` 的提示列表下标（主流）**

`StructureUtility.withChannel(channel, backing)`（`StructureUtility.java:2821-2887`）在 **`spawnHint` / `placeBlock` / `survivalPlaceBlock` / `couldBeValid`** 中把触发器换成"子通道值"，再委托 backing；落地方是 `ofBlocksTiered`：

```java
// StructureUtility.java:720-723
private Pair<Block, Integer> getHint(ItemStack trigger) {
    if (hints.isEmpty()) return null;
    return hints.get(Math.min(Math.max(trigger.stackSize, 1), hints.size()) - 1);
}
// StructureUtility.java:738-757
public boolean spawnHint(...) { Pair<Block,Integer> hint = getHint(trigger); ... hintParticle(world,x,y,z,hint.getKey(),hint.getValue()); }
public boolean placeBlock(...) { Pair<Block,Integer> hint = getHint(trigger); ... world.setBlock(x,y,z,hint.getKey(),hint.getValue(),2); }
```

> **取值域语义 = 1 基下标 + 1，索引进 `allKnownTiers` 列表，超出则夹取到最后一档**（`Math.min`）。**值 0 不是"第一档"，而是"未设置"**（见 §2.3.1）。

**机制 B —— 自定义 `IStructureElement` 直接读通道**

`TFFT_FIELD`：符号 `'f'` 绑定 `TFFTStorageFieldElement.INSTANCE`（`MTETankTFFT.java:269`），**没有 `.use()` 包裹**，元素自己在 `getHint` 里读通道：

```java
// MTETankTFFT.java:149-163
private int getHint(ItemStack stack) {
    return GTStructureChannels.TFFT_FIELD.getValueClamped(stack, 1, Field.VALUES.length);
}
public boolean spawnHint(...) { StructureLibAPI.hintParticle(world, x, y, z, TFFT_FIELD, getHint(trigger)); ... }
public boolean placeBlock(...) { world.setBlock(x, y, z, TFFT_FIELD, getHint(trigger), 3); ... }
```

`LSC_CAPACITOR` 也有一个这样的元素（`CellElement.INSTANCE`，`MTELapotronicSuperCapacitor.java:1194-1289`），**同时**在符号 `'C'` 上被 `.use()` 包裹（`:214`）——这就是 §3.4 相交实例的成因。

**机制 C —— 尺寸型：`getValueClamped`**

```java
// IStructureChannels.java:27-29
default int getValueClamped(ItemStack trigger, int min, int max) {
    return Math.min(max, ChannelDataAccessor.getChannelData(trigger, get()) + min - 1);
}
```

语义（`IStructureChannels.java:17-21` 文档注释原文）：**值 1 → min，值 2 → min+1，…… 大于等于 (max−min+1) 的值全部 → max**。即通道值本身仍是 1 基，`min` 是"值 1 对应的实际尺寸"。

**机制 D —— 舱口布局：布尔标志**

```java
// HatchElementBuilder.java:527
if (!GTStructureChannels.HATCH.hasValue(trigger) && !mExclusive) {
    env.getChatter().accept(new ChatComponentTranslation("GT5U.autoplace.error.no_placeable", type));
    return PlaceResult.REJECT;
}
```

`GTStructureChannels.HATCH` 在整个 GT5U 中**只有这 1 处引用**（外加枚举声明本身）。`.exclusive()` 的舱口元素绕过该要求（`HatchElementBuilder.java:199` 注释 + `:204-207`）。

#### 2.3.1 "未设置"（Not set）的权威定义

```java
// ChannelDataAccessor.java:112-121  —— setChannelData
if (data <= 0) throw new IllegalArgumentException();          // 通道值必须 > 0
...
// ChannelDataAccessor.java:95-103  —— getChannelData
if (!...hasKey(channel, NBT.TAG_INT)) return masterStack.stackSize;   // 无子通道 -> 回落到主通道(stackSize)
// ChannelDataAccessor.java:46-59   —— withChannel
if (...!hasKey(channel, NBT.TAG_INT)) return masterStack;     // 无该子通道 -> 原样返回
```

**结论（格式设计的关键）**：

1. 通道值域是 **1..N 的正整数**，**0 在数据层不可表示**（`setChannelData` 抛异常）。
2. **"未设置"的物理形态是"该通道键不存在"**，此时该位置回落到**主通道值（触发器 `stackSize`）**。
3. 参考实现的落地方式与之一致：`GuiMultiblockHandler.java:238-254`，滑杆为 0 时调 `unsetChannelData`，> 0 时调 `setChannelData`；滑杆文本 0 显示 `blockrenderer6343.nei.not_set`（`:198-200`）。
4. **`withChannel.check()` 不换通道**（`StructureUtility.java:2824-2826` 直接 `backing.check(t, world, x, y, z)`）。即**通道在"结构校验"时不参与**；它只影响 **hint / place / couldBeValid**。这是 §3 证明的基石。
5. **`withChannel.getBlocksToPlace()` 也不换通道**（`StructureUtility.java:2858-2863`：`return backing.getBlocksToPlace(t, world, x, y, z, trigger, env);` 传的是**原始 trigger**）。所以用 `getBlocksToPlace` 枚举某通道的取值域时，实际枚举的是 **`allKnownTiers` 提示列表的长度**，而不是该通道值域——**这是 BlockRenderer6343 能正确得到 `channelMaxTier` 的原因**（§3.7），也是 T1.3 必须注意的陷阱：**要构造"通道值 = k 的变体"必须走 `placeBlock`/`spawnHint`，不能走 `getBlocksToPlace`。**

### 2.4 重名 id：不止"3 条"，派生影响更大

`"casing"` 由 3 个常量共用：`METAL_MACHINE_CASING`（`GTStructureChannels.java:30`）、`TIER_CASING`（`:32`）、`ALCHEMICAL_CASING`（`:48`）。**实测无其他重名 id。**

三条重名带来的**四处共用**（全部已核实）：

| 共用的东西 | 代码位置 | 后果 |
|-----------|---------|------|
| 语言描述键 `channels.gregtech.casing` | `GTStructureChannels.java:83-87` + `en_US.lang:2323` | 三者描述**无法区分**（当前恰好都指向同一句话，无害） |
| `ChannelDescription` 注册表对象 | `ChannelDescription.java:23`（`Map<String, ChannelDescription> registry`）、`:31`、`:62`（`computeIfAbsent(channel, ...)`） | 三者落进**同一个 `ChannelDescription` 实例** |
| indicator 值表 `items`（`ItemStack → channelValue`） | `ChannelDescription.java:26`、`:63` | **值语义在同一命名空间内混叠**：值 3 对 `TIER_CASING` 用户是 `sBlockCasings1` meta 2，对 `METAL_MACHINE_CASING` 用户是 `BlockCasings12` meta 12（`BlockCasings12.java:39`、`CasingTier.java:40-41`、`:47-52`）。方块键不同故无键冲突，**但同一个 (id, 值) 指向不同方块** |
| 工具提示 | `StructureLibAPI.java:380-386` | `structurelib.tooltip.channelvalue` 只显示 `casing`，玩家/导出器无法区分 |

**缓解事实（已实测，重要）**：**没有任何一个多方块同时使用这 3 条中的 2 条**。验证命令：

```powershell
$all = Get-ChildItem -Recurse -Filter *.java -Path D:\Github\GTNH\GT5-Unofficial\src | Select-Object -ExpandProperty FullName
$set = @('METAL_MACHINE_CASING','TIER_CASING','ALCHEMICAL_CASING')
foreach($f in $all){ $t=Get-Content $f -Raw; $h=@(); foreach($c in $set){ if($t -match "GTStructureChannels\.$c"){ $h+=$c } }
  if($h.Count -ge 2){ "$($f) -> $($h -join ', ')" } }
# 输出为空 = 无冲突
```

因此**在 GT5U 当前版本内，按"多方块实例"消歧即可完全规避问题**；但**按 id 全局消歧不安全**（原因见上表第 3 行的值混叠）。

---

## 3. 作用域相交性结论

### 3.1 分派链路（完整证据链）

```
GTStructureChannels.X.use(elem)                       // IStructureChannels.java:39-41
  -> StructureUtility.withChannel(X.get(), elem)      // StructureUtility.java:2821-2887
     -> ChannelDataAccessor.withChannel(trigger, ch)  // ChannelDataAccessor.java:46-59  (把子通道值写进 stackSize)
        -> ofBlocksTiered.getHint(trigger)            // StructureUtility.java:720-723    (值 -> allKnownTiers 下标)
           -> spawnHint / placeBlock / getBlocksToPlace / survivalPlaceBlock
```

位置 → 通道的绑定发生在**结构定义期**：

```java
// StructureDefinition.java:19
private final Map<Character, IStructureElement<T>> elements;
// StructureDefinition.java:184-190  —— 注意 putIfAbsent：同字符重复 addElement 被静默忽略
public Builder<T> addElement(Character name, IStructureElement<T> structurePiece) { elements.putIfAbsent(name, structurePiece); ... }
// StructureDefinition.java:210 / :226 —— 结构串里每个字符 -> 恰好一个元素
... e.getValue().chars().mapToObj(c -> (char) c).distinct().map(elements::get) ...
... e.getValue().chars().mapToObj(c -> elements.get((char) c)) ...
```

### 3.2 形式化

对某多方块 `M`（一个 `IStructureDefinition` + 一组 `construct`/`checkMachine`）：

- 设 `Sym(M)` = 结构定义中所有符号（`'A'`…）的集合。由 §3.1，`Sym → IStructureElement` 是**函数**（`Map<Character, …>`）。
- 设 `Pos(s)` = 符号 `s` 在所有 shape 中出现的坐标集合。
- 设 `wrap(e) ⊆ Channels` = 元素 `e` 的 **hint/place 路径**所读的通道集合（含 `.use()` 包裹 + 元素内部 `getValue`/`hasValue`/`getValueClamped` 的读取）。
- 定义 **`scope(ch) = ⋃ { Pos(s) | s ∈ Sym(M), ch ∈ wrap(elements[s]) }`**。

`scope` 是**位置的并集**，所以：

> **`scope(a) ∩ scope(b) ≠ ∅` ⟺ ∃ 符号 `s`，其元素同时在 hint/place 路径读 `a` 和 `b`。**

### 3.3 结论一：替换型通道两两不相交（结构性成立）

**证明**：每个位置 `p` 属于**恰好一个**符号 `s`（shape 是字符矩阵，`StructureDefinition.java:210`），而每个符号**恰好一个**元素（`Map`，`putIfAbsent`）。因此 `p` 的参照方块集合只由 `wrap(elements[s])` 决定。若结构定义中不存在"单个元素同时读两个通道"，则任意两个通道的 `scope` 必然由**不同符号**贡献，而不同符号的位置集合不相交（同一位置的字符唯一）。**∎**

**代码佐证**：

- `StructureDefinition.java:19`（`Map<Character, IStructureElement<T>>`）
- `StructureDefinition.java:184-190`（`putIfAbsent`，符号唯一绑定）
- `StructureDefinition.java:210`、`:226`（字符 → 元素，单值映射）
- 绝大多数通道用法都是"标准 `.use(ofBlocksTiered(...))`"（如 `MTEElectricBlastFurnace.java:81-84` 的 `'C'`、`MTEMultiAutoclave.java:192-196` 的 `'F'`），`wrap` 恰为单元素集合。

**全库扫描结果**（见 §3.7 命令）：**实现自定义 `IStructureElement` 且读 ≥2 个通道的文件只有 1 个** —— `MTELapotronicSuperCapacitor.java`。其余多方块（含 4 通道的 `MTEMultiAutoclave`、`MTEChemicalPlant`）均满足不相交。

### 3.4 例外实例（必须单独列出）：`MTELapotronicSuperCapacitor`

**这是本次调研发现的唯一一处作用域相交，按风险 2 协议必须为该机记录例外规则。**

具体机制：

```java
// MTELapotronicSuperCapacitor.java:203-214
.addElement(
    'c',
    ofChain(
        onlyIf(te -> te.topState != TopState.NotTop,
            onElementPass(te -> te.topState = TopState.Top,
                chainAllGlasses(-1, (te, t) -> te.glassTier = t, te -> te.glassTier))),   // <- BOROGLASS 分支
        onlyIf(te -> te.topState != TopState.Top,
            onElementPass(te -> te.topState = TopState.NotTop, CellElement.INSTANCE))))    // <- 未包裹的 CellElement
.addElement('C', GTStructureChannels.LSC_CAPACITOR.use(CellElement.INSTANCE));          // <- LSC_CAPACITOR 包裹
.addElement('b', buildHatchAdder(...)
    .hatchItemFilterAnd((t, h) -> GTStructureChannels.BOROGLASS.getValue(h) < 6        // :195  BOROGLASS 影响舱口过滤
        ? filterByMTEClass(ImmutableList.of(MTEHatchEnergyTunnel.class, MTEHatchDynamoTunnel.class)).negate()
        : s -> true)
    ...)
```

`CellElement`（自定义元素）在自动放置路径里**同时读两个通道**：

```java
// MTELapotronicSuperCapacitor.java:1254-1270
public PlaceResult survivalPlaceBlock(..., ItemStack trigger, AutoPlaceEnvironment env) {
    if (check(t, world, x, y, z)) return PlaceResult.SKIP;
    // glass for LSC can be paired with capacitors up to 3 tiers higher
    int glassTier = GTStructureChannels.BOROGLASS.getValue(trigger) + 2;         // <- 读 BOROGLASS
    ...
    if (GTStructureChannels.LSC_CAPACITOR.hasValue(trigger)) {                    // <- 读 LSC_CAPACITOR
        int capacitorTier = GTStructureChannels.LSC_CAPACITOR
            .getValueClamped(trigger, 1, Capacitor.VALUES_BY_TIER.length);
        if (Capacitor.VALUES_BY_TIER[capacitorTier - 1].getMinimalGlassTier() > glassTier) {
            env.getChatter().accept(new ChatComponentTranslation("kekztech.structure.glass_incompatible"));
            return PlaceResult.REJECT;                                           // <- 两通道联合判定
        }
        ...
```

**相交的三重性**：

1. **元素级相交**：符号 `'C'` 的参照方块集由 `LSC_CAPACITOR`（`withChannel` 换值）**和** `BOROGLASS`（元素内部读）**共同**决定 → `scope(LSC_CAPACITOR) ∩ scope(BOROGLASS) ≠ ∅`。
2. **符号内相交**：符号 `'c'` 通过 `onlyIf(te -> te.topState …)` 在**运行期**解析为 `chainAllGlasses`（BOROGLASS）或 `CellElement.INSTANCE`（内部又读 BOROGLASS + LSC_CAPACITOR）——**同一位置的控制通道随运行状态变化**。
3. **`'b'` 的舱口过滤**也被 `BOROGLASS` 影响（`:195`）——`BOROGLASS` 的作用域甚至溢出到舱口符号。

**此外还有检查期值耦合（与位置无关，见 §4.1.2）**：`checkMachine` 在 `:565-579` 用**已放置玻璃的电压等级**与**已放置电容的最高档**做比较。

**对 T0.5 的直接影响**：格式必须支持"某变体的某位置由多个通道共同决定"的例外表达；**不能假定"每格归属唯一通道"**。最小可行方案见 §5.3。

### 3.5 尺寸型通道的"作用域"是另一种东西

`STRUCTURE_HEIGHT` / `STRUCTURE_LENGTH` **从不绑定到符号**（`.use()` 命中数 = 0），只被 `construct`/`survivalConstruct` 读取：

```java
// MTEDistillationTower.java:288-296
public void construct(ItemStack stackSize, boolean hintsOnly) {
    buildPiece(STRUCTURE_PIECE_BASE, stackSize, hintsOnly, 1, 0, 0);
    int tTotalHeight = GTStructureChannels.STRUCTURE_HEIGHT.getValueClamped(stackSize, 3, 12);
    for (int i = 1; i < tTotalHeight - 1; i++) buildPiece(STRUCTURE_PIECE_LAYER_HINT, stackSize, hintsOnly, 1, i, 0);
    buildPiece(STRUCTURE_PIECE_TOP_HINT, stackSize, hintsOnly, 1, tTotalHeight - 1, 0);
}
```

即尺寸型通道的"作用域"是**重复片段的份数**，它**改变了位置集合本身**（增加/减少 slice）。这带来两条格式设计含义：

1. 尺寸型通道**不与替换型通道争位置**（前者决定"有哪些位置"，后者决定"某位置是什么方块"）→ 二者天然正交，**但叠加顺序必须是"尺寸 → 骨干 → 替换"**（与计划 T1.4 的 `尺寸型 → 骨干 → 替换型 → 运行态` 一致，本节为其提供代码依据）。
2. 尺寸型通道的**有效域随机器而变**，且**不是"1..max"而是"min..max"**（`getValueClamped` 的偏移语义，§2.3 机制 C）。例：`MTEDistillationTower` 3..12、`MTEPowerSubStation` 4..18、`MTELapotronicSuperCapacitor` 4..50、`MTEAssemblyLine` 5..16、`MTEIndustrialCokeOven` 1..16。

**6 条尺寸型读取点的 min/max 全表**：

| 机器 | 通道 | min..max | 代码位置 |
|------|------|----------|----------|
| `MTEDistillationTower` | `height` | 3..12 | `MTEDistillationTower.java:291`、`:305` |
| `MTEMegaDistillTower` | `height` | 3..12 | `MTEMegaDistillTower.java:324`、`:339` |
| `MTEAdvDistillationTower` | `height` | 3..12 | `MTEAdvDistillationTower.java:229`、`:242` |
| `MTEPowerSubStation` | `height` | 4..18 | `MTEPowerSubStation.java:373`、`:384` |
| `MTELapotronicSuperCapacitor` | `height` | 4..50 | `MTELapotronicSuperCapacitor.java:606`、`:615` |
| `MTETankTFFT` | `height` | `DEFAULT_LAYER_AMOUNT`..`MAX_LAYER_AMOUNT` | `MTETankTFFT.java:376`、`:390` |
| `MTEAssemblyLine` | `length` | 5..16 | `MTEAssemblyLine.java:428`、`:439` |
| `MTEAdvAssLine` | `length` | 5..16 | `MTEAdvAssLine.java:245`、`:257` |
| `MTEIndustrialCokeOven` | `length` | 1..16 | `MTEIndustrialCokeOven.java:211`、`:233`（`MAX_LENGTH=16`，`:68`） |
| `MTENetworkSwitchAdv` | `length` | 1..`MAX_LENGTH` | `MTENetworkSwitchAdv.java:147`、`:167` |

> **注意**：`MTEYottaFluidTank` 也有 1..15 层的结构高度，但**用的是隐式循环而非具名通道**（`MTEYottaFluidTank.java:276-279`：`while (structureCheck_EM(YOTTANK_MID, ...)) cnt++;`）。**"结构尺寸可变"≠"存在尺寸通道"**——T1.2 的通道探测必须以"是否读 `STRUCTURE_HEIGHT/LENGTH` 通道"为准，不能以"尺寸是否可变"为准，否则会误报。

### 3.6 `gt_hatch` 与其余通道语义正交

`HATCH` 只被 `HatchElementBuilder` 用作**是否允许自动放置舱口**的开关（`HatchElementBuilder.java:527`），它既不绑定符号也不改方块编号。其作用域是"所有 `buildHatchAdder(...)` 符号"，与替换型通道的符号**可能重叠**——但**语义维度不同**（一个决定"能不能放舱口"，一个决定"放哪种方块"），不构成 §3.2 意义上的 `scope` 相交。

**格式含义**：`gt_hatch` 不是"取值通道"，**不应生成滑杆**。参考实现也未给它生成滑杆（它不在 `ConstructableData.channelMaxTierMap` 里，因为 `HatchElementBuilder` 的元素不被 `StructureHacks.getStacksForElement` 识别为 tiered/channel 元素）。建议 T0.5 把 `gt_hatch` 归为**布尔开关**（或直接按"非取值通道"处理并在通道清单里标注 `kind`）。

### 3.7 验证方法（可复现）

**方法 1 —— 全库扫描"读 ≥2 通道的自定义元素"**（本次得到唯一相交实例）：

```powershell
$all = Get-ChildItem -Recurse -Filter *.java -Path D:\Github\GTNH\GT5-Unofficial\src | Select-Object -ExpandProperty FullName
foreach($f in $all){
  $txt = Get-Content $f -Raw
  if($txt -notmatch 'IStructureElement'){ continue }
  $names = (Select-String -Path $f -Pattern 'GTStructureChannels\.(\w+)' -AllMatches).Matches |
           ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
  if($names.Count -lt 2){ continue }
  $reads = Select-String -Path $f -Pattern 'GTStructureChannels\.\w+\.(getValue|getValueClamped|hasValue)'
  if($reads.Count -ge 1){ "--- $f channels=[$($names -join ',')]"; $reads | ForEach-Object { "    L$($_.LineNumber): $($_.Line.Trim())" } }
}
# 输出恰好 3 个文件：MTEPowerSubStation（2 处均为 height，非相交）、
#                   MTELapotronicSuperCapacitor（★ 相交）、
#                   MTETankTFFT（仅 1 处 field 读取，非相交）
```

**方法 2 —— 以运行时注册表反查（推荐给 T1.2 用，比符号遍历更可靠）**

`ChannelDescription` 是 StructureLib 暴露的**权威通道↔取值注册表**：

```java
ChannelDescription.get(channelId)      // ChannelDescription.java:28-32
ChannelDescription.getAll()            // :67-69   全量通道
ChannelDescription.iterate(block)      // :40-45   「这个方块是哪些通道的第几档」
desc.getItems()                        // :91-93   ItemStack -> channelValue
desc.getDescriptions()                 // :87-89   modid -> 语言键
```

`GTStructureChannels.register()`（`GTStructureChannels.java:81-88`）在 `GTMod.java:389` 被调用，`registerAsIndicator`（`GTStructureChannels.java:76-79`）在各方块类中填充 `items`。**这是导出期获取"通道取值域"的首选数据源**，因为它不依赖对匿名 `withChannel` 类做反射。

**方法 3 —— BlockRenderer6343 现有做法（对照）**

`ConstructableData.channelMaxTierMap` 的来源与计算：

```java
// ConstructableData.java:62-69  —— setMaxTier
public void setMaxTier(int tier, @NotNull String channel) {
    if (this == EMPTY) return;
    hasData = true;
    maxTotalTier = Math.max(maxTotalTier, tier);
    if (!channel.isEmpty() && channelMaxTierMap.getInt(channel) < tier) channelMaxTierMap.put(channel, tier);
}
// ConstructableData.java:25,29 —— 字段
private final Object2IntMap<String> channelMaxTierMap = new Object2IntOpenHashMap<>();   // 键=通道 id 字符串
private int maxTotalTier = 1;
```

填充路径（**关键**）：`StructureHacks.extractTieredBlocks`（`StructureHacks.java:113-142`）从 `tier=0` 起，令 `holo.stackSize = tier++ + 1`，反复调 `element.getBlocksToPlace(...)`，直到返回空 **或新方块与上次相同**（`ConstructableData.addItemTier` 的 `lastHash == hash` 判据，`:51-54`）则中断，最后 `data.setMaxTier(tier - 1, channel)`。

由于 `withChannel.getBlocksToPlace` **不换通道**（§2.3.1 第 5 条），`getHint` 实际走的是 `allKnownTiers` 提示列表 → **`channelMaxTierMap[id]` 的物理含义 = 该通道 `allKnownTiers` 提示列表的长度**（而非某种"等级数"）。这正好与 `en_US.lang` 声明的区间一致（如 `coil` → 14）。

通道 id 的取得靠对匿名类的 `val$channel` 字段反射（`StructureHacks.java:60`、`:144-154`），因此**只识别 `withChannel` 直接包裹的元素**——`TFFT_FIELD` 这类"自定义元素直读通道"的通道**不会被探测到**（实测 `BlockRenderer6343` 中无 `field` 通道）。**T1.2 必须补上这条路径，否则会漏掉 TFFT_FIELD。**

`maxTotalTier` 有两个来源：

1. **有通道时**：`extractTieredBlocks` 的 `setMaxTier(tier-1, channel)` 取所有通道的最大值（`ConstructableData.java:65` 的 `Math.max`）。
2. **无通道时**：`GTConstructableScan.java:96-104` 走 `ObserverWorld.estimateTierFromConstructable`，它真实放置控制器（`FAKE_PLAYER` + `onItemUse`，`ObserverWorld.java:156-163`），再逐级调 `multi.construct(holo, false)` 直到不再产生新方块：

```java
// ObserverWorld.java:174-189
private int estimateTier(IConstructable multi) {
    int tier = 0; ItemStack holo = HOLO_STACK.copy();
    do { holo.stackSize = tier + 1; hasChanged = false;
         if (... multi instanceof INEIPreviewModifier modifier) modifier.onPreviewConstruct(holo);
         multi.construct(holo, false);
    } while (tier++ < MAX_TRIES && hasChanged);
    return tier - 1;
}
```

**结论**：`maxTotalTier` 是**探测值**（试出来的），不是声明值。**仅总 Tier 的多方块**走的正是这条路径（`setMaxTier(tier, "")`，空通道字符串只更新 `maxTotalTier`）——这与 T0.5 fixture #2 与 T2.4 "无具名通道只显示 Tier 滑杆" 的要求吻合。

---

## 4. 耦合约束来源

### 4.1 检查期耦合（`checkMachine`，代码显式）

#### 4.1.1 尺寸 × 替换：`MTEIndustrialCokeOven`（**最重要的一处**）

```java
// MTEIndustrialCokeOven.java:206-223  —— 构造期
public void construct(ItemStack stackSize, boolean hintsOnly) {
    int extraSlices;
    if (getCoilTier() >= HeatingCoilLevel.MAX.getTier() + 1) {
        extraSlices = stackSize.stackSize;                                                   // 用「总 Tier」主通道
    } else {
        extraSlices = GTStructureChannels.STRUCTURE_LENGTH.getValueClamped(stackSize, 1, MAX_LENGTH);  // 用「length」子通道
    }
    ...
}
// MTEIndustrialCokeOven.java:279-287  —— 检查期（镜像约束）
if (getCoilTier() >= HeatingCoilLevel.MAX.getTier() + 1) {
    while (checkPiece(STRUCTURE_PIECE_NEXT, ...)) { width++; }                    // 不限长（上限 MAX_LENGTH 失效）
} else {
    while (width < MAX_LENGTH - 1 && checkPiece(STRUCTURE_PIECE_NEXT, ...)) { width++; }   // 限长 MAX_LENGTH
}
// MTEIndustrialCokeOven.java:371-373
public int getCoilTier() { return this.coilLevel == null ? 0 : (int) this.coilLevel.getTier() + 1; }
// MTEIndustrialCokeOven.java:68
private static final int MAX_LENGTH = 16;
```

> **`coil` 通道的档位决定了 `length` 通道与「总 Tier」谁生效，并且决定长度是否受 `MAX_LENGTH` 约束。**
> **`coil` 与 `length` 的位置集合不相交（§3.3 成立），但二者语义强耦合。** 这正是"因子化对多数机器成立、但对少数机器必须记录例外规则"的典型——是 T0.5 格式必须能表达的第一类约束。

**额外风险**：`construct()` 依赖**实例状态** `getCoilTier()`，而非纯函数式地依赖 trigger。`checkMachine` 会把 `coilLevel` 重置为 `HeatingCoilLevel.None`（`:273`）→ `getCoilTier()==0` → 走 `else` 分支。**导出期必须显式控制该状态**，否则同一 trigger 在不同调用顺序下会得到不同几何。→ 列入 §6 风险。

#### 4.1.2 通道 × 通道：`MTELapotronicSuperCapacitor`（玻璃 ↔ 电容）

```java
// MTELapotronicSuperCapacitor.java:565-579
// Make sure glass tier is T-2 of the highest tier capacitor in the structure
// Count down from the highest tier until an entry is found
// Borosilicate glass after 5 are just recolours of 0
for (int highestGlassTier = capacitors.length - 1; highestGlassTier >= 0; highestGlassTier--) {
    int highestCapacitor = Capacitor.getIndexFromGlassTier(highestGlassTier);
    if (capacitors[highestCapacitor] > 0) {
        if (Capacitor.VALUES[highestCapacitor].getMinimalGlassTier() > glassTier) return false;
        break;
    }
}
// Glass has to be at least UV-tier to allow TT Laser hatches
if (glassTier < 8) { if (!mEnergyTunnelsTT.isEmpty() || !mDynamoTunnelsTT.isEmpty()) return false; }
```

**这是"两个通道的值域在检查期被联合约束"的确证**：`glassTier` 来自 `BOROGLASS` 符号（`:202`、`:210`），`capacitors[]` 来自 `LSC_CAPACITOR` 符号的 `CellElement.check`（`:1198-1205`）。**位置不相交，值耦合。**

#### 4.1.3 通道 × 通道：`MTEYottaFluidTank`（玻璃 ↔ 存储单元）

```java
// MTEYottaFluidTank.java:281-289
// maxCell+1 = Tier of highest Cell. glassTier is the glass voltage tier
if (maxCell + 3 <= glassTier) { ... return true; }
return false;
```

语义：**玻璃电压等级 ≥ 最高存储单元等级 + 2**。`maxCell` 由结构扫描得出（`:276-279`），`glassTier` 由 `chainAllGlasses`（`:308`）写入。

#### 4.1.4 绝对阈值（非通道间，但同样限制合法取值）

大量机器对 `glassTier` 施加绝对电压门限，例如：

| 机器 | 约束 | 位置 |
|------|------|------|
| `MTECircuitAssemblyLine` | `glassTier >= EV` | `:505` |
| `MTEComponentAssemblyLine` | `glassTier >= UV` | `:347` |
| `MTEPreciseAssembler` | `glassTier >= EV`（且 `casingTier` 决定最大配方等级，`:290` 工具提示） | `:274-276`、`:290` |
| `MTETankTFFT` | `glassTier >= EV` | `:442` |
| `MTELINAC` | `glassTier >= LuV` | `:381` |
| `MTESynchrotron` | `glassTier >= LuV` | `:788` |
| `MTEIndustrialMixer` | `glassTier >= UIV` | `:270` |
| `MTEMegaBlastFurnace` | `glassTier >= UV` / `>= UMV` | `:344`、`:351` |
| `MTEMegaChemicalReactor` | `glassTier >= UV` | `:213` |
| `MTEExtremeEntityCrusher` | `glassTier >= UV` | `:935` |

### 4.2 建造期（自动放置）耦合

只影响**自动放置**，不影响**结构校验**（`checkMachine` 不做此检查）：

```java
// MTELapotronicSuperCapacitor.java:1258-1270   —— 已在 §3.4 引用
// glass for LSC can be paired with capacitors up to 3 tiers higher
int glassTier = GTStructureChannels.BOROGLASS.getValue(trigger) + 2;
if (Capacitor.VALUES_BY_TIER[capacitorTier - 1].getMinimalGlassTier() > glassTier) { ... return PlaceResult.REJECT; }
```

**含义**：一个"合法"取值组合可能**无法被蓝图自动放置**。T1.3 若用自动放置建变体，会撞上这条约束；T1.3 若用 `placeBlock`（非 `survivalPlaceBlock`）则可绕过。**必须在 T1.3 明确采用哪种路径**（见 §6 风险）。

### 4.3 主导模式：**不是"玻璃 ≤ 线圈"，而是"玻璃 ≥ 能量仓等级"**

计划文档与需求书猜测的耦合形式是"玻璃等级 ≤ 线圈等级"。**全库扫描（`glassTier` 的所有比较点，见下表）未发现任何"玻璃 ≤ 线圈"约束**。实际主导模式是：

> **`BOROGLASS`（观测到的玻璃电压等级）≥ 能量仓 tier / 其他部件 tier（当玻璃未达 UMV 时）。**

27 处典型证据（`Select-String -Pattern 'glassTier\s*[<>=]|[<>=]\s*glassTier'`）：

| 机器 | 代码位置 | 比较对象 |
|------|---------|---------|
| `MTEExtremeEntityCrusher` | `:935-936` | `glassTier < UV` 时，`hatch.mTier > glassTier` → false |
| `MTEExtremeIndustrialGreenhouse` | `:314-315` | 同上（阈值 8） |
| `MTEExtremeIndustrialApiary` | `:675-676` | `glassTier < UEV` + 能量仓 tier |
| `MTEMegaBlastFurnace` | `:344,351,353,358` | UV / UMV / 能量仓 tier |
| `MTEMegaOilCracker` | `:267,272,277` | UV / 舱口 tier / 能量仓 tier |
| `MTEMegaChemicalReactor` | `:213,218,223` | 同上 |
| `MTEMegaChemicalReactorLegacy` | `:189,194,199` | 同上 |
| `MTEMegaAlloyBlastSmelter` | `:215-217,223` | 能量仓 tier / UV |
| `MTEElectricImplosionCompressor` | `:234` | `hatch.mTier > glassTier` |
| `MTEFluidShaper` | `:276` | `mEnergyHatch.mTier > glassTier` |
| `MTEMassSolidifier` | `:268` | 同上 |
| `MTELargeFluidExtractor` | `:190-191` | `energyHatch.getTierForStructure() > glassTier`（置 `structureBadGlassTier`） |
| `MTEWormholeGenerator` | `:340-341` | 同上 |
| `MTEIndustrialLaserEngraver` | `:301` | `laserSource.mTier <= glassTier` |
| `MTEAlgaePond` | `:185` | `inputTier > glassTier` |
| `MTEBioVat` | `:283` | 配方所需玻璃等级 |
| `kubatech` 系 | `:931-936`、`:314-315`、`:675-676` | 能量仓 tier |

**格式含义**：这类约束**输入的是一方是通道值、另一方是"非通道的可变结构内容"（放了几级能量仓）**。因此**它无法仅用"通道 A ≤ 通道 B"表达**——只在总 Tier 语义下才近似成立（能量仓等级通常等于总 Tier）。建议按 §4.5 处理。

### 4.4 无法从代码获得的约束及其来源

**不在代码中的约束**（必须承认并给出缺省行为）：

1. **通道组合的"玩家惯例"约束**：如 wiki/教程常建议"玻璃等级配合能量仓等级"，但这是**间接结论**（约束真正来源是 §4.3 的代码阈值），不是独立规则。
2. **未实现通道的取值域**：§2.2 中 6 个无 lang 声明的 id（`piston_block`/`construct`/`super_chest`/`chassis`/`essentia_cell`/`coke_oven_casing`）**没有书面规格**，只能运行时探测。
3. **"未设置"回落到主通道**带来的隐含耦合：由于 `ChannelDataAccessor.getChannelData` 在键缺失时返回 `trigger.stackSize`（`ChannelDescription`→`ChannelDataAccessor.java:99-102`），**选择"Not set"等价于把该通道设为主通道值**。这不显式出现在任何多方块代码中，但**普遍影响 hint/place 结果**（§2.3.1）。
4. **描述/工具提示里的约束文本**：`MultiblockTooltipBuilder.addSubChannelUsage(channel, purpose)`（`MultiblockTooltipBuilder.java:1095-1111`）有 **112 处调用**，其中带语义说明的仅 2 处：
   - `MTEChemicalPlant.java:158`：`"metal machine casing (minimum 70)"`
   - `MTENetworkSwitchAdv.java:293`：`"middle slice count"`
   **这类文本没有 getter 可读**（`MultiblockTooltipBuilder` 无 `getSubChannels`），只能通过反射读 `sLines` 或解析 `getStructureDescription(...)` 输出。**不建议作为约束来源。**

**缺省行为建议（写入 T0.5 契约）**：

| 情形 | 建议缺省行为 |
|------|------------|
| 导出期无法确定某通道的合法取值区间 | 以运行时探测（`ChannelDescription.getItems()` 的键数 / `ConstructableData.channelMaxTierMap`）为准，**记为该通道的 `maxValue`**，并在文件里标注 `domainSource: "probed"` |
| 导出期无法确定任何通道间约束 | **不拒绝任何组合**；装配按"所有通道独立生效"处理，并在文件里置 `couplings: []` + `couplingMode: "none"` |
| 已知存在约束但无法机器表达（如 §4.3 的"玻璃 ≥ 能量仓 tier"） | 记为**软约束**：`{ kind: "note", text: "..." }`，**不参与装配夹取**，仅在 UI 提示；理由是这类约束的另一方不是通道而是结构内容，格式内无法求值 |
| 结构定义里出现"一个位置由多通道共同决定"（§3.4 型） | 该多变体位置**不得进入查表骨干**，必须整体落入该变体的差异规则（见 §5.3） |
| 尺寸型通道取值超出 `min..max` | **夹取到 `max`**（与 GT 的 `getValueClamped` 一致），并在 UI 上把滑杆上限设为 `max` |

---

## 5. 重名消歧建议（T0.5 格式的直接输入）

### 5.1 候选方案对比

| 方案 | 是否安全 | 证据 |
|------|---------|------|
| **只用 id**（`"casing"`） | ❌ **不安全** | 三条共用 `ChannelDescription` 实例与 `items` 值表（`ChannelDescription.java:23,31,62`），同一个 `(id, 值)` 指向不同方块（`CasingTier.java:47-52` vs `BlockCasings12.java:39`）；且滑杆标签相同，用户无法区分 |
| **只用枚举名** | ⚠️ 可用但不足 | 枚举名唯一（实测无重复），但**丢失游戏内 id**，违反计划 §6"通道命名尊重游戏内 id"的硬约束 |
| **枚举名 + id 双键** | ✅ **推荐** | 唯一化（枚举名 30/30 唯一）；id 保留用于对齐游戏内语义、i18n 语言键、`ChannelDescription` 查询 |
| **按多方块实例消歧** | ✅ **必需补充** | 实测无任一多方块同时使用 2 条同 id 通道（§2.4 命令），因此"实例内 id 唯一"成立 → 可作为**校验断言**，但不能替代双键（跨机器引用、工具/文件合并场景仍会歧义） |

### 5.2 建议（T0.5 直接采纳）

1. **文件格式的通道标识用 `{ enumName, id }` 双键**。例：
   ```json
   { "enum": "HEATING_COIL", "id": "coil",          "kind": "replace", "max": 14 },
   { "enum": "TIER_CASING",  "id": "casing",        "kind": "replace", "max": 15 },
   { "enum": "METAL_MACHINE_CASING", "id": "casing", "kind": "replace", "max": 0, "domainSource": "probed" }
   ```
2. **呈现名（UI 标签）取 `enumName` 而非 `capitalize(id)`**，否则三条 `casing` 会在同机出现同名滑杆。当前 `GuiMultiblockHandler.java:189` 用的是 `StringUtils.capitalize(channel)`（即 capitalize(id)）——**这是参考实现的已知缺陷，照抄会继承歧义**。
3. **导出期加断言**：对每个多方块，`id` 集合内不得出现重复；若出现，**导出失败并落盘原因**（因为这意味着该机同时用了 2 条同 id 通道，属于 GT5U 新增用法，必须人工处理）。当前版本该断言永不触发，但能防未来回归。
4. **保留 `id` 用于语言键与 `ChannelDescription` 查询**，但**不要**用它做 UI 唯一键或规则匹配键。
5. **`gt_hatch` 标 `kind: "hatch"`**，不生成滑杆（§3.6）。
6. **尺寸型通道额外存 `min`**（因为值域实际是 `min..max`，见 §3.5），或统一存 `valueSemantics: "clamped-offset"`。

### 5.3 相交实例的例外表达（`MTELapotronicSuperCapacitor`）

按风险 2 协议"发现相交实例 → 格式需为该机记录例外规则"。最小可行方案：

- 每条差异规则除"旧下标 → 新下标"外，**允许一个可选的 `guard` 字段**，表达"该规则仅在以下通道取值满足条件时生效"。这既覆盖 §3.4 的元素级相交（`'C'` 受 `BOROGLASS` 影响），也覆盖 §4.1.1 的尺寸×替换耦合（`length` 仅在 `coil` 达 MAX+1 时生效）。
- **不需要**引入"每格多通道归属"的通用模型——那会把格式复杂度抬高一个量级，而实测只有 1 台机器需要，**且该机的相交位置（`'C'` 列）本就随运行态在两套规则间切换**，可用"多组差异规则 + guard 互斥"表达。
- 建议在文件中把该机标记为 `hasScopeOverlap: true` + 简短说明，供 T1.3/T3.1 抽查。

---

## 6. 开放项与风险

| # | 事项 | 说明 | 建议处理 |
|---|------|------|---------|
| R1 | **计划口径"27 条"已过期** | 实测 30 条（§1.2）。计划 §6 把关清单与 §8 锚点表均写 27 | 回写 `multiblock-channel-renderer-plan.md:91,396`；T0.5/T1.2 以运行时枚举为准 |
| R2 | **相交实例需格式支持** | `MTELapotronicSuperCapacitor`（§3.4） | 按 §5.3 加 `guard`；并在验收中把它列为必测机 |
| R3 | **尺寸型通道的 `min` 语义容易被忽略** | `getValueClamped` 是"值 1 → min"的偏移（`IStructureChannels.java:27-29`），不是 1..max | T0.5 明确 `min` 字段；T2.4 滑杆上限 = `max`，且驱动值需按该语义映射 |
| R4 | **`withChannel.getBlocksToPlace` 不换通道** | `StructureUtility.java:2858-2863` 传原始 trigger，与 `placeBlock`/`spawnHint` 行为不一致 | T1.3 **构造变体必须走 `placeBlock`/`spawnHint`**；`getBlocksToPlace` 只可用于"探测取值域" |
| R5 | **`construct()` 依赖实例状态** | `MTEIndustrialCokeOven.construct` 读 `getCoilTier()`（`:208,230`），而该字段由上次 `checkMachine` 决定 | T1.3 导出前显式设置相关实例字段（或先跑一次 `checkMachine`）；否则同 trigger 结果不稳定 |
| R6 | **自定义元素直读通道的通道会被漏探测** | `TFFT_FIELD` 无 `.use()` 包裹（`MTETankTFFT.java:269`），BlockRenderer6343 的反射只认 `withChannel` 匿名类（`StructureHacks.java:60,144-154`） | T1.2 必须同时用 `ChannelDescription.getAll()/getItems()`（§3.7 方法 2），不能只照搬 `StructureHacks` |
| R7 | **6 个通道无书面取值域** | `piston_block`/`construct`/`super_chest`/`chassis`/`essentia_cell`/`coke_oven_casing` | 全部走运行时探测；格式标 `domainSource: "probed"` |
| R8 | **`casing` 三条的语义在注册表中混叠** | §2.4；当前无机器受影响，但**未来 GT5U 新增机器可能同时用两条** | §5.2 第 3 条的导出期断言 |
| R9 | **`MTELapotronicSuperCapacitor` 的 `glassTier` 计算疑似用下标当电压等级** | `:1259` `BOROGLASS.getValue(trigger) + 2`，而 `getValue` 返回的是**玻璃列表下标**（`GlassTier.java:105-108` 返回 `glassToTierAndIndex` 的右值 = 通道下标），主序列恰为 `index+2 == 电压等级`，但**变体玻璃（subtier>0）不成立** | **不属 T0.4 结论范围**，仅登记供 T1.3 比对几何时留意；如需可作为向上游报告项 |
| R10 | **`glass` 通道值域动态且较大（≈35）** | `GlassTier.getGlassList()`（`GlassTier.java:110-138`）在运行时构造，且含一处 `tierToGlass` 键冲突（`:208-209` 两条 `(tier=11, subtier=1)`）→ 树映射会覆盖一条 | 导出期以运行时探测为准；组合数上限配置（T1.5）需按 ≈35 估算 `glass` 的取值数 |
| R11 | **`structurelib.tooltip` / `gt_hatch` 语言键只覆盖 22 条** | §2.2 | T0.5 的"呈现名"不应依赖 GT 语言文件，应由文件自带 |

---

## 7. 附录：关键代码位置索引

**StructureLib（通道机制本体）**

| 用途 | 位置 |
|------|------|
| 通道 ↔ 取值权威注册表 | `ChannelDescription.java:22-31,40-45,53-65,67-69,87-93` |
| 触发器子通道读写（值必须 > 0；缺失回落 `stackSize`） | `ChannelDataAccessor.java:46-59,95-103,112-121,160-176` |
| `withChannel`：`check` 不换通道；`spawnHint`/`placeBlock`/`survivalPlaceBlock`/`couldBeValid` 换；`getBlocksToPlace` **不换** | `StructureUtility.java:2821-2887`（关键：`:2824-2826`、`:2855`、`:2858-2863`） |
| `ofBlocksTiered`：值 → 提示列表下标、夹取 | `StructureUtility.java:584-614`、`:707-789`（关键：`:720-723`、`:738-757`） |
| 符号 → 元素单值映射 | `StructureDefinition.java:19,184-190,210,226` |
| `LazyStructureElement`（按实例延迟解析；BlockRenderer 靠反射解包） | `LazyStructureElement.java:13-68` |
| `registerChannelDescription` / `registerChannelItem` | `StructureLibAPI.java:363-387` |
| 通道 id 必须小写、值必须 > 0（debug 断言） | `ChannelDescription.java:29,48,55-60`；`ChannelDataAccessor.java:48-49,81-82,116` |

**GT5U（通道定义与用法）**

| 用途 | 位置 |
|------|------|
| 通道枚举全 30 条 | `GTStructureChannels.java:25-54` |
| 通道注册入口（`GTMod` 调用） | `GTStructureChannels.java:76-88`；`GTMod.java:389` |
| 官方取值域声明（22 条） | `src/main/resources/assets/gregtech/lang/en_US.lang:2319-2340` |
| `IStructureChannels.use` / `getValue` / `getValueClamped` / `hasValue` | `IStructureChannels.java:27-41` |
| 玻璃档位与通道下标 | `GlassTier.java:100-138` |
| 机壳档位（`TIER_CASING`） | `CasingTier.java:26-55` |
| 线圈档位（`HEATING_COIL`） | `BlockCasings5.java:81-84`；`HeatingCoilLevel.java:39-42,51-53,84-86` |
| `gt_hatch` 唯一消费点 | `HatchElementBuilder.java:527`（`exclusive` 绕过：`:199,204-207`） |
| 尺寸型×替换型耦合（**最重要**） | `MTEIndustrialCokeOven.java:206-223`、`:279-287`、`:371-373` |
| 检查期通道×通道耦合（玻璃↔电容） | `MTELapotronicSuperCapacitor.java:565-579` |
| 建造期通道×通道耦合 | `MTELapotronicSuperCapacitor.java:1254-1270` |
| 检查期通道×通道耦合（玻璃↔存储单元） | `MTEYottaFluidTank.java:281-289` |
| 作用域相交实例（`'c'`/`'C'` 条件元素 + 双通道元素） | `MTELapotronicSuperCapacitor.java:190-215,1194-1289` |
| 多通道替换型范例（4 通道、不相交） | `MTEMultiAutoclave.java:152-196`、`:239-247` |
| 单通道最小范例（EBF，仅 coil） | `MTEElectricBlastFurnace.java:68-92` |
| 自定义元素直读通道范例（`field`） | `MTETankTFFT.java:149-163,269` |
| 尺寸通道读取点全表 | 见 §3.5 |

**BlockRenderer6343（通道探测与 UI 参考实现）**

| 用途 | 位置 |
|------|------|
| 通道最大值表 / 总 Tier | `ConstructableData.java:25,29,43-69,94-96` |
| 按通道注入取值（`stackSize` 递增 + `lastHash` 去重中断） | `StructureHacks.java:113-142` |
| 匿名类 `val$channel` 反射取 id | `StructureHacks.java:36,55-65,144-154` |
| `LAZY_ELEMENT` / `onElementPass` 解包 | `StructureHacks.java:35,81-85,201-215` |
| 通道 id 字符串 key（**歧义根源**） | `ConstructableData.java:25,55-59,66-68` |
| 通道滑杆生成（范围/0=Not set/标签=capitalize(id)） | `GuiMultiblockHandler.java:178-204` |
| 通道值写入/擦除（0 → `unsetChannelData`） | `GuiMultiblockHandler.java:238-254`；`ChannelDataAccessor.java:112-121,129-140` |
| 无通道回退路径（仅总 Tier） | `GTConstructableScan.java:96-104`；`ObserverWorld.java:174-189` |
| 通道数据复制到全息投影 | `BRUtil.java:132-141` |
