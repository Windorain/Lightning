<#
  Phase 3 验收总入口 —— **一条命令跑通全闭环**（计划 §5「总入口」/ §6「自动化验收」）
  ============================================================================
    npm run acceptance:multiblock                 # 默认子集 5 台（风险 7 裁决，非全量）
    npm run acceptance:multiblock -- -DryRun      # 只做前置检查 + 打印计划
    npm run acceptance:multiblock -- -OnlyStages export-multiblock,volume-curve
    npm run acceptance:multiblock -- -CompareWith scripts/acceptance/.out/acceptance-run1/acceptance-report.json
    npm run acceptance:multiblock -- -SampleFrom scripts/multiblock-pipeline/.out/orches-verify-6/exports -Label sample

  编排（全部零人工交互；任何一步红都不阻断后续，报告里逐条登记）：
    preflight → build-mod-gtnh → falsify-mod-negative → export-multiblock → verify-expanded
    → contract-validate → web-real-acceptance → web-synthetic-regression → web-unit-vitest
    → build-web → volume-curve → web-assembly-cross-check → static-checks
    → falsify-offline-negative → sde-export-interop → evidence-screenshots → report

  退出码（优先级从上到下，第一个命中的即最终退出码）：
    3  前置检查致命（缺 CoFH conf / 缺 T1.2 事实层 / 缺 gradle / 缺 playwright chromium）
    4  mod 半环红（build:mod:gtnh / 导出 / 展开校验 / 契约校验 / mod 负对照 / /sde export 互不干扰）
    5  web 半环红（真实导出 spec / 合成回归 / vitest / build:web）
    6  分析类阶段红（T3.2 体积曲线 / web 装配交叉验证 / 静态判据 / 离线证伪 / 截图归档）
    7  报告汇总失败（未产出 acceptance-report.json）
    2  验收不完整（有阶段 not-run：真实导出 spec 未落地 / 被开关跳过）
    8  幂等：与 -CompareWith 的逐条判定不一致
    9  阶段全绿但 §6 把关清单项判红
    0  全绿

  详细设计、报告 schema、判据映射见 `scripts/acceptance/README.md`。
#>
[CmdletBinding()]
param(
    # 本次运行的标签（归档目录名 = acceptance-<label>）
    [string]$Label = "",
    # 归档根目录
    [string]$OutRoot = "",
    # 导出范围（simpleName/fqcn/slug，逗号分隔）。空 = 管线默认验收子集 5 台
    [string]$Scope = "",
    # 上一次的 acceptance-report.json：逐条比对判定（幂等验收）
    [string]$CompareWith = "",
    # 只做前置检查并打印计划
    [switch]$DryRun,
    # 分段验证：只跑指定阶段（其余记 not-run）
    [string[]]$OnlyStages = @(),
    # 样例模式：用既有产物目录回放生成报告（不启动游戏 / 不跑 playwright；verdict=sample）
    [string]$SampleFrom = "",
    # 分段验证用：把既有产物归档塞进本次运行目录（正式验收不用）
    [string]$SeedExportsFrom = "",
    # 跳过 /sde export 互不干扰阶段
    [switch]$SkipSdeInterop,
    # 跳过证伪阶段（**不建议**：会失去"断言有效性"证据）
    [switch]$SkipFalsification,
    # 跳过全部 web 阶段
    [switch]$SkipWeb,
    # 真实导出 spec 未落地时不判红（仅用于样例/调试；正式验收禁用）
    [switch]$AllowMissingRealSpec,
    # 跳过 gradlew build（复跑时省时间；正式验收禁用）
    [switch]$SkipBuild,
    # 让合成回归也包含真实导出 spec（默认排除：它在自己的阶段里以 --retries=0 跑，重跑一遍要多花 ~12 min）
    [switch]$IncludeRealInSynthetic,
    # 各阶段超时（分钟）
    [int]$ExportTimeoutMinutes = 120,
    [int]$SdeInteropTimeoutMinutes = 25,
    [int]$WebTimeoutMinutes = 45,
    [int]$BuildTimeoutMinutes = 45,
    [int]$VolumeTimeoutMinutes = 30
)

$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
$modDir = Join-Path $repoRoot 'mod\gtnh'
$mcDataDir = Join-Path $modDir 'run\client'
$webDir = Join-Path $repoRoot 'web'

if ([string]::IsNullOrWhiteSpace($OutRoot)) { $OutRoot = Join-Path $scriptDir '.out' }
if ([string]::IsNullOrWhiteSpace($Label)) { $Label = 'run-' + (Get-Date -Format 'yyyyMMdd-HHmmss') }

$runDir = Join-Path $OutRoot ('acceptance-' + $Label)
$logDir = Join-Path $runDir 'logs'
$stagesDir = Join-Path $runDir 'stages'
$webOutDir = Join-Path $runDir 'web'
$volumeDir = Join-Path $runDir 'volume'
$interopDir = Join-Path $runDir 'interop'
$falsifyDir = Join-Path $runDir 'falsification'
$exportsArchive = Join-Path $runDir 'exports'
$pipelineOutRoot = Join-Path $repoRoot 'scripts\multiblock-pipeline\.out'
$liveExportsDir = Join-Path $mcDataDir 'sde_multiblock_exports'
$livePipelineResult = Join-Path $mcDataDir 'sde_multiblock_pipeline_result.json'
$structureExportsDir = Join-Path $mcDataDir 'structure_exports'
$fixtureOutReport = Join-Path $repoRoot 'scripts\multiblock-fixtures\.out\validation-report.json'

foreach ($d in @($runDir, $logDir, $stagesDir, $webOutDir, $volumeDir, $interopDir, $falsifyDir)) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}

$script:stageResults = [ordered]@{}
$script:stageOrder = @()
# `-OnlyStages a,b,c` 在 `pwsh -File` / `npm run ... -- ` 下可能整体作为单个字符串传入 → 统一拆分
$script:onlyStageList = @()
foreach ($s in $OnlyStages) { foreach ($p in ($s -split ',')) { if ($p.Trim()) { $script:onlyStageList += $p.Trim() } } }
$script:interactivity = [ordered]@{
    mode            = if ($SampleFrom) { 'sample' } else { 'acceptance' }
    singleCommand   = $true
    command         = 'npm run acceptance:multiblock' + ($(if ($Label) { " -- -Label $Label" } else { '' }))
    prompts         = 0
    stdinRedirected = $true
    webHeadless     = $true
    note            = '全部子进程 stdin 重定向为 ignore；无任何交互提示（计划 §6「自动化验收」）'
}
$script:openItems = @(
    [ordered]@{ id = 'scope-not-full'; severity = 'info'; text = '验收范围 = 默认子集 5 台（风险 7 裁决，非全量）；全量估算 ≈32 h@默认上限 / ≈431 h@不裁剪，需用户裁定（子集验收 / 分片并行 / 下调上限）。' },
    [ordered]@{ id = 'r2-criterion-applicability'; severity = 'info'; text = 'R2 的常数项闸门 `b·N_max ≥ 2·max(a,4096)` 在真实产物上不可满足：每文件 materialPalette+textureBlobs 池 ≈40 KB gzip（T1.4 开放项 2：未按机剪枝），而 §9.4 的 4096 B 下限按"信封头 300–400 B"设的。故 R2 的**正式判定落在契约 k 序列**（fixture 通道域 ×1/×2/×4/×8），真实序列上给出斜率/R²/边际＋补充判据（每组合边际 < 单变体完整网格、截距主要来自固定池）——不静默算通过，请调度者知悉/裁决。' },
    [ordered]@{ id = 'fixed-pool-unpruned'; severity = 'info'; text = '每份产物都带全套 materialPalette/textureBlobs（≈40 KB gzip）；T1.4 开放项 2 记录"按机剪枝可省 31–55 KB/文件"，属独立任务。' },
    [ordered]@{ id = 'sde-interop-two-sessions'; severity = 'info'; text = '/sde export 与 multiblock 导出是**同一专用世界的两次顺序客户端会话**（tick 分派优先级使单会话内无法兼跑，不改 mod 无法合并）；互不干扰判据（产物目录快照 + 基线哈希）不受影响。' },
    [ordered]@{ id = 'gitignore-acceptance-out'; severity = 'info'; text = '已解决：`.gitignore` 已含 `scripts/acceptance/.out/`，运行证据（可达 100+ MB）不会被 `git add -A` 带进仓库；本任务同时把归档文档 `volume-profile-result.md` 从仓库树移到该证据目录。' }
)
$script:adjudications = @(
    [ordered]@{ id = 'T3.2-control-export-via-offline-encoder'; text = 'T3.2 的对照导出走离线编码（MultiblockFactorizeTool 对捕获数据集做域子集重编码，与生产同一 Java 编码器），不做多轮游戏内对照导出（每轮 2.5min 且编码路径相同）。'; source = '调度者裁决' },
    [ordered]@{ id = 'T3.4-sde-export-same-world'; text = '/sde export 互不干扰：同世界先后执行 /sde export 与 multiblock 导出，断言 /sde export 产物与基线哈希一致、两套产物目录互不影响。'; source = '调度者裁决' },
    [ordered]@{ id = 'scope-default-subset-5'; text = '验收范围 = 默认子集 5 台（风险 7 裁决）；报告中显式标注"非全量"并给出全量估算（32h@上限 / 431h@不裁剪）。'; source = '调度者裁决' }
)

function Write-Step([string]$msg) { Write-Host "== [acceptance] $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host "   OK  $msg" -ForegroundColor Green }
function Write-Warn2([string]$msg) { Write-Host "   !!  $msg" -ForegroundColor Yellow }
function Write-Err2([string]$msg) { Write-Host "   XX  $msg" -ForegroundColor Red }

$script:npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue) ?? (Get-Command npm -ErrorAction SilentlyContinue).Source
$script:npxCmd = (Get-Command npx.cmd -ErrorAction SilentlyContinue) ?? (Get-Command npx -ErrorAction SilentlyContinue).Source
$script:nodeCmd = (Get-Command node -ErrorAction SilentlyContinue).Source
$script:pwshCmd = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
$script:gradlew = Join-Path $modDir 'gradlew.bat'
# 合成回归的选取：`multiblock-` 全部 spec，但**默认排除**真实导出 spec
# （它有自己的阶段：MB_REAL_EXPORTS_DIR + --retries=0 + ~12 min；`npm run test:e2e:multiblock` 会把它一起带上）
$SyntheticPattern = if ($IncludeRealInSynthetic) { 'multiblock-' } else { 'multiblock-(?!real-acceptance)' }

