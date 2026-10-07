<#
  run-input-acceptance.ps1 的纯判定模块（输入手段族实机验收）
  ============================================================================
  这里只放「读 JSON / 比数值 / 判红绿」的纯函数：**不碰客户端、不发 HTTP、不起进程、不归档、不读文件**。
  输入一律是**已经落到内存里的纯数据**（作业 JSON / 错误信封 / 读面 JSON / 描述符 JSON），
  输出一律是 @{ id; ok; status; detail }（status = pass | fail | skipped | blocked）。

  为什么这样拆（照 anchor-checks.ps1 的既有拆法）：
    ① 同一份判定逻辑既能被驱动脚本用于真机轮次，也能被 run-input-acceptance-selftest.ps1
       用合成夹具反复喂——「好数据绿、坏数据精确红」才有离线证据；
    ② 判定里**不允许**有任何 I/O：读 options.txt / 读 runs 目录 / 走 HTTP 全归驱动，
       因此「判据红」永远只可能是数据的问题，不是编排的问题。

  口径（不许在本文件里放宽，逐条对应 Lead 定的验收口径）：
    - status='skipped' 与 'blocked' **都不是** pass（ok=$false）。跳过不许看起来像通过；
      G1 未实现时给 'blocked'（blocked-by-G1），不给 pass，也不给 fail（它不是被测实现的缺陷）。
    - 负对照判据（M7/M8/M9/M10）要求「非 0 退出 **且** 错误码命中」——
      「调用方侧本地拒绝」与「执行期作业 failed」两种形状都算（caller.mjs 只对前者给 HTTP 4xx）。

  约定：所有 Test-* 函数返回一个 check 对象，或**一个 check 对象的数组**（如 W6/W8 的两半）。
  调用方（驱动或自检）负责把数组摊平、打印、记红绿表。
#>

# ---------------------------------------------------------------------------
# check 对象构造（唯一构造点）
# ---------------------------------------------------------------------------
function New-CpCheck {
    param([string]$Id, [string]$Status, [string]$Detail)
    if ([string]::IsNullOrEmpty($Status)) { $Status = 'fail' }
    return [pscustomobject]@{
        id     = $Id
        ok     = ($Status -eq 'pass')
        status = $Status
        detail = $Detail
    }
}

function New-CpPass { param([string]$Id, [string]$Detail) New-CpCheck $Id 'pass' $Detail }
function New-CpFail { param([string]$Id, [string]$Detail) New-CpCheck $Id 'fail' $Detail }
function New-CpSkip { param([string]$Id, [string]$Detail) New-CpCheck $Id 'skipped' $Detail }
function New-CpBlocked { param([string]$Id, [string]$Detail) New-CpCheck $Id 'blocked' $Detail }

# ---------------------------------------------------------------------------
# 纯数据读取工具（PSCustomObject / hashtable / 数组通吃；缺字段一律 $null，不抛）
# ---------------------------------------------------------------------------
function Get-CpProp {
    param($Node, [string]$Name)
    if ($null -eq $Node) { return $null }
    if ($Node -is [System.Collections.IDictionary]) {
        if ($Node.Contains($Name)) { return $Node[$Name] }
        return $null
    }
    if ($Node -is [System.Management.Automation.PSCustomObject]) {
        if ($Node.PSObject.Properties.Name -contains $Name) { return $Node.$Name }
        return $null
    }
    return $null
}

# 数组字段的安全取值：字段缺席 / JSON null / 空数组一律返回 @()（0 元素）。
# 为什么必须单列：`@($node.absent)` 在 PowerShell 里是「一个 $null 元素」，会把「没有数组」
# 误读成「有 1 个元素」——这正好是「未实现被读成已具备」的失效模式在脚本层的翻版。
function Get-CpArray {
    param($Node, [string]$Name)
    $v = Get-CpProp $Node $Name
    if ($null -eq $v) { return @() }
    return @($v)
}

function Test-CpHasProp {
    param($Node, [string]$Name)
    if ($null -eq $Node) { return $false }
    if ($Node -is [System.Collections.IDictionary]) { return $Node.Contains($Name) }
    if ($Node -is [System.Management.Automation.PSCustomObject]) {
        return ($Node.PSObject.Properties.Name -contains $Name)
    }
    return $false
}

# RFC 6901 指针（与 read-shots / 判据 json-field 同口径；空串指根）
function Get-CpPointer {
    param($Node, [string]$Pointer)
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
        } elseif ($cur -is [System.Management.Automation.PSCustomObject] -or $cur -is [System.Collections.IDictionary]) {
            if (-not (Test-CpHasProp $cur $token)) { return $null }
            $cur = Get-CpProp $cur $token
        } else {
            return $null
        }
    }
    return $cur
}

function Format-CpValue {
    param($Value)
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) { return ($(if ($Value) { 'true' } else { 'false' })) }
    if ($Value -is [string]) { return $Value }
    try { return (($Value | ConvertTo-Json -Compress -Depth 4) -replace '\s+', ' ') } catch { return [string]$Value }
}

# ---------------------------------------------------------------------------
# 调用结果（caller.mjs 的 --json-out 文件）的读取口径
#   trial = @{ label; exitCode; json }
#   json 有两种合法形状：
#     ① 作业 JSON：{jobId, state:'done'|'failed', result?, error?, runId?}
#     ② 错误信封（HTTP 4xx 提交期拒绝）：{ok:false, httpStatus, error:{code,message,context?}}
# ---------------------------------------------------------------------------
function Get-CpTrialExit {
    param($Trial)
    if ($null -eq $Trial) { return -999 }
    $v = Get-CpProp $Trial 'exitCode'
    if ($null -eq $v) { return -999 }
    return [int]$v
}

function Get-CpTrialJson { param($Trial) return (Get-CpProp $Trial 'json') }
function Get-CpTrialState { param($Trial) return [string](Get-CpProp (Get-CpTrialJson $Trial) 'state') }
function Get-CpTrialJobId { param($Trial) return [string](Get-CpProp (Get-CpTrialJson $Trial) 'jobId') }
function Get-CpTrialHttpStatus { param($Trial) return (Get-CpProp (Get-CpTrialJson $Trial) 'httpStatus') }

function Get-CpTrialResult {
    param($Trial)
    return (Get-CpProp (Get-CpTrialJson $Trial) 'result')
}

function Get-CpTrialError {
    param($Trial)
    return (Get-CpProp (Get-CpTrialJson $Trial) 'error')
}

function Get-CpTrialErrorCode {
    param($Trial)
    $e = Get-CpTrialError $Trial
    if ($null -eq $e) { return $null }
    $c = Get-CpProp $e 'code'
    if ($null -eq $c) { return $null }
    return [string]$c
}

# 失败形状（只进 detail，不进判据）：submit = HTTP 4xx 提交期拒绝；job = 执行期作业 failed；timeout = 调用方超时
function Get-CpTrialShape {
    param($Trial)
    $json = Get-CpTrialJson $Trial
    if ($null -eq $json) { return 'no-json-out' }
    if ((Get-CpProp $json 'callerTimeout') -eq $true) { return 'timeout' }
    $http = Get-CpTrialHttpStatus $Trial
    if ($null -ne $http -and [int]$http -ge 400) { return "submit-http$http" }
    $state = Get-CpTrialState $Trial
    if ($state -eq 'failed') { return 'job-failed' }
    if ($state -eq 'done') { return 'job-done' }
    return "state=$state"
}

function Format-CpTrial {
    param($Trial)
    if ($null -eq $Trial) { return '(无调用)' }
    $label = [string](Get-CpProp $Trial 'label')
    return ("{0}: exit={1} shape={2} state={3} code={4}" -f `
            $(if ([string]::IsNullOrEmpty($label)) { '?' } else { $label }), `
        (Get-CpTrialExit $Trial), (Get-CpTrialShape $Trial), (Get-CpTrialState $Trial), (Get-CpTrialErrorCode $Trial))
}

# 「非 0 退出 且 错误码命中」——负对照判据的唯一实现（M7/M8/M9/M10 共用）
function Test-CpRejectedWithCode {
    param([string]$Id, $Trial, [string]$WantCode, [string]$What)
    $exit = Get-CpTrialExit $Trial
    $code = Get-CpTrialErrorCode $Trial
    $shape = Get-CpTrialShape $Trial
    $detail = ("{0}；期望拒绝且 code={1}；实测 {2}" -f $What, $WantCode, (Format-CpTrial $Trial))
    if ($exit -eq 0) { return (New-CpFail $Id ("未被拒绝（退出码 0 = 作业 done）$detail")) }
    if ($code -ne $WantCode) { return (New-CpFail $Id ("错误码不符（期望 $WantCode）$detail")) }
    return (New-CpPass $Id $detail)
}

# ---------------------------------------------------------------------------
# 坐标 / 几何（W3/W4 用）
# ---------------------------------------------------------------------------
function ConvertTo-CpVec3 {
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Array] -or $Value -is [System.Collections.IList]) {
        $a = @($Value)
        if ($a.Count -lt 3) { return $null }
        return @([double]$a[0], [double]$a[1], [double]$a[2])
    }
    if ((Test-CpHasProp $Value 'x') -and (Test-CpHasProp $Value 'y') -and (Test-CpHasProp $Value 'z')) {
        return @([double](Get-CpProp $Value 'x'), [double](Get-CpProp $Value 'y'), [double](Get-CpProp $Value 'z'))
    }
    return $null
}

function Get-CpHorizontalDistance {
    param($A, $B)
    $va = ConvertTo-CpVec3 $A
    $vb = ConvertTo-CpVec3 $B
    if ($null -eq $va -or $null -eq $vb) { return $null }
    $dx = $vb[0] - $va[0]
    $dz = $vb[2] - $va[2]
    return [math]::Sqrt($dx * $dx + $dz * $dz)
}

# read.player 的位置字段名探测（W4 的诚实边界：字段名不硬编码猜）
# 依次探测 []、/pos/server、/pos/client、/pos；命中即返回 @{ pointer; value }
function Get-CpPlayerPosPointer {
    param($PlayerJson)
    foreach ($p in @('/pos/server', '/pos/client', '/pos')) {
        $v = Get-CpPointer $PlayerJson $p
        if ($null -ne (ConvertTo-CpVec3 $v)) { return $p }
    }
    if ($null -ne (ConvertTo-CpVec3 $PlayerJson)) { return '' }
    return $null
}

# ---------------------------------------------------------------------------
# Stage pre
# ---------------------------------------------------------------------------

# P0：options.txt 的 pauseOnLostFocus:false 已在（先证明「失焦也持续 tick」这条）
#   输入是 options.txt 的**全部文本**。命中口径与 drive-session.ps1 的回读校验逐字相同：
#   必须恰有一行 pauseOnLostFocus:，且其值就是 false。
function Test-InputP0PauseOnLostFocus {
    param([string]$OptionsText, [string]$OptionsPath = 'options.txt')
    if ([string]::IsNullOrEmpty($OptionsText)) {
        return (New-CpFail 'P0' "options.txt 空或读不到（$OptionsPath）：无法证明失焦仍持续 tick")
    }
    $hits = @()
    foreach ($line in ($OptionsText -split "`r?`n")) {
        $t = $line.Trim()
        if ($t -match '^pauseOnLostFocus:(.*)$') { $hits += $t }
    }
    if ($hits.Count -eq 0) {
        return (New-CpFail 'P0' "options.txt 里没有 pauseOnLostFocus 行（$OptionsPath）：失焦会弹暂停菜单 ⇒ 无人值守不 tick")
    }
    # 必须**恰有一条**且为 false：多行（冲突）会让「哪个生效」不可判定，与 drive-session.ps1 的回读校验同口径
    if ($hits.Count -ne 1 -or $hits[0] -cne 'pauseOnLostFocus:false') {
        return (New-CpFail 'P0' ("pauseOnLostFocus 行必须恰有一条且为 false；实测 [$($hits -join ' | ')]（$OptionsPath）"))
    }
    return (New-CpPass 'P0' "options.txt 已钉 pauseOnLostFocus:false（唯一生效行，$OptionsPath）")
}

