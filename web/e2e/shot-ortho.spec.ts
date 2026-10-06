/**
 * #87 指定正交机位出图 e2e —— **验收器具**：把 SDE 导出的结构 JSON 按 MC 控制面 `CameraSpec`
 * 指定的正交机位逐台出 PNG，落盘到 `MB_SHOT_DIR`。
 *
 * 与 `texture-uv-orientation.spec.ts` 的分工：
 *  - 那个 spec 用视口相机 + `canvas.screenshot()` 做**目视对照**；
 *  - 本 spec 走 `OPERATOR_EXPORT_SHOT_PNG`（真实下载链路）出**离屏正交图**，
 *    机位由 env 给定，像素直接可进证据链。
 *
 * 环境变量（**缺任一即抛错**，不静默跳过）：
 *   LIGHTNING_SHOT_E2E_PORT  dev server 端口（见 playwright.shot.config.ts；不在本文件校验）
 *   MB_SHOT_PRODUCT          导出 JSON 绝对路径（Envelope 或 plain，两种都收）
 *   MB_SHOT_CAMERAS          JSON 数组 [{ name, pos:[x,y,z], yaw, pitch, orthoHeight, width, height }]（MC 口径）
 *   MB_SHOT_CENTER           JSON [x,y,z]：结构中心的 MC 世界坐标（由 scanBounds + cellGrid 尺寸复原）
 *   MB_SHOT_DIR              出图目录（不存在则创建）
 *   MB_SHOT_MIN_BBOX        （可选）每台机位的**非底色包围盒下界** JSON `{ "<camName>": { w, h } }`：
 *                           给定时断言该机位出图的非底色包围盒不小于它——这是「内容被近/远平面裁掉、
 *                           或结构出画」的**形状级**判据（#87 ortho-north 只出孤立一枚即由此暴露：
 *                           横排 5 格 → w 应为 600px）。缺省不校验。
 *
 * 运行：见 `playwright.shot.config.ts` 文件头。
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'

import {
  gotoWorkbench,
  injectSceneDocument,
  readContentMesh,
  waitForDocLoaded,
} from './helpers/multiblock'

interface ShotCameraEnv {
  name: string
  pos: [number, number, number]
  yaw: number
  pitch: number
  orthoHeight: number
  width: number
  height: number
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (v === undefined || v === '') {
    throw new Error(`${name} 未设置：本 spec 全部输入由环境变量驱动，缺任一即无法出图（不做默认回落）`)
  }
  return v
}

function parseJsonEnv<T>(name: string, raw: string): T {
  try {
    return JSON.parse(raw) as T
  } catch (e) {
    throw new Error(`${name} 不是合法 JSON：${String(e)}；原文=${raw}`)
  }
}

const PRODUCT = path.resolve(requireEnv('MB_SHOT_PRODUCT'))
const CAMERAS = parseJsonEnv<ShotCameraEnv[]>('MB_SHOT_CAMERAS', requireEnv('MB_SHOT_CAMERAS'))
const CENTER = parseJsonEnv<[number, number, number]>('MB_SHOT_CENTER', requireEnv('MB_SHOT_CENTER'))
const OUT_DIR = path.resolve(requireEnv('MB_SHOT_DIR'))

/**
 * 可选「轮廓下界」：`{ "<camName>": { w, h } }`。
 * 给了就按机位断言非底色包围盒不小于它（形状级判据），不给就只跑通用的「非空白」判据。
 */
const MIN_BBOX: Record<string, { w: number; h: number }> | null = process.env.MB_SHOT_MIN_BBOX
  ? parseJsonEnv<Record<string, { w: number; h: number }>>('MB_SHOT_MIN_BBOX', process.env.MB_SHOT_MIN_BBOX)
  : null

