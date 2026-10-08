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
# Stage extra 的夹具（E1/E2/E3）
# ---------------------------------------------------------------------------
# E2 的「投递前后状态」夹具：除易变字段（tick/墙钟/ping/控制面记账）外逐字相同
function New-E2State {
    param([double]$X = 64.5, [long]$TotalTime = 1000, [int]$Ping = 12, [int]$JobCount = 7, [int]$EventSeq = 99, [int]$Buffered = 3)
    return [pscustomobject]@{
        player = [pscustomobject]@{
            name = 'Dev'; pos = @($X, 13.0, 64.5); health = 20.0; fallDistance = 0.0
            game   = [pscustomobject]@{ isFlying = $true; allowFlying = $true; gameType = 'creative' }
            effects = @(); ping = $Ping
        }
        status = [pscustomobject]@{
            world  = [pscustomobject]@{ folder = 'cp_input_live'; loaded = $true; managed = $true; totalTime = $TotalTime }
            busy   = $false
            jobs   = [pscustomobject]@{ count = $JobCount; lastSeq = 42; recent = @('a', 'b') }
            events = [pscustomobject]@{ lastSeq = $EventSeq; buffered = $Buffered; capacity = 512 }
        }
    }
}
function New-E2FillArtifacts {
    param([int]$Steps = 300, [int]$BaseTick = 5000, [int]$Depth = 2, [int]$CapacityDepthAt = -1, [int]$CapacityDepth = 256)
    $list = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $Steps; $i++) {
        $d = $Depth
        if ($CapacityDepthAt -ge 0 -and $i -eq $CapacityDepthAt) { $d = $CapacityDepth }
        [void]$list.Add([pscustomobject]@{ action = 'input.key'; delivered = 1; deliveredAtTick = ($BaseTick + $i); queueDepthAfter = $d; __artifact = "action/$i-fill.json" })
    }
    return @($list)
}
function New-E3Artifact([string]$Path, [long]$Bytes, [string]$Sha, [string]$Role = 'shot') {
    return [pscustomobject]@{ path = $Path; bytes = $Bytes; sha256 = $Sha; role = $Role }
}
function New-E3Download([string]$Path, [string]$DeclaredSha, [long]$DeclaredBytes, [string]$ActualSha, [long]$ActualBytes, [bool]$DownloadOk = $true) {
    return [pscustomobject]@{ path = $Path; declaredSha256 = $DeclaredSha; declaredBytes = $DeclaredBytes; actualSha256 = $ActualSha; actualBytes = $ActualBytes; downloadOk = $DownloadOk }
}
# 保持期间的 input.state（E1.readback 夹具）
function New-HoldStateResult {
    param($SneakPressed = $true, $ForwardPressed = $false, [switch]$DropForward, [switch]$DropField)
    $items = New-Object System.Collections.ArrayList
    $sneak = [pscustomobject]@{ kind = 'key'; id = 'key.sneak'; keyCode = 42; jobId = 'j-sneak'; heldTicks = 12; expiresInTicks = 1188 }
    if (-not $DropField) { $sneak | Add-Member -NotePropertyName gameBindingPressed -NotePropertyValue $SneakPressed -Force }
    [void]$items.Add($sneak)
    if (-not $DropForward) {
        $fwd = [pscustomobject]@{ kind = 'key'; id = 'key.forward'; keyCode = 17; jobId = 'j-fwd'; heldTicks = 10; expiresInTicks = 1190 }
        $fwd | Add-Member -NotePropertyName gameBindingPressed -NotePropertyValue $ForwardPressed -Force
        [void]$items.Add($fwd)
    }
    return [pscustomobject]@{ implemented = $true; held = [pscustomobject]@{ count = @($items).Count; items = @($items) } }
}

Write-Host '-- E1 组合键（潜行修饰）' -ForegroundColor DarkCyan
$e1PlainA = @(64.5, 13.0, 64.5); $e1PlainB = @(76.5, 13.0, 64.5)   # 60 tick 走 12.0 ⇒ 0.20/tick
$e1SneakB = @(68.1, 13.0, 64.5)                                    # 60 tick 走 3.6 ⇒ 0.06/tick（比值 0.30）
Expect 'E1 潜行使位移下降到 0.30 倍 ⇒ pass' (Test-InputE1SneakModifier -PlainPosA $e1PlainA -PlainPosB $e1PlainB -PlainTicks 60 -SneakPosA $e1PlainA -SneakPosB $e1SneakB -SneakTicks 60) 'pass'
# 负对照（**必须真变红**）：潜行无效 ⇒ 两边每 tick 位移相当
Expect 'E1 负对照：潜行无效（比值 0.99）⇒ fail' (Test-InputE1SneakModifier -PlainPosA $e1PlainA -PlainPosB $e1PlainB -PlainTicks 60 -SneakPosA $e1PlainA -SneakPosB @(76.4, 13.0, 64.5) -SneakTicks 60) 'fail'
# 判界就在 0.6 上：0.60 倍不许算过
Expect 'E1 恰在判界上（比值 0.60）⇒ fail' (Test-InputE1SneakModifier -PlainPosA $e1PlainA -PlainPosB $e1PlainB -PlainTicks 60 -SneakPosA $e1PlainA -SneakPosB @(71.7, 13.0, 64.5) -SneakTicks 60) 'fail'
# 对照不成立（只按前进也没动）⇒ fail（不许因为「两边都没动」判绿）
Expect 'E1 对照不成立（对照也几乎不动）⇒ fail' (Test-InputE1SneakModifier -PlainPosA @(64.5, 13.0, 64.5) -PlainPosB @(64.6, 13.0, 64.5) -PlainTicks 60 -SneakPosA @(64.5, 13.0, 64.5) -SneakPosB @(64.5, 13.0, 64.5) -SneakTicks 60) 'fail'
Expect 'E1 坐标不可解析 ⇒ fail' (Test-InputE1SneakModifier -PlainPosA $null -PlainPosB $e1PlainB -PlainTicks 60 -SneakPosA $e1PlainA -SneakPosB $e1SneakB -SneakTicks 60) 'fail'
Expect 'E1 tick 增量为 0 ⇒ fail' (Test-InputE1SneakModifier -PlainPosA $e1PlainA -PlainPosB $e1PlainB -PlainTicks 0 -SneakPosA $e1PlainA -SneakPosB $e1SneakB -SneakTicks 60) 'fail'

