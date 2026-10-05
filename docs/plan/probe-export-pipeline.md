# T1.6 游戏内自动导出管线（E 管线的 mod 半环）— 报告

> **任务**：`multiblock-channel-renderer-plan.md` §T1.6「游戏内自动导出管线」+ §9 留白 #7/#8/#10；
> 上位依据 [probe-multiblock-command.md](probe-multiblock-command.md)（T1.5：`/sde multiblock`、配置面、产物目录、失败落盘格式）、
> [probe-run-state.md](probe-run-state.md) §4.4（CoFH 卡死 / 进缺失模组存档死锁 / 主菜单态 `renderViewEntity` NPE）、
> [probe-variant-capture.md](probe-variant-capture.md)（T1.3 设施与数据集格式）、
> [multiblock-channel-renderer-plan.md](multiblock-channel-renderer-plan.md) §3.5（风险 7：全量耗时）。
> **状态**：完成。`gradlew build` 通过；**全闭环无人值守跑通三次**（两次幂等 + 一次故意失败）。
> 自检 1（产物逐字节一致）：**5/5 产物 + 35/35 展开校验文件 SAME**；
> 自检 2（故意失败）：**退出码 2 + `UnknownMachine` 原因落盘**；
> 自检 3（展开 vs 装配逐格 diff）：**5 台 / 35 组合 / 43,749 格 diff = 0**（`full` 与 `idMeta` 两个口径都 0）；
> 自检 4（耗时）：默认子集单轮 **154.0 s / 147.8 s**（进世界 7.0 s，导出 146.4 s，捕获 145.1 s）。

---

## 0. 结论（TL;DR）

| 项 | 结论 / 数字 |
|----|-------------|
| **一条命令** | `npm run multiblock:export`（= `pwsh -File scripts/multiblock-pipeline/run-pipeline.ps1`），或直接 `cd mod/gtnh && .\gradlew.bat runClientSdePipeline`（需先写触发文件） |
| **零人工交互** | 客户端启动 → 自动进**专用干净世界** → 聊天栏真实执行 `/sde multiblock <范围>` → 等导出落盘 → 写展开校验文件 + 结构化结果 → 按退出码退出。GUI 全程无需点击，实测三次无人工介入 |
| **专用世界（留白 #7）** | `sde_pipeline_world`：不存在则「超平坦 + 创造 + 允许命令」新建，存在则复用。首轮 `created`（7.4 s）、后续轮 `reused`（6.6–7.5 s） |
| **范围参数** | 触发文件 `scope`（simpleName / fqcn / slug，逗号或数组）；缺省 = **管线默认验收子集**；`["all"]` = 全量 |
| **默认验收子集（风险 7 裁决）** | `MTEElectricBlastFurnace`、`MTEDistillationTower`、`MTEBrickedBlastFurnace`、`MTEQuantumForceTransformer`、`MTEAdvEBF` = **1262 变体 / 5 产物**（T1.5 实测这 5 台**零失败**） |
| **完成信号** | `<mcDataDir>/sde_multiblock_pipeline_result.json`（结构化结果，外层脚本只认这一个稳定路径；产物目录内另有 `pipeline-result.json` 同内容副本） |
| **退出码** | `0` 全绿；`2` 与本次范围相关的导出失败；`3` 管线级致命；`4` 编排层拿不到结果文件。**实测：成功轮 0 / 故意失败轮 2** |
| **幂等** | 两次无人值守导出：5/5 产物 + 35/35 展开校验文件 **SHA-256 逐字节一致**（`compare-runs.mjs` 退出码 0） |
| **失败可诊断** | `failures[]`（T1.5 原样并入 + 管线级）+ `inScopeFailures[]`/`outOfScopeFailures[]` 分列 + `variantWarnings` 按 kind 聚合 + `chatLines`（服务端回包，用于定位「命令为什么没被受理」） |
| **展开校验文件（留白 #10）** | `<产物目录>/expanded/<slug>.multiblock__<variant>.json` + `_manifest.json`（抽样清单）。**5 台 / 35 组合 / 35 文件 / 43,749 格，逐格 diff = 0** |
| **与 T1.5/T1.4 闭环** | 同一批产物过 `verify-encoded.mjs`：**1262/1262 变体 diff = 0**；过 T0.5 契约校验器：**失败 0 / 警告 2**（良性 `illegal/no-channel`） |
| **`gradlew build`** | **通过**（含 `spotlessJavaCheck`） |
| **写范围** | 只动 `client/multiblock/`（3 新）、`client/automation/`（+24 行最小挂接）、`config/`（1 新）、`mod/gtnh/build.gradle.kts`、根 `package.json`、`.gitignore`、`scripts/multiblock-pipeline/`。**未动** `web/`、`protocol/`、`CommandSde.java`、`SceneEnvelopeBuilder.java`、T1.5 的任何文件 |

---

## 1. 留白 #7 / #8 / #10 拍板

### 1.1 留白 #7 —「自动进世界」的实现方式：**专用干净世界（新建 or 复用同一存档）**

**拍板**：`<mcDataDir>/saves/sde_pipeline_world`，判据是 `level.dat` 是否存在：

| 情形 | 动作 | 幂等性 |
|------|------|--------|
| 不存在 | `launchIntegratedServer(folder, "SDE Pipeline World", new WorldSettings(固定种子, CREATIVE, false, false, WorldType.FLAT).enableCommands())` | ✔ 每轮都是同一世界、同一生成参数 |
| 已存在 | `launchIntegratedServer(folder, "SDE Pipeline World", null)`（读回存档自己的 `WorldInfo`） | ✔ 复用同一世界，不重建 |

**理由**（不是"省事"，是 T0.3 §4.4(2) 的线程 dump 实证）：
1. **绝不能加载玩家存档**：含缺失模组的存档会走 `Loader.fireMissingMappingEvent → GameData.processIdRematches → StartupQuery.confirm`，
   客户端弹确认框、Server 线程 `CountDownLatch.await`、而 `Minecraft.launchIntegratedServer` 又在 Client 线程 `Thread.sleep` 等世界 —— **两侧互等死锁**；
   就算应答了，客户端随后还会因缺失 dimension provider 崩溃，并且**会改写该存档**（本机首个存档 `test` 就是这种）。
