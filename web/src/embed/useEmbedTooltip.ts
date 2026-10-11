/**
 * useEmbedTooltip — 嵌入视口的工具提示解析 composable。
 *
 * 消费 region.state.hover 导出的 hover 联合类型，结合场景数据计算出最终的
 * tooltipText / neiTooltipMap / metaTooltipText / showMetaHint。
 *
 * ── 侧栏文案的两条键通道（B-4 / Gitea #37，契约 §2.2）──────────────────
 *
 * 侧栏 `tooltip-hover` 的 payload 是**行身份键**，两条路径各行一套键：
 *  - **物品行**（B-3 后左栏唯一形态，`StatsRow.key`）= **物品身份键** `registry:damage[#nbt]`
 *    ⇒ 查**物品索引表** `itemIndex`（文档根级，B-2 落盘；`@/pure/itemIndex` 的 `buildItemHitIndex`）。
 *    这是 #5 §8 缺口②的根治：物品键**不查** `neiTooltipMap`（它的键是 block_registry 键，
 *    必然不中，旧实现因此回退成 `"0"`）。
 *  - **旧文件宿主行**（无部件文档的退化路径）= 宿主 blockId ⇒ 仍查 `neiTooltipMap`（既有语义不变）。
 *
 * 两键**恒不混用**（`registry:damage` vs `registryId[@meta]` 拼写不同；即便巧合同形，
 * 物品索引表也**优先**——单一数据源 = `itemIndex`）。两条都不中 ⇒ 返回行键本身（旧实现的
 * "取最后一个冒号之后"会给出 `"0"` 这类无意义片段，已废弃）。空说明兜底由 `itemIndex` 保证
 * （`tooltip` 空 ⇒ 至少 `display` 一行），本层不把它掏空。
 */
import { computed, type Ref, type ShallowRef } from 'vue'
import type { EmbedHover } from '@/runtime/hover'
import type { StructureDefinition } from '@/render/schema/types'
import { blockRegistryKeyForPalette } from '@/render/data/blockRegistryResolve'
import { buildItemHitIndex } from '@/pure/itemIndex'
import { resolvePreviewTooltipText, resolveViewportTooltipChain } from '@/pure/tooltipResolution'
import { readSceneMetaField } from '@/render/data/compactSceneDocument'

export function useEmbedTooltip(deps: {
  hoverRef: Ref<EmbedHover | null>
  definitionRef: ShallowRef<StructureDefinition | null>
  tooltipPaletteRef: Ref<readonly string[]>
  showHoverTooltipRef: Ref<boolean>
  docRef: Ref<{ serialize(): unknown } | null>
}) {
  /** NEI tooltip map from block palette — keyed by blockId. */
  const neiTooltipMap = computed<Map<string, string[]>>(() => {
    const def = deps.definitionRef.value
    if (!def) return new Map()
    const map = new Map<string, string[]>()
    for (const e of def.blockPalette) {
      const key = blockRegistryKeyForPalette(e.registryId, e.meta)
      if (!map.has(key) && e.tooltip && e.tooltip.length > 0) {
        map.set(key, e.tooltip)
      }
    }
    return map
  })

  /**
   * 物品索引反查表（键 = 物品身份键）：单一数据源 = 渲染定义根的文档根级 `itemIndex`。
   * 缺省/旧文件 ⇒ 空表（零差异）；不补 extraKeys（本层不猜行键集）。
   */
  const itemHitIndex = computed(() => buildItemHitIndex(deps.definitionRef.value))

  /** Meta tooltip text (author / version). */
  const metaTooltipText = computed(() => {
    const d = deps.docRef.value
    if (!d) return ''
    const plain = d.serialize()
    const rows: string[] = []
    const pick = (label: string, key: string) => {
      const v = readSceneMetaField(plain, key).trim()
      if (v) rows.push(`${label}：${v}`)
    }
    pick('作者', 'author')
    pick('版本号', 'gtnhVersion')
    return rows.join('\n')
  })

  /** Whether the meta hint icon should be shown. */
  const showMetaHint = computed(() => metaTooltipText.value.length > 0)

  /**
   * 侧栏行键 → 说明行（两条键通道的**唯一**汇合点，见文件头）：
   *  ① 物品身份键 → `itemIndex`（B-4 新增；空 ⇒ ②）；
   *  ② 宿主 blockId → `neiTooltipMap`（既有语义，宿主行/旧文件）；
   *  ③ 都不中 ⇒ `[]`（调用方退回行键本身，绝不产出 `"0"` 这类片段）。
   */
  function resolveSidebarLines(rowKey: string): string[] {
    if (!rowKey) return []
    const item = itemHitIndex.value.get(rowKey)
    if (item && item.tooltip.length > 0) return item.tooltip
    const nei = neiTooltipMap.value.get(rowKey)
    if (nei && nei.length > 0) return nei
    return []
  }

  /** Unified tooltip text for the current hover state. */
  const tooltipText = computed(() => {
    const h = deps.hoverRef.value
    if (!h) return ''

    switch (h.kind) {
      case 'block': {
        // Viewport: gated by showHoverTooltip setting
        if (h.source === 'viewport' && !deps.showHoverTooltipRef.value) return ''
        // Resolve viewport tooltip
        if (h.source === 'viewport') {
          const def = deps.definitionRef.value
          if (!def) return ''
          const ht = { blockId: h.blockId, clientX: h.clientX, clientY: h.clientY, source: 'viewport' as const, voxel: h.voxel }
          const cellText = resolvePreviewTooltipText(def, deps.tooltipPaletteRef.value, ht)
          // 优先级链（契约 §8 末段 + P2.2）：逐格人工说明（叠加层）→ 部件说明 → 宿主 NEI 回退
          return resolveViewportTooltipChain({
            cellText,
            part: h.part ?? null,
            hostNeiLines: neiTooltipMap.value.get(h.blockId),
          })
        }
        // Sidebar: 物品身份键先查物品索引表（B-4），宿主键回退 NEI（旧文件宿主行语义不变）
        //
        // 这里返回**原始文本行**（以 `\n` 连接），不再返回 HTML 串：
        // 旧实现是 `itemLines.map(renderTooltipHtml).join('\n')`，把格式解析
        // 提前到解析层并与「该显示哪几行」这个领域问题混在一起。
        // 现在呈现格式由受控边界（`editors/ContentText.vue`，逐行模式）统一决定（#259 A32）。
        const itemLines = resolveSidebarLines(h.blockId)
        if (itemLines.length > 0) return itemLines.join('\n')
        return h.blockId
      }

      case 'annotation': {
        const doc = deps.docRef.value
        if (!doc) return ''
        const plain = doc.serialize() as Record<string, any>
        const annos = plain.annotations as Array<{ id: string; description?: string }> | undefined
        const anno = annos?.find((a: { id: string }) => a.id === h.annotationId)
        if (!anno) return ''
        return anno.description || ''
      }

      case 'meta': {
        return metaTooltipText.value
      }

      default:
        return ''
    }
  })

  return { tooltipText, neiTooltipMap, metaTooltipText, showMetaHint }
}
