/**
 * `composition/seams` —— **暂存双轨的登记表**。
 *
 * ## 这份表是什么
 *
 * 退役清单列出 13 条"旧机制 → 目标分层"的迁移。其中若干条**不可能**
 * 在某一次改动的边界内一次退完：退出需要消费者先迁走，而消费者属别的工作面。
 * 这类"新机制已交付、旧路径仍在服役"的**过渡态**必须显式登记 ——
 * 否则它就从"有期限的暂存"退化成"长期并存"，而退役纪律
 * 明文规定：**阶段间暂存的未迁移路径必须有负责人和退出阶段**。
 *
 * `boundary-rules.mjs` 的 `RETIREMENT_OWNERS` 登记的是**退役条目**本身；
 * 本表登记的是**代码里当下真实存在的双轨接缝**（seam）——粒度更细、可逐条对应到
 * 文件与函数，并且**带退出条件**。两者是"任务清单"与"现状清单"的关系。
 *
 * ## 为什么放在 `composition/`
 *
 * `composition/` 是九个目标分层之一（"装配"，无旧对应物），
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

/**
 * 接缝负责面 —— **模块职责 / 领域身份的封闭集合**。
 *
 * ## 为什么是一张"面"表，而不是批次表
 *
 * 登记项必须说清"这条双轨归谁管"。用**批次代号 + 工单号**表达有两个不稳固处：
 * 同一职责先后落过三个代号（代号随流程换名，职责本身没变），于是同一句话要跟着改三次；
 * 且代号的含义在**这份表之外** —— 读表的人得先去查外部编号表才知道它管什么，
 * 而一份要靠外部表才读得懂的"现状清单"不满足自包含要求。
 *
 * ⇒ 用**领域身份**表达：`surface` 指认本条落在哪个模块职责面上，`duty` 是该面的
 * 规范职责原文。判据（`tests/architecture/boundary-scan.test.ts`）只核对本文件内的四件事：
 * ① `surface` 已登记；② `duty` 逐字等于规范职责；③ 每个登记的面都**被至少一条接缝使用**
 * （无空转登记）；④ 各面措辞**两两不同**（面之间必须有区分力）。**不依赖任何外部编号表。**
 */
export type SeamOwnerSurface =
  /** 退役审计面：跟踪与核对存量双轨，不承接迁移实现。 */
  | 'retirement-audit'
  /** 内核内容面与呈现消费面：内容承载、求值点与画面生产者、渲染链。 */
  | 'content-and-presentation'
  /** 旧文档载体退出面：载体读写面收口与产物侧传输。 */
  | 'document-carrier-retirement'
  /** 写路径内核化面：端口切换、命令提交面与撤销权威。 */
  | 'write-path-kernelization'

/**
 * 每个负责面的**规范职责**（唯一措辞；登记的 `owner.duty` 必须**逐字**等于它）。
 *
 * 措辞刻意只描述**模块职责**，不写"哪个批次 / 哪张单" —— 理由见 `SeamOwnerSurface`。
 * 登记侧写的是**字面量**（不是 `SEAM_OWNER_DUTIES[...]` 的取值）：判据要能**抓到漂移**，
 * 若登记处直接引用本表，"duty 与规范职责不一致"在类型层面就不可能写出来，那条判据即恒真。
 */
export const SEAM_OWNER_DUTIES: Readonly<Record<SeamOwnerSurface, string>> = Object.freeze({
  'retirement-audit': '退役审计面：存量双轨的核对、全量回归与复杂度对账（跟踪，不承接迁移实现）',
  'content-and-presentation': '内核内容面与呈现消费：内容承载补全、求值点与画面生产者的接线、渲染链终切',
  'document-carrier-retirement': '旧文档载体退出面：`RuntimeDocument` 退出生产、保真记录随产物传输与导出面端口',
  'write-path-kernelization': '写路径内核化面：端口切换、命令提交面与撤销权威统一',
})

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
   * 为什么不能一次退完 —— 必须指向**具体的外部依赖**，
   * 而不是"工作量大"这类无法核对的说法。
   */
  readonly blocker: string
  /**
   * 负责范围与职责 —— **自包含的模块职责 / 领域身份**：
   * `surface` 取自本文件的 `SEAM_OWNER_DUTIES` 封闭表，`duty` 是该面的规范职责原文。
   *
   * ## 为什么不是"批次号 + 工单号"
   *
   * 本条原先写 `{ p: '…', issue: …, duty: … }`：那是**过程编号**（批次代号 + 工单号），
   * 在这里承担两个作用 —— 指认"谁负责"、并让判据能与外部编号表做算术对账。两者都不稳固：
   * 代号随流程换名（同一职责先后落过三个代号），职责却没变；编号的含义又在本表之外，
   * 读者必须先去查编号表才知道它管什么。⇒ 改为领域身份后，"谁负责 / 职责是什么 /
   * 何时退出"三件事**只在本文件内**即可读全，判据也只在文件内核对（见 `SeamOwnerSurface`）。
   */
  readonly owner: { readonly surface: SeamOwnerSurface; readonly duty: string }
  /**
   * **退出条件**（可静态核对的判据）。退出=删掉 `oldTrack`，
   * 并把本条从本表移除（本表的长度就是"双轨剩余数"，只应减少）。
   *
   * ## 退出条件必须是**两个子句**，不是一个
   *
   * 只用"能力/登记条件"当退出条件会产生**假退出**：能力落地的当天，
   * 旧机制可能一行未动。实测反例（本表内）：`legacy-grid-edit-handle` 的原退出条件
   * 写的是「`Command` 联合含 `moveCells` 且 `moveTranslate.ts` 经
   * `Context#submitContentEdit` 发起移动」—— 前半句在落地 `moveCells` 的当天成立，
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
   * 本条声明的文件是否**全部落在生产入口的可达闭包内**。
   *
   * ## 为什么必须有这个字段（闭合判据的**空洞真**）
   *
   * 退役判据的一种形态是「入口可达闭包 ∩ 旧层 = ∅」。它对**不在闭包内**的文件
   * 恒真 —— 什么都不做也判"已退出"。实测：
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
 * 早期登记过的 `per-viewport-channel-staging` 已核销。
 * 已核销的条目（模块级宿主开关、组件挂载决定状态寿命）
 * **不**登记进本表 —— 本表语义是"双轨**剩余**数、只应减少"，
 * 把已退役项塞进来会违背该口径；那些条目改由
 * `composition/__tests__/seams.test.ts` 的**回归断言**把守（防被改回去）。
 *
 * ⚠️ **一**：`screenshot-live-capture-by-design` **不是**待退役双轨
//
 * （截屏按产品定义就是即兴抓屏），它的 `exitCondition`（甲）（乙）都写"不适用"。
 * 它进表只为让 `tests/architecture/export-purity.test.ts` 的"导出入口读了实时视口/相机"
 * 判据有一个**显式且承重**的例外 ⇒ 读"双轨剩余数"时须把这一条**扣除**。
 */
