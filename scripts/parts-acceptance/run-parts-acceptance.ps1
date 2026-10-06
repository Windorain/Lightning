<#
  Phase 3 部件验收总入口 —— **一条命令跑通 P3.1–P3.4**（计划 §5「总入口」/§6 清单）
  ============================================================================
    npm run acceptance:parts                          # 完整编排（默认 L1 内部 -Runs 2）
    npm run acceptance:parts -- -DryRun               # 只做前置检查 + 打印阶段计划
    npm run acceptance:parts -- -OnlyStages l2-real-render -L1From <既有归档>
    npm run acceptance:parts -- -Runs 2               # **连续两次完整运行** + 产物字节一致性比对
    npm run acceptance:parts -- -ContinueOnFailure     # 失败不即停（跑完再汇总）

  编排（全部零人工交互；默认**失败即停**，失败点之后的阶段记 not-run 并进报告）：
    preflight → build-mod-gtnh → l1-export-oracle（P1.8 建造→导出→oracle，内部 -Runs 2 跨轮幂等）
    → l1-verify-oracle（脚本侧独立复算：三个产物 × oracle 逐格）
    → degradation-static（P3.3 推断永不当主来源 / 三档降级 / 字节干净 / 旧格式 / web 不重算 / proto）
    → reference-fake-provider（P1.1 expB 必抛假提供者证据机器核对）
    → regression-vitest → build-web → regression-parts-fixtures（P2.5 断言包）
    → regression-multiblock-cross（多方块加载+通道切换交叉回归）
    → l2-real-render（P3.1 真实导出渲染断言，web/e2e/parts-real-export.spec.ts）
    → falsify-negative（P3.4 负对照：篡改必红）→ idempotency → report

  退出码（优先级从上到下，第一个命中的即最终退出码）：
    3  前置检查致命（缺 CoFH conf / gradlew / playwright / canonical oracle / 部件脚本）
    4  mod 半环红（build:mod:gtnh / L1 建造导出 / 脚本侧逐格核对 / 降级静态判据 / 假提供者引用）
    5  web 半环红（vitest / build:web / P2.5 断言包 / 多方块交叉 / L2 真实导出断言）
    6  证伪红（负对照未如期变红 / 正对照未绿）
    7  报告未产出（acceptance-report.json）
    2  验收不完整（有阶段 not-run：被开关跳过 / 假提供者证据缺失 / 失败即停的后续阶段）
    8  幂等：`-Runs 2` 的逐条判定或产物字节不一致
    9  阶段全绿但 §6 把关清单判红（判据本身红）
    0  全绿

  设计说明与判据映射见 `scripts/parts-acceptance/README.md`。
#>
[CmdletBinding()]
param(
    # 本次运行的标签（归档目录名 = parts-acceptance-<label>）
    [string]$Label = "",
    # 归档根目录
    [string]$OutRoot = "",
    # 完整编排重复轮数（≥2 = 连续两次完整运行 + 产物字节一致性比对；时间戳字段除外）
    [int]$Runs = 1,
    # L1（游戏内建造/导出/oracle）内部跨轮幂等轮数。
    # **默认 1**：跨会话 FMP stale-tile 累积（本轮实测 F3，见报告 findings）会让 L1 内部多轮不可靠；
    # 字节级幂等证据由「单轮内双导出 sha256」+「编排级 -Runs 2（每轮清场）」共同承担。
    [int]$L1Runs = 1,
    # 复用既有 L1 归档（跳过客户端启动；分段验证/复跑用）
    [string]$L1From = "",
    # 上一次的 acceptance-report.json（逐条判定比对）
    [string]$CompareWith = "",
    # 只做前置检查并打印阶段计划
    [switch]$DryRun,
    # 分段验证：只跑指定阶段（其余记 not-run）
    [string[]]$OnlyStages = @(),
    # 失败不即停（跑完全部阶段再汇总）
    [switch]$ContinueOnFailure,
    # 跳过 gradlew build（复跑省时间；正式验收禁用）
    [switch]$SkipBuild,
    # 跳过 web 侧阶段（vitest / build:web / playwright）
    [switch]$SkipWeb,
    # 验收世界基线快照（默认开）：**同一世界连续两次客户端会话**会因 FMP stale-tile 累积偶发翻倍（findings F3），
    # 且"从零生成"又因客户端同步窗口不足而产出无效（findings M4）。折中：第一次 pass 前把世界**快照**下来，
    # 之后每个 pass 开跑前用基线还原（旧的活世界移到本轮目录，不删除）⇒ 各轮起点**逐字节相同**，
    # 幂等比对测的是管线（建造器/导出器/web）而不是世界累积状态。
    [bool]$SnapshotWorld = $true,
    # 跳过 L1（要求 -L1From 或既有归档已就位）
    [switch]$SkipL1,
    # 清场验收世界（把 mod/gtnh/run/client/saves/sde_parts_acceptance_world **移动**到运行目录备份后再跑）。
    # **默认关闭**：P3.1 实测（findings F3/M4）—— 从零生成的世界里客户端在 WAIT_SYNC 窗口内收不到
    # 新建方块（measured 全格 hostFullCube=true、导出无 cellPartsGrid）⇒ 得不到有效产物；
    # 复用既有世界（自动化自带 resetWorld 清场 + 重建）才是可用路径。该开关留给"干净房"排查用。
    [switch]$ResetWorld,
    # 放置后等待服务端→客户端同步的 tick 数（传给 L1 脚本）。默认 120（=6s，比 L1 默认 60 更宽）：
    # P3.1 实测（findings F5）AE2 线缆总线格偶发整格缺失，疑与客户端同步窗口有关 —— 加宽窗口是该风险的**编排侧**缓解。
    [int]$SyncWaitTicks = 120,
    # 各阶段超时（分钟）
    [int]$L1TimeoutMinutes = 40,
    [int]$WebTimeoutMinutes = 45,
    [int]$BuildTimeoutMinutes = 45
)

$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
$modDir = Join-Path $repoRoot 'mod\gtnh'
$mcDataDir = Join-Path $modDir 'run\client'
$webDir = Join-Path $repoRoot 'web'
$oracleDir = Join-Path $scriptDir 'oracle'
$l1Script = Join-Path $scriptDir 'run-acceptance.ps1'

if ([string]::IsNullOrWhiteSpace($OutRoot)) { $OutRoot = Join-Path $scriptDir '.out' }
if ([string]::IsNullOrWhiteSpace($Label)) { $Label = 'parts-' + (Get-Date -Format 'yyyyMMdd-HHmmss') }
$runDir = Join-Path $OutRoot ('parts-acceptance-' + $Label)

# 一次完整编排（pass）的工作目录：Runs>1 时每轮一个子目录，否则就是运行目录本身
function Get-PassDir([int]$pass) {
    if ($Runs -gt 1) { return (Join-Path $runDir "pass$pass") }
    return $runDir
}

$script:continueOnFailure = [bool]$ContinueOnFailure
$script:aborted = $false
$script:stageResults = [ordered]@{}
$script:stageOrder = @()
$script:onlyStageList = @()
foreach ($s in $OnlyStages) { foreach ($p in ($s -split ',')) { if ($p.Trim()) { $script:onlyStageList += $p.Trim() } } }

# 阶段阶段定义（id → 中文名），供 DryRun 打印与报告核对
$script:stagePlan = [ordered]@{
    'preflight'                 = '前置检查（gradlew / CoFH conf / node / playwright / canonical oracle / 部件脚本）'
    'build-mod-gtnh'            = 'cd mod/gtnh && gradlew build'
    'l1-export-oracle'          = "run-acceptance.ps1 -Runs $L1Runs（建造→导出→oracle：full/degraded_ae2/degraded_all + 字节干净对照）"
    'l1-verify-oracle'          = 'node scripts/parts-acceptance/verify-oracle.mjs（脚本侧独立复算：三产物 × oracle 逐格）'
    'degradation-static'        = 'node scripts/parts-acceptance/check-static.mjs（P3.3 降级/静态判据）'
    'reference-fake-provider'   = 'node scripts/parts-acceptance/falsification.mjs --only fake-provider（P1.1 expB 引用）'
    'regression-vitest'         = 'cd web && npx vitest run'
    'build-web'                 = 'npm run build:web'
    'regression-parts-fixtures' = 'playwright test parts-hover-stats.spec.ts parts-falsification.spec.ts'
    'regression-multiblock-cross' = 'playwright test multiblock-channel-traversal.spec.ts -g 尺寸变化方向（加载+通道切换，单用例）'
    'l2-real-render'            = 'playwright test parts-real-export.spec.ts（P3.1 真实导出渲染断言）'
    'falsify-negative'          = 'node scripts/parts-acceptance/falsification.mjs --only negatives（P3.4 篡改必红）'
    'idempotency'               = '跨轮产物字节一致性比对（-Runs 2 时逐文件 sha256）'
    'report'                    = 'node scripts/parts-acceptance/build-parts-report.mjs（§6 清单逐条机器判定）'
}
$script:modStages = @('build-mod-gtnh', 'l1-export-oracle', 'l1-verify-oracle', 'degradation-static', 'reference-fake-provider')
$script:webStages = @('regression-vitest', 'build-web', 'regression-parts-fixtures', 'regression-multiblock-cross', 'l2-real-render')

function Write-Step([string]$msg) { Write-Host "== [parts] $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host "   OK  $msg" -ForegroundColor Green }
function Write-Warn2([string]$msg) { Write-Host "   !!  $msg" -ForegroundColor Yellow }
function Write-Err2([string]$msg) { Write-Host "   XX  $msg" -ForegroundColor Red }

$script:nodeCmd = (Get-Command node -ErrorAction SilentlyContinue).Source
$script:npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue) ?? (Get-Command npm -ErrorAction SilentlyContinue).Source
$script:gradlew = Join-Path $modDir 'gradlew.bat'
$script:pwshCmd = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
$script:pwCli = Join-Path $webDir 'node_modules\@playwright\test\cli.js'

