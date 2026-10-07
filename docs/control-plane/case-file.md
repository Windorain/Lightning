# 声明式用例文件规范（lightning.case/1）

> 承载 Issue #57 交付物二、#47 评论 id=664 的 A9/C8。交互路径与无人值守路径**共用同一实现**——
> 本文定义的模型与解析器在 `controlplane/core/`，`case.validate` 与 `case.run` 是它的唯一入口。

## 1. 顶层结构

```jsonc
{
  "schema": "lightning.case/1",          // 必填，精确匹配
  "id": "lp-pipe-row",                    // 必填，[a-z0-9-]+，run 目录名组成部分
  "label": "LP 四格管道参照",              // 展示名
  "world":    { ... },                   // 必填：世界构建方式
  "build":    [ ... ],                   // 可空：场景构建步骤
  "read":     [ ... ],                   // 可空（v1.3，issue #98）：读面步骤
  "action":   [ ... ],                   // 可空（v1.6，issue #103）：L2 编排步骤（任意 cp 动作）
  "capture":  { ... },                   // 可空（PR-2 起）：扫描与捕获参数
  "cameras":  [ ... ],                   // 可空（PR-2 起）：机位表
  "criteria": [ ... ],                   // 必填，至少一条：判据与阈值
  "variants": [ ... ],                   // 可空：负对照变体
  "evidence": { ... }                    // 必填：期望证据清单
}
```

**段序即执行序**（`CaseValidator.SEGMENTS`，v1.6）：

```
world → capture → build → read → action → cameras → criteria → evidence
```

`action` 排在 `read` 之后、`cameras` 之前，两条都有理由：读面读的是**成品场景**（编排要改世界就该发生在读数之后，
否则读数说的是改动前的世界而调用方以为它说的是当前的）；截图与判据必须说**同一个世界**（编排若排在拍摄之后，
截图里的世界与 `criteria` 段读到的世界就不是一回事了）。

## 2. world 段

```jsonc
"world": {
  "folder": "cp_lp_pipe_row",   // 必填，必须 cp_ 前缀（托管世界规则见 contract.md §6）
  "seed": 20261006,             // 必填，固定种子
  "void": true,                 // 必填且目前只许 true（C4）
  "base": [64, 12, 64],         // 可省；出现相对坐标时必填（缺则 CP-VALID-002 指向对应 build[i].at）
  "settleTicks": 60             // 构建后静置 tick 数，默认 60
}
```

## 3. build 段（场景构建步骤，有序执行）

每步一个对象，`op` 判别：

| op | 参数 | 说明 |
|---|---|---|
| `clear` | `from:[x,y,z], to:[x,y,z]` | 托管区域清场（setBlockToAir） |
| `block` | `at:[x,y,z], id:"minecraft:stone", meta:0` | 放置方块 |
| `te` | `at:[x,y,z], completer:"vanilla"\|"lp-pipe"\|"ae2-part"\|"gt-machine", params:{...}` | TE 状态补全（权威同步路径，contract.md §6.4）；`completer` 必须在注册表中。`gt-machine`（#117）的 `params` 是放置输入：`{machine:"Machine_LV_ChemicalReactor"}`（GT `ItemList` 常量名，首选）或 `{item:"gregtech:gt.blockmachines", meta:421}`（显式 MetaTileEntity id，须 > 0），可选 `side`（DOWN\|UP\|NORTH\|SOUTH\|WEST\|EAST，默认 UP）。补全器自带放置与放置后读回验证（读回 `mID == 0` 的空壳即 `CP-EXEC-001`），故用例**不要**先用 `block` 步铺 GT 机器方块；给机器供电用 §3 之外的 `scene.inventory.write`（`battery` + `charge:"full"` 写进机器充电槽）；**给机器注流体用 `scene.tank.fill`**（#122，contract.md §4.4；`scene.inventory.write` 只碰 `IInventory`，碰不到 `IFluidHandler`）——读回走 `read.te` 的 `tanks` 字段 |
| `wait` | `ticks:N` | 等待 N tick（同步/渲染稳定） |

坐标三种写法，一律规范化为绝对坐标：绝对数组 `[x,y,z]`；`"@base"` + 同层 `offset:[dx,dy,dz]`；字符串 `"base+[dx,dy,dz]"`。`world.base` 只接受绝对数组。构建完成后运行器自动做：TE 补全（`te` 步声明的）→ `markBlockRangeForRenderUpdate` → 静置 `settleTicks`。

## 3.1 read 段（读面步骤，v1.3 / issue #98）

每步一个对象：`{action:"read.blocks", params:{...}, path:"read/blocks.json", role?}`。
执行该读面动作（契约 §4.1 的 `read.*`），把返回的 JSON 落 run 目录的 `path` 并登记为产物。
段序在 `build` 之后、`cameras` 之前——读的是**成品场景**，且产物必须先落盘，`criteria` 段才引用得到。

```jsonc
"read": [
  { "action": "read.blocks",
    "params": { "from": [64,11,63], "to": [69,15,68], "includeAir": true },
    "path": "read/blocks.json", "role": "read-blocks" },
  { "action": "read.diff",
    "params": { "expectManifestFile": "cp_demo" },
    "path": "read/diff.json" }
]
```

