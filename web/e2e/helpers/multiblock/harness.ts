/**
 * T2.6 无头渲染断言管线 —— 骨架 harness（第一阶段）。
 *
 * 零替身五原则的落点（逐条）：
 *  1. **入口挂载**：`gotoWorkbench()` 打开 `/`（`index.html` → `main-dev.ts` → `DevApp.vue`
 *     → 完整 `WorkbenchRoot.vue`），不挂测试壳、不 import 内部模块拼装。
 *  2. **DOM 事件注入**：`setSliderValue()` / `pressSliderKey()` / `clickLocator()` 全部
 *     作用在真实 DOM 元素上（range input、tab 按钮），由浏览器派发
 *     `input`/`change`/`click`/`keydown`；绝不直接调用 operator 或内部函数。
 *     （`ctx.getOperators().exec(...)` 仅用于**等价于生产路径的 IO 接管**，
 *     见第 3 条——它不是观测点。）
 *  3. **IO 接管**：`injectSceneDocument()` 用 `File` + `OPERATOR_OPEN_SCENE` 注入场景。
 *     该 seam 就是**生产代码自己的入口**——`WorkbenchViewport.vue` 的
 *     `onDrop()` 对拖入的 .json 走同一 operator、同一 `file` 属性。
 *     因此没有为测试新开 src 侧后门；仓库 fixture 原件永不被改写
 *     （篡改只在测试内对注入副本进行）。
 *  4. **公开观测**：观测集合 = `window.__vm__`（`WorkbenchRoot.vue` 显式声明的
 *     「测试层通过 window.__vm__ 访问公开观测面」）上的
 *     `ctx.getDoc()` / `ctx.getCurrentFrameIndex()` / `ctx.getLayerWorldY()` /
 *     `ctx.viewports.get('r-viewport')`（`definition` / `layerPreview`），
 *     加上 DOM（`.vp-dock__stat`、`#wm-layer-range` 的 aria）与截图。不读任何私有字段。
 *  5. **零替身**：全程生产类实例；无 Mock/Fake/Stub，无测试专用 URL 参数。
 */

import { expect, type Locator, type Page } from '@playwright/test'
import { parseMultiblockDeclaration } from '@/context/parsers/multiblockDocument'

/** Workbench 入口（`web/index.html`，与 `obj-export.spec.ts` 同入口）。 */
export const WORKBENCH_URL = '/'
/** 视口 region id（`src/runtime/regionIds.ts` 的 `REGION.WORKBENCH_VIEWPORT`）。 */
export const VIEWPORT_REGION = 'r-viewport'
/** 帧滑杆（`WorldFrameScrubber.vue`）。 */
export const FRAME_SLIDER = 'input.nei-slider__range[aria-label^="当前帧"]'
/** 分层预览滑杆（`LayerPreviewBar.vue`，id 固定）。 */
export const LAYER_SLIDER = '#wm-layer-range'
/** 顶部 dock 的 tab 行（`ViewportFrameLayerDock.vue`）。 */
export const DOCK = '.vp-dock'
/** 播放/暂停按钮（`WorldFramePlayerControls.vue`）。 */
export const PLAYBACK_BUTTON = '.wm-wfp-controls .nei-ctrl-btn'
/** dock 右上角状态容器：含 `帧 i/N` 与 `层 <label>` 两个 stat。 */
export const DOCK_STAT = '.vp-dock__stat'
/** dock 状态行容器（读整行文本用这个；`.vp-dock__stat` 有两个）。 */
export const DOCK_STATUS = '.vp-dock__tab-status'
/** 真实 3D 画布容器（`RenderEngineHost.vue`）。 */
export const VIEWPORT_CANVAS = '.vc-viewport'

// ---------------------------------------------------------------------------
// 入口挂载
// ---------------------------------------------------------------------------

/**
 * 打开完整 Workbench 并等到 `__vm__` 公开观测面就绪。
 *
 * 此时**还没有**场景：`RenderEngineHost` 只在 `loadStatus === 'ok'` 时挂载，
 * 所以 `.vc-viewport` 要等注入场景之后才出现（见 `waitForViewportMounted`）。
 */
export async function gotoWorkbench(page: Page): Promise<void> {
  // 生产路径在「有未保存修改」时会走 window.confirm 询问；
  // 测试视作「确认丢弃」，避免 headless 下默认 dismiss 造成误判。
  page.on('dialog', (d) => {
    void d.accept()
  })
  await page.goto(WORKBENCH_URL)
  await page.waitForFunction(() => (window as any).__vm_ready__ === true, undefined, {
    timeout: 90_000,
  })
  await expect(page.locator('.wb-shell')).toBeVisible({ timeout: 90_000 })
}

/** 等到真实 3D 容器（`.vc-viewport`）挂载——即 `loadStatus === 'ok'` 且定义就绪。 */
export async function waitForViewportMounted(page: Page, timeout = 60_000): Promise<void> {
  await expect(page.locator(VIEWPORT_CANVAS)).toBeVisible({ timeout })
}

/** 等到 doc 非空（加载成功后才有 document）。 */
export async function waitForDocLoaded(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const ctx = (window as any).__vm__
      // #301 P10f D3：存在性走 GF-15 读面（`getDoc()` 已终删）。
      return !!ctx && ctx.hasLoadedDocument()
    },
    undefined,
    { timeout },
  )
}

/**
 * 等到「已渲染网格」= 视口 slot 的 `definition` 非空。
 * 仅对帧为主文档有意义（多方块文档的网格由 T2.2/T2.5 装配后写入，同理适用）。
 */
export async function waitForRenderedGrid(page: Page, timeout = 60_000): Promise<void> {
  await page.waitForFunction(
    (regionId) => {
      const ctx = (window as any).__vm__
      const slot = ctx?.viewports?.get(regionId)
      return !!slot && slot.definition.value !== null
    },
    VIEWPORT_REGION,
    { timeout },
  )
}

/**
 * 等到当前帧索引为 `index`。
 *
 * ## P10 #261：观测点从 `ctx.getCurrentFrameIndex().value` 改为 `ctx.getFrameIndex()`
 *
 * 旧观测点返回一个**可写** `Ref<number>`（`Main.currentFrameIndex`），本批已删除。
 * 新观测点是**只读派生**访问器（`Context.getFrameIndex()`）—— 它由
 * `EditContext.time` 经离散阶跃采样算出。
 *
 * 对 e2e 的意义是**判据更强了**：旧观测点只能证明"某个 Ref 被写成了 i"
 * （写入者可能是 operator，也可能不是播放）；新观测点证明的是
 * "**内核的时间**落在第 i 帧上"。后者才是 T2.6「播放推进」真正要断言的事。
 */
