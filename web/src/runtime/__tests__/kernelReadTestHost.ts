/**
 * **内核读面的测试宿主**（#301 P10f C′1）。
 *
 * ## 为什么需要它
 *
 * C′1 把若干查询从"直读 legacy `getDoc()`"迁到**内核读面**
 * （`ctx.kernelAnnotations()` / `ctx.kernelMaterials()` / `ctx.frameDeclarations()`）。
 * 既有测试用"只提供 `getDoc()` 的最小 ctx" ⇒ 迁移后会因
 * `ctx.kernelMaterials is not a function` 判红（**这是正确的摩擦**：
 * 生产读面变了，替身必须同步）。
 *
 * ## ⚠️ 核心设计：`ctx` 是**真的 `Context`**，不是复刻
 *
 * 本宿主用 `Object.create(Context.prototype)` × `Object.assign` 造一个真 `Context`，
 * 只注入读面所需的字段（`main` / `kernel`）。
 *
 * ### 为什么必须这样（本批实测两轮的教训）
 *
 * 我第一版让宿主**复刻**了"装配成功 ? 内核 : legacy"那段分流。后果是判据**空转**：
 * 把生产 `Context.kernelAnnotations` 改成"永远返回空表"，测试**仍全绿**
 * （实测两轮确认）。那正是本工程反复吃过的"两份实现必然漂移"。
 *
 * ⇒ 把判定提进纯函数 `runtime/sideTableResolution`（生产与测试**同一处**），
 * 且本宿主的 `ctx` 是**生产 `Context` 实例** ⇒ `ctx.kernelAnnotations()` 执行的是
 * **生产实现本体**，注入缺陷会当场判红。
 *
 * ## 为什么不构造完整的 `Context`
 *
 * 真构造函数要 `Main`/`WM`/`ViewportManager`/`ScreenRoot`/`WorkbenchServices` 五件外壳。
 * 本宿主只注入读面用到的两件（`main.doc` 与 `kernel`），其余字段对读面不可达。
 * ⚠️ 这是"取事实那一步的替身"，**不是**"判定的替身" —— 判定在被调用的生产方法里。
 */

import { ref, type Ref } from 'vue'
import { Context } from '@/runtime/context'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID, KernelSession } from '@/runtime/kernelSession'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { multiblockDeclarationViewOf } from '@/domain/multiblockDocument'
import { projectMultiblockSelection } from '@/domain/multiblockSelection'
import {
  channelPanelModelOf,
  type MultiblockChannelPanelModel,
} from '@/shared/viewport/multiblockChannelUi'

export interface KernelReadHost {
  /** **生产** `Context` 实例（只有 `main`/`kernel` 两件被注入）。 */
  readonly ctx: Context
  readonly session: KernelSession | null
  setDocument(doc: RuntimeDocument | null): void
  /**
   * **测试侧**对"被跟踪的 legacy 文档"的观测口。
   *
   * ## 为什么它在测试宿主里，而不在生产 API 上（#301 P10f D3 的判据设计）
   *
   * D3 删掉了 `getDoc()` —— 其机械含义是"**旧文档不再是生产可读的权威**"。
   * 但"双轨回写是否真的落在 legacy"这类判据**必须**能观测旧文档，
   * 否则 #333 那一类缺陷（内核写了、legacy 没投影）就重新变得不可判。
   *
   * 处置：观测口留在**宿主**（本文件持有 `docRef` 这一注入事实），
   * **不**回到生产 `Context` 上。于是：
   *  - 生产代码无法读旧文档（判据本意达成）；
   *  - 测试**显式声明**它在观测一份"自己注入的、被生产代码替换过的"值
   *    —— 而不是伪装成"生产有这么一个读面"。
   *
   * 这与 `editors/__tests__/p10fPanelTooltipWrite.test.ts` 的 `doc()` 同一手法
   * （那里一直是这么做的，本批只是把它推广到本宿主）。
   */
  legacyDocument(): RuntimeDocument | null
  dispose(): void
}

