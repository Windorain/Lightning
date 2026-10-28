# 控制面契约（lightning.controlplane v1）

本文是模组内置常驻 HTTP 控制面的契约：启用与监听、鉴权与权限、端点、参数类型、错误码、动作面、线程模型、托管世界规则与版本化规则。实现变更必须与本文同步修订。

控制面是观察与编排设施，不参与导出与捕获数据产物的生成链路。

## 1. 启用与监听

1. **默认关闭**。`<mcDataDir>/config/lightning.cfg` 的 `controlplane.enabled`（默认 `false`）是启用项。
2. **JVM 属性覆盖**：`-Dsde.controlPlane` 覆盖配置项，两个方向都生效——`on`/`true`/`1`/`yes` 强制开启，`off`/`false`/`0`/`no` 强制关闭，其它取值或未设置时回落配置项。
3. **监听地址**：`controlplane.bind`，默认 `127.0.0.1`。绑非回环地址时在启动日志打 WARN。
4. **端口**：`controlplane.port`，默认 `23057`（域 1..65535，越界回落默认值）。被占用时按 `preferred+1` 起顺序回退，最多 128 次尝试。
5. **实际绑定写入**：`<mcDataDir>/controlplane/server.json`，字段 `{schema:"lightning.cp-server/1", port, bind, boundAt, contractVersion, prefix, pid}`。
6. **调用方发现顺序**：先读 `server.json` 的 `port`，再读 `tokens.json` 的 `tokens.{observe,scene,forensic}`。端口不扫描、不复用上一轮残留。
7. **产物根**：控制面产物一律落 `<mcDataDir>/controlplane/`（`runs/`、`snapshots/`、`tokens.json`、`server.json`、`events.jsonl`），不写 CWD 相对路径。

## 2. 鉴权与权限

1. **token**：三个权限级各一个，每次启动随机生成（32 字节 → 64 位十六进制），写 `<mcDataDir>/controlplane/tokens.json`（尽力设 0600）。空 token 与未知 token 不匹配任何权限级。
2. **出示方式**：`Authorization: Bearer <token>` 或查询参数 `?token=`。
3. **权限级**（严格递增，高阶含低阶）：

   | 级 | 覆盖范围 |
   |---|---|
   | `observe` | 只读：状态、动作目录、作业查询、事件流水、日志 tail、产物下载 |
   | `scene` | 场景操作：世界幂等构建/快照/回滚、用例执行、L0/L1 写动作、导出 |
   | `forensic` | 取证拍摄：截图、捕获会话 |

4. **可写动作需确认**：`scene` 级及以上动作的调用体必须含字面布尔 `"confirm": true`，否则 `CP-CONFIRM-001`。`confirm` 由权限级派生，不由动作名列表维护。
5. **单动作互斥**：同一时刻只允许一个动作在队或在跑；此时提交得 `CP-BUSY-001`。`CP-BUSY-001` 只在提交期判定，tick 排空不以忙为门（步进作业靠每 tick 推进）。
6. **按内容升格**：动作的静态权限级低于内容要求时（`case.run` 跑含 `cameras` 段的用例），鉴权期按静态级放行、执行期升格校验。同步调用方得 HTTP 403 `CP-AUTH-002`；异步调用方得 `state=failed` 且 `error.code=CP-AUTH-002` 的作业。
7. **全程留痕**：每次动作调用（含拒绝）追加一条事件流水记录。

## 3. HTTP 端点（前缀 `/cp/v1`）

| 方法 | 路径 | 级 | 说明 |
|---|---|---|---|
| GET | `/cp/v1/about` | observe | `contractVersion`、`prefix`、`enabled`、`running`、`port`、`bind`、`uptimeMs`、`busy`、`currentJobId`、`pending`、`events{lastSeq,buffered,capacity}`、`jobs{lastSeq,counts}`、版本信息 |
| GET | `/cp/v1/actions` | observe | 动作自描述：`{contractVersion, count, actions[]}` |
| POST | `/cp/v1/actions/{name}` | 按动作 | 执行动作（见 §3.1） |
| GET | `/cp/v1/jobs/{jobId}` | observe | 作业状态（见 §3.2） |
| GET | `/cp/v1/events?since=<seq>&limit=<n>` | observe | 事件流水，`since` 只返回 `seq > since`，`limit ≤ 0` 表示不限（受环形缓冲约束）；响应 `{events, count, lastSeq, since}` |
| GET | `/cp/v1/logs/tail?lines=<n>` | observe | tail 客户端日志（`logs/fml-client-latest.log`）；`lines` 默认 200、上限 5000；响应 `{path, requestedLines, lines, truncated, content}` |
| GET | `/cp/v1/artifacts/{runId}` | observe | 产物清单：`{runId, caseId, jobSeq, createdAt, artifacts[{path, bytes, sha256, role?}], count}` |
| GET | `/cp/v1/artifacts/{runId}/{path}` | observe | 下载单个产物（拒绝路径穿越） |

响应一律 JSON。成功 `{"ok": true, "data": ...}`；失败为 HTTP 4xx/5xx + `{"ok": false, "error": {"code", "message", "context"}}`。

### 3.1 动作提交

1. 默认异步：立即返回 HTTP 202 与作业 JSON。
2. `?sync=true&timeoutMs=N`：阻塞至完成或超时。`timeoutMs` 缺省 30000。完成返回 200；超时返回 202 + 作业 JSON + `timedOut:true` + `timeoutMs`，**动作不取消**。
3. 调用体中的控制字段 `confirm`、`sync`、`timeoutMs`、`token` 由端点消费，不传给动作实现。
4. 动作名不在注册表中 ⇒ `CP-VALID-001`。

