# 控制面契约 v1（lightning.controlplane）

> 本文是模组内置常驻 HTTP 控制面的**权威契约**：端点、动作模型、错误码、权限、线程与边界规则。
> 承载 Issue #57（交付物一）、#47 评论 id=664 的 A7/A8 与约束 C7/C10，验收前提为基准单 #55。
> 本文只记规则与约定；实现变更必须与本文同步修订。

## 1. 总则与边界（不可放宽）

1. **启用**：默认关闭。两条启用通道，任一即可：`lightning.cfg` `controlplane.enabled=true` 或 JVM 属性 `-Dsde.controlPlane=on`。正式游戏环境（非自动化/开发）不得默认开启。
2. **监听**：默认仅绑 `127.0.0.1`（回环）。配置 `controlplane.bind` 可显式改其它地址；绑非回环地址必须在启动日志打 WARN。
3. **端口**：默认 **23057**（工作区 `.workspace/ports.json` 本树条目登记；避开全部已登记 slot）。被占用时按 preferred+1… 回退（上限 128 次），实际绑定端口写入 `<mcDataDir>/controlplane/server.json`（含 `port`、`boundAt`、`contractVersion`）。
4. **鉴权**：三个权限级各一个 token，每次启动随机生成，写 `<mcDataDir>/controlplane/tokens.json`（0600 尽力设置）。调用方用 `Authorization: Bearer <token>` 或 `?token=`。**不存在空 token 放行**。
5. **权限三级**（严格递增，高阶含低阶）：
   - `observe`：只读观察——状态、动作目录、作业查询、事件流水、日志 tail、产物下载；
   - `scene`：场景操作——世界幂等构建/快照/回滚、用例文件执行（不含取证拍摄段）；
   - `forensic`：取证拍摄——截图、捕获、渲染相关动作（PR-2 起提供）。
6. **可写动作需确认**：`scene`/`forensic` 级动作的调用体必须含 `"confirm": true`，否则 `CP-CONFIRM-001`。
7. **单动作互斥**：同一时刻只允许一个动作在执行；执行中再提交得 `CP-BUSY-001`（除非该动作声明可并发，本契约 v1 没有）。
8. **线程边界**：HTTP 线程只解析/鉴权/入队/读文件，**绝不触碰 MC 状态**。动作在客户端 tick 线程（`TickEvent.ClientTickEvent` Phase.END）排空执行；GL/截图类动作（PR-2）再转渲染通道。这条是 1.7.10 的现实约束，不是风格偏好。
9. **产物路径**：控制面一切产物落 `<mcDataDir>/controlplane/`（`runs/`、`snapshots/`、`tokens.json`、`server.json`、`events.jsonl`），绝不写 CWD 相对路径。
10. **不进产物路径**：控制面代码不参与导出/捕获数据产物的生成链路；它是观察与编排设施。
11. **全程留痕**：每一次动作调用（含拒绝）追加一条事件流水记录。

## 2. HTTP 端点（前缀 `/cp/v1`）

| 方法 | 路径 | 级 | 说明 |
|---|---|---|---|
| GET | `/cp/v1/about` | observe | 契约版本、mod/MC/Forge 版本、启用态、绑定端口、忙闲、uptime |
| GET | `/cp/v1/actions` | observe | **动作自描述**：全部动作的名称、权限级、参数（名称/类型/必填/默认/说明）、返回结构说明、调用示例。无先验知识调用方仅凭本端点即可完成调用（验收锚之一） |
| POST | `/cp/v1/actions/{name}` | 按动作 | 执行动作。默认异步：立即返回 `{jobId}`；`?sync=true&timeoutMs=N` 时阻塞至完成或超时（超时返回 202 + jobId，动作不取消） |
| GET | `/cp/v1/jobs/{jobId}` | observe | 作业状态：`queued/running/done/failed`、进度、结果或错误、产物清单引用。jobId 形态 `j<seq>` |
| GET | `/cp/v1/events?since=<seq>&limit=<n>` | observe | 结构化、有序事件流水（seq 单调递增）；同一份流水同时服务活动面板与审计。响应为包装对象 `{events:[...], count, lastSeq, since}` |
| GET | `/cp/v1/logs/tail?lines=<n>` | observe | tail 客户端日志（`logs/fml-client-latest.log`），默认 200 行，上限 5000 |
| GET | `/cp/v1/artifacts/{runId}` | observe | 产物清单（包装对象）：`{runId, caseId, jobSeq, createdAt, count, artifacts:[{path, bytes, sha256, role}]}` |
| GET | `/cp/v1/artifacts/{runId}/{path}` | observe | 下载单个产物（防路径穿越） |

