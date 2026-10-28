# 声明式用例文件规范（lightning.case/1）

用例文件由控制面解析并执行：`case.validate` 返回规范化执行计划，`case.run` 按计划执行。两者共用同一模型与解析器（`controlplane/core/` 的 `CaseFile` / `CaseParser` / `CaseValidator`），不存在第二套校验。

## 1. 顶层结构

```jsonc
{
  "schema": "lightning.case/1",          // 必填，精确匹配
  "id": "lp-pipe-row",                    // 必填，[a-z0-9-]+，参与 run 目录名
  "label": "LP 四格管道参照",              // 展示名
  "world":    { ... },                   // 必填：世界构建方式（§2）
  "capture":  { ... },                   // 可空：捕获会话参数（§4）
  "build":    [ ... ],                   // 可空：场景构建步骤（§3）
  "read":     [ ... ],                   // 可空：读面步骤（§3.1）
  "action":   [ ... ],                   // 可空：L2 编排步骤（§3.2）
  "export":   [ ... ],                   // 可空：导出步骤（§3.3）
  "cameras":  [ ... ],                   // 可空：机位表（§4）
  "criteria": [ ... ],                   // 必填，至少一条：判据与阈值（§5）
  "variants": [ ... ],                   // 可空：负对照变体（§6）
  "evidence": { ... }                    // 必填：期望证据清单（§7）
}
```

**段序即执行序**（九段）：

```
world → capture → build → read → action → export → cameras → criteria → evidence
```

本节的段序串是文档里的唯一字面副本；源码权威是 `CaseValidator.SEGMENTS`，其他文件与 `contract.md` 只引用本节。非段名（例如把机位产物目录 `shots/` 当段名）会得 `CP-VALID-002`。段序与全仓 `docs/` 段序串的一致性由 `CaseSegmentOrderDocTest` 断言。

## 2. world 段

```jsonc
"world": {
  "folder": "cp_lp_pipe_row",   // 必填，必须 cp_ 前缀（托管世界规则见 contract.md §10）
  "seed": 20261006,             // 必填，固定种子
  "void": true,                 // 必填且只许 true
  "base": [64, 12, 64],         // 可省；出现相对坐标时必填（缺则 CP-VALID-002 指向对应 build[i].at）
  "settleTicks": 60             // 构建后静置 tick 数，默认 60
}
```

`world` 段走 `WorldRebuildRunner`（与 `world.rebuild` 同一实现）：卸载 → 删除托管存档目录 → 写标记（`complete:false`）→ 建虚空世界 → 场景构建 → 静置 → 标记完成。用例没有 `build` 段时由 `world` 段自己标记完成。

## 3. build 段（场景构建步骤，有序执行）

每步一个对象，`op` 判别：

| op | 参数 | 语义 |
|---|---|---|
| `clear` | `from:[x,y,z], to:[x,y,z]` | 托管区域清场（`setBlockToAir`） |
| `block` | `at:[x,y,z], id:"minecraft:stone", meta:0` | 放置方块 |
| `te` | `at:[x,y,z], completer:"vanilla"\|"lp-pipe"\|"ae2-part"\|"gt-machine", params:{...}` | TE 状态补全（经模组自身权威同步路径，`contract.md` §10 第 6 条） |
| `wait` | `ticks:N` | 等待 N tick |

坐标三种写法，一律规范化为绝对坐标：绝对数组 `[x,y,z]`；`"@base"` + 同层 `offset:[dx,dy,dz]`；字符串 `"base+[dx,dy,dz]"`。`world.base` 只接受绝对数组。构建完成后运行器自动执行 TE 补全（`te` 步声明的）→ `markBlockRangeForRenderUpdate` → 静置 `settleTicks`。

