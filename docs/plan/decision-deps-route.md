# T0.2 依赖路线决策记录：compileOnly vs 反射

> **任务**：`multiblock-channel-renderer-plan.md` T0.2
> **决策对象**：为支持 GT 多方块枚举、StructureLib 通道探测、运行态驱动，`mod/gtnh` 是否引入 `compileOnly` 依赖获取编译期 API。
> **本轮边界**：仅调研与决策，**未修改** `dependencies.gradle`，**未运行** gradle。
> **版本基线（本决策的全部结论均以这两个真实 artifact 为准，非源码 HEAD 推测）**：
> - `GT5-Unofficial-5.09.52.283-dev.jar`（`C:\gradle-cache\...\GT5-Unofficial\5.09.52.283\`）
> - `StructureLib-1.4.28-dev.jar`（`C:\gradle-cache\...\StructureLib\1.4.28\`）

---

## 1. 决策结论

**采用编译期依赖**（`compileOnly` 语义，落在 `dependencies.gradle` 中与既有 `runtimeOnlyNonPublishable` 同坐标同版本并列），**并保留一处小而明确的反射残留**（4 个无公开访问器的成员）。

一句话：**该做的反射跑不掉，但该编的必须编** —— 新增的整条"枚举 → 结构定义 → 通道探测 → 运行态"链路几乎全部落在 GT5U/StructureLib 的 **public API** 上，反射重写成本高且**失败是静默的**；而剩余必须反射的部分只有 4 个成员，属于已知、可隔离、可加断言的小面积。

---

## 2. 事实核查：计划书三处前提需要修正

调研中发现计划书 §T0.2 与 §8 的三处描述与代码实际不符，后续任务（尤其 T0.4、T0.5）需按修正后的事实推进：

| # | 计划书原文 | 实际情况 | 影响 |
|---|---|---|---|
| 1 | "通道探测需要 **StructureLib** 的 `IStructureChannels`"（计划书 L73） | `IStructureChannels` **不在 StructureLib**，而在 **GT5U**：`gregtech/api/structure/IStructureChannels.java`（pinned jar 内 `gregtech/api/structure/IStructureChannels.class` 已确认存在） | 通道探测的编译期依赖对象是 **GT5U**，不是 StructureLib；只加 StructureLib 不够 |
| 2 | "通道定义全集（**27 条**）"（计划书 L91、L396） | `GTStructureChannels` 实为 **30 条**枚举常量 | T0.4/T0.5 的通道清单规模按 30 计 |
| 3 | "GT5U 内部状态机（运行态进入，风险最高处）"（计划书 L73） | 状态机字段位于 `gregtech.api.metatileentity.implementations.MTEMultiBlockBase`，**全部为 `public`**（见 §5.3 javap 证据），并非"内部/私有" | "风险最高"这一判断需要下修；它是**公开 API 表面**，这反而**加强**了编译期路线的理由 |

> 计划书 §T0.2 提到的 `GregTechMetaTileRegistry` 实际位于 `mod/gtnh/src/main/java/com/lightning/mod/core/registry/GregTechMetaTileRegistry.java`（不在 `core/registry/gt/` 下；`gt/` 下只有 `GregTechBlockReflection`）。

### 2.1 现状核实（Lightning 侧）

- `mod/gtnh/dependencies.gradle` L13–14：`GT5-Unofficial` 与 `StructureLib` 均为 `runtimeOnlyNonPublishable`，**不在编译类路径**。
- 全仓 `mod/gtnh/src` 的 import 扫描结果：**零** `gregtech.*` / `com.gtnewhorizon.*` / `codechicken.*` / `ic2` / `appeng` 编译期 import（仅 `cpw.mods.*` 即 Forge/FML）。当前对 GT 生态是 **100% 反射**。
- 既有反射资产已成规模：45 处 `Class.forName` / `getDeclaredMethod` / `setAccessible` / `ReflectionHelper`，其中 `client/export/GtTextureResolver.java` 是重度反射（L71–578，含 `mIconName` 私有字段 + `setAccessible`）。

**这意味着引入编译期依赖会形成"混合模型"**：新的多方块链路走编译期，而 `GtTextureResolver` 那类 GT **渲染内部**（私有字段、图标名）仍必须反射。这不是缺陷 —— 见 §4.2，那部分本来就没有公开访问器。

---

## 3. 需要什么 API（逐项，均以 pinned jar 的 `javap` 输出为准）

### 3.1 枚举（Phase 1 / T1.2）

| 成员 | 归属 | 可见性 |
|---|---|---|
| `GregTechAPI.METATILEENTITIES` | GT5U `gregtech.api` | public static 字段 |
| `IConstructable` | StructureLib 1.4.28 | public interface |
| `IConstructableProvider#getConstructable()` | StructureLib 1.4.28 | public |
| `ISurvivalConstructable#survivalConstruct(...)` | StructureLib 1.4.28 | public |
| `IMetaTileEntity#getStackForm(int)` | GT5U `gregtech.api` | public |

