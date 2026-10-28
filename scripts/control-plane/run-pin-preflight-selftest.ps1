<#
  点火前置（pauseOnLostFocus=false）的离线自检
  ============================================================================
  只跑本地文件与 PowerShell AST，不起客户端、不碰 HTTP、不碰世界。

  证明两件事：
    A. 行为：唯一写选项实现（drive-session.ps1 -PinOnly）经 shared preflight 调用后，
       缺 options 会创建、true 会改 false、重复/冲突会归一为恰好一行、CRLF 安全；
       而「options.txt 是目录 / 不可写 / drive-session 失败」必须 throw（非零），
       不可能被当成成功继续点火。
    B. 结构：对每个真正点火的驱动，用 AST（不是扫注释/字符串）证明
       preflight 的 CommandAst 在所有实际 Start-Process 之前，且位于
       try/catch 中、catch 调 Fail-Fatal；preflight 只在 if (-not $SkipClientStart) 分支内。

  用法：pwsh -File scripts/control-plane/run-pin-preflight-selftest.ps1
  退出码：0 = 全部符合预期；2 = 有自检项不符。
#>
[CmdletBinding()]
param(
    # 工作目录（缺省落在被 .gitignore 忽略的 scripts/control-plane/.out 下）
    [string]$WorkRoot = '',
    # 断言表落盘目录（缺省同上）
    [string]$ArchiveRoot = ''
)

$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

$scriptDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
if ([string]::IsNullOrWhiteSpace($WorkRoot)) { $WorkRoot = Join-Path $scriptDir '.out\pin-preflight-selftest' }
if ([string]::IsNullOrWhiteSpace($ArchiveRoot)) { $ArchiveRoot = $WorkRoot }

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$root = Join-Path $WorkRoot "run-$ts"
$archiveDir = Join-Path $ArchiveRoot "archive-$ts"
New-Item -ItemType Directory -Force -Path $root, $archiveDir | Out-Null

. (Join-Path $scriptDir 'pin-preflight.ps1')

$script:fail = 0
$results = New-Object System.Collections.ArrayList

function Check([string]$Name, [bool]$Ok, [string]$Detail) {
    if (-not $Ok) { $script:fail++ }
    $short = (([string]$Detail) -replace '\r?\n', ' ')
    if ($short.Length -gt 300) { $short = $short.Substring(0, 300) + '...' }
    [void]$results.Add([pscustomobject]@{ name = $Name; ok = $Ok; detail = $short })
    $mark = if ($Ok) { 'PASS' } else { 'FAIL' }
    $color = if ($Ok) { 'Green' } else { 'Red' }
    Write-Host ("  [{0}] {1,-54} {2}" -f $mark, $Name, $Detail) -ForegroundColor $color
}

function New-CaseDir([string]$Name) {
    $d = Join-Path $root $Name
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    return $d
}

function Write-OptionsCrlf([string]$Path, [string[]]$Lines) {
    $nl = [string][char]13 + [string][char]10
    [System.IO.File]::WriteAllText($Path, (($Lines -join $nl) + $nl), (New-Object System.Text.UTF8Encoding $false))
}

function Read-OptionLines([string]$Path) { return @([System.IO.File]::ReadAllLines($Path)) }

function Get-PinLines([string]$Path) {
    return @(Read-OptionLines $Path | Where-Object { $_.TrimEnd() -match '^pauseOnLostFocus:' } | ForEach-Object { $_.TrimEnd() })
}

# ---------------------------------------------------------------------------
# A. 行为：钉 + 回读自证 / 失败必须阻断
# ---------------------------------------------------------------------------
Write-Host '== A. 功能：钉 pauseOnLostFocus=false 且回读自证 ==' -ForegroundColor Cyan

# A1 缺 options.txt → 创建一行 false
$d1 = New-CaseDir 'a1-missing'
$pin1 = Invoke-PauseOnLostFocusPreflight -RunDir $d1 -Tag 'selftest'
$l1 = @(Get-PinLines $pin1.optionsPath)
Check 'A1 缺 options.txt → 创建恰好一行 false' ($l1.Count -eq 1 -and $l1[0] -ceq 'pauseOnLostFocus:false') ("exit=" + $pin1.exitCode + " lines=[" + ($l1 -join ' | ') + "]")
Check 'A1b 证据行含「已钉」+「回读」+false' (($pin1.evidenceLine -match '已钉') -and ($pin1.evidenceLine -match '回读') -and ($pin1.evidenceLine -match 'pauseOnLostFocus:false')) $pin1.evidenceLine
Check 'A1c 证据对象自报回读恰 1 行且值为 false' ($pin1.readbackCount -eq 1 -and $pin1.readbackLine -ceq 'pauseOnLostFocus:false') ("readbackCount=" + $pin1.readbackCount)

