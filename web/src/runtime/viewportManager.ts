import { computed, ref, shallowRef } from 'vue'
import type { ViewportSlot } from '@/runtime/types'
import { cameraMainKeyForRegion } from '@/runtime/mainCameras'
import { createViewportCameraInitLedger, type CameraInitState } from '@/runtime/viewportCameraInit'
import type { ViewportCameraState } from '@/runtime/viewportCamera'
import { ViewportDeviceRegistry } from '@/presentation/deviceState'

/**
 * 把一个视口槽位**归零**（资源基线在 slot 层的落点）。
 *
 * ## 为什么必须有这个函数（实测出的资源不归零缺陷）
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
  /**
   * **初始机位施加台账**（缺陷修复；纪律与实测证据见
   * `runtime/viewportCameraInit.ts` 的文件头）。
   *
   * 它按 region 记"上次是哪份文档时框选的"。台账的寿命是 **Context**，
   * **不随呈现卸载清除**：槽位归零/注销只说明"这一刻没有承载"，
   * 不说明"这个视口从没框选过"——后者会让每次工作区往返都重新 fit，
   * 覆盖用户机位（与 SPEC §7.3-b③ 相反；判据见模块头）。
   */
  const cameraInit = createViewportCameraInitLedger()
  /**
   * **设备相位索引**：一个视口一台 `DeviceStateMachine`。
   *
   * 权威在机器本身（`PresenterSession` 持有同一实例）；本索引只回答两件
   * "多 Area"问题：哪些视口此刻可提交（`submittableViewports`）与哪些处于
   * 非就绪相位（`pending`）。视口卸载时 `remove`，不让已拆解的视口留在读面里。
   */
  const devices = new ViewportDeviceRegistry()

  return {
    devices,
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
        // 呈现会话由 `useViewportRuntime` 装配时写入；
        // 与 `outlinePass` 同一口径：注册期没有，装配后有。
        presenterSurface: null,
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
      // ⚠️ **不**清除初始机位记号：注销槽位是呈现生命周期事件
      // （工作区切走、合并 Area 都会走到这里），而机位记号表达的是
      // "这个 region 在当前文档下框选过没有"。清掉它会让重挂变成"首装"⇒ 重新 fit。
      if (activeId.value === id) {
        activeId.value = slots.keys().next().value ?? null
      }
    },
    /** 归零槽位但**保留**其身份（卸载视口组件时用；见 `resetSlot` 注释）。 */
    reset(id: string): void {
      const slot = slots.get(id)
      if (slot) resetSlot(slot)
    },
    /**
     * 该 region 此刻是否**应当**施加初始机位（`runtime/viewportCameraInit.ts`）。
     *
     * 取到 `true` 就同时在台账上记下本次文档身份 —— 调用方**不得**只读不取
     * （否则下一次调用会重复返回 `true`，"只施加一次"成为空话）。
     */
    claimInitialViewportCamera(id: string, documentRevision: number, hasCameraState: boolean): boolean {
      return cameraInit.claim(id, documentRevision, hasCameraState)
    },
    /** 台账中该 region 已施加初始机位的文档身份（`null` = 尚未施加；判据/诊断面）。 */
    initialViewportCameraRevisionOf(id: string): number | null {
      return cameraInit.appliedRevisionOf(id)
    },

    /**
     * 登记"首次框选待做"：fit 时内容组还没有几何 ⇒ 等首个成功 apply 补做一次。
     * 与 `claimInitialViewportCamera` 同一台账，语义与判据见 `viewportCameraInit`。
     */
    markInitialFitPending(id: string, documentRevision: number, provisional: ViewportCameraState | null): void {
      cameraInit.markFitPending(id, documentRevision, provisional)
    },
    /**
     * 取走"待做"的首次框选（**只一次**）；`'fit'` 表示现在应当再施加一次初始机位。
     *
     * `'user'`（用户已先动相机）与 `'stale'`（换了文档）都表示**放弃补偿**。
     */
    takeInitialFitPending(
      id: string,
      documentRevision: number,
      current: ViewportCameraState | null,
    ): 'fit' | 'user' | 'stale' | null {
      return cameraInit.takePendingFit(id, documentRevision, current)
    },
    /** 记录初始机位来自 fit（`cameraInitState === 'fitted'`）。 */
    markInitialCameraFitted(id: string): void {
      cameraInit.markFitted(id)
    },
    /** 记录初始机位来自定义缺省兜底（`cameraInitState === 'fallback'`）。 */
    markInitialCameraFallback(id: string): void {
      cameraInit.markFallback(id)
    },
    /**
     * 该视口初始机位的施加结果（`pending`/`fitted`/`fallback`/`user`；`null` = 还没判定过）。
     *
     * 判据面："首次装载后 `fitted` 且 zoom ≠ 定义缺省 1" 才证明自动框选真的跑过。
     */
    cameraInitStateOf(id: string): CameraInitState | null {
      return cameraInit.initStateOf(id)
    },
    get(id: string): ViewportSlot | undefined {
      return slots.get(id)
    },
    forEach(fn: (slot: ViewportSlot) => void): void {
      for (const slot of slots.values()) fn(slot)
    },
    resetAllViewportCameras(mainCameras: Record<string, import('vue').Ref<import('@/runtime/viewportCamera').ViewportCameraState | null>>): void {
      for (const slot of slots.values()) {
        // 按键**动态**取：`cameras` 是开放键空间（按 region 分配），
        // 故新视口的键可能尚未创建 —— 直接 `mainCameras[key].value = null`
        // 会在键不存在时抛错（`undefined.value`）。
        const ref = mainCameras[slot.cameraMainKey] ?? (mainCameras[slot.cameraMainKey] = shallowRef(null))
        ref.value = null
      }
    },
    activeId,
    active,
  }
}

export type ViewportManager = ReturnType<typeof createViewportManager>