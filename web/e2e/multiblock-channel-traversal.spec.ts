/**
 * 逐格预演 + 像素诊断 —— **通道滑杆全组合遍历**。
 *
 * 判据框架：**cellGrid 级断言为通过判据**；像素断言只诊断记录、不作门禁
 * —— 合成 fixture 的几何在视口里不可见是**几何属性问题**（相机取景/遮挡裁剪），
 * 与"通道 → 装配 → 渲染定义"这条链路无关（mesh 顶点数随装配 72→180 已验证绑定正常）。
 * 真实像素门禁留给真实导出产物验收。
 *
 * 每个组合做三件事：
 *  1. **DOM 驱动**滑杆到目标声明值（含运行态 `change`）——真实 `<input type=range>` / `<select>`，
 *     事件由浏览器派发，与真人操作同路径（`setSliderValue`，见 harness 注释）；
 *  2. 等渲染定义**收敛**到该组合（`waitForRenderMatch`：面板属性同步、渲染定义异步，
 *     装配经 `revision++ → watch(flush:'post') → loadStructureAndResources → rebuildContentMesh`）；
 *  3. 断言：`data-mb-variant` = 期望变体键、`data-mb-dims` = 参考尺寸、
 *     `definition.cellGrid` 与参考展开网格**逐格一致（差异 0）**。
 *
 * 覆盖矩阵（时间治理：**性能控制 + 逐条论证的抽样**）：
 *  - `desktop-chrome`：**精简集**（`reducedTraversal(file)`，`552 → ≈69`）。删减不是"跑快点"，
 *    而是"门禁口径下内容互异类只有 43 个"这一事实的直接推论：552 条等式里 509 条与其
 *    类代表**逐格相同**，逐条配对账本由 `reducedTraversal.ts` 机械产出并在本文件自检。
 *    区分力由三类成员共同守住：**内容类代表**（不存在没断言过的期望内容）、
 *    **轴跃迁见证**（任一滑杆/Tier 轴失效必红）、**逐档覆盖**（每档真的走过 DOM 事件路径）。
 *    完整论证与实测数据见 `web/e2e/helpers/multiblock/reducedTraversal.ts` 文件头。
 *  - `mobile-chrome`：**抽样子集**（每 fixture：`全 0` / `各通道有效下界` / `各通道域上界` × tierSample × 运行态）
 *    —— 保留原有的跨视口抽样（与精简集口径不同：它证的是"窄视口下同一条链路同样成立"）。
 *
 * 连续装配优化：同文档内**渐进拖动**（只对与当前值不同的控件派发事件），每 fixture 只注入一次文档。
 * 截图策略：每个 Tier 档位的第一条组合截一张视口图（等级跨档 = 有意义的证据），
 * 不为数百个组合各存一张几乎完全相同的 PNG。
 */

import { expect, test, type Page, type TestInfo } from '@playwright/test'
import {
  captureEvidence,
  describeGridDiff,
  diffSignatureGrids,
  drivePanel,
  enumerateExpectedCombos,
  expectStablePixels,
  gotoWorkbench,
  injectSceneDocumentOk,
  openChannelTabReady,
  paletteSignatures,
  panelContractFor,
  pollUntil,
  readChannelPanel,
  readFixture,
  readRenderedDefinition,
  reducedTraversal,
  assertReducedTraversal,
  sampleCombos,
  setTier,
  signatureDiff,
  signatureGrid,
  snapshotOrFallbackReference,
  VIEWPORT_CANVAS,
  waitForRenderMatch,
  type ExpectedCombo,
  type FixtureReference,
  type GridDiff,
  type PanelDrivePayload,
  type SignatureGrid,
} from './helpers/multiblock'

const SHOT_DIR = 'e2e/screenshots/multiblock'

/** 单组合收敛超时：一次 mesh 重建在毫秒级，给足 20s 余量。 */
const SETTLE_TIMEOUT_MS = 20_000

const FIXTURES = ['multiblock-ebf-2ch.json', 'multiblock-tier-only.json', 'multiblock-lsc-overlap.json'] as const

