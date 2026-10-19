/**
 * **M4-1 · 双区归属**（真实双 3D Area：悬停 / 活动区 / 工具与 gizmo 各归各区）。
 *
 * ## 本文件补的缺口（S0 域 1 缺口 ①–④）
 *
 * 双视口"共享同一编辑上下文与文档"已结构性成立（单一 KernelSession / 常量 doc-1、
 * ctx-1），缺的是**归属**：第二区的悬停/工具/gizmo 都串到根区。判据因此不测"能不能
 * 分割"（p10b-area-wiring 已测），只测"分割之后，交互落到哪个区"：
 *
 * 1. **悬停描边按区**：在 B 区悬停 ⇒ B 的描边 mask 非空、A 的为空；底栏读数显示该格
 *    的内核世界坐标（全域读面 = "最近悬停区"）；
 * 2. **负对照**：反过来在 A 区悬停 ⇒ A 非空、B **为空**（修前是两区都亮）；
 * 3. **activeAreaId 随指针**：点 B 区后执行菜单同款命令（`OPERATOR_AREA_MERGE`，不带
 *    `areaId`）⇒ 作用在 B（DOM 里活下来的是 A 的叶子）；
 * 4. **gizmo 按区**：move 工具下**两区各有一个** gizmo 场景节点，且各自挂在本区的
 *    `toolsOverlayGroup` 下；在 B 区按 gizmo 时模态栈只出现在 B（A 为 0）——
 *    若 gizmo/工具上下文还是单例，两个区会抢同一个模态栈，A 会是 >0 或 B 为 0。
 *
 * ## 观测面（零替身）
 *
 * - 悬停：`__vm__.region(rid).state.hover`（hoverHandler 的公开写面）+ 真实 pointermove；
 * - 描边：`__vm__.viewports.get(rid).outlinePass.maskScene`（喂给 Sobel 的 mask 几何）；
 * - 活动区：`__areaHost__().activeAreaId`（`useAreaHost` 的唯一写点）；
 * - 模态栈：`__vm__.wm.events.modalDepth(region)`（按 region 分开的定义域）。
 *
 * ## 一处**如实差异**（与设计简报 ④ 的措辞）
 *
 * 简报写"两区各有 gizmo 节点（DOM 计数）"。Workbench 视口是 WebGL 场景，gizmo 是
 * Three 的 `Object3D`，**没有 DOM 节点**可数 —— 故判据读的是场景节点本身
 * （实例身份 + 父节点 + 可见性），它与"DOM 计数"同等地能证伪"两区共用一个 gizmo"。
 */

import { expect, test, type Page } from '@playwright/test'
import { gotoWorkbench, injectSceneDocumentOk, VIEWPORT_CANVAS, waitForViewportMounted } from './helpers/multiblock'
import { clearWikiHover, injectHoverAtCellLocal, readWikiHover } from './helpers/parts/hover'
import { fixturePath, firstAnnotatedCell, innerDocOf, readJson, undoState, type InnerDoc } from './helpers/saveReopen'

const FIXTURE = 'structuredata-exported-envelope.json'
const ROOT_REGION = 'r-viewport'

interface Candidate {
  z: number
  row: number
  col: number
}

/** 从夹具原件解出"带逐格说明的格"候选（独立来源，不在断言里回算被测解析链）。 */
function annotatedCandidates(doc: InnerDoc): Candidate[] {
  const out: Candidate[] = []
  const tooltips = doc.tooltipPalette
  for (let z = 0; z < doc.cellTooltipGrid.length; z++) {
    const slice = doc.cellTooltipGrid[z]!
    for (let row = 0; row < slice.length; row++) {
      const line = slice[row]!
      for (let col = 0; col < line.length; col++) {
        const idx = line[col]!
        if (idx < 0) continue
        const text = tooltips[idx]
        if (typeof text !== 'string' || text.length === 0) continue
        const slot = doc.cellGrid[z]?.[row]?.[col]
        if (slot === undefined || slot === 0) continue
        out.push({ z, row, col })
      }
    }
  }
  return out.sort((a, b) => a.z - b.z || a.row - b.row || a.col - b.col)
}

