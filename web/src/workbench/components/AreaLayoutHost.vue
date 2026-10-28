<script setup lang="ts">
/**
 * `AreaLayoutHost` —— **把 `Workspace.layout` 的 Area 分割树渲染成真实 DOM**
 * （Area 产品接线）。
 *
 * ## 本组件补齐的缺口（机械证据）
 *
 * 完整的 Area 机制已经落地（`editors/AreaHost.vue`、`editors/useAreaHost.ts`、
 * `domain/workspace.ts` 的 `splitArea`/`mergeArea`/`setEditorType`），但**没有**
 * 任何生产代码把它渲染出来 —— 实测：
 *
 * - `WorkbenchShell.vue` 只有**一个** `<slot name="viewport" />`；
 * - `editors/AreaHost.vue` 与 `editors/useAreaHost.ts` 在全树只被**两处注释**
 *   提到（`composition/profiles.ts:499`、`runtime/lifecycle.ts:28`），零 import；
 * - `splitArea` 只在 `designUseCases.test.ts` 的**纯域层**断言里被调用。
 *
 * 于是「工作台可真实分割出第二个 3D Area」在产品里**不可达**，而基本骨架把它
 * 列为完成边界（「Area 可分割、合并、切换类型，切回恢复局部状态」），
 * 产品级判据也依赖它。
 *
 * ## 三条职责（各自对应一条判据）
 *
 * | 职责 | 判据 |
 * |---|---|
 * | 分割树 → 递归 flex（`direction` + `ratio`） | §13「Area 可分割、合并」 |
 * | 每个 Area 挂 `AreaHost`，其 `editor` 组件由**本层**按类型注入 | §10「组件由外壳注入」（`editors/` 不 import 旧 `workbench/`） |
 * | 每个 3D Area 用**自己的 region** | 「保持独立观察视角」（机位键按 region 分配） |
 *
 * ## 为什么"每个 Area 一个 region"是必需的
 *
 * region 是**输入域 + 相机键 + 视口槽位 + viewer 偏好**的共同键
 * （见 `runtime/mainCameras#cameraMainKeyForRegion`）。两个 3D Area 共用一个 region
 * 会让它们共享机位与槽位 —— 而判据是「**保持独立观察视角**」。
 * 根 Area 仍用 `REGION.WORKBENCH_VIEWPORT`：单视口装配的行为**逐字不变**
 * （既有 e2e 与 `__vm__` 观测面读的就是它）。
 *
 * ## 布局的权威与寿命
 *
 * 布局是 `Workspace` 的**值**，由 `useAreaHost` 持有；本组件只是它的**投影**。
 * 于是"切走再切回状态还在"来自 `Workspace.layout.localState`，而不是"组件从没被
 * 卸载"（组件卸载即归还资源的形态）。关闭 Area ⇒ 组件真卸载 ⇒ 资源归还。
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
 * **Area 会话取自 `Context`**。
 *
 * ## 为什么不是本组件的 `ref`
 *
 * 契约明文要求「**Area 与编辑器实例的寿命不依赖组件挂载**」。`WorkbenchRoot`
 * 切工作区时用 `:key="ws-${workspace}"` 卸载重建子树（刻意的 `v-show` → `v-if`），
 * 故若布局归本组件的 `ref`，切到 Wiki 再切回预览会丢掉分割出的 Area 与机位 ——
 * 而"切回恢复"正是 §13 的判据。
 *
 * 会话由宿主在装配期创建（`runtime/host/workbenchHost`），本组件只是它的**投影**。
 *
 * ## 没有会话时渲染明确空态（不静默留空壳）
 *
 * 嵌入外壳（固定布局）在装配层就没有 `layout.edit`，故没有 Area 会话。
 * 但嵌入用的是 `EmbedViewport`，不走本组件 —— 走到这里而没有会话是**装配缺陷**，
 * 必须响亮失败（不允许空接口/假成功），故直接抛错而不是渲染空壳。
 */
const host: AreaHostApi = ctx.requireAreaSession()

/** 供外壳（菜单/快捷键/测试）驱动布局命令。 */
provide('areaHost', host)

/**
 * 编辑器类型 → 组件（**本层**的映射）。
 *
 * `editors/` 不得 import 旧 `workbench/` 的深度 3 实现
 * （`gate/no-private-cross-layer` 判红过初版）；而"类型 → 组件"本属**装配**
 * 故本组件做这个绑定，`AreaHost` 只消费 `:is`。
 *
 * 其余类型（inspector/timeline/channels）目前**没有**独立 Area 组件
 * （它们在既有面板里呈现）—— 映射里不给组件，`AreaHost` 显示明确空态
 * （不允许暴露会假成功的按钮或空接口）。
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
 * `r-viewport-<areaId>` ⇒ 各自一份机位与视口槽位（「保持独立观察视角」）。
 */
function regionIdFor(areaId: string): string {
  return areaId === ROOT_AREA_ID ? REGION.WORKBENCH_VIEWPORT : `${REGION.WORKBENCH_VIEWPORT}-${areaId}`
}

const areas = computed<readonly AreaNode[]>(() => collectAreas(host.workspace.value.layout))

