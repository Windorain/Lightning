import type { Context } from '@/runtime/context'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '@/runtime/screenTypes'
import type { UILayout, UIOperator, UILabel, UISeparator } from '../types/layout'
import { CAPABILITY } from '@/composition/modules'
import { isWikiApiAvailable } from '@/wiki/mwApiAdapter'

export const menuBarPanel: PanelDeclaration = {
  id: 'menu-bar',
  label: '菜单栏',
  spaceType: SpaceType.VIEW_3D,
  regionType: RegionType.HEADER,

  poll(): boolean { return true },

  layout(ctx: Context): UILayout {
    // 本实例的翻译（#259 A33）：标签在每次 layout() 求值时按**本实例**语言生成，
    // 语言变化会让面板重算 —— 不再经模块级 activeLang 影响别的实例。
    const t = ctx.t
    const lang = ctx.getShellSettings().lang.value
    const conn = ctx.getConnection().connected
    // B5 #7：旧实现是 `const wikiHost = isWikiHostProfile()`（模块级宿主反查）。
    // 现在问能力 —— "这个外壳是否有 Wiki 上传面"决定菜单项，而不是"宿主叫什么"。
    const wikiHost = ctx.hasCapability(CAPABILITY.WIKI_UPLOAD)
    const wikiUi = ctx.wm.chrome.wikiUi
    const wikiFileOps = wikiHost && (wikiUi?.mwReady.value ?? isWikiApiAvailable())

    const fileItems: (UIOperator | UILabel | UISeparator)[] = [
      { kind: 'operator', id: 'OPERATOR_NEW_SCENE', label: t('newFile') },
      { kind: 'operator', id: 'OPERATOR_OPEN_SCENE', label: t('openScene') },
      // R1-α（#387）：工程格式的生产开/存入口。
      // `poll` 让"打开工程"永远可用、"保存工程"只在**内核装配成功**时可用
      // （工程格式编码的是内核文档 —— 未装配时没有可编码的权威，
      // 让菜单项可点会在点击后静默失败）。
      { kind: 'operator', id: 'OPERATOR_OPEN_PROJECT', label: t('openProject') },
      { kind: 'operator', id: 'OPERATOR_SAVE_PROJECT', label: t('saveProject') },
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
            // #282 P10b：Area 布局编辑命令**真实可达**（此前只有装配声明与纯域实现，
            // 全树零入口）。`poll` 读"是否有 Area 会话"（装配结果）⇒ 嵌入外壳
            // （固定布局）里这些项**灰显**，且原因是装配层的，不是"UI 藏了按钮"。
            { kind: 'operator', id: 'OPERATOR_AREA_SPLIT', label: lang === 'zh' ? '水平分割区域' : 'Split Area Horizontally', props: { direction: 'horizontal' } },
            { kind: 'operator', id: 'OPERATOR_AREA_SPLIT', label: lang === 'zh' ? '垂直分割区域' : 'Split Area Vertically', props: { direction: 'vertical' } },
            { kind: 'operator', id: 'OPERATOR_AREA_MERGE', label: lang === 'zh' ? '合并区域' : 'Merge Area' },
            { kind: 'separator' },
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