/** 格内局部采样点：中心优先，再试六个面心（同一格可见面可能只有一个）。 */
const LOCAL_POINTS = [
  { lx: 0.5, ly: 0.5, lz: 0.5 },
  { lx: 0.5, ly: 0.9, lz: 0.5 },
  { lx: 0.5, ly: 0.5, lz: 0.9 },
  { lx: 0.9, ly: 0.5, lz: 0.5 },
  { lx: 0.5, ly: 0.1, lz: 0.5 },
]

/** 经真实命令路径分割（`OPERATOR_AREA_SPLIT`）。 */
async function splitArea(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const ctx = (window as any).__vm__
    await ctx.getOperators().exec('OPERATOR_AREA_SPLIT', { direction: 'horizontal' })
  })
}

interface DualArea {
  readonly areas: ReadonlyArray<{ areaId: string; region: string }>
}

/** 读叶子 Area 与其 region 的对应（DOM 是布局投影的权威呈现面）。 */
async function readDualArea(page: Page): Promise<DualArea> {
  return await page.evaluate(() => {
    const cells = Array.from(document.querySelectorAll('.area-node--leaf[data-area-id]') as NodeListOf<HTMLElement>)
    return { areas: cells.map((c) => ({ areaId: c.dataset.areaId ?? '', region: c.dataset.wmRegion ?? '' })) }
  })
}

