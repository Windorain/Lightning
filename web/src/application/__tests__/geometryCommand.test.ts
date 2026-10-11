/**
 * `application/geometry-command` —— **网格顶点写经由唯一写路由**
 * （契约 §5.2、§1.3；#249 §14 A07/A08、§3.3；#254 E1）。
 *
 * ## 本文件在 GF-5 收敛后的形态（#254 变基吸收）
 *
 * 收敛把属性语义的唯一权威移交给 **RNA 注册表**（`application/properties.ts` +
 * `kernel-properties.ts`），并删除了 `commands.ts` 里的内联白名单
 * （`validatePropertyWrite` / `applyPropertyValue` / `isStructuralProperty`）。
 * 故本文件在变基后**改走公开的 `Editor` 面**（`submit`/`drain`/`settlement`），
 * 而不是直接摸 `reduceCommand` + 自造 `ApplicationState`（那是收敛前的写法）。
 *
 * ## 本文件要证的四件事
 *
 * 1. **几何写没有第二条通路**：顶点写走 `setProperty`（`PropertyRef.element` 承载
 *    子元素寻址），不是新加一条 `setVertexPosition` 命令。命令联合的封闭性由
 *    `kernel-legacy-isolation.test.ts` 从**源码**层断言（`kind:` 字面量集合），
 *    故"偷偷加一条几何命令"会被它判红。
 *
 * 2. **`StaleReference` 在收敛后的 RNA 判据上自动生效**：过期判定是
 *    `properties.ts#staleReason(ref, facts)`，其 `facts.topologyVersion` 来自
 *    `ObjectData.topologyVersion`。本批（P3）把后者由硬编码 `0` 改为**由载荷导出**，
 *    正是让该判定对网格**正确**的前提（见下）。
 *
 * 3. **A08 多选原子性**：`applySetProperty` 的三阶段（全量预检 → 无变化判定 →
 *    单次提交）保证"一个目标不可写即整体拒绝，先前的目标也**没被写**"。
 *
 * 4. **写权按拥有者判定**（#249 §3.3）：多方块生成物（`source === 'content'`）的网格
 *    **不可**写，而同一文档里的可编辑网格**仍可**写 —— 不符整份文档一个布尔值。
 *
 * ## 为什么"过期引用"这条依赖 P3 的修正（变基时的语义交汇点）
 *
 * `staleReason` 比较 `ref.element.topologyVersion` 与 `facts.topologyVersion`
 * （= `ObjectData.topologyVersion`）。若该字段仍是硬编码 `0`，而引用是按网格
 * **真实**拓扑版本（`elementRefOf`）构造的，那么网格版本 > 0 时**有效引用会被误判过期**。
 * 故本文件同时覆盖"版本相符（相对当前文档）"与"版本不符 ⇒ `StaleReference`"两侧，
 * 并用一条独立断言锁定"拓扑版本由载荷导出"，使硬编码回归立刻判红。
 */

import { describe, expect, it } from 'vitest'
import { Editor } from '@/runtime/execution'
import { VIEWER_CAPABILITIES, reduceCommand } from '@/application/commands'
import { KERNEL_MESH_TYPE, KERNEL_OBJECT_TYPES, KERNEL_OBJECT_TYPE_IDS } from '@/application/kernel-properties'
import { withScene } from '@/domain/document'
import { findObject, findObjectData, objectData } from '@/domain/scene'
import { elementRef, objectRef, propertyRef } from '@/domain/identity'
import { bumpTopology, elementRefOf, meshData, meshFromPayload } from '@/domain/geometry'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具：打开一个含网格对象的内核文档（全程经公开命令，不手搓状态）
// ─────────────────────────────────────────────────────────────────────────────