`te` 步的 `completer` 必须在注册表中（`vanilla` / `lp-pipe` / `ae2-part` / `gt-machine`）。`gt-machine` 的 `params` 是放置输入：`{machine:"Machine_LV_ChemicalReactor"}`（GT `ItemList` 常量名，首选）或 `{item:"gregtech:gt.blockmachines", meta:421}`（显式 MetaTileEntity id，须 > 0），可选 `side`（`DOWN`/`UP`/`NORTH`/`SOUTH`/`WEST`/`EAST`，默认 `UP`）。补全器自带放置与放置后读回验证，读回空壳即 `CP-EXEC-001`，因此用例不要先用 `block` 步铺 GT 机器方块。给机器供电用 `scene.inventory.write`（`battery` + `charge:"full"` 写进充电槽）；给机器注流体用 `scene.tank.fill`，读回走 `read.te` 的 `tanks` 字段。

## 3.1 read 段（读面步骤）

每步：`{action, params, path, role?}`。执行 `read.*` 动作，把返回 JSON 落 run 目录的 `path` 并登记为产物。

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

校验口径（`case.validate` 与 `case.run` 同源）：

1. `action` 必填且必须以 `read.` 开头（`CaseValidator.READ_ACTION_PREFIX`）。动作是否已注册由执行期判定（`CP-VALID-001`，`context.registered` 给出全部已注册动作名）。
2. `path` 必填、必须是 run 目录内的合法相对路径（拒绝路径穿越）；同一用例内不得重复，也不得与运行器自身产物（`manifest.json`、`criteria.json`、`evidence.json`、`observation.json`）重名。
3. 空 `read` 段给 warning，不是错误。
4. 读面步骤必须是同步动作（`read.*` 全部是）。
5. `role` 缺省时按动作名派生（`read.blocks` → `read-blocks`）。
6. 读面步骤与 `criteria` 段共用同一 run 目录（`ActionContext.withParams` 共享 run），因此判据可直接引用读面产物。
7. 变体补丁可以改 `read` 段的 `params`。

## 3.2 action 段（L2 编排步骤）

每步一个对象：

```jsonc
"action": [
  { "action": "scene.player.pose",
    "params": { "pos": [64.5, 13.0, 64.5], "yaw": 180, "allowFlying": true },
    "path": "action/0-pose.json", "role": "scene-player-pose",
    "expect": { "/after/isFlying": true, "/observed": true } },
  { "action": "player.place_block",
    "params": { "at": [64, 12, 64], "side": 1 },
    "path": "action/2-place.json",
    "expect": { "/blockAppeared": true, "/observed": true } }
]
```

语义：执行该动作 → 结果 JSON 落 run 目录的 `path` 并登记为产物 → `expect` 非空时当场逐步断言。本段的默认语义是在单次 `advance` 内逐条跑完同步动作。

### 跨帧的输入固定程序

输入族步进动作是本段唯一的跨 tick 例外——不推进它就无法表达「注入输入 → 推进 N tick → 读后果」：

```jsonc
"action": [
  { "action": "input.key",
    "params": { "key": "key.forward", "action": "tap" },
    "holdTicks": 20,
    "path": "action/0-hold-w.json", "role": "input-hold-forward",
    "expect": { "/delivered": 2 } },
  { "action": "input.key",     "params": { "key": "key.forward", "action": "down" }, "path": "action/1-down.json" },
  { "action": "input.state",   "params": {  }, "path": "action/2-held.json",
    "expect": { "/held/count": 1 } },
  { "action": "input.release", "params": {  }, "path": "action/3-release.json" },
  { "action": "input.state",   "params": {  }, "path": "action/4-released.json",
    "expect": { "/held/count": 0 } }
]
```

规则：

