/**
 * RuntimeDocument — 运行时场景文档。
 *
 * 独立于传输格式（V2Plain / StructureData / World / Multiblock），使用 Y-up 坐标系。
 * Pallete 已解析为 SlotBlock，不使用原始的 palette index。
 * 序列化/反序列化分别在 serializers / parsers 中实现。
 *
 * **支持两种文档形态（互斥，见 `docs/plan/format-multiblock-doc.md` §2）**：
 *  - **帧为主**（缺省）：`multiblock === null`，帧自带 grid（既有行为，一行未变）。
 *  - **多方块为主**（`documentShape === "multiblock"`）：`multiblock` 承载全部声明
 *    （通道清单 / 总 Tier 域 / 运行态 / 变体 / 规则表 / 骨架 / viewerSemantics），
 *    帧只承载**变体声明**（`RuntimeFrame.multiblock`，`grid === null`）——
 *    网格是装配产物，由装配器（T2.2）按当前取值选择生成。
 */
import { structureRowToWorldY } from '@/pure/vec'
import { blockKey } from '@/pure/string'
import { PARTS_GRID_NONE, partListSignature, type PartList, type PartRecord } from '@/pure/partTypes'
import { Grid, type GridPos, type SlotBlock, type PaletteEntryMeta } from './grid'
import {
  MULTIBLOCK_DOCUMENT_SHAPE,
  parseMultiblockDeclaration,
  type MultiblockChannelDecl,
  type MultiblockDeclaration,
  type MultiblockFrameDecl,
  type MultiblockRuleDecl,
  type MultiblockRunstateDecl,
  type MultiblockVariantDecl,
} from './parsers/multiblockDocument'

export { Grid, GridPos, SlotBlock, PaletteEntryMeta }
export { PARTS_GRID_NONE, partListSignature }
export type { PartBox, PartItem, PartList, PartRecord, PartSource } from '@/pure/partTypes'

export type {
  MultiblockDeclaration,
  MultiblockDecl,
  MultiblockChannelDecl,
  MultiblockChannelKind,
  MultiblockRunstateDecl,
  MultiblockRuleDecl,
  MultiblockRuleRef,
  MultiblockVariantDecl,
  MultiblockFrameDecl,
  MultiblockSizeStep,
  MultiblockBackbone,
  MultiblockCouplingDecl,
  MultiblockNoteDecl,
  MultiblockViewerSemantics,
  MultiblockTotalTierDomain,
} from './parsers/multiblockDocument'
export { MULTIBLOCK_DOCUMENT_SHAPE, MultiblockParseError, multiblockVariantKey } from './parsers/multiblockDocument'

export const AIR_PALETTE_INDEX = 0

// ---------------------------------------------------------------------------
// RuntimeFrame
// ---------------------------------------------------------------------------

export class RuntimeFrame {
  readonly index: number
  readonly label: string | undefined
  readonly grid: Grid | null
  readonly durationMs: number | undefined
  /**
   * 多方块帧声明（`variant` / `stepIndex` / `rules` —— Frame 是**唯一**变体存储原语）。
   * 帧为主文档恒为 `null`。注意：多方块帧的 `grid` 由装配器按需生成，构造时为 `null`。
   */
  readonly multiblock: MultiblockFrameDecl | null

  constructor(
    index: number,
    label?: string,
    grid?: Grid | null,
    durationMs?: number,
    multiblock?: MultiblockFrameDecl | null,
  ) {
    this.index = index
    this.label = label
    this.grid = grid ?? null
    this.durationMs = durationMs
    this.multiblock = multiblock ?? null
  }


}

// ---------------------------------------------------------------------------
// RuntimeDocument
// ---------------------------------------------------------------------------

export class RuntimeDocument {
  readonly formatVersion: string
  readonly id: string
  readonly frames: RuntimeFrame[]
  readonly meta: Record<string, unknown>
  readonly annotations: unknown[]
  readonly labels: unknown[]
  readonly textureBlobs: Record<string, unknown> | undefined
  readonly tooltipPalette: unknown[] | undefined
  readonly cellTooltipGrid: number[][][] | undefined
  readonly materialPalette: unknown[] | undefined
  readonly playback: Record<string, unknown> | undefined

