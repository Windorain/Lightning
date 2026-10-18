<script setup lang="ts">
/**
 * `WorkbenchRoot` —— 工作台外壳根组件（#249 §10；B5 退役矩阵 #7 + #10 主责）。
 *
 * ## 本组件退役的两个旧机制
 *
 * ### #10：组件挂载决定编辑状态寿命（旧 `v-show` 保活）
 *
 * 旧模板（本文件的历史版本）：
 *
 * ```vue
 * <WorkbenchShell v-show="workspace === 'preview' || workspace === 'wiki'"> ... </WorkbenchShell>
 * <WorkbenchShell v-if="workspace === 'export'"> ... </WorkbenchShell>
 * <WorkbenchShell v-if="workspace === 'materials'"> ... </WorkbenchShell>
 * ```
 *
 * `v-show` 把 preview/wiki 那个 shell **永久保活**在 DOM 里，
 * 于是"切走再切回状态还在"靠的是组件从没被卸载。
 * 后果两条：切到导出/材质时一个隐藏的 3D 视口仍在跑渲染循环；
 * 而"关闭 Area 释放运行资源"根本没有发生的机会（没有东西被关闭）。
 *
 * 现在：**只有一个工作区在 DOM 里**（`v-if` + `:key`），
 * 且切换时走 `AreaHost` 的显式生命周期（关旧实例 → 还资源 → 开新实例）。
 * 「切回恢复」由 `Workspace.layout` 的 `localState` 承载 —— 状态不在组件里。
 *
 * ### #7：公共功能模块 + profile + 外壳（旧宿主开关）
 *
 * 旧实现读 `import.meta.env.VITE_HOST_PROFILE` 并把结果交给
 * `createWorkbenchHost({ profile })`，后者写一个**模块级全局**；
 * 19 处消费点随后用 `isWikiHostProfile()` 反查。
 *
 * 现在：本组件从 `composition/shell` 取 `ShellRuntime`（装配结果），
 * 交给 `createWorkbenchHost({ shell })`，并 `provide(shellKey, shell)`。
 * **差异只有一处**：`shell.has(CAPABILITY.WIKI_UPLOAD)` 决定 Wiki 相关的
 * 布尔与钩子（Wiki 键冒泡、浮层挂载目标），而不是"宿主是不是 wiki"。
 *
 * ## 为什么 `window.__vm__` 保留
 *
 * `e2e/helpers/**` 的观测面依赖它（`e2e/helpers/multiblock/README.md` 明列）。
 * 它是**公开观测面**，不是内部状态 —— 与 #249 §5「`read` 不导出内部状态」
 * 不冲突：这里导出的是那些 helper 已经依赖的**既有公开面**，
 * 且本批不改它的形状（改形状会让全量 e2e 大面积假红，而那不是本批的目标）。
 */
import { onMounted, onBeforeUnmount, provide, ref, computed, watch } from 'vue'

import WorkbenchShell from '@/workbench/layout/WorkbenchShell.vue'
import WorkbenchSettingsDrawer from '@/workbench/components/WorkbenchSettingsDrawer.vue'
import MenubarSettingsButton from '@/workbench/components/MenubarSettingsButton.vue'
import WorkspaceTabs from '@/workbench/components/WorkspaceTabs.vue'
import StatusBar from '@/workbench/components/StatusBar.vue'
import ExportWorkspace from '@/workbench/components/ExportWorkspace.vue'
import MaterialGallery from '@/workbench/ux/panels/MaterialGallery.vue'
import EmbedViewport from '@/shared/viewport/EmbedViewport.vue'
import { buildEmbedSettingsFromMain } from '@/viewer/viewerConfig'
import type { EmbedSettings } from '@/viewer/viewerConfig'
import { createSelectionContext } from '@/context/selection'
import { provideEditHistory } from '@/context/editHistory'
import { provideToolRegistry } from '@/workbench/tools/registry'
import HostProvider from '@/runtime/HostProvider.vue'
import { createToolSettings } from '@/runtime/toolSettings'

// Operators — registered via shared VM assembly
import { createWorkbenchHost } from '@/runtime/host/workbenchHost'

import { bindChromeDom, CHROME_REGION } from '@/runtime/chromeBinder'
import { createChromeKeymapHandler } from '@/handlers/chromeKeymapHandler'
import ReadonlyLayout from '@/workbench/ux/ReadonlyLayout.vue'
import PanelTabs from '@/workbench/ux/PanelTabs.vue'

