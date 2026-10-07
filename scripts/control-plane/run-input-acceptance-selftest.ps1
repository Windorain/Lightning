<#
  run-input-acceptance.ps1 的离线行为自检（不起客户端、不碰 HTTP、不碰世界、不写归档）
  ============================================================================
  用**合成夹具**（fixtures）逐条喂 input-acceptance-checks.ps1 的纯判定函数，证明两件事：
    ① 好数据 → 绿（正向口径没写反）；
    ② 坏数据 → 红，且红得**精确**（重投 / 三类参数负对照 / 文本假绿 / W4 的两种失败形态 /
       means 泄漏 / 能力面空目录 / 命中集占位）。

  这是「判据与断言不会恒绿」的离线证据；真机轮次由 run-input-acceptance.ps1 承担。
  夹具全部是**作业 JSON / 错误信封 / 读面 JSON** 的字面量——与 caller.mjs 的 --json-out 同形状。

  用法：pwsh -File scripts/control-plane/run-input-acceptance-selftest.ps1
  可选：-CaseValidateReport <path>  把（临时）CaseValidator 离线校验报告并入报告（不作为 pass 依据）
  退出码：0 = 全部符合预期；2 = 有自检项不符（红绿表列出）。
#>
[CmdletBinding()]
param(
    # 合成夹具与报告的落点（默认工作区 temp 下，不落工作树）
    [string]$WorkRoot = 'D:\Workspace\Lightning\temp\cp-input-acceptance-selftest',
    # （可选）真实 CaseValidator 的离线校验报告（由临时测试写出）；只并入报告，不作判据
    [string]$CaseValidateReport = 'D:\Workspace\Lightning\temp\cp-input-acceptance\case-validate.json'
)

$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

. (Join-Path $PSScriptRoot 'input-acceptance-checks.ps1')

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$outDir = Join-Path $WorkRoot $ts
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$script:results = New-Object System.Collections.ArrayList
function Check([string]$Name, [bool]$Ok, [string]$Detail) {
    [void]$script:results.Add([pscustomobject]@{ name = $Name; ok = $Ok; detail = $Detail })
    $mark = if ($Ok) { 'PASS' } else { 'FAIL' }
    $color = if ($Ok) { 'Green' } else { 'Red' }
    Write-Host ("   [{0}] {1,-52} {2}" -f $mark, $Name, $Detail) -ForegroundColor $color
}
# 期望某判据在给定数据上「绿 / 红 / 跳过 / 阻塞」
function Expect([string]$Name, $Result, [string]$WantStatus) {
    $got = "$($Result.status)"
    $ok = ($got -eq $WantStatus)
    Check "$Name（期望 $WantStatus）" $ok ("实际 status={0} ok={1}；{2}" -f $got, $Result.ok, [string]$Result.detail)
}
function ExpectArray([string]$Name, $Items, [string]$WantStatusJoined) {
    $got = (@($Items) | ForEach-Object { "$($_.status)" }) -join ','
    $ok = ($got -eq $WantStatusJoined)
    Check "$Name（期望 $WantStatusJoined）" $ok ("实际 status=$got；" + ((@($Items) | ForEach-Object { "$($_.id):$($_.detail)" }) -join ' || '))
}

