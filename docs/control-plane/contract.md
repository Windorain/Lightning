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

### 2.1 参数类型与 `TYPE_INT` 取值口径（Gitea #131）

自描述里每个参数都有 `type`（`string` / `int` / `number` / `boolean` / `object` / `array` / `path`）。
**类型即判据：不做隐式转换。** 其中 `int` 的取值口径原先走 gson 的宽松取值，会把
`1.5` 截断成 `1`、把 `"3"` 解析成 `3`、把 `true` 当成 `1`（**且不报错**）——调用方写了 `1.5`、
动作按 `1` 执行并回报 `1`，是一处全动作面的静默失真（Gitea #131）。

**接受 / 拒绝对照表**（`TYPE_INT`，与 `Json.strictInt` 的实现同源）：

| 入参 | 判定 | 说明 |
|---|---|---|
| `3` | **接受** | 精确整数 |
| `3.0` | **接受** | 数值，且值精确为整数（`3.0 == 3`） |
| `-7` | **接受** | 负整数 |
| 键不存在 | **接受** | 视为「未提供」⇒ 用自述里的 `default`（无 `default` 则用动作内部默认） |
| `null`（显式） | **接受** | 同样视为「未提供」⇒ 默认值（`Json.get` 的口径：JSON null 与缺键同义） |
| `1.5` / `-0.5` | **拒绝** | `CP-VALID-002`：非整数数值，**不截断** |
| `true` / `false` | **拒绝** | `CP-VALID-002`：布尔不做 `0/1` 转换 |
| `"3"` | **拒绝** | `CP-VALID-002`：字符串数字不解析 |
| `2147483648`（超 int） | **拒绝** | `CP-VALID-002`：超出 `int` 可表示范围 |
| `{...}` / `[...]` | **拒绝** | `CP-VALID-002`：类型不符 |

拒绝时错误形状（与既有参数校验同码同形）：

```jsonc
{
  "code": "CP-VALID-002",
  "message": "参数类型不符: margin 期望 int（精确整数），收到 1.5（类型 number）",
  "context": {
    "fields": [{ "field": "margin", "reason": "期望精确整数，收到带小数的数值 1.5（不做截断）",
                 "received": "1.5", "receivedType": "number", "expected": "int" }],
    "hint": "TYPE_INT 参数要求 JSON 数值且值精确为整数（如 3 / 3.0）；不接受小数、字符串数字与布尔（契约 §2.1，Gitea #131）。确实需要小数请改用声明为 number 的参数"
  }
}
```

**行为变更声明（契约 1.7 内收紧，不升版本）**：改前 `read.run limit:1.5` 返回 exit 0（回显 `1`）、
`capture.diag maxEvents:1.5` 静默截断成 `1`；改后两者都是 `CP-VALID-002`。
依赖旧强转的调用方必须显式传整数——这是本收口批次「不许静默强转」的裁决产物。

**未覆盖（如实登记）**：`array` 参数**元素**的整数口径由各动作自定（例如 `at`/`pos`/`to` 允许小数，
`frames:[int...]` 已按本表收紧）；本表只约束声明为 `int` 的**参数**本身。

### 2.2 动作自描述的字段集合（G8，v1.8 起有离线防线）

`GET /cp/v1/actions` 每个元素的字段集合是**冻结**的：

| 字段 | 必现 | 说明 |
|---|---|---|
| `name` / `tier` / `writable` / `confirmRequired` | 是 | 动作名、权限级、是否可写、是否需要 `confirm` |
| `description` / `params` / `returns` / `examples` | 是 | 说明、逐参数自述、返回结构说明、可复制示例 |
| `since` | 是 | 引入的契约小版本 |
| `means` | **否（可选）** | **手段归因**（v1.8 新增，Gitea #165）：这个动作是**怎么把事做进去**的 |

**`means` 的三条硬规则**（写进契约的理由：不写规则，调用方只能靠猜）：

1. **不设默认值**。缺省时该键**不出现**，且「不出现」**不等于**任何默认值——把「未声明」读成
   「已具备某个默认值」是本契约明令禁止的默认类（`input-contract.md` §11.2 第 17 条）。
   正因如此，本字段对既有动作的自描述 JSON 是**逐字节无影响**的增量。
2. **只在承担了归因义务的动作上写**。v1.8 写它的只有输入族（`input.*`，值 `"input"`）——
   它们确实把事件投进**游戏自己的输入队列**、由游戏路由，而不是语义 API 直调。
   为既有动作逐条裁决归因是**另一次独立改动**，不能靠一个批量默认值就地完成。
3. **与返回值侧的 `means`/`layer`/`semantics` 并列，不替代**（§4.12 与 `input-contract.md` §10.3）。

**离线防线（G8）**：字段集合由 `InputRegistrationTest` 逐动作断言——既有动作的集合必须逐字不变，
输入族只多 `means` 一个键。没有这道防线时，给 `means` 加一个默认值会让 43 个动作的自述
**静默**全变，而既有断言（动作总数、版本单调、逐参数默认值）一条都拦不住
（这正是 `input-contract.md` §9.4 登记的风险，本批已消除）。

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

## 4. 动作清单

> **数量口径（D3 漂移防线）**：本表按引入批次分节；**权威动作数**以实机
> `GET /cp/v1/actions` 的 `count` 字段为准。契约 **1.8** 共 **48 个**动作：
> 本节 8 个（PR-1）+ §4.1 的 9 个读面（#98 的 8 + #114 的 `read.capture`）+ §4.2 的 3 个取证（PR-2）
> + §4.4 的 7 个 L0（#99/#122）+ §4.5 的 2 个命令通道（#100）+ §4.6 的 9 个 L1（#101）
> + §4.9 的 1 个收尾原语（#103）+ §4.7 的 3 个导出族（#102）+ §4.11 的 1 个捕获诊断（`capture.diag`）
> + §4.12 的 5 个输入手段族（#165）。
> 历史上本标题曾写「v1，PR-1 交付」而表外另有动作，导致目录与文档不一致（Gitea #97 §5-D3）——
> 新增动作时**必须**同步本节计数。
>
> **版本沿革**：1.3 由 #98（读面）与 #99（L0）并轨占用（调度者裁决）；
> #100 取 **1.4**（撞号裁决 1）；#101 自报 1.4 与 #100 撞号，合流统一为 **1.5**；
> #103 取 **1.6**；**收口批次裁决**：#102/#114/#122/#123 四单并行、各自开号必然撞号
> （#114 与 #102 同报 1.7、#122 自报 1.6 与 #103 冲突），统一取 **1.7**；
> #165（通用玩家输入）取 **1.8**；
> 并禁止出现 `1.10` 这类值（版本按字符串/浮点比较，`1.10` 会排到 `1.6` 之前）。
> 小版本只增不改义（§5）。

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

v1.3（issue #98）追加的观察面读面动作见 §4.1；v1.4（issue #100，收口T3）追加的命令通道动作见 §4.5；
v1.5（issue #101，收口T4）追加的 L1 玩家操作见 §4.6；v1.6（issue #103，收口T6）追加的收尾原语见 §4.9；
v1.7（收口批次，调度者裁决）追加的导出族见 §4.7（issue #102）；同一批次里**不新增动作**的契约增量
（托管世界标记前置与 `complete` 状态机、`world.info` 的 `markerComplete`、`world.snapshot` 只接受成品）
见 §6.1/§6.6（issue #123）；
下表是 PR-1 的动作清单，追加不改已有语义。

PR-2 追加取证级动作（下表），PR-3 追加双轨判据；追加不改上表已有语义。
**#99（收口T2）追加 6 个 L0 布景原语**（`scene.*`，见 §4.4），同样只增不改上表语义。
**#101（收口T4）追加 9 个 L1 玩家操作**（`player.*`，见 §4.6），同样只增不改上表语义。
**#122 追加 1 个 L0 流体注入原语**（`scene.tank.fill`，见 §4.4），同样只增不改上表语义。
**#102（收口T5）追加 3 个导出族动作**（`export.scene`/`export.registry`/`export.multiblock`，见 §4.7），
同样只增不改上表语义；该单同时把 `cmd.exec` 的 `artifacts[]` 升级为「登记进 run 清单（带 sha256）」。
**#165（通用玩家输入）追加 5 个输入手段族动作**（`input.key`/`input.mouse`/`input.text`/`input.release`
四个 `scene` 级可写动作 + `input.state` 只读观察面，见 §4.12），并新增可选自描述字段 `means`（见 §2.2）；
同样只增不改上表语义。

### 4.1 观察面读面动作（v1.3，issue #98）

「Agent 必须有『看』的能力，不只有截图」（需求书 §5）。下表九个动作**全部 `observe` 级、全部只读、
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
| `read.capture` | observe | **捕获通道自证诊断读数**（v1.7，#114）：三通道计数（`channels.*.windows/quads/zeroFlowWindows`）、`directTessellatorHookActive`、按格归属（`quadsByAttr`/`quadsByBin`）、逐窗口 zeroFlow 事件、自证日志。数据源是 `CaptureDiagnostics.toJson()` 唯一落点。可选 `channel`（默认 all）、`events`（默认 true）、`maxEvents`（默认 64，上限 512）。**未采集是显式空态**（`collectionState`）而不是编造数据——详见 §4.10 |

**哈希口径（`read.blocks` / `read.diff`）**：`sha256(canonical({"blocks":[{"pos","blockId","meta"}…]}))`，
`blocks` 按 `(x,y,z)` 升序、`pos` 为 `[x,y,z]`，无空白、键排序（`Json.canonical`）。
**与场景清单哈希的关系（可互算，不是恒等）**：场景清单的口径是
`{blocks:[{pos,blockId,meta}], tileEntities:[{pos,class}]}`（case-file.md §8.7）。
区域读回刻意**不含** `tileEntities`——含了它，「同一区域两次读回同不同」就混进了「该不该在这一格有 TE」
这个额外变量，而该变量由 `read.te` 与场景清单各自独立回答。
因此：读回整片区域并把结果排序后作为 `blocks`、附上同一批位置的 `tileEntities`，即得场景清单的哈希子集。
**判据只用一处的定义**：`world-hash-equals` 的脚本口径与 `read.diff` 的 `hashes` 都由
`ReadSupport.hashSubsetOf` 产出，不存在第二套哈希实现。