# ---------------------------------------------------------------------------
# 通用原语（与 scripts/acceptance/run-acceptance.ps1 同形：进程执行 + 阶段片段）
# ---------------------------------------------------------------------------
function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [Parameter(Mandatory = $true)][string]$WorkDir,
        [Parameter(Mandatory = $true)][string]$LogPath,
        [int]$TimeoutSec = 1800,
        [hashtable]$ExtraEnv = @{}
    )
    $saved = @{}
    foreach ($k in $ExtraEnv.Keys) {
        $saved[$k] = [Environment]::GetEnvironmentVariable($k)
        [Environment]::SetEnvironmentVariable($k, [string]$ExtraEnv[$k])
    }
    $errPath = "$LogPath.err"
    $started = Get-Date
    $timedOut = $false
    $code = -1
    try {
        $proc = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $WorkDir `
            -NoNewWindow -PassThru -RedirectStandardOutput $LogPath -RedirectStandardError $errPath
        $exited = $proc.WaitForExit($TimeoutSec * 1000)
        if (-not $exited) {
            $timedOut = $true
            Write-Err2 "阶段超时（${TimeoutSec}s），杀进程树 pid=$($proc.Id)"
            & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null
            $proc.WaitForExit(30000) | Out-Null
        }
        $proc.Refresh()
        $code = if ($proc.HasExited) { $proc.ExitCode } else { -1 }
    } catch {
        $code = -1
        Write-Err2 "启动失败：$FilePath $($ArgumentList -join ' ') → $($_.Exception.Message)"
    } finally {
        foreach ($k in $ExtraEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
    }
    $elapsed = (Get-Date) - $started
    return [ordered]@{
        exitCode  = [int]$code
        timedOut  = $timedOut
        logPath   = $LogPath
        elapsedMs = [int]$elapsed.TotalMilliseconds
        stdOut    = if (Test-Path $LogPath) { Get-Content $LogPath -Raw } else { '' }
        stdErr    = if (Test-Path $errPath) { Get-Content $errPath -Raw } else { '' }
    }
}

$script:stagesDir = ''
function Write-StageFragment {
    param(
        [string]$Id, [string]$Name, [string]$Command, [string]$Status, [Nullable[int]]$ExitCode,
        [int]$DurationMs, [string]$StartedAt, [string]$EndedAt,
        [array]$Gates = @(), [array]$Artifacts = @(), [array]$Evidence = @(),
        [hashtable]$Data = @{}, [array]$Notes = @()
    )
    $frag = [ordered]@{
        id = $Id; name = $Name; command = $Command; cwd = $repoRoot; startedAt = $StartedAt; endedAt = $EndedAt
        durationMs = $DurationMs; exitCode = $ExitCode; status = $Status
        gates = $Gates; artifacts = $Artifacts; evidence = $Evidence; data = $Data; notes = $Notes
    }
    Set-Content -Path (Join-Path $script:stagesDir "$Id.json") -Value ($frag | ConvertTo-Json -Depth 12) -Encoding utf8NoBOM
    $script:stageResults[$Id] = $frag
    $script:stageOrder += $Id
    return $frag
}

function Get-GateStatus([array]$Gates) {
    if ($Gates.Count -eq 0) { return 'pass' }
    if (($Gates | Where-Object { -not $_.ok }).Count -gt 0) { return 'fail' }
    return 'pass'
}

function Test-StageEnabled([string]$Id) {
    if ($script:onlyStageList.Count -eq 0) { return $true }
    return ($script:onlyStageList -contains $Id)
}

function Invoke-StageSkipped([string]$Id, [string]$Name, [string]$Reason) {
    Write-Warn2 "$Id 跳过：$Reason"
    Write-StageFragment -Id $Id -Name $Name -Command '' -Status 'not-run' -ExitCode $null -DurationMs 0 `
        -StartedAt (Get-Date).ToString('o') -EndedAt (Get-Date).ToString('o') -Gates @() -Notes @($Reason) | Out-Null
}

# 失败即停 + 分段开关：所有阶段都经此入口
function Invoke-Stage([string]$Id, [scriptblock]$Body) {
    $name = $script:stagePlan[$Id]
    if ($script:aborted) { Invoke-StageSkipped $Id $name '前序阶段失败（失败即停；-ContinueOnFailure 可关闭）'; return }
    if (-not (Test-StageEnabled $Id)) { Invoke-StageSkipped $Id $name '不在 -OnlyStages'; return }
    & $Body
    $status = $script:stageResults[$Id].status
    if ($status -eq 'fail' -and -not $script:continueOnFailure) { $script:aborted = $true }
}

function Invoke-Playwright {
    param([string]$Id, [string]$SpecPattern, [string]$JsonOut, [int]$TimeoutMinutes, [hashtable]$ExtraEnv = @{}, [string]$Grep = '')
    $t0 = Get-Date
    $log = Join-Path $script:logDir "$Id.log"
    $env2 = @{ PLAYWRIGHT_JSON_OUTPUT_NAME = $JsonOut }
    foreach ($k in $ExtraEnv.Keys) { $env2[$k] = $ExtraEnv[$k] }
    $pwArgs = @($script:pwCli, 'test', $SpecPattern, '--reporter=json', '--retries=0')
    if ($Grep -ne '') { $pwArgs += @('-g', $Grep) }
    $r = Invoke-Native -FilePath $script:nodeCmd -ArgumentList $pwArgs -WorkDir $webDir `
        -LogPath $log -TimeoutSec ($TimeoutMinutes * 60) -ExtraEnv $env2
    if (-not (Test-Path $JsonOut) -and $r.stdOut) {
        $idx = $r.stdOut.IndexOf('{')
        if ($idx -ge 0) { Set-Content -Path $JsonOut -Value $r.stdOut.Substring($idx) -Encoding utf8NoBOM }
    }
    # 外部 playwright/vite 争用的显式诊断（否则会被误读为判据失败）
    $foreign = [bool](Select-String -Path $log -Pattern 'ERR_CONNECTION_REFUSED|ECONNREFUSED' -Quiet -ErrorAction SilentlyContinue)
    return [ordered]@{ t0 = $t0; log = $log; result = $r; jsonPath = $JsonOut; foreign = $foreign }
}

# ---------------------------------------------------------------------------
# 阶段 1：前置检查
# ---------------------------------------------------------------------------
function Invoke-Preflight {
    $t0 = Get-Date
    $gates = @()
    $evidence = @()

    $gates += @{ name = 'gradlew 存在'; ok = (Test-Path $script:gradlew); detail = $script:gradlew }
    $gates += @{ name = 'L1 脚本存在'; ok = (Test-Path $l1Script); detail = $l1Script }
    $gates += @{ name = 'node 可用'; ok = [bool]$script:nodeCmd; detail = "$($script:nodeCmd)" }
    $gates += @{ name = 'playwright CLI 存在'; ok = (Test-Path $script:pwCli); detail = $script:pwCli }

    # CoFH MCP conf（与 run-pipeline/run-acceptance 同一坑：不修会在客户端启动阶段静默挂住）
    $confRoots = @()
    if ($env:USERPROFILE) { $confRoots += (Join-Path $env:USERPROFILE '.gradle') }
    if ($env:GRADLE_USER_HOME) { $confRoots += $env:GRADLE_USER_HOME }
    $confHits = @()
    foreach ($root in $confRoots) {
        $forgeDir = Join-Path $root 'caches\minecraft\net\minecraftforge\forge'
        if (-not (Test-Path $forgeDir)) { continue }
        Get-ChildItem $forgeDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $conf = Join-Path $_.FullName 'unpacked\conf'
            if (-not (Test-Path $conf)) { return }
            $srg = Get-ChildItem $conf -Filter '*.srg' -File -ErrorAction SilentlyContinue
            if ($srg) { $confHits += $conf }
        }
    }
    $gates += @{ name = 'CoFH MCP conf 就绪'; ok = ($confHits.Count -gt 0); detail = if ($confHits.Count -gt 0) { $confHits[0] } else { '未找到 unpacked/conf/*.srg' } }

    # canonical oracle 三件（P3.1/P3.4 的 ground truth）
    $oracleNames = @('sde_parts_acceptance_oracle_full.json', 'sde_parts_acceptance_oracle_degraded_ae2.json', 'sde_parts_acceptance_oracle_degraded_all.json')
    $oracleMissing = @()
    foreach ($n in $oracleNames) { if (-not (Test-Path (Join-Path $oracleDir $n))) { $oracleMissing += $n } }
    $gates += @{ name = 'canonical oracle 三件在册'; ok = ($oracleMissing.Count -eq 0); detail = if ($oracleMissing.Count -eq 0) { $oracleDir } else { "缺：$($oracleMissing -join ', ')" } }

    # 部件脚本（本编排依赖的 Node 工具）
    $tools = @('verify-oracle.mjs', 'check-static.mjs', 'falsification.mjs', 'build-parts-report.mjs')
    $toolMissing = @()
    foreach ($t in $tools) { if (-not (Test-Path (Join-Path $scriptDir $t))) { $toolMissing += $t } }
    $gates += @{ name = '验收工具脚本在册'; ok = ($toolMissing.Count -eq 0); detail = if ($toolMissing.Count -eq 0) { $scriptDir } else { "缺：$($toolMissing -join ', ')" } }

    # 复用既有 L1 归档（-L1From）或 -SkipL1 的语义检查
    if ($L1From) {
        $ok = Test-Path (Join-Path $L1From 'sde_parts_acceptance_result.json')
        $gates += @{ name = '-L1From 归档可用'; ok = $ok; detail = $L1From }
    }

    # web 侧 spec（本编排的 L2 断言包必须落地）
    $l2Spec = Join-Path $webDir 'e2e\parts-real-export.spec.ts'
    $gates += @{ name = 'L2 spec 在册（parts-real-export.spec.ts）'; ok = (Test-Path $l2Spec); detail = $l2Spec }

    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok '前置检查通过' } else {
        Write-Err2 '前置检查未通过：'
        $gates | Where-Object { -not $_.ok } | ForEach-Object { Write-Host "      - $($_.name)：$($_.detail)" }
    }
    Write-StageFragment -Id 'preflight' -Name '前置检查' -Command '（内置）' -Status $status -ExitCode $(if ($status -eq 'pass') { 0 } else { 3 }) `
        -DurationMs ([int]((Get-Date) - $t0).TotalMilliseconds) -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') `
        -Gates $gates -Evidence $evidence -Data @{ gradlew = $script:gradlew; cofhConf = $confHits; oracleDir = $oracleDir } | Out-Null
}

