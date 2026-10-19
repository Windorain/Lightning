/**
 * B-1 · 部件级描边 mask —— e2e 断言 + 对比截图（issue #34 / #4）。
 *
 * 观测面（零替身）：完整 WorkbenchRoot → 注入 fixture（生产 IO 路径）→ Wiki 工作区
 * （生产 EmbedViewport）→ 生产悬停注入（`injectHoverAtCellLocal`）→ 读**真正喂给
 * Sobel 的 mask 几何**（`ctx.viewports.get('r-wiki-preview').outlinePass.maskScene`，
 * 见 `runtime/drw.ts#bindSelectionOutline` → `SelectionOutlinePass.setMaskMeshes`）。
 *
 * 断言口径：mask 世界顶点 AABB - 格世界角 = 格内局部 AABB（与 `PartRecord.boxes`
 * 同一空间，契约 §6.1）。修复前 = 整格并集（4 面），修复后 = 所指部件的盒 union。
 *
 * 截图（`web/e2e/screenshots/parts/`，gitignore 内）：
 *  - `b1-{before,after}-{cable,toggle,storage}-hover.png`：同视角、逐部件悬停；
 *  - 调用方（本任务）另用 `--project=desktop-chrome` 跑一次生成对比图。
 */
import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  gotoWikiPreviewWithScene,
  probeHover,
  clearWikiHover,
  readPartsFixture,
  augmentFixtureGeometry,
  normalizeTextureBlobsForRender,
  quadCenter,
  readOutlineMask,
  maskLocalAabb,
  readGridSize,
  screenshotWikiViewport,
  type QuadCorners,
} from './helpers/parts'

const SHOT_DIR = path.join(import.meta.dirname, 'screenshots', 'parts')
const AE2_GRID = { w: 2, h: 1, d: 1 }

/** AE2 线缆格（palette 1）：三部件事先画好的可命中面（与 P2.5 悬停包同一副本）。 */
const AE2_AUGMENT_QUADS = {
  cable: [[0.375, 0.375, 0.375], [0.375, 0.375, 0.625], [0.375, 0.625, 0.625], [0.375, 0.625, 0.375]] as QuadCorners,
  toggle: [[0.375, 0.375, 0], [0.625, 0.375, 0], [0.625, 0.625, 0], [0.375, 0.625, 0]] as QuadCorners,
  storage: [[0.1875, 1, 0.1875], [0.8125, 1, 0.1875], [0.8125, 1, 0.8125], [0.1875, 1, 0.8125]] as QuadCorners,
} as const
/** AE2 石头格（palette 2，无部件）：满方块对照。 */
const AE2_STONE_QUAD = [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]] as QuadCorners

function augmentedAe2Fixture(): Record<string, unknown> {
  let f = readPartsFixture('parts-ae2-multibox.v2.json')
  f = augmentFixtureGeometry(f, 1, [AE2_AUGMENT_QUADS.cable, AE2_AUGMENT_QUADS.toggle, AE2_AUGMENT_QUADS.storage])
  f = augmentFixtureGeometry(f, 2, [AE2_STONE_QUAD])
  return normalizeTextureBlobsForRender(f)
}

const CELL = { col: 0, row: 0, z: 0 }