1. **例外集合**：`CaseValidator.ACTION_STEPPING_INPUT_ACTIONS` = `input.key` / `input.mouse`。其余步进动作在 `action` 段仍被拒（`CP-VALID-002`）。
2. **每 tick 推进一次**：在飞的输入步每次 `advance` 恰好推进一步；未完成即让出本 tick（不 sleep、不忙等、不在段内循环到完成），完成也到此为止——每个输入步至少占一个 tick。相邻的同步步骤仍在同一 tick 内连跑；需要额外帧边界时插入一个输入步。
3. **完成前不进入下一步骤**：后续步骤（含读断言）不抢跑。
4. **`holdTicks` 在步骤对象顶层**（与 `params` 并列）：精确整数 `1..1200`；`1` = 同一次调用内 down+up，`≥2` = 第 `holdTicks` 个 tick 抬起。不写即由动作自己的缺省（`1`）决定，执行器不补隐式持有量。
5. **输入族步进步的 `params` 内不得出现 `holdTicks`**：只写在 `params` 内或两处都写 ⇒ `CP-VALID-002`。该约束只适用于输入族步进步，不越过动作边界否决其它动作的同名参数（如 `player.dig` 的 `params.holdTicks`）。
6. **不适用字段显式拒绝**：同步动作写 `holdTicks`、`input.key` 的 `action` 不是 `tap`、`input.mouse` 的 `op` 不是 `click`，三种都在 `case.validate` 期报 `CP-VALID-002` 并给出字段上下文。
7. **输入步不走步骤间收敛**（§8 第 9 条）：它的等待是 tick 推进，不是墙钟。
8. **收尾释放所持按下态**：段内失败、阶段超时、段异常三条路径都释放（失败现场释放一次，`onFinish` 再释放一次，幂等），释放走 `input.release` 的同一实现；该动作未注册时记 warn 事件，并由每个持有点的 1200 tick 到期自动释放。
9. **段产物形态不变**：`segments/action.json` 与每条步骤记录的字段集合不因本例外改变；输入步的 tick 推进明细落在该步自己的 `action/N-*.json`。

### 与 read 段的对照

| 项 | `read` 段 | `action` 段 |
|---|---|---|
| 步骤形态 | `{action, params, path, role?}` | `{action, params, path, role?, expect?, holdTicks?}` |
| 动作名前缀 | 只许 `read.*` | 不限 |
| 禁止项 | 写动作 | 收尾原语（`core.shutdown`） |
| 同步性 | 静态要求同步 | 执行期判定：同步动作 + `input.key`/`input.mouse` |
| 产物落点 | 同一 run 目录 | 同一 run 目录 |

### 校验口径

1. `action` 必填；不得是收尾原语——`core.shutdown` 被 `CaseValidator.ACTION_FORBIDDEN` 拒绝（它会让本作业后续段不再执行，收尾由驱动在整跑结束后单独发起）。
2. `path` 必填、必须是 run 目录内的合法相对路径；同一用例内不得重复，也不得与运行器自身产物重名。
3. `expect`（可选）形态为 `{RFC 6901 指针: 期望值}`，一个对象内可放多条，全部必须命中：空对象是错误（空断言集永远通过，属必须排除的失效形态）；指针必以 `/` 开头（`""` 表示整棵结果对象）；单步上限 64 条（`CaseValidator.MAX_STEP_EXPECT`）；求值走 `Json.resolvePointer`，与 `json-field`/`te-state-equals` 判据同一实现。
4. 动作是否已注册、是同步还是步进，由执行期判定（`CP-VALID-001`，`context.registered` 给出全部已注册动作名）。非输入族的步进动作一律拒（`CP-VALID-002`）。
5. `role` 缺省时按动作名派生（`player.place_block` → `action-player-place_block`）。
6. 变体补丁可以改 `action` 段的 `params`。

**逐步断言的判定**：`expect` 命中 ⇒ 该步记 `ok:true` 与 `assertions[{pointer, expect, actual, ok}]`，继续下一步；任一条不命中 ⇒ 当场 `CP-EXEC-001`（`context.assertions` 逐条给两侧值，`context.failed` 只列不命中项），本段中止，run 目录里的产物停在失败那一步。

**分层标注**：编排段可以混编 L0（`scene.*`）与 L1（`player.*`），两层的结论不互替；判据 id 应带层前缀（`l0-*`/`l1-*`）以便机械区分。

## 3.3 export 段（导出步骤）

每步：`{action, params}`。执行 `export.*` 动作，产物落本用例的 run 目录并登记哈希；落点由导出动作决定，段里不声明。

```jsonc
"export": [
  { "action": "export.scene",
    "params": { "name": "lp-pipe-row", "shape": "world", "frames": "all" } }
]
```

