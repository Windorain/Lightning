import type { JsonNbt } from '@/render/schema/types'

export function autoTooltipFromNbt(nbt: JsonNbt): string {
  const lines: string[] = []
  if (typeof nbt !== 'object' || nbt === null) return ''

  const mappings: Array<[string, string, (v: unknown) => string]> = [
    ['mWorks', '§b机器加工', v => v ? '§a运行中' : '§c未运行'],
    ['mEUt', '§d功率', v => `§e${Math.abs(Number(v))}§6 EU/t`],
    ['mStoredEnergy', '§d能量', v => `§a${formatNum(Number(v))}§6 EU`],
    ['mActive', '§b状态', v => v ? '§a激活' : '§7休眠'],
    ['mEfficiency', '§b效率', v => `§e${(Number(v) / 100).toFixed(0)}§f %`],
    ['mFluidMode', '§b流体模式', v => v ? '§6输出金液' : '§7输出面粉'],
    ['batchMode', '§b批量处理', v => v ? '§a开启' : '§7关闭'],
    ['chunkLoadingEnabled', '§b区块加载', v => v ? '§a开启' : '§7关闭'],
    ['wirelessMode', '§6无线模式', v => v ? '§a开启' : '§7关闭'],
    ['autoPull', '§6ME-自动拉取', v => v ? '§a开启' : '§7关闭'],
  ]

  for (const [key, label, format] of mappings) {
    if (key in nbt) {
      lines.push(`${label}: §f${format((nbt as Record<string, unknown>)[key])}`)
    }
  }
  return lines.join('\n')
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + 'G'
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(Math.round(n))
}