import { createContextMenu, showContextMenu, hideContextMenu, type ContextMenuItem } from '@/workbench/ux/contextMenu'
import { usePanelQueries } from '@/workbench/usePanelQueries'
import { REGION } from '@/runtime/regionIds'
import { createWikiUiState } from '@/runtime/wikiUi'
import WikiModalsHost from '@/workbench/components/WikiModalsHost.vue'
import MenubarFullscreenButton from '@/workbench/components/MenubarFullscreenButton.vue'
import MenubarWikiStatus from '@/workbench/components/MenubarWikiStatus.vue'
import {
  bindWorkbenchKeyBubbleOnWikiHost,
  getFloatingUiTeleportTarget,
  getWorkbenchAppElement,
} from '@/adapters/shellDom'
import { isWikiApiAvailable } from '@/wiki/mwApiAdapter'
import { ALL_CAPABILITIES } from '@/application/commands'
import { assembleInput, type AssembledInput } from '@/composition/assembleInput'
import { ExclusiveKeydownConflict, exclusiveKeydownOwners } from '@/adapters/inputBinding'
import { SINGLE_WORKBENCH_NOTICE } from '@/workbench/singleWorkbenchNotice'
import { workbenchCommandSink, workbenchInputHotkeys } from '@/workbench/inputHotkeys'
import AreaLayoutHost from '@/workbench/components/AreaLayoutHost.vue'

// ── 装配（B5 #7 的替代物：profile 是值，不是模块级全局）────────────────────
import { CAPABILITY } from '@/composition/modules'
import { createShellRuntimeForProfile, resolveShellProfile, shellKey, type ShellRuntime } from '@/composition/shell'
import { useKernelFrameLoop } from '@/composition/useKernelFrameLoop'
import { editorTypeRegistry } from '@/editors/builtinEditors'

/**
 * 解析本构建的外壳 profile 并构造运行实例。
 *
 * 模块级**常量**（不是 `let`）：它在组件之外只读一次，
 * 且没有任何模块能改写它 —— 这正是与旧 `hostProfile` 的差别。
 */
const shell: ShellRuntime = createShellRuntimeForProfile(resolveShellProfile(), {
  floatingUiScope: () => getWorkbenchAppElement(),
})
provide(shellKey, shell)

const wikiHost = shell.has(CAPABILITY.WIKI_UPLOAD)
/** 该外壳是否有可调整 Area 布局（旧实现靠 `VITE_HOST_PROFILE` 判断）。 */
const adjustableLayout = shell.adjustableLayout

const selection = createSelectionContext()
const editHistory = provideEditHistory(256)
const toolRegistry = provideToolRegistry()

// 共享 VM 组装
const tool = createToolSettings()
const { host, ctx, screen: defaultScreen } = createWorkbenchHost({
  selection, editHistory, toolRegistry, tool, shell,
})

// **内核帧循环**（P10 #261 / R-WK-03）：宿主按帧向内核注入时间输入。
// 挂载即开始、卸载即停止（`onMounted`/`onBeforeUnmount`），不留幽灵推进。
// 它替代的是旧 `renderEngine` 里那个"绘制 + 业务 tick 混在一起"的 RAF。
useKernelFrameLoop(ctx)

ctx.wm.chrome.wikiUi = createWikiUiState()
if (wikiHost) {
  ctx.wm.chrome.wikiUi.mwReady.value = isWikiApiAvailable()
}

provide('editorTypeRegistry', editorTypeRegistry)

const { activeToolshelfPanels, activePropertiesPanels, activeHeaderPanels } = usePanelQueries(ctx, defaultScreen)

const toolshelfCollapsed = computed(() => ctx.requireRegion(REGION.WORKBENCH_TOOLSHELF).collapsed)
const propsCollapsed = computed(() => ctx.requireRegion(REGION.WORKBENCH_PROPS).collapsed)

const embedPublish = computed(() => ctx.main.embedPublish.value)
const embedSettings = computed<EmbedSettings>(() => buildEmbedSettingsFromMain(ctx.main))

