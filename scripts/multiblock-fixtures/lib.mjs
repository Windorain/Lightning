/**
 * 多方块文档 fixture 公共库（T0.5）。
 *
 * 本文件同时服务两个脚本：
 *   - generate-fixtures.mjs  —— 生成 web/src/context/__tests__/fixtures/multiblock-*.json
 *   - validate-multiblock-fixtures.mjs —— 格式校验 + **装配算法参考实现**
 *
 * 装配算法是 T2.2 的对照蓝本：**零游戏逻辑**，只有查表 + 索引 + 区间写入。
 * 本库不依赖任何 web/ 或 mod/ 源码（Node ≥ 18，零第三方依赖）。
 */

import { gunzipSync } from 'node:zlib'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const AIR = 0

/** 四边形顶点平铺：每面 4 顶点 × 7 字段，顺序 [x,y,z,u,v,brightness,color] */
export const UNIT_CUBE_FACES = [
  // -z (向 -z 外法线的面)
  [[0, 0, 0, 0, 0], [1, 0, 0, 1, 0], [1, 1, 0, 1, 1], [0, 1, 0, 0, 1]],
  // +z
  [[0, 0, 1, 0, 0], [1, 0, 1, 1, 0], [1, 1, 1, 1, 1], [0, 1, 1, 0, 1]],
  // -y
  [[0, 0, 0, 0, 0], [1, 0, 0, 1, 0], [1, 0, 1, 1, 1], [0, 0, 1, 0, 1]],
  // +y
  [[0, 1, 0, 0, 0], [1, 1, 0, 1, 0], [1, 1, 1, 1, 1], [0, 1, 1, 0, 1]],
  // -x
  [[0, 0, 0, 0, 0], [0, 0, 1, 1, 0], [0, 1, 1, 1, 1], [0, 1, 0, 0, 1]],
  // +x
  [[1, 0, 0, 0, 0], [1, 0, 1, 1, 0], [1, 1, 1, 1, 1], [1, 1, 0, 0, 1]],
]

/** 参考格式（bakedQuadsJsonV1）的立方体几何：6 面 × 4 顶点对象。 */
export function bakedCubeGeometry() {
  const quads = []
  for (let mi = 0; mi < UNIT_CUBE_FACES.length; mi++) {
    const face = UNIT_CUBE_FACES[mi]
    quads.push({
      materialIndex: mi,
      vertices: face.map(([x, y, z, u, v]) => ({ x, y, z, u, v, brightness: 0.85, color: 16777215 })),
    })
  }
  return { encoding: 'bakedQuadsJsonV1', quads }
}

/** 一个方块状态条目（几何 = 单位立方体）。 */
export function paletteEntry(registryId, meta, extra = {}) {
  return {
    registryId,
    meta,
    renderMode: 'BakedModel',
    geometry: bakedCubeGeometry(),
    occludesAdjacentFaces: true,
    ...extra,
  }
}

export function airEntry() {
  return {
    registryId: 'air',
    meta: 0,
    renderMode: 'BakedModel',
    geometry: { encoding: 'bakedQuadsJsonV1', quads: [] },
    occludesAdjacentFaces: false,
    tooltip: [],
  }
}

// ---------------------------------------------------------------------------
// 调色板内容签名（对齐 mod 侧 MeshCaptureService.entryEqualitySignature 的口径）
// ---------------------------------------------------------------------------

/** 规范化 JSON：对象键排序，数组顺序保留（几何 quads 顺序是语义的一部分）。 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}'
  }
  return JSON.stringify(value === undefined ? null : value)
}

export function entrySignature(entry) {
  return canonicalJson(entry)
}

/** 调色板全局并集 + 按内容签名去重。air 恒为下标 0。 */
export function unionPalette(entries) {
  const out = [airEntry()]
  const seen = new Map([[entrySignature(out[0]), 0]])
  for (const e of entries) {
    const sig = entrySignature(e)
    if (seen.has(sig)) continue
    seen.set(sig, out.length)
    out.push(e)
  }
  return { palette: out, indexOf: seen }
}

