#!/usr/bin/env pwsh
<#
.SYNOPSIS
  输入手段族（input.*）实机验收驱动：把 Lead 定的判据（P0..P3 / M1..M12 / W1..W8 / G1）做成
  表驱动、可单条重跑、红绿可机读的一次跑完。

.DESCRIPTION
  一切动作调用**只**经 scripts/control-plane/caller.mjs（自描述驱动，无先验知识调用方）；
  判定逻辑**只**在 scripts/control-plane/input-acceptance-checks.ps1（纯函数，可离线自检）；
  本文件只做编排：写 cfg → 钉 pauseOnLostFocus → 起客户端 → 等 server.json → 按 stage 调 caller
  → 归档 → 打印红绿表 → 给退出码。

  为什么先钉再起（AGENTS.md「无人值守窗口必须保证客户端持续 tick」）：
    无人值守的客户端从不获得焦点 ⇒ MC 自动弹暂停菜单 ⇒ 不 tick ⇒ 自动化产物永不落盘。
    治本 = **点火前**把 run 目录 options.txt 的 pauseOnLostFocus 钉为 false（MC 只在启动时读它）。
    本驱动按既有纪律调 drive-session.ps1 -PinOnly 完成钉选项，并把 P0 判据钉在 options.txt 的实读上。

  stage 语义（-Stage）：
    pre   —— 前置（P0..P3）。任一红 ⇒ 立即退出 2 且不进后续 stage。除 -Stage pre 外，其余 stage 都会**先跑 pre**。
    menu  —— 主菜单（无世界）：M1..M12。不做任何世界断言。
    world —— 真实世界（world.rebuild 建托管世界 cp_input_live，void:true）：W1..W8。
    g1    —— cases/input-multitick.json 的 action 段（依赖 feat/cp-input-steps 的合入）；
             未实现时输出 blocked-by-G1（**不是** pass，也不是实现缺陷）。
    all   —— pre → menu → world → g1（默认）。

  判定口径的三条硬纪律（照 Lead 的验收口径，不放宽）：
    ① 负对照必须真变红：M7/M8/M9/M10 要求「非 0 退出 **且** 错误码命中」；
    ② 跳过不算 pass：M12 在会话内无法改变窗口尺寸时记 skipped-with-reason，计入 summary 的 skipped
       并让退出码非全绿；
    ③ G1 未实现记 blocked（blocked-by-G1），同样非全绿。

  退出码：0 全绿；2 有断言红（含 skipped / blocked）；3 管线级致命（server.json 超时 / 客户端早退）；
          4 前置检查或编排自身失败。

.EXAMPLE
  # 客户端已按窗口纪律获批在跑（复用，不启停）
  pwsh -File scripts/control-plane/run-input-acceptance.ps1 -SkipClientStart -Port 23314

.EXAMPLE
  # 只重跑世界段（自己起停客户端）
  pwsh -File scripts/control-plane/run-input-acceptance.ps1 -Stage world -Port 23314

.NOTES
  runClient 是独占资源（Gradle 锁 + 端口 + 世界存档）：用前必须按 AGENTS.md 的四步窗口纪律申请，
  一次只跑一个。本脚本默认 **不** 复用已在跑的客户端；复用请显式给 -SkipClientStart。