# ---------------------------------------------------------------------------
# 通用：进程执行（stdout/stderr 落文件，超时杀进程树）
# ---------------------------------------------------------------------------
function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [Parameter(Mandatory = $true)][string]$WorkDir,
        [Parameter(Mandatory = $true)][string]$LogPath,
        [int]$TimeoutSec = 1800,
        [hashtable]$ExtraEnv = @{}
    )
    $saved = @{}
    foreach ($k in $ExtraEnv.Keys) {
        $saved[$k] = [Environment]::GetEnvironmentVariable($k)
        [Environment]::SetEnvironmentVariable($k, [string]$ExtraEnv[$k])
    }
    $errPath = "$LogPath.err"
    $started = Get-Date
    $timedOut = $false
    $code = -1
    try {
        $proc = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $WorkDir `
            -NoNewWindow -PassThru -RedirectStandardOutput $LogPath -RedirectStandardError $errPath
        # 用 .NET 的 WaitForExit(int) 而不是 Wait-Process：后者在大输出/多进程场景下会长时间占用 CPU
        $exited = $proc.WaitForExit($TimeoutSec * 1000)
        if (-not $exited) {
            $timedOut = $true
            Write-Err2 "阶段超时（${TimeoutSec}s），杀进程树 pid=$($proc.Id)"
            & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null
            $proc.WaitForExit(30000) | Out-Null
        }
        $proc.Refresh()
        $code = if ($proc.HasExited) { $proc.ExitCode } else { -1 }
    } catch {
        $code = -1
        Write-Err2 "启动失败：$FilePath $($ArgumentList -join ' ') → $($_.Exception.Message)"
    } finally {
        foreach ($k in $ExtraEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
    }
    $elapsed = (Get-Date) - $started
    return [ordered]@{
        exitCode  = [int]$code
        timedOut  = $timedOut
        logPath   = $LogPath
        elapsedMs = [int]$elapsed.TotalMilliseconds
        stdOut    = if (Test-Path $LogPath) { Get-Content $LogPath -Raw } else { '' }
        stdErr    = if (Test-Path $errPath) { Get-Content $errPath -Raw } else { '' }
    }
}

function Write-StageFragment {
    param(
        [string]$Id, [string]$Name, [string]$Command, [string]$Status, [Nullable[int]]$ExitCode,
        [int]$DurationMs, [string]$StartedAt, [string]$EndedAt,
        [array]$Gates = @(), [array]$Artifacts = @(), [array]$Evidence = @(),
        [hashtable]$Data = @{}, [array]$Notes = @()
    )
    $frag = [ordered]@{
        id = $Id; name = $Name; command = $Command; cwd = $repoRoot; startedAt = $StartedAt; endedAt = $EndedAt
        durationMs = $DurationMs; exitCode = $ExitCode; status = $Status
        gates = $Gates; artifacts = $Artifacts; evidence = $Evidence; data = $Data; notes = $Notes
    }
    $path = Join-Path $stagesDir "$Id.json"
    Set-Content -Path $path -Value ($frag | ConvertTo-Json -Depth 10) -Encoding utf8NoBOM
    $script:stageResults[$Id] = $frag
    $script:stageOrder += $Id
    return $frag
}

function Test-StageEnabled([string]$Id) {
    if ($script:onlyStageList.Count -eq 0) { return $true }
    return ($script:onlyStageList -contains $Id)
}

function Get-GateStatus([array]$Gates) {
    if ($Gates.Count -eq 0) { return 'pass' }
    if (($Gates | Where-Object { -not $_.ok }).Count -gt 0) { return 'fail' }
    return 'pass'
}

function Invoke-StageSkipped([string]$Id, [string]$Name, [string]$Reason) {
    Write-Warn2 "$Id 跳过：$Reason"
    Write-StageFragment -Id $Id -Name $Name -Command '' -Status 'not-run' -ExitCode $null -DurationMs 0 `
        -StartedAt (Get-Date).ToString('o') -EndedAt (Get-Date).ToString('o') -Gates @() -Notes @($Reason) | Out-Null
}

# ---------------------------------------------------------------------------
# 阶段 1：前置检查
# ---------------------------------------------------------------------------
function Invoke-Preflight {
    $t0 = Get-Date
    $gates = @()
    $evidence = @()

    $gates += @{ name = 'gradlew.bat 存在'; ok = (Test-Path $script:gradlew); detail = $script:gradlew }
    $gates += @{ name = 'node / npm / npx / pwsh 可用'; ok = ($script:nodeCmd -and $script:npmCmd -and $script:npxCmd -and $script:pwshCmd); detail = "node=$($script:nodeCmd)" }
    $gates += @{ name = 'web/node_modules 已安装'; ok = (Test-Path (Join-Path $webDir 'node_modules')); detail = 'web/node_modules' }

    # CoFH MCP conf：判据是"目录里真有 *.srg"
    $confRoots = @()
    if ($env:USERPROFILE) { $confRoots += (Join-Path $env:USERPROFILE '.gradle') }
    if ($env:GRADLE_USER_HOME) { $confRoots += $env:GRADLE_USER_HOME }
    $confHit = $null
    foreach ($root in $confRoots) {
        $forgeDir = Join-Path $root 'caches\minecraft\net\minecraftforge\forge'
        if (-not (Test-Path $forgeDir)) { continue }
        Get-ChildItem $forgeDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $conf = Join-Path $_.FullName 'unpacked\conf'
            if ((Test-Path $conf) -and (Get-ChildItem $conf -Filter '*.srg' -File -ErrorAction SilentlyContinue)) {
                if (-not $confHit) { $confHit = $conf }
            }
        }
    }
    $gates += @{ name = 'CoFH MCP conf（含 .srg）'; ok = [bool]$confHit; detail = "$confHit" }

    # T1.2 事实层
    $scanRoot = Join-Path $mcDataDir 'multiblock_scan'
    $facts = if (Test-Path $scanRoot) {
        Get-ChildItem $scanRoot -Directory -Filter 'run-*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'machines.json' } | Where-Object { Test-Path $_ }
    } else { @() }
    $gates += @{ name = 'T1.2 枚举事实层（machines.json）'; ok = ($facts.Count -gt 0); detail = "$($facts | Select-Object -First 1)" }

    # playwright chromium
    $pwRoots = @("$env:LOCALAPPDATA\ms-playwright", "$env:USERPROFILE\AppData\Local\ms-playwright")
    $pwHit = $null
    foreach ($r in $pwRoots) {
        if (Test-Path $r) {
            $hit = Get-ChildItem $r -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'chromium*' } | Select-Object -First 1
            if ($hit -and -not $pwHit) { $pwHit = $hit.FullName }
        }
    }
    $gates += @{ name = 'playwright chromium 已安装'; ok = [bool]$pwHit; detail = "$pwHit" }

    # 编译产物（T3.2 的离线编码器需要 classes）
    $classes = Join-Path $modDir 'build\classes\java\main\com\lightning\mod\client\multiblock\MultiblockFactorizeTool.class'
    $gates += @{ name = '编码器已编译（build-mod-gtnh 阶段会补）'; ok = (Test-Path $classes); detail = "build/classes/.../MultiblockFactorizeTool.class" }

    $gitHead = (& git -C $repoRoot rev-parse HEAD 2>$null)
    $gitDirty = (& git -C $repoRoot status --porcelain 2>$null | Measure-Object -Line).Lines

    # 端口 5199 争用探测（**非致命**）：本编排的 playwright 与外部 playwright 共用
    # `web/playwright.config.ts` 的 webServer（reuseExistingServer=true）→ 外部进程退出时会把
    # 本编排复用的 vite 一起关掉（实测：11 个用例 ERR_CONNECTION_REFUSED）。这里只登记事实。
    $portInUse = $false
    try {
        $conn = Get-NetTCPConnection -LocalPort 5199 -State Listen -ErrorAction SilentlyContinue
        $portInUse = [bool]$conn
    } catch { $portInUse = $false }
    if ($portInUse) {
        Write-Warn2 '端口 5199 已有服务在监听（可能来自外部 playwright/vite）→ 串联纪律：不要与其它 playwright 并发跑本次验收'
        $script:openItems += [ordered]@{
            id = 'port-5199-contention'; severity = 'info'
            text = '启动前置检查时端口 5199 已被占用：本编排的 playwright 会复用该 webServer（reuseExistingServer=true），若外部进程在本次运行中退出，会把复用的 vite 关掉 → 用例报 ERR_CONNECTION_REFUSED（非判据失败）。**须串行运行**（确认无其它 playwright 在跑）。'
        }
    }

    $status = Get-GateStatus $gates
    # preflight 结果必须落盘于运行目录（「无口头结论」机器门禁要求每个阶段有证据文件）
    $preLog = Join-Path $logDir 'preflight.log'
    $preLines = @("preflight gates @ $(Get-Date -Format o)")
    foreach ($g in $gates) { $preLines += ("[{0}] {1} :: {2}" -f $(if ($g.ok) { 'OK' } else { 'FAIL' }), $g.name, $g.detail) }
    [System.IO.File]::WriteAllLines($preLog, $preLines)
    $frag = Write-StageFragment -Id 'preflight' -Name '前置检查（playwright / CoFH conf / T1.2 事实层 / 构建产物）' `
        -Command 'internal' -Status $status -ExitCode $(if ($status -eq 'pass') { 0 } else { 3 }) `
        -DurationMs ([int]((Get-Date) - $t0).TotalMilliseconds) -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') `
        -Gates $gates -Evidence @($preLog) -Data @{ confHit = "$confHit"; facts = "$($facts | Select-Object -First 1)"; playwright = "$pwHit"; gitHead = "$gitHead"; gitDirtyLines = $gitDirty; port5199InUse = $portInUse }
    foreach ($g in $gates) { if ($g.ok) { Write-Ok $g.name } else { Write-Err2 "$($g.name)：$($g.detail)" } }
    return $frag
}

# ---------------------------------------------------------------------------
# 阶段：mod 半环
# ---------------------------------------------------------------------------
function Invoke-BuildMod {
    $t0 = Get-Date
    $log = Join-Path $logDir 'build-mod-gtnh.log'
    Write-Step "build:mod:gtnh（gradlew build，含 spotless）"
    $r = Invoke-Native -FilePath $script:gradlew -ArgumentList @('build', '--console=plain') -WorkDir $modDir -LogPath $log -TimeoutSec ($BuildTimeoutMinutes * 60)
    $ok = ($r.exitCode -eq 0 -and -not $r.timedOut)
    $gates = @(@{ name = 'gradlew build 退出码 0'; ok = $ok; detail = "exit=$($r.exitCode) timeout=$($r.timedOut)" })
    if ($ok) { Write-Ok "gradlew build 通过（$([int]($r.elapsedMs / 1000))s）" } else { Write-Err2 "gradlew build 失败（exit=$($r.exitCode)）" }
    return Write-StageFragment -Id 'build-mod-gtnh' -Name 'gradlew build（mod 工程纪律 + T3.2 编码器编译）' `
        -Command 'cd mod/gtnh && ./gradlew build' -Status (Get-GateStatus $gates) -ExitCode $r.exitCode `
        -DurationMs $r.elapsedMs -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') -Gates $gates `
        -Artifacts @('mod/gtnh/build/libs') -Evidence @($log) -Data @{ timedOut = $r.timedOut }
}

