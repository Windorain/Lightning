/**
 * 规则应用（契约 §4.5 / §5.4）—— **零求值**：只有查表 + 索引 + 区间写入。
 *
 * 覆盖差异表达的四种手段：
 *   ① `fill`    —— 沿轴区间批量写入（`sel` 某轴给数组 = 逐层一个坐标；不给 = 该轴全长；越界跳过）
 *   ② `setCell` —— 单格写入 / 删除（`index: 0`）
 *   ③ `indexAliases` —— "旧下标 → 新下标"的整表批量替换
 *   ④ `index` / `indexRole` / `indexTable` —— 常量 / 骨架角色 / 通道取值 **查表**
 *
 * 没有算术、没有表达式、没有游戏语义：`fill` 不允许 `y: "h-2"` 这类写法（契约 §4.5.1）。
 */
import type { AxisSelector, Dims, Guard, MultiblockRule, MultiblockSizeStep } from './types'

/** 一次写入的目标格。 */
export interface WriteCell {
  x: number
  y: number
  z: number
}

type AxisPlan = { kind: 'all' } | { kind: 'values'; values: number[] }

/**
 * 单轴选择器规划（契约 §4.5.1）：
 *   - 数组 → 逐层取一个坐标（第 i 层用 `values[i]`，长度不足则重复最后一个）
 *   - 数字 → 每层同一个坐标
 *   - 缺省 → 该轴全长
 * `layers` 只用于数字的铺开长度（参考实现同口径：x/z 的数字也铺 `h` 份）。
 */
function planAxis(spec: AxisSelector | undefined, layers: number): AxisPlan {
  if (spec === undefined) return { kind: 'all' }
  if (Array.isArray(spec)) return { kind: 'values', values: spec.map((n) => Math.trunc(n)) }
  return { kind: 'values', values: new Array(layers).fill(Math.trunc(spec)) }
}

/**
 * 把一条规则展开为**目标格列表**（纯索引运算）。
 *
 * `fill` 的层数 = `sel.y` 的取值个数（数组）或结构高度（数字/缺省）；
 * 越界坐标**该层跳过、不报错** —— 这让"同一张规则表适配所有骨架阶"成立。
 */
export function expandOp(rule: MultiblockRule, dims: Dims): WriteCell[] {
  if (rule.kind === 'fill') {
    const { w, h, d } = dims
    const sel = rule.sel
    if (!sel) throw new Error(`fill 规则缺 sel: ${rule.id}`)
    const xs = planAxis(sel.x, h)
    const ys = planAxis(sel.y, h)
    const zs = planAxis(sel.z, h)
    const out: WriteCell[] = []
    const layers = Math.max(ys.kind === 'all' ? h : ys.values.length, 1)
    for (let layer = 0; layer < layers; layer++) {
      const yv = ys.kind === 'all' ? layer : ys.values[Math.min(layer, ys.values.length - 1)]!
      if (yv === undefined || yv < 0 || yv >= h) continue
      const xList = xs.kind === 'all' ? fullAxis(w) : xs.values
      const zList = zs.kind === 'all' ? fullAxis(d) : zs.values
      for (const xv of xList) {
        if (xv < 0 || xv >= w) continue
        for (const zv of zList) {
          if (zv < 0 || zv >= d) continue
          out.push({ x: xv, y: yv, z: zv })
        }
      }
    }
    return out
  }
  if (rule.kind === 'setCell') {
    const { w, h, d } = dims
    const x = Math.trunc(rule.x ?? 0)
    const y = Math.trunc(rule.y ?? 0)
    const z = Math.trunc(rule.z ?? 0)
    if (x < 0 || x >= w || y < 0 || y >= h || z < 0 || z >= d) return []
    return [{ x, y, z }]
  }
  throw new Error(`未知 rule.kind: ${String((rule as { kind?: unknown }).kind)}`)
}

function fullAxis(size: number): number[] {
  const out: number[] = []
  for (let i = 0; i < size; i++) out.push(i)
  return out
}

/**
 * 解析一条规则"写入什么下标"（契约 §5.4）：
 * `indexTable[effective[channel]]` → `step.roles[indexRole]` → `index`（纯查表，无函数）。
 */
export function resolveRuleIndex(
  rule: MultiblockRule,
  step: MultiblockSizeStep,
  effective: Record<string, number>,
): number {
  let index: number | undefined = rule.index
  if (rule.indexTable) {
    const v = rule.channel === undefined ? undefined : effective[rule.channel]
    if (v === undefined) throw new Error(`规则 ${rule.id} 的 indexTable 引用了未声明/未解析通道: ${rule.channel}`)
    index = rule.indexTable[v]
    if (index === undefined) throw new Error(`规则 ${rule.id} 的 indexTable 缺第 ${v} 档（通道 ${rule.channel}）`)
  } else if (rule.indexRole !== undefined) {
    index = step.roles?.[rule.indexRole]
    if (index === undefined) throw new Error(`骨干角色未定义: ${rule.indexRole}（规则 ${rule.id}）`)
  }
  if (index === undefined) throw new Error(`规则 ${rule.id} 既无 index 也无有效 indexTable/indexRole`)
  return index
}

/**
 * `indexAliases`：在写入之前对**当前网格**做一次整表替换（契约 §4.5.2）。
 * 值为 `v` 的格子，若 `v` 在表中则改成 `aliases[v]`，否则保持。
 */
export function applyIndexAliases(
  grid: number[][][],
  aliases: Record<string, number>,
  dims: Dims,
): number {
  let changed = 0
  for (let z = 0; z < dims.d; z++) {
    const slice = grid[z]!
    for (let y = 0; y < dims.h; y++) {
      const row = slice[y]!
      for (let x = 0; x < dims.w; x++) {
        const v = row[x]!
        if (Object.prototype.hasOwnProperty.call(aliases, String(v))) {
          row[x] = aliases[String(v)]!
          changed++
        }
      }
    }
  }
  return changed
}

/** guard 的类型出口（规则表消费方常需要）。 */
export type { Guard }
