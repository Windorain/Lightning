/**
 * 无头渲染断言管线 —— 骨架 harness。
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

import { expect, test, type Frame, type Locator, type Page, type Request } from '@playwright/test'
import { parseMultiblockDeclaration } from '@/context/parsers/multiblockDocument'
import {
  BOOT_READY_CAP_MS,
  BOOT_READY_HEADROOM_MS,
  decideReadyBudget,
  describeReadyBudget,
  explicitReadyBudget,
  type ReadyBudget,
  type ReadyBudgetInputs,
} from './readyBudget'

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
// 启动失败**可归因性**：有界启动探针 + ready 等待失败时的有界诊断
// ---------------------------------------------------------------------------

/** 启动探针采集的事件类别（只这四类；见 {@link bootProbeStateOf}）。 */
type BootProbeEventKind = 'console' | 'pageerror' | 'requestfailed' | 'response'

/**
 * 启动探针的**一条**单行事件摘要。
 *
 * 探测面刻意只有四类：console 的 `error` 与 `[vite]` 提示、`pageerror`、
 * `requestfailed`、HTTP>=400 与 `document` 的 response。这四类正是"页面（或它的
 * 模块图）为什么没起来"的可判别事实；其余一律不采 —— 探针不是日志收集器。
 */
interface BootProbeEvent {
  /** 相对本轮计时零点（ms）。 */
  readonly at: number
  readonly kind: BootProbeEventKind
  /** 单行化 + 截断后的摘要（≤ {@link BOOT_PROBE_LINE_MAX} 字符）。 */
  readonly line: string
  /** `requestfailed` / `response` 的资源类型（归因读**结构化字段**，不从文本反解）。 */
  readonly resourceType?: string
  /** `response` 的 HTTP 状态码。 */
  readonly status?: number
}

interface BootProbeState {
  t0: number
  /** **有界**环形缓冲（≤ {@link BOOT_PROBE_RING_MAX} 条）。 */
  readonly events: BootProbeEvent[]
  /** 被环形上限挤掉的事件数（有界的代价，如实记账）。 */
  dropped: number
  /**
   * **本轮 goto 期间**的主文档导航事实（起点 = 本页探针注册 / 每次 `gotoWorkbench` 入口）。
   *
   * ## 为什么不直接读导航纪元
   *
   * 页面的 `navEpochOf` / `navStartEpochOf` 是**页面级**计数，且**惰性注册**
   * （第一次读取才挂监听）。对应 spec 把"第一次读取时"当零点，断言
   * `commits` 恰好是 1 —— 若探针在 `gotoWorkbench` 入口就抢先注册，那个零点会提前
   * 到初始导航，这些绝对断言会变成 2（实测红）。故探针**不碰**该注册时机，
   * 只自己数一份**启动范围**的同类事实；两份计数互不影响，且探针这份**只进诊断**，
   * 从不作为通过/失败判据。
   */
  nav: { starts: number; commits: number; failures: number; inFlight: Set<Request> }
  /**
   * 本轮"启动 pending"状态：**从 goto 之前 armed，ready 成功（或本函数退出）disarm**。
   *
   * 页面在 pending 期间被关闭（test deadline / 外部 close）时，close 监听只输出一条
   * ≤1KB 的 **Node 侧**兜底（budget / nav / events / attribution），**不 evaluate**。
   * 这是"锚点晚 + deadline 先到"这一类唯一还能留下分类事实的出口：它**与预算来源无关**
   * （headroom 也一样），也不依赖 ready 等待失败抛出。
   */
  pending: PendingStartup
}

/** 启动 pending 的可变状态（同一页多次 goto 时按次重置）。 */
interface PendingStartup {
  active: boolean
  explicit: boolean
  entryClock: TestClockReading | null
  budget: ReadyBudget | null
  /** Node 兜底是否已经打印过（late 预打印 / close / 只能有一次）。 */
  fallbackEmitted: boolean
}

/** 环形缓冲上限：够看清一次启动的失败链，又不让内存随事件量增长。 */
const BOOT_PROBE_RING_MAX = 100
/** 单条事件的摘要上限（字符）。 */
const BOOT_PROBE_LINE_MAX = 200
/** 诊断文本的**硬上限**（字节，UTF-8）—— 粘进失败报告时不会淹没原始错误。 */
const BOOT_DIAG_MAX_BYTES = 2_048
/**
 * ready 等待的预算：**90s 上限 / 正常为归因预留 30s / 最少 1s**，并按**本测试的真实剩余**
 * 收紧（纯算术在 `./readyBudget`）。
 *
 * | 剩余 test 预算 | 等待预算 |
 * |---|---|
 * | 无 deadline（`test.setTimeout(0)` / 非 test 上下文） | 上限 90s |
 * | 剩余 ≥ 1s + 诊断预留（3.25s） | `min(90s, max(1s, 剩余 − 30s))`（**旧语义不变**） |
 * | 剩余 < 1s + 诊断预留（晚调用） | `min(250ms, 剩余)` 有界即时宽限；剩余 0 才为 0 |
 *
 * 旧实现只看 `TestInfo.timeout`、**不看已经跑了多久**：90s 的用例在 30s 时做第二次
 * `gotoWorkbench` 仍拿 60s 等 ready，于是 ready + 采诊断一起越过 test deadline、页面先关。
 * 现在用"本测试首次进入 harness"的锚点算已耗时（见 {@link currentTestClock}），把等待与
 * 页面侧采集都压进真实剩余；**test timeout 本身不改**（不靠延长 timeout 掩盖）。
 *
 * ## 锚点的限度（如实登记，不声称消除未知 flaky）
 *
 * Playwright 1.60 的公开 `TestInfo` **没有** `startTime`/elapsed（只有 `timeout`），
 * 故锚点只能取"本测试首次进入 harness"的时刻 ⇒ `已耗时` 是**下界**：若一条用例在首次
 * `gotoWorkbench` 之前已跑了很久，剩余会被**高估**。30s headroom 能吸收 ≤30s 的高估；
 * 超过时仍可能撞 deadline —— 这类由**启动 pending 的 close 监听**兜底：页面一关就先写
 * 一条 ≤1KB `[boot-probe:close]` 到 **stderr**（分类/导航/事件/预算），不依赖页面还活着、
 * 也不依赖预算来源（headroom 同样覆盖）。
 */

/**
 * Vite 客户端里**会替换文档**的那两行（`vite/dist/client/client.mjs`）：
 *
 *  - `[vite] page reload <path>` —— full-reload（HMR 无法热更时）；
 *  - `[vite] server connection lost. Polling for restart...` —— ws 断开。
 *
 * 只有它们才是"文档被替换"的线索。`[vite] connecting... / connected.` 是**每次健康启动
 * 都有**的常规行，若当成线索就会制造**假归因**（模块请求失败与启动抛错
 * 两类都被误挂了一条 "Vite 客户端提示"）。
 */
const VITE_DOCUMENT_REPLACEMENT_HINT = /\[vite\] (?:page reload|server connection lost)/

/**
 * 每页一份探针状态（`WeakMap` 为键：页面被回收时随之消失）。
 *
 * ## 为什么用 WeakMap + 只注册一次
 *
 * `page.on` 每次调用都会新增一个监听器。`gotoWorkbench` 在**同一页**上被调用多次是
 * 常态（save/reopen 类用例、以及负对照），若在入口无条件注册，监听器会随调用
 * 次数线性增长 —— 那会把"诊断"变成"泄漏"（专门有一条判据压这个）。
 *
 * ## 健康路径的代价（本单的硬约束）
 *
 * 注册监听**不做任何页面侧动作**：不 evaluate、不截图、不 trace、不打日志。
 * 实际注册 **9 个监听器**（console / pageerror / requestfailed / response /
 * framenavigated / request / requestfinished / dialog / **close**，各一次；回调里只做
 * 内存记账）。close 回调只在"启动 pending"期间、且尚未打印过 Node 兜底时输出一条
 * ≤1KB **stderr** 事实；健康成功路径 close 时 pending 已 disarm ⇒ 零输出。
 * 判据（`__vm_ready__` + `.wb-shell`）不变；预算见 {@link currentTestClock} 与
 * `./readyBudget`（**90s 上限、正常为归因预留 30s、按真实剩余收紧**）。
 */
const bootProbes = new WeakMap<Page, BootProbeState>()

/** 单行化 + 截断（诊断里的每一行都必须能安全地塞进一条错误消息）。 */
function bootProbeOneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, BOOT_PROBE_LINE_MAX)
}

/** 取异常的单行消息（`Error` 取其 `message`，其余 `String()`）。 */
function causeMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 每测试一份的**时钟锚点**（公开 `test.info()` 对象身份为键）。 */
interface TestClockAnchor {
  /** 本测试**首次进入 harness** 的时刻（`Date.now()`）。 */
  readonly at: number
}

/**
 * 测试锚点表：**WeakMap 以公开的 `TestInfo` 对象为键**。
 *
 * ## 为什么这样分组（而不是全局变量 / workerIndex / 文件名）
 *
 *  - `test.info()` 在同一次测试执行里返回**同一个对象**（实测），换测试、换 retry 都是
 *    新对象 ⇒ `WeakMap` 天然做到"一测一时钟"，**不会把上一条用例的起点串到下一条**；
 *  - 不注册任何 `beforeEach`/`afterEach`：helper 可能被同一 worker 里的多个 spec 先后
 *    import，模块级 hook 只会在**第一个** spec 的 suite 上生效（实测），既覆盖不全又会
 *    让"谁先 import"决定别条用例的行为 —— 那正是"多套全局串号"；
 *  - `TestInfo` 被回收时锚点随之消失（WeakMap），不占内存。
 *
 * ## 锚点不是"测试开始"（公开 API 的边界）
 *
 * Playwright 1.60 的 `TestInfo` 没有 `startTime`；本实现能拿到的**最早**测试内时刻就是
 * "本测试第一次调用 harness"。因此 `elapsed` 是**下界**：首调之前已经跑掉的时间不计入，
 * 剩余会被高估。高估由 30s headroom 吸收；更极端的情形由启动 pending 的 close 监听
 * （{@link collectPendingBootDiagnostic}）保证至少有分类/导航事实。
 */