响应一律 JSON。成功：`{"ok": true, "data": ...}`；失败：HTTP 4xx/5xx + `{"ok": false, "error": {"code", "message", "context"}}`。

## 3. 错误码（稳定，调用方可依赖）

格式 `CP-<类>-<序>`。v1 内码值只增不改义。

| 码 | HTTP | 含义 |
|---|---|---|
| CP-AUTH-001 | 401 | 未认证（token 缺失/错误） |
| CP-AUTH-002 | 403 | 权限级不足 |
| CP-VALID-001 | 404 | 未知动作/未知端点 |
| CP-VALID-002 | 400 | 参数非法（`context.fields` 逐字段说明） |
| CP-CONFIRM-001 | 400 | 可写动作缺 `"confirm": true`（必须字面布尔 true，字符串不放行；confirm 要求由权限级派生：scene/forensic 级一律要求） |
| CP-BUSY-001 | 409 | 已有动作执行中 |
| CP-STATE-001 | 409 | 前置状态不满足（如世界未加载、非托管世界） |
| CP-EXEC-001 | 500 | 动作执行失败（`context` 带阶段与摘要，不依赖解析日志） |
| CP-EXEC-002 | 504 | 动作自身超时（由动作实现抛出） |
| CP-IO-001 | 500（产物/run/日志不存在时 404） | 产物/文件读写失败 |

`?sync=true` 等待超时**不是错误**：返回 HTTP 202 + `{jobId, timedOut:true}`，动作继续执行。

## 4. 动作清单（v1，PR-1 交付）

| 动作 | 级 | 语义 |
|---|---|---|
| `core.ping` | observe | 存活回声 |
| `core.status` | observe | 版本、世界加载态、忙闲、事件流水游标、最近作业 |
| `world.info` | observe | 当前世界描述（folder/维度/是否托管/是否虚空）；未在世界中返回 `loaded:false`。元数据（folder/marker/generatorOptions/seed/gameType 等）取**服务端世界**（1.7.10 客户端 WorldClient 是占位视图，会谎报 `folder=none`），客户端字段（playerPos/worldTime 等）取客户端；响应含 `metaSource`（server\|client）标明元数据来源 |
| `world.rebuild` | scene | **幂等重建托管世界**：卸载当前托管世界 → 删除托管存档目录 → 以固定种子建虚空世界 → 可选执行场景构建段（含 TE 状态补全）→ 静置稳定 → 返回世界描述与场景清单哈希。两次调用结果一致（哈希相等） |
| `world.snapshot` | scene | 快照（v1 口径=整目录复制）：自动离图 → 复制存档目录到 `snapshots/<id>/`（+ 树哈希清单 JSON）→ 重进世界。快照 id：`<ts>-<folder>` |
| `world.rollback` | scene | 回滚到指定快照（默认最近）：离图 → 快照目录整体覆盖回 → 重算树哈希与快照比对（不一致 CP-EXEC-001）→ 重进。试错不污染世界 |
| `case.validate` | observe | 解析用例文件，返回规范化执行计划（分段列表、判据、期望证据）或逐字段错误 |
| `case.run` | scene 起 | 执行用例文件：默认整跑；`segments:[...]` 按段执行。**整跑与按段共用同一实现、同一产物形态**（验收锚）。产物为 run 目录 + 观测记录 + 判据结论 |

