/**
 * T3.1 / T3.3 —— **真实导出产物**（T1.6 `/sde multiblock` 的产物）的读入、声明级期望值枚举、
 * 以及「web 装配网格 vs mod 展开校验文件」的逐格比对口径。
 *
 * 与 `contract.ts` / `referenceGrids.ts` 的分工：
 *  - `contract.ts` / `referenceGrids.ts`：**合成 fixture**（T0.5 产物）的钉死契约与参考网格（第二阶段已验收冻结）；
 *  - 本文件：**真实产物**（`mod/gtnh/run/client/sde_multiblock_exports/`，T1.6 产物）。
 *    真实产物组合规模远大于 fixture（5 台 / 1262 组合），故**期望值不硬编码**，
 *    而是**从产物 JSON 的声明节读取**（`multiblock.channels` / `totalTierDomain` / `tierSample` /
 *    `runstates` / `variants` / `backbone.sizeSteps[].{w,hh,d}`）。
 *
 * ## 反同义反复（anti-tautology）的边界 —— 必须说清楚
 *
 * 期望值确实来自被测文件的**声明节**，但断言目标是：
 *
 *   > **UI / 解析器忠实呈现文件声明**（而不是"文件本身正确"）。
 *
 * 因此这是**合法**的期望值来源：篡改声明节（如删一条通道、改一个呈现名、改总 Tier 域）
 * 会让"声明 → 面板"这条链上的断言变红；而"文件声明是否与游戏内真实多方块一致"
 * 由 T1.5/T1.6 的导出期自检（`verify-encoded.mjs` / `validate-multiblock-fixtures.mjs`）承担，
 * 不在本文件职责内。`multiblock-real-acceptance.spec.ts` 的证伪用例覆盖了这一边界。
 *
 * 三处**独立交叉自检**保证"从声明节枚举"这件事本身不是恒绿：
 *  1. `enumerateRealCombos()` 的枚举键集合必须**逐字等于** `multiblock.variants[].key` 集合；
 *  2. `expectedDimsFor()` 的尺寸来自 `frames[].stepIndex → backbone.sizeSteps[]`，
 *     与面板 `data-mb-dims` 互证（两条独立来源）；
 *  3. T3.3 的参考基线是 **mod 侧独立导出的展开网格文件**（另一进程、另一实现），
 *     不是本进程从声明节重算的结果。
 *
 * ## 环境变量接管（验收管线语义）
 *
 * `MB_REAL_EXPORTS_DIR` 指定产物目录；缺省 = `<repo>/mod/gtnh/run/client/sde_multiblock_exports`。
 * **目录缺失 / 无产物 / 展开清单缺失 / 展开文件缺失 → 抛错（显式失败）**，
 * 绝不静默跳过 —— 静默跳过会让"1262 组合遍历 + 35 组合逐格 diff"在干净检出上退化成空跑。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { WEB_ROOT, type MultiblockFixtureEnvelope } from './contract'
import type { DocObservation } from './harness'
import type { ChannelPanelObservation } from './channels'
import {
  paletteLabels,
  paletteSignatures,
  type BlockSignature,
  type SignatureMode,
} from './referenceGrids'

/** 仓库根（`web/` 的上一级）。 */
export const REPO_ROOT = path.resolve(WEB_ROOT, '..')

/** 产物目录的环境变量名。 */
export const MB_REAL_EXPORTS_DIR_ENV = 'MB_REAL_EXPORTS_DIR'

/** 缺省产物目录（相对仓库根）。 */
export const DEFAULT_REAL_EXPORTS_DIR_REL = path.join(
  'mod',
  'gtnh',
  'run',
  'client',
  'sde_multiblock_exports',
)

/** 产物文件后缀（T1.5 `/sde multiblock` 的命名约定）。 */
export const REAL_PRODUCT_SUFFIX = '.multiblock.json'

/** 展开校验文件所在子目录（T1.6 留白 #10）。 */
export const EXPANDED_DIR_NAME = 'expanded'

/** 展开抽样清单文件名。 */
export const EXPANDED_MANIFEST_NAME = '_manifest.json'

/** 展开校验文件的 schema 断言值。 */
export const EXPANDED_SCHEMA = 'lightning.multiblock.expanded/1'

/** 产物缺失时给出的确切生成命令（不是"跳过"）。 */
export const REAL_EXPORT_COMMAND = 'npm run multiblock:export   # 仓库根；默认验收子集 5 台（≈3.5 min）'

// ---------------------------------------------------------------------------
// 产物目录解析（环境变量接管 + 缺产物硬失败）
// ---------------------------------------------------------------------------

export interface RealExportsDirInfo {
  dir: string
  source: 'env' | 'default'
  /** 环境变量原文（未设置 = null）。 */
  envValue: string | null
  /** 实际检查过的候选路径（失败信息里逐条列出）。 */
  candidates: string[]
}

function hasRealProducts(dir: string): boolean {
  try {
    return fs
      .readdirSync(dir)
      .some((f) => f.endsWith(REAL_PRODUCT_SUFFIX) && fs.statSync(path.join(dir, f)).isFile())
  } catch {
    return false
  }
}

/**
 * 解析产物目录（**不抛错**，供诊断/自检用例使用；正常路径用 `resolveRealExportsDir()`）。
 *
 * 相对路径的解析顺序：① 仓库根；② 进程 CWD。两者都试（`MB_REAL_EXPORTS_DIR` 既可能写成
 * 仓库根相对路径，也可能在 `cd web` 之后写成 `../mod/...`）。
 */
export function resolveRealExportsDirInfo(): RealExportsDirInfo {
  const envValue = (process.env[MB_REAL_EXPORTS_DIR_ENV] ?? '').trim()
  const candidates: string[] = []
  if (envValue.length > 0) {
    candidates.push(path.isAbsolute(envValue) ? envValue : path.resolve(REPO_ROOT, envValue))
    if (!path.isAbsolute(envValue)) {
      const fromCwd = path.resolve(process.cwd(), envValue)
      if (!candidates.includes(fromCwd)) candidates.push(fromCwd)
    }
  } else {
    candidates.push(path.resolve(REPO_ROOT, DEFAULT_REAL_EXPORTS_DIR_REL))
  }
  for (const c of candidates) {
    if (hasRealProducts(c)) return { dir: c, source: envValue.length > 0 ? 'env' : 'default', envValue: envValue || null, candidates }
  }
  return {
    dir: candidates[0]!,
    source: envValue.length > 0 ? 'env' : 'default',
    envValue: envValue || null,
    candidates,
  }
}

/**
 * 取产物目录；**缺产物即显式失败**（验收管线语义：不静默跳过）。
 */
