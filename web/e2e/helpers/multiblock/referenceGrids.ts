/**
 * **参考展开网格（ground-truth）的读入与逐格比对口径**。
 *
 * 参考网格来源：`scripts/multiblock-fixtures/validate-multiblock-fixtures.mjs --all --verify-grids`
 * 落盘的 552 份 `expanded-fixtures/<fixture>__<variant>.json`，每份形如
 * `{ variant, dims: {w,h,d}, cellGrid: number[][][], ... }`。
 * 该目录在 `.gitignore` 中（可再生）：本模块**只读**，缺失时给出确切再生命令（见 `resolveReferenceDir`）。
 *
 * ## 坐标朝向口径（防"看起来对齐其实是镜像"）
 *
 * 两边**同一口径**，不需要任何翻转：
 *  - 参考 `cellGrid[z][row][x]`（`lib.mjs` 的 `newGrid(w,h,d)` = `[z][y][x]`，装配写入用 `grid[z][y][x]`）
 *  - 渲染 `definition.cellGrid[zSlice][row][column]`（`@/render/schema/types.ts`）
 *  - 键 `row 0 = 结构顶部`，世界 Y = `structureRowToWorldY(row, height)` = `height-1-row`（`@/pure/vec`）。
 *
 * 即：**本模块不做任何 row/z 翻转或转置**；若两边朝向本来就不一致，diff 会立刻变红——
 * 这正是我们想要的（而不是被一段"看起来合理"的翻转掩盖）。
 *
 * ## 调色板下标 → 方块签名的对齐口径（关键，防同 name 同 meta 不同态错配）
 *
 * 两边下标空间**不同**：
 *  - 参考侧下标指向 fixture 的**并集调色板**（`inner.blockPalette`，EBF 9 条）；
 *  - 渲染侧下标指向 `_gridToV2` **重编号**后的调色板（只含该组合实际出现的方块，入口
 *    `buildMultiblockRenderView` 刻意不传并集调色板，否则下标错位 → 静默渲染错方块）。
 *
 * 对齐方式 = **内容签名**（`canonicalJson(entry)`：对象键排序、数组保序，与
 * `MeshCaptureService.entryEqualitySignature` / `lib.mjs#entrySignature` 同口径）：
 * 两边各自把"下标 → 签名"建表，再逐格比签名。**不假设两边下标编号相同**。
 *
 * ⚠️ **签名收缩**（必须在报告里如实说明，不得掩盖）：
 *  EBF 调色板下标 7 / 8 的 `registryId@meta` 完全相同
 *  （`gregtech:gt.blockmachines@1000`），仅 tooltip 不同（"Electric Blast Furnace" vs
 *  "(running)"）—— 故：
 *   - `signatureCollapsed`：参考里存在"不同签名 / 同 name:meta"的条目对（EBF 为 1）；
 *   - 逐格比对用**同一投影函数**比较（`signatureGrid` 的 `full` 与 `idMeta` 两口径都算，
 *     门禁用 `idMeta`，`full` 作为**非门禁**的更强证据记录）；
 *   - `name:meta` 口径**天然**无法区分"运行态把下标 7 写成 8"这类同 `name:meta` 的互换。
 *
 * ## 实测更正：下面这段旧结论**已被实测推翻**，保留以便对账
 *
 * > ~~该盲区没有任何 web 面判据覆盖……`full` 口径**不能**覆盖它 —— 实测渲染侧把调色板条目的
 * > `registryId` 统一归一为 `minecraft:` 前缀，故 `full` 对参考侧**恒有差异**（实测 18/18、
 * > 9/9、6/6）⇒ 它在渲染面没有分辨力……⇒ 结论：EBF 的 216 对运行态组合在 web 渲染面
 * > **结构性不可分辨**，属**产品侧缺口**（`context/grid.ts` 的调色板缓存按 `blockKey` =
 * > `name:meta` 归并 + `_gridToV2` 以该键去重），须另立单修 `src/`。~~
 *
 * 事实更正（实测，两处都是机械可复核的）：
 *
 * 1. **`minecraft:` 归一不成立**：渲染定义的调色板条目保留原 `registryId`
 *    （实测控制器条目 = `gregtech:gt.blockmachines@1000`，且带 `geometry`/`tooltip`/`nbt`）；
 *    对"仅改运行态"那一对组合，`full` 口径**参考 vs 渲染逐格 diff = 0/9（两态皆 0）**
 *    —— 即本文件原先"`full` 恒有差异、没有分辨力"的记录是**陈旧实测**，已不适用。
 * 2. **缺口位置不是调色板归并**：`_fromV2CellGrid` 以**下标**（`'#'+i`）建缓存、`blockKey`
 *    对反序列化方块返回 `'#'+paletteIndex`，故 7/8 **不会**被归并；真正的缺口在**失效判定
 *    读面**（`runtime/presentationAdapter#readContentIdentity` 的结构摘要只含名称级调色板
 *    身份）⇒ 渲染链从不重解（`planContentRebuild` 全 false）。已修（补内容级调色板项）。
 *
 * ⇒ 因此**见证/盲轴口径改用 `full`**（内容级）：EBF 的运行态轴**不再登记为盲轴**，
 * `KNOWN_BLIND_AXES['multiblock-ebf-2ch.json'] = []`（见 `reducedTraversal.ts` 文件头）。
 * 逐格**门禁**仍用 `idMeta`（跨实现的稳定身份），`full` 继续作非门禁证据。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { MULTIBLOCK_CONTRACTS, contractFor, type MultiblockFixtureContract } from './contract'

const HERE = import.meta.dirname
/** `web/`。 */
const WEB_ROOT = path.resolve(HERE, '..', '..', '..')
/** `scripts/multiblock-fixtures/.out/expanded-fixtures`。 */
export const REFERENCE_DIR = path.resolve(WEB_ROOT, '..', 'scripts', 'multiblock-fixtures', '.out', 'expanded-fixtures')

