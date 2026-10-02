# T1.4 因子化编码实现 — 报告（需求 C 本体）

> **任务**：`multiblock-channel-renderer-plan.md` T1.4「因子化编码实现」——把 T1.3 的变体几何数据集编码为 T0.5 定稿的
> [多方块为主文档格式](format-multiblock-doc.md)，并证明"组合不展开"。
> **上位依据**：[format-multiblock-doc.md](format-multiblock-doc.md)（**契约全文，唯一格式真源**）、
> [multiblock-channel-renderer-plan.md](multiblock-channel-renderer-plan.md) §T1.4/§6、
> [probe-variant-capture.md](probe-variant-capture.md)（T1.3 数据集字段设计 §9）、
> [volume-profile-baseline.md](volume-profile-baseline.md)（T0.1 剖析方法）。
> **输入数据集**：`mod/gtnh/run/client/variant_capture/run-0015/`（4 台 / **842 变体** / 全局调色板 47 条）。
> **产物**：`mod/gtnh/run/client/variant_capture/encoded/`（4 台契约文档 + 信封 + 10 份对照组 + 2 份验证报告）。
> **状态**：完成。闭环 **842/842 逐格 diff = 0**、T0.5 校验器 **14/14 全绿**、web 侧真实解析器/装配器
> **14 份 / 1598 变体 / 0 diff**、`gradlew build` 通过。

---

## 0. 结论（TL;DR）

| 项 | 数字 / 结论 |
|----|-------------|
| 编码器落点 | **Java 侧**：`client/multiblock/MultiblockFactorizer`（核心，零 MC 依赖）+ `MultiblockFactorizeTool`（离线驱动/诊断）。理由与 T1.5 复用面见 §1 |
| 4 台产物 | 变体 **842**；骨架阶 1 / 10 / 1 / 1；规则 **3 / 21 / 5 / 60** 条（合计 89 条服务 842 变体） |
| 规则类型分布 | `indexAliases`（调色板重编号）4 条、`indexTable`（通道查表）59 条、常量 `setCell`（运行态叠加）26 条 |
| 文件体积 | 信封合计 **331,441 B**（gzip payload 247,052 B）；逐变体完整网格若展开需 **441,327,387 B**（①口径）→ **κ = 1332.76×** |
| 闭环验证 | **842/842 变体装配成功且逐格 diff = 0**（`scripts/multiblock-encode/verify-encoded.mjs`，参考装配器 = `scripts/multiblock-fixtures/lib.mjs`） |
| 契约校验 | `validate-multiblock-fixtures.mjs` 对 14 份产物：**失败 0 / 警告 2**（两台无替换型通道 → 跳过"非法取值夹取"探针） |
| web 侧交叉 | web 真实 `MultiblockParser.detect` + `parseMultiblockDeclaration` + `RuntimeDocument.fromV2Plain` + **T2.2 装配器**：14 份 / 1598 变体 / **0 diff** |
| 边际成本（gzip） | **10–30 B/组合**（帧描述 + 规则）；新增**通道取值**的成本由该取值引入的新方块状态几何主导（≈2.3 KB/取值） |
| 对照组 | 「取值数 +1」文件 +2,516/+3,500/+2,672 B（其中帧+声明仅 +54/+60/+40 B）；「通道数 +1（组合数不变）」+56 B；「通道数 +1（10→50 组合）」+7,804 B，对称方向 +8,024 B（残差 220 B ≈ 2.8%） |
| `gradlew build` | **通过**（含 `spotlessJavaCheck`） |

---

## 1. 拍板：编码器落在 Java 侧（离线 Node 只做闭环验证）

**决策**：因子化编码逻辑放 **mod 侧 Java**（`mod/gtnh/src/main/java/com/lightning/mod/client/multiblock/` 新增两个类），
Node 侧只写**验证器**（`scripts/multiblock-encode/*.mjs`），不写第二套编码器。

| 类 | 职责 | 与 T1.5 的关系 |
|----|------|----------------|
| `MultiblockFactorizer` | 核心：尺寸阶推导 + 逐位置依赖分类 + 规则合成 + 矩形分解 + 调色板剪枝/重编号 + frames/inner body 组装。**零 MC 依赖**（只用 Gson + JDK），输入 `MachineIn`（内存变体集合 + 并集调色板），输出 `Result{innerBody, stats}` | **T1.5 直接调用**：`MultiblockFactorizer.factorize(machineIn)` → `inner.get(...)` → 塞进 `SceneEnvelopeBuilder.toEnvelope` 的 rawFinal。T1.3 的 `VariantCaptureRunner` 手上就有 `int[][][]` 网格 + `GeometryPalette` 的并集调色板，构造 `MachineIn` 是纯搬运 |
| `MultiblockFactorizeTool` | 离线驱动：读 `machines/*.json` + `palette.json` → 产物 + 统计 + 对照组；`main()` 可直接用 `java -cp` 跑（**不启动游戏**） | T1.5 的 `/sde multiblock` **不调用它**（T1.5 走内存路径）；它同时是"相同输入 → 相同产物"的确定性复算器，供 T3.2/T3.3 用 |

**理由（按权重）**：

1. **判断标准是"T1.5 能否直接复用"，答案是能**：`/sde multiblock` 必须是游戏内一次运行的产物，编码逻辑若只在 Node，
   T1.5 就得**重写一遍**（并把"格式真源"劈成两份）。Java 侧写一次，T1.5 与离线工具共用同一个 `factorize`。
2. **零 MC 依赖让"必须开游戏"不成立**：`MultiblockFactorizer` 只用 Gson + JDK，因此
   `java -cp build/classes/java/main;<gson> MultiblockFactorizeTool <dataset> <out>` 就能跑（实测：842 变体 + 10 份对照组 **2.0 s**），
   迭代成本从"每次 2–3 分钟 runClient"降到秒级。这是"Java 侧也能快速闭环"的关键。
3. **信封复用不重做**：产物信封由既有 `SceneEnvelopeBuilder` 产出（§8 只加 2 处 `copyIfPresent`），
   Java 侧调用顺理成章；Node 侧若自己拼 gzip+base64 就变成"第二套信封实现"。
4. **代价可控**：离线验证仍是 Node（`lib.mjs` 参考装配器 + T0.5 校验器 + web 真实解析器），
   即"编码用 Java、验收用独立实现"，两侧语言不同反而**避免了同源同错**。

