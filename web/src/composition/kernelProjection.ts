/**
 * `composition/kernelProjection` —— **内核文档 → 旧发布格式**（G-3 反向编码器；#282 P10b）。
 *
 * ## 本模块解决什么
 *
 * 正向装配（`composition/kernelAssembly`）把旧文件读进内核。反向这一半同样必要，
 * 且是**两条**真实需求的共同前置：
 *
 * | 需求 | 依据 | 为什么必须反向 |
 * |---|---|---|
 * | 发布/导出闭环 | #249 §12；#282 执行范围第 5 条 | 产物必须是外部格式；内核 `Scene` 不是文件格式 |
 * | 呈现链消费内核内容 | #282 执行范围第 2 条 | 渲染后端吃的是"文档 plain JSON"（`drwMeshPipeline` 的 `doc.serialize()`），故内核内容要能投影回那个形状 |
 *
 * ## 三条设计判据
 *
 * ### 1. 反向编码**不是**"把装配的输入原样吐回"
 *
 * 内核文档是**权威**：用户可以在内核里改元数据/对象/资源（那才是"内核文档上可编辑"）。
 * 故反向编码必须**从内核值重建**，而不是缓存并回放原始 JSON —— 后者会让
 * "编辑了但导出还是旧的"成为一个必然的静默缺陷。
 *
 * 判据由 `kernelAssembly.test.ts` 的往返断言把守：改内核元数据后重新投影，
 * 产物里的元数据**必须**变。
 *
 * ### 2. 版本化：`format_version` 与形态键由**内容**决定，不由调用方声明
 *
 * 多方块文档（带 `multiblock` 声明）投影出 `documentShape: 'multiblock'` + 内层 body；
 * 帧为主文档投影出 `format_version: '2.0'` + 帧自带 `structure`。
 * 形态由 {@link KernelProjectionInput} 的 `multiblock` 是否存在**机械决定** ——
 * 让调用方传一个 `shape` 参数就会造出"声明与内容不符"的文件。
 *
 * ### 3. 未知字段经**保真记录**回写（不静默丢，也不塞回核心）
 *
 * #249 §12：未知字段"若必须往返保留，放在带源格式/源版本的适配器保真记录中"。
 * 故本模块接受一个可选的 {@link FidelityRecord}，把它记录的字段写回产物根 ——
 * 这是"往返保留"的实现，而记录本身**不进**内核文档（§15 第 2 条：
 * 核心无字段袋）。于是"保真"与"核心干净"同时成立。
 *
 * ## 纯度
 *
 * 无 IO、无 DOM、无时钟、不 import 任何旧层的**实现**（只吃旧层的类型与纯数据）。
 */

import type { Grid, SlotBlock } from '@/context/grid'
import { Grid as LegacyGrid } from '@/context/grid'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import { RuntimeDocument as LegacyRuntimeDocument, RuntimeFrame } from '@/context/runtimeDocument'
import { structureRowToWorldY } from '@/pure/vec'
import { AIR_PALETTE_INDEX } from '@/context/runtimeDocument'
import type { DocumentContent } from '@/domain/content'
import { findObject, findObjectData, objectsInOrder, type Scene, type SceneObject } from '@/domain/scene'

// ─────────────────────────────────────────────────────────────────────────────
// 方块单元键/值（与 `composition/kernelAssembly` 的 `blockCellKey`/`blockCellValue` 对偶）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `"x,y,z"` → 坐标；非法返回 `null`（不抛：坏数据是**显式**跳过，由诊断计数）。
 *
 * 与 `kernelAssembly#blockCellKey` 是**对偶**关系。两处的键格式必须一致，
 * 由 `kernelAssembly.test.ts` 的往返断言把守（装配 → 投影 → 再装配逐格一致）。
 */
export function parseBlockCellKey(key: string): { x: number; y: number; z: number } | null {
  const parts = key.split(',')
  if (parts.length !== 3) return null
  // 空段必须显式拒绝：`Number('')` 是 0，直接判 `Number.isInteger` 会让
  // `"1,2,"` 被静默读成 `(1,2,0)` —— 一次真实的坐标误读。
  if (parts.some((p) => p.trim() === '')) return null
  const x = Number(parts[0])
  const y = Number(parts[1])
  const z = Number(parts[2])
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return null
  return { x, y, z }
}

