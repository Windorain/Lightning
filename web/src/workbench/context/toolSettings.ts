import { ref } from 'vue'
import type { BContextSettings } from '@/workbench/context/bContext'
import { currentLang } from '@/workbench/i18n'
import { theme } from '@/workbench/composables/useNeiTheme'

export const FLOOR_TEMPLATES = [
  { id: 'floor_stone', label: 'Stone Floor', color: '#808080' },
  { id: 'floor_wood', label: 'Wood Floor', color: '#8B6914' },
  { id: 'floor_checker', label: 'Checker Floor', color: '#ccc/#666' },
  { id: 'floor_sandstone', label: 'Sandstone Floor', color: '#D4B896' },
  { id: 'floor_glass', label: 'Glass Floor', color: '#88ccff' },
]

export function createBContextSettings(overrides?: {
  theme?: 'dark' | 'light'
  language?: 'zh' | 'en'
  confirmDirty?: (msg: string) => boolean
}): BContextSettings {
  const replaceBrush = ref<string | null>(null)
  const fillBrush = ref<string | null>(null)
  const generateType = ref<string | null>(null)
  const snapEnabled = ref<boolean>(false)

  return {
    get replaceBrush(): string | null { return replaceBrush.value },
    set replaceBrush(v: string | null) { replaceBrush.value = v },
    get fillBrush(): string | null { return fillBrush.value ?? replaceBrush.value },
    set fillBrush(v: string | null) { fillBrush.value = v },
    get generateType(): string | null { return generateType.value },
    set generateType(v: string | null) { generateType.value = v },
    dragSensitivity: 0.05,
    get snapEnabled(): boolean { return snapEnabled.value },
    set snapEnabled(v: boolean) { snapEnabled.value = v },
    confirmDirty: overrides?.confirmDirty ?? ((msg: string) => window.confirm(msg)),
    get theme(): 'dark' | 'light' {
      if (overrides?.theme) return overrides.theme
      return theme.value
    },
    get language(): 'zh' | 'en' {
      if (overrides?.language) return overrides.language
      return currentLang.value
    },
  }
}