/** 打开文档并加一个网格对象；返回编辑器与网格对象 id。 */
function openWithMesh(meshSize?: number): { e: Editor; oid: string } {
  const e = new Editor()
  e.submit({ kind: 'openDocument', documentId: 'doc-1', contextId: 'ctx-1' })
  e.submit({
    kind: 'addObject',
    contextId: 'ctx-1',
    objectType: 'mesh',
    ...(meshSize === undefined ? {} : { meshSize }),
  })
  e.drain()
  const oid = Object.keys(e.snapshot().docs['doc-1'].scene.objects)[0]
  return { e, oid }
}

const sceneOf = (e: Editor) => e.snapshot().docs['doc-1'].scene
const docOf = (e: Editor) => e.snapshot().docs['doc-1']

/** 取某对象的网格与数据事实（id / 内容版本 / 拓扑版本）。 */
function meshFacts(e: Editor, oid: string) {
  const scene = sceneOf(e)
  const obj = findObject(scene, oid)
  if (!obj) throw new Error('fixture: object missing')
  const data = findObjectData(scene, obj.dataId)
  if (!data) throw new Error('fixture: data missing')
  const mesh = meshFromPayload(data.payload)
  if (!mesh) throw new Error('fixture: not a mesh')
  return { mesh, dataId: data.id, contentVersion: data.contentVersion, topologyVersion: data.topologyVersion }
}

/** 造一个指向某顶点的限定式属性引用（属性 ID = `mesh.vertexPosition`）。 */
function vertexRefAt(e: Editor, oid: string, vertexId: string, topologyVersionOffset = 0) {
  const { contentVersion, topologyVersion } = meshFacts(e, oid)
  return propertyRef(objectRef(oid, contentVersion), `${KERNEL_MESH_TYPE}.vertexPosition`, {
    element: elementRef(vertexId, topologyVersion + topologyVersionOffset),
  })
}

/** 提交一次顶点写并返回结算结果。 */
function writeVertex(e: Editor, oid: string, vertexId: string, value: { x: number; y: number; z: number }) {
  const ticket = e.submit({ kind: 'setProperty', refs: [vertexRefAt(e, oid, vertexId)], value })
  e.drain()
  return e.settlement(ticket)
}

function vertexPosition(e: Editor, oid: string, vertexId: string) {
  const { mesh } = meshFacts(e, oid)
  const v = mesh.topology.vertices.find((x) => x.id === vertexId)
  if (!v) throw new Error(`fixture: vertex ${vertexId} missing`)
  return v.position
}

// ─────────────────────────────────────────────────────────────────────────────
// 0. 注册面：mesh 走**公开注册路径**，不是核心分派改写
// ─────────────────────────────────────────────────────────────────────────────

