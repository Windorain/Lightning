# scripts/control-plane —— 控制面脚本（PR-1 + PR-2 + PR-3）

> 契约权威文档： [`docs/control-plane/contract.md`](../../docs/control-plane/contract.md)（端点/错误码/权限/端口）、
> [`docs/control-plane/case-file.md`](../../docs/control-plane/case-file.md)（用例格式/判据注册表/变体/证据）、
> [`docs/control-plane/observation-record.md`](../../docs/control-plane/observation-record.md)（观测记录）。
> 本文只写**规则与用法**；脚本引用的每个端点与字段都必须能在这三篇里找到出处（见 §6 对照表）。
> 本文不记过程、不记某次运行的结果。

## 1. 组成

| 文件 | 角色 |
|---|---|
| `caller.mjs` | **无先验知识调用方**（验收锚）：只凭 `GET /cp/v1/actions` 的自描述构造调用 |
| `cases/smoke-basic.json` | PR-1 冒烟用例（`lightning.case/1`）：虚空世界 + 3 石 + 1 箱（TE 补全）+ 负对照变体 |
| `run-smoke.ps1` | 无人值守冒烟驱动：写配置 → 起客户端 → 依次断言 A1..A9 → 收尾归档 |
| `cases/smoke-shots.json` | **PR-2** 取证拍摄用例：同一场景 + `capture` 段 + 3 机位（透视/正交/超分拼接）+ 图像判据 + 负对照变体（见 §9.2） |
| `run-shots.ps1` | **PR-2** 取证拍摄验收驱动：写配置 → 起客户端 → 依次断言 B1..B7 → 收尾归档（截图原图另平铺一份，见 §9.4） |
| `cases/lp-pipe-row.json` | **PR-3** LP 锚点用例：四管横排（裸管/两管互联/管+箱）+ 双轨判据（`te-state-equals` + 图像）+ 负对照（见 §10.2） |
| `cases/ae2-parts.json` | **PR-3** AE2 锚点用例：缆块 + 部件（中心缆/切换总线/存储总线）+ 双轨判据 + K1 三十格距离门远机位对照（见 §10.3） |
| `anchor-checks.ps1` | **PR-3** 纯检查模块：红绿判定本体（无 HTTP / 无世界 / 无归档），被驱动与自检共用（见 §10.1） |
| `run-anchor.ps1` | **PR-3** 锚点验收驱动：写配置 → 起客户端 → 依次断言 C1..C7 → 收尾归档（见 §10.1） |
| `run-anchor-selftest.ps1` | **PR-3** 离线行为自检：合成夹具跑 `anchor-checks.ps1` 的每条判定，验证好数据绿、坏数据精确红（见 §10.7） |
| `cases/read-surface.json` | **v1.3（#98）** 读面锚点用例：`read` 段跑读面动作，`criteria` 用 `json-field` 直接引用其产物 + 4 个负对照变体（见 §11.2） |
| `run-read-surface.ps1` | **v1.3（#98）** 读面验收驱动：B1（只读性）/ D1（自述完备）/ D3（默认值可见）/ D4（失败显式）/ R（哈希可复算与可互算）/ B2（读面进判据）（见 §11） |
| `cases/tank-fill-live.json` | **v1.7（#122）** 流体注入用例：`te` 步放 LV 化学反应釜 + 4 条 `tanks` 判据 + `world-hash-equals`；负对照变体 `neg-setblock-shell`（`te` 换 `block` 直铺空壳，储罐判据必红） |
| `run-tank-fill.ps1` | **v1.7（#122）** 流体注入验收驱动：D1（自述完备）/ D3（默认与边界值可见）/ D4（失败显式，含提交期拒绝与执行期失败两种形状）/ A（正向注入 + `read.te` 读回一致）/ N（世界内负对照）。`-InWorld` 才跑 A/N（见 §12） |
| `export-minimal-experiment.mjs` | **v1.7（#102）** 最小实验：证伪「扫描 + 烘焙可在同一 cp 动作内完成」这条**推断**（见 §13.1） |
| `export-acceptance.mjs` | **v1.7（#102）** 导出族验收驱动：C1..C6 + D2/D3/D5 一次跑全，产出机器可读报告（见 §13.2） |
| `export-check.mjs` | **v1.7（#102）** 单份场景文件检查器：把产物喂给 **web 侧真实解析器**（C1 的机械判据），并核对帧集/exportId/逐帧哈希（见 §13.3） |
| `export-d2-compare.mjs` | **v1.7（#102）** D2 双通道对照：语义子树规范化哈希比对（**不做字节比对**，口径见 `dual-channel-consistency.md` §2.2） |
| `export-d2-twins.mjs` | **v1.7（#102）** D2 覆盖另外两条孪生链路：`export.registry` ↔ `/sde dump`、`export.multiblock` ↔ `/sde multiblock`（见 §13.4） |
| `frame-recipe-probe.mjs` | **v1.7（#102）** 诊断：找出「逐帧世界状态不同」的可用配方（触达距离 + 选区归服务端玩家，见 §12.5） |
| `inspect-artifact.mjs` | **v1.7（#102）** 诊断：打印产物形态（顶层/inner 键、帧结构、调色板层级、provenance 配对） |
| `evidence-catalog.mjs` | **v1.7（#102）** 证据快照：把 `GET /cp/v1/actions` 的全量自述落成 JSON（D1/D3 的静态可复核证据） |
| `cases/export-c4.json` | **v1.7（#102）** C4 同 run 纪律用例：`export` 段把导出件与实拍/观测/世界清单放进**同一个 run** |
| `caller-defaults.test.mjs` | **v1.7（#126）** 调用器缺省口径回归（`node:test`，离线零依赖）：缺省不物化、显式 `false`/`0`/`null`/`""` 原样保留 |
| `bake-truth-acceptance.mjs` | **v1.7（#127 + #131）** 实机验收驱动：烘焙忠实性（同世界正对照 / 跨世界负对照 / 同 folder 改内容 / 同坐标换块）+ `TYPE_INT` 实机回归；先证明 `pauseOnLostFocus:false` 再谈其他。**实机 31/31 全绿（2026-10-07，`runClient25` + 控制面 23311）** |

脚本只做**编排与调用**：控制面本体在 `mod/gtnh/src/main/java/com/lightning/mod/client/controlplane/`。
脚本不直接 POST 裸请求——一切动作调用都经 `caller.mjs`（自描述驱动），便于审计「调用方是否真的读了自描述」。

## 2. 前置（硬约束，缺一不可）

1. **`web/node_modules` 必须存在**（`cd web; npm ci`）。`runClient` 依赖 `syncWeb→vite`，缺了它客户端起不来；
   `run-smoke.ps1` 把它作为前置检查，缺失即明确报错退出（不猜测、不自动安装）。
2. **端口**：控制面默认 **23057**；**本树（`feat/cp-silent-truth`）在 `.workspace/ports.json` 登记的首选端口是 `23311`**，
   由 `<mcDataDir>/config/lightning.cfg` 的 `controlplane.port` 指定（本树实测绑定 23311）。
   实现按 `preferred+1…` 回退（契约 §1.3），因此**脚本一律以 `<mcDataDir>/controlplane/server.json` 的 `port` 为准**，
   不假设一定是 23057；`-Port` 只用于前置占用检查。
3. **`runClient` 是独占资源**（Gradle 锁 + 端口 + 世界存档）：**用前向 Lead 申请**，一次只跑一个。
   `-SkipClientStart` 只用于「复用别人已启动、已获批的客户端」，不解除独占纪律。
4. **环境**：Node 18+（本仓 22，`caller.mjs` 只用内置 `fetch`）、PowerShell 7。
5. **启用通道**：`<mcDataDir>/config/lightning.cfg` 的 `[controlplane] enabled=true`（契约 §1.1）。
   脚本写前备份原值、收尾原样还原（新建的文件移入归档，不删除）。
   后备通道 `-EnableViaJvmProperty`（注入 `JAVA_TOOL_OPTIONS=-Dsde.controlPlane=on`）**只用于排障**：
   它绕过 `lightning.cfg` 通道，不能作为验收依据。

## 3. 用法

### 3.1 `caller.mjs`

```
node caller.mjs <actionName> [paramsJson] [options]
```

| 选项 | 语义 |
|---|---|
| `paramsJson` | JSON 对象字面量；以 `@` 开头表示从该文件读 JSON |
| `--tier observe\|scene\|forensic` | 强制权限级；默认取**动作自描述声明的** `tier` |
| `--sync` | `?sync=true&timeoutMs=N` 同步提交（超时返回 202 + jobId，动作不取消） |
| `--timeoutMs N` | 总超时毫秒（默认 60000）：从 POST 起算，覆盖「同步等待 + 异步轮询」 |
| `--poll-intervalMs N` | 异步轮询间隔（默认 500） |
| `--mc-dir <path>` | mcDataDir（默认 `mod/gtnh/run/client`） |
| `--no-confirm` | 不自动补 `confirm:true`（负测试专用，预期 `CP-CONFIRM-001`） |
| `--allow-unknown-params` | 放行自描述未声明的参数（默认报错，用于暴露契约漂移） |
| `--json-out <path>` | 机读出口：作业 JSON / 错误信封写一份到该路径 |
| `--describe` | 只打印该动作的自描述 JSON（纯 JSON 到 stdout） |
| `--actions` | 只打印整份动作目录 JSON（纯 JSON 到 stdout） |

**发现顺序**（不猜、不扫描端口）：`<mcDataDir>/controlplane/server.json` → `port`（+`bind`/`contractVersion`/`pid`）；
`<mcDataDir>/controlplane/tokens.json` → `tokens.{observe,scene,forensic}`。

**构造调用的规则**（`caller.mjs` 的注释里也写着，是「无先验知识」的验收内容）：

1. 动作必须存在于自描述里，否则本地报错退出（不发出请求）；
2. 必填参数缺失 → 本地报错并列出该动作的完整参数表；
3. **未提供的选填参数不写进请求体**（交给服务端缺省逻辑；Gitea #126 之前会按自描述 `default` 代填，
   那会让「调用方没给」与「调用方给的就是默认值」不可分，把「缺省取决于调用形态」的参数架空）；
4. 调用方显式给的值原样保留（`false` / `0` / `null` / `""` 都不做 falsy 判断）；
5. 参数名不在自描述里 → 本地报错（`--allow-unknown-params` 可直传）；
6. `confirm` 由**权限级**派生（`confirmRequired` / `tier` ∈ {scene, forensic}），不是动作私有知识；
7. 动作的知识（名称/参数/类型/必填/默认/权限级/是否需确认）**全部**来自 `GET /cp/v1/actions`；
   脚本里唯一的非自描述常量是契约级控制字段（`confirm`/`sync`/`timeoutMs`）与信封形态 `{ok,data|error}`。

> 缺省口径的回归：`node scripts/control-plane/caller-defaults.test.mjs`（三态可区分：缺省 / 显式值 / 显式 `false`）。

**退出码**：`0` = 作业 `done`；`1` = 调用错误（HTTP 4xx/5xx、本地用法错误、动作不存在）；
`2` = 作业 `failed`；`3` = 超时（作业仍在跑，未取消）。

**`--json-out` 的内容**：作业 JSON（`done`/`failed`）；调用错误时是 `{ok:false,httpStatus,error:{code,message,context},…}`；
超时是最后一份作业 JSON + `callerTimeout:true`。脚本消费这个文件，不解析 stdout。

```powershell
node scripts/control-plane/caller.mjs core.ping
node scripts/control-plane/caller.mjs case.run '{"file":"D:/.../smoke-basic.json","segments":["world","build"]}' --sync --timeoutMs 600000
node scripts/control-plane/caller.mjs world.rebuild '{}' --no-confirm     # 预期 CP-CONFIRM-001，退出码 1
node scripts/control-plane/caller.mjs case.run --describe                # 看自描述（机读）
```

### 3.2 `cases/smoke-basic.json`

- `world`：`folder=cp_smoke_basic`、固定种子、`void=true`、`base=[64,12,64]`、`settleTicks=60`；
- `build`：清场一块区域 → 3×`minecraft:stone` → 1×`minecraft:chest` → `te` 步 `completer:"vanilla"` → `wait`；
  三种坐标写法都用到了（绝对数组 / `"base+[dx,dy,dz]"` / `"@base"`+`offset`）；
- `criteria`：4 条，覆盖 4 种判据类型——
  `artifact-exists(world/scene-manifest.json)`、`artifact-nonempty(observation.json)`、
  `event-emitted(kind="case-segment", minCount=1)`、`json-field(observation.json #/schema == lightning.observation/1)`；
- `variants`：1 个负对照 `neg-manifest-missing`——把 `criteria[0].params.path` 改成不存在的产物，
  `expectCriteriaRed=["scene-manifest-exists"]`（**变体判据变红才叫通过**，见 case-file.md §6）；
- `evidence.expect`：`observation.json`、`criteria.json`、`world/scene-manifest.json`（缺失即 `evidence-complete` 红）。

用例文件**离线校验**（不启动客户端，用仓内真实解析器）：

```powershell
# 见 §7 自检记录：CaseValidator.validate(text) 必须返回 VALID 且 warnings 为空
```

### 3.3 `run-smoke.ps1`

```powershell
pwsh -File scripts/control-plane/run-smoke.ps1                                  # 全流程（申请到 runClient 后跑）
pwsh -File scripts/control-plane/run-smoke.ps1 -SkipClientStart                 # 复用已在跑的客户端（不写配置、不停客户端）
pwsh -File scripts/control-plane/run-smoke.ps1 -KeepClient                      # 跑完保留客户端现场
pwsh -File scripts/control-plane/run-smoke.ps1 -CaseFile <path>                 # 换用例文件
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `-CaseFile` | `cases/smoke-basic.json` | 用例文件 |
| `-McDataDir` | `mod/gtnh/run/client` | 覆盖 mcDataDir（离线自检用） |
| `-SkipClientStart` | 关 | 复用已在跑的客户端；要求端口在听且 `server.json`/`tokens.json` 就绪 |
| `-KeepClient` | 关 | 不停止本脚本启动的客户端 |
| `-EnableViaJvmProperty` | 关 | 后备启用通道（排障） |
| `-Port` | `23057` | 仅前置占用检查用 |
| `-ClientReadyTimeoutMin` | `5` | 等待 `server.json` 的上限 |
| `-CaseTimeoutMs` | `600000` | 单次 `case.run` 总超时 |
| `-ArchiveRoot` | `D:\Workspace\Lightning\temp\control-plane` | 归档根 |
| `-FileParamName`/`-SegmentsParamName`/`-VariantParamName` | 空 | 参数名覆盖（默认从 `case.run` 自描述探测；探测失败才需要显式给） |

**流程**：前置检查 → 写 `lightning.cfg`（备份原值）→ 陈旧 `server.json`/`tokens.json` 移入归档 →
`Start-Process gradlew runClientSdePipeline --console=plain`（日志重定向）→ 等 `server.json`（超时则打印日志尾 40 行并退出 3）
→ 断言 → 收尾（停客户端 → 还原 cfg → 归档 → 红绿表）。

**断言清单**：

| id | 断言 | 红意味着 |
|---|---|---|
| A1 | `core.ping` 退出码 0 | 控制面没起来/鉴权不通 |
| A2 | `core.status` 退出码 0 | 状态端不可用 |
| A3/A3b | `case.validate` 退出码 0 且计划的判据/变体数与用例一致 | 解析器或计划输出与用例不符 |
| A4/A4b/A4c | `case.run` 整跑退出码 0；run 的 `criteria.json` 全绿且覆盖用例全部判据；`evidence-complete` 绿 | 用例判据未满足 / 证据缺失 |
| A5/A6 | `case.run` 按段（`world,build` 与 `criteria,evidence`）各退出码 0 | 按段路径不可用（验收锚） |
| A7a | 整跑的段集合 == 两次按段的并集 | 按段与整跑产物形态不一致（验收锚） |
| A7b | 判据 id→verdict 与整跑逐条一致 | 按段连跑与整跑结论不同 |
| A7c | 整跑产物（除 `manifest.json`/`observation.json` 记账类）都在按段并集里 | 产物形态不一致 |
| A8 | 变体跑退出码 0 且 `expectCriteriaRed` 列出的判据**全红** | 负对照恒绿（假绿）或变体执行失败 |
| A9 | 无 `confirm` 调 `world.rebuild`：退出码非 0 且 `error.code == CP-CONFIRM-001` | 可写动作确认边界被绕过（严重） |

**退出码**：`0` 全绿；`2` 有断言红；`3` 管线级致命（`server.json` 超时 / 客户端早退）；`4` 前置检查或编排自身失败。

**参数名自适应**：`file` / `segments` / 变体选择参数名**不硬编码**——脚本先 `caller.mjs case.run --describe`
读自描述再选名（候选：`file|case|caseFile|path|casePath`、`segments|segment`、`variant|variants|variantId|variantIds`），
并把这些探测结果也记成断言（`param:file` / `param:segments` / `param:variant`）。
自描述里没有 `segments` → 断言红（契约 §4 要求 `segments:[...]`）；
自描述里没有变体选择参数 → 不判红：按 case-file.md §6「运行器对变体执行同一实现」在整跑结果里核对变体结论。

## 4. 产物与归档

- **run 目录**（契约 case-file §8.4）：`<mcDataDir>/controlplane/runs/<yyyyMMdd-HHmmss>-<caseId>-<jobSeq>/`，
  内含 `manifest.json`、`observation.json`、`criteria.json`、`segments/<name>.json`、`world/scene-manifest.json` 等；
  全程只增不改。
- **归档**：`<ArchiveRoot>\smoke-<ts>\`（默认 `D:\Workspace\Lightning\temp\control-plane\smoke-<ts>\`）：

  | 内容 | 说明 |
  |---|---|
  | `runs/<runId>/` | 本次会话产生的每个 run 目录（定位失败时退化为 `runs-all/` 整目录复制） |
  | `events.jsonl` | 事件流水副本（契约 §8；`kind` 含 `case-segment`/`criteria-verdict`） |
  | `logs/gradle-runClient.log`、`.err` | 客户端进程 stdout/stderr |
  | `logs/fml-client-latest.log` | 客户端日志（`/cp/v1/logs/tail` 的数据源） |
  | `logs/caller-*.json` | 每次调用的作业 JSON / 错误信封（`--json-out`） |
  | `lightning.cfg.before` / `.after` / `.created-by-smoke` | 配置原值 / 收尾值 / 新建件（新建件移入归档而非删除） |
  | `stale/` | 启动前移开的陈旧 `server.json`/`tokens.json` |
  | `assertions.json`、`summary.md` | 断言红绿表（机读 + 人读） |

- **`temp/` 随时会被删除**：归档放这里只是便于当场排查。**要留的证据（红绿表、run 目录、events.jsonl）必须上 Gitea**
  （Issues/`#57` 的评论附件），不要指望 `temp/` 里有第二份。runClient 产生的托管存档
  (`<mcDataDir>/saves/cp_smoke_basic`) 不自动清理，需要时自行处置。