### 3.2 作业状态

`{jobId, seq, action, params, state, progress, progressMessage?, runId?, result?, error?, submittedAt, startedAt?, endedAt?}`。

`state` 取 `queued` / `running` / `done` / `failed`；`jobId` 形态 `j<seq>`，`seq` 为进程内递增的作业序号。

## 4. 参数类型

自描述里每个参数都有 `type`：`string` / `int` / `number` / `boolean` / `object` / `array` / `path`。

**类型即判据：不做隐式转换。** 声明为 `int` 的参数必须精确为整数；不截断小数、不解析字符串数字、不把布尔当 `0/1`。

| 入参 | 判定 | 说明 |
|---|---|---|
| `3` | 接受 | 精确整数 |
| `3.0` | 接受 | 数值且值精确为整数 |
| `-7` | 接受 | 负整数 |
| 键不存在 | 接受 | 视为未提供 ⇒ 取自述 `default`，无 `default` 取动作内部默认 |
| `null`（显式） | 接受 | 与缺键同义 |
| `1.5` / `-0.5` | 拒绝 | `CP-VALID-002`，不截断 |
| `true` / `false` | 拒绝 | `CP-VALID-002`，布尔不做 `0/1` 转换 |
| `"3"` | 拒绝 | `CP-VALID-002`，字符串数字不解析 |
| 超出 `int` 范围 | 拒绝 | `CP-VALID-002` |
| `{...}` / `[...]` | 拒绝 | `CP-VALID-002`，类型不符 |

拒绝时 `context.fields[]` 逐字段给出 `{field, reason, received, receivedType, expected}`。

`array` 参数的**元素**取值口径由各动作自定（例如 `at`/`pos`/`to` 允许小数）；本节只约束声明为 `int` 的参数本身。

**运行期必填**：自描述未标必填的参数仍可能在运行期必填（如 `world.rebuild` 的 `folder`/`seed`、`scene.tank.fill` 的 `at`/`fluid`/`amount`），缺失报 `CP-VALID-002`。

## 5. 动作自描述的字段集合

`GET /cp/v1/actions` 每个元素的字段集合固定：

| 字段 | 必现 | 说明 |
|---|---|---|
| `name` / `tier` / `writable` / `confirmRequired` | 是 | 动作名、权限级、是否可写、是否需要 `confirm` |
| `description` / `params` / `returns` / `examples` / `since` | 是 | 说明、逐参数自述、返回结构说明、可复制示例、引入的契约小版本 |
| `means` | 否 | 手段归因。只有输入族（`input.*`）写 `"input"`；缺省时该键不出现，且「不出现」不等于任何默认值 |

`params[]` 每项为 `{name, type, required, default?, description?}`，`default` 缺省即不出现。

## 6. 错误码

格式 `CP-<类>-<序>`；v1 内码值只增不改义，调用方可依赖码值分支。HTTP 状态码是该码的默认值，个别端点会覆盖（产物/run/日志不存在用 `CP-IO-001` + 404）。

| 码 | HTTP | 含义 |
|---|---|---|
| `CP-AUTH-001` | 401 | 未认证（token 缺失/错误） |
| `CP-AUTH-002` | 403 | 权限级不足 |
| `CP-VALID-001` | 404 | 未知动作/未知端点/未知资源 |
| `CP-VALID-002` | 400 | 参数非法（`context.fields` 逐字段说明） |
| `CP-CONFIRM-001` | 400 | 可写动作缺字面布尔 `"confirm": true` |
| `CP-BUSY-001` | 409 | 已有动作在队或在跑 |
| `CP-STATE-001` | 409 | 前置状态不满足（世界未加载、非托管世界、捕获会话封锁、容器/TE 不存在等） |
| `CP-EXEC-001` | 500 | 动作执行失败（`context` 带阶段与摘要） |
| `CP-EXEC-002` | 504 | 动作自身超时（由动作实现抛出） |
| `CP-IO-001` | 500（不存在时 404） | 产物/文件读写失败 |

`?sync=true` 等待超时不是错误，见 §3.1。

## 7. 动作面

动作总数以 `GET /cp/v1/actions` 的 `count` 为准；契约 **1.8** 共 **48 个**：基础 8 + 读面 9 + 取证 3 + 捕获诊断 1 + L0 7 + 命令通道 2 + L1 9 + 收尾 1 + 导出 3 + 输入 5。

### 7.1 基础动作

| 动作 | 级 | 语义 |
|---|---|---|
| `core.ping` | observe | 存活回声：`{pong, contractVersion, prefix, versions{mod,minecraft,forge,modsTotal}, serverTime, uptimeMs, busy, probeActive, probe, capabilities[]}` |
| `core.status` | observe | 现场总览：版本、世界状态、忙闲、当前/待处理作业、事件游标、作业计数、快照、路径、最近 run |
| `world.info` | observe | 世界描述。元数据（folder/marker/generatorOptions/seed/gameType）取服务端权威世界，客户端字段（`playerPos` 等）取客户端，`metaSource` 标明来源；含 `managed` / `markerPresent` / `markerComplete`；不在世界中返回 `loaded:false` |
| `world.rebuild` | scene | 幂等重建托管世界：离开 → 删除托管存档目录 → 写标记（`complete:false`）→ 固定种子建虚空世界 → 可选 `build` 段 → 静置 → 标记完成（`complete:true`）并写场景清单；返回世界描述与场景清单哈希 |
| `world.snapshot` | scene | 快照（整目录复制）：离图 → 复制存档目录到 `snapshots/<id>/` + 树哈希清单 → 重进世界。只接受 `complete:true` 的托管世界 |
| `world.rollback` | scene | 回滚到快照（默认最近）：离图 → 快照目录整体覆盖 → 重算树哈希并与快照比对（不一致 `CP-EXEC-001`）→ 重进 |
| `case.validate` | observe | 解析用例文件，返回规范化计划（段列表、展开的判据、期望证据、警告）与判据类型自描述 `criteriaTypes[{type,since,params}]` |
| `case.run` | scene | 执行用例文件：整跑或按 `segments` 按段执行，同一实现与同一产物形态；产物为 run 目录 + 观测记录 + 判据结论 + 证据核对结论 |

