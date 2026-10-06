<#
  run-anchor.ps1 的离线行为自检（不起客户端、不碰 HTTP、不碰世界）
  ============================================================================
  用**合成夹具**（fixtures）反复调用 anchor-checks.ps1 的纯检查函数，验证两件事：
    ① 好数据 → 绿（正向口径没写反）；
    ② 坏数据 → 红，且红得**精确**（缺配对/恒绿负对照/缆越过距离门/清单漂移/证据缺失/族名不符）。
  这是「判据与断言不会恒绿」的离线证据；真机轮次由 run-anchor.ps1 承担。

  夹具的产物字节（PNG）是本地合成的真 PNG（真 CRC、24 位真彩），不是随便的假文件——
  主色占比复算必须有真实像素可数才构成证据。

  用法：pwsh -File scripts/control-plane/run-anchor-selftest.ps1
  退出码：0 = 全部符合预期；2 = 有自检项不符（红绿表列出）。
#>
[CmdletBinding()]
param(
    # 夹具根目录（默认 temp 下的 anchor-selftest）
    [string]$WorkRoot = 'D:\Workspace\Lightning\temp\control-plane\anchor-selftest',
    # 归档根（断言表落盘处）
    [string]$ArchiveRoot = 'D:\Workspace\Lightning\temp\control-plane'
)

$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

. (Join-Path $PSScriptRoot 'anchor-checks.ps1')

# 合成 PNG 的最小实现（与 run-anchor.ps1 的 Write-ProbePng 同一手法；自检脚本自带一份，
# 免得为了拿一个写图函数去 dot-source 整个驱动脚本——那会立刻执行驱动逻辑）。
function Add-Be32([System.Collections.Generic.List[byte]]$L, [uint32]$V) {
    $L.Add([byte](($V -shr 24) -band 0xFF)); $L.Add([byte](($V -shr 16) -band 0xFF))
    $L.Add([byte](($V -shr 8) -band 0xFF)); $L.Add([byte]($V -band 0xFF))
}
$script:crcTable = $null
function Get-Crc32([byte[]]$Data) {
    if ($null -eq $script:crcTable) {
        $t = New-Object int64[] 256
        for ($n = 0; $n -lt 256; $n++) {
            $c = [int64]$n
            for ($k = 0; $k -lt 8; $k++) {
                if (($c -band 1) -ne 0) { $c = [int64]3988292384 -bxor ($c -shr 1) } else { $c = $c -shr 1 }
            }
            $t[$n] = $c
        }
        $script:crcTable = $t
    }
    $crc = [int64]4294967295
    foreach ($b in $Data) {
        $idx = [int](($crc -bxor [int64]$b) -band [int64]255)
        $crc = ($script:crcTable[$idx] -bxor ($crc -shr 8)) -band [int64]4294967295
    }
    return [uint32](($crc -bxor [int64]4294967295) -band [int64]4294967295)
}
function Write-Png {
    param([string]$Path, [int]$Width, [int]$Height, [int]$TopCount = -1, [bool]$Interlaced = $false)
    $total = $Width * $Height
    if ($TopCount -lt 0 -or $TopCount -gt $total) { $TopCount = $total }
    $stride = $Width * 3
    $raw = New-Object byte[] (($stride + 1) * $Height)
    $off = 0; $idx = 0
    for ($y = 0; $y -lt $Height; $y++) {
        $raw[$off] = 0; $off++
        for ($x = 0; $x -lt $Width; $x++) {
            if ($idx -lt $TopCount) { $raw[$off] = 20; $raw[$off + 1] = 40; $raw[$off + 2] = 60 }
            else { $raw[$off] = 200; $raw[$off + 1] = 210; $raw[$off + 2] = 230 }
            $off += 3; $idx++
        }
    }
    $ms = New-Object System.IO.MemoryStream
    $ds = New-Object System.IO.Compression.DeflateStream($ms, [System.IO.Compression.CompressionMode]::Compress, $true)
    $ds.Write($raw, 0, $raw.Length); $ds.Dispose()
    $deflated = $ms.ToArray(); $ms.Dispose()
    $z = New-Object System.Collections.Generic.List[byte]
    $z.Add([byte]0x78); $z.Add([byte]0x01)
    foreach ($b in $deflated) { $z.Add($b) }
    $a = 1; $b = 0
    foreach ($v in $raw) { $a = ($a + [int]$v) % 65521; $b = ($b + $a) % 65521 }
    $adler = [int64]$b * 65536 + [int64]$a
    $z.Add([byte](($adler -shr 24) -band 255)); $z.Add([byte](($adler -shr 16) -band 255))
    $z.Add([byte](($adler -shr 8) -band 255)); $z.Add([byte]($adler -band 255))

    $out = New-Object System.Collections.Generic.List[byte]
    foreach ($b in @(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)) { $out.Add([byte]$b) }
    $chunk = {
        param([string]$Type, [byte[]]$Data)
        $body = New-Object System.Collections.Generic.List[byte]
        foreach ($b in [System.Text.Encoding]::ASCII.GetBytes($Type)) { $body.Add($b) }
        foreach ($b in $Data) { $body.Add($b) }
        Add-Be32 $out ([uint32]$Data.Length)
        foreach ($b in $body) { $out.Add($b) }
        Add-Be32 $out (Get-Crc32 $body.ToArray())
    }
    $ihdr = New-Object System.Collections.Generic.List[byte]
    Add-Be32 $ihdr ([uint32]$Width); Add-Be32 $ihdr ([uint32]$Height)
    $ihdr.Add([byte]8); $ihdr.Add([byte]2); $ihdr.Add([byte]0); $ihdr.Add([byte]0)
    $ihdr.Add([byte]$(if ($Interlaced) { 1 } else { 0 }))
    & $chunk 'IHDR' $ihdr.ToArray()
    & $chunk 'IDAT' $z.ToArray()
    & $chunk 'IEND' (New-Object byte[] 0)
    [System.IO.File]::WriteAllBytes($Path, $out.ToArray())
}

