/**
 * T2.6 · 多方块 fixture 加载断言（第一阶段骨架，**不依赖通道 UI**）。
 *
 * 覆盖计划 T2.6 自检项「加载 3 份多方块 fixture → 经公开观测点断言
 * `doc.isMultiblock`、通道声明条数（3/1/3）、运行态数（2/1/1）、变体数（432/12/108）
 * 与文件声明一致」。
 *
 * 反同义反复：期望值硬编码在 `helpers/multiblock/contract.ts`，
 * **不是**「再读一遍被测文件」。因此仓库 fixture 被篡改时这些断言必须变红
 * （证伪见 `multiblock-falsification.spec.ts`）。
 */

import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  MULTIBLOCK_CONTRACTS,
  contractFor,
  declarationViolations,
  backboneViolations,
  expectBackbone,
  expectDeclaration,
  gotoWorkbench,
  injectSceneDocumentOk,
  readDocObservation,
  readFixture,
  readRenderedGrid,
  assertScreenshotNotBlank,
  waitForRenderedGrid,
} from './helpers/multiblock'

const SHOT_DIR = path.join(import.meta.dirname, 'screenshots', 'multiblock')

/**
 * 计划 T2.6 自检要求的三个数字（通道声明条数 / 运行态数 / 变体数）。
 * 这里再单列一张紧凑表，让报告读起来就是「3/1/3、2/1/1、432/12/108」。
 */
const REQUIRED_TRIPLE: Record<string, [channels: number, runstates: number, variants: number]> = {
  'multiblock-ebf-2ch.json': [3, 2, 432],
  'multiblock-tier-only.json': [1, 1, 12],
  'multiblock-lsc-overlap.json': [3, 1, 108],
}

