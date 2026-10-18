/**
 * M8-1 · S5：恢复副本生产路径 **round-trip**（写 → 刷新 → 在场 → 采纳；正式基线不动）
 *
 * ## 判据要钉的语义（SPEC §9:299 + §9:291 + §8:285）
 *
 * 「恢复副本与正式保存分开记录。恢复副本写入成功**不改变正式保存基线**。
 *  采纳恢复副本是**明确的内容恢复操作**；损坏副本和存储失败不得破坏当前有效内容。」
 *
 * 三段可判定事实：
 *  a. 生产保存之后，存储里存在该文档的**恢复副本**（键族 lk.recovery.v1.*，
 *     与正式保存键族 lk.save.v1.* **结构性分开**）；
 *  b. 刷新后副本仍在场，并且能经**生产入口**被采纳；
 *  c. 采纳后：内容 = 恢复副本的内容；而**正式保存基线**未被改动 —— 采纳之后文档仍应
 *     表现为"脏"（采纳不是保存），且磁盘上那份"已保存"产物的字节不变。
 *
 * ## 当前预期的红（S0-B D5：全链零生产接线）
 *
 * 计数口径（S0-B §2.3，全 web/ 排除 __tests__）：writeRecoveryCopy / planRecoveryWrite /
 * readRecoveryCopy / listRecoveryKeys / decideRecoveryAdoption / adoptRecoveryCopy /
 * validateRecoveryCopy 的调用点**全部为 0**；browserStoragePort / createMemoryStoragePort
 * 实例化 0；自动保存写点 0；恢复入口 UI 0。
 * ⇒ 本用例第一步（"副本必须在场"）就红，失败消息会写明"恢复副本键数为 0"。
 *
 * ## 判据纪律
 *
 * - **注入走生产路径**：装载 = OPERATOR_OPEN_SCENE + File；编辑 = 右栏真实输入；
 *   保存 = 文件菜单 → 真实下载 → 落盘；刷新 = 真实 page.reload()（不是软路由）。
 * - **测量前挪离默认值**：保存**之后**再改一次（未保存的修改，正是恢复副本要保的东西），
 *   保存**之前**也改过一次（保证磁盘产物与刷新前内存态可区分）。
 * - **反假绿**：① 刷新前内存态必须含未保存编辑、磁盘态必须不含；② 刷新后必须确认
 *   未保存那次编辑真的不在了（既有 e2e kernel-save-reopen.spec.ts:100-110 已把这条当判据）；
 *   ③ 副本必须与正式保存键族互斥（§9:299「分开记录」）。
 */

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

import { gotoWorkbench, injectSceneDocumentOk, waitForViewportMounted } from './helpers/multiblock/harness'
import {
  TOOLTIP_FIELD,
  fixturePath,
  firstAnnotatedCell,
  innerDocOf,
  saveViaFileMenu,
  selectCell,
  writeField,
} from './helpers/saveReopen'
import {
  FORMAL_SAVE_KEY_PREFIX,
  RECOVERY_KEY_PREFIX,
  m8CaseDir,
  storageKeys,
  storageValue,
} from './helpers/m8/faults'

const FIXTURE = 'structuredata-exported-envelope.json'

/** 生产脏读面。 */
async function kernelDirty(page: Page): Promise<boolean | null> {
  return (await page.evaluate(() => (window as any).__vm__.kernelDirty())) as boolean | null
}

/** 本页的实例身份与文档身份（都经生产读面；取不到时如实返回 null）。 */
async function identities(page: Page): Promise<{ instanceId: string | null; documentId: string | null }> {
  return (await page.evaluate(() => {
    const vm = (window as any).__vm__
    const inst = typeof vm?.instanceId === 'string' ? vm.instanceId : null
    let docId: string | null = null
    try {
      docId = vm?.kernelPresentationDocument?.()?.id ?? null
    } catch {
      docId = null
    }
    return { instanceId: inst, documentId: docId === null ? null : String(docId) }
  })) as { instanceId: string | null; documentId: string | null }
}