**校验口径（`case.validate` 与 `case.run` 同源）**：
1. `action` 必填且**必须**以 `read.` 开头——读面段只放读动作（写动作走 `build` 段）；这是「读面只读」
   这条纪律唯一的**静态可查落点**。动作是否真的已注册由 `case.run` 的 `read` 段执行期判定
   （`CP-VALID-001`，`context.registered` 给出全部已注册动作名）。
2. `path` 必填、必须是合法的 run 目录内相对路径（防穿越）；同一次用例内**不得重复**
   （后一步会静默覆盖前一步，判据引用哪一份就说不清了），也不得与运行器自身产物
   （`manifest.json`/`criteria.json`/`evidence.json`/`observation.json`）重名。
3. 空 `read` 段给 warning（声明了但没写步骤，多半是笔误），不是错误。
4. 读面步骤**必须是同步动作**（`read.*` 全部是）：跨 tick 的读面会读到两个世界状态。
5. 产物落点即判据的 `params.path`；`role` 缺省时按动作名派生（`read.blocks` → `read-blocks`）。
6. 读面步骤与 `criteria` **同一份 run 目录**（`ActionContext.withParams` 共享 run）——
   这是「读面输出可被判据直接引用」的机械保证。
7. 变体补丁可以改 `read` 段的 `params`（负对照「读数变了判据该红」的基础），写法同其它段（RFC 6902 子集）。

## 3.2 action 段（L2 编排步骤，v1.6 / issue #103）

**这一段是「L2 = L0/L1 的有序编排」在代码上的落点。** 每步一个对象：

```jsonc
"action": [
  { "action": "scene.player.pose",
    "params": { "pos": [64.5, 13.0, 64.5], "yaw": 180, "allowFlying": true },
    "path": "action/0-pose.json", "role": "scene-player-pose",
    "expect": { "/after/isFlying": true, "/observed": true } },
  { "action": "scene.inventory.write",
    "params": { "target": "player", "slots": [{ "slot": 0, "id": "minecraft:stone", "count": 64 }] },
    "path": "action/1-give.json" },
  { "action": "player.place_block",
    "params": { "at": [64, 12, 64], "side": 1 },
    "path": "action/2-place.json",
    "expect": { "/blockAppeared": true, "/observed": true } }
]
```

**语义**：执行该动作（契约 §4 的**任意已注册同步动作**）→ 结果 JSON 落 run 目录的 `path` 并登记为产物
→ `expect` 非空时**当场**逐步断言。

### 与 read 段的对称与差异

| 项 | `read` 段（v1.3） | `action` 段（v1.6） |
|---|---|---|
| 步骤形态 | `{action, params, path, role?}` | `{action, params, path, role?, expect?}` |
| 动作名前缀 | **只许 `read.*`**（读面只读的静态落点） | **不限**（本职就是调 L0/L1 写动作） |
| 静态纪律 | 前缀 + 路径纪律 | ①禁编排收尾原语（见下）②路径纪律 |
| 同步性 | 静态声明为只许同步 | **执行期**判定（core 没有注册表） |
| 产物落点 | 同一 run 目录（`ActionContext.withParams` 共享 run） | 同左 |

### 校验口径（`case.validate` 与 `case.run` 同源）

1. `action` 必填；**不得是收尾原语**——`core.shutdown` 被 `CaseValidator.ACTION_FORBIDDEN` 明确拒绝：
   它会让本作业后续段（含 `criteria`/`evidence`）不再执行，收尾必须由驱动在**整跑结束后**单独发起。
2. `path` 必填、必须是合法的 run 目录内相对路径（防穿越）；同一次用例内**不得重复**，
   也不得与运行器自身产物（`manifest.json`/`criteria.json`/`evidence.json`/`observation.json`）重名。
3. `expect`（可选）形态是 **`{RFC 6901 指针: 期望值}`**，一个对象里可放多条，全部必须命中：
   - **空对象是错误**（空断言集恒绿——恒绿假断言是明确要防的失效模式）；要不断言就别写这个字段；
   - 指针必须 `/` 开头（`""` = 整棵结果对象，与 `json-field` 同口径）；单步上限 64 条；
   - 求值走 `Json.resolvePointer`——**与 `json-field`/`te-state-equals` 判据同一份实现**，不另起一套指针语义。
4. 动作是否真的已注册、是不是同步动作，由 `case.run` 的 `action` 段**执行期**判定
   （`CP-VALID-001`，`context.registered` 给出全部已注册动作名）；步进动作一律拒（`CP-VALID-002`）——
   本段在单次 `advance` 里逐条跑完，放行跨 tick 的动作会让「段完成」与「动作完成」脱钩。
5. 产物落点即判据的 `params.path`；`role` 缺省时按动作名派生（`player.place_block` → `action-player-place_block`）。
6. 变体补丁可以改 `action` 段的 `params`（负对照「编排参数变了判据该红」的基础），写法同其它段。