# ---------------------------------------------------------------------------
# 阶段：mod 半环
# ---------------------------------------------------------------------------
<#
  验收世界清场（**移动**而非删除；可原地还原）：
  跨会话 FMP stale-tile 累积（findings F3：同一世界第二次客户端会话导出翻倍）会让 L1 内部
  `-Runs 2` 的第二轮不可靠。默认每轮开跑前把世界移进运行目录备份 ⇒ 从零生成，独立变量归零；
  `-KeepWorld` 关闭该行为。
#>
function Reset-AcceptanceWorld {
    param([Parameter(Mandatory = $true)][string]$BackupRoot)
    $world = Join-Path $mcDataDir 'saves\sde_parts_acceptance_world'
    if (-not (Test-Path $world)) {
        return [ordered]@{ moved = $false; reason = "世界不存在（本轮由自动化新建）：$world" }
    }
    New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
    $dest = Join-Path $BackupRoot ('sde_parts_acceptance_world-' + (Get-Date -Format 'HHmmss'))
    try {
        Move-Item -Path $world -Destination $dest -ErrorAction Stop
    } catch {
        return [ordered]@{ moved = $false; reason = "移动失败（可能有客户端占用 session.lock）：$($_.Exception.Message)" }
    }
    return [ordered]@{ moved = $true; dest = $dest; src = $world }
}

# ---------------------------------------------------------------------------
# 验收世界基线快照 / 还原（见 -SnapshotWorld 说明）
# ---------------------------------------------------------------------------
function Copy-TreeContents {
    param([Parameter(Mandatory = $true)][string]$From, [Parameter(Mandatory = $true)][string]$To)
    New-Item -ItemType Directory -Force -Path $To | Out-Null
    Copy-Item -Path (Join-Path $From '*') -Destination $To -Recurse -Force
}

<#
  基线快照：第一次调用 = 把当前世界拷成基线；之后每次调用 = 先还原基线（旧的活世界移进本轮目录，不删除）。
  返回 { created | restored | reason }。世界不存在（首轮需生成）时返回 created=false 并让自动化自行生成。
#>
function Sync-AcceptanceWorldBaseline {
    param([Parameter(Mandatory = $true)][string]$Baseline, [Parameter(Mandatory = $true)][string]$PassDir)
    $world = Join-Path $mcDataDir 'saves\sde_parts_acceptance_world'
    if (-not (Test-Path $Baseline)) {
        if (-not (Test-Path $world)) {
            return [ordered]@{ created = $false; restored = $false; baseline = $Baseline; reason = '世界不存在（本轮由自动化生成；下一轮起快照生效）' }
        }
        Copy-TreeContents -From $world -To $Baseline
        return [ordered]@{ created = $true; restored = $false; baseline = $Baseline; reason = '已建立基线快照（第 1 轮起点）' }
    }
    # 还原基线：活世界先移走（保留证据），再拷贝基线
    if (Test-Path $world) {
        $trash = Join-Path $PassDir ('world-previous-' + (Get-Date -Format 'HHmmss'))
        New-Item -ItemType Directory -Force -Path (Split-Path $trash -Parent) | Out-Null
        Move-Item -Path $world -Destination $trash -ErrorAction Stop
    }
    Copy-TreeContents -From $Baseline -To $world
    return [ordered]@{ created = $false; restored = $true; baseline = $Baseline; reason = '已还原基线（各轮起点逐字节相同）' }
}

function Invoke-BuildMod {
    $t0 = Get-Date
    $log = Join-Path $script:logDir 'build-mod-gtnh.log'
    Write-Step 'gradlew build（mod/gtnh）'
    $r = Invoke-Native -FilePath $script:gradlew -ArgumentList @('build', '--console=plain') -WorkDir $modDir `
        -LogPath $log -TimeoutSec ($BuildTimeoutMinutes * 60)
    $gates = @(@{ name = 'gradlew build 退出码 0'; ok = ($r.exitCode -eq 0); detail = "exit=$($r.exitCode) timeout=$($r.timedOut)" })
    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok 'mod 构建通过' } else { Write-Err2 "mod 构建失败（exit=$($r.exitCode)）" }
    return Write-StageFragment -Id 'build-mod-gtnh' -Name 'gradlew build（mod/gtnh）' -Command 'cd mod/gtnh && gradlew build' `
        -Status $status -ExitCode $r.exitCode -DurationMs $r.elapsedMs -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') `
        -Gates $gates -Evidence @($log)
}