2. **导出根本不依赖世界内容**：T1.3 的变体构建与几何捕获都在 `ProbeDummyWorld` 里做（T1.5 §2.1），
   真实世界只是一个"有个真玩家、能发命令"的容器。因此"复用同一世界"对产物**没有任何影响** —— 这一点由自检 1 的逐字节一致直接证明。
3. `WorldSettings.enableCommands()` 是**必要**的：`ServerConfigurationManager.func_152596_g`（`SdePermissions` 的底层）只在
   `server.isSinglePlayer() && worldInfo.areCommandsAllowed() && serverOwner == player` 时给 OP；不打开 cheats，`/sde multiblock` 会被拒。
4. 用户给出的两个选项（"不存在则自动创建超平坦/虚空世界"）里选 **`WorldType.FLAT`**：`WorldType` 是原版注册表里的类型，
   无需自定义 `IChunkProvider`；而 void 需要自带生成器（多一份要维护的代码）。超平坦在 GTNH 下加载实测 0.5 s 量级。

**留了逃生门**：聊天命令若在 120 tick 内没被受理（例如世界 `commandsAllowed` 被外部改过），管线会**回退到直接
`SdeMultiblockConfig.requestExport`** 并把它写进 `warnings[]`（含最近的服务端聊天回包），
**不会**静默失败、也不会因此判成功（回退事实写在 `scope.channel = "direct-request(fallback)"`）。实测三轮都走的是**命令路径**，回退未触发。

### 1.2 留白 #8 —「验收总入口命令名与编排方式」：**gradle task + 根 npm script 各一层薄封装**

**拍板**：

| 层 | 名字 | 职责 |
|----|------|------|
| gradle task | `runClientSdePipeline` | 只做一件事：**以正确的 JVM 参数把客户端拉起来**。它 `dependsOn("runClient")`，并且只在**本任务被请求时**给 `runClient` 注入 `-Dfml.queryResult=confirm`（普通 `runClient` 一字不变） |
| npm script | `npm run multiblock:export` | 外层编排：前置检查 → 写触发文件 → 起客户端（带进程超时）→ 读结构化结果 → 归档产物 → **以管线的退出码退出** |
| npm script | `npm run multiblock:selfcheck` | 一条命令跑完四项自检（两次幂等 + 故意失败 + 逐格 diff + 耗时汇总） |
| npm script | `npm run multiblock:verify-expanded` / `multiblock:compare-runs` | 两个离线校验器（T3.3 直接复用前者） |

**为什么不是"只用 gradle task"**：`gradle` 看不到"CoFH conf 缺失会在启动阶段静默挂住"这件事（那是 JVM 启动前的文件系统事实），
也无法在客户端挂死时给出可诊断的退出码；而"只用 npm script"又会让 Phase 3 在纯 gradle 环境里没有入口。
两层各司其职，且 **Phase 3 的总入口建议就叫 `npm run acceptance:multiblock`，内部第一步调 `multiblock:export`**（本任务不占用该名字）。

### 1.3 留白 #10 —「展开形态校验文件的格式与抽样清单」：见 §5（与 `referenceGrids.ts` 的口径逐条对齐）

---

## 2. 管线实现（一个客户端 tick 状态机）

```
INIT ──▶ JOIN ──▶ WAIT_WORLD ──▶ COMMAND ──▶ WAIT_PENDING ──▶ EXPORT ──▶ FINALIZE ──▶ DONE
 │         │            │            │              │              │            │
读触发文件 建/复用世界  等 thePlayer  发聊天命令   等请求登记     驱动 T1.5    产物哈希+
+ 前置检查             +静置 40tick               (60t 重发/120t 回退) 导出一次   展开校验文件
                                                                                +结构化结果+退出
```

| 阶段 | 关键点 |
|------|--------|
| `INIT` | 读触发文件；`SdeMultiblockConfig.load()`（复用 T1.5 配置面，不新增配置项）；CoFH conf 检查；**首次接管 tick 时补设 `System.setProperty("fml.queryResult","confirm")`**（JVM 参数缺失时的进程内兜底） |
| `JOIN` | 见 §1.1。`launchIntegratedServer` 是阻塞调用（内部 `Thread.sleep(200)` 循环） |
| `WAIT_WORLD` | 等 `theWorld != null && thePlayer != null && currentScreen == null`，再静置 40 tick（约 2 s）避免命令被吞 |
| `COMMAND` | `mc.thePlayer.sendChatMessage("/sde multiblock MTEElectricBlastFurnace,MTEDistillationTower,...")` —— **真实命令路径**（CommandSde → `SdeMultiblockConfig.requestExport`），并在发送前记录 `export-report.json` 的 mtime |
| `WAIT_PENDING` | 轮询 `SdeMultiblockConfig.hasPendingExport()`；60 tick 未受理则重发；120 tick 仍未受理则回退直连并记警告；400 tick 判 `CommandNotAccepted` 致命 |
| `EXPORT` | 调 **T1.5 的 `MultiblockExportAutomation.tick(mc)`**（它才是执行体；管线不改它的语义）。完成判据 = `export-report.json` 的 `finishedAtEpochMs ≥ 命令发出时刻` **且** mtime 变化；若导出抛异常没写成报告，则抓 `failure-*.json`（T1.5 的落盘格式）作为原因 |
| `FINALIZE` | 逐份产物重算 SHA-256 → 写展开校验文件 → 写结构化结果 → 清触发文件 → 按退出码退出 |

**"本次到底跑没跑过导出"的判据**：`commandSentMs > 0 && exportAttempts > 0`。不满足时结果里落 `ExportNotAttempted` 致命失败，
**并且忽略目录里可能存在的上一轮 `export-report.json`** —— 否则"读不到本轮结果"会退化成"读到上一轮结果"，那就是静默通过。