校验口径：

1. `action` 必填且必须以 `export.` 开头（`CaseValidator.EXPORT_ACTION_PREFIX`）。该段另允许 `CaseValidator.EXPORT_SEGMENT_EXTRA_ACTIONS` 中的 `cmd.exec` 与 `scene.player.pose`（造帧缓冲与摆玩家这两件导出前置事实）；`cmd.exec` 携带的子命令限 `CaseValidator.EXPORT_SEGMENT_FRAMING_SUBS` 的成帧类子命令（`pos1`、`pos2`、`hpos1`、`hpos2`、`sel`、`start`、`end`、`setname`、`setframe`、`setstructureid`、`record`、`status`），`export`/`dump`/`multiblock` 在段内被拒。
2. 段里不接受 `path`/`role`（未知字段即 `CP-VALID-002`）：落点由导出动作决定。
3. 空 `export` 段给 warning，不是错误。
4. 导出动作可以是步进动作：`export.scene` 在 `onBegin` 一次性取走帧缓冲快照，跨 tick 不引入撕裂；段内循环推进到完成，上限 `CaseRunAction.MAX_EXPORT_STEPS`（200），产物落在用例自己的 run 目录。
5. 产物落点与 role 见 `contract.md` §7.8；判据用 `artifact-exists`/`artifact-nonempty`/`json-field` 指向 run 内的那份文件。
6. 变体补丁可以改 `export` 段的 `params`。

`frames:"all"` 导出缓冲内全部帧；`expectFrames:{frames:[0,1,2]}` 是调用方侧的同会话判据，不符即 `CP-STATE-001`（带 `extra`/`missing`）。字段口径见 [format-scene-file.md](../contracts/format-scene-file.md)。

## 4. capture 与 cameras 段

```jsonc
"capture": {                             // 可空：会话默认（= capture.begin/capture.end 包围 build 之后、shots 之前的区间）
  "lighting": "natural",                 // natural | neutral-flat
  "renderMode": "本色",                   // 本色 | 参与光照
  "worldTime": 6000                      // 可空：拍摄光照基准
},
"cameras": [ CameraSpec, ... ]           // 可空：机位表（CameraSpec 见 contract.md §9 第9条）
```

1. 两段都空 ⇒ 不产截图。
2. `cameras` 非空时 `case.run` 按内容升格为 `forensic`：不足该级时同步调用得 HTTP 403 `CP-AUTH-002`，异步作业得 `state=failed` 且 `error.code=CP-AUTH-002`。
3. 每机位产物：`shots/<name>.png` + `shots/<name>.meta.json`（机位参数与实际 `renderMode`/`lighting`/`worldTime`），拼接机位另产 `shots/<name>.tiles/`。
4. `capture` 段建立捕获会话（`capture.begin`），会话期间一切世界写动作被拒 `CP-STATE-001`。

## 5. criteria 段（判据与阈值）

每条判据 `{id, type, params, expect}`。`expect` 仅 `json-field` 与 `te-state-equals` 必填并参与比较，其余类型按自身语义自证。

判据类型（v1 共 9 种；`params` 列与自描述逐字一致）：

| type | params | 语义 |
|---|---|---|
| `artifact-exists` | `path` | run 目录内产物存在 |
| `artifact-nonempty` | `path, minBytes(默认1)` | 产物存在且字节数 ≥ minBytes |
| `json-field` | `path, pointer(RFC 6901), expect(必填)` | JSON 产物字段等于 expect |
| `world-hash-equals` | `—` | 当前场景规范化哈希等于本 run 首次构建哈希（幂等判据） |
| `event-emitted` | `kind, minCount(默认1)` | 事件流水含指定 kind 至少 minCount 条 |
| `image-size-equals` | `path, width, height` | 图像尺寸等于期望（读取 PNG 头，不解码全图） |
| `image-not-uniform` | `path, maxSameColorRatio(默认0.98)` | 主色占比 < maxSameColorRatio（排除整帧纯色的无效画面） |
| `te-state-equals` | `at[x,y,z], key(RFC 6901 指针，对描述器输出), expect(必填)` | 经与补全器同族的 TE 描述器读运行期状态字段并与 expect 比较；描述器输出同时进观测记录 `runtimeReads` 的 `te.*` 条目 |
| `image-uniform` | `path, minSameColorRatio(默认0.98)` | 主色占比 ≥ minSameColorRatio（TE 距离门远机位的近似纯背景） |

