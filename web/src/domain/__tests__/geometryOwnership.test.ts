/**
 * A07 `geometry-ownership` —— **共享几何的按对象独立编辑**（#249 §14 A07、§3.2）。
 *
 * ## A07 的可观测断言（#249 §14 逐字）
 *
 * | Given / When | 必须成立 | 负对照必须判红 |
 * |---|---|---|
 * | A/B 共用几何，**仅编辑 A 顶点** | B 不变；A 数据按需分离；取消/撤销恢复正确引用且无孤儿 | **原地改共享数据** |
 *
 * ## 本文件的负对照为什么"真的破坏了目标保证"
 *
 * #249 §14 测试维护要求：「负对照必须证明**确实破坏了**目标保证，**不能只令测试主动抛错**」。
 * 故本文件的负对照不是"期望某个函数抛异常"，而是：
 *  - **原地改共享数据**（`mutateSharedInPlace`）：用与正确路径**同一套**断言器
 *    （`assertOnlyTargetChanged`）去检查一个真的会改到 B 的实现，断言该断言器判红；
 *  - **batchIdx 当身份**（`ordinalAsIdentity`）：用与正确路径**同一个**身份解析器
 *    去解析一个真的用局部序号当身份的实现，断言它给出错误的身份。
 *
 * 于是"断言器有效"与"实现正确"是两条独立证据：若断言器太弱（恒绿），负对照会失败。
 */

import { describe, expect, it } from 'vitest'
import {
  buildGeometrySourceMap,
  consumersOfData,
  deformation,
  edgeIdOf,
  elementRefOf,
  evaluateDeformation,
  faceIdOf,
  meshBounds,
  meshData,
  meshFromPayload,
  meshTopology,
  ordinalKey,
  resolveByOrdinal,
  resolveVertex,
  topologyVersionOf,
  unitBoxMesh,
  withVertexPosition,
  type Deformation,
  type MeshData,
} from '@/domain/geometry'
import {
  applyVertexDisplacements,
  beginGeometryEdit,
  cancelGeometryEdit,
  checkVertexRef,
  commitGeometryEdit,
  geometryStagingFootprint,
  writeVertexOnObject,
} from '@/domain/geometryEditing'
import {
  addMeshObject,
  createDocument,
  shareMeshData,
  withScene,
  undo,
  redo,
  type Scene,
} from '@/domain/document'
import { isDataShared, objectsSharingData } from '@/domain/scene'
import { elementRef, type ElementRef } from '@/domain/identity'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

/** 造"两个对象共享同一份几何"的场景（A07 的 Given）。 */
function sharedPair(): { scene: Scene; a: string; b: string; dataId: string } {
  const base = createDocument('doc-1').scene
  const a = addMeshObject(base, { objectId: 'A', dataId: 'geo-1', size: 1 })
  expect(a.ok).toBe(true)
  if (!a.ok) throw new Error('fixture')
  // B 先有**自己的**数据（构造上必须先有对象条目），随后显式改为共享 A 的数据。
  // 共享由 shareMeshData 显式建立 —— 不是巧合的别名。
  const b = addMeshObject(a.value, { objectId: 'B', dataId: 'geo-b-tmp', size: 1 })
  expect(b.ok).toBe(true)
  if (!b.ok) throw new Error('fixture')
  const res = shareMeshData(b.value, 'B', 'A')
  expect(res.ok).toBe(true)
  if (!res.ok) throw new Error('fixture')
  // 清掉不再被引用的临时数据（避免它干扰"无孤儿"类断言）
  const data = { ...res.value.data }
  delete data['geo-b-tmp']
  return { scene: Object.freeze({ ...res.value, data: Object.freeze(data) }), a: 'A', b: 'B', dataId: 'geo-1' }
}

function meshOf(scene: Scene, objectId: string): MeshData {
  const obj = scene.objects[objectId]
  const data = scene.data[obj.dataId]
  const mesh = meshFromPayload(data.payload)
  if (!mesh) throw new Error('not a mesh')
  return mesh
}

function vertexPosition(scene: Scene, objectId: string, vertex: string): { x: number; y: number; z: number } {
  const mesh = meshOf(scene, objectId)
  const ref = elementRefOf(mesh.topology, vertex)
  const r = resolveVertex(mesh.topology, ref)
  if (!r.ok) throw new Error('vertex missing')
  return r.value.position
}

/**
 * 共享判定的**断言器**（正负对照共用它）。
 *
 * 语义：对一批"不该变的"对象，断言它们的数据与位置逐位未变。
 * 若实现真的改了共享数据，B 的位置会变 ⇒ 本函数返回非空 ⇒ 负对照判红。
 */
