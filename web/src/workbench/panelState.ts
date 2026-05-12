import { ref, computed, type ComputedRef } from 'vue'

const _highlightedBlockTypes = ref<Set<string>>(new Set())
const _pinnedBlockTypes = ref<Set<string>>(new Set())

export interface PanelState {
  /** Hover-highlighted block types (temporary, cleared on mouse leave) */
  readonly highlightedBlockTypes: ComputedRef<ReadonlySet<string>>
  /** Click-pinned block types (persistent until unpinned) */
  readonly pinnedBlockTypes: ComputedRef<ReadonlySet<string>>
  /** Combined set for viewport overlay rendering (union of hover + pinned) */
  readonly activeBlockTypes: ComputedRef<ReadonlySet<string>>
  highlightType(blockStateId: string): void
  clearHighlight(): void
  pinType(blockStateId: string): void
  unpinType(blockStateId: string): void
  clearPins(): void
}

function setUnion(a: Set<string>, b: Set<string>): Set<string> {
  const s = new Set(a)
  for (const v of b) s.add(v)
  return s
}

const highlightedBlockTypes = computed<ReadonlySet<string>>(() => _highlightedBlockTypes.value)
const pinnedBlockTypes = computed<ReadonlySet<string>>(() => _pinnedBlockTypes.value)
const activeBlockTypes = computed<ReadonlySet<string>>(() =>
  setUnion(_highlightedBlockTypes.value, _pinnedBlockTypes.value)
)

export function usePanelState(): PanelState {
  function highlightType(id: string): void {
    _highlightedBlockTypes.value = new Set([id])
  }

  function clearHighlight(): void {
    _highlightedBlockTypes.value = new Set()
  }

  function pinType(id: string): void {
    const s = new Set(_pinnedBlockTypes.value)
    if (s.has(id)) { s.delete(id) } else { s.add(id) }
    _pinnedBlockTypes.value = s
  }

  function unpinType(id: string): void {
    const s = new Set(_pinnedBlockTypes.value)
    s.delete(id)
    _pinnedBlockTypes.value = s
  }

  function clearPins(): void {
    _pinnedBlockTypes.value = new Set()
  }

  return {
    highlightedBlockTypes,
    pinnedBlockTypes,
    activeBlockTypes,
    highlightType,
    clearHighlight,
    pinType,
    unpinType,
    clearPins,
  }
}