export async function waitForFrameIndex(page: Page, index: number, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    (i) => {
      const ctx = (window as any).__vm__
      return !!ctx && ctx.getFrameIndex() === i
    },
    index,
    { timeout },
  )
}

/** 等到图层 Y 为 `y`（公开观测点 `ctx.getLayerWorldY()`）。 */
export async function waitForLayerY(page: Page, y: number, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    (v) => {
      const ctx = (window as any).__vm__
      return !!ctx && ctx.getLayerWorldY().value === v
    },
    y,
    { timeout },
  )
}

// ---------------------------------------------------------------------------
// 导航竞态防护（#272）
// ---------------------------------------------------------------------------

/**
 * 每页的**导航纪元**（main frame 的 `framenavigated` 计数）。
 *
 * ## 为什么需要计数，而不是只靠 try/catch
 *
 * `page.evaluate` 的语义是"在**当前**执行上下文里跑"。若该窗口内页面发生了导航
 * （新文档被提交），上下文被销毁，于是有两种坏结果：
 *
 *  1. evaluate **抛错** —— `Execution context was destroyed, most likely because of a
 *     navigation`（本单报告的现象）；
 *  2. evaluate **成功返回**，但结果来自**即将被丢弃的文档** —— 更坏：没有任何异常，
 *     调用方拿着一个"来自上一份文档"的结果继续跑，后续断言在错误的页面上进行。
 *
 * 只用 try/catch 只能挡住第 1 种。纪元计数把"这次尝试期间到底有没有导航"
 * 变成**可判定的事实**：返回值只有在纪元未变时才被接受（见 `evaluateNavigable`）。
 *
 * ## 为什么挂监听在这里而不是在 spec 里
 *
 * 监听必须**只注册一次**（`page.on` 每次调用都会新增一个监听器，重复注册会泄漏）。
 * 用 `WeakMap` 以 `page` 为键做惰性注册，页面被回收时状态随之消失。
 */
const navEpochs = new WeakMap<Page, { count: number }>()

/** 取当前导航纪元（首次调用时为本页注册一次性监听）。 */
export function navEpochOf(page: Page): number {
  let st = navEpochs.get(page)
  if (st === undefined) {
    const state = { count: 0 }
    navEpochs.set(page, state)
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) state.count += 1
    })
    return state.count
  }
  return st.count
}

/**
 * 等到"可以安全 evaluate"的状态：本帧 load 已发生、app 已就绪、DOM 完成。
 *
 * 三条判据都**幂等**（已满足时立即返回），故可安全地放在每次尝试之前。
 *
 * ## 为什么不用 `networkidle`
 *
 * `networkidle`（500ms 无网络）在本应用里**不可靠**：视口渲染、纹理预取与 wiki
 * 数据页查询都可能持续产生请求，于是它要么白等到超时、要么因"恰好安静了一瞬"
 * 而给出误导性的通过。判据应当表达**真实前提**（"文档已 load 且 app 已引导完成"），
 * 而不是"网络看起来安静"。
 */
export async function waitForEvaluateReady(page: Page, timeout = 90_000): Promise<void> {
  await page.waitForLoadState('load', { timeout })
  await page.waitForFunction(
    () => (window as any).__vm_ready__ === true && document.readyState === 'complete',
    undefined,
    { timeout },
  )
}

/**
 * "evaluate 因导航被打断"的**专用错误类型**。
 *
 * ## 为什么需要显式类型（而不是靠消息里恰好含某段文字）
 *
 * `evaluateNavigable` 在尝试耗尽后会抛一个**包装**错误（带尝试次数与最后原因）。
 * 若上层（`injectSceneDocumentOk`）只靠正则匹配消息来判断"这是不是导航竞态"，
 * 就会依赖"包装消息恰好原样嵌入了 Playwright 的原文"这一**偶然**事实 ——
 * 一旦消息模板调整（例如以后不再拼接 `lastReason`），判定会静默失效，
 * 重试不再触发，缺陷以"偶发红"的形式回来。
 *
 * 故用显式类型把"是不是导航竞态"变成**类型系统**能回答的问题：
 *  - 原始 Playwright 错误：靠消息识别（它是外部库，我们无法给它加类型）；
 *  - 本模块包装后的错误：靠 `instanceof` 识别（可靠，与文案无关）。
 */
export class NavigationInterruptedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NavigationInterruptedError'
  }
}

/**
 * 本单竞态的**精确**签名（导航销毁执行上下文）。
 *
 * 刻意保持**窄**：只认导航/上下文销毁这一类。任何其它错误（断言失败、超时、
 * 应用抛错）都**立即上抛**，绝不被重试吞掉 —— 否则重试就从"接住环境竞态"
 * 退化成"掩盖真实缺陷"，那正是本单要避免的方向。
 */
export function isNavigationDestroyedError(e: unknown): boolean {
  if (e instanceof NavigationInterruptedError) return true
  const m = e instanceof Error ? e.message : String(e)
  return /Execution context was destroyed/.test(m) || /most likely because of a navigation/.test(m)
}

export interface NavigableEvaluateOptions {
  /** 最大尝试次数（含首次）。**有界**：不是无限重试。 */
  readonly attempts?: number
  readonly timeout?: number
}

/**
 * 在**导航竞态**下依然可用的 `page.evaluate`。
 *
 * ## 契约（三件事同时成立才算成功）
 *
 *  1. 每次尝试前先过 {@link waitForEvaluateReady}（load + app 就绪）；
 *  2. evaluate 正常返回；**且**
 *  3. **该次尝试期间没有发生导航**（纪元未变）—— 否则返回值按"可能来自已丢弃文档"
 *     处理，属于失败，需重试。
 *
 * ## 为什么这不是"加 sleep 碰运气"
 *
 *  - **不 sleep**：重试前不等待固定时长，而是等**可判定的就绪条件**（新文档 load +
 *    app 引导完成）。等待的是事实，不是时长。
 *  - **有界**：`attempts` 默认 3。耗尽仍失败 ⇒ 抛错（含最后一次的真实原因），
 *    不会把失败变成静默通过。
 *  - **只接环境竞态**：非导航类错误原样上抛，判据强度不受影响。
 *
 * ## 与"重试掩盖缺陷"的界线
 *
 * 被重试的是**环境**（dev server 的 HMR `full-reload` / `vite:ws:disconnect` 会让
 * Vite 客户端 `location.reload()`，见 `vite/dist/client/client.mjs` 的
 * `debounceReload` 与 `vite:ws:disconnect` 分支）—— 与产品行为无关，
 * 而重试后必然重新履行"注入 → 断言 docLoaded"的完整判据（见 `injectSceneDocumentOk`），
 * 故没有任何断言被放宽。
 */