const testClockAnchors = new WeakMap<object, TestClockAnchor>()

interface TestClockReading {
  readonly timeoutMs: number | null
  /** 距本测试首次进入 harness 的已耗时（ms）。 */
  readonly elapsedMs: number
}

/**
 * 读当前 test 的时钟；**首次调用即记录锚点**。
 *
 * 非 test 上下文（脚本 / globalSetup / fixture 外）`test.info()` 会抛 ⇒ 返回 `null`，
 * 预算退回"无 deadline"上限。只读公开的 `timeout`，不碰私有字段。
 */
function currentTestClock(): TestClockReading | null {
  try {
    const info = test.info() as unknown as { timeout?: unknown }
    if (info === null || typeof info !== 'object') return null
    const timeout = info.timeout
    const timeoutMs = typeof timeout === 'number' && Number.isFinite(timeout) ? timeout : null
    let anchor = testClockAnchors.get(info)
    if (anchor === undefined) {
      anchor = { at: Date.now() }
      testClockAnchors.set(info, anchor)
    }
    return {
      timeoutMs,
      elapsedMs: Math.max(0, Date.now() - anchor.at),
    }
  } catch {
    return null
  }
}

/** 由两个时刻的读数算预算（纯算术委托给 `./readyBudget`，这里只负责取数）。 */
function budgetFromClocks(
  atEntry: TestClockReading | null,
  atWait: TestClockReading | null,
): ReadyBudget {
  const inputs: ReadyBudgetInputs = {
    testTimeoutMs: atWait?.timeoutMs ?? atEntry?.timeoutMs ?? null,
    elapsedMs: atEntry?.elapsedMs ?? atWait?.elapsedMs ?? null,
    waitElapsedMs: atWait?.elapsedMs ?? atEntry?.elapsedMs ?? null,
  }
  return decideReadyBudget(inputs)
}

/**
 * 诊断头行的**预算来源**（只写真实来源，不把一种来源写成另一种）：
 *  - 显式覆盖 ⇒ `显式指定`（不冒充 headroom）；
 *  - 无 deadline ⇒ 上限本身（`test.setTimeout(0)` 不是 0ms 预算）；
 *  - 晚调用 ⇒ 在既有 headroom 文案后如实标注"按剩余收紧"。
 */
function budgetNoteOf(budget: ReadyBudget, explicit: boolean): string {
  if (explicit) return '显式指定'
  if (budget.source === 'no-deadline') return `ready 上限 ${BOOT_READY_CAP_MS}ms（无 test deadline）`
  const base = `ready 上限 ${BOOT_READY_CAP_MS}ms，为归因预留 ${BOOT_READY_HEADROOM_MS}ms`
  return budget.source === 'late' ? `${base}；晚调用：按剩余收紧` : base
}

/**
 * 取（必要时**首次注册**）本页探针；每次 `gotoWorkbench` 会先清空上一轮的事件。
 *
 * 清空而不是累积：诊断只回答"**这一次**为什么没起来"。上一轮的事件留在缓冲里会把
 * 归因搅浑（上一轮的 reload 数与这一轮的模块失败混进同一份"事实"）。
 */
function bootProbeStateOf(page: Page): BootProbeState {
  const existing = bootProbes.get(page)
  if (existing !== undefined) {
    existing.t0 = Date.now()
    existing.events.length = 0
    existing.dropped = 0
    existing.nav.starts = 0
    existing.nav.commits = 0
    existing.nav.failures = 0
    existing.nav.inFlight.clear()
    return existing
  }
  const state: BootProbeState = {
    t0: Date.now(),
    events: [],
    dropped: 0,
    nav: { starts: 0, commits: 0, failures: 0, inFlight: new Set() },
    pending: {
      active: false,
      explicit: false,
      entryClock: null,
      budget: null,
      fallbackEmitted: false,
    },
  }
  bootProbes.set(page, state)
  const push = (event: Omit<BootProbeEvent, 'at'>): void => {
    if (state.events.length >= BOOT_PROBE_RING_MAX) {
      state.events.shift()
      state.dropped += 1
    }
    state.events.push({ at: Date.now() - state.t0, ...event })
  }
  page.on('console', (msg) => {
    const type = msg.type()
    const text = msg.text()
    // 只收 error 与 Vite 客户端自身的提示行；普通 log/debug（含产品自己的信息日志）
    // 与启动判据无关。⚠️ `[vite] connecting... / connected.` 是**每次健康启动都有**的常规行，
    // 它**不是** reload 线索 —— 归因只看 {@link VITE_DOCUMENT_REPLACEMENT_HINT}。
    if (type !== 'error' && !text.includes('[vite]')) return
    push({ kind: 'console', line: bootProbeOneLine(`${type}: ${text}`) })
  })
  page.on('pageerror', (err) => {
    push({ kind: 'pageerror', line: bootProbeOneLine(err.message) })
  })
  page.on('requestfailed', (req) => {
    push({
      kind: 'requestfailed',
      resourceType: req.resourceType(),
      line: bootProbeOneLine(
        `${req.resourceType()} ${req.url()} => ${req.failure()?.errorText ?? 'unknown'}`,
      ),
    })
    // 同一个事件既进事件缓冲（归因用），也落定"在途导航已终止"（计 pending/failures）。
    // 合并成一个 handler：同一事件不再注册两次监听、落定政策也只有一处。
    if (state.nav.inFlight.delete(req)) state.nav.failures += 1
  })
  page.on('response', (res) => {
    const status = res.status()
    const resourceType = res.request().resourceType()
    // 只要这两类：HTTP>=400（"请求被拒"）与 document（"哪些文档被提交过" ——
    // reload 循环的正面证据）。2xx 的普通资源与启动判据无关。
    if (status < 400 && resourceType !== 'document') return
    push({
      kind: 'response',
      resourceType,
      status,
      line: bootProbeOneLine(`${status} ${resourceType} ${res.url()}`),
    })
  })
  // 启动范围的导航事实（口径与页面的 start/commit/pending **同义**，但独立计数；
  // 理由见 {@link BootProbeState.nav}：不能改动该惰性零点）。
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) state.nav.commits += 1
  })
  page.on('request', (req) => {
    if (!req.isNavigationRequest()) return
    if (req.frame() !== page.mainFrame()) return
    // 重定向会为后续请求再发一次 request；被重定向的那条不应永远占着在途集合。
    const from = req.redirectedFrom()
    if (from !== null) state.nav.inFlight.delete(from)
    state.nav.starts += 1
    state.nav.inFlight.add(req)
  })
  page.on('requestfinished', (req) => {
    state.nav.inFlight.delete(req)
  })
  // dialog 也在这里一次性注册：原先 `gotoWorkbench` 每次调用都 `page.on('dialog')`，
  // 同一页多次打开会叠加监听（泄漏判据覆盖到这里）。行为不变（一律 accept）。
  page.on('dialog', (d) => {
    void d.accept()
  })
  // 启动 pending 期间的 close：**与预算来源无关**的 Node 兜底。
  //
  // 为什么不能只靠 ready 等待失败时的 catch：`page.waitForFunction` 的预算可能因为
  // "锚点晚"而高估（例如 7s 用例先睡 5s 再首次 goto），于是 test deadline 在等待/采集
  // 期间先关页，首败是 Playwright 的 `Test timeout`，根本走不到我们的 catch。close 事件
  // 是那一刻唯一还能执行的 Node 侧时机；这里只读内存（事件环/导航/预算），不 evaluate。
  page.on('close', () => {
    const pending = state.pending
    if (!pending.active || pending.fallbackEmitted) return
    pending.fallbackEmitted = true
    const budget = pending.explicit
      ? (pending.budget ?? explicitReadyBudget(0))
      : budgetFromClocks(pending.entryClock, currentTestClock())
    const cause = new Error('页面在启动 pending 期间被关闭（test deadline / 外部 close）')
    console.error(
      collectPendingBootDiagnostic(
        page,
        budget,
        cause,
        budgetNoteOf(budget, pending.explicit),
        'close',
      ),
    )
  })
  return state
}

/** 页面侧启动事实（一次 evaluate 取回；**只在诊断路径**读）。 */
interface BootPageFacts {
  readyState: string
  href: string
  scripts: number
  vmType: string
  readyValue: string
  bootErrText: string | null
  shellPresent: boolean
  resources: number
  slowest: Array<{ name: string; ms: number }>
}

/** 给一个 Promise 加**有界**等待：超时即判"采集不到"，绝不让诊断二次死等。 */
function withDeadline<T>(work: Promise<T>, budgetMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`页面侧采集超过 ${budgetMs}ms 未返回（渲染进程冻结或正在导航）`))
    }, budgetMs)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * 采集页面侧启动事实（`readyState` / `location` / scripts 数 / `.wm-boot--err` 文本 /
 * `__vm__` 与 `__vm_ready__` / 资源条数与最慢 5 项）。
 *
 * 自包含（不引用模块作用域里的任何常量/函数）—— `page.evaluate` 只搬运函数源码。
 * 每一项都**有界**：错误文本截 240 字符、最慢资源只取 5 项、资源名去掉 origin 前缀。
 * 任何一项取不到都如实回退（`null` / 0），不抛错 —— 诊断路径里"某一项读不到"
 * 不该把整份诊断变成异常。
 */
