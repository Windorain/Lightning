# scripts/control-plane

本目录是控制面的外部入口：调用器、实机验收驱动、离线自检、产物检查与静态门禁。控制面本体在 `mod/gtnh/src/main/java/com/lightning/mod/client/controlplane/`，脚本只做编排、取证与判定。

契约权威：[contract.md](../../docs/control-plane/contract.md)（端点、鉴权、错误码、动作面、线程）、[case-file.md](../../docs/control-plane/case-file.md)（用例格式、判据、变体、证据、run 目录）、[observation-record.md](../../docs/control-plane/observation-record.md)（观测记录）、[input-contract.md](../../docs/control-plane/input-contract.md)（`input.*` 参数与能力）。动作与参数以运行期 `GET /cp/v1/actions` 的自描述为准。可重放用例资产在 [test/cases/](../../test/cases/README.md)。

## 1. 入口

| 文件 | 用途 | 退出码 |
|---|---|---|
| `caller.mjs` | 自描述驱动调用器：只凭 `GET /cp/v1/actions` 构造请求 | 见 §3 |
| `drive-session.ps1` | `-PinOnly` 钉 `pauseOnLostFocus=false` 并回读；不带该开关时是 F2 截图驱动循环（不抢焦点） | `-PinOnly` 成功 0 |
| `pin-preflight.ps1` | 点火前置 helper：调 `drive-session.ps1 -PinOnly`、回读证明，失败即 throw | 失败由调用方转致命（4） |
| `run-smoke.ps1` | 冒烟验收（冒烟用例整跑、按段与负对照变体） | 0/2/3/4 |
| `run-shots.ps1` | 取证拍摄验收（机位、图像判据、捕获会话封锁、权限升格） | 0/2/3/4 |
| `run-anchor.ps1` | LP / AE2 锚点验收；`-ChecksOnly` 只跑离线部分 | 0/2/3/4 |
| `anchor-checks.ps1` | 锚点纯判定模块（无 HTTP、无世界、无归档），被驱动与自检共用 | 由调用方消费 |
| `run-one-shot.ps1` | 一条命令：起客户端 → 跑用例 → 复核产物 → `core.shutdown` 退出 | 0/2/3/4 |
| `run-read-surface.ps1` | 读面验收：只读性、自描述、默认值、失败显式、哈希可复算 | 0/2 |
| `run-tank-fill.ps1` | 流体注入 `scene.tank.fill` 验收 | 0/2 |
| `run-input-acceptance.ps1` | 输入手段族 `input.*` 实机验收（分段、可单条重跑） | 0/2/3/4 |
| `input-acceptance-checks.ps1` | 输入族纯判定模块（一条判据一个函数） | 由调用方消费 |
| `run-static-gates.ps1` | mod 源码静态门禁（gson 运行期兼容 + 格式化），不需要客户端 | 0/1/2 |
| `export-acceptance.mjs` | 导出族验收（C1–C6 / D2 / D3 / D5） | 0/1 |
| `export-check.mjs` | 单份场景文件检查器：喂 web 侧真实解析器并核对帧集、`exportId`、逐帧哈希 | 0/1/2 |
| `export-d2-compare.mjs` | 两条通道产物的一致对照（解包后比对语义子树，默认不比字节） | 0/1/2 |
| `export-d2-twins.mjs` | `dump` 与 `multiblock` 两条链路的双通道核对 | 0/1/2 |
| `bake-truth-acceptance.mjs` | 烘焙忠实性与 `TYPE_INT` 实机回归（需已在跑的客户端） | 0/1/2 |
| `evidence-catalog.mjs` | 把动作自描述落成可复核 JSON | 0（失败抛错） |
| `inspect-artifact.mjs` | 产物形态诊断，不作判据 | 0/2 |
| `caller-defaults.test.mjs` | 调用器缺省口径离线回归（`node:test`） | 测试框架给出 |

离线自检入口：

| 入口 | 验证对象 | 退出码 |
|---|---|---|
| `run-anchor-selftest.ps1` | `anchor-checks.ps1` 的逐条判定 | 0/2 |
| `run-input-acceptance-selftest.ps1` | `input-acceptance-checks.ps1` 的逐条判定与分支 | 0/2 |
| `run-pin-preflight-selftest.ps1` | 钉选项的创建、改写、归一、CRLF、只读、目录与驱动失败，以及点火驱动的 AST 阻断结构 | 0/2 |
| `run-static-gates.ps1` | gson 兼容与格式化门禁 | 0/1/2 |

## 2. 前置与运行纪律