**只读性（验收 B1）**：九个动作的调用前后**世界清单哈希不变**（实测，见证据）。
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
| `shot.multi` | forensic | 多机位截图：参数 `{cameras:[CameraSpec], target?:bbox, lighting?:natural\|neutral-flat, renderMode?:本色\|参与光照, worldTime?, gui?:"none"\|"screen"}`。每机位产 `shots/<name>.png`（拼接机位另产 `shots/<name>.tiles/` 与 `shots/<name>.meta.json`），全部产物登记哈希；观测记录按机位更新 camera/projection/lighting/renderMode。**`gui`（v1.8 起，Gitea #164）**：缺省 `"none"` = 不拍 GUI（只拍世界，返回 `guiHidden:true`）；`"screen"` = 拍**真实 framebuffer GUI 画面**（返回 `guiHidden:false`，并在 `guiCapture[]` 里登记产物）。该参数是**字符串**、不是布尔：取值域外（含布尔、数字、对象）一律 `CP-VALID-002`——它曾因 gson `JsonPrimitive` 被当 `String` 而**从未真正可用**（#193），故此处显式写明口径 |
| `capture.begin` / `capture.end` | forensic | 捕获会话包围：begin 后禁止一切世界写动作（违规 CP-STATE-001），end 释放；`case.run` 的 capture 段自动包围 build 之后、shots 之前的区间 |

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

> **引用口径（2026-10 收口核对）**：本节九条是**编号列表项**，不是 `####` 小节 ⇒ **不存在** `§4.3.1`/`§4.3.2`/… 这样的锚点。仓库另有一批注释与文档写「contract §4.3.x」（源码如 `CameraSpec.java:100`、`ReadPlayerAction.java:34`、`CaptureDiagSession.java:42`、`CaptureRenderState.java:27`、`CameraSpecs.java:121`、`ShotExecutor.java:143`，文档如 `scripts/control-plane/README.md:330/334/379`）——那些编号在本契约里**没有对应标题**，正确指向是本节的列表项 1..9（或 §4.5.x 的命令通道小节）。
> **本单（#105）只订正了 §4.5 下被错编成 `4.3.x` 的六个小节标题**（现为 §4.5.1…§4.5.5）与指向它们的引用；上述批注释引用**未逐一改**（横跨源码/脚本/多份文档，且是既存缺陷、非本单引入）——登记为开放项，待新单统一（相关需求单 #136）。

### 4.4 L0 布景原语（#99，「收口T2」；#122 追加流体注入）

能力面三层口径见 #96 §4.1：**L0 原语**＝直接设定世界/实体/玩家/背包状态（布景、构造输入、常规回归）；
**L1 玩家操作**＝经玩家路径执行；**L2**＝L0/L1 的有序编排。**L0 的产物不能当作 L1 的证据**（#96 §4.2）。

| 动作 | 级 | 语义 |
|---|---|---|
| `scene.entity.spawn` | scene | 生成实体（含掉落物）。`item` 造掉落物、`entity` 造一般实体，二者互斥必居其一；可带 SNBT `nbt` |
| `scene.entity.clear` | scene | 清除范围内实体（含掉落物）。选择条件 `box`/`entity`/`item` 取交集；`includePlayers` 默认 false |
| `scene.player.state` | scene | 玩家游戏模式 / 生命 / 经验 / 药水效果（`before`/`after` 双快照） |
| `scene.inventory.write` | scene | 逐槽写入玩家背包或世界容器（`{slot,id,meta,count,nbt}`）——「拿到物品」之**给**。模组权威取物/充电三种写法（#117/#122）：`{slot,battery:"<GT ItemList 常量>"}` 由 GT 自己的清单决定物品与 meta；`{slot,battery,charge:"full"\|"empty"\|<EU>}` 经物品自己的 IC2 `IElectricItemManager` 充放电（`charge` ⟂ `nbt`，见 §6.5）；**#122 追加** `{slot,material:"<GT 材料名>",prefix:"<OrePrefixes 形态名>"}` 由 GT 自己的 ore dict 统一化路径产出物品与 meta（`material` ⟂ `id`/`battery`/`meta`）。把满充 GT 电池写进机器充电槽即「给机器供电」 |
| `scene.weather.time` | scene | 设定世界权威时刻与天气（持续生效；`shot.multi.worldTime` 是拍摄基准，两义不同） |
| `scene.player.pose` | scene | 瞬时传送/转向——L0 布景原语，与 #101 的 L1 真实移动互补、两义按层标注 |
| `scene.tank.fill` | scene | **流体注入**（#122）：`{at,fluid,amount,side?}`，经 `IFluidHandler.fill` 向指定位置的机器/储罐注入流体。补的是「拿到物品」碰不到的那一半——`scene.inventory.write` 只碰 `IInventory`，而 GT 机器的流体口是内部储罐（`MTEBasicTank.mFluid`），槽位表里没有流体槽。`filled` = `fill` 的实际返回值（**部分注入如实报告**，`partial:true`）；`dryRunFillable` = 一次 `fill(...,false)` 干跑（不改状态），把「返回 0」的两种原因分开。`fluid` 接受 Forge 注册名或 GT 材料名（`_GT5U` 后缀不敏感）；`amount` 无默认值 |

**共同口径（六条，全部可判定）**：

1. **只写服务端权威世界**（`MinecraftServer.worldServers[0]`，见 `mc.scene.L0Session`）。
   客户端 `WorldClient` 是只读投影：写它会被原版同步覆写（方块/实体/时间/天气皆然）。
   这与 `world.rebuild` 的场景构建、`world.info` 的元数据、`shot.multi` 的光照基准同一口径。
2. **同步一律走原版出口**：`S2BPacketChangeGameState(3)`（游戏模式）/ `S06PacketUpdateHealth`（生命）/
   `S1FPacketSetExperience`（经验）/ `S1DPacketEntityEffect`（药水）/ `S08PacketPlayerPosLook`（传送）/
   `S2FPacketSetSlot`（背包槽位）/ `S3PacketTimeUpdate` + `S2BPacketChangeGameState(7,8)`（时间天气）。
   **不自造同步、不逐字段从静态数据推算回填**（§6.4 的既有禁令对 L0 同样成立）。
   `scene.tank.fill`（#122）走**模组/原版自身的注入 API** `IFluidHandler.fill`——
   GT 的 `BaseMetaTileEntity` 自己实现它（`IGregTechTileEntity extends IFluidHandler`），
   **不**直接写 `MTEBasicTank.mFluid` 字段（那是逐字段回填，与「给机器供电必须把电池写进充电槽
   而不是改 EU 缓冲」同一条纪律）。
3. **写入门控**：七个动作开场一律过 `CaptureControl.assertWorldWriteAllowed`——捕获会话期间被
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
`scene.player.pose` 返回 `layer:"L0"` + `semantics:"teleport"`；
`scene.tank.fill`（#122）返回 `layer:"L0"` + `semantics:"fill"`。三者的 `layerNote` 字段写明
「与 #101 的 L1 对应动作互补而不互替」。

**储罐读回（#122）**：`scene.tank.fill` 的返回值自带注入前后的 `before`/`after`（逐罐
`{index,present,capacity,fluid,amount,empty}` + GT 侧单值读数），用例侧的读回走 `read.te` 的
`tanks` 字段（`GtMachineDescriber` 暴露 `getTankInfo` 与 GT 侧单值读数）
——与 `te-state-equals` 判据**同一棵树、同一读取口**。`scene.tank.fill` 是「机器里有没有这个流体」
的证据，**不是**「玩家/管道把流体运进来了」的证据（后者属 L1/L2）。

**读数口径三条（#122 实机证伪后成文，读错会造出假绿）**：

1. **输入侧的权威读数是逐罐 `tanks[]`（`/tanks/tanks/<i>/amount`）**。断言「注入进去了多少」用它。
2. **`drainableFluid`/`drainableFluidAmount` 是「输出/可排出」那一侧**，不是输入罐：
   `MTEBasicTank.getFluid() → getDrainableStack()`（`:195-197`），
   而 `MTEBasicMachine.getDrainableStack() → mFluidOut`（`:455-457`）。
   实机实测：入口注 HCl 3000 后它是 `null`/`0`，配方跑完后才变成 `trichlorosilane`/`1000`。
   **不要**拿它断言「注入成功」——0 会被误读成「没注进去」。
3. **容量取 `/tanks/metaTileCapacity`（= MTE 的 `mTankCapacity`，LV 化学反应釜 = 16000），
   不要取方块实体的 `getCapacity()`**——后者返回 `(int) min(MAX, getEUCapacity())`
   （`BaseMetaTileEntity.java:1997-1999`）= **EU 缓冲容量 2048**，是一个「看起来像储罐容量」的错数字
   （#122 实机首轮实测到的 D-1）。

**SNBT 口径**：`nbt` 参数是 **SNBT 文本**（原版 `/give`、`/summon` 的写法，
即 `net.minecraft.nbt.JsonToNBT`），**不是 JSON 对象**——两者语法相近但不同（SNBT 字符串值可裸写、
有 `1b`/`1.0f` 数字后缀）。自述与示例里写死这一点。

`CameraSpec`（`shot.multi` 与 `case.run` 的 `cameras` 段共用；机位级 `renderMode`/`lighting`/`worldTime` 覆盖见本节第 6 条）：

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

### 4.5 命令通道动作（v1.4，收口T3，Refs #100）

| 动作 | 级 | 语义 |
|---|---|---|
| `export.session` | observe | **只读**：返回 `ExportSession` 单例态的一致性快照（会话开关/选区模式/pos1/pos2/规范化 min-max 与尺寸/活动帧/已录帧号/**逐帧内容 sha256**/**缓冲世代号**/输出名/structureId/最近作者）。唯一触碰 `ExportSession.snapshot()`（同一临界区取全部字段）；不写状态、不碰世界与文件、不建 run 目录，世界清单哈希不变。`statusLine` 字段与 `/sde status` 打印的那一行同源同形 |
| `cmd.exec` | scene | 在**服务端线程**执行一条**白名单内**的 `/sde` 子命令，返回该命令的真实回报文本（与游戏内手动执行同一命令逐字相同）。参数 `{command, timeoutMs?}`。白名单外一律 `CP-VALID-002` + 原因 + `context.alternatives[]` 可行替代 |

#### 4.5.1 `/sde` 命令白名单（1.4）

白名单是**显式枚举**（唯一权威：`client/controlplane/mc/cmd/SdeCommandWhitelist.java`），**未登记即拒绝**——新增子命令必须显式登记，不做默认放行。