# ---------------------------------------------------------------------------
# 合成夹具：调用（trial）构造器
#   trial = @{ label; exitCode; json }  —— json 的形状与 caller.mjs 的 --json-out 文件逐字相同
# ---------------------------------------------------------------------------
function New-DoneTrial {
    param([string]$Label, $Result)
    return [pscustomobject]@{ label = $Label; exitCode = 0; json = [pscustomobject]@{ jobId = 'j1'; state = 'done'; result = $Result } }
}
function New-FailedTrial {
    param([string]$Label, [string]$Code, [string]$Message = 'x', $Context = $null)
    $err = [pscustomobject]@{ code = $Code; message = $Message }
    if ($null -ne $Context) { $err | Add-Member -NotePropertyName context -NotePropertyValue $Context -Force }
    return [pscustomobject]@{ label = $Label; exitCode = 2; json = [pscustomobject]@{ jobId = 'j2'; state = 'failed'; error = $err } }
}
function New-SubmitRejectTrial {
    param([string]$Label, [string]$Code, [string]$Message = 'x')
    return [pscustomobject]@{ label = $Label; exitCode = 1; json = [pscustomobject]@{ ok = $false; httpStatus = 400; error = [pscustomobject]@{ code = $Code; message = $Message } } }
}
function New-KeyResult {
    param(
        [int]$Delivered = 1, [bool]$AlreadyHeld = $false, [int]$HeldCount = 1, [string]$Action = 'down',
        [string]$JobId = 'j7', [int]$HoldTicks = 0, $AutoReleased = @(), $Released = @(), $Events = @(),
        $PhysicalConcurrent = $false, $Consumer = $null
    )
    if ($null -eq $Consumer) {
        $Consumer = [pscustomobject]@{ chain = 'world'; currentScreen = $null; allowUserInput = $false; displayActive = $false; inGameHasFocus = $false }
    }
    $r = [pscustomobject]@{
        means = 'input'; semantics = 'key'; layer = $null; key = 'key.forward'; keyCode = 17; action = $Action
        delivered = $Delivered; alreadyHeld = $AlreadyHeld; wasHeld = $false
        held = [pscustomobject]@{ count = $HeldCount; items = @([pscustomobject]@{ kind = 'key'; id = 'key.forward'; jobId = $JobId; heldTicks = 0 }) }
        autoReleased = @($AutoReleased); released = @($Released); events = @($Events)
        physicalConcurrent = $PhysicalConcurrent; consumer = $Consumer
    }
    if ($HoldTicks -gt 0) { $r | Add-Member -NotePropertyName holdTicks -NotePropertyValue $HoldTicks -Force }
    return $r
}
function New-StateResult {
    param(
        [int]$ActionCount = 5, [switch]$EmptyCatalog, $KeyCodeRange = @(0, 255),
        [string]$MouseDepth = 'unobservable', [int]$HeldCount = 0, $Actions = $null
    )
    if ($null -eq $Actions) {
        $Actions = if ($ActionCount -eq 5) { @('input.key', 'input.text', 'input.mouse', 'input.release', 'input.state') } else { @() }
    }
    $cat = [pscustomobject]@{ 'key.forward' = 17; 'key.sneak' = 42 }
    if ($EmptyCatalog) { $cat = [pscustomobject]@{} }
    return [pscustomobject]@{
        implemented = $true; family = 'input'; means = 'input'
        actions = @($Actions)
        keyCatalog = $cat
        keyCodeRange = $KeyCodeRange
        queues = [pscustomobject]@{ keyboardDepth = 1; keyboardSeedBaseline = 1; keyboardCapacity = 256; mouseDepth = $MouseDepth }
        held = [pscustomobject]@{ count = $HeldCount; items = @() }
        coordinates = [pscustomobject]@{ displayWidth = 854; displayHeight = 480; scaledWidth = 427; scaledHeight = 240; pixelScale = 1.0; scaleFactor = 2; guiScaleSetting = 2; windowWidth = 854; windowHeight = 480 }
    }
}
function New-Catalog {
    param([int]$ExtraCount = 43, [switch]$LeakMeans, [int]$InputTierScene = 4, [switch]$CountMismatch)
    $list = New-Object System.Collections.ArrayList
    foreach ($n in @('input.key', 'input.mouse', 'input.text', 'input.release')) {
        [void]$list.Add([pscustomobject]@{ name = $n; tier = 'scene'; writable = $true; confirmRequired = $true; since = '1.8'; means = 'input' })
    }
    [void]$list.Add([pscustomobject]@{ name = 'input.state'; tier = 'observe'; writable = $false; confirmRequired = $false; since = '1.8'; means = 'input' })
    $i = 0
    foreach ($n in @('core.ping', 'core.status', 'world.info')) {
        $i++
        $o = [pscustomobject]@{ name = "other.$i"; tier = 'observe'; writable = $false; confirmRequired = $false; since = '1.0' }
        if ($LeakMeans -and $i -eq 1) { $o = [pscustomobject]@{ name = "other.$i"; tier = 'observe'; writable = $false; confirmRequired = $false; since = '1.0'; means = 'api' } }
        [void]$list.Add($o)
    }
    for ($k = $i; $k -lt $ExtraCount; $k++) {
        [void]$list.Add([pscustomobject]@{ name = "other.$($k + 1)"; tier = 'observe'; writable = $false; confirmRequired = $false; since = '1.0' })
    }
    $count = $list.Count
    if ($CountMismatch) { $count = $count - 1 }
    return [pscustomobject]@{ contractVersion = '1.8'; count = $count; actions = @($list) }
}

function New-MouseResult {
    param([string]$Op = 'move', [int]$Delivered = 1, [bool]$WithinTolerance = $true, [double]$GuiX = 213, [double]$GuiY = 120, [double]$ReqX = 213, [double]$ReqY = 120, $HitSet = $null, $PhysicalConcurrent = 'unobservable')
    $r = [pscustomobject]@{
        means = 'input'; semantics = 'mouse'; layer = $null; op = $Op; delivered = $Delivered
        requested = [pscustomobject]@{ space = 'gui-scaled'; x = $ReqX; y = $ReqY }
        readback = [pscustomobject]@{ space = 'gui-scaled-observed'; requestedX = $ReqX; requestedY = $ReqY; tolerancePx = 1; mouseX = $GuiX; mouseY = $GuiY; guiX = $GuiX; guiY = $GuiY; withinTolerance = $WithinTolerance }
        held = [pscustomobject]@{ count = 0; items = @() }
        physicalConcurrent = $PhysicalConcurrent
    }
    if ($null -ne $HitSet) { $r | Add-Member -NotePropertyName hitSet -NotePropertyValue $HitSet -Force }
    return $r
}