1. **Web 依赖**：`web/node_modules` 必须存在；冷树先执行 `cd web; pnpm install --frozen-lockfile`。驱动把缺失当作前置失败并明确退出，不自动安装。
2. **运行环境**：Node 18+（本仓 22；`caller.mjs` 只用内置 `fetch`）、PowerShell 7、可执行的 `gradlew`。
3. **控制面启用**：`<mcDataDir>/config/lightning.cfg` 中 `controlplane.enabled=true`。驱动写配置前备份原值、收尾还原；`-EnableViaJvmProperty` 走 `-Dsde.controlPlane=on`，只用于排障。
4. **端口与凭据发现**：除 `run-one-shot.ps1` 会把 `-Port` 写进配置外，其他驱动的 `-Port` 只用于点火前占用检查。调用一律读 `<mcDataDir>/controlplane/server.json` 的 `port`，token 读 `tokens.json`。
5. **客户端独占**：`runClient` 受 Gradle 锁、端口与存档共同约束，一次只允许一个；`-SkipClientStart` 只表示复用已获批的客户端，不解除独占。
6. **点火前钉选项**：MC 1.7.10 只在启动时读 `options.txt`，因此所有会 `Start-Process` 的驱动在启动前经 `pin-preflight.ps1` 调 `drive-session.ps1 -PinOnly`，并回读确认 `options.txt` 中恰好一行 `pauseOnLostFocus:false`；失败即退出 4，不起客户端。`-SkipClientStart` 与 `-ChecksOnly` 不写 `options.txt`。手工启动客户端时先执行：

   ```powershell
   pwsh -File scripts/control-plane/drive-session.ps1 -RunDir <mcDataDir> -Tag manual -PinOnly
   ```

7. **启动通道**：`run-smoke.ps1` 默认 `runClientSdePipeline`（`-UseModernJdk` 改用 `runClient25`）；`run-shots.ps1`、`run-anchor.ps1`、`run-one-shot.ps1`、`run-input-acceptance.ps1` 默认 `runClient25`，前三者的 `-LegacyJdk` 退回 `runClientSdePipeline`。
8. **归档**：驱动把 run 目录、`events.jsonl`、日志与断言表归到 `-ArchiveRoot`，缺省 `scripts/control-plane/.out`（`.gitignore` 覆盖）。归档用于当场排查。

## 3. 调用器 `caller.mjs`

```text
node scripts/control-plane/caller.mjs <actionName> [paramsJson] [options]
```

| 选项 | 语义 |
|---|---|
| `paramsJson` | JSON 对象字面量；以 `@` 开头表示从该文件读取 JSON |
| `--tier observe|scene|forensic` | 强制权限级；缺省取动作自描述的 `tier` |
| `--sync` | 用 `?sync=true&timeoutMs=N` 同步提交；超时返回 202 + `jobId`，动作不取消 |
| `--timeoutMs N` | 总超时毫秒，默认 `60000`，覆盖同步等待与异步轮询 |
| `--poll-intervalMs N` | 异步轮询间隔，默认 `500` |
| `--mc-dir <path>` | mcDataDir，默认 `mod/gtnh/run/client` |
| `--no-confirm` | 不自动补 `confirm:true`，负测试专用 |
| `--allow-unknown-params` | 放行自描述未声明的参数；默认本地报错 |
| `--json-out <path>` | 另存最终作业 JSON 或错误信封 |
| `--describe` / `--actions` | 只打印动作自描述或整份动作目录（纯 JSON 到 stdout） |

**发现顺序**：`server.json` 的 `port`（以及 `bind`/`contractVersion`/`pid`）→ `tokens.json` 的 `tokens.{observe,scene,forensic}`。不扫描端口，不读上一轮残留。

**构造规则**：

1. 动作必须存在于自描述中，否则本地报错，不发出请求。
2. 必填参数缺失时本地报错，并打印该动作的完整参数表。
3. 未提供的选填参数不写入请求体；调用器不按 `default` 代填，服务端缺省逻辑生效。
4. 显式值原样保留：`false` / `0` / `null` / `""` 都不做 falsy 判断。
5. 参数名不在自描述中时本地报错；`--allow-unknown-params` 仅用于定位契约漂移。
6. `confirm` 由权限级派生。

**退出码**：`0` 作业完成；`1` 调用错误（HTTP 4xx/5xx、本地用法错误、动作不存在）；`2` 作业 `failed`；`3` 超时（作业仍在跑，未取消）。`--json-out` 在完成或失败时写作业 JSON，调用错误时写 `{ok:false, httpStatus, error}`，超时写最后一份作业 JSON 并加 `callerTimeout:true`。

```powershell
node scripts/control-plane/caller.mjs core.ping
node scripts/control-plane/caller.mjs case.run @case-run-params.json --sync --timeoutMs 600000
node scripts/control-plane/caller.mjs world.rebuild --no-confirm    # 预期 CP-CONFIRM-001，退出码 1
node scripts/control-plane/caller.mjs case.run --describe
node --test scripts/control-plane/caller-defaults.test.mjs
```

## 4. 实机驱动的最小运行命令