### 「逐步断言」的判定口径（#103 裁决 T3-3）

逐步断言不是「跑完再一起判」，而是**每步跑完当场判**：

- `expect` 命中 ⇒ 该步记 `ok:true` + `assertions[{pointer, expect, actual, ok}]`，继续下一步；
- 任一条不命中 ⇒ **当场 `CP-EXEC-001`**（`context.assertions` 逐条给出两侧值、`context.failed` 只列不命中项），
  本段中止，run 目录里留下的产物**正好停在失败那一步**——而不是一份「跑完了但判据红」的现场。

这条与 `criteria` 段的分工是：`criteria` 判**结论**（跑完之后，对全部产物求值），
`expect` 判**过程**（每一步的即时后果）。两者不互替：只有 `expect` 能在「第 3 步就已经错了」时
让第 4 步不要在一个错的基础上继续跑。

**前提：步骤间收敛**（`settleMs`）。逐步断言要求「第 N 步的结果」= 「第 N 步做完之后的世界」，
而 L1 的请求是包、服务端在它自己线程的 tick 里处理——不收敛就会让逐步断言**系统性假红**
（实机形态与修法详见 §10.7）。每一步之后的等待时长落该步的 `settleMs`。

### 分层标注（#96 §4.2）

编排段可以把 L0（`scene.*`）与 L1（`player.*`）混编，但**两层的结论不互替**：
L0 的产物不能当 L1 的证据。用例作者应在 `label` 或资产索引行里写明「本程序在哪一层取得结论」，
判据的 id 也应带上层前缀（`l0-*`/`l1-*`）以便机械区分。

## 4. capture / cameras 段（PR-2 起生效）

```jsonc
"capture": {                             // 可空：捕获会话参数（= capture.begin/end 包围 build 之后、shots 之前）
  "lighting": "natural",                 // natural | neutral-flat（会话默认，可被机位覆盖）
  "renderMode": "本色",                   // 本色 | 参与光照（豁免一，会话默认）
  "worldTime": 6000                      // 可空：拍摄光照基准
},
"cameras": [ CameraSpec, ... ]           // 可空：机位表（CameraSpec 见 contract.md §4.3），逐个调 shot.multi 同一实现
```

- 两段都空 → 不产截图；`cameras` 非空时才需要 forensic 级 token（`case.run` 权限按内容升格：含 cameras 段的用例必须 forensic 调用）。
- PR-1 行为（历史口径）：解析器接受并透传这两段，执行时跳过并标注 `deferred`——PR-2 起改为实际执行。
- 每机位产物：`shots/<name>.png` + `shots/<name>.meta.json`（机位参数与实际 renderMode/lighting/worldTime）；拼接机位另产 `shots/<name>.tiles/`。

## 5. criteria 段（判据与阈值）

每条判据：`{id, type, params, expect}`。`expect` 仅 `json-field` 强制要求并参与比较，其余类型按自身语义自证。`type` 注册表（v1）：

| type | params | 语义 |
|---|---|---|
| `artifact-exists` | `path` | run 目录内产物存在 |
| `artifact-nonempty` | `path, minBytes(默认1)` | 产物存在且字节数 ≥ minBytes（**非空断言**，V2） |
| `json-field` | `path, pointer(RFC 6901), expect(必填)` | JSON 产物字段等于 expect（RFC 6901 指针） |
| `world-hash-equals` | `—` | 重建后场景哈希等于本 run 首次构建哈希（幂等判据） |
| `event-emitted` | `kind, minCount(默认1)` | 事件流水含指定 kind 至少 minCount 条 |
| `image-size-equals`（PR-2） | `path, width, height` | 图像产物尺寸等于期望（读取 PNG 头，不解码全图） |
| `image-not-uniform`（PR-2） | `path, maxSameColorRatio(默认0.98)` | 图像非纯色——主色占比 < maxSameColorRatio（防黑屏/全白假图，负对照友好） |
| `te-state-equals`（PR-3，运行期轨） | `at[x,y,z], key(RFC 6901 指针，对描述器输出), expect(必填)` | 经补全器同族的 **TE 描述器**（TeDescriber，与 completer 同注册、只读不写）读取 TE 运行期状态字段（LP：renderState 连接矩阵/管型；AE2：各面部件清单），与 expect 比较；描述器输出同时进观测记录 runtimeReads（te.* 条目） |
| `image-uniform`（PR-3，图像轨补充） | `path, minSameColorRatio(默认0.98)` | 图像近纯色——主色占比 ≥ minSameColorRatio（TE 距离门远机位：被门剔除的场景应近似纯背景） |

> **本表的 `params` 列逐字等于自描述端点的 `params`**（§5.1 的三方对账口径）。
> 历史上这三行与端点不一致（`json-field` / `event-emitted` / `te-state-equals` 的默认值与指针形态写法不同），
> 由 `test/criteria/check-criteria-types.mjs` 在 #103 当场照出——**以端点为权威，本表向它对齐**。