/**
 * **Area 工作区**（#282 P10b Area 产品接线）。
 *
 * ## 布局**不**归本组件
 *
 * #249 明文要求「Area 与编辑器实例的寿命不依赖组件挂载」。本组件切工作区时
 * 会被 `:key` 卸载重建（P6 刻意的 `v-show` → `v-if`），故布局若放在这里的 `ref`
 * 会随切换丢失 —— 而"切回恢复"正是 §13/A13 的判据。
 *
 * 布局因此由**宿主**在装配期创建并挂在 `Context` 上
 * （`runtime/host/workbenchHost` → `ctx.setAreaSession`）；
 * `AreaLayoutHost` 只把它渲染出来。本组件只保留一个 ref 用于把布局命令
 * 暴露给菜单/测试（见 `areaHost()`）。
 *
 * 旧形态下"工作台有几个视口"由模板写死（`WorkbenchShell` 一个
 * `<slot name="viewport">` ⇒ 恒一个 3D 视口），`AreaHost`/`useAreaHost`
 * **零生产消费者**，于是 `splitArea` 只在纯域层测试里被调用 —— #249 §13
 * 「Area 可分割、合并、切换类型」在产品里不可达。现在它可达了。
 */
const areaHostRef = ref<InstanceType<typeof AreaLayoutHost> | null>(null)

/** 供菜单/快捷键/测试驱动布局命令（与 `AreaLayoutHost` 的 provide 是同一对象）。 */
function areaHost() {
  return ctx.hasAreaSession() ? ctx.requireAreaSession() : null
}
// e2e 需要能真实触发分割（走真实命令路径，而不是替身）
;(window as unknown as Record<string, unknown>).__areaHost__ = areaHost

// Context menu
const contextMenu = createContextMenu()
const lastMousePosition = ref<{ x: number; y: number } | null>(null)

const ADD_MENU_ITEMS: ContextMenuItem[] = [
  { kind: 'label', label: '生成', icon: '＋' },
  { kind: 'separator', label: '' },
  // P10 #261：菜单项改用 **P7 命令空间 ID**（不再用 `OPERATOR_UNDO`/`OPERATOR_REDO`）。
  // 与快捷键（`WORKBENCH_APP_HOTKEYS` 的 `edit.undo`/`edit.redo`）**同一个 ID**
  // ⇒ 命令搜索可见、可用性判定只有一处（`evaluateCommandAvailability`）。
  { kind: 'operator', label: '撤销 (Ctrl+Z)', commandId: 'edit.undo' },
  { kind: 'operator', label: '重做 (Ctrl+Shift+Z)', commandId: 'edit.redo' },
]

function invokeContextMenuItem(item: ContextMenuItem) {
  // 首选：经输入端口按**命令 ID** 分发（与键盘同一条路由）。
  if (item.commandId) {
    const port = ctx.wm.inputPort
    if (port) {
      port.invokeCommand(item.commandId, item.props as Record<string, string | number | boolean> | undefined)
      return
    }
    // 端口尚未装配（极早的菜单调用）：显式记录而不是静默丢弃 ——
    // 静默丢弃会表现为"点了菜单没反应"，而那是 #249 §13 禁止的假成功控件形态。
    ctx.log.warn('菜单', `输入端口尚未装配，命令 ${item.commandId} 未分发`)
    return
  }
  // 兼容：仍在迁移中的旧 operator 项（**逐条**，不得新增）。
  if (item.opId) {
    ctx.getOperators().invoke(item.opId, item.props ?? {})
  }
}

ctx.wm.chrome.contextMenuOpen = contextMenu.open
ctx.wm.chrome.contextMenuPosition = contextMenu.position
ctx.wm.chrome.contextMenuItems = ADD_MENU_ITEMS
ctx.wm.chrome.lastMousePosition = lastMousePosition
ctx.wm.chrome.showContextMenu = (pos, items) => showContextMenu(contextMenu, pos, items)
ctx.wm.chrome.hideContextMenu = () => hideContextMenu(contextMenu)

let unbindChrome: (() => void) | null = null
let unbindWikiKeyBubble: (() => void) | null = null
let inputAssembly: AssembledInput | null = null
const floatingUiTeleportTo = ref<HTMLElement | 'body'>('body')

function refreshFloatingUiTeleport(): void {
  // B5 #7：旧实现内部 `isWikiHostProfile()`；现在传**端口**（`shell.pageKeyboard`）。
  // P7 合流裁决：保留 P6 的端口形状，**不**回退成 `isWikiHost` 布尔 —— 见
  // `adapters/shellDom.ts` 文件头"宿主差异是端口，不是宿主名"。
  floatingUiTeleportTo.value = getFloatingUiTeleportTarget(shell.pageKeyboard)
}

