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
      '**R-WK-04（#250，2026-10-11）**：把实时工作台从 `RuntimeDocument` 迁到内核 `Document` 需要"旧文档 → 内核场景"装配 —— #261 实测内核 `Document` 只承载 block/annotation/camera/mesh，不承载 `frames`/`cellGrid`/`textureBlobs`/`materialPalette`/`multiblock`/`meta`，而渲染链（21 个 `render/` 文件）按后者工作；全树没有任何生产代码从旧场景文件构造内核 `Scene`。故该装配是**架构新增**而非集成收口，归 **#282（P10b）**。#261 已完成的是宿主驱动接线与 `ReadView` 读面补齐（相机组 + 播放读面），见 `runtime/kernelSession`。',
    owner: Object.freeze({ p: 'P10b', issue: 282, duty: '旧文档→内核场景装配与呈现接线' }),
    exitCondition:
      '`src/runtime/context.ts` 的 `getDoc()` 不再返回 `RuntimeDocument`（类型改为内核 `Document`），且 `src/editors/workbench-rna.ts` 的 `documentStateOf` 直接由内核 `Document` 构造 `DocumentState`（不再有 `RuntimeDocument`）。届时删除本条登记。**执行批次：#282（R-WK-04）**。',
  }),
  /**
   * P10e（#299）登记：**呈现链与 legacy 渲染链并存**（本批的显式暂存）。
   *
   * ## 为什么必须登记（而不是只在汇报里说"本批不切渲染链"）
   *
   * 按 #171 退役纪律：「阶段间暂存的未迁移路径必须有负责人和退出阶段」。
   * 本批把 `BatchedPresenter` 接成**真实生产实现**（此前零生产调用方），
   * 但它**不接管画面** —— 画面仍由 `DRW`（legacy `blockMesh`）产出。
   * 这是一条真实的双轨，必须有可核对的退出条件。
   *
   * ## 为什么本批**不**接管画面（切一半比不切更糟）
   *
   * 接管需要"DRW 消费内核求值产物"的整体切换，其前置为：
   *  - 保存面从 `ctx.getDoc()` 迁到内核投影（`raw-authority-object` 终删）；
   *  - 9 条**未装配内核**的加载路径补齐（实测：内核文档只在文件选择器与
   *    `documentLoadPipeline` 两条路径被填充）；
   *  - `Command` 封闭联合扩展（侧表写面）；
   *  - 材质统一（呈现层是 `MeshBasicMaterial`，legacy 是贴图材质库）。
   *
   * 缺任一条即"切换后能力回退且无替代" —— 那正是 #171 禁止的半成品形态。
   *
   * ## 本批交付的**可核对**能力（不是"接了但没验证"）
   *
   * - **逐格拾取**：`PresenterSession.pickAt` 解出 `{column,row,zSlice,quadIndex}`
   *   （生产视口实测：81 个采样点命中 27 次、解出 6 个不同的格，见
   *   `e2e/p10e-presenter-live.spec.ts`）；
   * - **逐像素结构性等价**：同一（由内容导出的）相机下两条链离屏渲染，
   *   覆盖率与包围盒一致（实测 `ebf-2ch` 覆盖率 0.2286/0.2286、包围盒逐维相同）。
   */
  Object.freeze({
    id: 'presenter-surface-dual-track',
    files: Object.freeze([
      'src/composition/presenterSession.ts',
      'src/shared/viewport/useViewportRuntime.ts',
      'src/runtime/drwMeshPipeline.ts',
    ]),
    newTrack:
      '`composition/presenterSession` 的 `PresenterSession`：内核场景 → `PresentationInputs` → `compileScene` → `BatchedPresenter` → 真实 GL。每帧经 `applyKernelDocument` 按**内容身份**去重（机位变化不重编，A11）；持 `PickIndex` 提供**逐格**拾取（`cell` = `{column,row,zSlice,quadIndex}`）；纹理经五态链绑定。可观测面：`ViewportSlot.presenterSurface`（批次/账/世代）。',
    oldTrack:
      '`runtime/drwMeshPipeline` 的 `blockMeshProvider` → legacy `blockMesh` 仍是**画面**的生产路径（写 `vpSlot.contentGroup`）。呈现会话有自己的根对象，**不**挂进 `contentGroup`（挂进去会让"谁画了这 24 个三角形"没有唯一答案）。',
    blocker:
      '**R-WK-07（#250，2026-10-12）**：D4（`raw-authority-object` 终删 + `RuntimeDocument` 退出生产 + G-6 + 导出面）已卷出为 **P10f（#301）** 子批 A–E；渲染链终切属子批 C/D，其前置即上方四条。本批硬约束是**能力不回退**，而"呈现链接管画面但其材质/注解/描边尚未统一"会让画面**变平**（无贴图）—— 那是可感知回退。',
    owner: Object.freeze({ p: 'P10f', issue: 301, duty: 'D4 终退统战：RuntimeDocument 退出生产、G-6 三段与导出面端口' }),
    exitCondition:
      '`src/runtime/drwMeshPipeline.ts` 的 `blockMeshProvider` 路径被删除，且视口结构层由 `src/composition/presenterSession.ts` 的 `PresenterSession` 产出（画面唯一来源是内核求值产物）；届时删除本条登记。',
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
      '旧导出器仍在生产路径上：`src/workbench/export/bundleMeshAssembly.ts` 与 `src/workbench/exportIsometricImage.ts` 消费**旧文档内容**（消费方经 `ctx.getDoc().value?.serialize()` 取 plain 文档），命令入口在 `src/operators/builtin/exportOperators.ts`（四个命令全部如此），面板在 `src/workbench/components/ExportWorkspace.vue`。',
    blocker:
      '**P10c（#286）实测修正（改写 P9 的原文，附机械证据）**：\n' +
      '① **消费者面**：四个导出命令与 `ExportWorkspace.vue` 全部经 `ctx.getDoc().value?.serialize()` 读旧文档 ⇒ 删除它们需要 `getDoc()` 的退出，而那是 `raw-authority-object` 条目（归 #289/P10d）。\n' +
      '② **几何面**：OBJ 导出经 `loadStructureOrWorld(doc)` → `collectStructureGeometryPiecesPure(def)`，其几何唯一来源是 `blockPalette[].geometry`（`render/schema/types.ts:257` → `structureGeometryCore.ts:217`）。P10c 实测：内核投影**不带回显**时 palette 条目 `withGeometry=0`、**triangles=0**（ebf-2ch 0/旧 24；帧为主真实信封 0/旧 4882）⇒ 换成内核求值后 OBJ 导出会**静默产出空几何**。这正是 R-WK-06 划给 #289 的内容面。\n' +
      // P10f/E（#301）窄授权修正（仅本句）：③ 的**前半**已不成立 —— 两个端口已有生产
      // 实现、`ExportJob` 已有生产构造点（`src/adapters/export/`；判据见
      // `tests/architecture/export-port-implementation.test.ts` 与
      // `src/adapters/export/__tests__/exportPorts.test.ts`）。仍未接的是**消费面**：
      // 四个导出命令仍走旧导出器 ⇒ 四命令迁移归主线 D/E。
      // ⚠️ 真实 GPU 填充那一段**只由 e2e 证明**（本仓 `gl@8.1.6` 是 WebGL 1.0，
      // 而 three r174 硬编码请求 `webgl2` ⇒ vitest 无真 GL 路径）。
      '③ **替代面未接线**：`runtime/exportJob.ts` 的 `ExportJob` 生产零构造点、`OffscreenRenderPort` 与 `EncoderPort` 均**零生产实现**（`export-purity.test.ts` 只锁了方法集合封闭，不锁"有人实现"）。故"导出改由 `ExportJob` 承担"当前不可执行。**P10f/E（#301）更新**：两端口的生产实现与 `ExportJob` 的生产构造点已落地（`src/adapters/export/`）；仍未接的是**消费面**（四个导出命令仍走旧导出器），四命令迁移归主线 D/E。\n' +
      '④ **文字修正**：本条的旧 `oldTrack` 曾称两个文件"从正在操作的视口取景（必要时临时改机位再恢复）"。实测**不成立**：`bundleMeshAssembly.ts` 与 `exportIsometricImage.ts` 都不 import 任何视口/相机/`ctx` 实时面，后者自建 `new THREE.WebGLRenderer` 与自建透视/正交相机（`:105,:153-168`）。"借用并旋转实时相机"发生在**截图**路径（`runtime/renderEngine.ts:215` 的 `canvas.toDataURL`），不是这两个导出器。A29 的负对照面据此收窄（见汇报）。',
    owner: Object.freeze({ p: 'P10d', issue: 289, duty: '内核内容面补全与呈现消费、渲染链终切' }),
    exitCondition:
      '`src/workbench/export/bundleMeshAssembly.ts` 与 `src/workbench/exportIsometricImage.ts` 被删除，且 `src/operators/builtin/exportOperators.ts` 的导出命令改由 `src/runtime/exportJob.ts` 的 `ExportJob` 承担（`OffscreenRenderPort`/`EncoderPort` 各有生产实现，且 OBJ 几何来自内核内容面而不再依赖旧文档回显）；届时删除本条登记。',
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
      '**R-WK-06（#250，2026-10-12）**：`deriveAssetNeeds()` 需要"文档场景 → 呈现图元（`EvaluatedPrimitive[]`）"的装配，而这属**文档内容面** —— 与 `raw-authority-object` 同一前置（内核 `Document` 不承载旧文档内容）。P9 原登记为 P10b（#282），而 #282 交付的是**多方块通道/呈现接线**，本条未在其中交付；P10c（#286）复核后按 R-WK-06 的划界改归 **#289（P10d）**（内容面补全与呈现消费）。',
    owner: Object.freeze({ p: 'P10d', issue: 289, duty: '内核内容面补全与呈现消费、渲染链终切' }),
    exitCondition:
      '`src/application/exportPlan.ts` 的 `deriveAssetNeeds()` 由已装配的图元来源产出非空清单（不再在未装配时返回空），且 `src/runtime/exportJob.ts` 的作业按该清单解析资源。届时删除本条登记。',
  }),
  /**
   * P6（#257）登记：**每视口通道暂存**（B5 #4 的消费者面）。
   *
   * ## ✅ 已核销（#282 P10b 执行）
   *
   * 本条已**退出**：`shared/viewport/useMultiblockChannels.ts` 删除，每视口
   * `state`/`revision`/`bindMultiblockMeshSync` 一并消失。取值改经
   * `EditContext.channelValues`（`runtime/kernelSession` 的 `channelValues()`/
   * `setChannelValue()` 薄转发，写面走既有的 `setChannelValue` 命令），
   * 失效由渲染侧按**内容身份**判定（`presentation/contentIdentity` +
   * `contentRefreshTick`），不再有调用方手动声明的重建范围。
   *
   * ## 为什么这条从本表**删除**（而不是留在这里标"已退出"）
   *
   * 本表的语义是"双轨**剩余**数、只应减少"（见文件头）。把已退役项留在这里
   * 会让"表长 = 双轨剩余数"这个不变量失真 —— 与 P6 当年核销自己两条时同一口径。
   * 故本条移出本表，改由 `__tests__/seams.test.ts` 的**回归断言**把守
   * （防旧机制被改回去），与 P6 处理"模块级宿主开关"的手法一致。
   *
   * 机械证据：`multiblock-channel-traversal.spec.ts` 全 552 组合遍历仍全绿，
   * `lsc-overlap` 的 108/108 组合**逐格 diff = 0**（取值变化真的驱动了重建）。
   */
  // ───────────────────────────────────────────────────────────────────────────
  // P10c（#286）核销：`property-draft-session-mirror` **已退出**
  //
  // ## 这条接缝原来是什么
  //
  // P7（#258）把草稿的**判定与提交时机**收敛到了输入层（`domain/textDraft` 三态机 +
  // `runtime/inputSession` + `InputPort.textProjection`），但 P2 的
  // `PanelSession.drafts`（每字段一份草稿文本）仍作为**呈现镜像**留在表里：
  // `PropertyInspector.onDraft` 写它、`buildField` 读它产生
  // `FieldViewModel.draft`/`draftState`，`editors/property-controls` 的 `parseDraft`
  // 做第二次解析。
  //
  // ## 为什么现在能删（本批实测，不是推理）
  //
  // 退出条件原文是"`buildField` 不再读 `session.drafts`，且 `parseDraft` 不再被
  // 呈现路径调用"。满足它需要证明删掉**不会**损失能力。两条实测给出了答案 ——
  // 这份镜像在生产里**从未生效**：
  //
  //  1. **写键与读键不同**：`PropertyInspector.onDraft` 写
  //     `localPropertyOf(desc.id)`（`lightning.block.tooltip` → `tooltip`），
  //     而 `editors/inspector.ts` 的 `makeRow` 与卸载 flush 读
  //     `localIdOf(desc.id)`（→ `block.tooltip`）。枚举生产 84 个属性，
  //     **0 处**两键相等 ⇒ 镜像喂给渲染模型的路本就不通。
  //  2. **环上没有行为**：唯一同键读取点 `buildField` 只被
  //     `FieldViewModel.draft`/`draftState` 这条链消费，而该链的消费者只有
  //     组件里那个 `props.field.draftState` 回落分支 —— 它在 (1) 之下永远拿不到值。
  //
  // 故本批删除：`PanelSession.drafts`/`sessions`、`FieldViewModel.draft`/`draftState`、
  // `FieldDraftState`、`property-controls` 的整套 `EditSession`/`EditPolicy`/
  // `tryCommit`/`canCommitDraft`（`sessions` 从未被写入使用），以及
  // `PropertyField` 的 `draft`/`commit`/`cancel` 三个 emit
  // （`commit`/`cancel` **从来没有发出点**，父级处理器本就不可达）。
  //
  // "卸载不丢字"这条能力**保留**，只是归属明确在输入层：
  // `domain/textDraft.blurControl` 的 `blur`/`focus-switch`/`enter` 经
  // `settleControl` 提交，`PropertyField` 卸载时 `unbindControl` 也会以
  // `target-invalid` 结算（判据见 `domain/__tests__/textDraft.test.ts` 的焦点切换组）。
  //
  // 表长 = 双轨剩余数，只减不增 —— 本条按该语义移出，回归断言在
  // `__tests__/seams.test.ts`（防旧机制复活）。
  // ───────────────────────────────────────────────────────────────────────────
  /**
   * P10c（#286）登记：**保真记录的传输未接通**（P9 报告的 G-6 扫尾）。
   *
   * ## 为什么必须登记（而不是继续留在报告散文里）
   *
   * P9（#260）交付了保真记录的**机制**：`captureFidelity` 采集、
   * `serializeFidelity`/`parseFidelity` 往返、`fidelityStorageKey` 旁置键、
   * `judgeFidelityAfterEdit` 三态裁定 —— 全部有测试、全部纯。
   *
   * 但 P9 当时的登记口径是"**只给键构造与序列化，不假装已接通**"，而那条缺口
   * **只写在报告里**（`temp/p09/a20-b1-conformance.md`，属随时会被删除的临时目录）。
   * 按工作区元规则「规则进指令，证据进平台」「只存在于评论里的规则 ≈ 不存在」，
   * 一个只活在报告里的缺口在 P11 审计时**无法被机械核对**。本批把它登记进本表。
   *
   * ## 缺口的三段（P10c 全树实测，零生产调用方）
   *
   *  - **(a) 生产者**：没有任何生产调用方调 `captureFidelity`。天然落点是
   *    `operators/builtin/docLifecycleOperators.ts` 的 `adoptDocumentIntoKernel`
   *    —— 它手里已有 `unknownFields`/`sourceFormat`/`sourceVersion`，但**只**在
   *    日志里数了个数，记录从未被构造。
   *  - **(b) 持久化**：`fidelityStorageKey` 给出旁置键，但 `RecoveryStorePort`
   *    的两个实现（`browserStoragePort`/`createMemoryStoragePort`）在生产里
   *    **从未被实例化**。且该键与 `recoveryStoreKey` 家族**不兼容**
   *    （缺 scope/instance 段、返回裸 `string` 而非 `Result`、无对应解析器）
   *    ⇒ "按同一个端口存"不是接线问题，而是**键口径要先统一**。
   *  - **(c) "随产物一起传"**：`SnapshotPayload`（`domain/captureSpec.ts`）与
   *    `BuildManifest`（`application/publishFormat.ts`）都是**刻意封闭**的结构
   *    （后者白名单在文件头明文说明"自由扩展位结构性不可表达"）。唯一已存在的
   *    产物侧挂点是 `composition/kernelProjection.ts` 的
   *    `KernelProjectionInput.fidelityFields` → `projectKernelDocument`
   *    （把字段写回 plain 根与 `meta.` 子树），而它本身**生产零调用方**。
   *
   * (c) 才是**真正的**缺口，且它落在"内核 → 旧格式投影"这条面上 —— 与 P10c 的
   * 渲染链/`RuntimeDocument` 条目不重叠。故本条归 **P10d**（R-WK-06 新设：#289）。
   *
   * ## 为什么本批**不**顺手实现 (a)+(b)
   *
   * 只做 (a)+(b) 会得到"记录被构造并写进本机存储，却没有任何产物带得走它"——
   * 正是 #171 禁止的半成品：新机制带着生产副作用上线，而它宣称的能力
   * （"记录随产物同行"）依然不成立，同时新增一处无读取方的生产存储实例化。
   */
  Object.freeze({
    id: 'fidelity-record-transport-unwired',
    files: Object.freeze([
      'src/adapters/files/fidelityRecord.ts',
      'src/operators/builtin/docLifecycleOperators.ts',
      'src/composition/kernelProjection.ts',
      'src/application/recovery.ts',
    ]),
    newTrack:
      '`adapters/files/fidelityRecord.ts` 的保真记录：`captureFidelity` 采集未知顶层字段（带源格式/源版本；`_extra` 显式排除）、`serializeFidelity`/`parseFidelity` 往返（读到 `_extra` 显式拒绝）、`fidelityStorageKey` 旁置键、`judgeFidelityAfterEdit` 的三态裁定（`valid`/`stale`/`dropped`）。产物侧既定挂点是 `composition/kernelProjection.ts` 的 `KernelProjectionInput.fidelityFields` → `projectKernelDocument`（写回 plain 根与 `meta.` 子树）。',
    oldTrack:
      '未知顶层字段今天**到不了任何产物**：`composition/kernelAssembly.ts` 把它们收进 `AssembledDocument.unknownFields`，而唯一消费者 `operators/builtin/docLifecycleOperators.ts` 只把键数写进一条日志（`unknownFields: Object.keys(value.unknownFields).length`）—— 记录从未被构造、从未被持久化、也没有任何产物结构接受它；故"保存 → 再打开"会静默丢掉这些字段。',
    blocker:
      '产物侧唯一挂点 `src/composition/kernelProjection.ts` 的 `projectKernelDocument` **生产零调用方**：它属"内核 → 旧格式投影"这条面，依赖内核内容面补全（P10d）。同时 `src/application/recovery.ts` 的 `RecoveryStorePort` 在生产里从未被实例化，且 `fidelityStorageKey` 与 `recoveryStoreKey` 家族的键口径不兼容（缺 scope/instance 段、返回裸 `string`、无解析器）—— 持久化半边需先统一键口径，不是接线。故本批只登记，归 P10d。',
    owner: Object.freeze({ p: 'P10d', issue: 289, duty: '内核内容面补全与呈现消费、渲染链终切' }),
    exitCondition:
      '`src/operators/builtin/docLifecycleOperators.ts` 的 `adoptDocumentIntoKernel` 调 `captureFidelity` 构造记录，且 `src/composition/kernelProjection.ts` 的 `KernelProjectionInput.fidelityFields` 有生产调用方（记录据它写回产物），使"保存 → 再打开"保留未知顶层字段；届时删除本条登记。',
  }),
])

/** 按 id 取登记项（未登记返回 `undefined`，由调用方决定是缺口还是缺陷）。 */
export function seamById(id: string): SeamRegistration | undefined {
  return SEAMS.find((s) => s.id === id)
}
