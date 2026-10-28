/**
 * **捕获占位条目的真实产物回归**：半透明幽灵呈现 + cell-not-lost 判据接线。
 *
 * ## 真实入口（不是测试壳）
 *
 * `gotoWorkbench` 打开完整工作台 → 经生产拖放同一 operator 注入**真实游戏内导出件**
 * （CTM 档，含一格末影储罐占位）→ 帧循环把内核文档喂给呈现会话。
 *
 * ## 真实件的来源（仓外）
 *
 * 信封来自 `<LIGHTNING_REAL_FIXTURES_DIR>/tesr/tesr-capture-placeholder.ctm.json`（唯一夹具根键）；
 * 世界侧读数 `fixtures/tesr-capture-placeholder.read-blocks.json` 无纹理、仍留公开树。
 * 夹具缺失时**本 spec 由入口产物门控整份排除**（`e2e/real-artifact-gate.ts`）——
 * 不是在本文件里静默跳过：直接运行本 spec 而缺件会当场抛解析错误。
 *
 * ## 两条互相独立的事实
 *
 * | # | 事实 | 观测面 |
 * |---|---|---|
 * | ① | 占位条目在装配后仍是占位（6 四边形），且呈现材质是真的半透明幽灵（`transparent` + `opacity<1` + 不写深度 + 关 alphaTest） | `readRenderedDefinition` + 呈现根材质遍历 |
 * | ② | `cell-not-lost` 判据吃**同一次加载**的生产解析结果：正对照绿；把一格改成空气 ⇒ 红 | `ctx.kernelSourceRoot()` + `domain/exportIntegrity` |
 *
 * ## 画面证据
 *
 * 机位斜 20°（从 +z 偏 +x），让幽灵与身后的箱子错开半格；截图落
 * `test-results/tesr-capture/`（缺省，ignored）；可用 `I3_SHOT_DIR` 覆盖。两张图配套：
 * `ghost-on`（幽灵在画面里）与 `ghost-off`（同机位隐藏幽灵，供人眼对照背后是什么）。
 * 人眼判据：幽灵半透明（背景与箱子从它里透出来）+ 颜色仍是黑曜石色系（未被染色）。
 */
/// <reference path="./real-fixtures.d.ts" />
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { realFixturePath } from './real-fixtures.mjs'
import {
  gotoWorkbench,
  injectSceneDocumentOk,
  waitForViewportMounted,
  VIEWPORT_CANVAS,
  VIEWPORT_REGION,
} from './helpers/multiblock'
import { setCamera } from './helpers/areaLifetime'
import { cellNotLostOf, type WorldBlockRef } from '@/domain/exportIntegrity'

const DIR = path.join(import.meta.dirname, 'fixtures')
/** 仓外夹具键（`web/e2e/real-fixtures.mjs` 的固定映射）。 */
const TESR_FIXTURE_KEY = 'tesrCaptureCtm'
const ENVELOPE = 'tesr-capture-placeholder.ctm.json'
const READ_BLOCKS = 'tesr-capture-placeholder.read-blocks.json'
const SHOT_DIR = process.env.I3_SHOT_DIR ?? path.join(import.meta.dirname, '..', 'test-results', 'tesr-capture')

interface GhostObservation {
  placeholderEntries: number
  placeholderQuads: number
  ghostMaterials: number
  ghostState: { transparent: boolean; opacity: number; depthWrite: boolean; alphaTest: number; color: number } | null
  opaqueMaterials: number
  meshes: number
}