**没有做的事情（避免双真源）**：没有在 Node 侧重新实现编码算法；`scripts/multiblock-encode/` 下只有
`factorize.ps1`（启动器）、`verify-encoded.mjs`（闭环）、`verify-web-parser.mjs`（web 侧交叉）、`inspect-dependencies.mjs`（诊断）。

---

## 2. 编码算法（契约 §4/§5/§6 的落地）

装配顺序硬约束「尺寸型 → 骨干 → 替换型 → 运行态」在编码侧对应如下四步：

### 2.1 取值解析与骨架阶（契约 §5.2 / §4.4）

1. 逐变体按契约 §5.2 解析有效值：`value = (raw > 0) ? raw : 总Tier`，再按 `[size?min:0, domain.max]` 夹取；
   总 Tier 先按 `totalTierDomain` 夹取。
   **交叉校验**：与 T1.3 记录的 `variants[].effective` 逐变体比对 —— 替换型通道**完全一致**（EBF/QFT 全部命中）；
   尺寸型通道有 **44/220** 个变体不一致，原因见 §8 开放项 1（T1.3 的该字段对尺寸型记的是"按下界夹取后的值"，
   既无 1 基偏移也不是通道取值；**真实尺寸由网格本身给出**，本编码器以网格为准）。
2. 尺寸型通道按有效值定阶：`stepIndex = 有效值 − 1`，阶数 = 域长度（DT：10 阶 ↔ 3×3×3 … 3×12×3）。
   断言：同一阶内尺寸唯一、不同阶尺寸互异、每个阶都有变体、**阶数必须等于域长度**（否则抛错，不静默降级）。
   无尺寸型通道的机器（EBF/QFT/BBF）：单阶，`sizeChannel` 用契约 §4.4 的哨兵值 `"totalTier"`（与 T0.5 的 tier-only fixture 同口径）。

### 2.2 逐位置依赖分类（"骨干 + 按通道分解的差异规则"的推导）

对每个格位置，把它在**同阶全部变体**上的取值建成立方表，然后枚举候选键
（`∅`、单条替换型通道、{总Tier}、{运行态}、以及它们的组合），选**精确键**：

* 判据 = "同一键元组上取值唯一"（不精确则弃用该键）；
* 择优顺序 = **帧分区最少 → 帧轴最少 → 键最小**（确定性）；
* 键为 `∅` → 该格所有变体同值 → **进骨架**（`backbone.sizeSteps[].cellGrid`）；
* 键含通道 → 值为 `eff[通道] → 下标` 的**查表**（`indexTable`）；
* 键含运行态 → 规则相位 `runstate`；
* 键含总 Tier → 按帧引用不同规则（`tier.overlay`），**不做算术**（契约 §4.5.1）。

分类结果（实测）：

| 机器 | 格数 | 常量格 | 变化格 | 位置组 | 规则矩形 |
|------|-----:|-------:|-------:|-------:|---------:|
| EBF | 36 | 19 | 17 | 2 | 3 |
| DT（每阶） | 27…108 | 26…107 | 1 | 1 | 1 |
| QFT | 4725 | 4346 | 379 | 3 | 58 |
| BBF | 36 | 35 | 1 | 1 | 1 |

即：**骨架里只有"所有变体都不变"的格子**；替换型/运行态位置在骨架里写 `0`（空），由规则写入。
EBF 的 17 个变化格 = 16 个线圈格（只随 `coil`） + 1 个控制器格（只随运行态）；QFT 的 379 个 = shielding 142 + manipulator 236 + 控制器 1
（与 T1.3 §8.3 的 A1 差异位置数完全吻合：142 / 236）。

### 2.3 规则合成与矩形分解（契约 §4.5 / §4.5.1）

* **同键同查表的位置集合**合成一组规则：同一张 `indexTable` 服务该组所有位置，因此"系统性替换"是**一条规则**而不是逐格数据。
* 位置集合用 `fill` 的 `sel` 语义（逐层笛卡尔积）精确划分：按 y 分层 → 层内把 z 列按"x 集合"归并 → 跨层合并相同 `(X, Z)`。
  该划分**恒为精确覆盖且互不重叠**，规则数 = 划分块数（EBF 16 格 → 2 个矩形；QFT 379 格 → 58 个矩形）。
* 单格矩形写 `setCell`，多格写 `fill`；轴线取满时省略该键（省字节）；单元素轴写成数字。
* **`indexAliases`（旧下标 → 新下标）**用于**调色板重编号**：骨架保持数据集（全局）下标，每条 frame 引用一条
  `palette.renumber` 规则（`phase:"backbone"`，故最先执行）把整表换成剪枝后的下标；规则写入的内容直接是**最终下标**。
  *锚点格*选"所有阶都是 const-air 的格子"（写 0 = 无操作；若不存在则退化为"所有阶都非常量的格子"，再退化为 `x=-1` 越界跳过）。
  实测锚点：EBF `(1,1,1)`、DT `(1,1,1)`、QFT `(0,0,0)`、BBF `(1,0,1)`。

### 2.4 变体与帧（契约 §5.1 / §5.3）

* 输入多少变体就声明多少变体（**不抽样、不裁剪**）；变体键按契约 §5.1 从 `channels` 顺序重新派生
  （与 T1.3 的键逐字节一致，实测无重复、无缺失）。
* 每变体恰好一帧：`{index, variant, runstate, stepIndex, rules:[…]}`；**无 `ops`、无 `cellGrid`**。
  帧的引用列表 = `palette.renumber` + 本阶内"激活键匹配 (tt, runstate)"的全部内容规则（确定性顺序）。

### 2.5 调色板剪枝（契约 §6.1 第 4 条）

每份文档只保留**本机变体真正引用到的条目**（`air` 恒 0），其余丢弃并按顺序重编号：

| 机器 | 全局条目 | 本机条目 | 丢弃 |
|------|--------:|--------:|-----:|
| EBF | 47 | 22 | 25 |
| DT | 47 | 10 | 37 |
| QFT | 47 | 14 | 33 |
| BBF | 47 | 4 | 43 |

`materialPalette` / `textureBlobs` / `tooltipPalette` **原样保留**（既有结构，见 §8 开放项 2）。

---

## 3. 4 台产物编码统计

> 数据源：`encoded/factorization-report.json`（工具自报） + `encoded/verification-report.json`（闭环验证器）。

