/**
 * A18 `gpu-batching` · A12 `stale-jobs` · G1/G2 —— 呈现编译的**结构侧**判据。
 *
 * 判据分工（本文件 ↔ e2e）：
 *  - **本文件**：绘制数**结构估计**、批次身份稳定性、对象身份稳定性、过期限定、
 *    单例更新不重建全部几何。全部不需要 GPU，任何机器可复现。
 *  - **e2e**：`WebGLRenderer.info.render.calls` 的**实测**数字（真 GL）。
 *
 * 这个分工是刻意的：测试维护要求"提供期望/实际、源码 SHA、夹具哈希和环境"，而结构侧
 * 判据不受显卡/驱动影响，实测侧才是环境相关的证据。只报其中一侧都不足以证明 A18。
 */

import { describe, expect, it } from 'vitest'
import { A18_DRAW_CALL_BUDGET, DEFAULT_BATCH_BUDGET, compatibilityKeyOf, planBatches } from '../batchPlan'
import { compileScene, generationOf, requiredAssetIds } from '../compileScene'
import { PickIndex, evaluateStalePick, isResolutionCurrent } from '../pickingIndex'
import {
  NO_DIGESTS,
  computeInvalidation,
  contentDigestOf,
  defaultPresentationDependencies,
  digestsOf,
  membersDigestOf,
} from '../invalidationPlan'
import { structurallyEqual } from '../evaluationKey'
import {
  DEFAULT_MATERIAL,
  MemoryGeometrySource,
  fixtureHash,
  makeAttributes,
  makeHomogeneousFixture,
  makeKey,
  makePrimitive,
  translationMatrix,
} from './fixtures'

/** A18 夹具规模：10,000 个同几何/同材质不透明对象（A18 原文）。 */
const A18_FIXTURE_SIZE = 10_000