**准入（15 条）**：`pos1` `pos2` `hpos1` `hpos2` `sel` `start` `end` `setname` `setframe` `setstructureid` `record` `export` `multiblock` `dump` `status`。
其中只有 `status` 是 `observe` 级（纯只读），其余 14 条均为 `scene` 级。

**排除（4 条，附理由）**：

| 子命令 | 排除理由 |
|---|---|
| `web` / `webstop` | 内置工作区 HTTP 服务的启停，**涉及端口占用**；该服务与控制面是并列的两套 HTTP/鉴权域（本文 §9 要求零共享可变状态），经本通道放行等于开一条绕过控制面鉴权与事件流水的**隐藏能力路径**（#96 §8.7）。需要时在游戏内手动执行 |
| `hajimi` / `hjm` | 「设输出名 → record → export → 发客户端」四步合一的**复合快捷方式**，不提供任何其余子命令没有的能力，却把四个动作压成不可分步、不可单独审计的原子操作，违反 #96 §8.2「命令不扭曲行为」。请改用 `setname` / `record` / `export` 原语组合 |

#### 4.5.1.1 `export.session` 的 C3 判据字段（派发裁决 3：只增不改）

为「同会话同缓冲」机械判据（#102 的 C3）补两个**只增不改**字段——**不**引入隐式清缓冲、
**不**改变任何命令态行为：

| 字段 | 口径 | 用途 |
|---|---|---|
| `frameSha256[]` | 与 `recordedFrames[]` **同序一一对应**；哈希对象是该帧**进入缓冲那一刻**的 JSON 文本的 UTF-8 字节（`Hashing.sha256HexUtf8`，与 observation-record.md §2.1「对字节内容计算」同口径）。注意：哈希的是**缓冲内**的 scan 中间态，**不是**落盘后经客户端 enrich 的信封（两者形态不同，见 §4.5.4） | 跨会话拼接的产物其帧哈希落在不同缓冲，可据此判红（C3 负对照） |
| `bufferGeneration` | 帧缓冲每发生一次结构性变化（写入帧 / 清空）即递增的世代号 | 廉价判断「缓冲有没有动过」（比逐帧哈希更省事）；想判断「动成了什么」才需要 `frameSha256[]` |


#### 4.5.2 `cmd.exec` 的线程语义

1. 命令在 1.7.10 集成服的 **`Server thread`** 上执行（`MinecraftServer.getCommandManager().executeCommand(...)`），与玩家在聊天框敲命令**同一路径、同一线程**；本动作不自己实现任何命令语义，不在命令前后追加或跳过任何步骤（#96 §8.2）。
2. cp 动作在 **`Client thread`**（tick 排空）调用并**阻塞等待**回包，等待方向单一（客户端等服务端），结构上不会死锁。
3. 命令的**发送者是真实服务端玩家**（`EntityPlayerMP`）：`/sde` 多个子命令要求其为玩家（读坐标/准星/世界/OP 权限），例如 `pos1`/`hpos1`/`record`/`export`/`multiblock`。无服务端玩家时以 `CP-STATE-001` 显式失败，**不**用假发送者制造「通道可用但什么都干不了」的假通过。
4. **回报**取命令真实写给玩家的聊天文本（原样，含 `SDE: ` 前缀），并按序转发给玩家——玩家在聊天框看到的与手动执行完全一致。

#### 4.5.3 `cmd.exec` 的失败码

| 情形 | 错误码 | context |
|---|---|---|
| 白名单外（含 `web`/`webstop`/`hajimi`/`hjm` 与任意非 `/sde` 命令） | `CP-VALID-002` | `command`/`root`/`sub`/`decision`/`reason`/`alternatives[]`/`fields[]` |
| 无服务端玩家（未进世界 / 集成服未起） | `CP-STATE-001` | `command`/`sub`/`hint` |
| 等待服务端回包超时 | `CP-EXEC-002` | `command`/`sub`/`timeoutMs`/`elapsedMs` |
| 命令在服务端抛异常 | `CP-EXEC-001` | `command`/`sub`/`exception` |
| 参数非法（缺 `command` / 超长 / `command` 非字符串） | `CP-VALID-002` | `fields[]` |

#### 4.5.4 `cmd.exec` 的审计口径

每次调用（**含拒绝**）落一条 `kind=cmd-exec` 事件，`data` 携带：
`commandText`（提交原文）、`command`（归一化文本）、`root`、`sub`、`allowed`、`decision`、`tier`、`whitelistVersion`、`timeoutMs`；
执行类另带 `status`（`ok`/`no-server`/`timeout`/`exception`）、`executedOnThread`、`serverTick`、`elapsedMs`、`reply`（回报全文）、`artifacts[]`。

**产物口径（裁决 6，v1.6 起由 #102 落地）**：`export` / `dump` 的产物由 `cmd.exec` **复制/登记进它自己 run**
的 `cmd-exec/` 子目录并登记 sha256（`artifacts[{role,path,exists,registered,sha256,bytes,note}]`）——
run 由**发起方**（`cmd.exec`）持有，落点由它给出（§4.7.2-B 的投递单）。因此 C5
「命令通道产生的场景文件同样可发现可核对」成立，且 D2 两侧都有哈希可比。
`multiblock` 是异步长跑（客户端 tick 在主菜单后执行），不在 `cmd.exec` 的等待窗口内，故它如实给
`registered:false` + 原因（要它进清单请用 `export.multiblock`）。

> **搬迁前的口径（#100，已废止）**：产物落 CWD 相对路径 `structure_exports/`，`cmd.exec` 只声明
> `{role,path,exists,note}` 而不登记 run 清单条目。老路径 `structure_exports/` 在 v1.6 仍服务
> 尚未搬迁的命令通道，其删除归 #104。
>
> **已知事实（如实记录，非缺陷）**：`runClient` 下服务端 `exportToFile()` 与客户端 enrich
> （`MeshCaptureService`）写的是**同一目录同一文件**，客户端随后覆盖服务端产物。这是
> `CWD == mcDataDir` 的产物，形态依赖该巧合；换启动方式（工作目录不同）会静默产出两份不同形态的文件。
> cp 通道（`export.scene`）**回避这条链**（客户端一次写完，不经过网络包），从根上消掉二义。

#### 4.5.5 `ExportSession` 的线程语义与互斥口径（裁决 13）

`ExportSession` 是**进程级单例**，在集成服里被至少三条线程触碰：`Server thread`（`/sde` 命令、`SdeServerRecordScheduler` 连录/cycle）、`Client thread`（cp 动作、`ItemSde*` 工具物品、`PacketSaveCellNoteHandler`）、以及经作业队列间接触达的 HTTP 提交方（HTTP 线程本身**不**触碰它，见 §1.8）。

**互斥口径**：全部**公共**读写路径在**同一个**监视器上同步——`ExportSession` 的私有静态终态 `LOCK`（`synchronized (LOCK)`，**不**用 `synchronized` 方法或 `synchronized(this)`）。这一把锁同时覆盖命令路径与 cp 路径，因此调用方无需各自加锁，也不存在「谁忘了加锁」的缺口。

**故意不加锁的两处**（不是遗漏）：

1. `scanToStructureJsonOnly` 的**世界扫描**：只把「读走选区六值 + 采样口径 + 结构 id」放进锁，扫描本身在锁外执行。扫描按区块遍历世界（可达数百毫秒），整段持锁会堵住服务端连录与 cp 只读快照——这正是「命令执行期间 cp 读面与世界动作不死锁」的实现依据。扫描只用拷贝出的局部坐标，与单例后续写入无共享状态。
2. `jsonStringForScanCompare`：只序列化**调用方传入**的局部对象，不读任何字段。

**快照读面**：`snapshot()` 在同一临界区内取走全部字段并返回**不可变**值对象，供 `export.session` 与 `cmd.exec` 的 `sessionAfter` 使用——逐调 getter 会拿到互相矛盾的组合（如「选区已变、帧列表还是旧的」），这是「读面必须可判定」的前提。

### 4.6 L1 玩家操作（v1.5，#101，「收口T4」）

能力面三层口径见 #96 §4.1：**L0 原语**＝直接设定世界/实体/玩家/背包状态（布景、构造输入、常规回归）；
**L1 玩家操作**＝**经由玩家路径执行**（移动、朝向、使用物品、右键、左键、放置、拾取、容器与背包收放、开关界面）；
**L2**＝L0/L1 的有序编排，且只有 L2 允许宣称「端到端」。
**L0 的产物不能当作 L1 的证据**（#96 §4.2）；每条结论声明它在哪一层取得，不同层的结论不互替。

| 动作 | 级 | 语义 |
|---|---|---|
| `player.move` | scene | **真实移动**：逐 tick 走原版 AABB 碰撞推进 + `EntityClientPlayerMP.sendMotionUpdates()`（客户端自己发 C03）；服务端照常校验（姿态 / moved too quickly / moved wrongly / floating），被拽回时如实报告两侧读数 |
| `player.look` | scene | **真实转向**：分步设置客户端 yaw/pitch 并经 C03/C05 发给服务端；支持 `yaw`/`pitch`、`lookAt:[x,y,z]`、`entityId` 三形态（互斥必居其一） |
| `player.use_item` | scene | **使用手持物品**：对空气走 `PlayerControllerMP.sendUseItem`（C08 的 `(-1,-1,-1,255)` sentinel），对方块走 `onPlayerRightClick`；观察量是**手持物品自身的变化**（count/耐久/NBT） |
| `player.interact` | scene | **右键交互**：方块走 `onPlayerRightClick`（`onItemUseFirst` → `onBlockActivated` → `tryPlaceItemIntoWorld`），实体走 `interactWithEntitySendPacket`（C02(INTERACT)）；观察量是**交互产物**（容器被打开 / 方块被激活 / 实体被移除） |
| `player.dig` | scene | **左键破坏**：实体走 `attackEntity`（C02(ATTACK)），方块走 `clickBlock`（C07(0)）+ `holdTicks` 内的 `onPlayerDamageBlock`（C07(2)），即原版按住左键的同一入口 |
| `player.place_block` | scene | **放置方块**：`onPlayerRightClick` → 服务端 `activateBlockOrUseItem` → `ItemBlock.tryPlaceItemIntoWorld`；`at` 是**被右键的方块**，新方块出现在 `at` 沿 `side` 偏移一格处（原版规则） |
| `player.pickup` | scene | **拾取掉落物**（「拿到物品」之 L1 义，裁决 4）：世界里已有掉落物 → 玩家走过去碰它，由服务端 `EntityItem.onCollideWithPlayer → InventoryPlayer.addItemStackToInventory` 收进背包 |
| `player.slot_click` | scene | **容器与背包槽位收放**：`PlayerControllerMP.windowClick` → 本地 `Container.slotClick` + `C0EPacketClickWindow`；服务端 `processClickWindow` 跑权威 `slotClick`。**含移位点击**（`shift:true` ⇔ `clickType:1`） |
| `player.gui` | scene | **开关玩家界面**：`inventory`（复刻原版 `keyBindInventory`：C16 + `GuiInventory`）/ `container`（复用 `player.interact` 的右键路径，服务端 `S2DPacketOpenWindow` → 客户端 `displayGuiScreen`，模组机器界面同样可用）/ `close`（`EntityClientPlayerMP.closeScreen()` = C0D）/ `open`（只读报告） |

