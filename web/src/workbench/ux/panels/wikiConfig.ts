import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout } from '../types/layout'

export const wikiConfigPanel: PanelDeclaration = {
  id: 'wiki-config-panel',
  label: 'Wiki 配置',
  spaceType: SpaceType.PREFERENCES,
  regionType: RegionType.MAIN,

  poll(): boolean { return true },

  layout(_ctx: BContext): UILayout {
    return {
      kind: 'column', align: false, items: [
        { kind: 'label', text: '视口尺寸' },
        { kind: 'property', rnaPath: 'wikiconfig.viewWidth', label: '宽' },
        { kind: 'property', rnaPath: 'wikiconfig.viewHeight', label: '高' },
        { kind: 'separator' },
        { kind: 'label', text: '初始摄像头' },
        { kind: 'property', rnaPath: 'wikiconfig.cameraYaw', label: '偏航角' },
        { kind: 'property', rnaPath: 'wikiconfig.cameraElevation', label: '俯仰角' },
        { kind: 'property', rnaPath: 'wikiconfig.cameraZoom', label: '缩放' },
      ],
    }
  },
}