### 5.1 判据类型的引入版本与三方对账

判据类型的引入版本（`since`，口径同动作的 `since`）：

| 判据类型 | since |
|---|---|
| `artifact-exists` / `artifact-nonempty` / `json-field` / `world-hash-equals` / `event-emitted` | 1.0 |
| `image-size-equals` / `image-not-uniform` | 1.1 |
| `te-state-equals` / `image-uniform` | 1.2 |

对账的三方：

| 方 | 位置 | 角色 |
|---|---|---|
| ① 自描述端点 | `case.validate` 的 `criteriaTypes[{type, since, params}]`（数据源 `CriteriaEngine.typeCatalog()`） | 权威：调用方据它知道能写哪些判据、各自参数形态与引入版本 |
| ② 注册表 | `CriteriaEngine.TYPES`（`CaseParser.parseCriteria` 用它判未知判据类型） | 必须与 ① 同序、同集合、逐条 `type`/`since`/`params` 一致 |
| ③ §5 的判据表与本节上表的引入版本 | 人读形态 | 必须与 ① 逐行一致 |

①↔② 由 `CaseParserTest#criteriaTypeCatalogContentIsLocked` 锁定；①↔③ 与 ①↔快照由 `test/criteria/check-criteria-types.mjs --check test/criteria/criteria-types.json` 离线对账（快照在 `test/criteria/criteria-types.json`，刷新方式见该文件的 `_howToRefresh`）。

**引用读面产物**：读面动作是普通 `observe` 动作，不为它们新增判据类型；用 `json-field` 的 RFC 6901 指针引用读面产物。典型形态：

```jsonc
{ "id": "read-te-pipe-up", "type": "json-field",
  "params": { "path": "read/te.json", "pointer": "/tiles/0/claimedState/connections/UP" },
  "expect": true }
{ "id": "read-blocks-hash", "type": "json-field",
  "params": { "path": "read/blocks.json", "pointer": "/sha256" },
  "expect": "<64 位十六进制>" }
```

`read.diff` 的产物约定为 `read/diff.json`（role `read-diff`），登记进 `manifest.json`，可直接被 `evidence.expect` 引用。

**双轨判据**（对锚点用例强制）：同一可视特性必须成对断言——运行期轨（`te-state-equals`）证世界状态、图像轨（`image-not-uniform`/`image-uniform`/`image-size-equals`）证渲染结果；双轨不齐的锚点用例视为用例缺陷。配对口径按判据 id：运行期轨为 `te-<target>[-<面|机位>]`，图像轨为 `img-<target>[-<面|机位>]`，第二段逐字相同；反向不强制（允许只有图像轨的门控判据）。该口径由 `anchor-checks.ps1` 的 `Test-AnchorPairing` 静态判定。

**判据结论**：`{id, verdict: "green"|"red"|"error", detail}`。`error`（判据自身无法求值，如产物缺失到无法断言）视同 red 但单列。

## 6. variants 段（负对照）

每个变体 `{id, mutate, expectCriteriaRed:[...]}`：

1. `mutate` 是对本用例 JSON 的覆盖补丁（RFC 6902 子集：`replace`/`add`/`remove`，作用于顶层段与 `build` 步骤数组元素）。
2. 校验期即试算补丁：补丁失败按 `variants[i].mutate[j].path` 逐字段报错；补丁未改变用例内容 ⇒ 校验报错（防止出现永远通过的断言）；`expectCriteriaRed` 必须引用已存在的判据 id。
3. 补丁适用性判定只对原始用例成立：执行期对补丁产物文档的再校验跳过该类判定（`VariantCheck.SKIP` 只跳过适用性判定，其余字段校验照旧）。
4. 运行器对变体执行同一实现，断言 `expectCriteriaRed` 列出的判据必须失败；未失败则变体用例本身判为失败。

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

