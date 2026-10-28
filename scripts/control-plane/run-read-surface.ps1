#!/usr/bin/env pwsh
<#
.SYNOPSIS
  读面验收驱动：B1（只读性）/ D1（自描述完备）/ D3（默认值可见）/ D4（失败显式）。

.DESCRIPTION
  只做编排与调用：一切动作调用经 scripts/control-plane/caller.mjs（自描述驱动），
  证据落 -EvidenceDir。不启停客户端（-SkipClientStart 语义），只连已获批的客户端。

  与 run-smoke.ps1/run-shots.ps1 的关系：流程骨架与发现顺序（server.json → tokens.json）同源，
  本脚本不复制它们的归档/还原路径（那是各自驱动的耦合），只做读面验收的断言集。

  端口：一律以 server.json 的 port 为准，不假设。
#>
[CmdletBinding()]
param(
    [string]$McDataDir = "",
    [string]$EvidenceDir = "",
    [string]$RepoRoot = "",
    [int]$ActionTimeoutMs = 180000,
    [string]$CaseFile = ""
)

$ErrorActionPreference = "Stop"
$script:Assertions = New-Object System.Collections.ArrayList

if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path }
if (-not $McDataDir) { $McDataDir = Join-Path $RepoRoot "mod\gtnh\run\client" }
if (-not $EvidenceDir) { $EvidenceDir = Join-Path $PSScriptRoot ".out\cp-read\evidence" }
if (-not $CaseFile) { $CaseFile = Join-Path $RepoRoot "test\cases\read-surface\read-surface.json" }

$Caller = Join-Path $RepoRoot "scripts\control-plane\caller.mjs"
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null

function Add-Assertion {
    param([string]$Id, [bool]$Ok, [string]$Detail)
    $null = $script:Assertions.Add([pscustomobject]@{ id = $Id; ok = $Ok; detail = $Detail })
    $color = if ($Ok) { "Green" } else { "Red" }
    Write-Host ("  [{0}] {1} {2}" -f $(if ($Ok) { "PASS" } else { "FAIL" }), $Id, $Detail) -ForegroundColor $color
}

function Invoke-Caller {
    <#
      .OUTPUTS @{ exitCode; json (parsed --json-out); raw }
      一律经 caller.mjs（自描述驱动）：脚本不直接 POST 裸请求。
    #>
    param([string]$Action, [string]$ParamsJson = "{}", [string]$Tier = "observe",
        [string]$OutFile, [switch]$NoConfirm, [switch]$Sync)

    if (-not $OutFile) {
        $OutFile = Join-Path $EvidenceDir ("caller-{0}-{1}.json" -f $Action, [guid]::NewGuid().ToString("N").Substring(0, 8))
    }
    $nodeArgs = @($Caller, $Action, $ParamsJson, "--tier", $Tier, "--mc-dir", $McDataDir,
        "--json-out", $OutFile, "--timeoutMs", "$ActionTimeoutMs")
    if ($Sync) { $nodeArgs += "--sync" }
    if ($NoConfirm) { $nodeArgs += "--no-confirm" }

    $raw = & node @nodeArgs 2>&1 | Out-String
    $code = $LASTEXITCODE
    $json = $null
    if (Test-Path $OutFile) {
        try { $json = Get-Content -Raw -Encoding UTF8 $OutFile | ConvertFrom-Json } catch { $json = $null }
    }
    return [pscustomobject]@{ exitCode = $code; json = $json; raw = $raw; outFile = $OutFile }
}

function Get-ServerInfo {
    $f = Join-Path $McDataDir "controlplane\server.json"
    if (-not (Test-Path $f)) { throw "找不到 server.json（$f）：客户端没起或控制面未启用" }
    return Get-Content -Raw -Encoding UTF8 $f | ConvertFrom-Json
}

# ---------------------------------------------------------------- 前置

Write-Host "== 前置检查 ==" -ForegroundColor Cyan
$srv = Get-ServerInfo
Write-Host ("  控制面端口 = {0}（契约 {1}）" -f $srv.port, $srv.contractVersion)
Add-Assertion "P1 port" ($srv.port -gt 0) "server.json port=$($srv.port)"
Add-Assertion "P2 contractVersion" ($srv.contractVersion -eq "1.3") "contractVersion=$($srv.contractVersion)（读面引入版本）"

