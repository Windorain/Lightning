<#
  P1.8 部件验收（建造 → 导出 → oracle 落盘）—— 外层编排（仿 run-pipeline.ps1/run-parts-probe.ps1 骨架）
  ============================================================================
  一条命令跑完：前置检查 → 写触发文件 sde_parts_acceptance.json → gradlew runClientSdePipeline
  → 游戏内自动进专用世界（sde_parts_acceptance_world）→ 清场（FMP remPart 通道）→ 建造八分区
  → 全量导出×2 + 退化导出（关 ae2 / 全关）+ oracle×3 落盘 + oracle↔导出逐格核对
  → 读结构化结果 → 归档产物 → oracle 复制到 scripts/parts-acceptance/oracle/（留白 #9 拍板目录）。

  用法（零人工交互）：
    pwsh -File scripts/parts-acceptance/run-acceptance.ps1 -Label p18-run-1
    npm run acceptance:parts                      # 等价入口（package.json）
    # 自定义退化轮（P3.3 外部驱动形态：本轮从启动起只关指定族，单轮导出+核对）
    pwsh -File scripts/parts-acceptance/run-acceptance.ps1 -Label deg-ae2 -DisabledFamilies ae2
    # 幂等跨轮证据：跑两轮并比对全部产物字节（默认 Runs=2 已覆盖）
    pwsh -File scripts/parts-acceptance/run-acceptance.ps1 -Label idem -Runs 2

  退出码：0 = 全绿（含跨轮幂等比对）；2 = 断言/核对有失败；3 = 管线级致命（超时/进世界失败）；
          4 = 外层编排自身失败（无结果文件/跨轮字节不一致）。
#>
[CmdletBinding()]
param(
    # 本次运行的标签（归档目录名与结果文件 label）
    [string]$Label = "",
    # 跨轮幂等轮数（每轮独立启动客户端；≥2 时逐文件比对字节一致）
    [int]$Runs = 2,
    # 放置后等待服务端→客户端同步的 tick 数
    [int]$SyncWaitTicks = 60,
    # 自定义退化轮：从启动起关闭指定族提供者（逗号分隔，如 ae2 或 ae2,eio,fmp,generic）
    [string[]]$DisabledFamilies = @(),
    # 客户端进程单轮总超时（分钟）
    [int]$ProcessTimeoutMinutes = 30,
    # 只做前置检查与触发文件写入，不启动客户端（干跑）
    [switch]$DryRun,
    # 不归档产物
    [switch]$NoArchive
)

$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
$modDir = Join-Path $repoRoot 'mod\gtnh'
$mcDataDir = Join-Path $modDir 'run\client'
$archiveRoot = Join-Path $scriptDir '.out'
$oracleDir = Join-Path $scriptDir 'oracle'

if ([string]::IsNullOrWhiteSpace($Label)) {
    $Label = 'parts-acceptance-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
}

