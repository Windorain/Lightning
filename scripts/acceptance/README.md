# Phase 3 验收编排（`npm run acceptance:multiblock`）

> 判据真源：`docs/contracts/format-multiblock-doc.md` §9（体积判定式 R1/R2/R3 与阈值）、§6（调色板）；
> 上游半环：游戏内导出管线与因子化编码（过程性计划/探针报告已按 #51 裁决删除，原文见 issue #51 / git 历史）。
>
> 本目录是**交付 E「自动化验收管线」的总入口**。一条命令、零人工交互、任何一步红即非零退出。

---

## 0. 一条命令

```powershell
npm run acceptance:multiblock                             # 正式验收（默认子集 5 台；**实测 ≈35 min**）
npm run acceptance:multiblock -- -DryRun                  # 只做前置检查 + 打印计划（秒级）
npm run acceptance:multiblock -- -Label v1                # 指定归档标签
npm run acceptance:multiblock -- -CompareWith <上一次的 acceptance-report.json>   # 幂等逐条比对
npm run acceptance:multiblock -- -OnlyStages volume-curve # 分段验证（其余阶段记 not-run）
npm run acceptance:multiblock -- -SampleFrom scripts/multiblock-pipeline/.out/<run>/exports -Label sample   # 样例报告（不构成验收）
```

**时长构成（实测/分段实测）**：两个 playwright 阶段占大头 —— 真实导出 spec **8.9 min**（28 用例，含 1262 组合遍历 + 像素门禁 + 35 抽样逐格 diff）、
合成回归 **≈11 min**（52 用例，desktop 552 组合遍历最慢）；其余阶段：导出 3.5 min、mod 负对照 3 min、`/sde export` 互不干扰 2.5 min、
离线证伪 1.5 min、构建 1–2 min、T3.2 1 min、其余合计 <1 min。→ **串行一条命令 ≈33–38 min**。

> ⚠️ **不得与其它 playwright/vite 并发运行**：`web/playwright.config.ts` 的 webServer 是 `reuseExistingServer: true`，
> 两个 playwright 进程共用 5199 端口时，先退出的一方会把它复用的 vite 一并关掉 → 另一方整片 `ERR_CONNECTION_REFUSED`
> （实测：真实导出 spec 28 项里 11 项这么红过）。编排已把这件事做成 preflight 登记 + 阶段的显式门禁与诊断。

| 开关 | 作用 |
|---|---|
| `-Scope a,b` | 导出范围（simpleName/fqcn/slug）；缺省 = 管线默认验收子集（EBF/DT/BBF/QFT/AdvEBF） |
| `-SkipWeb` / `-SkipSdeInterop` / `-SkipFalsification` / `-SkipBuild` | 跳过对应阶段（**都会让验收变成"不完整"，退出码 2**） |
| `-AllowMissingRealSpec` | 真实导出 spec 未落地时不阻断（仅调试；正式验收禁用） |
| `-SeedExportsFrom <dir>` | 分段验证：把既有产物归档塞进本次运行目录（正式验收不用） |
| `-IncludeRealInSynthetic` | 让合成回归也带上真实导出 spec（默认排除，见下） |
| `-ExportTimeoutMinutes` / `-WebTimeoutMinutes` / `-BuildTimeoutMinutes` / `-VolumeTimeoutMinutes` / `-SdeInteropTimeoutMinutes` | 各阶段超时（分钟） |

**真实导出 spec 的调用纪律（实测踩坑，已固化）**：
- 模式 = `multiblock-real-acceptance`，`--retries=0`（禁止"重试到绿"），`MB_REAL_EXPORTS_DIR` = 本次运行的 `exports` 归档目录；
- **必须直调 `node web/node_modules/@playwright/test/cli.js`，不能走 `npx.cmd`**：`cmd.exe` 会吞掉模式里的 `(`/`!`/`)`，
  实测把 `multiblock-(?!real-acceptance)` 退化成 `multiblock-`（于是把真实 spec 也带进来，白跑 ~12 min）。