  /**
   * 多方块声明（`documentShape === "multiblock"`）；帧为主文档恒为 `null`。
   * 承载 T2.2 装配器与 T2.4 UI 需要的**全部声明**：
   * 通道清单（双键 enum/id、kind、取值域含 0 = "Not set"、size 型 min/max）、总 Tier 域 + tierSample、
   * 运行态清单与呈现名、变体映射、规则表、骨架 sizeSteps、couplings/notes/viewerSemantics。
   * `multiblock.raw` 即**契约内层 JSON 原文**（含 `blockPalette`/`frames`），是装配器的输入形态。
   */
  readonly multiblock: MultiblockDeclaration | null

  /** 不认识的顶层 key 兜底（round-trip 无损） */
  private _extra: Record<string, unknown>

  constructor(opts: {
    formatVersion?: string
    id?: string
    frames?: RuntimeFrame[]
    meta?: Record<string, unknown>
    annotations?: unknown[]
    labels?: unknown[]
    textureBlobs?: Record<string, unknown> | null
    tooltipPalette?: unknown[] | null
    cellTooltipGrid?: number[][][] | null
    materialPalette?: unknown[] | null
    playback?: Record<string, unknown> | null
    multiblock?: MultiblockDeclaration | null
    extra?: Record<string, unknown>
  }) {
    this.formatVersion = opts.formatVersion ?? '2.0'
    this.id = opts.id ?? ''
    this.frames = opts.frames ?? []
    this.meta = { ...(opts.meta ?? {}) }
    this.annotations = [...(opts.annotations ?? [])]
    this.labels = [...(opts.labels ?? [])]
    this.textureBlobs = opts.textureBlobs ?? undefined
    this.tooltipPalette = opts.tooltipPalette ?? undefined
    this.cellTooltipGrid = opts.cellTooltipGrid
      ? opts.cellTooltipGrid.map(s => s ? s.map(r => r ? [...r] : []) : [])
      : undefined
    this.materialPalette = opts.materialPalette ?? undefined
    this.playback = opts.playback ?? undefined
    this.multiblock = opts.multiblock ?? null
    this._extra = { ...(opts.extra ?? {}) }
  }

  /** 是否为「多方块为主」文档（形态枚举量判别，与「帧为主」互斥）。 */
  get isMultiblock(): boolean {
    return this.multiblock !== null
  }

  /** 通道清单（空 = 仅总 Tier；T2.4 每通道一条滑杆，`kind === 'hatch'` 的 `slider === false`）。 */
  get multiblockChannels(): MultiblockChannelDecl[] {
    return this.multiblock?.decl.channels ?? []
  }

  /** 运行态清单与呈现名（T2.4 运行态切换）。 */
  get multiblockRunstates(): MultiblockRunstateDecl[] {
    return this.multiblock?.decl.runstates ?? []
  }

  /** 变体清单（声明值集合；帧是变体的存储原语）。 */
  get multiblockVariants(): MultiblockVariantDecl[] {
    return this.multiblock?.decl.variants ?? []
  }

  /** 差异规则表（按引用复用；帧只存 id）。 */
  get multiblockRules(): MultiblockRuleDecl[] {
    return this.multiblock?.decl.rules ?? []
  }

  /** 帧声明（`variant` / `stepIndex` / `rules`）；帧为主文档为空数组。 */
  get multiblockFrames(): MultiblockFrameDecl[] {
    return this.multiblock?.frames ?? []
  }

  /**
   * **契约内层 JSON 原文**（`multiblock` + `blockPalette` + `frames` + …）——
   * T2.2 装配器的输入（冻结接缝：内层 JSON 对象 + `{values, runstate}`）。帧为主文档为 `null`。
   */
  get multiblockSource(): Record<string, unknown> | null {
    return this.multiblock?.raw ?? null
  }

  get frameCount(): number {
    return this.frames.length
  }

  frame(i: number): RuntimeFrame | null {
    return this.frames[i] ?? null
  }

  forEachFrame(fn: (frame: RuntimeFrame) => void): void {
    for (const f of this.frames) fn(f)
  }

