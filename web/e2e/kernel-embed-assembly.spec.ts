/**
 * **生产嵌入装配**（A14/A15 从测试事实变生产事实）。
 *
 * ## 判据的三面（全部读运行中的生产实例，不喂手工载荷）
 *
 * 1. **装配可查询**：`window.__lk_embed__.probes()[0]`（`EmbedRoot` 用**它实际持有的**
 *    `ShellRuntime` 登记）⇒ `capabilities()` / `pruned()` / `prunedLandings()`。
 *    A14 的"可选落点被裁剪且原因可查"必须在这份结果上成立（`editor:inspector`）。
 * 2. **嵌入能力集**：看（evaluate/picking/interaction.begin）+ 播放（timeline.playback）
 *    + 通道仍在；无 content.* / save.write / export.run / tools.manipulators / layout.edit。
 * 3. **负对照（结构化拒绝）**：在同一实例上经**生产写入口**发一条内容编辑命令
 *    （`Context#submitContentEditSettlement`，与 operator 同一条）⇒ `status:'rejected'`
 *    + `error.code:'UnsupportedOperation'`。这不是"UI 上悄悄没有按钮"：命令真的被发出去了，
 *    拒绝带结构化原因。
 *
 * 同一条用例里的**正对照**（setTime / setChannelValue 未被拒）证明上面的拒绝来自
 * **装配裁剪**，而不是"这条写入口坏了"。
 *
 * ## 为什么不用 `assembly.test.ts` 的手工载荷
 *
 * 铁律⑦：接线判据的输入必须来自生产解析 + 装配。本 spec 读的是**运行实例**里
 * `EmbedRoot` 交给 `createEmbedHost` 的那个 `shell.assembly` —— 若有人把
 * `createEmbedShellRuntime()` 从生产路径摘掉（回到能力空集），本 spec 立刻红。
 */

import { expect, test, type Page } from '@playwright/test'

const PAGE = '/e2e-embed-mobile.html'

interface ProbeReading {
  profileId: string
  regionId: string
  capabilities: string[]
  pruned: { moduleId: string; reason: string; capability?: string }[]
  prunedLandings: { kind: string; id: string; moduleId: string; missingCapability: string }[]
}

async function waitEmbedProbe(page: Page): Promise<void> {
  await page.goto(PAGE)
  await expect(page.locator('.vc-viewport canvas'), '嵌入必须真的挂上画布').toBeVisible({ timeout: 120_000 })
  await page.waitForFunction(
    () => {
      const probe = (window as any).__lk_embed__
      return typeof probe?.probes === 'function' && probe.probes().length >= 1
    },
    undefined,
    { timeout: 60_000 },
  )
}

async function readProbe(page: Page): Promise<ProbeReading> {
  return (await page.evaluate(() => {
    const p = (window as any).__lk_embed__.probes()[0]
    const asm = p.assembly()
    return {
      profileId: String(p.profileId),
      regionId: String(p.regionId),
      capabilities: [...p.capabilities()].map(String).sort(),
      pruned: (asm.pruned ?? []).map((x: any) => ({ moduleId: String(x.moduleId), reason: String(x.reason), capability: x.capability === undefined ? undefined : String(x.capability) })),
      prunedLandings: (asm.prunedLandings ?? []).map((x: any) => ({
        kind: String(x.kind),
        id: String(x.id),
        moduleId: String(x.moduleId),
        missingCapability: String(x.missingCapability),
      })),
    }
  })) as ProbeReading
}