# A2 幂等：再钉一次仍恰好一行
$pin2 = Invoke-PauseOnLostFocusPreflight -RunDir $d1 -Tag 'selftest'
$l2 = @(Get-PinLines $pin2.optionsPath)
Check 'A2 重复调用幂等（仍恰好一行 false）' ($l2.Count -eq 1 -and $l2[0] -ceq 'pauseOnLostFocus:false') ("lines=[" + ($l2 -join ' | ') + "]")

# A3 已有 true → 改 false，其它行原样保留
$d3 = New-CaseDir 'a3-true'
Write-OptionsCrlf (Join-Path $d3 'options.txt') @('fov:0', 'pauseOnLostFocus:true', 'lang:zh_CN')
$pin3 = Invoke-PauseOnLostFocusPreflight -RunDir $d3 -Tag 'selftest'
$lines3 = @(Read-OptionLines $pin3.optionsPath)
$pl3 = @(Get-PinLines $pin3.optionsPath)
Check 'A3 已有 true → 改 false，其它行原样保留' ($pl3.Count -eq 1 -and $pl3[0] -ceq 'pauseOnLostFocus:false' -and ($lines3 -contains 'fov:0') -and ($lines3 -contains 'lang:zh_CN') -and $lines3.Count -eq 3) ("lines=[" + ($lines3 -join ' | ') + "]")

# A4 重复/冲突（CRLF）→ 归一为恰好一行
$d4 = New-CaseDir 'a4-dupes'
Write-OptionsCrlf (Join-Path $d4 'options.txt') @('pauseOnLostFocus:true', 'fov:0', 'pauseOnLostFocus:false', 'pauseOnLostFocus:true', 'lang:zh_CN')
$pin4 = Invoke-PauseOnLostFocusPreflight -RunDir $d4 -Tag 'selftest'
$lines4 = @(Read-OptionLines $pin4.optionsPath)
$pl4 = @(Get-PinLines $pin4.optionsPath)
Check 'A4 重复/冲突 → 归一且回读恰一行 false（CRLF 安全）' ($pl4.Count -eq 1 -and $pl4[0] -ceq 'pauseOnLostFocus:false' -and $lines4.Count -eq 3 -and ($lines4 -contains 'fov:0') -and ($lines4 -contains 'lang:zh_CN')) ("lines=[" + ($lines4 -join ' | ') + "]")
Check 'A4b 回读行没有夹带 CR（TrimEnd 后逐字等于 false）' ($pin4.readbackLine -ceq 'pauseOnLostFocus:false') ("readback=[" + $pin4.readbackLine + "]")

# A5 options.txt 是目录 → throw
$d5 = New-CaseDir 'a5-dir'
New-Item -ItemType Directory -Force -Path (Join-Path $d5 'options.txt') | Out-Null
$threw5 = $false; $msg5 = ''
try { [void](Invoke-PauseOnLostFocusPreflight -RunDir $d5 -Tag 'selftest') } catch { $threw5 = $true; $msg5 = $_.Exception.Message }
Check 'A5 options.txt 为目录 → throw（非零阻断，不点火）' ($threw5 -and ($msg5 -match '钉选项') -and ($msg5 -match '目录|不是普通文件')) $msg5
Check 'A5b 目录未被替换成文件（没有假装钉住）' (Test-Path -LiteralPath (Join-Path $d5 'options.txt') -PathType Container) 'options.txt 仍是目录'

# A6 options.txt 只读 → throw，且内容未被改写
$d6 = New-CaseDir 'a6-readonly'
$f6 = Join-Path $d6 'options.txt'
Write-OptionsCrlf $f6 @('pauseOnLostFocus:true')
Set-ItemProperty -LiteralPath $f6 -Name IsReadOnly -Value $true
$threw6 = $false; $msg6 = ''
try { [void](Invoke-PauseOnLostFocusPreflight -RunDir $d6 -Tag 'selftest') } catch { $threw6 = $true; $msg6 = $_.Exception.Message }
$after6 = @(Get-PinLines $f6)
Check 'A6 options.txt 只读 → throw（不静默成功）' ($threw6 -and ($msg6 -match '钉选项') -and ($msg6 -match '退出码|失败')) $msg6
Check 'A6b 只读失败后内容仍是 true（未被改写）' ($after6.Count -eq 1 -and $after6[0] -ceq 'pauseOnLostFocus:true') ("lines=[" + ($after6 -join ' | ') + "]")
Set-ItemProperty -LiteralPath $f6 -Name IsReadOnly -Value $false