export async function evaluateNavigable<T, A>(
  page: Page,
  fn: (arg: A) => T | Promise<T>,
  arg: A,
  opts: NavigableEvaluateOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3
  const timeout = opts.timeout ?? 90_000
  let lastReason = '未知'
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await waitForEvaluateReady(page, timeout)
    const epochBefore = navEpochOf(page)
    try {
      const value = await page.evaluate(fn as never, arg as never)
      if (navEpochOf(page) === epochBefore) return value as T
      lastReason = 'evaluate 期间发生了导航（结果不可信，可能来自已被丢弃的文档）'
    } catch (e) {
      if (!isNavigationDestroyedError(e)) throw e
      lastReason = e instanceof Error ? e.message.split('\n')[0] : String(e)
    }
    if (attempt < attempts) {
      // 等**新文档** load 完成再进入下一次尝试（失败时超时无妨：下一轮的就绪门会再等）。
      await page.waitForLoadState('load', { timeout }).catch(() => undefined)
    }
  }
  throw new NavigationInterruptedError(
    `evaluateNavigable：${attempts} 次尝试均被导航打断（每次都等到 load + app 就绪后才重试）。` +
      `最后一次原因：${lastReason}`,
  )
}

// ---------------------------------------------------------------------------
// IO 接管：场景注入
// ---------------------------------------------------------------------------

export interface InjectResult {
  docLoaded: boolean
  docId: string | null
  isMultiblock: boolean | null
  frameCount: number | null
  /** 解析失败时 parser registry 返回的原因（生产 UI 会把它写进日志）。 */
  parseError: string | null
}

/**
 * 通过**生产代码自己的拖放路径**注入场景文档（IO 接管）。
 *
 * 走 `OPERATOR_OPEN_SCENE` + `{ file }`：与 `WorkbenchViewport.vue#onDrop` 中的
 * `ctx.getOperators().exec('OPERATOR_OPEN_SCENE', { file })` 完全一致，
 * 因此无需在 src 侧新增任何注入口。
 *
 * `json` 由调用方给出——可以是仓库 fixture 原件，也可以是测试内动态篡改的副本
 * （篡改副本在内存里，不落盘、不改仓库原件）。
 *
 * ## 为什么走 `evaluateNavigable` 而不是裸 `page.evaluate`（#272）
 *
 * 注入要跑 `OPERATOR_OPEN_SCENE`（解析 JSON + 建文档 + 装配），耗时数百毫秒 ——
 * 这是一个**窗口**。若该窗口内页面发生导航（dev server 的 HMR `full-reload`
 * 或 `vite:ws:disconnect` 都会让 Vite 客户端 `location.reload()`），执行上下文被销毁，
 * 于是报 `Execution context was destroyed, most likely because of a navigation`
 * ——即 #272 观测到的间歇失败（全量套件、负载下更易出现；单跑该 spec 不复现）。
 * `evaluateNavigable` 把"注入前等到就绪 + 窗口内无导航"变成判据，而不是靠运气。
 */
export async function injectSceneDocument(
  page: Page,
  json: unknown,
  fileName: string,
): Promise<InjectResult> {
  const text = JSON.stringify(json)
  return await evaluateNavigable(
    page,
    async ({ text, fileName }: { text: string; fileName: string }) => {
      const ctx = (window as any).__vm__
      if (!ctx) throw new Error('T2.6: window.__vm__ 未就绪')
      const file = new File([text], fileName, { type: 'application/json' })
      // 与生产拖放同一入口
      await ctx.getOperators().exec('OPERATOR_OPEN_SCENE', { file })
      // #301 P10f D3：内容事实各有具名读面。
      // R2/S3：形态判别改走**内核读面**（原 `ctx.legacyRenderSource()` 已退役）。
      const loaded = ctx.hasLoadedDocument()
      const plain = ctx.plainForSave().plain as Record<string, unknown> | null
      const body = ctx.kernelMultiblockBody()
      // ⚠️ **严格性**（Lead 裁决 ④）：产物 plain 声明了多方块 ⇒ body **必须**非空。
      // 缺 body 是**缺陷**（内核没接住声明），不得报成 `isMultiblock: false`
      // —— 那会用"不是多方块"掩盖失败，让调用方的断言读到一个看起来正常的 `false`。
      const declaredCount = plain?.multiblockCount
      if (typeof declaredCount === 'number' && declaredCount > 0 && body === null) {
        throw new Error(
          '内核未承载多方块 body：产物 plain 声明 multiblockCount=' + declaredCount
          + '，但 `ctx.kernelMultiblockBody()` 为 null（装配/承运缺陷，不是"帧为主文档"）',
        )
      }
      return {
        docLoaded: loaded,
        docId: (plain?.id as string | undefined) ?? null,
        isMultiblock: body !== null,
        frameCount: loaded ? ctx.frameDeclarations().count : null,
        parseError: loaded ? null : '解析失败（见 ctx.log 的场景加载 error 记录）',
      }
    },
    { text, fileName },
    // **单次**尝试：整步重做由 `injectSceneDocumentOk` 负责。
    // 若此处也用 3 次，重试次数会变成 3×3=9（嵌套相乘），既无必要也让"有界"失准。
    // 两层职责分工：本函数只保证"这一次 evaluate 没被导航打断"，不重做整个注入步骤。
    { attempts: 1 },
  )
}

/** 注入步骤的选项（有界重做；见 `injectSceneDocumentOk`）。 */
export interface InjectStepOptions {
  /** 整个"注入 + 断言已加载"步骤的最大尝试次数（含首次）。**有界**。 */
  readonly attempts?: number
  readonly timeout?: number
}