| 机器 | 变体 N | 骨架阶 | 规则合计 | 规则类型分布 | 调色板 | 内层未压缩 | gzip payload | **信封落盘** |
|------|-------:|-------:|---------:|--------------|-------:|-----------:|-------------:|-------------:|
| `MTEBrickedBlastFurnace` | 2 | 1 | **3** | 1 alias + 2 运行态 setCell | 4 | 89,244 | 46,302 | **62,244** |
| `MTEDistillationTower` | 220 | 10 | **21** | 1 alias + 20 运行态 setCell（每阶 2 条） | 10 | 164,707 | 52,006 | **69,847** |
| `MTEElectricBlastFurnace` | 420 | 1 | **5** | 1 alias + 2 通道 indexTable(fill) + 2 运行态 setCell | 22 | 276,215 | 81,183 | **108,754** |
| `MTEQuantumForceTransformer` | 200 | 1 | **60** | 1 alias + 57 通道 indexTable(fill) + 2 运行态 setCell | 14 | 372,675 | 67,561 | **90,596** |
| **合计** | **842** | — | **89** | alias 4 / indexTable 59 / 常量 setCell 26 | — | 902,841 | **247,052** | **331,441** |

**"规则数不随组合数增长"的直接读数**：

* EBF：`coil` 的 14 个取值只靠 **2 条** `indexTable` 规则（两个矩形）表达，`indexTable` 表长 15（档 0 = 未设置分支，
  由最近观测档补齐 = 与档 1 同内容，契约 §6.2）；420 个变体 → **帧只存 3 个规则 id 的引用**。
  未压缩下 `multiblock.rules` 子树 < **500 B**（剖析：`rules[].id` 78 + `legend` 88 + `indexTable[]` 54 + `phase` 48 + `kind` 39 + 其余 ≈ 100）。
* DT：10 阶 × 2 运行态 = 20 条 `setCell`（每阶一条 idle/active），第 k 阶（k=0…9）控制器在 `(1, k+2, 0)`（即该阶末行）；220 变体共享这 20 条。
* QFT：两条通道共 57 条矩形规则（`shielding` 23 + `manipulator` 34），200 变体共享。
* BBF：仅控制器 1 格两态 → 2 条 `setCell`。

**展开体积与 κ**（三种口径，全部来自实测）：

| 机器 | 文件 B | V（§9.2：调色板×1 + Σ 完整网格） | **κ=V/G** | 校验器①口径展开 B | **κ①（T0.5 口径）** |
|------|-------:|---------------------------------:|----------:|------------------:|--------------------:|
| BBF | 62,244 | 15,118 | 0.24 | 89,450 | 1.44× |
| DT | 69,847 | 89,256 | 1.28 | 9,174,367 | 131.49× |
| EBF | 108,754 | 144,833 | 1.33 | 20,815,595 | 191.53× |
| QFT | 90,596 | 2,274,759 | **25.11** | 411,247,975 | **4543.17×** |
| **合计** | **331,441** | 2,523,966 | — | **441,327,387** | **1332.76×** |

**为什么 κ 与 κ① 差这么多**（必须说清，否则数字会被误读）：

* κ① 是 T0.5 校验器的口径：`内层 − Σ网格 + Σ网格×N`，即"把每份文档里的那一份调色板/材质池保留一次、
  再把 N 份完整网格全部写下来"。它回答的是"**如果按组合展开写文件会多大**" → 441 MB vs 331 KB。
* κ（§9.2 字面口径）只把"调色板 + Σ网格"算作展开体积，**不含材质池**。真实产物里材质池是**每文件一份的常数**
  （`materialPalette` 56 条 + `textureBlobs` 51 个 = **70,923 B 未压缩 / ≈45 KB gzip**），对 BBF 这种 2 变体、36 格的机器，
  它直接压过网格体积 → κ<1。
* 这正是契约 §9.3 预留的"常数主导"分支：**κ 的绝对值取决于"每变体网格字节 / 常数池字节"的比值**，
  小机器上 κ 必然 <1，而它**不代表展开**。可机器判定的"没展开"证据在 §4（逐格 diff=0）与 §6（边际成本）。

---

## 4. 闭环验证（核心验收线）：842 变体逐格 diff = 0

**方法**（`scripts/multiblock-encode/verify-encoded.mjs`，退出码 0/1）：

```
产物 <name>.multiblock.json（生产形态 base64(gzip(json)) 信封）
  → lib.mjs readFixtureDocument（解 base64 → 先当 JSON 文本 → 失败再 gunzip）
  → lib.mjs assembleVariant(doc, variantKey)   ← T2.2 的对照蓝本，独立实现
  → 与 T1.3 数据集 machines/<slug>.json#variants[].grid.cellGrid 逐格比较
```

**一处必须显式说明的口径（否则 diff 会"假红"）**：数据集网格用的是**全局并集调色板下标**，
而产物用的是**本机剪枝后下标**（契约 §6.1 第 4 条要求"不得有从未被引用的条目"，故必须剪枝）。
因此逐格 diff 在**内容层**做：把全局下标经 `entrySignature`（条目内容签名，`lib.mjs` 同口径）映射到产物下标空间再比较。
这一步**同时**证明了"剪枝/重编号没有改变任何方块状态的内容"（映射缺项即硬失败）。
另外 `ctl-renumber-direct-ebf`（编码期直接换下标、不生成 alias 规则）也逐格 diff=0 → 两条重编号路径等价。

**结果**：

| 文档 | 变体 | 声明集合 = 笛卡尔积？ | frame 覆盖 | **逐格 diff** | ground-truth 来源 |
|------|-----:|----------------------|-----------|--------------:|-------------------|
| `mteelectricblastfurnace` | 420 | ✔（15×14×2） | 420/420 | **0** | 数据集（独立读取） |
| `mtedistillationtower` | 220 | ✔（11×10×2） | 220/220 | **0** | 数据集 |
| `mtequantumforcetransformer` | 200 | ✔（5×5×4×2） | 200/200 | **0** | 数据集 |
| `mtebrickedblastfurnace` | 2 | ✔（1×1×2） | 2/2 | **0** | 数据集 |
| **4 台合计** | **842** | ✔ | ✔ | **0** | — |
| 10 份对照组 | 756 | ✔（各自的域/抽样） | ✔ | **0** | 工具落盘的输入子集 + 与数据集本体逐格交叉核对（缺项/不一致即硬失败） |

其他机器判据（同一次运行，全部通过）：

* 文件内**无组合展开**：`frames[].ops` / `frames[].cellGrid` 出现即硬失败（实测：0 出现）；
* 声明集合 ≠ 笛卡尔组合集 → 硬失败（实测：无缺、无多）；
* 调色板：`air` 恒 0、无未被引用的条目（实测：14 份文档 0 条未引用，含 air）；
* `indexTable` 长度 = 域长度 + 1、下标不越界；`indexAliases` 目标下标不越界。

