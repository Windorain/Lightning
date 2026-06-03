import { onUnmounted } from 'vue'

/**
 * Minimal material info needed to drive animated-texture playback.
 */
export interface AnimationMaterialInfo {
  dataUrl: string | null
  kind: string
  animation?: { defaultFrametimeTicks?: number } | null
}

/**
 * Composable that manages animated-material canvas rendering.
 *
 * Accepts a resolver function so the caller can look up material data
 * however they store it (ref, store, etc.). Returns `setCanvasRef` for
 * use in Vue template `:ref` bindings.
 */
export function useMaterialAnimation(
  getMaterial: (id: string) => AnimationMaterialInfo | undefined,
) {
  const animationRefs = new Map<string, HTMLCanvasElement>()
  const animationHandles = new Map<string, number>()

  function setCanvasRef(el: unknown, materialId: string) {
    const canvas = el as HTMLCanvasElement | null
    if (canvas) {
      animationRefs.set(materialId, canvas)
      startAnimation(materialId)
    } else {
      stopAnimation(materialId)
      animationRefs.delete(materialId)
    }
  }

  function startAnimation(id: string) {
    const lookupId = id.endsWith('-detail') ? id.slice(0, -7) : id
    const card = getMaterial(lookupId)
    if (!card?.dataUrl || card.kind !== 'animated') return

    const img = new Image()
    img.src = card.dataUrl
    img.onload = () => {
      const canvas = animationRefs.get(id)
      if (!canvas) return

      const frameSize = img.width
      const frameCount = Math.floor(img.height / frameSize)
      if (frameCount <= 1) return

      canvas.width = frameSize
      canvas.height = frameSize
      const ctx = canvas.getContext('2d')!
      ctx.imageSmoothingEnabled = false

      const frameTime = card.animation?.defaultFrametimeTicks ?? 1
      const tickMs = Math.max(frameTime * 50, 80)
      let currentFrame = 0
      let lastTime = performance.now()
      let elapsed = 0

      function step(now: number) {
        const delta = now - lastTime
        lastTime = now
        elapsed += delta
        while (elapsed >= tickMs && tickMs > 0) {
          elapsed -= tickMs
          currentFrame = (currentFrame + 1) % frameCount
        }
        ctx.clearRect(0, 0, frameSize, frameSize)
        ctx.drawImage(
          img,
          0, currentFrame * frameSize, frameSize, frameSize,
          0, 0, frameSize, frameSize,
        )
        animationHandles.set(id, requestAnimationFrame(step))
      }
      ctx.drawImage(img, 0, 0, frameSize, frameSize, 0, 0, frameSize, frameSize)
      animationHandles.set(id, requestAnimationFrame(step))
    }
  }

  function stopAnimation(id: string) {
    const handle = animationHandles.get(id)
    if (handle !== undefined) {
      cancelAnimationFrame(handle)
      animationHandles.delete(id)
    }
  }

  onUnmounted(() => {
    for (const handle of animationHandles.values()) {
      cancelAnimationFrame(handle)
    }
  })

  return { setCanvasRef }
}
