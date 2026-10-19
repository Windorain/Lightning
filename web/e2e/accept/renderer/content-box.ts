import * as THREE from 'three'

/**
 * 呈现根的内容包围盒（**内核局部坐标**）。
 *
 * 用途：把「世界坐标」换算到「Web 图像像素」需要一个平移量；
 * 该平移量 = 世界内容中心 − 局部内容中心，由本函数给出局部那一半。
 * 不猜、不硬编码：盒子来自实际渲染出来的对象。
 */
export function contentBoxLocal(): { min: [number, number, number]; max: [number, number, number] } | null {
  const ctx = (window as unknown as { __vm__?: Record<string, any> }).__vm__
  const slots = ctx?.viewports
  if (slots === undefined) return null
  const candidates: any[] = []
  const active = slots.active?.value
  if (active) candidates.push(active)
  for (const id of ['r-viewport', 'r-wiki-preview', 'r-workbench-viewport', 'r-embed']) {
    const s = slots.get?.(id)
    if (s) candidates.push(s)
  }
  const hit = candidates.find((s) => s?.presenterSurface?.object3d != null)
  const root = hit?.presenterSurface?.object3d
  if (!root) return null
  root.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(root)
  if (box.isEmpty()) return null
  return { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] }
}