// ---------------------------------------------------------------------------
// 取值域解析（通道语义）
// ---------------------------------------------------------------------------

/**
 * 取值域解析：
 *   - 无 `domain` 字段 → [0, totalTier]（无声明；GT 里未设置回落主通道 = 总 Tier）
 *   - `domain` 存在     → [0, domain.max]，0 恒为"未设置"（Not set）
 *   - `min`/`max` 只描述**有效值**区间，不影响域的起点（0 永远在域内）
 * 返回 `{ lo, hi }`（含端点，lo 恒为 0）。
 */
export function channelBounds(ch, totalTier) {
  const dom = ch.domain
  if (!dom) return { lo: 0, hi: Math.max(0, totalTier | 0) }
  const hi = dom.max === undefined || dom.max === null ? Math.max(0, totalTier | 0) : dom.max | 0
  return { lo: 0, hi: Math.max(0, hi) }
}

/** 通道是否被显式设置（>0）。0 / null / undefined 均为"未设置"。 */
export function isSet(v) {
  return typeof v === 'number' && v > 0
}

/**
 * 有效取值（GT `ChannelDataAccessor.getChannelData` 语义）：
 * 通道未设置 → 回落到主通道（stackSize）= 总 Tier；已设置 → 取显式值。
 * 这是 UI 默认态（Tier=1、所有通道 Not set）能装配出确定结构的原因，也是
 * "设置 0 = 未设置 = 回落总 Tier" 这条**必须可表达**的语义的落点。
 */
export function resolveEffective(raw, totalTier) {
  const set = isSet(raw)
  return { set, value: set ? Math.floor(raw) : Math.floor(totalTier) }
}

// ---------------------------------------------------------------------------
// 装配器（参考实现 / T2.2 蓝本）
// ---------------------------------------------------------------------------

function newGrid(w, h, d, fillValue = AIR) {
  const g = []
  for (let z = 0; z < d; z++) {
    const slice = []
    for (let y = 0; y < h; y++) slice.push(new Array(w).fill(fillValue))
    g.push(slice)
  }
  return g
}

function cloneGrid(g) {
  return g.map((slice) => slice.map((row) => row.slice()))
}

/** 取 selector 的某个轴：数组里不含 y 时按"每层一行"铺开。 */
function expandAxisTiled(v, size, layers) {
  if (Array.isArray(v)) return v.map((n) => n | 0)
  if (typeof v === 'number') return new Array(layers).fill(v | 0)
  return new Array(layers).fill(null) // null = 全长
}

function axisValues(spec, size, layers) {
  if (spec === undefined) return { kind: 'all' }
  if (Array.isArray(spec)) return { kind: 'list', values: spec.map((n) => n | 0) }
  return { kind: 'tiled', values: expandAxisTiled(spec, size, layers) }
}

/**
 * 把一条 op 展开为 `{ sel: {x,y,z}, index }` 列表（**纯索引运算**）。
 * 覆盖差异表达：
 *   ① `fill` —— 沿轴区间批量写入（`sel` 的某轴给数组 = 逐层一个坐标，不给 = 该轴全长）；
 *   ② `setCell` —— 单格写入 / 删除（`index: 0`）；
 *   ③ `indexAliases` —— "旧下标 → 新下标"的整表批量替换（与 abc 组合）；
 *   ④ `indexTable` —— 取值 → 调色板下标的**查表**（配 `channel` 使用）：禁止函数求值，
 *      内容差异只能来自声明好的表；表长 = 该通道取值数，下标 = 有效取值。
 */