**退出码落定（踩坑点，见 §6.3）**：走 `FMLCommonHandler.instance().exitJava(code, false)`；`code == 0` 才走
`Minecraft.shutdown()` 的正常收尾。两条路都挂 120 s 安全网线程（`exitJava(code, true)` = 真 halt），
无人值守下即使收尾被卡住也不会挂死外层编排。

---

## 3. 管线用法

```powershell
# ① 默认验收子集（风险 7 裁决：EBF/DT/BBF/QFT/AdvEBF），跑完归档到 scripts/multiblock-pipeline/.out/<label>/
npm run multiblock:export -- -Label idem-run-1
#    等价：pwsh -File scripts/multiblock-pipeline/run-pipeline.ps1 -Label idem-run-1

# ② 指定子集（Phase 3 小子集迭代）
pwsh -File scripts/multiblock-pipeline/run-pipeline.ps1 -Label subset -Scope MTEElectricBlastFurnace,MTEDistillationTower

# ③ 故意失败（自检 2）：不存在的机器名
pwsh -File scripts/multiblock-pipeline/run-pipeline.ps1 -Label fail-demo -Scope MTENoSuchMachineT16

# ④ 全量（风险 7：默认配置 ≈ 32 h、不裁剪 ≈ 431 h，**需用户裁定**；脚本只做时长守卫，不阻止）
pwsh -File scripts/multiblock-pipeline/run-pipeline.ps1 -Label full -All -ProcessTimeoutMinutes 2880

# ⑤ 四项自检一条命令
npm run multiblock:selfcheck

# ⑥ 离线校验（T3.3 的 mod 半环）
node scripts/multiblock-pipeline/verify-expanded.mjs <产物目录>
node scripts/multiblock-pipeline/compare-runs.mjs <run1 的 pipeline-result.json> <run2 的 pipeline-result.json>
```

触发文件（由脚本写，也可手写后直接 `gradlew runClientSdePipeline`）：

```jsonc
{
  "label": "idem-run-1",
  "world": "sde_pipeline_world",           // 专用干净世界目录名（留白 #7）
  "scope": ["MTEElectricBlastFurnace", "..."],  // 省略 = 默认验收子集；["all"] = 全量
  "expanded": { "enabled": true, "randomSamples": 5 },   // 留白 #10
  "cleanupTrigger": true,                   // 跑完删触发文件
  "limit": 8,                               // 可选：/sde multiblock limit=N（分片用）
  "phaseTimeoutMs": 1800000, "totalTimeoutMs": 21600000  // 可选：阶段/整轮预算
}
```

**范围参数**：simpleName / fqcn / slug 任一形态，逗号或空白分隔；**未知名单不会静默忽略** ——
`filterScope` 落 `scope/UnknownMachine` 失败并据此给出非零退出码（自检 2 就是这条）。

**退出码**：`0` 全绿 / `2` 与本次范围相关的导出失败 / `3` 管线级致命 / `4` 外层编排自身失败（拿不到结果文件）。

---

## 4. 自检证据

全部命令与产物在 `scripts/multiblock-pipeline/.out/`（`.gitignore` 已登记）。

### 4.1 自检 1 — 幂等：连续两次无人值守导出，产物逐字节一致

`pwsh -File scripts/multiblock-pipeline/selfcheck.ps1`（本地三次真实客户端运行，零人工交互）：

| | run1 `t16-idem-1` | run2 `t16-idem-2` |
|---|---|---|
| status / exitCode | `ok` / `0` | `ok` / `0` |
| 世界 | `sde_pipeline_world`（reused） | `sde_pipeline_world`（reused） |
| 范围 | 5 台（默认子集） | 5 台（默认子集） |
| 变体 | 1262 | 1262 |
| 产物 | 5 份 / 444,336 B | 5 份 / 444,336 B |
| 展开校验文件 | 5 台 / 35 组合 / 35 文件 | 5 台 / 35 组合 / 35 文件 |

**哈希对比（`compare-runs.mjs`，退出码 0）**：

| 类别 | 文件 | 字节(1/2) | 判定 | SHA-256（前 16） |
|---|---|---|---|---|
| 产物 | `mteelectricblastfurnace.multiblock.json` | 109231 / 109231 | **SAME** | `505554d8ed31911e` |
| 产物 | `mtedistillationtower.multiblock.json` | 70740 / 70740 | **SAME** | `1ccd7cb34b4ba58b` |
| 产物 | `mtebrickedblastfurnace.multiblock.json` | 63057 / 63057 | **SAME** | `210cedd06c1b00de` |
| 产物 | `mtequantumforcetransformer.multiblock.json` | 91853 / 91853 | **SAME** | `6865bf41a455f934` |
| 产物 | `mteadvebf.multiblock.json` | 109455 / 109455 | **SAME** | `77304ce6e0346404` |
| 展开校验文件 | `expanded/*.json`（35 份） | — | **SAME 35/35** | 略（见 `compare-runs` 全量输出） |

```
产物：5/5 逐字节一致；展开校验文件：35/35 逐字节一致
✅ 幂等：两次无人值守导出的产物与展开校验文件全部逐字节一致
```

> **这一条不是"天然成立"的**：T1.5 产物的 `multiblock.notes[0].text` 写的是
> 「数据来源：`run-NNNN`/machines/<slug>.json」，而 `run-NNNN` 由 `VariantCaptureRunner` 扫 `_dataset/run-*` 取 max+1 自增 ——
> **不复位产物目录，两次运行的产物必然不同（只差那一个 run 号）**。实测对比：同一台 BBF 的两轮产物内层 20,122 B 完全一致，
> **唯一差异**就是 `run-0003` vs `run-0004`。故外层脚本在起客户端前**先保全上一轮（`.out/_prev-<label>/exports`）再清空产物目录**，
> 使每轮都是 `_dataset/run-0001` → notes 稳定 → 逐字节可复现。
> 代价是失去 T1.3 内部"与上一次运行自动比对签名"；管线层的两次运行哈希比对是更强的替代（判据见 §6.4 与 §7 开放项 1）。

