# 因子化编码器离线驱动（零 MC 启动：直接 JVM 跑 MultiblockFactorizeTool）
#
#   pwsh -File scripts/multiblock-encode/factorize.ps1 -Dataset <run-NNNN 目录> -OutDir <输出目录> [-Control]
#
# 前提：`mod/gtnh/gradlew.bat compileJava` 已通过（本脚本不编译，只运行）。
param(
  [Parameter(Mandatory = $true)][string]$Dataset,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [switch]$Control,
  [string]$Only = ""
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = (Resolve-Path (Join-Path $here "..\..")).Path
$classes = Join-Path $repo "mod\gtnh\build\classes\java\main"
if (-not (Test-Path $classes)) { throw "未找到编译产物：$classes（先跑 gradlew compileJava）" }
$gsonHome = if ($env:GRADLE_USER_HOME) { $env:GRADLE_USER_HOME } else { Join-Path $env:USERPROFILE ".gradle" }
$gson = Get-ChildItem (Join-Path $gsonHome "caches\modules-2\files-2.1\com.google.code.gson\gson") -Recurse -Filter "gson-2*.jar" -ErrorAction SilentlyContinue |
  Sort-Object { [version]($_.Name -replace '^gson-|\.jar$', '') } | Select-Object -First 1
if (-not $gson) { throw "找不到 gson jar（$gsonHome\caches\...）" }
$cp = "$classes;$($gson.FullName)"
$toolArgs = @($Dataset, $OutDir)
if ($Only) { $toolArgs += "--only=$Only" }
if ($Control) { $toolArgs += "--control" }
Write-Host "[factorize] cp=$cp"
& java -cp $cp com.lightning.mod.client.multiblock.MultiblockFactorizeTool @toolArgs
exit $LASTEXITCODE