参考实现的做法（`BlockRenderer6343/.../GTNEIMultiblockHandler.java` L40–44）就是编译期 `instanceof IConstructable` 遍历 `METATILEENTITIES`。

### 3.2 结构定义与通道探测（T1.2 / T1.3）

| 成员 | 归属 | 可见性 |
|---|---|---|
| `IConstructable#getStructureDefinition()` | StructureLib 1.4.28 | public（default method） |
| `StructureDefinition#getStructures()` → `Map<String, IStructureElement<T>[]>` | StructureLib 1.4.28 | public |
| `IStructureElement#getBlocksToPlace(...)` / 内嵌 `BlocksToPlace` | StructureLib 1.4.28 | public |
| `AutoPlaceEnvironment#fromLegacy(IItemSource, EntityPlayer, Consumer)` | StructureLib 1.4.28 | public static |
| `ChannelDataAccessor`（get/set/iterate/wipe） | StructureLib 1.4.28 | public class |
| `IStructureChannels`（`get()` / `getDefaultTooltip()` / `use()` / `getValue`） | **GT5U** `gregtech.api.structure` | public interface |
| `GTStructureChannels`（30 条枚举） | GT5U `gregtech.common.misc` | public enum |
| `CasingInfo#channel` | GT5U `gregtech.api.structure` | **public 字段**（`IStructureChannels`） |
| `StructureWrapper#casings` | GT5U `gregtech.api.structure` | **public 字段**（`Char2ObjectArrayMap<CasingInfo<MTE>>`） |
| `GTStructureUtility#ofCoil(...)` / `#activeCoils(...)` / `#buildHatchAdder()` | GT5U `gregtech.api.util` | public static（pinned 版本已确认存在） |

### 3.3 运行态驱动（T0.3 / T1.3）

见 §5.3，全部为 public。

---

## 4. 编译期依赖能买到什么、买不到什么

### 4.1 买到的（这是决策的主要依据）

1. **泛型密集的链路不必反射重写。** `getStructures()` 返回 `Map<String, IStructureElement<T>[]>`（泛型数组），下游是 `getBlocksToPlace(...)` → 内嵌类 `BlocksToPlace` → 需要 `AutoPlaceEnvironment`。全反射实现要一路 `Object` 传递 + `Array.get` + 手工构造环境对象，代码量与出错面都很大。
2. **参考实现可直接移植。** `BlockRenderer6343` 本身就是编译期依赖写法：其 `dependencies.gradle` L4–6 为 `api('...StructureLib:1.4.34:dev')` + `implementation('...GT5-Unofficial:5.09.52.398:dev')`。走编译期路线时，`GTConstructableScan` / `StructureHacks` / `ObserverWorld` 的移植是**逐行翻译**；走反射则是**整体重写**。
3. **失败模式从"静默"变"响亮"。** 这是本决策最硬的论据：
   - **反射**：字段/方法改名后，既有代码模式是 `catch (Throwable) { return null/false; }`（`GregTechMetaTileRegistry` L57–59、L118–120、L138–140、L191–193；`GregTechBlockReflection` L17–19）。结果是 **GT 机器被静默降级成普通方块，构建照样通过**，回归只会在渲染结果里以"内容不对"的形式暴露。
   - **编译期**：改名即 `compileJava` 失败，定点、即时、可定位。
4. **零运行期/发布期代价。** GT5U 与 StructureLib **本来就在运行类路径上**（L13–14 的 `runtimeOnlyNonPublishable`）。加 `compileOnly` 只增加"编译期可见性"这一个维度：不新增运行期依赖、不改变 jar 体积、不写入发布 POM（`usesMavenPublishing = false`，且 `compileOnly` 本身不发布）。
5. **版本锁步在本仓库恰好是现成的。** `dependencies.gradle` L8 已有 `def gt5Ver = project.findProperty("gtnhRun.gt5Version") ?: "5.09.52.283"` 这一单点来源。且经核实 **GT5U 5.09.52.283 自己的 `dependencies.gradle` 声明 `StructureLib:1.4.28`** —— 与 Lightning 已 pin 的 `1.4.28` 完全一致。即 Lightning 当前的 (GT5U, StructureLib) 版本对**本身就是自洽的**，无需为编译期引入而升级任何一方。