interface ComboOutcome {
  combo: ExpectedCombo
  panelVariant: string
  panelDims: string
  /** 面板观测：该取值组合是否命中已声明变体。 */
  declaredVariant: boolean | null
  /** 渲染定义形状 `[d,h,w]`。 */
  renderedShape: [number, number, number]
  /** 参考尺寸 `[d,h,w]`。 */
  referenceShape: [number, number, number]
  /** `idMeta` 口径逐格 diff（**门禁**）。 */
  diff: GridDiff
  /** `full` 口径逐格 diff（非门禁的更强证据）。 */
  diffFull: GridDiff
  renderedPaletteSize: number
  /** 渲染调色板里无法从参考并集调色板派生的条目（应为空）。 */
  paletteUnknown: string[]
  settleMs: number
  probes: number
}

/** 面板 `data-mb-dims` 的格式（`formatDims`）：`w×h×d`。 */
function dimsText(d: { w: number; h: number; d: number }): string {
  return `${d.w}×${d.h}×${d.d}`
}

/** 只统计差异条数（轮询里的廉价探针，不建 details）。 */
function diffCountAgainst(got: SignatureGrid, want: SignatureGrid): number {
  if (got.d !== want.d || got.h !== want.h || got.w !== want.w) return Number.MAX_SAFE_INTEGER
  let n = 0
  for (let z = 0; z < want.d; z++) {
    for (let y = 0; y < want.h; y++) {
      for (let x = 0; x < want.w; x++) {
        if (got.rows[z]?.[y]?.[x] !== want.rows[z]?.[y]?.[x]) n++
      }
    }
  }
  return n
}

/**
 * 渲染调色板里、"无法从参考并集调色板的 `name:meta` 集合派生"的条目（空 = 渲染只用了
 * fixture 声明过的**方块身份**）。
 *
 * 口径说明（实测证据，见 README §7 新增条目）：
 *  渲染侧调色板条目经 `Grid`（`SlotBlock = {name, meta}`）**按 `name:meta` 归并**，
 *  归并后具体挑到哪一条的 tooltip/nbt 是不确定的（EBF 的 `gt.blockmachines@1000`
 *  在并集里有 7/8 两条，实测渲染拿到的是第 8 条「(running)」的 tooltip + `nbt.activeFace`，
 *  即使该网格里根本没有运行态规则命中）。因此**不能**用 `canonicalJson(entry)` 全集当判据，
 *  `name:meta` 才是渲染侧真正携带的身份信息。
 */
function unknownPaletteEntries(palette: unknown[], ref: FixtureReference): string[] {
  const known = new Set(
    paletteSignatures(ref.palette)
      .map((s) => s.idMeta)
      .filter((s) => s !== ''),
  )
  const out: string[] = []
  for (const e of paletteSignatures(palette)) {
    if (e.idMeta === '') continue // air：下标 0，两侧都必须有
    if (!known.has(e.idMeta)) out.push(e.idMeta)
  }
  // air 恒在下标 0（契约 §6.1）
  const first = paletteSignatures(palette)[0]
  if (!first || first.idMeta !== '') out.push('下标 0 必须是 air')
  return out
}

/** 每个 Tier 档位的第一条组合截一张视口图（证据链：跨档变化，不存 552 张近似重复的 PNG）。 */
function shouldShoot(previous: ExpectedCombo | null, combo: ExpectedCombo): boolean {
  return previous === null || previous.totalTier !== combo.totalTier
}

/** 一条组合的可读标签。 */
function comboLabel(c: ComboOutcome): string {
  return `${c.combo.fixtureFile} :: ${c.combo.variantKey}`
}

/**
 * 驱动一个组合、等收敛、读回三处观测（面板属性 / 渲染定义 / 参考基线）。
 */