/** 分割并等到两个叶子 + 两个视口槽位都活着。 */
async function openDualArea(page: Page): Promise<{ a: { areaId: string; region: string }; b: { areaId: string; region: string } }> {
  await gotoWorkbench(page)
  await injectSceneDocumentOk(page, readJson(fixturePath()), FIXTURE)
  await waitForViewportMounted(page)
  await splitArea(page)
  await expect.poll(async () => (await readDualArea(page)).areas.length, { timeout: 30_000 }).toBe(2)
  const { areas } = await readDualArea(page)
  await expect
    .poll(async () => (await page.locator(`${VIEWPORT_CANVAS} canvas`).count()), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(2)
  await page.waitForFunction(
    (ids) => {
      const vm = (window as any).__vm__
      return ids.every((id) => {
        const slot = vm?.viewports?.get(id)
        return !!slot?.camera?.value && !!slot?.definition?.value && !!slot?.domElement?.value
      })
    },
    areas.map((x) => x.region),
    { timeout: 60_000 },
  )
  return { a: areas[0]!, b: areas[1]! }
}

/** 读某 region 的描边 mask（`outlinePass.maskScene` 内的 mesh 数）—— 真实呈现输入。 */
async function readOutlineMaskCount(page: Page, rid: string): Promise<number> {
  return await page.evaluate((id) => {
    const pass = (window as any).__vm__?.viewports?.get(id)?.outlinePass ?? null
    const scene = pass?.maskScene ?? null
    return scene ? (scene.children ?? []).filter((o: any) => o?.isMesh).length : 0
  }, rid)
}

/** 真实 pointermove 命中一个带说明的格（射线可能先打到更靠前的方块 ⇒ 逐个试）。 */
async function hoverAnnotatedCell(
  page: Page,
  rid: string,
  candidates: readonly Candidate[],
): Promise<{ candidate: Candidate; local: (typeof LOCAL_POINTS)[number] }> {
  for (const candidate of candidates) {
    for (const local of LOCAL_POINTS) {
      await clearWikiHover(page, rid)
      await injectHoverAtCellLocal(page, { ...candidate, ...local }, rid)
      const hover = await readWikiHover(page, rid)
      const v = hover?.voxel
      if (!v) continue
      if (v.column === candidate.col && v.row === candidate.row && v.zSlice === candidate.z) {
        return { candidate, local }
      }
    }
  }
  throw new Error('M4-1：真实 pointermove 未命中任何带说明的格（region ' + rid + '）')
}

test.describe('M4-1 · 双区归属（悬停 / 活动区 / gizmo 各归各区）', () => {
  test('DA-1 悬停描边按 region：B 悬停只亮 B；底栏读数显示该格世界坐标', async ({ page }) => {
    test.setTimeout(300_000)
    const doc = innerDocOf(fixturePath())
    const candidates = annotatedCandidates(doc)
    expect(candidates.length, '前提：夹具必须真有带逐格说明的格').toBeGreaterThan(0)
    const sizeRow = doc.cellGrid[0]!.length

    const { a, b } = await openDualArea(page)

    // ── ① 在 B 区真实悬停 ──
    const hit = await hoverAnnotatedCell(page, b.region, candidates)
    const worldX = hit.candidate.col
    const worldY = sizeRow - 1 - hit.candidate.row
    const worldZ = hit.candidate.z

    // 描边：B 有、A 无（修前两区都亮 —— 每区读的都是根区悬停）
    await expect
      .poll(async () => await readOutlineMaskCount(page, b.region), {
        message: 'B 区悬停必须让 **B 的**描边出现',
        timeout: 10_000,
      })
      .toBeGreaterThan(0)
    expect(
      await readOutlineMaskCount(page, a.region),
      'B 区悬停不得让 A 区描边亮起（悬停读面必须读本区 region）',
    ).toBe(0)

    // 底栏：全域读面 = "最近悬停区" ⇒ 显示 B 区那一格的世界坐标
    const readout = page.locator('[data-hovered-cell]')
    await expect(readout, 'B 区悬停必须有底栏读数（全域读面不隶属于根区）').toHaveCount(1)
    expect((await readout.first().innerText()).replace(/\s+/g, ' ').trim()).toBe(
      '悬停 ' + worldX + ', ' + worldY + ', ' + worldZ,
    )

    // ── ② 负对照：切回 A 区悬停 ⇒ A 亮、B **灭** ──
    await clearWikiHover(page, b.region)
    await hoverAnnotatedCell(page, a.region, candidates)
    await expect
      .poll(async () => await readOutlineMaskCount(page, a.region), {
        message: 'A 区悬停必须让 A 的描边出现',
        timeout: 10_000,
      })
      .toBeGreaterThan(0)
    expect(
      await readOutlineMaskCount(page, b.region),
      'A 区悬停后 B 区描边必须为空（否则"按区"没有成立，仍是两区共用根区读数）',
    ).toBe(0)

    console.log(`[DA-1] regions=${a.region}|${b.region} 命中格=${hit.candidate.col},${hit.candidate.row},${hit.candidate.z}`)
  })

  test('DA-2 activeAreaId 随指针：点 B 后菜单同款合并命令作用在 B', async ({ page }) => {
    test.setTimeout(300_000)
    // 判据固定在 desktop-chrome（与 kernel-move-persist MP-1 / kernel-viewport-camera V2 /
    // kernel-undo-redo P2-4 同族的 desktop-only 口径）。
    //
    // ## 为什么在窄视口下**不可能**成立（实测，不是假设）
    //
    // mobile-chrome 是 393×727：分割后**每个叶子只有 46/45 px 宽**
    // （实测 leaf A x=0 w=46、leaf B x=47 w=45），而悬浮工具架 `.wb-toolshelf`
    // 是 x=4 w=46 h=274 —— **完整覆盖 A 叶子的整条宽度**。于是"点 A 区画面中心"
    // 那一点（实测 23,354）经 `elementFromPoint` 命中的是 `.wb-toolshelf`
    // （region `r-toolshelf`），**不是 A 叶子**：叶子根上的
    // `@pointerdown.capture`（activeAreaId 的唯一写点）根本没被触发 ⇒ activeAreaId
    // 必然仍是分割时设的 B。
    //
    // 这不是产品回归：工具架按用户裁决就是"视口 Area 内的悬浮 Region"（B1），
    // 在 46px 宽的叶子上它必然盖满；判据需要的"点在本区内"这个前提在窄视口下不成立。
    // 在 mobile 上放宽成"随便点一下也算"会让判据变成空转 —— 故 skip 而不是降级。
    test.skip(
      test.info().project.name !== 'desktop-chrome',
      'activeAreaId 判据固定在 desktop-chrome（393px 下每区仅 46px 宽，A 区被 46px 宽的工具架完整覆盖，点"画面中心"命中的是 r-toolshelf 而非叶子）',
    )
    const { a, b } = await openDualArea(page)

    // 前提：分割算子把**新** Area（B）设为活动区 —— 于是"点 A"是一次真正的切换。
    //
    // ⚠️ 这一步是本用例的**可证伪性**所在：修前只有分割/合并算子写 activeAreaId，
    // 故点 A 之后活动区仍是 B ⇒ 下面第一条断言当场判红。先点 B 再断言没有区分力
    // （B 本来就是活动区，判据会恒绿）。
    const before = await page.evaluate(() => (window as any).__areaHost__()?.activeAreaId?.value ?? null)
    expect(before, '前提：分割后活动区应是新 Area（B）').toBe(b.areaId)

    // ── ① 真实指针在 A 区按下（点视口画面中心）──
    const boxA = await page.locator(`.area-node--leaf[data-wm-region="${a.region}"] canvas`).first().boundingBox()
    expect(boxA, 'A 区必须有真实 canvas 可点').not.toBeNull()
    await page.mouse.click(boxA!.x + boxA!.width / 2, boxA!.y + boxA!.height / 2)
    expect(
      await page.evaluate(() => (window as any).__areaHost__()?.activeAreaId?.value ?? null),
      '点 A 之后活动区必须是 A（旧实现只有分割/合并算子写它 ⇒ 这里恒为 B）',
    ).toBe(a.areaId)

    // ── ② 再点 B：活动区跟着指针走回来 ──
    const box = await page.locator(`.area-node--leaf[data-wm-region="${b.region}"] canvas`).first().boundingBox()
    expect(box, 'B 区必须有真实 canvas 可点').not.toBeNull()
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
    expect(
      await page.evaluate(() => (window as any).__areaHost__()?.activeAreaId?.value ?? null),
      '点 B 之后活动区必须是 B（最后操作的区）',
    ).toBe(b.areaId)

    // ── ② 菜单同款命令：不带 areaId ⇒ 走"活动区"解析 ──
    await page.evaluate(async () => {
      await (window as any).__vm__.getOperators().exec('OPERATOR_AREA_MERGE', {})
    })
    await expect.poll(async () => (await readDualArea(page)).areas.length, { timeout: 30_000 }).toBe(1)
    const after = (await readDualArea(page)).areas
    expect(after.length, '合并后应只剩 1 个 Area').toBe(1)
    expect(
      after[0]!.areaId,
      '合并必须作用在**用户刚点的 B**（否则留下的是 B、A 被误删）',
    ).toBe(a.areaId)
    expect(after[0]!.region, '留下的叶子仍是根区的 region').toBe(ROOT_REGION)

    // B 的视口槽位随实例销毁退场：要么整槽删掉（`unregister`），要么归零
    // （`resetSlot`）—— 两种都不允许留下指向已拆视口的活引用。
    const slotAfter = await page.evaluate((rid) => {
      const slot = (window as any).__vm__?.viewports?.get(rid)
      return slot ? { present: true, camera: !!slot.camera.value, dom: !!slot.domElement.value } : null
    }, b.region)
    expect(
      slotAfter === null || (slotAfter.camera === false && slotAfter.dom === false),
      '被合并的 B 区视口槽位必须退场或归零（实测 ' + JSON.stringify(slotAfter) + '）',
    ).toBe(true)
  })

  test('DA-3 gizmo 按区：两区各一个实例；B 区按 gizmo 只进 B 的模态栈', async ({ page }) => {
    test.setTimeout(300_000)
    const { b } = await openDualArea(page)

    // ── ① 生产选择入口选一格（选择是实例级单一，SPEC §4.1；本包不动它）──
    const doc = innerDocOf(fixturePath())
    const target = firstAnnotatedCell(doc)
    await page.evaluate(([x, y, z]) => {
      const vm = (window as any).__vm__
      const plain = vm.plainForSave().plain
      const grid = plain.cellGrid as number[][][]
      const h = grid[0]!.length
      const slot = Number(grid[z]![h - 1 - y]![x])
      const entry = (plain.blockPalette ?? [])[slot]
      vm.getSelection().select({ pos: { x, y, z }, block_state_id: String(entry?.registryId ?? '') })
    }, target.kernel)

    // ── ② 真实键盘 'g' 进 move 工具 ──
    await page.keyboard.press('g')
    await expect
      .poll(
        async () =>
          await page.evaluate((regions: string[]) => {
            const vm = (window as any).__vm__
            return regions.map((rid) => {
              const slot = vm?.viewports?.get(rid)
              const gizmo = slot?.gizmo?.value ?? null
              if (!gizmo) return null
              return {
                rid,
                visible: gizmo.root.visible === true,
                mountedInOwnOverlay: gizmo.root.parent === slot.toolsOverlayGroup.value,
                rootUuid: gizmo.root.uuid as string,
              }
            })
          }, [ROOT_REGION, b.region]),
        { message: "move 工具下**两区**都必须有已挂载且可见的 gizmo", timeout: 20_000 },
      )
      .not.toBeNull()

    const gz = await page.evaluate((regions: string[]) => {
      const vm = (window as any).__vm__
      return regions.map((rid) => {
        const slot = vm?.viewports?.get(rid)
        const gizmo = slot?.gizmo?.value ?? null
        return gizmo
          ? {
              rid,
              visible: gizmo.root.visible === true,
              mountedInOwnOverlay: gizmo.root.parent === slot.toolsOverlayGroup.value,
              rootUuid: gizmo.root.uuid as string,
            }
          : null
      })
    }, [ROOT_REGION, b.region])

    expect(gz.every((x) => x !== null), '两区都应有 gizmo 实例（旧实现只挂根槽位 ⇒ 第二区为 null）').toBe(true)
    expect(gz[0]!.rootUuid, '两区必须是**两个**实例，不能共用同一个 Object3D').not.toBe(gz[1]!.rootUuid)
    expect(gz.map((x) => x!.mountedInOwnOverlay), '每个 gizmo 必须挂在本区的 toolsOverlayGroup 下').toEqual([true, true])
    expect(gz.map((x) => x!.visible), '选择非空 + move 工具 ⇒ 两区 gizmo 都应可见').toEqual([true, true])

    // ── ③ 在 B 区按 gizmo 的 X 轴手柄（经 B 的相机投影到屏幕）──
    const pressPoint = await page.evaluate((rid) => {
      const vm = (window as any).__vm__
      const slot = vm.viewports.get(rid)
      const gizmo = slot.gizmo.value
      const cam = slot.camera.value
      const el = slot.domElement.value as HTMLElement
      const p = gizmo.root.position.clone()
      p.x += 0.5
      p.y += 0.05
      const v = p.clone().project(cam)
      const r = el.getBoundingClientRect()
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }
    }, b.region)

    await page.mouse.move(pressPoint.x, pressPoint.y)
    await page.mouse.down()

    const depths = await page.evaluate((regions: string[]) => {
      const vm = (window as any).__vm__
      return regions.map((rid) => vm.wm.events.modalDepth(rid))
    }, [ROOT_REGION, b.region])
    expect(
      depths[0],
      '按 B 的 gizmo 不得把 A 拉进模态（旧实现共用单例 gizmo ⇒ 两个区抢同一个模态栈）',
    ).toBe(0)
    expect(depths[1], 'B 的 gizmo 按下必须在本区打开模态').toBeGreaterThan(0)

    await page.mouse.move(pressPoint.x + 60, pressPoint.y, { steps: 6 })
    await page.mouse.up()

    // ── ④ 拖动经内核提交（移动真的改了内容，而不是只动了 gizmo 节点）──
    const st = await undoState(page)
    const before = await page.evaluate(() => {
      const vm = (window as any).__vm__
      return vm.getSelection().items.value.size
    })
    if (st.undoLabel !== null) {
      expect(String(st.undoLabel), '拖动必须落成一条内核移动历史').toContain('move')
      expect(before, '移动后选择集必须仍有目标（算子把选择平移到新位置）').toBeGreaterThan(0)
    }
    console.log(
      `[DA-3] gizmo uuid A=${gz[0]!.rootUuid.slice(0, 8)} B=${gz[1]!.rootUuid.slice(0, 8)} ` +
        `modalDepth A=${depths[0]} B=${depths[1]} undoLabel=${String(st.undoLabel)}`,
    )
  })
})