# A7 drive-session 本身失败（exit 3）→ throw；失败路径不得产出 options.txt
$d7 = New-CaseDir 'a7-driver-fail'
$stub = Join-Path $root 'stub-driver-fail.ps1'
[System.IO.File]::WriteAllText($stub, 'Write-Output "stub: 模拟钉选项失败"; exit 3', (New-Object System.Text.UTF8Encoding $false))
$threw7 = $false; $msg7 = ''
try { [void](Invoke-PauseOnLostFocusPreflight -RunDir $d7 -Tag 'selftest' -DriveSessionPath $stub) } catch { $threw7 = $true; $msg7 = $_.Exception.Message }
Check 'A7 drive-session 失败（exit 3）→ throw 且信息含退出码 3' ($threw7 -and ($msg7 -match '退出码 3')) $msg7
Check 'A7b 失败路径不产出 options.txt（不假装钉住）' (-not (Test-Path -LiteralPath (Join-Path $d7 'options.txt'))) 'options.txt 不存在'

# ---------------------------------------------------------------------------
# B. AST 工具
# ---------------------------------------------------------------------------
function Get-Ast([string]$Path) {
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
    return [pscustomobject]@{ Ast = $ast; Errors = @($errors) }
}

function Get-CommandAsts($Ast) {
    return @($Ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true))
}

function Test-NodeInside($Node, $Parent) {
    return ($Node.Extent.StartOffset -ge $Parent.Extent.StartOffset -and $Node.Extent.EndOffset -le $Parent.Extent.EndOffset)
}

function Get-EnclosingIfs($Node) {
    $out = New-Object System.Collections.ArrayList
    $p = $Node.Parent
    while ($null -ne $p) {
        if ($p -is [System.Management.Automation.Language.IfStatementAst]) {
            $branch = $null; $cond = $null
            foreach ($c in $p.Clauses) {
                if (Test-NodeInside $Node $c.Item2) { $branch = 'then'; $cond = $c.Item1.Extent.Text; break }
            }
            if ($null -eq $branch -and $null -ne $p.ElseClause -and (Test-NodeInside $Node $p.ElseClause)) { $branch = 'else'; $cond = 'else' }
            if ($null -ne $branch) {
                [void]$out.Add([pscustomobject]@{ condition = $cond; branch = $branch; line = $p.Extent.StartLineNumber })
            }
        }
        if ($p -is [System.Management.Automation.Language.FunctionDefinitionAst]) { break }
        $p = $p.Parent
    }
    return $out
}

function Get-EnclosingTryWithCatch($Node) {
    $p = $Node.Parent
    while ($null -ne $p) {
        if ($p -is [System.Management.Automation.Language.TryStatementAst] -and $p.CatchClauses.Count -gt 0) { return $p }
        if ($p -is [System.Management.Automation.Language.FunctionDefinitionAst]) { break }
        $p = $p.Parent
    }
    return $null
}

function Get-ClientStartCommands($Ast) {
    # 「实际点火」= Start-Process 的实参里带 runClient/runTask；静态门禁（gradleArgs）不在其中
    return @(Get-CommandAsts $Ast | Where-Object {
            $_.CommandElements.Count -gt 0 -and
            $_.CommandElements[0].Extent.Text -eq 'Start-Process' -and
            $_.Extent.Text -match 'runClient|runTask'
        })
}

# ---------------------------------------------------------------------------
# B. 结构：preflight 在点火之前，且失败有阻断
# ---------------------------------------------------------------------------
Write-Host '== B. 结构：每个驱动的 preflight 先于 Start-Process，失败可阻断 ==' -ForegroundColor Cyan