### 4.2 自检 2 — 故意制造失败：退出码非零 + 原因落盘

`pwsh -File scripts/multiblock-pipeline/run-pipeline.ps1 -Label fail-demo -Scope MTENoSuchMachineT16`：

| 项 | 值 |
|----|----|
| 管线 `status` / `exitCode` | `has-failures` / **`2`** |
| 外层脚本退出码 | **`2`**（`exit $result.exitCode`；嵌套 pwsh 实测正确传递） |
| 客户端进程 | gradle 包装进程退出码 **1**（`runClient` 以 2 退出 → `JavaExec` 判失败 → gradle 以 1 收尾）；日志实证 `Java has been asked to exit (code 2) by cpw.mods.fml.common.FMLCommonHandler.exitJava` |
| 产物 | 0 份 |
| 失败条文 | 3 条（`inScopeFailures` 1 + `outOfScopeFailures` 2 + 管线级 0） |

落盘的原因（`pipeline-result.json.failures[]`，逐条含 `machine/stage/kind/message`）：

```json
{ "machine": "MTENoSuchMachineT16", "stage": "scope", "kind": "UnknownMachine",
  "message": "T1.2 枚举数据里找不到该多方块（既不匹配 simpleName、fqcn，也不匹配 slug）" }
```

**结论**：非零退出码 **且** 原因落盘 **且** 原因可机器定位（`stage=scope / kind=UnknownMachine`）——"静默跳过"被排除。

### 4.3 自检 3 — 展开校验文件 vs 产物经 `lib.mjs` 装配：逐格 diff = 0

`node scripts/multiblock-pipeline/verify-expanded.mjs scripts/multiblock-pipeline/.out/t16-idem-2/exports`（退出码 0）：

| 机器 | 抽样组合 | 变体总数 | 比对格数 | **diff** | 签名塌缩（已知盲区） |
|------|--------:|--------:|--------:|--------:|----:|
| `mteelectricblastfurnace` | 8 | 420 | 288 | **0** | 3 |
| `mtedistillationtower` | 8 | 220 | 576 | **0** | 5 |
| `mtebrickedblastfurnace` | 2 | 2 | 72 | **0** | 1 |
| `mtequantumforcetransformer` | 9 | 200 | 42,525 | **0** | 1 |
| `mteadvebf` | 8 | 420 | 288 | **0** | 6 |
| **合计** | **35** | 1262 | **43,749** | **0** | 16 |

```
✅ 全绿：全部抽样组合装配成功且逐格 diff = 0（full 与 idMeta 两个口径都 0）
```

**同一批产物的更强全量闭环**（T1.4/T1.5 的既有校验器，覆盖**全部 1262 个变体**而不只是抽样）：

```powershell
node scripts/multiblock-encode/verify-encoded.mjs <exports> <exports/_dataset/run-0001>
→ 5 份产物覆盖变体 1262 / 数据集 1262；逐格 diff 合计 0；退出码 0
```

**契约校验器**（T0.5）：

```powershell
node scripts/multiblock-fixtures/validate-multiblock-fixtures.mjs <5 份产物>
→ ✅ 全绿（失败 0 / 警告 2）；警告 = 两条良性 `illegal/no-channel`（BBF/DT 无替换型通道，与 T1.5 同口径）
```

### 4.4 自检 4 — 两次运行的总耗时（Phase 3 编排预算）

| 运行 | 总耗时 | 进世界 | 导出（T1.5 `run()`） | 其中捕获（T1.3） | 其中编码（T1.4） | 变体 | 单变体 |
|------|------:|------:|------:|------:|------:|------:|------:|
| `t16-idem-1` | **154.0 s** | 7.0 s | 146.4 s | 145.1 s | 1.19 s | 1262 | 115 ms |
| `t16-idem-2` | **147.8 s** | 6.6 s | 140.6 s | 139.4 s | 1.13 s | 1262 | 111 ms |
| `t16-fail-demo` | 99.2 s | 7.5 s | 91.2 s | 91.1 s | 0.00 s | （见 §6.5 空范围白跑） | — |

**给 Phase 3 的预算结论**：客户端**进程总时长 ≈ 3.5 min**，其中
**JVM + 79 个 mod + 贴图图集加载 ≈ 62 s**（实测：进程 210 s − 管线 147.8 s；冒烟轮 72 s − 管线 8.2 s ≈ 64 s，两条独立佐证），
进世界 6.6–7.5 s（已含在管线总耗时内），导出 ≈ **110–120 ms/变体**（本子集；T1.5 实测全量均值 279.5 ms/变体，因为含 LSC/PowerSubStation 这类慢机）。
→ **默认子集单轮 ≈ 2.5 min 管线 + 1 min 启动**，Phase 3 的"小子集快速迭代 + 全量终验"完全可行。

---

## 5. 展开形态校验文件（留白 #10）：格式、抽样清单、与 web diff 工具的对齐口径

### 5.1 与 `web/e2e/helpers/multiblock/referenceGrids.ts` 的对齐口径（逐条）

先读该文件确认口径（其文件头注释就是契约），逐条对齐如下：

