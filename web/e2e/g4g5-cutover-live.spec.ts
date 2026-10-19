/**
 * R1-β① G4+G5 · **切源后「画面与拾取仍产出」的真实入口判据（L2 smoke）**。
 *
 * ## 这份 spec 补的是哪条诚实边界
 *
 * Gitea `Lightning/lightning` #387 的评论 7706 / 7707 如实登记：本轴**未跑真实入口 e2e**
 * ⇒ 当时**不得声称**「切源后画面与拾取仍产出」。本文件把那句话变成**机器判据**：
 * 用**生产入口**打开场景，断言 ① 视口真的产出批次 / 图元（不是空场景）与 ② 拾取真的命中一个对象，
 * 并附**负对照**（同一对读面在未打开场景时判红 —— 证两条正判据不是恒真）。
 *
 * ## 与前几处判据的分工（**不重复造观测通道**）
 *
 * | 判据面 | 覆盖到了什么 |
 * |---|---|
 * | `runtime/__tests__/g4DrwKernelRenderSource.test.ts` | DRW 吃内核面且以 `docRef = null` 证**自足** —— 生产装配，但**不是真实入口** |
 * | `e2e/c8-picture-takeover.spec.ts`（非 smoke） | 同一条主张 + 画面归属负对照，但**不在 L2 门内** |
 * | `e2e/p10e-presenter-live.spec.ts` 的 @smoke 用例 | 逐格拾取（真实入口），**未**断言"视口产出批次 / 图元" |
 * | **本文件**（@smoke） | 把上述两半**合并进 L2 门**：真入口 ⇒ 画面产出批次 **且** 拾取命中 |
 *
 * 读面**全部复用既有观测通道**：`e2e/helpers/c8/probe.ts#readPictureCensus`（画面归属 / 网格计数）
 * 与 `e2e/helpers/p10e/probe.ts#pickCellsAcrossViewport`（逐格拾取）。
 *
 * ## 不覆盖（如实，勿读成"全覆盖"）
 *
 * - **`docRef = null` 的"内核面自足"形态无法在真实入口复现**：生产恒注入 `renderSourceRef`，
 *   且 `docRef` 由 `useKernelChannels().renderDoc` 提供 ⇒ 那一半仍由上面的单元判据承担。
 * - 贴图 / 材质混合推断、方块图标缓存身份键、`contentRefreshTick` 消费点均不在本文件范围。
 */

import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  gotoWorkbench,
  injectSceneDocumentOk,
  readFixture,
  waitForViewportMounted,
  VIEWPORT_REGION,
} from './helpers/multiblock'

/** 与 `e2e/helpers/c8/probe.ts#PictureCensus` 同形（读面字段逐字对齐，不另立形状）。 */
interface PictureCensus {
  readonly hasSlot: boolean
  readonly hasSurface: boolean
  readonly contentGroupIsPresenterRoot: boolean
  readonly presenterRootInScene: boolean
  readonly presenterMeshes: number
  readonly triangleMapInContentGroup: number
  readonly triangleMapInScene: number
  readonly meshesInScene: number
}

/** 与 `e2e/helpers/p10e/probe.ts#PickScanResult` 同形。 */
interface PickScanResult {
  readonly hits: number
  readonly stale: number
  readonly cells: readonly string[]
  readonly sample: readonly {
    readonly objectId: string
    readonly cell: string
    readonly quadIndex: number
  }[]
  readonly note: string
}

/**
 * 浏览器侧探针必须**经 vite 转译**再 import：`page.evaluate(fn)` 把函数序列化后裸执行，
 * 裸说明符 `three` 没有 import map 可解析（`p10e-presenter-live.spec.ts` 文件头记过这条实测）。
 * 这里的写法与 c8 / p10e 两处**同法**，不引入第二套加载机制。
 */
async function readCensus(page: Page, regionId: string): Promise<PictureCensus> {
  return (await page.evaluate(
    async (rid) => {
      const mod = (await import('/e2e/helpers/c8/probe.ts')) as unknown as Record<
        string,
        (r: string) => unknown
      >
      return mod.readPictureCensus!(rid)
    },
    regionId,
  )) as PictureCensus
}

