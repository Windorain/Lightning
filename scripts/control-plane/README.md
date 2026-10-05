# scripts/control-plane —— 控制面脚本（PR-1）

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

脚本只做**编排与调用**：控制面本体在 `mod/gtnh/src/main/java/com/lightning/mod/client/controlplane/`。
脚本不直接 POST 裸请求——一切动作调用都经 `caller.mjs`（自描述驱动），便于审计「调用方是否真的读了自描述」。

## 2. 前置（硬约束，缺一不可）

1. **`web/node_modules` 必须存在**（`cd web; npm ci`）。`runClient` 依赖 `syncWeb→vite`，缺了它客户端起不来；
   `run-smoke.ps1` 把它作为前置检查，缺失即明确报错退出（不猜测、不自动安装）。
2. **端口**：控制面默认 **23057**（本树在 `.workspace/ports.json` 登记为 `control`）。
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
3. 未提供的选填参数按自描述的 `default` 补齐；
4. 参数名不在自描述里 → 本地报错（`--allow-unknown-params` 可直传）；
5. `confirm` 由**权限级**派生（`confirmRequired` / `tier` ∈ {scene, forensic}），不是动作私有知识；
6. 动作的知识（名称/参数/类型/必填/默认/权限级/是否需确认）**全部**来自 `GET /cp/v1/actions`；
   脚本里唯一的非自描述常量是契约级控制字段（`confirm`/`sync`/`timeoutMs`）与信封形态 `{ok,data|error}`。

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