| 口径 | `referenceGrids.ts` 的约定 | T1.6 展开文件 | 对齐方式 |
|------|---------------------------|---------------|----------|
| 文件形状 | `ReferenceGridFile = { variant, dims:{w,h,d}, cellGrid }` | **同三个字段同名同义**，另加 `schema/machine/values/totalTier/runstate/why/coordinateConvention/palette` | 直接兼容：`{variant, dims, cellGrid}` 是超集里的同名字段 |
| 文件命名 | `${fixtureFile 去 .json}__${variantKey 里 \|/: → _}.json` | `${slug}.multiblock__${variantKey 里 \|/: → _}.json` | **一字不差**（`referenceFileBase(slug + '.multiblock.json', key)` 直接可用） |
| 坐标朝向 | `cellGrid[z][row][x]`，**row 0 = 结构顶部**，世界 Y = `height-1-row`，**不做任何翻转/转置** | **完全相同**（直接取 T1.3 数据集的 `variants[].grid.cellGrid`，与 `lib.mjs#assembleVariant` 的 `[z][y][x]` 同一朝向） | 无需翻转；若朝向本来不一致，diff 会立刻变红 —— 这正是想要的 |
| 下标空间 | 参考侧指向**并集调色板**；渲染侧指向**重编号后的调色板**；两边不同 | `palette.indexSpace = "global-union"`（= `_dataset/run-NNNN/palette.json#blockPalette`，0 = air） | 两边下标空间**必然不同**，故对齐只能走内容签名 |
| 对齐方式 | **内容签名** `canonicalJson(entry)`（对象键排序、数组保序），两边各建"下标 → 签名"表再逐格比签名 | 每份文件内联 `palette.signatures`: `{ "<全局下标>": "<canonicalJson(entry)>" }`（**只含本网格用到的下标**） | 逐格比对时把全局下标经签名映射到产物下标空间；**映射不上 = 硬失败**（绝不当作 air 放过） |
| 两种口径 | `full`（非门禁强证据）/ `idMeta`（门禁，`name:meta`，air → `''`） | 两者都算、都要求 = 0 | 见 §4.3：`full` 与 `idMeta` 都 0 |
| 已知盲区 | `signatureCollapsed`：参考里"不同 full 签名 / 同 `name:meta`"的条目对（渲染侧按 `name:meta` 归并，必然合并） | 报告里逐台给出 `signatureCollapsed` 计数（本批 16 对） | 如实记录，不掩盖 |

> **踩坑（值得写进 T3.3 的交接）**：`canonicalJson` 在 Java 侧**不能**直接用 Gson 的
> `JsonPrimitive#toString()`：数据集里写的是 `"u":1.0`，Gson 原样返回 `"1.0"`，而 JS 解析成 1 后 stringify 成 `"1"` ——
> 4189 vs 3949 字节的签名差异**全部**来自这里（首轮自检 3 因此整片报红）。
> 现已按 JS 的 Number→String 规则输出（整数去 `.0`、指数转十进制、`-0`→`0`、NaN/Inf → `null`）。

### 5.2 每份展开文件（`expanded/<slug>.multiblock__<variant>.json`）

```jsonc
{
  "schema": "lightning.multiblock.expanded/1",
  "variant": "coil:14|tt:1|runstate:idle",        // 与 referenceGrids 的 variant 同字段
  "dims": { "w": 3, "h": 4, "d": 3 },            // 同 referenceGrids 的 dims
  "cellGrid": [ [ [ 0, 0, 0 ], "…" ] ],          // [z][row][x]，row 0 = 顶部，全局并集下标
  "machine": { "slug": "…", "id": "gregtech:metaTileEntity_electricBlastFurnace", "displayName": "…", "sourceClass": "…" },
  "values": { "coil": 14 }, "totalTier": 1, "runstate": "idle",
  "why": [ "channel:coil=max(domain.max=14) → coil:14|tt:1|runstate:idle [hit=coil:14, runstate=idle, tt=1, 精确命中]" ],
  "coordinateConvention": "cellGrid[z][row][x]；row 0 = 结构顶部；世界 Y = height-1-row；不翻转不转置",
  "palette": {
    "indexSpace": "global-union",
    "entryCount": 57,
    "signatures": { "0": "{\"geometry\":…}", "1": "{\"geometry\":…}" },   // 只含本网格用到的下标
    "labels":     { "1": "gt.blockmachines@1000" }                        // 人读标签，报告/失败信息用
  }
}
```

> **刻意不写** `palette.json` 的路径/哈希：数据集目录名带 `run-NNNN`，写进去就把"两次运行产物逐字节一致"毁掉。
> 逐份文件自带用到的签名即自洽可校验；"数据集中立来源 + 整份 palette 的 SHA-256"写在 `_manifest.json` 里（清单本就带时间戳，不参与字节比对）。

### 5.3 抽样清单（`expanded/_manifest.json`，同时内联进 `pipeline-result.json.expanded.sampleList`）

**抽样策略（确定性，同一输入两次运行得到同一清单、同一文件字节）**：
每条具名通道的**最小取值**（0 = 未设置）与**最大取值**（`domain.max`）各一例 + **每个运行态一例** + **N 组伪随机组合**
（N = `expanded.randomSamples`，默认 5；伪随机用自定义 LCG，种子 = slug 的 FNV-1a → 跨 JVM/平台确定，与 `java.util.Random` 无关）。
选值用"目标越近越好"的最小代价搜索，因此**被 T1.5 收窄过域 / 抽样过总 Tier 的机器也能选到真实存在的组合**，
且每条 `why` 会记录命中的实际取值与是否**精确命中**（就近匹配会同时进 `warnings`）。

**默认子集实测清单（35 条）**：

| 机器 | 通道 | 运行态 | tierSample | 变体总数 | 抽样 | 抽样键（`why` 摘要） |
|------|------|--------|-----------|--------:|-----:|---------------------|
| `mteelectricblastfurnace` | `coil:replace 0..14` | idle/active | 1..14 | 420 | **8** | `coil:0\|tt:1\|idle`(min)、`coil:14\|tt:1\|idle`(max)、`coil:0\|tt:1\|active`(runstate)、`coil:7\|tt:12\|idle`、`coil:2\|tt:4\|idle`、`coil:11\|tt:12\|active`、`coil:10\|tt:12\|active`、`coil:8\|tt:8\|idle`（random#1–5） |
| `mtedistillationtower` | `height:dimension 0..10` | idle/active | 1..10 | 220 | **8** | `height:0\|tt:1\|idle`(min)、`height:10\|tt:1\|idle`(max，尺寸 3x12x3)、`height:0\|tt:1\|active`、`height:0\|tt:7\|active`、`height:0\|tt:6\|active`、`height:8\|tt:8\|idle`、`height:7\|tt:10\|idle`、`height:8\|tt:8\|active` |
| `mtebrickedblastfurnace` | （无通道，仅总 Tier） | idle/active | 1 | 2 | **2** | `tt:1\|idle`（= idle 运行态 + random#2/#3 合并）、`tt:1\|active`（= active 运行态 + random#1/#4/#5 合并） |
| `mtequantumforcetransformer` | `manipulator 0..4`、`shielding 0..4` | idle/active | 1..4 | 200 | **9** | `manipulator:0\|shielding:0\|tt:1\|idle`(两通道同时取 min)、`manipulator:4\|shielding:0\|tt:1\|idle`(max)、`manipulator:0\|shielding:4\|tt:1\|idle`(max)、`…\|idle`→`active`、+ 5 组 random（1 组与已存在的键合并） |
| `mteadvebf` | `coil:replace 0..14` | idle/active | 1..14 | 420 | **8** | 同 EBF 结构（`coil:0` min / `coil:14` max / active / 5 random） |