```powershell
pwsh -File scripts/control-plane/run-smoke.ps1
pwsh -File scripts/control-plane/run-shots.ps1
pwsh -File scripts/control-plane/run-anchor.ps1
pwsh -File scripts/control-plane/run-one-shot.ps1
pwsh -File scripts/control-plane/run-read-surface.ps1
pwsh -File scripts/control-plane/run-tank-fill.ps1 -InWorld
pwsh -File scripts/control-plane/run-input-acceptance.ps1 -Stage world
node scripts/control-plane/export-acceptance.mjs --out <证据目录>
node scripts/control-plane/bake-truth-acceptance.mjs --out <证据目录>
```

`run-read-surface.ps1` 与 `run-tank-fill.ps1` 不启停客户端，只连已获批的客户端；`run-tank-fill.ps1` 不加 `-InWorld` 只跑离线自描述与默认值检查。

共同参数：

| 参数 | 说明 |
|---|---|
| `-CaseFile <path>` | 用例文件；缺省依次为 `test/cases/smoke/cp-smoke-basic.json`、`test/cases/smoke/cp-smoke-shots.json`、`test/cases/read-surface/read-surface.json`、`test/cases/anchor/lp-pipe-row.json` 与 `test/cases/anchor/ae2-parts.json` |
| `-McDataDir <path>` | 覆盖 mcDataDir，默认 `mod/gtnh/run/client` |
| `-SkipClientStart` | 复用已获批的客户端，不写配置、不起进程 |
| `-KeepClient` | 跑完不停客户端，保留现场 |
| `-Port <n>` | 点火前占用检查（`run-one-shot.ps1` 例外，写进配置） |
| `-ArchiveRoot <path>` | 归档根，缺省 `scripts/control-plane/.out` |
| `-EvidenceDir <path>` | `run-read-surface.ps1`、`run-tank-fill.ps1` 的证据目录 |
| `-ActionTimeoutMs <ms>` / `-CaseTimeoutMs <ms>` | 单动作与单次 `case.run` 的超时；声明了 `totalTimeoutMs`/`stageTimeoutMs` 的动作由驱动下传预算 |
| `-Stage <all|pre|menu|world|g1|extra>` / `-Only <E1|E2|E3>` | `run-input-acceptance.ps1` 的分段与单条重跑 |

`run-input-acceptance.ps1` 的 `-Stage` 缺省 `all`（pre → menu → world → g1）；`-Stage extra` 另跑 E1/E2/E3，且总是先跑 pre。`-Only` 只对 `-Stage extra` 有效。

## 5. 静态门禁 `run-static-gates.ps1`

不需要客户端，只验 mod 源码的静态门禁，不验判据。

```powershell
pwsh -NoProfile -File scripts/control-plane/run-static-gates.ps1
npm run gates:mod-static
pwsh -NoProfile -File scripts/control-plane/run-static-gates.ps1 -SkipSpotless
pwsh -NoProfile -File scripts/control-plane/run-static-gates.ps1 -TimeoutMinutes 45
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `-SkipSpotless` | 关 | 跳过格式门禁；gson 兼容始终跑 |
| `-TimeoutMinutes` | `30` | 整体超时 |
| `-OutDir` | `scripts/control-plane/.out/static-gates` | 日志根 |

| 门禁 | 证明 | 失败处置 |
|---|---|---|
| `gsonCompatCheck` | `src/main/java` 整树只用了运行期实载 gson 版本存在的 API | 改成 2.2.4 兼容写法（见 [build-guide.md](../../docs/build-guide.md)） |
| `spotlessJavaCheck` | 源码符合仓库格式化口径 | `cd mod/gtnh && ./gradlew spotlessApply` 后重跑 |

判定逐条读 Gradle 任务标记：`> Task :<门禁>`、`UP-TO-DATE`、`FROM-CACHE` 记 PASS；`FAILED` 记 FAIL；`SKIPPED`、`NO-SOURCE` 或标记行缺失记 NOT RUN 并以退出码 2 结束。`-SkipSpotless` 未请求的格式门禁记 `n/a`。本入口不跑 `build`（会连带 `processResources → syncWeb → npm`），也不复制判据实现。

## 6. 退出码

| 码 | 含义 | 出现处 |
|---|---|---|
| `0` | 全部通过 / 作业完成 / 归档完成 | 全部入口 |
| `1` | 调用错误（HTTP 4xx/5xx、本地用法错误）或门禁失败 | `caller.mjs`、`export-*.mjs`、`bake-truth-acceptance.mjs`、`run-static-gates.ps1` |
| `2` | 有断言失败 / 作业 `failed` / 有差异 / 输入不可用 / 证据不完整 | 实机驱动、离线自检、检查器与比对器 |
| `3` | 管线级致命（等 `server.json` 超时、客户端早退）或调用超时 | 实机驱动、`caller.mjs` |
| `4` | 前置检查或编排自身失败（缺 gradlew、`web/node_modules`、用例，端口被占，钉选项失败） | 实机驱动 |
