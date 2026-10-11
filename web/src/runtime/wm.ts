import type { Ref } from 'vue'
import { EventDispatcherImpl } from '@/events/dispatcher'
import type { createLogCenter } from '@/logging/LogCenter'
import type { ContextMenuItem } from '@/workbench/ux/contextMenu'
import type { ShellSettings } from '@/runtime/shellSettings'
import type { WikiUiState } from '@/runtime/wikiUi'
import type { InputPort } from '@/runtime/inputPort'
import type { ControlBinding } from '@/application/inputCommands'
import { createShellSettings, type CreateShellSettingsOptions } from '@/runtime/shellSettings'
import { createDiagnosticRecorder, type DiagnosticRecorder } from '@/application/diagnostics'

export interface WMChrome {
  contextMenuOpen?: Ref<boolean>
  contextMenuPosition?: Ref<{ x: number; y: number }>
  contextMenuItems?: ContextMenuItem[]
  lastMousePosition?: Ref<{ x: number; y: number } | null>
  showContextMenu?(pos: { x: number; y: number }, items: ContextMenuItem[]): void
  hideContextMenu?(): void
  wikiUi?: WikiUiState
}

export class WM {
  readonly events: EventDispatcherImpl
  readonly settings: ShellSettings
  /**
   * 有界结构化诊断（#249 §19.9 / #259 A35）。
   *
   * 容量在这里**显式**给出（默认 512）：容量是运行配置，
   * 而"必须有容量"是契约（`createDiagnosticRecorder` 的必填参数）。
   * 挂在 WM 上 ⇒ **每实例一份**，同页两实例的诊断互不混杂。
   */
  readonly diagnostics: DiagnosticRecorder
  readonly chrome: WMChrome = {}
  /**
   * **输入端口**（P7 #258）：呈现层声明焦点/弹窗/控件绑定等**显式状态**的唯一入口。
   *
   * 为什么放在 `WM` 而不加在 `Context` 上：它是**外壳级**的（`WM` 本来就持有事件
   * 分发器与 chrome 状态），而 `Context` 是 #249 §2.3 点名要退役的"万能 Context"——
   * 继续往它上面加字段正是那一条禁止的方向。
   *
   * 装配层（`WorkbenchRoot`）在启动时注入实现。未注入时 `requireInputPort()` 抛错 ——
   * **不**静默降级成一个什么都不做的空端口：那会让"输入没生效"表现为"点了没反应"。
   */
  inputPort: InputPort | null = null

  /**
   * **属性提交落点注册表**（P7 #258）：`controlId` → "把完整合法的领域值写进旧文档"。
   *
   * ## 为什么需要它，以及它为什么是**临时**的
   *
   * 草稿三态机判出 `complete` 后要落到领域上。P1 的落点是 `setProperty` 命令
   * （经 `Editor.submit`）；但工作台的**真实文档**仍是旧 `RuntimeDocument`
   * （P1 已知缺口，归口 P10），`RNAWidget` 的 `descriptor.set(owner, value)` 才是
   * 今天真正的写点。
   *
   * 若在 `application/inputCommands` 里直接调它，`application` 就得认识
   * 呈现层的 widget —— 那是分层倒置。故由**呈现层登记自己的写点**，
   * 命令层只发 `draft.commit`，装配层按 `controlId` 找到落点。
   *
   * P10 把真实文档换成 P1 的类型化文档后，本表整个删除，
   * `draft.commit` 直接映射成 `setProperty`（`application/inputCommands` 已有该分支）。
   *
   * 登记边见 `tests/architecture/kernel-legacy-isolation.test.ts` 的
   * `REGISTERED_LEGACY_CONSUMERS`（**不得静默**）。
   */
  readonly applyPropertyRegistry = new Map<string, (value: number | string) => void>()

  /**
   * **待接管**的控件绑定（晚绑定汇合点）。
   *
   * ## 为什么需要它（P7 首跑 e2e 实测到的真实缺陷）
   *
   * Vue 的挂载顺序是**子先父后**：属性面板里的 `RNAWidget` 在
   * `WorkbenchRoot.onMounted`（真到那一刻才 `assembleInput` 并写 `wm.inputPort`）
   * **之前**就挂载完了。若组件在 `onMounted` 里直接 `wm.inputPort.bindControl(...)`，
   * 读到的必然是 `null` —— 结果是控件**从未**登记，提交时报
   * `UnsupportedOperation: reason=unboundControl`（实测轨迹原文）。
   *
   * 这个集合是"控件先到、端口后到"的汇合点：
   *  - 端口未就绪 ⇒ 控件把声明放这里；
   *  - 装配完成 ⇒ `assembleInput` 排空它并逐条 `bindControl`。
   *
   * 晚挂载的控件（切面板 tab 才渲染）走直连路径，不进这里。
   */
  readonly pendingControlBindings: ControlBinding[] = []

  /** 取输入端口；未装配即抛（不静默降级）。 */
  requireInputPort(): InputPort {
    if (this.inputPort === null) {
      throw new Error('输入端口尚未装配：装配层须在启动时注入 wm.inputPort（P7 #258）')
    }
    return this.inputPort
  }

  constructor(
    log?: ReturnType<typeof createLogCenter>,
    shellOptions?: CreateShellSettingsOptions,
    diagnosticsOptions?: { capacity?: number; now?: () => number },
  ) {
    this.events = new EventDispatcherImpl(log)
    this.settings = createShellSettings(shellOptions)
    this.diagnostics = createDiagnosticRecorder({
      capacity: diagnosticsOptions?.capacity ?? 512,
      now: diagnosticsOptions?.now ?? (() => Date.now()),
    })
    // 内容拒绝事实 → 诊断通道的**报告函数**由 HostProvider 注入给呈现边界
    // （见 runtime/HostProvider.vue 与 editors/contentBoundary.ts）。
  }
}
