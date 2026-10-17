<script setup lang="ts">
/**
 * `AreaLayoutHost` —— **把 `Workspace.layout` 的 Area 分割树渲染成真实 DOM**
 * （#282 P10b Area 产品接线；#249 §10 §13）。
 *
 * ## 本组件补齐的缺口（机械证据）
 *
 * P6 交付了完整的 Area 机制（`editors/AreaHost.vue`、`editors/useAreaHost.ts`、
 * `domain/workspace.ts` 的 `splitArea`/`mergeArea`/`setEditorType`），但**没有**
 * 任何生产代码把它渲染出来 —— 实测：
 *
 * - `WorkbenchShell.vue` 只有**一个** `<slot name="viewport" />`；
 * - `editors/AreaHost.vue` 与 `editors/useAreaHost.ts` 在全树只被**两处注释**
 *   提到（`composition/profiles.ts:499`、`runtime/lifecycle.ts:28`），零 import；
 * - `splitArea` 只在 `designUseCasesS16.test.ts` 的**纯域层**断言里被调用。
 *
 * 于是「工作台可真实分割出第二个 3D Area」在产品里**不可达**，而 #249 §13 把它
 * 列为基本骨架的完成边界（「Area 可分割、合并、切换类型，切回恢复局部状态」），
 * A05/A17 的**产品级**判据也依赖它。
 *
 * ## 三条职责（各自对应一条判据）
 *
 * | 职责 | 判据 |
 * |---|---|
 * | 分割树 → 递归 flex（`direction` + `ratio`） | §13「Area 可分割、合并」 |
 * | 每个 Area 挂 `AreaHost`，其 `editor` 组件由**本层**按类型注入 | §10「组件由外壳注入」（`editors/` 不 import 旧 `workbench/`） |
 * | 每个 3D Area 用**自己的 region** | A05「保持独立观察视角」（机位键按 region 分配） |
 *
 * ## 为什么"每个 Area 一个 region"是必需的
 *
 * region 是**输入域 + 相机键 + 视口槽位 + viewer 偏好**的共同键
 * （见 `runtime/mainCameras#cameraMainKeyForRegion`）。两个 3D Area 共用一个 region
 * 会让它们共享机位与槽位 —— 而 A05 判据是「**保持独立观察视角**」。
 * 根 Area 仍用 `REGION.WORKBENCH_VIEWPORT`：单视口装配的行为**逐字不变**
 * （既有 e2e 与 `__vm__` 观测面读的就是它）。
 *
 * ## 布局的权威与寿命
 *
 * 布局是 `Workspace` 的**值**，由 `useAreaHost` 持有；本组件只是它的**投影**。
 * 于是"切走再切回状态还在"来自 `Workspace.layout.localState`，而不是"组件从没被
 * 卸载"（§15 第 10 条要退役的形态）。关闭 Area ⇒ 组件真卸载 ⇒ 资源归还（A13）。
 *
 * ## 它不做什么（边界）
 *
 * - **不做**业务决定："切类型要不要保留局部状态"由 `domain/workspace` 决定；
 * - **不**自己存布局；
 * - **不**询问宿主名（读能力/装配结果，不读 profile）。
 */
import { computed, onBeforeUnmount, provide, watch } from 'vue'
import type { Component } from 'vue'
import { collectAreas, type AreaNode } from '@/domain/workspace'
import type { AreaHostApi } from '@/editors/useAreaHost'
import { REGION } from '@/runtime/regionIds'
import { useContext } from '@/runtime/context'
import WorkbenchViewport from '@/workbench/components/WorkbenchViewport.vue'
import AreaNodeView from './AreaNodeView.vue'
import { AREA_VIEW_CONTEXT, type AreaViewContext } from './areaViewContext'

const ctx = useContext()

