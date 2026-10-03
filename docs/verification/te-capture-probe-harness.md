# TE 捕获探针验证回路（可复用验证基础设施）

> **本文是什么**：一条**可复用的游戏内验证回路**的规则、约定、how-to 与判据 —— 用来验证「`/sde export`
> 的捕获路径对世界/活动 TE 的副作用」、「某 mod 的方块/TE 能否被捕获」这类**只能在全量客户端里问出答案**的问题。
> **首个实例**：Gitea issue #12（LP 管道 TE 被就地 NBT 往返改坏 → 导出后客户端渲染 NPE 崩溃），
> 修复见提交 `e9f0bf3`（4 文件：`dependencies.gradle`、`MeshCaptureService.java`、
> `MultipartNbtStateUtil.java`、`MeshCaptureBlockPostRenderContext.java`）。
> 本文只讲**怎么复用**，不记过程流水；issue #12 全程只作为贯穿示例。
>
> **行号约定**：除显式标注外，所有 `file:line` 都取自本工作树 `branches/bug-fix` **修复提交 `e9f0bf3` 之后**的文件。
> 侦察报告 `state/issue-12/probe-infra-recon.md` 与 `state/issue-12-body.md:67-68` 的行号取自修复前文件（同一份代码已整体后移），
> 引用时以本文核对过的行号为准。

---

## 1. 用途与适用范围

| 项 | 内容 |
|---|---|
| **适用** | ① 验证捕获路径对**世界状态 / 活动 TileEntity** 的副作用（改坏、泄漏、回滚不回来）；② 验证**某个 mod 的方块或 TE 能否被捕获**（几何、NBT、TESR 路径是否可达）；③ 任何**必须走真实 `MeshCaptureService.finalizeStructureJson`** 的断言 |
| **不适用** | 只关心假世界几何/变体的捕获（`ProbeDummyWorld` 有**自带**捕获循环，见 §3.1）；纯 JVM 无头单测（捕获需要活的 GL 上下文，见 §3.3）；只想测「导出产物字节幂等」而与被捕获世界状态无关的场景 |
| **硬前提** | 必须能在 `runClient` 进程内执行（§3.3）；被捕获方块必须真实存在于 `mc.theWorld`（§3.1）；被断言的世界状态必须能在**捕获前后各读一次**（§4.3） |
| **首个实例** | issue #12：`/sde export` 为渲染 TESR 就地做 `writeToNBT`/`readFromNBT` 往返，LogisticsPipes 的 `readFromNBT` 非幂等（每次重建 pipe，`bindPipe()` 有一次性守卫 `pipeBound`），活动 TE 的 `pipe.container` 永久为 null ⇒ 导出结束恢复渲染即 NPE 崩溃（`state/issue-12-body.md:62-79`）。修复改为按扫描 NBT 造**副本 TE**，活动 TE 全程零写入 |

**判据纪律（本回路的存在意义）**

1. **没有负对照的绿不算绿**。任何「修复有效」的结论都必须配上「把修复关掉 → 断言变红」的一轮实测；
   本回路的负对照开关是 `-Dsde.teCaptureMode=inplace`（§4.4）。
2. **被测对象没到位就判失败退出**，不许拿「缺陷没触发」冒充「修复有效」（`LpTeRoundTripAutomation.java:610-628` 的前置校验即此）。
3. **断言必须能落到结构化结果文件**，再由外层脚本转成退出码；日志只能作为特征行，不作判据本体（§4.3、§6）。

---

## 2. 如何引入运行时依赖（以 LogisticsPipes 为例）

### 2.1 依赖形态：只进运行期，不进编译期

```gradle
// mod/gtnh/dependencies.gradle:70
runtimeOnlyNonPublishable("com.github.GTNewHorizons:LogisticsPipes:1.5.28-GTNH:dev")
```

| 规则 | 理由 | 出处 |
|---|---|---|
| 用 `runtimeOnlyNonPublishable` | 只给 dev 客户端装配，不写发布 POM；验证目标是「不引入 compile 耦合」 | `dependencies.gradle:61-62`、`:70`；裁决 A5（`state/issue-12/adjudications.md:13`） |
| **不加** `compileOnly` / `implementation` | 探测代码一旦 import 该 mod 的类，编译期就真耦合了，且换版本即编译失败 | `LpPipeReflect.java:24-27` |
| 验证代码**一律反射**触达 | `compileClasspath` 不含该 mod；反射失败要落盘候选清单，不静默替换 | `LpPipeReflect.java:54-60`、`:129-138` |

### 2.2 仓库

- 本树 `settings.gradle.kts:1-15` 里**显式声明**的是 pluginManagement 侧的
  `https://nexus.gtnewhorizons.com/repository/public/`；工程级依赖仓库本树未另行声明，
  由 `com.gtnewhorizons.gtnhsettingsconvention`（`settings.gradle.kts:18`）提供
  （该归属为代码阅读结论，非实测；**实测**的是 LP 坐标确实能从该仓库解析，见 §2.4）。
- **一律用 `nexus.gtnewhorizons.com`**。`maven.gtnewhorizons.com` 的 SSL 故障**未确证**（本次未复测），
  不作为可用坐标写入任何文档或脚本。
- 验证一个坐标真的存在，最省事的判据是直接抓它的 Gradle 模块元数据：
  `https://nexus.gtnewhorizons.com/repository/public/<group 路径>/<artifact>/<ver>/<artifact>-<ver>.module`
  （本文编写时对 LP `1.5.28-GTNH` / `1.5.36-GTNH` 各抓一次均 HTTP 200）。