$tokensFile = Join-Path $McDataDir "controlplane\tokens.json"
Add-Assertion "P3 tokens" (Test-Path $tokensFile) "tokens.json 存在"

# ---------------------------------------------------------------- D1：自描述

Write-Host "== D1：GET /cp/v1/actions 自述完备 ==" -ForegroundColor Cyan
$dumpFile = Join-Path $EvidenceDir "actions-describe.json"
# stdout 与 stderr 必须分开：caller.mjs 的 [cp-caller] 诊断行走 stderr，
# 合并后就不是纯 JSON 了（--actions 的契约是「纯 JSON 到 stdout」）。
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$dumpRaw = & node $Caller --actions "--mc-dir" $McDataDir 2>$null | Out-String
$ErrorActionPreference = $prevEap
$dumpRaw = $dumpRaw.Trim()
[System.IO.File]::WriteAllText($dumpFile, $dumpRaw, (New-Object System.Text.UTF8Encoding $false))
$actions = $null
try { $actions = $dumpRaw | ConvertFrom-Json } catch { }
Add-Assertion "D1.0 actions-parsed" ($null -ne $actions) "自述端点返回可解析 JSON（$dumpFile，$(if ($dumpRaw) { $dumpRaw.Length } else { 0 }) 字节）"
if ($actions) {
    Add-Assertion "D1.1 action-count" ($actions.count -ge 19) "动作目录 count=$($actions.count)（11 基线 + 8 读面）"
    Add-Assertion "D1.2 contractVersion" ($actions.contractVersion -eq "1.3") "自述端点 contractVersion=$($actions.contractVersion)"
}

$readNames = @("read.blocks", "read.overview", "read.player", "read.inventory", "read.te", "read.block", "read.diff", "read.run")
if ($actions) {
    foreach ($n in $readNames) {
        $d = $actions.actions | Where-Object { $_.name -eq $n }
        $missing = New-Object System.Collections.ArrayList
        if (-not $d) { Add-Assertion "D1 $n" $false "自述端点里没有该动作"; continue }
        if ([string]::IsNullOrWhiteSpace($d.description)) { $null = $missing.Add("description") }
        if ([string]::IsNullOrWhiteSpace($d.returns)) { $null = $missing.Add("returns") }
        if ([string]::IsNullOrWhiteSpace($d.since)) { $null = $missing.Add("since") }
        if (-not $d.examples -or @($d.examples).Count -eq 0) { $null = $missing.Add("examples") }
        if ($d.tier -ne "observe") { $null = $missing.Add("tier!=observe($($d.tier))") }
        if ($d.writable -ne $false) { $null = $missing.Add("writable!=false") }
        foreach ($p in @($d.params)) {
            if ([string]::IsNullOrWhiteSpace($p.name)) { $null = $missing.Add("param.name") }
            if ([string]::IsNullOrWhiteSpace($p.type)) { $null = $missing.Add("$($p.name).type") }
            if ([string]::IsNullOrWhiteSpace($p.description)) { $null = $missing.Add("$($p.name).description") }
            if ($null -eq $p.required) { $null = $missing.Add("$($p.name).required") }
        }
        Add-Assertion "D1 $n" ($missing.Count -eq 0) $(if ($missing.Count -eq 0) { "参数/返回/示例/since 齐备（params=$( @($d.params).Count )，examples=$( @($d.examples).Count )）" } else { "缺项: " + ($missing -join ", ") })
    }
}

# ---------------------------------------------------------------- D3：默认值可见

