/**
 * M1 P3 · **保存工程 → 真正刷新 → 打开工程**的真实入口回归（退出判据 1–5）。
 *
 * ## 这条路径此前没有任何走真实入口的判据
 *
 * `adapters/files/__tests__/projectRoundTrip.test.ts` 与
 * `composition/__tests__/r1aProjectFormatProduction.test.ts` 覆盖 codec/composition 往返，
 * 但后者文件头（:24-31）**明文自述**「不声称『UI 上点一下就能跑通』」，且用的是手造
 * `ProjectHost`。本文件补的正是那一层：**UI + 真算子 + 生产 `projectHostOf(ctx)` + 磁盘往返**。
 *
 * ## 零替身（逐条）
 *
 * | 环节 | 走的是 |
 * |---|---|
 * | 装载输入 | `File 菜单 → 打开场景…` → 隐藏 `<input type=file>`（生产 `pickFile()`） |
 * | 编辑 | 右栏生成式 Inspector 的真实 `input`（`data-property` 定位 → `draft.commit`） |
 * | 保存 | `File 菜单 → 保存工程` → 生产 `projectForSave(projectHostOf(ctx))` → 浏览器下载落盘 |
 * | 刷新 | `page.reload()`（真导航；纪元计数判据） |
 * | 重开 | `File 菜单 → 打开工程…` → 给隐藏 input 送**磁盘上那个产物** |
 * | 撤销 | 真实按键 `Control+z`（唯一入口，见 `inputHotkeys`） |
 *
 * ## 为什么 P3-1 不是恒真（退出判据 4）
 *
 * 保存之后**再改一次且不保存**（内存态 = B），随后才 reload + 重开磁盘产物（= A）。
 * ⇒ 断言读到的必须是 A（磁盘），且必须**不是** B（内存）。P3-2 把同一判据用于
 * "不重开"的情形并断言它必须判红 —— 若哪天判据变成恒真，P3-2 先红。
 */

import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  gotoWorkbench,
  navEpochOf,
  VIEWPORT_CANVAS,
  waitForEvaluateReady,
  waitForViewportMounted,
} from './helpers/multiblock/harness'
import {
  annotatedCells,
  fieldOf,
  firstAnnotatedCell,
  fixturePath,
  innerDocOf,
  isDirty,
  kernelAnnotations,
  openViaFileMenu,
  caseDir,
  pressUndo,
  saveViaFileMenu,
  selectCell,
  structureSnapshot,
  TOOLTIP_FIELD,
  undoState,
  writeField,
} from './helpers/saveReopen'

/** 等 `__p7_input__` 只读探针就绪（`WorkbenchRoot.vue` 装配时挂）。 */
async function waitForInputProbe(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(() => typeof (window as any).__p7_input__?.counters === 'function', undefined, {
    timeout: 30_000,
  })
}