### 4.2 买不到的（编译期也无法消除的反射残留）

**关键结论：即使加上完整编译期依赖，仍有一部分成员没有任何公开访问器。** 这不是推测 —— 参考实现 `BlockRenderer6343` 已经持有 `api(StructureLib)` + `implementation(GT5U)`，**却依然在反射**。以下 4 项在 pinned 版本上逐一复核：

| # | 成员 | pinned 版本实况 | 参考实现如何绕过 |
|---|---|---|---|
| 1 | `StructureUtility.withChannel(String, IStructureElement)` 返回的**匿名类**中所捕获的通道名 | 源码 L2821–2822 为 `return new IStructureElement<T>() {...}`；通道名只存在于合成的 `val$channel` 字段，**无任何 getter** | `StructureHacks.java` L50–51、L60、L144–154：`ReflectionHelper.findField(channelElem.getClass(), "val$channel")` + MethodHandle |
| 2 | `LazyStructureElement` | javap（1.4.28）：**包级私有类** `class ...LazyStructureElement<T>`，其 `get(T)` 为 **private** | `StructureHacks.java` L56–59：`Class.forName` + `ReflectionHelper.findMethod(..., {"get"}, ...)` |
| 3 | `HatchElementBuilder#mHint` | javap（pinned GT5U）：`private int mHint;`（源码 `HatchElementBuilder.java` L54） | `GTGuiMultiblockHandler.java` L83–84：`ReflectionHelper.findField(HatchElementBuilder.class, "mHint")` |
| 4 | `HatchElementBuilder` 匿名内部类的合成外部引用 `this$0` | 编译器合成，无 API | `GTGuiMultiblockHandler.java` L82–83：`findField(hatchEle.getClass(), "this$0")` |

**对 #1 的一条可选优化（仅部分适用）**：GT5U 自己的 `StructureWrapper#getStructureElement(char)` 源码 L344–346 是 `if (casing.channel != null) element = casing.channel.use(element);`，而 `CasingInfo#channel` 是 **public 字段**、`StructureWrapper#casings` 也是 **public 字段**。因此对走 `IStructureProvider` 新结构系统的多方块，可从 `CasingInfo#channel.get()` 直接拿到通道 id，**完全绕开 `val$channel` 反射**。

> **但覆盖面有限，不能作为主路径**：`IStructureProvider` 在全仓仅由 `MTEEntropicProcessor`、`MTEDecayWarehouse` 两个 MTE 实现，且 `StructureWrapper` 在具体 MTE 里是 `protected final` 字段、**没有通用访问器**。绝大多数 GT 多方块仍走旧的 `IConstructable` + `IStructureDefinition` 路径。
> **结论**：`val$channel` 反射在可预见范围内**必须保留**，作为通用通道名提取机制；`CasingInfo#channel` 路径可作为"新结构系统"的增强分支，但不是替代。此项建议在 T1.2 实施时实测覆盖率后再定，**不要在 T0.2 阶段承诺消除**。

---

## 5. 断裂面分析

### 5.1 编译期路线：断裂面

| 断裂源 | 表现 | 何时暴露 | 处置成本 |
|---|---|---|---|
| GT5U 改动 `api` 包公开签名/字段名（如 `mMaxProgresstime` 更名） | `compileJava` **编译失败** | 升级 GT5U 的那次构建 | 低：编译器直接给出位置；改动局限在 T1.x 新包内 |
| StructureLib 改动公开签名 | 同上 | 同上 | 低 |
| **编译版本 ≠ 运行版本**（最危险的一种） | 编译通过、运行期 `NoSuchMethodError` / `NoSuchFieldError` | `runClient` 或 T1.6 自动导出时 | 中：靠 §5.4 的锁步纪律消灭 |
| GT 缺席时加载含 GT 引用的类 | `NoClassDefFoundError`（**类加载期**，不是调用期） | 无 GT 环境启动 | 中：靠 §7 的类隔离纪律消灭 |

### 5.2 反射路线：断裂面