### 4.1 T0.5 校验器（格式 + 全组合装配 + 判定式）

```
node scripts/multiblock-fixtures/validate-multiblock-fixtures.mjs \
     mod/gtnh/run/client/variant_capture/encoded/*.multiblock.json \
     mod/gtnh/run/client/variant_capture/encoded/control/*.multiblock.json
→ ✅ 全绿（失败 0 / 警告 2）
```

* 14 份产物**全部通过**（`shape/*`、`channels/*`、`backbone/*`、`palette/*`、`variants/complete`、`assembly/all-variants`、
  `frames/*`、`rules/*`、`illegal/*`）。
* 2 条警告均为 `illegal/no-channel`：BBF（无通道）与 DT（只有尺寸型通道）没有替换型通道，"域外取值夹取"探针跳过 ——
  **不是产物缺陷**（EBF/QFT 两份都跑通了 `illegal/not-set-fallback` 与 `illegal/out-of-domain-clamp`）。
* 校验器的全量输出留档：`scripts/multiblock-fixtures/.out/validation-report.t14-encoded.json`
  （`validation-report.json` 已恢复为 T0.5 的三份 fixture 结果，仍为 40.50× 全绿）。

### 4.2 web 侧真实实现交叉验证（T2.1 / T2.3 / T2.2）

`scripts/multiblock-encode/verify-web-parser.mjs` 用 esbuild（web/node_modules 自带）把 web 侧**真实模块**按 `@` 别名
捆绑成临时 ESM 后调用 —— **不修改 `web/` 下任何文件**：

```
node scripts/multiblock-encode/verify-web-parser.mjs <encodedDir> <datasetDir>
→ web 侧解析/装配合计：文档 14 份、变体 1598 个、逐格 diff 0
```

断言明细（全部通过）：

| 断言 | web 侧真实入口 | 结果 |
|------|----------------|------|
| 形态判别（先于 V2Plain） | `MultiblockParser.detect(envelope)` | 14/14 true |
| 形态枚举量读取（信封 `meta`） | `readDocumentShape` / `isEnvelopeDocument` | 14/14 `"multiblock"` / true |
| 既有信封解包（base64→gzip→JSON + meta 合并） | `readEnvelopeLayers` | 14/14 成功，内层含 `multiblock`/`multiblockCount`，**无根级 cellGrid** |
| 声明解析 + 内部校验 | `parseMultiblockDeclaration(inner)` | 14/14 无异常、0 条解析警告 |
| RuntimeDocument 承载（T2.3） | `RuntimeDocument.fromV2Plain(plain, {multiblockSource})` | 14/14 承载，变体数与声明一致 |
| **T2.2 装配器逐格** | `assembleVariant(inner, key)` | **1598/1598 diff = 0** |

> 意义：T3.3 的"web 装配 = mod 导出"在**真实 web 代码路径**上已经提前跑通（1598 个变体，含全部 842 个真实组合）。
> 参考网格落盘目录 `scripts/multiblock-fixtures/.out/expanded-fixtures/` 未参与本次验证（T3.3 的正式对照物是 T1.6 的展开校验文件）。

---

## 5. 编码前后体积剖析（T0.1 工具，任务要求的"验证前置"）

```
node scripts/volume-profile/volume-profile.mjs analyse mod/gtnh/run/client/variant_capture/run-0015 \
     --verify false --md scripts/volume-profile/out/t14-before.md --json scripts/volume-profile/out/t14-before.json
node scripts/volume-profile/volume-profile.mjs analyse scripts/multiblock-encode/.out/profile-after \
     --verify false --md scripts/volume-profile/out/t14-after.md  --json scripts/volume-profile/out/t14-after.json
```

（"after" 输入目录只放 4 份**产物信封**，不含对照组与 ground-truth 副本，避免剖析被对照数据污染；
两份 md/json 均落在 `scripts/volume-profile/out/`，可重复运行、逐字节稳定。）

### 5.1 before：T1.3 数据集（= 逐变体展开形态）

| 文件 | 落盘 | 未压缩 | gzip | `other:$.variants[].grid.cellGrid[][][]` |
|------|-----:|-------:|-----:|-----------------------------------------:|
| `mtequantumforcetransformer.json` | 18,588,583 | 2,557,490 | 61,466 | **1,131,600** |
| `mteelectricblastfurnace.json` | 1,461,649 | 744,630 | 45,467 | 20,880 |
| `mtedistillationtower.json` | 983,036 | 436,317 | 29,332 | 28,710 |
| `mtebrickedblastfurnace.json` | 10,243 | 6,573 | 2,787 | 138 |
| `palette.json` | 541,796 | 294,913 | 102,872 | — |
| `report.json` | 29,082 | 21,989 | 5,884 | — |
| `manifest.json` | 593 | 512 | 324 | — |
| **合计（7 份）** | **21,614,982** | **4,062,424** | **248,132** | — |

> 说明：T1.3 的数据集是**捕获证据包**（每个变体带完整网格 + 布局/几何签名 + 构建/断言元数据），
> 不是待发布的产物格式；这里只作"编码前"的字节分布基线。它的 `variants[].grid.cellGrid` 桶合计 ≈ 118 万字节，
> 且 **`cellGrid` 在数据集里是逐变体各存一份**。

### 5.2 after：4 份契约产物（内层 payload 分桶）

> 单位：字节（未压缩 JSON 的叶子 + 键名口径，分隔符单列）。同一份池（texture.blobs 59,637 + material.entries 4,487）
> 在每份产物里各存一份 → **每文件常数 ≈ 70,923 B**。

| 机器 | 内层未压缩 | texture.blobs | palette.meta | palette.geometry | frames.meta | material | other | **骨架 cellGrid** | 逐变体网格 |
|------|-----------:|--------------:|-------------:|-----------------:|------------:|---------:|------:|------------------:|-----------:|
| BBF | 76,9xx | 59,637 (66.3%) | 8,364 (9.3%) | 2,370 (2.6%) | 132 (0.2%) | 4,487 (5.0%) | 1,905 (2.1%) | **68** | **0** |
| DT | 164,707 | 59,637 (35.6%) | 10,849 (6.5%) | 8,731 (5.2%) | 16,872 (10.1%) | 4,487 (2.7%) | 13,349 (8.0%) | **1,295**（10 阶） | **0** |
| EBF | 281,607 | 59,637 (21.2%) | 50,405 (17.9%) | 16,798 (6.0%) | 41,760 (14.8%) | 4,487 (1.6%) | 18,206 (6.5%) | **36** | **0** |
| QFT | 376,678 | 59,637 (15.8%) | 28,234 (7.5%) | 13,616 (3.6%) | **162,890 (43.2%)** | 4,487 (1.2%) | 22,843 (6.1%) | **5,279** | **0** |