# ---------------------------------------------------------------------------
# 逐项自检
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host "== [CP-INPUT-SELFTEST] 离线判据自检（$ts）" -ForegroundColor Cyan

Write-Host '-- P0 options.txt 的 pauseOnLostFocus' -ForegroundColor DarkCyan
Expect 'P0 已钉 false'        (Test-InputP0PauseOnLostFocus -OptionsText "fov:0`npauseOnLostFocus:false`nlang:zh_CN") 'pass'
Expect 'P0 缺失该行'          (Test-InputP0PauseOnLostFocus -OptionsText "fov:0`nlang:zh_CN") 'fail'
Expect 'P0 值为 true'         (Test-InputP0PauseOnLostFocus -OptionsText "pauseOnLostFocus:true") 'fail'
Expect 'P0 两行冲突'          (Test-InputP0PauseOnLostFocus -OptionsText "pauseOnLostFocus:true`npauseOnLostFocus:false") 'fail'
Expect 'P0 文本为空'          (Test-InputP0PauseOnLostFocus -OptionsText '') 'fail'

Write-Host '-- P1 契约版本' -ForegroundColor DarkCyan
Expect 'P1 1.8'               (Test-InputP1ContractVersion -ServerJson ([pscustomobject]@{ port = 23314; contractVersion = '1.8' })) 'pass'
Expect 'P1 1.7（旧）'          (Test-InputP1ContractVersion -ServerJson ([pscustomobject]@{ port = 23314; contractVersion = '1.7' })) 'fail'
Expect 'P1 无 server.json'     (Test-InputP1ContractVersion -ServerJson $null) 'fail'

Write-Host '-- P2 动作目录' -ForegroundColor DarkCyan
Expect 'P2 好目录'            (Test-InputP2ActionCatalog -Catalog (New-Catalog)) 'pass'
$badTier = New-Catalog
$badTier.actions[0].tier = 'observe'
Expect 'P2 input.key tier 漂移' (Test-InputP2ActionCatalog -Catalog $badTier) 'fail'
$badSince = New-Catalog
$badSince.actions[4].since = '1.7'
Expect 'P2 input.state since 旧' (Test-InputP2ActionCatalog -Catalog $badSince) 'fail'
$badMeans = New-Catalog
$badMeans.actions[3].means = 'api'
Expect 'P2 input.release means 漂移' (Test-InputP2ActionCatalog -Catalog $badMeans) 'fail'
Expect 'P2 count 漂移'        (Test-InputP2ActionCatalog -Catalog (New-Catalog -CountMismatch)) 'fail'
$missingAction = New-Catalog
$missingAction.actions = @($missingAction.actions | Where-Object { $_.name -ne 'input.text' })
$missingAction.count = $missingAction.actions.Count
Expect 'P2 缺 input.text'     (Test-InputP2ActionCatalog -Catalog $missingAction) 'fail'

Write-Host '-- P3 means 不泄漏' -ForegroundColor DarkCyan
Expect 'P3 无泄漏'            (Test-InputP3MeansNotLeaked -Catalog (New-Catalog)) 'pass'
Expect 'P3 means 泄漏一个'     (Test-InputP3MeansNotLeaked -Catalog (New-Catalog -LeakMeans)) 'fail'

Write-Host '-- M1/M2 幂等（负对照：重投）' -ForegroundColor DarkCyan
Expect 'M1 down 好数据'        (Test-InputM1KeyDown -Trial (New-DoneTrial 'm1' (New-KeyResult -Delivered 1 -HeldCount 1 -Action down))) 'pass'
Expect 'M1 delivered=0'       (Test-InputM1KeyDown -Trial (New-DoneTrial 'm1' (New-KeyResult -Delivered 0 -HeldCount 1))) 'fail'
Expect 'M1 held 空'           (Test-InputM1KeyDown -Trial (New-DoneTrial 'm1' (New-KeyResult -Delivered 1 -HeldCount 0))) 'fail'
Expect 'M1 jobId 空'          (Test-InputM1KeyDown -Trial (New-DoneTrial 'm1' (New-KeyResult -Delivered 1 -HeldCount 1 -JobId ''))) 'fail'
Expect 'M2 幂等好数据'         (Test-InputM2KeyDownIdempotent -Trial (New-DoneTrial 'm2' (New-KeyResult -Delivered 0 -AlreadyHeld $true -HeldCount 1))) 'pass'
Expect 'M2 重投（delivered=1）' (Test-InputM2KeyDownIdempotent -Trial (New-DoneTrial 'm2' (New-KeyResult -Delivered 1 -AlreadyHeld $false -HeldCount 1))) 'fail'
Expect 'M2 alreadyHeld=false' (Test-InputM2KeyDownIdempotent -Trial (New-DoneTrial 'm2' (New-KeyResult -Delivered 0 -AlreadyHeld $false -HeldCount 1))) 'fail'
Expect 'M2 held.count=2'      (Test-InputM2KeyDownIdempotent -Trial (New-DoneTrial 'm2' (New-KeyResult -Delivered 0 -AlreadyHeld $true -HeldCount 2))) 'fail'

