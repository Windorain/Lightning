<#
  T1.6 半环自检（一条命令跑完计划要求的全部自检项）
  ================================================
  pwsh -File scripts/multiblock-pipeline/selfcheck.ps1

  自检 1｜幂等：连续两次无人值守导出（默认子集），产物与展开校验文件逐字节一致（SHA-256 清单比对）
  自检 2｜失败可诊断：故意请求不存在的机器名 → 退出码非零 + 原因落盘
  自检 3｜闭环：展开形态校验文件 vs 产物经 lib.mjs 装配结果**逐格 diff = 0**，且抽样清单覆盖策略可机器核对
  自检 4｜耗时：两次运行各自的总耗时/进世界耗时/导出耗时（供 Phase 3 编排预算）

  退出码：0 = 四项全过；1 = 有自检项失败。
#>
[CmdletBinding()]
param(
    [int]$ProcessTimeoutMinutes = 120,
    # 复用已有归档（跳过真实客户端运行）—— 只跑离线校验
    [switch]$OfflineOnly,
    [string]$Idem1Label = 't16-idem-1',
    [string]$Idem2Label = 't16-idem-2',
    [string]$FailLabel = 't16-fail-demo',
    # 故意失败用的机器名（必须不在 T1.2 枚举里）
    [string]$FailMachine = 'MTENoSuchMachineT16'
)

$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
$archiveRoot = Join-Path $scriptDir '.out'
$runner = Join-Path $scriptDir 'run-pipeline.ps1'

$checks = [ordered]@{}
function Record([string]$name, [bool]$ok, [string]$detail) {
    $checks[$name] = [ordered]@{ ok = $ok; detail = $detail }
    if ($ok) { Write-Host "  [PASS] $name —— $detail" -ForegroundColor Green }
    else { Write-Host "  [FAIL] $name —— $detail" -ForegroundColor Red }
}

