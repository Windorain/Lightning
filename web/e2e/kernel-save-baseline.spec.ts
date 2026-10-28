/**
 * **保存后干净**（正式保存基线在保存成功时推进）
 *
 * ## 判据要钉的语义（SPEC §9:293 + §6:208 + §8:285）
 *
 * 「保存 S0 期间可以继续编辑到 S1；成功结果只证明 S0 已保存」——
 * 即一次**成功的保存**必须让"当前内容 vs 保存基线"的关系变成"相同"（干净），
 * 而不是继续报脏。脏状态由内容与基线的语义关系决定，不由单调计数决定（§6:208）。
 *
 * ## 本包新增的入口：wiki-profile 服务
 *
 * 三条生产保存路径分属**两个外壳 profile**：
 *
 *   OPERATOR_SAVE_PROJECT（保存工程）  → workbench 文件菜单（主服务，PLAYWRIGHT_PORT）
 *   OPERATOR_SAVE_FILE（保存到文件）   → workbench 文件菜单（wiki 菜单以 Wiki 三项取代它）
 *   OPERATOR_DOCUMENT_SAVE（Wiki 保存）→ wiki 文件菜单（`wiki.upload` 能力 + `mw.Api`）
 *
 * ⇒ 同一次运行起**两个** dev server（`playwright.config.ts` 的 webServer 数组）：
 * 主槽 = workbench profile，主槽 +1 = wiki profile（同一份 vite 配置、同一条
 * `/__tree__` 身份核验；见 `e2e/tree-identity.ts` 与 `e2e/global-setup.ts`）。
 * 于是 S1 的三条路径在**同一次** `test:e2e:tree` 里都被真实走过，没有"跳过"。
 *
 * ## 判据纪律
 *
 * - **输入来自生产路径**：真实菜单点击（文件 → 保存工程 / 保存到文件 / 保存到 Wiki）
 *   → 浏览器真实下载（前两条）/ 真实 `mw.Api` 编辑请求（Wiki 路，`e2e/helpers/wiki/wikiSandbox`
 *   扮演远端，**记录**写出的正文）→ 落盘到系统临时目录（不落仓库树）；装载走生产算子
 *   （OPERATOR_OPEN_SCENE + File / OPERATOR_DOCUMENT_LOAD + wiki-data）。
 * - **测量前挪离默认值**：保存前必须有**真实编辑**（逐格说明改一格），且断言
 *   「编辑前=干净、编辑后=脏」两端都有读数 —— 否则"保存后干净"可能只是恒 false 的读面。
 * - **反假绿（三条）**：① 产物/远端请求必须含本次编辑（证明保存真的发生了）；
 *   ② 保存后再改一次必须重新变脏；③ 编辑必须改变内容身份（sha256 不同）。
 * - **保存期间的新编辑仍脏**（SPEC §9:293；S1-e）：远端延迟响应期间插入一次真实编辑，
 *   保存成功后必须**仍脏**（基线取的是请求捕获的 S0），再次保存才干净。
 */

import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

import { gotoWorkbench, injectSceneDocumentOk, waitForViewportMounted } from './helpers/multiblock/harness'
import {
  fixturePath,
  firstAnnotatedCell,
  innerDocOf,
  innerDocOfText,
  saveViaFileMenu,
  saveViaWikiMenu,
  TOOLTIP_FIELD,
  selectCell,
  writeField,
  readFixtureText,
  copyFixtureTo,
} from './helpers/saveReopen'
import { m8CaseDir } from './helpers/recovery/faults'
import { gotoWikiWorkbench, installWikiSandbox } from './helpers/wiki/wikiSandbox'

const FIXTURE = 'structuredata-exported-envelope.json'
/** e2e 里这份"远端页面"的结构名（`Data:Structures/<BASE>.json`）。 */
const WIKI_BASE = 'E2E-Structure-Save'
const WIKI_INDEX_TITLE = `Data:Structures/${WIKI_BASE}.json`

