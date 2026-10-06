<#
  run-anchor.ps1 的纯检查模块（PR-3 锚点验收）
  ============================================================================
  这里只放「读文档 / 比数值 / 判红绿」的纯函数：不碰客户端、不发 HTTP、不改世界。
  抽出来的唯一理由是**可离线自检**——同一份逻辑既能被驱动脚本调用（真机轮次），也能被
  run-anchor-selftest.ps1 用合成夹具（fixtures）反复调用，验证它在坏数据上确实变红。
  （run-smoke.ps1 / run-shots.ps1 的「就地复制而非抽公共」是那两个脚本各自的归档/还原路径耦合
  所致；本模块不含任何归档或进程逻辑，所以不违背那条理由。）

  约定：所有函数返回 [pscustomobject]@{ ok = <bool>; detail = <string> }，
  不自己打印、不自己记断言——打印与断言表由调用方（驱动或自检）负责。
#>

# ---------------------------------------------------------------------------
# PNG 独立复算：主色占比（与 CriteriaEngine/ImageCriteria 的 image-uniform 同口径：
# 众数像素数 / 全图像素数）。刻意**不共用判据实现的代码路径**，只共用口径定义。
#   支持：8 位、非隔行、颜色型 0/2/4/6；其余返回 $null（判据自证，这里不猜）
# ---------------------------------------------------------------------------
function Get-PngDominantColorRatio([string]$Path) {
    if (-not (Test-Path $Path -PathType Leaf)) { return $null }
    try {
        $bytes = [System.IO.File]::ReadAllBytes($Path)
        if ($bytes.Length -lt 8) { return $null }
        if ([System.Text.Encoding]::ASCII.GetString($bytes, 1, 3) -ne 'PNG') { return $null }
        $pos = 8
        $width = 0; $height = 0; $depth = 0; $colorType = 0; $interlace = 0
        $idat = New-Object System.Collections.Generic.List[byte]
        while ($pos + 8 -le $bytes.Length) {
            $len = ([int]$bytes[$pos] -shl 24) + ([int]$bytes[$pos + 1] -shl 16) + ([int]$bytes[$pos + 2] -shl 8) + [int]$bytes[$pos + 3]
            $type = [System.Text.Encoding]::ASCII.GetString($bytes, $pos + 4, 4)
            $dataStart = $pos + 8
            if ($len -lt 0 -or $dataStart + $len -gt $bytes.Length) { return $null }
            if ($type -eq 'IHDR') {
                $width = ([int]$bytes[$dataStart] -shl 24) + ([int]$bytes[$dataStart + 1] -shl 16) + ([int]$bytes[$dataStart + 2] -shl 8) + [int]$bytes[$dataStart + 3]
                $height = ([int]$bytes[$dataStart + 4] -shl 24) + ([int]$bytes[$dataStart + 5] -shl 16) + ([int]$bytes[$dataStart + 6] -shl 8) + [int]$bytes[$dataStart + 7]
                $depth = [int]$bytes[$dataStart + 8]
                $colorType = [int]$bytes[$dataStart + 9]
                $interlace = [int]$bytes[$dataStart + 12]
            } elseif ($type -eq 'IDAT') {
                for ($i = 0; $i -lt $len; $i++) { [void]$idat.Add($bytes[$dataStart + $i]) }
            } elseif ($type -eq 'IEND') {
                break
            }
            $pos = $dataStart + $len + 4
        }
        if ($interlace -ne 0) { return $null }
        if ($depth -ne 8) { return $null }
        $channels = switch ($colorType) { 0 { 1 } 2 { 3 } 4 { 2 } 6 { 4 } default { 0 } }
        if ($channels -eq 0) { return $null }

        $compressed = $idat.ToArray()
        $ms = New-Object System.IO.MemoryStream(, $compressed)
        # PNG 的 IDAT 是 zlib 流：跳过 2 字节头（CMF/FLG）；尾部 adler32 由 DeflateStream 自然忽略
        [void]$ms.Seek(2, [System.IO.SeekOrigin]::Begin)
        $ds = New-Object System.IO.Compression.DeflateStream($ms, [System.IO.Compression.CompressionMode]::Decompress)
        $out = New-Object System.IO.MemoryStream
        try { $ds.CopyTo($out) } finally { $ds.Dispose(); $ms.Dispose() }
        $raw = $out.ToArray()
        $out.Dispose()

        $stride = $width * $channels
        if ($raw.Length -lt ($stride + 1) * $height) { return $null }
        $prev = New-Object byte[] $stride
        $cur = New-Object byte[] $stride
        $counts = @{}
        $total = 0
        $off = 0
        for ($y = 0; $y -lt $height; $y++) {
            $ft = [int]$raw[$off]; $off++
            [Array]::Copy($raw, $off, $cur, 0, $stride); $off += $stride
            for ($i = 0; $i -lt $stride; $i++) {
                $a = if ($i -ge $channels) { [int]$cur[$i - $channels] } else { 0 }
                $b = [int]$prev[$i]
                $c = if ($i -ge $channels) { [int]$prev[$i - $channels] } else { 0 }
                $x = [int]$cur[$i]
                switch ($ft) {
                    0 { }
                    1 { $x = ($x + $a) -band 0xFF }
                    2 { $x = ($x + $b) -band 0xFF }
                    3 { $x = ($x + [int](($a + $b) / 2)) -band 0xFF }
                    4 {
                        $p = $a + $b - $c
                        $pa = [math]::Abs($p - $a); $pb = [math]::Abs($p - $b); $pc = [math]::Abs($p - $c)
                        $pr = if ($pa -le $pb -and $pa -le $pc) { $a } elseif ($pb -le $pc) { $b } else { $c }
                        $x = ($x + $pr) -band 0xFF
                    }
                    default { return $null }
                }
                $cur[$i] = [byte]$x
            }
            for ($x0 = 0; $x0 -lt $width; $x0++) {
                $base = $x0 * $channels
                if ($channels -ge 3) { $key = "$([int]$cur[$base]),$([int]$cur[$base + 1]),$([int]$cur[$base + 2])" }
                else { $key = "$([int]$cur[$base]),$([int]$cur[$base]),$([int]$cur[$base])" }
                if ($counts.ContainsKey($key)) { $counts[$key] = $counts[$key] + 1 } else { $counts[$key] = 1 }
                $total++
            }
            $tmp = $prev; $prev = $cur; $cur = $tmp
        }
        if ($total -le 0) { return $null }
        $max = 0
        foreach ($v in $counts.Values) { if ($v -gt $max) { $max = $v } }
        return [pscustomobject]@{
            ratio    = [double]$max / [double]$total
            pixels   = $total
            colors   = $counts.Count
            topColor = ($counts.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 1).Key
            width    = $width
            height   = $height
        }
    } catch { return $null }
}