test.describe('B-1 · 描边 mask 从整格收敛到部件', () => {
  test('同格三部件悬停 → mask 几何各自不同且贴合部件盒；满方块格为整格（无回归）', async ({ page }, testInfo) => {
    test.setTimeout(180_000)
    await gotoWikiPreviewWithScene(page, augmentedAe2Fixture(), 'parts-ae2-multibox.b1-outline.json')
    const size = await readGridSize(page)
    expect({ w: size.w, h: size.h, d: size.d }, 'fixture 网格尺寸').toEqual(AE2_GRID)

    fs.mkdirSync(SHOT_DIR, { recursive: true })
    const shots: Record<string, string> = {}
    const observed: Record<string, unknown> = {}

    for (const [name, quad, partLocalId] of [
      ['cable', AE2_AUGMENT_QUADS.cable, 'ae2:UNKNOWN'],
      ['toggle', AE2_AUGMENT_QUADS.toggle, 'ae2:NORTH'],
      ['storage', AE2_AUGMENT_QUADS.storage, 'ae2:UP'],
    ] as const) {
      await clearWikiHover(page)
      const probe = await probeHover(
        page,
        { ...CELL, ...quadCenter(quad) },
        h => h?.part?.localId === partLocalId,
      )
      expect(probe.hover.part?.localId, `${name} 悬停命中部件身份`).toBe(partLocalId)

      const mask = await readOutlineMask(page)
      const local = maskLocalAabb(mask, CELL, size)
      observed[name] = { part: partLocalId, meshCount: mask.meshCount, vertexCount: mask.vertexCount, local }
      expect(local, `${name} 有可见 mask（观测 ${JSON.stringify(observed[name])}）`).not.toBeNull()

      // mask 是 rAF/帧后写入的：等一帧再截图，保证截到的是稳定态
      await page.waitForTimeout(150)
      const file = path.join(SHOT_DIR, `b1-after-${name}-hover.png`)
      await screenshotWikiViewport(page, file)
      shots[name] = file
    }

    // ── 定向断言：三部件 mask 局部 AABB 两两不同 ──
    const keys = Object.values(observed).map(o => JSON.stringify((o as { local: unknown }).local))
    expect(new Set(keys).size, '同格三部件 ⇒ 三个不同的 mask').toBe(3)

    // ── 贴合断言（硬编码自 PartRecord.boxes，契约 §3/§6）──
    const cable = (observed.cable as { local: { min: number[]; max: number[] } }).local
    const toggle = (observed.toggle as { local: { min: number[]; max: number[] } }).local
    const storage = (observed.storage as { local: { min: number[]; max: number[] } }).local

    expect(cable.min, '线缆 mask 下界 = 其视觉盒 union 下界').toEqual([0.375, 0.375, 0.3125])
    expect(cable.max, '线缆 mask 上界 = 其视觉盒 union 上界（不含存储总线顶面 y=1）').toEqual([0.625, 0.75, 0.625])
    expect(toggle.min, '切换总线 mask 下界（z 收到 0）').toEqual([0.375, 0.375, 0])
    expect(toggle.max, '切换总线 mask 上界').toEqual([0.625, 0.625, 0.3125])
    expect(storage.min, '存储总线 mask 下界（中段盒）').toEqual([0.125, 0.75, 0.125])
    expect(storage.max, '存储总线 mask 上界（顶面板碰撞盒最外沿）').toEqual([0.875, 1, 0.875])

    // 修复前整格并集 = x/z [0.1875,0.8125]、y [0.375,1]；线缆 mask 不得与之重合
    expect(cable.max[1], '线缆描边不再包住整格顶部').toBeLessThan(1)

    // ── 回归：满方块格（石头，无部件）mask = 整格几何，与修复前逐项一致 ──
    await clearWikiHover(page)
    const stone = await probeHover(page, { ...CELL, col: 1, ...quadCenter(AE2_STONE_QUAD) }, h => h !== null && h.part === null)
    expect(stone.hover.part, '满方块格不携带部件命中').toBeNull()
    const stoneMask = await readOutlineMask(page)
    const stoneLocal = maskLocalAabb(stoneMask, { ...CELL, col: 1 }, size)!
    // 石头 palette 几何 = +z 面 + +y 顶面（整格几何的两块面）
    expect(stoneLocal.min).toEqual([0, 0, 0])
    expect(stoneLocal.max).toEqual([1, 1, 1])
    const stoneFile = path.join(SHOT_DIR, 'b1-regression-fullcube-stone-hover.png')
    await screenshotWikiViewport(page, stoneFile)

    console.log(`[B-1] mask 局部 AABB = ${JSON.stringify(observed)}`)
    console.log(`[B-1] 满方块对照 mask = ${JSON.stringify(stoneLocal)}；截图 = ${JSON.stringify({ ...shots, stone: stoneFile })}`)
    testInfo.attach('b1-outline-observation', {
      body: JSON.stringify({ observed, stoneLocal, project: testInfo.project.name }, null, 1),
      contentType: 'application/json',
    })
  })
})
