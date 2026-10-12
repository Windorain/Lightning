/**
 * RuntimeDocument — 运行时场景文档。
 *
 * 独立于传输格式（V2Plain / StructureData / World / Multiblock），使用 Y-up 坐标系。
 * Pallete 已解析为 SlotBlock，不使用原始的 palette index。
 * 序列化/反序列化分别在 serializers / parsers 中实现。
 *
 * **支持两种文档形态（互斥，见 `docs/contracts/format-multiblock-doc.md` §2）**：
 *  - **帧为主**（缺省）：`multiblock === null`，帧自带 grid（既有行为，一行未变）。
 *  - **多方块为主**（`documentShape === "multiblock"`）：`multiblock` 承载全部声明
 *    （通道清单 / 总 Tier 域 / 运行态 / 变体 / 规则表 / 骨架 / viewerSemantics），
 *    帧只承载**变体声明**（`RuntimeFrame.multiblock`，`grid === null`）——
 *    网格是装配产物，由装配器（T2.2）按当前取值选择生成。
 */
import { structureRowToWorldY } from '@/pure/vec'
import { blockKey } from '@/pure/string'
import { PARTS_GRID_NONE, partListSignature, type PartList, type PartRecord } from '@/pure/partTypes'
import { deepCopyPlain } from '@/pure/deepCopy'
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

  /**
   * **换一批注解**（#301 P10f C′2 的回写落点）。
   *
   * ## 为什么需要它（而不是调用方自己 `clone()` 后改字段）
   *
   * C′2 的同步桥要"把内核注解投影回 legacy"，而调用方（`runtime/context`）是
   * **旧层**代码：让它 `clone()` + 直接改 `annotations` 会绕开本类的封装，
   * 且**每处调用点都要自己写一遍**（那正是本项目三度实测会漂移的形态）。
   *
   * ## 为什么返回 `this` 而不是抛错/空洞
   *
   * **内容相同 ⇒ 返回 `this`**（引用相等）。调用方据此判断"无需回写"，
   * 于是**不 bump 内容重读信号** ⇒ 渲染链不做无谓重建。
   * 这是"净零往返不重建"的落地：同一份内容回写两次，第二次是零成本。
   *
   * ⚠️ 判定用**逐字段等价**而不是引用相等：投影每次都会新建数组与行对象
   * （纯函数不得返回共享可变结构），故引用比较恒不等 —— 那会让本方法永远"有变化"。
   *
   * ## 它**不**碰版本/基线/历史
   *
   * 那些字段表示"哪一份文档、是否脏、可否撤销"，与本方法无关。
   * （`RuntimeDocument` 本身也不持版本 —— 版本在 `Context.versionOf`。）
   */
  withAnnotations(next: readonly Record<string, unknown>[]): RuntimeDocument {
    const current = this.annotations as readonly Record<string, unknown>[]
    if (sameAnnotationRows(current, next)) return this
    const clone = this.clone()
    // `annotations` 是 `readonly` 声明、非冻结数组 ⇒ 就地替换内容（`clone()` 已给出新数组）
    ;(clone as unknown as { annotations: unknown[] }).annotations = [...next]
    return clone
  }

  /**
   * **换逐格说明侧表**（#301 P10f D2 收尾 / #333 的回写落点）。
   *
   * ## 为什么需要它（与 `withAnnotations` 同一理由，且**同一批**）
   *
   * D0 段二让"逐格说明编辑"改走内核命令（`setCellTooltip`），但**没有**扩
   * `Context#syncLegacyFromKernel` —— 而那个方法的文件头**明文写着**：
   *
   * > 「网格/材质/帧轴本批**不写**，故无需回写；将来若要写它们，
   * > 必须**同时**扩本方法（成对铁律第④项：同一事实的全部消费者同批迁移）。」
   *
   * ⇒ 那次迁移**违反了它自己引用的纪律**：内核写了 `cellContent.tooltip`，
   * legacy 侧表没被投影，而面板读 legacy ⇒ "提交成功但看不到"（**#333**）。
   * 本方法与 `syncLegacyFromKernel` 的扩展就是那条纪律的补做。
   *
   * ## 两个字段**成对**替换（契约 §逐格说明的成对 idioms）
   *
   * `tooltipPalette`（文案池）+ `cellTooltipGrid`（下标网格）是**一对**：
   * 只换一个会留下"悬空下标"（正是 #80 加锁防的形态）。
   * ⇒ 本方法只暴露**成对**入口，不提供单字段写（结构上让"写一半"不可表达）。
   *
   * ## `undefined` 的语义 = **清除**（不是"不改"）
   *
   * 内核侧"没有任何逐格说明"是**权威事实** ⇒ legacy 侧表必须被清成"没有"。
   * 若把 `undefined` 解释成"不改"，则"删掉最后一条说明"会**无声地不生效**
   * （内核已删、legacy 仍留着旧池与旧网格）—— 那正是本方法要修的那类缺陷。
   * 调用方若想"不动"，就**不要调**本方法（而不是传 `undefined`）。
   *
   * ## 为什么返回 `this` 而不是抛错/空洞
   *
   * 与 `withAnnotations` 逐字同口径：**内容相同 ⇒ 返回 `this`**，调用方据此跳过
   * 回写 ⇒ 不 bump 内容重读信号（"净零往返不重建"）。比较用**逐元素等价**而非
   * 引用相等（投影每次新建数组）。
   *
   * ## 它**不**碰版本/基线/历史
   *
   * 同 `withAnnotations`（编辑语义 ⇒ 回写后文档仍是脏的）。
   */
  withCellTooltips(
    palette: readonly string[] | undefined,
    grid: readonly number[][][] | undefined,
  ): RuntimeDocument {
    if (sameTooltipPool(this.tooltipPalette, palette) && sameTooltipGrid(this.cellTooltipGrid, grid)) return this
    const clone = this.clone()
    const mutable = clone as unknown as {
      tooltipPalette: string[] | undefined
      cellTooltipGrid: number[][][] | undefined
    }
    // 深拷贝（`clone()` 已给出新数组，这里再按层复制，避免与投影产物共享可变结构）
    mutable.tooltipPalette = palette === undefined ? undefined : [...palette]
    mutable.cellTooltipGrid =
      grid === undefined ? undefined : grid.map((s) => (s ? s.map((r) => (r ? [...r] : []) ) : []))
    return clone
  }

  clone(): RuntimeDocument {
    return new RuntimeDocument({
      formatVersion: this.formatVersion,
      id: this.id,
      frames: this.frames.map(f => {
        const frameMultiblock = f.multiblock ? (deepCopyPlain(f.multiblock) as MultiblockFrameDecl) : null
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
          cellParts.set(`${pos.x},${pos.y},${pos.z}`, deepCopyPlain(parts) as PartRecord[])
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
      multiblock: this.multiblock ? (deepCopyPlain(this.multiblock) as MultiblockDeclaration) : null,
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
                partLists.push(deepCopyPlain(parts) as PartList)
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

/**
 * 两批注解行是否**逐字段等价**（#301 P10f C′2 的"净零往返"判定）。
 *
 * ## 为什么不能用 `JSON.stringify` 比较
 *
 * 键的顺序会影响 `JSON.stringify` 的产物，而本函数的两个输入来自
 * **不同来源**（legacy 原行 vs 内核投影行）—— 键序不同会让"其实没变"判成"变了"，
 * 后果是每次回写都 bump 内容重读信号 ⇒ 渲染链无谓重建。
 *
 * ## 为什么只比"投影会产出的那些键"
 *
 * legacy 行可能带投影**不认识**的额外键（用户数据 / 未来扩展）。那些键
 * **不参与**等价判定：本函数的用途是"内核投影是否与现状相同"，
 * 而投影产物里根本没有它们 ⇒ 不该因为它们存在就判"不同"（那会让回写反复发生）。
 *
 * ⚠️ 代价是：若调用方传入的行**丢掉了** legacy 的额外键，本函数会说"相同"
 * 从而**不丢**它们（因为不写）。这是**有意的**保守方向 —— 宁可少写，不可误删。
 */
/**
 * 逐格说明**池**的逐元素等价（`withCellTooltips` 的"内容相同 ⇒ 返回 `this`"判据）。
 *
 * `undefined` 与"空数组"**不等价**：前者 = 没有该侧表（文件里不写这个键），
 * 后者 = 有但为空（文件里写 `[]`）。这正是本工程"缺席 ≠ 空"的口径，
 * 也是 `projectionFidelity` 的 D1+ 判据所钉的那条。
 */
function sameTooltipPool(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** 逐格说明**下标网格**的逐元素等价（同上；`undefined` 与全 `-1` 不等价）。 */
function sameTooltipGrid(a: readonly number[][][] | undefined, b: readonly number[][][] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  if (a.length !== b.length) return false
  for (let z = 0; z < a.length; z++) {
    const sa = a[z]
    const sb = b[z]
    if (sa === undefined || sb === undefined) {
      if (sa !== sb) return false
      continue
    }
    if (sa.length !== sb.length) return false
    for (let r = 0; r < sa.length; r++) {
      const ra = sa[r]
      const rb = sb[r]
      if (ra === undefined || rb === undefined) {
        if (ra !== rb) return false
        continue
      }
      if (ra.length !== rb.length) return false
      for (let c = 0; c < ra.length; c++) if (ra[c] !== rb[c]) return false
    }
  }
  return true
}

function sameAnnotationRows(
  a: readonly Record<string, unknown>[],
  b: readonly Record<string, unknown>[],
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    // 以 `b`（新投影产物）的键为准：它定义了"这次投影认得的字段集"
    for (const key of Object.keys(y)) {
      if (!sameField(x[key], y[key])) return false
    }
    // 反向：`a` 里有、`b` 里没有的**投影字段**也算变化 ——
    // 例如内核删掉了 `locked`，而 legacy 还带着 `true`。
    // 只检查 `b` 认得的那类键（`ANNOTATION_FIELD_PAIRS` 的 legacy 侧）之外的键不管，
    // 故这里用"`a` 有而 `b` 明确为 undefined"来判定。
    for (const key of Object.keys(x)) {
      if (x[key] === undefined) continue
      if (y[key] === undefined && PROJECTED_KEYS.has(key)) return false
    }
  }
  return true
}

/** 投影会产出的 legacy 键（与 `runtime/annotationRead` 的字段表一致）。 */
const PROJECTED_KEYS: ReadonlySet<string> = new Set([
  'id',
  'type',
  'visible',
  'title',
  'description',
  'min',
  'max',
  'pos',
  'points',
  'color',
  'renderStyle',
  'locked',
  'frameIndex',
  'created_at',
  'updated_at',
])

/** 标量直比；对象/数组走结构比较（投影产出的是冻结的普通对象）。 */
function sameField(x: unknown, y: unknown): boolean {
  if (x === y) return true
  if (x === null || y === null || typeof x !== 'object' || typeof y !== 'object') return false
  return JSON.stringify(x) === JSON.stringify(y)
}