**共同口径（逐条可判定）**：

1. **只走原版玩家的出口**：本组只调原版对象自己的方法——`Minecraft.playerController`
   （`clickBlock` / `onPlayerRightClick` / `sendUseItem` / `attackEntity` /
   `interactWithEntitySendPacket` / `windowClick` / `onPlayerDamageBlock`）与
   `EntityClientPlayerMP`（`sendMotionUpdates` / `closeScreen` / `moveEntity`）。
   **不自己拼 C0x 包、不直接写服务端世界或背包**。抄一份「看起来一样」的服务端逻辑会立刻与
   真客户端行为分叉，而分叉正是 L1 要验证的东西；那也正是 §8.7 禁止的第二条能力路径。
2. **写入门控同 L0**：九个动作开场一律过 `CaptureControl.assertWorldWriteAllowed`
   （捕获会话期间被*别的*作业调用即 `CP-STATE-001`，§4.1 的既有口径）。
3. **观察由服务端权威侧回读**：返回值里的 `observed` 一律按**服务端**的实读判定
   （`serverAfter` 位置、逐格 `blockId/meta`、`openContainer`、背包逐槽），
   客户端预测的位置/槽位只作对照（`clientAfter` / `predicted`）。
   **客户端动了而服务端没动 = 没观察到**，不是「大体上成功」。
4. **失败显式（§8.5）**：参数类 `CP-VALID-002`（`context.fields` 逐字段）、前置状态类 `CP-STATE-001`
   （带「差什么、怎么补」）、原版抛出意外 `CP-EXEC-001`（带 cause，栈不丢）。
   而「玩家路径执行了但世界没变」**不是错误**：返回 `observed:false` + `notObservedReason`
   （逐条列可能原因）+ 逐格/逐槽回读。**不静默成功、不空转绿**——
   「点了没反应」与「动作失败」是两件事，自述与返回值都分开说。
5. **探索模式纪律（#96 §3，「便宜试错」的物质基础）**：L1 操作失败**不得导致进程重启或崩溃**。
   典型负场景——对空气右键、挖不动基岩、视线未命中就左键、手空着放置、没开容器就点槽位——
   一律返回上述形态的可解释结果或契约错误码，进程继续可用。
   这也是本组**一次调用内跑完一小步、不注册为步进动作**的理由：调用方在两次调用之间可以自由
   读面、截图、回滚（状态转换由请求驱动，§8.4）。
6. **两义成对、按层标注（裁决 3/4）**：每个动作返回值带 `layer:"L1"` 与 `semantics`
   （`walk` / `turn` / `use-item` / `interact-block` / `interact-entity` / `dig-block` / `dig-entity` /
   `place-block` / `pickup` / `slot-move` / `gui-*`），与 L0 的 `layer:"L0"` 成对：

   | 语义 | L0（`scene.*`） | L1（`player.*`） |
   |---|---|---|
   | 位置与朝向 | `scene.player.pose`（`semantics:"teleport"`，瞬时 + S08） | `player.move`（`"walk"`）+ `player.look`（`"turn"`） |
   | 拿到物品 | `scene.inventory.write`（`semantics:"give"`，直接写槽位） | `player.pickup`（`"pickup"`，掉落物 → 走过去碰） |

   **两者都做、两义都演示、结论注明取得层**（#96 裁决 4）。
7. **槽号口径两义**：`player.slot_click` 的 `slot` 是**当前 `openContainer` 的界面槽号**
   （`Slot.slotNumber`，即包里的那个，`-999` 是原版「容器外」）；`scene.inventory.write` 的
   `slot` 是 **`InventoryPlayer` 下标**（0..8 快捷栏 / 9..35 主背包 / 36..39 盔甲）。
   两者不同（`ContainerPlayer` 含合成格且顺序错位），**勿混用**——两条自述里都写死了这一点。
8. **同步动作、非步进**：九个都是一次调用内做有限步（`maxTicks` / `holdTicks` 有上界），
   不跨 tick 等世界装卸。理由见第 5 条。

**范围外（裁决 3）**：**GUI 内非槽位按钮点击**（机器模式按钮、JEI 面板等）**不在本任务范围**。
`player.gui` 只负责开/关，槽位收放由 `player.slot_click` 负责；按钮点击若 F2 教程样本实际需要，
当场切独立单子，不混入。

> **【重裁，2026-10-08，Gitea #166】** 上面这条是**对 L1 `player.*` 这一组的范围裁剪**，
> **不是平台能力结论**：它成立的唯一理由是「本组没有输入手段」，而该理由已随**通用输入族**
> （`input.mouse` 的绝对 GUI 坐标 `move` + `click`，见 §4.12）消失 ⇒
> **该「范围外」不再约束通用输入**。但两句限制仍然成立，且必须分开陈述：
> ① **能定位并投递点击 ≠ 命中 MUI widget**——GUI 命中集**每帧重建**，`move` 后须等 ≥2 tick（§4.12、`input-contract.md` §2.3/§2.4）；
> ② **命中 ≠ 业务后果发生**——后者必须由实机判据给出，不得由「注入成功」推定。
> 因此**本组（`player.*`）的裁剪保持不变**（仍然只有这九个动作、仍然不做按钮点击），
> GUI 按钮点击改由通用输入族承载；本条不放宽任何既有判据。

**平台边界（如实记录，不掩盖）**：L1 的动作在**客户端 tick 线程**执行，
包经集成服的本地 netty `LocalChannel` 送达；服务端在**它自己线程的 tick** 里处理
（`MinecraftServer.updateTimeLightAndEntities → networkTick`）。本组动作在读回前显式推送出站队列
（`NetHandlerPlayClient.getNetworkManager().processReceivedPackets()`），使本地链路下服务端处理
在同一 tick 内完成；**但服务端的 moved-too-quickly 等判定与「被拽回」只有在服务端 tick 后才可见**，
因此移动/拾取这类需要跨 tick 收敛的动作**如实返回当前读数与 `observed`**，不强求一调到位——
一次不成就调两次，这正是探索模式的用法。

### 4.7 导出族动作（v1.7，#102，「收口T5」）

落地 #96 §6.1 与 §10 C 族：把 `/sde export`（场景文件）、`/sde multiblock`（数据集）、`/sde dump`（注册表）
三条链路<b>同批</b>搬迁为 cp 动作（裁决 5），产物统一迁入 run 目录并登记哈希清单（裁决 6）。

| 动作 | 级 | 语义 |
|---|---|---|
| `export.scene` | scene | 把 `ExportSession` 帧缓冲导出为一份场景文件并登记（`/sde export` 的 cp 等价）。**客户端 tick 线程一次写完**（不经网络包 ⇒ 无「服务端写一份、客户端覆盖一份」的二义）。形态默认 `shape:"world"` = **单帧即 N=1 的多帧文档**（R1-3 口径唯一）。帧预算在扫描前算，超限 `CP-VALID-002` 且不写产物 |
| `export.registry` | scene | `/sde dump` 的 cp 等价：请求客户端生成三份注册表并落**本 run 目录**的 `registry/`，逐份登记（`/sde dump` 是唯一必须新增机制的一条，见下） |
| `export.multiblock` | scene | `/sde multiblock` 的 cp 等价：枚举 → 逐台变体捕获 → 因子化编码 → 逐台信封；产物落**本 run 目录**并登记 |

#### 4.7.1 产物单一归属（裁决 6）

每个动作的每份产物**有且只有一个**落点 = 该动作 run 目录内的相对路径，且登记进该 run 的 `manifest.json`。
**不存在**「原地一份 + 清单引用一份」的双态。cp 通道**不写** CWD 相对路径，也**不写**老路径
`structure_exports/`——老路径只服务尚未搬迁的命令通道，其删除归 #104。

| 动作 | 产物（run 目录内相对路径） | role |
|---|---|---|
| `export.scene` | `export/<name>.json` | `scene-export` |
| `export.scene`（逐帧明细） | `export/frames/F<n>.json` | `scene-export-frame` |
| `export.registry` | `registry/block_registry.json` / `material_registry.json` / `model_registry.json` | `registry-block` / `registry-material` / `registry-model` |
| `export.multiblock` | `export/<slug>.multiblock.json` | `multiblock` |
| `export.multiblock`（报告） | `export/report.json` | `multiblock-report` |
| `export.multiblock`（数据集） | `export/_dataset/run-NNNN/**` | `multiblock-dataset` |
| `cmd.exec`（命令产物） | `cmd-exec/<name>.json` | `cmd-scene-file` / `registry-*` |

**内部件不进清单**：`export.registry` 的投递单 `registry/dump-request.json` 在消费后**删除**且**从不登记**
——否则清单里会出现「一个指向自己的条目」这种自引用怪象。

**已知影响（如实登记，裁决 4 的附带影响面）**：工作台 `ExportsListPanel`
（`web/src/workbench/components/ExportsListPanel.vue`）读的是 `structure_exports/`，
因此**看不到 cp 通道产物**。C1 的验收方式相应改为「经 `GET /cp/v1/artifacts/{runId}/{path}` 下载产物
→ 喂给工作台/Wiki 解析器」（`export.scene` 结果的 `downloadPath` 就是这个 URL）。
`SdeWebServer` 是 `/sde web` 的老设施（裁决 2 已排除它入白名单），其归宿由 #104 裁决，不在 v1.6 范围。

#### 4.7.2 三条链路的目标数据流（搬迁后）

**A. `export.scene`（替代服务端写 + 网络包 + 客户端 enrich 三段式）**

