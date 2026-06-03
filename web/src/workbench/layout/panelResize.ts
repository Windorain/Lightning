/**
 * 可拖拽分隔线：CSS Grid 列宽拖动。左右面板均可拖拽调整宽度，
 * 宽度持久化到 localStorage；Workbench 写入 ScreenRoot.layout。
 */
import { onUnmounted, ref, type Ref } from 'vue'
import type { Context } from '@/runtime/context'

import { readPersistedPanelWidths, writePersistedPanelWidth } from './panelLayoutStorage'

const MIN_LEFT = 48
const MIN_RIGHT = 200

export interface PanelResizeState {
  leftWidth: Ref<number>
  rightWidth: Ref<number>
  startLeftDrag: (e: PointerEvent) => void
  startRightDrag: (e: PointerEvent) => void
  dragging: Ref<boolean>
}

/** @param ctx Workbench 时绑定 ScreenRoot.layout；省略则仅本地 ref（测试/孤立） */
export function usePanelResize(ctx?: Context): PanelResizeState {
  const screen = ctx?.getScreenRoot()
  const fallback = readPersistedPanelWidths()
  const leftWidth = screen?.layout.leftWidth ?? ref(fallback.leftWidth)
  const rightWidth = screen?.layout.rightWidth ?? ref(fallback.rightWidth)
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
    if (activeDrag === 'left') writePersistedPanelWidth('left', leftWidth.value)
    else writePersistedPanelWidth('right', rightWidth.value)
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
