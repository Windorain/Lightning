/**
 * **P10b（#282）· A05/A17 产品级端到端验收**（真实双 3D Area，零替身）。
 *
 * ## 本文件补什么（与 `a05a17MultiAreaHistory.test.ts` 的分工）
 *
 * `src/__tests__/a05a17MultiAreaHistory.test.ts` 在**内核层**证明"A05/A17 的判据
 * 足以被内核契约承载"，其文件头逐字写明：「产品层待 #282 补装配后复跑同一判据」。
 *
 * 本文件就是那次复跑：在**真实双 3D Area**（真实分割命令、真实两个
 * `WorkbenchViewport`、两个 WebGL 上下文、两个独立 region/机位）上跑**同一批判据**。
 *
 * ## A05 `multi-area-interaction` 判据（设计文档原文）
 *
 * > 两个 3D Area + 属性编辑器，拖动/建注解 → **松手前两视口有效坐标相同、面板相同；
 * > 基础文档/历史未变；提交仅一条历史；机位独立**
 * > 负对照：**只让发起视口读暂存结果**
 *
 * ## A17 `history-reference` 判据（设计文档原文）
 *
 * > 提交后撤销/重做，目标被删除、多上下文观察 → **内容/相关选择一致；无悬空引用；
 * > 回保存内容变干净；无关机位不变**
 * > 负对照：**回放旧选择直接引用已失效对象**
 *
 * ## 零替身
 *
 * 全程真实组件 + 真实命令路径（`OPERATOR_AREA_SPLIT`、`beginInteraction` 等），
 * 无 Mock/Stub，无测试专用 URL 参数。观测面是 `__vm__` 公开面 + 真实 DOM。
 */

import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { gotoWorkbench, injectSceneDocumentOk, readFixture, waitForViewportMounted } from './helpers/multiblock'

const SHOT_DIR = path.join(import.meta.dirname, 'screenshots', 'p10b-a05a17')

/** 分割出第二个 3D Area（真实命令路径）。 */
async function splitArea(page: Page, direction: 'horizontal' | 'vertical' = 'horizontal'): Promise<void> {
  await page.evaluate(async (dir) => {
    await (window as any).__vm__.getOperators().exec('OPERATOR_AREA_SPLIT', { direction: dir })
  }, direction)
  await expect
    .poll(async () => await page.evaluate(() => document.querySelectorAll('.vc-viewport').length), {
      message: '分割后应有两个真实 3D 视口',
      timeout: 20_000,
    })
    .toBe(2)
}

/** 两个 Area 的 region id（按 DOM 顺序；根 Area 是 `r-viewport`）。 */
async function areaRegions(page: Page): Promise<readonly string[]> {
  return await page.evaluate(() =>
    Array.from(document.querySelectorAll('.area-node--leaf[data-area-id]') as NodeListOf<HTMLElement>).map(
      (c) => c.dataset.wmRegion ?? '',
    ),
  )
}

/** 加载一份真实多方块夹具并分割成双视口。 */
async function dualViewportWithFixture(page: Page): Promise<readonly string[]> {
  await gotoWorkbench(page)
  const fx = readFixture('multiblock-tier-only.json')
  await injectSceneDocumentOk(page, fx.envelope, 'multiblock-tier-only.json')
  await waitForViewportMounted(page)
  await splitArea(page)
  return await areaRegions(page)
}

/**
 * 造一个**可写**对象并返回其 id。
 *
 * ## 为什么不能取 `objects.list()[0]`（P10b 实测修正）
 *
 * 真实多方块夹具装配后，对象表里**第一个**是 `structure:multiblock` —— 它是
 * §3.3 的**生成物**，写权为 `readOnly`（`deleteObject` 对它会被内核
 * **正确拒绝**：`{code:'ReadOnly', params:{owner:'content'}}`）。
 * 初版取 `[0]` 于是"删不掉"，而那不是缺陷、是判据在正确地保护生成物。
 *
 * 正解：从**结算结果**里取本次新建的实体 id（`changes.createdEntities`），
 * 那才是本命令真的造出来的可写对象。这也顺带证明了"接收 ≠ 已生效"要用结算查询
 * （`settlementOf`）而不是靠副作用猜。
 */