describe('A18 gpu-batching：均质夹具的绘制数结构门槛（≤32）', () => {
  it(`10,000 个同几何/同材质不透明对象 ⇒ 批次结构计数 ≤ ${A18_DRAW_CALL_BUDGET}`, () => {
    const primitives = makeHomogeneousFixture(A18_FIXTURE_SIZE)
    const plans = planBatches(primitives, DEFAULT_BATCH_BUDGET)

    expect(primitives).toHaveLength(A18_FIXTURE_SIZE)
    expect(new Set(plans.map((p) => p.compatibilityKey)).size).toBe(1)
    expect(plans.length).toBeLessThanOrEqual(A18_DRAW_CALL_BUDGET)
    // 成员无遗漏（合并/分片不得丢**图元** —— 丢图元就是假绿）
    const members = plans.flatMap((p) => p.members)
    expect(members).toHaveLength(A18_FIXTURE_SIZE)
    expect(new Set(members.map((m) => m.primitiveKey)).size).toBe(A18_FIXTURE_SIZE)
    expect(new Set(members.map((m) => m.objectId)).size).toBe(A18_FIXTURE_SIZE)

    console.log(
      `[A18·结构] 夹具 ${A18_FIXTURE_SIZE} 对象 同几何/同材质/不透明 ⇒ 批次数 ${plans.length}` +
        `（门槛 ≤${A18_DRAW_CALL_BUDGET}）；夹具哈希 ${fixtureHash([A18_FIXTURE_SIZE, DEFAULT_MATERIAL])}`,
    )
  })

  it('编译结果的 drawCallEstimate 与批次数一致，且 instanceable 批次可实例化', () => {
    const geometry = new MemoryGeometrySource()
    geometry.set('geo:cube', 'v1', makeAttributes(1))
    const result = compileScene(
      { key: makeKey(), geometry, primitives: makeHomogeneousFixture(A18_FIXTURE_SIZE) },
      DEFAULT_BATCH_BUDGET,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.drawCallEstimate).toBe(result.value.plans.length)
    expect(result.value.drawCallEstimate).toBeLessThanOrEqual(A18_DRAW_CALL_BUDGET)
    // 同质 + 同几何 + shared 变形 ⇒ 走实例化路径
    expect(result.value.payloads.every((p) => p.instanceable)).toBe(true)
    expect(result.value.payloads[0]!.instances).toHaveLength(A18_FIXTURE_SIZE)
  })

  it('负对照：一对象一绘制（每对象独立材质身份）⇒ 兼容性组数 = 对象数，判红', () => {
    const n = 64
    // 走**非顶点色**路径：该路径下 tint 决定材质 `color`，故不同 tint 必须分批次。
    // （顶点色路径下 tint 对结果无影响，被归一为 `-` —— 那是正确行为，不是漏洞。）
    const perObject = Array.from({ length: n }, (_, i) =>
      makePrimitive(`obj:${i}`, {
        geometry: { id: 'geo:cube', version: 'v1' },
        material: { ...DEFAULT_MATERIAL, useVertexColor: false, tint: 0x100000 + i },
        transform: translationMatrix(i, 0, 0),
      }),
    )
    // 真正的"一对象一绘制"检出口：不同 tint ⇒ 兼容性键互不相同
    const distinctKeys = new Set(perObject.map(compatibilityKeyOf))
    expect(distinctKeys.size, '不同 tint 必须是不同兼容性组（否则会给 A 的色画到 B 上）').toBe(n)

    const plans = planBatches(perObject, DEFAULT_BATCH_BUDGET)
    // 上界强制会把批次数压到 32，但**必须**显式标记非同质
    expect(plans.length).toBeLessThanOrEqual(A18_DRAW_CALL_BUDGET)
    expect(plans.every((p) => p.homogeneous), '上界合并必须显式标记非同质').toBe(false)
  })

  it('顶点色路径下 tint 被归一（同材质不同 tint 仍可合批，行为不变）', () => {
    // 顶点色路径：染色来自 `geometry.attributes.color`，材质 `color` 恒白
    // ⇒ 不同 tint 不产生不同绘制结果，合批是**正确**的（不是"丢对象"）。
    const a = makePrimitive('obj:a', { material: { ...DEFAULT_MATERIAL, tint: 0x111111 } })
    const b = makePrimitive('obj:b', { material: { ...DEFAULT_MATERIAL, tint: 0x222222 } })
    expect(compatibilityKeyOf(a)).toBe(compatibilityKeyOf(b))
  })

  it('负对照：把 batch index 当对象 ID ⇒ 类型层面不可表达（无 generation 无法解析）', () => {
    const geometry = new MemoryGeometrySource()
    geometry.set('geo:cube', 'v1', makeAttributes(1))
    const primitives = makeHomogeneousFixture(8)
    const result = compileScene({ key: makeKey(), geometry, primitives })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const index = new PickIndex(result.value)

    // 正对照：带正确 generation ⇒ 解回**对象身份**
    const okResolution = index.resolve({
      generation: index.currentGeneration,
      batchIndex: 0,
      instanceSlot: 3,
    })
    expect(okResolution).not.toBeNull()
    expect(okResolution!.objectId).toBe(primitives[3]!.objectId)

    // 负对照：错误的 generation（旧画面）⇒ 拒绝，绝不退化成"按位置找对象"
    expect(index.resolve({ generation: 'g:deadbeef', batchIndex: 0, instanceSlot: 3 })).toBeNull()
    // 负对照：批次内不存在的槽位 ⇒ 暴露为 null（不得猜一个对象）
    expect(index.resolve({ generation: index.currentGeneration, batchIndex: 0, instanceSlot: 9999 })).toBeNull()
  })
})