### 7.2 读面动作（全部 observe、只读、同步）

| 动作 | 语义 |
|---|---|
| `read.blocks` | 区域方块读回：闭区间逐格 `{pos, id, blockId, meta, te}` + 规范化 `sha256`；参数 `{from,to}` 或 `{region:{from,to}}`，可选 `includeAir`（默认 true）、`hash`（默认 true）。哈希恒按含空气的完整区域计算 |
| `read.overview` | 世界概览：维度、时间、天气、已加载区块数、实体与方块实体计数（按类型）、玩家清单 |
| `read.player` | 玩家状态：服务端与客户端位置、朝向与视线、生命/护甲/吸收/燃烧/氧气、饥饿、游戏模式与能力、经验、药水效果、手持与光标物品 |
| `read.inventory` | 背包与容器逐槽：`source=player`（主背包 36 + 护甲 4 + 光标）/ `tile`（`at` 处方块实体的 `IInventory`）/ `ender`；逐槽 `{slot,empty,id,meta,count,maxStackSize,damage,maxDamage,displayName,nbt}` |
| `read.te` | TE 状态：逐位置「通用 TE 事实」+ 逐族描述器输出（与 `te-state-equals` 判据同一读取口）；注册族与缺席族分列 |
| `read.block` | 方块与物品信息：注册名、渲染类型、是否 TESR/ISBRH、所需工具与等级、材质、硬度与抗爆、掉落物；`at` 读世界中的格，`block`/`item` 按注册名查注册表 |
| `read.diff` | 期望态（`expectInline` / `expectManifest` / `expectManifestFile`）与服务端实读逐格 diff，逐格给 `kinds[blockId\|meta]`、两侧读数与双侧规范化 `sha256` |
| `read.run` | run 产物清单读回：枚举 run 并实读磁盘 `manifest.json`，给 `path/bytes/sha256/role` 与磁盘一致性（`missingFiles`/`sizeMismatch`）；`shots/` 下产物单独归组 |
| `read.capture` | 捕获通道诊断读数：三通道计数（`channels.*.windows/quads/zeroFlowWindows`）、`directTessellatorHookActive`、按格归属（`quadsByAttr`/`quadsByBin`）、逐窗口 zeroFlow 事件、`collectionState`；可选 `channel`（默认 all）、`events`（默认 true）、`maxEvents`（默认 64、上限 512） |

**哈希口径**（`read.blocks` / `read.diff`）：`sha256(canonical({"blocks":[{"pos","blockId","meta"}…]}))`，`blocks` 按 `(x,y,z)` 升序、`pos` 为 `[x,y,z]`、键排序、无空白。区域读回不含 `tileEntities`；场景清单哈希口径见 [case-file.md §8](case-file.md)，两者可互算而不恒等。

**只读性**：读面调用前后世界清单哈希不变。**失败显式**：无服务端世界 ⇒ `CP-STATE-001`；坐标非法/范围过大/参数冲突 ⇒ `CP-VALID-002`；容器或 TE 不存在 ⇒ `CP-STATE-001`（不返回空表）。

**产物**：`read.diff` 的 `expectManifestFile` 路径会开 run 并落 `read/diff.json` 并登记 sha256；其余读面是纯内存读数。

### 7.3 取证动作（forensic）

| 动作 | 语义 |
|---|---|
| `shot.multi` | 多机位截图：`{cameras:[CameraSpec], target?, lighting?, renderMode?, worldTime?, gui?}`；每机位产 `shots/<name>.png`（拼接机位另产 `shots/<name>.tiles/` 与 `shots/<name>.meta.json`），全部登记哈希。`gui` 是字符串：`none`（默认，只拍世界，`guiHidden:true`）或 `screen`（把 `currentScreen` 画进同一 framebuffer，`guiHidden:false` 且登记 `guiCapture[]`）；取值域外一律 `CP-VALID-002` |
| `capture.begin` | 开始捕获会话：此后一切世界写动作被拒 `CP-STATE-001`，直到 `capture.end`；重复 begin 亦 `CP-STATE-001` |
| `capture.end` | 结束捕获会话并恢复世界写动作；未 begin 时幂等成功（`idempotent:true`） |

### 7.4 捕获通道诊断（observe）

`capture.diag` 布防/撤防录窗与诊断会话，并可按 `dump:true` 把 TESR 录窗 drain 到的实录几何装配成场景文档落本 run（`capture/diag-dump.json`，登记 sha256）。

