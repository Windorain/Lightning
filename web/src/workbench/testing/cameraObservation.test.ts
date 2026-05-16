/**
 * Camera state observation test — 检测输入事件是否真实改变了相机状态。
 *
 * 通过 window.__vm__ 暴露的 bctx 读取相机参数，每步操作后打印快照。
 * 所有测试都有实际断言，排除恒真式。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestHarness, shutdown, type TestHarness } from './harness'

interface CameraSnapshot {
  px: number
  py: number
  pz: number
  zoom: number
}

async function snap(h: TestHarness): Promise<CameraSnapshot> {
  return h.page.evaluate(() => {
    const vm = (window as any).__vm__
    const c = vm.viewport.camera.value
    return {
      px: +c.position.x.toFixed(4),
      py: +c.position.y.toFixed(4),
      pz: +c.position.z.toFixed(4),
      zoom: +c.zoom.toFixed(4),
    }
  })
}

describe('camera event input', () => {
  let h: TestHarness

  beforeAll(async () => {
    h = await createTestHarness()
    await h.page.evaluate(() => (window as any).__vm__.scene.loadBuiltinScene())
    await h.page.waitForFunction(() => {
      const vm = (window as any).__vm__
      return vm?.viewport?.camera?.value != null
    }, { timeout: 15000 })
  }, 30000)
  afterAll(() => shutdown())

  it('initial state: zoom=1, camera set', async () => {
    const s = await snap(h)
    console.log('[init]', s)
    expect(s.zoom).toBe(1)
    expect(Number.isFinite(s.px)).toBe(true)
  })

  it('wheel via synthetic WheelEvent — zoom changes', async () => {
    const before = await snap(h)
    console.log('[wheel-synthetic-before]', before)

    // 走 page.evaluate 派发真实 WheelEvent
    await h.page.evaluate(() => {
      const vm = (window as any).__vm__
      const canvas = vm.viewport.domElement.value
      if (!canvas) throw new Error('no canvas')
      canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -120,
        clientX: 100,
        clientY: 100,
        bubbles: true,
        cancelable: true,
      }))
    })
    await h.page.waitForTimeout(200)

    const after = await snap(h)
    console.log('[wheel-synthetic-after]', after)

    // zoom 必须变化（deltaY < 0 → zoom in → zoom 增大）
    const changed = after.zoom !== before.zoom
    console.log('[wheel-synthetic-verdict]', { before: before.zoom, after: after.zoom, changed })
    expect(changed).toBe(true)
    expect(after.zoom).toBeGreaterThan(before.zoom)
  })

  it('wheel via Playwright mouse.wheel — zoom changes', async () => {
    const before = await snap(h)
    console.log('[wheel-playwright-before]', before)

    const canvas = await h.page.$('canvas')
    const box = await canvas!.boundingBox()
    const cx = box!.x + box!.width / 2
    const cy = box!.y + box!.height / 2
    await h.page.mouse.move(cx, cy)
    await h.page.mouse.wheel(0, -120)
    await h.page.waitForTimeout(200)

    const after = await snap(h)
    console.log('[wheel-playwright-after]', after)

    expect(after.zoom).not.toBe(before.zoom)
    expect(after.zoom).toBeGreaterThan(before.zoom)
  })

  it('LMB drag UP — camera Y should decrease (Blender convention)', async () => {
    const before = await snap(h)
    console.log('[drag-up-before]', before)

    const canvas = await h.page.$('canvas')
    const box = await canvas!.boundingBox()
    const cx = box!.x + box!.width / 2
    const cy = box!.y + box!.height / 2

    // 拖拽向上 150px
    await h.page.mouse.move(cx, cy)
    await h.page.mouse.down({ button: 'left' })
    for (let i = 1; i <= 15; i++) {
      await h.page.mouse.move(cx, cy - i * 10)
    }
    await h.page.mouse.up({ button: 'left' })

    await h.page.waitForTimeout(200)
    const after = await snap(h)
    console.log('[drag-up-after]', after)

    const yDelta = +(after.py - before.py).toFixed(4)
    console.log('[drag-up-verdict]', { beforeY: before.py, afterY: after.py, yDelta })

    // Blender 惯例：拖 UP → 相机 Y 减少（看到更多底面，摄像机抬头）
    expect(yDelta).toBeLessThan(0)
  })

  it('LMB drag DOWN — camera Y should increase (Blender convention)', async () => {
    const before = await snap(h)
    console.log('[drag-down-before]', before)

    const canvas = await h.page.$('canvas')
    const box = await canvas!.boundingBox()
    const cx = box!.x + box!.width / 2
    const cy = box!.y + box!.height / 2

    await h.page.mouse.move(cx, cy)
    await h.page.mouse.down({ button: 'left' })
    for (let i = 1; i <= 15; i++) {
      await h.page.mouse.move(cx, cy + i * 10)
    }
    await h.page.mouse.up({ button: 'left' })

    await h.page.waitForTimeout(200)
    const after = await snap(h)
    console.log('[drag-down-after]', after)

    const yDelta = +(after.py - before.py).toFixed(4)
    console.log('[drag-down-verdict]', { beforeY: before.py, afterY: after.py, yDelta })

    // Blender 惯例：拖 DOWN → 相机 Y 增加（看到更多顶面，摄像机低头）
    expect(yDelta).toBeGreaterThan(0)
  })
})