describe('mesh 类型经公开注册路径进入内核（#249 §13「不改核心 switch」）', () => {
  it('`mesh` 已登记在对象类型全集与 RNA 声明表中', () => {
    expect(KERNEL_OBJECT_TYPE_IDS).toContain(KERNEL_MESH_TYPE)
    const decl = KERNEL_OBJECT_TYPES.find((t) => t.id === KERNEL_MESH_TYPE)
    expect(decl, 'mesh 必须有 RNA 声明（否则属性写被判 property-not-registered）').toBeTruthy()
    const ids = (decl?.properties ?? []).map((p) => p.id)
    expect(ids).toContain('vertexPosition')
    // 变换与结构属性与其它类型一致（变换属对象自身，不属类型 —— #249 §3.1）
    expect(ids).toContain('transform.position')
    expect(ids).toContain('name')
  })

  it('`vertexPosition` 标记为**不可动画**（有意：动画走形变权重，不每帧改写基础网格）', () => {
    const decl = KERNEL_OBJECT_TYPES.find((t) => t.id === KERNEL_MESH_TYPE)
    const vp = decl?.properties.find((p) => p.id === 'vertexPosition')
    expect(vp).toBeTruthy()
    // #249 §3.2「不能在每帧改写基础网格」+ §7「固定拓扑形变经形变权重驱动」
    expect(vp?.animatable, '把基础顶点标为可动画＝给"每帧写基础值"留合法通道（A09 负对照）').toBe(false)
    // 而"不可动画"**不**妨碍它可写
    expect(vp?.valueType).toBe('vec3')
  })

  it('**负对照**：未登记的属性 ⇒ 写被显式拒绝（不是静默成功）', () => {
    const { e, oid } = openWithMesh()
    const ticket = e.submit({
      kind: 'setProperty',
      refs: [propertyRef(objectRef(oid, meshFacts(e, oid).contentVersion), 'mesh.noSuchProperty')],
      value: 1,
    })
    e.drain()
    const outcome = e.settlement(ticket)
    expect(outcome?.status).toBe('rejected')
    if (outcome?.status !== 'rejected') return
    expect(['UnsupportedOperation', 'MissingTarget']).toContain(outcome.error.code)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 1. 顶点写经唯一写路由
// ─────────────────────────────────────────────────────────────────────────────

describe('顶点写走**唯一**写路由（`setProperty` + `PropertyRef.element`）', () => {
  it('`setProperty` 能写网格顶点，且文档版本推进、历史记账一条', () => {
    const { e, oid } = openWithMesh()
    const before = docOf(e).version
    const historyBefore = docOf(e).history.past.length
    const vertex = meshFacts(e, oid).mesh.topology.vertices[0].id

    const outcome = writeVertex(e, oid, vertex, { x: 5, y: 0, z: 0 })
    expect(outcome?.status).toBe('applied')
    if (outcome?.status !== 'applied') return

    expect(outcome.version.documentVersion).toBe(before.documentVersion + 1)
    expect(outcome.version.contentVersion).not.toBe(before.contentVersion)
    expect(docOf(e).history.past.length, '历史恰好 +1（唯一提交协议）').toBe(historyBefore + 1)
    expect(vertexPosition(e, oid, vertex).x).toBe(5)
  })

  it('写相同值 ⇒ `unchanged`（不推进版本、不新增历史 —— 幽灵历史防线）', () => {
    const { e, oid } = openWithMesh()
    const cur = vertexPosition(e, oid, 'x0y0z0')
    const versionBefore = docOf(e).version
    const historyBefore = docOf(e).history.past.length

    const outcome = writeVertex(e, oid, 'x0y0z0', { x: cur.x, y: cur.y, z: cur.z })
    expect(outcome?.status).toBe('unchanged')
    expect(docOf(e).version).toBe(versionBefore)
    expect(docOf(e).history.past.length).toBe(historyBefore)
  })

  it('**E1**：`topologyVersion` 过期的元素引用 ⇒ `StaleReference`（不是 MissingTarget、不猜配）', () => {
    const { e, oid } = openWithMesh()
    const { topologyVersion } = meshFacts(e, oid)
    const ticket = e.submit({
      kind: 'setProperty',
      // 伪造一个"旧拓扑版本"的引用
      refs: [vertexRefAt(e, oid, 'x0y0z0', 99)],
      value: { x: 1, y: 1, z: 1 },
    })
    e.drain()
    const outcome = e.settlement(ticket)
    expect(outcome?.status).toBe('rejected')
    if (outcome?.status !== 'rejected') return
    expect(outcome.error.code, '必须是 StaleReference').toBe('StaleReference')
    expect(outcome.error.params.expected).toBe(topologyVersion + 99)
    expect(outcome.error.params.actual).toBe(topologyVersion)
  })

  it('**P3 修正的前提**：`ObjectData.topologyVersion` 是**真实的**载荷拓扑版本（非硬编码 0）', () => {
    const { e, oid } = openWithMesh()
    const { topologyVersion } = meshFacts(e, oid)
    expect(topologyVersion, '新盒子的拓扑版本').toBe(0)

    // 把数据的网格推进到版本 1，断言**导出的**版本随之改变。
    // 若 `objectData` 仍硬编码 0，本断言判红 —— 那正是"有效引用被误判过期"的根因。
    const scene = sceneOf(e)
    const obj = findObject(scene, oid)!
    const data = findObjectData(scene, obj.dataId)!
    const mesh = meshFromPayload(data.payload)!
    const bumped = bumpTopology(mesh.topology, { attributes: [] })
    expect(bumped.ok).toBe(true)
    if (!bumped.ok) return
    const bumpedMesh = meshData(mesh.id, bumped.value, mesh.deformation)
    const nextData = objectData(data.id, Object.freeze({ kind: 'mesh' as const, mesh: bumpedMesh }), data.source)
    expect(nextData.topologyVersion, '拓扑版本必须由载荷导出').toBe(1)
    expect(nextData.topologyVersion).not.toBe(0)
    void scene
  })

  it('**版本相符**时才可写（防"过期判定"过宽而误拒有效引用）', () => {
    const { e, oid } = openWithMesh()
    const { topologyVersion } = meshFacts(e, oid)
    // 偏移 0 ⇒ 与当前文档一致 ⇒ 应被接受
    const ticket = e.submit({
      kind: 'setProperty',
      refs: [vertexRefAt(e, oid, 'x0y0z0', 0)],
      value: { x: 2, y: 0, z: 0 },
    })
    e.drain()
    const outcome = e.settlement(ticket)
    expect(outcome?.status, '版本一致的引用必须可写（否则过期判定过宽）').toBe('applied')
    expect(topologyVersion).toBe(0)
  })

  it('**负对照**：不带 `element` 的顶点写 ⇒ 拒绝（不得退化成"随便挑一个顶点"）', () => {
    const { e, oid } = openWithMesh()
    const ticket = e.submit({
      kind: 'setProperty',
      refs: [propertyRef(objectRef(oid, meshFacts(e, oid).contentVersion), `${KERNEL_MESH_TYPE}.vertexPosition`)],
      value: { x: 1, y: 0, z: 0 },
    })
    e.drain()
    const outcome = e.settlement(ticket)
    expect(outcome?.status, '缺元素身份的顶点写必须被拒绝').toBe('rejected')
    if (outcome?.status !== 'rejected') return
    expect(['InvalidValue', 'UnsupportedOperation', 'MissingTarget', 'StaleReference']).toContain(outcome.error.code)
  })

  it('元素引用指向**不存在**的顶点（版本对）⇒ 拒绝且文档未变', () => {
    const { e, oid } = openWithMesh()
    const versionBefore = docOf(e).version
    const ticket = e.submit({
      kind: 'setProperty',
      refs: [vertexRefAt(e, oid, 'no-such-vertex', 0)],
      value: { x: 1, y: 0, z: 0 },
    })
    e.drain()
    const outcome = e.settlement(ticket)
    expect(outcome?.status).toBe('rejected')
    if (outcome?.status !== 'rejected') return
    expect(['MissingTarget', 'InvalidValue']).toContain(outcome.error.code)
    expect(docOf(e).version, '拒绝不推进版本').toBe(versionBefore)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. A08 多选原子性（收敛后由 `applySetProperty` 三阶段承担）
// ─────────────────────────────────────────────────────────────────────────────

describe('A08 多选原子性：一个目标不可写 ⇒ 整体拒绝，先前的目标也没被写', () => {
  it('两个顶点，一个过期 ⇒ 整体拒绝且**第一个逐位未变**', () => {
    const { e, oid } = openWithMesh()
    const before0 = vertexPosition(e, oid, 'x0y0z0')
    const before1 = vertexPosition(e, oid, 'x1y1z1')

    const ticket = e.submit({
      kind: 'setProperty',
      refs: [
        vertexRefAt(e, oid, 'x0y0z0', 0), // 完全合法
        vertexRefAt(e, oid, 'x1y1z1', 99), // 拓扑版本过期
      ],
      value: { x: 3, y: 3, z: 3 },
    })
    e.drain()
    const outcome = e.settlement(ticket)

    expect(outcome?.status, '一个失败即整体拒绝（不静默部分成功）').toBe('rejected')
    if (outcome?.status !== 'rejected') return
    expect(outcome.error.code).toBe('StaleReference')

    // **原子性**：第一个顶点必须逐位未变
    // （若实现是"逐个写、遇失败才停"，它此时已被改写 ⇒ 本断言判红）
    expect(vertexPosition(e, oid, 'x0y0z0')).toEqual(before0)
    expect(vertexPosition(e, oid, 'x1y1z1')).toEqual(before1)
  })

  it('两个**都合法** ⇒ 两个都写入（原子批次的正向面）', () => {
    const { e, oid } = openWithMesh()
    const ticket = e.submit({
      kind: 'setProperty',
      refs: [vertexRefAt(e, oid, 'x0y0z0', 0), vertexRefAt(e, oid, 'x1y1z1', 0)],
      value: { x: 9, y: 0, z: 0 },
    })
    e.drain()
    const outcome = e.settlement(ticket)
    expect(outcome?.status).toBe('applied')
    expect(vertexPosition(e, oid, 'x0y0z0').x).toBe(9)
    expect(vertexPosition(e, oid, 'x1y1z1').x).toBe(9)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. 写权按拥有者判定（#249 §3.3；契约 §3.2 ReadOnly 负对照）
// ─────────────────────────────────────────────────────────────────────────────

describe('写权按**拥有者/内容来源**判定（不用整份文档一个布尔值）', () => {
  it('只读内容网格拒绝，**同一文档**的可编辑网格仍可写', () => {
    // 经公开命令建两个网格对象，然后把其中一个的数据标为 `content` 来源
    // （模拟多方块生成物；生产上该来源由生成物类型贡献方给出）。
    const base = new Editor()
    base.submit({ kind: 'openDocument', documentId: 'doc-1', contextId: 'ctx-1' })
    base.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'mesh', name: 'RO' })
    base.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'mesh', name: 'RW' })
    base.drain()

    const state = base.snapshot()
    const doc = state.docs['doc-1']
    const objs = Object.values(doc.scene.objects)
    const ro = objs.find((o) => o.name === 'RO')!
    const rw = objs.find((o) => o.name === 'RW')!
    const dataMap = { ...doc.scene.data }
    dataMap[ro.dataId] = Object.freeze({ ...dataMap[ro.dataId], source: 'content' as const })
    const nextScene = Object.freeze({ ...doc.scene, data: Object.freeze(dataMap) })
    const nextDoc = withScene(doc, nextScene).doc
    const st2 = Object.freeze({ ...state, docs: Object.freeze({ ...state.docs, 'doc-1': nextDoc }) })

    const e2 = new Editor({ initial: st2 })
    const scene2 = e2.snapshot().docs['doc-1'].scene
    const dataOf = (id: string) => findObjectData(scene2, findObject(scene2, id)!.dataId)!
    const refFor = (id: string) =>
      propertyRef(objectRef(id, dataOf(id).contentVersion), `${KERNEL_MESH_TYPE}.vertexPosition`, {
        element: elementRef('x0y0z0', dataOf(id).topologyVersion),
      })

    // RO（content 来源）⇒ 拒绝，且**原因指向拥有者**（不是"文档只读"）
    const roTicket = e2.submit({ kind: 'setProperty', refs: [refFor(ro.id)], value: { x: 1, y: 0, z: 0 } })
    e2.drain()
    const roOutcome = e2.settlement(roTicket)
    expect(roOutcome?.status).toBe('rejected')
    if (roOutcome?.status !== 'rejected') return
    expect(roOutcome.error.code, '必须按拥有者判 ReadOnly').toBe('ReadOnly')

    // RW（同文档、document 来源）⇒ **仍可写**（这就是"不用文档级布尔"的证伪点）
    const rwTicket = e2.submit({ kind: 'setProperty', refs: [refFor(rw.id)], value: { x: 4, y: 0, z: 0 } })
    e2.drain()
    const rwOutcome = e2.settlement(rwTicket)
    expect(rwOutcome?.status, '同文档内可编辑对象必须仍可写（ReadOnly 负对照）').toBe('applied')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. 共享几何：经命令层的按对象独立编辑（A07 的可观测面）
// ─────────────────────────────────────────────────────────────────────────────

describe('A07 经命令层：仅编辑 A ⇒ B 逐位不变（共享几何按对象独立编辑）', () => {
  it('A/B 共享数据；写 A 顶点后 B 仍指向**原数据**且位置未变', () => {
    const base = new Editor()
    base.submit({ kind: 'openDocument', documentId: 'doc-1', contextId: 'ctx-1' })
    base.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'mesh', name: 'A' })
    base.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'mesh', name: 'B' })
    base.drain()

    const state = base.snapshot()
    const doc = state.docs['doc-1']
    const objs = Object.values(doc.scene.objects)
    const a = objs.find((o) => o.name === 'A')!
    const b = objs.find((o) => o.name === 'B')!
    // B 改指 A 的数据，并删掉 B 自己的数据（避免孤儿）
    const objects = { ...doc.scene.objects, [b.id]: Object.freeze({ ...b, dataId: a.dataId }) }
    const dataMap = { ...doc.scene.data }
    delete dataMap[b.dataId]
    const shared = Object.freeze({ ...doc.scene, objects: Object.freeze(objects), data: Object.freeze(dataMap) })
    const sharedDoc = withScene(doc, shared).doc
    const st2 = Object.freeze({ ...state, docs: Object.freeze({ ...state.docs, 'doc-1': sharedDoc }) })
    const e2 = new Editor({ initial: st2 })

    const scene2 = e2.snapshot().docs['doc-1'].scene
    const sharedData = findObjectData(scene2, a.dataId)!
    const mesh = meshFromPayload(sharedData.payload)!
    const vertex = mesh.topology.vertices[0].id
    const bBefore = mesh.topology.vertices[0].position

    const ticket = e2.submit({
      kind: 'setProperty',
      refs: [
        propertyRef(objectRef(a.id, sharedData.contentVersion), `${KERNEL_MESH_TYPE}.vertexPosition`, {
          element: elementRefOf(mesh.topology, vertex),
        }),
      ],
      value: { x: bBefore.x + 0.25, y: bBefore.y, z: bBefore.z },
    })
    e2.drain()
    const outcome = e2.settlement(ticket)
    expect(outcome?.status, '顶点写必须成功').toBe('applied')
    if (outcome?.status !== 'applied') return

    const after = e2.snapshot().docs['doc-1'].scene
    const aAfter = findObject(after, a.id)!
    const bAfter = findObject(after, b.id)!
    // A 被分离（拿到自己的新数据）
    expect(aAfter.dataId, 'A 的数据被分离').not.toBe(a.dataId)
    // B 仍指向**原**数据，且其顶点位置逐位未变
    expect(bAfter.dataId, 'B 仍指向原数据').toBe(a.dataId)
    const bMeshAfter = meshFromPayload(findObjectData(after, bAfter.dataId)!.payload)!
    expect(bMeshAfter.topology.vertices[0].position, 'B 逐位不变').toEqual(bBefore)
    // A 的顶点确实变了（否则"B 不变"可能只是"谁都没变"）
    const aMeshAfter = meshFromPayload(findObjectData(after, aAfter.dataId)!.payload)!
    expect(aMeshAfter.topology.vertices.find((v) => v.id === vertex)!.position.x).toBeCloseTo(bBefore.x + 0.25, 12)
    // 原数据仍在（无丢失）
    expect(findObjectData(after, a.dataId)).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. `addObject` 的网格面与能力裁剪
// ─────────────────────────────────────────────────────────────────────────────

describe('`addObject` 网格面与能力裁剪', () => {
  it('`addObject` 支持 `mesh`；载荷种类与拓扑版本一致', () => {
    const { e, oid } = openWithMesh()
    const obj = findObject(sceneOf(e), oid)!
    expect(obj.type).toBe('mesh')
    const data = findObjectData(sceneOf(e), obj.dataId)!
    expect(data.payload.kind).toBe('mesh')
    expect(data.topologyVersion).toBe(0)
    expect(meshFromPayload(data.payload), '载荷可解析为网格').toBeDefined()
  })

  it('网格尺寸非法 ⇒ 显式 InvalidValue.reason=badBoxSize（不压成"id 冲突"）', () => {
    const e = new Editor()
    e.submit({ kind: 'openDocument', documentId: 'doc-1', contextId: 'ctx-1' })
    const ticket = e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'mesh', meshSize: -1 })
    e.drain()
    const outcome = e.settlement(ticket)
    expect(outcome?.status).toBe('rejected')
    if (outcome?.status !== 'rejected') return
    expect(outcome.error.code).toBe('InvalidValue')
    expect(outcome.error.params.reason).toBe('badBoxSize')
  })

  it('能力裁剪：无 `content.edit` 时顶点写被**运行时**拒绝（不只靠 UI 隐藏）', () => {
    // `Editor` 的公开构造面不提供能力注入（能力由 profile 装配决定），故本条的
    // 可执行形式与基线一致：经 `reduceCommand` **显式**传查看器能力集。
    // 这是能力裁剪的**运行时**拒绝面（A15 负对照：不得只靠 UI 隐藏按钮）。
    const base = new Editor()
    base.submit({ kind: 'openDocument', documentId: 'doc-1', contextId: 'ctx-1' })
    base.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'mesh' })
    base.drain()

    const before = base.snapshot()
    const st = before.docs['doc-1'].scene
    const oid = Object.keys(st.objects)[0]
    const data = findObjectData(st, findObject(st, oid)!.dataId)!
    const mesh = meshFromPayload(data.payload)!

    const rejected = reduceCommand(
      before,
      {
        kind: 'setProperty',
        refs: [
          propertyRef(objectRef(oid, data.contentVersion), `${KERNEL_MESH_TYPE}.vertexPosition`, {
            element: elementRefOf(mesh.topology, mesh.topology.vertices[0].id),
          }),
        ],
        value: { x: 1, y: 0, z: 0 },
      },
      { capabilities: [...VIEWER_CAPABILITIES] },
    )
    expect(rejected.status, '查看器 profile 下内容编辑必须被运行时拒绝').toBe('rejected')
    if (rejected.status !== 'rejected') return
    expect(rejected.error.code).toBe('UnsupportedOperation')
    expect(rejected.state, '拒绝零残留').toBe(before)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. 只读视图：网格载荷可读，且不暴露可变 TypedArray
// ─────────────────────────────────────────────────────────────────────────────

describe('读面：网格载荷可读且不暴露可变底层 TypedArray', () => {
  it('`objects.data` 能取回网格载荷；属性层与顶点都是普通只读结构', () => {
    const { e, oid } = openWithMesh()
    const view = e.read({ documentId: 'doc-1', contextId: 'ctx-1' })
    expect(view).toBeTruthy()
    const obj = findObject(sceneOf(e), oid)!
    const got = view.objects.data(obj.dataId)
    expect(got.ok).toBe(true)
    if (!got.ok) return
    const mesh = meshFromPayload(got.value.payload)
    expect(mesh).toBeDefined()
    for (const layer of mesh!.topology.attributes) expect(ArrayBuffer.isView(layer.values)).toBe(false)
    expect(ArrayBuffer.isView(mesh!.topology.vertices)).toBe(false)
  })

  it('反空洞真：`ReadView` 确实返回了网格（否则上一条可能只是"没解析到"）', () => {
    const { e, oid } = openWithMesh()
    const view = e.read({ documentId: 'doc-1', contextId: 'ctx-1' })
    const obj = findObject(sceneOf(e), oid)!
    const got = view.objects.data(obj.dataId)
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.value.payload.kind).toBe('mesh')
  })
})
