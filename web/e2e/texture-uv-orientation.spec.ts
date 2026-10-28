/**
 * 纹理朝向（BUG: 多方块产物覆盖层图标上下颠倒 / UV 不正确）—— **目视对照截图**。
 *
 * 与 `scripts/multiblock-pipeline/verify-uv-orientation.mjs` 的分工：
 *  - 数据级门禁（同一面内「.extFacing() 覆盖层手性 == 基础贴图手性」）在脚本里，可进 CI；
 *  - 本 spec 只负责**把同一份产物渲染成可肉眼比对的画面**（修复前 / 修复后 / 主菜单态参照），
 *    由环境变量驱动，不把截图固化成 CI 门禁（渲染像素不是绝对确定的，见 real-acceptance 文件头）。
 *
 * 环境变量：
 *   MB_UV_PRODUCT  产物文件（`.multiblock.json`）绝对路径；缺省 = 仓库内修复后的 EBF 产物
 *   MB_UV_SHOT     截图输出路径（PNG）；缺省 = `e2e/screenshots/uv-fix/shot.png`
 *   MB_UV_YAW      相机方位角（度）：0 = 从 +z 侧看（南面），180 = 从 -z 侧看（北面 = 控制器正面）
 *   MB_UV_LABEL    日志标签
 *
 * 运行：cd web && MB_UV_PRODUCT=... MB_UV_SHOT=... npx playwright test texture-uv-orientation --project=desktop-chrome
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import {
  TIER_SLIDER,
  VIEWPORT_CANVAS,
  gotoWorkbench,
  injectSceneDocumentOk,
  loadRealProduct,
  openChannelTabReady,
  readContentMesh,
  readPixelStats,
  waitForMeshIdle,
} from './helpers/multiblock'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const DEFAULT_PRODUCT = path.join(
  REPO_ROOT,
  'mod',
  'gtnh',
  'run',
  'client',
  'sde_multiblock_exports',
  'mteelectricblastfurnace.multiblock.json',
)

const PRODUCT = process.env.MB_UV_PRODUCT || DEFAULT_PRODUCT
const SHOT = process.env.MB_UV_SHOT || path.join(HERE, 'screenshots', 'uv-fix', 'shot.png')
const YAW = Number(process.env.MB_UV_YAW ?? '180')
const LABEL = process.env.MB_UV_LABEL || path.basename(PRODUCT)

test.describe('纹理朝向目视对照', () => {
  test(`${LABEL}：yaw=${YAW} 截图`, async ({ page }) => {
    test.setTimeout(180_000)
    const product = loadRealProduct(PRODUCT)

    await gotoWorkbench(page)
    const injected = await injectSceneDocumentOk(page, product.envelope, product.file)
    expect(injected.docLoaded, `${product.file}：必须能被 Multiblock 解析器加载`).toBe(true)
    expect(injected.isMultiblock, `${product.file}：必须判为「多方块为主」形态`).toBe(true)

    await openChannelTabReady(page)
    await waitForMeshIdle(page, TIER_SLIDER)

    // 等挂载期 mesh 世代稳定（两次连读一致即认为挂载重建已停下）
    let uuid = (await readContentMesh(page)).uuid
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(50)
      const cur = (await readContentMesh(page)).uuid
      if (cur !== null && cur === uuid) break
      uuid = cur
    }

    // 摆相机：`ctx.main.cameras` 是运行时公开的相机状态（viewOperators 也这样写）
    await page.evaluate(({ yawDeg }) => {
      const ctx = (window as any).__vm__
      const slot = ctx.viewports.get('r-viewport')
      const key = slot.cameraMainKey
      const ref = ctx.main.cameras[key]
      const cur = ref.value
      ref.value = { ...cur, yawDeg, elevationDeg: 12 }
    }, { yawDeg: YAW })

    await page.waitForTimeout(500)
    const canvas = page.locator(VIEWPORT_CANVAS)
    await expect(canvas).toBeVisible()
    const png = await canvas.screenshot({ path: SHOT })
    const stats = await readPixelStats(page, png)
    // 只断言「不是空画面」；朝向判据由数据级门禁承担
    expect(stats.uniqueColors, `${LABEL}：截图疑似空白 ${JSON.stringify(stats)}`).toBeGreaterThan(32)
    expect(stats.nonBlackRatio, `${LABEL}：截图疑似全黑 ${JSON.stringify(stats)}`).toBeGreaterThan(0.02)
    // 把产物身份与相机参数写进 testInfo，便于证据归档
    test.info().annotations.push({ type: 'product', description: PRODUCT })
    test.info().annotations.push({ type: 'camera', description: `yaw=${YAW} elevation=12` })
    test.info().annotations.push({ type: 'screenshot', description: SHOT })
    console.log(`[uv-shot] ${LABEL} yaw=${YAW} → ${SHOT} stats=${JSON.stringify(stats)}`)
  })
})