/** 打开工作台 → 真实文件菜单装载夹具副本 → 等真实视口挂载。 */
async function openFixture(page: import('@playwright/test').Page, inputCopy: string): Promise<void> {
  await gotoWorkbench(page)
  await page.waitForFunction(() => typeof (window as any).__p7_input__?.counters === 'function', undefined, {
    timeout: 30_000,
  })
  await injectSceneDocumentOk(page, JSON.parse(fs.readFileSync(inputCopy, 'utf8')), FIXTURE)
  await waitForViewportMounted(page)
}

/** 产物的内容身份（页面内 sha256；保存前后"内容真的变了/没变"的机械读数）。 */
async function contentDigest(page: import('@playwright/test').Page): Promise<string> {
  return (await page.evaluate(async () => {
    const text = JSON.stringify((window as any).__vm__.plainForSave().plain)
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    return [...new Uint8Array(d)].map((v) => v.toString(16).padStart(2, '0')).join('')
  })) as string
}

/** 生产脏读面（Context#kernelDirty —— 由内容与保存基线的关系派生）。 */
async function kernelDirty(page: import('@playwright/test').Page): Promise<boolean | null> {
  return (await page.evaluate(() => (window as any).__vm__.kernelDirty())) as boolean | null
}

/** 保存相关读面的一次性快照（binding / 能力 / Wiki 标记 / 两个保存算子的 poll）。 */
interface SaveFacts {
  sourceId: string
  locator: string
  remoteRevisionId: number | null
  hasWiki: boolean
  dirty: boolean | null
  unsavedMarks: number
  wikiRows: number
  documentSavePoll: boolean | null
  wikiSaveConfirmPoll: boolean | null
}

async function saveFacts(page: import('@playwright/test').Page): Promise<SaveFacts> {
  return (await page.evaluate(() => {
    const vm = (window as any).__vm__
    const binding = vm.getDocumentBinding().value
    const ops = vm.getOperators()
    const pollOf = (id: string): boolean | null => {
      const op = ops.find(id)
      if (!op || typeof op.poll !== 'function') return null
      return Boolean(op.poll(vm))
    }
    return {
      sourceId: String(binding.sourceId),
      locator: String(binding.locator),
      remoteRevisionId: binding.remoteRevisionId === null ? null : Number(binding.remoteRevisionId),
      hasWiki: Boolean(vm.hasCapability?.('wiki.upload')),
      dirty: vm.kernelDirty(),
      unsavedMarks: document.querySelectorAll('.sb-root .sb-unsaved').length,
      wikiRows: document.querySelectorAll('.sb-root .sb-item--link').length,
      documentSavePoll: pollOf('OPERATOR_DOCUMENT_SAVE'),
      wikiSaveConfirmPoll: pollOf('OPERATOR_WIKI_SAVE_CONFIRM'),
    }
  })) as SaveFacts
}

/** wiki-profile 侧装载：走生产算子 `OPERATOR_DOCUMENT_LOAD`（sourceId=wiki-data）。 */
async function loadWikiFixture(page: import('@playwright/test').Page): Promise<void> {
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
}

