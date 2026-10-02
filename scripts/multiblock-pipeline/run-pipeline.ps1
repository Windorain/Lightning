<#
  T1.6 游戏内自动导出管线 —— 外层编排（留白 #8 的 npm script / 外壳脚本半环）
  ============================================================================
  一条命令跑完：前置检查 → 写触发文件 → gradlew runClientSdePipeline（注入
  -Dfml.queryResult=confirm）→ 读结构化结果 → 归档产物 → 以管线的退出码退出。

  用法（全部零人工交互）：
    # 默认验收子集（风险 7 裁决：EBF/DT/BBF/QFT/AdvEBF），产物归档到 .out/<label>/
    pwsh -File scripts/multiblock-pipeline/run-pipeline.ps1 -Label idem-run-1

    # 指定子集
    pwsh -File scripts/multiblock-pipeline/run-pipeline.ps1 -Label subset -Scope MTEElectricBlastFurnace,MTEDistillationTower

    # 故意失败（不存在的机器名）—— 退出码必须非零且原因落盘
    pwsh -File scripts/multiblock-pipeline/run-pipeline.ps1 -Label fail-demo -Scope MTENoSuchMachineT16

    # 全量（风险 7：默认配置 ≈ 32 h，需用户裁定；脚本只做时长守卫，不阻止）
    pwsh -File scripts/multiblock-pipeline/run-pipeline.ps1 -Label full -All

  退出码：0 = 全绿；2 = 导出报告有失败；3 = 管线级致命（前置检查/进世界/超时/报告缺失）；
          4 = 外层编排自身失败（gradle 未产出结果文件）。
#>
[CmdletBinding()]
param(
    # 范围（simpleName / fqcn / slug，逗号或空格分隔）。为空且未给 -All 时用管线默认验收子集。
    [string[]]$Scope = @(),
    # 全量导出（风险 7：需用户裁定后的终验才用）
    [switch]$All,
    # /sde multiblock limit=N（分片用）
    [int]$Limit = -1,
    # 本次运行的标签（用于归档目录名与结果文件 label）
    [string]$Label = "",
    # 展开形态校验文件：每台额外抽的随机组合数
    [int]$ExpandedRandomSamples = 5,
    # 关闭展开形态校验文件（非验收形态，仅调试）
    [switch]$NoExpanded,
    # 专用干净世界存档目录名（留白 #7）
    [string]$World = "sde_pipeline_world",
    # 客户端进程总超时（分钟）—— 超时视为管线致命（杀进程后报 3）
    [int]$ProcessTimeoutMinutes = 120,
    # 只做前置检查与触发文件写入，不启动客户端（干跑）
    [switch]$DryRun,
    # 不归档产物
    [switch]$NoArchive
)

$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
$modDir = Join-Path $repoRoot 'mod\gtnh'
$mcDataDir = Join-Path $modDir 'run\client'
$outDirName = 'sde_multiblock_exports'
$outDir = Join-Path $mcDataDir $outDirName
$archiveRoot = Join-Path $scriptDir '.out'

if ([string]::IsNullOrWhiteSpace($Label)) {
    $Label = 'run-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
}
$logDir = Join-Path $archiveRoot $Label
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'gradle-runClient.log'