  forEachBlock(fn: (frameIndex: number, pos: GridPos, block: SlotBlock) => void): void {
    for (const f of this.frames) {
      if (f.grid) {
        f.grid.forEach((pos, block) => fn(f.index, pos, block))
      }
    }
  }

  /**
   * 按格取部件列表（契约 §2 cellPartsGrid/partLists 的运行时查询；无部件/无网格 ⇒ null）。
   * 盒为导出时快照，web 端任何编辑不重算（契约 §12）。
   */
  partsAt(frameIndex: number, pos: GridPos): readonly PartRecord[] | null {
    return this.frames[frameIndex]?.grid?.partsAt(pos) ?? null
  }

  /** 序列化为 V2Plain JSON（兼容 render pipeline：展开首帧 structure 字段到顶层） */
  serialize(): Record<string, unknown> {
    const rawFrames = this.frames.map(f => {
      // 多方块帧：以原样帧对象为底（variant/runstate/stepIndex/rules/参考 cellGrid 全部保留）
      const frame: Record<string, unknown> = f.multiblock ? { ...f.multiblock.raw } : {}
      frame.index = f.index
      frame.label = f.label
      frame.durationMs = f.durationMs
      if (f.grid) {
        const { cellGrid, blockPalette, cellPartsGrid, partLists } = this._gridToV2(f.grid)
        frame.structure = {
          geometryPhase: 'baked' as const,
          cellGrid,
          blockPalette,
          // 契约 §2：仅当确有部件数据时才写出（缺省 ⇒ 与无部件行为完全一致）
          ...(cellPartsGrid ? { cellPartsGrid, partLists } : {}),
        }
      }
      return frame
    })

    const out: Record<string, unknown> = {
      ...this._extra,
      format_version: this.formatVersion,
      id: this.id,
      meta: { ...this.meta },
      frames: rawFrames,
      annotations: [...this.annotations],
      labels: [...this.labels],
    }
    // 多方块文档：`_extra` 已带回 multiblock/multiblockCount/blockPalette（原样），
    // 此处只补「构造期未经过反序列化」时缺失的节点，使形态自描述（documentShape 判别可复原）。
    if (this.multiblock) {
      if (!('documentShape' in out)) out.documentShape = MULTIBLOCK_DOCUMENT_SHAPE
      if (!('multiblock' in out)) out.multiblock = this.multiblock.decl.raw
      if (!('multiblockCount' in out)) out.multiblockCount = this.multiblock.multiblockCount
      if (!('blockPalette' in out) && this.multiblock.blockPalette.length > 0) {
        out.blockPalette = this.multiblock.blockPalette
      }
    }
    // 展开首帧 structure 到顶层，兼容 render pipeline（loadStructureData 直接读顶层字段）
    if (rawFrames.length > 0) {
      const st = rawFrames[0]!.structure as Record<string, unknown> | undefined
      if (st) {
        for (const key of Object.keys(st)) {
          if (!(key in out)) {
            out[key] = st[key]
          }
        }
      }
    }
    if (this.textureBlobs) out.textureBlobs = this.textureBlobs
    if (this.tooltipPalette) out.tooltipPalette = [...this.tooltipPalette]
    if (this.cellTooltipGrid) out.cellTooltipGrid = this.cellTooltipGrid.map(s => s ? s.map(r => r ? [...r] : []) : [])
    if (this.materialPalette) out.materialPalette = [...this.materialPalette]
    if (this.playback) out.playback = { ...this.playback }
    return out
  }