# P1：server.json 的 contractVersion == "1.8"
function Test-InputP1ContractVersion {
    param($ServerJson, [string]$Want = '1.8')
    if ($null -eq $ServerJson) { return (New-CpFail 'P1' 'server.json 读不到') }
    $v = [string](Get-CpProp $ServerJson 'contractVersion')
    if ($v -ne $Want) { return (New-CpFail 'P1' "contractVersion=$v（要求 $Want）") }
    $port = Get-CpProp $ServerJson 'port'
    return (New-CpPass 'P1' "contractVersion=$v port=$port")
}

# P2：动作目录（caller.mjs --actions 的 JSON）
function Test-InputP2ActionCatalog {
    param($Catalog, [int]$WantCount = 48)
    if ($null -eq $Catalog) { return (New-CpFail 'P2' '动作目录 JSON 读不到（GET /actions）') }
    $problems = New-Object System.Collections.ArrayList
    $count = Get-CpProp $Catalog 'count'
    $actions = Get-CpArray $Catalog 'actions'
    if ($null -eq $count) { [void]$problems.Add('count 字段缺席') }
    elseif ([int]$count -ne $WantCount) { [void]$problems.Add("count=$count（要求 $WantCount）") }
    if ($actions.Count -ne $WantCount) { [void]$problems.Add("actions[] 长度 $($actions.Count) != count $WantCount") }
    $byName = @{}
    foreach ($a in $actions) { $byName[[string](Get-CpProp $a 'name')] = $a }

    $writable = @('input.key', 'input.mouse', 'input.text', 'input.release')
    foreach ($n in $writable) {
        if (-not $byName.ContainsKey($n)) { [void]$problems.Add("$n 不在动作目录里"); continue }
        $d = $byName[$n]
        if ([string](Get-CpProp $d 'tier') -ne 'scene') { [void]$problems.Add("$n.tier=$([string](Get-CpProp $d 'tier'))（要求 scene）") }
        if ((Get-CpProp $d 'writable') -ne $true) { [void]$problems.Add("$n.writable=$((Get-CpProp $d 'writable'))（要求 true）") }
        if ((Get-CpProp $d 'confirmRequired') -ne $true) { [void]$problems.Add("$n.confirmRequired=$((Get-CpProp $d 'confirmRequired'))（要求 true）") }
        if ([string](Get-CpProp $d 'since') -ne '1.8') { [void]$problems.Add("$n.since=$([string](Get-CpProp $d 'since'))（要求 1.8）") }
        if ([string](Get-CpProp $d 'means') -ne 'input') { [void]$problems.Add("$n.means=$([string](Get-CpProp $d 'means'))（要求 input）") }
    }
    if (-not $byName.ContainsKey('input.state')) {
        [void]$problems.Add('input.state 不在动作目录里')
    } else {
        $d = $byName['input.state']
        if ([string](Get-CpProp $d 'tier') -ne 'observe') { [void]$problems.Add("input.state.tier=$([string](Get-CpProp $d 'tier'))（要求 observe）") }
        if ((Get-CpProp $d 'writable') -ne $false) { [void]$problems.Add("input.state.writable=$((Get-CpProp $d 'writable'))（要求 false）") }
        if ([string](Get-CpProp $d 'since') -ne '1.8') { [void]$problems.Add("input.state.since=$([string](Get-CpProp $d 'since'))（要求 1.8）") }
        if ([string](Get-CpProp $d 'means') -ne 'input') { [void]$problems.Add("input.state.means=$([string](Get-CpProp $d 'means'))（要求 input）") }
    }
    if ($problems.Count -gt 0) { return (New-CpFail 'P2' ("count=$count；" + ($problems -join '; '))) }
    return (New-CpPass 'P2' "count=$count；五个 input.* 的 tier/writable/confirmRequired/since=1.8/means=input 全部命中")
}

# P3（G8 实机面）：除五个 input.* 外，其余动作的自描述 JSON 里都不含 means 键
function Test-InputP3MeansNotLeaked {
    param($Catalog, [int]$WantOthers = 43)
    if ($null -eq $Catalog) { return (New-CpFail 'P3' '动作目录 JSON 读不到（GET /actions）') }
    $actions = Get-CpArray $Catalog 'actions'
    $leaked = New-Object System.Collections.ArrayList
    $others = 0
    foreach ($a in $actions) {
        $n = [string](Get-CpProp $a 'name')
        if ($n -like 'input.*') { continue }
        $others++
        if (Test-CpHasProp $a 'means') {
            [void]$leaked.Add("$n(means=$(Format-CpValue (Get-CpProp $a 'means')))")
        }
    }
    if ($leaked.Count -gt 0) {
        return (New-CpFail 'P3' ("means 泄漏到非输入族动作（$($leaked.Count) 个）: " + ($leaked -join ', ')))
    }
    if ($others -ne $WantOthers) {
        return (New-CpFail 'P3' "非输入族动作数=$others（要求 $WantOthers）；means 未泄漏，但计数不符")
    }
    return (New-CpPass 'P3' "非输入族 $others 个动作的自描述 JSON 里均无 means 键（可选字段未被默认值冒充）")
}

# ---------------------------------------------------------------------------
# Stage menu
# ---------------------------------------------------------------------------

# 编排自加的守卫（不是 Lead 的验收判据）：menu 段的前提是「无世界」
function Test-InputM0NoWorld {
    param($StatusTrial)
    $res = Get-CpTrialResult $StatusTrial
    if ($null -eq $res) {
        return (New-CpFail 'M0' ("core.status 不可用，无法确认 menu 段的前置（无世界）: " + (Format-CpTrial $StatusTrial)))
    }
    $loaded = Get-CpProp (Get-CpProp $res 'world') 'loaded'
    $folder = Get-CpProp (Get-CpProp $res 'world') 'folder'
    if ($loaded -eq $true) {
        return (New-CpFail 'M0' "menu 段前提不成立：world.loaded=true（folder=$folder）——菜单段断言在已进世界时不可比")
    }
    return (New-CpPass 'M0' "world.loaded=$loaded（menu 段前提成立：无世界）")
}

# M1：down 投递成功、持键表 1 条、jobId 非空
function Test-InputM1KeyDown {
    param($Trial)
    if ((Get-CpTrialExit $Trial) -ne 0) {
        return (New-CpFail 'M1' ("input.key down 未成功: " + (Format-CpTrial $Trial)))
    }
    $res = Get-CpTrialResult $Trial
    if ($null -eq $res) { return (New-CpFail 'M1' "作业 done 但无 result 字段: $(Format-CpTrial $Trial)") }
    $delivered = Get-CpProp $res 'delivered'
    $held = Get-CpProp $res 'held'
    $count = Get-CpProp $held 'count'
    $items = Get-CpArray $held 'items'
    $jobId = $null
    if ($items.Count -gt 0) { $jobId = [string](Get-CpProp $items[0] 'jobId') }
    $d = "delivered=$delivered held.count=$count held.items[0].jobId=$(if ([string]::IsNullOrEmpty($jobId)) { '(空)' } else { $jobId })"
    if ([int]$delivered -ne 1) { return (New-CpFail 'M1' "delivered=$delivered（要求 1）；$d") }
    if ([int]$count -ne 1) { return (New-CpFail 'M1' "held.count=$count（要求 1）；$d") }
    if ([string]::IsNullOrEmpty($jobId)) { return (New-CpFail 'M1' "held.items[0].jobId 为空（持键归属不可判）；$d") }
    return (New-CpPass 'M1' $d)
}

# M2：同键再 down ⇒ 幂等（alreadyHeld=true、delivered=0、held.count 仍 1）
#   负对照口径：delivered=1 即「重投」，判红。
function Test-InputM2KeyDownIdempotent {
    param($Trial)
    if ((Get-CpTrialExit $Trial) -ne 0) {
        return (New-CpFail 'M2' ("第二次 input.key down 未成功: " + (Format-CpTrial $Trial)))
    }
    $res = Get-CpTrialResult $Trial
    if ($null -eq $res) { return (New-CpFail 'M2' "作业 done 但无 result 字段: $(Format-CpTrial $Trial)") }
    $delivered = Get-CpProp $res 'delivered'
    $already = Get-CpProp $res 'alreadyHeld'
    $count = Get-CpProp (Get-CpProp $res 'held') 'count'
    $d = "delivered=$delivered alreadyHeld=$already held.count=$count"
    if ([int]$delivered -ne 0) { return (New-CpFail 'M2' "delivered=$delivered（重投！幂等要求 0）；$d") }
    if ($already -ne $true) { return (New-CpFail 'M2' "alreadyHeld=$already（要求 true）；$d") }
    if ([int]$count -ne 1) { return (New-CpFail 'M2' "held.count=$count（要求仍为 1）；$d") }
    return (New-CpPass 'M2' $d)
}

# M3：release 全清 + 幂等（第二次 count=0 且 alreadyIdle=true）
function Test-InputM3Release {
    param($First, $Second)
    foreach ($t in @($First, $Second)) {
        if ((Get-CpTrialExit $t) -ne 0) {
            return (New-CpFail 'M3' ("input.release 未成功: " + (Format-CpTrial $t)))
        }
    }
    $r1 = Get-CpTrialResult $First
    $r2 = Get-CpTrialResult $Second
    if ($null -eq $r1 -or $null -eq $r2) { return (New-CpFail 'M3' 'release 的 result 字段缺席') }
    $c1 = Get-CpProp $r1 'count'
    $c2 = Get-CpProp $r2 'count'
    $idle2 = Get-CpProp $r2 'alreadyIdle'
    $d = "第一次 count=$c1；第二次 count=$c2 alreadyIdle=$idle2"
    if ([int]$c1 -lt 1) { return (New-CpFail 'M3' "第一次 release count=$c1（要求 >=1，说明确有可释放的持键）；$d") }
    if ([int]$c2 -ne 0) { return (New-CpFail 'M3' "第二次 release count=$c2（要求 0）；$d") }
    if ($idle2 -ne $true) { return (New-CpFail 'M3' "第二次 release alreadyIdle=$idle2（要求 true）；$d") }
    return (New-CpPass 'M3' $d)
}

# M4：tap holdTicks:1 = 同一 tick down+up ⇒ delivered=2
function Test-InputM4TapSameTick {
    param($Trial)
    if ((Get-CpTrialExit $Trial) -ne 0) { return (New-CpFail 'M4' ("tap holdTicks=1 未成功: " + (Format-CpTrial $Trial))) }
    $res = Get-CpTrialResult $Trial
    if ($null -eq $res) { return (New-CpFail 'M4' 'result 字段缺席') }
    $delivered = Get-CpProp $res 'delivered'
    $ht = Get-CpProp $res 'holdTicks'
    $d = "delivered=$delivered holdTicks=$ht events=$((Get-CpArray $res 'events').Count)"
    if ([int]$delivered -ne 2) { return (New-CpFail 'M4' "delivered=$delivered（要求 2 = 同 tick down+up）；$d") }
    return (New-CpPass 'M4' $d)
}