/**
 * 装配 P7 输入面（**唯一**的 document 事件挂载点）。
 *
 * ## B5 退役矩阵 #12（输入面）的装配侧删除记录
 *
 * 删除前，键盘由**两条** `document` capture 监听分别处理：
 * `bindChromeDom`（本组件在下面调用）与 `bindViewportDom`（各视口的
 * `host.attachViewport`）。两者都先问 `wikiInputShield` 的全局布尔、再问
 * `isEditingTarget(event.target)`，然后各自 `dispatch`。
 *
 * 现在键盘只有**一个**入口：本函数建的 `InputBinding`。`bindChromeDom` 保留
 * 的只是鼠标位置事实（见 `runtime/chromeBinder.ts` 的文件头）。
 *
 * 若有人再加一条 `keydown`，`claimExclusive` 会抛错，e2e 的挂载计数也会失败。
 */
/**
 * 草稿镜像回填入口。
 *
 * 输入事件由本装配的 **document 级**监听消费（唯一挂载点），组件拿不到返回值，
 * 故由装配层在每次事件后回调各控件的镜像刷新。镜像只由**只读投影**写入
 * （`RNAWidget.syncDraftMirror`），不是第二份权威。
 *
 * 用 `window` 上的注册表而不是 Vue `provide/inject`：`RNAWidget` 由深层面板
 * 动态渲染，装配层拿不到它们的实例；而这张表只是"谁想被通知"的登记簿。
 */
const DRAFT_MIRROR_HOOK_KEY = Symbol.for('lightning.p7.draftMirrorHook')

function refreshDraftMirrors(): void {
  const hooks = (window as unknown as Record<PropertyKey, unknown>)[DRAFT_MIRROR_HOOK_KEY] as
    | Map<string, (id: string) => void>
    | undefined
  if (hooks) for (const fn of hooks.values()) fn('')
}

/**
 * 第二个工作台实例的提示（M7-6 / Q3）。
 *
 * 结构禁止不变（`claimExclusive` 仍拒绝第二条 document keydown）；变的是**表现**：
 * 旧实现在 `onMounted` 的异步回调里抛错 ⇒ 用户只看到第二个工作台半死、没有任何解释。
 * 现在把这一种冲突收成一句人话 + 视口区内的可见提示条，其余异常照旧上抛
 * （吞掉它们会让真正的装配缺陷静默）。
 */
const singleInstanceNotice = ref<string | null>(null)