$drivers = @(
    [pscustomobject]@{ file = 'run-smoke.ps1'; tag = 'smoke' },
    [pscustomobject]@{ file = 'run-shots.ps1'; tag = 'shots' },
    [pscustomobject]@{ file = 'run-anchor.ps1'; tag = 'anchor' },
    [pscustomobject]@{ file = 'run-input-acceptance.ps1'; tag = 'input' },
    [pscustomobject]@{ file = 'run-one-shot.ps1'; tag = 'oneshot' }
)
$inventory = New-Object System.Collections.ArrayList

foreach ($drv in $drivers) {
    $path = Join-Path $scriptDir $drv.file
    Check ("B0 " + $drv.file + " 存在") (Test-Path -LiteralPath $path -PathType Leaf) $path
    $parsed = Get-Ast $path
    Check ("B0b " + $drv.file + " 语法可解析") ($parsed.Errors.Count -eq 0) (($parsed.Errors | ForEach-Object { $_.Message + '@' + $_.Extent.StartLineNumber }) -join '; ')

    $cmds = Get-CommandAsts $parsed.Ast
    $pins = @($cmds | Where-Object { $_.Extent.Text -match 'Invoke-PauseOnLostFocusPreflight' })
    $sps = Get-ClientStartCommands $parsed.Ast
    Check ("B0c " + $drv.file + " 恰有 1 处 preflight 调用") ($pins.Count -eq 1) ("count=" + $pins.Count)
    Check ("B0d " + $drv.file + " 恰有 1 处实际 runClient 点火") ($sps.Count -eq 1) ("count=" + $sps.Count)

    if ($pins.Count -eq 1 -and $sps.Count -eq 1) {
        $pin = $pins[0]
        $sp = $sps[0]
        Check ("B1 " + $drv.file + " preflight 行 < Start-Process 行") ($pin.Extent.StartLineNumber -lt $sp.Extent.StartLineNumber) ("pin@" + $pin.Extent.StartLineNumber + " < sp@" + $sp.Extent.StartLineNumber)

        $try = Get-EnclosingTryWithCatch $pin
        $catchText = if ($null -ne $try) { (($try.CatchClauses | ForEach-Object { $_.Body.Extent.Text }) -join ' ') } else { '' }
        Check ("B2 " + $drv.file + " preflight 失败有阻断（catch 调 Fail-Fatal）") ($null -ne $try -and $catchText -match 'Fail-Fatal') ("try@" + $(if ($null -ne $try) { $try.Extent.StartLineNumber } else { '-' }) + " catch=" + $(if ($catchText -match 'Fail-Fatal') { 'Fail-Fatal' } else { '缺失' }))

        $ifs = Get-EnclosingIfs $pin
        $guard = @($ifs | Where-Object { $_.branch -eq 'then' -and $_.condition -match 'SkipClientStart' -and $_.condition -match '-not' })
        Check ("B3 " + $drv.file + " preflight 只在 if (-not SkipClientStart) 分支") ($guard.Count -ge 1) (($ifs | ForEach-Object { $_.branch + ':' + $_.condition }) -join ' ;; ')
        $checksOnly = @($ifs | Where-Object { $_.branch -eq 'then' -and $_.condition -match 'ChecksOnly' })
        Check ("B4 " + $drv.file + " preflight 不在 ChecksOnly 分支") ($checksOnly.Count -eq 0) ("ChecksOnly-branch=" + $checksOnly.Count)

        $spIfs = Get-EnclosingIfs $sp
        $spGuard = @($spIfs | Where-Object { $_.branch -eq 'then' -and $_.condition -match 'SkipClientStart' -and $_.condition -match '-not' })
        Check ("B5 " + $drv.file + " Start-Process 同属点火分支") ($spGuard.Count -ge 1) (($spIfs | ForEach-Object { $_.branch + ':' + $_.condition }) -join ' ;; ')

        [void]$inventory.Add([pscustomobject]@{
                driver = $drv.file
                tag = $drv.tag
                preflightLine = $pin.Extent.StartLineNumber
                startProcessLine = $sp.Extent.StartLineNumber
                blockingCatchLine = if ($null -ne $try) { $try.Extent.StartLineNumber } else { $null }
                skipGuard = ($guard.Count -ge 1)
            })
    }
}

# ---------------------------------------------------------------------------
# C. 清单：所有实际点火入口都在保护内；不点火的驱动不接线
# ---------------------------------------------------------------------------
Write-Host '== C. 清单：点火入口完整、无漏网 ==' -ForegroundColor Cyan

