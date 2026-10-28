/**
 * `composition/kernelPickAdapter` —— **内核拾取 → 拾取契约形状**。
 *
 * ## 为什么必须有它（真实缺口，不是"顺手抽象")
 *
 * 工作台/嵌入两侧的拾取入口是 `context/queries#pickEntity`，它把
 * `render/interaction/scenePick#ScenePickParams` 喂给旧实现，而旧实现的两条假设
 * **只对 legacy `blockMesh` 成立**：
 *
 *  1. `contentGroup` 下的 Mesh 挂 `userData.triangleMap`（`scenePick.ts:225-227`）；
 *  2. 世界坐标由 `Raycaster` 命中点给出。
 *
 * 画面切到 `PresenterSession` 后假设 1 **不再成立**（内核批次的标签是
 * `batchTagOf` 的 `{batchIndex, compatibilityKey, objectIds}`，逐格身份在
 * `PickIndex` 的 `TriangleCellMap` 里，按**内容身份 + 世代**查，不挂在 Mesh 上）。
 * 若只切画面不切拾取，结果是**静默**的：射线仍然命中，只是解不出任何方格
 * ⇒ 点选"没反应"，而没有任何断言会响。本模块是那条断言的落点。
 *
 * ## 判据为什么能区分两条路（而不是"看起来都能选"）
 *
 * 输入是 `PresenterSession#pickAt` 的 `PickResolution`（对象身份 + 元素身份 +
 * **格身份** + 命中时的求值键/世代），映射规则与 legacy 逐字段同口径：
 *
 * | 输出字段 | 来源 | 与 legacy 的关系 |
 * |---|---|---|
 * | `column` / `row` / `zSlice` / `quadIndex` | `resolution.cell` | **逐字同名**（`presentation/cellIdentity#CellRef` 明文沿用 legacy 口径） |
 * | `blockId` | `paletteEntryOf(...)` → `registryId` + `meta` → `presentation/blockRegistryKey` | 内核网格读面（`runtime/gridRead`）+ 呈现层键口径。**不是** `at().name`（编码后的截前缀短名 ⇒ 静默失配） |
 * | `distance` / `point` | `PresenterPickResult` | 与 `resolution` **同一次射线**（不重射） |
 *
 * ## 纯性
 *
 * 无 IO、无 DOM、无 Vue、不改入参。**不**做坐标翻转（翻转只发生在
 * 拾取→选择边界，见 `context/queries#pickVoxel` 的 `structureRowToWorldY`）——
 * 在本层翻一次会让"两处翻转定义"重新出现（既有负对照要防的形态）。
 */

import { structureRowToWorldY } from '@/pure/vec'
import type { KernelGridView } from '@/runtime/gridRead'
import { blockRegistryKey } from '@/presentation/blockRegistryKey'
import type { PickResolution } from '@/presentation/pickingIndex'
import type { PresenterHit } from '@/composition/presenterSession'

/** 本适配器的输出：与 legacy `ScenePickBlock` **逐字段同形**（便于判据逐字段对账）。 */
export interface KernelScenePickBlock {
  readonly kind: 'block'
  readonly distance: number
  readonly blockId: string
  readonly column: number
  readonly row: number
  readonly zSlice: number
  readonly quadIndex: number | undefined
  readonly point: { readonly x: number; readonly y: number; readonly z: number }
}

/** 内核命中的**逐格**部分（`resolution.cell` 缺席时的显式原因）。 */
export type KernelPickSkip =
  | { readonly kind: 'no-cell'; readonly detail: string }
  | { readonly kind: 'cell-not-in-grid'; readonly detail: string }
  | { readonly kind: 'cell-palette-missing'; readonly detail: string }
  | { readonly kind: 'cell-is-air'; readonly detail: string }

export type KernelPickOutcome =
  | { readonly ok: true; readonly block: KernelScenePickBlock }
  | { readonly ok: false; readonly skip: KernelPickSkip }

export interface KernelPickInput {
  readonly resolution: PickResolution
  readonly point: readonly [number, number, number]
  readonly distance: number
  readonly grid: KernelGridView
  /**
   * 分层预览的**世界 Y**（`null` = 不分层）。
   *
   * 取新层形状（`number | null`，与 `PresenterSession#setLayerPreview` /
   * `kernelPresentationInputs` 同一取值域），**不**取 legacy 的 `'all' | {worldY}`
   * 联合：后者定义在 `render/data/layerPreview`（深度 3），装配根 import 它会被
   * `gate/no-private-cross-layer` 判红（公共出口最大深度 2）。
   */
  readonly layerWorldY: number | null
}

/**
 * 内核命中 → `ScenePickBlock` 形状。
 *
 * 三种"解不出"的情形**显式分列**（而不是一起返回 `null`）：调用方对它们的处置不同 ——
 * `no-cell` 是"这份几何不是逐格来源"（合法），`cell-not-in-grid` 是
 * "格表与 GPU 状态不一致"（**真实缺陷**，必须暴露），`cell-is-air` 是"点到了空格"
 * （合法但无选择意义）。
 */