function Write-Step([string]$msg) { Write-Host "== [T1.6] $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host "   OK  $msg" -ForegroundColor Green }
function Write-Warn2([string]$msg) { Write-Host "   !!  $msg" -ForegroundColor Yellow }
function Write-Err2([string]$msg) { Write-Host "   XX  $msg" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# ① 前置检查（必须在进程启动前：CoFH 卡死是「启动阶段静默挂住」，事后无法诊断）
# ---------------------------------------------------------------------------
Write-Step "前置检查"

$gradlew = Join-Path $modDir 'gradlew.bat'
if (-not (Test-Path $gradlew)) { Write-Err2 "找不到 $gradlew"; exit 4 }
Write-Ok "gradlew: $gradlew"

# CoFH MCP conf（T0.3 §4.4(1)）：判据是「目录里真有 .srg」，只建空目录同样会让 CoFH 走进弹框分支
$confRoots = @()
if ($env:USERPROFILE) { $confRoots += (Join-Path $env:USERPROFILE '.gradle') }
if ($env:GRADLE_USER_HOME) { $confRoots += $env:GRADLE_USER_HOME }
$confHits = @()
$confEmpties = @()
foreach ($root in $confRoots) {
    $forgeDir = Join-Path $root 'caches\minecraft\net\minecraftforge\forge'
    if (-not (Test-Path $forgeDir)) { continue }
    Get-ChildItem $forgeDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $conf = Join-Path $_.FullName 'unpacked\conf'
        if (-not (Test-Path $conf)) { return }
        $srg = Get-ChildItem $conf -Filter '*.srg' -File -ErrorAction SilentlyContinue
        if ($srg) { $confHits += $conf } else { $confEmpties += $conf }
    }
}
if ($confHits.Count -eq 0) {
    Write-Err2 "CoFH MCP conf 前置检查失败：候选目录里没有含 .srg 的 conf（查过 $($confRoots -join '; ')；$($confEmpties.Count) 个目录存在但无 .srg）"
    Write-Err2 "处置：在 %USERPROFILE%\.gradle 下建目录联接 -> <GRADLE_USER_HOME>\caches\minecraft\net\minecraftforge\forge\1.7.10-10.13.4.1614-1.7.10\unpacked"
    Write-Err2 "不修的话 CoFH ASM 会弹 Swing 目录选择框，客户端在启动阶段静默挂住且日志无输出（T0.3 §4.4(1)）。"
    exit 3
}
Write-Ok "CoFH conf: $($confHits[0])"

# T1.2 事实层（枚举 machines.json）—— 没有它导出无法开始（T1.5 的硬依赖）
$scanRoot = Join-Path $mcDataDir 'multiblock_scan'
$facts = @()
if (Test-Path $scanRoot) {
    $facts = Get-ChildItem $scanRoot -Directory -Filter 'run-*' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName 'machines.json' } |
        Where-Object { Test-Path $_ }
}
if ($facts.Count -eq 0) {
    Write-Err2 "找不到 T1.2 的 multiblock_scan/run-*/machines.json（枚举事实层缺失，导出无法开始）"
    Write-Err2 "先跑一次 T1.2 扫描（触发文件 sde_multiblock_scan.json + runClient）再跑本管线。"
    exit 3
}
Write-Ok "T1.2 事实层: $($facts[0])"

# 陈旧的 T1.5 触发文件会让本轮语义含糊：移开（保留证据，不删除）
$staleT15 = Join-Path $mcDataDir 'sde_multiblock.json'
if (Test-Path $staleT15) {
    $moved = "$staleT15.stale-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Move-Item -Force $staleT15 $moved
    Write-Warn2 "发现陈旧的 T1.5 触发文件，已移开: $moved"
}

# 陈旧结果文件必须清掉：否则「读不到本轮结果」会退化成读到上一轮结果
$resultPath = Join-Path $mcDataDir 'sde_multiblock_pipeline_result.json'
if (Test-Path $resultPath) { Remove-Item -Force $resultPath; Write-Ok "已清除上一轮结果文件" }