/** 注入步骤的**文档原子性标记**（一次性随机串；导航会把它连同旧文档一起清掉）。 */
function newInjectToken(): string {
  return `wk-inj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 注入并断言加载成功；返回注入结果。
 *
 * ## 为什么整步要重做，而不只是给 evaluate 加重试（#272 的实测教训）
 *
 * 注入**不止是一次 evaluate**，而是一个复合步骤：
 *
 * ```
 * ① page.evaluate(OPERATOR_OPEN_SCENE)   ← 窗口 A（数百 ms）
 * ② 断言 docLoaded                        ← 判据
 * ③ 等 doc 非空                            ← 窗口 B
 * ```
 *
 * 只保护窗口 A 是不够的：导航若落在 ②/③ 之间，evaluate 已成功返回，
 * 但**后续断言是在一份已经没有文档的新文档上做的** ⇒ `waitForDocLoaded` 一直等不到，
 * 直到 30s 超时。这不是"重试没生效"，而是**重试的作用域画小了**。
 * （本单的回归用例 A 正是这样先失败的 —— 它逼出了这个洞。）
 *
 * ⇒ 用**一次性令牌**把整步钉在同一份文档上：注入前在当前文档写入随机令牌；
 * 导航一旦发生，令牌随旧文档一起消失。于是"文档被换掉"可以**立即**判定，
 * 而不是靠把超时调短去猜。
 *
 * ## 判据强度不变
 *
 * `docLoaded` 断言与改动前**逐字相同**（消息、条件都未放宽）；令牌只用来判定
 * "这次尝试是否发生在同一份文档上"。非导航类错误（含断言失败）**原样上抛**。
 */
export async function injectSceneDocumentOk(
  page: Page,
  json: unknown,
  fileName: string,
  opts: InjectStepOptions = {},
): Promise<InjectResult> {
  const attempts = opts.attempts ?? 3
  const timeout = opts.timeout ?? 90_000
  let lastReason = '未知'
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await waitForEvaluateReady(page, timeout)
    const token = newInjectToken()
    try {
      // ① 在当前文档上打标记（若此刻正好发生导航，标记落在新文档上，仍然自洽）
      await page.evaluate((t) => {
        ;(window as any).__wk_inject_token__ = t
      }, token)

      const result = await injectSceneDocument(page, json, fileName)

      // ② 注入期间文档被换掉 ⇒ 结果与后续断言不属于同一份文档 ⇒ 重做
      if (!(await tokenStillCurrent(page, token))) {
        lastReason = '注入期间文档被替换（导航）'
        continue
      }

      // ③ 判据：与改动前逐字相同（不放宽）
      expect(result.docLoaded, `场景注入失败（${fileName}）：${result.parseError}`).toBe(true)

      // ④ 等 doc 非空；若期间文档被换掉则**立即**返回，交给下一轮重做
      await page.waitForFunction(
        (t) => {
          const w = window as any
          if (w.__wk_inject_token__ !== t) return true
          return !!w.__vm__ && w.__vm__.hasLoadedDocument()
        },
        token,
        { timeout },
      )
      if (!(await tokenStillCurrent(page, token))) {
        lastReason = '等待文档就绪期间文档被替换（导航）'
        continue
      }
      return result
    } catch (e) {
      if (!isNavigationDestroyedError(e)) throw e
      lastReason = e instanceof Error ? e.message.split('\n')[0] : String(e)
    }
    if (attempt < attempts) {
      await page.waitForLoadState('load', { timeout }).catch(() => undefined)
    }
  }
  throw new NavigationInterruptedError(
    `injectSceneDocumentOk：${attempts} 次尝试均被导航打断（每次都等到 load + app 就绪后才重做）。` +
      `最后一次原因：${lastReason}`,
  )
}

/** 当前文档是否仍是打令牌时那一份（导航会让令牌随旧文档消失）。 */
async function tokenStillCurrent(page: Page, token: string): Promise<boolean> {
  return await page.evaluate((t) => (window as any).__wk_inject_token__ === t, token)
}

// ---------------------------------------------------------------------------
// 公开观测：文档形态 / 多方块声明
// ---------------------------------------------------------------------------

export interface ChannelObservation {
  key: string
  enumName: string | null
  id: string
  name: string
  kind: string
  min: number
  max: number
  slider: boolean
  domainLo: number
  domainHi: number
  slot: string | null
}

export interface RunstateObservation {
  id: string
  name: string
  materialSwap: boolean
}

export interface BackboneStepObservation {
  channel: string
  layers: number | null
  d: number
  h: number
  w: number
  cellGrid: number[][][]
  roles: Record<string, number>
}

export interface BackboneObservation {
  kind: string
  sizeChannel: string
  stepCount: number
  steps: BackboneStepObservation[]
}

export interface FrameGridObservation {
  index: number
  /** 帧是否带自己的 grid（多方块帧为 false：网格由 T2.2 装配产生）。 */
  present: boolean
  d: number
  h: number
  w: number
  solidCells: number
}

export interface DocObservation {
  hasDoc: boolean
  docId: string | null
  /**
   * 契约**内层 body** 的形态键（`multiblockSource.documentShape`）。
   * 真实产物的形态键在**信封 meta**（契约 §2.1），因此信封形态下这里是 null ——
   * 形态判别的公开观测点用 `isMultiblock`。
   */
  documentShape: string | null
  /** `doc.multiblockSource` 是否非空（T2.2 装配器的输入是否就绪）。 */
  multiblockSourcePresent: boolean
  isMultiblock: boolean
  frameCount: number
  /** 逐帧 `doc.frames[i].grid` 的形状/实心数（帧为主文档的「当前帧数据」公开观测点）。 */
  frameGrids: FrameGridObservation[]
  channelCount: number
  channels: ChannelObservation[]
  runstateCount: number
  runstates: RunstateObservation[]
  variantCount: number
  ruleCount: number
  multiblockFrameCount: number
  totalTierDomain: { min: number; max: number; default: number | null } | null
  backbone: BackboneObservation | null
  blockPaletteSize: number
  /**
   * **解析告警**（R2/S3 起来源变更：必须连同 {@link declarationMatchesSource} 一起读）。
   *
   * 来源不再是页面里的旧文档（`doc.multiblock.warnings`，随
   * `Context#legacyRenderSource()` 一起退役），而是**内核无损源根**在测试进程里用
   * **同一个解析器**（`parseMultiblockDeclaration`）重解析的产物 —— 判据要证的性质
   * （"真实产物**文件**无解析瑕疵"）是**文件**的属性，故这样证是完整的；
   * "应用解析的是**同一份** body"这条链由 {@link declarationMatchesSource} 用内容证。
   */
  warnings: string[]
  /**
   * 应用侧观测到的声明（`kernelMultiblockBody().declaration` 的通道键 + 骨架逐格）
   * 是否**等于**上面那次重解析得到的对应值 —— 用**内容**证明同一性。
   * `null` = 内核源根未采集（那时由 {@link multiblockSourcePresent} 判）。
   */
  declarationMatchesSource: boolean | null
  /**
   * 内核**无损源根**里的 `multiblock` 节（页面侧没有解析器，故原样过桥给测试进程；
   * 见 {@link warnings}）。`null` = 未采集。
   */
  kernelMultiblockSource: unknown
  /**
   * `decl.backbone.sizeSteps[i].cellGrid` 是否与**内核无损源根**的 `multiblock.backbone`
   * 逐格一致 —— 证明解析器把格级数据**原样透传**，而不是自己算了一份。
   */
  backboneMatchesSource: boolean | null
}

