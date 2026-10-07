<#
  run-one-shot.ps1 —— 控制面「一条命令」入口（#106 F4）
  ============================================================================
  目标：把「冷启动一个控制面客户端 → 跑一份用例 → 用设施自己的手段验证产物 →
  用设施自己的方式干净退出」收敛成**一条命令**，并让进程退出码等于设施的判定。

  用法（在 <工作树>\ 下执行）：
    pwsh -File scripts/control-plane/run-one-shot.ps1
    pwsh -File scripts/control-plane/run-one-shot.ps1 -CaseFile <abs>\test\cases\smoke\cp-smoke-shots.json -Port 23312
    pwsh -File scripts/control-plane/run-one-shot.ps1 -SkipClientStart          # 复用已在跑的客户端
    pwsh -File scripts/control-plane/run-one-shot.ps1 -KeepClient               # 跑完不清退（人工看现场）

  与既有驱动的差别（每条都是本单实测出来的缺口）：
    1. **能设首选端口**：`-Port` 不只做前置占用检查，而是真的写进
       `<mcDataDir>\config\lightning.cfg` 的 `I:port=`（既有驱动只写 `enabled`，
       端口只能吃 23057 默认值 —— 多树并行时无法落到 .workspace/ports.json 分配的 slot）。
    2. **干净退出**：收尾调控制面自己的 `core.shutdown`（契约 §4.9，走
       `Minecraft.shutdown()`，世界落盘），**不** taskkill。
    3. **退出码 = 设施判定**：取 `core.shutdown` 结果的 `code`
       （0 判据全绿 / 2 有红 / 3 设施错误），外层脚本无需解析 stdout。
    4. **产物当场复核**：跑完读 `GET /cp/v1/artifacts/{runId}` 清单并抽样核对
       sha256（设施自己的哈希），而不是只看作业退出码。
    5. **用例默认指向唯一入库位** `test/cases/`，不是历史副本目录。

  退出码：0 设施判定全绿；2 设施判定有红；3 设施错误；4 前置检查或编排自身失败。

  纪律：runClient 是独占资源（Gradle 锁 + 端口 + 世界存档），一次只跑一个；
  点火前必须钉 pauseOnLostFocus=false（本脚本自动钉，见 drive-session.ps1）。
#>
[CmdletBinding()]
param(
    # 用例文件（绝对路径）；默认资产库最便宜的冒烟用例
    [string]$CaseFile = '',
    # 控制面**首选**监听端口：真的写进 lightning.cfg（不只是前置检查）
    [int]$Port = 23057,
    # 权限级：auto = 看用例有没有 cameras 段自动定（有 → forensic）
    [ValidateSet('auto', 'scene', 'forensic')][string]$Tier = 'auto',
    # 复用已在跑的客户端：不写配置、不起进程、不钉选项
    [switch]$SkipClientStart,
    # 跑完不退出客户端（保留现场）
    [switch]$KeepClient,
    # mcDataDir 覆盖
    [string]$McDataDir = '',
    # 用 runClientSdePipeline（旧 JDK 通道）替代默认的 runClient25
    [switch]$LegacyJdk,
    # server.json 等待上限（分钟）
    [int]$ClientReadyTimeoutMin = 8,
    # 单次 case.run 总超时 / 阶段超时（毫秒）——长跑动作必须显式下传，否则假红 CP-EXEC-002
    [int]$CaseTimeoutMs = 600000,
    [int]$StageTimeoutMs = 300000,
    # 归档根目录
    [string]$ArchiveRoot = 'D:\Workspace\Lightning\temp\control-plane'
)

$ErrorActionPreference = 'Stop'
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
$caller = Join-Path $scriptDir 'caller.mjs'
$driveSession = Join-Path $scriptDir 'drive-session.ps1'
$mcDataDir = if ([string]::IsNullOrWhiteSpace($McDataDir)) { Join-Path $modDir 'run\client' } else { [System.IO.Path]::GetFullPath($McDataDir) }
$cpDir = Join-Path $mcDataDir 'controlplane'
$serverJsonPath = Join-Path $cpDir 'server.json'
$tokensJsonPath = Join-Path $cpDir 'tokens.json'
$cfgPath = Join-Path $mcDataDir 'config\lightning.cfg'
$casePath = if ([string]::IsNullOrWhiteSpace($CaseFile)) {
    Join-Path $repoRoot 'test\cases\smoke\cp-smoke-basic.json'
} else { [System.IO.Path]::GetFullPath($CaseFile) }

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$archiveDir = Join-Path $ArchiveRoot "one-shot-$ts"
New-Item -ItemType Directory -Force -Path $archiveDir | Out-Null

