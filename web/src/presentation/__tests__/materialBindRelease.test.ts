/**
 * **带绑定的材质必须能被释放**（判据：换绑定后旧材质的引用/dispose 账平）。
 *
 * ## 缺陷形态
 *
 * `materialFor` 的缓存键 = `materialIdentityOf(descriptor, binding)`（**含绑定**），而
 * `mount` 曾把 `mounted.materialKey` 填成 `materialIdentityOf(payload.material)`（**不含绑定**）。
 * `unmount` 按 `mounted.materialKey` 释放 ⇒ 释放的是一个缓存里从未存在的键：
 *  - 带绑定的材质**永不 dispose**，每次换绑定（如纹理解码完成触发的重建）漏一份；
 *  - 缓存还命中那个本该销毁的旧条目 ⇒ `materialReuses` 涨、`materialBuilds` 不动；
 *  - `stats.disposals` 在 `unmount` 里盲加一（旧口径）⇒ 泄漏被伪装成正常回收。
 *
 * ## 本文件的判据（每条都对应一个可红读数）
 *
 * | # | 断言 | 抓什么 |
 * |---|---|---|
 * | ① | 同一绑定再设置一次 ⇒ 旧材质**真的** dispose，`materialBuilds` 递增、`materialReuses` 不涨 | 释放键必须命中缓存（主判据） |
 * | ② | 反复换绑 N 次 ⇒ `liveRefs` 恒定（不随次数增长） | 「引用泄漏」的直接账面形式 |
 * | ③ | 换到新内容版本的绑定 ⇒ 旧材质 dispose、新材质是新对象 | 驱动量是内容身份，不是「有没有换过」 |
 * | ④ | 共享材质的批次卸载（材质还有别的持有者）⇒ **不** dispose，`disposals` 只计真实 dispose | `disposals` 不得是 unmount 次数（口径修正） |
 *
 * ## 关于 CRLF
 *
 * 本判据只断言运行时对象与计数（不读源码文本、不做字节级断言）⇒ 不受 `core.autocrlf`
 * 影响，无需换行归一化（不是源码文本判据）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { DEFAULT_BATCH_BUDGET } from '../batchPlan'
import { compileScene } from '../compileScene'
import { BatchedPresenter } from '../presenter'
import { VOXEL_SAMPLING, type TextureBinding } from '../textureBinding'
import type { MaterialDescriptor } from '../evaluationKey'
import { MemoryGeometrySource, makeAttributes, makeKey, makePrimitive } from './fixtures'

/** 带贴图的材质：绑定在场时缓存键与「无绑定」不同 —— 这正是引爆条件。 */
const MAPPED: MaterialDescriptor = {
  id: 'material:415',
  version: 'v1',
  blend: 'translucent',
  tint: 0xffffff,
  useVertexColor: true,
}

function bindingOf(descriptor: MaterialDescriptor, mapVersion = 'v1'): TextureBinding {
  return Object.freeze({
    materialId: descriptor.id,
    materialVersion: descriptor.version,
    map: { id: 'tex:415', version: mapVersion },
    sampling: VOXEL_SAMPLING,
    missingRequired: false,
  })
}

function bindingsOf(binding: TextureBinding): Map<string, TextureBinding> {
  return new Map([[binding.materialId, binding]])
}

/** 单材质/单几何的场景夹具（一个批次 ⇒ 材质与几何各一份引用）。 */
function singleMaterialScene() {
  const geometry = new MemoryGeometrySource()
  geometry.set('geo:cube', 'v1', makeAttributes(2))
  const compiled = compileScene(
    { key: makeKey(), geometry, primitives: [makePrimitive('obj:415', { material: MAPPED })] },
    DEFAULT_BATCH_BUDGET,
  )
  if (!compiled.ok) throw new Error('夹具编译失败')
  return compiled.value
}