### 2.3 版本选择纪律：先看 `.module` 的 `dependencyConstraints`，别顶破已锁定基线

**规则**：引入任何 dev 期 mod 前，先读它的 `.module`，把其中对**本树已有版本**的 `requires` 与
`dependencies.gradle` 里已锁定的版本对齐。**只有当新依赖的约束 ≤ 现有版本时才可以直接加**；若要抬高现有版本，必须先裁决。

**实测判例（issue #12 的 A4 裁决）**：

| 候选 | 该版本对 GTNHLib 的 `dependencyConstraints` | 对本树的影响 | 结论 |
|---|---|---|---|
| **1.5.28-GTNH** | `GTNHLib` requires `0.9.36` | 本树已解析 `0.9.62`（`dependencies.gradle:26`）≫ 0.9.36 ⇒ **不抬高** | **采纳**（且 issue 字节码核对用的就是 1.5.28） |
| 1.5.36-GTNH | `GTNHLib` requires `0.11.37` | 会把已锁定的 `0.9.62` 顶到 `0.11.x`，打破 GT5U 5.09.52.283 的编译基线 | 弃用 |

出处：`dependencies.gradle:64-67`；裁决 A4（`state/issue-12/adjudications.md:12`）。
两个版本的约束差异由本文编写时抓取 `.module` 独立复核（见上表右列的值）。

**梯度一致性也要核**：换版本会连带改传递依赖（1.5.36 要 BuildCraft 7.1.63 / NEI 2.8.123 / ModularUI2 2.3.85 /
unimixins 0.3.1，1.5.28 是 7.1.60 / 2.8.100 / 2.3.72 / 0.2.1）。传递依赖带来的版本上移属于**待登记项**
（裁决 O6：NEI 2.8.93→2.8.100、ModularUI2 2.3.43→2.3.72），首轮 `runClient` 要扫 mixin / `NoSuchMethod` 报错。

### 2.4 验证依赖解析（两条命令，一正一反）

```powershell
cd mod\gtnh
# ① 正：运行期必须能看到目标 mod（及其传递依赖）
& <gradle> -q dependencies --configuration runtimeClasspath --offline --console=plain | Select-String 'LogisticsPipes|BuildCraft'
# ② 反：编译期必须看不到目标 mod（证明验证代码只能反射）——期望零命中
& <gradle> -q dependencies --configuration compileClasspath  --offline --console=plain | Select-String 'LogisticsPipes'
```

本文编写时的实测结果：① 命中 `com.github.GTNewHorizons:LogisticsPipes:1.5.28-GTNH` 与传递依赖
`com.github.GTNewHorizons:BuildCraft:7.1.60`；同一次解析里 GTNHLib 仍锁在 `0.9.62`
（`GTNHLib:0.9.36 -> 0.9.62`），与编译基线（`dependencies.gradle:26`）一致 —— 这就是「版本没有顶破基线」的可执行判据；
② 零命中（`compileClasspath` 共 85 行）。
「版本取 `runtimeClasspath` 的实际解析结果以保证编译期/运行期锁步」是本项目既有惯例，
出处 `dependencies.gradle:25`、`docs/plan/decision-deps-route.md:221`。

---

## 3. 捕获路径的硬事实

以下四条决定了回路**只能长成现在这个形状**；任何「换成假世界/换离线单测/只写 registryId」的方案都会测不到缺陷。

### 3.1 捕获世界被硬编码为 `Minecraft.getMinecraft().theWorld`

```java
// mod/gtnh/src/main/java/com/lightning/mod/client/meshcapture/MeshCaptureService.java:451-453
World world = Minecraft.getMinecraft().theWorld;
if (world == null) {
    throw new IllegalStateException("finalize requires Minecraft.theWorld (client).");
}
```

⇒ **被捕获的方块必须真实放置在客户端世界（`runClient` 的集成服务端存档）里**，并已同步到客户端。

- **反证**：`ProbeDummyWorld` 喂不进这条路径，它只能给**自带捕获循环**的探针用
  （`client/multiblock/StateGeometryCapture.java`、`client/multiblock/VariantGeometryBakery.java`；
  侦察报告 §2.3 给出两处入口与循环行号）。那两处**没有** `writeToNBT`/`readFromNBT` 往返，
  用它们测「捕获改坏活动 TE」是测不到的。
- 假世界的能力边界（供对照，不是本回路的路线）：`ProbeDummyWorld.setBlock` 会走
  `block.createTileEntity` 造 TE（`ProbeDummyWorld.java:122`、`:162`），构造时 `isRemote = false`（`:100`），
  但 `updateEntities()` 是空实现（`:319`）⇒ 假世界里的 TE **不会自己 tick**，要用就得手动驱。

### 3.2 缺陷/TE 分支的进入条件是「扫描文档带 `tileNbtB64`」

```java
// MeshCaptureService.java:546          分支条件
if (teForCapture != null && vs != null && vs.tileNbt != null) {
// MeshCaptureService.java:1075-1082    唯一解析点（base64 + gzip）
NBTTagCompound tileNbt = null;
if (t.has("tileNbtB64")) {
    String b64 = t.get("tileNbtB64").getAsString();
    byte[] raw = Base64.getDecoder().decode(b64);
    tileNbt = CompressedStreamTools.readCompressed(new ByteArrayInputStream(raw));
}
```