v1.3（issue #98）追加的观察面读面动作见 §4.1；下表是 PR-1 的动作清单，追加不改已有语义。

PR-2 追加取证级动作（下表），PR-3 追加双轨判据；追加不改上表已有语义。
**#99（收口T2）追加 6 个 L0 布景原语**（`scene.*`，见 §4.4），同样只增不改上表语义。

### 4.1 观察面读面动作（v1.3，issue #98）

「Agent 必须有『看』的能力，不只有截图」（需求书 §5）。下表八个动作**全部 `observe` 级、全部只读、
全部同步**（一次 tick 内读完返回：跨 tick 的读面会读到两个世界状态，「调用前后世界哈希不变」就无从判定）：

| 动作 | 级 | 语义 |
|---|---|---|
| `read.blocks` | observe | **区域方块读回**：闭区间区域内每格 `{pos, id, blockId, meta, te}` + 规范化 `sha256`。参数 `{from,to}` 或 `{region:{from,to}}`，可选 `includeAir`（默认 true）、`hash`（默认 true）。哈希**恒**按「含空气的完整区域」计算（不受 `includeAir` 影响）——哈希是区域的属性，不是请求选项的属性 |
| `read.overview` | observe | **世界概览**：维度/时间/天气/已加载区块数/实体与方块实体计数（按类型分组）/玩家清单。服务端权威世界；含 `world.info` 同一份世界身份字段 |
| `read.player` | observe | **玩家状态**：位置（服务端与客户端各一份）、朝向与视线、生命/护甲/吸收/燃烧/氧气、饥饿、游戏模式与能力、经验、药水效果、手持与光标物品 |
| `read.inventory` | observe | **背包与容器逐槽**：`source=player`（主背包 36 + 护甲 4 + 光标）/ `tile`（`at` 处方块实体的 `IInventory`）/ `ender`（末影箱）。逐槽 `{slot,empty,id,meta,count,maxStackSize,damage,maxDamage,displayName,nbt}` |
| `read.te` | observe | **TE 状态**：逐位置「通用 TE 事实」（类名/是否在位/NBT 摘要）+「逐族描述器输出」（**与 `te-state-equals` 判据、观测记录 `runtimeReads` 同一个读取口**）。注册族与缺席族分列 |
| `read.block` | observe | **方块与物品信息**：注册名/渲染类型/是否 TESR/是否 ISBRH/所需工具与等级/材质/硬度抗爆/掉落物。`at` 读世界里那一格；`block`/`item` 按注册名问注册表 |
| `read.diff` | observe | **状态差异**：期望态（`expectInline` / `expectManifest` / `expectManifestFile`）与服务端实读**逐格 diff**，逐格给 `kinds[blockId\|meta]` 与两侧读数，并给双侧规范化 `sha256` |
| `read.run` | observe | **run 产物清单读回**：枚举 run 并逐 run 实读磁盘 `manifest.json`，给出 `path/bytes/sha256/role` 与**磁盘一致性**（`missingFiles`/`sizeMismatch`），`shots/` 下产物单独归组——用于确认 `shot.multi` 等取证动作的产物确实进了 run 清单（§8.6 产物显式） |

**哈希口径（`read.blocks` / `read.diff`）**：`sha256(canonical({"blocks":[{"pos","blockId","meta"}…]}))`，
`blocks` 按 `(x,y,z)` 升序、`pos` 为 `[x,y,z]`，无空白、键排序（`Json.canonical`）。
**与场景清单哈希的关系（可互算，不是恒等）**：场景清单的口径是
`{blocks:[{pos,blockId,meta}], tileEntities:[{pos,class}]}`（case-file.md §8.7）。
区域读回刻意**不含** `tileEntities`——含了它，「同一区域两次读回同不同」就混进了「该不该在这一格有 TE」
这个额外变量，而该变量由 `read.te` 与场景清单各自独立回答。
因此：读回整片区域并把结果排序后作为 `blocks`、附上同一批位置的 `tileEntities`，即得场景清单的哈希子集。
**判据只用一处的定义**：`world-hash-equals` 的脚本口径与 `read.diff` 的 `hashes` 都由
`ReadSupport.hashSubsetOf` 产出，不存在第二套哈希实现。

