/**
 * M8-1 · S6：**损坏的恢复副本在场**时，正常打开/编辑/保存不受影响 + 有结构化诊断
 *
 * ## 判据要钉的语义（SPEC §9:299）
 *
 * 「采纳恢复副本是明确的内容恢复操作；**损坏副本和存储失败不得破坏当前有效内容**。」
 * 两句分别落成两条可判定事实：
 *  a. **不破坏**：在场一份损坏副本时，正常装载 → 编辑 → 保存 → 重开，有效内容逐字节不变；
 *  b. **可辨认**（§10.7:309「失败必须…明确说明实际后果」）：损坏副本必须留下**结构化诊断**
 *     （稳定码 + 原因 + 文档身份），不得只静默丢弃。
 *
 * ## 记录（M8-1 先红 → M8-4 起为真保证）
 *
 * M8-1 写本文件时恢复副本链路**生产零调用**（write/read/validate/adopt 调用点全为 0）：
 * 那时 (a) 半"必然绿"，但绿的方式是"根本没人读它"——**空洞成立**，不是能力；
 * (b) 半红（无 recovery 码族）。
 *
 * M8-4 起链路已生产接线（`composition/recoverySession` + `runtime/host/recoveryHost`）：
 * (a) 半的绿从此是**真保证**（有读路径、有校验、损坏副本被拒绝而非"没人读"）；
 * (b) 半转绿（`recovery.corrupt`）。本文件保留两半断言：
 * 把"不破坏有效内容"与"损坏可辨认"分别钉死，避免只测一半。
 *
 * ## 损坏副本怎么"在场"（注入面）
 *
 * 恢复副本是**存储介质上的数据**（application/recovery#recoveryStoreKey），
 * 不是某个内部函数的返回值 ⇒ 直接写 localStorage 就是"在场一份损坏副本"最忠实的表达
 * （外部输入 = 外部输入），不需要改 src/、也不需要自喂内部函数。
 * 键按 recoveryStoreKey 的字面形状构造：lk.recovery.v1.<范围>.<实例身份>.<文档 ID>；
 * 三种范围（workbench/embed/shared）各写一份，避免"赌实现选了哪个范围"。
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
  openViaFileMenu,
  saveViaFileMenu,
  selectCell,
  writeField,
} from './helpers/saveReopen'
import {
  RECOVERY_KEY_PREFIX,
  RECOVERY_SCOPES,
  m8CaseDir,
  normalizeInstanceId,
  readDiagnostics,
  storageKeys,
  type DiagnosticFacts,
} from './helpers/m8/faults'

const FIXTURE = 'structuredata-exported-envelope.json'

/** 读本页实例身份（生产读面；取不到时用 normalizeInstanceId 的缺省值）。 */
async function instanceIdOf(page: Page): Promise<string> {
  const raw = (await page.evaluate(() => {
    const vm = (window as any).__vm__
    return typeof vm?.instanceId === 'string' ? vm.instanceId : ''
  })) as string
  return normalizeInstanceId(raw)
}

/** 写一份**损坏**恢复副本（三范围 × 真实/兜底文档身份）。返回写入的键。 */
async function plantCorruptedRecoveryCopies(page: Page, docId: string | null): Promise<string[]> {
  const instanceId = await instanceIdOf(page)
  return (await page.evaluate(
    ({ prefix, scopes, inst, documentId }: { prefix: string; scopes: string[]; inst: string; documentId: string | null }) => {
      const keys: string[] = []
      // 四种损坏形态（与 A31-5 的七类坏副本同族，取最有代表性的四种）
      const payloads = [
        '{"not":"a recovery payload"', // notJson（截断）
        JSON.stringify({ kind: 'recovery-copy', schemaVersion: 999, payload: null }), // schema
        JSON.stringify({ kind: 'recovery-copy' }), // shape（缺 artifact/payload）
        'garbage@@@', // 完全不是 JSON 对象
      ]
      const ids = documentId === null ? ['e2e-corrupt-doc'] : [documentId, 'e2e-corrupt-doc']
      let i = 0
      for (const scope of scopes) {
        for (const id of ids) {
          const key = prefix + scope + '.' + inst + '.' + id
          localStorage.setItem(key, payloads[i % payloads.length]!)
          keys.push(key)
          i += 1
        }
      }
      return keys
    },
    { prefix: RECOVERY_KEY_PREFIX, scopes: [...RECOVERY_SCOPES], inst: instanceId, documentId: docId },
  )) as string[]
}