⇒ **只写 `registryId`/`meta` 的探针永远触发不到 TE 往返路径**。

| 既有探针 | 合成 `cellTypes` 的地方 | 写了什么 | 后果 |
|---|---|---|---|
| `PartsExportProbe` | `PartsExportProbe.java:196`、`:222-223` | 只有 `registryId` + `meta` | 从未进入 `:546` 分支 |
| `PartsAcceptanceAutomation` | `PartsAcceptanceAutomation.java:761`、`:794` | 同上 | 同上 |

**探针侧的正确写法**（issue #12 的做法）：

```java
NBTTagCompound tag = new NBTTagCompound();
te.writeToNBT(tag);                                    // 与缺陷本体同一 API
ByteArrayOutputStream bos = new ByteArrayOutputStream();
CompressedStreamTools.writeCompressed(tag, bos);       // gzip（解码侧 readCompressed）
t.addProperty("tileNbtB64", Base64.getEncoder().encodeToString(bos.toByteArray()));
```

出处：`LpTeRoundTripAutomation.java:1138-1144`（快照口径）、`:1146-1151`（b64+gzip）、`:1176-1188`（写进 `cellTypes`）。
**注意**：捕获侧会给 NBT 补/覆盖 `x`/`y`/`z` 三个整数键（`MeshCaptureService.java:764-771`），
探针的 NBT 需带（或允许被覆盖）这三键。

### 3.3 捕获需要真 GL 上下文 ⇒ 只能在 `runClient` 内跑

| 证据 | 位置 |
|---|---|
| 捕获循环直接走 `Tessellator`：`Tessellator.instance` → `startDrawingQuads()` → `draw()` | `MeshCaptureService.java:564-576` |
| 主批次没产出四边形时走 `GL11.glPushMatrix()` + `rb.renderBlockAsItem(...)` | `MeshCaptureService.java:597-600`（`import org.lwjgl.opengl.GL11` 在 `:32`） |
| 顶点录制读 GPU/draw-mode 状态 | `client/meshcapture/TessellatorCaptureState.java:12`、`:415` |
| TESR 补捕获读模型视图矩阵并真正 `renderTileEntityAt` | `client/meshcapture/postrender/TileEntitySpecialRendererPostRenderStrategy.java:107`、`:122` |

⇒ **纯 JVM 无头跑不可行**；不要试图为它写单测。正确做法是「不创建上下文，而是搭在客户端进程里」——
所有自动化都挂在客户端 tick 分派点上（§3.4），进程由 `gradlew runClientSdePipeline` 拉起
（`mod/gtnh/build.gradle.kts:61-79`）。
**但「需要 GL」≠「需要世界」**：`RunStateProbeAutomation` 默认 `world=none` 即可在主菜单态捕获
（侦察报告 §3 末段）——世界是 §3.1 那条硬编码带来的额外要求。

### 3.4 探针触发链路（含顺序即优先级）

注册：`proxy/ClientProxy.java:33`（`FMLCommonHandler.instance().bus().register(new SdeClientAutomationTickHandler())`）。
分派：`client/automation/SdeClientAutomationTickHandler.onClientTick`（`:51-138`），**顺序即优先级，命中即 `return`**：

| 顺序 | 判断 | 行号 | 触发文件（在 `<mcDataDir>` 下） |
|---|---|---|---|
| 1 | `LpTeRoundTripAutomation.isRequested` | `:60-63` | `sde_lp_te_probe.json` |
| 2 | `MultiblockPipelineAutomation.isRequested` | `:68-71` | `sde_multiblock_pipeline.json` |
| 3 | `MultiblockScanAutomation.isRequested` | `:74-77` | `sde_multiblock_scan.json` |
| 4 | `RunStateProbeAutomation.isRequested` | `:80-83` | `sde_runstate_probe.json` |
| 5 | `PartsProbeAutomation.isRequested` | `:87-90` | `sde_parts_probe.json` |
| 6 | `PartsAcceptanceAutomation.isRequested` | `:94-97` | `sde_parts_acceptance.json` |
| — | 之后才是配置门控的通用自动化（`lightning.cfg`） | `:99-101` | — |

- 前 6 条**完全绕过** `lightning.cfg`：触发文件存在就接管 tick，不存在就**零行为变化**
  （各 `isRequested` 首行即 `triggerFile(mc).isFile()`，如 `LpTeRoundTripAutomation.java:176-193`）。
- 触发文件位置一律 `new File(mc.mcDataDir, <NAME>)`（`LpTeRoundTripAutomation.java:171-173`）；
  本树 `mcDataDir` 实测 = `mod/gtnh/run/client`（脚本侧同一路径：`scripts/issue-12/run-lp-te-probe.ps1:47`）。
- **新探针必须插到最前**：它自带专用世界与专用放置路径，排在既有探针之后会与它们抢世界
  （注册顺序的注释即此：`SdeClientAutomationTickHandler.java:58-59`）。

**一次会话的时序（issue #12 形态）**

