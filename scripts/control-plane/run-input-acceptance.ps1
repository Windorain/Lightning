#!/usr/bin/env pwsh
<#
.SYNOPSIS
  输入手段族（input.*）实机验收驱动：把验收判据（P0..P3 / M1..M12 / W1..W8 / G1）做成
  表驱动、可单条重跑、红绿可机读的一次跑完。

.DESCRIPTION
  一切动作调用**只**经 scripts/control-plane/caller.mjs（自描述驱动，无先验知识调用方）；
  判定逻辑**只**在 scripts/control-plane/input-acceptance-checks.ps1（纯函数，可离线自检）；
  本文件只做编排：写 cfg → 钉 pauseOnLostFocus → 起客户端 → 等 server.json → 按 stage 调 caller
  → 归档 → 打印红绿表 → 给退出码。

  为什么先钉再起（无人值守窗口必须保证客户端持续 tick）：
    无人值守的客户端从不获得焦点 ⇒ MC 自动弹暂停菜单 ⇒ 不 tick ⇒ 自动化产物永不落盘。
    治本 = **点火前**把 run 目录 options.txt 的 pauseOnLostFocus 钉为 false（MC 只在启动时读它）。
    本驱动按既有纪律调 drive-session.ps1 -PinOnly 完成钉选项，并把 P0 判据钉在 options.txt 的实读上。

  stage 语义（-Stage）：
    pre   —— 前置（P0..P3）。任一红 ⇒ 立即退出 2 且不进后续 stage。除 -Stage pre 外，其余 stage 都会**先跑 pre**。
    menu  —— 主菜单（无世界）：M1..M12。不做任何世界断言。
    world —— 真实世界（world.rebuild 建托管世界 cp_input_live，void:true）：W1..W8。
    g1    —— cases/input-multitick.json 的 action 段（G1 已实现：action 步顶层 holdTicks 合法；仅当 case.validate 以结构化字段证据证明该能力缺失时才判 blocked-by-G1）。
             G1 的能力缺失**只**由 case.validate 的结构化字段证据认定：exit≠0、code=CP-VALID-002、
             context.fields 非空且每一条都是 action[<数字>].holdTicks 的「未知字段」原因，
             才输出 blocked-by-G1（**不是** pass，也不是实现缺陷）。「不适用/语义拒绝」、混合字段、
             fields 缺席或指向别字段、错误码不符、只有 message 提 holdTicks、只有 case.run 报
             未知字段、执行期任何失败，一律 fail（不许用 blocked 掩盖第二处错误）。
    extra —— 三条残余判据（E1 组合键 / E2 队列满 / E3 产物哈希）：
              pre → 托管世界重建（**复用 world 段的同一实现**，不另起一套）→ E1 → E2 → E3。
              可用 -Only E1|E2|E3 单条重跑（只对 -Stage extra 有效）。用法见 README §1 的 run-input-acceptance.ps1 条目。
    all   —— pre → menu → world → g1（默认；**不含 extra**，保持既有行为逐条不变）。

  判定口径的三条硬纪律（按既定验收口径，不放宽）：
    ① 负对照必须真变红：M7/M8/M9/M10 要求「非 0 退出 **且** 错误码命中」；
    ② 跳过不算 pass：M12 在会话内无法改变窗口尺寸时记 skipped-with-reason，计入 summary 的 skipped
       并让退出码非全绿；
    ③ G1 未实现记 blocked（blocked-by-G1），同样非全绿；该结论只认 case.validate 的逐字段
       结构化证据（CP-VALID-002 且 fields 全部为 action[<数字>].holdTicks 的未知字段），
       执行期失败从不参与。extra 段的 E2 同理：单作业内构造不出
       「队列满」触发条件时记 blocked-with-reason（**不许**改判成 pass、也不许降级成别的断言）。

  退出码：0 全绿；2 有断言红（含 skipped / blocked）；3 管线级致命（server.json 超时 / 客户端早退）；
          4 前置检查或编排自身失败。

.EXAMPLE
  # 客户端已按窗口纪律获批在跑（复用，不启停）
  pwsh -File scripts/control-plane/run-input-acceptance.ps1 -SkipClientStart -Port 23314

.EXAMPLE
  # 只重跑世界段（自己起停客户端）
  pwsh -File scripts/control-plane/run-input-acceptance.ps1 -Stage world -Port 23314

.EXAMPLE
  # 只跑 extra 段（E1/E2/E3；先跑 pre，再重建托管世界）
  pwsh -File scripts/control-plane/run-input-acceptance.ps1 -Stage extra -Port 23314

.EXAMPLE
  # 单条重跑（只跑 E2；pre 与世界准备仍会先跑）
  pwsh -File scripts/control-plane/run-input-acceptance.ps1 -Stage extra -Only E2 -Port 23314

.NOTES
  runClient 是独占资源（Gradle 锁 + 端口 + 世界存档）：用前必须先申请独占窗口，
  一次只跑一个。本脚本默认 **不** 复用已在跑的客户端；复用请显式给 -SkipClientStart。