export function expandOp(op, ctx, effective) {
  let index = op.index
  if (op.indexTable) {
    const v = effective?.get(op.channel)
    if (v === undefined) throw new Error(`op.indexTable 引用了未声明通道: ${op.channel}`)
    index = op.indexTable[v]
    if (index === undefined) throw new Error(`op.indexTable 缺第 ${v} 档（通道 ${op.channel}）`)
  }
  if (index === undefined) throw new Error(`op 既无 index 也无有效 indexTable（kind=${op.kind}）`)

  if (op.kind === 'fill') {
    const { w, h, d } = ctx
    const xs = axisValues(op.sel.x, w, h)
    const ys = axisValues(op.sel.y, h, h)
    const zs = axisValues(op.sel.z, d, h)
    const out = []
    const layers = Math.max(ys.values ? ys.values.length : h, 1)
    for (let layer = 0; layer < layers; layer++) {
      const yv = ys.kind === 'all' ? layer : ys.values[Math.min(layer, ys.values.length - 1)]
      if (yv === null || yv === undefined || yv < 0 || yv >= h) continue
      const xList = xs.kind === 'all' ? Array.from({ length: w }, (_, i) => i) : xs.values
      const zList = zs.kind === 'all' ? Array.from({ length: d }, (_, i) => i) : zs.values
      for (let xi = 0; xi < xList.length; xi++) {
        const xv = xList[xi]
        if (xv < 0 || xv >= w) continue
        for (let zi = 0; zi < zList.length; zi++) {
          const zv = zList[zi]
          if (zv < 0 || zv >= d) continue
          out.push({ sel: { x: xv, y: yv, z: zv }, index })
        }
      }
    }
    return out
  }
  if (op.kind === 'setCell') {
    const { w, h, d } = ctx
    if (op.x < 0 || op.x >= w || op.y < 0 || op.y >= h || op.z < 0 || op.z >= d) return []
    return [{ sel: { x: op.x, y: op.y, z: op.z }, index }]
  }
  throw new Error(`未知 op.kind: ${String(op.kind)}`)
}

/** guard 求值：clauses 之间 AND；`not:true` 为否定；无 clauses 视为恒真。 */
export function evalGuard(guard, effective, channelByKey) {
  if (!guard) return true
  const clauses = guard.clauses ?? []
  let acc = true
  for (const c of clauses) {
    const ch = channelByKey.get(c.channel)
    if (!ch) throw new Error(`guard 引用了未声明通道: ${c.channel}`)
    const v = effective.get(c.channel)
    let ok
    if (c.not === true) ok = v !== c.value
    else if (c.min !== undefined) ok = v >= c.min
    else if (c.max !== undefined) ok = v <= c.max
    else ok = v === c.value
    acc = acc && ok
    if (!acc) break
  }
  return guard.not === true ? !acc : acc
}

/**
 * 通道耦合求值（唯一会"夹取"的地方）。缺省 `couplings: []` + `couplingMode: "none"`
 * → 不夹取、不拒绝任何组合。
 */
export function applyCouplings(mb, effective, report) {
  const couplings = Array.isArray(mb.couplings) ? mb.couplings : []
  if (couplings.length === 0 || mb.couplingMode !== 'clamp') return
  for (const cp of couplings) {
    const a = effective.get(cp.a)
    let b = effective.get(cp.b)
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
      effective.set(cp.b, b)
      // 注意：**不往 couplings 对象上写运行时字段**（否则会把装配产物污染进文档数据，
      // 让"同一份文档两次序列化不一致"）。夹取前后值只出现在 report 里。
      report.clamped.push({ coupling: cp.id ?? '', a: cp.a, b: cp.b, requires: cp.requires, bWas: before, bNow: b })
    }
  }
}

/**
 * 变体键：`<通道key>:<声明值>|...|tt:<总Tier>|runstate:<id>`。
 *
 * **总 Tier 必须进键**：通道未设置（0）时其有效值**回落总 Tier**（§3.2），因此
 * "全部通道未设置"的取值 0 在 Tier=1 与 Tier=3 下是两个不同变体，只靠通道值无法区分。
 * 声明值恒为原始值（未设置的通道写 0），有效值由装配期求值 —— 键因此是**声明**而非求值产物。
 */
export function variantKey(channels, values, runstate, totalTier) {
  const parts = channels.map((c) => `${c.key}:${values[c.key] ?? 0}`)
  parts.push(`tt:${totalTier}`)
  parts.push(`runstate:${runstate}`)
  return parts.join('|')
}

