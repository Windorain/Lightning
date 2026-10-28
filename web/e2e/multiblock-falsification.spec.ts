/**
 * 断言有效性证伪（**防止管线恒绿**）。
 *
 * 自检要求：「故意篡改 fixture 一个格子，管线变红 —— 证明断言有效而非恒绿」。
 *
 * 三条纪律：
 *  1. **仓库 fixture 原件一字不改**：篡改只发生在测试内存里的注入副本
 *     （`cloneInner` + `rewrap`），注入路径与原件完全相同（同信封、同 parser）。
 *  2. **红色必须来自断言，而不是解析失败**：每个用例先断言篡改副本仍能正常加载
 *     （`docLoaded === true`），再用 try/catch 验证**断言确实抛出**。
 *  3. **证伪必须“定向”**：格级篡改只能打红格级断言、声明级断言仍绿（反之亦然），
 *     以此排除「整个管线一起崩」这种伪证。
 *
 * 另含像素断言的自证伪（纯色 PNG 必须被拒），保证截图非空断言本身不是恒绿。
 */

import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  COLOR_BUCKETS,
  MULTIBLOCK_CONTRACTS,
  VIEWPORT_CANVAS,
  backboneViolations,
  blankViolations,
  buildFrameDominantMultiframeDocument,
  cloneInner,
  contractFor,
  declarationViolations,
  diffSignatureGrids,
  drivePanel,
  expectBackbone,
  expectDeclaration,
  gotoWorkbench,
  injectSceneDocumentOk,
  openChannelTabReady,
  paletteSignatures,
  readChannelPanel,
  readDocObservation,
  readFixture,
  readRenderedDefinition,
  readPixelStats,
  rewrap,
  signatureGrid,
  snapshotOrFallbackReference,
  waitForRenderedGrid,
  type PixelStats,
} from './helpers/multiblock'

/** 跑一个同步断言，返回捕获到的错误（未抛则返回 null）。 */
function captureFailure(fn: () => void): unknown {
  try {
    fn()
    return null
  } catch (e) {
    return e
  }
}

/** 违反项列表里是否提到了某个关键词。 */
function mentions(violations: string[], needle: string): boolean {
  return violations.some((v) => v.includes(needle))
}

