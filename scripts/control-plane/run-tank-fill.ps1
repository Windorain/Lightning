#!/usr/bin/env pwsh
<#
.SYNOPSIS
  issue #122（L0 流体注入原语 scene.tank.fill）验收驱动：
  D1（自述完备）/ D3（默认与边界值可见）/ D4（失败显式）/
  A（正向注入与读回一致）/ N（负对照）。

  配方级联证（「注入真的让 GT 配方跑起来」）不在本脚本内：它由
  cases/tank-fill-live.json 整跑 + 逐 2s 采样 read.te 的 progress/产物承担，
  见 README §12.5 的实测记录（2026-10-07）。

.DESCRIPTION
  一切动作调用经 scripts/control-plane/caller.mjs（自描述驱动），证据落 -EvidenceDir。
  不启停客户端，只连已获批的客户端；端口一律以 server.json 的 port 为准。

  与 run-read-surface.ps1 的关系：骨架（Invoke-Caller / 断言表 / 报告）同源，
  但本脚本只断言 #122 引入的那一个动作（外加 #122 追加的 material/prefix 形态），
  不重复读面 8 动作的验收（那是 #98 的器具，见 run-read-surface.ps1）。

  坐标系：默认机器在 [65,12,65]（与 gt-machine-live.json / tank-fill-live.json 同口径）。

.EXAMPLE
  pwsh -File scripts/control-plane/run-tank-fill.ps1
#>
[CmdletBinding()]
param(
    [string]$McDataDir = "",
    [string]$EvidenceDir = "",
    [string]$RepoRoot = "",
    [int]$ActionTimeoutMs = 180000,
    [int[]]$MachineAt = @(65, 12, 65),
    [string]$Fluid = "HydrochloricAcid",
    [int]$Amount = 3000,
    # 只跑离线可做的 D1/D3（不起世界）；加 -InWorld 才跑注入与负对照
    [switch]$InWorld
)

$ErrorActionPreference = "Stop"
$script:Assertions = New-Object System.Collections.ArrayList

if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path }
if (-not $McDataDir) { $McDataDir = Join-Path $RepoRoot "mod\gtnh\run\client" }
if (-not $EvidenceDir) { $EvidenceDir = Join-Path $RepoRoot "..\temp\cp-tank-fill\evidence-script" }

$Caller = Join-Path $RepoRoot "scripts\control-plane\caller.mjs"
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
$script:At = "[{0},{1},{2}]" -f $MachineAt[0], $MachineAt[1], $MachineAt[2]
$script:Action = "scene.tank.fill"

function Add-Assertion {
    param([string]$Id, [bool]$Ok, [string]$Detail)
    $null = $script:Assertions.Add([pscustomobject]@{ id = $Id; ok = $Ok; detail = $Detail })
    Write-Host ("  [{0}] {1} {2}" -f $(if ($Ok) { "PASS" } else { "FAIL" }), $Id, $Detail) -ForegroundColor $(if ($Ok) { "Green" } else { "Red" })
}

function Invoke-Caller {
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
    if (Test-Path $OutFile) { try { $json = Get-Content -Raw -Encoding UTF8 $OutFile | ConvertFrom-Json } catch { $json = $null } }
    return [pscustomobject]@{ exitCode = $code; json = $json; raw = $raw; outFile = $OutFile }
}

function Get-ServerInfo {
    $f = Join-Path $McDataDir "controlplane\server.json"
    if (-not (Test-Path $f)) { throw "找不到 server.json（$f）：客户端没起或控制面未启用" }
    return Get-Content -Raw -Encoding UTF8 $f | ConvertFrom-Json
}

$srv = Get-ServerInfo
Write-Host ("== 控制面：port={0} contractVersion={1} ==" -f $srv.port, $srv.contractVersion) -ForegroundColor Cyan
Add-Assertion "P0 port" ($srv.port -gt 0) "server.json port=$($srv.port)"