/**
 * 本层**登记过**的视口 region（= 释放台账）。
 *
 * ## 为什么需要它
 *
 * `ensureViewportRegion` 会在**屏幕树**里挂一个 region 节点（含该视口的
 * viewer 偏好实例、悬停状态、输入域 id）。此前本组件只在**整块卸载**时
 * 释放它们，于是"合并掉一个 Area"这条**局部**关闭路径把节点留在了屏幕树上：
 * 被合并的区已经不在布局里、画布也已销毁，但 `screen.region('r-viewport-a2')`
 * 仍返回节点、`wmInputRegionIds()` 仍报它的输入域 —— 陈旧成功读面（D5）。
 *
 * 释放权威与登记权威必须是**同一处**（就是本组件）：它知道"哪些 region 是它
 * 为当前布局登记的"，因此合并/关闭掉的那个能当场释放，而装配期静态声明的根
 * region（`r-viewport`）不会被误删（`releaseViewportRegion` 对它显式返回 false）。
 */
const ensuredRegions = new Set<string>()

/**
 * 布局 → 屏幕树 region 的**对账**（登记 + 释放），以及实例 id 的分配。
 *
 * ## 实例 id 为什么由本组件分配（实测修正 —— 这是"零视口"回归的根因）
 *
 * `AreaHost` 只在 `instanceId !== null` 时挂载编辑器组件；而 `AreaNode.instanceId`
 * 由 `createArea` 硬编码为 `null`，唯一会绑定它的路径是 `AreaHost` 的
 * `instance-open` 事件，该事件又只在 `open()` 里发出、`open()` 在 id 为 `null` 时
 * 提前返回 —— **死锁**。⇒ 由渲染树的拥有者（本组件）显式分配并绑定：它回答
 * "谁渲染这个 Area"，也就回答"谁给它一个实例"（身份是显式输入）。
 * 已有 id 的 Area **不重分配**（重分配会让 `AreaHost` 的 `:key` 变化 ⇒ 视口与
 * WebGL 上下文被无谓重建）；切类型时 `setEditorType` 把 id 置回 `null` ⇒ 这里
 * 再分配一个新 id ⇒ `AreaHost` 关旧开新（「切类型释放旧实例」）。
 * `immediate: true` 让首次渲染前就绑好 id（否则首帧渲染空态）。
 *
 * 时机：`watch` 的 **pre-flush**（默认）⇒ 早于子组件卸载。于是被合并 Area 的
 * region 在它的 `WorkbenchViewport` 拆解之前就已从屏幕树移除；子组件卸载只负责
 * 自己的运行资源（detach / DRW / 视口槽位）。两者不重叠、也不互为前提。
 */
watch(
  areas,
  (list) => {
    for (const a of list) {
      if (a.instanceId === null) host.bindInstance(a.id, host.allocateInstanceId(a.editorType))
    }
    const screen = ctx.getScreenRoot()
    const desired = new Set(list.map((a) => regionIdFor(a.id)))
    if (screen !== null) for (const id of desired) screen.ensureViewportRegion(id)
    // 被关闭/合并的 Area：其 region 节点当场释放（不是等整块卸载）。
    if (screen !== null) {
      for (const id of [...ensuredRegions]) {
        if (desired.has(id)) continue
        // 释放成功才从台账移除：根 region 会被显式拒绝（它属装配期静态声明），
        // 拒绝≠已释放，留在台账里下次仍会尝试 —— 不制造"已经释放了"的错觉。
        if (screen.releaseViewportRegion(id)) ensuredRegions.delete(id)
      }
    }
    for (const id of desired) ensuredRegions.add(id)
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
   * **局部状态的两个口**（「localState 真接线」；原话：
   * 「同会话布局树写回/读回；刷新持久化暂不做」）。
   *
   * 之前这两条在 `useAreaHost` 里定义齐备但**生产零调用**（写与读都只有 e2e 自己调），
   * 于是一个 Area 的实例私有 UI 状态只能靠"组件没被卸载过"存活 —— 正是 §7.3-a 要退役的形态。
   * 现在：`AreaHost#close` 先问子组件要状态 ⇒ 这里写回布局树；挂载时读出来当
   * `:local-state` 传给子组件（首次呈现前就恢复）。
   *
   * 写入权威仍唯一（`useAreaHost#captureLocalState` → `domain/workspace#setLocalState`）；
   * 本层只做接线，不解释状态内容（各编辑器类型自己的语义）。
   */
  localStateOf: (areaId, editorType) => host.restoreLocalState(areaId, editorType),
  onLocalStateCapture: (areaId, editorType, state) => {
    host.captureLocalState(areaId, editorType, state)
  },
  /**
   * **活动 Area 随指针**：任何区被按下 ⇒ 它成为"最后操作的区"，
   * 于是菜单里的分割/合并/切类型作用于用户刚点的那个区（而不是 `useAreaHost`
   * 里那个只有算子才写的旧值）。
   *
   * 写入点仍是 `useAreaHost#setActive`（唯一）；这里只做接线，不做决定。
   */
  onActivateArea: (areaId) => host.setActive(areaId),
}
provide(AREA_VIEW_CONTEXT, viewContext)

/**
 * 整块卸载（切工作区/离开）：释放**本层登记过**的全部 region。
 *
 * 与上面的增量释放同一权威、同一个出口（`releaseViewportRegion`）：
 * 卸载只是"一次把台账清空"，不是第二条释放路径。
 */
onBeforeUnmount(() => {
  const screen = ctx.getScreenRoot()
  if (screen === null) return
  for (const id of ensuredRegions) screen.releaseViewportRegion(id)
  ensuredRegions.clear()
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