- 合成回归默认排除真实 spec（`npm run test:e2e:multiblock` 的 `multiblock-` 会把它一起带上）：
  两者各跑一遍要多花 ~12 min，而真实 spec 有自己的阶段（`--retries=0` + 产物归档目录）。

**退出码**：`0` 全绿 · `2` 验收不完整（有阶段 `not-run`）· `3` 前置检查致命 · `4` mod 半环红 ·
`5` web 半环红 · `6` 分析类阶段红（T3.2 / 装配交叉验证 / 静态判据 / 证伪 / 截图）· `7` 报告未产出 ·
`8` 幂等逐条判定不一致 · `9` 阶段全绿但 §6 清单项红。

---

## 1. 步骤图

```
preflight ─▶ build-mod-gtnh ─▶ falsify-mod-negative ─▶ export-multiblock ─▶ verify-expanded
   │              │                    │                      │                    │
   环境闸门    gradlew build      未知机器必须退出码 2    /sde multiblock    展开文件 vs 参考装配
   （CoFH conf   （含 spotless；    + 原因落盘（证伪）      （5 台 + 展开校验    逐格 diff（T3.3 mod 半环）
   /事实层/      T3.2 编码器编译）                          文件 + 结构化结果）
   playwright）
   │
   ├─▶ contract-validate ─▶ web-real-acceptance ─▶ web-synthetic-regression ─▶ web-unit-vitest ─▶ build-web
   │      T0.5 契约校验器     真实导出 spec            合成 fixture 全量回归         vitest            build:web
   │      + 契约 k 序列       （MB_REAL_EXPORTS_DIR）  （帧为主 + 面板/遍历/非法 + 证伪）
   │
   └─▶ volume-curve ─▶ web-assembly-cross-check ─▶ static-checks ─▶ falsify-offline-negative
          T3.2：离线编码器对照      web 真实装配代码路径       装配路径零游戏逻辑      篡改必红（6 条负对照）
          + volume-profile 分桶      vs mod 数据集逐格 diff    / 无 GT 逻辑重放        + 正对照
          + R1/R2/R3 + 曲线图
   │
   └─▶ sde-export-interop ─▶ evidence-screenshots ─▶ report
          /sde export 与 multiblock   截图证据链归档       acceptance-report.json + .md
          互不干扰（同世界、两次会话）  （+ manifest）
```

**为什么 `/sde export` 与 multiblock 是两个客户端会话**：`SdeClientAutomationTickHandler` 的分派顺序是
「T1.6 管线触发文件 → T1.2 扫描 → T0.3 探针 → 通用指令文件队列」，管线触发文件存在时**直接 return**，
故同一次会话内无法既跑 multiblock 管线又跑指令文件队列。调度者裁决的「同世界先后执行」因此落为
**同一专用世界（`sde_pipeline_world`）的两次顺序会话**；互不干扰判据（产物目录哈希快照 + 基线哈希）不受影响。

---

## 2. 失败语义（不静默、不"重试到绿"）

1. **任何阶段红都不阻断后续**：编排把红留在片段里，最后统一汇总成报告与退出码 —— 一次运行拿到**全部**红项。
2. **阶段状态**：`pass` / `fail` / `not-run`（缺依赖、被开关跳过、spec 未落地）/ `sample`（`-SampleFrom` 回放）。
3. **`not-run` 一律不算通过**：报告里计入 `verdict.counts.notRun` 并把相关清单项降级为 `not-run`；退出码至少 2。
4. **禁止"重试到绿"**：编排不做自动重试；playwright 自身的 `retries: 1` 属于既有配置，其 flaky 结果照原样记录。
5. **过期证据防御**：契约校验器写固定路径报告 —— 编排在跑之前**先删除**旧报告，避免"崩溃后读到上一轮报告"这种假绿
   （本编排自检时真实踩到过：`validate-multiblock-fixtures.mjs --volume` 对**真实产物**会抛
   `装配越界`（`scaleDocument` 是 fixture 专用放大），当时读到了上一轮 falsification 留下的报告）。
