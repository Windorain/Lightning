<#
  Gitea issue #56 端到端验证回路：palette NBT 挂载的 gson 兼容性（真实 /sde export 链路）
  ======================================================================================
  一条命令跑完：前置检查 → 清陈旧产物 → 写 lightning.cfg（autoLoad）与指令文件
  sde_automation_commands.txt → gradlew runClientSdePipeline（独占资源）→ 通用指令自动化
  进首个存档（预置 sde_lp_te_probe_world 副本）→ tp/setblock 建场景（熔炉 + 2 石头）
  → /sde pos1|pos2|record|export raw → 客户端烘焙 → 进程退出后核对产物与日志 → 归档。

  场景选择依据（复现必要条件，见 issue 评论「执行计划」）：
  - 熔炉 TileEntityFurnace.writeToNBT 恒写 Items 等键 ⇒ 扫描档 cellTypes 必带 tileNbtB64；
  - 熔炉是烘焙模型、必出 quads ⇒ 必进终态 blockPalette ⇒ 必命中 palette NBT 挂载分支
    （MeshCaptureService.java:676 JsonParser.parseString，gson 2.2.4 ⇒ NoSuchMethodError）。

  两种模式（同一场景，唯一差别是工作树代码）：
    -Mode fixoff  基线（修复前）：预期导出中止——产物停留 geometryPhase=scan、
                  日志出现 NoSuchMethodError。兼作验收负对照（修复无运行时开关）。
    -Mode fixon   修复后：同一世界同一场景连导两次（A/B 幂等哈希对），预期
                  geometryPhase=baked、palette 熔炉条目 nbt 字段挂上、A/B SHA-256 相同。

  用法：
    pwsh -File scripts/issue-56/run-export-check.ps1 -Mode fixoff -Label fixoff-1
    pwsh -File scripts/issue-56/run-export-check.ps1 -Mode fixon  -Label fixon-1

  退出码：0 = 客户端进程正常结束且本轮产物齐（不断言修复对错，判读在调度者）；
          4 = 编排自身失败（前置检查/无产物）；5 = 客户端进程被超时强杀。
#>
[CmdletBinding()]
param(
    [ValidateSet('fixoff', 'fixon')]
    [string]$Mode = 'fixoff',
    [string]$Label = '',
    [int]$ProcessTimeoutMinutes = 15
)

$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
$modDir = Join-Path $repoRoot 'mod\gtnh'
$mcDataDir = Join-Path $modDir 'run\client'
$gradlew = Join-Path $modDir 'gradlew.bat'
$tempRoot = (Resolve-Path (Join-Path $repoRoot '..\..\..\temp')).Path
$sceneDir = Join-Path $tempRoot 'Scene\issue-56'

if ([string]::IsNullOrWhiteSpace($Label)) {
    $Label = "$Mode-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
}
$outDir = Join-Path $sceneDir $Label
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$logFile = Join-Path $outDir 'gradle-runClient.log'

# 场景坐标（远离既有 LP 管道 64..68,12,64；选区 5×1×3 含 熔炉+2石头）。
# 注意：/sde pos1|pos2 取「玩家脚下方块」，且两条指令间隔 20 tick —— tp 到空中会在
# 等待期内自由落体（fixoff-1 实测玩家从 y=11/13 落到 y=4，选区扫成空气层）。
# 因此场景与 pos 全部放在超平坦地表站立层 y=4（草方块 y=3 之上一格），玩家零落差。
$exportNames = if ($Mode -eq 'fixon') { @('issue56-fixon-a', 'issue56-fixon-b') } else { @('issue56-fixoff') }