# ---------------------------------------------------------------------------
# C2：双轨齐备静态检查（离线）
#   配对口径：判据 id 形态「<轨前缀>-<目标>[-<面|机位>]」，第二段是目标名。
#   每个 te-state-equals 判据（id 以 te- 开头）必须存在至少一个同目标的图像判据
#   （id 以 img- 开头且第二段逐字相同）。
# ---------------------------------------------------------------------------
function Test-AnchorPairing($CaseDoc) {
    $problems = New-Object System.Collections.ArrayList
    if ($null -eq $CaseDoc) { return [pscustomobject]@{ ok = $false; detail = '用例文档为空' } }
    $imgTargets = @{}
    foreach ($c in @($CaseDoc.criteria)) {
        $id = [string]$c.id
        if ($id -match '^img-([a-z0-9]+)(-|$)') { $imgTargets[$Matches[1]] = $true }
    }
    $teCount = 0; $pairs = New-Object System.Collections.ArrayList
    foreach ($c in @($CaseDoc.criteria)) {
        if ([string]$c.type -ne 'te-state-equals') { continue }
        $teCount++
        $id = [string]$c.id
        if ($id -notmatch '^te-([a-z0-9]+)(-|$)') {
            [void]$problems.Add("$id 不以 te-目标 形态开头（id 命名约定，双轨配对靠它）")
            continue
        }
        $target = $Matches[1]
        if (-not $imgTargets.ContainsKey($target)) {
            [void]$problems.Add("$id 的目标 $target 没有配对的图像判据（缺 img-$target-*）")
        } else {
            [void]$pairs.Add($target)
        }
    }
    if ($teCount -eq 0) { [void]$problems.Add('用例里没有 te-state-equals 判据（锚点用例必须两轨齐备）') }
    if ($problems.Count -gt 0) { return [pscustomobject]@{ ok = $false; detail = ($problems -join '; ') } }
    return [pscustomobject]@{ ok = $true; detail = "te 判据 $teCount 条全部有同目标图像判据（配对达标目标: $(($pairs | Sort-Object -Unique) -join ',')）" }
}