/** 同一材质 + 两个**不同几何** ⇒ 两个批次，但共用同一份材质（引用 = 2）。 */
function twoGeometryScene(keepFirst: boolean) {
  const geometry = new MemoryGeometrySource()
  geometry.set('geo:a', 'v1', makeAttributes(1))
  geometry.set('geo:b', 'v1', makeAttributes(2))
  const a = makePrimitive('obj:a', { geometry: { id: 'geo:a', version: 'v1' } })
  const b = makePrimitive('obj:b', { geometry: { id: 'geo:b', version: 'v1' } })
  const compiled = compileScene(
    { key: makeKey(), geometry, primitives: keepFirst ? [a] : [a, b] },
    DEFAULT_BATCH_BUDGET,
  )
  if (!compiled.ok) throw new Error('夹具编译失败')
  return compiled.value
}

/** 挂载树上的唯一材质（单一材质夹具；多于一个直接判红，避免「数到哪个算哪个」）。 */
function onlyMaterial(root: THREE.Object3D): THREE.Material {
  const found = new Set<THREE.Material>()
  root.traverse((o) => {
    const mat = (o as THREE.Mesh).material
    if (mat === undefined) return
    if (Array.isArray(mat)) for (const m of mat) found.add(m)
    else found.add(mat)
  })
  expect(found.size, '夹具只有一个材质（否则本条断言的对象不确定）').toBe(1)
  return [...found][0]!
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('换绑定后旧材质必须被真实释放（批次级材质键 = 缓存键）', () => {
  it('① 同一绑定再设置一次（解码完成那类重建）⇒ 旧材质真的 dispose，且不复用旧条目', () => {
    const scene = singleMaterialScene()
    const binding = bindingOf(MAPPED)
    const presenter = new BatchedPresenter({
      scope: 'test:material-release',
      textureBindings: bindingsOf(binding),
    })
    try {
      presenter.apply(scene)
      const first = onlyMaterial(presenter.object3d)
      const started = presenter.statsSnapshot()
      expect(started.materialBuilds, '① 起点：带绑定的材质建立一份').toBe(1)
      expect(started.materialReuses, '① 起点：还没有复用').toBe(0)
      const liveBefore = presenter.ledger().liveRefs
      expect(liveBefore, '① 起点：材质 1 份 + 几何 1 份').toBe(2)

      const disposeSpy = vi.spyOn(first, 'dispose')
      // 同一份绑定再设置一次：语义等价于「纹理解码完成，材质必须按新信息重建」。
      presenter.setTextureBindings(bindingsOf(binding))

      expect(disposeSpy, '① 旧材质必须真的 dispose（核心读数）').toHaveBeenCalledTimes(1)
      const after = presenter.statsSnapshot()
      expect(after.materialBuilds, '① 新材质是被创建的').toBe(2)
      expect(after.materialReuses, '① 不得复用那个本该释放的旧材质').toBe(0)
      const current = onlyMaterial(presenter.object3d)
      expect(current, '① 画面上换成了新材质对象').not.toBe(first)
      expect(presenter.ledger().liveRefs, '① 引用不得累积').toBe(liveBefore)
      const ledger = presenter.ledger()
      expect(ledger.zeroCrossings, '① 每次归零恰好一次 dispose').toBe(ledger.disposeTotal)
    } finally {
      presenter.dispose()
    }
  })

  it('② 反复换绑定 N 次 ⇒ 引用恒定（泄漏的直接账面形式）', () => {
    const scene = singleMaterialScene()
    const binding = bindingOf(MAPPED)
    const presenter = new BatchedPresenter({
      scope: 'test:material-release-loop',
      textureBindings: bindingsOf(binding),
    })
    try {
      presenter.apply(scene)
      const liveBefore = presenter.ledger().liveRefs
      const rounds = 5
      for (let i = 0; i < rounds; i++) presenter.setTextureBindings(bindingsOf(binding))
      const stats = presenter.statsSnapshot()
      const ledger = presenter.ledger()
      expect(ledger.liveRefs, '② 换 5 次绑定后引用必须与起点相同（旧实现每次 +1）').toBe(liveBefore)
      expect(stats.materialReuses, '② 没有一次是复用本该释放的旧材质').toBe(0)
      expect(stats.materialBuilds, '② 每轮重建一份新材质').toBe(rounds + 1)
      expect(ledger.zeroCrossings, '② 归零次数 == dispose 次数（账没说谎）').toBe(ledger.disposeTotal)
    } finally {
      presenter.dispose()
    }
  })

  it('③ 换到新内容版本的绑定 ⇒ 旧材质 dispose，新材质是新对象', () => {
    const scene = singleMaterialScene()
    const presenter = new BatchedPresenter({
      scope: 'test:material-release-version',
      textureBindings: bindingsOf(bindingOf(MAPPED, 'v1')),
    })
    try {
      presenter.apply(scene)
      const v1 = onlyMaterial(presenter.object3d)
      const disposeSpy = vi.spyOn(v1, 'dispose')
      presenter.setTextureBindings(bindingsOf(bindingOf(MAPPED, 'v2')))
      const v2 = onlyMaterial(presenter.object3d)
      expect(v2, '③ 内容版本变 ⇒ 换材质对象').not.toBe(v1)
      expect(disposeSpy, '③ 旧版本材质必须 dispose').toHaveBeenCalledTimes(1)
      expect(presenter.statsSnapshot().materialBuilds, '③ 重建一次').toBe(2)
      // 再设一次同一份 v2 绑定：旧实现会命中那个没被释放的 v2 条目（materialReuses 涨）。
      presenter.setTextureBindings(bindingsOf(bindingOf(MAPPED, 'v2')))
      const stats = presenter.statsSnapshot()
      expect(stats.materialReuses, '③ 上一份 v2 材质已释放 ⇒ 不可能命中').toBe(0)
      expect(stats.materialBuilds, '③ 每次都重建').toBe(3)
    } finally {
      presenter.dispose()
    }
  })
})

describe('stats.disposals 只计真实 dispose（不是 unmount 次数）', () => {
  it('④ 共享材质的批次卸载 ⇒ 材质不 dispose，disposals 与真实调用数一致', () => {
    const materialDispose = vi.spyOn(THREE.Material.prototype, 'dispose')
    const geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose')
    const presenter = new BatchedPresenter({ scope: 'test:disposals-caliber' })
    try {
      presenter.apply(twoGeometryScene(false))
      const both = presenter.statsSnapshot()
      expect(both.batchObjects, '④ 两个批次（不同几何、同材质）').toBe(2)
      expect(both.materialBuilds, '④ 材质只建一份').toBe(1)
      expect(both.materialReuses, '④ 第二个批次复用同一份材质').toBe(1)
      // 归属账的粒度是**缓存条目**（材质/几何各 acquire 一次，最后一个引用释放时 release）：
      // 于是这里读数是 3 = 2 份几何 + 1 份材质（材质被两个批次共享 ⇒ 引用数 2、条目 1 条）。
      expect(presenter.ledger().activeCount, '④ 2 份几何 + 1 份材质').toBe(3)

      // 只剩一个批次 ⇒ 发生一次真实的**卸载**（但材质不归零）。
      presenter.apply(twoGeometryScene(true))
      const single = presenter.statsSnapshot()
      expect(single.batchObjects, '④ 确实卸载了一个批次').toBe(1)
      expect(materialDispose.mock.calls.length, '④ 材质仍被另一批次持有 ⇒ 不得 dispose').toBe(0)
      expect(geometryDispose.mock.calls.length, '④ 孤立的几何被真正释放').toBe(1)
      expect(single.disposals, '④ disposals 必须等于真实 dispose 次数（旧口径把 unmount 也算进来）')
        .toBe(materialDispose.mock.calls.length + geometryDispose.mock.calls.length)
      expect(presenter.ledger().activeCount, '④ 材质条目仍在（还被另一批次持有）+ 1 份几何').toBe(2)

      presenter.dispose()
      const disposed = presenter.statsSnapshot()
      expect(disposed.disposals, '④ 全生命周期一致：disposals == 真实 dispose 调用数')
        .toBe(materialDispose.mock.calls.length + geometryDispose.mock.calls.length)
      expect(presenter.ledger().atBaseline, '④ dispose 后账回基线').toBe(true)
    } finally {
      presenter.dispose()
    }
  })
})