Write-Host '-- E1.readback held[].gameBindingPressed' -ForegroundColor DarkCyan
Expect 'E1.readback 两键都在且带回读字段' (Test-InputE1SneakReadback -HoldTrial (New-DoneTrial 'hold' (New-HoldStateResult -SneakPressed $true -ForwardPressed $true))) 'pass'
Expect 'E1.readback 回读为 false（如实，不判红）' (Test-InputE1SneakReadback -HoldTrial (New-DoneTrial 'hold' (New-HoldStateResult -SneakPressed $false -ForwardPressed $false))) 'pass'
Expect 'E1.readback 缺 gameBindingPressed 字段 ⇒ fail' (Test-InputE1SneakReadback -HoldTrial (New-DoneTrial 'hold' (New-HoldStateResult -DropField))) 'fail'
Expect 'E1.readback 少了 forward 条目 ⇒ fail' (Test-InputE1SneakReadback -HoldTrial (New-DoneTrial 'hold' (New-HoldStateResult -DropForward))) 'fail'
Expect 'E1.readback input.state 调用失败 ⇒ fail' (Test-InputE1SneakReadback -HoldTrial (New-FailedTrial 'hold' 'CP-STATE-001' '运行时未装配')) 'fail'

Write-Host '-- E2 队列满（三条分支 + 负对照）' -ForegroundColor DarkCyan
$e2ValOk = New-DoneTrial 'e2-validate' ([pscustomobject]@{ valid = $true })
$e2RunOk = New-DoneTrial 'e2-run' ([pscustomobject]@{ overall = 'green' })
$e2Before = New-E2State -TotalTime 1000 -Ping 12 -JobCount 7 -EventSeq 99 -Buffered 3
$e2After = New-E2State -TotalTime 1300 -Ping 25 -JobCount 10 -EventSeq 105 -Buffered 1
Expect 'E2 300 步 ≫ 容量但深度只到 2 ⇒ blocked（不是 pass）' (Test-InputE2QueueFullSingleJob -ValidateTrial $e2ValOk -RunTrial $e2RunOk -BeforeState $e2Before -AfterState $e2After -StepArtifacts (New-E2FillArtifacts -Steps 300 -Depth 2) -PlannedSteps 300) 'blocked'
Expect 'E2 深度确实到过容量却仍投递成功 ⇒ fail' (Test-InputE2QueueFullSingleJob -ValidateTrial $e2ValOk -RunTrial $e2RunOk -BeforeState $e2Before -AfterState $e2After -StepArtifacts (New-E2FillArtifacts -Steps 300 -Depth 2 -CapacityDepthAt 250 -CapacityDepth 256) -PlannedSteps 300) 'fail'
$e2Rejected = New-FailedTrial 'e2-run' 'CP-STATE-001' '键盘事件队列已满，拒绝投递（不做静默丢弃）'
Expect 'E2 命中 CP-STATE-001 且零写入 ⇒ pass' (Test-InputE2QueueFullSingleJob -ValidateTrial $e2ValOk -RunTrial $e2Rejected -BeforeState $e2Before -AfterState $e2After -StepArtifacts @() -PlannedSteps 300) 'pass'
# 负对照（**必须真变红**）：拒绝码对了，但前后状态有真实写入（玩家动了）
Expect 'E2 负对照：命中 CP-STATE-001 但有真实写入 ⇒ fail' (Test-InputE2QueueFullSingleJob -ValidateTrial $e2ValOk -RunTrial $e2Rejected -BeforeState $e2Before -AfterState (New-E2State -X 66.5 -TotalTime 1300 -Ping 25 -JobCount 10 -EventSeq 105 -Buffered 1) -StepArtifacts @() -PlannedSteps 300) 'fail'
Expect 'E2 用例未通过校验 ⇒ blocked' (Test-InputE2QueueFullSingleJob -ValidateTrial (New-FailedTrial 'e2-validate' 'CP-VALID-002' 'action[0].key 未知字段') -RunTrial $e2RunOk -BeforeState $e2Before -AfterState $e2After -StepArtifacts @() -PlannedSteps 300) 'blocked'
Expect 'E2 因别的错误码失败 ⇒ fail（不是 blocked）' (Test-InputE2QueueFullSingleJob -ValidateTrial $e2ValOk -RunTrial (New-FailedTrial 'e2-run' 'CP-EXEC-002' '步进超时') -BeforeState $e2Before -AfterState $e2After -StepArtifacts @() -PlannedSteps 300) 'fail'
# 状态比对的**口径**本身：易变字段必须被排除，真实差异必须被抓到
$cmpClean = Compare-CpStateModuloVolatile -Before $e2Before -After $e2After
Check 'E2 口径：易变字段被显式排除后差异为 0' ($cmpClean.diffs.Count -eq 0) ("diffs={0} skipped={1}（{2}）" -f $cmpClean.diffs.Count, $cmpClean.skipped.Count, (($cmpClean.skipped | Select-Object -First 3) -join '; '))
$cmpDirty = Compare-CpStateModuloVolatile -Before $e2Before -After (New-E2State -X 66.5 -TotalTime 1300 -Ping 25 -JobCount 10 -EventSeq 105 -Buffered 1)
Check 'E2 口径：真实位移差异被逐路径抓到' ($cmpDirty.diffs.Count -gt 0) ("diffs={0}: {1}" -f $cmpDirty.diffs.Count, (($cmpDirty.diffs | Select-Object -First 3) -join ' | '))
# 【首轮实机教训】读面的 readAt 是墙钟：第一轮 E2 的「零写入」比对就是被 /player/readAt 撞出一条假差异。
# 只差 readAt 的两份状态必须判「零差异」，否则 E2 一旦真走到 pass 分支就会因假红而翻车（同类于 Gitea #169）。
$cmpReadAt = Compare-CpStateModuloVolatile -Before ([pscustomobject]@{ player = [pscustomobject]@{ readAt = '2026-10-08T01:20:15.3704717+08:00'; x = 64.5 } }) -After ([pscustomobject]@{ player = [pscustomobject]@{ readAt = '2026-10-08T01:20:32.2192540+08:00'; x = 64.5 } })
Check 'E2 口径：只差 readAt（墙钟）⇒ 判零差异（假红守卫）' ($cmpReadAt.diffs.Count -eq 0) ("diffs={0} skipped={1}" -f $cmpReadAt.diffs.Count, $cmpReadAt.skipped.Count)
$cmpReadAtReal = Compare-CpStateModuloVolatile -Before ([pscustomobject]@{ player = [pscustomobject]@{ readAt = 'a'; x = 64.5 } }) -After ([pscustomobject]@{ player = [pscustomobject]@{ readAt = 'b'; x = 65.5 } })
Check 'E2 口径：readAt 之外的同伴字段差异仍被抓到' ($cmpReadAtReal.diffs.Count -eq 1) ("diffs={0}: {1}" -f $cmpReadAtReal.diffs.Count, ($cmpReadAtReal.diffs -join ' | '))