/** 参考目录缺失时给出的确切再生命令（不是"跳过"）。 */
export const REGENERATE_COMMAND = 'node scripts/multiblock-fixtures/validate-multiblock-fixtures.mjs --all --verify-grids'

export interface Dims {
  w: number
  h: number
  d: number
}

/** 参考网格文件形状。 */
export interface ReferenceGridFile {
  variant: string
  dims: Dims
  cellGrid: number[][][]
}

/** 方块签名（两种口径，见文件头注释）。 */
export interface BlockSignature {
  /** `canonicalJson(entry)` —— 与参考蓝本/捕获侧同口径，能区分 7/8（tooltip 不同）。 */
  full: string
  /** `name:meta`（`air` → `''`）—— 渲染管线 `SlotBlock` 实际保留的信息，逐格门禁用这个。 */
  idMeta: string
}

/** 逐格签名网格（`[z][row][x]`，与 `cellGrid` 同形同序）。 */
export interface SignatureGrid {
  d: number
  h: number
  w: number
  /** `rows[z][row][x]`。 */
  rows: string[][][]
}

/**
 * 签名 grid 的口径。
 *
 * - `idMeta`（**门禁**）：`name:meta`，`air` → `''`。这是渲染侧真正携带的方块身份
 *   （`Grid` 的 `SlotBlock = {name, meta}`），也是唯一稳定的比对口径。
 * - `full`（**非门禁**）：`canonicalJson(entry)`，但 **air 一律映射为 `''`**
 *   （见 `paletteSignatures`：参考侧 air 是一条带 `geometry/tooltip` 的完整条目，
 *   渲染侧 air 只有 `{registryId:'air',meta:0}` —— 若把 air 的全文算进去，
 *   每个含空气格的组合都会"差异"，把真正的差异淹没在噪声里）。
 *   `full` 用于把**同 `name:meta` 但内容不同**的条目（如 EBF 运行态 tooltip/nbt）也纳入比对。
 */
export type SignatureMode = 'full' | 'idMeta'