1. **只改观察条件**：不写世界、不驱动渲染、不改画面；不碰 `CaptureSession`，也不被它拦。
2. **三态会话处置**：`arm` 未给时缺省布防；`arm:false` 撤防（不清计数、不清 drain 汇）；`dump:true` 且未给 `arm` 时缺省 `unchanged`（既不重新布防也不撤防）。`arm`/`reset` 刻意不声明 `default`，实际生效值由返回值的 `sessionMode`（`arm`/`disarm`/`unchanged`）与 `resetRequested` 机读给出。
3. **撤防的待兑现语义**：撞上在飞录窗时只挂 `windowsDisarmPending:true`，由该窗口关闭时兑现。
4. **忠实边界**：dump 的几何唯一来源是 `TessellatorCaptureState.endWindowAndDrain` 交出的窗口四边形；录不到的格留空并进 `assembly.missing`，`staticFallback` 恒为 `false`。
5. **未采集是显式空态**：`read.capture.collectionState` 取 `not-collected` / `collecting` / `collected-then-disarmed`，三者都不抛异常。`directTessellatorHookActive=false` 只表示该会话没有 DirectTessellator 流量，不是缺陷。

### 7.5 L0 布景原语（scene）

| 动作 | 语义 |
|---|---|
| `scene.entity.spawn` | 生成实体（含掉落物）：`item` 或 `entity` 二者必居其一；可带 SNBT `nbt` |
| `scene.entity.clear` | 清除范围内实体（含掉落物）：`box`/`entity`/`item` 取交集；`includePlayers` 默认 false |
| `scene.player.state` | 玩家游戏模式 / 生命 / 经验 / 药水效果（返回 `before`/`after` 双快照） |
| `scene.inventory.write` | 逐槽写入玩家背包或世界容器；三种条目形态：`{slot,id,meta,count,nbt}`、`{slot,battery,charge}`、`{slot,material,prefix,count}` |
| `scene.weather.time` | 设定世界权威时刻与天气（持续生效） |
| `scene.player.pose` | 瞬时传送/转向（`EntityPlayerMP.setPositionAndUpdate`） |
| `scene.tank.fill` | 流体注入：`{at,fluid,amount,side?}` 经 `IFluidHandler.fill` 注入，返回 `filled`（实际注入量）、`dryRunFillable`（干跑）、`partial`、注入前后逐罐读数 |

**共同口径**：

1. **只写服务端权威世界**（`MinecraftServer.worldServers[0]`）。客户端 `WorldClient` 是只读投影。
2. **同步走原版出口**：游戏模式 `S2BPacketChangeGameState(3)`、生命 `S06`、经验 `S1F`、药水 `S1D`、传送 `S08`、背包槽位 `S2F`、时间天气 `S3` + `S2BPacketChangeGameState(7,8)`、流体 `IFluidHandler.fill`。不自造同步、不逐字段从静态数据回填。
3. **写入门控**：七个动作开场过 `CaptureControl.assertWorldWriteAllowed`；捕获会话期间被其它作业调用即 `CP-STATE-001`（会话开场作业自身可穿透）。
4. **失败显式**：未知实体/物品 id、越界坐标、越界槽位、非容器方块实体、未知药水、未知天气、无世界/无玩家 ⇒ `CP-VALID-002` 或 `CP-STATE-001`，不静默过滤。
5. **返回值自带读回**：逐项 `readBack` 或 `before`/`after` 快照，外加 `sceneReadback`（按最新场景清单的位置集合实读回读并重算哈希）。世界无清单时 `sceneReadback.present=false` 并给原因，不是错误。
6. **不进场景清单哈希**（除确实改动清单登记位置者），因此不破坏 `world-hash-equals` 幂等判据。

**按层标注**：`scene.inventory.write` 返回 `layer:"L0"` + `semantics:"give"`；`scene.player.pose` 返回 `layer:"L0"` + `semantics:"teleport"`；`scene.tank.fill` 返回 `layer:"L0"` + `semantics:"fill"`；三者 `layerNote` 写明与 L1 对应动作互补而不互替。

**SNBT 口径**：`nbt` 参数是 SNBT 文本（`net.minecraft.nbt.JsonToNBT`），不是 JSON 对象。

**流体读数口径**：输入侧权威读数是逐罐 `tanks[]`（`/tanks/tanks/<i>/amount`）；`drainableFluid`/`drainableFluidAmount` 是输出/可排出侧；容量取 `/tanks/metaTileCapacity`，不是方块实体的 `getCapacity()`（后者返回 EU 缓冲容量）。`fill` 返回 0 报 `CP-EXEC-001`，部分注入如实返回 `filled`/`partial:true`/`notFilled`。

### 7.6 命令通道动作

| 动作 | 级 | 语义 |
|---|---|---|
| `export.session` | observe | 只读：`ExportSession.snapshot()` 的一致性快照（会话开关、选区模式与规范化 min-max、活动帧、已录帧、逐帧 `frameSha256[]`、`bufferGeneration`、输出名、`structureId`、最近作者、`statusLine`）。不写状态、不碰世界与文件、不建 run |
| `cmd.exec` | scene | 在服务端线程执行白名单内的 `/sde` 子命令并返回真实回报文本（`{command, timeoutMs?}`）；白名单外 `CP-VALID-002` + `context.alternatives[]` |

**白名单**（唯一权威 `mc/cmd/SdeCommandWhitelist.java`，未登记即拒绝）：`pos1` `pos2` `hpos1` `hpos2` `sel` `start` `end` `setname` `setframe` `setstructureid` `record` `export` `multiblock` `dump` `status`。仅 `status` 为 `observe` 级，其余 14 条为 `scene` 级。`web`/`webstop`（另启一套 HTTP/鉴权域）与 `hajimi`/`hjm`（四步合并的快捷方式）不在白名单。

**线程与回报**：命令在集成服 `Server thread` 上经 `MinecraftServer.getCommandManager().executeCommand(...)` 执行，与聊天框敲命令同一路径；控制面动作在 `Client thread` 发起并阻塞等待回包，等待方向单一。发送者是真实服务端玩家；无服务端玩家时 `CP-STATE-001`。回报取命令真实写给玩家的聊天文本（原样，含前缀）并按序转发。