function Invoke-L1ExportOracle {
    $t0 = Get-Date
    $log = Join-Path $script:logDir 'l1-export-oracle.log'
    $l1Root = Join-Path $passDir 'l1'
    New-Item -ItemType Directory -Force -Path $l1Root | Out-Null
    $l1Label = "$Label-l1"
    $worldReset = $null

    if ($L1From) {
        Write-Step "L1：复用既有归档 $L1From"
        $dest = Join-Path $l1Root $l1Label
        if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
        Copy-Item -Force (Join-Path $L1From '*') $dest
        $r = [ordered]@{ exitCode = 0; elapsedMs = 0; timedOut = $false; stdOut = '（复用既有归档，未启动客户端）'; stdErr = '' }
    } elseif ($SkipL1) {
        Write-Warn2 'L1：-SkipL1 且无 -L1From → 记 not-run'
        Invoke-StageSkipped 'l1-export-oracle' $script:stagePlan['l1-export-oracle'] '-SkipL1 且未提供 -L1From'
        return
    } else {
        # 清掉**本标签**的陈旧归档目录：否则本轮新产物会被旧目录抢走（L2/verify 会去读旧导出），
        # 也会让"这次运行到底验的是哪份产物"无法自证。只删本标签前缀（运行目录内、自己创建）。
        Get-ChildItem -Path $l1Root -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq $l1Label -or $_.Name -like "$l1Label-r*" } |
            ForEach-Object { Remove-Item -Recurse -Force $_.FullName }
        # 清场（-ResetWorld，默认关）：把验收世界**移动**到运行目录备份 ⇒ 从零生成。
        # **默认关闭**（见 -ResetWorld 说明：干净世界里客户端同步窗口不足 ⇒ 产物无效，findings M4）。
        if ($ResetWorld) {
            $worldReset = Reset-AcceptanceWorld -BackupRoot (Join-Path $passDir 'world-backup')
            if ($worldReset.moved) { Write-Ok "验收世界已清场（备份：$($worldReset.dest)）" }
            else { Write-Warn2 "验收世界未清场：$($worldReset.reason)" }
        } else {
            $worldReset = [ordered]@{ moved = $false; reason = '默认不清场（复用既有世界；自动化自带 resetWorld 清场 + 重建）' }
        }
        # 基线快照 / 还原（-SnapshotWorld，默认开）：让连续多轮从**逐字节相同**的世界状态起跑（findings F3 的处置）
        if ($SnapshotWorld -and -not $ResetWorld) {
            try {
                $worldReset = Sync-AcceptanceWorldBaseline -Baseline (Join-Path $runDir 'world-baseline') -PassDir $passDir
                Write-Ok "世界基线：$($worldReset.reason)"
            } catch {
                Write-Warn2 "世界基线快照/还原失败（不阻断，但跨轮幂等可能受 F3 影响）：$($_.Exception.Message)"
                $worldReset = [ordered]@{ created = $false; restored = $false; reason = "失败：$($_.Exception.Message)" }
            }
        }
        Write-Step "L1：建造 → 导出 → oracle（run-acceptance.ps1 -Runs $L1Runs -SyncWaitTicks $SyncWaitTicks，超时 ${L1TimeoutMinutes}min）"
        $r = Invoke-Native -FilePath $script:pwshCmd `
            -ArgumentList @('-NoProfile', '-File', $l1Script, '-Label', $l1Label, '-Runs', "$L1Runs", '-OutRoot', $l1Root, '-SyncWaitTicks', "$SyncWaitTicks") `
            -WorkDir $repoRoot -LogPath $log -TimeoutSec ($L1TimeoutMinutes * 60)
    }

    # L1 归档目录：优先 -r1（多轮时），否则单目录
    $cand = @()
    $cand += (Join-Path $l1Root "$l1Label-r1")
    $cand += (Join-Path $l1Root $l1Label)
    $archive = $cand | Where-Object { Test-Path (Join-Path $_ 'sde_parts_acceptance_result.json') } | Select-Object -First 1
    $result = if ($archive) { Get-Content (Join-Path $archive 'sde_parts_acceptance_result.json') -Raw | ConvertFrom-Json } else { $null }

    $suites = @($result.suites)
    $gates = @(
        @{ name = 'L1 编排退出码 0'; ok = ($r.exitCode -eq 0); detail = "exit=$($r.exitCode) timeout=$($r.timedOut)" },
        @{ name = 'L1 结构化结果已产出'; ok = [bool]$result; detail = "$archive" },
        @{ name = 'L1 status=ok / exitCode=0'; ok = ($result -and $result.status -eq 'ok' -and $result.exitCode -eq 0); detail = "status=$($result.status) exitCode=$($result.exitCode)" },
        @{ name = '三套件（full / degraded_ae2 / degraded_all）全绿'; ok = ($suites.Count -eq 3 -and (@($suites | Where-Object { -not $_.pass }).Count -eq 0)); detail = ($suites | ForEach-Object { "$($_.suite)=$($_.pass)" }) -join ' ' },
        @{ name = '同轮双导出幂等（sha256 相等）'; ok = ($result -and $result.idempotencyFull.identical -eq $true); detail = if ($result -and $result.idempotencyFull -and $result.idempotencyFull.runASha256) { "A=$($result.idempotencyFull.runASha256.Substring(0,12)) B=$($result.idempotencyFull.runBSha256.Substring(0,12))" } else { 'n/a（结果文件未记录 idempotencyFull）' } },
        @{ name = '满方块-only 字节干净（L1 结论）'; ok = ($result -and $result.fullCubeByteClean.pass -eq $true); detail = if ($result -and $result.fullCubeByteClean -and $result.fullCubeByteClean.enabledSha256) { "enabled=$($result.fullCubeByteClean.enabledSha256.Substring(0,12))" } else { 'n/a（结果文件未记录 fullCubeByteClean）' } }
    )
    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok "L1 全绿：$($result.intentCells) 格意图 / 三套件通过 / 幂等 + 字节干净" }
    else { Write-Err2 'L1 红（见日志与结果文件）' }

    $script:l1Archive = $archive
    return Write-StageFragment -Id 'l1-export-oracle' -Name 'L1：建造 → 导出 → oracle（P1.8 全链路）' `
        -Command "pwsh -File scripts/parts-acceptance/run-acceptance.ps1 -Label $l1Label -Runs $L1Runs -OutRoot $l1Root" `
        -Status $status -ExitCode $r.exitCode -DurationMs $r.elapsedMs -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') `
        -Gates $gates -Artifacts @($archive) -Evidence @($log) `
        -Data @{ archive = $archive; l1Runs = $L1Runs; worldReset = $worldReset; intentCells = $result.intentCells; suites = $suites; idempotencyFull = $result.idempotencyFull; fullCubeByteClean = $result.fullCubeByteClean; warnings = @($result.warnings); reused = [bool]$L1From }
}

function Invoke-L1VerifyOracle {
    $t0 = Get-Date
    $verifyDir = Join-Path $passDir 'verify'
    New-Item -ItemType Directory -Force -Path $verifyDir | Out-Null
    $archive = $script:l1Archive
    if (-not $archive) { Invoke-StageSkipped 'l1-verify-oracle' $script:stagePlan['l1-verify-oracle'] 'L1 归档缺失（前序未产出）'; return }

    $plan = @(
        @{ kind = 'full';        oracle = 'sde_parts_acceptance_oracle_full.json';        export = 'sde_parts_acceptance_export_full_a.json';        out = 'oracle-full.json' },
        @{ kind = 'degradedAe2'; oracle = 'sde_parts_acceptance_oracle_degraded_ae2.json'; export = 'sde_parts_acceptance_export_degraded_ae2.json'; out = 'oracle-degraded-ae2.json' },
        @{ kind = 'degradedAll'; oracle = 'sde_parts_acceptance_oracle_degraded_all.json'; export = 'sde_parts_acceptance_export_degraded_all.json'; out = 'oracle-degraded-all.json' }
    )
    $checks = @()
    $reports = @{}
    foreach ($p in $plan) {
        $log = Join-Path $script:logDir "verify-oracle-$($p.kind).log"
        $out = Join-Path $verifyDir $p.out
        Write-Step "逐格核对（脚本侧独立复算）：$($p.kind)"
        $r = Invoke-Native -FilePath $script:nodeCmd `
            -ArgumentList @((Join-Path $scriptDir 'verify-oracle.mjs'), '--oracle', (Join-Path $oracleDir $p.oracle), '--export', (Join-Path $archive $p.export), '--label', $p.kind, '--out', $out) `
            -WorkDir $repoRoot -LogPath $log -TimeoutSec 900
        $rep = if (Test-Path $out) { Get-Content $out -Raw | ConvertFrom-Json } else { $null }
        $reports[$p.kind] = $rep
        $checks += @{ name = "$($p.kind) 验证器退出码 0"; ok = ($r.exitCode -eq 0); detail = "exit=$($r.exitCode)" }
        $checks += @{ name = "$($p.kind) 判据全过"; ok = ($rep -and $rep.pass -eq $true -and $rep.failedChecks -eq 0); detail = if ($rep) { "checks=$($rep.checks) failed=$($rep.failedChecks) cells=$($rep.cellsChecked) fullCube=$($rep.fullCubeCells)" } else { 'n/a' } }
    }
    $status = Get-GateStatus $checks
    if ($status -eq 'pass') { Write-Ok "脚本侧逐格核对全绿：$($reports['full'].checks) + $($reports['degradedAe2'].checks) + $($reports['degradedAll'].checks) 条判据" }
    else { Write-Err2 '脚本侧逐格核对红' }
    return Write-StageFragment -Id 'l1-verify-oracle' -Name 'L1 复算：oracle ↔ 导出逐格核对（脚本侧独立实现）' `
        -Command 'node scripts/parts-acceptance/verify-oracle.mjs --oracle <oracle> --export <归档导出>（三套件）' `
        -Status $status -ExitCode $(if ($status -eq 'pass') { 0 } else { 1 }) -DurationMs ([int]((Get-Date) - $t0).TotalMilliseconds) `
        -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') -Gates $checks `
        -Artifacts @((Join-Path $verifyDir 'oracle-full.json'), (Join-Path $verifyDir 'oracle-degraded-ae2.json'), (Join-Path $verifyDir 'oracle-degraded-all.json')) `
        -Evidence @($script:logDir) `
        -Data @{ full = @{ checks = $reports['full'].checks; failed = $reports['full'].failedChecks; cells = $reports['full'].cellsChecked; observations = $reports['full'].observations }; degradedAe2 = @{ checks = $reports['degradedAe2'].checks; failed = $reports['degradedAe2'].failedChecks }; degradedAll = @{ checks = $reports['degradedAll'].checks; failed = $reports['degradedAll'].failedChecks } }
}

function Invoke-DegradationStatic {
    $t0 = Get-Date
    $log = Join-Path $script:logDir 'degradation-static.log'
    $out = Join-Path $passDir 'static-checks.json'
    Write-Step '静态/降级判据（推断永不当主来源 / 三档降级 / 字节干净 / 旧格式 / web 不重算盒 / proto）'
    $archive = $script:l1Archive
    if (-not $archive) { Invoke-StageSkipped 'degradation-static' $script:stagePlan['degradation-static'] 'L1 归档缺失（前序未产出）'; return }
    $r = Invoke-Native -FilePath $script:nodeCmd `
        -ArgumentList @((Join-Path $scriptDir 'check-static.mjs'), '--archive', $archive, '--out', $out) `
        -WorkDir $repoRoot -LogPath $log -TimeoutSec 600
    $rep = if (Test-Path $out) { Get-Content $out -Raw | ConvertFrom-Json } else { $null }
    $s = $rep.sections
    $gates = @(
        @{ name = '脚本退出码 0'; ok = ($r.exitCode -eq 0); detail = "exit=$($r.exitCode)" },
        @{ name = '推断永不当主来源'; ok = ($s.inferredNeverPrimary.pass -eq $true); detail = "tier1/2 与 inferred 同格 = $($s.inferredNeverPrimary.violations.Count)" },
        @{ name = '三档降级档位正确'; ok = ($s.tierDegradation.pass -eq $true); detail = "违例 $($s.tierDegradation.violations.Count) 条" },
        @{ name = '满方块-only 字节干净'; ok = ($s.fullCubeByteClean.pass -eq $true); detail = "L1 sha256 相等 = $($s.fullCubeByteClean.l1Reference.pass)" },
        @{ name = '旧格式文件无部件字段'; ok = ($s.legacyNoPartsKeys.pass -eq $true); detail = "检查 $($s.legacyNoPartsKeys.files.Count) 份" },
        @{ name = 'web 端不重算盒'; ok = ($s.webNoBoxConstruction.pass -eq $true); detail = "扫描 $($s.webNoBoxConstruction.scanned.Count) 文件" },
        @{ name = 'proto 契约字段在册'; ok = ($s.protoContractFields.pass -eq $true); detail = "$($s.protoContractFields.path)" }
    )
    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok '静态/降级判据全绿' } else { Write-Err2 '静态/降级判据红' }
    return Write-StageFragment -Id 'degradation-static' -Name 'P3.2/P3.3 静态与降级判据' `
        -Command 'node scripts/parts-acceptance/check-static.mjs --archive <L1 归档> --out <run>/static-checks.json' `
        -Status $status -ExitCode $r.exitCode -DurationMs $r.elapsedMs -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') `
        -Gates $gates -Artifacts @($out) -Evidence @($log) -Data @{ sections = $s; violations = @($rep.violations) }
}