Write-Host '-- M3 release 幂等' -ForegroundColor DarkCyan
$rel1 = New-DoneTrial 'm3a' ([pscustomobject]@{ count = 1; alreadyIdle = $false; delivered = 1 })
$rel2 = New-DoneTrial 'm3b' ([pscustomobject]@{ count = 0; alreadyIdle = $true; delivered = 0 })
Expect 'M3 全清 + 幂等'        (Test-InputM3Release -First $rel1 -Second $rel2) 'pass'
Expect 'M3 第一次 count=0'     (Test-InputM3Release -First (New-DoneTrial 'm3a' ([pscustomobject]@{ count = 0; alreadyIdle = $true })) -Second $rel2) 'fail'
Expect 'M3 第二次 count=1'     (Test-InputM3Release -First $rel1 -Second (New-DoneTrial 'm3b' ([pscustomobject]@{ count = 1; alreadyIdle = $false }))) 'fail'
Expect 'M3 第二次 alreadyIdle=false' (Test-InputM3Release -First $rel1 -Second (New-DoneTrial 'm3b' ([pscustomobject]@{ count = 0; alreadyIdle = $false }))) 'fail'

Write-Host '-- M4/M5 tap' -ForegroundColor DarkCyan
Expect 'M4 同 tick down+up'    (Test-InputM4TapSameTick -Trial (New-DoneTrial 'm4' (New-KeyResult -Delivered 2 -HeldCount 0 -Action tap -HoldTicks 1))) 'pass'
Expect 'M4 delivered=1'       (Test-InputM4TapSameTick -Trial (New-DoneTrial 'm4' (New-KeyResult -Delivered 1 -HeldCount 1 -Action tap -HoldTicks 1))) 'fail'
Expect 'M5 跨帧好数据'         (Test-InputM5TapCrossFrame -Trial (New-DoneTrial 'm5' (New-KeyResult -Delivered 2 -HeldCount 0 -Action tap -HoldTicks 5 -AutoReleased @([pscustomobject]@{ kind = 'key'; id = 'key.forward'; jobId = 'j9'; heldTicks = 5; reason = 'expired' })))) 'pass'
Expect 'M5 heldTicks=3（不足）' (Test-InputM5TapCrossFrame -Trial (New-DoneTrial 'm5' (New-KeyResult -Delivered 2 -HeldCount 0 -Action tap -HoldTicks 5 -AutoReleased @([pscustomobject]@{ heldTicks = 3; reason = 'expired' })))) 'fail'
Expect 'M5 delivered=1（没抬起）' (Test-InputM5TapCrossFrame -Trial (New-DoneTrial 'm5' (New-KeyResult -Delivered 1 -HeldCount 1 -Action tap -HoldTicks 5))) 'fail'
Expect 'M5 无 heldTicks 明细'   (Test-InputM5TapCrossFrame -Trial (New-DoneTrial 'm5' (New-KeyResult -Delivered 2 -HeldCount 0 -Action tap -HoldTicks 5))) 'fail'

Write-Host '-- M6/M7 滚轮' -ForegroundColor DarkCyan
Expect 'M6 档位 1'            (Test-InputM6Wheel -Trial (New-DoneTrial 'm6' (New-MouseResult -Op wheel -Delivered 1))) 'pass'
Expect 'M6 delivered=0'       (Test-InputM6Wheel -Trial (New-DoneTrial 'm6' (New-MouseResult -Op wheel -Delivered 0))) 'fail'
Expect 'M7 零档被拒（作业 failed）' (Test-InputM7WheelZeroRejected -Trial (New-FailedTrial 'm7' 'CP-VALID-002' 'amount=0 是零档')) 'pass'
Expect 'M7 零档被拒（提交期 4xx）' (Test-InputM7WheelZeroRejected -Trial (New-SubmitRejectTrial 'm7' 'CP-VALID-002')) 'pass'
Expect 'M7 零档假绿（exit 0）'  (Test-InputM7WheelZeroRejected -Trial (New-DoneTrial 'm7' (New-MouseResult -Op wheel -Delivered 0))) 'fail'
Expect 'M7 错误码不符'         (Test-InputM7WheelZeroRejected -Trial (New-FailedTrial 'm7' 'CP-STATE-001')) 'fail'
Expect 'M8 越上界被拒'         (Test-InputM8HoldTicksOverMaxRejected -Trial (New-FailedTrial 'm8' 'CP-VALID-002' 'holdTicks 越界')) 'pass'
Expect 'M8 假绿（exit 0）'     (Test-InputM8HoldTicksOverMaxRejected -Trial (New-DoneTrial 'm8' (New-KeyResult -Delivered 2 -Action tap -HoldTicks 1201))) 'fail'
Expect 'M9 不适用字段被拒'      (Test-InputM9HoldTicksInapplicableRejected -Trial (New-FailedTrial 'm9' 'CP-VALID-002' '参数不适用: holdTicks')) 'pass'
Expect 'M9 静默忽略（假绿）'    (Test-InputM9HoldTicksInapplicableRejected -Trial (New-DoneTrial 'm9' (New-KeyResult -Delivered 1 -Action down))) 'fail'
Expect 'M10 文本未就绪被拒'     (Test-InputM10TextNotReady -Trial (New-FailedTrial 'm10' 'CP-STATE-001' '文本投递路由未就绪')) 'pass'
Expect 'M10 文本假绿（delivered:N）' (Test-InputM10TextNotReady -Trial (New-DoneTrial 'm10' ([pscustomobject]@{ semantics = 'text'; delivered = 2 }))) 'fail'
Expect 'M10 码错（VALID）'     (Test-InputM10TextNotReady -Trial (New-FailedTrial 'm10' 'CP-VALID-002')) 'fail'