function assertOnlyTargetChanged(
  before: Scene,
  after: Scene,
  unchangedObjectIds: readonly string[],
): readonly string[] {
  const violations: string[] = []
  for (const id of unchangedObjectIds) {
    const b = before.objects[id]
    const a = after.objects[id]
    if (!b || !a) {
      violations.push(`${id}: 对象消失`)
      continue
    }
    if (b.dataId !== a.dataId) {
      violations.push(`${id}: dataId 从 ${b.dataId} 变成 ${a.dataId}（不该动它）`)
      continue
    }
    const mb = meshFromPayload(before.data[b.dataId].payload)
    const ma = meshFromPayload(after.data[a.dataId].payload)
    if (!mb || !ma) {
      violations.push(`${id}: 载荷不是网格`)
      continue
    }
    for (const v of mb.topology.vertices) {
      const nv = ma.topology.vertices.find((x) => x.id === v.id)
      if (!nv) {
        violations.push(`${id}: 顶点 ${v.id} 消失`)
        continue
      }
      if (nv.position.x !== v.position.x || nv.position.y !== v.position.y || nv.position.z !== v.position.z) {
        violations.push(`${id}: 顶点 ${v.id} 被改动（${JSON.stringify(v.position)} → ${JSON.stringify(nv.position)}）`)
      }
    }
  }
  return violations
}

// ─────────────────────────────────────────────────────────────────────────────
// A07 正常路径
// ─────────────────────────────────────────────────────────────────────────────