if (!fs.existsSync(PRODUCT)) {
  throw new Error(`MB_SHOT_PRODUCT 指向的文件不存在：${PRODUCT}`)
}
if (!Array.isArray(CAMERAS) || CAMERAS.length === 0) {
  throw new Error(`MB_SHOT_CAMERAS 必须是非空数组，实际 ${JSON.stringify(CAMERAS)}`)
}
for (const [i, cam] of CAMERAS.entries()) {
  if (!cam || typeof cam.name !== 'string' || cam.name.length === 0) {
    throw new Error(`MB_SHOT_CAMERAS[${i}].name 必须是非空字符串（决定输出文件名），实际 ${JSON.stringify(cam?.name)}`)
  }
  if (!Array.isArray(cam.pos) || cam.pos.length !== 3) {
    throw new Error(`MB_SHOT_CAMERAS[${i}].pos 必须是长度 3 的数组，实际 ${JSON.stringify(cam.pos)}`)
  }
}
if (!Array.isArray(CENTER) || CENTER.length !== 3) {
  throw new Error(`MB_SHOT_CENTER 必须是长度 3 的数组，实际 ${JSON.stringify(CENTER)}`)
}

/** 读产物：Envelope（有 `payload`）或 plain（本身就是内层 JSON），两种都直接交给 `OPERATOR_OPEN_SCENE`。 */
function readProductJson(absPath: string): { json: unknown; kind: 'envelope' | 'plain' } {
  const parsed = JSON.parse(fs.readFileSync(absPath, 'utf8')) as Record<string, unknown>
  const isEnvelope = typeof parsed.payload === 'string'
  return { json: parsed, kind: isEnvelope ? 'envelope' : 'plain' }
}

interface NonBackgroundStats {
  /** 非底色包围盒（像素） */
  minX: number
  minY: number
  width: number
  height: number
  /** 非底色像素数 / 总像素数 */
  areaRatio: number
  /** 非底色像素数 */
  count: number
  total: number
}

/**
 * 在页面里解 PNG 并统计「非底色（天空蓝）像素」的包围盒与占比。
 *
 * 为什么放在页面里：断言需要真实解码后的像素，而在浏览器里 `Image` + `canvas` 是零依赖路径
 * （Node 侧没有图像解码库）。这张图正是页面自己渲染出来的，用同一个环境解码不引入新替身。
 */
async function readNonBackgroundStats(
  page: import('@playwright/test').Page,
  pngBase64: string,
  tolerance = 12,
): Promise<NonBackgroundStats> {
  return await page.evaluate(
    async ({ b64, tol }) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('2D context 不可用，无法校验出图像素')
      ctx.drawImage(img, 0, 0)
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      // 底色 = 天空蓝 0x9ec6e8（与 bakeShotPngDataUrl 的 SHOT_DEFAULT_BACKGROUND 一致）
      const sky = [0x9e, 0xc6, 0xe8]
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      let count = 0
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const i = (y * canvas.width + x) * 4
          const isSky =
            Math.abs(data[i]! - sky[0]!) <= tol &&
            Math.abs(data[i + 1]! - sky[1]!) <= tol &&
            Math.abs(data[i + 2]! - sky[2]!) <= tol
          if (isSky) continue
          count++
          if (x < minX) minX = x
          if (y < minY) minY = y
          if (x > maxX) maxX = x
          if (y > maxY) maxY = y
        }
      }
      const total = canvas.width * canvas.height
      return {
        minX: count ? minX : -1,
        minY: count ? minY : -1,
        width: count ? maxX - minX + 1 : 0,
        height: count ? maxY - minY + 1 : 0,
        areaRatio: total ? count / total : 0,
        count,
        total,
      }
    },
    { b64: pngBase64, tol: tolerance },
  )
}

