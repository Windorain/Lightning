/**
 * 取值解析（契约 §5.2 / §7.2）—— 装配第 0 步。
 *
 * 纯查表 + 夹取，**零游戏逻辑**：所有语义都写在文档数据里（`domain` / `totalTierDomain` / `couplings`）。
 * 本文件与参考实现 `scripts/multiblock-fixtures/lib.mjs` 逐行同构，仅两处刻意不同：
 *   1. 用 `Record<string, number>` 而非 `Map`（便于直接进报告/JSON）；
 *   2. **不往 `couplings` 对象上写 `rawB`** —— 参考实现会污染调用方的文档数据，
 *      使"同一份文档两次序列化不一致"；夹取前后值只出现在 `report.clamped`。
 */
import type {
  AssemblyReport,
  ClampRecord,
  Guard,
  MultiblockChannel,
  MultiblockCoupling,
  MultiblockDecl,
  MultiblockVariant,
} from './types'

// ---------------------------------------------------------------------------
// 取值域
// ---------------------------------------------------------------------------

/**
 * 取值域解析（契约 §4.2 第 1 条）：域的取值集合恒为 `0..max`，**0 就是"未设置"**。
 *   - 无 `domain` 字段 → `[0, totalTier]`
 *   - `domain` 存在     → `[0, domain.max]`；`max` 缺省 = 总 Tier 域上界
 * `min`/`max` 只描述**有效值**区间，不影响域的起点。
 */
export function channelBounds(ch: MultiblockChannel, totalTier: number): { lo: number; hi: number } {
  const dom = ch.domain
  if (!dom) return { lo: 0, hi: Math.max(0, Math.trunc(totalTier) || 0) }
  const hi = dom.max === undefined || dom.max === null ? Math.max(0, Math.trunc(totalTier) || 0) : Math.trunc(dom.max)
  return { lo: 0, hi: Math.max(0, hi) }
}

/** 通道是否被显式设置（>0）。0 / null / undefined 均为"未设置"。 */
export function isSet(v: unknown): boolean {
  return typeof v === 'number' && v > 0
}

/**
 * 有效取值（GT `ChannelDataAccessor.getChannelData` 语义）：
 * 通道未设置 → 回落到主通道（stackSize）= 总 Tier；已设置 → 取显式值。
 */
export function resolveEffective(raw: unknown, totalTier: number): { set: boolean; value: number } {
  const set = isSet(raw)
  return { set, value: set ? Math.floor(raw as number) : Math.floor(totalTier) }
}

/** 总 Tier 抽样清单：显式 `tierSample` 优先，缺省 = 整个 `totalTierDomain`。 */
export function tierSampleOf(mb: MultiblockDecl): number[] {
  const tt = mb.totalTierDomain ?? { min: 1, max: 1 }
  const min = Math.trunc(tt.min)
  const max = Math.trunc(tt.max)
  if (Array.isArray(mb.tierSample) && mb.tierSample.length > 0) {
    return [...mb.tierSample].map((n) => Math.trunc(n)).sort((a, b) => a - b)
  }
  const out: number[] = []
  for (let i = min; i <= max; i++) out.push(i)
  return out
}

// ---------------------------------------------------------------------------
// 变体键（契约 §5.1）
// ---------------------------------------------------------------------------

/**
 * 变体键：`<通道key>:<声明值>|…|tt:<总Tier>|runstate:<id>`。
 *
 * **总 Tier 必须进键**：通道未设置（0）时其有效值回落总 Tier，故"全部通道未设置"在
 * `tt:1` 与 `tt:3` 下是两个不同变体。键里的值恒为**声明值**（未设置写 0）。
 */
export function variantKeyOf(
  channels: MultiblockChannel[],
  values: Record<string, number>,
  runstate: string,
  totalTier: number,
): string {
  const parts = channels.map((c) => `${c.key}:${values[c.key] ?? 0}`)
  parts.push(`tt:${totalTier}`)
  parts.push(`runstate:${runstate}`)
  return parts.join('|')
}

/** 变体键反解（诊断/兼容用）。 */
export function parseVariantKey(key: string): {
  values: Record<string, number>
  totalTier?: number
  runstate?: string
} {
  const out: { values: Record<string, number>; totalTier?: number; runstate?: string } = { values: {} }
  for (const part of String(key).split('|')) {
    const i = part.indexOf(':')
    if (i < 0) continue
    const k = part.slice(0, i)
    const v = part.slice(i + 1)
    if (k === 'tt') out.totalTier = Number(v)
    else if (k === 'runstate') out.runstate = v
    else out.values[k] = Number(v)
  }
  return out
}

// ---------------------------------------------------------------------------
// guard（契约 §4.5.3）
// ---------------------------------------------------------------------------

/**
 * guard 求值：clauses 之间 AND；`not:true` 为否定（含整体取反）；无 clauses 视为恒真。
 * 只做"声明值/有效值"的比较，不做算术。
 */
export function evalGuard(
  guard: Guard | undefined,
  effective: Record<string, number>,
  channelByKey: Map<string, MultiblockChannel>,
): boolean {
  if (!guard) return true
  const clauses = guard.clauses ?? []
  let acc = true
  for (const c of clauses) {
    if (!channelByKey.has(c.channel)) throw new Error(`guard 引用了未声明通道: ${c.channel}`)
    const v = effective[c.channel]
    if (v === undefined) throw new Error(`guard 引用了未解析通道: ${c.channel}`)
    let ok: boolean
    if (c.not === true) ok = v !== c.value
    else if (c.min !== undefined) ok = v >= c.min
    else if (c.max !== undefined) ok = v <= c.max
    else ok = v === c.value
    acc = acc && ok
    if (!acc) break
  }
  return guard.not === true ? !acc : acc
}