/**
 * 造一个真 `Context`，只注入读面所需的字段。
 *
 * `main` 只需 `doc`（`Ref<RuntimeDocument | null>`）—— 读面里唯一读的字段。
 * `kernel` 为 `null` 时正是"无内核会话"（配置事实，生产里也存在）。
 */
function makeRealContext(docRef: Ref<RuntimeDocument | null>, session: KernelSession | null): Context {
  const ctx = Object.create(Context.prototype) as Context
  Object.assign(ctx as unknown as Record<string, unknown>, {
    main: makeFakeMain(docRef),
    kernel: session,
    /**
     * **装配能力 = 空集**（M7-5）。
     *
     * 本宿主是"只注入读面所需字段"的手工 `Context`（`Object.create` 不执行类字段
     * 初始化器 ⇒ 生产构造函数里的空集缺省在这里**不存在**）。`Context` 的能力查询
     * 是若干读面的门（工作台会话/悬停/外观…），给空集让它们**失败关闭**：
     * 没有装配就没有工作台外壳能力，读面按生产语义抛 `workbench:` 而不是 TypeError。
     */
    capabilities: Object.freeze([]) as readonly string[],
  })
  return ctx
}

/**
 * `main` 的**忠实替身**（只含读面 + 唯一写入口用到的那几个字段）。
 *
 * ## 为什么 `replaceDoc` 必须真的写 `doc.value`（不能省）
 *
 * #301 P10f D3 的 `Context#restoreDocumentSnapshot`（撤销快照）**经 `setDocument`**
 * —— 而 `setDocument` 的第一句就是 `this.main.replaceDoc(next)`。
 * 若替身没有 `replaceDoc`，R8 的判据会以 `is not a function` 判红
 * （**正确的摩擦**：生产路径多了一个必经点，替身必须同步）。
 *
 * 「文档被替换」在生产里是**两个信号一起动**（`contentRefreshTick` +
 * `documentRevision`，见 `Main#replaceDoc`），故替身也一起动
 * —— 只动 `doc.value` 会让"换文档后哪些读面该刷新"这类判据假绿。
 *
 * ## ⚠️ `revision` 参数必须**逐字复刻**（R1-β① C1 / 裁决③）
 *
 * 第一版替身**忽略**第二个实参、无条件 bump 两个信号 ⇒ 它比生产**更宽**，
 * 于是"`content-sync` 不推进 `documentRevision`"这条判据在本宿主上**恒绿不可能**
 * （实测：C1 落地后它仍是老的 bump-both 形态）。这正是本工程反复吃过的**替身失真**：
 * 判据会被一个比生产更宽松的替身喂成假绿/假红。
 *
 * ⇒ 本替身与 `Main#replaceDoc` **逐点相同**：
 *  - `contentRefreshTick` **两种意图都 bump**（宽信号："内容可能变了"）；
 *  - `documentRevision` **只在**`revision === 'document'` 时 bump（窄信号："换了一份文档"，
 *    它是 `EmbedViewport.vue` 重置 `didInitCamera` 的依据）。
 *
 * 忠实性由判据本尊把守（`r1ContentSyncRevision.test.ts` 的"替身 vs 生产源码"组）：
 * 生产若改了这段语义而替身没跟，那条会判红。
 */
function makeFakeMain(docRef: Ref<RuntimeDocument | null>): Record<string, unknown> {
  const contentRefreshTick = ref(0)
  const documentRevision = ref(0)
  return {
    doc: docRef,
    contentRefreshTick,
    documentRevision,
    replaceDoc(next: RuntimeDocument | null, revision: 'document' | 'content' = 'document'): void {
      docRef.value = next
      // 宽信号：两种意图都要（读面靠它重读内容）。
      contentRefreshTick.value += 1
      // 窄信号：只有**真的换文档**才推进（与 `Main#replaceDoc` 的早退同形）。
      if (revision === 'content') return
      documentRevision.value += 1
    },
    requestContentRefresh(): void {
      contentRefreshTick.value += 1
    },
  }
}

