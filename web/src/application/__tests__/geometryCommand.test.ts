/**
 * `application/geometry-command` —— **网格顶点写经由唯一写路由**
 * （契约 §5.2、§1.3；#249 §14 A07/A08、§3.3；#254 E1）。
 *
 * ## 本文件要证的三件事
 *
 * 1. **几何写没有第二条通路**：顶点位置写走 `setProperty`（`PropertyRef.element`
 *    承载子元素寻址），不是新加一条 `setVertexPosition` 命令。
 *    这是契约 §5.2「不存在第二条属性写通路」在几何上的落地 ——
 *    项目既有的 `kernel-legacy-isolation.test.ts` 会从**源码**层面断言命令联合
 *    的封闭性（`kind:` 字面量集合与契约一致），故"偷偷加一条几何命令"会被它判红。
 *
 * 2. **`StaleReference` 在命令层自动生效**：`validatePropertyWrite` 里那条
 *    「`ref.element.topologyVersion !== data.topologyVersion` ⇒ 拒绝」是 P1 就有的，
 *    本批**没有**为几何另开校验分支。故"拓扑一变、旧引用必须失效"由既有单点承担。
 *
 * 3. **写权按拥有者判定**（#249 §3.3）：多方块生成物（`source === 'content'`）
 *    的网格**不可**写，而同一文档里的可编辑网格**仍可**写 ——
 *    不使用整份文档一个布尔值（契约 §3.2 的 ReadOnly 负对照）。
 */

import { describe, expect, it } from 'vitest'
import {
  ALL_CAPABILITIES,
  defaultExecutionInputs,
  openDocumentState,
  reduceCommand,
  type Command,
  type ExecutionInputs,
} from '@/application/commands'
import type { ApplicationState } from '@/application/state'
import { captureReadView } from '@/application/queries'
import { addMeshObject, withScene } from '@/domain/document'
import type { Scene } from '@/domain/scene'
import { findObject, findObjectData, objectData, sceneObject, withObject } from '@/domain/scene'
import { meshFromPayload } from '@/domain/geometry'
import { elementRef, objectRef, propertyRef } from '@/domain/identity'

const ENV: ExecutionInputs = defaultExecutionInputs(ALL_CAPABILITIES)

/** 建一个"文档 + 一个网格对象"的状态（经既有命令，不手搓状态）。 */
function stateWithMesh(): { state: ApplicationState; objectId: string; historyBefore: number } {
  let state = openDocumentState()
  const added = reduceCommand(state, { kind: 'addObject', contextId: 'ctx-1', objectType: 'mesh', meshSize: 2 }, ENV)
  expect(added.status, '网格对象的创建必须成功（类型已登记，见 scene.ts 的 DEFAULT_TYPES）').toBe('applied')
  state = added.state
  const objectId = added.status === 'applied' ? Object.keys(state.docs['doc-1'].scene.objects)[0] : ''
  // `addObject` **本身**记一条历史 ⇒ 后续断言必须以它为基线（不是假定 0）
  return { state, objectId, historyBefore: state.docs['doc-1'].history.past.length }
}

/** 直接建一个"共享几何"的状态（用于 A07 经命令层的往返）。 */
function stateWithSharedGeometry(): { state: ApplicationState; scene: Scene } {
  const state = openDocumentState()
  const doc = state.docs['doc-1']
  const a = addMeshObject(doc.scene, { objectId: 'A', dataId: 'geo-1', size: 1 })
  if (!a.ok) throw new Error('fixture')
  const b = addMeshObject(a.value, { objectId: 'B', dataId: 'geo-b', size: 1 })
  if (!b.ok) throw new Error('fixture')
  const shared = Object.freeze({ ...b.value, objects: Object.freeze({ ...b.value.objects, B: Object.freeze({ ...b.value.objects['B'], dataId: 'geo-1' }) }) })
  const data = { ...shared.data }
  delete data['geo-b']
  const scene = Object.freeze({ ...shared, data: Object.freeze(data) })
  const next = withScene(doc, scene).doc
  return { state: Object.freeze({ ...state, docs: Object.freeze({ ...state.docs, 'doc-1': next }) }), scene }
}

function vertexRefOf(scene: Scene, objectId: string, vertex: string) {
  const obj = findObject(scene, objectId)
  const data = obj ? findObjectData(scene, obj.dataId) : undefined
  const mesh = data ? meshFromPayload(data.payload) : undefined
  if (!mesh) throw new Error('not a mesh')
  return propertyRef(objectRef(objectId, data?.contentVersion), 'mesh.vertexPosition', {
    element: elementRef(vertex, mesh.topology.version),
  })
}

// ─────────────────────────────────────────────────────────────────────────────

