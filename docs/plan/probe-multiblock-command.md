# T1.5 `/sde multiblock` 命令 + 配置面（含 T1.4 遗留：guard 规则生成）— 报告

> **任务**：`multiblock-channel-renderer-plan.md` §T1.5「`/sde multiblock` 命令 + 配置面」+
> §T1.4 遗留前置「多通道同位置相交的 guard 规则生成路径」（T1.4 报告 §8 开放项 4）。
> **上位依据**：[format-multiblock-doc.md](format-multiblock-doc.md)（契约 = 唯一格式真源，§4.5.3 / §5.1 / §5.2 / §6.1 / §9.4）、
> [probe-factorized-encoding.md](probe-factorized-encoding.md) §8.4、[probe-variant-capture.md](probe-variant-capture.md) §13.1、
> [probe-multiblock-scan.md](probe-multiblock-scan.md)（T1.2 枚举）。
> **状态**：完成。`gradlew build` 通过；游戏内 `/sde multiblock` 无人值守导出跑通两轮（4 台 与 13 台）；
> 10 份游戏内产物过 T0.5 校验器（**失败 0 / 警告 4**，警告均为良性 `illegal/no-channel`）且闭环**逐格 diff = 0**（合计 2638 变体）；
> guard 路径有**合成相交用例**全链路闭环（576 变体 diff=0 + web 侧真实装配 0 diff）与**真实 LSC** 数据闭环（1672 / 1152 变体 diff=0）。

---

## 0. 结论（TL;DR）

| 项 | 数字 / 结论 |
|----|-------------|
| **guard 路径** | 已实现（`MultiblockFactorizer`）：快路径（≤1 条替换型通道）无解时回退到「多通道键 + `guard.clauses` 多组规则」；规则 id 唯一、帧只引用 guard 成立的规则、文档标 `hasScopeOverlap:true` + `scopeOverlapNote`（契约 §4.1 必填项） |
| **T1.4 产物回归** | 4 台非相交机器产物 **SHA-256 逐字节不变**；10 份对照组只有 `multiblock.notes` 多出「域收窄 / 总 Tier 抽样」两条忠实度声明，其余字段逐字节相同 |
| **合成相交用例闭环** | 576 变体 / 2 骨架阶 / 33 规则（**18 条带 guard**，含「两条 clause 的三通道相交」）→ 参考装配器逐格 **diff = 0**、T0.5 校验器 **失败 0 / 警告 0**、**web 侧真实解析器 + T2.2 装配器 0 diff** |
| **真实 LSC（相交机）实测** | 原始捕获**不可无损编码**（上游捕获缺陷，§1.4）；按 `registryId:meta` 规范化后**两轮数据都闭环 diff = 0、校验器全绿**（1672 变体 / 1 阶；1152 变体 / 3 阶）。但**依赖分析证明**：采样窗口内 **0 个位置**同时依赖 ≥2 条通道（41/57/73 格只随 `glass`、9/18/27 格只随 `capacitor`、50 格常量）→ 真实数据上**未触发** guard（负结果，§1.4b） |
| **命令** | `/sde multiblock [all\|<name\|fqcn>[,<…>]] [limit=N]`；权限沿用 `SdePermissions.canUseSde`；tab 补全已更新；执行落在客户端 tick（命令只登记 common 侧请求 → `CommandSde` 零 `@SideOnly` 越界） |
| **产物隔离** | 产物目录 `sde_multiblock_exports/`（配置项 `outputDirName`），与 `/sde export` 的会话产物/`structure_exports` 完全独立；`CommandSde` 的 `export` 分支、`ExportSession`、`SceneEnvelopeBuilder` **一字未改** |
| **每个多方块恰好一份文件** | ✔ 产物目录里每台一个 `<slug>.multiblock.json`（无 `.body.json` 等旁挂文件）；中间数据集单独落 `_dataset/run-NNNN/` |
| **失败可诊断** | run A：4 台 → 3 份产物 + **480 条失败**；run B：13 台 → 8 份产物 + **1673 条失败**；每条含 `machine/stage/kind/message/异常链+栈顶帧`，其余机器继续，日志与报告逐条列出 |
| **配置面默认（留白 #6）** | `structuralCompression=true`、`maxChannelValues=0`（不限制）、`maxVariantsPerMachine=20000`、`maxExportMachines=0`（全部）、`structuralOnly=false`、`globalBudgetMs=4 h`、`outputDirName=sde_multiblock_exports` |
| **风险 7（全量耗时）** | **已触发**：全量不裁剪 = **5,551,258 变体**（≈154 h @100 ms/变体、728 h @472 ms）；默认上限 20000 = **413,754 变体**（只收窄 2 台）→ **11.5–32 h**；实测样本速率 **279.5 ms/变体**（13 台 / 6600 变体）。单次运行不可行 → 需用户裁定分片/子集（§3.5） |
| `gradlew build` | **通过**（含 `spotlessJavaCheck`） |

---

## 1. 前置：多通道同位置相交的 guard 规则生成（契约 §4.5.3）

### 1.1 实现

`MultiblockFactorizer` 的两段式键搜索（**快路径语义与 T1.4 完全同构**）：

1. **快路径（不变）**：候选键 = `{∅, 单条替换型通道} × {总 Tier} × {运行态}`；判据 = 「同一键元组上取值唯一」；
   择优 = 「帧分区最少 → 帧轴最少 → 键最小」。这是 T1.4 已验收的路径，凡它可解的位置**产物逐字节不变**。
