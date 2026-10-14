/**
 * **R1-β① C7 段二 · 内核拾取的生产判据**（接缝 `presenter-surface-dual-track` 的画面切换前置）。
 *
 * ## 为什么需要它（缺口是具体的）
 *
 * 旧拾取（`render/interaction/scenePick`）从 Mesh 的 `userData.triangleMap` 解格
 * （`scenePick.ts:225-227`）。画面切到 `PresenterSession` 后内核批次的标签是
 * `batchTagOf` 的 `{batchIndex, compatibilityKey, objectIds}` —— **没有 triangleMap**
 * ⇒ 只切画面不切拾取会让点选**静默失效**（射线仍命中，但解不出任何格）。
 *
 * ## 输入口径（生产解析 + 装配，禁手搓载荷）
 *
 * 与 `textureUnificationProduction.test.ts` 同一套生产链：
 * 真实信封夹具 → 生产 parser registry → 生产 `adoptLoadedDocument` → 内核 `Document`
 * → `PresenterSession.applyKernelDocument` → **真实射线** → `kernelPickBlockOf`。
 *
 * ## 判据结构：正判据 + 负对照
 *
 * | # | 断言 | 抓什么 |
 * |---|---|---|
 * | ① | 对真实几何**从相机方向射穿中心** ⇒ `hit` 且解出 `column/row/zSlice` | 正判据：内核命中能解成方格 |
 * | ② | 同一个 `blockId` 与内核网格读面（`grid.at`）**逐字一致** | 映射没有自造一份名字 |
 * | ③ | 命中结果里的 `point` 与射线实际命中点同源（不是重射/编造） | 与 `resolution` 同一次射线 |
 * | ④ | **负对照**：把逐格身份抹掉（同一命中但 `cell === undefined`）⇒ `no-cell` | 证明 ① 不是恒真 |
 * | ⑤ | **负对照**：分层预览把该格滤成空气 ⇒ `cell-is-air`（不是"照样选上"） | 分层语义未退化 |
 */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import fs from 'node:fs'
import path from 'node:path'
import { createParserRegistry } from '@/context/parserRegistry'
import {
  V2PlainParser,
  WorldParser,
  StructureDataParser,
  createEnvelopeParser,
} from '@/context/parsers/builtinParsers'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { KernelSession, KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID } from '@/runtime/kernelSession'
import { PresenterSession } from '@/composition/presenterSession'
import { kernelPickBlockOf, kernelPickEntitiesOf, type KernelScenePickBlock } from '@/composition/kernelPickAdapter'
import { kernelGridOf } from '@/runtime/gridRead'
import { structureRowToWorldY } from '@/pure/vec'

const ENVELOPE_FIXTURE = path.join(process.cwd(), 'e2e', 'fixtures', 'structuredata-exported-envelope.json')

async function kernelSetup(fixture: string = ENVELOPE_FIXTURE) {
  const raw = JSON.parse(fs.readFileSync(fixture, 'utf8').replace(/\r\n/g, '\n')) as Record<string, unknown>
  const registry = createParserRegistry()
  registry.register(V2PlainParser)
  registry.register(createEnvelopeParser(registry))
  registry.register(WorldParser)
  registry.register(StructureDataParser)
  const parsed = await registry.detectAndParse(raw)
  expect(parsed.document, '生产解析必须成功').not.toBeNull()
  const session = new KernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: [],
  })
  const ok = adoptLoadedDocument(
    { kernel: session, log: { info: () => {}, warn: () => {} } },
    parsed.document!,
    raw,
    fixture,
  )
  expect(ok, '生产装配必须成功（GF-16 = true）').toBe(true)
  return session.document()!
}

/**
 * 造一条**必然命中**的真实射线：取某个真实批次几何的**第一个三角形质心**，
 * 从该三角形正面外侧沿法线反向射入。
 *
 * ## 为什么不能用"包围盒中心"
 *
 * 实测（本判据首版）：信封结构有 32 个批次、62 个实例，块体是**有间隙**的
 * —— 整场景包围盒中心那一条 (x,y) 列上**可能没有面**（`mesh.raycast` 直接返 0）。
 * 那不是实现缺陷，是"射线碰巧从缝里穿过"。用真实三角形的质心则命中是**构造保证**，
 * 判据不会因夹具内容变化而变成碰运气。
 */