$scanDirs = @($scriptDir, (Join-Path $repoRoot 'scripts\acceptance'))
$launchers = New-Object System.Collections.ArrayList
foreach ($dir in $scanDirs) {
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { continue }
    foreach ($file in @(Get-ChildItem -LiteralPath $dir -Filter '*.ps1' -File)) {
        $parsed = Get-Ast $file.FullName
        foreach ($cmd in (Get-ClientStartCommands $parsed.Ast)) {
            [void]$launchers.Add([pscustomobject]@{ file = $file.Name; line = $cmd.Extent.StartLineNumber })
        }
    }
}
$actual = @($launchers | ForEach-Object { $_.file } | Sort-Object -Unique)
$expected = @('run-smoke.ps1', 'run-shots.ps1', 'run-anchor.ps1', 'run-input-acceptance.ps1', 'run-one-shot.ps1') | Sort-Object
Check 'C1 实际 runClient 点火入口恰为 5 个受保护驱动' (($actual -join ',') -eq ($expected -join ',')) ("actual=[" + ($actual -join ',') + "]")
foreach ($group in @($launchers | Group-Object -Property file)) {
    Check ("C2 " + $group.Name + " 恰有 1 处点火（无重复 Start-Process）") ($group.Count -eq 1) ("count=" + $group.Count + " lines=" + ((@($group.Group) | ForEach-Object { $_.line }) -join ','))
}

foreach ($n in @('run-read-surface.ps1', 'run-tank-fill.ps1')) {
    $parsed = Get-Ast (Join-Path $scriptDir $n)
    $sps = @(Get-CommandAsts $parsed.Ast | Where-Object { $_.CommandElements.Count -gt 0 -and $_.CommandElements[0].Extent.Text -eq 'Start-Process' })
    $pins = @(Get-CommandAsts $parsed.Ast | Where-Object { $_.Extent.Text -match 'Invoke-PauseOnLostFocusPreflight' })
    Check ("C3 " + $n + " 不点火：无 Start-Process 也无 preflight 写入") ($sps.Count -eq 0 -and $pins.Count -eq 0) ("Start-Process=" + $sps.Count + " preflight=" + $pins.Count)
}

$gates = Get-Ast (Join-Path $scriptDir 'run-static-gates.ps1')
$gateSps = @(Get-CommandAsts $gates.Ast | Where-Object { $_.CommandElements.Count -gt 0 -and $_.CommandElements[0].Extent.Text -eq 'Start-Process' })
$gateClient = Get-ClientStartCommands $gates.Ast
Check 'C4 run-static-gates 的 gradlew 调用不是 runClient（选择器不误伤）' ($gateSps.Count -eq 1 -and $gateClient.Count -eq 0) ("Start-Process=" + $gateSps.Count + " client=" + $gateClient.Count)

# ---------------------------------------------------------------------------
# D. AST 忽略注释/字符串：注释里的 Start-Process 不算命令
# ---------------------------------------------------------------------------
Write-Host '== D. AST 只认 CommandAst（注释/字符串不算点火） ==' -ForegroundColor Cyan

