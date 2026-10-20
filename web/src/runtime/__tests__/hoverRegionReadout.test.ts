/**
 * **M4-1 双区归属 · 悬停读面**（单测层：读面语义与其唤醒机制）。
 *
 * ## 本文件证明什么
 *
 * 1. **按区读**：每个视口的悬停描边走 `createWorkbenchHoverBlockRef(ctx, regionId)`
 *    ⇒ A 区悬停只产出 A 区的目标，B 区不跟着亮（S0 域 1 缺口 ① 的机制面）。
 * 2. **全域读按"最近写入"决胜**：底栏/检查器走 `createScreenHoverBlockRef`，
 *    多区同时有非空悬停时读**最后写入**的那一个（而不是永远读根区）。
 * 3. **唤醒**：第二区是运行期登记的，而 Vue computed 只订阅"上次读过的依赖" ——
 *    屏幕悬停时钟（`HoverClock`）在 region 增删与任何写入时推进，故新区的第一次
 *    悬停也会让已算过的全域读面重算（否则表现为"B 区悬停底栏没反应"）。
 * 4. **零回潮**：单区装配下全域读面 === 该区读面（M3-shell B1 的底栏判据不变）。
 *
 * ## 为什么这里用"屏幕替身"而不是真 `ScreenRoot`
 *
 * 本文件校验的是**读面规则**（排序、唤醒、单区退化），不需要屏幕树的渲染副作用；
 * 生产装配（真 `ScreenRoot` + 真 `Context`）由 e2e `kernel-dual-area` 覆盖。
 * 替身只实现读面真正依赖的两件事：`forEachRegion` 与 `hoverClock`。
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@/runtime/context'
import {
  createScreenHoverAnnotationIdRef,
  createScreenHoverBlockRef,
  createWorkbenchHoverBlockRef,
} from '@/runtime/hover/access'
import { createHoverClock, createViewportHoverState, type ViewportHoverState } from '@/runtime/hover/state'

interface FakeRegion {
  id: string
  state: { hover: ViewportHoverState }
}

/** 读面真正依赖的屏幕面：region 枚举 + 悬停时钟（见文件头）。 */
function makeScreen(clock = createHoverClock()) {
  const regions: FakeRegion[] = []
  const screen = {
    hoverClock: clock,
    forEachRegion: (fn: (r: FakeRegion) => void) => {
      for (const r of regions) fn(r)
    },
  }
  return {
    screen,
    clock,
    addRegion(id: string): FakeRegion {
      const r: FakeRegion = { id, state: { hover: createViewportHoverState(clock) } }
      regions.push(r)
      // 生产里 `ScreenRoot.reindex()` 在登记后推进时钟（唤醒已算过的读面）
      clock.next()
      return r
    },
    ctx(): Context {
      return {
        getScreenRoot: () => screen,
        requireRegion: (id: string) => {
          const r = regions.find((x) => x.id === id)
          if (!r) throw new Error('region not found: ' + id)
          return r
        },
        // 读面把悬停/网格高度换成内核世界坐标；h=0 ⇒ worldY 直接用 row
        kernelGrid: () => null,
        getFrameIndex: () => 0,
      } as unknown as Context
    },
  }
}

/** 造一次"悬停到某格"（写面 = `hoverHandler` 经 `applyRegionHoverPick` 的那一条）。 */
function hoverCell(hover: ViewportHoverState, column: number, row: number, zSlice: number): void {
  hover.setViewportBlock({
    blockId: `b:${column},${row},${zSlice}`,
    voxel: { column, row, zSlice },
    clientX: 1,
    clientY: 2,
  })
}

const posOf = (ref: { value: { pos: { x: number; y: number; z: number } } | null }) =>
  ref.value === null ? null : [ref.value.pos.x, ref.value.pos.y, ref.value.pos.z]