test.describe('#87 指定正交机位出图', () => {
  test(`按 ${CAMERAS.length} 台 MC 机位出图 → ${OUT_DIR}`, async ({ page }) => {
    const product = readProductJson(PRODUCT)
    fs.mkdirSync(OUT_DIR, { recursive: true })

    /** 收集页面级异常：算子 `exec` 的抛错不会让 `page.evaluate` 变红（registry 吞异常），必须显式观测 */
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(`console.error: ${m.text()}`)
    })

    await gotoWorkbench(page)

    const injected = await injectSceneDocument(page, product.json, path.basename(PRODUCT))
    expect(
      injected.docLoaded,
      `场景注入失败（${PRODUCT}，kind=${product.kind}）：${injected.parseError}`,
    ).toBe(true)
    await waitForDocLoaded(page)
    expect(
      injected.isMultiblock,
      `${PRODUCT} 被判为「多方块为主」：本器具只服务单结构，拒绝出图`,
    ).toBe(false)

    // 等挂载期 mesh 世代稳定（两次连读一致即认为重建已停下；照 texture-uv-orientation.spec.ts）
    let uuid = (await readContentMesh(page)).uuid
    for (let i = 0; i < 120; i++) {
      await page.waitForTimeout(50)
      const cur = (await readContentMesh(page)).uuid
      if (cur !== null && cur === uuid) break
      uuid = cur
    }
    expect(uuid, '内容 mesh 未落地（世代 uuid 为空）').not.toBeNull()

    const written: string[] = []
    for (const cam of CAMERAS) {
      const target = path.join(OUT_DIR, `${cam.name}.png`)
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 120_000 }),
        page.evaluate(
          async ({ cam: camera, center }) => {
            const ctx = (window as any).__vm__
            await ctx.getOperators().exec('OPERATOR_EXPORT_SHOT_PNG', { ...camera, center })
          },
          { cam, center: CENTER },
        ),
      ])
      await download.saveAs(target)
      const bytes = fs.statSync(target).size
      expect(
        bytes,
        `${cam.name}：PNG 为 0 字节（下载事件触发但内容为空，通常是渲染/下载链路静默失败）`,
      ).toBeGreaterThan(0)

      /**
       * 「出图非空白」硬断言（不是只查文件大小——纯天空底也能写出几十 KB）。
       * 判据：非底色包围盒的面积占比 ≥ 0.02%，且非底色的高度 ≥ 3px。
       * 底色=天空蓝（默认），用容差比较；缺省相机出图若跑偏/出画会立刻变红。
       */
      const stats = await readNonBackgroundStats(page, fs.readFileSync(target).toString('base64'))
      expect(
        stats.height,
        `${cam.name}：画面里没有非底色内容（疑似结构出画或整幅纯天空）stats=${JSON.stringify(stats)}`,
      ).toBeGreaterThanOrEqual(3)
      expect(
        stats.areaRatio,
        `${cam.name}：非底色面积过小 ${JSON.stringify(stats)}`,
      ).toBeGreaterThan(2e-4)

      /**
       * 形状级判据（可选）：轮廓是「内容有没有被裁」的直接观测量。
       * #87 ortho-north 的实际形态：横排 5 格（600×120）被近平面整面裁掉后只剩孤立一枚（120×120），
       * 面积占比判据照样通过 —— 只查"非空白"抓不住这类缺陷，故补这一条。
       */
      const minBox = MIN_BBOX?.[cam.name]
      if (minBox) {
        expect(
          stats.width,
          `${cam.name}：非底色包围盒宽 ${stats.width}px < 预期下界 ${minBox.w}px（最前一层被裁 / 结构出画）stats=${JSON.stringify(stats)}`,
        ).toBeGreaterThanOrEqual(minBox.w)
        expect(
          stats.height,
          `${cam.name}：非底色包围盒高 ${stats.height}px < 预期下界 ${minBox.h}px（最前一层被裁 / 结构出画）stats=${JSON.stringify(stats)}`,
        ).toBeGreaterThanOrEqual(minBox.h)
        test.info().annotations.push({
          type: 'minBbox',
          description: `${cam.name} ≥ ${minBox.w}x${minBox.h}`,
        })
      }

      written.push(target)
      test.info().annotations.push({
        type: 'shot',
        description: `${cam.name} yaw=${cam.yaw} pitch=${cam.pitch} orthoHeight=${cam.orthoHeight} ${cam.width}x${cam.height} → ${target} (${bytes}B) bbox=${stats.width}x${stats.height}@(${stats.minX},${stats.minY})`,
      })
      console.log(
        `[shot-ortho] ${cam.name} → ${target} (${bytes}B) bbox=${stats.width}x${stats.height}@(${stats.minX},${stats.minY}) areaRatio=${stats.areaRatio.toExponential(2)}`,
      )
    }

    expect(written.length, '未产出任何图').toBe(CAMERAS.length)
    expect(
      pageErrors.filter((e) => !e.includes('favicon') && !e.includes('Failed to load resource')),
      '页面报错（算子 exec 抛错会被 operator registry 吞掉，只能从这里看见）',
    ).toEqual([])

    test.info().annotations.push({ type: 'product', description: PRODUCT })
    test.info().annotations.push({ type: 'center', description: JSON.stringify(CENTER) })
    test.info().annotations.push({ type: 'outDir', description: OUT_DIR })
  })
})
