import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import MaterialGallery from './MaterialGallery.vue'

export const materialGalleryPanel: PanelDeclaration = {
  id: 'material-gallery',
  label: '材质画廊',
  icon: '\u{1F3A8}',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,

  poll(ctx: BContext): boolean {
    const doc = ctx.scene.scene.value
    if (!doc) return false
    const palette = doc.materialPalette as unknown[] | undefined
    return (palette?.length ?? 0) > 0
  },

  layout(_ctx: BContext) {
    // Fallback layout — component takes precedence
    return { kind: 'column', align: false, items: [{ kind: 'label' as const, text: '材质画廊' }] }
  },

  component: MaterialGallery,
}