# 填充键位门：填充键必须是**未绑定**键码（否则「事件被消费也不写世界」的前提不可辩护）
$e2PickOk = New-DoneTrial 'e2-pick' (New-StateResult)
$e2Cat = [pscustomobject]@{ 'key.forward' = 17; 'key.sneak' = 42; 'key.jump' = 57 }
Expect 'E2 填充键位门：未绑定键码 87 ⇒ 不因键位原因红' (Test-InputE2QueueFullSingleJob -ValidateTrial $e2ValOk -RunTrial $e2RunOk -BeforeState $e2Before -AfterState $e2After -StepArtifacts (New-E2FillArtifacts -Steps 300 -Depth 2) -PlannedSteps 300 -FillerTrial $e2PickOk -FillerCatalog $e2Cat -FillerCode 87) 'blocked'
Expect 'E2 负对照：填充键码已被 KeyBinding 占用 ⇒ fail' (Test-InputE2QueueFullSingleJob -ValidateTrial $e2ValOk -RunTrial $e2RunOk -BeforeState $e2Before -AfterState $e2After -StepArtifacts (New-E2FillArtifacts -Steps 300 -Depth 2) -PlannedSteps 300 -FillerTrial $e2PickOk -FillerCatalog $e2Cat -FillerCode 17) 'fail'
Expect 'E2 填充键位门：找不到未绑定键码 ⇒ blocked' (Test-InputE2QueueFullSingleJob -ValidateTrial $null -RunTrial $null -BeforeState $null -AfterState $null -StepArtifacts @() -PlannedSteps 300 -FillerTrial $e2PickOk -FillerCatalog $e2Cat -FillerCode -1) 'blocked'
Expect 'E2 填充键位门：keyCatalog 为空 ⇒ blocked（未绑定不可判）' (Test-InputE2QueueFullSingleJob -ValidateTrial $null -RunTrial $null -BeforeState $null -AfterState $null -StepArtifacts @() -PlannedSteps 300 -FillerTrial $e2PickOk -FillerCatalog ([pscustomobject]@{}) -FillerCode 87) 'blocked'
Expect 'E2 填充键位门：input.state 取不到 ⇒ blocked' (Test-InputE2QueueFullSingleJob -ValidateTrial $null -RunTrial $null -BeforeState $null -AfterState $null -StepArtifacts @() -PlannedSteps 300 -FillerTrial (New-FailedTrial 'e2-pick' 'CP-STATE-001' '未装配') -FillerCatalog $null -FillerCode -1) 'blocked'