Write-Host '-- M11 input.state 能力面' -ForegroundColor DarkCyan
Expect 'M11 好数据'            (Test-InputM11InputState -Trial (New-DoneTrial 'm11' (New-StateResult))) 'pass'
Expect 'M11 actions 为空（当前实机形态）' (Test-InputM11InputState -Trial (New-DoneTrial 'm11' (New-StateResult -ActionCount 0))) 'fail'
Expect 'M11 keyCatalog 空'     (Test-InputM11InputState -Trial (New-DoneTrial 'm11' (New-StateResult -EmptyCatalog))) 'fail'
Expect 'M11 keyCodeRange=null' (Test-InputM11InputState -Trial (New-DoneTrial 'm11' (New-StateResult -KeyCodeRange $null))) 'fail'
Expect 'M11 mouseDepth=0（编数）' (Test-InputM11InputState -Trial (New-DoneTrial 'm11' (New-StateResult -MouseDepth 0))) 'fail'
Expect 'M11 held.count=1（泄漏）' (Test-InputM11InputState -Trial (New-DoneTrial 'm11' (New-StateResult -HeldCount 1))) 'fail'
$implFalse = New-StateResult
$implFalse.implemented = $false
Expect 'M11 implemented=false' (Test-InputM11InputState -Trial (New-DoneTrial 'm11' $implFalse)) 'fail'

Write-Host '-- M12 窗口/尺度上下文' -ForegroundColor DarkCyan
$stA = New-DoneTrial 'm12a' (New-StateResult)
$stB = New-DoneTrial 'm12b' (New-StateResult)
Expect 'M12 会话内无法改窗口 ⇒ skipped' (Test-InputM12ScaleContext -First $stA -Second $stB) 'skipped'
$stC = New-StateResult
$stC.coordinates = [pscustomobject]@{ displayWidth = 1280; displayHeight = 720; scaledWidth = 427; scaledHeight = 240; pixelScale = 1.0; scaleFactor = 2; guiScaleSetting = 2; windowWidth = 1280; windowHeight = 720 }
Expect 'M12 上下文确已变化 ⇒ pass' (Test-InputM12ScaleContext -First $stA -Second (New-DoneTrial 'm12c' $stC)) 'pass'

Write-Host '-- W1/W2 世界与失焦推进' -ForegroundColor DarkCyan
Expect 'W1 托管世界'           (Test-InputW1WorldManaged -Trial (New-DoneTrial 'w1' ([pscustomobject]@{ world = [pscustomobject]@{ loaded = $true; managed = $true; folder = 'cp_input_live' } }))) 'pass'
Expect 'W1 loaded=false'      (Test-InputW1WorldManaged -Trial (New-DoneTrial 'w1' ([pscustomobject]@{ world = [pscustomobject]@{ loaded = $false; managed = $false } }))) 'fail'
Expect 'W1 managed=false（非托管）' (Test-InputW1WorldManaged -Trial (New-DoneTrial 'w1' ([pscustomobject]@{ world = [pscustomobject]@{ loaded = $true; managed = $false; folder = 'New World' } }))) 'fail'
Expect 'W2 失焦仍跨帧推进'      (Test-InputW2UnfocusedAdvance -Trial (New-DoneTrial 'w2' (New-KeyResult -Delivered 2 -HeldCount 0 -Action tap -HoldTicks 20))) 'pass'
$w2nofocus = New-KeyResult -Delivered 2 -HeldCount 0 -Action tap -HoldTicks 20 -Consumer ([pscustomobject]@{ chain = 'world'; displayActive = $null; inGameHasFocus = $null })
Expect 'W2 consumer 两项为 null（不可读）' (Test-InputW2UnfocusedAdvance -Trial (New-DoneTrial 'w2' $w2nofocus)) 'fail'
Expect 'W2 delivered=1'       (Test-InputW2UnfocusedAdvance -Trial (New-DoneTrial 'w2' (New-KeyResult -Delivered 1 -HeldCount 1 -Action tap -HoldTicks 20))) 'fail'
Expect 'W2 consumer 缺席'      (Test-InputW2UnfocusedAdvance -Trial (New-DoneTrial 'w2' ([pscustomobject]@{ delivered = 2 }))) 'fail'