test.describe('断言证伪：篡改注入副本 → 管线必须变红', () => {
  test('格级：篡改骨架一个格子 → 格级断言红、声明级断言仍绿', async ({ page }) => {
    const c = contractFor('multiblock-tier-only.json')
    const { envelope, inner } = readFixture(c.file)

    // ── 基线：未篡改原件 → 全绿（同一页面先建立对照）──
    await gotoWorkbench(page)
    await injectSceneDocumentOk(page, envelope, c.file)
    const clean = await readDocObservation(page)
    expectDeclaration(clean, c)
    expectBackbone(clean, c)

    // ── 篡改：骨架第 0 阶 cellGrid 的 (z=0, row=0, x=0) 由 1 改成 2（角色 2 已声明，仍能正常解析）──
    const tampered = cloneInner(inner)
    const mb = tampered.multiblock as Record<string, unknown>
    const backbone = mb.backbone as Record<string, unknown>
    const steps = backbone.sizeSteps as Array<Record<string, unknown>>
    const grid = steps[0]!.cellGrid as number[][][]
    const before = grid[0]![0]![0]
    grid[0]![0]![0] = before === 1 ? 2 : 1
    expect(grid[0]![0]![0], '篡改必须真的改动了一个格子').not.toBe(before)

    // 重新起一个干净页面再注入篡改副本（避免与基线混淆）
    await gotoWorkbench(page)
    const injected = await injectSceneDocumentOk(page, rewrap(envelope, tampered), 'tampered-cell.json')
    expect(injected.docLoaded, '篡改一格后仍应能正常解析（否则红色来自解析失败，不是断言）').toBe(true)
    expect(injected.isMultiblock).toBe(true)

    const doc = await readDocObservation(page)
    // 篡改确实沿公开观测点透出
    expect(doc.backbone!.steps[0]!.cellGrid[0]![0]![0]).toBe(grid[0]![0]![0])

    const bbViolations = backboneViolations(doc, c)
    expect(bbViolations.length, '格级断言必须报出违反项').toBeGreaterThan(0)
    expect(mentions(bbViolations, '逐格下标'), `违反项应指向被篡改的列：${bbViolations.join(' | ')}`).toBe(true)

    // ── 固化：预期的失败断言确实失败 ──
    const err = captureFailure(() => expectBackbone(doc, c))
    expect(err, '格级篡改后 expectBackbone 必须抛出（管线变红）').not.toBeNull()
    console.log(`[多方块] 格级篡改 → 断言红：${(err as Error).message.split('\n')[0]}`)

    // ── 定向性：声明级断言仍绿（证伪不是“整体崩”）──
    expect(declarationViolations(doc, c), '格级篡改不应影响声明级断言').toEqual([])
  })

  test('声明级：删掉通道声明 → 通道条数断言红、格级断言仍绿', async ({ page }) => {
    const c = contractFor('multiblock-tier-only.json')
    const { envelope, inner } = readFixture(c.file)

    const tampered = cloneInner(inner)
    ;(tampered.multiblock as Record<string, unknown>).channels = []

    await gotoWorkbench(page)
    const injected = await injectSceneDocumentOk(page, rewrap(envelope, tampered), 'tampered-channels.json')
    expect(injected.docLoaded, '删空 channels 后仍应能正常解析').toBe(true)

    const doc = await readDocObservation(page)
    expect(doc.channelCount).toBe(0)
    const violations = declarationViolations(doc, c)
    expect(mentions(violations, '通道声明条数'), `应报通道条数不符：${violations.join(' | ')}`).toBe(true)

    const err = captureFailure(() => expectDeclaration(doc, c))
    expect(err, '声明被篡改后 expectDeclaration 必须抛出').not.toBeNull()
    console.log(`[多方块] 声明级篡改（通道条数）→ 断言红：${(err as Error).message.split('\n')[0]}`)

    // 定向性：格级断言仍绿
    expect(backboneViolations(doc, c), '通道条数篡改不应影响格级断言').toEqual([])
  })

  test('声明级：改通道/运行态呈现名 → 呈现名断言红、条数断言仍绿', async ({ page }) => {
    const c = contractFor('multiblock-ebf-2ch.json')
    const { envelope, inner } = readFixture(c.file)

    const tampered = cloneInner(inner)
    const mb = tampered.multiblock as Record<string, unknown>
    const channels = mb.channels as Array<Record<string, unknown>>
    const runstates = mb.runstates as Array<Record<string, unknown>>
    channels[1]!.name = 'CoilX'
    runstates[1]!.name = 'RunningX'

    await gotoWorkbench(page)
    const injected = await injectSceneDocumentOk(page, rewrap(envelope, tampered), 'tampered-names.json')
    expect(injected.docLoaded, '改呈现名后仍应能正常解析').toBe(true)

    const doc = await readDocObservation(page)
    expect(doc.channelCount, '条数未被改动').toBe(c.channelKeys.length)
    expect(doc.runstateCount, '条数未被改动').toBe(c.runstateIds.length)

    const violations = declarationViolations(doc, c)
    expect(mentions(violations, '通道呈现名'), `应报通道呈现名不符：${violations.join(' | ')}`).toBe(true)
    expect(mentions(violations, '运行态呈现名'), `应报运行态呈现名不符：${violations.join(' | ')}`).toBe(true)

    const err = captureFailure(() => expectDeclaration(doc, c))
    expect(err, '呈现名被篡改后 expectDeclaration 必须抛出').not.toBeNull()
    console.log(`[多方块] 声明级篡改（呈现名）→ 断言红：${(err as Error).message.split('\n')[0]}`)

    expect(backboneViolations(doc, c), '呈现名篡改不应影响格级断言').toEqual([])
  })

  test('像素断言自证伪：纯色/全黑截图必须被拒，真实视口截图必须通过', async ({ page }) => {
    expect(COLOR_BUCKETS).toBe(32 * 32 * 32)

    await gotoWorkbench(page)
    // 用真正能渲染出几何的样例做「必须通过」的一侧（实测 uniqueColors 500+）
    await injectSceneDocumentOk(page, buildFrameDominantMultiframeDocument(), 'pixel-baseline.json')
    await waitForRenderedGrid(page)

    // 真实视口截图 → 非空断言必须通过
    const realPng = await page.locator(VIEWPORT_CANVAS).screenshot()
    const realStats = await readPixelStats(page, realPng)
    expect(blankViolations(realStats), `真实截图不应被判空：${JSON.stringify(realStats)}`).toEqual([])
    expect(captureFailure(() => assertNotBlankSync(realStats))).toBeNull()

    // 纯色（全黑/全白/单色）截图 → 必须被拒
    for (const color of ['#000000', '#ffffff', '#3a7bd5']) {
      const png = await makeSolidPng(page, color, 320, 240)
      const stats = await readPixelStats(page, png)
      const violations = blankViolations(stats)
      expect(violations.length, `纯色截图 ${color} 必须被判空（实测 ${JSON.stringify(stats)}）`).toBeGreaterThan(0)
      const err = captureFailure(() => assertNotBlankSync(stats))
      expect(err, `纯色截图 ${color} 上 expectNotBlank 必须抛出`).not.toBeNull()
      console.log(`[多方块] 纯色 ${color} 被拒：${violations.join(' | ')}`)
    }
  })

  test('契约表完整性：三份 fixture 都被证伪用例覆盖或明确说明', () => {
    const files = MULTIBLOCK_CONTRACTS.map((c) => c.file)
    expect(files).toContain('multiblock-tier-only.json')
    expect(files).toContain('multiblock-ebf-2ch.json')
    expect(files).toContain('multiblock-lsc-overlap.json')
  })
})

