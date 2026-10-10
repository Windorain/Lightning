/**
 * `runtime/viewportManager` 的槽位生命周期验收 —— **A13 的"实例/监听/作业回基线"**。
 *
 * ## 为什么这份测试是 A13 的必需一半（P6 实测出的缺口）
 *
 * `attachViewport` 挂载时把 7 个字段写进槽位（`camera`/`domElement`/
 * `contentGroup`/`definition`/`overlayGroup`/`layerPreview`/`orbitTarget`），
 * 但它的 unbind 原先**只**做 `unbindDom()` + `drw.unbindOverlayPass()` ——
 * 槽位原样留着已 dispose 的句柄。
 *
 * 后果不是"报错"，而是**陈旧成功**：任何一个经 `window.__vm__` 观测面
 * 读槽位的消费者（e2e 的 4 个 helper 全属此类）都会把
 * "已经没了的视口"读成"还在，且数据齐全"。这类假绿无法通过改选择器治。
 *
 * 本文件把"卸载后槽位必须归零"变成纯单测（不需要 WebGL / DOM）：
 *  - `resetSlot` / `unregister` 之后 `isSlotLive` 为 `false`；
 *  - 每个承载资源的字段都为 `null`；
 *  - **负对照**：不归零时 `isSlotLive` 仍为 `true`（证明判据不是恒假）。
 */

import { describe, expect, it } from 'vitest'
import { createViewportManager, isSlotLive, resetSlot } from '../viewportManager'

/** 模拟 `attachViewport` 的槽位写入（与 `attachViewport.ts` 的字段清单一一对应）。 */
function fakeAttach(slot: ReturnType<ReturnType<typeof createViewportManager>['register']>): void {
  // 类型上这些是 Ref/ShallowRef；用最简对象冒充运行期句柄即可（本测试只判空/非空）
  slot.camera.value = { position: { x: 0, y: 0, z: 0 } } as never
  slot.domElement.value = { tagName: 'CANVAS' } as never
  slot.contentGroup.value = { isGroup: true } as never
  slot.definition.value = { cellGrid: [[[]]] } as never
  slot.layerPreview.value = 'all' as never
  slot.overlayGroup.value = { isGroup: true } as never
  slot.orbitTarget.value = { x: 0, y: 0, z: 0 } as never
  slot.outlinePass = { maskScene: { children: [] } } as never
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 归零
// ─────────────────────────────────────────────────────────────────────────────

describe('A13 · 槽位归零：卸载后不得留下陈旧句柄', () => {
  it('`resetSlot` 把**每一个**承载运行资源的字段归零', () => {
    const vp = createViewportManager()
    const slot = vp.register('r-viewport')
    fakeAttach(slot)
    expect(isSlotLive(slot), '装配后槽位必须是活的').toBe(true)

    resetSlot(slot)

    for (const field of ['camera', 'domElement', 'contentGroup', 'definition', 'layerPreview', 'overlayGroup', 'orbitTarget'] as const) {
      expect(slot[field].value, `${field} 必须归零（否则经 __vm__ 读它的人会读到陈旧成功）`).toBeNull()
    }
    expect(slot.outlinePass, 'outlinePass 必须归零').toBeNull()
    expect(isSlotLive(slot)).toBe(false)
  })

  it('`manager.reset(id)` 归零槽位但**保留**其身份（region id / cameraMainKey 不变）', () => {
    const vp = createViewportManager()
    const slot = vp.register('r-viewport')
    const mainKey = slot.cameraMainKey
    fakeAttach(slot)

    vp.reset('r-viewport')

    const after = vp.get('r-viewport')
    expect(after, '槽位必须仍然存在（重挂载要复用同一个身份）').toBe(slot)
    expect(after?.cameraMainKey, 'cameraMainKey 不得因归零而改变').toBe(mainKey)
    expect(after?.id).toBe('r-viewport')
    expect(isSlotLive(after!)).toBe(false)
  })

  it('`manager.unregister(id)` 归零**并**移除槽位（消费者拿到的引用也看到 null）', () => {
    const vp = createViewportManager()
    const slot = vp.register('r-viewport')
    fakeAttach(slot)
    vp.register('r-other')

    vp.unregister('r-viewport')

    expect(vp.get('r-viewport'), '槽位必须被移除').toBeUndefined()
    // 关键：**持有旧引用**的消费者（e2e 的 __vm__ 观测面）也看到归零，而不是陈旧值
    expect(slot.camera.value, 'unregister 必须先归零再移除（否则旧引用仍指向陈旧句柄）').toBeNull()
    expect(isSlotLive(slot)).toBe(false)
    // 活动槽位回落到其余之一
    expect(vp.activeId.value).toBe('r-other')
  })

  it('`unregister` 在槽位为空集时把 `activeId` 归零（不留悬空的活动 id）', () => {
    const vp = createViewportManager()
    vp.register('only')
    vp.unregister('only')
    expect(vp.activeId.value).toBeNull()
    expect(vp.active.value).toBeNull()
  })

  it('幂等与无副作用：对不存在的 id 调 reset/unregister 不抛、不改其他槽位', () => {
    const vp = createViewportManager()
    const a = vp.register('a')
    fakeAttach(a)
    expect(() => vp.reset('ghost')).not.toThrow()
    expect(() => vp.unregister('ghost')).not.toThrow()
    expect(isSlotLive(a), '别的槽位不得被误伤').toBe(true)
  })

  it('`register` 幂等：同 id 重复注册返回**同一个**槽位（不重置已装配内容）', () => {
    const vp = createViewportManager()
    const a = vp.register('r')
    fakeAttach(a)
    const b = vp.register('r')
    expect(b).toBe(a)
    expect(isSlotLive(b), '重复 register 不得静默清空一个活着的槽位').toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. 负对照
// ─────────────────────────────────────────────────────────────────────────────

describe('**负对照**：判据必须能区分"归零"与"未归零"', () => {
  it('未归零的槽位 `isSlotLive` 为 true —— 这就是旧实现卸载后的状态（陈旧成功的指纹）', () => {
    const vp = createViewportManager()
    const slot = vp.register('r-viewport')
    fakeAttach(slot)
    // 模拟旧 unbind：只解绑监听与 overlay，**不**碰槽位字段
    const legacyUnbind = (): void => {
      /* unbindDom() + drw.unbindOverlayPass() ——全都不碰 slot.* */
    }
    legacyUnbind()
    expect(
      isSlotLive(slot),
      '旧实现的卸载路径下槽位仍是"活的" —— 这正是 e2e 读到陈旧数据的原因',
    ).toBe(true)
    expect(slot.camera.value, '旧实现下相机句柄仍在').not.toBeNull()

    // 真实现对照
    vp.reset('r-viewport')
    expect(isSlotLive(slot)).toBe(false)
  })

  it('**反空洞真**：`isSlotLive` 不是恒假 —— 只装配一半（缺 domElement）时为 false', () => {
    const vp = createViewportManager()
    const slot = vp.register('r')
    // 只写 camera，不写 domElement ⇒ 没有真实的渲染宿主 ⇒ 不算活
    slot.camera.value = { position: { x: 0, y: 0, z: 0 } } as never
    expect(isSlotLive(slot), '缺 domElement ⇒ 不算活（两个必要条件）').toBe(false)
    slot.domElement.value = { tagName: 'CANVAS' } as never
    expect(isSlotLive(slot), '两者齐备才算活').toBe(true)
  })
})