function rayOnRealTriangle(session: PresenterSession): {
  readonly raycaster: THREE.Raycaster
  /** 用于独立核对"命中点确实落在这块三角形上"。 */
  readonly centroid: THREE.Vector3
} {
  let picked: { mesh: THREE.Mesh; centroid: THREE.Vector3; normal: THREE.Vector3 } | null = null
  session.object3d.traverse((o) => {
    if (picked !== null) return
    const mesh = o as THREE.Mesh
    const attr = (mesh.geometry as THREE.BufferGeometry | undefined)?.getAttribute?.('position')
    if (mesh.isMesh !== true || attr === undefined || attr.count < 3) return
    const a = new THREE.Vector3().fromBufferAttribute(attr as THREE.BufferAttribute, 0)
    const b = new THREE.Vector3().fromBufferAttribute(attr as THREE.BufferAttribute, 1)
    const c = new THREE.Vector3().fromBufferAttribute(attr as THREE.BufferAttribute, 2)
    const centroid = new THREE.Vector3().add(a).add(b).add(c).divideScalar(3)
    const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize()
    // 转世界坐标：本呈现产物挂在会话根下，矩阵可能非单位。
    mesh.updateWorldMatrix(true, false)
    centroid.applyMatrix4(mesh.matrixWorld)
    normal.transformDirection(mesh.matrixWorld)
    picked = { mesh, centroid, normal }
  })
  expect(picked, '前置：呈现产物里必须有带位置属性的真实 Mesh').not.toBeNull()
  const { centroid, normal } = picked!
  const origin = centroid.clone().addScaledVector(normal, 20)
  const raycaster = new THREE.Raycaster()
  raycaster.set(origin, normal.clone().negate().normalize())
  raycaster.far = 100
  return { raycaster, centroid }
}

