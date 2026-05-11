import { ref } from 'vue'
import type { Tool } from '@/workbench/toolRegistry'
import type { ThreeToolContext } from './_base'

const generateType = ref<string | null>(null)

export function getGenerateType(): string | null { return generateType.value }
export function setGenerateType(id: string | null): void { generateType.value = id }

export const FLOOR_TEMPLATES = [
  { id: 'floor_solid_white', label: '白色地板', color: '#ffffff' },
  { id: 'floor_solid_gray', label: '灰色地板', color: '#808080' },
  { id: 'floor_solid_black', label: '黑色地板', color: '#222222' },
  { id: 'floor_checker', label: '棋盘格', color: '#ffffff/#000000' },
  { id: 'floor_ruler', label: '坐标标尺', color: '#ff4444' },
] as const

export const generateTool: Tool = {
  id: 'generate',
  label: 'Generate',
  icon: '◆',
  cursor: 'crosshair',
  defaultKey: 'Shift+a',

  onPointerUp(ctx: ThreeToolContext, event: PointerEvent): void {
    const type = generateType.value
    if (!type) return
    const picked = ctx.pickVoxel(event)
    const pos = picked?.pos ?? { x: 0, y: 0, z: 0 }
    ctx.executeGenerate(type, pos)
  },
}