/**
 * 一次性读回全部公开的文档/多方块声明观测点。
 *
 * 数据来源（全部公开，R2/S3 起全部是**内核读面**）：
 *  - `ctx.kernelMultiblockBody().declaration` → 通道 / 运行态 / 变体 / 规则 / 骨架 /
 *    总 Tier 域 / 调色板 / 帧声明（原 `doc.multiblock*` 一族）；
 *  - `ctx.kernelSourceRoot()` → 契约**内层 body 原文**（原 `doc.multiblockSource`），
 *    原样过桥给测试进程重解析（那是 `warnings` 与 `backboneMatchesSource` 的来源）；
 *  - `ctx.plainForSave().plain` → 文档 id 与形态键；
 *  - `ctx.kernelGrid(i)` → 逐帧网格；
 *  - `ctx.frameDeclarations()` → 帧数。
 */
export async function readDocObservation(page: Page): Promise<DocObservation> {
  const observed = await page.evaluate(() => {
    const ctx = (window as any).__vm__
    // ## #301 P10f D3 + R2/S3：观测面按**事实种类**分开取（`getDoc()`/`legacyRenderSource()` 均已退役）
    //
    // | 事实 | 读面 |
    // |---|---|
    // | 有文档吗 / 帧数 | `hasLoadedDocument()` / `frameDeclarations()` |
    // | 文档 id / 形态键 | `plainForSave().plain`（产物 plain 是唯一出口） |
    // | 多方块**声明**（通道/运行态/变体/规则/骨架/调色板/帧声明） | `kernelMultiblockBody().declaration`（内核承运） |
    // | 契约**内层 body 原文** | `kernelSourceRoot()`（无损源根；页面侧不解析，原样过桥） |
    // | 逐帧网格 | `kernelGrid(i)`（声明尺寸 + 逐格；i = 声明序） |
    const loaded = ctx.hasLoadedDocument()
    const plain = ctx.plainForSave().plain as Record<string, unknown> | null
    if (!loaded) {
      return {
        hasDoc: false,
        docId: null,
        documentShape: null,
        multiblockSourcePresent: false,
        isMultiblock: false,
        frameCount: 0,
        frameGrids: [],
        channelCount: 0,
        channels: [],
        runstateCount: 0,
        runstates: [],
        variantCount: 0,
        ruleCount: 0,
        multiblockFrameCount: 0,
        totalTierDomain: null,
        backbone: null,
        blockPaletteSize: 0,
        warnings: [],
        declarationMatchesSource: null,
        kernelMultiblockSource: null,
        backboneMatchesSource: null,
      }
    }
    const body = ctx.kernelMultiblockBody() as { declaration?: any } | null
    const decl = body?.declaration ?? null
    const sourceRoot = ctx.kernelSourceRoot() as Record<string, unknown> | null
    const sourceMultiblock = (sourceRoot?.multiblock ?? null) as any
    const backbone = decl?.backbone
      ? {
          kind: decl.backbone.kind,
          sizeChannel: decl.backbone.sizeChannel,
          stepCount: decl.backbone.sizeSteps.length,
          steps: decl.backbone.sizeSteps.map((s: any) => ({
            channel: s.channel,
            layers: s.layers ?? null,
            d: s.cellGrid.length,
            h: s.cellGrid[0]?.length ?? 0,
            w: s.cellGrid[0]?.[0]?.length ?? 0,
            cellGrid: s.cellGrid,
            roles: s.roles ?? {},
          })),
        }
      : null
    // ⚠️ 名字**不可**再用 `decl`：上面已有 `decl = mb?.decl`（多方块**声明**）——
    // 两者是不同的事实（帧声明 vs 多方块声明）。我第一版撞名 ⇒ `vue-tsc` **没报**
    // （`e2e/` 不在其 `tsconfig` 的 include 内）而 **L2 的 babel 解析当场判红**
    //（`Identifier 'decl' has already been declared`）。记此：**e2e 的语法正确性
    // 只由 L2 把守**，别指望 L0。
    const frameDecl = ctx.frameDeclarations()
    return {
      hasDoc: true,
      docId: (plain?.id as string | undefined) ?? null,
      // 形态键取自**产物 plain**（原取自内层 body 的 `documentShape`）。语义变化如实登记：
      // 信封形态下旧口径恒 `null`（meta 里的形态键不在内层 body 上），新口径为 `'multiblock'`；
      // R2/S3 实测全仓**没有**任何判据依赖旧口径（`doc.documentShape` 无 spec 断言）。
      documentShape: typeof plain?.documentShape === 'string' ? plain.documentShape : null,
      multiblockSourcePresent: sourceMultiblock !== null,
      isMultiblock: body !== null,
      frameCount: frameDecl.count,
      // 逐帧网格走 R5（`kernelGrid(i)`；i = 声明序 —— 与旧 `frames[i]` 同一遍历序）。
      frameGrids: Array.from({ length: frameDecl.count }, (_v, i) => {
        const grid = ctx.kernelGrid(i)
        if (!grid) return { index: i, present: false, d: 0, h: 0, w: 0, solidCells: 0 }
        return {
          index: i,
          present: true,
          d: grid.depth,
          h: grid.height,
          w: grid.width,
          solidCells: grid.count(),
        }
      }),
      channelCount: decl?.channels?.length ?? 0,
      channels: (decl?.channels ?? []).map((c: any) => ({
        key: c.key,
        enumName: c.enumName ?? null,
        id: c.id,
        name: c.name,
        kind: c.kind,
        min: c.min,
        max: c.max,
        slider: c.slider,
        domainLo: c.domain.lo,
        domainHi: c.domain.hi,
        slot: c.slot ?? null,
      })),
      runstateCount: decl?.runstates?.length ?? 0,
      runstates: (decl?.runstates ?? []).map((r: any) => ({
        id: r.id,
        name: r.name,
        materialSwap: !!r.materialSwap,
      })),
      variantCount: decl?.variants?.length ?? 0,
      ruleCount: decl?.rules?.length ?? 0,
      multiblockFrameCount: decl?.frames?.length ?? 0,
      totalTierDomain: decl
        ? {
            min: decl.totalTierDomain.min,
            max: decl.totalTierDomain.max,
            default: decl.totalTierDomain.default ?? null,
          }
        : null,
      backbone,
      blockPaletteSize: decl?.blockPalette?.length ?? 0,
      // ⚠️ 页面侧**不产**告警：来源已随旧读面退役 ⇒ 改由测试进程重解析**内核源根**填，
      // 见 `withSourceParse` 与 `DocObservation#warnings` 的说明（含口径边界）。
      warnings: [],
      declarationMatchesSource: null,
      kernelMultiblockSource: sourceMultiblock,
      backboneMatchesSource: (() => {
        const rawSteps = sourceMultiblock?.backbone?.sizeSteps
        if (!Array.isArray(rawSteps) || !backbone) return null
        if (rawSteps.length !== backbone.steps.length) return false
        return rawSteps.every(
          (s: any, i: number) =>
            JSON.stringify(s.cellGrid) === JSON.stringify(backbone.steps[i]!.cellGrid),
        )
      })(),
    }
  })
  return withSourceParse(observed)
}