/** 规范化 JSON：对象键排序，数组顺序保留（与 `lib.mjs#canonicalJson` 逐字对齐）。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>
    const keys = Object.keys(rec).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(rec[k])).join(',') + '}'
  }
  return JSON.stringify(value === undefined ? null : value)
}

/** 一个调色板条目的两种签名口径（下标越界 → 标记 `?<idx>`，绝不静默当作 air）。 */
export function paletteSignatures(entries: unknown[]): BlockSignature[] {
  return entries.map((e) => {
    const rec = (e ?? {}) as Record<string, unknown>
    const rid = typeof rec.registryId === 'string' ? rec.registryId : ''
    const colon = rid.indexOf(':')
    const name = colon >= 0 ? rid.slice(colon + 1) : rid
    const meta = Number(rec.meta ?? 0)
    const isAir = name === '' || name === 'air' || name === 'Air'
    return { full: canonicalJson(e), idMeta: isAir ? '' : `${name}:${meta}` }
  })
}

/** `名字@meta`（报告人读用；同 `name:meta` 但保留 `@` 形态，便于与既有报告对照）。 */
export function paletteLabels(entries: unknown[]): string[] {
  return entries.map((e) => {
    const rec = (e ?? {}) as Record<string, unknown>
    const rid = typeof rec.registryId === 'string' ? rec.registryId : ''
    const colon = rid.indexOf(':')
    const name = colon >= 0 ? rid.slice(colon + 1) : rid
    return `${name}@${Number(rec.meta ?? 0)}`
  })
}

/** 判断传入的是已算好的签名表还是原始调色板条目。 */
function asSignatures(palette: unknown[] | BlockSignature[]): BlockSignature[] {
  const isSignatures = palette.every(
    (p) => p !== null && typeof p === 'object' && 'full' in (p as object) && 'idMeta' in (p as object),
  )
  return isSignatures ? (palette as BlockSignature[]) : paletteSignatures(palette)
}

/** 把 `[z][row][x]` 下标网格 + 调色板 → 签名网格（越界下标记为 `?<idx>`，必然与被比对方不等）。 */
export function signatureGrid(
  cellGrid: number[][][],
  palette: unknown[] | BlockSignature[],
  mode: SignatureMode,
): SignatureGrid {
  const sigs = asSignatures(palette)
  const rows = cellGrid.map((slice) =>
    slice.map((row) =>
      row.map((idx) => {
        const s = sigs[idx]
        if (!s) return `?${String(idx)}`
        // air 在两种口径下都归一为空串：参考侧 air 是完整条目、渲染侧只有 {registryId,meta}，
        // 把它的全文算进 full 口径只会让"每个含空气格的组合"都假红（见 SignatureMode 注释）。
        if (s.idMeta === '') return ''
        return s[mode]
      }),
    ),
  )
  return {
    d: rows.length,
    h: rows[0]?.length ?? 0,
    w: rows[0]?.[0]?.length ?? 0,
    rows,
  }
}

export interface GridDiff {
  /** 比对过的格数（按**期望**形状统计）。 */
  cells: number
  /** 差异条数（全量计数，`details` 只留前 N 条）。 */
  count: number
  /** 形状是否一致（不一致时 `shape` 给两边形状）。 */
  shape: string | null
  details: Array<{ x: number; y: number; z: number; got: string; want: string }>
}

/** 逐格比对签名网格（`[z][row][x]`，两边同口径）。 */
export function diffSignatureGrids(
  got: SignatureGrid,
  want: SignatureGrid,
  maxDetails = 8,
): GridDiff {
  const out: GridDiff = { cells: 0, count: 0, shape: null, details: [] }
  if (got.d !== want.d || got.h !== want.h || got.w !== want.w) {
    out.shape = `渲染 ${got.d}×${got.h}×${got.w}（[d,h,w]）≠ 参考 ${want.d}×${want.h}×${want.w}`
  }
  for (let z = 0; z < want.d; z++) {
    for (let y = 0; y < want.h; y++) {
      for (let x = 0; x < want.w; x++) {
        out.cells++
        const a = got.rows[z]?.[y]?.[x]
        const b = want.rows[z]?.[y]?.[x]
        if (a !== b) {
          out.count++
          if (out.details.length < maxDetails) {
            out.details.push({ x, y, z, got: String(a), want: String(b) })
          }
        }
      }
    }
  }
  return out
}