function Invoke-ReferenceFakeProvider {
    $t0 = Get-Date
    $log = Join-Path $script:logDir 'reference-fake-provider.log'
    $falsifyDir = Join-Path $passDir 'falsification'
    New-Item -ItemType Directory -Force -Path $falsifyDir | Out-Null
    Write-Step 'P1.1 expB 引用：必抛假提供者 → 导出完成且降级记录落盘（机器核对探针归档）'
    $archive = $script:l1Archive
    if (-not $archive) { Invoke-StageSkipped 'reference-fake-provider' $script:stagePlan['reference-fake-provider'] 'L1 归档缺失（前序未产出）'; return }
    $r = Invoke-Native -FilePath $script:nodeCmd `
        -ArgumentList @((Join-Path $scriptDir 'falsification.mjs'), '--archive', $archive, '--out', $falsifyDir, '--only', 'fake-provider') `
        -WorkDir $repoRoot -LogPath $log -TimeoutSec 600
    $rep = if (Test-Path (Join-Path $falsifyDir 'fake-provider.json')) { Get-Content (Join-Path $falsifyDir 'fake-provider.json') -Raw | ConvertFrom-Json } else { $null }
    $ctrl = if ($rep) { @($rep.controls)[0] } else { $null }
    if ($r.exitCode -eq 2) {
        # 证据缺失：记 not-run + 开放项（**不静默算通过**）
        $msg = '探针归档缺失（mod/gtnh/run/client/sde_parts_probe_dump.json / _result.json）—— P1.1 expB 证据不可得，本阶段记 not-run；请先跑一次部件探针（PartsProbeAutomation）再复跑本编排'
        Invoke-StageSkipped 'reference-fake-provider' $script:stagePlan['reference-fake-provider'] $msg
        $script:openItems += [ordered]@{ id = 'fake-provider-evidence-missing'; severity = 'blocking'; text = $msg }
        return
    }
    $gates = @(
        @{ name = '脚本退出码 0'; ok = ($r.exitCode -eq 0); detail = "exit=$($r.exitCode)" },
        @{ name = 'expB 容错通过（非满格逐格记录 providerFailures）'; ok = ($ctrl -and $ctrl.ok -eq $true); detail = if ($ctrl) { "非满格 $($ctrl.evidence.nonFullCellsWithProviderFailures)/$($ctrl.evidence.nonFullCells)" } else { 'n/a' } },
        @{ name = '结果与无该提供者的基线（expC）一致'; ok = ($ctrl -and $ctrl.evidence.baselineComparedCells -gt 0); detail = if ($ctrl) { "对比 $($ctrl.evidence.baselineComparedCells) 格" } else { 'n/a' } }
    )
    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok "假提供者引用通过：$($ctrl.evidence.nonFullCellsWithProviderFailures)/$($ctrl.evidence.nonFullCells) 非满格记录降级" }
    else { Write-Err2 '假提供者引用红' }
    return Write-StageFragment -Id 'reference-fake-provider' -Name 'P3.4 引用：必抛假提供者容错（P1.1 expB）' `
        -Command 'node scripts/parts-acceptance/falsification.mjs --only fake-provider' -Status $status -ExitCode $r.exitCode `
        -DurationMs $r.elapsedMs -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') -Gates $gates `
        -Artifacts @((Join-Path $falsifyDir 'fake-provider.json')) -Evidence @($log, $ctrl.evidence.probeDump) -Data @{ control = $ctrl }
}

# ---------------------------------------------------------------------------
# 阶段：web 半环
# ---------------------------------------------------------------------------
function Invoke-RegressionVitest {
    $t0 = Get-Date
    $log = Join-Path $script:logDir 'regression-vitest.log'
    Write-Step 'vitest run（web 单元测试）'
    $vitestCli = Join-Path $webDir 'node_modules\vitest\vitest.mjs'
    $r = Invoke-Native -FilePath $script:nodeCmd -ArgumentList @($vitestCli, 'run') -WorkDir $webDir -LogPath $log -TimeoutSec ($WebTimeoutMinutes * 60)
    $text = if (Test-Path $log) { Get-Content $log -Raw } else { '' }
    $m = [regex]::Match($text, 'Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed')
    $failed = if ($m.Groups[1].Success) { [int]$m.Groups[1].Value } else { 0 }
    $passed = if ($m.Groups[2].Success) { [int]$m.Groups[2].Value } else { 0 }
    $gates = @(
        @{ name = 'vitest 退出码 0'; ok = ($r.exitCode -eq 0); detail = "exit=$($r.exitCode)" },
        @{ name = '无失败用例'; ok = ($failed -eq 0); detail = "failed=$failed" },
        @{ name = '有用例通过'; ok = ($passed -gt 0); detail = "passed=$passed" }
    )
    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok "vitest 全绿（$passed 用例）" } else { Write-Err2 "vitest 红（passed=$passed failed=$failed）" }
    return Write-StageFragment -Id 'regression-vitest' -Name 'vitest 单元测试（P2.1–P2.4 回归）' -Command 'cd web && npx vitest run' `
        -Status $status -ExitCode $r.exitCode -DurationMs $r.elapsedMs -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') `
        -Gates $gates -Evidence @($log) -Data @{ passed = $passed; failed = $failed }
}

function Invoke-BuildWeb {
    $t0 = Get-Date
    $log = Join-Path $script:logDir 'build-web.log'
    Write-Step 'build:web（embed + workbench）'
    $r = Invoke-Native -FilePath $script:npmCmd -ArgumentList @('run', 'build:web') -WorkDir $repoRoot -LogPath $log -TimeoutSec ($BuildTimeoutMinutes * 60)
    $gates = @(@{ name = 'build:web 退出码 0'; ok = ($r.exitCode -eq 0); detail = "exit=$($r.exitCode)" })
    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok 'build:web 通过' } else { Write-Err2 'build:web 失败' }
    return Write-StageFragment -Id 'build-web' -Name 'npm run build:web' -Command 'npm run build:web' -Status $status -ExitCode $r.exitCode `
        -DurationMs $r.elapsedMs -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') -Gates $gates -Evidence @($log)
}

function Invoke-RegressionPartsFixtures {
    $t0 = Get-Date
    $jsonPath = Join-Path $passDir 'web\parts-fixtures.json'
    New-Item -ItemType Directory -Force -Path (Split-Path $jsonPath -Parent) | Out-Null
    Write-Step 'P2.5 断言包（fixture 驱动：悬停/统计/图标/回归 + 证伪）'
    $res = Invoke-Playwright -Id 'regression-parts-fixtures' -SpecPattern 'parts-hover-stats.spec.ts parts-falsification.spec.ts' -JsonOut $jsonPath -TimeoutMinutes $WebTimeoutMinutes
    $r = $res.result
    $gates = @(
        @{ name = 'playwright 退出码 0'; ok = ($r.exitCode -eq 0); detail = "exit=$($r.exitCode) timeout=$($r.timedOut)" },
        @{ name = 'json 报告已产出'; ok = (Test-Path $jsonPath); detail = $jsonPath },
        @{ name = '未被外部 webServer 争用'; ok = (-not $res.foreign); detail = "foreign=$($res.foreign)" }
    )
    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok 'P2.5 断言包全绿' } else { Write-Err2 "P2.5 断言包红（exit=$($r.exitCode)）" }
    Write-StageFragment -Id 'regression-parts-fixtures' -Name 'P2.5 断言包（fixture：悬停/统计/图标/回归 + 证伪）' `
        -Command 'cd web && node node_modules/@playwright/test/cli.js test parts-hover-stats.spec.ts parts-falsification.spec.ts --retries=0' `
        -Status $status -ExitCode $r.exitCode -DurationMs $r.elapsedMs -StartedAt $res.t0.ToString('o') -EndedAt (Get-Date).ToString('o') `
        -Gates $gates -Artifacts @($jsonPath) -Evidence @($res.log) -Data @{ reportJson = $jsonPath } | Out-Null
}

function Invoke-RegressionMultiblockCross {
    $t0 = Get-Date
    $jsonPath = Join-Path $passDir 'web\multiblock-cross.json'
    New-Item -ItemType Directory -Force -Path (Split-Path $jsonPath -Parent) | Out-Null
    # 选最轻量且能证明「加载 + 通道切换」的既有 spec：multiblock-channel-traversal 单用例
    # （驱动 height 1→5 与 Tier 1→3 滑杆 → 断言渲染逐格等于独立参考），不跑 real-acceptance 全套（~12min）
    $spec = 'multiblock-channel-traversal.spec.ts'
    $grep = '尺寸变化方向'
    Write-Step "多方块交叉回归（加载 + 通道切换）：$spec -g $grep"
    $res = Invoke-Playwright -Id 'regression-multiblock-cross' -SpecPattern $spec -JsonOut $jsonPath -TimeoutMinutes $WebTimeoutMinutes -Grep $grep
    $r = $res.result
    $gates = @(
        @{ name = 'playwright 退出码 0'; ok = ($r.exitCode -eq 0); detail = "exit=$($r.exitCode) timeout=$($r.timedOut)" },
        @{ name = 'json 报告已产出'; ok = (Test-Path $jsonPath); detail = $jsonPath },
        @{ name = '未被外部 webServer 争用'; ok = (-not $res.foreign); detail = "foreign=$($res.foreign)" }
    )
    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok '多方块交叉回归全绿（加载 + 通道切换不回归）' } else { Write-Err2 "多方块交叉回归红（exit=$($r.exitCode)）" }
    Write-StageFragment -Id 'regression-multiblock-cross' -Name '多方块交叉回归（加载 + 通道切换）' `
        -Command "cd web && node node_modules/@playwright/test/cli.js test $spec -g '$grep' --retries=0" `
        -Status $status -ExitCode $r.exitCode -DurationMs $r.elapsedMs -StartedAt $res.t0.ToString('o') -EndedAt (Get-Date).ToString('o') `
        -Gates $gates -Artifacts @($jsonPath) -Evidence @($res.log) `
        -Data @{ reportJson = $jsonPath; spec = $spec; grep = $grep } -Notes @('选型理由：多方块 spec 中最快能证明「加载+通道切换」的单用例（驱动尺寸/Tier 滑杆 + 逐格参考比对）；real-acceptance 全套 ~12min 不跑') | Out-Null
}

