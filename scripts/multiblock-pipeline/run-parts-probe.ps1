<#
  P0.2 三族部件接口反射可达性探针 —— 外层编排（仿 run-pipeline.ps1 骨架，独立触发/结果文件）
  ============================================================================
  一条命令跑完：前置检查 → 写触发文件 sde_parts_probe.json → gradlew runClientSdePipeline
  → 探针在游戏内自动进专用世界 → 服务端真实放置三族部件组合 → 客户端反射读取并落盘
  → 读结构化结果 sde_parts_probe_result.json → 归档 dump → 以探针退出码退出。

  用法（零人工交互）：
    pwsh -File scripts/multiblock-pipeline/run-parts-probe.ps1 -Label p02-run-1

  退出码：0 = 三族全部读到部件；2 = 至少一族没读到部件（放置或读取失败，细节见 dump）；
          3 = 管线级致命（超时/进世界失败/写出失败）；4 = 外层编排自身失败（无结果文件）。
#>
[CmdletBinding()]
param(
    # 本次运行的标签（用于归档目录名与结果文件 label）
    [string]$Label = "",
    # 放置后等待服务端→客户端同步的 tick 数
    [int]$SyncWaitTicks = 60,
    # 客户端进程总超时（分钟）
    [int]$ProcessTimeoutMinutes = 30,
    # 只做前置检查与触发文件写入，不启动客户端（干跑）
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
$modDir = Join-Path $repoRoot 'mod\gtnh'
$mcDataDir = Join-Path $modDir 'run\client'
$archiveRoot = Join-Path $scriptDir '.out'

if ([string]::IsNullOrWhiteSpace($Label)) {
    $Label = 'parts-probe-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
}
$logDir = Join-Path $archiveRoot $Label
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'gradle-runClient.log'

function Write-Step([string]$msg) { Write-Host "== [P0.2] $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host "   OK  $msg" -ForegroundColor Green }
function Write-Warn2([string]$msg) { Write-Host "   !!  $msg" -ForegroundColor Yellow }
function Write-Err2([string]$msg) { Write-Host "   XX  $msg" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# ① 前置检查（与 run-pipeline.ps1 同一判据：CoFH MCP conf 目录里要有 .srg）
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

# 陈旧结果文件必须清掉：否则「读不到本轮结果」会退化成读到上一轮结果
$resultPath = Join-Path $mcDataDir 'sde_parts_probe_result.json'
$dumpPath = Join-Path $mcDataDir 'sde_parts_probe_dump.json'
foreach ($stale in @($resultPath, $dumpPath)) {
    if (Test-Path $stale) { Remove-Item -Force $stale; Write-Ok "已清除上一轮文件: $stale" }
}

# ---------------------------------------------------------------------------
# ② 写触发文件
# ---------------------------------------------------------------------------
Write-Step "写触发文件"

$trigger = [ordered]@{
    schema          = 'lightning.parts-probe.trigger/1'
    label           = $Label
    requestedBy     = 'scripts/multiblock-pipeline/run-parts-probe.ps1'
    cleanupTrigger  = $true
    syncWaitTicks   = $SyncWaitTicks
}
$triggerPath = Join-Path $mcDataDir 'sde_parts_probe.json'
$json = $trigger | ConvertTo-Json -Depth 6
Set-Content -Path $triggerPath -Value $json -Encoding utf8NoBOM
Write-Ok "触发文件: $triggerPath"

if ($DryRun) {
    Write-Step "DryRun：前置检查与触发文件已就绪，不启动客户端"
    exit 0
}

# ---------------------------------------------------------------------------
# ③ 启动客户端（复用 runClientSdePipeline：注入 -Dfml.queryResult=confirm；探针进程内也有兜底）
# ---------------------------------------------------------------------------
Write-Step "启动客户端（gradlew runClientSdePipeline，超时 ${ProcessTimeoutMinutes} min）"
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

# ---------------------------------------------------------------------------
# ④ 读结构化结果 + 归档
# ---------------------------------------------------------------------------
Write-Step "读结构化结果"

if (-not (Test-Path $resultPath)) {
    Write-Err2 "探针没有产出结果文件: $resultPath"
    if ($timedOut) { Write-Err2 "原因：外层进程超时被强杀（见日志尾部）" }
    if (Test-Path $logFile) { Get-Content $logFile -Tail 40 | ForEach-Object { "      $_" } }
    exit 4
}

$result = Get-Content $resultPath -Raw | ConvertFrom-Json
Write-Ok "status=$($result.status) exitCode=$($result.exitCode) label=$($result.label)"

Copy-Item -Force $resultPath (Join-Path $logDir 'parts-probe-result.json')
if (Test-Path $dumpPath) {
    Copy-Item -Force $dumpPath (Join-Path $logDir 'parts-probe-dump.json')
    Write-Ok "探针数据归档: $(Join-Path $logDir 'parts-probe-dump.json')"
}

Write-Step "汇总"
Write-Host ("   status        : {0}" -f $result.status)
Write-Host ("   exitCode      : {0}" -f $result.exitCode)
foreach ($f in $result.families) {
    Write-Host ("   族 {0,-8} : 读到部件 {1} 个（{2}）" -f $f.family, $f.partsRead, $f.detail)
}
if (@($result.warnings).Count -gt 0) {
    Write-Host "   警告:"
    $result.warnings | Select-Object -First 8 | ForEach-Object { Write-Host "      $_" }
}

Write-Host ""
if ($result.exitCode -eq 0) {
    Write-Host "== [P0.2] 三族探针全绿（退出码 0）" -ForegroundColor Green
} else {
    Write-Host "== [P0.2] 非零退出（退出码 $($result.exitCode)）：原因见 dump 与 $logFile" -ForegroundColor Red
}
exit [int]$result.exitCode