#>
[CmdletBinding()]
param(
    # mcDataDir（默认 <repo>\mod\gtnh\run\client）
    [string]$McDataDir = '',
    # 复用已在跑的客户端：不写 cfg、不写 options.txt、不起进程、不停进程（本路径不点火）
    [switch]$SkipClientStart,
    # 跑完不停客户端（保留现场）
    [switch]$KeepClient,
    # 控制面预期端口（**仅用于前置占用检查**；调用一律以 server.json 的 port 为准）
    [int]$Port = 23314,
    # 等待 server.json / tokens.json 的上限（分钟）
    [int]$ClientReadyTimeoutMin = 8,
    # 只跑哪个 stage（all|pre|menu|world|g1|extra）
    [ValidateSet('all', 'pre', 'menu', 'world', 'g1', 'extra')]
    [string]$Stage = 'all',
    # extra 段里只跑哪几条判据（空 = E1/E2/E3 全跑）；只对 -Stage extra 有效
    [ValidateSet('E1', 'E2', 'E3')]
    [string[]]$Only = @(),
    # E1 的两个测量窗口各持续多少 tick（对照与潜行各一段；每 tick 位移按窗口内的 tick 增量折算）
    [int]$E1HoldTicks = 60,
    # E1 相位间静置 tick 数：虚空 + 创造飞行，松开键后仍会滑行；不静置会把上一段的余速算进下一段
    [int]$E1SettleTicks = 30,
    # E2 的填充步数（必须 ≫ 键盘队列容量 256，才谈得上「远超容量」）
    [int]$E2FillSteps = 300,
    # E2 投递前静置 tick 数：让 E1 留下的飞行余速衰减掉，否则「零写入」会被余速撞红
    [int]$E2SettleTicks = 40,
    # 归档根（缺省 = 本脚本目录下被 .gitignore 忽略的 .out；显式给参数则以参数为准）
    [string]$ArchiveRoot = '',
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
# 归档默认落本脚本目录下被 .gitignore 忽略的 .out（不写死任何机器路径；显式 -ArchiveRoot 优先）
if ([string]::IsNullOrWhiteSpace($ArchiveRoot)) { $ArchiveRoot = Join-Path $scriptDir '.out' }
$pinPreflightPath = Join-Path $scriptDir 'pin-preflight.ps1'
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
# 托管世界重建：world 段与 extra 段**共用同一实现**（不另起一套）
#   参数逐字保持 world 段既有取值（folder/seed/void/base/settleTicks），label 也保持
#   'world-rebuild' ⇒ world 段的调用形状与证据命名一个字节都没变。
# ---------------------------------------------------------------------------
function Invoke-ManagedWorldRebuild {
    $rebuildParams = @{
        folder = 'cp_input_live'; seed = 20261008; void = $true
        base = @(64, 12, 64); settleTicks = 60; confirm = $true
    }
    return (Invoke-Cp -Action 'world.rebuild' -Params $rebuildParams -Label 'world-rebuild' -Sync -Tier 'scene' -TimeoutMs $ActionTimeoutMs)
}

# 编排守卫 O.rebuild（驱动自加，不是验收判据）
function Add-ManagedWorldRebuildCheck {
    param($Trial)
    Add-Check (New-CpCheck 'O.rebuild' $(if ($Trial.exitCode -eq 0) { 'pass' } else { 'fail' }) "world.rebuild(cp_input_live, void) 退出码 $($Trial.exitCode)")
}

# ---------------------------------------------------------------------------
# E3 用的只读 HTTP 直连（**只有产物清单与产物下载**走这里）
#   为什么可以不走 caller.mjs：caller.mjs 是**动作**调用方（POST /cp/v1/actions/{name}，
#   按自描述构造请求体），而产物清单/下载是 GET 只读端点、没有自描述可依
#   （CoreEndpoints.java:166/173 注册；tier=OBSERVE）。发现顺序与 caller.mjs 同源：
#   先读 server.json 拿 port，再读 tokens.json 拿 observe token，**不猜端口**。
# ---------------------------------------------------------------------------
function Get-CpHttpContext {
    $info = Read-JsonFile $serverJsonPath
    $tokens = Read-JsonFile $tokensJsonPath
    if ($null -eq $info -or $null -eq $tokens) { return $null }
    $port = Get-CpProp $info 'port'
    $tok = Get-CpProp (Get-CpProp $tokens 'tokens') 'observe'
    if ($null -eq $port -or [string]::IsNullOrWhiteSpace([string]$tok)) { return $null }
    return [pscustomobject]@{
        base    = ("http://127.0.0.1:{0}/cp/v1" -f $port)
        headers = @{ Authorization = "Bearer $tok" }
    }
}

# GET /cp/v1/artifacts/{runId} → data（清单原文同时落归档）；失败返回 $null 并落错误文本
function Get-CpArtifactManifest {
    param([string]$RunId, [string]$OutDir)
    $ctx = Get-CpHttpContext
    if ($null -eq $ctx) { return $null }
    try {
        $resp = Invoke-RestMethod -Uri "$($ctx.base)/artifacts/$RunId" -Headers $ctx.headers -Method Get -TimeoutSec 60
        $data = if (Test-CpHasProp $resp 'data') { Get-CpProp $resp 'data' } else { $resp }
        try { ($data | ConvertTo-Json -Depth 14) | Set-Content -Path (Join-Path $OutDir 'e3-manifest.json') -Encoding utf8NoBOM } catch { }
        return $data
    } catch {
        try { Set-Content -Path (Join-Path $OutDir 'e3-manifest.error.txt') -Value "$_" -Encoding utf8NoBOM } catch { }
        return $null
    }
}

# GET /cp/v1/artifacts/{runId}/{path} → 下载字节 + 复算 sha256（返回记录，不做判定）
function Get-CpArtifactBytes {
    param([string]$RunId, [string]$RelPath, [string]$DestDir)
    $ctx = Get-CpHttpContext
    $dest = Join-Path $DestDir ($RelPath -replace '[\\/]', '__')
    $ok = $false
    $err = ''
    if ($null -ne $ctx) {
        try {
            Invoke-WebRequest -Uri "$($ctx.base)/artifacts/$RunId/$RelPath" -Headers $ctx.headers -OutFile $dest -TimeoutSec 180 | Out-Null
            $ok = $true
        } catch { $err = "$_" }
    } else {
        $err = 'HTTP 上下文不可用（server.json/tokens.json 读不到）'
    }
    $sha = ''
    $bytes = 0
    if ($ok -and (Test-Path $dest)) {
        $sha = (Get-FileHash -Algorithm SHA256 -Path $dest).Hash.ToLowerInvariant()
        $bytes = (Get-Item $dest).Length
    }
    return [pscustomobject]@{ path = $RelPath; dest = $dest; downloadOk = $ok; actualSha256 = $sha; actualBytes = $bytes; error = $err }
}

# E2 的填充用例：**现场生成在归档目录**（300 步不进仓；避免仓里出现巨型用例）
#   填充键位选**未绑定**的 LWJGL 键码（依据：input.state.keyCatalog 是运行期键位注册表的实读，
#   不在其中的键码没有任何 KeyBinding 绑到它 ⇒ 事件即使被消费也不产生世界写入）。
#   动作用 action:"up"：抬起一个没按下的键是**无害**的（wasHeld=false），且仍是「写进队列的一条事件」
#   ⇒ 「已入队事件即使被消费也不产生世界写入」这一前提可辩护。
function New-E2FillCaseFile {
    param([string]$Path, [int]$KeyCode, [int]$Steps)
    # 注意：PowerShell 变量名大小写不敏感 ⇒ 局部名不能叫 $steps（会与 [int]$Steps 同名冲突）
    $stepList = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $Steps; $i++) {
        [void]$stepList.Add([ordered]@{
                action = 'input.key'
                params = [ordered]@{ key = $KeyCode; action = 'up' }
                path   = ("action/{0:d4}-up-unbound.json" -f $i)
                role   = 'e2-filler'
                expect = [ordered]@{ '/delivered' = 1 }
            })
    }
    # 【首轮实机教训】`lightning.case/1` 的 **`world` / `criteria` / `evidence` 是必填**：
    # 首轮生成的用例只带 schema/id/label/action，`case.validate` 当场 `CP-VALID-002`
    # （「world 必填且须为 object；criteria 必填；evidence 必填」）⇒ E2 走进「构造失败」的 blocked，
    # 一条判据都没取到。三个字段在此补齐；`world` 用与 extra/world 段同一份托管世界参数
    # （本探针只跑 action 段，`world` 只是元数据，不会被重建）。
    $doc = [ordered]@{
        schema   = 'lightning.case/1'
        id       = 'input-queue-fill-extra'
        label    = ("E2 队列填充探针：单个 case.run 作业内压入 {0} 条键事件（未绑定键码 {1}，全部 action=up ⇒ 功能惰性）" -f $Steps, $KeyCode)
        world    = [ordered]@{
            folder      = 'cp_input_live'
            seed        = 20261008
            void        = $true
            base        = @(64, 12, 64)
            settleTicks = 60
        }
        action   = @($stepList)
        criteria = @(
            [ordered]@{
                id     = 'e2-filler-artifact-present'
                type   = 'artifact-nonempty'
                params = [ordered]@{ path = ("action/{0:d4}-up-unbound.json" -f 0) }
            }
        )
        evidence = [ordered]@{
            expect = @([ordered]@{ path = ("action/{0:d4}-up-unbound.json" -f 0); role = 'e2-filler' })
        }
    }
    $parent = Split-Path $Path -Parent
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    ($doc | ConvertTo-Json -Depth 8) | Set-Content -Path $Path -Encoding utf8NoBOM
    return $Path
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

if ($Only.Count -gt 0 -and $Stage -ne 'extra') {
    Write-Err2 "-Only 只对 -Stage extra 有效（当前 -Stage $Stage；-Only = $($Only -join ','))"; exit 4
}

if (-not $SkipClientStart) {
    if (-not (Test-Path $webNodeModules)) {
        Write-Err2 "找不到 $webNodeModules —— runClient 依赖 syncWeb→vite，请先执行: cd web; pnpm install --frozen-lockfile"
        exit 4
    }
    if (-not (Test-Path $pinPreflightPath)) { Write-Err2 "找不到 $pinPreflightPath（点火前置 helper）"; exit 4 }
    . $pinPreflightPath
    $portBusy = Test-PortListening $Port
    if ($portBusy) { Write-Err2 "端口 $Port 已被占用（runClient 是独占资源：先确认没有别的客户端在跑）"; exit 4 }
    Write-Ok "端口 $Port 空闲（仅前置占用检查；实调一律以 server.json 为准）"
} else {
    Write-Warn2 '-SkipClientStart：不写 cfg、不写 options.txt、不起进程、不停进程（本路径不点火）'
}

# ---------------------------------------------------------------------------
# 写 cfg + 起客户端
# ---------------------------------------------------------------------------
try {
    if (-not $SkipClientStart) {
        # 钉 pauseOnLostFocus=false（**必须先钉再起**：MC 只在启动时读 options.txt）
        Write-Step '钉 pauseOnLostFocus=false（点火前置；唯一写选项实现 = drive-session.ps1 -PinOnly）'
        try {
            $pinEvidence = Invoke-PauseOnLostFocusPreflight -RunDir $mcDataDir -Tag 'input'
        } catch {
            Fail-Fatal "点火前置失败：pauseOnLostFocus 未钉住，禁止启动客户端。$($_.Exception.Message)" 4
        }
        Write-Ok $pinEvidence.EvidenceLine

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
    if ($boundPort -ne $Port) { Write-Warn2 "实际绑定端口 $boundPort 与预期 $Port 不同（契约 §1 第 4 条允许回退）；后续调用一律以 server.json 为准" }

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
            $rb = Invoke-ManagedWorldRebuild
            Add-ManagedWorldRebuildCheck $rb

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
                Add-Check (New-CpCheck 'O.g1-validate' 'fail' ("case.validate 失败（逐字段原文见下）: " + (Format-CpTrialFailure $val)))
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

        # =============================================================== extra
        if ($st -eq 'extra') {
            $runE1 = ($Only.Count -eq 0) -or ($Only -contains 'E1')
            $runE2 = ($Only.Count -eq 0) -or ($Only -contains 'E2')
            $runE3 = ($Only.Count -eq 0) -or ($Only -contains 'E3')
            Add-Note ("extra 段的 -Only = " + $(if ($Only.Count -eq 0) { '(空 ⇒ E1/E2/E3 全跑)' } else { ($Only -join ',') }) + "；本轮实跑 = " + (@(@('E1', 'E2', 'E3') | Where-Object { ($Only.Count -eq 0) -or ($Only -contains $_) }) -join ','))

            # ---- 世界准备：复用 world 段的托管世界重建流程（同一函数、同一参数、同一 label）
            Write-Step 'extra 世界准备（复用 world 段的 world.rebuild 流程）'
            $rb = Invoke-ManagedWorldRebuild
            Add-ManagedWorldRebuildCheck $rb
            $exStatus = Invoke-Cp -Action 'core.status' -Params @{} -Label 'extra-w1-status' -Sync -Tier 'observe'
            Add-Check (Test-InputW1WorldManaged -Trial $exStatus)

            # ============================================================= E1
            if ($runE1) {
                Write-Step ("E1：组合键（潜行修饰）被世界链按序消费；每段窗口 {0} tick、段间静置 {1} tick" -f $E1HoldTicks, $E1SettleTicks)
                # 卫生：先清掉可能的残留持键（幂等），再静置——虚空 + 创造飞行，松开后仍会滑行
                $e1Rel0 = Invoke-Cp -Action 'input.release' -Params @{ confirm = $true } -Label 'e1-hygiene-release' -Sync -Tier 'scene'
                $e1SettleA = Wait-ClientTicks -TargetTicks $E1SettleTicks -RoundSec 6 -ReadPlayerOnly -BudgetSeconds (Get-WaitBudget $E1SettleTicks)
                Add-Note ("E1 前置：input.release 退出码 $($e1Rel0.exitCode)（卫生步骤，不作判据）；静置 {0} tick 实测增量={1}" -f $E1SettleTicks, $e1SettleA.tickDelta)

                # ---- 对照相位：只按 key.forward（这就是任务书要求的负对照形态）
                $e1PlainDown = Invoke-Cp -Action 'input.key' -Params @{ key = 'key.forward'; action = 'down'; confirm = $true } -Label 'e1-plain-down' -Sync -Tier 'scene'
                $e1TickPlain0 = Get-ClientTick
                $e1PlainA = Get-PlayerPos (Invoke-Cp -Action 'read.player' -Params @{} -Label 'e1-plain-pos-a' -Sync -Tier 'observe')
                $e1WaitPlain = Wait-ClientTicks -TargetTicks $E1HoldTicks -RoundSec 8 -ReadPlayerOnly -BudgetSeconds (Get-WaitBudget $E1HoldTicks)
                $e1PlainB = Get-PlayerPos (Invoke-Cp -Action 'read.player' -Params @{} -Label 'e1-plain-pos-b' -Sync -Tier 'observe')
                $e1TickPlain1 = Get-ClientTick
                $e1PlainRelease = Invoke-Cp -Action 'input.release' -Params @{ confirm = $true } -Label 'e1-plain-release' -Sync -Tier 'scene'
                $e1PlainTicks = if ($null -ne $e1TickPlain0 -and $null -ne $e1TickPlain1) { [int]([long]$e1TickPlain1 - [long]$e1TickPlain0) } else { 0 }

                # ---- 段间静置：让对照相位的余速衰减（否则会被算进潜行相位）
                $e1SettleB = Wait-ClientTicks -TargetTicks $E1SettleTicks -RoundSec 6 -ReadPlayerOnly -BudgetSeconds (Get-WaitBudget $E1SettleTicks)

                # ---- 潜行相位：key.sneak down → key.forward down（顺序即任务书要求的事件序）
                $e1SneakDown = Invoke-Cp -Action 'input.key' -Params @{ key = 'key.sneak'; action = 'down'; confirm = $true } -Label 'e1-sneak-down' -Sync -Tier 'scene'
                $e1FwdDown = Invoke-Cp -Action 'input.key' -Params @{ key = 'key.forward'; action = 'down'; confirm = $true } -Label 'e1-sneak-forward-down' -Sync -Tier 'scene'
                $e1TickSneak0 = Get-ClientTick
                $e1SneakA = Get-PlayerPos (Invoke-Cp -Action 'read.player' -Params @{} -Label 'e1-sneak-pos-a' -Sync -Tier 'observe')
                # 保持期间的 input.state：取 held[].gameBindingPressed 的**回读值**（不是推测）
                $e1HoldState = Invoke-Cp -Action 'input.state' -Params @{} -Label 'e1-hold-state' -Sync -Tier 'observe'
                $e1WaitSneak = Wait-ClientTicks -TargetTicks $E1HoldTicks -RoundSec 8 -ReadPlayerOnly -BudgetSeconds (Get-WaitBudget $E1HoldTicks)
                $e1SneakB = Get-PlayerPos (Invoke-Cp -Action 'read.player' -Params @{} -Label 'e1-sneak-pos-b' -Sync -Tier 'observe')
                $e1TickSneak1 = Get-ClientTick
                $e1HoldStateEnd = Invoke-Cp -Action 'input.state' -Params @{} -Label 'e1-hold-state-end' -Sync -Tier 'observe'
                $e1SneakTicks = if ($null -ne $e1TickSneak0 -and $null -ne $e1TickSneak1) { [int]([long]$e1TickSneak1 - [long]$e1TickSneak0) } else { 0 }

                # ---- 收尾：两键 up + input.release 兜底（顺序与按下相反）
                $e1SneakUp = Invoke-Cp -Action 'input.key' -Params @{ key = 'key.sneak'; action = 'up'; confirm = $true } -Label 'e1-sneak-up' -Sync -Tier 'scene'
                $e1FwdUp = Invoke-Cp -Action 'input.key' -Params @{ key = 'key.forward'; action = 'up'; confirm = $true } -Label 'e1-sneak-forward-up' -Sync -Tier 'scene'
                $e1Release = Invoke-Cp -Action 'input.release' -Params @{ confirm = $true } -Label 'e1-release' -Sync -Tier 'scene'

                Add-Check (Test-InputE1SneakModifier -PlainPosA $e1PlainA -PlainPosB $e1PlainB -PlainTicks $e1PlainTicks -SneakPosA $e1SneakA -SneakPosB $e1SneakB -SneakTicks $e1SneakTicks)
                Add-Check (Test-InputE1SneakReadback -HoldTrial $e1HoldState)
                Add-ProbeNote ("E1 保持结束时的 input.state 回读（exit={0}）：{1}" -f $e1HoldStateEnd.exitCode, (Format-CpTrial $e1HoldStateEnd))
                Add-Note ("E1 调用退出码：plain down=$($e1PlainDown.exitCode) plain release=$($e1PlainRelease.exitCode) sneak down=$($e1SneakDown.exitCode) forward down=$($e1FwdDown.exitCode) sneak up=$($e1SneakUp.exitCode) forward up=$($e1FwdUp.exitCode) release=$($e1Release.exitCode)（调用形状，不作判据）")
                Add-Note ("E1 的 tick 口径：位置窗口 [读 A 前的 core.status, 读 B 后的 core.status]，对照 {0} tick（等待轮内实测 {1}）、潜行 {2} tick（等待轮内实测 {3}）——窗口含两次读数各自的 tick 开销，两侧同形，比值不受影响" -f $e1PlainTicks, $e1WaitPlain.tickDelta, $e1SneakTicks, $e1WaitSneak.tickDelta)
            }

            # ============================================================= E2
            if ($runE2) {
                Write-Step ("E2：队列满 ⇒ CP-STATE-001 且零写入；填充 {0} 步、投递前静置 {1} tick" -f $E2FillSteps, $E2SettleTicks)
                # 选一个**未绑定**的键码：input.state.keyCatalog 是运行期键位注册表的实读
                # （McInputHost.java:165-187 / InputRuntimeProbe.java:434-455），不在其取值集里的键码
                # 没有任何 KeyBinding 绑到它 ⇒ 事件即使被消费也不产生世界写入（功能惰性）。
                $e2Pick = Invoke-Cp -Action 'input.state' -Params @{} -Label 'e2-pick-keycode' -Sync -Tier 'observe'
                $e2Catalog = Get-CpProp (Get-CpTrialResult $e2Pick) 'keyCatalog'
                $e2Bound = New-Object System.Collections.ArrayList
                if ($null -ne $e2Catalog) {
                    foreach ($prop in @($e2Catalog.PSObject.Properties)) { [void]$e2Bound.Add([int]$prop.Value) }
                }
                $e2FillerCode = -1
                for ($c = 1; $c -le 254; $c++) { if (-not $e2Bound.Contains($c)) { $e2FillerCode = $c; break } }

                if ($e2Bound.Count -eq 0 -or $e2FillerCode -lt 0) {
                    # 判定仍在纯函数里：这里只把「拿不到未绑定键码」的事实交给它
                    Add-Check (Test-InputE2QueueFullSingleJob -ValidateTrial $null -RunTrial $null -BeforeState $null -AfterState $null -StepArtifacts @() -PlannedSteps $E2FillSteps -FillerTrial $e2Pick -FillerCatalog $e2Catalog -FillerCode $e2FillerCode)
                } else {
                    $e2CaseDir = Join-Path $archiveDir 'cases'
                    $e2CasePath = Join-Path $e2CaseDir 'e2-queue-fill.json'
                    [void](New-E2FillCaseFile -Path $e2CasePath -KeyCode $e2FillerCode -Steps $E2FillSteps)
                    Write-Ok ("E2 填充用例已现场生成（不入库）：{0}（{1} 步；未绑定键码 {2}；keyCatalog 已占用 {3} 个键码）" -f $e2CasePath, $E2FillSteps, $e2FillerCode, $e2Bound.Count)
                    Add-Note ("E2 的填充用例由驱动现场生成在归档目录（{0}），并作为证据一并归档；未绑定键码的判定依据：它不在 input.state.keyCatalog（运行期键位注册表实读）的取值集里" -f $e2CasePath)

                    $e2Val = Invoke-Cp -Action 'case.validate' -Params @{ file = $e2CasePath } -Label 'e2-validate' -Sync -Tier 'observe' -TimeoutMs 120000

                    # 投递前的观测：read.player + core.status（先静置，让 E1 的飞行余速衰减）
                    $e2Settle = Wait-ClientTicks -TargetTicks $E2SettleTicks -RoundSec 6 -ReadPlayerOnly -BudgetSeconds (Get-WaitBudget $E2SettleTicks)
                    $e2Before = [pscustomobject]@{
                        player = Get-CpTrialResult (Invoke-Cp -Action 'read.player' -Params @{} -Label 'e2-before-player' -Sync -Tier 'observe')
                        status = Get-CpTrialResult (Invoke-Cp -Action 'core.status' -Params @{} -Label 'e2-before-status' -Sync -Tier 'observe')
                    }
                    $e2Run = Invoke-Cp -Action 'case.run' -Params @{ file = $e2CasePath; segments = @('action'); confirm = $true } -Label 'e2-run' -Sync -Tier 'scene' -TimeoutMs $ActionTimeoutMs
                    $e2After = [pscustomobject]@{
                        player = Get-CpTrialResult (Invoke-Cp -Action 'read.player' -Params @{} -Label 'e2-after-player' -Sync -Tier 'observe')
                        status = Get-CpTrialResult (Invoke-Cp -Action 'core.status' -Params @{} -Label 'e2-after-status' -Sync -Tier 'observe')
                    }
                    # 兜底释放（本程序只投 up，理论上不产生持键）
                    $e2Release = Invoke-Cp -Action 'input.release' -Params @{ confirm = $true } -Label 'e2-release' -Sync -Tier 'scene'

                    # 收集本作业的 action 步骤产物（队列深度/投递 tick 的实测来源）
                    $e2Artifacts = New-Object System.Collections.ArrayList
                    foreach ($d in @($e2Run.newRuns | ForEach-Object { Join-Path $runsDir $_ })) {
                        $actDir = Join-Path $d 'action'
                        if (-not (Test-Path $actDir)) { continue }
                        foreach ($f in @(Get-ChildItem -File $actDir -Filter '*.json' -ErrorAction SilentlyContinue | Sort-Object Name)) {
                            $doc = Read-JsonFile $f.FullName
                            if ($null -eq $doc) { continue }
                            [void]$e2Artifacts.Add($doc)
                        }
                    }
                    Add-Note ("E2 收尾 input.release 退出码 $($e2Release.exitCode)（卫生步骤，不作判据）；静置 {0} tick 实测增量={1}；step 产物 {2} 份" -f $E2SettleTicks, $e2Settle.tickDelta, $e2Artifacts.Count)
                    Add-Check (Test-InputE2QueueFullSingleJob -ValidateTrial $e2Val -RunTrial $e2Run -BeforeState $e2Before -AfterState $e2After -StepArtifacts $e2Artifacts -PlannedSteps $E2FillSteps -FillerTrial $e2Pick -FillerCatalog $e2Catalog -FillerCode $e2FillerCode)
                }
            }

            # ============================================================= E3
            if ($runE3) {
                Write-Step 'E3：产物可从既有清单发现并复核哈希 + 界面确实进了帧（gui:screen vs 同机位 gui:none 对照）'
                $e3Cameras = @(
                    @{ name = 'e3-gui'; pos = @(64.5, 20.0, 70.5); yaw = 180.0; pitch = 45.0
                        projection = @{ type = 'perspective'; fov = 70 }; resolution = @(854, 480) }
                )
                # 开一个真界面：否则 gui:screen 只是「拍了但没有界面」的如实读数（与 W7 同一理由）
                $e3GuiOpen = Invoke-Cp -Action 'player.gui' -Params @{ gui = 'inventory'; confirm = $true } -Label 'e3-open-inventory' -Sync -Tier 'scene'
                Add-Check (New-CpCheck 'O.e3-gui-open' $(if ($e3GuiOpen.exitCode -eq 0) { 'pass' } else { 'fail' }) "player.gui inventory 退出码 $($e3GuiOpen.exitCode)（编排守卫，非验收判据：只是让 gui:screen 有界面可画）")
                $e3Shot = Invoke-Cp -Action 'shot.multi' -Params @{ cameras = $e3Cameras; gui = 'screen'; confirm = $true } -Label 'e3-shot-gui' -Sync -Tier 'forensic' -TimeoutMs $ActionTimeoutMs
                # 对照帧：同一机位、界面**仍开着**，只差 gui 参数。缺陷态下这两帧曾逐字节相同
                # ⇒「界面进了帧」这台判据是独立于 mod 自述的那一半（mod 自述由 Test-InputGuiDrawLanded 读 meta 断言）。
                $e3Control = Invoke-Cp -Action 'shot.multi' -Params @{ cameras = $e3Cameras; gui = 'none'; confirm = $true } -Label 'e3-shot-control' -Sync -Tier 'forensic' -TimeoutMs $ActionTimeoutMs
                $e3GuiClose = Invoke-Cp -Action 'player.gui' -Params @{ gui = 'close'; confirm = $true } -Label 'e3-close-inventory' -Sync -Tier 'scene'
                Add-Note "E3 卫生步骤 player.gui close 退出码 $($e3GuiClose.exitCode)（不作判据）"

                $e3OutDir = Join-Path $archiveDir 'e3'
                New-Item -ItemType Directory -Force -Path $e3OutDir, (Join-Path $e3OutDir 'downloads') | Out-Null
                $e3RunId = [string](Get-CpProp (Get-CpTrialResult $e3Shot) 'runId')
                $e3Manifest = Get-CpArtifactManifest -RunId $e3RunId -OutDir $e3OutDir
                $e3Downloads = New-Object System.Collections.ArrayList
                if ($null -ne $e3Manifest) {
                    $e3Targets = @((Get-CpArray $e3Manifest 'artifacts') | Where-Object {
                            $p = [string](Get-CpProp $_ 'path')
                            ($p -match '^shots/[^/]+\.png$') -or ($p -match '^shots/[^/]+\.meta\.json$')
                        })
                    Write-Info ("E3 清单 runId=$e3RunId：shots/*.png 与 *.meta.json 共 {0} 份待逐份复核" -f @($e3Targets).Count)
                    foreach ($art in $e3Targets) {
                        $rel = [string](Get-CpProp $art 'path')
                        $got = Get-CpArtifactBytes -RunId $e3RunId -RelPath $rel -DestDir (Join-Path $e3OutDir 'downloads')
                        [void]$e3Downloads.Add([pscustomobject]@{
                                path           = $rel
                                declaredSha256 = [string](Get-CpProp $art 'sha256')
                                declaredBytes  = Get-CpProp $art 'bytes'
                                actualSha256   = $got.actualSha256
                                actualBytes    = $got.actualBytes
                                downloadOk     = $got.downloadOk
                            })
                        if (-not $got.downloadOk) { Write-Warn2 "E3 下载失败: $rel —— $($got.error)" }
                    }
                    # 复算记录（证据）：清单原文 + 逐份比对表
                    try {
                        $e3Downloads | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $e3OutDir 'e3-sha256-report.json') -Encoding utf8NoBOM
                        $tbl = New-Object System.Collections.ArrayList
                        [void]$tbl.Add('# E3 产物哈希复核（清单声明 vs 下载字节复算）')
                        [void]$tbl.Add('')
                        [void]$tbl.Add("- runId: $e3RunId")
                        [void]$tbl.Add("- 清单: $(Join-Path $e3OutDir 'e3-manifest.json')")
                        [void]$tbl.Add('')
                        [void]$tbl.Add('| 产物 | 下载 | 复算 sha256 | 清单 sha256 | 一致 | 字节(复算/清单) |')
                        [void]$tbl.Add('|---|---|---|---|---|---|')
                        foreach ($r in $e3Downloads) {
                            $same = ($r.downloadOk -and $r.actualSha256 -and ($r.actualSha256 -eq $r.declaredSha256.ToLowerInvariant()))
                            [void]$tbl.Add(("| {0} | {1} | {2} | {3} | {4} | {5}/{6} |" -f $r.path, $r.downloadOk, $r.actualSha256, $r.declaredSha256, $same, $r.actualBytes, $r.declaredBytes))
                        }
                        [void]($tbl | Set-Content -Path (Join-Path $e3OutDir 'e3-sha256-report.md') -Encoding utf8NoBOM)
                    } catch { Write-Warn2 "E3 复核表写出失败: $($_.Exception.Message)" }
                }
                # ---- 界面到底有没有进帧（两条判据，各自独立成证）
                #   ① mod 自述侧：screen 帧 meta 的 guiCapture[].changedPixels（**同一帧内**绘制前后的改动像素数）
                #   ② 独立侧：screen 帧与同机位 gui:none 对照帧的真实像素差异（不采信任何自述字段）
                $e3DrawMeta = Read-JsonFile (Join-Path $e3OutDir 'downloads\shots__e3-gui.meta.json')
                Add-Check (Test-InputGuiDrawLanded -ScreenMeta $e3DrawMeta -RunId $e3RunId)
                $e3CtrlDir = Join-Path $e3OutDir 'control-downloads'
                New-Item -ItemType Directory -Force -Path $e3CtrlDir | Out-Null
                $e3ControlRunId = [string](Get-CpProp (Get-CpTrialResult $e3Control) 'runId')
                $e3ControlPng = Get-CpArtifactBytes -RunId $e3ControlRunId -RelPath 'shots/e3-gui.png' -DestDir $e3CtrlDir
                Add-Check (Test-InputGuiFrameContent -ScreenPng (Join-Path $e3OutDir 'downloads\shots__e3-gui.png') -ControlPng $e3ControlPng.dest -Detail "screen runId=$e3RunId / control runId=$e3ControlRunId / 机位 e3-gui（界面全程开着，只差 gui 参数）")
                Add-Note "E3 对照帧 runId=$e3ControlRunId（gui:none，界面仍开着）；界面绘制自证字段见 screen 帧 meta 的 guiCapture[].changedPixels / glStateBefore / glStateAfter"
                Add-Check (Test-InputE3ArtifactHashes -Manifest $e3Manifest -Downloads $e3Downloads -RunId $e3RunId -ShotTrial $e3Shot)
            }
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
        Write-Warn2 '-SkipClientStart：不接管客户端进程（由验收人收工）'
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
    [void]$md.AppendLine("- extra 段参数: Only=$(if ($Only.Count -eq 0) { '(空=全跑)' } else { ($Only -join ',') }) E1HoldTicks=$E1HoldTicks E1SettleTicks=$E1SettleTicks E2FillSteps=$E2FillSteps E2SettleTicks=$E2SettleTicks")
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
    [void]$md.AppendLine('- extra 段（-Stage extra）的判据口径（脚本入口见 README §1）：E1 判界 = 潜行每 tick 水平位移 < 对照的 0.6 倍（对照下界 0.02 blocks/tick，与 input-acceptance-checks.ps1 的 MinPlainPerTick 默认值同源）；E2 的填充用例由驱动现场生成在归档目录（cases/e2-queue-fill.json，不入库）；E3 用 GET /cp/v1/artifacts/{runId} 逐份复算 sha256。')
    [void]$md.AppendLine('- extra 段里的 W1 是「托管世界已就绪」的前置**复用**（判据函数与 world 段同一份），不是新增判据；O.rebuild / O.e3-gui-open 是驱动自加的编排守卫。')
    [void]$md.AppendLine('- E2 的「零写入」比对口径：逐路径叶子比对，显式排除 tick 计数/墙钟/JVM 内存/控制面自身记账/网络与状态效果时长等易变字段（排除清单与理由逐条写在 E2 的 detail 里），**不是**整体 JSON 字符串相等。')
    [void]$md.AppendLine('- 未跑的 stage 的判据**不出现在本表**（不是 skip、也不是 pass）；表里只有实跑过的判据。')
    [void]$md.AppendLine('- O.* 是驱动自加的编排守卫（不是验收判据），只为把「编排失败」与「判据红」分开。')
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

