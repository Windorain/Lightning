/**
 * 文档绑定的**浏览器棘轮**：Wiki A 正式装载 → 本地 B 经生产入口接管 → 保存门关闭。
 *
 * ## 判据（全部在真实 wiki-profile 服务上）
 *
 * | 步 | 事实 |
 * |---|---|
 * | A | 生产 `OPERATOR_DOCUMENT_LOAD`（sourceId=wiki-data）建立 wiki 绑定（locator/revision/基线） |
 * | B | 生产 `OPERATOR_OPEN_SCENE` 接管本地文档：文件名 / 工作区 / **产物 id** 先证明 B 真的换了，再看绑定四字段都不再来自 A |
 * | 门 | 「保存到 Wiki」native disabled，原因**指向另存为**（不是"没有可审计变更"）；「另存为 Wiki 结构」可用 |
 * | 零动作 | 对不可用项派发 click：不打开模态、不发任何远端请求、不产生 edit、不下载 |
 *
 * ## 远端与边界
 *
 * 远端由 `helpers/wiki/wikiSandbox` 扮演并**记录**请求（只读夹具，不写真实 Wiki）。
 * 所有装载/菜单/绑定都是生产实现；本 spec 不执行另存为的写入，只判它可用。
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

import { injectSceneDocumentOk, waitForViewportMounted } from './helpers/multiblock/harness'
import { caseDir, fixturePath, saveViaFileMenu, readFixtureText } from './helpers/saveReopen'
import { gotoWikiWorkbench, installWikiSandbox } from './helpers/wiki/wikiSandbox'
import { blockPaletteEntryKey } from '@/domain/blockGeometry'

const FILE_MENU = '.wb-menubar .ux-menu-btn'
const SAVE_TO_WIKI = '.ux-menu-item[data-op-id="OPERATOR_WIKI_SAVE_CONFIRM"]'
const SAVE_AS = '.ux-menu-item[data-op-id="OPERATOR_WIKI_SAVE_AS"]'
const MODAL_PRIMARY = '.wiki-modal__primary'

const WIKI_BASE = 'W441-DocumentBindingTakeover'
const WIKI_INDEX_TITLE = `Data:Structures/${WIKI_BASE}.json`
const LOCAL_BASE = 'w441-local.json'



/**
 * **真实主编辑内容**：经生产内核命令 `setCellIdentity` 只改一格方块身份。
 *
 * 不碰 tooltip/标题/注解等"可摘要字段" —— 这是摘要草稿为 `null`、而 Wiki 远端
 * 确实陈旧的场景。选择已存在的非空气格（内核的格写命令要求键已在 `cells` 表中）。
 */
async function editOneCellIdentity(page: Page): Promise<void> {
  const facts = (await page.evaluate(() => {
    const vm = (window as any).__vm__
    const plain = vm.plainForSave().plain as Record<string, unknown>
    const grid = plain.cellGrid as number[][][]
    const palette = plain.blockPalette as Array<Record<string, unknown>>
    const rows = grid[0]!.length
    for (let z = 0; z < grid.length; z++) {
      for (let row = 0; row < grid[z]!.length; row++) {
        for (let col = 0; col < grid[z]![row]!.length; col++) {
          const idx = grid[z]![row]![col]!
          const current = palette[idx]
          if (idx <= 0 || current === undefined) continue
          const nextIdx = palette.findIndex(
            (e, i) =>
              i !== idx &&
              e.registryId !== current.registryId &&
              typeof e.registryId === 'string' &&
              e.registryId.startsWith('minecraft:'),
          )
          if (nextIdx < 0) continue
          return { cell: { x: col, y: rows - 1 - row, z }, next: palette[nextIdx]! }
        }
      }
    }
    return null
  })) as { cell: { x: number; y: number; z: number }; next: Record<string, unknown> } | null
  expect(facts, '前提：Wiki 夹具里必须有一个可换身份的非空气格').not.toBeNull()
  if (facts === null) return
  const identity = {
    name: String(facts.next.registryId).replace(/^minecraft:/, ''),
    paletteRef: blockPaletteEntryKey(facts.next as never),
    ...(typeof facts.next.meta === 'number' ? { meta: facts.next.meta } : {}),
  }
  const settled = (await page.evaluate(
    (input) => {
      const vm = (window as any).__vm__
      const session = vm.requireKernelSession()
      const ticket = session.submit({
        kind: 'setCellIdentity',
        contextId: 'ctx-1',
        cells: [input.cell],
        identity: input.identity,
      })
      session.drain()
      // 与生产 `Context#submitContentEdit` 同序：内核写 → legacy 投影（bump 内容读信号）。
      // 少了这一步，StatusBar 的 computed 不会因内核内容变化而重算。
      vm.syncLegacyFromKernel()
      return (session.settlementOf(ticket) as { status?: string } | null)?.status ?? 'null'
    },
    { cell: facts.cell, identity },
  )) as string
  expect(settled, 'setCellIdentity 必须真的生效（生产内核写命令）').toBe('applied')
}