/**
 * **内核源根 → 重解析**（R2/S3 的 `warnings` 处置；Lead 裁决 ④ 的 (iii) 方案）。
 *
 * ## 为什么这样证是完整的
 *
 * 判据要证的性质是"**真实产物文件**无解析瑕疵"—— 那是**文件**的属性，故在测试进程里
 * 用**同一个解析器**（`parseMultiblockDeclaration`，与生产同一实现）重解析内核无损源根，
 * 就把这条性质完整证了；而"应用解析的是**同一份** body"这条链由**内容**证：
 * `declarationMatchesSource` 把应用侧观测到的通道键与骨架逐格值，与重解析得到的
 * 对应值**直接比对**（不靠"两边各自与期望比"的传递性）。
 *
 * ## 口径边界（如实登记）
 *
 * 内核无损源根是「内层 body 剔除 meta 键后与信封 meta 合并」的产物
 * （`adapters/plainRoot#plainRootOf`）—— 比原始内层字节**多**了 meta 键（如 `documentShape`）。
 * 那不影响本处要比对的声明字段，但严格说"重解析的输入不是原文件字节"；
 * 与原文件字节一致的那一份由 fixture 门控覆盖
 * （`scripts/multiblock-fixtures/validate-multiblock-fixtures.mjs --all --verify-grids`）。
 */
function withSourceParse(obs: DocObservation): DocObservation {
  const source = obs.kernelMultiblockSource
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    // 未采集（无内核载体）⇒ 如实 `null`（"无法判"）："缺 body"由 `multiblockSourcePresent` 判。
    return { ...obs, warnings: [], declarationMatchesSource: null }
  }
  let parsed: ReturnType<typeof parseMultiblockDeclaration>
  try {
    parsed = parseMultiblockDeclaration(source as Record<string, unknown>)
  } catch (e) {
    return { ...obs, warnings: [`内核源根重解析失败：${String(e)}`], declarationMatchesSource: false }
  }
  const decl = parsed.decl
  const appChannels = JSON.stringify(obs.channels.map((c) => c.key))
  const srcChannels = JSON.stringify(decl.channels.map((c) => c.key))
  const appBackbone = JSON.stringify(obs.backbone?.steps.map((s) => s.cellGrid) ?? null)
  const srcBackbone = JSON.stringify(decl.backbone.sizeSteps.map((s) => s.cellGrid))
  return {
    ...obs,
    warnings: [...parsed.warnings],
    declarationMatchesSource: appChannels === srcChannels && appBackbone === srcBackbone,
  }
}

// ---------------------------------------------------------------------------
// 公开观测：视口渲染态
// ---------------------------------------------------------------------------

export interface RenderedGridObservation {
  present: boolean
  d: number
  h: number
  w: number
  /** 非空格数（下标 ≠ 0）。 */
  solidCells: number
  /** 逐格下标，`cellGrid[z][y][x]`（原样取自渲染定义）。 */
  cellGrid: number[][][]
  /** 调色板条目指纹：`registryId@meta`。 */
  palette: string[]
}

/**
 * 读回**视口实际渲染的定义**（`ctx.viewports.get('r-viewport').definition`）。
 *
 * 这是 T3.3「web 装配 vs mod 导出逐格 diff」的网格来源：
 * 它比 `doc.frames[i].grid` 更贴近「真正画出来的东西」，
 * 且与 `drwMeshPipeline` 使用的同一份 `StructureDefinition`。
 *
 * 注：**不**从这里读「分层预览模式」——`slot.layerPreview` 是 attach 时刻的快照
 * （`attachViewport` 只在装配时写一次），分层预览的公开观测点用
 * `ctx.getLayerWorldY()` + dock 的 `层` 标签（见 `readDockStatus`）。
 */