export function resolveRealExportsDir(): string {
  const info = resolveRealExportsDirInfo()
  if (hasRealProducts(info.dir)) return info.dir
  const checked = info.candidates
    .map((c) => `    - ${c}${fs.existsSync(c) ? '（存在，但没有 *' + REAL_PRODUCT_SUFFIX + ' 产物）' : '（不存在）'}`)
    .join('\n')
  throw new Error(
    `T3.1：真实导出产物目录不可用 —— 找不到任何 *${REAL_PRODUCT_SUFFIX} 产物。\n` +
      `  环境变量 ${MB_REAL_EXPORTS_DIR_ENV} = ${info.envValue === null ? '<未设置>' : JSON.stringify(info.envValue)}（来源：${info.source}）\n` +
      `  已检查的候选路径：\n${checked}\n` +
      `  验收管线语义：**产物缺失必须显式失败，不得静默跳过**。\n` +
      `  生成产物：${REAL_EXPORT_COMMAND}`,
  )
}

// ---------------------------------------------------------------------------
// 产物读入
// ---------------------------------------------------------------------------

export interface RealChannelDecl {
  key: string
  id: string
  enumName: string | null
  /** 呈现名（UI 标签；真实产物取 GT 枚举名，如 `HEATING_COIL`）。 */
  name: string
  kind: string
  /** 有效取值下界（解析器缺省 1，`size` 型必备）。 */
  min: number
  /** 有效取值上界（缺省 = 取值域上界）。 */
  max: number
  /** 是否生成滑杆（`hatch` 型不生成）。 */
  slider: boolean
  /** 滑杆下界（解析器口径恒 0 = `Not set`）。 */
  domainLo: number
  /** 滑杆上界 = `domain.max ?? totalTierDomain.max`（解析器口径）。 */
  domainHi: number
}

export interface RealRunstateDecl {
  id: string
  name: string
  materialSwap: boolean
}

export interface RealBackboneStep {
  channel: string
  w: number
  h: number
  d: number
  roles: Record<string, number>
  cellGrid: number[][][]
}

export interface RealFrameDecl {
  index: number
  variant: string
  runstate: string
  stepIndex: number
  rules: string[]
}

export interface RealProduct {
  /** 产物文件名（`<slug>.multiblock.json`）。 */
  file: string
  slug: string
  absPath: string
  /** 信封原件（可直接注入；`payload` 保持产物原样 = base64(gzip(json))）。 */
  envelope: MultiblockFixtureEnvelope
  /** 内层 body（含 `multiblock` / `blockPalette` / `frames`）。 */
  inner: Record<string, unknown>
  /** 信封 `meta`（含 `documentShape`）。 */
  meta: Record<string, unknown>
  documentShape: string | null
  displayName: string
  machineId: string | null
  sourceClass: string | null
  hasScopeOverlap: boolean
  channels: RealChannelDecl[]
  runstates: RealRunstateDecl[]
  totalTierDomain: { min: number; max: number; default: number | null }
  tierSample: number[]
  /** 文件声明的变体键（`variants[].key`，声明顺序）。 */
  variantKeys: string[]
  declaredKeys: Set<string>
  /** `variantKey → 该变体的 frame 声明（契约 §5.3）`。 */
  framesByVariant: Map<string, RealFrameDecl[]>
  /** `ruleId → 规则原文`。 */
  rules: Map<string, Record<string, unknown>>
  ruleCount: number
  /** 骨架阶（`backbone.sizeSteps`）。 */
  steps: RealBackboneStep[]
  sizeChannel: string
  blockPalette: unknown[]
  paletteSize: number
  noteCount: number
  couplingCount: number
  couplingMode: string
}

function asObject(v: unknown, what: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`T3.1：${what} 必须是对象（实际 ${Array.isArray(v) ? 'array' : typeof v}）`)
  }
  return v as Record<string, unknown>
}

function reqArray(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`T3.1：${what} 必须是数组`)
  return v
}

function reqString(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new Error(`T3.1：${what} 必须是字符串`)
  return v
}

function optNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 解码产物信封（T1.6 生产形态 = `base64(gzip(json))`；容忍 `base64(json)`）。 */
export function decodeProductInner(envelope: MultiblockFixtureEnvelope): Record<string, unknown> {
  const buf = Buffer.from(envelope.payload, 'base64')
  const text =
    buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8')
  return JSON.parse(text) as Record<string, unknown>
}

/** 用篡改后的内层 body 重建只存在于内存的产物信封（保持 `gzip+base64` 生产形态）。 */
export function rewrapProduct(
  envelope: MultiblockFixtureEnvelope,
  inner: Record<string, unknown>,
): MultiblockFixtureEnvelope {
  return {
    ...envelope,
    payload: zlib.gzipSync(Buffer.from(JSON.stringify(inner), 'utf8')).toString('base64'),
  }
}