#>
[CmdletBinding()]
param(
    # mcDataDir（默认 <repo>\mod\gtnh\run\client）
    [string]$McDataDir = '',
    # 复用已在跑的客户端：不写 cfg、不起进程、不停进程（钉选项仍会执行，幂等）
    [switch]$SkipClientStart,
    # 跑完不停客户端（保留现场）
    [switch]$KeepClient,
    # 控制面预期端口（**仅用于前置占用检查**；调用一律以 server.json 的 port 为准）
    [int]$Port = 23314,
    # 等待 server.json / tokens.json 的上限（分钟）
    [int]$ClientReadyTimeoutMin = 8,
    # 只跑哪个 stage（all|pre|menu|world|g1）
    [ValidateSet('all', 'pre', 'menu', 'world', 'g1')]
    [string]$Stage = 'all',
    # 归档根（默认 D:\Workspace\Lightning\temp\control-plane）
    [string]$ArchiveRoot = 'D:\Workspace\Lightning\temp\control-plane',
    # 单次动作调用（含 case.run / world.rebuild）的 sync 超时（毫秒）
    [int]$ActionTimeoutMs = 600000,
    # 进入客户端之后的**整段流水线墙钟预算**（分钟）：W4 的等待轮与 g1 的 case.run 都受它约束
    [int]$ClientTimeoutMin = 30,
    # W4（D-7 到期抬起）的等待 tick 数：必须 >= 持键上限 1200，默认 1300
    [int]$PumpProofTicks = 1300,
    # G1 用的用例文件（默认 <scriptDir>\cases\input-multitick.json）
    [string]$CaseFile = '',
    # 仓根覆盖（默认 scripts/control-plane/../..）
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
# 原生命令写 stderr 不应触发 Stop（PS 7.4+ 的行为开关）
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

# ---------------------------------------------------------------------------
# 路径与状态
# ---------------------------------------------------------------------------
$scriptDir = $PSScriptRoot
$repoRoot = if ([string]::IsNullOrWhiteSpace($RepoRoot)) { (Resolve-Path (Join-Path $scriptDir '..\..')).Path } else { (Resolve-Path $RepoRoot).Path }
$modDir = Join-Path $repoRoot 'mod\gtnh'
$gradlew = Join-Path $modDir 'gradlew.bat'
$webNodeModules = Join-Path $repoRoot 'web\node_modules'
$mcDataDir = if ([string]::IsNullOrWhiteSpace($McDataDir)) { Join-Path $modDir 'run\client' } else { [System.IO.Path]::GetFullPath($McDataDir) }
$cpDir = Join-Path $mcDataDir 'controlplane'
$runsDir = Join-Path $cpDir 'runs'
$serverJsonPath = Join-Path $cpDir 'server.json'
$tokensJsonPath = Join-Path $cpDir 'tokens.json'
$eventsFile = Join-Path $cpDir 'events.jsonl'
$clientLog = Join-Path $mcDataDir 'logs\fml-client-latest.log'
$cfgPath = Join-Path $mcDataDir 'config\lightning.cfg'
$optionsPath = Join-Path $mcDataDir 'options.txt'
$callerPath = Join-Path $scriptDir 'caller.mjs'
$driveSession = Join-Path $scriptDir 'drive-session.ps1'
$casePath = if ([string]::IsNullOrWhiteSpace($CaseFile)) { Join-Path $scriptDir 'cases\input-multitick.json' } else { [System.IO.Path]::GetFullPath($CaseFile) }

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$archiveDir = Join-Path $ArchiveRoot "input-$ts"
$logDir = Join-Path $archiveDir 'logs'
$staleDir = Join-Path $archiveDir 'stale'
$runsArchive = Join-Path $archiveDir 'runs'
$script:checks = New-Object System.Collections.ArrayList
$script:createdRuns = New-Object System.Collections.ArrayList
$script:notes = New-Object System.Collections.ArrayList
$script:fatalCode = 0
$script:exitCode = 2
$script:clientProc = $null
$script:cfgExisted = $false
$script:tickSeq = 0
$script:waitSeq = 0
$script:stageLog = New-Object System.Collections.ArrayList
$script:sessionDeadline = (Get-Date).AddMinutes([math]::Max(1, $ClientTimeoutMin))
$script:serverInfo = $null
$script:playerPosPointer = '(未探测)'
$script:probeNotes = New-Object System.Collections.ArrayList

function Write-Step([string]$msg) { Write-Host "== [CP-INPUT] $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host "   OK  $msg" -ForegroundColor Green }
function Write-Warn2([string]$msg) { Write-Host "   !!  $msg" -ForegroundColor Yellow }
function Write-Err2([string]$msg) { Write-Host "   XX  $msg" -ForegroundColor Red }
function Write-Info([string]$msg) { Write-Host "   --  $msg" -ForegroundColor DarkCyan }
function Write-Dim([string]$msg) { Write-Host "      $msg" -ForegroundColor DarkGray }

function Fail-Fatal([string]$Message, [int]$Code) {
    $script:fatalCode = $Code
    throw $Message
}

function Add-Note([string]$Text) { [void]$script:notes.Add($Text) }
function Add-ProbeNote([string]$Text) { [void]$script:probeNotes.Add($Text); Write-Info "探针（不作判据）: $Text" }

# 判定结果入表（check 对象或数组；数组摊平）
function Add-Check {
    param($Check)
    foreach ($c in @($Check)) {
        if ($null -eq $c) { continue }
        [void]$script:checks.Add($c)
        $mark = switch ("$($c.status)") { 'pass' { 'PASS' } 'fail' { 'FAIL' } 'skipped' { 'SKIP' } 'blocked' { 'BLOCK' } default { 'FAIL' } }
        $color = switch ("$($c.status)") { 'pass' { 'Green' } 'fail' { 'Red' } 'skipped' { 'Yellow' } 'blocked' { 'Magenta' } default { 'Red' } }
        Write-Host ("   {0,-5} {1,-14} {2}" -f $mark, $c.id, $c.detail) -ForegroundColor $color
    }
}

function Get-CheckCounts {
    $c = @{ pass = 0; fail = 0; skipped = 0; blocked = 0 }
    foreach ($x in $script:checks) { if ($c.ContainsKey("$($x.status)")) { $c["$($x.status)"] = $c["$($x.status)"] + 1 } else { $c['fail'] = $c['fail'] + 1 } }
    return $c
}

function Get-Text([string]$Path, [int]$Lines = 40) {
    try { if (Test-Path $Path) { return @(Get-Content $Path -Tail $Lines) } } catch { return @("(读取失败: $($_.Exception.Message))") }
    return @()
}

function Show-LogTail([string]$Path, [int]$Lines = 40) {
    foreach ($l in (Get-Text $Path $Lines)) { Write-Dim $l }
}

function Read-JsonFile([string]$Path) {
    if (-not (Test-Path $Path)) { return $null }
    try { return (Get-Content -Raw -Encoding UTF8 $Path | ConvertFrom-Json) } catch { return $null }
}

function Test-PortListening([int]$P) {
    try {
        $conns = @(Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction Stop)
        if ($conns.Count -gt 0) { return $true }
    } catch { }
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $client.Connect('127.0.0.1', $P)
        $client.Close()
        return $true
    } catch { return $false }
}

# ---------------------------------------------------------------------------
# 判定模块（纯函数）先加载：本脚本的所有断言都来自它
# ---------------------------------------------------------------------------
$checksModule = Join-Path $scriptDir 'input-acceptance-checks.ps1'
if (-not (Test-Path $checksModule)) { Write-Err2 "找不到判定模块 $checksModule"; exit 4 }
. $checksModule

# ---------------------------------------------------------------------------
# 调用方：只经 caller.mjs；每次调用记录新增 run 目录（归档要覆盖全部产物）
# ---------------------------------------------------------------------------
function Get-RunDirNames {
    if (-not (Test-Path $runsDir)) { return @() }
    return @(Get-ChildItem -Directory $runsDir -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
}

function Invoke-Cp {
    param(
        [Parameter(Mandatory = $true)][string]$Action,
        $Params = @{},
        [string]$Label = '',
        [switch]$Sync,
        [switch]$Describe,
        [string]$Tier = '',
        [switch]$AllowUnknownParams,
        [int]$TimeoutMs = 0
    )
    if ([string]::IsNullOrWhiteSpace($Label)) { $Label = ($Action -replace '[^A-Za-z0-9._-]', '_') }
    if ($TimeoutMs -le 0) { $TimeoutMs = $ActionTimeoutMs }
    $jsonOut = Join-Path $logDir "caller-$Label.json"
    $body = '{}'
    if ($Params -is [string]) { $body = $Params }
    elseif ($null -ne $Params) { $body = ($Params | ConvertTo-Json -Compress -Depth 10) }

    $av = @($callerPath, $Action)
    if (-not $Describe) { $av += $body }
    $av += @('--mc-dir', $mcDataDir, '--json-out', $jsonOut)
    if ($Describe) { $av += '--describe' } else { $av += @('--timeoutMs', "$TimeoutMs") }
    if (-not [string]::IsNullOrWhiteSpace($Tier)) { $av += @('--tier', $Tier) }
    if ($Sync) { $av += '--sync' }
    if ($AllowUnknownParams) { $av += '--allow-unknown-params' }

    $before = Get-RunDirNames
    Write-Dim ("> node caller.mjs {0} {1}{2}{3}" -f $Action, $(if ($Describe) { '--describe' } else { $body }), $(if ($Sync) { ' --sync' } else { '' }), $(if ($Tier) { " --tier $Tier" } else { '' }))
    $raw = & node @av 2>&1 | Out-String
    $code = $LASTEXITCODE
    $newNames = @((Get-RunDirNames) | Where-Object { $before -notcontains $_ })
    foreach ($n in $newNames) {
        $p = Join-Path $runsDir $n
        if (-not $script:createdRuns.Contains($p)) { [void]$script:createdRuns.Add($p) }
    }
    $doc = $null
    if (Test-Path $jsonOut) { try { $doc = Get-Content -Raw -Encoding UTF8 $jsonOut | ConvertFrom-Json } catch { $doc = $null } }
    foreach ($line in ($raw -split "`r?`n")) { if ($line.Trim().Length -gt 0) { Write-Dim "  $line" } }
    Write-Dim ("  <- exit={0} runDirs新增={1}" -f $code, $newNames.Count)

    return [pscustomobject]@{
        action  = $Action
        label   = $Label
        exitCode = $code
        json    = $doc
        jsonPath = $jsonOut
        output  = $raw
        newRuns = @($newNames)
    }
}

# ---------------------------------------------------------------------------
# 客户端 tick 记账：core.status.world.totalTime（单调 tick 计数）
#   它**不触碰输入运行时**（StatusAction 只读世界/版本/事件/快照路径），因此不会顺带结算到期，
#   可以安全地用作 W4 的等待边界量。
# ---------------------------------------------------------------------------
function Get-ClientTick {
    $script:tickSeq++
    $t = Invoke-Cp -Action 'core.status' -Params @{} -Label ("tick-{0:d3}" -f $script:tickSeq) -Sync -Tier 'observe' -TimeoutMs 30000
    $res = Get-CpTrialResult $t
    $tot = Get-CpProp (Get-CpProp $res 'world') 'totalTime'
    if ($null -eq $tot) { return $null }
    return [long]$tot
}

# 等待的墙钟预算 = 名义 5 倍（1 tick = 50ms ⇒ 5 倍 = 每 tick 0.25s），下限 30s。
# 为什么不是「等够 tick 数就停」就够：真实的 tick 速率受客户端帧率与 HTTP 往返影响，
# 预算只负责兜住「客户端根本没 tick」这种病态，不参与判据。
function Get-WaitBudget([int]$Ticks) {
    return [int][math]::Max(30, [math]::Ceiling($Ticks * 0.25))
}

# 等待客户端推进 N tick。
#   -ReadPlayerOnly：轮内**只**发 read.player（W4 的严格口径：任何 input.* 调用都会顺带结算到期，
#                    会污染「泵抬起的」与「读的时候才抬起的」的可区分性）；
#                    轮边界才发一次 core.status 记账（边界不属于「等待期间」）。
function Wait-ClientTicks {
    param(
        [int]$TargetTicks,
        [int]$RoundSec = 12,
        [switch]$ReadPlayerOnly,
        [int]$BudgetSeconds = 0
    )
    $remaining = [int]($script:sessionDeadline - (Get-Date)).TotalSeconds
    if ($remaining -lt 10) { $remaining = 10 }
    $budget = if ($BudgetSeconds -gt 0) { [math]::Min($BudgetSeconds, $remaining) } else { $remaining }
    $startTick = Get-ClientTick
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $calls = 0
    $lastPlayer = $null
    $delta = -1
    while ($true) {
        $roundSw = [System.Diagnostics.Stopwatch]::StartNew()
        while ($roundSw.Elapsed.TotalSeconds -lt $RoundSec) {
            $script:waitSeq++
            $lastPlayer = Invoke-Cp -Action 'read.player' -Params @{} -Label ("wait-player-{0:d4}" -f $script:waitSeq) -Sync -Tier 'observe' -TimeoutMs 30000
            $calls++
            if (-not $ReadPlayerOnly) { $null = Get-ClientTick }
            Start-Sleep -Milliseconds 40
            if ($sw.Elapsed.TotalSeconds -ge $budget) { break }
        }
        $nowTick = Get-ClientTick
        if ($null -ne $nowTick -and $null -ne $startTick) { $delta = [long]$nowTick - [long]$startTick }
        if ($delta -ge $TargetTicks) { break }
        if ($sw.Elapsed.TotalSeconds -ge $budget) { break }
    }
    Write-Info ("等待 {0} tick 完成：实测 tick 增量={1}（read.player 调用 {2} 次，墙钟 {3:N1}s，只调 read.player={4}）" -f $TargetTicks, $delta, $calls, $sw.Elapsed.TotalSeconds, [bool]$ReadPlayerOnly)
    return [pscustomobject]@{
        tickDelta       = $delta
        wallSec         = $sw.Elapsed.TotalSeconds
        readPlayerCalls = $calls
        lastPlayer      = $lastPlayer
    }
}

function Get-PlayerPos {
    param($Trial)
    $res = Get-CpTrialResult $Trial
    if ($null -eq $res) { return $null }
    $p = Get-CpPlayerPosPointer $res
    if ($null -eq $p) { return $null }
    $script:playerPosPointer = $(if ($p -eq '') { '(根即坐标数组)' } else { $p })
    return (Get-CpPointer $res $p)
}

# ---------------------------------------------------------------------------
# cfg：写 controlplane { B:enabled=true; I:port=<slot> }（Forge 形态）+ 备份/还原
#   与 run-shots.ps1 / run-smoke.ps1 同一实现（刻意复制而非抽公共：各自的归档/还原路径耦合在自身）。
#   契约事实：Forge Configuration 的分节是 `name {` … `}`，不是 INI 的 [name]
#   （实测：写 [controlplane] 会被 Forge 忽略并重写为默认值 ⇒ 控制面没起来）。
# ---------------------------------------------------------------------------
function Enable-ControlPlaneCfg([string]$Path, [int]$Slot) {
    $lines = @()
    if (Test-Path $Path) { $lines = @(Get-Content $Path) }
    $section = ''
    $doneEnabled = $false
    $donePort = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if ($line -match '^\s*\[(.+?)\]\s*$') { $section = $Matches[1].Trim().ToLowerInvariant(); continue }
        if ($line -match '^\s*([A-Za-z0-9_.-]+)\s*\{\s*$') { $section = $Matches[1].Trim().ToLowerInvariant(); continue }
        if ($line -match '^\s*\}\s*$') { $section = ''; continue }
        if ($section -eq 'controlplane' -and $line -match '^\s*[BISED]:\s*enabled\s*=') {
            $lines[$i] = '    B:enabled=true'
            $doneEnabled = $true
            continue
        }
        if ($section -eq 'controlplane' -and $line -match '^\s*I:\s*port\s*=') {
            $lines[$i] = "    I:port=$Slot"
            $donePort = $true
            continue
        }
    }
    if (-not $doneEnabled -or -not $donePort) {
        if ($lines.Count -gt 0 -and $lines[-1].Trim() -ne '') { $lines += '' }
        $lines += 'controlplane {'
        if (-not $doneEnabled) { $lines += '    B:enabled=true' }
        if (-not $donePort) { $lines += "    I:port=$Slot" }
        $lines += '}'
    }
    $parent = Split-Path $Path -Parent
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Set-Content -Path $Path -Value $lines -Encoding utf8NoBOM
    return [pscustomobject]@{ enabledReplaced = $doneEnabled; portReplaced = $donePort }
}

function Restore-LightningCfg {
    if ($SkipClientStart) { return }
    try {
        if ($script:cfgExisted) {
            Copy-Item -Force (Join-Path $archiveDir 'lightning.cfg.before') $cfgPath
            Write-Ok "已还原 lightning.cfg（备份在 $archiveDir\lightning.cfg.before）"
        } elseif (Test-Path $cfgPath) {
            # 不删除：移到归档目录（铁律：AI 不删除，只标记）
            Move-Item -Force $cfgPath (Join-Path $archiveDir 'lightning.cfg.created-by-run-input-acceptance')
            Write-Ok '已移除本次新建的 lightning.cfg（原件移入归档）'
        }
    } catch { Write-Warn2 "还原 lightning.cfg 失败: $($_.Exception.Message)" }
}

# ---------------------------------------------------------------------------
# 前置检查（编排自身失败 ⇒ 退出码 4）
# ---------------------------------------------------------------------------
Write-Step "前置检查"
New-Item -ItemType Directory -Force -Path $archiveDir, $logDir, $staleDir | Out-Null

if (-not (Test-Path $gradlew)) { Write-Err2 "找不到 $gradlew"; exit 4 }
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { Write-Err2 'PATH 里找不到 node（caller.mjs 需要 Node 18+）'; exit 4 }
if (-not (Test-Path $callerPath)) { Write-Err2 "找不到 $callerPath"; exit 4 }
if (-not (Test-Path $checksModule)) { Write-Err2 "找不到 $checksModule"; exit 4 }
if (-not (Test-Path $mcDataDir)) { Write-Err2 "找不到 mcDataDir: $mcDataDir（客户端至少跑过一次才会有 run/client）"; exit 4 }
Write-Ok "node: $nodeExe"
Write-Ok "mcDataDir: $mcDataDir"

if ($Stage -in @('all', 'world', 'g1') -and -not (Test-Path $casePath)) {
    Write-Err2 "找不到 G1 用例文件: $casePath"; exit 4
}

if (-not $SkipClientStart) {
    if (-not (Test-Path $webNodeModules)) {
        Write-Err2 "找不到 $webNodeModules —— runClient 依赖 syncWeb→vite，请先执行: cd web; npm i"
        exit 4
    }
    if (-not (Test-Path $driveSession)) { Write-Err2 "找不到 $driveSession（钉 pauseOnLostFocus 用）"; exit 4 }
    $portBusy = Test-PortListening $Port
    if ($portBusy) { Write-Err2 "端口 $Port 已被占用（runClient 是独占资源：先确认没有别的客户端在跑）"; exit 4 }
    Write-Ok "端口 $Port 空闲（仅前置占用检查；实调一律以 server.json 为准）"
} else {
    Write-Warn2 '-SkipClientStart：不写 cfg、不起进程、不停进程（钉选项仍会执行）'
}

# ---------------------------------------------------------------------------
# 钉 pauseOnLostFocus=false（**必须先钉再起**：MC 只在启动时读 options.txt）
# ---------------------------------------------------------------------------
Write-Step '钉 options.txt 的 pauseOnLostFocus:false（无人值守持续 tick 的治本项）'
if (Test-Path $driveSession) {
    $pinOut = & pwsh -NoProfile -File $driveSession -RunDir $mcDataDir -Tag input -PinOnly 2>&1 | Out-String
    foreach ($l in ($pinOut -split "`r?`n")) { if ($l.Trim().Length -gt 0) { Write-Dim "  $l" } }
    if ($LASTEXITCODE -ne 0) { Write-Err2 "drive-session.ps1 -PinOnly 失败（exit $LASTEXITCODE）"; exit 4 }
} else {
    Write-Warn2 "找不到 drive-session.ps1；跳过钉选项（P0 判据仍会实读 options.txt）"
}

# ---------------------------------------------------------------------------
# 写 cfg + 起客户端
# ---------------------------------------------------------------------------
try {
    if (-not $SkipClientStart) {
        Write-Step "写 lightning.cfg（controlplane { B:enabled=true; I:port=$Port }，原值备份）"
        $script:cfgExisted = Test-Path $cfgPath
        if ($script:cfgExisted) { Copy-Item -Force $cfgPath (Join-Path $archiveDir 'lightning.cfg.before'); Write-Ok '原值已备份' }
        else { Write-Warn2 'lightning.cfg 不存在，本次新建（收尾会移入归档，不删除）' }
        $r = Enable-ControlPlaneCfg $cfgPath $Port
        Write-Ok ("lightning.cfg 已写（enabled 替换={0} port 替换={1}）" -f $r.enabledReplaced, $r.portReplaced)

        # 陈旧发现文件移开：否则会读到上一轮的 port/token（只能连到死人端口）
        foreach ($f in @($serverJsonPath, $tokensJsonPath)) {
            if (Test-Path $f) { Move-Item -Force $f (Join-Path $staleDir (Split-Path $f -Leaf)); Write-Warn2 "陈旧发现文件已移入归档: $(Split-Path $f -Leaf)" }
        }

        Write-Step "启动客户端（gradlew runClient25 --console=plain，日志 $logDir\gradle-runClient.log）"
        $env:JAVA_TOOL_OPTIONS = '-Dfml.queryResult=confirm'
        try {
            $script:clientProc = Start-Process -FilePath $gradlew `
                -ArgumentList @('runClient25', '--console=plain') `
                -WorkingDirectory $modDir -NoNewWindow -PassThru `
                -RedirectStandardOutput (Join-Path $logDir 'gradle-runClient.log') `
                -RedirectStandardError (Join-Path $logDir 'gradle-runClient.err')
        } finally {
            Remove-Item Env:\JAVA_TOOL_OPTIONS -ErrorAction SilentlyContinue
        }
        Write-Ok "客户端进程 pid=$($script:clientProc.Id)"

        Write-Step "等待 server.json / tokens.json（上限 $ClientReadyTimeoutMin min）"
        $deadline = (Get-Date).AddMinutes($ClientReadyTimeoutMin)
        $ready = $false
        while ((Get-Date) -lt $deadline) {
            if ($script:clientProc.HasExited) {
                Show-LogTail (Join-Path $logDir 'gradle-runClient.log') 40
                Fail-Fatal "客户端进程提前退出（exitCode=$($script:clientProc.ExitCode)）" 3
            }
            if ((Test-Path $serverJsonPath) -and (Test-Path $tokensJsonPath)) { $ready = $true; break }
            Start-Sleep -Seconds 2
        }
        if (-not $ready) {
            Show-LogTail (Join-Path $logDir 'gradle-runClient.log') 40
            Fail-Fatal "等待 server.json 超时（$ClientReadyTimeoutMin min）：$serverJsonPath 未出现" 3
        }
    } else {
        if (-not (Test-Path $serverJsonPath)) { Fail-Fatal "-SkipClientStart 但找不到 server.json（$serverJsonPath）：控制面没起来？" 4 }
    }

    $script:serverInfo = Read-JsonFile $serverJsonPath
    if ($null -eq $script:serverInfo -or -not $script:serverInfo.port) { Fail-Fatal "server.json 不可读或非法（$serverJsonPath）" 4 }
    $boundPort = [int]$script:serverInfo.port
    Write-Ok ("控制面: port={0} contractVersion={1}" -f $boundPort, $script:serverInfo.contractVersion)
    if ($boundPort -ne $Port) { Write-Warn2 "实际绑定端口 $boundPort 与预期 $Port 不同（契约 §1.3 允许回退）；后续调用一律以 server.json 为准" }

    Write-Step 'core.ping（等 HTTP 真正可连）'
    $pingDeadline = (Get-Date).AddSeconds(90)
    $ping = $null
    while ($true) {
        $ping = Invoke-Cp -Action 'core.ping' -Params @{} -Label 'ping' -TimeoutMs 20000
        if ($ping.exitCode -eq 0) { break }
        if ((Get-Date) -ge $pingDeadline) { break }
        Start-Sleep -Seconds 3
    }
    Add-Check (New-CpCheck 'O.ping' $(if ($ping.exitCode -eq 0) { 'pass' } else { 'fail' }) "core.ping 退出码 $($ping.exitCode)（0=done）")

    # ---------------------------------------------------------------- stage pre
    $stagesToRun = if ($Stage -eq 'all') { @('pre', 'menu', 'world', 'g1') }
    elseif ($Stage -eq 'pre') { @('pre') }
    else { @('pre', $Stage) }

    foreach ($st in $stagesToRun) {
        [void]$script:stageLog.Add($st)
        Write-Step "stage: $st"

        # ================================================================= pre
        if ($st -eq 'pre') {
            $optText = if (Test-Path $optionsPath) { (Get-Content -Raw -Encoding UTF8 $optionsPath) } else { '' }
            Add-Check (Test-InputP0PauseOnLostFocus -OptionsText $optText -OptionsPath $optionsPath)
            Add-Check (Test-InputP1ContractVersion -ServerJson $script:serverInfo)
            # --actions 是 caller.mjs 的专属开关（不是动作名）：只能手工构造这条命令行
            $catPath = Join-Path $logDir 'caller-actions.json'
            $catRaw = & node $callerPath '--actions' '--mc-dir' $mcDataDir '--json-out' $catPath 2>&1 | Out-String
            $catCode = $LASTEXITCODE
            foreach ($l in ($catRaw -split "`r?`n")) { if ($l.Trim().Length -gt 0) { Write-Dim "  $l" } }
            $catDoc = Read-JsonFile $catPath
            Add-Check (New-CpCheck 'O.actions' $(if ($catCode -eq 0 -and $null -ne $catDoc) { 'pass' } else { 'fail' }) "GET /actions 退出码 $catCode；count=$([string](Get-CpProp $catDoc 'count'))")
            Add-Check (Test-InputP2ActionCatalog -Catalog $catDoc)
            Add-Check (Test-InputP3MeansNotLeaked -Catalog $catDoc)
            $preCounts = Get-CheckCounts
            if ($preCounts.fail -gt 0 -or $preCounts.blocked -gt 0) {
                Write-Err2 "pre 段有红（$($preCounts.fail) 红）⇒ 不进后续 stage（退出码 2）"
                $script:exitCode = 2
                break
            }
            if ($st -eq 'pre' -and $Stage -eq 'pre') { break }
            continue
        }

        # ================================================================ menu
        if ($st -eq 'menu') {
            $statusTrial = Invoke-Cp -Action 'core.status' -Params @{} -Label 'menu-status' -Sync -Tier 'observe'
            Add-Check (Test-InputM0NoWorld -StatusTrial $statusTrial)

            $m1 = Invoke-Cp -Action 'input.key' -Params @{ key = 'key.forward'; action = 'down'; confirm = $true } -Label 'm1-down' -Sync -Tier 'scene'
            Add-Check (Test-InputM1KeyDown -Trial $m1)

            $m2 = Invoke-Cp -Action 'input.key' -Params @{ key = 'key.forward'; action = 'down'; confirm = $true } -Label 'm2-down-again' -Sync -Tier 'scene'
            Add-Check (Test-InputM2KeyDownIdempotent -Trial $m2)

            $m3a = Invoke-Cp -Action 'input.release' -Params @{ confirm = $true } -Label 'm3-release-1' -Sync -Tier 'scene'
            $m3b = Invoke-Cp -Action 'input.release' -Params @{ confirm = $true } -Label 'm3-release-2' -Sync -Tier 'scene'
            Add-Check (Test-InputM3Release -First $m3a -Second $m3b)

            $m4 = Invoke-Cp -Action 'input.key' -Params @{ key = 'key.forward'; action = 'tap'; holdTicks = 1; confirm = $true } -Label 'm4-tap-1' -Sync -Tier 'scene'
            Add-Check (Test-InputM4TapSameTick -Trial $m4)

            $m5 = Invoke-Cp -Action 'input.key' -Params @{ key = 'key.forward'; action = 'tap'; holdTicks = 5; confirm = $true } -Label 'm5-tap-5' -Sync -Tier 'scene'
            Add-Check (Test-InputM5TapCrossFrame -Trial $m5)

            $m6 = Invoke-Cp -Action 'input.mouse' -Params @{ op = 'wheel'; amount = 1; confirm = $true } -Label 'm6-wheel-1' -Sync -Tier 'scene'
            Add-Check (Test-InputM6Wheel -Trial $m6)

            $m7 = Invoke-Cp -Action 'input.mouse' -Params @{ op = 'wheel'; amount = 0; confirm = $true } -Label 'm7-wheel-0' -Sync -Tier 'scene'
            Add-Check (Test-InputM7WheelZeroRejected -Trial $m7)

            $m8 = Invoke-Cp -Action 'input.key' -Params @{ key = 'key.forward'; action = 'tap'; holdTicks = 1201; confirm = $true } -Label 'm8-hold-1201' -Sync -Tier 'scene'
            Add-Check (Test-InputM8HoldTicksOverMaxRejected -Trial $m8)

            $m9 = Invoke-Cp -Action 'input.key' -Params @{ key = 'key.forward'; action = 'down'; holdTicks = 3; confirm = $true } -Label 'm9-down-holdticks' -Sync -Tier 'scene'
            Add-Check (Test-InputM9HoldTicksInapplicableRejected -Trial $m9)

            $m10 = Invoke-Cp -Action 'input.text' -Params @{ text = 'hi'; confirm = $true } -Label 'm10-text' -Sync -Tier 'scene'
            Add-Check (Test-InputM10TextNotReady -Trial $m10)

            $m11 = Invoke-Cp -Action 'input.state' -Params @{} -Label 'm11-state' -Sync -Tier 'observe'
            Add-Check (Test-InputM11InputState -Trial $m11)

            # M12：窗口/尺度上下文失效。会话内无法改变窗口尺寸 ⇒ 如实 skipped-with-reason。
            # 第二份快照在世界段之后取（若操作者此时改了窗口，本判据会转为可机读的绿）。
            $script:m12First = $m11
            Add-Check (Test-InputM12ScaleContext -First $script:m12First -Second $null)
            continue
        }

        # =============================================================== world
        if ($st -eq 'world') {
            $rebuildParams = @{
                folder = 'cp_input_live'; seed = 20261008; void = $true
                base = @(64, 12, 64); settleTicks = 60; confirm = $true
            }
            $rb = Invoke-Cp -Action 'world.rebuild' -Params $rebuildParams -Label 'world-rebuild' -Sync -Tier 'scene' -TimeoutMs $ActionTimeoutMs
            Add-Check (New-CpCheck 'O.rebuild' $(if ($rb.exitCode -eq 0) { 'pass' } else { 'fail' }) "world.rebuild(cp_input_live, void) 退出码 $($rb.exitCode)")

            $w1 = Invoke-Cp -Action 'core.status' -Params @{} -Label 'w1-status' -Sync -Tier 'observe'
            Add-Check (Test-InputW1WorldManaged -Trial $w1)

            # 位置字段名探测（不硬编码猜）：read.player 的实际返回 + 自描述，两者都落 summary
            $playerDesc = Invoke-Cp -Action 'read.player' -Describe -Label 'describe-read.player'
            $descReturns = [string](Get-CpProp $playerDesc.json 'returns')
            Add-Note ("read.player 自描述 returns: " + $(if ([string]::IsNullOrWhiteSpace($descReturns)) { '(读不到)' } else { $descReturns }))

            $w2 = Invoke-Cp -Action 'input.key' -Params @{ key = 'key.forward'; action = 'tap'; holdTicks = 20; confirm = $true } -Label 'w2-tap-20' -Sync -Tier 'scene'
            Add-Check (Test-InputW2UnfocusedAdvance -Trial $w2)

            # ---- W3：世界相对移动生效（W4 的正对照）
            $w3down = Invoke-Cp -Action 'input.key' -Params @{ key = 'key.forward'; action = 'down'; confirm = $true } -Label 'w3-down' -Sync -Tier 'scene'
            $posATrial = Invoke-Cp -Action 'read.player' -Params @{} -Label 'w3-pos-a' -Sync -Tier 'observe'
            $posA = Get-PlayerPos $posATrial
            $wait3 = Wait-ClientTicks -TargetTicks 40 -RoundSec 6 -BudgetSeconds (Get-WaitBudget 40)
            $posBTrial = Invoke-Cp -Action 'read.player' -Params @{} -Label 'w3-pos-b' -Sync -Tier 'observe'
            $posB = Get-PlayerPos $posBTrial
            $w3rel = Invoke-Cp -Action 'input.release' -Params @{ confirm = $true } -Label 'w3-release' -Sync -Tier 'scene'
            if ($w3down.exitCode -ne 0 -or $w3rel.exitCode -ne 0) {
                Add-Check (New-CpFail 'W3' "down/release 调用未成功（down exit=$($w3down.exitCode) release exit=$($w3rel.exitCode)）")
            } else {
                Add-Check (Test-InputW3MovementEffective -PosA $posA -PosB $posB -MinDistance 0.5 -WaitTicks 40)
            }

            # ---- W4：D-7 到期抬起（只用 read.player 观测；两次等待各自带 tick 证据）
            $w4down = Invoke-Cp -Action 'input.key' -Params @{ key = 'key.forward'; action = 'down'; confirm = $true } -Label 'w4-down' -Sync -Tier 'scene'
            $posATrial4 = Invoke-Cp -Action 'read.player' -Params @{} -Label 'w4-pos-a' -Sync -Tier 'observe'
            $posA4 = Get-PlayerPos $posATrial4
            $wait4 = Wait-ClientTicks -TargetTicks $PumpProofTicks -RoundSec 12 -ReadPlayerOnly -BudgetSeconds (Get-WaitBudget $PumpProofTicks)
            $posBTrial4 = Invoke-Cp -Action 'read.player' -Params @{} -Label 'w4-pos-b' -Sync -Tier 'observe'
            $posB4 = Get-PlayerPos $posBTrial4
            $tickAtB = Get-ClientTick
            $wait4b = Wait-ClientTicks -TargetTicks 200 -RoundSec 8 -ReadPlayerOnly -BudgetSeconds (Get-WaitBudget 200)
            $posCTrial4 = Invoke-Cp -Action 'read.player' -Params @{} -Label 'w4-pos-c' -Sync -Tier 'observe'
            $posC4 = Get-PlayerPos $posCTrial4
            $tickAtC = Get-ClientTick
            $tailDelta = if ($null -ne $tickAtB -and $null -ne $tickAtC) { [long]$tickAtC - [long]$tickAtB } else { -1 }
            $w4rel = Invoke-Cp -Action 'input.release' -Params @{ confirm = $true } -Label 'w4-release' -Sync -Tier 'scene'

            if ($w4down.exitCode -ne 0) {
                Add-Check (New-CpFail 'W4' "W4 的 down 未成功（exit=$($w4down.exitCode)）⇒ 判据不成立")
            } else {
                Add-Check (Test-InputW4ExpiryPump -PosA $posA4 -PosB $posB4 -PosC $posC4 -PumpProofTicks $PumpProofTicks)
            }
            Add-Check (Test-InputW4TickEvidence -TickDelta $wait4.tickDelta -PumpProofTicks $PumpProofTicks -WallSeconds $wait4.wallSec)
            Add-ProbeNote ("W4 尾段（B→C）等待 200 tick 实测 tick 增量={0}（墙钟 {1:N1}s）" -f $tailDelta, $wait4b.wallSec)

            # ---- W5：移动自校准（坐标取 GUI 缩放中点附近）
            $st5 = Invoke-Cp -Action 'input.state' -Params @{} -Label 'w5-state' -Sync -Tier 'observe'
            $coords = Get-CpProp (Get-CpTrialResult $st5) 'coordinates'
            $sw = Get-CpProp $coords 'scaledWidth'; $sh = Get-CpProp $coords 'scaledHeight'
            if ($null -eq $sw -or $null -eq $sh -or [int]$sw -le 4 -or [int]$sh -le 4) {
                Add-Check (New-CpFail 'W5' "input.state.coordinates 不可用（scaledWidth=$sw scaledHeight=$sh）⇒ 无法构造 GUI 坐标")
            } else {
                $mx = [int]([math]::Floor([int]$sw / 2)); $my = [int]([math]::Floor([int]$sh / 2))
                Write-Info "W5 目标 GUI 坐标 = ($mx,$my)（scaled ${sw}x${sh}）"
                $w5 = Invoke-Cp -Action 'input.mouse' -Params @{ op = 'move'; x = $mx; y = $my; confirm = $true } -Label 'w5-move-center' -Sync -Tier 'scene'
                Add-Check (Test-InputW5MouseMoveCalibration -Trial $w5)
            }

            # ---- W6：拖动命中（move → 等 ≥2 tick → down → move → up）
            $w6m1x = if ($null -ne $sw) { [int]([math]::Floor([int]$sw / 2)) } else { 100 }
            $w6m1y = if ($null -ne $sh) { [int]([math]::Floor([int]$sh / 2)) } else { 100 }
            $w6m2x = $w6m1x + 20; $w6m2y = $w6m1y + 10
            $w6a = Invoke-Cp -Action 'input.mouse' -Params @{ op = 'move'; x = $w6m1x; y = $w6m1y; confirm = $true } -Label 'w6-1-move' -Sync -Tier 'scene'
            $null = Wait-ClientTicks -TargetTicks 2 -RoundSec 3 -BudgetSeconds (Get-WaitBudget 2)
            $w6b = Invoke-Cp -Action 'input.mouse' -Params @{ op = 'down'; button = 0; confirm = $true } -Label 'w6-2-down' -Sync -Tier 'scene'
            $w6c = Invoke-Cp -Action 'input.mouse' -Params @{ op = 'move'; x = $w6m2x; y = $w6m2y; confirm = $true } -Label 'w6-3-move' -Sync -Tier 'scene'
            $w6d = Invoke-Cp -Action 'input.mouse' -Params @{ op = 'up'; button = 0; confirm = $true } -Label 'w6-4-up' -Sync -Tier 'scene'
            Add-Check (Test-InputW6DragExitCodes -Trials @($w6a, $w6b, $w6c, $w6d))
            Add-Check (Test-InputW6HitSetTruthy -DownTrial $w6b)

            # ---- W7：GUI 实拍（gui:"screen"）
            $shotDesc = Invoke-Cp -Action 'shot.multi' -Describe -Label 'describe-shot.multi'
            $w7a = Test-InputW7GuiParamDeclared -Descriptor $shotDesc.json
            Add-Check $w7a
            $shotCameras = @(
                @{ name = 'gui-live'; pos = @(64.5, 20.0, 70.5); yaw = 180.0; pitch = 45.0
                    projection = @{ type = 'perspective'; fov = 70 }; resolution = @(854, 480) }
            )
            # 正路径：开一个真界面（否则 guiCapture 只是「拍了但没有界面」的如实读数）→ gui:screen 拍摄
            $guiOpen = Invoke-Cp -Action 'player.gui' -Params @{ gui = 'inventory'; confirm = $true } -Label 'w7-open-inventory' -Sync -Tier 'scene'
            Add-Check (New-CpCheck 'O.gui-open' $(if ($guiOpen.exitCode -eq 0) { 'pass' } else { 'fail' }) "player.gui inventory 退出码 $($guiOpen.exitCode)（GUI 实拍要有可画的界面）")

            if ("$($w7a.status)" -eq 'pass') {
                $w7b = Invoke-Cp -Action 'shot.multi' -Params @{ cameras = $shotCameras; gui = 'screen'; confirm = $true } -Label 'w7b-shot-gui' -Sync -Tier 'forensic' -TimeoutMs $ActionTimeoutMs
                Add-Check (Test-InputW7GuiCapturePositive -Trial $w7b)
            } else {
                Add-Check (New-CpFail 'W7b' "无法按自描述调用 gui:screen（shot.multi 的自描述未声明 gui 参数）⇒ 无先验知识调用方开不了 GUI 实拍")
                # 补充探针（**不作判据**）：用 --allow-unknown-params 直传 gui，如实记录底层实现到底能不能画
                $probe = Invoke-Cp -Action 'shot.multi' -Params @{ cameras = $shotCameras; gui = 'screen'; confirm = $true } -Label 'w7b-probe-allow-unknown' -Sync -Tier 'forensic' -AllowUnknownParams -TimeoutMs $ActionTimeoutMs
                $pc = @(Get-CpShotCameras $probe)
                $pcDesc = if ($pc.Count -gt 0) { "guiHidden=$(Format-CpValue (Get-CpProp $pc[0] 'guiHidden')) guiCapture=$(@(Get-CpProp $pc[0] 'guiCapture').Count) 项 drawn=$(Format-CpValue (Get-CpProp (@(Get-CpProp $pc[0] 'guiCapture'))[0] 'drawn'))" } else { '取不到机位读数' }
                Add-ProbeNote ("--allow-unknown-params 直传 gui:screen 的底层实测（exit=$($probe.exitCode)）: $pcDesc")
            }

            $w7c = Invoke-Cp -Action 'shot.multi' -Params @{ cameras = $shotCameras; confirm = $true } -Label 'w7c-shot-default' -Sync -Tier 'forensic' -TimeoutMs $ActionTimeoutMs
            Add-Check (Test-InputW7DefaultPathUnchanged -Trial $w7c)
            $guiClose = Invoke-Cp -Action 'player.gui' -Params @{ gui = 'close'; confirm = $true } -Label 'w7-close-inventory' -Sync -Tier 'scene'
            Add-Note "player.gui close 退出码 $($guiClose.exitCode)（卫生步骤，不作判据）"

            # ---- W8：physical.concurrent 真值（键盘侧布尔；鼠标侧 unobservable）
            $w8a = Invoke-Cp -Action 'input.key' -Params @{ key = 'key.forward'; action = 'down'; confirm = $true } -Label 'w8-down-forward' -Sync -Tier 'scene'
            $w8b = Invoke-Cp -Action 'input.key' -Params @{ key = 'key.jump'; action = 'down'; confirm = $true } -Label 'w8-down-jump' -Sync -Tier 'scene'
            $w8c = Invoke-Cp -Action 'input.mouse' -Params @{ op = 'wheel'; amount = 1; confirm = $true } -Label 'w8-wheel' -Sync -Tier 'scene'
            Add-Check (Test-InputW8PhysicalConcurrent -KeyboardTrial $w8b -MouseTrial $w8c)
            $w8rel = Invoke-Cp -Action 'input.release' -Params @{ confirm = $true } -Label 'w8-release' -Sync -Tier 'scene'
            Add-Note "W8 收尾 release: exit=$($w8rel.exitCode) count=$([string](Get-CpProp (Get-CpTrialResult $w8rel) 'count'))（卫生步骤，不作判据）"

            # ---- M12 的第二份快照（世界段之后）：操作者若改了窗口，本判据转绿
            $m12Second = Invoke-Cp -Action 'input.state' -Params @{} -Label 'm12-state-second' -Sync -Tier 'observe'
            if ($null -ne $script:m12First) {
                # 用世界段之后这一份替换 M12 的 skipped 结论（同一判据只保留一条）
                $m12check = Test-InputM12ScaleContext -First $script:m12First -Second $m12Second
                $kept = @($script:checks | Where-Object { $_.id -ne 'M12' })
                $script:checks.Clear()
                foreach ($k in $kept) { [void]$script:checks.Add($k) }
                Add-Check $m12check
            }
            continue
        }

        # ================================================================== g1
        if ($st -eq 'g1') {
            $val = Invoke-Cp -Action 'case.validate' -Params @{ file = $casePath } -Label 'g1-validate' -Sync -Tier 'observe' -TimeoutMs 60000
            if ($val.exitCode -eq 0) {
                Add-Check (New-CpCheck 'O.g1-validate' 'pass' "case.validate 通过（用例 $casePath）")
            } else {
                Add-Check (New-CpCheck 'O.g1-validate' 'fail' ("case.validate 退出码 $($val.exitCode) code=$((Get-CpTrialErrorCode $val)) msg=$(Format-CpValue (Get-CpProp (Get-CpTrialError $val) 'message'))"))
            }
            $run = Invoke-Cp -Action 'case.run' -Params @{ file = $casePath; segments = @('world', 'action'); confirm = $true } -Label 'g1-run' -Sync -Tier 'scene' -TimeoutMs $ActionTimeoutMs
            $held = Invoke-Cp -Action 'input.state' -Params @{} -Label 'g1-state-after' -Sync -Tier 'observe'

            # 从 case.run 新建的 run 目录里读 action 段步骤产物（纯数据交给判定模块）
            $stepArtifacts = New-Object System.Collections.ArrayList
            foreach ($d in @($run.newRuns | ForEach-Object { Join-Path $runsDir $_ })) {
                $actDir = Join-Path $d 'action'
                if (-not (Test-Path $actDir)) { continue }
                foreach ($f in @(Get-ChildItem -File $actDir -Filter '*.json' -ErrorAction SilentlyContinue | Sort-Object Name)) {
                    $doc = Read-JsonFile $f.FullName
                    if ($null -eq $doc) { continue }
                    $doc | Add-Member -NotePropertyName '__artifact' -NotePropertyValue ("action/" + $f.Name) -Force
                    [void]$stepArtifacts.Add($doc)
                }
            }
            Add-Check (Test-InputG1CaseRun -ValidationTrial $val -RunTrial $run -HeldAfter $held -StepArtifacts $stepArtifacts -CasePath $casePath)
            continue
        }
    }

    $counts = Get-CheckCounts
    if ($counts.fail -gt 0 -or $counts.skipped -gt 0 -or $counts.blocked -gt 0) { $script:exitCode = 2 } else { $script:exitCode = 0 }
} catch {
    $msg = "$_"
    Write-Err2 "编排中断: $msg"
    $code = if ($script:fatalCode -gt 0) { $script:fatalCode } else { 4 }
    Add-Check (New-CpCheck 'O.orchestration' 'fail' $msg)
    $script:exitCode = $code
} finally {
    # -----------------------------------------------------------------------
    # 收尾：停客户端 → 还原配置 → 归档 → 红绿表
    # -----------------------------------------------------------------------
    Write-Step '收尾'
    if ($null -ne $script:clientProc) {
        if ($KeepClient) {
            Write-Warn2 "-KeepClient：客户端 pid=$($script:clientProc.Id) 保持运行（人工收工后请自行结束）"
        } else {
            try { if ($script:clientProc.HasExited) { Write-Ok "客户端已自行退出（exitCode=$($script:clientProc.ExitCode)）" } } catch { }
            try {
                if (-not $script:clientProc.HasExited) {
                    Write-Step "停止客户端（taskkill /PID $($script:clientProc.Id) /T /F）"
                    & taskkill.exe /PID $script:clientProc.Id /T /F 2>&1 | ForEach-Object { Write-Dim "$_" }
                    $script:clientProc.WaitForExit(60000) | Out-Null
                    Write-Ok '客户端进程树已结束'
                }
            } catch { Write-Warn2 "停客户端失败: $($_.Exception.Message)" }
        }
    } elseif ($SkipClientStart) {
        Write-Warn2 '-SkipClientStart：不接管客户端进程（由调度者收工）'
    }

    Start-Sleep -Seconds 2
    Restore-LightningCfg

    Write-Step "归档到 $archiveDir"
    try {
        New-Item -ItemType Directory -Force -Path $runsArchive | Out-Null
        foreach ($d in $script:createdRuns) {
            if (Test-Path $d) {
                Copy-Item -Recurse -Force $d (Join-Path $runsArchive (Split-Path $d -Leaf))
                Write-Ok "run 归档: $(Split-Path $d -Leaf)"
            }
        }
        if ($script:createdRuns.Count -eq 0 -and (Test-Path $runsDir)) {
            Copy-Item -Recurse -Force $runsDir (Join-Path $archiveDir 'runs-all')
            Write-Warn2 '未能定位单个 run 目录，已整目录复制 runs/ → runs-all/'
        }
        if (Test-Path $eventsFile) { Copy-Item -Force $eventsFile (Join-Path $archiveDir 'events.jsonl'); Write-Ok 'events.jsonl 已归档' }
        else { Write-Warn2 "找不到 events.jsonl（$eventsFile）" }
        if (Test-Path $clientLog) { Copy-Item -Force $clientLog (Join-Path $logDir 'fml-client-latest.log'); Write-Ok '客户端日志已归档' }
        if (Test-Path $cfgPath) { Copy-Item -Force $cfgPath (Join-Path $archiveDir 'lightning.cfg.after') }
        if (Test-Path $optionsPath) { Copy-Item -Force $optionsPath (Join-Path $archiveDir 'options.txt.after') }
    } catch { Write-Warn2 "归档失败: $($_.Exception.Message)" }

    $counts = Get-CheckCounts
    $fatalText = if ($script:fatalCode -gt 0) { "管线致命码 $($script:fatalCode)" } else { '无' }

    # summary.md（人读：红绿表 + 每条的 detail 量 + 已知留白）
    $md = New-Object System.Text.StringBuilder
    [void]$md.AppendLine("# 输入手段族实机验收（input.*）$ts")
    [void]$md.AppendLine('')
    [void]$md.AppendLine("- 分支/提交: $(git -C $repoRoot rev-parse --abbrev-ref HEAD 2>$null) @ $(git -C $repoRoot log --oneline -1 2>$null)")
    [void]$md.AppendLine("- mcDataDir: ``$mcDataDir``")
    [void]$md.AppendLine("- 控制面: port=$([string](Get-CpProp $script:serverInfo 'port')) contractVersion=$([string](Get-CpProp $script:serverInfo 'contractVersion'))")
    [void]$md.AppendLine("- stage: -Stage $Stage；实跑: $($script:stageLog -join ' → ')")
    [void]$md.AppendLine("- 参数: PumpProofTicks=$PumpProofTicks ActionTimeoutMs=$ActionTimeoutMs ClientTimeoutMin=$ClientTimeoutMin SkipClientStart=$([bool]$SkipClientStart) KeepClient=$([bool]$KeepClient)")
    [void]$md.AppendLine("- 用例文件（G1）: ``$casePath``")
    [void]$md.AppendLine("- 位置字段探测: read.player 的坐标指针 = $script:playerPosPointer")
    [void]$md.AppendLine("- 管线致命: $fatalText")
    [void]$md.AppendLine('')
    [void]$md.AppendLine("## 统计")
    [void]$md.AppendLine('')
    [void]$md.AppendLine("| 结论 | 条数 |")
    [void]$md.AppendLine("|---|---|")
    [void]$md.AppendLine("| pass | $($counts.pass) |")
    [void]$md.AppendLine("| fail | $($counts.fail) |")
    [void]$md.AppendLine("| skipped（不算 pass） | $($counts.skipped) |")
    [void]$md.AppendLine("| blocked（不算 pass） | $($counts.blocked) |")
    [void]$md.AppendLine('')
    [void]$md.AppendLine("## 红绿表")
    [void]$md.AppendLine('')
    [void]$md.AppendLine("| 判据 | 结果 | detail（含可复核量） |")
    [void]$md.AppendLine("|---|---|---|")
    foreach ($c in $script:checks) {
        $mark = switch ("$($c.status)") { 'pass' { 'PASS' } 'fail' { 'FAIL' } 'skipped' { 'SKIP' } 'blocked' { 'BLOCK' } default { 'FAIL' } }
        [void]$md.AppendLine(("| {0} | {1} | {2} |" -f $c.id, $mark, (([string]$c.detail) -replace '\|', '\|')))
    }
    [void]$md.AppendLine('')
    [void]$md.AppendLine("## 已知留白 / 说明")
    [void]$md.AppendLine('')
    foreach ($n in $script:notes) { [void]$md.AppendLine("- $n") }
    foreach ($p in $script:probeNotes) { [void]$md.AppendLine("- 探针（**不作判据**）: $p") }
    [void]$md.AppendLine('- M12 需要人工改窗口尺寸才能测；会话内无法改 ⇒ 记 skipped-with-reason（不计 pass、退出码非全绿）。')
    [void]$md.AppendLine('- 未跑的 stage 的判据**不出现在本表**（不是 skip、也不是 pass）；表里只有实跑过的判据。')
    [void]$md.AppendLine('- O.* 是驱动自加的编排守卫（不是 Lead 的验收判据），只为把「编排失败」与「判据红」分开。')
    if ($counts.skipped -gt 0 -or $counts.blocked -gt 0) {
        [void]$md.AppendLine("- 本轮的 skipped=$($counts.skipped) blocked=$($counts.blocked)：都属于「非全绿」，退出码按 2 计。")
    }
    [void]$md.AppendLine('')
    [void]$md.AppendLine("通过（pass）$($counts.pass) / 红 $($counts.fail) / 跳过 $($counts.skipped) / 阻塞 $($counts.blocked)")
    [void](Set-Content -Path (Join-Path $archiveDir 'summary.md') -Value $md.ToString() -Encoding utf8NoBOM)

    $assertionsDoc = [pscustomobject]@{
        ts              = $ts
        stage           = $Stage
        stagesRun       = @($script:stageLog)
        mcDataDir       = $mcDataDir
        caseFile        = $casePath
        port            = Get-CpProp $script:serverInfo 'port'
        contractVersion = Get-CpProp $script:serverInfo 'contractVersion'
        pumpProofTicks  = $PumpProofTicks
        playerPosPointer = $script:playerPosPointer
        counts          = $counts
        fatalCode       = $script:fatalCode
        checks          = @($script:checks)
        notes           = @($script:notes)
        probeNotes      = @($script:probeNotes)
    }
    [void](ConvertTo-Json -InputObject $assertionsDoc -Depth 10 | Set-Content -Path (Join-Path $archiveDir 'assertions.json') -Encoding utf8NoBOM)

    Write-Host ''
    Write-Host ("== 结果：pass {0} / fail {1} / skipped {2} / blocked {3} ==" -f $counts.pass, $counts.fail, $counts.skipped, $counts.blocked) `
        -ForegroundColor $(if ($counts.fail -eq 0 -and $counts.skipped -eq 0 -and $counts.blocked -eq 0) { 'Green' } else { 'Red' })
    Write-Host "证据目录：$archiveDir"
}

exit $script:exitCode