Write-Host "== D3：默认值在自述里机读可见 ==" -ForegroundColor Cyan
$expectedDefaults = @(
    @{ a = "read.blocks"; p = "includeAir"; v = "true" },
    @{ a = "read.blocks"; p = "hash"; v = "true" },
    @{ a = "read.overview"; p = "entities"; v = "true" },
    @{ a = "read.overview"; p = "topEntityTypes"; v = "10" },
    @{ a = "read.inventory"; p = "source"; v = "player" },
    @{ a = "read.inventory"; p = "includeEmpty"; v = "true" },
    @{ a = "read.inventory"; p = "nbtMaxEntries"; v = "24" },
    @{ a = "read.te"; p = "includeNbt"; v = "true" },
    @{ a = "read.block"; p = "meta"; v = "0" },
    @{ a = "read.diff"; p = "maxChanges"; v = "4096" },
    @{ a = "read.run"; p = "limit"; v = "20" }
)
if ($actions) {
    foreach ($e in $expectedDefaults) {
        $d = $actions.actions | Where-Object { $_.name -eq $e.a }
        $p = if ($d) { @($d.params) | Where-Object { $_.name -eq $e.p } } else { $null }
        if (-not $p) { Add-Assertion "D3 $($e.a).$($e.p)" $false "自述里没有该参数"; continue }
        $hasDefault = $null -ne $p.PSObject.Properties["default"]
        $val = if ($hasDefault) { "$($p.default)" } else { "<none>" }
        Add-Assertion "D3 $($e.a).$($e.p)" ($hasDefault -and $val -eq $e.v) "default=$val（期望 $($e.v)）"
    }
}

# ---------------------------------------------------------------- 起世界（读面需要世界）

