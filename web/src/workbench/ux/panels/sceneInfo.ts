import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout } from '../types/layout'

export const sceneInfoPanel: PanelDeclaration = {
  id: 'scene-info-panel',
  label: '场景信息',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,

  poll(): boolean { return true },

  layout(_ctx: BContext): UILayout {
    return {
      kind: 'column', align: false, items: [
        { kind: 'box', label: '元数据', items: [
          { kind: 'property', rnaPath: 'scenemetadata.name', label: '名称' },
          { kind: 'property', rnaPath: 'scenemetadata.author', label: '作者' },
          { kind: 'property', rnaPath: 'scenemetadata.description', label: '描述', widget: 'text' },
        ]},
        { kind: 'separator' },
        { kind: 'operator', id: 'OPERATOR_SCENE_META_EDIT', label: '保存' },
      ],
    }
  },
}