| 阶段 | 做什么 | 关键出处 |
|---|---|---|
| `INIT` | 解析触发文件 + 补设 `System.setProperty("fml.queryResult","confirm")` | `LpTeRoundTripAutomation.java:301-363`、`:185-188` |
| `JOIN` | 进**专用世界** `sde_lp_te_probe_world`：`level.dat` 存在则复用，否则用 `WorldSettings(种子, CREATIVE, false, false, FLAT).enableCommands()` 新建，再 `mc.launchIntegratedServer(...)` | `:379-404`；世界名 `:78` |
| `WAIT_WORLD` | 等 `theWorld/thePlayer` 非 null 且 `currentScreen == null`，再等 `worldSettleTicks`（默认 40） | `:406-420`、`:140` |
| `TELEPORT` | 把服务端真玩家 `setPositionAndUpdate` 到基点（客户端要加载该区块才读得到 tile） | `:422-440`；基点 `64,12,64` `:153-155` |
| `PLACE` | 等 `chunkWaitTicks`（60）→ 在 `server.worldServers[0]` 用**目标 mod 自己的放置路径**放方块 | `:443-524`、`:141` |
| `WAIT_SYNC` | 等 `syncWaitTicks`（探针默认 60；脚本传 120） | `:526-532`、`:142`；脚本 `:33` |
| `PROBE` | 7 个分步（每步一 tick）：前置校验 → TESR 自检 → runA → runA 后快照 → runB → 最终断言 → 停留 | `:100-108`、`:536-576` |
| `DONE` | 落盘 → 删触发文件 → 停留 `postCaptureDwellTicks` → 按退出码退出 | `:1023-1037`、`:1436-1462` |

- **为什么要 `fml.queryResult=confirm`**：FML 的 `StartupQuery` 确认框在 Server 线程阻塞，而 `launchIntegratedServer`
  在 Client 线程 sleep 等世界 ⇒ 互等死锁。gradle 任务只在**自己被请求时**注入该属性
  （`mod/gtnh/build.gradle.kts:61-79`，唯一差异是 `:72`），探针另有进程内兜底（`:185-188`）。
- **整轮/单阶段预算**：探针 `TOTAL_TIMEOUT_MS = 12 min`、`PHASE_TIMEOUT_MS = 4 min`、退出安全网 60 s
  （`LpTeRoundTripAutomation.java:81-83`、`:1436-1462`）；外层脚本再给进程级超时（§5）。

---

## 4. 怎么搭验证探针（issue #12 实例 = 模板）

### 4.1 形状：一条独立 tick 状态机

| 要件 | 本实例取值 | 规则 |
|---|---|---|
| 触发文件 | `sde_lp_te_probe.json` | 一个探针一个触发文件，放 `<mcDataDir>` 根（`LpTeRoundTripAutomation.java:76`、`:171-173`） |
| 专用世界 | `sde_lp_te_probe_world` | 不加载玩家存档（含缺失 mod 的存档会走 `StartupQuery` 死锁，且会被改写）；幂等复用同一存档（`:78`、`:387-402`） |
| 结果文件 | `sde_lp_te_probe_result.json`（含 `status` / `exitCode` / `checks` / `pass`） | 游戏内**结构化**落盘，外层脚本只认这一个稳定路径（`:77`、`:1323-1334`） |
| 过程产物 | `_scan.json` / `_export.json` / `_export-runB.json` / `_exit.json` | 由 `artifactName(kind)` 统一命名（`:1474-1476`、`:640`、`:764`、`:840`、`:241`） |
| 注册位置 | `SdeClientAutomationTickHandler` **最前**（`:58-63`） | 否则与既有探针抢世界 |

### 4.2 放置路径必须走目标 mod 自己的 API（LP 判例）

LP 的管道 TE 绑定（`pipe` / `pipe.container`）只在 LP 自己的放置装配里完成：

```
createPipe(item)  →  world.setBlock(管道方块)  →  取 TE  →  initialize(pipe)  →  sendUpdateToClient()
```

出处：`parts/probe/LpPipeReflect.java:148-198`（该三步即 LP `LogisticsBlockGenericPipe.placePipe` 的实现，
类注释 `:30-36`、`:140-147` 标注了与 LP 源码的对应关系）。
补充要点：

- 管道**方块实例**不在 `LogisticsBlockGenericPipe` 自己的字段上，要按**类型**扫 LP 门面类
  `logisticspipes.LogisticsPipes` 的静态字段（`:200-228`；实测 1.5.28 是 `LogisticsPipes.LogisticsPipeBlock`）。
- 管道物品清单取 LP 自己注册的权威表 `LogisticsBlockGenericPipe.pipes`（`:91-123`），按类名关键字挑选，
  挑不到就落盘候选清单（`:129-138`）。

**判据（不靠人工观察）**：探针在捕获**之前**做前置校验 —— 每根管道在客户端都必须是真 LP 管道 TE
且 `pipe`/`container` 非 null，否则直接判 `precondition-failed` + `exitCode=3` 退出
（`LpTeRoundTripAutomation.java:596-628`；服务端侧放置后 `pipe == null` 也当场抛错 `:495-497`）。
**未单独实测**：「裸 `world.setBlock` 造出的 LP 管道 TE 必然通不过该前置校验」这一条本文未做对照实验，
但前置校验本身使得「放置路径不对」不可能被误判成「修复有效」。

### 4.3 断言三件套（+ 一条可达性自检）

> 编号沿用探针自己的口径（`LpTeRoundTripAutomation.java:872-999`，与 `state/Scene/issue-12/README.md:43-49` 一致）：
> 断言 1/2/4a/4b/5 是判据本体，3a/3b 是产物层旁证。