/** 读一份产物（单文件，不做目录级校验）。 */
export function loadRealProduct(absPath: string): RealProduct {
  const file = path.basename(absPath)
  const envelope = JSON.parse(fs.readFileSync(absPath, 'utf8')) as MultiblockFixtureEnvelope
  const inner = decodeProductInner(envelope)
  const meta = asObject(envelope.meta ?? {}, `${file} 的 meta`)
  const mb = asObject(inner.multiblock, `${file} 的 inner.multiblock`)
  const totalTierRaw = asObject(mb.totalTierDomain, `${file} 的 totalTierDomain`)
  const totalTierDomain = {
    min: optNumber(totalTierRaw.min) ?? 1,
    max: optNumber(totalTierRaw.max) ?? 1,
    default: optNumber(totalTierRaw.default) ?? null,
  }
  // 通道：本文件不重实现解析器语义，只按契约 §4.2 复算"解析器会得到什么"
  // （domain.lo 恒 0；domain.hi = domain.max ?? 总 Tier 上界；min 缺省 1；max 缺省 = domain.hi）。
  const channels: RealChannelDecl[] = reqArray(mb.channels ?? [], `${file} 的 channels`).map((raw, i) => {
    const c = asObject(raw, `${file} 的 channels[${i}]`)
    const key = reqString(c.key, `${file} channels[${i}].key`)
    const kind = reqString(c.kind, `${file} 通道 ${key} 的 kind`)
    const dom = c.domain === undefined || c.domain === null ? null : asObject(c.domain, `${file} 通道 ${key} 的 domain`)
    const domainHi = dom === null ? totalTierDomain.max : (optNumber(dom.max) ?? totalTierDomain.max)
    const declaredMin = optNumber(c.min)
    const declaredMax = optNumber(c.max)
    return {
      key,
      id: reqString(c.id, `${file} 通道 ${key} 的 id`),
      enumName: typeof c.enum === 'string' ? c.enum : null,
      name: reqString(c.name, `${file} 通道 ${key} 的呈现名 name`),
      kind,
      min: declaredMin ?? 1,
      max: declaredMax ?? domainHi,
      slider: c.slider === undefined ? kind !== 'hatch' : c.slider === true,
      domainLo: 0,
      domainHi,
    } satisfies RealChannelDecl
  })

  const runstates: RealRunstateDecl[] = reqArray(mb.runstates ?? [], `${file} 的 runstates`).map((raw, i) => {
    const r = asObject(raw, `${file} 的 runstates[${i}]`)
    return {
      id: reqString(r.id, `${file} runstates[${i}].id`),
      name: reqString(r.name, `${file} runstates[${i}].name`),
      materialSwap: r.materialSwap === true,
    } satisfies RealRunstateDecl
  })

  const tierSampleRaw =
    Array.isArray(mb.tierSample) && mb.tierSample.length > 0
      ? (mb.tierSample as unknown[]).map((n) => Math.trunc(Number(n))).sort((a, b) => a - b)
      : Array.from(
          { length: totalTierDomain.max - totalTierDomain.min + 1 },
          (_, i) => totalTierDomain.min + i,
        )

  const variantKeys = reqArray(mb.variants ?? [], `${file} 的 variants`).map((raw, i) =>
    reqString(asObject(raw, `${file} variants[${i}]`).key, `${file} variants[${i}].key`),
  )

  const framesByVariant = new Map<string, RealFrameDecl[]>()
  for (const raw of reqArray(inner.frames ?? [], `${file} 的 frames`)) {
    const f = asObject(raw, `${file} 的 frames[]`)
    const decl: RealFrameDecl = {
      index: Math.trunc(Number(f.index ?? 0)),
      variant: reqString(f.variant, `${file} frames[].variant`),
      runstate: typeof f.runstate === 'string' ? f.runstate : '',
      stepIndex: Math.trunc(Number(f.stepIndex ?? 0)),
      rules: Array.isArray(f.rules) ? f.rules.map((r) => String(r)) : [],
    }
    const list = framesByVariant.get(decl.variant)
    if (list) list.push(decl)
    else framesByVariant.set(decl.variant, [decl])
  }

  const backbone = asObject(mb.backbone, `${file} 的 backbone`)
  const sizeChannel = reqString(backbone.sizeChannel, `${file} 的 backbone.sizeChannel`)
  const steps: RealBackboneStep[] = reqArray(backbone.sizeSteps, `${file} 的 backbone.sizeSteps`).map(
    (raw, i) => {
      const s = asObject(raw, `${file} sizeSteps[${i}]`)
      const cellGrid = reqArray(s.cellGrid, `${file} sizeSteps[${i}].cellGrid`) as number[][][]
      const h = optNumber(s.hh) ?? cellGrid[0]?.length ?? 0
      const w = optNumber(s.w) ?? cellGrid[0]?.[0]?.length ?? 0
      const d = optNumber(s.d) ?? cellGrid.length
      return {
        channel: typeof s.channel === 'string' ? s.channel : sizeChannel,
        w,
        h,
        d,
        roles:
          s.roles === undefined || s.roles === null
            ? {}
            : (asObject(s.roles, `${file} sizeSteps[${i}].roles`) as Record<string, number>),
        cellGrid,
      } satisfies RealBackboneStep
    },
  )

  const rules = new Map<string, Record<string, unknown>>()
  const ruleList = reqArray(mb.rules ?? [], `${file} 的 rules`)
  for (const raw of ruleList) {
    const r = asObject(raw, `${file} 的 rules[]`)
    rules.set(reqString(r.id, `${file} rules[].id`), r)
  }

  const blockPalette = Array.isArray(inner.blockPalette) ? (inner.blockPalette as unknown[]) : []

  return {
    file,
    slug: file.replace(/\.multiblock\.json$/, ''),
    absPath,
    envelope,
    inner,
    meta,
    documentShape: typeof meta.documentShape === 'string' ? meta.documentShape : null,
    displayName: reqString(mb.displayName, `${file} 的 displayName`),
    machineId: typeof mb.id === 'string' ? mb.id : null,
    sourceClass: typeof mb.sourceClass === 'string' ? mb.sourceClass : null,
    hasScopeOverlap: mb.hasScopeOverlap === true,
    channels,
    runstates,
    totalTierDomain,
    tierSample: tierSampleRaw,
    variantKeys,
    declaredKeys: new Set(variantKeys),
    framesByVariant,
    rules,
    ruleCount: ruleList.length,
    steps,
    sizeChannel,
    blockPalette,
    paletteSize: blockPalette.length,
    noteCount: Array.isArray(mb.notes) ? mb.notes.length : 0,
    couplingCount: Array.isArray(mb.couplings) ? mb.couplings.length : 0,
    couplingMode: typeof mb.couplingMode === 'string' ? mb.couplingMode : 'none',
  }
}

/** 目录里的全部产物（按 slug 排序，确定性）。 */
export function loadRealProducts(dir?: string): RealProduct[] {
  const d = dir ?? resolveRealExportsDir()
  const files = fs
    .readdirSync(d)
    .filter((f) => f.endsWith(REAL_PRODUCT_SUFFIX))
    .sort()
  if (files.length === 0) {
    throw new Error(
      `T3.1：产物目录 ${d} 里没有任何 *${REAL_PRODUCT_SUFFIX} 产物（显式失败，不静默跳过）。\n` +
        `  生成产物：${REAL_EXPORT_COMMAND}`,
    )
  }
  return files.map((f) => loadRealProduct(path.join(d, f)))
}

// ---------------------------------------------------------------------------
// 声明级期望值：组合枚举（与 variant 声明交叉自检）
// ---------------------------------------------------------------------------

export interface RealCombo {
  productFile: string
  slug: string
  /** 期望变体键（契约 §5.1：`<通道key>:<声明值>|…|tt:<Tier>|runstate:<id>`）。 */
  variantKey: string
  /** 通道声明值（含 0 = Not set）。 */
  values: Record<string, number>
  totalTier: number
  runstate: string
}

/** 变体键（契约 §5.1 的唯一派生规则；**本文件独立实现**，不调用被测代码）。 */
export function realVariantKey(
  channelOrder: readonly string[],
  values: Record<string, number>,
  runstate: string,
  totalTier: number,
): string {
  const parts = channelOrder.map((k) => `${k}:${values[k] ?? 0}`)
  parts.push(`tt:${totalTier}`)
  parts.push(`runstate:${runstate}`)
  return parts.join('|')
}