Write-Host "== 起干净世界（world.rebuild 虚空）==" -ForegroundColor Cyan
$rebuild = Invoke-Caller -Action "world.rebuild" -Tier scene -Sync -OutFile (Join-Path $EvidenceDir "world-rebuild.json") `
    -ParamsJson '{"folder":"cp_read_probe","seed":20261007,"void":true,"base":[64,12,64],"settleTicks":60,"build":[{"op":"clear","from":[60,10,60],"to":[72,18,72]},{"op":"block","at":[65,12,64],"id":"minecraft:stone","meta":0},{"op":"block","at":[66,12,64],"id":"minecraft:stone","meta":0},{"op":"block","at":[67,12,64],"id":"minecraft:planks","meta":2},{"op":"block","at":[65,12,65],"id":"minecraft:chest","meta":0},{"op":"te","at":[65,12,65],"completer":"vanilla","params":{}},{"op":"block","at":[66,12,65],"id":"minecraft:furnace","meta":3},{"op":"te","at":[66,12,65],"completer":"vanilla","params":{}},{"op":"block","at":[68,12,64],"id":"minecraft:mob_spawner","meta":0},{"op":"wait","ticks":20}]}'
Add-Assertion "W1 world.rebuild" ($rebuild.exitCode -eq 0) "退出码 $($rebuild.exitCode)"
$sceneHash = $null
if ($rebuild.json -and $rebuild.json.result) {
    $sceneHash = $rebuild.json.result.scene.sha256
    Add-Assertion "W2 scene-hash" (-not [string]::IsNullOrWhiteSpace($sceneHash)) "场景清单 sha256=$sceneHash"
}

# ---------------------------------------------------------------- B1：只读性（调用前后世界哈希不变）

Write-Host "== B1：全部读面逐个调用，前后世界清单哈希不变 ==" -ForegroundColor Cyan

function Get-WorldHashPair {
    # read.blocks 覆盖构建区域 [60,10,60]..[72,18,72]：读面前后各读一次，哈希必须相等
    $r = Invoke-Caller -Action "read.blocks" -Tier observe `
        -ParamsJson '{"from":[60,10,60],"to":[72,18,72],"includeAir":true,"hash":true}' `
        -OutFile (Join-Path $EvidenceDir "b1-readblocks-$([guid]::NewGuid().ToString('N').Substring(0,6)).json")
    if ($r.exitCode -ne 0) { throw "read.blocks 失败（退出码 $($r.exitCode)）：$($r.raw)" }
    return $r.json.result.sha256
}

$hashBefore = Get-WorldHashPair
Add-Assertion "B1.0 before-hash" (-not [string]::IsNullOrWhiteSpace($hashBefore)) "调用前区域哈希 = $hashBefore"

$readCalls = @(
    @{ n = "read.blocks"; p = '{"from":[64,11,63],"to":[68,13,66]}' },
    @{ n = "read.overview"; p = '{}' },
    @{ n = "read.player"; p = '{}' },
    @{ n = "read.inventory"; p = '{"source":"player"}' },
    @{ n = "read.inventory"; p = '{"source":"tile","at":[65,12,65]}' },
    @{ n = "read.inventory"; p = '{"source":"ender"}' },
    @{ n = "read.te"; p = '{"at":[[65,12,65],[66,12,65],[65,12,64]],"includeNbt":true}' },
    @{ n = "read.block"; p = '{"at":[65,12,65]}' },
    @{ n = "read.block"; p = '{"block":"minecraft:chest"}' },
    @{ n = "read.block"; p = '{"item":"minecraft:diamond_pickaxe"}' },
    @{ n = "read.run"; p = '{"limit":5}' },
    @{ n = "read.diff"; p = '{"expectInline":[{"at":[65,12,64],"id":"minecraft:stone","meta":0},{"at":[66,12,64],"id":"minecraft:stone","meta":0}]}' }
)

$callTable = New-Object System.Collections.ArrayList
foreach ($c in $readCalls) {
    $tag = ($c.n + "-" + ($c.p -replace '[^A-Za-z0-9]', '')).Substring(0, [Math]::Min(60, $c.n.Length + ($c.p -replace '[^A-Za-z0-9]', '').Length))
    $out = Join-Path $EvidenceDir ("b1-$tag.json")
    $r = Invoke-Caller -Action $c.n -Tier observe -ParamsJson $c.p -OutFile $out
    $ok = ($r.exitCode -eq 0)
    $null = $callTable.Add([pscustomobject]@{ action = $c.n; params = $c.p; exitCode = $r.exitCode; evidence = (Split-Path -Leaf $out) })
    Add-Assertion "B1 $($c.n) $($c.p)" $ok "退出码 $($r.exitCode)"
}

$hashAfter = Get-WorldHashPair
Add-Assertion "B1.99 after-hash" ($hashBefore -eq $hashAfter) "调用后区域哈希 = $hashAfter；与调用前$(if ($hashBefore -eq $hashAfter) { '相等 ✅' } else { '不等 ❌' })"

# 场景清单哈希（world.rebuild 写的那份）也复核一次：读面不该改动清单
$manifestFile = Join-Path $McDataDir "saves\cp_read_probe\scene-manifest.json"
if (Test-Path $manifestFile) {
    $m = Get-Content -Raw -Encoding UTF8 $manifestFile | ConvertFrom-Json
    Add-Assertion "B1.100 scene-manifest-hash" ($m.sha256 -eq $sceneHash) "存档内清单 sha256=$($m.sha256)（与 world.rebuild 返回的一致）"
}

# ---------------------------------------------------------------- D4：失败显式

Write-Host "== D4：失败场景逐个实测（错误码 + 上下文齐备）==" -ForegroundColor Cyan

$failCases = @(
    @{ id = "D4.1 read.blocks 缺 to（服务端判定）"; a = "read.blocks"; p = '{"from":[64,12,64]}'; wantCode = "CP-VALID-002" },
    @{ id = "D4.1c read.blocks 空参数（服务端判定）"; a = "read.blocks"; p = '{}'; wantCode = "CP-VALID-002" },
    @{ id = "D4.2 read.blocks from>to"; a = "read.blocks"; p = '{"from":[70,12,64],"to":[64,12,64]}'; wantCode = "CP-VALID-002" },
    @{ id = "D4.3 read.blocks y 越界"; a = "read.blocks"; p = '{"from":[64,300,64],"to":[64,300,64]}'; wantCode = "CP-VALID-002" },
    @{ id = "D4.4 read.blocks 区域过大"; a = "read.blocks"; p = '{"from":[-100,0,-100],"to":[100,255,100]}'; wantCode = "CP-VALID-002" },
    @{ id = "D4.5 read.blocks 坐标分量非整数"; a = "read.blocks"; p = '{"from":[64.5,12,64],"to":[64,12,64]}'; wantCode = "CP-VALID-002" },
    @{ id = "D4.6 read.blocks region 与 from/to 冲突"; a = "read.blocks"; p = '{"from":[64,12,64],"to":[64,12,64],"region":{"from":[65,12,64],"to":[65,12,64]}}'; wantCode = "CP-VALID-002" },
    @{ id = "D4.7 read.inventory 容器不存在"; a = "read.inventory"; p = '{"source":"tile","at":[64,200,64]}'; wantCode = "CP-STATE-001" },
    @{ id = "D4.8 read.inventory 该位置不是容器"; a = "read.inventory"; p = '{"source":"tile","at":[68,12,64]}'; wantCode = "CP-STATE-001" },
    @{ id = "D4.9 read.inventory source 非法"; a = "read.inventory"; p = '{"source":"nope"}'; wantCode = "CP-VALID-002" },
    @{ id = "D4.10 read.te 缺位置参数"; a = "read.te"; p = '{}'; wantCode = "CP-VALID-002" },
    @{ id = "D4.11 read.block 三选一都没给"; a = "read.block"; p = '{}'; wantCode = "CP-VALID-002" },
    @{ id = "D4.12 read.block 三者给了两个"; a = "read.block"; p = '{"at":[65,12,64],"block":"minecraft:stone"}'; wantCode = "CP-VALID-002" },
    @{ id = "D4.13 read.block 未知方块注册名"; a = "read.block"; p = '{"block":"nope:not_a_block"}'; wantCode = "CP-VALID-002" },
    @{ id = "D4.14 read.block 未知物品注册名"; a = "read.block"; p = '{"item":"nope:not_an_item"}'; wantCode = "CP-VALID-002" },
    @{ id = "D4.15 read.diff 缺期望态"; a = "read.diff"; p = '{}'; wantCode = "CP-VALID-002" },
    @{ id = "D4.16 read.diff 期望态给了两个"; a = "read.diff"; p = '{"expectInline":[],"expectManifest":{"blocks":[]}}'; wantCode = "CP-VALID-002" },
    @{ id = "D4.17 read.diff 存档清单不存在"; a = "read.diff"; p = '{"expectManifestFile":"cp_no_such_world"}'; wantCode = "CP-STATE-001" },
    @{ id = "D4.18 read.diff 文件夹名非法"; a = "read.diff"; p = '{"expectManifestFile":"not_prefixed"}'; wantCode = "CP-VALID-002" },
    @{ id = "D4.19 read.run runId 不存在（不得返回空清单）"; a = "read.run"; p = '{"runId":"no-such-run-xyz"}'; wantCode = "CP-IO-001" },
    @{ id = "D4.20 read.overview chunkRange 形态非法"; a = "read.overview"; p = '{"chunkRange":[1,2,3]}'; wantCode = "CP-VALID-002" },
    @{ id = "D4.21 read.overview chunkRange 过大"; a = "read.overview"; p = '{"chunkRange":[0,100,0,100]}'; wantCode = "CP-VALID-002" },
    @{ id = "D4.22 read.inventory nbtMaxEntries 非正"; a = "read.inventory"; p = '{"source":"player","nbtMaxEntries":0}'; wantCode = "CP-VALID-002" },
    @{ id = "D4.23 未知动作（调用方按自述拒绝）"; a = "read.nope"; p = '{}'; wantCode = $null; wantCallerReject = $true }
)

$failTable = New-Object System.Collections.ArrayList
foreach ($f in $failCases) {
    $out = Join-Path $EvidenceDir ("d4-" + ($f.id -replace '[^A-Za-z0-9.]', '_') + ".json")
    $r = Invoke-Caller -Action $f.a -ParamsJson $f.p -Tier observe -OutFile $out
    $code = $null; $http = $null; $msg = $null; $ctx = $null; $state = $null
    if ($r.json) {
        if ($r.json.error) {
            $code = $r.json.error.code; $msg = $r.json.error.message
            if ($r.json.error.PSObject.Properties["context"]) { $ctx = $r.json.error.context }
        }
        if ($r.json.PSObject.Properties["state"]) { $state = $r.json.state }
        if ($r.json.PSObject.Properties["httpStatus"]) { $http = $r.json.httpStatus }
    }
    # 调用方侧拒绝（caller.mjs 按自述在发请求前拦下）：没有错误码，但必须真的没发出请求：
    # 退出码 1 + stdout 里出现 caller 的本地报错。它测的是「自述是否足以让调用方拦住误用」。
    $callerRejected = $r.exitCode -eq 1 -and $r.raw -match 'caller|自描述|必填|未知动作'
    $null = $failTable.Add([pscustomobject]@{
        id = $f.id; action = $f.a; params = $f.p; exitCode = $r.exitCode
        jobState = $state; errorCode = $code; httpStatus = $http; message = $msg; hasContext = ($null -ne $ctx)
        callerRejected = $callerRejected
        evidence = (Split-Path -Leaf $out)
    })
    if ($f.wantCallerReject) {
        Add-Assertion $f.id $callerRejected "调用方侧拒绝（退出码 $($r.exitCode)，未发出请求）：$($r.raw.Trim() -split "`n" | Select-Object -Last 1)"
        continue
    }
    $codeOk = if ($null -eq $f.wantCode) { $true } else { $code -eq $f.wantCode }
    # 注意：动作执行期的失败一律是「作业 failed」（HTTP 200 + 作业体），这是既有契约口径
    # （CoreEndpoints 只对运行期权限升格特判回 403）。因此这里断言 state=failed 而不是 httpStatus——
    # 把 HTTP 状态码当判据会造出一条恒假的断言（实测踩过）。
    $httpOk = if ($null -eq $f.wantHttp) { $true } else { $http -eq $f.wantHttp }
    $notGreen = ($r.exitCode -ne 0) -and ($state -eq "failed") -and (-not [string]::IsNullOrWhiteSpace($code)) -and ($null -ne $ctx)
    Add-Assertion $f.id ($codeOk -and $httpOk -and $notGreen) "退出码=$($r.exitCode) state=$state code=$code http=$(if ($null -eq $http) { '(作业体，无 HTTP 错误码)' } else { $http }) ctx=$(if ($null -ne $ctx) { 'yes' } else { 'no' }) `"$msg`""
}

# 无世界场景：这一条要单独做（需要在非世界中调用），写成「记录不判定」并在报告里说明
Write-Host "  注：'无世界' 失败场景需要退出世界后测，见 no-world-*.json（本轮不重进标题，避免打断会话）" -ForegroundColor Yellow

# ---------------------------------------------------------------- R：哈希可复算 / 可互算
#
# 需求书 §5 的读面条目要求「规范化哈希（哈希口径与 world.rebuild 场景清单一致，可互算）」。
# 「可互算」不能靠文档声称，必须在验收里真的算一遍：
#   R1 复算：从 read.blocks 的 hashInput 重算 sha256，必须等于它自报的 sha256。
#   R2 互算：把 read.blocks 的 blocks 子集 + 场景清单同一批位置的 tileEntities 组装成
#            场景清单的哈希子集，算出的 sha256 必须等于场景清单自报的 sha256。
# 两处都手工复现「键排序 + 无空白」的 canonical 文本（Json.canonical 的口径），
# 因此也能发现「实现里换了序列化口径」这类漂移。
Write-Host "== R：读面哈希可复算 / 与场景清单可互算 ==" -ForegroundColor Cyan

function Get-Sha256Hex {
    param([string]$Text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        return ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") }) -join ""
    } finally { $sha.Dispose() }
}

function ConvertTo-CanonicalBlocks {
    # 复现 Json.canonical 对 {"blocks":[{"pos":[x,y,z],"blockId":N,"meta":M}...]} 的输出：
    # 键按字典序（blockId < meta < pos），数组按下标，无任何空白。
    param($Blocks)
    $parts = foreach ($b in $Blocks) {
        $p = $b.pos
        '{"blockId":' + [int]$b.blockId + ',"meta":' + [int]$b.meta + ',"pos":[' + [int]$p[0] + ',' + [int]$p[1] + ',' + [int]$p[2] + ']}'
    }
    return '{"blocks":[' + ($parts -join ',') + ']}'
}

$blocksFile = Join-Path $EvidenceDir "b1-readblocks-latest.json"
# 用「与 B1 同一参数」的调用产物做 R1/R2：直接把最近一次 B1 的 read.blocks 产物找出来
$b1Files = Get-ChildItem $EvidenceDir -Filter "b1-readblocks-*.json" | Sort-Object LastWriteTime
$hashEvidence = $null
if ($b1Files.Count -gt 0) {
    $json = Get-Content -Raw -Encoding UTF8 $b1Files[-1].FullName | ConvertFrom-Json
    if ($json.state -eq "done" -and $json.result) {
        $hashEvidence = $json.result
        Add-Assertion "R0 read.blocks 产物可用" $true "取自 $($b1Files[-1].Name)"
    }
}
if ($hashEvidence) {
    # R1：自报 sha256 == 从 hashInput 复算
    $hi = $hashEvidence.hashInput
    $canon = ConvertTo-CanonicalBlocks -Blocks $hi.blocks
    $recomputed = Get-Sha256Hex -Text $canon
    Add-Assertion "R1 读面哈希可复算" ($recomputed -eq $hashEvidence.sha256) `
        "自报=$($hashEvidence.sha256) 复算=$recomputed（canonical 长度 $($canon.Length)）"

    # R2：读面子集 + 场景清单的 TE → 场景清单哈希
    #
    # 「可互算」的正确形态（见 ReadSupport#hashSubsetOf 的注释）：区域读回<b>不含</b> tileEntities，
    # 因此要得到场景清单的哈希子集，需要「按清单的位置集合从读面读数里取 blocks」+「清单自己的 TE」。
    # 不是把整片区域的 blocks 都塞进去——那样位置集合根本不同，算出来的当然也不等。
    $mf = Join-Path $McDataDir "saves\cp_read_probe\scene-manifest.json"
    if (Test-Path $mf) {
        $manifest = Get-Content -Raw -Encoding UTF8 $mf | ConvertFrom-Json
        $byPos = @{}
        foreach ($b in $hi.blocks) {
            $byPos[('{0},{1},{2}' -f [int]$b.pos[0], [int]$b.pos[1], [int]$b.pos[2])] = $b
        }
        $picked = New-Object System.Collections.ArrayList
        $missingPos = 0
        foreach ($mb in $manifest.blocks) {
            $k = '{0},{1},{2}' -f [int]$mb.pos[0], [int]$mb.pos[1], [int]$mb.pos[2]
            if ($byPos.ContainsKey($k)) { $null = $picked.Add($byPos[$k]) } else { $missingPos++ }
        }
        $sortedBlocks = $picked | Sort-Object @{E={[int]$_.pos[0]}}, @{E={[int]$_.pos[1]}}, @{E={[int]$_.pos[2]}}
        $blockCanon = ConvertTo-CanonicalBlocks -Blocks $sortedBlocks
        $blockInner = $blockCanon.Substring('{"blocks":'.Length)
        $blockInner = $blockInner.Substring(0, $blockInner.Length - 1)
        $teParts = foreach ($te in ($manifest.tileEntities | Sort-Object @{E={[int]$_.pos[0]}}, @{E={[int]$_.pos[1]}}, @{E={[int]$_.pos[2]}})) {
            $p = $te.pos
            '{"class":"' + $te.class + '","pos":[' + [int]$p[0] + ',' + [int]$p[1] + ',' + [int]$p[2] + ']}'
        }
        $subset = '{"blocks":' + $blockInner + ',"tileEntities":[' + ($teParts -join ',') + ']}'
        $recomputedScene = Get-Sha256Hex -Text $subset
        Add-Assertion "R2 与场景清单可互算" ($recomputedScene -eq $manifest.sha256 -and $missingPos -eq 0) `
            "清单自报=$($manifest.sha256) 由读面读数+清单TE复算=$recomputedScene（取 $($picked.Count) 个位置，缺 $missingPos，TE $($manifest.tileEntities.Count)）"
    } else {
        Add-Assertion "R2 与场景清单可互算" $false "找不到 $mf"
    }
} else {
    Add-Assertion "R0 read.blocks 产物可用" $false "证据目录里没有成功的 b1-readblocks-*.json"
}

# ---------------------------------------------------------------- B2：读面进判据

Write-Host "== B2：criteria 引用读面输出并经 case.run 通过 ==" -ForegroundColor Cyan
if (Test-Path $CaseFile) {
    $caseRun = Invoke-Caller -Action "case.run" -Tier scene -Sync `
        -ParamsJson ("{`"file`":`"" + ($CaseFile -replace '\\', '/') + "`",`"confirm`":true}") `
        -OutFile (Join-Path $EvidenceDir "b2-case-run.json")
    Add-Assertion "B2.1 case.run 退出码 0" ($caseRun.exitCode -eq 0) "退出码 $($caseRun.exitCode)"
    if ($caseRun.json -and $caseRun.json.result) {
        $overall = $caseRun.json.result.overall
        Add-Assertion "B2.2 overall=green" ($overall -eq "green") "overall=$overall"
        $counts = $caseRun.json.result.criteria.counts
        if ($counts) {
            Add-Assertion "B2.3 判据全绿" ($counts.red -eq 0 -and $counts.error -eq 0) "green=$($counts.green) red=$($counts.red) error=$($counts.error)"
        }
        $runId = $caseRun.json.result.runId
        Add-Assertion "B2.4 runId 存在" (-not [string]::IsNullOrWhiteSpace($runId)) "runId=$runId"
        if ($runId) {
            $runDir = Join-Path $McDataDir "controlplane\runs\$runId"
            if (Test-Path $runDir) {
                Copy-Item -Recurse -Force $runDir (Join-Path $EvidenceDir "b2-run")
                $crit = Join-Path $runDir "criteria.json"
                if (Test-Path $crit) {
                    Add-Assertion "B2.5 criteria.json 存在" $true "已归档到 b2-run/"
                }
            }
        }
    }
} else {
    Add-Assertion "B2.0 用例文件存在" $false "找不到 $CaseFile"
}

# ---------------------------------------------------------------- 报告

$summary = [pscustomobject]@{
    generatedAt = (Get-Date).ToString("o")
    mcDataDir = $McDataDir
    port = $srv.port
    contractVersion = $srv.contractVersion
    sceneHashAfterRebuild = $sceneHash
    b1BeforeHash = $hashBefore
    b1AfterHash = $hashAfter
    readCalls = $callTable
    failCases = $failTable
    assertions = $script:Assertions
    passCount = @($script:Assertions | Where-Object { $_.ok }).Count
    failCount = @($script:Assertions | Where-Object { -not $_.ok }).Count
}
$summary | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 (Join-Path $EvidenceDir "assertions.json")

$md = New-Object System.Text.StringBuilder
$null = $md.AppendLine("# 读面验收（read-surface）")
$null = $md.AppendLine("")
$null = $md.AppendLine("- 生成时间：$($summary.generatedAt)")
$null = $md.AppendLine("- 端口：$($srv.port)（契约 $($srv.contractVersion)）")
$null = $md.AppendLine("- 区域哈希（调用前）：``$hashBefore``")
$null = $md.AppendLine("- 区域哈希（调用后）：``$hashAfter``")
$null = $md.AppendLine("- 场景清单 sha256（world.rebuild 返回）：``$sceneHash``")
$null = $md.AppendLine("")
$null = $md.AppendLine("| 断言 | 结果 | 说明 |")
$null = $md.AppendLine("|---|---|---|")
foreach ($a in $script:Assertions) {
    $null = $md.AppendLine(("| {0} | {1} | {2} |" -f $a.id, $(if ($a.ok) { "✅" } else { "❌" }), ($a.detail -replace '\|', '\|')))
}
$null = $md.AppendLine("")
$null = $md.AppendLine("通过 $($summary.passCount) / 失败 $($summary.failCount)")
Set-Content -Encoding UTF8 (Join-Path $EvidenceDir "summary.md") $md.ToString()

Write-Host ""
Write-Host ("== 结果：通过 {0}，失败 {1} ==" -f $summary.passCount, $summary.failCount) -ForegroundColor $(if ($summary.failCount -eq 0) { "Green" } else { "Red" })
Write-Host "证据目录：$EvidenceDir"
if ($summary.failCount -gt 0) { exit 2 } else { exit 0 }
