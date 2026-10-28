/**
 * 嵌入**同页多实例**的测试页引导（测试专用，不属于产品构建）。
 *
 * 职责只有三条，全部是"宿主页本来就要做的事"：
 *  1. 取仓库夹具（与 `embed-mobile.spec.ts` 同一份游戏内导出信封）；
 *  2. 按**宿主参数**（主题 / 特性开关 / 文档）调用生产 `mount()`；
 *  3. 暴露少量的宿主侧操作（新开容器、**显式销毁**），供 e2e 驱动"重挂载 / 卸载"。
 *
 * 它**不** import 任何内部装配模块、不建替身宿主：
 * 挂载路径与 Wiki 真实嵌入完全相同（`@/embed/mount` → `EmbedRoot` → `EmbedViewport`）。
 *
 * ## `mount()` 现在返回寿命句柄，本页把它留下来
 *
 * 旧实现里这里只能"新建容器再 mount 一次"来模拟重挂载（生产 `mount()` 返回 `void`，
 * 旧的 D8 形态）。现在补了 `EmbedSession`（`{ instanceId, mounted, failure, update, unmount }`），
 * 于是本页可以做真实宿主会做的事：**记住句柄、需要时 unmount**。
 * GE-1..GE-3 的既有用例语义不变（它们只关心"再挂一个实例"）。
 */

import { mount, type EmbedSession } from '@/embed/mount'
import type { View3DFeatures } from '@/viewer/viewerConfig'

const FIXTURE_URL = '/e2e/fixtures/structuredata-exported-envelope.json'
/**
 * 第二份**不同内容**的夹具（日志隔离判据用）。
 *
 * 两份文档的资源条数不同 ⇒ 每个实例写进自己 `liveStatus` 的
 * `纹理就绪 N/N` 必然不同。共享日志槽时两实例会读到**同一个** N
 * （最后写者胜），按实例隔离时各读各的。
 */
const MINIMAL_FIXTURE_URL = '/e2e/fixtures/minimal-v2.json'

interface MountSpec {
  /** 挂载点选择器（宿主页给的容器）。 */
  selector: string
  /** 宿主显式指定的主题（进实例设置，不写全局）。 */
  theme?: 'dark' | 'light'
  /** 宿主声明的特性开关（呈现裁剪的宿主输入）。 */
  features?: Partial<View3DFeatures>
  /**
   * `'fixture'` = 正常信封；`'broken'` = 无效文档（用于失败隔离判据）；
   * `'minimal'` = 另一份内容不同的文档（用于日志/liveStatus 的实例隔离判据）。
   */
  data?: 'fixture' | 'broken' | 'minimal'
  /** 调试状态栏（`features.debugStatusBar` **且** `ui.debug` 才显示，见 EmbedViewport）。 */
  debug?: boolean
}

let fixtureDocument: unknown = null
let minimalDocument: unknown = null

async function loadFixture(): Promise<unknown> {
  if (fixtureDocument !== null) return fixtureDocument
  const res = await fetch(FIXTURE_URL)
  if (!res.ok) throw new Error('fixture load failed: ' + res.status)
  fixtureDocument = await res.json()
  return fixtureDocument
}

async function loadMinimal(): Promise<unknown> {
  if (minimalDocument !== null) return minimalDocument
  const res = await fetch(MINIMAL_FIXTURE_URL)
  if (!res.ok) throw new Error('minimal fixture load failed: ' + res.status)
  minimalDocument = await res.json()
  return minimalDocument
}

/** 宿主页保存的寿命句柄（键 = 选择器），供 `unmount(selector)` 使用。 */
const sessions = new Map<string, EmbedSession>()

/**
 * 纯宿主动作：往一个容器挂一个嵌入实例（与 Wiki 页面调用 `mount` 完全同路）。
 *
 * 选择器**原样**交给生产 `mount()`（字符串形态）：缺容器时的失败面
 * （warn + `failure.noMountPoint`）因此走的是产品自己的那条路径，
 * 而不是本页先替它判掉 —— 否则失败面判据测的是夹具而不是产品。
 */
