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
import { computed, onBeforeUnmount, provide } from 'vue'
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

function regionIdFor(areaId: string): string {
  return areaId === ROOT_AREA_ID ? REGION.WORKBENCH_VIEWPORT : `${REGION.WORKBENCH_VIEWPORT}-${areaId}`
}

/**
 * 按需向 Screen 树登记 region（幂等），返回其 id。
 *
 * 对所有 Area 统一登记（不只是 viewport3d）：登记幂等且成本极低，于是
 * "把某 Area 切成 viewport3d"时 region **已就绪** —— 不需要在类型切换的瞬间
 * 做一次可能失败的登记（那时若失败，该视口就没有机位/输入域）。
 */
function ensureRegion(areaId: string): string {
  const rid = regionIdFor(areaId)
  const screen = ctx.getScreenRoot()
  const fn = (screen as unknown as { ensureViewportRegion?: (r: string, a: string) => unknown } | null)?.ensureViewportRegion
  if (typeof fn === 'function') fn.call(screen, rid, areaId)
  return rid
}

const areas = computed<readonly AreaNode[]>(() => collectAreas(host.workspace.value.layout))

function instanceIdOf(areaId: string): string | null {
  return areas.value.find((a) => a.id === areaId)?.instanceId ?? null
}

const viewContext: AreaViewContext = {
  regionIdFor: ensureRegion,
  instanceIdOf,
  componentFor: (editorType) => COMPONENT_BY_TYPE[editorType] ?? null,
  resourcesOf: (editorType) => host.registry.resourcesOf(editorType),
  ledger: () => host.ledger.value,
  setLedger: (next) => host.setLedger(next),
  onInstanceOpen: (p) => host.bindInstance(p.areaId, p.instanceId),
  onInstanceClose: (p) => host.bindInstance(p.areaId, null),
  onLifecycleError: (p) => ctx.log.warn('Area 生命周期', `${p.reason} @ ${p.areaId}`, p.detail),
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