/**
 * **Area 会话取自 `Context`**（#282 P10b）。
 *
 * ## 为什么不是本组件的 `ref`
 *
 * #249 明文要求「**Area 与编辑器实例的寿命不依赖组件挂载**」。`WorkbenchRoot`
 * 切工作区时用 `:key="ws-${workspace}"` 卸载重建子树（P6 刻意的 `v-show` → `v-if`），
 * 故若布局归本组件的 `ref`，切到 Wiki 再切回预览会丢掉分割出的 Area 与机位 ——
 * 而"切回恢复"正是 §13/A13 的判据。
 *
 * 会话由宿主在装配期创建（`runtime/host/workbenchHost`），本组件只是它的**投影**。
 *
 * ## 没有会话时渲染明确空态（不静默留空壳）
 *
 * 嵌入外壳（固定布局）在装配层就没有 `layout.edit`（#257），故没有 Area 会话。
 * 但嵌入用的是 `EmbedViewport`，不走本组件 —— 走到这里而没有会话是**装配缺陷**，
 * 必须响亮失败（#249 §13「不允许空接口/假成功」），故直接抛错而不是渲染空壳。
 */
const host: AreaHostApi = ctx.requireAreaSession()

/** 供外壳（菜单/快捷键/测试）驱动布局命令。 */
provide('areaHost', host)

/**
 * 编辑器类型 → 组件（**本层**的映射）。
 *
 * `editors/` 不得 import 旧 `workbench/` 的深度 3 实现
 * （`gate/no-private-cross-layer` 判红过 P6 的初版）；而"类型 → 组件"本属**装配**
 * （契约 §7）。故本组件做这个绑定，`AreaHost` 只消费 `:is`。
 *
 * 其余类型（inspector/timeline/channels）目前**没有**独立 Area 组件
 * （它们在既有面板里呈现）—— 映射里不给组件，`AreaHost` 显示明确空态
 * （#249 §13「不允许暴露会假成功的按钮或空接口」）。
 */
const COMPONENT_BY_TYPE: Readonly<Record<string, Component>> = Object.freeze({
  viewport3d: WorkbenchViewport,
})

/** 根 Area（装配期静态声明的那个）——它复用既有 region，保证单视口零回归。 */
const ROOT_AREA_ID = collectAreas(host.workspace.value.layout)[0]?.id ?? 'a1'

/**
 * 某 Area 的 region id（**纯函数**，不碰屏幕树）。
 *
 * 根 Area 复用 `REGION.WORKBENCH_VIEWPORT`（`r-viewport`）⇒ 单视口装配的行为与
 * 既有 e2e / `__vm__` 观测面**逐字一致**（零回归）；分割出的 Area 用
 * `r-viewport-<areaId>` ⇒ 各自一份机位与视口槽位（A05「保持独立观察视角」）。
 */
function regionIdFor(areaId: string): string {
  return areaId === ROOT_AREA_ID ? REGION.WORKBENCH_VIEWPORT : `${REGION.WORKBENCH_VIEWPORT}-${areaId}`
}

const areas = computed<readonly AreaNode[]>(() => collectAreas(host.workspace.value.layout))

