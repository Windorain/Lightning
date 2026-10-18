/**
 * M8-1 · **S1：保存后干净**（正式保存基线在保存成功时推进）
 *
 * ## 判据要钉的语义（SPEC §9:293 + §6:208 + §8:285）
 *
 * 「保存 S0 期间可以继续编辑到 S1；成功结果只证明 S0 已保存」——
 * 即一次**成功的保存**必须让"当前内容 vs 保存基线"的关系变成"相同"（干净），
 * 而不是继续报脏。脏状态由内容与基线的语义关系决定，不由单调计数决定（§6:208）。
 *
 * ## 当前预期的红（S0-B D1，代码路径已核对）
 *
 * 生产上有**两条**"已保存关系"的承载：B1 = 内核 Document.saveBaseline
 * （domain/document.ts:521-549 completeSave 推进，isDirty 的输入）与 B2 =
 * DocumentBinding.saveBaseline（workbench/document/pipeline#afterDocumentSave 推进，
 * Wiki「· 未保存」标记的输入）。三条生产保存路径**都不推 B1**：
 *
 *   OPERATOR_SAVE_PROJECT（保存工程）   docLifecycleOperators.ts:281-300  推 B1 否 / 推 B2 否
 *   OPERATOR_SAVE_FILE（保存到文件）    docLifecycleOperators.ts:200-217  推 B1 否 / 推 B2 否
 *   OPERATOR_DOCUMENT_SAVE（Wiki 保存） documentIoOperators.ts:41-91      推 B1 否 / 推 B2 是
 *
 * ⇒ 保存后 kernelDirty() 仍为 true（本用例先红），且 Wiki 的「· 未保存」标记
 * （StatusBar.vue:42-47 的 wikiDirty = 摘要差异 || kernelDirty）也消不掉。
 *
 * ## 判据纪律
 *
 * - **输入来自生产路径**：真实菜单点击（文件 → 保存工程 / 保存到文件）→ 浏览器真实下载 →
 *   落盘到 temp/m8/（不落仓库树）；装载走生产算子 OPERATOR_OPEN_SCENE + File。
 * - **测量前挪离默认值**：保存前必须有**真实编辑**（逐格说明改一格），且断言
 *   「编辑前=干净、编辑后=脏」两端都有读数 —— 否则"保存后干净"可能只是恒 false 的读面。
 * - **反假绿（三条）**：① 保存产物在**磁盘**上必须含本次编辑（证明保存真的发生了，
 *   而不是"什么都没做所以干净"）；② 保存后**再改一次**必须重新变脏（证明干净不是恒真）；
 *   ③ 编辑必须改变内容身份（sha256 不同）。
 * - **Wiki 路的可达性（实测登记，不作行为判据）**：本装配（dev server = workbench profile）
 *   **没有** wiki.upload 能力 ⇒ OPERATOR_DOCUMENT_SAVE 的 poll 恒 false
 *   （binding.sourceId 只能是 local-file），StatusBar 也不渲染 Wiki 行。
 *   故「Wiki「· 未保存」标记消失」这一半**在当前 e2e 入口下不可达**，S1-c 用能力读面把这条
 *   登记为可判定事实，并把"需要 wiki-profile e2e 入口"留给 M8-2 的 P4。
 *   不允许用"假装 wiki 绑定"的内部写来伪造这一半（那正是自喂内部函数）。
 */

import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

import { gotoWorkbench, injectSceneDocumentOk, waitForViewportMounted } from './helpers/multiblock/harness'
import {
  fixturePath,
  firstAnnotatedCell,
  innerDocOf,
  saveViaFileMenu,
  TOOLTIP_FIELD,
  selectCell,
  writeField,
} from './helpers/saveReopen'
import { m8CaseDir } from './helpers/m8/faults'

const FIXTURE = 'structuredata-exported-envelope.json'

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