# ---------------------------------------------------------------------------
# 夹具构造
# ---------------------------------------------------------------------------
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$root = Join-Path $WorkRoot $ts
$archiveDir = Join-Path $ArchiveRoot "selftest-$ts"
Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $root, $archiveDir | Out-Null

$results = New-Object System.Collections.ArrayList
function Check([string]$Name, [bool]$Ok, [string]$Detail) {
    [void]$results.Add([pscustomobject]@{ name = $Name; ok = $Ok; detail = $Detail })
    $mark = if ($Ok) { 'PASS' } else { 'FAIL' }
    $color = if ($Ok) { 'Green' } else { 'Red' }
    Write-Host ("   [{0}] {1,-46} {2}" -f $mark, $Name, $Detail) -ForegroundColor $color
}
# 期望某检查在给定数据上「绿 / 红」
function Expect([string]$Name, $Result, [bool]$WantOk) {
    $ok = ([bool]$Result.ok) -eq $WantOk
    $want = if ($WantOk) { '绿' } else { '红' }
    Check "$Name（期望$want）" $ok ("实际 ok={0}；{1}" -f [bool]$Result.ok, [string]$Result.detail)
}

function New-RunDir([string]$Name, $CriteriaJson) {
    $d = Join-Path $root $Name
    New-Item -ItemType Directory -Force -Path (Join-Path $d 'shots'), (Join-Path $d 'world') | Out-Null
    $CriteriaJson | Set-Content -Path (Join-Path $d 'criteria.json') -Encoding utf8NoBOM
    return $d
}

# 判据桶：LP 好数据 / AE2 好数据 / AE2 坏门（far 仍非纯色）
$lpCriteriaGood = @'
{ "schema": "lightning.cp-criteria/1", "overall": "green",
  "criteria": [
    {"id":"te-x1-iso-north","type":"te-state-equals","verdict":"green","detail":"ok"},
    {"id":"te-x2-pair-east","type":"te-state-equals","verdict":"green","detail":"ok"},
    {"id":"img-x1-not-uniform","type":"image-not-uniform","verdict":"green","detail":"ok"},
    {"id":"img-x2-not-uniform","type":"image-not-uniform","verdict":"green","detail":"ok"},
    {"id":"world-hash","type":"world-hash-equals","verdict":"green","detail":"ok"}
  ] }
'@
$ae2CriteriaGood = @'
{ "schema": "lightning.cp-criteria/1", "overall": "green",
  "criteria": [
    {"id":"img-host-not-uniform-near","type":"image-not-uniform","verdict":"green","detail":"ok"},
    {"id":"img-host-not-uniform-ortho","type":"image-not-uniform","verdict":"green","detail":"ok"},
    {"id":"img-gate-size-far","type":"image-size-equals","verdict":"green","detail":"ok"},
    {"id":"img-gate-uniform-far","type":"image-uniform","verdict":"green","detail":"ok"},
    {"id":"img-nb-not-uniform-near","type":"image-not-uniform","verdict":"green","detail":"ok"},
    {"id":"world-hash","type":"world-hash-equals","verdict":"green","detail":"ok"}
  ] }
