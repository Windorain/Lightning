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

export interface KernelReadHost {
  /** **生产** `Context` 实例（只有 `main`/`kernel` 两件被注入）。 */
  readonly ctx: Context
  readonly session: KernelSession | null
  setDocument(doc: RuntimeDocument | null): void
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
    main: { doc: docRef },
    kernel: session,
  })
  return ctx
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

/** **legacy 分支**宿主：不装配（读面走 legacy 侧）。 */
export function makeKernelReadHost(doc: RuntimeDocument | null): KernelReadHost {
  // 两跳断言（`as unknown as`）：Vue 的 `ref()` 会把 `RuntimeDocument`（含私有字段的
  // 类实例）解包成结构类型 ⇒ 单跳断言仍报 TS2322（实测）。运行期是同一个对象。
  const docRef = ref(doc) as unknown as Ref<RuntimeDocument | null>
  return {
    ctx: makeRealContext(docRef, null),
    session: null,
    setDocument: (next: RuntimeDocument | null): void => swapDocument(docRef, null, next),
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
    dispose: (): void => session.dispose(),
  }
}