function Invoke-FalsifyModNegative {
    $t0 = Get-Date
    $label = "$Label-falsify"
    $log = Join-Path $logDir 'falsify-mod-negative.log'
    Write-Step "证伪（mod 半环）：未知机器必须退出码 2 + 原因落盘"
    $r = Invoke-Native -FilePath $script:pwshCmd -ArgumentList @('-NoProfile', '-File', (Join-Path $repoRoot 'scripts\multiblock-pipeline\run-pipeline.ps1'), '-Label', $label, '-Scope', 'MTENoSuchMachineT16', '-ProcessTimeoutMinutes', '15') `
        -WorkDir $repoRoot -LogPath $log -TimeoutSec (20 * 60)
    $resultPath = Join-Path $pipelineOutRoot "$label\pipeline-result.json"
    $result = if (Test-Path $resultPath) { Get-Content $resultPath -Raw | ConvertFrom-Json } else { $null }
    $unknown = if ($result) { @($result.failures | Where-Object { $_.kind -eq 'UnknownMachine' -and $_.stage -eq 'scope' }).Count } else { 0 }
    $gates = @(
        @{ name = '故意失败轮退出码 = 2'; ok = ($r.exitCode -eq 2); detail = "exit=$($r.exitCode)" },
        @{ name = '原因落盘（scope/UnknownMachine）'; ok = ($unknown -gt 0); detail = "UnknownMachine=$unknown" },
        @{ name = '未产出产物（不存在静默通过）'; ok = ($result -and @($result.products).Count -eq 0); detail = "products=$(@($result.products).Count)" }
    )
    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok "mod 负对照按预期变红（退出码 2 + 原因落盘）" } else { Write-Err2 "mod 负对照未按预期变红 → 判定式可能恒绿" }
    # 该轮的 pipeline-result 既作为证伪证据，也交给 falsification.mjs
    $copy = Join-Path $falsifyDir 'mod-negative-pipeline-result.json'
    if (Test-Path $resultPath) { Copy-Item -Force $resultPath $copy }
    return Write-StageFragment -Id 'falsify-mod-negative' -Name '证伪：mod 半环未知机器（退出码 2 + 原因落盘）' `
        -Command "pwsh -File scripts/multiblock-pipeline/run-pipeline.ps1 -Label $label -Scope MTENoSuchMachineT16" `
        -Status $status -ExitCode $r.exitCode -DurationMs $r.elapsedMs -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') `
        -Gates $gates -Evidence @($log, $copy) -Data @{ pipelineResult = $copy; kinds = @($result.failures | ForEach-Object { "$($_.stage)/$($_.kind)" }) }
}

function Invoke-ExportMultiblock {
    $t0 = Get-Date
    $exportLabel = "$Label-export"
    $log = Join-Path $logDir 'export-multiblock.log'
    $args = @('-NoProfile', '-File', (Join-Path $repoRoot 'scripts\multiblock-pipeline\run-pipeline.ps1'), '-Label', $exportLabel,
        '-ProcessTimeoutMinutes', "$ExportTimeoutMinutes")
    $scopeList = @()
    foreach ($s in ($Scope -split ',')) { if ($s.Trim()) { $scopeList += $s.Trim() } }
    if ($scopeList.Count -gt 0) { $args += @('-Scope', ($scopeList -join ',')) }
    Write-Step "真实导出（npm run multiblock:export → $exportLabel）"
    $r = Invoke-Native -FilePath $script:pwshCmd -ArgumentList $args -WorkDir $repoRoot -LogPath $log -TimeoutSec (($ExportTimeoutMinutes + 10) * 60)

    $resultPath = Join-Path $pipelineOutRoot "$exportLabel\pipeline-result.json"
    $result = if (Test-Path $resultPath) { Get-Content $resultPath -Raw | ConvertFrom-Json } else { $null }

    # 归档产物（archiveRoot 里的 exports 即 run-pipeline 的归档副本）
    if (Test-Path (Join-Path $pipelineOutRoot "$exportLabel\exports")) {
        if (Test-Path $exportsArchive) { Remove-Item -Recurse -Force $exportsArchive }
        New-Item -ItemType Directory -Force -Path $exportsArchive | Out-Null
        Get-ChildItem (Join-Path $pipelineOutRoot "$exportLabel\exports") -Force | ForEach-Object {
            Copy-Item -Recurse -Force $_.FullName $exportsArchive
        }
    }
    if (Test-Path $resultPath) { Copy-Item -Force $resultPath (Join-Path $runDir 'pipeline-result.json') }
    $archiveLog = Join-Path $pipelineOutRoot "$exportLabel\gradle-runClient.log"
    if (Test-Path $archiveLog) { Copy-Item -Force $archiveLog (Join-Path $logDir 'export-gradle-runClient.log') }

    $products = if ($result) { @($result.products) } else { @() }
    $expanded = if ($result) { $result.expanded } else { $null }
    # 门禁口径 = **范围内**失败（T1.6 §7 开放项 2：T1.2 的 2 条 slug 碰撞恒为"范围外失败"，不隐藏但不算门禁）
    $inScopeFail = if ($result) { $result.inScopeFailureCount } else { -1 }
    $outScopeFail = if ($result) { $result.outOfScopeFailureCount } else { -1 }
    $gates = @(
        @{ name = '管线退出码 0'; ok = ($r.exitCode -eq 0); detail = "exit=$($r.exitCode) timeout=$($r.timedOut)" },
        @{ name = '结构化结果文件已产出'; ok = [bool]$result; detail = "$resultPath" },
        @{ name = '产物 5 份（默认子集）'; ok = ($products.Count -eq 5 -or $scopeList.Count -gt 0); detail = "products=$($products.Count)" },
        @{ name = '展开校验文件已产出（>0 组合）'; ok = ($expanded -and $expanded.files -gt 0); detail = "expanded=$($expanded.files)" },
        @{ name = '范围内失败 0 条'; ok = ($inScopeFail -eq 0); detail = "inScope=$inScopeFail outOfScope=$outScopeFail" }
    )
    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok "导出全绿：$($products.Count) 台 / 变体 $($result.variantsTested) / 展开文件 $($expanded.files)" }
    else { Write-Err2 "导出红（见 $log 与 pipeline-result.json）" }
    return Write-StageFragment -Id 'export-multiblock' -Name '真实导出：/sde multiblock（默认子集 5 台）+ 展开校验文件' `
        -Command ($args -join ' ') -Status $status -ExitCode $r.exitCode -DurationMs $r.elapsedMs `
        -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') -Gates $gates `
        -Artifacts @($exportsArchive) -Evidence @($log, (Join-Path $runDir 'pipeline-result.json')) `
        -Data @{ exportLabel = $exportLabel; products = $products; expanded = $expanded; timing = $result.timing; captureTotals = $result.timing.captureTotals; environment = $result.environment; warnings = @($result.warnings) }
}

function Invoke-VerifyExpanded {
    $t0 = Get-Date
    $log = Join-Path $logDir 'verify-expanded.log'
    Write-Step "展开校验文件 vs 产物装配逐格 diff（T3.3 mod 半环）"
    $r = Invoke-Native -FilePath $script:nodeCmd -ArgumentList @((Join-Path $repoRoot 'scripts\multiblock-pipeline\verify-expanded.mjs'), $exportsArchive) `
        -WorkDir $repoRoot -LogPath $log -TimeoutSec 900
    $reportPath = Join-Path $exportsArchive 'expanded\expanded-verification-report.json'
    $report = if (Test-Path $reportPath) { Get-Content $reportPath -Raw | ConvertFrom-Json } else { $null }
    $target = Join-Path $runDir 'verify-expanded.json'
    if ($report) { Copy-Item -Force $reportPath $target }
    $gates = @(
        @{ name = '脚本退出码 0'; ok = ($r.exitCode -eq 0); detail = "exit=$($r.exitCode)" },
        @{ name = '逐格 diff = 0'; ok = ($report -and $report.totalDiff -eq 0); detail = "totalDiff=$($report.totalDiff)" },
        @{ name = '硬失败 0 条'; ok = ($report -and @($report.failures).Count -eq 0); detail = "failures=$(@($report.failures).Count)" },
        @{ name = '抽样组合 > 0'; ok = ($report -and $report.samples -gt 0); detail = "samples=$($report.samples) cells=$($report.cells)" }
    )
    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok "逐格 diff=0（$($report.samples) 组合 / $($report.cells) 格）" } else { Write-Err2 "逐格 diff 红" }
    return Write-StageFragment -Id 'verify-expanded' -Name '展开校验文件 vs 参考装配逐格 diff（T3.3 mod 半环）' `
        -Command "node scripts/multiblock-pipeline/verify-expanded.mjs $exportsArchive" -Status $status -ExitCode $r.exitCode `
        -DurationMs $r.elapsedMs -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') -Gates $gates `
        -Artifacts @($target) -Evidence @($log) -Data @{ samples = $report.samples; cells = $report.cells; totalDiff = $report.totalDiff; machines = $report.machines; results = $report.results; warnings = @($report.warnings) }
}

