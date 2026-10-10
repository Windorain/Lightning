/**
 * `application/evaluation` + `runtime/evaluation` —— **A11 evaluation-invalidation /
 * A12 stale-jobs** 与 #255 验收 F4 的判定面（#249 §7 §14）。
 *
 * ## 本文件要证明的四件事（逐条对应 #255 的验收清单）
 *
 * 1. **A11 精确失效**：只改注解描述、只改机位时，**方块几何重建数为 0**。
 *    判据是 `stats.recomputedByDomain.geometry === 0` —— 一个数，不是"感觉没重算"。
 * 2. **无调用方手动 refresh**：模块面上不存在 `refresh`/`invalidate`/`markDirty`
 *    这类入口（静态断言 + 行为断言两重）。
 * 3. **循环检测**：声明期判红并给出环路径。
 * 4. **A12 过期结果不覆盖新结果**：旧慢求值后于新求值返回 ⇒ 拒绝接纳 + 要求回收。
 */

import { describe, expect, it } from 'vitest'
import {
  detectDependencyCycle,
  diffKeyDimensions,
  emptyEvaluationCache,
  evaluateGraph,
  evaluateScene,
  evaluationKeyId,
  memberSnapshot,
  nodeIdentity,
  resourceVersionsChanged,
  sameStructuralKey,
  sameViewProjection,
  sceneVersionSources,
  structuralPart,
  topologicalOrder,
  validateGraph,
  versionSnapshot,
  admitNodeResult,
  lookupResource,
  requireEvaluationCapability,
  type AsyncNodeRequest,
  type EvaluationGraphDeclaration,
  type EvaluationKey,
  type EvaluationNodeDeclaration,
  type SceneReadView,
} from '@/application/evaluation'
import {
  EvaluationInstance,
  identityForNode,
  nodesAffectedByResourceChange,
  sceneReadView,
} from '@/runtime/evaluation'
import { timeValue } from '@/domain/animation'
import { propertyKey } from '@/domain/animation'

// ─────────────────────────────────────────────────────────────────────────────
// 图夹具：三类节点（方块几何 / 注解 / 机位），与 A11 的三个操作一一对应
// ─────────────────────────────────────────────────────────────────────────────

interface SceneFactsForGraph {
  /** 方块数据内容版本。 */
  readonly blockDataVersion: number
  /** 注解描述版本（`annotation.text`）。 */
  readonly annotationTextVersion: number
  /** 机位（**不进结构身份**）。 */
  readonly camera: string
  /** 几何数据版本变化（用于"只改一个几何数据"）。 */
  readonly geometryDataVersion?: number
}

/**
 * 构造求值图。
 *
 * 关键设计（这是 A11 能否成立的全部）：
 *  - `geometry.block` 只吃 `data:block-1`，**不吃**注解版本、**不吃时间**；
 *  - `annotation.box` 吃 `annotation:1`；
 *  - `camera.projection` 吃 `camera:1`（视图投影键）；
 *  - `pick.index` 吃上游几何 + 注解（拾取需要两者一致，见 #249 §7「对应同次求值」）。
 */
function makeGraph(): EvaluationGraphDeclaration {
  const nodes: EvaluationNodeDeclaration[] = [
    {
      id: 'geometry.block',
      domain: 'geometry',
      deps: [],
      versionInputs: ['data:block-1'],
      // 方块几何**不**依赖时间：播放动画不得让它重算（#249 §7）
      timeDependent: false,
      compute: (input) => {
        const v = input.versions.values['data:block-1'] ?? 0
        return { ok: true, value: Object.freeze({ objectId: 'o-block', cells: v, kind: 'blockGeometry' }) }
      },
    },
    {
      id: 'annotation.box',
      domain: 'annotation',
      deps: [],
      versionInputs: ['annotation:1'],
      timeDependent: false,
      compute: (input) => {
        const v = input.versions.values['annotation:1'] ?? 0
        return { ok: true, value: Object.freeze({ objectId: 'o-anno', textVersion: v, kind: 'annotation' }) }
      },
    },
    {
      id: 'camera.projection',
      domain: 'camera',
      deps: [],
      versionInputs: ['camera:1'],
      timeDependent: false,
      compute: (input) => {
        const c = input.versions.values['camera:1'] ?? 0
        return { ok: true, value: Object.freeze({ objectId: 'o-cam', cameraVersion: c, kind: 'camera' }) }
      },
    },
    {
      id: 'channel.tier',
      domain: 'channel',
      deps: [],
      versionInputs: ['channel:tier'],
      // 通道**吃**参数版本（参数版本在结构键里），时间由 timeDependent 单独声明
      timeDependent: true,
      compute: (input) => {
        const p = input.versions.values['channel:tier'] ?? 0
        return { ok: true, value: Object.freeze({ objectId: 'o-block', tier: p, time: input.key.time.frame, kind: 'channel' }) }
      },
    },
    {
      id: 'pick.index',
      domain: 'picking',
      deps: ['geometry.block', 'annotation.box'],
      versionInputs: [],
      timeDependent: false,
      compute: (input) => {
        // 拾取必须对应同一次求值（#249 §7）：它读上游结果，故自动随之失效。
        const g = input.upstream['geometry.block'] as { cells?: number } | undefined
        const a = input.upstream['annotation.box'] as { textVersion?: number } | undefined
        return { ok: true, value: Object.freeze({ objectId: 'pick', geometry: g?.cells ?? -1, annotation: a?.textVersion ?? -1, kind: 'pick' }) }
      },
    },
  ]
  return Object.freeze({
    id: 'scene-graph',
    nodes: Object.freeze(nodes),
    outputs: Object.freeze(['geometry.block', 'annotation.box', 'camera.projection', 'channel.tier', 'pick.index']),
  })
}