EBF 的 `other` 明细（最能说明"文件里是什么占的"）：

| 明细桶 | 字节 | 占未压缩 |
|--------|-----:|---------:|
| `other:$.multiblock.variants[].key` | 12,050 | 4.28% |
| `other:$.multiblock.variants[].runstate` | 2,940 | 1.04% |
| `other:$.multiblock.variants[].totalTier` | 570 | 0.20% |
| `other:$.multiblock.variants[].values.coil` | 560 | 0.20% |
| `other:$.multiblock.rules[].*`（**全部规则**：id 78 + legend 88 + indexTable 54 + phase 48 + kind 39 + 坐标/下标 ≈ 100） | **≈ 460** | 0.16% |
| `other:$.multiblock.backbone.sizeSteps[].cellGrid[][][]` | **36** | 0.01% |

**结论**：编码后字节分布落在**纹理 blob + 调色板条目（几何/缩略图）+ 帧与变体声明**上；
`cellGrid` 只剩"骨架那一份"（EBF 36 格 / DT 10 阶合计 1,295 B / QFT 15×21×15 = 4,725 格 **5,279 B**，
其中 4,346 格是真值、379 格是 `0` 占位），**逐变体完整网格在产物里不存在**。

**一个必须点出的分布事实**：QFT 的 `frames.meta` 一项占内层 **43.2%** —— 因为每帧要按契约 §5.3 携带
**有序规则 id 引用列表**（该机每帧 **59** 条引用，200 帧 ≈ 11,800 条引用）。这是"规则按引用复用"的固有代价，
仍然远优于逐变体网格（945,000 格），但它是当前产物里最大的**可压缩**项（见 §8 开放项 8）。

### 5.3 与 T0.5 契约 §9.1 的三条设计结论对照

| 契约结论 | 本次实测 |
|----------|----------|
| 规则表按引用复用（frame 只存 id） | ✔ 89 条规则服务 842 变体；EBF 的规则子树 < 500 B |
| 并集调色板 + 内容签名去重 | ✔ 每机再按"本机引用集"剪枝：47 → 4/10/14/22 条；0 条未引用 |
| 网格字段不是体积杠杆 | ✔ 产物里只有骨架网格；移动 cellGrid 到帧内会让文件爆炸（T0.5 §9.6 已量化） |

---

## 6. 对照组体积数据（计划 T1.4 自检；为 T3.2 备料）

10 份对照组全部由**同一数据集子集重编码**生成（`encoded/control/`），并逐格 diff=0（§4）。
每份都落 `*.groundtruth.json`（工具编码时吃进去的输入网格），验证器再与数据集本体逐格交叉核对。

### 6.1 「取值数 +1」（EBF，`tierSample` 固定 `[1,2]` 隔离取值轴）

| 配置 | coil 取值数 | N | 文件 B | Δ文件 | Δgzip(palette) | Δgzip(frames+声明) | **B/组合（gzip）** |
|------|-----------:|---:|-------:|------:|---------------:|-------------------:|-------------------:|
| `ctl-values-12values` | 12 | 48 | 94,674 | — | — | — | — |
| `ctl-values-13values` | 13 | 52 | 97,190 | **+2,516** | +2,264 | **+54** | **13.5** |
| `ctl-values-14values` | 14 | 56 | 100,690 | **+3,500** | +2,297 | **+60** | **15.0** |
| `ctl-values-15values` | 15 | 60 | 103,362 | **+2,672** | +1,826 | **+40** | **10.0** |

* 线性拟合：**文件 B ≈ 59,068 + 739.1·N，R² = 0.9961**（4 点）。
* 每条新增取值的文件增量 **2,516 / 3,500 / 2,672 B**，其中**新方块状态的几何+缩略图占 1,826–2,297 B（gzip）**，
  **帧描述 + 通道声明只占 40–60 B（≈10–15 B/组合）** —— 与契约 §10.4 的 fixture 边际（14–18 B/组合）同量级。
* 换言之："+1 取值"贵在**多了一个方块状态**，不贵在"多了 4 个组合"。

### 6.2 「通道数 +1」（QFT，`tierSample=[1]`）

| 配置 | 通道 | N | 文件 B | gzip(palette) | gzip(frames+声明) | 规则数 |
|------|------|---:|-------:|--------------:|------------------:|-------:|
| `ctl-chan-1-shielding` | shielding | 10 | 78,672 | 15,144 | 2,786 | 26 |
| `ctl-chan-1-manipulator` | manipulator | 10 | 78,452 | 14,725 | 2,918 | 37 |
| `ctl-chan-2-degenerate` | shielding + manipulator(max=0) | 10 | 78,728 | 15,144 | 2,857 | 26 |
| `ctl-chan-2-both` | shielding + manipulator | 50 | 86,476 | 19,656 | 3,958 | 60 |

* **组合数不变（N=10）加一条通道：Δ文件 +56 B，Δgzip +71 B** —— 通道轴本身的声明/键串成本是**常数级**的。
* **N 10→50**：Δ文件 +7,804 B = 3 条新方块状态（gzip +4,512） + 40 条新组合的帧与规则（gzip **+1,172 → 29 B/组合**）。
* **可加性检验**：`both − shield = 7,804 B`，`both − manipulator = 8,024 B` → 两个方向差 **220 B（2.8%）**，
  即体积在通道上**近似可加**（无相乘项）。
* 同一台机器上"通道 +1"的成本（3 条状态 + 29 B/组合）与"取值 +1"的成本（1 条状态 + 13.5 B/组合）**同一量级**，
  且都与"每组合一份完整网格"（2,560 B/组合，见 §3 校验器的 `perVariantGridCost`）相差 **2 个数量级**。

### 6.3 附加对照