**失败码**：白名单外 `CP-VALID-002`（`command`/`root`/`sub`/`decision`/`reason`/`alternatives[]`/`fields[]`）；无服务端玩家 `CP-STATE-001`；等待回包超时 `CP-EXEC-002`；命令抛异常 `CP-EXEC-001`；参数非法 `CP-VALID-002`。

**审计**：每次调用（含拒绝）落一条 `kind=cmd-exec` 事件，`data` 含 `commandText`、`command`、`root`、`sub`、`allowed`、`decision`、`tier`、`whitelistVersion`、`timeoutMs`；执行类另带 `status`、`executedOnThread`、`serverTick`、`elapsedMs`、`reply`、`artifacts[]`。

**产物归属**：`export`/`dump` 的产物由 `cmd.exec` 复制/登记进它自己 run 的 `cmd-exec/`，逐份登记 sha256；`multiblock` 是异步长跑，不在等待窗口内，如实给 `registered:false`。

**`ExportSession` 互斥**：公共读写路径在同一个监视器（私有静态终态 `LOCK`）上同步，命令路径与 cp 路径共用这一把锁。世界扫描与 `jsonStringForScanCompare` 在锁外执行，只使用拷贝出的局部值。`snapshot()` 在同一临界区取走全部字段并返回不可变值对象。

### 7.7 L1 玩家操作（scene）

| 动作 | 语义 |
|---|---|
| `player.move` | 真实移动：逐 tick 走原版 AABB 碰撞推进并 `sendMotionUpdates()`（客户端发 C03），服务端照常校验 |
| `player.look` | 真实转向：分步设置客户端 yaw/pitch 并经 C03/C05 发给服务端；`yaw`/`pitch`、`lookAt`、`entityId` 三形态互斥必居其一 |
| `player.use_item` | 使用手持物品：对空气走 `sendUseItem`，对方块走 `onPlayerRightClick`；观察手持物品自身变化 |
| `player.interact` | 右键交互：方块走 `onPlayerRightClick`，实体走 `interactWithEntitySendPacket`；观察交互产物 |
| `player.dig` | 左键破坏：实体走 `attackEntity`，方块走 `clickBlock` + `holdTicks` 内的 `onPlayerDamageBlock` |
| `player.place_block` | 放置方块：`onPlayerRightClick` → 服务端 `activateBlockOrUseItem` → `ItemBlock.tryPlaceItemIntoWorld`；新方块出现在 `at` 沿 `side` 偏移一格处 |
| `player.pickup` | 拾取掉落物：玩家走过去碰它，由服务端 `EntityItem.onCollideWithPlayer` 收进背包 |
| `player.slot_click` | 容器与背包槽位收放：`PlayerControllerMP.windowClick` → 本地 `Container.slotClick` + `C0EPacketClickWindow`；`shift:true` 为移位点击 |
| `player.gui` | 开关玩家界面：`inventory` / `container` / `close` / `open`（只读报告） |

**共同口径**：

1. **只走原版玩家的出口**：`Minecraft.playerController` 与 `EntityClientPlayerMP` 的方法；不自拼 C0x 包、不直接写服务端世界或背包。
2. **写入门控同 L0**：九个动作开场过 `CaptureControl.assertWorldWriteAllowed`。
3. **观察由服务端权威侧回读**：`observed` 按服务端实读判定；客户端预测值只作对照（`clientAfter`/`predicted`）。
4. **失败显式**：参数类 `CP-VALID-002`、前置状态类 `CP-STATE-001`、原版意外 `CP-EXEC-001`。「执行了但世界没变」不是错误：返回 `observed:false` + `notObservedReason` + 逐格/逐槽回读。
5. **失败不导致进程重启或崩溃**：负场景返回可解释结果或契约错误码。
6. **两义成对**：返回值带 `layer:"L1"` 与 `semantics`（`walk`/`turn`/`use-item`/`interact-block`/`interact-entity`/`dig-block`/`dig-entity`/`place-block`/`pickup`/`slot-move`/`gui-*`）。位置与朝向、拿到物品两组与 L0 成对，结论注明取得层。
7. **槽号两义**：`player.slot_click` 的 `slot` 是当前 `openContainer` 的界面槽号（`Slot.slotNumber`，`-999` 为容器外）；`scene.inventory.write` 的 `slot` 是 `InventoryPlayer` 下标（0..8 快捷栏、9..35 主背包、36..39 盔甲）。两者不同，不得混用。
8. **同步动作、非步进**：一次调用内做有限步（`maxTicks`/`holdTicks` 有上界），不跨 tick 等世界装卸。
9. **平台边界**：包经集成服的本地 netty `LocalChannel` 送达，服务端在它自己线程的 tick 里处理；动作在读回前显式推送出站队列，但服务端「被拽回」一类判定只有在服务端 tick 后才可见，因此移动/拾取类动作如实返回当前读数与 `observed`。

**范围外**：GUI 内非槽位按钮点击（机器模式按钮、JEI 面板等）不由 `player.*` 承担，由 `input.*` 承载。两句限制分开成立：能定位并投递点击不等于命中控件（命中集每帧重建，`move` 后须等 ≥2 tick）；命中不等于业务后果发生（后者须由实机判据给出）。

### 7.8 导出族动作（scene）

