/**
 * 库入口：挂载 Wiki 结构渲染器（显式 bootstrap，无隐式配置）。
 *
 * ## `mount()` 现在返回**显式寿命句柄**
 *
 * 旧实现返回 `void`：调用方拿不到 Vue app 句柄，于是
 *  - 同一页面**重复** `mount()` 会叠挂实例（每组 GL/presenter/帧循环各活一份）；
 *  - Wiki 换了内容只能把整页刷掉才能释放上一份；
 *  - 契约里只能把它登记成 `lifecycleGap`（`adapters/host/hostCapabilities.ts`）。
 *
 * 现在返回值是 {@link EmbedSession}：`unmount()` 真正卸载（组件树 → 视口槽位 →
 * presenter/纹理 → 帧循环 → 日志与装配探针登记），`update()` 换 bootstrap
 * 而不新建实例（与 `EmbedRoot` 的 `watch(bootstrap)` 同一语义）。
 *
 * ## 失败面：warn + **容器内占位诊断**，不抛未捕获异常、不静默
 *
 * 旧形态是"缺挂载点只 warn 然后 return"——宿主拿不到任何失败信号。
 * 调度策略：**warn + 占位诊断**。三种失败各有落点：
 *
 * | 情况 | 落点 |
 * |---|---|
 * | 找不到挂载点（没有容器可画） | `console.warn` + `session.failure`（`code:'noMountPoint'`） |
 * | 组件树渲染/挂载抛错 | 容器内 `.embed-mount-error[role=alert]` 占位 + `session.failure` |
 * | 装配失败（`createEmbedShellRuntime` 抛） | 同上（Vue 的 `errorHandler` 收口） |
 *
 * 占位**在容器内**而不是抛给页面：Wiki 正文不该因为一个嵌入坏了整页报错；
 * 但也不能静默 —— 占位带 `data-lk-embed-error` 与原因文本，宿主与 e2e 都能读。
 */

import { createApp, h, reactive, type App } from 'vue'

import EmbedRoot from '@/embed/EmbedRoot.vue'
import { ensureMobileFitHost } from '@/embed/mobileFitHost'
import { initEmbedTouchSim } from '@/embed/touchPointer'
import { allocateEmbedInstanceId } from '@/runtime/instanceIdentity'

import type { EmbedBootstrapOptions } from './embedContract'

import '@/styles/precision-tokens.css'
import '@/styles/embed-nei-tokens.css'
import '@/styles/embed-mobile.css'
/* Wiki 外壳规则：与 scripts/huiji/StructureRender.css 同源，构建时并入 dist/StructureRender.css 末尾 */
import '../../../scripts/huiji/StructureRender.css'

/** 挂载失败的结构化原因（`session.failure`；`null` = 正常挂载）。 */
export interface EmbedMountFailure {
  readonly code: 'noMountPoint' | 'mountThrew'
  /** 人读原因（占位里显示的就是这句）。 */
  readonly message: string
}

/**
 * 一次嵌入挂载的**寿命句柄**（替代旧的"无返回值"）。
 *
 * 它只表达"这一份嵌入的存在与结束"，不暴露 Context/Vue 内部：
 * 宿主（Wiki 模板 / SDE 预览 / e2e 页）需要的就是这三个动作。
 */
export interface EmbedSession {
  /** 本实例身份（持久化键与日志观测面的键；见 `runtime/instanceIdentity`）。 */
  readonly instanceId: string
  /** 是否真的挂上了（`false` ⇒ 看 `failure`）。 */
  readonly mounted: boolean
  /** 挂载失败原因（`null` = 正常）。 */
  readonly failure: EmbedMountFailure | null
  /**
   * 换一份 bootstrap（同一实例）。
   *
   * 与"重新 `mount()`"不是一回事：不新建 Vue app、不换实例身份，
   * 于是偏好/日志/装配探针都还是这一份。`EmbedRoot` 的 `watch(bootstrap)`
   * 会因为新对象而重新装载文档。
   */
  update(next: EmbedBootstrapOptions): void
  /**
   * 显式销毁本实例（幂等）。
   *
   * 顺序即语义：卸载 Vue 树（→ 各组件 `onBeforeUnmount`：视口槽位归零、
   * presenter/纹理释放、帧循环停、`__log__`/`__lk_embed__` 注销）→
   * 清空容器 → 移除本函数创建的 fit 外壳包装。
   */
  unmount(): void
}

