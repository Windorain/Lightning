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
  "capture":  { ... },                   // 可空（PR-2 起）：扫描与捕获参数
  "cameras":  [ ... ],                   // 可空（PR-2 起）：机位表
  "criteria": [ ... ],                   // 必填，至少一条：判据与阈值
  "variants": [ ... ],                   // 可空：负对照变体
  "evidence": { ... }                    // 必填：期望证据清单
}
```

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
| `te` | `at:[x,y,z], completer:"vanilla"\|"lp-pipe"\|"ae2-part", params:{...}` | TE 状态补全（权威同步路径，contract.md §6.4）；`completer` 必须在注册表中 |
| `wait` | `ticks:N` | 等待 N tick（同步/渲染稳定） |

坐标三种写法，一律规范化为绝对坐标：绝对数组 `[x,y,z]`；`"@base"` + 同层 `offset:[dx,dy,dz]`；字符串 `"base+[dx,dy,dz]"`。`world.base` 只接受绝对数组。构建完成后运行器自动做：TE 补全（`te` 步声明的）→ `markBlockRangeForRenderUpdate` → 静置 `settleTicks`。

## 4. capture / cameras 段

PR-2 定义（相机注入、正交投影、分块超分辨率、多机位生成）。PR-1 解析器必须**接受并透传**这两段（`case.validate` 报"该段由契约 v1.x 提供"而非报错），保证用例文件前向兼容。

## 5. criteria 段（判据与阈值）

每条判据：`{id, type, params, expect}`。`expect` 仅 `json-field` 强制要求并参与比较，其余类型按自身语义自证。`type` 注册表（v1）：

| type | params | 语义 |
|---|---|---|
| `artifact-exists` | `path` | run 目录内产物存在 |
| `artifact-nonempty` | `path, minBytes(默认1)` | 产物存在且字节数 ≥ minBytes（**非空断言**，V2） |
| `json-field` | `path, pointer:"/a/b/0", expect` | JSON 产物字段等于 expect（RFC 6901 指针） |
| `world-hash-equals` | — | 重建后场景哈希等于本 run 首次构建哈希（幂等判据） |
| `event-emitted` | `kind, minCount` | 事件流水含指定 kind 至少 minCount 条 |

判据结论：`{id, verdict: "green"|"red"|"error", detail}`。`error`（判据自身无法求值，如产物缺失到连断言都不能做）视同 red 但单列。

## 6. variants 段（负对照，C6/V3 落地）

每个变体：`{id, mutate, expectCriteriaRed: [...]}`。
- `mutate` 是对本用例 JSON 的覆盖补丁（RFC 6902 子集：replace/add/remove on 顶层段与 build 步骤数组元素）；
- 校验期即试算补丁：补丁失败按 `variants[i].mutate[j].path` 逐字段报错；**补丁未改变用例内容 → 校验报错**（防恒绿假断言）；`expectCriteriaRed` 必须引用已存在的判据 id；
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

1. **整跑**：`POST /cp/v1/actions/case.run {file|inline, confirm:true}` → 依序执行 world→build→(capture)→(shots)→criteria→evidence。
2. **按段**：`segments:["world","build"]` 只跑指定段；段间状态是真实世界状态（不是重放），因此**按段连跑的结果必须与整跑一致**（验收锚）。判据段在新 run 中求值时，若引用的产物在本 run 不存在，必须**从当前世界状态重新产出**（如重新扫描托管区域生成 scene-manifest.json）再求值。
3. 每段产出 `segments/<name>.json`（状态、耗时、产物引用；skipped/deferred 段也先落记录）；**`observation.json` 必须在判据段求值之前落盘**（判据可引用它）；判据汇总 `criteria.json`（纯判据语义），证据核对结论落 `evidence.json`（schema `lightning.cp-evidence/1`），合并结论在 `result.overall`（判据与证据任一红/错即 red）。
4. run 目录：`<mcDataDir>/controlplane/runs/<yyyyMMdd-HHmmss>-<caseId>-<jobSeq>/`（jobSeq 为数字作业序号，jobId 形态 `j<seq>`），全程只增不改；`manifest.json`（schema `lightning.cp-manifest/1`）登记全部产物的 sha256。tokens/server 内部文件 schema 分别为 `lightning.cp-tokens/1`、`lightning.cp-server/1`。`case.run` 必须把 runId 挂上作业（`GET /cp/v1/jobs/{id}` 可见）。
5. **变体执行**：`variant:"<id>"` 只跑该变体；不带 variant 时整跑后顺带执行**不改动 world/build 段**的全部变体（改动 world/build 的变体标 `evaluated:false` + 原因，须用 `variant` 单独跑——避免整跑里叠加多次世界重建）。结论写入结果（`variants:[{id, allExpectedRed, evaluated, criteria:[...]}]`）。变体应用补丁后跑同一实现；`expectCriteriaRed` 列出的判据**必须变红**——不变红则作业判 failed（防恒绿假断言）。
6. 失败即停（ fail-fast ），已完成的段保留产物；`job` 结果携带失败段与错误码。
7. `world.rebuild` 结果含 `sceneManifestSha256`；`world-hash-equals` 判据的哈希口径：first=本 run build 段产物（按段续跑时取存档内清单），current=服务端世界按清单位置**实读回读**后的规范化哈希——世界未漂移时两者相等，漂移时如实判红。场景清单哈希只覆盖 `{blocks:[{pos,blockId,meta}], tileEntities:[{pos,class}]}`（键排序无空白 sha256，pos 升序）；注册名/种子不入哈希——哈希回答「世界是不是同一场景」。

## 9. 文件解析与校验规则

- 只接受 UTF-8 JSON；未知顶层字段报错（防笔误静默）；段内未知字段报错。
- `case.validate` 返回规范化计划：解析后的段列表、每条判据的展开形态、期望证据清单、全部警告。
- 坐标、id、阈值全部做范围校验；`CP-VALID-002` 的 `context.fields` 逐字段给原因。