describe('顶点写走**唯一**写路由（`setProperty` + `PropertyRef.element`）', () => {
  it('`setProperty` 能写网格顶点，且文档版本推进、历史记账一条', () => {
    const { state, objectId, historyBefore } = stateWithMesh()
    const scene = state.docs['doc-1'].scene
    const before = state.docs['doc-1'].version
    const cmd: Command = {
      kind: 'setProperty',
      contextId: 'ctx-1',
      refs: [vertexRefOf(scene, objectId, 'x0y0z0')],
      value: { x: 5, y: 0, z: 0 },
    }
    const t = reduceCommand(state, cmd, ENV)
    expect(t.status).toBe('applied')
    if (t.status !== 'applied') return
    // 内容版本推进（顶点真的动了）
    expect(t.version.documentVersion).toBe(before.documentVersion + 1)
    expect(t.version.contentVersion).not.toBe(before.contentVersion)
    // 历史**恰好**多一条（唯一提交协议：不产生幽灵历史）
    expect(t.state.docs['doc-1'].history.past.length).toBe(historyBefore + 1)
    // 顶点位置确实变了
    const after = t.state.docs['doc-1'].scene
    const mesh = meshFromPayload(findObjectData(after, findObject(after, objectId)!.dataId)!.payload)!
    expect(mesh.topology.vertices.find((v) => v.id === 'x0y0z0')!.position.x).toBe(5)
  })

  it('写相同值 ⇒ `unchanged`（不推进版本、不新增历史 —— 幽灵历史防线）', () => {
    const { state, objectId, historyBefore } = stateWithMesh()
    const scene = state.docs['doc-1'].scene
    const mesh = meshFromPayload(findObjectData(scene, findObject(scene, objectId)!.dataId)!.payload)!
    const cur = mesh.topology.vertices.find((v) => v.id === 'x0y0z0')!.position
    const t = reduceCommand(
      state,
      { kind: 'setProperty', contextId: 'ctx-1', refs: [vertexRefOf(scene, objectId, 'x0y0z0')], value: { x: cur.x, y: cur.y, z: cur.z } },
      ENV,
    )
    expect(t.status).toBe('unchanged')
    if (t.status !== 'unchanged') return
    expect(t.state.docs['doc-1'].history.past.length, '历史条数不变').toBe(historyBefore)
  })

  it('**E1**：`topologyVersion` 过期的元素引用 ⇒ `StaleReference`（不是 MissingTarget、不猜配）', () => {
    const { state, objectId, historyBefore } = stateWithMesh()
    const scene = state.docs['doc-1'].scene
    const good = vertexRefOf(scene, objectId, 'x0y0z0')
    // 伪造一个"旧拓扑版本"的引用
    const stale = propertyRef(good.owner, 'mesh.vertexPosition', { element: elementRef('x0y0z0', 99) })
    const t = reduceCommand(state, { kind: 'setProperty', contextId: 'ctx-1', refs: [stale], value: { x: 1, y: 1, z: 1 } }, ENV)
    expect(t.status).toBe('rejected')
    if (t.status !== 'rejected') return
    expect(t.error.code, '必须是 StaleReference').toBe('StaleReference')
    expect(t.error.params.expected).toBe(99)
    expect(t.error.params.actual).toBe(0)
    // 拒绝后**文档零变化**（A06 同族）
    expect(t.state.docs['doc-1'].history.past.length).toBe(historyBefore)
    expect(t.state.docs['doc-1'].version).toBe(state.docs['doc-1'].version)
  })

  it('**负对照**：不带 `element` 的顶点写 ⇒ 拒绝（不得退化成"随便挑一个顶点"）', () => {
    const { state, objectId } = stateWithMesh()
    const scene = state.docs['doc-1'].scene
    const obj = findObject(scene, objectId)!
    // 引用里**没有** element —— 这正是"不静默猜配"要拦住的形态
    const noElement = propertyRef(objectRef(objectId, obj.transform ? 0 : 0), 'mesh.vertexPosition')
    const t = reduceCommand(state, { kind: 'setProperty', contextId: 'ctx-1', refs: [noElement], value: { x: 1, y: 0, z: 0 } }, ENV)
    expect(t.status, '缺元素身份的顶点写必须被拒绝').toBe('rejected')
    if (t.status !== 'rejected') return
    // 校验顺序保证它先撞上"元素引用必须存在"那一类拒绝
    expect(['StaleReference', 'InvalidValue', 'UnsupportedOperation']).toContain(t.error.code)
  })

  it('元素引用指向**不存在**的顶点（版本对）⇒ `MissingTarget`', () => {
    const { state, objectId } = stateWithMesh()
    const scene = state.docs['doc-1'].scene
    const good = vertexRefOf(scene, objectId, 'x0y0z0')
    const ghost = propertyRef(good.owner, 'mesh.vertexPosition', { element: elementRef('no-such-vertex', 0) })
    const t = reduceCommand(state, { kind: 'setProperty', contextId: 'ctx-1', refs: [ghost], value: { x: 1, y: 0, z: 0 } }, ENV)
    // 版本相符但元素不存在 ⇒ 走 applyPropertyValue 的 null ⇒ 显式拒绝（**不**部分成功）
    expect(t.status).toBe('rejected')
    if (t.status !== 'rejected') return
    expect(['MissingTarget', 'InvalidValue']).toContain(t.error.code)
  })

  it('**A08 多选原子性**：两个顶点，一个可写一个过期 ⇒ **整体拒绝**，第一个也没被写', () => {
    const { state, objectId } = stateWithMesh()
    const scene = state.docs['doc-1'].scene
    const okRef = vertexRefOf(scene, objectId, 'x0y0z0')
    const badRef = propertyRef(okRef.owner, 'mesh.vertexPosition', { element: elementRef('x1y1z1', 99) })
    const t = reduceCommand(state, { kind: 'setProperty', contextId: 'ctx-1', refs: [okRef, badRef], value: { x: 3, y: 3, z: 3 } }, ENV)
    expect(t.status, '一个失败即整体拒绝（不静默部分成功）').toBe('rejected')
    if (t.status !== 'rejected') return
    expect(t.error.code).toBe('StaleReference')
    // 第一个顶点**没有**被写（原子性）
    const after = t.state.docs['doc-1'].scene
    const mesh = meshFromPayload(findObjectData(after, findObject(after, objectId)!.dataId)!.payload)!
    expect(mesh.topology.vertices.find((v) => v.id === 'x0y0z0')!.position).toEqual(
      meshFromPayload(findObjectData(scene, findObject(scene, objectId)!.dataId)!.payload)!.topology.vertices.find((v) => v.id === 'x0y0z0')!.position,
    )
  })

  it('写权按**拥有者**判定：只读内容网格拒绝，同文档的可编辑网格仍可写', () => {
    // 构造：可编辑 A（共享 geo-1）+ 只读 B（source='content'）
    const { state } = stateWithSharedGeometry()
    const doc = state.docs['doc-1']
    const a = addMeshObject(doc.scene, { objectId: 'C', dataId: 'geo-c', size: 1 })
    if (!a.ok) throw new Error('fixture')
    // 把 A 的数据标记为 content 来源（多方块生成物的形态）
    const dataMap = { ...a.value.data }
    dataMap['geo-1'] = Object.freeze({ ...dataMap['geo-1'], source: 'content' as const })
    const scene = Object.freeze({ ...a.value, data: Object.freeze(dataMap) })
    const next = withScene(doc, scene).doc
    const st: ApplicationState = Object.freeze({ ...state, docs: Object.freeze({ ...state.docs, 'doc-1': next }) })

    // A 只读 ⇒ 拒绝，且**原因指向拥有者**（不是"文档只读"）
    const refA = vertexRefOf(scene, 'A', 'x0y0z0')
    const tA = reduceCommand(st, { kind: 'setProperty', contextId: 'ctx-1', refs: [refA], value: { x: 1, y: 0, z: 0 } }, ENV)
    expect(tA.status).toBe('rejected')
    if (tA.status !== 'rejected') return
    expect(tA.error.code).toBe('ReadOnly')
    expect(tA.error.params.owner).toBe('content')
    expect(tA.error.params.objectId).toBe('A')

    // **同一文档里**的 C 仍可写（不是整份文档一个布尔值）
    const refC = vertexRefOf(scene, 'C', 'x0y0z0')
    const tC = reduceCommand(st, { kind: 'setProperty', contextId: 'ctx-1', refs: [refC], value: { x: 2, y: 0, z: 0 } }, ENV)
    expect(tC.status, '同文档内可编辑对象必须仍可写（ReadOnly 负对照）').toBe('applied')
  })

  it('**负对照**：绕过命令层直接改场景数据 ⇒ 与"经命令写"的结果可区分（证明命令层是唯一通路）', () => {
    const { state, objectId, historyBefore } = stateWithMesh()
    const scene = state.docs['doc-1'].scene
    const ref = vertexRefOf(scene, objectId, 'x0y0z0')
    const viaCommand = reduceCommand(state, { kind: 'setProperty', contextId: 'ctx-1', refs: [ref], value: { x: 4, y: 0, z: 0 } }, ENV)
    expect(viaCommand.status).toBe('applied')
    if (viaCommand.status !== 'applied') return

    // "旁路"：直接改场景对象（无历史、无版本推进）—— 这是契约 §5.2 禁止的形态
    const obj = findObject(scene, objectId)!
    const data = findObjectData(scene, obj.dataId)!
    const mesh = meshFromPayload(data.payload)!
    const bypassed = Object.freeze({
      ...scene,
      data: Object.freeze({
        ...scene.data,
        [data.id]: Object.freeze({
          ...data,
          payload: Object.freeze({
            kind: 'mesh' as const,
            mesh: Object.freeze({ ...mesh, topology: Object.freeze({ ...mesh.topology, vertices: Object.freeze(mesh.topology.vertices.map((v) => (v.id === 'x0y0z0' ? Object.freeze({ id: v.id, position: Object.freeze({ x: 4, y: 0, z: 0 }) }) : v))) }) }),
          }),
        }),
      }),
    })
    const bypassedDoc = withScene(state.docs['doc-1'], bypassed).doc
    // 两者的**顶点值**相同
    const vm = meshFromPayload(findObjectData(viaCommand.state.docs['doc-1'].scene, findObject(viaCommand.state.docs['doc-1'].scene, objectId)!.dataId)!.payload)!
    const bm = meshFromPayload(findObjectData(bypassedDoc.scene, findObject(bypassedDoc.scene, objectId)!.dataId)!.payload)!
    expect(bm.topology.vertices.find((v) => v.id === 'x0y0z0')!.position).toEqual(vm.topology.vertices.find((v) => v.id === 'x0y0z0')!.position)
    // 但**历史**不同：旁路没有新增历史条目 ⇒ 二者可区分
    // （这就是"唯一通路"的可执行含义：旁路不带提交协议，故可被检出）
    expect(viaCommand.state.docs['doc-1'].history.past.length).toBe(historyBefore + 1)
    expect(bypassedDoc.history.past.length).toBe(historyBefore)
  })

  it('只读视图能读到网格载荷（`objects.data`）且**不**暴露可变 TypedArray', () => {
    const { state, objectId } = stateWithMesh()
    const view = captureReadView(state, 'doc-1', 'ctx-1')
    expect(view.ok).toBe(true)
    if (!view.ok) return
    const obj = findObject(state.docs['doc-1'].scene, objectId)!
    const data = view.value.objects.data(obj.dataId)
    expect(data.ok).toBe(true)
    if (!data.ok) return
    const mesh = meshFromPayload(data.value.payload)
    expect(mesh).toBeDefined()
    // 几何属性层是普通只读数组（契约 §2.2：不得暴露可变底层 TypedArray）
    for (const layer of mesh!.topology.attributes) expect(ArrayBuffer.isView(layer.values)).toBe(false)
  })

  it('`addObject` 支持 `mesh` 类型；未知类型仍被类型面挡住（不静默造对象）', () => {
    const state = openDocumentState()
    const t = reduceCommand(state, { kind: 'addObject', contextId: 'ctx-1', objectType: 'mesh' }, ENV)
    expect(t.status).toBe('applied')
    if (t.status !== 'applied') return
    const objs = Object.values(t.state.docs['doc-1'].scene.objects)
    expect(objs.length).toBe(1)
    expect(objs[0].type).toBe('mesh')
    // 其数据载荷种类是 mesh，且拓扑版本与网格一致
    const data = t.state.docs['doc-1'].scene.data[objs[0].dataId]
    expect(data.payload.kind).toBe('mesh')
    expect(data.topologyVersion).toBe(0)
  })

  it('`addObject` 的网格尺寸非法 ⇒ 显式拒绝（不压成"id 冲突"的同一个 null）', () => {
    const state = openDocumentState()
    const t = reduceCommand(state, { kind: 'addObject', contextId: 'ctx-1', objectType: 'mesh', meshSize: -1 }, ENV)
    expect(t.status).toBe('rejected')
    if (t.status !== 'rejected') return
    expect(t.error.code).toBe('InvalidValue')
    expect(t.error.params.reason).toBe('badBoxSize')
  })

  it('能力裁剪：无 `content.edit` 时顶点写被**运行时**拒绝（不只靠 UI 隐藏）', () => {
    const { state, objectId } = stateWithMesh()
    const scene = state.docs['doc-1'].scene
    const readonlyEnv = defaultExecutionInputs(['content.add', 'content.delete'])
    const t = reduceCommand(state, { kind: 'setProperty', contextId: 'ctx-1', refs: [vertexRefOf(scene, objectId, 'x0y0z0')], value: { x: 1, y: 0, z: 0 } }, readonlyEnv)
    expect(t.status).toBe('rejected')
    if (t.status !== 'rejected') return
    expect(t.error.code).toBe('UnsupportedOperation')
  })

  it('`withObject` 对**只读内容**数据可正常构造（写权判据只看 `source`，不看构造路径）', () => {
    const base = openDocumentState().docs['doc-1'].scene
    const withContent = withObject(
      base,
      sceneObject({ id: 'ro', type: 'mesh', dataId: 'ro-data' }),
      objectData('ro-data', { kind: 'blockGrid', cells: {} }, 'content'),
    )
    expect(withContent).not.toBeNull()
    expect(withContent?.data['ro-data'].source).toBe('content')
  })
})
