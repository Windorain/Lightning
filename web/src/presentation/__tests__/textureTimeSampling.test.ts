/**
 * **presenter 每帧采样**：时间 → 采样 → `repeat.y`/`offset.y`（竖条裁切）。
 *
 * ## 本文件钉什么（设计 §5.2-③）
 *
 * | 判据 | 防什么 |
 * |---|---|
 * | 0.12s ⇒ frame 1 / offset 0.25；0.30s ⇒ frame 3 / 0.75 | 采样没接上（"纹理不动"） |
 * | 回到 0.12s ⇒ 逐字段回到第一读数 | **累加器**实现（没有倒退通路） |
 * | 同值重复调用 ⇒ 读数不变 | 隐藏的累积量 |
 * | 1 圈后（0.40s）回 frame 0 | 循环边界 |
 * | `flipY:true` ⇒ (N-1-frame)/N | 帧序上下颠倒 |
 * | 两次 `setSceneTime` 后 applies/materialBuilds/batchBuilds 不变 | 把时间塞回结构身份（每帧全量重编） |
 * | `setTextureBindings(空)` ⇒ 读数清空、纹理偏移归零 | 采样残留到已卸载纹理 |
 * | 失败序列 ⇒ 偏移不变 + errors 计数 | 用 0 帧冒充成功 |
 *
 * ## 为什么用**真实** `compileScene` + `BatchedPresenter`
 *
 * 唯一被替身的是"取纹理"这一步（`TexturePort` 是端口：GPU 上传在浏览器里）。
 * 绑定、编译、材质、批次、采样与读数全部是生产实现 —— 于是"采样真的写到材质用的
 * 那张 `THREE.Texture` 上"是被断言的事实，而不是假设。
 */
import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { DEFAULT_BATCH_BUDGET } from '../batchPlan'
import { compileScene } from '../compileScene'
import { BatchedPresenter, type TexturePort } from '../presenter'
import { bindTexture, sampleBoundTexture, VOXEL_SAMPLING, type TextureBinding, type TextureSampling } from '../textureBinding'
import { contentIdentityKey, type ContentIdentity } from '../assetIdentity'
import { textureAnimationOf } from '@/domain/textureAnimation'
import type { MaterialDescriptor } from '../evaluationKey'
import type { TextureSequence } from '@/domain/materials'
import { MemoryGeometrySource, makeAttributes, makeKey, makePrimitive } from './fixtures'

const MAP: ContentIdentity = Object.freeze({ id: 'material:0', version: 'v1' })
const MATERIAL: MaterialDescriptor = Object.freeze({
  id: 'material:0',
  version: 'v1',
  blend: 'opaque',
  tint: 0xffffff,
  useVertexColor: true,
})

/** 4 格竖条（16×64）+ 逐帧 ticks [2,3,1,2] ⇒ 时长 [0.1,0.15,0.05,0.1]（总 0.4s）。 */
function stripBinding(sampling: TextureSampling = VOXEL_SAMPLING): TextureBinding {
  const animation = textureAnimationOf({
    id: 'material:0',
    resource: { assetId: 'material:0', contentVersion: 'v1', url: 'inline:0' },
    kind: 'animated',
    animation: {
      defaultFrametimeTicks: 2,
      frameSequence: [
        { index: 0 },
        { index: 1, timeTicks: 3 },
        { index: 2, timeTicks: 1 },
        { index: 3, timeTicks: 2 },
      ],
    },
    width: 16,
    height: 64,
  })
  if (animation === null) throw new Error('夹具：竖条必须派生出序列')
  return bindTexture(MATERIAL, { identity: MAP, required: true, state: 'ready', animation }, sampling)
}