async function readBootPageFacts(page: Page, budgetMs: number): Promise<BootPageFacts> {
  // 剩余预算不足时**不赌**渲染进程还能在 deadline 前回话：直接降级为 Node 侧事实。
  if (!(budgetMs > 0)) {
    throw new Error(`页面侧采集预算 ${budgetMs}ms（剩余已放不下安全采集，跳过）`)
  }
  return await withDeadline(
    page.evaluate(() => {
      const w = window as any
      const errEl = document.querySelector('.wm-boot--err')
      let resources = 0
      let slowest: Array<{ name: string; ms: number }> = []
      try {
        const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
        resources = entries.length
        slowest = entries
          .slice()
          .sort((a, b) => b.duration - a.duration)
          .slice(0, 5)
          .map((e) => {
            const name = String(e.name)
            return {
              name: name.startsWith(location.origin) ? name.slice(location.origin.length) : name.slice(0, 120),
              ms: Math.round(e.duration),
            }
          })
      } catch {
        // performance 不可用（极端环境）⇒ 如实留空，不抛
      }
      return {
        readyState: document.readyState,
        href: location.href,
        scripts: document.scripts.length,
        vmType: typeof w.__vm__,
        readyValue: String(w.__vm_ready__),
        bootErrText:
          errEl === null
            ? null
            : (errEl.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
        shellPresent: document.querySelector('.wb-shell') !== null,
        resources,
        slowest,
      }
    }),
    budgetMs,
  )
}

/**
 * **启动范围**的主文档导航事实（口径与页面的 start/commit/pending 同义）。
 *
 * 起点是本页探针注册 / 每次 `gotoWorkbench` 入口 —— 见 {@link BootProbeState.nav}
 * 说明为什么不去借用页面级计数。
 */
interface BootNavFacts {
  starts: number
  commits: number
  failures: number
  pending: boolean
}

/**
 * 由已采集事实给出**有界归因候选**（不是因果断言）。
 *
 * 每一类都对应**具体的**事件字段或页面字段：命中就点名"疑似 X"，一条都不命中就如实写
 * "未命中已知归因" —— 不用"未知错误"含糊过去，也不把猜测写成结论（本单只修
 * **可归因性**，不声称消除未知 flaky）。
 */
function bootAttribution(
  events: readonly BootProbeEvent[],
  facts: BootPageFacts | null,
  nav: BootNavFacts | null,
): string[] {
  const out: string[] = []
  const isEntryType = (t: string | undefined): boolean => t === 'script' || t === 'document'
  const failedEntry = events.filter((e) => e.kind === 'requestfailed' && isEntryType(e.resourceType))
  if (failedEntry.length > 0) {
    out.push(`模块/入口请求失败 ×${failedEntry.length}（首个：${failedEntry[0]!.line.slice(0, 120)}）`)
  }
  const rejectedEntry = events.filter(
    (e) => e.kind === 'response' && isEntryType(e.resourceType) && (e.status ?? 0) >= 400,
  )
  if (rejectedEntry.length > 0) {
    out.push(`脚本/文档响应 HTTP≥400 ×${rejectedEntry.length}（首个：${rejectedEntry[0]!.line.slice(0, 120)}）`)
  }
  if (facts !== null && facts.bootErrText !== null && facts.bootErrText !== '') {
    out.push('启动期异常被错误边界捕获（.wm-boot--err 有文本）')
  }
  const pageErrors = events.filter((e) => e.kind === 'pageerror')
  if (pageErrors.length > 0) {
    out.push(`启动期未捕获异常 ×${pageErrors.length}（首个：${pageErrors[0]!.line.slice(0, 120)}）`)
  }
  if (nav !== null && nav.commits >= 2) {
    out.push(`文档被反复替换 ×${nav.commits}（reload 循环形态）`)
  }
  if (nav !== null && nav.pending) {
    out.push('ready 等待失败时仍有未落定的主文档导航（在途）')
  }
  // 只认**会替换文档**的 Vite 行（见 {@link VITE_DOCUMENT_REPLACEMENT_HINT}）；
  // `[vite] connecting/connected` 健康启动必现，绝不能当线索。
  const viteHints = events.filter(
    (e) => e.kind === 'console' && VITE_DOCUMENT_REPLACEMENT_HINT.test(e.line),
  )
  if (viteHints.length > 0) {
    out.push(
      `Vite reload/断线提示 ×${viteHints.length}（HMR full-reload / ws 断开会触发 location.reload）`,
    )
  }
  const consoleErrors = events.filter((e) => e.kind === 'console' && !e.line.includes('[vite]'))
  if (out.length === 0 && consoleErrors.length > 0) {
    out.push(`console error ×${consoleErrors.length}（首个：${consoleErrors[0]!.line.slice(0, 120)}）`)
  }
  return out
}

/** 按 **UTF-8 字节**截断（不在多字节字符中间切断），并留出截断标记的位置。 */
function capUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder()
  if (encoder.encode(text).length <= maxBytes) return text
  const marker = '\n…[诊断已按上限截断]'
  const budget = maxBytes - encoder.encode(marker).length
  let used = 0
  let out = ''
  for (const ch of text) {
    const size = encoder.encode(ch).length
    if (used + size > budget) break
    used += size
    out += ch
  }
  return out + marker
}

/** close 前 Node 兜底的硬上限（字节）：只保事实，不与完整诊断抢空间。 */
const BOOT_NODE_FALLBACK_MAX_BYTES = 1_024

/** 诊断的**进程侧骨架**（不依赖页面，页面关闭/冻结时也一定产出）。 */
interface BootDiagnosticScaffold {
  readonly lines: string[]
  readonly state: BootProbeState | undefined
  readonly nav: BootNavFacts | null
}

/**
 * 组诊断的进程侧部分：头行（预算 + 原错误）、`[budget]` 事实、`[nav]` 导航事实。
 *
 * 这三段**先于**任何页面侧动作：页面已被关闭、渲染进程冻结、或 test deadline 正在逼近时，
 * 它们仍能独立成文（`late` 分支会先把这一段写 stderr 再尝试页面采集）。
 *
 * `head` 可替换头行：close 兜底用 `[boot-probe:close]`，与"ready 等待失败"的首败
 * message 明确区分。
 */
function bootDiagnosticScaffold(
  page: Page,
  budget: ReadyBudget,
  cause: unknown,
  /** 头行的预算来源说明：默认路径写 headroom 政策，显式预算只写"显式指定"。 */
  budgetNote: string,
  head?: string,
): BootDiagnosticScaffold {
  const lines: string[] = []
  lines.push(
    head ??
      `[boot-probe] ready 等待失败：预算 ${budget.waitMs}ms（${budgetNote}）；原错误：${bootProbeOneLine(causeMessage(cause))}`,
  )
  lines.push(describeReadyBudget(budget))
  const state = bootProbes.get(page)
  // 导航事实来自探针自己的**启动范围**计数（起点 = 本轮 `gotoWorkbench` 入口）；
  // 这一行不依赖页面，渲染进程冻结/文档正在被换掉时也一定在。
  let nav: BootNavFacts | null = null
  if (state !== undefined) {
    nav = {
      starts: state.nav.starts,
      commits: state.nav.commits,
      failures: state.nav.failures,
      pending: state.nav.inFlight.size > 0,
    }
    lines.push(
      `[nav] starts=${nav.starts} commits=${nav.commits} failures=${nav.failures} pending=${nav.pending}`,
    )
  } else {
    lines.push('[nav] 探针未注册（gotoWorkbench 之外的调用）⇒ 无导航事实')
  }
  return { lines, state, nav }
}

/** 页面侧事实的几行（与改动前逐字同格式，便于既有断言与人工对账）。 */
function bootDiagnosticPageLines(facts: BootPageFacts): string[] {
  const lines: string[] = [
    `[page] readyState=${facts.readyState} scripts=${facts.scripts} __vm__=${facts.vmType} ` +
      `__vm_ready__=${facts.readyValue} .wb-shell=${facts.shellPresent ? 'present' : 'absent'}`,
    `[page] location=${facts.href.slice(0, 160)}`,
    `[boot-err] .wm-boot--err=${
      facts.bootErrText === null || facts.bootErrText === ''
        ? '<无>'
        : JSON.stringify(facts.bootErrText)
    }`,
  ]
  const slowest = facts.slowest.map((s) => `${s.name} ${s.ms}ms`).join(' | ') || '<无>'
  lines.push(`[perf] resources=${facts.resources} slowest5=${slowest}`)
  return lines
}

/** 收尾：事件摘要 + 归因（**先于**事件 tail，2KB 截断先砍细节）+ 事件尾巴。 */
function finishBootDiagnostic(
  scaffold: BootDiagnosticScaffold,
  facts: BootPageFacts | null,
  maxBytes: number,
): string {
  const lines = scaffold.lines
  const events = scaffold.state?.events ?? []
  const dropped = scaffold.state?.dropped ?? 0
  const count = (kind: BootProbeEventKind): number => events.filter((e) => e.kind === kind).length
  lines.push(
    `[events] kept=${events.length}/${BOOT_PROBE_RING_MAX} dropped=${dropped} ` +
      `console=${count('console')} pageerror=${count('pageerror')} requestfailed=${count('requestfailed')} response=${count('response')}`,
  )
  // 归因**先于**事件 tail：2KB 上限截断时先砍细节，不能先砍结论。
  const attribution = bootAttribution(events, facts, scaffold.nav)
  lines.push(
    `[attribution] ${
      attribution.length === 0 ? '未命中已知归因（只报事实，不作因果断言）' : attribution.join('；')
    }`,
  )
  for (const e of events.slice(-6)) {
    lines.push(`  +${e.at}ms ${e.kind}: ${e.line.slice(0, 120)}`)
  }
  return capUtf8(lines.join('\n'), maxBytes)
}