interface BoundFacts {
  readonly sourceId: string
  readonly locator: string
  readonly remoteRevisionId: number | null
  readonly hasBaseline: boolean
  readonly baselineIsCurrent: boolean
  readonly plainId: string | null
  readonly localFileName: string | null
  readonly workspaceMode: string
  readonly loaded: boolean
  readonly dirty: boolean | null
  readonly modal: string
}

/** 生产读面快照：绑定四字段 + "基线是否就是当前产物" + 文档/文件名。 */
async function boundFacts(page: Page): Promise<BoundFacts> {
  return (await page.evaluate(() => {
    const vm = (window as any).__vm__
    const binding = vm.getDocumentBinding().value
    const plain = vm.plainForSave().plain as Record<string, unknown> | null
    const baselineCurrent =
      binding.saveBaseline !== null &&
      plain !== null &&
      JSON.stringify(binding.saveBaseline) === JSON.stringify(plain)
    return {
      sourceId: String(binding.sourceId),
      locator: String(binding.locator),
      remoteRevisionId:
        binding.remoteRevisionId === null ? null : Number(binding.remoteRevisionId),
      hasBaseline: binding.saveBaseline !== null,
      baselineIsCurrent: baselineCurrent,
      plainId: plain === null ? null : String((plain as any).id ?? ''),
      localFileName: vm.getLocalFileName().value === null ? null : String(vm.getLocalFileName().value),
      workspaceMode: String(vm.getWorkspaceMode().value),
      loaded: Boolean(vm.hasLoadedDocument()),
      dirty: vm.kernelDirty(),
      modal: String(vm.wm.chrome.wikiUi?.modal?.value ?? ''),
    }
  })) as BoundFacts
}

async function openFileMenu(page: Page): Promise<void> {
  await page.locator(FILE_MENU, { hasText: '文件' }).first().click()
  await expect(page.locator('.ux-menu-dropdown')).toBeVisible({ timeout: 10_000 })
}