**覆盖策略是机器判据，不靠人看**：`verify-expanded.mjs` 会对每台逐通道断言
「抽样里存在 `values[ch] == 0`（最小）与 `values[ch] == domain.max`（最大）」，并对每个声明运行态断言"至少一例" ——
任一不满足即硬失败。本批 5 台全部通过（见 §4.3）。

---

## 6. 环境坑与实测踩坑（三条计划点名 + 两条本轮新发现）

### 6.1 CoFH MCP conf（T0.3 §4.4(1)）—— 做成**进程启动前**的硬前置

`cofh.asm.LoadingPlugin.<clinit> → ObfMapping$MCPRemapper.confDirectoryGuess → JFileChooser.showDialog`：
找不到 MCP conf 会弹 Swing 目录选择框，**启动阶段静默挂住且日志无输出**（事后无从诊断）。
两条防线：

1. **外层脚本前置检查**（唯一能在进程启动前拦住的地方）：扫 `%USERPROFILE%\.gradle` 与 `%GRADLE_USER_HOME%` 下的
   `caches/minecraft/net/minecraftforge/forge/*/unpacked/conf`，判据不是"目录存在"而是**目录里真有 `*.srg`**
   （只建空目录同样会让 CoFH 走进弹框分支）。不满足 → 打印处置建议并以退出码 3 结束，**不启动客户端**。
2. **mod 侧**（`SdeMultiblockPipelineConfig.checkCohfConf()`）：同样口径的纯文件系统检查，结果写进
   `pipeline-result.json.environment.cofhConfCheck`（含全部候选路径 + `candidatesWithoutSrg`），便于事后审计。
   本机实测：`ok=true found=C:\Users\<user>\.gradle\caches\...\1.7.10-10.13.4.1614\unpacked\conf`。

### 6.2 FML 确认框（T0.3 §4.4(2)）—— `-Dfml.queryResult=confirm` **双重**注入

- **JVM 参数**：gradle task `runClientSdePipeline` 在只有它被请求时给 `runClient` 注入 `-Dfml.queryResult=confirm`；
- **进程内兜底**：管线首次接管 tick 时若 `System.getProperty("fml.queryResult") == null` 就补设（`StartupQuery` 读的正是这个属性），
  保证换启动方式也不会退回死锁路径。两项都写进结果文件（`environment.fmlQueryResult`），缺失时同时落 `warnings[]`。

### 6.3 **新发现**：`Runtime.halt` 会被 FML 的安全管理器静默拦掉 → 退出码不生效

首轮冒烟（故意失败场景）暴露出：结果文件写的是 `exitCode=3`，但**客户端进程仍以 0 退出**，日志里只有一句
`cpw.mods.fml.relauncher.FMLSecurityManager$ExitTrappedException`。
根因（读源码实证）：`FMLSecurityManager.checkPermission` 对 `exitVM` 权限只放行
`cpw.mods.fml.*` 与 `Minecraft` 自身发起的请求，其余一律 `throw new ExitTrappedException()`；
而 `Runtime.halt(int)` **也会**先走 `SecurityManager.checkExit` → 自定义类里的 halt 被拦。
**处置**：改用 `FMLCommonHandler.instance().exitJava(code, false)`（从 `cpw.mods.fml.common` 发起，在放行名单内），
`code == 0` 时走 `Minecraft.shutdown()` 正常收尾；两条路都挂安全网线程调 `exitJava(code, true)`（真 halt）。
修复后实测：`Java has been asked to exit (code 2) by cpw.mods.fml.common.FMLCommonHandler.exitJava`，gradle 包装进程退出码 1。

### 6.4 **新发现**：T1.5 产物里带自增的 `run-NNNN` 引用 → 不处理则"逐字节幂等"永远不成立

见 §4.1 的实测对比。处置：外层脚本在起客户端前**保全上一轮 + 清空产物目录**，使每轮都是 `_dataset/run-0001`。
这是本轮为满足"产物字节一致"这一硬要求所做的最小干预，**没有改动 T1.5 任何文件**。

### 6.5 **新发现**：请求范围为空时 T1.3 会白跑一次默认目标集

故意失败轮（`scope = [MTENoSuchMachineT16]` → 过滤后范围 0 台）里，
`SdeMultiblockConfig.parseScope` 得到的空清单被 `VariantCaptureRunner.Config.machines` 当作**默认目标集**，
捕获了 **4 台 / 842 变体 / 91.1 s**（`_dataset/run-0001/machines/` 里是 `mtebrickedblastfurnace`/`mtedistillationtower`/
`mteelectricblastfurnace`/`mtequantumforcetransformer`），但编码阶段按 `scope`（0 台）遍历 → **0 产物**。
管线**不因此判成功**（`UnknownMachine` 已落失败 → 退出码 2），但白跑 91 s。
属 T1.5/T1.3 的边界行为（本任务写范围外），已登记为开放项。

---

## 7. 开放项与风险