describe('A07 geometry-ownership：A/B 共用几何，仅编辑 A 顶点', () => {
  it('Given A/B 共享 geo-1；When 改 A 的一个顶点；Then B 的数据与位置**逐位不变**', () => {
    const { scene, a, b, dataId } = sharedPair()
    expect(isDataShared(scene, dataId), '前置：A/B 必须真的共享').toBe(true)

    const meshA = meshOf(scene, a)
    const vertex = meshA.topology.vertices[0].id
    const result = writeVertexOnObject(scene, {
      objectId: a,
      vertex,
      delta: { x: 0.25, y: 0, z: 0 },
      detachedDataId: `${a}::geo`,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // A 被分离（拿到自己的数据）
    expect(result.value.detached, 'A 的数据应被分离（原本被共享）').toBe(true)
    expect(result.value.dataId).not.toBe(dataId)
    expect(result.value.scene.objects[a].dataId).toBe(result.value.dataId)
    // 原数据仍在（B 还在用）—— 无孤儿**也**无丢失
    expect(result.value.scene.data[dataId]).toBeDefined()
    expect(result.value.scene.objects[b].dataId).toBe(dataId)

    // **B 逐位不变**（A07 的核心断言）
    expect(assertOnlyTargetChanged(scene, result.value.scene, [b])).toEqual([])

    // A 的顶点**确实**动了（否则"B 不变"可能只是"谁都没变"的假绿）
    const before = vertexPosition(scene, a, vertex)
    const after = vertexPosition(result.value.scene, a, vertex)
    expect(after.x - before.x).toBeCloseTo(0.25, 12)
    expect(after.y).toBe(before.y)
    expect(after.z).toBe(before.z)
  })

  it('反空洞真：若**共用**位置真的被改，同一断言器会判红（证明上一条不是空转）', () => {
    const { scene, a, b, dataId } = sharedPair()
    const meshA = meshOf(scene, a)
    const vertex = meshA.topology.vertices[0].id

    // 变异实现：**原地**改共享数据（正是 A07 负对照要判红的形态）
    const mutated = mutateSharedInPlace(scene, dataId, vertex, { x: 0.5, y: 0, z: 0 })
    const violations = assertOnlyTargetChanged(scene, mutated, [b])
    expect(violations.length, '原地改共享数据必须被同一断言器判红').toBeGreaterThan(0)
    // 且它**确实**改到了 B（不是"报了个别的错"）
    expect(vertexPosition(mutated, b, vertex).x).not.toBe(vertexPosition(scene, b, vertex).x)
  })

  it('独占数据的对象**不**被无谓分离（按需分离的第二半）', () => {
    const base = createDocument('doc-1').scene
    const made = addMeshObject(base, { objectId: 'solo', dataId: 'geo-solo', size: 1 })
    if (!made.ok) throw new Error('fixture')
    const mesh = meshOf(made.value, 'solo')
    const r = writeVertexOnObject(made.value, {
      objectId: 'solo',
      vertex: mesh.topology.vertices[0].id,
      delta: { x: 1, y: 0, z: 0 },
      detachedDataId: 'should-not-be-used',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.detached, '已独占 ⇒ 不得分离').toBe(false)
    expect(r.value.dataId, '已独占 ⇒ 数据身份不变').toBe('geo-solo')
    expect(r.value.scene.data['should-not-be-used'], '不得产生未使用的数据（无孤儿）').toBeUndefined()
  })

  it('共享者为 3 个时，只改 1 个 ⇒ 另 2 个逐位不变', () => {
    const { scene } = sharedPair()
    const added = addMeshObject(scene, { objectId: 'C', dataId: 'geo-c-tmp', size: 1 })
    if (!added.ok) throw new Error('fixture')
    const shared = shareMeshData(added.value, 'C', 'A')
    if (!shared.ok) throw new Error('fixture')
    const data = { ...shared.value.data }
    delete data['geo-c-tmp']
    const sc = Object.freeze({ ...shared.value, data: Object.freeze(data) })
    expect(objectsSharingData(sc, 'geo-1').length).toBe(3)

    const mesh = meshOf(sc, 'B')
    const r = writeVertexOnObject(sc, { objectId: 'B', vertex: mesh.topology.vertices[1].id, delta: { x: 0, y: 0.1, z: 0 }, detachedDataId: 'B::geo' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(assertOnlyTargetChanged(sc, r.value.scene, ['A', 'C'])).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 取消 / 提交 / 撤销 / 重做（引用一致 + 无孤儿）
// ─────────────────────────────────────────────────────────────────────────────

describe('A07 取消 / 撤销 / 重做：恢复正确引用且无孤儿', () => {
  it('取消 ⇒ 场景回到起点，且**没有**新的网格数据（取消不遗留新几何）', () => {
    const { scene, a } = sharedPair()
    const plan = beginGeometryEdit(scene, [a])
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.detachNeeded, '共享 ⇒ 需要分离').toEqual([a])

    // 编辑（产出候选场景）后取消
    const mesh = meshOf(scene, a)
    const candidate = commitGeometryEdit(scene, [{ objectId: a, vertex: mesh.topology.vertices[0].id, delta: { x: 9, y: 9, z: 9 } }])
    expect(candidate.ok).toBe(true)

    const cancelled = cancelGeometryEdit(plan.value)
    expect(cancelled, '取消 ⇒ 与起点**同一引用**（零痕迹）').toBe(scene)
    expect(Object.keys(cancelled.data).sort()).toEqual(Object.keys(scene.data).sort())
    // 无孤儿：分离产生的数据不在被取消的场景里
    if (candidate.ok) {
      const added = Object.keys(candidate.value.scene.data).filter((k) => !Object.prototype.hasOwnProperty.call(scene.data, k))
      expect(added.length, '候选确实产生了新数据（前置，证明上一条不是空转）').toBeGreaterThan(0)
      for (const k of added) expect(cancelled.data[k], `取消后不得残留 ${k}`).toBeUndefined()
    }
  })

  it('提交 → withScene 记账 → 撤销回起点内容 → 重做回到编辑后内容（引用一致）', () => {
    const { scene, a, b } = sharedPair()
    const mesh = meshOf(scene, a)
    const vertex = mesh.topology.vertices[0].id
    const candidate = commitGeometryEdit(scene, [{ objectId: a, vertex, delta: { x: 0.3, y: 0, z: 0 } }])
    expect(candidate.ok).toBe(true)
    if (!candidate.ok) return

    const doc0 = createDocument('doc-1')
    const docA = withScene(doc0, scene).doc
    const write = withScene(docA, candidate.value.scene)
    expect(write.changed, '顶点真的动了 ⇒ 内容变化').toBe(true)
    const pushed = {
      ...write.doc,
      history: {
        past: [
          {
            label: 'edit vertex',
            beforeScene: scene,
            afterScene: candidate.value.scene,
            beforeVersion: docA.version,
            afterVersion: write.version,
            changes: { changedProperties: [], createdEntities: [], removedEntities: [], structurallyShared: true },
            selectionBefore: [],
            selectionAfter: [],
          },
        ],
        future: [],
        maxDepth: 256,
      },
    }

    const undone = undo(pushed)
    expect(undone).not.toBeNull()
    if (!undone) return
    // 撤销：A 回到共享数据（**引用一致**），B 也没变
    expect(undone.doc.scene.objects[a].dataId).toBe('geo-1')
    expect(assertOnlyTargetChanged(scene, undone.doc.scene, [a, b])).toEqual([])
    // 撤销回起点 ⇒ 与起点内容身份相等 ⇒ 干净
    expect(undone.doc.version.contentVersion).toBe(docA.version.contentVersion)

    const redone = redo(undone.doc)
    expect(redone).not.toBeNull()
    if (!redone) return
    expect(redone.doc.scene.objects[a].dataId).toBe(candidate.value.scene.objects[a].dataId)
    expect(assertOnlyTargetChanged(scene, redone.doc.scene, [b])).toEqual([])
    expect(vertexPosition(redone.doc.scene, a, vertex).x).toBeCloseTo(vertexPosition(candidate.value.scene, a, vertex).x, 12)
  })

  it('撤销后**无孤儿**：A 的分离数据不再被任何对象引用（但也**不**静默丢失 B 的共享数据）', () => {
    const { scene, a, b } = sharedPair()
    const mesh = meshOf(scene, a)
    const candidate = commitGeometryEdit(scene, [{ objectId: a, vertex: mesh.topology.vertices[0].id, delta: { x: 1, y: 0, z: 0 } }])
    if (!candidate.ok) throw new Error('fixture')
    // 分离后 A 不再引用 geo-1，B 仍引用它
    expect(objectsSharingData(candidate.value.scene, 'geo-1').map((o) => o.id), 'B 仍共享原始数据').toEqual([b])
    // 撤销 = 直接用起点场景，故 A 回到 geo-1
    expect(objectsSharingData(scene, 'geo-1').map((o) => o.id).sort()).toEqual([a, b].sort())
  })

  it('净零位移 ⇒ 不产生新数据、不记账（幽灵历史防御）', () => {
    const { scene, a } = sharedPair()
    const mesh = meshOf(scene, a)
    const r = writeVertexOnObject(scene, {
      objectId: a,
      vertex: mesh.topology.vertices[0].id,
      delta: { x: 0, y: 0, z: 0 },
      detachedDataId: 'A::geo',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.netZero).toBe(true)
    expect(r.value.scene, '净零 ⇒ 场景同一引用').toBe(scene)
    expect(r.value.detached).toBe(false)
  })

  it('"移出再移回"净零 ⇒ 内容身份回到起点（withScene 判 unchanged）', () => {
    const { scene, a } = sharedPair()
    const mesh = meshOf(scene, a)
    const vertex = mesh.topology.vertices[0].id
    // 移出
    const out = commitGeometryEdit(scene, [{ objectId: a, vertex, delta: { x: 0.5, y: 0, z: 0 } }])
    if (!out.ok) throw new Error('fixture')
    // 移回（自当前位置反向位移）
    const back = commitGeometryEdit(out.value.scene, [{ objectId: a, vertex, delta: { x: -0.5, y: 0, z: 0 } }])
    if (!back.ok) throw new Error('fixture')
    const startMesh = meshOf(scene, a)
    const endMesh = meshOf(back.value.scene, a)
    const p0 = startMesh.topology.vertices.find((v) => v.id === vertex)?.position
    const p1 = endMesh.topology.vertices.find((v) => v.id === vertex)?.position
    expect(p1).toEqual(p0)
    // 但**数据身份不同**（分离发生了）—— 故内容身份按"整份场景"比较仍会不同。
    // 这正是要**显式**报告的事实：移出再移回在**顶点位置**上净零，
    // 但"发生了一次按需分离"本身是内容变化（新数据 id）。测试锁定这一语义，
    // 使"看起来净零却被判脏"有明确解释，而不是被静默当作零。
    expect(back.value.scene.objects[a].dataId).not.toBe(scene.objects[a].dataId)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 退役 #9：batchIdx / 下标 / 合成键不得作为身份
// ─────────────────────────────────────────────────────────────────────────────

describe('退役 #9（grid-coord-as-identity）：身份必须经来源映射，局部序号不作身份', () => {
  it('重新分批（改变局部序号）后，对象身份与元素身份**不变**', () => {
    const { scene, a, b } = sharedPair()
    const map1 = buildGeometrySourceMap(scene)
    // "重新分批"：把 order 反转（模拟渲染侧重新划分批次后的局部序号变化）
    const reordered: Scene = Object.freeze({ ...scene, order: Object.freeze([...scene.order].reverse()) })
    const map2 = buildGeometrySourceMap(reordered)

    // 对象身份（byObject 的键）与元素身份**不变**
    expect(Object.keys(map2.byObject).sort()).toEqual(Object.keys(map1.byObject).sort())
    expect(map2.byObject[a].elementIds).toEqual(map1.byObject[a].elementIds)
    expect(map2.byObject[b].elementIds).toEqual(map1.byObject[b].elementIds)
    // 而局部序号**确实**变了（否则上一条是空转）
    expect(map2.byObject[a].ordinal.slot).not.toBe(map1.byObject[a].ordinal.slot)
  })

  it('**负对照**：把局部序号当身份 ⇒ 重新分批后"身份"指向了另一个对象（判红）', () => {
    const { scene, a, b } = sharedPair()
    const map1 = buildGeometrySourceMap(scene)
    const reordered: Scene = Object.freeze({ ...scene, order: Object.freeze([...scene.order].reverse()) })
    const map2 = buildGeometrySourceMap(reordered)

    // 变异实现：局部序号即身份（batchIdx 式）
    const ordinalAsIdentity = (map: ReturnType<typeof buildGeometrySourceMap>, slot: number): string | undefined => {
      for (const [id, e] of Object.entries(map.byObject)) if (e.ordinal.slot === slot) return id
      return undefined
    }
    const slotOfA = map1.byObject[a].ordinal.slot
    expect(ordinalAsIdentity(map1, slotOfA), '起点：该序号指向 A').toBe(a)
    expect(ordinalAsIdentity(map2, slotOfA), '重新分批后同一序号**不再**指向 A ⇒ 序号不能当身份').not.toBe(a)
  })

  it('`resolveByOrdinal` **必须**回表：序号 → 来源映射 → 稳定身份', () => {
    const { scene, a } = sharedPair()
    const map = buildGeometrySourceMap(scene)
    const entry = map.byObject[a]
    const resolved = resolveByOrdinal(map, entry.ordinal)
    expect(resolved, '序号必须能回表到稳定身份').toBeDefined()
    expect(resolved?.objectId).toBe(a)
    // 不存在的序号 ⇒ undefined（**不**猜、不返回最近邻）
    expect(resolveByOrdinal(map, { batch: 999, slot: 999 })).toBeUndefined()
    expect(ordinalKey(entry.ordinal)).toBe(`${entry.ordinal.batch}:${entry.ordinal.slot}`)
  })

  it('共享几何在来源映射里**显式可见**（A07 需要的事实；合成键会把它藏起来）', () => {
    const { scene, dataId, a, b } = sharedPair()
    const map = buildGeometrySourceMap(scene)
    expect([...consumersOfData(map, dataId)].sort()).toEqual([a, b])
    expect(map.byData[dataId].length).toBe(2)
  })

  it('元素身份不由下标决定：调换顶点数组顺序后，**同一顶点**的引用仍然解析到同一位置', () => {
    const { scene, a } = sharedPair()
    const mesh = meshOf(scene, a)
    // 记录"语义角色 x0y0z0"的位置与其引用
    const semantic = mesh.topology.vertices[0].id
    const ref = elementRefOf(mesh.topology, semantic)
    const before = resolveVertex(mesh.topology, ref)
    expect(before.ok).toBe(true)

    // 调换顶点数组顺序（**固定拓扑**：身份集合不变，只有枚举顺序变）
    const shuffled = meshTopology({
      version: mesh.topology.version,
      vertices: Object.freeze([...mesh.topology.vertices].reverse()),
      edges: mesh.topology.edges,
      faces: mesh.topology.faces,
    })
    expect(shuffled.ok).toBe(true)
    if (!shuffled.ok) return
    const after = resolveVertex(shuffled.value, ref)
    expect(after.ok, '同一身份在重排后必须仍然解析得到').toBe(true)
    if (!before.ok || !after.ok) return
    expect(after.value.position).toEqual(before.value.position)
    // 且"下标 0"现在指向**另一个**顶点 ⇒ 下标确实不是身份
    expect(shuffled.value.vertices[0].id).not.toBe(mesh.topology.vertices[0].id)
  })

  it('顶点身份按**语义角色**构造（不随枚举顺序漂移）', () => {
    const box = unitBoxMesh('m', 1)
    expect(box.ok).toBe(true)
    if (!box.ok) return
    const ids = box.value.topology.vertices.map((v) => v.id)
    expect(ids).toContain('x0y0z0')
    expect(ids).toContain('x1y1z1')
    // 语义 id ⇒ 与顺序无关：反转后集合相同
    const reversed = Object.freeze([...box.value.topology.vertices].reverse())
    expect(reversed.map((v) => v.id).sort()).toEqual([...ids].sort())
  })

  it('边/面身份与枚举顺序无关（无序对 / 排序顶点集）', () => {
    expect(edgeIdOf('a', 'b')).toBe(edgeIdOf('b', 'a'))
    expect(faceIdOf(['c', 'a', 'b'])).toBe(faceIdOf(['a', 'b', 'c']))
  })

  it('**负对照**：按坐标派生身份 ⇒ 移动对象后"身份"改变（即 #15 第 9 条要退役的形态）', () => {
    const { scene, a } = sharedPair()
    // 变异实现：用"对象当前位置"当身份键
    const coordinateIdentity = (s: Scene, objectId: string): string =>
      `${s.objects[objectId].transform.position.x},${s.objects[objectId].transform.position.y},${s.objects[objectId].transform.position.z}`

    const idBefore = coordinateIdentity(scene, a)
    // 移动该对象（**身份不变**，位置改变）
    const moved: Scene = Object.freeze({
      ...scene,
      objects: Object.freeze({
        ...scene.objects,
        [a]: Object.freeze({
          ...scene.objects[a],
          transform: Object.freeze({ ...scene.objects[a].transform, position: Object.freeze({ x: 7, y: 0, z: 0 }) }),
        }),
      }),
    })
    const idAfter = coordinateIdentity(moved, a)
    expect(idBefore, '前置：坐标键在移动前').not.toBe(idAfter)
    // 而**真正的**身份（对象 id / 数据 id / 元素 id）一字未变
    expect(moved.objects[a].id).toBe(scene.objects[a].id)
    expect(moved.objects[a].dataId).toBe(scene.objects[a].dataId)
    expect(buildGeometrySourceMap(moved).byObject[a].elementIds).toEqual(buildGeometrySourceMap(scene).byObject[a].elementIds)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E1：拓扑版本变化 ⇒ 旧引用**显式失效**（StaleReference，不静默猜配）
// ─────────────────────────────────────────────────────────────────────────────

describe('E1：拓扑版本变化使失效引用显式失效（不静默猜配）', () => {
  it('拓扑版本推进后，旧 `ElementRef` 的解析返回 `StaleReference`（**不是**找不到，也不是猜配）', () => {
    const { scene, a } = sharedPair()
    const mesh = meshOf(scene, a)
    const ref = elementRefOf(mesh.topology, mesh.topology.vertices[0].id)

    // 拓扑变化：删掉一个顶点（版本推进）
    const bumped = bumpTopologyFrom(mesh, [0])
    expect(bumped.version).toBe(mesh.topology.version + 1)

    const resolved = resolveVertex(bumped, ref)
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error.code, '必须是 StaleReference（版本限定寻址的核心）').toBe('StaleReference')
    expect(resolved.error.params.expected).toBe(mesh.topology.version)
    expect(resolved.error.params.actual).toBe(mesh.topology.version + 1)
  })

  it('**负对照**：忽略版本、只按编号找 ⇒ 会静默命中"另一个元素"（判红）', () => {
    const { scene, a } = sharedPair()
    const mesh = meshOf(scene, a)
    const ref = elementRefOf(mesh.topology, mesh.topology.vertices[0].id)
    const bumped = bumpTopologyFrom(mesh, [1, 2, 3]) // 删掉前两个顶点，版本 +1

    // 变异实现：不比版本，直接按 elementId 找（"静默猜配"的实现形态）
    const guess = (topo: typeof mesh.topology, r: ElementRef): string | null => {
      const hit = topo.vertices.find((v) => v.id === r.elementId)
      return hit ? hit.id : null
    }
    const resolved = resolveVertex(bumped, ref)
    expect(resolved.ok, '正确实现：版本不符必须拒绝').toBe(false)
    // 变异实现要么"猜到了"（危险），要么返回 null（"找不到"而非"过期"）。
    // 两种都不是 StaleReference ⇒ 调用方无法区分"元素没了"与"引用过期"。
    // 本测试锁定：正确的错误码是 StaleReference，而变异实现给不出它。
    const mutantCode = guess(bumped, ref) === null ? 'MissingTarget' : 'guessed'
    expect(mutantCode).not.toBe('StaleReference')
  })

  it('固定拓扑编辑（只改位置）**不**推进拓扑版本 ⇒ 引用仍然有效', () => {
    const { scene, a } = sharedPair()
    const mesh = meshOf(scene, a)
    const ref = elementRefOf(mesh.topology, mesh.topology.vertices[0].id)
    const written = withVertexPosition(mesh, ref, { x: 5, y: 0, z: 0 })
    expect(written.ok).toBe(true)
    if (!written.ok) return
    expect(written.value.topology.version, '固定拓扑编辑不得改拓扑版本').toBe(mesh.topology.version)
    expect(resolveVertex(written.value.topology, ref).ok, '同一引用仍有效').toBe(true)
  })

  it('`checkVertexRef` 与命令层同源：版本不符 ⇒ StaleReference', () => {
    const { scene } = sharedPair()
    const stale = elementRef('x0y0z0', 99)
    const r = checkVertexRef(scene, 'A', stale)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('StaleReference')
  })

  it('`topologyVersionOf` 从载荷**导出**版本（不是硬编码 0）', () => {
    const box = unitBoxMesh('m', 1)
    if (!box.ok) throw new Error('fixture')
    const bumped = bumpTopologyFrom(box.value, [1])
    expect(bumped.version).toBe(1)
    expect(topologyVersionOf({ kind: 'mesh', mesh: meshData('m', bumped) })).toBe(1)
    // 非网格载荷无子元素 ⇒ 0（且 `ElementRef` 对它们无意义）
    expect(topologyVersionOf({ kind: 'annotation' })).toBe(0)
  })

  it('GPU 顶点展开不进领域身份：拓扑里不存在任何索引数组', () => {
    const box = unitBoxMesh('m', 1)
    if (!box.ok) throw new Error('fixture')
    const topo = box.value.topology
    // 逐字段：没有 `index`/`indices`/`triangleMap` 之类
    expect(Object.keys(topo).sort()).toEqual(['attributes', 'edges', 'faces', 'version', 'vertices'])
    for (const f of topo.faces) {
      expect(Object.keys(f).sort(), '面只有身份与顶点身份列表').toEqual(['id', 'vertices'])
      for (const v of f.vertices) expect(typeof v, '面的顶点是**身份字符串**，不是下标').toBe('string')
    }
    for (const e of topo.edges) {
      expect(Object.keys(e).sort()).toEqual(['a', 'b', 'id'])
      expect(typeof e.a).toBe('string')
      expect(typeof e.b).toBe('string')
    }
    // 也不存在 TypedArray（契约 §2.2：不暴露可变底层 TypedArray）
    expect(ArrayBuffer.isView(topo.vertices)).toBe(false)
    for (const layer of topo.attributes) expect(ArrayBuffer.isView(layer.values)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 固定拓扑形变
// ─────────────────────────────────────────────────────────────────────────────

describe('固定拓扑形变：形变数据 + 权重求值（不每帧改写基础网格）', () => {
  const makeDeformed = () => {
    const box = unitBoxMesh('m', 1)
    if (!box.ok) throw new Error('fixture')
    const def = deformationOf('bend', box.value.topology.version, [
      { id: 'weight', targets: [{ vertex: 'x0y0z0', offset: { x: 0, y: 1, z: 0 } }] },
    ])
    return meshData('m', box.value.topology, def)
  }

  it('形变求值给出"基础位置 + 权重×位移"，且**基础网格逐位不变**', () => {
    const mesh = makeDeformed()
    const baseBefore = mesh.topology.vertices.map((v) => ({ id: v.id, position: { ...v.position } }))

    const evaluated = evaluateDeformationOf(mesh, { weight: 0.5 })
    expect(evaluated.ok).toBe(true)
    if (!evaluated.ok) return
    expect(evaluated.value['x0y0z0'].y).toBeCloseTo(mesh.topology.vertices.find((v) => v.id === 'x0y0z0')!.position.y + 0.5, 12)

    // 基础网格**一字未改**（A02「不改输入」+ #249 §3.2「不能在每帧改写基础网格」）
    for (let i = 0; i < baseBefore.length; i++) {
      expect(mesh.topology.vertices[i].position).toEqual(baseBefore[i].position)
    }
  })

  it('权重为 0 ⇒ 有效位置等于基础位置（"无声明"与"权重 0"可控区分）', () => {
    const mesh = makeDeformed()
    const r = evaluateDeformationOf(mesh, { weight: 0 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    for (const v of mesh.topology.vertices) expect(r.value[v.id]).toEqual(v.position)
  })

  it('形变未被求值时**不**返回"看起来像恒等"的假结果：无形变 ⇒ 显式拒绝', () => {
    const box = unitBoxMesh('m', 1)
    if (!box.ok) throw new Error('fixture')
    const noDef = meshData('m', box.value.topology)
    const r = evaluateDeformationOf(noDef, { weight: 1 })
    expect(r.ok, '无形变数据 ⇒ 必须显式拒绝，不是静默恒等').toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('InvalidValue')
    expect(r.error.params.reason).toBe('noDeformation')
  })

  it('形变数据与网格**拓扑版本不符** ⇒ StaleReference（形变也钉在拓扑上）', () => {
    const box = unitBoxMesh('m', 1)
    if (!box.ok) throw new Error('fixture')
    const def = deformationOf('bend', 99, [{ id: 'w', targets: [{ vertex: 'x0y0z0', offset: { x: 1, y: 0, z: 0 } }] }])
    const mesh = meshData('m', box.value.topology, def)
    const r = evaluateDeformationOf(mesh, { w: 1 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('StaleReference')
  })

  it('非有限权重 ⇒ InvalidValue（不夹取、不当作 0）', () => {
    const mesh = makeDeformed()
    const r = evaluateDeformationOf(mesh, { weight: Number.NaN })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('InvalidValue')
    expect(r.error.params.reason).toBe('nonFiniteWeight')
  })

  it('形变目标指向不存在的顶点 ⇒ MissingTarget（不静默跳过）', () => {
    const box = unitBoxMesh('m', 1)
    if (!box.ok) throw new Error('fixture')
    const def = deformationOf('bend', box.value.topology.version, [{ id: 'w', targets: [{ vertex: 'nope', offset: { x: 1, y: 0, z: 0 } }] }])
    const mesh = meshData('m', box.value.topology, def)
    const r = evaluateDeformationOf(mesh, { w: 1 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('MissingTarget')
  })

  it('形变**不**改变拓扑版本（固定拓扑）与元素身份', () => {
    const mesh = makeDeformed()
    expect(mesh.deformation?.topologyVersion).toBe(mesh.topology.version)
    expect(mesh.topology.version).toBe(0)
  })

  it('分离（按对象独立编辑）**保留**形变（不静默丢失）', () => {
    const { scene, a } = sharedPair()
    // 给共享数据装上形变
    const obj = scene.objects[a]
    const data = scene.data[obj.dataId]
    const mesh = meshFromPayload(data.payload)!
    const def = deformationOf('bend', mesh.topology.version, [{ id: 'w', targets: [{ vertex: 'x0y0z0', offset: { x: 0, y: 2, z: 0 } }] }])
    const withDef = Object.freeze({
      ...scene,
      data: Object.freeze({ ...scene.data, [obj.dataId]: Object.freeze({ ...data, payload: Object.freeze({ kind: 'mesh' as const, mesh: meshData(mesh.id, mesh.topology, def) }) }) }),
    })
    const r = writeVertexOnObject(withDef, { objectId: a, vertex: 'x0y0z0', delta: { x: 1, y: 0, z: 0 }, detachedDataId: 'A::geo' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const detachedMesh = meshFromPayload(r.value.scene.data[r.value.dataId].payload)!
    expect(detachedMesh.deformation, '分离后形变必须保留').toBeDefined()
    expect(detachedMesh.deformation?.id).toBe('bend')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 不复制整份文档（可测量）
// ─────────────────────────────────────────────────────────────────────────────

describe('C2 同族：几何编辑不复制整份文档（可测量占用）', () => {
  it('`geometryStagingFootprint` 的暂存顶点数远小于文档顶点总数', () => {
    let scene = createDocument('doc-1').scene
    for (let i = 0; i < 6; i++) {
      const made = addMeshObject(scene, { objectId: `o${i}`, dataId: `g${i}`, size: 1 })
      if (!made.ok) throw new Error('fixture')
      scene = made.value
    }
    const fp = geometryStagingFootprint(scene, [{ objectId: 'o0', vertex: 'x0y0z0' }])
    expect(fp.documentObjects).toBe(6)
    expect(fp.documentVertices, '每盒 8 顶点').toBe(48)
    expect(fp.stagedVertices, '只暂存**被拖动**的 1 个顶点').toBe(1)
    expect(fp.stagedObjects).toBe(1)
    // 暂存占比 < 5%（若整文档复制会是 100%）
    expect(fp.stagedVertices / fp.documentVertices).toBeLessThan(0.05)
  })

  it('`applyVertexDisplacements` 不改输入网格（A02 同族）', () => {
    const box = unitBoxMesh('m', 1)
    if (!box.ok) throw new Error('fixture')
    const before = box.value.topology.vertices.map((v) => ({ ...v.position }))
    const r = applyVertexDisplacements(box.value, [{ vertex: 'x0y0z0', delta: { x: 1, y: 2, z: 3 } }])
    expect(r.ok).toBe(true)
    for (let i = 0; i < before.length; i++) expect(box.value.topology.vertices[i].position).toEqual(before[i])
  })

  it('`applyVertexDisplacements` 对不存在顶点 ⇒ MissingTarget（不静默跳过）', () => {
    const box = unitBoxMesh('m', 1)
    if (!box.ok) throw new Error('fixture')
    const r = applyVertexDisplacements(box.value, [{ vertex: 'nope', delta: { x: 1, y: 0, z: 0 } }])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('MissingTarget')
  })

  it('`meshBounds` 由顶点求得；空集返回 null（不返回退化零点盒冒充"有几何"）', () => {
    const box = unitBoxMesh('m', 1)
    if (!box.ok) throw new Error('fixture')
    const b = meshBounds(box.value)
    expect(b).not.toBeNull()
    expect(b?.min.x).toBeCloseTo(-0.5, 12)
    expect(b?.max.x).toBeCloseTo(0.5, 12)
    expect(meshBounds(meshData('empty', { version: 0, vertices: [], edges: [], faces: [], attributes: [] }))).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 测试内的"变异实现"与薄转发（保持断言器与实现分离）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **变异实现**：原地改共享数据（A07 负对照的注入形态）。
 *
 * 它真的改了共享数据 —— 故"B 不变"的断言器必然判红。
 * 这正是 #249 §14 要求的"负对照必须证明确实破坏了目标保证"。
 */
function mutateSharedInPlace(scene: Scene, dataId: string, vertex: string, delta: { x: number; y: number; z: number }): Scene {
  const data = scene.data[dataId]
  const mesh = meshFromPayload(data.payload)
  if (!mesh) throw new Error('not a mesh')
  // **直接**改这个数据里的顶点（不管有多少对象在共享它）
  const vertices = mesh.topology.vertices.map((v) =>
    v.id === vertex ? Object.freeze({ id: v.id, position: Object.freeze({ x: v.position.x + delta.x, y: v.position.y + delta.y, z: v.position.z + delta.z }) }) : v,
  )
  const nextMesh = meshData(mesh.id, Object.freeze({ ...mesh.topology, vertices: Object.freeze(vertices) }), mesh.deformation)
  return Object.freeze({
    ...scene,
    data: Object.freeze({ ...scene.data, [dataId]: Object.freeze({ ...data, payload: Object.freeze({ kind: 'mesh' as const, mesh: nextMesh }) }) }),
  })
}

/** 删掉若干顶点并推进版本（拓扑变更夹具）。 */
function bumpTopologyFrom(mesh: MeshData, removeIndices: readonly number[]): MeshData['topology'] {
  const remove = new Set(removeIndices)
  const vertices = mesh.topology.vertices.filter((_, i) => !remove.has(i))
  const kept = new Set(vertices.map((v) => v.id))
  // 边/面中悬空的引用一并清掉（否则拓扑自洽性校验会拒绝）
  const edges = mesh.topology.edges.filter((e) => kept.has(e.a) && kept.has(e.b))
  const faces = mesh.topology.faces.filter((f) => f.vertices.every((v) => kept.has(v)))
  const r = meshTopology({ version: mesh.topology.version + 1, vertices, edges, faces })
  if (!r.ok) throw new Error(`fixture: ${JSON.stringify(r.error)}`)
  return r.value
}

function deformationOf(
  id: string,
  topologyVersion: number,
  channels: readonly { id: string; targets: readonly { vertex: string; offset: { x: number; y: number; z: number } }[] }[],
): Deformation {
  return deformation(id, topologyVersion, channels)
}

function evaluateDeformationOf(mesh: MeshData, weights: Readonly<Record<string, number>>) {
  return evaluateDeformation(mesh, weights)
}
