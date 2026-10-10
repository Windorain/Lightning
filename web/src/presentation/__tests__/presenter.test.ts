/**
 * 呈现器（**GPU 上传侧**）的判据：A19 计数平衡、G1 不重建全部几何、实例化路径选择、
 * A30 设备丢失处置。
 *
 * 这些断言**不需要 GL 上下文**：`THREE.BufferGeometry` / `InstancedMesh` / `Material`
 * 的构造是纯 CPU 行为，只有 `render()` 才需要 GL。于是"上传阶段的对象与计数"能在 vitest
 * 里断言，而 **draw call 实测**（`WebGLRenderer.info.render.calls`）留给 e2e —— 两者分工
 * 明确，互不冒充（#249 §14「不得以未跑的项目报通过」）。
 *
 * 注意：本文件在 `src/presentation/__tests__/`，按 `module-graph.mjs` 的
 * `isProductionFile` 不计入生产模块图，故这里的 three 导入不影响闸门判定。
 */

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { DEFAULT_BATCH_BUDGET } from '../batchPlan'
import { compileScene } from '../compileScene'
import { BatchedPresenter, materialIdentityOf } from '../presenter'
import { MemoryGeometrySource, makeAttributes, makeHomogeneousFixture, makeKey, makePrimitive } from './fixtures'

function fixture(n: number) {
  const geometry = new MemoryGeometrySource()
  geometry.set('geo:cube', 'v1', makeAttributes(12))
  const primitives = makeHomogeneousFixture(n)
  const compiled = compileScene({ key: makeKey(), geometry, primitives }, DEFAULT_BATCH_BUDGET)
  if (!compiled.ok) throw new Error('夹具编译失败')
  return { geometry, primitives, scene: compiled.value }
}

describe('呈现器：实例化路径（A18 的上传侧）', () => {
  it('10,000 个同质对象 ⇒ 1 个 InstancedMesh 承载全部实例', () => {
    const { scene } = fixture(10_000)
    const presenter = new BatchedPresenter({ scope: 'test-scope' })
    presenter.apply(scene)

    const stats = presenter.statsSnapshot()
    expect(stats.batchObjects).toBe(1)
    expect(stats.instanceCount).toBe(10_000)
    expect(stats.batchBuilds).toBe(1)

    const inst = presenter.object3d.children[0] as THREE.InstancedMesh
    expect(inst.isInstancedMesh).toBe(true)
    expect(inst.count).toBe(10_000)
    expect(inst.geometry.getAttribute('position').count).toBe(12 * 3)

    // 实例矩阵确实写进去了（不是"数了数就算"）
    const m = new THREE.Matrix4()
    inst.getMatrixAt(9_999, m)
    const pos = new THREE.Vector3().setFromMatrixPosition(m)
    expect(Number.isFinite(pos.x)).toBe(true)
    expect(m.equals(new THREE.Matrix4())).toBe(false)

    presenter.dispose()
  })

  it('批次对象携带**对象身份**（不是批次序号作为身份）', () => {
    const { scene, primitives } = fixture(4)
    const presenter = new BatchedPresenter({ scope: 'test-scope' })
    presenter.apply(scene)
    const inst = presenter.object3d.children[0] as THREE.InstancedMesh
    const tag = inst.userData.presentationBatch as { batchIndex: number; objectIds: string[] }
    expect(tag.objectIds).toEqual(primitives.map((p) => p.objectId))
    expect(tag.batchIndex).toBe(0)
    presenter.dispose()
  })

  it('独立变形（deform=independent）⇒ 不走实例化，但共享同一份几何', () => {
    const geometry = new MemoryGeometrySource()
    geometry.set('geo:cube', 'v1', makeAttributes(1))
    const primitives = [0, 1, 2].map((i) =>
      makePrimitive(`obj:${i}`, {
        deform: 'independent',
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, i, 0, 0, 1],
      }),
    )
    const compiled = compileScene({ key: makeKey(), geometry, primitives })
    if (!compiled.ok) return
    const presenter = new BatchedPresenter({ scope: 'test-scope' })
    presenter.apply(compiled.value)

    const holder = presenter.object3d.children[0] as THREE.Group
    expect(holder.isGroup).toBe(true)
    expect(holder.children).toHaveLength(3)
    // 共享几何：三个 Mesh 指向同一个 BufferGeometry 实例
    const geoms = new Set(holder.children.map((c) => (c as THREE.Mesh).geometry))
    expect(geoms.size, '同几何必须共享一份 BufferGeometry').toBe(1)
    expect(presenter.statsSnapshot().geometryBuilds).toBe(1)
    presenter.dispose()
  })

  it('负对照：把 batch index 当对象身份 ⇒ 批次标签里必须有 objectIds 可供断言', () => {
    const { scene, primitives } = fixture(3)
    const presenter = new BatchedPresenter({ scope: 'test-scope' })
    presenter.apply(scene)
    const tag = (presenter.object3d.children[0] as THREE.InstancedMesh).userData
      .presentationBatch as { objectIds: string[] }
    // 破坏方式：只用 batchIndex 标识对象 ⇒ 移出一个对象后无法判断谁是谁
    expect(tag.objectIds[2]).toBe(primitives[2]!.objectId)
    expect(primitives[2]!.objectId).not.toBe(String(0))
    presenter.dispose()
  })
})