# ---------------------------------------------------------------- D1：自述完备

Write-Host "== D1：scene.tank.fill 自述完备（无自述的动作视为不存在）==" -ForegroundColor Cyan
$desc = Invoke-Caller -Action $script:Action -ParamsJson '{}' -Tier observe -OutFile (Join-Path $EvidenceDir "d1-describe.json") -NoConfirm
# --describe 走 caller 的专属开关，这里手工调一次拿纯 JSON
$descFile = Join-Path $EvidenceDir "d1-describe.json"
$descRaw = & node $Caller --describe $script:Action "--mc-dir" $McDataDir "--json-out" $descFile 2>$null | Out-String
$d = $null
try { $d = $descRaw | ConvertFrom-Json } catch { }
Add-Assertion "D1.0 自述可解析" ($null -ne $d) "自述 JSON $(if ($descRaw) { $descRaw.Length } else { 0 }) 字节"
if ($d) {
    Add-Assertion "D1.1 name" ($d.name -eq $script:Action) "name=$($d.name)"
    Add-Assertion "D1.2 tier=scene" ($d.tier -eq "scene") "tier=$($d.tier)"
    Add-Assertion "D1.3 writable+confirm" ($d.writable -eq $true -and $d.confirmRequired -eq $true) "writable=$($d.writable) confirmRequired=$($d.confirmRequired)"
    Add-Assertion "D1.4 since=1.7" ($d.since -eq "1.7") "since=$($d.since)"
    Add-Assertion "D1.5 description 非空" (-not [string]::IsNullOrWhiteSpace($d.description)) "长度 $(@($d.description).Length)"
    Add-Assertion "D1.6 returns 非空" (-not [string]::IsNullOrWhiteSpace($d.returns)) "长度 $(@($d.returns).Length)"
    Add-Assertion "D1.7 returns 声明部分注入" ($d.returns -match "partial") "returns 含 partial（部分注入如实报告）"
    Add-Assertion "D1.8 returns 声明干跑" ($d.returns -match "dryRunFillable") "returns 含 dryRunFillable"
    Add-Assertion "D1.9 returns 声明 layer" ($d.returns -match "layer") "returns 含 layer（两义标注可机读）"
    $missing = New-Object System.Collections.ArrayList
    foreach ($p in @($d.params)) {
        if ([string]::IsNullOrWhiteSpace($p.name)) { $null = $missing.Add("name") }
        if ([string]::IsNullOrWhiteSpace($p.type)) { $null = $missing.Add("$($p.name).type") }
        if ([string]::IsNullOrWhiteSpace($p.description)) { $null = $missing.Add("$($p.name).description") }
        if ($null -eq $p.required) { $null = $missing.Add("$($p.name).required") }
    }
    Add-Assertion "D1.10 逐参数四要素齐备" ($missing.Count -eq 0) "params=$(@($d.params).Count) 缺项=$($missing -join ',')"
    $exOk = $true; $exMsg = @()
    foreach ($e in @($d.examples)) {
        if ($null -eq $e.confirm) { $exOk = $false; $exMsg += "某示例缺 confirm:true" }
        if ($null -eq $e.at) { $exOk = $false; $exMsg += "某示例缺 at" }
        if ($null -eq $e.fluid) { $exOk = $false; $exMsg += "某示例缺 fluid" }
        if ($null -eq $e.amount) { $exOk = $false; $exMsg += "某示例缺 amount" }
    }
    Add-Assertion "D1.11 示例可复制（含 confirm/at/fluid/amount）" ($exOk -and @($d.examples).Count -gt 0) "examples=$(@($d.examples).Count) $($exMsg -join ';')"
}

# ---------------------------------------------------------------- D3：默认与边界值可见