# 产物目录复位 —— **幂等（自检 1）的关键前提**，实测依据：
# T1.5 产物内层 `multiblock.notes[0].text` 会写「数据来源：run-NNNN/machines/<slug>.json」，
# 而 run-NNNN 由 VariantCaptureRunner 扫 `_dataset/run-*` 取 max+1 自增；不复位则
# 「同一世界 + 同一范围」两次运行的产物**必然**不同（20222 字节里只差那一个 run 号），
# 逐字节幂等判据就永远不成立。复位方式 = 先保全上一轮（归档到 .out/_prev-<label>/exports）再清空，
# 新目录由 T1.5 自己重建 → 每轮都是 `_dataset/run-0001` → notes 稳定 → 产物逐字节可复现。
# 代价：失去 T1.3 内部的「与上一次运行的签名自动比对」；管线层的两次运行哈希比对是更强的替代。
if (Test-Path $outDir) {
    if (-not $NoArchive) {
        $prevDir = Join-Path $archiveRoot ('_prev-' + $Label + '\exports')
        if (Test-Path $prevDir) { Remove-Item -Recurse -Force $prevDir }
        New-Item -ItemType Directory -Force -Path $prevDir | Out-Null
        Get-ChildItem $outDir -Force | ForEach-Object { Copy-Item -Recurse -Force $_.FullName $prevDir }
        Write-Ok "上一轮产物已保全到 $prevDir"
    } else {
        Write-Warn2 "-NoArchive：上一轮产物目录将被直接删除（不复位就没有逐字节幂等判据）"
    }
    Remove-Item -Recurse -Force $outDir
    Write-Ok "产物目录已复位（清空后由 T1.5 重建，保证 _dataset/run-0001）: $outDir"
}

# ---------------------------------------------------------------------------
# ② 写触发文件
# ---------------------------------------------------------------------------
Write-Step "写触发文件"

$scopeList = @()
foreach ($s in $Scope) {
    foreach ($p in ($s -split '[,\s]+')) { if ($p.Trim() -ne '') { $scopeList += $p.Trim() } }
}

$trigger = [ordered]@{
    schema         = 'lightning.multiblock.pipeline.trigger/1'
    label          = $Label
    requestedBy    = 'scripts/multiblock-pipeline/run-pipeline.ps1'
    world          = $World
    worldDisplay   = 'SDE Pipeline World'
    cleanupTrigger = $true
    expanded       = [ordered]@{
        enabled       = (-not $NoExpanded)
        randomSamples = $ExpandedRandomSamples
    }
    scopeNote      = 'scope 省略 = 管线默认验收子集（风险 7 裁决）；"all" = 全量（需用户裁定）'
}
if ($All) {
    $trigger['scope'] = @('all')
} elseif ($scopeList.Count -gt 0) {
    $trigger['scope'] = $scopeList
}
if ($Limit -gt 0) { $trigger['limit'] = $Limit }

$triggerPath = Join-Path $mcDataDir 'sde_multiblock_pipeline.json'
$json = $trigger | ConvertTo-Json -Depth 6
Set-Content -Path $triggerPath -Value $json -Encoding utf8NoBOM
Write-Ok "触发文件: $triggerPath"
Write-Host ($json -split "`n" | ForEach-Object { "      $_" }) -Separator "`n"

if ($DryRun) {
    Write-Step "DryRun：前置检查与触发文件已就绪，不启动客户端"
    exit 0
}

# ---------------------------------------------------------------------------
# ③ 启动客户端（gradle task 注入 -Dfml.queryResult=confirm）
# ---------------------------------------------------------------------------
Write-Step "启动客户端（gradlew runClientSdePipeline，超时 ${ProcessTimeoutMinutes} min）"
Write-Host "   日志: $logFile"