export const SEAMS: readonly SeamRegistration[] = Object.freeze([
  /**
   * ⚠️ **已核销**：原 `kernel-property-write-dual-track` 与
   * `property-write-legacy-document-model` 两条曾登记在此。
   *
   * ## 两条的退出子句**同时**成立（不是"看起来走了"）
   *
   * | 子句 | 结论 | 机械证据（判据口径见 `boundary-scan.test.ts`） |
   * |---|---|---|
   * | ① `getDoc()` 不再返回旧文档 | ✅ | `retirementRegistry.test.ts` 的 `own`/`consumer` 两条位级模式 **0 命中** |
   * | ② `documentStateOf` 不再由旧文档构造 `DocumentState` | ✅ | `DocumentState` **已无 `document` 字段**；旧数据模型取值口**已终删**；生产调用点 **0**（`codeOf` 剥注释与字符串后，`editors/workbench-rna.ts` 里不再出现该调用） |
   *
   * ## 为什么是"删除登记"而不是"改写登记"
   *
   * `SEAMS` 的语义是"双轨**剩余**数、只应减少"（见本表文件头）。
   * 两条登记描述的旧轨都已从代码里消失 ⇒ 留在表里就是**空转登记**，
   * 而"登记表 = 现状清单"是这张表存在的全部理由。
   *
   * 反向的守护（防被改回去）在 `seams.test.ts` / `boundary-scan.test.ts` /
   * `exportOwnership.test.ts` 的**核销回归断言**里，不在本表。
   */
  /**
   * ⚠️ **已核销**：原 `legacy-grid-edit-handle` 曾登记在此。
   *
   * | 子句 | 结论 | 机械证据 |
   * |---|---|---|
   * | 甲 `Command` 有块移动命令 | ✅ | `moveCells`（领域语义见该命令注释） |
   * | 乙 消费者迁移数 = 0 | ✅ | `moveTranslate.ts` 已改走 `submitContentEdit` 的 `moveCells` 命令；`Context#legacyGridForEdit` **已删除**（全树 0 命中，只剩注释与登记文） |
   *
   * ⚠️ **本条与网格读面无关**：`runtime/gridRead#gridViewOfLegacy`/`LegacyGridLike`
   * **仍在**（它们是**读面**的未装配回落，由 `Context#kernelGrid` 的分流使用），
   * 不在本条登记的范围内 —— 本条登记的是**写**路径的编辑句柄。
   */
  /**
   * 登记：**渲染链的旧格式源文档**（渲染链终切的接缝）。
   *
   * ## 为什么它必须留下
   *
   * DRW 消费的是**旧格式的渲染视图文档**：多方块视口的 `renderDoc` 由
   * `composition/kernelRenderView#kernelRenderViewFromFace` 产出（旧入口
   * `kernelRenderViewOf` 已删），而该函数的**出参**仍是旧格式
   *（`projectKernelDocument` 的既有签名决定）。
   * 故"DRW 不再吃旧格式"**不是**"删一个访问器"能达成的 —— 它要的是**渲染链终切**
   *（DRW 消费 `PresenterSession`），而那是 `presenter-surface-dual-track` 登记的接缝，
   * 其终切被**显式排除**在本条范围外。
   *
   * ## 与旧 `getDoc()` 的**实质区别**（这是判据要能区分的事）
   *
   * | | 旧 `getDoc()` | 本读面 |
   * |---|---|---|
   * | 语义 | 文档内容的**权威读入口** | **渲染投影的格式输入** + 外部格式事实（声明内层 body / 文件格式版本） |
   * | 消费者 | 46 处 / 18 文件（保存/导出/属性/拾取/撤销**全在内**） | 现剩 1 处（`shared/viewport/useKernelChannels.ts` 的声明内层 body）+ e2e 观测；**DRW 的定义面 / 说明池 / 材质库输入三读取点已改吃内核面**，不经此读面 |
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
      '内核求值 → 呈现：`composition/kernelMultiblockEvaluation#evaluateMultiblockPresentation`'
      + '（**唯一求值点**）按"声明 + body + 当前通道取值"再装配出**派生场景**，'
      + ' `Context#kernelRenderSourceFace`（DRW 定义面）与 `Context#kernelPresentationDocument`'
      + '（呈现会话）读同一份派生场景 ⇒ "滑杆动了画面动"（断点②）；'
      + ' `composition/kernelRenderView#kernelRenderViewFromFace` 只做投影（不再自己装配）；'
      + ' `composition/presenterSession#PresenterSession` 是画面生产者。'
      + ' 派生场景不写回内核文档（不进历史、不进保存）—— 求值 ≠ 内容。',
    oldTrack:
      'DRW 的**定义面 / 说明池 / 材质库输入**已改吃内核面 `KernelRenderSourceFace`'
      + '（`composition/kernelPresentationInputs#kernelRenderSourceFaceOf`）：`definitionAt(frameIndex)`'
      + ' 逐帧给出 `{ definition, tooltipPalette }` 与 `materialInput`；注入点'
      + ' `shared/viewport/useViewportRuntime.ts:249`，消费侧 `runtime/drwMeshPipeline.ts:182`。'
      + ' `buildMaterialLibrary(doc.serialize())` 已从 DRW 消失（现由 `materialInput` 接'
      + ' `render/data/materialLibraryFromTextures`，按**已解码像素**装配）。'
      + ' 接线判据以**旧源缺席**（`docRef = null`）证明内核面**自足**：'
      + ' `runtime/__tests__/drwKernelRenderSource.test.ts`（生产装配面 ⇒ `loadStatus` = `ok`、'
      + ' `materialPalette.length === 62`、`tooltipPalette.length > 0`；负对照 `renderSourceRef = null`'
      + ' ⇒ 定义 `null`、说明池 `[]`、装载如实 `error`）。'
      + ' ⚠️ DRW 已不再是画面路径（画面由 `PresenterSession` 产出）。**仍读旧格式文档的只剩**：'
      + ' ① `useKernelChannels` 已不再取 `doc.multiblockSource`，再装配走'
      + ' `assembleMultiblockKernelFace` + `evaluateMultiblockPresentation`（画面源唯一）；'
      + ' 旧文档装配簇（`assembleForSelection`/`buildChannelPanelModel`/`kernelRenderViewOf`）'
      + ' 已删除（判据改为生产派生 + 冻结指纹/夹具）；'
      + ' ② 方块图标缓存的**身份键**（`runtime/drwMeshPipeline.ts:292-293` 键里绑旧 `StructureDefinition` 的'
      + ' `definition.id` + `summarizeBlocksForCache(definition)`）—— **未迁**；'
      + ' ③ `contentRefreshTick` 消费点（`runtime/drw.ts:149`、`runtime/drwMeshPipeline.ts:369`）—— **本轴退出项**。'
      + ' 其余三处已迁：`EmbedViewport` 的 tooltip 入参 → 内核读面；`useViewportRuntime` 的回落删除；'
      + ' `workbench-rna` 的生成态判定 → `Context#kernelWriteAuthority`。',
    blocker:
      '**画面终切与定义面 / 说明池 / 材质库输入终切均已完成；多方块声明内层 body 的消费也已迁走**，'
      + '本条现在只挡**下面两条残余**：'
      + '② 方块图标缓存的**身份键**（`runtime/drwMeshPipeline.ts:292-293` 仍绑旧 `StructureDefinition` 的'
      + ' `definition.id` + `summarizeBlocksForCache(definition)`）；'
      + '③ `contentRefreshTick` 消费点（`runtime/drw.ts:149`、`runtime/drwMeshPipeline.ts:369`，**本轴退出项**）。'
      + '⇒ 两类都迁走（或内核承载定义身份键）才能删读面本体。'
      + '另有内核面缺席时的旧文档回落分支（`runtime/drwMeshPipeline.ts:345-361` 与 `:413-434`），'
      + '生产注入点（`shared/viewport/useViewportRuntime.ts:249`）恒在场 ⇒ 该分支不构成生产读取。'
      + '旧文档装配簇与 `buildMultiblockRenderView` 在删除前已核实为**生产零调用**（全树 0 调用位），'
      + '仅被对照/恒等判据消费；那些判据改为**生产派生 + 冻结几何指纹/冻结面板夹具**后，四个入口同批删除。'
      + '它们**从未**是本接缝的第二权威（画面源唯一 = `evaluateMultiblockPresentation`）。',
    closureCoverage: 'in-closure',
    owner: Object.freeze({
      surface: 'retirement-audit',
      duty: '退役审计面：存量双轨的核对、全量回归与复杂度对账（跟踪，不承接迁移实现）',
    }),
    exitCondition:
      "**（甲）登记条件 —— ✅ 已成立（材质/注解/描边三处统一均已生产接线）**：\n"
      + "  · **材质统一 —— 已落地**：`composition/viewportTexturePort`（`TexturePort` 的**生产实现**：按内容身份复用 / 身份消失即 `dispose` / 释放后不复活）+ `adapters/textureDecode`（DOM 侧解码器，非浏览器环境如实答 `null`）+ 视口接线（`shared/viewport/useViewportRuntime` 每帧：资源五态 → 上传 → `PresenterSession.bindTextures`，带取消序号与显式诊断）。判据 `composition/__tests__/textureUnificationProduction.test.ts`（正判据 + 四条负对照，含真实信封 39 材质组的合并批次）。\n"
      + "  · **材质统一 —— 已闭合**：网格几何的材质 id 是 `material:<下标>`，绑定键命中 ⇒ `createMaterial` 真的设 `params.map`。闭合它的是**两处同一个改动**：① `presentation/compileScene` 的批次/来源划分从「按 `objectId`」改为「按**图元**」（`primitiveKeyOf`，对象身份与批次身份分离）；② `composition/kernelPresentationInputs` 改产逐 `materialIndex` 图元（复用 `runtime/presentationAdapter#structureMaterialPrimitives`/`structureMaterialGroups`）。越过 32 预算的**合并批次**里批次级材质只是代表值 ⇒ 逐成员材质/几何身份随 `BatchInstance` 下达，呈现与拾取都按成员取（否则『B 的方块贴 A 的图』，静默）。\n"
      + "  · **材质统一 —— 第二处阻断点**：即使分组正确，**真实浏览器里画面仍无贴图**。机制：`shared/viewport/useViewportRuntime#syncPresenterTextures` 在帧循环里**每帧**被调用，而取消判据 `seq !== textureSyncSeq` 会把上一帧**在途**的解码作废 ⇒ 一次解码若长于一帧，落地那一行**永不执行**：资源全 `ready`、绑定表恒空、`missingRequired` 也是 0 ⇒ **完全无报错的无图**。正解 = 与 `applyIfChanged` 同纪律的**身份去重**（资源身份未变则不重解码/不重绑定）+ **在途身份**标记。判据 = `web/e2e/texture-visible.spec.ts`（真实工作台：挂载材质 `withMap === materials`，含清空绑定 ⇒ 0 张的负对照）。\n"
      + "  · **注解/描边统一 —— 已生产接线**：注解链 = `shared/viewport/useViewportRuntime.ts:1083` → `composition/presenterSession.ts:822` → `:797 setAnnotations` → `presentation/annotationPlan#compileAnnotations`（上传唯一入口 `:785 applyAnnotations`）；描边链 = `shared/viewport/EditorViewportHost.vue:198` → `runtime/drw.ts:293 planPicks` → `composition/kernelOutlinePlanPort.ts:313` → `:347 planOutlines` → `render/mesh/outlinePlanMasks#plansToMaskMeshes` → `SelectionOutlinePass`。legacy 侧 `render/mesh/annotationMeshProvider.ts` **整文件已删**。⇒ 本条的**当前退出闸口**是 `blocker` 里的 ②③。\n"
      + "**（乙）消费者迁移数 = 0 —— ✅ 成立**：`Context#legacyRenderSource()` 的**全仓**调用点 = 0"
      + "（生产最后 1 处 `src/shared/viewport/useKernelChannels.ts:199` 与 e2e 两处同批改吃内核读面），随后**删除读面本体**。"
      + "核销依据（机械可复跑）= `runtime/__tests__/legacyRenderSourceConsumers.test.ts` 的**两条**判据："
      + "生产 = 0 **且** 全仓 = 0（覆盖 `src/`、`e2e/`、`tests/`、`scripts/`），各带负对照，其中"
      + "「往真实 `e2e/` 文件注入一处调用 ⇒ 必红」为**实跑**证据。"
      + "⚠️ **上面 ②③ 两类残余仍在** ⇒ **登记条目本身保留**（它们就是本条的退出闸口）。"
      + "核销后，`tests/architecture/shared-viewport-upward-import-closure.test.ts` 已改为**结构性**正向对照；"
      + "`tests/architecture/boundary-scan.test.ts` 与 `src/composition/__tests__/exportOwnership.test.ts` 的点名锚点已在各自注释里标明「核销时同批改」。",

  }),
  /**
   * ⚠️ **已核销**：原 `legacy-document-in-place-edit` 曾登记在此。
//
   *
   * ## 它为什么可以退出（两个子句同时成立，不是"看起来走了"）
   *
   * | 子句 | 结论 | 机械证据 |
   * |---|---|---|
   * | 甲 "承载 `meta.embed_initial_view` 的**专门适配面**" | ✅ 已有 | `runtime/context.ts#setHostEmbedInitialView`（类型化 `ViewportCameraState`，**不**交出旧文档本体；原地写 + 镜像语义逐点不变） |
   * | 乙 "本用途上 `legacyDocumentModel()` **零调用**" | ✅ 成立 | `context/captureEmbedInitialView.ts` 已改走上面的具名装配面；`boundary-scan.test.ts` 的调用者白名单闭集随之收窄。**残留的那一处（`property-write-legacy-document-model`）也已核销** ⇒ `legacyDocumentModel()` 全树 0 调用 |
   *
   * ## 为什么按"专门适配面"就算退出（而不是"移到另一个口就是改名"）
   *
   * 区别在**是否交出旧文档本体**：本面只收发**观察视角的值**（`ViewportCameraState`），
   * 旧文档形态不出模块；而 `legacyDocumentModel()` 交出的是 `RuntimeDocument` 本体。
   * 退役纪律禁的是后者那种"换个名字继续当权威读入口"。
   *
   * ⚠️ **残留的相邻欠账不在本条**：`meta.embed_initial_view` 至今**没有类型化内核落点**
   * （装配仍把观察视角放在非类型化的 `view` 里）—— 那是**甲方案未兑现**，
   * 不在本接缝的范围内，故本条核销**不等于**该缺口关闭。
   */
  // ───────────────────────────────────────────────────────────────────────────
  // 核销：`isometric-export-legacy-bake` **已退出**（导出切同一条呈现链）
  //
  // ## 这条接缝原来是什么
  //
  // "等轴 PNG / 场景 GIF 仍走自建烘焙链"的暂存登记：命令取 `plainForSave()` 的**声明态**
  // 文档，自己 `new THREE.WebGLRenderer` + `buildMaterialLibrary` + `buildBlockMesh` 烘焙，
  // 逐帧再 `setSceneTime`。它的退出条件原文只有一条：「渲染链终切后，命令经
  // `assembleSnapshotExportJob` + `ExportJob.run()` 产出 PNG」。
  //
  // ## 为什么现在能删（六条可机检条件**同时**成立，逐条留证）
  //
  // | # | 条件 | 机械证据 |
  // |---|---|---|
  // | 1 | 三个整文件已删除 | `workbench/exportIsometricImage.ts` / `exportAnimatedGif.ts` / `animatedGifEncoder.ts` 不在树上 |
  // | 2 | 两个入口不再 import 旧烘焙 | 全树对三个路径的**代码**引用为 0（只剩退役文字） |
  // | 3 | 两个命令**确实**经作业 | `exportOperators` 调 `runIsoExport`，后者调 `assembleSnapshotExportJob` + `ExportJob.run()`；静态判据在 `tests/architecture/export-chain.test.ts` |
  // | 4 | 判据面全绿 | `export-iso-time` / `export-scene-gif` / `export-ports` / `exportPorts.test.ts` / `snapshotExport.test.ts` + 反转后的 `exportOwnership` |
  // | 5 | 登记面同步 | 本条删除；`export-borrows-live-viewport-dual-track` 的 ③ 同步改成"2/5 已迁" |
  // | 6 | 新判据接棒 | `export-chain.test.ts` 的「命令必须经作业」静态判据（含负对照） |
  //
  // ## 为什么替换是**结构性**的（不是"换了实现但仍是两条链"）
  //
  // 命令现在只做三件事：捕获（`composition/exportCapture`，读与屏上**同一个**求值点的派生场景）、
  // 装配冻结作业、运行。相机是**四个 `CameraSpec` 值**（`presentation/isoExportCamera`），
  // 时间来自冻结的 `CaptureTime[]`，纹理只有**一份** `TextureResource[]`（同一数组值喂设备与绑定）。
  // ⇒ "第二次求值/第二条采样器/第二台相机"在导出侧不再可表达。
  //
  /**
   * ⚠️ **已核销**：原 `presenter-surface-dual-track` 曾登记在此。
   *
   * 它原是"呈现链与 legacy 渲染链并存"的暂存登记。画面生产者切到内核呈现根后，
   * 切到内核呈现根，故两个退出子句同时成立：
   *
   * | 子句 | 结论 | 机械证据 |
   * |---|---|---|
   * | 甲 视口结构层由 `PresenterSession` 产出 | ✅ | `shared/viewport/useViewportRuntime` 把 `vpSlot.contentGroup.value` 指向 `presenterSurface.object3d` —— 该槽位是结构层进场景树的唯一挂载点（`runtime/renderEngine#drawFrame` 的 `layers.structure.add(opts.contentGroup)`） |
   * | 乙 `drwMeshPipeline` 的 `blockMeshProvider` 路径被删除 | ✅ | `BlockMeshProvider`/`presentContentMesh`/`presentWorldFrame`/`worldMeshCache` 全树 **0 命中**（只剩退役记录文字）；`render/mesh/annotationMeshProvider.ts` 整文件删除 |
   * | 附属 材质统一 | ✅ | 逐材质图元 + `material:<下标>` 绑定命中（`e2e/texture-visible.spec.ts`） |
   * | 附属 注解/描边统一 | ✅ | 注解经 `kernelAnnotationInputs` → `annotationPlan` → `OverlayPresenter`（在呈现会话内）；描边经 `PresenterSession.applyOutline` 与 `DRW.outlinePass` 的**自建** mask（`SelectionHighlightProvider`，与内容几何无关） |
   *
   * ## 画面取证与负对照
   *
   * `e2e/picture-takeover.spec.ts`（真实工作台）用**两条互相独立**的事实判"画面生产者是
   * 呈现根"：①呈现根真的在场景树里（批次对象沿 `parent` 链可达 `mainScene`）；
   * ②`contentGroup` 下**没有** legacy `userData.triangleMap` 网格。
   * **负对照**：把结构层指回一个新建的 legacy 网格组（等价于"绘制交回 DRW"）⇒ 判据必须判红。
   */
  /**
   * 登记：**固定快照导出已交付，旧导出器仍在服役**。
   *
   * 这是退役矩阵第 13 条（`exporter-borrows-live-viewport`）在**代码现状**上的形态：
   * 替代机制（内核侧固定快照导出作业）已交付且可静态核对，但它的**消费面**
   * （工作台的导出命令与面板）仍走旧导出器 —— 而旧导出器借用实时视口正是要退役的行为。
   *
   * 为什么当时不删旧导出器：**内核→生产接线**
   * （宿主创建 Editor、按帧注入时间输入、渲染消费求值结果）是当时的另一条主线；
   * 因为内核尚未接线，旧导出器此刻是生产唯一路径，删除即能力停摆且无替代
   * （明令禁止的半成品替换形态）。
   */
  Object.freeze({
    id: 'export-borrows-live-viewport-dual-track',
    files: Object.freeze([
      'src/domain/captureSpec.ts',
      'src/application/exportPlan.ts',
      'src/runtime/exportJob.ts',
      'src/workbench/export/bundleMeshAssembly.ts',
      'src/operators/builtin/exportOperators.ts',
      'src/workbench/components/ExportWorkspace.vue',
    ]),
    newTrack:
      '内核侧固定快照导出：`domain/captureSpec` 把取景复制成 `CameraSpec` 值、把采样时间算成冻结的 `CaptureTime` 序列；'
      + '`application/exportPlan` 组装**不可变**请求并在预检处默认失败；`runtime/exportJob` 的离屏端口只有'
      + ' `acquire/renderFrame/release`（**没有**取实时相机/视口的方法）。静态判据见 `web/tests/architecture/export-purity.test.ts`。',
    oldTrack:
      '旧导出器仍在**部分**生产路径上：`src/workbench/export/bundleMeshAssembly.ts` 消费**旧文档内容**'
      + '（消费方经 `ctx.plainForSave()` 取 plain 文档），命令入口在 `src/operators/builtin/exportOperators.ts`。'
      + '⚠️ 现在只剩三个（Plain / Envelope / OBJ）；等轴 PNG 与场景 GIF 已迁至 `assembleSnapshotExportJob` +'
      + ' `ExportJob.run()`，旧烘焙链（`workbench/exportIsometricImage.ts` / `exportAnimatedGif.ts` /'
      + ' `animatedGifEncoder.ts`）整文件删除。\n'
      + '⚠️ **截屏不在本条旧轨内**：`runtime/renderEngine#screenshot` 读活画布/活相机是**明示例外**'
      + '（即兴抓屏，不是正式导出），单独登记在 `screenshot-live-capture-by-design`。',
    blocker:
      '① **消费者面**：Plain / Envelope / OBJ **三个**命令与 `ExportWorkspace.vue` 的导出卡片仍经'
      + ' `ctx.plainForSave()` 读旧文档投影（`getDoc()` 已终删）⇒ 删掉它们需要那三条产物迁到内核侧；'
      + ' 等轴 PNG 与场景 GIF **已退出**该面（经 `workbench/export/isoExportJob` → `ExportJob`）。\n'
      + '② **几何面**：OBJ 导出经 `loadStructureOrWorld(doc)` → `collectStructureGeometryPiecesPure(def)`，'
      + ' 其几何唯一来源是 `blockPalette[].geometry`（`render/schema/types.ts:257` → `structureGeometryCore.ts:217`）。'
      + ' 实测：内核投影**不带回显**时 palette 条目 `withGeometry=0`、**triangles=0**（ebf-2ch 0/旧 24；'
      + ' 帧为主真实信封 0/旧 4882）⇒ 换成内核求值后 OBJ 导出会**静默产出空几何**。\n'
      + '③ **替代面的两半必须分开写**：'
      + ' **有生产构造点**：`src/adapters/export/snapshotExportJob.ts` 的 `assembleSnapshotExportJob` 内实例化'
      + ' `ExportJob`（本文件外的唯一构造点；判据 `tests/architecture/export-port-implementation.test.ts`）；'
      + ' `OffscreenRenderPort` 与 `EncoderPort` **各有生产实现**。'
      + ' **部分生产消费方（2/5）**：等轴 PNG 与场景 GIF 已经 `workbench/export/isoExportJob` 调'
      + ' `assembleSnapshotExportJob` + `ExportJob.run()`；Plain / Envelope / OBJ 三条仍走 `plainForSave()` 的旧投影路径'
      + '（它们产的是 JSON/ZIP，不属呈现链）。'
      + ' **四个导出命令不迁 `ExportJob`**（切过去丢贴图 + 违反「导出不得借用实时视口」）⇒ 剩下的只是'
      + ' **旧导出器本体**的删除，其前置收窄为「渲染链终切」。\n'
      + '④ **文字修正**：旧 `oldTrack` 曾称两个文件"从正在操作的视口取景（必要时临时改机位再恢复）"。'
      + ' 实测**不成立**：`bundleMeshAssembly.ts` 与 `exportIsometricImage.ts` 都不 import 任何视口/相机/`ctx` 实时面，'
      + ' 后者自建 `new THREE.WebGLRenderer` 与自建透视/正交相机。"借用并旋转实时相机"发生在**截图**路径'
      + '（`runtime/renderEngine.ts:215` 的 `canvas.toDataURL`），不是这两个导出器。',
    closureCoverage: 'in-closure',
    owner: Object.freeze({
      surface: 'content-and-presentation',
      duty: '内核内容面与呈现消费：内容承载补全、求值点与画面生产者的接线、渲染链终切',
    }),
    exitCondition:
      "**（甲）登记条件 —— ✅ 已成立**：导出端口实现完备（`adapters/export/snapshotExportJob.ts` + `SnapshotOffscreenRenderPort` + `createEncoderPort`），且有真 GL e2e 证据（`e2e/export-ports.spec.ts`）。\n"
      + "**（乙）消费者迁移数 = 0 —— ⏳ 未成立（剩 3 条：Plain / Envelope / OBJ）**：三条仍走 `plainForSave()` 的旧投影路径；等轴 PNG 与场景 GIF **已迁**（经 `workbench/export/isoExportJob` → `ExportJob.run()`，旧烘焙链整文件删除）。\n"
      + "✅ **闭包判据适用**：本条 `closureCoverage: 'in-closure'`（声明与实测量均为 in-closure，`boundary-scan.test.ts` 逐条核对）。\n"
      + "**命令不许回退到自建链**另有静态判据：`web/tests/architecture/export-chain.test.ts`（命令必须经作业 / 装配必须真的运行，各带负对照）。\n"
      + "**以下为原退出条件**：`src/workbench/export/bundleMeshAssembly.ts` 被删除，且 `src/operators/builtin/exportOperators.ts` 的全部导出命令改由 `src/runtime/exportJob.ts` 的 `ExportJob` 承担（含 OBJ 几何来自内核内容面而不再依赖旧文档回显）；届时删除本条登记。",

  }),
  /**
   * 登记：**截屏是明示例外，不是待退役的债务**。
   *
   * ## 为什么它不是双轨
   *
   * `runtime/renderEngine#screenshot()` 用的是**活画布 / 活相机 / 墙钟文件名**
   * （`renderEngine.ts:223-250`）：`vp.domElement.toDataURL()` 取当前帧，
   * `lightning-screenshot-${Date.now()}.png` 落盘。按产品定义它就是**即兴抓屏**
   * （"把眼前这一画面存下来"），**不是**正式导出 —— 正式导出的纪律是
   * 固定快照（`ExportRequest` + 资源清单 + `ExportJob`），那条链由
   * `export-borrows-live-viewport-dual-track` 与 `tests/architecture/export-chain.test.ts` 把守。
   *
   * ⇒ 把截屏改造成"固定快照导出"会**改变产品语义**（用户要的是"此刻画面"，
   * 不是"某组导出配置下的产物"）。故它**不进入**退役流程：本登记的作用是让
   * `export-purity` 扩面时"命中实时视口/相机"的静态判据有一个**显式且承重**的例外，
   * 而不是让那条判据对截屏路径静默失明。
   *
   * ## 判据面（不是只挂个名字）
   *
   * - `web/tests/architecture/export-purity.test.ts` 的 `EXPORT_LIVE_VIEWPORT_EXCEPTIONS`
   *   按 `file + symbol` 精确放行本路径；**删掉这条例外 ⇒ 判据判红**（证明例外承重）；
   * - 例外条目必须**有对应命中**（该 file/symbol 真的读写实时面），否则报
   *   "例外条目无对应命中" —— 防止例外表变成万能免死金牌。
   */
  Object.freeze({
    id: 'screenshot-live-capture-by-design',
    files: Object.freeze([
      'src/runtime/renderEngine.ts',
      'src/shared/viewport/EmbedViewport.vue',
    ]),
    newTrack:
      '无替代轨 —— 本路径按产品定义就是**即兴抓屏**：`renderEngine.ts#screenshot()` 读当前活画布（`vp.domElement`）、用当前相机渲染（`renderMain`）并直接 `toDataURL` 落盘（文件名前缀 `lightning-screenshot-`，与正式导出产物天然区分）。',
    oldTrack:
      '同一路径即"旧轨"：它读了实时视口/相机与墙钟，**不**走固定快照（无 `ExportRequest`、无资源清单、不进 `ExportJob`）。这不是待迁移的双轨，而是**明示例外**（产品语义裁决：保留为即兴抓屏）。',
    blocker:
      '**不适用（不是债务）**：没有"把它迁到固定快照"的计划 —— 那会改变产品语义（"存下此刻画面" ≠ "导出配置下的产物"）。若日后产品要它成为正式导出，须**另立包**，并同批改写本条与 `export-purity` 的例外表。',
    closureCoverage: 'in-closure',
    owner: Object.freeze({
      surface: 'retirement-audit',
      duty: '退役审计面：存量双轨的核对、全量回归与复杂度对账（跟踪，不承接迁移实现）',
    }),
    exitCondition:
      '**（甲）登记条件 —— 不适用**：`src/runtime/renderEngine.ts` 的 `screenshot()` 就是按产品定义读实时面（活画布/活相机/墙钟），不存在"能力尚未就绪"。\n' +
      '**（乙）消费者迁移数 = 0 —— 不适用**：本路径不是待迁移的旧轨；它由 `EXPORT_LIVE_VIEWPORT_EXCEPTIONS` 按 `file + symbol` 显式登记为**明示例外**。\n' +
      '**真正的判据**（不是退出条件，而是"例外不得变成装饰"）：`web/tests/architecture/export-purity.test.ts` 的两条反空洞判据 —— ① 假条目必须报"例外条目无对应命中"；② 删掉 `runtime/renderEngine.ts` 的真条目 ⇒ 判据必须判红。\n' +
      '**若日后要它成为正式导出**：须另立包，同批改本条与例外表；届时才谈退出。',
  }),
  /**
   * 登记：**导出资源清单的产出方式**尚未接线。
   *
   * 资源预检要求「产物对应场景描述与**资源清单**」，且「缺必需资源时预检失败」。预检本身
   * 已交付且被测试覆盖（`src/application/__tests__/snapshotExport.test.ts` 的预检组），
   * 但**清单从哪来**这一步还没有生产调用方：
   *
   *  - 新轨：请求携带显式资源清单（`normalizeAssetNeeds`）或由已装配的导入器反推；
   *  - 旧轨：旧导出器（`workbench/export/bundleMeshAssembly.ts`）直接从旧文档与
   *    纹理库取资源，**不经过**任何"必需/可选 + 内容版本"的清单；
   *  - 缺口：`application/exportPlan.ts` 的 `deriveAssetNeeds()` 在未装配时返回空清单，
   *    并在函数注释里**显式登记**该事实（不伪造图元、不假装"无需资源"）。
   *
   * 这条接缝的存在使终局审计能机械核对"资源清单是否仍靠手列/靠旧路径取"。
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
      '`deriveAssetNeeds()` 需要"文档场景 → 呈现图元（`EvaluatedPrimitive[]`）"的装配，而这属**文档内容面** —— 与 `raw-authority-object` 同一前置（内核 `Document` 不承载旧文档内容）。该缺口归**内核内容面**（内容面补全与呈现消费）。',
    // ⚠️ **闭包覆盖从 `outside-closure` 翻成 `in-closure`**（与 `export-borrows-…` 同步）：
    // 声明文件里的 `application/exportPlan.ts` / `runtime/exportJob.ts` 现在**可达**
    // （导出命令 → 捕获装配 → 作业）⇒ 原 `closureNote` 作废并删除。
    closureCoverage: 'in-closure',
    owner: Object.freeze({
      surface: 'content-and-presentation',
      duty: '内核内容面与呈现消费：内容承载补全、求值点与画面生产者的接线、渲染链终切',
    }),
    exitCondition:
      "**（甲）登记条件 —— ✅ 已成立**：产物侧已能表达资源身份（`adapters/files/projectFormat.ts` 的 `normalizeAssets`/`assetManifestDigest`；`composition/saveProjection.ts` 已在产物侧传值）。\n**（乙）消费者迁移数 = 0 —— ⏳ 部分兑现**：等轴 PNG / 场景 GIF 已按捕获期反推的清单写产物（`deriveAssetNeeds` → 请求 `assets` → 作业 `assetNeeds` 转发）；**OBJ 仍不写清单**（`bundleMeshAssembly` 直接从旧文档与纹理库取资源）。\n**以下为原退出条件（逐字保留）**：\n"
      +
      '`src/application/exportPlan.ts` 的 `deriveAssetNeeds()` 由已装配的图元来源产出非空清单（不再在未装配时返回空），且 `src/runtime/exportJob.ts` 的作业按该清单解析资源。届时删除本条登记。',
  }),
  /**
   * 登记：**每视口通道暂存**（消费者面）。
   *
   * ## ✅ 已核销
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
   * 会让"表长 = 双轨剩余数"这个不变量失真 —— 与既有核销同一口径。
   * 故本条移出本表，改由 `__tests__/seams.test.ts` 的**回归断言**把守
   * （防旧机制被改回去），与处理"模块级宿主开关"的手法一致。
   *
   * 机械证据：`multiblock-channel-traversal.spec.ts` 全 552 组合遍历仍全绿，
   * `lsc-overlap` 的 108/108 组合**逐格 diff = 0**（取值变化真的驱动了重建）。
   */
  // ───────────────────────────────────────────────────────────────────────────
  // 核销：`property-draft-session-mirror` **已退出**
  //
  // ## 这条接缝原来是什么
  //
  // 输入层把草稿的**判定与提交时机**收敛到了输入层（`domain/textDraft` 三态机 +
  // `runtime/inputSession` + `InputPort.textProjection`），但旧的
  // `PanelSession.drafts`（每字段一份草稿文本）仍作为**呈现镜像**留在表里：
  // `PropertyInspector.onDraft` 写它、`buildField` 读它产生
  // `FieldViewModel.draft`/`draftState`，`editors/property-controls` 的 `parseDraft`
  // 做第二次解析。
  //
  // ## 为什么现在能删（实测，不是推理）
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
  // 故删除：`PanelSession.drafts`/`sessions`、`FieldViewModel.draft`/`draftState`、
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
   * 登记：**保真记录的传输未接通**。
   *
   * ## 为什么必须登记（而不是继续留在报告散文里）
   *
   * 此前交付了保真记录的**机制**：`captureFidelity` 采集、
   * `serializeFidelity`/`parseFidelity` 往返、`fidelityStorageKey` 旁置键、
   * `judgeFidelityAfterEdit` 三态裁定 —— 全部有测试、全部纯。
   *
   * 但当时的登记口径是"**只给键构造与序列化，不假装已接通**"，而那条缺口
   * **只写在报告里**（临时目录，随时会被删除）。
   * 按工作区元规则「规则进指令，证据留痕」「只存在于评论里的规则 ≈ 不存在」，
   * 一个只活在报告里的缺口在终局审计时**无法被机械核对**。现在把它登记进本表。
   *
   * ## 缺口的三段（全树实测，零生产调用方）
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
   * (c) 才是**真正的**缺口，且它落在"内核 → 旧格式投影"这条面上 —— 与渲染链/
   * `RuntimeDocument` 条目不重叠。故本条归内核内容面。
   *
   * ## 为什么当时**不**顺手实现 (a)+(b)
   *
   * 只做 (a)+(b) 会得到"记录被构造并写进本机存储，却没有任何产物带得走它"——
   * 正是退役纪律禁止的半成品：新机制带着生产副作用上线，而它宣称的能力
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
      '(a) **已接线**：源文件未知顶层字段原先只被计数、从未构造记录 ⇒ 现由 `composition/documentLoad` 经 `adapters/fidelityCapture`（深度 2）采集并交给内核会话承载。\n(b) **已统一**：保真键原先是一个**游离**方案（`lk.fidelity.v1.<文档ID>.record`，与 recovery/save 家族八处不兼容：缺 scope/instance 段、无解析器、裸 `string`、版本硬编码、空 id 静默降级、不被分类器识别）⇒ 现并入同族（`fidelityStoreKey`/`parseFidelityStoreKey`/`artifactKindOfKey`）。旧键零生产调用方 ⇒ 无迁移负担。\n(c) **已接线 + 回落分支已删**：`composition/saveProjection.ts` 已在产物侧传入 `fidelityFields`（12 处产字节节点全改吃 `ctx.plainForSave()`），且产物等价判据（`composition/__tests__/saveProjection.test.ts` 的 ①③④⑤⑥ 组）已把"键面 + 语义面 + 逐格说明 + 材质表"两侧比对转绿。**已删除 `Context.plainForSave` 的 `source: "legacy"` 回落分支**（旧实现：无会话 / 未装配 / 投影面不可解释时回落 `main.doc.serialize()`）⇒ 保存权威**唯一**（与 `composition/projectIo#projectForSave` 逐字同口径；`plain === null` 时给出结构化 `reason`）。本条剩余未闭子句只剩"e2e 真实产物等价判据纳入套件"。',
    blocker:
      '(c) 剩余两件（**不是**"接线"）：① 保存路径的**回落分支** —— **已删除**（`Context.plainForSave` 恒 `source: "kernel"`，未装配时 `plain: null` + 结构化 `reason`）；'
      + '② 产物等价判据从"四份夹具"扩到"e2e 真实产物"（真实产物 spec 仍显式排除）⇒ **本条剩余未闭子句只剩 ②**。\n'
      + '⚠️ **对子句①的评估（要求"若未接则保留该子句登记"）**：\n'
      + '  - **保存等价已验**（`saveProjection.test.ts` 52 tests，四份真实夹具'
      + ' 逐键/语义面/逐格说明/材质 sha256 全绿）⇒ 子句①的**前半**（"等价"）已闭；\n'
      + '  - **当时回落分支仍在**（当时结论），三种情形下必然生效（无会话 / 未装配 / 投影面不可解释）；'
      + ' 当时按「能力不回退」把它当**设计**保留。**后续按消费者重写授权删除它** ——'
      + ' 口径翻转的依据是一并退役项（保存权威不得双轨）与 `composition/projectIo#projectForSave` 的既有先例'
      + '（那里自陈"用旧文档填它需要先造一份内核 `Document`，那正是第二个权威的入口"）；'
      + ' 删除**不丢能力**：未装配时 `plain === null` + `reason`（`no-session`/`not-adopted`/`unreadable`）**可判定**，'
      + ' 调用方据此显式失败/提示（**不是**静默产出一份空产物）。\n'
      + '  - **另半边（保真记录的持久化）仍未接**：`RecoveryStorePort` 现由 恢复副本接线'
      + '**生产实例化**（`composition/recoverySession` 用 `browserStoragePort` 写/读/校验/采纳恢复副本，'
      + ' 键族 `lk.recovery.v1.*`）—— 更正：本条此前写"零生产实例化"（当时成立），'
      + ' 恢复副本接线后该句不再成立；**仍未接的是保真记录自身的持久化**（`fidelityStoreKey` 至今无生产读写点，'
      + ' 只有 `adapters/files/fidelityRecord` 的形状与测试）。\n'
      + '⚠️ **三处更正**（早期写下、后续实测推翻）：① 原写"产物侧唯一挂点 `projectKernelDocument` 生产零调用方"—— **不成立**（`kernelRenderView.ts:135` 已在生产调用它）；真正的缺口更窄：`fidelityFields` 无生产传值方。② 原写 (b) "需先统一键口径，不是接线"—— **键口径已统一**。③ 原写 (c) "接线后删除本条登记"—— **改判**：接线完成 ≠ 缺口闭合（回落分支当时仍在）⇒ 登记保留、只更新文案与退出条件；**"无 legacy 回落分支"这一子句已闭**，剩余只有 e2e 真实产物等价 ⇒ 该子句闭后核销本条。',
    closureCoverage: 'in-closure',
    owner: Object.freeze({
      surface: 'document-carrier-retirement',
      duty: '旧文档载体退出面：`RuntimeDocument` 退出生产、保真记录随产物传输与导出面端口',
    }),
    exitCondition:
      "**（甲）登记条件 —— ✅ 已成立**：装配路径经 `adapters/fidelityCapture` 采集并由内核会话承载（`KernelSession.setFidelityFieldMap`）；保真键已并入 recovery/save 家族（`fidelityStoreKey` 带 scope+instance 段、返回 `Result`、有解析器、被 `artifactKindOfKey` 识别）。\n**（乙）消费者迁移数 = 0 —— ✅ 已成立**：保存路径的旧权威回落分支已删除（`Context.plainForSave` 恒 `source: 'kernel'`，`plain === null` 时 `reason` 可判定；旧实现三种情形回落 `main.doc.serialize()`）。\n闭包内 ⇒ 闭包判据有效（本条的退出仍是\"回落分支消失\"这一子句，现已成立；剩余未闭子句见 `blocker` 的 ②）。\n**以下为原退出条件（逐字保留）**：\n"
      +
      '**三段全部成立**才算闭合：\n(a) ✅ **已达成** —— `src/composition/documentLoad.ts` 的装配路径经 `adapters/fidelityCapture` 调 `captureFidelity` 构造记录，且由内核会话承载（`KernelSession.setFidelityFieldMap`/`fidelityFieldMapOf`，卸载即清空）；\n(b) ✅ **已达成** —— 保真键并入 recovery/save 家族（`src/application/recovery.ts` 的 `fidelityStoreKey` 带 scope+instance 段、返回 `Result`、有 `parseFidelityStoreKey`、被 `artifactKindOfKey` 识别、版本为具名常量 `FIDELITY_SCHEMA_VERSION`）；\n(c) ✅ **"无 legacy 回落分支"已闭** —— `Context.plainForSave` 恒 `source: "kernel"`（未装配 ⇒ `plain: null` + 结构化 `reason`），生产传值方 = `src/composition/saveProjection.ts`；**剩余未闭**：e2e 真实产物等价判据纳入套件（真实产物 spec 仍按门控显式排除）⇒ 该子句闭后核销本条。',
  }),
  /**
   * ⚠️ **本条第 (a) 半已核销** —— `side-table-write-legacy-track`
   * 的子句①（`metaEditOperators.ts` 不再 import 旧读入口）**已成立**：
   * 帧高读取改走 `ctx.kernelGrid(0)`，回落分支的克隆改走
   * `ctx.frozenDocumentValue()`（冻结取值的边界口）⇒ 该文件对 `getDoc()` 零命中
   * （判据本尊口径实测 **0 处 / 0 文件**）。
   *
   * 子句②（注解 `locked`/几何的写端口）**未**兑现 ⇒ 本条的剩余部分**换名**为
   * 下面真正的残留登记 `annotation-wide-field-face`（同一事实、只留剩余半边）——
   * 保留旧名会让"这条接缝在管什么"与代码现状不符（本表的口径是"双轨**剩余**数"）。
   */
  /**
   * 登记的是**剩余半边**：**注解写面的字段面窄于 RNA 描述符**。
   *
   * ## ⚠️ 措辞更正：**读面不窄，窄的是写面**
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
   * 注解写面把"文档内编辑"迁到内核（`annotationOperators` 三处），但**并非全部**：
   * 有两类编辑内核**尚无对应写面** ⇒ 仍走 legacy。按退役纪律
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
   * ⇒ 该迁移的 `annotationPatchCommand` 只迁 `title`；`locked`/几何等
   * **整体回落 legacy**（刻意不部分写：部分写会让用户看到"改了一半"；
   * 硬凑成 `setProperty` 会落到 `default: UnsupportedOperation` ⇒ 命令被拒
   * ⇒ 调用点误判"未装配"而**二次写 legacy**）。
   *
   * ## 为什么当时不顺手扩
   *
   * (a) 要新设计承载面，(b) 要扩写端口 + 补描述符 —— 两者都会让工作从
   * "读面/写面迁移"扩张成"承载面设计"，而那正是既定分工
   * **没有**授权的东西（授权范围是
   * "9 处编辑走内核命令 + 渲染读改分流"，不含承载面扩张）。
   *
   * ---
   *
   * ## ⚠️ **核销**（本条整条移除，只留剩余半边的新登记）
   *
   * 原本条的两条子句在后续工作中各归其位：
   *
   * | 子句 | 后续状态 | 处置 |
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
      '内核写面承载注解内容编辑：**新建/删除**（C′2）、**`title`/`description`/`text`**、'
      + '**`color`/`locked`/`min`/`max`/`pos`/`renderStyle`**（新增描述符与写入分支：'
      + ' `application/kernel-properties.ts` 的注解属性集 + `applyKernelPropertyValue` 的几何/半边写）、'
      + '逐格说明（`setCellTooltip`）与**面板注解属性写**（`editors/workbench-rna` 路由到 `setProperty`）'
      + '—— 都经 `Context.submitContentEdit`；读面是 `runtime/annotationRead#kernelAnnotationsOf` 的'
      + '**封闭 15 字段**表（`ANNOTATION_FIELD_PAIRS` 与回写侧双向断言）。'
      + '⚠️ 同时把 `title`+`description` ↔ 载荷 `text` 的编码规则收敛到 '
      + '`domain/scene#annotationTextOf`/`splitAnnotationText`（唯一实现），于是内核能表达"只改一半"'
      + '—— 顺带修掉 `annotationPatchCommand` 原来写 `annotation.text` 造成的**改标题丢描述**。',
    oldTrack:
      '(b) **仍落 legacy 的是这几类**（⚠️ 读面**不窄** —— 见文件头的措辞更正）：'
      + ' ① `src/operators/builtin/annotationOperators.ts` 的 `annotationPatchCommand` 只映射 '
      + '`title`/`description` 两个键（其余键返回 `null` ⇒ 整体回落 legacy 的 `frozenDocumentValue()` 写）；'
      + ' ② 面板**读不到**的那批几何字段（`blockPos`/`quadIndex`/`renderOpacity`/`fillOpacity`/'
      + '`frameThickness`/`overlay`/`icon`/`size`/`thickness`/`arrow`/`showPoints`/`fontSize`/'
      + '`backgroundAlpha`/`linkedAnnotationId`/`points`）：内核 `AnnotationGeometry` **承载**它们、'
      + '但 `runtime/annotationRead#geometryFieldsOf` 逐字段显式转发时**未列入** ⇒ '
      + '`editors/workbench-rna.ts` 的属性读给 `value-absent`、面板显示为空'
      + '（**读不到 ⇒ 也写不到**，故它们同时是读面与写面的缺口）。',
    blocker:
      '**(i) 读面命名空间**：需要在 `runtime/annotationRead#geometryFieldsOf` 里逐项转发上面那批'
      + '尚未列入的几何字段（读面是**封闭 15 字段**表，加字段是"决定"而不是自动跟随 —— '
      + '见 `geometryFieldsOf` 的注释）；'
      + ' **(ii) 写面跟随**：读面一旦交出这些字段，`application/kernel-properties.ts` 的注解描述符'
      + '与写入分支必须同批跟上（`ANNOTATION_GEOMETRY_WRITABLE` 表就是那个落点）。'
      + '⚠️ 已把 (i) 的**前置**（写面从"只认 `text`"扩成表驱动）做完，'
      + '但**没有**扩读面 ⇒ 本条仍开。',
    closureCoverage: 'in-closure',
    owner: Object.freeze({
      surface: 'retirement-audit',
      duty: '退役审计面：存量双轨的核对、全量回归与复杂度对账（跟踪，不承接迁移实现）',
    }),
    exitCondition:
      "**（甲）登记条件 —— ✅ 大部分成立**：写面侧，内核注解属性集已含 `title`/`description`/`text`/`color`/`locked`/`min`/`max`/`pos`/`renderStyle`（`application/kernel-properties.ts`），且 `domain/scene` 收下了 `title`+`description` ↔ `text` 的唯一编码实现；`annotationPatchCommand` 已能映射 `title`/`description`。**未成立**的是读面命名空间的最后一批几何字段（上表 ②）—— 它们读不到，也就写不到。\n**（乙）消费者迁移数 = 0 —— ⏳ 未成立**：`annotationPatchCommand` 对 `color`/`locked`/`min`/`max`/`pos`/`renderStyle` 等键**仍返回 `null`** 并回落 legacy（写面已能表达它们，缺的是调用点的键映射 + 读面字段）。\n**以下为原退出条件（逐字保留）**：\n"
      +
      '`src/runtime/annotationRead.ts` 的 `ANNOTATION_FIELD_PAIRS` 覆盖'
      + ' `src/editors/workbench-inspector.ts` 的注解描述符**全部**字段，'
      + '且 `src/operators/builtin/annotationOperators.ts` 的 `annotationPatchCommand`'
      + ' 不再有"未承载字段即整体回落"的分支 ⇒ 届时删除本条登记。',
  }),
  /**
   * **补登**。
   *
   * ## 为什么是"补登"而不是"新增"
   *
   * 本表的语义是「双轨**剩余**数、只应减少」。本条登记的是一条**早已存在**、
   * 却在历次工作中**从未被登记**的双轨：撤销权威。
   *
   * 它不在原 11 条里 —— 后果不是"少记一笔"，而是**机械判据
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
      '**整文档撤销缺口**：算子级整文档撤销（含「**撤销到无文档**」，'
      + '既定要求该能力存续）在内核历史模型下**无承载面** —— '
      + '内核撤销是 `Document#history` 的事务内记账，而 `openDocument`/`closeDocument` '
      + '会**换掉** `Document`（新文档历史天然为空）⇒ **跨文档撤销在类型上不存在**。'
      + '既定口径：**多文档不是本轮能力**（仅作架构扩展性保留），'
      + '故禁止以"先上多文档"解此题；处置 = 现在保留临时路径，后续按 **A′**'
      + '（把「打开/关闭文档」这一动作本身记成一次可撤销的历史事实，或保留可撤销墓碑使历史可达）。',
    closureCoverage: 'in-closure',
    owner: Object.freeze({
      surface: 'write-path-kernelization',
      duty: '写路径内核化面：端口切换、命令提交面与撤销权威统一',
    }),
    exitCondition:
      '**（甲）登记条件 —— ⏳ 未成立**：需要整文档撤销缺口的 A′ 落地 —— 内核有承载'
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
  /**
   * **补登**：内核 → 旧载体的**投影回写**（`Context#syncLegacyFromKernel`）。
   *
   * ## 为什么是补登而不是新登记
   *
   * `application/writeFaces.ts:89-91` 早已**点名**这条路径：清算对象
   * （legacy 镜像、`syncLegacyFromKernel`）正落在 `document-content` 上
   * （那是一条被容忍的临时分叉，**由接缝登记与退出条件把守**）。
   * 而实测：本表在 `syncLegacyFromKernel` 上 **0 命中**
   * ⇒ 那句话里的把守当时是**声明里的空话**。本表是**现状清单**
   * （见文件头『本表是声明而非机制』），声明与现状不符就是本表要修的事。
   *
   * ## 它为什么**算**双轨（不是合法的投影单向面）
   *
   * | 问 | 实测 |
   * |---|---|
   * | 同一内容事实是否两处**存储** | 是：内核 `Document`（写权威）+ `RuntimeDocument` 载体（被投影维护的**存量**副本，不是读时计算） |
   * | 载体是否仍被生产**读** | 是：渲染回落 `runtime/drwMeshPipeline.ts:568`/`:633` 的 `doc.serialize()`；未装配侧元数据 `runtime/context.ts:1070` |
   * | 是否需要**人工保持同步** | 是：新增内核写命令必须同步扩本方法 —— `runtime/context.ts:1758-1764` 逐字记着加 `setCellTooltip` 却漏扩的后果（『提交成功但看不到』，e2e 确定性红） |
   *
   * ⇒ 它不是『求值派生』（求值不进存储、不换引用、不进历史），而是一条**必须随内核写命令
   * 手工扩展**的存量投影；漏扩的失败形态是『静默不同步』（内核写了、载体停在旧值）。
   * 这正是退役纪律要求『暂存路径必须有负责人与退出阶段』的那类事实。
   *
   * ## 与 `legacy-render-source-document` 的分工（不是同一条的重复登记）
   *
   * 那条登记的是**读面**（旧格式文档作为渲染/声明的格式输入）；本条登记的是**写面**
   * （内核内容被投影回载体，载体因此成为同一事实的第二份存储）。两条的退出是同一件事的
   * 两半：读面迁走 **且** 不再需要投影 ⇒ 载体退出生产（`RuntimeDocument` 退出生产）。
   *
   * ## owner 口径
   *
   * `owner.surface` 取**职责归属**而非活跃批次：内核内容面的
   * 职责原文即『RuntimeDocument 退出生产』，本条的退出就落在那条线的残余上。
   * 补登记**不改任何行为**。
   */
  Object.freeze({
    id: 'kernel-to-legacy-carrier-projection',
    files: Object.freeze([
      'src/runtime/context.ts',
      'src/runtime/host/recoveryHost.ts',
      'src/context/runtimeDocument.ts',
    ]),
    newTrack:
      '内核 `Document` 是内容的**唯一写权威**：编辑经 `Context#submitContentEditSettlement` → '
      + '`application/commands#reduceCommand` 结算（自带历史记账）；画面读内核求值面（`PresenterSession`），'
      + '保存/导出读内核投影（`Context#plainForSave` → `composition/saveProjection`）。'
      + '载体（若仍需存在）只是**派生副本**，不得反向写入内核。',
    oldTrack:
      '`RuntimeDocument` 载体是同一份内容事实的**第二处存储**：`Context#syncLegacyFromKernel`'
      + '（`src/runtime/context.ts:1775`）把内核的网格/注解/逐格说明投影回载体'
      + '（`projectKernelGrids` + `projectAnnotationsToLegacy` + `projectCellTooltipsToLegacy`），'
      + '并经唯一写者 `Context#setDocument(next, content-sync)` 写入（`src/runtime/context.ts:1840`；'
      + '`intent` 参数见 `:1709`）。**生产调用点 3 处**：`src/runtime/context.ts:1934`'
      + '（内容提交结算的 `applied` 分支）、`src/runtime/context.ts:2333`、'
      + '`src/runtime/host/recoveryHost.ts:99`（恢复副本采纳）。载体仍被生产读：'
      + '`runtime/drwMeshPipeline.ts:568`/`:633` 的 `doc.serialize()` 回落（条件 `renderSource() === null`）、'
      + '`runtime/context.ts:1070`（未装配侧元数据读）。',
    blocker:
      '载体退出生产读面的前置是**两条读路径**，都不在本次范围：'
      + '① 渲染链的旧格式回落（`runtime/drwMeshPipeline.ts:568`/`:633`）—— 归 `legacy-render-source-document` '
      + '的同一条退出线（图标缓存身份键 + `contentRefreshTick` 消费点）；'
      + '② 未装配侧的元数据读（`runtime/context.ts:1070`）—— 需要内核成为唯一装配产物，'
      + '未装配分支不再有生产调用方。本次只登记，不改运行逻辑（零行为变更）。',
    closureCoverage: 'in-closure',
    owner: Object.freeze({
      surface: 'document-carrier-retirement',
      duty: '旧文档载体退出面：`RuntimeDocument` 退出生产、保真记录随产物传输与导出面端口',
    }),
    exitCondition:
      '**（甲）登记条件 —— ✅ 已成立（投影面在案，且写入只经唯一写者）**：内核承载面齐全（网格/注解/逐格说明），'
      + '投影三件套在 `src/runtime/context.ts#syncLegacyFromKernel` 内，写入经 `Context#setDocument(next, content-sync)`。'
      + '\n**（乙）消费者迁移数 = 0 —— ⏳ 未成立（现 3 处调用点；载体仍被生产读）**：'
      + '`syncLegacyFromKernel()` 的调用点 = 3（`src/runtime/context.ts:1934`、`:2333`、`src/runtime/host/recoveryHost.ts:99`）；'
      + '`content-sync` 的唯一写入点 = `src/runtime/context.ts:1840`。'
      + '\n**退出条件（两个子句同时成立时删除本方法与本条登记）**：'
      + '① 上述 3 处调用点 = 0，且 `src/runtime/context.ts` 的 `setDocument` 不再接受 `content-sync` 意图；'
      + '② 载体不再被生产读 —— `runtime/drwMeshPipeline.ts` 的 `doc.serialize()` 回落删除，'
      + '且 `src/runtime/context.ts:1070` 的未装配侧元数据读删除。'
      + '\n**退出阶段**：与 `legacy-render-source-document` 的（乙）同批（渲染链终切 + 未装配分支消失之后）；'
      + '补登记只，**不改任何行为**。',
  }),
  /**
   * **补登（U2）**：壳设置 → `Main.embedPublish` 的**运行期镜像**。
   *
   * ## 事实（实测）
   *
   * - 权威 = `DocumentState.shell.shellSettings`：`editors/workbench-rna.ts#documentStateOf`
   *   构造它（`:536-549`），写经 `applySetProperty` 结算（壳设置不进文档历史，内核契约 §3.4）。
   * - 镜像 = `Main.embedPublish`（`runtime/main.ts:119`；由 `runtime/mainCameras.ts:125-126`
   *   的 store 分配）。写点**唯一**：`editors/workbench-rna.ts:916`（`applyShellState`，
   *   其 `:910` 注释即“壳设置写回…不进文档历史”）。
   * - 读点：`editors/workbench-rna.ts:330`（`workspace` 拥有者的 RNA 读）、`:538`
   *   （`documentStateOf` 把镜像**再塞回** `shell.shellSettings`）、`:915`（写前取当前值）；
   *   运行期消费者：`workbench/WorkbenchRoot.vue:138`（`:517` 用它的 `viewWidth`/`viewHeight`）、
   *   `viewer/viewerConfig.ts:155`、`wiki/wikiEmbedTemplate.ts:8`、
   *   `operators/builtin/miscOperators.ts:295`、`workbench/ux/PropertyInspector.vue:67`。
   *
   * ## 为什么算双轨（不是“写一次、只读”的末端缓存）
   *
   * `documentStateOf` 用镜像**重建** `DocumentState`，`applyShellState` 又把结算结果写回镜像
   * ⇒ 同一事实在同一轮里走“权威 → 镜像 → 权威”的**往返**：第二份存储是回路的一部分，
   * 而不是末端派生值。且这条写落在 `ctx.main` 上（Main 裸字段的残余面之一）。
   *
   * ## 它不属初始视角缺口
   *
   * `embedPublish` 是发布/预览配置（视口尺寸、背景、特性开关），**不是**
   * `meta.embed_initial_view`（那是 U3，见 `main-embed-initial-view-mirror`）。
   * 故本条的退出**不以该缺口为前置**；两条镜像按同一改动同步复审。
   *
   * ## owner 口径
   *
   * 本条**没有**已排期的实现批认领（壳设置读面迁移尚未立包）⇒ owner 取退役审计
   * 范围跟踪；实现时按本条的（乙）接管，并同步改本注释。
   */
  Object.freeze({
    id: 'main-embed-publish-mirror',
    files: Object.freeze([
      'src/runtime/main.ts',
      'src/runtime/mainCameras.ts',
      'src/editors/workbench-rna.ts',
    ]),
    newTrack:
      '壳设置的**权威**是 `DocumentState.shell.shellSettings`：写经 `editors/workbench-rna.ts#submitPropertyWrite`'
      + ' 的壳分派（`applySetProperty` 结算，不进文档历史），读经 `documentStateOf`；'
      + '消费者应当读这份壳状态（或其具名投影），而不是读一个可写的 Ref。',
    oldTrack:
      '`Main.embedPublish` 是同一事实的**第二份存储**：`src/runtime/main.ts:119` 声明、'
      + '`src/runtime/mainCameras.ts:125-126` 分配；写点 `src/editors/workbench-rna.ts:916`'
      + '（`applyShellState`）；读点 `:330`/`:538`/`:915`；运行期消费者 `workbench/WorkbenchRoot.vue:138`、'
      + '`viewer/viewerConfig.ts:155`、`wiki/wikiEmbedTemplate.ts:8`、`operators/builtin/miscOperators.ts:295`、'
      + '`workbench/ux/PropertyInspector.vue:67`。生产读数（去测试文件）：**9 处 / 6 文件**。',
    blocker:
      '消费者按 Vue `Ref` 形状读它（`viewerConfig`/`wikiEmbedTemplate`/`PropertyInspector` 直接取 `.value`），'
      + '且 `documentStateOf` 用它重建 `DocumentState` ⇒ 迁移需要一条壳设置的**具名读面**'
      + '（或让读者直接吃 `DocumentState.shell` 的投影）。那属壳/面板批次，本次只登记。',
    closureCoverage: 'in-closure',
    owner: Object.freeze({
      surface: 'retirement-audit',
      duty: '退役审计面：存量双轨的核对、全量回归与复杂度对账（跟踪，不承接迁移实现）',
    }),
    exitCondition:
      '**（甲）登记条件 —— ✅ 已成立（权威在案）**：壳设置的权威存储 = `DocumentState.shell.shellSettings`'
      + '（`src/editors/workbench-rna.ts#documentStateOf` 构造，`applySetProperty` 结算）。'
      + '\n**（乙）消费者迁移数 = 0 —— ⏳ 未成立（写点 1 + 读点 3 + 运行期消费者 5）**：'
      + '`main.embedPublish` 的生产读数 = 9 处 / 6 文件，其中写点 1 处（`src/editors/workbench-rna.ts:916`）。'
      + '\n**退出条件（两个子句同时成立时删除镜像字段与本条登记）**：'
      + '① `src/runtime/main.ts` 不再声明 `embedPublish`，`src/runtime/mainCameras.ts` 不再分配它；'
      + '② `main.embedPublish` 的读写点 = 0（`src/editors/workbench-rna.ts` 的 `documentStateOf`/`applyShellState`'
      + ' 改为直接用 `DocumentState.shell` 或具名读面）。'
      + '\n**退出阶段**：壳设置读面迁移 —— **不以初始视角缺口为前置**（本条不涉及 `meta.embed_initial_view`）；'
      + '与 `main-embed-initial-view-mirror` 同批复审。',
  }),
  /**
   * **补登（U3）**：`meta.embed_initial_view` → `Main.embedInitialView` 的**运行期镜像**
   * —— 初始视角缺口未闭时的那条补偿。
   *
   * ## 事实（实测）
   *
   * - 载体侧落点 = 文档 `meta.embed_initial_view`（`EMBED_INITIAL_VIEW_META_KEY`，
   *   `src/context/embedInitialView.ts:5`）：`setDocumentEmbedInitialView`（`:42-51`）**原地**写、
   *   `getDocumentEmbedInitialView`（`:35-40`）读（命中判据 `isViewportCameraState` `:19-33`）。
   * - 镜像 = `Main.embedInitialView`（`src/runtime/main.ts:118`；`src/runtime/mainCameras.ts:125` 分配）。
   *   **写点 4 处**：`src/context/embedInitialView.ts:62`（`hydrateMainEmbedInitialViewFromDoc`，
   *   装载/替换文档后）、`src/runtime/context.ts:1144`（`setHostEmbedInitialView` 同一动作的两半）、
   *   `src/operators/builtin/docLifecycleOperators.ts:141`/`:276`（关闭/替换文档时置 `null`）。
   *   **读点 2 处**：`src/runtime/viewportCamera.ts:96-102`（无活相机时的嵌入机位初值）、
   *   `src/runtime/viewportCameraApply.ts:39`（把初始视角应用到机位）。
   *
   * ## 为什么它必须存在（= 为什么它仍算双轨）
   *
   * 初始视角的甲方案**未闭**：`meta.embed_initial_view` 至今**没有类型化内核落点** ——
   * `composition/kernelAssembly.ts:1280-1282` 明写观察视角仍放在**非类型化**的 `view` 里。
   * 于是运行期必须留一份**可观察**的镜像给机位初始化读；此刻删镜像会把读者逼回旧文档本体
   * （那正是刚拆掉的口）。⇒ 它是有期限的补偿，不是永久设计。
   *
   * ## 与 `main-embed-publish-mirror` 的区别
   *
   * 那条是壳设置镜像，不依赖初始视角缺口；本条是该缺口的**运行期补偿** ——
   * 缺口收口时本条的（甲）才可能成立。两者按同一改动同步复审。
   *
   * ## owner 口径
   *
   * 初始视角缺口是既有遗留（本表 `legacy-document-in-place-edit` 的核销注末句
   * 即写“核销**不等于**该缺口关闭”）⇒ owner 取该范围的职责归属。
   */
  Object.freeze({
    id: 'main-embed-initial-view-mirror',
    files: Object.freeze([
      'src/runtime/main.ts',
      'src/runtime/context.ts',
      'src/context/embedInitialView.ts',
      'src/context/captureEmbedInitialView.ts',
    ]),
    newTrack:
      '观察视角的落点是文档 `meta.embed_initial_view`（`src/context/embedInitialView.ts` 的'
      + ' `setDocumentEmbedInitialView`/`getDocumentEmbedInitialView`，写入**原地**、不换文档引用、'
      + '不推进 `documentRevision`）；宿主侧经具名装配面 `Context#setHostEmbedInitialView`（`src/runtime/context.ts:1140`）'
      + ' 收口，抓取半在 `src/context/captureEmbedInitialView.ts:29`。',
    oldTrack:
      '`Main.embedInitialView` 是同一事实的**运行期镜像**：`src/runtime/main.ts:118` 声明、'
      + '`src/runtime/mainCameras.ts:125` 分配；写点 4 处（`src/context/embedInitialView.ts:62`、'
      + '`src/runtime/context.ts:1144`、`src/operators/builtin/docLifecycleOperators.ts:141`/`:276`）；'
      + '读点 2 处（`src/runtime/viewportCamera.ts:96-102`、`src/runtime/viewportCameraApply.ts:39`）。'
      + '生产读写点合计 **6 处**。',
    blocker:
      '**初始视角缺口的甲方案未闭**：`meta.embed_initial_view` 没有类型化内核落点（`composition/kernelAssembly.ts:1280-1282`'
      + ' 明写观察视角在非类型化的 `view` 里，给它类型化落点是甲方案）。在类型化读面出现前删镜像，'
      + '机位初始化就只能回读旧文档本体（`RuntimeDocument.meta`）—— 那是刚退役的取值形态。'
      + '本次只登记（零行为变更），缺口收口不在本次范围。',
    closureCoverage: 'in-closure',
    owner: Object.freeze({
      surface: 'write-path-kernelization',
      duty: '写路径内核化面：端口切换、命令提交面与撤销权威统一',
    }),
    exitCondition:
      '**（甲）登记条件 —— ⏳ 未成立**：初始视角缺口的甲方案要求 `meta.embed_initial_view` 有**类型化内核落点 + 类型化读面**；'
      + '今天它仍是 `src/context/embedInitialView.ts` 上的旧文档 `meta`，装配仍把观察视角放在非类型化的 `view`'
      + '（`composition/kernelAssembly.ts:1280-1282`）。'
      + '\n**（乙）消费者迁移数 = 0 —— ⏳ 未成立（写点 4 + 读点 2 = 6 处）**：'
      + '`src/context/embedInitialView.ts:62`、`src/runtime/context.ts:1144`、'
      + '`src/operators/builtin/docLifecycleOperators.ts:141`/`:276`、`src/runtime/viewportCamera.ts:96`、'
      + '`src/runtime/viewportCameraApply.ts:39`。'
      + '\n**退出条件（删除镜像字段与本条登记）**：**（乙）是唯一删除闸口** —— 上述 6 处读写点 = 0，'
      + '且 `src/runtime/main.ts` 不再声明 `embedInitialView`、`src/runtime/mainCameras.ts` 不再分配它。'
      + '两条路径都以此为准：① 缺口收口（类型化落点 + 读面就位 ⇒ 6 处改吃它）；'
      + '② 镜像消除（即便缺口未闭，只要 6 处读写点归零）。**只有（甲）不算退出。**'
      + '\n**退出阶段**：缺口收口之后的第一批，或镜像消除批 —— 二者先到先算；'
      + '与 `main-embed-publish-mirror` 同批复审。',
  }),
  /**
   * ⚠️ **已核销**：原
   * `shared-viewport-upward-imports-assembly-root` 曾登记在此。
   *
   * ## 它为什么可以退出（两个子句同时成立，不是"看起来走了"）
   *
   * | 子句 | 结论 | 机械证据（口径与读数均**亲跑**，不转抄任何自述） |
   * |---|---|---|
   * | 甲 具名装配面 + 必填注入 | ✅ | `src/runtime/host.ts:81` 声明 `Host#createViewportPresenter(regionId: string): ViewportPresenterBundle`，包形状见 `:34`（`surface`/`textures`/`textureResourcesOf`/`sceneSeconds`/`dispose`，创建与释放同源），实现 `:123`；描边侧同族 `:74` 声明 / `:108` 实现。两个生产调用方都经它提供：`shared/viewport/EmbedViewport.vue:107`、`workbench/components/WorkbenchViewport.vue:70`（`createPresenter: (rid) => host.createViewportPresenter(rid)`），描边在 `EmbedViewport.vue:405` / `WorkbenchViewport.vue:181`。视口侧 `src/shared/viewport/useViewportRuntime.ts:82` 的 `createPresenter` 是**必填**成员（同 `renderDocRef` 形）⇒ 省略即类型错误，**无退回就地构造的旁路**。 |
   * | 乙 该文件对 `@/composition/` 的**值导入 = 0** | ✅ | 亲跑读数 **0**（含 `import type` 的全量为 **1**：`useViewportRuntime.ts:15` 的 `import type { PresenterSession }`；动态 `import('@/composition/…')` = 0）。口径见下节。 |
   *
   * ## （乙）的判据口径
   *
   * 把行注释（`//`）与块注释**置换为空白**后，按
   * `^\s*import\s+(?!type\b)…from '@/composition/…'` 匹配 **import 声明**：
   * 字符串字面量**保留**（模块说明符本身就是字符串 —— 剥掉它就没有判据可言），
   * 故本文件头注释里出现的 `composition/` 字样一律**不计**（裸 `grep` 会误判）。
   * `import type` 不计入值导入，动态 `import()` 表达式单独计。
   *
   * ## 计数历史（同一口径在历史 blob 上**逐点复算**，不是转抄）
   *
   * | 时点 | 值导入数 | 复算 |
   * |---|---|---|
   * | 起点（值导入 4 条：`presenterSession` / `viewportTexturePort` / `kernelTextureResources` / `kernelRuntime`） | **4** | ✅ 复算 = 4 |
   * | 中间修订（曾误记 5，已纠正） | ~~5~~ | 该增量由"注解的读内核场景收进 `PresenterSession#syncKernelAnnotations`"消除 |
   * | 该修订落地后 | **4** | ✅ 复算 = 4 |
   * | 收口（值导入清零） | **0** | ✅ 复算 = 0（读数得到独立复现） |
   * | 测量时点 | **0** | ✅ 复算 = 0 |
   *
   * **负对照**：在同一份文本里注入 1 条值导入 ⇒ 读数由 0 变 **1**（证明计数有区分力，
   * 不是恒零）。反复活的**常驻判据**落在
   * `tests/architecture/shared-viewport-upward-import-closure.test.ts`
   * —— 本表已不再看管本条，守护随之搬到测试里（同 `seams.test.ts` 对已核销项的处置）。
   *
   * ## 为什么是"删除登记"而不是"改写登记"
   *
   * 本表语义是"双轨**剩余**数、只应减少"（见文件头）：`oldTrack` 描述的那 4 条值导入
   * 与就地 `new PresenterSession(...)` 已从代码里消失 ⇒ 留在表里就是**空转登记**，
   * 而"登记表 = 现状清单"是这张表存在的全部理由（同 `kernel-property-write-dual-track`
   * 等条的处置）。
   *
   * ## 诚实登记的残余（**不在**本条范围，也不由本次消除）
   *
   *  - **type-only 仍余 1 条**：`useViewportRuntime.ts:15` 的
   *    `import type { PresenterSession }`（只用于 `Parameters<…>` 形态推导）。它不进运行时
   *    依赖图，但**不是**永久保留项 —— 其归属（能否注入形状 / type-only 是否计入值导入）
   *    由契约修订一并裁定。
   *  - **他文件里对本 id 的交叉引用未同步改净**（不在当前改动范围，如实登记）：
   *    `src/composition/presenterSession.ts:673` 仍写"**已登记**的结构债"——核销后此说不准；
   *    `src/runtime/drw.ts:39`、`src/runtime/host.ts:30`/`:65`、
   *    `src/shared/viewport/EmbedViewport.vue:105` 与
   *    `src/shared/viewport/useViewportRuntime.ts:8`/`:72` 亦点名本 id。
   *    ⇒ 按"核销后口径"改词交上述文件的归属写者，本次不越界改。
   */
])

/** 按 id 取登记项（未登记返回 `undefined`，由调用方决定是缺口还是缺陷）。 */
export function seamById(id: string): SeamRegistration | undefined {
  return SEAMS.find((s) => s.id === id)
}