Write-Host "== D3：默认值与边界在自述里机读可见 ==" -ForegroundColor Cyan
if ($d) {
    $pSide = @($d.params) | Where-Object { $_.name -eq "side" }
    $pAmount = @($d.params) | Where-Object { $_.name -eq "amount" }
    $pFluid = @($d.params) | Where-Object { $_.name -eq "fluid" }
    Add-Assertion "D3.1 side 默认值机读可见" ($null -ne $pSide -and $pSide.default -eq "UP") "side.default=$(if ($pSide) { $pSide.default } else { '<缺参数>' })"
    Add-Assertion "D3.2 side 列出全部取值" ($null -ne $pSide -and $pSide.description -match "DOWN" -and $pSide.description -match "EAST") "side 说明列出六面"
    Add-Assertion "D3.3 amount 上界机读可见" ($null -ne $pAmount -and $pAmount.description -match "1000000") "amount 说明含上界 1000000"
    Add-Assertion "D3.4 amount 说明不给默认值的理由" ($null -ne $pAmount -and $pAmount.description -match "默认") "amount 说明解释为何无默认值"
    Add-Assertion "D3.5 amount 无默认值" ($null -ne $pAmount -and $null -eq $pAmount.default) "amount.default 缺席（不给默认值）"
    Add-Assertion "D3.6 fluid 无默认值" ($null -ne $pFluid -and $null -eq $pFluid.default) "fluid.default 缺席"
    Add-Assertion "D3.7 fluid 说明两种写法" ($null -ne $pFluid -and $pFluid.description -match "GT" -and $pFluid.description -match "_GT5U") "fluid 说明含注册名/材料名两条路与 _GT5U 后缀"
}

# ---------------------------------------------------------------- D4：失败显式（含调用方侧拒绝）

Write-Host "== D4：失败场景（错误码 + 逐字段 context）==" -ForegroundColor Cyan

# 参数体一律用哈希表 → ConvertTo-Json 构造：手写转义引号在 PowerShell 里
# （转义符是反引号、不是反斜杠）极易造出非法 JSON，而那种失败会伪装成「服务端拒绝了参数」
# ——本脚本首版正是踩了这个坑（10 条 D4 全红，实为脚本自身没发出请求）。构造器只有一个。
function New-TankParams {
    param([hashtable]$Extra = @{}, [switch]$NoConfirm)
    $h = @{ at = $MachineAt; fluid = $Fluid; amount = 1000 }
    if (-not $NoConfirm) { $h["confirm"] = $true }
    foreach ($k in $Extra.Keys) { $h[$k] = $Extra[$k] }
    return ($h | ConvertTo-Json -Compress -Depth 6)
}

$failCases = @(
    @{ id = "D4.1 缺 confirm（可写动作）"; p = (New-TankParams -NoConfirm); wantCode = "CP-CONFIRM-001"; noConfirm = $true },
    @{ id = "D4.2 缺 amount（无默认值）"; p = (@{ at = $MachineAt; fluid = $Fluid; confirm = $true } | ConvertTo-Json -Compress); wantCode = "CP-VALID-002" },
    @{ id = "D4.3 缺 fluid"; p = (@{ at = $MachineAt; amount = 1000; confirm = $true } | ConvertTo-Json -Compress); wantCode = "CP-VALID-002" },
    @{ id = "D4.4 未知流体"; p = (New-TankParams @{ fluid = "nope:not_a_fluid" }); wantCode = "CP-VALID-002" },
    @{ id = "D4.5 未知注入面"; p = (New-TankParams @{ side = "SIDEWAYS" }); wantCode = "CP-VALID-002" },
    @{ id = "D4.6 量为 0"; p = (New-TankParams @{ amount = 0 }); wantCode = "CP-VALID-002" },
    @{ id = "D4.7 量为负"; p = (New-TankParams @{ amount = -5 }); wantCode = "CP-VALID-002" },
    @{ id = "D4.8 量非整数"; p = (New-TankParams @{ amount = 1.5 }); wantCode = "CP-VALID-002" },
    @{ id = "D4.9 量超上界"; p = (New-TankParams @{ amount = 1000001 }); wantCode = "CP-VALID-002" },
    @{ id = "D4.10 at 形态非法"; p = (@{ at = @(1, 2); fluid = $Fluid; amount = 1000; confirm = $true } | ConvertTo-Json -Compress); wantCode = "CP-VALID-002" },
    @{ id = "D4.11 未知动作（调用方按自述拒绝）"; p = '{}'; wantCode = $null; wantCallerReject = $true; actionOverride = "scene.tank.fil" },
    @{ id = "D4.12 自述未声明参数（调用方拒绝）"; p = '{"slots":[],"confirm":true}'; wantCode = $null; wantCallerReject = $true }
)