test.describe('保存后干净（基线推进）', () => {
  test('保存工程 → kernelDirty()=false；保存后再改一次 → 重新为 true', async ({ page }) => {
    test.setTimeout(420_000)
    const out = m8CaseDir('s1-a', test.info().project.name)
    const inputCopy = path.join(out, 'input-copy.json')
    copyFixtureTo(inputCopy)
    const target = firstAnnotatedCell(innerDocOf(inputCopy))

    await openFixture(page, inputCopy)
    await selectCell(page, target.kernel, target.fileIdx)

    // ── ① 前提两端：装载后干净 → 编辑后脏 ──
    expect(await kernelDirty(page), '前提：刚装载（未编辑）必须是干净的（否则"保存后干净"没有起点）').toBe(false)
    const beforeEdit = await contentDigest(page)

    const EDIT = '已保存的编辑'
    await writeField(page, TOOLTIP_FIELD, EDIT)
    expect(await kernelDirty(page), '前提：真实编辑必须让文档变脏（kernelDirty 读面必须有区分力）').toBe(true)
    expect(await contentDigest(page), '前提：真实编辑必须改变内容身份').not.toBe(beforeEdit)

    // ── ② 真实保存：文件菜单 → 保存工程 → 浏览器下载落盘 ──
    const savedPath = path.join(out, 's1-a-saved-project.json')
    const saved = await saveViaFileMenu(page, '保存工程', savedPath)
    expect(saved.bytes, '前提：保存产物不得为空（保存真的发生了）').toBeGreaterThan(0)
    const onDisk = fs.readFileSync(savedPath, 'utf8')
    expect(onDisk, '前提：磁盘产物必须含本次编辑（否则"干净"可能只是保存根本没做）').toContain(EDIT)

    const afterSave = await contentDigest(page)
    const dirtyAfterSave = await kernelDirty(page)
    console.log(
      '[save-baseline-a] bytes=' + saved.bytes +
        ' digestBefore=' + beforeEdit.slice(0, 12) +
        ' digestAfter=' + afterSave.slice(0, 12) +
        ' kernelDirty(after save)=' + String(dirtyAfterSave),
    )

    // ── ③ 主判据：保存成功 ⇒ 干净 ──
    expect(
      dirtyAfterSave,
      '⚠️ S1/D1：保存工程成功后 kernelDirty() 必须为 false（基线必须随保存成功推进；当前实现只写盘、不推 B1）',
    ).toBe(false)
    // 保存是"记录已保存关系"，不是"改内容"：产物内容不得被这次保存改写
    expect(afterSave, '保存不得改变当前内容身份（保存不是编辑）').toBe(await contentDigest(page))

    // ── ④ 反假绿：保存干净之后再一次编辑，必须重新变脏 ──
    const UNSAVED = '未保存的第二改'
    await writeField(page, TOOLTIP_FIELD, UNSAVED)
    expect(await kernelDirty(page), '反假绿：保存后再编辑必须重新变脏（证明"干净"不是恒真读面）').toBe(true)
  })

  test('保存到文件（第二条真实保存路径）→ kernelDirty()=false', async ({ page }) => {
    test.setTimeout(420_000)
    const out = m8CaseDir('s1-b', test.info().project.name)
    const inputCopy = path.join(out, 'input-copy.json')
    copyFixtureTo(inputCopy)
    const target = firstAnnotatedCell(innerDocOf(inputCopy))

    await openFixture(page, inputCopy)
    await selectCell(page, target.kernel, target.fileIdx)

    const EDIT = '保存到文件的编辑'
    await writeField(page, TOOLTIP_FIELD, EDIT)
    expect(await kernelDirty(page), '前提：真实编辑必须让文档变脏').toBe(true)

    const savedPath = path.join(out, 's1-b-saved-plain.json')
    const saved = await saveViaFileMenu(page, '保存到文件', savedPath)
    expect(saved.bytes, '前提：保存产物不得为空').toBeGreaterThan(0)
    expect(fs.readFileSync(savedPath, 'utf8'), '前提：磁盘产物必须含本次编辑').toContain(EDIT)

    const dirty = await kernelDirty(page)
    console.log('[save-baseline-b] bytes=' + saved.bytes + ' kernelDirty(after save)=' + String(dirty))
    expect(
      dirty,
      '⚠️ S1/D1：保存到文件成功后 kernelDirty() 必须为 false（当前实现只 downloadJson，不推基线）',
    ).toBe(false)
  })

  test('保存不产生可重复提交的空编辑：两次保存产物逐字相同 + 第二次保存时脏状态已为 false', async ({ page }) => {
    test.setTimeout(420_000)
    const out = m8CaseDir('s1-c', test.info().project.name)
    const inputCopy = path.join(out, 'input-copy.json')
    copyFixtureTo(inputCopy)
    const target = firstAnnotatedCell(innerDocOf(inputCopy))

    await openFixture(page, inputCopy)
    await selectCell(page, target.kernel, target.fileIdx)
    const EDIT = '重复保存的内容'
    await writeField(page, TOOLTIP_FIELD, EDIT)

    const first = path.join(out, 's1-c-save-1.json')
    const second = path.join(out, 's1-c-save-2.json')
    await saveViaFileMenu(page, '保存工程', first)

    // 保存后**没有任何编辑**，再保存一次：产物必须与第一次逐字相同。
    await saveViaFileMenu(page, '保存工程', second)

    const facts = await saveFacts(page)
    const a = fs.readFileSync(first, 'utf8')
    const b = fs.readFileSync(second, 'utf8')
    console.log(
      '[save-baseline-c] sameBytes=' + String(a === b) +
        ' kernelDirty=' + String(facts.dirty) +
        ' saveProjectPoll=' + String(facts.documentSavePoll),
    )

    // ① 空编辑不产生新内容（这一半与脏状态无关，今天也应该成立）
    expect(a, '两次保存之间没有编辑 ⇒ 产物必须逐字相同（保存不得引入新内容）').toBe(b)
    // ② 「保存命令仍可重复提交」的用户可见出口 = 脏状态 + poll 的 kernelDirty 项
    expect(
      facts.dirty,
      '⚠️ S1/D1：保存后再保存时脏状态必须已是 false（否则 Wiki 路的 poll 允许对同一内容再提交一次空编辑）',
    ).toBe(false)
    // ③ workbench 路径的保存可用性：保存工程在册且**无文档变化时不应报脏**
    expect(facts.documentSavePoll, '登记：保存工程算子必须在册且有 poll（wiki 绑定下才是 false）').not.toBe(null)
    // ④ Wiki 半边**不再**在这里登记为"不可达"：它由 wiki-profile 服务上的保存判据判正
  })

  test('Wiki 保存路 → kernelDirty()=false 且「· 未保存」消失（wiki-profile 服务）', async ({ page }) => {
    test.setTimeout(420_000)
    const out = m8CaseDir('s1-d', test.info().project.name)
    fs.mkdirSync(out, { recursive: true })
    const target = firstAnnotatedCell(innerDocOf(fixturePath()))

    const wiki = await installWikiSandbox(page, {
      indexTitle: WIKI_INDEX_TITLE,
      indexContent: readFixtureText(),
    })
    await gotoWikiWorkbench(page)
    await loadWikiFixture(page)
    await selectCell(page, target.kernel, target.fileIdx)

    // ── ① 前提：wiki 绑定 + 干净 + Wiki 行在 + 无「未保存」标记 ──
    const loaded = await saveFacts(page)
    expect(loaded.sourceId, '装载必须把绑定设成 wiki-data（否则保存走不到 Wiki 路）').toBe('wiki-data')
    expect(loaded.locator, '绑定必须指向 wiki 索引页').toBe(WIKI_INDEX_TITLE)
    expect(loaded.dirty, '前提：刚装载（未编辑）必须是干净的').toBe(false)
    expect(loaded.wikiRows, 'wiki 绑定 ⇒ StatusBar 必须渲染 Wiki 行（这是「未保存」标记的宿主）').toBe(1)
    expect(loaded.unsavedMarks, '前提：干净时不得有「· 未保存」标记').toBe(0)

    // ── ② 真实编辑 ⇒ 脏 + 标记出现 ──
    const EDIT = '保存到 Wiki 的编辑'
    await writeField(page, TOOLTIP_FIELD, EDIT)
    const edited = await saveFacts(page)
    expect(edited.dirty, '前提：真实编辑必须让文档变脏').toBe(true)
    expect(edited.unsavedMarks, '前提：脏时 Wiki 行必须出现「· 未保存」').toBe(1)
    expect(edited.documentSavePoll, '前提：有变更时 Wiki 保存命令必须可用').toBe(true)

    // ── ③ 真实入口：文件 → 保存到 Wiki → 确认保存 ──
    const revBefore = loaded.remoteRevisionId
    await saveViaWikiMenu(page)
    await expect
      .poll(async () => (await saveFacts(page)).remoteRevisionId, {
        message: '保存完成后 binding.remoteRevisionId 必须推进（生产保存真的落到远端）',
        timeout: 120_000,
      })
      .not.toBe(revBefore)

    const saved = await saveFacts(page)
    console.log(
      '[save-baseline-d] edits=' + wiki.edits.length +
        ' firstTitle=' + (wiki.edits[0]?.title ?? '(none)') +
        ' firstBytes=' + (wiki.edits[0]?.text.length ?? 0) +
        ' kernelDirty(after save)=' + String(saved.dirty) +
        ' unsavedMarks=' + saved.unsavedMarks +
        ' docSavePoll=' + String(saved.documentSavePoll) +
        ' wikiConfirmPoll=' + String(saved.wikiSaveConfirmPoll),
    )

    // ④ 反假绿：远端**真的**收到了含本次编辑的索引页正文
    //    （信封载荷是 gzip+base64 ⇒ 必须解到内层再比，直查正文永远为假）
    expect(wiki.edits.length, '保存必须发出一次 edit 请求（远端写入真的发生）').toBe(1)
    const posted = JSON.stringify(innerDocOfText(wiki.edits[0]!.text))
    expect(wiki.edits[0]!.title, '写出的页面必须是索引页').toBe(WIKI_INDEX_TITLE)
    expect(posted, '写出的正文必须含本次编辑（否则"干净"可能只是保存没做）').toContain(EDIT)
    expect(wiki.edits[0]!.baserevid, '条件版本：保存必须带上装载时的修订号').toBe(wiki.loadRevisionId)

    // ── ⑤ 主判据：保存成功 ⇒ 干净 + Wiki「· 未保存」消失 ──
    expect(
      saved.dirty,
      '⚠️ S1/D1：保存到 Wiki 成功后 kernelDirty() 必须为 false（基线必须随保存成功推进）',
    ).toBe(false)
    expect(saved.unsavedMarks, '⚠️ S1/D1：保存成功后 Wiki 行的「· 未保存」必须消失').toBe(0)
    expect(saved.wikiRows, '反假绿：Wiki 行本身仍须在场（消失的是标记，不是整行）').toBe(1)

    // ── ⑥ 空编辑不可重复提交（既有缺陷形态）──
    expect(
      saved.documentSavePoll,
      '⚠️ S1/D1：干净状态下 Wiki 保存命令必须不可用（poll=false），否则可重复提交空编辑 revision',
    ).toBe(false)
    expect(saved.wikiSaveConfirmPoll, '⚠️ S1/D1：保存确认入口在干净状态下也必须不可用').toBe(false)
    // 直接提交一次：不得打开保存模态（"提交即 unchanged"的用户可见形态）
    const opened = await page.evaluate(() => {
      const vm = (window as any).__vm__
      const r = vm.getOperators().invoke(vm, 'OPERATOR_WIKI_SAVE_CONFIRM')
      return { result: String(r), modal: String(vm.wm.chrome.wikiUi?.modal?.value ?? '') }
    })
    expect(opened.modal, '干净状态下提交保存命令不得打开保存模态（否则空编辑可被重复提交）').not.toBe('save-confirm')
    console.log('[save-baseline-d] invokeOnClean=' + JSON.stringify(opened))

    // ── ⑦ 反假绿：再改一次必须重新变脏 ──
    await writeField(page, TOOLTIP_FIELD, '保存到 Wiki 后未保存的第二改')
    expect(await kernelDirty(page), '反假绿：保存后再编辑必须重新变脏').toBe(true)
  })

  test('保存期间插入新编辑 ⇒ 保存成功后仍脏（基线取请求捕获的文档）', async ({ page }) => {
    test.setTimeout(420_000)
    const out = m8CaseDir('s1-e', test.info().project.name)
    fs.mkdirSync(out, { recursive: true })
    const target = firstAnnotatedCell(innerDocOf(fixturePath()))

    // 远端 edit 延迟 1.5s：给"保存**期间**用户继续编辑"留出真实窗口。
    const wiki = await installWikiSandbox(page, {
      indexTitle: WIKI_INDEX_TITLE,
      indexContent: readFixtureText(),
      editDelayMs: 1_500,
    })
    await gotoWikiWorkbench(page)
    await loadWikiFixture(page)
    await selectCell(page, target.kernel, target.fileIdx)

    const S0_EDIT = '保存前的内容'
    await writeField(page, TOOLTIP_FIELD, S0_EDIT)
    expect(await kernelDirty(page), '前提：编辑后必须是脏的').toBe(true)

    const revBefore = (await saveFacts(page)).remoteRevisionId
    await saveViaWikiMenu(page)
    // 等到远端**收到**了这次 edit（响应仍被延迟）⇒ 保存确实在途
    await expect
      .poll(() => wiki.edits.length, { message: '保存请求必须已到远端（此时响应被延迟）', timeout: 60_000 })
      .toBe(1)

    // ⚠️ 保存在途时继续编辑到 S1（SPEC §9:293 允许且必须允许）
    const S1_EDIT = '保存期间的第二次编辑'
    await writeField(page, TOOLTIP_FIELD, S1_EDIT)
    expect(await kernelDirty(page), '前提：保存在途时编辑 ⇒ 仍脏').toBe(true)

    // 等这次保存结算完成
    await expect
      .poll(async () => (await saveFacts(page)).remoteRevisionId, {
        message: '在途保存必须完成结算',
        timeout: 120_000,
      })
      .not.toBe(revBefore)

    const afterSave = await saveFacts(page)
    const postedS0 = JSON.stringify(innerDocOfText(wiki.edits[0]!.text))
    console.log(
      '[save-baseline-e] kernelDirty(after save with in-flight edit)=' + String(afterSave.dirty) +
        ' unsavedMarks=' + afterSave.unsavedMarks +
        ' postedContainsS0=' + String(postedS0.includes(S0_EDIT)) +
        ' postedContainsS1=' + String(postedS0.includes(S1_EDIT)),
    )

    // ⑤ 主判据：成功只证明 S0 已保存 ⇒ S1 仍脏
    expect(
      afterSave.dirty,
      '⚠️ S1/D1：保存期间的新编辑必须仍然脏（基线取该请求捕获的 S0，不是"当前版本"）',
    ).toBe(true)
    expect(afterSave.unsavedMarks, '「· 未保存」必须仍在（保存没有覆盖保存期间的新编辑）').toBe(1)
    // 且写出去的确实是 S0（不是 S1）——"产物 = 捕获的快照"这一半
    expect(postedS0, '写出的正文必须是 S0（保存捕获的快照）').toContain(S0_EDIT)
    expect(postedS0, '写出的正文不得含保存期间的 S1 编辑').not.toContain(S1_EDIT)

    // ⑥ 再保存一次（这次没有并发编辑）⇒ 干净
    await saveViaWikiMenu(page)
    await expect
      .poll(async () => (await saveFacts(page)).unsavedMarks, {
        message: '第二次保存后「· 未保存」必须消失',
        timeout: 120_000,
      })
      .toBe(0)
    const clean = await saveFacts(page)
    expect(clean.dirty, '第二次保存（无并发编辑）成功后必须干净').toBe(false)
    expect(wiki.edits.length, '两次保存 ⇒ 两次 edit').toBe(2)
    expect(JSON.stringify(innerDocOfText(wiki.edits[1]!.text)), '第二次写出的正文必须含 S1 编辑').toContain(S1_EDIT)
  })
})