**只读性（验收 B1）**：八个动作的调用前后**世界清单哈希不变**（实测，见证据）。
只读不是靠约定：读面代码里不存在任何写世界/TE 的调用点（不出现
`setBlock`/`setBlockToAir`/`markBlockForUpdate`/`initialize`/`addPart` 等）。

**失败显式（§8.5）**：无服务端世界 → `CP-STATE-001`（上下文带 `action` 与可行补救）；
坐标非法/范围过大/参数冲突 → `CP-VALID-002`（`context.fields` 逐字段）；
容器不存在、TE 不存在 → `CP-STATE-001`（**不**返回空表：空容器与不存在的容器含义相反）。

**产物显式（§8.6）**：`read.diff` 的 `expectManifestFile` 路径会开 run 目录并把结果落
`read/diff.json`，登记 sha256 进 `manifest.json`；其余读面是纯内存读数，不产 run。

### 4.2 取证级动作（PR-2，Refs #41）

| 动作 | 级 | 语义 |
|---|---|---|
| `shot.multi` | forensic | 多机位截图：参数 `{cameras:[CameraSpec], target?:bbox, lighting?:natural\|neutral-flat, renderMode?:本色\|参与光照, worldTime?}`。每机位产 `shots/<name>.png`（拼接机位另产 `shots/<name>.tiles/` 与 `shots/<name>.meta.json`），全部产物登记哈希；观测记录按机位更新 camera/projection/lighting/renderMode |
| `capture.begin` / `capture.end` | forensic | 捕获会话包围：begin 后禁止一切世界写动作（违规 CP-STATE-001），end 释放；`case.run` 的 capture 段自动包围 build 之后、shots 之前的区间 |

`CameraSpec`：

```jsonc
{
  "name": "front-top",                     // 机位 id，产物文件名
  "pos": [64.5, 20.0, 70.5],             // 相机世界坐标（门控位置分离：与 playerPos 各自记录）
  "yaw": 180.0, "pitch": 45.0,           // 原样写入 rotationPitch——MC 语义：正=俯视、负=仰视
                                         // （俯拍用正 pitch；负 pitch 俯拍是文档曾写错过的口径，勿仿）
  "projection": {                          // 二选一
    "type": "perspective", "fov": 70
    // "type": "ortho", "orthoHeight": 16.0    // 正交：视高（方块数），宽按画面宽高比推
  },
  "resolution": [1920, 1080],
  "tile": { "cols": 2, "rows": 2, "overlap": 0.05 }  // 可空：超分拼接（投影偏移法，非视口拼接）
}
```

### 4.3 相机与渲染规则（PR-2，#41 落地）