2. **guard 回退（新增）**：快路径无解时（同一格的取值同时依赖 ≥2 条替换型通道），变量集取
   「全部替换型通道 + 总 Tier + 运行态」，从全集出发**逐个尝试消去**（先 `tt`、再 `rs`、再通道按下标从大到小），
   得到**不可约精确键**（精确性对键细化单调 ⇒ 贪心消去安全且确定）：
   - `channels[0]` = 查表通道 → `indexTable`（表长 = 域长，档 0 = 未设置分支，契约 §6.2）；
   - `channels[1..]` = guard 通道 → `guard.clauses:[{channel, value}…]`（**等值**形态；clauses 之间 AND，契约 §4.5.3）；
   - 每个 guard 元组一条 `fill`/`setCell` 规则；`frame.rules` **只引用该变体 guard 成立的规则**（省字节），
     装配器**仍**按契约 §5.4 逐条 `evalGuard` —— 两条路径结果相同；
   - 连完整键都不精确时（同一有效取值元组两个值）**硬失败并落盘原因**（位置 + 骨架阶 + 理由），不静默降级。
3. 文档级声明：`hasScopeOverlap = (guardPositions>0)`、`scopeOverlapNote`（列「哪些通道组合影响多少格 + 样例坐标（骨架阶:x,y,z）」）、
   `opsLegend["channel.guard"]`（**仅真正用到 guard 时才写**，因此非相交机器产物逐字节不变）、`notes[]` 追加相交说明；
   统计新增 `hasScopeOverlap / guardPositions / guardRules / guardKeyHistogram`。

### 1.2 回归证据：T1.4 已验收产物逐字节不变

```
pwsh -File scripts\multiblock-encode\factorize.ps1 -Dataset mod\gtnh\run\client\variant_capture\run-0015 `
     -OutDir scripts\multiblock-encode\.out\regress-guard -Control
→ 4 台产物 SHA-256 与 run/client/variant_capture/encoded/ 完全一致（SAME 4/4）
→ 10 份对照组 8 份 DIFF：**内层 body 只有 `multiblock.notes` 不同**（新增「通道域收窄到 0..K」「总 Tier 抽样 = [1,2]」），
  variants / frames / rules / backbone / blockPalette 逐字节相同 —— 正是 T1.5 要求的「抽样必须在产物 notes 记录」。
```

### 1.3 合成「多通道同位置相交」用例（闭环）

`scripts/multiblock-encode/make-synthetic-overlap.mjs`（调色板复用 T1.3 `run-0015/palette.json` 的真实条目，
网格由**确定性函数**生成，与编码器相互独立）+ 一条命令 `pwsh -File scripts/multiblock-encode/verify-guard-overlap.ps1`：

| 项 | 值 |
|----|----|
| 机器 | `SynthGuardOverlap`：`cap`/`glass`/`extra`（替换型）+ `height`（尺寸型，域 1..3） |
| 组合 | 域 4×4×3×3 × tierSample [1,2] × 运行态 2 = **576 变体**（= ∏域 × tierSample × 运行态，与校验器口径一致） |
| 相交位置 | **6 个**（跨 2 个骨架阶）：`(0,0,0)`+`(0,1,0)` → 2 通道（guard 通道 `glass`）；`(2,0,2)` → **3 通道（两条 clause：glass + extra）** |
| 规则 | 33 条 = 1 `palette.renumber` + **18 条 `channel.guard`** + 6 `channel.replace` + 4 `tier.overlay` + 4 `runstate.overlay` |
| 闭环 diff | **576/576 逐格 diff = 0**（`verify-encoded.mjs` + `lib.mjs` 参考装配器，退出码 0） |
| 契约校验器 | **失败 0 / 警告 0** |
| **web 侧真实实现** | `verify-web-parser.mjs`：web 真实 `MultiblockParser.detect` + `parseMultiblockDeclaration` + `RuntimeDocument` + **T2.2 装配器** → 文档 1 份 / 变体 576 / **逐格 diff 0** |
| 体积对照 | 校验器口径① 展开 31,450,334 B vs 产物 105,225 B = **298.89×** |

真实产物节选（`synthguardoverlap.multiblock.json`）：

```jsonc
{ "id": "r.s0.g6.r0.g1v1.g2v1", "phase": "replace",
  "guard": { "clauses": [ { "channel": "glass", "value": 1 }, { "channel": "extra", "value": 1 } ] },
  "legend": "channel.guard", "channel": "cap", "indexTable": [7,7,8,9],
  "kind": "setCell", "x": 2, "y": 0, "z": 2 }
```

### 1.4 真实 LSC（T0.4 点名的相交实例）实测

#### (a) 原始捕获不可无损编码 —— 上游捕获缺陷（已定位到格）

```
run A（height 收窄到 1 阶、tierSample=[1]、1672 变体）：
  T1.3 自报：已验证状态键 30 / **不稳定状态键 32**；失败 242 StateKeyMismatch + 237 CaptureErrors
  编码器拒绝：位置 (1,0,0) 在骨架阶 0 上的取值无法表达：即使取「全部替换型通道 + 总 Tier + 运行态」的完整键也不是精确键
根因（离线定位，直接 diff 数据集）：
  两个**布局签名完全相同**（21cc34086769e5a3）的变体
    capacitor:0|glass:0|height:0|tt:1|idle  与  capacitor:1|glass:1|height:1|tt:1|idle
  在 33 格上取值不同，而这些格**两边方块状态完全相同**（同为 bartworks:BW_GlasBlocks:0）、**几何却不同**。
  ⇒ 同一方块状态在不同构建里被烘焙出不同几何（透明玻璃亮度/AO 与假世界光照状态相关），
    调色板出现多条「同 registryId:meta、不同几何」的条目 → 同一有效取值元组上出现两个下标。