运行结束逐条核对，缺失即产生 id 为 `evidence-complete` 的结论并判为失败。`expect` 允许为空数组（校验期给 warning，此时不产生 `evidence-complete` 判据）；`evidence` 段本身必填。核对结论落 `evidence.json`（schema `lightning.cp-evidence/1`）。

## 8. 执行语义

1. **整跑**：`POST /cp/v1/actions/case.run {file|inline, confirm:true}` 按 §1 的九段执行序依次执行。没有 `shots` 段——截图属 `cameras` 段，`shots/` 只是机位产物的落点目录名。
2. **按段**：`segments:["world","build"]` 只跑指定段。段间状态是真实世界状态而非重放，因此按段连跑的结果必须与整跑一致。判据段在新 run 中求值时，若引用的产物在本 run 不存在，必须从当前世界状态重新产出（如重新扫描托管区域生成 `scene-manifest.json`）再求值。
3. **落盘次序**：每段产出 `segments/<name>.json`（状态、耗时、产物引用；skipped/deferred 段也先落记录）；`observation.json` 必须在判据段求值之前落盘；判据汇总落 `criteria.json`，证据核对结论落 `evidence.json`，合并结论在作业结果 `overall`（判据或证据任一失败、或判据无法求值，即为 `red`）。
4. **run 目录**：`<mcDataDir>/controlplane/runs/<yyyyMMdd-HHmmss>-<caseId>-<jobSeq>/`，全程只增不改；`manifest.json`（schema `lightning.cp-manifest/1`）登记全部产物的 sha256。`case.run` 把 runId 挂上作业（`GET /cp/v1/jobs/{jobId}` 的 `runId` 字段）。
5. **变体执行**：`variant:"<id>"` 只跑该变体；不带 `variant` 时整跑后顺带执行不改动 `world`/`build` 段的全部变体（改动这两段的变体标 `evaluated:false` 并给原因，须用 `variant` 单独跑）。结论写入 `variants:[{id, allExpectedRed, evaluated, criteria:[...]}]`。
6. **失败即停**：已完成的段保留产物，作业结果携带失败段与错误码。
7. **`world-hash-equals` 口径**：first = 本 run `build` 段产物（按段续跑时取存档内清单），current = 服务端世界按清单位置实读回读后的规范化哈希。场景清单哈希只覆盖 `{blocks:[{pos,blockId,meta}], tileEntities:[{pos,class}]}`（键排序无空白 sha256，`pos` 升序）；注册名与种子不入哈希。清单另含 `teReads:[{pos,completer,state,sha256}]`（`te` 步描述器输出的审计快照），不进清单哈希。
8. **坐标与标识校验**：`y` 域 0..255，`meta` 域 0..15，水平坐标绝对值上限 30000000；`CP-VALID-002` 的 `context.fields` 逐字段给原因。
9. **步骤间收敛**（`action` 段专有）：L1 的请求是包，服务端在它自己线程的 tick 里处理；`scene.*` 的同步出口也是同一方向。因此 `action` 段在每步之后做一次往返收敛（flush 入站包 + 等服务端 tick，`PlayerSession.completeClientRequest`，与 L1 动作回读前的收尾同一实现），`read.*` 与输入族步进步除外；等待时长写进该步段记录的 `settleMs`（失败记 -1）。

### 8.8 hermetic 纪律

以「同参同世界、结论可复算」为前提的固定程序（回归套件、锚点用例、逐帧导出复现、任何要跨轮比较哈希的验收），其第一次世界写动作必须是 `world.rebuild`（`void:true`）或 `case.run` 的 `world` 段，不得在既有世界上续跑。