Write-Host '-- W3/W4 位移判据（W4 的两种失败形态）' -ForegroundColor DarkCyan
Expect 'W3 位移 4.0 > 0.5'     (Test-InputW3MovementEffective -PosA @(64.5, 13.0, 64.5) -PosB @(68.5, 13.0, 64.5)) 'pass'
Expect 'W3 位移 0.1（键没生效）' (Test-InputW3MovementEffective -PosA @(64.5, 13.0, 64.5) -PosB @(64.6, 13.0, 64.5)) 'fail'
Expect 'W3 坐标不可解析'        (Test-InputW3MovementEffective -PosA $null -PosB @(64.5, 13.0, 64.5)) 'fail'
$posA = @(64.5, 13.0, 64.5); $posB = @(69.0, 13.0, 64.5); $posC = @(69.02, 13.0, 64.5)
Expect 'W4 到期抬起（好数据）'   (Test-InputW4ExpiryPump -PosA $posA -PosB $posB -PosC $posC -PumpProofTicks 1300) 'pass'
Expect 'W4 失败形态①：等待期间没动' (Test-InputW4ExpiryPump -PosA $posA -PosB @(64.6, 13.0, 64.5) -PosC @(64.6, 13.0, 64.5) -PumpProofTicks 1300) 'fail'
Expect 'W4 失败形态②：仍在动（没抬起）' (Test-InputW4ExpiryPump -PosA $posA -PosB $posB -PosC @(72.0, 13.0, 64.5) -PumpProofTicks 1300) 'fail'
Expect 'W4 失败形态③：坐标不可解析' (Test-InputW4ExpiryPump -PosA $posA -PosB $posB -PosC $null -PumpProofTicks 1300) 'fail'
Expect 'W4 证据充分（1300 tick）' (Test-InputW4TickEvidence -TickDelta 1305 -PumpProofTicks 1300 -WallSeconds 66) 'pass'
Expect 'W4 证据不足（400 tick）'  (Test-InputW4TickEvidence -TickDelta 400 -PumpProofTicks 1300 -WallSeconds 20) 'fail'

Write-Host '-- W5/W6 鼠标坐标与拖动' -ForegroundColor DarkCyan
Expect 'W5 自校准命中'         (Test-InputW5MouseMoveCalibration -Trial (New-DoneTrial 'w5' (New-MouseResult -Op move -Delivered 1 -WithinTolerance $true -GuiX 213 -GuiY 120 -ReqX 213 -ReqY 120))) 'pass'
Expect 'W5 偏差 3px'          (Test-InputW5MouseMoveCalibration -Trial (New-DoneTrial 'w5' (New-MouseResult -Op move -Delivered 1 -WithinTolerance $false -GuiX 216 -GuiY 120 -ReqX 213 -ReqY 120))) 'fail'
Expect 'W5 readback 缺席'      (Test-InputW5MouseMoveCalibration -Trial (New-DoneTrial 'w5' ([pscustomobject]@{ op = 'move'; delivered = 1 }))) 'fail'
$dragOk = @(
    (New-DoneTrial 'w6-1-move' (New-MouseResult -Op move)),
    (New-DoneTrial 'w6-2-down' (New-MouseResult -Op down -HitSet ([pscustomobject]@{ state = 'stale'; minSettleTicks = 2 }))),
    (New-DoneTrial 'w6-3-move' (New-MouseResult -Op move)),
    (New-DoneTrial 'w6-4-up' (New-MouseResult -Op up))
)
$dragBad = @(
    (New-DoneTrial 'w6-1-move' (New-MouseResult -Op move)),
    (New-FailedTrial 'w6-2-down' 'CP-STATE-001'),
    (New-DoneTrial 'w6-3-move' (New-MouseResult -Op move)),
    (New-DoneTrial 'w6-4-up' (New-MouseResult -Op up))
)
Expect 'W6a 四步都成功'         (Test-InputW6DragExitCodes -Trials $dragOk) 'pass'
Expect 'W6a 第二步失败'         (Test-InputW6DragExitCodes -Trials $dragBad) 'fail'
Expect 'W6b down 里 hitSet 真值' (Test-InputW6HitSetTruthy -DownTrial $dragOk[1]) 'pass'
Expect 'W6b down 里没有 hitSet（当前实机形态）' (Test-InputW6HitSetTruthy -DownTrial (New-DoneTrial 'w6-2-down' (New-MouseResult -Op down))) 'fail'
Expect 'W6b hitSet.state 占位'  (Test-InputW6HitSetTruthy -DownTrial (New-DoneTrial 'w6-2-down' (New-MouseResult -Op down -HitSet ([pscustomobject]@{ state = 'unimplemented'; minSettleTicks = 2 })))) 'fail'
Expect 'W6b hitSet.state 为空'  (Test-InputW6HitSetTruthy -DownTrial (New-DoneTrial 'w6-2-down' (New-MouseResult -Op down -HitSet ([pscustomobject]@{ state = ''; minSettleTicks = 2 })))) 'fail'

