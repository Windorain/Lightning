/**
 * 渲染侧唯一 replay spec（本目录下唯一的 .spec.ts）。
 *
 * 只做三件事：读机位计划 → 按计划渲染 → 落盘（图 + 元数据）。
 * **不做任何机位/缩放/裁切数学**：所有数字来自 runner/camera-plan.mjs 的产物。
 *
 * 环境变量：
 *   ACCEPT_PLAN  机位计划 JSON（{ resolution, orthoHeight, cameras:[{name, game, web}] }）
 *   ACCEPT_DOC   游戏导出的场景文件（原样，禁止修补）
 *   ACCEPT_OUT   产物目录（写 <name>.png + shot-meta.json）
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from '@playwright/test'
import { gotoWorkbench, injectSceneDocumentOk, waitForViewportMounted } from '../../helpers/multiblock'

test('accept: render plan cameras through the product viewport', async ({ page }) => {
  test.setTimeout(300_000)
  const planPath = process.env.ACCEPT_PLAN
  const docPath = process.env.ACCEPT_DOC
  const outDir = process.env.ACCEPT_OUT
  if (!planPath || !docPath || !outDir) throw new Error('ACCEPT_PLAN / ACCEPT_DOC / ACCEPT_OUT 必须设置')

  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))
  const doc = JSON.parse(fs.readFileSync(docPath, 'utf8'))
  fs.mkdirSync(outDir, { recursive: true })

  await page.setViewportSize({ width: 1600, height: 1000 })
  await gotoWorkbench(page)
  const injected = await injectSceneDocumentOk(page, doc, path.basename(docPath))
  await waitForViewportMounted(page)
  await page.waitForTimeout(1200)

  const metas: any[] = []
  for (const cam of plan.cameras) {
    const canvas = page.locator('.vc-viewport canvas').first()
    const box = await canvas.boundingBox()
    if (!box) throw new Error('找不到视口 canvas')

    // 只在「世界每像素」这一层对齐：zoom 由 canvas 高度反推，保证与游戏侧同 px/block
    const zoom = (10 * (cam.game.resolution[1] / cam.game.orthoHeight)) / box.height

    await page.evaluate((p: any) => {
      ;(window as any).__vm__.main.ensureCamera('r-viewport').value = p
    }, { ...cam.web, zoom })

    await page.waitForTimeout(700)
    await canvas.screenshot({ path: path.join(outDir, cam.name + '.png') })
    metas.push({
      name: cam.name,
      canvas: { width: box.width, height: box.height },
      zoom,
      web: { ...cam.web, zoom },
      pxPerBlock: box.height * zoom / 10,
      game: cam.game,
    })
    console.log('[accept-shot]', cam.name, JSON.stringify({ pxPerBlock: metas[metas.length - 1].pxPerBlock }))
  }
  fs.writeFileSync(path.join(outDir, 'shot-meta.json'), JSON.stringify({ plan: plan.scene, orthoHeight: plan.orthoHeight, shots: metas }, null, 2) + '\n', 'utf8')
})
