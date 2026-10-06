<#
  PR-2 取证拍摄验收驱动（无人值守）—— contract.md §4.1/§4.2 + case-file.md §4/§5 的端到端验收
  ============================================================================
  与 run-smoke.ps1（PR-1）同风格、同退出码；差异只在断言集与归档内容（截图原图是证据）。

  流程：前置检查（gradlew / web/node_modules / 用例文件 / 端口）→ 写 run/client/config/lightning.cfg
  （controlplane.enabled=true，原值备份）→ Start-Process 启动客户端（默认 runClient25，可用
  -LegacyJdk 退回 runClientSdePipeline）→ 轮询 server.json → 依次断言：

    B1 case.run 整跑（--tier forensic --sync）  退出码 0 且 result.overall=green
    B2 run 产物自证                            criteria.json 全绿且覆盖全部判据、evidence-complete 绿、
                                              observation.camera.mode=injected、playerPos≠camera.pos（门控分离）、
                                              cameras[] 摘要 = 3 机位
    B3 负对照变体单跑（variant 参数）            退出码 0 且 expectCriteriaRed 列出的判据全红（变体红=通过），
                                              其余判据仍绿（负对照必须「精确命中」）
    B4 捕获会话门控                            capture.begin → world.rebuild 被判 CP-STATE-001 →
                                              capture.end → world.rebuild 成功（恢复环境）
    B5 权限按内容升格                            含 cameras 段的 case.run 用 --tier scene --sync
                                              → HTTP 403 + CP-AUTH-002
    B6 截图产物与渲染留痕                        shots/<name>.png 存在且非空（PNG 头实读尺寸 == 声明）、
                                              meta.json 的 cameraHeldDuringRender=true 且 resolution 与声明一致、
                                              拼接机位的 <name>.tiles/ 片数 == meta.tile.cols×rows、
                                              单片命名 == r<row>c<col>.png
    B7 收尾无残留                              core.status 世界仍在（loaded+managed）→ caller 直接再拍一张
                                              persp-main 成功：settingsRestored=true、真实窗口尺寸已还原、
                                              新图尺寸/留痕正确（投影/分辨率/renderViewEntity 无残留）

  收尾：停客户端 → 还原 lightning.cfg → 归档（run 目录 + events.jsonl + 日志 + 全部 shots PNG 原图，
  后者另在归档根平铺一份 shots-flat/ 便于当 Gitea 附件）→ 打印红绿表与归档路径。

  用法：
    pwsh -File scripts/control-plane/run-shots.ps1
    pwsh -File scripts/control-plane/run-shots.ps1 -SkipClientStart    # 复用已在跑的客户端（不写配置、不停客户端）
    pwsh -File scripts/control-plane/run-shots.ps1 -KeepClient         # 跑完不停客户端（留现场）
    pwsh -File scripts/control-plane/run-shots.ps1 -CaseFile <path>    # 换用例文件
    pwsh -File scripts/control-plane/run-shots.ps1 -LegacyJdk          # 退回 runClientSdePipeline

  退出码：0 = 全绿；2 = 有断言红；3 = 管线级致命（server.json 超时/客户端早退）；
          4 = 前置检查或编排自身失败。

  纪律：runClient 是独占资源（Gradle 锁 + 端口 + 世界存档），用前向 Lead 申请，一次只跑一个。
