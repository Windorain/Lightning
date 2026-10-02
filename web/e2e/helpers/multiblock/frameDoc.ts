/**
 * T2.6 无头渲染断言管线 —— 「帧为主」多帧文档合成器（T3.4 既有路径回归用）。
 *
 * 为什么合成而不落新 fixture：
 *  - 仓库现有的「帧为主」样例都是**单帧**（`web/e2e/fixtures/minimal-v2.json` 1 帧；
 *    `structuredata-exported-envelope.json`、`data/scenes/export.json` 为单帧 baked 结构），
 *    单帧时 `hasWorldMultiFrame === false`，帧控制 tab 根本不出现，无法回归帧播放语义。
 *  - 零替身原则 3「IO 接管」允许由测试提供场景数据：因此在**测试内存里**
 *    从真实导出样例 `structuredata-exported-envelope.json` 派生 3 帧注入，
 *    不新增仓库文件、不改任何 src。
 *
 * 基座选 `structuredata-exported-envelope.json` 而不是 `minimal-v2.json` 的原因（实测）：
 *  - `minimal-v2.json` 的 `textureBlobs` 是 `{id,mime,dataBase64}[]` 对象数组，
 *    渲染侧 `rootTextureBlobs()` 只认 `string[]`，实测会报
 *    `[drw] buildBlockMesh Error: 纹理未预取: 0` → 网格建不出来，
 *    截图非空断言会退化成「只截到 UI chrome」，失去意义；
 *  - `structuredata-exported-envelope.json` 是真实桌面导出信封（57 条 base64 纹理），
 *    能真正渲染出几何，截图断言才有内容。
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const HERE = import.meta.dirname
/** 真实导出信封样例（只读）`web/e2e/fixtures/structuredata-exported-envelope.json`。 */
export const FRAME_FIXTURE = path.join(HERE, '..', '..', 'fixtures', 'structuredata-exported-envelope.json')

export interface FrameExpectation {
  /** 该帧 `cellGrid` 的形状 `[d, h, w]`（`[z][y][x]`）。 */
  d: number
  h: number
  w: number
  /** 非空格数（下标 ≠ 0）。 */
  solidCells: number
}

/** 解出真实结构（`payload` = gzip+base64）。 */
function readRealStructure(): {
  cellGrid: number[][][]
  blockPalette: unknown[]
  materialPalette: unknown
  textureBlobs: unknown
  tooltipPalette: unknown
} {
  const envelope = JSON.parse(fs.readFileSync(FRAME_FIXTURE, 'utf8')) as { payload: string }
  const plain = JSON.parse(
    zlib.gunzipSync(Buffer.from(envelope.payload, 'base64')).toString('utf8'),
  ) as Record<string, unknown>
  return {
    cellGrid: plain.cellGrid as number[][][],
    blockPalette: plain.blockPalette as unknown[],
    materialPalette: plain.materialPalette,
    textureBlobs: plain.textureBlobs,
    tooltipPalette: plain.tooltipPalette,
  }
}

function countSolid(cellGrid: number[][][]): number {
  let n = 0
  for (const slice of cellGrid) for (const row of slice) for (const c of row) if (c !== 0) n++
  return n
}

/**
 * 三帧的帧体 grid（全部来自真实结构，形状/实心数两两不同）：
 *  - frame 0：完整结构；
 *  - frame 1：砍掉最上面 2 个 z 切片（结构变矮）；
 *  - frame 2：保留全部切片但 y ≥ 3 的行挖空（结构变稀疏）。
 * 「帧真的切了」由此具备机器可判定的形态差异。
 */
function buildFrameGrids(): number[][][][] {
  const full = readRealStructure().cellGrid
  const cut = full.slice(0, full.length - 2)
  const zeroed = full.map((slice) => slice.map((row, y) => (y >= 3 ? row.map(() => 0) : row)))
  return [full, cut, zeroed]
}

const FRAME_GRIDS = buildFrameGrids()

/** 由 `FRAME_GRIDS` 导出的期望（硬编码语义 = 形状 + 实心数，不看任何被测输出）。 */
export const FRAME_EXPECTATIONS: FrameExpectation[] = FRAME_GRIDS.map((g) => ({
  d: g.length,
  h: g[0]!.length,
  w: g[0]![0]!.length,
  solidCells: countSolid(g),
}))

/** 帧数 = 3。 */
export const FRAME_COUNT = FRAME_GRIDS.length

/**
 * 生成 3 帧「帧为主」V2Plain 文档（`format_version: "2.0"` + `frames[]`，
 * 无 `documentShape` → 缺省即帧为主，契约 §2.1）。
 *
 * 每帧自带 `structure.cellGrid` + `structure.blockPalette`（V2Plain 既有语义，一行未改），
 * `materialPalette` / `textureBlobs` / `tooltipPalette` 在根级（与 `serialize()` 的产出同形）。
 */
export function buildFrameDominantMultiframeDocument(): Record<string, unknown> {
  const real = readRealStructure()
  return {
    format_version: '2.0',
    id: 'e2e-multiframe-frame-dominant',
    meta: {
      name: 'E2E Multiframe (frame-dominant)',
      author: 'T2.6 harness',
      created_at_ms: 0,
      description: '由 structuredata-exported-envelope.json 派生的 3 帧回归样例',
      tags: [],
      origin: { x: 0, y: 0, z: 0 },
    },
    frames: FRAME_GRIDS.map((cellGrid, i) => ({
      index: i,
      label: `frame-${i}`,
      durationMs: 120,
      structure: {
        geometryPhase: 'baked',
        cellGrid,
        blockPalette: real.blockPalette,
      },
    })),
    annotations: [],
    labels: [],
    materialPalette: real.materialPalette,
    textureBlobs: real.textureBlobs,
    tooltipPalette: real.tooltipPalette,
  }
}