async function driveCombo(
  page: Page,
  combo: ExpectedCombo,
  ref: FixtureReference,
  previous: ExpectedCombo | null,
  testInfo: TestInfo,
): Promise<ComboOutcome> {
  const p = panelContractFor(combo.fixtureFile)
  const t0 = Date.now()

  // 1) DOM 驱动（**批量一次往返**：Tier → 运行态 → 逐通道；只对与上一组合不同的控件派发事件）
  const payload: PanelDrivePayload = {}
  if (previous === null || previous.totalTier !== combo.totalTier) payload.tier = combo.totalTier
  if (previous === null || previous.runstate !== combo.runstate) payload.runstate = combo.runstate
  const values: Record<string, number> = {}
  for (const ch of p.channels) {
    const want = combo.values[ch.key] ?? 0
    if (previous !== null && previous.values[ch.key] === want) continue
    values[ch.key] = want
  }
  if (Object.keys(values).length > 0) payload.values = values
  if (payload.tier !== undefined || payload.runstate !== undefined || payload.values) {
    await drivePanel(page, payload)
  }

  // 2) 等渲染定义收敛（逐格 diff 归零；超时把最后一次观测交给断言报红）
  const reference = ref.byVariant.get(combo.variantKey)!
  let probes = 0
  // 等待判据 = **同时**满足形状与逐格内容（先让开一轮宏任务再读，见 `waitForRenderMatch` 注释）
  const observed = await waitForRenderMatch(async () => {
    await new Promise((r) => setTimeout(r, 0))
    probes++
    const rendered = await readRenderedDefinition(page)
    const got = signatureGrid(rendered.cellGrid, rendered.palette, 'idMeta')
    const gotFull = signatureGrid(rendered.cellGrid, rendered.palette, 'full')
    return {
      rendered,
      got,
      gotFull,
      diffCount: diffCountAgainst(got, reference.signature),
    }
  }, SETTLE_TIMEOUT_MS)

  const panel = await readChannelPanel(page)
  if (shouldShoot(previous, combo)) {
    const label = `traverse-${combo.fixtureFile.replace('.json', '')}-${combo.variantKey.replace(/[|:]/g, '_')}`
    await captureEvidence(
      page,
      page.locator(VIEWPORT_CANVAS),
      `${label} 视口`,
      `${SHOT_DIR}/${label}-${testInfo.project.name}.png`,
    )
  }

  return {
    combo,
    panelVariant: panel.variantKey ?? '<缺失>',
    panelDims: panel.dims ?? '<缺失>',
    declaredVariant: panel.declaredVariant,
    renderedShape: observed.rendered.shape,
    referenceShape: [reference.dims.d, reference.dims.h, reference.dims.w],
    diff: diffSignatureGrids(observed.got, reference.signature),
    diffFull: diffSignatureGrids(observed.gotFull, reference.signatureFull),
    renderedPaletteSize: observed.rendered.palette.length,
    paletteUnknown: unknownPaletteEntries(observed.rendered.palette, ref),
    settleMs: Date.now() - t0,
    probes,
  }
}

/** 跑一份 fixture 的组合集合（同一页面、同一文档、渐进拖动）。 */
async function runCombos(
  page: Page,
  file: string,
  combos: ExpectedCombo[],
  ref: FixtureReference,
  testInfo: TestInfo,
): Promise<{ outcomes: ComboOutcome[]; elapsedMs: number }> {
  const fx = readFixture(file)
  const t0 = Date.now()

  await gotoWorkbench(page)
  await injectSceneDocumentOk(page, fx.envelope, file)
  await openChannelTabReady(page)

  // 起手自检：注入的确实是本 fixture（避免串场）
  const initial = await readChannelPanel(page)
  expect(initial.present, `${file}：通道面板必须存在`).toBe(true)
  expect(initial.channels.length, `${file}：滑杆条数 = 声明条数`).toBe(ref.contract.channelKeys.length)

  const outcomes: ComboOutcome[] = []
  let previous: ExpectedCombo | null = null
  for (const combo of combos) {
    const out = await driveCombo(page, combo, ref, previous, testInfo)
    outcomes.push(out)
    previous = combo

    const label = comboLabel(out)
    expect(out.panelVariant, `${label}：面板 data-mb-variant 必须 = 期望变体键`).toBe(combo.variantKey)
    expect(out.panelDims, `${label}：面板 data-mb-dims 必须 = 参考尺寸`).toBe(
      dimsText(ref.byVariant.get(combo.variantKey)!.dims),
    )
    expect(out.renderedShape, `${label}：渲染定义形状 [d,h,w] 必须 = 参考形状`).toEqual(out.referenceShape)
    expect(out.paletteUnknown, `${label}：渲染调色板不得出现 fixture 未声明的方块内容`).toEqual([])
    expect(
      out.diff.count,
      `${label}：逐格 diff 必须为 0（逐格判据）。${describeGridDiff(out.diff)}`,
    ).toBe(0)
  }

  return { outcomes, elapsedMs: Date.now() - t0 }
}

