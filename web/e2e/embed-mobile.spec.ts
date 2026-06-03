import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const PAGE = '/e2e-embed-mobile.html'
const SCREENSHOT_DIR = path.join(import.meta.dirname, 'screenshots')

async function waitEmbedReady(page: import('@playwright/test').Page) {
  await page.goto(PAGE)
  await expect(page.locator('.wm-root')).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('.vc-viewport canvas')).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('.nei-slot-row').first()).toBeVisible({ timeout: 120_000 })
}

test.describe('embed mobile adaptation', () => {
  test('mobile: fit host scales 800px box into wiki column', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chrome', 'mobile-only')

    await waitEmbedReady(page)

    const host = page.locator('.wsr-fit-host')
    await expect(host).toBeVisible()

    const hostBox = await host.boundingBox()
    const column = page.locator('#wiki-column')
    const colBox = await column.boundingBox()
    expect(hostBox).not.toBeNull()
    expect(colBox).not.toBeNull()

    expect(hostBox!.width).toBeLessThanOrEqual(colBox!.width + 2)
    expect(hostBox!.width).toBeLessThan(800)

    const mount = page.locator('.web-structure-renderer')
    const mountBox = await mount.boundingBox()
    expect(mountBox).not.toBeNull()
    expect(mountBox!.width).toBeLessThan(800)
    expect(mountBox!.width).toBeGreaterThan(200)

    const scale = await mount.getAttribute('data-wsr-fit-scale')
    expect(scale).not.toBeNull()
    expect(Number(scale)).toBeLessThan(1)
  })

  test('mobile: narrow layout collapses stats sidebar', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chrome', 'mobile-only')

    await waitEmbedReady(page)

    const root = page.locator('.wm-root')
    await expect(root).toHaveClass(/wsr-layout-(narrow|tiny)/)

    const sidebar = page.locator('.nei-sidebar')
    await expect(sidebar).toHaveClass(/nei-sidebar--collapsed/)

    const sidebarBox = await sidebar.boundingBox()
    expect(sidebarBox?.width ?? 999).toBeLessThanOrEqual(46)
  })

  test('mobile: visual acceptance screenshot', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chrome', 'mobile-only')

    await waitEmbedReady(page)
    await expect(page.locator('.wm-root')).toHaveClass(/wsr-layout-(narrow|tiny)/)

    const mount = page.locator('.web-structure-renderer')
    const canvas = page.locator('.vc-viewport canvas')
    const mountBox = await mount.boundingBox()
    const canvasBox = await canvas.boundingBox()
    expect(mountBox).not.toBeNull()
    expect(canvasBox).not.toBeNull()

    expect(canvasBox!.width).toBeGreaterThan(200)
    expect(canvasBox!.height).toBeGreaterThan(100)
    expect(canvasBox!.height / mountBox!.height).toBeGreaterThan(0.4)
    expect(canvasBox!.width / mountBox!.width).toBeGreaterThan(0.55)

    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'mobile-390-acceptance.png'),
      fullPage: false,
    })
  })

  test('mobile: touch pointer on canvas does not throw', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chrome', 'mobile-only')

    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await waitEmbedReady(page)
    const canvas = page.locator('.vc-viewport canvas')
    const box = await canvas.boundingBox()
    expect(box).not.toBeNull()

    await page.evaluate(
      ({ x, y }) => {
        const el = document.querySelector('.vc-viewport canvas') as HTMLCanvasElement | null
        if (!el) throw new Error('no canvas')
        const cx = x + 80
        const cy = y + 80
        for (const type of ['pointerdown', 'pointermove', 'pointerup'] as const) {
          el.dispatchEvent(
            new PointerEvent(type, {
              pointerId: 42,
              pointerType: 'touch',
              isPrimary: true,
              button: 0,
              buttons: type === 'pointerup' ? 0 : 1,
              clientX: cx + (type === 'pointermove' ? 20 : 0),
              clientY: cy + (type === 'pointermove' ? 10 : 0),
              bubbles: true,
              cancelable: true,
            }),
          )
        }
      },
      { x: box!.x, y: box!.y },
    )

    await page.waitForTimeout(150)
    expect(pageErrors.filter((m) => /embed:.*not available/i.test(m))).toEqual([])
  })

  test('mobile: canvas drag does not throw embed selection error', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chrome', 'mobile-only')

    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await waitEmbedReady(page)
    const canvas = page.locator('.vc-viewport canvas')
    const box = await canvas.boundingBox()
    expect(box).not.toBeNull()

    await canvas.dispatchEvent('pointerdown', {
      button: 0,
      clientX: box!.x + box!.width / 2,
      clientY: box!.y + box!.height / 2,
      pointerId: 1,
      bubbles: true,
    })
    await canvas.dispatchEvent('pointermove', {
      button: 0,
      clientX: box!.x + box!.width / 2 + 24,
      clientY: box!.y + box!.height / 2 + 12,
      pointerId: 1,
      bubbles: true,
    })
    await canvas.dispatchEvent('pointerup', {
      button: 0,
      clientX: box!.x + box!.width / 2 + 24,
      clientY: box!.y + box!.height / 2 + 12,
      pointerId: 1,
      bubbles: true,
    })

    await page.waitForTimeout(150)
    const bad = pageErrors.filter((m) => /embed:.*not available/i.test(m))
    expect(bad).toEqual([])
  })

  test('mobile: hides nonessential titlebar actions', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chrome', 'mobile-only')

    await waitEmbedReady(page)

    await expect(page.locator('.wm-root.wsr-layout-narrow, .wm-root.wsr-layout-tiny')).toBeVisible()
    await expect(page.locator('.wm-titlebar button[title="复位视角"]')).toBeHidden()
    await expect(page.locator('.wm-titlebar button[title="截屏"]')).toBeHidden()
    await expect(page.locator('.wm-titlebar button[title="全屏"]')).toBeVisible()
  })

  test('desktop: no scale, desktop layout', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', 'desktop-only')

    await page.goto(PAGE)
    await page.evaluate(() => {
      document.getElementById('wiki-column')?.style.setProperty('max-width', '900px')
    })
    await expect(page.locator('.wm-root')).toBeVisible({ timeout: 45_000 })
    await expect(page.locator('.vc-viewport canvas')).toBeVisible({ timeout: 45_000 })

    const scale = await page.locator('.web-structure-renderer').getAttribute('data-wsr-fit-scale')
    expect(scale).toBeNull()

    await expect(page.locator('.wm-root')).toHaveClass(/wsr-layout-desktop/)
  })
})
