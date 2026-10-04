/**
 * B-1 部件级描边 mask —— e2e 公开观测原语（issue #34）。
 *
 * 观测面：`window.__vm__` → 视口 `outlinePass`（`drw.outlinePass`，经
 * `useViewportRuntime` 暴露；`SelectionOutlinePass.maskScene` 是其公开字段）
 * ⇒ 读出**真正喂给 Sobel 的 mask 几何**（`setMaskMeshes` 的产物），不做替身。
 *
 * 坐标口径：mask 的世界顶点 - 格世界角 = 格内局部坐标（与 `PartRecord.boxes` 同空间，
 * 契约 §6.1）。格世界角与网格生成偏移互逆（`structureGeometryUVs.ts` L31–34）。
 */

import { type Page } from '@playwright/test'
import { WIKI_REGION } from './hover'

/** 一个 mask mesh 的顶点摘要（世界坐标下的 AABB + 顶点数） */
export interface OutlineMaskSummary {
  meshCount: number
  vertexCount: number
  min: [number, number, number]
  max: [number, number, number]
}

/** 读当前 outline mask（`outlinePass.maskScene` 内 mesh 的 position AABB）。 */
export async function readOutlineMask(page: Page): Promise<OutlineMaskSummary> {
  return await page.evaluate((rid) => {
    const slot = (window as any).__vm__?.viewports?.get(rid)
    const pass = slot?.outlinePass ?? null
    const scene = pass?.maskScene ?? null
    const meshes = scene ? (scene.children ?? []).filter((o: any) => o?.isMesh) : []
    let vertexCount = 0
    const min: [number, number, number] = [Infinity, Infinity, Infinity]
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
    for (const m of meshes) {
      const attr = m.geometry?.getAttribute?.('position')
      if (!attr) continue
      for (let i = 0; i < attr.count; i++) {
        vertexCount++
        const p = [attr.getX(i), attr.getY(i), attr.getZ(i)]
        for (let a = 0; a < 3; a++) {
          if (p[a] < min[a]) min[a] = p[a]
          if (p[a] > max[a]) max[a] = p[a]
        }
      }
    }
    return { meshCount: meshes.length, vertexCount, min, max }
  }, WIKI_REGION)
}

/** mask AABB（世界）→ 格内局部 AABB（减去该格世界角）。 */
export function maskLocalAabb(
  mask: OutlineMaskSummary,
  cell: { col: number; row: number; z: number },
  size: { w: number; h: number; d: number },
): { min: [number, number, number]; max: [number, number, number] } | null {
  if (mask.vertexCount === 0) return null
  const worldY = size.h - 1 - cell.row
  const ox = cell.col - size.w / 2
  const oy = worldY - size.h / 2
  const oz = cell.z - size.d / 2
  const r = (v: number): number => Math.round(v * 10000) / 10000
  return {
    min: [r(mask.min[0] - ox), r(mask.min[1] - oy), r(mask.min[2] - oz)],
    max: [r(mask.max[0] - ox), r(mask.max[1] - oy), r(mask.max[2] - oz)],
  }
}

/** 读注入文档的网格尺寸（cellGrid 行列层）。 */
export async function readGridSize(page: Page): Promise<{ w: number; h: number; d: number }> {
  return await page.evaluate((rid) => {
    const g = (window as any).__vm__?.viewports?.get(rid)?.definition?.value?.cellGrid as number[][][] | undefined
    if (!g) return { w: 0, h: 0, d: 0 }
    return { d: g.length, h: g[0]!.length, w: g[0]![0]!.length }
  }, WIKI_REGION)
}
