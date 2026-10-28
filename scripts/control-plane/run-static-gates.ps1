<#
  run-static-gates.ps1 —— mod 级静态门禁的本地执行入口（不需要客户端、不需要游戏）
  ============================================================================
  解决的问题：gsonCompatCheck（用**运行期实载的** gson 版本重编译 src/main/java 整树，
  把「编译期 API 版本 ≠ 运行期 API 版本」这类事故拦在编译期）是这类问题的唯一防线，
  但它的执行面长期只存在于「知道该敲哪条命令的人脑子里」——门禁存在、没有执行面，
  等于没有门禁。本脚本把它做成一条可重复、可粘贴取证的命令。

  用法：
    # ① 在仓库根调用（推荐；脚本路径相对仓库根）
    pwsh -NoProfile -File scripts/control-plane/run-static-gates.ps1
    # ② 在任意 cwd 调用：必须给脚本绝对路径（脚本内部一律以 $PSScriptRoot 解析仓库根，
    #    cwd 在哪里都不影响它定位仓库）
    pwsh -NoProfile -File <仓库根>/scripts/control-plane/run-static-gates.ps1
    # 可选参数
    pwsh -NoProfile -File scripts/control-plane/run-static-gates.ps1 -SkipSpotless
    pwsh -NoProfile -File scripts/control-plane/run-static-gates.ps1 -TimeoutMinutes 45
    # 根目录 npm 别名（等价于 ①）
    npm run gates:mod-static

  跑什么：
    1. gsonCompatCheck   —— 硬门禁，始终跑。用 build.gradle.kts 里钉死的运行期 gson 版本
                           重编译全部 main 源码；2.8+ 独有 API 直接编译报错。
    2. spotlessJavaCheck —— 格式门禁，-SkipSpotless 可跳过（跳过的结果如实记 n/a，不伪装成绿）。

  判定口径（关键——「没红」不等于「跑过」）：
    每条门禁必须**正向**出现自己的任务标记才算有结论：
      > Task :<门禁>                → PASS（本次真执行）
      > Task :<门禁> UP-TO-DATE     → PASS（接受：输入未变，沿用上次成功结果；要「真编译」证据
                                     就删掉对应输出目录再跑，见 README §5）
      > Task :<门禁> FROM-CACHE     → PASS（构建缓存命中，未重编译；同上）
      > Task :<门禁> FAILED         → FAIL（门禁红，退出码 1）
      > Task :<门禁> SKIPPED / NO-SOURCE，或该行压根没出现 → NOT RUN（退出码 2）
    只要有一条 NOT RUN，整体退出码就是 2、并且绝不打印 VERDICT=PASS——「配置期就失败」
    「被 -x 排除」「源集为空」这几种情形长得都像「没有 FAILED」，只靠这一条判绿会假绿。

  刻意不做的（每条都有理由，别顺手加）：
    - 不跑 build：build 会连带 processResources → syncWeb → npm 构建，与静态门禁要验的
      东西无关，只会把「验一行代码」变成「先装好 node 依赖」；
    - 不起客户端、不发 HTTP、不碰世界：所以它**不是**验收轮次，不能替代验收轮次；
    - 不另写判据实现：gson 兼容性判据只有一个实现（Gradle 任务 gsonCompatCheck），
      本脚本只做调用、取证与失败分类，绝不复制一份等价检查。

  与既有入口的关系（不重复）：scripts/acceptance/run-acceptance.ps1 是整闭环验收
  （起客户端 + 导出 + playwright，以小时计），scripts/control-plane 的实机驱动脚本要连着
  在跑的客户端；本目录另有离线判据自检，但它们验判据、不验产品源码。改一行 control-plane
  代码真正需要的是几十秒级的静态验证，却被绑在这两个
  重入口上，结果就是不验。本脚本是同一个 Gradle 任务的轻量调用面，用于合流前复核。

  退出码：
    0 全绿（每条门禁都有正向结论）；
    1 门禁红（有任务 FAILED，且没有 NOT RUN）；
    2 编排/证据失败（NOT RUN、超时、gradle 非零但归不到具体门禁、版本漂移、采不到结果）。
