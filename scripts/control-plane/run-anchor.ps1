<#
  契约 1.2 锚点验收驱动（无人值守）—— contract.md §10 第 5 条/第 6 条 + case-file.md §5/§8 的端到端验收
  ============================================================================
  与 run-shots.ps1（契约 1.1）同风格、同退出码、同归档骨架；差异只在用例集（两个锚点）、断言集
  （C1..C7）与新增的离线静态检查（C2）与独立复算（C4）。

  验收对象：
    test/cases/anchor/lp-pipe-row.json   LP 四管横排（裸管 / 两管互联 / 管+箱）——运行期轨 + 图像轨双轨齐备
    test/cases/anchor/ae2-parts.json     AE2 缆块 + 部件（中心缆/切换总线/存储总线）——双轨 + K1 三十格距离门远机位对照

  流程：前置检查（gradlew / web/node_modules / 两个用例文件 / 端口）→ 写 run/client/config/lightning.cfg
  （controlplane.enabled=true，原值备份）→ Start-Process 启动客户端（默认 runClient25，可用
  -LegacyJdk 退回 runClientSdePipeline）→ 轮询 server.json → 依次断言：

    C1 两用例整跑（--tier forensic --sync）   退出码 0、result.overall=green、run 的 criteria.json
                                            全绿且覆盖用例声明的全部判据 id（两条独立用例）
    C2 双轨齐备静态检查（离线）                两个用例文件里每个 te-state-equals 判据都有同目标的图像判据
                                            （用法见 README §1 的 run-anchor.ps1 条目），缺失即红；不需要客户端
    C3 负对照变体单跑                          两用例各跑 variant：退出码 0、variantVerification.ok=true、
                                            expectCriteriaRed 精确判红（其余判据保持绿——run-shots B3d 口径）
    C4 K1 门控                                 ae2 run：near/ortho 图 image-not-uniform=green 且非空、
                                            far 图 image-uniform=green 且非空（相机在 30 格距离门外）；
                                            另独立复算 far.png 主色占比 ≥ 判据 minSameColorRatio
                                            （自己解 PNG，与判据同口径但不共用实现）
    C5 幂等                                    lp-pipe-row 连跑两次（两个 runId）：
                                            world/scene-manifest.json 的 sha256 相等；两次 run 的
                                            world-hash-equals 判据均绿
    C6 证据齐全                                两用例 run 的 evidence.json overall=green 且期望证据逐条在场
    C7 观测记录                                两用例 run 的 observation.json：runtimeReads 里存在
                                            「te.lp-pipe[」/「te.ae2-part[」条目且 sha256 非空；
                                            observation.cameras 摘要与用例机位表逐项一致

  收尾：停客户端 → 还原 lightning.cfg → 归档（run 目录 + shots-flat 平铺 + events + 日志 +
  assertions/summary/session）→ 打印红绿表与归档路径。

  用法：
    pwsh -File scripts/control-plane/run-anchor.ps1
    pwsh -File scripts/control-plane/run-anchor.ps1 -SkipClientStart    # 复用已在跑的客户端
    pwsh -File scripts/control-plane/run-anchor.ps1 -KeepClient         # 跑完不停客户端
    pwsh -File scripts/control-plane/run-anchor.ps1 -ChecksOnly         # 只跑离线检查（C2 + 复算器自检）
    pwsh -File scripts/control-plane/run-anchor.ps1 -LegacyJdk          # 退回 runClientSdePipeline

  退出码：0 = 全绿；2 = 有断言红；3 = 管线级致命（server.json 超时/客户端早退）；
          4 = 前置检查或编排自身失败。

  纪律：runClient 是独占资源（Gradle 锁 + 端口 + 世界存档），用前必须先申请独占窗口，一次只跑一个。
#>
[CmdletBinding()]
param(
    # LP 锚点用例（默认 <repo>\test\cases\anchor\lp-pipe-row.json）
    [string]$LpCaseFile = '',
    # AE2 锚点用例（默认 <repo>\test\cases\anchor\ae2-parts.json）
    [string]$Ae2CaseFile = '',
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
    # 用 runClient25（lwjgl3ify 现代 JVM）：**默认开**；本开关保留只为与 run-smoke/run-shots 写法兼容
    [switch]$UseModernJdk,
    # 退回 runClientSdePipeline（旧 JDK 通道）；与默认（现代 JVM）互斥，给了它就以它为准
    [switch]$LegacyJdk,
    # 只跑离线检查（C2 + 复算器自检）：不需要客户端，也不起客户端
    [switch]$ChecksOnly,
    # server.json 等待上限（分钟）
    [int]$ClientReadyTimeoutMin = 5,
    # 单次 case.run 的总超时（毫秒）
    [int]$CaseTimeoutMs = 900000,
    # 单次 world.rebuild / shot.multi 的总超时（毫秒）
    [int]$ActionTimeoutMs = 600000,
    # 归档根目录（缺省 = 本脚本目录下被 .gitignore 忽略的 .out；显式给参数则以参数为准）
    [string]$ArchiveRoot = '',
    # 参数名覆盖（默认从 case.run 自描述里探测；探测失败才需要显式给）
    [string]$FileParamName = '',
    [string]$VariantParamName = ''
)

$ErrorActionPreference = 'Stop'
# 原生命令写 stderr 不应触发 Stop（PS 7.4+ 的行为开关）
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

# 纯检查模块（读文档/比数值/判红绿；无 HTTP、无世界、无归档）——同一份逻辑被本驱动与
# run-anchor-selftest.ps1 共用，后者用合成夹具验证它在坏数据上确实变红。
. (Join-Path $PSScriptRoot 'anchor-checks.ps1')

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
# 归档默认落本脚本目录下被 .gitignore 忽略的 .out（不写死任何机器路径；显式 -ArchiveRoot 优先）
if ([string]::IsNullOrWhiteSpace($ArchiveRoot)) { $ArchiveRoot = Join-Path $scriptDir '.out' }
$lpCasePath = if ([string]::IsNullOrWhiteSpace($LpCaseFile)) { Join-Path $repoRoot 'test\cases\anchor\lp-pipe-row.json' } else { [System.IO.Path]::GetFullPath($LpCaseFile) }
$ae2CasePath = if ([string]::IsNullOrWhiteSpace($Ae2CaseFile)) { Join-Path $repoRoot 'test\cases\anchor\ae2-parts.json' } else { [System.IO.Path]::GetFullPath($Ae2CaseFile) }
$port = $Port
# 现代 JVM 默认开（纯为启动快）；-LegacyJdk 退回 runClientSdePipeline
$modernJdk = -not [bool]$LegacyJdk
if ($UseModernJdk -and $LegacyJdk) { Write-Warning "-UseModernJdk 与 -LegacyJdk 同时给出：以 -LegacyJdk 为准（退回 runClientSdePipeline）" }

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$archiveDir = Join-Path $ArchiveRoot "anchor-$ts"
$logDir = Join-Path $archiveDir 'logs'
$flatShotsDir = Join-Path $archiveDir 'shots-flat'
$assertions = New-Object System.Collections.ArrayList
$script:fatalCode = 0
$script:nodeExe = ''
$script:paramCache = @{}
$script:cfgExisted = $false
$clientProc = $null
$createdRuns = New-Object System.Collections.ArrayList

function Write-Step([string]$msg) { Write-Host "== [CP-ANCHOR] $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host "   OK  $msg" -ForegroundColor Green }
function Write-Warn2([string]$msg) { Write-Host "   !!  $msg" -ForegroundColor Yellow }
function Write-Err2([string]$msg) { Write-Host "   XX  $msg" -ForegroundColor Red }
function Write-Dim([string]$msg) { Write-Host "      $msg" -ForegroundColor DarkGray }
function Write-Info([string]$msg) { Write-Host "   --  $msg" -ForegroundColor DarkCyan }

function Add-Assertion([string]$Name, [bool]$Ok, [string]$Detail) {
    [void]$assertions.Add([pscustomobject]@{ name = $Name; ok = $Ok; detail = $Detail })
    if ($Ok) { Write-Host ("   PASS  {0,-40} {1}" -f $Name, $Detail) -ForegroundColor Green }
    else { Write-Host ("   FAIL  {0,-40} {1}" -f $Name, $Detail) -ForegroundColor Red }
}

function Fail-Fatal([string]$Message, [int]$Code) {
    $script:fatalCode = $Code
    throw $Message
}

# ---------------------------------------------------------------------------
# 通用工具（与 run-shots.ps1 同源；刻意复制而非抽公共，理由见 run-shots.ps1 注释）
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

function Format-Size($W, $H) { return "$W`x$H" }

# ---------------------------------------------------------------------------
# 合成 PNG（只给离线自检用）：24 位真彩、逐行 filter=0（None）、单 IDAT、真实 CRC。
#   不依赖 System.Drawing（headless 也能跑），只用 BCL：DeflateStream 出 raw deflate，
#   这里补 zlib 的 CMF/FLG 头与 adler32 尾。
# ---------------------------------------------------------------------------
function Add-Be32([System.Collections.Generic.List[byte]]$L, [uint32]$V) {
    $L.Add([byte](($V -shr 24) -band 0xFF)); $L.Add([byte](($V -shr 16) -band 0xFF))
    $L.Add([byte](($V -shr 8) -band 0xFF)); $L.Add([byte]($V -band 0xFF))
}

# PNG chunk CRC32（标准 IEEE 多项式）。⚠ 必须用**十进制**字面量：PowerShell 的
# 0xEDB88320 / 0xFFFFFFFF 会被解析成 Int32（-306674912 / -1），[int64] 转换不做零扩展，
# CRC 会静默算错（实测踩中）。
$script:crcTable = $null
function Get-Crc32([byte[]]$Data) {
    if ($null -eq $script:crcTable) {
        $t = New-Object int64[] 256
        for ($n = 0; $n -lt 256; $n++) {
            $c = [int64]$n
            for ($k = 0; $k -lt 8; $k++) {
                if (($c -band 1) -ne 0) { $c = [int64]3988292384 -bxor ($c -shr 1) } else { $c = $c -shr 1 }
            }
            $t[$n] = $c
        }
        $script:crcTable = $t
    }
    $crc = [int64]4294967295
    foreach ($b in $Data) {
        $idx = [int](($crc -bxor [int64]$b) -band [int64]255)
        $crc = ($script:crcTable[$idx] -bxor ($crc -shr 8)) -band [int64]4294967295
    }
    return [uint32](($crc -bxor [int64]4294967295) -band [int64]4294967295)
}

function Write-ProbePng {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [int]$Width = 64, [int]$Height = 48,
        [int]$BgR = 120, [int]$BgG = 160, [int]$BgB = 220,
        [int]$BlobCount = 0,
        [int]$Seed = 7
    )
    $stride = $Width * 3
    $raw = New-Object byte[] (($stride + 1) * $Height)
    $off = 0
    for ($y = 0; $y -lt $Height; $y++) {
        $raw[$off] = 0; $off++   # filter type 0 = None
        for ($x = 0; $x -lt $Width; $x++) {
            $raw[$off] = [byte]$BgR; $raw[$off + 1] = [byte]$BgG; $raw[$off + 2] = [byte]$BgB
            $off += 3
        }
    }
    $rand = New-Object System.Random($Seed)
    for ($i = 0; $i -lt $BlobCount; $i++) {
        $bx = $rand.Next([math]::Max(1, $Width - 4)); $by = $rand.Next([math]::Max(1, $Height - 4))
        $cr = $rand.Next(256); $cg = $rand.Next(256); $cb = $rand.Next(256)
        for ($dy = 0; $dy -lt 3; $dy++) {
            for ($dx = 0; $dx -lt 3; $dx++) {
                $px = $bx + $dx; $py = $by + $dy
                if ($px -ge $Width -or $py -ge $Height) { continue }
                $p = $py * ($stride + 1) + 1 + $px * 3
                $raw[$p] = [byte]$cr; $raw[$p + 1] = [byte]$cg; $raw[$p + 2] = [byte]$cb
            }
        }
    }
    $ms = New-Object System.IO.MemoryStream
    $ds = New-Object System.IO.Compression.DeflateStream($ms, [System.IO.Compression.CompressionMode]::Compress, $true)
    $ds.Write($raw, 0, $raw.Length)
    $ds.Dispose()
    $deflated = $ms.ToArray()
    $ms.Dispose()
    # zlib 包装：CMF=0x78 FLG=0x01 + deflate + adler32（大端）
    $z = New-Object System.Collections.Generic.List[byte]
    $z.Add([byte]0x78); $z.Add([byte]0x01)
    foreach ($b in $deflated) { $z.Add($b) }
    $a = 1; $b = 0
    foreach ($v in $raw) {
        $a = ($a + [int]$v) % 65521
        $b = ($b + $a) % 65521
    }
    $adler = [int64]$b * 65536 + [int64]$a
    $z.Add([byte](($adler -shr 24) -band 255)); $z.Add([byte](($adler -shr 16) -band 255))
    $z.Add([byte](($adler -shr 8) -band 255)); $z.Add([byte]($adler -band 255))

    $out = New-Object System.Collections.Generic.List[byte]
    foreach ($b in @(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)) { $out.Add([byte]$b) }
    $chunk = {
        param([string]$Type, [byte[]]$Data)
        $body = New-Object System.Collections.Generic.List[byte]
        foreach ($b in [System.Text.Encoding]::ASCII.GetBytes($Type)) { $body.Add($b) }
        foreach ($b in $Data) { $body.Add($b) }
        Add-Be32 $out ([uint32]$Data.Length)
        foreach ($b in $body) { $out.Add($b) }
        Add-Be32 $out (Get-Crc32 $body.ToArray())
    }
    $ihdr = New-Object System.Collections.Generic.List[byte]
    Add-Be32 $ihdr ([uint32]$Width); Add-Be32 $ihdr ([uint32]$Height)
    $ihdr.Add([byte]8)   # bit depth
    $ihdr.Add([byte]2)   # color type 2 = truecolor RGB
    $ihdr.Add([byte]0); $ihdr.Add([byte]0); $ihdr.Add([byte]0)
    & $chunk 'IHDR' $ihdr.ToArray()
    & $chunk 'IDAT' $z.ToArray()
    & $chunk 'IEND' (New-Object byte[] 0)
    [System.IO.File]::WriteAllBytes($Path, $out.ToArray())
}

# ---------------------------------------------------------------------------
# 配置：lightning.cfg 的 controlplane.enabled（写前备份、收尾还原）
#   契约事实：Forge Configuration 的分节是 `name {` … `}`，不是 INI 的 `[name]`
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
    if ($SkipClientStart -or $ChecksOnly) { return }
    try {
        if ($script:cfgExisted) {
            Copy-Item -Force (Join-Path $archiveDir 'lightning.cfg.before') $cfgPath
            Write-Ok "已还原 lightning.cfg（备份在 $archiveDir\lightning.cfg.before）"
        } elseif (Test-Path $cfgPath) {
            # 不删除：移到归档目录（铁律：AI 不删除，只标记）
            Move-Item -Force $cfgPath (Join-Path $archiveDir 'lightning.cfg.created-by-run-anchor')
            Write-Ok "已移除本次新建的 lightning.cfg（原件移入归档）"
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
    $out = & $script:nodeExe @av 2>&1
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

function Get-ActionParamNames([string]$Action) {
    if ($script:paramCache.ContainsKey($Action)) { return $script:paramCache[$Action] }
    $d = Invoke-Caller -Action $Action -Describe -Label "describe-$Action"
    $names = @()
    if ($d.json -and $d.json.params) { $names = @($d.json.params | ForEach-Object { [string]$_.name }) }
    $script:paramCache[$Action] = $names
    return $names
}

function Add-StepTimeouts([hashtable]$Params, [string]$Action, [int]$TotalMs, [int]$StageMs) {
    if ($StageMs -gt $TotalMs) { $StageMs = $TotalMs }
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
    $now = Get-RunDirNames
    $new = @($now | Where-Object { $Before -notcontains $_ })
    if ($new.Count -gt 0) {
        Write-Warn2 "作业 JSON 没给可用的 runId，改用本次新增的 run 目录（$($new.Count) 个）"
        return (Resolve-Path (Join-Path $runsDir $new[-1])).Path
    }
    return $null
}

function Get-CriteriaDoc([string]$RunDir) {
    if ([string]::IsNullOrWhiteSpace($RunDir)) { return $null }
    return (Read-JsonFile (Join-Path $RunDir 'criteria.json'))
}

function Get-RunFile([string]$RunDir, [string]$Rel) {
    if ([string]::IsNullOrWhiteSpace($RunDir)) { return $null }
    return (Read-JsonFile (Join-Path $RunDir ($Rel -replace '/', '\')))
}

function Get-VerdictMap($CriteriaDoc) {
    $map = @{}
    if ($null -eq $CriteriaDoc) { return $map }
    foreach ($c in @($CriteriaDoc.criteria)) {
        if ($null -ne $c -and $c.id) { $map[[string]$c.id] = [string]$c.verdict }
    }
    return $map
}

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

function Get-CaseCriteriaIds($CaseDoc) { return @($CaseDoc.criteria | ForEach-Object { [string]$_.id }) }
function Get-CaseVariant($CaseDoc) { return @($CaseDoc.variants)[0] }

# C2：判定本体在 anchor-checks.ps1 的 Test-AnchorPairing（脚本入口见 README §1）
function Invoke-PairingCheck {
    foreach ($pair in @(@{ path = $lpCasePath; doc = $lpCaseDoc }, @{ path = $ae2CasePath; doc = $ae2CaseDoc })) {
        $r = Test-AnchorPairing $pair.doc
        Add-Assertion "C2 双轨齐备静态检查: $(Split-Path $pair.path -Leaf)" ([bool]$r.ok) ([string]$r.detail)
    }
}

# ---------------------------------------------------------------------------
# 前置检查（两个用例文件 + 离线检查；-ChecksOnly 到此为止）
# ---------------------------------------------------------------------------
Write-Step "前置检查"
if (-not $ChecksOnly) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

if (-not (Test-Path $lpCasePath)) { Write-Err2 "找不到 LP 锚点用例: $lpCasePath"; exit 4 }
if (-not (Test-Path $ae2CasePath)) { Write-Err2 "找不到 AE2 锚点用例: $ae2CasePath"; exit 4 }
Write-Ok "LP 用例:  $lpCasePath"
Write-Ok "AE2 用例: $ae2CasePath"

$lpCaseDoc = Read-JsonFile $lpCasePath
$ae2CaseDoc = Read-JsonFile $ae2CasePath
if ($null -eq $lpCaseDoc) { Write-Err2 "LP 用例不是合法 JSON: $lpCasePath"; exit 4 }
if ($null -eq $ae2CaseDoc) { Write-Err2 "AE2 用例不是合法 JSON: $ae2CasePath"; exit 4 }
$lpCriteriaIds = Get-CaseCriteriaIds $lpCaseDoc
$ae2CriteriaIds = Get-CaseCriteriaIds $ae2CaseDoc
$lpCameras = Get-CaseCameras $lpCaseDoc
$ae2Cameras = Get-CaseCameras $ae2CaseDoc
$lpVariant = Get-CaseVariant $lpCaseDoc
$ae2Variant = Get-CaseVariant $ae2CaseDoc
Write-Ok ("LP  id={0} 判据 {1} 条，机位 {2} 个，变体 {3}" -f $lpCaseDoc.id, $lpCriteriaIds.Count, $lpCameras.Count, @($lpCaseDoc.variants).Count)
Write-Ok ("AE2 id={0} 判据 {1} 条，机位 {2} 个，变体 {3}" -f $ae2CaseDoc.id, $ae2CriteriaIds.Count, $ae2Cameras.Count, @($ae2CaseDoc.variants).Count)
if (-not $ChecksOnly) {
    if ($lpCameras.Count -eq 0 -or $ae2Cameras.Count -eq 0) { Write-Err2 "锚点用例必须有 cameras 段（本驱动验收取证拍摄 + 图像轨）"; exit 4 }
    if ($null -eq $lpVariant -or $null -eq $ae2Variant) { Write-Err2 "锚点用例必须有 variants 段（C3 负对照）"; exit 4 }
}

# ---------------------------------------------------------------------------
# C2：静态检查（离线；放在最前——它不需要客户端，也不该被前置失败掩掉）
# ---------------------------------------------------------------------------
Write-Step "C2 双轨齐备静态检查（离线，不需要客户端）"
Invoke-PairingCheck

if ($ChecksOnly) {
    Write-Step "-ChecksOnly：只跑离线检查（C2 + 复算器自检），随后直接进收尾"
    $probeDir = Join-Path $archiveDir 'probe-png'
    New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
    $uni = Join-Path $probeDir 'uniform.png'
    $mix = Join-Path $probeDir 'mixed.png'
    Write-ProbePng -Path $uni -Width 64 -Height 48 -BgR 120 -BgG 160 -BgB 220 -BlobCount 0
    Write-ProbePng -Path $mix -Width 64 -Height 48 -BgR 120 -BgG 160 -BgB 220 -BlobCount 40
    $ru = Get-PngDominantColorRatio $uni
    $rm = Get-PngDominantColorRatio $mix
    Add-Assertion 'C4s 复算器自检: 纯色图 ratio>=0.999' ($null -ne $ru -and $ru.ratio -ge 0.999) `
        $(if ($null -eq $ru) { '复算器读不出 PNG（$null）' } else { "ratio=$([math]::Round($ru.ratio,6)) colors=$($ru.colors)" })
    Add-Assertion 'C4s 复算器自检: 杂色图 ratio<0.95' ($null -ne $rm -and $rm.ratio -lt 0.95) `
        $(if ($null -eq $rm) { '复算器读不出 PNG（$null）' } else { "ratio=$([math]::Round($rm.ratio,6)) colors=$($rm.colors)" })
    # 复算器必须能读真截图（现场取证的 PNG 是 ImageIO 写的）：有历史 run 就顺带核一张
    $sample = Get-ChildItem (Join-Path $runsDir '*-ae2-parts-*') -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if ($null -ne $sample) {
        $sampleFar = Join-Path $sample.FullName 'shots\far.png'
        $rs = Get-PngDominantColorRatio $sampleFar
        Add-Assertion 'C4s 复算器自检: 能读现场截图' ($null -ne $rs) `
            $(if ($null -eq $rs) { "读不出 $sampleFar" } else { "ratio=$([math]::Round($rs.ratio,6)) colors=$($rs.colors) 尺寸=$(Format-Size $rs.width $rs.height)" })
    } else {
        Write-Info "runs/ 下没有 ae2-parts 的历史 run：跳过「能读现场截图」自检"
    }
} else {

# ---------------------------------------------------------------------------
# 前置检查（需要客户端的一侧）
# ---------------------------------------------------------------------------
if (-not (Test-Path $gradlew)) { Write-Err2 "找不到 $gradlew"; exit 4 }
Write-Ok "gradlew: $gradlew"

if (-not (Test-Path $webNodeModules)) {
    Write-Err2 "找不到 $webNodeModules —— runClient 依赖 syncWeb→vite，请先执行: cd web; pnpm install --frozen-lockfile"
    exit 4
}
Write-Ok "web/node_modules 存在"

if (-not (Test-Path $mcDataDir)) { Write-Err2 "找不到 mcDataDir: $mcDataDir（客户端至少跑过一次才会有 run/client）"; exit 4 }

$script:nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $script:nodeExe) { Write-Err2 "PATH 里找不到 node（caller.mjs 需要 Node 18+）"; exit 4 }
Write-Ok "node: $script:nodeExe"

if (-not (Test-Path $callerPath)) { Write-Err2 "找不到 $callerPath"; exit 4 }

$pinPreflightPath = Join-Path $scriptDir 'pin-preflight.ps1'
if (-not (Test-Path $pinPreflightPath)) { Write-Err2 "找不到 $pinPreflightPath（点火前置 helper）"; exit 4 }
. $pinPreflightPath

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

try {
    # -----------------------------------------------------------------------
    # 写配置 + 起客户端
    # -----------------------------------------------------------------------
    if (-not $SkipClientStart) {
        Write-Step '钉 pauseOnLostFocus=false（点火前置；唯一写选项实现 = drive-session.ps1 -PinOnly）'
        try {
            $pinEvidence = Invoke-PauseOnLostFocusPreflight -RunDir $mcDataDir -Tag 'anchor'
        } catch {
            Fail-Fatal "点火前置失败：pauseOnLostFocus 未钉住，禁止启动客户端。$($_.Exception.Message)" 4
        }
        Add-Assertion 'P0 pauseOnLostFocus' ($pinEvidence.readbackCount -eq 1 -and $pinEvidence.readbackLine -ceq 'pauseOnLostFocus:false') $pinEvidence.EvidenceLine
        Write-Ok $pinEvidence.EvidenceLine

        Write-Step "写 lightning.cfg（controlplane.enabled=true，原值备份）"
        $script:cfgExisted = Test-Path $cfgPath
        if ($script:cfgExisted) { Copy-Item -Force $cfgPath (Join-Path $archiveDir 'lightning.cfg.before'); Write-Ok "原值已备份" }
        else { Write-Warn2 "lightning.cfg 不存在，本次新建（收尾会移入归档，不删除）" }
        $replaced = Enable-ControlPlaneCfg $cfgPath
        Write-Ok ("lightning.cfg 已写: {0}（{1}）" -f $cfgPath, $(if ($replaced) { '替换既有键' } else { '追加 controlplane { B:enabled=true } 分节' }))

        $staleDir = Join-Path $archiveDir 'stale'
        New-Item -ItemType Directory -Force -Path $staleDir | Out-Null
        foreach ($f in @($serverJsonPath, $tokensJsonPath)) {
            if (Test-Path $f) { Move-Item -Force $f (Join-Path $staleDir (Split-Path $f -Leaf)); Write-Warn2 "陈旧发现文件已移入归档: $(Split-Path $f -Leaf)" }
        }

        $runTask = if ($modernJdk) { 'runClient25' } else { 'runClientSdePipeline' }
        Write-Step "启动客户端（gradlew $runTask --console=plain，日志 $logDir\gradle-runClient.log）"
        # 追加式注入：保留调用方已设的 JAVA_TOOL_OPTIONS（诊断器具等外部 -D 走这条通道，
        # 整体赋值会丢弃外部值，诊断被迫绕道 _JAVA_OPTIONS；故改为追加式注入）
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
            Write-Warn2 "若实现只认 JVM 属性通道，请用 -EnableViaJvmProperty 复跑"
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
    if ($port -ne $Port) { Write-Warn2 "实际绑定端口 $port 与预期 $Port 不同（契约 §1 第 4 条允许 preferred+1 回退）；后续调用一律以 server.json 为准" }

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
        Add-Assertion 'P3 param:variant' $false "case.run 自描述里没有变体选择参数（C3 需要按变体单跑）"
    } else {
        Add-Assertion 'P3 param:variant' $true "变体参数 = $variantParam"
    }

    function New-CaseRunParams([string]$Path, $Extra) {
        $p = @{ $fileParam = $Path }
        if ($Extra) { foreach ($k in $Extra.Keys) { $p[$k] = $Extra[$k] } }
        [void](Add-StepTimeouts $p 'case.run' $CaseTimeoutMs $ActionTimeoutMs)
        return ($p | ConvertTo-Json -Compress -Depth 10)
    }

    # -----------------------------------------------------------------------
    # C1 两用例整跑（forensic）：退出码 0 + overall green + 判据全绿全覆盖
    # -----------------------------------------------------------------------
    function Invoke-FullRun([string]$Tag, [string]$Path, $CaseDoc, [string[]]$CriteriaIds, $Cameras) {
        Write-Step "$Tag case.run 整跑（--tier forensic --sync，超时 $([int]($CaseTimeoutMs / 1000)) s）"
        $r = Invoke-Caller -Action 'case.run' -ParamsJson (New-CaseRunParams $Path $null) -Label "$Tag-run-full" -Tier 'forensic' -Sync -TimeoutMs $CaseTimeoutMs
        Add-Assertion "$Tag-a case.run(forensic,整跑)" ($r.code -eq 0) "退出码 $($r.code)（0=done）；用例 $([string]$CaseDoc.id)"
        $result = Get-JsonProp $r.json 'result'
        $overall = [string](Get-JsonProp $result 'overall')
        Add-Assertion "$Tag-b result.overall=green" ($overall -eq 'green') "overall=$overall"
        $runDir = Resolve-RunDir $r.json $r.newRuns
        if ($runDir) { Write-Ok "run 目录: $runDir" } else { Write-Err2 "定位不到整跑的 run 目录" }

        $shots = Get-JsonProp $result 'shots'
        if ($shots) {
            $camCount = [int](Get-JsonProp $shots 'cameraCount')
            $failedCount = [int](Get-JsonProp $shots 'failedCount')
            Add-Assertion "$Tag-c 机位数/失败数" (($camCount -eq $Cameras.Count) -and ($failedCount -eq 0)) `
                "cameraCount=$camCount（期望 $($Cameras.Count)）failedCount=$failedCount"
        } else {
            Add-Assertion "$Tag-c 机位数/失败数" $false "作业结果里没有 shots 段（case.run 未走拍摄路径？）"
        }

        $criteria = Get-CriteriaDoc $runDir
        if ($null -eq $criteria) {
            Add-Assertion "$Tag-d criteria.json 全绿且覆盖全部判据" $false "run 目录里没有 criteria.json（$runDir）"
        } else {
            $map = Get-VerdictMap $criteria
            $notGreen = @($map.GetEnumerator() | Where-Object { $_.Value -ne 'green' } | ForEach-Object { "$($_.Key)=$($_.Value)" })
            $missing = @($CriteriaIds | Where-Object { -not $map.ContainsKey($_) })
            Add-Assertion "$Tag-d criteria.json 全绿且覆盖全部判据" (($criteria.overall -eq 'green') -and ($notGreen.Count -eq 0) -and ($missing.Count -eq 0)) `
                ("overall={0} 判据数={1}/{2} 非绿=[{3}] 缺判据=[{4}]" -f $criteria.overall, $map.Count, $CriteriaIds.Count, ($notGreen -join ','), ($missing -join ','))
        }

        $evidence = Get-RunFile $runDir 'evidence.json'
        $evCheck = Test-EvidenceComplete $runDir $evidence $Cameras
        Add-Assertion "$Tag-e evidence.json overall=green" ([bool]$evCheck.ok) ([string]$evCheck.detail)
        return [pscustomobject]@{ run = $r; runDir = $runDir; result = $result; criteria = $criteria }
    }

    $lpFull = Invoke-FullRun 'C1lp' $lpCasePath $lpCaseDoc $lpCriteriaIds $lpCameras
    $ae2Full = Invoke-FullRun 'C1ae2' $ae2CasePath $ae2CaseDoc $ae2CriteriaIds $ae2Cameras

    # -----------------------------------------------------------------------
    # C3 负对照变体单跑（两用例各一）：退出码 0 + variantVerification.ok + 精确命中
    # -----------------------------------------------------------------------
    function Invoke-VariantRun([string]$Tag, [string]$Path, $Variant) {
        $variantId = [string]$Variant.id
        $redIds = @($Variant.expectCriteriaRed | ForEach-Object { [string]$_ })
        Write-Step "$Tag 负对照变体单跑（variant=$variantId，expectCriteriaRed=[$($redIds -join ',')]）"
        if (-not $variantParam) {
            Add-Assertion "$Tag-a 变体跑退出码 0" $false '自描述无变体选择参数，无法单跑变体'
            Add-Assertion "$Tag-d 负对照精确命中" $false '同上'
            return $null
        }
        $r = Invoke-Caller -Action 'case.run' -ParamsJson (New-CaseRunParams $Path @{ $variantParam = $variantId }) -Label "$Tag-run-variant" -Tier 'forensic' -Sync -TimeoutMs $CaseTimeoutMs
        Add-Assertion "$Tag-a 变体跑退出码 0" ($r.code -eq 0) "退出码 $($r.code)；variant=$variantId"

        $result = Get-JsonProp $r.json 'result'
        $verify = Get-JsonProp $result 'variantVerification'
        if ($verify) {
            $okV = [bool](Get-JsonProp $verify 'ok')
            Add-Assertion "$Tag-b variantVerification.ok" $okV ("ok={0} notRed=[{1}] missing=[{2}]" -f $okV, (@(Get-JsonProp $verify 'notRed') -join ','), (@(Get-JsonProp $verify 'missing') -join ','))
        } else {
            Add-Assertion "$Tag-b variantVerification.ok" $false '作业结果里没有 variantVerification'
        }

        $runDir = Resolve-RunDir $r.json $r.newRuns
        $criteria = Get-CriteriaDoc $runDir
        $prec = Test-VariantPrecision $criteria $redIds
        $map = Get-VerdictMap $criteria
        $notRed = @($redIds | Where-Object { $map[$_] -ne 'red' } | ForEach-Object { "$_=$($map[$_])" })
        Add-Assertion "$Tag-c 期望判据全红" ($null -ne $criteria -and $notRed.Count -eq 0) `
            $(if ($null -eq $criteria) { "变体 run 目录里没有 criteria.json（$runDir）" } else { "expectCriteriaRed=[$($redIds -join ',')] 全部变红" })
        Add-Assertion "$Tag-d 负对照精确命中" ([bool]$prec.ok) ([string]$prec.detail)
        return [pscustomobject]@{ run = $r; runDir = $runDir; criteria = $criteria }
    }

    $lpVariantRun = Invoke-VariantRun 'C3lp' $lpCasePath $lpVariant
    $ae2VariantRun = Invoke-VariantRun 'C3ae2' $ae2CasePath $ae2Variant

    # -----------------------------------------------------------------------
    # C4 K1 门控：near/ortho 非纯色、far 近纯色 + 独立复算 far.png 主色占比
    # -----------------------------------------------------------------------
    Write-Step "C4 K1 门控（near/ortho 非纯色 + far 近纯色 + 独立复算）"
    $ae2RunDir = $ae2Full.runDir
    if ([string]::IsNullOrWhiteSpace($ae2RunDir)) {
        Add-Assertion 'C4a near/ortho 非纯色判据绿且图非空' $false 'AE2 整跑 run 目录未定位'
        Add-Assertion 'C4b far 近纯色判据绿且图非空' $false 'AE2 整跑 run 目录未定位'
        Add-Assertion 'C4c 独立复算 far.png 主色占比' $false 'AE2 整跑 run 目录未定位'
    } else {
        $gate = Test-GateCriteria $ae2Full.criteria $ae2RunDir
        # 门控是一个整体判定（门内 non-uniform / 门外 uniform / 三图非空），同一条结论同时服务
        # C4a/C4b；失败文本会点名是 near/ortho 还是 far/img-gate。
        Add-Assertion 'C4a near/ortho 非纯色判据绿且图非空' ([bool]$gate.ok) ([string]$gate.detail)
        Add-Assertion 'C4b far 近纯色判据绿且图非空' ([bool]$gate.ok) ([string]$gate.detail)

        $farCrit = @($ae2CaseDoc.criteria | Where-Object { [string]$_.id -eq 'img-gate-uniform-far' })[0]
        $minRatio = 0.98
        if ($null -ne $farCrit) {
            $mr = Get-JsonProp (Get-JsonProp $farCrit 'params') 'minSameColorRatio'
            if ($null -ne $mr) { $minRatio = [double]$mr }
        }
        $recomp = Test-GateUniformRecompute $ae2RunDir 'shots/far.png' $minRatio
        Add-Assertion 'C4c 独立复算 far.png 主色占比' ([bool]$recomp.ok) ([string]$recomp.detail)
    }

    # -----------------------------------------------------------------------
    # C5 幂等：lp-pipe-row 连跑两次（两个 runId），清单 sha256 相等 + world-hash 绿
    # -----------------------------------------------------------------------
    Write-Step "C5 幂等（lp-pipe-row 连跑两次，两个 runId）"
    $lpRun2 = Invoke-Caller -Action 'case.run' -ParamsJson (New-CaseRunParams $lpCasePath $null) -Label 'C5-run-full-2' -Tier 'forensic' -Sync -TimeoutMs $CaseTimeoutMs
    Add-Assertion 'C5a 第二次整跑退出码 0' ($lpRun2.code -eq 0) "退出码 $($lpRun2.code)"
    $lpRun2Result = Get-JsonProp $lpRun2.json 'result'
    $lpRun2Overall = [string](Get-JsonProp $lpRun2Result 'overall')
    Add-Assertion 'C5a2 第二次 overall=green' ($lpRun2Overall -eq 'green') "overall=$lpRun2Overall"
    $lpRun2Dir = Resolve-RunDir $lpRun2.json $lpRun2.newRuns
    if ($lpRun2Dir) { Write-Ok "第二次 run 目录: $lpRun2Dir" }

    $lpSha1 = $null; $lpSha2 = $null
    if ($lpFull.runDir) {
        $m = Get-RunFile $lpFull.runDir 'world/scene-manifest.json'
        if ($m) { $lpSha1 = [string](Get-JsonProp $m 'sha256') }
    }
    if ($lpRun2Dir) {
        $m = Get-RunFile $lpRun2Dir 'world/scene-manifest.json'
        if ($m) { $lpSha2 = [string](Get-JsonProp $m 'sha256') }
    }
    $idem = Test-IdempotentManifest $lpSha1 $lpSha2
    Add-Assertion 'C5b sceneManifestSha256 相等' ([bool]$idem.ok) ([string]$idem.detail)

    $lpMap1 = Get-VerdictMap $lpFull.criteria
    $lpMap2 = Get-VerdictMap (Get-CriteriaDoc $lpRun2Dir)
    Add-Assertion 'C5c 两次的 world-hash 判据均绿' (($lpMap1['world-hash'] -eq 'green') -and ($lpMap2['world-hash'] -eq 'green')) `
        ("第一次 world-hash={0} 第二次 world-hash={1}" -f $lpMap1['world-hash'], $lpMap2['world-hash'])

    # -----------------------------------------------------------------------
    # C6 证据齐全（两用例）
    # -----------------------------------------------------------------------
    Write-Step "C6 evidence-complete（两用例）"
    foreach ($tagged in @(@{ tag = 'C6lp'; dir = $lpFull.runDir; cam = $lpCameras }, @{ tag = 'C6ae2'; dir = $ae2Full.runDir; cam = $ae2Cameras })) {
        $ev = Get-RunFile $tagged.dir 'evidence.json'
        $r = Test-EvidenceComplete $tagged.dir $ev $tagged.cam
        Add-Assertion "$($tagged.tag) evidence-complete 绿" ([bool]$r.ok) ([string]$r.detail)
    }

    # -----------------------------------------------------------------------
    # C7 观测记录：runtimeReads 的族名条目 + sha256 非空 + cameras 摘要齐
    # -----------------------------------------------------------------------
    Write-Step "C7 观测记录（runtimeReads / cameras 摘要）"
    foreach ($tagged in @(
            @{ tag = 'C7lp'; dir = $lpFull.runDir; prefix = 'te.lp-pipe['; cam = $lpCameras },
            @{ tag = 'C7ae2'; dir = $ae2Full.runDir; prefix = 'te.ae2-part['; cam = $ae2Cameras })) {
        $obs = Get-RunFile $tagged.dir 'observation.json'
        $teReads = Test-ObservationTeReads $obs $tagged.prefix
        Add-Assertion "$($tagged.tag) runtimeReads 族名条目" ([bool]$teReads.ok) ([string]$teReads.detail)
        $camCheck = Test-ObservationCameras $obs $tagged.cam
        Add-Assertion "$($tagged.tag) observation.cameras 摘要" ([bool]$camCheck.ok) ([string]$camCheck.detail)
    }
} catch {
    $msg = "$_"
    Write-Err2 "编排中断: $msg"
    if ($script:fatalCode -eq 0) { Add-Assertion 'orchestration' $false $msg }
    else { Add-Assertion 'fatal' $false $msg }
} finally {
    # -----------------------------------------------------------------------
    # 收尾：停客户端 → 还原配置（归档在下面的共用段）
    # -----------------------------------------------------------------------
    Write-Step "收尾"
    if ($null -ne $clientProc) {
        if ($KeepClient) {
            Write-Warn2 "-KeepClient：客户端 pid=$($clientProc.Id) 保持运行（人工收工后请自行结束）"
        } else {
            try { if ($clientProc.HasExited) { Write-Ok "客户端已自行退出（exitCode=$($clientProc.ExitCode)）" } } catch { }
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
        Write-Warn2 "-SkipClientStart：不接管客户端进程（由验收人收工）"
    }

    Start-Sleep -Seconds 2
    Restore-LightningCfg
}
}

# ---------------------------------------------------------------------------
# 归档（两条路径共用；-ChecksOnly 也落断言表，便于离线自检留痕）
# ---------------------------------------------------------------------------
Write-Step "归档到 $archiveDir"
try {
    # -ChecksOnly 在前置检查里刻意不建 logs/（不产客户端产物），归档要自己保证目录在
    New-Item -ItemType Directory -Force -Path $archiveDir, $logDir, $flatShotsDir | Out-Null
    $runsArchive = Join-Path $archiveDir 'runs'
    New-Item -ItemType Directory -Force -Path $runsArchive | Out-Null
    foreach ($d in $createdRuns) {
        if (Test-Path $d) {
            Copy-Item -Recurse -Force $d (Join-Path $runsArchive (Split-Path $d -Leaf))
            Write-Ok "run 归档: $(Split-Path $d -Leaf)"
        }
    }
    if ($createdRuns.Count -eq 0 -and (Test-Path $runsDir) -and -not $ChecksOnly) {
        Copy-Item -Recurse -Force $runsDir (Join-Path $archiveDir 'runs-all')
        Write-Warn2 "未能定位单个 run 目录，已整目录复制 runs/ → runs-all/"
    }

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
    if (-not $ChecksOnly -and (Test-Path $cfgPath)) { Copy-Item -Force $cfgPath (Join-Path $archiveDir 'lightning.cfg.after') }

    $lines = New-Object System.Collections.ArrayList
    [void]$lines.Add("# 控制面契约 1.2 锚点验收 $ts")
    [void]$lines.Add('')
    [void]$lines.Add("- LP 用例:  ``$lpCasePath``")
    [void]$lines.Add("- AE2 用例: ``$ae2CasePath``")
    [void]$lines.Add("- mcDataDir: ``$mcDataDir``")
    [void]$lines.Add("- 客户端复用: $([bool]$SkipClientStart)；保留客户端: $([bool]$KeepClient)；runClient25: $modernJdk；仅离线检查: $([bool]$ChecksOnly)")
    [void]$lines.Add("- 归档 run 目录: $($createdRuns.Count) 个")
    [void]$lines.Add('')
    foreach ($d in $createdRuns) {
        if (-not (Test-Path $d)) { continue }
        $doc = Get-CriteriaDoc $d
        if ($null -eq $doc) { continue }
        [void]$lines.Add("## $(Split-Path $d -Leaf)")
        [void]$lines.Add('')
        [void]$lines.Add("overall=$($doc.overall)")
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

    $meta = [pscustomobject]@{
        ts             = $ts
        lpCaseFile     = $lpCasePath
        ae2CaseFile    = $ae2CasePath
        lpCaseId       = [string]$lpCaseDoc.id
        ae2CaseId      = [string]$ae2CaseDoc.id
        mcDataDir      = $mcDataDir
        checksOnly     = [bool]$ChecksOnly
        lpCameras      = @($lpCameras | ForEach-Object { "$($_.name):$(Format-Size $_.width $_.height):$($_.projection)" })
        ae2Cameras     = @($ae2Cameras | ForEach-Object { "$($_.name):$(Format-Size $_.width $_.height):$($_.projection)" })
        lpCriteriaIds  = @($lpCriteriaIds)
        ae2CriteriaIds = @($ae2CriteriaIds)
        runDirs        = @($createdRuns | ForEach-Object { Split-Path $_ -Leaf })
        flatShots      = $flatCount
    }
    [void]($meta | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $archiveDir 'session.json') -Encoding utf8NoBOM)
    Write-Ok "断言表: $archiveDir\assertions.json / summary.md / session.json"
} catch { Write-Warn2 "归档失败: $($_.Exception.Message)" }

Write-Host ""
Write-Host "== [CP-ANCHOR] 断言红绿表" -ForegroundColor Cyan
foreach ($a in $assertions) {
    $mark = if ($a.ok) { 'PASS' } else { 'FAIL' }
    $color = if ($a.ok) { 'Green' } else { 'Red' }
    Write-Host ("   [{0}] {1,-40} {2}" -f $mark, $a.name, $a.detail) -ForegroundColor $color
}
$failed = @($assertions | Where-Object { -not $_.ok })
Write-Host ""
Write-Host "   归档: $archiveDir"
Write-Host ("   总计: {0} 条断言，{1} 红" -f $assertions.Count, $failed.Count)

$fatal = if ($script:fatalCode -gt 0) { $script:fatalCode } else { 0 }
$failedCount = @($assertions | Where-Object { -not $_.ok }).Count
if ($fatal -gt 0) {
    Write-Host "== [CP-ANCHOR] 管线级致命（退出码 $fatal）" -ForegroundColor Red
    exit $fatal
}
if ($failedCount -gt 0) {
    Write-Host "== [CP-ANCHOR] 有 $failedCount 条断言红（退出码 2）：原因见红绿表与归档" -ForegroundColor Red
    exit 2
}
Write-Host "== [CP-ANCHOR] 契约 1.2 锚点验收全绿（退出码 0）" -ForegroundColor Green
exit 0
