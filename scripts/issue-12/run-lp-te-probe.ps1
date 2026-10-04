<#
  Gitea issue #12 端到端验证回路：真 LP 管道 TE 的 NBT 往返副作用验证
  ============================================================================
  一条命令跑完：前置检查 → 清陈旧结果 → 写触发文件 sde_lp_te_probe.json
  → gradlew runClientSdePipeline（独占资源）→ 游戏内探针自动进专用世界 → 走 LP 自己的放置路径
  放 4 根管道 → 等同步 → 前置校验（真 LP 管道 TE + pipe/container 非 null）→ TESR 自检
  → scan 文档（含 tileNbtB64）跑真实 MeshCaptureService 捕获（两次）→ 逐管道 writeToNBT 快照比对
  → 结果 JSON 落盘（崩溃在后不丢证据）→ 读结果 → 归档到 temp/Scene\issue-12\<Label>\。

  两种模式（同一探针，唯一差别是 JVM 属性）：
    -Mode copy     默认副本 TE 路径（被测修复；MeshCaptureService 默认分支）
    -Mode inplace  -Dsde.teCaptureMode=inplace 负对照（旧就地往返行为，预期把管道 TE 改坏）
  注意：MeshCaptureService.TE_CAPTURE_INPLACE 是 static final（类初始化时定值），
  两种模式必须是两个独立进程，不能同进程切换。

  用法：
    pwsh -File scripts/issue-12/run-lp-te-probe.ps1 -Mode copy    -Label copy-run-1
    pwsh -File scripts/issue-12/run-lp-te-probe.ps1 -Mode inplace -Label inplace-run-1

  退出码：0 = 探针全绿；2 = 有失败断言（负对照下这是预期）；3 = 探针致命（放置/超时/写出失败）；
          4 = 编排自身失败（无结果文件）；5 = 客户端进程被超时强杀。
#>
[CmdletBinding()]
param(
    # 捕获模式：copy（默认，被测修复）| inplace（负对照）
    [ValidateSet('copy', 'inplace')]
    [string]$Mode = 'copy',
    # 本次运行标签（归档目录名 + 触发文件 label）
    [string]$Label = '',
    # 客户端进程超时（分钟）
    [int]$ProcessTimeoutMinutes = 15,
    # 放置后等待服务端→客户端同步的 tick 数
    [int]$SyncWaitTicks = 120,
    # 断言落盘后继续跑多少 tick 再退出（issue #12 的崩溃在导出后 1~2 秒，故默认停留 5 s）
    [int]$PostCaptureDwellTicks = 100,
    # 只做前置检查与触发文件写入，不启动客户端
    [switch]$DryRun,
    # 跳过 TESR 自检（排查用）
    [switch]$NoSelfCheck
)

$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
$modDir = Join-Path $repoRoot 'mod\gtnh'
$mcDataDir = Join-Path $modDir 'run\client'
$gradle = 'C:\gradle-cache\wrapper\dists\gradle-9.2.1-bin\2t0n5ozlw9xmuyvbp7dnzaxug\gradle-9.2.1\bin\gradle.bat'
$stateRoot = 'D:\Workspace\Lightning\state'
$sceneDir = Join-Path $stateRoot 'Scene\issue-12'
$logDir = Join-Path $stateRoot 'logs'

if ([string]::IsNullOrWhiteSpace($Label)) {
    $Label = "lp-te-$Mode-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
}
$outDir = Join-Path $sceneDir $Label
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "issue12-$Label.log"
$sdeLog = Join-Path $logDir "issue12-$Label.sde.log"

function Step([string]$m) { Write-Host "== [issue-12/$Mode] $m" -ForegroundColor Cyan }
function Ok([string]$m) { Write-Host "   OK  $m" -ForegroundColor Green }
function Warn2([string]$m) { Write-Host "   !!  $m" -ForegroundColor Yellow }
function Err2([string]$m) { Write-Host "   XX  $m" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# ① 前置检查
# ---------------------------------------------------------------------------
Step "前置检查"

if (-not (Test-Path $gradle)) { Err2 "找不到 gradle: $gradle"; exit 4 }
Ok "gradle: $gradle（工作树 mod\gtnh\gradlew 的 wrapper jar 未入库，故用共享分发包）"

# CoFH MCP conf（缺了会在启动阶段静默挂住，与 run-parts-probe.ps1 同一坑）
$confHits = @()
foreach ($root in @((Join-Path $env:USERPROFILE '.gradle'), $env:GRADLE_USER_HOME, 'C:\gradle-cache')) {
    if ([string]::IsNullOrWhiteSpace($root)) { continue }
    $forgeDir = Join-Path $root 'caches\minecraft\net\minecraftforge\forge'
    if (-not (Test-Path $forgeDir)) { continue }
    Get-ChildItem $forgeDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $conf = Join-Path $_.FullName 'unpacked\conf'
        if (Test-Path $conf) {
            $srg = Get-ChildItem $conf -Filter '*.srg' -File -ErrorAction SilentlyContinue
            if ($srg) { $confHits += $conf }
        }
    }
}
if ($confHits.Count -eq 0) { Err2 "CoFH MCP conf 前置检查失败（不修会启动即静默挂住）"; exit 4 }
Ok "CoFH conf: $($confHits[0])"