/** 逐格差异的可读摘要（失败信息用）。 */
export function describeGridDiff(diff: GridDiff): string {
  const head = diff.shape ? `${diff.shape}；` : ''
  const items = diff.details
    .map((d) => `(x=${d.x},row=${d.y},z=${d.z}) 渲染=${d.got} 参考=${d.want}`)
    .join(' | ')
  return `${head}差异 ${diff.count}/${diff.cells} 格${items ? `：${items}` : ''}`
}

// ---------------------------------------------------------------------------
// 参考目录 / fixture 内层文档
// ---------------------------------------------------------------------------

/** 参考目录是否可用（含 ≥1 份 `multiblock-*.json`）。 */
export function referenceDirReady(): boolean {
  try {
    return fs.readdirSync(REFERENCE_DIR).some((f) => f.startsWith('multiblock-') && f.endsWith('.json'))
  } catch {
    return false
  }
}

/**
 * 取参考目录；缺失时**抛错并给出确切再生命令**（绝不静默跳过验收）。
 */
export function resolveReferenceDir(): string {
  if (!referenceDirReady()) {
    throw new Error(
      `参考展开网格目录不存在或为空：${REFERENCE_DIR}\n` +
        `请先再生：cd ${WEB_ROOT} && cd .. && ${REGENERATE_COMMAND}`,
    )
  }
  return REFERENCE_DIR
}

/** 变体键 → 参考文件名（与 `--verify-grids` 的命名规则一字不差：`|`/`:` → `_`）。 */
export function referenceFileBase(fixtureFile: string, variantKey: string): string {
  return `${fixtureFile.replace(/\.json$/, '')}__${variantKey.replace(/[|:]/g, '_')}`
}

/** 参考网格文件路径。 */
export function referenceGridPath(fixtureFile: string, variantKey: string): string {
  return path.join(resolveReferenceDir(), `${referenceFileBase(fixtureFile, variantKey)}.json`)
}

/** fixture 内层 body（含 `blockPalette`；文件名取自钉死的契约表，只读）。 */
export interface FixtureInner {
  file: string
  contract: MultiblockFixtureContract
  /** 内层 body（`multiblock` / `blockPalette` / `frames` …）。 */
  inner: Record<string, unknown>
}

const INNER_CACHE = new Map<string, FixtureInner>()

/** 读 fixture 内层 body（缓存；仓库原件一字不改）。 */
export function loadFixtureInner(file: string): FixtureInner {
  const hit = INNER_CACHE.get(file)
  if (hit) return hit
  const c = contractFor(file)
  const p = path.resolve(WEB_ROOT, 'src', 'context', '__tests__', 'fixtures', c.file)
  const envelope = JSON.parse(fs.readFileSync(p, 'utf8')) as { payload: string }
  const inner = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')) as Record<string, unknown>
  const out: FixtureInner = { file: c.file, contract: c, inner }
  INNER_CACHE.set(file, out)
  return out
}

export function innerBlockPalette(inner: Record<string, unknown>): unknown[] {
  const pal = inner.blockPalette
  if (!Array.isArray(pal)) throw new Error('fixture 内层缺 blockPalette（并集调色板）')
  return pal
}

export function innerVariants(inner: Record<string, unknown>): Array<{ key: string; values: Record<string, number>; runstate?: string; totalTier?: number }> {
  const mb = inner.multiblock as Record<string, unknown>
  const variants = mb?.variants
  if (!Array.isArray(variants)) throw new Error('fixture 内层缺 multiblock.variants')
  return variants as Array<{ key: string; values: Record<string, number>; runstate?: string; totalTier?: number }>
}

// ---------------------------------------------------------------------------
// fixture 参考清单（一次读盘，供遍历用例查表）
// ---------------------------------------------------------------------------

/** 一个组合的参考基线。 */
export interface ReferenceVariant {
  variantKey: string
  dims: Dims
  /** 参考并集下标网格。 */
  cellGrid: number[][][]
  /** 参考签名网格（`idMeta` 口径，逐格门禁）。 */
  signature: SignatureGrid
  /** 参考签名网格（`full` 口径，更强的非门禁证据）。 */
  signatureFull: SignatureGrid
  /** 格数 = w×h×d。 */
  cells: number
}