Write-Host '-- W7 GUI 实拍' -ForegroundColor DarkCyan
$descWithGui = [pscustomobject]@{ name = 'shot.multi'; params = @(@{ name = 'cameras'; type = 'array' }, @{ name = 'gui'; type = 'string'; description = 'GUI 取证模式：none | screen' }) }
$descNoGui = [pscustomobject]@{ name = 'shot.multi'; params = @(@{ name = 'cameras'; type = 'array' }, @{ name = 'target'; type = 'array' }) }
Expect 'W7a 声明了 gui'        (Test-InputW7GuiParamDeclared -Descriptor $descWithGui) 'pass'
Expect 'W7a 未声明 gui（当前实机形态）' (Test-InputW7GuiParamDeclared -Descriptor $descNoGui) 'fail'
$guiCam = @([pscustomobject]@{ name = 'gui-live'; ok = $true; guiHidden = $false; guiCapture = @([pscustomobject]@{ mode = 'screen'; screen = 'net.minecraft.client.gui.inventory.GuiInventory'; drawn = $true }) })
$guiCamBroken = @([pscustomobject]@{ name = 'gui-live'; ok = $true; guiHidden = $true; guiCapture = @() })
Expect 'W7b guiCapture 非空 + guiHidden=false' (Test-InputW7GuiCapturePositive -Trial (New-DoneTrial 'w7b' ([pscustomobject]@{ cameras = $guiCam }))) 'pass'
Expect 'W7b guiCapture 为空'    (Test-InputW7GuiCapturePositive -Trial (New-DoneTrial 'w7b' ([pscustomobject]@{ cameras = $guiCamBroken }))) 'fail'
$defCam = @([pscustomobject]@{ name = 'gui-live'; ok = $true; guiHidden = $true })
$defCamLeak = @([pscustomobject]@{ name = 'gui-live'; ok = $true; guiHidden = $true; guiCapture = @([pscustomobject]@{ mode = 'screen' }) })
Expect 'W7c 默认路径不受影响'    (Test-InputW7DefaultPathUnchanged -Trial (New-DoneTrial 'w7c' ([pscustomobject]@{ cameras = $defCam }))) 'pass'
Expect 'W7c 默认路径冒出 guiCapture' (Test-InputW7DefaultPathUnchanged -Trial (New-DoneTrial 'w7c' ([pscustomobject]@{ cameras = $defCamLeak }))) 'fail'
Expect 'W7c 默认路径 guiHidden=false' (Test-InputW7DefaultPathUnchanged -Trial (New-DoneTrial 'w7c' ([pscustomobject]@{ cameras = @([pscustomobject]@{ name = 'x'; guiHidden = $false }) }))) 'fail'

Write-Host '-- W8 physical.concurrent' -ForegroundColor DarkCyan
$w8k = New-DoneTrial 'w8b' (New-KeyResult -Delivered 1 -HeldCount 2 -PhysicalConcurrent $false)
$w8m = New-DoneTrial 'w8c' (New-MouseResult -Op wheel -Delivered 1 -PhysicalConcurrent 'unobservable')
ExpectArray 'W8 键盘布尔 + 鼠标 unobservable' (Test-InputW8PhysicalConcurrent -KeyboardTrial $w8k -MouseTrial $w8m) 'pass,pass'
$w8kUnobs = New-DoneTrial 'w8b' (New-KeyResult -Delivered 1 -HeldCount 2 -PhysicalConcurrent 'unobservable（键盘队列深度探针不可用）')
ExpectArray 'W8 键盘侧 unobservable（探针不可用）' (Test-InputW8PhysicalConcurrent -KeyboardTrial $w8kUnobs -MouseTrial $w8m) 'fail,pass'
$w8mFake = New-DoneTrial 'w8c' (New-MouseResult -Op wheel -Delivered 1 -PhysicalConcurrent $false)
ExpectArray 'W8 鼠标侧编造 false' (Test-InputW8PhysicalConcurrent -KeyboardTrial $w8k -MouseTrial $w8mFake) 'pass,fail'