# 陈旧结果/产物必须清掉，否则「读不到本轮结果」会退化成读到上一轮结果
$resultPath = Join-Path $mcDataDir 'sde_lp_te_probe_result.json'
$exitPath = Join-Path $mcDataDir 'sde_lp_te_probe_exit.json'
foreach ($stale in @($resultPath, $exitPath)) {
    if (Test-Path $stale) { Remove-Item -Force $stale; Ok "已清除上一轮文件: $stale" }
}
Get-ChildItem $mcDataDir -Filter 'sde_lp_te_probe_*.json' -File -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item -Force $_.FullName
    Ok "已清除陈旧产物: $($_.Name)"
}

# 独占资源检查：同一时间只允许「本工作树」的 runClient。
# 注意：不能用 -Dgradlestart.bouncerClient 判据 —— 那是 gtnhconvention 注入到*所有* GTNH 客户端
# （含其它项目的客户端）的，实测当时另有一份 GuideNH 的客户端在跑，会误报成冲突。
$running = Get-Process java -ErrorAction SilentlyContinue | Where-Object {
    $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
    $cl -and ($cl -match 'GradleStart') -and ($cl -match [regex]::Escape($modDir))
}
if ($running) {
    Err2 "本工作树已有 runClient 在跑（runClient 是独占资源）：PID $(($running.Id) -join ', ')"
    exit 4
}
Ok "本工作树没有其它 runClient 在跑（其它项目的客户端进程忽略）"

# ---------------------------------------------------------------------------
# ② 写触发文件
# ---------------------------------------------------------------------------
Step "写触发文件"

$trigger = [ordered]@{
    schema          = 'lightning.lp-te-probe.trigger/1'
    label           = $Label
    requestedBy     = 'scripts/issue-12/run-lp-te-probe.ps1'
    mode            = $Mode
    cleanupTrigger  = $true
    syncWaitTicks   = $SyncWaitTicks
    clearBeforePlace = $true
    selfCheck       = (-not $NoSelfCheck)
    postCaptureDwellTicks = $PostCaptureDwellTicks
    baseX           = 64
    baseY           = 12
    baseZ           = 64
}
$triggerPath = Join-Path $mcDataDir 'sde_lp_te_probe.json'
New-Item -ItemType Directory -Force -Path $mcDataDir | Out-Null
Set-Content -Path $triggerPath -Value ($trigger | ConvertTo-Json -Depth 6) -Encoding utf8NoBOM
Ok "触发文件: $triggerPath"

if ($DryRun) { Step "DryRun：不启动客户端"; exit 0 }

# ---------------------------------------------------------------------------
# ③ 启动客户端
# ---------------------------------------------------------------------------
# 说明（写进报告的例外）：
#  - syncWeb 依赖 web/node_modules（本树未装，且探针不依赖 web 产物）⇒ 显式 -x syncWeb；
#    processResources dependsOn syncWeb，故一并 -x，避免任务图直接失败。
#  - inplace 负对照经 JAVA_TOOL_OPTIONS 注入（build.gradle.kts 不许改；该变量会被 forked 的
#    客户端 JVM 自动采用，等价于 -Dsde.teCaptureMode=inplace）。探针会在结果 JSON 里回读
#    teCaptureMode 以证明确实生效。
Step "启动客户端（gradle runClientSdePipeline，超时 ${ProcessTimeoutMinutes} min，mode=$Mode）"
Write-Host "   完整日志: $logFile"

$gradleArgs = @('runClientSdePipeline', '-x', 'syncWeb', '-x', 'processResources', '--console=plain')
$savedJavaToolOptions = $env:JAVA_TOOL_OPTIONS
if ($Mode -eq 'inplace') {
    $env:JAVA_TOOL_OPTIONS = "$savedJavaToolOptions -Dsde.teCaptureMode=inplace".Trim()
    Ok "JAVA_TOOL_OPTIONS=$env:JAVA_TOOL_OPTIONS"
}

$started = Get-Date
$proc = Start-Process -FilePath $gradle -ArgumentList $gradleArgs `
    -WorkingDirectory $modDir -NoNewWindow -PassThru `
    -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"