#>
[CmdletBinding()]
param(
    # 用例文件（默认 scripts/control-plane/cases/smoke-shots.json）
    [string]$CaseFile = '',
    # mcDataDir 覆盖（默认 <repo>\mod\gtnh\run\client）；主要给离线自检用
    [string]$McDataDir = '',
    # 控制面预期端口（契约默认 23057）；仅用于前置占用检查
    [int]$Port = 23057,
    # 复用已在跑的客户端：不写配置、不起进程、不停进程
    [switch]$SkipClientStart,
    # 跑完不停客户端（保留现场）
    [switch]$KeepClient,
    # 后备通道：用 JVM 属性 -Dsde.controlPlane=on 启用（绕过 lightning.cfg 通道，仅排障用）
    [switch]$EnableViaJvmProperty,
    # 用 runClient25（lwjgl3ify 现代 JVM，启动更快）：**默认开**。
    # 本开关保留只为与 run-smoke.ps1 的写法兼容（给了也是默认行为，不报错）；
    # 要退回 runClientSdePipeline 请用 -LegacyJdk。
    [switch]$UseModernJdk,
    # 退回 runClientSdePipeline（旧 JDK 通道）；与默认（现代 JVM）互斥，给了它就以它为准
    [switch]$LegacyJdk,
    # server.json 等待上限（分钟）
    [int]$ClientReadyTimeoutMin = 5,
    # 单次 case.run 的总超时（毫秒）：PR-2 整跑含世界重建 + 3 机位拍摄，比 PR-1 冒烟长
    [int]$CaseTimeoutMs = 900000,
    # 单次 world.rebuild / shot.multi 的总超时（毫秒）
    [int]$ActionTimeoutMs = 600000,
    # 归档根目录
    [string]$ArchiveRoot = 'D:\Workspace\Lightning\temp\control-plane',
    # 参数名覆盖（默认从 case.run 自描述里探测；探测失败才需要显式给）
    [string]$FileParamName = '',
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
$casePath = if ([string]::IsNullOrWhiteSpace($CaseFile)) { Join-Path $scriptDir 'cases\smoke-shots.json' } else { [System.IO.Path]::GetFullPath($CaseFile) }
$port = $Port
# 现代 JVM 默认开（契约外的启动口径选择，纯为启动快）；-LegacyJdk 退回 runClientSdePipeline
$modernJdk = -not [bool]$LegacyJdk
if ($UseModernJdk -and $LegacyJdk) { Write-Warning "-UseModernJdk 与 -LegacyJdk 同时给出：以 -LegacyJdk 为准（退回 runClientSdePipeline）" }

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$archiveDir = Join-Path $ArchiveRoot "shots-$ts"
$logDir = Join-Path $archiveDir 'logs'
$flatShotsDir = Join-Path $archiveDir 'shots-flat'
$assertions = New-Object System.Collections.ArrayList
$script:fatalCode = 0
$clientProc = $null
$cfgExisted = $false
$createdRuns = New-Object System.Collections.ArrayList

function Write-Step([string]$msg) { Write-Host "== [CP-SHOTS] $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host "   OK  $msg" -ForegroundColor Green }
function Write-Warn2([string]$msg) { Write-Host "   !!  $msg" -ForegroundColor Yellow }
function Write-Err2([string]$msg) { Write-Host "   XX  $msg" -ForegroundColor Red }
function Write-Dim([string]$msg) { Write-Host "      $msg" -ForegroundColor DarkGray }
function Write-Info([string]$msg) { Write-Host "   --  $msg" -ForegroundColor DarkCyan }

function Add-Assertion([string]$Name, [bool]$Ok, [string]$Detail) {
    [void]$assertions.Add([pscustomobject]@{ name = $Name; ok = $Ok; detail = $Detail })
    if ($Ok) { Write-Host ("   PASS  {0,-34} {1}" -f $Name, $Detail) -ForegroundColor Green }
    else { Write-Host ("   FAIL  {0,-34} {1}" -f $Name, $Detail) -ForegroundColor Red }
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

function Get-JsonProp($Node, [string]$Name) {
    if ($null -eq $Node) { return $null }
    if ($Node -is [System.Management.Automation.PSCustomObject] -and ($Node.PSObject.Properties.Name -contains $Name)) { return $Node.$Name }
    return $null
}

# RFC 6901 指针（判据 json-field 的同一口径；空串指根）
function Resolve-JsonPointer($Node, [string]$Pointer) {
    if ($null -eq $Node) { return $null }
    if ([string]::IsNullOrEmpty($Pointer)) { return $Node }
    if (-not $Pointer.StartsWith('/')) { return $null }
    $cur = $Node
    foreach ($raw in $Pointer.Substring(1).Split('/')) {
        if ($null -eq $cur) { return $null }
        $token = $raw.Replace('~1', '/').Replace('~0', '~')
        if ($cur -is [System.Array] -or $cur -is [System.Collections.IList]) {
            $idx = 0
            if (-not [int]::TryParse($token, [ref]$idx)) { return $null }
            if ($idx -lt 0 -or $idx -ge @($cur).Count) { return $null }
            $cur = @($cur)[$idx]
        } elseif ($cur -is [System.Management.Automation.PSCustomObject]) {
            if (-not ($cur.PSObject.Properties.Name -contains $token)) { return $null }
            $cur = $cur.$token
        } else {
            return $null
        }
    }
    return $cur
}

# PNG 头实读尺寸（只读 24 字节；不解码全图，与判据 image-size-equals 同口径）
function Get-PngSize([string]$Path) {
    if (-not (Test-Path $Path -PathType Leaf)) { return $null }
    try {
        $fs = [System.IO.File]::OpenRead($Path)
        try {
            $buf = New-Object byte[] 24
            $n = $fs.Read($buf, 0, 24)
            if ($n -lt 24) { return $null }
            $sig = (($buf[0..7] | ForEach-Object { $_.ToString('x2') }) -join '')
            if ($sig -ne '89504e470d0a1a0a') { return $null }
            if ([System.Text.Encoding]::ASCII.GetString($buf, 12, 4) -ne 'IHDR') { return $null }
            $w = ([int]$buf[16] -shl 24) + ([int]$buf[17] -shl 16) + ([int]$buf[18] -shl 8) + [int]$buf[19]
            $h = ([int]$buf[20] -shl 24) + ([int]$buf[21] -shl 16) + ([int]$buf[22] -shl 8) + [int]$buf[23]
            return [pscustomobject]@{ width = $w; height = $h }
        } finally { $fs.Dispose() }
    } catch { return $null }
}

function Format-Size($W, $H) { return "$W`x$H" }

# ---------------------------------------------------------------------------
# 配置：lightning.cfg 的 controlplane.enabled（写前备份、收尾还原）
#   与 run-smoke.ps1 的 Enable-ControlPlaneCfg 同一实现（刻意复制而非抽公共：两个驱动各自的
#   归档/还原路径耦合在自身脚本里，抽公共函数要再引入一个被两个脚本加载的模块文件）。
#   契约事实：Forge Configuration 的分节是 `name {` … `}`，不是 INI 的 [name]
#   （2026-10-06 冒烟实测：写 [controlplane] 会被 Forge 忽略并重写为默认值 ⇒ 控制面没起来）。
# ---------------------------------------------------------------------------
function Enable-ControlPlaneCfg([string]$Path) {
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
            Move-Item -Force $cfgPath (Join-Path $archiveDir 'lightning.cfg.created-by-run-shots')
            Write-Ok "已移除本次新建的 lightning.cfg（原件移入归档 lightning.cfg.created-by-run-shots）"
        }
    } catch { Write-Warn2 "还原 lightning.cfg 失败: $($_.Exception.Message)" }
}

# ---------------------------------------------------------------------------
# 调用方：只经 caller.mjs（自描述驱动），本脚本不 POST 任何裸请求
#   每次调用后把「本次新增的 run 目录」记入 $createdRuns —— 归档要覆盖全部产物，
#   而 world.rebuild / shot.multi / case.run 都会各建一个 run 目录。
# ---------------------------------------------------------------------------
function Invoke-Caller {
    param(
        [Parameter(Mandatory = $true)][string]$Action,
        [string]$ParamsJson = '{}',
        [string]$Label = '',
        [switch]$Sync,
        [switch]$NoConfirm,
        [switch]$Describe,
        [string]$Tier = '',
        [int]$TimeoutMs = 120000
    )
    if ([string]::IsNullOrWhiteSpace($Label)) { $Label = ($Action -replace '[^A-Za-z0-9._-]', '_') }
    $jsonOut = Join-Path $logDir "caller-$Label.json"
    $av = @($callerPath, $Action)
    if (-not $Describe) { $av += $ParamsJson }
    $av += @('--mc-dir', $mcDataDir, '--json-out', $jsonOut)
    if ($Describe) { $av += '--describe' } else { $av += @('--timeoutMs', "$TimeoutMs") }
    if (-not [string]::IsNullOrWhiteSpace($Tier)) { $av += @('--tier', $Tier) }
    if ($Sync) { $av += '--sync' }
    if ($NoConfirm) { $av += '--no-confirm' }

    $before = Get-RunDirNames
    Write-Dim ("> node caller.mjs {0} {1}{2}{3}{4}" -f $Action, $(if ($Describe) { '(--describe)' } else { $ParamsJson }), $(if ($Sync) { ' --sync' } else { '' }), $(if ($Tier) { " --tier $Tier" } else { '' }), $(if ($NoConfirm) { ' --no-confirm' } else { '' }))
    $out = & $nodeExe @av 2>&1
    $code = $LASTEXITCODE
    foreach ($line in @($out)) { Write-Dim "$line" }
    $newRunNames = @((Get-RunDirNames) | Where-Object { $before -notcontains $_ })
    foreach ($n in $newRunNames) {
        $p = Join-Path $runsDir $n
        if (-not $createdRuns.Contains($p)) { [void]$createdRuns.Add($p) }
    }
    $json = Read-JsonFile $jsonOut
    return [pscustomobject]@{ action = $Action; code = $code; jsonPath = $jsonOut; json = $json; output = @($out); newRuns = @($newRunNames) }
}

# ---------------------------------------------------------------------------
# 动作自描述探测（参数名不硬编码；describe 调用同样落 --json-out 作证据）
# ---------------------------------------------------------------------------
$script:paramCache = @{}
function Get-ActionParamNames([string]$Action) {
    if ($script:paramCache.ContainsKey($Action)) { return $script:paramCache[$Action] }
    $d = Invoke-Caller -Action $Action -Describe -Label "describe-$Action"
    $names = @()
    if ($d.json -and $d.json.params) { $names = @($d.json.params | ForEach-Object { [string]$_.name }) }
    $script:paramCache[$Action] = $names
    return $names
}

# 步进动作的自身超时（SteppingActionBase：默认总 5 min / 阶段 3 min）——按脚本超时对齐：
# PR-2 整跑含世界重建 + 3 机位拍摄，「慢但正确」的运行不该被动作自身超时判成 CP-EXEC-002。
# 参数名只在自描述声明时才带（否则 caller.mjs 按「参数未在自描述中声明」本地报错）。
function Add-StepTimeouts([hashtable]$Params, [string]$Action, [int]$TotalMs, [int]$StageMs) {
    if ($StageMs -gt $TotalMs) { $StageMs = $TotalMs } # 阶段预算不得超过总预算（语义一致性）
    $names = Get-ActionParamNames $Action
    if ($names -contains 'totalTimeoutMs') { $Params['totalTimeoutMs'] = $TotalMs }
    if ($names -contains 'stageTimeoutMs') { $Params['stageTimeoutMs'] = $StageMs }
    return $Params
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

function Get-CriteriaDoc([string]$RunDir) {
    if ([string]::IsNullOrWhiteSpace($RunDir)) { return $null }
    return (Read-JsonFile (Join-Path $RunDir 'criteria.json'))
}

# run 目录内的产物读 JSON；run 目录未定位/文件缺失时返回 $null（不抛参数绑定异常）
function Get-RunFile([string]$RunDir, [string]$Rel) {
    if ([string]::IsNullOrWhiteSpace($RunDir)) { return $null }
    return (Read-JsonFile (Join-Path $RunDir ($Rel -replace '/', '\')))
}

# criteria.json → {id → verdict}
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

# 精确命中变体子树：任何键 id/variantId/variant/name 等于变体 id 的对象
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

# 机位清单（从用例文件读；脚本不硬编码用例内容）
function Get-CaseCameras($CaseDoc) {
    $out = New-Object System.Collections.ArrayList
    foreach ($c in @($CaseDoc.cameras)) {
        if ($null -eq $c) { continue }
        $res = @($c.resolution)
        $tile = Get-JsonProp $c 'tile'
        [void]$out.Add([pscustomobject]@{
                name       = [string]$c.name
                width      = [int]$res[0]
                height     = [int]$res[1]
                projection = [string]$c.projection.type
                tiled      = ($null -ne $tile)
                spec       = $c
            })
    }
    return $out
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
$caseCameras = Get-CaseCameras $caseDoc
$caseVariant = @($caseDoc.variants)[0]
$caseWorld = Get-JsonProp $caseDoc 'world'
Write-Ok ("用例 id={0} 判据 {1} 条，机位 {2} 个，变体 {3} 个" -f $caseDoc.id, $caseCriteriaIds.Count, $caseCameras.Count, @($caseDoc.variants).Count)
if ($caseCameras.Count -eq 0) { Write-Err2 "用例没有 cameras 段：本驱动验收的是 PR-2 取证拍摄，无法继续"; exit 4 }
if ($null -eq $caseVariant) { Write-Err2 "用例没有 variants 段：B3 负对照无法验证"; exit 4 }

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

        $runTask = if ($modernJdk) { 'runClient25' } else { 'runClientSdePipeline' }
        Write-Step "启动客户端（gradlew $runTask --console=plain，日志 $logDir\gradle-runClient.log）"
        # 追加式注入：保留调用方已设的 JAVA_TOOL_OPTIONS（同 run-anchor.ps1 修复，#89 Lead 裁决）
        $origJavaToolOptions = $env:JAVA_TOOL_OPTIONS
        $jvmOpts = @()
        if ($origJavaToolOptions) { $jvmOpts += $origJavaToolOptions }
        if ($modernJdk) { $jvmOpts += '-Dfml.queryResult=confirm' }
        if ($EnableViaJvmProperty) {
            $jvmOpts += '-Dsde.controlPlane=on'
            Write-Warn2 "已设 JAVA_TOOL_OPTIONS 含 -Dsde.controlPlane=on（绕过 lightning.cfg 通道，仅排障用）"
        }
        if ($jvmOpts.Count -gt 0) { $env:JAVA_TOOL_OPTIONS = ($jvmOpts -join ' ') }
        try {
            $clientProc = Start-Process -FilePath $gradlew `
                -ArgumentList @($runTask, '--console=plain') `
                -WorkingDirectory $modDir -NoNewWindow -PassThru `
                -RedirectStandardOutput (Join-Path $logDir 'gradle-runClient.log') `
                -RedirectStandardError (Join-Path $logDir 'gradle-runClient.err')
        } finally {
            if ($jvmOpts.Count -gt 0) {
                if ($null -ne $origJavaToolOptions) { $env:JAVA_TOOL_OPTIONS = $origJavaToolOptions }
                else { Remove-Item Env:\JAVA_TOOL_OPTIONS -ErrorAction SilentlyContinue }
            }
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

    if ($null -eq $serverInfo -or -not $serverInfo.port) { Fail-Fatal "server.json 不可读或非法（$serverJsonPath）：拿不到控制面端口" 4 }
    $port = [int]$serverInfo.port
    if ($port -ne $Port) { Write-Warn2 "实际绑定端口 $port 与预期 $Port 不同（契约 §1.3 允许 preferred+1 回退）；后续调用一律以 server.json 为准" }

    # -----------------------------------------------------------------------
    # 探活 + 自描述（参数名不硬编码）
    # -----------------------------------------------------------------------
    Write-Step "core.ping（等 HTTP 真正可连）"
    $ping = $null
    $httpDeadline = (Get-Date).AddSeconds(60)
    while ($true) {
        $ping = Invoke-Caller -Action 'core.ping' -Label 'ping' -TimeoutMs 20000
        if ($ping.code -eq 0) { break }
        if ((Get-Date) -ge $httpDeadline) { break }
        Start-Sleep -Seconds 3
    }
    Add-Assertion 'P1 core.ping' ($ping.code -eq 0) "退出码 $($ping.code)（0=done）"

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

    $fileParam = Resolve-ParamName @('file', 'case', 'caseFile', 'path', 'casePath') $FileParamName 'file'
    if (-not $fileParam) {
        Add-Assertion 'P2 param:file' $false "case.run 自描述里没有文件参数（期望 file/…）；实际: $($paramNames -join ', ')"
        Fail-Fatal "无法确定 case.run 的文件参数名" 2
    }
    Add-Assertion 'P2 param:file' $true "文件参数 = $fileParam"

    $variantParam = Resolve-ParamName @('variant', 'variants', 'variantId', 'variantIds') $VariantParamName 'variant'
    if (-not $variantParam) {
        Add-Assertion 'P3 param:variant' $false "case.run 自描述里没有变体选择参数（B3 需要按变体单跑）"
    } else {
        Add-Assertion 'P3 param:variant' $true "变体参数 = $variantParam"
    }

    function New-CaseRunParams($Extra) {
        $p = @{ $fileParam = $casePath }
        if ($Extra) { foreach ($k in $Extra.Keys) { $p[$k] = $Extra[$k] } }
        [void](Add-StepTimeouts $p 'case.run' $CaseTimeoutMs $ActionTimeoutMs)
        return ($p | ConvertTo-Json -Compress -Depth 10)
    }

    # -----------------------------------------------------------------------
    # B1 整跑（forensic）：退出码 0 + overall green
    # -----------------------------------------------------------------------
    Write-Step "B1 case.run 整跑（--tier forensic --sync，超时 $([int]($CaseTimeoutMs / 1000)) s）"
    $b1 = Invoke-Caller -Action 'case.run' -ParamsJson (New-CaseRunParams $null) -Label 'B1-run-full' -Tier 'forensic' -Sync -TimeoutMs $CaseTimeoutMs
    Add-Assertion 'B1 case.run(forensic,整跑)' ($b1.code -eq 0) "退出码 $($b1.code)（0=done）"
    $b1Result = Get-JsonProp $b1.json 'result'
    $b1Overall = [string](Get-JsonProp $b1Result 'overall')
    Add-Assertion 'B1b result.overall=green' ($b1Overall -eq 'green') "overall=$b1Overall"
    $b1RunDir = Resolve-RunDir $b1.json $b1.newRuns
    if ($b1RunDir) { Write-Ok "run 目录: $b1RunDir" } else { Write-Err2 "定位不到整跑的 run 目录" }

    $b1Shots = Get-JsonProp $b1Result 'shots'
    if ($b1Shots) {
        $camCount = [int](Get-JsonProp $b1Shots 'cameraCount')
        $shotCount = [int](Get-JsonProp $b1Shots 'shotCount')
        $failed = [int](Get-JsonProp $b1Shots 'failedCount')
        Add-Assertion 'B1c 机位数/失败数' (($camCount -eq $caseCameras.Count) -and ($failed -eq 0)) `
            "cameraCount=$camCount（期望 $($caseCameras.Count)）shotCount=$shotCount failedCount=$failed"
    } else {
        Add-Assertion 'B1c 机位数/失败数' $false "作业结果里没有 shots 段（case.run 未走拍摄路径？）"
    }

    # -----------------------------------------------------------------------
    # B2 run 产物自证：criteria 全绿全覆盖 / 证据齐全 / 门控位置分离 / cameras 摘要
    # -----------------------------------------------------------------------
    Write-Step "B2 run 产物自证"
    $b1Criteria = Get-CriteriaDoc $b1RunDir
    $b1Map = Get-VerdictMap $b1Criteria
    if ($null -eq $b1Criteria) {
        Add-Assertion 'B2a criteria.json 全绿且覆盖全部判据' $false "run 目录里没有 criteria.json（$b1RunDir）"
    } else {
        $notGreen = @($b1Map.GetEnumerator() | Where-Object { $_.Value -ne 'green' } | ForEach-Object { "$($_.Key)=$($_.Value)" })
        $missingIds = @($caseCriteriaIds | Where-Object { -not $b1Map.ContainsKey($_) })
        $ok = ($b1Criteria.overall -eq 'green') -and ($notGreen.Count -eq 0) -and ($missingIds.Count -eq 0)
        Add-Assertion 'B2a criteria.json 全绿且覆盖全部判据' $ok `
            ("overall={0} counts={1} 非绿=[{2}] 缺判据=[{3}]" -f $b1Criteria.overall, ($b1Criteria.counts | ConvertTo-Json -Compress), ($notGreen -join ','), ($missingIds -join ','))
    }

    $b1Evidence = Get-RunFile $b1RunDir 'evidence.json'
    if ($null -eq $b1Evidence) {
        Add-Assertion 'B2b evidence-complete 绿' $false "run 目录里没有 evidence.json（runDir=$b1RunDir）"
    } else {
        $evVerdict = [string](Get-JsonProp $b1Evidence 'overall')
        $missingEv = @()
        $presentEv = 0
        foreach ($e in @((Get-JsonProp $b1Evidence 'expect'))) {
            $rel = [string](Get-JsonProp $e 'path')
            if ([string]::IsNullOrWhiteSpace($rel)) { continue }
            if (Test-Path (Join-Path $b1RunDir ($rel -replace '/', '\'))) { $presentEv++ } else { $missingEv += $rel }
        }
        Add-Assertion 'B2b evidence-complete 绿' (($evVerdict -eq 'green') -and ($missingEv.Count -eq 0)) `
            ("evidence.json overall={0}；期望证据 {1} 项在场，缺=[{2}]" -f $evVerdict, $presentEv, ($missingEv -join ','))
    }

    $obs = Get-RunFile $b1RunDir 'observation.json'
    if ($null -eq $obs) {
        Add-Assertion 'B2c observation.camera.mode=injected' $false "run 目录里没有 observation.json（runDir=$b1RunDir）"
        Add-Assertion 'B2d 门控位置分离' $false 'observation.json 缺失'
        Add-Assertion 'B2e cameras[] 摘要' $false 'observation.json 缺失'
    } else {
        $camMode = [string](Resolve-JsonPointer $obs '/observation/camera/mode')
        Add-Assertion 'B2c observation.camera.mode=injected' ($camMode -eq 'injected') "mode=$camMode（判据 observation-camera-injected 的同一指针）"

        $playerPos = Resolve-JsonPointer $obs '/observation/playerPos'
        $cameraPos = Resolve-JsonPointer $obs '/observation/camera/pos'
        if ($null -eq $playerPos -or $null -eq $cameraPos) {
            Add-Assertion 'B2d 门控位置分离' $false "playerPos=$($playerPos | ConvertTo-Json -Compress) camera.pos=$($cameraPos | ConvertTo-Json -Compress)"
        } else {
            $pa = @($playerPos); $ca = @($cameraPos)
            $delta = 0.0
            for ($i = 0; $i -lt 3; $i++) { $delta = [math]::Max($delta, [math]::Abs([double]$pa[$i] - [double]$ca[$i])) }
            Add-Assertion 'B2d 门控位置分离' ($delta -gt 0.5) `
                ("playerPos=[{0}] camera.pos=[{1}] 最大轴差={2:N3}（须 >0.5：两者各自记录）" -f ($pa -join ','), ($ca -join ','), $delta)
        }

        $obsCams = @(Resolve-JsonPointer $obs '/observation/cameras')
        $obsNames = @($obsCams | ForEach-Object { [string]$_.name })
        $wantNames = @($caseCameras | ForEach-Object { $_.name })
        $namesOk = (($obsNames -join ',') -eq ($wantNames -join ','))
        $cameraCountObs = Resolve-JsonPointer $obs '/observation/cameraCount'
        Add-Assertion 'B2e cameras[] 摘要' ($obsCams.Count -eq $caseCameras.Count -and $namesOk) `
            ("observation.cameras={0} 个 [{1}]（期望 {2} 个 [{3}]）cameraCount={4}" -f `
                $obsCams.Count, ($obsNames -join ','), $caseCameras.Count, ($wantNames -join ','), $cameraCountObs)
    }

    # -----------------------------------------------------------------------
    # B3 负对照变体单跑：退出码 0 且 expectCriteriaRed 全红
    # -----------------------------------------------------------------------
    Write-Step "B3 负对照变体单跑（variant=$($caseVariant.id)）"
    if (-not $variantParam) {
        Add-Assertion 'B3 负对照变体' $false '自描述无变体选择参数，无法单跑变体'
    } else {
        $variantId = [string]$caseVariant.id
        $redIds = @($caseVariant.expectCriteriaRed | ForEach-Object { [string]$_ })
        $b3 = Invoke-Caller -Action 'case.run' -ParamsJson (New-CaseRunParams @{ $variantParam = $variantId }) -Label 'B3-run-variant' -Tier 'forensic' -Sync -TimeoutMs $CaseTimeoutMs
        Add-Assertion 'B3a 变体跑退出码 0' ($b3.code -eq 0) "退出码 $($b3.code)；变体 $variantId expectCriteriaRed=[$($redIds -join ',')]"

        $b3Result = Get-JsonProp $b3.json 'result'
        $b3Verify = Get-JsonProp $b3Result 'variantVerification'
        if ($b3Verify) {
            $okV = [bool](Get-JsonProp $b3Verify 'ok')
            Add-Assertion 'B3b variantVerification.ok' $okV ("ok={0} actual={1} notRed=[{2}] missing=[{3}]" -f `
                    $okV, ((Get-JsonProp $b3Verify 'actual') | ConvertTo-Json -Compress), (@(Get-JsonProp $b3Verify 'notRed') -join ','), (@(Get-JsonProp $b3Verify 'missing') -join ','))
        } else {
            Add-Assertion 'B3b variantVerification.ok' $false '作业结果里没有 variantVerification'
        }

        $b3RunDir = Resolve-RunDir $b3.json $b3.newRuns
        $b3Criteria = Get-CriteriaDoc $b3RunDir
        if ($null -eq $b3Criteria) {
            Add-Assertion 'B3c 期望判据全红' $false "变体 run 目录里没有 criteria.json（$b3RunDir）"
        } else {
            $b3Map = Get-VerdictMap $b3Criteria
            $notRed = @($redIds | Where-Object { $b3Map[$_] -ne 'red' } | ForEach-Object { "$_=$($b3Map[$_])" })
            Add-Assertion 'B3c 期望判据全红' ($notRed.Count -eq 0) ("expectCriteriaRed 未变红=[{0}]；变体 run 判据: {1}" -f ($notRed -join ','), (Format-VerdictMap $b3Map))
            $otherRed = @($b3Map.GetEnumerator() | Where-Object { $redIds -notcontains $_.Key -and $_.Value -ne 'green' } | ForEach-Object { "$($_.Key)=$($_.Value)" })
            Add-Assertion 'B3d 负对照精确命中' ($otherRed.Count -eq 0) ("除 expectCriteriaRed 外的非绿=[{0}]（负对照只该改动目标判据）" -f ($otherRed -join ','))
        }
    }

    # -----------------------------------------------------------------------
    # B4 捕获会话门控：begin → 世界写被拒 CP-STATE-001 → end → 重建成功
    # -----------------------------------------------------------------------
    Write-Step "B4 捕获会话门控（capture.begin / world.rebuild / capture.end）"
    $rebuildParams = @{
        folder      = [string](Get-JsonProp $caseWorld 'folder')
        seed        = [long](Get-JsonProp $caseWorld 'seed')
        void        = [bool](Get-JsonProp $caseWorld 'void')
        base        = @(Get-JsonProp $caseWorld 'base')
        settleTicks = [int](Get-JsonProp $caseWorld 'settleTicks')
        build       = @(Get-JsonProp $caseDoc 'build')
    }
    $rebuildJson = (Add-StepTimeouts $rebuildParams 'world.rebuild' $ActionTimeoutMs $ActionTimeoutMs | ConvertTo-Json -Compress -Depth 10)

    $capBegin = Invoke-Caller -Action 'capture.begin' -ParamsJson '{}' -Label 'B4-capture-begin' -Sync -TimeoutMs 60000
    Add-Assertion 'B4a capture.begin' ($capBegin.code -eq 0) "退出码 $($capBegin.code)"

    $rebuildBlocked = Invoke-Caller -Action 'world.rebuild' -ParamsJson $rebuildJson -Label 'B4-rebuild-blocked' -Sync -TimeoutMs $ActionTimeoutMs
    $blockedCode = ''
    if ($rebuildBlocked.json -and $rebuildBlocked.json.error) { $blockedCode = [string]$rebuildBlocked.json.error.code }
    Add-Assertion 'B4b 会话期间世界写被拒' (($rebuildBlocked.code -ne 0) -and ($blockedCode -eq 'CP-STATE-001')) `
        ("退出码 {0}（应非 0）error.code={1}（应 CP-STATE-001）" -f $rebuildBlocked.code, $blockedCode)

    $capEnd = Invoke-Caller -Action 'capture.end' -ParamsJson '{}' -Label 'B4-capture-end' -Sync -TimeoutMs 60000
    $capEndWasArmed = $null
    if ($capEnd.json -and $capEnd.json.result) { $capEndWasArmed = Get-JsonProp $capEnd.json.result 'wasArmed' }
    Add-Assertion 'B4c capture.end 释放会话' (($capEnd.code -eq 0) -and ($capEndWasArmed -eq $true)) `
        ("退出码 {0}；wasArmed={1}（须 true：确实释放了一个会话）" -f $capEnd.code, $capEndWasArmed)

    $rebuildOk = Invoke-Caller -Action 'world.rebuild' -ParamsJson $rebuildJson -Label 'B4-rebuild-ok' -Sync -TimeoutMs $ActionTimeoutMs
    $rebuildOkScene = Get-JsonProp (Get-JsonProp $rebuildOk.json 'result') 'scene'
    $rebuildOkSha = [string](Get-JsonProp $rebuildOkScene 'sha256')
    Add-Assertion 'B4d 会话结束后重建成功' (($rebuildOk.code -eq 0) -and (-not [string]::IsNullOrWhiteSpace($rebuildOkSha))) `
        ("退出码 {0}；scene.sha256={1}" -f $rebuildOk.code, $rebuildOkSha)
    Write-Info ("场景哈希对照：B1 case.run scene.sha256={0} / B4d world.rebuild scene.sha256={1}" -f `
            [string](Get-JsonProp (Get-JsonProp $b1Result 'scene') 'sha256'), $rebuildOkSha)

    # -----------------------------------------------------------------------
    # B5 权限按内容升格：含 cameras 段的 case.run 用 scene 级 → HTTP 403 CP-AUTH-002
    # -----------------------------------------------------------------------
    Write-Step "B5 含 cameras 段的 case.run 用 --tier scene（预期 HTTP 403 CP-AUTH-002）"
    $b5 = Invoke-Caller -Action 'case.run' -ParamsJson (New-CaseRunParams $null) -Label 'B5-scene-tier' -Tier 'scene' -Sync -TimeoutMs 120000
    $b5Code = ''
    $b5Http = ''
    if ($b5.json) {
        if ($b5.json.error) { $b5Code = [string]$b5.json.error.code }
        $b5Http = [string]$b5.json.httpStatus
    }
    Add-Assertion 'B5 权限按内容升格' (($b5.code -ne 0) -and ($b5Code -eq 'CP-AUTH-002') -and ($b5Http -eq '403')) `
        ("退出码 {0}（应非 0）httpStatus={1}（应 403）error.code={2}（应 CP-AUTH-002）" -f $b5.code, $b5Http, $b5Code)

    # -----------------------------------------------------------------------
    # B6 截图产物与渲染留痕（在 B1 的 run 目录上核对）
    # -----------------------------------------------------------------------
    Write-Step "B6 截图产物与渲染留痕"
    if (-not $b1RunDir) {
        Add-Assertion 'B6a 机位 PNG 存在且非空' $false 'B1 run 目录未定位'
        Add-Assertion 'B6b meta.json 渲染留痕' $false 'B1 run 目录未定位'
        Add-Assertion 'B6c PNG 实读尺寸' $false 'B1 run 目录未定位'
        Add-Assertion 'B6d tiles 片数' $false 'B1 run 目录未定位'
        Add-Assertion 'B6e tiles 单片命名' $false 'B1 run 目录未定位'
    } else {
        $shotsDir = Join-Path $b1RunDir 'shots'
        if ($caseCameras.Count -eq 0) {
            # 用例读不到/cameras 为空时 foreach 一次不进会全绿——显式兜底
            Add-Assertion 'B6a 机位 PNG 存在且非空' $false '用例 cameras 表为空（case 读取失败？），B6 系列无对象可核'
            Add-Assertion 'B6b meta.json 渲染留痕' $false '同上'
            Add-Assertion 'B6c PNG 实读尺寸' $false '同上'
            Add-Assertion 'B6d tiles 片数' $false '同上'
            Add-Assertion 'B6e tiles 单片命名' $false '同上'
        } else {
        $pngProblems = @()
        $metaProblems = @()
        $sizeProblems = @()
        $tileProblems = @()
        $nameProblems = @()
        $tiledDetail = @()

        foreach ($cam in $caseCameras) {
            $png = Join-Path $shotsDir ("{0}.png" -f $cam.name)
            $meta = Join-Path $shotsDir ("{0}.meta.json" -f $cam.name)

            if (-not (Test-Path $png -PathType Leaf)) { $pngProblems += "$($cam.name).png 缺失"; $sizeProblems += "$($cam.name).png 缺失（无法实读尺寸）" }
            elseif ((Get-Item $png).Length -le 0) { $pngProblems += "$($cam.name).png 为 0 字节"; $sizeProblems += "$($cam.name).png 为 0 字节" }

            if (-not (Test-Path $meta -PathType Leaf)) {
                $metaProblems += "$($cam.name).meta.json 缺失"
                if ($cam.tiled) { $tileProblems += "$($cam.name).meta.json 缺失（无法核验片数）"; $nameProblems += "$($cam.name).meta.json 缺失（无法核验命名）" }
            } else {
                $m = Read-JsonFile $meta
                if ($null -eq $m) { $metaProblems += "$($cam.name).meta.json 不是合法 JSON" }
                else {
                    if ((Get-JsonProp $m 'cameraHeldDuringRender') -ne $true) { $metaProblems += "$($cam.name).cameraHeldDuringRender=$((Get-JsonProp $m 'cameraHeldDuringRender'))（须 true）" }
                    $res = @(Get-JsonProp $m 'resolution')
                    if (@($res).Count -ne 2 -or [int]$res[0] -ne $cam.width -or [int]$res[1] -ne $cam.height) {
                        $metaProblems += "$($cam.name).resolution=[$(@($res) -join ',')]（须 [$($cam.width),$($cam.height)]）"
                    }
                    $reqRes = @(Get-JsonProp $m 'requestedResolution')
                    if (@($reqRes).Count -eq 2 -and ([int]$reqRes[0] -ne $cam.width -or [int]$reqRes[1] -ne $cam.height)) {
                        $metaProblems += "$($cam.name).requestedResolution=[$(@($reqRes) -join ',')]（声明 [$($cam.width),$($cam.height)]）"
                    }

                    if ($cam.tiled) {
                        $tile = Get-JsonProp $m 'tile'
                        $cols = [int](Get-JsonProp $tile 'cols')
                        $rows = [int](Get-JsonProp $tile 'rows')
                        $reqCols = [int](Get-JsonProp $tile 'requestedCols')
                        $reqRows = [int](Get-JsonProp $tile 'requestedRows')
                        $tilesDir = Join-Path $shotsDir ("{0}.tiles" -f $cam.name)
                        if (-not (Test-Path $tilesDir -PathType Container)) {
                            $tileProblems += "$($cam.name).tiles/ 目录缺失（声明 tile）"
                        } else {
                            $tileFiles = @(Get-ChildItem -File $tilesDir -Filter '*.png' -ErrorAction SilentlyContinue)
                            $expectCount = $cols * $rows
                            if ($tileFiles.Count -ne $expectCount) {
                                $tileProblems += "$($cam.name).tiles/ 片数 $($tileFiles.Count) != tile.cols×rows=$cols×$rows=$expectCount"
                            }
                            # 单片实际命名（ShotExecutor.tileName：r<row>c<col>.png，1 起）
                            $expectNames = @()
                            for ($r = 1; $r -le $rows; $r++) { for ($c = 1; $c -le $cols; $c++) { $expectNames += "r${r}c${c}.png" } }
                            $actualNames = @($tileFiles | ForEach-Object { $_.Name } | Sort-Object)
                            $wantNames = @($expectNames | Sort-Object)
                            if (($actualNames -join ',') -ne ($wantNames -join ',')) {
                                $nameProblems += "$($cam.name).tiles/ 命名不符：实际=[$($actualNames -join ',')] 期望=[$($wantNames -join ',')]"
                            }
                            $zero = @($tileFiles | Where-Object { $_.Length -le 0 } | ForEach-Object { $_.Name })
                            if ($zero.Count -gt 0) { $nameProblems += "$($cam.name).tiles/ 存在 0 字节片: $($zero -join ',')" }
                        }
                        $tiledDetail += ("{0}: 实际网格 {1}x{2}（声明 {3}x{4}）" -f $cam.name, $cols, $rows, $reqCols, $reqRows)
                    }

                    # 独立实读 PNG 头：判据 image-size-equals 的同一口径，绕开 meta 自证
                    $sz = Get-PngSize $png
                    if ($null -eq $sz) { $sizeProblems += "$($cam.name).png 不是可读 PNG（头解析失败）" }
                    elseif ($sz.width -ne $cam.width -or $sz.height -ne $cam.height) {
                        $sizeProblems += "$($cam.name).png 实读 $(Format-Size $sz.width $sz.height) != 声明 $(Format-Size $cam.width $cam.height)"
                    }
                }
            }
        }

        # shots/ 下的全部 PNG（含拼接中间帧）都必须非空
        $allShots = @()
        if (Test-Path $shotsDir) { $allShots = @(Get-ChildItem -Recurse -File $shotsDir -Filter '*.png' -ErrorAction SilentlyContinue) }
        $emptyShots = @($allShots | Where-Object { $_.Length -le 0 } | ForEach-Object { $_.Name })

        Add-Assertion 'B6a 机位 PNG 存在且非空' ($pngProblems.Count -eq 0) $(if ($pngProblems.Count -eq 0) { "$($caseCameras.Count) 机位 PNG 就位；shots/ 下 PNG 共 $($allShots.Count) 个，0 字节 $($emptyShots.Count) 个" } else { $pngProblems -join '; ' })
        Add-Assertion 'B6b meta.json 渲染留痕' ($metaProblems.Count -eq 0) $(if ($metaProblems.Count -eq 0) { 'cameraHeldDuringRender=true 且 resolution/requestedResolution 与用例声明一致' } else { $metaProblems -join '; ' })
        Add-Assertion 'B6c PNG 实读尺寸' ($sizeProblems.Count -eq 0) $(if ($sizeProblems.Count -eq 0) { '三张整图 PNG 头实读尺寸 == 声明（独立于 meta 自证）' } else { $sizeProblems -join '; ' })
        Add-Assertion 'B6d 拼接片数' ($tileProblems.Count -eq 0) $(if ($tileProblems.Count -eq 0) { ("tiles/ 片数 == meta.tile.cols×rows；{0}" -f ($tiledDetail -join '；')) } else { $tileProblems -join '; ' })
        Add-Assertion 'B6e 拼接片命名' ($nameProblems.Count -eq 0) $(if ($nameProblems.Count -eq 0) { '单片命名 == r<row>c<col>.png（ShotExecutor.tileName，1 起）' } else { $nameProblems -join '; ' })
        }
    }

    # -----------------------------------------------------------------------
    # B7 收尾无残留：世界仍在 + caller 直接再拍一张 persp-main
    # -----------------------------------------------------------------------
    Write-Step "B7 收尾无残留（core.status + 再拍 persp-main）"
    $status = Invoke-Caller -Action 'core.status' -Label 'B7-status' -TimeoutMs 30000
    $statusResult = Get-JsonProp $status.json 'result'
    $statusWorld = Get-JsonProp $statusResult 'world'
    $statusLoaded = Get-JsonProp $statusWorld 'loaded'
    $statusManaged = Get-JsonProp $statusWorld 'managed'
    Add-Assertion 'B7a core.status 世界仍在' (($status.code -eq 0) -and ($statusLoaded -eq $true) -and ($statusManaged -eq $true)) `
        ("退出码 {0}；world.loaded={1} world.managed={2} folder={3}" -f $status.code, $statusLoaded, $statusManaged, (Get-JsonProp $statusWorld 'folder'))

    $mainCam = @($caseCameras | Where-Object { $_.name -eq 'persp-main' })[0]
    if ($null -eq $mainCam) {
        Add-Assertion 'B7b 再拍 persp-main' $false '用例里没有 persp-main 机位，无法做收尾复拍'
    } else {
        $reshotParams = @{ cameras = @($mainCam.spec) }
        $capSpec = Get-JsonProp $caseDoc 'capture'
        if ($capSpec) { $reshotParams['capture'] = $capSpec }
        [void](Add-StepTimeouts $reshotParams 'shot.multi' $ActionTimeoutMs $ActionTimeoutMs)
        $reshot = Invoke-Caller -Action 'shot.multi' -ParamsJson ($reshotParams | ConvertTo-Json -Compress -Depth 10) -Label 'B7-reshot' -Sync -TimeoutMs $ActionTimeoutMs
        $reshotResult = Get-JsonProp $reshot.json 'result'
        $settingsRestored = Get-JsonProp $reshotResult 'settingsRestored'
        Add-Assertion 'B7b 再拍 persp-main' (($reshot.code -eq 0) -and ($settingsRestored -eq $true)) `
            ("退出码 {0}；settingsRestored={1}（须 true）baseDisplay={2}x{3}" -f $reshot.code, $settingsRestored, (Get-JsonProp $reshotResult 'baseDisplayWidth'), (Get-JsonProp $reshotResult 'baseDisplayHeight'))

        $reshotRunDir = Resolve-RunDir $reshot.json $reshot.newRuns
        $reshotProblems = @()
        if (-not $reshotRunDir) { $reshotProblems += 'run 目录未定位' }
        else {
            $rp = Join-Path $reshotRunDir 'shots\persp-main.png'
            $rm = Join-Path $reshotRunDir 'shots\persp-main.meta.json'
            $sz = Get-PngSize $rp
            if ($null -eq $sz) { $reshotProblems += 'shots/persp-main.png 缺失或不可读' }
            elseif ($sz.width -ne $mainCam.width -or $sz.height -ne $mainCam.height) {
                $reshotProblems += "实读尺寸 $(Format-Size $sz.width $sz.height) != 声明 $(Format-Size $mainCam.width $mainCam.height)"
            }
            $rmDoc = Read-JsonFile $rm
            if ($null -eq $rmDoc) { $reshotProblems += 'shots/persp-main.meta.json 缺失或非法' }
            elseif ((Get-JsonProp $rmDoc 'cameraHeldDuringRender') -ne $true) { $reshotProblems += "cameraHeldDuringRender=$((Get-JsonProp $rmDoc 'cameraHeldDuringRender'))" }
            else {
                # 最强的一条「无残留」证据：本次拍摄开始时读到的真实窗口尺寸（meta.baseDisplay）
                # 必须仍是本次会话的原始窗口，而不是上一轮拍摄留下的 framebuffer 尺寸
                $rBase = @(Get-JsonProp $rmDoc 'baseDisplay')
                $obsDwMeta = Resolve-JsonPointer $obs '/clientConfig/displayWidth'
                $obsDhMeta = Resolve-JsonPointer $obs '/clientConfig/displayHeight'
                if (@($rBase).Count -eq 2 -and $null -ne $obsDwMeta) {
                    if ([int]$rBase[0] -ne [int]$obsDwMeta -or [int]$rBase[1] -ne [int]$obsDhMeta) {
                        $reshotProblems += "复拍 meta.baseDisplay=[$(@($rBase) -join ',')] 与 observation.clientConfig=[$obsDwMeta,$obsDhMeta] 不一致（上一次拍摄的 framebuffer 尺寸没还原？）"
                    }
                }
            }
        }
        # 真实窗口尺寸是否还原：与 observation 里的 clientConfig 对照
        if ($obs) {
            $obsDw = Resolve-JsonPointer $obs '/clientConfig/displayWidth'
            $obsDh = Resolve-JsonPointer $obs '/clientConfig/displayHeight'
            $rdw = Get-JsonProp $reshotResult 'baseDisplayWidth'
            $rdh = Get-JsonProp $reshotResult 'baseDisplayHeight'
            if ($null -ne $obsDw -and $null -ne $rdw -and ([int]$obsDw -ne [int]$rdw -or [int]$obsDh -ne [int]$rdh)) {
                $reshotProblems += "复拍记录的 baseDisplay=$rdw`x$rdh 与 observation.clientConfig=$obsDw`x$obsDh 不一致（真实窗口尺寸未还原？）"
            }
        }
        Add-Assertion 'B7c 复拍产物/留痕' ($reshotProblems.Count -eq 0) $(if ($reshotProblems.Count -eq 0) { "复拍 run=$reshotRunDir，尺寸与留痕正确（投影/分辨率/renderViewEntity 无残留）" } else { $reshotProblems -join '; ' })
    }
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
    # 收尾：停客户端 → 还原配置 → 归档（含全部 shots PNG 原图）→ 红绿表
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

        # 截图原图平铺一份：验收时直接当 Gitea 附件（run 目录里的 shots/ 同时保留）
        New-Item -ItemType Directory -Force -Path $flatShotsDir | Out-Null
        $flatCount = 0
        foreach ($d in $createdRuns) {
            $sd = Join-Path $d 'shots'
            if (-not (Test-Path $sd)) { continue }
            $runName = Split-Path $d -Leaf
            foreach ($f in @(Get-ChildItem -Recurse -File $sd -Filter '*.png' -ErrorAction SilentlyContinue)) {
                $rel = $f.FullName.Substring($sd.Length).TrimStart('\') -replace '\\', '/'
                $flatName = "{0}__{1}" -f $runName, ($rel -replace '/', '__')
                Copy-Item -Force $f.FullName (Join-Path $flatShotsDir $flatName)
                $flatCount++
            }
        }
        if ($flatCount -gt 0) { Write-Ok "截图原图平铺归档: $flatShotsDir（$flatCount 个 PNG）" }
        else { Write-Warn2 "本次没有可平铺的截图 PNG" }

        if (Test-Path $eventsFile) { Copy-Item -Force $eventsFile (Join-Path $archiveDir 'events.jsonl'); Write-Ok "events.jsonl 已归档" }
        else { Write-Warn2 "找不到 events.jsonl（$eventsFile）" }
        if (Test-Path $clientLog) { Copy-Item -Force $clientLog (Join-Path $logDir 'fml-client-latest.log'); Write-Ok "客户端日志已归档" }
        if (Test-Path $cfgPath) { Copy-Item -Force $cfgPath (Join-Path $archiveDir 'lightning.cfg.after') }

        # 每个 run 的判据结论摘要（人读）
        $lines = New-Object System.Collections.ArrayList
        [void]$lines.Add("# 控制面 PR-2 取证拍摄验收 $ts")
        [void]$lines.Add('')
        [void]$lines.Add("- 用例文件: ``$casePath``")
        [void]$lines.Add("- mcDataDir: ``$mcDataDir``")
        [void]$lines.Add("- 客户端复用: $([bool]$SkipClientStart)；保留客户端: $([bool]$KeepClient)；runClient25: $modernJdk")
        [void]$lines.Add("- 归档 run 目录: $($createdRuns.Count) 个")
        [void]$lines.Add('')
        foreach ($d in $createdRuns) {
            if (-not (Test-Path $d)) { continue }
            $doc = Get-CriteriaDoc $d
            if ($null -eq $doc) { continue }
            [void]$lines.Add("## $(Split-Path $d -Leaf)")
            [void]$lines.Add('')
            [void]$lines.Add("overall=$($doc.overall) counts=$($doc.counts | ConvertTo-Json -Compress)")
            [void]$lines.Add('')
            [void]$lines.Add('| 判据 | 结论 | 说明 |')
            [void]$lines.Add('|---|---|---|')
            foreach ($c in @($doc.criteria)) {
                [void]$lines.Add("| $($c.id) | $($c.verdict) | $(([string]$c.detail) -replace '\|', '\|') |")
            }
            [void]$lines.Add('')
        }
        [void]$lines.Add('## 断言表')
        [void]$lines.Add('')
        [void]$lines.Add('| 断言 | 结果 | 说明 |')
        [void]$lines.Add('|---|---|---|')
        foreach ($a in $assertions) { [void]$lines.Add("| $($a.name) | $(if ($a.ok) { 'PASS' } else { 'FAIL' }) | $($a.detail -replace '\|', '\|') |") }
        [void]($lines | Set-Content -Path (Join-Path $archiveDir 'summary.md') -Encoding utf8NoBOM)

        [void]($assertions | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $archiveDir 'assertions.json') -Encoding utf8NoBOM)

        # 本次会话的机位清单与判据清单（机读，便于附件说明）
        $meta = [pscustomobject]@{
            ts          = $ts
            caseFile    = $casePath
            caseId      = [string]$caseDoc.id
            mcDataDir   = $mcDataDir
            cameras     = @($caseCameras | ForEach-Object { "$($_.name):$(Format-Size $_.width $_.height):$($_.projection)" })
            criteriaIds = @($caseCriteriaIds)
            runDirs     = @($createdRuns | ForEach-Object { Split-Path $_ -Leaf })
            flatShots   = $flatCount
        }
        [void]($meta | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $archiveDir 'session.json') -Encoding utf8NoBOM)
        Write-Ok "断言表: $archiveDir\assertions.json / summary.md / session.json"
    } catch { Write-Warn2 "归档失败: $($_.Exception.Message)" }

    Write-Host ""
    Write-Host "== [CP-SHOTS] 断言红绿表" -ForegroundColor Cyan
    foreach ($a in $assertions) {
        $mark = if ($a.ok) { 'PASS' } else { 'FAIL' }
        $color = if ($a.ok) { 'Green' } else { 'Red' }
        Write-Host ("   [{0}] {1,-34} {2}" -f $mark, $a.name, $a.detail) -ForegroundColor $color
    }
    $failed = @($assertions | Where-Object { -not $_.ok })
    Write-Host ""
    Write-Host "   归档: $archiveDir"
    Write-Host ("   总计: {0} 条断言，{1} 红" -f $assertions.Count, $failed.Count)
}

$fatal = if ($script:fatalCode -gt 0) { $script:fatalCode } else { 0 }
$failedCount = @($assertions | Where-Object { -not $_.ok }).Count
if ($fatal -gt 0) {
    Write-Host "== [CP-SHOTS] 管线级致命（退出码 $fatal）" -ForegroundColor Red
    exit $fatal
}
if ($failedCount -gt 0) {
    Write-Host "== [CP-SHOTS] 有 $failedCount 条断言红（退出码 2）：原因见红绿表与归档" -ForegroundColor Red
    exit 2
}
Write-Host "== [CP-SHOTS] PR-2 取证拍摄验收全绿（退出码 0）" -ForegroundColor Green
exit 0