Write-Host '-- E3 产物发现与哈希复核' -ForegroundColor DarkCyan
$e3ShaPng = 'a' * 64
$e3ShaMeta = 'b' * 64
$e3Manifest = [pscustomobject]@{
    runId = '20261008-120000-shot-e3'; caseId = 'shot'; jobSeq = 12; createdAt = '2026-10-08T12:00:00Z'
    count = 3
    artifacts = @(
        (New-E3Artifact 'shots/gui-live.png' 20480 $e3ShaPng 'shot'),
        (New-E3Artifact 'shots/gui-live.meta.json' 1024 $e3ShaMeta 'shot-meta'),
        (New-E3Artifact 'manifest.json' 512 ('c' * 64) 'manifest')
    )
}
$e3DlOk = @(
    (New-E3Download 'shots/gui-live.png' $e3ShaPng 20480 $e3ShaPng 20480),
    (New-E3Download 'shots/gui-live.meta.json' $e3ShaMeta 1024 $e3ShaMeta 1024)
)
Expect 'E3 清单可发现且逐份哈希一致 ⇒ pass' (Test-InputE3ArtifactHashes -Manifest $e3Manifest -Downloads $e3DlOk) 'pass'
# 负对照（**必须真变红**）：下载字节与清单哈希不符
$e3DlBad = @(
    (New-E3Download 'shots/gui-live.png' $e3ShaPng 20480 ('d' * 64) 20480),
    (New-E3Download 'shots/gui-live.meta.json' $e3ShaMeta 1024 $e3ShaMeta 1024)
)
Expect 'E3 负对照：哈希不符 ⇒ fail' (Test-InputE3ArtifactHashes -Manifest $e3Manifest -Downloads $e3DlBad) 'fail'
Expect 'E3 字节数不符 ⇒ fail' (Test-InputE3ArtifactHashes -Manifest $e3Manifest -Downloads @((New-E3Download 'shots/gui-live.png' $e3ShaPng 20480 $e3ShaPng 20000), $e3DlOk[1])) 'fail'
Expect 'E3 下载失败 ⇒ fail' (Test-InputE3ArtifactHashes -Manifest $e3Manifest -Downloads @((New-E3Download 'shots/gui-live.png' $e3ShaPng 20480 '' 0 $false), $e3DlOk[1])) 'fail'
Expect 'E3 未下载全（逐份比对不完整）⇒ fail' (Test-InputE3ArtifactHashes -Manifest $e3Manifest -Downloads @($e3DlOk[0])) 'fail'
$e3NoHash = [pscustomobject]@{ runId = 'r1'; count = 2; artifacts = @(
        (New-E3Artifact 'shots/a.png' 10 $null 'shot'),
        (New-E3Artifact 'shots/a.meta.json' 10 '' 'shot-meta')) }
Expect 'E3 清单未声明 sha256 ⇒ fail（如实记「未覆盖」）' (Test-InputE3ArtifactHashes -Manifest $e3NoHash -Downloads @()) 'fail'
$e3NoPng = [pscustomobject]@{ runId = 'r1'; count = 1; artifacts = @((New-E3Artifact 'shots/a.meta.json' 10 $e3ShaMeta 'shot-meta')) }
Expect 'E3 清单里没有 PNG ⇒ fail' (Test-InputE3ArtifactHashes -Manifest $e3NoPng -Downloads @()) 'fail'
$e3NoMeta = [pscustomobject]@{ runId = 'r1'; count = 1; artifacts = @((New-E3Artifact 'shots/a.png' 10 $e3ShaPng 'shot')) }
Expect 'E3 清单里没有 meta.json ⇒ fail' (Test-InputE3ArtifactHashes -Manifest $e3NoMeta -Downloads @()) 'fail'
Expect 'E3 清单读不到 ⇒ fail' (Test-InputE3ArtifactHashes -Manifest $null -Downloads @()) 'fail'
# 只看 shots/ 下的产物：tiles 子目录与它目录的产物不参与本判据
$e3Tiles = [pscustomobject]@{ runId = 'r1'; count = 3; artifacts = @(
        (New-E3Artifact 'shots/a.png' 10 $e3ShaPng 'shot'),
        (New-E3Artifact 'shots/a.meta.json' 10 $e3ShaMeta 'shot-meta'),
        (New-E3Artifact 'shots/a.tiles/r0c0.png' 10 ('e' * 64) 'shot-tile')) }
Expect 'E3 tiles 子目录不干扰（仍 pass）' (Test-InputE3ArtifactHashes -Manifest $e3Tiles -Downloads $e3DlOk) 'pass'