describe('G1：单例更新不重建全部几何', () => {
  it('第二次 apply 同一世代 ⇒ 几何全部复用，重建数为 0', () => {
    const { geometry, primitives } = fixture(64)
    const presenter = new BatchedPresenter({ scope: 'test-scope' })
    const first = compileScene({ key: makeKey(), geometry, primitives })
    if (!first.ok) return
    presenter.apply(first.value)
    const afterFirst = presenter.statsSnapshot()
    expect(afterFirst.geometryBuilds).toBe(1)

    // 同输入再编译一次（模拟"只改了注解/无关输入"导致的重新 apply）
    const second = compileScene({ key: makeKey(), geometry, primitives })
    if (!second.ok) return
    presenter.apply(second.value)

    const afterSecond = presenter.statsSnapshot()
    expect(afterSecond.geometryBuilds, 'G1：不得重建全部方块几何').toBe(afterFirst.geometryBuilds)
    expect(afterSecond.batchBuilds, '批次对象应复用而非重建').toBe(afterFirst.batchBuilds)
    expect(afterSecond.batchReuses).toBeGreaterThan(0)
    expect(afterSecond.materialBuilds).toBe(1)
    presenter.dispose()
  })

  it('只改变换 ⇒ 几何与材质都不重建，实例矩阵被更新', () => {
    const geometry = new MemoryGeometrySource()
    geometry.set('geo:cube', 'v1', makeAttributes(4))
    const presenter = new BatchedPresenter({ scope: 'test-scope' })

    const primitivesA = makeHomogeneousFixture(8)
    const compiledA = compileScene({ key: makeKey(), geometry, primitives: primitivesA })
    if (!compiledA.ok) return
    presenter.apply(compiledA.value)

    // 只改变换（几何/材质身份不变）
    const primitivesB = primitivesA.map((p, i) =>
      makePrimitive(p.objectId, {
        geometry: p.geometry,
        material: p.material,
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, i * 10, 0, 0, 1],
        bounds: p.bounds,
      }),
    )
    const compiledB = compileScene({ key: makeKey(), geometry, primitives: primitivesB })
    if (!compiledB.ok) return
    presenter.apply(compiledB.value)

    const stats = presenter.statsSnapshot()
    expect(stats.geometryBuilds).toBe(1)
    expect(stats.materialBuilds).toBe(1)
    expect(stats.batchReuses).toBeGreaterThan(0)

    // 矩阵真的更新了
    const inst = presenter.object3d.children[0] as THREE.InstancedMesh
    const m = new THREE.Matrix4()
    inst.getMatrixAt(3, m)
    expect(new THREE.Vector3().setFromMatrixPosition(m).x).toBe(30)
    presenter.dispose()
  })

  it('对象移出批次 ⇒ 批次重建，但对象身份仍来自批次标签（G2）', () => {
    const geometry = new MemoryGeometrySource()
    geometry.set('geo:cube', 'v1', makeAttributes(1))
    const presenter = new BatchedPresenter({ scope: 'test-scope' })

    const all = makeHomogeneousFixture(8)
    const a = compileScene({ key: makeKey(), geometry, primitives: all })
    if (!a.ok) return
    presenter.apply(a.value)

    const reduced = all.slice(0, 6)
    const b = compileScene({ key: makeKey(), geometry, primitives: reduced })
    if (!b.ok) return
    presenter.apply(b.value)

    const inst = presenter.object3d.children[0] as THREE.InstancedMesh
    expect(inst.count).toBe(6)
    const tag = inst.userData.presentationBatch as { objectIds: string[] }
    expect(tag.objectIds).toEqual(reduced.map((p) => p.objectId))
    presenter.dispose()
  })
})