| # | 断言 | 实现口径 | 出处 |
|---|---|---|---|
| **1** | **导出前后活动 TE 的 `writeToNBT` 快照逐字节一致** | 每根管道 `writeToNBT` → gzip → SHA-256 + 字节数；比对 `[捕获前] vs [捕获后]`，并附 `pipeClass` / `containerNonNull` 同异 | 快照 `:1092-1144`；比对与 `expect` `:872-926` |
| **2** | **反射字段断言**：`LogisticsTileGenericPipe.pipe != null && pipe.container != null` | 反射读私有字段（沿继承链回退，兼容 `CoreRoutedPipe` / `CoreUnroutedPipe` 两种位置） | `LpPipeReflect.java:233-240`、`:294-318`；断言 `:928-935` |
| **4a** | **策略失败警告计数**（副作用的外在特征） | 数日志里 `MeshCaptureBlockPostRenderRegistry: strategy` 的行数，**取捕获前后差值**（不受历史行干扰）；日志定位 `logs/fml-client-latest.log` | 特征行 `postrender/MeshCaptureBlockPostRenderRegistry.java:62-66`；计数 `:1047-1082`；断言 `:964-967` |
| **4b** | **未捕获异常**（客户端渲染线程 NPE） | `Thread.setDefaultUncaughtExceptionHandler` 记录 | `:205-251`；断言 `:968-972` |
| **5** | **可达性自检**：真渲染线程上对该 TE 跑一次 `hasSpecialRenderer` + `renderTileEntityAt` | 临时把 `TileEntityRendererDispatcher.staticPlayer*` 移到该格（只读渲染），量 TESR 实际写入的四边形数 | `:660-729`；断言 `:974-999` |

**为什么需要断言 5**：若被捕获的方块在本环境根本没有可用渲染器，那么「无策略失败」就什么也证明不了 ——
自检是「**断言 4a** 有意义」的前提证据（`:652-658` 的注释即此）。

**产物层断言（旁证，与本回路正交）**：断言 3a/3b —— `blockPalette`/`cellGrid` 是否含目标格、几何 quads 是否 > 0；
另记 runA vs runB 产物 SHA-256 是否一致（`:937-960`、`:949-957`）。注意这两条**可能因与本回路无关的原因变红**（§8 第 1 条）。

**比对口径的两条坑**

- **`writeToNBT` 是安全口径**：LP 的破坏点在 `readFromNBT`（重建 pipe + 一次性绑定），
  所以「前后各 `writeToNBT` 一次比字节」在机制上成立（`state/issue-12/probe-infra-recon.md` §5.4、`state/issue-12-body.md:70-74`）。
- **运行时 gson 是 MC 1.7.10 自带的 2.2.4**：`JsonArray.isEmpty()` 到 2.8.2 才有，实测会抛
  `NoSuchMethodError` ——一律用 `size() > 0`（`LpTeRoundTripAutomation.java:923-924`）。

### 4.4 负对照设计（证伪能力）

| 项 | 内容 |
|---|---|
| 开关 | `-Dsde.teCaptureMode=inplace`：恢复旧行为 = 备份活动 TE → 就地 `readFromNBT(扫描 NBT)` → `finally` 回滚 |
| 默认 | **copy**（副本 TE）：`MeshCaptureService.java:87-90`；`inplace` 之外任何值都是 copy |
| 危险标注 | `MeshCaptureService.java:76-86`、`:550-552`、`:773-777` 三处标注「负对照专用，严禁默认启用」 |
| 一个进程只能一种模式 | `TE_CAPTURE_INPLACE` 是 `static final`（类初始化时定值）⇒ **两种模式必须是两个独立进程**（`LpTeRoundTripAutomation.java:366-377`；脚本头注释 `run-lp-te-probe.ps1:13-14`） |
| 怎么注入 | 经 `JAVA_TOOL_OPTIONS`（被 fork 的客户端 JVM 自动采用），**不动** `build.gradle.kts`；探针在结果 JSON 里回读 `teCaptureMode` / `teCaptureModeProperty` 证明确实生效（脚本 `:155-159`、`:219`；探针 `:1328-1329`） |

**负对照必须让断言变红（实测判据）**：`inplace` 轮断言 1/2/4a 全红、4/4 管道的
`pipe.container` 由 true→false、**8 条**策略失败警告（与 issue 原件同签名同条数）
（`state/Scene/issue-12/README.md:14`、`:43-49`）。

### 4.5 崩溃安全（本回路的强制约定）

issue #12 的崩溃发生在「导出结束、正常渲染恢复」**之后 1~2 秒**（`state/issue-12-body.md:76-79`），
因此：

1. **捕获完成后立刻落盘中途结果**：`stepSnapAfterA` 在 runA 之后马上写结果 JSON（`status=in-progress`），
   再继续 runB / 最终断言 —— 崩溃在后也不丢第一现场证据（`:775-813`）。
2. **结果写入必须是幂等可重入的**：任何一步都能调 `writeResultAndArtifacts`（`:1359-1380`）。
3. **停留观察**：`postCaptureDwellTicks > 0` 时先停留再退出（默认脚本给 100 tick ≈ 5 s，覆盖崩溃窗口）；
   探针内默认 0 = 立刻退出（`:151`、`:1017-1037`；脚本 `:35`、`:130`）。
4. **崩溃证据靠全局钩子**：渲染线程致命异常只有 `Thread.setDefaultUncaughtExceptionHandler` 收得到
   （`:201-219`）；再加一个 shutdown hook 写极小的退出标记
   `sde_lp_te_probe_exit.json`（含 `requestedExitCode` / `uncaughtThrowable` / `dwellLeftAtExit`，`:220-247`），
   供外层脚本对账「探针自己请求的退出码」与「进程实际退出码」。
