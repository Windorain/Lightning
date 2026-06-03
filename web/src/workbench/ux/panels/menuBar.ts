import type { Context } from '@/runtime/context'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '@/runtime/screenTypes'
import type { UILayout } from '../types/layout'
import { t } from '@/config/i18n'

export const menuBarPanel: PanelDeclaration = {
  id: 'menu-bar',
  label: '菜单栏',
  spaceType: SpaceType.VIEW_3D,
  regionType: RegionType.HEADER,

  poll(): boolean { return true },

  layout(ctx: Context): UILayout {
    const lang = ctx.getShellSettings().lang.value
    const conn = ctx.getConnection().connected

    return {
      kind: 'row',
      align: false,
      items: [
        // File menu
        {
          kind: 'menu',
          label: t('file'),
          items: [
            { kind: 'operator', id: 'OPERATOR_NEW_SCENE', label: t('newFile') },
            { kind: 'operator', id: 'OPERATOR_OPEN_SCENE', label: t('openScene') },
            { kind: 'separator' },
            { kind: 'operator', id: 'OPERATOR_SAVE_FILE', label: t('saveToFile') },
          ],
        },
        // Edit menu
        {
          kind: 'menu',
          label: t('edit'),
          items: [
            { kind: 'label', text: t('language') },
            {
              kind: 'operator', id: 'OPERATOR_SET_LANGUAGE',
              label: t('chinese'),
              props: { lang: 'zh' },
            },
            {
              kind: 'operator', id: 'OPERATOR_SET_LANGUAGE',
              label: t('english'),
              props: { lang: 'en' },
            },
          ],
        },
        // View menu
        {
          kind: 'menu',
          label: t('view'),
          items: [
            { kind: 'operator', id: 'OPERATOR_RESET_LAYOUT', label: t('resetLayout') },
          ],
        },
        // Help — disabled label, no dropdown
        { kind: 'label', text: t('help') },
        // Spacer — pushes right-side items to the end via UI flex styles
        { kind: 'label', text: '' },
        // Theme toggle
        {
          kind: 'operator',
          id: 'OPERATOR_TOGGLE_THEME',
          label: '☀',
          title: lang === 'zh' ? '切换主题' : 'Toggle Theme',
        },
        // Connection status
        {
          kind: 'label',
          text: conn ? t('connected') : t('offline'),
        },
      ],
    }
  },
}