6. **超时安全网**：每个子进程带 `Wait-Process -Timeout`，超时 `taskkill /T /F` 杀整棵树并记 `timedOut=true`。
7. **运行时配置外借必还原**：`/sde export` 互不干扰阶段需要临时改 `run/client/config/lightning.cfg`
   （`autoLoadFirstSingleplayerWorld=true`）——`run/` 已被 `mod/gtnh/.gitignore` 覆盖，属**运行环境文件**，
   且编排在 `finally` 里**原样还原**并把备份留在证据目录。

---

## 3. `acceptance-report.json` schema

```jsonc
{
  "schema": "lightning.acceptance.multiblock/1",
  "generatedAt": "…", "label": "…", "mode": "acceptance" | "sample",
  "verdict": {                       // 总判定
    "status": "pass" | "fail" | "sample",
    "exitCode": 0,
    "counts": { "pass": 20, "fail": 0, "na": 3, "notRun": 0 },
    "redChecks": [ { "id", "status", "detail" } ],   // fail / not-run 逐条
    "naChecks":  [ { "id", "detail" } ],             // 不适用（附理由，不掩盖失败）
    "note": "…"
  },
  "scope": {                         // 范围（风险 7 裁决）
    "mode": "default-subset-5", "explicitNonFull": true,
    "machines": ["…"], "variants": 1262,
    "fullRunEstimate": { "uncappedHours": 431, "cappedHours": 32, "basis": "…" },
    "adjudications": [ { "id", "text", "source" } ]
  },
  "stages":     [ { "id","name","command","exitCode","status","durationMs","gates","artifacts","evidence","notes","data" } ],
  "checks":     [ { "id","section","text","judgedBy":"machine","status","detail","gates","evidence" } ],   // §6 逐条映射（23 条）
  "products":   [ { "file","slug","machine","variants","bytes","sha256" } ],
  "productsTotalBytes": 319164,
  "exportsSnapshotSummary": { "files","bytes","sha256Joined" },
  "expanded":   { "enabled","machines","samples","files","manifest","fileHashes","sampleList" },
  "capture":    { …T1.6 captureTotals… },
  "diff":       { "verifyExpanded": {…}, "webRealAcceptance": {…}, "webAssemblyCrossCheck": {…} },
  "contractValidation": { "failures","warnings","checksByPrefix","report" },
  "volumeCurve": {
    "verdict": {…}, "criterion": { "safetyFactor":1.35,"r2Min":0.95,"floorBytes":4096,"maxMarginalBytesPerVariant":2048 },
    "series": [ { "id","axis","status","points","extended","R1","R2","R3" } ],
    "risk4":  { "status","worst","rows","dedup","thresholds" },
    "products":[ { "file","N","G","V","kappa","paletteShare" } ],
    "contractKSequence": [ … ], "criterionNotes": [ … ],
    "artifacts": { "json","svg","md","profile" }
  },
  "falsification": { "controls":[ { "id","expected","observed","ok","controlStatus" } ], "webSpec": {…} },
  "interop":    { "world","multiblockExports":{…,"diff"},"structureExports":{…},"produced":[…],"baselines":[…],"gates":[…] },
  "idempotency":{ "priorRun":{ "label","allSame","expandedAllSame","rows" }, "comparedWith","verdictsMatch","perCheck" },
  "web":        { "realAcceptance":{…},"synthetic":{…},"vitest":{…} },
  "staticChecks": { "assemblyPath":{…},"gtReplay":{…} },
  "screenshots": { "archiveDir","convention","count","bytes","manifest" },
  "sampling":   { "expandedSampleList","volumeSeries","webRealSampling","falsificationControls" },
  "timings":    { "totalMs","perStage":{…},"pipelineResult":{…} },
  "environment":{ "cofhConf","world","fmlQueryResult","os","git","node","interactivity" },
  "openItems":  [ { "id","severity","text" } ],
  "evidenceLayout": { "runDir","report","stages","logs","exports","screenshots","volume","web","interop","falsification" }
}
```

