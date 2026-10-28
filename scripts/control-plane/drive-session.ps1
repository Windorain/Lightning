# 会话驱动：钉 pauseOnLostFocus=false（治本）+ F2 截图；ESC 仅兜底、永不抢焦点。
#
# 无人值守纪律（无人值守窗口必须保证客户端持续 tick）：
# 「抢焦点 + 周期 ESC」废止——它跟用户抢键盘鼠标，用户在机上干活会被打断。
# 正解 = 点火前把 run 目录 options.txt 的 pauseOnLostFocus 钉为 false（1.7.10 原生选项，
# 失焦不弹暂停菜单、照 tick）；ESC 周期仅作已钉选项仍失效时的兜底，且不得抢焦点。
#
# 时序要求：MC 只在启动时读 options.txt —— 钉选项必须先于客户端启动才对本会话生效。
# 本脚本每次点火都会钉（幂等），但调用方若要本会话生效，应先跑本脚本的 -PinOnly，
# 再启动客户端，最后再跑本脚本的驱动循环（或直接在外层编排里先钉后启）。
#
# 用法：
#   # ①只钉选项（客户端启动前调用一次）
#   pwsh -File scripts/control-plane/drive-session.ps1 -RunDir <mod\gtnh\run\client> -Tag t1 -PinOnly
#   # ②驱动循环（客户端运行期间）：钉选项 + F2 周期截图，不抢焦点
#   pwsh -File scripts/control-plane/drive-session.ps1 -RunDir <mod\gtnh\run\client> -Tag t1 -Seconds 200
#   # ③兜底：已钉选项仍见暂停菜单时启用 ESC（PostMessage，不抢焦点）
#   pwsh -File scripts/control-plane/drive-session.ps1 -RunDir <mod\gtnh\run\client> -Tag t1 -EscFallbackEvery 2
param(
    [int]$Seconds = 200,
    [Parameter(Mandatory = $true)][string]$Tag,
    [int]$EveryMs = 3000,
    # ESC 兜底周期（每 N 个循环一次）；0 = 关闭（默认）。永不抢焦点，仅 PostMessage。
    [int]$EscFallbackEvery = 0,
    # 客户端 run 目录（含 options.txt / screenshots）
    [Parameter(Mandatory = $true)][string]$RunDir,
    # 只钉 pauseOnLostFocus=false 并校验，不进驱动循环
    [switch]$PinOnly,
    # 截图输出目录（缺省 = <RunDir>\screenshots）
    [string]$ShotsDir = "",
    # 驱动日志（缺省 = <RunDir>\drive-<Tag>.log）
    [string]$LogFile = ""
)
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- 钉选项（治本）
# 写入/校验 options.txt 的 pauseOnLostFocus:false；文件缺失则生成该行。
function Set-PauseOnLostFocusFalse([string]$runDir) {
    $optFile = Join-Path $runDir 'options.txt'
    # options.txt 是目录 / 不可写时显式失败：绝不静默跳过（跳过 ⇒ 失焦暂停 ⇒ 驱动超时）
    if (Test-Path -LiteralPath $optFile -PathType Container) {
        throw "钉选项失败：$optFile 是目录，不是可写的 options.txt"
    }
    if (-not (Test-Path -LiteralPath $optFile -PathType Leaf)) {
        New-Item -ItemType Directory -Force -Path $runDir | Out-Null
        Set-Content -LiteralPath $optFile -Value 'pauseOnLostFocus:false' -Encoding ascii
    } else {
        # 重复/冲突行归一：保留首个 pauseOnLostFocus: 的位置写成 false，其余同前缀行删除
        $lines = @(Get-Content -LiteralPath $optFile)
        $out = New-Object System.Collections.ArrayList
        $hit = $false
        foreach ($line in $lines) {
            if ($line -match '^pauseOnLostFocus:') {
                if (-not $hit) { [void]$out.Add('pauseOnLostFocus:false'); $hit = $true }
            } else {
                [void]$out.Add($line)
            }
        }
        if (-not $hit) { [void]$out.Add('pauseOnLostFocus:false') }
        Set-Content -LiteralPath $optFile -Value $out.ToArray() -Encoding ascii
    }
    # 校验：回读必须见到唯一生效行（TrimEnd 让 CRLF / 尾随空白不误判）
    $readback = @(Get-Content -LiteralPath $optFile | Where-Object { $_.TrimEnd() -match '^pauseOnLostFocus:' } | ForEach-Object { $_.TrimEnd() })
    if ($readback.Count -ne 1 -or $readback[0] -cne 'pauseOnLostFocus:false') {
        throw "钉选项校验失败：$optFile 回读 = [$($readback -join ' | ')]"
    }
    Write-Host "== 已钉 pauseOnLostFocus:false（$optFile）"
    return $optFile
}

New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
$RunDir = (Resolve-Path $RunDir).Path
[void](Set-PauseOnLostFocusFalse $RunDir)
if ($PinOnly) { Write-Host '== PinOnly：钉选项完成，退出（请随后启动客户端）'; exit 0 }

# 以下仅为驱动循环（F2 截图 / ESC 兜底）需要：PinOnly 路径不编译 user32 绑定，无头环境也能钉。
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class F {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
"@
$WM_KEYDOWN = 0x0100; $WM_KEYUP = 0x0101; $VK_F2 = 0x71; $VK_ESC = 0x1B
$lpF2D = [IntPtr](0x003C0001); $lpF2U = [IntPtr](0xC03C0001)
$lpEscD = [IntPtr](0x00010001); $lpEscU = [IntPtr](0xC0010001)

if ([string]::IsNullOrWhiteSpace($ShotsDir)) { $ShotsDir = Join-Path $RunDir 'screenshots' }
if ([string]::IsNullOrWhiteSpace($LogFile)) { $LogFile = Join-Path $RunDir "drive-$Tag.log" }
New-Item -ItemType Directory -Force -Path $ShotsDir | Out-Null

# ---------------------------------------------------------------- 驱动循环（不抢焦点）
$i = 0
$deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline) {
    $p = Get-Process java -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*Minecraft*' } | Select-Object -First 1
    if ($p -and $p.MainWindowHandle -ne 0) {
        $h = $p.MainWindowHandle
        # ESC 兜底（默认关）：仅 PostMessage，不抢焦点。已钉选项正常时用不到。
        if ($EscFallbackEvery -gt 0 -and ($i % $EscFallbackEvery -eq 0)) {
            [void][F]::PostMessage($h, $WM_KEYDOWN, [IntPtr]$VK_ESC, $lpEscD)
            Start-Sleep -Milliseconds 60
            [void][F]::PostMessage($h, $WM_KEYUP, [IntPtr]$VK_ESC, $lpEscU)
            Start-Sleep -Milliseconds 200
        }
        [void][F]::PostMessage($h, $WM_KEYDOWN, [IntPtr]$VK_F2, $lpF2D)
        Start-Sleep -Milliseconds 60
        [void][F]::PostMessage($h, $WM_KEYUP, [IntPtr]$VK_F2, $lpF2U)
        Add-Content -Path $LogFile -Value ("{0} #{1} F2 posted（无焦点干预）" -f (Get-Date -Format 'HH:mm:ss'), $i) -Encoding utf8
    } else {
        Add-Content -Path $LogFile -Value ("{0} #{1} 无 Minecraft 窗口" -f (Get-Date -Format 'HH:mm:ss'), $i) -Encoding utf8
    }
    $i++
    Start-Sleep -Milliseconds $EveryMs
}
Get-Content $LogFile | Select-Object -Last 12