describe('C7 段二 · 内核拾取适配（生产解析 + 装配 + 真实射线）', () => {
  it('① 真实几何上射入 ⇒ 解出方格，且 ② `blockId` 与内核网格读面逐字一致', async () => {
    const doc = await kernelSetup()
    const session = new PresenterSession({ scope: 'c7-pick-pos' })
    try {
      const applied = session.applyKernelDocument(doc, { frame: 0, fps: 20 })
      expect(applied.applied, '前置：内核编译必须成功').toBe(true)
      expect(applied.batches, '前置：必须有批次可拾取').toBeGreaterThan(0)

      const { raycaster, centroid } = rayOnRealTriangle(session)
      const hit = session.pickAt(raycaster)
      expect(hit.kind, '正判据：真实三角形上必须命中').toBe('hit')
      if (hit.kind !== 'hit') return
      expect(hit.resolution.objectId, '必须解出对象身份').toBeTruthy()
      expect(hit.resolution.cell, '必须解出**格身份**（切链后这是新路径的唯一来源）').toBeDefined()

      const grid = kernelGridOf(doc, 0)
      expect(grid, '前置：内核网格读面可用').not.toBeNull()
      const out = kernelPickBlockOf({
        resolution: hit.resolution,
        point: hit.point,
        distance: hit.distance,
        grid: grid!,
        layerPreview: 'all',
      })
      expect(out.ok, `适配必须解出方格（若否：${out.ok ? '' : out.skip.detail}）`).toBe(true)
      if (!out.ok) return
      const block: KernelScenePickBlock = out.block
      const cell = hit.resolution.cell!
      expect(block.column).toBe(cell.column)
      expect(block.row).toBe(cell.row)
      expect(block.zSlice).toBe(cell.zSlice)
      expect(block.quadIndex).toBe(cell.quadIndex)

      // ② `blockId` = **完整 registry 键**（独立来源：内核网格读面的**调色板条目**）。
      //
      // ⚠️ R1-β① C8 判据修复：本行原先把期望值写成 `grid.at()` 现算
      // （`at.meta === 0 ? at.name : …`），而**实现**也用 `grid.at()` ⇒ 同源 ⇒ **恒绿**。
      // 生产上暴露的缺口正是这一条：`at.name` 是 GF-7 的**已截命名空间**短名
      // （`stone`），而 tooltip/侧栏的键是完整 registryId（`minecraft:stone`）⇒
      // 命中"成功"但 tooltip/侧栏查不到（静默回退，e2e `parts-hover-stats` 实测擒获）。
      // 现在期望值取**调色板条目**（另一条读面），并加"短名必须判红"的负对照。
      const worldY = structureRowToWorldY(cell.row, grid!.height)
      const at = grid!.at({ x: cell.column, y: worldY, z: cell.zSlice })
      expect(at, '命中格必须在内核网格里').not.toBeNull()
      const entry = grid!.paletteEntryOf({ x: cell.column, y: worldY, z: cell.zSlice })
      expect(entry, '命中格必须有调色板条目（身份的唯一来源）').not.toBeNull()
      const expected = entry!.meta === 0 ? entry!.registryId : `${entry!.registryId}@${entry!.meta}`
      expect(block.blockId, '`blockId` 必须来自**调色板条目**的 registryId（legacy 键口径）').toBe(expected)
      expect(block.blockId, '不得是空气').not.toBe('air')
      const shortForm = at!.meta === 0 ? at!.name : `${at!.name}@${at!.meta}`
      if (shortForm !== entry!.registryId) {
        expect(
          block.blockId,
          '`blockId` 不得退化成 GF-7 短名（丢命名空间 ⇒ tooltip/侧栏永远查不到）',
        ).not.toBe(shortForm)
      }
      expect(block.blockId, '真实 registry 键必须带命名空间').toContain(':')

      // ③ 命中点与本次射线同源，且确实落在被击中的三角形上
      expect(block.point.x).toBe(hit.point[0])
      expect(block.point.y).toBe(hit.point[1])
      expect(block.point.z).toBe(hit.point[2])
      expect(block.distance).toBe(hit.distance)
      expect(block.distance, '距离必须为正（真实命中）').toBeGreaterThan(0)
      const hitPoint = new THREE.Vector3(hit.point[0], hit.point[1], hit.point[2])
      expect(
        hitPoint.distanceTo(centroid),
        '命中点必须落在所选三角形的质心附近（证明射线确实打在这块真实几何上）',
      ).toBeLessThan(2)
    } finally {
      session.dispose()
    }
  })

  it('④ **负对照**：同一命中但逐格身份缺席 ⇒ `no-cell`（不猜第 0 格）', async () => {
    const doc = await kernelSetup()
    const session = new PresenterSession({ scope: 'c7-pick-neg1' })
    try {
      session.applyKernelDocument(doc, { frame: 0, fps: 20 })
      const { raycaster } = rayOnRealTriangle(session)
      const hit = session.pickAt(raycaster)
      expect(hit.kind).toBe('hit')
      if (hit.kind !== 'hit') return

      const grid = kernelGridOf(doc, 0)!
      // 抹掉格身份（= 那份几何不是逐格来源，如纯网格元素/A18 自造夹具）
      const stripped = { ...hit.resolution, cell: undefined }
      const out = kernelPickBlockOf({
        resolution: stripped,
        point: hit.point,
        distance: hit.distance,
        grid,
        layerPreview: 'all',
      })
      expect(out.ok, '无格身份 ⇒ 必须拒绝，而不是猜一格').toBe(false)
      if (!out.ok) expect(out.skip.kind).toBe('no-cell')
    } finally {
      session.dispose()
    }
  })

  it('⑤ **负对照**：分层预览滤掉命中层 ⇒ `cell-is-air`（分层语义未退化）', async () => {
    const doc = await kernelSetup()
    const session = new PresenterSession({ scope: 'c7-pick-neg2' })
    try {
      session.applyKernelDocument(doc, { frame: 0, fps: 20 })
      const { raycaster } = rayOnRealTriangle(session)
      const hit = session.pickAt(raycaster)
      expect(hit.kind).toBe('hit')
      if (hit.kind !== 'hit') return

      const grid = kernelGridOf(doc, 0)!
      const cell = hit.resolution.cell!
      // 分层预览"只显示别的 Y 层"时，命中格是空气 ⇒ 不得照样选上。
      const out = kernelPickBlockOf({
        resolution: hit.resolution,
        point: hit.point,
        distance: hit.distance,
        grid,
        layerPreview: { worldY: -12345 },
      })
      expect(out.ok, '分层预览下该格为空气 ⇒ 必须拒绝').toBe(false)
      if (!out.ok) expect(out.skip.kind).toBe('cell-is-air')
      expect(cell.row, '（前置：确实拿到了一格）').toBeTypeOf('number')
    } finally {
      session.dispose()
    }
  })

  it('⑥ 轮换拾取：`pickAllAt` 给**多个**候选，且去重键与 legacy 同（同格只算一次）', async () => {
    const doc = await kernelSetup()
    const session = new PresenterSession({ scope: 'c7-pick-all' })
    try {
      session.applyKernelDocument(doc, { frame: 0, fps: 20 })
      const grid = kernelGridOf(doc, 0)!
      // 沿 -Z 射入：信封是**多层**结构，故一条轴线上通常能穿透多格。
      const { raycaster } = rayOnRealTriangle(session)
      const all = session.pickAllAt(raycaster)
      expect(all.kind).toBe('hits')
      if (all.kind !== 'hits') return
      expect(all.hits.length, '穿透候选至少一个').toBeGreaterThan(0)

      const entities = kernelPickEntitiesOf({ hits: all.hits, grid, layerPreview: 'all' })
      expect(entities.length).toBeGreaterThan(0)
      // 去重：同一格不得出现两次（否则轮换会在同一格上打转）
      const keys = entities.map((e) => `${e.column},${e.row},${e.zSlice}`)
      expect(new Set(keys).size, '同格只算一个候选').toBe(keys.length)
      // 距离升序（射线的事实，不得被本层重排）
      for (let i = 1; i < entities.length; i += 1) {
        expect(entities[i]!.distance, '候选必须按距离升序').toBeGreaterThanOrEqual(entities[i - 1]!.distance)
      }
      // 与单个拾取的**最近一个**必须同格（两条链共用同一映射）
      const one = kernelPickBlockOf({
        resolution: all.hits[0]!.resolution,
        point: all.hits[0]!.point,
        distance: all.hits[0]!.distance,
        grid,
        layerPreview: 'all',
      })
      if (one.ok && entities.length > 0) {
        expect([entities[0]!.column, entities[0]!.row, entities[0]!.zSlice]).toEqual([
          one.block.column,
          one.block.row,
          one.block.zSlice,
        ])
      }
    } finally {
      session.dispose()
    }
  })

  it('⑦ **负对照**：`pickAllAt` 与 `pickAt` 对**同一条射线**给出同一最近格（两链共用一条映射）', async () => {
    const doc = await kernelSetup()
    const session = new PresenterSession({ scope: 'c7-pick-all-consistency' })
    try {
      session.applyKernelDocument(doc, { frame: 0, fps: 20 })
      const { raycaster } = rayOnRealTriangle(session)
      const one = session.pickAt(raycaster)
      const all = session.pickAllAt(raycaster)
      expect(one.kind).toBe('hit')
      expect(all.kind).toBe('hits')
      if (one.kind !== 'hit' || all.kind !== 'hits') return
      expect(all.hits.length, '全量必须有内容').toBeGreaterThan(0)
      const first = all.hits[0]!
      // 同一条映射 ⇒ 对象身份、格身份、距离必须逐字段一致（不是"两个近似实现"）
      expect(first.resolution.objectId).toBe(one.resolution.objectId)
      expect(first.resolution.cell).toEqual(one.resolution.cell)
      expect(first.distance).toBe(one.distance)
      expect(first.point).toEqual(one.point)
    } finally {
      session.dispose()
    }
  })
})
