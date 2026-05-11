// web/src/workbench/composables/useSnapping.ts
import { ref } from 'vue'

const snapEnabled = ref(true)

export function useSnapping() {
  function toggleSnap(): void { snapEnabled.value = !snapEnabled.value }
  return { snapEnabled, toggleSnap }
}