| # | 项 | 影响 | 建议处置 |
|---|----|------|----------|
| 1 | **T1.5 产物含自增 `run-NNNN` 引用**（`multiblock.notes[0].text`） | 不在产物目录上做复位，同一世界同一范围的两次运行产物**必然**不同（只差一个 run 号）→ 逐字节幂等无法成立 | 根治（属 T1.5/T1.3，本任务写范围外）：把数据集来源写成**与 run 号无关**的形态（如 `_dataset/machines/<slug>.json`），或把 run 号从产物里去掉。当前管线用"每轮复位产物目录到 run-0001"绕过 |
| 2 | **T1.2 枚举 slug 碰撞被算作 T1.5 失败（每次读枚举都落 2 条）** | `export-report.json.status` 恒为 `has-failures`；若直接拿它当门禁，任何子集都永远非零 | 本管线按「与请求范围是否相关」分列（`inScopeFailures`/`outOfScopeFailures`），**一条都不隐藏**（`failures[]` 原样保留）。根治仍在 T1.2 的 slug 消歧（T1.5 开放项 5） |
| 3 | **范围为空时白跑默认目标集 91 s**（§6.5） | 故意失败/全部失败场景浪费时间；不误导判定 | T1.5 在 `filterScope` 后若 `scope.isEmpty()` 就短路捕获（本任务写范围外） |
| 4 | **`ServerBranchNotExecuted` 等变体级断言噪声**（T1.5 开放项 6） | 若默认子集混进这类机器，`status` 会变 `has-failures`（本管线的门禁口径 = T1.5 的 `failureCount`） | 默认子集按"T1.5 实测零失败"挑选（风险 7 裁决）即为规避；结果文件已提供 `variantWarnings`（按 kind 只读聚合）便于 T1.5 落地"变体警告 vs 产物失败"分列后管线自动跟进 |
| 5 | **`/sde multiblock limit=N` 在 T1.5 里实际不生效** | 命令把 `SdeMultiblockConfig.maxExportMachines = limit`，但 `MultiblockExportRunner.run` 开头又 `SdeMultiblockConfig.load(cfg)` 把它覆盖回配置值 | 属 T1.5（本任务写范围外）。本管线默认不用 `limit`；`-Limit` 参数保留但**分片请改用 `-Scope`**（已验证生效） |
| 6 | **全量（`-All`）单次不可行**（计划风险 7） | 默认配置 ≈ 32 h、不裁剪 ≈ 431 h（T1.5 §3.5 实测外推） | **需用户裁定**：子集验收（已具备）/ 分片并行（`-Scope` 分片）/ 下调 `maxVariantsPerMachine`。管线只做时长守卫（`-ProcessTimeoutMinutes`），不阻止 |
| 7 | **客户端启动耗时（≈50 s）与导出耗时同量级** | 小子集迭代时启动开销占比高（5 台 2.5 min 里约 1 min 是启动） | Phase 3 若需多组对照，优先在**一次进程内**用多条命令（T1.5 的命令路径支持同一会话重复执行）；本任务未做（T1.6 的完成定义是"启动 → 导出 → 退出"） |
| 8 | **专用世界会在 `run/client/saves/` 留下存档** | 占用磁盘（约 1–2 MB）；不影响产物 | 已在 `run/`（gitignore）内；`-World <name>` 可换名。若需清理，删 `saves/sde_pipeline_world` 即回到"首轮创建"路径（幂等仍成立，已实测同世界复用与新建两条路径） |

---

## 8. 产物清单与复现命令

### 8.1 代码 / 脚本（全部在写范围内）

| 路径 | 说明 |
|------|------|
| `mod/gtnh/src/main/java/com/lightning/mod/config/SdeMultiblockPipelineConfig.java` | **新增**：默认验收子集、专用世界常量、预算、退出码、CoFH conf 前置检查（纯 JDK，零 MC 依赖） |
| `mod/gtnh/src/main/java/com/lightning/mod/client/multiblock/MultiblockPipelineAutomation.java` | **新增**：tick 状态机（进世界 → 发命令 → 等导出 → 收尾 → 退出码） |
| `mod/gtnh/src/main/java/com/lightning/mod/client/multiblock/MultiblockExpandedVerifier.java` | **新增**：展开形态校验文件 + 抽样清单写出（留白 #10） |
| `mod/gtnh/src/main/java/com/lightning/mod/client/automation/SdeClientAutomationTickHandler.java` | **改 +24 行**：顶部一个管线分派分支 + 一个 `ClientChatReceivedEvent` 记录钩子（触发文件不存在时零行为变化） |
| `mod/gtnh/build.gradle.kts` | **改**：`runClientSdePipeline` 任务（只在它被请求时给 `runClient` 注入 `-Dfml.queryResult=confirm`） |
| `package.json` | **改**：`multiblock:export` / `multiblock:selfcheck` / `multiblock:verify-expanded` / `multiblock:compare-runs` |
| `.gitignore` | **改**：登记 `scripts/multiblock-pipeline/.out/` |
| `scripts/multiblock-pipeline/run-pipeline.ps1` | **新增**：外层编排（前置检查 → 触发文件 → 客户端 → 结果 → 归档 → 退出码） |
| `scripts/multiblock-pipeline/selfcheck.ps1` | **新增**：四项自检一条命令 |
| `scripts/multiblock-pipeline/verify-expanded.mjs` | **新增**：展开 vs 装配逐格 diff（T3.3 直接复用） |
| `scripts/multiblock-pipeline/compare-runs.mjs` | **新增**：两次运行产物/展开文件哈希对比（幂等判据） |
| `docs/plan/probe-export-pipeline.md` | 本报告 |

**未改**：`web/`、`protocol/`、`CommandSde.java`、`SceneEnvelopeBuilder.java`、T1.5 的任何文件
（`MultiblockExportRunner` / `MultiblockExportAutomation` / `MultiblockFactorizer` / `MultiblockDatasetCodec` / `VariantCaptureRunner` /
`MultiblockScanAutomation`）、`client/meshcapture/`、`LightningMod`。未 `git commit`。
（`git status` 实证：4 个 modified + 4 个新增文件/目录。）

### 8.2 证据产物（`scripts/multiblock-pipeline/.out/`，gitignore）

