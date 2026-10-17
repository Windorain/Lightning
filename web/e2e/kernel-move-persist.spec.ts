/**
 * M2-4 · **移动经保存/重开持久化判据**（缺口 3；M1 复核 §3.2 #3）。
 *
 * ## 缺陷形态（M1 复核 §3.2 #3）
 *
 * M1 的 P3-1 只持久化「逐格注解」这一种修改；计划 §3 里「移动一个对象/格」+
 * 「已编辑数据保留」的组合**没有被证**（手测卡里移动只出现在取消演练里）。
 *
 * ## 判据（B 级：真实入口 + 负对照）
 *
 * 1. 输入：`文件 → 打开场景…`（真实 `<input type=file>`，生产 `pickFile()`）
 *    装真实信封的**副本**（夹具原件永不被改写）；
 * 2. 编辑：**生产移动算子**（`g` → 真实 pointer 拖动 → `submitContentEdit({kind:'moveCells'})`），
 *    以撤销项 `move cells` 为"移动真的进了内核事务"的事实判据；
 *    **不硬编码**位移：改动的两格从"移动前后逐格差异"里解出（源格 P 变空、目标格 Q
 *    拿到 P 原来的方块，且 Q 与 P 相邻）；
 * 3. 保存：`文件 → 保存工程`（生产 `projectForSave` → 浏览器下载 → 磁盘产物）；
 *    在 **Node 侧**解盘产物，断言文件里的格集合与移动后的内容**逐位置一致**；
 * 4. 重开：`page.reload()`（真导航，纪元 +1）→ `文件 → 打开工程…` 送**磁盘产物**；
 * 5. 主断言：重开后逐格内容**逐字**等于保存时（`cellGrid` 字符串相等），
 *    且移动的两格 P/Q 各自的状态都在场；`isDirty === false`、撤销栈为空；
 * 6. 负对照：保存后**再移动一次但不保存**（内存态 B）⇒ reload + 重开磁盘产物，
 *    断言读到的是 A（第一次移动后的状态）而**不是** B —— 区分"真持久化"与
 *    "内存残留假绿"。
 */
import { expect, test, type Page } from '@playwright/test'
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
  caseDir,
  firstAnnotatedCell,
  fixturePath,
  innerDocOf,
  isDirty,
  openViaFileMenu,
  readJson,
  saveViaFileMenu,
  selectCell,
  structureSnapshot,
  undoState,
} from './helpers/saveReopen'

/** 保存产物里承载逐格内容的键（与 `kernel-save-reopen` 同一份口径的读法）。 */
function diskCellKeys(projectFile: string): string[] {
  const raw = readJson(projectFile)
  const payload = (raw as any).payload
  const data = payload?.scene?.data ?? {}
  const out: string[] = []
  for (const key of Object.keys(data)) {
    const cells = data[key]?.payload?.cells
    if (cells && typeof cells === 'object') out.push(...Object.keys(cells))
  }
  return out.sort()
}

/**
 * 内核逐格内容 → `{"x,y,z": 方块身份}`（世界坐标口径；行翻转与 `kernelAnnotations` 同一换算）。
 *
 * ⚠️ 值取**方块身份**（`registryId:meta`）而不是调色板下标：实测同一次会话里
 * 调色板会被重建并重新编号（移动前后同一个方块的下标 17 → 26），比对下标会得到
 * 假差异。（下标只在"同一份快照内"有意义，跨快照必须用身份。）
 */
async function cellsByWorld(page: Page): Promise<Record<string, string>> {
  return (await page.evaluate(() => {
    const p = (window as any).__vm__.plainForSave().plain
    const grid = p.cellGrid as number[][][]
    const palette = (p.blockPalette ?? []) as { registryId?: string; meta?: number }[]
    const h = grid[0]?.length ?? 0
    const out: Record<string, string> = {}
    for (let z = 0; z < grid.length; z++) {
      for (let row = 0; row < grid[z]!.length; row++) {
        for (let col = 0; col < grid[z]![row]!.length; col++) {
          const slot = Number(grid[z]![row]![col])
          if (slot === 0) continue
          const entry = palette[slot]
          out[`${col},${h - 1 - row},${z}`] = entry ? `${entry.registryId}:${entry.meta ?? 0}` : `slot:${slot}`
        }
      }
    }
    return out
  })) as Record<string, string>
}