## 5. 常见失败与处置

| 现象 | 含义 | 处置 |
|---|---|---|
| 等 `server.json` 超时（退出 3） | 控制面没启用或没起来 | 看日志尾；确认 `lightning.cfg` 的 `[controlplane] enabled=true` 被实现读取（否则用 `-EnableViaJvmProperty` 定位是通道问题还是实现问题） |
| 端口 23057 被占用（退出 4） | 已有客户端在跑 | 独占纪律：排队；或确认那是不是本次获批的客户端（是则用 `-SkipClientStart`） |
| A7a/A7c 红 | 整跑与按段产物形态不一致 | 这正是契约 §4/§8.2 的验收锚，属实现缺陷；把两个 run 目录一并附上 |
| A8 未变红 | 负对照恒绿（假断言） | 检查变体补丁是否真的改变了用例（`case.validate` 的 `appliedSha256`/`applicable`） |
| A9 红 | 可写动作缺 `confirm` 仍被放行 | 契约 §1.6 的边界被绕过，最高优先级 |
| `caller.mjs` 报「参数未在自描述中声明」 | 自描述与调用方的参数名漂移 | 用 `--describe`/`--actions` 对齐，或临时 `--allow-unknown-params` 直传后修实现 |
| 定位不到 run 目录 | 作业 JSON 未带 `runId`/`runDir` | 脚本退化为「本次新增的 run 目录」，并在归档里整目录复制 `runs/` |

## 6. 脚本依赖的契约事实（对照表）

| 脚本依赖 | 出处 |
|---|---|
| `GET /cp/v1/about`、`/actions`、`/jobs/{id}`、`/events`、`/logs/tail`、`/artifacts/...` | contract.md §2 |
| `POST /cp/v1/actions/{name}`、`?sync=true&timeoutMs=N`、202+jobId | contract.md §2 |
| 信封 `{ok,data}` / `{ok:false,error:{code,message,context}}` | contract.md §2 |
| `CP-AUTH-001/002`、`CP-VALID-001/002`、`CP-CONFIRM-001`、`CP-BUSY-001`、`CP-STATE-001`、`CP-EXEC-001/002`、`CP-IO-001` | contract.md §3 |
| 权限级 `observe|scene|forensic`、可写级需 `confirm:true` | contract.md §1.5/§1.6 |
| `server.json`（`port`/`bind`/`boundAt`/`contractVersion`）、`tokens.json`（`tokens.{observe,scene,forensic}`） | contract.md §1.3/§1.4 |
| 作业状态 `queued|running|done|failed`、`jobId` 形态 `j<seq>` | contract.md §2 |
| 判据类型 `artifact-exists|artifact-nonempty|json-field|world-hash-equals|event-emitted` 及参数名 | case-file.md §5 |
| 变体 `mutate`(RFC 6902 子集) / `expectCriteriaRed`「必须变红」 | case-file.md §6 |
| `evidence.expect[{path,role}]` → `evidence-complete` | case-file.md §7 |
| run 目录命名、`manifest.json`、`criteria.json`、`segments/<name>.json` | case-file.md §8.3/§8.4 |
| `observation.json` schema `lightning.observation/1`（`/schema` 指针） | observation-record.md §1 |

## 7. 自检记录（离线，不含客户端实测）

| 自检 | 结果 |
|---|---|
| `node --check caller.mjs` | 通过 |
| `pwsh` 解析检查（`[Parser]::ParseFile`） | 通过 |
| `caller.mjs` × 契约替身（自描述驱动、默认值补齐、自动 confirm、异步轮询、同步超时转轮询、错误信封、退出码 0/1/2/3） | 全部符合约定 |
| `caller-defaults.test.mjs`（#126） | `node:test` 9/9 通过（缺省不写入请求体、显式 false/0/null/"" 原样保留、JSON 往返不变、缺必填/未声明参数仍报错） |
| `bake-truth-acceptance.mjs` | `node --check` 通过；**实机 31/31 全绿，驱动 exit 0**（GTNH 客户端 `runClient25` + 控制面 23311，contractVersion=1.7，count=43）。前置不满足（`pauseOnLostFocus:false` 缺失，或 `server.json`/`tokens.json` 缺失）时 **exit 2** 且不进入任何步骤（离线可验） |

> **该驱动 (b)/(d) 两条负对照的失败点不同，判据口径也不同（首跑实测纠正）**：
> (b) 跨世界失败在 `stage: pre-bake`（`ctx.beginRun` **之前**，见 `ExportSceneAction.java:239` vs `:242`）
> ⇒ 连 run 目录都不开 ⇒ 判据是「**run 数不增**」（B7）。
> (d) 同坐标改块失败在 `stage: bake`（逐格烘焙时才暴露身份冲突）⇒ run **已经开了**（成功路径需要一个落盘点）
> ⇒ 判据是「**登记产物数 = 0 且 run 目录 `export/` 下零文件**」（D4），**不是**「run 数不增」。
> 首跑实测：D4 按「run 数不增」写会**假红**——该 run 里 `artifacts.count=0`、目录内仅 202 字节 `manifest.json`
> （记账件）、`export/` 空 ⇒ **实现是对的，是判据套错了失败点**。现口径比旧口径更严：
> 同时查登记表与落盘文件，防「写了文件但没登记」。
| `cases/smoke-basic.json` × 仓内真实 `CaseValidator.validate` | `VALID`，`warnings=[]`，判据/变体/坐标规范化符合预期 |
| `run-smoke.ps1` × 行为替身（A1..A9 全绿；负对照恒绿 → A8 红；端口不在听 → 退出 4） | 全绿退出 0 / 红退出 2 / 前置失败退出 4 |

## 8. 已知依赖与留白（需要实现侧确认）

1. **`observation.json` 的落盘时序**：`cases/smoke-basic.json` 的 `artifact-nonempty(observation.json)` 与
   `json-field(observation.json #/schema)` 要求运行器在**判据求值之前**已落 `observation.json`
   （否则判据按 case-file.md §5 记 `error`，视同红）。文档未规定该时序。
2. **`case.run` 的变体选择参数**：两篇文档只定义了用例文件里的 `variants`，未定义 `case.run` 如何选定单个变体。
   `run-smoke.ps1` 因此自适应：有选择参数（`variant`/`variants`/`variantId`）就按变体跑，没有就在整跑结果里核对变体结论。
3. **`world-hash-equals` 未纳入冒烟**：该判据语义是「重建后场景哈希 == 本 run 首次构建哈希」，
   但文档未定义单次 `case.run` 如何触发「重建并比对」；冒烟改用 `world.rebuild` 的 `CP-CONFIRM-001` 边界做可写动作覆盖。
4. **按段连跑的产物归属**：契约 §8.2 要求「按段连跑与整跑一致」，但未定义段产物是否跨 run 目录承接。
   本脚本按**并集口径**比对（段集合相等、判据结论逐条相等、整跑产物都能在并集里找到），
   并把 `manifest.json`/`observation.json` 列为「记账类允许缺」。

## 9. PR-2 取证拍摄验收（`cases/smoke-shots.json` + `run-shots.ps1`）

> 契约出处：[`contract.md`](../../docs/control-plane/contract.md) §4.1（`shot.multi`/`capture.*`/`CameraSpec`）、
> §4.3（相机与渲染规则）、[`case-file.md`](../../docs/control-plane/case-file.md) §4（`capture`/`cameras`）、
> §5（`image-size-equals`/`image-not-uniform`）、§6（负对照）。
> 前置、启用通道、端口、`caller.mjs` 用法与退出码**与 §2/§3.1 完全一致**，本节不重复。

### 9.1 `run-shots.ps1` 用法

```powershell
pwsh -File scripts/control-plane/run-shots.ps1                     # 全流程（申请到 runClient 后跑）
pwsh -File scripts/control-plane/run-shots.ps1 -SkipClientStart    # 复用已在跑的客户端（不写配置、不停客户端）
pwsh -File scripts/control-plane/run-shots.ps1 -KeepClient         # 跑完保留客户端现场
pwsh -File scripts/control-plane/run-shots.ps1 -LegacyJdk          # 退回 runClientSdePipeline（默认 runClient25）
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `-CaseFile` | `cases/smoke-shots.json` | 用例文件（用例必须有 `cameras` 段与 `variants` 段，否则前置即退出 4） |
| `-McDataDir` | `mod/gtnh/run/client` | 覆盖 mcDataDir（离线自检用） |
| `-SkipClientStart` | 关 | 复用已在跑的客户端；要求端口在听且 `server.json`/`tokens.json` 就绪 |
| `-KeepClient` | 关 | 不停止本脚本启动的客户端 |
| `-EnableViaJvmProperty` | 关 | 后备启用通道（排障） |
| `-UseModernJdk` | **开（默认行为）** | 只为与 `run-smoke.ps1` 的写法兼容而保留：给了也是默认行为（裸开关可用，不报错） |
| `-LegacyJdk` | 关 | 退回 `runClientSdePipeline`；与默认（现代 JVM）互斥，给了它就以它为准 |
| `-Port` | `23057` | 仅前置占用检查用（后续一律以 `server.json` 的 `port` 为准） |
| `-ClientReadyTimeoutMin` | `5` | 等待 `server.json` 的上限 |
| `-CaseTimeoutMs` | `900000` | 单次 `case.run` 总超时（PR-2 整跑含世界重建 + 3 机位拍摄，比 PR-1 冒烟长） |
| `-ActionTimeoutMs` | `600000` | 单次 `world.rebuild`/`shot.multi` 总超时 |
| `-ArchiveRoot` | `D:\Workspace\Lightning\temp\control-plane` | 归档根（本次目录 `shots-<ts>\`） |
| `-FileParamName`/`-VariantParamName` | 空 | 参数名覆盖（默认从自描述探测；探测失败才需要显式给） |

**`-CaseTimeoutMs`/`-ActionTimeoutMs` 不只是 caller 的等待上限**：脚本还会把它作为动作自身的
`totalTimeoutMs`/`stageTimeoutMs` 传下去（**仅当该动作的自描述声明了这两个参数**，名字从 `--describe` 探测；
阶段预算被钳到不超过总预算）。理由是 `SteppingActionBase` 的默认值只有**总 5 min / 阶段 3 min**，
而 PR-2 整跑含「世界重建 + 3 机位拍摄」，不显式对齐就会出现「慢但正确」被判 `CP-EXEC-002` 的假红。

**与 `run-smoke.ps1` 的关系**：流程骨架、`lightning.cfg` 写入（`Enable-ControlPlaneCfg`，Forge 分节格式）、
陈旧发现文件移入 `stale/`、`Invoke-Caller`（只经 `caller.mjs`）、收尾三段（停客户端 → 还原 cfg → 归档）
**同源**；`run-shots.ps1` 不抽公共模块而是就地复制（两个驱动各自的归档/还原路径耦合在自身脚本里，
抽公共要再引入一个两边都加载的模块文件）。差异：断言集 B1..B7、`--tier forensic` 显式指定、
`capture.*`/`world.rebuild`/`shot.multi` 的额外调用、归档多一份截图原图平铺、动作自身超时对齐。

### 9.2 `cases/smoke-shots.json`

- `world`：`folder=cp_smoke_shots`、`seed=20261006`、`void=true`、`base=[64,12,64]`、`settleTicks=60`；
- `build`：清场 `[63,11,63]..[68,14,68]` → 3×`minecraft:stone` 横排（`base+[0,0,0]` / `@base`+`offset` / 绝对 `[66,12,64]`）
  → 1×`minecraft:chest`（`base+[0,0,1]`）+ `te` 步 `completer:"vanilla"` → `wait 20`；
- `capture`：`{lighting:"natural", renderMode:"本色", worldTime:6000}`（会话默认；worldTime 6000 = 正午）；
- `cameras`（3 机位，看的是同一场景 bbox `x[64,67] y[12,13] z[64,66]`，中心 `(65.5,12.5,65.0)`）：

  | 机位 | pos | yaw | pitch | 投影 | resolution | tile |
  |---|---|---|---|---|---|---|
  | `persp-main` | `[65.5,16.5,69.5]` | 180.0 | 41.63 | perspective fov 70 | 1280×720 | — |
  | `ortho-top` | `[65.5,18.0,65.0]` | 180.0 | 90.0 | ortho orthoHeight 12 | 1280×720 | — |
  | `persp-tiled` | `[68.5,16.5,68.5]` | 139.4 | 40.95 | perspective fov 70 | 1920×1080 | 2×2 overlap 0.05 |

- **yaw/pitch 的算法（可复算）**：1.7.10 的视线方向
  `d = (-sin(yaw)·cos(pitch), -sin(pitch), cos(yaw)·cos(pitch))`（`EntityLivingBase.getLook` 口径；
  本树 `mod/gtnh/build/rfg/minecraft-src` 的 `EntityRenderer.orientCamera` 把 `rotationPitch` 原样 `glRotatef`，
  与 AE2/Botania/BloodMagic 的 `getLook` 副本一致）。⇒ **pitch 为正才是俯视**，三机位取
  `yaw = 180° - atan(dx/dz)`、`pitch = atan(|dy| / 水平距离)` 对准场景中心，见 §9.7 留白 1。
- `criteria`（8 条，id 与语义）：

  | id | 类型 | 断言 |
  |---|---|---|
  | `persp-main-size` / `ortho-top-size` | `image-size-equals` | `1280×720`（整图尺寸，拼接机位指拼接后整图） |
  | `persp-tiled-size` | `image-size-equals` | `1920×1080` |
  | `persp-main-not-uniform` / `persp-tiled-not-uniform` | `image-not-uniform` | 默认阈值 `0.98` |
  | `ortho-top-not-uniform` | `image-not-uniform` | 显式 `maxSameColorRatio=0.995`（理由见 §9.7 留白 4） |
  | `persp-main-meta-exists` | `artifact-exists` | `shots/persp-main.meta.json` |
  | `observation-camera-injected` | `json-field` | `observation.json #/observation/camera/mode == "injected"` |

- `variants`：`neg-persp-main-width` 把 `criteria[0].params.width` 改成 `9999`（**只动判据、不动 world/build**，
  因此整跑时的变体扫描也会真实求值，`evaluated=true`），`expectCriteriaRed=["persp-main-size"]`；
- `evidence.expect`：`observation.json` / `criteria.json` / `shots/{persp-main,ortho-top,persp-tiled}.png`
  （缺失即 `evidence-complete` 红）。

### 9.3 断言 B1..B7

| id | 断言 | 红意味着 |
|---|---|---|
| B1/B1b/B1c | `case.run --tier forensic --sync` 退出码 0；`result.overall=green`；`shots.cameraCount==3` 且 `failedCount==0` | 取证拍摄整跑不通过（用例判据/证据任一处红），或机位没拍全 |
| B2a | run 的 `criteria.json` 全绿且覆盖用例全部判据 id | 图像判据没满足（黑屏/纯色/尺寸不符）或判据缺失 |
| B2b | `evidence.json` 的 `overall=green` 且 `expect` 里每条路径都在 run 目录里 | 证据清单缺项（本次缺的是截图原图或两份记账文件） |
| B2c | `observation.json` 的 `/observation/camera/mode == injected` | 相机不是注入式（PR-1 占位值 `player` 没被覆盖） |
| B2d | `observation.playerPos` 与 `observation.camera.pos` 至少一轴相差 > 0.5 | 门控位置分离（contract §4.3.2）没落地：机位与玩家位置被写成同一个 |
| B2e | `observation.cameras[]` 数量与名字 == 用例声明 | 多机位摘要缺失或顺序错乱 |
| B3a/B3b/B3c/B3d | 变体单跑退出码 0；`result.variantVerification.ok=true`；变体 run 的 `criteria.json` 里 `expectCriteriaRed` 全 `red`；其余判据仍 `green` | 负对照恒绿（假绿，防不住错图）或变体求值跑偏 |
| B4a/B4b/B4c/B4d | `capture.begin` 退出码 0 → 会话期间 `world.rebuild` 非 0 且 `error.code=CP-STATE-001` → `capture.end` 退出码 0 且 `wasArmed=true` → 再 `world.rebuild` 退出码 0 且 `scene.sha256` 非空 | 捕获会话没封住世界写动作（取证期间世界仍在变），或会话泄漏（永久封死写动作） |
| B5 | 含 `cameras` 段的 `case.run` 用 `--tier scene --sync`：非 0 且 `httpStatus=403` + `error.code=CP-AUTH-002` | 按内容升格（contract §4.3.9）没生效：低权限调用方顺手拿到了取证截图 |
| B6a | 3 机位 `shots/<name>.png` 存在且 >0 字节；`shots/**/*.png` 无 0 字节 | 截图没落盘/落成空文件（`ScreenShotHelper` 失败也返回非 null，只能靠文件断言） |
| B6b | 每机位 `meta.json` 的 `cameraHeldDuringRender=true`，`resolution`/`requestedResolution` 与用例声明一致 | 渲染期 `renderViewEntity` 被改回玩家（静默错图），或分辨率覆写没生效 |
| B6c | 三张整图 PNG **头实读**尺寸 == 声明 | 只靠 meta 自证不够；判据 `image-size-equals` 的同一口径独立复核 |
| B6d | 拼接机位 `shots/<name>.tiles/` 的片数 == `meta.tile.cols × rows`（**实际网格**，非声明值） | 分片丢失，或执行器/投影覆写的有效网格对不上（`requestedCols/Rows` 只记声明） |
| B6e | 单片命名 == `r<row>c<col>.png`（1 起，`ShotExecutor.tileName`），且无 0 字节片 | 逐片留痕的命名口径变了（事后无法按行列核对接缝） |
| B7a | `core.status` 退出码 0 且 `world.loaded=true`、`world.managed=true` | 拍摄把世界弄丢了（离开世界没重进） |
| B7b/B7c | 收尾用同一机位规格再调一次 `shot.multi`：退出码 0、`settingsRestored=true`、`baseDisplayWidth/Height` 与 `observation.clientConfig.displayWidth/Height` 一致；新图尺寸与 meta 留痕正确 | 投影/FOV/分辨率/`renderViewEntity`/`gameSettings` 有残留（第一次拍摄污染了后续） |

**退出码**：`0` 全绿；`2` 有断言红；`3` 管线级致命（`server.json` 超时 / 客户端早退）；`4` 前置检查或编排自身失败。
**参数名自适应**：`file`（`file|case|caseFile|path|casePath`）与变体选择参数（`variant|variants|variantId|variantIds`）
从 `case.run` 自描述探测，并记成断言 `P2 param:file` / `P3 param:variant`；自描述没有变体参数 → `P3` 红（B3 无从验证）。
§8.2 的留白（`case.run` 如何选定单个变体）已由 PR-2 自描述落地为 `variant`。