1. **注入式相机**：渲染时用虚拟相机实体替换 `mc.renderViewEntity`（不传送真实玩家）；TE 渲染距离门随相机位置生效——这是注入而非挪玩家的核心理由。**机制更正（PR-3 实证）**：1.7.10 的 TE 距离门由 `TileEntityRendererDispatcher` 按 `renderViewEntity` 静态位置剔除 **TESR** 渲染，门值是各 TE 的 `getMaxRenderDistanceSquared()`（原版默认 4096=64 格；AE2 `TileCableBus`=900.0=30 格——**但 AE2 缆几何走 ISBRH 块层渲染不受此门管，门只管其动态部件（监视器屏显）的 TESR 内容**）。因此 K1 的验收器具是**原版箱子**（64 格 TESR 门）：玩家恒定停在门内、相机近/远跨门双拍——近图箱在、远图箱失即证「门随相机而非随玩家」。
2. **门控位置分离（A3）**：`observation.playerPos` 恒为真实玩家位置，`observation.camera.pos` 为机位；两者各自记录，判据可分别断言。
3. **正交投影**：渲染帧内替换投影矩阵，帧结束还原；透视/正交逐机位独立。**fov 合法域 5..110**（原版滑块的 30..110 只钳 `gameSettings.fovSetting`，投影覆写直写矩阵不经滑块；望远镜窄 fov 机位合法，K1 门控对照即用 fov 3~8）。
4. **超分拼接**：投影偏移 tiling（各 tile 用偏移投影矩阵渲染后像素级拼接）；**禁止视口拼接**（`EntityRenderer` 会强制视口尺寸，tile 间接缝错）。`resolution` 指**拼接后整图尺寸**（每片渲染尺寸 = resolution/cols × resolution/rows）；`overlap` 仅作接缝余量声明——投影偏移法下各片恰好分割整图，**不参与像素装配**；接缝可审计性靠 `<name>.tiles/` 逐片落盘。
5. **GL 线程**：shot/capture 类动作经 tick 排空后在客户端 tick 线程执行（1.7.10 单机 tick 线程==渲染线程；需要出帧时动作自行驱动 `EntityRenderer.renderWorld`，不等游戏主循环）；渲染故障 CP-EXEC-001 并附摘要。
6. **光照参与开关（豁免一）**：`renderMode`/`lighting` 逐机位可覆盖会话默认；**v1 仅如实留痕观测档位**（`shots/<name>.meta.json` 含 `lightingApplied:false` + warning），**不注入光照管线**——中性光照注入留待后续契约版本。
7. **世界时刻**：`worldTime` 决定拍摄光照基准；观测记录落实际 worldTime。
8. **`target` 参数（v1）**：仅作观察目标留痕（bbox 进观测记录），**不参与自动取景**；自动框景留待后续版本。
9. **按内容升格的鉴权时点**：动作静态级低于内容要求时（如 scene 级 `case.run` 跑含 cameras 段的用例），鉴权期按静态级放行、**执行期**升格检查——sync 调用方得 HTTP 403 `CP-AUTH-002`，异步调用方得 failed 作业（`error.code=CP-AUTH-002`）。

### 4.4 L0 布景原语（#99，「收口T2」）

能力面三层口径见 #96 §4.1：**L0 原语**＝直接设定世界/实体/玩家/背包状态（布景、构造输入、常规回归）；
**L1 玩家操作**＝经玩家路径执行；**L2**＝L0/L1 的有序编排。**L0 的产物不能当作 L1 的证据**（#96 §4.2）。

| 动作 | 级 | 语义 |
|---|---|---|
| `scene.entity.spawn` | scene | 生成实体（含掉落物）。`item` 造掉落物、`entity` 造一般实体，二者互斥必居其一；可带 SNBT `nbt` |
| `scene.entity.clear` | scene | 清除范围内实体（含掉落物）。选择条件 `box`/`entity`/`item` 取交集；`includePlayers` 默认 false |
| `scene.player.state` | scene | 玩家游戏模式 / 生命 / 经验 / 药水效果（`before`/`after` 双快照） |
| `scene.inventory.write` | scene | 逐槽写入玩家背包或世界容器（`{slot,id,meta,count,nbt}`）——「拿到物品」之**给**。模组权威取物/充电两种写法（#117）：`{slot,battery:"<GT ItemList 常量>"}` 由 GT 自己的清单决定物品与 meta；`{slot,battery,charge:"full"\|"empty"\|<EU>}` 经物品自己的 IC2 `IElectricItemManager` 充放电（`charge` ⟂ `nbt`，见 §6.5）。把满充 GT 电池写进机器充电槽即「给机器供电」 |
| `scene.weather.time` | scene | 设定世界权威时刻与天气（持续生效；`shot.multi.worldTime` 是拍摄基准，两义不同） |
| `scene.player.pose` | scene | 瞬时传送/转向——L0 布景原语，与 #101 的 L1 真实移动互补、两义按层标注 |

**共同口径（六条，全部可判定）**：

