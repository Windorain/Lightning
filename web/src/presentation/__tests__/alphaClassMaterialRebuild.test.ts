/**
 * **alpha 类别到达 ⇒ 材质按新分类重建**（重建链核实判据）。
 *
 * ## 这条判据回答的问题（它是"接线能不能生效"的**前提**）
 *
 * 分类发生在**解码完成时**（`composition/kernelTextureResources#decodeOne`），而材质在
 * **应用场景时**就已创建（那时纹理还没解码 ⇒ 类别缺席 ⇒ 画家路径）。于是"修好分类"
 * 只有在下面这条链**真实存在**时才会改变画面：
 *
 * ```
 * textureBindingsOf(带 alphaClass) → PresenterSession.bindTextures → BatchedPresenter.setTextureBindings
 *   → 卸载全部批次 → 按新绑定重挂 → materialFor（缓存键变）→ createMaterial(用新类别)
 * ```
 *
 * 本判据把这条链**逐环断言**（不靠"应该会重建"的推测）：
 *
 * | # | 断言 | 抓什么 |
 * |---|---|---|
 * | ① | 无绑定时挂载材质 = 画家路径（不写深度） | 起点是修复前形态（否则后面的"变化"没有对照） |
 * | ② | 换入带 `alphaClass='binary'` 的绑定 ⇒ 挂载材质**换成另一个对象**且 = cutout 等价 | 真的重建（不是改了个字段） |
 * | ③ | 同一绑定**去掉类别**再换回 ⇒ 回到画家路径 | 驱动量是**类别**本身（不是"有绑定"） |
 * | ④ | `materialIdentityOf` 对"有/无类别"给**不同**身份 | 重建不依赖引用计数归零这种副作用 |
 *
 * ## 为什么必须有 ④（实测发现的事实）
 *
 * 解码完成时 `map` 的**内容身份不变**（内嵌资源的版本来自字节，解码前后同一个值），
 * 变的只有类别 ⇒ 若类别不进材质身份，缓存会命中**修复前那个材质**。故类别进身份，
 * 让"类别变 ⇒ 材质键变"是结构性的。
 */
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { DEFAULT_BATCH_BUDGET } from '../batchPlan'
import { compileScene } from '../compileScene'
import { BatchedPresenter, materialIdentityOf } from '../presenter'
import { VOXEL_SAMPLING, type TextureBinding } from '../textureBinding'
import type { MaterialDescriptor } from '../evaluationKey'
import { MemoryGeometrySource, makeAttributes, makeKey, makePrimitive } from './fixtures'

const GLASS: MaterialDescriptor = {
  id: 'material:1',
  version: 'v1',
  blend: 'translucent',
  tint: 0xffffff,
  useVertexColor: true,
}

const CUTOUT = { transparent: true, alphaTest: 0.5, depthWrite: true }
const BLEND = { transparent: true, alphaTest: 0, depthWrite: false }

function sceneFixture() {
  const geometry = new MemoryGeometrySource()
  geometry.set('geo:cube', 'v1', makeAttributes(2))
  const compiled = compileScene(
    { key: makeKey(), geometry, primitives: [makePrimitive('obj:acc', { material: GLASS })] },
    DEFAULT_BATCH_BUDGET,
  )
  if (!compiled.ok) throw new Error('夹具编译失败')
  return compiled.value
}

function bindingOf(material: MaterialDescriptor, alphaClass?: TextureBinding['alphaClass']): TextureBinding {
  return Object.freeze({
    materialId: material.id,
    materialVersion: material.version,
    map: { id: 'tex:acc', version: 'v1' },
    sampling: VOXEL_SAMPLING,
    missingRequired: false,
    ...(alphaClass === undefined ? {} : { alphaClass }),
  })
}

/** 挂载树上的唯一材质（本夹具单材质；多于一个直接判红，避免"数到哪个算哪个"）。 */
function onlyMaterial(root: THREE.Object3D): THREE.MeshBasicMaterial {
  const found = new Set<THREE.Material>()
  root.traverse((o) => {
    const mat = (o as THREE.Mesh).material
    if (mat === undefined) return
    if (Array.isArray(mat)) for (const m of mat) found.add(m)
    else found.add(mat)
  })
  expect(found.size, '夹具只有一个材质（否则本条断言的对象不确定）').toBe(1)
  return [...found][0] as THREE.MeshBasicMaterial
}

function stateOf(material: THREE.MeshBasicMaterial) {
  return { transparent: material.transparent, alphaTest: material.alphaTest, depthWrite: material.depthWrite }
}

describe('alpha 类别到达 ⇒ 材质按新分类重建（重建链）', () => {
  it('① 无绑定 ⇒ 画家路径；② 换入 binary 绑定 ⇒ 材质换对象且 = cutout 等价；③ 去掉类别 ⇒ 回到画家路径', () => {
    const scene = sceneFixture()
    const presenter = new BatchedPresenter({ scope: 'test:alpha-rebuild' })
    try {
      presenter.apply(scene)
      const before = onlyMaterial(presenter.object3d)
      expect(stateOf(before), '① 起点：类别未知 ⇒ 修复前的画家路径').toEqual(BLEND)
      expect(presenter.statsSnapshot().materialBuilds, '① 起始材质只建一次').toBe(1)

      // ② 解码完成：绑定带来类别（map 的内容身份与"解码前"完全相同 —— 只有类别是新的）。
      presenter.setTextureBindings(new Map([[GLASS.id, bindingOf(GLASS, 'binary')]]))
      const after = onlyMaterial(presenter.object3d)
      expect(after, '② 必须换成另一个材质对象（重建，而不是原地改字段）').not.toBe(before)
      expect(stateOf(after), '② binary ⇒ cutout 等价状态（alphaTest + 写深度）').toEqual(CUTOUT)
      expect(presenter.statsSnapshot().materialBuilds, '② 新材质是被**创建**的（缓存未命中）').toBe(2)

      // ③ 负对照：同一绑定去掉类别（= 解码前的绑定形状）⇒ 回到画家路径。
      presenter.setTextureBindings(new Map([[GLASS.id, bindingOf(GLASS)]]))
      const back = onlyMaterial(presenter.object3d)
      expect(back, '③ 又一次换绑定 ⇒ 又换材质对象').not.toBe(after)
      expect(stateOf(back), '③ 未知类别 ⇒ 画家路径（证明驱动量是类别，不是"有绑定"）').toEqual(BLEND)
    } finally {
      presenter.dispose()
    }
  })

  it('④ 材质身份对"有/无类别"给出**不同**身份（重建不依赖引用计数归零）', () => {
    const absent = materialIdentityOf(GLASS, bindingOf(GLASS))
    const binary = materialIdentityOf(GLASS, bindingOf(GLASS, 'binary'))
    const partial = materialIdentityOf(GLASS, bindingOf(GLASS, 'partial'))
    expect(binary.id, '类别必须在材质身份里').not.toBe(absent.id)
    expect(partial.id, '三种类别互不相同的身份').not.toBe(binary.id)
    expect(partial.id).not.toBe(absent.id)
    // 版本/内容身份不受影响：类别是派生，不是"另一个版本"。
    expect(binary.version).toBe(absent.version)
    expect(binary.id.startsWith('material:' + GLASS.id), '身份前缀仍是材质 id（不篡改命名空间）').toBe(true)
  })
})