describe('G2：重新分组/压缩/移出批次后对象 ID 稳定', () => {
  it('批次成员变化不改变对象身份；批次位置可变而对象身份不变', () => {
    const geometry = new MemoryGeometrySource()
    geometry.set('geo:cube', 'v1', makeAttributes(1))
    const geometry2 = new MemoryGeometrySource()
    geometry2.set('geo:cube', 'v1', makeAttributes(1))

    const before = makeHomogeneousFixture(16)
    const compiledBefore = compileScene({ key: makeKey(), geometry, primitives: before })
    expect(compiledBefore.ok).toBe(true)
    if (!compiledBefore.ok) return
    const indexBefore = new PickIndex(compiledBefore.value)

    // 移出 4 个对象（重新分组 / 压缩）
    const after = before.slice(4)
    const compiledAfter = compileScene({ key: makeKey(), geometry: geometry2, primitives: after })
    expect(compiledAfter.ok).toBe(true)
    if (!compiledAfter.ok) return
    const indexAfter = new PickIndex(compiledAfter.value)

    for (const p of after) {
      const a = indexBefore.provenanceOf(p.objectId)
      const b = indexAfter.provenanceOf(p.objectId)
      expect(b, `${p.objectId} 在重分组后必须仍可解析`).toBeDefined()
      expect(b!.objectId).toBe(p.objectId)
      expect(b!.geometryId).toBe(a!.geometryId)
    }
    // 被移出的对象确实不在新映射里（不是"仍然幽灵存在"）
    for (const p of before.slice(0, 4)) {
      expect(indexAfter.provenanceOf(p.objectId)).toBeUndefined()
    }
    // 留下来的对象仍可取到批次位置（类型上要求是 number，而非"稳定不变"）
    expect(typeof indexAfter.batchIndexOf(after[0]!.objectId)).toBe('number')
  })

  it('世代身份由内容派生：同输入同世代；成员/内容变化变世代；机位变化不变', () => {
    const geometry = new MemoryGeometrySource()
    geometry.set('geo:cube', 'v1', makeAttributes(1))
    const primitives = makeHomogeneousFixture(4)
    const key = makeKey()
    const plans = planBatches(primitives)

    expect(generationOf(key, plans)).toBe(generationOf(key, plans))
    expect(
      generationOf({ ...key, viewProjection: { camera: 'cam:other', localDisplay: 'all' } }, plans),
      '机位不进世代身份（A11：机位变化不得引发重算）',
    ).toBe(generationOf(key, plans))
    expect(generationOf({ ...key, documentVersion: 2 }, plans)).not.toBe(generationOf(key, plans))
    expect(generationOf({ ...key, scene: 'scene:other' }, plans)).not.toBe(generationOf(key, plans))
  })
})

describe('A12 stale-jobs：旧结果不覆盖、拾取与显示版本一致', () => {
  const geometry = new MemoryGeometrySource()
  geometry.set('geo:cube', 'v1', makeAttributes(1))
  const primitives = makeHomogeneousFixture(4)

  it('过期的拾取结果被显式挂起（不是静默套用到新版本）', () => {
    const oldKey = makeKey({ documentVersion: 1 })
    const compiled = compileScene({ key: oldKey, geometry, primitives })
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const index = new PickIndex(compiled.value)
    const res = index.resolve({ generation: index.currentGeneration, batchIndex: 0, instanceSlot: 0 })
    expect(res).not.toBeNull()

    const currentKey = makeKey({ documentVersion: 2 })
    const verdict = evaluateStalePick(res, currentKey)
    expect(verdict).not.toBeNull()
    expect(verdict!.kind).toBe('suspend')
    if (verdict!.kind !== 'suspend') return
    expect(verdict!.reason).toBe('stale-evaluation')
    expect(verdict!.detail).toContain('文档版本')
    expect(verdict!.heldVersion.documentVersion).toBe(1)
  })

  it('负对照：不做版本检查（把旧结果直接当当前结果）⇒ 版本断言判红', () => {
    const compiled = compileScene({ key: makeKey({ documentVersion: 1 }), geometry, primitives })
    if (!compiled.ok) return
    const index = new PickIndex(compiled.value)
    const res = index.resolve({ generation: index.currentGeneration, batchIndex: 0, instanceSlot: 0 })!
    const currentKey = makeKey({ documentVersion: 2 })
    // 破坏方式：跳过 `isResolutionCurrent`，直接采用 —— 这正是负对照要判红的做法
    expect(isResolutionCurrent(res, currentKey), '无版本检查的做法必须被判红').toBe(false)
  })

  it('机位变化不算过期（结构性等价 ⇒ apply）', () => {
    const key = makeKey({ viewProjection: { camera: 'cam:a', localDisplay: 'all' } })
    const compiled = compileScene({ key, geometry, primitives })
    if (!compiled.ok) return
    const index = new PickIndex(compiled.value)
    const res = index.resolve({ generation: index.currentGeneration, batchIndex: 0, instanceSlot: 1 })!
    const movedKey = makeKey({ viewProjection: { camera: 'cam:b', localDisplay: 'all' } })
    expect(structurallyEqual(res.keyAtHit, movedKey)).toBe(true)
    expect(evaluateStalePick(res, movedKey)!.kind).toBe('apply')
  })
})

