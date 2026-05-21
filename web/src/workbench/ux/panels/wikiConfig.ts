import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout } from '../types/layout'

export const wikiConfigPanel: PanelDeclaration = {
  id: 'wiki-config-panel',
  label: '嵌入配置',
  spaceType: SpaceType.PREFERENCES,
  regionType: RegionType.MAIN,

  poll(): boolean { return true },
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
          kind: 'box', label: '初始相机', items: [
            { kind: 'property', rnaPath: 'wikiconfig.cameraYaw', label: '偏航角 (Yaw)' },
            { kind: 'property', rnaPath: 'wikiconfig.cameraElevation', label: '仰角 (Elev.)' },
            { kind: 'property', rnaPath: 'wikiconfig.cameraZoom', label: '缩放 (Zoom)' },
          ],
        },
      ],
    }
  },
}
