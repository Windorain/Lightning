import { computed, ref, shallowRef } from 'vue'
import type { ViewportSlot } from '@/runtime/types'
import { cameraMainKeyForRegion } from '@/runtime/mainCameras'

/**
 * 把一个视口槽位**归零**（B5 #10 的资源基线在 slot 层的落点）。
 *
 * ## 为什么必须有这个函数（P6 实测出的 A13 缺陷）
 *
 * `attachViewport` 在挂载时写入 `camera`/`domElement`/`contentGroup`/
 * `definition`/`overlayGroup`/`layerPreview`/`orbitTarget`，但它返回的
 * unbind **只做** `unbindDom()` + `drw.unbindOverlayPass()` —— 槽位字段
 * 全部留在原处。后果是一整类**假绿**：
 *
 * | 读取者 | 卸载后读到的 |
 * |---|---|
 * | e2e `readContentMesh` | 已 dispose 的 mesh group（`present: true` + 陈旧三角形数） |
 * | e2e `waitForRenderedGrid` | 陈旧 `definition` ⇒ 断言"已渲染"成立 |
 * | e2e `readDefinitionRootFields` / `readGridSize` | 陈旧定义 |
 * | e2e `readCameraDirectionForCell` | 陈旧相机 ⇒ 探针全部落空 |
 *
 * 这些是**语义**读取（经 `__vm__` 公开观测面），不是 DOM 选择器 ——
 * 所以"改选择器"治不了，必须在卸载时把槽位归零。
 *
 * ## 为什么归零而不是 `unregister`
 *
 * `unregister` 会从 `slots` 里删项，于是 `ctx.viewports.get(rid)` 在
 * 重挂载之前返回 `undefined` —— 而**测试与产品代码都把那当作"还没挂载"**，
 * 于是"卸载后读到 stale"会变成"卸载后 `get` 抛错/返回 undefined"，
 * 后者虽然也不理想，但它是**响亮**的。这里选归零（保留槽位、清掉内容），
 * 因为：
 *  1. `slot` 的**身份**（region id / cameraMainKey）在重挂载时要保持，
 *     `ViewportManager.resetAllViewportCameras` 也按槽位遍历；
 *  2. 归零让"槽位存在 ≠ 视口活着"这件事有**一个显式判据**
 *     （`isSlotLive`），从而 stale 读取能被断言抓住，而不是靠返回值恰巧不同。
 *
 * ## 与 `ViewportSlot` 的类型关系
 *
 * `ViewportSlot` 的字段是 `Ref`/`ShallowRef`，故归零是**赋值 null**
 * （而不是重建对象）—— 这样持有 `slot.camera` 引用的既有消费者
 * 会自然看到 `null`，不需要各自加判空分支。
 */
export function resetSlot(slot: ViewportSlot): void {
  slot.camera.value = null
  slot.contentGroup.value = null
  slot.domElement.value = null
  slot.definition.value = null
  slot.layerPreview.value = null
  slot.gizmo.value = null
  slot.overlayGroup.value = null
  slot.toolsOverlayGroup.value = null
  slot.worldAnnotationGroup.value = null
  slot.wireframe.value = null
  slot.orbitTarget.value = null
  slot.outlinePass = null
}

/**
 * 槽位是否**活着**（已装配且未被卸载）。
 *
 * 判据是"承载运行资源的字段非空"——`domElement` + `camera` 两者都在，
 * 才说明有一个真实的编辑器实例在跑。这给 stale 读取一个**可断言的否定面**：
 * `resetSlot` 之后 `isSlotLive` 必须为 `false`。
 */
export function isSlotLive(slot: ViewportSlot): boolean {
  return slot.camera.value !== null && slot.domElement.value !== null
}

export function createViewportManager() {
  const slots = new Map<string, ViewportSlot>()
  const activeId = ref<string | null>(null)
  const active = computed(() => {
    const id = activeId.value
    return id ? (slots.get(id) ?? null) : null
  })

  return {
    register(id: string): ViewportSlot {
      if (slots.has(id)) return slots.get(id)!
      const slot: ViewportSlot = {
        id,
        camera: ref(null),
        contentGroup: shallowRef(null),
        domElement: ref(null),
        definition: shallowRef(null),
        layerPreview: ref(null),
        gizmo: shallowRef(null),
        overlayGroup: ref(null),
        toolsOverlayGroup: shallowRef(null),
        worldAnnotationGroup: shallowRef(null),
        wireframe: shallowRef(null),
        orbitTarget: ref(null),
        cameraMainKey: cameraMainKeyForRegion(id),
        outlinePass: null,
      }
      slots.set(id, slot)
      if (!activeId.value) activeId.value = id
      return slot
    },
    /**
     * 注销一个 region 的槽位 **并归零其内容**。
     *
     * 归零在删除之前做：持有 `slot` 引用的消费者（例如 e2e 的 `__vm__` 观测面）
     * 会看到 `null` 而不是一个被删掉的槽位的陈旧内容。
     */
    unregister(id: string): void {
      const slot = slots.get(id)
      if (slot) resetSlot(slot)
      slots.delete(id)
      if (activeId.value === id) {
        activeId.value = slots.keys().next().value ?? null
      }
    },
    /** 归零槽位但**保留**其身份（卸载视口组件时用；见 `resetSlot` 注释）。 */
    reset(id: string): void {
      const slot = slots.get(id)
      if (slot) resetSlot(slot)
    },
    get(id: string): ViewportSlot | undefined {
      return slots.get(id)
    },
    forEach(fn: (slot: ViewportSlot) => void): void {
      for (const slot of slots.values()) fn(slot)
    },
    resetAllViewportCameras(mainCameras: Record<string, import('vue').Ref<import('@/runtime/viewportCamera').ViewportCameraState | null>>): void {
      for (const slot of slots.values()) mainCameras[slot.cameraMainKey].value = null
    },
    activeId,
    active,
  }
}

export type ViewportManager = ReturnType<typeof createViewportManager>