function Invoke-ContractValidate {
    $t0 = Get-Date
    $log = Join-Path $logDir 'contract-validate.log'
    Write-Step "T0.5 契约校验器（格式 + 全组合装配；产物集不跑 --volume——见下）"
    # 校验器把报告写到固定路径 → 先备份，跑完还原（不污染 T0.5 的既有证据）
    $backup = $null
    if (Test-Path $fixtureOutReport) { $backup = [System.IO.File]::ReadAllBytes($fixtureOutReport) }
    # **关键**：跑之前必须移走旧报告，否则崩溃时会读到上一轮的陈旧报告（静默通过）
    if (Test-Path $fixtureOutReport) { Remove-Item -Force $fixtureOutReport }

    $files = Get-ChildItem $exportsArchive -Filter '*.multiblock.json' -File | ForEach-Object { $_.FullName }
    $r = Invoke-Native -FilePath $script:nodeCmd -ArgumentList (@((Join-Path $repoRoot 'scripts\multiblock-fixtures\validate-multiblock-fixtures.mjs')) + $files) `
        -WorkDir $repoRoot -LogPath $log -TimeoutSec 900
    $report = if (Test-Path $fixtureOutReport) { Get-Content $fixtureOutReport -Raw | ConvertFrom-Json } else { $null }
    $target = Join-Path $runDir 'contract-validation.json'
    if ($report) { Copy-Item -Force $fixtureOutReport $target }

    # ---- 契约 k 序列（R2 的正式判定落点）：对契约 fixture 做 --volume ----
    $fixtureFiles = Get-ChildItem (Join-Path $webDir 'src\context\__tests__\fixtures') -Filter 'multiblock-*.json' -File |
        ForEach-Object { $_.FullName }
    $volLog = Join-Path $logDir 'contract-volume-fixtures.log'
    if (Test-Path $fixtureOutReport) { Remove-Item -Force $fixtureOutReport }
    $rv = Invoke-Native -FilePath $script:nodeCmd -ArgumentList (@((Join-Path $repoRoot 'scripts\multiblock-fixtures\validate-multiblock-fixtures.mjs')) + $fixtureFiles + @('--volume')) `
        -WorkDir $repoRoot -LogPath $volLog -TimeoutSec 900
    $volReport = if (Test-Path $fixtureOutReport) { Get-Content $fixtureOutReport -Raw | ConvertFrom-Json } else { $null }
    $volTarget = Join-Path $runDir 'contract-volume-fixtures.json'
    if ($volReport) { Copy-Item -Force $fixtureOutReport $volTarget }
    if ($backup) { [System.IO.File]::WriteAllBytes($fixtureOutReport, $backup) }

    $failures = if ($report) { $report.failures } else { -1 }
    $warnings = if ($report) { $report.warnings } else { -1 }
    $volumePass = if ($volReport -and $volReport.volume) { (@($volReport.volume) | Where-Object { -not $_.pass }).Count -eq 0 } else { $false }
    $gates = @(
        @{ name = '产物集校验脚本退出码 0（无硬失败）'; ok = ($r.exitCode -eq 0); detail = "exit=$($r.exitCode)（报告存在=$([bool]$report)）" },
        @{ name = '产物集硬失败 0 条'; ok = ($failures -eq 0); detail = "failures=$failures warnings=$warnings" },
        @{ name = '契约 k 序列（fixture --volume）判定脚本退出码 0'; ok = ($rv.exitCode -eq 0); detail = "exit=$($rv.exitCode)" },
        @{ name = '契约 k 序列全通过（R2 的判定落点）'; ok = $volumePass; detail = "files=$(@($volReport.volume).Count) 全过=$volumePass" }
    )
    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok "契约校验全绿（产物集失败 0 / 警告 $warnings）；k 序列 $(@($volReport.volume).Count) 份全过" }
    else { Write-Err2 "契约校验红（exit=$($r.exitCode) failures=$failures kSequence=$volumePass）" }
    return Write-StageFragment -Id 'contract-validate' -Name 'T0.5 契约校验器（产物集格式/全组合装配 + 契约 k 序列 --volume）' `
        -Command 'node scripts/multiblock-fixtures/validate-multiblock-fixtures.mjs <5 产物>; node ... <3 fixture> --volume' `
        -Status $status -ExitCode $r.exitCode -DurationMs ([int]((Get-Date) - $t0).TotalMilliseconds) `
        -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') -Gates $gates `
        -Artifacts @($target, $volTarget) -Evidence @($log, $volLog) `
        -Data @{ failures = $failures; warnings = $warnings; checks = $report.checks; volumePass = $volumePass; kSequence = @($volReport.volume | ForEach-Object { @{ file = $_.file; pass = $_.pass; fit = $_.fit } }) }
}

# ---------------------------------------------------------------------------
# 阶段：web 半环
# ---------------------------------------------------------------------------
function Get-RealAcceptanceSpec {
    $matches = Get-ChildItem (Join-Path $webDir 'e2e') -Filter '*.spec.ts' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like '*real-acceptance*' }
    return $matches
}

<#
  说明：playwright 的 json 报告**不在 PowerShell 里解析**（大 JSON + 递归在 pwsh 里既慢又易卡），
  阶段只判「退出码 + 报告落盘」；用例级 passed/failed 计数由 `build-report.mjs`（Node）解析后写进验收报告。
  另一个纪律：真实导出 spec 必须 `--retries=0`（禁止"重试到绿"，见 spec 头部第 7 条）。
#>

function Invoke-Playwright {
    param([string]$Id, [string]$Name, [string]$Pattern, [string]$JsonOut, [int]$TimeoutMinutes, [hashtable]$ExtraEnv = @{}, [switch]$NoRetries)
    $t0 = Get-Date
    $log = Join-Path $logDir "$Id.log"
    Write-Step "$Name（node playwright test $Pattern$(if ($NoRetries) { ' --retries=0' })）"
    $env2 = @{ PLAYWRIGHT_JSON_OUTPUT_NAME = $JsonOut }
    foreach ($k in $ExtraEnv.Keys) { $env2[$k] = $ExtraEnv[$k] }
    # **直调 node + playwright CLI**（不走 npx.cmd）：cmd.exe 会吞掉模式里的 `(`/`!`/`)`，
    # 实测会把 `multiblock-(?!real-acceptance)` 退化成 `multiblock-`（把 12 min 的真实导出 spec 也带上）。
    $pwCli = Join-Path $webDir 'node_modules\@playwright\test\cli.js'
    $pwArgs = @($pwCli, 'test', $Pattern, '--reporter=json')
    if ($NoRetries) { $pwArgs += '--retries=0' }
    $r = Invoke-Native -FilePath $script:nodeCmd -ArgumentList $pwArgs `
        -WorkDir $webDir -LogPath $log -TimeoutSec ($TimeoutMinutes * 60) -ExtraEnv $env2
    $json = if (Test-Path $JsonOut) { $true } else { $false }
    if (-not $json -and $r.stdOut) {
        # 兜底：json reporter 有时写 stdout
        $idx = $r.stdOut.IndexOf('{')
        if ($idx -ge 0) { Set-Content -Path $JsonOut -Value $r.stdOut.Substring($idx) -Encoding utf8NoBOM; $json = $true }
    }
    return [ordered]@{ t0 = $t0; log = $log; result = $r; json = $json; jsonPath = $JsonOut }
}

function Invoke-WebRealAcceptance {
    if ($SkipWeb) { Invoke-StageSkipped 'web-real-acceptance' '真实导出 spec（T3.1/T3.3 web 半环）' '被 -SkipWeb 跳过'; return }
    $specs = Get-RealAcceptanceSpec
    if ($specs.Count -eq 0) {
        $msg = "web/e2e/multiblock-real-acceptance.spec.ts 尚未落地（由并行代理开发中）；本阶段记 not-run，清单项 web/assembly-equals-mod 不得判绿"
        Invoke-StageSkipped 'web-real-acceptance' '真实导出 spec（T3.1/T3.3 web 半环）' $msg
        $script:openItems += [ordered]@{ id = 'real-acceptance-spec-missing'; severity = $(if ($AllowMissingRealSpec) { 'info' } else { 'blocking' }); text = $msg }
        return
    }
    $jsonPath = Join-Path $webOutDir 'real-acceptance.json'
    $res = Invoke-Playwright -Id 'web-real-acceptance' -Name "真实导出 spec（MB_REAL_EXPORTS_DIR=$exportsArchive）" `
        -Pattern 'multiblock-real-acceptance' -JsonOut $jsonPath -TimeoutMinutes $WebTimeoutMinutes `
        -ExtraEnv @{ MB_REAL_EXPORTS_DIR = $exportsArchive } -NoRetries
    $r = $res.result
    # 外部 playwright/vite 争用的显式诊断（否则会被误读为判据失败）
    $foreign = [bool](Select-String -Path $res.log -Pattern 'ERR_CONNECTION_REFUSED|ECONNREFUSED' -Quiet -ErrorAction SilentlyContinue)
    $notes = @()
    if ($foreign) {
        $notes += '检测到 ERR_CONNECTION_REFUSED：端口 5199 的 webServer 被外部进程关闭（本编排复用了外部 playwright 的 vite）→ 本次 web 结果不可信，须在无其它 playwright 运行时串行重跑'
        $script:openItems += [ordered]@{ id = 'web-server-killed-externally'; severity = 'blocking'; text = "$Id 阶段出现 ERR_CONNECTION_REFUSED（端口 5199 服务被外部进程关闭）；结果判红并需串行重跑。" }
        Write-Err2 '检测到 ERR_CONNECTION_REFUSED（外部 playwright/vite 争用）→ 需串行重跑'
    }
    $gates = @(
        @{ name = 'playwright 退出码 0'; ok = ($r.exitCode -eq 0); detail = "exit=$($r.exitCode) timeout=$($r.timedOut)" },
        @{ name = 'json 报告已产出'; ok = (Test-Path $jsonPath); detail = $jsonPath },
        @{ name = '未被外部 webServer 争用（无 ERR_CONNECTION_REFUSED）'; ok = (-not $foreign); detail = "foreign=$foreign" }
    )
    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok "真实导出 spec 全绿（详见 json 报告）" } else { Write-Err2 "真实导出 spec 红（exit=$($r.exitCode)）" }
    Write-StageFragment -Id 'web-real-acceptance' -Name '真实导出 spec（T3.1 截图/像素 + T3.3 逐格 diff）' `
        -Command "cd web && node node_modules/@playwright/test/cli.js test multiblock-real-acceptance --retries=0（MB_REAL_EXPORTS_DIR=$exportsArchive）" `
        -Status $status -ExitCode $r.exitCode -DurationMs $r.elapsedMs -StartedAt $res.t0.ToString('o') -EndedAt (Get-Date).ToString('o') `
        -Gates $gates -Artifacts @($jsonPath) -Evidence @($res.log) -Data @{ reportJson = $jsonPath; specFile = $specs[0].Name; retries = 0; foreignServerKilled = $foreign } -Notes $notes | Out-Null
}

function Invoke-WebSynthetic {
    if ($SkipWeb) { Invoke-StageSkipped 'web-synthetic-regression' '合成 fixture 全量回归（含帧为主 + 证伪）' '被 -SkipWeb 跳过'; return }
    $jsonPath = Join-Path $webOutDir 'synthetic.json'
    $res = Invoke-Playwright -Id 'web-synthetic-regression' -Name '合成 fixture 全量回归（排除真实导出 spec；见 -IncludeRealInSynthetic）' `
        -Pattern $SyntheticPattern -JsonOut $jsonPath -TimeoutMinutes $WebTimeoutMinutes
    $r = $res.result
    $foreign = [bool](Select-String -Path $res.log -Pattern 'ERR_CONNECTION_REFUSED|ECONNREFUSED' -Quiet -ErrorAction SilentlyContinue)
    $gates = @(
        @{ name = 'playwright 退出码 0'; ok = ($r.exitCode -eq 0); detail = "exit=$($r.exitCode) timeout=$($r.timedOut)" },
        @{ name = 'json 报告已产出'; ok = (Test-Path $jsonPath); detail = $jsonPath },
        @{ name = '未被外部 webServer 争用（无 ERR_CONNECTION_REFUSED）'; ok = (-not $foreign); detail = "foreign=$foreign" }
    )
    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok '合成回归全绿（用例计数见 json 报告）' } else { Write-Err2 "合成回归红（exit=$($r.exitCode)）" }
    Write-StageFragment -Id 'web-synthetic-regression' -Name '合成 fixture 全量回归（帧为主回归 + 通道面板/遍历/非法 + 证伪 spec）' `
        -Command "cd web && npx playwright test $SyntheticPattern" -Status $status -ExitCode $r.exitCode -DurationMs $r.elapsedMs `
        -StartedAt $res.t0.ToString('o') -EndedAt (Get-Date).ToString('o') -Gates $gates -Artifacts @($jsonPath) -Evidence @($res.log) `
        -Data @{ reportJson = $jsonPath; pattern = $SyntheticPattern } | Out-Null
}

function Invoke-WebUnit {
    if ($SkipWeb) { Invoke-StageSkipped 'web-unit-vitest' 'vitest 单元测试' '被 -SkipWeb 跳过'; return }
    $t0 = Get-Date
    $log = Join-Path $logDir 'web-unit-vitest.log'
    Write-Step 'vitest run（web 单元测试；直调 node + vitest CLI）'
    $vitestCli = Join-Path $webDir 'node_modules\vitest\vitest.mjs'
    $r = Invoke-Native -FilePath $script:nodeCmd -ArgumentList @($vitestCli, 'run') -WorkDir $webDir -LogPath $log -TimeoutSec ($WebTimeoutMinutes * 60)
    $text = if (Test-Path $log) { Get-Content $log -Raw } else { '' }
    $m = [regex]::Match($text, 'Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed')
    $failedTests = if ($m.Groups[1].Success) { [int]$m.Groups[1].Value } else { 0 }
    $passedTests = if ($m.Groups[2].Success) { [int]$m.Groups[2].Value } else { 0 }
    $gates = @(
        @{ name = 'vitest 退出码 0'; ok = ($r.exitCode -eq 0); detail = "exit=$($r.exitCode)" },
        @{ name = '无失败用例'; ok = ($failedTests -eq 0); detail = "failed=$failedTests" },
        @{ name = '有用例通过'; ok = ($passedTests -gt 0); detail = "passed=$passedTests" }
    )
    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok "vitest 全绿（$passedTests 用例）" } else { Write-Err2 "vitest 红（passed=$passedTests failed=$failedTests）" }
    return Write-StageFragment -Id 'web-unit-vitest' -Name 'vitest 单元测试（既有路径回归）' -Command 'cd web && npx vitest run' `
        -Status $status -ExitCode $r.exitCode -DurationMs $r.elapsedMs -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') `
        -Gates $gates -Evidence @($log) -Data @{ passed = $passedTests; failed = $failedTests }
}