test.describe('逐格 diff 的证伪：篡改 indexTable → 对应组合必须变红', () => {
  /**
   * 目标（自检）：证明**遍历阶段新增的 cellGrid 级断言**不是恒绿。
   *
   * 篡改口径：把 EBF 规则 `coil.slot` 的 `indexTable`（`[2,2,3,4]`，索引 = `coil` 有效值）
   * 的第 1、2 项互换 → `coil=1` 与 `coil=2` 的方块身份互换。这是**内容差异**篡改：
   * 形状/尺寸/变体键/通道声明都不变，唯独逐格内容会错 —— 正是"格级断言"该抓的东西。
   *
   * 三条纪律（与格级/声明级证伪一致）：
   *  1. 仓库 fixture 原件一字不改（篡改只在内存副本上，用 `cloneInner` + `rewrap`）；
   *  2. 红色必须来自**断言**而不是加载失败（先断言篡改副本仍能正常加载）；
   *  3. 证伪必须**定向**：只在该组合变红、且差异格坐标可解释（`(x=1,row=1,z=1)` = `coil.slot`）。
   */
  test('篡改 coil.slot 的 indexTable（换两个下标）→ 该组合逐格 diff 变红，其余组合仍绿', async ({ page }) => {
    test.setTimeout(300_000)
    const file = 'multiblock-ebf-2ch.json'
    const ref = snapshotOrFallbackReference(file)
    const { envelope, inner } = readFixture(file)

    /**
     * 目标组合：`height=5`（骨架阶 4 → 3×5×3）、`coil=2`（命中被互换的表项，`coil.slot=(x=1,y=1,z=1)`）、
     * `glass=2`、`tt=1`、`idle`。
     *
     * ⚠️ 两个口径坑（都踩过，记在这里以免复现"证伪失败其实是目标选错"）：
     *  1. `coil.slot` 是 `(x=1,y=1,z=1)` 的 `setCell`，契约朝向 row 0 = 顶部 —— `height=1`（3×1×3）
     *     时 `row=1` **越界**，该规则被 `expandOp` 静默丢弃；
     *  2. `height=2` 时 `(x=1,y=1,z=1)` 又被同相位的运行态规则 `runstate.face.h2.idle`
     *     （`phase:"runstate"` 排在 `replace` 之后，后写者胜）覆盖成控制器方块，
     *     于是 `coil.slot` 的篡改被**遮蔽**。只有 `height=5` 的组合里该格由 `coil.slot` 独占。
     *  实测（蓝本装配，见报告）：`height:5|coil:2|glass:2|tt:1|idle` 上互换 `indexTable[2]/[3]`
     *  恰好产生 **1 格**差异 `(x=1,row=1,z=1)`：`gt.blockcasings5:4`(Kanthal) ↔ `gt.blockcasings5:5`(Nichrome)。
     */
    const targetKey = 'height:5|coil:2|glass:2|tt:1|runstate:idle'
    /** 对照组一：coil=0（indexTable[0] 未被动过）→ 篡改后仍应逐格一致。 */
    const controlKey = 'height:5|coil:0|glass:2|tt:1|runstate:idle'
    /** 对照组二：coil=1（indexTable[1] 与 [2] 的值**相同**，互换后仍同值）→ 必须仍一致。 */
    const controlKey2 = 'height:5|coil:1|glass:2|tt:1|runstate:idle'
    const target = ref.byVariant.get(targetKey)!
    const control = ref.byVariant.get(controlKey)!
    expect(target, `参考清单必须含 ${targetKey}`).toBeTruthy()

    /**
     * 驱动到某组合并返回"渲染签名网格 vs 参考"的逐格 diff。
     *
     * ⚠️ 这里**不能**用 `waitForRenderMatch`（它的语义是"等收敛到 0，否则耗满超时"）：
     * 证伪用例期望的恰恰是**非零** diff，用收敛等待会白等满 20 s（实测整个用例 23.5 s，
     * 其中基线只占 1.3 s）。改为"等渲染签名**稳定**（连续两次读数相同）"，通常 1～2 次探测即返回。
     */
    const diffAt = async (key: string) => {
      const reference = ref.byVariant.get(key)!
      let prev = ''
      let observed = { rendered: await readRenderedDefinition(page), sig: signatureGrid([], [], 'idMeta') }
      for (let i = 0; i < 120; i++) {
        observed = await readRenderedDefinition(page).then((rendered) => ({
          rendered,
          sig: signatureGrid(rendered.cellGrid, rendered.palette, 'idMeta'),
        }))
        const stamp = JSON.stringify(observed.sig.rows)
        if (stamp === prev) break // 连续两次读数一致 = 装配已落定
        prev = stamp
        await new Promise((r) => setTimeout(r, 25))
      }
      return {
        diff: diffSignatureGrids(observed.sig, reference.signature),
        shape: observed.rendered.shape,
        referenceShape: [reference.dims.d, reference.dims.h, reference.dims.w] as [number, number, number],
      }
    }

    /** 驱动面板到目标组合（DOM 事件注入）。 */
    const gotoCombo = async (height: number, coil: number) => {
      await drivePanel(page, { tier: 1, runstate: 'idle', values: { height, coil, glass: 2 } })
    }
    // ── 基线：未篡改原件 → 目标组合与对照组都必须 diff=0 ──
    await gotoWorkbench(page)
    await injectSceneDocumentOk(page, envelope, file)
    await openChannelTabReady(page)
    await gotoCombo(5, 2)
    const cleanTarget = await diffAt(targetKey)
    await gotoCombo(5, 0)
    const cleanControl = await diffAt(controlKey)
    expect(cleanTarget.diff.count, `基线：未篡改时 ${targetKey} 必须 diff=0`).toBe(0)
    expect(cleanControl.diff.count, `基线：未篡改时 ${controlKey} 必须 diff=0`).toBe(0)
    // 前置断言：目标组合的骨架阶必须**容得下** coil.slot 的落点 (x=1,y=1,z=1)
    expect(target.dims, '目标组合骨架阶尺寸必须容得下 row=1').toEqual({ w: 3, h: 5, d: 3 })

    // ── 篡改：互换 coil.slot 的 indexTable[2] 与 indexTable[3] ──
    // （EBF 的 `coil.slot.indexTable = [2,2,3,4]`：下标 1 与 2 值**相同**，互换不可观测 ——
    //  那正是"证伪本身也要被自检"的坑，故取 [2]↔[3] 这一对**内容不同**的相邻项。）
    const tampered = cloneInner(inner)
    const mb = tampered.multiblock as Record<string, unknown>
    const rules = mb.rules as Array<Record<string, unknown>>
    const coilRule = rules.find((r) => r.id === 'coil.slot')!
    expect(coilRule, 'EBF 必须有 coil.slot 规则').toBeTruthy()
    const table = coilRule.indexTable as number[]
    expect(table, 'coil.slot.indexTable 形状前提').toHaveLength(4)
    const before = table.slice()
    const i1 = 2
    const i2 = 3
    ;[table[i1], table[i2]] = [table[i2]!, table[i1]!]
    expect(table, '篡改必须真的互换了两个下标').not.toEqual(before)
    const palette = (tampered.blockPalette as unknown[]) ?? ref.palette
    const sigs = paletteSignatures(palette)
    // 前置断言：被互换的两个下标必须是**不同内容**（否则篡改不可观测，证伪是假的）
    expect(
      sigs[before[i1]!]!.idMeta,
      `被互换的两个调色板条目（${before[i1]} / ${before[i2]}）必须内容不同，否则篡改不可观测`,
    ).not.toBe(sigs[before[i2]!]!.idMeta)
    // 前置断言：其余表项在互换前后必须一致（保证"定向"）
    for (const i of [0, 1]) expect(table[i], `indexTable[${i}] 不得被动到`).toBe(before[i])

    // 重新起干净页面注入篡改副本（注入路径与原件完全相同：Envelope → Multiblock parser）
    await gotoWorkbench(page)
    const injected = await injectSceneDocumentOk(page, rewrap(envelope, tampered), 'tampered-indextable.json')
    expect(injected.docLoaded, '篡改 indexTable 后仍应能正常解析（否则红色来自解析失败）').toBe(true)
    expect(injected.isMultiblock).toBe(true)
    await openChannelTabReady(page)

    // ── 目标组合：必须变红 ──
    await gotoCombo(5, 2)
    const panel = await readChannelPanel(page)
    expect(panel.variantKey, '变体键不受 indexTable 篡改影响（键只由声明值派生）').toBe(targetKey)
    const bad = await diffAt(targetKey)
    expect(bad.diff.count, `${targetKey}：篡改后逐格 diff 必须 > 0（管线变红）`).toBeGreaterThan(0)
    expect(bad.shape, '篡改的是内容而不是形状：尺寸必须不变').toEqual(bad.referenceShape)

    // 差异必须落在 coil.slot 那格（x=1,row=1,z=1），且证据三元组可解释
    const atSlot = bad.diff.details.filter((d) => d.x === 1 && d.y === 1 && d.z === 1)
    expect(atSlot.length, `差异必须落在 coil.slot（x=1,row=1,z=1）。实测 ${JSON.stringify(bad.diff.details)}`).toBeGreaterThan(0)
    const detail = atSlot[0]!
    expect(detail.want, '参考侧该格 = 原 indexTable 对应的方块').toBe(sigs[before[i1]!]!.idMeta)
    expect(detail.got, '渲染侧该格 = 被篡改后 indexTable 对应的方块').toBe(sigs[before[i2]!]!.idMeta)
    console.log(
      `[多方块] 格级证伪（indexTable）：${targetKey} 差异 ${bad.diff.count} 格 —— ` +
        `(${detail.x},${detail.y},${detail.z}) 参考=${detail.want} 渲染=${detail.got}（互换了 indexTable[${i1}]/[${i2}]）`,
    )

    // ── 定向性一：对照组 coil=0（未动到被篡改的下标）仍必须 diff=0 ──
    await gotoCombo(5, 0)
    const stillOk = await diffAt(controlKey)
    expect(
      stillOk.diff.count,
      `${controlKey}：indexTable[0] 未被动过，逐格 diff 必须仍为 0（证伪是定向的，不是整体崩）`,
    ).toBe(0)
    // 对照组基线自洽：height=5 的骨架阶是 3×5×3
    expect(control.dims, '对照组参考尺寸').toEqual({ w: 3, h: 5, d: 3 })

    // ── 定向性二：coil=1（被互换的两项在互换前后**同值**）也必须 diff=0 ──
    await gotoCombo(5, 1)
    const stillOk2 = await diffAt(controlKey2)
    expect(
      stillOk2.diff.count,
      `${controlKey2}：indexTable[1]/[2] 同值，互换后该档位结果不变，逐格 diff 必须仍为 0`,
    ).toBe(0)
  })
})

/** 同步版非空断言（`expectNotBlank` 的等价包装，供 captureFailure 使用）。 */
function assertNotBlankSync(stats: PixelStats): void {
  const violations = blankViolations(stats)
  expect(violations, `截图疑似全黑/全空。实测 ${JSON.stringify(stats)}`).toEqual([])
}

/** 在页面内生成一张纯色 PNG，返回 Buffer。 */
async function makeSolidPng(page: Page, color: string, w: number, h: number): Promise<Buffer> {
  const b64 = await page.evaluate(
    ({ color, w, h }) => {
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const g = c.getContext('2d')!
      g.fillStyle = color
      g.fillRect(0, 0, w, h)
      return c.toDataURL('image/png').split(',')[1]!
    },
    { color, w, h },
  )
  return Buffer.from(b64, 'base64')
}