async function pickCells(page: Page): Promise<PickScanResult> {
  return (await page.evaluate(async () => {
    const mod = (await import('/e2e/helpers/p10e/probe.ts')) as unknown as Record<
      string,
      () => unknown
    >
    return mod.pickCellsAcrossViewport!()
  })) as PickScanResult
}

test.describe('R1-β① G4+G5 · 切源后真实入口：画面与拾取仍产出（#387 诚实边界）', () => {
  test(
    '真入口打开场景 ⇒ 视口产出批次 / 图元 且 拾取命中一个对象',
    { tag: '@smoke' },
    async ({ page }) => {
      const file = 'multiblock-tier-only.json'
      // 生产入口：完整 WorkbenchRoot → 生产 OPERATOR_OPEN_SCENE → 生产解析 / 装配 → 视口装配
      await gotoWorkbench(page)
      const fx = readFixture(file)
      await injectSceneDocumentOk(page, fx.envelope, file)
      await waitForViewportMounted(page)
      // 帧循环几拍，让内核文档 → 呈现会话的 apply 生效
      await page.waitForTimeout(1500)

      // ── ① 画面真的产出批次 / 图元（复用 c8 的画面归属读面）──
      const census = await readCensus(page, VIEWPORT_REGION)
      console.log('[G4G5·真入口] census = ' + JSON.stringify(census))
      expect(census.hasSlot, '工作台视口槽必须存在').toBe(true)
      expect(census.hasSurface, '视口必须装配呈现会话（否则画面没有生产者）').toBe(true)
      expect(census.contentGroupIsPresenterRoot, '结构层必须就是呈现根').toBe(true)
      expect(census.presenterMeshes, '视口必须真的产出批次网格（图元），不是空场景').toBeGreaterThan(0)
      expect(census.meshesInScene, '反空洞：主场景里确实有网格').toBeGreaterThan(0)

      // ── ② 拾取真的命中一个对象（复用 p10e 的逐格拾取读面）──
      const picked = await pickCells(page)
      const unique = new Set(picked.cells)
      console.log(
        '[G4G5·真入口] pick = '
          + JSON.stringify({
            note: picked.note,
            hits: picked.hits,
            stale: picked.stale,
            uniqueCells: unique.size,
            sample: picked.sample.slice(0, 3),
          }),
      )
      expect(picked.note, '拾取探针必须取到呈现会话与相机').toBe('ok')
      expect(picked.hits, '扫视口必须命中（否则"拾取仍产出"没有证据）').toBeGreaterThan(0)
      expect(picked.stale, '正常路径不得出现过期拾取').toBe(0)
      for (const s of picked.sample.slice(0, 3)) {
        expect(s.objectId, '拾取必须带对象身份（格身份不取代对象身份）').toBeTruthy()
        expect(Number.isInteger(s.quadIndex), '面序号必须是整数').toBe(true)
      }
    },
  )

  test(
    '**负对照**：未打开场景时同一对读面必须判红（证上面两条不是恒真）',
    { tag: '@smoke' },
    async ({ page }) => {
      // 同一个生产入口，但**不**注入任何场景文档 ⇒ 读面必须如实答"没有东西"
      await gotoWorkbench(page)
      await page.waitForTimeout(500)

      const census = await readCensus(page, VIEWPORT_REGION)
      const picked = await pickCells(page)
      console.log(
        '[G4G5·负对照] census = '
          + JSON.stringify(census)
          + ' pick = '
          + JSON.stringify({ note: picked.note, hits: picked.hits }),
      )

      expect(
        census.presenterMeshes,
        '未打开场景 ⇒ 呈现根不得挂批次网格（若仍 > 0，正判据①读的是常量）',
      ).toBe(0)
      expect(
        picked.note,
        '未打开场景 ⇒ 拾取探针必须如实答"取不到会话 / 相机"（若仍 ok，正判据②读的是常量）',
      ).not.toBe('ok')
      expect(picked.hits, '未打开场景 ⇒ 不得有命中').toBe(0)
    },
  )
})