# 从结果里读「实际持有 tick 数」（autoReleased 优先，退到 released；两者都没有返回 $null）
function Get-CpHeldTicksFromResult {
    param($Result)
    $candidates = New-Object System.Collections.ArrayList
    foreach ($key in @('autoReleased', 'released')) {
        foreach ($item in (Get-CpArray $Result $key)) {
            $v = Get-CpProp $item 'heldTicks'
            if ($null -ne $v) { [void]$candidates.Add([double]$v) }
        }
    }
    if ($candidates.Count -eq 0) { return $null }
    return ($candidates | Measure-Object -Maximum).Maximum
}

# M5：tap holdTicks:5 跨帧 ⇒ delivered=2 且 heldTicks>=5
function Test-InputM5TapCrossFrame {
    param($Trial, [int]$MinHeldTicks = 5)
    if ((Get-CpTrialExit $Trial) -ne 0) { return (New-CpFail 'M5' ("tap holdTicks=5 未成功: " + (Format-CpTrial $Trial))) }
    $res = Get-CpTrialResult $Trial
    if ($null -eq $res) { return (New-CpFail 'M5' 'result 字段缺席') }
    $delivered = Get-CpProp $res 'delivered'
    $heldTicks = Get-CpHeldTicksFromResult $res
    $auto = Get-CpArray $res 'autoReleased'
    $rel = Get-CpArray $res 'released'
    $d = "delivered=$delivered holdTicks=$([string](Get-CpProp $res 'holdTicks')) heldTicks=$(if ($null -eq $heldTicks) { '(无明细)' } else { $heldTicks }) autoReleased=$($auto.Count) released=$($rel.Count)"
    if ([int]$delivered -ne 2) { return (New-CpFail 'M5' "delivered=$delivered（要求 2：跨帧的 down 与到期抬起的 up）；$d") }
    if ($null -eq $heldTicks) { return (New-CpFail 'M5' "autoReleased/released 里都没有 heldTicks ⇒ 跨帧持有量不可复核；$d") }
    if ([double]$heldTicks -lt $MinHeldTicks) { return (New-CpFail 'M5' "heldTicks=$heldTicks（要求 >=$MinHeldTicks）；$d") }
    return (New-CpPass 'M5' $d)
}

# M6：滚轮档位投递
function Test-InputM6Wheel {
    param($Trial)
    if ((Get-CpTrialExit $Trial) -ne 0) { return (New-CpFail 'M6' ("input.mouse wheel 未成功: " + (Format-CpTrial $Trial))) }
    $res = Get-CpTrialResult $Trial
    if ($null -eq $res) { return (New-CpFail 'M6' 'result 字段缺席') }
    $delivered = Get-CpProp $res 'delivered'
    $d = "delivered=$delivered amount=$([string](Get-CpProp $res 'amount')) sign=$([string](Get-CpProp $res 'sign'))"
    if ([int]$delivered -ne 1) { return (New-CpFail 'M6' "delivered=$delivered（要求 1）；$d") }
    return (New-CpPass 'M6' $d)
}

# M7：零档负对照 ⇒ 非 0 且 CP-VALID-002
function Test-InputM7WheelZeroRejected {
    param($Trial)
    return (Test-CpRejectedWithCode -Id 'M7' -Trial $Trial -WantCode 'CP-VALID-002' -What 'input.mouse wheel amount=0（零档不许当 no-op 绿）')
}

# M8：holdTicks 越上界负对照 ⇒ 非 0 且 CP-VALID-002
function Test-InputM8HoldTicksOverMaxRejected {
    param($Trial)
    return (Test-CpRejectedWithCode -Id 'M8' -Trial $Trial -WantCode 'CP-VALID-002' -What 'input.key tap holdTicks=1201（持有上限 1200）')
}

# M9：不适用字段负对照 ⇒ 非 0 且 CP-VALID-002
function Test-InputM9HoldTicksInapplicableRejected {
    param($Trial)
    return (Test-CpRejectedWithCode -Id 'M9' -Trial $Trial -WantCode 'CP-VALID-002' -What 'input.key action=down 带 holdTicks（不适用字段必须显式拒绝，不许静默忽略）')
}

# M10：文本不许假绿 ⇒ 非 0 且 CP-STATE-001（能力未就绪）
function Test-InputM10TextNotReady {
    param($Trial)
    return (Test-CpRejectedWithCode -Id 'M10' -Trial $Trial -WantCode 'CP-STATE-001' -What 'input.text（文本路由两路均未打通 ⇒ 必须显式失败，不许 delivered:N 的绿）')
}

# M11：input.state 的能力声明面
function Test-InputM11InputState {
    param($Trial, [string[]]$WantActions = @('input.key', 'input.mouse', 'input.release', 'input.state', 'input.text'))
    if ((Get-CpTrialExit $Trial) -ne 0) { return (New-CpFail 'M11' ("input.state 未成功: " + (Format-CpTrial $Trial))) }
    $res = Get-CpTrialResult $Trial
    if ($null -eq $res) { return (New-CpFail 'M11' 'result 字段缺席') }
    $problems = New-Object System.Collections.ArrayList

    if ((Get-CpProp $res 'implemented') -ne $true) { [void]$problems.Add("implemented=$((Get-CpProp $res 'implemented'))（要求 true）") }
    if ([string](Get-CpProp $res 'family') -ne 'input') { [void]$problems.Add("family=$([string](Get-CpProp $res 'family'))（要求 input）") }

    $gotActions = @((Get-CpArray $res 'actions') | ForEach-Object { [string]$_ })
    $want = @($WantActions | Sort-Object)
    $gotSorted = @($gotActions | Sort-Object)
    if (($gotSorted -join ',') -ne ($want -join ',')) {
        [void]$problems.Add("actions=[$($gotActions -join ',')]（要求恰为五个 input.* 名）")
    }

    $cat = Get-CpProp $res 'keyCatalog'
    $catCount = 0
    $badCat = New-Object System.Collections.ArrayList
    if ($null -eq $cat) {
        [void]$problems.Add('keyCatalog 缺席')
    } else {
        foreach ($p in @($cat.PSObject.Properties)) {
            $catCount++
            $v = $p.Value
            if ($null -eq $v -or -not ($v -is [int] -or $v -is [long] -or $v -is [double])) {
                [void]$badCat.Add("$($p.Name)=$(Format-CpValue $v)")
            }
        }
        if ($catCount -eq 0) { [void]$problems.Add('keyCatalog 是空对象（键位目录的权威来源不许为空）') }
        if ($badCat.Count -gt 0) { [void]$problems.Add("keyCatalog 里有非整数键码: $($badCat -join ', ')") }
    }

    $range = Get-CpArray $res 'keyCodeRange'
    $rangeOk = $false
    $rangeText = '(null/占位)'
    if ($range.Count -eq 2) {
        $lo = $range[0]; $hi = $range[1]
        $isInt = ($lo -is [int] -or $lo -is [long]) -and ($hi -is [int] -or $hi -is [long])
        if ($isInt) {
            $rangeText = "[$lo,$hi]"
            $rangeOk = ([int]$lo -ge 0) -and ([int]$hi -le 255) -and ([int]$lo -le [int]$hi) -and -not ([int]$lo -eq 0 -and [int]$hi -eq 0)
        } else {
            $rangeText = "[$(Format-CpValue $lo),$(Format-CpValue $hi)]（非整数）"
        }
    } elseif ($range.Count -ne 0) {
        $rangeText = "[$($range -join ',')]（长度不为 2）"
    }
    if (-not $rangeOk) { [void]$problems.Add("keyCodeRange=$rangeText（要求 [0,255] 这类真实整数区间，不是 null/占位）") }

    $mouseDepth = Get-CpProp (Get-CpProp $res 'queues') 'mouseDepth'
    if ([string]$mouseDepth -ne 'unobservable') {
        [void]$problems.Add("queues.mouseDepth=$([string]$mouseDepth)（鼠标侧无公开探针 ⇒ 必须如实为 ""unobservable""，不许编 0）")
    }
    $heldCount = Get-CpProp (Get-CpProp $res 'held') 'count'
    if ($null -eq $heldCount -or [int]$heldCount -ne 0) {
        [void]$problems.Add("held.count=$([string]$heldCount)（要求 0：本段结束不该留有持键）")
    }

    $d = "implemented=$((Get-CpProp $res 'implemented')) actions=$($gotActions.Count) 个 keyCatalog=$catCount 项 keyCodeRange=$rangeText mouseDepth=$mouseDepth held.count=$heldCount"
    if ($problems.Count -gt 0) { return (New-CpFail 'M11' ($d + '；' + ($problems -join '；'))) }
    return (New-CpPass 'M11' $d)
}

# M12：窗口/尺度上下文失效
#   会话内无法改变窗口尺寸 ⇒ 如实 skipped-with-reason（不许伪装成 pass）。
#   若操作者真的改了窗口（第二次快照的指纹与第一次不同）⇒ 该判据转为「上下文变化可机读」的绿。
function Test-InputM12ScaleContext {
    param($First, $Second)
    $r1 = Get-CpTrialResult $First
    if ($null -eq $r1) { return (New-CpSkip 'M12' 'skipped-with-reason: input.state 不可用，取不到 coordinates（无法观测上下文）') }
    $c1 = Get-CpProp $r1 'coordinates'
    if ($null -eq $c1) { return (New-CpSkip 'M12' 'skipped-with-reason: input.state.coordinates 字段缺席') }
    $fields = @('displayWidth', 'displayHeight', 'scaledWidth', 'scaledHeight', 'pixelScale', 'scaleFactor', 'guiScaleSetting', 'windowWidth', 'windowHeight')
    $fp = @()
    foreach ($f in $fields) { $fp += ("{0}={1}" -f $f, (Format-CpValue (Get-CpProp $c1 $f))) }
    $text1 = ($fp -join ' ')

    $r2 = Get-CpTrialResult $Second
    if ($null -eq $r2 -or $null -eq (Get-CpProp $r2 'coordinates')) {
        return (New-CpSkip 'M12' "skipped-with-reason: 会话内没有取到第二份 coordinates（需要人工改窗口尺寸才能测）；第一份: $text1")
    }
    $c2 = Get-CpProp $r2 'coordinates'
    $changed = @()
    foreach ($f in $fields) {
        $a = Get-CpProp $c1 $f; $b = Get-CpProp $c2 $f
        if ("$a" -ne "$b") { $changed += ("{0}:{1}->{2}" -f $f, (Format-CpValue $a), (Format-CpValue $b)) }
    }
    if ($changed.Count -eq 0) {
        return (New-CpSkip 'M12' "skipped-with-reason: 会话内窗口/尺度上下文未变（两次快照指纹逐字相同）⇒ 需要人工改窗口尺寸才能测；指纹: $text1")
    }
    return (New-CpPass 'M12' ("上下文确已变化且可机读: " + ($changed -join ', ') + "；第二次指纹: " + (($fields | ForEach-Object { "{0}={1}" -f $_, (Format-CpValue (Get-CpProp $c2 $_)) }) -join ' ')))
}