### §6 把关清单 → 机器判据映射（23 条）

每条清单项在 `scripts/acceptance/lib/checklist.mjs` 里就是一个 `judge(ctx)`；`ctx` 由
`build-report.mjs` 从阶段片段 + 产物 + 分析 JSON 装配。**不自己跑任何东西**，因此报告可随时重算。

| # | 清单项（计划 §6 原文缩略） | 机器判据落点 |
|---:|---|---|
| 1 | 所有变体真实构建后捕获，无凭空合成 | `captureTotals`：builds>0、captures=variants、failureCount=0、unstableStateKeys=0、full/anchored>0 |
| 2 | 调色板 = 并集；同一状态几何只存一份 | 逐产物装配全部变体收集用到的下标（无未引用条目）+ 条目内容签名全局唯一 + 本机并集 ⊆ 全局并集 |
| 3 | 几何按内容签名去重、跨变体共享 | `duplicateCapturesSuppressed>0` + 全局去重率>1 + 展开逐格 diff=0 |
| 4 | 文件内无组合展开 | 无 `frames[].ops` / `frames[].cellGrid` + 聚合 κ=ΣV/ΣG ≥ 2.3 + 契约校验器 frames/* 全绿 |
| 5 | 体积剖析证明"随相加而非相乘" | T3.2：R1（κ 随 N）∧R3（S 那一份不随 N）+ R2 未判失败 + 契约 k 序列全过 + 声明部分边际 < 128 B/组合 |
| 6 | 未丢弃变体；上限仅安全兜底 | 范围内失败 0 + 声明集合 = 笛卡尔积 + frames=N + 配置面 `maxChannelValues/maxExportMachines=0`、`structuralOnly=false`、`maxVariantsPerMachine=20000` |
| 7 | 信封机制复用、因子化在信封之前 | 全部产物 `Envelope` + `gzip+base64` + payload 可解 + 内层键位齐备 + 无根级 cellGrid |
| 8 | 文档级枚举互斥；帧为主语义不变 | 全部产物 `documentShape=multiblock` + 帧为主回归 spec 绿 + vitest 绿 |
| 9 | Frame 唯一原语 | frames 数=变体数 + frame 键 ⊆ 契约白名单 + 无内联 ops/cellGrid |
| 10 | 通道命名尊重 id；`casing`×3 已消歧 | 每通道 `{enum,id,key,name}` 齐备 + 机内 key 唯一 + `name ≠ capitalize(id)` + 校验器 channels/* 绿 |
| 11 | 耦合约束有表达或缺省定义 | 每产物显式 `couplingMode`/`couplings` 数组 + notes 非空 + 校验器 rules/guard-channel 绿 |
| 12 | 装配路径零游戏逻辑 | 静态扫描 `web/src/context/multiblock/**` + 多方块 parser：无 GT import、无通道 id 分支、无 eval、无等级算术 |
| 13 | 同文件同取值 → web 装配 = mod 导出 | 真实导出 spec 绿 + `verify-web-parser.mjs`（真实 web 模块）diff=0 + `verify-expanded.mjs` diff=0 |
| 14 | 通道 UI 忠实反映声明 | 真实导出 spec 绿 + 面板/遍历/非法 spec 绿 + 面板 DOM 单测绿 |
| 15 | 与帧播放/分层预览互不干扰；两端可用 | 帧为主回归 spec 绿 + 两个 device project 均有用例通过 + fixture 加载 spec 绿 |
| 16 | `build:mod:gtnh` / `build:web` / `vitest` 通过 | 三个阶段退出码 |
| 17 | 未引入第三轴 | 内层/multiblock 键 ⊆ 契约白名单 + 通道 kind 合法 + 校验器 shape/backbone 绿 |
| 18 | 未在 web 端重放 GT/StructureLib 逻辑 | 静态扫描全 `web/src`：无 GT import、无通道 id 常量、无等级→结构公式 |
| 19 | 一条命令跑通全闭环、零人工 | `run-state.interactivity`（singleCommand / prompts=0 / stdin 重定向）+ 世界自动进入记录 + headless |
| 20 | 报告全绿 + 截图/曲线随报告归档 | 报告与 `.md` 存在 + 曲线 JSON/SVG 存在 + 截图清单与非零张数 + 抽样清单内联 + 其余项无红 |
| 21 | 管线幂等（两次运行一致） | 与最近历史归档的产物/展开文件 SHA-256 对比 + 可选 `-CompareWith` 的逐条判定比对 |
| 22 | 断言有效性已证伪 | 6 条负对照全部按预期变红（含 mod 半环退出码 2）+ 正对照仍绿 + web 证伪 spec 绿 |
| 23 | 无"人工过一遍"作为通过依据 | 所有清单项 `judgedBy=machine` 且带证据路径 + 零交互记录 + 每阶段都有落盘产物 |

---

## 4. 证据链归档约定

```
scripts/acceptance/.out/acceptance-<label>/
  acceptance-report.json        机器可读验收报告（唯一真源）
  acceptance-report.md          人读摘要（§6 逐条 + 阶段耗时 + 产物哈希 + 曲线 + 开放项）
  run-state.json                运行状态（范围/裁决/开放项/交互性/git）
  stages/<id>.json              每阶段片段（gates / artifacts / evidence / data）
  logs/<id>.log (+ .err)        每阶段原始输出
  exports/                      产物归档（含 expanded/ 与 _dataset/）
  pipeline-result.json          T1.6 结构化结果
  verify-expanded.json          展开逐格 diff 报告
  contract-validation.json      产物集契约校验报告
  contract-volume-fixtures.json 契约 k 序列报告（R2 的判定落点）
  static-checks.json            静态判据
  volume/
    encoded/                    离线编码器输出（产物 + control/ + 报告）
    profile-input/              volume-profile 的输入副本（只放信封，避免报告/body 污染分桶）
    profile.json / profile.md   T0.1 剖析工具的分桶结果
    volume-curve.json/.svg/.md  T3.2 机读数据 + 曲线图 + 人读表格
  web/
    real-acceptance.json        真实导出 spec 的 playwright json 报告
    synthetic.json              合成回归的 playwright json 报告
    web-parser-cross-check.json web 真实装配代码路径 vs 数据集的 diff 报告
  interop/
    snapshot-before.json        /sde export 阶段前的两套产物目录快照
    interop.json                互不干扰判据 + 产物描述 + 基线哈希
    lightning.cfg.bak           运行时配置备份（已还原）
  falsification/
    falsification.json          负对照/正对照清单
    tamper-*/                   篡改副本（证据，不污染归档产物）
  screenshots/
    manifest.json + 镜像文件     截图证据链（保持仓库相对路径 + SHA-256）
