import { ref, computed } from 'vue'

const _highlightedBlockTypes = ref<Set<string>>(new Set())
const _pinnedBlockTypes = ref<Set<string>>(new Set())

export interface PanelState {
  /** Hover-highlighted block types (temporary, cleared on mouse leave) */
  readonly highlightedBlockTypes: ReadonlySet<string>
  /** Click-pinned block types (persistent until unpinned) */
  readonly pinnedBlockTypes: ReadonlySet<string>
  /** Combined set for viewport overlay rendering (union of hover + pinned) */
  readonly activeBlockTypes: ReadonlySet<string>
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
    highlightedBlockTypes: _highlightedBlockTypes.value as ReadonlySet<string>,
    pinnedBlockTypes: _pinnedBlockTypes.value as ReadonlySet<string>,
    activeBlockTypes: activeBlockTypes.value as ReadonlySet<string>,
    highlightType,
    clearHighlight,
    pinType,
    unpinType,
    clearPins,
  }
}