# ---------------------------------------------------------------------------
# E3.content 的夹具：**现场生成**合法 PNG（纯 PowerShell 写出，不引外部图片文件）
#   编码只用 BCL：zlib 头 + **存储块**（BTYPE=00，无压缩 deflate）+ adler32 + 真实 CRC32；
#   与 run-anchor.ps1 的 Write-ProbePng 同一套做法（那边用 DeflateStream，这边用存储块，
#   两边都不依赖 System.Drawing）。
#   filterType 支持 0-4：走标准**正向滤波**，用来证明被测解码侧真的把 filter 反回来了。
# ---------------------------------------------------------------------------
$script:testCrcTable = $null
function Get-TestCrc32([byte[]]$Data) {
    if ($null -eq $script:testCrcTable) {
        $t = New-Object int64[] 256
        for ($n = 0; $n -lt 256; $n++) {
            $c = [int64]$n
            for ($k = 0; $k -lt 8; $k++) {
                if (($c -band 1) -ne 0) { $c = [int64]3988292384 -bxor ($c -shr 1) } else { $c = $c -shr 1 }
            }
            $t[$n] = $c
        }
        $script:testCrcTable = $t
    }
    $crc = [int64]4294967295
    foreach ($b in $Data) {
        $idx = [int](($crc -bxor [int64]$b) -band [int64]255)
        $crc = ($script:testCrcTable[$idx] -bxor ($crc -shr 8)) -band [int64]4294967295
    }
    return [uint32](($crc -bxor [int64]4294967295) -band [int64]4294967295)
}
function Get-TestAdler32([byte[]]$Data) {
    $a = 1; $b = 0
    foreach ($v in $Data) {
        $a = ($a + [int]$v) % 65521
        $b = ($b + $a) % 65521
    }
    return [int64]$b * 65536 + [int64]$a
}

# 把「逐像素样本数组 + 宽高」编码成 PNG（颜色型 2 = RGB / 6 = RGBA）
function Write-TestPng {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][int]$Width,
        [Parameter(Mandatory = $true)][int]$Height,
        [Parameter(Mandatory = $true)][byte[]]$Pixels,
        [int]$ColorType = 2,
        [int]$FilterType = 0
    )
    $channels = if ($ColorType -eq 6) { 4 } else { 3 }
    $stride = $Width * $channels
    $raw = New-Object byte[] (($stride + 1) * $Height)
    $off = 0
    for ($y = 0; $y -lt $Height; $y++) {
        $raw[$off] = [byte]$FilterType; $off++
        for ($i = 0; $i -lt $stride; $i++) {
            $x = [int]$Pixels[$y * $stride + $i]
            $a = if ($i -ge $channels) { [int]$Pixels[$y * $stride + $i - $channels] } else { 0 }
            $b = if ($y -gt 0) { [int]$Pixels[($y - 1) * $stride + $i] } else { 0 }
            $c = if ($i -ge $channels -and $y -gt 0) { [int]$Pixels[($y - 1) * $stride + $i - $channels] } else { 0 }
            switch ($FilterType) {
                0 { }
                1 { $x = ($x - $a) -band 0xFF }
                2 { $x = ($x - $b) -band 0xFF }
                3 { $x = ($x - [int](($a + $b) / 2)) -band 0xFF }
                4 {
                    $p = $a + $b - $c
                    $pa = [math]::Abs($p - $a); $pb = [math]::Abs($p - $b); $pc = [math]::Abs($p - $c)
                    $pr = if ($pa -le $pb -and $pa -le $pc) { $a } elseif ($pb -le $pc) { $b } else { $c }
                    $x = ($x - $pr) -band 0xFF
                }
                default { throw "不支持的夹具 filter 类型 $FilterType" }
            }
            $raw[$off] = [byte]$x; $off++
        }
    }
    # zlib 流：CMF/FLG + 存储块序列 + adler32（大端）
    $z = New-Object System.Collections.Generic.List[byte]
    $z.Add([byte]0x78); $z.Add([byte]0x01)
    $p = 0
    while ($p -lt $raw.Length) {
        $n = [int][math]::Min(65535, $raw.Length - $p)
        $z.Add([byte]$(if ($p + $n -ge $raw.Length) { 1 } else { 0 }))
        $z.Add([byte]($n -band 0xFF)); $z.Add([byte](($n -shr 8) -band 0xFF))
        $inv = (-bnot $n) -band 0xFFFF
        $z.Add([byte]($inv -band 0xFF)); $z.Add([byte](($inv -shr 8) -band 0xFF))
        for ($i = 0; $i -lt $n; $i++) { $z.Add($raw[$p + $i]) }
        $p += $n
    }
    $adler = Get-TestAdler32 $raw
    foreach ($sh in @(24, 16, 8, 0)) { $z.Add([byte](($adler -shr $sh) -band 0xFF)) }

    $out = New-Object System.Collections.Generic.List[byte]
    foreach ($b in @(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)) { $out.Add([byte]$b) }
    $chunk = {
        param([string]$Type, [byte[]]$Data)
        $body = New-Object System.Collections.Generic.List[byte]
        foreach ($b in [System.Text.Encoding]::ASCII.GetBytes($Type)) { $body.Add($b) }
        foreach ($b in $Data) { $body.Add($b) }
        $len = $Data.Length
        foreach ($sh in @(24, 16, 8, 0)) { $out.Add([byte](($len -shr $sh) -band 0xFF)) }
        foreach ($b in $body) { $out.Add($b) }
        $crc = Get-TestCrc32 $body.ToArray()
        foreach ($sh in @(24, 16, 8, 0)) { $out.Add([byte](($crc -shr $sh) -band 0xFF)) }
    }
    $ihdr = New-Object System.Collections.Generic.List[byte]
    foreach ($sh in @(24, 16, 8, 0)) { $ihdr.Add([byte](($Width -shr $sh) -band 0xFF)) }
    foreach ($sh in @(24, 16, 8, 0)) { $ihdr.Add([byte](($Height -shr $sh) -band 0xFF)) }
    $ihdr.Add([byte]8); $ihdr.Add([byte]$ColorType); $ihdr.Add([byte]0); $ihdr.Add([byte]0); $ihdr.Add([byte]0)
    & $chunk 'IHDR' $ihdr.ToArray()
    & $chunk 'IDAT' $z.ToArray()
    & $chunk 'IEND' (New-Object byte[] 0)
    [System.IO.File]::WriteAllBytes($Path, $out.ToArray())
}