function assembleWorkbenchInput(): void {
  const hotkeys = workbenchInputHotkeys(ctx)
  try {
  inputAssembly = assembleInput({
    // P10 收口点：把老 operator 转发换成 `editorCommandSink(editor)` 即完成
    // "输入 → P1 唯一写通路"的最后一跳。当前实现逐条列明转发项，
    // 未接通的命令 ID 显式 `UnsupportedOperation`（不静默丢弃）。
    sink: workbenchCommandSink(ctx),
    // 工作台 profile 具备全部能力（查看器 profile 的裁剪归 P9/P11 的装配）
    capabilities: ALL_CAPABILITIES,
    // 晚绑定汇合：属性面板里的控件先于本装配挂载（Vue 子先父后），
    // 它们的声明暂存在待接管队列里，此处排空（否则提交报 `unboundControl`）。
    pendingControls: [...ctx.wm.pendingControlBindings],
    // "坐标 → Area"：用命中元素所属的 region 容器（`data-wm-region`）判定。
    // Area 布局的权威归属是 P6；P7 只消费这个事实。
    hitTest: (x, y, target) => {
      if (target instanceof Element) {
        const owner = target.closest('[data-wm-region]') as HTMLElement | null
        const rid = owner?.dataset.wmRegion
        if (rid) return rid
      }
      if (typeof document !== 'undefined') {
        const el = document.elementFromPoint(x, y)
        const holder = el?.closest('[data-wm-region]') as HTMLElement | null
        return holder?.dataset.wmRegion ?? null
      }
      return null
    },
    areaHotkeys: hotkeys.areaHotkeys,
    appHotkeys: hotkeys.appHotkeys,
    localActions: hotkeys.localActions,
    // P10 #261：注入当前编辑上下文 —— 需要 `contextId` 的命令（`edit.undo`/
    // `edit.redo`）才可解析。此前 `WORKBENCH_APP_HOTKEYS` 不带 params，
    // 实测被 `resolveIntent` 以 `missingParam` 拒绝 ⇒ Ctrl+Z 从未真正生效。
    contextId: ctx.requireKernelSession().contextId,
    owner: 'workbench',
    onEvent: () => {
      refreshDraftMirrors()
    },
    onTextEffects: () => {
      refreshDraftMirrors()
    },
    onResume: ({ resumeBaseline, droppedTicks }) => {
      // 恢复**不**追赶：只把基线记进诊断（#249 §9）。绝不在此补跑历史 tick。
      ctx.log.info('输入', `页面恢复：基线=${Math.round(resumeBaseline)}ms 丢弃 ${droppedTicks} tick`)
    },
  })
  } catch (e) {
    /**
     * **同页第二个工作台**（M7-0 Q3）：结构禁止保留，表现改成一句人话。
     *
     * 判据是"提示可见 + 原实例不受影响"，不是"第二个工作台能用" —— 后者会
     * 悄悄废掉 A22 的结构防御（两条 document keydown 各启动操作）。
     */
    if (e instanceof ExclusiveKeydownConflict) {
      singleInstanceNotice.value = SINGLE_WORKBENCH_NOTICE
      ctx.log.warn('工作台', SINGLE_WORKBENCH_NOTICE, { incumbent: e.incumbent, challenger: e.challenger })
      console.warn('[StructureRenderer] ' + SINGLE_WORKBENCH_NOTICE)
      return
    }
    // 别的装配异常照旧上抛：吞掉它们会把真正的缺陷变成"没有键盘"。
    throw e
  }
  ctx.wm.inputPort = inputAssembly.port
  // e2e/诊断探针（只读；不含任何领域状态）
  ;(window as any).__p7_input__ = {
    counters: () => inputAssembly?.session.counters,
    trace: () => inputAssembly?.session.trace,
    modalScopeId: () => inputAssembly?.session.routing.modal.scopeId ?? null,
    textFocus: () => inputAssembly?.session.routing.textFocus ?? null,
    textProjection: (controlId: string) => inputAssembly?.session.textProjection(controlId) ?? null,
    unhandledLocalActions: () => inputAssembly?.session.unhandledLocalActions ?? [],
    boundControlIds: () => inputAssembly?.session.boundControlIds ?? [],
    pendingControlIds: () => ctx.wm.pendingControlBindings.map((b) => b.controlId),
    applyRegistryIds: () => [...ctx.wm.applyPropertyRegistry.keys()],
    // **结构证据**：谁持有唯一的 document keydown。长度 >1 说明有人违反了 A22。
    keydownOwners: () => exclusiveKeydownOwners(),
  }
}

/**
 * 工作区选择。
 *
 * `workspace` 的取值集合来自**装配**而不是硬编码：
 * 有内容编辑能力才给"导出/材质"这类工作台专属工作区；
 * 查看器/无界面装配下 `workspaces` 只有它自己该有的那一个。
 */
const workspaces = computed<readonly WorkbenchWorkspace[]>(() => {
  const all: WorkbenchWorkspace[] = ['preview', 'wiki', 'export', 'materials']
  // 无可调整布局 ⇒ 只保留"文档 + 通道/时间"这一份固定布局（#257 明文）
  if (!adjustableLayout) return Object.freeze(['preview'] as const)
  return Object.freeze(all)
})
const workspace = ref<WorkbenchWorkspace>(workspaces.value[0] ?? 'preview')
watch(workspaces, (list) => {
  if (!list.includes(workspace.value)) workspace.value = list[0] ?? 'preview'
})
watch(workspace, (v) => {
  void ctx.getOperators().exec('OPERATOR_APPLY_SETTINGS', { uiWorkspace: v })
}, { immediate: true })
const settingsOpen = ref(false)
provide('workbenchSettingsOpen', settingsOpen)

/** 只有 `preview` / `wiki` 两个工作区承载 3D 视口与属性面板（同旧口径）。 */
const viewportWorkspace = computed(() => workspace.value === 'preview' || workspace.value === 'wiki')