function Step([string]$m) { Write-Host "== [issue-56/$Mode] $m" -ForegroundColor Cyan }
function Ok([string]$m) { Write-Host "   OK  $m" -ForegroundColor Green }
function Err2([string]$m) { Write-Host "   XX  $m" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# ① 前置检查
# ---------------------------------------------------------------------------
Step "前置检查"

if (-not (Test-Path $gradlew)) { Err2 "找不到 gradlew: $gradlew"; exit 4 }
if (-not (Test-Path (Join-Path $modDir 'gradle\wrapper\gradle-wrapper.jar'))) { Err2 "缺 gradle-wrapper.jar"; exit 4 }
Ok "gradlew: $gradlew"

$worldDir = Join-Path $mcDataDir 'saves\sde_lp_te_probe_world'
if (-not (Test-Path (Join-Path $worldDir 'level.dat'))) {
    Err2 "预置世界不存在: $worldDir（从 bug-fix 树复制 sde_lp_te_probe_world 后重试）"
    exit 4
}
Ok "预置世界: $worldDir"

# 陈旧产物必须清掉，否则「读不到本轮产物」会退化成读到上一轮
$exportDir = Join-Path $mcDataDir 'structure_exports'
foreach ($n in $exportNames) {
    $stale = Join-Path $exportDir "$n.json"
    if (Test-Path $stale) { Remove-Item -Force $stale; Ok "已清除陈旧产物: $n.json" }
}
$cmdPath = Join-Path $mcDataDir 'sde_automation_commands.txt'
if (Test-Path $cmdPath) { Remove-Item -Force $cmdPath }

# 独占资源检查：同一时间只允许「本工作树」的 runClient
$running = Get-Process java -ErrorAction SilentlyContinue | Where-Object {
    $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
    $cl -and ($cl -match 'GradleStart') -and ($cl -match [regex]::Escape($modDir))
}
if ($running) {
    Err2 "本工作树已有 runClient 在跑（独占资源）：PID $(($running.Id) -join ', ')"
    exit 4
}
Ok "本工作树没有其它 runClient 在跑"

# runClient 的 -x processResources 假定资源已处理过（与 scripts/issue-12 同口径：
# processResources dependsOn syncWeb，而 syncWeb 需要 web/node_modules，故排除）。
# 新树 build/resources 为空时 mixin 配置缺失会启动即挂（MixinInitialisationError），
# 这里补一次「只拷资源、不跑 syncWeb」的 processResources。
$mixinsCfg = Join-Path $modDir 'build\resources\main\mixins.lightning.json'
if (-not (Test-Path $mixinsCfg)) {
    Step "首次补资源处理（processResources -x syncWeb）"
    Push-Location $modDir
    try {
        & $gradlew 'processResources' '-x' 'syncWeb' '--console=plain' 2>&1 |
            Out-File -FilePath (Join-Path $outDir 'processResources.log') -Encoding utf8
        $prcExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($prcExit -ne 0 -or -not (Test-Path $mixinsCfg)) {
        Err2 "processResources 失败（日志 $outDir\processResources.log）"
        exit 4
    }
    Ok "资源已处理: $mixinsCfg"
}

# ---------------------------------------------------------------------------
# ② 写配置 + 指令文件
# ---------------------------------------------------------------------------
Step "写 lightning.cfg 与指令文件"

$cfgDir = Join-Path $mcDataDir 'config'
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
$cfgPath = Join-Path $cfgDir 'lightning.cfg'
$cfgBody = @"
# Configuration file

automation {
    B:autoLoadFirstSingleplayerWorld=true
    S:automationCommandFile=sde_automation_commands.txt
    B:cleanupCommandFileAfterRun=true
    I:commandDelayTicks=20
    B:exitGameAfterCommands=true
}
"@
if (Test-Path $cfgPath) {
    $cur = Get-Content $cfgPath -Raw
    if ($cur -match 'autoLoadFirstSingleplayerWorld=true') {
        Ok "lightning.cfg 已启用 autoLoad（不覆写）"
    } else {
        $cur = $cur -replace 'B:autoLoadFirstSingleplayerWorld=\w+', 'B:autoLoadFirstSingleplayerWorld=true'
        Set-Content -Path $cfgPath -Value $cur -Encoding utf8NoBOM
        Ok "lightning.cfg 已就地把 autoLoad 置 true"
    }
} else {
    Set-Content -Path $cfgPath -Value $cfgBody -Encoding utf8NoBOM
    Ok "lightning.cfg 已写入"
}

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('/tp @p 96 5 72')
$lines.Add('/say issue56 scene-build begin')
$lines.Add('/setblock 95 4 64 minecraft:stone 0')
$lines.Add('/setblock 96 4 64 minecraft:furnace 2')
$lines.Add('/setblock 97 4 64 minecraft:stone 0')
$lines.Add('/tp @p 94 4 63')
$lines.Add('/sde pos1')
$lines.Add('/tp @p 98 4 65')
$lines.Add('/sde pos2')
foreach ($n in $exportNames) {
    $lines.Add("/sde setname $n")
    $lines.Add('/sde record')
    $lines.Add('/tp @p 96 5 72')
    $lines.Add('/sde export raw')
    # 导出后客户端烘焙是异步的（网络包 → tick 队列）；队列排空即 shutdown，
    # 必须用填充指令把进程留住，给烘焙/崩溃留足时间窗
    for ($i = 1; $i -le 40; $i++) { $lines.Add("/say bake-wait $n $i") }
}
$lines.Add('/say issue56 run end')
Set-Content -Path $cmdPath -Value $lines -Encoding utf8NoBOM
Ok "指令文件: $cmdPath（$(($lines.Count)) 行）"

# ---------------------------------------------------------------------------
# ③ 启动客户端
# ---------------------------------------------------------------------------
Step "启动客户端（gradlew runClientSdePipeline，超时 ${ProcessTimeoutMinutes} min）"
Write-Host "   完整日志: $logFile"

$gradleArgs = @('runClientSdePipeline', '-x', 'syncWeb', '-x', 'processResources', '--console=plain')
$started = Get-Date
$proc = Start-Process -FilePath $gradlew -ArgumentList $gradleArgs `
    -WorkingDirectory $modDir -NoNewWindow -PassThru `
    -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"
$timedOut = $false
try {
    Wait-Process -Id $proc.Id -Timeout ($ProcessTimeoutMinutes * 60) -ErrorAction Stop
} catch {
    $timedOut = $true
    Err2 "客户端进程超时（${ProcessTimeoutMinutes} min），杀掉整棵进程树"
    & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null
}
$elapsed = (Get-Date) - $started
Ok ("客户端进程结束：exitCode={0}，耗时 {1:n1} min" -f $proc.ExitCode, $elapsed.TotalMinutes)

# ---------------------------------------------------------------------------
# ④ 摘日志 + 归档产物
# ---------------------------------------------------------------------------
Step "摘日志与归档"

$fmlLog = Join-Path $mcDataDir 'logs\fml-client-latest.log'
if (Test-Path $fmlLog) {
    Copy-Item -Force $fmlLog (Join-Path $outDir 'fml-client-latest.log')
    $sdeLines = Select-String -Path $fmlLog -Pattern '\[SDE' | ForEach-Object { $_.Line }
    $sdeLines | Set-Content -Path (Join-Path $outDir 'sde-lines.log') -Encoding utf8NoBOM
    Ok "[SDE] 行 $($sdeLines.Count) 行"
    $nsme = Select-String -Path $fmlLog -Pattern 'NoSuchMethodError' -SimpleMatch
    Ok ("NoSuchMethodError 命中 {0} 处" -f @($nsme).Count)
} else {
    Err2 "缺 FML 日志: $fmlLog"
}

$found = 0
foreach ($n in $exportNames) {
    $art = Join-Path $exportDir "$n.json"
    if (Test-Path $art) {
        $found++
        $dest = Join-Path $outDir "$n.json"
        Copy-Item -Force $art $dest
        $hash = (Get-FileHash $dest -Algorithm SHA256).Hash.ToLower()
        $phase = (Select-String -Path $dest -Pattern '"geometryPhase":\s*"(\w+)"' | Select-Object -First 1).Matches.Groups[1].Value
        Ok ("产物 {0}.json：phase={1} sha256={2} bytes={3}" -f $n, $phase, $hash, (Get-Item $dest).Length)
    } else {
        Err2 "缺产物: $n.json"
    }
}

$crashDir = Join-Path $mcDataDir 'crash-reports'
if (Test-Path $crashDir) {
    Get-ChildItem $crashDir -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -ge $started } | ForEach-Object {
        Copy-Item -Force $_.FullName (Join-Path $outDir $_.Name)
        Write-Host "   !! 新崩溃报告归档: $($_.Name)" -ForegroundColor Yellow
    }
}

if ($timedOut) { exit 5 }
if ($found -lt $exportNames.Count) { exit 4 }
Write-Host "== [issue-56/$Mode] 运行完成（归档 $outDir）" -ForegroundColor Green
exit 0