async function readGhostObservation(page: import('@playwright/test').Page): Promise<GhostObservation> {
  return (await page.evaluate((region) => {
    const ctx = (window as any).__vm__
    const slot = ctx.viewports.get(region)
    const def = slot?.definition?.value ?? null
    const palette = (def?.blockPalette ?? []) as { renderMode?: string; geometry?: { quads?: unknown[] } | null }[]
    const placeholder = palette.filter((p) => p.renderMode === 'CapturePlaceholder')
    const root = slot?.contentGroup?.value ?? null
    const materials = new Set<any>()
    let meshes = 0
    root?.traverse((o: any) => {
      if (!o?.isMesh) return
      meshes += 1
      const m = o.material
      if (Array.isArray(m)) for (const x of m) materials.add(x)
      else if (m) materials.add(m)
    })
    const all = [...materials]
    const ghosts = all.filter((m) => m.transparent === true && typeof m.opacity === 'number' && m.opacity < 1)
    const opaques = all.filter((m) => !(m.transparent === true && typeof m.opacity === 'number' && m.opacity < 1))
    const g = ghosts[0]
    return {
      placeholderEntries: placeholder.length,
      placeholderQuads: (placeholder[0]?.geometry?.quads ?? []).length,
      ghostMaterials: ghosts.length,
      ghostState: g
        ? {
            transparent: g.transparent === true,
            opacity: g.opacity,
            depthWrite: g.depthWrite !== false,
            alphaTest: typeof g.alphaTest === 'number' ? g.alphaTest : -1,
            color: typeof g.color?.getHex === 'function' ? g.color.getHex() : -1,
          }
        : null,
      opaqueMaterials: opaques.length,
      meshes,
    }
  }, VIEWPORT_REGION)) as GhostObservation
}