onMounted(async () => {
  // 输入面**先**装配：宿主启动期间的按键也应走同一条路由
  assembleWorkbenchInput()
  unbindChrome = bindChromeDom(ctx, createChromeKeymapHandler(CHROME_REGION, () => ctx))
  await host.start()
  refreshFloatingUiTeleport()
  // B5 #7 保留：宿主差异走**端口**（`shell.pageKeyboard`）而不是宿主名。
  // 端口为 `null`（= 无宿主接管页面键盘）时该函数自身不安装任何监听。
  {
    const app = getWorkbenchAppElement()
    if (app) unbindWikiKeyBubble = bindWorkbenchKeyBubbleOnWikiHost(app, shell.pageKeyboard)
  }
  document.addEventListener('fullscreenchange', refreshFloatingUiTeleport)
})

onBeforeUnmount(() => {
  unbindChrome?.()
  unbindChrome = null
  unbindWikiKeyBubble?.()
  unbindWikiKeyBubble = null
  // 宿主显式销毁（M7-6）：摘掉视口 attach + 注销 `window.__log__` 的**本实例登记**。
  // 不销毁会让读面继续指向一个已销毁的 ctx —— 与"实例还在跑"同形。
  host.destroy()
  inputAssembly?.dispose()
  inputAssembly = null
  if (ctx.wm.inputPort !== null) ctx.wm.inputPort = null
  delete (window as any).__p7_input__
  document.removeEventListener('fullscreenchange', refreshFloatingUiTeleport)
})

// VM 句柄：测试层通过 window.__vm__ 访问公开观测面
;(window as any).__vm__ = ctx
;(window as any).__vm_ready__ = true


ctx.log.injectStateRefs({
  // #301 P10f D2：快照从**内核投影**取（未装配自动回落旧文档）。
  scene: () => ctx.plainForSave().plain as any,
  selection: () => [...selection.items.value].filter(e => e.kind === 'block').map(e => e.ref),
  toolRegistry: () => ({
    activeToolId: toolRegistry.activeTool.value?.id ?? 'none',
    canUndo: editHistory.canUndo.value,
    canRedo: editHistory.canRedo.value,
    undoLabel: editHistory.undoLabel.value,
    redoLabel: editHistory.redoLabel.value,
  }),
})

/** 工作区标签（导出/材质是工作台专属；查看器装配下 `workspaces` 里没有它们）。 */
type WorkbenchWorkspace = 'preview' | 'wiki' | 'export' | 'materials'
</script>