// ---------------------------------------------------------------------------
// 通道耦合（契约 §7.2）
// ---------------------------------------------------------------------------

/**
 * 通道耦合求值（唯一会"夹取"的地方，与域夹取并列）。
 *
 * 缺省 `couplings: []` + `couplingMode: "none"` → **不夹取、不拒绝任何组合**。
 * 方向即语义：`b` 是被夹取的一方；`couplings` 数组顺序执行（可级联）。
 */
export function applyCouplings(
  mb: MultiblockDecl,
  effective: Record<string, number>,
  report: AssemblyReport,
): void {
  const couplings: MultiblockCoupling[] = Array.isArray(mb.couplings) ? mb.couplings : []
  if (couplings.length === 0 || mb.couplingMode !== 'clamp') return
  for (const cp of couplings) {
    const a = effective[cp.a]
    let b = effective[cp.b]
    if (a === undefined || b === undefined) {
      report.warnings.push(`coupling ${cp.id ?? ''} 引用了未声明通道，已跳过`)
      continue
    }
    const before = b
    let changed = false
    if (cp.requires === 'ge' && !(a >= b)) {
      b = a
      changed = true
    } else if (cp.requires === 'le' && !(a <= b)) {
      b = a
      changed = true
    } else if (cp.requires === 'eq' && a !== b) {
      b = a
      changed = true
    }
    if (changed) {
      effective[cp.b] = b
      const rec: ClampRecord = {
        coupling: cp.id ?? '',
        a: cp.a,
        b: cp.b,
        requires: cp.requires,
        bWas: before,
        bNow: b,
      }
      report.clamped.push(rec)
    }
  }
}

// ---------------------------------------------------------------------------
// 装配第 0 步：取值解析
// ---------------------------------------------------------------------------

/** 新建一份空报告（装配过程逐步填满）。 */
export function createReport(variantKey: string): AssemblyReport {
  return {
    variantKey,
    frameIndex: -1,
    runstate: '',
    totalTier: 0,
    stepIndex: -1,
    dims: { w: 0, h: 0, d: 0 },
    effective: {},
    clamped: [],
    rejections: [],
    warnings: [],
    opsApplied: 0,
    rulesApplied: [],
  }
}

/**
 * 取值解析（契约 §5.2）：**总 Tier 域夹取 → 逐通道（未设置回落总 Tier）域夹取 → 耦合夹取**。
 *
 * @param overrideValues 覆盖"声明值"。用于装配一个**未被声明为变体**的组合（例如 UI 滑到域外
 *   的 99）：变体定位用夹取后的声明值（因而能找到已声明变体），而取值解析用原始值，
 *   这样 `report.clamped` 才能如实记录 `was: 99 → now: 3`。
 */
export function resolveVariantValues(
  mb: MultiblockDecl,
  variantKey: string,
  variant: MultiblockVariant,
  overrideValues?: Record<string, number>,
): { effective: Record<string, number>; totalTier: number; runstate: string; report: AssemblyReport } {
  const report = createReport(variantKey)
  const parsedKey = parseVariantKey(variantKey)
  const runstate =
    variant.runstate ?? parsedKey.runstate ?? mb.runstates?.[0]?.id ?? 'idle'
  report.runstate = runstate

  const totalTierRaw =
    variant.totalTier ?? parsedKey.totalTier ?? mb.totalTierDomain?.default ?? mb.totalTierDomain?.max ?? 1

  const ttDomain = mb.totalTierDomain ?? { min: 1, max: 1 }
  let totalTier = Math.floor(totalTierRaw)
  if (totalTier < ttDomain.min) {
    report.clamped.push({ field: 'totalTier', was: totalTier, now: ttDomain.min, reason: 'domain' })
    totalTier = ttDomain.min
  }
  if (totalTier > ttDomain.max) {
    report.clamped.push({ field: 'totalTier', was: totalTier, now: ttDomain.max, reason: 'domain' })
    totalTier = ttDomain.max
  }

  const effective: Record<string, number> = {}
  for (const ch of mb.channels) {
    const raw = overrideValues?.[ch.key] ?? variant.values?.[ch.key] ?? 0
    const { lo, hi } = channelBounds(ch, totalTier)
    let v = resolveEffective(raw, totalTier).value
    if (v < lo || v > hi) {
      // 域夹取优先于回落：`domain` 声明的是**模式**（可作哪些值），未设置的通道回落总 Tier
      // 时若越出模式，按 GT `getValueClamped` 同口径夹取。
      report.clamped.push({ field: ch.key, was: v, now: Math.min(Math.max(v, lo), hi), reason: 'domain' })
      v = Math.min(Math.max(v, lo), hi)
    }
    effective[ch.key] = v
  }
  report.totalTier = totalTier
  report.effective = effective

  applyCouplings(mb, effective, report)
  return { effective, totalTier, runstate, report }
}

/**
 * 尺寸型 → 骨架阶（契约 §5.2）：
 * `k = min(max(effective[sizeChannel], min), max) − min`。
 *
 * 装配本身用 `frame.stepIndex`（契约 §5.4 明文："尺寸型已在上一步由 stepIndex 完成"）；
 * 本函数供 UI/报告复核用，`sizeChannel` 不是具名通道（如 `totalTier`）时返回 `undefined`。
 */
export function stepIndexForEffective(mb: MultiblockDecl, effective: Record<string, number>): number | undefined {
  const key = mb.backbone?.sizeChannel
  const ch = mb.channels.find((c) => c.key === key)
  const v = effective[key]
  if (v === undefined) return undefined
  const min = ch?.min ?? 1
  const max = ch?.max ?? v
  const clamped = Math.min(Math.max(v, min), max)
  return clamped - min
}
