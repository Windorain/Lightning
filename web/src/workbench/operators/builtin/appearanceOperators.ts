import type { OperatorType } from '@/workbench/operators/operatorType'
import { toggleTheme } from '@/workbench/composables/useNeiTheme'
import { setLang } from '@/workbench/i18n'

export const ThemeToggleOperator: OperatorType = {
  id: 'OPERATOR_TOGGLE_THEME',
  label: '切换主题',
  description: '在暗色/亮色主题间切换',

  poll(_bctx) { return true },

  exec(_bctx) {
    toggleTheme()
  },
}

export const SetLanguageOperator: OperatorType = {
  id: 'OPERATOR_SET_LANGUAGE',
  label: '设置语言',
  description: '设置界面语言（zh/en）',

  poll(_bctx) { return true },

  exec(_bctx, props) {
    const lang = props.lang as 'zh' | 'en'
    if (lang !== 'zh' && lang !== 'en') return
    setLang(lang)
  },
}