'@
$ae2CriteriaGateBroken = @'
{ "schema": "lightning.cp-criteria/1", "overall": "red",
  "criteria": [
    {"id":"img-host-not-uniform-near","type":"image-not-uniform","verdict":"green","detail":"ok"},
    {"id":"img-host-not-uniform-ortho","type":"image-not-uniform","verdict":"green","detail":"ok"},
    {"id":"img-gate-size-far","type":"image-size-equals","verdict":"green","detail":"ok"},
    {"id":"img-gate-uniform-far","type":"image-uniform","verdict":"red","detail":"图像不够纯色（缆没被门剔除）"},
    {"id":"world-hash","type":"world-hash-equals","verdict":"green","detail":"ok"}
  ] }
'@
# 变体桶：精确命中 / 恒绿（目标没红）/ 误红（别的判据也红了）
$variantPrecise = '{"overall":"green","criteria":[{"id":"te-x1-iso-north","verdict":"red"},{"id":"img-x1-not-uniform","verdict":"green"},{"id":"world-hash","verdict":"green"}]}'
$variantStuck = '{"overall":"green","criteria":[{"id":"te-x1-iso-north","verdict":"green"},{"id":"img-x1-not-uniform","verdict":"green"}]}'
$variantCollateral = '{"overall":"red","criteria":[{"id":"te-x1-iso-north","verdict":"red"},{"id":"img-x1-not-uniform","verdict":"red"}]}'

$lpRun1 = New-RunDir 'lp-run1' $lpCriteriaGood
$lpRun2 = New-RunDir 'lp-run2' $lpCriteriaGood
$ae2Run = New-RunDir 'ae2-run' $ae2CriteriaGood
$ae2RunBroken = New-RunDir 'ae2-run-broken' $ae2CriteriaGateBroken

# 图像：near/ortho 有结构（ratio 0.8），far 近纯色（ratio 0.97）；broken 的 far 也有结构（0.8）
Write-Png -Path (Join-Path $ae2Run 'shots\near.png') -Width 64 -Height 48 -TopCount 614
Write-Png -Path (Join-Path $ae2Run 'shots\ortho-top.png') -Width 64 -Height 48 -TopCount 614
Write-Png -Path (Join-Path $ae2Run 'shots\far.png') -Width 64 -Height 48 -TopCount 92
Write-Png -Path (Join-Path $ae2RunBroken 'shots\near.png') -Width 64 -Height 48 -TopCount 614
Write-Png -Path (Join-Path $ae2RunBroken 'shots\ortho-top.png') -Width 64 -Height 48 -TopCount 614
Write-Png -Path (Join-Path $ae2RunBroken 'shots\far.png') -Width 64 -Height 48 -TopCount 614

# 清单（幂等）+ 证据 + 观测
$manifestSha = 'abc123def456'
$manifestJson = @{ schema = 'lightning.cp-scene/1'; folder = 'cp_lp_pipe_row'; sha256 = $manifestSha } | ConvertTo-Json -Compress
$manifestJson | Set-Content -Path (Join-Path $lpRun1 'world\scene-manifest.json') -Encoding utf8NoBOM
$manifestJson | Set-Content -Path (Join-Path $lpRun2 'world\scene-manifest.json') -Encoding utf8NoBOM

$evidence = '{"schema":"lightning.cp-evidence/1","overall":"green","expect":[{"path":"observation.json","role":"observation"},{"path":"shots/near.png","role":"shot"}]}'
$evidence | Set-Content -Path (Join-Path $ae2Run 'evidence.json') -Encoding utf8NoBOM
'{"schema":"lightning.cp-evidence/1","overall":"red","expect":[{"path":"observation.json"},{"path":"shots/absent.png"}]}' |
    Set-Content -Path (Join-Path $ae2RunBroken 'evidence.json') -Encoding utf8NoBOM
'{}' | Set-Content -Path (Join-Path $ae2Run 'observation.json') -Encoding utf8NoBOM

$obsGood = @'
{ "schema":"lightning.observation/1",
  "runtimeReads": [
    {"key":"world.sceneManifest","summary":"x","sha256":"aaaa"},
    {"key":"te.ae2-part[64,12,64].state","summary":"x","sha256":"bbbb"},
    {"key":"te.ae2-part[65,12,64].state","summary":"x","sha256":"cccc"}
  ],
  "observation": { "cameras": [
    {"name":"near","pos":[70.5,15.5,69.5],"projection":{"type":"perspective"},"resolution":[1280,720]},
    {"name":"ortho-top","pos":[65.0,18.0,64.0],"projection":{"type":"ortho"},"resolution":[1280,720]},
    {"name":"far","pos":[105.5,13.5,64.5],"projection":{"type":"perspective"},"resolution":[1280,720]}
  ] } }