run B（height 0..3、capacitor 0..3、glass 0..11、1152 变体）复现同类问题：10 StateKeyMismatch + 10 CaptureErrors。
```

**处置（写范围内、零新游戏运行）**：`scripts/multiblock-encode/derive-lsc-real-subset.mjs` 对真实捕获数据做
「按 `(registryId, meta)` 归并调色板条目（= 契约 §6.1 第 3 条『同一方块状态的烘焙几何全文件只存一份』）+ 变体筛选」，
**不合成任何几何**（每条目、每格都来自真实构建与真实捕获）：

| 数据集 | 规范化 | 编码结果 | 闭环 diff | T0.5 校验器 |
|--------|--------|----------|-----------|-------------|
| run A LSC（1 阶 / tierSample [1]） | 497 → 69 条（归并 428），改写 88,495 格 | 1672 变体 / 5 规则 / 129,250 B / κ=5.67 | **1672/1672 = 0** | **失败 0 / 警告 0** |
| run B LSC（3 阶 / tierSample [1,2,3]） | 700 → 120 条（归并 580），改写 144,000 格 | 1152 变体 / 13 规则 / 192,794 B / κ=3.55 | **1152/1152 = 0** | **失败 0 / 警告 0**（`variants/complete` = 4×12×4 × 3 × 2 = 1152 ✔） |

#### (b) 为什么真实数据没触发 guard（负结果，逐位置依赖分析）

`inspect-dependencies.mjs`（与编码器同口径的单通道/运行态/Tier 依赖判定）：

| 数据集（规范化后） | 只随 `glass` | 只随 `capacitor` | 常量 | **需要 ≥2 通道** |
|---|---:|---:|---:|---:|
| run A：5×4×5（1 阶） | 41 | 9 | 50 | **0** |
| run B：5×4×5（阶 0） | 41 | 9 | 50 | **0** |
| run B：5×5×5（阶 1） | 57 | 18 | 50 | **0** |
| run B：5×6×5（阶 2） | 73 | 27 | 50 | **0** |

结论：在 `capacitor 0..10 × glass 0..37 × height 有效值 ` 到 `capacitor 0..3 × glass 0..11 × height 0..3`、
`tier` 1 到 1..3 这些窗口内，LSC 的「'C' 列」与「玻璃区」是**互不相交的位置集合**；
T0.4 记录的相交在**内容层**表现为一元依赖（元素级/优先级级重叠，谁写这一格），
**没有**产生「同一格同时随两通道变」的二维依赖。因此：
- guard 实现本身由**合成用例**完成全链路闭环（含两条 clause 的三通道情形，§1.3）；
- 真实 LSC 数据提供的是**真实数据闭环 diff=0**（1672 + 1152 变体）与**为何不需要 guard 的机器判据**（上表）；
- 若将来要「真实相交」证据，需要更宽的窗口（更多尺寸阶 / 更多 Tier，单变体成本见 §3.5）或换一台机器 —— 已登记为开放项 §4.3。

---

## 2. T1.5 命令与配置面

### 2.1 架构（一条命令 = 四步，零人工）

```
/sde multiblock [all|<name|fqcn>[,<…>]] [limit=N]                       （CommandSde，服务端线程）
 → SdeMultiblockConfig.requestExport(scope, player)                     （common 侧请求，**不引用任何 client 类**）
 → SdeClientAutomationTickHandler.onClientTick → MultiblockScanAutomation.tick（T1.2 起的既有挂接点）
 → MultiblockExportAutomation.tick（世界里立即执行；主菜单静置 60 tick）              （client，@SideOnly(CLIENT)）
 → MultiblockExportRunner.run(mc, cfg)：
      ① 枚举（T1.2）：读 multiblock_scan/run-NNNN/machines.json → 范围过滤（未知名单 / slug 碰撞**报失败**）
      ② 变体构建 + 捕获（T1.3）：VariantCaptureRunner.run(mc, cfg) —— **一次运行覆盖范围内全部机器**
         （共用一个并集调色板、一次纹理嵌入；每台落 machines/<slug>.json）
      ③ 因子化编码（T1.4）：MultiblockDatasetCodec 读取 → MultiblockFactorizer.factorize（与离线工具同一个编码器/读取器）
      ④ 信封落盘：既有 SceneEnvelopeBuilder.toEnvelope → <outputDir>/<slug>.multiblock.json（**每台恰好一份**）
 → export-report.json（产物清单 + 计时 + samplingPlan + failures[] + notes）