/**
 * 启动失败诊断（**只在 ready 等待失败时**调用；≤ {@link BOOT_DIAG_MAX_BYTES} 字节）。
 *
 * ## 组成
 *
 *  - **进程侧导航事实**（start / commit / failure / pending）与 **`[budget]` 事实**：
 *    先取、不依赖页面 —— 即便渲染进程冻结或文档正在被换掉，这两行也一定在；
 *  - **页面侧事实**（一次 evaluate，预算 = `budget.pageProbeMs`，正常路径即 2s）：
 *    `readyState` / location / scripts 数 / `.wm-boot--err` 文本 / `__vm__` 与
 *    `__vm_ready__` / 资源条数与最慢 5 项；页面已关/预算为 0/采集超时都降级为
 *    "页面侧事实不可用（原因）"，**部分诊断**照样有；
 *  - **事件摘要**（环形缓冲最后几条 + 每类计数 + 丢弃数）；
 *  - **归因候选**（见 {@link bootAttribution}）。
 *
 * ## 页面关闭不吞诊断
 *
 * 页面在 ready 等待期间被关闭（例：test deadline 先到）时，`page.evaluate` 会立即以
 * "Target page, context or browser has been closed" 失败；本函数把这个失败**降级**
 * 成页面侧不可用，**不把已组好的进程侧事实一起丢掉**。
 *
 * 注意区分两个时机（复核要求写清）：
 *  - **close 事件发生时**（页面刚被关、本函数可能还没被调到）：{@link bootProbeStateOf}
 *    注册的 close 监听会先写一条 ≤1KB 的 `[boot-probe:close]` **stderr** 兜底；它
 *    与预算来源无关，也不需要页面还活着。首败若是 Playwright 的 Test timeout（走不到
 *    本函数的 catch），这条兜底就是运行输出里唯一的事实来源。
 *  - **首败 message**：本函数产出的完整诊断（≤2KB）挂在抛出的错误 message 上；失败
 *    路径同时按原行为把它写一次 stderr。两者职责不同，不互相替代。
 */
async function collectBootDiagnostic(
  page: Page,
  budget: ReadyBudget,
  cause: unknown,
  budgetNote: string,
): Promise<string> {
  const scaffold = bootDiagnosticScaffold(page, budget, cause, budgetNote)
  let facts: BootPageFacts | null = null
  try {
    facts = await readBootPageFacts(page, budget.pageProbeMs)
  } catch (e) {
    scaffold.lines.push(
      `[page] 页面侧事实不可用（${bootProbeOneLine(causeMessage(e))}）⇒ 以下仅进程侧事实`,
    )
  }
  if (facts !== null) scaffold.lines.push(...bootDiagnosticPageLines(facts))
  return finishBootDiagnostic(scaffold, facts, BOOT_DIAG_MAX_BYTES)
}

/**
 * **晚调用预打印的 Node 侧有界兜底**（`source === 'late'` 且尚未打印过时，尝试页面采集之前）。
 *
 * 目的不是替代完整诊断，而是把"如果页面马上被关掉就再也拿不到"的结论先写 stderr：
 * 分类（`[attribution]`，只依赖事件环形缓冲与进程侧导航事实）、导航计数、预算事实。
 * 上限 {@link BOOT_NODE_FALLBACK_MAX_BYTES}，不额外 evaluate、不截图、不新增监听。
 */
function collectNodeBootDiagnostic(
  page: Page,
  budget: ReadyBudget,
  cause: unknown,
  budgetNote: string,
): string {
  const scaffold = bootDiagnosticScaffold(page, budget, cause, budgetNote)
  scaffold.lines.push('[page] close 前 Node 兜底：页面采集尚未尝试（失败报告仍会附完整诊断）')
  return finishBootDiagnostic(scaffold, null, BOOT_NODE_FALLBACK_MAX_BYTES)
}

/**
 * **启动 pending 失败的 Node 侧有界兜底**（任意预算来源；页面关闭 / goto 中止共用）。
 *
 * 与 {@link collectNodeBootDiagnostic} 的区别：这里**不是**"晚调用预打印"，而是启动
 * pending 期间唯一还能留下 Node 事实的出口：
 *  - `mode='close'`：页面 close 事件（test deadline / 外部 close）；
 *  - `mode='goto'`：`page.goto` 自身被 deadline/导航中止拒绝（非 close 语义，头行与
 *    页面行都不得写成"页面已关闭"，只写实际 cause）。
 *
 * 头行统一用 `[boot-probe:close]` 便于 runner 逐 case 计数；正文明确"未尝试 evaluate"。
 * 只读内存，不做任何页面侧动作；上限 1KB。健康成功路径 pending 已 disarm，不会触发。
 */
function collectPendingBootDiagnostic(
  page: Page,
  budget: ReadyBudget,
  cause: unknown,
  budgetNote: string,
  mode: 'close' | 'goto',
): string {
  const head =
    mode === 'close'
      ? `[boot-probe:close] 启动 pending 期间页面被关闭（test deadline / 外部 close）⇒ 仅 Node 侧事实；未尝试 page.evaluate；原错误：${bootProbeOneLine(causeMessage(cause))}`
      : `[boot-probe:close] 启动 pending 期间 goto 失败（页面关闭或导航中止）⇒ 仅 Node 侧事实；未尝试 page.evaluate；原错误：${bootProbeOneLine(causeMessage(cause))}`
  const pageLine =
    mode === 'close'
      ? '[page] 页面已关闭：页面侧事实不可得（本兜底不做 evaluate）'
      : '[page] 启动 pending 在 goto 阶段失败：未做页面采集（原因见原错误）'
  const scaffold = bootDiagnosticScaffold(page, budget, cause, budgetNote, head)
  scaffold.lines.push(pageLine)
  return finishBootDiagnostic(scaffold, null, BOOT_NODE_FALLBACK_MAX_BYTES)
}

// ---------------------------------------------------------------------------
// 入口挂载
// ---------------------------------------------------------------------------

/** `gotoWorkbench` 的可选参数（**只为测试收敛预算**，见 {@link gotoWorkbench}）。 */
export interface GotoWorkbenchOptions {
  /**
   * ready 等待的**显式上限覆盖值**（ms）。**不传**时走 `./readyBudget` 的默认政策
   * （90s 上限、正常为归因预留 30s、按真实剩余收紧，见 {@link currentTestClock}）；
   * **传了就以它为准**（不参与剩余政策）。
   *
   * 只给"负对照"这类**已知启动会失败**的用例收敛时间用：诊断要证明的是"首次超时就能
   * 区分失败类别"，不是"等满默认预算才知道失败"。它不是放宽产品判据，也不是新的自动
   * retry —— 生产 e2e 调用一律不传此参数。
   */
  readonly readyTimeoutMs?: number
}

/**
 * 是否是"ready 没等到"这一类失败（超时 / 等待期间导航销毁上下文 / **页面被关闭**）。
 *
 * ## 为什么把"页面被关闭"也算进来
 *
 * 旧口径把页面关闭原样上抛，理由是"不许把别的真实原因包装成 boot-probe"。但页面关闭
 * 恰恰是**晚调用最可能的收场**：test deadline 先到、fixture 先关页。此时进程侧事实
 * （导航 / 事件环 / 预算）都还在，丢掉它们等于把"可归因"退回"什么都没有"。
 * 故页面关闭也走诊断路径：诊断**不替代**原错误（原文仍在消息里、对象仍在 `cause`），
 * 只是补上事实。
 *
 * 其它错误（浏览器崩溃、参数非法…）**原样上抛**。
 * `TimeoutError` 用 Playwright 公开的 `name` 判定（不读私有字段）。
 */
function isReadyWaitFailure(e: unknown): boolean {
  if (isNavigationDestroyedError(e)) return true
  if (isPageClosedError(e)) return true
  if (e instanceof Error && e.name === 'TimeoutError') return true
  const m = e instanceof Error ? e.message : String(e)
  return /Timeout \d+ms exceeded/.test(m)
}

/** 页面/上下文/浏览器在等待期间被关闭（Playwright 的公开错误文案；不读私有字段）。 */
function isPageClosedError(e: unknown): boolean {
  const m = causeMessage(e)
  return (
    /Target page, context or browser has been closed/.test(m) ||
    /Target closed/.test(m) ||
    /Page closed/.test(m) ||
    /Browser has been closed/.test(m)
  )
}