'@
$obsNoTe = '{"runtimeReads":[{"key":"world.sceneManifest","summary":"x","sha256":"aaaa"}],"observation":{"cameras":[]}}'
$obsEmptySha = '{"runtimeReads":[{"key":"te.ae2-part[64,12,64].state","summary":"x","sha256":""}],"observation":{"cameras":[]}}'
$obsCamShort = '{"runtimeReads":[{"key":"te.ae2-part[64,12,64].state","summary":"x","sha256":"bbbb"}],"observation":{"cameras":[{"name":"near","pos":[1,2,3],"projection":{"type":"perspective"},"resolution":[640,480]}]}}'

$ae2Cameras = @(
    [pscustomobject]@{ name = 'near'; width = 1280; height = 720 },
    [pscustomobject]@{ name = 'ortho-top'; width = 1280; height = 720 },
    [pscustomobject]@{ name = 'far'; width = 1280; height = 720 })

# 用例文档（C2 夹具）
$caseGood = @{ criteria = @(
        @{ id = 'te-x1-iso-north'; type = 'te-state-equals' },
        @{ id = 'img-x1-not-uniform'; type = 'image-not-uniform' },
        @{ id = 'img-x1-size'; type = 'image-size-equals' }) }
$caseUnpaired = @{ criteria = @(
        @{ id = 'te-y9-abc'; type = 'te-state-equals' },
        @{ id = 'img-x1-not-uniform'; type = 'image-not-uniform' }) }
$caseBadId = @{ criteria = @(
        @{ id = 'connx1'; type = 'te-state-equals' },
        @{ id = 'img-x1-not-uniform'; type = 'image-not-uniform' }) }
$caseNoTe = @{ criteria = @(
        @{ id = 'img-x1-not-uniform'; type = 'image-not-uniform' }) }

# ---------------------------------------------------------------------------
# 逐项自检
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "== [CP-ANCHOR-SELFTEST] 离线行为自检（$ts）" -ForegroundColor Cyan

Write-Host "-- C2 双轨齐备静态检查" -ForegroundColor DarkCyan
Expect 'C2 配对达标'            (Test-AnchorPairing $caseGood) $true
Expect 'C2 缺图像配对'          (Test-AnchorPairing $caseUnpaired) $false
Expect 'C2 id 命名不合约定'      (Test-AnchorPairing $caseBadId) $false
Expect 'C2 无 te-state 判据'    (Test-AnchorPairing $caseNoTe) $false
Expect 'C2 文档为空'            (Test-AnchorPairing $null) $false

Write-Host "-- C3 负对照精确命中" -ForegroundColor DarkCyan
$docPrecise = $variantPrecise | ConvertFrom-Json
$docStuck = $variantStuck | ConvertFrom-Json
$docCollat = $variantCollateral | ConvertFrom-Json
Expect 'C3 精确命中'            (Test-VariantPrecision $docPrecise @('te-x1-iso-north')) $true
Expect 'C3 目标恒绿（假绿）'     (Test-VariantPrecision $docStuck @('te-x1-iso-north')) $false
Expect 'C3 误伤其它判据'        (Test-VariantPrecision $docCollat @('te-x1-iso-north')) $false
Expect 'C3 criteria 缺失'       (Test-VariantPrecision $null @('te-x1-iso-north')) $false

Write-Host "-- C4 K1 门控（判据面）" -ForegroundColor DarkCyan
Expect 'C4 门内 non-uniform + 门外 uniform' (Test-GateCriteria ($ae2CriteriaGood | ConvertFrom-Json) $ae2Run) $true
Expect 'C4 缆越过距离门（far 非纯色）'        (Test-GateCriteria ($ae2CriteriaGateBroken | ConvertFrom-Json) $ae2RunBroken) $false
Expect 'C4 run 目录为空'                    (Test-GateCriteria ($ae2CriteriaGood | ConvertFrom-Json) '') $false