```
HTTP thread  → 解析/鉴权/入队（§1.8：绝不触碰 MC）
Client thread → ActionSteppingExecutor → ExportSceneAction
   onBegin  : ctx.beginRun("export-scene") → 读 ExportSession.bufferSnapshot()
              （帧体 + 帧号 + 逐帧 sha256 + 世代号 + 选区 + 身份字段，全在同一临界区取走）
              显式校验：会话/选区完整? 帧预算? expectFrames?
   stage=scan  : ExportSceneWriter.buildDocument（唯一合并实现；形态由 shape 决定）
   stage=bake  : MeshCaptureService.finalizeStructureJson（客户端能力，天然可调用）
   stage=write : ArtifactStore.writeArtifact(run, "export/<name>.json", bytes, "scene-export")
                 + 可选逐帧明细 export/frames/F<n>.json
   onFinish : 释放（缓冲**不**被清——契约 1.6 不提供隐式清缓冲）
```

**关键事实**：`/sde export` 需要「服务端写 scan 中间态 → 投给客户端烘焙」是因为**命令跑在服务端线程**，
而烘焙（`finalizeStructureJson`）是 `@SideOnly(CLIENT)`。cp 动作本来就跑在**客户端 tick 线程**，
因此扫描与烘焙在同一次动作内顺序完成——这条推断由 #102 的最小实验实测确认（见证据目录）。

**B. `export.registry`（唯一必须新增机制的一条）**

```
Client thread → ExportRegistryAction
   onBegin    : ctx.beginRun("export-registry")
                RegistryDumpDelivery.request(runId, <run>/registry, "export.registry")   ← 内存投递单
                内部件 registry/dump-request.json 落盘（**不登记**）
   stage=wait-client : 等 ExportBundleClient.tickConsumePendingDumpIfAny 消费（客户端 tick 轮询）
   stage=verify      : 三份存在 + 非空 + 可解析（有 schemaVersion）
   stage=register    : 逐份 registerArtifact（role registry-*）
   onFinish   : 释放未消费的投递单（否则一次超时会让后续调用永远撞 CP-BUSY-001）
```

**★ 反模式（不要这么做）**：不要设计成「`/sde dump` 自己开一个 run」。命令通道跑在 `Server thread`，
它**没有** `ActionContext`/`JobHandle`，拿不到 runId 也开不了 cp run；强行开 run 会产出「不属于任何
cp 作业」的孤儿 run，违反 §1.8 与 #96 §8.7。正确形态是 **run 由发起方持有**：

- cp 通道：`export.registry` 开 run → 投递单指向该 run → 客户端写进去 → 动作登记；
- 命令通道：`cmd.exec {command:"/sde dump"}` → `cmd.exec` 开 run（`caseId="cmd-exec"`）→ 投递单指向该 run
  → 产物同样进清单（C5 达成），且两条通道写的是**同一个写出体**
  （`ExportBundleClient.writeFullRegistryDump`），满足 D2。

**投递单优先序**：内存单槽**优先**，老文件路径 `structure_exports/pending_dump.json` **兜底**
（只服务尚未搬迁的命令通道）。两条路都收敛到同一个写出体。

**C. `export.multiblock`（复用既有执行体，只改落点与登记）**

```
Client thread → ExportMultiblockAction（步进）
   onBegin  : ctx.beginRun("export-multiblock")
              RunConfig.outputRootOverride = <run>/export
   export   : MultiblockExportRunner.run(mc, rc)   ← 与 /sde multiblock 同一执行体
              （含 T1.3 数据集，同样落 run 目录：cap.outputRootOverride）
   register : 逐台信封（multiblock）/ report.json（multiblock-report）/ 数据集（multiblock-dataset，按 dataset 档位）
```

**主菜单下也能跑**：捕获路径自带 `ProbeDummyWorld`（不进真实世界），与 #104 之前那条触发文件
驱动的入口（`MultiblockExportAutomation`，已随 #104 删除）的行为一致——自述里写明这一点，
不假装要求世界。

**前置枚举事实（V11 已知缺口，必须与本节一起读）**：本动作**硬依赖**
`multiblock_scan/run-NNNN/machines.json`（T1.2 的枚举事实层）。产出它的 `MultiblockScanRunner`
按 V11 裁决**保留**（它是生产件），但 #104 删除了它唯一的触发入口
（`MultiblockScanAutomation` + `sde_multiblock_scan.json`），而 cp 侧**没有**对应的自描述动作
⇒ **当前没有任何自描述通道可以生成该枚举事实**，本动作在没有存量 `machines.json` 的机器上
必然报 `CP-STATE-001`。这是 #104 **显式登记**的已知缺口（不是静默遗漏），
建议补一个自描述入口（如 `export.enumerate`）。

**产物字节幂等**：产物**不含** `runId`/时间戳/绝对路径（格式契约硬约束，
`docs/contracts/format-multiblock-doc.md` §6.3），故两次运行产物可逐字节比对（A3）。

#### 4.7.3 帧预算（C6）

`export.scene` 两档预算，都在**扫描之前**算（选区尺寸 × 帧数即可推算体积），超限一律 `CP-VALID-002`
+ `context.fields`，**不写任何产物**——不静默截断、不写爆：

| 预算 | 参数 | 默认 | 绝对上限 | 超限 context |
|---|---|---|---|---|
| 帧数 | `maxFrames` | **64** | **256**（= `SdeServerRecordScheduler.MAX_CONSECUTIVE_RECORD_TICKS`） | `fields[field=frames]` = 「实际 N 帧 > 上限 M（不静默截断）」 |
| 体素 | `maxCells` | **2,000,000** | 48³×64 | `fields[field=maxCells]`（单帧与总量分别校验） |

`context` 另含可复算口径：`frames`/`maxFrames`/`volumePerFrame`/`volumeTotal`/`maxCells`/`computed`（算式文本）。

**为什么必须扫描前算**：`frameJson` 存的是每帧一份完整 scan JSON 字符串，导出瞬间内存约 3 倍膨胀
（帧字符串 + 帧对象树 + 合并文档）。256 帧 × 大型选区足以打爆堆。

`export.multiblock` 的预算**沿用既有实现**（不新造）：`globalBudgetMs`（默认 4h）是**业务预算**
（超时后剩余机器进 `failures[]`，不静默跳过）；`maxVariantsPerMachine`（默认 20000）是单台安全兜底，
超限按契约 tierSample 抽样 + 必要时收窄通道域，产物 `notes` 如实记录真实域。
`totalTimeoutMs`/`stageTimeoutMs` 是**作业看门狗**，与业务预算分工明确。

#### 4.7.4 形态统一（R1-3，派发裁决 5）

`export.scene` 的 `shape` 参数（`world` | `structure` | `auto`）：

- **默认 `world`**：恒 `{id,mode,frames[],playback}`，**单帧即 N=1 的多帧文档** ⇒ C1（单场景文件）
  与 C2（多帧）产出的是**同一种文件**、共用一条消费方解析路径；
- `structure`：恒裸单结构（仅允许单帧）。**注意两态不可互替**——`liftBlockPaletteToRoot`
  （跨帧调色板全局去重）只在 World 分支做；
- `auto`：旧隐函数（`{0}` → 单结构；否则 World）。**仅命令通道 `/sde export`** 用于逐字节保留既有行为。

搬迁前该判据是**帧号的隐函数**，`setframe 5 后 record 一次`（N=1 但键=5）会产出多帧形态——
调用方无法从参数预知产物是哪种文件，C1 与 C2 可能各自绿却是两种文件（假绿）。本契约把它显式化。
完整字段表见 [format-scene-file.md](../contracts/format-scene-file.md)。

#### 4.7.5 C3「同会话同缓冲」判据

`ExportSession` 是进程级单例，`frameJson` **从不因 `startSession`/`endSession` 清空**
（两者只翻一个 boolean）⇒ **「同会话」不可由 `inSession` 判定**，必须靠：

1. **动作侧**：`export.scene` 在 `onBegin` 经 `ExportSession.bufferSnapshot()` 在**同一临界区**取走
   帧体 + 帧号 + 逐帧哈希 + 世代号 ⇒ 产物内部自洽（不会出现「帧体是新的、哈希是旧的」）；
2. **产物侧**：cp 通道写 `provenance` + `exportId`（命令通道不写）——
   全部 `frames[i].exportId` 必须彼此相等且等于根级 `exportId`；
   `provenance.frameSha256` 必须与导出前经 `export.session` 读到的逐帧哈希同源同序；
3. **调用方侧**：`expectFrames` 参数（显式声明这次导出应包含哪些帧）不符即 `CP-STATE-001`，
   带 `expected`/`actual`/`extra`/`missing`。

**负对照构造**（C3 判红的验收方式）：动作 A 录 F0..F2 并导出；动作 B（**跨次动作**）再录 F9；
B 导出时声明 `expectFrames:{frames:[0,1,2]}` ⇒ 判红（`extra:[9]`）。
**不要**用 `start`/`end` 之间构造负对照——缓冲不清空，那样构造不出「跨会话」。

#### 4.7.6 `case.run` 的 `export` 段（C4 同 run 纪律）

C4 要求「导出件、实拍、观测记录、世界清单哈希**同一 run**，且该 run 内世界清单哈希唯一」。
若导出只能在用例之外单独调 `export.scene`，它必然落在**另一个** run 里——该判据对导出件就永远不成立。
因此 `case.run` 增加 `export` 段（**v1.7 起**，与 §4.7 整节及 `ActionRegistrar.java:257` 的 `since` 口径一致）：

```jsonc
{
  "export": [
    { "action": "export.scene", "params": { "name": "demo", "shape": "world" } }
  ]
}
```

- **段位**：`export` 排在 `read`/`action` 之后、`cameras` 之前——**完整九段执行序不在本契约复述**，
  唯一字面副本在 [case-file.md §1](case-file.md)，源码权威是 `CaseValidator.SEGMENTS`（`CaseValidator.java:69-83`）；
  本节只约束 `export` 的**相对位置**（导出在 `read`/`action` 之后、`cameras` 之前：
  拍摄会覆写投影/光照/渲染状态，不该影响导出件反映的世界状态）；
- **前缀限制**：段里只接受 `export.*` 动作；
- **不声明落点**：段里**不**接受 `path`/`role`——落点由导出动作决定，声明它会产生第二处真相。

#### 4.7.7 D2 适用范围（补充裁决 X-11）

双通道一致性**只适用于有命令孪生的 `/sde` 承重族动作**——即本节的三个：

