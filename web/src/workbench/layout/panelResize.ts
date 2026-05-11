/**
 * 可拖拽分隔线：CSS Grid 列宽拖动。左右面板均可拖拽调整宽度，
 * 宽度持久化到 localStorage。
 */
import { onUnmounted, ref, type Ref } from 'vue'

const LS_KEY_LEFT = 'wsr-wb-left-w'
const LS_KEY_RIGHT = 'wsr-wb-right-w'
const DEFAULT_LEFT = 220
const DEFAULT_RIGHT = 300
const MIN_LEFT = 48
const MIN_RIGHT = 200

function readPersisted(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem(key)
    if (v !== null) {
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) return n
    }
  } catch { /* noop */ }
  return fallback
}

function writePersisted(key: string, val: number): void {
  try { localStorage.setItem(key, String(Math.round(val))) } catch { /* noop */ }
}

export interface PanelResizeState {
  leftWidth: Ref<number>
  rightWidth: Ref<number>
  startLeftDrag: (e: PointerEvent) => void
  startRightDrag: (e: PointerEvent) => void
  dragging: Ref<boolean>
}

export function usePanelResize(): PanelResizeState {
  const leftWidth = ref(readPersisted(LS_KEY_LEFT, DEFAULT_LEFT))
  const rightWidth = ref(readPersisted(LS_KEY_RIGHT, DEFAULT_RIGHT))
  const dragging = ref(false)

  let activeDrag: 'left' | 'right' | null = null
  let startX = 0
  let startW = 0

  function onMove(e: PointerEvent): void {
    if (!activeDrag) return
    const dx = e.clientX - startX
    if (activeDrag === 'left') {
      const w = Math.max(MIN_LEFT, startW + dx)
      leftWidth.value = w
    } else {
      const w = Math.max(MIN_RIGHT, startW - dx)
      rightWidth.value = w
    }
  }

  function onUp(): void {
    if (!activeDrag) return
    if (activeDrag === 'left') writePersisted(LS_KEY_LEFT, leftWidth.value)
    else writePersisted(LS_KEY_RIGHT, rightWidth.value)
    activeDrag = null
    dragging.value = false
    document.removeEventListener('pointermove', onMove)
    document.removeEventListener('pointerup', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  function beginDrag(side: 'left' | 'right', e: PointerEvent): void {
    activeDrag = side
    startX = e.clientX
    startW = side === 'left' ? leftWidth.value : rightWidth.value
    dragging.value = true
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  onUnmounted(() => {
    document.removeEventListener('pointermove', onMove)
    document.removeEventListener('pointerup', onUp)
  })

  return {
    leftWidth,
    rightWidth,
    startLeftDrag: (e: PointerEvent) => beginDrag('left', e),
    startRightDrag: (e: PointerEvent) => beginDrag('right', e),
    dragging,
  }
}
