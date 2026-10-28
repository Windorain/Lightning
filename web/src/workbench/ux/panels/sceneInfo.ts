/**
 * **场景信息**面板 —— 生成式属性面板。
 *
 * 旧版本手写 7 条 `kind: 'property'`（`scenemetadata.*`），每条都要有人记得加进这个
 * 布局函数 —— 「新加属性忘了加进面板 ⇒ 属性静默消失」正是「死属性」记录过的
 * 死属性成因（11/50 条登记属性没有 UI 入口）。新形态：属性由
 * `lightning.sceneMetadata` 声明生成，布局规格只决定**分节与顺序**，
 * 漏配的行会被自动补齐并在 `generatedRows` 里标记出来。
 */

import type { Context } from '@/runtime/context'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '@/runtime/screenTypes'
import type { UILayout } from '../types/layout'
import PropertyInspector from '../PropertyInspector.vue'

export const sceneInfoPanel: PanelDeclaration = {
  id: 'scene-info-panel',
  label: '场景信息',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,
  workspaces: ['preview', 'wiki'],

  poll(): boolean {
    return true
  },

  component: PropertyInspector,

  layout(_ctx: Context): UILayout {
    // 属性行由 `PropertyInspector` 生成；本面板没有额外诊断片段。
    return { kind: 'column', align: false, items: [] }
  },
}