/** 汇总日志（覆盖矩阵 + 耗时实测）。 */
function logSummary(
  file: string,
  outcomes: ComboOutcome[],
  elapsedMs: number,
  testInfo: TestInfo,
  reduced: ReturnType<typeof reducedTraversal> | null,
): void {
  const settle = outcomes.map((o) => o.settleMs)
  const sum = settle.reduce((a, b) => a + b, 0)
  const max = settle.reduce((a, b) => Math.max(a, b), 0)
  const probes = outcomes.reduce((a, b) => a + b.probes, 0)
  const cells = outcomes.reduce((a, b) => a + b.diff.cells, 0)
  const gridDiffZero = outcomes.filter((o) => o.diff.count === 0).length
  const fullDiffZero = outcomes.filter((o) => o.diffFull.count === 0).length
  // 诊断：面板当前**没有**输出 `data-mb-declared`（实测恒为 null），故"组合是否已声明"这一维度
  // 由"面板变体键逐字命中期望键 + 逐格 diff=0"这两条可观测证据等价表达（见 README §7.7）。
  const declaredSamples = [...new Set(outcomes.map((o) => String(o.declaredVariant)))].join(',')
  // 删减账本（desktop 精简集才有）：声明多少 → 实跑多少 → 判据上界（内容类）多少。
  const ledger = reduced
    ? `\n  删减账本：声明 ${reduced.declared} → 精简 ${reduced.combos.length}` +
      `（内容类 ${reduced.contentClasses} = 判据上界／轴跃迁见证 ${reduced.witnesses.length}／逐档覆盖 ${reduced.levelCover.length}）` +
      `；省略 ${reduced.pairing.length} 条**逐条已配对**（每条都能指认一个逐格相同的保留成员）；` +
      `盲轴 [${reduced.blindAxes.join(',') || '无'}]`
    : ''
  console.log(
    `[多方块] 遍历 ${testInfo.project.name} :: ${file}\n` +
      `  组合 ${outcomes.length} / 格 ${cells} / 逐格 diff=0 的组合 ${gridDiffZero}/${outcomes.length}` +
      `（full 签名口径 ${fullDiffZero}/${outcomes.length}）\n` +
      `  耗时：总 ${elapsedMs} ms（${(elapsedMs / Math.max(outcomes.length, 1)).toFixed(1)} ms/组合）` +
      `，单组合驱动→收敛 mean ${(sum / Math.max(outcomes.length, 1)).toFixed(1)} ms / max ${max} ms` +
      `，收敛探测 ${probes} 次（${(probes / Math.max(outcomes.length, 1)).toFixed(2)}/组合）\n` +
      `  渲染调色板尺寸 ${[...new Set(outcomes.map((o) => o.renderedPaletteSize))].join(',')}` +
      `；data-mb-declared 观测值集合 {${declaredSamples}}` +
      ledger,
  )
}

