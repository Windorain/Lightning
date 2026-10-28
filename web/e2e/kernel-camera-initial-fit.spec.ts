/**
 * **首次装载的初始机位必须是框选结果**（回归判据）
 *
 * ## 它钉住什么（实测的缺陷形态）
 *
 * `loadStatus='ok'` 现在 不再等纹理解码 ⇒ 视口在**首帧呈现 apply 之前**挂载
 * ⇒ `OPERATOR_INIT_VIEWPORT_CAMERA` 时内容组还没有几何 ⇒ `fitCameraToGroup` 返回
 * `{ok:false,'group has no geometry bounds'}` ⇒ 旧实现落**定义缺省兜底**
 * （`zoom=1` / `target=(0,2,0)`），且之后按 M7 的「内容投影不得重置用户机位」
 * 纪律**不会**再 fit。
 *
 * 后果：机器被画小约 2.3 倍（`builtin-multiblock-sample` 的像素判据实测
 * ratio 0.542→0.105、bbox 647×536→285×269），并且让 `kernel-dual-edit` / `kernel-undo-redo`
 * 这类**用真实鼠标做投影命中**的判据在下游以"悬停不中/撤销栈多一条"的形态红。
 *
 * ## 判据
 *
 * | 用例 | 断言 | 反假绿 |
 * |---|---|---|
 * | C1 内置样例 | `cameraInitState==='fitted'`；`zoom !== 定义缺省 1`；`pending` 已消费 | 缺省值 1 是**具体数字**（不是"非空"），落兜底当场红 |
 * | C2 打开工程（生产 operator） | 同上（第二路入口，证明不是 dev 样例专属） | 两条入口共用同一断言 |
 * | C3 负对照：先挪机位再改内容 | 机位**逐字段不变**；且 `cameraInitState` 不回到 `pending` | 若补偿逻辑写成"内容一到就 fit"，此条红 |
 *
 * ## 读面（生产只读面，不新增测试钩子）
 *
 * - `__vm__.viewports.cameraInitStateOf(rid)` —— `runtime/viewportCameraInit#CameraInitState`
 *   （`pending` / `fitted` / `fallback` / `user`）；
 * - `__vm__.main.cameras[rid].value` —— 逻辑机位（生产权威）。
 */

import { expect, test } from '@playwright/test'

import { gotoWorkbench, injectSceneDocumentOk } from './helpers/multiblock/harness'
import { fixturePath, readJson } from './helpers/saveReopen'

const RID = 'r-viewport'
const SAMPLE_SCENE_ID = 'builtin-multiblock-ebf'
/** `resolveInitialViewportCamera` 的缺省 zoom（落兜底的指纹）。 */
const FALLBACK_ZOOM = 1

interface CameraFacts {
  readonly zoom: number | null
  readonly target: { x: number; y: number; z: number } | null
  readonly state: string | null
  readonly pending: boolean
}

async function readCamera(page: import('@playwright/test').Page): Promise<CameraFacts> {
  return (await page.evaluate((rid: string) => {
    const vm = (window as any).__vm__
    const cam = vm?.main?.cameras?.[rid]?.value ?? null
    const vp = vm?.viewports ?? null
    return {
      zoom: cam ? Number(cam.zoom) : null,
      target: cam ? { x: cam.target.x, y: cam.target.y, z: cam.target.z } : null,
      state: vp?.cameraInitStateOf?.(rid) ?? null,
      pending: vp?.pendingOf?.(rid) ?? null,
    } as any
  }, RID)) as CameraFacts & { pending: unknown }
}

/** 一条入口共用：等待"首个 apply 已落地 → 补偿已完成"。 */
async function expectFittedInitialCamera(page: import('@playwright/test').Page, why: string): Promise<void> {
  await expect
    .poll(async () => (await readCamera(page)).state, { message: why + '：初始机位的施加结果必须可读', timeout: 30_000 })
    .toBe('fitted')
  const facts = await readCamera(page)
  expect(facts.zoom, why + '：**首次装载的 zoom 必须是框选结果**，落定义缺省 ' + FALLBACK_ZOOM + ' 即为回归').not.toBe(FALLBACK_ZOOM)
  expect(facts.zoom ?? 0, why + '：框选结果的 zoom 必须 > 0').toBeGreaterThan(0)
  expect((facts as any).pending, why + '：待做的补偿必须已被消费（不得残留）').toBeNull()
}