export async function readRenderedGrid(
  page: Page,
  regionId: string = VIEWPORT_REGION,
): Promise<RenderedGridObservation> {
  return await page.evaluate((rid) => {
    const ctx = (window as any).__vm__
    const slot = ctx.viewports.get(rid)
    const def = slot?.definition?.value ?? null
    if (!def) {
      return {
        present: false,
        d: 0,
        h: 0,
        w: 0,
        solidCells: 0,
        cellGrid: [],
        palette: [],
      }
    }
    let solidCells = 0
    for (const slice of def.cellGrid as number[][][]) {
      for (const row of slice) {
        for (const idx of row) if (idx !== 0) solidCells++
      }
    }
    return {
      present: true,
      d: def.cellGrid.length,
      h: def.cellGrid[0]?.length ?? 0,
      w: def.cellGrid[0]?.[0]?.length ?? 0,
      solidCells,
      cellGrid: def.cellGrid,
      palette: (def.blockPalette as any[]).map((p) => `${p.registryId}@${p.meta}`),
    }
  }, regionId)
}

export interface ViewportObservation {
  frameIndex: number
  layerWorldY: number
  docFrameCount: number
}

/** 读回视口状态类公开观测点（帧索引 / 图层 Y）。 */
export async function readViewportState(page: Page): Promise<ViewportObservation> {
  return await page.evaluate(() => {
    const ctx = (window as any).__vm__
    return {
      frameIndex: ctx.getFrameIndex(),
      layerWorldY: ctx.getLayerWorldY().value,
      docFrameCount: ctx.frameDeclarations().count,
    }
  })
}

// ---------------------------------------------------------------------------
// DOM 事件注入辅助
// ---------------------------------------------------------------------------

/**
 * 驱动 range 滑杆：设值后由浏览器派发 `input` + `change`。
 *
 * 这是**元素级 DOM 事件注入**：目标元素就是生产 DOM（`WorldFrameScrubber` /
 * `LayerPreviewBar` 的 `<input type=range>`），事件由 DOM 派发并被 Vue 的
 * `@input`/`@change` 监听器消费，最终经 `ctx.getOperators().exec(...)` 生效——
 * 与真人拖动滑杆的事件路径一致，不跳过监听器、不直接调 operator。
 *
 * 前置条件只要求**已挂载 + 未禁用**（`meshBusy` 会禁用滑杆），不要求可见：
 * 窄视口下（`mobile-chrome` = Pixel 5）Workbench 视口列会被压到约 250 CSS px，
 * 滑杆的 flex 宽度实测被挤到 **0**——元素仍在生产 DOM 里且事件路径完全一样，
 * 因此功能断言照跑，布局问题单列为开放项（见报告）。
 */