/**
 * 打开完整 Workbench 并等到 `__vm__` 公开观测面就绪。
 *
 * 此时**还没有**场景：`RenderEngineHost` 只在 `loadStatus === 'ok'` 时挂载，
 * 所以 `.vc-viewport` 要等注入场景之后才出现（见 `waitForViewportMounted`）。
 *
 * ## ready 等待失败时的**有界归因**
 *
 * 旧形态（`page.waitForFunction` 超时）在 full 套件里表现为"90s 后什么都没有"：只有一句
 * `Timeout 90000ms exceeded`，既没有首跑诊断，也无法区分"模块请求失败 / 文档被反复替换 /
 * 启动抛错 / 渲染进程冻结"。
 *
 * 现在：探针（{@link bootProbeStateOf}）从**本函数入口**开始只挂监听（健康路径零
 * evaluate / 截图 / trace / 日志），一旦 ready 等待失败，就输出 ≤2KB 诊断
 * （{@link collectBootDiagnostic}），并**保留原错误为 `cause` 与原文**。
 *
 * ## 预算：90s 上限 / 正常为归因预留 30s / **按真实剩余收紧**
 *
 * 缺省 test timeout 也是 90s；若 ready 等满 90s，两者同刻到点 ⇒ test deadline 先关页面，
 * 诊断**进不了报告**。旧政策 `min(90s, max(1s, test timeout − 30s))` 只看 timeout、
 * 不看已经跑了多久：90s 的用例在 30s 时做第二次 `gotoWorkbench` 仍拿 60s，于是
 * ready + 采集一起越过 deadline。现在：
 *
 *  - 本测试**首次进入 harness** 时记锚点（{@link currentTestClock}），每次 goto 取
 *    `已耗时 = now − 锚点`、`剩余 = max(0, timeout − 已耗时)`；
 *  - 等待 = `min(90s, max(1s, 剩余 − 30s))`：
 *    剩余足够时**旧语义逐字保留**（缺省 90s ⇒ 60s、10s ⇒ 1s、无 deadline ⇒ 90s），
 *    剩余不足（< 1s + 3.25s 预留）时改走下面的 250ms 有界宽限；
 *  - `goto` 自身的耗时也算进剩余：等待真正开始前再读一次时钟，取更小的那份；
 *  - ready 之后等 `.wb-shell` 复用**同一个**等待预算（不再额外给第二份 90s）；
 *  - 显式 `readyTimeoutMs` **原样**交给 Playwright：`0` = 不设超时，**负数 = 立即超时**
 *    （Playwright 事实）；不参与剩余政策，**test timeout 本身不改**，也不用"延长
 *    test timeout"去掩盖。
 *
 * ## 晚调用（剩余不足以"1s 等待 + 3.25s 诊断预留"）
 *
 * 等待 = `min(250ms, 剩余)` 的**有界即时 ready 宽限**（从诊断预留里扣）：健康启动的
 * ready 通常只要 12–25ms，给这段候选窗口就不会把健康的晚调用误判红；坏页面在宽限后
 * 照常失败。页面侧采集预算压到 `剩余 − 等待 − 250ms`（不足则只发 Node 侧事实）。
 * **不再死守 1s 把 deadline 用完**；剩余 < 500ms 时等待再压到 `max(0, 剩余 − 250ms)`，
 * 即使页面采集预算为 0 也保留 250ms 给诊断/close 事实。也不把"预算耗尽"与
 * "显式 0 = 不设超时 / 负数 = 立即超时"混同。
 *
 * ## 两种 close 事实（复核要求分清的边界）
 *
 *  - **启动 pending 期间页面被关闭**（含 test deadline 先到）：{@link bootProbeStateOf}
 *    的 close 监听写一条 ≤1KB `[boot-probe:close]` **stderr** 兜底（budget/nav/events/
 *    attribution），**与预算来源无关、无需页面还活着**。它覆盖"锚点晚 ⇒ 剩余被高估 ⇒
 *    首败是 Test timeout、走不到本函数 catch"的情形。
 *  - **本函数 catch 到的首败**：完整诊断（≤2KB）挂在抛出错误的 message 上，并按原行为
 *    写一次 stderr。两者职责不同：前者是"页面已关时的运行输出证据"，后者是"首败报告"。
 *  Node 兜底每次启动**最多一条**：late 预打印与 close 监听共用一个 `fallbackEmitted`。
 *
 * 诊断里的 `[budget]` 行只写 `basis=anchor-estimate` + `remaining-estimate=` +
 * `actual-remaining=unknown`：剩余是从"本测试首次进入 harness"的锚点估算出来的，
 * 不是 Node 侧可测的实际剩余；deadline 关页时更不能把估算写成事实。
 *
 * ## 锚点的限度（如实登记，不声称消除未知 flaky）
 *
 * Playwright 1.60 的公开 `TestInfo` 没有 `startTime`/elapsed。锚点只能取"本测试首次
 * 进入 harness"的时刻 ⇒ 已耗时是**下界**：若首次调用之前已跑了很久，剩余会被高估。
 * 30s headroom 吸收 ≤30s 的高估；更极端的晚启动仍可能在等待/采集期间撞 deadline ——
 * 这正是 close 兜底存在的原因。本函数**不声称**"任意二次启动都必然可归因"。
 *
 * ## 边界（本单刻意不越）
 *
 *  1. 诊断**不替代**原错误：抛出的仍是"ready 等待失败"，原错误对象挂在 `cause` 上；
 *     页面在等待期间被关闭**也采诊断**（Node 事实必在、页面侧降级）；若页面在 catch
 *     之前就被关（首败是 Test timeout），则至少已有 close 监听的 `[boot-probe:close]`
 *     stderr 事实。浏览器崩溃/参数非法等其它错误仍**原样上抛**；
 *  2. 诊断**不二次长等**：页面侧采集预算由剩余算出（正常 2s），冻结/导航销毁/页面关闭
 *     都降级为部分诊断；剩余 < 500ms 时等待进一步压到 `max(0, 剩余 − 250ms)`，先给
 *     诊断/close 事件留 250ms；
 *  3. 不改判据、不新增自动 retry、不改业务断言 —— 判据仍是 `__vm_ready__` 之后
 *     `.wb-shell` 可见；预算政策见上（**不声称"90s 一字未改"**）。
 *  4. **`page.goto` 自身失败不被包装，但 pending 期间会写一条 Node 兜底**：若 `goto`
 *     自己抛（deadline 先关页导致 `net::ERR_ABORTED`、连接失败…），错误对象与原文
 *     **原样上抛**（不包装成"ready 等待失败"）；若此时仍在启动 pending，则先写一条
 *     `[boot-probe:close]` stderr 事实（≤1KB，不 evaluate）。close 事件可能晚于
 *     goto 的 reject 一两个 tick，这条同步兜底保证 deadline-during-goto 也有分类证据。
 */
export async function gotoWorkbench(
  page: Page,
  opts: GotoWorkbenchOptions = {},
): Promise<void> {
  // 显式覆盖优先；默认路径按"本次调用时的真实剩余"算预算（见函数文档）。
  const explicitBudget = opts.readyTimeoutMs !== undefined
  // 入口先取时钟：**首次调用记录本测试的锚点**，之后所有 goto 共用它（不会串到下一条用例）。
  const clockAtEntry = currentTestClock()
  const entryBudget: ReadyBudget = explicitBudget
    ? explicitReadyBudget(
        opts.readyTimeoutMs!,
        clockAtEntry?.timeoutMs ?? null,
        clockAtEntry?.elapsedMs ?? null,
      )
    : budgetFromClocks(clockAtEntry, clockAtEntry)
  // 探针从入口开始（含 goto 本身）：模块请求失败/文档替换都发生在 goto 期间。
  const state = bootProbeStateOf(page)
  // **goto 之前 armed**：deadline 可能落在 goto 本身（导航 pending）或 ready 等待期间；
  // close 监听与预算来源无关，只读内存。ready 成功/本函数退出时 disarm。
  state.pending.active = true
  state.pending.explicit = explicitBudget
  state.pending.entryClock = clockAtEntry
  state.pending.budget = entryBudget
  state.pending.fallbackEmitted = false

  try {
    try {
      await page.goto(WORKBENCH_URL)
    } catch (gotoError) {
      // deadline 落在 goto 期间：goto 会以 net::ERR_ABORTED / target closed 拒绝，
      // 而 page 的 close 事件可能晚于 reject 一两个 tick。此时 pending 仍 armed，
      // 先写**中性**的启动 pending 失败事实（不写"页面已关闭"，只带实际 cause；
      // 不包装 goto 错误，原文照抛），close 监听随后靠 fallbackEmitted 去重。
      if (state.pending.active && !state.pending.fallbackEmitted) {
        state.pending.fallbackEmitted = true
        const failureBudget = explicitBudget
          ? entryBudget
          : budgetFromClocks(clockAtEntry, currentTestClock())
        console.error(
          collectPendingBootDiagnostic(
            page,
            failureBudget,
            gotoError,
            budgetNoteOf(failureBudget, explicitBudget),
            'goto',
          ),
        )
      }
      throw gotoError
    }
    // goto 自身耗时也计入剩余：等待真正开始时重读时钟（只取更小的那份，绝不放大预算）。
    const budget: ReadyBudget = explicitBudget
      ? entryBudget
      : budgetFromClocks(clockAtEntry, currentTestClock())
    state.pending.budget = budget
    const readyTimeoutMs = budget.waitMs
    // 诊断头只说**真实来源**：显式预算不冒充 headroom（否则会误报"为归因预留 30s"）。
    const budgetNote = budgetNoteOf(budget, explicitBudget)

    /**
     * 统一失败出口：包装原错误（保留 `cause` 与原文）、挂上有界诊断、只在失败路径写控制台。
     * 晚调用先写一条 Node 兜底；close 监听与它共用一个 `fallbackEmitted`（每次启动最多一条）。
     */
    const failWithDiagnostic = async (cause: unknown): Promise<never> => {
      if (budget.source === 'late' && !state.pending.fallbackEmitted) {
        state.pending.fallbackEmitted = true
        console.error(collectNodeBootDiagnostic(page, budget, cause, budgetNote))
      }
      const diagnostic = await collectBootDiagnostic(page, budget, cause, budgetNote)
      const waitPhrase =
        readyTimeoutMs > 0
          ? `${readyTimeoutMs}ms 内 __vm_ready__ 未就绪`
          : explicitBudget
            ? // 显式 0 = 不设超时；负数 = Playwright 立即超时。两者都不是"预算耗尽 0"。
              `ready 等待失败（显式预算 ${readyTimeoutMs}ms；0=不设超时，负数=立即超时）`
            : 'ready 等待预算为 0ms（剩余不足，未等待，直接带诊断失败）'
      const wrapped = new Error(
        `gotoWorkbench：${waitPhrase}（${bootProbeOneLine(causeMessage(cause))}）\n${diagnostic}`,
      )
      ;(wrapped as Error & { cause?: unknown }).cause = cause
      // 只有失败路径才写控制台：健康路径不得出现任何 `[boot-probe]` 日志。
      console.error(wrapped.message)
      throw wrapped
    }

    // 只有**默认路径**的"剩余 0"才快速失败：Playwright 的 `timeout: 0` 是"不设超时"，
    // 负数则是"立即超时"（实测），两者语义不同；显式覆盖都原样交给它，不能与
    // "预算耗尽"混同。
    if (!explicitBudget && readyTimeoutMs <= 0) {
      await failWithDiagnostic(
        new Error(
          `ready 等待预算为 0ms（test 剩余 ${budget.remainingMs ?? '未知'}ms 已到 0；未等待）`,
        ),
      )
    }

    try {
      await page.waitForFunction(() => (window as any).__vm_ready__ === true, undefined, {
        timeout: readyTimeoutMs,
      })
    } catch (cause) {
      // 只包装"ready 没等到"这一类；其它错误原样上抛（不让诊断掩盖真实原因）。
      if (!isReadyWaitFailure(cause)) throw cause
      await failWithDiagnostic(cause)
    }
    // ready 成功：启动已经结束，之后的关页不再算"启动 pending"（健康路径 close 零输出）。
    state.pending.active = false
    // 与 ready 共用同一等待预算：晚调用下不得在这里又等 90s。
    await expect(page.locator('.wb-shell')).toBeVisible({ timeout: readyTimeoutMs })
  } finally {
    state.pending.active = false
  }
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
      // 存在性走具名读面（`getDoc()` 已终删）。
      return !!ctx && ctx.hasLoadedDocument()
    },
    undefined,
    { timeout },
  )
}

