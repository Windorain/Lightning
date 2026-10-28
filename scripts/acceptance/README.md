# 验收编排（`npm run acceptance:multiblock`）

本目录是多方块验收的编排入口：由一条命令依次执行下列阶段，把每个阶段的结论、产物与日志汇总成报告与退出码。编排不做重试，也不因某阶段失败而中断后续阶段。当前树中完整验收不可达成，原因见 §1。

判据的权威定义在 [format-multiblock-doc.md](../../docs/contracts/format-multiblock-doc.md) §10（体积判据：记号、阈值与 R1/R2/R3）与 §6（调色板）。

## 1. 当前可完成性边界（先读）

`scripts/multiblock-pipeline/run-pipeline.ps1` **不在本仓库中**。两个阶段直接调用它：`falsify-mod-negative`（`-Scope MTENoSuchMachineT16`）与 `export-multiblock`（默认子集）。调用因此以非零退出码结束，阶段判为失败，`exports/` 不会被产出。

由此产生的当前事实：

1. **完整真实验收在当前树中不可达成**。`export-multiblock` 与 `falsify-mod-negative` 必然失败；`verify-expanded`、`contract-validate`、`volume-curve`、`falsify-offline-negative`、`web-real-acceptance`、`web-assembly-cross-check` 缺少它们产出的 `exports/` 输入，同样无法通过。
2. **`web-real-acceptance` 的 spec 存在**（`web/e2e/multiblock-real-acceptance.spec.ts`，随仓库版本化）。它读取 `MB_REAL_EXPORTS_DIR` 指向的真实产物；目录、产物文件或展开文件缺失时由 `helpers/multiblock/realExports.ts` 在 import 期抛错，本次 playwright 运行以非零退出码结束——不静默跳过。因此该阶段当前的失败原因是**缺真实产物**，不是缺 spec。
3. **`not-run` 只用于两种情况**：阶段被开关跳过（`-SkipWeb`、`-SkipSdeInterop`、`-SkipFalsification`、`-SkipBuild`），或不在 `-OnlyStages` 之内。缺少输入不属于 `not-run`，按失败记录。
4. **`sde-export-interop` 固定记 `not-run`**：该阶段依赖的批处理设施（指令文件队列、客户端 tick 接管链、专用世界）不在仓库中，因此本阶段不做任何检查，报告里固定写 `not-run` 并给出原因；本编排尚未接入其它实现。

## 2. 命令

```powershell
npm run acceptance:multiblock                                  # 依次执行全部阶段（默认子集 5 台）
npm run acceptance:multiblock -- -DryRun                        # 只做前置检查并打印计划
npm run acceptance:multiblock -- -Label v1                      # 指定归档标签（目录名 acceptance-v1）
npm run acceptance:multiblock -- -OutRoot D:/evidence           # 指定归档根
npm run acceptance:multiblock -- -CompareWith <report.json>     # 与上一次报告逐条比对
npm run acceptance:multiblock -- -OnlyStages volume-curve       # 分段执行（其余阶段记 not-run）
npm run acceptance:multiblock -- -SampleFrom <exports 目录> -Label sample   # 样例报告（verdict=sample）

npm run acceptance:volume-doc                                   # 体积曲线归档文档（默认 --mode template）
node scripts/acceptance/volume-doc.mjs --mode data --run-dir <runDir>      # 用真实数据生成归档文档
```

`npm run acceptance:multiblock` 等价于 `pwsh -NoProfile -File scripts/acceptance/run-acceptance.ps1`，其余参数用 `-- ` 透传。

## 3. 参数（`run-acceptance.ps1`）

