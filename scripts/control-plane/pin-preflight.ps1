# 控制面点火前置（shared preflight）：钉 pauseOnLostFocus=false 并回读自证。
#
# 为什么需要这一层：
#   MC 1.7.10 只在启动时读 run 目录的 options.txt。失焦若弹暂停菜单，客户端就不再 tick，
#   一切自动化产物都不会落盘（表现为驱动超时）。所以「无人值守」的唯一治本做法是
#   **在 Start-Process 之前**把 pauseOnLostFocus 钉成 false，然后回读证明它真的生效。
#
# 职责边界（刻意做小）：
#   * 唯一的写选项实现是 drive-session.ps1 -PinOnly（本文件不自己写 options.txt）；
#   * 本文件只做四件事：调用 -> 非零退出码即失败 -> 回读恰好一行 false -> 产出可打印的证据对象；
#   * 失败一律 throw（调用方必须放在 try/catch 里并以 Fail-Fatal / 非零退出码阻断），
#     绝不「钉失败也继续点火」。
#
# 用法（驱动在 if (-not $SkipClientStart) 分支里、Start-Process 之前调用）：
#   . (Join-Path $scriptDir 'pin-preflight.ps1')
#   try { $pin = Invoke-PauseOnLostFocusPreflight -RunDir $mcDataDir -Tag 'smoke' }
#   catch { Fail-Fatal "点火前置失败：$($_.Exception.Message)" 4 }
#   Write-Ok $pin.EvidenceLine
#
# 注意：本文件被 dot-source，函数留在调用方作用域；只有实际要点火的路径才调用它，
#       -SkipClientStart / -ChecksOnly 等不点火路径不得调用（不得无谓写 run 目录）。

function Get-PinDriveSessionPath {
    param([string]$DriveSessionPath = '')
    if (-not [string]::IsNullOrWhiteSpace($DriveSessionPath)) {
        return [System.IO.Path]::GetFullPath($DriveSessionPath)
    }
    return (Join-Path $PSScriptRoot 'drive-session.ps1')
}

function Invoke-PauseOnLostFocusPreflight {
    [CmdletBinding()]
    param(
        # 客户端 run 目录（含 options.txt）；缺省由调用方给 $mcDataDir
        [Parameter(Mandatory = $true)][string]$RunDir,
        # 传给 drive-session.ps1 的标签（仅用于它自己的日志命名）
        [string]$Tag = 'preflight',
        # 覆盖 drive-session.ps1 路径（离线自检用来模拟「钉选项失败」）
        [string]$DriveSessionPath = ''
    )

    if ([string]::IsNullOrWhiteSpace($RunDir)) { throw '钉选项前置：-RunDir 为空，无法确定 options.txt 位置' }
    $runDirFull = [System.IO.Path]::GetFullPath($RunDir)
    $driver = Get-PinDriveSessionPath $DriveSessionPath
    if (-not (Test-Path -LiteralPath $driver -PathType Leaf)) {
        throw "钉选项前置：找不到 drive-session.ps1（$driver）——没有它就不点火"
    }
    $pwshCmd = (Get-Command pwsh -ErrorAction SilentlyContinue)
    if (-not $pwshCmd) { throw '钉选项前置：PATH 里找不到 pwsh（drive-session.ps1 需要 PowerShell 7）' }

    # (1) 调用唯一的写选项实现（-PinOnly：只钉 + 自校验，不进 F2 驱动循环）
    $pinOut = @(& pwsh -NoProfile -File $driver -RunDir $runDirFull -Tag $Tag -PinOnly 2>&1)
    $pinCode = $LASTEXITCODE
    $pinText = ((@($pinOut) | ForEach-Object { "$_" }) -join ([char]10)).TrimEnd()
    if ($pinCode -ne 0) {
        throw ("钉选项失败：drive-session.ps1 -PinOnly 退出码 $pinCode（RunDir=$runDirFull）。输出：$pinText")
    }

    # (2) 回读自证：options.txt 必须存在、是普通文件、恰好一行且值为 false
    $optionsPath = Join-Path $runDirFull 'options.txt'
    if (-not (Test-Path -LiteralPath $optionsPath)) {
        throw "钉选项回读失败：$optionsPath 不存在（drive-session.ps1 报告成功却没有产物）"
    }
    if (-not (Test-Path -LiteralPath $optionsPath -PathType Leaf)) {
        throw "钉选项回读失败：$optionsPath 不是普通文件（是目录？）"
    }
    $allLines = @([System.IO.File]::ReadAllLines($optionsPath))
    if ($allLines.Count -gt 0) { $allLines[0] = $allLines[0].TrimStart([char]0xFEFF) }
    $hits = @($allLines | Where-Object { $_.TrimEnd() -match '^pauseOnLostFocus:' } | ForEach-Object { $_.TrimEnd() })
    if ($hits.Count -ne 1) {
        throw ("钉选项回读失败：$optionsPath 里应为恰好一行 pauseOnLostFocus:，实际 $($hits.Count) 行：[$($hits -join ' | ')]")
    }
    if ($hits[0] -cne 'pauseOnLostFocus:false') {
        throw "钉选项回读失败：$optionsPath 的生效值是 [$($hits[0])]，期望 pauseOnLostFocus:false"
    }

    $evidence = "已钉 pauseOnLostFocus:false（$optionsPath）；回读恰 1 行：$($hits[0])"
    return [pscustomobject]@{
        pinned        = $true
        exitCode      = $pinCode
        runDir        = $runDirFull
        optionsPath   = $optionsPath
        readbackCount = $hits.Count
        readbackLine  = $hits[0]
        evidenceLine  = $evidence
        output        = @($pinOut)
    }
}