async function mountSession(spec: MountSpec): Promise<EmbedSession | null> {
  if (spec.data === 'broken') {
    const session = mount(spec.selector, {
      data: { document: { notADocument: true } },
      features: { titleBar: true, blockStatsSidebar: false, layerBar: false, frameControls: false },
      ui: { sceneBackground: 0x0f172a, ...(spec.theme ? { theme: spec.theme } : {}) },
    })
    sessions.set(spec.selector, session)
    return session
  }
  // ⚠️ 变量名不得叫 document：本函数上方用全局 document 取挂载点（TDZ 会炸）
  const doc = spec.data === 'minimal' ? await loadMinimal() : await loadFixture()
  const session = mount(spec.selector, {
    data: { document: doc },
    features: {
      titleBar: true,
      blockStatsSidebar: false,
      layerBar: spec.features?.layerBar ?? false,
      frameControls: spec.features?.frameControls ?? false,
      debugStatusBar: spec.features?.debugStatusBar ?? false,
      showAxesGizmo: false,
    },
    ui: {
      sceneBackground: 0x0f172a,
      ...(spec.theme ? { theme: spec.theme } : {}),
      ...(spec.debug ? { debug: true } : {}),
    },
  })
  sessions.set(spec.selector, session)
  return session
}

/** GE 组沿用的布尔形态（"这次挂载真的发生了吗" = `session.mounted`）。 */
async function mountOne(spec: MountSpec): Promise<boolean> {
  return (await mountSession(spec))?.mounted ?? false
}

/**
 * 宿主侧的"重新挂载"：**新建**一个容器再 `mount` 一次。
 *
 * 这正是 Wiki 模板重复嵌入（同页第二个渲染器）的真实形态；
 * 旧实例是否仍在跑由判据暴露 —— 本函数不替它假装已被销毁。
 */
async function remountInNewSlot(spec: Omit<MountSpec, 'selector'> & { id: string }): Promise<boolean> {
  const host = document.querySelector('#remount-slot')
  if (!host) return false
  const el = document.createElement('div')
  el.id = spec.id
  el.className = 'web-structure-renderer'
  Object.assign(el.style, { width: '600px', height: '560px', background: '#0f172a' })
  host.appendChild(el)
  return await mountOne({ ...spec, selector: '#' + spec.id })
}

;(window as any).__embedDual__ = {
  mountOne,
  remountInNewSlot,
  ready: false,
  /** 挂载并返回本次句柄的身份/成败（G7 用；不改变 `mountOne` 语义）。 */
  mountTracked: async (spec: MountSpec) => {
    const session = await mountSession(spec)
    // `ok` = "真的挂上了"（`session.mounted`）；失败会话仍然带回身份与结构化原因。
    return {
      ok: session?.mounted ?? false,
      instanceId: session?.instanceId ?? null,
      mounted: session?.mounted ?? false,
      failure: session?.failure ?? null,
    }
  },
  /** 显式销毁某一次挂载（**真实调用**生产 `session.unmount()`）。 */
  unmount: (selector: string): boolean => {
    const s = sessions.get(selector)
    if (s === undefined) return false
    s.unmount()
    sessions.delete(selector)
    return true
  },
  /** 换内容（同一实例；验证 update 不新建实例）。 */
  update: (selector: string, spec: Omit<MountSpec, 'selector'>): Promise<boolean> => {
    const s = sessions.get(selector)
    if (s === undefined) return Promise.resolve(false)
    return (async () => {
      const doc = spec.data === 'minimal' ? await loadMinimal() : await loadFixture()
      s.update({
        data: { document: doc },
        features: { titleBar: true, blockStatsSidebar: false, layerBar: false, frameControls: false },
        ui: { sceneBackground: 0x0f172a },
      })
      return true
    })()
  },
  /**
   * **裸**生产入口（失败面判据用）：把 `mount()` 原样透出，宿主可自己构造坏 bootstrap。
   *
   * 这不是"替身宿主"：它调用的就是产品 `mount()`，只是不经过本页的夹具封装，
   * 于是"库在坏输入下怎么表现"可以被直接观测。
   */
  mountRaw: (el: Element, options: unknown) => {
    const session = mount(el, options as Parameters<typeof mount>[1])
    return { instanceId: session.instanceId, mounted: session.mounted, failure: session.failure }
  },
  /** 只读：本页仍持有句柄的选择器。 */
  sessionSelectors: () => [...sessions.keys()],
}

async function boot(): Promise<void> {
  // 两个实例：A = 深色 + 层栏 + 调试状态栏；B = 浅色 + 无层栏、无状态栏
  //（宿主参数不同 ⇒ 呈现裁剪与状态栏都按**实例**生效，这是隔离判据的观测面）
  await mountOne({ selector: '#embed-a', theme: 'dark', features: { layerBar: true, debugStatusBar: true }, debug: true })
  await mountOne({ selector: '#embed-b', theme: 'light', features: { layerBar: false } })
  ;(window as any).__embedDual__.ready = true
}

void boot().catch((e) => {
  console.error('[e2e-embed-dual]', e)
  const el = document.querySelector('#embed-a')
  if (el) el.textContent = e instanceof Error ? e.message : String(e)
})