test.describe('Wiki A → 本地 B：绑定随文档换手，保存门指向另存为', () => {
  test('生产 OPEN_SCENE 接管后旧 Wiki locator/revision/基线退场；保存项灰显且零请求', async ({ page }) => {
    test.setTimeout(420_000)
    test.skip(test.info().project.name !== 'desktop-chrome', '菜单/绑定判据固定在 desktop-chrome')

    const wiki = await installWikiSandbox(page, {
      indexTitle: WIKI_INDEX_TITLE,
      indexContent: readFixtureText(),
    })
    await gotoWikiWorkbench(page)

    // ── A：正式 Wiki 装载（生产算子 → 生产管线 → 生产绑定）──
    await page.evaluate(
      async (title) => {
        await (window as any).__vm__.getOperators().exec('OPERATOR_DOCUMENT_LOAD', {
          sourceId: 'wiki-data',
          title,
        })
      },
      WIKI_BASE,
    )
    await waitForViewportMounted(page)

    const wikiA = await boundFacts(page)
    expect(wikiA.sourceId, '前提：Wiki 装载必须建立 wiki-data 绑定').toBe('wiki-data')
    expect(wikiA.locator).toBe(WIKI_INDEX_TITLE)
    expect(wikiA.remoteRevisionId, '前提：Wiki 装载必须带入远端 revision').toBe(wiki.loadRevisionId)
    expect(wikiA.hasBaseline, '前提：Wiki 装载必须钉住保存基线').toBe(true)
    expect(wikiA.baselineIsCurrent, '前提：刚装载 = 与基线一致').toBe(true)
    expect(wikiA.dirty).toBe(false)

    // ── B：生产 OPEN_SCENE（与拖放同一条路径）接管**另一份**本地文档 ──
    const localRaw = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'minimal-v2.json'), 'utf8'),
    ) as Record<string, unknown>
    await injectSceneDocumentOk(page, localRaw, LOCAL_BASE)
    await waitForViewportMounted(page)
    await expect
      .poll(async () => (await boundFacts(page)).localFileName, {
        message: '生产入口必须先证明本地 B 真的接管了文档',
        timeout: 30_000,
      })
      .toBe(LOCAL_BASE)

    const localB = await boundFacts(page)
    // ① B 接管：文件名、工作区、产物身份都与 A 不同。
    expect(localB.workspaceMode, '工作区模式必须换成 local-file').toBe('local-file')
    expect(localB.plainId, '产物 id 必须是本地夹具，不是 A 的信封').toBe(String(localRaw.id))
    expect(localB.plainId, 'B 的产物身份不得等于 A').not.toBe(wikiA.plainId)
    expect(localB.loaded).toBe(true)
    expect(localB.dirty).toBe(false)

    // ② 绑定不再来自 A：四个字段逐个断。
    expect(localB.sourceId, 'sourceId 不得仍是 wiki-data').toBe('local-file')
    expect(localB.locator, 'locator 不得仍是 A 的 Wiki 页').toBe(LOCAL_BASE)
    expect(localB.locator).not.toBe(WIKI_INDEX_TITLE)
    expect(localB.remoteRevisionId, 'remoteRevisionId 不得仍是 A 的远端修订').toBeNull()
    expect(localB.hasBaseline, '基线必须钉到 B 的当前产物').toBe(true)
    expect(localB.baselineIsCurrent, 'B 刚打开 = 与基线一致').toBe(true)

    // ── 保存门：不可用，且原因**必须**指向另存为（不是"没有可审计变更"）──
    let downloads = 0
    page.on('download', () => { downloads += 1 })
    const requestsBefore = wiki.requests()

    await openFileMenu(page)
    const save = page.locator(SAVE_TO_WIKI)
    await expect(save, '"保存到 Wiki"必须在菜单里可见（不许悄悄消失）').toHaveCount(1)
    await expect(save, '本地文档上保存到 Wiki 必须 native disabled').toBeDisabled()
    expect(await save.getAttribute('aria-disabled')).toBe('true')
    const reason = (await save.getAttribute('data-unavailable-reason')) ?? ''
    expect(reason, '原因必须说清当前文档不是 Wiki 载入的').toContain('Wiki')
    expect(reason, '下一步必须指向另存为').toContain('另存为 Wiki 结构')
    expect(reason, '不得把"非 Wiki 文档"说成"没有可审计变更"').not.toContain('没有可审计的变更')
    expect((await save.getAttribute('title')) ?? '', 'title 必须带同一句原因').toContain(reason)

    const saveAs = page.locator(SAVE_AS)
    await expect(saveAs, '另存为必须是可用的下一步（正对照）').toBeEnabled()
    expect(await saveAs.getAttribute('data-unavailable-reason')).toBeNull()

    // ── 零动作：派发 click 也不执行（不打开模态 / 不发请求 / 不写 Wiki / 不下载）──
    await save.dispatchEvent('click')
    await page.waitForTimeout(500)
    expect((await boundFacts(page)).modal, '点击不可用项不得打开保存确认模态').toBe('')
    expect(await page.locator(MODAL_PRIMARY).count(), '不得出现任何模态主按钮').toBe(0)
    expect(wiki.requests(), '点击不可用项不得发出任何远端请求').toBe(requestsBefore)
    expect(wiki.edits.length, '不得产生 edit（不写 Wiki）').toBe(0)
    expect(downloads, '这条命令不得产生浏览器下载').toBe(0)

    // 反假绿：保存项灰显不是"整条菜单废了"——另存为仍在同一菜单里。
    await expect(page.locator(SAVE_AS), '另存为必须在同一份菜单里可用').toBeEnabled()
  })

  test('cellGrid-only：本地保存后 StatusBar 仍「未保存」、gate 仍开；mock Wiki 保存后干净', async ({ page }) => {
    test.setTimeout(420_000)
    test.skip(test.info().project.name !== 'desktop-chrome', '菜单/底栏判据固定在 desktop-chrome')

    const wiki = await installWikiSandbox(page, {
      indexTitle: WIKI_INDEX_TITLE,
      indexContent: readFixtureText(),
    })
    await gotoWikiWorkbench(page)
    await page.evaluate(
      async (title) => {
        await (window as any).__vm__.getOperators().exec('OPERATOR_DOCUMENT_LOAD', {
          sourceId: 'wiki-data',
          title,
        })
      },
      WIKI_BASE,
    )
    await waitForViewportMounted(page)

    const clean = await boundFacts(page)
    expect(clean.sourceId).toBe('wiki-data')
    expect(clean.baselineIsCurrent, '前提：刚装载 = 干净').toBe(true)
    await expect(page.locator('.sb-unsaved'), '干净时不得有「未保存」').toHaveCount(0)

    // ── 真实主编辑：只改一格方块身份（不碰任何可摘要字段）──
    await editOneCellIdentity(page)
    const edited = await boundFacts(page)
    expect(edited.baselineIsCurrent, '前提：cellGrid-only 后基线必须落后').toBe(false)
    await expect(page.locator('.sb-unsaved'), 'cellGrid-only 后必须出现「未保存」').toHaveCount(1)

    // ── 本地保存：B1 clean，但 Wiki 远端仍落后 ──
    //
    // wiki-profile 的文件菜单**没有**「保存到文件」（那是非 wiki 外壳的项，见
    // `workbench/ux/panels/menuBar` 的 fileItems 分支）；这里用真实菜单里的
    // 「保存工程」走同一条本地保存结算。SAVE_FILE 与 SAVE_PROJECT 各自的
    // "只推进本地绑定基线"由生产链单测分别覆盖。
    const dest = path.join(caseDir('s441-cellgrid', test.info().project.name), 's441-local-project.json')
    await saveViaFileMenu(page, '保存工程', dest)
    expect(await page.evaluate(() => (window as any).__vm__.kernelDirty()), 'B1 应已 clean').toBe(false)
    const afterLocal = await boundFacts(page)
    expect(afterLocal.locator, '本地保存不得换 Wiki locator').toBe(clean.locator)
    expect(afterLocal.remoteRevisionId, '本地保存不得推 Wiki revision').toBe(clean.remoteRevisionId)
    expect(afterLocal.baselineIsCurrent, '本地保存不得推进 Wiki 基线').toBe(false)
    expect(wiki.edits.length, '本地保存不得写 Wiki').toBe(0)
    await expect(page.locator('.sb-unsaved'), 'B1 clean 但 Wiki 页未写 ⇒ 仍须「未保存」').toHaveCount(1)

    // ── 保存门仍可用；确认模态用**通用摘要**（草稿为 null 也不能拒绝）──
    await openFileMenu(page)
    const save = page.locator(SAVE_TO_WIKI)
    await expect(save, 'Wiki 远端落后 ⇒ 保存到 Wiki 必须仍可用').toBeEnabled()
    await save.click()
    const confirm = page.locator(MODAL_PRIMARY, { hasText: '确认保存' })
    await expect(confirm, '全量有差异时必须打开保存确认').toBeVisible({ timeout: 20_000 })
    const summary = await page.locator('.wiki-modal__textarea').inputValue()
    expect(summary, '摘要草稿为 null 时必须退化为通用摘要').toContain('内容更新')
    await confirm.click()

    // ── mock Wiki 保存成功 ⇒ B2 推进、全量 diff 为空、未保存消失、gate 关闭 ──
    await expect.poll(() => wiki.edits.length, { message: '确认后必须真的发出一次 mock Wiki 写' }).toBe(1)
    await expect(page.locator('.sb-unsaved'), 'Wiki 保存成功后「未保存」必须消失').toHaveCount(0)
    const saved = await boundFacts(page)
    expect(saved.baselineIsCurrent, 'Wiki 保存成功后基线 = 当前产物').toBe(true)
    await openFileMenu(page)
    const saveAfter = page.locator(SAVE_TO_WIKI)
    await expect(saveAfter, 'Wiki 保存成功后保存项必须不可用').toBeDisabled()
    expect((await saveAfter.getAttribute('data-unavailable-reason')) ?? '').toContain('没有可审计的变更')
    expect(wiki.edits.length, '本次会话只允许一次 Wiki 写').toBe(1)
  })
})
