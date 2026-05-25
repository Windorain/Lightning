import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout } from '../types/layout'

export const wikiConfigPanel: PanelDeclaration = {
  id: 'wiki-config-panel',
  label: '嵌入配置',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,

  poll(ctx: BContext): boolean { return ctx.uiWorkspace.value === 'wiki' },
  owner(ctx: BContext): unknown { return ctx.wikiConfig },
  layout(_ctx: BContext): UILayout {
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
          kind: 'box', label: '初始相机', items: [
            { kind: 'property', rnaPath: 'wikiconfig.cameraYaw', label: '偏航角 (°)' },
            { kind: 'property', rnaPath: 'wikiconfig.cameraElevation', label: '仰角 (°)' },
            { kind: 'property', rnaPath: 'wikiconfig.cameraZoom', label: '缩放' },
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