| 路径 | 说明 |
|------|------|
| `selfcheck-report.json` | 四项自检的机读汇总（checks + timing） |
| `t16-idem-1/`、`t16-idem-2/` | 两次幂等运行的归档：`exports/`（5 产物 + `expanded/`(35 文件+清单) + `_dataset/run-0001/` + `export-report.json` + `pipeline-result.json` + `verification-report.json` + `expanded/expanded-verification-report.json`）+ `gradle-runClient.log` |
| `t16-idem-2/validation-report.t16.txt` / `.json` | 契约校验器输出（失败 0 / 警告 2） |
| `t16-fail-demo/` | 故意失败运行归档（退出码 2 + 失败原因） |
| `_prev-<label>/exports` | 每轮复位前的上一轮产物保全（证据，不丢） |
| `mod/gtnh/run/client/sde_multiblock_pipeline_result.json` | 结构化结果的**稳定路径**（外层脚本读它） |

### 8.3 复现（全部零人工交互）

```powershell
# ① 构建
cd mod\gtnh; .\gradlew.bat build; cd ..\..

# ② 四项自检一条命令（≈ 9 min：两次幂等 + 一次故意失败 + 两个离线校验器）
npm run multiblock:selfcheck

# ③ 单轮导出（默认子集）
npm run multiblock:export -- -Label my-run

# ④ 离线逐格 diff（对归档目录）
node scripts\multiblock-pipeline\verify-expanded.mjs scripts\multiblock-pipeline\.out\t16-idem-2\exports

# ⑤ 幂等哈希对比
node scripts\multiblock-pipeline\compare-runs.mjs `
  scripts\multiblock-pipeline\.out\t16-idem-1\pipeline-result.json `
  scripts\multiblock-pipeline\.out\t16-idem-2\pipeline-result.json

# ⑥ 与 T1.4/T1.5 全量闭环 + 契约校验器（抽样之外的更强证据）
node scripts\multiblock-encode\verify-encoded.mjs `
  scripts\multiblock-pipeline\.out\t16-idem-2\exports `
  scripts\multiblock-pipeline\.out\t16-idem-2\exports\_dataset\run-0001
$f = Get-ChildItem scripts\multiblock-pipeline\.out\t16-idem-2\exports\*.multiblock.json | % FullName
node scripts\multiblock-fixtures\validate-multiblock-fixtures.mjs @f
```

### 8.4 事实勘误与登记

- 计划 §T1.6 的"导出完成后自动退出（或有明确的完成信号文件）"→ **两者都做**：结果文件（完成信号）+ 自动退出 + 退出码。
- 计划 §9 留白 #7 → **专用干净世界**（§1.1）；#8 → **gradle task + 根 npm script 两层**（§1.2）；
  #10 → **`{variant,dims,cellGrid}` 超集 + 内联内容签名 + 抽样清单**（§5），与 `referenceGrids.ts` 同字段同朝向、命名规则一字不差。
- 风险 7（全量耗时）→ 本任务**只给裁决建议**：默认子集 = T1.5 实测零失败的 5 台代表机；全量仍需用户裁定（§7 开放项 6）。
  Phase 3 的编排预算已实测：默认子集单轮 **≈ 2.5 min**（2 min 导出 + 1 min 启动/进世界）。
- 本轮新增的三条实测事实（FML 拦 `exitVM`、`run-NNNN` 破坏幂等、空范围白跑默认目标集）已分别写进 §6.3/§6.4/§6.5，
  其中前两条已在本任务范围内处置完毕，第三条登记为 T1.5/T1.3 的开放项。

---

## 9. 修复记录（后续任务追加）：`thumbnailPNG` 不确定性 → 自检 1 原是「碰运气」

> **来源**：调度者独立复跑 T1.6 自检 1 时擒获 —— `t16-idem-1` vs `t16-idem-2` 的产物**并非**逐字节一致：
> 剥离 `thumbnailPNG` 后内层 JSON 逐字节相同，9/14 条条目的缩略图不同；展开校验文件同样只在 `thumbnailPNG` 上不同。
> **完整报告**：`docs/plan/fix-thumbnail-determinism.md`（根因、裁决、修复点、5 次运行幂等证据、
> `/sde export` 字节级不变证据、体积收益、开放项）。

**一句话结论**：`thumbnailPNG` 是 GPU 渲染的方块缩略图（`BlockThumbnailRenderer`），跨运行像素不稳定；
它进了 `GeometryPalette` 的条目 ⇒ 同时破坏「产物逐字节幂等」与「展开签名 `canonicalJson(条目)` 的跨运行对齐」。
**裁决：multiblock 导出路径不再产出 `thumbnailPNG`**（主产物调色板条目与展开校验文件一律不写；
`/sde export`（wiki）路径一字不动）。

**本轮 §4.1 的"5/5 产物 + 35/35 展开文件逐字节一致"应按下述口径重读**：该结论在**修复前**是概率性的
（同一脚本重跑就可能红）。修复后（本记录追加时）已用 **5 次无人值守运行**重新验证：
主产物 5/5、展开文件 35/35 跨 5 轮**逐一 SHA-256 相同**，且 `idem-1/idem-2/i3/i4/i5` 的**跨轮两两比对**全部退出码 0
（`compare-runs.mjs`），`npm run multiblock:selfcheck` 仍全绿（含自检 3 的 43,749 格 diff = 0）；
同时 `/sde export` 在**修复前 2 次 + 修复后 1 次**共 3 次运行下产物 SHA-256 完全相同（含 2,467 B 缩略图 base64）。
**副作用**：默认子集主产物 444,336 B → 319,164 B（−28.2%），展开校验文件 −22.4%，数据集 `palette.json` −17.4%；
捕获耗时**无**实测收益（落在运行间噪声内，不夸大）。

**新增开放项**（详见修复报告 §10）：① 若将来要缩略图，须用**确定性软件光栅**另行立项；
② `docs/contracts/format-multiblock-doc.md` §6.3 的「`thumbnailPNG` 原样进条目」政策与本修复冲突，需契约 owner 改写；
③ 展开签名口径是「条目全文」，跨年代（含/不含缩略图）产物不可混用（本修复刻意不改签名定义，避免第二套口径）。
