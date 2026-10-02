/**
 * T2.6 第二阶段 · 交付 1 —— **通道面板声明一致性断言**。
 *
 * 目标（计划 T2.4 硬约束「通道 UI 忠实反映文件声明」的机器判据）：
 *  1. 面板条数 = 文件声明的通道条数（EBF 3 / 只 Tier 的 fixture 无具名通道只 Tier 滑杆 / LSC 3）；
 *  2. 每条滑杆标签 = 通道**呈现名**（逐字）、范围 `0..hi`（`hi = domain.max`）、
 *     `0` 显示 `Not set`；
 *  3. Tier 滑杆范围与 `totalTierDomain` 一致（含已声明抽样清单）；
 *  4. 运行态选项与声明一致（id + 呈现名，顺序一致）。
 *
 * 期望值全部**硬编码**在 `panelContract.ts`（反同义反复）：不读被测文件、不读被测 DOM 来当期望。
 * 另加一条**交叉一致**断言（`doc.multiblockChannels` ↔ 面板 `data-*`）：它能抓出
 * "面板自己算了一套"这类偏差，但它不是主要判据（主要判据是上面的硬编码表）。
 *
 * 证据链：整页 + 视口截图存档到 `e2e/screenshots/multiblock/`（合成 fixture 的截图
 * **只存档不断言内容**，见 README「像素判据不适用于合成 fixture」）。
 */

import { expect, test } from '@playwright/test'
import {
  CHANNEL_TAB,
  PANEL_CONTRACTS,
  contractFor,
  gotoWorkbench,
  injectSceneDocumentOk,
  openChannelTabReady,
  panelContractFor,
  readChannelPanel,
  readDocObservation,
  readFixture,
  VIEWPORT_CANVAS,
  captureEvidence,
  type ChannelPanelObservation,
} from './helpers/multiblock'

/** 截图目录（与第一阶段证据链同处）。 */
const SHOT_DIR = 'e2e/screenshots/multiblock'

function shotPath(label: string, project: string): string {
  return `${SHOT_DIR}/${label}-${project}.png`
}