Write-Host '-- G1 跨帧输入步（含 blocked-by-G1）' -ForegroundColor DarkCyan
$valBlocked = New-FailedTrial 'g1-validate' 'CP-VALID-002' '用例文件非法（2 处）：action[0].holdTicks 未知字段（严格模式）' ([pscustomobject]@{ fields = @([pscustomobject]@{ field = 'action[0].holdTicks'; reason = '未知字段（严格模式）' }) })
$runBlocked = New-FailedTrial 'g1-run' 'CP-VALID-002' 'action[0].holdTicks 未知字段'
Expect 'G1 未实现 ⇒ blocked（不是 pass）' (Test-InputG1CaseRun -ValidationTrial $valBlocked -RunTrial $runBlocked -HeldAfter $null -StepArtifacts @()) 'blocked'
$valOk = New-DoneTrial 'g1-validate' ([pscustomobject]@{ valid = $true })
$runOk = New-DoneTrial 'g1-run' ([pscustomobject]@{ overall = 'green' })
$art0 = [pscustomobject]@{ action = 'input.key'; semantics = 'key'; delivered = 2; holdTicks = 20; deliveredAtTick = 100; autoReleased = @([pscustomobject]@{ kind = 'key'; heldTicks = 20; reason = 'expired' }); __artifact = 'action/0-tap-forward-20.json' }
$art1 = [pscustomobject]@{ action = 'input.key'; semantics = 'key'; delivered = 1; action2 = 'down'; deliveredAtTick = 121; __artifact = 'action/1-down-forward-10.json' }
$art2 = [pscustomobject]@{ action = 'input.key'; semantics = 'key'; delivered = 1; deliveredAtTick = 131; __artifact = 'action/2-up-forward.json' }
$held0 = New-DoneTrial 'g1-state-after' (New-StateResult -HeldCount 0)
Expect 'G1 跨帧证据齐 + 无泄漏' (Test-InputG1CaseRun -ValidationTrial $valOk -RunTrial $runOk -HeldAfter $held0 -StepArtifacts @($art0, $art1, $art2)) 'pass'
$noCross = @([pscustomobject]@{ action = 'input.key'; semantics = 'key'; delivered = 2; deliveredAtTick = 100; __artifact = 'action/0.json' })
Expect 'G1 无跨帧证据'         (Test-InputG1CaseRun -ValidationTrial $valOk -RunTrial $runOk -HeldAfter $held0 -StepArtifacts $noCross) 'fail'
Expect 'G1 有持键泄漏'         (Test-InputG1CaseRun -ValidationTrial $valOk -RunTrial $runOk -HeldAfter (New-DoneTrial 'g1-state-after' (New-StateResult -HeldCount 1)) -StepArtifacts @($art0, $art1, $art2)) 'fail'
Expect 'G1 没有步骤产物'        (Test-InputG1CaseRun -ValidationTrial $valOk -RunTrial $runOk -HeldAfter $held0 -StepArtifacts @()) 'fail'
Expect 'G1 case.run 因别的理由失败 ⇒ fail（不是 blocked）' (Test-InputG1CaseRun -ValidationTrial $valOk -RunTrial (New-FailedTrial 'g1-run' 'CP-EXEC-001' '世界重建失败') -HeldAfter $held0 -StepArtifacts @()) 'fail'

# ---------------------------------------------------------------------------
# 归档 + 红绿表
# ---------------------------------------------------------------------------
$failed = @($script:results | Where-Object { -not $_.ok })
$lines = New-Object System.Collections.ArrayList
[void]$lines.Add("# run-input-acceptance 离线判据自检 $ts")
[void]$lines.Add('')
[void]$lines.Add("- 夹具根: ``$outDir``")
[void]$lines.Add("- 自检项: $($script:results.Count) 条，红 $($failed.Count) 条")
[void]$lines.Add('')
[void]$lines.Add('| 自检项 | 结果 | 说明 |')
[void]$lines.Add('|---|---|---|')
foreach ($r in $script:results) { [void]$lines.Add(("| {0} | {1} | {2} |" -f $r.name, $(if ($r.ok) { 'PASS' } else { 'FAIL' }), (([string]$r.detail) -replace '\|', '\|'))) }
if (Test-Path $CaseValidateReport) {
    $rep = Get-Content -Raw -Encoding UTF8 $CaseValidateReport | ConvertFrom-Json
    [void]$lines.Add('')
    [void]$lines.Add('## 附：真实 CaseValidator 的离线校验报告（临时入口写出，**不作判据**）')
    [void]$lines.Add('')
    [void]$lines.Add("- 用例文件: ``$($rep.caseFile)``")
    [void]$lines.Add("- parsed=$($rep.parsed) code=$([string]$rep.code)")
    [void]$lines.Add("- message=$([string]$rep.message)")
    if ($rep.context) {
        foreach ($f in @($rep.context.fields)) { [void]$lines.Add(("- 字段: {0} — {1}" -f $f.field, $f.reason)) }
    }
}
[void](Set-Content -Path (Join-Path $outDir 'summary.md') -Value $lines.ToString() -Encoding utf8NoBOM)
[void]((ConvertTo-Json -InputObject @($script:results) -Depth 6) | Set-Content -Path (Join-Path $outDir 'assertions.json') -Encoding utf8NoBOM)

Write-Host ''
Write-Host "   报告: $outDir"
Write-Host ("   总计: {0} 条自检，{1} 红" -f $script:results.Count, $failed.Count)
if ($failed.Count -gt 0) {
    Write-Host "== [CP-INPUT-SELFTEST] 有 $($failed.Count) 条自检不符（退出码 2）" -ForegroundColor Red
    exit 2
}
Write-Host '== [CP-INPUT-SELFTEST] 离线自检全部符合预期（退出码 0）' -ForegroundColor Green
exit 0