export interface FixtureReference {
  file: string
  contract: MultiblockFixtureContract
  inner: Record<string, unknown>
  /** 并集调色板（参考下标空间）。 */
  palette: unknown[]
  /** 并集调色板的人读标签（报告用）。 */
  paletteLabels: string[]
  /** 参考里"不同签名 / 同 `name:meta`"的条目对（渲染侧必然合并 → 记录为已知盲区）。 */
  signatureCollapsed: Array<{ a: number; b: number; idMeta: string }>
  /** `variantKey → 参考基线`。 */
  byVariant: Map<string, ReferenceVariant>
  /** 参考文件里出现的变体键顺序（= 文件系统顺序，用作遍历顺序避免额外排序假设）。 */
  order: string[]
}

const FIXTURE_REF_CACHE = new Map<string, FixtureReference>()

/** 读一份 fixture 的**全部**参考网格（552 份里属于它的那部分）。 */
export function loadFixtureReference(file: string): FixtureReference {
  const hit = FIXTURE_REF_CACHE.get(file)
  if (hit) return hit
  const { contract, inner } = loadFixtureInner(file)
  const palette = innerBlockPalette(inner)
  const sigs = paletteSignatures(palette)
  const variants = innerVariants(inner)

  // 已知盲区：不同 full 签名但同 idMeta（渲染侧按 name:meta 归并，必然合并）
  const firstByIdMeta = new Map<string, number>()
  const signatureCollapsed: Array<{ a: number; b: number; idMeta: string }> = []
  sigs.forEach((s, i) => {
    if (s.idMeta === '') return
    const prev = firstByIdMeta.get(s.idMeta)
    if (prev === undefined) firstByIdMeta.set(s.idMeta, i)
    else if (sigs[prev]!.full !== s.full) signatureCollapsed.push({ a: prev, b: i, idMeta: s.idMeta })
  })

  const byVariant = new Map<string, ReferenceVariant>()
  const order: string[] = []
  for (const v of variants) {
    const p = referenceGridPath(contract.file, v.key)
    if (!fs.existsSync(p)) {
      throw new Error(
        `参考网格缺失 ${path.basename(p)}\n目录：${REFERENCE_DIR}\n再生：${REGENERATE_COMMAND}`,
      )
    }
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as ReferenceGridFile
    const signature = signatureGrid(raw.cellGrid, sigs, 'idMeta')
    byVariant.set(v.key, {
      variantKey: v.key,
      dims: raw.dims,
      cellGrid: raw.cellGrid,
      signature,
      signatureFull: signatureGrid(raw.cellGrid, sigs, 'full'),
      cells: raw.dims.w * raw.dims.h * raw.dims.d,
    })
    order.push(v.key)
  }

  const ref: FixtureReference = {
    file: contract.file,
    contract,
    inner,
    palette,
    paletteLabels: paletteLabels(palette),
    signatureCollapsed,
    byVariant,
    order,
  }
  FIXTURE_REF_CACHE.set(file, ref)
  return ref
}

/** 三份 fixture 的参考清单（一次读满 552 份）。 */
export function loadAllReferences(): Map<string, FixtureReference> {
  const out = new Map<string, FixtureReference>()
  for (const c of MULTIBLOCK_CONTRACTS) out.set(c.file, loadFixtureReference(c.file))
  return out
}

// ---------------------------------------------------------------------------
// 缺文件兜底：用**冻结蓝本** `scripts/multiblock-fixtures/lib.mjs` 就地补生成
// ---------------------------------------------------------------------------

/** `scripts/multiblock-fixtures/`（与参考实现蓝本同目录）。 */
export const FIXTURE_SCRIPT_DIR = path.resolve(WEB_ROOT, '..', 'scripts', 'multiblock-fixtures')

/** 已检查过"参考文件是否齐全"的 fixture（避免每个 use 都探测 552 次文件系统）。 */
const GENERATED_READY = new Set<string>()