/** 缺省挂载点（与 `main.ts` 的 `MOUNT_SELECTOR` 同源语义）。 */
const DEFAULT_SELECTORS = ['.web-structure-renderer', '#web-structure-renderer'] as const

function resolveMountElement(target: string | Element | null | undefined): HTMLElement | null {
  const el =
    target == null
      ? document.querySelector(DEFAULT_SELECTORS[0]) ?? document.querySelector(DEFAULT_SELECTORS[1])
      : typeof target === 'string'
        ? document.querySelector(target)
        : target
  return el instanceof HTMLElement ? el : null
}

/**
 * 在容器内画占位诊断（**不抛**）。
 *
 * 用原生 DOM 而不是 Vue：失败可能发生在 app 挂载前后，占位必须两种情形都能画。
 */
function renderFailurePlaceholder(el: HTMLElement, failure: EmbedMountFailure): void {
  el.querySelector(':scope > .embed-mount-error')?.remove()
  const box = document.createElement('div')
  box.className = 'embed-mount-error'
  box.setAttribute('role', 'alert')
  box.setAttribute('data-lk-embed-error', failure.code)
  box.textContent = `结构渲染器挂载失败：${failure.message}`
  // 内联样式而不是外挂 CSS：占位必须在**任何**宿主页面都可见，
  // 而嵌入库的样式表由宿主页按需引入 —— 依赖它会让"失败不可见"重新出现。
  box.style.cssText = [
    'padding:12px 14px',
    'font:13px/1.5 system-ui, sans-serif',
    'color:#fecaca',
    'background:#3f1d1d',
    'border:1px solid #7f1d1d',
    'border-radius:4px',
    'white-space:pre-wrap',
  ].join(';')
  el.appendChild(box)
}

function failureSession(instanceId: string, failure: EmbedMountFailure): EmbedSession {
  return {
    instanceId,
    mounted: false,
    failure,
    update() { /* 没有实例可更新：保持失败态，不静默"变成成功" */ },
    unmount() { /* 没有实例可销毁（幂等） */ },
  }
}