$probe = Join-Path $root 'comment-probe.ps1'
[System.IO.File]::WriteAllText($probe, @'
# Start-Process -FilePath gradlew -ArgumentList runClient25
# Invoke-PauseOnLostFocusPreflight -RunDir x
$s = "Start-Process runClient25"
Write-Output $s
'@, (New-Object System.Text.UTF8Encoding $false))
$probeAst = Get-Ast $probe
$probeSp = @(Get-CommandAsts $probeAst.Ast | Where-Object { $_.CommandElements.Count -gt 0 -and $_.CommandElements[0].Extent.Text -eq 'Start-Process' })
$probePin = @(Get-CommandAsts $probeAst.Ast | Where-Object { $_.Extent.Text -match 'Invoke-PauseOnLostFocusPreflight' })
Check 'D1 注释/字符串里的 Start-Process 与 preflight 都不是 CommandAst' ($probeSp.Count -eq 0 -and $probePin.Count -eq 0) ("Start-Process=" + $probeSp.Count + " preflight=" + $probePin.Count)

foreach ($n in @('run-smoke.ps1', 'run-shots.ps1', 'run-anchor.ps1')) {
    $text = Get-Content -LiteralPath (Join-Path $scriptDir $n) -Raw
    $rawCount = ([regex]::Matches($text, 'Start-Process')).Count
    $parsed = Get-Ast (Join-Path $scriptDir $n)
    $cmdCount = @(Get-CommandAsts $parsed.Ast | Where-Object { $_.CommandElements.Count -gt 0 -and $_.CommandElements[0].Extent.Text -eq 'Start-Process' }).Count
    Check ("D2 " + $n + " 原文出现 " + $rawCount + " 次但 AST 只认 1 次命令") ($rawCount -gt $cmdCount -and $cmdCount -eq 1) ("raw=" + $rawCount + " ast=" + $cmdCount)
}

# ---------------------------------------------------------------------------
# E. 唯一写实现：helper 自己不写文件；.mjs 只连不点火
# ---------------------------------------------------------------------------
Write-Host '== E. 唯一写实现与只连不点火 ==' -ForegroundColor Cyan

$helperAst = Get-Ast (Join-Path $scriptDir 'pin-preflight.ps1')
$writes = @(Get-CommandAsts $helperAst.Ast | Where-Object {
        $_.CommandElements.Count -gt 0 -and $_.CommandElements[0].Extent.Text -match '^(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item)$'
    })
Check 'E1 pin-preflight.ps1 自己不写文件（唯一写选项实现仍是 drive-session.ps1）' ($writes.Count -eq 0) ("write-cmds=" + $writes.Count)
$helperText = Get-Content -LiteralPath (Join-Path $scriptDir 'pin-preflight.ps1') -Raw
Check 'E2 helper 调用的是 drive-session.ps1 -PinOnly' (($helperText -match 'drive-session\.ps1') -and ($helperText -match '-PinOnly')) 'delegate=drive-session.ps1 -PinOnly'

$bt = Get-Content -LiteralPath (Join-Path $scriptDir 'bake-truth-acceptance.mjs') -Raw
Check 'E3 bake-truth-acceptance.mjs 只连已运行客户端（无 child_process）' (-not ($bt -match 'child_process')) 'no child_process import'
Check 'E4 bake-truth-acceptance.mjs 保留自己的前置校验（读 options.txt 的 pauseOnLostFocus）' (($bt -match 'pauseOnLostFocus') -and ($bt -match 'options')) 'preflight kept'

# ---------------------------------------------------------------------------
# 归档与退出
# ---------------------------------------------------------------------------
$report = [pscustomobject]@{
    generatedAt = (Get-Date).ToString('o')
    repoRoot = $repoRoot
    total = $results.Count
    failed = $script:fail
    inventory = @($inventory)
    results = @($results)
}
($report | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath (Join-Path $archiveDir 'assertions.json') -Encoding utf8NoBOM

$md = New-Object System.Collections.ArrayList
[void]$md.Add('# 点火前置（pauseOnLostFocus）离线自检')
[void]$md.Add('')
[void]$md.Add('- 时间: ' + $report.generatedAt)
[void]$md.Add('- 断言: ' + $report.total + ' 条，失败 ' + $report.failed + ' 条')
[void]$md.Add('')
[void]$md.Add('| 驱动 | preflight 行 | Start-Process 行 | 阻断 catch 行 | 仅在点火分支 |')
[void]$md.Add('|---|---|---|---|---|')
foreach ($i in @($inventory)) {
    [void]$md.Add('| ' + $i.driver + ' | ' + $i.preflightLine + ' | ' + $i.startProcessLine + ' | ' + $i.blockingCatchLine + ' | ' + $i.skipGuard + ' |')
}
[void]$md.Add('')
[void]$md.Add('| 断言 | 结果 | 说明 |')
[void]$md.Add('|---|---|---|')
foreach ($r in $results) {
    $d = ([string]$r.detail) -replace '\|', '\|'
    [void]$md.Add('| ' + $r.name + ' | ' + $(if ($r.ok) { 'PASS' } else { 'FAIL' }) + ' | ' + $d + ' |')
}
[void]$md.Add('')
[void]$md.Add('证据行: ' + $pin1.evidenceLine)
($md | Set-Content -LiteralPath (Join-Path $archiveDir 'summary.md') -Encoding utf8NoBOM)

Write-Host ''
Write-Host ('== 自检结果：' + $results.Count + ' 条，失败 ' + $script:fail + ' 条') -ForegroundColor $(if ($script:fail -eq 0) { 'Green' } else { 'Red' })
Write-Host ('   证据行: ' + $pin1.evidenceLine)
Write-Host ('   断言表: ' + (Join-Path $archiveDir 'assertions.json'))
if ($script:fail -gt 0) { exit 2 }
exit 0
