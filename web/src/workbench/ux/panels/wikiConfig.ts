import type { Context } from '@/runtime/context'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '@/runtime/screenTypes'
import type { UILayout } from '../types/layout'

export const wikiConfigPanel: PanelDeclaration = {
  id: 'wiki-config-panel',
  label: '嵌入配置',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,
  workspaces: ['wiki'],

  poll(): boolean { return true },
  owner(ctx: Context): unknown { return { main: ctx.main } },
  layout(_ctx: Context): UILayout {
    return {
      kind: 'column', align: false, items: [
        {
          kind: 'box', label: '视口尺寸', items: [
            { kind: 'property', rnaPath: 'wikiconfig.viewWidth', label: '宽度' },
            { kind: 'property', rnaPath: 'wikiconfig.viewHeight', label: '高度' },
          ],
        },
        { kind: 'separator' },
        {
          kind: 'box', label: '功能开关', items: [
            { kind: 'property', rnaPath: 'wikiconfig.showStats', label: '方块统计栏' },
            { kind: 'property', rnaPath: 'wikiconfig.showLayerBar', label: '分层预览条' },
            { kind: 'property', rnaPath: 'wikiconfig.showFrameControls', label: '帧控制' },
            { kind: 'property', rnaPath: 'wikiconfig.showTitle', label: '标题栏' },
            { kind: 'property', rnaPath: 'wikiconfig.showDebugStatus', label: '调试状态栏' },
            { kind: 'property', rnaPath: 'wikiconfig.showAxesGizmo', label: '坐标轴' },
          ],
        },
        { kind: 'separator' },
        {
          kind: 'box', label: '嵌入初始视角', items: [
            { kind: 'operator', id: 'OPERATOR_SYNC_EMBED_INITIAL_VIEW', label: '同步预览视角到文档' },
          ],
        },
        { kind: 'separator' },
        {
          kind: 'box', label: '外观', items: [
            { kind: 'property', rnaPath: 'wikiconfig.sceneBackgroundHex', label: '背景色' },
          ],
        },
      ],
    }
  },
}
