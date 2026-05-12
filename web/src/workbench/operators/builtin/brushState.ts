/**
 * Shared brush state — 操作符间共享的笔刷状态。
 * 对标 Blender 的 ToolSettings（场景级画笔设置）。
 * replaceOperator 和 fillOperator 共享 brushType，
 * eyedropperOperator 设置它。
 */
import { ref } from 'vue'

const brushType = ref<string | null>(null)
const fillType = ref<string | null>(null)

export function getReplaceBrush(): string | null { return brushType.value }
export function setReplaceBrush(id: string | null): void { brushType.value = id }
export function getFillBrush(): string | null { return fillType.value ?? brushType.value }
export function setFillBrush(id: string | null): void { fillType.value = id }