| 断裂源 | 表现 | 何时暴露 | 处置成本 |
|---|---|---|---|
| 上表任意一项改名 | **静默降级**（既有 `catch (Throwable)` 模式返回 safe default） | 可能**永不**在构建/测试中暴露，只体现为渲染内容错误 | **高**：无信号，需人工发现 |
| 第 4 节 4 项残留 | 无论哪条路线都同样存在 | 同参考实现 | 低：与参考实现同源，风险已知且被上游持续验证 |
| 反射成员的**语义**变化（名字不变、行为变） | 编译期路线同样无法防（编译期只保证签名） | —— | 两条路线**相同** |

> 注意最后一行：编译期依赖**不保护语义**。它保护的是"名字/签名"这一层。因此 §4.2 的 4 项残留 + 语义断言（T1.2 的"枚举数量与 BlockRenderer6343 同量级"自检）仍不可省。

### 5.3 专项：运行态进入（计划书 l 点名"风险最高处"）

**结论：这是支持编译期路线的最强单项，因为所需表面是公开 API。**

`javap -p` 于 **pinned GT5U 5.09.52.283** 的 `gregtech.api.metatileentity.implementations.MTEMultiBlockBase`：

```
public boolean mMachine;
public boolean mWrench;
public int mProgresstime;
public int mMaxProgresstime;
public int mStartUpCheck;
public int mRuntime;
public int mEfficiency;
public int mUpdate;
public java.util.ArrayList<...MTEHatchMaintenance> mMaintenanceHatches;
public void onPostTick(gregtech.api.interfaces.tileentity.IGregTechTileEntity, long);
public boolean checkRecipe(net.minecraft.item.ItemStack);
public gregtech.api.recipe.check.CheckRecipeResult checkProcessing();
protected final boolean checkRecipe();          // 无参重载，protected
protected ...CheckRecipeResult doCheckRecipe();  // protected
```

配套事实（pinned GT5U 源码）：

- 活动态是**派生量**：`MTEMultiBlockBase.onPostTick` L632 `aBaseMetaTileEntity.setActive(mMaxProgresstime > 0);`
- 另有公开逃生门：`gregtech/api/interfaces/tileentity/IMachineProgress.java` L62 `void setActive(boolean aActive);`（公开接口方法）
- `checkRecipe(ItemStack)`（L1039）内部 L1066 `mMaxProgresstime = processingLogic.getDuration();`
- **服务端门槛**：`onPostTick` L598 `if (aBaseMetaTileEntity.isServerSide())`，`else`（L644）仅 `startActivitySound()`。整条运行态机只跑在服务端侧 —— 这是 T0.3 的**关键技术条件**，与依赖路线无关，但必须在探针中验证假世界满足它（`DummyWorld` 用 `World` 构造器、`isRemote` 默认 `false`，初判满足；须实测）。

**因此**：这些成员既"编译期可达"又"反射也够得着"，两条路线都能做。但正因为它们是 `public` 字段，**改名风险真实存在**（公开字段不受 API 稳定性保护），编译期路线把这一风险转成构建失败，反射路线则让它静默 —— 这就是决策的落点。

### 5.4 版本锁步（编译期路线的硬前提）

三条必须同时成立，否则编译期路线反而更糟：

1. **同一坐标、同一版本**：`compileOnly` 与 `runtimeOnlyNonPublishable` 必须用**同一个变量**展开，禁止各写一个字面量。
2. **`StructureLib` 版本单点化**：现状 L14 把 `1.4.28` 写死，而 GT5U 版本来自 `gradle.properties`。已核实 GT5U 5.09.52.283 自声明 `StructureLib:1.4.28`，两者当前一致 —— 但**这个一致性目前是靠人肉维持的**，必须在 T0.2 落地时把它变成结构性保证（见 §6）。
3. **升级即双改**：以后升 GT5U 必须同时核对它声明的 StructureLib 版本并同步更新，二者一起动。

---

## 6. `dependencies.gradle` 具体改法（建议 diff，本轮**未**实际修改）

### 6.1 主方案（推荐）：追加 `compileOnly`，运行期声明**一字不动**

选择理由：T0.2 的自检标准是"运行环境（runClient）行为不变"。本方案**只增加编译期可见性**，`runtimeOnlyNonPublishable` 那两行完全不动，运行期装配路径零改动、零回归面。