5. **退出路径**：`code == 0` 走 `mc.shutdown()`，非 0 走 `FMLCommonHandler.instance().exitJava(code, false)`
   （**不要**用 `Runtime.halt`：FML 的安全管理器会拦 `exitVM`，见 `docs/plan/probe-export-pipeline.md` §6.3），
   两条路都挂 60 s 安全网线程 `exitJava(code, true)`（`:1436-1462`）。

### 4.6 移植到其它 mod / 其它断言的最小清单

1. 复制「独立触发文件 + 独立专用世界 + 独立结果文件 + 注册在最前」四件套（§4.1）。
2. 依赖按 §2 引入：`runtimeOnlyNonPublishable` + 全反射；先读 `.module` 的约束再定版本。
3. 放置走目标 mod 自己的放置 API，并在捕获前做**前置校验**（§4.2）。
4. 合成扫描文档时给目标格塞 `tileNbtB64`（§3.2）。
5. 断言选「捕获前后可读、可哈希、可计数」的量：`writeToNBT` 快照 SHA-256 + 反射字段 + 策略失败计数（§4.3）。
6. 配一个「把修复关掉」的开关做负对照，并实测它能红（§4.4）。
7. 逐条落实崩溃安全五件（§4.5）。

---

## 5. 怎么跑

```powershell
# 正对照（被测修复；默认 -Mode copy）
pwsh -File scripts/issue-12/run-lp-te-probe.ps1 -Mode copy    -Label copy-run-1
# 负对照（旧就地往返行为，预期把管道 TE 改坏）
pwsh -File scripts/issue-12/run-lp-te-probe.ps1 -Mode inplace -Label inplace-run-1
# 只做前置检查 + 写触发文件，不起客户端
pwsh -File scripts/issue-12/run-lp-te-probe.ps1 -DryRun
```

| 参数 | 默认 | 作用 | 出处 |
|---|---|---|---|
| `-Mode` | `copy` | `copy` = 被测修复；`inplace` = `-Dsde.teCaptureMode=inplace` 负对照 | `:26-27`、`:155-159` |
| `-Label` | `lp-te-<mode>-<yyyyMMdd-HHmmss>` | 归档目录名 + 触发文件 `label` | `:29`、`:53-56` |
| `-ProcessTimeoutMinutes` | `15` | 客户端进程超时（分钟） | `:31`、`:167` |
| `-SyncWaitTicks` | `120` | 放置后等「服务端 → 客户端」同步的 tick 数 | `:33`、`:127` |
| `-PostCaptureDwellTicks` | `100` | 断言落盘后继续跑多少 tick 再退出（≈5 s，覆盖崩溃窗口） | `:35`、`:130` |
| `-DryRun` | 关 | 只跑前置检查与触发文件写入 | `:37`、`:140` |
| `-NoSelfCheck` | 关 | 跳过 TESR 自检（排查用） | `:39`、`:129` |

**脚本流程**：前置检查（`:70-114`）→ 清陈旧结果（`:92-101`）→ 写触发文件（`:119-138`）→
`<gradle> runClientSdePipeline -x syncWeb -x processResources`（`:151-176`）→ 摘 `[SDE]` 行（`:178-182`）→
读结果（`:187-197`）→ 归档（`:199-214`）→ 汇总打印 → 退出（`:216-247`）。

**退出码语义**

| 码 | 含义 | 脚本落点 |
|---|---|---|
| `0` | 探针全绿 | 脚本 `:241-243` 打绿、`:247` 透传 `result.exitCode` |
| `2` | 有失败断言（**负对照下这是预期**） | 探针 `:1006`；脚本 `:244`、`:247` |
| `3` | 探针致命（放置失败 / 前置条件不成立 / 超时 / 写出失败） | 探针 `:514`、`:618`、`:1413` |
| `4` | **编排自身失败**：找不到 gradle、CoFH conf 前置检查失败、本树已有 `runClient` 在跑、读不到结果文件 | `:72`、`:89`、`:112`、`:193` |
| `5` | 客户端进程被超时强杀 | `:165-172`、`:246` |

**超时与杀树**：`Wait-Process -Timeout ($ProcessTimeoutMinutes*60)` 超时后
`taskkill.exe /PID <pid> /T /F` **杀掉整棵进程树**（`:166-172`）；随后仍尝试摘 `[SDE]` 行与归档。
进程退出码与探针自报 `exitCode` 是两个值，汇总时会分别打印（`:218`），不要混用。

---

## 6. 产物去哪

### 6.1 两级落点

| 级 | 路径 | 内容 | 出处 |
|---|---|---|---|
| 游戏内（原始） | `mod/gtnh/run/client/`（= `mc.mcDataDir`） | `sde_lp_te_probe_result.json`、`_exit.json`、`_scan.json`、`_export.json`、`_export-runB.json`、`crash-reports/` | 探针 `:77`、`:241`、`:1474-1476`；`mcDataDir` 见脚本 `:47` |
| 归档（跨轮保留） | `state/Scene/issue-<N>/<label>/` | `result.json`（结果副本）、`sde_lp_te_probe_*.json` 全部、`sde-lines.log`、`gradle-runClient.log`、本轮新崩溃报告 | 脚本 `:50`、`:56`、`:199-214` |
| 运行日志 | `state/logs/issue<N>-<label>.log`（完整）、`.log.err`、`.sde.log`（仅 `[SDE]` 行） | 崩溃现场最要紧的是 `[SDE]` 摘录与 `.log.err` | 脚本 `:51`、`:59-60`、`:164`、`:178-182` |