**读面输出的判据引用（v1.3，issue #98）**：`read.*` 动作是 `observe` 级**普通动作**，不经用例文件——
它们由调用方在跑用例前后直接调，产物落 run 目录（`read.diff` 的 `expectManifestFile` 路径），
再用既有的 `json-field` 判据断言。**没有**为读面新增判据类型：读面要服务的是「读得全、读得准」，
而不是再造一套断言词汇；「读数进判据」这条链路由 `json-field` 的 RFC 6901 指针直接承担，
一处定义、一处求值。典型形态：

```jsonc
// criteria 段：引用 read.te 的族状态（与 te-state-equals 同一棵树，同一读取口）
{ "id": "read-te-pipe-up", "type": "json-field",
  "params": { "path": "read/te.json", "pointer": "/tiles/0/claimedState/connections/UP" },
  "expect": true }
// criteria 段：引用 read.blocks 的规范化哈希（与 read.diff 的 hashes 同口径）
{ "id": "read-blocks-hash", "type": "json-field",
  "params": { "path": "read/blocks.json", "pointer": "/sha256" },
  "expect": "<64 位十六进制>" }
// criteria 段：引用 read.diff 的差异计数（0 = 与期望态逐格一致）
{ "id": "read-diff-clean", "type": "json-field",
  "params": { "path": "read/diff.json", "pointer": "/different" }, "expect": 0 }
```

读面产物落 run 目录的路径约定（`read.diff` 的 `expectManifestFile` 路径）：`read/diff.json`，
role `read-diff`，登记进 `manifest.json`（§7 的 `evidence.expect` 可直接引用它）。

**双轨判据口径（#41，PR-3 起对锚点用例强制）**：同一可视特性必须成对断言——运行期轨（`te-state-equals`）证「世界状态对」，图像轨（`image-not-uniform`/`image-uniform`/`image-size-equals`）证「渲染结果对」。锚点用例（LP 四管/AE2 部件）的每个 TE 可视特性两轨齐备；双轨不齐的锚点用例视为用例缺陷（验收驱动静态检查）。

判据结论：`{id, verdict: "green"|"red"|"error", detail}`。`error`（判据自身无法求值，如产物缺失到连断言都不能做）视同 red 但单列。

### 5.1 `criteriaTypes`：判据类型的自描述（v1.3 起，本表是它的对齐对象）

`case.validate` 的结果里有 `criteriaTypes`，形态 `[{type, since, params}]`——**它是判据类型注册表的
唯一权威**，上面那张表与 `CriteriaEngine.TYPES` 都必须向它对齐（#103 G7 的三方对账）：

| 方 | 位置 | 角色 |
|---|---|---|
| ① 自描述端点 | `case.validate` 的 `criteriaTypes`（数据源 `CriteriaEngine.typeCatalog()`） | **唯一权威**：调用方据此知道能写哪些判据、各自参数形态与引入版本 |
| ② 注册表 | `CriteriaEngine.TYPES`（`CaseParser.parseCriteria` 用它判「未知判据类型」） | 必须与 ① **同序、同集合、逐条 `type`/`since`/`params` 一致** |
| ③ 本文件 §5 的表 | 人读形态 | 必须与 ① 逐行一致 |

机械保障：`CaseParserTest#criteriaTypeCatalogContentIsLocked` 锁 ①② 的逐条内容
（原先是只锁数量的 `assertEquals(9, TYPES.size())`——改名/改 `since`/改 `params` 都不会红，那是漂移的温床）；
③ 的对账快照在 `test/criteria/criteria-types.json`，比对方法见 `test/criteria/README.md`。

**判据类型的引入版本**（`since`，口径同动作的 `since`）：

| type | since |
|---|---|
| `artifact-exists` / `artifact-nonempty` / `json-field` / `world-hash-equals` / `event-emitted` | 1.0 |
| `image-size-equals` / `image-not-uniform` | 1.1 |
| `te-state-equals` / `image-uniform` | 1.2 |

**v1.6 没有新增判据类型**：`action` 段是**段**的扩充（编排能力），不是判据词汇的扩充——
编排步骤的期望值由 §3.2 的 `expect`（逐步断言）承担，跑完之后的结论仍由既有 9 种判据在
`criteria` 段求值。因此 `criteriaTypes` 在 v1.6 逐字不变，**这正是对账要证明的事**。

## 6. variants 段（负对照，C6/V3 落地）

每个变体：`{id, mutate, expectCriteriaRed: [...]}`。
- `mutate` 是对本用例 JSON 的覆盖补丁（RFC 6902 子集：replace/add/remove on 顶层段与 build 步骤数组元素）；
- 校验期即试算补丁：补丁失败按 `variants[i].mutate[j].path` 逐字段报错；**补丁未改变用例内容 → 校验报错**（防恒绿假断言）；`expectCriteriaRed` 必须引用已存在的判据 id；
- 「补丁适用性」判定只对**原始用例**成立：执行期对**补丁产物文档**的再校验必须跳过该类判定（产物文档已是补丁值，再应用同一补丁必然幂等报"未改变"——实现为 `VariantCheck.ENFORCE/SKIP`，SKIP 只跳过适用性判定，其余字段校验照旧）；
- 运行器对变体执行同一实现，断言：`expectCriteriaRed` 列出的判据**必须变红**——不变红则变体用例本身判 red（防恒绿假断言）。