Write-Host "-- C4 K1 门控（独立复算）" -ForegroundColor DarkCyan
Expect 'C4 复算 far 近纯色'      (Test-GateUniformRecompute $ae2Run 'shots/far.png' 0.95) $true
Expect 'C4 复算 far 有结构'      (Test-GateUniformRecompute $ae2RunBroken 'shots/far.png' 0.95) $false
Expect 'C4 复算图缺失'          (Test-GateUniformRecompute $ae2Run 'shots/absent.png' 0.95) $false
Expect 'C4 复算隔行 PNG 不猜'     (Test-GateUniformRecompute $(New-RunDir 'interlaced' '{}' ) 'shots/far.png' 0.95) $false
# 隔行图单列：确认复算器对「不支持的特性」返回 null 而不是编一个数
$ilDir = Join-Path $root 'interlaced'; New-Item -ItemType Directory -Force -Path (Join-Path $ilDir 'shots') | Out-Null
Write-Png -Path (Join-Path $ilDir 'shots\far.png') -Width 16 -Height 16 -TopCount -1 -Interlaced $true
Check 'C4 复算器: 隔行 PNG → $null' ($null -eq (Get-PngDominantColorRatio (Join-Path $ilDir 'shots\far.png'))) `
    '非 8 位非隔行范围之外的 PNG 返回 $null（判据自证，不猜）'

Write-Host "-- C5 幂等清单哈希" -ForegroundColor DarkCyan
Expect 'C5 两次 sha256 相等'      (Test-IdempotentManifest $manifestSha $manifestSha) $true
Expect 'C5 两次 sha256 漂移'      (Test-IdempotentManifest $manifestSha 'zzz999') $false
Expect 'C5 sha256 缺失'          (Test-IdempotentManifest '' $manifestSha) $false

Write-Host "-- C6 证据齐全" -ForegroundColor DarkCyan
$evGood = Get-Content (Join-Path $ae2Run 'evidence.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$evBad = Get-Content (Join-Path $ae2RunBroken 'evidence.json') -Raw -Encoding UTF8 | ConvertFrom-Json
Expect 'C6 overall green 且证据在场' (Test-EvidenceComplete $ae2Run $evGood @($ae2Cameras[0])) $true
Expect 'C6 overall red'            (Test-EvidenceComplete $ae2RunBroken $evBad @($ae2Cameras[0])) $false
Expect 'C6 evidence.json 缺失'      (Test-EvidenceComplete $ae2Run $null @($ae2Cameras[0])) $false

Write-Host "-- C7 观测记录" -ForegroundColor DarkCyan
$obsDocGood = $obsGood | ConvertFrom-Json
Expect 'C7 te.ae2-part 读数齐'    (Test-ObservationTeReads $obsDocGood 'te.ae2-part[') $true
Expect 'C7 无 te 族名条目'        (Test-ObservationTeReads ($obsNoTe | ConvertFrom-Json) 'te.ae2-part[') $false
Expect 'C7 族名逐字不符（lp 前缀）' (Test-ObservationTeReads $obsDocGood 'te.lp-pipe[') $false
Expect 'C7 sha256 为空'          (Test-ObservationTeReads ($obsEmptySha | ConvertFrom-Json) 'te.ae2-part[') $false
Expect 'C7 cameras 摘要齐'        (Test-ObservationCameras $obsDocGood $ae2Cameras) $true
Expect 'C7 cameras 尺寸不符'      (Test-ObservationCameras ($obsCamShort | ConvertFrom-Json) $ae2Cameras) $false

# ---------------------------------------------------------------------------
# 归档 + 红绿表
# ---------------------------------------------------------------------------
$failed = @($results | Where-Object { -not $_.ok })
$lines = New-Object System.Collections.ArrayList
[void]$lines.Add("# run-anchor 离线自检 $ts")
[void]$lines.Add('')
[void]$lines.Add("- 夹具根: ``$root``")
[void]$lines.Add("- 自检项: $($results.Count) 条，红 $($failed.Count) 条")
[void]$lines.Add('')
[void]$lines.Add('| 自检项 | 结果 | 说明 |')
[void]$lines.Add('|---|---|---|')
foreach ($r in $results) { [void]$lines.Add("| $($r.name) | $(if ($r.ok) { 'PASS' } else { 'FAIL' }) | $($r.detail -replace '\|', '\|') |") }
[void]($lines | Set-Content -Path (Join-Path $archiveDir 'summary.md') -Encoding utf8NoBOM)
[void]($results | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $archiveDir 'assertions.json') -Encoding utf8NoBOM)

Write-Host ""
Write-Host "   归档: $archiveDir"
Write-Host ("   总计: {0} 条自检，{1} 红" -f $results.Count, $failed.Count)
if ($failed.Count -gt 0) {
    Write-Host "== [CP-ANCHOR-SELFTEST] 有 $($failed.Count) 条自检不符（退出码 2）" -ForegroundColor Red
    exit 2
}
Write-Host "== [CP-ANCHOR-SELFTEST] 离线自检全部符合预期（退出码 0）" -ForegroundColor Green
exit 0