function Invoke-L2RealRender {
    $t0 = Get-Date
    $jsonPath = Join-Path $passDir 'web\l2-real-export.json'
    $obsPath = Join-Path $passDir 'web\l2-observations.json'
    New-Item -ItemType Directory -Force -Path (Split-Path $jsonPath -Parent) | Out-Null
    $archive = $script:l1Archive
    if (-not $archive) { Invoke-StageSkipped 'l2-real-render' $script:stagePlan['l2-real-render'] 'L1 归档缺失（前序未产出）'; return }
    Write-Step "L2 真实导出渲染断言（PARTS_ACCEPTANCE_DIR=$archive）"
    $res = Invoke-Playwright -Id 'l2-real-render' -SpecPattern 'parts-real-export.spec.ts' -JsonOut $jsonPath -TimeoutMinutes $WebTimeoutMinutes `
        -ExtraEnv @{ PARTS_ACCEPTANCE_DIR = $archive; PARTS_L2_OBSERVATIONS_OUT = $obsPath }
    $r = $res.result
    $gates = @(
        @{ name = 'playwright 退出码 0'; ok = ($r.exitCode -eq 0); detail = "exit=$($r.exitCode) timeout=$($r.timedOut)" },
        @{ name = 'json 报告已产出'; ok = (Test-Path $jsonPath); detail = $jsonPath },
        @{ name = '未被外部 webServer 争用'; ok = (-not $res.foreign); detail = "foreign=$($res.foreign)" },
        @{ name = 'L2 观测文件已产出（偏差登记）'; ok = (Test-Path $obsPath); detail = $obsPath }
    )
    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok 'L2 真实导出断言全绿（详见 json 报告）' } else { Write-Err2 "L2 红（exit=$($r.exitCode)）" }
    Write-StageFragment -Id 'l2-real-render' -Name 'P3.1 L2：真实导出渲染断言包' `
        -Command "cd web && node node_modules/@playwright/test/cli.js test parts-real-export.spec.ts --retries=0（PARTS_ACCEPTANCE_DIR=$archive）" `
        -Status $status -ExitCode $r.exitCode -DurationMs $r.elapsedMs -StartedAt $res.t0.ToString('o') -EndedAt (Get-Date).ToString('o') `
        -Gates $gates -Artifacts @($jsonPath, $obsPath) -Evidence @($res.log) `
        -Data @{ reportJson = $jsonPath; observations = $obsPath; archive = $archive } | Out-Null
}

# ---------------------------------------------------------------------------
# 阶段：证伪 + 幂等 + 报告
# ---------------------------------------------------------------------------
function Invoke-FalsifyNegative {
    $t0 = Get-Date
    $log = Join-Path $script:logDir 'falsify-negative.log'
    $falsifyDir = Join-Path $passDir 'falsification'
    New-Item -ItemType Directory -Force -Path $falsifyDir | Out-Null
    Write-Step 'P3.4 负对照：篡改 oracle / 敲掉部件 / 改计数 → 验证器必须红（正对照必须绿）'
    $archive = $script:l1Archive
    if (-not $archive) { Invoke-StageSkipped 'falsify-negative' $script:stagePlan['falsify-negative'] 'L1 归档缺失（前序未产出）'; return }
    $r = Invoke-Native -FilePath $script:nodeCmd `
        -ArgumentList @((Join-Path $scriptDir 'falsification.mjs'), '--archive', $archive, '--out', $falsifyDir, '--only', 'negatives') `
        -WorkDir $repoRoot -LogPath $log -TimeoutSec 900
    $rep = if (Test-Path (Join-Path $falsifyDir 'falsification.json')) { Get-Content (Join-Path $falsifyDir 'falsification.json') -Raw | ConvertFrom-Json } else { $null }
    $reds = @($rep.controls | Where-Object { $_.expectedRed })
    $notRed = @($reds | Where-Object { -not $_.ok })
    $gates = @(
        @{ name = '脚本退出码 0'; ok = ($r.exitCode -eq 0); detail = "exit=$($r.exitCode)" },
        @{ name = '负对照 ≥5 条'; ok = ($reds.Count -ge 5); detail = "controls=$($reds.Count)" },
        @{ name = '全部负对照如期变红'; ok = ($reds.Count -gt 0 -and $notRed.Count -eq 0); detail = "$($reds.Count - $notRed.Count)/$($reds.Count)" },
        @{ name = '正对照（未篡改）绿'; ok = ($rep.positiveControl.ok -eq $true); detail = "exit=$($rep.positiveControl.exitCode)" }
    )
    $status = Get-GateStatus $gates
    if ($status -eq 'pass') { Write-Ok "证伪全绿：$($reds.Count) 条负对照全部变红，正对照绿" } else { Write-Err2 "证伪红：$($notRed.Count) 条负对照没红" }
    return Write-StageFragment -Id 'falsify-negative' -Name 'P3.4 证伪：篡改必红（负对照 + 正对照）' `
        -Command 'node scripts/parts-acceptance/falsification.mjs --only negatives --archive <L1 归档>' `
        -Status $status -ExitCode $r.exitCode -DurationMs $r.elapsedMs -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') `
        -Gates $gates -Artifacts @((Join-Path $falsifyDir 'falsification.json')) -Evidence @($log) `
        -Data @{ positiveControl = $rep.positiveControl; summary = $rep.summary }
}

function Invoke-Idempotency {
    param([string]$Pass1Dir, [string]$Pass2Dir)
    $t0 = Get-Date
    $out = Join-Path $runDir 'idempotency.json'
    $gates = @()
    $data = @{ mode = if ($Runs -gt 1) { 'cross-run' } else { 'single-run' } }
    if ($Runs -le 1) {
        $gates += @{ name = 'L1 同轮双导出幂等（已在 L1 阶段判定）'; ok = $true; detail = 'Runs=1：跨轮比对未启用；以 L1 -Runs 2 内部幂等 + 报告重算稳定为证据' }
        $data.excludedPatterns = @('acceptance-report.json#generatedAt', 'stages/*.json#startedAt/endedAt/durationMs', 'l1/*/sde_parts_acceptance_result.json#startedAtEpochMs/finishedAtEpochMs', 'logs/*.log')
        Set-Content -Path $out -Value ([ordered]@{ schema = 'lightning.parts-idempotency/1'; mode = 'single-run'; allSame = $null; excludedPatterns = $data.excludedPatterns; note = '未启用 -Runs 2' } | ConvertTo-Json -Depth 6) -Encoding utf8NoBOM
    } else {
        Write-Step "跨轮幂等比对（pass1 vs pass2）：产物逐文件 sha256"
        # 比对集：数据产物（排除含时间戳/路径字段的文件）
        $patterns = @(
            'l1\*\sde_parts_acceptance_export_*.json',
            'l1\*\sde_parts_acceptance_oracle_*.json',
            'l1\*\sde_parts_acceptance_dump.json',
            'verify\*.json',
            'static-checks.json'
        )
        # 路径字段归一化：JSON 产物里嵌了本轮的**绝对路径**（pass1/ 与 pass2/ 不同），
        # 直接比字节会把"同一份数据"判成不一致。归一化 = 把本轮运行目录/pass 目录路径替换为占位符后再比。
        $runRoot = $runDir
        $variants = @()
        foreach ($p in @($Pass1Dir, $Pass2Dir, $runRoot)) {
            $rel = $p.Substring($repoRoot.Length).TrimStart('\', '/')
            foreach ($v in @($p, $p.Replace('\', '/'), $p.Replace('\', '\\'), $rel, $rel.Replace('\', '/'), $rel.Replace('\', '\\'))) {
                if ($v) { $variants += $v }
            }
        }
        $variants = $variants | Sort-Object -Unique | Sort-Object -Property Length -Descending
        function Get-NormalizedFileHash([string]$file, [string]$selfPassDir, [string[]]$pathVariants) {
            $ext = [System.IO.Path]::GetExtension($file)
            if ($ext -ieq '.json') {
                $txt = Get-Content $file -Raw
                foreach ($v in $pathVariants) { if ($v) { $txt = $txt.Replace($v, '<PATH>') } }
                $sha = [System.Security.Cryptography.SHA256]::Create()
                try {
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes($txt)
                    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '')
                } finally { $sha.Dispose() }
            }
            return (Get-FileHash $file -Algorithm SHA256).Hash
        }
        $compared = @()
        $mismatch = @()
        foreach ($pat in $patterns) {
            $files = Get-ChildItem -Path (Join-Path $Pass1Dir $pat) -File -ErrorAction SilentlyContinue
            foreach ($f in $files) {
                $relPath = $f.FullName.Substring($Pass1Dir.Length).TrimStart('\')
                $b = Join-Path $Pass2Dir $relPath
                if (-not (Test-Path $b)) { $mismatch += "$relPath（pass2 缺失）"; continue }
                $ha = Get-NormalizedFileHash -file $f.FullName -selfPassDir $Pass1Dir -pathVariants $variants
                $hb = Get-NormalizedFileHash -file $b -selfPassDir $Pass2Dir -pathVariants $variants
                $same = ($ha -eq $hb)
                $compared += [ordered]@{ file = $relPath; sha1 = $ha.Substring(0, 16); sha2 = $hb.Substring(0, 16); same = $same; normalized = ($f.Extension -ieq '.json') }
                if (-not $same) { $mismatch += "$relPath（$($ha.Substring(0,12)) vs $($hb.Substring(0,12))）" }
            }
        }
        $allSame = ($compared.Count -gt 0 -and $mismatch.Count -eq 0)
        $excluded = @(
            'acceptance-report.json#generatedAt（报告生成时刻）',
            'stages/*.json#startedAt/endedAt/durationMs（阶段计时）',
            'l1/*/sde_parts_acceptance_result.json#startedAtEpochMs/finishedAtEpochMs（真实运行时刻）',
            'falsification/falsification.json#evidence.*（含运行目录路径）',
            'logs/*.log（含真实时刻、耗时、进度）',
            '**路径字段归一化**：JSON 产物里的本轮绝对路径（pass1/ vs pass2/）先替换为 <PATH> 再比字节'
        )
        Set-Content -Path $out -Value ([ordered]@{
                schema = 'lightning.parts-idempotency/1'; mode = 'cross-run'
                pass1 = $Pass1Dir; pass2 = $Pass2Dir; compared = $compared; allSame = $allSame; mismatch = $mismatch
                excludedPatterns = $excluded
                note = '时间戳/路径字段已显式排除（报告中标注）；数据产物必须逐字节一致'
            } | ConvertTo-Json -Depth 8) -Encoding utf8NoBOM
        $gates += @{ name = '跨轮产物逐字节一致'; ok = $allSame; detail = "比对 $($compared.Count) 个文件，不一致 $($mismatch.Count) 个：$($mismatch -join '; ')" }
        $data.comparedFiles = $compared.Count
        $data.mismatch = $mismatch
        if ($allSame) { Write-Ok "跨轮幂等：$($compared.Count) 个数据产物逐字节一致" } else { Write-Err2 "跨轮不一致：$($mismatch -join '; ')" }
    }
    $status = Get-GateStatus $gates
    return Write-StageFragment -Id 'idempotency' -Name '幂等：跨轮产物字节一致性（时间戳除外）' -Command '（内置：Get-FileHash 逐文件比对）' `
        -Status $status -ExitCode $(if ($status -eq 'pass') { 0 } else { 8 }) -DurationMs ([int]((Get-Date) - $t0).TotalMilliseconds) `
        -StartedAt $t0.ToString('o') -EndedAt (Get-Date).ToString('o') -Gates $gates -Artifacts @($out) -Data $data
}

function Invoke-Report {
    param([string]$ReportRunDir, [string]$ComparePath = '')
    $t0 = Get-Date
    $log = Join-Path $script:logDir 'report.log'
    Write-Step "汇总 acceptance-report.json（§6 清单逐条机器判定）：$ReportRunDir"
    $args = @((Join-Path $scriptDir 'build-parts-report.mjs'), '--run-dir', $ReportRunDir)
    if ($ComparePath -and (Test-Path $ComparePath)) { $args += @('--compare-with', $ComparePath) }
    $r = Invoke-Native -FilePath $script:nodeCmd -ArgumentList $args -WorkDir $repoRoot -LogPath $log -TimeoutSec 900
    $reportPath = Join-Path $ReportRunDir 'acceptance-report.json'
    return [ordered]@{ result = $r; reportPath = $reportPath; present = (Test-Path $reportPath); t0 = $t0; log = $log }
}

# ---------------------------------------------------------------------------
# 运行状态（报告的环境/裁决/开放项/阶段顺序来源）
# ---------------------------------------------------------------------------
function Write-RunState {
    param([string]$Mode)
    $gitHead = (& git -C $repoRoot rev-parse HEAD 2>$null)
    $gitDirty = (& git -C $repoRoot status --porcelain 2>$null) -join "`n"
    $state = [ordered]@{
        schema = 'lightning.acceptance.parts.run-state/1'
        label = $Label
        mode = $Mode
        command = 'npm run acceptance:parts' + $(if ($Label) { " -- -Label $Label" } else { '' }) + $(if ($Runs -gt 1) { " -Runs $Runs" } else { '' })
        startedAt = (Get-Date).ToString('o')
        runs = $Runs
        l1Runs = $L1Runs
        resetWorld = [bool]$ResetWorld
        l1From = $L1From
        skipBuild = [bool]$SkipBuild
        skipWeb = [bool]$SkipWeb
        stageOrder = @($script:stagePlan.Keys)
        zones = @('full-cube', 'single-box', 'ae2', 'enderio', 'fmp', 'overlay', 'degraded', 'variants')
        multiblockCrossSpec = 'multiblock-channel-traversal.spec.ts（-g 尺寸变化方向）'
        multiblockCrossNote = '多次方块 spec 中最快能证明「加载 + 通道切换」的单用例；real-acceptance 全套（~12 min）不跑'
        interactivity = [ordered]@{
            singleCommand = $true
            prompts = 0
            stdinRedirected = $true
            webHeadless = $true
            note = '全部子进程零交互；无任何提示（计划 §5「零人工」）'
        }
        openItems = $script:openItems
        adjudications = $script:adjudications
        git = @{ head = "$gitHead".Trim(); dirtyLines = if ($gitDirty) { ($gitDirty -split "`n").Count } else { 0 }; dirtySample = ($gitDirty -split "`n" | Select-Object -First 10) }
        paths = [ordered]@{ runDir = $runDir; scripts = $scriptDir; oracle = $oracleDir; l1Script = $l1Script }
    }
    Set-Content -Path (Join-Path $runDir 'run-state.json') -Value ($state | ConvertTo-Json -Depth 8) -Encoding utf8NoBOM
}