# ---------------------------------------------------------------------------
# C3：负对照变体（同一口径：expectCriteriaRed 必须**恰好**变红，其余保持 green）
# ---------------------------------------------------------------------------
function Test-VariantPrecision($CriteriaDoc, [string[]]$ExpectedRed) {
    $red = @($ExpectedRed | ForEach-Object { [string]$_ })
    if ($null -eq $CriteriaDoc) { return [pscustomobject]@{ ok = $false; detail = '变体 run 的 criteria.json 读不到' } }
    $map = @{}
    foreach ($c in @($CriteriaDoc.criteria)) { if ($c.id) { $map[[string]$c.id] = [string]$c.verdict } }
    $notRed = @($red | Where-Object { $map[$_] -ne 'red' } | ForEach-Object { "$_=$($map[$_])" })
    $otherRed = @($map.GetEnumerator() | Where-Object { $red -notcontains $_.Key -and $_.Value -ne 'green' } | ForEach-Object { "$($_.Key)=$($_.Value)" })
    $problems = @()
    if ($notRed.Count -gt 0) { $problems += "expectCriteriaRed 未变红=[$($notRed -join ',')]" }
    if ($otherRed.Count -gt 0) { $problems += "除 expectCriteriaRed 外的非绿=[$($otherRed -join ',')]" }
    if ($problems.Count -gt 0) { return [pscustomobject]@{ ok = $false; detail = ($problems -join '；') } }
    return [pscustomobject]@{ ok = $true; detail = "expectCriteriaRed 精确命中（$($red -join ',') 全红，其余 $($map.Count - $red.Count) 条全绿）" }
}