/**
 * 枚举一台真实产物的**全部已声明组合**：`∏(每通道 0..domain.hi) × tierSample × runstates`。
 *
 * 交叉自检（硬失败，不静默）：枚举出的键集合必须与 `multiblock.variants[].key` **逐字相等**。
 * 这条自检让"期望值来自声明节"这件事本身可被证伪 —— 若枚举规则与文件不一致（例如漏了未声明
 * 的通道值、或误解了 Tier 抽样语义），这里立刻报错而不是产生一批假绿。
 */
export function enumerateRealCombos(p: RealProduct): RealCombo[] {
  const channels = p.channels.filter((c) => c.slider)
  const nonSlider = p.channels.filter((c) => !c.slider)
  const keys = channels.map((c) => c.key)
  const out: RealCombo[] = []
  const values: Record<string, number> = {}
  for (const c of nonSlider) values[c.key] = 0

  const rec = (i: number): void => {
    if (i === channels.length) {
      for (const tt of p.tierSample) {
        for (const rs of p.runstates) {
          out.push({
            productFile: p.file,
            slug: p.slug,
            variantKey: realVariantKey(p.channels.map((c) => c.key), values, rs.id, tt),
            values: { ...values },
            totalTier: tt,
            runstate: rs.id,
          })
        }
      }
      return
    }
    const ch = channels[i]!
    for (let v = ch.domainLo; v <= ch.domainHi; v++) {
      values[ch.key] = v
      rec(i + 1)
    }
    delete values[ch.key]
  }
  rec(0)

  // ── 交叉自检：期望枚举 ↔ 文件声明的变体键集合 ──
  const got = out.map((c) => c.variantKey)
  const missing = p.variantKeys.filter((k) => !got.includes(k))
  const extra = got.filter((k) => !p.declaredKeys.has(k))
  const dupGot = got.filter((k, i) => got.indexOf(k) !== i)
  if (missing.length > 0 || extra.length > 0 || dupGot.length > 0) {
    throw new Error(
      `T3.1：${p.file} 的组合枚举与文件声明的变体键不一致（期望值表自相矛盾，禁止静默继续）。\n` +
        `  枚举 ${got.length} 条 / 声明 ${p.variantKeys.length} 条\n` +
        `  声明有而枚举无：${missing.slice(0, 4).join(', ') || '（无）'}\n` +
        `  枚举有而声明无：${extra.slice(0, 4).join(', ') || '（无）'}\n` +
        `  枚举重复：${dupGot.slice(0, 4).join(', ') || '（无）'}\n` +
        `  非滑杆通道（枚举时固定 0）：${nonSlider.map((c) => c.key).join(', ') || '（无）'}`,
    )
  }
  return out
}

/** 全量组合（5 台 1262 条；`sum === 1262` 由 spec 断言）。 */
export function enumerateAllRealCombos(products: RealProduct[]): RealCombo[] {
  return products.flatMap((p) => enumerateRealCombos(p))
}

/**
 * 抽样组合（mobile 项目 + 像素证据用；**固定、可复现、不随机**）。
 *
 * 规则：取值三档（`全 0` = Not set 基线 / 每通道有效下界 `ch.min` / 每通道取值域上界 `ch.domainHi`）
 * × Tier 两档（`tierSample` 首尾，去重）× 每个运行态。
 * 每台多为 3×2×2 = 12 条（单运行态/单 Tier 的机器自动退化）。
 *
 * **按变体键去重**：无通道的机器（BBF）三档取值完全相同 → 同一个变体键会出现 3 次；
 * 去重后 BBF 的抽样 = 2 条（= 它的全部变体）。
 */
export function sampleRealCombos(p: RealProduct): RealCombo[] {
  const channels = p.channels.filter((c) => c.slider)
  const picks: Array<Record<string, number>> = []
  const allZero: Record<string, number> = {}
  for (const c of p.channels) allZero[c.key] = 0
  picks.push(allZero)
  const allMin: Record<string, number> = { ...allZero }
  for (const c of channels) allMin[c.key] = c.min
  picks.push(allMin)
  const allHi: Record<string, number> = { ...allZero }
  for (const c of channels) allHi[c.key] = c.domainHi
  picks.push(allHi)

  const tierPicks = [...new Set([p.tierSample[0]!, p.tierSample[p.tierSample.length - 1]!])]
  const out: RealCombo[] = []
  const seen = new Set<string>()
  for (const values of picks) {
    for (const tt of tierPicks) {
      for (const rs of p.runstates) {
        const key = realVariantKey(p.channels.map((c) => c.key), values, rs.id, tt)
        if (!p.declaredKeys.has(key) || seen.has(key)) continue
        seen.add(key)
        out.push({
          productFile: p.file,
          slug: p.slug,
          variantKey: key,
          values: { ...values },
          totalTier: tt,
          runstate: rs.id,
        })
      }
    }
  }
  return out
}

/** 该组合的期望渲染尺寸 `w×h×d` —— 由 `frames[].stepIndex → backbone.sizeSteps[]` 派生（独立于装配器）。 */
export function expectedDimsFor(p: RealProduct, variantKey: string): { w: number; h: number; d: number } {
  const frames = p.framesByVariant.get(variantKey)
  if (!frames || frames.length === 0) {
    throw new Error(`T3.1：${p.file} 的变体 ${variantKey} 没有任何 frame（契约 §5.3 要求 ≥1）`)
  }
  const stepIndexes = [...new Set(frames.map((f) => f.stepIndex))]
  if (stepIndexes.length > 1) {
    throw new Error(
      `T3.1：${p.file} 的变体 ${variantKey} 的多个 frame 使用了不同骨架阶 ${JSON.stringify(stepIndexes)}，` +
        `无法派生唯一期望尺寸（需在契约层澄清）`,
    )
  }
  const step = p.steps[stepIndexes[0]!]
  if (!step) {
    throw new Error(
      `T3.1：${p.file} 的变体 ${variantKey} 的 stepIndex=${stepIndexes[0]} 越出 backbone.sizeSteps（${p.steps.length} 阶）`,
    )
  }
  return { w: step.w, h: step.h, d: step.d }
}

/** `w×h×d`（面板 `data-mb-dims` 的格式，与 `formatDims` 一字不差）。 */
export function dimsText(dims: { w: number; h: number; d: number }): string {
  return `${dims.w}×${dims.h}×${dims.d}`
}

// ---------------------------------------------------------------------------
// 像素门禁：相邻取值/运行态对照组的构造（抽样对）
// ---------------------------------------------------------------------------

