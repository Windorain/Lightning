# T1.5 前置：guard（多通道同位置相交）规则生成路径的**闭环自检**（一条命令跑完，零人工）
#
#   pwsh -File scripts/multiblock-encode/verify-guard-overlap.ps1
#
# 步骤：
#   ① 生成合成相交数据集（palette 复用 T1.3 run-0015 的真实调色板，网格由确定性函数生成）
#   ② 离线因子化编码（MultiblockFactorizeTool，与游戏内 /sde multiblock 共用同一个编码器）
#   ③ 闭环验证：编码产物 → lib.mjs 参考装配器 → 与 ground-truth 逐格 diff（退出码 0 = 全绿）
#   ④ 契约校验器（T0.5：格式 + 全组合装配 + 判定式）
#
# 前提：`mod/gtnh/gradlew.bat compileJava` 已通过。
param(
  [string]$Palette = "mod\gtnh\run\client\variant_capture\run-0015\palette.json",
  [string]$OutRoot = "scripts\multiblock-encode\.out"
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = (Resolve-Path (Join-Path $here "..\..")).Path
Set-Location $repo

$dataset = Join-Path $OutRoot "synth-overlap"
$encoded = Join-Path $OutRoot "synth-overlap-encoded"

Write-Host "== ① 生成合成相交数据集 =="
node (Join-Path $here "make-synthetic-overlap.mjs") --palette $Palette --out $dataset
if ($LASTEXITCODE -ne 0) { throw "生成合成数据集失败" }

Write-Host "== ② 因子化编码（离线工具，与游戏内共用编码器） =="
pwsh -File (Join-Path $here "factorize.ps1") -Dataset $dataset -OutDir $encoded
if ($LASTEXITCODE -ne 0) { throw "编码失败" }

Write-Host "== ③ 闭环：产物 → lib.mjs 参考装配 → ground-truth 逐格 diff =="
node (Join-Path $here "verify-encoded.mjs") $encoded $dataset
$closed = $LASTEXITCODE

Write-Host "== ④ T0.5 契约校验器 =="
$doc = Join-Path $encoded "synthguardoverlap.multiblock.json"
node (Join-Path $repo "scripts\multiblock-fixtures\validate-multiblock-fixtures.mjs") $doc
$valid = $LASTEXITCODE

Write-Host ""
Write-Host "闭环退出码=$closed  契约校验退出码=$valid"
if ($closed -ne 0 -or $valid -ne 0) { exit 1 }
Write-Host "✅ guard 相交用例全绿"
exit 0