| 参数 | 默认 | 说明 |
|---|---|---|
| `-Label <名>` | `run-<yyyyMMdd-HHmmss>` | 归档标签，运行目录为 `<OutRoot>/acceptance-<Label>` |
| `-OutRoot <dir>` | `scripts/acceptance/.out` | 归档根目录 |
| `-Scope <a,b,...>` | 空 = 编排默认导出子集（5 台：EBF/DT/BBF/QFT/AdvEBF） | 传给导出命令的范围（simpleName/fqcn/slug） |
| `-CompareWith <report.json>` | 空 | 上一次的 `acceptance-report.json`，逐条比对判定 |
| `-DryRun` | 关 | 只做前置检查并打印计划 |
| `-OnlyStages <a,b,...>` | 空 | 只执行指定阶段，其余记 `not-run` |
| `-SampleFrom <exports 目录>` | 空 | 用既有产物回放生成报告（不起游戏、不跑 playwright），`verdict=sample` |
| `-SeedExportsFrom <dir>` | 空 | 分段验证：把既有产物归档复制进本次运行目录作为导出阶段的输入 |
| `-SkipSdeInterop` | 关 | 跳过 `/sde export` 互不干扰阶段 |
| `-SkipFalsification` | 关 | 跳过证伪阶段 |
| `-SkipWeb` | 关 | 跳过全部 Web 阶段 |
| `-SkipBuild` | 关 | 跳过 `gradlew build` |
| `-AllowMissingRealSpec` | 关 | 仅在缺少真实导出 spec 时改变报告里该条 `openItems` 的严重级别；当前 spec 存在，该开关不改变任何阶段判定 |
| `-IncludeRealInSynthetic` | 关 | 让合成回归也包含真实导出 spec（默认排除，见 §8 第 6 条） |
| `-ExportTimeoutMinutes` | `120` | 导出阶段超时 |
| `-SdeInteropTimeoutMinutes` | `25` | 互不干扰阶段超时 |
| `-WebTimeoutMinutes` | `45` | Web 阶段超时 |
| `-BuildTimeoutMinutes` | `45` | 构建阶段超时 |
| `-VolumeTimeoutMinutes` | `30` | 体积曲线阶段超时 |

`volume-doc.mjs` 的参数：`--mode template|data`（template 写骨架，已存在时除非 `--force` 不覆盖；data 用真实 `volume-curve.json` 与报告生成完整文档）、`--run-dir <runDir>`（data 模式必填）、`--out <doc>`（缺省 `scripts/acceptance/.out/volume/volume-profile-result.md`）、`--force`；退出码 `0` 成功、`2` 输入不可用。编排在体积曲线产物存在时以 data 模式调用它，失败时退回 template 模式。

## 4. 退出码

按下列优先级取第一个命中的取值：

| 码 | 含义 |
|---|---|
| `3` | 前置检查未通过（缺 CoFH conf、缺枚举事实层、缺 gradle、缺 playwright chromium） |
| `4` | 模组侧阶段失败（`build:mod:gtnh`、导出、展开校验、契约校验、模组侧证伪、`/sde export` 互不干扰） |
| `5` | Web 侧阶段失败（真实导出 spec、合成回归、vitest、`build:web`） |
| `6` | 分析类阶段失败（体积曲线、Web 装配交叉验证、静态检查、离线证伪、截图归档） |
| `7` | 报告汇总失败（未产出 `acceptance-report.json`） |
| `2` | 验收不完整（有阶段 `not-run`：被开关跳过或不在 `-OnlyStages`） |
| `8` | 与 `-CompareWith` 的逐条判定不一致 |
| `9` | 阶段均通过但把关清单项判定失败 |
| `0` | 全部通过 |

## 5. 阶段

```
preflight → build-mod-gtnh → falsify-mod-negative → export-multiblock → verify-expanded
          → contract-validate → web-real-acceptance → web-synthetic-regression → web-unit-vitest
          → build-web → volume-curve → web-assembly-cross-check → static-checks
          → falsify-offline-negative → sde-export-interop → evidence-screenshots → report
```