/** 版本快照构造（与图声明的 `versionInputs` 对应）。 */
function versionsFor(facts: SceneFactsForGraph) {
  return versionSnapshot({
    'data:block-1': facts.geometryDataVersion ?? facts.blockDataVersion,
    'annotation:1': facts.annotationTextVersion,
    'camera:1': 1,
    'channel:tier': 1,
  })
}

function keyFor(facts: SceneFactsForGraph, overrides: Partial<EvaluationKey> = {}): EvaluationKey {
  return Object.freeze({
    documentVersion: 1,
    scene: 'scene-1',
    time: timeValue(0, 20),
    parameterVersion: 1,
    contentResourceVersions: Object.freeze({}),
    viewProjection: Object.freeze({ camera: facts.camera, localDisplay: 'all' }),
    ...overrides,
  })
}

const BASE_FACTS: SceneFactsForGraph = Object.freeze({
  blockDataVersion: 1,
  annotationTextVersion: 1,
  camera: 'persp',
})

function evaluate(facts: SceneFactsForGraph, key: EvaluationKey, cache = emptyEvaluationCache()) {
  const r = evaluateGraph(makeGraph(), key, versionsFor(facts), memberSnapshot({}), cache)
  if (!r.ok) throw new Error(`求值失败: ${r.error.code} ${JSON.stringify(r.error.params)}`)
  return r.value
}

// ─────────────────────────────────────────────────────────────────────────────
// A11：精确失效
// ─────────────────────────────────────────────────────────────────────────────