test.describe('生产嵌入装配（EMBED_PROFILE 真消费）', () => {
  test('生产事实：装配可查询、能力集齐备、落点裁剪留原因', async ({ page }) => {
    test.setTimeout(240_000)
    await waitEmbedProbe(page)
    const reading = await readProbe(page)
    console.log('[embed-assembly] ' + JSON.stringify(reading))

    expect(reading.profileId, '生产嵌入实例的 profile 必须是 embed').toBe('embed')
    expect(reading.regionId, '独立嵌入的视口 region').toBe('r-embed')

    // ── 嵌入能力集：看 + 悬停说明 + 播放动画（通道/时间轴）──
    for (const cap of [
      'evaluate',
      'picking',
      'interaction.begin',
      'timeline.playback',
      'timeline.edit',
      'channels.panel',
      'editor.viewport3d',
      'shell.embed',
    ]) {
      expect(reading.capabilities, '生产嵌入必须仍具备 ' + cap + '（嵌入能力集）').toContain(cap)
    }
    // ── 嵌入能力的负向：无编辑 / 无保存 / 无正式导出 / 无布局编辑 / 无操纵器 ──
    for (const cap of [
      'content.edit',
      'content.add',
      'content.delete',
      'save.write',
      'export.run',
      'tools.manipulators',
      'layout.edit',
      'layout.restore',
    ]) {
      expect(reading.capabilities, '生产嵌入不得具备 ' + cap).not.toContain(cap)
    }

    // ── A14：可选落点在**生产装配结果**上被裁剪且原因可查 ──
    expect(
      reading.prunedLandings,
      '生产装配必须在 prunedLandings 里留下 editor:inspector 的裁剪记录',
    ).toEqual([
      { kind: 'editor', id: 'inspector', moduleId: 'editors.inspector', missingCapability: 'inspector.panels' },
    ])
    expect(
      reading.pruned.some((p) => p.moduleId === 'editors.inspector' && p.reason === 'missingOptionalCapability' && p.capability === 'inspector.panels'),
      '模块级裁剪记录（A14 可查询面）也必须存在',
    ).toBe(true)
  })

  test('负对照：被裁能力的命令在嵌入里被**结构化拒绝**（不是 UI 悄悄消失）', async ({ page }) => {
    test.setTimeout(240_000)
    await waitEmbedProbe(page)

    const outcome = (await page.evaluate(() => {
      const p = (window as any).__lk_embed__.probes()[0]
      const ctxId = p.contextId()
      const pick = (o: any) =>
        o === null || o === undefined
          ? null
          : { status: String(o.status), code: o.error?.code === undefined ? null : String(o.error.code) }
      return {
        addObject: pick(p.attemptCommand({ kind: 'addObject', contextId: ctxId, objectType: 'block' })),
        setProperty: pick(
          p.attemptCommand({
            kind: 'setProperty',
            refs: [{ owner: { kind: 'object', id: 'ghost' }, property: 'name' }],
            value: 'x',
          }),
        ),
        setTime: pick(p.attemptCommand({ kind: 'setTime', contextId: ctxId, time: { frame: 0, fps: 20 } })),
        setChannelValue: pick(
          p.attemptCommand({ kind: 'setChannelValue', contextId: ctxId, channel: 'tier', value: 3 }),
        ),
      }
    })) as Record<string, { status: string; code: string | null } | null>

    console.log('[embed-assembly-negative] ' + JSON.stringify(outcome))

    // ── 负对照：两条被裁能力的命令都必须被内核**结构化拒绝** ──
    expect(outcome.addObject, 'addObject 必须走到内核并被拒（null = 写入口没接上，判红）').not.toBeNull()
    expect(outcome.addObject!.status).toBe('rejected')
    expect(outcome.addObject!.code, '拒绝原因必须是能力不足（UnsupportedOperation）').toBe('UnsupportedOperation')

    expect(outcome.setProperty, 'setProperty 必须走到内核并被拒').not.toBeNull()
    expect(outcome.setProperty!.status).toBe('rejected')
    expect(outcome.setProperty!.code).toBe('UnsupportedOperation')

    // ── 正对照：嵌入能力集里的命令**不得**被能力拒绝（证明上两条不是"入口坏了"）──
    expect(outcome.setTime, 'setTime 必须仍可用（Q2：播放动画）').not.toBeNull()
    expect(outcome.setTime!.status, '时间定位不得被拒').not.toBe('rejected')
    expect(outcome.setChannelValue, 'setChannelValue 必须仍可用（Q2：通道）').not.toBeNull()
    expect(outcome.setChannelValue!.status, '通道取值不得被拒').not.toBe('rejected')
  })
})