## 7. evidence 段（期望证据清单）

```jsonc
"evidence": {
  "expect": [
    {"path": "observation.json", "role": "observation"},
    {"path": "criteria.json", "role": "criteria"},
    {"path": "world/scene-manifest.json", "role": "scene-manifest"}
  ]
}
```
运行结束逐条核对，缺失即判据 `evidence-complete` 变红。`expect` 允许为空数组（校验期给 warning），`evidence` 段本身必填。

## 8. 执行语义

1. **整跑**：`POST /cp/v1/actions/case.run {file|inline, confirm:true}` → 依序执行 world→build→read→(capture)→(shots)→criteria→evidence。
2. **按段**：`segments:["world","build"]` 只跑指定段；段间状态是真实世界状态（不是重放），因此**按段连跑的结果必须与整跑一致**（验收锚）。判据段在新 run 中求值时，若引用的产物在本 run 不存在，必须**从当前世界状态重新产出**（如重新扫描托管区域生成 scene-manifest.json）再求值。
3. 每段产出 `segments/<name>.json`（状态、耗时、产物引用；skipped/deferred 段也先落记录）；**`observation.json` 必须在判据段求值之前落盘**（判据可引用它）；判据汇总 `criteria.json`（纯判据语义），证据核对结论落 `evidence.json`（schema `lightning.cp-evidence/1`），合并结论在 `result.overall`（判据与证据任一红/错即 red）。
4. run 目录：`<mcDataDir>/controlplane/runs/<yyyyMMdd-HHmmss>-<caseId>-<jobSeq>/`（jobSeq 为数字作业序号，jobId 形态 `j<seq>`），全程只增不改；`manifest.json`（schema `lightning.cp-manifest/1`）登记全部产物的 sha256。tokens/server 内部文件 schema 分别为 `lightning.cp-tokens/1`、`lightning.cp-server/1`。`case.run` 必须把 runId 挂上作业（`GET /cp/v1/jobs/{id}` 可见）。
5. **变体执行**：`variant:"<id>"` 只跑该变体；不带 variant 时整跑后顺带执行**不改动 world/build 段**的全部变体（改动 world/build 的变体标 `evaluated:false` + 原因，须用 `variant` 单独跑——避免整跑里叠加多次世界重建）。结论写入结果（`variants:[{id, allExpectedRed, evaluated, criteria:[...]}]`）。变体应用补丁后跑同一实现；`expectCriteriaRed` 列出的判据**必须变红**——不变红则作业判 failed（防恒绿假断言）。
6. 失败即停（ fail-fast ），已完成的段保留产物；`job` 结果携带失败段与错误码。
7. `world.rebuild` 结果含 `sceneManifestSha256`；`world-hash-equals` 判据的哈希口径：first=本 run build 段产物（按段续跑时取存档内清单），current=服务端世界按清单位置**实读回读**后的规范化哈希——世界未漂移时两者相等，漂移时如实判红。场景清单哈希只覆盖 `{blocks:[{pos,blockId,meta}], tileEntities:[{pos,class}]}`（键排序无空白 sha256，pos 升序）；注册名/种子不入哈希——哈希回答「世界是不是同一场景」。清单另含 `teReads:[{pos,completer,state,sha256}]`（PR-3：te 步描述器输出快照），**不进清单哈希**——它只是审计快照，改它不影响幂等判据。

### 8.8 hermetic 纪律（验收类固定程序必须起手重建世界）

> 本节成文 #93 的处置口径，是 #96 §12 对 #93「解除条件」的落地。**它是纪律，不是能力**——
> `world.rebuild` 早已具备（§2 的 `void:true` + 契约 §6.3 的「删除 → 建虚空世界」），
> 缺的是「验收必须先走它」这条硬要求。

**规则**：凡以「同参同世界、结论可复算」为前提的固定程序（回归套件、锚点用例、逐帧导出复现、
任何要跨轮比较哈希的验收），其**第一次世界写动作必须是 `world.rebuild`**（`void:true`），
不得在既有世界上续跑。

**理由（#93 的实测机理）**：老一代套件复用专用世界文件夹（`level.dat` 存在即复用），清场走 FMP
`remPart`——**只拆部件、不拆方块**。上一轮运行若中断，残留方块（torch/chest 等）留在世界里污染
下一轮，三套件同族红签名（`minecraft:torch:0 应为 12 实际 14` 等）都无法区分「产品回归」与「世界脏」。
只要起手不换世界，「同参同世界」这个前提就**不成立**，任何跨轮哈希比较都是无根之木。

**为什么 `world.rebuild` 够用**：它走「卸载 → **整目录删除** → 固定种子建虚空世界」（契约 §6.3），
残留不可能跨轮存活；`void:true` 是全虚空（无基岩无土层），世界本身不产生任何计划外方块。
因此「起手重建」＝「这个世界是全新的」，前提重新成立。

**与 `case.run` 的 `world` 段的关系（语义不冲突，逐条对齐）**：