const parseKey = (k: string): [number, number, number] => {
  const [x, y, z] = k.split(',').map(Number)
  return [x!, y!, z!]
}

/** 内核选择读面：选中的方块（世界坐标）。 */
async function selectedBlockPositions(page: Page): Promise<string[]> {
  return (await page.evaluate(() => {
    const sel = (window as any).__vm__.getSelection()
    return [...sel.items.value]
      .filter((e: any) => e.kind === 'block')
      .map((e: any) => `${e.ref.pos.x},${e.ref.pos.y},${e.ref.pos.z}`)
  })) as string[]
}

/** 生产选择入口（世界坐标口径；`block_state_id` 由生产内容给出）。 */
async function selectWorld(page: Page, pos: [number, number, number]): Promise<void> {
  await page.evaluate(([x, y, z]) => {
    const vm = (window as any).__vm__
    const plain = vm.plainForSave().plain
    const grid = plain.cellGrid as number[][][]
    const h = grid[0]!.length
    const slot = Number(grid[z]![h - 1 - y]![x])
    const entry = (plain.blockPalette ?? [])[slot]
    vm.getSelection().select({
      pos: { x, y, z },
      block_state_id: String(entry?.registryId ?? ''),
    })
  }, pos)
}

/** 取"最靠中间"的一格（离边界远 ⇒ 反向/正向拖动都不易立刻越界）。 */
function centerMost(keys: string[]): [number, number, number] {
  let best: [number, number, number] = [0, 0, 0]
  let bestScore = -1
  for (const k of keys) {
    const [x, y, z] = parseKey(k)
    const score = Math.min(x, y, z)
    if (score > bestScore) {
      bestScore = score
      best = [x, y, z]
    }
  }
  return best
}

interface MoveEvidence {
  /** 源格（移动前有方块、移动后没了）。 */
  from: string
  /** 目标格（移动后拿到了源格原来的方块）。 */
  to: string
  undoLabel: string
}

/**
 * 用**生产移动算子**做一次移动：`g` → 真实 pointer 拖动 → 提交。
 *
 * 起点从画布上**未被覆盖层遮挡**的空白处取（实测四角被 `wb-toolshelf`/`wb-divider`
 * 覆盖，点上去不会进入移动），逐个试到撤销项以 `move cells` 开头为止；
 * 位移本身**不硬编码**，由内容差异反解。
 */