| 动作 | 命令孪生 | 一致性为何机械成立 |
|---|---|---|
| `export.scene` | `/sde export` | 共用 `ExportSceneWriter`（唯一合并与序列化实现） |
| `export.registry` | `/sde dump` | 共用 `ExportBundleClient.writeFullRegistryDump`（唯一写出体） |
| `export.multiblock` | `/sde multiblock` | 直接调 `MultiblockExportRunner.run`（同一执行体） |

**其余动作在自述与验收中标注「D2 不适用」**，不强行造比对。比对口径见
[dual-channel-consistency.md](dual-channel-consistency.md) §2.2：
**不做文件逐字节比对**——解 Envelope → 取 inner → 语义子树规范化 JSON 的 sha256
（gzip 头含 MTIME，且 cp 通道多了 `provenance`）。

### 4.8 hermetic 纪律（起手重建世界）

见 case-file.md §8.8。要点：**验收类固定程序的第一次世界写动作必须是 `world.rebuild`（`void:true`）**，
不得在既有世界上续跑。`case.run` 的 `world` 段与之是**同一实现**（§6.3），二者语义不冲突。
L0 的轮内清场原语（`scene.entity.clear`）**不构成 hermetic 保证**，不能替代起手重建。

### 4.9 无人值守收尾原语（v1.6，#103，「收口T6」）

| 动作 | 级 | 语义 |
|---|---|---|
| `core.shutdown` | scene | **无人值守收尾原语**：读 run 的**两份结论**（`criteria.json` 与 `evidence.json` 的 `overall`，**任一非绿即红**）→ 按约定定退出码 →（默认）延迟后结束客户端进程。**只读 `evidence.json` 会把红跑读成绿跑**（实机存在 `criteria=red` / `evidence=green` 的 run），详见本节末的退出码表 |

**为什么需要它（V5 的硬真空）**：老批处理设施（`MultiblockPipelineAutomation` 等）把
「跑完 → 落结果文件 → 以退出码结束进程」做成一件事，外层脚本据此判红绿。那些设施随 #104 整体删除后，
控制面成了唯一入口，而 `grep mc.shutdown|exitJava|exitCode` 在 `client/controlplane/` 里**零命中**
——无人值守编排拿不到任何稳定的进程级信号，只能靠轮询 HTTP 猜「跑完了没、绿没绿」。

**退出码约定（与 run 的**合并结论**对齐）**：

| 码 | 含义 | 判定 |
|---|---|---|
| `0` | 判据全绿 | `criteria.json.overall == "green"` **且** `evidence.json.overall == "green"` |
| `2` | 有红 | 两份里**任一**非 green（**任何**非 green 值都判 2，不是只认字面量 `red`） |
| `3` | 设施错误 | 连「绿没绿」都读不出来：run 目录里两份结论文件都不在、非法 JSON、缺 `overall`、runId/caseId 都不可用 |

**为什么读两份**：`criteria.json.overall` 是用例声明的**判据**结论，`evidence.json.overall` 是
**期望证据核对**结论（该在场的产物在不在）——两者语义不同、**不可互替**。实机实测存在
`criteria=red` 而 `evidence=green` 的 run（一次 `l1-orchestration` 的 2 条判据红、12 项期望产物齐备）；
只读其一会对那次红跑返回 **0「判据全绿」**，即把红跑读成绿跑。合并规则与 `case.run` 的作业结果
`overall` **逐字同源**（run 目录里没有持久化「合并结论」的字段，必须重新合并得出）。

三个退出码值与老设施逐字相同（外层脚本可以不改）。**「结论红」与「设施坏」必须分开**——
把两者混成一个非零码，是让自动化无法自诊断的最快方式。

**退出纪律**（照抄已实测的口径）：FML 的 `FMLSecurityManager` 把非 `cpw.mods.fml.*` 发起的
`exitVM` 权限请求直接抛 `ExitTrappedException`——自定义类里调 `Runtime.getRuntime().halt(code)`
会被**静默拦掉**（实测：日志里一句 `FMLSecurityManager$ExitTrappedException`，进程仍以 0 退出，
外层脚本因此把一次红跑读成绿跑）。因此：

- `code == 0` ⇒ `Minecraft.shutdown()` 正常收尾（世界落盘，main 返回 0）；
- `code != 0` ⇒ `FMLCommonHandler.instance().exitJava(code, false)`（结果文件已 flush）；
- 两条路都先挂 120 s 安全网线程（到点 `exitJava(code, true)` 硬退），绝不挂死外层编排；
- **绝不** `Runtime.halt` / `System.exit`。

**为什么延迟退出**：本动作是 HTTP 动作，结论要经响应体回给调用方，而响应在动作返回**之后**才写；
就地退出会把调用方吊死在一个永不来的响应上（而它正是要靠这个响应知道退出码）。因此实际退出跑在
延迟 `delayMs`（默认 1500 ms）的守护线程里，结果里如实给 `exitScheduledInMs`。

**可判定性**：`dryRun:true` 只定码不退出——用它可以在不杀进程的前提下逐条核对「码与**两份结论**（`criteria.json` + `evidence.json`）对齐」。

**不许编入固定程序**：本动作会让本作业后续段不再执行，`case.run` 的 `action` 段一律拒绝它
（`CaseValidator.ACTION_FORBIDDEN`）——收尾由驱动在**整跑结束后**单独发起。

### 4.10 L2 编排段（v1.6，#103）

`case.run` 的用例文件新增通用 `action` 段（**段**的扩充，不是新动作）：逐条执行用例声明的任意
**同步** cp 动作，产物落 run 目录，`expect` 非空时当场逐步断言。段序为九段固定序
（唯一字面副本见 [case-file.md §1](case-file.md)，权威 `CaseValidator.SEGMENTS`；
`action` 夹在 `read` 与 `export` 之间）。
完整口径见 [case-file.md §3.2](case-file.md)。

**为什么它是 L2 的题中之义**：需求书 §4.3 把 L2 定义为「L0/L1 的**有序编排**，可重放、**逐步断言**」；
在本段之前，用例能表达的世界写只有 `build` 段的四种构建 op（clear/block/te/wait），
`scene.*`（L0）与 `player.*`（L1）一步也进不了固定程序——「L2 = 有序编排」这句话在代码上没有落点。
**没有它，`tutorials/` 的教程复现程序无法表达。**

### 4.11 捕获通道自证诊断（v1.7，#114，「V4 职责迁移」）

| 动作 | 级 | 语义 |
|---|---|---|
| `capture.diag` | observe | **捕获通道自证诊断的布防/撤防与 drain-dump**：未给 `arm` 时缺省布防录窗 + 诊断会话（**例外**：`dump:true` 且未给 `arm` ⇒ 缺省「不动」`unchanged`——该缺省**取决于调用形态**，故 `arm`/`reset` 刻意不声明 `default`，实际生效值由返回值 `sessionMode` 机读）；`arm:false` 撤防（**不清计数、不清 drain 汇**）；`dump:true` 把 TESR 录窗 drain 到的实录几何装配成 web V2 场景文档落 run（`capture/diag-dump.json`，登记 sha256 进清单）。**三态会话处置**：`dump:true` 且未显式给 `arm` 时缺省是 `unchanged`——既不重新布防（会清零抹掉现场）也不撤防（会停掉正在进行的采集），只读已采到的证据 |

**三态会话处置的必要性（实机擒获的缺陷）**：`sessionMode` 有 `arm` / `disarm` / `unchanged` 三个取值，因为「dump 时该怎么办」有第三种正确答案。若 `{"dump":true}` 沿用 `arm:true` 的缺省，它会**顺手重新布防**并因 `reset` 缺省为 true 而清零计数——调用方以为只是把已采到的几何落盘，实际把刚采到的现场抹了；反过来把缺省改成 `arm:false` 同样错——那会把**正在进行的采集停掉**。故缺省必须是「不动」（`unchanged`，返回值里 `sessionTouched:false` 如实回报），`reset` 缺省随之 = `(sessionMode == arm)`。两条缺省规则都是纯函数（`CaptureDiagAction.resolveSessionMode` / `resolveResetDefault`），可离线逐值锁死。

**为什么存在（V4 硬真空）**：「忠实复现捕获层」的核心承诺是**静默漏录不可接受**——录窗开着但零几何流入必须可检测。这份自证此前只由老设施 `CaptureChannelProbeAutomation` 承载（触发文件驱动、进程自毁退出），而 `CaptureDiagnostics` 在 `client/controlplane/` 下**零对应物**（实测 `grep CaptureDiagnostics` 0 命中）。#104 要整体删除老探针，删之前必须先落地这条能力，否则「录窗通道到底录到了没有」再没有可读口径。

**两个动作的分工（为什么不是一件事）**：

| 半边 | 动作 | 有副作用吗 | 为什么这样切 |
|---|---|---|---|
| 读 | `read.capture`（§4.1） | 无 | 「读面调用前后世界不变」（B1）靠的正是无副作用；把布防塞进读面会让这条纪律名存实亡。读数因此可**自由轮询**，包括捕获会话进行中 |
| 写 | `capture.diag`（本节） | 有（只改**观察条件**） | 翻转录窗总开关、开诊断会话、布防 TESR drain 汇——都不改世界、不改画面、不驱动渲染 |

**权限级为什么是 `observe`**：本动作只把「尺子架起来」，连一帧都不渲（对比 `shot.multi` 是 `forensic`——它真的注入相机与投影去渲帧）。若提到 `scene`，则「采集诊断」会带上 `confirm:true`，而它在无人值守流程里恰恰是**排障第一步**——排障工具不该比被测对象更难拿。

**与 `capture.begin`/`capture.end` 的区别（两者正交，不是同一件事）**：后者是**世界写封锁**（取证期间世界不得漂移，`CP-STATE-001` 拦别的作业写世界）；本动作是**观察条件布防**（录窗与诊断计数）。可以只开诊断不封锁世界（排障），也可以只封锁世界不采诊断（既有 `case.run` capture 段）。因此 `capture.diag` **不碰** `CaptureSession`，也**不被**它拦。

**忠实边界（#55 禁条，与老探针逐字同源）**：drain-dump 的几何**唯一**来源是 `TessellatorCaptureState.endWindowAndDrain` 交出的窗口四边形；录不到的格留空（`cellGrid` = air）并进 `assembly.missing` 显式列出，**绝不**从静态数据/物品渲染兜底。`staticFallback` 恒为 `false` 且写进产物。

