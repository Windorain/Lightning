/**
 * `composition/seams` —— **暂存双轨的登记表**（#250 GF-5 收敛项 4）。
 *
 * ## 这份表是什么
 *
 * #249 §15 的退役矩阵列出 13 条"旧机制 → 目标分层"的迁移。其中若干条**不可能**
 * 在某一个批次的边界内一次退完：退出需要消费者先迁走，而消费者属别的批次。
 * 这类"新机制已交付、旧路径仍在服役"的**过渡态**必须显式登记 ——
 * 否则它就从"有期限的暂存"退化成"长期并存"，而 AGENTS.md 的退役纪律
 * （#171）明文规定：**阶段间暂存的未迁移路径必须有负责人和退出阶段**。
 *
 * `boundary-rules.mjs` 的 `RETIREMENT_OWNERS` 登记的是**§15 那 13 条**本身；
 * 本表登记的是**代码里当下真实存在的双轨接缝**（seam）——粒度更细、可逐条对应到
 * 文件与函数，并且**带退出条件**。两者是"任务清单"与"现状清单"的关系。
 *
 * ## 为什么放在 `composition/`
 *
 * `composition/` 是 #249 §4 的九个目标分层之一（"装配"，无旧对应物），
 * 它的职责正是"把各层装到一起"——而**接缝恰好是装配问题**：
 * 哪条路径还没接通、临时由谁代偿、什么时候拆掉。放在 `domain/` 会让纯核心
 * 知道迁移事务；放在 `editors/` 会把装配事实藏进某个编辑器实现。
 *
 * ## 本表是**声明**而非机制
 *
 * 它不改变任何运行时行为，只让"双轨在哪、谁负责、何时退出"可被静态核对
 * （`tests/architecture/boundary-scan.test.ts` 逐条断言字段完整）。
 * 每条 `exitCondition` 必须是**可判定的**：写"迁移完成后"是空话，
 * 写"`workbench-rna.ts` 不再 import `RuntimeDocument`"才可核对。
 */

/** 一条暂存双轨的登记项。 */
export interface SeamRegistration {
  /** 稳定标识（非空、kebab-case，供测试与报告引用）。 */
  readonly id: string
  /** 涉及的文件（相对 `web/`，正斜杠）。 */
  readonly files: readonly string[]
  /** 新轨（已交付的权威路径）。 */
  readonly newTrack: string
  /** 旧轨（仍在服役、待退出的路径）。 */
  readonly oldTrack: string
  /**
   * 为什么不能在本批退完 —— 必须指向**具体的外部依赖**，
   * 而不是"工作量大"这类无法核对的说法。
   */
  readonly blocker: string
  /** 负责批次（`P<N>`）与执行单号。 */
  readonly owner: { readonly p: string; readonly issue: number; readonly duty: string }
  /**
   * **退出条件**（可静态核对的判据）。退出=删掉 `oldTrack`，
   * 并把本条从本表移除（本表的长度就是"双轨剩余数"，只应减少）。
   */
  readonly exitCondition: string
}

/**
 * 当下登记在案的接缝。**新增双轨必须在此登记**（否则 `test:arch` 会因
 * `boundary-scan.test.ts` 的"登记项字段完整"+数量对账而提醒）。
 *
 * P6（#257）按 R-WK-01 归口义务在此登记 `per-viewport-channel-staging`
 * （该文件属 P6 区；相位按 R-WK-03 归 #261）。
 * P6 自己**已核销**的两条（模块级宿主开关、组件挂载决定状态寿命）
 * **不**登记进本表 —— 本表语义是"双轨**剩余**数、只应减少"，
 * 把已退役项塞进来会违背该口径；那两条改由
 * `composition/__tests__/seams.test.ts` 的**回归断言**把守（防被改回去）。
 */