/** 与"损坏副本"相关的结构化诊断（码含 recovery/corrupt/storage 或参数里提到）。 */
function corruptRecords(records: readonly DiagnosticFacts[]): DiagnosticFacts[] {
  return records.filter((r) => {
    if (/recovery|corrupt|storage/i.test(r.code)) return true
    const blob = (JSON.stringify(r.params) + JSON.stringify(r.correlation)).toLowerCase()
    return /recovery|corrupt/.test(blob)
  })
}

test.describe('M8-1 · S6 损坏恢复副本不破坏有效内容', () => {
  test('S6-a 在场损坏副本：正常装载/编辑/保存仍不受影响（M8-4 起为真保证）', async ({ page }) => {
    test.setTimeout(480_000)
    const out = m8CaseDir('s6-a', test.info().project.name)
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

    // ── ① 正常编辑 + 保存（磁盘态 = 有效内容的基准）──
    const VALID = 'M8-S6 有效内容'
    await writeField(page, TOOLTIP_FIELD, VALID)
    const savedPath = path.join(out, 's6-a-saved-project.json')
    await saveViaFileMenu(page, '保存工程', savedPath)
    const savedText = fs.readFileSync(savedPath, 'utf8')
    expect(savedText, '前提：磁盘产物必须含有效编辑').toContain(VALID)
    // 有效内容的**语义读面**（内核世界坐标的逐格说明；与 M1 P3 的 kernelAnnotations 同一读面）。
    //
    // 为什么不用 plain 的 sha256：工程产物是**边界编码**（encodeProject 的载荷与
    // plainForSave().plain 不同形），逐字比会把"编码形状差异"当成"内容被改写"。
    // 内容是否被损坏输入改写，问的是**内容语义**，故取语义读面。
    const readAnnotationMap = async (): Promise<Record<string, string>> =>
      (await page.evaluate(() => {
        const vm = (window as any).__vm__
        const g = vm.kernelGrid(0)
        const cells: Record<string, string> = {}
        if (!g) return cells
        for (let z = 0; z < g.depth; z++) {
          for (let y = 0; y < g.height; y++) {
            for (let x = 0; x < g.width; x++) {
              const t = g.tooltipAt({ x, y, z })
              if (typeof t === 'string' && t.length > 0) cells[x + ',' + y + ',' + z] = t
            }
          }
        }
        return cells
      })) as Record<string, string>
    const validAnnotations = await readAnnotationMap()
    expect(Object.values(validAnnotations), '前提：保存那一刻的有效内容必须含本次编辑').toContain(VALID)

    // ── ② 在场一份损坏恢复副本（写存储介质；不是内部函数）──
    const docId = (await page.evaluate(() => {
      const vm = (window as any).__vm__
      try {
        return vm?.kernelPresentationDocument?.()?.id ?? null
      } catch {
        return null
      }
    })) as string | null
    const planted = await plantCorruptedRecoveryCopies(page, docId)
    const nowKeys = await storageKeys(page, RECOVERY_KEY_PREFIX)
    console.log('[S6-a] planted=' + JSON.stringify(planted) + ' recoveryKeys=' + nowKeys.length)
    expect(planted.length, '前提：损坏副本必须真的写进存储介质').toBeGreaterThan(0)
    expect(nowKeys.length, '前提：存储里必须能读到恢复副本键族').toBeGreaterThan(0)

    // ── ③ 刷新后走**正常**装载路径（损坏副本仍在场）──
    await page.reload()
    await page.waitForFunction(() => (window as any).__vm_ready__ === true, undefined, { timeout: 90_000 })
    await openViaFileMenu(page, '打开工程', savedPath)
    await waitForViewportMounted(page)

    // ── ④ 主判据（a）：有效内容不被损坏副本改写 ──
    const afterOpenFields = await readAnnotationMap()
    console.log(
      '[S6-a] validAnnotations=' + Object.keys(validAnnotations).length +
        ' afterOpenFields=' + Object.keys(afterOpenFields).length,
    )
    expect(
      afterOpenFields,
      '⚠️ §9:299：损坏副本在场时，打开工程后的**内容语义**必须与那份有效内容逐格相同' +
        '（不得被损坏输入改写）',
    ).toEqual(validAnnotations)
    expect(
      await page.evaluate(() => (window as any).__vm__.kernelDirty()),
      '刚打开 = 干净（与保存基线相同）',
    ).toBe(false)

    // ── ⑤ 再编辑 + 再保存仍然正常（损坏副本不毒化写路径）──
    await selectCell(page, target.kernel, target.fileIdx)
    const SECOND = 'M8-S6 有效内容二改'
    await writeField(page, TOOLTIP_FIELD, SECOND)
    expect(await page.evaluate(() => (window as any).__vm__.kernelDirty()), '前提：编辑必须让文档变脏').toBe(true)
    const saved2 = path.join(out, 's6-a-saved-project-2.json')
    const s2 = await saveViaFileMenu(page, '保存工程', saved2)
    expect(s2.bytes, '损坏副本在场的保存必须仍然产出非空产物').toBeGreaterThan(0)
    expect(fs.readFileSync(saved2, 'utf8'), '第二次保存必须含第二次编辑').toContain(SECOND)

    console.log('[S6-a] 结论：(a) 有效内容未被改写 —— M8-4 起读路径已接线，损坏副本被校验拒绝（不再"没人读"），这是真保证')
  })

  test('S6-b 损坏副本必须留下结构化诊断（不得静默丢弃）', async ({ page }) => {
    test.setTimeout(420_000)
    const out = m8CaseDir('s6-b', test.info().project.name)
    const inputCopy = path.join(out, 'input-copy.json')
    fs.copyFileSync(fixturePath(), inputCopy)

    await gotoWorkbench(page)
    await page.waitForFunction(() => typeof (window as any).__p7_input__?.counters === 'function', undefined, {
      timeout: 30_000,
    })
    await injectSceneDocumentOk(page, JSON.parse(fs.readFileSync(inputCopy, 'utf8')), FIXTURE)
    await waitForViewportMounted(page)

    const planted = await plantCorruptedRecoveryCopies(page, null)
    const baseline = corruptRecords(await readDiagnostics(page))
    expect(baseline.length, '基线：写入损坏副本之前不得已有相关诊断').toBe(0)

    // 刷新 ⇒ 若存在恢复副本读取路径，它必然在启动时看到这份损坏副本
    await page.reload()
    await page.waitForFunction(() => (window as any).__vm_ready__ === true, undefined, { timeout: 90_000 })
    // 再走一次正常装载（恢复候选枚举/校验通常随文档装载发生）
    await openViaFileMenu(page, '打开场景', inputCopy)
    await waitForViewportMounted(page)
    await page.waitForTimeout(1500)

    const records = await readDiagnostics(page)
    const found = corruptRecords(records)
    console.log(
      '[S6-b] planted=' + planted.length +
        ' diagnostics=' + records.length +
        ' corrupt=' + JSON.stringify(found) +
        ' allCodes=' + JSON.stringify([...new Set(records.map((r) => r.code))]),
    )
    expect(
      found.length,
      '⚠️ S6/D5：在场一份**损坏**恢复副本时必须有结构化诊断（稳定码 + 文档身份/原因），' +
        '不得静默丢弃（§10.7:309）。当前恢复副本链路生产零接线（read/validate 调用点 0）⇒ ' +
        '没有任何代码会看到这份损坏副本，因此本判据必然红',
    ).toBeGreaterThan(0)
    for (const r of found) {
      expect(Object.keys(r.params).length, '诊断必须带结构化参数（原因/文档身份）：' + JSON.stringify(r)).toBeGreaterThan(0)
    }
  })
})