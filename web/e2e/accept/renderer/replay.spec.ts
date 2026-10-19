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
  console.log('[step] plan loaded', plan.cameras.length)
  const doc = JSON.parse(fs.readFileSync(docPath, 'utf8'))
  fs.mkdirSync(outDir, { recursive: true })

  console.log('[step] before viewport')
  await page.setViewportSize({ width: 1600, height: 1000 })
  console.log('[step] viewport set')
  console.log('[step] goto workbench')
  await gotoWorkbench(page)
  console.log('[step] workbench ready')
  console.log('[step] inject doc')
  const injected = await injectSceneDocumentOk(page, doc, path.basename(docPath))
  console.log('[step] injected', JSON.stringify(injected))
  await waitForViewportMounted(page)
  console.log('[step] viewport mounted')
  await page.waitForTimeout(1200)

  const localBox = (await page.evaluate(async () => {
    const mod = (await import('/e2e/accept/renderer/content-box.ts')) as { contentBoxLocal: () => unknown }
    return mod.contentBoxLocal()
  })) as { min: number[]; max: number[] } | null
  console.log('[step] localBox', JSON.stringify(localBox))

  const slotsInfo = await page.evaluate(() => {
    const ctx = (window as any).__vm__
    const slots = ctx?.viewports
    const ids = slots?.ids?.() ?? null
    return { ids, active: slots?.active?.value?.id ?? null, keys: slots ? Object.keys(slots) : null }
  })
  console.log('[step] viewports', JSON.stringify(slotsInfo))
  const renderStats = await page.evaluate(() => {
    const ctx = (window as any).__vm__
    const slots = ctx?.viewports
    const ids = ['r-viewport']
    const out: any = {}
    for (const id of ids) {
      const s = slots?.get?.(id)
      const root = s?.presenterSurface?.object3d
      if (!root) { out[id] = null; continue }
      let meshes = 0, verts = 0
      root.traverse((o: any) => { if (o?.isMesh) { meshes++; const g = o.geometry; verts += g?.attributes?.position?.count ?? 0 } })
      out[id] = { children: root.children.length, meshes, verts }
    }
    return out
  })
  console.log('[step] renderStats', JSON.stringify(renderStats))

  const camState = await page.evaluate(() => {
    const ctx = (window as any).__vm__
    return ctx?.main?.ensureCamera?.('r-viewport')?.value ?? null
  })
  console.log('[step] camState', JSON.stringify(camState))

  const metas: any[] = []
  for (const cam of plan.cameras) {
    console.log('[step] camera', cam.name)
    const canvases = await page.evaluate(() => Array.from(document.querySelectorAll('canvas')).map((c, i) => { const r = c.getBoundingClientRect(); return { i, w: r.width, h: r.height, x: r.x, y: r.y } }))
    const best = canvases.filter((c) => c.w > 100 && c.h > 100).sort((a, b) => b.w * b.h - a.w * a.h)[0]
    if (!best) throw new Error('没有可用的 canvas：' + JSON.stringify(canvases))
    const canvasLoc = page.locator('canvas').nth(best.i)
    const box = await canvasLoc.boundingBox()
    console.log('[step] viewport box', JSON.stringify(box))
    const camInfo = await page.evaluate(() => {
      const w = window as any
      const slot = w.__vm__?.viewports?.get?.('r-viewport')
      const describeCam = (c: any): any => {
        if (!c) return null
        const cam = c.isCamera ? c : (c.value?.isCamera ? c.value : null)
        if (!cam) return { notACamera: true, keys: Object.keys(c).slice(0, 12), ctor: c?.constructor?.name ?? null }
        return {
          type: cam.type, zoom: cam.zoom, near: cam.near, far: cam.far,
          left: cam.left, right: cam.right, top: cam.top, bottom: cam.bottom,
          pos: [cam.position.x, cam.position.y, cam.position.z],
          quat: [cam.quaternion.x, cam.quaternion.y, cam.quaternion.z, cam.quaternion.w],
        }
      }
      return {
        camera: describeCam(slot?.camera),
        cameraMainKey: slot?.cameraMainKey ?? null,
      }
    })
        console.log('[step] camInfo', JSON.stringify(camInfo))
    if (!box) throw new Error('找不到视口容器 .vc-viewport')

    // 只在「世界每像素」这一层对齐：zoom 由 canvas 高度反推，保证与游戏侧同 px/block
    const zoom = (10 * (cam.game.resolution[1] / cam.game.orthoHeight)) / box.height

    const target = localBox === null ? null : {
      x: (localBox.min[0] + localBox.max[0]) / 2,
      y: (localBox.min[1] + localBox.max[1]) / 2,
      z: (localBox.min[2] + localBox.max[2]) / 2,
    }
    if (target === null) throw new Error('localBox 为空：无法确定机位目标点')
    // 产品在装载后会做一次「初始取景」并**覆写**相机状态（实测：设置后读回被改成默认斜视）。
    // 故这里写成**有界重试 + 读回核验**：不假设写一次就生效，也不放宽判据。
    const want = { target, yawDeg: cam.web.yawDeg, elevationDeg: cam.web.elevationDeg, distance: cam.web.distance, zoom }
    const apply = (p: any) => page.evaluate((q: any) => {
      ;(window as any).__vm__.main.ensureCamera(q.viewportId).value = {
        target: q.target, yawDeg: q.yawDeg, elevationDeg: q.elevationDeg, distance: q.distance, zoom: q.zoom,
      }
    }, { ...p, viewportId: slotsInfo.active ?? 'r-viewport' })
    const read = () => page.evaluate(() => (window as any).__vm__.main.ensureCamera('r-viewport').value)
    const close = (a: any, b: any) =>
      a && b &&
      Math.abs(a.yawDeg - b.yawDeg) < 0.01 &&
      Math.abs(a.elevationDeg - b.elevationDeg) < 0.01 &&
      Math.abs(a.zoom - b.zoom) < 0.01 &&
      Math.abs(a.distance - b.distance) < 0.01
    let applied = false
    for (let attempt = 0; attempt < 10 && !applied; attempt++) {
      await apply(want)
      await page.waitForTimeout(150)
      applied = close(await read(), want)
    }
    if (!applied) throw new Error('相机写入被产品覆写：' + JSON.stringify(await read()))
    console.log('[step] camera applied', cam.name)
    await page.waitForTimeout(700)
    await canvasLoc.screenshot({ path: path.join(outDir, cam.name + '.png') })
    console.log('[step] shot written', cam.name)
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
  fs.writeFileSync(path.join(outDir, 'shot-meta.json'), JSON.stringify({ plan: plan.scene, orthoHeight: plan.orthoHeight, localBox, shots: metas }, null, 2) + '\n', 'utf8')
})