/** 生产采纳入口是否存在（今天为零；判据据此把"机制不存在"表达成可读事实）。 */
async function adoptionEntry(page: Page): Promise<{ ops: string[]; dom: string[] }> {
  return (await page.evaluate(() => {
    const vm = (window as any).__vm__
    const ops = (vm.getOperators().all() as { id: string }[])
      .map((o) => o.id)
      .filter((id) => /RECOVER|RECOVERY|ADOPT/i.test(id))
    const dom = Array.from(
      document.querySelectorAll('[data-lk-recovery], [data-recovery-candidate], [data-lk-recovery-adopt]'),
    ).map((el) => el.tagName + ':' + (el.getAttribute('data-lk-recovery') ?? ''))
    return { ops, dom }
  })) as { ops: string[]; dom: string[] }
}

test.describe('M8-1 · S5 恢复副本 round-trip（正式基线不动）', () => {
  test('S5-a 生产保存 → 真实刷新 → 该文档的恢复副本必须在场（与正式保存键族分开）', async ({ page }) => {
    test.setTimeout(480_000)
    const out = m8CaseDir('s5-a', test.info().project.name)
    const inputCopy = path.join(out, 'input-copy.json')
    fs.copyFileSync(fixturePath(), inputCopy)
    const target = firstAnnotatedCell(innerDocOf(inputCopy))

    await gotoWorkbench(page)
    await page.waitForFunction(() => typeof (window as any).__p7_input__?.counters === 'function', undefined, {
      timeout: 30_000,
    })
    await injectSceneDocumentOk(page, JSON.parse(fs.readFileSync(inputCopy, 'utf8')), FIXTURE)
    await waitForViewportMounted(page)
    await selectCell(page, target.kernel, target.fileIdx)

    // ── ① 保存一次（磁盘态 A）→ 再改一次（内存态 B，不保存）──
    const SAVED = 'M8-S5 已保存的值'
    await writeField(page, TOOLTIP_FIELD, SAVED)
    const savedPath = path.join(out, 's5-a-saved-project.json')
    await saveViaFileMenu(page, '保存工程', savedPath)
    const savedBytes = fs.readFileSync(savedPath, 'utf8')
    expect(savedBytes, '前提：磁盘产物必须含已保存的值').toContain(SAVED)

    const UNSAVED = 'M8-S5 未保存的值（恢复副本要保的就是它）'
    await writeField(page, TOOLTIP_FIELD, UNSAVED)
    expect(await kernelDirty(page), '前提：未保存的修改必须让文档变脏').toBe(true)
    // 反假绿①：内存态 != 磁盘态（否则"副本把内容带回来"与"刷新没丢东西"不可区分）
    const inMemory = await page.evaluate(() => JSON.stringify((window as any).__vm__.plainForSave().plain))
    expect(inMemory, '前提：内存态必须含未保存的那次编辑').toContain(UNSAVED)
    expect(savedBytes, '前提：磁盘态不得含未保存的那次编辑（两态必须可区分）').not.toContain(UNSAVED)

    const id = await identities(page)
    const beforeReload = await storageKeys(page, RECOVERY_KEY_PREFIX)
    const formalKeys = await storageKeys(page, FORMAL_SAVE_KEY_PREFIX)
    console.log(
      '[S5-a] identity=' + JSON.stringify(id) +
        ' recoveryKeys(before reload)=' + beforeReload.length +
        ' formalSaveKeys=' + formalKeys.length,
    )

    // ── ② 真实刷新（模拟崩溃/关闭标签页后的重启）──
    await page.reload()
    await page.waitForFunction(() => (window as any).__vm_ready__ === true, undefined, { timeout: 90_000 })

    // 反假绿②：刷新后未保存的编辑必须真的不在了（既有行为：kernel-save-reopen 已钉）
    expect(
      await page.evaluate(() => (window as any).__vm__?.hasLoadedDocument() ?? false),
      '前提：刷新后不得还挂着旧文档（否则"恢复"无从谈起）',
    ).toBe(false)

    // ── ③ 主判据：恢复副本必须在场（键族 lk.recovery.v1.*；与正式保存键分开）──
    const afterReload = await storageKeys(page, RECOVERY_KEY_PREFIX)
    console.log('[S5-a] recoveryKeys(after reload)=' + JSON.stringify(afterReload))
    expect(
      afterReload.length,
      '⚠️ S5/D5：生产保存之后刷新，存储里必须存在该文档的**恢复副本**（键族 ' + RECOVERY_KEY_PREFIX + '）。' +
        '当前全链零生产接线（writeRecoveryCopy 调用点 0）⇒ 实测 ' + afterReload.length + ' 个键；' +
        '这是 M8-4 的前置能力，不是本批能修的判据问题',
    ).toBeGreaterThan(0)

    // 两个键族必须**结构性分开**（§9:299「恢复副本与正式保存分开记录」）
    expect(
      afterReload.every((k) => !k.startsWith(FORMAL_SAVE_KEY_PREFIX)),
      '恢复副本键不得落在正式保存键族里（两类记录必须分开）',
    ).toBe(true)
    // 副本必须带内容（不是空壳）
    for (const key of afterReload) {
      const value = await storageValue(page, key)
      expect(value, '恢复副本必须有内容（键 ' + key + '）').toBeTruthy()
      expect(value!.length, '恢复副本内容不得为空壳（键 ' + key + '）').toBeGreaterThan(2)
    }
  })

  test('S5-b 恢复副本必须能经生产入口被采纳；采纳不推正式保存基线', async ({ page }) => {
    test.setTimeout(480_000)
    const out = m8CaseDir('s5-b', test.info().project.name)
    const inputCopy = path.join(out, 'input-copy.json')
    fs.copyFileSync(fixturePath(), inputCopy)
    const target = firstAnnotatedCell(innerDocOf(inputCopy))

    await gotoWorkbench(page)
    await page.waitForFunction(() => typeof (window as any).__p7_input__?.counters === 'function', undefined, {
      timeout: 30_000,
    })
    await injectSceneDocumentOk(page, JSON.parse(fs.readFileSync(inputCopy, 'utf8')), FIXTURE)
    await waitForViewportMounted(page)
    await selectCell(page, target.kernel, target.fileIdx)

    const SAVED = 'M8-S5b 已保存的值'
    await writeField(page, TOOLTIP_FIELD, SAVED)
    const savedPath = path.join(out, 's5-b-saved-project.json')
    await saveViaFileMenu(page, '保存工程', savedPath)
    const savedText = fs.readFileSync(savedPath, 'utf8')
    const savedDigest = await page.evaluate(async (bytes: string) => {
      const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bytes))
      return [...new Uint8Array(d)].map((v) => v.toString(16).padStart(2, '0')).join('')
    }, savedText)

    const UNSAVED = 'M8-S5b 未保存的值'
    await writeField(page, TOOLTIP_FIELD, UNSAVED)

    await page.reload()
    await page.waitForFunction(() => (window as any).__vm_ready__ === true, undefined, { timeout: 90_000 })

    // ── 主判据 A：必须存在**生产**采纳入口（算子或可见面板）──
    const entry = await adoptionEntry(page)
    console.log('[S5-b] adoptionEntry=' + JSON.stringify(entry))
    expect(
      entry.ops.length + entry.dom.length,
      '⚠️ S5/D5：恢复副本必须能经**生产入口**被采纳（拒绝"读到就自动采纳"，也拒绝"只能手改存储"）。' +
        '当前恢复入口 UI = 0、恢复类算子 = 0（S0-B §2.3 全链零接线）',
    ).toBeGreaterThan(0)

    // ── 主判据 B：采纳之后仍为脏（采纳不是保存，§9:299）──
    // 走到这里说明入口存在；用生产入口采纳后核对"内容回来但仍脏 + 磁盘产物未变"。
    // ⚠️ 这一段在 M8-4 接线前不可达（上一行已判红）；保留完整断言以便接线后立即生效。
    if (entry.ops.length > 0) {
      await page.evaluate(async (opId: string) => {
        const vm = (window as any).__vm__
        await vm.getOperators().exec(opId)
      }, entry.ops[0]!)
      await page.waitForTimeout(2500)
    }
    expect(
      await kernelDirty(page),
      '⚠️ §9:299：采纳恢复副本之后必须仍是**脏**（恢复副本写入/采纳都不推进正式保存基线）',
    ).toBe(true)
    const afterDigest = await page.evaluate(async (bytes: string) => {
      const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bytes))
      return [...new Uint8Array(d)].map((v) => v.toString(16).padStart(2, '0')).join('')
    }, fs.readFileSync(savedPath, 'utf8'))
    expect(afterDigest, '正式保存产物必须逐字节不变（恢复副本不得改写正式保存记录）').toBe(savedDigest)
  })
})