| 配置 | 用途 | 结果 |
|------|------|------|
| `ctl-tier-overlay-shielding` | 未声明通道的回落随总 Tier 变 → 必须走"按帧引用不同规则"的等级叠加层 | N=40，规则 162 条（159 条矩形容量 + 23 张 `indexTable` + 2 条运行态），**逐格 diff=0** |
| `ctl-renumber-direct-ebf` | 调色板重编号的两种实现对照 | `indexAliases` 规则版：5 条规则 / 108,754 B；编码期直接换下标版：4 条规则 / 108,494 B → **`indexAliases` 代价 +260 B（+0.24%）**，换来契约 §4.5.2 明文要求的"旧下标 → 新下标批量替换"能力且两条路径都 diff=0 |

---

## 7. 硬约束逐条核对

### 7.1 计划 T1.4 硬约束

| # | 硬约束 | 落实位置 | 机器判据 | 结论 |
|---|--------|----------|----------|------|
| 1 | **组合不展开**：骨干布局 + 按通道分解的差异规则；文件内不得出现逐变体完整网格 | `MultiblockFactorizer.classifyStep/buildBackbone`；帧只存规则 id | 闭环验证器：`frames[].ops` / `frames[].cellGrid` 出现即硬失败（0 出现）；剖析：`cellGrid` 桶只剩骨架（36 B / 1,575 格）；κ① = 1332.76× | ✅ |
| 2 | **系统性替换表达为规则**（"旧下标 → 新下标"批量规则 `indexAliases` / `indexTable` 查表），不是逐格数据 | 通道 → `indexTable`（59 条）；剪枝重编号 → `indexAliases`（4 条） | 闭环 diff=0；`ctl-renumber-direct-ebf` 对照证明两条路径等价；EBF 14 个取值只用 2 条矩形规则 | ✅ |
| 3 | **尺寸型先定骨干，替换型叠加，运行态作为叠加层** | 阶由有效值定；骨架只含常量格；`phase` = `backbone`/`replace`/`runstate`；装配排序由 lib.mjs/web 按相位执行 | DT 10 阶（3×3×3…3×12×3）、20 条运行态规则；QFT/EBF 的运行态差异恰为控制器 1 格 | ✅ |
| 4 | 建议叠加跨变体差分（N+1 是 N 外扩时），但**忠实度优先** | 未做"跨阶差分复用"优化：每阶独立骨架、每阶独立运行态规则（DT 20 条而非 2 条） | 逐格 diff=0；规则数仍与组合数无关 | ✅（选择忠实度） |
| 5 | **不得靠丢弃变体换体积** | 输入变体 1:1 映射为声明 + 帧 | 4 台 842/842；声明集合 = 笛卡尔积（校验器 `variants/complete`）；对照组同为子集全量 | ✅ |

### 7.2 契约 §13.1（交 T1.4）9 条

| # | 要求 | 落实 |
|---|------|------|
| 1 | 产出 `multiblock`（含 channels/runstates/totalTierDomain/tierSample/backbone/rules/variants/couplings/notes/viewerSemantics/opsLegend）+ 根级并集 `blockPalette` + `frames` | ✔ 14/14 份；`couplings:[]`+`couplingMode:"none"`（契约 §7.3 缺省行为写进 `notes`）；`opsLegend` 登记 4 条 legend |
| 2 | 规则表按引用；禁止 `frames[].ops` / 生产 `frames[].cellGrid` | ✔ 帧只存 `{index,variant,runstate,stepIndex,rules[]}` |
| 3 | 调色板复用签名去重机制、air 恒 0、每取值新状态只进一份 | ✔ 条目原样搬（不改内容 → 签名不变）；本机剪枝后重编号 |
| 4 | 尺寸型 `sizeSteps` 阶数 = 域长度；每阶一份只含骨架的完整 `cellGrid` | ✔ DT 10 阶；断言"阶数 = 域长度"、"不同阶尺寸互异"；骨架变化位置写 0 |
| 5 | 取值注入只走 `placeBlock`；构造前复位实例状态 | T1.3 的落点（本任务不重建构）；本编码器只消费其产物，并在 §5.2 交叉校验有效值 |
| 6 | `gt_hatch` 标 `kind:"hatch"` 不进规则表 | ✔ 代码路径显式排除 hatch 通道（本数据集 4 台无 hatch 通道） |
| 7 | 导出期断言（通道 id 唯一、每变体有帧、下标不越界、`indexTable` 长度、阶数、无未引用条目）违反即失败并落盘原因 | ✔ 全部实现为 `FactorizeException`（带位置/变体/通道的可定位信息）；实测 0 次触发 |
| 8 | 信封走既有 `SceneEnvelopeBuilder`；只加 `meta.documentShape` 与 inner `multiblock`/`multiblockCount` | ✔ `SceneEnvelopeBuilder` 加 2 处 `copyIfPresent`（1 行 meta + 2 行 inner），**既有两条分支行为不变**；`payloadEncoding` 仍为 `gzip+base64`；未做 `setLevel(9)` 显式优化（T0.1 §8 F7 记为可选） |
| 9 | 装配顺序 = 尺寸型 → 骨干 → 替换型 → 运行态 | ✔ `phase` 三档（`backbone`/`replace`/`runstate`）；尺寸型由 `stepIndex` 完成 |

### 7.3 计划 §6 把关清单「压缩」四条

| 条目 | 结论 |
|------|------|
| 文件内无组合展开 | ✅ 842 变体 → 89 条规则；产物中无逐变体网格；κ① = 1332.76× |
| 体积剖析数据证明"随相加而非相乘增长" | ✅ 边际 10–30 B/组合（gzip）；通道 +1（组合不变）+56 B；通道双向可加（残差 2.8%）；新增取值的成本 = 1 个方块状态 |
| 未靠丢弃变体/牺牲忠实度换体积 | ✅ 842/842 全量声明 + 逐格 diff=0；未做跨阶差分复用（忠实度优先） |
| gzip+base64 信封复用未重做；因子化在信封之前 | ✅ `SceneEnvelopeBuilder.toEnvelope` 原样调用；`meta.documentShape` + inner `multiblock`/`multiblockCount` 两处扩展 |

---

## 8. 开放项与风险