| 项 | `case.run` 的 `world` 段 | hermetic 纪律 | 是否冲突 |
|---|---|---|---|
| 实现 | `WorldRebuildRunner`（`CaseRunAction.stepWorld`，见 §2） | 要求走 `world.rebuild` | 否——**同一实现**，契约 §6.3 明写「共用同一实现」 |
| 语义 | 卸载 → 删目录 → 建虚空世界（**只重建世界**，构建步在 `build` 段） | 起手换掉世界 | 否——正是纪律要的那一步 |
| `void` | §2 必填且只许 `true` | 要求 `void:true` | 否——口径一致 |
| 段序 | `world → capture → build → cameras → criteria → evidence`（§1、§8.1） | 要求 world 在**第一次世界写之前** | 否——`world` 是首段 |
| 产物 | 写 run 内 `world/scene-manifest.json` + 存档内 `scene-manifest.json` | 不涉及 | 否 |
| 幂等 | 同参两次 `sceneManifestSha256` 相等 | 跨轮可比的前提正是它 | 否——纪律依赖它成立 |

**因此**：`case.run` 的 `world` 段**就是** hermetic 纪律在固定程序里的落点，二者是同一件事的两种说法，
无需改 `case.run` 语义。纪律要管的是**程序怎么写**（`world` 段必须存在且必须重建，不能省略、
不能让程序接着上一轮的世界跑），不是**设施怎么实现**。

**执行层约束（三条，可判定）**：

1. **`world` 段不得省略**：验收类用例的 `world` 段必填且 `void:true`（已有校验，§2）。
   只跑判据段（`segments:["criteria"]`）这类续跑**只有在同一轮内**才合法——跨轮续跑即违反纪律。
2. **不得隐式复用上一轮的世界**：程序起手要么 `world.rebuild`，要么 `case.run` 的 `world` 段；
   任何「先探一下世界在不在、在就接着用」的写法都违反本节。
3. **轮内清场不等于起手重建**：`scene.entity.clear`（#99）等轮内原语清实体但不清方块、不清背包、
   不重置天气时间，**不构成 hermetic 保证**，不能替代起手重建。
4. **L1 玩家操作也是世界写动作（#101 明确）**：`player.*`（见 contract.md §4.6）会改方块、背包、
   实体与玩家位置，因此**同样受本节约束**——它们开场一律过写入门控
   （捕获会话期间被别的作业调用即 `CP-STATE-001`），且**不得**被当作「起手重建的替代品」：
   程序起手仍必须是 `world.rebuild`（或 `case.run` 的 `world` 段），L1 只能发生在**其后**。
   反向也成立：L1 的产物**不构成** hermetic 保证（走过一段路不改变「世界是不是全新的」这件事）。

**留痕**：`world.rebuild` 的删除阶段落 `world-rebuild` 事件（含 folder/seed），与
`sceneManifestSha256` 一同构成「本轮确实从新世界开始」的可审计证据链。

**边界（如实标注）**：本节管**世界**的 hermetic（方块/TE/实体所在的那份存档）。
**玩家侧状态**（背包、经验、药水效果、飞行）在 1.7.10 落 `<saves>/<folder>/playerdata/`，
**在**存档目录内，因此随 `world.rebuild` 的整目录删除一并复位。
**客户端侧**的易失渲染状态不在此列，由捕获层的会话纪律管（契约 §4.2）。

## 9. 文件解析与校验规则

- 只接受 UTF-8 JSON；未知顶层字段报错（防笔误静默）；段内未知字段报错。
- `case.validate` 返回规范化计划：解析后的段列表、每条判据的展开形态、期望证据清单、全部警告。
- 坐标、id、阈值全部做范围校验；`CP-VALID-002` 的 `context.fields` 逐字段给原因。

## 10. 产物比较模式（A3「同一固定程序执行两次，产物结构一致」的口径，v1.6 / #103 任务 2）

> 需求书 §10 A3 的原文是「同一固定程序执行两次，产物结构一致」——**「结构」二字必须有定义**，
> 否则这句话不可判定。本节把它拆成四种可执行的比较模式 + 一张可审的豁免字段表。
> 本节是 `test/expected/` 基准的比对口径来源，也是 A3 验收（两次 run 的比对记录）的判定依据。

### 10.1 四种比较模式（逐产物声明，四选一）

| 模式 | 语义 | 典型产物 | 判定方式 |
|---|---|---|---|
| `byte-equal` | 逐字节相同 | `world/scene-manifest.json` 的 `blocks`/`tileEntities` 段、导出件正文 | 两侧文件字节序列相等（sha256 相等是充分条件） |
| `canonical-hash-equal` | 规范化 JSON（键排序、无空白）的 sha256 相同 | `criteria.json` 的判据结论集、`scene-manifest.json` 的 `sha256` 字段 | 两侧 `Json.canonical` 后取 sha256 相等 |
| `structural-equal` | 结构相同（键集合 + 类型 + 数组长度 + 值按同一豁免表归一后相等） | `observation.json`、`segments/*.json`、`evidence.json` | 递归比较：键集合相等、类型相等、数组长度相等、值按 §10.2 归一后相等 |
| `presence-only` | 只要求存在且非空 | 图像/截图（`shots/*.png`）、拼接片（`shots/*.tiles/r*c*.png`）、`logs/*` | 文件存在且字节数 > 0 |