Write-Host ''
Write-Host '================================================================================' -ForegroundColor Cyan
Write-Host ' T1.6 半环自检：游戏内自动导出管线' -ForegroundColor Cyan
Write-Host '================================================================================' -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# 自检 1 前置：两次无人值守导出
# ---------------------------------------------------------------------------
if (-not $OfflineOnly) {
    Write-Host ''
    Write-Host '[自检 1] 第一次无人值守导出…' -ForegroundColor Cyan
    & pwsh -NoProfile -File $runner -Label $Idem1Label -ProcessTimeoutMinutes $ProcessTimeoutMinutes
    $r1 = $LASTEXITCODE
    Write-Host "  第一次退出码: $r1"
    if ($r1 -ne 0) { Record '自检1-run1' $false "第一次导出退出码 $r1（应为 0）" } else { Record '自检1-run1' $true '第一次导出退出码 0' }

    Write-Host ''
    Write-Host '[自检 1] 第二次无人值守导出…' -ForegroundColor Cyan
    & pwsh -NoProfile -File $runner -Label $Idem2Label -ProcessTimeoutMinutes $ProcessTimeoutMinutes
    $r2 = $LASTEXITCODE
    Write-Host "  第二次退出码: $r2"
    if ($r2 -ne 0) { Record '自检1-run2' $false "第二次导出退出码 $r2（应为 0）" } else { Record '自检1-run2' $true '第二次导出退出码 0' }

    # -----------------------------------------------------------------------
    # 自检 2：故意失败
    # -----------------------------------------------------------------------
    Write-Host ''
    Write-Host "[自检 2] 故意失败（请求不存在的机器名 $FailMachine）…" -ForegroundColor Cyan
    & pwsh -NoProfile -File $runner -Label $FailLabel -Scope $FailMachine -ProcessTimeoutMinutes $ProcessTimeoutMinutes
    $r3 = $LASTEXITCODE
    Write-Host "  退出码: $r3（必须非零）"
    $failResult = Join-Path $archiveRoot "$FailLabel\pipeline-result.json"
    if ($r3 -eq 0) {
        Record '自检2-退出码' $false '故意失败却退出码 0'
    } elseif (-not (Test-Path $failResult)) {
        Record '自检2-退出码' $false "退出码 $r3 但结果文件未归档（原因没有落盘）"
    } else {
        $fr = Get-Content $failResult -Raw | ConvertFrom-Json
        $unknown = @($fr.failures | Where-Object { $_.kind -eq 'UnknownMachine' })
        if ($unknown.Count -ge 1) {
            Record '自检2-退出码' $true "退出码 $r3，原因落盘：$($unknown[0].machine) / $($unknown[0].kind) / $($unknown[0].message)"
        } else {
            Record '自检2-退出码' $false "退出码 $r3，但 failures[] 里没有 UnknownMachine（原因不可诊断）"
        }
    }
} else {
    Write-Host '  [跳过] 真实客户端运行（-OfflineOnly）' -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# 自检 1 判定：哈希清单比对
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '[自检 1] 产物逐字节一致性…' -ForegroundColor Cyan
$res1 = Join-Path $archiveRoot "$Idem1Label\pipeline-result.json"
$res2 = Join-Path $archiveRoot "$Idem2Label\pipeline-result.json"
if ((Test-Path $res1) -and (Test-Path $res2)) {
    $cmpOut = & node (Join-Path $scriptDir 'compare-runs.mjs') $res1 $res2
    $cmpCode = $LASTEXITCODE
    $cmpOut | ForEach-Object { Write-Host $_ }
    Record '自检1-字节一致' ($cmpCode -eq 0) "compare-runs.mjs 退出码 $cmpCode"
} else {
    Record '自检1-字节一致' $false "缺结果文件：$res1 / $res2"
}

# ---------------------------------------------------------------------------
# 自检 3：展开 vs 装配逐格 diff
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '[自检 3] 展开形态校验文件 vs 产物经 lib.mjs 装配逐格 diff…' -ForegroundColor Cyan
$exports = Join-Path $archiveRoot "$Idem2Label\exports"
if (-not (Test-Path $exports)) { $exports = Join-Path $archiveRoot "$Idem1Label\exports" }
if (Test-Path $exports) {
    $vOut = & node (Join-Path $scriptDir 'verify-expanded.mjs') $exports
    $vCode = $LASTEXITCODE
    $vOut | ForEach-Object { Write-Host $_ }
    Record '自检3-逐格diff' ($vCode -eq 0) "verify-expanded.mjs 退出码 $vCode（产物目录 $exports）"
} else {
    Record '自检3-逐格diff' $false "找不到归档产物目录: $exports"
}

# ---------------------------------------------------------------------------
# 自检 4：耗时记录
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '[自检 4] 两次运行耗时…' -ForegroundColor Cyan
$timing = @()
foreach ($p in @($res1, $res2)) {
    if (Test-Path $p) {
        $r = Get-Content $p -Raw | ConvertFrom-Json
        $expSec = if ($r.timing.exportReport) { [math]::Round($r.timing.exportReport.totalMs / 1000.0, 1) } else { -1 }
        $capSec = if ($r.timing.captureTotals) { [math]::Round($r.timing.captureTotals.elapsedMs / 1000.0, 1) } else { -1 }
        $timing += [ordered]@{
            label        = $r.label
            status       = $r.status
            exitCode     = $r.exitCode
            totalSec     = [math]::Round($r.timing.totalMs / 1000.0, 1)
            joinWorldSec = [math]::Round($r.timing.joinWorldMs / 1000.0, 1)
            exportSec    = $expSec
            captureSec   = $capSec
            products     = @($r.products).Count
            variants     = $r.variantsTested
        }
        Write-Host ("  {0}: 总 {1} s = 进世界 {2} s + 导出 {3} s（捕获 {4} s）；产物 {5} 份 / 变体 {6}；status={7} exitCode={8}" -f `
                $r.label, [math]::Round($r.timing.totalMs / 1000.0, 1), [math]::Round($r.timing.joinWorldMs / 1000.0, 1), `
                $expSec, $capSec, @($r.products).Count, $r.variantsTested, $r.status, $r.exitCode)
    }
}
Record '自检4-耗时记录' ($timing.Count -ge 1) "记录了 $($timing.Count) 次运行的耗时（见 selfcheck-report.json）"

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
$bad = @($checks.GetEnumerator() | Where-Object { -not $_.Value.ok })
$report = [ordered]@{
    tool      = 'scripts/multiblock-pipeline/selfcheck.ps1 (T1.6)'
    ranAt     = (Get-Date).ToString('o')
    checks    = $checks
    timing    = $timing
    archive   = $archiveRoot
    allPassed = ($bad.Count -eq 0)
}
$reportPath = Join-Path $archiveRoot 'selfcheck-report.json'
New-Item -ItemType Directory -Force -Path $archiveRoot | Out-Null
Set-Content -Path $reportPath -Value ($report | ConvertTo-Json -Depth 8) -Encoding utf8NoBOM

Write-Host ''
Write-Host '================================================================================' -ForegroundColor Cyan
if ($bad.Count -eq 0) {
    Write-Host ' T1.6 半环自检：全部通过' -ForegroundColor Green
} else {
    Write-Host " T1.6 半环自检：$($bad.Count) 项未通过" -ForegroundColor Red
    foreach ($b in $bad) { Write-Host "   - $($b.Key): $($b.Value.detail)" -ForegroundColor Red }
}
Write-Host " 报告: $reportPath" -ForegroundColor Cyan
Write-Host '================================================================================' -ForegroundColor Cyan
exit ($(if ($bad.Count -eq 0) { 0 } else { 1 }))
