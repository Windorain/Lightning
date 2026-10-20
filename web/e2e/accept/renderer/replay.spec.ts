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
  // 世界→局部 的平移必须来自**文档声明的网格**，不能来自"渲染出来的东西"：
  // 一旦某些方块没渲染出来，包围盒会缩水，映射随之漂移（实测过：只剩箱子时目标点偏到箱子上）。
  let sceneFrame: { min: number[]; size: number[] } | null = null
  {
    let innerDoc: any = doc
    try {
      if (doc && typeof doc.payload === 'string') {
        const zlib = await import('node:zlib')
        innerDoc = JSON.parse(zlib.gunzipSync(Buffer.from(doc.payload, 'base64')).toString('utf8'))
      }
    } catch { innerDoc = doc }
    // 网格来源优先级：导出件自带的 provenance.selection（权威，含 min/max/size）→ cellGrid + scanBounds。
    // 不用"渲染出来的内容"：那会随缺陷漂移（实测：1×1×1 的坏导出会让包围盒缩成一块）。
    const provSel = (doc as any)?.meta?.provenance?.selection ?? (innerDoc as any)?.frames?.[0]?.structure?.provenance?.selection ?? null
    const st = innerDoc?.frames?.[0]?.structure
    const g = st?.cellGrid as number[][][] | undefined
    if (provSel && Array.isArray(provSel.min) && Array.isArray(provSel.pos2)) {
      const size = [provSel.sizeX, provSel.sizeY, provSel.sizeZ]
      if (size.every((v: any) => Number.isFinite(v) && v > 0)) sceneFrame = { min: provSel.min, size }
    }
    if (sceneFrame === null && g && g.length && g[0]?.length && g[0][0]?.length) {
      const size = [g[0][0].length, g[0].length, g.length]
      const sb = st?.scanBounds ?? {};
      const min = [(sb as any).minX ?? 0, (sb as any).minY ?? (sb as any).maxY ?? 0, (sb as any).minZ ?? 0]
      sceneFrame = { min, size }
    }
  }
  console.log('[step] sceneFrame', JSON.stringify(sceneFrame))

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

  // 画布必须**恰好等于场景分辨率**（两侧同宽高是配对的前提；画布比窗口小，靠加窗口尺寸补齐）。
  // 宽度 = 窗口 − 侧栏，高度 = 窗口 − 顶栏，故用实测边距迭代几次即可；对不上就报错，不缩图。
  const [TARGET_W, TARGET_H] = plan.resolution as [number, number]
  const largestCanvas = async () => {
    const boxes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('canvas')).map((c, i) => {
        const r = c.getBoundingClientRect()
        return { i, w: Math.round(r.width), h: Math.round(r.height) }
      }),
    )
    const best = boxes.filter((b) => b.w > 200 && b.h > 200).sort((a, b) => b.w * b.h - a.w * a.h)[0]
    if (!best) throw new Error('没有可用的 canvas：' + JSON.stringify(boxes))
    return best
  }
  let probe = await largestCanvas()
  for (let attempt = 0; attempt < 4; attempt++) {
    if (Math.abs(probe.w - TARGET_W) <= 2 && Math.abs(probe.h - TARGET_H) <= 2) break
    const vp = page.viewportSize()!
    await page.setViewportSize({ width: Math.round(TARGET_W + vp.width - probe.w), height: Math.round(TARGET_H + vp.height - probe.h) })
    await page.waitForTimeout(700)
    probe = await largestCanvas()
  }
  console.log('[step] canvas aligned', JSON.stringify({ canvas: probe, target: [TARGET_W, TARGET_H] }))
  if (Math.abs(probe.w - TARGET_W) > 2 || Math.abs(probe.h - TARGET_H) > 2) {
    throw new Error('画布 ' + probe.w + '×' + probe.h + ' 与场景分辨率 ' + TARGET_W + '×' + TARGET_H + ' 对不齐（两侧必须同宽高）')
  }
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

  // 真实交互诊断（不写相机）：用鼠标拖拽把视口转到目标 yaw/elevation，截图后仍读回状态自证。
  if (process.env.ACCEPT_DRAG === '1') {
    const targetYaw = Number(process.env.ACCEPT_DRAG_YAW ?? '180')
    const targetElev = Number(process.env.ACCEPT_DRAG_ELEV ?? '0')
    const read = () => page.evaluate(() => (window as any).__vm__?.main?.ensureCamera?.('r-viewport')?.value ?? null)
    const boxDrag = (await page.locator('canvas').first().boundingBox())!
    const cx = boxDrag.x + boxDrag.width / 2
    const cy = boxDrag.y + boxDrag.height / 2
    // 先标定灵敏度：拖 120 px 读回 yaw 变化
    const before = await read()
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 120, cy, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    const after = await read()
    const degPerPx = ((after?.yawDeg ?? 0) - (before?.yawDeg ?? 0)) / 120
    console.log('[drag] sensitivity', degPerPx, 'before', before?.yawDeg, 'after', after?.yawDeg)
    const wrap = (d: number) => ((d % 360) + 540) % 360 - 180
    for (let i = 0; i < 8; i++) {
      const cur = await read()
      const dyaw = wrap(targetYaw - (cur?.yawDeg ?? 0))
      const delev = targetElev - (cur?.elevationDeg ?? 0)
      if (Math.abs(dyaw) < 1 && Math.abs(delev) < 1) break
      const dx = degPerPx === 0 ? 0 : -dyaw / degPerPx
      const dy = -delev / (degPerPx || 0.3) * 0.35
      await page.mouse.move(cx, cy)
      await page.mouse.down()
      await page.mouse.move(cx + dx, cy + dy, { steps: 16 })
      await page.mouse.up()
      await page.waitForTimeout(250)
    }
    const finalState = await read()
    console.log('[drag] final', JSON.stringify(finalState))
    await page.waitForTimeout(600)
    fs.mkdirSync(outDir, { recursive: true })
    await page.locator('canvas').first().screenshot({ path: path.join(outDir, 'drag-view.png') })
    console.log('[drag] shot written drag-view.png')
  }
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
    if (process.env.ACCEPT_DIAG === '1') {
      const dirStats = await page.evaluate(() => {
        const slot = (window as any).__vm__?.viewports?.get?.('r-viewport')
        const root = slot?.presenterSurface?.root ?? slot?.presenterSurface?.object3d
        const out: any = { meshes: 0, byDir: {}, sides: {} as any }
        const bucket = (n: number[]) => {
          const a = n.map(Math.abs); const i = a.indexOf(Math.max(...a))
          return ['x', 'y', 'z'][i] + (n[i] < 0 ? '-' : '+')
        }
        root?.traverse?.((o: any) => {
          if (!o?.isMesh) return
          out.meshes++
          const side = o.material?.side ?? null
          out.sides[String(side)] = (out.sides[String(side)] ?? 0) + 1
          const pos = o.geometry?.attributes?.position
          if (!pos) return
          for (let i = 0; i + 2 < pos.count; i += 3) {
            const p0 = [pos.getX(i), pos.getY(i), pos.getZ(i)]
            const p1 = [pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1)]
            const p2 = [pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2)]
            const u = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]
            const v = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]]
            const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
            const k = bucket(n)
            out.byDir[k] = (out.byDir[k] ?? 0) + 1
          }
        })
        return out
      })
      console.log('[diag] triangles by facing', JSON.stringify(dirStats))
      const camFwd = await page.evaluate(() => {
        const slot = (window as any).__vm__?.viewports?.get?.('r-viewport')
        const c = slot?.camera?.isCamera ? slot.camera : slot?.camera?.value
        if (!c) return null
        const q = c.quaternion
        const rot = (v: number[]) => {
          const [x, y, z] = v
          const ix = q.w * x + q.y * z - q.z * y
          const iy = q.w * y + q.z * x - q.x * z
          const iz = q.w * z + q.x * y - q.y * x
          const iw = -q.x * x - q.y * y - q.z * z
          return [
            ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
            iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
            iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
          ]
        }
        const f = rot([0, 0, -1])
        return { pos: [c.position.x, c.position.y, c.position.z], forward: f.map((v: number) => +v.toFixed(3)), near: c.near, far: c.far, zoom: c.zoom }
      })
      console.log('[diag] camFwd', JSON.stringify(camFwd), 'cam=' + cam.name)
    }
    if (!box) throw new Error('找不到视口容器 .vc-viewport')

    // 只在「世界每像素」这一层对齐：zoom 由 canvas 高度反推，保证与游戏侧同 px/block
    const zoom = (10 * (cam.game.resolution[1] / cam.game.orthoHeight)) / box.height

    // 目标点 = **内容中心在局部坐标里的位置**：两侧必须瞄同一个世界点。
    //   局部内容中心 = 世界内容中心（plan.bounds.center） − 声明网格中心（sceneFrame）
    // 扫描区常比内容大（留白格）；若直接瞄局部原点，取景整体偏移（实测：平移 (1,0,2) 格后 stone 判红）。
    // 也禁止用"渲染出来的包围盒"当目标：少渲染几块时内容中心会漂移（实测：只剩箱子时目标点偏到箱子上）。
    if (sceneFrame === null) throw new Error('导出件缺声明网格（cellGrid/scanBounds）：无法建立世界→局部映射')
    if (!plan.bounds || !Array.isArray(plan.bounds.center)) throw new Error('机位计划缺 bounds.center')
    const gridCenter = [0, 1, 2].map((i) => sceneFrame!.min[i] + sceneFrame!.size[i] / 2)
    const target = {
      x: plan.bounds.center[0] - gridCenter[0],
      y: plan.bounds.center[1] - gridCenter[1],
      z: plan.bounds.center[2] - gridCenter[2],
    }
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
    if (process.env.ACCEPT_DIAG === '1') {
      // 视锥剔除诊断：把每个网格的包围球/世界位置与相机视锥参数打出来。
      const info = await page.evaluate(() => {
        const slot = (window as any).__vm__?.viewports?.get?.('r-viewport')
        const root = slot?.presenterSurface?.root ?? slot?.presenterSurface?.object3d
        const cam = slot?.camera?.isCamera ? slot.camera : slot?.camera?.value
        const meshes: any[] = []
        root?.traverse?.((o: any) => {
          if (!o?.isMesh) return
          const g = o.geometry
          if (g && !g.boundingSphere) g.computeBoundingSphere?.()
          const bs = g?.boundingSphere
          const wp = new o.constructor.prototype.constructor === undefined ? null : null
          meshes.push({
            name: o.name || null,
            visible: o.visible,
            frustumCulled: o.frustumCulled,
            materialSide: o.material?.side ?? null,
            bs: bs ? { c: [bs.center.x, bs.center.y, bs.center.z], r: bs.radius } : null,
            pos: [o.position.x, o.position.y, o.position.z],
            matrixWorldPos: (() => {
              const e = o.matrixWorld?.elements
              return e ? [Math.round(e[12] * 1000) / 1000, Math.round(e[13] * 1000) / 1000, Math.round(e[14] * 1000) / 1000] : null
            })(),
          })
        })
        return {
          meshes,
          camera: cam ? { l: cam.left, r: cam.right, t: cam.top, b: cam.bottom, near: cam.near, far: cam.far, pos: [cam.position.x, cam.position.y, cam.position.z] } : null,
        }
      })
      console.log('[diag-cull]', JSON.stringify(info))
      const depth = await page.evaluate(() => {
        const slot = (window as any).__vm__?.viewports?.get?.('r-viewport')
        const root = slot?.presenterSurface?.root ?? slot?.presenterSurface?.object3d
        const cam = slot?.camera?.isCamera ? slot.camera : slot?.camera?.value
        if (!root || !cam) return null
        root.updateMatrixWorld?.(true)
        const THREE = (root.constructor as any)?.__three ?? null
        // 直接用 three 的 Box3 从 Object3D 求盒：不引入依赖，靠遍历累加 geometry.boundingBox
        let min = [Infinity, Infinity, Infinity]
        let max = [-Infinity, -Infinity, -Infinity]
        const v: any = { x: 0, y: 0, z: 0 }
        root.traverse?.((o: any) => {
          if (!o?.isMesh || !o.geometry) return
          o.geometry.computeBoundingBox?.()
          const bb = o.geometry.boundingBox
          if (!bb) return
          for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) {
            v.x = x; v.y = y; v.z = z
            const e = o.matrixWorld.elements
            const wx = e[0] * v.x + e[4] * v.y + e[8] * v.z + e[12]
            const wy = e[1] * v.x + e[5] * v.y + e[9] * v.z + e[13]
            const wz = e[2] * v.x + e[6] * v.y + e[10] * v.z + e[14]
            if (wx < min[0]) min[0] = wx; if (wx > max[0]) max[0] = wx
            if (wy < min[1]) min[1] = wy; if (wy > max[1]) max[1] = wy
            if (wz < min[2]) min[2] = wz; if (wz > max[2]) max[2] = wz
          }
        })
        return { worldBox: { min, max }, near: cam.near, far: cam.far, camPos: [cam.position.x, cam.position.y, cam.position.z] }
      })
      console.log('[diag-box]', JSON.stringify(depth))
    }
    if (process.env.ACCEPT_WIDENEAR === '1') {
      // 近/远平面诊断：产品把正交相机的 near/far 收成 target±1 的薄板，场景深度超出就被裁。
      const before = await page.evaluate(() => {
        const slot = (window as any).__vm__?.viewports?.get?.('r-viewport')
        const cam = slot?.camera?.isCamera ? slot.camera : slot?.camera?.value
        if (!cam) return null
        const b = { near: cam.near, far: cam.far }
        cam.near = 0.01
        cam.far = 200
        cam.updateProjectionMatrix?.()
        return b
      })
      console.log('[diag] near/far widened from', JSON.stringify(before))
      await page.waitForTimeout(800)
      const after = await page.evaluate(() => {
        const slot = (window as any).__vm__?.viewports?.get?.('r-viewport')
        const cam = slot?.camera?.isCamera ? slot.camera : slot?.camera?.value
        return cam ? { near: cam.near, far: cam.far } : null
      })
      console.log('[diag] near/far after 800ms', JSON.stringify(after))
      await page.waitForTimeout(400)
    }
    if (process.env.ACCEPT_NOCULL === '1') {
      const n = await page.evaluate(() => {
        const slot = (window as any).__vm__?.viewports?.get?.('r-viewport')
        const root = slot?.presenterSurface?.root ?? slot?.presenterSurface?.object3d
        let k = 0
        root?.traverse?.((o: any) => { if (o?.isMesh) { o.frustumCulled = false; k++ } })
        return k
      })
      console.log('[diag] frustumCulled=false applied to', n, 'meshes')
      await page.waitForTimeout(400)
    }
    if (process.env.ACCEPT_DOUBLE === '1') {
      const n = await page.evaluate(() => {
        const slot = (window as any).__vm__?.viewports?.get?.('r-viewport')
        const root = slot?.presenterSurface?.root ?? slot?.presenterSurface?.object3d
        let k = 0
        root?.traverse?.((o: any) => { if (o?.isMesh && o.material) { o.material.side = 2; o.material.needsUpdate = true; k++ } })
        return k
      })
      console.log('[diag] double-side applied to', n, 'meshes')
      await page.waitForTimeout(400)
    }
    await page.waitForTimeout(700)
    await canvasLoc.screenshot({ path: path.join(outDir, cam.name + '.png') })
    console.log('[step] shot written', cam.name)
    metas.push({
      name: cam.name,
      canvas: { width: box.width, height: box.height },
      zoom,
      target,
      web: { ...cam.web, zoom },
      pxPerBlock: box.height * zoom / 10,
      game: cam.game,
    })
    console.log('[accept-shot]', cam.name, JSON.stringify({ pxPerBlock: metas[metas.length - 1].pxPerBlock }))
  }
  fs.writeFileSync(path.join(outDir, 'shot-meta.json'), JSON.stringify({ plan: plan.scene, orthoHeight: plan.orthoHeight, localBox, sceneFrame, shots: metas }, null, 2) + '\n', 'utf8')
})