$assertions = New-Object System.Collections.ArrayList
$clientProc = $null
$cfgExisted = $false
$facilityCode = $null

function Write-Step([string]$m) { Write-Host "== [CP-ONE-SHOT] $m" -ForegroundColor Cyan }
function Write-Ok([string]$m) { Write-Host "   OK  $m" -ForegroundColor Green }
function Write-Warn2([string]$m) { Write-Host "   !!  $m" -ForegroundColor Yellow }
function Write-Err2([string]$m) { Write-Host "   XX  $m" -ForegroundColor Red }
function Add-Assertion([string]$Name, [bool]$Ok, [string]$Detail) {
    [void]$assertions.Add([pscustomobject]@{ name = $Name; ok = $Ok; detail = $Detail })
    $c = if ($Ok) { 'Green' } else { 'Red' }
    Write-Host ("   [{0}] {1,-24} {2}" -f $(if ($Ok) { 'PASS' } else { 'FAIL' }), $Name, $Detail) -ForegroundColor $c
}
function Fail-Fatal([string]$Message, [int]$Code) {
    Write-Err2 $Message
    Write-Step "归档到 $archiveDir"
    try { Save-Summary } catch { }
    exit $Code
}
# 写参数 JSON 到文件，用 caller.mjs 的 @file 形态——绕开 PowerShell 对 JSON argv 的引号/反斜杠转义
function Write-Params([string]$Name, [hashtable]$Obj) {
    $p = Join-Path $archiveDir "params-$Name.json"
    ($Obj | ConvertTo-Json -Depth 8 -Compress) | Set-Content -Path $p -Encoding utf8NoBOM
    return $p
}
function Save-Summary() {
    [void]($assertions | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $archiveDir 'assertions.json') -Encoding utf8NoBOM)
    $lines = New-Object System.Collections.ArrayList
    [void]$lines.Add("# 控制面一条命令跑（run-one-shot.ps1）$ts")
    [void]$lines.Add('')
    [void]$lines.Add("- 用例文件: ``$casePath``")
    [void]$lines.Add("- mcDataDir: ``$mcDataDir``")
    [void]$lines.Add("- 首选端口: $Port；权限级: $Tier")
    [void]$lines.Add("- 复用客户端: $([bool]$SkipClientStart)；保留客户端: $([bool]$KeepClient)")
    [void]$lines.Add('')
    [void]$lines.Add('| 检查 | 结果 | 说明 |')
    [void]$lines.Add('|---|---|---|')
    foreach ($a in $assertions) { [void]$lines.Add("| $($a.name) | $(if ($a.ok) { 'PASS' } else { 'FAIL' }) | $($a.detail -replace '\|', '\|') |") }
    [void]($lines | Set-Content -Path (Join-Path $archiveDir 'summary.md') -Encoding utf8NoBOM)
    Write-Ok "断言表: $archiveDir\assertions.json / summary.md"
}
function Test-PortListening([int]$P) {
    try { if (@(Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction Stop).Count -gt 0) { return $true } } catch { }
    try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $P); $c.Close(); return $true } catch { return $false }
}
function Invoke-Caller([string]$Action, [string]$ParamsPath, [string[]]$Extra, [string]$JsonOut) {
    $argv = @($caller, $Action, "@$ParamsPath") + $Extra + @('--json-out', $JsonOut)
    $out = & node @argv 2>&1
    $code = $LASTEXITCODE
    $out | Set-Content -Path ($JsonOut -replace '\.json$', '.stdout.txt') -Encoding utf8NoBOM
    $json = $null
    if (Test-Path $JsonOut) { try { $json = Get-Content $JsonOut -Raw -Encoding UTF8 | ConvertFrom-Json } catch { } }
    return [pscustomobject]@{ code = $code; output = $out; json = $json }
}

