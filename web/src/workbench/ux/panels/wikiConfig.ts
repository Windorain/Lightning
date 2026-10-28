/**
 * **嵌入配置**面板 —— 生成式属性面板。
 *
 * 旧版本手写 9 条 `kind: 'property'`（`wikiconfig.*`），并额外手写一条**具名命令**
 * 「同步预览视角到文档」。新形态分得清楚：
 *  - 9 条属性由 `lightning.publishConfig` 声明生成（写路径按键值注册，**不靠前缀分派**）；
 *  - 具名命令仍是具名命令（`OPERATOR_SYNC_EMBED_INITIAL_VIEW`）—— 它不是字段写入，
 *    所以留在诊断/命令片段里，由 `ReadonlyLayout` 渲染（该渲染器没有属性分支）。
 */

import type { Context } from '@/runtime/context'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '@/runtime/screenTypes'
import type { UILayout } from '../types/layout'
import PropertyInspector from '../PropertyInspector.vue'

export const wikiConfigPanel: PanelDeclaration = {
  id: 'wiki-config-panel',
  label: '嵌入配置',
  spaceType: SpaceType.PROPERTIES,
  regionType: RegionType.MAIN,
  workspaces: ['wiki'],

  poll(): boolean {
    return true
  },

  component: PropertyInspector,

  /**
   * 具名命令片段（**不是**属性写路径）。
   *
   * `PropertyInspector` 只渲染属性；命令按钮由面板容器另行渲染同一 `layout()`
   * （`PanelTabs` 对 `component` 面板同时渲染命令片段），因此这里保留一条具名命令。
   */
  layout(_ctx: Context): UILayout {
    return {
      kind: 'column',
      align: false,
      items: [
        { kind: 'separator' },
        {
          kind: 'box',
          label: '嵌入初始视角',
          items: [{ kind: 'operator', id: 'OPERATOR_SYNC_EMBED_INITIAL_VIEW', label: '同步预览视角到文档' }],
        },
      ],
    }
  },
}