function Invoke-BuildWeb {
    if ($SkipWeb) { Invoke-StageSkipped 'build-web' '前端构建' '被 -SkipWeb 跳过'; return }
    $t0 = Get-Date
    $log = Join-Path $logDir 'build-web.log'
    Write-Step 'build:web（embed + workbench）'
    $r = Invoke-Native -FilePath $script:npmCmd -ArgumentList @('run', 'build:web') -WorkDir $repoRoot -LogPath $log -TimeoutSec ($BuildTimeoutMinutes * 60)
    $gates = @(@{ name = 'build:web 退出码 0'; ok = ($r.exitCode -eq 0); detail = "exit=$($r.exitCode)" })
    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok 'build:web 通过' } else { Write-Err2 'build:web 失败' }
    return Write-StageFragment -Id 'build-web' -Name 'npm run build:web（embed + workbench 产物）' -Command 'npm run build:web' `
        -Status $status -ExitCode $r.exitCode -DurationMs $r.elapsedMs -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') `
        -Gates $gates -Artifacts @('web/dist', 'web/dist-workbench') -Evidence @($log)
}

# ---------------------------------------------------------------------------
# 阶段：T3.2 体积曲线
# ---------------------------------------------------------------------------
function Invoke-VolumeCurve {
    $t0 = Get-Date
    $log = Join-Path $logDir 'volume-curve.log'
    Write-Step 'T3.2 体积曲线（离线编码器对照 + volume-profile 分桶 + 机器判定 + 曲线图）'
    $dataset = Join-Path $exportsArchive '_dataset\run-0001'
    $datasetDir = if (Test-Path $dataset) { $dataset } else { (Get-ChildItem (Join-Path $exportsArchive '_dataset') -Directory -Filter 'run-*' | Sort-Object Name | Select-Object -First 1).FullName }
    $encodedDir = Join-Path $volumeDir 'encoded'
    New-Item -ItemType Directory -Force -Path $encodedDir | Out-Null

    $factorLog = Join-Path $logDir 'volume-factorize.log'
    $fr = Invoke-Native -FilePath $script:pwshCmd -ArgumentList @('-NoProfile', '-File', (Join-Path $repoRoot 'scripts\multiblock-encode\factorize.ps1'), '-Dataset', $datasetDir, '-OutDir', $encodedDir, '-Control') `
        -WorkDir $repoRoot -LogPath $factorLog -TimeoutSec ($VolumeTimeoutMinutes * 60)

    # volume-profile 的输入目录：只放信封产物（+对照组），避免 report/body 污染分桶
    $profileInput = Join-Path $volumeDir 'profile-input'
    if (Test-Path $profileInput) { Remove-Item -Recurse -Force $profileInput }
    New-Item -ItemType Directory -Force -Path $profileInput | Out-Null
    Get-ChildItem $exportsArchive -Filter '*.multiblock.json' -File | ForEach-Object { Copy-Item -Force $_.FullName $profileInput }
    $ctlSrc = Join-Path $encodedDir 'control'
    if (Test-Path $ctlSrc) { Get-ChildItem $ctlSrc -Filter '*.multiblock.json' -File | ForEach-Object { Copy-Item -Force $_.FullName $profileInput } }
    $profileJson = Join-Path $volumeDir 'profile.json'
    $profileMd = Join-Path $volumeDir 'profile.md'
    $pr = Invoke-Native -FilePath $script:nodeCmd -ArgumentList @((Join-Path $repoRoot 'scripts\volume-profile\volume-profile.mjs'), 'analyse', $profileInput, '--verify', 'false', '--md', $profileMd, '--json', $profileJson) `
        -WorkDir $repoRoot -LogPath (Join-Path $logDir 'volume-profile.log') -TimeoutSec ($VolumeTimeoutMinutes * 60)

    $cr = Invoke-Native -FilePath $script:nodeCmd -ArgumentList @((Join-Path $scriptDir 'volume-curve.mjs'), '--encoded', $encodedDir, '--products', $exportsArchive, '--profile', $profileJson, '--contract-report', (Join-Path $runDir 'contract-volume-fixtures.json'), '--pipeline-result', (Join-Path $runDir 'pipeline-result.json'), '--out', $volumeDir) `
        -WorkDir $repoRoot -LogPath $log -TimeoutSec ($VolumeTimeoutMinutes * 60)

    $curve = if (Test-Path (Join-Path $volumeDir 'volume-curve.json')) { Get-Content (Join-Path $volumeDir 'volume-curve.json') -Raw | ConvertFrom-Json } else { $null }
    $gates = @(
        @{ name = '离线编码器对照组已产出（--control）'; ok = (Test-Path (Join-Path $encodedDir 'control')); detail = (Join-Path $encodedDir 'control') },
        @{ name = 'volume-profile 分桶成功'; ok = (Test-Path $profileJson); detail = $profileJson },
        @{ name = '体积曲线判定脚本退出码 0'; ok = ($cr.exitCode -eq 0); detail = "exit=$($cr.exitCode)" },
        @{ name = 'R1/R2/R3 未判失败'; ok = ($curve -and $curve.verdict.status -ne 'fail'); detail = "status=$($curve.verdict.status)" },
        @{ name = '风险 4（调色板并集占比）未标红'; ok = ($curve -and $curve.risk4.status -ne 'fail'); detail = "risk4=$($curve.risk4.status)" },
        @{ name = '曲线图已生成'; ok = (Test-Path (Join-Path $volumeDir 'volume-curve.svg')); detail = (Join-Path $volumeDir 'volume-curve.svg') }
    )
    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok "体积曲线：$($curve.verdict.status)（风险 4 = $($curve.risk4.status)）" } else { Write-Err2 "体积曲线红：$($curve.verdict.status)" }
    return Write-StageFragment -Id 'volume-curve' -Name 'T3.2 体积曲线机器判定（离线编码器对照 + volume-profile 分桶 + R1/R2/R3 + 曲线图）' `
        -Command "pwsh -File scripts/multiblock-encode/factorize.ps1 -Dataset <dataset> -OutDir <run>/volume/encoded -Control; node scripts/volume-profile/volume-profile.mjs analyse <profile-input>; node scripts/acceptance/volume-curve.mjs ..." `
        -Status $status -ExitCode $cr.exitCode -DurationMs ([int]((Get-Date) - $t0).TotalMilliseconds) -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') `
        -Gates $gates -Artifacts @((Join-Path $volumeDir 'volume-curve.json'), (Join-Path $volumeDir 'volume-curve.svg'), (Join-Path $volumeDir 'volume-curve.md'), $profileMd, $profileJson) `
        -Evidence @($log, $factorLog) -Data @{ verdict = $curve.verdict; series = $curve.series; risk4 = $curve.risk4; dataset = $datasetDir; factorizeExit = $fr.exitCode; profileExit = $pr.exitCode }
}

function Invoke-WebAssemblyCrossCheck {
    $t0 = Get-Date
    $log = Join-Path $logDir 'web-assembly-cross-check.log'
    Write-Step 'web 侧真实解析器/装配器 vs mod 数据集逐格 diff（T3.3 web 半环的离线交叉验证）'
    $encodedDir = Join-Path $volumeDir 'encoded'
    $dataset = (Get-ChildItem (Join-Path $exportsArchive '_dataset') -Directory -Filter 'run-*' | Sort-Object Name | Select-Object -First 1).FullName
    $r = Invoke-Native -FilePath $script:nodeCmd -ArgumentList @((Join-Path $repoRoot 'scripts\multiblock-encode\verify-web-parser.mjs'), $encodedDir, $dataset) `
        -WorkDir $repoRoot -LogPath $log -TimeoutSec ($VolumeTimeoutMinutes * 60)
    $reportPath = Join-Path $encodedDir 'web-parser-report.json'
    $target = Join-Path $webOutDir 'web-parser-cross-check.json'
    $report = if (Test-Path $reportPath) { Get-Content $reportPath -Raw | ConvertFrom-Json } else { $null }
    if ($report) { Copy-Item -Force $reportPath $target }
    $diffs = if ($report) { (@($report.docs) | ForEach-Object { $_.webDiffs } | Measure-Object -Sum).Sum } else { -1 }
    $variants = if ($report) { (@($report.docs) | ForEach-Object { $_.variants } | Measure-Object -Sum).Sum } else { -1 }
    $gates = @(
        @{ name = '脚本退出码 0'; ok = ($r.exitCode -eq 0); detail = "exit=$($r.exitCode)" },
        @{ name = 'web 装配逐格 diff = 0'; ok = ($diffs -eq 0); detail = "diff=$diffs（变体 $variants）" },
        @{ name = '硬失败 0 条'; ok = ($report -and @($report.failures).Count -eq 0); detail = "failures=$(@($report.failures).Count)" }
    )
    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok "web 真实装配代码路径 diff=0（$variants 变体）" } else { Write-Err2 "web 装配 diff 红" }
    return Write-StageFragment -Id 'web-assembly-cross-check' -Name 'web 真实解析器/装配器（esbuild 捆绑）vs mod 数据集逐格 diff' `
        -Command 'node scripts/multiblock-encode/verify-web-parser.mjs <encoded> <dataset>' -Status $status -ExitCode $r.exitCode `
        -DurationMs $r.elapsedMs -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') -Gates $gates -Artifacts @($target) -Evidence @($log) `
        -Data @{ diffs = $diffs; variants = $variants; documents = if ($report) { @($report.docs).Count } else { 0 } }
}