export function parseVariantKey(key) {
  const out = { values: {}, totalTier: undefined, runstate: undefined }
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

/**
 * 取值解析（装配第 1 步）：域夹取 → 未设置回落总 Tier → 通道耦合夹取。
 *
 * **生成器与校验器必须共用这一段**：`frame.cellGrid` 参考网格是按"夹取后的有效值"算出来的，
 * 若生成端与校验端对耦合的处理不一致，参考网格就会与装配结果不匹配。
 *
 * @returns {{effective: Map<string,number>, totalTier: number, report: object}}
 */
export function resolveVariantValues(doc, variantKeyString, variant) {
  const mb = doc.multiblock
  const report = { variantKey: variantKeyString, clamped: [], rejections: [], warnings: [], opsApplied: 0 }
  const parsedKey = parseVariantKey(variantKeyString)
  const runstate = variant.runstate ?? parsedKey.runstate ?? mb.runstates?.[0]?.id ?? 'idle'
  report.runstate = runstate
  const totalTierRaw = variant.totalTier ?? parsedKey.totalTier ?? mb.totalTierDomain?.default ?? mb.totalTierDomain?.max ?? 1

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

  const effective = new Map()
  for (const ch of mb.channels) {
    const raw = variant.values?.[ch.key] ?? 0
    const { lo, hi } = channelBounds(ch, totalTier)
    let v = resolveEffective(raw, totalTier).value
    if (v < lo || v > hi) {
      // 域夹取优先于回落：`domain` 声明的是**模式**（可作哪些值），未设置的通道回落总 Tier
      // 时若越出模式，按 GT `getValueClamped` 同口径夹取。这是耦合/域检查之前的规范化步骤。
      report.clamped.push({ field: ch.key, was: v, now: Math.min(Math.max(v, lo), hi), reason: 'domain' })
      v = Math.min(Math.max(v, lo), hi)
    }
    effective.set(ch.key, v)
  }
  for (const cp of mb.couplings ?? []) {
    if (cp && cp.requires) cp.rawB = effective.get(cp.b)
  }
  applyCouplings(mb, effective, report)
  return { effective, totalTier, report }
}

/**
 * 装配一个变体 → 完整 cellGrid（下标指向 **根级并集调色板**）。
 *
 * 装配顺序（计划 T1.4 硬约束）：**尺寸型 → 骨干 → 替换型 → 运行态**。
 * 实现上 = "取骨架阶 → 克隆 → 按相位依次写入规则表"，只有查表 + 索引 + 区间写入，
 * 不含任何游戏逻辑、不调用任何未知函数（内容差异全部来自 `index` / `indexTable` / `indexRole`）。
 *
 * 规则表（`multiblock.rules`）**按引用**被 frame 复用：一个变体只存
 * `{variantKey, stepIndex, runstate, rules:[规则id…]}`，故文件体积随"规则条目数"增长，
 * 而不是随"变体数 × 规则数"增长。
 *
 * @returns {{cellGrid:number[][][], report:object, dims:{w:number,h:number,d:number}, effective:Map<string,number>}}
 */
export function assembleVariant(doc, variantKeyString, opts = {}) {
  void opts
  const mb = doc.multiblock
  const channelByKey = new Map(mb.channels.map((c) => [c.key, c]))

  // --- 1. 变体取值（域夹取 → 回落 → 耦合夹取） ---
  const variant = (mb.variants ?? []).find((v) => v.key === variantKeyString)
  if (!variant) throw new Error(`未声明的变体键: ${variantKeyString}`)
  const { effective, report } = resolveVariantValues(doc, variantKeyString, variant)

  // --- 2. 尺寸型 → 骨干（每 frame 按自己的 stepIndex 取骨架阶；尺寸差异只体现为"选哪一阶"） ---
  const sizeSteps = mb.backbone?.sizeSteps ?? []
  const dims = { w: 1, h: 1, d: 1 }
  report.dims = dims

  // --- 3. 逐 frame 装配（每 frame 一个变体；规则表**按引用复用**，不在 frame 内重复） ---
  // frame 用 `variant`（变体键）定位变体：变体键由 `{通道声明值…, tt, runstate}` 唯一派生，
  // 是格式的**主键**，故 frame 必须携带它（不额外存 "第几个变体" —— 那会引入第二套编号）。
  const frames = (doc.frames ?? []).filter((f) => f.variant === variantKeyString)
  if (frames.length === 0) throw new Error(`变体 ${variantKeyString} 没有任何 frame（Frame 是唯一变体存储原语）`)
  const primaryFrame = frames[0]
  const phaseRank = { 0: 0, backbone: 0, 1: 1, replace: 1, 2: 2, runstate: 2 }
  const ruleSpec = new Map((mb.rules ?? []).map((r) => [r.id, r]))
  let result = null

  for (const frame of frames) {
    if (frame.stepIndex === undefined) throw new Error(`frame ${frame.index} 缺 stepIndex（关联骨架阶）`)
    const stepOfFrame = sizeSteps[frame.stepIndex]
    if (!stepOfFrame) throw new Error(`frame ${frame.index} 的 stepIndex=${frame.stepIndex} 越界`)
    const grid = cloneGrid(stepOfFrame.cellGrid)
    const dimsF = { w: grid[0][0].length, h: grid[0].length, d: grid.length }
    if (frame === primaryFrame) Object.assign(dims, dimsF)

    const refs = Array.isArray(frame.rules) ? frame.rules : []
    const ops = []
    for (let i = 0; i < refs.length; i++) {
      const id = typeof refs[i] === 'string' ? refs[i] : refs[i].id
      const order = typeof refs[i] === 'string' ? i : (refs[i].order ?? i)
      const spec = ruleSpec.get(id)
      if (!spec) throw new Error(`frame ${frame.index} 引用了未声明规则: ${id}`)
      if (!evalGuard(spec.guard, effective, channelByKey)) continue
      ops.push({ op: spec, phase: phaseRank[spec.phase ?? 'replace'] ?? 1, order })
    }
    // 同 phase 内按 frame 内的引用顺序（order）稳定排序："后写者胜"必须可复现。
    ops.sort((a, b) => a.phase - b.phase || a.order - b.order)

    for (const { op } of ops) {
      let index = op.index
      if (op.indexRole !== undefined) {
        index = stepOfFrame.roles?.[op.indexRole]
        if (index === undefined) throw new Error(`骨干角色未定义: ${op.indexRole}（frame ${frame.index}）`)
      }
      if (op.indexAliases) {
        // 整表批量替换：旧下标 → 新下标（未命中则保持原值）
        const alias = op.indexAliases
        for (let z = 0; z < dimsF.d; z++) {
          for (let y = 0; y < dimsF.h; y++) {
            for (let x = 0; x < dimsF.w; x++) {
              const v = grid[z][y][x]
              if (Object.prototype.hasOwnProperty.call(alias, String(v))) grid[z][y][x] = alias[String(v)]
            }
          }
        }
      }
      const writes = expandOp({ ...op, index }, dimsF, effective)
      for (const w of writes) grid[w.sel.z][w.sel.y][w.sel.x] = w.index
      report.opsApplied += writes.length
    }

    // --- 4. 越界断言（装配结果必须落在并集调色板内） ---
    const paletteSize = (doc.blockPalette ?? []).length
    for (let z = 0; z < dimsF.d; z++) {
      for (let y = 0; y < dimsF.h; y++) {
        for (let x = 0; x < dimsF.w; x++) {
          const v = grid[z][y][x]
          if (!Number.isInteger(v) || v < 0 || v >= paletteSize) {
            throw new Error(`装配越界: (${x},${y},${z}) = ${v}，调色板长度 ${paletteSize}（frame ${frame.index}）`)
          }
        }
      }
    }

    // 参考实现返回第一个 frame 的网格（fixture 每个变体恰好一个 frame）
    if (frame === primaryFrame) {
      const expected = frame.cellGrid
      if (expected) {
        const a = JSON.stringify(grid)
        const b = JSON.stringify(expected)
        if (a !== b) throw new Error(`frame ${frame.index} 的 cellGrid 与参考骨架+规则装配结果不一致`)
      }
      result = { cellGrid: grid, report, dims: dimsF, effective }
    }
  }
  if (!result) throw new Error(`变体 ${variantKeyString} 的 frame 未产出网格`)
  return result
}

// ---------------------------------------------------------------------------
// 文档读取（Envelope → 内层 body）
// ---------------------------------------------------------------------------

function base64ToBytes(b64) {
  return Uint8Array.from(Buffer.from(b64, 'base64'))
}

/**
 * 读取 fixture 文档。支持：
 *   - 信封（`documentFormat: "Envelope"`）：payload 解 base64 后**先当 JSON 文本读**，
 *     不成立再 gunzip 后读 JSON。fixture 用未压缩 payload 以保证可读可 diff；
 *     真实 `/sde multiblock` 产物走 gzip 分支（同一把钥匙，两种载荷）。
 *   - 裸体（内层 body 直接落盘，便于 node 侧单测）。
 */
export function readFixtureDocument(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('文档根必须是 JSON 对象')
  if (typeof raw.payload === 'string' && raw.meta && typeof raw.meta === 'object') {
    const bytes = base64ToBytes(raw.payload)
    const text = Buffer.from(bytes).toString('utf8')
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = JSON.parse(gunzipSync(bytes).toString('utf8'))
    }
    return { ...raw.meta, ...body }
  }
  return raw
}