### 9.4 产物与归档（截图原图是证据）

归档目录 `<ArchiveRoot>\shots-<ts>\`：

| 内容 | 说明 |
|---|---|
| `runs/<runId>/` | 本次会话**每个** run 目录（`case.run` 整跑/变体、`world.rebuild`、`shot.multi`、`capture.*`）；`Invoke-Caller` 按「调用前后新增的 run 目录」登记，不猜「最新」 |
| `shots-flat/` | **全部截图原图平铺**：`<runId>__<机位>.png`、`<runId>__<机位>.tiles__r<row>c<col>.png`。验收时直接当 Gitea 附件上传（AGENTS.md 铁律：证据当场落 Gitea，`temp/` 里的不算） |
| `events.jsonl` | 事件流水副本（含 `case-segment`/`criteria-verdict`） |
| `logs/gradle-runClient.log`、`.err` | 客户端进程 stdout/stderr |
| `logs/fml-client-latest.log` | 客户端日志（`/cp/v1/logs/tail` 的数据源） |
| `logs/caller-*.json` | 每次调用的作业 JSON / 错误信封（`--json-out`） |
| `lightning.cfg.before` / `.after` / `.created-by-run-shots` | 配置原值 / 收尾值 / 新建件（新建件移入归档而非删除） |
| `stale/` | 启动前移开的陈旧 `server.json`/`tokens.json` |
| `assertions.json`、`summary.md`、`session.json` | 断言红绿表（机读 + 人读 + 会话摘要：用例 id、机位清单、run 目录清单、平铺张数） |

`summary.md` 另附**每个 run 的逐条判据结论表**（`criteria.json` 的 id/verdict/detail），便于把红绿表与判据结论一起当附件。
托管存档（`<mcDataDir>/saves/cp_smoke_shots`）不自动清理。

### 9.5 脚本依赖的 PR-2 契约事实（对照表增量）

| 脚本依赖 | 出处 |
|---|---|
| `shot.multi`（forensic）+ `cameras`/`target`/`lighting`/`renderMode`/`worldTime`/`capture` 参数、`since 1.1` | contract.md §4.1 |
| `capture.begin`/`capture.end`（forensic，`{confirm:true}`；重复 begin 拒、未 begin 的 end 幂等） | contract.md §4.1 |
| `CameraSpec = {name,pos,yaw,pitch,projection{type,fov\|orthoHeight},resolution,tile?{cols,rows,overlap}}` | contract.md §4.1 |
| `shots/<name>.png` + `shots/<name>.meta.json`（schema `lightning.shot-meta/1`）+ 拼接机位 `shots/<name>.tiles/` | contract.md §4.1、case-file.md §4 |
| `meta.json` 字段 `cameraHeldDuringRender`/`resolution`/`requestedResolution`/`tile{cols,rows,requestedCols,requestedRows,overlap}`/`lightingApplied` | 实现（`ShotExecutor.finishCamera`）；契约 §4.3.6 的 `lightingApplied:false` 留痕口径 |
| `tiles/` 单片命名 `r<row>c<col>.png`（1 起） | 实现（`ShotExecutor.tileName`）；契约只规定「逐片落盘可审计」 |
| 图像判据 `image-size-equals{path,width,height}`、`image-not-uniform{path,maxSameColorRatio?}` | case-file.md §5 |
| `observation.camera{...}`/`cameras[]`/`playerPos`（门控位置分离） | contract.md §4.3.2、observation-record.md §2.4 |
| 含 `cameras` 段的 `case.run` 按内容升格 → sync 得 HTTP 403 `CP-AUTH-002` | contract.md §4.3.9 |
| `case.run` 的 `variant` 参数 + `result.variantVerification{ok,actual,notRed,missing}` | 实现（自描述 `variant`、`CaseRunAction.verifyVariant`）；case-file.md §6/§8.5 |
| 步进动作的 `totalTimeoutMs`/`stageTimeoutMs`（默认 5 min / 3 min） | 实现（`SteppingActionBase.PARAM_*`，自描述里带 default） |

### 9.6 自检记录（离线，不含客户端实测）

| 自检 | 结果 |
|---|---|
| `node --check`（`caller.mjs` 未改）+ 用例 JSON `JSON.parse` | 通过 |
| `run-shots.ps1` 解析检查（`[Parser]::ParseFile`） | 通过（8433 token，0 错误） |
| `cases/smoke-shots.json` × 仓内**真实** `CaseValidator.validate`（`core/` 全量 `javac` 编译 + gson 2.2.4，临时 main） | `VALID`：8 判据 / 3 机位 / 1 变体，`variants[0].applicable=true`，`evidence` 5 项；唯一 warning 是「cameras 段非空 ⇒ 需 forensic」（预期） |
| 同法回归 `cases/smoke-basic.json` | 仍 `VALID`，`warnings=[]` |
| `run-shots.ps1` × 行为替身（契约面 stub：自描述 + 同步作业 + run 产物形态 + 真 PNG） | 全绿 28 条断言 → 退出 0；注入缺陷时精确变红：tiles 少一片 → `B6d`/`B6e` 红、退出 2；变体不变红 → `B3a`/`B3b`/`B3c` 红、退出 2；升格不生效 → `B5` 红、退出 2；端口不在听 → 退出 4 |
| `run-shots.ps1` × 自描述驱动的超时对齐 | 请求体里带 `totalTimeoutMs`/`stageTimeoutMs`（B1 的 `case.run`、B4 的 `world.rebuild`、B7 的 `shot.multi`），名字先经 `--describe` 探测 |

### 9.7 已知留白与实现/契约不一致（需要实现侧裁决）

1. **`pitch` 符号：契约注释与 1.7.10 现实相反。** `docs/control-plane/contract.md` §4.1 的 `CameraSpec` 示例
   （`pos [64.5,20,70.5]`、`pitch -45`）与 `CameraSpec.java` 的字段注释（`负为俯视`）都假定「负 = 俯视」，
   而 `VirtualCamera.place()` 把 `pitch` 原样写进 `rotationPitch`，`EntityRenderer.orientCamera` 也是原样
   `glRotatef` ⇒ 按 `getLook` 口径 `d.y = -sin(pitch)`，**负 pitch 是仰视**。本用例按「俯视场景」的真实需求取正 pitch；
   若裁决以契约为准，实现需在注入前取负（并同步两篇文档），届时本用例三机位的 pitch 要一并翻转。
2. **`camera.pos` 与有效视点差 1.7 格。** `EntityRenderer.orientCamera` 用 `f1 = yOffset - 1.62F` 与
   `glTranslatef(0, f1, 0)`（非第三人称另有 `-0.1`）定位视点，而 `VirtualCamera` 把 `yOffset` 置 0 ⇒
   有效视点 = 声明 `pos.y - 1.72`（类注释「视点 = posY + yOffset」少了 `-1.62` 常量；要「pos 即视点」应设
   `yOffset = 1.62`）。本用例的取景角按声明 `pos` 计算，并在两种口径下都留了 ≥10° 的余量（场景始终在画面内），
   但 `observation.camera.pos` / `meta.spec.pos` 记的是**声明值**而非有效视点——事后从留痕复算实际取景会差 1.7 格。
3. **真实玩家实体会进画面。** `RenderGlobal.renderEntities` 只跳过 `renderViewEntity` 自己；注入相机不是玩家，
   于是玩家稳定化位置 `base + (0.5,1,0.5)`（= 第一块石头那一格）的玩家模型会被渲染进所有机位。
   这是 A3「门控位置分离」的必然代价（世界侧确实没动玩家），但看图的人要知道画面里那个实体是玩家，不是场景物。
   要不要在拍摄期隐藏玩家实体（`mc.thePlayer` 走 `RenderGlobal` 的既有跳过分支之外再加一条）属产品裁决。
4. **正交俯拍必然顶到 `image-not-uniform` 的默认阈值。** `orthoHeight=12` + 16:9 ⇒ 画面覆盖 ≈21.3×12 格；
   场景可见面积（3 石 + 1 箱顶面，正交俯视只看顶面）≈3.8 格² ⇒ 只占画面 ≈1.5%，其余是虚空背景的**单一颜色**
   （相机在地平线以下时 `RenderGlobal.renderSky` 用纯色面/黑盒铺底，正交下所有背景像素等距 ⇒ 无渐变）。
   默认 `maxSameColorRatio=0.98` 对**正确**的正交俯拍图也会判红，故该判据显式写 `0.995`
   （纯色假图仍是 `1.0` ⇒ 仍拦得住）。这是用例侧的阈值校准，不是判据类型的问题；但若后续再有「大范围小场景」
   的正交机位，都会撞同一件事，值得在 contract §4.3 记一条「正交机位的 `image-not-uniform` 阈值按场景占比给」。
5. **拼接机位的中间帧命名与登记。** `ShotExecutor.shoot()` 对拼接机位把每片渲染帧也落在
   `shots/<name>-r<row>c<col>.png`（与 `shots/<name>.tiles/r<row>c<col>.png` **不同名**），且这些中间帧
   **不登记**进 `manifest.json` / `artifacts`（`GET /cp/v1/artifacts/{runId}` 看不到）。判据与 B6 只用
   `tiles/` 的口径；中间帧是否该登记、命名是否该与 `tiles/` 统一，留待实现侧。
6. **`evidence-complete` 只落在 `evidence.json`。** `criteria.json` 里没有这条 id，判据集合与证据结论是两份文档。
   因此 `run-smoke.ps1` 的 A4c（在 criteria 的 verdict map 里找 `evidence-complete`）恒为空转（有 `if` 保护，不误报红）；
   本驱动的 B2b 直接读 `evidence.json`。


## 10. PR-3 锚点验收（`cases/lp-pipe-row.json` + `cases/ae2-parts.json` + `run-anchor.ps1`）

> 契约出处：contract.md §6.3（托管世界固定完成序 + **AE2 空缆块自毁时序陷阱**）、§6.4（TE 状态补全=
> 走模组权威同步路径）、§6.5（**补全器的权威放置职责**：`params` 是放置输入而不是 NBT 回填；v1.2 注册表
> `vanilla`/`lp-pipe`/`ae2-part`）、§4.3.1（AE2 电缆 30 方块渲染距离门）；case-file.md §5（`te-state-equals` /
> `image-uniform` 与**双轨判据口径**）、§8.7（清单哈希口径）。
> 前置、启用通道、端口、`caller.mjs` 用法与退出码**与 §2/§3.1 完全一致**，本节不重复。

### 10.1 `run-anchor.ps1` 用法

```powershell
pwsh -File scripts/control-plane/run-anchor.ps1                    # 全流程（申请到 runClient 后跑）
pwsh -File scripts/control-plane/run-anchor.ps1 -SkipClientStart   # 复用已在跑的客户端（不写配置、不停客户端）
pwsh -File scripts/control-plane/run-anchor.ps1 -KeepClient        # 跑完保留客户端现场
pwsh -File scripts/control-plane/run-anchor.ps1 -ChecksOnly        # 只跑离线检查（C2 + 复算器自检），不起客户端
pwsh -File scripts/control-plane/run-anchor.ps1 -LegacyJdk         # 退回 runClientSdePipeline（默认 runClient25）
pwsh -File scripts/control-plane/run-anchor-selftest.ps1           # 离线行为自检（合成夹具，见 §10.7）
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `-LpCaseFile` / `-Ae2CaseFile` | `cases/lp-pipe-row.json` / `cases/ae2-parts.json` | 两个锚点用例 |
| `-McDataDir` | `mod/gtnh/run/client` | 覆盖 mcDataDir（离线自检用） |
| `-SkipClientStart` | 关 | 复用已在跑的客户端；要求端口在听且 `server.json`/`tokens.json` 就绪 |
| `-KeepClient` | 关 | 不停止本脚本启动的客户端 |
| `-ChecksOnly` | 关 | **只跑离线检查**（C2 + 主色占比复算器自检）：不写配置、不起客户端、不做 C1/C3~C7 |
| `-EnableViaJvmProperty` | 关 | 后备启用通道（排障） |
| `-UseModernJdk` | **开（默认行为）** | 只为与 `run-smoke.ps1`/`run-shots.ps1` 写法兼容而保留 |
| `-LegacyJdk` | 关 | 退回 `runClientSdePipeline`；与默认（现代 JVM）互斥，给了它就以它为准 |
| `-Port` | `23057` | 仅前置占用检查用（后续一律以 `server.json` 的 `port` 为准） |
| `-ClientReadyTimeoutMin` | `5` | 等待 `server.json` 的上限 |
| `-CaseTimeoutMs` / `-ActionTimeoutMs` | `900000` / `600000` | `case.run` 总超时 / 动作自身超时（仅当自描述声明了 `totalTimeoutMs`/`stageTimeoutMs` 才下传，名字从 `--describe` 探测） |
| `-ArchiveRoot` | `D:\Workspace\Lightning\temp\control-plane` | 归档根（本次目录 `anchor-<ts>\`） |
| `-FileParamName` / `-VariantParamName` | 空 | 参数名覆盖（默认自描述探测） |

**拆分口径**：驱动脚本只管「起客户端 / 调 `caller.mjs` / 归档 / 打印红绿表」；所有**红绿判定本体**在
`anchor-checks.ps1` 的纯函数里（`Test-AnchorPairing` / `Test-VariantPrecision` / `Test-GateCriteria` /
`Test-GateUniformRecompute` / `Test-IdempotentManifest` / `Test-EvidenceComplete` /
`Test-ObservationTeReads` / `Test-ObservationCameras` + `Get-PngDominantColorRatio`）。
拆出来的唯一理由是**可离线自检**：同一份判定既能被真机轮次调用，也能被 `run-anchor-selftest.ps1` 用合成夹具
反复喂坏数据（§10.7）。这与 §9.1 里「两个驱动各自复制公共函数」的取舍不冲突——那个取舍针对的是**归档/还原路径**
的耦合，本模块不含任何进程或归档逻辑。

### 10.2 `cases/lp-pipe-row.json`（LP 四管锚点）

- `world`：`folder=cp_lp_pipe_row`、`seed=20261006`、`void=true`、`base=[64,12,64]`、`settleTicks=60`；
- `build`：清场 `[62,10,62]..[70,16,68]` → **3 根 LP 基础物流管**（`64/65/66`，全用 `te` 步 `completer:"lp-pipe"`，
  物品注册名见 §10.6）→ `minecraft:chest`（`block` 步）+ `te` 步 `completer:"vanilla"` → `wait 20`；
  三种连接形态：`64` 裸管（四面皆空）、`65↔66` 两管互联、`66` 管+箱（东侧接箱子）；
- `capture`：`{lighting:"natural", renderMode:"本色", worldTime:6000}`；`cameras` 2 个 1280×720 透视机位
  （`persp-row` 斜视看三种连接形态、`persp-front` 正面平视，两者都取正 pitch=俯视，口径同 §9.2 的 yaw/pitch 算法）；
- `criteria`（18 条，`te-*` 8 条 + `img-*` 8 条 + `world-hash` + `observation-exists`）：

  | 目标 | 运行期轨（`te-state-equals`，id 前缀 `te-`） | 图像轨（id 前缀 `img-`） |
  |---|---|---|
  | `x1`（裸管） | `te-x1-iso-north`=`/connections/NORTH` false、`te-x1-iso-west`=`/connections/WEST` false、`te-x1-iso-init`=`/initialized` true | `img-x1-size` / `img-x1-not-uniform`（`persp-row.png` 1280×720 + 非纯色） |
  | `x2`（两管互联） | `te-x2-pair-east`=`@65 /connections/EAST` true | `img-x2-size` / `img-x2-not-uniform`（同上，互连的可见性） |
  | `x3`（管+箱） | `te-x3-pair-west`=`@66 /connections/WEST` true、`te-x3-chest-east`=`@66 /connections/EAST` true、`te-x3-down`=`@66 /connections/DOWN` false、`te-x3-pipe-type`=`@66 /pipeType` | `img-x3-size` / `img-x3-not-uniform`（同上） |
  | `scene` | —（由 x1..x3 覆盖；全场景可见性由图像轨单独承担） | `img-scene-size` / `img-scene-no-blank-frame`（`persp-front.png`，**`maxSameColorRatio=0.90`——防整帧假图**，见下方「图像轨阈值标定方法」） |

- `variants`：`neg-x1-iso-north-flipped` 把 `criteria[0].expect` 由 `false` 改成 `true`（只动判据、不动 world/build），
  `expectCriteriaRed=["te-x1-iso-north"]`；
- `evidence.expect`：`observation.json` / `criteria.json` / `world/scene-manifest.json` / 两张机位 PNG。

**双轨配对口径（驱动 C2 静态检查的判定规则）**：判据 id 一律是「`<轨前缀>-<目标>[-<面|机位>]`」三段形态——

1. 运行期轨 id 以 **`te-`** 开头，图像轨 id 以 **`img-`** 开头；
2. **第二段是目标名**，必须逐字相同（`te-x1-iso-north` ↔ `img-x1-*`）；
3. 静态检查对每个 `te-state-equals` 判据要求「同目标至少存在一条 `img-*` 判据」，缺失即红；
   第三段自由（可写面名如 `iso-north`，也可写机位名如 `-persp-row`）。

因此同一处可视特性一定是「运行期说什么 + 图像证明看得见」成对出现——只写运行期轨等于只证明世界状态对、
没证明渲染结果对（case-file.md §5 的双轨齐备口径）。

**图像轨阈值标定方法（PR-3 验收轮 a2 实战教训，后续用例必须照做）**：`image-not-uniform` 的默认
`0.98` 只挡「纯黑/纯白假图」，**挡不住「机位朝向错、画面里只有天空渐变」的空转绿**（a2 首轮 LP 两机位
yaw 算错背对场景，0.98 阈值下照样全绿——目验截图才擒获）。规矩有三：
1. **截图必须目验**（首轮验收至少一次），确认画面里真的有场景；
2. **决定性阈值 = 场景实测值与「同机位纯天空实测值」之间的中值并留余量**——本用例的标定：
   `persp-front` 贴近取景（管排占画面主体）实测主色占比 **0.0746**（场景在）、纯天空对照档
   **0.137~0.151** ⇒ 阈值 **0.10**（两侧余量均 ≥25%）；`persp-row` 主色 0.1208 与纯天空档拉不开
   安全间距 ⇒ 它的 `not-uniform` 保持 0.98，只承担「黑屏防线 + 形态留档」，**决定性判据
   集中在 `img-scene-not-uniform`**（即重校准后的 `img-scene-no-blank-frame`，见文末记录），不在每个配对判据上都假装有精度；
3. 每个锚点用例至少要有**一条**这种「贴近取景 + 决定性阈值」的判据。
4. **主色占比对「场景覆盖率 <50%」结构性不敏感**（a2 标定实测：AE2 缆总成在 fov 70/20 下
   场景档与纯天空档读数完全相同 0.1423/0.1422、0.2335/0.2335——场景像素颜色各异，先吃掉的是
   非主色的天空像素）。所以「贴近取景」必须真的贴到场景占半幅以上，否则两档拉不开；
   AE2 侧决定性判据 = `img-*-not-uniform-near`（fov 10 特写，~~0.15~~ 重校准后 0.90，见文末第二案记录）与 `img-gate-not-uniform-near`
   （窄 fov 门内对照，0.98 vs 门外 1.0）。

**判据重校准记录（2026-10-06，`img-scene-not-uniform` → `img-scene-no-blank-frame`，0.10 → 0.90；
出处 #89 评论 1669 判读 + Lead 裁决采纳方案 A）**：上面的 0.10 标定在 **原版渲染**下成立（场景在
0.075 / 纯天空 0.137~0.151），但在 **Angelica 渲染管线**（GTNH 新基线，地平线雾带与虚空渐变层视觉
消失、天空整片均匀天穹色）下，「场景在」读数跳到 **0.413**、「TE 丢失后」0.531，0.10 阈值必红——
渲染差异说由 5 个旧基线样本（稳定 0.075）+ 直方图（内容像素计数两基线一致、主色同 #BCD5FF）坐实。
重校准后意图改为**只防整帧假图**（黑/白空帧主色占比 ≈1.0，两基线同）：正常帧旧基线 0.075 /
新基线 0.413，0.90 对两基线都保留判别间距。**已知空隙（如实记录）**：vanilla 下「机位背对场景、
画面只有天空渐变」（0.137~0.151）在 0.90 阈值下转绿——该守卫在原版渲染下失效，由规矩 1
「截图必须目验」承担；Angelica 下纯天空帧主色 ≈1.0 仍被抓。TE 丢失曾被本判据附带抓住（0.531），
属错位职责，正式守卫归 `te-state-equals` 双轨判据，不因本次重校准补回。雾带消失的机制层归因
（GLSM/FogService 哪一环）**已知未究**。

**判据重校准记录·第二案（2026-10-06，AE2 三条 `img-*-not-uniform-near` 0.15 → 0.90，**不改名**；
出处 #89 评论 1684 提案 + Lead 裁决批准）**：新基线 AE2 读数出现后风险坐实——ctm/Angelica 下
`near.png`（fov 10 特写）内容档主色占比实测 **0.745**（对照实验② AE2 首跑），远超 0.15；
vanilla 标定为内容档 0.1423 / 纯天空档 0.1422。重校准后意图与第一案同一口径：**防整帧假图 +
Angelica 下防纯天空空转绿**（Angelica 纯天空档预期 ≈1.0，0.90 两侧余量 17% / 10%）。
**已知空隙（同族如实记录）**：vanilla 下纯天空 0.1422 在 0.90 阈值转绿，该守卫在原版渲染失效，
由规矩 1「截图必须目验」承担。**不改名的理由（Lead 确认）**：三条 id 被 `anchor-checks.ps1`
的 `Test-GateCriteria` 默认参与 `run-anchor-selftest.ps1` 两组 fixture 字面引用，改名牵动
4 文件且 id 无错误语义（not-uniform 是判据型名），意图声明走本记录路径。
**`img-gate-not-uniform-near`（0.98）不动**：新基线实测 0.9709 贴边险过（余量 0.9%，记录在案）；
其判据意图是门内/门外**对照**（gate-near 0.9709 vs far 0.9982，两读数 Angelica 下同步抬升、
2.7pt 间距仍在），C4 对照断言功能未损。

### 10.3 `cases/ae2-parts.json`（AE2 部件锚点 + K1 门控对照）

- `world`：`folder=cp_ae2_parts`、`seed=20261006`、`void=true`、`base=[64,12,64]`、`settleTicks=60`；
- `build`（**时序关键**：缆块的 `block` 步与其 `te` 步同 tick 紧邻，中间不插 `wait`/`clear`——
  契约 §6.3 的 AE2 空缆块自毁陷阱）：
  1. `block @64` = `appliedenergistics2:tile.BlockCableBus` → **同一 tick 紧随** `te @64` `completer:"ae2-part"`：
     `parts=[{中心缆 UNKNOWN, meta 16},{切换总线 NORTH, meta 80},{存储总线 UP, meta 220}]`
     （中心缆写在 `parts[]` **最前**：AE2 的 `canAddPart` 拿中心缆类型校验各面部件）；
  2. `block @65` 缆块 → `te @65` `parts=[{中心缆 UNKNOWN, meta 16}]`（第二根缆，制造相邻缆格）；
  3. `block @66` = `minecraft:chest`（meta 3，按世界实写值声明） → `te @66` `completer:"vanilla"`；
  4. **K1 器具**：`block @[64,12,90]` = `minecraft:chest`（meta 3）→ `te` `completer:"vanilla"`
     （门控专用箱，远离 AE2 场景 26 格；清场区相应扩到 z=94）；
  5. `wait 20`；
- `capture`：同 §10.2；`cameras` 4 个：

  | 机位 | pos | 投影 | 与门控箱的距离 | 作用 |
  |---|---|---|---|---|
  | `near` | `[68.5,13.3,68.5]` pitch 8 | perspective **fov 10**, 1280×720 | — | 缆总成必被渲染 ⇒ `image-not-uniform` **决定性阈值 0.15**（场景实测 0.1172 / 同几何纯天空 0.1804；fov 70/20 下两档实测完全相同 0.142/0.233——主色占比对 <50% 覆盖率场景结构性不敏感，必须贴近取景） |
  | `ortho-top` | `[65.3,18.0,64.2]` pitch 90 | ortho orthoHeight 7, 1280×720 | — | 正交俯视形态留档；阈值 0.995 仅作黑屏防线（同几何两档同为 0.194，无法分离——决定性由 near 承担） |
  | `gate-near` | `[64.5,13.5,120.5]` pitch 2 | perspective **fov 8**, 640×360 | ≈30.5 格（**门内** <64） | 箱必被渲染 ⇒ `image-not-uniform`（实测主色 0.757） |
  | `far` | `[64.5,13.5,160.5]` pitch 1 | perspective **fov 5**, 640×360 | ≈70.5 格（**门外** >64） | 箱被 TESR 门剔除 ⇒ `image-uniform`（**实测主色 1.000000、colors=1**，阈值 0.95） |

- `criteria`（20 条；id 第二段是目标，配对口径同 §10.2）：

  | 目标 | 运行期轨（`te-*`） | 图像轨（`img-*`） |
  |---|---|---|
  | `host`（`@64` 缆 + 两部件） | `te-host-cable`=`/partClasses/UNKNOWN`、`te-host-cable-item`=`/parts/UNKNOWN`、`te-host-toggle`=`/partClasses/NORTH`、`te-host-storage`=`/partClasses/UP`、`te-host-empty-down`=`/parts/DOWN`=null | `img-host-size-near` / `img-host-not-uniform-near`、`img-host-size-ortho` / `img-host-not-uniform-ortho` |
  | `nb`（`@65` 相邻纯缆） | `te-nb-cable`=`/partClasses/UNKNOWN`、`te-nb-cable-item`=`/parts/UNKNOWN`、`te-nb-empty-east`=`/parts/EAST`=null | `img-nb-size-near` / `img-nb-not-uniform-near` |
  | `scene` | —（由 host/nb 覆盖） | `img-scene-size-near` / `img-scene-not-uniform-near` |
  | `gate`（K1 门控） | —（门控是**渲染**判据，运行期无对应状态可断言） | `img-gate-size-near` + `img-gate-not-uniform-near`（门内箱在）+ `img-gate-size-far` + `img-gate-uniform-far`（门外箱失，`minSameColorRatio=0.95`） |

  末行是 §10.2 配对口径里**唯一允许「图像轨单独成立」**的形态：`img-gate-*` 没有 `te-gate-*` 配对，
  因为配对的强制方向是「每个 `te-*` 必须有同目标 `img-*`」（运行期结论必须有图像佐证），反向不强制。
  这也是 C4 门控要单独断言的原因——它证明的是「渲染距离门按相机坐标生效」，不是某个 TE 字段的取值。
  加上 `world-hash` 与 `observation-exists` 共 22 条。
- `variants`：`neg-host-cable-class-flipped` 把 `criteria[0].expect` 改成 `PartCableSmart`，
  `expectCriteriaRed=["te-host-cable"]`；
- `evidence.expect`：`observation.json` / `criteria.json` / `world/scene-manifest.json` / 四张机位 PNG。

**K1 门控原理（PR-3 真机实证后的机制更正）**：1.7.10 的 TE 距离门由 `TileEntityRendererDispatcher`
按 `renderViewEntity` 静态位置剔除 **TESR** 渲染，门值是各 TE 的 `getMaxRenderDistanceSquared()`
（原版默认 4096=64 格）。**AE2 缆几何走 ISBRH 块层渲染、不受此门管**——`TileCableBus` 的 900.0
（30 格）门只管其动态部件（监视器屏显等 `requireDynamicRender()` 为真的 TESR 内容），因此
「缆在 30 格外消失」在 AE2-U rv3 上不成立（验收轮 a1 的 far 图实证：41 格外缆与箱仍渲染为一个
黑点）。故 K1 器具改为**原版箱子**（`TileEntityChest` 走 TESR，门 = 原版默认 64 格）：玩家被
稳定化流程恒定在门控箱 26 格处（**玩家始终在门内**），相机两次跨门——`gate-near`（30.5 格，
门内）箱必在、`far`（70.5 格，门外）箱必失。**若门随的是玩家而非相机，两张图里箱都会在**；
实测 far 主色占比 1.000000（colors=1）⇒ 箱确实被剔除 ⇒ 门随相机生效。窄 fov（5~8）的作用
有二：把箱放大到可断言量级、把天空渐变压到逐像素平坦（宽 fov 下天空渐变主色占比只有 0.06~0.17，
`image-uniform` 指标在宽 fov 天空上不可用——这是 a1 轮 6 红的真因：判据指标选型错，不是实现错）。

### 10.4 `cases/gg-antimatter-casing.json`（#87 回归锚：GG 外壳 CTM 导出材质定位）

- 锚点定位：issue #87（GoodGenerator `antimatterContainmentCasing` 导出紫黑占位）的持久回归用例——
  CTM 连通对 + 孤立枚 + 同 mod 正常对照，六轴正交。根因与验收证据链见 #87（评论 1651 根因 /
  1918 验收 / 1919 更正）与 #89；
- `world`：`folder=cp_gg_casing`、`seed=20261006`、`void=true`、`base=[64,12,64]`、`settleTicks=60`；
- `build`：横排 `[64..68,12,64]` = stone | ACC | ACC（connect=block 连通对）| magneticFluxCasing |
  gravityStabilizationCasing（同 mod 正常对照）+ 孤立 ACC `[65,12,66]`（tile 0 形态）；`wait 20`；
- **机位构造（「瞄准结构中心」，Lead 批准）**：六机位 pos 均取在「过结构几何中心
  G=(66.5,12.5,65.5)（内容 AABB x[64,69)×y[12,13)×z[64,67)）的视轴」上，yaw/pitch 由 pos→G 反推
  （游戏侧 `d_mc(yaw,pitch)` 与 web 出图器具 `lookAt(G−pos)` 由构造同向）；`ortho-top` 的 pos 在 z
  向偏 0.5 格（pitch 86.4° 而非 90°）以避开 lookAt 极点退化与 MC 极点旋向不确定；
- 判据口径：六机位各 `image-size-equals` + `image-not-uniform`（`maxSameColorRatio=0.98`——
  Angelica 均匀天穹下 5 格横排主色占比 ≈0.92，0.98 保留对「纯天空 ≈1.0」的判别）+
  `world-hash` + `observation.json` 存在性；
- 变体（负对照）：`neg-iso-acc-moved` 把孤立 ACC 挪一格（`/build/6/at` → [65,12,67]），
  预期仅 `world-hash` 变红。

### 10.5 断言 C1..C7

| id | 断言 | 红意味着 |
|---|---|---|
| C1xx-a/b/c/d/e | 每用例：`case.run --tier forensic --sync` 退出码 0；`result.overall=green`；`shots.cameraCount` == 用例机位数且 `failedCount=0`；run 的 `criteria.json` 全绿且覆盖用例声明的**全部**判据 id；`evidence.json` overall=green 且期望证据 + 各机位 PNG 逐条在场 | 用例（含双轨判据/图像/证据）任一环不通过，或 run 产物自证不完整 |
| C2 | 两个用例文件里每个 `te-state-equals` 判据都有**同目标**的图像判据（§10.2 配对口径）；**不需要客户端** | 锚点用例双轨不齐（只证世界状态、没证渲染结果）——用例缺陷 |
| C3xx-a/b/c/d | 每用例：变体单跑退出码 0；`result.variantVerification.ok=true`；变体 run 的 `criteria.json` 里 `expectCriteriaRed` 全部变红；**其余判据仍绿** | 负对照恒绿（假绿，防不住错图/错状态）或变体求值跑偏（误伤其它判据） |
| C4a | ae2 run 的 `near.png`/`ortho-top.png` 非空且 `image-not-uniform` 判据绿（AE2 场景确实渲染出来了） | 场景没渲染出来（图缺失/空图/纯背景） |
| C4b | ae2 run 的 `far.png` 非空且 `image-uniform`（+ 尺寸判据）绿（门外机位确实看不见门控箱）；`gate-near.png` 非空且 `image-not-uniform` 绿（门内机位确实看见——K1 的决定性两半：玩家恒在门内，门若随玩家则两图皆有箱） | TESR 距离门没随相机生效：箱在门外仍被渲染，或门内也不渲染（K1 门控失效/器具摆错） |
| C4c | **独立复算** `far.png` 的主色占比 ≥ 判据的 `minSameColorRatio`（自己解 PNG：IDAT→inflate→逐行反滤波→数众数像素） | 与判据同口径但不共用实现；判据绿而这里红 ⇒ 判据实现可疑（反之亦然） |
| C5a/a2/b/c | lp-pipe-row 连跑两次（两个 runId）：两次都退出码 0 + overall green；两次 `world/scene-manifest.json` 的 `sha256` 相等；两次 run 的 `world-hash-equals` 判据均绿 | 场景重建不幂等（世界漂移）——见 §10.8 留白 2 的已知边界 |
| C6xx | 两用例 run 的 `evidence.json` overall=green 且期望证据逐条在场（含机位 PNG） | 证据清单缺项（截图或记账文件没落盘） |
| C7xx（×2） | 两用例 run 的 `observation.json`：`runtimeReads` 里存在 key 以 **`te.lp-pipe[`** / **`te.ae2-part[`** 开头的条目（族名逐字口径）且其 `sha256` 非空；`observation.cameras` 数量/顺序/名字与用例一致且每项含 `pos`/`projection`/`resolution` | 运行期轨没有留痕（观测记录离线不可解释），或机位摘要缺失/串位 |

**退出码**：`0` 全绿；`2` 有断言红；`3` 管线级致命（`server.json` 超时 / 客户端早退）；`4` 前置检查或编排自身失败。
**归 port 口径、参数名自适应（`P1`/`P2`/`P3`）与 `run-shots.ps1` 相同**。

### 10.6 注册名来源（源码实证——用例里每个字符串都可核对）

| 用例里的字符串 | 出处（源码行号） | 运行期实证 |
|---|---|---|
| `LogisticsPipes:item.PipeItemsBasicLogistics` | `LogisticsPipes.java:691-694`：`createPipe()` 里 `res.setUnlocalizedName(clas.getSimpleName())`；`LogisticsBlockGenericPipe.java:882-885`：`registerPipe()` 再 `setUnlocalizedName(clas.getSimpleName())` + `GameRegistry.registerItem(item, item.getUnlocalizedName())`；`@Mod(modid="LogisticsPipes")` 在 `LogisticsPipes.java:156` | 现场探针产物 `sde_lp_te_probe_result.json` 的 `registeredPipeItems` 读到 `"registry": "LogisticsPipes:item.PipeItemsBasicLogistics"`（`LpTeRoundTripAutomation` 走 `Item.itemRegistry.getNameForObject`）。**历史实证（Gitea #104 后形态已不存在）**：该类与那份产物文件随 #104 整体删除——结论仍可按上列源码行复核，但产物工件不再可再生成 |
| `appliedenergistics2:item.ItemMultiPart` | `core/features/ItemFeatureHandler.java:67-71`：`name=="ItemPart"` → `name="ItemMultiPart"`，随后 `GameRegistry.registerItem(item, "item." + name)` | 探针产物 `PartsFamilyProviderProbe.java:182/213/230` 断言的 `typeKey` 字面量即 `appliedenergistics2:item.ItemMultiPart:<meta>`。**历史实证（Gitea #104 后类已删除）**：该探针类随 #104 整体删除，字面量结论仍可按上列源码行复核 |
| `appliedenergistics2:tile.BlockCableBus` | `core/features/AECableBusFeatureHandler.java:60-72`：`registryName = "tile." + name` → `GameRegistry.registerBlock(featured, null, registryName)` | 同上（部件格宿主 registry 名） |
| 部件 `meta`：中心缆 16 / 切换总线 80 / 存储总线 220 | `items/parts/PartType.java:70`（`CableGlass(0, …)`，括号首参即 `baseDamage`）、`:111`（`ToggleBus(80, …)`）、`:126`（`StorageBus(220, …)`）；`ItemMultiPart.java:119`：`partDamage = mat.getBaseDamage() + varID`，`varID = AEColor.ordinal()`（`api/util/AEColor.java` 的常量声明序里 `Transparent` 在末位，ordinal 16 ⇒ 缆 `0+16=16`，总线/存储总线 varID=0 ⇒ meta 就是 `baseDamage`） | `PartsFamilyProviderProbe.java:182/213/230` 的三条字面量断言（真机跑过；**该类已随 Gitea #104 删除**，此处为历史实证） |
| `PartCableGlass` / `PartToggleBus` / `PartStorageBus`（类名） | `items/parts/PartType.java` 的 import 段（`appeng.parts.networking.PartCableGlass`、`appeng.parts.misc.PartToggleBus`、`appeng.parts.misc.PartStorageBus`）与各枚举常量的构造参数 | 描述器输出 `partClasses`（本树真实客户端首轮已实测命中，见 §10.8 留白 1） |

**写法的两个坑（用例里刻意避开）**：

1. **LP 管物品名带 `item.` 段**。直觉写法 `LogisticsPipes:PipeItemsBasicLogistics` 会报 `CP-VALID-002`
   （`LpPipeCompleter.resolveItem` 走 `GameRegistry.findItem("LogisticsPipes","PipeItemsBasicLogistics")`
   查不到）——真实注册名是 `LogisticsPipes:item.PipeItemsBasicLogistics`（上面那行实证）。
2. **AE2 部件的物品身份含 meta**。`ModReflect.itemId(ItemStack)`（`:103-114`）在 meta≠0 时输出
   `modid:name@meta`，而 `LpPipeDescriber`/`Ae2PartDescriber` 的 `parts` 值走同一函数 ⇒ 断言非 0 meta 的
   部件必须写 `appliedenergistics2:item.ItemMultiPart@16` 这种形态（缆固定带 `@16`，总线/存储总线 meta 为 0
   不带后缀）。`partClasses` 是纯类名、与 meta 无关，适合断言「这一面装的是哪种部件」。

### 10.7 自检记录（离线，不含客户端实测）

```powershell
pwsh -File scripts/control-plane/run-anchor.ps1 -ChecksOnly          # C2 + 复算器自检（5 条断言）
pwsh -File scripts/control-plane/run-anchor-selftest.ps1              # 29 条行为自检（合成夹具）
```

`run-anchor-selftest.ps1` 用合成夹具（本地生成的真 PNG：正确 CRC、24 位真彩、可控主色占比）逐条验证
`anchor-checks.ps1` 的判定**方向正确且不会恒绿**，覆盖的坏数据情形：

| 检查 | 好数据 | 坏数据（必须红） |
|---|---|---|
| `Test-AnchorPairing` | 配对齐 | 缺同目标图像判据 / id 不以 `te-` 开头 / 用例无 `te-state-equals` / 文档为空 |
| `Test-VariantPrecision` | 精确命中 | 目标恒绿（假绿）/ 误伤其它判据 / `criteria.json` 缺失 |
| `Test-GateCriteria` | 门内 non-uniform + 门外 uniform | 缆越过距离门（far 仍非纯色）/ run 目录为空 |
| `Test-GateUniformRecompute` | 主色占比 0.970 ≥ 0.95 | 有结构图 0.800 < 0.95 / 图缺失 / 隔行 PNG（复算器返回 `$null` 不猜） |
| `Test-IdempotentManifest` | 两次 sha256 相等 | sha256 漂移 / sha256 缺失 |
| `Test-EvidenceComplete` | overall green 且证据在场 | overall red / `evidence.json` 缺失 |
| `Test-ObservationTeReads` | 族名条目齐且 sha256 非空 | 无 `te.*` 条目 / 族名前缀逐字不符 / sha256 为空 |
| `Test-ObservationCameras` | 3 机位摘要齐 | 机位数不符 + 名字/顺序不符 + `resolution` 不符 |
| `Get-PngDominantColorRatio` | — | 合成纯色图 ratio=1、杂色图 ratio<1；真判据产物（a1 轮现场 `far.png`）读数与判据引擎**逐位一致**（0.064926） |

**离线还做了这些（都不起客户端）**：

| 自检 | 结果 |
|---|---|
| 两个用例 × 仓内**真实** `CaseValidator`（`core/` 全量 `javac` + gson 2.2.4，临时 main，口径同 §9.6） | 均 `VALID`：`lp-pipe-row` 18 判据 / 2 机位 / 变体 `applicable=true`；`ae2-parts` 20 判据 / 3 机位 / 变体 `applicable=true`；唯一 warning 是「cameras 段非空 ⇒ 需 forensic」（预期） |
| 同法回归 §3.2/§9.2 的两个既有用例 | `smoke-basic`（4 判据）与 `smoke-shots`（8 判据、3 机位）仍 `VALID`，变体 `applicable=true` |
| 四个 `.ps1` 解析（`[Parser]::ParseFile`） | `run-anchor.ps1` 7777 token / `anchor-checks.ps1` 3096 / `run-anchor-selftest.ps1` 2397 / `run-shots.ps1` 8500 / `run-smoke.ps1` 5714，**均 0 错误** |
| `run-anchor.ps1 -ChecksOnly` | 5 条断言全绿、退出 0（含「复算器能读现场截图」：0.064926） |
| `run-anchor-selftest.ps1` | 29 条自检全绿、退出 0 |
| `run-anchor.ps1` 的 C1/C3~C7 | **未离线复核**：它们必须由真机轮次产生 run 目录后才能断言；首次验收由调度者执行 |

### 10.8 已知留白与实现/契约不一致（需要实现侧裁决）

1. **LP 相邻管的 `connections` 不是「几何对称」推出来的**。真机首轮实测（`cp_lp_pipe_row` 四格场景）：
   `@64` 的 `/connections/EAST=true`、`NORTH/SOUTH/DOWN/UP=false`、`WEST=false`；而 `@65` 是
   `EAST=true` **且 `WEST=true`**——即「西边是它刚连上的 `@64`」也报连接，于是
   **`WEST=false` 不能由「`@65` 西侧是入口管（本该只有东侧出）」推出来**。首轮用例曾按对称性写了
   `te-x2-pair-west`（`@65 /connections/WEST` 期望 `false`）⇒ 该判据如实判红，这是**用例假设错、不是实现错**；
   已改为可复算的三条（`te-x1-iso-west`=`@64 /connections/WEST` false、`te-x2-pair-east`=`@65 EAST` true、
   `te-x3-*`=`@66` 的两侧）。
   留白在于**这份连接表的权威语义**：`LogisticsTileGenericPipe.computeConnections()`
   （`LogisticsTileGenericPipe.java:867-893`）逐面写 `canPipeConnect(...)`，而
   `CoreRoutedPipe.canPipeConnect`（`CoreRoutedPipe.java:1085-1091`）先过
   `isSideBlocked`（同文件 `:1094`，内含 `getUpgradeManager().isSideDisconnected(side)` 与
   `getRouter().isSideDisconneceted(side)`）再回落 `transport.canPipeConnect`。
   「单机、无物流网络、两侧都是基础物流管」时这几层的合取结果就是实测值；
   若后续要用例断言更强的连接拓扑（如「入口管不该西接」），需要把这份语义写进契约或由实现侧给出
   「哪些面在何种网络状态下必然不连」的口径——目前契约（case-file.md §5）只说 `te-state-equals`
   读的是「TE 描述器的运行期字段」，没说这些字段该满足什么不变式。
2. **`world-hash-equals` 的「首建哈希」是取本轮 build 段产物还是存档内清单，由实现决定**（case-file.md §8.7
   允许两种口径）。`cases/lp-pipe-row.json` 的 `world-hash-equals` 在真机轮次里为绿，说明当前实现是
   「以本轮 build 产物为准」；若将来改成「读存档内清单」，C5b 的清单 sha256 相等判定仍然成立
   （两次 run 的 `world/scene-manifest.json` 逐字节一致），但 C5c 会更依赖实现口径，届时需复看。
3. **`minecraft:chest` 的 `meta` 会被世界改写（0 → 3）**。真机轮次的 `scene-manifest.json` 里
   `mismatches` 有一条：`{"pos":[67,12,64],"kind":"block","requested":{"id":"minecraft:chest","meta":0},
   "actual":{"meta":3}}`。箱子的朝向由相邻方块推导，用例声明的 `meta:0` 不是最终值；
   这不影响幂等（两次重建都得到 3）与连接判据（箱子作为 `IInventory` 仍被 LP 管连上），
   但**它是一条 block 步的 mismatch 留痕**——是否需要给「世界会自动改写的方块属性」留一条白名单，
   属实现/契约口径问题（`SceneBuilder.placeBlock` 目前把「请求值≠实际值」一律记 mismatch）。
4. **AE2 伪装板（`params.facades[]`）在本用例里刻意不用**。补全器的 facade 分支要求该物品能被
   `PartPlacement.isFacade` 认领，而 AE2 的 `ItemFacade.createPartFromItemStack`
   （`items/parts/ItemFacade.java:158-164`）走 `getTextureItem(is)` → 需要物品带 **NBT**（`data.getIntArray("x")`）
   才认；`params.facades[].item` 只有注册名 + meta 两个字段（`Ae2PartCompleter.stack()`），**表达不了 NBT**。
   因此「AE2 伪装板」这条锚点在当前参数形态下不可达——要么给 `facades[]` 加 NBT 字段（契约 §5 增量可容许），
   要么改用 BuildCraft 伪装板（整合包未必启用）。本用例覆盖「中心缆 + 两个部件」与「缆+箱」两种形态，
   伪装板留白待裁决。
5. ~~`image-uniform` 阈值与 far 机位构图~~（**已解决并回填**，本条留档）：旧 far 机位（`[105.5,13.5,64.5]`
   pitch 40 fov 70）的画面被天空渐变+云占满，主色占比实测 0.132668——**宽 fov 下天空渐变使
   `image-uniform` 指标不可用**（验收轮 a1 的 6 红真因：判据指标选型错，不是门失效；读图证实 41 格外
   缆+箱仍渲染为一个黑点 ⇒ AE2 缆走 ISBRH 不受 TESR 门管）。K1 器具已改为「原版箱子 64 格 TESR 门
   + 望远镜窄 fov 双机位」（见 §10.3 的 K1 门控原理段）：`gate-near` 实测主色 0.757580（箱在）、
   `far` 实测 **1.000000（colors=1）**（箱失）⇒ 阈值定 0.95（「实测 − 余量」口径）。玩家隐藏已由
   PR-2 收尾的 doRender cancel 解决，far 图不再有玩家点。
6. **`-ChecksOnly` 不产客户端产物，因此不写 `lightning.cfg`**。它的归档里没有 `stale/`、`lightning.cfg.*`、
   客户端日志，只有 `probe-png/`、`summary.md`、`assertions.json`、`session.json` 与 `events.jsonl`（若在）。
   这条分界是刻意的：离线检查不该有副作用。

## 11. 读面验收（`cases/read-surface.json` + `run-read-surface.ps1`，v1.3 / #98）

> 契约出处：contract.md §4.1（观察面读面动作：`read.*` 八动作、哈希口径、只读/失败/产物纪律）、
> §8.5/§8.6（失败显式、产物显式）；case-file.md §3.1（`read` 段语义与校验口径）、§5（读面输出的判据引用）。
> 前置、启用通道、端口、`caller.mjs` 用法与退出码**与 §2/§3.1 完全一致**，本节不重复。

### 11.1 `run-read-surface.ps1` 用法

```powershell
pwsh -File scripts/control-plane/run-read-surface.ps1 -SkipClientStart  # 连已获批的客户端（本脚本不启停客户端）
pwsh -File scripts/control-plane/run-read-surface.ps1 -EvidenceDir <dir> -ActionTimeoutMs 240000
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `-McDataDir` | `mod/gtnh/run/client` | mcDataDir（`server.json`/`tokens.json` 的发现根） |
| `-EvidenceDir` | `<repo>/../temp/cp-read/evidence` | 证据落点（每次调用的 `--json-out`、自述 dump、红绿表） |
| `-CaseFile` | `cases/read-surface.json` | B2 用的读面用例 |
| `-ActionTimeoutMs` | `180000` | 单次动作的总超时（`caller.mjs`），会下传给支持它的动作 |

**本脚本不启停客户端**（与 `run-smoke.ps1`/`run-shots.ps1` 的差异）：读面验收需要在**两种世界状态**下测——
在世界里（B1/B2/R）与**不在世界里**（D4 的部分条目）。启停由人/调度者按独占串行纪律安排，
脚本只在其间做调用与断言。因此没有 `-SkipClientStart`/`-KeepClient` 这种开关。

### 11.2 断言集

| id | 断言 | 红意味着 |
|---|---|---|
| P1/P2/P3 | `server.json` 的 `port>0`、`contractVersion=1.3`、`tokens.json` 存在 | 控制面没起、或跑的是旧契约版本 |
| D1.0/1.1/1.2 | `GET /cp/v1/actions` 返回可解析 JSON；`count≥19`；`contractVersion=1.3` | 自述端点不可用或动作目录不全 |
| D1 `read.*` ×8 | 逐动作：`description`/`returns`/`since`/`examples`（≥1 且是对象）非空，`tier=observe`、`writable=false`，逐参数 `name`/`type`/`description`/`required` 齐备 | 自描述缺项（需求书 §8.1：没有自描述的动作视为不存在） |
| D3 ×11 | 逐参数核对 `default` 机读可见且与实现取值一致 | 默认行为只能靠猜（§8.3） |
| W1/W2 | `world.rebuild` 退出码 0；返回 `scene.sha256` 非空 | 起不了干净世界，后续断言无意义 |
| B1.0/B1.99 | `read.blocks` 在**全部读面调用前后**各读一次同一区域，两次 `sha256` 相等 | **读面有副作用**（B1 的判据本体） |
| B1 ×12 | 12 个读面调用（覆盖 8 动作 × 各自形态）逐个退出码 0 | 读面不可用 |
| B1.100 | 存档内 `scene-manifest.json` 的 `sha256` == `world.rebuild` 返回值 | 读面改动了清单（或重建不幂等） |
| D4.1..D4.23 | 逐条失败场景：非 0 退出、作业 `failed`、**错误码命中**、`context` 非空 | 失败不显式（§8.5 空转绿）。含 2 条**调用方侧拒绝**（空参数/未知动作）——它们测的是「自述是否足以让调用方在发请求前拦住误用」 |
| R1 | 从 `read.blocks` 自报的 `hashInput` 手工复算 canonical 文本的 sha256，必须等于它自报的 `sha256` | 哈希不可复算（口径漂移） |
| R2 | 按**场景清单的位置集合**从读面读数取 `blocks` + 清单自己的 `tileEntities`，组装哈希子集算 sha256，必须等于清单自报的 `sha256` | 与 `world.rebuild` 场景清单**不可互算**（需求书 §5 的读面条目原文） |
| B2.1..B2.5 | `case.run` 退出码 0；`overall=green`；判据全绿且覆盖全部声明；runId 有；run 目录已归档 | 读面输出进不了判据（§10 B2） |

**退出码**：`0` 全绿；`2` 有断言红。**注意本脚本不起客户端**，故没有「端口不在听」的退出码 4 分支。

### 11.3 `cases/read-surface.json`

- `world`：`folder=cp_read_surface`、`seed=20261007`、`void=true`、`base=[64,12,64]`、`settleTicks=60`；
- `build`：清场 → 2×`minecraft:stone` + 1×`minecraft:planks:2` + 1×`minecraft:chest`(+`te` vanilla) → `wait 20`；
- `read`：**7 步**（`read.blocks` / `read.te` / `read.block` / `read.player` / `read.overview` / `read.run` /
  `read.diff`），各落 `read/<name>.json` 并带 `role`；
- `criteria`：**25 条**，其中 **20 条**直接引用读面产物（`json-field` 指针指到 `/volume`、`/airCount`、
  `/tiles/0/tile/class`、`/tiles/1/claimedFamily`（`expect:null`）、`/block/render/isTesr`、
  `/block/harvest/*`、`/weather/raining`、`/different`、`/hashes/equal`、`/expectSource` 等）；
- `variants`：**4 个负对照**，每个都把某条读面判据的 `expect` 翻错，`expectCriteriaRed` 指向它。
  **四个全都必须变红**——这是「读面判据不是恒绿」的机械证明（实测：4/4 `allExpectedRed=true`）；
- `evidence.expect`：10 项（含 7 个读面产物）。

**为什么读面判据不新增判据类型**：读面要服务的是「读得全、读得准」，不是再造一套断言词汇。
读数进判据走既有的 `json-field` + RFC 6901 指针，一处定义、一处求值（契约 §4.1 与 case-file.md §5 同口径）。
`expect: null` 两条专测「显式缺席可断言」——它们的存在依赖于 `Json.toJson` 打开 `serializeNulls()`
（见 §11.5 第 1 条）。

### 11.4 读面验收的两种世界状态（D4 的分工）

| 状态 | 覆盖 | 落点 |
|---|---|---|
| **在世界里** | B1（只读性）、R（哈希）、B2（读面进判据）、D4 中的参数/容器/TE 类失败 | `run-read-surface.ps1` 全量 |
| **不在世界里**（客户端停在主菜单） | 「无世界」失败：8 个读面动作全部 `CP-STATE-001` + `context{hint,worldLoaded:false}`；`read.run` **仍然成功**（产物在磁盘上，与世界无关——这是刻意设计，不是漏判） | 需人工把客户端留在主菜单时另跑（见 §11.5 第 3 条） |

### 11.5 实测擒获的缺陷与实现/契约口径（v1.3 轮次）

1. **`Json.toJson` 默认丢弃显式 `null` 成员（已修）**。Gson 的 `serializeNulls` 默认关闭，
   于是 `TeDescriber` 纪律要求的「缺席写显式 `null`」在**落盘后整个键消失**：
   内存里判据看得见的「显式缺席」在产物里变成「键不存在」。实测症状是
   `read/te.json` 里 `claimedFamily`/`families[].state` 两个键凭空不见，`json-field` 指针报「未命中」。
   修法：`Json.GSON`/`GSON_PRETTY` 一律 `.serializeNulls()`。
   **影响面**：`canonical()` 是手写序列化器、本来就输出 `null`，故**哈希口径不受影响**
   （实测 R1/R2 在本改动前后都通过）。这属既有缺陷（`te-state-equals` 判据的 `expect:null` 断言
   在拿**产物**比对时会踩到，拿**运行期状态**比对时不会），本单连带修掉并加锁两条 `expect:null` 判据。
2. **`ArtifactStore.loadFromDisk` 不读回 `caseId`/`jobSeq`/`createdAt`（已修）**。
   manifest 里本来写着它们，但磁盘还原路径只填 `artifacts`，于是重启后枚举历史 run 时
   `caseId` 全是 null——「按 caseId 发现某个 run」对**已完成**的 run 全部失效，而恰恰那些才是要事后核对的。
   `read.run` 的 `caseId` 过滤器因此在本单里被实测暴露（`caseId` 过滤返回 0 条）。已修并加单测断言。
3. **动作执行期失败是「作业 failed」（HTTP 200 + 作业体），不是 HTTP 4xx**。
   契约口径如此（`CoreEndpoints.submitAction` 只对**运行期权限升格**特判回 403）。
   因此 D4 断言的是 `exitCode=2` + `jobState=failed` + `error.code` + `context` 非空，
   **不**断言 `httpStatus`——按 HTTP 状态码写会造出一条恒假断言（本单首轮实测踩过：22 条 D4 全红，
   红因是断言写错而不是实现有问题）。
4. **`read.blocks` 的 `from`/`to` 在自述里**不**标 `required`**，但运行期必填。
   理由与 `world.rebuild` 的既有处置逐字相同（`ActionRegistrar` 里的注释）：让「服务端的逐字段参数校验」
   在负测试里可观测，而不是一律被 `caller.mjs` 按自述提前拦掉。自述的 `description` 明写
   「运行期必填，缺失报 CP-VALID-002」。**这一处的取舍需要调度者认可**：
   调用的代价是「自述不能表达『必填』」，收益是「负测试能打到服务端校验」。
   两条负测试都保留了：`D4.1`（服务端判定）与 `D4.23`（调用方按自述拦截未知动作）。
5. **`read.run` 是第 8 个动作（超出任务单字面的 7 类读面）**。它的存在理由是任务单原文
   「截图读面已有 `shot.multi`，不重建，**但要确认其产物入 run 清单**」——确认需要一个**可调用的枚举读**
   （`GET /cp/v1/artifacts/{runId}` 只回答单 run；逐 run 手工 curl 不算设施）。
   它同时服务需求书 §8.6「产物显式 + 可通过清单端点发现与核对」。实测它确认了
   `shot.multi` 的 `shots/*.png` + `shots/*.meta.json` 确实以 `role=shot`/`shot-meta` 登记，
   且 `missingFiles=0`/`sizeMismatch=0`（清单与磁盘一致）。
   **若调度者判为越界，可整动作删除**（一个文件 + 一段注册 + 两条判据，无耦合）。
6. **未覆盖项：容器/背包里「有物品的槽位」**。本轮实测覆盖了空槽、不存在容器、非容器 TE、
   末影箱、光标槽，但**没有一个槽里真的装着 ItemStack**——因为把物品放进容器需要 L0 写原语
   （`#99` 的「背包与容器写入」），当前不存在。因此 `readSlot` 的 `id/meta/count/maxStackSize/
   damage/maxDamage/displayName/nbt` 这条**非空分支**只经代码审查与单测（NBT 摘要机制本身已由
   `read.te` 的真实箱子 NBT 充分覆盖：复合 + 列表 + 字符串 + int 四种类型都在返回值里）。
   **本条是真实的能力边界，不是「已验收」**：`#99` 落地后应补一条「写入 → 逐槽读回」的实测。
## 12. 流体注入验收（`cases/tank-fill-live.json` + `run-tank-fill.ps1`，v1.7 / #122）

### 12.1 用法

```powershell
# 连已获批的客户端（本脚本不启停客户端）
pwsh -File scripts/control-plane/run-tank-fill.ps1                 # 只跑离线可做的 D1/D3
pwsh -File scripts/control-plane/run-tank-fill.ps1 -InWorld        # 加跑 A（正向+读回）与 N（负对照）
pwsh -File scripts/control-plane/run-tank-fill.ps1 -InWorld -EvidenceDir <dir> -ActionTimeoutMs 240000
```

参数：`-MachineAt`（默认 `65,12,65`）、`-Fluid`（默认 `HydrochloricAcid`）、`-Amount`（默认 3000）。

### 12.2 断言集

| 组 | 条数 | 说明 |
|---|---|---|
| D1 | 12 | 自述完备：name/tier/since/description/returns/逐参数四要素/示例可复制；**returns 必须点出 `partial` 与 `dryRunFillable`**（这两个字段是「部分注入如实报告」与「零注入原因区分」的机读落点） |
| D3 | 7 | 默认与边界值机读可见：`side` 默认 `UP`、`amount` 上界 1000000、`amount`/`fluid` **无**默认值（漏写必须显式失败） |
| D4 | 12 | 失败显式：缺 confirm / 缺 amount / 缺 fluid / 未知流体 / 未知面 / 量 0·负·非整数·超界 / at 形态非法 / 2 条调用方侧拒绝 |
| A | 11 | 正向：`filled==amount`、`complete && !partial`、`layer:"L0"`+`semantics:"fill"`、逐罐读数==filled、**`read.te` 读回量与 `filled` 一致**（验收判据一）、容量 16000、非空壳 |
| N | 3 | 负对照：非容器位置 `CP-STATE-001`、超容量**部分注入如实报告**（`partial:true`，不是错误）、部分注入后恰好满 |

### 12.3 D4 的两种失败形状（**两种都合格**，别只认一种）

本脚本首版只认「执行期失败」，把 `CP-CONFIRM-001` 误判成红。契约 §3 的既有口径是**两种形状**：

1. **提交期拒绝**：HTTP 4xx + `error.code` + `context`——请求根本没变成作业。
   实测：缺 `confirm` → HTTP 400 `CP-CONFIRM-001`，`context={action,tier,requiredField}`。
2. **执行期失败**：HTTP 200 + 作业 `state=failed` + 非 0 退出 + `error.code` + `context`
   ——动作跑起来之后的前置/参数类错误（`CoreEndpoints` 只对运行期权限升格特判回 403）。
   实测：缺 `amount` / 未知流体 / 未知面 / 量越界 → `state=failed` + `CP-VALID-002`。

判据是「错误码命中 + `context` 非空 + 确实是失败」，**不是**「HTTP 一定是 200」或「一定是作业体」。

### 12.4 世界内断言的前置

`-InWorld` 会先跑一次 `world.rebuild`（`folder=cp_tank122_script`，含 `te` 步放机器）——
满足 hermetic 纪律（第一次世界写动作必须是 `world.rebuild`）。故本脚本**会改世界**，
不要在别人的验收世界中途跑它。

### 12.5 实测记录（2026-10-07，v1.7）

| 组 | 结果 |
|---|---|
| D1 / D3 / D4 / A / N | **46 条全绿**（`通过 46，失败 0`），退出码 0 |
| `case.run tank-fill-live`（整跑） | `overall=green`，8 条判据全绿，0 红 0 error |
| `case.run` + `variant=neg-setblock-shell` | `variantVerification.ok=true`——3 条期望判据全红（`shell` true / `metaTileId` 0 / `metaTileCapacity` null），`world-hash-equals` 仍绿（哈希对空壳盲，负对照只能靠描述器） |

### 12.6 读数口径（读错会造出假绿，实机证伪后成文）

| 想断言什么 | 该读哪里 | **不要**读哪里 |
|---|---|---|
| 注入了多少 | `/tanks/tanks/<i>/amount`（逐罐，输入侧的权威读数） | ~~`/tanks/fluid`~~ |
| 储罐容量 | `/tanks/metaTileCapacity`（MTE 的 `mTankCapacity`，LV 化学反应釜 = 16000） | ~~方块实体的 `getCapacity()`~~（那是 **EU 容量 2048**） |
| 产物流体 | `/tanks/tanks/<i>/fluid`（输出罐）或 `/tanks/drainableFluid` | — |

`/tanks/drainableFluid`/`drainableFluidAmount` 指的是「输出/可排出」那一侧（`MTEBasicMachine.getDrainableStack() → mFluidOut`）：
入口注 HCl 3000 后它是 `null`/`0`，配方跑完后才变成 `trichlorosilane`/`1000`。
**拿它断言「注入成功」会把 0 误读成「没注进去」**——这是 #122 实机第二轮踩到的坑（见
`temp/cp-tank-fill/live-verify-plan.md` §5-D2）。

**「注入后读回 == 注入量」这条断言有时序敏感性（#122 独立复核成文，2026-10-07）**：若机器已具备起跑条件
（输入物品 + 足量电量），GT 会在**配方启动那一 tick** 按 `MTEBasicMachine.checkRecipe` 的
`isRecipeInputEqual(true, …)`（consume=true）把**物品与流体输入一次性扣掉**，此后 `read.te` 读到 `0`、
`drainableFluid` 仍是 `null`——**这不是注入失败**。因此：

- 要断言「注入了多少」，请在**机器未起跑时**读 `/tanks/tanks/<i>/amount`，或直接读 `fill` 返回值里的
  `after.tanks[<i>].amount`（注入当刻的读数，与配方是否起跑无关）；
- 决定性对照（实机做过）：重建世界 → **只注 3000 mB、不投任何物品/电池** → 12 s 内 4 次读回恒为
  `hydrochloricacid_gt5u@3000`、`metaTileCapacity=16000`、`running=false` ⇒ **读路径不分叉**，
  读到 0 只可能是配方已把它消耗掉；
- 判据「注入是否真的发生」应取 **`fill.after` + 服务端侧配方结果**（进度/产物），而不是事后单点读罐。
## 13. 导出族验收（v1.7 / #102，「收口T5」）

> 契约： [`docs/control-plane/contract.md`](../../docs/control-plane/contract.md) §4.7（导出族动作）、
> [`docs/contracts/format-scene-file.md`](../../docs/contracts/format-scene-file.md)（场景文件格式契约）、
> [`docs/control-plane/dual-channel-consistency.md`](../../docs/control-plane/dual-channel-consistency.md)（D2 口径）。
> 上游：#96 §6.1/§10 C 族与 D2、#102 裁决 5/6/7 与补充裁决 X-11。

### 13.1 最小实验（先行，证伪一条推断）

`migration-design.md` §6 末段要求：在铺开搬迁之前，用最小实验证伪一次
「**扫描 + 烘焙可在同一 cp 动作内完成**」这条推断——它的依据只是「cp 动作跑在 Client thread」
与 `MeshCaptureService` 的 `@SideOnly(CLIENT)` 标注，是**推断**而非事实。

```powershell
node scripts/control-plane/export-minimal-experiment.mjs --json-out <证据目录>\E1E2.json
```

它分两步：**E1** 经 `export.session` 读回命令通道（服务端线程）设的选区/帧号——证明跨线程可见；
**E2** 调一次 `export.scene`，读回产物并断言每帧 `geometryPhase=baked`、根级 `blockPalette` 非空、
scan 专有字段（`cellTypes`/`worldGrid`）已清理。

> **判据位置的实测更正**：World 形态下 `blockPalette` 被 `liftBlockPaletteToRoot` **提到根级**，
> 帧内**必然没有** `blockPalette`（那是 Structure 形态的形态）。第一版脚本断言「帧内有 blockPalette」
> 从而误判——**断言必须对准形态契约**（`format-scene-file.md` §2.3），不能凭直觉。

### 13.2 一次跑全（C1..C6 + D2/D3/D5）

```powershell
node scripts/control-plane/export-acceptance.mjs --out <证据目录>
```

| 判据 | 做法 |
|---|---|
| C1 | 产物经 `GET /cp/v1/artifacts/{runId}/{path}` 下载后喂给 **web 侧真实解析器**（见 §13.3） |
| C2 | 逐帧录 N≥3（每帧先改世界状态）后导出，逐帧哈希与 `export.session.frameSha256` 配对比对；另断言改过状态的帧内容两两不同 |
| C3 | 正例：全部帧 `exportId` 一致、`provenance` 在位；**负例**：跨次动作追加一帧后用 `expectFrames` 声明原帧集 ⇒ 必须 `CP-STATE-001` |
| C4 | `case.run` 的 `export` 段（v1.6）：导出件 + 实拍 + 观测记录 + 世界清单**同一 run** |
| C5 | 逐份下载核对清单 `sha256`；断言清单内路径全是 run 相对路径 |
| C6 | `maxFrames` 超限 ⇒ `CP-VALID-002` + `context.fields` + `computed`，且 `bufferGeneration` 不变（不写爆、不动缓冲） |
| D2 | `export.scene` vs `cmd.exec {/sde export}`：形态一致 + 语义子树哈希一致（见 §13.4） |
| D3 | 三个新动作的关键参数默认值在自述里可见；`since ≤ contractVersion` |
| D5 | `/sde web` 经 `cmd.exec` 被拒（带 `alternatives`）；动作命名空间封闭 |

### 13.3 单份场景文件检查器（C1 的机械判据）

```powershell
node scripts/control-plane/export-check.mjs <file.json> --session-json <export.session 快照> `
     --expect-shape world --expect-frames 0,1,2,9 --json-out <证据>\C1-web-parser.json
```

**它不自己实现解析器**：用 esbuild 现场把 `web/src/` 的真实模块捆成临时 ESM（不改 `web/` 下任何文件），
跑既有消费方的真实入口链：`readEnvelopeLayers` → **`normalizeEnvelopeToPlain`** → `WorldParser.detect/parse`
→ `RuntimeDocument`。

> **两个实测教训（都写进脚本注释）**：
> 1. **不能直接对 `inner` 调 `WorldParser.detect`**：Envelope 的 `id`/`label`/`playback` 在 **meta 里**，
>    inner 只有体数据，而 `detect` 要求 `typeof d.id === 'string'` ⇒ 必然 false。
>    正解是既有消费方的真实路径 `normalizeEnvelopeToPlain`（把 meta 折进根）。
> 2. **判据只看 `webConsumerOk`，不能看子进程退出码**：该检查器内部还会跑 C2/C3 断言，
>    它非零退出不代表「解析不了这份文件」（第一版驱动就因此把 C1 误判成红）。

### 13.4 D2 双通道对照

```powershell
node scripts/control-plane/export-d2-compare.mjs <命令通道产物> <API 通道产物> --label export `
     --json-out <证据>\D2-compare.json --byte-ok
node scripts/control-plane/export-d2-twins.mjs --out <证据目录>
```

- **`export`**：`export-acceptance.mjs` 已覆盖（D2-3a 形态 / D2-3b 语义子树哈希 / D2-3e 字节「仅记录、不作判据」）。
- **`dump`**：`export-d2-twins.mjs` 比三份注册表的**内容**——两侧共用
  `ExportBundleClient.writeFullRegistryDump`，且产物**不含**路径/时间戳 ⇒ **可逐字节比**（实测一致）。
- **`multiblock`**：两侧共用 `MultiblockExportRunner.run`，但 `/sde multiblock` 是**异步长跑**
  （`cmd.exec` 拿不到字节），且这条管线有**上游前置** `multiblock_scan/run-NNNN/machines.json`。
  缺前置时本脚本把判据转为「前置缺失是否被**显式且可执行**地报出来」（`CP-STATE-001` +
  `context.expected/scanDir/hint`）——这本身就是 C6 口径在「缺前提」上的落地。

> **为什么 D2 不做字节比对**（除 `dump` 这类逐字节幂等产物外）：gzip 头含 MTIME，且 cp 通道多了
> `provenance`/`exportId`（C3 判据字段）。**拿字节相等当判据会把搬迁误判成不一致。**
> 口径 = 解 Envelope → 取 inner → **剔除** `provenance`/`exportId` → 语义子树规范化 JSON 的 sha256。

### 13.5 三个必须知道的实机口径（本单踩出来的）

1. **`/sde pos1|pos2` 的坐标只来自服务端玩家实体**（没有坐标参数）⇒ 想构造任意 AABB，
   唯一手段是先用 `scene.player.pose` 把玩家摆到角点。回报里的坐标是 `floor(玩家坐标)`
   并标注「脚下方块」⇒ 要以 `(a,b,c)` 为选区角，玩家站在 `(a+0.5, b+1, c+0.5)`。
   **回报用的是全角括号** `（513, 6, -647，脚下方块）` —— 半角正则匹配不到（踩过）。
2. **`player.place_block` 受触达距离约束（约 4.5 格）**，且**动作 ok + `read.block`（客户端侧）看得到**
   **≠ 服务端世界真的有**：服务端在 `NetHandlerPlayServer` 侧拒绝时，`/sde record`（服务端扫描）
   依旧扫出全空气。**唯一可信的判据是服务端侧产物**（导出件里的 `cellGrid`/`blockPalette`）。
   正解 = 每次放置前把玩家摆到目标格正上方（目标格 = 脚下一格，距离 1）。
3. **命令通道产物要「延迟登记」才拿到终态**（见 §13.6）。

### 13.6 命令通道产物的延迟登记（`CommandArtifactRegistrar`）

`cmd.exec` 是**同步动作**，但它两条产物链在命令返回时都**还不是终态**：

| 链路 | 为什么不是终态 | 终态的机械判据 |
|---|---|---|
| `/sde export` | 服务端线程先写 `geometryPhase=scan` 中间态并投包，客户端**下一个 tick** 才覆盖为 `baked`+Envelope | JSON 里出现 `documentFormat`（Envelope/Plain/Raw） |
| `/sde dump` | 三份注册表由**客户端 tick** 写出 | 投递单已消费 **且** 三份文件都在 |

**不能靠「在动作里 sleep 等」**：`cmd.exec` 跑在**客户端 tick 线程**，而那正是唯一能推进这两件事的线程
——在动作里阻塞 = 掐死推进者 ⇒ **构造性死锁**（第一版就是这么写的，实测表现为「等待客户端写出注册表超时」）。
正解 = 排进 `CommandArtifactRegistrar` 队列并立即返回（结果里如实写 `deferred:true`），
由 `ControlPlaneTickHandler` 每 tick 推进，成为终态后复制进 run + 登记 sha256 + 补写 manifest。
超时则**如实登记当时的字节**并附 `phase` 说明（不静默成功、不假装是终态）；登记事件落 `cp-export` 流水。

> **这一条把 D2 从「比不了」变成「比得了」**：延迟登记之前，命令通道登记下来的是 scan 半成品
> （实测 `geometryPhase=scan` + `cellTypes`/`worldGrid`），与 cp 通道的 baked 产物**本就不同形态**
> ⇒ D2 必然判红且红得没有意义。登记终态后两侧语义子树哈希**实测相等**。

## 14. 已知留白（#102 如实登记）

1. **`export.multiblock` 实机未验**：本机没有 `multiblock_scan/run-*/machines.json`（T1.2 的产物），
   而跑那轮枚举扫描是遍历 221 台的分钟级长跑，未在本单执行。因此它的**产物形态与幂等性（A3）未经实机验证**；
   已验证的是：注册正确、自述完备、缺前置时**显式可执行**地报 `CP-STATE-001`
   （`context.expected/scanDir/hint` 三件齐），以及命令通道侧如实声明未登记。
2. **工作台 `ExportsListPanel` 看不到 cp 产物**：它读 `structure_exports/`，而 cp 通道按裁决 6
   只写 run 目录。C1 的验收方式相应为「经 `GET /cp/v1/artifacts/{runId}/{path}` 下载后喂给解析器」。
   老路径的删除归 **#104**。
3. **`/sde dump` 的 `pending_dump.json` 仍在老路径**：内存投递单优先把它重定向到 run 目录，
   但服务端线程写的那份老文件仍会落地（命令通道既有行为）。删它归 #104。
4. **`web/node_modules` 是 C1 证据的前置**：本树冷启动时缺失，须先 `cd web; npm ci`。
   脚本已把「缺失」降级为 C1 的 **warning + `webConsumerOk=null`**（不假装解析通过，也不静默当绿）。

## 15. 输入手段族实机验收（`input.*` / `run-input-acceptance.ps1`，v1.8 / #160 族）

> 本节是**只在末尾追加**的一节；上面的 1..14 节一字未动。
> 契约正文在 `docs/control-plane/input-contract.md`（§2 输入表示 / §3 生命周期 / §5 能力发现 /
> §6 错误语义 / §9.2 G1 扩展），逐参数一律以 `GET /cp/v1/actions` 的自描述为唯一权威。

### 15.1 三个文件 + 一份用例（职责分离）

| 文件 | 职责 | 不含什么 |
|---|---|---|
| `input-acceptance-checks.ps1` | **纯判定模块**：一条判据一个函数，输入是「作业 JSON / 错误信封 / 读面 JSON / 描述符 JSON」，输出 `@{id;ok;status;detail}`（`status` = `pass`/`fail`/`skipped`/`blocked`） | 无 HTTP、无进程、不读文件、不归档、不打印 |
| `run-input-acceptance.ps1` | **编排**：写 cfg → 钉 `pauseOnLostFocus` → 起客户端 → 等 `server.json` → 按 stage 调 `caller.mjs` → 归档 → 红绿表 → 退出码 | 不自己判红绿（判定全在被 dot-source 的模块里） |
| `run-input-acceptance-selftest.ps1` | **离线自检**：合成夹具逐条喂判定模块（好数据绿 / 坏数据精确红） | 不起客户端、不发 HTTP |
| `cases/input-multitick.json` | G1 的跨帧输入固定程序（`action` 段含顶层 `holdTicks` 的输入步） | 当前**预期被拒**（G1 未实现）⇒ 判据记 `blocked-by-G1` |

> **`extra` 段（E1/E2/E3）不新增入库用例**：E2 的 300 步填充用例由驱动**现场生成在归档目录**
> （`<ArchiveRoot>\input-<ts>\cases\e2-queue-fill.json`），避免仓里出现巨型用例；它随归档一并留证
> （见 §15.8）。

一切动作调用**只**经 `caller.mjs`（退出码 0/1/2/3；消费 `--json-out` 文件，不解析 stdout）。
端口**不猜**：先读 `<mcDataDir>\controlplane\server.json` 的 `port`；`-Port` 只用于点火前的占用检查。

### 15.2 用法

```powershell
# ① 复用已在跑的客户端（需先按窗口纪律获批；不启停、不改 cfg）
pwsh -File scripts/control-plane/run-input-acceptance.ps1 -SkipClientStart -Port 23314

# ② 自己起停客户端（会写 cfg 并备份原值，跑完还原/归档）
pwsh -File scripts/control-plane/run-input-acceptance.ps1 -Port 23314

# ③ 只重跑某一段（pre 会先跑：它是门）
pwsh -File scripts/control-plane/run-input-acceptance.ps1 -Stage world -Port 23314
pwsh -File scripts/control-plane/run-input-acceptance.ps1 -Stage g1    -Port 23314

# ④ 离线自检（不需要客户端）
pwsh -File scripts/control-plane/run-input-acceptance-selftest.ps1

# ⑤ extra 段（E1/E2/E3；先跑 pre，再复用 world 段的世界重建流程）
pwsh -File scripts/control-plane/run-input-acceptance.ps1 -Stage extra -Port 23314

# ⑥ 单条重跑（-Only 只对 -Stage extra 有效；pre 与世界准备仍会先跑）
pwsh -File scripts/control-plane/run-input-acceptance.ps1 -Stage extra -Only E2 -Port 23314
```

参数（与既有两个驱动的既有命名惯例一致）：

| 参数 | 默认 | 语义 |
|---|---|---|
| `-McDataDir` | `<repo>\mod\gtnh\run\client` | mcDataDir（含 `controlplane/`、`config/`、`options.txt`） |
| `-SkipClientStart` | 关 | 复用已在跑的客户端：不写 cfg、不起进程、不停进程（**钉选项仍执行**） |
| `-KeepClient` | 关 | 跑完不停客户端（保留现场） |
| `-Port` | 23314 | **仅**前置占用检查；实调一律以 `server.json` 为准 |
| `-ClientReadyTimeoutMin` | 8 | 等 `server.json` / `tokens.json` 的上限（分钟） |
| `-Stage` | `all` | `all`/`pre`/`menu`/`world`/`g1`/`extra`；除 `pre` 外每个 stage 都**先跑 pre**。`all` **不含** `extra`（保持既有行为逐条不变） |
| `-Only` | 空 | `E1`/`E2`/`E3` 子集；**只对 `-Stage extra` 有效**（别的 stage 传它 ⇒ 退出码 4）。空 = 三条全跑 |
| `-E1HoldTicks` | 60 | E1 两个测量窗口各持续多少 tick（对照一段、潜行一段） |
| `-E1SettleTicks` | 30 | E1 相位间静置 tick 数（虚空 + 创造飞行，松开键后仍会滑行；不静置会把上一段余速算进下一段） |
| `-E2FillSteps` | 300 | E2 的填充步数（必须 ≫ 键盘队列容量 256） |
| `-E2SettleTicks` | 40 | E2 投递前静置 tick 数（让 E1 留下的飞行余速衰减，否则「零写入」会被余速撞红） |
| `-ArchiveRoot` | `D:\Workspace\Lightning\temp\control-plane` | 归档根；本次落 `<ArchiveRoot>\input-<ts>\` |
| `-ActionTimeoutMs` | 600000 | 单次调用（含 `case.run` / `world.rebuild` / `shot.multi`）的 sync 超时 |
| `-ClientTimeoutMin` | 30 | 进入客户端之后的整段流水线墙钟预算（分钟）；W4 的等待轮与 G1 都受它约束 |
| `-PumpProofTicks` | 1300 | W4 的等待 tick 数（必须 ≥ 持键上限 1200） |
| `-CaseFile` | `cases\input-multitick.json` | G1 用的用例（绝对路径） |
| `-RepoRoot` | `scripts\control-plane\..\..` | 仓根覆盖（自检/异位调用用） |

**点火前置（缺一不可，脚本自己会做前两件）**：① `web/node_modules` 存在（`runClient` 依赖 `syncWeb→vite`）；
② 调 `drive-session.ps1 -RunDir <mcDataDir> -Tag input -PinOnly` 钉 `options.txt` 的
`pauseOnLostFocus:false`（**必须先钉再启动**：MC 只在启动时读 `options.txt`）；
③ `runClient` 是独占资源，用前按 `AGENTS.md` 的四步窗口纪律申请。

### 15.3 断言表（id → 读什么 → 通过条件；红了说明什么）

**stage `pre`（前置；任一红 ⇒ 立即退出 2 且不进后续 stage）**

| id | 读什么 | 通过条件（红了说明什么） |
|---|---|---|
| `P0` | `<mcDataDir>\options.txt` 全文 | **恰有一行** `pauseOnLostFocus:false`（缺失/为 true/两行冲突/空文件都红）。这是「无人值守失焦仍持续 tick」的**前置证明** |
| `P1` | `server.json` | `contractVersion == "1.8"`（客户端起的是旧契约 ⇒ 后面所有输入族断言都不成立） |
| `P2` | `caller.mjs --actions` | `count == 48`；五个 `input.*` 都在；`input.key/mouse/text/release` 的 `tier=scene`、`writable=true`、`confirmRequired=true`、`since=1.8`、`means=input`；`input.state` 的 `tier=observe`、`writable=false`、`since=1.8`、`means=input` |
| `P3` | 同上（G8 实机面） | 除五个 `input.*` 外，其余 **43** 个动作的自描述 JSON 里**不含 `means` 键**（可选字段不许用默认值冒充「已声明」） |

**stage `menu`（主菜单，无世界；不做任何世界断言）**

| id | 读什么 | 通过条件（红了说明什么） |
|---|---|---|
| `M0` | `core.status.world.loaded` | 前提守卫（**驱动自加**，非 Lead 判据）：`loaded != true`。已进世界时菜单段断言不可比 |
| `M1` | `input.key{down}` 的 `result` | exit 0、`delivered==1`、`held.count==1`、`held.items[0].jobId` 非空 |
| `M2` | 紧接着同一条 `down` | exit 0、`alreadyHeld==true`、`delivered==0`（**重投即红**）、`held.count` 仍为 1 |
| `M3` | 两次 `input.release` | 第一次 `count>=1`；第二次 `count==0` 且 `alreadyIdle==true`（幂等不是错误） |
| `M4` | `input.key{tap,holdTicks:1}` | exit 0、`delivered==2`（同 tick down+up） |
| `M5` | `input.key{tap,holdTicks:5}` | exit 0、`delivered==2`、`heldTicks>=5`（`autoReleased[].heldTicks`，退到 `released[]`）；两者都读不到 ⇒ 红（跨帧持有量不可复核） |
| `M6` | `input.mouse{wheel,amount:1}` | exit 0、`delivered==1` |
| `M7` | `input.mouse{wheel,amount:0}` | **非 0 退出 且 `error.code=="CP-VALID-002"`**（零档不许当 no-op 绿） |
| `M8` | `input.key{tap,holdTicks:1201}` | 非 0 且 `CP-VALID-002`（持有上限 1200） |
| `M9` | `input.key{down,holdTicks:3}` | 非 0 且 `CP-VALID-002`（不适用字段必须显式拒绝，不许静默忽略） |
| `M10` | `input.text{text:"hi"}` | 非 0 且 `CP-STATE-001`（文本路由两路未打通 ⇒ 不许 `delivered:N` 的假绿） |
| `M11` | `input.state` 的 `result` | exit 0；`implemented==true`；`family=="input"`；`actions` **恰为**五个 `input.*`；`keyCatalog` 非空且「键位名→整数键码」；`keyCodeRange` 是 `[0,255]` 这类**真实整数区间**（null/占位/长度不为 2 即红）；`queues.mouseDepth=="unobservable"`（不许编 0）；`held.count==0` |
| `M12` | 两次 `input.state.coordinates` 指纹 | 会话内**无法**改变窗口尺寸 ⇒ `skipped-with-reason`（**不是 pass**，summary 写明「需要人工改窗口尺寸才能测」）；若指纹确有变化 ⇒ pass |

**stage `world`（`world.rebuild` 建托管世界 `cp_input_live`，`void:true`）**

| id | 读什么 | 通过条件（红了说明什么） |
|---|---|---|
| `W1` | `core.status` | `world.loaded==true` 且 `world.managed==true`（`cp_` 前缀的托管世界） |
| `W2` | `input.key{tap,holdTicks:20}` | exit 0、`delivered==2`；`consumer.displayActive` / `inGameHasFocus` **存在且是布尔**（**不要求为 true**——失焦是无人值守的常态；`null` 表示探针不可读 ⇒ 不「如实」） |
| `W3` | `read.player.pos` A/B | `horizontalDistance(A,B) > 0.5`（键真的让玩家动起来了；**W4 的正对照，必须先过**） |
| `W4` | `read.player.pos` A/B/C | `dist(A,B) > 0.5` **且** `dist(B,C) < 0.1`；两个位移都写进 detail。**等待期间只调 `read.player`**（任何 `input.*` 调用都会先结算到期，会让「泵抬起的」与「读的时候才抬起的」不可区分） |
| `W4.evidence` | 等待期间的 `core.status.world.totalTime` 增量 | `>= PumpProofTicks`（**驱动自加的证据充分性门**：等得不够时 `dist(B,C)` 小只能说明玩家因别的原因停下 ⇒ 防假绿） |
| `W5` | `input.mouse{op:move}` 的 `readback` | exit 0、`withinTolerance==true`、且 `guiX/guiY` 与请求值差 ≤1（坐标取 `input.state.coordinates.scaledWidth/Height` 中点） |
| `W6a` | 拖动四步（move→down→move→up） | 四条都 exit 0 |
| `W6b` | `down` 的 `result` | `hitSet.state` 是**真值**（字段缺席 / 空串 / `unimplemented`/`placeholder`/`未实现` 一类占位都红） |
| `W7a` | `shot.multi --describe` | 自描述里**声明**了 `gui` 参数且取值域说明含 `screen`（没声明 ⇒ 无先验知识调用方**开不了** GUI 实拍） |
| `W7b` | 带 `gui:"screen"` 的 `shot.multi` | 每机位 `guiHidden==false` 且 `guiCapture` 非空数组（正路径前会先 `player.gui inventory` 开一个真界面，免得「拍了但没有界面」也算绿） |
| `W7c` | **不带** `gui` 的 `shot.multi` | 每机位 `guiHidden==true` 且**不含** `guiCapture` 键（默认路径逐字节不变） |
| `W8a` | `input.key` 两键 down 后的结果 | 键盘侧 `physicalConcurrent` 是**布尔**（`"unobservable"` 一类字符串即红） |
| `W8b` | `input.mouse{wheel}` 的结果 | 鼠标侧 `physicalConcurrent == "unobservable"`（不许编造 false/true） |

**stage `g1`（依赖 `feat/cp-input-steps` 的合入）**

| id | 读什么 | 通过条件（红了说明什么） |
|---|---|---|
| `G1` | `case.validate` + `case.run{"segments":["world","action"]}` + 步骤产物 + 跑后 `input.state.held.count` | exit 0；`action` 段里确有输入步产物且能读出**跨帧推进证据**（`heldTicks>=2` 或不同步骤的 `deliveredAtTick` 有别）；跑完 `held.count==0`（失败也不留按着的键）。**未实现时**（`case.validate` 报 `action[i].holdTicks 未知字段` 一类）⇒ `blocked-by-G1`（**不是 pass，也不是实现缺陷**）；因别的理由失败 ⇒ `fail` |

**stage `extra`（`-Stage extra`；pre → 托管世界重建 → E1 → E2 → E3，口径详见 §15.8）**

| id | 读什么 | 通过条件（红了说明什么） |
|---|---|---|
| `W1` | `core.status` | **前置复用**（判据函数与 world 段同一份，不是新增判据）：`world.loaded==true` 且 `world.managed==true` |
| `E1` | 两个相位的 `read.player` 位置 + 窗口 tick 增量 | `潜行/对照 < 0.6`（每 tick 水平位移），**且** 对照 ≥ 0.02 blocks/tick（对照不成立 ⇒ 红：只按前进也没动起来时不许判绿）。detail 带两侧位移、tick、每 tick 值与比值 |
| `E1.readback` | 保持期间的 `input.state.held.items[]` | 两个键都在持键表里且条目带 `gameBindingPressed` 字段；回读值 true/false/null 一律**如实**进 detail（null 不判红，字段整个缺席才红） |
| `E2` | `case.validate` + 单作业 `case.run`（300 步）+ 步骤产物的 `queueDepthAfter`/`deliveredAtTick` + 投递前后 `read.player`/`core.status` | 三态：命中 `CP-STATE-001` **且**排除易变字段后逐路径零差异 ⇒ `pass`；实测深度已达容量却仍投递成功 / 填充用例因别的错误码失败 / 填充键位被占用 ⇒ `fail`；**单作业内构造不出触发条件** ⇒ `blocked`（附最大深度、单 tick 投递率、机制出处），**绝不算 pass** |
| `E3` | `shot.multi{gui:"screen"}` 的 `runId` + `GET /cp/v1/artifacts/{runId}` 清单 + 逐份下载复算 | 清单里能发现 `shots/<name>.png` 与 `shots/<name>.meta.json`，且**逐份**字节 sha256/bytes 与清单声明一致 ⇒ `pass`；发现不到、清单未声明 sha256（**未覆盖**）、下载失败、有产物没复核 ⇒ `fail` |

**驱动自加的编排守卫**（`O.*`，不是 Lead 的判据，只为把「编排失败」与「判据红」分开）：
`O.ping`（`core.ping` 可连）、`O.actions`（`GET /actions` 可读）、`O.rebuild`（`world.rebuild` 成功）、
`O.gui-open`（`player.gui inventory` 成功）、`O.g1-validate`（`case.validate` 通过）、
`O.e3-gui-open`（extra 段为 GUI 实拍开界面，成功与否不作判据）、
`O.orchestration`（编排异常）。

### 15.4 退出码与「非全绿」的口径

| 码 | 含义 |
|---|---|
| `0` | 全绿（**只有** pass） |
| `2` | 有断言红；**或**有 `skipped` / `blocked`（跳过与阻塞都不算 pass） |
| `3` | 管线级致命：等 `server.json` 超时 / 客户端进程早退 |
| `4` | 前置检查或编排自身失败（缺 `gradlew`/`node`/`web/node_modules`/`caseFile`、端口被占、钉选项失败、`server.json` 不可读…） |

`pre` 段任一红 ⇒ **立即**退出 2，后续 stage 一步都不跑（表里只有跑过的判据；未跑的 stage 的判据
**不出现在表里**，既不算 skip 也不算 pass）。

### 15.5 归档（`<ArchiveRoot>\input-<ts>\`）

```
input-<ts>/
  runs/<runId>/               每次调用新增的 run 目录（world.rebuild/case.run/shot.multi…全量复制）
  runs-all/                   仅当定位不到单个 run 目录时的兜底整目录复制
  logs/caller-*.json          每次 caller.mjs 的 --json-out（机读作业 JSON / 错误信封）
  logs/gradle-runClient.log   .err 客户端启动日志
  logs/fml-client-latest.log  客户端日志
  events.jsonl                控制面事件流水
  lightning.cfg.before/.after cfg 备份与跑后快照（`-SkipClientStart` 时只有 .after）
  options.txt.after           钉选项后的 options.txt 快照
  stale/                      点火前移开的上轮 server.json / tokens.json
  assertions.json             机读判定表（含 status/ok/detail、counts、probeNotes）
  summary.md                  人读：红绿表 + 每条 detail 里的可复核量 + 已知留白
  cases/e2-queue-fill.json    **仅 extra 段**：现场生成的 E2 填充用例（300 步；不入库，随归档留证）
  e3/e3-manifest.json         **仅 extra 段**：GET /cp/v1/artifacts/{runId} 的清单原文
  e3/e3-sha256-report.json|md **仅 extra 段**：逐份「清单声明 vs 下载复算」比对表
  e3/downloads/*              **仅 extra 段**：逐份下载下来的产物字节（已改名展平）
  e3/e3-manifest.error.txt    **仅 extra 段**：清单拉取失败时的原始错误（失败时才有）
```

> `temp/` 随时会被删除。**要留的证据（红绿表、作业 JSON、客户端日志）必须当场作为 ISSUE/PR 附件上 Gitea**
> ——归档只是便于当场排查，不等于留证（`AGENTS.md` 铁律 5）。

### 15.6 离线自检（本节的自检表）

| # | 自检项 | 命令 | 判定 |
|---|---|---|---|
| 1 | 两个（三个）`.ps1` 语法 | `pwsh -Command "[System.Management.Automation.Language.Parser]::ParseFile(<脚本>, [ref]$null, [ref]$e)"` | 解析错误 0（逐文件） |
| 2 | 调用方未受影响 | `node --check scripts/control-plane/caller.mjs` | 退出 0（本单未改 `caller.mjs`） |
| 3 | 判据函数的合成夹具自检 | `pwsh -File scripts/control-plane/run-input-acceptance-selftest.ps1` | **131 条自检 0 红**：好数据绿、坏数据精确红（重投 / M7-M9 三类参数负对照 / M10 假绿 / W4 两种失败形态 / `means` 泄漏 / 能力面空目录 / 命中集占位 / G1 的 blocked 分支 / **E1 潜行无效负对照 / E2 的 blocked·fail·pass 三分支与填充键位门 / E3 的哈希不符负对照与「未声明 sha256」**） |
| 4 | G1 用例的真实校验器校验 | 见下 | 当前**预期红**：`CP-VALID-002`「`action[0].holdTicks` 未知字段」——这正是 `blocked-by-G1` 的离线证据 |

第 4 项的做法（用例校验器是 Java，PowerShell 侧没有等价实现）：加一个**一次性**测试
`mod/gtnh/src/test/java/com/lightning/mod/client/controlplane/core/TmpInputMultitickCaseValidateTest.java`
把 `CaseValidator.validate` 的结论落成 JSON 到 `D:\Workspace\Lightning\temp\cp-input-acceptance\case-validate.json`，跑

```powershell
cd mod\gtnh; .\gradlew.bat test --tests '*TmpInputMultitickCaseValidateTest*' --console=plain
pwsh -File scripts/control-plane/run-input-acceptance-selftest.ps1   # 会把该报告并入自检报告（不作判据）
```

**该临时测试提交前必须删除**（不许把临时校验件留在树里）；`run-input-acceptance-selftest.ps1` 只把
它的报告当**附注**并入（`不作判据`），删掉它之后第 3 项仍然全绿。

### 15.7 已知留白（如实登记）

1. **M12 需要人工参与**：脚本无法改窗口尺寸，会话内两次 `coordinates` 指纹相同 ⇒ 记
   `skipped-with-reason`，summary 会写「需要人工改窗口尺寸才能测」。人工改窗口后重跑 world 段即转 pass。
2. **W4 的等待口径**：等待循环内**只**发 `read.player`（严格口径）；tick 记账用**轮边界**的一次
   `core.status.world.totalTime`（它不触碰输入运行时，不会顺带结算到期）。等待有墙钟预算
   （名义 5 倍：`tick × 0.25s`，下限 30s，且不超过 `-ClientTimeoutMin`）——预算只兜住
   「客户端根本没 tick」这类病态，不参与判据。`W4.evidence` 用的是
   **真实世界 tick 增量**——比实现里 `McInputHost.clientTick()` 的「max(被驱动 tick, 墙钟折算)」
   更严格（墙钟兜底会**提前**收口），因此它是防假绿而不是放宽。
3. **`input.state.actions` 的实机真值未经本单验证**：静态读源码发现
   `InputStateProviderImpl.assemble` 用**本包内**的 `actionsJson(implemented)`（恒空数组），
   而 `InputCapabilities.registeredActionsJson()`（T3-A 新增）**没有生产调用点** ⇒ 若实机如此，`M11` 会红。
   本单只写驱动、不改 mod 代码，故**如实保留该判据**（红了就是红的）。
4. **`W6b`、`W7a` 同理**：静态读源码发现 `input.mouse op=down` 的返回里没有 `hitSet` 字段
   （只有 `op=move` 有），而 `shot.multi` 的自描述**未声明** `gui` 参数（`ShotMultiAction` 却读它）⇒
   两条判据当前预期红。驱动**不放宽**它们，只在 `W7b` 旁附一条 `--allow-unknown-params` 的
   **非判据探针**，如实记录底层实现能不能画 GUI。
5. **未离线验证的部分**：所有真机断言（`M*`/`W*`/`G1` 的取值）都只能实机跑出来；本单只证明
   「判定逻辑在好/坏数据上红绿正确」与「编排能起停、能归档、能给退出码」。
6. **`-Stage menu` 的前提**：需要客户端停在主菜单。若 `-SkipClientStart` 复用的客户端已在世界里，
   `M0` 会红并且 M 段结论不可比（此时应改用 `-Stage world`）。

### 15.8 `extra` 段：E1 / E2 / E3（#160 的三条残余判据）

> 三条判据的**判定函数**都在 `input-acceptance-checks.ps1`（纯函数、无 IO），编排在
> `run-input-acceptance.ps1` 的 `extra` 段。**编排里不内联任何判定**。
> `-Stage extra` 的语义：`pre` → **托管世界重建**（与 `world` 段**同一个函数** `Invoke-ManagedWorldRebuild`，
> 同一 folder/seed/void/base/settleTicks、同一 `O.rebuild` 守卫，不另起一套）→ `E1` → `E2` → `E3`。
> `-Only E1|E2|E3` 可单条重跑（`pre` 与世界准备仍会先跑；别的 stage 传 `-Only` ⇒ 退出码 4）。
> **`-Stage all` 不含 `extra`**：`all` 的既有行为（pre→menu→world→g1）逐条不变，需要 extra 就显式给。

#### 15.8.1 E1：组合键（潜行修饰）被世界链按序消费

程序（同一段流水线，非同一个 HTTP 作业——`input.key down` 立即完成且**刻意保留持键**，
位置采样必须用别的作业，这是动作面的既定形状）：

```
input.release（卫生）→ 静置 E1SettleTicks
对照相位：input.key{key.forward,down} → core.status(tick0) → read.player(A) → 等 E1HoldTicks →
          read.player(B) → core.status(tick1) → input.release
静置 E1SettleTicks（消掉对照相位的飞行余速）
潜行相位：input.key{key.sneak,down} → input.key{key.forward,down} → core.status(tick0) →
          read.player(A) → input.state（取 gameBindingPressed 回读）→ 等 E1HoldTicks →
          read.player(B) → core.status(tick1) → input.state → 两键 up（先 sneak 后 forward）→ input.release
```

**通过口径**（`E1`）：`每 tick 水平位移(潜行) / 每 tick 水平位移(对照) < 0.6`，
且 `每 tick 位移(对照) >= 0.02` blocks/tick。前者是「显著低于」，后者是**对照成立性门**
（只按前进也没动起来时，位移比没有意义 ⇒ 红，不许因为「两边都没动」判绿）。

- 下限取 0.02 的理由：MC 步行约 0.21 blocks/tick、创造飞行更高，0.02（= 1.2 blocks / 60 tick 窗口）
  只用来把「键根本没生效（位移 ≈ 0）」排除掉，远低于任何真实移动速率 ⇒ 不会制造假红。

- 阈值 0.6 的来历：MC 的潜行把移动**输入**乘 0.3（`MovementInputFromOptions.updatePlayerMoveState`），
  0.6 是「显著低于」的判界，**不是**把 0.3 放宽到 0.6；两侧实测值都写进 detail。
- tick 口径：位置窗口取 `[读 A 前的 core.status.world.totalTime, 读 B 后的 core.status.world.totalTime]`，
  **窗口含两次读数各自的 tick 开销**（各约 1 tick），两侧同形 ⇒ 比值不受影响；等待轮内的实测增量
  另记进 summary 的说明行（`Wait-ClientTicks` 的 `tickDelta`）。
- **负对照**：只注入 `key.forward`（不加 `key.sneak`）就是上面那个对照相位。工具本身这条恒真；
  真正被证明的是「判据函数在『潜行无效』的构造数据上会红」——由 §15.6 的离线自检完成
  （比值 0.99 / 恰在 0.60 判界上 / 对照不动，三条都断言 `fail`）。
- **诚实纪律**：实机若发现潜行**确实没有**让位移下降，`E1` 就是**红**；detail 里带两侧位移、tick 数、
  每 tick 值与比值，供 Lead 定性。**禁止**把期望改成「无差别也算过」。

**`E1.readback`**：保持期间的 `input.state` 里，`key.sneak` 与 `key.forward` 都必须出现在
`held.items[]`，且每条都带 `gameBindingPressed` 字段（字段名实读：`InputStateProviderImpl.java:601`；
动作结果面的同名回读在 `InputRuntimeImpl.java:1160`）。回读值 `true`/`false`/`null` 一律**如实**写进
detail —— `null` 是「探针读不到」的如实结果，不判红；**字段整个缺席**才红（§3.6 第 4 条要求回读）。

#### 15.8.2 E2：队列满 ⇒ `CP-STATE-001` 且零写入

**机制调查结论**（逐条带出处，静态读源码 + lwjgl3ify 源码）：

| 问题 | 结论 | 出处 |
|---|---|---|
| 是哪一条队列 | LWJGL（lwjgl3ify）的**键盘事件队列** `org.lwjglx.input.Keyboard.eventQueue`；注入入口是 §1.2 白名单里的 `Keyboard.addRawKeyEvent` | `Lwjgl3ifyInjector.java:298-315`；`D:\github\gtnh\lwjgl3ify\src\main\java\org\lwjglx\input\Keyboard.java:195/240` |
| 容量从哪来 | `new ArrayBlockingQueue<>(256)`；设施侧常量 `KEYBOARD_QUEUE_CAPACITY = 256`（运行期**读不到**容量：`eventQueue` 不是定长数组 ⇒ 探针回退契约常量并标注来源） | `Keyboard.java:195`；`InputCapabilities.java:59`；`InputRuntimeProbe.java:271-285`；`InputStateProviderImpl.java:443-452` |
| 深度基线 | 静态块往队列里塞了 **1 条 seed 事件**，且 `Keyboard.next()` 只在 `size() > 1` 时移除 ⇒ 深度基线恒为 1 | `Keyboard.java:228`、`Keyboard.java:318-320`；`InputCapabilities.java:68` |
| 满时行为 | **两段式**：① 投递前**整请求原子拒绝**——`depthBefore + 本请求键盘事件数 > capacity` ⇒ 该请求所有事件逐条记 `Rejected(i, CP-STATE-001)`，一条都不投（`InputRuntimeImpl.java:336-362`）；② 若预检过了但中途注入失败 ⇒ 整条请求失败、已投递部分如实给出 `delivered`，不假装成功（`:378-392`） | `InputRuntimeImpl.java:348-362` |
| 底层队列满会怎样 | **静默丢弃**：`addRawKeyEvent` 把 `eventQueue.add(...)` 包在 `catch (IllegalStateException ignored) {}` 里 ⇒ 注入面**不会**抛错给设施，这正是设施必须先探深度的原因 | `Keyboard.java:254-256` |
| 已入队事件会不会被消费 | 会。MC 每 tick 的 `runTickKeyboard` 用 `Keyboard.next()` 轮询排空（`next` 只在 `size()>1` 时 remove，保留 seed 哨兵）；设施自己的记账也按「本 tick 的 runTick 已消费上一批」归零 | `Keyboard.java:314-346`；`InputRuntimeImpl.java:258-269` |
| 单作业最多能投几条 | `JobQueue` 严格互斥、每 tick 只 `drainOne()` 一次；`input.key`/`input.mouse` 每次只投**一条**；`case.run` 的编排段虽然能在单作业内跑输入步，但驱动**每个输入步至少占一个 tick**（`advanceInternal` 在输入步完成后就 `return null` 让出本 tick） | `JobQueue.java:79-104/115-192`；`ControlPlaneTickHandler.java:80-82`；`InputKeyAction.java:257/266`；`CaseRunAction.java:1158-1191` |
| 有没有批量入口 | 只有 `input.text`（把整串字符作为事件列表交给 `deliver`），但它在投递**之前**就被能力门拦成 `CP-STATE-001`（路由未就绪）⇒ 那条 `CP-STATE-001` 不是「队列满」 | `InputTextAction.java:75-92/121`；`InputCapabilities.TEXT_SUPPORTED` |

**探针构造**：驱动先读 `input.state.keyCatalog`（运行期键位注册表实读，`InputRuntimeProbe.java:434-455`、
`McInputHost.java:165-187`），在 `1..254` 里取**第一个不在其取值集里**的键码作为填充键
（= 没有任何 `KeyBinding` 绑到它 ⇒ 事件即使被消费也不产生世界交互），然后**现场生成**
`cases/e2-queue-fill.json`：`E2FillSteps`（默认 300）步 `input.key{key:<未绑定码>, action:"up"}`。
用 `action:"up"` 是因为「抬起一个没按下的键」无害（`wasHeld:false`）且仍是写进队列的一条事件；
**不用** `key.forward` 这类会动玩家的键，也**不用**会开界面/丢物品/改选择槽的键。

**三态判定**（`E2`，全在纯函数里）：

1. 命中 `CP-STATE-001` ⇒ 再用**排除易变字段后的逐路径比对**验零写入；零差异 ⇒ `pass`，
   有差异（或观测面不完整）⇒ `fail`。
2. 没命中，但实测 `queueDepthAfter` 最大值已达容量 ⇒ `fail`（容量预检没生效，实现缺陷）。
3. 没命中，且填充用例因**别的**错误码失败 ⇒ `fail`（无法归因到队列满）。
4. 没命中，深度远低于容量、单 tick 投递率被 tick 限住 ⇒ **`blocked`**（附最大深度、单 tick 投递次数、
   `deliveredAtTick` 去重数、四条机制出处）。**这不是 pass**：`CP-STATE-001`「队列满」路径**未被覆盖**。

> **按上面的机制，第 4 条就是当前实机形态**（公开动作面上单作业最多每 tick 投一条，而 MC 每 tick 排空）
> —— 但**结论以实机实测为准**：驱动照跑 300 步，把实测最大深度写进 detail。若实机深度真的爬到 256，
> 就会走第 1 条（甚至第 2 条），判据随之变绿或变红，不需要改代码。

**「零写入」的比对口径**（**不是**整体 JSON 字符串相等）：取投递前的 `read.player` + `core.status`
与投递后的同一对读面，做**逐路径叶子比对**，并**显式排除**下列易变字段（排除清单与理由写进 `E2` 的 detail）：

| 排除的字段名 | 理由 |
|---|---|
| `totalTime` `worldTime` `gameTime` `dayTime` `tick` `time` | tick 计数/世界时刻：每 tick 自增，逐字比对必然不等 |
| `serverTime` `timestamp` `createdAt` `ts` `at` `uptimeMs` `elapsedMs` `nanoTime` | 墙钟/单调钟：前后两次读必然不同 |
| `memory` `heapUsed` `heapMax` `heapCommitted` `nonHeapUsed` `usedBytes` | JVM 内存读数：GC 自行变化，与「有没有写世界」无关 |
| `lastSeq` `buffered` `count` `counts` `recent` `recentRuns` `pending` `busy` `currentJobId` `currentAction` `probeActive` `probe` | 控制面自身记账：前后两次读面调用本身就在改变它们（不是世界写入） |
| `ping` `duration` | 与写入无关的易变读数：网络往返延迟 / 状态效果剩余时长每 tick 自减 |

被排除的**具体路径**逐条进 detail（例如 `/status/jobs/count（控制面自身记账…）`），可逐条复核；
`read.player` 的位置/生命/飞行态、`core.status.world.folder/loaded/managed` 等**不在排除清单里**，
任何变化都会被逐路径抓到。

#### 15.8.3 E3：产物可从既有清单发现并复核哈希

程序：`player.gui{inventory}`（让 `gui:screen` 有界面可画，仅编排守卫 `O.e3-gui-open`，不作判据）→
`shot.multi{cameras:[e3-gui], gui:"screen"}` → 取结果里的 `runId` → `player.gui{close}`（卫生）→
`GET /cp/v1/artifacts/{runId}`（端点与权限级实读：`CoreEndpoints.java:166` 注册、tier=`OBSERVE`；
条目形状 `{path,bytes,sha256,role}` 见 `ArtifactStore.java:74-79`）→
对清单里 `shots/<name>.png` 与 `shots/<name>.meta.json`（**不含** `shots/<name>.tiles/`）**逐份**
`GET /cp/v1/artifacts/{runId}/<path>` 下载字节、复算 sha256 与 bytes，与清单声明比对。

- **只读 HTTP 直连的理由**：`caller.mjs` 是**动作**调用方（按自描述构造 `POST /actions/{name}`），
  而产物清单/下载是 `GET` 只读端点、没有自描述可依；发现顺序与 `caller.mjs` 同源（先读 `server.json`
  的 `port`、再读 `tokens.json` 的 `observe` token，**不猜端口**）。
- `pass`：清单里能发现 PNG 与 meta，且**逐份**哈希与字节数全部一致（脚本另写
  `e3/e3-sha256-report.md` 的比对表 + `e3/e3-sha256-report.json` 的机读记录）。
- `fail`：发现不到 PNG / 发现不到 meta / **清单未声明 `sha256`（如实记「未覆盖」）** / 某份下载失败 /
  有产物没被复核 / 哈希或字节数不符。
- 证据位置：`<ArchiveRoot>\input-<ts>\e3\`（清单原文、错误文本、比对表、下载下来的原始字节）。

#### 15.8.4 本节的离线证据与**已知缺口**

离线自检（§15.6 第 3 项）覆盖：E1 的 6 条（含「潜行无效」「恰在判界」「对照不成立」三条负对照）、
`E1.readback` 的 5 条、E2 的 13 条（三态 + 填充键位门 5 条 + 比对口径 2 条）、E3 的 10 条
（含哈希不符 / 字节不符 / 未声明 sha256 / 未下载全 / tiles 不干扰），共 131 条 0 红（97 → 131）。

**如实登记的缺口**：

1. **E1 的「潜行是否真的让位移下降」只能实机跑出来**。静态面能证明的只有：`input.key` 的事件序进的是
   同一条队列、`KeyBinding` 状态由事件驱动（`world` 段的 `W3` 早已证明 `key.forward` 能推动玩家）。
   潜行系数 0.3 出自 MC 的 `MovementInputFromOptions.updatePlayerMoveState`，但**本工作区里没有
   Minecraft 1.7.10 的反编译源码**（`D:\github\gtnh` 的 29 个仓里没有 `Minecraft`/`Forge`），
   因此这条没有 `file:line` 可引 —— 它是**知识**而不是本仓可核事实，已如实标注。
2. **E2 的「队列满」路径按机制不可达 ⇒ 记 `blocked`**（第 4 条分支）。这是**结论**，不是 pass，
   也不是实现缺陷：`CP-STATE-001` 的容量预检代码在位（`InputRuntimeImpl.java:348-362`），
   但公开动作面上没有能在单 tick 内投满 256 条的入口。
3. **E2 的填充用例未经 `CaseValidator` 离线校验**：`case.validate` 是控制面动作（要客户端）。
   驱动会在实机先跑 `case.validate`，未通过就走 `blocked` 分支（构造层结论）；
   离线侧只证明了生成形状（300 步、path 唯一、每步 1 条 `expect`、文件 73 KB < `CaseParser.MAX_FILE_BYTES`
   1 MiB、id 22 字符 < `MAX_ID_LENGTH` 64）。
4. **E3 的清单字段依赖实机形状**：离线已用替身端点验证「清单发现 → 逐份下载 → 复算 → 比对」全链路
   （含 {ok,data} 信封）；但 `shot.multi` 实机产出的 `shots/` 命名与 `sha256` 字段是否齐全，只能实机确认。
   **清单若不含 `sha256`，E3 如实记「未覆盖」并红**，不改口径。