describe('M4-1 · 悬停读面按 region 归属', () => {
  it('每区读自己的悬停：A 悬停不影响 B 的读面（描边独立的最小机制）', () => {
    const s = makeScreen()
    const a = s.addRegion('r-viewport')
    const b = s.addRegion('r-viewport-a2')
    const ctx = s.ctx()

    const refA = createWorkbenchHoverBlockRef(ctx, 'r-viewport')
    const refB = createWorkbenchHoverBlockRef(ctx, 'r-viewport-a2')

    hoverCell(a.state.hover, 1, 2, 3)
    expect(posOf(refA), 'A 区的读面必须看到自己刚悬停的格').toEqual([1, 2, 3])
    expect(posOf(refB), 'A 区悬停**不得**串到 B 区的描边读面').toBeNull()

    hoverCell(b.state.hover, 7, 8, 9)
    expect(posOf(refB)).toEqual([7, 8, 9])
    expect(posOf(refA), 'B 区悬停**不得**改写 A 区的描边读面').toEqual([1, 2, 3])
  })

  it('全域读面取**最近写入**的区（而不是永远读根区）', () => {
    const s = makeScreen()
    const a = s.addRegion('r-viewport')
    const b = s.addRegion('r-viewport-a2')
    const ctx = s.ctx()
    const top = createScreenHoverBlockRef(ctx)

    hoverCell(a.state.hover, 1, 1, 1)
    expect(posOf(top), '只有一个区有悬停时全域读面必须读它').toEqual([1, 1, 1])

    hoverCell(b.state.hover, 2, 2, 2)
    expect(posOf(top), '第二区写入后全域读面必须跟到第二区（否则底栏恒读根区）').toEqual([2, 2, 2])

    hoverCell(a.state.hover, 3, 3, 3)
    expect(posOf(top), '再回到第一区 ⇒ 全域读面跟回第一区').toEqual([3, 3, 3])

    a.state.hover.clearViewport()
    expect(posOf(top), '最近写入的区被清空 ⇒ 全域读面回落到仍有悬停的区').toEqual([2, 2, 2])
  })

  it('同一格上的持续移动也算"最近写入"（离开再回到同一格不得读到旧区）', () => {
    const s = makeScreen()
    const a = s.addRegion('r-viewport')
    const b = s.addRegion('r-viewport-a2')
    const ctx = s.ctx()
    const top = createScreenHoverBlockRef(ctx)

    hoverCell(a.state.hover, 5, 5, 5)
    hoverCell(b.state.hover, 6, 6, 6)
    expect(posOf(top)).toEqual([6, 6, 6])

    // 回到 A 的**同一格**：`setViewportBlock` 走"目标未变，只更新光标坐标"的早退分支
    hoverCell(a.state.hover, 5, 5, 5)
    expect(
      posOf(top),
      '同格持续移动必须刷新最近写入序号（否则"离开后回到原格"会一直读到另一个区）',
    ).toEqual([5, 5, 5])
  })

  it('运行期新登记的区：第一次悬停也唤醒已算过的全域读面', () => {
    const s = makeScreen()
    const a = s.addRegion('r-viewport')
    const ctx = s.ctx()
    const top = createScreenHoverBlockRef(ctx)

    hoverCell(a.state.hover, 1, 1, 1)
    expect(posOf(top)).toEqual([1, 1, 1])

    // 分割：新 region 在**读面已经算过之后**才登记
    const b = s.addRegion('r-viewport-a2')
    hoverCell(b.state.hover, 9, 9, 9)
    expect(
      posOf(top),
      '新区的第一次悬停必须让全域读面重算（computed 只订阅上次读过的依赖 ⇒ 靠屏幕时钟唤醒）',
    ).toEqual([9, 9, 9])
  })

  it('零回潮：单区装配下全域读面与"该区读面"逐值相等', () => {
    const s = makeScreen()
    const a = s.addRegion('r-viewport')
    const ctx = s.ctx()
    const perRegion = createWorkbenchHoverBlockRef(ctx, 'r-viewport')
    const top = createScreenHoverBlockRef(ctx)

    expect(posOf(top), '都无悬停时两者都为 null').toBeNull()
    hoverCell(a.state.hover, 4, 5, 6)
    expect(posOf(top)).toEqual(posOf(perRegion))
    a.state.hover.clearViewport()
    expect(posOf(top)).toBeNull()
    expect(posOf(perRegion)).toBeNull()
  })

  it('注解悬停与方块悬停共用同一条"最近写入区"规则', () => {
    const s = makeScreen()
    const a = s.addRegion('r-viewport')
    const b = s.addRegion('r-viewport-a2')
    const ctx = s.ctx()
    const topAnno = createScreenHoverAnnotationIdRef(ctx)
    const topBlock = createScreenHoverBlockRef(ctx)

    hoverCell(a.state.hover, 1, 1, 1)
    b.state.hover.setAnnotation({ annotationId: 'anno-1', clientX: 3, clientY: 4 })
    expect(topAnno.value, '最近写入区的注解必须被全域注解读面读到').toBe('anno-1')
    expect(
      posOf(topBlock),
      '最近写入的是注解悬停 ⇒ 全域方块读面为空（不混用另一个区的方块）',
    ).toBeNull()
  })
})