/**
 * 组合枚举 = **文档声明的全部变体**（`multiblock.variants[]`）。
 *
 * 为什么以声明为准而不是重算笛卡尔积：**格式本身不需要你重算组合**（这正是"禁止组合展开"
 * 的另一面）——声明即契约，装配只做查表。校验器在此之上做完备性检查：
 * 声明集合必须恰好等于 `∏(每通道域) × multiblock.tierSample × 运行态集`。
 * `tierSample` 是**总 Tier 的抽样清单**（真实产物可给全 1..max；fixture 给代表值）；
 * 它必须落在 `totalTierDomain` 内，且每个抽样值都要有完整变体，不允许"少声明一个组合"。
 */
export function enumerateVariants(doc) {
  return (doc.multiblock?.variants ?? []).map((v) => ({
    key: v.key,
    totalTier: v.totalTier ?? doc.multiblock.totalTierDomain?.default ?? 1,
    values: { ...(v.values ?? {}) },
    runstate: v.runstate ?? 'idle',
  }))
}

/** 总 Tier 抽样清单：显式 `multiblock.tierSample` 优先，缺省 = 整个 `totalTierDomain`。 */
export function tierSample(doc) {
  const mb = doc.multiblock
  const tt = mb.totalTierDomain ?? { min: 1, max: 1 }
  if (Array.isArray(mb.tierSample) && mb.tierSample.length > 0) return [...mb.tierSample].sort((a, b) => a - b)
  return range(tt.min, tt.max)
}

/** 期望组合集：∏(通道域) × tierSample × 运行态集。用于声明完备性断言。 */
export function expectedCombinationKeys(doc) {
  const mb = doc.multiblock
  const channelKeys = mb.channels.map((c) => c.key)
  const domains = mb.channels.map((c) => channelBounds(c, mb.totalTierDomain?.max ?? 1))
  const runstates = (mb.runstates ?? []).map((r) => r.id)
  const out = []
  function rec(i, values) {
    if (i === channelKeys.length) {
      for (const ttVal of tierSample(doc)) {
        for (const rs of runstates) {
          out.push({ key: variantKey(mb.channels, values, rs, ttVal), totalTier: ttVal, values: { ...values }, runstate: rs })
        }
      }
      return
    }
    const { lo, hi } = domains[i]
    for (const v of range(lo, hi)) {
      values[channelKeys[i]] = v
      rec(i + 1, values)
    }
    delete values[channelKeys[i]]
  }
  rec(0, {})
  return out
}

export function range(lo, hi) {
  const out = []
  for (let i = lo; i <= hi; i++) out.push(i)
  return out
}