/**
 * `"minecraft:<name>:<meta>"` → 方块；非法返回 `null`。
 *
 * 与 `kernelAssembly#blockCellValue` 对偶。`meta` 缺省为 0（旧产物常只写名字）。
 * 前缀 `minecraft:` 可有可无（两种历史形态都接受）—— 但**必须**是
 * `<name>` 或 `<name>:<meta>` 两段式，多段（含命名空间以外冒号）判非法，
 * 因为那时"哪一段是 meta"不可判定，猜一个就是静默错读。
 */
export function parseBlockCellValue(value: string): { name: string; meta: number } | null {
  if (typeof value !== 'string' || value === '') return null
  const body = value.startsWith('minecraft:') ? value.slice('minecraft:'.length) : value
  const parts = body.split(':')
  if (parts.length === 1) return parts[0] === '' ? null : { name: parts[0], meta: 0 }
  if (parts.length === 2) {
    const meta = Number(parts[1])
    if (!Number.isInteger(meta) || parts[0] === '') return null
    return { name: parts[0], meta }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// blockGrid 对象 → 旧 (cellGrid, blockPalette)
// ─────────────────────────────────────────────────────────────────────────────

/** 一次网格投影的结果（下标网格 + 调色板 + 诊断计数）。 */
export interface ProjectedGrid {
  readonly cellGrid: number[][][]
  readonly blockPalette: Record<string, unknown>[]
  /** 无法解析的单元键/值数（**显式**计数，不静默吞）。 */
  readonly invalidCells: number
}

/**
 * 内核 `blockGrid` 载荷 → 旧 `(cellGrid, blockPalette)`。
 *
 * ## 坐标翻转（**唯一**的翻转点，与装配侧对偶）
 *
 * 内核 `cells` 的键是 Y-up 世界坐标（`y = 0` 为底）；旧 `cellGrid` 的
 * `row 0 = 顶部`。故 `row = sizeRow - 1 - y`，由
 * `pure/vec#structureRowToWorldY` 的**逆**给出 —— 这里直接用
 * `structureRowToWorldY(row, sizeRow) === y` 反解 `row`，即
 * `row = sizeRow - 1 - y`（该函数是自逆的：`f(f(r)) = r`）。
 *
 * 用同一个函数反解（而不是手写 `sizeRow - 1 - y`）是为了让"翻转只有一处定义"
 * 成为事实：翻转公式改了，两侧同时改。
 *
 * 调色板下标 0 恒为 air（与 `AIR_PALETTE_INDEX` 同源），故实体方块从 1 起编号。
 */
export function projectGridCells(cells: Readonly<Record<string, string>>): ProjectedGrid {
  // 先解析全部单元，求包围盒（尺寸由内容决定，不由调用方声明 —— 与"形态由内容决定"同一纪律）。
  const parsed: { x: number; y: number; z: number; name: string; meta: number }[] = []
  let invalidCells = 0
  for (const [key, value] of Object.entries(cells)) {
    const pos = parseBlockCellKey(key)
    const block = parseBlockCellValue(value)
    if (pos === null || block === null) {
      invalidCells += 1
      continue
    }
    parsed.push({ ...pos, ...block })
  }
  if (parsed.length === 0) {
    return { cellGrid: [], blockPalette: [airPaletteEntry()], invalidCells }
  }
  let maxX = 0
  let maxY = 0
  let maxZ = 0
  for (const c of parsed) {
    if (c.x > maxX) maxX = c.x
    if (c.y > maxY) maxY = c.y
    if (c.z > maxZ) maxZ = c.z
  }
  const width = maxX + 1
  const height = maxY + 1
  const depth = maxZ + 1

  // 调色板：按首次出现顺序编号（下标 0 保留给 air）—— 稳定且可复现。
  const blockPalette: Record<string, unknown>[] = [airPaletteEntry()]
  const indexByNameMeta = new Map<string, number>()
  const indexOf = (name: string, meta: number): number => {
    const key = `${name}\u0000${meta}`
    const hit = indexByNameMeta.get(key)
    if (hit !== undefined) return hit
    const idx = blockPalette.length
    indexByNameMeta.set(key, idx)
    blockPalette.push({ registryId: `minecraft:${name}`, meta, renderMode: 'BlockModel' })
    return idx
  }

  // 旧 cellGrid 的 row 序：row 0 = 顶部 ⇒ row = height - 1 - y。
  const cellGrid: number[][][] = []
  for (let z = 0; z < depth; z++) {
    const slice: number[][] = []
    for (let row = 0; row < height; row++) {
      slice.push(new Array(width).fill(AIR_PALETTE_INDEX))
    }
    cellGrid.push(slice)
  }
  for (const c of parsed) {
    const row = structureRowToWorldY(c.y, height)
    cellGrid[c.z]![row]![c.x] = indexOf(c.name, c.meta)
  }
  return { cellGrid, blockPalette, invalidCells }
}

function airPaletteEntry(): Record<string, unknown> {
  return { registryId: 'air', meta: AIR_PALETTE_INDEX, renderMode: 'BlockModel' }
}

/**
 * 由投影出的 `(cellGrid, blockPalette)` 重建一个旧 `Grid`。
 *
 * ## 为什么需要它（不能只吐 JSON）
 *
 * 渲染链（`resolveRenderBundle` → `StructureDefinition`）要的是**已解析的
 * `cellGrid` + `blockPalette`**，而不是 `Grid`。但**保存/导出**路径要的是
 * 可 `serialize()` 的文档，而 `RuntimeDocument.serialize()` 从 `Grid` 出发。
 *
 * ⇒ 本函数把投影结果装回旧模型，使"内核 → 旧文档"是一条**完整**通路
 * （而不是只够喂渲染、不够保存的半条）。行序翻转在此**再次**用
 * `structureRowToWorldY` 反解 —— 与 `projectGridCells` 同一个函数，
 * 故两处不可能漂移。
 */
export function projectToLegacyGrid(cells: Readonly<Record<string, string>>): { grid: Grid; invalidCells: number } {
  const projected = projectGridCells(cells)
  const depth = projected.cellGrid.length
  const height = projected.cellGrid[0]?.length ?? 0
  const width = projected.cellGrid[0]?.[0]?.length ?? 0
  const paletteCache = new Map<string, import('@/pure/gridTypes').PaletteEntryMeta>()
  for (let i = 0; i < projected.blockPalette.length; i++) {
    const entry = projected.blockPalette[i]!
    const rid = entry.registryId as string
    const colon = rid.indexOf(':')
    const name = colon >= 0 ? rid.slice(colon + 1) : rid
    if (name !== 'air' && name !== 'Air') {
      paletteCache.set('#' + String(i), entry as unknown as import('@/pure/gridTypes').PaletteEntryMeta)
    }
  }
  const gridCells: (SlotBlock | null)[][][] = []
  for (let z = 0; z < depth; z++) {
    const slice: (SlotBlock | null)[][] = []
    for (let y = 0; y < height; y++) {
      const row = structureRowToWorldY(y, height)
      const outRow: (SlotBlock | null)[] = new Array(width).fill(null)
      const rawRow = projected.cellGrid[z]?.[row]
      if (rawRow) {
        for (let x = 0; x < width; x++) {
          const idx = rawRow[x]!
          if (idx === AIR_PALETTE_INDEX) continue
          const entry = projected.blockPalette[idx]
          if (entry === undefined) continue
          const rid = entry.registryId as string
          const colon = rid.indexOf(':')
          const name = colon >= 0 ? rid.slice(colon + 1) : rid
          if (name === 'air' || name === 'Air') continue
          outRow[x] = { name, meta: (entry.meta as number) ?? 0, paletteIndex: idx }
        }
      }
      slice[y] = outRow
    }
    gridCells.push(slice)
  }
  return { grid: new LegacyGrid(width, height, depth, gridCells, paletteCache), invalidCells: projected.invalidCells }
}

// ─────────────────────────────────────────────────────────────────────────────
// 投影入口
// ─────────────────────────────────────────────────────────────────────────────

/** 投影诊断（稳定码；不静默）。 */
export type ProjectionDiagnosticCode =
  /** `blockGrid` 载荷里有无法解析的单元键/值（已跳过，计数在 `count`）。 */
  | 'invalidGridCells'
  /** 内核对象类型不是 `block`（当前渲染/保存格式承载不了它）。 */
  | 'unsupportedObjectType'

export interface ProjectionDiagnostic {
  readonly code: ProjectionDiagnosticCode
  readonly path: string
  readonly detail: string
  readonly count?: number
}

export interface KernelProjectionInput {
  readonly scene: Scene
  readonly content: DocumentContent
  /**
   * 帧时长轴 → 帧声明的来源：`frameObjects` 给出"帧下标 → 内核对象 id"。
   *
   * 缺省 = 按 `scene.order` 里 `block` 类型对象的顺序（装配产物就是这个顺序）。
   */
  readonly frameObjects?: readonly string[]
  /**
   * 多方块内层 body（装配产物的 `multiblock.source`）。
   *
   * **有值** ⇒ 产物是"多方块为主"形态（`documentShape: 'multiblock'` + 内层 body）。
   * 无值 ⇒ "帧为主"形态。形态由它**机械决定**（见文件头判据 2）。
   */
  readonly multiblockSource?: Readonly<Record<string, unknown>> | null
  /**
   * 保真记录里要回写的未知字段（#249 §12 的"往返保留"）。
   *
   * 键是**顶层字段名**（`meta.` 前缀的项写回 `meta` 子树）。
   */
  readonly fidelityFields?: Readonly<Record<string, unknown>>
  /** 文档 id（缺省用 `scene.id` 去掉 `-scene` 后缀）。 */
  readonly documentId?: string
}

/** 投影产物：一份旧格式 plain JSON + 诊断。 */
export interface ProjectedDocument {
  readonly plain: Readonly<Record<string, unknown>>
  readonly diagnostics: readonly ProjectionDiagnostic[]
}

/**
 * 内核文档 → 旧格式 plain JSON（**G-3 反向编码器**）。
 *
 * 逐项映射（与正向装配对偶）：
 *
 * | 内核 | 旧格式 | 说明 |
 * |---|---|---|
 * | `DocumentContent.metadata` | `meta.{name,author,description,tags,origin,created_at_ms}` + 根 `label` | 展示名同时写根 `label`（真实产物的键，见装配侧的实测说明） |
 * | `DocumentContent.frameAxis` | `frames[].{index,label,durationMs}` | 时长轴 |
 * | `DocumentContent.resources` | `textureBlobs` + `materialPalette` | 内嵌字节回 `textureBlobs`，声明回 `materialPalette` |
 * | `block` 对象的 `blockGrid` | `frames[].structure.{cellGrid,blockPalette}` | 逐格重建 |
 * | `multiblockSource` | 根 `documentShape`/`multiblock`/… + 内层 body | 多方块形态 |
 * | `annotation` 对象 | `annotations[]` | 反向合成 title/description |
 */
export function projectKernelDocument(input: KernelProjectionInput): ProjectedDocument {
  const { scene, content } = input
  const diagnostics: ProjectionDiagnostic[] = []
  const documentId = input.documentId ?? (scene.id.endsWith('-scene') ? scene.id.slice(0, -'-scene'.length) : scene.id)

  // ── ① 方块对象 → 每帧一个 structure ──
  const blockObjects: SceneObject[] = objectsInOrder(scene).filter((o) => o.type === 'block')
  const frameObjectIds = input.frameObjects ?? blockObjects.map((o) => o.id)
  const structures: { index: number; label: string | null; durationMs: number | null; structure: Record<string, unknown> | null }[] = []
  const axisFrames = content.frameAxis.frames
  for (let i = 0; i < frameObjectIds.length; i++) {
    const objectId = frameObjectIds[i]!
    const obj = findObject(scene, objectId)
    if (obj === undefined) {
      diagnostics.push(
        Object.freeze({ code: 'unsupportedObjectType' as const, path: `$.frames[${i}]`, detail: `帧对象 ${objectId} 在内核场景里不存在` }),
      )
      continue
    }
    const data = findObjectData(scene, obj.dataId)
    if (data === undefined || data.payload.kind !== 'blockGrid') {
      diagnostics.push(
        Object.freeze({
          code: 'unsupportedObjectType' as const,
          path: `$.frames[${i}]`,
          detail: `对象 ${objectId} 的载荷不是 blockGrid（实际 ${data?.payload.kind ?? '缺失'}）—— 当前文件格式承载不了它`,
        }),
      )
      continue
    }
    const projected = projectGridCells(data.payload.cells)
    if (projected.invalidCells > 0) {
      diagnostics.push(
        Object.freeze({
          code: 'invalidGridCells' as const,
          path: `$.frames[${i}].structure.cellGrid`,
          detail: `${objectId} 有无法解析的单元键/值`,
          count: projected.invalidCells,
        }),
      )
    }
    const axis = axisFrames[i] ?? axisFrames[0]
    structures.push({
      index: axis?.index ?? i,
      label: axis?.label ?? obj.name,
      durationMs: axis?.durationMs ?? null,
      structure:
        projected.cellGrid.length === 0
          ? null
          : { geometryPhase: 'baked' as const, cellGrid: projected.cellGrid, blockPalette: projected.blockPalette },
    })
  }

  // ── ② 注解对象 → annotations[] ──
  const annotations: Record<string, unknown>[] = []
  for (const obj of objectsInOrder(scene)) {
    if (obj.type !== 'annotation') continue
    const data = findObjectData(scene, obj.dataId)
    if (data === undefined || data.payload.kind !== 'annotation') continue
    const text = data.payload.text ?? ''
    // 反向合成：`title\n\ndescription` → 两个字段（正向合成的逆）。
    const [title, ...rest] = text.split('\n\n')
    annotations.push({
      id: obj.id.startsWith('annotation:') ? obj.id.slice('annotation:'.length) : obj.id,
      type: data.payload.shape,
      visible: obj.visible,
      title: title ?? '',
      description: rest.join('\n\n'),
    })
  }

  // ── ③ 资源 → textureBlobs + materialPalette ──
  //
  // ## `textureBlobs` 的**两种**形状（由契约决定，不是实现选择）
  //
  // | 文档形态 | `textureBlobs` | 依据 |
  // |---|---|---|
  // | 帧为主（V2Plain/World） | **对象**（`{"0": "<base64>", …}`） | `RuntimeDocument.serialize()` 的既有形态；`render/data/buildMaterialLibrary` 按键读 |
  // | 多方块（`documentShape: multiblock`） | **数组**（`["<base64>", …]`） | `docs/contracts/format-multiblock-doc.md:108` 逐字要求「`"textureBlobs": [ … ]`」，且 `multiblockDocument` 的解析器**显式拒绝**对象形态（实测报 `textureBlobs 必须是数组（实际 object）`） |
  //
  // ⇒ 由 `multiblockSource` 的存在机械决定用哪种（与形态判别同一纪律）。
  // 这是本文件被真实夹具测试抓出的第一个缺陷：只写对象形态会让多方块产物
  // **无法被生产解析器读回**（往返断链）。
  const isMultiblock = input.multiblockSource != null
  const textureBlobs: Record<string, string> = {}
  const textureBlobList: string[] = []
  const materialPalette: Record<string, unknown>[] = []
  for (let i = 0; i < content.resources.length; i++) {
    const r = content.resources[i]!
    const entry: Record<string, unknown> = { kind: r.kind }
    if (r.blend !== null) entry.blend = r.blend
    if (r.emissive !== null) entry.emissive = r.emissive
    if (r.animation !== null) entry.animation = r.animation
    if (r.atlas !== null) entry.atlas = r.atlas
    if (r.linear !== null) entry.linear = r.linear
    if (r.useMipmaps !== null) entry.useMipmaps = r.useMipmaps
    if (r.ref.url !== '') entry.locator = r.ref.url
    if (r.payload !== null) {
      textureBlobs[String(i)] = r.payload
      // 数组形态按**调色板下标**对齐（下标即索引），故空洞补空串 ——
      // 用 `push` 会让"外链资源"把后续下标整体前移，使 `textureBlobIndex` 指错条目。
      while (textureBlobList.length < i) textureBlobList.push('')
      textureBlobList.push(r.payload)
      entry.textureBlobIndex = i
    }
    materialPalette.push(entry)
  }

  // ── ④ 元数据（含根级 label —— 真实产物的展示名键） ──
  const meta: Record<string, unknown> = {
    name: content.metadata.name,
    author: content.metadata.author,
    description: content.metadata.description,
    tags: [...content.metadata.tags],
    origin: { ...content.metadata.origin },
  }
  if (content.metadata.createdAtMs !== null) meta.created_at_ms = content.metadata.createdAtMs

  // ── ⑤ 形态：由 `multiblockSource` 的存在**机械决定** ──
  const plain: Record<string, unknown> = {
    format_version: '2.0',
    id: documentId,
    label: content.metadata.name,
    meta,
    frames: structures.map((s) => {
      const frame: Record<string, unknown> = { index: s.index, label: s.label, durationMs: s.durationMs }
      if (s.structure !== null) frame.structure = s.structure
      return frame
    }),
    annotations,
    labels: [],
  }
  if (isMultiblock) {
    // 多方块形态：数组（契约 `format-multiblock-doc.md:108` 逐字要求）
    if (textureBlobList.length > 0) plain.textureBlobs = textureBlobList
  } else if (Object.keys(textureBlobs).length > 0) {
    // 帧为主形态：对象（`RuntimeDocument.serialize()` 的既有形态）
    plain.textureBlobs = textureBlobs
  }
  if (materialPalette.length > 0) plain.materialPalette = materialPalette

  if (input.multiblockSource != null) {
    // 多方块为主：内层 body 的键**摊平到根**（与信封解包后的 plain 同形 ——
    // 见 `composition/kernelAssembly` 的实测说明：真实产物的形态键与
    // blockPalette/frames 都在内层 body 的根上）。
    for (const [k, v] of Object.entries(input.multiblockSource)) {
      if (k === 'frames') continue // 帧由上面的投影产出（内层 frames 只承载变体声明，另见下）
      if (!(k in plain)) plain[k] = v
    }
    // 内层 frames 承载**变体声明**（`variant`/`runstate`/`stepIndex`/`rules`），
    // 而投影出的 frames 承载网格。两者按 index 合并 —— 丢掉任一侧都是静默丢语义。
    const innerFrames = Array.isArray(input.multiblockSource.frames) ? (input.multiblockSource.frames as Record<string, unknown>[]) : []
    const projectedFrames = plain.frames as Record<string, unknown>[]
    for (let i = 0; i < projectedFrames.length; i++) {
      const inner = innerFrames[i]
      if (inner === undefined) continue
      for (const [k, v] of Object.entries(inner)) {
        if (k === 'structure' || k === 'index') continue
        if (!(k in projectedFrames[i]!)) projectedFrames[i]![k] = v
      }
    }
    plain.documentShape = 'multiblock'
  }

  // ── ⑥ 保真字段回写（§12 的"往返保留"；`meta.` 前缀写回 meta 子树） ──
  for (const [key, value] of Object.entries(input.fidelityFields ?? {})) {
    if (key.startsWith('meta.')) {
      meta[key.slice('meta.'.length)] = value
    } else if (!(key in plain)) {
      plain[key] = value
    }
  }

  return Object.freeze({ plain: Object.freeze(plain), diagnostics: Object.freeze(diagnostics) })
}

/**
 * 内核文档 → 旧 `RuntimeDocument`（供渲染链与保存链消费）。
 *
 * 这是"内核为权威"的落点：渲染/保存不再读旧文档，而是读**从内核投影出来的**文档。
 * 旧 `RuntimeDocument` 因此降级为**传输形状**（呈现后端要的形状），不再是权威。
 */
export function projectToRuntimeDocument(input: KernelProjectionInput): {
  readonly doc: RuntimeDocument
  readonly diagnostics: readonly ProjectionDiagnostic[]
} {
  const projected = projectKernelDocument(input)
  const plain = projected.plain
  // 走 `fromV2Plain` 而不是手工 new：它已经处理帧/网格/注解/调色板的解析，
  // 且"投影 → 解析"这条往返本身就是要被断言的性质（见测试）。
  const doc = LegacyRuntimeDocument.fromV2Plain(plain as Record<string, unknown>)
  if (doc === null) {
    // 投影出的产物必须能被生产解析器读回 —— 读不回说明投影产出了非法形状。
    // 这是一个**实现缺陷**（不是业务失败），故用空文档 + 诊断表达，
    // 而不是抛异常（纯层不抛；见 `domain/errors` 的纪律）。
    return {
      doc: LegacyRuntimeDocument.empty(),
      diagnostics: Object.freeze([
        ...projected.diagnostics,
        Object.freeze({
          code: 'unsupportedObjectType' as const,
          path: '$',
          detail: '投影产物无法被 fromV2Plain 读回（投影产出了非法形状）',
        }),
      ]),
    }
  }
  return { doc, diagnostics: projected.diagnostics }
}

/** 未使用占位：保持 `RuntimeFrame` 类型可达（下游类型推导用）。 */
export type { RuntimeFrame }