# ---------------------------------------------------------------------------
# Stage world
# ---------------------------------------------------------------------------

# W1：core.status 报 world.loaded=true 且 world.managed=true
function Test-InputW1WorldManaged {
    param($Trial)
    if ((Get-CpTrialExit $Trial) -ne 0) { return (New-CpFail 'W1' ("core.status 未成功: " + (Format-CpTrial $Trial))) }
    $res = Get-CpTrialResult $Trial
    $w = Get-CpProp $res 'world'
    if ($null -eq $w) { return (New-CpFail 'W1' 'core.status 无 world 字段') }
    $loaded = Get-CpProp $w 'loaded'
    $managed = Get-CpProp $w 'managed'
    $folder = [string](Get-CpProp $w 'folder')
    $d = "world.loaded=$loaded world.managed=$managed folder=$folder markerComplete=$((Get-CpProp $w 'markerComplete'))"
    if ($loaded -ne $true) { return (New-CpFail 'W1' "world.loaded=$loaded（要求 true）；$d") }
    if ($managed -ne $true) { return (New-CpFail 'W1' "world.managed=$managed（要求 true，即 cp_ 前缀的托管世界）；$d") }
    return (New-CpPass 'W1' $d)
}

# W2：失焦下仍推进（tap holdTicks:20 跨帧完成），consumer 两项如实
function Test-InputW2UnfocusedAdvance {
    param($Trial, [int]$HoldTicks = 20)
    if ((Get-CpTrialExit $Trial) -ne 0) { return (New-CpFail 'W2' ("世界内 tap holdTicks=$HoldTicks 未成功: " + (Format-CpTrial $Trial))) }
    $res = Get-CpTrialResult $Trial
    if ($null -eq $res) { return (New-CpFail 'W2' 'result 字段缺席') }
    $delivered = Get-CpProp $res 'delivered'
    $consumer = Get-CpProp $res 'consumer'
    if ($null -eq $consumer) { return (New-CpFail 'W2' "consumer 字段缺席（无法如实报告消费链/焦点）；delivered=$delivered") }
    $problems = New-Object System.Collections.ArrayList
    if ([int]$delivered -ne 2) { [void]$problems.Add("delivered=$delivered（要求 2）") }
    foreach ($k in @('displayActive', 'inGameHasFocus')) {
        if (-not (Test-CpHasProp $consumer $k)) {
            [void]$problems.Add("consumer.$k 缺席（必须如实报告）")
        } elseif ((Get-CpProp $consumer $k) -isnot [bool]) {
            [void]$problems.Add("consumer.$k=$(Format-CpValue (Get-CpProp $consumer $k))（须为布尔；null = 探针不可读）")
        }
    }
    $d = ("delivered={0} holdTicks={1} consumer.chain={2} displayActive={3} inGameHasFocus={4} allowUserInput={5}" -f `
        $delivered, (Format-CpValue (Get-CpProp $res 'holdTicks')), (Format-CpValue (Get-CpProp $consumer 'chain')), `
        (Format-CpValue (Get-CpProp $consumer 'displayActive')), (Format-CpValue (Get-CpProp $consumer 'inGameHasFocus')), `
        (Format-CpValue (Get-CpProp $consumer 'allowUserInput')))
    if ($problems.Count -gt 0) { return (New-CpFail 'W2' ($d + '；' + ($problems -join '；'))) }
    return (New-CpPass 'W2' $d)
}

# W3：世界相对移动生效（键真的起作用）——W4 的正对照
function Test-InputW3MovementEffective {
    param($PosA, $PosB, [double]$MinDistance = 0.5, [int]$WaitTicks = 40)
    $dist = Get-CpHorizontalDistance $PosA $PosB
    if ($null -eq $dist) {
        return (New-CpFail 'W3' ("坐标不可解析（A=$(Format-CpValue $PosA) B=$(Format-CpValue $PosB)）⇒ 无法判定位移"))
    }
    $d = ("horizontalDistance(A,B)={0:N3}（要求 > {1}）；A={2} B={3}；等待 {4} tick" -f $dist, $MinDistance, (Format-CpValue $PosA), (Format-CpValue $PosB), $WaitTicks)
    if ($dist -le $MinDistance) { return (New-CpFail 'W3' $d) }
    return (New-CpPass 'W3' $d)
}

# W4：D-7 到期抬起（只用 read.player 观测：它不触碰输入运行时）
#   口径：dist(A,B) > MinMove（等待期间键确实按着、玩家确实在动）
#         且 dist(B,C) < MaxStop（等待结束后键已被自动抬起、玩家停下来了）
function Test-InputW4ExpiryPump {
    param($PosA, $PosB, $PosC, [int]$PumpProofTicks = 1300, [double]$MinMove = 0.5, [double]$MaxStop = 0.1)
    $dAB = Get-CpHorizontalDistance $PosA $PosB
    $dBC = Get-CpHorizontalDistance $PosB $PosC
    if ($null -eq $dAB -or $null -eq $dBC) {
        return (New-CpFail 'W4' ("坐标不可解析（A=$(Format-CpValue $PosA) B=$(Format-CpValue $PosB) C=$(Format-CpValue $PosC)）⇒ 无法判定"))
    }
    $d = ("horizontalDistance(A,B)={0:N3}（要求 > {1}：等待期间键确实按着） horizontalDistance(B,C)={2:N3}（要求 < {3}：到期后已被自动抬起） PumpProofTicks={4}；A={5} B={6} C={7}" -f `
        $dAB, $MinMove, $dBC, $MaxStop, $PumpProofTicks, (Format-CpValue $PosA), (Format-CpValue $PosB), (Format-CpValue $PosC))
    if ($dAB -le $MinMove) { return (New-CpFail 'W4' ("等待期间玩家没动（按着的键没生效）⇒ 本判据不成立；$d")) }
    if ($dBC -ge $MaxStop) { return (New-CpFail 'W4' ("等待结束后玩家仍在动（键没有被自动抬起）；$d")) }
    return (New-CpPass 'W4' $d)
}

# W4 的证据充分性门（不许把「等得不够」读成「泵起作用了」）：
#   等待期间的客户端 tick 增量必须 >= PumpProofTicks，否则 heldTicks 上限 1200 还没到期，
#   dist(B,C) 小只能说明玩家因别的原因停下 ⇒ 假绿。
function Test-InputW4TickEvidence {
    param([long]$TickDelta, [int]$PumpProofTicks = 1300, [double]$WallSeconds = 0)
    if ($TickDelta -lt 0) { return (New-CpFail 'W4.evidence' "tick 增量不可读（TickDelta=$TickDelta）⇒ 无法证明等待覆盖了 1200 tick 的持有上限") }
    $d = ("等待期间客户端 tick 增量={0}（要求 >= {1}）；墙钟 {2:N1}s" -f $TickDelta, $PumpProofTicks, $WallSeconds)
    if ($TickDelta -lt $PumpProofTicks) {
        return (New-CpFail 'W4.evidence' ("证据不足（等得不够，不能证明 1200 tick 上限已到期）: $d"))
    }
    return (New-CpPass 'W4.evidence' $d)
}

# W5：移动自校准（readback 与请求值 ±1 且 withinTolerance=true）
function Test-InputW5MouseMoveCalibration {
    param($Trial, [double]$Tolerance = 1.0)
    if ((Get-CpTrialExit $Trial) -ne 0) { return (New-CpFail 'W5' ("input.mouse op=move 未成功: " + (Format-CpTrial $Trial))) }
    $res = Get-CpTrialResult $Trial
    if ($null -eq $res) { return (New-CpFail 'W5' 'result 字段缺席') }
    $rb = Get-CpProp $res 'readback'
    if ($null -eq $rb) { return (New-CpFail 'W5' 'readback 字段缺席（§2.4 要求 move 必须回读）') }
    if ((Get-CpProp $res 'delivered') -ne 1) { return (New-CpFail 'W5' "delivered=$((Get-CpProp $res 'delivered'))（要求 1）") }
    $within = Get-CpProp $rb 'withinTolerance'
    $reqX = Get-CpProp $rb 'requestedX'; $reqY = Get-CpProp $rb 'requestedY'
    $guiX = Get-CpProp $rb 'guiX'; $guiY = Get-CpProp $rb 'guiY'
    if ($null -eq $reqX) { $reqX = Get-CpProp (Get-CpProp $res 'requested') 'x' }
    if ($null -eq $reqY) { $reqY = Get-CpProp (Get-CpProp $res 'requested') 'y' }
    $d = "requested=($reqX,$reqY) readback.gui=($guiX,$guiY) withinTolerance=$within mouseX=$((Get-CpProp $rb 'mouseX')) mouseY=$((Get-CpProp $rb 'mouseY')) tolerance=$((Get-CpProp $rb 'tolerancePx'))"
    if ($null -eq $guiX -or $null -eq $guiY) { return (New-CpFail 'W5' "readback 的 GUI 坐标不可读（探针不可用）: $d") }
    if ($within -ne $true) { return (New-CpFail 'W5' "readback.withinTolerance=$within（要求 true）: $d") }
    if ($null -ne $reqX -and [math]::Abs([double]$guiX - [double]$reqX) -gt $Tolerance) { return (New-CpFail 'W5' "X 偏差 $([math]::Abs([double]$guiX - [double]$reqX)) > ${Tolerance}: $d") }
    if ($null -ne $reqY -and [math]::Abs([double]$guiY - [double]$reqY) -gt $Tolerance) { return (New-CpFail 'W5' "Y 偏差 $([math]::Abs([double]$guiY - [double]$reqY)) > ${Tolerance}: $d") }
    return (New-CpPass 'W5' $d)
}

# W6a：拖动四步都成功（move → down → move → up）
function Test-InputW6DragExitCodes {
    param($Trials)
    $list = @($Trials)
    $bad = New-Object System.Collections.ArrayList
    $parts = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $list.Count; $i++) {
        $t = $list[$i]
        $code = Get-CpTrialExit $t
        [void]$parts.Add(("${i}:{0}=exit{1}" -f (Get-CpProp $t 'label'), $code))
        if ($code -ne 0) { [void]$bad.Add(("第 {0} 步 {1} exit={2} code={3}" -f $i, (Get-CpProp $t 'label'), $code, (Get-CpTrialErrorCode $t))) }
    }
    $d = "四步: $($parts -join ' ')"
    if ($list.Count -ne 4) { return (New-CpFail 'W6a' "步骤数 $($list.Count) != 4；$d") }
    if ($bad.Count -gt 0) { return (New-CpFail 'W6a' (($bad -join '；') + "；$d")) }
    return (New-CpPass 'W6a' $d)
}

