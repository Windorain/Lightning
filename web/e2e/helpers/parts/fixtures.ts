/**
 * 部件断言包 —— fixture 读取 / 内存变形 / 几何增强（**仓库原件一字不改**）。
 *
 * 三条纪律（与多方块轮证伪一致）：
 *  1. 仓库 fixture 原件只读；一切变形（证伪篡改、几何增强）都发生在测试内存的
 *     注入副本上（JSON 深拷贝），注入路径与原件完全相同（OPERATOR_OPEN_SCENE + File）。
 *  2. **几何增强的正当性**（部件轮新增，拍板登记于 spec 文件头）：
 *     fixture geometry 从简，并补记「每个部件盒内须有至少一个 raycast 可命中的面」
 *     （c98351a 按悬停实测补全）。但悬停拾取是**真实 raycast**（scenePick.ts 命中
 *     三角形 → 命中点换算格内坐标 → 部件盒判定），fixture 几何仍有两处物理不可达
 *     （实测）：① 全部 quad 单绕组、法线在 (+x,-y,+z) 半球，而视口
 *     init 相机恒在 (-x,+y,-z) 象限 —— FrontSide 材质背面剔除 ⇒ 原件几何从默认
 *     相机**全部不可命中**；② AE2 fixture 为切换总线补的 z=0.3125 面同时处于线缆
 *     颈盒（z∈[0.3125,0.375]）min 边界上，按「最小体积盒」取舍规则（partHit.ts）
 *     该面命中会判给**线缆**而非切换总线（颈盒体积更小）。`augmentFixtureGeometry()`
 *     只在副本上向调色板条目**追加**双绕组四边形（正反两个绕组 ⇒ 任意相机方向
 *     必可命中），且注入面取目标部件**独占**的盒边界（如切换总线 z=0 min 面），
 *     **部件数据（盒/说明/物品身份/计数）与原件逐字节一致** —— 断言目标仍是原件
 *     的部件数据，几何只是让 raycast 能到达那些盒。
 *  3. 增强注入点 = 追加四边形的面中心（格内局部坐标已知），保证射线命中点落在
 *     目标部件盒内（命中判定的输入由此确定）。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'

const FIXTURE_DIR = path.join(import.meta.dirname, '..', '..', 'fixtures')

/** 读仓库 fixture 原件（只读）。 */
export function readPartsFixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8')) as Record<string, unknown>
}

/** JSON 深拷贝（变形副本的起点；原件不受影响）。 */
export function cloneFixture<T>(fixture: T): T {
  return JSON.parse(JSON.stringify(fixture)) as T
}

/**
 * textureBlobs 归一化（内存副本）：`[{id,mime,dataBase64}]` 对象数组 → `[dataBase64]`
 * 字符串数组。渲染管线（`listPaletteTextureDataUrls`）只认 string[] —— 对象数组会
 * 被静默跳过导致「纹理未预取」、网格构建失败（multiblock README §7 开放项 4 记载的
 * 既有口径，minimal-v2 与两份 parts fixture 同为对象数组格式）。本函数与几何增强
 * 同属「输入整备」：只让 fixture 的几何在渲染管线中可达，不触碰部件数据。
 */
export function normalizeTextureBlobsForRender(fixture: Record<string, unknown>): Record<string, unknown> {
  const copy = cloneFixture(fixture)
  const blobs = copy.textureBlobs
  if (Array.isArray(blobs)) {
    copy.textureBlobs = blobs.map((b) =>
      typeof b === 'string' ? b : (b as { dataBase64?: string })?.dataBase64 ?? '',
    )
  }
  return copy
}

/** 四边形四角（格内局部 0–1 坐标，顺序即绕组）。 */
export type QuadCorners = [
  [number, number, number],
  [number, number, number],
  [number, number, number],
  [number, number, number],
]

interface BakedQuadVertex {
  x: number
  y: number
  z: number
  u: number
  v: number
  color: number
}

function quadVertices(c: QuadCorners, color: number): BakedQuadVertex[] {
  const uv: Array<[number, number]> = [[0, 0], [1, 0], [1, 1], [0, 1]]
  return c.map((p, i) => ({ x: p[0], y: p[1], z: p[2], u: uv[i]![0], v: uv[i]![1], color }))
}