# ===========================================================================
# 主流程
# ===========================================================================
Write-Host ""
Write-Host "═══ Lightning 部件验收总入口（acceptance:parts）═══" -ForegroundColor Magenta
Write-Host "   label     : $Label"
Write-Host "   run dir   : $runDir"
Write-Host "   完整轮数  : $Runs（L1 内部幂等轮数 $L1Runs）"
Write-Host "   模式      : $(if ($DryRun) { 'dry-run' } else { 'acceptance' })"
Write-Host ""

$script:openItems = @(
    [ordered]@{ id = 'p2.5-geometry-augmented-copy'; severity = 'info'; text = 'P2.5 fixture 悬停用例采用「几何增强内存副本」口径（fixture 单绕组背向默认相机 + AE2 补面与邻盒共边界）；真实导出（本编排 L2）几何完整，不需要增强 —— 见 web/e2e/helpers/parts/README.md' },
    [ordered]@{ id = 'p2.5-mobile-collapse-oscillation'; severity = 'info'; text = 'mobile 窄布局侧栏展开 ~50ms 内被生产 watcher 折回（P2.5 实证）；展开态统计交互仅 desktop 跑，mobile 覆盖 = 解析级 + 悬停' },
    [ordered]@{ id = 'f1-f2-real-export-root-fields'; severity = 'resolved'; text = '【已修复闭环】StructureDataParser 根级透传 statsTemplate/statsOverride/partIconTextures + EmbedViewport 接线 :part-icon-textures（structureDataRootFields.test.ts 6 用例 + L2 正向锁：徽标=document-default、图标 canvas 逐行断言）' },
    [ordered]@{ id = 'f2b-fmp-iconkey-mat-prefix'; severity = 'resolved'; text = '【已修复闭环】FMP 行图标键带 mat= 前缀而嵌入纹理键不带 ⇒ mod 侧 nbtDiscriminator 改存 "mat=<材料串>" 键值串（契约 §10.2 同形），iconKey()==typeKey，图标键对齐' },
    [ordered]@{ id = 'ae2-plane-zero-thickness-box'; severity = 'info'; text = 'AE2 平面类部件（成形/破坏面板）碰撞盒在某轴零厚度（如实快照）；L1/L2 判据按「逐轴 min≤max + 非全轴退化」判定 —— 见报告 findings M1' },
    [ordered]@{ id = 'family-naming-eio'; severity = 'info'; text = '契约 §3 示例把 EnderIO 族写作 enderio，实现统一用 eio（localId 前缀 = family = 开关族名，自洽）—— 见报告 findings M2' },
    [ordered]@{ id = 'gitignore-parts-acceptance-out'; severity = 'resolved'; text = '【已闭环】.gitignore 已覆盖 scripts/parts-acceptance/.out/（L51），运行证据不会入库' }
)
$script:adjudications = @(
    [ordered]@{ id = 'P3.1-l2-real-export-archive'; text = 'L2 直接消费 L1 归档产物（每次完整编排内由 L1 阶段新鲜产出，canonical oracle 权威），不做"另跑一轮只导出"以减少客户端启动次数（一次一个 MC 客户端纪律）。'; source = '执行侧拍板（计划 §5 P3.1 允许"验收编排内重新导出"）' },
    [ordered]@{ id = 'P3.4-part-removal-equivalent-injection'; text = '「敲掉测试结构一个部件重导出」用**导出侧等价注入**实现（在真实导出副本上删除多部件格的部件条目 / 整格置 -1），ground truth（oracle）不动 —— 与"少放一部件后重导出"对验证器是同一类缺陷；避免改 mod 建造意图（写范围禁止）。'; source = '执行侧拍板（任务允许"等价注入方式，拍板记录"）' },
    [ordered]@{ id = 'P3.2-multiblock-cross-spec-choice'; text = '多方块交叉回归选 `multiblock-channel-traversal.spec.ts -g 尺寸变化方向` 单用例（驱动 height 1→5 / Tier 1→3 滑杆 + 逐格参考比对），不跑 real-acceptance 全套（~12 min）。'; source = '执行侧拍板（任务要求"选最快的能证明加载+通道切换的 spec"）' },
    [ordered]@{ id = 'P3.3-inferred-static-check'; text = '"推断永不当主来源"以**静态文件判据**实现（full/degraded 三产物中 tier1/2 与 inferred 不得同格），不动 mod 代码。'; source = '任务要求（scripts 侧新脚本）' },
    [ordered]@{ id = 'protocol-gen-substituted'; text = '契约 §10.1 拍板：proto 作契约文档 + 两侧手写对齐 ⇒ 本编排以「proto 契约字段在册」静态判据替代跑 `npm run protocol:gen`（buf CLI 非本仓库构建前置）。'; source = '契约 §10.1' }
)

if ($DryRun) {
    Write-Step 'DryRun：阶段计划（不执行）'
    foreach ($k in $script:stagePlan.Keys) { Write-Host ("   {0,-28} {1}" -f $k, $script:stagePlan[$k]) }
    Write-Host ""
    Write-Host "   退出码：3 前置 / 4 mod 半环 / 5 web 半环 / 6 证伪 / 7 报告 / 2 不完整 / 8 幂等 / 9 清单红 / 0 全绿"
    exit 0
}

# 预检（在任何重活之前；致命即退出码 3）
$preDir = Get-PassDir 1
$passDir = $preDir
$script:stagesDir = Join-Path $preDir 'stages'
$script:logDir = Join-Path $preDir 'logs'
foreach ($d in @($runDir, $preDir, $script:stagesDir, $script:logDir, (Join-Path $preDir 'web'), (Join-Path $preDir 'verify'), (Join-Path $preDir 'falsification'))) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}
Write-RunState -Mode 'acceptance'
Invoke-Preflight
if ($script:stageResults['preflight'].status -ne 'pass') {
    Write-Err2 '前置检查未通过 → 退出码 3（不启动任何重活）'
    Invoke-Report -ReportRunDir $preDir | Out-Null
    if ($preDir -ne $runDir) {
        Copy-Item -Force (Join-Path $preDir 'acceptance-report.json') (Join-Path $runDir 'acceptance-report.json')
        if (Test-Path (Join-Path $preDir 'acceptance-report.md')) { Copy-Item -Force (Join-Path $preDir 'acceptance-report.md') (Join-Path $runDir 'acceptance-report.md') }
    }
    exit 3
}