# ---------------------------------------------------------------------------
# 前置检查
# ---------------------------------------------------------------------------
Write-Step "前置检查"
if (-not (Test-Path $gradlew)) { Fail-Fatal "缺 gradlew.bat: $gradlew" 4 }
Add-Assertion 'P1 gradlew' $true $gradlew
if (-not (Test-Path $webNodeModules)) { Fail-Fatal "缺 web\node_modules：先 cd web; npm ci（runClient 依赖 syncWeb→vite）" 4 }
Add-Assertion 'P2 web/node_modules' $true 'syncWeb→vite 依赖已就位'
if (-not (Test-Path $casePath)) { Fail-Fatal "用例文件不存在: $casePath" 4 }

$caseDoc = Get-Content $casePath -Raw -Encoding UTF8 | ConvertFrom-Json
$effTier = $Tier
if ($Tier -eq 'auto') {
    $camCount = @($caseDoc.cameras | Where-Object { $_ }).Count
    $effTier = if ($camCount -gt 0) { 'forensic' } else { 'scene' }
}
Add-Assertion 'P3 用例与权限级' $true ("id={0}；cameras {1} 段 → tier={2}" -f $caseDoc.id, @($caseDoc.cameras).Count, $effTier)

if (-not $SkipClientStart) {
    if (Test-PortListening $Port) { Fail-Fatal "端口 $Port 已在监听（runClient 独占：先确认没有别的客户端在跑）" 4 }
    Add-Assertion 'P4 端口空闲' $true "preferred=$Port"
}