/**
 * 向 fixture **副本**的 `blockPalette[paletteIndex].geometry.quads` 追加四边形，
 * 每个四边形写**正 + 反两个绕组**（FrontSide 材质 raycast 背面剔除 ⇒ 双绕组
 * 保证任意相机方向必可命中；渲染 z-fighting 与断言无关）。返回新对象，入参不改。
 */
export function augmentFixtureGeometry(
  fixture: Record<string, unknown>,
  paletteIndex: number,
  quads: QuadCorners[],
  color = 13421772,
): Record<string, unknown> {
  const copy = cloneFixture(fixture)
  const frames = copy.frames as Array<{ structure: { blockPalette: Array<{ geometry: { quads: unknown[] } }> } }>
  const entry = frames[0]!.structure.blockPalette[paletteIndex]!
  for (const q of quads) {
    entry.geometry.quads.push({ materialIndex: 0, vertices: quadVertices(q, color) })
    const reversed = [q[0], q[3], q[2], q[1]] as QuadCorners
    entry.geometry.quads.push({ materialIndex: 0, vertices: quadVertices(reversed, color) })
  }
  return copy
}

/** 以四角坐标求面中心（增强注入点 = 面中心，保证命中点落入目标盒）。 */
export function quadCenter(q: QuadCorners): { lx: number; ly: number; lz: number } {
  return {
    lx: (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4,
    ly: (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4,
    lz: (q[0][2] + q[1][2] + q[2][2] + q[3][2]) / 4,
  }
}

// ---------------------------------------------------------------------------
// 公开观测：文档部件数据（Grid API，解析级 —— 不经渲染管线）
// ---------------------------------------------------------------------------

export interface CellPartBoxObservation {
  min: [number, number, number]
  max: [number, number, number]
  kind: string
}

export interface CellPartsObservation {
  pos: { x: number; y: number; z: number }
  parts: Array<{
    localId: string
    typeKey: string
    displayName: string
    tooltip: string[]
    itemKeys: string[]
    itemCounts: number[]
    boxCount: number
    /** 盒快照（契约 §6：0–1 方块局部、允许越界；真实导出用导出盒推导探针点）。 */
    boxes: CellPartBoxObservation[]
    source: { family: string; fallback: boolean; boxProvenance: string; tier: number }
    /** 族特有补充（契约 §3：如 `facing=meta5`）；无 ⇒ null。 */
    properties: Record<string, string> | null
  }> | null
}

/**
 * 经公开 Grid API（`doc.frame(0).grid.partsAt`）读当前文档全部带部件格。
 * 这是**解析级**观测：不依赖渲染管线，serialize 缺陷存在时同样可用。
 */
export async function readPartsObservation(page: Page): Promise<CellPartsObservation[]> {
  return await page.evaluate(() => {
    // D3（R5）：网格读面（网格帧下标**逐字保留 0** —— 原实现即 `frame(0)`）。
    const grid = (window as any).__vm__?.kernelGrid?.(0)
    if (!grid) return []
    const out: CellPartsObservation[] = []
    for (let z = 0; z < grid.depth; z++) {
      for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
          const parts = grid.partsAt({ x, y, z })
          if (!parts || parts.length === 0) continue
          out.push({
            pos: { x, y, z },
            parts: parts.map((p: any) => ({
              localId: p.localId,
              typeKey: p.typeKey,
              displayName: p.displayName,
              tooltip: [...p.tooltip],
              itemKeys: p.items.map((it: any) => `${it.registry}:${it.damage}`),
              itemCounts: p.items.map((it: any) => it.count),
              boxCount: p.boxes.length,
              boxes: p.boxes.map((b: any) => ({
                min: [...b.min] as [number, number, number],
                max: [...b.max] as [number, number, number],
                kind: b.kind,
              })),
              source: { ...p.source },
              properties: p.properties ? { ...p.properties } : null,
            })),
          })
        }
      }
    }
    return out
  })
}
