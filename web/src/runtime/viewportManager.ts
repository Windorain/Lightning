import { computed, ref, shallowRef } from 'vue'
import type { ViewportSlot } from '@/runtime/types'
import { cameraMainKeyForRegion } from '@/runtime/mainCameras'

export function createViewportManager() {
  const slots = new Map<string, ViewportSlot>()
  const activeId = ref<string | null>(null)
  const active = computed(() => {
    const id = activeId.value
    return id ? (slots.get(id) ?? null) : null
  })

  return {
    register(id: string): ViewportSlot {
      if (slots.has(id)) return slots.get(id)!
      const slot: ViewportSlot = {
        id,
        camera: ref(null),
        contentGroup: shallowRef(null),
        domElement: ref(null),
        definition: shallowRef(null),
        layerPreview: ref(null),
        gizmo: shallowRef(null),
        overlayGroup: ref(null),
        toolsOverlayGroup: shallowRef(null),
        worldAnnotationGroup: shallowRef(null),
        wireframe: shallowRef(null),
        orbitTarget: ref(null),
        cameraMainKey: cameraMainKeyForRegion(id),
      }
      slots.set(id, slot)
      if (!activeId.value) activeId.value = id
      return slot
    },
    unregister(id: string): void {
      slots.delete(id)
      if (activeId.value === id) {
        activeId.value = slots.keys().next().value ?? null
      }
    },
    get(id: string): ViewportSlot | undefined {
      return slots.get(id)
    },
    forEach(fn: (slot: ViewportSlot) => void): void {
      for (const slot of slots.values()) fn(slot)
    },
    resetAllViewportCameras(mainCameras: Record<string, import('vue').Ref<import('@/runtime/viewportCamera').ViewportCameraState | null>>): void {
      for (const slot of slots.values()) mainCameras[slot.cameraMainKey].value = null
    },
    activeId,
    active,
  }
}

export type ViewportManager = ReturnType<typeof createViewportManager>