describe('A19：呈现器资源计数平衡', () => {
  it('dispose 后活跃计数归零、账守恒', () => {
    const { scene } = fixture(16)
    const presenter = new BatchedPresenter({ scope: 'test-scope' })
    presenter.apply(scene)
    expect(presenter.ledger().activeCount).toBeGreaterThan(0)

    const disposed = presenter.statsSnapshot().disposals
    presenter.dispose()

    const ledger = presenter.ledger()
    expect(ledger.activeCount, '活跃资源必须回基线').toBe(0)
    expect(ledger.balanced, 'A19 主判据：显式计数守恒').toBe(true)
    expect(presenter.statsSnapshot().disposals).toBeGreaterThan(disposed)
    expect(presenter.object3d.children).toHaveLength(0)
  })

  it('负对照：少一次 dispose（不调用 presenter.dispose）⇒ 活跃计数不回基线', () => {
    const { scene } = fixture(16)
    const presenter = new BatchedPresenter({ scope: 'test-scope' })
    presenter.apply(scene)
    // 破坏方式：直接丢弃呈现器，不做 dispose（"少一次 dispose"的经典形态）
    const leaked = presenter.ledger()
    expect(leaked.activeCount, '未 dispose 时必须留下可观测的活跃资源 —— 这就是判红读数').toBeGreaterThan(0)
    expect(leaked.balanced).toBe(false)
    // 清理，避免测试间互相影响
    presenter.dispose()
  })

  it('两个呈现器（两个设备作用域）互不影响：释放其一另一仍可用', () => {
    const { scene } = fixture(8)
    const a = new BatchedPresenter({ scope: 'viewport-a' })
    const b = new BatchedPresenter({ scope: 'viewport-b' })
    a.apply(scene)
    b.apply(scene)
    expect(a.ledger().activeCount).toBe(b.ledger().activeCount)

    a.dispose()
    expect(a.ledger().activeCount).toBe(0)
    // b 完全不受影响（"一方关闭不破坏另一方"）
    expect(b.ledger().activeCount).toBeGreaterThan(0)
    expect(b.object3d.children.length).toBeGreaterThan(0)
    b.dispose()
    expect(b.ledger().balanced).toBe(true)
  })

  it('材质身份含 tint/blend/顶点色（不同 tint 不得共用材质实例）', () => {
    const vc = materialIdentityOf({
      id: 'mat:x',
      version: 'v1',
      blend: 'opaque',
      tint: 0xffffff,
      useVertexColor: true,
    })
    const plainA = materialIdentityOf({
      id: 'mat:x',
      version: 'v1',
      blend: 'opaque',
      tint: 0x111111,
      useVertexColor: false,
    })
    const plainB = materialIdentityOf({
      id: 'mat:x',
      version: 'v1',
      blend: 'opaque',
      tint: 0x222222,
      useVertexColor: false,
    })
    expect(plainA.id).not.toBe(plainB.id)
    expect(vc.id).not.toBe(plainA.id)
    // 版本进身份 ⇒ 换纹理得新材质（A36「版本替换」）
    const v2 = materialIdentityOf({
      id: 'mat:x',
      version: 'v2',
      blend: 'opaque',
      tint: 0x111111,
      useVertexColor: false,
    })
    expect(v2.id).toBe(plainA.id)
    expect(v2.version).not.toBe(plainA.version)
  })
})

describe('A30：设备丢失处置', () => {
  it('handleContextLost 放弃全部句柄并清空挂载（旧句柄不复用）；restore 需重新 apply', () => {
    const { scene } = fixture(32)
    const presenter = new BatchedPresenter({ scope: 'test-scope' })
    presenter.apply(scene)
    const beforeActive = presenter.ledger().activeCount
    expect(beforeActive).toBeGreaterThan(0)

    const abandoned = presenter.handleContextLost()
    expect(abandoned).toBeGreaterThan(0)
    expect(presenter.ledger().activeCount, '丢失后旧句柄全部放弃').toBe(0)
    expect(presenter.object3d.children, '挂载表清空 ⇒ 恢复必然重建').toHaveLength(0)
    expect(presenter.currentGeneration).toBeNull()

    // 恢复：用**当前有效版本**重新 apply（A30 明文）
    presenter.handleContextRestored()
    expect(presenter.restores).toBe(1)
    presenter.apply(scene)
    expect(presenter.object3d.children.length).toBeGreaterThan(0)
    expect(presenter.ledger().activeCount).toBeGreaterThan(0)
    presenter.dispose()
  })

  it('负对照：只 resize 而不重建 ⇒ 挂载表为空（A30 负对照判红）', () => {
    const { scene } = fixture(8)
    const presenter = new BatchedPresenter({ scope: 'test-scope' })
    presenter.apply(scene)
    presenter.handleContextLost()
    // 破坏方式：只做"恢复到就绪"而不重新 apply 归属资源
    presenter.handleContextRestored()
    expect(presenter.object3d.children, '未重建时挂载表必须为空 —— 这正是判红读数').toHaveLength(0)
    expect(presenter.currentGeneration).toBeNull()
    presenter.dispose()
  })
})