  clone(): RuntimeDocument {
    return new RuntimeDocument({
      formatVersion: this.formatVersion,
      id: this.id,
      frames: this.frames.map(f => {
        const frameMultiblock = f.multiblock ? (structuredClone(f.multiblock) as MultiblockFrameDecl) : null
        if (!f.grid) return new RuntimeFrame(f.index, f.label, null, f.durationMs, frameMultiblock)
        // Deep clone grid
        const cells: (SlotBlock | null)[][][] = []
        for (let z = 0; z < f.grid.depth; z++) {
          const slice: (SlotBlock | null)[][] = []
          for (let y = 0; y < f.grid.height; y++) {
            const row: (SlotBlock | null)[] = []
            for (let x = 0; x < f.grid.width; x++) {
              const b = f.grid.at({ x, y, z })
              row.push(b ? { ...b } : null)
            }
            slice.push(row)
          }
          cells.push(slice)
        }
        const paletteCache = new Map(f.grid.getPaletteCache())
        const cellParts = new Map<string, PartRecord[]>()
        f.grid.forEachParts((pos, parts) => {
          cellParts.set(`${pos.x},${pos.y},${pos.z}`, structuredClone(parts) as PartRecord[])
        })
        return new RuntimeFrame(
          f.index,
          f.label,
          new Grid(f.grid.width, f.grid.height, f.grid.depth, cells, paletteCache, cellParts),
          f.durationMs,
          frameMultiblock,
        )
      }),
      meta: { ...this.meta },
      annotations: [...this.annotations],
      labels: [...this.labels],
      textureBlobs: this.textureBlobs ? (Array.isArray(this.textureBlobs) ? [...this.textureBlobs] as unknown as Record<string, unknown> : { ...this.textureBlobs }) : undefined,
      tooltipPalette: this.tooltipPalette ? [...this.tooltipPalette] : undefined,
      cellTooltipGrid: this.cellTooltipGrid ? this.cellTooltipGrid.map(s => s ? s.map(r => r ? [...r] : []) : []) : undefined,
      materialPalette: this.materialPalette ? [...this.materialPalette] : undefined,
      playback: this.playback ? { ...this.playback } : undefined,
      multiblock: this.multiblock ? (structuredClone(this.multiblock) as MultiblockDeclaration) : null,
      extra: { ...this._extra },
    })
  }


  /**
   * 从 V2Plain JSON 创建（反序列化入口）。
   *
   * `opts.multiblockSource` = **信封内层 body 原文**（多方块文档；缺省用 `raw` 自身，即裸体形态）。
   * 仅当 `raw.documentShape === "multiblock"` 时才构建多方块声明，其它文档走原路径（行为不变）。
   */
  static fromV2Plain(
    raw: Record<string, unknown>,
    opts?: { multiblockSource?: Record<string, unknown> },
  ): RuntimeDocument | null {
    const framesRaw = raw.frames
    if (!Array.isArray(framesRaw)) return null

    const known = new Set([
      'format_version', 'id', 'frames', 'meta',
      'annotations', 'labels',
      'schemaVersion', 'label', 'gtnhVersion', 'author',
      'description', 'modSource', 'globalConfig',
      'cellTooltipGrid', 'tooltipPalette', 'materialPalette',
      // 契约 §2：根级 cellPartsGrid/partLists 是 serialize() 的首帧展开副本（可由 frames 派生），
      // 不进 _extra —— 否则编辑后再序列化根级会残留过期快照（派生数据不收编进兜底透传）。
      'cellPartsGrid', 'partLists',
    ])
    const extra: Record<string, unknown> = {}
    for (const key of Object.keys(raw)) {
      if (!known.has(key)) extra[key] = (raw as Record<string, unknown>)[key]
    }

    const meta = raw.meta as Record<string, unknown> | undefined
    const annotations = (raw.annotations as unknown[]) ?? []
    const labels = (raw.labels as unknown[]) ?? []

    // 多方块文档：形态枚举量在信封 meta（真实产物）或根级（裸体）；不满足者走既有路径。
    const multiblock = raw.documentShape === MULTIBLOCK_DOCUMENT_SHAPE
      ? parseMultiblockDeclaration(opts?.multiblockSource ?? raw)
      : null
    // 帧声明按位置对应（内层 body 的 frames 与合并后的 frames 同序、同源）
    const frameDeclByIndex = new Map<number, MultiblockFrameDecl>()
    for (const fd of multiblock?.frames ?? []) frameDeclByIndex.set(fd.index, fd)

    const frames: RuntimeFrame[] = []
    for (let i = 0; i < framesRaw.length; i++) {
      const f = framesRaw[i] as Record<string, unknown> | undefined
      if (!f || typeof f !== 'object') continue
      const index = (f.index as number) ?? i
      const label = f.label as string | undefined
      const durationMs = f.durationMs as number | undefined
      const st = f.structure as Record<string, unknown> | undefined
      let grid: Grid | null = null
      if (st?.cellGrid && Array.isArray(st.cellGrid) && st.blockPalette && Array.isArray(st.blockPalette)) {
        grid = RuntimeDocument._fromV2CellGrid(
          st.cellGrid as number[][][],
          st.blockPalette as Record<string, unknown>[],
          // 契约 §2：cellPartsGrid/partLists 可选；缺省 ⇒ 无部件（行为与旧文件一致）
          st.cellPartsGrid as number[][][] | undefined,
          st.partLists as PartList[] | undefined,
        )
      }
      // 多方块帧：解析期**不建 Grid**（装配产物由 T2.2 按当前取值生成）
      const frameMultiblock = multiblock ? (frameDeclByIndex.get(index) ?? multiblock.frames[i] ?? null) : null
      frames.push(new RuntimeFrame(index, label, grid, durationMs, frameMultiblock))
    }

    return new RuntimeDocument({
      formatVersion: (raw.format_version as string) ?? '2.0',
      id: (raw.id as string) ?? '',
      frames,
      meta: meta ? { ...meta } : { name: '', author: '', created_at_ms: Date.now(), description: '', tags: [], origin: { x: 0, y: 0, z: 0 } },
      annotations: [...annotations],
      labels: [...labels],
      textureBlobs: raw.textureBlobs as Record<string, unknown> | undefined,
      tooltipPalette: raw.tooltipPalette as unknown[] | undefined,
      cellTooltipGrid: raw.cellTooltipGrid as number[][][] | undefined,
      materialPalette: raw.materialPalette as unknown[] | undefined,
      playback: raw.playback as Record<string, unknown> | undefined,
      multiblock,
      extra,
    })
  }