# ---------------------------------------------------------------------------
# 钉选项（治本）+ 写配置 + 起客户端
# ---------------------------------------------------------------------------
try {
    if (-not $SkipClientStart) {
        New-Item -ItemType Directory -Force -Path $mcDataDir | Out-Null
        Write-Step "钉 pauseOnLostFocus=false（客户端启动前，必需的无人值守前置）"
        & pwsh -File $driveSession -RunDir $mcDataDir -Tag oneshot -PinOnly | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail-Fatal "钉选项失败（drive-session.ps1 -PinOnly 退出 $LASTEXITCODE）" 4 }
        $pinned = @(Get-Content (Join-Path $mcDataDir 'options.txt') | Where-Object { $_ -match '^pauseOnLostFocus:' })
        Add-Assertion 'P5 pauseOnLostFocus' ($pinned.Count -eq 1 -and $pinned[0] -ceq 'pauseOnLostFocus:false') ($pinned -join ' | ')

        Write-Step "写 lightning.cfg（controlplane.enabled=true + 首选端口 $Port，原值备份）"
        $cfgExisted = Test-Path $cfgPath
        if ($cfgExisted) { Copy-Item -Force $cfgPath (Join-Path $archiveDir 'lightning.cfg.before') }
        $cfgDir = Split-Path $cfgPath -Parent
        if (-not (Test-Path $cfgDir)) { New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null }
        # Forge Configuration 分节格式（不是 INI 的 [name]）——既有驱动实测：写 [controlplane] 会被 Forge 忽略
        @(
            'controlplane {'
            '    B:enabled=true'
            "    I:port=$Port"
            '}'
        ) | Set-Content -Path $cfgPath -Encoding utf8NoBOM
        Add-Assertion 'P6 lightning.cfg' $true "enabled=true, port=$Port → $cfgPath"

        # 陈旧发现文件移开：否则会读到上一轮的 port/token（只能连到死人端口）
        $staleDir = Join-Path $archiveDir 'stale'
        New-Item -ItemType Directory -Force -Path $staleDir | Out-Null
        foreach ($f in @($serverJsonPath, $tokensJsonPath)) {
            if (Test-Path $f) { Move-Item -Force $f (Join-Path $staleDir (Split-Path $f -Leaf)) }
        }

        $runTask = if ($LegacyJdk) { 'runClientSdePipeline' } else { 'runClient25' }
        Write-Step "启动客户端（gradlew $runTask --console=plain）"
        if (-not $env:GRADLE_USER_HOME) { $env:GRADLE_USER_HOME = 'C:\gradle-cache' }
        $logOut = Join-Path $archiveDir 'gradle-runClient.log'
        $logErr = Join-Path $archiveDir 'gradle-runClient.err'
        $jvm = @()
        if (-not $LegacyJdk) { $jvm += '-Dfml.queryResult=confirm' }
        if ($jvm.Count -gt 0) { $env:JAVA_TOOL_OPTIONS = ($jvm -join ' ') }
        try {
            $clientProc = Start-Process -FilePath $gradlew -ArgumentList @($runTask, '--console=plain') `
                -WorkingDirectory $modDir -NoNewWindow -PassThru `
                -RedirectStandardOutput $logOut -RedirectStandardError $logErr
        } finally {
            if ($jvm.Count -gt 0) { Remove-Item Env:\JAVA_TOOL_OPTIONS -ErrorAction SilentlyContinue }
        }
        Write-Ok "客户端进程 pid=$($clientProc.Id)"

        Write-Step "等待 server.json / tokens.json（上限 $ClientReadyTimeoutMin min）"
        $deadline = (Get-Date).AddMinutes($ClientReadyTimeoutMin)
        $ready = $false
        while ((Get-Date) -lt $deadline) {
            if ($clientProc.HasExited) {
                Get-Content $logOut -Tail 30 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
                Fail-Fatal "客户端提前退出（exitCode=$($clientProc.ExitCode)）：控制面没起来" 3
            }
            if ((Test-Path $serverJsonPath) -and (Test-Path $tokensJsonPath)) { $ready = $true; break }
            Start-Sleep -Seconds 2
        }
        if (-not $ready) {
            Get-Content $logOut -Tail 30 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
            Fail-Fatal "等 server.json 超时（$ClientReadyTimeoutMin min）" 3
        }
    }

    $srv = Get-Content $serverJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $boundPort = [int]$srv.port
    Add-Assertion 'P7 控制面就绪' ($boundPort -gt 0) ("port={0} bind={1} contractVersion={2} pid={3}" -f $srv.port, $srv.bind, $srv.contractVersion, $srv.pid)
    if ($boundPort -ne $Port) { Write-Warn2 "实际绑定端口 $boundPort ≠ 首选 $Port（契约 §1.3 允许 preferred+1 回退）" }

    # -----------------------------------------------------------------------
    # 跑用例
    # -----------------------------------------------------------------------
    Write-Step "case.run（tier=$effTier，sync）"
    $pRun = Write-Params 'case-run' @{
        file           = $casePath.Replace('\', '/')
        totalTimeoutMs = $CaseTimeoutMs
        stageTimeoutMs = $StageTimeoutMs
    }
    $r = Invoke-Caller -Action 'case.run' -ParamsPath $pRun `
        -Extra @('--tier', $effTier, '--sync', '--timeoutMs', "$CaseTimeoutMs") `
        -JsonOut (Join-Path $archiveDir 'case-run.json')
    if ($null -eq $r.json) { Add-Assertion 'C1 case.run 调用' $false "无作业 JSON（退出 $($r.code)）"; throw "case.run 无作业 JSON" }
    $res = $r.json.result
    $runId = [string]$res.runId
    $overall = [string]$res.overall
    $counts = $res.criteria.counts
    Add-Assertion 'C1 case.run' ($r.code -eq 0 -and $overall -eq 'green') `
        ("退出码 {0}；runId={1}；overall={2}；criteria green={3} red={4} error={5}" -f $r.code, $runId, $overall, $counts.green, $counts.red, $counts.error)
    Add-Assertion 'C2 evidence' ($res.evidence.verdict -eq 'green') ("verdict={0}；{1}" -f $res.evidence.verdict, $res.evidence.detail.detail)

    # -----------------------------------------------------------------------
    # 用设施自己的手段复核产物：GET /cp/v1/artifacts/{runId} + sha256 抽样
    # -----------------------------------------------------------------------
    Write-Step "复核产物（GET /cp/v1/artifacts/$runId）"
    $tok = (Get-Content $tokensJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json).tokens
    $hdr = @{ Authorization = "Bearer $($tok.observe)" }
    $base = "http://127.0.0.1:$boundPort/cp/v1"
    $man = (Invoke-RestMethod -Uri "$base/artifacts/$runId" -Headers $hdr).data
    Add-Assertion 'C3 产物清单' ($man.count -gt 0) ("count={0}（caseId={1}）" -f $man.count, $man.caseId)

    $probe = $man.artifacts | Where-Object { $_.role -eq 'shot' } | Select-Object -First 1
    if ($null -eq $probe) { $probe = $man.artifacts | Where-Object { $_.role -ne 'segment' -and $_.role -ne 'case' } | Select-Object -First 1 }
    if ($probe) {
        $dl = Join-Path $archiveDir ('artifact-' + (Split-Path $probe.path -Leaf))
        Invoke-WebRequest -Uri "$base/artifacts/$runId/$($probe.path)" -Headers $hdr -OutFile $dl | Out-Null
        $got = (Get-FileHash $dl -Algorithm SHA256).Hash.ToLower()
        Add-Assertion 'C4 产物 sha256 复核' ($got -eq $probe.sha256) ("$($probe.path)：下载 $($got.Substring(0,16))… vs 清单 $($probe.sha256.Substring(0,16))…")
    } else {
        Add-Assertion 'C4 产物 sha256 复核' $false '清单里没有可下载的非 segment 产物'
    }

    # -----------------------------------------------------------------------
    # 用设施自己的方式干净退出（契约 §4.9），退出码即设施判定
    # -----------------------------------------------------------------------
    if ($KeepClient) {
        Write-Warn2 "-KeepClient：不发起 core.shutdown，客户端 pid=$($clientProc.Id) 保持运行"
        $facilityCode = if ($overall -eq 'green' -and $res.evidence.verdict -eq 'green') { 0 } else { 2 }
    } else {
        Write-Step "core.shutdown（设施自身的收尾原语）"
        $sdParams = if ($runId) { @{ runId = $runId; reason = 'run-one-shot.ps1 收尾' } } else { @{ code = 2; reason = 'case.run 未产出 runId' } }
        $pSd = Write-Params 'shutdown' $sdParams
        $sd = Invoke-Caller -Action 'core.shutdown' -ParamsPath $pSd -Extra @('--sync', '--timeoutMs', '60000') -JsonOut (Join-Path $archiveDir 'shutdown.json')
        $facilityCode = if ($sd.json -and $sd.json.result) { [int]$sd.json.result.code } else { 3 }
        Add-Assertion 'S1 core.shutdown' ($null -ne $facilityCode) `
            ("code={0}；exitPath={1}" -f $facilityCode, $(if ($sd.json.result) { $sd.json.result.exitPath } else { '(无)' }))

        Write-Step "等端口释放"
        $deadline = (Get-Date).AddSeconds(150)
        $released = $false
        while ((Get-Date) -lt $deadline) {
            if (-not (Test-PortListening $boundPort)) { $released = $true; break }
            Start-Sleep -Seconds 3
        }
        Add-Assertion 'S2 端口释放' $released "port=$boundPort released=$released"
    }
} catch {
    Write-Err2 "编排中断: $_"
    Add-Assertion 'orchestration' $false "$_"
    if ($null -eq $facilityCode) { $facilityCode = 4 }
} finally {
    if ($cfgExisted -and -not $SkipClientStart) {
        try { Copy-Item -Force (Join-Path $archiveDir 'lightning.cfg.before') $cfgPath; Write-Ok 'lightning.cfg 已还原' }
        catch { Write-Warn2 "还原 lightning.cfg 失败: $($_.Exception.Message)" }
    }
    Write-Step "归档到 $archiveDir"
    try { Save-Summary } catch { Write-Warn2 "归档失败: $($_.Exception.Message)" }
    Write-Host ""
    Write-Host "   归档: $archiveDir" -ForegroundColor Cyan
}

if ($null -eq $facilityCode) { $facilityCode = 4 }
Write-Host "   设施判定退出码: $facilityCode（0 全绿 / 2 有红 / 3 设施错误 / 4 前置或编排失败）" -ForegroundColor Cyan
exit $facilityCode