```diff
--- a/mod/gtnh/dependencies.gradle
+++ b/mod/gtnh/dependencies.gradle
@@ -5,14 +5,27 @@
  * 版本与 GT5-Unofficial 的 api 依赖及 gradle.properties 中 gtnhRun.gt5Version 对齐。
  */
 dependencies {
     def gt5Ver = (project.findProperty("gtnhRun.gt5Version") ?: "5.09.52.283").toString()
+    // StructureLib 版本单点化：GT5-Unofficial 5.09.52.283 的 dependencies.gradle 声明 StructureLib 1.4.28。
+    // 升级 GT5U 时必须同步核对并更新此处（见 docs/plan/decision-deps-route.md §5.4）。
+    def structureLibVer = (project.findProperty("gtnhRun.structureLibVersion") ?: "1.4.28").toString()
 
     implementation("com.google.code.gson:gson:2.8.9")
 
+    // ===== 编译期 API（T0.2 决策：docs/plan/decision-deps-route.md）=====
+    // GT 多方块枚举（IConstructable）、StructureLib 通道探测（IStructureDefinition / IStructureElement）、
+    // GT5U 通道语义（IStructureChannels / GTStructureChannels / CasingInfo）、
+    // 运行态驱动（MTEMultiBlockBase 公开状态字段 + IMachineProgress#setActive）
+    // 均需编译期可见，否则只能全反射重写且失败静默。
+    // compileOnly：仅编译期可见，不发布到 POM；运行期装载仍由下方 runtimeOnlyNonPublishable 负责。
+    // 二者必须同坐标同版本（用同一变量展开），否则编译期/运行期错配。
+    compileOnly("com.github.GTNewHorizons:GT5-Unofficial:${gt5Ver}:dev")
+    compileOnly("com.github.GTNewHorizons:StructureLib:${structureLibVer}:dev")
+
     // GregTech 5 + NEI 等（GT5 仓库 dependencies.gradle 中 api/implementation 条目的运行时装载）
     runtimeOnlyNonPublishable("com.github.GTNewHorizons:GT5-Unofficial:${gt5Ver}:dev")
-    runtimeOnlyNonPublishable("com.github.GTNewHorizons:StructureLib:1.4.28:dev")
+    runtimeOnlyNonPublishable("com.github.GTNewHorizons:StructureLib:${structureLibVer}:dev")
     runtimeOnlyNonPublishable("net.industrial-craft:industrialcraft-2:2.2.828-experimental:dev")
     runtimeOnlyNonPublishable("com.github.GTNewHorizons:NotEnoughItems:2.8.68-GTNH:dev")
     runtimeOnlyNonPublishable("com.github.GTNewHorizons:GTNHLib:0.9.20:dev")
```

即：**新增 2 行 `compileOnly`**，**把 L14 的 `1.4.28` 字面量换成变量**，其余 38 行保持原样。

> **【调度者落地修正 · 放行执行时 adjudication】** 实际落地为 `compileOnly(...) { transitive = false }`。原因：GTNH maven 上 GT5U 的间接依赖坐标已漂移（`CodeChickenLib:1.3.0` 等 5 个 artifact 404），传递解析导致 `compileClasspath` 不可解析。非传递后编译只需本 jar；若后续引用到缺失间接类型，逐个补显式 `compileOnly` 并在本节追加记录。放行验证结果：① compileJava 通过且 GT5U/StructureLib import 探针真实参与编译（探针已删）；② 错误类名 → 响亮编译失败（否定性测试通过）；③ `gradlew build` 默认配置（含配置缓存）EXIT=0；④ 产物 jar 190 条目，无 `gregtech/`、`com/gtnewhorizon/structurelib/` 类（compileOnly 未污染产物）；⑤ runClient 冒烟推迟至 T0.3 探针执行时一并验证（运行期声明逐字节等价，装配不变是构造性结论）。
>
> **【§6.1 后续追加记录 · T0.3 探针实际引用到的间接类型（2026-10-02）】** T0.3 探针（`mod/gtnh/src/main/java/com/lightning/mod/client/multiblock/`）第一次真正把 GT5U 的公开 API 编进业务代码，暴露出 3 个必须补的间接类型 —— 它们都出现在 GT5U 公开签名/接口继承链上，`transitive = false` 后不在编译类路径：
>
> | 缺失类型 | 来源 | 出现在哪条链上 |
> |---|---|---|
> | `com.gtnewhorizon.gtnhlib.capability.CapabilityProvider` | GTNHLib | `IMetaTileEntity extends CapabilityProvider` |
> | `com.cleanroommc.modularui.api.IGuiHolder` | ModularUI2 | `IMetaTileEntity extends IGuiHolder<PosGuiData>` |
> | `appeng.api.crafting.ICraftingIconProvider` | Applied Energistics 2 | `BlockMachines` / `ItemMachines` 继承链（`ItemStack#onItemUse` 放置路径） |
>
> 追加的 3 行（同样 `transitive = false`，版本取 `gradlew dependencies --configuration runtimeClasspath` 的**实际解析结果**以保证编译期/运行期锁步）：
>
> ```groovy
> def gtnhLibVer = (project.findProperty("gtnhRun.gtnhLibVersion") ?: "0.9.62").toString()
> compileOnly("com.github.GTNewHorizons:GTNHLib:${gtnhLibVer}:dev") { transitive = false }
> compileOnly("com.github.GTNewHorizons:ModularUI2:2.3.43-1.7.10:dev") { transitive = false }
> compileOnly("com.github.GTNewHorizons:Applied-Energistics-2-Unofficial:rv3-beta-834-GTNH:dev") { transitive = false }
> ```
>
> 注意 `GTNHLib` 声明即 `0.9.20` 而运行期被冲突解析到 `0.9.62`（`runtimeOnlyNonPublishable` 里写的是 0.9.20）—— compileOnly 取 **0.9.62**，与真实运行类路径一致；这是 §5.4 锁步纪律的一次具体应用（版本来源改为"运行期解析结果"而非"声明字面量"）。
> 验证：`gradlew compileJava`/`gradlew build` 通过；探针两次 `runClient` 全量启动（79 mods）并产出结果；运行期声明未改。

