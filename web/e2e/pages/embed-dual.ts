/**
 * M7-1 · 嵌入同页双实例的**测试页引导**（测试专用，不属于产品构建）。
 *
 * 职责只有三条，全部是"宿主页本来就要做的事"：
 *  1. 取仓库夹具（与 `embed-mobile.spec.ts` 同一份游戏内导出信封）；
 *  2. 按**宿主参数**（主题 / 特性开关 / 文档）调用生产 `mount()`；
 *  3. 暴露少量的宿主侧操作（给第二个容器重新 `mount` 一次），供 e2e 驱动"重挂载"。
 *
 * 它**不** import 任何内部装配模块、不建替身宿主、不改 `src/`：
 * 挂载路径与 Wiki 真实嵌入完全相同（`@/embed/mount` → `EmbedRoot` → `EmbedViewport`）。
 *
 * ## 为什么"重挂载"由宿主页来做
 *
 * 生产 `mount()` 返回 `void`（`src/embed/mount.ts:19-27`，S0-B D8 / G7 登记为缺口），
 * 宿主**拿不到**销毁句柄 —— M7-6 才补。故本页用宿主可用的最小手段模拟"同一页面
 * 重新挂载一个嵌入"：新建容器并再次调用 `mount()`。这正是 Wiki 模板重复嵌入时的
 * 真实形态（同页第二个渲染器），也是判据要覆盖的形态。
 */

import { mount } from '@/embed/mount'
import type { View3DFeatures } from '@/viewer/viewerConfig'

const FIXTURE_URL = '/e2e/fixtures/structuredata-exported-envelope.json'

interface MountSpec {
  /** 挂载点选择器（宿主页给的容器）。 */
  selector: string
  /** 宿主显式指定的主题（进实例设置，不写全局）。 */
  theme?: 'dark' | 'light'
  /** 宿主声明的特性开关（呈现裁剪的宿主输入）。 */
  features?: Partial<View3DFeatures>
  /** `'fixture'` = 正常信封；`'broken'` = 无效文档（用于失败隔离判据）。 */
  data?: 'fixture' | 'broken'
  /** 调试状态栏（`features.debugStatusBar` **且** `ui.debug` 才显示，见 EmbedViewport）。 */
  debug?: boolean
}

let fixtureDocument: unknown = null

async function loadFixture(): Promise<unknown> {
  if (fixtureDocument !== null) return fixtureDocument
  const res = await fetch(FIXTURE_URL)
  if (!res.ok) throw new Error('fixture load failed: ' + res.status)
  fixtureDocument = await res.json()
  return fixtureDocument
}

/** 纯宿主动作：往一个容器挂一个嵌入实例（与 Wiki 页面调用 `mount` 完全同路）。 */
async function mountOne(spec: MountSpec): Promise<boolean> {
  const el = document.querySelector(spec.selector)
  if (!el) return false
  if (spec.data === 'broken') {
    mount(el, {
      data: { document: { notADocument: true } },
      features: { titleBar: true, blockStatsSidebar: false, layerBar: false, frameControls: false },
      ui: { sceneBackground: 0x0f172a, ...(spec.theme ? { theme: spec.theme } : {}) },
    })
    return true
  }
  // ⚠️ 变量名不得叫 document：本函数上方用全局 document 取挂载点（TDZ 会炸）
  const doc = await loadFixture()
  mount(el, {
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
  return true
}

/**
 * 宿主侧的"重新挂载"：**新建**一个容器再 `mount` 一次（旧容器可先由测试移除）。
 *
 * 这与产品缺口一致（无 unmount 句柄），故本函数只做"新开一个实例"，
 * 不假装旧实例已被销毁 —— 旧实例是否仍在跑由判据来暴露。
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

;(window as any).__embedDual__ = { mountOne, remountInNewSlot, ready: false }

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