**约定**

- 每个 issue 一个目录 `state/Scene/issue-<N>/`，其下**一轮一个 `<label>/`**；
  目录里放一份 `README.md` 作为索引，用表格列出**权威运行**（哪一轮是对照、结论是什么），
  **不要覆盖历史轮次**（`state/Scene/issue-12/README.md:9-14` 即此形态）。
- 归档必须包含**本轮新生成**的崩溃报告（按 `LastWriteTime >= 本轮开始时刻` 过滤，脚本 `:207-214`）。
- 命名：`<mode>-run-<n>`（`copy-run-6` / `inplace-run-2`），使目录名自带模式信息。

### 6.2 仓库树内零未跟踪文件纪律

- **所有产物、日志、临时脚本一律不进仓库树**：`mod/gtnh/run/` 已被
  `mod/gtnh/.gitignore:3`（`/run/`）忽略，`state/` 与根级 `resources/` 在工作树之外（见根 `AGENTS.md`）。
- 树内新增文件**只允许**是「本次要提交的代码 / 脚本 / 文档」三类。
  交付验证回路时，探针 Java 源、分派挂接、`scripts/issue-<N>/` 都必须**随后提交**；
  本文编写时 `git status` 实证该实例尚有一处 modified（`SdeClientAutomationTickHandler.java`）与四处未跟踪
  （`LpPipeReflect.java`、`LpPrimaryCaptureProbeStrategy.java`、`LpTeRoundTripAutomation.java`、`scripts/issue-12/`）——
  这正是「交付未收尾」的形态，不要留到下一轮。
- 工作树里 `docs/` 是被该分支仓库跟踪的（`git ls-files docs` 可见 `docs/architecture.md` 等），
  所以**本文件本身也是待提交项**。

---

## 7. 环境坑速查

| # | 坑 | 现象 | 处置 | 出处 |
|---|---|---|---|---|
| 1 | `mod/gtnh/gradlew` 的 wrapper jar **未入库** | `gradlew` 不可用（`gradle/wrapper/` 下只有 `.properties`） | 用同版本分发包：`C:\gradle-cache\wrapper\dists\gradle-9.2.1-bin\2t0n5ozlw9xmuyvbp7dnzaxug\gradle-9.2.1\bin\gradle.bat` | 脚本 `:48`、`:72-73`；裁决 A6 / 开放项 O1（`state/issue-12/adjudications.md:14`、`:20`）。根因：根 `.gitignore:12` 的 `!gradle/wrapper/gradle-wrapper.jar` 只反选仓库根，`mod/gtnh/...` 仍被 `*.jar` 吃掉 |
| 2 | `web/node_modules` 未装 | `:syncWeb` 失败（它要跑 `npm run build:workbench`），而 `processResources dependsOn syncWeb` ⇒ 任务图直接失败 | **二者都要排除**：`-x syncWeb -x processResources`（探针不依赖 web 产物）；或先 `npm ci` | `mod/gtnh/build.gradle.kts:19-24`、`:47-49`；脚本 `:146-147`、`:154`；开放项 O2 |
| 3 | `runClient` 是**独占资源** | 同树两个客户端抢 Gradle 锁 / 端口 / 世界存档 | 起客户端前做进程检查并**直接判退出 4**；判据必须限定「本工作树」——**不能**用 `-Dgradlestart.bouncerClient`（那是 gtnhconvention 注入给**所有** GTNH 客户端的，实测会误报其它项目的客户端） | 脚本 `:103-114`；根 `AGENTS.md`「独占串行」 |
| 4 | CoFH MCP conf 缺失 | 启动阶段**静默挂住**且日志无输出（`ObfMapping$MCPRemapper.confDirectoryGuess → JFileChooser`） | 启动**前**做硬前置：扫 `%USERPROFILE%\.gradle` / `%GRADLE_USER_HOME%` / `C:\gradle-cache` 下的 `caches/minecraft/net/minecraftforge/forge/*/unpacked/conf`，判据不是「目录存在」而是**里面真有 `*.srg`** | 脚本 `:75-90`；`docs/plan/probe-export-pipeline.md` §6.1 |
| 5 | 陈旧结果未清 | 「读不到本轮结果」会退化成**读到上一轮结果** = 静默通过 | 起客户端前删本轮结果与 `sde_*` 陈旧产物 | 脚本 `:92-101` |
| 6 | 想改模式却去改 `build.gradle.kts` | 改构建文件影响面大，且与「一进程一模式」冲突 | 经 `JAVA_TOOL_OPTIONS` 注入 JVM 属性；跑完复原 | 脚本 `:148-159`、`:174` |

---

## 8. 已知边界（不掩盖）

1. **LP 管道几何在本环境抓不到 —— 与 §4 的回路无关的独立缺口**：LP 管道方块 `getRenderType() == 137`
   在本环境**没有注册任何 ISBRH**（`isbrhClass = <none-for-renderType>`，FML 的 `renderWorldBlock` 返回 false），
   其 TESR 在捕获期间写入 **0 个四边形**（`tesrQuadsDelta = 0`）⇒ 产物里管道格为空，
   断言 3a/3b 在 **copy 与 inplace 两种模式下都红**。
   出处：`state/Scene/issue-12/README.md:53`；诊断字段由 `LpPrimaryCaptureProbeStrategy.java:96-152` 落盘
   （`renderType` / `isbrhClass` / `quadsAtEntry` / `quadsAfterPrimary` / `quadsIsbrhDelta` / `fmlRenderWorldBlockHandled`）。