test.describe('TESR 捕获占位：真实产物呈现 + 完整性判据', () => {
  test('占位是半透明幽灵；cell-not-lost 在同一次加载上正绿负红 @smoke', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', '真实产物截图/材质判据固定在 desktop-chrome')
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    // 真实信封经 resolver 读仓外件（缺件即抛，带 key / 期望相对路径 / 候选）；
    // 行尾先归一化到 LF（外部件经 Windows 复制后仍可能是 CRLF）。
    const envelope = JSON.parse(
      fs.readFileSync(realFixturePath(TESR_FIXTURE_KEY), 'utf8').replace(/\r\n/g, '\n'),
    ) as unknown
    const readBlocks = JSON.parse(
      fs.readFileSync(path.join(DIR, READ_BLOCKS), 'utf8').replace(/\r\n/g, '\n'),
    ) as {
      blocks?: { pos: [number, number, number]; id?: string }[]
    }
    const blocks: WorldBlockRef[] = (readBlocks.blocks ?? []).map((b) => ({ pos: b.pos, id: b.id }))

    await gotoWorkbench(page)
    const injected = await injectSceneDocumentOk(page, envelope, ENVELOPE)
    expect(injected.docLoaded, '真实导出件必须能被生产入口加载').toBe(true)
    await waitForViewportMounted(page)
    // 帧循环 + 呈现 apply（内容身份去重，通常一拍即落）。
    await page.waitForTimeout(1500)

    // 机位：斜 20° 从 +z 偏 +x 看，让幽灵立方体与身后的箱子错开半格 ——
    // 一张图里同时能看见"背景/箱子从幽灵里透出来"与"幽灵仍是黑曜石原色"。
    await setCamera(page, VIEWPORT_REGION, {
      target: { x: -2, y: -1.5, z: 0 },
      yawDeg: 20,
      elevationDeg: 12,
      distance: 4.5,
      zoom: 1.8,
    })
    await page.waitForTimeout(600)

    // ── 画面证据 ①：幽灵在画面里（原色 + 半透明） ──
    const vp = page.locator(VIEWPORT_CANVAS)
    const ghostOn = await vp.screenshot({ path: path.join(SHOT_DIR, `ghost-on-${testInfo.project.name}.png`) })

    // ── 画面证据 ②：隐藏幽灵再拍一张（人眼对照"背后是什么"），并断言两张确实不同 ──
    const setGhostVisible = (visible: boolean) =>
      page.evaluate(
        ({ region, v }) => {
          const ctx = (window as any).__vm__
          const root = ctx.viewports.get(region)?.contentGroup?.value ?? null
          root?.traverse((o: any) => {
            const m = o.material
            if (m?.transparent === true && typeof m.opacity === 'number' && m.opacity < 1) m.visible = v
          })
        },
        { region: VIEWPORT_REGION, v: visible },
      )
    await setGhostVisible(false)
    await page.waitForTimeout(300)
    const ghostOff = await vp.screenshot({ path: path.join(SHOT_DIR, `ghost-off-${testInfo.project.name}.png`) })
    await setGhostVisible(true)
    expect(ghostOn.equals(ghostOff), '幽灵必须真的画进光栅（隐藏前后截图不得逐字节相同）').toBe(false)
    const obs = await readGhostObservation(page)
    console.log('[占位幽灵] ' + JSON.stringify(obs))
    expect(obs.placeholderEntries, '装配后必须保留一个占位条目').toBe(1)
    expect(obs.placeholderQuads, '占位几何必须是 6 个四边形').toBe(6)
    expect(obs.ghostMaterials, '呈现根里必须恰有一个幽灵材质').toBe(1)
    expect(obs.ghostState, '幽灵材质必须存在').not.toBeNull()
    expect(obs.ghostState!.transparent, '幽灵必须 transparent').toBe(true)
    expect(obs.ghostState!.opacity, '幽灵不透明度必须 < 1').toBeLessThan(1)
    expect(obs.ghostState!.opacity, '幽灵不透明度必须是约定的 0.4').toBeCloseTo(0.4, 3)
    expect(obs.ghostState!.depthWrite, '幽灵不得写深度').toBe(false)
    expect(obs.ghostState!.alphaTest, '幽灵必须关 alphaTest（否则半透明被裁掉）').toBe(0)
    expect(obs.ghostState!.color, '幽灵不得染色（保持白 + 顶点色/贴图原色）').toBe(0xffffff)
    expect(obs.opaqueMaterials, '场景里其余材质必须仍是不透明（对照）').toBeGreaterThan(0)

    // ── 画面证据 ──
    const shot = path.join(SHOT_DIR, `ghost-${testInfo.project.name}.png`)
    await page.locator(VIEWPORT_CANVAS).screenshot({ path: shot })

    // ── 判据接线：吃同一次加载的生产解析结果 ──
    const sourceRoot = (await page.evaluate(() => {
      const ctx = (window as any).__vm__
      return ctx.kernelSourceRoot()
    })) as Record<string, unknown> | null
    expect(sourceRoot, '内核源根必须可读（判据的输入来自生产解析）').not.toBeNull()
    const frames = sourceRoot!.frames as { structure?: Record<string, unknown> }[] | undefined
    const structure = frames?.[0]?.structure
    expect(structure, '源根必须带帧结构').toBeDefined()
    const rootBlockPalette = sourceRoot!.blockPalette
    const positive = cellNotLostOf({ structure: structure!, rootBlockPalette, blocks })
    console.log('[格子不丢失·正对照] ' + JSON.stringify({ ok: positive.ok, lost: positive.lostCells, violations: positive.violations }))
    expect(positive.ok, `真实产物必须判绿：${JSON.stringify(positive.violations)}`).toBe(true)

    // 负对照：同一次加载的格数据里抠掉箱子格 ⇒ 判据必红。
    const damaged = JSON.parse(JSON.stringify(structure)) as {
      cellGrid: number[][][]
      scanBounds: { minX: number; maxY: number; minZ: number }
    }
    const b = damaged.scanBounds
    const z = 64 - b.minZ
    const row = b.maxY - 12
    const col = 64 - b.minX
    expect(damaged.cellGrid[z]![row]![col], '夹具前提：箱子格有几何').not.toBe(0)
    damaged.cellGrid[z]![row]![col] = 0
    const negative = cellNotLostOf({ structure: damaged, rootBlockPalette, blocks })
    console.log('[格子不丢失·负对照] ' + JSON.stringify({ ok: negative.ok, lost: negative.lostCells, violations: negative.violations }))
    expect(negative.ok, '抠掉一格必须判红').toBe(false)
    expect(negative.lostCells).toBe(1)
  })
})