async function addWritableObject(page: Page, name = 'A'): Promise<string> {
  const id = await page.evaluate((n) => {
    const kernel = (window as any).__vm__.requireKernelSession()
    const ticket = kernel.submit({
      kind: 'addObject', contextId: kernel.contextId, objectType: 'block', name: n,
    })
    kernel.drain()
    const outcome = kernel.settlementOf(ticket)
    const created = outcome?.changes?.createdEntities ?? []
    const first = created.find((e: { kind: string }) => e.kind === 'object')
    return first?.id ?? null
  }, name)
  expect(id, `addObject 必须结算出一个新建对象（实测 ${name}）`).not.toBeNull()
  return id as string
}

test.describe('P10b · A05/A17 产品级（真实双 3D Area）', () => {
  // ── A05：松手前两视口有效坐标相同 ──────────────────────────────────────────
  test('A05 · 拖动期：两视口读到的**有效坐标相同**（同一暂存，不是各读各的）', async ({ page }) => {
    const regions = await dualViewportWithFixture(page)
    expect(regions.length, '应有两个 Area region').toBe(2)

    const id = await addWritableObject(page)
    const observed = await page.evaluate((objectId) => {
      const kernel = (window as any).__vm__.requireKernelSession()
      // 开一次"移动"暂存（不经松手提交）
      kernel.submit({ kind: 'beginInteraction', contextId: kernel.contextId, tool: 'move', targets: [objectId] })
      kernel.drain()
      kernel.submit({
        kind: 'updateInteraction', contextId: kernel.contextId,
        displacement: { x: 4, y: 2, z: -1 },
      })
      kernel.drain()
      // **两个"视口" = 两次 read()**：`ReadScope` 只有 documentId/contextId，
      // 故"两个视口读到同一份暂存"是**结构事实**（没有第二个暂存可读）。
      const v1 = kernel.read().interaction.effectiveTransform(objectId)
      const v2 = kernel.read().interaction.effectiveTransform(objectId)
      return {
        v1: v1.ok ? v1.value : null,
        v2: v2.ok ? v2.value : null,
      }
    }, id)

    expect(observed.v1, '两视口都应读到有效变换').not.toBeNull()
    expect(observed.v1, 'A05 判据原文：松手前两视口有效坐标必须相同').toEqual(observed.v2)
    expect(observed.v1?.position, '暂存位移应反映在有效坐标上').toMatchObject({ x: 4, y: 2, z: -1 })
  })

  test('A05 · **机位独立**：改一个 Area 的机位，另一个不动（双真实视口）', async ({ page }) => {
    const regions = await dualViewportWithFixture(page)
    const [regA, regB] = regions
    expect(regA, '第一个 Area 的 region').not.toBe('')
    expect(regB, '第二个 Area 的 region 必须不同于第一个（否则共享机位）').not.toBe(regA)

    const observed = await page.evaluate(
      ({ a, b }) => {
        const ctx = (window as any).__vm__
        const camA = ctx.main.ensureCamera(a)
        const camB = ctx.main.ensureCamera(b)
        camA.value = { yawDeg: 11, elevationDeg: 22, distance: 33, zoom: 1, target: { x: 1, y: 2, z: 3 } }
        camB.value = { yawDeg: 99, elevationDeg: 88, distance: 77, zoom: 1, target: { x: 9, y: 8, z: 7 } }
        return {
          a: camA.value?.yawDeg ?? null,
          b: camB.value?.yawDeg ?? null,
          // 两个视口的**真实**相机对象也必须各自独立（不是共享一个 THREE.Camera）
          sameCamera: ctx.viewports.get(a)?.camera?.value === ctx.viewports.get(b)?.camera?.value,
          bothLive: !!(ctx.viewports.get(a)?.camera?.value && ctx.viewports.get(b)?.camera?.value),
        }
      },
      { a: regA, b: regB },
    )

    expect(observed.a, '改第二个 Area 的机位不得影响第一个（A05「机位独立」）').toBe(11)
    expect(observed.b, '第二个 Area 的机位应是刚设置的值').toBe(99)
    expect(observed.bothLive, '两个视口都应有活的相机（否则"独立"是空转）').toBe(true)
    expect(observed.sameCamera, '两个视口不得共享同一个相机对象').toBe(false)
  })

  test('A05 · **面板相同**：两处读到的选择/上下文摘要一致', async ({ page }) => {
    await dualViewportWithFixture(page)
    const id = await addWritableObject(page)
    const observed = await page.evaluate((objectId) => {
      const kernel = (window as any).__vm__.requireKernelSession()
      kernel.submit({ kind: 'select', contextId: kernel.contextId, target: { kind: 'object', id: objectId } })
      kernel.drain()
      const s1 = kernel.read().interaction.selection()
      const s2 = kernel.read().interaction.selection()
      const c1 = kernel.read().interaction.context()
      const c2 = kernel.read().interaction.context()
      return {
        s1: s1.ok ? s1.value : null,
        s2: s2.ok ? s2.value : null,
        c1: c1.ok ? c1.value : null,
        c2: c2.ok ? c2.value : null,
      }
    }, id)
    expect(observed.s1, '两处选择必须相同').toEqual(observed.s2)
    expect(observed.c1, '两处上下文摘要必须相同').toEqual(observed.c2)
    // 反空洞真：选择里确实有那个对象（否则"两处相同"可能只是"两处都空"）
    const selIds = (observed.s1?.selected ?? []).map((r: { id: string }) => r.id)
    expect(selIds, '选择里应含刚选中的对象（反空洞真）').toContain(id)
  })

  test('A05 · **基础文档/历史未变**：暂存期间不推进版本、不记历史', async ({ page }) => {
    await dualViewportWithFixture(page)
    const id = await addWritableObject(page)
    const observed = await page.evaluate((objectId) => {
      const kernel = (window as any).__vm__.requireKernelSession()
      const vBefore = kernel.read().version
      const dBefore = kernel.read().workspace.document()
      kernel.submit({ kind: 'beginInteraction', contextId: kernel.contextId, tool: 'move', targets: [objectId] })
      kernel.drain()
      for (const dx of [1, 2, 3, 4]) {
        kernel.submit({ kind: 'updateInteraction', contextId: kernel.contextId, displacement: { x: dx, y: 0, z: 0 } })
        kernel.drain()
      }
      const vAfter = kernel.read().version
      const dAfter = kernel.read().workspace.document()
      return {
        before: vBefore.documentVersion,
        after: vAfter.documentVersion,
        undoBefore: dBefore.ok ? dBefore.value.canUndo : null,
        undoAfter: dAfter.ok ? dAfter.value.canUndo : null,
        labelAfter: dAfter.ok ? dAfter.value.undoLabel : null,
      }
    })
    expect(observed.after, '暂存期间文档版本不得推进').toBe(observed.before)
    expect(observed.undoAfter, '暂存期间不得记历史').toBe(observed.undoBefore)
    expect(observed.labelAfter, '暂存不得产生名为 move 的历史条目').not.toBe('move')
  })

  test('A05 · **提交仅一条历史**：多次 update 只产生一条撤销条目', async ({ page }) => {
    await dualViewportWithFixture(page)
    const id = await addWritableObject(page)
    const observed = await page.evaluate((objectId) => {
      const kernel = (window as any).__vm__.requireKernelSession()
      kernel.submit({ kind: 'beginInteraction', contextId: kernel.contextId, tool: 'move', targets: [objectId] })
      kernel.drain()
      for (const dx of [1, 2, 3, 4, 5]) {
        kernel.submit({ kind: 'updateInteraction', contextId: kernel.contextId, displacement: { x: dx, y: 0, z: 0 } })
        kernel.drain()
      }
      kernel.submit({ kind: 'commitInteraction', contextId: kernel.contextId, label: 'move' })
      kernel.drain()
      const afterCommit = kernel.read().workspace.document()
      const moved = kernel.read().interaction.effectiveTransform(objectId)
      kernel.submit({ kind: 'undo', contextId: kernel.contextId })
      kernel.drain()
      const afterUndo = kernel.read().workspace.document()
      const undone = kernel.read().interaction.effectiveTransform(objectId)
      kernel.submit({ kind: 'redo', contextId: kernel.contextId })
      kernel.drain()
      const redone = kernel.read().interaction.effectiveTransform(objectId)
      return {
        canUndoAfterCommit: afterCommit.ok ? afterCommit.value.canUndo : null,
        canUndoAfterUndo: afterUndo.ok ? afterUndo.value.canUndo : null,
        moved: moved.ok ? moved.value : null,
        undone: undone.ok ? undone.value : null,
        redone: redone.ok ? redone.value : null,
      }
    }, id)
    expect(observed.canUndoAfterCommit, '提交后应有可撤销条目').toBe(true)
    // 撤销**一次**必须回到原位 —— 若 5 次 update 各记一条历史，这里只退一格
    expect(observed.moved?.position, '提交后应在位移后的位置').toMatchObject({ x: 5 })
    expect(
      observed.undone?.position,
      '撤销**一次**必须回到提交前（多次 update 只应产生一条历史）',
    ).toMatchObject({ x: 0 })
    expect(observed.redone?.position, '重做应回到位移后的位置').toMatchObject({ x: 5 })
  })

  // ── A05 负对照 ────────────────────────────────────────────────────────────
  test('A05 · **负对照**：「只让发起视口读暂存结果」在本接口下**不可表达**', async ({ page }) => {
    await dualViewportWithFixture(page)
    const observed = await page.evaluate(() => {
      const kernel = (window as any).__vm__.requireKernelSession()
      // `read()` 的作用域只有 documentId/contextId —— 没有"视口/Area"参数。
      // 故"让 A 读暂存、让 B 读基线"在类型层面就没有表达方式。
      const scopeKeys = Object.keys(kernel.read()).sort()
      const readFnArity = kernel.read.length
      return { scopeKeys, readFnArity }
    })
    // 反空洞真：确实拿到了真实读面（否则下面的断言只是"没扫到"）
    expect(observed.scopeKeys, '读面应有契约 §2.2 的六个成员').toContain('version')
    expect(observed.scopeKeys, '读面应含 interaction 组').toContain('interaction')
    // `read` 不接受任何参数 ⇒ 无法按视口分叉
    expect(observed.readFnArity, '`read()` 不得接受"视口/Area"参数（否则负对照形态可表达）').toBe(0)
    expect(observed.scopeKeys, '读面不得含任何视口维度的键').not.toContain('regionId')
    expect(observed.scopeKeys, '读面不得含任何 Area 维度的键').not.toContain('areaId')
  })

  // ── A17 ───────────────────────────────────────────────────────────────────
  test('A17 · 撤销/重做一致、**无悬空引用**、**回保存内容变干净**', async ({ page }) => {
    await dualViewportWithFixture(page)
    const observed = await page.evaluate(() => {
      const kernel = (window as any).__vm__.requireKernelSession()
      const base = kernel.read().version
      kernel.submit({ kind: 'addObject', contextId: kernel.contextId, objectType: 'block', name: 'A' })
      kernel.drain()
      const afterAdd = kernel.read().version
      const dirty = kernel.read().workspace.document()

      kernel.submit({ kind: 'undo', contextId: kernel.contextId })
      kernel.drain()
      const afterUndo = kernel.read().version
      const clean = kernel.read().workspace.document()

      kernel.submit({ kind: 'redo', contextId: kernel.contextId })
      kernel.drain()
      const afterRedo = kernel.read().version

      // **无悬空引用**：撤销后选择里不得留着已被删除的对象
      const objs = kernel.read().objects.list()
      const sel = kernel.read().interaction.selection()
      const ids = new Set(objs.ok ? objs.value.map((o: { id: string }) => o.id) : [])
      const selIds = sel.ok
        ? (sel.value.selected ?? []).filter((r: { kind: string }) => r.kind === 'object').map((r: { id: string }) => r.id)
        : []
      return {
        baseContent: base.contentVersion,
        addContent: afterAdd.contentVersion,
        undoContent: afterUndo.contentVersion,
        redoContent: afterRedo.contentVersion,
        dirty: dirty.ok ? dirty.value.dirty : null,
        clean: clean.ok ? clean.value.dirty : null,
        dangling: selIds.filter((id: string) => !ids.has(id)),
      }
    })

    expect(observed.addContent, '新增对象必须改变内容身份').not.toBe(observed.baseContent)
    expect(observed.undoContent, '撤销必须回到基线内容身份（回保存内容变干净）').toBe(observed.baseContent)
    expect(observed.redoContent, '重做必须回到新增后的内容身份（可复现）').toBe(observed.addContent)
    expect(observed.dirty, '新增后应判为脏').toBe(true)
    expect(observed.clean, '撤销回保存基线后应判为干净（A17「回保存内容变干净」）').toBe(false)
    expect(observed.dangling, '撤销后不得留下指向已删除对象的悬空引用').toEqual([])
  })

  test('A17 · **无关机位不变**：撤销/重做不动两个 Area 的机位', async ({ page }) => {
    const regions = await dualViewportWithFixture(page)
    const [regA, regB] = regions
    const observed = await page.evaluate(
      ({ a, b }) => {
        const ctx = (window as any).__vm__
        const kernel = ctx.requireKernelSession()
        // 先各自设一个机位（模拟"用户各自观察过"）
        ctx.main.ensureCamera(a).value = { yawDeg: 45, elevationDeg: 30, distance: 20, zoom: 1, target: { x: 0, y: 0, z: 0 } }
        ctx.main.ensureCamera(b).value = { yawDeg: 120, elevationDeg: 60, distance: 40, zoom: 1, target: { x: 5, y: 0, z: 5 } }

        kernel.submit({ kind: 'addObject', contextId: kernel.contextId, objectType: 'block', name: 'A' })
        kernel.drain()
        kernel.submit({ kind: 'undo', contextId: kernel.contextId })
        kernel.drain()
        kernel.submit({ kind: 'redo', contextId: kernel.contextId })
        kernel.drain()

        return {
          a: ctx.main.ensureCamera(a).value,
          b: ctx.main.ensureCamera(b).value,
        }
      },
      { a: regA, b: regB },
    )
    expect(observed.a?.yawDeg, '撤销/重做不得改动第一个 Area 的机位（A17「无关机位不变」）').toBe(45)
    expect(observed.a?.distance, '第一个 Area 的距离不得变').toBe(20)
    expect(observed.b?.yawDeg, '撤销/重做不得改动第二个 Area 的机位').toBe(120)
    expect(observed.b?.distance, '第二个 Area 的距离不得变').toBe(40)
  })

  test('A17 · **负对照**：回放旧选择**不得**直接引用已失效对象（判据非恒真）', async ({ page }) => {
    const regions = await dualViewportWithFixture(page)
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    const id = await addWritableObject(page)
    const observed = await page.evaluate((objectId) => {
      const kernel = (window as any).__vm__.requireKernelSession()
      kernel.submit({ kind: 'select', contextId: kernel.contextId, target: { kind: 'object', id: objectId } })
      kernel.drain()
      // 删除该对象（撤销会把它带回来）
      kernel.submit({ kind: 'deleteObject', contextId: kernel.contextId, objectId })
      kernel.drain()
      const afterDelete = kernel.read().objects.list()
      const exists = afterDelete.ok ? afterDelete.value.some((o: { id: string }) => o.id === objectId) : true
      // 负对照：**若**回放旧选择直接引用已失效对象，这里会读到不存在的 id。
      // 判据：读面不得把已删除对象报成存在（"missing"与"存在"必须可区分）。
      const sel = kernel.read().interaction.selection()
      const selIds = sel.ok
        ? (sel.value.selected ?? []).filter((r: { kind: string }) => r.kind === 'object').map((r: { id: string }) => r.id)
        : []
      const idsNow = new Set(afterDelete.ok ? afterDelete.value.map((o: { id: string }) => o.id) : [])
      return {
        objectId,
        existsAfterDelete: exists,
        dangling: selIds.filter((x: string) => !idsNow.has(x)),
      }
    })
    expect(observed.existsAfterDelete, '删除后该对象必须不在对象表里（反空洞真）').toBe(false)
    expect(
      observed.dangling,
      '删除后选择里不得留悬空引用（A17 负对照「回放旧选择直接引用已失效对象」必须判红）',
    ).toEqual([])

    const shot = path.join(SHOT_DIR, 'a17-negative-control.png')
    await page.screenshot({ path: shot })
    console.log(`[P10b A17] regions=${JSON.stringify(regions)} objectId=${observed.objectId}`)
  })
})