# W6b：down 返回里 hitSet.state 有真值（不是未实现占位）
function Test-InputW6HitSetTruthy {
    param($DownTrial)
    if ((Get-CpTrialExit $DownTrial) -ne 0) { return (New-CpFail 'W6b' ("down 未成功: " + (Format-CpTrial $DownTrial))) }
    $res = Get-CpTrialResult $DownTrial
    if ($null -eq $res) { return (New-CpFail 'W6b' 'result 字段缺席') }
    if (-not (Test-CpHasProp $res 'hitSet')) {
        return (New-CpFail 'W6b' "down 的返回里没有 hitSet 字段（实现只在 op=move 返回 hitSet{state,minSettleTicks}）⇒ 命中集状态在 down 上不可判")
    }
    $hit = Get-CpProp $res 'hitSet'
    $state = Get-CpProp $hit 'state'
    if ($null -eq $state -or [string]::IsNullOrWhiteSpace([string]$state)) {
        return (New-CpFail 'W6b' ("hitSet.state 为空/占位: $(Format-CpValue $state)（minSettleTicks=$(Format-CpValue (Get-CpProp $hit 'minSettleTicks'))）"))
    }
    $placeholder = @('unimplemented', 'not-implemented', 'notimplemented', 'todo', 'placeholder', 'stub', 'null', 'unknown', 'n/a', '未实现', '占位')
    if ($placeholder -contains ([string]$state).ToLowerInvariant()) {
        return (New-CpFail 'W6b' "hitSet.state='$state' 是未实现占位值")
    }
    return (New-CpPass 'W6b' "hitSet.state='$state' minSettleTicks=$(Format-CpValue (Get-CpProp $hit 'minSettleTicks'))")
}

# W7a：shot.multi 的自描述里**声明**了 gui 参数（无先验知识调用方能否开 GUI 实拍的前提）
function Test-InputW7GuiParamDeclared {
    param($Descriptor, [string]$WantValue = 'screen')
    if ($null -eq $Descriptor) { return (New-CpFail 'W7a' 'shot.multi 自描述读不到（--describe）') }
    $names = @((Get-CpArray $Descriptor 'params') | ForEach-Object { [string](Get-CpProp $_ 'name') })
    $p = @((Get-CpArray $Descriptor 'params') | Where-Object { [string](Get-CpProp $_ 'name') -eq 'gui' })
    if ($p.Count -eq 0) {
        return (New-CpFail 'W7a' "shot.multi 自描述里没有 gui 参数 ⇒ 无先验知识调用方**无法**开 GUI 实拍（caller.mjs 按自描述构造，会本地拒绝）；自描述参数: [$($names -join ', ')]")
    }
    $desc = [string](Get-CpProp $p[0] 'description')
    if ($desc -notmatch [regex]::Escape($WantValue)) {
        return (New-CpFail 'W7a' "gui 参数已声明但取值域说明里不含 '$WantValue'（说明: $desc）")
    }
    return (New-CpPass 'W7a' "shot.multi 声明了 gui 参数且说明含 '$WantValue'（说明: $desc）")
}

# 从 shot.multi 的作业结果里取逐机位对象（result.cameras[]；取不到时退到 artifactsByCamera[]）
function Get-CpShotCameras {
    param($Trial)
    $res = Get-CpTrialResult $Trial
    if ($null -eq $res) { return @() }
    $cams = Get-CpArray $res 'cameras'
    if ($cams.Count -gt 0) { return $cams }
    return (Get-CpArray $res 'artifactsByCamera')
}