# ---------------------------------------------------------------------------
# C4（1/2）：K1 门控的判据面——near/ortho 必须 non-uniform+green，far 必须 uniform+green
# ---------------------------------------------------------------------------
function Test-GateCriteria($CriteriaDoc, [string]$RunDir, [string]$NearPng = 'shots/near.png', [string]$OrthoPng = 'shots/ortho-top.png', [string]$FarPng = 'shots/far.png', [string]$NearId = 'img-host-not-uniform-near', [string]$OrthoId = 'img-host-not-uniform-ortho', [string]$FarId = 'img-gate-uniform-far', [string]$FarSizeId = 'img-gate-size-far') {
    $problems = New-Object System.Collections.ArrayList
    if ([string]::IsNullOrWhiteSpace($RunDir) -or $null -eq $CriteriaDoc) {
        return [pscustomobject]@{ ok = $false; detail = 'run 目录或 criteria.json 不可用' }
    }
    $map = @{}
    foreach ($c in @($CriteriaDoc.criteria)) { if ($c.id) { $map[[string]$c.id] = [string]$c.verdict } }
    $readable = @{}
    foreach ($p in @($NearPng, $OrthoPng, $FarPng)) {
        $full = Join-Path $RunDir ($p -replace '/', '\')
        if (-not (Test-Path $full -PathType Leaf)) { $readable[$p] = '缺失' }
        elseif ((Get-Item $full).Length -le 0) { $readable[$p] = '0 字节' }
        else { $readable[$p] = 'ok' }
    }
    foreach ($t in @(@{ png = $NearPng; id = $NearId; want = 'green'; label = 'near(30 格内)' },
            @{ png = $OrthoPng; id = $OrthoId; want = 'green'; label = 'ortho(30 格内)' })) {
        if ($readable[$t.png] -ne 'ok') { [void]$problems.Add("$($t.png) $($readable[$t.png])") }
        if ($map[$t.id] -ne $t.want) { [void]$problems.Add("$($t.id)=$($map[$t.id])（须 $($t.want)）") }
    }
    if ($readable[$FarPng] -ne 'ok') { [void]$problems.Add("$FarPng $($readable[$FarPng])") }
    if ($map[$FarId] -ne 'green') { [void]$problems.Add("$FarId=$($map[$FarId])（须 green）") }
    if ($FarSizeId -and $map[$FarSizeId] -ne 'green') { [void]$problems.Add("$FarSizeId=$($map[$FarSizeId])（须 green）") }
    # 门内对照半边（K1 决定性证据：玩家恒在门内，相机在门内 ⇒ 箱必须渲染；用例声明了该判据才检查）
    [string]$GateNearPng = 'shots/gate-near.png'
    [string]$GateNearId = 'img-gate-not-uniform-near'
    if ($map.ContainsKey($GateNearId)) {
        $gnFull = Join-Path $RunDir ($GateNearPng -replace '/', '\')
        if (-not (Test-Path $gnFull -PathType Leaf)) { [void]$problems.Add("$GateNearPng 缺失") }
        elseif ((Get-Item $gnFull).Length -le 0) { [void]$problems.Add("$GateNearPng 0 字节") }
        if ($map[$GateNearId] -ne 'green') { [void]$problems.Add("$GateNearId=$($map[$GateNearId])（须 green）") }
    }
    if ($problems.Count -gt 0) { return [pscustomobject]@{ ok = $false; detail = ($problems -join '; ') } }
    return [pscustomobject]@{ ok = $true; detail = "$NearPng/$OrthoPng 在门内且 non-uniform=green；$FarPng 在门外且 uniform=green，图均非空" }
}

# ---------------------------------------------------------------------------
# C4（2/2）：独立复算 far.png 主色占比（判据绿而这里红 ⇒ 判据实现可疑）
# ---------------------------------------------------------------------------
function Test-GateUniformRecompute([string]$RunDir, [string]$FarPng = 'shots/far.png', [double]$MinRatio = 0.85) {
    if ([string]::IsNullOrWhiteSpace($RunDir)) { return [pscustomobject]@{ ok = $false; detail = 'run 目录不可用' } }
    $full = Join-Path $RunDir ($FarPng -replace '/', '\')
    $r = Get-PngDominantColorRatio $full
    if ($null -eq $r) {
        return [pscustomobject]@{ ok = $false; detail = "$FarPng 缺失或独立复算器读不出（非 8 位非隔行 PNG，或文件损坏）" }
    }
    $detail = "主色占比={0:N6}（阈值 {1}）主色={2} 颜色数={3} 尺寸={4}x{5}" -f $r.ratio, $MinRatio, $r.topColor, $r.colors, $r.width, $r.height
    if ($r.ratio -lt $MinRatio) { return [pscustomobject]@{ ok = $false; detail = "不足：$detail" } }
    return [pscustomobject]@{ ok = $true; detail = $detail }
}

# ---------------------------------------------------------------------------
# C5：幂等——两次 run 的 scene-manifest sha256 相等
# ---------------------------------------------------------------------------
function Test-IdempotentManifest([string]$Sha1, [string]$Sha2) {
    if ([string]::IsNullOrWhiteSpace($Sha1) -or [string]::IsNullOrWhiteSpace($Sha2)) {
        return [pscustomobject]@{ ok = $false; detail = "清单读不到或缺 sha256：第一次=$Sha1 第二次=$Sha2" }
    }
    if ($Sha1 -ne $Sha2) { return [pscustomobject]@{ ok = $false; detail = "不一致：第一次=$Sha1 第二次=$Sha2" } }
    return [pscustomobject]@{ ok = $true; detail = "相等：$Sha1" }
}

# ---------------------------------------------------------------------------
# C6：证据齐全——evidence.json overall=green 且 expect 逐条在场（另附机位 PNG 必核）
# ---------------------------------------------------------------------------
function Test-EvidenceComplete([string]$RunDir, $EvidenceDoc, $Cameras) {
    if ([string]::IsNullOrWhiteSpace($RunDir)) { return [pscustomobject]@{ ok = $false; detail = 'run 目录不可用' } }
    if ($null -eq $EvidenceDoc) { return [pscustomobject]@{ ok = $false; detail = "run 目录里没有 evidence.json（$RunDir）" } }
    $overall = [string]$EvidenceDoc.overall
    $missing = New-Object System.Collections.ArrayList
    $present = 0
    foreach ($e in @($EvidenceDoc.expect)) {
        $rel = [string]$e.path
        if ([string]::IsNullOrWhiteSpace($rel)) { continue }
        if (Test-Path (Join-Path $RunDir ($rel -replace '/', '\'))) { $present++ } else { [void]$missing.Add($rel) }
    }
    foreach ($cam in @($Cameras)) {
        if ($null -eq $cam) { continue }
        $rel = "shots/$($cam.name).png"
        if (-not (Test-Path (Join-Path $RunDir ($rel -replace '/', '\')))) { [void]$missing.Add("$rel（机位产物）") }
    }
    $ok = ($overall -eq 'green') -and ($missing.Count -eq 0)
    $detail = "overall=$overall；期望证据 $present 项在场，缺=[$($missing -join ',')]"
    return [pscustomobject]@{ ok = $ok; detail = $detail }
}

# ---------------------------------------------------------------------------
# C7（1/2）：观测记录的 te.* 运行期读数——族名逐字前缀 + sha256 非空
# ---------------------------------------------------------------------------
function Test-ObservationTeReads($ObservationDoc, [string]$FamilyPrefix) {
    if ($null -eq $ObservationDoc) { return [pscustomobject]@{ ok = $false; detail = 'observation.json 读不到' } }
    $reads = @($ObservationDoc.runtimeReads)
    $matched = @($reads | Where-Object { $null -ne $_ -and ([string]$_.key).StartsWith($FamilyPrefix) })
    $bad = @($matched | Where-Object { [string]::IsNullOrWhiteSpace([string]$_.sha256) } | ForEach-Object { [string]$_.key })
    $none = @($reads | Where-Object { $null -ne $_ -and ([string]$_.key) -like 'te.*' }).Count
    $ok = ($matched.Count -gt 0) -and ($bad.Count -eq 0)
    $detail = "匹配 `"$FamilyPrefix`" 条目 $($matched.Count) 条（记录里 te.* 共 $none 条）；sha256 为空=[$($bad -join ',')]"
    return [pscustomobject]@{ ok = $ok; detail = $detail }
}

# ---------------------------------------------------------------------------
# C7（2/2）：observation.cameras 摘要齐（数量/顺序/名字 == 用例声明；pos/projection/resolution 在场且尺寸一致）
# ---------------------------------------------------------------------------
function Test-ObservationCameras($ObservationDoc, $Cameras) {
    if ($null -eq $ObservationDoc) { return [pscustomobject]@{ ok = $false; detail = 'observation.json 读不到' } }
    $obsCams = @($ObservationDoc.observation.cameras)
    $obsNames = @($obsCams | ForEach-Object { [string]$_.name })
    $wantNames = @($Cameras | ForEach-Object { [string]$_.name })
    $problems = New-Object System.Collections.ArrayList
    if (($obsNames -join ',') -ne ($wantNames -join ',')) {
        [void]$problems.Add("名字/顺序不符：实际=[$($obsNames -join ',')] 期望=[$($wantNames -join ',')]")
    }
    foreach ($c in $obsCams) {
        $n = [string]$c.name
        $spec = @($Cameras | Where-Object { [string]$_.name -eq $n })[0]
        if ($null -eq $spec) { continue }
        $res = @($c.resolution)
        if (@($res).Count -ne 2 -or [int]$res[0] -ne [int]$spec.width -or [int]$res[1] -ne [int]$spec.height) {
            [void]$problems.Add("$n.resolution=[$(@($res) -join ',')]（声明 $($spec.width)x$($spec.height)）")
        }
        if ($null -eq $c.pos) { [void]$problems.Add("$n.pos 缺失") }
        if ($null -eq $c.projection) { [void]$problems.Add("$n.projection 缺失") }
    }
    if ($obsCams.Count -ne @($Cameras).Count) { [void]$problems.Add("机位数 $($obsCams.Count) != 声明 $(@($Cameras).Count)") }
    if ($problems.Count -gt 0) { return [pscustomobject]@{ ok = $false; detail = ($problems -join '; ') } }
    return [pscustomobject]@{ ok = $true; detail = "$($obsCams.Count) 机位摘要齐（name/pos/projection/resolution 与用例一致）" }
}