export async function setSliderValue(page: Page, selector: string, value: number): Promise<void> {
  const slider = page.locator(selector).first()
  await expect(slider).toBeAttached()
  await expect(slider).toBeEnabled()
  await slider.evaluate((el, v) => {
    const input = el as HTMLInputElement
    input.value = String(v)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
}

/**
 * 用真实键盘驱动已聚焦的 range 滑杆（键盘 → 原生值变更 → `input`/`change`）。
 * 与 `setSliderValue` 互为独立通道：证明帧/层切换不依赖某一种事件注入方式。
 */
export async function pressSliderKey(
  page: Page,
  selector: string,
  key: string,
): Promise<void> {
  const slider = page.locator(selector).first()
  await expect(slider).toBeAttached()
  await slider.focus()
  await page.keyboard.press(key)
}

/** 读元素的 CSS 像素盒（布局诊断用，例如窄视口下滑杆被挤成 0 宽）。 */
export async function elementBox(
  page: Page,
  selector: string,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return await page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
}

/** 点击 dock 上的 tab（`帧控制` / `分层预览`）。 */
export function dockTab(page: Page, label: string): Locator {
  return page.locator(`${DOCK} .vp-dock__tab`, { hasText: label })
}

/**
 * 等网格重建结束：`meshBusy` 会把滑杆置为 `disabled`
 * （`WorldFrameScrubber` / `LayerPreviewBar` 的 `:disabled="meshBusy"`），
 * 所以「滑杆重新可交互」是装配完成的公开信号。
 */
export async function waitForMeshIdle(page: Page, selector: string, timeout = 30_000): Promise<void> {
  await expect(page.locator(selector).first()).toBeEnabled({ timeout })
}

/** 读 dock 状态行文本（`帧 i/N` + `层 <label>`）。 */
export async function readDockStatus(page: Page): Promise<string> {
  return (await page.locator(DOCK_STATUS).first().innerText()).replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// 第二阶段（通道滑杆遍历）通用原语
// ---------------------------------------------------------------------------

/**
 * 轮询直到 `probe()` 返回真值，返回命中的值（超时抛错并带上 `label`）。
 *
 * 用途：多方块通道装配是**异步**的（`useMultiblockChannels.commit` → `revision++` →
 * `bindMultiblockMeshSync` 的 `watch(..., {flush:'post'})` → `loadStructureAndResources()`
 * → `rebuildContentMesh()`），而面板的 `data-*` 属性是**同步**更新的。
 * 因此断言前必须等"渲染定义真的跟上"，而不是等一个固定时长。
 */
export async function pollUntil<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  timeout = 20_000,
  interval = 25,
): Promise<T> {
  const deadline = Date.now() + timeout
  let last: unknown = null
  for (;;) {
    const v = await probe()
    if (v) return v as T
    if (Date.now() > deadline) {
      throw new Error(`T2.6：等待超时（${timeout}ms）—— ${label}${last === null ? '' : `（最后一次观测：${JSON.stringify(last)}）`}`)
    }
    last = v === undefined ? null : v
    await new Promise((r) => setTimeout(r, interval))
  }
}

/**
 * 等到"渲染定义与参考基线逐格一致"，返回命中的渲染观测。
 *
 * 收敛判据用**逐格比对结果**（不是形状）：形状一致但内容还停留在上一次装配时，
 * 本函数会继续轮询；真出现实现级错配时则**超时后**由调用方给出完整 diff 证据
 * （因此不会把"异步没跟上"误报成"逻辑错了"）。
 */
export async function waitForRenderMatch<T extends { diffCount: number }>(
  probe: () => Promise<T>,
  timeout = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeout
  let last = await probe()
  while (last.diffCount !== 0 && Date.now() <= deadline) {
    await new Promise((r) => setTimeout(r, 25))
    last = await probe()
  }
  if (last.diffCount !== 0) {
    // 再给一次机会：装配走的是 `watch(flush:'post')` 微任务 + 异步 mesh 重建，
    // 页面上其它区域仍在收尾时，首个读回可能刚好落在旧定义上。这里显式让出一轮宏任务
    // 再读一次，避免把"刚好慢半拍"判成实现错配（真错配仍会带着完整 diff 报红）。
    await new Promise((r) => setTimeout(r, 150))
    last = await probe()
  }
  return last
}

// ---------------------------------------------------------------------------
// 第三阶段（真实产物验收）：内容 mesh 的「世代」观测
// ---------------------------------------------------------------------------

export interface ContentMeshObservation {
  /** 视口 slot 里是否已有内容 mesh 组。 */
  present: boolean
  /**
   * **内容世代**标识（R1-β① C8 起语义变更，见下）。
   *
   * ## 为什么它不再是 `contentGroup.uuid`
   *
   * 旧形态下 `presentContentMesh()` 每次重建都**新建一个 Group 并整体替换**
   * `slot.contentGroup.value` ⇒ "uuid 变化 ⇔ 新一代 mesh 落地"。
   *
   * C8 把画面生产者切到 `PresenterSession` 后，`contentGroup` **就是**呈现会话的
   * 根对象（稳定不变），批次/注解由会话**就地**重建 ⇒ uuid 只会在视口重挂时变，
   * "世代"这件事改由 `PresenterSession.generation` 表达（它是批次结构世代，
   * 每次真重建推进）。故本字段 = 呈现会话世代（前缀 `presenter:`），
   * 无呈现会话时回落 `contentGroup.uuid`。
   *
   * ⚠️ 观测口径的实质没变：它仍然只读**公开字段**
   * （`ViewportSlot.contentGroup` / `ViewportSlot.presenterSurface`），不是测试后门。
   */
  uuid: string | null
  /** 组内 mesh 数。 */
  meshes: number
  /** 顶点数合计。 */
  vertices: number
  /** 三角形数合计。 */
  triangles: number
}

/** 读视口内容 mesh 的观测（mesh 数 / 顶点数 / 三角形数 / 世代 uuid）。 */
export async function readContentMesh(
  page: Page,
  regionId: string = VIEWPORT_REGION,
): Promise<ContentMeshObservation> {
  return await page.evaluate((rid) => {
    const ctx = (window as any).__vm__
    const slot = ctx?.viewports?.get(rid)
    const group = slot?.contentGroup?.value ?? null
    // 世代：优先呈现会话的批次世代（C8 起画面由它产出）；无会话时回落组 uuid。
    const generation = typeof slot?.presenterSurface?.generation === 'string'
      ? `presenter:${slot.presenterSurface.generation}`
      : null
    if (!group) return { present: false, uuid: generation, meshes: 0, vertices: 0, triangles: 0 }
    let meshes = 0
    let vertices = 0
    let triangles = 0
    group.traverse((o: any) => {
      if (!o?.isMesh || !o.geometry) return
      meshes++
      const pos = o.geometry.getAttribute?.('position')
      if (pos) vertices += pos.count
      const idx = o.geometry.getIndex?.()
      if (idx) triangles += idx.count / 3
      else if (pos) triangles += pos.count / 3
    })
    return {
      present: true,
      uuid: generation ?? (typeof group.uuid === 'string' ? group.uuid : null),
      meshes,
      vertices: Math.round(vertices),
      triangles: Math.round(triangles),
    }
  }, regionId)
}

/**
 * 等到「新一代内容 mesh 已挂进场景」：
 * `contentGroup.uuid` 从 `previousUuid` 变成别的值（`previousUuid === null` 时只要求非空）。
 *
 * 超时抛错（带上最后一次观测），因为"mesh 世代没变"意味着装配根本没落地 ——
 * 那是必须报红的实现问题，不是可以放过的噪声。
 */
export async function waitForMeshGeneration(
  page: Page,
  previousUuid: string | null,
  timeout = 30_000,
  regionId: string = VIEWPORT_REGION,
): Promise<ContentMeshObservation> {
  const deadline = Date.now() + timeout
  let last: ContentMeshObservation = { present: false, uuid: null, meshes: 0, vertices: 0, triangles: 0 }
  for (;;) {
    last = await readContentMesh(page, regionId)
    const changed = last.present && last.uuid !== null && (previousUuid === null || last.uuid !== previousUuid)
    if (changed) return last
    if (Date.now() > deadline) {
      throw new Error(
        `T3.1：等待内容 mesh 世代更新超时（${timeout}ms）—— previousUuid=${previousUuid ?? '<首次>'}，` +
          `最后一次观测 ${JSON.stringify(last)}。装配/mesh 重建未落地，属必须报红的实现问题。`,
      )
    }
    await new Promise((r) => setTimeout(r, 20))
  }
}

export interface RenderedDefinitionObservation {
  present: boolean
  /** `[d, h, w]`。 */
  shape: [number, number, number]
  /** `cellGrid[z][row][x]` 下标（**原样**取自渲染定义，不做任何翻转）。 */
  cellGrid: number[][][]
  /** 渲染调色板条目（原样；用于重建签名）。 */
  palette: unknown[]
  solidCells: number
}

/**
 * 读渲染定义的**原样**内容（`cellGrid` + `blockPalette`），供签名级逐格比对。
 *
 * 与 `readRenderedGrid()` 的差别：后者已把调色板压成 `registryId@meta` 字符串
 * （够用于"有没有东西"的诊断，但**不足以**做签名对齐——渲染调色板是重编号的，
 * 且 `name:meta` 会归并内容不同的条目）。本函数把原始条目交回，由 helper 侧统一建表。
 */
export async function readRenderedDefinition(
  page: Page,
  regionId: string = VIEWPORT_REGION,
): Promise<RenderedDefinitionObservation> {
  return await page.evaluate((rid) => {
    const ctx = (window as any).__vm__
    const def = ctx.viewports.get(rid)?.definition?.value ?? null
    if (!def) {
      return { present: false, shape: [0, 0, 0], cellGrid: [], palette: [], solidCells: 0 }
    }
    const cellGrid = def.cellGrid as number[][][]
    let solid = 0
    for (const slice of cellGrid) {
      for (const row of slice) {
        for (const idx of row) if (idx !== 0) solid++
      }
    }
    return {
      present: true,
      shape: [cellGrid.length, cellGrid[0]?.length ?? 0, cellGrid[0]?.[0]?.length ?? 0],
      cellGrid,
      palette: def.blockPalette ?? [],
      solidCells: solid,
    }
  }, regionId)
}