| 阶段 | 内容 | 当前输入条件 |
|---|---|---|
| `preflight` | 环境检查：`gradlew.bat`、node/npm/npx/pwsh、`web/node_modules`、CoFH MCP conf（含 `.srg`）、枚举事实层 `machines.json`、playwright chromium、离线编码器 class | 需要 Gradle 缓存、`web/node_modules` 与 `multiblock_scan/run-*/machines.json` |
| `build-mod-gtnh` | `gradlew build`（含格式化门禁与离线编码器编译） | — |
| `falsify-mod-negative` | 未知机器必须退出码 2 且原因落盘 | 调用 `run-pipeline.ps1`（不在仓库，当前失败） |
| `export-multiblock` | `/sde multiblock` 导出默认子集，含展开校验文件与结构化结果 | 同上 |
| `verify-expanded` | 展开文件与参考装配逐格 diff | 需要 `exports/` |
| `contract-validate` | 产物集契约校验 + 契约 k 序列（fixture `--volume`） | 需要 `exports/` 内的 5 份产物 |
| `web-real-acceptance` | 真实导出 spec：`MB_REAL_EXPORTS_DIR` 指向本次 `exports/`，`--retries=0` | 需要真实产物（spec 已在仓库） |
| `web-synthetic-regression` | 合成 fixture 全量回归 | 仅需 `web/node_modules` |
| `web-unit-vitest` | `vitest` | 仅需 `web/node_modules` |
| `build-web` | `build:web` | 仅需 `web/node_modules` |
| `volume-curve` | 离线编码器对照、profile 分桶、R1/R2/R3 与曲线图 | 需要 `exports/` 与已编译的编码器 |
| `web-assembly-cross-check` | Web 侧真实装配代码路径与数据集逐格 diff | 需要 `exports/` |
| `static-checks` | 装配路径零游戏逻辑、无 GT 逻辑重放 | 需要枚举事实层的通道 id 集合 |
| `falsify-offline-negative` | 篡改注入必须使判定失败（负对照）与未篡改正对照 | 需要 `exports/` |
| `sde-export-interop` | 当前固定记 `not-run`（见 §1.4） | — |
| `evidence-screenshots` | 截图证据链归档 | 需要本阶段新产生的截图 |
| `report` | `acceptance-report.json` 与 `acceptance-report.md` | — |

阶段状态取 `pass` / `fail` / `not-run`（仅被开关跳过或不在 `-OnlyStages`）/ `sample`（`-SampleFrom` 回放）。`not-run` 计入报告的 `verdict.counts.notRun`，相关清单项降级为 `not-run`。

## 6. 证据目录与报告

```
<OutRoot>/acceptance-<label>/
  acceptance-report.json        机器可读验收报告（报告数据以它为准，schema lightning.acceptance.multiblock/1）
  acceptance-report.md          人读摘要
  run-state.json                运行状态（范围、裁决、开放项、交互性、git、环境）
  stages/<id>.json              每阶段片段（gates / artifacts / evidence / data）
  logs/<id>.log (.err)          每阶段原始输出
  exports/                      产物归档（含 expanded/ 与 _dataset/）；当前树中不会产出
  pipeline-result.json          结构化结果（产物哈希、捕获统计、展开清单、配置面）
  verify-expanded.json          展开逐格 diff 报告
  contract-validation.json      产物集契约校验报告
  contract-volume-fixtures.json 契约 k 序列报告
  static-checks.json            静态检查结果
  volume/                       离线编码器输出、profile 分桶、volume-curve.json/.svg/.md、volume-profile-result.md
  web/                          real-acceptance.json / synthetic.json / web-parser-cross-check.json
  interop/                      snapshot-before.json / interop.json / lightning.cfg.bak（该阶段当前记 not-run）
  falsification/                falsification.json 与 tamper-* 篡改副本
  screenshots/                  manifest.json 与镜像的截图文件
```

报告由 `build-report.mjs` 从阶段片段、产物与分析 JSON 装配，可在任意时刻重算：`node scripts/acceptance/build-report.mjs --run-dir <runDir> [--compare-with <report.json>] [--out <report.json>] [--label <label>]`（退出码 `0` 报告算完、`1` 判定含 fail 或 not-run 但报告仍落盘、`2` 运行目录不可用）。

`<OutRoot>` 是运行证据目录：`scripts/acceptance/.out/` 已被 `.gitignore` 覆盖，运行证据不进仓库。

## 7. 单项工具