test.describe('M1 P3 保存工程 → 刷新 → 重开：真实工作台入口', () => {
  test('P3-1 保存工程 → reload → 打开工程：修改/结构/纹理保留、isDirty=false、重开后可编辑可撤销', async ({ page }) => {
    test.setTimeout(420_000)
    const out = caseDir('p3-1', test.info().project.name)
    // 输入用**副本**（铁律：仓库夹具原件永不被改写/覆盖）
    const inputCopy = path.join(out, 'p3-1-input-copy.json')
    fs.copyFileSync(fixturePath(), inputCopy)
    const target = firstAnnotatedCell(innerDocOf(inputCopy))

    await gotoWorkbench(page)
    await waitForInputProbe(page)
    await openViaFileMenu(page, '打开场景', inputCopy)
    await waitForViewportMounted(page)

    // ── ① 编辑一处可撤销修改（P2 已跑通的路径：带注解格的「单元格 Tooltip」）──
    await selectCell(page, target.kernel, target.fileIdx)
    expect((await fieldOf(page, TOOLTIP_FIELD))!.value, '夹具原件里这一格必须有注解文本').toBe(target.expected)
    const structBefore = await structureSnapshot(page)

    const EDIT = 'P3-1 修改（e2e）'
    await writeField(page, TOOLTIP_FIELD, EDIT)
    expect((await fieldOf(page, TOOLTIP_FIELD))!.value).toBe(EDIT)
    const s1 = await undoState(page)
    expect(s1.canUndo, '前提：编辑必须进内核撤销栈').toBe(true)
    expect(s1.undoLabel, '前提：撤销项必须指向被改的那一格').toContain('cell tooltip @')

    // ── ② 保存工程（File 菜单真实点击 → 下载落盘到 temp，**不落仓库树**）──
    const savedPath = path.join(out, 'p3-1-saved-project.json')
    const saved = await saveViaFileMenu(page, '保存工程', savedPath)
    expect(saved.bytes, '工程产物不得为空').toBeGreaterThan(0)
    // 外部证据：在 Node 里解磁盘产物（不读页面状态）确认它真的带这次修改
    const onDisk = fs.readFileSync(savedPath, 'utf8')
    expect(onDisk, '磁盘产物必须含本次修改的文本（"保存"真的写了盘）').toContain(EDIT)

    // ── ③ 负对照素材：保存后**再改一次、不保存** ⇒ 内存态 B ≠ 磁盘态 A ──
    const UNSAVED = 'P3-1 未保存的第二改（刷新必须把它清掉）'
    await writeField(page, TOOLTIP_FIELD, UNSAVED)
    expect((await fieldOf(page, TOOLTIP_FIELD))!.value).toBe(UNSAVED)
    expect(await isDirty(page), '未保存的第二改必须让文档变脏').toBe(true)

    // ── ④ 真正 reload（不是软路由、不保留内存状态）──
    const epochBefore = navEpochOf(page)
    await page.reload()
    await waitForEvaluateReady(page)
    expect(navEpochOf(page), '判据：reload 必须真的换掉文档（导航纪元必须 +1）').toBeGreaterThan(epochBefore)
    expect(await page.evaluate(() => (window as any).__vm__?.hasLoadedDocument() ?? false), 'reload 后不得还挂着旧文档').toBe(false)

    // ── ⑤ File 菜单 → 打开工程 → 给隐藏 <input type=file> 送**磁盘上那个产物** ──
    await openViaFileMenu(page, '打开工程', savedPath)
    await waitForViewportMounted(page)

    // ── ⑥ 断言：修改保留（且来自磁盘，不是内存）──
    await selectCell(page, target.kernel, target.fileIdx)
    const after = await fieldOf(page, TOOLTIP_FIELD)
    expect(after, '重开后选中同一格必须仍有 Tooltip 字段').not.toBeNull()
    expect(after!.value, '① 修改必须保留 —— 且必须是**磁盘那一份**（A）').toBe(EDIT)
    expect(after!.display, '① 权威显示值（data-input-display）也必须一致').toBe(EDIT)
    expect(after!.value, '① 内存里那次未保存的修改（B）**不得**出现').not.toBe(UNSAVED)

    // 机器读面复核（不经面板）：该格在世界坐标读面上就是 EDIT，且**只有**它带 EDIT
    const ann = await kernelAnnotations(page)
    expect(ann.cells[`${target.kernel[0]},${target.kernel[1]},${target.kernel[2]}`]).toBe(EDIT)
    expect(
      Object.entries(ann.cells).filter(([, v]) => v === EDIT).length,
      'EDIT 只应出现在被改的那一格（不得扩散）',
    ).toBe(1)

    // ── ⑦ 结构与纹理保留（机械逐格/逐条断言）──
    const structAfter = await structureSnapshot(page)
    expect(structAfter.gridShape, '网格声明形状必须保留').toEqual(structBefore.gridShape)
    expect(structAfter.cellGrid, '逐格方块结构必须**逐字**相同').toBe(structBefore.cellGrid)
    expect(structAfter.blockPalette, '方块调色板必须逐条相同').toEqual(structBefore.blockPalette)
    expect(structAfter.materialCount, '材质条目数必须相同').toBe(structBefore.materialCount)
    expect(structAfter.textureBlobs, '纹理 blob 内容必须逐字节相同').toBe(structBefore.textureBlobs)
    expect(structAfter.materialCount, '前提：样本必须有材质（否则"相同"是空转）').toBeGreaterThan(0)
    expect(structAfter.textureBlobs.length, '前提：样本必须有纹理字节').toBeGreaterThan(0)
    // 画面也确实挂上了（`.vc-viewport` 可见由 waitForViewportMounted 保证）
    await expect(page.locator(VIEWPORT_CANVAS).first(), '重开后视口必须有内容').toBeVisible()

    // ── ⑧ isDirty === false（`restoreProject` 把保存基线钉到还原后版本）──
    expect(await isDirty(page), '② 刚重开 = 与保存基线相同 ⇒ 必须干净（isDirty === false）').toBe(false)
    expect(await undoState(page), '② 重开后撤销/重做栈必须为空（历史不跨刷新）').toEqual({
      canUndo: false,
      canRedo: false,
      undoLabel: null,
      redoLabel: null,
    })

    // ── ⑨ 重开后**仍可编辑且可撤销**（P2 的修复在重开路径上仍成立）──
    const AFTER = 'P3-1 重开后再改（e2e）'
    await writeField(page, TOOLTIP_FIELD, AFTER)
    expect((await undoState(page)).canUndo, '重开后的编辑必须进撤销栈').toBe(true)
    expect(await isDirty(page), '重开后的编辑必须让文档变脏').toBe(true)
    const trace = await pressUndo(page)
    const keyEntry = trace.find((e) => e.source === 'key' && e.kind === 'keydown' && e.commandId === 'edit.undo')
    expect(keyEntry, 'Ctrl+Z 必须产出 edit.undo 意图').toBeTruthy()
    expect(keyEntry!.dispatched, '⚠️ edit.undo 的意图必须真的交给分发（P2 缺陷的判据在重开路径上仍须成立）').toBe(true)
    expect(trace.some((e) => e.source === 'command' && e.commandId === 'edit.undo'), '必须有分发结算记录').toBe(true)
    expect((await fieldOf(page, TOOLTIP_FIELD))!.value, '④ 重开后撤销必须回到磁盘里的值').toBe(EDIT)
    expect((await fieldOf(page, TOOLTIP_FIELD))!.display).toBe(EDIT)
    expect(await isDirty(page), '撤销回保存基线 ⇒ 必须重新变干净').toBe(false)
    expect((await undoState(page)).canRedo, '撤销后必须可重做').toBe(true)

    await page.screenshot({ path: path.join(out, 'p3-1-after-reopen.png') })
    console.log(`[P3-1] 输入副本=${inputCopy} 产物=${savedPath}（${saved.bytes} B，建议名 ${saved.suggested}）`)
    console.log(`[P3-1] 结构/纹理：材质 ${structAfter.materialCount} 条，纹理字节 ${structAfter.textureBlobs.length} chars，网格 ${structAfter.gridShape.join('x')}`)
  })

  test('P3-2 负对照：**跳过重开**时同一判据必须判红（证明 P3-1 不是恒真）', async ({ page }) => {
    test.setTimeout(300_000)
    const out = caseDir('p3-2', test.info().project.name)
    const inputCopy = path.join(out, 'p3-2-input-copy.json')
    fs.copyFileSync(fixturePath(), inputCopy)
    const target = firstAnnotatedCell(innerDocOf(inputCopy))

    await gotoWorkbench(page)
    await waitForInputProbe(page)
    await openViaFileMenu(page, '打开场景', inputCopy)
    await waitForViewportMounted(page)
    await selectCell(page, target.kernel, target.fileIdx)

    const EDIT = 'P3-2 已保存的值'
    const UNSAVED = 'P3-2 未保存的值'
    await writeField(page, TOOLTIP_FIELD, EDIT)
    const savedPath = path.join(out, 'p3-2-saved-project.json')
    await saveViaFileMenu(page, '保存工程', savedPath)
    await writeField(page, TOOLTIP_FIELD, UNSAVED)

    // 判别子：内存态现在**不是**磁盘态（否则下面的"必须判红"无从谈起）
    const inMemory = (await fieldOf(page, TOOLTIP_FIELD))!.value
    expect(inMemory, '前提：内存态必须是**未保存**的那次修改').toBe(UNSAVED)
    expect(fs.readFileSync(savedPath, 'utf8'), '前提：磁盘产物里是**已保存**的值').toContain(EDIT)

    // 把 P3-1 的核心判据原样搬过来（不 reload、不重开）—— 它**必须**失败：
    // 若"仍读内存旧状态"也能满足这条判据，P3-1 就是恒真，本里程碑的"磁盘重载"就没被证。
    let red = false
    try {
      expect(await fieldOf(page, TOOLTIP_FIELD)).toMatchObject({ value: EDIT })
    } catch {
      red = true
    }
    expect(red, '跳过重开时 P3-1 的判据若仍然成立，说明它抓不到"没读磁盘"，本组必须判红').toBe(true)
    console.log(`[P3-2] 负对照成立：不重开 ⇒ 判据判红（内存=${inMemory}，磁盘=${EDIT}）`)
  })
})