# 渐变底：唯一色数远超 1（刻意贴近「背景是渐变」的实机情形，也是既有 image-uniform 判据判绿的那种帧）
function New-TestFrame {
    param([int]$Width, [int]$Height, [int]$Channels = 3)
    $px = New-Object byte[] ($Width * $Height * $Channels)
    for ($y = 0; $y -lt $Height; $y++) {
        for ($x = 0; $x -lt $Width; $x++) {
            $i = ($y * $Width + $x) * $Channels
            $px[$i] = [byte]((40 + $x) -band 0xFF)
            $px[$i + 1] = [byte]((90 + $y) -band 0xFF)
            $px[$i + 2] = [byte]((150 + $x + $y) -band 0xFF)
            if ($Channels -eq 4) { $px[$i + 3] = [byte]255 }
        }
    }
    return , $px
}

# 在样本数组上画一个实心矩形（模拟「这一帧多画了界面」的那块像素）
function Set-TestRect {
    param(
        [Parameter(Mandatory = $true)][byte[]]$Pixels,
        [Parameter(Mandatory = $true)][int]$Width,
        [Parameter(Mandatory = $true)][int]$Channels,
        [int]$X0 = 0, [int]$Y0 = 0, [int]$W = 1, [int]$H = 1,
        [int]$R = 250, [int]$G = 250, [int]$B = 250
    )
    for ($y = $Y0; $y -lt ($Y0 + $H); $y++) {
        for ($x = $X0; $x -lt ($X0 + $W); $x++) {
            $i = ($y * $Width + $x) * $Channels
            $Pixels[$i] = [byte]$R; $Pixels[$i + 1] = [byte]$G; $Pixels[$i + 2] = [byte]$B
            if ($Channels -eq 4) { $Pixels[$i + 3] = [byte]255 }
        }
    }
}

Write-Host '-- E3.content GUI 实拍帧 vs 同机位 gui:none 对照帧' -ForegroundColor DarkCyan
$e3cDir = Join-Path $outDir 'e3-content'
New-Item -ItemType Directory -Force -Path $e3cDir | Out-Null
$e3cW = 64; $e3cH = 48                                       # 3072 像素
$e3cBase = New-TestFrame -Width $e3cW -Height $e3cH
$e3cSame = [byte[]]$e3cBase.Clone()                          # 与对照帧完全相同（Gitea #205 现象）
$e3cRect = [byte[]]$e3cBase.Clone()
Set-TestRect -Pixels $e3cRect -Width $e3cW -Channels 3 -X0 20 -Y0 16 -W 24 -H 16   # 384/3072 = 12.5%
$e3cTiny = [byte[]]$e3cBase.Clone()
Set-TestRect -Pixels $e3cTiny -Width $e3cW -Channels 3 -X0 30 -Y0 20 -W 2 -H 1      # 2/3072 = 0.065%
$pE3Base = Join-Path $e3cDir 'gui-none.png'
$pE3Same = Join-Path $e3cDir 'gui-screen-same.png'
$pE3Rect = Join-Path $e3cDir 'gui-screen-rect.png'
$pE3Tiny = Join-Path $e3cDir 'gui-screen-tiny.png'
Write-TestPng -Path $pE3Base -Width $e3cW -Height $e3cH -Pixels $e3cBase
Write-TestPng -Path $pE3Same -Width $e3cW -Height $e3cH -Pixels $e3cSame
Write-TestPng -Path $pE3Rect -Width $e3cW -Height $e3cH -Pixels $e3cRect
Write-TestPng -Path $pE3Tiny -Width $e3cW -Height $e3cH -Pixels $e3cTiny

