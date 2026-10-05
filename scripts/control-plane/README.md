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
| `run-anchor-selftest.ps1` | **PR-3** 离线行为自检：合成夹具跑 `anchor-checks.ps1` 的每条判定，验证好数据绿、坏数据精确红（见 §10.6） |

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

## 9. PR-2 取证拍摄验收（`cases/smoke-shots.json` + `run-shots.ps1`）

> 契约出处：[`contract.md`](../../docs/control-plane/contract.md) §4.1（`shot.multi`/`capture.*`/`CameraSpec`）、
> §4.2（相机与渲染规则）、[`case-file.md`](../../docs/control-plane/case-file.md) §4（`capture`/`cameras`）、
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
| B2d | `observation.playerPos` 与 `observation.camera.pos` 至少一轴相差 > 0.5 | 门控位置分离（contract §4.2.2）没落地：机位与玩家位置被写成同一个 |
| B2e | `observation.cameras[]` 数量与名字 == 用例声明 | 多机位摘要缺失或顺序错乱 |
| B3a/B3b/B3c/B3d | 变体单跑退出码 0；`result.variantVerification.ok=true`；变体 run 的 `criteria.json` 里 `expectCriteriaRed` 全 `red`；其余判据仍 `green` | 负对照恒绿（假绿，防不住错图）或变体求值跑偏 |
| B4a/B4b/B4c/B4d | `capture.begin` 退出码 0 → 会话期间 `world.rebuild` 非 0 且 `error.code=CP-STATE-001` → `capture.end` 退出码 0 且 `wasArmed=true` → 再 `world.rebuild` 退出码 0 且 `scene.sha256` 非空 | 捕获会话没封住世界写动作（取证期间世界仍在变），或会话泄漏（永久封死写动作） |
| B5 | 含 `cameras` 段的 `case.run` 用 `--tier scene --sync`：非 0 且 `httpStatus=403` + `error.code=CP-AUTH-002` | 按内容升格（contract §4.2.9）没生效：低权限调用方顺手拿到了取证截图 |
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
| `meta.json` 字段 `cameraHeldDuringRender`/`resolution`/`requestedResolution`/`tile{cols,rows,requestedCols,requestedRows,overlap}`/`lightingApplied` | 实现（`ShotExecutor.finishCamera`）；契约 §4.2.6 的 `lightingApplied:false` 留痕口径 |
| `tiles/` 单片命名 `r<row>c<col>.png`（1 起） | 实现（`ShotExecutor.tileName`）；契约只规定「逐片落盘可审计」 |
| 图像判据 `image-size-equals{path,width,height}`、`image-not-uniform{path,maxSameColorRatio?}` | case-file.md §5 |
| `observation.camera{...}`/`cameras[]`/`playerPos`（门控位置分离） | contract.md §4.2.2、observation-record.md §2.4 |
| 含 `cameras` 段的 `case.run` 按内容升格 → sync 得 HTTP 403 `CP-AUTH-002` | contract.md §4.2.9 |
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
   的正交机位，都会撞同一件事，值得在 contract §4.2 记一条「正交机位的 `image-not-uniform` 阈值按场景占比给」。
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
> `vanilla`/`lp-pipe`/`ae2-part`）、§4.2.1（AE2 电缆 30 方块渲染距离门）；case-file.md §5（`te-state-equals` /
> `image-uniform` 与**双轨判据口径**）、§8.7（清单哈希口径）。
> 前置、启用通道、端口、`caller.mjs` 用法与退出码**与 §2/§3.1 完全一致**，本节不重复。

### 10.1 `run-anchor.ps1` 用法