<template>
  <HostProvider :host="host" :ctx="ctx">
    <!--
      **同页第二个工作台**（M7-6 / Q3）：结构禁止不变，给一句人话 + 可见提示。
      提示落在实例根内（不是 document.body）：同页两个实例时，用户能看出是**哪一个**
      实例没接管键盘；它也随本实例卸载一起消失，不留全局残留。
    -->
    <div
      v-if="singleInstanceNotice"
      class="wm-single-instance-notice"
      role="alert"
      data-lk-workbench-conflict="1"
    >
      {{ singleInstanceNotice }}
    </div>
    <!--
      #10：`v-show` → `v-if` + `:key`。
      只有一个工作区在 DOM 里；切换即**卸载旧组件**（不是隐藏它）。
      `:key="workspace"` 保证切换工作区时组件被真正重建 ——
      于是"切换时旧视口的渲染循环/监听/作业确实结束了"，
      而"切回状态还在"只能来自 `Workspace` 的 `localState`（不在组件里）。

      变基合流（× P2 #253）：面板渲染改经 `ReadonlyLayout` + `@operator`
      （P2 的只读呈现面），应用 P6 的显式生命周期与 `adjustableLayout` 闸门。
    -->
    <WorkbenchShell v-if="viewportWorkspace" :key="`ws-${workspace}`">
      <template #menubar>
        <div class="wb-menubar-inner">
          <ReadonlyLayout
            v-for="panel in activeHeaderPanels"
            :key="panel.id"
            :layout="panel.layout"
            @operator="(id: string, p?: Record<string, unknown>) => ctx.getOperators().exec(id, p)"
          />
          <MenubarWikiStatus />
          <MenubarSettingsButton />
          <MenubarFullscreenButton />
        </div>
      </template>
      <!-- 布局编辑命令按装配裁剪：固定布局外壳（查看器/嵌入）不给工作区标签 -->
      <template v-if="adjustableLayout" #workspace-tabs>
        <WorkspaceTabs :model-value="workspace" @update:model-value="workspace = $event" />
      </template>
      <template v-if="workspace !== 'wiki' && !toolshelfCollapsed" #tool-shelf>
        <div class="wb-toolshelf" :data-wm-region="REGION.WORKBENCH_TOOLSHELF">
          <template v-for="panel in activeToolshelfPanels" :key="panel.id">
            <component v-if="panel.component" :is="panel.component" :ctx="ctx" />
            <ReadonlyLayout
              v-else
              :layout="panel.layout"
              @operator="(id: string, p?: Record<string, unknown>) => ctx.getOperators().exec(id, p)"
            />
          </template>
        </div>
      </template>
      <template #viewport>
        <!--
          #282 P10b：单视口 slot → **Area 分割树渲染**。
          `AreaLayoutHost` 把一个 Area（初始）渲染成 `AreaHost` + `WorkbenchViewport`；
          分割后自动多出第二个（各有自己的 region ⇒ 自己的机位与视口槽位）。
          无文档时仍是占位态（`WorkbenchViewport` 自己显示 No scene loaded）。
        -->
        <AreaLayoutHost
          v-if="workspace === 'preview'"
          ref="areaHostRef"
        />
        <div v-else-if="workspace === 'wiki' && ctx.hasLoadedDocument()" class="wb-wiki-embed">
          <EmbedViewport :settings="embedSettings" :style="{ width: `${embedPublish.viewWidth}px`, height: `${embedPublish.viewHeight}px` }" />
        </div>
      </template>
      <template v-if="!propsCollapsed" #properties>
        <PanelTabs :panels="activePropertiesPanels" :ctx="ctx" @operator="(id: string, p?: Record<string, unknown>) => ctx.getOperators().exec(id, p)" />
      </template>
      <template #statusbar>
        <StatusBar />
      </template>
    </WorkbenchShell>

    <WorkbenchShell v-else-if="workspace === 'export'" :key="`ws-${workspace}`">
      <template #menubar>
        <div class="wb-menubar-inner">
          <ReadonlyLayout
            v-for="panel in activeHeaderPanels"
            :key="panel.id"
            :layout="panel.layout"
            @operator="(id: string, p?: Record<string, unknown>) => ctx.getOperators().exec(id, p)"
          />
          <MenubarWikiStatus />
          <MenubarSettingsButton />
          <MenubarFullscreenButton />
        </div>
      </template>
      <template #workspace-tabs>
        <WorkspaceTabs :model-value="workspace" @update:model-value="workspace = $event" />
      </template>
      <template #viewport>
        <ExportWorkspace />
      </template>
      <template #statusbar>
        <StatusBar />
      </template>
    </WorkbenchShell>

    <WorkbenchShell v-else-if="workspace === 'materials'" :key="`ws-${workspace}`">
      <template #menubar>
        <div class="wb-menubar-inner">
          <ReadonlyLayout
            v-for="panel in activeHeaderPanels"
            :key="panel.id"
            :layout="panel.layout"
            @operator="(id: string, p?: Record<string, unknown>) => ctx.getOperators().exec(id, p)"
          />
          <MenubarWikiStatus />
          <MenubarSettingsButton />
          <MenubarFullscreenButton />
        </div>
      </template>
      <template #workspace-tabs>
        <WorkspaceTabs :model-value="workspace" @update:model-value="workspace = $event" />
      </template>
      <template #viewport>
        <MaterialGallery />
      </template>
      <template #statusbar>
        <StatusBar />
      </template>
    </WorkbenchShell>

    <WorkbenchSettingsDrawer />

    <!-- ContextMenu floating overlay -->
    <Teleport :to="floatingUiTeleportTo">
      <Transition name="menu-pop">
        <div
          v-if="ctx.wm.chrome.contextMenuOpen?.value ?? false"
          class="context-menu-overlay"
          @click="hideContextMenu(contextMenu)"
          @contextmenu.prevent
        >
          <div
            class="context-menu-popup"
            :style="{ left: (ctx.wm.chrome.contextMenuPosition?.value.x ?? 0) + 'px', top: (ctx.wm.chrome.contextMenuPosition?.value.y ?? 0) + 'px' }"
            @click.stop
          >
            <template v-for="(item, i) in ((ctx.wm.chrome.contextMenuItems ?? []) as ContextMenuItem[])" :key="i">
              <hr v-if="item.kind === 'separator'" class="cm-sep" />
              <span v-else-if="item.kind === 'label'" class="cm-label">{{ item.label }}</span>
              <button
                v-else-if="item.kind === 'operator'"
                class="cm-item"
                @click="invokeContextMenuItem(item); hideContextMenu(contextMenu)"
              >
                <span v-if="item.icon" class="cm-icon">{{ item.icon }}</span>
                {{ item.label }}
              </button>
            </template>
          </div>
        </div>
      </Transition>
    </Teleport>
    <WikiModalsHost v-if="ctx.wm.chrome.wikiUi" :ctx="ctx" />
  </HostProvider>