**产物显式（§8.6）**：dump 产物落**本次调用开的 run 目录**并登记 sha256 进 `manifest.json`——这是对老探针的一处**收紧**：老探针写在 `<mcDataDir>/sde_capture_channel_probe_export.json`（run 清单外，归档工作树即消失），控制面产物可经 `GET /cp/v1/artifacts/{runId}` 发现、可下载、可核对。

**负对照：未采集必须显式空态（不编造数据）**：全 0 有两种**相反**含义——「没采过」与「采到了零流入」。`read.capture` 因此给出 `collectionState`：

| 取值 | 含义 |
|---|---|
| `not-collected` | 从未布防过诊断会话 ⇒ 全部计数为 0，且 `note` 明写「这是未采集的空态，不是采集到零流入」 |
| `collecting` | 正在采（此态下的 0 才是「采到零流入」） |
| `collected-then-disarmed` | 采过并已撤防 ⇒ 计数是**已采到的真实证据**（撤防不清计数） |

三者都不抛异常（未采集是合法状态，不是错误），但含义在读数里分得开——「空转绿」的反面不是「一律报错」，而是「如实说明这个 0 是什么」。

**`directTessellatorHookActive=false` 何时是缺陷**：它证明的是 `MixinDirectTessellatorCapture` 活着（见过 DirectTessellator 顶点），**不是**诊断在开（录窗外也置位）。无 DirectTessellator 流量的会话（纯方块/TESR 场景）保持 `false` 是**正确行为**；硬判据只在「本会话确实制造了 LP 管等 DirectTessellator 流量」的场景成立（`hookScope` 字段在读数里写明了这条）。

**为什么需要 `disarmWindows()` 的「待兑现」语义**：两个开窗 Mixin 的 `RETURN` 注入点都以 `areWindowsArmed()` 为门（未布防即提前返回）。若在窗口**开着**的时候把开关就地置假，那次关闭会被跳过，`CAPTURE.active` 永远为真，此后每一次 `beginWindow` 都抛「录窗嵌套/排队被拒绝」——一次撤防把整条录窗通道打死，且现场只留下一条看不出因果的异常。故 `capture.diag {arm:false}` 撞上在飞窗口时只挂「待兑现」标记（`windowsDisarmPending:true` 如实回报），由该窗口关闭时兑现。

**#104 删除口径（本节的验收用途）**：老探针承载的四件事全部有归属——①三通道计数/zeroFlow/按格归属 → `read.capture`；②`directTessellatorHookActive` → `read.capture`（同一字段、同一数据源）；③诊断会话布防 → `capture.diag {arm:true}`；④drain-dump → `capture.diag {dump:true}`。老探针独有的「专用世界 + 受控放置 + 玩家面向」不属于本职责，已由 `world.rebuild` / `te` 步 / `scene.player.pose` 覆盖（#104 删除矩阵 A-2.3）。

### 4.12 输入手段族（`input.*`，v1.8，Gitea #160/#162/#163/#164/#165）

**本节只是指针**：输入手段族的接口形状、生命周期、执行语义、能力发现、错误语义、状态迁移表与集成协议，
全部冻结在 **`docs/control-plane/input-contract.md`**；覆盖矩阵、旁路清单（**不可达**项）与负对照目录在
**`docs/control-plane/input-coverage.md`**。本节不复制其内容，避免同一规则两处漂移。

| 动作 | 级 | 语义 |
|---|---|---|
| `input.key` | scene（步进） | 把键事件投进**游戏自己的输入队列**（不抢焦点、不动用户桌面鼠标）；`action=down\|up\|tap`，`tap` 的 `holdTicks∈[1,1200]`（1=同一次调用内 down+up，≥2=第 holdTicks 个 tick 抬起）。**投递成功 ≠ 业务成功**；组合键只保证事件序（轮询面不覆盖） |
| `input.mouse` | scene（步进） | 鼠标事件；`op=move\|relative\|down\|up\|click\|wheel`。`move` 收 **GUI 缩放坐标**、由设施换算成投递口径并**回读自校准**；`click` **不做**隐式 move（不先 move 就点，点到的是上一次的位置）；`move` 后须等 ≥2 tick 再 `down`；`relative` 消费门是 `inGameHasFocus && Display.isActive()` ⇒ **失焦不承诺生效** |
| `input.text` | scene（同步） | 逐字符投递普通文本（UTF-16 码元，每字符一条事件）。**当前能力未就绪 ⇒ 任何非空请求一律 `CP-STATE-001`**，绝不返回 `delivered:N` 的假绿；范围外字符 ⇒ 整条 `CP-VALID-002` 且逐字符说明（不静默丢弃、不替换）；**禁止**直接改控件值 |
| `input.release` | scene（同步） | 全清**本设施投递过**的按下态（跨作业、幂等；无持有时 `count:0/alreadyIdle:true`，不是错误）。不碰 SDL 物理态、不调 `KeyBinding.unPressAllKeys`、不清任何非本设施投递的事件 |
| `input.state` | observe（同步） | 本族的**唯一能力声明口**：只读快照（能力/键位目录/坐标口径/消费链/持键/队列/未实现清单）。任何「本族能不能做 X」的答案只能来自它，不得来自散文 |

**四个可写动作的 `confirm` 门**：它们都是 `scene` 级 ⇒ 调用体必须带 `"confirm": true`
（§1.6 / `CP-CONFIRM-001`）。`input.state` 是 `observe` ⇒ 不需要 `confirm`，可自由轮询。

**手段归因与 `layer` 的关系（显式例外，继续保留）**：本族返回值以 `means:"input"` 归因、`layer` 恒为
`null`——输入手段与 L0/L1/L2 是**两个维度**（`input-contract.md` §10.1：输入成功 ≠ 操作目标正确 ≠ 流程成立）。
§4.6 的「`layer`/`semantics` 成对」规则在此登记为**显式例外**（`input-contract.md` §12.1 D-1），不是漏改。
本族动作的自描述也带 `means:"input"`（§2.2）。

**登记的未知（调用方必须知道，不许当成已具备）**：GUI 文本路由 P0 实测未打通；鼠标侧队列深度无公开探针
（`physicalConcurrent` 鼠标侧恒 `"unobservable"`）；无取消能力；离图/断连/关服无钩子；不承诺崩溃后清理。
完整清单以 `input.state.notImplemented` 为准（与 `input-contract.md` §11.2 **同源**，实现一项删两处）。

## 5. 版本化规则

- URI 前缀即契约大版本：`/cp/v1`。
- v1 内只允许**增量**：新增动作、新增可选参数、新增响应字段均可；不得改已有字段语义、不得删字段、不得收紧默认值。
- 破坏变更开 `/cp/v2`，旧版本至少保留一个里程碑周期。
- 每个动作描述含 `since`（引入的契约小版本，如 `1.0`）；`GET /cp/v1/about` 报 `contractVersion`。
- **变更记录（Gitea #104，「收口T7」）：`probeActive` / `probe` 的语义变更（显式例外，需评审确认）**
  - **形状不变**：字段名、类型、位置与 `core.ping` / `core.status` / `about` 的返回结构一字未动，故 `contractVersion` **不升**（**当时**为 1.7；当前版本是 **1.8**，由 #165 的输入手段族引入——见 §4 的版本沿革与会话 `about` 的实读）。
  - **语义变更**：`probeActive` 旧义 = 「老触发文件自动化链是否激活」；新义 = 「**控制面自身忙闲**」（有作业在队/在跑）。`probe` 旧义 = 激活中的老探针名；新义 = **恒为 `null`**。
  - **为什么必须变**：老一代批处理设施（10 个自动化入口 + `client/automation/SdeClientAutomationTickHandler` 接管链 + 9 个触发文件 + 5 个专用世界目录）已随 #104 **整体删除** ⇒ 旧义的真值来源不复存在，字段若维持旧义就恒为 `false`/`null`，成为一个只会误导调用方的空字段。
  - **规则冲突的如实登记**：本节上文写「v1 内不得改已有字段语义」。#104 的裁决者（Gitea #104 最新裁决评论，V7）明确选择「保留字段、改语义」，理由是删字段同样是破坏性变更且 `CP-BUSY-001` 口径仍需要这个字段。**本例外是显式登记的，不是漏改**；若评审认为必须严守 v1 语义冻结，则唯一合规做法是开 `/cp/v2`（成本远高于收益，因为旧义已无真值来源）。自述（`GET /cp/v1/actions` 的 `core.ping` / `core.status` 描述）已同步写明新义与「老探针设施已随 #104 删除」。
  - **`CP-BUSY-001` 仍存在**，但只对「已有控制面动作在队/在跑」的提交成立（`JobQueue.submit`，HTTP 线程判定），与 tick 排空无关（§9）。
- **变更记录（Gitea #165，契约 1.7 → 1.8）：纯增量**
  - **新增**：§4.12 的 5 个输入手段族动作（`input.*`，动作计数 43 → 48）；§2.2 的可选自描述字段 `means`。
  - **不改既有语义**：`means` 缺省时不出现该键 ⇒ 既有 43 个动作的自描述 JSON **逐字节不变**；
    输入族返回值是新增形态，不触碰任何既有动作的参数/返回/权限语义。
  - **被改动的既有契约文字只有两处**：动作计数（43→48）与契约版本（1.7→1.8）——都是计数/版本前进，不是语义变更。
  - **同步移动的三处**（`input-contract.md` §1.4 的硬要求）：`ActionRegistrar` 的计数注释、
    本文 §4 的计数、两处动作计数断言（`ReadCaptureOfflineTest` / `InputCapabilitiesTest`）。三者必须同批移动。
  - **§9.3 第 1 条的修订（D-7）**：输入持键的**到期结算**不再只依赖步进动作的 advance——
    由既有的 `ControlPlaneTickHandler` 每 tick 调一次幂等的结算泵。理由见 `input-contract.md` §12.1 D-7。

## 6. 托管世界规则（C4 落地）