function Write-Step([string]$msg) { Write-Host "== [P1.8] $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host "   OK  $msg" -ForegroundColor Green }
function Write-Warn2([string]$msg) { Write-Host "   !!  $msg" -ForegroundColor Yellow }
function Write-Err2([string]$msg) { Write-Host "   XX  $msg" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# ① 前置检查（与 run-parts-probe.ps1 同一判据）
# ---------------------------------------------------------------------------
Write-Step "前置检查"

$gradlew = Join-Path $modDir 'gradlew.bat'
if (-not (Test-Path $gradlew)) { Write-Err2 "找不到 $gradlew"; exit 4 }
Write-Ok "gradlew: $gradlew"

$confRoots = @()
if ($env:USERPROFILE) { $confRoots += (Join-Path $env:USERPROFILE '.gradle') }
if ($env:GRADLE_USER_HOME) { $confRoots += $env:GRADLE_USER_HOME }
$confHits = @()
foreach ($root in $confRoots) {
    $forgeDir = Join-Path $root 'caches\minecraft\net\minecraftforge\forge'
    if (-not (Test-Path $forgeDir)) { continue }
    Get-ChildItem $forgeDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $conf = Join-Path $_.FullName 'unpacked\conf'
        if (-not (Test-Path $conf)) { return }
        $srg = Get-ChildItem $conf -Filter '*.srg' -File -ErrorAction SilentlyContinue
        if ($srg) { $confHits += $conf }
    }
}
if ($confHits.Count -eq 0) {
    Write-Err2 "CoFH MCP conf 前置检查失败（与 run-pipeline.ps1 同一坑：不修会启动阶段静默挂住）"
    exit 3
}
Write-Ok "CoFH conf: $($confHits[0])"

# 游戏内产物文件名（每轮归档前从 mcDataDir 收走）
$artifactNames = @(
    'sde_parts_acceptance_result.json',
    'sde_parts_acceptance_dump.json',
    'sde_parts_acceptance_export_full_a.json',
    'sde_parts_acceptance_export_full_b.json',
    'sde_parts_acceptance_export_fullcube_only.json',
    'sde_parts_acceptance_export_degraded_ae2.json',
    'sde_parts_acceptance_export_degraded_all.json',
    'sde_parts_acceptance_export_custom.json',
    'sde_parts_acceptance_oracle_full.json',
    'sde_parts_acceptance_oracle_degraded_ae2.json',
    'sde_parts_acceptance_oracle_degraded_all.json',
    'sde_parts_acceptance_oracle_custom.json'
)

# 陈旧文件必须清掉：否则「读不到本轮结果」会退化成读到上一轮结果
foreach ($name in $artifactNames) {
    $stale = Join-Path $mcDataDir $name
    if (Test-Path $stale) { Remove-Item -Force $stale }
}
Write-Ok "已清除陈旧产物文件"

# ---------------------------------------------------------------------------
# ② 逐轮运行
# ---------------------------------------------------------------------------
$runExitCodes = @()
$runDirs = @()

for ($run = 1; $run -le [Math]::Max(1, $Runs); $run++) {
    $runLabel = $Runs -gt 1 ? "$Label-r$run" : $Label
    $logDir = Join-Path $archiveRoot $runLabel
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $logFile = Join-Path $logDir 'gradle-runClient.log'

    Write-Step "第 $run/$Runs 轮：写触发文件（label=$Label，归档目录 $runLabel）"

    # 触发文件 label 各轮恒为基础 $Label（不串轮号）：label 会进入 dump/结果 JSON，
    # 串轮号会让跨轮字节比对永远失败；轮次区分由归档目录（-rN 后缀）承担。
    $trigger = [ordered]@{
        schema          = 'lightning.parts-acceptance.trigger/1'
        label           = $Label
        requestedBy     = 'scripts/parts-acceptance/run-acceptance.ps1'
        cleanupTrigger  = $true
        syncWaitTicks   = $SyncWaitTicks
    }
    if ($DisabledFamilies.Count -gt 0) {
        $famList = @()
        foreach ($f in $DisabledFamilies) {
            foreach ($p in ($f -split '[,\s]+')) { if ($p.Trim() -ne '') { $famList += $p.Trim() } }
        }
        $trigger.disabledFamilies = $famList
    }
    $triggerPath = Join-Path $mcDataDir 'sde_parts_acceptance.json'
    $json = $trigger | ConvertTo-Json -Depth 6
    Set-Content -Path $triggerPath -Value $json -Encoding utf8NoBOM
    Write-Ok "触发文件: $triggerPath"

    if ($DryRun) {
        Write-Step "DryRun：前置检查与触发文件已就绪，不启动客户端"
        exit 0
    }

    Write-Step "第 $run/$Runs 轮：启动客户端（gradlew runClientSdePipeline，超时 ${ProcessTimeoutMinutes} min）"
    Write-Host "   日志: $logFile"

    $started = Get-Date
    $proc = Start-Process -FilePath $gradlew `
        -ArgumentList @('runClientSdePipeline', '--console=plain', '-q') `
        -WorkingDirectory $modDir -NoNewWindow -PassThru `
        -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"

    $timedOut = $false
    try {
        Wait-Process -Id $proc.Id -Timeout ($ProcessTimeoutMinutes * 60) -ErrorAction Stop
    } catch {
        $timedOut = $true
        Write-Err2 "客户端进程超时（${ProcessTimeoutMinutes} min），杀掉整棵进程树"
        & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null
    }
    $elapsed = (Get-Date) - $started
    Write-Ok ("客户端进程结束：exitCode={0}，耗时 {1:n1} min" -f $proc.ExitCode, $elapsed.TotalMinutes)

    Write-Step "第 $run/$Runs 轮：读结构化结果 + 归档"

    $resultPath = Join-Path $mcDataDir 'sde_parts_acceptance_result.json'
    if (-not (Test-Path $resultPath)) {
        Write-Err2 "验收没有产出结果文件: $resultPath"
        if ($timedOut) { Write-Err2 "原因：外层进程超时被强杀（见日志尾部）" }
        if (Test-Path $logFile) { Get-Content $logFile -Tail 40 | ForEach-Object { "      $_" } }
        exit 4
    }
    $result = Get-Content $resultPath -Raw | ConvertFrom-Json
    Write-Ok "status=$($result.status) exitCode=$($result.exitCode) label=$($result.label)"
    $runExitCodes += [int]$result.exitCode

    if (-not $NoArchive) {
        foreach ($name in $artifactNames) {
            $src = Join-Path $mcDataDir $name
            if (Test-Path $src) {
                Copy-Item -Force $src (Join-Path $logDir $name)
                Remove-Item -Force $src
            }
        }
        Write-Ok "产物归档: $logDir"
        # oracle 复制到 canonical 目录（留白 #9 拍板：scripts/parts-acceptance/oracle/）
        # 只收标准三件（full/degraded_ae2/degraded_all）；custom 轮产物只进归档目录
        if ($run -eq 1) {
            New-Item -ItemType Directory -Force -Path $oracleDir | Out-Null
            Get-ChildItem $logDir -Filter 'sde_parts_acceptance_oracle_*.json' -File |
                Where-Object { $_.Name -notlike '*_custom.json' } | ForEach-Object {
                Copy-Item -Force $_.FullName (Join-Path $oracleDir $_.Name)
            }
            Write-Ok "oracle 落盘: $oracleDir"
        }
    } else {
        foreach ($name in $artifactNames) {
            $src = Join-Path $mcDataDir $name
            if (Test-Path $src) { Remove-Item -Force $src }
        }
    }
    $runDirs += $logDir

    foreach ($s in $result.suites) {
        Write-Host ("   套件 {0,-14}: pass={1} failedChecks={2} {3}" -f $s.suite, $s.pass, $s.failedChecks, $s.disabledFamilies)
    }
    if (@($result.warnings).Count -gt 0) {
        Write-Host "   警告:"
        $result.warnings | Select-Object -First 8 | ForEach-Object { Write-Host "      $_" }
    }

    if ($result.exitCode -ne 0) {
        Write-Err2 "第 $run 轮非零退出（$($result.exitCode)），中止后续轮次"
        exit [int]$result.exitCode
    }
}

# ---------------------------------------------------------------------------
# ③ 跨轮幂等比对（Runs ≥ 2）：逐文件 sha256 必须一致
# ---------------------------------------------------------------------------
if ($Runs -ge 2 -and -not $NoArchive) {
    Write-Step "跨轮幂等比对（$($runDirs[0]) vs $($runDirs[1])）"
    $names = Get-ChildItem $runDirs[0] -Filter 'sde_parts_acceptance_*.json' -File | ForEach-Object { $_.Name }
    $mismatch = @()
    foreach ($name in $names) {
        # 结果文件含真实时间戳（startedAt/finishedAt）⇒ 排除；oracle 幂等拍板 builtAtEpochMs=0；
        # dump/导出/oracle 在触发文件 label 恒定（见上注记）后应逐字节一致
        if ($name -eq 'sde_parts_acceptance_result.json') { continue }
        $a = Join-Path $runDirs[0] $name
        $b = Join-Path $runDirs[1] $name
        if (-not (Test-Path $b)) { $mismatch += "$name（第二轮缺失）"; continue }
        $ha = (Get-FileHash $a -Algorithm SHA256).Hash
        $hb = (Get-FileHash $b -Algorithm SHA256).Hash
        if ($ha -ne $hb) {
            $mismatch += "$name（$($ha.Substring(0,12)) vs $($hb.Substring(0,12))）"
        } else {
            Write-Host ("      {0}  {1}" -f $ha.Substring(0, 16), $name)
        }
    }
    if ($mismatch.Count -gt 0) {
        Write-Err2 "跨轮字节不一致（破坏了「重复运行产物字节一致」自检）:"
        $mismatch | ForEach-Object { Write-Host "      $_" }
        exit 4
    }
    Write-Ok "跨轮幂等：$($names.Count - 1) 个产物文件全部字节一致"
}

Write-Host ""
$finalCode = ($runExitCodes | Measure-Object -Maximum).Maximum
if ($finalCode -eq 0) {
    Write-Host "== [P1.8] 部件验收全绿（$Runs 轮，退出码 0）" -ForegroundColor Green
} else {
    Write-Host "== [P1.8] 非零退出（退出码 $finalCode）：原因见各轮结果文件与日志" -ForegroundColor Red
}
exit [int]$finalCode
