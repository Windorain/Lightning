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
   *
   * ## 退出条件必须是**两个子句**，不是一个（R1-α 补；R0-3 判据补丁）
   *
   * 只用"能力/登记条件"当退出条件会产生**假退出**：能力落地的当天，
   * 旧机制可能一行未动。实测反例（本表内）：`legacy-grid-edit-handle` 的原退出条件
   * 写的是「`Command` 联合含 `moveCells` 且 `moveTranslate.ts` 经
   * `Context#submitContentEdit` 发起移动」—— 前半句在 R1-α 落地 `moveCells` 的当天成立，
   * 而后半句（消费者）一行未动。读者只看前半句会判"已退出"。
   *
   * ⇒ 每条 `exitCondition` 必须显式分列：
   *  - **（甲）登记条件**：能力/承载面是否存在（可机检：类型/成员扫描）；
   *  - **（乙）消费者迁移数 = 0**：旧路径的**调用点**是否已全部迁走
   *    （可机检：**声明位/引用位**的位级模式命中数，或 `retirementRegistry` 的
   *    `own`/`consumer` 口径 —— ⚠️ **不**是裸标识符 `grep`：同名异物与注释会误判）。
   *  **只有（甲）不算退出。** 由 `tests/architecture/boundary-scan.test.ts` 机械把守。
   */
  readonly exitCondition: string
  /**
   * 本条声明的文件是否**全部落在生产入口的可达闭包内**（R1-α 补；R0-3 判据补丁）。
   *
   * ## 为什么必须有这个字段（闭合判据的**空洞真**）
   *
   * 退役判据的一种形态是「入口可达闭包 ∩ 旧层 = ∅」。它对**不在闭包内**的文件
   * 恒真 —— 什么都不做也判"已退出"。实测（R1-α 探针 `temp/r1a/probe-seam-closure.mjs`）：
   * 11 条接缝里 **3 条**共 6 处声明文件（4 个不同文件：
   * `adapters/export/snapshotExportJob.ts`、`domain/captureSpec.ts`、
   * `application/exportPlan.ts`、`runtime/exportJob.ts`）落在闭包**之外** ——
   * 而 `runtime/exportJob.ts` 恰是后两条接缝的**迁移目标**
   * （它不可达正是"尚未接线"这件事本身）。
   *
   * ⇒ 对这三条，"闭包判据"不是判据。本字段让这件事**可见**；声明 `outside-closure`
   * 的接缝必须给出 `closureNote` 说明它的**真判据**是什么，而
   * `boundary-scan.test.ts` 会**实测**闭包并断言声明值与事实一致。
   */
  readonly closureCoverage: 'in-closure' | 'outside-closure'
  /** `closureCoverage === 'outside-closure'` 时必填：说明闭包判据对本条为何恒真、真判据是什么。 */
  readonly closureNote?: string
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
      '实时工作台的面板写路径仍落在**旧运行时文档**上：`editors/workbench-rna.ts` 的'
      + ' `documentStateOf` 造 `DocumentState` 时取旧 `RuntimeDocument`（`DocumentState.document` 的'
      + ' 字段类型就是它），再传给 `applySetProperty`。机制已是同一套（同一个 RNA 表与同一个原子写路由），'
      + '但**数据模型**仍是旧的 `RuntimeDocument` 而非内核的 `Scene`/`Document`。\n'
      + '⚠️ **D3 更新**：取值口已不再是 `ctx.getDoc()`（**该访问器已终删**），'
      + ' 而是具名取值口 `Context#legacyDocumentModel()`（见 `property-write-legacy-document-model`）。',
    blocker:
      '**R-WK-04（#250，2026-10-11）**：把实时工作台从 `RuntimeDocument` 迁到内核 `Document` 需要"旧文档 → 内核场景"装配 —— #261 实测内核 `Document` 只承载 block/annotation/camera/mesh，不承载 `frames`/`cellGrid`/`textureBlobs`/`materialPalette`/`multiblock`/`meta`，而渲染链（21 个 `render/` 文件）按后者工作；全树没有任何生产代码从旧场景文件构造内核 `Scene`。故该装配是**架构新增**而非集成收口，归 **#282（P10b）**。#261 已完成的是宿主驱动接线与 `ReadView` 读面补齐（相机组 + 播放读面），见 `runtime/kernelSession`。',
    closureCoverage: 'in-closure',
    owner: Object.freeze({ p: 'P10b', issue: 282, duty: '旧文档→内核场景装配与呈现接线' }),
    exitCondition:
      "**（甲）登记条件 —— ✅ 已成立**：`src/runtime/context.ts` 的 `getDoc()` 已终删（**registry 判据**：`application/__tests__/retirementRegistry.test.ts:501-502` 的 `own`(`\\bgetDoc\\s*\\(`) 与 `consumer`(`\\.getDoc\\s*\\(`) 两条模式『声明位 / 引用位』**0 命中** —— 该判据自带不误红（排除 `getDocument`/`getDocumentBinding` 等）、真残留判红、以及『同名异物不误判』的对偶。⚠️ **不要**按字面去扫全树：`git grep getDoc` 有 219 命中，其中绝大多数是注释，其余是内核里**同名但无关**的私有辅助函数 `application/commands.ts:2161 function getDoc(state, id)`）。\n**（乙）消费者迁移数 = 0 —— ⏳ 未成立**：`src/editors/workbench-rna.ts` 的 `documentStateOf` 仍由旧文档构造 `DocumentState`（实测 `Context#legacyDocumentModel()` 仍有 2 处生产调用者）。\n闭包内（`closureCoverage: 'in-closure'`）⇒ 闭包判据对本条**有效**。\n**以下为原退出条件（逐字保留）**：\n"
      +
      '**①✅ 已成立（#301 P10f D3）**：`src/runtime/context.ts` 的 `getDoc()` **已删除**'
      + '（判据本尊口径：`retirementRegistry.test.ts` 的 `own`/`consumer` 两条位级模式 0 命中'
      + ' —— **不是**「全树 0 命中」：`git grep getDoc` 有 219 命中，'
      + ' 多为注释与内核同名辅助函数 `commands.ts` 的 `function getDoc(state, id)`；'
      + ' 该访问器曾是"文档内容的权威读入口"，'
      + ' 46 处消费点已各有具名读面 —— 见 `Context` 的 `// --- Main ---` 段）。\n'
      + '**②⏳ 未成立**：`src/editors/workbench-rna.ts` 的 `documentStateOf` 仍由旧文档构造'
      + ' `DocumentState`（`DocumentState.document` 的类型是 `RuntimeDocument`）。'
      + '**本批按 Lead 裁决 D-5 收窄改写**：兑现①、②的完整内核化**另立**登记'
      + ' `property-write-legacy-document-model`（owner P11）—— 兑现②需要**块身份写命令**'
      + '（实测：`Command` 联合有 `setCellTooltip`、**无** `setCellContent`）'
      + ' + RNA 描述符 + 写端口，是**承载面新增**，超出 D3「终删」范围。\n'
      + '⇒ 本条**保留登记**（②未兑现），但它的 `oldTrack` 已不再是"`getDoc()` 读入口"。',
  }),
  /**
   * P10f D3（#301）登记：**属性写的数据模型仍是旧文档**（D-5 裁决的剩余半边）。
   *
   * ## 它与 `kernel-property-write-dual-track` 的关系（不是重复登记）
   *
   * 那条接缝的原 `exitCondition` 有**两个子句**：
   *  ① `getDoc()` 不再返回旧文档 —— **D3 已兑现**（访问器终删）；
   *  ② `documentStateOf` 由内核 `Document` 构造 —— **未兑现**。
   *
   * D3 按 Lead 裁决（comment 6228）**收窄**那条（只留②），并把②的完整内核化
   * **另立本条**（owner P11）。分开的理由是**可核对**：①的判据是"零命中"
   *（已绿），②的判据是"`Command` 联合有块身份写命令"（**未**存在）——
   * 混在一条里会让"①已达成"被误读成"整条已达成"。
   *
   * ## 为什么本批**不**兑现②（实测，不是工作量）
   *
   * ```
   * application/commands.ts 的 Command 联合（实测 `readonly kind:` 全部命中）：
   *   setTransform / addObject / deleteObject / setCellTooltip / beginInteraction /
   *   updateInteraction / commitInteraction / cancelInteraction / select / setTime /
   *   setPlaying / setPlaybackRate / advancePlayback / setChannelValue /
   *   insertKeyframe / removeKeyframe / setTrackEnabled / publishDefault /
   *   undo / redo / save / saveCompleted / openDocument / closeDocument
   * ⇒ **没有**任何写"块身份 / 网格格内容"的命令（`setCellTooltip` 只写说明）。
   * ```
   *
   * 而 `editors/property-writers#writeBlockProperty` 要写的正是**方块身份**
   *（`SlotBlock.name`/`meta`）与**格内容**。⇒ 兑现② = 新增命令 + RNA 描述符 +
   * 写端口，是**承载面新增**（GF-13 最小集在 C′2 只交付到 `setCellTooltip`），
   * 超出 D3「终删 `getDoc()`」的范围。
   */
  Object.freeze({
    id: 'property-write-legacy-document-model',
    files: Object.freeze([
      'src/editors/workbench-rna.ts',
      'src/editors/property-writers.ts',
      'src/application/commands.ts',
    ]),
    newTrack:
      '内核 `Document` + `Command` 联合 + `reduceSetProperty`：属性语义查同一个 RNA 注册表、'
      + '写入走同一个 `applySetProperty` 原子路由（多选一失败整批拒、逐目标原因）—— 机制已收敛。',
    oldTrack:
      '`editors/property-writers#DocumentState` 的 `document` 字段类型是'
      + ' **旧 `RuntimeDocument`**，由 `editors/workbench-rna#documentStateOf` 经'
      + ' 具名取值口 `Context#legacyDocumentModel()` 取（`getDoc()` 已终删）。'
      + '⇒ 面板属性写的**数据模型**仍是旧文档。',
    blocker:
      '`Command` 联合**无**块身份/格内容写命令（实测 24 个成员，`setCellTooltip` 只写说明）'
      + ' ⇒ 完整内核化需要：① 新写命令（`setCellContent` 家族，GF-13 扩展）；'
      + ' ② `application/kernel-properties.ts` 的块身份属性描述符；'
      + ' ③ `editors/property-writers#writeBlockProperty` 的内核分支。'
      + ' 三件都是**承载面/写面新增**。',
    closureCoverage: 'in-closure',
    owner: Object.freeze({ p: 'P11', issue: 262, duty: '退役审计、全量回归、性能门槛与复杂度对账' }),
    exitCondition:
      "**（甲）登记条件 —— ✅ 已成立（R1-α）**：`src/application/commands.ts` 的 `Command` 联合含块身份/格内容写命令（R1-α 落地 `setCellContent`/`moveCells`/`setDocumentMeta`，联合 24 → 27，R-WK-07 授权）。⚠️ 本条 blocker 原写的\"联合无此类命令\"**已滞后于代码**，同批改正。\n**（乙）消费者迁移数 = 0 —— ⏳ 未成立**：`src/editors/property-writers.ts` 的 `DocumentState.document` 仍是 `RuntimeDocument`，`legacyDocumentModel(` 生产调用点 2 处。**只有（甲）不算退出。**\n**以下为原退出条件（逐字保留）**：\n"
      +
      '`src/editors/property-writers.ts` 的 `DocumentState.document` 的类型不再是'
      + ' `RuntimeDocument`（改为内核 `Document` 或 `ApplicationState`），'
      + '且 `src/editors/workbench-rna.ts` 的 `documentStateOf` 不再取旧文档 '
      + '⇒ 届时删除本条登记，并核销 `kernel-property-write-dual-track` 的子句②。',
  }),
  /**
   * P10f D3（#301）登记：**网格的原地编辑句柄**（B′ 撤回理由①的落点）。
   *
   * ## 为什么它**不能**用网格读面（B′ 的实测，必须留下）
   *
   * `operators/builtin/moveTranslate` 把 grid 捕获进撤销项的 `execute`/`undo`
   * 闭包并调 `grid.moveBlock(from, to)` **原地改**。而读面（`Context#kernelGrid`）
   * **每次新建**一个视图对象（内核分支更是由不可变载荷算出来的）⇒ 在它上面
   * `moveBlock` 的改动**静默丢失**（不报错、不改盘、用户看不到变化）。B′ 探针实测：
   *
   * ```
   * legacy  frame(0).grid === frame(0).grid   → true   （同一对象，写入留存）
   * 读面    gridOf(doc,0) === gridOf(doc,0)   → false  （每次新建）
   * ```
   *
   * ⇒ 本批给它一个**具名**编辑句柄（`Context#legacyGridForEdit`），
   * 而不是让它在读面上写（那会静默无效），也不是把读面做成有状态缓存
   * （那会让"读到的是快照"这一保证消失）。
   */
  Object.freeze({
    id: 'legacy-grid-edit-handle',
    files: Object.freeze([
      'src/runtime/context.ts',
      'src/runtime/gridRead.ts',
      'src/operators/builtin/moveTranslate.ts',
    ]),
    newTrack:
      '只读网格读面 `Context#kernelGrid(frameIndex)` → `runtime/gridRead#KernelGridView`'
      + '（内核 `blockGrid` 载荷为权威，未装配回落旧 `Grid`，**两种来源归一形状**）。'
      + '它是 15 处内容读取的统一入口（尺寸/格/部件/条目/几何/说明）。',
    oldTrack:
      '`src/operators/builtin/moveTranslate.ts` 经**具名编辑句柄**'
      + ' `Context#legacyGridForEdit(frameIndex)` 取旧 `Grid` 并 `moveBlock`'
      + '（写路径；句柄带 `moveBlock`，读面**没有**该方法 —— 结构上让"在读面上写"写不出来）。',
    blocker:
      '`Command` 联合**无**移动格的命令（GF-13 最小集在 C′2 只到 `setCellTooltip`）'
      + ' ⇒ 该写路径此刻无法迁到内核；改走读面会让写入静默丢失（#171 禁止的能力回退）。',
    closureCoverage: 'in-closure',
    owner: Object.freeze({ p: 'P11', issue: 262, duty: '退役审计、全量回归、性能门槛与复杂度对账' }),
    exitCondition:
      "**（甲）登记条件 —— ✅ 已成立（R1-α）**：`src/application/commands.ts` 的 `Command` 联合含 `moveCells`（R1-α 落地；领域语义见该命令注释：整格迁移 / 身份随迁且命名空间不改写 / 替换非交换 / 同时语义）。⚠️ 本条原退出条件只写了这一半，于是它在 `moveCells` 落地的当天**看起来已经退出**，而 `src/operators/builtin/moveTranslate.ts:309` 一行未动 —— 这正是 R0-3 点名的形态。\n**（乙）消费者迁移数 = 0 —— ⏳ 未成立**：实测 `Context#legacyGridForEdit(` 的生产调用点 **1 处**（`src/operators/builtin/moveTranslate.ts:309`），`src/runtime/gridRead.ts` 仍导出 `LegacyGridLike`。**只有（甲）不算退出。**\n**以下为原退出条件（逐字保留）**：\n"
      +
      '`src/application/commands.ts` 的 `Command` 联合含 `moveCells`'
      + '（或等价的块移动命令），且 `src/operators/builtin/moveTranslate.ts`'
      + ' 经 `Context#submitContentEdit` 发起移动、不再持有旧 `Grid`'
      + '（`src/runtime/gridRead.ts` 的 `LegacyGridLike` 随之下线）'
      + '⇒ 届时删除 `Context#legacyGridForEdit` 与本条登记。',
  }),
  /**
   * P10f D3（#301）登记：**渲染链的旧格式源文档**（渲染链终切的接缝）。
   *
   * ## 为什么它必须留下（D 批映射表 §八明文排除）
   *
   * DRW 消费的是**旧格式的渲染视图文档**：多方块视口的 `renderDoc` 由
   * `composition/kernelRenderView#kernelRenderViewOf` 产出，而该函数的**入参与出参
   * 都是旧格式**（`assembleKernelDocument` 与 `projectKernelDocument` 的既有签名决定）。
   * 故"DRW 不再吃旧格式"**不是**"删一个访问器"能达成的 —— 它要的是**渲染链终切**
   *（DRW 消费 `PresenterSession`），而那是 `presenter-surface-dual-track` 登记的接缝，
   * 其终切在 D 批映射表 §八被**显式排除**。
   *
   * ## 与旧 `getDoc()` 的**实质区别**（这是判据要能区分的事）
   *
   * | | 旧 `getDoc()` | 本读面 |
   * |---|---|---|
   * | 语义 | 文档内容的**权威读入口** | **渲染投影的格式输入** + 外部格式事实（声明内层 body / 文件格式版本） |
   * | 消费者 | 46 处 / 18 文件（保存/导出/属性/拾取/撤销**全在内**） | 3 处（`shared/viewport/**`）+ 1 处（`workbench-rna` 的多方块生成态判定）+ e2e 观测 |
   * | 判据 | 无（它就是权威） | 由 `boundary-scan` 的**白名单**钉住调用者 |
   */
  Object.freeze({
    id: 'legacy-render-source-document',
    files: Object.freeze([
      'src/runtime/context.ts',
      'src/shared/viewport/useViewportRuntime.ts',
      'src/shared/viewport/useKernelChannels.ts',
      'src/shared/viewport/EmbedViewport.vue',
      'src/editors/workbench-rna.ts',
    ]),
    newTrack:
      '内核求值 → 呈现：`composition/kernelRenderView#kernelRenderViewOf` 用'
      + ' `assembleKernelDocument` + `projectKernelDocument` 产出渲染视图（P10d D2 交付，'
      + ' 逐三角形一致已验）；`composition/presenterSession#PresenterSession` 已有生产实现。',
    oldTrack:
      'DRW 的文档来源仍是旧格式 `RuntimeDocument`，经具名读面 '
      + '`Context#legacyRenderSource()` 取（`useViewportRuntime` 的 `docRef`、'
      + ' `useKernelChannels` 的 `decl`/`multiblockSource`、`EmbedViewport` 的 `useEmbedTooltip` 入参、'
      + ' `workbench-rna` 的多方块生成态判定）。⚠️ 该读面**也**承载两件"外部格式事实"：'
      + ' 多方块**声明内层 body**（`multiblockSource`，内核不承载）与**文件格式版本**'
      + '（`formatVersion`，与内核装配面的 `schemaVersion` 是**不同编号**）。',
    blocker:
      '画面终切需要"DRW 消费 `PresenterSession`"的整体切换，其前置为材质统一'
      + '（呈现层是 `MeshBasicMaterial`，legacy 是贴图材质库）与注解/描边统一 ——'
      + ' 缺任一条即"切换后画面变平"（可感知回退，#171 禁止）。'
      + ' D 批映射表 §八逐字排除本批做渲染链终切。',
    closureCoverage: 'in-closure',
    owner: Object.freeze({ p: 'P11', issue: 262, duty: '退役审计、全量回归、性能门槛与复杂度对账' }),
    exitCondition:
      "**（甲）登记条件 —— ⏳ 部分成立**：新轨 `composition/presenterSession.ts` 的 `PresenterSession` 已有生产实现，但终切的另一条前置（材质统一 + 注解/描边统一）未交付。\n**（乙）消费者迁移数 = 0 —— ⏳ 未成立**：实测 `Context#legacyRenderSource()` 的**生产调用点 4 处**（`shared/viewport/useViewportRuntime.ts`、`useKernelChannels.ts`、`EmbedViewport.vue`、`editors/workbench-rna.ts`）。\n闭包内 ⇒ 闭包判据对本条**有效**。\n**以下为原退出条件（逐字保留）**：\n"
      +
      '`src/shared/viewport/useViewportRuntime.ts` 的 `docRef` 不再吃旧格式文档'
      + '（DRW 消费 `PresenterSession` 产出）、且 `src/editors/workbench-rna.ts` 的'
      + ' 多方块生成态判定与 `src/shared/viewport/useKernelChannels.ts` 的声明读取'
      + '都不再经 `Context#legacyRenderSource()`（声明内层 body 与文件格式版本'
      + ' 由内核或专门适配面承载）⇒ 届时删除该读面与本条登记。',
  }),
  /**
   * P10f D3（#301）登记：**旧文档的原地编辑**（`meta.embed_initial_view` 写）。
   *
   * ## 为什么它不能用"克隆 + `setDocument`"（实测的信号面差异）
   *
   * `context/captureEmbedInitialView#capturePreviewToDocument` 抓取预览视口相机后
   * 写 `doc.meta[embed_initial_view]`，而 `context/embedInitialView#setDocumentEmbedInitialView`
   * 的语义**就是原地改**。
   *
   * | 方案 | 后果 |
   * |---|---|
   * | 传克隆（`frozenDocumentValue()`） | 写入**静默丢失**（改的是副本，没人用） |
   * | 克隆 + `setDocument(clone)` | `main.replaceDoc` 会 bump `contentRefreshTick` **与** `documentRevision` ⇒ `EmbedViewport.vue` 的 `watch(getDocumentRevision)` 把 `didInitCamera` 重置 ⇒ **相机自动初始化被重置**（可感知行为变更） |
   * | **本体**（本条） | 与收口前**逐字节相同**（原地改 meta，不 bump 任何信号） |
   */
  Object.freeze({
    id: 'legacy-document-in-place-edit',
    files: Object.freeze([
      'src/runtime/context.ts',
      'src/context/captureEmbedInitialView.ts',
      'src/context/embedInitialView.ts',
    ]),
    newTrack:
      '**替换式**编辑一律走"克隆 + `Context#setDocument`"（`frozenDocumentValue()`'
      + ' 给克隆、`setDocument` 是唯一写入口，语义见其 `intent` 参数）。',
    oldTrack:
      '`src/context/captureEmbedInitialView.ts` 经具名取值口 '
      + '`Context#legacyDocumentModel()` 取**本体**并原地写 `doc.meta`'
      + '（`setDocumentEmbedInitialView` 的语义就是原地改）。',
    blocker:
      '`meta.embed_initial_view` 是**文件格式**的键，内核内容面（`DocumentContent`）'
      + '不承载它 ⇒ 换成"克隆 + `setDocument`"会改变信号面（见上表），'
      + '而改成内核命令需要先有"写文档 meta"的命令（`Command` 联合无此类成员）。',
    closureCoverage: 'in-closure',
    owner: Object.freeze({ p: 'P11', issue: 262, duty: '退役审计、全量回归、性能门槛与复杂度对账' }),
    exitCondition:
      "**（甲）登记条件 —— ⏳ 未成立**：需要\"承载 `meta.embed_initial_view` 的内核内容面或专门适配面\"。⚠️ **R1-α 实测澄清**：R1-α 落地的 `setDocumentMeta` 写的是 `DocumentContent.metadata` 的具名字段（`name`/`author`/`description`/`tags`/`origin`/`createdAtMs`），**不含** `embed_initial_view` —— GF-8 已裁决它是观察视角（归 3D 编辑器实例/宿主初始视图），不伪造进文档 ⇒ 本条仍缺专门适配面。\n**（乙）消费者迁移数 = 0 —— ⏳ 未成立**：实测 `Context#legacyDocumentModel()` 的生产调用点恰 2 处（`context/captureEmbedInitialView.ts:19`、`editors/workbench-rna.ts:503`）。\n**以下为原退出条件（逐字保留）**：\n"
      +
      '`meta.embed_initial_view` 由内核内容面或专门适配面承载，'
      + '且 `src/context/captureEmbedInitialView.ts` 不再取旧文档本体'
      + '（`src/runtime/context.ts` 的 `legacyDocumentModel()` 在本用途上零调用）'
      + '⇒ 届时核销本用途；若 `property-write-legacy-document-model` 也已核销，'
      + '则该取值口可整体删除。',
  }),
  /**
   * P10f D3（#301）登记：**等轴 PNG 导出仍走旧烘焙链**（D-8 实测驱动的收窄）。
   *
   * ## 为什么本批**不**把它切到 `ExportJob`（实测，不是工作量）
   *
   * 任务书第 5 项的字面是"四命令迁 `ExportJob`"，Lead 裁决 D-8 取 (甲)
   * （ISO PNG 走 `ExportJob`、其余三命令保持 `plainForSave`）。**接线前实测推翻了"低风险"这一前提**：
   *
   * | 事实 | 证据 |
   * |---|---|
   * | 现路径**带贴图** | `workbench/exportIsometricImage#bakeIsometricStructurePngDataUrl` 先 `buildMaterialLibrary(document)`，再 `buildBlockMesh(definition, materialLibrary, …)` ⇒ 真材质库 |
   * | `ExportJob` 路径**默认无贴图** | `adapters/export/offscreenRenderPort` 的 `textures?: TexturePort`，注释逐字："缺省 = 材质走 **中性色**" |
   * | 没有可交出去的生产 `TexturePort` | 全树 `TexturePort` 的**唯一**生产消费者是 `composition/presenterSession`（**视口作用域**，从活视口取资源）。把它交给导出作业正是 A29 要防的"导出借用实时视口" |
   *
   * ⇒ 现在切过去，产出的等轴 PNG 会**失去贴图**（画面变平）—— 那是**可感知的能力回退**，
   * #171 明令禁止。而 `e2e/export-ports.spec.ts` 的现有证据证的是**端口链**
   *（内容包围盒 + 透视相机 + 合成探针），**不覆盖**等轴方向的语义与画面质量
   * ⇒ 我原先给 D-8 的"已有 e2e 证据"这句话**不成立**，如实更正。
   *
   * ## 本批做了什么
   *
   * - 三个非渲染产物命令（Plain / Envelope / OBJ）的**产字节**已在 D2 迁到
   *   `Context#plainForSave()`（内核投影优先）—— D-8 的"其余保持"部分已兑现；
   * - 等轴 PNG **保持现路径**（无能力回退），并登记本条等待前置齐备。
   *
   * ## ⚠️ 终局裁决（P11-B3，#262 comment 6429 三，2026-10-13）：四命令**不迁**
   *
   * 本条曾把"四命令迁 `ExportJob`"当退出条件之一。Lead 终局裁决**采纳「不迁」**：
   * 切过去丢贴图（`textures` 缺省 ⇒ 中性色）+ 违反 A29（唯一生产 `TexturePort` 属视口作用域）。
   * ⇒ 本条的 `exitCondition` **收窄**为唯一前置「渲染链终切后」（材质统一 ⇒ 出现不借用
   * 实时视口的生产 `TexturePort`），不再要求命令迁移。
   */
  Object.freeze({
    id: 'isometric-export-legacy-bake',
    files: Object.freeze([
      'src/workbench/exportIsometricImage.ts',
      'src/operators/builtin/exportOperators.ts',
      'src/adapters/export/snapshotExportJob.ts',
    ]),
    newTrack:
      '`adapters/export/snapshotExportJob#assembleSnapshotExportJob` + '
      + '`SnapshotOffscreenRenderPort`（取景/求值/呈现/读回/释放）+ `createEncoderPort`'
      + '（真 PNG 字节）—— 冻结快照导出作业的**生产装配**，且已有真 GL e2e 证据'
      + '（`e2e/export-ports.spec.ts`，2 passed / 负对照诚实失败）。',
    oldTrack:
      '`src/operators/builtin/exportOperators.ts` 的 `ExportIsoPngOperator` 经 '
      + '`src/workbench/exportIsometricImage.ts#bakeIsometricStructurePngDataUrl` **自建** '
      + '`WebGLRenderer` + `buildMaterialLibrary` + `buildBlockMesh` 烘焙等轴 PNG'
      + '（D7 修复后 `resolveIsoDirection` 是渲染下标与文件名的**同一来源**）。',
    blocker:
      '`adapters/export/offscreenRenderPort` 的 `textures` 缺省 ⇒ **材质走中性色**；'
      + '而唯一的生产 `TexturePort` 属 `composition/presenterSession`（**视口作用域**）'
      + ' ⇒ 交给导出作业就是 A29 要防的"导出借用实时视口资源"。'
      + ' 故切换的前置是**渲染链终切**（呈现层接管画面、材质统一）——'
      + ' 与 `presenter-surface-dual-track` / `legacy-render-source-document` 同一前置。',
    // ⚠️ **闭包外**（R1-α 实测）：见 `closureNote` —— 「闭包 ∩ 旧层 = ∅」对本条恒真。
    closureCoverage: 'outside-closure',
    closureNote:
      "声明文件 `adapters/export/snapshotExportJob.ts` 不在任何生产入口的可达闭包内 —— 它正是本条尚未接线的那一端（`ExportIsoPngOperator` 仍走自建烘焙链，没有调用它）。⇒「闭包 ∩ 旧层 = ∅」对本条**恒真**，不能当判据。本条的**真判据**是「渲染链终切后 `ExportIsoPngOperator` 经 `assembleSnapshotExportJob` + `ExportJob.run()` 产出 PNG」（接线判据，含负对照：断开该接线则同一产物判据判红）。",
    owner: Object.freeze({ p: 'P11', issue: 262, duty: '退役审计、全量回归、性能门槛与复杂度对账' }),
    exitCondition:
      "**（甲）登记条件 —— ⏳ 未成立**：需\"渲染链终切后出现不借用实时视口的生产 `TexturePort`\"（材质统一的前置）。\n**（乙）消费者迁移数 = 0 —— ⏳ 未成立**：`operators/builtin/exportOperators.ts` 的 `ExportIsoPngOperator` 仍经 `workbench/exportIsometricImage.ts` 自建烘焙链。\n⚠️ 本条 `closureCoverage: 'outside-closure'` ⇒ **不得**用闭包判据（见 `closureNote`）。\n**以下为原退出条件（逐字保留）**：\n"
      +
      '**渲染链终切后**（唯一前置）：`src/composition/presenterSession.ts` 的 `PresenterSession` '
      + '接管画面、材质统一 ⇒ 生产侧出现**不借用实时视口**的 `TexturePort`（或材质统一后不再需要贴图端口）；'
      + '届时 `src/operators/builtin/exportOperators.ts` 的 `ExportIsoPngOperator` 经 '
      + '`assembleSnapshotExportJob` + `ExportJob.run()` 产出 PNG'
      + '（同批作废 `src/workbench/exportIsometricImage.ts` 的自建渲染器路径）'
      + ' ⇒ 删除本条登记。\n'
      + '⚠️ **退出条件已收窄（Lead 裁决 #262 comment 6429 三，2026-10-13）**：原条件的另一半是'
      + '「四命令迁 `ExportJob`」—— 该裁决**采纳「不迁」**（切过去丢贴图 + 违反 A29 借用实时视口）'
      + '⇒ 本条**不再**以"命令迁移"为退出条件，只留「渲染链终切」这一条可核对前置。',
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
   *  - ✅ **已兑现（#301 P10f D3）**：保存面从旧读取入口迁到内核投影
   *    （`raw-authority-object` 相位已翻 `executed`；`getDoc()` 判据本尊口径 **0 命中**）；
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
    closureCoverage: 'in-closure',
    owner: Object.freeze({ p: 'P10f', issue: 301, duty: 'D4 终退统战：RuntimeDocument 退出生产、G-6 三段与导出面端口' }),
    exitCondition:
      "**（甲）登记条件 —— ⏳ 部分成立**：`PresenterSession` 生产实现 ✅（逐格拾取 + 逐像素结构等价已验）。⚠️ **R1-α 更新**：原列前置之一「`Command` 封闭联合扩展（侧表写面）」**已交付**（R1-α 落地 `setCellContent`/`moveCells`/`setDocumentMeta`，联合 24 → 27）；仍未交付的是「9 条未装配内核的加载路径补齐」与「材质统一」。\n**（乙）消费者迁移数 = 0 —— ⏳ 未成立**：画面仍由 `DRW`（legacy `blockMesh`）产出；实测 `shared/viewport/useViewportRuntime.ts:77` 的 `docRef` 仍取 `ctx.legacyRenderSource()`。\n**以下为原退出条件（逐字保留）**：\n"
      +
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
      //
      // ## ⚠️ P11-B3 措辞精确化（#262 comment 6429 四，2026-10-13）
      //
      // ③ 的**"零生产调用方"口径本就含混**（把"有生产构造点"与"有生产消费方"混成一句），
      // 实测两件事必须分开写：
      //  - **有**生产构造点：`src/adapters/export/snapshotExportJob.ts` 的
      //    `assembleSnapshotExportJob` → `new ExportJob({`（实测 `:82`；此前 11 处
      //    `new ExportJob(` 全在 `__tests__`）；
      //  - **零**生产消费方：四个导出命令仍走 `workbench/export*` 旧导出器，
      //    无一处调 `assembleSnapshotExportJob` / `ExportJob.run()`。
      // ⇒ 措辞改为「**有生产构造点、零生产消费方**」，并**去掉**"四命令迁移归主线 D/E"
      //   这一半 —— Lead 裁决：**四命令不迁 `ExportJob`**（切过去丢贴图 + 违反 A29
      //   借用实时视口），等轴 seam 的退出条件据此收窄为「渲染链终切后」。
      '③ **替代面的两半必须分开写**（原文"零生产调用方"把两者混为一谈）：\n' +
      '  · **有生产构造点**：`src/adapters/export/snapshotExportJob.ts` 的 `assembleSnapshotExportJob` 内实例化 `ExportJob`（实测 `:82`，本文件外的唯一构造点；判据 `tests/architecture/export-port-implementation.test.ts`）；`OffscreenRenderPort` 与 `EncoderPort` **各有生产实现**（`src/adapters/export/offscreenRenderPort.ts` / `encoderPort.ts`）。\n' +
      '  · **零生产消费方**：四个导出命令（`src/operators/builtin/exportOperators.ts`）与 `ExportWorkspace.vue` 全走旧导出器，**无一处**调 `assembleSnapshotExportJob` / `ExportJob.run()` ⇒ "导出改由 `ExportJob` 承担"在**消费面**未接。\n' +
      '  · **Lead 裁决（#262 comment 6429 三，2026-10-13）：四个导出命令 `迁 ExportJob` = 采纳「不迁」**（切过去丢贴图 + 违反 A29 借用实时视口）⇒ 剩下的只是**旧导出器本体**的删除，其前置收窄为「渲染链终切」（见 seam `isometric-export-legacy-bake`）。\n' +
      '④ **文字修正**：本条的旧 `oldTrack` 曾称两个文件"从正在操作的视口取景（必要时临时改机位再恢复）"。实测**不成立**：`bundleMeshAssembly.ts` 与 `exportIsometricImage.ts` 都不 import 任何视口/相机/`ctx` 实时面，后者自建 `new THREE.WebGLRenderer` 与自建透视/正交相机（`:105,:153-168`）。"借用并旋转实时相机"发生在**截图**路径（`runtime/renderEngine.ts:215` 的 `canvas.toDataURL`），不是这两个导出器。A29 的负对照面据此收窄（见汇报）。',
    // ⚠️ **闭包外**（R1-α 实测）：见 `closureNote` —— 「闭包 ∩ 旧层 = ∅」对本条恒真。
    closureCoverage: 'outside-closure',
    closureNote:
      "3 处声明文件不在闭包内：`domain/captureSpec.ts`、`application/exportPlan.ts`、`runtime/exportJob.ts`。其中 `runtime/exportJob.ts` 恰是本条的**迁移目标**（导出作业端口尚未被生产入口装配 ⇒ 不可达**就是**\"尚未接线\"本身）。⇒「闭包 ∩ 旧层 = ∅」对本条**恒真**。本条的**真判据**是「生产导出入口经该端口取资源、且导出路径不再借用实时视口」（A29 + 接线）。",
    owner: Object.freeze({ p: 'P10d', issue: 289, duty: '内核内容面补全与呈现消费、渲染链终切' }),
    exitCondition:
      "**（甲）登记条件 —— ✅ 已成立**：导出端口实现完备（`adapters/export/snapshotExportJob.ts` + `SnapshotOffscreenRenderPort` + `createEncoderPort`），且已有真 GL e2e 证据（`e2e/export-ports.spec.ts`）。\n**（乙）消费者迁移数 = 0 —— ⏳ 未成立**：生产导出入口尚未经该端口装配。\n⚠️ 本条 `closureCoverage: 'outside-closure'` ⇒ **不得**用闭包判据（见 `closureNote`）。\n**以下为原退出条件（逐字保留）**：\n"
      +
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
    // ⚠️ **闭包外**（R1-α 实测）：见 `closureNote` —— 「闭包 ∩ 旧层 = ∅」对本条恒真。
    closureCoverage: 'outside-closure',
    closureNote:
      "2 处声明文件不在闭包内：`application/exportPlan.ts`、`runtime/exportJob.ts`（同 `export-borrows-live-viewport-dual-track` 的迁移目标）。⇒「闭包 ∩ 旧层 = ∅」对本条**恒真**。本条的**真判据**是「产物侧已接线 `assetId`/`contentVersion` 清单」（`composition/saveProjection` 已在产物侧传值，见本条说明）。",
    owner: Object.freeze({ p: 'P10d', issue: 289, duty: '内核内容面补全与呈现消费、渲染链终切' }),
    exitCondition:
      "**（甲）登记条件 —— ✅ 已成立**：产物侧已能表达资源身份（`adapters/files/projectFormat.ts` 的 `normalizeAssets`/`assetManifestDigest`；`composition/saveProjection.ts` 已在产物侧传值）。\n**（乙）消费者迁移数 = 0 —— ⏳ 未成立**：导出路径尚未实际写清单。\n⚠️ 本条 `closureCoverage: 'outside-closure'` ⇒ **不得**用闭包判据（见 `closureNote`）。\n**以下为原退出条件（逐字保留）**：\n"
      +
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
      '(a) **已接线（D1）**：源文件未知顶层字段原先只被计数、从未构造记录 ⇒ 现由 `composition/documentLoad` 经 `adapters/fidelityCapture`（深度 2）采集并交给内核会话承载。\n(b) **已统一（D1）**：保真键原先是一个**游离**方案（`lk.fidelity.v1.<文档ID>.record`，与 recovery/save 家族八处不兼容：缺 scope/instance 段、无解析器、裸 `string`、版本硬编码、空 id 静默降级、不被分类器识别）⇒ 现并入同族（`fidelityStoreKey`/`parseFidelityStoreKey`/`artifactKindOfKey`）。旧键零生产调用方 ⇒ 无迁移负担。\n(c) **已接线（D2），但本条不核销** —— "接线"与"缺口闭合"是两件事：`composition/saveProjection.ts` 已在产物侧传入 `fidelityFields`（12 处产字节节点全改吃 `ctx.plainForSave()`），且 D2 的产物等价判据（`composition/__tests__/p10fSaveProjection.test.ts` 的 ①③④⑤⑥ 组）已把"键面 + 语义面 + 逐格说明 + 材质表"两侧比对转绿；**但**保存路径的旧权威**回落分支仍在**（`Context.plainForSave` 的 `source: "legacy"`），即"`RuntimeDocument` 退出生产"这条总目标未达成 ⇒ 登记保留，退出条件收窄（见下）。',
    blocker:
      '(c) 剩余两件（**不是**"接线"）：① 保存路径的**回落分支**（`Context.plainForSave` 未装配 ⇒ legacy `serialize()`）'
      + ' —— **#301 P10f D3 评估结论：本批不核销该子句**（见下）；'
      + '② 产物等价判据从"四份夹具"扩到"e2e 真实产物"（真实产物 spec 仍显式排除）。\n'
      + '⚠️ **D3 对子句①的评估（Lead 任务书第 4 项要求"若未接则保留该子句登记"）**：\n'
      + '  - **保存等价已验**（D2：`p10fSaveProjection.test.ts` 52 tests，四份真实夹具'
      + ' 逐键/语义面/逐格说明/材质 sha256 全绿）⇒ 子句①的**前半**（"等价"）已闭；\n'
      + '  - **但回落分支本身仍在**：`Context#plainForSave` 的 `source: "legacy"` 分支'
      + ' 在三种情形下必然生效（无会话 / 未装配 GF-16 / 投影面不可解释）——'
      + ' 这三种情形**不是缺陷**，而是 #171「能力不回退」的落点（内核支持不了的文档形态，'
      + ' 旧路径照常能存）。`getDoc()` 的终删**不改变**这一点：产字节的**权威**已转到内核投影，'
      + ' 而"未装配时回落"是**设计**。\n'
      + '  - **另半边（L4 保真记录的持久化）仍未接**：`RecoveryStorePort`'
      + '（`adapters/storage/memory`/`browser`）**零生产实例化**（D 映射表 §3.2 实测；'
      + ' D3 复核仍成立 —— 全树 `createMemoryStoragePort|browserStoragePort` 只出现在 `__tests__`）。'
      + ' ⇒ **该子句保留登记**（本批不核销，如实回报 Lead）。\n⚠️ **三处更正**（前序批次写下、后续实测推翻）：① 原写"产物侧唯一挂点 `projectKernelDocument` 生产零调用方"—— **不成立**（`kernelRenderView.ts:135` 已在生产调用它）；真正的缺口更窄：`fidelityFields` 无生产传值方。② 原写 (b) "需先统一键口径，不是接线"—— **D1 已统一**。③ 原写 (c) "D2 接线后删除本条登记"—— **改判**：接线完成 ≠ 缺口闭合（回落分支仍在）⇒ 登记**保留**、只更新文案与退出条件；核销会让"保存路径尚未终切"失去登记。',
    closureCoverage: 'in-closure',
    owner: Object.freeze({ p: 'P10f', issue: 301, duty: 'D4 终退统战：RuntimeDocument 退出生产、G-6 三段与导出面端口' }),
    exitCondition:
      "**（甲）登记条件 —— ✅ 已成立（D1 两段）**：装配路径经 `adapters/fidelityCapture` 采集并由内核会话承载（`KernelSession.setFidelityFieldMap`）；保真键已并入 recovery/save 家族（`fidelityStoreKey` 带 scope+instance 段、返回 `Result`、有解析器、被 `artifactKindOfKey` 识别）。\n**（乙）消费者迁移数 = 0 —— ⏳ 未成立**：保存路径的旧权威回落分支仍在（`Context.plainForSave` 的 `source: 'legacy'`）。\n闭包内 ⇒ 闭包判据有效（但本条的退出是\"回落分支消失\"，不是\"闭包干净\"）。\n**以下为原退出条件（逐字保留）**：\n"
      +
      '**三段全部成立**才算闭合：\n(a) ✅ **D1 已达成** —— `src/composition/documentLoad.ts` 的装配路径经 `adapters/fidelityCapture` 调 `captureFidelity` 构造记录，且由内核会话承载（`KernelSession.setFidelityFieldMap`/`fidelityFieldMapOf`，卸载即清空）；\n(b) ✅ **D1 已达成** —— 保真键并入 recovery/save 家族（`src/application/recovery.ts` 的 `fidelityStoreKey` 带 scope+instance 段、返回 `Result`、有 `parseFidelityStoreKey`、被 `artifactKindOfKey` 识别、版本为具名常量 `FIDELITY_SCHEMA_VERSION`）；\n(c) ⏳ **D2 已接线、等价已把守、终切未完** —— 生产传值方 = `src/composition/saveProjection.ts`（✅ D2），产物等价判据在四份真实夹具上逐键/语义面转绿（✅ D2）；**但**旧权威回落分支仍在 ⇒ 闭合判据改为"保存路径无 legacy 回落分支（`Context.plainForSave` 恒 `source: "kernel"`）**且** e2e 真实产物等价判据纳入套件"。',
  }),
  /**
   * ⚠️ **本条第 (a) 半已核销（#301 P10f D3）** —— `side-table-write-legacy-track`
   * 的子句①（`metaEditOperators.ts` 不再 import 旧读入口）**已成立**：
   * D3 把它的帧高读取改走 `ctx.kernelGrid(0)`，回落分支的克隆改走
   * `ctx.frozenDocumentValue()`（R8 的边界取值口）⇒ 该文件对 `getDoc()` 零命中
   * （判据本尊口径实测 **0 处 / 0 文件**）。
   *
   * 子句②（注解 `locked`/几何的写端口）**未**兑现 ⇒ 本条的剩余部分**换名**为
   * 下面真正的残留登记 `annotation-wide-field-face`（同一事实、只留剩余半边）——
   * 保留旧名会让"这条接缝在管什么"与代码现状不符（本表的口径是"双轨**剩余**数"）。
   */
  /**
   * P10f C′2（#301）登记的**剩余半边**：**注解写面的字段面窄于 RNA 描述符**。
   *
   * ## ⚠️ #262 P11-B3 措辞更正（Lead 裁决 comment 6429 三 L5）：**读面不窄，窄的是写面**
   *
   * 本条原写「注解**读面/写面**的字段面窄于 RNA 描述符」，把读面一并列为瓶颈 ——
   * **与代码现实不符**。实测（判据本尊口径）：
   * `runtime/annotationRead.ts` 的 `ANNOTATION_FIELD_PAIRS` = **15** 条封闭表，
   * `id`/`type`/`visible`/`title`/`description` + 几何 `min`/`max`/`pos`/`points`/
   * `color`/`renderStyle` + **`locked`/`frameIndex`/`createdAt`/`updatedAt`**。
   * ⇒ 早先被写成"不在读面里"的 **`locked` 与这几类几何事实都在读面内**
   * （`editors/workbench-rna.ts` 的注解属性读正走这张表，其注释亦逐字写明
   * 「`locked` 是读面 15 字段之一」）。**读面因此不窄。**
   *
   * 真正窄的是**写面**：`operators/builtin/annotationOperators#annotationPatchCommand`
   * 实测**只迁 `title`**（非单键 `title` 的补丁一律返回 `null`），其余字段整体回落 legacy。
   * 本条此后只如实登记：**(i) 写面缺口** + **(ii) 读面命名空间未转发的那批几何字段**。
   *
   * ## 为什么必须登记（而不是只在汇报里说"这部分没迁"）
   *
   * C′2 把"文档内编辑"迁到内核（`annotationOperators` 三处），但**并非全部**：
   * 有两类编辑内核**尚无对应写面** ⇒ 仍走 legacy。按 #171
   * 「阶段间暂存的未迁移路径必须有负责人和退出阶段」，它们必须有可核对的出口。
   *
   * ## 两类各差什么（实测，不是"还没做"）
   *
   * ### (a) 逐格说明（tooltip 侧表）
   * `operators/builtin/metaEditOperators.ts` 写的是 `doc.tooltipPalette` +
   * `doc.cellTooltipGrid` —— **两个平行数组 + 下标配对**的侧表结构。
   * 内核 `DocumentContent` 的 `cellContent` 用的是**单表 + 键编码**
   * （`domain/cellContent` 的 `cellContentKeyOf`），两者**形状不同**。
   * 迁移需要一次"侧表 → 键表"的表示转换 + 对应用户可撤销的写命令
   * —— 那是**新的承载面设计**，不是接线。
   *
   * ### (b) 注解的字段写面（`locked` / 几何 / 其余）
   * 内核注解对象类型的属性集实测为 `name`/`visible`/transform/`text`
   * （`application/kernel-properties.ts:162-172`），而写端口
   * `editors/property-writers#writeAnnotationProperty` **只实现 `text` 与分量写**。
   * ⇒ C′2 的 `annotationPatchCommand` 只迁 `title`；`locked`/几何等
   * **整体回落 legacy**（刻意不部分写：部分写会让用户看到"改了一半"；
   * 硬凑成 `setProperty` 会落到 `default: UnsupportedOperation` ⇒ 命令被拒
   * ⇒ 调用点误判"未装配"而**二次写 legacy**）。
   *
   * ## 为什么本批不顺手扩
   *
   * (a) 要新设计承载面，(b) 要扩写端口 + 补描述符 —— 两者都会让本批从
   * "读面/写面迁移"扩张成"承载面设计"，而那正是 C′1 期裁定"归 C′2 的写面批
   * 更自然"时**没有**授权的东西（Lead #250 comment 5960 的范围是
   * "9 处编辑走内核命令 + 渲染读改分流"，不含承载面扩张）。
   *
   * ---
   *
   * ## ⚠️ #301 P10f D3 的**核销**（本条整条移除，只留剩余半边的新登记）
   *
   * 原本条的两条子句在 D3 后各归其位：
   *
   * | 子句 | D3 后 | 处置 |
   * |---|---|---|
   * | ① `metaEditOperators.ts` 不再引用旧读入口 | ✅ **成立**（帧高走 `ctx.kernelGrid(0)`；回落克隆走 `ctx.frozenDocumentValue()`；判据本尊口径 **0 命中**） | 已兑现 ⇒ **不再需要本条** |
   * | ② 注解 `locked`/几何的写端口 | ⏳ 未兑现 | **换名**为新登记 `annotation-wide-field-face`（同一事实、只留剩余半边） |
   *
   * 保留旧名会让"这条接缝在管什么"与代码现状不符 —— 本表的口径是
   * **双轨剩余数、只应减少**（文件头逐字如此）。
   */
  Object.freeze({
    id: 'annotation-wide-field-face',
    files: Object.freeze([
      'src/operators/builtin/annotationOperators.ts',
      'src/editors/workbench-rna.ts',
      'src/workbench/ux/panels/AnnotationEditorPanel.vue',
      'src/runtime/annotationRead.ts',
      'src/application/kernel-properties.ts',
      'src/editors/property-writers.ts',
    ]),
    newTrack:
      '内核写面承载内容编辑：注解**新建/删除**与 **`title`** 字段写（`annotationOperators`，C′2）+ 逐格说明写（`setCellTooltip`，D0）—— 都经 `Context.submitContentEdit`；'
      + '读面是 `runtime/annotationRead#kernelAnnotationsOf` 的**封闭 15 字段**表'
      + '（`ANNOTATION_FIELD_PAIRS` 与回写侧双向断言）。',
    oldTrack:
      '(b) **仍落 legacy 的是写面**（⚠️ 读面**不窄** —— 见文件头的措辞更正）：'
      + ' `src/operators/builtin/annotationOperators.ts` 的 `annotationPatchCommand` '
      + '实测**只迁 `title`**（非单键 `title` 的补丁一律返回 `null`）⇒ `locked`/几何/其余字段的'
      + '**写**一律回落 legacy（刻意不部分写：部分写会让用户看到"改了一半"）。\n'
      + '  另有一组**几何**事实不在读面的 15 字段命名空间里（内核 `AnnotationGeometry` '
      + '**承载**、RNA 描述符**声明**、读面逐字段显式转发时**未列入**）：'
      + ' `blockPos`/`quadIndex`/`renderOpacity`/`fillOpacity`/`frameThickness`/`overlay`/'
      + '`icon`/`size`/`thickness`/`arrow`/`showPoints`/`fontSize`/`backgroundAlpha`/'
      + '`linkedAnnotationId` ⇒ `src/editors/workbench-rna.ts` 的属性读对它们给 `value-absent`、'
      + ' `AnnotationEditorPanel.vue` 显示为空。\n'
      + '(a) ✅ **已核销（D3）**：逐格说明的回落分支与帧高读取已全部改走'
      + ' `ctx.kernelGrid(0)` / `ctx.frozenDocumentValue()`，对旧读入口 0 命中。',
    blocker:
      '**(i) 写面**：需要扩 `editors/property-writers#writeAnnotationProperty` 的写入分支与'
      + ' `application/kernel-properties.ts` 的注解属性描述符；'
      + ' **(ii) 读面命名空间**：需要在 `runtime/annotationRead#geometryFieldsOf` 里逐项转发'
      + ' 上面那批尚未列入的几何字段（读面是**封闭 15 字段**表，加字段是"决定"而不是自动跟随'
      + ' —— 见 `geometryFieldsOf` 的注释）。'
      + '两件都是**承载面/写面新增**，超出 D3「终删 `getDoc()`」的范围（Lead comment 5960 的红线）。',
    closureCoverage: 'in-closure',
    owner: Object.freeze({ p: 'P11', issue: 262, duty: '退役审计、全量回归、性能门槛与复杂度对账' }),
    exitCondition:
      "**（甲）登记条件 —— ✅ 部分成立**：读面已是封闭 15 字段表（`ANNOTATION_FIELD_PAIRS`，含 `locked` 与几何）。⚠️ **R1-α 澄清**：注解字段写**不**经逐格内容命令 —— R1-α 落地的 `setCellContent` 写的是**格**内容（`blockGrid.cellContent`），注解字段写走 `SetPropertyCommand` + RNA 描述符。未成立的是描述符字段覆盖。\n**（乙）消费者迁移数 = 0 —— ⏳ 未成立**：`annotationOperators.ts` 的 `annotationPatchCommand` 仍有\"未承载字段即整体回落\"的分支（实测只迁 `title`）。\n**以下为原退出条件（逐字保留）**：\n"
      +
      '`src/runtime/annotationRead.ts` 的 `ANNOTATION_FIELD_PAIRS` 覆盖'
      + ' `src/editors/workbench-inspector.ts` 的注解描述符**全部**字段，'
      + '且 `src/operators/builtin/annotationOperators.ts` 的 `annotationPatchCommand`'
      + ' 不再有"未承载字段即整体回落"的分支（`src/editors/property-writers.ts`'
      + ' 对这些字段都有写分支）⇒ 届时删除本条登记。',
  }),
  /**
   * R1-β① **补登**（2026-10-13；用户裁决 R0-7 / #385 评论 7029）。
   *
   * ## 为什么是"补登"而不是"新增"
   *
   * 本表的语义是「双轨**剩余**数、只应减少」。本条登记的是一条**早已存在**、
   * 却在 P0–P11 全过程中**从未被登记**的双轨：撤销权威。
   *
   * 它不在原 11 条里 —— 后果不是"少记一笔"，而是 **R0-3 的机械判据
   * （"闭包 ∩ 旧层 = ∅" + 本表）结构上发现不了它**：表里没有它，
   * 扫描器也就不会去找它。补登之后，该判据才重新具备覆盖力。
   */
  Object.freeze({
    id: 'undo-authority-dual-track',
    files: Object.freeze([
      'src/operators/pushDocUndo.ts',
      'src/operators/operatorRegistry.ts',
      'src/operators/modalOperatorWrapper.ts',
      'src/runtime/context.ts',
    ]),
    newTrack:
      '内核撤销是 `Document#history` 的事务内记账：`Command` 联合的 '
      + '`{kind: undo | redo, contextId}` 经 `reduceUndoRedo` 在事务内完成；'
      + '读面取 `Context#kernelUndoState()`（`KernelSession#documentSummary()` → '
      + '`application/queries#queryDocument` 的 `doc.history.past/future`），'
      + '提交面取 `Context#submitKernelUndoRedo()`。',
    oldTrack:
      '旧栈 `UndoManager`（`context/editHistory`）仍由 `src/operators/pushDocUndo.ts:34` 的 '
      + '`ctx.getEditHistory().push({ execute, undo })` **持续写入** —— 它记录的是'
      + '**算子级整文档快照**（`DocumentSnapshot | null` 不透明令牌，`execute`/`undo` 各做一次'
      + '整文档替换）。调用点四处：`src/operators/operatorRegistry.ts:65,112,139`'
      + '（对所有 `flagUndo` 且 `ctx.hasLoadedDocument()` 的算子包一层）与 '
      + '`src/operators/modalOperatorWrapper.ts:54`；出口是 `Context#getEditHistory()`。'
      + '⇒ 同一次编辑可能在内核历史与旧栈各留一条记录，而用户按 Ctrl+Z 只走其中一条。',
    blocker:
      '**GF-20**（#385 评论 7019、7029）：算子级整文档撤销（含「**撤销到无文档**」，'
      + '#301 R-WK-09 裁决 3 要求该能力存续）在内核历史模型下**无承载面** —— '
      + '内核撤销是 `Document#history` 的事务内记账，而 `openDocument`/`closeDocument` '
      + '会**换掉** `Document`（新文档历史天然为空）⇒ **跨文档撤销在类型上不存在**。'
      + '用户裁决 R0-7 已定：**多文档不是本轮能力**（仅作架构扩展性保留），'
      + '故禁止以"先上多文档"解此题；处置 = 现在保留临时路径，后续按 **A′**'
      + '（把「打开/关闭文档」这一动作本身记成一次可撤销的历史事实，或保留可撤销墓碑使历史可达）。',
    closureCoverage: 'in-closure',
    owner: Object.freeze({ p: 'R1-β①', issue: 387, duty: '端口切换与写路径内核化（撤销权威统一）' }),
    exitCondition:
      '**（甲）登记条件 —— ⏳ 未成立**：需要 GF-20 的 A′ 落地 —— 内核有承载'
      + '「文档生命周期转换」的历史形态（或可撤销墓碑），'
      + '使 `Document#history` 能表达"回到上一份文档 / 回到无文档"。\n'
      + '**（乙）消费者迁移数 = 0 —— ⏳ 未成立**：`pushDocUndo(` 的旧栈写入点'
      + '（`src/operators/pushDocUndo.ts:34`）及其四处调用点须消失，'
      + '且 `Context#getEditHistory()` 的生产调用点为 0'
      + '（扫描口径：`git grep -n "getEditHistory()" -- web/src`，排除 `__tests__`/`.test.`'
      + ' 与注释行 —— **不是**按裸标识符扫全树，同名异物与注释会误判）。'
      + '**只有（甲）不算退出。**\n'
      + '**以下为补登时记录的旧退出条件（逐字保留）**：'
      + '`src/operators/pushDocUndo.ts` 不再向旧栈写入，'
      + '`src/operators/operatorRegistry.ts` 与 `src/operators/modalOperatorWrapper.ts`'
      + ' 不再包旧栈撤销 ⇒ 届时删除本条登记。',
  }),
])

/** 按 id 取登记项（未登记返回 `undefined`，由调用方决定是缺口还是缺陷）。 */
export function seamById(id: string): SeamRegistration | undefined {
  return SEAMS.find((s) => s.id === id)
}