test.describe('通道滑杆组合遍历（desktop 精简集 / mobile 抽样）', () => {
  for (const file of FIXTURES) {
    test(`${file}：已声明组合 → 变体键 / 尺寸 / 逐格 diff`, async ({ page }, testInfo) => {
      const ref = snapshotOrFallbackReference(file)
      const reduced = reducedTraversal(file)
      const isDesktop = testInfo.project.name === 'desktop-chrome'
      // desktop 跑**精简集**；mobile 保留原抽样子集（证窄视口下同一链路成立）。
      const combos = isDesktop ? reduced.combos : sampleCombos(file)
      test.setTimeout(300_000)

      const { outcomes, elapsedMs } = await runCombos(page, file, combos, ref, testInfo)
      logSummary(file, outcomes, elapsedMs, testInfo, isDesktop ? reduced : null)

      expect(outcomes.length, `${file}：遍历组合数`).toBe(combos.length)
      expect(
        outcomes.filter((o) => o.diff.count === 0).length,
        `${file}：全部组合的逐格 diff 必须为 0`,
      ).toBe(outcomes.length)

      // 非门禁的更强证据（full 签名口径）：**记录**而不是断言 —— 渲染侧调色板条目由
      // `Grid` 按 `name:meta` 归并，归并后保留哪一条的 tooltip/nbt 不确定
      // （EBF 并集 7/8 同 `gt.blockmachines@1000`，实测渲染保留第 8 条的 tooltip + nbt.activeFace），
      // 因此 full 口径差异在本 fixture 上是**预期现象**，逐格门禁一律用 `idMeta` 口径。
      const fullMismatch = outcomes.filter((o) => o.diffFull.count > 0)
      if (fullMismatch.length > 0) {
        console.log(
          `[多方块] 诊断：full 签名口径下 ${fullMismatch.length}/${outcomes.length} 个组合存在差异` +
            `（预期：渲染侧把调色板条目的 registryId 归一为 minecraft: 前缀 + 按 name:meta 归并）；` +
            `idMeta 口径仍为 0 —— 例如 ${comboLabel(fullMismatch[0]!)}：${describeGridDiff(fullMismatch[0]!.diffFull)}`,
        )
      }
      // 而 `idMeta` 口径**必须是零差异**（门禁本身在 `runCombos` 里逐组合已断言，此处给出汇总证据）
      expect(
        outcomes.filter((o) => o.diff.count === 0).length,
        `${file}：idMeta 口径（门禁）必须全部为 0`,
      ).toBe(outcomes.length)
    })
  }

  test('尺寸变化方向：Tier / 尺寸型通道增大 → 结构尺寸非递减（逐档实测值）', async ({ page }, testInfo) => {
    test.setTimeout(300_000)
    await gotoWorkbench(page)

    // ① EBF：尺寸型通道 height 1→5（Tier 固定 1，其余通道 Not set），维度 = cellGrid[0].length
    {
      const file = 'multiblock-ebf-2ch.json'
      const ref = snapshotOrFallbackReference(file)
      await injectSceneDocumentOk(page, readFixture(file).envelope, file)
      await openChannelTabReady(page)
      await setTier(page, 1)
      const heights: number[] = []
      for (const h of [1, 2, 3, 4, 5]) {
        await drivePanel(page, { values: { height: h } })
        const key = `height:${h}|coil:0|glass:0|tt:1|runstate:idle`
        const reference = ref.byVariant.get(key)!
        const got = await pollUntil(
          async () => {
            const rendered = await readRenderedDefinition(page)
            const sig = signatureGrid(rendered.cellGrid, rendered.palette, 'idMeta')
            return diffCountAgainst(sig, reference.signature) === 0 ? rendered : null
          },
          `EBF height=${h} 渲染收敛`,
          SETTLE_TIMEOUT_MS,
        )
        heights.push(got.shape[1])
      }
      expect(heights, 'EBF：height 1→5 的高度序列必须严格递增 1→5').toEqual([1, 2, 3, 4, 5])
      for (let i = 1; i < heights.length; i++) {
        expect(heights[i]!, `EBF height 档 ${i} 非递减`).toBeGreaterThanOrEqual(heights[i - 1]!)
      }
      console.log(`[多方块] 尺寸方向 EBF（${testInfo.project.name}）：height 1→5 高度 ${heights.join(' → ')}`)
    }

    // ② 仅总 Tier：Tier 1→3 决定柱高（骨架阶 3/4/5）
    {
      const file = 'multiblock-tier-only.json'
      const ref = snapshotOrFallbackReference(file)
      await injectSceneDocumentOk(page, readFixture(file).envelope, file)
      await openChannelTabReady(page)
      const heights: number[] = []
      for (const tier of [1, 2, 3]) {
        await setTier(page, tier)
        const key = `structTier:0|tt:${tier}|runstate:idle`
        const reference = ref.byVariant.get(key)!
        const got = await pollUntil(
          async () => {
            const rendered = await readRenderedDefinition(page)
            const sig = signatureGrid(rendered.cellGrid, rendered.palette, 'idMeta')
            return diffCountAgainst(sig, reference.signature) === 0 ? rendered : null
          },
          `tier-only tt=${tier} 渲染收敛`,
          SETTLE_TIMEOUT_MS,
        )
        heights.push(got.shape[1])
      }
      expect(heights, 'tier-only：Tier 1→3 的高度序列必须是 3 → 4 → 5').toEqual([3, 4, 5])
      // 非递减 + 至少一档严格变大（防"滑杆没接线也会绿"）
      expect(heights.some((v, i) => i > 0 && v > heights[i - 1]!), 'tier-only：至少一档必须严格变大').toBe(true)
      console.log(`[多方块] 尺寸方向 tier-only（${testInfo.project.name}）：Tier 1→3 高度 ${heights.join(' → ')}`)
    }
  })

  test('像素诊断（**非门禁**）：重复截图一致（噪声地板）+ 相邻组合差异如实记录供真实产物对照', async ({ page }, testInfo) => {
    test.setTimeout(300_000)
    await gotoWorkbench(page)
    const file = 'multiblock-ebf-2ch.json'
    const ref = snapshotOrFallbackReference(file)
    await injectSceneDocumentOk(page, readFixture(file).envelope, file)
    await openChannelTabReady(page)

    /** 驱动到一个组合、等收敛、截图 + 像素统计。 */
    const shotAt = async (tier: number, height: number, coil: number, glass: number, runstate: string, label: string) => {
      await drivePanel(page, {
        tier,
        runstate,
        values: { height, coil, glass },
      })
      const key = `height:${height}|coil:${coil}|glass:${glass}|tt:${tier}|runstate:${runstate}`
      const reference = ref.byVariant.get(key)!
      await pollUntil(
        async () => {
          const rendered = await readRenderedDefinition(page)
          const sig = signatureGrid(rendered.cellGrid, rendered.palette, 'idMeta')
          return diffCountAgainst(sig, reference.signature) === 0 ? true : null
        },
        `像素诊断 ${key} 渲染收敛`,
        SETTLE_TIMEOUT_MS,
      )
      // captureEvidence 内部完成"截图非空"基础断言（全黑/纯色必须被拒）
      return await captureEvidence(page, page.locator(VIEWPORT_CANVAS), `像素诊断 ${label} ${key}`, null)
    }

    // ① 负向判据（**作门禁**）：同一组合重复截图必须一致 —— 这是噪声地板
    const a1 = await shotAt(2, 1, 1, 1, 'idle', '重复A')
    const a2 = await shotAt(2, 1, 1, 1, 'idle', '重复B')
    const noise = expectStablePixels(a1.signature, a2.signature, 'EBF 同组合重复截图')

    // ② 正向差异（**只记录，不作门禁**）：合成 fixture 的几何在视口里不可见
    const s0 = await shotAt(2, 1, 1, 1, 'idle', 'height=1')
    const s1 = await shotAt(2, 5, 1, 1, 'idle', 'height=5')
    const s2 = await shotAt(2, 5, 1, 1, 'active', 'active')
    const d01 = signatureDiff(s0.signature, s1.signature)
    const d12 = signatureDiff(s1.signature, s2.signature)

    console.log(
      `[多方块] 像素诊断（${testInfo.project.name}）\n` +
        `  噪声地板（同组合重复截图，门禁）：meanAbs=${noise.meanAbs.toFixed(4)} maxAbs=${noise.maxAbs.toFixed(2)} ` +
        `变化格=${noise.changedCells}/256\n` +
        `  非门禁诊断 height 1→5  : meanAbs=${d01.meanAbs.toFixed(4)} maxAbs=${d01.maxAbs.toFixed(2)} 变化格=${d01.changedCells}\n` +
        `  非门禁诊断 idle→active : meanAbs=${d12.meanAbs.toFixed(4)} maxAbs=${d12.maxAbs.toFixed(2)} 变化格=${d12.changedCells}\n` +
        `  视口像素 uniqueColors=${s1.stats.uniqueColors} σ=${s1.stats.stdDevLuma.toFixed(2)} ` +
        `nonBlack=${s1.stats.nonBlackRatio.toFixed(4)}（同视口的帧为主样例 uniqueColors 500+）`,
    )
    // 门禁只有一条：截图不得退化成纯色（WebGL 上下文丢失 / 未绘制）
    expect(s1.stats.uniqueColors, '视口截图不得退化成纯色').toBeGreaterThan(1)
  })

  /**
   * **运行态可辨（EBF，门禁）** —— 从"非门禁诊断"升格为判据。
   *
   * ## 病历（为什么它此前只能"记录"）
   *
   * 本条原先只驱动一对"**其余轴全部固定、仅运行态不同**"的组合，断言①两次都收敛到各自
   * 参考，然后**记录**②渲染定义是否可分辨、③控制器条目内容 —— 因为当时实测渲染面
   * **结构性不可分辨**（`cellGrid` 与 `blockPalette` 两次全文相同），把"注定红"的断言写成
   * 门禁等于用假失败冒充判据。缺口登记在 `reducedTraversal.ts` 的 `KNOWN_BLIND_AXES`。
   *
   * ## 现在为什么能当门禁（已修，根因=失效判定读面）
   *
   * 根因不在投影、也不在渲染包解析（三段实测：`kernelRenderViewOf` 的产物、`fromV2Plain`
   * 往返、`resolveRenderBundle` 的解析**都已经可辨**），而在**内容身份的读面**：
   * `runtime/presentationAdapter#readContentIdentity` 的结构摘要只含**名称级**调色板身份
   * （`registryId@meta`），对"同 `name:meta`、异条目内容"（运行态：`tooltip`/`nbt.activeFace`）
   * 结构性不可见 ⇒ `planContentRebuild` 全 false ⇒ 渲染链**什么都不做** ⇒ 视口定义逐字节不变。
   *
   * ## 判据（两条都是**生产观测面**：`vpSlot.definition`，不新造探针）
   *
   *  1. **逐字节变化**：两次渲染定义（`cellGrid` + `blockPalette` 全文）必须不同；
   *  2. **含 running 形态**：active 的控制器条目必须带运行态内容（`tooltip` 含
   *     `(running)` **且** `nbt.activeFace === true`），idle 的必须**不带** ——
   *     两侧都断言，防止"随手改点别的字段"也算过。
   *
   * 门禁仍保留原有的"两次都必须收敛到各自参考（`idMeta` 逐格 diff=0）"作为前置：
   * 否则下面的"可分辨性"结论毫无意义。
   */
  test('运行态可辨（EBF，门禁）：固定其余轴、仅改运行态 ⇒ 视口渲染定义逐字节变化且含 running 形态', async ({ page }) => {
    test.setTimeout(120_000)
    const file = 'multiblock-ebf-2ch.json'
    const ref = snapshotOrFallbackReference(file)
    await gotoWorkbench(page)
    await injectSceneDocumentOk(page, readFixture(file).envelope, file)
    await openChannelTabReady(page)

    // 一对**其余轴固定、仅 runstate 不同**的组合（取精简集里那一对的取值）。
    const common = { height: 1, coil: 1, glass: 1 }
    const tiers = 1
    const keyOf = (rs: string): string =>
      `height:${common.height}|coil:${common.coil}|glass:${common.glass}|tt:${tiers}|runstate:${rs}`

    const drive = async (rs: string) => {
      await drivePanel(page, { tier: tiers, runstate: rs, values: common })
      const reference = ref.byVariant.get(keyOf(rs))!
      const observed = await waitForRenderMatch(async () => {
        await new Promise((r) => setTimeout(r, 0))
        const rendered = await readRenderedDefinition(page)
        const got = signatureGrid(rendered.cellGrid, rendered.palette, 'idMeta')
        return { rendered, diffCount: diffCountAgainst(got, reference.signature) }
      }, SETTLE_TIMEOUT_MS)
      return observed
    }

    const idle = await drive('idle')
    const active = await drive('active')

    // 前置：两次都必须真收敛到各自参考（否则下面的"可分辨性"结论毫无意义）
    expect(idle.diffCount, `${keyOf('idle')}：必须收敛到参考（idMeta 逐格 diff=0）`).toBe(0)
    expect(active.diffCount, `${keyOf('active')}：必须收敛到参考（idMeta 逐格 diff=0）`).toBe(0)

    // 门禁①：渲染定义**逐字节**变化（cellGrid + blockPalette 全文）
    const idleText = JSON.stringify(idle.rendered)
    const activeText = JSON.stringify(active.rendered)
    expect(
      activeText,
      '仅切运行态后，视口渲染定义（cellGrid + blockPalette 全文）必须逐字节变化',
    ).not.toBe(idleText)

    // 门禁②：active 必须含 running 形态，idle 必须不含（两侧都断言）
    const controllerOf = (palette: unknown[]): Record<string, unknown> => {
      const hit = paletteSignatures(palette).findIndex((s) => s.idMeta === 'gt.blockmachines:1000')
      expect(hit, 'EBF 的控制器条目（gt.blockmachines:1000）必须出现在渲染调色板里').toBeGreaterThanOrEqual(0)
      return palette[hit] as Record<string, unknown>
    }
    const runningShape = (e: Record<string, unknown>): boolean =>
      JSON.stringify(e.tooltip ?? null).includes('(running)') &&
      (e.nbt as { activeFace?: unknown } | undefined)?.activeFace === true

    const idleCtl = controllerOf(idle.rendered.palette)
    const activeCtl = controllerOf(active.rendered.palette)
    expect(runningShape(activeCtl), `active 的控制器条目必须带 running 形态（tooltip + nbt.activeFace），实测 ${JSON.stringify(activeCtl)}`).toBe(true)
    expect(runningShape(idleCtl), `idle 的控制器条目**不得**带 running 形态，实测 ${JSON.stringify(idleCtl)}`).toBe(false)

    // 参考侧对照（诊断；不是门禁）：并集下标 7/8 的 tooltip/nbt
    const refController = (key: string): string => {
      const grid = ref.byVariant.get(key)!.cellGrid
      const used = new Set<number>()
      for (const slice of grid) for (const row of slice) for (const i of row) used.add(i)
      const idxs = [...used].filter((i) => ref.paletteLabels[i] === 'gt.blockmachines@1000')
      return idxs
        .map((i) => {
          const e = ref.palette[i] as { tooltip?: unknown; nbt?: unknown }
          return `[${i}] tooltip=${JSON.stringify(e.tooltip)} nbt=${JSON.stringify(e.nbt)}`
        })
        .join('  ')
    }

    console.log(
      `[运行态门禁] ${file} :: 其余轴固定 (height=${common.height},coil=${common.coil},glass=${common.glass},tt=${tiers})\n` +
        `  前置①：两次渲染均收敛到各自参考，idMeta 逐格 diff=0\n` +
        `  门禁①：渲染定义逐字节变化 = ${idleText !== activeText}（idle ${idleText.length}B / active ${activeText.length}B）\n` +
        `  门禁②：active 控制器 = ${JSON.stringify(activeCtl)}；idle 控制器 = ${JSON.stringify(idleCtl)}\n` +
        `  参考侧对照：idle → ${refController(keyOf('idle'))}；active → ${refController(keyOf('active'))}`,
    )
  })

  test('覆盖矩阵自检：期望枚举 ↔ 文件声明 ↔ 参考清单 三方一致（含 mobile 抽样命中）', async ({}, testInfo) => {
    for (const file of FIXTURES) {
      const ref = snapshotOrFallbackReference(file)
      const req = readFixture(file)
      const all = enumerateExpectedCombos(file)
      expect(all.length, `${file}：期望组合数 = 契约声明的变体数`).toBe(ref.contract.variantCount)
      for (const combo of all) {
        expect(ref.byVariant.has(combo.variantKey), `${file}：参考清单必须含 ${combo.variantKey}`).toBe(true)
      }
      const sample = sampleCombos(file)
      for (const combo of sample) {
        expect(ref.byVariant.has(combo.variantKey), `${file}：抽样组合必须命中参考清单 ${combo.variantKey}`).toBe(true)
      }
      const docVariants = ((req.inner.multiblock as { variants: Array<{ key: string }> }).variants ?? []).map((v) => v.key)
      expect([...docVariants].sort(), `${file}：期望枚举 vs 文件声明的变体键集合`).toEqual(
        [...all.map((c) => c.variantKey)].sort(),
      )
      console.log(
        `[多方块] 覆盖矩阵 ${testInfo.project.name} :: ${file} 全量 ${all.length} / mobile 抽样 ${sample.length}`,
      )
    }
  })

  /**
   * 删减论证自证（**零浏览器成本**，两个 project 都跑）。
   *
   * 精简集 `S` 的三条不变量若有一条站不住，`buildReducedTraversal()` 会**抛错**：
   *  ① 内容类全覆盖（不存在"没有任何组合断言过"的期望内容）；
   *  ② 每条"内容会变"的轴跃迁都有见证落在 `S` 内（任一滑杆/Tier 轴失效必红）；
   *  ③ 每个被省略的组合都能指认 `S` 内一个**逐格相同**的成员（逐条配对，不是抽样估计）；
   *  ④ 实际盲轴集合 == `KNOWN_BLIND_AXES`（轴"悄悄变盲"必须被抓住）。
   *
   * 这条用例是"删减 483 条组合"这一动作的**判据**——删减理由本身也被测试把守。
   */
  test('精简集自证：内容类全覆盖 / 跃迁见证完备 / 省略者逐条配对 / 盲轴已登记', async () => {
    const summary = assertReducedTraversal()
    console.log(summary)
    for (const file of FIXTURES) {
      const s = reducedTraversal(file)
      expect(s.combos.length, `${file}：精简集必须非空且小于声明数（除全互异的 tiny fixture）`).toBeGreaterThan(0)
      expect(s.contentClasses, `${file}：判据上界（内容类数）必须为正`).toBeGreaterThan(0)
      // 逐个保留成员都必须在参考清单里（防止"精简"把键写错导致空跑）
      const ref = snapshotOrFallbackReference(file)
      for (const combo of s.combos) {
        expect(ref.byVariant.has(combo.variantKey), `${file}：保留成员 ${combo.variantKey} 必须在参考清单`).toBe(true)
      }
    }
  })
})