配套（可选但推荐）在 `mod/gtnh/gradle.properties` L89 附近追加，使版本单点在 properties 里也可覆盖：

```properties
# StructureLib 编译/运行版本；必须与 GT5U 声明的版本一致（GT5U 5.09.52.283 -> StructureLib 1.4.28）
gtnhRun.structureLibVersion = 1.4.28
```

> 若不想动 `gradle.properties`，删掉 `findProperty` 那段的属性名、直接写 `def structureLibVer = "1.4.28"` 亦可 —— **仍然必须让两处引用同一个变量**，这才是锁步的关键。

### 6.2 备选方案：改用 `devOnlyNonPublishable`（更简洁，但改动更大）

GTNH 官方模板（`ExampleMod1.7.10/dependencies.gradle` L13–14）把 `devOnlyNonPublishable` 定义为 *"a combination of runtimeOnlyNonPublishable and compileOnly for dependencies present at both compiletime and runtime, but not published as Maven dependencies"* —— 正是本场景的语义。已用 `javap` 确认该配置**确实由本仓库所用的插件版本创建**：`gtnhgradle-2.0.19.jar` 的 `com/gtnewhorizons/gtnhgradle/modules/ModernJavaModule` 中存在 `ConfigurationContainer.create("devOnlyNonPublishable", ...)` 与 `create("runtimeOnlyNonPublishable", ...)`，并调用 `Configuration.extendsFrom`。生态内亦有现成用法（`GT5-Unofficial/dependencies.gradle` L57、L59、L106）。

改法为把 L13–14 两行**替换**为：

```groovy
    devOnlyNonPublishable("com.github.GTNewHorizons:GT5-Unofficial:${gt5Ver}:dev")
    devOnlyNonPublishable("com.github.GTNewHorizons:StructureLib:${structureLibVer}:dev")
```

**但本轮不推荐它作为首选**：它同时改动了**运行期**配置的装配方式，而主方案（6.1）把运行期完全冻结。T0.2 的价值在于"低风险地拿到编译期 API"，先用主方案验证编译与运行都正常，**再**考虑是否折叠成 `devOnlyNonPublishable` 作为纯清理。

### 6.3 落地后必须做的验证（由调度者在构建基线放行后执行）

1. `npm run build:mod:gtnh` 通过 —— 且**必须确认新增的 GT 引用真的参与了编译**（先写一行 `import gregtech.api.structure.IStructureChannels;` 之类的探针，确认编译期可见性成立，再删）。
2. `runClient` 正常启动、既有导出/渲染行为不变。
3. **否定性测试**：临时确认 `compileOnly` 未污染发布产物（jar 内无 GT 类；`usesMavenPublishing = false`，主要确认 `runtimeOnlyNonPublishable` 语义未变）。
4. 若选 6.2，重复 1–3。

---