describe('A11 / G1：失效面由版本化输入计算（不是手推计数器）', () => {
  const primitives = makeHomogeneousFixture(16)
  const objectIds = primitives.map((p) => p.objectId)
  /** 几何读集内容摘要（由**几何数据**机械派生，不是凭空填的常量）。 */
  const geometryContent = contentDigestOf(primitives.map((p) => [p.objectId, p.geometry.id, p.geometry.version]))
  const annotationContentA = contentDigestOf(['anno:1', '文字 A'])

  function deps(annotationText: string, memberIds: readonly string[] = objectIds) {
    return defaultPresentationDependencies({
      geometryObjectIds: memberIds,
      geometryContentDigest: contentDigestOf(
        memberIds.map((id) => [id, 'geo:cube', 'v1']),
      ),
      annotationIds: ['anno:1'],
      annotationContentDigest: contentDigestOf(['anno:1', annotationText]),
      materialResourceIds: ['tex:stone'],
      batchContentDigest: contentDigestOf([memberIds.length, 'geo:cube@v1']),
    })
  }

  it('G1：只改注解文字 ⇒ 方块几何重建数为 0，且只有注解节点重算', () => {
    const prevDeps = deps('文字 A')
    const nextDeps = deps('文字 B')
    // 文档版本因这次编辑而推进（注解是内容）—— 但几何**不得**因此重建
    const plan = computeInvalidation(
      makeKey({ documentVersion: 1 }),
      makeKey({ documentVersion: 2 }),
      nextDeps,
      digestsOf(prevDeps),
    )

    expect(plan.recomputeCounts.geometry, 'G1 明文：变一个注解文字不重建全部方块几何').toBe(0)
    expect(plan.recomputeCounts.batchPlan).toBe(0)
    expect(plan.recomputeCounts.annotation).toBe(1)
    const annoVerdict = plan.verdicts.find((v) => v.target === 'annotation')!
    expect(annoVerdict.action).toBe('recompute')
    if (annoVerdict.action !== 'recompute') return
    expect(annoVerdict.reason).toBe('content-changed')
  })

  it('A11：只改机位 ⇒ 几何重建数为 0 且只有 viewProjection 重算', () => {
    const d = deps('文字 A')
    const plan = computeInvalidation(
      makeKey({ viewProjection: { camera: 'cam:a', localDisplay: 'all' } }),
      makeKey({ viewProjection: { camera: 'cam:b', localDisplay: 'all' } }),
      d,
      digestsOf(d),
    )

    expect(plan.viewProjectionChanged).toBe(true)
    expect(plan.structurallyEquivalent, '机位不进主键 ⇒ 结构等价').toBe(true)
    expect(plan.recomputeCounts.geometry, 'A11 明文：机位变化方块几何重建数必须为 0').toBe(0)
    expect(plan.recomputeCounts.material).toBe(0)
    expect(plan.recomputeCounts.batchPlan).toBe(0)
    expect(plan.recomputeCounts.annotation).toBe(0)
    expect(plan.recomputeCounts.viewProjection).toBe(1)
  })

  it('A11：只改一个几何数据 ⇒ 对应依赖更新（几何重算 1，无手动 refresh 入口）', () => {
    const prevDeps = deps('文字 A')
    // 内容变了：几何读集摘要变化（这就是"一个几何数据被编辑"）
    const nextDeps = defaultPresentationDependencies({
      geometryObjectIds: objectIds,
      geometryContentDigest: contentDigestOf(['几何被编辑后的内容']),
      annotationIds: ['anno:1'],
      annotationContentDigest: contentDigestOf(['anno:1', '文字 A']),
      materialResourceIds: ['tex:stone'],
      batchContentDigest: contentDigestOf([objectIds.length, 'geo:cube@v1']),
    })
    const plan = computeInvalidation(
      makeKey({ documentVersion: 1 }),
      makeKey({ documentVersion: 2 }),
      nextDeps,
      digestsOf(prevDeps),
    )
    expect(plan.recomputeCounts.geometry).toBe(1)
    expect(plan.verdicts.find((v) => v.target === 'geometry')!.action).toBe('recompute')
    // 注解内容未变 ⇒ 注解不重算（证明失效是**逐节点**的，不是全量）
    expect(plan.recomputeCounts.annotation).toBe(0)
    void geometryContent
  })

  it('资源版本替换 ⇒ 材质节点重算（A28/A36 的失效侧）', () => {
    const prevDeps = deps('文字 A')
    const plan = computeInvalidation(
      makeKey({ documentVersion: 1, contentResourceVersions: { 'tex:stone': 'v1' } }),
      makeKey({ documentVersion: 1, contentResourceVersions: { 'tex:stone': 'v2' } }),
      prevDeps,
      digestsOf(prevDeps),
    )
    expect(plan.recomputeCounts.material).toBe(1)
    const v = plan.verdicts.find((x) => x.target === 'material')!
    expect(v.action).toBe('recompute')
    if (v.action !== 'recompute') return
    expect(v.reason).toBe('resource-version-changed')
    // 几何读集未变 ⇒ 几何不重建（"换纹理不重建几何"）
    expect(plan.recomputeCounts.geometry).toBe(0)
  })

  it('动态集合**成员变化**必须被计入（不能只跟踪现存成员）', () => {
    const prevDeps = deps('文字 A', objectIds)
    const nextDeps = deps('文字 A', [...objectIds, 'obj:new'])
    const plan = computeInvalidation(
      makeKey({ documentVersion: 1 }),
      makeKey({ documentVersion: 1 }), // 内容版本**没变**
      nextDeps,
      digestsOf(prevDeps),
    )
    const membership = plan.verdicts.find(
      (v) => v.action === 'recompute' && v.reason === 'collection-membership-changed',
    )
    expect(membership, '新增对象必须有明确失效（只跟踪现存成员的实现会漏掉它）').toBeDefined()
    expect(membersDigestOf([...objectIds, 'obj:new'])).not.toBe(membersDigestOf(objectIds))
  })

  it('负对照：把机位混进主键 ⇒ 结构等价断言判红且几何重建数 > 0', () => {
    const d = deps('文字 A')
    const a = makeKey({ viewProjection: { camera: 'cam:a', localDisplay: 'all' } })
    // 破坏方式：把机位差异伪装成文档版本差异（旧 renderViewRevision 正是这个形状）
    const b = makeKey({ documentVersion: 2, viewProjection: { camera: 'cam:b', localDisplay: 'all' } })
    expect(structurallyEqual(a, b)).toBe(false)

    const brokenDeps = defaultPresentationDependencies({
      // 破坏方式：几何节点声明 documentVersion（旧"全量失效"的形状）
      geometryObjectIds: objectIds,
      geometryContentDigest: contentDigestOf(objectIds),
      annotationIds: ['anno:1'],
      materialResourceIds: ['tex:stone'],
    }).map((node) =>
      node.target === 'geometry'
        ? { ...node, inputs: [...node.inputs, 'documentVersion' as const] }
        : node,
    )
    const plan = computeInvalidation(a, b, brokenDeps, digestsOf(d))
    expect(plan.recomputeCounts.geometry, '把内容版本当全局失效开关 ⇒ 几何重建').toBeGreaterThan(0)
  })

  it('场景变化 ⇒ 全树 drop（身份前提消失，不是"全量重建漏了口子"）', () => {
    const d = deps('文字 A')
    const plan = computeInvalidation(
      makeKey({ scene: 'scene:a' }),
      makeKey({ scene: 'scene:b' }),
      d,
      digestsOf(d),
    )
    expect(plan.verdicts.every((v) => v.action === 'drop')).toBe(true)
  })

  it('无变化 ⇒ 全部 reuse（惰性：不动就不算）', () => {
    const d = deps('文字 A')
    const plan = computeInvalidation(makeKey(), makeKey(), d, digestsOf(d))
    expect(plan.recomputeCounts).toEqual({
      geometry: 0,
      material: 0,
      batchPlan: 0,
      annotation: 0,
      viewProjection: 0,
    })
    expect(plan.verdicts.every((v) => v.action === 'reuse')).toBe(true)
  })

  it('诚实边界：初始轮（无上一轮摘要）不做"内容变化"推断，避免假失效', () => {
    const d = deps('文字 A')
    const plan = computeInvalidation(makeKey(), makeKey(), d, NO_DIGESTS)
    expect(plan.recomputeCounts.annotation).toBe(0)
    expect(plan.recomputeCounts.geometry).toBe(0)
  })

  it('摘要必须由读集派生：不同内容 ⇒ 不同摘要（防止"凭判断填写"）', () => {
    expect(contentDigestOf(['a', 'b'])).toBe(contentDigestOf(['b', 'a']))
    expect(contentDigestOf(['文字 A'])).not.toBe(contentDigestOf(['文字 B']))
    expect(annotationContentA).not.toBe(contentDigestOf(['anno:1', '文字 B']))
  })
})