/**
 * 等到「已渲染网格」= 视口 slot 的 `definition` 非空。
 * 仅对帧为主文档有意义（多方块文档的网格由装配阶段写入，同理适用）。
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
 * ## 观测点从 `ctx.getCurrentFrameIndex().value` 改为 `ctx.getFrameIndex()`
 *
 * 旧观测点返回一个**可写** `Ref<number>`（`Main.currentFrameIndex`），现已删除。
 * 新观测点是**只读派生**访问器（`Context.getFrameIndex()`）—— 它由
 * `EditContext.time` 经离散阶跃采样算出。
 *
 * 对 e2e 的意义是**判据更强了**：旧观测点只能证明"某个 Ref 被写成了 i"
 * （写入者可能是 operator，也可能不是播放）；新观测点证明的是
 * "**内核的时间**落在第 i 帧上"。后者才是无头管线「播放推进」真正要断言的事。
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
// 导航竞态防护
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
interface MainFrameNavEpochs {
  /** 已**提交**（`framenavigated`）的 main-frame 导航数 —— `navEpochOf` 的既有公开语义。 */
  commits: number
  /** 已**发起**（main-frame navigation request）的导航数 —— `navStartEpochOf` 的语义。 */
  starts: number
  /** 已发起、但尚未提交/失败的 main-frame 导航请求。 */
  inFlight: Set<Request>
  /** 已发起、随后**失败/取消**（不会再有提交）的 main-frame 导航请求数。 */
  failures: number
  /** `request/requestfinished/requestfailed` 监听是否已注册（每页只注册一次）。 */
  startTracking: boolean
}

const navEpochs = new WeakMap<Page, MainFrameNavEpochs>()

/** 取本页的计数状态（首次调用时注册一次性 `framenavigated` 监听）。 */
function navEpochStateOf(page: Page): MainFrameNavEpochs {
  let st = navEpochs.get(page)
  if (st !== undefined) return st
  const state: MainFrameNavEpochs = { commits: 0, starts: 0, inFlight: new Set(), failures: 0, startTracking: false }
  navEpochs.set(page, state)
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) state.commits += 1
  })
  return state
}

/**
 * 取当前导航纪元（main frame 的 `framenavigated` **提交**计数）。
 *
 * ## 语义保持：这是"文档真的换了"的计数（修复前后不变）
 *
 * `kernel-save-reopen` / `kernel-move-persist` 用 `epochBefore = navEpochOf(page)`、
 * `page.reload()` 后断言 `navEpochOf(page) > epochBefore` 来证明"reload 真的换掉了文档"。
 * 它们要的是**提交**（旧文档被新文档替换），不是"请求已发出"——因此本函数**只**数
 * `framenavigated`。请求计数在 {@link navStartEpochOf}，两者刻意分开。
 */
export function navEpochOf(page: Page): number {
  return navEpochStateOf(page).commits
}

/**
 * 取当前导航**发起**纪元（main-frame navigation request 计数）。
 *
 * ## 为什么单靠 `navEpochOf`（commit）不够（导航残余竞态）
 *
 * 导航有两个可观测时刻，中间隔着一整个网络往返：
 *
 * ```text
 * request(start) ──────────（响应未到，旧文档仍在跑）──────────▶ framenavigated(commit)
 * ```
 *
 * 只数 commit 时，`start → commit` 之间的窗口是**盲区**：`page.evaluate` 仍会在旧文档里
 * 正常返回，`waitForLoadState('load')` 也会因为旧文档早已 load 而**立即**通过。
 * 于是旧文档的结果被当成"没有导航发生"采信 —— 这正是确定性回归 C 复现的形态
 * （扣住 reload 的主文档响应 1200ms > evaluate 500ms，窗口内只有 start、没有 commit）。
 *
 * ## 惰性注册的边界（调用方须知）
 *
 * 监听第一次调用本函数时才挂上；**在调用之前已经发出的请求不会被追溯计数**。
 * 需要覆盖某次导航时，必须在触发它之前先读一次本函数（或让它随更早的
 * `evaluateNavigable` 调用完成注册）。
 */
export function navStartEpochOf(page: Page): number {
  const state = navEpochStateOf(page)
  if (!state.startTracking) {
    state.startTracking = true
    page.on('request', (req) => {
      if (!req.isNavigationRequest()) return
      if (req.frame() !== page.mainFrame()) return
      // 重定向会为后续请求再发一次 request；被重定向的那条不应永远占着 inFlight。
      const from = req.redirectedFrom()
      if (from !== null) state.inFlight.delete(from)
      state.starts += 1
      state.inFlight.add(req)
    })
    page.on('requestfinished', (req: Request) => {
      state.inFlight.delete(req)
    })
    page.on('requestfailed', (req: Request) => {
      // 只有"本模块跟踪的那条导航请求"失败才算一次终止；普通资源失败与判据无关。
      if (state.inFlight.delete(req)) state.failures += 1
    })
  }
  return state.starts
}

/** 当前是否有 main-frame 导航"已发起、未提交也未失败"（仅测试进程侧状态）。 */
export function hasPendingMainFrameNavigation(page: Page): boolean {
  return navEpochStateOf(page).inFlight.size > 0
}

/**
 * 一次尝试开始时的导航纪元快照（start / commit / failure）。
 *
 * `starts` / `commits` 是公开语义；`failures` 只用于落定判据
 * （"在途导航已失败/取消 ⇒ 不会再有提交"），不作为页面可观测点。
 */
export interface NavEpochSnapshot {
  readonly starts: number
  readonly commits: number
  readonly failures: number
}

/**
 * 取当前快照，并**自保证** main-frame 导航的 request 监听已经注册。
 *
 * ## 为什么需要"取快照"这个显式入口
 *
 * 监听是惰性的：谁先读计数，谁就负责注册。若调用方把"等落定"排在自己的
 * 快照之前，等待函数会看到一个尚未开始计数的空状态而**立即返回** —— 这不是
 * "没有导航"，而是"还没开始看"。本函数把"注册 + 取快照"合成一步，
 * 让调用方不必记住顺序；{@link waitForPendingMainFrameNavigation} 内部也会
 * 再自保证一次（防未来先 wait 后注册）。
 *
 * 边界仍是：**调用之前已经发出的请求不会追溯计数**。要覆盖某次导航，
 * 必须在发起它之前先取一次快照（或让它随更早的 evaluate 完成注册）。
 */