| 动作 | 语义 |
|---|---|
| `export.scene` | 把 `ExportSession` 帧缓冲导出为场景文件并登记（`/sde export` 的 cp 等价）。在客户端 tick 线程一次写完，不经网络包。默认 `shape:"world"`（单帧即 N=1 的多帧文档）；`shape:"structure"` 恒裸单结构、仅允许单帧；`auto` 是既有隐函数形态，只用于命令通道的逐字节兼容 |
| `export.registry` | 请求客户端生成三份注册表并落本 run 的 `registry/`，逐份登记（`/sde dump` 的 cp 等价） |
| `export.multiblock` | 枚举 → 逐台变体捕获 → 因子化编码 → 逐台信封；产物落本 run 并登记（`/sde multiblock` 的 cp 等价） |

**产物单一归属**：每份产物有且只有一个落点 = 该动作 run 目录内的相对路径，并登记进该 run 的 `manifest.json`；不存在「原地一份 + 清单引用一份」的双态。

| 动作 | 产物（run 内相对路径） | role |
|---|---|---|
| `export.scene` | `export/<name>.json` | `scene-export` |
| `export.scene`（逐帧明细） | `export/frames/F<n>.json` | `scene-export-frame` |
| `export.registry` | `registry/block_registry.json`、`registry/material_registry.json`、`registry/model_registry.json` | `registry-block` / `registry-material` / `registry-model` |
| `export.multiblock` | `export/<slug>.multiblock.json` | `multiblock` |
| `export.multiblock`（报告） | `export/report.json` | `multiblock-report` |
| `export.multiblock`（数据集） | `export/_dataset/run-NNNN/**` | `multiblock-dataset` |
| `cmd.exec`（命令产物） | `cmd-exec/<name>.json` | `cmd-scene-file` / `registry-*` |

投递单 `registry/dump-request.json` 是内部件，消费后删除且从不登记。

**帧预算**（`export.scene`，扫描前计算，超限 `CP-VALID-002` + `context.fields` 且不写任何产物）：`maxFrames` 默认 64、上限 256；`maxCells` 默认 2000000、上限 48³×64。`context` 另含 `frames`/`maxFrames`/`volumePerFrame`/`volumeTotal`/`maxCells`/`computed`。

**`export.multiblock` 预算**：`globalBudgetMs`（默认 4h）是业务预算，超时后剩余机器进 `failures[]`；`maxVariantsPerMachine`（默认 20000）是单台上限，超限按 tierSample 抽样并收窄通道域，产物 `notes` 记录真实域。`totalTimeoutMs`/`stageTimeoutMs` 是作业看门狗。

**前置枚举事实**：本动作依赖 `multiblock_scan/run-NNNN/machines.json`（枚举事实层）。该文件不存在时报 `CP-STATE-001`；控制面当前没有生成它的自描述动作。

**录制世界校验**：`export.scene` 在 `onBegin` 比对帧内记录的 `captureWorld`（存档目录名 + 维度）与导出时刻活动世界，不符报 `CP-STATE-001` 且不写产物；几何按扫描身份（`cellTypes[ti]` 的 registryId/meta/NBT）烘焙，活动世界该坐标与扫描身份冲突即显式失败。每帧录制世界身份写进 `provenance.captureWorld` 与结果 `captureWorld`。

**同会话同缓冲**：`frameJson` 不因 `startSession`/`endSession` 清空；判定靠三点——`onBegin` 经 `bufferSnapshot()` 在同一临界区取走帧体与逐帧哈希；cp 通道产物写 `provenance` + `exportId`，全部 `frames[i].exportId` 彼此相等且等于根级；调用方用 `expectFrames` 显式声明帧集，不符即 `CP-STATE-001`（带 `expected`/`actual`/`extra`/`missing`）。

**与命令孪生的一致性**：三条链路各与命令孪生共用同一执行体——`export.scene` 与 `/sde export` 共用 `ExportSceneWriter`；`export.registry` 与 `/sde dump` 共用 `ExportBundleClient.writeFullRegistryDump`；`export.multiblock` 直接调 `MultiblockExportRunner.run`。其余动作没有命令孪生。

**工作台可见性**：工作台 `ExportsListPanel` 读 `structure_exports/`，看不到 cp 通道产物；消费方式是经 `GET /cp/v1/artifacts/{runId}/{path}` 下载后喂解析器（`export.scene` 结果的 `downloadPath` 即该 URL）。

**`case.run` 的 `export` 段**：只接受 `export.*` 动作（另允许 `cmd.exec` 与 `scene.player.pose`；`cmd.exec` 限成帧类子命令），不接受 `path`/`role`（落点由动作决定）。段位见 [case-file.md §1](case-file.md)。

### 7.9 收尾原语（scene）

`core.shutdown`：读 run 的两份结论（`criteria.json` 与 `evidence.json` 的 `overall`，任一份非通过即判失败）→ 按约定定退出码 → 默认延迟 `delayMs`（1500 ms）结束客户端进程，结果给 `exitScheduledInMs`。`dryRun:true` 只定码不退出。

| 码 | 含义 | 判定 |
|---|---|---|
| `0` | 判据全部通过 | 两份结论的 `overall` 均为 `green` |
| `2` | 有失败 | 任一份非 `green`（任何非 `green` 取值都判 2） |
| `3` | 设施错误 | 两份文件都不在、非法 JSON、缺 `overall`、runId/caseId 不可用 |

退出路径：`code == 0` 走 `Minecraft.shutdown()`；`code != 0` 走 `FMLCommonHandler.instance().exitJava(code, false)`；两条路都先挂 120 s 安全网线程。不使用 `Runtime.halt` / `System.exit`（FML 的 `FMLSecurityManager` 会拦掉非 `cpw.mods.fml.*` 发起的 `exitVM`）。该动作会让本作业后续段不再执行，故被 `case.run` 的 `action` 段拒绝（`CaseValidator.ACTION_FORBIDDEN`）。

