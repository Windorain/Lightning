import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout } from '../types/layout'

export const wikiConfigPanel: PanelDeclaration = {
  id: 'wiki-config-panel',
  label: '嵌入视口设置',
  spaceType: SpaceType.PREFERENCES,
  regionType: RegionType.MAIN,

  poll(): boolean { return true },
  owner(ctx: BContext): unknown { return ctx.wikiConfig },
  layout(_ctx: BContext): UILayout {
    return {
      kind: 'column', align: false, items: [
        { kind: 'label', text: '视口尺寸' },
        { kind: 'property', rnaPath: 'wikiconfig.viewWidth', label: '宽' },
        { kind: 'property', rnaPath: 'wikiconfig.viewHeight', label: '高' },
        { kind: 'separator' },

        { kind: 'label', text: '功能开关' },
        { kind: 'property', rnaPath: 'wikiconfig.showStats', label: '方块统计栏' },
        { kind: 'property', rnaPath: 'wikiconfig.showLayerBar', label: '分层预览条' },
        { kind: 'property', rnaPath: 'wikiconfig.showFrameControls', label: '帧控制' },
        { kind: 'property', rnaPath: 'wikiconfig.showTitle', label: '标题栏' },
        { kind: 'property', rnaPath: 'wikiconfig.showDebugStatus', label: '调试状态栏' },
        { kind: 'property', rnaPath: 'wikiconfig.showAxesGizmo', label: '坐标轴' },
        { kind: 'separator' },

        { kind: 'label', text: '图标设置' },
        { kind: 'property', rnaPath: 'wikiconfig.iconSizePx', label: '图标尺寸 (px)' },
        { kind: 'property', rnaPath: 'wikiconfig.iconOrthoHalf', label: '图标正交半尺寸' },
        { kind: 'separator' },

        { kind: 'label', text: '初始摄像头' },
        { kind: 'property', rnaPath: 'wikiconfig.cameraYaw', label: '偏航角 (°)' },
        { kind: 'property', rnaPath: 'wikiconfig.cameraElevation', label: '俯仰角 (°)' },
        { kind: 'property', rnaPath: 'wikiconfig.cameraZoom', label: '缩放' },
        { kind: 'separator' },

        { kind: 'label', text: '外观' },
        { kind: 'property', rnaPath: 'wikiconfig.sceneBackgroundHex', label: '背景色' },
      ],
    }
  },
}