$timedOut = $false
try {
    Wait-Process -Id $proc.Id -Timeout ($ProcessTimeoutMinutes * 60) -ErrorAction Stop
} catch {
    $timedOut = $true
    Err2 "客户端进程超时（${ProcessTimeoutMinutes} min），杀掉整棵进程树"
    & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null
}
$elapsed = (Get-Date) - $started
if ($Mode -eq 'inplace') { $env:JAVA_TOOL_OPTIONS = $savedJavaToolOptions }
$exitCode = $proc.ExitCode
Ok ("客户端进程结束：exitCode={0}，耗时 {1:n1} min" -f $exitCode, $elapsed.TotalMinutes)

# 无论成败先摘出 [SDE] 行（崩溃现场最要紧）
if (Test-Path $logFile) {
    Select-String -Path $logFile -Pattern '\[SDE' -Encoding utf8 | ForEach-Object { $_.Line } | Set-Content -Path $sdeLog -Encoding utf8NoBOM
    Ok "[SDE] 行已摘出: $sdeLog（$((Get-Content $sdeLog -ErrorAction SilentlyContinue | Measure-Object -Line).Lines) 行）"
}

# ---------------------------------------------------------------------------
# ④ 读结果 + 归档
# ---------------------------------------------------------------------------
Step "读结构化结果"

if (-not (Test-Path $resultPath)) {
    Err2 "探针没有产出结果文件: $resultPath"
    if ($timedOut) { Err2 "原因：外层超时强杀（见日志尾部）" }
    if (Test-Path $logFile) { Get-Content $logFile -Tail 40 | ForEach-Object { "      $_" } }
    exit 4
}

$result = Get-Content $resultPath -Raw | ConvertFrom-Json
Ok "status=$($result.status) exitCode=$($result.exitCode) label=$($result.label) mode=$($result.teCaptureMode)"

Copy-Item -Force $resultPath (Join-Path $outDir 'result.json')
Get-ChildItem $mcDataDir -Filter 'sde_lp_te_probe_*.json' -File -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item -Force $_.FullName (Join-Path $outDir $_.Name)
    Ok "产物归档: $($_.Name)"
}
Copy-Item -Force $sdeLog (Join-Path $outDir 'sde-lines.log') -ErrorAction SilentlyContinue
Copy-Item -Force $logFile (Join-Path $outDir 'gradle-runClient.log') -ErrorAction SilentlyContinue

# 本轮新崩溃报告（服务端 + 客户端）
$crashDir = Join-Path $mcDataDir 'crash-reports'
if (Test-Path $crashDir) {
    Get-ChildItem $crashDir -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -ge $started } | ForEach-Object {
        Copy-Item -Force $_.FullName (Join-Path $outDir $_.Name)
        Warn2 "新崩溃报告归档: $($_.Name)"
    }
}

Step "汇总"
Write-Host ("   status        : {0}" -f $result.status)
Write-Host ("   exitCode      : {0}（探针自报；进程退出码 {1}）" -f $result.exitCode, $exitCode)
Write-Host ("   teCaptureMode : {0}（JVM 属性 {1}）" -f $result.teCaptureMode, $result.teCaptureModeProperty)
Write-Host ("   lpVersion     : {0}" -f $result.lpVersion)
if ($result.checks) {
    foreach ($c in $result.checks) {
        $color = if ($c -like 'FAIL*') { 'Red' } else { 'Green' }
        Write-Host ("   {0}" -f $c) -ForegroundColor $color
    }
}
if ($result.teByteComparison) {
    Write-Host "   —— 逐管道 TE 快照比对 ——"
    foreach ($d in $result.teByteComparison) {
        Write-Host ("   {0,-22} nbtSame={1} containerSame={2} ok={3}" -f $d.label, $d.nbtSame, $d.containerSame, $d.ok)
    }
}
if ($result.uncaughtThrowable) { Warn2 "未捕获异常: $($result.uncaughtThrowable)" }
if ($result.newCrashReports) { Warn2 "本轮新崩溃报告: $($result.newCrashReports -join ', ')" }
if (@($result.warnings).Count -gt 0) {
    Write-Host "   警告:"
    $result.warnings | Select-Object -First 10 | ForEach-Object { Write-Host "      $_" }
}

Write-Host ""
if ($result.exitCode -eq 0) {
    Write-Host "== [issue-12/$Mode] 探针全绿（归档 $outDir）" -ForegroundColor Green
} else {
    Write-Host "== [issue-12/$Mode] 非零退出（$($result.exitCode)）：详见 $outDir 与 $logFile" -ForegroundColor Red
}
if ($timedOut) { exit 5 }
exit [int]$result.exitCode
