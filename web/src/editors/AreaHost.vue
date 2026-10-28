<script setup lang="ts">
/**
 * `AreaHost` —— **一个 Area 的显式生命周期宿主**。
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
 * 后果（正是要退役的形态）：
 *  1. 「切走再切回状态还在」靠的是**组件从没被卸载**，不是"状态有自己的拥有者"；
 *  2. 「关闭 Area 释放运行资源」**无法发生** —— 渲染器/监听/作业都随隐藏子树活着。
 *
 * ## 本组件的机制
 *
 * - **挂载即开实例**：`onMounted` → `openInstance(ledger, instanceId, editorType)`
 *   并 `acquire` 该编辑器类型声明的资源；
 * - **卸载即关实例**：`onBeforeUnmount` → 先把实例私有局部状态写回布局树
 *   （`captureLocalState`），再逐一 `release`，最后 `closeInstance`；
 * - **状态不在组件里**：实例私有的可序列化局部状态由父层（`useAreaHost`）在
 *   切走/卸载前写入 `Workspace.layout` 的 `localState`，组件挂载后**读回**
 *   （`:local-state`）。组件只是它的"投影"。
 *
 * ## 两处口的现状（见各处的注释）
 *
 * | 口 | 现状 |
 * |---|---|
 * | 局部状态 | **真接线**：`captureLocalState`（子组件 expose）→ `onLocalStateCapture`（父层写布局树）→ `restoreLocalState`（父层读）→ `:local-state`（子组件读回） |
 * | `:dispose` | **已删除**（原先是从未被任何调用方传入的可选 prop，见下方注释） |
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
 * 这一对是本组件对「保留状态不靠隐藏组件存活」的承诺，也是 `leaks()` 能抓到漏还的结构前提。
 */
import { onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue'
import { acquireResource, closeInstance, openInstance, releaseResource, type LifecycleLedger } from '@/runtime/lifecycle'
import type { EditorLocalState } from '@/domain/workspace'

const props = defineProps<{
  /** Area 稳定 id（布局树里的 id）。 */
  areaId: string
  /**
   * **本 Area 的 region id**。
   *
   * 编辑器组件要按 region 定位自己的输入域、相机键与视口槽位
   * （见 `runtime/mainCameras#cameraMainKeyForRegion`）。两个 3D Area 若共用
   * 一个 region 就会共享机位 —— 而契约要求「保持独立观察视角」。
   *
   * 由外壳计算并传入（region 的分配属装配，不属本组件）；缺省 `null` 表示
   * 本 Area 的类型不需要 region（如纯呈现型编辑器）。
   */
  regionId?: string | null
  /** 当前编辑器类型（切换时本组件会重挂内容）。 */
  editorType: string
  /** 活动实例 id（由父层分配；`null` 表示本 Area 不承载实例）。 */
  instanceId: string | null
  /**
   * 某编辑器类型声明的资源种类（挂载时逐一 `acquire`；关闭时按**打开时那个类型**逐一 `release`）。
   *
   * ## 为什么是函数而不是数组（实测）
   *
   * 旧的 `resources: readonly string[]` 由父层按**当前** `editorType` 算好传入。切类型时
   * `props.editorType` 在关闭**之前**就变成了新类型（Vue props 先于子组件 watcher 更新），
   * 于是 `close()` 拿**新类型**的资源清单去释放**旧实例**：
   *
   * | | 旧实例实际持有 | 关闭时按什么释放 | 后果 |
   * |---|---|---|---|
   * | 切类型 viewport3d → timeline | 6 类 | timeline 的清单（空） | 6 类一个都没还 ⇒ `resourceLeakOnClose` |
   * | 反向切换 | 0 类 | viewport3d 的 6 类 | 每类一条 `releaseFailed` |
   *
   * 实测读数（`e2e/kernel-area-local-state.spec.ts` 的切类型用例，修复前）：
   * `["releaseFailed @ a1" ×8, "resourceLeakOnClose @ a1" ×2]`。
   *
   * ⇒ 释放必须按 `opened.editorType` **现取**清单；本函数就是"按类型取清单"的端口
   * （实现是 `editors/areaRegistry#resourcesOf`，本层不解释资源语义）。
   */
  resourcesOf: (editorType: string) => readonly string[]
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
   * ## 为什么是 getter 而不是值（实测）
   *
   * 旧形状是 `ledger: LifecycleLedger`（渲染期快照）。关闭发生在**卸载/换代**
   * 期间时，父层不一定重渲过这个子组件，于是 `props.ledger` 可能是若干次
   * 转移之前的旧值；`close()` 在这个旧值上 `release`/`closeInstance`，再
   * `onLedgerChange` **写回**，就把已被兄弟实例关掉的记录**复活**了。
   *
   * 实测（合并回单区后）：活跃实例 `[3,4]`、`totalActive=12`，
   * 其中 3 是在 ③ 之前已关闭、被 stale 账本写回复活的；④ 离开工作区后 3 仍留存。
   *
   * ⇒ 账本是**当前值**，不是渲染输入。每次 open/close 都现取。
   */
  getLedger: () => LifecycleLedger
  /** 账本变更回调（Vue 里账本是 prop，不能就地改）。 */
  onLedgerChange: (next: LifecycleLedger) => void
  /**
   * 本 Area 在**当前编辑器类型**下已保存的局部状态（`Workspace.layout.localState` 的值）。
   *
   * 组件挂载时读它一次（首帧就是恢复后的形态，不是"先默认再改回" ——
   * SPEC §7.3-b③「逻辑状态应在**首次呈现前**正确恢复」）。
   */
  localState?: EditorLocalState
  /** 子组件在关闭前交回的局部状态 ⇒ 父层写回布局树（`useAreaHost#captureLocalState`）。 */
  onLocalStateCapture: (areaId: string, editorType: string, state: EditorLocalState) => void
}>()

/**
 * ## `:dispose` 口已删除（留证据）
 *
 * 旧声明是一个可选 prop `dispose?: () => void`，注释说"真正的 GPU/DOM/监听释放由
 * 子组件通过 `expose` 提供"。**全 `src/` 无任何传入口**（`AreaNodeView` 的模板从未
 * 写 `:dispose`，也没有 `dispose=` 赋值），故它恒为 `undefined`：
 *
 * - 该口在运行时**永远不执行**（`close()` 里的 `try { props.dispose?.() } catch` 是死代码）；
 * - 文件头却据此声称"关闭即真释放"，与事实不符（真实释放在
 *   `WorkbenchViewport#onBeforeUnmount`：detach → 摘帧钩子 → 注销 region → `drw.dispose()`
 *   → `viewports.unregister`，以及 `RenderEngineHost#onBeforeUnmount` 的 `engine.dispose()`）。
 *
 * 选择**删除**而不是接线，理由是可证伪的：父子卸载顺序是
 * 父 `beforeUnmount` → 子卸载，而 `drw.dispose()` 不幂等（`outlinePass.dispose` +
 * `disposeCachesAndLibrary` + `mesh.dispose`）。若在本组件里再调一次"真释放"，
 * 同一份 GPU 资源会被释放两遍（第二遍作用于已释放的句柄）。⇒ 释放路径保持现状
 * （子组件自己的卸载钩子），这里只留事实记录。
 */

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
 * ## 为什么不能读 `props.instanceId` 来关（根因）
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

/**
 * 编辑器组件实例的**局部状态口**（子组件 `defineExpose({ captureLocalState })`）。
 *
 * 为什么必须走"问子组件"而不是在本层拼：局部状态是**实例私有**的
 * （各编辑器类型不同、语义不同），核心不为类型开 switch（同一纪律）。
 * 本层只负责"何时问、写到哪里"。
 */
interface EditorLocalStateHandle {
  captureLocalState?: () => EditorLocalState
}
const editorRef = ref<EditorLocalStateHandle | null>(null)

/**
 * 把编辑器当前的局部状态写回布局树（**在释放资源之前**，此时子组件仍挂着）。
 *
 * 位置很关键：`close()` 由「卸载」与「切类型/换实例」两条路共用，二者都发生在
 * 子组件还活着的时候（父 `beforeUnmount` 先于子卸载；`watch` 是 pre-flush，
 * 先于 `:key` 触发的重建）⇒ 这一刻问得到真状态。
 */
function captureEditorLocalState(): void {
  const record = opened.value
  const handle = editorRef.value
  if (record === null || handle === null) return
  const capture = handle.captureLocalState
  if (typeof capture !== 'function') return
  let state: EditorLocalState | undefined
  try {
    state = capture.call(handle)
  } catch (e) {
    emit('lifecycle-error', { areaId: props.areaId, reason: 'captureLocalStateThrew', detail: String(e) })
    return
  }
  if (state === undefined) return
  props.onLocalStateCapture(props.areaId, record.editorType, state)
}

function open(): void {
  const id = props.instanceId
  if (id === null || opened.value !== null) return
  const next = openInstance(props.getLedger(), id, props.editorType)
  if (next === null) {
    emit('lifecycle-error', { areaId: props.areaId, reason: 'instanceAlreadyOpen', detail: { instanceId: id } })
    return
  }
  let l = next
  for (const kind of props.resourcesOf(props.editorType)) {
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
 * 那会让"漏还"这条判据静默失效（实测中曾出现过这类假绿）。
 */
function close(): void {
  // 关闭只认**本组件打开的那个实例**（见 `opened` 的表：props 的 id 可能已是 null/新值）
  const record = opened.value
  if (record === null) return
  const id = record.instanceId

  // ① 先交回局部状态（此时子组件仍挂着，问得到真值；见 `captureEditorLocalState`）
  captureEditorLocalState()
  emit('instance-close', { areaId: props.areaId, instanceId: id })

  // 现取账本（不是渲染期快照）：见 `getLedger` 的说明
  let l = props.getLedger()
  // ⚠️ 按**打开时那个类型**的清单释放（见 `resourcesOf`：此刻 props.editorType 已是新类型）
  for (const kind of props.resourcesOf(record.editorType)) {
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
      这正是「保留状态不靠隐藏组件存活」在模板层的表达：
      状态在 `Workspace.layout.localState` 里，组件被重建后从那里读回。
    -->
    <component
      :is="editor"
      ref="editorRef"
      v-if="editor && instanceId"
      :key="instanceId"
      :area-id="areaId"
      :region-id="regionId ?? undefined"
      :local-state="localState"
    />
    <!--
      没有可用编辑器组件时**不留空壳**：显示明确状态。
      不暴露会假成功的按钮或空接口。
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