test.describe('T2.6 · 多方块 fixture 加载（公开观测点 vs 文件声明）', () => {
  for (const c of MULTIBLOCK_CONTRACTS) {
    // #332 L2 smoke：只把最轻的一份 fixture 标记为关键路径（"工作台加载 + 文档打开"），
    // 另两份留在 full —— 三份的差别只是声明规模，加载链路同一条。
    const tags = c.file === 'multiblock-tier-only.json' ? ['@smoke'] : []
    test(`加载 ${c.file}：形态/通道/运行态/变体/骨架 与文件声明一致`, { tag: tags }, async ({ page }, testInfo) => {
      fs.mkdirSync(SHOT_DIR, { recursive: true })
      const slug = c.file.replace(/\.json$/, '')

      // ── 入口挂载（原则 1）：完整 WorkbenchRoot ──
      await gotoWorkbench(page)

      // ── IO 接管（原则 3）：注入 fixture 原件（信封形态，与真实产物同一读取路径）──
      const fx = readFixture(c.file)
      expect(fx.envelope.documentFormat, `${c.file} 应为 Envelope fixture`).toBe('Envelope')
      // 形态键在信封 meta（契约 §2.1）——文件侧自证
      expect(fx.envelope.meta.documentShape, `${c.file} 信封 meta 应声明形态枚举量`).toBe('multiblock')

      const injected = await injectSceneDocumentOk(page, fx.envelope, c.file)
      expect(injected.isMultiblock, `${c.file} 应被判别为多方块为主文档`).toBe(true)
      // M5-1（2026-10-18 用户裁决）：帧清单是**场景（变体配置集合）**，不是时间轴 ——
      // 故内核帧轴为 0（没有可播放帧），而声明里的场景数仍是"一变体一场景"。
      expect(injected.frameCount, `${c.file} 内核帧轴必须为 0（场景不参与播放）`).toBe(0)

      // ── 公开观测（原则 4）：RuntimeDocument 公开 getter ──
      const doc = await readDocObservation(page)
      // 声明没有丢：全部场景仍在声明里（空帧轴 ≠ 丢内容）。
      expect(doc.multiblockSceneCount, `${c.file} 声明的场景数（一变体一场景）`).toBe(c.frameCount)

      // 计划自检口径的三元组
      expect(
        [doc.channelCount, doc.runstateCount, doc.variantCount],
        `${c.file} 通道条数/运行态数/变体数应与文件声明一致`,
      ).toEqual(REQUIRED_TRIPLE[c.file])

      // 完整声明级契约（通道 key/enum/呈现名/kind、运行态 id/呈现名、规则数、总 Tier 域、调色板、无告警）
      expectDeclaration(doc, c)
      // 格级契约（骨架阶数、第 0 阶形状与逐格下标、decl 与 multiblockSource 原文一致）
      expectBackbone(doc, c)

      console.log(
        `[T2.6] ${c.file}: channels=${doc.channelCount} runstates=${doc.runstateCount} ` +
          `variants=${doc.variantCount} rules=${doc.ruleCount} frames=${doc.frameCount} ` +
          `tier=${JSON.stringify(doc.totalTierDomain)} backbone=${JSON.stringify(c.backbone)}`,
      )

      // ── 截图非空断言 + 证据链 ──
      const shot = path.join(SHOT_DIR, `${slug}-${testInfo.project.name}.png`)
      const stats = await assertScreenshotNotBlank(page, page, `${c.file} 整页截图`, shot)
      console.log(`[T2.6] ${c.file} 整页截图像素实测 ${JSON.stringify(stats)}`)

      // ── 视口装配网格：**诊断性观测，不作断言** ──
      // 多方块文档的网格由 T2.2/T2.5 装配产生，属第二阶段范围；
      // 这里只在它已经就绪时记录下来（也是第二阶段接线的就绪探针）。
      let assembled: string
      try {
        await waitForRenderedGrid(page, 8_000)
        const g = await readRenderedGrid(page)
        assembled = JSON.stringify({
          present: g.present, d: g.d, h: g.h, w: g.w, solidCells: g.solidCells, palette: g.palette.length,
        })
      } catch {
        assembled = '未就绪（T2.5 装配接线尚未落地）'
      }
      console.log(`[T2.6] ${c.file} 视口装配网格（诊断，不作断言）: ${assembled}`)
    })
  }

  test('形态互斥：帧为主文档（minimal-v2）不被判为多方块', async ({ page }) => {
    await gotoWorkbench(page)
    const frameDominant = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'minimal-v2.json'), 'utf8'),
    ) as Record<string, unknown>
    const injected = await injectSceneDocumentOk(page, frameDominant, 'minimal-v2.json')
    expect(injected.isMultiblock, '缺省（无 documentShape）即帧为主').toBe(false)

    const doc = await readDocObservation(page)
    expect(doc.isMultiblock).toBe(false)
    expect(doc.multiblockSourcePresent).toBe(false)
    expect(doc.channelCount).toBe(0)
    expect(doc.runstateCount).toBe(0)
    expect(doc.variantCount).toBe(0)
    expect(doc.multiblockSceneCount).toBe(0)
    expect(doc.frameCount).toBe(1)
    // 帧为主文档的帧自带 grid（与多方块帧「grid 由装配产生」形成对照）
    expect(doc.frameGrids[0]?.present).toBe(true)

    const stats = await assertScreenshotNotBlank(page, page, 'minimal-v2 整页截图', null)
    console.log(`[T2.6] minimal-v2 截图像素实测 ${JSON.stringify(stats)}`)
  })

  test('契约表自洽：REQUIRED_TRIPLE 与 MULTIBLOCK_CONTRACTS 同源', () => {
    for (const c of MULTIBLOCK_CONTRACTS) {
      expect(REQUIRED_TRIPLE[c.file]).toEqual([c.channelKeys.length, c.runstateIds.length, c.variantCount])
      expect(contractFor(c.file)).toBe(c)
      // 谓词对「空观测」必须报红（不是恒绿）
      const empty = {
        hasDoc: false, docId: null, documentShape: null, isMultiblock: false, frameCount: 0,
        frameGrids: [], channelCount: 0, channels: [], runstateCount: 0, runstates: [],
        variantCount: 0, ruleCount: 0, multiblockSceneCount: 0, totalTierDomain: null,
        backbone: null, blockPaletteSize: 0, warnings: [], backboneMatchesSource: null,
        declarationMatchesSource: null, kernelSourceRoot: null,
        multiblockSourcePresent: false,
      }
      expect(declarationViolations(empty, c).length).toBeGreaterThan(0)
      expect(backboneViolations(empty, c).length).toBeGreaterThan(0)
    }
  })
})
