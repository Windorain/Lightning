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
      // 本实例的翻译：标签在每次 layout() 求值时按**本实例**语言生成，
    // 语言变化会让面板重算 —— 不再经模块级 activeLang 影响别的实例。
    const t = ctx.t
    const lang = ctx.getShellSettings().lang.value
    const conn = ctx.getConnection().connected
      // 旧实现是 `const wikiHost = isWikiHostProfile()`（模块级宿主反查）。
    // 现在问能力 —— "这个外壳是否有 Wiki 上传面"决定菜单项，而不是"宿主叫什么"。
    const wikiHost = ctx.hasCapability(CAPABILITY.WIKI_UPLOAD)
    const wikiUi = ctx.wm.chrome.wikiUi
    const wikiFileOps = wikiHost && (wikiUi?.mwReady.value ?? isWikiApiAvailable())

      // 文件菜单按 Blender 式分组定序 ——
    //   [新建] ─ [打开场景… / 打开工程…] ─ [保存工程 / 保存到文件]
    // 只加分隔符与顺序；**项文案与 operator id 一字未改**（8 份 saveReopen 判据按文案定位）。
    // wiki 宿主的追加逻辑（含其前置分隔符）保持原样：那是另一条文档来源的分组。
    const fileItems: (UIOperator | UILabel | UISeparator)[] = [
      { kind: 'operator', id: 'OPERATOR_NEW_SCENE', label: t('newFile') },
      { kind: 'separator' },
      { kind: 'operator', id: 'OPERATOR_OPEN_SCENE', label: t('openScene') },
        // 工程格式的生产开/存入口。
      // `poll` 让"打开工程"永远可用、"保存工程"只在**内核装配成功**时可用
      // （工程格式编码的是内核文档 —— 未装配时没有可编码的权威，
      // 让菜单项可点会在点击后静默失败）。
      { kind: 'operator', id: 'OPERATOR_OPEN_PROJECT', label: t('openProject') },
      { kind: 'separator' },
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
              // 撤销/重做接到**既有** operator（注册表里两者都有，
            // `poll` 读内核撤销读面 `ctx.kernelUndoState()` —— 没有可撤销项时
            // invoke 会被 poll 拒绝为 CANCELLED，不静默改文档）。
            // 键位提示写**实际绑定**：`workbench/inputHotkeys` 是 Ctrl+Z / Ctrl+Shift+Z。
            { kind: 'operator', id: 'OPERATOR_UNDO', label: t('undo') },
            { kind: 'operator', id: 'OPERATOR_REDO', label: t('redo') },
            { kind: 'separator' },
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
              // Area 布局编辑命令**真实可达**（此前只有装配声明与纯域实现，
            // 全树零入口）。`poll` 读"是否有 Area 会话"（装配结果）⇒ 嵌入外壳
            // （固定布局）里这些项**灰显**，且原因是装配层的，不是"UI 藏了按钮"。
            { kind: 'operator', id: 'OPERATOR_AREA_SPLIT', label: lang === 'zh' ? '水平分割区域' : 'Split Area Horizontally', props: { direction: 'horizontal' } },
            { kind: 'operator', id: 'OPERATOR_AREA_SPLIT', label: lang === 'zh' ? '垂直分割区域' : 'Split Area Vertically', props: { direction: 'vertical' } },
            { kind: 'operator', id: 'OPERATOR_AREA_MERGE', label: lang === 'zh' ? '合并区域' : 'Merge Area' },
            { kind: 'separator' },
            { kind: 'operator', id: 'OPERATOR_RESET_LAYOUT', label: t('resetLayout') },
              // 主题切换从顶栏右侧的独立 ☀ 项挪进视图菜单尾（菜单正式化）。
            // 只换**呈现位置**：operator id / 行为 / 持久化一律不变。
            { kind: 'separator' },
            { kind: 'operator', id: 'OPERATOR_TOGGLE_THEME', label: t('toggleTheme'), icon: '☀' },
          ],
        },
        // Help — disabled label, no dropdown
        { kind: 'label', text: t('help') },
        // Spacer — pushes right-side items to the end via UI flex styles
        { kind: 'label', text: '' },
        // 连接状态（Wiki 状态见 MenubarWikiStatus 组件）
          // 顶栏右侧不再渲染主题项（已挪进视图菜单尾）。
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