### 7.10 输入手段族（scene / observe）

接口、参数、坐标、生命周期、状态机与能力清单的唯一权威是 [input-contract.md](input-contract.md)。

| 动作 | 级 | 语义 |
|---|---|---|
| `input.key` | scene（步进） | 把键事件投进游戏自己的输入队列；`action=down\|up\|tap`，`tap` 的 `holdTicks∈[1,1200]` |
| `input.mouse` | scene（步进） | 鼠标事件；`op=move\|relative\|down\|up\|click\|wheel` |
| `input.text` | scene（同步） | 逐字符投递文本；当前能力未就绪，任何非空请求一律 `CP-STATE-001` |
| `input.release` | scene（同步） | 全清本设施投递过的按下态（跨作业、幂等） |
| `input.state` | observe（同步） | 本族唯一的能力声明口：只读快照 |

本族返回值以 `means:"input"` 归因、`layer` 恒为 `null`（§7.7 第 6 条的显式例外）。四个可写动作是 `scene` 级，调用体必须带 `"confirm": true`；`input.state` 不需要。

## 8. 线程与执行模型

1. **HTTP 线程只做解析、鉴权、入队、读文件**，不触碰 MC 状态。
2. **动作在客户端 tick 线程执行**：`ControlPlaneTickHandler` 在 `TickEvent.ClientTickEvent` 的 `Phase.END` 排空作业队列；GL/截图类动作再转渲染通道。
3. **步进动作按工厂注册**（`registerStepping(desc, Supplier)`）：每个作业一个实例，作业内复用、收尾销毁。禁止有状态单例；已收尾或跨作业复用实例当场 `CP-EXEC-001`。
4. **同步动作**单次执行内完成；**步进动作**按 tick 推进，`totalTimeoutMs` 缺省 5 min、`stageTimeoutMs` 缺省 3 min，超时抛 `CP-EXEC-002`。
5. **`about` 等端点的 MC 相关字段由 tick 线程周期快照提供**。
6. **进度事件节流**：增量 ≥0.05 或间隔 ≥3 s 放行，终值 1.0 必放行。
7. **调用既有 runner（扫描/导出类）时强制 `exit=false` / `cleanupTrigger=false`**。
8. **与 `SdeWebServer`（`/sde web`，`/api/v1/*`）零共享可变状态**：不同端口、不同实例、不同鉴权域。
9. **日志前缀** `[SDE][CP]`。

## 9. 相机与渲染规则

1. **注入式相机**：渲染时用虚拟相机实体替换 `mc.renderViewEntity`，不传送真实玩家。1.7.10 的 TE 距离门（`TileEntityRendererDispatcher`）按 `renderViewEntity` 剔除 TESR，门值取各 TE 的 `getMaxRenderDistanceSquared()`（原版默认 4096 = 64 格）；AE2 缆几何走 ISBRH 块层渲染，不受该门约束。
2. **门控位置分离**：`observation.playerPos` 恒为真实玩家位置，`observation.camera.pos` 为机位，两者各自记录。
3. **投影**：逐机位独立，渲染帧内替换投影矩阵并在帧末还原。`fov` 合法域 5..110。
4. **超分拼接**：投影偏移 tiling（各 tile 用偏移投影矩阵渲染后像素级拼接），禁止视口拼接；`resolution` 指拼接后整图尺寸（每片 = `resolution/cols` × `resolution/rows`）；`overlap` 仅作接缝余量声明，不参与像素装配；`<name>.tiles/` 逐片落盘。
5. **执行线程**：shot/capture 类动作在客户端 tick 线程执行（1.7.10 单机 tick 线程即渲染线程），需要出帧时动作自行驱动 `EntityRenderer.renderWorld`；渲染故障报 `CP-EXEC-001` 并附摘要。
6. **光照与渲染模式**：`renderMode`/`lighting` 逐机位覆盖会话默认；v1 只留痕观测档位（`shots/<name>.meta.json` 含 `lightingApplied:false` 与 warning），不注入光照管线。
7. **世界时刻**：`worldTime` 决定拍摄光照基准，实际值落观测记录。
8. **`target` 参数**：v1 仅作观察目标留痕（bbox 进观测记录），不参与自动取景。
9. **`CameraSpec`**（`shot.multi` 与 `case.run` 的 `cameras` 段共用）： `{name, pos, yaw, pitch, projection{type:"perspective", fov} | {type:"ortho", orthoHeight}, resolution:[w,h], tile?{cols,rows,overlap}}`。`pitch` 语义为正值俯视、负值仰视（写进 `rotationPitch`）。

## 10. 托管世界规则

