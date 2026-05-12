import type { Tool } from '@/workbench/toolRegistry'
import type { ThreeToolContext } from './_base'

export const annotationTool: Tool = {
  id: 'annotation',
  label: 'Annotate',
  icon: '▢',
  cursor: 'crosshair',

  onPointerDown(ctx: ThreeToolContext, event: PointerEvent): void {
    const picked = ctx.pickVoxel(event)
    if (!picked) return
    ctx._annotStart = picked.pos
    ctx._annotating = true
  },

  onPointerMove(ctx: ThreeToolContext, event: PointerEvent): void {
    if (!ctx._annotating) return
    const picked = ctx.pickVoxel(event)
    if (!picked) return
    ctx._annotEnd = picked.pos
  },

  renderOverlay(ctx: ThreeToolContext): void {
    if (!ctx._annotating || !ctx._annotStart) {
      ctx._annotPreview = null
      return
    }
    const end = ctx._annotEnd ?? ctx._annotStart
    const min = {
      x: Math.min(ctx._annotStart.x, end.x),
      y: Math.min(ctx._annotStart.y, end.y),
      z: Math.min(ctx._annotStart.z, end.z),
    }
    const max = {
      x: Math.max(ctx._annotStart.x, end.x),
      y: Math.max(ctx._annotStart.y, end.y),
      z: Math.max(ctx._annotStart.z, end.z),
    }
    ctx._annotPreview = { min, max }
  },

  onPointerUp(ctx: ThreeToolContext, _event: PointerEvent): void {
    if (!ctx._annotating || !ctx._annotStart) return
    const end = ctx._annotEnd ?? ctx._annotStart
    const min = {
      x: Math.min(ctx._annotStart.x, end.x),
      y: Math.min(ctx._annotStart.y, end.y),
      z: Math.min(ctx._annotStart.z, end.z),
    }
    const max = {
      x: Math.max(ctx._annotStart.x, end.x),
      y: Math.max(ctx._annotStart.y, end.y),
      z: Math.max(ctx._annotStart.z, end.z),
    }
    ctx.executeCreateAnnotation({ min, max })
    ctx._annotating = false
    ctx._annotStart = null
    ctx._annotEnd = null
  },
}