```

- **触发文件模式**：`<mcDataDir>/sde_multiblock.json`（与 T1.2/T1.3 同构；`exit`/`cleanupTrigger` 可选）→ 无人值守跑完即退出。
- **不需要真实存档**：与 T1.2/T1.3 一样在假世界（`ProbeDummyWorld`）里构建。
- **命令侧零 `@SideOnly` 越界**：`CommandSde`（common）只碰 `SdeMultiblockConfig`（common 的 `config` 包）；
  客户端 tick 才是 `@SideOnly(CLIENT)` 的落点 —— 专用服务器不会因命令类加载而 `NoClassDefFoundError`。
- **同一会话可重复执行**：`finished` 状态机在检测到新请求时重置。

### 2.2 权限与 tab 补全

| 项 | 落点 |
|----|------|
| 权限 | `SdePermissions.canUseSde(player)`（与 `record`/`pos1` 同一条）；`getRequiredPermissionLevel()` 仍为 2（未改动） |
| tab 补全 | 一级子命令表新增 `"multiblock"`；二级给 `all` / `limit=`（机器名来自 T1.2 枚举数据，不硬编码 219 个名字） |
| 用法串 | `getCommandUsage` 增补 `multiblock [all\|<name,...>] [limit=N]` |
| 重复请求 | `requestExport` 幂等：已有未消费请求时提示等待，不堆积 |
| `limit=N` | 本轮运行参数（= `maxExportMachines` 的运行时覆盖），便于分片 |

### 2.3 配置面（`config/SdeMultiblockConfig`）与留白 #6 的默认值

配置文件 `<mcDataDir>/config/sde_multiblock.cfg`（首次使用时按显式路径装载；装载路径写进报告 `notes[0]`）。
**为什么不挂在 `LightningMod.preInit`**：T1.5 写范围不含 `LightningMod`，故懒加载（调用者手上有 `mc.mcDataDir`，避免 common 侧猜数据目录）。

| 配置项 | 默认（**留白 #6 拍板**） | 理由 / 实测依据 |
|---|---|---|
| `structuralCompression` | `true` | 需求 C 本体。`false` 走 `MultiblockExpandedWriter`：每帧内联完整 `cellGrid` 的**组合展开**形态，仅供体积对照/诊断，**不通过契约校验器**（已在配置注释 + 产物 notes 写明） |
| `maxChannelValues` | `0`（不限制） | 收窄通道域 = 牺牲忠实度。221 台的**全量组合积分布**：`≤100`: 159 台、`≤1k`: 16、`≤5k`: 25、`≤20k`: 3、`≤100k`: 12、`≤1M`: 4、`>1M`: 2（最大 `MTEMultiAutoclave` 1,898,100、`MTELapotronicSuperCapacitor` 1,886,016） |
| `maxVariantsPerMachine` | **`20000`** | **单台**兜底（不是全局预算）。全量不裁剪 = **5,551,258 变体** → 单次运行不可能（§3.5）。20000 只让 **2/221** 台触碰上限，其余 219 台**零裁剪**；全量规划变体 413,754 |
| `maxExportMachines` | `0`（全部） | 导出范围上限只用于分片/试跑（`/sde multiblock limit=N` 是同一语义的运行时覆盖） |
| `structuralOnly` | `false` | `true` = 只导出结构性组合（跳过 active 运行态，变体减半，产物只声明 idle 一态） |
| `globalBudgetMs` | `4 h` | 整轮时间预算兜底：超时后剩余机器**计入失败清单**（不静默跳过）。它是「一次会话上限」，不是「全量必需时长」 |
| `outputDirName` | `sde_multiblock_exports` | 与 `/sde export` 完全分开（交付 A 硬要求） |
| `includeThumbnails` / `embedTextures` | `true` / `true` | 沿用 T1.3 既有机制 |
| `keepDataset` | `true` | 保留 `_dataset/run-NNNN/` 供离线复算 / T3.3 闭环；产物目录本身仍只有「每台一份产物 + 报告」 |

> **「上限只在抽样时生效」的边界声明**（T1.4 开放项 5）：一旦收窄通道域，**总 Tier 抽样上界被强制夹到 ≤ 收窄后最小域上界**
> （`VariantCaptureRunner` 的 `narrowedMinMax` 逻辑），否则「未设置 → 回落总 Tier」的真实值会越出声明域、契约 §5.2 下不可无损编码。
> 实测：LSC height 收到 0..1 → `tierSample` 从 `[1..47]` 自动夹到 `[1]` 并写入产物 notes；收到 0..3 → `[1,2,3]`。

### 2.4 抽样规划（自动兜底 + 显式抽样）

- **自动**（`MultiblockExportRunner.planSample`）：`∏(域+1) × 运行态 > maxVariantsPerMachine` 时，
  把**当前域最宽**的通道折半（下界 1，保持 `0..K` 连续前缀）直到满足；差额交给契约 §9.4 的 `tierSample` 抽样。
  收窄事实写进：数据集通道的 `subsetOverridden/trueDomainMax/subsetNote/notes`、`export-report.json.samplingPlan`、
  **产物 `multiblock.notes`**（2 条：域收窄 + 总 Tier 抽样）。
- **显式**（触发文件 `channelSample`）：直接给出每台每通道的取值前缀（必须从 0 起连续，否则落 `BadChannelSample` 失败）。
  run A/run B 用这条把 LSC 压到可捕获规模（组合积 20064 → 836 / 192）。

### 2.5 失败可诊断（静默跳过 = 失败）

`export-report.json.failures[]` 每条含 `machine / stage / kind / message / failure(异常链 + 栈顶 6 帧) / atEpochMs`；
`stage` ∈ {`scope`（枚举里找不到 / slug 碰撞）, `plan`（事实层读不出）, `t1.3-*`（构建、进态、捕获，原样并入 T1.3 的 failures）,
`encode`（`FactorizeException` 定位到通道/位置/变体）, `capture`（整轮捕获抛异常）}。
命令/触发文件跑完**逐条打印**失败清单，并把第一条的机器 + kind 回显到聊天栏。

---

## 3. 自检证据

### 3.1 `gradlew build`

`mod/gtnh> .\gradlew.bat build` → **BUILD SUCCESSFUL**（含 `spotlessJavaCheck`；格式化经 `spotlessApply`）。

### 3.2 无人值守导出（两轮，`MultiblockScanAutomation` 触发文件模式）

**run A**（4 台含 LSC；LSC 显式 `height:[0,1]`，`maxVariantsPerMachine=4000`）：

| 机器 | 变体 | 捕获 ms | 产物 | 失败 |
|------|-----:|--------:|------|------|
| `MTELapotronicSuperCapacitor` | 1672 | 789,761 | —（编码拒绝，§1.4a） | 242 StateKeyMismatch + 237 CaptureErrors + 1 FactorizeException |
| `MTEElectricBlastFurnace` | 420 | 30,155 | `mteelectricblastfurnace.multiblock.json` (103,583 B) | 0 |
| `MTEDistillationTower` | 220 | 10,574 | `mtedistillationtower.multiblock.json` (65,124 B) | 0 |
| `MTEBrickedBlastFurnace` | 2 | 132 | `mtebrickedblastfurnace.multiblock.json` (58,129 B) | 0 |
| **合计** | **2314** | **831,176** | **3 份**（= 4 请求 − 1 失败） | **480 条，全部有原因** |

**run B**（13 台：10 台分层计时 + 3 通道 `MTEEyeOfHarmony` + 宽窗口 LSC + 预期失败用例 `MTEPowerSubStation`）：

| 机器 | 变体 | 捕获 ms | ms/变体 | 产物 |
|------|-----:|--------:|--------:|------|
| `MTEBrickedBlastFurnace` | 2 | 428 | 214 | ✔ (157,793 B) |
| `MTEDecayWarehouse` | 20 | 11,421 | 571 | —（编码拒绝：完整键不精确） |
| `MTEPCBFactory` | 228 | 42,922 | 188 | —（编码拒绝：同一阶两种尺寸） |
| `MTEAdvEBF` | 420 | 50,891 | 121 | ✔ (207,035 B) |
| `MTEIndustrialCokeOven` | 68 | 5,422 | 80 | —（编码拒绝：两阶同尺寸） |
| `MTENetworkSwitchAdv` | 544 | 20,283 | 37 | ✔ (169,584 B，16 阶) |
| `MTEQuantumForceTransformer` | 200 | 17,914 | 90 | ✔ (186,145 B) |
| `MTEOilDrill2` | 2 | 203 | 102 | ✔ (161,823 B) |
| `MTEExoFoundry` | 24 | 1,895 | 79 | ✔ (174,602 B) |
| `MTEIndustrialDehydrator` | 420 | 58,408 | 139 | ✔ (202,641 B) |
| `MTEEyeOfHarmony` | 384 | 40,608 | 106 | ✔ (202,112 B) |
| `MTELapotronicSuperCapacitor` | 1152 | **1,518,985** | **1319** | —（编码拒绝，§1.4a） |
| `MTEPowerSubStation` | 3136 | 75,583 | 24 | —（编码拒绝：通道 id 重复 `cell`） |
| **合计** | **6600** | **1,848,962** | **279.5** | **8 份**（= 13 请求 − 5 失败） |

端到端链路佐证（`jstack`）：`MultiblockExportAutomation.tick → MultiblockExportRunner.run → VariantCaptureRunner.run → VariantGeometryBakery.capture`。

**失败清单的构成（run B，1673 条）**：`ServerBranchNotExecuted` 1365（active 态断言：`errorDisplayID` 未变化 —— 记录但不阻断产物）、
`StateKeyMismatch`/`CaptureErrors` 128 + 124（PCBFactory 118/113、DecayWarehouse 11/11、LSC 10/10）、
`BlockWithoutGeometry` 20（DecayWarehouse 有非空气方块捕不到四边形）、`ReplaceValueFidelityFailed` 8（DecayWarehouse）、
`MachineAssertionFailed` 2（CokeOven/NetworkSwitchAdv）、`FactorizeException` 5（逐条原因见上表）。

### 3.3 产物过契约校验器 + 闭环逐格 diff = 0

| 检查 | 命令 | 结果 |
|------|------|------|
| run A 闭环 | `verify-encoded.mjs <exports> <_dataset/run-0001>` | **642/642 变体、逐格 diff = 0**（3 份产物） |
| run A 校验器 | `validate-multiblock-fixtures.mjs <run A 3 份>` | **失败 0 / 警告 2**（`illegal/no-channel`：BBF/DT 无替换型通道，与 T1.4 同口径良性） |
| run B 闭环 | `verify-encoded.mjs <.out/run-b/products> <_dataset/run-0002>` | **1996/1996 变体、逐格 diff = 0**（8 份产物） |
| run B 校验器 | `validate-multiblock-fixtures.mjs <全部 10 份产物>` | **失败 0 / 警告 4**（同为良性） |
| guard 合成用例 | `pwsh -File scripts\multiblock-encode\verify-guard-overlap.ps1` | 576/576 diff = 0；校验器 失败 0/警告 0；web 侧 0 diff（一条命令可复现，退出码 0） |
| LSC 真实数据（1 阶 / 规范化） | `verify-encoded.mjs .out/lsc-real-encoded .out/lsc-real` | **1672/1672 diff = 0**；校验器 失败 0/警告 0 |
| LSC 真实数据（3 阶 / 规范化） | `verify-encoded.mjs .out/lsc-real-wide-encoded .out/lsc-real-wide` | **1152/1152 diff = 0**；校验器 失败 0/警告 0（`backbone/steps-count` = 3 ✓） |

### 3.4 `/sde export` 既有路径不受影响

**结构性论证**（`git diff` 实证）：

1. `CommandSde.java` 的 diff 只有 4 处：`+import SdeMultiblockConfig`、usage 串增补、`+case "multiblock"`、tab 表新增一项
   （`git diff --stat` = 62 insertions, 1 deletion —— 那 1 行删除是 usage 串）。`case "export"` / `hajimi` / `record` / `pos1`… **未被触碰**。
2. 命令注册点未改动：`LightningMod` L47 `event.registerServerCommand(new CommandSde())`（文件零修改）；
   `getCommandName()` / `getRequiredPermissionLevel()` 未变。
3. T1.5 不引用 `ExportSession`、不写 `structure_exports/`、不新增信封逻辑，`SceneEnvelopeBuilder` **一字未改**（复用 T1.4 的两处 `copyIfPresent`）。
4. `git status` 只涉及：`CommandSde.java`、`config/SdeMultiblockConfig.java`（新）、`client/multiblock/*`（新 4 个 + 改 4 个）、
   `scripts/multiblock-encode/*`（新 4 个）、`docs/plan/probe-multiblock-command.md`（新）。**未改** `web/`、`protocol/`、
   `SceneEnvelopeBuilder`、`client/automation/`、`client/meshcapture/`、`LightningMod` 及其它 mod 文件。

**运行时论证**：T1.5 产物目录与 `/sde export` 无交集；两者状态互不相干（`ExportSession` vs `SdeMultiblockConfig.pending`），不共享文件、不加锁。

### 3.5 全量耗时（计划风险 7）— 实测 + 外推

**实测样本（run B，13 台 / 6600 变体 / 1,848,962 ms）**：平均 **279.5 ms/变体**；
逐台范围 **24 ms/变体**（`MTEPowerSubStation`）～ **1319 ms/变体**（`MTELapotronicSuperCapacitor`），中位数 ≈ 105 ms。
`ms ≈ a + b·N` 最小二乘拟合 **R² = 0.07**（不可信）—— 说明单变体成本**不**由 N 决定，而由「结构规模 × 状态数 × 透明/几何复杂度」决定
（LSC 25 分钟 / 1152 变体 vs PowerSubStation 76 秒 / 3136 变体）。外推表（`extrapolate-full-run.mjs`，产物 `.out/full-run-extrapolation.{md,json}`）：

| `maxVariantsPerMachine` | 收窄机器 | 全量规划变体 | 全量外推（279.5 ms/变体，实测均值） | 全量外推（100 ms/变体） |
|---:|---:|---:|---:|---:|
| **不设上限（全量不裁剪）** | 0 | **5,551,258** | **431 h** | 154 h |
| **20000（默认）** | 2 | **413,754** | **32.1 h** | 11.5 h |
| 10000 | 5 | 250,394 | 19.4 h | 7.0 h |
| 4000（run A/B 实测配置） | 6 | 150,030 | 11.7 h | 4.2 h |
| 2000 | 6 | 88,454 | 6.9 h | 2.5 h |
| 1000 | 11 | 47,470 | 3.7 h | 1.3 h |

**结论（必须上报的裁定项）**：**全量 221 台在单次运行里不可行**（默认配置 32 h、全量不裁剪 431 h）。
选项（需用户裁定）：① 子集验收（10–20 台代表机 = 1–3 h，已具备工具链）② 分片并行
（`/sde multiblock <machine-list>` 或 `maxExportMachines`/`limit=N`，各分片独立进程/机器，共享只读的 T1.2 事实层）
③ 下调上限（1000 → 全量 47,470 变体 ≈ 3.7 h）。
注意：分片不会改变单变体成本，只会把总时长摊到并行度上。

---

## 4. 开放项与风险

| # | 项 | 影响 | 建议处置 |
|---|----|------|----------|
| 1 | **全量 221 台单次运行不可行（风险 7 触发）** | 见 §3.5：默认配置 32 h、全量不裁剪 431 h（实测均值） | **需用户裁定**：子集验收 / 分片并行 / 下调 `maxVariantsPerMachine`。工具链已就绪（机器清单 + `limit=N` + 每轮报告） |
| 2 | **上游捕获保真度：5/13 台无法无损编码（run B）** | 逐条已定位：① 状态键几何不稳定（LSC/DecayWarehouse：同状态不同几何 → 完整键不精确）② 未声明的尺寸轴（PCBFactory：同阶两种尺寸 `[7,6,7]` vs `[11,7,11]`）③ 尺寸通道平台期（CokeOven：两阶同尺寸 `3x3x3`）④ 通道 id 重复（PowerSubStation 两条 `cell`）⑤ `BlockWithoutGeometry`（DecayWarehouse 20 条） | ①②③⑤ 属 T1.3/捕获层（`client/meshcapture` 不在本任务写范围）：建议独立任务做「quad 亮度/材质规范化」「尺寸驱动轴补探测」「平台期阶合并」。④ 属 T1.2 探测层（重名 id 消歧）。**这 5 台当前不可交付**，但失败原因已可机器定位 |
| 3 | **真实数据未触发 guard（LSC 负结果）** | 见 §1.4b：4 个窗口 × 逐位置依赖分析，需要 ≥2 通道的位置数 = **0** | 若要真实相交证据：更宽窗口（更多尺寸阶/Tier，单变体 1.3 s → 代价高）或换机器。guard 实现已有合成用例全链路闭环（含两条 clause 的三通道情形） |
| 4 | **`materialPalette`/`textureBlobs` 未按机剪枝**（T1.4 §8.2 的放大版） | 每份产物都带全套池：run B 产物 **150–207 KB/份**（含 EyeOfHarmony 的 15 条调色板但材质/贴图池是全量）；BBF 内层从 T1.4 的 89 KB 涨到 137 KB，**+48 KB 全是池**。全量 221 台 = 每文件重复同一大池 | 独立任务做「按机剪枝 + 同步改写条目 `materialIndex`」（T1.4 已列判据）。这是全量导出的体积主项 |
| 5 | **T1.2 枚举 221 条 → 219 个唯一 slug** | 4 台机器只有 2 个不同 simpleName：`MTELargeTurbineSteam`（mteId 865 GT++ / 1131 GT）与 `MTELargeTurbineGas`（1151 / 31073）→ 产物文件与 T1.3 数据集文件名都会互相覆盖 | **已在 `readEnumeration` 落 `DuplicateSlug` 失败**（不再静默）；根治需 T1.2 的 slug 消歧（按 mteId 或 fqcn 前缀加后缀），属上游 |
| 6 | **`ServerBranchNotExecuted` 噪声占失败清单 82%**（1365/1673） | active 态断言（`errorDisplayID` 未变化）在部分机器上系统性触发，会让报告 `status=has-failures`（但不阻断产物） | 建议把「变体级断言噪声」与「产物级失败」在报告里分列（`variantWarnings` vs `failures`），便于机器判定；口径需 T1.3 确认（本轮不改语义） |
| 7 | **`frames` 子树随规则条数增长**（T1.4 §8.8 延续） | QFT 200 帧 × 59 规则引用；guard 规则多的机器更明显 | 可选优化（缩短规则 id / 规则组引用，契约外需 T0.5 增补）；本轮不做 |
| 8 | **`structuralCompression=false` 的非生产形态** | 组合展开形态不过校验器（设计如此，已在配置注释 + 产物 notes 写明） | 仅作 T3.2 体积对照/诊断；不得作为交付形态 |
| 9 | **`globalBudgetMs` 默认 4 h 会产出「部分完成」报告** | 超时机器进 `failures[]`（`GlobalBudgetExceeded`），产物数 < 请求数 | 分片/子集运行时按需调大；`status=has-failures` 可机器判定 |

---

## 5. 产物清单与复现命令

### 5.1 代码（写范围内）

| 路径 | 说明 |
|------|------|
| `mod/gtnh/src/main/java/com/lightning/mod/server/command/CommandSde.java` | `multiblock` 子命令 + tab 补全（`export` 分支未动） |
| `mod/gtnh/src/main/java/com/lightning/mod/config/SdeMultiblockConfig.java` | **新增**：配置面（默认值 = 留白 #6）+ 命令→客户端 tick 的请求交接（common 侧，零 client 引用） |
| `mod/gtnh/src/main/java/com/lightning/mod/client/multiblock/MultiblockExportRunner.java` | **新增**：枚举 → 抽样规划 → T1.3 捕获 → 逐台因子化 → 信封落盘 → `export-report.json` |
| 同上 `MultiblockExportAutomation.java` | **新增**：触发文件 + 命令两条入口的客户端执行体 |
| 同上 `MultiblockDatasetCodec.java` | **新增**：T1.3 数据集唯一读取器（离线工具与游戏内共用；支持 `subsetOverridden/trueDomainMax`） |
| 同上 `MultiblockExpandedWriter.java` | **新增**：`structuralCompression=false` 的组合展开写出器（诊断用） |
| 同上 `MultiblockFactorizer.java` | guard 回退搜索 + guard 规则/帧引用 + `hasScopeOverlap/scopeOverlapNote` + 忠实度 notes + 统计 |
| 同上 `VariantCaptureRunner.java` | **增量**：`run(mc,cfg)` 重载、`outputDirName`、`channelSample`（域收窄 + Tier 上界夹取）、`includeActiveRunstate`；无配置时行为不变 |
| 同上 `MultiblockScanAutomation.java` | 挂接点多认一个触发文件/待执行请求（T1.3 之后、3 行分派） |
| 同上 `MultiblockFactorizeTool.java` | 改为委托 `MultiblockDatasetCodec`（单一读取器，消除双实现） |
| `scripts/multiblock-encode/make-synthetic-overlap.mjs` | 合成相交数据集生成器 |
| `scripts/multiblock-encode/verify-guard-overlap.ps1` | guard 闭环一条命令（生成 → 编码 → 闭环 → 校验器） |
| `scripts/multiblock-encode/derive-lsc-real-subset.mjs` | 真实 LSC 数据规范化子集派生（按 `registryId:meta` 归并 + 变体筛选） |
| `scripts/multiblock-encode/extrapolate-full-run.mjs` | 风险 7 外推工具（实测单台耗时 → 全量 + 上限扫描） |
| `scripts/multiblock-encode/pick-timing-sample.mjs` | 分层计时样本选择器 |

**未做**：未改 `web/`、`protocol/`、`SceneEnvelopeBuilder`、`client/automation/`、`client/meshcapture/`、`LightningMod`；未 git commit。

### 5.2 游戏内产物与证据

| 路径 | 说明 |
|------|------|
| `mod/gtnh/run/client/sde_multiblock_exports/export-report.json` | 每轮报告（产物 + 计时 + samplingPlan + failures + notes）；`latest-export-report.json` 同内容 |
| 同上 `*.multiblock.json` | 每台多方块**恰好一份**产物（gzip+base64 信封） |
| 同上 `_dataset/run-NNNN/` | 中间数据集（`palette.json` + `machines/<slug>.json` + T1.3 的 report/manifest） |
| `scripts/multiblock-encode/.out/run-a/`、`.out/run-b/` | 两轮归档（报告 + 产物 + 数据集副本 + T1.3 报告） |
| `scripts/multiblock-encode/.out/synth-overlap{,-encoded}/` | 合成相交用例数据集与产物 |
| `scripts/multiblock-encode/.out/lsc-real{,-encoded}/`、`lsc-real-wide{,-encoded}/` | 真实 LSC 1 阶 / 3 阶规范化子集与产物 |
| `scripts/multiblock-encode/.out/full-run-extrapolation.{md,json}` | 风险 7 外推产物 |
| `scripts/multiblock-fixtures/.out/validation-report.t15-*.txt` | 各轮产物过 T0.5 校验器的全量输出 |

### 5.3 复现（全部零人工交互）

```powershell
# ① 构建
cd mod\gtnh; .\gradlew.bat build; cd ..\..

# ② guard 闭环（合成相交用例：生成 → 编码 → lib.mjs 逐格 diff → T0.5 校验器）
pwsh -File scripts\multiblock-encode\verify-guard-overlap.ps1

# ③ 游戏内子集导出（无人值守；产物落 run\client\sde_multiblock_exports）
Set-Content -Path mod\gtnh\run\client\sde_multiblock.json -Encoding utf8NoBOM -Value @'
{ "machines": ["MTELapotronicSuperCapacitor","MTEElectricBlastFurnace","MTEDistillationTower","MTEBrickedBlastFurnace"],
  "channelSample": { "MTELapotronicSuperCapacitor": { "height": [0,1] } },
  "maxVariantsPerMachine": 4000, "requestedBy": "repro-run-a", "exit": true, "cleanupTrigger": true }
'@
cd mod\gtnh; .\gradlew.bat runClient; cd ..\..

# ④ 产物过契约校验器 + 闭环逐格 diff
$files = Get-ChildItem mod\gtnh\run\client\sde_multiblock_exports\*.multiblock.json | % FullName
node scripts\multiblock-fixtures\validate-multiblock-fixtures.mjs @files
node scripts\multiblock-encode\verify-encoded.mjs mod\gtnh\run\client\sde_multiblock_exports mod\gtnh\run\client\sde_multiblock_exports\_dataset\run-0001

# ⑤ 真实 LSC 规范化子集（离线，零游戏运行；1 阶 与 3 阶两个窗口）
node scripts\multiblock-encode\derive-lsc-real-subset.mjs `
  --dataset mod\gtnh\run\client\sde_multiblock_exports\_dataset\run-0001 --out scripts\multiblock-encode\.out\lsc-real
pwsh -File scripts\multiblock-encode\factorize.ps1 -Dataset scripts\multiblock-encode\.out\lsc-real -OutDir scripts\multiblock-encode\.out\lsc-real-encoded
node scripts\multiblock-encode\verify-encoded.mjs scripts\multiblock-encode\.out\lsc-real-encoded scripts\multiblock-encode\.out\lsc-real
node scripts\multiblock-encode\derive-lsc-real-subset.mjs --dataset mod\gtnh\run\client\sde_multiblock_exports\_dataset\run-0002 `
  --out scripts\multiblock-encode\.out\lsc-real-wide --heights 0,1,2,3 --tiers 1,2,3
pwsh -File scripts\multiblock-encode\factorize.ps1 -Dataset scripts\multiblock-encode\.out\lsc-real-wide -OutDir scripts\multiblock-encode\.out\lsc-real-wide-encoded
node scripts\multiblock-encode\verify-encoded.mjs scripts\multiblock-encode\.out\lsc-real-wide-encoded scripts\multiblock-encode\.out\lsc-real-wide

# ⑥ 风险 7：全量耗时外推（含 maxVariantsPerMachine 扫描）
node scripts\multiblock-encode\extrapolate-full-run.mjs `
  scripts\multiblock-encode\.out\run-b\export-report.json `
  mod\gtnh\run\client\multiblock_scan\run-0002\machines.json `
  --md scripts\multiblock-encode\.out\full-run-extrapolation.md --json scripts\multiblock-encode\.out\full-run-extrapolation.json
```

### 5.4 事实勘误与登记

- **T1.2 `machines.json`（run-0002）= 221 条枚举 → 219 个唯一 slug**（2 对重名 simpleName，4 台机器）：
  `MTELargeTurbineSteam`（mteId 865 GT++ / 1131 GT）、`MTELargeTurbineGas`（1151 / 31073）。已改为落 `DuplicateSlug` 失败（开放项 5）。
- 计划 §T1.5 建议的输出目录 `run/client/sde_multiblock_exports/` → **按建议取值**并提升为配置项 `outputDirName`。
- 留白 §9 第 6 条（上限默认值）→ **本报告 §2.3 拍板**：`maxVariantsPerMachine=20000`（单台兜底）、`maxChannelValues=0`、
  `maxExportMachines=0`、`structuralOnly=false`、`globalBudgetMs=4 h`。
- 尺寸型/运行态口径沿用 T1.4：**不要**用 T1.3 数据集的 `variants[].effective` 作尺寸型通道 oracle（T1.4 §8.1 / T1.3 §13.1 勘误）。
- 本任务写范围内的 `VariantCaptureRunner` 增量**默认行为不变**：不带 `channelSample`/`outputDirName`/`includeActiveRunstate` 时，
  T1.3 触发文件路径的行为与改动前一致（回归：T1.4 的 4 台产物 SHA-256 不变）。