#>
[CmdletBinding()]
param(
    # 跳过格式门禁（gsonCompatCheck 始终跑）
    [switch]$SkipSpotless,
    # 整体超时（分钟）：gradle 卡住时宁可报 2，也不要让人在合流前干等
    [int]$TimeoutMinutes = 30,
    # 日志根目录（默认落在仓内被 .gitignore 忽略的 .out 下）
    [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
$modDir = Join-Path $repoRoot 'mod\gtnh'
if ([string]::IsNullOrWhiteSpace($OutDir)) { $OutDir = Join-Path $scriptDir '.out\static-gates' }

function Write-Gate([string]$Text) { Write-Host ('[static-gates] ' + $Text) }

function Exit-Orchestration([string]$Message) {
    Write-Gate ('ERROR: ' + $Message)
    exit 2
}

# 取某个任务在日志里出现的全部状态后缀（空串 = 真执行；未出现 = 空数组）
function Get-TaskStates([string]$Text, [string]$Task) {
    $pattern = '(?m)^> Task :' + [regex]::Escape($Task) + '[ \t]*(?<state>[A-Za-z-]*)[ \t]*\r?$'
    $states = New-Object System.Collections.Generic.List[string]
    foreach ($m in [regex]::Matches($Text, $pattern)) { $states.Add($m.Groups['state'].Value.Trim()) }
    return $states.ToArray()
}

# 失败/未执行时的摘要：摘出编译错误行与环境线索，避免把堆栈当证据
function Write-LogExcerpt([string]$Text, [string[]]$Tasks) {
    Write-Gate '--- 失败摘要（先分类再修：本次回归 / 既有缺陷 / 环境问题）---'
    $taskLinePattern = '^> Task :(' + (($Tasks | ForEach-Object { [regex]::Escape($_) }) -join '|') + ') (FAILED|SKIPPED|NO-SOURCE)'
    $salient = @(
        $Text -split "\r?\n" |
            Where-Object {
                $_ -match '\.java:\d+:' -or
                $_ -match $taskLinePattern -or
                $_ -match 'What went wrong' -or
                $_ -match 'Compilation failed' -or
                $_ -match 'format violations' -or
                $_ -match '个错误' -or
                $_ -match '(?i)JAVA_HOME|java version|Unsupported class file|Cannot locate'
            } |
            Select-Object -Unique |
            Select-Object -First 20
    )
    if ($salient.Count -eq 0) { $salient = @($Text -split "\r?\n" | Where-Object { $_.Trim() -ne '' } | Select-Object -Last 20) }
    foreach ($line in $salient) { Write-Host ('    ' + $line) }
}

# ---------------------------------------------------------------------------
# 前置：定位 gradlew
# ---------------------------------------------------------------------------
$isWindowsHost = $true
if (Get-Variable -Name IsWindows -ErrorAction SilentlyContinue) { $isWindowsHost = [bool]$IsWindows }
$gradlewName = if ($isWindowsHost) { 'gradlew.bat' } else { 'gradlew' }
$gradlew = Join-Path $modDir $gradlewName
if (-not (Test-Path $gradlew)) { Exit-Orchestration ('找不到 ' + $gradlewName + '（' + $modDir + '）') }

# ---------------------------------------------------------------------------
# 取证头：被测版本 + 工作树状态（证据要写清被测 SHA，不能拿旧证据改标新 SHA）
# ---------------------------------------------------------------------------
$sha = (& git -C $repoRoot rev-parse HEAD)
$branch = (& git -C $repoRoot rev-parse --abbrev-ref HEAD)
$dirtyFiles = @(& git -C $repoRoot status --porcelain)
$dirtyCount = @($dirtyFiles | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count
Write-Gate ('repo=' + $repoRoot)
Write-Gate ('sha=' + $sha + ' branch=' + $branch + ' dirty=' + $dirtyCount + ' 项')

# ---------------------------------------------------------------------------
# 门禁前提本身的判据：gsonCompatCheck 校验的版本必须等于运行期实载版本
#   把 build.gradle.kts 的 gsonCompatRuntimeVersion 一改，门禁照样会绿——但它验的已经
#   不是「游戏里能不能跑」了，棘轮悄悄对着错误的目标。前提不成立 = 门禁没跑 = 退出码 2。
# ---------------------------------------------------------------------------
$buildScript = Join-Path $modDir 'build.gradle.kts'
$expectedGson = '2.2.4'
$pin = $null
$pinMatch = Select-String -Path $buildScript -Pattern 'val gsonCompatRuntimeVersion = "([0-9][^"]*)"' | Select-Object -First 1
if ($null -ne $pinMatch) { $pin = $pinMatch.Matches[0].Groups[1].Value }
Write-Gate ('gsonCompatRuntimeVersion=' + $pin + '（build.gradle.kts 固定值；门禁校验的就是这个版本）')
if ($pin -ne $expectedGson) {
    Write-Gate ('NOT RUN: 期望运行期 gson ' + $expectedGson + '，实际钉的是 ' + $pin + '——门禁没有执行')
    Write-Gate '  门禁校验的 API 面已不再等于游戏里实载的 API 面：要么改回来，要么先拿出「运行期确实是这个版本」的实证再改本脚本的期望值。'
    exit 2
}

# ---------------------------------------------------------------------------
# 执行（一次调用跑完所有门禁：同一个 daemon，省一次 JVM 与配置开销）
# ---------------------------------------------------------------------------
$tasks = @('gsonCompatCheck')
if (-not $SkipSpotless) { $tasks += 'spotlessJavaCheck' }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDir = Join-Path $OutDir $stamp
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$logPath = Join-Path $runDir 'static-gates.log'
$errPath = Join-Path $runDir 'static-gates.err.log'

$gradleArgs = @() + $tasks + @('--console=plain')
Write-Gate ('cmd: .\' + $gradlewName + ' ' + ($gradleArgs -join ' ') + '   （工作目录 mod/gtnh）')
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$proc = Start-Process -FilePath $gradlew -ArgumentList $gradleArgs -WorkingDirectory $modDir -RedirectStandardOutput $logPath -RedirectStandardError $errPath -PassThru -NoNewWindow
$timeoutMs = [Math]::Max(1, $TimeoutMinutes) * 60 * 1000
$finished = $proc.WaitForExit($timeoutMs)
$sw.Stop()
if (-not $finished) {
    try { $proc.Kill($true) } catch { }
    Write-Gate ('NOT RUN / TIMEOUT: 超过 ' + $TimeoutMinutes + ' 分钟，已终止 gradle（日志 ' + $logPath + '）')
    exit 2
}
if (-not (Test-Path $logPath)) { Exit-Orchestration ('gradle 没有产出日志，采不到结果（' + $logPath + '）') }
$logText = [System.IO.File]::ReadAllText($logPath)
if (Test-Path $errPath) { $logText = $logText + [Environment]::NewLine + [System.IO.File]::ReadAllText($errPath) }

# ---------------------------------------------------------------------------
# 判定：每条门禁必须正向出现自己的任务标记（口径见脚本头）
# ---------------------------------------------------------------------------
$outcomes = @()
foreach ($task in $tasks) {
    $states = @(Get-TaskStates -Text $logText -Task $task)
    $seen = '（无）'
    if ($states.Count -gt 0) { $seen = (($states | ForEach-Object { if ($_ -eq '') { '执行' } else { $_ } }) -join '/') }
    if ($states -contains 'FAILED') {
        $outcomes += [pscustomobject]@{ Task = $task; State = 'FAIL'; Note = $seen }
        Write-Gate ($task.PadRight(20) + ' FAIL（报告状态：' + $seen + '）')
    } elseif (($states -contains 'SKIPPED') -or ($states -contains 'NO-SOURCE')) {
        $outcomes += [pscustomobject]@{ Task = $task; State = 'NOT RUN'; Note = $seen }
        Write-Gate ($task.PadRight(20) + ' NOT RUN（报告状态：' + $seen + '——门禁没有执行，不能判绿）')
    } elseif (($states -contains '') -or ($states -contains 'UP-TO-DATE') -or ($states -contains 'FROM-CACHE')) {
        if ($states -contains '') {
            $outcomes += [pscustomobject]@{ Task = $task; State = 'PASS'; Note = '本次真执行' }
            Write-Gate ($task.PadRight(20) + ' PASS')
        } elseif ($states -contains 'UP-TO-DATE') {
            $outcomes += [pscustomobject]@{ Task = $task; State = 'PASS'; Note = 'UP-TO-DATE' }
            Write-Gate ($task.PadRight(20) + ' PASS（UP-TO-DATE：输入未变，沿用上次成功结果，本次未重编译）')
        } else {
            $outcomes += [pscustomobject]@{ Task = $task; State = 'PASS'; Note = 'FROM-CACHE' }
            Write-Gate ($task.PadRight(20) + ' PASS（FROM-CACHE：构建缓存命中，未重编译）')
        }
    } else {
        $outcomes += [pscustomobject]@{ Task = $task; State = 'NOT RUN'; Note = '日志里没有该任务标记' }
        Write-Gate ($task.PadRight(20) + ' NOT RUN（日志里没有 > Task :' + $task + ' 标记——门禁没有执行）')
    }
}
if ($SkipSpotless) { Write-Gate ('spotlessJavaCheck'.PadRight(20) + ' n/a（-SkipSpotless：本次未请求该门禁）') }

$notRun = @($outcomes | Where-Object { $_.State -eq 'NOT RUN' })
$failedOutcome = @($outcomes | Where-Object { $_.State -eq 'FAIL' })
$verdict = 'PASS'
if ($notRun.Count -gt 0) { $verdict = 'NOT-RUN' } elseif ($failedOutcome.Count -gt 0) { $verdict = 'FAIL' }
if ($verdict -eq 'PASS' -and $proc.ExitCode -ne 0) {
    $verdict = 'NOT-RUN'
    Write-Gate ('gradle 退出码 ' + $proc.ExitCode + '，但每条门禁都出现了正向标记——归不到具体门禁，按编排/环境失败处理（不是绿）')
}
if ($verdict -ne 'PASS') { Write-LogExcerpt -Text $logText -Tasks $tasks }

if ($logText -match '> Task :gsonCompatCheck FAILED') {
    Write-Gate 'gsonCompatCheck 红：源码用了运行期 gson 没有的 API。兼容写法对照表见 docs/build-guide.md「Gson 运行期兼容」。'
    Write-Gate '  注意：单测（gson 2.8.9 classpath）不会红，只有本门禁能拦住。'
}
if ($logText -match 'format violations') {
    Write-Gate 'spotlessJavaCheck 红：格式化违规。改法是 cd mod/gtnh && ./gradlew spotlessApply，改完重跑本门禁。'
}
if ($verdict -eq 'NOT-RUN') {
    Write-Gate 'NOT RUN 的常见成因：JAVA_HOME/JDK 不可用、gradle 配置期失败、任务被 -x 排除、daemon 异常退出。'
    Write-Gate '  处置：先修环境再重跑；本条**不是**「门禁通过」，不得作为合流证据。'
}

$verdictText = 'NOT-RUN（证据不成立）'
if ($verdict -eq 'PASS') { $verdictText = 'PASS' } elseif ($verdict -eq 'FAIL') { $verdictText = 'FAIL（门禁红）' }
Write-Gate ('VERDICT=' + $verdictText + ' gradle_exit=' + $proc.ExitCode + ' elapsed=' + [Math]::Round($sw.Elapsed.TotalSeconds, 1) + 's log=' + $logPath)
if ($verdict -eq 'PASS') { exit 0 }
if ($verdict -eq 'FAIL') { exit 1 }
exit 2