```

---

## 5. 判据、裁决与已知边界（**必须知悉**）

1. **R2 的判定落点是契约 k 序列，不是真实对照序列**：真实对照序列 N≤60，变量部分 `b·N_max ≈ 1.4 KB < 4096 B`，
   按 `format-multiblock-doc.md` §9.3 属"该点无判定意义"。编排对此的处理是：
   把 R1/R3 判在真实序列上、把 R2 判在**契约 k 序列**（T0.5 参考实现的 fixture 放大）上，
   真实序列上仍如实给出斜率/R²/边际与补充判据（每组合边际 < 单变体完整网格）——**不静默算通过**。
2. **固定池导致闸门必然不满足**：每文件 `materialPalette+textureBlobs ≈40 KB gzip`（T1.4 开放项 2：未按机剪枝），
   而 §9.4 的 4096 B 下限是按"信封头 300–400 B"设的 → `b·N_max ≥ 2·max(a,4096)` 在真实产物上不可满足。已登记 `openItems`。
3. **真实导出 spec 由并行代理开发**：编排按名字 `multiblock-real-acceptance` 调用（`MB_REAL_EXPORTS_DIR` 传入产物归档目录）。
    spec 未落地时该阶段记 `not-run`，"web 装配 = mod 导出"**不得仅凭合成 fixture 判绿**（清单项依赖阶段，自动降级）。
4. **`validate-multiblock-fixtures.mjs --volume` 对真实产物会抛错**（`scaleDocument` 是 fixture 专用放大；
   实测 `装配越界: (0,0,0)=49，调色板长度 39`，触发机 DM/DT 的 `size` 通道）。编排因此**只在 fixture 上**跑 `--volume`。
5. **`scripts/acceptance/.out/` 目前未被 `.gitignore` 覆盖**（写范围限制：本任务不能改 `.gitignore`）→ 建议补一行
   `scripts/acceptance/.out/`（已登记为 openItem）。
6. **超时/挂死**：CoFH conf 缺失（启动静默挂住）由 preflight 拦在进程启动前；客户端阶段另有 `taskkill` 安全网。
   进程等待用 .NET `Process.WaitForExit(ms)`（**不用 `Wait-Process`**：实测在 playwright 大输出场景下会长时间占用 CPU 并卡住编排），
   playwright 的 json 报告也不在 PowerShell 里解析（用例计数交给 `build-report.mjs`）。
7. **`validate-multiblock-fixtures.mjs --volume` 的替代**：契约 k 序列改由 fixture 三份跑（`contract-volume-fixtures.json`），
   真实产物集只跑格式 + 全组合装配。

---

## 6. 分段验证（本任务自检用过）

```powershell
# 单阶段
npm run acceptance:multiblock -- -OnlyStages export-multiblock
npm run acceptance:multiblock -- -OnlyStages volume-curve
npm run acceptance:multiblock -- -OnlyStages web-synthetic-regression
# 用既有产物归档验证 web 半环（不启动游戏）
pwsh -File scripts/acceptance/run-acceptance.ps1 -OnlyStages web-real-acceptance -SeedExportsFrom <既有 exports 目录>
# 样例报告（用既有产物回放，不动游戏、不跑 playwright）
pwsh -File scripts/acceptance/run-acceptance.ps1 -SampleFrom <既有 exports 目录> -Label sample
# 单个分析工具
node scripts/acceptance/volume-curve.mjs --encoded <encodedDir> --products <exportsDir> --out <dir> --profile <profile.json> --contract-report <fixtures k 序列.json>
node scripts/acceptance/falsification.mjs --exports <exportsDir> --out <dir> [--mod-negative <pipeline-result.json>]
node scripts/acceptance/static-checks.mjs --out <dir>/static-checks.json
node scripts/acceptance/build-report.mjs --run-dir <runDir> [--compare-with <report.json>]
```

## 7. 诊断工具（`scripts/acceptance/lib/`）

| 工具 | 用途 |
|---|---|
| `parse-check.ps1 <file.ps1>` | PowerShell 语法检查（编排脚本改动后先跑） |
| `show-report.mjs <report.json>` | 打一份报告摘要（判定 / 清单逐条 / 阶段 / 曲线 / 开放项） |
| `show-gates.mjs <report.json> [checkId…]` | 逐条打印某清单项的 **gates**（定位"为什么红"） |
| `show-pw-failures.mjs <playwright.json>` | 从 playwright json 报告抽失败用例与错误消息 |
| `checklist.mjs` / `evidence.mjs` | §6 清单判据定义 / 公共工具（哈希、快照、阶段片段） |

> **`.out/` 未被 `.gitignore` 覆盖**（写范围限制）：自检后已把大块证据（截图/产物副本/编码器输出）清掉，仅留样例报告（≈3.6 MB）。
> 提交前请加一行 `scripts/acceptance/.out/`（已登记为 openItem）。