</template>

<style scoped>
/* 第二个工作台实例的提示条（M7-6 / Q3）。
   刻意**在文档流内**而不是 fixed：fixed 会横跨整页、盖住**第一个**实例的 UI
   （实测：同页双实例页面上它的点击会拦截另一个实例的视口，把"原实例不受影响"
   这条判据自己弄坏）。在流内 ⇒ 只占本实例自己的一块高度。 */
.wm-single-instance-notice {
  padding: 8px 12px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--wb-text);
  background: var(--wb-warn, #7a5a00);
  border-bottom: 1px solid var(--wb-border);
}

/* 工具架 = 编辑视口 Area 内的**悬浮 Region**（用户裁决 2026-10-17）：
   position:absolute 浮在视口左上，不占布局流、不挤压 canvas。
   `data-wm-region="r-toolshelf"` 落在本元素上（见模板），于是指针命中的是
   「工具架」而不是整条视口条带 —— 这正是 `runtime/regionIds.ts:4` 声明了
   却一直无 DOM 宿主的缺口。 */
.wb-toolshelf {
  position: absolute; top: 4px; left: 4px; z-index: 100;
  display: flex; flex-direction: column; gap: 2px;
  padding: 4px;
  background: var(--wb-bg-elevated);
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}
.wb-menubar-inner {
  display: flex;
  align-items: center;
  height: 100%;
  padding: 0 10px;
}
.wb-menubar-inner :deep(.ux-menu-btn) {
  border: none;
  background: transparent;
  padding: 5px 10px;
  font-size: 13px;
  color: var(--wb-accent-muted);
  cursor: pointer;
}
.wb-menubar-inner :deep(.ux-menu-btn:hover) {
  background: var(--wb-bg-hover);
  border-radius: var(--wb-radius-sm);
  color: var(--wb-text);
}
.wb-menubar-inner :deep(.ux-arrow) { display: none; }
.wb-menubar-inner :deep(.ux-operator-btn) {
  border: none;
  background: transparent;
  padding: 5px 10px;
  font-size: 13px;
  color: var(--wb-accent-muted);
  width: auto;
  cursor: pointer;
}
.wb-menubar-inner :deep(.ux-operator-btn:hover) {
  background: var(--wb-bg-hover);
  border-radius: var(--wb-radius-sm);
  color: var(--wb-text);
}
.wb-menubar-inner :deep(.ux-label) {
  font-size: 13px;
  color: var(--wb-text-dim);
  padding: 0 4px;
}

/* ---- Wiki embed ---- */
.wb-wiki-embed {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  overflow: auto;
  background: var(--wb-viewport-bg);
  background-image:
    linear-gradient(var(--wb-grid-color) 1px, transparent 1px),
    linear-gradient(90deg, var(--wb-grid-color) 1px, transparent 1px);
  background-size: 32px 32px;
}
</style>

<style>
.context-menu-overlay {
  position: fixed; inset: 0; z-index: 50001;
  pointer-events: auto;
}
.context-menu-popup {
  position: absolute;
  min-width: 160px;
  background: var(--wb-bg-elevated);
  border: 1px solid var(--wb-border);
  border-radius: 4px;
  padding: 4px 0;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
}
.cm-item {
  display: block; width: 100%; padding: 4px 12px;
  border: none; background: transparent; color: var(--wb-text);
  font-size: 13px; text-align: left; cursor: pointer;
}
.cm-item:hover { background: var(--wb-bg-hover); }
.cm-label {
  display: block; padding: 2px 12px; font-size: 11px; color: var(--wb-text-dim);
}
.cm-sep { margin: 4px 8px; border: none; border-top: 1px solid var(--wb-border); }
.cm-icon { margin-right: 6px; }

.menu-pop-enter-active {
  transition: opacity 0.1s ease, transform 0.12s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.menu-pop-leave-active {
  transition: opacity 0.08s ease;
}
.menu-pop-enter-from {
  opacity: 0;
  transform: scale(0.95) translateY(-4px);
}
.menu-pop-leave-to {
  opacity: 0;
}

</style>