| 执行层约束 | 判据 |
|---|---|
| `world` 段不得省略 | 验收类用例的 `world` 段必填且 `void:true`（§2） |
| 不得隐式复用上一轮世界 | 起手必须是 `world.rebuild` 或 `world` 段；「先探一下世界在不在、在就接着用」违反本节 |
| 轮内清场不等于起手重建 | `scene.entity.clear` 等只清实体，不清方块、背包、天气时间，不构成 hermetic 保证 |
| L1 玩家操作也是世界写动作 | `player.*` 受写入门控约束，且不得被当作起手重建的替代品；L1 的产物也不构成 hermetic 保证 |
| 只跑判据段的续跑 | 只有在同一轮内才合法；跨轮续跑违反本节 |

`case.run` 的 `world` 段与 `world.rebuild` 是同一实现（`WorldRebuildRunner`），语义不冲突。玩家侧状态（背包、经验、药水、飞行）落 `<saves>/<folder>/playerdata/`，在存档目录内，随 `world.rebuild` 的整目录删除一并复位。客户端侧易失渲染状态由捕获会话纪律承担（`contract.md` §7.3）。

**留痕**：`world.rebuild` 的删除阶段落 `world-rebuild` 事件（含 folder/seed），标记前置与标记完成各落一条 `world-rebuild` 事件，与 `sceneManifestSha256` 共同构成「本轮从新世界开始」的可审计链。

## 9. 文件解析与校验

1. 只接受 UTF-8 JSON；未知顶层字段报错，段内未知字段报错。
2. `case.validate` 返回规范化计划：解析后的段列表、每条判据的展开形态、期望证据清单、全部警告。
3. 坐标、id、阈值全部做范围校验；`CP-VALID-002` 的 `context.fields` 逐字段给原因。

## 10. 产物比较模式

「同一固定程序执行两次、产物结构一致」中的「结构」由本节定义：四种比较模式 + 一张豁免表。这是 `test/expected/` 基准的比对口径来源。

### 10.1 四种比较模式（逐产物声明，四选一）

| 模式 | 语义 | 典型产物 | 判定方式 |
|---|---|---|---|
| `byte-equal` | 逐字节相同 | `world/scene-manifest.json` 的 `blocks`/`tileEntities` 段、导出件正文 | 两侧字节序列相等（sha256 相等是充分条件） |
| `canonical-hash-equal` | 规范化 JSON（键排序、无空白）的 sha256 相同 | `criteria.json` 的判据结论集、`scene-manifest.json` 的 `sha256` 字段 | 两侧 `Json.canonical` 后取 sha256 相等 |
| `structural-equal` | 结构相同：键集合 + 类型 + 数组长度 + 值按 §10.2 归一后相等 | `observation.json`、`segments/*.json`、`evidence.json` | 递归比较键集合、类型、数组长度与归一后的值 |
| `presence-only` | 只要求存在且非空 | `shots/*.png`、`shots/*.tiles/r*c*.png`、`logs/*` | 文件存在且字节数 > 0 |

### 10.2 豁免字段表（逐条给出处，豁免可被审）

| 字段 | 出处 | 依据 | 适用模式 |
|---|---|---|---|
| `runId` | 全部 run 产物 | 形态含时间戳与作业序号（§8 第 4 条），每次不同 | 全部 |
| `createdAt` / `generatedAt` / `recordedAt` / `readAt` / `regeneratedAt` | `manifest.json` / `criteria.json` / `evidence.json` / `segments/*.json` / `read/*.json` | 挂钟时间 | 全部 |
| `durationMs` | `segments/*.json` | 耗时 | 全部 |
| `runDir` / `runsRoot` / 绝对路径 | `read/run.json`、`segments/*.json` | 含 `<mcDataDir>` 绝对前缀，跨机器不同 | 全部 |
| `playerPos` / `worldTime` / `sinceEnterMs` / `totalTime` | `world.json`、`observation.json` | 实时状态（进图时间、玩家微调位置、世界时钟） | 全部 |
| `observation.artifacts[].sha256` / `.bytes` | `observation.json` | 随产物变化；产物本身豁免时其哈希一并豁免 | 全部 |
| `world/scene-manifest.json` 的 `mismatches[]` | 清单留痕 | 记录请求值与世界实际值的差异，是留痕不是期望值 | 全部 |
| `teReads[]` | `scene-manifest.json` | 契约明写不进清单哈希（§8 第 7 条），只是审计快照 | 全部 |
| 图像像素内容 | `shots/*.png` | 渲染状态会话易失；图像只做存在、尺寸与主色占比阈值判定 | `presence-only` |
| `jobSeq` | `manifest.json` | 进程内单调递增的作业序号，跨轮必然不同 | 全部 |