/**
 * 列出某 fixture 缺失的参考文件（对比 `multiblock.variants` 的声明集合）。
 * 文件名规则与 `--verify-grids` 一字不差：`<fixture>__<variant 里 |/: → _>.json`。
 */
export function missingReferenceVariants(file: string): string[] {
  const { contract, inner } = loadFixtureInner(file)
  const out: string[] = []
  for (const v of innerVariants(inner)) {
    if (!fs.existsSync(referenceGridPath(contract.file, v.key))) out.push(v.key)
  }
  return out
}

/** 用冻结蓝本就地生成一份参考网格（写入 `.out/expanded-fixtures/`，与 `--verify-grids` 同实现）。 */
function writeReferenceFromLib(
  lib: { assembleVariant: (doc: unknown, key: string) => { dims: Dims; cellGrid: number[][][] } },
  file: string,
  variantKey: string,
): void {
  const { contract, inner } = loadFixtureInner(file)
  const res = lib.assembleVariant(inner, variantKey)
  fs.mkdirSync(REFERENCE_DIR, { recursive: true })
  fs.writeFileSync(
    referenceGridPath(contract.file, variantKey),
    JSON.stringify({ variant: variantKey, dims: res.dims, cellGrid: res.cellGrid }),
    'utf8',
  )
}

/**
 * 取一份 fixture 的参考清单；缺文件时先**就地补生成**再读（绝不静默跳过验收）。
 *
 * 为什么不是"缺了就跳过"：参考目录在 `.gitignore` 里（可再生），静默跳过会让
 * 「552 组合逐格 diff」在干净检出上退化成空跑 —— 那正是恒绿断言。
 * 兜底实现与 `validate-multiblock-fixtures.mjs --verify-grids` **同一份蓝本**
 * （`lib.mjs`），因此补出来的基准与 CI 重新生成的完全一致。
 */
export function snapshotOrFallbackReference(file: string): FixtureReference {
  if (!GENERATED_READY.has(file)) {
    const missing = missingReferenceVariants(file)
    if (missing.length > 0) {
      const libPath = path.join(FIXTURE_SCRIPT_DIR, 'lib.mjs')
      const script = [
        `const { readFileSync, mkdirSync, writeFileSync } = require('node:fs')`,
        `const { join, basename } = require('node:path')`,
        `const { pathToFileURL } = require('node:url')`,
        `void (async () => {`,
        `  const [libPath, fixturePath, refDir, keysJson] = process.argv.slice(1)`,
        `  const lib = await import(pathToFileURL(libPath).href)`,
        `  const raw = JSON.parse(readFileSync(fixturePath, 'utf8'))`,
        `  const inner = JSON.parse(Buffer.from(raw.payload, 'base64').toString('utf8'))`,
        `  mkdirSync(refDir, { recursive: true })`,
        `  for (const key of JSON.parse(keysJson)) {`,
        `    const res = lib.assembleVariant(inner, key)`,
        `    const name = basename(fixturePath, '.json') + '__' + key.replace(/[|:]/g, '_') + '.json'`,
        `    writeFileSync(join(refDir, name), JSON.stringify({ variant: key, dims: res.dims, cellGrid: res.cellGrid }), 'utf8')`,
        `  }`,
        `})()`,
      ].join('\n')
      const fixturePath = path.resolve(WEB_ROOT, 'src', 'context', '__tests__', 'fixtures', file)
      const r = spawnSync(
        process.execPath,
        ['-e', script, libPath, fixturePath, REFERENCE_DIR, JSON.stringify(missing)],
        { stdio: 'inherit' },
      )
      if (r.status !== 0) {
        throw new Error(
          `参考展开网格缺失 ${missing.length} 份且就地补生成失败（exit ${String(r.status)}）。\n` +
            `目录：${REFERENCE_DIR}\n请手动再生：${REGENERATE_COMMAND}`,
        )
      }
      console.warn(
        `[多方块] 参考展开网格缺失 ${missing.length} 份，已用冻结蓝本 lib.mjs 就地补生成（fixture=${file}）`,
      )
    }
    GENERATED_READY.add(file)
  }
  return loadFixtureReference(file)
}