test.describe('M8-1 · S1 保存后干净（基线推进）', () => {
  test('S1-a 保存工程 → kernelDirty()=false；保存后再改一次 → 重新为 true', async ({ page }) => {
    test.setTimeout(420_000)
    const out = m8CaseDir('s1-a', test.info().project.name)
    const inputCopy = path.join(out, 'input-copy.json')
    fs.copyFileSync(fixturePath(), inputCopy)
    const target = firstAnnotatedCell(innerDocOf(inputCopy))

    await openFixture(page, inputCopy)
    await selectCell(page, target.kernel, target.fileIdx)

    // ── ① 前提两端：装载后干净 → 编辑后脏 ──
    expect(await kernelDirty(page), '前提：刚装载（未编辑）必须是干净的（否则"保存后干净"没有起点）').toBe(false)
    const beforeEdit = await contentDigest(page)

    const EDIT = 'M8-S1 已保存的编辑'
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
      '[S1-a] bytes=' + saved.bytes +
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
    const UNSAVED = 'M8-S1 未保存的第二改'
    await writeField(page, TOOLTIP_FIELD, UNSAVED)
    expect(await kernelDirty(page), '反假绿：保存后再编辑必须重新变脏（证明"干净"不是恒真读面）').toBe(true)
  })

  test('S1-b 保存到文件（第二条真实保存路径）→ kernelDirty()=false', async ({ page }) => {
    test.setTimeout(420_000)
    const out = m8CaseDir('s1-b', test.info().project.name)
    const inputCopy = path.join(out, 'input-copy.json')
    fs.copyFileSync(fixturePath(), inputCopy)
    const target = firstAnnotatedCell(innerDocOf(inputCopy))

    await openFixture(page, inputCopy)
    await selectCell(page, target.kernel, target.fileIdx)

    const EDIT = 'M8-S1b 已保存的编辑'
    await writeField(page, TOOLTIP_FIELD, EDIT)
    expect(await kernelDirty(page), '前提：真实编辑必须让文档变脏').toBe(true)

    const savedPath = path.join(out, 's1-b-saved-plain.json')
    const saved = await saveViaFileMenu(page, '保存到文件', savedPath)
    expect(saved.bytes, '前提：保存产物不得为空').toBeGreaterThan(0)
    expect(fs.readFileSync(savedPath, 'utf8'), '前提：磁盘产物必须含本次编辑').toContain(EDIT)

    const dirty = await kernelDirty(page)
    console.log('[S1-b] bytes=' + saved.bytes + ' kernelDirty(after save)=' + String(dirty))
    expect(
      dirty,
      '⚠️ S1/D1：保存到文件成功后 kernelDirty() 必须为 false（当前实现只 downloadJson，不推基线）',
    ).toBe(false)
  })

  test('S1-c 保存不产生可重复提交的空编辑：两次保存产物逐字相同 + Wiki 路可达性登记', async ({ page }) => {
    test.setTimeout(420_000)
    const out = m8CaseDir('s1-c', test.info().project.name)
    const inputCopy = path.join(out, 'input-copy.json')
    fs.copyFileSync(fixturePath(), inputCopy)
    const target = firstAnnotatedCell(innerDocOf(inputCopy))

    await openFixture(page, inputCopy)
    await selectCell(page, target.kernel, target.fileIdx)
    const EDIT = 'M8-S1c 保存一次'
    await writeField(page, TOOLTIP_FIELD, EDIT)

    const first = path.join(out, 's1-c-save-1.json')
    const second = path.join(out, 's1-c-save-2.json')
    await saveViaFileMenu(page, '保存工程', first)

    // 保存后**没有任何编辑**，再保存一次：产物必须与第一次逐字相同。
    // （这一次保存没有携带任何新内容；Wiki 路的"空编辑 revision"在契约上对应同一事实，
    //   其用户可见出口是 DocumentSaveOperator.poll 的 kernelDirty 项。）
    await saveViaFileMenu(page, '保存工程', second)

    const dirty = await kernelDirty(page)
    // Wiki 路可达性：本装配没有 wiki.upload ⇒ StatusBar 不渲染 Wiki 行，
    // OPERATOR_DOCUMENT_SAVE 的 poll 前提（binding.sourceId === wiki-data）在 e2e 下不可达。
    const gate = await page.evaluate(() => {
      const vm = (window as any).__vm__
      const binding = vm.getDocumentBinding().value
      const hasWiki = Boolean(vm.hasCapability?.('wiki.upload'))
      const unsavedMarks = document.querySelectorAll('.sb-root .sb-unsaved').length
      const ops = vm.getOperators().all().map((o: { id: string }) => o.id)
      return {
        hasWiki,
        sourceId: String(binding.sourceId),
        unsavedMarks,
        hasDocumentSaveOp: ops.includes('OPERATOR_DOCUMENT_SAVE'),
      }
    })

    const a = fs.readFileSync(first, 'utf8')
    const b = fs.readFileSync(second, 'utf8')
    console.log(
      '[S1-c] sameBytes=' + String(a === b) +
        ' kernelDirty=' + String(dirty) +
        ' hasWikiUpload=' + String(gate.hasWiki) +
        ' sourceId=' + gate.sourceId +
        ' unsavedMarks=' + gate.unsavedMarks +
        ' hasDocumentSaveOp=' + String(gate.hasDocumentSaveOp),
    )

    // ① 空编辑不产生新内容（这一半与脏状态无关，今天也应该成立）
    expect(a, '两次保存之间没有编辑 ⇒ 产物必须逐字相同（保存不得引入新内容）').toBe(b)
    // ② 「保存命令仍可重复提交」的用户可见出口 = poll 的 kernelDirty 项
    expect(
      dirty,
      '⚠️ S1/D1：保存后再保存时脏状态必须已是 false（否则 Wiki 路的 poll 允许对同一内容再提交一次空编辑）',
    ).toBe(false)
    // ③ 可达性登记（不是行为判据）：本装配没有 wiki.upload ⇒
    //    「Wiki「· 未保存」标记消失」这一半在 e2e 下不可达，需要 wiki-profile 的 e2e 入口（M8-2 P4）。
    expect(
      gate.hasWiki,
      '登记：本装配必须**如实**没有 wiki.upload（若哪天有了，S1 必须补上 Wiki 标记消失的判据）',
    ).toBe(false)
    expect(gate.unsavedMarks, '登记：没有 wiki 绑定 ⇒ StatusBar 不渲染「· 未保存」行（这不是正确性证据）').toBe(0)
    expect(gate.hasDocumentSaveOp, '登记：OPERATOR_DOCUMENT_SAVE 仍注册在册（只是 poll 不可达）').toBe(true)
  })
})