export function kernelPickBlockOf(input: KernelPickInput): KernelPickOutcome {
  const cell = input.resolution.cell
  if (cell === undefined) {
    return {
      ok: false,
      skip: {
        kind: 'no-cell',
        detail:
          `对象 ${input.resolution.objectId} 的几何不携带逐格身份（不是 blockGrid 来源，`
          + '或调用方未提供三角形序号）—— 不猜格，如实报出',
      },
    }
  }
  const worldY = structureRowToWorldY(cell.row, input.grid.height)
  const volume = input.grid

  // 内核网格读面直接给格视图；`null` = 该格不在当前网格里。
  const at = volume.at({ x: cell.column, y: worldY, z: cell.zSlice })
  if (at === null) {
    return {
      ok: false,
      skip: {
        kind: 'cell-not-in-grid',
        detail:
          `命中格 (col=${cell.column}, row=${cell.row}, z=${cell.zSlice}) 不在内核网格 `
          + `(${volume.width}x${volume.height}x${volume.depth}) 内 —— 几何与网格不一致（真实缺陷）`,
      },
    }
  }

  // legacy 口径的**分层**判定：`effectiveVoxelState` 只在
  // `structureRowToWorldY(row, sizeRow) === mode.worldY` 时返回真实体素。
  // 这里用**同一函数**判（而不是重写一遍比较），故"分层预览下的命中语义"
  // 不因切链而变 —— 两份实现必然漂移，本工程已三度实测。
  if (input.layerWorldY !== null && structureRowToWorldY(cell.row, volume.height) !== input.layerWorldY) {
    return {
      ok: false,
      skip: {
        kind: 'cell-is-air',
        detail:
          `命中格 (col=${cell.column}, row=${cell.row}, z=${cell.zSlice}) 不在分层预览的 Y=${input.layerWorldY} 层`
          + '上 ⇒ 该层视图下它是空气（无可选对象）',
      },
    }
  }

  // legacy 的 `blockRegistryKeyForPalette` 口径（`meta === 0` ⇒ 裸 `registryId`）：
  // 这是**外部契约**（侧栏高亮、tooltip、导出都按此键对齐），不是可自选的形式。
  //
  // ⚠️ **必须取调色板条目的 `registryId`，不能取 `grid.at().name`**（实测擒获）：
  // `at.name` 是单元值编码里的**已截命名空间**名字（`pure/gridTypes.ts:18`：
  // `cells` 的值就是 `minecraft:<name>:<meta>`）⇒ `at.name === 'stone'` 而 legacy 键是
  // `minecraft:stone`。这一字之差在外观上是"命中仍然成功、tooltip/侧栏却查不到"的**静默回退**
  // （`neiTooltipMap` 按 `registryId` 建键 ⇒ 永远不中）。
  //
  // 为什么早先的判据没抓到它：那条判据的期望值用**同一个** `grid.at()` 现算
  // （`at.meta === 0 ? at.name : …`）⇒ 与被测实现同源 ⇒ 恒绿。现在把期望改成
  // **独立来源**（结构定义的调色板 / 真实 registryId），并加"短名必须判红"的负对照。
  const entry = volume.paletteEntryOf({ x: cell.column, y: worldY, z: cell.zSlice })
  if (entry === null) {
    return {
      ok: false,
      skip: {
        kind: 'cell-palette-missing',
        detail:
          `命中格 (col=${cell.column}, row=${cell.row}, z=${cell.zSlice}) 在**调色板**里没有条目`
          + '（`paletteEntryOf` 答 null，可能因歧义拒绝）—— 解不出方块身份（真实缺陷）',
      },
    }
  }
  const blockId = blockRegistryKey(entry.registryId, entry.meta)
  if (blockId === 'air' || entry.registryId === 'air') {
    return {
      ok: false,
      skip: {
        kind: 'cell-is-air',
        detail: `命中格 (col=${cell.column}, row=${cell.row}, z=${cell.zSlice}) 是空气（无可选对象）`,
      },
    }
  }

  return {
    ok: true,
    block: {
      kind: 'block',
      distance: input.distance,
      blockId,
      column: cell.column,
      row: cell.row,
      zSlice: cell.zSlice,
      quadIndex: cell.quadIndex,
      point: { x: input.point[0], y: input.point[1], z: input.point[2] },
    },
  }
}

/** 轮换拾取的候选（与 legacy `ScenePickEntity` 的 **block** 分支逐字段同形）。 */
export interface KernelScenePickEntity {
  readonly kind: 'block'
  readonly distance: number
  readonly blockId: string
  readonly column: number
  readonly row: number
  readonly zSlice: number
  readonly quadIndex: number | undefined
  readonly normal: { readonly x: number; readonly y: number; readonly z: number } | undefined
  readonly point: { readonly x: number; readonly y: number; readonly z: number }
}

/**
 * 一条射线上的全部候选（去重口径与 legacy `scenePickAllFromPointer` **同一把键**：
 * `column,row,zSlice` —— 同格的不同面只算一个候选，否则轮换会在同一格上打转）。
 *
 * 输入必须是 `PresenterSession#pickAllAt` 的 `hits`（**按距离升序**，与 legacy 相同）。
 * 本函数**不**排序：排序是射线的事实，重排会把"离相机更远的候选"提到前面。
 */
export function kernelPickEntitiesOf(input: {
  readonly hits: readonly PresenterHit[]
  readonly grid: KernelGridView
  readonly layerWorldY: number | null
}): readonly KernelScenePickEntity[] {
  const seen = new Set<string>()
  const out: KernelScenePickEntity[] = []
  for (const hit of input.hits) {
    const out0 = kernelPickBlockOf({
      resolution: hit.resolution,
      point: hit.point,
      distance: hit.distance,
      grid: input.grid,
      layerWorldY: input.layerWorldY,
    })
    if (!out0.ok) continue
    const b = out0.block
    const key = `${b.column},${b.row},${b.zSlice}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(
      Object.freeze({
        kind: 'block' as const,
        distance: b.distance,
        blockId: b.blockId,
        column: b.column,
        row: b.row,
        zSlice: b.zSlice,
        quadIndex: b.quadIndex,
        normal: hit.normal === null ? undefined : { x: hit.normal[0], y: hit.normal[1], z: hit.normal[2] },
        point: b.point,
      }),
    )
  }
  return Object.freeze(out)
}
