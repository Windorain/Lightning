/**
 * useEmbedTooltip — 嵌入视口的工具提示解析 composable。
 *
 * 消费 useEmbedHover() 产出的 hover 状态，结合场景数据计算出最终的
 * tooltipText / neiTooltipMap / metaTooltipText / showMetaHint。
 */
import { computed, type Ref, type ShallowRef } from 'vue'
import type { EmbedHover } from '@/embed/embedHover'
import type { StructureDefinition } from '@/render/schema/types'
import { blockRegistryKeyForPalette } from '@/render/data/blockRegistryResolve'
import { resolvePreviewTooltipText } from '@/pure/tooltipResolution'
import { renderTooltipHtml } from '@/pure/renderTooltipHtml'
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
          const resolved = resolvePreviewTooltipText(def, deps.tooltipPaletteRef.value, ht)
          if (resolved) {
            const neiLines = neiTooltipMap.value.get(h.blockId)
            const nameLine = neiLines?.[0]
            if (nameLine) {
              const nl = resolved.indexOf('\n')
              const resolvedFirst = nl >= 0 ? resolved.slice(0, nl) : resolved
              if (resolvedFirst !== nameLine) {
                return nameLine + '\n' + resolved
              }
            }
            return resolved
          }
          // Fallback: first line of NEI tooltip from block palette
          const lines = neiTooltipMap.value.get(h.blockId)
          if (lines && lines.length > 0) return renderTooltipHtml(lines[0])
          return ''
        }
        // Sidebar: NEI tooltip
        const lines = neiTooltipMap.value.get(h.blockId)
        if (lines && lines.length > 0) return lines.map(l => renderTooltipHtml(l)).join('\n')
        const colon = h.blockId.lastIndexOf(':')
        return colon >= 0 ? h.blockId.slice(colon + 1) : h.blockId
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