$failTable = New-Object System.Collections.ArrayList
foreach ($f in $failCases) {
    $act = if ($f.actionOverride) { $f.actionOverride } else { $script:Action }
    $out = Join-Path $EvidenceDir ("d4-" + ($f.id -replace '[^A-Za-z0-9.]', '_') + ".json")
    # 注意变量名不能叫 $args：那是 PowerShell 的自动变量，会吃掉 splatting
    $cargs = @{ Action = $act; ParamsJson = $f.p; Tier = "scene"; OutFile = $out; Sync = $true }
    if ($f.noConfirm) { $cargs["NoConfirm"] = $true }
    $r = Invoke-Caller @cargs
    $code = $null; $ctx = $null; $state = $null; $msg = $null
    if ($r.json) {
        if ($r.json.error) {
            $code = $r.json.error.code; $msg = $r.json.error.message
            if ($r.json.error.PSObject.Properties["context"]) { $ctx = $r.json.error.context }
        }
        if ($r.json.PSObject.Properties["state"]) { $state = $r.json.state }
    }
    $callerRejected = $r.exitCode -eq 1 -and $r.raw -match 'caller|自描述|必填|未知动作'
    $httpStatus = $null
    if ($r.json -and $r.json.PSObject.Properties["httpStatus"]) { $httpStatus = $r.json.httpStatus }
    $null = $failTable.Add([pscustomobject]@{
        id = $f.id; exitCode = $r.exitCode; jobState = $state; errorCode = $code
        httpStatus = $httpStatus; hasContext = ($null -ne $ctx); message = $msg; callerRejected = $callerRejected
        evidence = (Split-Path -Leaf $out)
    })
    if ($f.wantCallerReject) {
        Add-Assertion $f.id $callerRejected "调用方侧拒绝（退出码 $($r.exitCode)，未发出请求）"
        continue
    }
    # 「失败显式」有两种既有形状，两者都合格（本脚本首版只认后者，把前者误判成红）：
    #   ① **提交期拒绝**（HTTP 4xx + error.code + context）——如缺 confirm 的 CP-CONFIRM-001，
    #      请求根本没变成作业（contract §3 的口径）；
    #   ② **执行期失败**（HTTP 200 + 作业 state=failed + 非 0 退出 + error.code + context）
    #      ——动作跑起来之后的前置/参数类错误（CoreEndpoints 只对运行期权限升格特判回 403）。
    # 判据：错误码命中 + context 非空 + 确实是失败（非 0 退出），且两者至少命中一种形状。
    $codeOk = if ($null -eq $f.wantCode) { $true } else { $code -eq $f.wantCode }
    $isSubmitReject = ($r.exitCode -eq 1) -and ($null -ne $httpStatus) -and ($httpStatus -ge 400) -and ($httpStatus -lt 500)
    $isJobFail = ($r.exitCode -eq 2) -and ($state -eq "failed")
    $hasCtx = ($null -ne $ctx)
    Add-Assertion $f.id ($codeOk -and $hasCtx -and ($isSubmitReject -or $isJobFail)) `
        "退出码=$($r.exitCode) state=$(if ($state) { $state } else { '(无作业)' }) http=$(if ($httpStatus) { $httpStatus } else { '(作业体)' }) code=$code ctx=$(if ($hasCtx) { 'yes' } else { 'no' })"
}

if (-not $InWorld) {
    Write-Host "  （未加 -InWorld：跳过世界内断言 A/N）" -ForegroundColor Yellow
} else {
    # ------------------------------------------------------------ A：正向注入与读回一致
    Write-Host "== A：正向注入 + read.te 读回一致 ==" -ForegroundColor Cyan
    $rebuild = Invoke-Caller -Action "world.rebuild" -Tier scene -Sync -OutFile (Join-Path $EvidenceDir "a0-rebuild.json") `
        -ParamsJson ("{`"folder`":`"cp_tank122_script`",`"seed`":20261007,`"void`":true,`"base`":[64,12,64],`"settleTicks`":60,`"build`":[{`"op`":`"clear`",`"from`":[63,11,63],`"to`":[70,16,70]},{`"op`":`"te`",`"at`":$($script:At),`"completer`":`"gt-machine`",`"params`":{`"machine`":`"Machine_LV_ChemicalReactor`",`"side`":`"UP`"}}],`"confirm`":true}")
    Add-Assertion "A0 world.rebuild" ($rebuild.exitCode -eq 0) "退出码 $($rebuild.exitCode)"

    $fill = Invoke-Caller -Action $script:Action -Tier scene -Sync -OutFile (Join-Path $EvidenceDir "a1-fill.json") `
        -ParamsJson ("{`"at`":$($script:At),`"fluid`":`"$Fluid`",`"amount`":$Amount,`"confirm`":true}")
    $fillRes = if ($fill.json) { $fill.json.result } else { $null }
    Add-Assertion "A1 注入退出码 0" ($fill.exitCode -eq 0) "退出码 $($fill.exitCode)"
    if ($fillRes) {
        Add-Assertion "A2 filled == amount" ($fillRes.filled -eq $Amount) "filled=$($fillRes.filled) amount=$Amount"
        Add-Assertion "A3 complete=true 且 partial=false" ($fillRes.complete -eq $true -and $fillRes.partial -eq $false) "complete=$($fillRes.complete) partial=$($fillRes.partial)"
        Add-Assertion "A4 layer=L0 semantics=fill" ($fillRes.layer -eq "L0" -and $fillRes.semantics -eq "fill") "layer=$($fillRes.layer) semantics=$($fillRes.semantics)"
        $inTank = @($fillRes.after.tanks)[0]
        Add-Assertion "A5 注入后逐罐读数 == filled" ($inTank.amount -eq $Amount) "after.tanks[0].amount=$($inTank.amount)"
        Add-Assertion "A6 逐罐读数带注册名" (-not [string]::IsNullOrWhiteSpace($inTank.fluid)) "after.tanks[0].fluid=$($inTank.fluid)"
    }

    $read = Invoke-Caller -Action "read.te" -Tier observe -Sync -OutFile (Join-Path $EvidenceDir "a7-readte.json") `
        -ParamsJson ("{`"at`":$($script:At),`"includeNbt`":false}")
    $st = if ($read.json -and $read.json.result) { $read.json.result.tiles[0].claimedState } else { $null }
    Add-Assertion "A7 read.te 认领 gt-machine" ($read.json.result.tiles[0].claimedFamily -eq "gt-machine") "claimedFamily=$($read.json.result.tiles[0].claimedFamily)"
    if ($st) {
        Add-Assertion "A8 read.te 注入量与 fill 一致（验收判据一）" ($st.tanks.tanks[0].amount -eq $Amount) "read.te /tanks/tanks/0/amount=$($st.tanks.tanks[0].amount) vs fill.filled=$($fillRes.filled)"
        Add-Assertion "A9 read.te 储罐容量 = 16000" ($st.tanks.capacity -eq 16000 -and $st.tanks.metaTileCapacity -eq 16000) "capacity=$($st.tanks.capacity) metaTileCapacity=$($st.tanks.metaTileCapacity)"
        Add-Assertion "A10 机器不是空壳" ($st.shell -eq $false -and $st.metaTileId -eq 421) "shell=$($st.shell) metaTileId=$($st.metaTileId)"
    }

    # ------------------------------------------------------------ N：负对照（世界内）
    Write-Host "== N：世界内负对照 ==" -ForegroundColor Cyan
    $negNoTe = Invoke-Caller -Action $script:Action -Tier scene -Sync -OutFile (Join-Path $EvidenceDir "n1-no-te.json") `
        -ParamsJson ("{`"at`":[$($MachineAt[0]+2),$($MachineAt[1]),$($MachineAt[2])],`"fluid`":`"$Fluid`",`"amount`":1000,`"confirm`":true}")
    $c1 = if ($negNoTe.json -and $negNoTe.json.error) { $negNoTe.json.error.code } else { $null }
    Add-Assertion "N1 非容器位置 → CP-STATE-001" ($c1 -eq "CP-STATE-001") "code=$c1"

    $negOver = Invoke-Caller -Action $script:Action -Tier scene -Sync -OutFile (Join-Path $EvidenceDir "n2-over-capacity.json") `
        -ParamsJson ("{`"at`":$($script:At),`"fluid`":`"$Fluid`",`"amount`":20000,`"confirm`":true}")
    $ov = if ($negOver.json) { $negOver.json.result } else { $null }
    if ($ov) {
        Add-Assertion "N2 超容量：部分注入如实报告（不是错误）" ($ov.partial -eq $true -and $ov.filled -lt 20000 -and $ov.complete -eq $false) "filled=$($ov.filled) partial=$($ov.partial) notFilled=$($ov.notFilled) after=$(@($ov.after.tanks)[0].amount)"
        Add-Assertion "N3 部分注入后储罐恰好满" (@($ov.after.tanks)[0].amount -eq 16000) "after.tanks[0].amount=$(@($ov.after.tanks)[0].amount)"
    }
}