1. **只写服务端权威世界**（`MinecraftServer.worldServers[0]`，见 `mc.scene.L0Session`）。
   客户端 `WorldClient` 是只读投影：写它会被原版同步覆写（方块/实体/时间/天气皆然）。
   这与 `world.rebuild` 的场景构建、`world.info` 的元数据、`shot.multi` 的光照基准同一口径。
2. **同步一律走原版出口**：`S2BPacketChangeGameState(3)`（游戏模式）/ `S06PacketUpdateHealth`（生命）/
   `S1FPacketSetExperience`（经验）/ `S1DPacketEntityEffect`（药水）/ `S08PacketPlayerPosLook`（传送）/
   `S2FPacketSetSlot`（背包槽位）/ `S3PacketTimeUpdate` + `S2BPacketChangeGameState(7,8)`（时间天气）。
   **不自造同步、不逐字段从静态数据推算回填**（§6.4 的既有禁令对 L0 同样成立）。
3. **写入门控**：六个动作开场一律过 `CaptureControl.assertWorldWriteAllowed`——捕获会话期间被
   *别的*作业调用即 `CP-STATE-001`（§4.1 的既有口径）。会话开场作业自身可穿透（既有语义）。
4. **失败显式**：未知实体/物品 id、越界坐标、越界槽位、非容器方块实体、未知药水、未知天气、
   无世界/无玩家，一律 `CP-VALID-002`（参数类，带 `context.fields`）或 `CP-STATE-001`（前置状态类），
   **不静默过滤成 0 个**（「过滤掉 0 个」是假绿）。
5. **返回值自带读回**：逐项 `readBack` 或 `before`/`after` 快照，外加 `sceneReadback`
   ——按世界内最新场景清单的**位置集合**实读回读并重算规范化哈希（口径与 `world-hash-equals` 判据、
   `SceneManifest.readBack` 同源）。读面（#98）未就绪时，这是「这次写观察到了什么变化」的兜底证据。
   世界没有清单时 `sceneReadback.present=false` + 原因，**不算错误**（L0 不该要求「必须先 rebuild」）。
6. **不进场景清单哈希**（除非确实改了清单登记的位置）：L0 原语只动清单之外的维度
   （实体、玩家、背包、时间、天气），因此**不破坏 `world-hash-equals` 幂等判据**。
   `scene.entity.clear` 与 `scene.inventory.write` 亦然（实体与背包不入清单哈希）。

**两义标注（#96 裁决 3/4 的落地）**：`scene.inventory.write` 返回 `layer:"L0"` + `semantics:"give"`；
`scene.player.pose` 返回 `layer:"L0"` + `semantics:"teleport"`。两者的 `layerNote` 字段写明
「与 #101 的 L1 对应动作互补而不互替」。

**SNBT 口径**：`nbt` 参数是 **SNBT 文本**（原版 `/give`、`/summon` 的写法，
即 `net.minecraft.nbt.JsonToNBT`），**不是 JSON 对象**——两者语法相近但不同（SNBT 字符串值可裸写、
有 `1b`/`1.0f` 数字后缀）。自述与示例里写死这一点。

### 4.5 hermetic 纪律（起手重建世界）

见 case-file.md §8.8。要点：**验收类固定程序的第一次世界写动作必须是 `world.rebuild`（`void:true`）**，
不得在既有世界上续跑。`case.run` 的 `world` 段与之是**同一实现**（§6.3），二者语义不冲突。
L0 的轮内清场原语（`scene.entity.clear`）**不构成 hermetic 保证**，不能替代起手重建。

## 5. 版本化规则

- URI 前缀即契约大版本：`/cp/v1`。
- v1 内只允许**增量**：新增动作、新增可选参数、新增响应字段均可；不得改已有字段语义、不得删字段、不得收紧默认值。
- 破坏变更开 `/cp/v2`，旧版本至少保留一个里程碑周期。
- 每个动作描述含 `since`（引入的契约小版本，如 `1.0`）；`GET /cp/v1/about` 报 `contractVersion`。