/**
 * **分配并绑定编辑器实例 id**（#282 P10b 实测修正 —— 这是"零视口"回归的根因）。
 *
 * ## 为什么必须有这一步
 *
 * `AreaHost` 只在 `instanceId !== null` 时挂载编辑器组件，否则显示
 * "该落点在本装配中不可用"空态。而 `AreaNode.instanceId` 由 `createArea`
 * 硬编码为 `null`（`domain/workspace.ts`），`splitArea` 建新 Area 也走
 * `createArea` ⇒ **永远是 `null`**。
 *
 * `useAreaHost.allocateInstanceId` 是"分配 id"的公开入口，但**全树零调用方**：
 * 唯一会绑定的路径是 `AreaHost` 的 `instance-open` 事件，而该事件只在 `open()`
 * 里发出，`open()` 又在 `id === null` 时提前返回 —— **死锁**。
 *
 * ⇒ 由本组件（渲染树的拥有者）显式分配并绑定：它是"谁渲染这个 Area"的答案，
 * 故也是"谁给它一个实例"的答案。这与 `useAreaHost` 文件头所述"实例 id 的分配
 * 是**显式输入**"（#249 §2.1）一致 —— 分配者就是接线层。
 *
 * ## 幂等
 *
 * 已有 id 的 Area **不重分配**（重分配会让 `AreaHost` 的 `:key` 变化 ⇒ 组件被
 * 重建 ⇒ 视口与 WebGL 上下文被无谓销毁重建）。`bindInstance` 对"值未变"也自行 no-op。
 *
 * ## 时机（两个"不能在渲染期做"的事都在这里）
 *
 * `immediate: true` 让**首次渲染前**就绑好 id（否则首帧渲染的是空态）；之后每次
 * 布局变化（分割/合并/切类型）重新对账。切类型时
 * `domain/workspace#setEditorType` 把 `instanceId` 置回 `null`（表示"要新实例"），
 * 于是这里再分配一个新 id ⇒ `AreaHost` 关旧开新（A13「切类型释放旧实例」）。
 *
 * region 登记与实例绑定**同一时机**（都依赖"当前有哪些 Area"），且都在 watch 里
 * 而不是渲染函数里 —— 渲染期改屏幕树是 Vue 反模式。
 */
watch(
  areas,
  (list) => {
    for (const a of list) {
      if (a.instanceId === null) host.bindInstance(a.id, host.allocateInstanceId(a.editorType))
    }
    const screen = ctx.getScreenRoot()
    const ensure = (screen as unknown as { ensureViewportRegion?: (r: string) => unknown } | null)?.ensureViewportRegion
    if (typeof ensure === 'function') {
      for (const a of list) ensure.call(screen, regionIdFor(a.id))
    }
  },
  { immediate: true },
)

function instanceIdOf(areaId: string): string | null {
  return areas.value.find((a) => a.id === areaId)?.instanceId ?? null
}

const viewContext: AreaViewContext = {
  regionIdFor,
  instanceIdOf,
  componentFor: (editorType) => COMPONENT_BY_TYPE[editorType] ?? null,
  resourcesOf: (editorType) => host.registry.resourcesOf(editorType),
  ledger: () => host.ledger.value,
  setLedger: (next) => host.setLedger(next),
  onInstanceOpen: (p) => host.bindInstance(p.areaId, p.instanceId),
  onInstanceClose: (p) => host.bindInstance(p.areaId, null),
  onLifecycleError: (p) => ctx.log.warn('Area 生命周期', `${p.reason} @ ${p.areaId}`, p.detail),
  /**
   * **活动 Area 随指针**（M4-1）：任何区被按下 ⇒ 它成为"最后操作的区"，
   * 于是菜单里的分割/合并/切类型作用于用户刚点的那个区（而不是 `useAreaHost`
   * 里那个只有算子才写的旧值）。
   *
   * 写入点仍是 `useAreaHost#setActive`（唯一）；这里只做接线，不做决定。
   */
  onActivateArea: (areaId) => host.setActive(areaId),
}
provide(AREA_VIEW_CONTEXT, viewContext)

onBeforeUnmount(() => {
  const screen = ctx.getScreenRoot()
  const release = (screen as unknown as { releaseViewportRegion?: (id: string) => boolean } | null)?.releaseViewportRegion
  if (typeof release !== 'function') return
  for (const a of areas.value) release.call(screen, regionIdFor(a.id))
})

/** 供外壳读布局（模板 ref / 诊断 / e2e 观测面）。 */
defineExpose({ host })
</script>

<template>
  <div class="area-layout" :data-area-count="areas.length">
    <AreaNodeView v-if="host.workspace.value.layout" :node="host.workspace.value.layout" />
  </div>
</template>

<style scoped>
.area-layout {
  display: flex;
  flex-direction: row;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}
</style>