  /** 创建空文档 */
  static empty(): RuntimeDocument {
    return new RuntimeDocument({
      id: '',
      meta: {
        name: '未命名', author: '', created_at_ms: Date.now(),
        description: '', tags: [], origin: { x: 0, y: 0, z: 0 },
      },
    })
  }

  // ---- 内部序列化辅助 ----

  private _gridToV2(grid: Grid): {
    cellGrid: number[][][]
    blockPalette: Record<string, unknown>[]
    cellPartsGrid?: number[][][]
    partLists?: PartList[]
  } {
    const paletteCache = grid.getPaletteCache()
    // name:meta → palette index (AIR_PALETTE_INDEX = 0 = air)
    const indexMap = new Map<string, number>()
    // Index 0 is always reserved for air
    const blockPalette: Record<string, unknown>[] = [{ registryId: 'air', meta: AIR_PALETTE_INDEX }]
    const cellGrid: number[][][] = []

    // 部件池（契约 §2.1：同内容 partList 内容签名去重、跨格共享下标）
    const wantParts = grid.hasAnyParts()
    const partLists: PartList[] = []
    const partListIndexBySignature = new Map<string, number>()
    const cellPartsGrid: number[][][] = []

    for (let z = 0; z < grid.depth; z++) {
      const slice: number[][] = []
      const partsSlice: number[][] = []
      for (let y = 0; y < grid.height; y++) {
        // cellGrid row = height - 1 - y (Y-up → cellGrid row, 0=top)
        const row: number[] = []
        const partsRow: number[] = []
        for (let x = 0; x < grid.width; x++) {
          const block = grid.at({ x, y, z })
          if (block) {
            const key = blockKey(block)
            let idx = indexMap.get(key)
            if (idx === undefined) {
              idx = blockPalette.length // AIR_PALETTE_INDEX already occupies index 0
              indexMap.set(key, idx)
              const meta = paletteCache.get(key)
              blockPalette.push(meta
                ? { ...meta }
                : {
                    registryId: 'minecraft:' + block.name,
                    meta: block.meta,
                    renderMode: 'BlockModel',
                  })
            }
            row.push(idx)
          } else {
            row.push(AIR_PALETTE_INDEX)
          }

          // 部件下标（与 cellGrid 同行列对齐；无部件 ⇒ PARTS_GRID_NONE）
          if (wantParts) {
            const parts = block ? grid.partsAt({ x, y, z }) : null
            if (parts && parts.length > 0) {
              const sig = partListSignature(parts)
              let pIdx = partListIndexBySignature.get(sig)
              if (pIdx === undefined) {
                pIdx = partLists.length
                partListIndexBySignature.set(sig, pIdx)
                partLists.push(structuredClone(parts) as PartList)
              }
              partsRow.push(pIdx)
            } else {
              partsRow.push(PARTS_GRID_NONE)
            }
          }
        }
        // cellGrid 的 row 顺序：row 0 = 顶部 = height-1-y
        slice.unshift(row)
        if (wantParts) partsSlice.unshift(partsRow)
      }
      cellGrid.push(slice)
      if (wantParts) cellPartsGrid.push(partsSlice)
    }

    if (!wantParts) return { cellGrid, blockPalette }
    return { cellGrid, blockPalette, cellPartsGrid, partLists }
  }