```powershell
pwsh -File scripts/control-plane/run-anchor.ps1                    # 全流程（申请到 runClient 后跑）
pwsh -File scripts/control-plane/run-anchor.ps1 -SkipClientStart   # 复用已在跑的客户端（不写配置、不停客户端）
pwsh -File scripts/control-plane/run-anchor.ps1 -KeepClient        # 跑完保留客户端现场
pwsh -File scripts/control-plane/run-anchor.ps1 -ChecksOnly        # 只跑离线检查（C2 + 复算器自检），不起客户端
pwsh -File scripts/control-plane/run-anchor.ps1 -LegacyJdk         # 退回 runClientSdePipeline（默认 runClient25）
pwsh -File scripts/control-plane/run-anchor-selftest.ps1           # 离线行为自检（合成夹具，见 §10.6）
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
反复喂坏数据（§10.6）。这与 §9.1 里「两个驱动各自复制公共函数」的取舍不冲突——那个取舍针对的是**归档/还原路径**
的耦合，本模块不含任何进程或归档逻辑。

### 10.2 `cases/lp-pipe-row.json`（LP 四管锚点）

- `world`：`folder=cp_lp_pipe_row`、`seed=20261006`、`void=true`、`base=[64,12,64]`、`settleTicks=60`；
- `build`：清场 `[62,10,62]..[70,16,68]` → **3 根 LP 基础物流管**（`64/65/66`，全用 `te` 步 `completer:"lp-pipe"`，
  物品注册名见 §10.5）→ `minecraft:chest`（`block` 步）+ `te` 步 `completer:"vanilla"` → `wait 20`；
  三种连接形态：`64` 裸管（四面皆空）、`65↔66` 两管互联、`66` 管+箱（东侧接箱子）；
- `capture`：`{lighting:"natural", renderMode:"本色", worldTime:6000}`；`cameras` 2 个 1280×720 透视机位
  （`persp-row` 斜视看三种连接形态、`persp-front` 正面平视，两者都取正 pitch=俯视，口径同 §9.2 的 yaw/pitch 算法）；
- `criteria`（18 条，`te-*` 8 条 + `img-*` 8 条 + `world-hash` + `observation-exists`）：

  | 目标 | 运行期轨（`te-state-equals`，id 前缀 `te-`） | 图像轨（id 前缀 `img-`） |
  |---|---|---|
  | `x1`（裸管） | `te-x1-iso-north`=`/connections/NORTH` false、`te-x1-iso-west`=`/connections/WEST` false、`te-x1-iso-init`=`/initialized` true | `img-x1-size` / `img-x1-not-uniform`（`persp-row.png` 1280×720 + 非纯色） |
  | `x2`（两管互联） | `te-x2-pair-east`=`@65 /connections/EAST` true | `img-x2-size` / `img-x2-not-uniform`（同上，互连的可见性） |
  | `x3`（管+箱） | `te-x3-pair-west`=`@66 /connections/WEST` true、`te-x3-chest-east`=`@66 /connections/EAST` true、`te-x3-down`=`@66 /connections/DOWN` false、`te-x3-pipe-type`=`@66 /pipeType` | `img-x3-size` / `img-x3-not-uniform`（同上） |
  | `scene` | —（由 x1..x3 覆盖；全场景可见性由图像轨单独承担） | `img-scene-size` / `img-scene-not-uniform`（`persp-front.png`，**`maxSameColorRatio=0.10`——决定性阈值**，见下方「图像轨阈值标定方法」） |

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
   集中在 `img-scene-not-uniform`**，不在每个配对判据上都假装有精度；
3. 每个锚点用例至少要有**一条**这种「贴近取景 + 决定性阈值」的判据。

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
  | `near` | `[70.5,15.5,69.5]` | perspective fov 70, 1280×720 | — | AE2 部件必被渲染 ⇒ `image-not-uniform` |
  | `ortho-top` | `[65.0,18.0,64.0]` pitch 90 | ortho orthoHeight 12, 1280×720 | — | 正交俯视的部件可见性；阈值按大范围小场景放宽（同 §9.7 留白 4） |
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

### 10.4 断言 C1..C7

| id | 断言 | 红意味着 |
|---|---|---|
| C1xx-a/b/c/d/e | 每用例：`case.run --tier forensic --sync` 退出码 0；`result.overall=green`；`shots.cameraCount` == 用例机位数且 `failedCount=0`；run 的 `criteria.json` 全绿且覆盖用例声明的**全部**判据 id；`evidence.json` overall=green 且期望证据 + 各机位 PNG 逐条在场 | 用例（含双轨判据/图像/证据）任一环不通过，或 run 产物自证不完整 |
| C2 | 两个用例文件里每个 `te-state-equals` 判据都有**同目标**的图像判据（§10.2 配对口径）；**不需要客户端** | 锚点用例双轨不齐（只证世界状态、没证渲染结果）——用例缺陷 |
| C3xx-a/b/c/d | 每用例：变体单跑退出码 0；`result.variantVerification.ok=true`；变体 run 的 `criteria.json` 里 `expectCriteriaRed` 全部变红；**其余判据仍绿** | 负对照恒绿（假绿，防不住错图/错状态）或变体求值跑偏（误伤其它判据） |
| C4a | ae2 run 的 `near.png`/`ortho-top.png` 非空且 `image-not-uniform` 判据绿（AE2 场景确实渲染出来了） | 场景没渲染出来（图缺失/空图/纯背景） |
| C4b | ae2 run 的 `far.png` 非空且 `image-uniform`（+ 尺寸判据）绿（门外机位确实看不见门控箱）；`gate-near.png` 非空且 `image-not-uniform` 绿（门内机位确实看见——K1 的决定性两半：玩家恒在门内，门若随玩家则两图皆有箱） | TESR 距离门没随相机生效：箱在门外仍被渲染，或门内也不渲染（K1 门控失效/器具摆错） |
| C4c | **独立复算** `far.png` 的主色占比 ≥ 判据的 `minSameColorRatio`（自己解 PNG：IDAT→inflate→逐行反滤波→数众数像素） | 与判据同口径但不共用实现；判据绿而这里红 ⇒ 判据实现可疑（反之亦然） |
| C5a/a2/b/c | lp-pipe-row 连跑两次（两个 runId）：两次都退出码 0 + overall green；两次 `world/scene-manifest.json` 的 `sha256` 相等；两次 run 的 `world-hash-equals` 判据均绿 | 场景重建不幂等（世界漂移）——见 §10.7 留白 2 的已知边界 |
| C6xx | 两用例 run 的 `evidence.json` overall=green 且期望证据逐条在场（含机位 PNG） | 证据清单缺项（截图或记账文件没落盘） |
| C7xx（×2） | 两用例 run 的 `observation.json`：`runtimeReads` 里存在 key 以 **`te.lp-pipe[`** / **`te.ae2-part[`** 开头的条目（族名逐字口径）且其 `sha256` 非空；`observation.cameras` 数量/顺序/名字与用例一致且每项含 `pos`/`projection`/`resolution` | 运行期轨没有留痕（观测记录离线不可解释），或机位摘要缺失/串位 |

**退出码**：`0` 全绿；`2` 有断言红；`3` 管线级致命（`server.json` 超时 / 客户端早退）；`4` 前置检查或编排自身失败。
**归 port 口径、参数名自适应（`P1`/`P2`/`P3`）与 `run-shots.ps1` 相同**。

### 10.5 注册名来源（源码实证——用例里每个字符串都可核对）

| 用例里的字符串 | 出处（源码行号） | 运行期实证 |
|---|---|---|
| `LogisticsPipes:item.PipeItemsBasicLogistics` | `LogisticsPipes.java:691-694`：`createPipe()` 里 `res.setUnlocalizedName(clas.getSimpleName())`；`LogisticsBlockGenericPipe.java:882-885`：`registerPipe()` 再 `setUnlocalizedName(clas.getSimpleName())` + `GameRegistry.registerItem(item, item.getUnlocalizedName())`；`@Mod(modid="LogisticsPipes")` 在 `LogisticsPipes.java:156` | 现场探针产物 `sde_lp_te_probe_result.json` 的 `registeredPipeItems` 读到 `"registry": "LogisticsPipes:item.PipeItemsBasicLogistics"`（`LpTeRoundTripAutomation` 走 `Item.itemRegistry.getNameForObject`） |
| `appliedenergistics2:item.ItemMultiPart` | `core/features/ItemFeatureHandler.java:67-71`：`name=="ItemPart"` → `name="ItemMultiPart"`，随后 `GameRegistry.registerItem(item, "item." + name)` | 探针产物 `PartsFamilyProviderProbe.java:182/213/230` 断言的 `typeKey` 字面量即 `appliedenergistics2:item.ItemMultiPart:<meta>` |
| `appliedenergistics2:tile.BlockCableBus` | `core/features/AECableBusFeatureHandler.java:60-72`：`registryName = "tile." + name` → `GameRegistry.registerBlock(featured, null, registryName)` | 同上（部件格宿主 registry 名） |
| 部件 `meta`：中心缆 16 / 切换总线 80 / 存储总线 220 | `items/parts/PartType.java:70`（`CableGlass(0, …)`，括号首参即 `baseDamage`）、`:111`（`ToggleBus(80, …)`）、`:126`（`StorageBus(220, …)`）；`ItemMultiPart.java:119`：`partDamage = mat.getBaseDamage() + varID`，`varID = AEColor.ordinal()`（`api/util/AEColor.java` 的常量声明序里 `Transparent` 在末位，ordinal 16 ⇒ 缆 `0+16=16`，总线/存储总线 varID=0 ⇒ meta 就是 `baseDamage`） | `PartsFamilyProviderProbe.java:182/213/230` 的三条字面量断言（真机跑过） |
| `PartCableGlass` / `PartToggleBus` / `PartStorageBus`（类名） | `items/parts/PartType.java` 的 import 段（`appeng.parts.networking.PartCableGlass`、`appeng.parts.misc.PartToggleBus`、`appeng.parts.misc.PartStorageBus`）与各枚举常量的构造参数 | 描述器输出 `partClasses`（本树真实客户端首轮已实测命中，见 §10.7 留白 1） |

**写法的两个坑（用例里刻意避开）**：

1. **LP 管物品名带 `item.` 段**。直觉写法 `LogisticsPipes:PipeItemsBasicLogistics` 会报 `CP-VALID-002`
   （`LpPipeCompleter.resolveItem` 走 `GameRegistry.findItem("LogisticsPipes","PipeItemsBasicLogistics")`
   查不到）——真实注册名是 `LogisticsPipes:item.PipeItemsBasicLogistics`（上面那行实证）。
2. **AE2 部件的物品身份含 meta**。`ModReflect.itemId(ItemStack)`（`:103-114`）在 meta≠0 时输出
   `modid:name@meta`，而 `LpPipeDescriber`/`Ae2PartDescriber` 的 `parts` 值走同一函数 ⇒ 断言非 0 meta 的
   部件必须写 `appliedenergistics2:item.ItemMultiPart@16` 这种形态（缆固定带 `@16`，总线/存储总线 meta 为 0
   不带后缀）。`partClasses` 是纯类名、与 meta 无关，适合断言「这一面装的是哪种部件」。

### 10.6 自检记录（离线，不含客户端实测）

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

### 10.7 已知留白与实现/契约不一致（需要实现侧裁决）

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