1. 控制面只操作**托管世界**：存档目录名以 `cp_` 前缀且内含 `cp_world.json`（`{schema:"lightning.cp-world/1", seed, void:true, complete, createdBy}`）。对非托管世界的一切写操作拒绝（`CP-STATE-001`）。
   - **标记前置与 `complete` 状态机（v1.7，#123）**：标记在**世界建好之后立刻**写（带 `complete:false`），构建全部成功后改写为 `complete:true`。理由是修复前标记只在最末阶段写，build 阶段失败即留下「有世界文件、无标记」的残留，**没有任何 API 能清掉**（#117 段二 D-2，只能手工删目录）。
   - **两个判据必须分清**（这是本节的核心，消费方一律照此判读）：
     | 判据 | 含义 | 消费点 |
     |---|---|---|
     | **有标记**（不论 `complete`） | 「曾经开始过」⇒ **可以删、可以重建** | `assertDeletable`（删除二次确认）、`world.rebuild` 的前置检查、`world.rollback` |
     | **`complete:true`** | 「构建完成的成品」⇒ **可以当成品复用** | `world.snapshot` 的整目录复制 |
   - **`complete:false` 的语义**：**「曾经开始过、可以删可以重建，但不得当作构建完成的世界复用」**——场景可能只铺了一半（build 段中途失败）、TE 补全可能未完成、场景清单可能缺失或过期。拒绝复用时错误理由必须分得开：无标记 = 「非托管世界」（安全拒绝），有标记但未完成 = 「构建未完成的世界」（可用性拒绝，提示重跑重建即可修好）。
   - **安全属性不回退（负对照）**：无标记的目录仍然**一律拒绝**删除与重建前置检查，修法放宽的只是「带标记但未完成」。
   - **向后兼容**：本字段引入前的标记无 `complete` 键（那时的标记只在构建完成后才写），故**缺键按 `true` 读**；形态坏掉的取值（null/字符串/数字）按**未完成**读（失败显式，不猜）。
   - **只读暴露**：`world.info` 的 `markerComplete` 给出该世界是否为构建完成的成品（`managed`/`markerPresent` 仍只回答「是不是托管目录」）。
2. **虚空世界**：`WorldType.FLAT` + 空层预设（无基岩无土层），固定种子；构建基点由用例文件给定。
3. **幂等重建**：`world.rebuild` 对同一用例定义产生相同世界；场景构建步骤以「清场（托管区域 setBlockToAir）→ 放置 → TE 补全 → 静置」为固定序。**时序陷阱（PR-3 实证）**：AE2 空缆块会在首个 tick 自毁（`TileCableBus.onReady`）——用例中缆块的 `block` 步与其 `te` 步之间**不得插入 `wait`/`clear` 等跨 tick 步骤**，te 步必须紧随同 tick 执行（completer 对缺中心缆报 CP-STATE-001 兜底）。
4. **TE 状态补全**（#55「设」第五项）：仅限场景构建阶段、捕获开始之前；必须经模组自身权威同步路径（如 `markBlockForUpdate` 触发 S35 description packet 摄取，或模组自己的 `initialize`/`addPart` 等 API）；**禁止**逐字段从静态数据推算回填。补全器按族注册（接口 `TeCompleter`），默认实现覆盖原版 TE；LP/AE2 族补全器随锚点场景交付。
5. **补全器的权威放置职责（PR-3 明确）**：当模组的方块需要构造上下文时（LP 通用管块需 `createPipe`/`placePipe`、AE2 部件需 `addPart` 到既有缆、GT 机器方块需 `ItemMachines.placeBlockAt` 才会建 MetaTileEntity），`te` 步的 completer 经**模组自身放置 API** 完成放置与补全；此时 `params` 声明的是**放置输入**（物品 id/朝向/面），不是 NBT 逐字段回填——该区分必须在 completer 类注释写明。**v1.3 注册表**：`vanilla` / `lp-pipe` / `ae2-part` / `gt-machine`（#117 追加，同一族名同时注册补全器与描述器）。
   - **补全器必须自带放置后验证**：`complete()` 返回 true 必须等价于「世界上真有一个可 tick 的模组方块实体」。反例（#117 的缺陷本体）：GT 机器用 `world.setBlock` 直铺只会得到一个 `mID == 0` 的空壳，其 `blockId`/`meta`/TE `class` **与真机器完全相同**——即 `world-hash-equals` 对「空壳 vs 可运行机器」是盲的。故 `gt-machine` 放置后读回 `getMetaTileID()`/`getMetaTileEntity()`，不符即 `CP-EXEC-001`；`GtMachineDescriber` 把同两项（外加 `shell` 布尔）暴露给 `read.te` 与 `te-state-equals`，负对照只能靠它判别。
   - **充电/供电一类「模组状态注入」一律经模组自身 API**：GT 电池的充电状态存在 NBT 键 `GT.ItemCharge` 上，手写它即 §6.4 禁止的逐字段回填；`scene.inventory.write` 的 `charge` 走物品自己的 IC2 `IElectricItemManager`（GT `MetaBaseItem` 自实现之），并显式拒绝 `charge` 与 `nbt` 同时出现。**给机器供电的正确形态是把满充电池写进机器充电槽**（GT 自己的 tick 从槽里取电），而不是直接改机器的 EU 缓冲字段。
   - **流体注入同理（#122）**：`scene.tank.fill` 走 `IFluidHandler.fill`（1.7.10 的标准流体交互入口，GT 的 `BaseMetaTileEntity` 自实现之），**不**直接写 `MTEBasicTank.mFluid` 字段。走 `fill` 的额外好处是 GT 自己的门槛全部照常生效（机器是否已 tick 起 `mTickTimer > 5`、输入面是否合法 `isLiquidInput(side)`、该流体是否被这台机器的配方表接受 `isFluidInputAllowed → getRecipeMap().containsInput`、容量与既有流体是否同种），本动作只如实报告它返回的数字。**`fill` 的返回语义是「实际注入了多少 mB」**，故 0 与部分注入都是正常返回值：本动作对 0 报 `CP-EXEC-001`（附候选原因与前后读数，不让「一点没进去」伪装成成功），对部分注入如实返回 `filled`/`partial:true`/`notFilled`（容量不足是正常场景，判红会让「尽量灌满」无法表达）。
   - **物品形态同理（#122）**：配方输入绝大多数是**材料形态**（三氯硅烷配方要 `dust × Silicon`），而 `ItemList` 里没有 `Silicon` 这类常量。`scene.inventory.write` 的 `material`+`prefix` 因此走 GT 自己的 `OrePrefixes.getPrefix(name)` + `Materials.get(name)` + `GTOreDictUnificator.get(prefix, material, amount)`——**与 GT 配方加载器同一路径**，故「用例投进去的东西」与「配方认的东西」不可能不一致；`material` ⟂ `id`/`battery`/`meta`（meta 是「材料子 id + 形态位」编码出来的实现细节，手写它等于绕过模组路径）。
6. 世界快照与回滚范围**包含** TE 补全后的状态。**因此 `world.snapshot` 只接受 `complete:true` 的世界**（v1.7，#123）：失败残留的场景可能只铺了一半，拍成快照会被 `world.rollback` 当作「期望态」扶正，判据再也看不见那个缺口。
7. **玩家稳定化**：虚空世界进图后允许对玩家做最小稳定化（传送到构建基点上方、创造飞行，防坠亡卡死无人值守流程）；只动玩家实体，不进场景清单与哈希。**L0 的 `scene.player.pose`（§4.4）是这条的显式化对应物**——同一件事由调用方按需触发，而不是只在进图时隐式做一次。
8. **离图阻塞**：`mc.loadWorld(null)` 在 tick 线程内阻塞至集成服停机（原版「保存并退到标题」同路径），客户端会冻结数秒到数十秒——动存档目录前必须保证 region 句柄释放，这是 v1 的取舍。
9. **hermetic 纪律（#99 成文）**：验收类固定程序的第一次世界写动作必须是 `world.rebuild`（`void:true`）；
   本节的 `case.run` 的 `world` 段与之**共用同一实现**（`WorldRebuildRunner`），语义不冲突。
   完整规则与逐条对齐表见 case-file.md §8.8；L0 的轮内清场原语**不构成** hermetic 保证（§4.6）。
10. **重建固定序（v1.7 起含标记前置）**：离开 → 删除（二次确认）→ **标记前置（写 `complete:false`）** → 建/进世界 → build 段 → 静置 → **标记收口（改写 `complete:true`）** + 写场景清单。前置点必须在**进世界之前**：`launchIntegratedServer` 一启动集成服就会写 `level.dat` 与 region，前置点若在其之后，仍会漏出「有世界文件、无标记」的窗口（正是 #123 要消灭的状态）。`case.run` 的 `world` 段落在 `MARKER` 阶段**不收口**（`markComplete=false`），由随后的 build 段收口——否则 build 失败会留下「标记说完成、场景只铺了一半」的世界。

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
- 与**老触发文件自动化**的关系（Gitea #104 之后）：老一代批处理设施 —— 10 个自动化入口、`client/automation/SdeClientAutomationTickHandler` 的接管链、9 个触发文件约定、5 个专用世界目录 —— 已**整体删除**。控制面是当前**唯一**驱动世界的自动化，因此**不存在**「与别的自动化链争 tick」的情形，`ControlPlaneTickHandler` 里也**没有**避让分支（原先的「既有探针激活 ⇒ 暂停排空」判据已随真值来源一并删除；留一个永不成立的判据就是死代码）。
- `probeActive` / `probe` 仍然存在，语义见 §5 的变更记录：`probeActive` = **控制面自身忙闲**（有作业在队/在跑），`probe` **恒为 `null`**。`CP-BUSY-001` 只对「已有控制面动作在队/在跑」的**提交**成立（`JobQueue.submit`，HTTP 线程判定）；tick 排空**不得**以「忙」为门 —— 步进作业正是靠每 tick 的 `drainOne()` 推进，以忙为门会把 running 作业冻结到超时。
- `about` 等端点的 MC 相关字段必须由 tick 线程周期快照提供（§1.8：HTTP 线程不得读 `mc.theWorld` 等 MC 状态）。
- 进度事件节流：增量 ≥0.05 或间隔 ≥3s 放行，终值 1.0 必放行（防事件流水被逐 tick 上报灌满）。
- 调用既有 runner（扫描/导出类）时必须强制其 `exit=false / cleanupTrigger=false`，禁止继承自毁退出。
- 日志前缀 `[SDE][CP]`，沿用 FMLLog 手工前缀约定。
- 与 `SdeWebServer`（`/sde web`，`/api/v1/*`）零共享可变状态：不同端口、不同实例、不同鉴权域。
- **步进动作按工厂注册**（`registerStepping(desc, Supplier)`）：每个作业一个动作实例，作业内复用、收尾销毁；禁止注册有状态单例（实测事故：实例复用导致后续作业静默返回上一作业的结果）。已收尾/跨作业复用实例必须当场 CP-EXEC-001，不许静默。