  /** @internal */
  static _fromV2CellGrid(
    cellGrid: number[][][],
    rawPalette: Record<string, unknown>[],
    cellPartsGrid?: number[][][],
    partLists?: PartList[],
  ): Grid {
    // 构建 palette cache（key = palette index，保留原始映射避免同名不同态被覆盖）
    const paletteCache = new Map<string, PaletteEntryMeta>()
    for (let i = 0; i < rawPalette.length; i++) {
      const entry = rawPalette[i]!
      const rid = entry.registryId as string
      const colon = rid.indexOf(':')
      const name = colon >= 0 ? rid.slice(colon + 1) : rid
      if (name !== 'air' && name !== 'Air') {
        paletteCache.set('#' + String(i), entry as unknown as PaletteEntryMeta)
      }
    }

    // 解析 air index (0)
    const depth = cellGrid.length
    const height = cellGrid[0]?.length ?? 0
    const width = cellGrid[0]?.[0]?.length ?? 0

    const cells: (SlotBlock | null)[][][] = []
    for (let z = 0; z < depth; z++) {
      const rawSlice = cellGrid[z]!
      const slice: (SlotBlock | null)[][] = []
      for (let row = 0; row < height; row++) {
        // Y-up: y = structureRowToWorldY(row, height) (cellGrid row 0 = 顶部)
        const y = structureRowToWorldY(row, height)
        const rawRow = rawSlice[row]!
        const outRow: (SlotBlock | null)[] = new Array(width).fill(null)
        for (let x = 0; x < width; x++) {
          const palIdx = rawRow[x]!
          if (palIdx > AIR_PALETTE_INDEX && palIdx < rawPalette.length) {
            const entry = rawPalette[palIdx]!
            const rid = entry.registryId as string
            const colon = rid.indexOf(':')
            const name = colon >= 0 ? rid.slice(colon + 1) : rid
            if (name !== 'air' && name !== 'Air') {
              outRow[x] = { name, meta: (entry.meta as number) ?? 0, paletteIndex: palIdx }
            }
          }
        }
        slice[y] = outRow
      }
      cells.push(slice)
    }

    const grid = new Grid(width, height, depth, cells, paletteCache)

    // 契约 §2：cellPartsGrid 与 cellGrid 同形、同下标 [z][row][column]；
    // 值 = partLists 下标，PARTS_GRID_NONE(-1) = 无部件。部件挂到宿主格（宿主为空气时容错跳过）。
    if (Array.isArray(cellPartsGrid) && Array.isArray(partLists) && partLists.length > 0) {
      for (let z = 0; z < depth; z++) {
        const partsSlice = cellPartsGrid[z]
        if (!Array.isArray(partsSlice)) continue
        for (let row = 0; row < height; row++) {
          const partsRow = partsSlice[row]
          if (!Array.isArray(partsRow)) continue
          const y = structureRowToWorldY(row, height)
          for (let x = 0; x < width; x++) {
            const pIdx = partsRow[x]
            if (typeof pIdx !== 'number' || pIdx <= PARTS_GRID_NONE || pIdx >= partLists.length) continue
            if (!grid.has({ x, y, z })) continue
            grid.setParts({ x, y, z }, partLists[pIdx]!)
          }
        }
      }
    }

    return grid
  }
}
