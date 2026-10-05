<#
  PR-1 控制面冒烟驱动（无人值守）—— 契约 v1 + lightning.case/1 的端到端验收
  ============================================================================
  流程：前置检查（gradlew / web/node_modules / 端口 23057）→ 写 run/client/config/lightning.cfg
  （controlplane.enabled=true，原值备份）→ Start-Process 启动 `gradlew runClientSdePipeline --console=plain`
  （日志重定向到归档目录）→ 轮询 server.json 出现（默认 5 min）→ 依次断言：

    A1 core.ping                       存活回声（退出码 0）
    A2 core.status                     状态可读（退出码 0）
    A3 case.validate <用例>            计划的判据/变体数与用例文件一致
    A4 case.run 整跑（sync，10 min）   退出码 0 且 run 的 criteria.json 全绿、覆盖用例全部判据
    A5 case.run 按段 world+build       退出码 0
    A6 case.run 按段 criteria+evidence 退出码 0
    A7 整跑 vs 按段一致                段集合相等 / 判据结论逐条一致 / 整跑产物是两次按段的并集子集
    A8 case.run 负对照变体             退出码 0 且 expectCriteriaRed 列出的判据全红（变体红=通过）
    A9 world.rebuild 无 confirm        调用失败且错误码 CP-CONFIRM-001

  收尾：恢复 lightning.cfg、停客户端（taskkill /T /F）、把 run 目录 + events.jsonl + 日志归档到
  `<ArchiveRoot>\smoke-<ts>\`，打印归档路径与断言红绿表。

  用法：
    pwsh -File scripts/control-plane/run-smoke.ps1
    pwsh -File scripts/control-plane/run-smoke.ps1 -SkipClientStart      # 复用已在跑的客户端（不写配置、不停客户端）
    pwsh -File scripts/control-plane/run-smoke.ps1 -KeepClient           # 跑完不停客户端（留现场给人工看）
    pwsh -File scripts/control-plane/run-smoke.ps1 -CaseFile <path>      # 换用例文件

  退出码：0 = 全绿；2 = 有断言红；3 = 管线级致命（server.json 超时/客户端早退）；
          4 = 前置检查或编排自身失败。

  纪律：runClient 是独占资源（Gradle 锁 + 端口 + 世界存档），用前向 Lead 申请，一次只跑一个。
#>
[CmdletBinding()]
param(
    # 用例文件（默认 scripts/control-plane/cases/smoke-basic.json）
    [string]$CaseFile = '',
    # mcDataDir 覆盖（默认 <repo>\mod\gtnh\run\client）；主要给离线自检用
    [string]$McDataDir = '',
    # 控制面预期端口（契约默认 23057）；仅用于前置占用检查
    [int]$Port = 23057,
    # 复用已在跑的客户端：不写配置、不起进程、不停进程
    [switch]$SkipClientStart,
    # 跑完不停客户端（保留现场）
    [switch]$KeepClient,
    # 后备通道：用 JVM 属性 -Dsde.controlPlane=on 启用（会绕过 lightning.cfg 通道，仅排障用）
    [switch]$EnableViaJvmProperty,
    # server.json 等待上限（分钟）
    [int]$ClientReadyTimeoutMin = 5,
    # 单次 case.run 的总超时（毫秒），默认 10 min
    [int]$CaseTimeoutMs = 600000,
    # 归档根目录
    [string]$ArchiveRoot = 'D:\Workspace\Lightning\temp\control-plane',
    # 参数名覆盖（默认从 case.run 自描述里探测；探测失败才需要显式给）
    [string]$FileParamName = '',
    [string]$SegmentsParamName = '',
    [string]$VariantParamName = ''
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
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
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
$callerPath = Join-Path $scriptDir 'caller.mjs'
$casePath = if ([string]::IsNullOrWhiteSpace($CaseFile)) { Join-Path $scriptDir 'cases\smoke-basic.json' } else { [System.IO.Path]::GetFullPath($CaseFile) }
$port = $Port

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$archiveDir = Join-Path $ArchiveRoot "smoke-$ts"
$logDir = Join-Path $archiveDir 'logs'
$assertions = New-Object System.Collections.ArrayList
$script:fatalCode = 0
$clientProc = $null
$cfgExisted = $false
$createdRuns = New-Object System.Collections.ArrayList

function Write-Step([string]$msg) { Write-Host "== [CP-SMOKE] $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host "   OK  $msg" -ForegroundColor Green }
function Write-Warn2([string]$msg) { Write-Host "   !!  $msg" -ForegroundColor Yellow }
function Write-Err2([string]$msg) { Write-Host "   XX  $msg" -ForegroundColor Red }
function Write-Dim([string]$msg) { Write-Host "      $msg" -ForegroundColor DarkGray }

function Add-Assertion([string]$Name, [bool]$Ok, [string]$Detail) {
    [void]$assertions.Add([pscustomobject]@{ name = $Name; ok = $Ok; detail = $Detail })
    if ($Ok) { Write-Host ("   PASS  {0,-32} {1}" -f $Name, $Detail) -ForegroundColor Green }
    else { Write-Host ("   FAIL  {0,-32} {1}" -f $Name, $Detail) -ForegroundColor Red }
}

function Fail-Fatal([string]$Message, [int]$Code) {
    $script:fatalCode = $Code
    throw $Message
}

# ---------------------------------------------------------------------------
# 通用工具
# ---------------------------------------------------------------------------
function Get-Text([string]$Path, [int]$Lines = 40) {
    try { if (Test-Path $Path) { return @(Get-Content $Path -Tail $Lines) } } catch { return @("(读取失败: $($_.Exception.Message))") }
    return @()
}

function Show-LogTail([string]$Path, [int]$Lines = 40) {
    foreach ($l in (Get-Text $Path $Lines)) { Write-Dim $l }
}

function Test-PortListening([int]$Port) {
    try {
        $conns = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
        if ($conns.Count -gt 0) { return $true }
    } catch { }
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $client.Connect('127.0.0.1', $Port)
        $client.Close()
        return $true
    } catch { return $false }
}

function Read-JsonFile([string]$Path) {
    if (-not (Test-Path $Path)) { return $null }
    try { return (Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

# ---------------------------------------------------------------------------
# 配置：lightning.cfg 的 controlplane.enabled（写前备份、收尾还原）
# ---------------------------------------------------------------------------
function Enable-ControlPlaneCfg([string]$Path) {
    # Forge Configuration 格式：分节是 `name {` ... `}`，不是 INI 的 [name]（2026-10-06 冒烟实测：
    # 写 [controlplane] 会被 Forge 忽略并重写为默认值 ⇒ 控制面没起来）。两种形态都识别、写入用 Forge 格式。
    $lines = @()
    if (Test-Path $Path) { $lines = @(Get-Content $Path) }
    $section = ''
    $done = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if ($line -match '^\s*\[(.+?)\]\s*$') { $section = $Matches[1].Trim().ToLowerInvariant(); continue }
        if ($line -match '^\s*([A-Za-z0-9_.-]+)\s*\{\s*$') { $section = $Matches[1].Trim().ToLowerInvariant(); continue }
        if ($line -match '^\s*\}\s*$') { $section = ''; continue }
        if ($section -eq 'controlplane' -and $line -match '^\s*[BISED]:\s*enabled\s*=') {
            $lines[$i] = '    B:enabled=true'
            $done = $true
            break
        }
        if ($line -match '^\s*controlplane\.enabled\s*=') {
            $lines[$i] = 'controlplane.enabled=true'
            $done = $true
            break
        }
    }
    if (-not $done) {
        if ($lines.Count -gt 0 -and $lines[-1].Trim() -ne '') { $lines += '' }
        $lines += 'controlplane {'
        $lines += '    B:enabled=true'
        $lines += '}'
    }
    $parent = Split-Path $Path -Parent
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Set-Content -Path $Path -Value $lines -Encoding utf8NoBOM
    return $done
}

function Restore-LightningCfg {
    if ($SkipClientStart) { return }
    try {
        if ($cfgExisted) {
            Copy-Item -Force (Join-Path $archiveDir 'lightning.cfg.before') $cfgPath
            Write-Ok "已还原 lightning.cfg（备份在 $archiveDir\lightning.cfg.before）"
        } elseif (Test-Path $cfgPath) {
            # 不删除：移到归档目录（铁律：AI 不删除，只标记）
            Move-Item -Force $cfgPath (Join-Path $archiveDir 'lightning.cfg.created-by-smoke')
            Write-Ok "已移除本次新建的 lightning.cfg（原件移入归档 lightning.cfg.created-by-smoke）"
        }
    } catch { Write-Warn2 "还原 lightning.cfg 失败: $($_.Exception.Message)" }
}

# ---------------------------------------------------------------------------
# 调用方：只经 caller.mjs（自描述驱动），本脚本不 POST 任何裸请求
# ---------------------------------------------------------------------------
function Invoke-Caller {
    param(
        [Parameter(Mandatory = $true)][string]$Action,
        [string]$ParamsJson = '{}',
        [string]$Label = '',
        [switch]$Sync,
        [switch]$NoConfirm,
        [switch]$Describe,
        [int]$TimeoutMs = 120000
    )
    if ([string]::IsNullOrWhiteSpace($Label)) { $Label = ($Action -replace '[^A-Za-z0-9._-]', '_') }
    $jsonOut = Join-Path $logDir "caller-$Label.json"
    $av = @($callerPath, $Action)
    if (-not $Describe) { $av += $ParamsJson }
    $av += @('--mc-dir', $mcDataDir, '--json-out', $jsonOut)
    if ($Describe) { $av += '--describe' } else { $av += @('--timeoutMs', "$TimeoutMs") }
    if ($Sync) { $av += '--sync' }
    if ($NoConfirm) { $av += '--no-confirm' }

    Write-Dim ("> node caller.mjs {0} {1}{2}{3}" -f $Action, $(if ($Describe) { '(--describe)' } else { $ParamsJson }), $(if ($Sync) { ' --sync' } else { '' }), $(if ($NoConfirm) { ' --no-confirm' } else { '' }))
    $out = & $nodeExe @av 2>&1
    $code = $LASTEXITCODE
    foreach ($line in @($out)) { Write-Dim "$line" }
    $json = Read-JsonFile $jsonOut
    return [pscustomobject]@{ action = $Action; code = $code; jsonPath = $jsonOut; json = $json; output = @($out) }
}

# ---------------------------------------------------------------------------
# run 目录与产物
# ---------------------------------------------------------------------------
function Get-RunDirNames {
    if (-not (Test-Path $runsDir)) { return @() }
    return @(Get-ChildItem -Directory $runsDir -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
}

function Resolve-RunDir($JobJson, [string[]]$Before) {
    $runId = $null
    if ($JobJson) {
        foreach ($name in @('runId', 'run', 'runDir')) {
            $v = $JobJson.$name
            if ($v -is [string] -and -not [string]::IsNullOrWhiteSpace($v)) { $runId = $v.Trim(); break }
            if ($null -ne $v -and $v.PSObject.Properties.Name -contains 'runId') { $runId = [string]$v.runId; break }
        }
    }
    if ($runId) {
        foreach ($cand in @((Join-Path $runsDir $runId), $runId)) {
            if (Test-Path $cand -PathType Container) { return (Resolve-Path $cand).Path }
        }
    }
    # 回退：本次调用新出现的 run 目录（不猜「最新」，只认新增）
    $now = Get-RunDirNames
    $new = @($now | Where-Object { $Before -notcontains $_ })
    if ($new.Count -gt 0) {
        Write-Warn2 "作业 JSON 没给可用的 runId，改用本次新增的 run 目录（$($new.Count) 个）"
        return (Resolve-Path (Join-Path $runsDir $new[-1])).Path
    }
    return $null
}

function Get-RunFiles([string]$RunDir) {
    if ([string]::IsNullOrWhiteSpace($RunDir) -or -not (Test-Path $RunDir)) { return @() }
    $prefix = (Resolve-Path $RunDir).Path.TrimEnd('\') + '\'
    return @(Get-ChildItem -Recurse -File $RunDir -ErrorAction SilentlyContinue |
        ForEach-Object { $_.FullName.Substring($prefix.Length).Replace('\', '/') } | Sort-Object)
}

function Get-SegmentNames([string]$RunDir) {
    $segDir = Join-Path $RunDir 'segments'
    if (-not (Test-Path $segDir)) { return @() }
    return @(Get-ChildItem -File $segDir -Filter '*.json' -ErrorAction SilentlyContinue |
        ForEach-Object { [System.IO.Path]::GetFileNameWithoutExtension($_.Name) } | Sort-Object)
}

function Get-CriteriaDoc([string]$RunDir) {
    if ([string]::IsNullOrWhiteSpace($RunDir)) { return $null }
    return (Read-JsonFile (Join-Path $RunDir 'criteria.json'))
}

function Get-VerdictMap($CriteriaDoc) {
    $map = @{}
    if ($null -eq $CriteriaDoc) { return $map }
    foreach ($c in @($CriteriaDoc.criteria)) {
        if ($null -ne $c -and $c.id) { $map[[string]$c.id] = [string]$c.verdict }
    }
    return $map
}

function Format-VerdictMap($Map) {
    if ($Map.Count -eq 0) { return '(空)' }
    return (($Map.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' ')
}

# 递归收集 {id|criteriaId, verdict} 结论对（不假设作业结果结构）
function Get-VerdictPairs($Node, [System.Collections.ArrayList]$Acc) {
    if ($null -eq $Node) { return }
    if ($Node -is [string] -or $Node -is [bool] -or $Node -is [int] -or $Node -is [long] -or $Node -is [double]) { return }
    if ($Node -is [System.Management.Automation.PSCustomObject]) {
        $names = @($Node.PSObject.Properties.Name)
        if (($names -contains 'id' -or $names -contains 'criteriaId') -and ($names -contains 'verdict')) {
            $idv = if ($names -contains 'id') { [string]$Node.id } else { [string]$Node.criteriaId }
            [void]$Acc.Add([pscustomobject]@{ id = $idv; verdict = [string]$Node.verdict; detail = [string]$Node.detail })
        }
        foreach ($p in $Node.PSObject.Properties) { Get-VerdictPairs -Node $p.Value -Acc $Acc }
        return
    }
    if ($Node -is [System.Collections.IEnumerable]) {
        foreach ($i in $Node) { Get-VerdictPairs -Node $i -Acc $Acc }
    }
}

# 精确命中变体子树（层 1）：任何键 id/variantId/variant/name 等于变体 id 的对象
function Find-VariantSubtree($Node, [string]$VariantId, [System.Collections.ArrayList]$Out) {
    if ($null -eq $Node) { return }
    if ($Node -is [string]) { return }
    if ($Node -is [System.Management.Automation.PSCustomObject]) {
        foreach ($key in @('id', 'variantId', 'variant', 'name')) {
            if ($Node.PSObject.Properties.Name -contains $key) {
                $v = $Node.$key
                if ($v -is [string] -and $v -eq $VariantId) { [void]$Out.Add($Node); return }
            }
        }
        foreach ($p in $Node.PSObject.Properties) { Find-VariantSubtree -Node $p.Value -VariantId $VariantId -Out $Out }
        return
    }
    if ($Node -is [System.Collections.IEnumerable]) {
        foreach ($i in $Node) { Find-VariantSubtree -Node $i -VariantId $VariantId -Out $Out }
    }
}

# ---------------------------------------------------------------------------
# 前置检查
# ---------------------------------------------------------------------------
Write-Step "前置检查"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (-not (Test-Path $gradlew)) { Write-Err2 "找不到 $gradlew"; exit 4 }
Write-Ok "gradlew: $gradlew"

if (-not (Test-Path $webNodeModules)) {
    Write-Err2 "找不到 $webNodeModules —— runClient 依赖 syncWeb→vite，请先执行: cd web; npm ci"
    exit 4
}
Write-Ok "web/node_modules 存在"

if (-not (Test-Path $casePath)) { Write-Err2 "找不到用例文件: $casePath"; exit 4 }
Write-Ok "用例文件: $casePath"

if (-not (Test-Path $mcDataDir)) { Write-Err2 "找不到 mcDataDir: $mcDataDir（客户端至少跑过一次才会有 run/client）"; exit 4 }

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { Write-Err2 "PATH 里找不到 node（caller.mjs 需要 Node 18+）"; exit 4 }
Write-Ok "node: $nodeExe"

if (-not (Test-Path $callerPath)) { Write-Err2 "找不到 $callerPath"; exit 4 }

$portBusy = Test-PortListening $port
if ($SkipClientStart) {
    if (-not $portBusy) { Write-Err2 "-SkipClientStart 但端口 $port 没有监听：请先按纪律申请并启动客户端"; exit 4 }
    if (-not (Test-Path $serverJsonPath) -or -not (Test-Path $tokensJsonPath)) {
        Write-Err2 "-SkipClientStart 但缺少 server.json/tokens.json（$cpDir）：控制面可能没启用"; exit 4
    }
    Write-Ok "复用已在跑的客户端（端口 $port 监听中，server.json/tokens.json 就绪）"
} else {
    if ($portBusy) { Write-Err2 "端口 $port 已被占用（runClient 独占资源：先确认没有别的客户端在跑）"; exit 4 }
    Write-Ok "端口 $port 空闲"
}

$caseDoc = Read-JsonFile $casePath
if ($null -eq $caseDoc) { Write-Err2 "用例文件不是合法 JSON: $casePath"; exit 4 }
$caseCriteriaIds = @($caseDoc.criteria | ForEach-Object { [string]$_.id })
$caseVariant = @($caseDoc.variants)[0]
Write-Ok ("用例 id={0} 判据 {1} 条，变体 {2} 个" -f $caseDoc.id, $caseCriteriaIds.Count, @($caseDoc.variants).Count)

# ---------------------------------------------------------------------------
# 写配置 + 起客户端
# ---------------------------------------------------------------------------
try {
    if (-not $SkipClientStart) {
        Write-Step "写 lightning.cfg（controlplane.enabled=true，原值备份）"
        $cfgExisted = Test-Path $cfgPath
        if ($cfgExisted) { Copy-Item -Force $cfgPath (Join-Path $archiveDir 'lightning.cfg.before'); Write-Ok "原值已备份" }
        else { Write-Warn2 "lightning.cfg 不存在，本次新建（收尾会移入归档，不删除）" }
        $replaced = Enable-ControlPlaneCfg $cfgPath
        Write-Ok ("lightning.cfg 已写: {0}（{1}）" -f $cfgPath, $(if ($replaced) { '替换既有键' } else { '追加 controlplane { B:enabled=true } 分节' }))

        # 陈旧发现文件移开：否则会读到上一轮的 port/token（只能连到死人端口）
        $staleDir = Join-Path $archiveDir 'stale'
        New-Item -ItemType Directory -Force -Path $staleDir | Out-Null
        foreach ($f in @($serverJsonPath, $tokensJsonPath)) {
            if (Test-Path $f) { Move-Item -Force $f (Join-Path $staleDir (Split-Path $f -Leaf)); Write-Warn2 "陈旧发现文件已移入归档: $(Split-Path $f -Leaf)" }
        }

        Write-Step "启动客户端（gradlew runClientSdePipeline --console=plain，日志 $logDir\gradle-runClient.log）"
        if ($EnableViaJvmProperty) {
            $env:JAVA_TOOL_OPTIONS = '-Dsde.controlPlane=on'
            Write-Warn2 "已设 JAVA_TOOL_OPTIONS=-Dsde.controlPlane=on（绕过 lightning.cfg 通道，仅排障用）"
        }
        try {
            $clientProc = Start-Process -FilePath $gradlew `
                -ArgumentList @('runClientSdePipeline', '--console=plain') `
                -WorkingDirectory $modDir -NoNewWindow -PassThru `
                -RedirectStandardOutput (Join-Path $logDir 'gradle-runClient.log') `
                -RedirectStandardError (Join-Path $logDir 'gradle-runClient.log.err')
        } finally {
            if ($EnableViaJvmProperty) { Remove-Item Env:\JAVA_TOOL_OPTIONS -ErrorAction SilentlyContinue }
        }
        Write-Ok "客户端进程 pid=$($clientProc.Id)"

        Write-Step "等待 server.json（上限 $ClientReadyTimeoutMin min）"
        $deadline = (Get-Date).AddMinutes($ClientReadyTimeoutMin)
        $ready = $false
        while ((Get-Date) -lt $deadline) {
            if ($clientProc.HasExited) {
                Show-LogTail (Join-Path $logDir 'gradle-runClient.log') 40
                Fail-Fatal "客户端进程提前退出（exitCode=$($clientProc.ExitCode)）：控制面没起来，见上面的日志尾" 3
            }
            if ((Test-Path $serverJsonPath) -and (Test-Path $tokensJsonPath)) { $ready = $true; break }
            Start-Sleep -Seconds 2
        }
        if (-not $ready) {
            Write-Err2 "等待 server.json 超时（$ClientReadyTimeoutMin min）：$serverJsonPath 未出现"
            Write-Warn2 "若实现只认 JVM 属性通道，请用 -EnableViaJvmProperty 复跑；否则检查 lightning.cfg 的 [controlplane] enabled 是否被读取"
            Show-LogTail (Join-Path $logDir 'gradle-runClient.log') 40
            Fail-Fatal "server.json 未出现（超时）" 3
        }
        $serverInfo = Read-JsonFile $serverJsonPath
        Write-Ok ("server.json 出现: port={0} bind={1} contractVersion={2} pid={3}" -f $serverInfo.port, $serverInfo.bind, $serverInfo.contractVersion, $serverInfo.pid)
    } else {
        $serverInfo = Read-JsonFile $serverJsonPath
        Write-Ok ("复用中的服务: port={0} contractVersion={1}" -f $serverInfo.port, $serverInfo.contractVersion)
    }

    $port = [int]$serverInfo.port
    if ($port -ne $Port) { Write-Warn2 "实际绑定端口 $port 与预期 $Port 不同（契约 §1.3 允许 preferred+1 回退）；后续调用一律以 server.json 为准" }

    # -----------------------------------------------------------------------
    # A1 core.ping（等 HTTP 真正可连）
    # -----------------------------------------------------------------------
    Write-Step "A1 core.ping"
    $ping = $null
    $httpDeadline = (Get-Date).AddSeconds(60)
    while ($true) {
        $ping = Invoke-Caller -Action 'core.ping' -Label 'ping' -TimeoutMs 20000
        if ($ping.code -eq 0) { break }
        if ((Get-Date) -ge $httpDeadline) { break }
        Start-Sleep -Seconds 3
    }
    Add-Assertion 'A1 core.ping' ($ping.code -eq 0) "退出码 $($ping.code)（0=done）"

    # -----------------------------------------------------------------------
    # A2 core.status
    # -----------------------------------------------------------------------
    Write-Step "A2 core.status"
    $status = Invoke-Caller -Action 'core.status' -Label 'status' -TimeoutMs 30000
    $statusDetail = ''
    if ($status.json -and $status.json.result) { $statusDetail = ($status.json.result | ConvertTo-Json -Compress -Depth 4) }
    if ($statusDetail.Length -gt 180) { $statusDetail = $statusDetail.Substring(0, 180) + '…' }
    Add-Assertion 'A2 core.status' ($status.code -eq 0) "退出码 $($status.code)；result=$statusDetail"

    # -----------------------------------------------------------------------
    # 动作参数名：只从自描述探测（脚本不硬编码动作参数知识）
    # -----------------------------------------------------------------------
    Write-Step "读 case.run 自描述（参数名探测）"
    $caseRunDesc = Invoke-Caller -Action 'case.run' -Describe -Label 'describe-case.run'
    $caseRunParams = @()
    if ($caseRunDesc.json -and $caseRunDesc.json.params) { $caseRunParams = @($caseRunDesc.json.params) }
    $paramNames = @($caseRunParams | ForEach-Object { [string]$_.name })
    Write-Ok ("case.run 自描述参数: {0}" -f (($caseRunParams | ForEach-Object { "$($_.name):$($_.type)" }) -join ', '))

    function Resolve-ParamName([string[]]$Candidates, [string]$Override, [string]$What) {
        if (-not [string]::IsNullOrWhiteSpace($Override)) {
            if ($paramNames -notcontains $Override) { Write-Warn2 "$What 显式指定的参数名 $Override 不在自描述里" }
            return $Override
        }
        foreach ($c in $Candidates) { if ($paramNames -contains $c) { return $c } }
        return $null
    }
    function Get-ParamType([string]$Name) {
        $p = @($caseRunParams | Where-Object { $_.name -eq $Name })
        if ($p.Count -gt 0) { return [string]$p[0].type }
        return ''
    }

    $fileParam = Resolve-ParamName @('file', 'case', 'caseFile', 'path', 'casePath') $FileParamName 'file'
    if (-not $fileParam) {
        Add-Assertion 'param:file' $false "case.run 自描述里没有文件参数（期望 file/…）；实际: $($paramNames -join ', ')"
        Fail-Fatal "无法确定 case.run 的文件参数名" 2
    }
    Add-Assertion 'param:file' $true "文件参数 = $fileParam"

    $segmentsParam = Resolve-ParamName @('segments', 'segment') $SegmentsParamName 'segments'
    if ($segmentsParam) { Add-Assertion 'param:segments' $true "按段参数 = $segmentsParam" }
    else { Add-Assertion 'param:segments' $false "case.run 自描述里没有 segments 参数（契约 §4 要求 segments:[...]）；实际: $($paramNames -join ', ')" }

    $variantParam = Resolve-ParamName @('variant', 'variants', 'variantId', 'variantIds') $VariantParamName 'variant'
    if ($variantParam) { Add-Assertion 'param:variant' $true "变体参数 = $variantParam（type=$(Get-ParamType $variantParam)）" }
    else { Add-Assertion 'param:variant' $true "自描述无变体选择参数 → 按 case-file.md §6「运行器执行变体」在整跑里核对变体结论" }

    function New-CaseRunParams([string[]]$Segments) {
        $p = @{}
        $p[$fileParam] = $casePath
        if ($segmentsParam -and $Segments) {
            if ((Get-ParamType $segmentsParam) -eq 'array') { $p[$segmentsParam] = @($Segments) } else { $p[$segmentsParam] = ($Segments -join ',') }
        }
        return ($p | ConvertTo-Json -Compress -Depth 8)
    }

    # -----------------------------------------------------------------------
    # A3 case.validate
    # -----------------------------------------------------------------------
    Write-Step "A3 case.validate"
    $validateParams = (@{ $fileParam = $casePath } | ConvertTo-Json -Compress)
    $validate = Invoke-Caller -Action 'case.validate' -ParamsJson $validateParams -Label 'validate' -TimeoutMs 60000
    Add-Assertion 'A3 case.validate' ($validate.code -eq 0) "退出码 $($validate.code)"

    $plan = if ($validate.json) { $validate.json.result } else { $null }
    if ($plan -and ($plan.PSObject.Properties.Name -contains 'criteria') -and ($plan.PSObject.Properties.Name -contains 'variants')) {
        $planCriteria = @($plan.criteria).Count
        $planVariants = @($plan.variants).Count
        $planSegments = @($plan.segments)
        $ok = ($planCriteria -eq $caseCriteriaIds.Count) -and ($planVariants -eq @($caseDoc.variants).Count)
        Add-Assertion 'A3b 计划与用例一致' $ok ("criteria {0}/{1}、variants {2}/{3}、segments=[{4}]" -f `
                $planCriteria, $caseCriteriaIds.Count, $planVariants, @($caseDoc.variants).Count, ($planSegments -join ','))
    } else {
        Write-Warn2 "case.validate 的 result 里没有 criteria/variants 字段，跳过计划一致性核对"
    }

    # -----------------------------------------------------------------------
    # A4 case.run 整跑
    # -----------------------------------------------------------------------
    Write-Step "A4 case.run 整跑（sync，超时 $([int]($CaseTimeoutMs / 1000)) s）"
    $before = Get-RunDirNames
    $fullRun = Invoke-Caller -Action 'case.run' -ParamsJson (New-CaseRunParams $null) -Label 'run-full' -Sync -TimeoutMs $CaseTimeoutMs
    Add-Assertion 'A4 case.run(整跑)' ($fullRun.code -eq 0) "退出码 $($fullRun.code)"
    $fullRunDir = Resolve-RunDir $fullRun.json $before
    if ($fullRunDir) { [void]$createdRuns.Add($fullRunDir); Write-Ok "run 目录: $fullRunDir" }
    else { Write-Err2 "定位不到整跑的 run 目录" }

    $fullCriteria = Get-CriteriaDoc $fullRunDir
    $fullMap = Get-VerdictMap $fullCriteria
    if ($null -eq $fullCriteria) {
        Add-Assertion 'A4b 整跑判据全绿' $false "run 目录里没有 criteria.json（$fullRunDir）"
    } else {
        $notGreen = @($fullMap.GetEnumerator() | Where-Object { $_.Value -ne 'green' } | ForEach-Object { "$($_.Key)=$($_.Value)" })
        $missingIds = @($caseCriteriaIds | Where-Object { -not $fullMap.ContainsKey($_) })
        $ok = ($fullCriteria.overall -eq 'green') -and ($notGreen.Count -eq 0) -and ($missingIds.Count -eq 0)
        Add-Assertion 'A4b 整跑判据全绿' $ok ("overall={0} counts={1} 非绿=[{2}] 缺判据=[{3}]" -f `
                $fullCriteria.overall, ($fullCriteria.counts | ConvertTo-Json -Compress), ($notGreen -join ','), ($missingIds -join ','))
        $evidenceVerdict = $fullMap['evidence-complete']
        if ($evidenceVerdict) { Add-Assertion 'A4c evidence-complete' ($evidenceVerdict -eq 'green') "verdict=$evidenceVerdict" }
    }

    # -----------------------------------------------------------------------
    # A5/A6 按段跑 + A7 一致性
    # -----------------------------------------------------------------------
    $run1Dir = $null
    $run2Dir = $null
    if ($segmentsParam) {
        Write-Step "A5 case.run 按段 world+build"
        $before = Get-RunDirNames
        $run1 = Invoke-Caller -Action 'case.run' -ParamsJson (New-CaseRunParams @('world', 'build')) -Label 'run-seg-world-build' -Sync -TimeoutMs $CaseTimeoutMs
        Add-Assertion 'A5 case.run(world,build)' ($run1.code -eq 0) "退出码 $($run1.code)"
        $run1Dir = Resolve-RunDir $run1.json $before
        if ($run1Dir) { [void]$createdRuns.Add($run1Dir); Write-Ok "run 目录: $run1Dir" }

        Write-Step "A6 case.run 按段 criteria+evidence"
        $before = Get-RunDirNames
        $run2 = Invoke-Caller -Action 'case.run' -ParamsJson (New-CaseRunParams @('criteria', 'evidence')) -Label 'run-seg-criteria-evidence' -Sync -TimeoutMs $CaseTimeoutMs
        Add-Assertion 'A6 case.run(criteria,evidence)' ($run2.code -eq 0) "退出码 $($run2.code)"
        $run2Dir = Resolve-RunDir $run2.json $before
        if ($run2Dir) { [void]$createdRuns.Add($run2Dir); Write-Ok "run 目录: $run2Dir" }

        if ($fullRunDir -and $run1Dir -and $run2Dir) {
            Write-Step "A7 整跑 vs 按段一致（产物形态/判据结论）"
            $fullSegs = Get-SegmentNames $fullRunDir
            $unionSegs = @((Get-SegmentNames $run1Dir) + (Get-SegmentNames $run2Dir) | Sort-Object -Unique)
            $segOk = (($fullSegs -join ',') -eq ($unionSegs -join ','))
            Add-Assertion 'A7a 段集合一致' $segOk ("整跑=[{0}] 按段并集=[{1}]" -f ($fullSegs -join ','), ($unionSegs -join ','))

            $p1Map = Get-VerdictMap (Get-CriteriaDoc $run1Dir)
            $p2Map = Get-VerdictMap (Get-CriteriaDoc $run2Dir)
            $partialMap = @{}
            foreach ($k in $p1Map.Keys) { $partialMap[$k] = $p1Map[$k] }
            foreach ($k in $p2Map.Keys) { $partialMap[$k] = $p2Map[$k] }
            $conflict = @()
            foreach ($k in $fullMap.Keys) {
                if (-not $partialMap.ContainsKey($k)) { $conflict += "$k(按段缺)"; continue }
                if ($partialMap[$k] -ne $fullMap[$k]) { $conflict += "$k(整跑=$($fullMap[$k]) 按段=$($partialMap[$k]))" }
            }
            $extra = @($partialMap.Keys | Where-Object { -not $fullMap.ContainsKey($_) })
            if ($extra.Count -gt 0) { $conflict += "按段多出: $($extra -join ',')" }
            Add-Assertion 'A7b 判据结论一致' ($conflict.Count -eq 0 -and $partialMap.Count -gt 0) `
                ("整跑={0} 按段={1} 差异=[{2}]" -f (Format-VerdictMap $fullMap), (Format-VerdictMap $partialMap), ($conflict -join '; '))

            # 逐 run 的记账文件（manifest/observation）允许只在整跑出现，其余必须能在按段并集里找到
            $allowMissing = @('manifest.json', 'observation.json')
            $unionFiles = @((Get-RunFiles $run1Dir) + (Get-RunFiles $run2Dir) | Sort-Object -Unique)
            $fullFiles = Get-RunFiles $fullRunDir
            $missing = @($fullFiles | Where-Object { $unionFiles -notcontains $_ -and $allowMissing -notcontains $_ })
            $missingAllowed = @($fullFiles | Where-Object { $unionFiles -notcontains $_ -and $allowMissing -contains $_ })
            Add-Assertion 'A7c 产物形态一致' ($missing.Count -eq 0) `
                ("整跑 {0} 个产物，按段并集 {1} 个；缺失=[{2}]、记账类允许缺=[{3}]" -f `
                    $fullFiles.Count, $unionFiles.Count, ($missing -join ','), ($missingAllowed -join ','))
        } else {
            Add-Assertion 'A7a 段集合一致' $false 'run 目录定位失败，无法比对'
        }
    } else {
        Add-Assertion 'A5 case.run(world,build)' $false '无 segments 参数，跳过'
        Add-Assertion 'A6 case.run(criteria,evidence)' $false '无 segments 参数，跳过'
        Add-Assertion 'A7a 段集合一致' $false '无 segments 参数，跳过'
    }

    # -----------------------------------------------------------------------
    # A8 负对照变体
    # -----------------------------------------------------------------------
    Write-Step "A8 case.run 负对照变体"
    if ($null -eq $caseVariant) {
        Add-Assertion 'A8 负对照变体' $false '用例文件没有 variants 段'
    } else {
        $variantId = [string]$caseVariant.id
        $redIds = @($caseVariant.expectCriteriaRed | ForEach-Object { [string]$_ })
        $before = Get-RunDirNames
        if ($variantParam) {
            if ((Get-ParamType $variantParam) -eq 'array') {
                $vp = @{ $fileParam = $casePath; $variantParam = @($variantId) }
            } else {
                $vp = @{ $fileParam = $casePath; $variantParam = $variantId }
            }
            $variantRun = Invoke-Caller -Action 'case.run' -ParamsJson ($vp | ConvertTo-Json -Compress -Depth 8) -Label 'run-variant' -Sync -TimeoutMs $CaseTimeoutMs
            $variantJob = $variantRun.json
        } else {
            $variantRun = Invoke-Caller -Action 'case.run' -ParamsJson (New-CaseRunParams $null) -Label 'run-variant-in-full' -Sync -TimeoutMs $CaseTimeoutMs
            $variantJob = $variantRun.json
        }
        $variantRunDir = Resolve-RunDir $variantJob $before
        if ($variantRunDir) { [void]$createdRuns.Add($variantRunDir) }

        $pairs = New-Object System.Collections.ArrayList
        $scope = 'job'
        if ($variantJob) {
            $subs = New-Object System.Collections.ArrayList
            Find-VariantSubtree -Node $variantJob -VariantId $variantId -Out $subs
            if ($subs.Count -gt 0) {
                $scope = "变体子树($($subs.Count) 个)"
                foreach ($s in $subs) { Get-VerdictPairs -Node $s -Acc $pairs }
            } else {
                Get-VerdictPairs -Node $variantJob -Acc $pairs
                Write-Warn2 "作业 JSON 里找不到变体 $variantId 的子树，退化为全量扫描（可能混入主用例结论）"
            }
        }
        $redFound = @{}
        $otherRed = @()
        foreach ($p in $pairs) {
            if ($redIds -contains $p.id) { if ($p.verdict -eq 'red') { $redFound[$p.id] = $p.detail } }
            elseif ($p.verdict -ne 'green') { $otherRed += "$($p.id)=$($p.verdict)" }
        }
        $notRed = @($redIds | Where-Object { -not $redFound.ContainsKey($_) })
        $ok = ($variantRun.code -eq 0) -and ($notRed.Count -eq 0)
        Add-Assertion 'A8 负对照变体' $ok `
            ("退出码 {0}；变体 {1} expectCriteriaRed=[{2}] 未变红=[{3}]；扫描范围={4}；其它非绿=[{5}]" -f `
                $variantRun.code, $variantId, ($redIds -join ','), ($notRed -join ','), $scope, ($otherRed -join ','))
    }

    # -----------------------------------------------------------------------
    # A9 可写动作缺 confirm（负测试：契约 §1.6 / CP-CONFIRM-001）
    # -----------------------------------------------------------------------
    Write-Step "A9 world.rebuild 无 confirm（预期 CP-CONFIRM-001）"
    $noConfirm = Invoke-Caller -Action 'world.rebuild' -ParamsJson '{}' -Label 'rebuild-no-confirm' -NoConfirm -TimeoutMs 30000
    $errCode = ''
    if ($noConfirm.json -and $noConfirm.json.error) { $errCode = [string]$noConfirm.json.error.code }
    if (-not $errCode) {
        $outText = ($noConfirm.output -join "`n")
        if ($outText -match '未知动作') { $errCode = '(动作未注册：world.rebuild 不在自描述里)' }
        elseif ($outText -match '本地错误') { $errCode = '(caller 本地错误)' }
    }
    Add-Assertion 'A9 world.rebuild 缺 confirm' (($noConfirm.code -ne 0) -and ($errCode -eq 'CP-CONFIRM-001')) `
        ("退出码 {0}（应非 0）error.code={1}（应 CP-CONFIRM-001）" -f $noConfirm.code, $errCode)
}
catch {
    $msg = "$_"
    Write-Err2 "编排中断: $msg"
    $code = if ($script:fatalCode -gt 0) { $script:fatalCode } else { 4 }
    if ($script:fatalCode -eq 0) { Add-Assertion 'orchestration' $false $msg }
    else { Add-Assertion 'fatal' $false $msg }
}
finally {
    # -----------------------------------------------------------------------
    # 收尾：停客户端 → 还原配置 → 归档 → 红绿表
    # -----------------------------------------------------------------------
    Write-Step "收尾"
    if ($null -ne $clientProc) {
        if ($KeepClient) {
            Write-Warn2 "-KeepClient：客户端 pid=$($clientProc.Id) 保持运行（人工收工后请自行结束）"
        } else {
            try { if ($clientProc.HasExited) { Write-Ok "客户端已自行退出（exitCode=$($clientProc.ExitCode)）" } }
            catch { }
            try {
                if (-not $clientProc.HasExited) {
                    Write-Step "停止客户端（taskkill /PID $($clientProc.Id) /T /F；等价人工路径是客户端内 /sde 退出）"
                    & taskkill.exe /PID $clientProc.Id /T /F 2>&1 | ForEach-Object { Write-Dim "$_" }
                    $clientProc.WaitForExit(60000) | Out-Null
                    Write-Ok "客户端进程树已结束"
                }
            } catch { Write-Warn2 "停客户端失败: $($_.Exception.Message)" }
        }
    } elseif ($SkipClientStart) {
        Write-Warn2 "-SkipClientStart：不接管客户端进程（由调度者收工）"
    }

    Start-Sleep -Seconds 2
    Restore-LightningCfg

    Write-Step "归档到 $archiveDir"
    try {
        $runsArchive = Join-Path $archiveDir 'runs'
        New-Item -ItemType Directory -Force -Path $runsArchive | Out-Null
        foreach ($d in $createdRuns) {
            if (Test-Path $d) {
                Copy-Item -Recurse -Force $d (Join-Path $runsArchive (Split-Path $d -Leaf))
                Write-Ok "run 归档: $(Split-Path $d -Leaf)"
            }
        }
        if ($createdRuns.Count -eq 0 -and (Test-Path $runsDir)) {
            # 定位失败时的兜底：整目录复制（宁可多存，别丢证据）
            Copy-Item -Recurse -Force $runsDir (Join-Path $archiveDir 'runs-all')
            Write-Warn2 "未能定位单个 run 目录，已整目录复制 runs/ → runs-all/"
        }
        if (Test-Path $eventsFile) { Copy-Item -Force $eventsFile (Join-Path $archiveDir 'events.jsonl'); Write-Ok "events.jsonl 已归档" }
        else { Write-Warn2 "找不到 events.jsonl（$eventsFile）" }
        if (Test-Path $clientLog) { Copy-Item -Force $clientLog (Join-Path $logDir 'fml-client-latest.log'); Write-Ok "客户端日志已归档" }
        if (Test-Path $cfgPath) { Copy-Item -Force $cfgPath (Join-Path $archiveDir 'lightning.cfg.after') }
        [void]($assertions | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $archiveDir 'assertions.json') -Encoding utf8NoBOM)
        $lines = New-Object System.Collections.ArrayList
        [void]$lines.Add("# 控制面冒烟 $ts")
        [void]$lines.Add('')
        [void]$lines.Add("- 用例文件: ``$casePath``")
        [void]$lines.Add("- mcDataDir: ``$mcDataDir``")
        [void]$lines.Add("- 客户端复用: $([bool]$SkipClientStart)；保留客户端: $([bool]$KeepClient)")
        [void]$lines.Add('')
        [void]$lines.Add('| 断言 | 结果 | 说明 |')
        [void]$lines.Add('|---|---|---|')
        foreach ($a in $assertions) { [void]$lines.Add("| $($a.name) | $(if ($a.ok) { 'PASS' } else { 'FAIL' }) | $($a.detail -replace '\|', '\|') |") }
        [void]($lines | Set-Content -Path (Join-Path $archiveDir 'summary.md') -Encoding utf8NoBOM)
        Write-Ok "断言表: $archiveDir\assertions.json / summary.md"
    } catch { Write-Warn2 "归档失败: $($_.Exception.Message)" }

    Write-Host ""
    Write-Host "== [CP-SMOKE] 断言红绿表" -ForegroundColor Cyan
    foreach ($a in $assertions) {
        $mark = if ($a.ok) { 'PASS' } else { 'FAIL' }
        $color = if ($a.ok) { 'Green' } else { 'Red' }
        Write-Host ("   [{0}] {1,-32} {2}" -f $mark, $a.name, $a.detail) -ForegroundColor $color
    }
    $failed = @($assertions | Where-Object { -not $_.ok })
    Write-Host ""
    Write-Host "   归档: $archiveDir"
    Write-Host ("   总计: {0} 条断言，{1} 红" -f $assertions.Count, $failed.Count)
}

$fatal = if ($script:fatalCode -gt 0) { $script:fatalCode } else { 0 }
$failedCount = @($assertions | Where-Object { -not $_.ok }).Count
if ($fatal -gt 0) {
    Write-Host "== [CP-SMOKE] 管线级致命（退出码 $fatal）" -ForegroundColor Red
    exit $fatal
}
if ($failedCount -gt 0) {
    Write-Host "== [CP-SMOKE] 有 $failedCount 条断言红（退出码 2）：原因见红绿表与归档" -ForegroundColor Red
    exit 2
}
Write-Host "== [CP-SMOKE] 控制面冒烟全绿（退出码 0）" -ForegroundColor Green
exit 0