## 6. 托管世界规则（C4 落地）

1. 控制面只操作**托管世界**：存档目录名以 `cp_` 前缀且内含 `cp_world.json`（`{schema:"lightning.cp-world/1", seed, void:true, createdBy}`）。对非托管世界的一切写操作拒绝（`CP-STATE-001`）。
2. **虚空世界**：`WorldType.FLAT` + 空层预设（无基岩无土层），固定种子；构建基点由用例文件给定。
3. **幂等重建**：`world.rebuild` 对同一用例定义产生相同世界；场景构建步骤以「清场（托管区域 setBlockToAir）→ 放置 → TE 补全 → 静置」为固定序。**时序陷阱（PR-3 实证）**：AE2 空缆块会在首个 tick 自毁（`TileCableBus.onReady`）——用例中缆块的 `block` 步与其 `te` 步之间**不得插入 `wait`/`clear` 等跨 tick 步骤**，te 步必须紧随同 tick 执行（completer 对缺中心缆报 CP-STATE-001 兜底）。
4. **TE 状态补全**（#55「设」第五项）：仅限场景构建阶段、捕获开始之前；必须经模组自身权威同步路径（如 `markBlockForUpdate` 触发 S35 description packet 摄取，或模组自己的 `initialize`/`addPart` 等 API）；**禁止**逐字段从静态数据推算回填。补全器按族注册（接口 `TeCompleter`），默认实现覆盖原版 TE；LP/AE2 族补全器随锚点场景交付。
5. **补全器的权威放置职责（PR-3 明确）**：当模组的方块需要构造上下文时（LP 通用管块需 `createPipe`/`placePipe`、AE2 部件需 `addPart` 到既有缆、GT 机器方块需 `ItemMachines.placeBlockAt` 才会建 MetaTileEntity），`te` 步的 completer 经**模组自身放置 API** 完成放置与补全；此时 `params` 声明的是**放置输入**（物品 id/朝向/面），不是 NBT 逐字段回填——该区分必须在 completer 类注释写明。**v1.3 注册表**：`vanilla` / `lp-pipe` / `ae2-part` / `gt-machine`（#117 追加，同一族名同时注册补全器与描述器）。
   - **补全器必须自带放置后验证**：`complete()` 返回 true 必须等价于「世界上真有一个可 tick 的模组方块实体」。反例（#117 的缺陷本体）：GT 机器用 `world.setBlock` 直铺只会得到一个 `mID == 0` 的空壳，其 `blockId`/`meta`/TE `class` **与真机器完全相同**——即 `world-hash-equals` 对「空壳 vs 可运行机器」是盲的。故 `gt-machine` 放置后读回 `getMetaTileID()`/`getMetaTileEntity()`，不符即 `CP-EXEC-001`；`GtMachineDescriber` 把同两项（外加 `shell` 布尔）暴露给 `read.te` 与 `te-state-equals`，负对照只能靠它判别。
   - **充电/供电一类「模组状态注入」一律经模组自身 API**：GT 电池的充电状态存在 NBT 键 `GT.ItemCharge` 上，手写它即 §6.4 禁止的逐字段回填；`scene.inventory.write` 的 `charge` 走物品自己的 IC2 `IElectricItemManager`（GT `MetaBaseItem` 自实现之），并显式拒绝 `charge` 与 `nbt` 同时出现。**给机器供电的正确形态是把满充电池写进机器充电槽**（GT 自己的 tick 从槽里取电），而不是直接改机器的 EU 缓冲字段。