# ---------------------------------------------------------------- 报告

$summary = [pscustomobject]@{
    generatedAt = (Get-Date).ToString("o")
    mcDataDir = $McDataDir
    port = $srv.port
    contractVersion = $srv.contractVersion
    action = $script:Action
    machineAt = $script:At
    failCases = $failTable
    assertions = $script:Assertions
    passCount = @($script:Assertions | Where-Object { $_.ok }).Count
    failCount = @($script:Assertions | Where-Object { -not $_.ok }).Count
}
$summary | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 (Join-Path $EvidenceDir "assertions.json")

$md = New-Object System.Text.StringBuilder
$null = $md.AppendLine("# issue #122 验收（$($script:Action)）")
$null = $md.AppendLine("")
$null = $md.AppendLine("- 生成时间：$($summary.generatedAt)")
$null = $md.AppendLine("- 端口：$($srv.port)（契约 $($srv.contractVersion)）")
$null = $md.AppendLine("- 机器坐标：$($script:At)")
$null = $md.AppendLine("")
$null = $md.AppendLine("| 断言 | 结果 | 说明 |")
$null = $md.AppendLine("|---|---|---|")
foreach ($a in $script:Assertions) {
    $null = $md.AppendLine(("| {0} | {1} | {2} |" -f $a.id, $(if ($a.ok) { "PASS" } else { "FAIL" }), ($a.detail -replace '\|', '\|')))
}
$null = $md.AppendLine("")
$null = $md.AppendLine("通过 $($summary.passCount) / 失败 $($summary.failCount)")
Set-Content -Encoding UTF8 (Join-Path $EvidenceDir "summary.md") $md.ToString()

Write-Host ""
Write-Host ("== 结果：通过 {0}，失败 {1} ==" -f $summary.passCount, $summary.failCount) -ForegroundColor $(if ($summary.failCount -eq 0) { "Green" } else { "Red" })
Write-Host "证据目录：$EvidenceDir"
if ($summary.failCount -gt 0) { exit 2 } else { exit 0 }