| # | 项 | 影响 | 建议处置 |
|---|----|------|----------|
| 1 | **T1.3 数据集的 `variants[].effective` 对尺寸型通道口径不同** | DT 有 **44/220** 个变体的 `effective` 与本编码器的解析不一致：T1.3 记的是"按尺寸下界夹取后的值"（`clamp(k, 3, 10)`），而契约 §5.2 的有效值是**通道取值**（`clamp(k, 1, 10)`，第 0 档 = 未设置分支），真实尺寸 = 取值 + 2（网格实测：`height:1→3×3×3`、`height:2→3×4×3`）。本编码器**以网格为准**，故不影响产物 | T1.5/T1.6 **不要**用数据集 `effective` 作尺寸型通道的 oracle（会把 2 个变体算错阶）；若要用，先按 `取值 = 尺寸 − (min−1)` 换算。建议 T1.3 侧回写该字段口径（或明确标注"尺寸型记尺寸、替换型记取值"） |
| 2 | **`materialPalette` / `textureBlobs` 未按机剪枝** | 每份产物都带全套池：**70,923 B 未压缩 / ≈45 KB gzip**（占 BBF 信封的 73%、EBF 的 41%）。实测每台真正引用的材质/贴图：BBF 4/56 材质、4/51 blob；DT 14/56、13/51；EBF 24/56、24/51；QFT 18/56、18/51 → **剪枝可省约 31–55 KB/文件**（BBF 最大），对 `/sde multiblock` 全量 221 台是 ~7–12 MB 的重复 | 未在 T1.4 实施，原因：① 剪枝必须**同步改写调色板条目几何里的 `materialIndex`**，而条目内容签名是跨文档去重口径（T1.3 §7.4 "materialIndex 全数据集稳定"），改表示会改变签名；② 本轮闭环只验 `cellGrid`，材质重映射需要独立判据（逐条目"材质 locator 序列不变"）。建议 T1.5 或独立任务做，并**必须**附该判据 |
| 3 | **内层 JSON 有两处非规范表示**（都继承自上游/既有机制，非本任务引入） | ① 顶点/UV 浮点写成 `0.0`/`1.0`（T1.3 的 Gson 序列化；`palette.json` 因此 294,821 B → 规范 JSON 281,813 B）；② `SceneEnvelopeBuilder` 的 `COMPACT_GSON = new Gson()` 带 HTML 转义，把 base64 里的 `=` 写成 `\u003d`（每处 +5 B）。实测 DT 内层 167,461 B → 规范序列化 164,356 B（**−1.85%**；gzip 后差异可忽略） | ① 若要改，需接受"调色板条目签名变化"（跨文档去重口径要同步迁移）；② 只需把 `COMPACT_GSON` 换成 `new GsonBuilder().disableHtmlEscaping().create()`，但**会改变既有 `/sde export` 的字节** → 不在 T1.4 写范围内，建议作为独立小任务（影响所有信封产物，且使 `verify-grids` 类的"重建一致性"断言恢复绿色） |
| 4 | **多通道"同位置相交"（作用域重叠）未实现 guard 路径** | 当前实现对"同一格的取值同时依赖 ≥2 条替换型通道"的情形**硬失败并落盘原因**（含位置与所需键），不静默降级。4 台机器的通道作用域两两不相交（EBF 16 格 / QFT shielding 142 格、manipulator 236 格、交集为空），故未触发；T0.4 记录的已知相交机是 `MTELapotronicSuperCapacitor` | T1.5 全量导出（221 台）**很可能撞上**相交机。契约 §4.5.3 的 `guard` 已由 web 解析器与 `lib.mjs` 实现（`evalGuard`），编码侧只需补"按另一通道取值分组 + `guard.clauses:[{channel, value}]`"的规则生成（预计 <100 行）。**建议 T1.5 之前单独补**并造合成相交用例做闭环（本轮未做，避免引入未验证路径） |
| 5 | **`tierSample` 抽样与"未设置回落"的边界** | 契约 §5.2 规定未设置的通道回落到**总 Tier**，再按通道域夹取；若把通道域缩小（子集重编码）而保留全域 `tierSample`，则"回落值超出域"的变体在契约语义下**不可无损编码**（ground-truth 网格是真实回落的结果）。本任务的对照组因此把 `tierSample` 固定为 `[1,2]` 以隔离取值轴 | T1.5 的配置面若允许"缩小通道域"，必须**同时限制 tierSample ≤ 新域上界**（或在 `notes` 里记录被排除的组合）；否则会出现"声明域装不下真实回落值"的产物 |
| 6 | **DT 的 `getValueClamped` 语义依赖"值→尺寸"偏移** | 契约 §4.4 用 `min=1/max=10` + 阶序编码，真实尺寸映射 `dim = 取值 + 2` 由数据集的 `channels[].min`（值 1 对应的尺寸）隐含。产物里已写进 `notes`（尺寸型通道语义说明），但格式本身**不承载"取值→尺寸"的偏移量** | 若 T2.4 的 UI 要显示"结构高度"，需按 `step.w/hh/d` 读，而不是按通道取值算。当前产品足够（滑杆只显示取值） |
| 7 | **`tableGapFillsPerPosition` 统计口径** | 该计数是"逐位置构表时的补齐次数"（同一组位置共享同一张表，故大于产物里实际缺档数）。EBF 16、QFT 378 | 仅影响报告可读性；已在报告里改名并注明。真实缺档只出现在 `indexTable[0]`（未设置分支，与档 1 同内容，契约 §6.2） |
| 8 | **QFT 的 `frames` 子树占内层 43%** | 契约 §5.3 要求每帧携带**有序规则 id 引用**，QFT 每帧 **59** 条（id 形如 `r.s0.g12.r3`）→ 200 帧 ≈ 11,600 条引用 ≈ 220 KB 未压缩。这是"规则按引用复用"的固有代价（远好于 945,000 格网格），但仍是产物里最大的可压缩项 | 可选优化（都不改契约语义）：① 缩短规则 id（`r.s0.g12.r3` → `a13`）预计省 3–5% 文件；② 给 `frame.rules` 引入"规则组"引用（契约外，需 T0.5 增补）。本轮不做（规则 id 保持自描述，便于 T3.x 诊断） |

**未做的事（明确声明）**：未改 `protocol/`（契约 §12.1 已拍板不动）；未改 `web/`（验证走 esbuild 临时捆绑，零写入）；
未改 T1.3 数据集（只读，`run-0015` 逐字节未动）；未做 git commit。

---

## 9. 产物清单与复现命令

### 9.1 产物