新增豁免必须在本表留下依据与出处；依据只能是契约条款或可复核的成因说明。

### 10.3 比较对象

| 产物 | 模式 | 说明 |
|---|---|---|
| `world/scene-manifest.json` | `canonical-hash-equal`（整份）+ `byte-equal`（`blocks`/`tileEntities` 两段） | 哈希回答世界是否同一场景；两段字节相等回答清单文本是否逐字一致 |
| `criteria.json` | `canonical-hash-equal`（`criteria[]` 的 `{id,type,verdict}` 投影） | 判据结论逐条一致；`detail` 里的人读文字不参与 |
| `evidence.json` | `canonical-hash-equal`（`{overall, verdict}` 投影） | 结论一致 |
| `observation.json` | `structural-equal` | 结构一致（版本、客户端配置、产物引用齐备），值按 §10.2 归一 |
| `segments/*.json` | `structural-equal` | 逐段结构一致（`segment`/`status`/`detail` 的键集合与类型） |
| `shots/*.png` | `presence-only` | 存在且非空；尺寸与主色占比由判据承担，不由比对器承担 |
| `read/*.json`、`action/*.json` | `canonical-hash-equal`（豁免归一后） | 读数与编排产物必须逐字一致（它们是判据的输入） |
| `read/run.json` | `presence-only` | `read.run` 枚举整个 runs 目录，必然包含本 run，条目数与字节数随 run 数单调增长（§10.5） |

### 10.4 执行方式

比对器 `test/expected/compare-runs.mjs`：输入两个 run 目录（或一个 run 加一份基准清单），逐产物按 §10.3 声明的模式比较，输出机读 JSON 与人读表。退出码 `0` = 全一致，`2` = 有差异，`3` = 设施错误。

```bash
# 两次 run 互比
node test/expected/compare-runs.mjs --a <runDirA> --b <runDirB> --json-out compare.json

# 与基准清单比
node test/expected/compare-runs.mjs --run <runDir> --baseline test/expected/<caseId>/manifest.json
```

比对器必须对篡改报错。可用它自带的合成夹具自检：

```bash
node test/expected/compare-runs.mjs --selftest
```

该命令用合成夹具逐条验证「好数据一致、改坏必报差异并指名产物」，逐条打印结论；全部符合退出 `0`，任一不符退出 `2`。

### 10.5 `read/run.json` 的比较模式

`read.run` 枚举整个 `runs/` 目录，必然包含本 run，条目数与总字节数随 run 数单调增长；同一固定程序跑两次该产物必然不同，且这不属于漂移。它的比较模式固定为 `presence-only`（存在且非空）。它的语义是「此刻有哪些 run」，属于设施状态，不属于被复现的世界状态。

### 10.6 豁免的三条纪律

1. **按路径豁免，不按字段名豁免**。`artifacts[].sha256` 需豁免（随产物变化），但 `world/scene-manifest.json` 的 `sha256` 恰是要比的核心值；正确形态是 `**/artifacts/*/sha256` 这样的路径豁免。同类例子：`chunks.loaded`（实时计数，豁免）与 `world.loaded`（布尔状态，不豁免）。
2. **豁免必须有依据**：`mismatches` 与 `teReads` 经逐字复现验证后可参与比较，因此不豁免，并加断言锁住它们参与比较；`read/overview.json` 的世界时钟、天气倒计时、已加载区块计数只有在比对报告里被证明逐轮不同时才获得豁免资格。
3. **人读文字只豁免内容，不豁免结构**：`summary`/`detail`/`note`/`message`/`reason` 按设计会引用 runId、字节数或绝对路径，其作用是解释而非断言；`detail` 从字符串变成对象、或整个键消失，都必须报错。