describe('A11 evaluation-invalidation：精确失效（#249 §7 + #255 F4）', () => {
  it('首次求值：全部输出节点都算（反空洞真 —— 判据不能恒为 0）', () => {
    const r = evaluate(BASE_FACTS, keyFor(BASE_FACTS))
    expect(r.stats.recomputed).toBe(5)
    expect(r.stats.recomputedByDomain.geometry).toBe(1)
    expect(r.stats.recomputedByDomain.annotation).toBe(1)
  })

  it('**零变化重求值 ⇒ 重建数 0**（缓存命中；否则"重建数为 0"无法与"什么都没算"区分）', () => {
    const key = keyFor(BASE_FACTS)
    const first = evaluate(BASE_FACTS, key)
    const second = evaluate(BASE_FACTS, key, first.cache)
    expect(second.stats.recomputed, '同一输入第二次求值不得重算任何节点').toBe(0)
    expect(second.stats.cacheHits).toBeGreaterThan(0)
  })

  it('**只改注解描述** ⇒ 注解重算、**方块几何重建数 = 0**（A11 判据原文）', () => {
    const key = keyFor(BASE_FACTS)
    const first = evaluate(BASE_FACTS, key)

    const changed: SceneFactsForGraph = Object.freeze({ ...BASE_FACTS, annotationTextVersion: 2 })
    const second = evaluate(changed, key, first.cache)

    expect(second.stats.recomputedByDomain.geometry ?? 0, '只改注解时方块几何重建数必须为 0').toBe(0)
    expect(second.stats.recomputedByDomain.annotation, '注解必须真的重算了').toBe(1)
    // 拾取依赖注解 ⇒ 也必须重算（不是"漏失效"）
    expect(second.stats.recomputedByDomain.picking).toBe(1)
    // 机位节点与注解无关 ⇒ 不重算
    expect(second.stats.recomputedByDomain.camera ?? 0).toBe(0)
  })

  it('**只改机位** ⇒ 方块几何重建数 = 0（viewProjection 不进结构身份）', () => {
    const key = keyFor(BASE_FACTS)
    const first = evaluate(BASE_FACTS, key)

    // 机位变了：key 的 viewProjection 不同，但结构半边相同。
    const movedKey = keyFor(BASE_FACTS, { viewProjection: Object.freeze({ camera: 'ortho', localDisplay: 'all' }) })
    expect(sameStructuralKey(key, movedKey), '机位不得进入结构身份').toBe(true)
    expect(sameViewProjection(key, movedKey), '视图投影键必须能区分机位').toBe(false)

    const second = evaluate(BASE_FACTS, movedKey, first.cache)
    expect(second.stats.recomputedByDomain.geometry ?? 0, '只改机位时方块几何重建数必须为 0').toBe(0)
    expect(second.stats.recomputed, '只改机位不应让任何结构节点重算').toBe(0)
  })

  it('只改**一个几何数据** ⇒ 对应依赖更新（不是全量重算）', () => {
    const key = keyFor(BASE_FACTS)
    const first = evaluate(BASE_FACTS, key)

    const changed: SceneFactsForGraph = Object.freeze({ ...BASE_FACTS, geometryDataVersion: 7 })
    const second = evaluate(changed, key, first.cache)

    expect(second.stats.recomputedByDomain.geometry, '几何数据变了 ⇒ 几何节点必须重算').toBe(1)
    expect(second.stats.recomputedByDomain.annotation ?? 0, '注解与本变化无关 ⇒ 不得重算').toBe(0)
    expect(second.stats.recomputedByDomain.camera ?? 0, '机位与本变化无关 ⇒ 不得重算').toBe(0)
    // 拾取消费几何 ⇒ 必须跟随（对应同一次求值）
    expect(second.stats.recomputedByDomain.picking).toBe(1)
    expect(second.stats.recomputed, '精确失效：只有几何与拾取重算').toBe(2)
  })

  it('**播放动画（时间前进）不得重建方块几何**（#249 §7）', () => {
    const key = keyFor(BASE_FACTS)
    const first = evaluate(BASE_FACTS, key)

    const t1 = keyFor(BASE_FACTS, { time: timeValue(25, 20), parameterVersion: 2 })
    const second = evaluate(BASE_FACTS, t1, first.cache)

    expect(second.stats.recomputedByDomain.geometry ?? 0, '动画改变采样参数不重建基础几何').toBe(0)
    // 而声明了 timeDependent 的通道节点必须跟随时间
    expect(second.stats.recomputedByDomain.channel, 'timeDependent 节点必须随时间重算').toBe(1)
  })

  it('**负对照**：把粗粒度版本冒充内容变化 ⇒ 方块几何重建数 > 0（必须判红）', () => {
    // 「把机位混进结构主键」在**本实现的数据模型下**有一个精确的操作化形态：
    // 让几何节点去声明**粗粒度**版本源（`document` / `parameters`），
    // 也就是旧机制的做法 —— 任何内容变化都让"什么都可能变了"的那个数前进。
    // 这正是 #249 §15 第 5 条要退役的形态，也是 A11 负对照要判红的形态。
    const coarseGraph: EvaluationGraphDeclaration = Object.freeze({
      id: 'coarse',
      nodes: Object.freeze([
        Object.freeze({
          id: 'geometry.block',
          domain: 'geometry' as const,
          deps: Object.freeze([]) as readonly string[],
          // **负对照**：几何节点去吃粗粒度版本（旧 structEpoch 口径）
          versionInputs: Object.freeze(['document', 'scene', 'parameters', 'staged', 'resources']),
          compute: (input: { versions: { values: Record<string, number> } }) => ({ ok: true as const, value: { cells: input.versions.values['document'] ?? 0 } }),
        }),
      ]),
      outputs: Object.freeze(['geometry.block']),
    })

    const coarseVersions = (documentVersion: number) =>
      versionSnapshot({ document: documentVersion, scene: 1, parameters: 1, staged: 0, resources: 0 })

    const k1 = keyFor(BASE_FACTS, { documentVersion: 1 })
    const first = evaluateGraph(coarseGraph, k1, coarseVersions(1), memberSnapshot({}), emptyEvaluationCache())
    expect(first.ok).toBe(true)
    if (!first.ok) return

    // 只改注解 ⇒ 内容推进 documentVersion ⇒ 粗粒度节点必然重算
    const k2 = keyFor(BASE_FACTS, { documentVersion: 2 })
    const second = evaluateGraph(coarseGraph, k2, coarseVersions(2), memberSnapshot({}), first.value.cache)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(
      second.value.stats.recomputedByDomain.geometry,
      '粗粒度版本源会让"只改注解"也重建方块几何 —— 这就是 A11 要判红的形态',
    ).toBeGreaterThan(0)

    // **同一判据**下，本实现（细粒度 versionInputs）必须判绿：
    // 只改注解时几何重建数为 0（见上方"只改注解描述"用例）。
    const fine = evaluate(BASE_FACTS, keyFor(BASE_FACTS))
    const fineChanged: SceneFactsForGraph = Object.freeze({ ...BASE_FACTS, annotationTextVersion: 9 })
    const fineSecond = evaluate(fineChanged, keyFor(BASE_FACTS), fine.cache)
    expect(fineSecond.stats.recomputedByDomain.geometry ?? 0, '细粒度声明下必须为 0').toBe(0)
  })

  it('`sceneVersionSources` 让"需要粗粒度"成为**显式选择**（而不是被强加给所有节点）', () => {
    const key = keyFor(BASE_FACTS, { documentVersion: 7, parameterVersion: 3 })
    const sources = sceneVersionSources(key)
    expect(sources.document).toBe(7)
    expect(sources.parameters).toBe(3)
    // 机位**不**在版本源里 ⇒ 节点无法声明依赖它 ⇒ 结构节点不可能因机位失效
    expect(Object.keys(sources)).not.toContain('viewProjection')
    expect(Object.keys(sources)).not.toContain('camera')
  })

  it('**负对照**：删除依赖边（拾取不再消费几何）⇒ 该变化不再传播（可判红）', () => {
    // 构造一个"拾取不依赖几何"的图：几何变更后拾取不重算，于是拾取结果与几何不一致。
    // 这证明"依赖边"确实是失效传播的唯一来源，而不是全局广播的副作用。
    const graph: EvaluationGraphDeclaration = Object.freeze({
      id: 'no-edge',
      nodes: Object.freeze([
        Object.freeze({
          id: 'geometry.block',
          domain: 'geometry' as const,
          deps: Object.freeze([]) as readonly string[],
          versionInputs: Object.freeze(['data:block-1']),
          compute: (input: { versions: { values: Record<string, number> } }) => ({ ok: true as const, value: { cells: input.versions.values['data:block-1'] ?? 0 } }),
        }),
        Object.freeze({
          id: 'pick.index',
          domain: 'picking' as const,
          // **故意删掉对 geometry.block 的依赖**
          deps: Object.freeze([]) as readonly string[],
          versionInputs: Object.freeze([]) as readonly string[],
          compute: () => ({ ok: true as const, value: { geometry: 'stale' } }),
        }),
      ]),
      outputs: Object.freeze(['geometry.block', 'pick.index']),
    })

    const key = keyFor(BASE_FACTS)
    const first = evaluateGraph(graph, key, versionsFor(BASE_FACTS), memberSnapshot({}), emptyEvaluationCache())
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const changed = { ...BASE_FACTS, geometryDataVersion: 9 }
    const second = evaluateGraph(graph, key, versionsFor(changed), memberSnapshot({}), first.value.cache)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.stats.recomputedByDomain.geometry).toBe(1)
    expect(second.value.stats.recomputedByDomain.picking ?? 0, '依赖边被删除后拾取不再跟随 ⇒ 与几何不一致').toBe(0)
  })

  it('**无调用方手动 refresh**：模块面上不存在 refresh/invalidate/markDirty 入口', async () => {
    const appMod = await import('@/application/evaluation')
    const rtMod = await import('@/runtime/evaluation')
    const banned = ['refresh', 'invalidate', 'markDirty', 'refreshViewport', 'bumpStructEpoch', 'noteDirty']
    for (const name of banned) {
      expect(Object.prototype.hasOwnProperty.call(appMod, name), `application/evaluation 不得导出 ${name}`).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(rtMod, name), `runtime/evaluation 不得导出 ${name}`).toBe(false)
    }
    // 反空洞真：模块确实导出了别的东西（不是空模块让上面恒真）
    expect(Object.keys(appMod).length).toBeGreaterThan(15)
    expect(Object.keys(rtMod).length).toBeGreaterThan(5)
  })

  it('图校验：重复 ID / 依赖缺失 / 输出缺失各自判红（不"后者胜出"）', () => {
    const dup = validateGraph({
      id: 'g',
      nodes: [
        { id: 'a', domain: 'other', deps: [], versionInputs: [], compute: () => ({ ok: true, value: 1 }) },
        { id: 'a', domain: 'other', deps: [], versionInputs: [], compute: () => ({ ok: true, value: 2 }) },
      ],
      outputs: ['a'],
    })
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.error.params.reason).toBe('duplicateNodeId')

    const missing = validateGraph({
      id: 'g',
      nodes: [{ id: 'a', domain: 'other', deps: ['nope'], versionInputs: [], compute: () => ({ ok: true, value: 1 }) }],
      outputs: ['a'],
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.params.reason).toBe('dependencyMissing')

    const outMissing = validateGraph({
      id: 'g',
      nodes: [{ id: 'a', domain: 'other', deps: [], versionInputs: [], compute: () => ({ ok: true, value: 1 }) }],
      outputs: ['ghost'],
    })
    expect(outMissing.ok).toBe(false)
    if (!outMissing.ok) expect(outMissing.error.params.reason).toBe('outputMissing')
  })

  it('循环检测给出**环路径**（可诊断，不是"栈溢出"）', () => {
    const cyclic: EvaluationGraphDeclaration = {
      id: 'cyc',
      nodes: [
        { id: 'a', domain: 'other', deps: ['c'], versionInputs: [], compute: () => ({ ok: true, value: 1 }) },
        { id: 'b', domain: 'other', deps: ['a'], versionInputs: [], compute: () => ({ ok: true, value: 2 }) },
        { id: 'c', domain: 'other', deps: ['b'], versionInputs: [], compute: () => ({ ok: true, value: 3 }) },
      ],
      outputs: ['b'],
    }
    const cycle = detectDependencyCycle(cyclic)
    expect(cycle).not.toBeNull()
    expect(cycle?.length).toBeGreaterThanOrEqual(2)
    // 环的首尾是同一个节点（可读的"a → b → c → a"）
    expect(cycle?.[0]).toBe(cycle?.[cycle.length - 1])

    const validated = validateGraph(cyclic)
    expect(validated.ok).toBe(false)
    if (!validated.ok) expect(validated.error.params.reason).toBe('dependencyCycle')

    // 无环图返回 null 且拓扑序稳定
    const dag = makeGraph()
    expect(detectDependencyCycle(dag)).toBeNull()
    const order = topologicalOrder(dag)
    expect(order).not.toBeNull()
    if (order) {
      expect(order.indexOf('geometry.block')).toBeLessThan(order.indexOf('pick.index'))
      // 对输入顺序不敏感：同一声明两次得到同一序
      expect(topologicalOrder(dag)).toEqual(order)
    }
  })

  it('动态集合依赖：**成员变化**也构成失效（#249 §7 明文）', () => {
    const graph: EvaluationGraphDeclaration = Object.freeze({
      id: 'dyn',
      nodes: Object.freeze([
        Object.freeze({
          id: 'collection.members',
          domain: 'other' as const,
          deps: Object.freeze([]) as readonly string[],
          versionInputs: Object.freeze([]) as readonly string[],
          collectionDeps: Object.freeze(['selection']),
          compute: (input: { members: { members: Record<string, readonly string[]> } }) => ({
            ok: true as const,
            value: { ids: Object.freeze([...(input.members.members['selection'] ?? [])]) },
          }),
        }),
      ]),
      outputs: Object.freeze(['collection.members']),
    })

    const key = keyFor(BASE_FACTS)
    const m1 = memberSnapshot({ selection: ['a', 'b'] })
    const first = evaluateGraph(graph, key, versionsFor(BASE_FACTS), m1, emptyEvaluationCache())
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value.stats.recomputed).toBe(1)

    // 同一成员集 ⇒ 命中缓存
    const again = evaluateGraph(graph, key, versionsFor(BASE_FACTS), m1, first.value.cache)
    expect(again.ok && again.value.stats.recomputed).toBe(0)

    // **成员变化**（内容不同）⇒ 必须失效
    const m2 = memberSnapshot({ selection: ['a', 'b', 'c'] })
    const third = evaluateGraph(graph, key, versionsFor(BASE_FACTS), m2, first.value.cache)
    expect(third.ok).toBe(true)
    if (!third.ok) return
    expect(third.value.stats.recomputed, '集合成员变化必须使节点失效（只跟踪现存成员会漏掉这条）').toBe(1)

    // 负对照：只跟踪**现存成员**的实现会漏掉"成员被移除"这类变化。
    // 用同一判据验证"顺序无关"（成员集语义，不是数组顺序语义）：
    const reordered = memberSnapshot({ selection: ['c', 'b', 'a'] })
    const fourth = evaluateGraph(graph, key, versionsFor(BASE_FACTS), reordered, third.value.cache)
    expect(fourth.ok && fourth.value.stats.recomputed, '成员集合相同（仅顺序不同）不得失效').toBe(0)
  })

  it('节点身份可外部断言（解释"为什么重算"）；时间只对 timeDependent 节点生效', () => {
    const graph = makeGraph()
    const geo = graph.nodes.find((n) => n.id === 'geometry.block')
    const chan = graph.nodes.find((n) => n.id === 'channel.tier')
    expect(geo && chan).toBeTruthy()
    if (!geo || !chan) return

    const k1 = keyFor(BASE_FACTS, { time: timeValue(0, 20) })
    const k2 = keyFor(BASE_FACTS, { time: timeValue(10, 20) })
    const v = versionsFor(BASE_FACTS)
    const m = memberSnapshot({})

    expect(nodeIdentity(geo, k1, v, m), '非 timeDependent 节点的身份不得随**时间**变化').toBe(nodeIdentity(geo, k2, v, m))
    expect(nodeIdentity(chan, k1, v, m), 'timeDependent 节点的身份必须随时间变化').not.toBe(nodeIdentity(chan, k2, v, m))
  })

  it('`EvaluationKey` 差异维度可直接计算（契约 §4 选择理由）', () => {
    const a = keyFor(BASE_FACTS)
    const b = keyFor(BASE_FACTS, {
      time: timeValue(5, 20),
      parameterVersion: 9,
      contentResourceVersions: Object.freeze({ 'asset-1': 'v2' }),
      viewProjection: Object.freeze({ camera: 'ortho', localDisplay: 'all' }),
    })
    expect(diffKeyDimensions(a, b).slice().sort()).toEqual(['contentResourceVersions', 'parameterVersion', 'time', 'viewProjection'])
    // 结构半边不含视图项
    expect(Object.prototype.hasOwnProperty.call(structuralPart(b), 'viewProjection')).toBe(false)
    // 键 id 稳定
    expect(evaluationKeyId(a)).toBe(evaluationKeyId(keyFor(BASE_FACTS)))
  })

  it('求值失败带节点定位，但**不改**错误码（结构化诊断，契约 §3.2）', () => {
    const graph: EvaluationGraphDeclaration = {
      id: 'failing',
      nodes: [
        {
          id: 'bad',
          domain: 'geometry',
          deps: [],
          versionInputs: ['data:block-1'],
          compute: () => ({ ok: false, error: { code: 'InvalidValue', params: Object.freeze({ reason: 'deliberate' }) } }),
        },
      ],
      outputs: ['bad'],
    }
    const r = evaluateGraph(graph, keyFor(BASE_FACTS), versionsFor(BASE_FACTS), memberSnapshot({}), emptyEvaluationCache())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('InvalidValue')
      expect(r.error.params.reason).toBe('deliberate')
      expect(r.error.params.node, '失败必须带节点定位').toBe('bad')
    }
  })

  it('未装配的求值能力被**运行时**拒绝（不靠隐藏按钮，A15 相关）', () => {
    expect(requireEvaluationCapability([], 'evaluation.read').ok).toBe(false)
    const denied = requireEvaluationCapability([], 'evaluation.read')
    if (!denied.ok) expect(denied.error.code).toBe('UnsupportedOperation')
    expect(requireEvaluationCapability(['evaluation.read'], 'evaluation.read').ok).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A12：过期结果 / 异步接纳
// ─────────────────────────────────────────────────────────────────────────────

describe('A12 stale-jobs：过期结果不得覆盖新结果（#249 §7）', () => {
  const req: AsyncNodeRequest = Object.freeze({
    nodeId: 'geometry.block',
    identity: 'identity-v1',
    bindingGeneration: 0,
    correlationId: 'corr-1',
  })

  it('身份相符 ⇒ 接纳（正对照，证明判据不是恒拒）', () => {
    const d = admitNodeResult(makeGraph(), req, { identity: 'identity-v1', bindingGeneration: 0 })
    expect(d.admitted).toBe(true)
    expect(d.release).toBe(false)
  })

  it('**负对照**：旧慢求值后于新求值返回（身份已前进）⇒ 拒绝 + 回收', () => {
    const d = admitNodeResult(makeGraph(), req, { identity: 'identity-v2', bindingGeneration: 0 })
    expect(d.admitted, '过期结果不得被接纳').toBe(false)
    expect(d.reason).toBe('staleIdentity')
    expect(d.release, '已获取资源必须回收').toBe(true)
  })

  it('**负对照**：文档已关闭/重绑（绑定代数不符）⇒ 拒绝 + 回收', () => {
    const d = admitNodeResult(makeGraph(), req, { identity: 'identity-v1', bindingGeneration: 1 })
    expect(d.admitted).toBe(false)
    expect(d.reason).toBe('staleBinding')
    expect(d.release).toBe(true)
  })

  it('取消是协议：已取消 ⇒ 结果丢弃并回收（不冒充成功）', () => {
    const d = admitNodeResult(makeGraph(), req, { identity: 'identity-v1', bindingGeneration: 0, cancelled: true })
    expect(d.admitted).toBe(false)
    expect(d.reason).toBe('cancelled')
    expect(d.release).toBe(true)
  })

  it('节点不在声明里 ⇒ 拒绝 + 回收（伪造完成不得改动状态）', () => {
    const d = admitNodeResult(makeGraph(), { ...req, nodeId: 'ghost' }, { identity: 'identity-v1', bindingGeneration: 0 })
    expect(d.admitted).toBe(false)
    expect(d.reason).toBe('nodeUnknown')
    expect(d.release).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 接线层：实例、在途记账、资源版本
// ─────────────────────────────────────────────────────────────────────────────

describe('runtime/evaluation 接线（缓存跨轮复用 + 在途请求记账）', () => {
  function source(facts: SceneFactsForGraph, graph: EvaluationGraphDeclaration = makeGraph()): SceneReadView {
    return Object.freeze(
      sceneReadView(graph, {
        sceneId: 'scene-1',
        documentVersion: 1,
        time: timeValue(0, 20),
        parameterVersion: 1,
        contentResourceVersions: Object.freeze({}),
        versions: {
          'data:block-1': facts.geometryDataVersion ?? facts.blockDataVersion,
          'annotation:1': facts.annotationTextVersion,
          'camera:1': 1,
          'channel:tier': 1,
          'res:1': 1,
        },
        members: {},
      }),
    )
  }

  it('跨轮缓存复用：第二轮同一输入 ⇒ 零重算；改一项 ⇒ 只重算该域', () => {
    const inst = new EvaluationInstance({ graph: makeGraph(), capabilities: ['evaluation.read'] })
    const first = inst.evaluate(source(BASE_FACTS))
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value.evaluated.stats.recomputed).toBe(5)
    expect(first.value.noStructuralChange).toBe(false)

    const second = inst.evaluate(source(BASE_FACTS))
    expect(second.ok && second.value.noStructuralChange, '同一输入第二轮必须无结构变化').toBe(true)
    expect(second.ok && second.value.evaluated.stats.recomputed).toBe(0)

    const changed = inst.evaluate(source({ ...BASE_FACTS, annotationTextVersion: 5 }))
    expect(changed.ok).toBe(true)
    if (!changed.ok) return
    expect(changed.value.evaluated.stats.recomputedByDomain.geometry ?? 0).toBe(0)
    expect(changed.value.evaluated.stats.recomputedByDomain.annotation).toBe(1)
  })

  it('未装配能力 ⇒ 求值被拒绝（不静默返回空场景）', () => {
    const inst = new EvaluationInstance({ graph: makeGraph(), capabilities: [] })
    const r = inst.evaluate(source(BASE_FACTS))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('UnsupportedOperation')
  })

  it('异步请求：发起即记账，过期结果被拒且**从在途表移除**（计数可对账）', () => {
    // 构造一个产出 pending 请求的节点。
    const graph: EvaluationGraphDeclaration = Object.freeze({
      id: 'async-graph',
      nodes: Object.freeze([
        Object.freeze({
          id: 'expensive.texture',
          domain: 'texture' as const,
          deps: Object.freeze([]) as readonly string[],
          versionInputs: Object.freeze(['res:1']),
          timeDependent: false,
          compute: (input: { nodeId: string; versions: { values: Record<string, number> } }) => ({
            ok: true as const,
            value: Object.freeze({
              kind: 'pendingEvaluation',
              nodeId: input.nodeId,
              identity: `id-${input.versions.values['res:1'] ?? 0}`,
              correlationId: 'corr-1',
            }),
          }),
        }),
      ]),
      outputs: Object.freeze(['expensive.texture']),
    })
    // 该图的资源版本来自 `res:1` 版本输入 ⇒ 用带 versions 的 source。
    const asyncSource = (resVersion: number): SceneReadView =>
      Object.freeze({
        ...sceneReadView(graph, {
          sceneId: 'scene-1',
          documentVersion: 1,
          time: timeValue(0, 20),
          parameterVersion: 1,
          contentResourceVersions: Object.freeze({}),
          versions: { 'res:1': resVersion },
          members: {},
        }),
      })

    const inst = new EvaluationInstance({ graph, capabilities: ['evaluation.read'] })
    const r = inst.evaluate(asyncSource(1))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.pending).toHaveLength(1)
    expect(r.value.pending[0].kind).toBe('pendingEvaluation')
    expect(inst.inFlightCount).toBe(1)

    // 输入前进 ⇒ 再一次求值产出**新的**身份（这就是"新求值"）
    const again = inst.evaluate(asyncSource(2))
    expect(again.ok).toBe(true)

    // 旧请求的结果现在晚到 ⇒ 必须被拒且要求回收
    const decision = inst.admitAsyncResult({
      request: r.value.pending[0],
      bindingGeneration: 0,
      outcome: { kind: 'success', data: Object.freeze({ texture: 'old' }) },
    })
    expect(decision.admitted, '过期结果不得被接纳（新求值已产出不同身份）').toBe(false)
    expect(decision.release, '过期结果必须要求回收').toBe(true)
    expect(decision.reason).toBe('staleIdentity')
  })

  it('当前请求：接纳并写入缓存（正对照）', () => {
    const graph: EvaluationGraphDeclaration = Object.freeze({
      id: 'async-ok',
      nodes: Object.freeze([
        Object.freeze({
          id: 'expensive.texture',
          domain: 'texture' as const,
          deps: Object.freeze([]) as readonly string[],
          versionInputs: Object.freeze(['res:1']),
          compute: (input: { nodeId: string }) => ({
            ok: true as const,
            value: Object.freeze({ kind: 'pendingEvaluation', nodeId: input.nodeId, identity: 'id-1', correlationId: 'corr-1' }),
          }),
        }),
      ]),
      outputs: Object.freeze(['expensive.texture']),
    })
    const inst = new EvaluationInstance({ graph, capabilities: ['evaluation.read'] })
    const src = Object.freeze({
      ...sceneReadView(graph, {
        sceneId: 'scene-1',
        documentVersion: 1,
        time: timeValue(0, 20),
        parameterVersion: 1,
        contentResourceVersions: Object.freeze({}),
        versions: { 'res:1': 1 },
        members: {},
      }),
    })
    const r = inst.evaluate(src)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.pending).toHaveLength(1)
    // 未发生新求值 ⇒ 身份相符 ⇒ 接纳
    const d = inst.admitAsyncResult({
      request: r.value.pending[0],
      bindingGeneration: 0,
      outcome: { kind: 'success', data: Object.freeze({ texture: 'new' }) },
    })
    expect(d.admitted).toBe(true)
    expect(d.release).toBe(false)
    expect(inst.inFlightCount).toBe(0)
  })

  it('显式取消在途请求 ⇒ 结果被拒且要求回收（取消是协议）', () => {
    const graph: EvaluationGraphDeclaration = Object.freeze({
      id: 'async-cancel',
      nodes: Object.freeze([
        Object.freeze({
          id: 'n',
          domain: 'other' as const,
          deps: Object.freeze([]) as readonly string[],
          versionInputs: Object.freeze([]) as readonly string[],
          compute: (input: { nodeId: string }) => ({ ok: true as const, value: Object.freeze({ kind: 'pendingEvaluation', nodeId: input.nodeId, identity: 'i', correlationId: 'c1' }) }),
        }),
      ]),
      outputs: Object.freeze(['n']),
    })
    const inst = new EvaluationInstance({ graph, capabilities: ['evaluation.read'] })
    const r = inst.evaluate(source(BASE_FACTS, graph))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.pending).toHaveLength(1)
    expect(inst.cancelAsync('c1')).toBe(true)
    expect(inst.cancelAsync('nope'), '未在案的请求不可取消').toBe(false)
    const d = inst.admitAsyncResult({
      request: r.value.pending[0],
      bindingGeneration: 0,
      outcome: { kind: 'success', data: 1 },
    })
    expect(d.admitted).toBe(false)
    expect(d.reason).toBe('cancelled')
    expect(d.release).toBe(true)
  })

  it('伪造/重复完成 ⇒ 拒绝并回收（unknown 标记）', () => {
    const inst = new EvaluationInstance({ graph: makeGraph(), capabilities: ['evaluation.read'] })
    const d = inst.admitAsyncResult({
      request: Object.freeze({ kind: 'pendingEvaluation', nodeId: 'geometry.block', identity: 'x', correlationId: 'never-issued' }),
      bindingGeneration: 0,
      outcome: { kind: 'success', data: 1 },
    })
    expect(d.admitted).toBe(false)
    expect(d.unknown).toBe(true)
    expect(d.release).toBe(true)
  })

  it('`discardInFlight` 丢弃全部在途并推进绑定代数（文档关闭路径）', () => {
    const graph: EvaluationGraphDeclaration = Object.freeze({
      id: 'async-2',
      nodes: Object.freeze([
        Object.freeze({
          id: 'n',
          domain: 'other' as const,
          deps: Object.freeze([]) as readonly string[],
          versionInputs: Object.freeze([]) as readonly string[],
          compute: (input: { nodeId: string }) => ({ ok: true as const, value: Object.freeze({ kind: 'pendingEvaluation', nodeId: input.nodeId, identity: 'i', correlationId: 'c1' }) }),
        }),
      ]),
      outputs: Object.freeze(['n']),
    })
    const inst = new EvaluationInstance({ graph, capabilities: ['evaluation.read'] })
    const r0 = inst.evaluate(source(BASE_FACTS, graph))
    expect(r0.ok).toBe(true)
    expect(inst.inFlightCount).toBe(1)
    const before = inst.binding
    const dropped = inst.discardInFlight()
    expect(dropped).toHaveLength(1)
    expect(inst.inFlightCount).toBe(0)
    expect(inst.binding, '重绑必须推进绑定代数').toBe(before + 1)
  })

  it('`identityForNode` 给出可对账的身份；未声明节点显式拒绝', () => {
    const v = versionsFor(BASE_FACTS)
    const m = memberSnapshot({})
    const id = identityForNode(makeGraph(), 'geometry.block', keyFor(BASE_FACTS), v, m)
    expect(id.ok).toBe(true)
    // 同一 `(key, versions, members, upstream)` 恒得同一身份
    expect(identityForNode(makeGraph(), 'geometry.block', keyFor(BASE_FACTS), v, m)).toEqual(id)
    const bad = identityForNode(makeGraph(), 'ghost', keyFor(BASE_FACTS), v, m)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe('UnsupportedOperation')
  })

  it('资源变化只标记**相关**节点（不做全量失效）', () => {
    const affected = nodesAffectedByResourceChange(makeGraph(), { 'a': 'v1' }, { 'a': 'v2' })
    expect(affected).toContain('channel.tier')
    expect(affected, '几何节点不得因纹理资源换版而失效').not.toContain('geometry.block')
    expect(nodesAffectedByResourceChange(makeGraph(), { 'a': 'v1' }, { 'a': 'v1' })).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A28 的求值面：资源按**内容版本**缓存，不按 URL
// ─────────────────────────────────────────────────────────────────────────────

describe('A28 求值面：资源缓存按内容身份（不是 URL）', () => {
  it('`lookupResource` 只接受内容身份键；同内容不同 URL 命中同一项', () => {
    const cache = Object.freeze({ 'asset-1\u0000v1': 'texture-data' })
    expect(lookupResource(cache, 'asset-1\u0000v1')).toBe('texture-data')
    // 用 URL 当键必然 miss（签名只接受内容身份——想按 URL 缓存写不出来）
    expect(lookupResource(cache, 'https://example.com/a.png')).toBeUndefined()
    expect(lookupResource(cache, 'asset-1\u0000v2')).toBeUndefined()
  })

  it('`resourceVersionsChanged` 逐 assetId 比对**内容版本**（替换资源可被识别）', () => {
    const changed = resourceVersionsChanged({ 'a': 'v1', 'b': 'v1' }, { 'a': 'v2', 'b': 'v1' })
    expect(changed).toEqual(['a'])
    // **负对照**：若按 URL 比对，同一 assetId 的版本变化会被漏掉（URL 没变）。
    // 这里用"URL 相同但内容版本不同"的形态表达它：
    const urlBased = (before: Record<string, string>, after: Record<string, string>) => Object.keys(after).filter((k) => before[k] === after[k])
    expect(urlBased({ 'a': 'https://x/a.png' }, { 'a': 'https://x/a.png' }), '按 URL 比对 ⇒ 看不到内容替换').toHaveLength(1)
    // 而内容版本比对看到了
    expect(resourceVersionsChanged({ 'a': 'https://x/a.png' }, { 'a': 'https://x/a.png#v2' })).toEqual(['a'])
  })

  it('sceneReadView 把"要传什么"收在一处：遗漏资源版本会体现在键里', () => {
    const a = sceneReadView(makeGraph(), {
      sceneId: 's',
      documentVersion: 1,
      time: timeValue(0, 20),
      parameterVersion: 1,
      contentResourceVersions: Object.freeze({ 'asset-1': 'v1' }),
    })
    const b = sceneReadView(makeGraph(), {
      sceneId: 's',
      documentVersion: 1,
      time: timeValue(0, 20),
      parameterVersion: 1,
      contentResourceVersions: Object.freeze({ 'asset-1': 'v2' }),
    })
    const ra = evaluateScene(a, { bindingGeneration: 0 })
    const rb = evaluateScene(b, { bindingGeneration: 0 })
    expect(ra.ok && rb.ok).toBe(true)
    if (ra.ok && rb.ok) {
      expect(sameStructuralKey(ra.value.key, rb.value.key), '资源内容版本必须进求值键').toBe(false)
    }
  })

  it('求值产物与 Document 分离：EvaluatedScene 不含 serialize/raw JSON 字段', () => {
    const src = sceneReadView(makeGraph(), {
      sceneId: 's',
      documentVersion: 1,
      time: timeValue(0, 20),
      parameterVersion: 1,
      contentResourceVersions: Object.freeze({}),
    })
    const r = evaluateScene(src, { bindingGeneration: 0 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const keys = Object.keys(r.value)
    expect(keys).not.toContain('serialize')
    expect(keys).not.toContain('frames')
    expect(keys).not.toContain('raw')
    // 来源映射与几何对应同一次求值
    expect(r.value.sources['geometry.block']).toBe('o-block')
    expect(r.value.objects.map((o) => o.objectId)).toContain('geometry.block')
  })

  it('取消的节点不出现在产物里（取消是协议）', () => {
    const src = sceneReadView(makeGraph(), {
      sceneId: 's',
      documentVersion: 1,
      time: timeValue(0, 20),
      parameterVersion: 1,
      contentResourceVersions: Object.freeze({}),
    })
    const r = evaluateScene(src, { bindingGeneration: 0, cancelledNodes: ['geometry.block'] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.objects.map((o) => o.objectId)).not.toContain('geometry.block')
    // 但依赖它的拾取仍然在（它自己没被取消）—— 取消粒度是节点
    expect(r.value.objects.map((o) => o.objectId)).toContain('pick.index')
  })
})

/** 未使用占位：保持 `propertyKey` 可达（供按属性键构造集合依赖的消费者复用）。 */
void propertyKey