test.describe('T2.6 · 通道面板声明一致性（面板 ↔ 文件声明的硬编码期望）', () => {
  for (const file of PANEL_CONTRACTS.map((p) => p.file)) {
    test(`面板忠实反映 ${file} 的声明（条数/标签/范围/Not set/Tier 域/运行态）`, async ({ page }, testInfo) => {
      const c = contractFor(file)
      const p = panelContractFor(file)
      const fx = readFixture(c.file)

      await gotoWorkbench(page)
      await injectSceneDocumentOk(page, fx.envelope, c.file)

      // 通道 tab：多方块文档的**默认** tab，但仍以显式点击驱动（DOM 事件，不直接调内部函数）
      await expect(page.locator(CHANNEL_TAB)).toBeVisible()
      await openChannelTabReady(page)

      const panel: ChannelPanelObservation = await readChannelPanel(page)
      expect(panel.present, `${c.file}：通道面板必须存在`).toBe(true)

      // ── 1. 条数 + 呈现名 ────────────────────────────────────────────────
      expect(panel.displayName, `${c.file}：面板显示名`).toBe(p.displayName)
      expect(
        panel.channels.map((x) => x.key),
        `${c.file}：滑杆条数/顺序必须 = 文件声明的通道顺序`,
      ).toEqual(p.channels.map((x) => x.key))
      expect(panel.channels.length, `${c.file}：滑杆条数`).toBe(p.sliderCount)
      // 「无具名通道 → 只 Tier 滑杆」的机器判据：tier-only 的滑杆集合退化为单条 structTier
      if (p.sliderCount === 1 && p.channels[0]!.key === 'structTier') {
        expect(panel.channels.length, 'tier-only：具名通道之外的轴不生成额外滑杆').toBe(1)
      }

      for (const want of p.channels) {
        const got = panel.channels.find((x) => x.key === want.key)!
        expect(got, `${c.file}：通道 ${want.key} 的滑杆`).toBeTruthy()
        // ── 2. 标签 / 范围 / Not set ─────────────────────────────────────
        expect(got.name, `${c.file}/${want.key}：滑杆标签必须 = 文件呈现名`).toBe(want.name)
        expect(got.kind, `${c.file}/${want.key}：data-mb-channel-kind`).toBe(want.kind)
        expect(got.sliderMin, `${c.file}/${want.key}：滑杆下界（0 = Not set 必须可及）`).toBe(want.sliderMin)
        expect(got.sliderMax, `${c.file}/${want.key}：滑杆上界 = domain.max`).toBe(want.sliderHi)
        expect(got.effMin, `${c.file}/${want.key}：声明有效下界`).toBe(want.valueMin)
        expect(got.effMax, `${c.file}/${want.key}：声明有效上界`).toBe(want.valueMax)
        // 初始态：所有通道 Not set（0）
        expect(got.value, `${c.file}/${want.key}：初始取值`).toBe(0)
        expect(got.valueText, `${c.file}/${want.key}：0 必须显示 "${p.notSetText}"`).toBe(p.notSetText)
      }

      // 面板里不得出现未声明的通道滑杆
      const declared = p.channels.map((x) => x.key).sort()
      expect([...panel.channels.map((x) => x.key)].sort(), `${c.file}：未声明通道不得出现滑杆`).toEqual(declared)

      // ── 3. Tier 滑杆范围与 totalTierDomain 一致 ────────────────────────
      expect(panel.tierMin, `${c.file}：data-mb-tier-min = totalTierDomain.min`).toBe(p.tierMin)
      expect(panel.tierMax, `${c.file}：data-mb-tier-max = totalTierDomain.max`).toBe(p.tierMax)
      expect(panel.tierSamples, `${c.file}：Tier 滑杆的已声明抽样清单`).toEqual(p.tierSamples)
      // 初始 Tier = totalTierDomain.default（并吸附到已声明抽样）：三份 fixture 的 default 都在抽样内
      const ttDefault = c.totalTierDomain as { min: number; max: number } & { default?: number }
      const declaredDefault = (fx.inner.multiblock as { totalTierDomain: { default?: number } }).totalTierDomain.default ?? ttDefault.max
      expect(p.tierSamples, `${c.file}：抽样清单必须升序且落在域内`).toEqual([...p.tierSamples].sort((a, b) => a - b))
      expect(panel.tier, `${c.file}：初始 Tier = 声明的 default（吸附抽样后）`).toBe(declaredDefault)
      for (const t of p.tierSamples) {
        expect(t, `${c.file}：抽样 ${t} 落在 ${p.tierMin}..${p.tierMax}`).toBeGreaterThanOrEqual(p.tierMin)
        expect(t).toBeLessThanOrEqual(p.tierMax)
      }
      expect(panel.tierValueText, `${c.file}：Tier 数值文本`).toBe(String(panel.tier))

      // ── 4. 运行态选项与声明一致 ────────────────────────────────────────
      expect(panel.runstateOptions, `${c.file}：运行态选项（id + 呈现名 + 顺序）`).toEqual(p.runstates)
      expect(panel.runstate, `${c.file}：初始运行态 = 声明首项`).toBe(p.runstates[0]!.id)

      // ── 4b. 初始取值必须命中已声明组合（契约 §5.2 推论 1）────────────────
      // 注：面板**不**渲染 `data-mb-declared`（实测 `readChannelPanel().declaredVariant === null`），
      // 故这里用"初始键 = 全通道 Not set + 声明 default + 声明首运行态"来等价表达，
      // 并在遍历用例里对**全部 552 个可达组合**断言逐格命中参考（更强的等价证据）。
      const expectedInitialKey = [
        ...p.channels.map((ch) => `${ch.key}:0`),
        `tt:${declaredDefault}`,
        `runstate:${p.runstates[0]!.id}`,
      ].join('|')
      expect(panel.variantKey, `${c.file}：初始变体键（全通道 Not set + 声明 default）`).toBe(expectedInitialKey)

      // ── 交叉一致（非主判据）：面板 ↔ 文档公开观测 ──────────────────────
      const doc = await readDocObservation(page)
      expect(doc.channels.map((x) => x.key), `${c.file}：面板 ↔ doc.multiblockChannels 的 key`).toEqual(
        panel.channels.map((x) => x.key),
      )
      expect(doc.channels.map((x) => x.name)).toEqual(panel.channels.map((x) => x.name))
      expect(doc.channels.map((x) => x.kind)).toEqual(panel.channels.map((x) => x.kind))
      // 滑杆上界 = 文档公开的取值域上界
      expect(panel.channels.map((x) => x.sliderMax)).toEqual(doc.channels.map((x) => x.domainHi))
      expect({ min: panel.tierMin, max: panel.tierMax }).toEqual({
        min: doc.totalTierDomain!.min,
        max: doc.totalTierDomain!.max,
      })

      // ── 5. 只提示不拒绝的提示（文件软约束逐条呈现） ────────────────────
      // 注意：notice 列表 = 文件 notes **+** 本轮装配的夹取/回落提示。初始态是否夹取取决于
      // 「通道 Not set 回落总 Tier 后是否越出该通道取值域」（如 LSC tt=3、capacitor 域上界 2
      // → capacitor 0 回落 3 后夹到 2），故这里只断言 **notes 的逐条覆盖**（条数下界），
      // 夹取提示的专项断言见 `multiblock-channel-illegal.spec.ts`。
      const declaredNotes = (
        (fx.inner.multiblock as { notes?: Array<{ text: string }> }).notes ?? []
      ).map((n) => n.text)
      expect(declaredNotes.length, `${c.file}：fixture 声明的 notes 条数`).toBe(p.noteCount)
      expect(
        panel.notices.length,
        `${c.file}：notes（${p.noteCount} 条）必须逐条呈现。实测 ${JSON.stringify(panel.notices)}`,
      ).toBeGreaterThanOrEqual(p.noteCount)
      for (const text of declaredNotes) {
        expect(
          panel.notices,
          `${c.file}：软约束 note 必须原样出现在 notice 列表里`,
        ).toContain(`提示（文件声明）：${text}`)
      }
      // 非 notes 的 notice 必须能自证来源（夹取 / 未声明组合 / 解析告警），不得是没有任何出处的自由文本
      for (const n of panel.notices) {
        if (n.startsWith('提示（文件声明）：')) continue
        expect(
          /取值夹取|耦合夹取|未声明|回落|告警|装配失败/.test(n),
          `${c.file}：notice 必须能自证来源（夹取/回落/告警）。实测 ${JSON.stringify(n)}`,
        ).toBe(true)
      }

      // ── 证据链（内容不设门禁，见 README：合成 fixture 视觉不可见是几何属性问题） ──
      const project = testInfo.project.name
      const pageCap = await captureEvidence(page, page, `${c.file} 整页`, shotPath(`panel-${c.file.replace('.json', '')}`, project))
      await captureEvidence(page, page.locator(VIEWPORT_CANVAS), `${c.file} 视口`, null)
      console.log(
        `[T2.6] 面板声明一致性 ${c.file}：滑杆 ${panel.channels.length} 条 / Tier ${panel.tierMin}..${panel.tierMax} ` +
          `抽样 [${panel.tierSamples.join(',')}] / 运行态 ${panel.runstateOptions.length} 态 / notice ${panel.notices.length} 条；` +
          `整页像素 uniqueColors=${pageCap.stats.uniqueColors} σ=${pageCap.stats.stdDevLuma.toFixed(2)}`,
      )
    })
  }
})