1. **托管世界判定**：存档目录名以 `cp_` 前缀且内含 `cp_world.json`（`{schema:"lightning.cp-world/1", seed, void, complete, createdBy, …}`）。对非托管世界的一切写操作拒绝（`CP-STATE-001`）。
2. **两个判据**：有标记（不论 `complete`）= 曾经开始过 ⇒ 可以删、可以重建（`assertDeletable`、`world.rebuild` 前置、`world.rollback`）；`complete:true` = 构建完成的成品 ⇒ 可以当成品复用（`world.snapshot`）。
3. **`complete:false`** 表示「可删可重建，但不得当作构建完成的世界复用」。拒绝复用时理由分列：无标记 = 非托管世界；有标记但未完成 = 构建未完成的世界。缺 `complete` 键按 `true` 读（向后兼容）；形态坏掉的取值按未完成读。
4. **虚空世界**：`WorldType.FLAT` + 空层预设（无基岩无土层），固定种子；构建基点由用例给定。
5. **幂等重建固定序**：离开 → 删除（二次确认）→ 标记前置（写 `complete:false`）→ 建/进世界 → build 段 → 静置 → 标记完成（改写 `complete:true`）并写场景清单。标记前置必须在进世界之前。
6. **TE 状态补全**：仅限场景构建阶段、捕获开始之前；必须经模组自身权威同步路径（如 `markBlockForUpdate` 触发 S35 description packet，或模组自己的 `initialize`/`addPart`/放置 API）；禁止逐字段从静态数据推算回填。补全器按族注册（接口 `TeCompleter`）：`vanilla` / `lp-pipe` / `ae2-part` / `gt-machine`，同一族名同时注册补全器与描述器。
7. **补全器自带放置后验证**：`complete()` 返回 true 必须等价于「世界上真有一个可 tick 的模组方块实体」。`gt-machine` 放置后读回 `getMetaTileID()`/`getMetaTileEntity()`，不符即 `CP-EXEC-001`；`GtMachineDescriber` 把同两项与 `shell` 布尔暴露给 `read.te` 与 `te-state-equals`。
8. **模组状态注入经模组自身 API**：GT 电池充电走物品自己的 IC2 `IElectricItemManager`（`scene.inventory.write` 的 `charge`，与 `nbt` 互斥；`count` 必须为 1）；给机器供电是把满充电池写进机器充电槽，不是改机器的 EU 缓冲。流体注入走 `IFluidHandler.fill`，不直接写 `MTEBasicTank.mFluid`。材料形态物品走 `OrePrefixes.getPrefix` + `Materials.get` + `GTOreDictUnificator.get`（与 GT 配方加载器同一路径）。
9. **AE2 缆块时序**：空缆块会在首个 tick 自毁（`TileCableBus.onReady`），用例中缆块的 `block` 步与其 `te` 步之间不得插入 `wait`/`clear` 等跨 tick 步骤（completer 对缺中心缆报 `CP-STATE-001`）。
10. **快照与回滚包含 TE 补全后的状态**，因此 `world.snapshot` 只接受 `complete:true` 的世界。
11. **玩家稳定化**：虚空世界进图后允许对玩家做最小稳定化（传送到构建基点上方、创造飞行），只动玩家实体，不进场景清单与哈希；`scene.player.pose` 是同一件事的显式化对应物。
12. **离图阻塞**：`mc.loadWorld(null)` 在 tick 线程内阻塞至集成服停机，客户端会冻结数秒到数十秒；动存档目录前必须保证 region 句柄释放。
13. **hermetic 纪律**：以「同参同世界、结论可复算」为前提的固定程序，其第一次世界写动作必须是 `world.rebuild`（`void:true`）或 `case.run` 的 `world` 段；两者共用 `WorldRebuildRunner`。L0 的轮内清场原语不构成 hermetic 保证。完整规则见 [case-file.md §8.8](case-file.md)。

## 11. 事件流水

1. 每条事件 `{seq, ts, level, kind, action?, jobId?, message, data?}`；`seq` 进程内单调递增，重启归零。
2. 内存环形缓冲（容量 4096）+ 追加写 `<mcDataDir>/controlplane/events.jsonl`。
3. `level` 取 `info` / `warn` / `error`。
4. `kind` 至少包含：`server-start`、`server-stop`、`action-submit`、`action-reject`、`action-start`、`action-progress`、`action-done`、`action-fail`、`world-rebuild`、`world-snapshot`、`world-rollback`、`case-segment`、`criteria-verdict`；命令通道另有 `cmd-exec`。新增 `kind` 只增不改义。

## 12. 观测记录与用例文件

每次 `case.run` 在 run 目录落 `observation.json`（schema `lightning.observation/1`），结构见 [observation-record.md](observation-record.md)。用例文件格式、段序、判据类型、变体、证据与产物比较口径见 [case-file.md](case-file.md)。场景文件格式见 [format-scene-file.md](../contracts/format-scene-file.md)。

## 13. 版本化规则

1. URI 前缀 `/cp/v1` 即契约大版本。
2. v1 内只允许增量：新增动作、新增可选参数、新增响应字段均可；不得改已有字段语义、不得删字段、不得收紧默认值。
3. 破坏变更开 `/cp/v2`。
4. 每个动作描述含 `since`（引入的契约小版本）；`GET /cp/v1/about` 报 `contractVersion`。`contractVersion` 必须 ≥ 任一动作的 `since`。
5. 版本按字符串/浮点比较，禁止出现 `1.10` 这类取值（会排到 `1.6` 之前）。
6. **当前契约版本：1.8。**

7. **向后兼容**：v1 内既有动作的 `since` 与字段语义不变；新增动作带自己的 `since`，调用方据 `since` 与 `contractVersion` 判断某项能力是否可得，不通过开关按版本切换行为。

8. `probeActive` 表示控制面自身忙闲（有作业在队或在跑），`probe` 恒为 `null`。

## 14. 架构约定

1. **包** `com.lightning.mod.client.controlplane`，分两层：
   - `core/`：零 MC 依赖（JDK + Gson），含 HTTP 服务、路由、动作注册表、作业队列、事件缓冲、错误信封、产物登记、用例模型与解析、判据引擎；
   - `mc/`：MC 绑定层，含 tick 排空、世界动作、场景构建、TE 补全器与描述器、观测记录采集、配置装配、动作自描述注册。
2. **启动**：`ClientProxy.initNetwork()` 按配置启动；**关闭**：JVM shutdown hook（无 FML 客户端停止事件可用）。
3. 控制面是唯一驱动世界的自动化，`ControlPlaneTickHandler` 内没有避让其它链的分支。