/**
 * **换文档**：镜像生产 `Context.setDocument` 的两段（legacy 写 + 内核存在性镜像）。
 *
 * ⚠️ 必须**真的**调 `session.markLoaded()`/`markUnloaded()` ——
 * `markLoaded` 会清 GF-16（"有了一份文档"不蕴含"内核里的就是它"）。
 * 若替身只改 `docRef`，就读不出"换文档后不得再读到上一份文档的注解"
 * 那条判据（实测：这样写会假绿）。
 */
function swapDocument(
  docRef: Ref<RuntimeDocument | null>,
  session: KernelSession | null,
  next: RuntimeDocument | null,
): void {
  docRef.value = next
  if (session === null) return
  if (next === null) session.markUnloaded()
  else session.markLoaded()
}

/**
 * **生产面板模型**（与 `useKernelChannels#panel` **同一派生**）：内核读面 + 唯一求值点。
 *
 * M6-1：旧文档版 `buildChannelPanelModel`（形参 `RuntimeDocument`）已退役。判据要的
 * 面板模型必须来自生产派生（声明 = `DocumentContent.multiblock`、场景数 = 声明里的
 * `scenes`、尺寸/提示 = `evaluateMultiblockPresentation` 的装配报告），故把
 * "生产派生"收在这一个测试口里 —— 两个判据文件不再各写一遍。
 *
 * `null` = 无声明（帧为主文档）或装配面缺席（如实降级，不伪造空面板）。
 */
export function productionPanelModelOf(host: KernelReadHost): MultiblockChannelPanelModel | null {
  const decl = host.ctx.kernelMultiblockDeclaration()
  if (decl === null) return null
  const view = multiblockDeclarationViewOf(decl)
  return channelPanelModelOf(
    view,
    projectMultiblockSelection(view, host.session?.channelValues() ?? {}),
    decl.scenes.length,
    host.ctx.kernelMultiblockEvaluation()?.assembly ?? null,
  )
}

/** **legacy 分支**宿主：不装配（读面走 legacy 侧）。 */
export function makeKernelReadHost(doc: RuntimeDocument | null): KernelReadHost {
  // 两跳断言（`as unknown as`）：Vue 的 `ref()` 会把 `RuntimeDocument`（含私有字段的
  // 类实例）解包成结构类型 ⇒ 单跳断言仍报 TS2322（实测）。运行期是同一个对象。
  const docRef = ref(doc) as unknown as Ref<RuntimeDocument | null>
  return {
    ctx: makeRealContext(docRef, null),
    session: null,
    setDocument: (next: RuntimeDocument | null): void => swapDocument(docRef, null, next),
    legacyDocument: (): RuntimeDocument | null => docRef.value,
    dispose: (): void => {},
  }
}

/**
 * **内核分支**宿主：走**生产** `adoptLoadedDocument` 真装配。
 *
 * @param plainRoot 装配源（`plainRootOf(raw)`）；不给 ⇒ 装配可能降级（GF-16=false）
 */
export function makeAdoptedKernelReadHost(
  doc: RuntimeDocument,
  plainRoot?: Readonly<Record<string, unknown>>,
): KernelReadHost {
  const docRef = ref(doc) as unknown as Ref<RuntimeDocument | null>
  const session = new KernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: [],
  })
  adoptLoadedDocument(
    { kernel: session, log: { info: () => {}, warn: () => {} } },
    doc,
    plainRoot,
    'test-host',
  )
  return {
    ctx: makeRealContext(docRef, session),
    session,
    setDocument: (next: RuntimeDocument | null): void => swapDocument(docRef, session, next),
    legacyDocument: (): RuntimeDocument | null => docRef.value,
    dispose: (): void => session.dispose(),
  }
}