2. **负对照下客户端渲染崩溃未复现**：停留 100 tick（5 s，覆盖「导出后 1~2 秒」窗口）后进程未崩溃、
   无 `crash-reports`、无未捕获异常。最可能同因第 1 条（本环境 LP 渲染器不画东西 ⇒ 正常帧里走不到
   `LogisticsTileGenericPipe.isOpaque()`）；issue 原件是 LP `1.5.26-GTNH`、本树 `1.5.28-GTNH`，
   两个变量都可能起作用，**本次不能区分**（`state/Scene/issue-12/README.md:54`）。
   ⇒ 因此本实例的「红」是靠**断言 1/2/4a**（TE 快照 + 反射字段 + 策略失败计数）证明的，不是靠崩溃。
3. **`runClient` 的实际 `workingDir` 未确证**：影响 `/sde export` 的 `structure_exports` 绝对落点
   （服务端侧落盘相对 JVM 工作目录，路径硬编码在 `core/session/ExportSession.java:373-378`；
   客户端富化落盘写的是另一个目录 `mc.mcDataDir/structure_exports`，`MeshCaptureService.java:122`）。
   本回路不受影响 —— 探针产物一律写 `mc.mcDataDir`（侦察报告 §4.1 与附录未确证项 #2）。
4. **LP 版本串落盘为 `<unknown>`**：`logisticspipes.LPConstants` 没有探针能读到的 public 版本字段
   （已按候选名与字段类型扫描）⇒ 结果 JSON 的 `lpVersion` 不能当版本证据用（`state/Scene/issue-12/README.md:55`）。

---

## 附：未确证清单（本文明确不做的断言）

| # | 未确证内容 | 影响的结论 |
|---|---|---|
| 1 | `maven.gtnewhorizons.com` 当前 SSL 故障 | 只是「一律用 `nexus.gtnewhorizons.com`」这条纪律的背景；仓库本身可用已实测（HTTP 200） |
| 2 | 「裸 `world.setBlock` 造出的 LP 管道 TE 必然通不过前置校验」 | §4.2 的放置路径纪律（未做对照实验；但前置校验使误判不可能） |
| 3 | `runClient` 实际 `workingDir`（= `mod/gtnh` 还是 `mod/gtnh/run/client`） | §8 第 3 条；只影响 `/sde export` 的落点 |
| 4 | 负对照下客户端崩溃为何不复现（ISBRH 缺口 vs LP 版本，两变量未分离） | §8 第 2 条 |
| 5 | 捕获期间对活动 TE 的改写是否**污染导出结果本身** | issue #12 的待确认项（`state/issue-12-body.md:86`）；现有「同轮双导出 sha256 一致」判据测不到（两次导出都在同一个被改坏的世界里），需「干净基线 vs 捕获后产物」的跨状态比对 |
| 6 | 主批次 ISBRH/RenderBlocks 路径仍读活动 TE 的保真度影响 | 裁决 O4（`state/issue-12/adjudications.md:23`）：属保真度话题，非崩溃缺陷 |

**关键 `file:line` 索引**（本文引用的主文件）：

| 文件 | 关键位置 |
|---|---|
| `mod/gtnh/src/main/java/com/lightning/mod/client/meshcapture/MeshCaptureService.java` | `:87-90` 模式开关、`:451-453` 硬编码世界、`:536-560` TE 处置、`:738-800` 副本/就地/回滚、`:1064-1086` `tileNbtB64` 解析 |
| `.../client/automation/SdeClientAutomationTickHandler.java` | `:51-138` 分派（顺序即优先级） |
| `.../client/meshcapture/parts/probe/LpTeRoundTripAutomation.java` | `:76-155` 常量与默认值、`:301-532` 各阶段、`:536-1015` 探针主体与断言、`:1023-1037` 停留/退出、`:1092-1212` 快照与扫描文档、`:1323-1462` 落盘与退出 |
| `.../client/meshcapture/parts/probe/LpPipeReflect.java` | `:91-123` 物品枚举、`:148-198` 放置、`:233-240` 反射字段、`:294-318` 状态快照 |
| `.../client/meshcapture/parts/probe/LpPrimaryCaptureProbeStrategy.java` | `:88-156` 逐格诊断（只观测，不改渲染语义） |
| `.../client/meshcapture/postrender/MeshCaptureBlockPostRenderRegistry.java` | `:50-69` 策略分发与吞异常的警告文本 |
| `mod/gtnh/dependencies.gradle` | `:61-70` LP 依赖与版本裁决 |
| `mod/gtnh/build.gradle.kts` | `:47-49` `syncWeb` 依赖、`:61-79` `runClientSdePipeline` |
| `scripts/issue-12/run-lp-te-probe.ps1` | `:20-21` 退出码、`:24-40` 参数、`:70-114` 前置、`:151-176` 起客户端与超时杀树、`:199-214` 归档 |
| 证据归档 | `state/Scene/issue-12/README.md`（权威运行与缺口）、`state/issue-12/probe-infra-recon.md`（侦察细节）、`state/issue-12/adjudications.md`（裁决 A1-A6 / 开放项 O1-O7） |
