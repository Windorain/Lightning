/**
 * 本地 / Playwright：模拟 Wiki 窄列 + 模板 800×600。
 * 场景：e2e/fixtures/structuredata-exported-envelope.json（来自桌面导出信封包）
 */
import { mount } from '@/embed/mount'
import { initEmbedTouchSim, isTouchSimActive } from '@/embed/touchPointer'

const el = document.querySelector('.web-structure-renderer')
if (!el) {
  throw new Error('e2e: missing .web-structure-renderer')
}

function showTouchSimBanner(): void {
  initEmbedTouchSim(el)
  if (!isTouchSimActive()) return
  const bar = document.createElement('div')
  bar.id = 'wsr-touch-sim-banner'
  bar.textContent =
    '触控模拟：Alt+左键拖=旋转 · Alt+Shift+左键拖=缩放+平移（上下捏合、左右平移）'
  Object.assign(bar.style, {
    position: 'fixed',
    left: '0',
    right: '0',
    bottom: '0',
    zIndex: '99999',
    padding: '8px 12px',
    fontSize: '12px',
    lineHeight: '1.4',
    color: '#e2e8f0',
    background: 'rgba(15,23,42,0.92)',
    fontFamily: 'system-ui,sans-serif',
  })
  document.body.appendChild(bar)
}

async function boot(): Promise<void> {
  showTouchSimBanner()
  const res = await fetch('/e2e/fixtures/structuredata-exported-envelope.json')
  if (!res.ok) {
    throw new Error(`加载场景失败: ${res.status} ${res.statusText}`)
  }
  const document = await res.json()

  mount(el, {
    data: { document },
    features: {
      titleBar: true,
      blockStatsSidebar: true,
      layerBar: true,
      frameControls: false,
      debugStatusBar: false,
      showAxesGizmo: false,
    },
    ui: {
      sceneBackground: 0x0f172a,
    },
  })
}

void boot().catch((e) => {
  console.error('[e2e-embed-mobile]', e)
  el.textContent = e instanceof Error ? e.message : String(e)
})