| 路径 | 说明 |
|------|------|
| `mod/gtnh/src/main/java/com/lightning/mod/client/multiblock/MultiblockFactorizer.java` | **编码器核心**（零 MC 依赖；T1.5 直接复用） |
| `mod/gtnh/src/main/java/com/lightning/mod/client/multiblock/MultiblockFactorizeTool.java` | 离线驱动（数据集 → 产物 + 统计 + 对照组；`main()` 可直跑） |
| `mod/gtnh/src/main/java/com/lightning/mod/client/export/SceneEnvelopeBuilder.java` | **仅加 2 处 `copyIfPresent`**（`meta.documentShape`；inner `multiblock` + `multiblockCount`） |
| `scripts/multiblock-encode/factorize.ps1` | 启动器（解析 classpath → `java -cp` 跑工具；前提 `gradlew compileJava`） |
| `scripts/multiblock-encode/verify-encoded.mjs` | **闭环验证器**（lib.mjs 装配 + 逐格 diff + 体积/κ/对照组汇总） |
| `scripts/multiblock-encode/verify-web-parser.mjs` | web 侧真实解析器/装配器交叉验证（esbuild 临时捆绑，零写入 web/） |
| `scripts/multiblock-encode/inspect-dependencies.mjs` | 诊断工具：逐位置打印"取值由什么决定"（新机器接入时先跑） |
| `mod/gtnh/run/client/variant_capture/encoded/mte*.multiblock.json` | **4 台契约产物**（生产形态 `base64(gzip(json))` 信封） |
| 同上 `*.multiblock.body.json` | 对应的内层 body（人工阅读/逐行 diff 用；非产品） |
| 同上 `control/*.multiblock.json` + `*.groundtruth.json` | 10 份对照组 + 其输入 ground-truth |
| 同上 `factorization-report.json` | 工具自报统计（每份文档的阶/规则/剪枝/体积/耗时） |
| 同上 `verification-report.json` | 闭环验证报告（含逐文档 diff 计数、κ、对照组拟合） |
| 同上 `web-parser-report.json` | web 侧交叉验证报告 |
| `scripts/volume-profile/out/t14-{before,after}.{md,json}` | 编码前后 T0.1 剖析 |
| `scripts/multiblock-fixtures/.out/validation-report.t14-encoded.json` | 14 份产物过 T0.5 校验器的全量输出 |

### 9.2 复现（全部零人工交互）

```powershell
# ① 编译（Java 侧编码器）
cd mod\gtnh; .\gradlew.bat compileJava

# ② 编码：4 台产物 + 10 份对照组 + 统计   （842 变体 + 对照组 ≈ 2 s）
cd ..\..
pwsh -File scripts\multiblock-encode\factorize.ps1 `
  -Dataset mod\gtnh\run\client\variant_capture\run-0015 `
  -OutDir  mod\gtnh\run\client\variant_capture\encoded -Control

# ③ 闭环验证（842/842 逐格 diff，退出码 0 = 全绿）
node scripts\multiblock-encode\verify-encoded.mjs `
  mod\gtnh\run\client\variant_capture\encoded mod\gtnh\run\client\variant_capture\run-0015

# ④ 契约校验器（格式 + 全组合装配 + 判定式）
node scripts\multiblock-fixtures\validate-multiblock-fixtures.mjs `
  mod\gtnh\run\client\variant_capture\encoded\*.multiblock.json `
  mod\gtnh\run\client\variant_capture\encoded\control\*.multiblock.json

# ⑤ web 侧真实解析器 + 装配器交叉验证
node scripts\multiblock-encode\verify-web-parser.mjs `
  mod\gtnh\run\client\variant_capture\encoded mod\gtnh\run\client\variant_capture\run-0015

# ⑥ 体积剖析（编码前 / 编码后）
node scripts\volume-profile\volume-profile.mjs analyse mod\gtnh\run\client\variant_capture\run-0015 --verify false `
  --md scripts\volume-profile\out\t14-before.md --json scripts\volume-profile\out\t14-before.json
node scripts\volume-profile\volume-profile.mjs analyse scripts\multiblock-encode\.out\profile-after --verify false `
  --md scripts\volume-profile\out\t14-after.md  --json scripts\volume-profile\out\t14-after.json
```

**确定性**：同一份数据集、同一份编译产物连跑两次（分别落 `encoded/` 与 `scripts/multiblock-encode/.out/encoded-rerun/`），
**14/14 份信封的 SHA-256 完全一致**（逐字节同一），统计里的 `innerSha256` 同样一致。
编码耗时：842 变体 + 10 份对照组 **≈ 2.0–2.6 s**（单台最贵 QFT 0.87 s）。

**既有回归**：`cd web && npx vitest run` → **11 文件 / 114 测试全绿**（含 T2.1 形态判别、T2.2 装配器 552 组合逐格、T2.4 通道面板 DOM）；
`mod/gtnh/gradlew.bat build` → **BUILD SUCCESSFUL**（含 `spotlessJavaCheck`）。
`SceneEnvelopeBuilder` 的两处扩展**不改变既有两条分支的任何字节**（未触碰既有 `copyIfPresent` 列表，只在"有 frames"分支追加 3 行）。

---

## 10. 交 T1.5 / T1.6 / T3.3 的接口摘要

1. **T1.5 只需三步**：
   ```java
   MultiblockFactorizer.MachineIn in = ...;                 // 从 VariantCaptureRunner 的内存变体 + GeometryPalette 装配
   MultiblockFactorizer.Result r = MultiblockFactorizer.factorize(in);
   JsonObject rawFinal = ...;                               // id/label/mode/documentShape + 把 r.innerBody 的键全部拷进来
   JsonObject envelope = SceneEnvelopeBuilder.toEnvelope(rawFinal);   // 既有信封，一行不改
   ```
   `factorize` 的所有失败都是 `FactorizeException`（带可定位原因）→ 直接进 T1.5 的失败清单（契约 §13.1.7）。
2. **T1.6/T3.3 的对照物**：`*.<name>.groundtruth.json` 的格式（`{machine, sourceSlug, variants:[{key,totalTier,values,runstate,cellGrid}]}`）
   可直接作为"展开形态校验文件"的雏形；T3.3 的 diff 工具照 `verify-encoded.mjs` 的 `gridEquals` + 内容层映射即可。
3. **T3.2 的自变量**：按契约 §9.5 用 **N（组合数）**；本次实测边际 **10–30 B/组合（gzip）**，
   `G ≈ a + b·N` 的 `b` 在"新增取值带来新方块状态"时会跳到 ~700 B/组合（那是**状态成本**不是**组合成本**），
   故建议 T3.2 把"新增方块状态数"作为协变量一并记录（本报告 §6 已给出分解口径）。
4. **T1.5 之前必须先解决的两个开放项**：多通道相交的 `guard` 规则生成（§8.4）、材质/贴图池按机剪枝（§8.2，可选但收益大）。