## 7. 回退方案

### 7.1 回退触发条件

任一成立即回退到反射路线（或部分回退）：

- `compileOnly` 加入后 `build:mod:gtnh` 无法通过，且原因是编译期可见性/去混淆问题（而非我们的代码写错）；
- 构建或运行期出现 GT5U 与 StructureLib 的**版本错配**信号（`NoSuchMethodError` / `NoSuchFieldError`），且无法用 §5.4 的锁步纪律根治；
- 引入编译期依赖导致 GT 缺席环境下类加载失败，且无法用类隔离根治。

### 7.2 回退动作（机械可执行）

1. **只删 §6.1 新增的 2 行 `compileOnly`**，保留 `runtimeOnlyNonPublishable`。运行期行为与今天**逐字节相同**，无残余状态。
2. 把 §6.1 对 L14 的变量化**保留或还原皆可**（该改动与反射路线不冲突，且锁步纪律对反射路线同样有益 —— 反射代码里的硬编码类名/成员名同样依赖精确版本）。
3. 新代码按反射实现：复用既有先例 `GregTechMetaTileRegistry`（`METATILEENTITIES` 数组 + `isInstance` 判定 + 懒加载缓存 + `catch (ClassNotFoundException | LinkageError)` 模式）与 `GregTechBlockReflection`。
4. **回退后必须补齐的补偿措施**（因为反射的失败是静默的 —— 这是回退的**代价**，不是可选项）：
   - **启动期自检并大声失败**：在 T1.2 入口处断言"枚举到的多方块数 > 0"，并逐项断言第 4 节 4 个反射成员可解析；任一失败**抛异常并落盘原因**，禁止沿用 `catch (Throwable) → return false` 的静默降级模式。
   - **版本断言**：比对运行期实际 GT5U / StructureLib 版本与代码假定的版本，不匹配即告警（可经 `Loader.getModContainer(...)` 读取）。
   - 上述两条应写入 T1.2 / T1.6 的自检项，纳入 E 管线的机器断言。

### 7.3 部分回退（推荐的中间态）

- **枚举 + 结构定义 + 通道探测**：编译期（§4.1 收益最大、反射最痛）。
- **运行态驱动**：编译期（§5.3，公开 API，且是最该被编译器看住的部分）。
- **4 项无公开访问器的成员**：始终反射，与路线选择无关；务必**集中到一个类**（如 `GtStructureReflection`）并加启动期断言，避免散落在业务代码里。

> 换句话说：**"compileOnly vs 反射"是个假二分**。真实形态是"编译期为主 + 一处受控反射内核"。本决策选的就是这个形态。

---

## 8. 开放项与风险

| # | 项 | 类型 | 处置 |
|---|---|---|---|
| 1 | `compileOnly` 与 `runtimeOnlyNonPublishable` 声明同一模块是否在该插件版本下完全无副作用 | **待构建验证** | §6.3 第 1、3 项；若有副作用则改用 §6.2 的 `devOnlyNonPublishable` |
| 2 | `devOnlyNonPublishable` 的 `extendsFrom` 具体父配置（是否同时含 compileOnly 与 runtimeOnly） | 未 100% 反编译确认 | 已确认配置存在（`ConfigurationContainer.create`）+ 官方模板语义描述 + 生态现成用法；若选 6.2 则实测确认 |
| 3 | 假世界是否满足 `onPostTick` 的 `isServerSide()` 门槛 | **T0.3 专项** | 与依赖路线无关，但决定运行态轴可行性；`DummyWorld.isRemote` 默认 false，初判可行，**须实测** |
| 4 | `CasingInfo#channel` 路径能覆盖多少多方块（能否减少 `val$channel` 反射） | 待 T1.2 实测 | 已知仅 2 个 MTE 走 `IStructureProvider` 新结构系统，**预期覆盖率很低**；不要据此削减反射预算 |
| 5 | GT5U 公开**字段**（`mMaxProgresstime` 等）不享受 API 稳定性保护 | 长期风险 | 编译期路线已把其转化为构建失败；另建议 T1.3 增加语义断言（捕获两态几何差异） |
| 6 | `GTStructureChannels` 重名 `casing` ×3（`METAL_MACHINE_CASING` / `TIER_CASING` / `ALCHEMICAL_CASING`）消歧 | 移交 **T0.4 / T0.5** | 已核实：30 条枚举中 `"casing"` 出现 3 次，与计划书一致；消歧方案由 T0.4 定 |
| 7 | 编译期依赖会把 GT5U 升级变成"必须同步改代码"的事件 | 流程成本 | 接受。这是**用一次显式编译错误换掉一次静默错误**，是本次决策的核心交换 |
| 8 | 混合模型（新链路编译期 + `GtTextureResolver` 反射）的长期一致性 | 架构债 | 建议把反射集中到少数 `*Reflection` 门面类并统一加断言；不在 T0.2 范围内强制重构既有 `GtTextureResolver` |

