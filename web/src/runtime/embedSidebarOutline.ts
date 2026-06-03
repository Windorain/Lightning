import type { ShallowRef } from 'vue'
import type { StructureDefinition } from '@/render/schema/types'
import {
  buildOutlineMasksForRegistryId,
  disposeOutlineMaskMeshes,
} from '@/render/mesh/blockRegistryOutlineMasks'

/** Embed 侧栏 blockId 选中 → DRW extraMaskMeshes */
export function createEmbedSidebarOutlineMasks(deps: {
  definitionRef: ShallowRef<StructureDefinition | null>
  masksRef: ShallowRef<import('three').Mesh[]>
}) {
  function rebuildSelectionMasks(blockId: string | null): void {
    disposeOutlineMaskMeshes(deps.masksRef.value)
    const def = deps.definitionRef.value
    deps.masksRef.value = blockId && def ? buildOutlineMasksForRegistryId(def, blockId) : []
  }
  return { rebuildSelectionMasks }
}
