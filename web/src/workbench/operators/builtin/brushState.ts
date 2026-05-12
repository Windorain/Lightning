/**
 * Shared brush state — 操作符间共享的笔刷状态。
 * 对标 Blender 的 ToolSettings（场景级画笔设置）。
 * replaceOperator 和 fillOperator 共享 brushType，
 * eyedropperOperator 设置它。
 */
import { ref } from 'vue'

const brushType = ref<string | null>(null)
const fillType = ref<string | null>(null)
const generateType = ref<string | null>(null)

export function getReplaceBrush(): string | null { return brushType.value }
export function setReplaceBrush(id: string | null): void { brushType.value = id }
export function getFillBrush(): string | null { return fillType.value ?? brushType.value }
export function setFillBrush(id: string | null): void { fillType.value = id }
export function getGenerateType(): string | null { return generateType.value }
export function setGenerateType(id: string | null): void { generateType.value = id }

export const FLOOR_TEMPLATES = [
  { id: 'floor_stone', label: 'Stone Floor', color: '#808080' },
  { id: 'floor_wood', label: 'Wood Floor', color: '#8B6914' },
  { id: 'floor_checker', label: 'Checker Floor', color: '#ccc/#666' },
  { id: 'floor_sandstone', label: 'Sandstone Floor', color: '#D4B896' },
  { id: 'floor_glass', label: 'Glass Floor', color: '#88ccff' },
]