async function performMove(page: Page, before: Record<string, string>): Promise<MoveEvidence> {
  const probes = await page.evaluate(() => {
    const el = (window as any).__vm__.viewports.get('r-viewport').domElement.value as HTMLElement
    const r = el.getBoundingClientRect()
    const raw = [
      { x: r.x + r.width / 2, y: r.y + 10 },
      { x: r.x + 10, y: r.y + r.height / 2 },
      { x: r.x + 10, y: r.bottom - 10 },
      { x: r.right - 10, y: r.bottom - 10 },
    ]
    return raw.filter((p) => document.elementFromPoint(p.x, p.y) === el)
  })
  expect(probes.length, '前提：画布上必须有未被覆盖层遮挡的点（移动拖动的起点）').toBeGreaterThan(0)

  const tried: string[] = []
  // 位移量按"格"缩放不确定 ⇒ 逐个试（含反向/更小位移）：越界的移动会被内核拒绝
  // （`submitContentEdit` → false），那时内容不变 —— 必须换一个落点再试，
  // 不能把"上一条撤销项还在"当成"这次移动成功"（撤销标签会一直留在栈上）。
  for (const p of probes) {
    for (const drag of [90, -90, 40, -40]) {
      await page.keyboard.press('g')
      await page.waitForTimeout(600)
      await page.mouse.move(p.x, p.y)
      await page.mouse.down()
      await page.mouse.move(p.x + drag, p.y, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(1500)
      const beforeNow = before
      const afterNow = await cellsByWorld(page)
      const st = (await page.evaluate(() => (window as any).__vm__.kernelUndoState())) as { undoLabel: string | null }
      const movedNow = Object.keys({ ...beforeNow, ...afterNow }).filter((k) => beforeNow[k] !== afterNow[k])
      if (!(typeof st.undoLabel === 'string' && st.undoLabel.startsWith('move cells')) || movedNow.length === 0) {
        tried.push(`(${p.x.toFixed(0)},${p.y.toFixed(0)}) drag=${drag} → label=${String(st.undoLabel)} 变更格=${movedNow.length}`)
        await page.keyboard.press('Escape')
        await page.waitForTimeout(200)
        continue
      }
      {
      const after = afterNow
      const changed = movedNow
      // 源格：移动后变空的那一方（恰好一格）。
      const empties = changed.filter((k) => before[k] !== undefined && after[k] === undefined)
      expect(empties.length, '移动必须让**恰好一格**源格变空（否则不是单格移动）').toBe(1)
      const from = empties[0]!
      /**
       * 目标格为什么从**选择读面**取，而不是从"内容差异"取：
       * 当目标格原本就放着**同一种方块**时，目标格的调色板下标不变 ⇒ 内容差异里
       * 只剩源格这一处（实测：3,1,3 → 15,1,3 就是这种情形）。
       * 生产移动算子在内核 `applied` 后会把选择集平移到新位置
       * （`moveTranslate.ts:346-360`），所以选择读面就是"移动落到哪"的权威事实。
       */
      const sel = await selectedBlockPositions(page)
      expect(sel.length, '生产移动算子必须把选择集平移到新位置（否则无法判定落点）').toBe(1)
      const to = sel[0]!
      expect(to, '落点必须与源格不同').not.toBe(from)
      expect(after[to], '目标格必须拿到源格原来的方块').toBe(before[from])
      return { from, to, undoLabel: st.undoLabel }
      }
    }
  }
  throw new Error('M2-4：真实拖动未能触发一次**真的改内容**的生产移动。已试：\n' + tried.join('\n'))
}

test.describe('M2-4 移动经保存/重开持久化（真实入口）', () => {
  test('MP-1 生产移动算子改格 → 保存工程 → reload → 打开工程：移动后的内容在场；未保存的第二次移动不在场', async ({
    page,
  }) => {
    test.setTimeout(600_000)
    // 与 P2-4 / V2 同口径：窄视口模拟下同样的真实拖动**不会**触发移动
    // （M1 P2 已登记为"未定位"项，不是本判据的结论）。判据固定在 desktop-chrome，
    // 而非在 mobile 上放宽"移动必须真的改内容"这条前提 —— 那会让判据变成空转。
    test.skip(
      test.info().project.name !== 'desktop-chrome',
      '移动拖动判据固定在 desktop-chrome（mobile 模拟下真实拖动未触发移动，M1 P2 已登记）',
    )
    const out = caseDir('m2-4-move', test.info().project.name)
    const inputCopy = path.join(out, 'move-input-copy.json')
    fs.copyFileSync(fixturePath(), inputCopy)
    const target = firstAnnotatedCell(innerDocOf(inputCopy))

    // ── ① 真实入口：File 菜单 → 打开场景 → 真实 <input type=file> ──
    await gotoWorkbench(page)
    await openViaFileMenu(page, '打开场景', inputCopy)
    await waitForViewportMounted(page)
    await expect(page.locator(VIEWPORT_CANVAS).first()).toBeVisible()

    // ── ② 生产选择 API 选中一格，再做一次生产移动 ──
    await selectCell(page, target.kernel, target.fileIdx)
    const before = await cellsByWorld(page)
    expect(Object.keys(before).length, '前提：样本必须有非空格').toBeGreaterThan(10)
    const moveA = await performMove(page, before)
    const afterA = await cellsByWorld(page)
    expect(afterA[moveA.to], `移动后的目标格 ${moveA.to} 必须有方块`).toBe(before[moveA.from])
    expect(afterA[moveA.from], `移动后的源格 ${moveA.from} 必须为空`).toBeUndefined()
    expect(await isDirty(page), '移动必须让文档变脏').toBe(true)
    console.log(`[MP-1] 移动 ${moveA.from} → ${moveA.to}（撤销项「${moveA.undoLabel}」）`)

    // ── ③ 保存工程（真实菜单 + 真实下载 + 磁盘落盘）──
    const savedPath = path.join(out, 'move-saved-project.json')
    const saved = await saveViaFileMenu(page, '保存工程', savedPath)
    expect(saved.bytes, '工程产物不得为空').toBeGreaterThan(0)
    // 外部证据（Node 侧解盘，不读页面）：文件里的格集合 = 移动后的格集合
    const diskKeys = diskCellKeys(savedPath)
    expect(diskKeys, '磁盘产物里的格位置必须与移动后的内容逐位置一致').toEqual(Object.keys(afterA).sort())

    // ── ④ 负对照素材：再移动一次但**不保存**（内存态 B）──
    // 换一格再做（同一格再往同一方向推可能越界，越界会被内核拒绝 ⇒ 内容不变）
    const beforeB = await cellsByWorld(page)
    await selectWorld(page, centerMost(Object.keys(beforeB)))
    const moveB = await performMove(page, beforeB)
    const afterB = await cellsByWorld(page)
    expect(JSON.stringify(afterB), '负对照前提：第二次移动必须真的改变内容（B 与 A 不同）').not.toBe(
      JSON.stringify(afterA),
    )
    expect(await isDirty(page), '未保存的第二次移动必须让文档保持脏').toBe(true)

    // ── ⑤ 真 reload（导航纪元 +1，内存状态必然消失）──
    const epochBefore = navEpochOf(page)
    await page.reload()
    await waitForEvaluateReady(page)
    expect(navEpochOf(page), '判据：reload 必须真的换掉文档').toBeGreaterThan(epochBefore)
    expect(
      await page.evaluate(() => (window as any).__vm__?.hasLoadedDocument() ?? false),
      'reload 后不得还挂着旧文档',
    ).toBe(false)

    // ── ⑥ 真实重开：File 菜单 → 打开工程 → 磁盘产物 ──
    await openViaFileMenu(page, '打开工程', savedPath)
    await waitForViewportMounted(page)

    // ── ⑦ 主断言：逐格内容 = 保存时（A），不是内存里那次未保存的移动（B）──
    const reopened = await cellsByWorld(page)
    expect(JSON.stringify(reopened), '① 重开后逐格内容必须与保存时**完全一致**（磁盘那一份）').toBe(
      JSON.stringify(afterA),
    )
    expect(reopened[moveA.to], `① 已保存的移动目标格 ${moveA.to} 必须在场`).toBe(before[moveA.from])
    expect(reopened[moveA.from], `① 已保存的移动源格 ${moveA.from} 必须仍为空`).toBeUndefined()
    expect(
      JSON.stringify(reopened),
      '② 未保存的第二次移动（B）**不得**出现（否则判据分不清"真持久化"与"内存残留"）',
    ).not.toBe(JSON.stringify(afterB))
    expect(reopened[moveB.to] === undefined || reopened[moveB.to] !== afterB[moveB.to], '② B 的目标格不得来自内存').toBe(
      true,
    )

    // ── ⑧ 保存基线：刚重开必须干净、历史不跨刷新 ──
    expect(await isDirty(page), '③ 刚重开 = 与保存基线相同 ⇒ 必须干净').toBe(false)
    expect(await undoState(page), '③ 重开后撤销/重做栈必须为空').toEqual({
      canUndo: false,
      canRedo: false,
      undoLabel: null,
      redoLabel: null,
    })

    // ── ⑨ 结构与纹理仍完整（逐字对照，防"只存了格而丢了资源"）──
    const snap = await structureSnapshot(page)
    expect(snap.materialCount, '前提：样本必须有材质').toBeGreaterThan(0)
    expect(snap.textureBlobs.length, '前提：样本必须有纹理字节').toBeGreaterThan(0)

    console.log(
      `[MP-1] 输入副本=${inputCopy} 产物=${savedPath}（${saved.bytes} B）` +
        ` 移动 A=${moveA.from}→${moveA.to} 未保存 B=${moveB.from}→${moveB.to}` +
        ` 格数 A=${Object.keys(afterA).length} B=${Object.keys(afterB).length}`,
    )
  })
})