function Invoke-StaticChecks {
    $t0 = Get-Date
    $log = Join-Path $logDir 'static-checks.log'
    Write-Step '静态机器判据（装配路径零游戏逻辑 / 无 GT 逻辑重放）'
    $target = Join-Path $runDir 'static-checks.json'
    $r = Invoke-Native -FilePath $script:nodeCmd -ArgumentList @((Join-Path $scriptDir 'static-checks.mjs'), '--out', $target) -WorkDir $repoRoot -LogPath $log -TimeoutSec 600
    $report = if (Test-Path $target) { Get-Content $target -Raw | ConvertFrom-Json } else { $null }
    $gates = @(
        @{ name = '脚本退出码 0（无发现）'; ok = ($r.exitCode -eq 0); detail = "exit=$($r.exitCode)" },
        @{ name = '装配路径 0 发现'; ok = ($report -and $report.assemblyPath.findings.total -eq 0); detail = "findings=$(if ($report) { $report.assemblyPath.findings.total } else { 'n/a' })" },
        @{ name = '全 web/src 0 发现'; ok = ($report -and $report.gtReplay.findings.total -eq 0); detail = "findings=$(if ($report) { $report.gtReplay.findings.total } else { 'n/a' })" }
    )
    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok "静态判据全绿（扫描 $($report.assemblyPath.scannedFiles.Count) + $($report.gtReplay.scannedFiles.Count) 文件）" } else { Write-Err2 '静态判据有发现' }
    return Write-StageFragment -Id 'static-checks' -Name '静态判据：装配路径零游戏逻辑 / 未重放 GT 逻辑' -Command 'node scripts/acceptance/static-checks.mjs' `
        -Status $status -ExitCode $r.exitCode -DurationMs $r.elapsedMs -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') `
        -Gates $gates -Artifacts @($target) -Evidence @($log) -Data @{ assemblyFindings = $report.assemblyPath.findings.total; webFindings = $report.gtReplay.findings.total; scanned = @{ assembly = $report.assemblyPath.scannedFiles.Count; web = $report.gtReplay.scannedFiles.Count } }
}

function Invoke-FalsifyOffline {
    $t0 = Get-Date
    $log = Join-Path $logDir 'falsify-offline.log'
    Write-Step '证伪（离线负对照）：篡改注入必须让判定式变红'
    $modNegative = Join-Path $falsifyDir 'mod-negative-pipeline-result.json'
    $args = @((Join-Path $scriptDir 'falsification.mjs'), '--exports', $exportsArchive, '--out', $falsifyDir)
    if (Test-Path $modNegative) { $args += @('--mod-negative', $modNegative) }
    $r = Invoke-Native -FilePath $script:nodeCmd -ArgumentList $args -WorkDir $repoRoot -LogPath $log -TimeoutSec 1800
    $report = if (Test-Path (Join-Path $falsifyDir 'falsification.json')) { Get-Content (Join-Path $falsifyDir 'falsification.json') -Raw | ConvertFrom-Json } else { $null }
    $controls = if ($report) { @($report.controls | Where-Object { $_.ran -ne $false }) } else { @() }
    $notRed = @($controls | Where-Object { -not $_.ok })
    $minControls = if ($SampleFrom) { 4 } else { 5 }
    $gates = @(
        @{ name = "负对照 ≥$minControls 条（已运行）"; ok = ($controls.Count -ge $minControls); detail = "controls=$($controls.Count)" },
        @{ name = '全部负对照按预期变红'; ok = ($controls.Count -gt 0 -and $notRed.Count -eq 0); detail = "$($controls.Count - $notRed.Count)/$($controls.Count)" },
        @{ name = '正对照（未篡改）仍绿'; ok = ($report -and $report.positiveControl.ok); detail = "positiveControl=$($report.positiveControl.ok)" }
    )
    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok "证伪全绿：$($controls.Count) 条负对照全部变红，正对照绿" } else { Write-Err2 "证伪红：$($notRed.Count) 条负对照没红" }
    return Write-StageFragment -Id 'falsify-offline-negative' -Name '证伪：离线负对照（篡改必红）+ 正对照' -Command 'node scripts/acceptance/falsification.mjs --exports <run>/exports --out <run>/falsification' `
        -Status $status -ExitCode $r.exitCode -DurationMs $r.elapsedMs -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') `
        -Gates $gates -Artifacts @((Join-Path $falsifyDir 'falsification.json')) -Evidence @($log) `
        -Data @{ controls = $controls; positiveControl = $report.positiveControl; allControlsRedAsExpected = $report.allControlsRedAsExpected }
}

# ---------------------------------------------------------------------------
# 阶段：/sde export 互不干扰（同世界，两次客户端会话）
# ---------------------------------------------------------------------------
function Invoke-SdeInterop {
    $t0 = Get-Date
    $log = Join-Path $logDir 'sde-export-interop.log'
    $cfgPath = Join-Path $mcDataDir 'config\lightning.cfg'
    $cmdFile = Join-Path $mcDataDir 'sde_automation_commands.txt'
    $snapshotBefore = Join-Path $interopDir 'snapshot-before.json'
    $reportPath = Join-Path $interopDir 'interop.json'
    Write-Step '/sde export 互不干扰（同世界先后执行 /sde export 与 multiblock 导出）'

    if (-not (Test-Path $cfgPath)) {
        Invoke-StageSkipped 'sde-export-interop' '/sde export 互不干扰' "找不到 $cfgPath（先跑一次客户端生成配置）"
        return
    }

    # ① 阶段前快照（两套产物目录）
    $snapR = Invoke-Native -FilePath $script:nodeCmd -ArgumentList @((Join-Path $scriptDir 'interop-check.mjs'), 'snapshot', '--out', $snapshotBefore, '--multiblock-exports', $liveExportsDir, '--structure-exports', $structureExportsDir) `
        -WorkDir $repoRoot -LogPath (Join-Path $logDir 'interop-snapshot.log') -TimeoutSec 600

    # ② 备份配置 + 开自动进世界（**运行时配置**，run/ 已被 gitignore；结束时原样还原）
    $cfgBackup = Join-Path $interopDir 'lightning.cfg.bak'
    Copy-Item -Force $cfgPath $cfgBackup
    $cfgText = Get-Content $cfgPath -Raw
    $cfgNew = $cfgText -replace 'B:autoLoadFirstSingleplayerWorld=false', 'B:autoLoadFirstSingleplayerWorld=true'
    $cfgNew = $cfgNew -replace 'B:cleanupCommandFileAfterRun=true', 'B:cleanupCommandFileAfterRun=false'
    Set-Content -Path $cfgPath -Value $cfgNew -Encoding utf8NoBOM
    $cfgPatched = ($cfgNew -ne $cfgText)

    # ③ 写指令文件（与 fix-thumb 证据链同一固定选区：tp 到地面方块内 → pos1/pos2 确定性非空气选区）
    $cmds = @(
        'sde start',
        'sde setname sde_export_smoke',
        'sde setstructureid lightning.smoke.thumbnail',
        'tp 964 3 -933',
        'sde pos1',
        'sde pos2',
        'sde record',
        'sde export',
        'sde status',
        'sde status',
        'sde status',
        'sde status',
        'sde status'
    )
    Set-Content -Path $cmdFile -Value ($cmds -join "`n") -Encoding utf8NoBOM
    # 让专用世界成为"最近游玩"（若排序依赖 level.dat 时间戳则据此置顶）
    $levelDat = Join-Path $mcDataDir 'saves\sde_pipeline_world\level.dat'
    if (Test-Path $levelDat) { (Get-Item $levelDat).LastWriteTime = Get-Date }

    $r = $null
    $compareExit = -1
    try {
        $r = Invoke-Native -FilePath $script:gradlew -ArgumentList @('runClientSdePipeline', '--console=plain', '-q') -WorkDir $modDir -LogPath $log -TimeoutSec ($SdeInteropTimeoutMinutes * 60)
        $cmpR = Invoke-Native -FilePath $script:nodeCmd -ArgumentList @((Join-Path $scriptDir 'interop-check.mjs'), 'compare', '--run-dir', $runDir, '--multiblock-exports', $liveExportsDir, '--structure-exports', $structureExportsDir, '--log', $log) `
            -WorkDir $repoRoot -LogPath (Join-Path $logDir 'interop-compare.log') -TimeoutSec 600
        $compareExit = $cmpR.exitCode
    } finally {
        Copy-Item -Force $cfgBackup $cfgPath
        if (Test-Path $cmdFile) { Remove-Item -Force $cmdFile }
    }

    $report = if (Test-Path $reportPath) { Get-Content $reportPath -Raw | ConvertFrom-Json } else { $null }
    $gates = @(
        @{ name = '客户端进程退出码 0'; ok = ($r -and $r.exitCode -eq 0); detail = "exit=$(if ($r) { $r.exitCode } else { 'n/a' })" },
        @{ name = '快照/比对脚本均已跑'; ok = ($snapR.exitCode -eq 0); detail = "snapshot=$($snapR.exitCode) compare=$compareExit" },
        @{ name = '/sde export 产物哈希 = 基线'; ok = ($report -and $report.hashMatch); detail = "hashMatch=$(if ($report) { $report.hashMatch } else { 'n/a' })" },
        @{ name = 'multiblock 产物目录逐字节未变'; ok = ($report -and $null -eq $report.multiblockExports.diff); detail = "diff=$(if ($report) { ($report.multiblockExports.diff | ConvertTo-Json -Compress) } else { 'n/a' })" },
        @{ name = '加载的是专用世界'; ok = ($report -and $report.worldObserved -eq $report.world); detail = "observed=$(if ($report) { $report.worldObserved } else { 'n/a' })" },
        @{ name = '配置面已原样还原'; ok = (Test-Path $cfgBackup); detail = $cfgBackup }
    )
    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok '/sde export 互不干扰全绿（产物与基线一致 + multiblock 目录未变）' } else { Write-Err2 '/sde export 互不干扰红' }
    return Write-StageFragment -Id 'sde-export-interop' -Name '/sde export 互不干扰（同世界先后执行，基线哈希 + 目录隔离）' `
        -Command 'gradlew runClientSdePipeline（指令文件：sde start/setname/tp 964 3 -933/pos1/pos2/record/export/status×5）' `
        -Status $status -ExitCode $(if ($r) { $r.exitCode } else { -1 }) -DurationMs ([int]((Get-Date) - $t0).TotalMilliseconds) `
        -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') -Gates $gates -Artifacts @($reportPath, $snapshotBefore) -Evidence @($log, $cfgBackup) `
        -Data @{ report = $report; configPatched = $cfgPatched; compareExit = $compareExit }
}

