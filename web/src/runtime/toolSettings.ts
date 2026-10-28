import { ref } from 'vue'
import type { ToolSettings } from '@/runtime/contextAccess'

export function createToolSettings(overrides?: {
  confirmDirty?: (message: string) => boolean
}): ToolSettings {
  return {
    replaceBrush: ref<string | null>(null),
    fillBrush: ref<string | null>(null),
    generateType: ref<string | null>(null),
    snapEnabled: ref(false),
    dragSensitivity: 0.05,
    confirmDirty: overrides?.confirmDirty ?? ((msg: string) => window.confirm(msg)),
  }
}