### 8.1 移交下游的结论

- **T0.3**：运行态可达性**不受依赖路线制约**（所依赖成员均为 public）。但必须验证 `isServerSide()` 在假世界的成立方式，以及客户端侧活动**表现**（活动纹理 / TESR）如何随服务端 `setActive` 生效。
- **T0.4**：通道全集按 **30** 条推进（非 27）；重名 `casing` ×3 已确认；通道语义权威源是 **GT5U** 的 `GTStructureChannels` + `IStructureChannels`，不是 StructureLib。
- **T1.2 / T1.3**：迁移 `BlockRenderer6343` 的 `GTConstructableScan` / `StructureHacks` / `ObserverWorld` 时，**注意其 pin 的是 StructureLib 1.4.34 + GT5U 5.09.52.398**，而 Lightning 是 **1.4.28 + 5.09.52.283**。已逐项核对本决策所需的全部 API 在 Lightning 的 pinned 版本上**均存在**，但移植仍需逐处对照 pinned 版本，不得假定与参考实现完全一致。

---

## 附：本决策的证据清单（可复核）

| 结论 | 证据 |
|---|---|
| `IStructureChannels` 在 GT5U 而非 StructureLib | `GT5-Unofficial/src/main/java/gregtech/api/structure/IStructureChannels.java`；pinned jar 内 `gregtech/api/structure/IStructureChannels.class` |
| pinned GT5U 具备全部所需 API | `javap` on `GT5-Unofficial-5.09.52.283-dev.jar`：`api/structure/*`（8 类）、`GTStructureChannels`、`INEIPreviewModifier`、`GTStructureUtility#ofCoil/activeCoils` 均存在 |
| 状态机字段为 public | `javap -p` on pinned `MTEMultiBlockBase`：`public boolean mMachine` / `public int mMaxProgresstime` / `mRuntime` / `mUpdate` / `mStartUpCheck` … |
| `setActive` 是公开 API | `gregtech/api/interfaces/tileentity/IMachineProgress.java` L62 |
| 活动态为派生量 | `MTEMultiBlockBase.java` L632 `setActive(mMaxProgresstime > 0)` |
| 运行态机仅在服务端 | `MTEMultiBlockBase.java` L598 / L644 |
| `HatchElementBuilder#mHint` 为 private | `HatchElementBuilder.java` L54；`javap -p` on pinned jar → `private int mHint;` |
| `LazyStructureElement` 包私有 + `get` private | `javap -p` on `StructureLib-1.4.28-dev.jar` → `class ...LazyStructureElement<T>` + `private ... get(T)` |
| `withChannel` 返回无 getter 的匿名类 | `StructureUtility.java` L2821–2822；参考实现反射 `val$channel`（`StructureHacks.java` L50–51、L60、L144–154） |
| 编译期依赖不消除反射 | `BlockRenderer6343/dependencies.gradle` L4–6（api+implementation）**而** `StructureHacks.java` L56–62、`GTGuiMultiblockHandler.java` L82–87 仍反射 |
| GT5U 5.09.52.283 自声明 StructureLib 1.4.28 | `git show 5.09.52.283:dependencies.gradle` → `api("com.github.GTNewHorizons:StructureLib:1.4.28:dev")` |
| `devOnlyNonPublishable` 存在 | `javap -c` on `gtnhgradle-2.0.19.jar` → `ModernJavaModule` 中 `ConfigurationContainer.create("devOnlyNonPublishable", …)` + `Configuration.extendsFrom`；模板注释 `ExampleMod1.7.10/dependencies.gradle` L13–14；生态用法 `GT5-Unofficial/dependencies.gradle` L57/59/106 |
| 反射失败静默 | `GregTechMetaTileRegistry.java` L57–59、L118–120、L138–140、L191–193；`GregTechBlockReflection.java` L17–19 |
| `GTStructureChannels` 为 30 条、`casing` ×3 | `GTStructureChannels.java` L22–54 |