# ---------------------------------------------------------------------------
# 阶段：截图证据链 + 报告
# ---------------------------------------------------------------------------
function Invoke-ScreenshotArchive([long]$SinceMs) {
    $t0 = Get-Date
    $log = Join-Path $logDir 'screenshots.log'
    Write-Step '截图证据链归档'
    $r = Invoke-Native -FilePath $script:nodeCmd -ArgumentList @((Join-Path $scriptDir 'screenshots.mjs'), 'archive', '--run-dir', $runDir, '--since', "$SinceMs", '--label', 'web') `
        -WorkDir $repoRoot -LogPath $log -TimeoutSec 900
    $manifestPath = Join-Path $runDir 'screenshots\manifest.json'
    $manifest = if (Test-Path $manifestPath) { Get-Content $manifestPath -Raw | ConvertFrom-Json } else { $null }
    $gates = @(
        @{ name = '归档脚本退出码 0'; ok = ($r.exitCode -eq 0); detail = "exit=$($r.exitCode)" },
        @{ name = '清单已产出'; ok = [bool]$manifest; detail = $manifestPath },
        @{ name = '归档文件数 > 0'; ok = ($manifest -and $manifest.count -gt 0); detail = "count=$(if ($manifest) { $manifest.count } else { 0 })" },
        @{ name = '无非法 PNG'; ok = ($manifest -and @($manifest.invalidPng).Count -eq 0); detail = "invalidPng=$(if ($manifest) { @($manifest.invalidPng).Count } else { 'n/a' })" }
    )
    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok "截图归档 $($manifest.count) 个文件" } else { Write-Warn2 '截图归档红（可能本阶段无新截图）' }
    return Write-StageFragment -Id 'evidence-screenshots' -Name '截图证据链归档（web/e2e/screenshots + web/test-results）' `
        -Command "node scripts/acceptance/screenshots.mjs archive --run-dir <run> --since $SinceMs" -Status $status -ExitCode $r.exitCode `
        -DurationMs $r.elapsedMs -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') -Gates $gates `
        -Artifacts @($manifestPath) -Evidence @($log) -Data @{ count = if ($manifest) { $manifest.count } else { 0 }; bytes = if ($manifest) { $manifest.bytes } else { 0 } }
}

function Invoke-Report {
    $t0 = Get-Date
    $log = Join-Path $logDir 'report.log'
    Write-Step '汇总 acceptance-report.json'
    # 体积曲线归档文档：样例/分段运行只写模板（不覆盖终验数据），正式验收且有曲线时写数据
    $docMode = if ($SampleFrom) { 'template' } else { 'data' }
    if (Test-Path (Join-Path $volumeDir 'volume-curve.json')) {
        # 归档文档必须落证据目录（$volumeDir 在 $runDir 内，$OutRoot 默认 scripts/acceptance/.out）：
        # 写进仓库树会让每次验收都在 git status 里留下未跟踪文件
        Invoke-Native -FilePath $script:nodeCmd -ArgumentList @((Join-Path $scriptDir 'volume-doc.mjs'), '--mode', $docMode, '--run-dir', $runDir, '--out', (Join-Path $volumeDir 'volume-profile-result.md')) `
            -WorkDir $repoRoot -LogPath (Join-Path $logDir 'volume-doc.log') -TimeoutSec 300 | Out-Null
    } elseif ($SampleFrom) {
        Invoke-Native -FilePath $script:nodeCmd -ArgumentList @((Join-Path $scriptDir 'volume-doc.mjs'), '--mode', 'template') `
            -WorkDir $repoRoot -LogPath (Join-Path $logDir 'volume-doc.log') -TimeoutSec 300 | Out-Null
    }
    $args = @((Join-Path $scriptDir 'build-report.mjs'), '--run-dir', $runDir)
    if ($CompareWith) { $args += @('--compare-with', $CompareWith) }
    $r = Invoke-Native -FilePath $script:nodeCmd -ArgumentList $args -WorkDir $repoRoot -LogPath $log -TimeoutSec 900
    $reportPath = Join-Path $runDir 'acceptance-report.json'
    Write-StageFragment -Id 'report' -Name '汇总 acceptance-report.json（§6 逐条映射）' -Command 'node scripts/acceptance/build-report.mjs --run-dir <run>' `
        -Status $(if (Test-Path $reportPath) { 'pass' } else { 'fail' }) -ExitCode $r.exitCode -DurationMs $r.elapsedMs `
        -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') `
        -Gates @(@{ name = '报告已产出'; ok = (Test-Path $reportPath); detail = $reportPath }) `
        -Artifacts @($reportPath, (Join-Path $runDir 'acceptance-report.md')) -Evidence @($log) | Out-Null
    # 再算一次：让报告自身的 stages[] 里也带上 report 阶段（纯读判定，秒级）
    $args2 = $args
    $r2 = Invoke-Native -FilePath $script:nodeCmd -ArgumentList $args2 -WorkDir $repoRoot -LogPath $log -TimeoutSec 900
    Write-Host ($r2.stdOut)
    return $r2
}

# ---------------------------------------------------------------------------
# 运行状态（报告的环境/裁决/开放项来源）
# ---------------------------------------------------------------------------
function Write-RunState {
    param([string]$Mode, [string]$ExportRunLabel)
    $gitHead = (& git -C $repoRoot rev-parse HEAD 2>$null)
    $gitDirty = (& git -C $repoRoot status --porcelain 2>$null) -join "`n"
    $state = [ordered]@{
        schema = 'lightning.acceptance.run-state/1'
        label = $Label
        mode = $Mode
        exportRunLabel = $ExportRunLabel
        startedAt = (Get-Date).ToString('o')
        singleCommand = 'npm run acceptance:multiblock'
        scopeMode = $(if ($Scope) { 'explicit-scope' } else { 'default-subset-5' })
        scope = $Scope
        adjudications = $script:adjudications
        openItems = $script:openItems
        interactivity = $script:interactivity
        fullRunEstimate = [ordered]@{
            basis = 'T1.5/T1.6 实测：279.5 ms/变体（全量均值）；全量不裁剪 5,551,258 变体 ≈ 431 h；默认 maxVariantsPerMachine=20000 时 ≈ 32 h'
            uncappedHours = 431
            cappedHours = 32
            note = '风险 7 裁决：Phase 3 验收范围 = 默认子集 5 台（非全量）；全量验收范围待用户裁定（子集验收 / 分片并行 / 下调上限）'
        }
        git = @{ head = "$gitHead".Trim(); dirtyLines = if ($gitDirty) { ($gitDirty -split "`n").Count } else { 0 }; dirtySample = ($gitDirty -split "`n" | Select-Object -First 10) }
        paths = [ordered]@{
            runDir = $runDir; logs = $logDir; stages = $stagesDir; exports = $exportsArchive
            web = $webOutDir; volume = $volumeDir; interop = $interopDir; falsification = $falsifyDir
            screenshots = (Join-Path $runDir 'screenshots')
        }
    }
    Set-Content -Path (Join-Path $runDir 'run-state.json') -Value ($state | ConvertTo-Json -Depth 10) -Encoding utf8NoBOM
}

# ===========================================================================
# 主流程
# ===========================================================================
Write-Host ""
Write-Host "═══ Lightning 多方块验收总入口（acceptance:multiblock）═══" -ForegroundColor Magenta
Write-Host "   label    : $Label"
Write-Host "   run dir  : $runDir"
Write-Host "   范围     : $(if ($Scope) { $Scope } else { '默认子集 5 台（EBF/DT/BBF/QFT/AdvEBF）' })"
Write-Host "   模式     : $(if ($SampleFrom) { "sample（回放 $SampleFrom）" } else { 'acceptance' })"
Write-Host ""

Write-RunState -Mode $(if ($SampleFrom) { 'sample' } else { 'acceptance' }) -ExportRunLabel "$Label-export"

# ---------------- 分段验证：把既有产物归档塞进本次运行目录 ----------------
if ($SeedExportsFrom) {
    $seed = (Resolve-Path $SeedExportsFrom).Path
    Write-Step "分段验证：从既有产物归档播种 $seed"
    if (Test-Path $exportsArchive) { Remove-Item -Recurse -Force $exportsArchive }
    New-Item -ItemType Directory -Force -Path $exportsArchive | Out-Null
    Get-ChildItem $seed -Force | ForEach-Object { Copy-Item -Recurse -Force $_.FullName $exportsArchive }
    $seedPr = Join-Path (Split-Path $seed -Parent) 'pipeline-result.json'
    if (Test-Path $seedPr) { Copy-Item -Force $seedPr (Join-Path $runDir 'pipeline-result.json') }
    Write-Ok "产物已就位：$exportsArchive"
}

