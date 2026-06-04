import type { Context } from '@/runtime/context'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '@/runtime/screenTypes'
import type { UILayout, UIOperator, UILabel, UISeparator } from '../types/layout'
import { t } from '@/config/i18n'
import { isWikiHostProfile } from '@/runtime/hostProfile'
import { isWikiApiAvailable } from '@/wiki/mwApiAdapter'

export const menuBarPanel: PanelDeclaration = {
  id: 'menu-bar',
  label: '菜单栏',
  spaceType: SpaceType.VIEW_3D,
  regionType: RegionType.HEADER,

  poll(): boolean { return true },

  layout(ctx: Context): UILayout {
    const lang = ctx.getShellSettings().lang.value
    const conn = ctx.getConnection().connected
    const wikiHost = isWikiHostProfile()
    const wikiUi = ctx.wm.chrome.wikiUi
    const wikiFileOps = wikiHost && (wikiUi?.mwReady.value ?? isWikiApiAvailable())

    const fileItems: (UIOperator | UILabel | UISeparator)[] = [
      { kind: 'operator', id: 'OPERATOR_NEW_SCENE', label: t('newFile') },
      { kind: 'operator', id: 'OPERATOR_OPEN_SCENE', label: t('openScene') },
    ]
    if (wikiFileOps) {
      fileItems.push(
        { kind: 'separator' },
        { kind: 'operator', id: 'OPERATOR_WIKI_PICK_AND_LOAD', label: t('loadFromWiki') },
        { kind: 'operator', id: 'OPERATOR_WIKI_SAVE_CONFIRM', label: t('saveToWiki') },
        { kind: 'operator', id: 'OPERATOR_WIKI_SAVE_AS', label: t('wikiSaveAs') },
      )
    } else if (!wikiHost) {
      fileItems.push(
        { kind: 'separator' },
        { kind: 'operator', id: 'OPERATOR_SAVE_FILE', label: t('saveToFile') },
      )
    }

    return {
      kind: 'row',
      align: false,
      items: [
        // File menu
        {
          kind: 'menu',
          label: t('file'),
          items: fileItems,
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
        // 连接状态（Wiki 状态见 MenubarWikiStatus 组件）
        ...(wikiHost
          ? []
          : [
              {
                kind: 'label' as const,
                text: conn ? t('connected') : t('offline'),
              },
            ]),
      ],
    }
  },
}