describe('编译的边界与显式失败（A36/G4 的结构侧）', () => {
  it('scene 缺失 ⇒ MissingTarget（不是"看起来完整"的空场景）', () => {
    const geometry = new MemoryGeometrySource()
    geometry.set('geo:cube', 'v1', makeAttributes(1))
    const result = compileScene({ key: makeKey({ scene: '' }), geometry, primitives: [] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('MissingTarget')
  })

  it('几何不可用 ⇒ 对象被**显式**记入 skipped，不静默丢', () => {
    const geometry = new MemoryGeometrySource()
    geometry.set('geo:cube', 'v1', makeAttributes(1))
    geometry.set('geo:missing', 'v1', makeAttributes(1))
    const primitives = [
      makePrimitive('obj:good'),
      makePrimitive('obj:bad', { geometry: { id: 'geo:missing', version: 'v1' } }),
    ]
    geometry.makeUnavailable('geo:missing')

    const result = compileScene({ key: makeKey(), geometry, primitives })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.skipped).toEqual([{ objectId: 'obj:bad', reason: 'geometry-unavailable' }])
    expect(result.value.provenance).toHaveLength(1)
  })

  it('几何内容版本不符 ⇒ 拒绝该对象（不得用旧 GPU 资源冒充新版本）', () => {
    const geometry = new MemoryGeometrySource()
    geometry.set('geo:cube', 'v2', makeAttributes(1))
    const primitives = [makePrimitive('obj:stale', { geometry: { id: 'geo:cube', version: 'v1' } })]
    const result = compileScene({ key: makeKey(), geometry, primitives })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.skipped[0]?.reason).toBe('geometry-version-mismatch')
  })

  it('变换形状非法 ⇒ 显式跳过（不用单位矩阵糊过去）', () => {
    const geometry = new MemoryGeometrySource()
    geometry.set('geo:cube', 'v1', makeAttributes(1))
    const primitives = [makePrimitive('obj:bad-transform', { transform: [1, 0, 0] })]
    const result = compileScene({ key: makeKey(), geometry, primitives })
    if (!result.ok) return
    expect(result.value.skipped[0]?.reason).toBe('transform-shape-invalid')
  })

  it('纯数据投影：编译结果不含任何 three 对象（GPU 上传未发生）', () => {
    const geometry = new MemoryGeometrySource()
    geometry.set('geo:cube', 'v1', makeAttributes(2))
    const result = compileScene({ key: makeKey(), geometry, primitives: makeHomogeneousFixture(4) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const serialized = JSON.stringify(result.value, (_k, v) => (v instanceof Float32Array ? '[f32]' : v))
    expect(serialized).not.toContain('isBufferGeometry')
    expect(serialized).not.toContain('isMaterial')
    // 但**确实**携带了上传所需的一切
    expect(result.value.payloads[0]!.attributes).toBeDefined()
    expect(result.value.payloads[0]!.instances).toHaveLength(4)
  })

  it('G4：必需资源清单由编译结果反推（供导出预检消费）', () => {
    const geometry = new MemoryGeometrySource()
    geometry.set('geo:cube', 'v1', makeAttributes(1))
    const primitives = [
      makePrimitive('a', { material: DEFAULT_MATERIAL }),
      makePrimitive('b', { material: { ...DEFAULT_MATERIAL, id: 'mat:dirt', version: 'v2' } }),
    ]
    const result = compileScene({ key: makeKey(), geometry, primitives })
    if (!result.ok) return
    expect(requiredAssetIds(result.value)).toEqual(['mat:dirt', 'mat:stone'])
  })
})