/** 假纹理端口：按内容身份发一张真实 `THREE.DataTexture`（构造不需要 GL）。 */
function fakeTextures(): { port: TexturePort; textureOf: (id: ContentIdentity) => THREE.DataTexture | null } {
  const byKey = new Map<string, THREE.DataTexture>()
  const port: TexturePort = {
    textureFor(identity) {
      const key = contentIdentityKey(identity)
      const existing = byKey.get(key)
      if (existing !== undefined) return existing
      // 16×64 RGBA：像素内容无关（本文件断言采样参数，不测像素）。
      const texture = new THREE.DataTexture(new Uint8Array(16 * 64 * 4), 16, 64)
      texture.wrapS = THREE.ClampToEdgeWrapping
      texture.wrapT = THREE.ClampToEdgeWrapping
      byKey.set(key, texture)
      return texture
    },
  }
  return { port, textureOf: (id) => byKey.get(contentIdentityKey(id)) ?? null }
}

describe('presenter 场景时间 → 样本 → 竖条裁切', () => {
  it('0.12s ⇒ frame 1 / offset 0.25 / repeat 0.25；0.30s ⇒ frame 3 / 0.75', () => {
    const { port, textureOf } = fakeTextures()
    const binding = stripBinding()
    const geometry = new MemoryGeometrySource()
    geometry.set('geo:cube', 'v1', makeAttributes(1))
    const compiled = compileScene(
      { key: makeKey(), geometry, primitives: [makePrimitive('obj:0', { material: MATERIAL })] },
      DEFAULT_BATCH_BUDGET,
    )
    if (!compiled.ok) throw new Error('夹具编译失败')
    const presenter = new BatchedPresenter({
      scope: 'test-texture-time-a',
      textures: port,
      textureBindings: new Map([[MATERIAL.id, binding]]),
    })
    try {
      presenter.apply(compiled.value)
      const texture = textureOf(MAP)!
      expect(texture, '夹具：端口必须真的发出了纹理').not.toBeNull()

      presenter.setSceneTime(0.12)
      let report = presenter.textureSamples()[0]!
      expect(presenter.textureSamples(), '必须有读数（空数组 = 接线未发生）').toHaveLength(1)
      expect(report.frame).toBe(1)
      expect(report.seconds).toBe(0.12)
      expect(report.stripFrameCount).toBe(4)
      expect(report.repeatY).toBe(0.25)
      expect(report.offsetY).toBe(0.25)
      expect(texture.repeat.y).toBe(0.25)
      expect(texture.offset.y, '读数必须就是写到纹理上的值').toBe(0.25)

      presenter.setSceneTime(0.3)
      report = presenter.textureSamples()[0]!
      expect(report.frame).toBe(3)
      expect(report.offsetY).toBe(0.75)
      expect(texture.offset.y).toBe(0.75)

      // **倒退**：回到 0.12 ⇒ 逐字段回到第一读数（累加器实现到这里会红）
      presenter.setSceneTime(0.12)
      expect(presenter.textureSamples()[0]).toEqual({
        assetId: MAP.id,
        contentVersion: MAP.version,
        seconds: 0.12,
        frame: 1,
        nextFrame: 2,
        mix: 0,
        stripFrameCount: 4,
        offsetY: 0.25,
        repeatY: 0.25,
      })
      expect(texture.offset.y).toBe(0.25)
    } finally {
      presenter.dispose()
    }
  })

  it('同值重复调用 ⇒ 读数不变（无累积量）；签名是 (binding, sequence, baseSeconds)', () => {
    const { port } = fakeTextures()
    const binding = stripBinding()
    const geometry = new MemoryGeometrySource()
    geometry.set('geo:cube', 'v1', makeAttributes(1))
    const compiled = compileScene(
      { key: makeKey(), geometry, primitives: [makePrimitive('obj:0', { material: MATERIAL })] },
      DEFAULT_BATCH_BUDGET,
    )
    if (!compiled.ok) throw new Error('夹具编译失败')
    const presenter = new BatchedPresenter({
      scope: 'test-texture-time-b',
      textures: port,
      textureBindings: new Map([[MATERIAL.id, binding]]),
    })
    try {
      presenter.apply(compiled.value)
      presenter.setSceneTime(0.12)
      const first = presenter.textureSamples()[0]!
      const spy = vi.spyOn(presenter as unknown as { applySceneTime: () => void }, 'applySceneTime')
      presenter.setSceneTime(0.12)
      presenter.setSceneTime(0.12)
      expect(spy, '同值必须短路（不重复采样）').not.toHaveBeenCalled()
      expect(presenter.textureSamples()[0]).toEqual(first)
      expect(sampleBoundTexture.length, '采样入口不得有累积增量参数').toBe(3)
    } finally {
      presenter.dispose()
    }
  })

  it('循环：0.40s ⇒ 回 frame 0 / offset 0（1 圈整）', () => {
    const { port } = fakeTextures()
    const binding = stripBinding()
    const geometry = new MemoryGeometrySource()
    geometry.set('geo:cube', 'v1', makeAttributes(1))
    const compiled = compileScene(
      { key: makeKey(), geometry, primitives: [makePrimitive('obj:0', { material: MATERIAL })] },
      DEFAULT_BATCH_BUDGET,
    )
    if (!compiled.ok) throw new Error('夹具编译失败')
    const presenter = new BatchedPresenter({
      scope: 'test-texture-time-c',
      textures: port,
      textureBindings: new Map([[MATERIAL.id, binding]]),
    })
    try {
      presenter.apply(compiled.value)
      presenter.setSceneTime(0.4)
      expect(presenter.textureSamples()[0]!.frame).toBe(0)
      expect(presenter.textureSamples()[0]!.offsetY).toBe(0)
    } finally {
      presenter.dispose()
    }
  })

  it('flipY:true ⇒ offset.y = (N-1-frame)/N（0.12s 时 0.5，不是 0.25）', () => {
    const { port, textureOf } = fakeTextures()
    const binding = stripBinding({ ...VOXEL_SAMPLING, flipY: true })
    const geometry = new MemoryGeometrySource()
    geometry.set('geo:cube', 'v1', makeAttributes(1))
    const compiled = compileScene(
      { key: makeKey(), geometry, primitives: [makePrimitive('obj:0', { material: MATERIAL })] },
      DEFAULT_BATCH_BUDGET,
    )
    if (!compiled.ok) throw new Error('夹具编译失败')
    const presenter = new BatchedPresenter({
      scope: 'test-texture-time-flip',
      textures: port,
      textureBindings: new Map([[MATERIAL.id, binding]]),
    })
    try {
      presenter.apply(compiled.value)
      presenter.setSceneTime(0.12)
      const report = presenter.textureSamples()[0]!
      expect(report.frame, '样本帧与 flipY 无关').toBe(1)
      expect(report.offsetY, 'flipY 分支：倒过来选格').toBe(0.5)
      expect(textureOf(MAP)!.offset.y).toBe(0.5)
    } finally {
      presenter.dispose()
    }
  })

  it('**不重编**：两次 setSceneTime 后 applies/materialBuilds/batchBuilds 不变', () => {
    const { port } = fakeTextures()
    const binding = stripBinding()
    const geometry = new MemoryGeometrySource()
    geometry.set('geo:cube', 'v1', makeAttributes(1))
    const compiled = compileScene(
      { key: makeKey(), geometry, primitives: [makePrimitive('obj:0', { material: MATERIAL })] },
      DEFAULT_BATCH_BUDGET,
    )
    if (!compiled.ok) throw new Error('夹具编译失败')
    const presenter = new BatchedPresenter({
      scope: 'test-texture-time-norecompile',
      textures: port,
      textureBindings: new Map([[MATERIAL.id, binding]]),
    })
    try {
      presenter.apply(compiled.value)
      const before = presenter.statsSnapshot()
      presenter.setSceneTime(0.12)
      presenter.setSceneTime(0.3)
      const after = presenter.statsSnapshot()
      expect(after.applies, '采样不得触发 apply').toBe(before.applies)
      expect(after.materialBuilds).toBe(before.materialBuilds)
      expect(after.batchBuilds).toBe(before.batchBuilds)
      expect(after.geometryBuilds).toBe(before.geometryBuilds)
      expect(presenter.textureSamples()[0]!.frame, '但样本必须真的变了').toBe(3)
    } finally {
      presenter.dispose()
    }
  })

  it('负对照：setTextureBindings(空) ⇒ 读数清空、纹理偏移归零、材质不再带 map', () => {
    const { port, textureOf } = fakeTextures()
    const binding = stripBinding()
    const geometry = new MemoryGeometrySource()
    geometry.set('geo:cube', 'v1', makeAttributes(1))
    const compiled = compileScene(
      { key: makeKey(), geometry, primitives: [makePrimitive('obj:0', { material: MATERIAL })] },
      DEFAULT_BATCH_BUDGET,
    )
    if (!compiled.ok) throw new Error('夹具编译失败')
    const presenter = new BatchedPresenter({
      scope: 'test-texture-time-unbind',
      textures: port,
      textureBindings: new Map([[MATERIAL.id, binding]]),
    })
    try {
      presenter.apply(compiled.value)
      presenter.setSceneTime(0.3)
      expect(presenter.textureSamples()).toHaveLength(1)

      presenter.setTextureBindings(new Map())
      expect(presenter.textureSamples(), '卸载后不得残留读数').toEqual([])
      const texture = textureOf(MAP)!
      expect(texture.offset.y, '不再动画 ⇒ 偏移必须归零（否则静态贴图被裁成一格）').toBe(0)
      expect(texture.repeat.y).toBe(1)
      const meshes: THREE.Mesh[] = []
      presenter.object3d.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh)
      })
      expect(meshes.length).toBeGreaterThan(0)
      for (const m of meshes) {
        expect((m.material as THREE.MeshBasicMaterial).map ?? null, '无绑定 ⇒ 材质不得带 map').toBeNull()
      }
    } finally {
      presenter.dispose()
    }
  })

  it('负对照：采样失败的序列 ⇒ 偏移不变、errors 计数 +1（不用 0 帧冒充成功）', () => {
    const { port, textureOf } = fakeTextures()
    // 手工造一个"空帧"序列（生产派生不可能产出它；这里就是要走 err 分支）。
    const emptySequence: TextureSequence = Object.freeze({
      id: 'material:0',
      resource: Object.freeze({ assetId: 'material:0', contentVersion: 'v1', url: '' }),
      frames: Object.freeze([]),
      loop: 'loop' as const,
    })
    const broken: TextureBinding = Object.freeze({
      ...bindTexture(MATERIAL, { identity: MAP, required: true, state: 'ready' }),
      animation: Object.freeze({ sequence: emptySequence, stripFrameCount: 4 }),
    })
    const geometry = new MemoryGeometrySource()
    geometry.set('geo:cube', 'v1', makeAttributes(1))
    const compiled = compileScene(
      { key: makeKey(), geometry, primitives: [makePrimitive('obj:0', { material: MATERIAL })] },
      DEFAULT_BATCH_BUDGET,
    )
    if (!compiled.ok) throw new Error('夹具编译失败')
    const presenter = new BatchedPresenter({
      scope: 'test-texture-time-err',
      textures: port,
      textureBindings: new Map([[MATERIAL.id, broken]]),
    })
    try {
      presenter.apply(compiled.value)
      const before = textureOf(MAP)!.offset.y
      // apply() 末尾本身会强制采样一次（坏序列 ⇒ 已计 1 次），故这里断言**增量**。
      const errorsBefore = presenter.textureSampleStats().errors
      expect(errorsBefore, 'apply 的初值落盘也走同一采样入口').toBe(1)
      presenter.setSceneTime(0.12)
      expect(presenter.textureSampleStats().errors, '一次失败采样必须 +1').toBe(errorsBefore + 1)
      expect(textureOf(MAP)!.offset.y, '失败时保持上一次偏移，不得写 0').toBe(before)
      expect(presenter.textureSamples(), '失败不产读数（读数只说成功样本）').toEqual([])
    } finally {
      presenter.dispose()
    }
  })
})