# W7b：带 gui:"screen" 的实拍 ⇒ 每机位 meta 的 guiCapture 非空且 guiHidden=false
function Test-InputW7GuiCapturePositive {
    param($Trial)
    if ((Get-CpTrialExit $Trial) -ne 0) { return (New-CpFail 'W7b' ("带 gui:screen 的 shot.multi 未成功: " + (Format-CpTrial $Trial))) }
    $cams = @(Get-CpShotCameras $Trial)
    if ($cams.Count -eq 0) { return (New-CpFail 'W7b' '结果里没有 cameras[]/artifactsByCamera[]（取不到 meta 读数）') }
    $problems = New-Object System.Collections.ArrayList
    $parts = New-Object System.Collections.ArrayList
    foreach ($c in $cams) {
        $name = [string](Get-CpProp $c 'name')
        $hidden = Get-CpProp $c 'guiHidden'
        $capList = Get-CpArray $c 'guiCapture'
        $cap = $capList
        $first = if ($capList.Count -gt 0) { $capList[0] } else { $null }
        [void]$parts.Add(("{0}: guiHidden={1} guiCapture={2} 项 drawn={3} screen={4}" -f `
                $name, (Format-CpValue $hidden), $cap.Count, (Format-CpValue (Get-CpProp $first 'drawn')), (Format-CpValue (Get-CpProp $first 'screen'))))
        if ($hidden -ne $false) { [void]$problems.Add("$name.guiHidden=$hidden（要求 false）") }
        if ($cap.Count -eq 0) { [void]$problems.Add("$name.guiCapture 为空/缺席（要求非空数组）") }
    }
    $d = ($parts -join '; ')
    if ($problems.Count -gt 0) { return (New-CpFail 'W7b' (($problems -join '；') + "；$d")) }
    return (New-CpPass 'W7b' $d)
}

# W7c：不带 gui 的默认路径不受影响 ⇒ guiHidden=true 且**不含** guiCapture
function Test-InputW7DefaultPathUnchanged {
    param($Trial)
    if ((Get-CpTrialExit $Trial) -ne 0) { return (New-CpFail 'W7c' ("默认路径的 shot.multi 未成功: " + (Format-CpTrial $Trial))) }
    $cams = @(Get-CpShotCameras $Trial)
    if ($cams.Count -eq 0) { return (New-CpFail 'W7c' '结果里没有 cameras[]/artifactsByCamera[]（取不到 meta 读数）') }
    $problems = New-Object System.Collections.ArrayList
    $parts = New-Object System.Collections.ArrayList
    foreach ($c in $cams) {
        $name = [string](Get-CpProp $c 'name')
        $hidden = Get-CpProp $c 'guiHidden'
        $hasCap = Test-CpHasProp $c 'guiCapture'
        [void]$parts.Add(("{0}: guiHidden={1} guiCapture键={2}" -f $name, (Format-CpValue $hidden), $hasCap))
        if ($hidden -ne $true) { [void]$problems.Add("$name.guiHidden=$hidden（默认路径要求 true）") }
        if ($hasCap) { [void]$problems.Add("$name 里出现了 guiCapture 键（默认路径不得有它）") }
    }
    $d = ($parts -join '; ')
    if ($problems.Count -gt 0) { return (New-CpFail 'W7c' (($problems -join '；') + "；$d")) }
    return (New-CpPass 'W7c' $d)
}

# W8：physical.concurrent 真值（键盘侧布尔；鼠标侧仍须 unobservable）
function Test-InputW8PhysicalConcurrent {
    param($KeyboardTrial, $MouseTrial)
    $out = New-Object System.Collections.ArrayList

    $kres = Get-CpTrialResult $KeyboardTrial
    if ((Get-CpTrialExit $KeyboardTrial) -ne 0 -or $null -eq $kres) {
        [void]$out.Add((New-CpFail 'W8a' ("键盘侧调用未成功，physicalConcurrent 无从判定: " + (Format-CpTrial $KeyboardTrial))))
    } else {
        $v = Get-CpProp $kres 'physicalConcurrent'
        if ($null -eq $v) {
            [void]$out.Add((New-CpFail 'W8a' 'physicalConcurrent 字段缺席'))
        } elseif ($v -is [bool]) {
            [void]$out.Add((New-CpPass 'W8a' "键盘侧 physicalConcurrent=$($v.ToString().ToLowerInvariant())（布尔真值；held.count=$((Get-CpProp (Get-CpProp $kres 'held') 'count'))）"))
        } else {
            [void]$out.Add((New-CpFail 'W8a' "键盘侧 physicalConcurrent='$v'（要求布尔，不是字符串）⇒ 键盘队列深度探针不可用"))
        }
    }

    $mres = Get-CpTrialResult $MouseTrial
    if ((Get-CpTrialExit $MouseTrial) -ne 0 -or $null -eq $mres) {
        [void]$out.Add((New-CpFail 'W8b' ("鼠标侧调用未成功: " + (Format-CpTrial $MouseTrial))))
    } else {
        $v = Get-CpProp $mres 'physicalConcurrent'
        if ([string]$v -eq 'unobservable') {
            [void]$out.Add((New-CpPass 'W8b' "鼠标侧 physicalConcurrent='unobservable'（如实：鼠标队列深度无公开探针）"))
        } else {
            [void]$out.Add((New-CpFail 'W8b' "鼠标侧 physicalConcurrent=$(Format-CpValue $v)（要求 ""unobservable""——不许编造 false/true）"))
        }
    }
    return $out
}

# ---------------------------------------------------------------------------
# Stage g1（依赖 feat/cp-input-steps 的合入；未实现 ⇒ blocked-by-G1，不是 pass）
# ---------------------------------------------------------------------------

# G1 的「未实现」识别：只在证据明确指向 holdTicks 输入步时才算 blocked
function Test-CpLooksLikeG1Missing {
    param($Validation, $RunTrial)
    $texts = New-Object System.Collections.ArrayList
    foreach ($t in @($Validation, $RunTrial)) {
        if ($null -eq $t) { continue }
        if ((Get-CpTrialExit $t) -eq 0) { continue }
        $e = Get-CpTrialError $t
        if ($null -eq $e) { continue }
        [void]$texts.Add([string](Get-CpProp $e 'message'))
        $ctx = Get-CpProp $e 'context'
        $fields = Get-CpArray $ctx 'fields'
        foreach ($f in $fields) { [void]$texts.Add([string](Get-CpProp $f 'field') + ' ' + [string](Get-CpProp $f 'reason')) }
        [void]$texts.Add([string]$ctx)
    }
    foreach ($s in $texts) {
        if ($s -match 'holdTicks') { return $true }
        if ($s -match '步进' -and $s -match 'input') { return $true }
        if ($s -match 'stepping' -and $s -match 'input') { return $true }
    }
    return $false
}

# G1：cases/input-multitick.json 的 action 段真的跑起来了 + 跨帧推进有证据 + 无持键泄漏
function Test-InputG1CaseRun {
    param(
        $ValidationTrial,
        $RunTrial,
        $HeldAfter,
        $StepArtifacts,
        [string]$CasePath = 'cases/input-multitick.json',
        [int]$MinCrossFrameTicks = 2
    )
    # ① 未实现识别（G1 的分支判定优先于一切）：用例被拒且原因指向 holdTicks/输入步进
    $vExit = Get-CpTrialExit $ValidationTrial
    $rExit = Get-CpTrialExit $RunTrial
    if (($vExit -ne 0 -or $rExit -ne 0) -and (Test-CpLooksLikeG1Missing $ValidationTrial $RunTrial)) {
        $why = @()
        foreach ($t in @($ValidationTrial, $RunTrial)) {
            if ($null -eq $t -or (Get-CpTrialExit $t) -eq 0) { continue }
            $why += ("{0} exit={1} code={2} msg={3}" -f (Get-CpProp $t 'label'), (Get-CpTrialExit $t), (Get-CpTrialErrorCode $t), (Format-CpValue (Get-CpProp (Get-CpTrialError $t) 'message')))
        }
        return (New-CpBlocked 'G1' ("blocked-by-G1：action 段的输入步（顶层 holdTicks）尚未实现 ⇒ 本判据既不 pass 也不算实现缺陷；用例文件 $CasePath；证据: " + ($why -join ' | ')))
    }
    if ($rExit -ne 0) {
        return (New-CpFail 'G1' ("case.run 失败（且原因不指向 G1 未实现）: " + (Format-CpTrial $RunTrial)))
    }
    if ($vExit -ne 0) {
        return (New-CpFail 'G1' ("case.validate 失败但 case.run 成功（校验与执行不同源）: " + (Format-CpTrial $ValidationTrial)))
    }
    $problems = New-Object System.Collections.ArrayList

    # ② 跨帧推进证据：输入步产物里的实际持有量 / 相邻步的投递 tick 差
    $arts = @($StepArtifacts)
    $inputArts = @()
    foreach ($a in $arts) {
        $name = [string](Get-CpProp $a '__artifact')
        $act = [string](Get-CpProp $a 'action')
        $sem = [string](Get-CpProp $a 'semantics')
        if ($act -like 'input.*' -or $sem -in @('key', 'mouse', 'text', 'release')) { $inputArts += $a }
    }
    $evidence = New-Object System.Collections.ArrayList
    $crossOk = $false
    foreach ($a in $inputArts) {
        $ht = Get-CpHeldTicksFromResult $a
        if ($null -ne $ht -and [double]$ht -ge $MinCrossFrameTicks) {
            $crossOk = $true
            [void]$evidence.Add(("{0}: heldTicks={1}" -f ([string](Get-CpProp $a '__artifact')), $ht))
        }
        $tick = Get-CpProp $a 'deliveredAtTick'
        if ($null -ne $tick) { [void]$evidence.Add(("{0}: deliveredAtTick={1}" -f ([string](Get-CpProp $a '__artifact')), $tick)) }
    }
    $ticks = @($inputArts | ForEach-Object { Get-CpProp $_ 'deliveredAtTick' } | Where-Object { $null -ne $_ } | Sort-Object -Unique)
    if ($ticks.Count -ge 2 -and ([long]$ticks[-1] - [long]$ticks[0]) -ge 1) { $crossOk = $true }
    if ($inputArts.Count -eq 0) { [void]$problems.Add("本 run 里找不到任何 input.* 步骤产物（$CasePath 的 action 段没跑起来？）") }
    elseif (-not $crossOk) { [void]$problems.Add("没有跨帧推进证据（heldTicks >= $MinCrossFrameTicks 或不同步骤的 deliveredAtTick 有别）") }

    # ③ 无持键泄漏
    $heldCount = $null
    if ($null -ne (Get-CpTrialResult $HeldAfter)) {
        $heldCount = Get-CpProp (Get-CpProp (Get-CpTrialResult $HeldAfter) 'held') 'count'
    }
    if ($null -eq $heldCount) { [void]$problems.Add('跑完后取不到 input.state.held.count（无法证明无泄漏）') }
    elseif ([int]$heldCount -ne 0) { [void]$problems.Add("跑完后 held.count=$heldCount（要求 0：失败时也不许留下按着的键）") }
    foreach ($a in $inputArts) {
        $idle = Get-CpProp $a 'alreadyIdle'
        if ($null -ne $idle -and $idle -ne $true) { [void]$problems.Add(("{0}: alreadyIdle={1}（要求 true）" -f ([string](Get-CpProp $a '__artifact')), $idle)) }
    }

    $d = ("input 步骤产物 {0} 个；跨帧证据: {1}；跑完后 held.count={2}" -f $inputArts.Count, (($evidence | Select-Object -First 6) -join ', '), (Format-CpValue $heldCount))
    if ($problems.Count -gt 0) { return (New-CpFail 'G1' ($d + '；' + ($problems -join '；'))) }
    return (New-CpPass 'G1' $d)
}

# ===========================================================================
# Stage extra（E1/E2/E3）
#   E1 组合键（潜行修饰）被世界链按序消费
#   E2 队列满 ⇒ CP-STATE-001 且零写入
#   E3 产物可从既有清单发现并复核哈希
#
# 纪律与上面各段逐条相同：纯函数、无 IO、status ∈ {pass,fail,skipped,blocked}；
# skipped / blocked 都不是 pass。本段的**取舍理由**（哪些是判据、哪些只是证据）写在
# scripts/control-plane/README.md §15.8。
# ===========================================================================

# ---------------------------------------------------------------------------
# 状态比对口径：显式排除易变字段（**不做**「整体 JSON 字符串相等」）
#
# 为什么必须按字段名显式排除：E2 要断言的是「投递前后世界/玩家状态逐字相同」，
# 而观测面里天然混着每 tick 自增的计数、墙钟、GC 读数与**探针自身调用**在推进的记账
# ——把它们算进去会让判据「一撞就红」；反过来整串相等又会被一个易变字段掩盖真实写入。
# 因此这里的口径是：**逐路径叶子比对 + 显式排除清单**，且被排除的路径逐条进 detail。
# ---------------------------------------------------------------------------
function Get-CpVolatileFieldReason {
    param([string]$Name)
    $groups = @(
        @{ why = 'tick 计数/世界时刻：每 tick 自增，逐字比对必然不等'; names = @('totalTime', 'worldTime', 'gameTime', 'dayTime', 'tick', 'time') }
        @{ why = '墙钟/单调钟：前后两次读必然不同（**含各读面的 `readAt` 与取证产物的 `generatedAt`**——第一轮实机就是它们把「零写入」比对撞出一条假差异：`/player/readAt` 前后必然不同，与有没有写世界无关）'; names = @('serverTime', 'timestamp', 'createdAt', 'ts', 'at', 'uptimeMs', 'elapsedMs', 'nanoTime', 'readAt', 'generatedAt', 'boundAt', 'observedAt') }
        @{ why = 'JVM 内存读数：GC 自行变化，与「有没有写世界」无关'; names = @('memory', 'heapUsed', 'heapMax', 'heapCommitted', 'nonHeapUsed', 'usedBytes') }
        @{ why = '控制面自身记账：前后两次读面调用本身就在改变它们（不是世界写入）'; names = @('lastSeq', 'buffered', 'count', 'counts', 'recent', 'recentRuns', 'pending', 'busy', 'currentJobId', 'currentAction', 'probeActive', 'probe') }
        @{ why = '与写入无关的易变读数：网络往返延迟 / 状态效果剩余时长每 tick 自减'; names = @('ping', 'duration') }
    )
    foreach ($g in $groups) {
        if (@($g.names) -contains $Name) { return [string]$g.why }
    }
    return $null
}

function Get-CpChildNames {
    param($Node)
    if ($null -eq $Node) { return @() }
    if ($Node -is [System.Collections.IDictionary]) { return @($Node.Keys | ForEach-Object { [string]$_ }) }
    if ($Node -is [System.Management.Automation.PSCustomObject]) { return @($Node.PSObject.Properties.Name) }
    return @()
}

function Test-CpNodeIsMap {
    param($Node)
    return ($Node -is [System.Collections.IDictionary]) -or ($Node -is [System.Management.Automation.PSCustomObject])
}

function Test-CpNodeIsList {
    param($Node)
    if ($Node -is [string]) { return $false }
    return ($Node -is [System.Array]) -or ($Node -is [System.Collections.IList])
}

# 递归逐路径比对；$Diffs / $Skipped 是调用方给的 ArrayList（原地追加）
function Compare-CpNodeModuloVolatile {
    param($Before, $After, [string]$Path, $Diffs, $Skipped, $Seen)
    $hasB = $null -ne $Before
    $hasA = $null -ne $After
    if (-not $hasB -and -not $hasA) { return }
    if ($hasB -ne $hasA) {
        [void]$Diffs.Add(("$Path = 仅单侧存在（before=$(Format-CpValue $Before) after=$(Format-CpValue $After)）"))
        return
    }
    if ((Test-CpNodeIsMap $Before) -or (Test-CpNodeIsMap $After)) {
        if (-not ((Test-CpNodeIsMap $Before) -and (Test-CpNodeIsMap $After))) {
            [void]$Diffs.Add(("$Path = 类型不同（before=$(Format-CpValue $Before) after=$(Format-CpValue $After)）"))
            return
        }
        $names = New-Object System.Collections.ArrayList
        foreach ($n in (Get-CpChildNames $Before)) { if (-not $names.Contains($n)) { [void]$names.Add($n) } }
        foreach ($n in (Get-CpChildNames $After)) { if (-not $names.Contains($n)) { [void]$names.Add($n) } }
        foreach ($n in $names) {
            $child = if ([string]::IsNullOrEmpty($Path)) { "/$n" } else { "$Path/$n" }
            $why = Get-CpVolatileFieldReason $n
            if ($null -ne $why) {
                if (-not $Seen.Contains($child)) { [void]$Seen.Add($child); [void]$Skipped.Add("$child（$why）") }
                continue
            }
            $cb = Test-CpHasProp $Before $n
            $ca = Test-CpHasProp $After $n
            if ($cb -ne $ca) {
                [void]$Diffs.Add(("$child = 仅单侧存在（before=$(Format-CpValue (Get-CpProp $Before $n)) after=$(Format-CpValue (Get-CpProp $After $n))）"))
                continue
            }
            Compare-CpNodeModuloVolatile (Get-CpProp $Before $n) (Get-CpProp $After $n) $child $Diffs $Skipped $Seen
        }
        return
    }
    if ((Test-CpNodeIsList $Before) -or (Test-CpNodeIsList $After)) {
        if (-not ((Test-CpNodeIsList $Before) -and (Test-CpNodeIsList $After))) {
            [void]$Diffs.Add(("$Path = 类型不同（before=$(Format-CpValue $Before) after=$(Format-CpValue $After)）"))
            return
        }
        $ba = @($Before)
        $aa = @($After)
        if ($ba.Count -ne $aa.Count) {
            [void]$Diffs.Add(("$Path = 数组长度不同（before=$($ba.Count) after=$($aa.Count)）"))
            return
        }
        for ($i = 0; $i -lt $ba.Count; $i++) {
            Compare-CpNodeModuloVolatile $ba[$i] $aa[$i] ("$Path/$i") $Diffs $Skipped $Seen
        }
        return
    }
    if ("$Before" -ne "$After") {
        [void]$Diffs.Add(("$Path = before=$(Format-CpValue $Before) after=$(Format-CpValue $After)"))
    }
}

# 状态比对入口：返回 @{ diffs[]; skipped[] }（diffs 为空 = 排除易变字段后逐路径相同）
function Compare-CpStateModuloVolatile {
    param($Before, $After)
    $diffs = New-Object System.Collections.ArrayList
    $skipped = New-Object System.Collections.ArrayList
    $seen = New-Object System.Collections.ArrayList
    Compare-CpNodeModuloVolatile $Before $After '' $diffs $skipped $seen
    return [pscustomobject]@{ diffs = @($diffs); skipped = @($skipped) }
}

# 比对结果的两行摘要（detail 复用；不参与判红绿）
function Format-CpStateCompare {
    param($Compare, [int]$MaxDiffs = 8, [int]$MaxSkips = 12)
    $dt = if ($Compare.diffs.Count -eq 0) { '差异 0 条' } else { "差异 $($Compare.diffs.Count) 条: " + (($Compare.diffs | Select-Object -First $MaxDiffs) -join ' | ') }
    $st = "排除易变路径 $($Compare.skipped.Count) 条: " + (($Compare.skipped | Select-Object -First $MaxSkips) -join '; ')
    return "$dt；$st"
}

# ---------------------------------------------------------------------------
# E1：组合键（潜行修饰）被世界链按序消费
#
#   正例口径：潜行+前进的**每 tick 水平位移**必须显著低于「只按前进」的对照
#             （潜行/对照 < MaxSneakPerTickRatio，默认 0.6；MC 的潜行输入系数是 0.3，
#              0.6 只用作「显著低于」的判界，不是把 0.3 放宽到 0.6）。
#   负对照：构造数据里潜行无效（两者每 tick 位移相当）⇒ **必须红**（见离线自检）。
#   对照不成立（只按前进也不动）⇒ 红：那说明键没生效，本判据无从比较，
#            绝不许因为「两边都没动」而判绿。
# ---------------------------------------------------------------------------
function Test-InputE1SneakModifier {
    param(
        $PlainPosA, $PlainPosB, [int]$PlainTicks = 0,
        $SneakPosA, $SneakPosB, [int]$SneakTicks = 0,
        [double]$MaxSneakPerTickRatio = 0.6,
        [double]$MinPlainPerTick = 0.02
    )
    $dPlain = Get-CpHorizontalDistance $PlainPosA $PlainPosB
    $dSneak = Get-CpHorizontalDistance $SneakPosA $SneakPosB
    $plainTxt = if ($null -eq $dPlain) { 'N/A' } else { "{0:N3}" -f [double]$dPlain }
    $sneakTxt = if ($null -eq $dSneak) { 'N/A' } else { "{0:N3}" -f [double]$dSneak }
    $common = ("对照（只按 key.forward）: A={0} B={1} 水平位移={2} tick={3}；潜行+前进: A={4} B={5} 水平位移={6} tick={7}" -f `
        (Format-CpValue $PlainPosA), (Format-CpValue $PlainPosB), $plainTxt, $PlainTicks,
        (Format-CpValue $SneakPosA), (Format-CpValue $SneakPosB), $sneakTxt, $SneakTicks)
    if ($null -eq $dPlain -or $null -eq $dSneak) {
        return (New-CpFail 'E1' ("坐标不可解析 ⇒ 无法判定位移（不是「无差别也算过」）；$common"))
    }
    if ($PlainTicks -le 0 -or $SneakTicks -le 0) {
        return (New-CpFail 'E1' ("tick 增量不可用（对照 $PlainTicks / 潜行 $SneakTicks）⇒ 无法折算每 tick 位移；$common"))
    }
    $plainPerTick = [double]$dPlain / [double]$PlainTicks
    $sneakPerTick = [double]$dSneak / [double]$SneakTicks
    $ratio = if ($plainPerTick -gt 0) { $sneakPerTick / $plainPerTick } else { $null }
    $ratioTxt = if ($null -eq $ratio) { '(对照为 0，比值无定义)' } else { "{0:N3}" -f [double]$ratio }
    $d = ("{0}；每 tick 水平位移：对照={1:N4} 潜行={2:N4}；潜行/对照={3}（判界 < {4}）；对照下界要求 >= {5}" -f `
        $common, $plainPerTick, $sneakPerTick, $ratioTxt, $MaxSneakPerTickRatio, $MinPlainPerTick)
    if ($plainPerTick -lt $MinPlainPerTick) {
        return (New-CpFail 'E1' ("对照组每 tick 位移 {0:N4} < {1} ⇒ 对照不成立（只按前进也没动起来，键没生效）⇒ 本判据无从比较，不许判绿；{2}" -f $plainPerTick, $MinPlainPerTick, $d))
    }
    if ($sneakPerTick -ge ($MaxSneakPerTickRatio * $plainPerTick)) {
        return (New-CpFail 'E1' ("潜行**没有**让位移下降（每 tick 位移未低于对照的 $MaxSneakPerTickRatio 倍）：$d"))
    }
    return (New-CpPass 'E1' ("潜行让每 tick 位移下降到对照的 $ratioTxt（判界 < $MaxSneakPerTickRatio）：$d"))
}

# ---------------------------------------------------------------------------
# E1.readback：保持期间的 input.state 必须**如实回读** held[].gameBindingPressed
#   字段名出处：InputStateProviderImpl.java:601（item.addProperty("gameBindingPressed", pressedFor(id, o))）
#              InputRuntimeImpl.java:1160（动作结果面的同名回读）
#   本判据只要求「两个键都在持键表里」且「每个条目都带该字段」——
#   回读值是 true/false/null 都如实进 detail（null = 探针读不到，不判红：
#   那是**如实**，不是缺失；字段整个缺席才是缺失）。
# ---------------------------------------------------------------------------
function Test-InputE1SneakReadback {
    param($HoldTrial, [string[]]$WantIds = @('key.sneak', 'key.forward'))
    if ((Get-CpTrialExit $HoldTrial) -ne 0) {
        return (New-CpFail 'E1.readback' ("保持期间 input.state 未成功（gameBindingPressed 取不到）: " + (Format-CpTrial $HoldTrial)))
    }
    $res = Get-CpTrialResult $HoldTrial
    if ($null -eq $res) { return (New-CpFail 'E1.readback' 'input.state 的 result 字段缺席') }
    $held = Get-CpProp $res 'held'
    $items = Get-CpArray $held 'items'
    $count = Get-CpProp $held 'count'
    $parts = New-Object System.Collections.ArrayList
    $problems = New-Object System.Collections.ArrayList
    foreach ($want in @($WantIds)) {
        $hit = @($items | Where-Object { [string](Get-CpProp $_ 'id') -eq $want })
        if ($hit.Count -eq 0) {
            [void]$parts.Add("$want=(不在持键表里)")
            [void]$problems.Add("held.items 里没有 $want（保持期间程序没有真的按下该键）")
            continue
        }
        $it = $hit[0]
        if (-not (Test-CpHasProp $it 'gameBindingPressed')) {
            [void]$parts.Add("$want=(无 gameBindingPressed 字段)")
            [void]$problems.Add("$want 的 held 条目没有 gameBindingPressed 字段（§3.6 第 4 条要求回读，不许省略）")
            continue
        }
        $note = [string](Get-CpProp $it 'gameBindingPressedNote')
        [void]$parts.Add(("$want.gameBindingPressed={0}{1}" -f (Format-CpValue (Get-CpProp $it 'gameBindingPressed')), $(if ([string]::IsNullOrWhiteSpace($note)) { '' } else { "（$note）" })))
    }
    $d = ("held.count={0}（要求 >= {1}）；回读: {2}" -f (Format-CpValue $count), @($WantIds).Count, ($parts -join '; '))
    $countNum = if ($null -eq $count) { -1 } else { [int]$count }
    if ($countNum -lt @($WantIds).Count) { [void]$problems.Add("held.count=$countNum < $(@($WantIds).Count)（保持期间两个键都该在持键表里）") }
    if ($problems.Count -gt 0) { return (New-CpFail 'E1.readback' (($problems -join '；') + "；$d")) }
    return (New-CpPass 'E1.readback' $d)
}

# ---------------------------------------------------------------------------
# E2：单作业内压入远超容量的键事件 ⇒ 队列满 ⇒ CP-STATE-001 且零写入
#
#   ⚠ 本判据的**触发条件**在公开动作面上是否可达，本身就是结论的一部分（见 README §15.8）。
#   三条分支：
#     ① 用例构造被校验器拒 ⇒ blocked（构造层拒绝，不是「队列满」的实测结论）
#     ② 错误码命中 CP-STATE-001 ⇒ 判据成立：再用「排除易变字段后的逐路径比对」验零写入
#     ③ 未被拒 ⇒ 只有当「实测深度已达容量却仍投递成功」才是 fail（实现缺陷）；
#        否则 blocked-with-reason（触发条件不可达），**绝不改判成 pass**，
#        也**绝不**降级成别的更容易绿的断言。
# ---------------------------------------------------------------------------
function Get-CpQueueFillStats {
    param($StepArtifacts)
    $depths = New-Object System.Collections.ArrayList
    $ticks = New-Object System.Collections.ArrayList
    $steps = 0
    foreach ($a in @($StepArtifacts)) {
        $steps++
        $d = Get-CpProp $a 'queueDepthAfter'
        if ($null -ne $d) { [void]$depths.Add([int]$d) }
        $t = Get-CpProp $a 'deliveredAtTick'
        if ($null -ne $t) { [void]$ticks.Add([long]$t) }
    }
    $maxDepth = $null
    if ($depths.Count -gt 0) { $maxDepth = [int](($depths | Measure-Object -Maximum).Maximum) }
    $distinct = @($ticks | Sort-Object -Unique)
    $maxPerTick = 0
    if ($ticks.Count -gt 0) {
        $g = $ticks | Group-Object
        $maxPerTick = [int](($g | Measure-Object -Property Count -Maximum).Maximum)
    }
    return [pscustomobject]@{
        steps                 = $steps
        depthSamples          = $depths.Count
        maxDepth              = $maxDepth
        tickSamples           = $ticks.Count
        distinctTicks         = $distinct.Count
        maxDeliveriesPerTick  = $maxPerTick
        firstTick             = $(if ($distinct.Count -gt 0) { $distinct[0] } else { $null })
        lastTick              = $(if ($distinct.Count -gt 0) { $distinct[-1] } else { $null })
    }
}

function Test-InputE2QueueFullSingleJob {
    param(
        $ValidateTrial, $RunTrial, $BeforeState, $AfterState, $StepArtifacts,
        [int]$PlannedSteps = 300,
        [int]$KeyCapacity = 256,
        # 填充键位门（可选）：驱动选用的未绑定键码 + 它的依据（input.state.keyCatalog 实读）
        $FillerTrial = $null, $FillerCatalog = $null, [int]$FillerCode = -1
    )
    $stats = Get-CpQueueFillStats $StepArtifacts
    $cmp = Compare-CpStateModuloVolatile $BeforeState $AfterState
    $cmpTxt = Format-CpStateCompare $cmp
    $statesUsable = ($null -ne $BeforeState) -and ($null -ne $AfterState) `
        -and ($null -ne (Get-CpProp $BeforeState 'player')) -and ($null -ne (Get-CpProp $AfterState 'player')) `
        -and ($null -ne (Get-CpProp $BeforeState 'status')) -and ($null -ne (Get-CpProp $AfterState 'status'))
    $statTxt = ("填充步 {0}（计划 {1}，容量 {2}）；step 产物 {3} 份；queueDepthAfter 实测最大值={4}（样本 {5}）；deliveredAtTick 去重={6}、单 tick 最多投递 {7} 次" -f `
        $stats.steps, $PlannedSteps, $KeyCapacity, $stats.steps, (Format-CpValue $stats.maxDepth), $stats.depthSamples, $stats.distinctTicks, $stats.maxDeliveriesPerTick)
    $watchTxt = "投递前后状态比对（read.player + core.status）：$cmpTxt"
    if (-not $statesUsable) { $watchTxt = "投递前后状态比对：**观测面不完整**（read.player/core.status 有一侧读不到）⇒ 零写入无从验证；$cmpTxt" }

    # ⓪ 填充键位门：填充键必须是**未绑定**键码。否则「已入队事件即使被消费也不产生世界写入」
    #    这一前提不可辩护 —— 而不做这个辩护就等于用会动玩家的键去撞队列，判据本身失去意义。
    if ($null -ne $FillerTrial) {
        $fillerWhy = $null
        if ((Get-CpTrialExit $FillerTrial) -ne 0) {
            $fillerWhy = "取键位目录的 input.state 未成功: " + (Format-CpTrial $FillerTrial)
        } else {
            $boundCount = 0
            $occupied = $false
            if ($null -ne $FillerCatalog) {
                foreach ($p in @($FillerCatalog.PSObject.Properties)) {
                    $boundCount++
                    if ([int]$p.Value -eq $FillerCode) { $occupied = $true }
                }
            }
            if ($boundCount -eq 0) {
                $fillerWhy = 'input.state.keyCatalog 为空（运行期键位注册表读不到）⇒ 无法判定某键码是否未绑定'
            } elseif ($FillerCode -lt 1 -or $FillerCode -gt 254) {
                $fillerWhy = "0..254 里找不到未被 keyCatalog 占用的键码（目录 $boundCount 项，候选=$FillerCode）"
            } elseif ($occupied) {
                return (New-CpFail 'E2' ("驱动选用的填充键码 $FillerCode 已被运行期 KeyBinding 占用（keyCatalog $boundCount 项里命中）⇒ 填充事件可能产生世界交互，前提不成立（编排缺陷）：$statTxt"))
            } elseif ($boundCount -gt 0) {
                $statTxt = ("填充键码 {0}（未绑定：不在 keyCatalog 的 {1} 个取值里）；" -f $FillerCode, $boundCount) + $statTxt
            }
        }
        if ($null -ne $fillerWhy) {
            return (New-CpBlocked 'E2' ("blocked：填充键位不可用 ⇒ 无法构造功能惰性的填充事件（「已入队事件即使被消费也不产生世界写入」这一前提不可辩护，本判据不做）：$fillerWhy；$statTxt"))
        }
    }

    if ((Get-CpTrialExit $ValidateTrial) -ne 0) {
        # 【首轮实机教训】只打 shape/state/code 不够定位：首轮就是这样把「用例缺 world/criteria/evidence」
        # 这条真正的原因丢在了 caller 日志里，摘要只显示一个 CP-VALID-002。这里把校验器的
        # **消息 + 逐字段上下文**一并带进 detail，让构造失败自证。
        $verr = Get-CpTrialError $ValidateTrial
        $vmsg = Format-CpValue (Get-CpProp $verr 'message')
        $vctx = Get-CpProp $verr 'context'
        $vfields = ''
        if ($null -ne $vctx) {
            $farr = Get-CpProp $vctx 'fields'
            if ($null -ne $farr) { $vfields = "；校验器逐字段: " + (Format-CpValue $farr) }
        }
        return (New-CpBlocked 'E2' ("blocked：E2 的填充用例未被校验器接受 ⇒ 探针构造失败（这是构造层结论，不是「队列满」的实测结论，既不算 pass 也不算实现缺陷）: " + (Format-CpTrial $ValidateTrial) + "；校验器消息: $vmsg$vfields；$statTxt"))
    }
    $runCode = Get-CpTrialErrorCode $RunTrial

    # ② 判据成立路径
    if ("$runCode" -eq 'CP-STATE-001') {
        if (-not $statesUsable) {
            return (New-CpFail 'E2' ("拒绝码命中 CP-STATE-001，但投递前后的观测面不完整 ⇒ 「零写入」无法验证（不许当成功）：$watchTxt；$statTxt"))
        }
        if ($cmp.diffs.Count -gt 0) {
            return (New-CpFail 'E2' ("拒绝码命中 CP-STATE-001，但投递前后状态**不是**零写入 ⇒ 队列满路径有副作用：$watchTxt；$statTxt"))
        }
        return (New-CpPass 'E2' ("CP-STATE-001（队列满拒绝）且投递前后零写入（$cmpTxt）；$statTxt"))
    }

    # ③ 未被拒
    if ($null -ne $stats.maxDepth -and [int]$stats.maxDepth -ge $KeyCapacity) {
        return (New-CpFail 'E2' ("实测键盘队列深度已达容量 $KeyCapacity 却仍投递成功（未被 CP-STATE-001 拒绝，违反契约 §4.4 第 3 条的容量预检）：$statTxt"))
    }
    if ((Get-CpTrialExit $RunTrial) -ne 0) {
        return (New-CpFail 'E2' ("填充用例失败且错误码 '$runCode' 不是 CP-STATE-001 ⇒ 无法归因到队列满: " + (Format-CpTrial $RunTrial) + "；$statTxt"))
    }
    $why = @(
        "① 计划 $PlannedSteps 条 ≫ 容量 $KeyCapacity"
        "② queueDepthAfter 实测最大值=$(Format-CpValue $stats.maxDepth)（远低于容量）⇒ 设施容量预检的判据 depthBefore + 本请求条数 > capacity 从未成立"
        "③ 单 tick 最多投递 $($stats.maxDeliveriesPerTick) 条、deliveredAtTick 去重 $($stats.distinctTicks) 个 ⇒ 投递速率被「编排段里每个输入步至少占一个 tick」限住（CaseRunAction.java:1190-1191），而 MC 每 tick 排空键盘队列（lwjgl3ify Keyboard.next()）"
        "④ 公开动作面上唯一的批量入口 input.text 在投递**之前**就被能力门以 CP-STATE-001（路由未就绪）拦下（InputTextAction.java:75/121）⇒ 那条 CP-STATE-001 不是「队列满」"
    )
    return (New-CpBlocked 'E2' ("blocked：单作业内**无法构造**触发条件（CP-STATE-001「队列满」路径未被覆盖，这不是 pass）。判定依据：" + ($why -join '；') + "。$statTxt；$watchTxt"))
}

# ---------------------------------------------------------------------------
# E3：产物可从既有清单发现并复核哈希
#   判据：GET /cp/v1/artifacts/{runId} 的清单里能发现 shots/<name>.png 与
#         shots/<name>.meta.json；**逐份**下载字节、复算 sha256，与清单声明的 sha256/bytes 比对，
#         全部一致才算 pass（至少要有一条 PNG 与一条 meta —— 由下载覆盖数保证）。
#   清单不含 sha256 字段 ⇒ 如实记「未覆盖」并**红**（不许含糊成 pass）。
#   字段出处：CoreEndpoints.java:304-323（清单 {runId,caseId,jobSeq,createdAt,artifacts[],count}）
#             ArtifactStore.java:74-79（条目 {path,bytes,sha256,role}）
# ---------------------------------------------------------------------------
function Test-InputE3ArtifactHashes {
    param($Manifest, $Downloads, [string]$RunId = '', $ShotTrial = $null)
    $shotTxt = if ($null -eq $ShotTrial) { '' } else { ("shot.multi: " + (Format-CpTrial $ShotTrial) + "；") }
    if ($null -eq $Manifest) {
        return (New-CpFail 'E3' ("GET /cp/v1/artifacts/{runId} 的清单读不到（产物发现面不可用）；${shotTxt}runId='" + $RunId + "'"))
    }
    $arts = Get-CpArray $Manifest 'artifacts'
    $rid = if ([string]::IsNullOrWhiteSpace($RunId)) { [string](Get-CpProp $Manifest 'runId') } else { $RunId }
    $png = @($arts | Where-Object { [string](Get-CpProp $_ 'path') -match '^shots/[^/]+\.png$' })
    $meta = @($arts | Where-Object { [string](Get-CpProp $_ 'path') -match '^shots/[^/]+\.meta\.json$' })
    $listed = ("清单 runId={0} count={1}；可发现 shots/*.png={2} 份、shots/*.meta.json={3} 份" -f `
        $rid, (Format-CpValue (Get-CpProp $Manifest 'count')), $png.Count, $meta.Count)
    if ($png.Count -lt 1) { return (New-CpFail 'E3' ("清单里发现不到 shots/*.png ⇒ 产物发现面不成立；$listed")) }
    if ($meta.Count -lt 1) { return (New-CpFail 'E3' ("清单里发现不到 shots/*.meta.json ⇒ 产物发现面不成立；$listed")) }

    $declaredPng = @($png | Where-Object { -not [string]::IsNullOrWhiteSpace([string](Get-CpProp $_ 'sha256')) })
    $declaredMeta = @($meta | Where-Object { -not [string]::IsNullOrWhiteSpace([string](Get-CpProp $_ 'sha256')) })
    if ($declaredPng.Count -eq 0 -or $declaredMeta.Count -eq 0) {
        return (New-CpFail 'E3' ("清单**未声明** sha256（未覆盖哈希字段）⇒ 本判据不可判，如实记为「未覆盖」：png 声明 {0}/{1}、meta 声明 {2}/{3}；$listed" -f `
                $declaredPng.Count, $png.Count, $declaredMeta.Count, $meta.Count))
    }

    $rows = New-Object System.Collections.ArrayList
    $bad = New-Object System.Collections.ArrayList
    $okPng = 0
    $okMeta = 0
    foreach ($dl in @($Downloads)) {
        $p = [string](Get-CpProp $dl 'path')
        $isPng = $p -match '^shots/[^/]+\.png$'
        $isMeta = $p -match '^shots/[^/]+\.meta\.json$'
        if (-not ($isPng -or $isMeta)) { continue }
        $dec = [string](Get-CpProp $dl 'declaredSha256')
        $act = [string](Get-CpProp $dl 'actualSha256')
        $dlOk = ((Get-CpProp $dl 'downloadOk') -eq $true)
        $decBytes = Get-CpProp $dl 'declaredBytes'
        $actBytes = Get-CpProp $dl 'actualBytes'
        $hashOk = $dlOk -and (-not [string]::IsNullOrWhiteSpace($act)) -and ($act.ToLowerInvariant() -eq $dec.ToLowerInvariant())
        $bytesOk = ($null -ne $decBytes) -and ($null -ne $actBytes) -and ([long]$decBytes -eq [long]$actBytes)
        $actShort = if ([string]::IsNullOrWhiteSpace($act)) { '(无)' } else { $act.Substring(0, [math]::Min(12, $act.Length)) + '…' }
        $decShort = if ([string]::IsNullOrWhiteSpace($dec)) { '(无)' } else { $dec.Substring(0, [math]::Min(12, $dec.Length)) + '…' }
        [void]$rows.Add(("{0}: 下载={1} 复算={2} 清单={3} 哈希一致={4} 字节 {5}/{6}" -f `
                $p, $dlOk, $actShort, $decShort, $hashOk, (Format-CpValue $actBytes), (Format-CpValue $decBytes)))
        if ($hashOk -and $bytesOk) {
            if ($isPng) { $okPng++ } else { $okMeta++ }
        } else {
            [void]$bad.Add("$p（下载=$dlOk 哈希一致=$hashOk 字节一致=$bytesOk 复算=$(Format-CpValue $act) 清单=$(Format-CpValue $dec)）")
        }
    }
    $missing = ($png.Count + $meta.Count) - $rows.Count
    if ($missing -gt 0) { [void]$bad.Add("有 $missing 份 shots/*.png|*.meta.json 没有被下载复核（逐份比对不完整）") }
    $table = ($rows | Select-Object -First 6) -join ' | '
    $d = ("$listed；逐份比对 $($rows.Count) 份（PNG 一致 $okPng、meta 一致 $okMeta）：$table")
    if ($bad.Count -gt 0) {
        return (New-CpFail 'E3' (($bad -join '；') + "；$d"))
    }
    if ($okPng -lt 1 -or $okMeta -lt 1) {
        return (New-CpFail 'E3' ("至少各需一条 PNG 与一条 meta 比对成功（实测 PNG $okPng / meta $okMeta）；$d"))
    }
    return (New-CpPass 'E3' ("清单可发现且逐份哈希复算全部一致（PNG $okPng 份、meta $okMeta 份）：$d"))
}