# ① 本判据的存在理由：两帧逐字节相同 ⇒ fail，且红文本必须点出「没有改到任何像素」
$e3cRSame = Test-InputGuiFrameContent -ScreenPng $pE3Same -ControlPng $pE3Base -Detail 'runId=20261008-gui camera=gui-live'
Expect 'E3.content 两帧逐字节相同 ⇒ fail' $e3cRSame 'fail'
Check 'E3.content 相同帧的红文本点出「逐字节相同 ⇒ 界面绘制没有改到任何像素」' `
    (($e3cRSame.detail -match '逐字节相同') -and ($e3cRSame.detail -match '没有改到任何像素')) ([string]$e3cRSame.detail)

# ② 中部有显著矩形差异（384/3072 = 12.5%）⇒ pass
$e3cRRect = Test-InputGuiFrameContent -ScreenPng $pE3Rect -ControlPng $pE3Base
Expect 'E3.content 中部矩形差异 12.5% ⇒ pass' $e3cRRect 'pass'
Check 'E3.content 正例的差异计数逐像素精确（384/3072）' (($e3cRRect.detail -match '差异像素 384/3072')) ([string]$e3cRRect.detail)

# ③ 负对照（**必须真变红**）：只差 2 像素（0.065% < 0.5%）⇒ fail，防止「有点差异就放行」
Expect 'E3.content 负对照：差异仅 2 像素（0.065%）⇒ fail' (Test-InputGuiFrameContent -ScreenPng $pE3Tiny -ControlPng $pE3Base) 'fail'

# ④ 对照帧 / screen 帧路径不存在 ⇒ fail（读不出不是「无差异」）
Expect 'E3.content 对照帧路径不存在 ⇒ fail' (Test-InputGuiFrameContent -ScreenPng $pE3Rect -ControlPng (Join-Path $e3cDir 'gui-none-missing.png')) 'fail'
Expect 'E3.content screen 帧路径不存在 ⇒ fail' (Test-InputGuiFrameContent -ScreenPng (Join-Path $e3cDir 'gui-screen-missing.png') -ControlPng $pE3Base) 'fail'

# ⑤ 尺寸不同 ⇒ fail
$pE3Other = Join-Path $e3cDir 'gui-screen-32x24.png'
Write-TestPng -Path $pE3Other -Width 32 -Height 24 -Pixels (New-TestFrame -Width 32 -Height 24)
Expect 'E3.content 两帧尺寸不同 ⇒ fail' (Test-InputGuiFrameContent -ScreenPng $pE3Other -ControlPng $pE3Base) 'fail'

# ⑥ 无法解码的文件：文本改名 .png / 截断的 PNG ⇒ fail
$pE3Text = Join-Path $e3cDir 'gui-screen-not-a-png.png'
Set-Content -Path $pE3Text -Value 'this file is not a PNG at all, just text renamed to .png' -Encoding utf8NoBOM
Expect 'E3.content 文本改名 .png（解不开）⇒ fail' (Test-InputGuiFrameContent -ScreenPng $pE3Text -ControlPng $pE3Base) 'fail'
$pE3Trunc = Join-Path $e3cDir 'gui-screen-truncated.png'
$e3cFull = [System.IO.File]::ReadAllBytes($pE3Rect)
[System.IO.File]::WriteAllBytes($pE3Trunc, [byte[]]$e3cFull[0..([int]($e3cFull.Length / 2))])
Expect 'E3.content 截断的 PNG ⇒ fail（读不出像素）' (Test-InputGuiFrameContent -ScreenPng $pE3Trunc -ControlPng $pE3Base) 'fail'

# ⑦ 判界在 0.5 上：差异恰为 4/800 = 0.500% ⇒ pass（用 >=，不许把恰好达标算红）
$e3cBW = 40; $e3cBH = 20                                     # 800 像素
$e3cBBase = New-TestFrame -Width $e3cBW -Height $e3cBH
$e3cBEdge = [byte[]]$e3cBBase.Clone()
Set-TestRect -Pixels $e3cBEdge -Width $e3cBW -Channels 3 -X0 10 -Y0 8 -W 4 -H 1
$pE3BBase = Join-Path $e3cDir 'bound-none.png'
$pE3BEdge = Join-Path $e3cDir 'bound-screen-4px.png'
Write-TestPng -Path $pE3BBase -Width $e3cBW -Height $e3cBH -Pixels $e3cBBase
Write-TestPng -Path $pE3BEdge -Width $e3cBW -Height $e3cBH -Pixels $e3cBEdge
$e3cREdge = Test-InputGuiFrameContent -ScreenPng $pE3BEdge -ControlPng $pE3BBase
Expect 'E3.content 差异恰在阈值上（4/800 = 0.500%）⇒ pass' $e3cREdge 'pass'
Check 'E3.content 判界口径是 >=（恰好达标不许算红）' (($e3cREdge.detail -match '差异像素 4/800')) ([string]$e3cREdge.detail)

# ⑧ RGBA（颜色型 6）也必须能解码，结果与 RGB 同内容一致
$e3cRgbaBase = New-TestFrame -Width $e3cW -Height $e3cH -Channels 4
$e3cRgbaRect = [byte[]]$e3cRgbaBase.Clone()
Set-TestRect -Pixels $e3cRgbaRect -Width $e3cW -Channels 4 -X0 20 -Y0 16 -W 24 -H 16
$pE3RgbaBase = Join-Path $e3cDir 'rgba-none.png'
$pE3RgbaRect = Join-Path $e3cDir 'rgba-screen-rect.png'
Write-TestPng -Path $pE3RgbaBase -Width $e3cW -Height $e3cH -Pixels $e3cRgbaBase -ColorType 6
Write-TestPng -Path $pE3RgbaRect -Width $e3cW -Height $e3cH -Pixels $e3cRgbaRect -ColorType 6
$e3cRRgba = Test-InputGuiFrameContent -ScreenPng $pE3RgbaRect -ControlPng $pE3RgbaBase
Expect 'E3.content RGBA（颜色型 6）也能解码 ⇒ pass' $e3cRRgba 'pass'
Check 'E3.content RGBA 解码后的差异计数与 RGB 一致（384/3072）' (($e3cRRgba.detail -match '差异像素 384/3072')) ([string]$e3cRRgba.detail)

# ⑨ filter 0-4（含 Paeth）都必须能反回来：同一张图换 filter 编码，判据结论与差异计数必须不变
foreach ($e3cFt in 0..4) {
    $pE3F = Join-Path $e3cDir "gui-screen-filter$e3cFt.png"
    Write-TestPng -Path $pE3F -Width $e3cW -Height $e3cH -Pixels $e3cRect -FilterType $e3cFt
    $rF = Test-InputGuiFrameContent -ScreenPng $pE3F -ControlPng $pE3Base
    Expect "E3.content filter=$e3cFt 编码的帧 ⇒ pass" $rF 'pass'
    Check "E3.content filter=$e3cFt 反 filter 后差异计数仍为 384/3072（反 filter 正确）" `
        (($rF.detail -match '差异像素 384/3072')) ([string]$rF.detail)
}

