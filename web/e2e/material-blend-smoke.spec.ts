/**
 * **守门（L2 @smoke）：缺 `blend` 的「冻结」材质条目 ⇒ 视口仍必须挂出来。**
 *
 * ## 它守的真入口失效形态（实测）
 *
 * `parts-singlebox-mix.v2.json` 的材质调色板是 `[{ textureBlobIndex: 0 }]`（**无** `blend`），
 * 而内核材质面（`composition/kernelPresentationInputs#materialPaletteOf`，D3c `1529fd81` 起）
 * **冻结**条目。旧 `hydrateMaterialBlendsInSceneDocument` 原地写 `entry.blend` ⇒ 真入口抛
 * `TypeError: Cannot add property blend, object is not extensible`
 * → `[drw] loadStructureAndResources: failed to build textureCache` → **视口 60s 挂不出来**。
 *（实证回归由 G4 接线 `c66975a4` 引入：DRW 的首选材质输入从旧格式 plain 换成内核面，
 * 于是"下游会原地写冻结条目"这个潜伏缺陷第一次被真入口踩到。）
 *
 * ## 为什么是这一条（而不是把画面接管用例提进 smoke）
 *
 * 实测数据：`picture-takeover` 单独跑 **4 passed / 14.5s**，但放进 smoke（2 workers、19 用例并发）
 * 后 **2 failed / 2 skipped**（`page.evaluate: Cannot read properties of undefined (reading 'camera')`、
 * `locator.screenshot: Element is not attached to the DOM`）—— 它走 wiki 内嵌预览 + 逐点拾取，
 * 对并发负载敏感。**L2 是机器硬门（按超时判红）**，把时序敏感的用例塞进去等于给门加随机红。
 * ⇒ 本文件只做"**挂载 + 非空画面**"这件 P0 实际坏掉的事（轻、稳），
 * 深链（wiki 预览 + 拾取）仍由 `picture-takeover` 在定向/全量里把守。
 *
 * ## 判据（两半，都不可省）
 *
 * | # | 断言 | 只证它会漏掉什么 |
 * |---|---|---|
 * | ① | `waitForViewportMounted` 不超时（P0 时正是这里 60s 红） | 只证"文档注入了" —— 注入成功而材质库炸掉时，注入断言仍绿 |
 * | ② | canvas 可见 + 整页截图**非空**（像素实测） | 只证①的话，"挂了个空壳/黑屏"不会被发现 |
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  gotoWorkbench,
  injectSceneDocumentOk,
  readDockStatus,
  waitForViewportMounted,
} from './helpers/multiblock/harness'
import { readPartsFixture } from './helpers/parts/fixtures'
import { assertScreenshotNotBlank } from './helpers/multiblock/pixels'

const SHOT_DIR = path.join(import.meta.dirname, 'screenshots', 'material-blend')

test.describe('冻结材质条目的 blend 补全（真入口守门）', () => {
  test(
    'parts-singlebox-mix.v2.json（无 blend）⇒ 视口挂载成功且画面非空',
    { tag: '@smoke' },
    async ({ page }, testInfo) => {
      fs.mkdirSync(SHOT_DIR, { recursive: true })
      await gotoWorkbench(page)

      const fx = readPartsFixture('parts-singlebox-mix.v2.json')
      await injectSceneDocumentOk(page, fx, 'p0-material-blend.json')

      // ① P0 的失效点：材质库构建失败会让这里 60s 超时。
      await waitForViewportMounted(page)

      // ② 挂出来的必须**有画面**（不是空壳）。
      await expect(page.locator('.vc-viewport canvas').first(), '视口 canvas 必须可见').toBeVisible()
      const shot = path.join(SHOT_DIR, `parts-singlebox-mix-${testInfo.project.name}.png`)
      const stats = await assertScreenshotNotBlank(page, page, '部件夹具整页截图', shot)
      expect(stats, '像素实测必须返回读数（非空断言在 helper 内）').toBeTruthy()

      console.log(`[材质混合] dock=${await readDockStatus(page)} 像素实测 ${JSON.stringify(stats)}`)
    },
  )
})