export const SEAMS: readonly SeamRegistration[] = Object.freeze([
  Object.freeze({
    id: 'kernel-property-write-dual-track',
    files: Object.freeze([
      'src/editors/workbench-rna.ts',
      'src/application/property-commands.ts',
      'src/application/kernel-properties.ts',
    ]),
    newTrack:
      '内核侧唯一写入口：#253 的 `reduceCommand` → `reduceSetProperty` → RNA 注册表 + `applySetProperty`（`application/kernel-properties.ts` 注册 block/annotation/camera 的属性语义）',
    oldTrack:
      '实时工作台的面板写路径仍落在**旧运行时文档**上：`editors/workbench-rna.ts` 的 `submitPropertyWrite`/`documentStateOf` 经 `ctx.getDoc()` 读文档，而 `runtime/context.ts` 的 `getDoc()` 类型是旧 `RuntimeDocument`（`getDoc(): Ref<RuntimeDocument | null>`），再包成 `DocumentState` 传给 `applySetProperty`。机制已是同一套（同一个 RNA 表与同一个原子写路由），但**数据模型**仍是旧的 `RuntimeDocument` 而非内核的 `Scene`/`Document`。',
    blocker:
      '把实时工作台从 `RuntimeDocument` 迁到内核 `Document`/`ApplicationState` 属**工作区/Area 装配**面（`boundary-rules.mjs` 的 `RETIREMENT_OWNERS["runtime-document-triple-duty"]` 归口 P4/P9；面积/外壳归 P6），不在 #253 的退出边界内（#253 退出边界：不做 Area/外壳）。',
    owner: Object.freeze({ p: 'P10', issue: 261, duty: '集成闭环与交叉验收' }),
    exitCondition:
      '`src/runtime/context.ts` 的 `getDoc()` 不再返回 `RuntimeDocument`（类型改为内核 `Document`），且 `src/editors/workbench-rna.ts` 的 `documentStateOf` 直接由内核 `Document` 构造 `DocumentState`（不再有 `RuntimeDocument`）。届时删除本条登记。',
  }),
  /**
   * P9（#260）登记：**固定快照导出已交付，旧导出器仍在服役**。
   *
   * 这是 B5 退役矩阵第 13 条（`exporter-borrows-live-viewport`）在**代码现状**上的形态：
   * 替代机制（内核侧固定快照导出作业）已交付且可静态核对，但它的**消费面**
   * （工作台的导出命令与面板）仍走旧导出器 —— 而旧导出器借用实时视口正是要退役的行为。
   *
   * 为什么本批不删旧导出器：按 R-WK-03（#250 裁决 2026-10-11），**内核→生产接线**
   * （宿主创建 Editor、按帧注入时间输入、渲染消费求值结果）是 #261 的核心内容；
   * 因为内核尚未接线，旧导出器此刻是生产唯一路径，删除即能力停摆且无替代
   * （#171 明令禁止的半成品替换形态）。
   */
  Object.freeze({
    id: 'export-borrows-live-viewport-dual-track',
    files: Object.freeze([
      'src/domain/captureSpec.ts',
      'src/application/exportPlan.ts',
      'src/runtime/exportJob.ts',
      'src/workbench/export/bundleMeshAssembly.ts',
      'src/workbench/exportIsometricImage.ts',
      'src/operators/builtin/exportOperators.ts',
      'src/workbench/components/ExportWorkspace.vue',
    ]),
    newTrack:
      '内核侧固定快照导出（#260）：`domain/captureSpec` 把取景复制成 `CameraSpec` 值、把采样时间算成冻结的 `CaptureTime` 序列；`application/exportPlan` 组装**不可变**请求并在预检处默认失败；`runtime/exportJob` 的离屏端口只有 `acquire/renderFrame/release`（**没有**取实时相机/视口的方法）。静态判据见 `web/tests/architecture/export-purity.test.ts`。',
    oldTrack:
      '旧导出器仍在生产路径上：`workbench/exportIsometricImage.ts` 与 `workbench/export/bundleMeshAssembly.ts` 从**正在操作的视口**取景（必要时临时改机位再恢复），命令入口在 `operators/builtin/exportOperators.ts`，面板在 `workbench/components/ExportWorkspace.vue`；A29 负对照「导出借用并旋转实时相机」描述的正是这条轨道。',
    blocker:
      '内核→生产接线（宿主创建 Editor、按帧注入时间输入、渲染消费求值结果）是 #261 的核心内容（R-WK-03），而旧导出器的**消费者**（导出命令与面板）位于生产旧路径上。接线完成前删除旧导出器 = 能力停摆且无替代。',
    owner: Object.freeze({ p: 'P10', issue: 261, duty: '集成闭环与交叉验收' }),
    exitCondition:
      '`src/workbench/export/bundleMeshAssembly.ts` 与 `src/workbench/exportIsometricImage.ts` 被删除，且 `src/operators/builtin/exportOperators.ts` 的导出命令改由 `src/runtime/exportJob.ts` 的 `ExportJob` 承担（不再从实时视口取景）。届时删除本条登记。',
  }),
  /**
   * P9（#260）登记：**导出资源清单的产出方式**尚未接线。
   *
   * A29 要求「产物对应 S0 与**资源清单**」，且「缺必需资源时预检失败」。预检本身
   * 已交付且被测试覆盖（`src/application/__tests__/snapshotExport.test.ts` 的预检组），
   * 但**清单从哪来**这一步还没有生产调用方：
   *
   *  - 新轨：请求携带显式资源清单（`normalizeAssetNeeds`）或由已装配的导入器反推；
   *  - 旧轨：旧导出器（`workbench/export/bundleMeshAssembly.ts`）直接从旧文档与
   *    纹理库取资源，**不经过**任何"必需/可选 + 内容版本"的清单；
   *  - 缺口：`application/exportPlan.ts` 的 `deriveAssetNeeds()` 在未装配时返回空清单，
   *    并在函数注释里**显式登记**该事实（不伪造图元、不假装"无需资源"）。
   *
   * 这条接缝的存在使 P11 的终局审计能机械核对"资源清单是否仍靠手列/靠旧路径取"。
   */
  Object.freeze({
    id: 'export-asset-manifest-unwired',
    files: Object.freeze([
      'src/application/exportPlan.ts',
      'src/runtime/exportJob.ts',
      'src/presentation/compileScene.ts',
      'src/workbench/export/bundleMeshAssembly.ts',
    ]),
    newTrack:
      '导出请求的 `assets` 是显式清单（`ExportAssetNeed[]`：稳定资源 ID + 内容版本 + 必需/可选 + 获取位置），由 `normalizeAssetNeeds()` 单点规范化；预检经 `presentation/assetState.preflightRequiredAssets()` 判必需资源是否就绪（五态，不把占位当完整）。',
    oldTrack:
      '旧导出器（`workbench/export/bundleMeshAssembly.ts`）在烘焙时直接从旧文档与纹理库取资源：没有"必需/可选"的声明，也没有内容版本参与的就绪判定，故"缺资源"表现为烘焙结果里少一块而不是预检失败。',
    blocker:
      '"文档场景 → 呈现图元（`EvaluatedPrimitive[]`）"的装配属 P10/#261 的集成闭环内容（内核尚未接线进生产，R-WK-03）；P9 交付的是**清单的形状、规范化与预检判据**，不是图元装配。',
    owner: Object.freeze({ p: 'P10', issue: 261, duty: '集成闭环与交叉验收' }),
    exitCondition:
      '`src/application/exportPlan.ts` 的 `deriveAssetNeeds()` 由已装配的图元来源产出非空清单（不再在未装配时返回空），且 `src/runtime/exportJob.ts` 的作业按该清单解析资源。届时删除本条登记。',
  }),
  /**
   * P6（#257）登记：**每视口通道暂存**（B5 #4 的消费者面）。
   *
   * 归口依据：R-WK-01 实施细则「跨区旧文件的退役删除由**文件所在区批次**执行，
   * 语义替代方提供替代接口与删除点清单」—— 该文件属 P6 区。
   *
   * 相位（R-WK-03 修正，2026-10-11）：删除前置条件是**内核接线生产**，
   * 目标批次由 P6 改为 **#261（P10 集成闭环）**。
   * 依据：本表登记时实测「新内核尚未接线生产」——
   * `web/src` 下 `new Editor(` 零生产构造、`runtime/evaluation.ts` 零导入者、
   * 没有任何生产调用方推进 `EditContext` 时间（`advanceContextTime` 零生产调用方），
   * 生产入口（`workbench/WorkbenchRoot.vue`、`dev/DevApp.vue`、
   * `runtime/host/workbenchHost.ts`）均不 import 内核。
   * ⇒ 内核未接线的状态下把消费者迁到 `EditContext`，会得到"读面永远静止"的**行为回退**
   * （通道取值改动不再驱动重建）；那是 #171 禁止的"留半成品"，故整组闭环归 #261。
   */
  Object.freeze({
    id: 'per-viewport-channel-staging',
    files: Object.freeze([
      'src/shared/viewport/useMultiblockChannels.ts',
      'src/shared/viewport/EmbedViewport.vue',
      'src/workbench/components/WorkbenchViewport.vue',
    ]),
    newTrack:
      '通道取值归 **P1 的 `EditContext.channelValues`**（同一编辑上下文的所有 Area 读到同一份值，#249 §3.3/§3.4）+ **P4（#255）的统一通道求值面**（`application/evaluation.ts` 纯求值、装配是纯函数、失效由依赖图自动传播，无调用方手动 refresh）',
    oldTrack:
      '`shared/viewport/useMultiblockChannels.ts` 的**每视口暂存副本**：每个视口自持 `state`（总 Tier / 通道取值 / 运行态）、`revision` 计数与 `bindMultiblockMeshSync()` 的手工链式刷新。这正是 B5 矩阵 #4「每视口独立暂存、重复选择副本」与「手动链式刷新」两条 slug 的共同消费者面 —— 于是"同上下文所有 Area 可见的有效读面"并不存在（每个视口只能读到自己那份）。',
    blocker:
      '**内核尚未接线生产**（R-WK-03）：#261（P10 集成闭环）需先完成宿主驱动接线，把 `EditorClient`/求值面/时间推进接进生产入口，随后消费者迁移与字段删除才有语义。实测（模块图级，非目视）：`new Editor(` 在生产代码零构造、`runtime/evaluation.ts` 零导入者、`advanceContextTime` 零生产调用方。此状态下来替换只能是半成品（读面静止）或把旧实现搬进新层（#171 禁止）。',
    owner: Object.freeze({ p: 'P10', issue: 261, duty: '集成闭环与交叉验收' }),
    exitCondition:
      '删除 `src/shared/viewport/useMultiblockChannels.ts`（其每视口 `state`/`revision`/`bindMultiblockMeshSync` 一并消失），通道取值改经 `EditContext.channelValues`、装配经 `application/evaluation.ts` 的纯求值；届时删除本条登记。',
  }),
])

/** 按 id 取登记项（未登记返回 `undefined`，由调用方决定是缺口还是缺陷）。 */
export function seamById(id: string): SeamRegistration | undefined {
  return SEAMS.find((s) => s.id === id)
}