**为什么是四种而不是一种**：`byte-equal` 最严但绝大多数产物做不到（时间戳/runId 天然每次不同）；
`presence-only` 最松但图像只能这么比（像素内容会话易失，#59 的 LP 空壳 VBO 事件已证）。
把模式**逐产物声明**而不是全局放宽，是为了让「这次为什么只比在场」有一个可审的落点——
「跑不过就放宽」与「按机理豁免」的区别就在这里。

### 10.2 豁免字段表（逐条给契约或机理出处，**豁免要能被审**）

| 字段 | 出处 | 为什么豁免 | 适用模式 |
|---|---|---|---|
| `runId` | 所有 run 产物 | 形态 `<yyyyMMdd-HHmmss>-<caseId>-<jobSeq>`（§8.4），含时间戳，天然每次不同 | 全部 |
| `createdAt` / `generatedAt` / `recordedAt` / `readAt` / `regeneratedAt` | `manifest.json` / `criteria.json` / `evidence.json` / `segments/*.json` / `read/*.json` | 挂钟时间 | 全部 |
| `durationMs` | `segments/*.json` | 耗时 | 全部 |
| `runDir` / `runsRoot` / 绝对路径 | `read/run.json`、`segments/*.json` | 含 `<mcDataDir>` 绝对前缀，跨机器不同 | 全部 |
| `playerPos` / `worldTime` / `sinceEnterMs` / `totalTime` | `world.json`、`observation.json` | 实时状态（进图时间、玩家微调位置、世界时钟） | 全部 |
| `observation.artifacts[].sha256` / `bytes` | `observation.json` | 随产物变化；产物本身若已豁免，其哈希也豁免 | 全部 |
| `world/scene-manifest.json` 的 `mismatches[]` | 实测 | 是**留痕**不是期望值（如 `minecraft:chest` 的 meta 被世界从 0 改写为 3） | 全部 |
| `teReads[]` | `scene-manifest.json` | **契约已明写**不进清单哈希（§8.7），只是审计快照 | 全部 |
| 图像像素内容 | `shots/*.png` | 渲染状态会话易失（#59 VBO 事件）；图像只做「存在 + 尺寸 + 主色占比阈值」判定 | `presence-only` |
| `jobSeq` | `manifest.json` | 作业序号，进程内单调递增，跨轮必然不同 | 全部 |

**新增豁免必须在本表留下理由与出处**。豁免的准入标准只有一条：**能指到契约条款或已实测的机理**。
「这次跑不过所以先豁免它」不是理由——那正是把 A3 变成纸面口径的方式。

### 10.3 比较对象（比哪些产物）

| 产物 | 模式 | 说明 |
|---|---|---|
| `world/scene-manifest.json` | `canonical-hash-equal`（整份）+ `byte-equal`（`blocks`/`tileEntities` 两段） | 哈希回答「世界是不是同一场景」；两段字节相等回答「清单文本是不是逐字一样」 |
| `criteria.json` | `canonical-hash-equal`（`criteria[]` 的 `{id,type,verdict}` 投影） | 判据**结论**必须逐条一致；`detail` 里的人读文字不参与（可含读数） |
| `evidence.json` | `canonical-hash-equal`（`{overall, verdict}` 投影） | 结论一致 |
| `observation.json` | `structural-equal` | 结构必须一致（版本/客户端配置/产物引用齐备），值按 §10.2 归一 |
| `segments/*.json` | `structural-equal` | 逐段结构一致（`segment`/`status`/`detail` 键集合与类型） |
| `shots/*.png` | `presence-only` | 存在且非空；尺寸与主色占比由**判据**（`image-size-equals` 等）承担，不由比对器承担 |
| `read/*.json`、`action/*.json` | `canonical-hash-equal`（豁免归一后） | 读数/编排产物必须逐字一致（它们是判据的输入，不一致即判据不可复算） |

### 10.4 可执行方式（口径不能是纸面的）

比对器在 `test/expected/compare-runs.mjs`：输入两个 run 目录（或一个 run + 一份基准清单），
逐产物按 §10.3 声明模式比较，输出机读 JSON + 人读表，退出码 `0`=全一致 / `2`=有差异 / `3`=设施错误。

```bash
# 两次 run 互比（A3 的标准形态）
node test/expected/compare-runs.mjs --a <runDirA> --b <runDirB> --json-out compare.json

# 与基准清单比（expected/ 的形态）
node test/expected/compare-runs.mjs --run <runDir> --baseline test/expected/<caseId>/manifest.json
```

**证伪要求（判据不恒绿）**：比对器必须对「改坏」变红。`test/expected/` 里附一份
篡改记录（把某一产物改一个字节 / 改一个字段 → 比对器必须以 2 退出并**指名**该产物），
否则「基准」只是死文件。

### 10.5 自引用产物：`read/run.json`（#103 实机实测，必须单列一条）