# ---------------------------------------------------------------------------
# E3.draw：界面绘制自证（同一帧内 changedPixels；mod 自述侧）
#   三条必须区分开的形态：#205 现场（0 改动）、旧版 mod（无该字段 = 未覆盖）、绘制失败（drawn=false）
# ---------------------------------------------------------------------------
Write-Host '-- E3.draw 界面绘制自证（同帧内 changedPixels）' -ForegroundColor DarkCyan

$e3dCapOk = [pscustomobject]@{ mode = 'screen'; screen = 'net.minecraft.client.gui.inventory.GuiContainerCreative'
    drawn = $true; changedPixels = 1500; frameHashBefore = 'aaaa1111bbbb2222'; frameHashAfter = 'cccc3333dddd4444'
    windowFramebufferCenterPixel = '#00ffffff'
}
$e3dMetaOk = [pscustomobject]@{ schema = 'lightning.shot-meta/1'; camera = 'e3-gui'; guiHidden = $false; guiCapture = @($e3dCapOk) }
Expect 'E3.draw drawn=true 且 changedPixels>0 ⇒ pass' (Test-InputGuiDrawLanded -ScreenMeta $e3dMetaOk -RunId 'r1') 'pass'

$e3dCapZero = [pscustomobject]@{ mode = 'screen'; screen = 'net.minecraft.client.gui.inventory.GuiContainerCreative'
    drawn = $true; changedPixels = 0; frameHashBefore = 'b4c145befb740428'; frameHashAfter = 'b4c145befb740428'
    windowFramebufferCenterPixel = '#00ffffff'
}
$e3dMetaZero = [pscustomobject]@{ schema = 'lightning.shot-meta/1'; camera = 'e3-gui'; guiHidden = $false; guiCapture = @($e3dCapZero) }
$e3dRZero = Test-InputGuiDrawLanded -ScreenMeta $e3dMetaZero
Expect 'E3.draw #205 现场形态：changedPixels=0 ⇒ fail' $e3dRZero 'fail'
Check 'E3.draw 零改动的红文本点出「没有改变本帧任何一个像素」' `
    (([string]$e3dRZero.detail) -match '没有改变本帧任何一个像素') ([string]$e3dRZero.detail)

# 旧版 mod 的产物没有这门自证字段 ⇒ 如实记「未覆盖」，不许因「没报错」含糊成 pass
$e3dCapNoField = [pscustomobject]@{ mode = 'screen'; screen = 'net.minecraft.client.gui.inventory.GuiContainerCreative'; drawn = $true }
$e3dMetaNoField = [pscustomobject]@{ schema = 'lightning.shot-meta/1'; camera = 'e3-gui'; guiHidden = $false; guiCapture = @($e3dCapNoField) }
$e3dRNoField = Test-InputGuiDrawLanded -ScreenMeta $e3dMetaNoField
Expect 'E3.draw 全部条目无 changedPixels 字段 ⇒ fail（未覆盖不等于通过）' $e3dRNoField 'fail'
Check 'E3.draw 未覆盖的红文本点出「未覆盖」' (([string]$e3dRNoField.detail) -match '未覆盖') ([string]$e3dRNoField.detail)

$e3dCapNotDrawn = [pscustomobject]@{ mode = 'screen'; screen = 'net.minecraft.client.gui.inventory.GuiContainerCreative'
    drawn = $false; changedPixels = 10
}
Expect 'E3.draw drawn=false（绘制未成功）⇒ fail' `
    (Test-InputGuiDrawLanded -ScreenMeta ([pscustomobject]@{ guiCapture = @($e3dCapNotDrawn) })) 'fail'

# 多机位：只要有一条没改到像素就红（不许用「另一条有改动」把整批判绿）
$e3dMetaMixed = [pscustomobject]@{ guiCapture = @(
        [pscustomobject]@{ screen = 'A'; drawn = $true; changedPixels = 900 },
        [pscustomobject]@{ screen = 'B'; drawn = $true; changedPixels = 0 }
    ) }
Expect 'E3.draw 多机位里一条零改动 ⇒ fail' (Test-InputGuiDrawLanded -ScreenMeta $e3dMetaMixed) 'fail'

Expect 'E3.draw guiCapture 缺席/为空 ⇒ fail' `
    (Test-InputGuiDrawLanded -ScreenMeta ([pscustomobject]@{ guiHidden = $true })) 'fail'
Expect 'E3.draw shot meta 读不出（$null）⇒ fail' (Test-InputGuiDrawLanded -ScreenMeta $null) 'fail'

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