export function navEpochSnapshotOf(page: Page): NavEpochSnapshot {
  const starts = navStartEpochOf(page)
  const state = navEpochStateOf(page)
  return { starts, commits: state.commits, failures: state.failures }
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
 * "等待在途导航落定"的**上限**（不是等待时长）。
 *
 * 正常路径由 `framenavigated`（提交）/ `requestfailed`（终止）事件**立即**唤醒；
 * 只有导航既不提交也不失败（例如响应被挂起）才会走到这个上限。它不是 sleep：
 * 不是为了"给导航一点时间"，而是给"事件永远不来"一个有限出口。
 */
const NAV_SETTLE_TIMEOUT_MS = 15_000

/**
 * 有界等待在途的 main-frame 导航**提交或终止**。
 *
 * ## 为什么重试前必须先等它（导航残余竞态）
 *
 * 导航请求已发出、响应未到时，**旧文档仍然活着**：`waitForLoadState('load')` 会因为
 * 旧文档早已 load 而**立即通过**。若此时直接进入下一次尝试，就绪门形同虚设，
 * 重试会在旧文档上原地打转，直到把 `attempts` 耗尽。
 *
 * ## 落定判据（不是"等一段时间"）
 *
 *  - 本次尝试开始后发生了 `framenavigated`（`commits > before.commits`）⇒ 已提交；
 *  - 本次尝试开始后**有导航失败/取消**（`failures > before.failures`）且已无在途
 *    请求 ⇒ 已终止（不会再有提交）；
 *  - 都没有 ⇒ 到 {@link NAV_SETTLE_TIMEOUT_MS} 的有限上限，交给下一轮门/尝试。
 *
 * `requestfinished` 早于 `framenavigated` 的极窄窗口**不**当作已落定：
 * 那时新文档还没提交，正是本单要防的"旧文档被误当成就绪"的形态。
 *
 * ## 两个调用点共用同一套政策（不要复制第二份）
 *
 *  - `evaluateNavigable` 的重试前；
 *  - `injectSceneDocumentOk` 的**外层**重做前 —— 内层 evaluate 是 `attempts: 1`
 *    （不嵌套重试）；外层用同一等待，把"何时算落定"从 Playwright 的隐式行为
 *    变成显式有界政策（缺它时棘轮 D 的探针 `commit=0` 判红，而不是注入失败）。
 *
 * ## 自保证注册
 *
 * 入口先调一次 {@link navStartEpochOf}：即便调用方把 wait 排在取快照之前，
 * 也不会因为"监听还没挂上"而把空状态误读成"没有在途导航"。
 */
export async function waitForPendingMainFrameNavigation(
  page: Page,
  before: NavEpochSnapshot,
  timeout: number,
): Promise<void> {
  // 自保证：先注册 request/finished/failed 监听，再读状态。
  navStartEpochOf(page)
  const state = navEpochStateOf(page)
  const settled = (): boolean =>
    state.commits > before.commits ||
    (state.failures > before.failures && state.inFlight.size === 0)
  if (settled()) return
  await new Promise<void>((resolve) => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (done) return
      done = true
      if (timer !== undefined) clearTimeout(timer)
      page.off('framenavigated', onCommit)
      page.off('requestfailed', onFailed)
      resolve()
    }
    const onCommit = (frame: Frame): void => {
      if (frame === page.mainFrame() && state.commits > before.commits) finish()
    }
    const onFailed = (): void => {
      if (settled()) finish()
    }
    page.on('framenavigated', onCommit)
    page.on('requestfailed', onFailed)
    timer = setTimeout(finish, Math.min(timeout, NAV_SETTLE_TIMEOUT_MS))
    // 注册监听之前事件可能已经到达（JS 单线程里窗口很窄，但确实存在）。
    if (settled()) finish()
  })
}

/**
 * 在**导航竞态**下依然可用的 `page.evaluate`。
 *
 * ## 契约（四件事同时成立才算成功）
 *
 *  1. 每次尝试前先过 {@link waitForEvaluateReady}（load + app 就绪）；
 *  2. evaluate 正常返回；
 *  3. **该次尝试期间 start 纪元未变**（没有新的 main-frame navigation request）；
 *  4. **commit 纪元未变**，且返回时**没有仍未落定的导航请求**。
 *
 * ## 为什么 start 与 commit **两个都要**（导航残余竞态）
 *
 * 只数 commit 时，`start → commit` 之间的整个网络往返是盲区：旧文档还在跑，
 * evaluate 会**正常返回旧文档的结果**，而 commit 尚未发生 —— 若只看 commit，
 * 这个结果会被当成"没有导航"采信。反过来，只数 start 也不够：
 * 一条 start 可能在求值**之前**就已发出并挂起（此时 start 前后不变、commit 也不变），
 * 所以还必须有第 4 条的"无在途导航"判据。两者合起来才等价于
 * "这次返回值来自一份**已经稳定**的文档，且期间没有被替换"。
 *
 * ## 为什么这不是"加 sleep 碰运气"
 *
 *  - **不 sleep**：重试前先**有界等待在途导航提交或终止**（见
 *    {@link waitForPendingMainFrameNavigation}），再走既有 load + `__vm_ready__` 门。
 *    等的是事件（事实），不是固定时长。
 *  - **有界**：`attempts` 默认 3，每个在途等待另有上限。耗尽仍失败 ⇒ 抛错
 *    （含最后一次的真实原因与 starts/commits），不会把失败变成静默通过。
 *  - **只接环境竞态**：非导航类错误原样上抛，判据强度不受影响；
 *    被拒绝的**成功返回值**也按失败处理（重试），绝不"先收下再说"。
 *  - **不嵌套**：本函数只做这一层有界重试；注入步骤的重做由
 *    `injectSceneDocumentOk` 单独负责（`injectSceneDocument` 传 `attempts: 1`），
 *    且外层重做前**复用同一个** {@link waitForPendingMainFrameNavigation}，
 *    不复制第二套政策。
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
    // 快照同时完成"注册 start 监听"：之后的 evaluate 窗口才有 start/commit 可比。
    const epoch = navEpochSnapshotOf(page)
    const startsBefore = epoch.starts
    const commitsBefore = epoch.commits
    try {
      const value = await page.evaluate(fn as never, arg as never)
      const startsAfter = navStartEpochOf(page)
      const commitsAfter = navEpochOf(page)
      const stillPending = hasPendingMainFrameNavigation(page)
      if (startsAfter === startsBefore && commitsAfter === commitsBefore && !stillPending) {
        return value as T
      }
      lastReason =
        `evaluate 期间主文档导航状态变化（starts ${startsBefore}→${startsAfter}，` +
        `commits ${commitsBefore}→${commitsAfter}${stillPending ? '，且仍有未提交的导航请求' : ''}）` +
        '：结果不可信，可能来自已被丢弃/即将被丢弃的文档'
    } catch (e) {
      if (!isNavigationDestroyedError(e)) throw e
      lastReason = e instanceof Error ? e.message.split('\n')[0] : String(e)
    }
    if (attempt < attempts) {
      // ① 先有界等待在途导航**提交或终止**：否则下一轮的 load 门会在旧文档上立即通过。
      await waitForPendingMainFrameNavigation(page, epoch, timeout)
      // ② 再走既有门：等**新文档** load 完成（失败时超时无妨：下一轮就绪门会再等）。
      await page.waitForLoadState('load', { timeout }).catch(() => undefined)
    }
  }
  throw new NavigationInterruptedError(
    `evaluateNavigable：${attempts} 次尝试均被导航打断（每次都等到在途导航落定 + load + app 就绪后才重试）。` +
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
 * ## 为什么走 `evaluateNavigable` 而不是裸 `page.evaluate`（导航竞态）
 *
 * 注入要跑 `OPERATOR_OPEN_SCENE`（解析 JSON + 建文档 + 装配），耗时数百毫秒 ——
 * 这是一个**窗口**。若该窗口内页面发生导航（dev server 的 HMR `full-reload`
 * 或 `vite:ws:disconnect` 都会让 Vite 客户端 `location.reload()`），执行上下文被销毁，
 * 于是报 `Execution context was destroyed, most likely because of a navigation`
 * ——即该竞态观测到的间歇失败（全量套件、负载下更易出现；单跑该 spec 不复现）。
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
      if (!ctx) throw new Error('harness: window.__vm__ 未就绪')
      const file = new File([text], fileName, { type: 'application/json' })
      // 与生产拖放同一入口
      await ctx.getOperators().exec('OPERATOR_OPEN_SCENE', { file })
      // 内容事实各有具名读面。
      // 形态判别改走**内核读面**（原 `ctx.legacyRenderSource()` 已退役）。
      const loaded = ctx.hasLoadedDocument()
      const plain = ctx.plainForSave().plain as Record<string, unknown> | null
      const body = ctx.kernelMultiblockBody()
      // ⚠️ **严格性**：产物 plain 声明了多方块 ⇒ body **必须**非空。
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
  /**
   * **测试接线探针**（可选）：每轮重做的"等落定"**返回后**回调一次，带上当前快照。
   *
   * 只用于钉住"外层重做复用了与 `evaluateNavigable` 同一个落定等待、且等待真的
   * 走完"这条接线；不参与判定、不改变等待行为（默认 `undefined` ⇒ 什么都不做）。
   */
  readonly onRetrySettle?: (after: NavEpochSnapshot) => void
}