export interface RealPixelPair {
  /** 可读标签（日志/证据文件名用）。 */
  label: string
  a: RealCombo
  b: RealCombo
  /** 这一对"变了什么"的语义说明（来自文件声明）。 */
  intent: string
}

/**
 * 构造像素对照组（**每台机器固定几对**，语义来自文件声明）：
 *  1. `运行态 idle→active`（所有运行态都在文件里声明过；两态的 cellGrid 至少下标不同）；
 *  2. `通道 <key>: 有效下界 → 取值域上界`（替换型/尺寸型通道换方块）；
 *  3. `Tier: 首档 → 次档`（未设置通道回落总 Tier ⇒ 内容随 Tier 变）。
 *
 * 每对在断言前会先核对**渲染内容确实不同**（前置条件），再断言**像素确实不同**（门禁）——
 * 因此这不是"随便挑一对"，而是"mod/装配侧说变了、画面必须也变"。
 */
export function pixelPairSpecs(p: RealProduct): RealPixelPair[] {
  const channels = p.channels.filter((c) => c.slider)
  const zeroValues: Record<string, number> = {}
  for (const c of p.channels) zeroValues[c.key] = 0
  const t0 = p.tierSample[0]!
  const mk = (values: Record<string, number>, totalTier: number, runstate: string): RealCombo => {
    const key = realVariantKey(p.channels.map((c) => c.key), values, runstate, totalTier)
    if (!p.declaredKeys.has(key)) {
      throw new Error(`T3.1：${p.file} 的像素对照组构造失败 —— 组合 ${key} 未在文件里声明`)
    }
    return { productFile: p.file, slug: p.slug, variantKey: key, values: { ...values }, totalTier, runstate }
  }

  const out: RealPixelPair[] = []
  const rs0 = p.runstates[0]
  const rs1 = p.runstates[1]
  if (rs0 && rs1) {
    out.push({
      label: `runstate-${rs0.id}-to-${rs1.id}`,
      a: mk(zeroValues, t0, rs0.id),
      b: mk(zeroValues, t0, rs1.id),
      intent: `运行态 ${rs0.name} → ${rs1.name}（两态在同一取值下的 cellGrid/调色板条目必须不同）`,
    })
  }
  for (const ch of channels) {
    const loValues = { ...zeroValues, [ch.key]: ch.min }
    const hiValues = { ...zeroValues, [ch.key]: ch.domainHi }
    if (ch.min === ch.domainHi) continue
    out.push({
      label: `channel-${ch.key}-${ch.min}-to-${ch.domainHi}`,
      a: mk(loValues, t0, rs0?.id ?? p.runstates[0]!.id),
      b: mk(hiValues, t0, rs0?.id ?? p.runstates[0]!.id),
      intent: `通道 ${ch.name}（${ch.key}）有效下界 ${ch.min} → 取值域上界 ${ch.domainHi}（替换/尺寸内容必须变）`,
    })
  }
  if (p.tierSample.length > 1) {
    const t1 = p.tierSample[1]!
    out.push({
      label: `tier-${t0}-to-${t1}`,
      a: mk(zeroValues, t0, rs0?.id ?? p.runstates[0]!.id),
      b: mk(zeroValues, t1, rs0?.id ?? p.runstates[0]!.id),
      intent: `总 Tier ${t0} → ${t1}（未设置通道回落总 Tier ⇒ 内容必须变）`,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 展开校验文件（T1.6 留白 #10）：清单 + 逐格比对口径
// ---------------------------------------------------------------------------

export interface ExpandedSample {
  variant: string
  /** 相对产物目录的路径（`expanded/<slug>.multiblock__<variant>.json`）。 */
  file: string
  dims: { w: number; h: number; d: number }
  values: Record<string, number>
  totalTier: number
  runstate: string
  why: string[]
  cells: number
}

export interface ExpandedMachine {
  slug: string
  machine: string
  displayName: string
  productFile: string
  variantTotal: number
  channels: Array<Record<string, unknown>>
  runstates: string[]
  tierSample: number[]
  samples: ExpandedSample[]
}

export interface ExpandedManifest {
  path: string
  schema: string
  coordinateConvention: string
  totalSamples: number
  machines: ExpandedMachine[]
}

/** 读 T1.6 的展开抽样清单；缺失即**显式失败**。 */
export function loadExpandedManifest(dir?: string): ExpandedManifest {
  const d = dir ?? resolveRealExportsDir()
  const p = path.join(d, EXPANDED_DIR_NAME, EXPANDED_MANIFEST_NAME)
  if (!fs.existsSync(p)) {
    throw new Error(
      `T3.3：找不到展开抽样清单 ${p}\n` +
        `  展开校验文件是 mod 侧独立导出的 ground-truth（T1.6 留白 #10），缺失时逐格 diff 无从谈起 —— 显式失败，不静默跳过。\n` +
        `  生成产物：${REAL_EXPORT_COMMAND}`,
    )
  }
  const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
  const schema = String(raw.schema ?? '')
  if (schema !== EXPANDED_SCHEMA) {
    throw new Error(`T3.3：展开清单 schema 必须为 ${EXPANDED_SCHEMA}（实际 ${schema}）`)
  }
  const machines: ExpandedMachine[] = reqArray(raw.machines, '展开清单 machines').map((m, i) => {
    const o = asObject(m, `展开清单 machines[${i}]`)
    return {
      slug: reqString(o.slug, `展开清单 machines[${i}].slug`),
      machine: String(o.machine ?? ''),
      displayName: String(o.displayName ?? ''),
      productFile: reqString(o.productFile, `展开清单 machines[${i}].productFile`),
      variantTotal: Math.trunc(Number(o.variantTotal ?? 0)),
      channels: reqArray(o.channels ?? [], `展开清单 machines[${i}].channels`) as Array<Record<string, unknown>>,
      runstates: (reqArray(o.runstates ?? [], `展开清单 machines[${i}].runstates`) as unknown[]).map(String),
      tierSample: (reqArray(o.tierSample ?? [], `展开清单 machines[${i}].tierSample`) as unknown[]).map((n) =>
        Math.trunc(Number(n)),
      ),
      samples: reqArray(o.samples ?? [], `展开清单 machines[${i}].samples`).map((s, j) => {
        const so = asObject(s, `展开清单 machines[${i}].samples[${j}]`)
        const dims = asObject(so.dims, `展开清单 samples[${j}].dims`)
        return {
          variant: reqString(so.variant, `展开清单 samples[${j}].variant`),
          file: reqString(so.file, `展开清单 samples[${j}].file`),
          dims: {
            w: Math.trunc(Number(dims.w ?? 0)),
            h: Math.trunc(Number(dims.h ?? 0)),
            d: Math.trunc(Number(dims.d ?? 0)),
          },
          values: (so.values ?? {}) as Record<string, number>,
          totalTier: Math.trunc(Number(so.totalTier ?? 0)),
          runstate: String(so.runstate ?? ''),
          why: Array.isArray(so.why) ? so.why.map(String) : [],
          cells: Math.trunc(Number(so.cells ?? 0)),
        } satisfies ExpandedSample
      }),
    }
  })
  return {
    path: p,
    schema,
    coordinateConvention: String(raw.coordinateConvention ?? ''),
    totalSamples: machines.reduce((n, m) => n + m.samples.length, 0),
    machines,
  }
}

/** 一份展开校验文件（ground-truth）。 */
export interface ExpandedGrid {
  file: string
  variant: string
  dims: { w: number; h: number; d: number }
  /** `cellGrid[z][row][x]`，下标空间 = **全局并集调色板**。 */
  cellGrid: number[][][]
  /**
   * 全局下标 → 内容签名（**稠密数组**，下标即全局下标）。
   * `full` = 文件内联的 `canonicalJson(entry)` 原文（逐字节取用，不重新 stringify）；
   * `idMeta` = 由该签名 JSON 解析出的 `name:meta`（`air` → `''`）。
   */
  signatures: BlockSignature[]
  /** 全局下标 → 人读标签（`name@meta`，报告用；文件缺该下标时为空串）。 */
  labels: string[]
  /** 网格里用到、但文件内联签名表里**没有**的下标（非空 = 映射不上 = 硬失败）。 */
  unmappedIndices: number[]
  /** 标签与签名 JSON 推出的 `idMeta` 不一致的下标（非空 = 对齐口径自相矛盾 = 硬失败）。 */
  labelConflicts: Array<{ index: number; labelMeta: string; signatureMeta: string }>
  entryCount: number
  totalCells: number
}

/** `name@meta` → `name:meta`（`air` → `''`）；与 `paletteSignatures` 同口径。 */
export function idMetaOfLabel(label: string): string {
  const at = label.lastIndexOf('@')
  const name = at >= 0 ? label.slice(0, at) : label
  const meta = at >= 0 ? label.slice(at + 1) : '0'
  if (name === '' || name === 'air' || name === 'Air') return ''
  return `${name}:${meta}`
}

/** 读一份展开校验文件并建"全局下标 → 内容签名"表（映射不上/标签冲突 → 记录，由断言判硬失败）。 */
export function loadExpandedGrid(dir: string, sample: ExpandedSample): ExpandedGrid {
  const p = path.isAbsolute(sample.file) ? sample.file : path.join(dir, sample.file)
  if (!fs.existsSync(p)) {
    throw new Error(
      `T3.3：展开校验文件缺失 ${p}（清单里声明了它）—— 显式失败，不静默跳过。\n` +
        `  生成产物：${REAL_EXPORT_COMMAND}`,
    )
  }
  const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
  const cellGrid = reqArray(raw.cellGrid, `${path.basename(p)} 的 cellGrid`) as number[][][]
  const palette = asObject(raw.palette, `${path.basename(p)} 的 palette`)
  const sigByIdx = asObject(palette.signatures, `${path.basename(p)} 的 palette.signatures`) as Record<string, string>
  const labelsRaw =
    palette.labels === undefined || palette.labels === null ? {} : (palette.labels as Record<string, string>)

  const used = new Set<number>()
  for (const slice of cellGrid) for (const row of slice) for (const idx of row) used.add(idx)

  const maxIdx = used.size === 0 ? -1 : Math.max(...used)
  const signatures: BlockSignature[] = []
  const labels: string[] = []
  const unmappedIndices: number[] = []
  const labelConflicts: Array<{ index: number; labelMeta: string; signatureMeta: string }> = []
  for (let i = 0; i <= maxIdx; i++) {
    const full = sigByIdx[String(i)]
    if (full === undefined) {
      // 没有签名 = 映射不上：绝不当作 air 放过
      if (used.has(i)) unmappedIndices.push(i)
      const missing = `?unmapped-index-${i}`
      signatures.push({ full: missing, idMeta: missing })
      labels.push('')
      continue
    }
    let idMeta = ''
    try {
      idMeta = paletteSignatures([JSON.parse(full) as unknown])[0]!.idMeta
    } catch {
      idMeta = `?unparsable-signature-${i}`
    }
    signatures.push({ full, idMeta })
    const label = typeof labelsRaw[String(i)] === 'string' ? labelsRaw[String(i)]! : ''
    labels.push(label)
    if (label !== '') {
      const labelMeta = idMetaOfLabel(label)
      // 两条独立对齐来源（标签 / 签名 JSON）必须一致，否则"下标 → 内容"这件事本身不可信
      if (labelMeta !== idMeta) labelConflicts.push({ index: i, labelMeta, signatureMeta: idMeta })
    }
  }

  const dims = {
    w: Math.trunc(Number((raw.dims as Record<string, unknown>)?.w ?? 0)),
    h: Math.trunc(Number((raw.dims as Record<string, unknown>)?.h ?? 0)),
    d: Math.trunc(Number((raw.dims as Record<string, unknown>)?.d ?? 0)),
  }
  let totalCells = 0
  for (const slice of cellGrid) for (const row of slice) for (const _ of row) totalCells++

  return {
    file: sample.file,
    variant: String(raw.variant ?? ''),
    dims,
    cellGrid,
    signatures,
    labels,
    unmappedIndices,
    labelConflicts,
    entryCount: Math.trunc(Number(palette.entryCount ?? 0)),
    totalCells,
  }
}

/** 逐格差异的一条明细（**带两边各自的下标与调色板条目**，契约 §T3.3 的报告要求）。 */
export interface RealGridMismatch {
  x: number
  row: number
  z: number
  /** 渲染侧下标 + 条目人读标签 + 签名。 */
  renderedIndex: number | null
  renderedEntry: string
  renderedSignature: string
  /** 参考（展开文件）侧全局下标 + 条目人读标签 + 签名。 */
  referenceIndex: number | null
  referenceEntry: string
  referenceSignature: string
}

export interface RealGridDiff {
  mode: SignatureMode
  /** 比对格数（按**参考**形状统计，与 `diffSignatureGrids` 同口径）。 */
  cells: number
  count: number
  /** 形状不一致时的描述（null = 形状一致）。 */
  shape: string | null
  details: RealGridMismatch[]
  /** 映射不上的参考下标（非空 = 硬失败，禁止当作 air）。 */
  unmappedIndices: number[]
}

/**
 * web 渲染网格 vs mod 展开校验文件**逐格 diff**（T3.3 的核心）。
 *
 * 对齐口径（与 `referenceGrids.ts` 文件头同口径，逐条对齐）：
 *  - 坐标：两边同一口径 `cellGrid[z][row][x]`，`row 0 = 结构顶部`，**不做任何翻转/转置**；
 *  - 下标空间：两边**不同**（渲染侧是 `_gridToV2` 按本组合重编号后的调色板；参考侧是全局并集），
 *    故先把两边各自映射为**内容签名**再逐格比签名（`mode = 'idMeta'` 为门禁，`'full'` 为更强旁证）；
 *  - 映射不上（参考用了签名表里没有的下标）→ `unmappedIndices` 非空，属**硬失败**。
 */
export function diffRenderedVsExpanded(
  rendered: { cellGrid: number[][][]; palette: unknown[] },
  expanded: ExpandedGrid,
  mode: SignatureMode = 'idMeta',
  maxDetails = 8,
): RealGridDiff {
  const renderedSigs = paletteSignatures(rendered.palette)
  const renderedLabels = paletteLabels(rendered.palette)
  const sigOf = (sigs: BlockSignature[], idx: number, m: SignatureMode): string => {
    const s = sigs[idx]
    if (!s) return `?index-${idx}`
    if (s.idMeta === '') return '' // air：两侧都归一为空串
    return s[m]
  }

  const got = rendered.cellGrid
  const want = expanded.cellGrid
  const out: RealGridDiff = {
    mode,
    cells: 0,
    count: 0,
    shape: null,
    details: [],
    unmappedIndices: [...expanded.unmappedIndices],
  }
  const gd = got.length
  const gh = gd > 0 ? got[0]!.length : 0
  const gw = gh > 0 ? got[0]![0]!.length : 0
  const wd = want.length
  const wh = wd > 0 ? want[0]!.length : 0
  const ww = wh > 0 ? want[0]![0]!.length : 0
  if (gd !== wd || gh !== wh || gw !== ww) {
    out.shape = `渲染 ${gd}×${gh}×${gw}（[d,h,w]）≠ 参考 ${wd}×${wh}×${ww}`
  }
  for (let z = 0; z < wd; z++) {
    for (let row = 0; row < wh; row++) {
      for (let x = 0; x < ww; x++) {
        out.cells++
        const ri = got[z]?.[row]?.[x]
        const wi = want[z]?.[row]?.[x]
        const a = ri === undefined ? `?out-of-range` : sigOf(renderedSigs, ri, mode)
        const b = wi === undefined ? `?out-of-range` : sigOf(expanded.signatures, wi, mode)
        if (a !== b) {
          out.count++
          if (out.details.length < maxDetails) {
            out.details.push({
              x,
              row,
              z,
              renderedIndex: ri ?? null,
              renderedEntry: ri === undefined ? '' : (renderedLabels[ri] ?? ''),
              renderedSignature: a,
              referenceIndex: wi ?? null,
              referenceEntry: wi === undefined ? '' : (expanded.labels[wi] ?? ''),
              referenceSignature: b,
            })
          }
        }
      }
    }
  }
  return out
}

/** 逐格差异的可读摘要（失败信息用；含坐标 + 两边下标 + 两边调色板条目）。 */
export function describeRealGridDiff(diff: RealGridDiff): string {
  const head = diff.shape ? `${diff.shape}；` : ''
  const items = diff.details
    .map(
      (d) =>
        `(x=${d.x},row=${d.row},z=${d.z}) 渲染[${d.renderedIndex ?? '-'}]=${d.renderedEntry || d.renderedSignature.slice(0, 40)} ` +
        `vs 参考[${d.referenceIndex ?? '-'}]=${d.referenceEntry || d.referenceSignature.slice(0, 40)}`,
    )
    .join(' | ')
  const unmapped = diff.unmappedIndices.length > 0 ? `；映射不上的参考下标 ${JSON.stringify(diff.unmappedIndices)}` : ''
  return `${head}口径=${diff.mode} 差异 ${diff.count}/${diff.cells} 格${items ? `：${items}` : ''}${unmapped}`
}

/**
 * 渲染调色板里"无法从展开文件的内容签名集合派生"的条目（空 = 渲染只用了 mod 侧声明过的方块身份）。
 *
 * 与第二阶段 `unknownPaletteEntries` 同精神，但参考集来自**展开文件的签名表**（30 台机器共用一份全局并集，
 * 单机只用其中一部分），且口径用 `name:meta`（渲染侧 `Grid`/`SlotBlock` 真正携带的身份）。
 * 另有护栏：渲染调色板下标 0 必须是 air（契约 §6.1）。
 */
export function unknownRenderedEntries(
  rendered: { palette: unknown[] },
  expanded: ExpandedGrid,
): string[] {
  const known = new Set(
    expanded.signatures.map((s) => s.idMeta).filter((s) => s !== ''),
  )
  const out: string[] = []
  const sigs = paletteSignatures(rendered.palette)
  sigs.forEach((s) => {
    if (s.idMeta === '') return
    if (!known.has(s.idMeta)) out.push(s.idMeta)
  })
  const first = sigs[0]
  if (!first || first.idMeta !== '') out.push('渲染调色板下标 0 必须是 air（契约 §6.1）')
  return out
}

// ---------------------------------------------------------------------------
// 声明 → UI/解析 的一致性谓词（纯函数；证伪用例复用）
// ---------------------------------------------------------------------------

/** 面板初始选中：Tier = clamp(`default ?? max`) 吸附 `tierSample`；通道全 0；运行态 = 首项。 */
export function expectedInitialSelection(p: RealProduct): {
  tier: number
  values: Record<string, number>
  runstate: string
  variantKey: string
} {
  const rawDefault = Math.trunc(p.totalTierDomain.default ?? p.totalTierDomain.max)
  const inDomain = Math.min(Math.max(rawDefault, p.totalTierDomain.min), p.totalTierDomain.max)
  const tier = snapToSample(p.tierSample, inDomain)
  const values: Record<string, number> = {}
  for (const c of p.channels) values[c.key] = 0
  return {
    tier,
    values,
    runstate: p.runstates[0]?.id ?? '',
    variantKey: realVariantKey(p.channels.map((c) => c.key), values, p.runstates[0]?.id ?? '', tier),
  }
}

/** Tier 吸附（并列取较小者；与 `multiblockChannelUi.snapTierToSample` 同口径）。 */
export function snapToSample(samples: readonly number[], tier: number): number {
  if (samples.length === 0) return Math.trunc(tier)
  const target = Math.trunc(tier)
  let best = samples[0]!
  for (const v of samples) {
    const d = Math.abs(v - target)
    const bd = Math.abs(best - target)
    if (d < bd || (d === bd && v < best)) best = v
  }
  return best
}

/** 文档解析结果 ↔ 产物声明节的一致性（空 = 通过）。 */
export function realDeclarationViolations(doc: DocObservation, p: RealProduct): string[] {
  const v: string[] = []
  if (!doc.hasDoc) return [`${p.file}：doc 未加载`]
  if (!doc.isMultiblock) v.push(`doc.isMultiblock=${doc.isMultiblock}，期望 true`)
  if (!doc.multiblockSourcePresent) v.push('multiblockSource 为空（装配器输入缺失）')
  const cmp = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      v.push(`${label}=${JSON.stringify(got)}，期望 ${JSON.stringify(want)}（文件声明）`)
    }
  }
  cmp('通道条数', doc.channelCount, p.channels.length)
  cmp('通道 key', doc.channels.map((c) => c.key), p.channels.map((c) => c.key))
  cmp('通道 enum', doc.channels.map((c) => c.enumName), p.channels.map((c) => c.enumName))
  cmp('通道呈现名', doc.channels.map((c) => c.name), p.channels.map((c) => c.name))
  cmp('通道 kind', doc.channels.map((c) => c.kind), p.channels.map((c) => c.kind))
  cmp('通道有效下界 min', doc.channels.map((c) => c.min), p.channels.map((c) => c.min))
  cmp('通道有效上界 max', doc.channels.map((c) => c.max), p.channels.map((c) => c.max))
  cmp('通道滑杆域 lo', doc.channels.map((c) => c.domainLo), p.channels.map((c) => c.domainLo))
  cmp('通道滑杆域 hi', doc.channels.map((c) => c.domainHi), p.channels.map((c) => c.domainHi))
  cmp('通道滑杆可见', doc.channels.map((c) => c.slider), p.channels.map((c) => c.slider))
  cmp('运行态 id', doc.runstates.map((r) => r.id), p.runstates.map((r) => r.id))
  cmp('运行态呈现名', doc.runstates.map((r) => r.name), p.runstates.map((r) => r.name))
  cmp('运行态 materialSwap', doc.runstates.map((r) => r.materialSwap), p.runstates.map((r) => r.materialSwap))
  cmp('总 Tier 域', doc.totalTierDomain, { min: p.totalTierDomain.min, max: p.totalTierDomain.max, default: p.totalTierDomain.default })
  cmp('变体数', doc.variantCount, p.variantKeys.length)
  cmp('差异规则条数', doc.ruleCount, p.ruleCount)
  cmp('帧数 = 变体数（一变体一帧）', doc.frameCount, p.variantKeys.length)
  cmp('场景声明数', doc.multiblockSceneCount, p.variantKeys.length)
  cmp('并集调色板条目数', doc.blockPaletteSize, p.paletteSize)
  cmp('骨架 sizeChannel', doc.backbone?.sizeChannel ?? null, p.sizeChannel)
  cmp('骨架阶数', doc.backbone?.stepCount ?? null, p.steps.length)
  cmp(
    '骨架各阶 cellGrid 形状 [d,h,w]',
    (doc.backbone?.steps ?? []).map((s) => [s.d, s.h, s.w]),
    p.steps.map((s) => [s.d, s.h, s.w]),
  )
  cmp(
    '骨架各阶 cellGrid 逐格原文',
    (doc.backbone?.steps ?? []).map((s) => JSON.stringify(s.cellGrid)),
    p.steps.map((s) => JSON.stringify(s.cellGrid)),
  )
  if (doc.backboneMatchesSource !== true) {
    v.push(`decl.backbone 与 multiblockSource 原文不一致（backboneMatchesSource=${doc.backboneMatchesSource}）`)
  }
  if (doc.warnings.length > 0) v.push(`解析告警非空（内核源根重解析）：${doc.warnings.join(' | ')}`)
  // 伴随断言（R2/S3）：内容同一性 —— 与 `contract#declarationViolations` 同一口径
  // （"告警为空"必须连同"应用读的就是这份 body"一起成立）。
  if (doc.declarationMatchesSource !== true) {
    v.push(`应用侧声明与内核源根重解析不一致（declarationMatchesSource=${doc.declarationMatchesSource}）`)
  }
  return v
}

/** 通道面板 DOM ↔ 产物声明节的一致性（空 = 通过）。 */
export function realPanelViolations(panel: ChannelPanelObservation, p: RealProduct): string[] {
  const v: string[] = []
  if (!panel.present) return [`${p.file}：通道面板未挂载`]
  const sliders = p.channels.filter((c) => c.slider)
  const cmp = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      v.push(`${label}=${JSON.stringify(got)}，期望 ${JSON.stringify(want)}（文件声明）`)
    }
  }
  cmp('面板 displayName', panel.displayName, p.displayName)
  cmp('滑杆条数（= 声明 slider 通道数）', panel.channels.length, sliders.length)
  cmp('滑杆 key 顺序', panel.channels.map((c) => c.key), sliders.map((c) => c.key))
  cmp('滑杆标签（呈现名逐字）', panel.channels.map((c) => c.name), sliders.map((c) => c.name))
  cmp('滑杆 kind', panel.channels.map((c) => c.kind), sliders.map((c) => c.kind))
  cmp('滑杆 min（0 = Not set）', panel.channels.map((c) => c.sliderMin), sliders.map((c) => c.domainLo))
  cmp('滑杆 max（= 取值域上界）', panel.channels.map((c) => c.sliderMax), sliders.map((c) => c.domainHi))
  cmp('有效下界', panel.channels.map((c) => c.effMin), sliders.map((c) => c.min))
  cmp('有效上界', panel.channels.map((c) => c.effMax), sliders.map((c) => c.max))
  cmp('Tier 滑杆下界', panel.tierMin, p.totalTierDomain.min)
  cmp('Tier 滑杆上界', panel.tierMax, p.totalTierDomain.max)
  cmp('Tier 抽样清单', panel.tierSamples, p.tierSample)
  cmp('运行态选项 id', panel.runstateOptions.map((o) => o.id), p.runstates.map((r) => r.id))
  cmp('运行态选项呈现名', panel.runstateOptions.map((o) => o.name), p.runstates.map((r) => r.name))
  // 文件 notes 必须逐条呈现为"只提示不拒绝"的 notice（契约 §7.3）
  const notes = ((p.inner.multiblock as Record<string, unknown>).notes ?? []) as Array<{ text?: string }>
  for (const n of notes) {
    const text = String(n.text ?? '')
    if (!panel.notices.some((x) => x.includes(text))) {
      v.push(`文件 note 未呈现为面板提示：${text.slice(0, 60)}…`)
    }
  }
  return v
}