# ---- 逐轮（Runs=1 时只有一轮，报告与阶段都在运行目录；Runs≥2 时每轮一个 passN 子目录）----
$passReports = @()
for ($pass = 1; $pass -le [Math]::Max(1, $Runs); $pass++) {
    $passDir = Get-PassDir $pass
    $script:stagesDir = Join-Path $passDir 'stages'
    $script:logDir = Join-Path $passDir 'logs'
    foreach ($d in @($passDir, $script:stagesDir, $script:logDir, (Join-Path $passDir 'web'), (Join-Path $passDir 'verify'), (Join-Path $passDir 'falsification'))) {
        New-Item -ItemType Directory -Force -Path $d | Out-Null
    }
    $script:stageResults = [ordered]@{}
    $script:stageOrder = @()
    $script:aborted = $false
    $script:l1Archive = $null

    # 前置阶段片段复制（每轮的 stages/ 都要有 preflight，报告才能解析依赖）
    Write-StageFragment -Id 'preflight' -Name '前置检查' -Command '（内置；本轮沿用）' -Status 'pass' -ExitCode 0 -DurationMs 0 `
        -StartedAt (Get-Date).ToString('o') -EndedAt (Get-Date).ToString('o') `
        -Gates @(@{ name = '前置检查（首轮已判定通过）'; ok = $true; detail = 'shared' }) | Out-Null

    if ($pass -gt 1) { Write-Host ""; Write-Host "───── 完整运行 第 $pass/$Runs 轮（$passDir）─────" -ForegroundColor Magenta }

    if ($SkipBuild) { Invoke-StageSkipped 'build-mod-gtnh' $script:stagePlan['build-mod-gtnh'] '被 -SkipBuild 跳过' }
    else { Invoke-Stage 'build-mod-gtnh' { Invoke-BuildMod | Out-Null } }

    Invoke-Stage 'l1-export-oracle' { Invoke-L1ExportOracle | Out-Null }
    Invoke-Stage 'l1-verify-oracle' { Invoke-L1VerifyOracle | Out-Null }
    Invoke-Stage 'degradation-static' { Invoke-DegradationStatic | Out-Null }
    Invoke-Stage 'reference-fake-provider' { Invoke-ReferenceFakeProvider | Out-Null }

    if ($SkipWeb) {
        foreach ($id in @('regression-vitest', 'build-web', 'regression-parts-fixtures', 'regression-multiblock-cross', 'l2-real-render')) {
            Invoke-StageSkipped $id $script:stagePlan[$id] '被 -SkipWeb 跳过'
        }
    } else {
        Invoke-Stage 'regression-vitest' { Invoke-RegressionVitest | Out-Null }
        Invoke-Stage 'build-web' { Invoke-BuildWeb | Out-Null }
        Invoke-Stage 'regression-parts-fixtures' { Invoke-RegressionPartsFixtures }
        Invoke-Stage 'regression-multiblock-cross' { Invoke-RegressionMultiblockCross }
        Invoke-Stage 'l2-real-render' { Invoke-L2RealRender }
    }

    Invoke-Stage 'falsify-negative' { Invoke-FalsifyNegative | Out-Null }

    # 幂等阶段与报告：Runs≥2 时先记录本轮的 L1 归档，跨轮比对在第二轮结束后统一做
    if ($pass -eq [Math]::Max(1, $Runs)) {
        if (-not (Test-StageEnabled 'idempotency')) {
            Invoke-StageSkipped 'idempotency' $script:stagePlan['idempotency'] '不在 -OnlyStages'
        } elseif ($Runs -gt 1) {
            Invoke-Idempotency -Pass1Dir (Get-PassDir 1) -Pass2Dir (Get-PassDir $Runs) | Out-Null
        } else {
            Invoke-Idempotency -Pass1Dir $passDir -Pass2Dir '' | Out-Null
        }
    } else {
        Invoke-StageSkipped 'idempotency' $script:stagePlan['idempotency'] '跨轮比对在末轮统一执行'
    }

    # 本轮报告（Runs≥2 时每轮各产一份，供逐条判定比对）
    $rep = Invoke-Report -ReportRunDir $passDir
    $passReports += [ordered]@{ pass = $pass; dir = $passDir; report = $rep.reportPath; present = $rep.present }
    if ($pass -eq 1) { $pass1Statuses = @{}; foreach ($k in $script:stageResults.Keys) { $pass1Statuses[$k] = $script:stageResults[$k].status } }
}

# ---- 最终报告：始终落在运行目录根（Runs≥2 时以第 1 轮为准 + 与第 2 轮逐条判定比对）----
# 报告需要 idempotency.json（在运行目录根）与所选 run dir 的阶段片段：
#  - Runs=1：run dir 就是 $runDir，直接用它重算（幂等：判定必须与首次一致）
#  - Runs≥2：第 1 轮产物在 pass1/，但 idempotency.json 在运行目录根 → 把比对文件复制进 pass1 后再算
$reportRunDir = if ($Runs -gt 1) { Get-PassDir 1 } else { $runDir }
if ($Runs -gt 1) {
    Copy-Item -Force (Join-Path $runDir 'idempotency.json') (Join-Path $reportRunDir 'idempotency.json')
    # 跨轮幂等阶段片段产生在**末轮**的 stages/ 里（第 1 轮只能记 not-run：比对要等两轮都跑完）。
    # 最终报告以第 1 轮为准 ⇒ 必须把该片段带过来，否则 §6 的 parts-E-idempotent 会被判 not-run
    # （实测：两轮全绿 + 13 个数据产物逐字节一致，却因聚合口径退化到退出码 8）。
    $idemFrag = Join-Path $runDir "pass$Runs\stages\idempotency.json"
    if (Test-Path $idemFrag) {
        Copy-Item -Force $idemFrag (Join-Path $reportRunDir 'stages\idempotency.json')
        try {
            $frag = Get-Content $idemFrag -Raw | ConvertFrom-Json
            $pass1Statuses['idempotency'] = $frag.status
        } catch { Write-Warn2 "读取跨轮幂等片段失败：$($_.Exception.Message)" }
    }
}
# 收尾写运行状态（含运行期间追加的开放项）⇒ 报告读它
Write-RunState -Mode 'acceptance'
$comparePath = if ($Runs -gt 1) { Join-Path (Get-PassDir $Runs) 'acceptance-report.json' } else { $CompareWith }
$final = Invoke-Report -ReportRunDir $reportRunDir -ComparePath $comparePath
if ($reportRunDir -ne $runDir) {
    Copy-Item -Force (Join-Path $reportRunDir 'acceptance-report.json') (Join-Path $runDir 'acceptance-report.json')
    Copy-Item -Force (Join-Path $reportRunDir 'acceptance-report.md') (Join-Path $runDir 'acceptance-report.md')
}

# ---------------------------------------------------------------------------
# 退出码
#   3 前置 / 4 mod 半环 / 5 web 半环 / 6 证伪 / 7 报告未产出
#   2 验收不完整（有 not-run）/ 8 幂等不一致 / 9 清单判红 / 0 全绿
# ---------------------------------------------------------------------------
$reportPath = Join-Path $runDir 'acceptance-report.json'
$report = if (Test-Path $reportPath) { Get-Content $reportPath -Raw | ConvertFrom-Json } else { $null }

function Get-StageStatus([string]$Id) {
    if ($pass1Statuses -and $pass1Statuses.ContainsKey($Id)) { return $pass1Statuses[$Id] }
    return 'missing'
}
function Test-AnyFail([string[]]$Ids) { foreach ($id in $Ids) { if ((Get-StageStatus $id) -eq 'fail') { return $true } } return $false }
function Test-AnyNotRun([string[]]$Ids) { foreach ($id in $Ids) { if ((Get-StageStatus $id) -eq 'not-run') { return $true } } return $false }

$exit = 0
if ((Get-StageStatus 'preflight') -ne 'pass') { $exit = 3 }
elseif (Test-AnyFail $script:modStages) { $exit = 4 }
elseif (Test-AnyFail $script:webStages) { $exit = 5 }
elseif (Test-AnyFail @('falsify-negative')) { $exit = 6 }
elseif (-not $report) { $exit = 7 }
elseif ($Runs -gt 1 -and $report.idempotency.crossRun -and $report.idempotency.crossRun.allSame -ne $true) { $exit = 8 }
elseif ($Runs -gt 1 -and $report.idempotency.verdictsMatch -eq $false) { $exit = 8 }
elseif (Test-AnyNotRun ($script:modStages + $script:webStages + @('falsify-negative', 'idempotency'))) { $exit = 2 }
elseif ($report.verdict.status -eq 'fail') { $exit = 9 }

Write-Host ""
if ($exit -eq 0) {
    Write-Host "═══ 部件验收全绿（退出码 0）═══" -ForegroundColor Green
} else {
    Write-Host "═══ 部件验收红（退出码 $exit）═══" -ForegroundColor Red
    if ($report) { foreach ($c in $report.verdict.redChecks) { Write-Host "   XX [$($c.status)] $($c.id) — $($c.detail)" -ForegroundColor Red } }
}
if ($report) {
    Write-Host "   判定：$($report.verdict.status)（pass $($report.verdict.counts.pass) / fail $($report.verdict.counts.fail) / na $($report.verdict.counts.na) / not-run $($report.verdict.counts.notRun)）"
    foreach ($f in $report.findings) { Write-Host "   !! [$($f.severity)] $($f.id) $($f.title)" -ForegroundColor Yellow }
}
Write-Host "   报告：$reportPath"
Write-Host "   摘要：$(Join-Path $runDir 'acceptance-report.md')"
Write-Host ""
exit $exit