/** 注入步骤的**文档原子性标记**（一次性随机串；导航会把它连同旧文档一起清掉）。 */
function newInjectToken(): string {
  return `wk-inj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 注入并断言加载成功；返回注入结果。
 *
 * ## 为什么整步要重做，而不只是给 evaluate 加重试（实测教训）
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
 * ## 外层重做前也等**同一份**落定（复核缺口）
 *
 * 内层 `injectSceneDocument` 固定 `attempts: 1`（不嵌套重试），"注入 evaluate 被
 * 导航打断"交给本函数重做。外层若只靠 `waitForEvaluateReady`/load 门，就把"何时
 * 算落定"交给了 Playwright 对 pending 导航的隐式行为 —— 实测 Chromium 会把新
 * evaluate/等待串行到 commit，从而**掩盖**缺口；去掉显式等待时，棘轮 D 的落定探针
 * `commit=0` 判红，而不是注入失败。
 * ⇒ 本函数在每轮重做前调用与 `evaluateNavigable` **同一个**
 * {@link waitForPendingMainFrameNavigation}：先等本轮在途导航提交/终止，再走
 * load + app 就绪门。政策只有一份，这里不允许再复制一套。
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
    // 外层重做的**同一份** epoch：本轮注入期间若导航已发起但未提交，
    // 内层 evaluate（attempts: 1）会拒绝；重做前必须等同一份在途导航落定。
    const epoch = navEpochSnapshotOf(page)
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
      } else {
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
        } else {
          return result
        }
      }
    } catch (e) {
      if (!isNavigationDestroyedError(e)) throw e
      lastReason = e instanceof Error ? e.message.split('\n')[0] : String(e)
    }
    if (attempt < attempts) {
      // 外层重做前也必须先等**同一份**在途导航提交/终止（与 evaluateNavigable 同一政策）。
      // 这是**显式的有界政策**：不依赖 Playwright 对 pending 导航的隐式延迟。
      // 实测 Chromium 会把 pending 期间的新 evaluate/等待串行到 commit，从而掩盖缺口；
      // 删掉本等待时，棘轮 D 的落定探针 commit=0 判红，而不是"注入失败"。
      await waitForPendingMainFrameNavigation(page, epoch, timeout)
      opts.onRetrySettle?.(navEpochSnapshotOf(page))
      await page.waitForLoadState('load', { timeout }).catch(() => undefined)
    }
  }
  throw new NavigationInterruptedError(
    `injectSceneDocumentOk：${attempts} 次尝试均被导航打断（每次都等到在途导航落定 + load + app 就绪后才重做）。` +
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
  /** 帧是否带自己的 grid（多方块帧为 false：网格由装配产生）。 */
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
   * 真实产物的形态键在**信封 meta**（契约 §2），因此信封形态下这里是 null ——
   * 形态判别的公开观测点用 `isMultiblock`。
   */
  documentShape: string | null
  /** `doc.multiblockSource` 是否非空（装配器的输入是否就绪）。 */
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
  /** **场景数**（声明里的变体配置集合；领域现叫 Scene，格式键仍是 `frames`）。 */
  multiblockSceneCount: number
  totalTierDomain: { min: number; max: number; default: number | null } | null
  backbone: BackboneObservation | null
  blockPaletteSize: number
  /**
   * **解析告警**（内核读面迁移以来：必须连同 {@link declarationMatchesSource} 一起读）。
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
   * 内核**无损源根**（= 契约内层 body 与信封 meta 合并后的 plain 形状；页面侧没有解析器，
   * 故原样过桥给测试进程重解析 —— 见 {@link warnings}）。`null` = 未采集。
   */
  kernelSourceRoot: unknown
  /**
   * `decl.backbone.sizeSteps[i].cellGrid` 是否与**内核无损源根**的 `multiblock.backbone`
   * 逐格一致 —— 证明解析器把格级数据**原样透传**，而不是自己算了一份。
   */
  backboneMatchesSource: boolean | null
}

/**
 * 一次性读回全部公开的文档/多方块声明观测点。
 *
 * 数据来源（全部公开，迁移后全部是**内核读面**）：
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
    // ## 观测面按**事实种类**分开取（`getDoc()`/`legacyRenderSource()` 均已退役）
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
        multiblockSceneCount: 0,
        totalTierDomain: null,
        backbone: null,
        blockPaletteSize: 0,
        warnings: [],
        declarationMatchesSource: null,
        kernelSourceRoot: null,
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
      // 实测全仓**没有**任何判据依赖旧口径（`doc.documentShape` 无 spec 断言）。
      documentShape: typeof plain?.documentShape === 'string' ? plain.documentShape : null,
      multiblockSourcePresent: sourceMultiblock !== null,
      isMultiblock: body !== null,
      frameCount: frameDecl.count,
      // 逐帧网格走 `kernelGrid(i)`；i = 声明序 —— 与旧 `frames[i]` 同一遍历序。
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
      // 声明里的**场景**清单（内核声明字段 `scenes`；不是时间轴帧数）。
      multiblockSceneCount: decl?.scenes?.length ?? 0,
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
      kernelSourceRoot: sourceRoot,
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
 * **内核源根 → 重解析**（`warnings` 处置的方案）。
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
  // ⚠️ 解析器的实参是**内层 body**（`{multiblock, multiblockCount, frames, …}`），
  // 不是 `multiblock` 节本身 —— L2 实测：传节本身会得到
  // `documentShape="multiblock" 要求内层存在 multiblock 对象（实际 undefined）`。
  const source = obs.kernelSourceRoot
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
// 窄观测：帧为主用例**实际消费**的文档字段
// ---------------------------------------------------------------------------

/** 一帧的**形状 + 实心数**（本用例断言的四元组；cellGrid 原样不过桥）。 */
export interface FrameShapeObservation {
  d: number
  h: number
  w: number
  solidCells: number
}

/**
 * {@link readFrameDocObservation} 的返回面 —— **只含多帧用例实际消费的字段**。
 *
 * 字段来源与 {@link readDocObservation} 的同名字段**逐字相同**（同一表达式、同一回落）：
 *
 * | 窄读字段 | 宽读里的同一表达式 |
 * |---|---|
 * | isMultiblock | body !== null（body = ctx.kernelMultiblockBody()） |
 * | channelCount | decl?.channels?.length ?? 0 |
 * | runstateCount | decl?.runstates?.length ?? 0 |
 * | variantCount | decl?.variants?.length ?? 0 |
 * | multiblockSceneCount | decl?.scenes?.length ?? 0 |
 * | frameCount | ctx.frameDeclarations().count |
 * | frameGrids | Array.from({length: frameDecl.count}, (_, i) => ctx.kernelGrid(i) → {d,h,w,solidCells}) |
 *
 * 刻意**不**读（本用例对其没有任何断言）：
 *  - plainForSave().plain（docId / documentShape）—— 产物 plain 是全文档投影；
 *  - kernelSourceRoot()（无损源根）与 withSourceParse()（测试进程重解析）；
 *  - channels / runstates 明细、backbone 逐格、totalTierDomain、
 *    blockPaletteSize、ruleCount、warnings、declarationMatchesSource、
 *    backboneMatchesSource。
 *
 * ⚠️ 这是**本用例的消费面**，不是"新的全读面"：以后哪个断言需要上面的字段，
 * 就回到 {@link readDocObservation}（它才是完整观测面），不要在这里逐个补。
 * 理由：宽读每次把源根 + 产物 plain 过桥（4 并发诊断实测 3.8–4.9s/次），
 * 而本用例只消费这 7 个字段。
 */
export interface FrameDocObservation {
  isMultiblock: boolean
  channelCount: number
  runstateCount: number
  variantCount: number
  multiblockSceneCount: number
  frameCount: number
  frameGrids: FrameShapeObservation[]
}

/**
 * 只读多帧用例实际消费的字段（窄读）。
 *
 * 语义与 {@link readDocObservation} 的对应字段**等价**（见 {@link FrameDocObservation}
 * 的表达式对照表）；差别只在**不构造/不过桥**未消费的观测面，因此不需要
 * kernelSourceRoot()，也不在测试进程重解析源根。
 */
export async function readFrameDocObservation(page: Page): Promise<FrameDocObservation> {
  return await page.evaluate(() => {
    const ctx = (window as any).__vm__
    const loaded = ctx.hasLoadedDocument()
    if (!loaded) {
      return {
        isMultiblock: false,
        channelCount: 0,
        runstateCount: 0,
        variantCount: 0,
        multiblockSceneCount: 0,
        frameCount: 0,
        frameGrids: [],
      }
    }
    // 与 readDocObservation 同一取值链（body → declaration → 各计数）。
    const body = ctx.kernelMultiblockBody() as { declaration?: any } | null
    const decl = body?.declaration ?? null
    const frameDecl = ctx.frameDeclarations()
    return {
      isMultiblock: body !== null,
      channelCount: decl?.channels?.length ?? 0,
      runstateCount: decl?.runstates?.length ?? 0,
      variantCount: decl?.variants?.length ?? 0,
      multiblockSceneCount: decl?.scenes?.length ?? 0,
      frameCount: frameDecl.count,
      // 逐帧网格走 kernelGrid(i)；i = 声明序 —— 只取形状/实心数，不过桥 cellGrid。
      frameGrids: Array.from({ length: frameDecl.count }, (_v, i) => {
        const grid = ctx.kernelGrid(i)
        if (!grid) return { d: 0, h: 0, w: 0, solidCells: 0 }
        return {
          d: grid.depth,
          h: grid.height,
          w: grid.width,
          solidCells: grid.count(),
        }
      }),
    }
  })
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
 * 这是「web 装配 vs mod 导出逐格 diff」的网格来源：
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
// 通道滑杆遍历通用原语
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
      throw new Error(`harness：等待超时（${timeout}ms）—— ${label}${last === null ? '' : `（最后一次观测：${JSON.stringify(last)}）`}`)
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
// 真实产物验收：内容 mesh 的「世代」观测
// ---------------------------------------------------------------------------

export interface ContentMeshObservation {
  /** 视口 slot 里是否已有内容 mesh 组。 */
  present: boolean
  /**
   * **内容世代**标识（语义已变更，见下）。
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
        `真实产物：等待内容 mesh 世代更新超时（${timeout}ms）—— previousUuid=${previousUuid ?? '<首次>'}，` +
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