$started = Get-Date
$proc = Start-Process -FilePath $gradlew `
    -ArgumentList @('runClientSdePipeline', '--console=plain', '-q') `
    -WorkingDirectory $modDir -NoNewWindow -PassThru `
    -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"

$timedOut = $false
try {
    Wait-Process -Id $proc.Id -Timeout ($ProcessTimeoutMinutes * 60) -ErrorAction Stop
} catch {
    $timedOut = $true
    Write-Err2 "客户端进程超时（${ProcessTimeoutMinutes} min），杀掉整棵进程树"
    & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null
}
$elapsed = (Get-Date) - $started
$gradleExit = $proc.ExitCode
Write-Ok ("客户端进程结束：exitCode={0}，耗时 {1:n1} min" -f $gradleExit, $elapsed.TotalMinutes)

# ---------------------------------------------------------------------------
# ④ 读结构化结果
# ---------------------------------------------------------------------------
Write-Step "读结构化结果"

if (-not (Test-Path $resultPath)) {
    Write-Err2 "管线没有产出结果文件: $resultPath"
    if ($timedOut) { Write-Err2 "原因：外层进程超时被强杀（见日志尾部）" }
    Write-Host "   日志尾部:" -ForegroundColor DarkGray
    if (Test-Path $logFile) { Get-Content $logFile -Tail 40 | ForEach-Object { "      $_" } }
    exit 4
}

$result = Get-Content $resultPath -Raw | ConvertFrom-Json
Write-Ok "status=$($result.status) exitCode=$($result.exitCode) label=$($result.label)"

# ---------------------------------------------------------------------------
# ⑤ 归档产物
# ---------------------------------------------------------------------------
if (-not $NoArchive -and (Test-Path $outDir)) {
    Write-Step "归档产物"
    $dst = Join-Path $logDir 'exports'
    if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    Get-ChildItem $outDir -Force | Where-Object { $_.Name -ne 'latest-pipeline-result.json' } | ForEach-Object {
        Copy-Item -Recurse -Force $_.FullName $dst
    }
    Copy-Item -Force $resultPath (Join-Path $logDir 'pipeline-result.json') -ErrorAction SilentlyContinue
    Write-Ok "归档: $dst"
}

# ---------------------------------------------------------------------------
# ⑥ 汇总
# ---------------------------------------------------------------------------
Write-Step "汇总"
Write-Host ("   status        : {0}" -f $result.status)
Write-Host ("   exitCode      : {0}" -f $result.exitCode)
Write-Host ("   范围          : {0}" -f (($result.scope.requested) -join ', '))
Write-Host ("   世界          : {0} ({1})" -f $result.environment.world.folder, $result.environment.world.action)
Write-Host ("   产物          : {0} 份" -f $result.products.Count)
Write-Host ("   失败          : {0} 条（pipeline 级 {1} 条）" -f $result.failureCount, @($result.failures | Where-Object { $_.stage -like 'pipeline*' }).Count)
Write-Host ("   警告          : {0} 条" -f @($result.warnings).Count)
Write-Host ("   总耗时        : {0:n1} min（进世界 {1:n1} min）" -f ($result.timing.totalMs / 60000.0), ($result.timing.joinWorldMs / 60000.0))
if ($result.exportReport) {
    Write-Host ("   导出报告      : {0}" -f $result.exportReport.status)
    Write-Host ("   变体级告警分列: {0}" -f (($result.variantWarnings.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ', '))
}
if ($result.expanded) {
    Write-Host ("   展开校验文件  : {0} 台 / {1} 组合 / {2} 文件" -f $result.expanded.machines, $result.expanded.samples, $result.expanded.files)
    Write-Host ("   抽样清单      : {0}" -f $result.expanded.manifest)
}
Write-Host "   产物哈希（前 6 条）:"
$result.products | Select-Object -First 6 | ForEach-Object { Write-Host ("      {0}  {1}  {2}" -f $_.sha256.Substring(0, [Math]::Min(16, $_.sha256.Length)), $_.bytes, $_.file) }
if ($result.failures.Count -gt 0) {
    Write-Host "   失败清单（前 8 条）:"
    $result.failures | Select-Object -First 8 | ForEach-Object { Write-Host ("      [{0}] {1} / {2}: {3}" -f $_.stage, $_.machine, $_.kind, $_.message) }
}

Write-Host ""
if ($result.exitCode -eq 0) {
    Write-Host "== [T1.6] 全绿（退出码 0）" -ForegroundColor Green
} else {
    Write-Host "== [T1.6] 非零退出（退出码 $($result.exitCode)）：原因见结果文件 failures[] 与 $logFile" -ForegroundColor Red
}
exit [int]$result.exitCode