test.describe('首次装载的初始机位 = fit 结果', () => {
  test('内置样例（真实入口）：cameraInitState=fitted 且 zoom 不是定义缺省', async ({ page }) => {
    test.setTimeout(180_000)
    await gotoWorkbench(page)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const drawer = page.locator('.drawer-panel')
    await drawer.waitFor({ state: 'visible', timeout: 20_000 })
    await drawer.getByRole('button', { name: '内置示例', exact: true }).click()
    await drawer.locator('select').selectOption(SAMPLE_SCENE_ID)
    await drawer.getByRole('button', { name: '加载到工作台' }).click()
    await page.waitForFunction(() => (window as any).__vm__?.hasLoadedDocument?.() === true, undefined, { timeout: 90_000 })
    await expectFittedInitialCamera(page, 'C1 内置样例')
    const facts = await readCamera(page)
    console.log('[初始机位] C1 sample = ' + JSON.stringify(facts))
  })

  test('打开工程（生产 OPERATOR_OPEN_SCENE）：同一条断言', async ({ page }) => {
    test.setTimeout(180_000)
    await gotoWorkbench(page)
    await injectSceneDocumentOk(page, readJson(fixturePath()), 'structuredata-exported-envelope.json')
    await expectFittedInitialCamera(page, 'C2 打开工程')
    const facts = await readCamera(page)
    console.log('[初始机位] C2 open = ' + JSON.stringify(facts))
  })

  test('负对照：先挪机位再改内容 ⇒ 机位逐字段不变（补偿不得抢用户机位）', async ({ page }) => {
    test.setTimeout(180_000)
    await gotoWorkbench(page)
    await injectSceneDocumentOk(page, readJson(fixturePath()), 'structuredata-exported-envelope.json')
    await expectFittedInitialCamera(page, 'C3 前置')

    // 用户动相机（生产写面：Main.cameras[rid]，与拖拽/滚轮同一条状态）
    const moved = { target: { x: 2, y: 1, z: 3 }, yawDeg: 12.5, elevationDeg: 22.25, distance: 7, zoom: 1.37 }
    await page.evaluate(({ rid, s }: any) => {
      const vm = (window as any).__vm__
      vm.main.ensureCamera(rid).value = s
    }, { rid: RID, s: moved })
    await page.waitForTimeout(900)
    const before = await readCamera(page)

    // 内容真的变一次（生产写入口：逐格说明）
    await page.evaluate(() => {
      const vm = (window as any).__vm__
      const p = vm.plainForSave().plain
      const grid = vm.kernelGrid(0)
      let hit: any = null
      for (let z = 0; z < grid.depth && hit === null; z++) {
        for (let y = 0; y < grid.height && hit === null; y++) {
          for (let x = 0; x < grid.width && hit === null; x++) {
            if (typeof grid.tooltipAt({ x, y, z }) === 'string') hit = { x, y, z }
          }
        }
      }
      if (hit === null) hit = { x: 0, y: 0, z: 0 }
      const entry = p.blockPalette[Number(p.cellGrid[hit.z]?.[p.cellGrid[hit.z].length - 1 - hit.y]?.[hit.x] ?? 0)]
      vm.getSelection().select({ pos: hit, block_state_id: String(entry?.registryId ?? '') })
    })
    await page.waitForTimeout(600)
    const field = page.locator('[data-property="lightning.block.tooltip"] input')
    await field.click()
    await field.fill('内容变化（e2e）')
    await page.keyboard.press('Tab')
    await page.waitForTimeout(1500)

    const after = await readCamera(page)
    expect(after.target, 'C3：内容变化后机位目标必须逐字段不变（内容投影不得重置用户机位）').toEqual(before.target)
    expect(after.zoom, 'C3：内容变化后 zoom 必须不变').toBe(before.zoom)
    expect(after.state, 'C3：一次内容变化不得把初始机位读面打回 pending').not.toBe('pending')
    console.log('[初始机位] C3 before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after))
  })
})