| 工具 | 用法 | 退出码 |
|---|---|---|
| `volume-curve.mjs` | `node scripts/acceptance/volume-curve.mjs --encoded <dir> --products <dir> --out <dir> --profile <profile.json> --contract-report <fixtures k 序列.json>` | 由编排消费 |
| `falsification.mjs` | `node scripts/acceptance/falsification.mjs --exports <dir> --out <dir> [--mod-negative <pipeline-result.json>]` | 0/1/2 |
| `static-checks.mjs` | `node scripts/acceptance/static-checks.mjs --out <runDir>/static-checks.json` | 0/1 |
| `screenshots.mjs` | `node scripts/acceptance/screenshots.mjs archive --run-dir <runDir> --since <epochMs> [--label <名>]` | 0/2 |
| `interop-check.mjs` | `node scripts/acceptance/interop-check.mjs snapshot --out <runDir>/interop/snapshot-before.json --multiblock-exports <dir> --structure-exports <dir>`；`compare --run-dir <runDir> --multiblock-exports <dir> --structure-exports <dir> --log <客户端日志> --world <名>` | 0/1/2 |
| `volume-doc.mjs` | 见 §3 | 0/2 |
| `build-report.mjs` | 见 §6 | 0/1/2 |

## 8. 判据与实现约束

1. **范围是默认子集 5 台**：报告显式标注 `explicitNonFull` 并给出全量估算；显式 `-Scope` 可更换机器集合。
2. **`not-run` 不计为通过**：它使验收不完整，退出码至少 2，相关清单项在报告里降级为 `not-run`。
3. **R2 的判定在契约 k 序列上**（[format-multiblock-doc.md](../../docs/contracts/format-multiblock-doc.md) §10.3）：真实对照序列的变量部分低于判定下限，因此 R1/R3 在真实序列上判定、R2 在契约参考实现的 fixture 放大序列（`contract-volume-fixtures.json`）上判定；真实序列仍给出斜率、R²、边际与补充判据。
4. **固定池使常数项闸门在真实产物上不可满足**：每份产物带全套 `materialPalette`/`textureBlobs`（未按机剪枝），而契约的 4096 B 下限（[format-multiblock-doc.md](../../docs/contracts/format-multiblock-doc.md) §10.1）按信封头量级设定；该事实登记在报告 `openItems`。
5. **真实导出 spec 是独立阶段**：它以 `--retries=0` 运行，`MB_REAL_EXPORTS_DIR` 指向本次 `exports/`；缺少真实产物时 spec 显式失败，不得仅凭合成 fixture 判定「Web 装配 = 模组导出」，相关清单项随阶段状态降级。该阶段必须直调 `web/node_modules/@playwright/test/cli.js`：经 `npx.cmd` 时 `cmd.exe` 会吞掉模式里的括号，把 `multiblock-(?!real-acceptance)` 退化成 `multiblock-`。
6. **合成回归默认排除真实导出 spec**：`npm run test:e2e:multiblock` 的 `multiblock-` 模式会把它一并带上，两个阶段各跑一遍属重复执行；`-IncludeRealInSynthetic` 可显式合并。
7. **不得与其它 playwright/vite 并发运行**：`web/playwright.config.ts` 的 webServer 为 `reuseExistingServer: true`，两个 playwright 进程共用同一 dev server 端口（缺省 5199）时，先退出的一方会关掉被复用的 vite，另一方整片连接失败。
8. **不得用重复运行掩盖失败**：编排不做自动重试；真实导出 spec 以 `--retries=0` 运行，playwright 自身 `retries` 配置产生的偶发失败照原样记录。
9. **`validate-multiblock-fixtures.mjs --volume` 只对 fixture 运行**：其 `scaleDocument` 是 fixture 专用的放大实现，对真实产物会越界；真实产物只做格式与全组合装配校验，契约 k 序列由 fixture 单独产出。
10. **运行时配置借用后还原**：`/sde export` 互不干扰阶段会临时修改 `run/client/config/lightning.cfg`，编排在 `finally` 中还原，备份留在 `interop/lightning.cfg.bak`。
11. **超时与挂死防护**：每个子进程带超时，超时结束整棵进程树并记 `timedOut=true`；进程等待用 .NET `Process.WaitForExit(ms)`；playwright 的 json 报告不在 PowerShell 中解析，用例计数由 `build-report.mjs` 解析。
