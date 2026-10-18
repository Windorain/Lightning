<script setup lang="ts">
/**
 * `AreaHost` —— **一个 Area 的显式生命周期宿主**（#249 §10；B5 退役矩阵 #10 主责）。
 *
 * ## 本组件退役的旧机制
 *
 * 旧 `WorkbenchRoot.vue` 用 `v-show` 把整个 `<WorkbenchShell>` 保活在 DOM 里：
 *
 * ```vue
 * <WorkbenchShell v-show="workspace === 'preview' || workspace === 'wiki'"> ... </WorkbenchShell>
 * <WorkbenchShell v-if="workspace === 'export'"> ... </WorkbenchShell>
 * ```
 *
 * 后果（正是 #249 §15 第 10 条要退役的形态）：
 *  1. 「切走再切回状态还在」靠的是**组件从没被卸载**，不是"状态有自己的拥有者"；
 *  2. 「关闭 Area 释放运行资源」**无法发生** —— 渲染器/监听/作业都随隐藏子树活着。
 *
 * ## 本组件的机制
 *
 * - **挂载即开实例**：`onMounted` → `openInstance(ledger, instanceId, editorType)`
 *   并 `acquire` 该编辑器类型声明的资源；
 * - **卸载即关实例**：`onBeforeUnmount` → 先逐一 `release`，再 `closeInstance`，
 *   最后调 `dispose()`（真正的 GPU/DOM/监听释放由子组件通过 `expose` 提供）；
 * - **状态不在组件里**：观察视角等局部状态由父层（`useAreaHost`）在
 *   切走/卸载前写入 `Workspace.layout` 的 `localState`，组件只是它的"投影"。
 *
 * ## 它**不**询问宿主名
 *
 * 本组件读的是 `ShellRuntime`（能力），不是"当前宿主叫什么"。
 * 类型上 `ShellRuntime` 根本没有宿主名字段（见 `composition/shell.ts`）。
 *
 * ## 资源清点为什么放在这里而不用 `onUnmounted`
 *
 * `onBeforeUnmount` 时 DOM 与 WebGL 上下文仍然有效，故"真正 dispose"必须在它里面做
 * （`onUnmounted` 时子组件已拆，拿不到 renderer 句柄）。
 * 账本的 `closeInstance` 紧随其后，于是"归还"与"注销"在同一处成对出现 ——
 * 这一对是本组件对 A13 的承诺，也是 `leaks()` 能抓到漏还的结构前提。
 */
import { onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue'
import { acquireResource, closeInstance, openInstance, releaseResource, type LifecycleLedger } from '@/runtime/lifecycle'

const props = defineProps<{
  /** Area 稳定 id（布局树里的 id）。 */
  areaId: string
  /**
   * **本 Area 的 region id**（#282 P10b）。
   *
   * 编辑器组件要按 region 定位自己的输入域、相机键与视口槽位
   * （见 `runtime/mainCameras#cameraMainKeyForRegion`）。两个 3D Area 若共用
   * 一个 region 就会共享机位 —— 而 A05 要求「保持独立观察视角」。
   *
   * 由外壳计算并传入（region 的分配属装配，不属本组件）；缺省 `null` 表示
   * 本 Area 的类型不需要 region（如纯呈现型编辑器）。
   */
  regionId?: string | null
  /** 当前编辑器类型（切换时本组件会重挂内容）。 */
  editorType: string
  /** 活动实例 id（由父层分配；`null` 表示本 Area 不承载实例）。 */
  instanceId: string | null
  /** 该编辑器类型声明的资源种类（挂载时逐一 acquire）。 */
  resources: readonly string[]
  /**
   * 真实编辑器组件。
   *
   * **由调用方（外壳）注入**，不是 `editors/` 层去 import：
   * 本层不得依赖旧 `workbench/` 实现（`gate/no-private-cross-layer` 判据），
   * 而"类型 → 组件"的绑定本属装配，不属核心。`null` = 本装配没有它的实现。
   */
  editor: Component | null
  /**
   * 读**当前**账本（由父层持有；本组件只写它的新值）。
   *
   * ## 为什么是 getter 而不是值（M7-2 / D4 实测）
   *
   * 旧形状是 `ledger: LifecycleLedger`（渲染期快照）。关闭发生在**卸载/换代**
   * 期间时，父层不一定重渲过这个子组件，于是 `props.ledger` 可能是若干次
   * 转移之前的旧值；`close()` 在这个旧值上 `release`/`closeInstance`，再
   * `onLedgerChange` **写回**，就把已被兄弟实例关掉的记录**复活**了。
   *
   * 实测（M7-1 G4 先红读数，③ 合并回单区）：活跃实例 `[3,4]`、`totalActive=12`，
   * 其中 3 是在 ③ 之前已关闭、被 stale 账本写回复活的；④ 离开工作区后 3 仍留存。
   *
   * ⇒ 账本是**当前值**，不是渲染输入。每次 open/close 都现取。
   */
  getLedger: () => LifecycleLedger
  /** 账本变更回调（Vue 里账本是 prop，不能就地改）。 */
  onLedgerChange: (next: LifecycleLedger) => void
  /** 子组件提供的资源释放口（真正的 dispose）。 */
  dispose?: () => void
}>()

const emit = defineEmits<{
  /** 实例挂载完成（父层据此登记实例 ↔ Area 绑定）。 */
  (e: 'instance-open', payload: { areaId: string; instanceId: string }): void
  /** 实例卸载前（父层据此把局部状态写回布局树）。 */
  (e: 'instance-close', payload: { areaId: string; instanceId: string }): void
  /** 资源账本异常（漏还/过度释放），带结构化原因。 */
  (e: 'lifecycle-error', payload: { areaId: string; reason: string; detail: unknown }): void
}>()

/**
 * 本组件**真正打开的那个实例**（`null` = 没开）。
 *
 * ## 为什么不能读 `props.instanceId` 来关（M7-2 / D4 根因）
 *
 * 关闭发生在两种时刻，而这两种时刻 `props.instanceId` 都**可能已不是**本组件
 * 打开的那个 id：
 *
 * | 时刻 | `props.instanceId` 的实际值 | 后果 |
 * |---|---|---|
 * | 合并/关闭 Area（组件卸载） | 父层按**新布局**算 `instanceIdOf(areaId)` ⇒ `null` | 旧 `close()` 的 `id === null` 守卫**静默早退**：不 release、不 close、不发任何账号 —— 旧实例记录永久留存 |
 * | 切编辑器类型（watch 触发） | 已是**新**实例 id | 关闭打在新 id 上：`releaseFailed`/`closeFailed`，旧账不销 |
 *
 * ⇒ 打开时把 id 与类型记下来，关闭只认这份记录。它**不是第二份权威**：
 * 账本仍是唯一账本、`setLedger` 仍是唯一写路径；这里只记"本组件开的是哪一个"，
 * 与 SPEC §7.3-a 的"实例从显式创建/恢复到显式关闭"一一对应。
 */
const opened = ref<{ readonly instanceId: string; readonly editorType: string } | null>(null)

function open(): void {
  const id = props.instanceId
  if (id === null || opened.value !== null) return
  const next = openInstance(props.getLedger(), id, props.editorType)
  if (next === null) {
    emit('lifecycle-error', { areaId: props.areaId, reason: 'instanceAlreadyOpen', detail: { instanceId: id } })
    return
  }
  let l = next
  for (const kind of props.resources) {
    const acquired = acquireResource(l, id, kind)
    if (acquired === null) {
      emit('lifecycle-error', { areaId: props.areaId, reason: 'acquireFailed', detail: { instanceId: id, kind } })
      props.onLedgerChange(l)
      return
    }
    l = acquired
  }
  props.onLedgerChange(l)
  opened.value = { instanceId: id, editorType: props.editorType }
  emit('instance-open', { areaId: props.areaId, instanceId: id })
}

/**
 * 关闭实例：**先还资源、再注销**。
 *
 * 顺序是刻意的：`closeInstance` 会移除登记项，之后无法再 release
 * （账本会对未登记实例返回 `null`）。若先注销再还，`released` 永远为空 ——
 * 那会让"漏还"这条判据静默失效（本批实测过一次这类假绿）。
 */
function close(): void {
  // 关闭只认**本组件打开的那个实例**（见 `opened` 的表：props 的 id 可能已是 null/新值）
  const record = opened.value
  if (record === null) return
  const id = record.instanceId
  emit('instance-close', { areaId: props.areaId, instanceId: id })

  // 真正的 dispose 先做（此时 DOM/WebGL 仍有效）
  try {
    props.dispose?.()
  } catch (e) {
    emit('lifecycle-error', { areaId: props.areaId, reason: 'disposeThrew', detail: String(e) })
  }

  // 现取账本（不是渲染期快照）：见 `getLedger` 的说明
  let l = props.getLedger()
  for (const kind of props.resources) {
    const released = releaseResource(l, id, kind)
    if (released === null) {
      emit('lifecycle-error', { areaId: props.areaId, reason: 'releaseFailed', detail: { instanceId: id, kind } })
      continue
    }
    l = released
  }
  const closed = closeInstance(l, id)
  if (closed === null) {
    emit('lifecycle-error', { areaId: props.areaId, reason: 'closeFailed', detail: { instanceId: id } })
    props.onLedgerChange(l)
  } else {
    if (Object.keys(closed.released).length > 0) {
      emit('lifecycle-error', { areaId: props.areaId, reason: 'resourceLeakOnClose', detail: closed.released })
    }
    props.onLedgerChange(closed.ledger)
  }
  opened.value = null
}

onMounted(open)

/**
 * 编辑器类型或实例 id 改变 ⇒ **关旧开新**（显式生命周期，不是"隐藏旧的"）。
 *
 * 这是"切类型释放旧实例"在组件层的落点：由 `domain/workspace` 的
 * `setEditorType` 计算出新的 `instanceId = null`，父层再分配一个新 id ⇒
 * 本 watch 触发，旧实例被真正关闭。
 */
watch(
  () => [props.instanceId, props.editorType] as const,
  () => {
    close()
    open()
  },
)

onBeforeUnmount(close)
</script>

<template>
  <div
    class="area-host"
    :data-area-id="areaId"
    :data-editor-type="editorType"
    :data-instance-id="instanceId ?? ''"
  >
    <!--
      编辑器组件本身由注册表给出（`core 不为类型开 switch`）。
      `:key` 绑到实例 id：换类型/换实例 ⇒ 组件被真正重建（不是复用隐藏的旧实例）。
      这正是 A13「保留状态不靠隐藏组件存活」在模板层的表达：
      状态在 `Workspace.layout.localState` 里，组件被重建后从那里读回。
    -->
    <component
      :is="editor"
      v-if="editor && instanceId"
      :key="instanceId"
      :area-id="areaId"
      :region-id="regionId ?? undefined"
    />
    <!--
      没有可用编辑器组件时**不留空壳**：显示明确状态。
      #249 §13：「不允许暴露会假成功的按钮或空接口」。
    -->
    <div v-else class="area-host__unavailable" role="status">
      <span class="area-host__unavailable-title">{{ editorType }}</span>
      <span class="area-host__unavailable-hint">该落点在本装配中不可用</span>
    </div>
  </div>
</template>

<style scoped>
.area-host {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}
.area-host__unavailable {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--wb-text-muted);
  font-size: 12px;
}
.area-host__unavailable-title {
  font-size: 13px;
  color: var(--wb-text-dim);
}
.area-host__unavailable-hint {
  font-size: 11px;
}
</style>