6. 世界快照与回滚范围**包含** TE 补全后的状态。
7. **玩家稳定化**：虚空世界进图后允许对玩家做最小稳定化（传送到构建基点上方、创造飞行，防坠亡卡死无人值守流程）；只动玩家实体，不进场景清单与哈希。**L0 的 `scene.player.pose`（§4.4）是这条的显式化对应物**——同一件事由调用方按需触发，而不是只在进图时隐式做一次。
8. **离图阻塞**：`mc.loadWorld(null)` 在 tick 线程内阻塞至集成服停机（原版「保存并退到标题」同路径），客户端会冻结数秒到数十秒——动存档目录前必须保证 region 句柄释放，这是 v1 的取舍。
9. **hermetic 纪律（#99 成文）**：验收类固定程序的第一次世界写动作必须是 `world.rebuild`（`void:true`）；
   本节的 `case.run` 的 `world` 段与之**共用同一实现**（`WorldRebuildRunner`），语义不冲突。
   完整规则与逐条对齐表见 case-file.md §8.8；L0 的轮内清场原语**不构成** hermetic 保证（§4.5）。

## 7. 观测记录

每次 `case.run` 在 run 目录落 `observation.json`，schema `lightning.observation/1`，字段规范见 [observation-record.md](observation-record.md)。核心要求（A10）：可据它**离线解释一次观测**——版本、渲染相关客户端配置、观察条件、关键运行期状态摘要与哈希、产物引用与哈希，缺一不可。

## 8. 事件流水

- 每条事件：`{seq, ts, level, kind, action?, jobId?, message, data?}`；`seq` 进程内单调递增。
- 内存环形缓冲（容量 4096）+ 追加写 `<mcDataDir>/controlplane/events.jsonl`。
- `kind` 至少：`server-start`、`server-stop`、`action-submit`、`action-reject`、`action-start`、`action-progress`、`action-done`、`action-fail`、`world-rebuild`、`world-snapshot`、`world-rollback`、`case-segment`、`criteria-verdict`。

## 9. 架构约定（实现必须遵守）

- 包：`com.lightning.mod.client.controlplane`，分两层——
  - `core/`：**零 MC 依赖**（只用 JDK + Gson），含 HTTP 服务、路由、动作注册表、作业队列、事件缓冲、错误信封、产物登记、用例文件模型与解析、判据引擎。零 MC 依赖是为了可单测（本仓 mod 无渲染环境单测能力，捕获/渲染不可无头测）。
  - `mc/`：MC 绑定层——tick 排空器、世界动作、场景构建、TE 补全器、观测记录采集、配置装配。
- 启动：`ClientProxy.initNetwork()` 按配置启动；关闭：JVM shutdown hook（无 FML 客户端停止事件可用）。
- 与既有触发文件自动化（`SdeClientAutomationTickHandler` 的 6 条分派）的关系：控制面排空器作为**新的独立 tick handler 注册**，不复用触发文件链；既有探针激活期间（其 `isRequested` 为真）控制面 tick 层**暂停排空**——在队作业保持 queued，探针结束后自动开跑；期间打 WARN 日志 + `action-reject` 事件留痕（`data.code=CP-BUSY-001`），`about.probeActive` 暴露原因（单向避让，不改动既有探针；`CP-BUSY-001` 提交即拒仅对「已有控制面动作在队/在跑」成立）。
- `about` 等端点的 MC 相关字段必须由 tick 线程周期快照提供（§1.8：HTTP 线程不得读 `mc.theWorld` 等 MC 状态）。
- 进度事件节流：增量 ≥0.05 或间隔 ≥3s 放行，终值 1.0 必放行（防事件流水被逐 tick 上报灌满）。
- 调用既有 runner（扫描/导出类）时必须强制其 `exit=false / cleanupTrigger=false`，禁止继承自毁退出。
- 日志前缀 `[SDE][CP]`，沿用 FMLLog 手工前缀约定。
- 与 `SdeWebServer`（`/sde web`，`/api/v1/*`）零共享可变状态：不同端口、不同实例、不同鉴权域。
- **步进动作按工厂注册**（`registerStepping(desc, Supplier)`）：每个作业一个动作实例，作业内复用、收尾销毁；禁止注册有状态单例（实测事故：实例复用导致后续作业静默返回上一作业的结果）。已收尾/跨作业复用实例必须当场 CP-EXEC-001，不许静默。