# ---------------- 样例模式：用既有产物回放（不启动游戏 / 不跑 playwright） ----------------
if ($SampleFrom) {
    Write-Step "样例模式：从 $SampleFrom 回放"
    $src = (Resolve-Path $SampleFrom).Path
    if (Test-Path $exportsArchive) { Remove-Item -Recurse -Force $exportsArchive }
    New-Item -ItemType Directory -Force -Path $exportsArchive | Out-Null
    Get-ChildItem $src -Force | ForEach-Object { Copy-Item -Recurse -Force $_.FullName $exportsArchive }
    $pr = Get-ChildItem (Split-Path $src -Parent) -Filter 'pipeline-result.json' -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pr) { Copy-Item -Force $pr.FullName (Join-Path $runDir 'pipeline-result.json') }
    $exportLabel = if ($pr) { (Split-Path $pr.DirectoryName -Leaf) } else { '' }

    Invoke-StageSkipped 'preflight' '前置检查' '样例模式跳过'
    Invoke-StageSkipped 'build-mod-gtnh' 'gradlew build' '样例模式跳过'
    Invoke-StageSkipped 'falsify-mod-negative' '证伪（mod 半环）' '样例模式跳过'
    # export-multiblock 以 sample 片段记录（产物来自既有归档）
    Write-StageFragment -Id 'export-multiblock' -Name '真实导出（样例回放：既有归档产物）' -Command "copy $src" -Status 'sample' `
        -ExitCode 0 -DurationMs 0 -StartedAt (Get-Date).ToString('o') -EndedAt (Get-Date).ToString('o') `
        -Gates @(@{ name = '既有产物已就位'; ok = $true; detail = $exportsArchive }) -Artifacts @($exportsArchive) `
        -Data @{ replayFrom = $src } | Out-Null
    Invoke-StageSkipped 'web-real-acceptance' '真实导出 spec' '样例模式跳过'
    Invoke-StageSkipped 'web-synthetic-regression' '合成回归' '样例模式跳过'
    Invoke-StageSkipped 'web-unit-vitest' 'vitest' '样例模式跳过'
    Invoke-StageSkipped 'build-web' 'build:web' '样例模式跳过'
    Invoke-StageSkipped 'sde-export-interop' '/sde export 互不干扰' '样例模式跳过'
    # 分析类阶段仍然真跑（它们只读产物，能验证报告 schema 与判据实现）
    Invoke-VerifyExpanded
    Invoke-ContractValidate
    Invoke-VolumeCurve
    Invoke-WebAssemblyCrossCheck
    Invoke-StaticChecks
    Invoke-FalsifyOffline
    Invoke-StageSkipped 'evidence-screenshots' '截图归档' '样例模式跳过'
    Write-RunState -Mode 'sample' -ExportRunLabel $exportLabel
    Invoke-Report | Out-Null
    Write-Host ""
    Write-Host "== 样例报告（不构成验收结论）：$(Join-Path $runDir 'acceptance-report.json')" -ForegroundColor Yellow
    exit 0
}

# ---------------- 正式验收 ----------------
$pre = Invoke-Preflight
if ($pre.status -ne 'pass') {
    Write-Err2 '前置检查未通过 → 退出码 3（不启动任何重活）'
    Write-RunState -Mode 'acceptance' -ExportRunLabel "$Label-export"
    Invoke-Report | Out-Null
    exit 3
}
if ($DryRun) {
    Write-Step 'DryRun：前置检查通过；计划如下（不执行任何阶段）'
    @(
        'build-mod-gtnh        cd mod/gtnh && gradlew build',
        'falsify-mod-negative  run-pipeline.ps1 -Scope MTENoSuchMachineT16（必须退出码 2）',
        "export-multiblock     run-pipeline.ps1 -Label $Label-export $(if ($Scope) { "-Scope $Scope" } else { '(默认子集 5 台)' })",
        'verify-expanded       node scripts/multiblock-pipeline/verify-expanded.mjs <exports>',
        'contract-validate     node .../validate-multiblock-fixtures.mjs <5 产物>（产物集不跑 --volume）+ node ... <3 fixture> --volume（契约 k 序列，R2 判定落点）',
        'web-real-acceptance   cd web && npx playwright test multiblock-real-acceptance（MB_REAL_EXPORTS_DIR=<exports>）',
        'web-synthetic-regression  cd web && npm run test:e2e:multiblock',
        'web-unit-vitest       cd web && npx vitest run',
        'build-web             npm run build:web',
        'volume-curve          factorize.ps1 --control + volume-profile.mjs + volume-curve.mjs',
        'web-assembly-cross-check  node scripts/multiblock-encode/verify-web-parser.mjs <encoded> <dataset>',
        'static-checks         node scripts/acceptance/static-checks.mjs',
        'falsify-offline-negative  node scripts/acceptance/falsification.mjs',
        'sde-export-interop    gradlew runClientSdePipeline（/sde export 指令文件）+ interop-check.mjs',
        'evidence-screenshots  node scripts/acceptance/screenshots.mjs archive',
        'report                node scripts/acceptance/build-report.mjs'
    ) | ForEach-Object { Write-Host "   - $_" }
    exit 0
}

if ($SkipBuild) {
    Invoke-StageSkipped 'build-mod-gtnh' 'gradlew build' '被 -SkipBuild 跳过'
} elseif (Test-StageEnabled 'build-mod-gtnh') {
    Invoke-BuildMod | Out-Null
} else {
    Invoke-StageSkipped 'build-mod-gtnh' 'gradlew build' '不在 -OnlyStages'
}

if ($SkipFalsification -or -not (Test-StageEnabled 'falsify-mod-negative')) {
    Invoke-StageSkipped 'falsify-mod-negative' '证伪（mod 半环）' $(if ($SkipFalsification) { '被 -SkipFalsification 跳过' } else { '不在 -OnlyStages' })
} else {
    Invoke-FalsifyModNegative | Out-Null
}

if (Test-StageEnabled 'export-multiblock') { Invoke-ExportMultiblock | Out-Null }
else { Invoke-StageSkipped 'export-multiblock' '真实导出' '不在 -OnlyStages' }

if (Test-StageEnabled 'verify-expanded') { Invoke-VerifyExpanded | Out-Null }
else { Invoke-StageSkipped 'verify-expanded' '展开逐格 diff' '不在 -OnlyStages' }

if (Test-StageEnabled 'contract-validate') { Invoke-ContractValidate | Out-Null }
else { Invoke-StageSkipped 'contract-validate' '契约校验' '不在 -OnlyStages' }

$webStageStart = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
if (Test-StageEnabled 'web-real-acceptance') { Invoke-WebRealAcceptance } else { Invoke-StageSkipped 'web-real-acceptance' '真实导出 spec' '不在 -OnlyStages' }
if (Test-StageEnabled 'web-synthetic-regression') { Invoke-WebSynthetic } else { Invoke-StageSkipped 'web-synthetic-regression' '合成回归' '不在 -OnlyStages' }
if (Test-StageEnabled 'web-unit-vitest') { Invoke-WebUnit | Out-Null } else { Invoke-StageSkipped 'web-unit-vitest' 'vitest' '不在 -OnlyStages' }
if (Test-StageEnabled 'build-web') { Invoke-BuildWeb | Out-Null } else { Invoke-StageSkipped 'build-web' 'build:web' '不在 -OnlyStages' }

if (Test-StageEnabled 'volume-curve') { Invoke-VolumeCurve | Out-Null } else { Invoke-StageSkipped 'volume-curve' 'T3.2 体积曲线' '不在 -OnlyStages' }
if (Test-StageEnabled 'web-assembly-cross-check') { Invoke-WebAssemblyCrossCheck | Out-Null } else { Invoke-StageSkipped 'web-assembly-cross-check' 'web 装配交叉验证' '不在 -OnlyStages' }
if (Test-StageEnabled 'static-checks') { Invoke-StaticChecks | Out-Null } else { Invoke-StageSkipped 'static-checks' '静态判据' '不在 -OnlyStages' }
if (Test-StageEnabled 'falsify-offline-negative') { Invoke-FalsifyOffline | Out-Null } else { Invoke-StageSkipped 'falsify-offline-negative' '离线负对照' '不在 -OnlyStages' }

if ($SkipSdeInterop -or -not (Test-StageEnabled 'sde-export-interop')) {
    Invoke-StageSkipped 'sde-export-interop' '/sde export 互不干扰' $(if ($SkipSdeInterop) { '被 -SkipSdeInterop 跳过' } else { '不在 -OnlyStages' })
} else {
    Invoke-SdeInterop | Out-Null
}

if (Test-StageEnabled 'evidence-screenshots') { Invoke-ScreenshotArchive -SinceMs $webStageStart | Out-Null }
else { Invoke-StageSkipped 'evidence-screenshots' '截图归档' '不在 -OnlyStages' }

Write-RunState -Mode 'acceptance' -ExportRunLabel "$Label-export"
$rr = Invoke-Report

# ---------------------------------------------------------------------------
# 退出码
#   3 前置检查致命 / 4 mod 半环红 / 5 web 半环红 / 6 T3.2 体积曲线红
#   2 验收不完整（有阶段 not-run：缺 spec / 被开关跳过）
#   7 报告未产出 / 9 阶段全绿但把关清单判红 / 8 幂等逐条判定不一致 / 0 全绿
# ---------------------------------------------------------------------------
function Get-StageStatus([string]$Id) {
    $f = $script:stageResults[$Id]
    if (-not $f) { return 'missing' }
    return $f.status
}
function Test-AnyFail([string[]]$Ids) {
    foreach ($id in $Ids) { if ((Get-StageStatus $id) -eq 'fail') { return $true } }
    return $false
}
function Test-AnyNotRun([string[]]$Ids) {
    foreach ($id in $Ids) { if ((Get-StageStatus $id) -eq 'not-run') { return $true } }
    return $false
}

$modStages = @('build-mod-gtnh', 'export-multiblock', 'verify-expanded', 'contract-validate', 'falsify-mod-negative', 'sde-export-interop')
$webStages = @('web-real-acceptance', 'web-synthetic-regression', 'web-unit-vitest', 'build-web')

$reportPath = Join-Path $runDir 'acceptance-report.json'
$report = if (Test-Path $reportPath) { Get-Content $reportPath -Raw | ConvertFrom-Json } else { $null }

$exit = 0
if ((Get-StageStatus 'preflight') -ne 'pass') { $exit = 3 }
elseif (Test-AnyFail $modStages) { $exit = 4 }
elseif (Test-AnyFail $webStages) { $exit = 5 }
elseif (Test-AnyFail @('volume-curve', 'web-assembly-cross-check', 'static-checks', 'falsify-offline-negative', 'evidence-screenshots')) { $exit = 6 }
elseif (-not $report) { $exit = 7 }
elseif (Test-AnyNotRun ($modStages + $webStages + @('volume-curve', 'web-assembly-cross-check', 'static-checks', 'falsify-offline-negative', 'evidence-screenshots'))) { $exit = 2 }
elseif ($CompareWith -and $report.idempotency.verdictsMatch -eq $false) { $exit = 8 }
elseif ($report.verdict.status -eq 'fail') { $exit = 9 }

Write-Host ""
if ($exit -eq 0) {
    Write-Host "═══ 验收全绿（退出码 0）═══" -ForegroundColor Green
} else {
    Write-Host "═══ 验收红（退出码 $exit）═══" -ForegroundColor Red
    if ($report) { foreach ($c in $report.verdict.redChecks) { Write-Host "   XX [$($c.status)] $($c.id) — $($c.detail)" -ForegroundColor Red } }
}
Write-Host "   报告：$reportPath"
Write-Host "   摘要：$(Join-Path $runDir 'acceptance-report.md')"
Write-Host "   截图：$(Join-Path $runDir 'screenshots')"
Write-Host "   曲线：$(Join-Path $volumeDir 'volume-curve.svg')"
Write-Host ""
exit $exit
