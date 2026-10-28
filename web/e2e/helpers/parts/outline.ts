/**
 * B-1 部件级描边 mask —— e2e 公开观测原语。
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

/** 单个 mask mesh 的顶点摘要（世界坐标 AABB + 顶点数；用于逐 mesh 双射断言）。 */
export interface OutlineMaskMeshSummary {
  /** maskScene 内的 mesh 下标（只作日志/定位，不承诺稳定顺序）。 */
  meshIndex: number
  vertexCount: number
  min: [number, number, number]
  max: [number, number, number]
}

/**
 * 逐 mesh 读当前 outline mask 的世界 AABB。
 *
 * 与 `readOutlineMask` 的区别：后者把全部 mesh 合成一个总 AABB（只能证明"总量"），
 * 本函数保留每个 mesh 的独立包围盒，供"多归属 → 多个 mask"的一一匹配/双射断言。
 * 顶点经 mesh 的 `matrixWorld` 变换后再求 AABB：mask 几何若挂在非零变换的 mesh 上，
 * 也不会把局部坐标误当世界坐标。
 */
export async function readOutlineMaskMeshes(page: Page): Promise<OutlineMaskMeshSummary[]> {
  return await page.evaluate((rid) => {
    const slot = (window as any).__vm__?.viewports?.get(rid)
    const pass = slot?.outlinePass ?? null
    const scene = pass?.maskScene ?? null
    const meshes = scene ? (scene.children ?? []).filter((o: any) => o?.isMesh) : []
    return meshes.map((m: any, meshIndex: number) => {
      m.updateWorldMatrix?.(true, false)
      const e = m.matrixWorld?.elements as number[] | undefined
      const attr = m.geometry?.getAttribute?.('position')
      let vertexCount = 0
      const min: [number, number, number] = [Infinity, Infinity, Infinity]
      const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
      if (attr) {
        for (let i = 0; i < attr.count; i++) {
          const x = attr.getX(i)
          const y = attr.getY(i)
          const z = attr.getZ(i)
          const p = e
            ? [
                e[0]! * x + e[4]! * y + e[8]! * z + e[12]!,
                e[1]! * x + e[5]! * y + e[9]! * z + e[13]!,
                e[2]! * x + e[6]! * y + e[10]! * z + e[14]!,
              ]
            : [x, y, z]
          vertexCount++
          for (let a = 0; a < 3; a++) {
            if (p[a]! < min[a]!) min[a] = p[a]!
            if (p[a]! > max[a]!) max[a] = p[a]!
          }
        }
      }
      return { meshIndex, vertexCount, min, max }
    })
  }, WIKI_REGION)
}

/** 世界 AABB → 格内局部 AABB（减去该格世界角）；无顶点 ⇒ null。 */
function localAabbOf(
  bounds: { vertexCount: number; min: [number, number, number]; max: [number, number, number] },
  cell: { col: number; row: number; z: number },
  size: { w: number; h: number; d: number },
): { min: [number, number, number]; max: [number, number, number] } | null {
  if (bounds.vertexCount === 0) return null
  const worldY = size.h - 1 - cell.row
  const ox = cell.col - size.w / 2
  const oy = worldY - size.h / 2
  const oz = cell.z - size.d / 2
  const r = (v: number): number => Math.round(v * 10000) / 10000
  return {
    min: [r(bounds.min[0] - ox), r(bounds.min[1] - oy), r(bounds.min[2] - oz)],
    max: [r(bounds.max[0] - ox), r(bounds.max[1] - oy), r(bounds.max[2] - oz)],
  }
}

/** mask AABB（世界）→ 格内局部 AABB（减去该格世界角）。 */
export function maskLocalAabb(
  mask: OutlineMaskSummary,
  cell: { col: number; row: number; z: number },
  size: { w: number; h: number; d: number },
): { min: [number, number, number]; max: [number, number, number] } | null {
  return localAabbOf(mask, cell, size)
}

/** 单个 mesh 的世界 AABB → 格内局部 AABB（多归属逐条匹配用）。 */
export function maskMeshLocalAabb(
  mesh: OutlineMaskMeshSummary,
  cell: { col: number; row: number; z: number },
  size: { w: number; h: number; d: number },
): { min: [number, number, number]; max: [number, number, number] } | null {
  return localAabbOf(mesh, cell, size)
}

/** 读注入文档的网格尺寸（cellGrid 行列层）。 */
export async function readGridSize(page: Page): Promise<{ w: number; h: number; d: number }> {
  return await page.evaluate((rid) => {
    const g = (window as any).__vm__?.viewports?.get(rid)?.definition?.value?.cellGrid as number[][][] | undefined
    if (!g) return { w: 0, h: 0, d: 0 }
    return { d: g.length, h: g[0]!.length, w: g[0]![0]!.length }
  }, WIKI_REGION)
}