export function mount(
  target: string | Element | null | undefined,
  options: EmbedBootstrapOptions,
): EmbedSession {
  const el = resolveMountElement(target)
  const instanceId = allocateEmbedInstanceId()
  if (el === null) {
    const failure: EmbedMountFailure = {
      code: 'noMountPoint',
      message: `未找到挂载节点 ${target ?? DEFAULT_SELECTORS.join(' / ')}`,
    }
    // 没有容器可画 ⇒ 只剩 warn + 结构化失败（**不**抛：Wiki 正文不该因一个嵌入整页报错）。
    console.warn('[StructureRenderer] mount:', failure.message)
    return failureSession(instanceId, failure)
  }

  // **主题不再写全局**（实例作用域的同一政策）。
  //
  // 旧实现是：
  //   const theme = options.ui?.theme ?? document.documentElement.dataset.neiTheme ?? 'dark'
  //   document.documentElement.dataset.neiTheme = theme      // ← 挂载期写全局
  //
  // 那有三个问题，第三个是同页多实例才会暴露的：
  //  1. **挂载期副作用**：`mount()` 本该只挂组件，却改了文档根属性；
  //  2. **写的是全局**：`data-nei-theme` 在 `documentElement` 上，全页一份；
  //  3. **同页两实例互相覆盖**：第二个 `mount()` 用**自己的** theme 覆盖第一个，
  //     于是先挂的那个被迫换了主题。
  //
  // 现在的落点：`EmbedViewport` 的**实例根元素**上写 `data-lk-theme`
  // （`ctx.getShellSettings().scopeAttrs`）。自定义属性沿 DOM 继承，
  // 故每个实例解析出自己的变量值，互不影响。
  //
  // 主题来源优先级不变（`options.ui.theme` > 实例偏好 > 文档根的既有属性 > `dark`）：
  // `options.ui.theme` 经 `EmbedRoot` → `buildEmbedSettingsFromBootstrap` 进实例设置；
  // 文档根属性的读取在 `shellSettings.ts` 的迁移路径里（那里**只读不写**）。
  // ⇒ 读取是"继承宿主页面的意图"，写入是"本实例的解析结果"；读取不产生覆盖。

  const mountEl = el
  // 实例身份由**装配层**分配：同页两次 mount 得到互不相同的 id，
  // 实例设置/viewer 偏好/日志观测面因此互不覆盖。同一次页面装载里按挂载顺序
  // 稳定（第一个嵌入恒为 embed-1）⇒ 刷新后仍读回自己的偏好。
  //
  // `props` 用 reactive 持有：`update()` 只替换里面的 bootstrap 对象，
  // Vue 的 `props.bootstrap` 随之变化 ⇒ `EmbedRoot` 的 `watch` 重新装载文档。
  // 这样"换内容"不会新建第二个实例（那正是旧的叠挂缺陷）。
  const props = reactive<{ bootstrap: EmbedBootstrapOptions; instanceId: string }>({
    bootstrap: options,
    instanceId,
  })

  const app: App = createApp({ render: () => h(EmbedRoot, { bootstrap: props.bootstrap, instanceId: props.instanceId }) })

  let failure: EmbedMountFailure | null = null
  /**
   * 渲染/挂载期异常收口（`app.config.errorHandler`）。
   *
   * 为什么不是把 Vue 的报错抛给页面：`mount()` 是**库**入口，Wiki 正文里一个嵌入
   * 装配失败不该让整页出现未捕获异常。但也不许静默 ——
   * 容器内落占位 + `console.error` + `session.failure` 三面同时成立。
   */
  app.config.errorHandler = (err) => {
    const message = err instanceof Error ? err.message : String(err)
    failure = { code: 'mountThrew', message }
    console.error('[StructureRenderer] mount:', err)
    // 占位**不在** errorHandler 里直接画：它可能在 `app.mount()` 的容器清空之前被调用，
    // 那样刚画的占位会被随后的挂载流程抹掉（实测会得到"报了失败但看不见"）。
    // ⇒ 由 `app.mount()` 之后统一渲染（见下方）。
  }

  const disposeFitHost = ensureMobileFitHost(mountEl)
  if (import.meta.env.DEV) initEmbedTouchSim(mountEl)

  let mounted = true
  let unmounted = false

  try {
    app.mount(mountEl)
  } catch (e) {
    // 同步抛错（极少见：mount 内部的异常通常已被 errorHandler 收口）——
    // 同样落占位，不把异常抛给页面。
    const message = e instanceof Error ? e.message : String(e)
    failure = { code: 'mountThrew', message }
    console.error('[StructureRenderer] mount:', e)
  }
  // 挂载流程结束后**统一**落占位：此时容器内容已定，占位不会被后续步骤抹掉。
  if (failure !== null) renderFailurePlaceholder(mountEl, failure)

  return {
    instanceId,
    get mounted() { return mounted && failure === null },
    get failure() { return failure },
    update(next: EmbedBootstrapOptions): void {
      if (unmounted) return
      props.bootstrap = next
    },
    unmount(): void {
      if (unmounted) return
      unmounted = true
      try {
        app.unmount()
      } catch (e) {
        // 卸载失败不得让宿主拿到一个"看起来销毁了"的假象：报出来，但继续清理。
        console.error('[StructureRenderer] unmount:', e)
      }
      disposeFitHost()
      // 容器回到"没有嵌入"的基线：**不**留占位、不留组件产出的 DOM。
      mountEl.replaceChildren()
      mounted = false
    },
  }
}