`read.run` 枚举的是**整个 runs/ 目录**，因此它必然包含**本 run 自己**，条目数与总字节数
随 runs 目录里的 run 数**单调增长**（实机：3554B → 9206B → 16047B）。

**它不是「同参同产物」**——同一份固定程序跑两次，它的值必然不同，而这**不是漂移**。
因此它的比较模式固定为 `presence-only`（存在且非空）。把它的内容纳入值比较，
会让**任何** A3 比对恒红，从而把 A3 变成一句做不到的话。

**这条不是豁免宽松化，而是口径的正确归属**：`read.run` 的语义是「此刻有哪些 run」，
那是**关于设施的问题**，不是**关于这个世界的问题**；后者才是固定程序要复现的东西。

### 10.6 豁免的两条纪律（从本单的实机比对过程里提炼）

A3 的成文口径不是一次写成的。本单实机跑了三轮，前两轮的比对报告直接决定了口径的最终形态；
两条纪律是那三轮的产物，写在这里以免后来者重犯：

1. **豁免必须按路径，不能按字段名**。`artifacts[].sha256` 要豁免（它随产物变化），
   但 `world/scene-manifest.json` 的 `sha256` **恰恰是要比的核心值**——把 `sha256` 写成全局豁免字段
   会连带把它挡掉（首轮实现就是这么写的）。正确形态：`**/artifacts/*/sha256` 这样的**路径**豁免。
   同族的例子：`chunks.loaded`（实时计数，豁免）vs `world.loaded`（布尔「加载了没」，**不**豁免）——
   同名字段、不同语义。
2. **豁免必须由证据支持，不是由建议支持**。前置盘点的 taxonomy 草案曾建议豁免
   `mismatches` 与 `teReads`；实机两轮证明二者**逐字可复现** ⇒ **撤回豁免**，
   并加断言锁住「它们参与比较」。`mismatches` 的语义说明（「是留痕不是期望值」）不构成
   非确定性的证明——留痕也可以是可复现的。

   反向也一样：`read/overview.json` 的世界时钟、天气倒计时、已加载区块计数，
   在**实机比对报告里被指名**为逐轮不同，才获得豁免资格。

**第三步是「人读文字」这一类**：`summary`/`detail`/`note`/`message`/`reason` 这些字段按设计会
引用 runId、字节数、绝对路径（观测记录的 `summary` 就是给离线解释用的）。它们的作用是**解释**，
不是**断言**——真正的断言是与它们并列的 `verdict`/`status`/`sha256`。
因此这一类**只豁免内容、不豁免结构**：`detail` 从字符串变成对象、或整个键消失，都必须红。

### 10.7 步骤间收敛（`action` 段专有，v1.6 / #103）

`action` 段在**单次 `advance`** 里逐条跑完（其成员必须是同步动作），而 L1（`player.*`）
的请求是**包**：客户端发出 C03/C07/C08，服务端在它自己线程的 tick 里处理
（`MinecraftServer.updateTimeLightAndEntities → networkTick`）。因此「上一步发了包」与
「下一步能读到它的后果」之间隔着服务端的一拍；**更微妙的是 `scene.*` 也走同步出口**
（如 `scene.player.pose` 的 S08 是服务端→客户端方向），而本段阻塞在客户端 tick 线程上——
客户端自己那一拍因此永远不来。

**因此本段在每步之后做一次往返收敛**（`PlayerSession.completeClientRequest`：
flush 入站包 + 等服务端 tick，与 L1 动作回读前的收尾同一份实现），`read.*` 除外（纯读）。
等待时长写进该步的段记录 `settleMs`（失败记 −1），让「等了多久」**可见**而不是隐式。

**这是「逐步」二字的题中之义**：没有它，「第 N 步的结果」就不是「第 N 步做完之后的世界」，
逐步断言会系统性地假红（实机形态：`player.move` 的 `serverBefore` 还是上一步之前的位置，
`movedServerBlocks=0`、`observed=false`）。

### 10.8 `core.shutdown` 的退出码来源：读**两份**结论（v1.6，实测缺陷的成文）

`core.shutdown` 的退出码对齐的「run 结论」= **`criteria.json` 与 `evidence.json` 两份的
合并结论**（任一非绿即红），与 `case.run` 的作业结果 `overall` 逐字同源。

**为什么不能只读一份**：两份文件的语义不同、不可互替——
`criteria.json.overall` 是用例声明的**判据**结论，`evidence.json.overall` 是**期望证据核对**
结论（该在场的产物在不在）。实机实测确实存在 `criteria=red` 而 `evidence=green` 的 run
（一次 `l1-orchestration` 的 2 条判据红、12 项期望产物齐备）。只读其一会对那次红跑返回
**0「判据全绿」**——那是把一次红跑读成绿跑，是本动作最不该犯的错。

run 目录里**没有**持久化「合并结论」的字段（job result 里的 `overall` 只活在内存与响应里），
因此退出码必须由这两份文件**重新合并**得出；合并规则不重造，与 `CaseRunAction.overall()` 同一口径。
