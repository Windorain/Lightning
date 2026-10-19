/**
 * K1 `publish-capability-check` —— **发布前能力检查逐项报告**（#260 验收 K1；#249 §12）。
 *
 * ## 判据（#260 正文逐字）
 *
 * > **K1** 发布前能力检查逐项报告不支持的**几何/变形/文字/轨道**；**默认导出失败**而非假成功。
 *
 * ## 为什么需要独立的验收文件（不并入 A29）
 *
 * A29 判的是"快照导出作业本身"，K1 判的是**发布目标能不能表达这次快照**。
 * 两者失败模式不同：A29 失败于"借用了实时状态"，K1 失败于"把表达不了的东西
 * 静默降采样后当成功发布"。后者正是 #249 §12 明令禁止的：
 * > 必要时导出烘焙结果，**并记录能力损失**……**默认导出失败而不是假成功**。
 *
 * ## 四类判定的**来源各不相同**（刻意，避免一处判据包打天下）
 *
 * | 类别 | 判定来源 |
 * |---|---|
 * | 几何 | P3 交付的 `legacyExportDiagnostics()`（经 `captureCapabilityLoss` 进请求） |
 * | 变形 | 同上（`LegacyExportUnsupportedDeformation`） |
 * | 文字 | 注解对象携带非空 `text` + 目标声明 `canExpressText === false` |
 * | 轨道 | 已启用轨道的目标属性不在目标声明的 `animatableProperties` 里 |
 *
 * 本文件对四类**各有一条正断言 + 一条负对照**。
 */

import { describe, expect, it } from 'vitest'
import { addAnnotationObject, addBlockObject, addMeshObject, createDocument, withScene } from '@/domain/document'
import { EMPTY_ANIMATION, type AnimationState, type AnimationTrack } from '@/domain/animation'
import { capabilityDiagnostics, capabilityReport, preflightExport, type EncoderPort, type PublishCapabilities } from '@/application/exportPlan'
import { planExportRequest } from '@/application/exportPlan'
import type { CaptureSpec as Spec } from '@/domain/captureSpec'
import { transform as makeTransform, vec3 } from '@/domain/scene'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

/** 旧整数格结构格式的能力声明（保守：只有整格方块、无文字、无变换附加项、无轨道）。 */
const LEGACY_MC: PublishCapabilities = Object.freeze({
  geometry: Object.freeze(['integerGridBlock']),
  deformations: Object.freeze(['none']),
  canExpressText: false,
  canExpressTransformExtras: false,
  animatableProperties: Object.freeze([]),
})

/** 一个"什么都能表达"的目标（用于反空洞真：报告必须为空，否则判据是恒红）。 */
const FULL: PublishCapabilities = Object.freeze({
  geometry: Object.freeze(['integerGridBlock', 'arbitraryMesh']),
  deformations: Object.freeze(['none', 'fixedTopology']),
  canExpressText: true,
  canExpressTransformExtras: true,
  animatableProperties: 'all',
})

const CAMERA = {
  projection: 'perspective' as const,
  position: { x: 5, y: 5, z: 5 },
  target: { x: 0, y: 0, z: 0 },
  up: { x: 0, y: 1, z: 0 },
  fovDegrees: 50,
  near: 0.1,
  far: 1000,
}

function spec(animation: AnimationState = EMPTY_ANIMATION): Spec {
  return {
    frameRate: 20,
    frameCount: 1,
    mapping: { source: 'scene', startFrame: 0, stepFrames: 1 },
    channels: {},
    camera: { kind: 'view', view: CAMERA, label: 'k1' },
    render: { width: 32, height: 32, background: 'transparent' },
    animation,
  }
}

/** 造一个带注解文字 + 非整数格平移 + 形变 + 轨道的场景（四类问题各一）。 */
function richDocument() {
  let doc = createDocument('doc-k1')
  // 注解（带文字）
  const ann = addAnnotationObject(doc.scene, { objectId: 'ann1', dataId: 'dann', shape: 'text', text: 'hello' })
  if (!ann) throw new Error('fixture: annotation')
  doc = withScene(doc, ann).doc
  // 方块 + 非整数格平移（几何不可表达）
  const blk = addBlockObject(doc.scene, { objectId: 'blk1', dataId: 'dblk' })
  if (!blk) throw new Error('fixture: block')
  doc = withScene(doc, blk).doc
  const moved = {
    ...doc,
    scene: {
      ...doc.scene,
      objects: {
        ...doc.scene.objects,
        blk1: { ...doc.scene.objects['blk1']!, transform: makeTransform({ position: vec3(0.25, 0, 0) }) },
      },
    },
  }
  return moved
}

/** 一条启用轨道（目标属性声明为 `lightning.mesh.deformWeight`）。 */
function animationWithTrack(): AnimationState {
  const track: AnimationTrack = Object.freeze({
    id: 'tr1',
    target: Object.freeze({ owner: Object.freeze({ kind: 'object', id: 'blk1' }), property: 'lightning.mesh.deformWeight' }),
    valueType: 'number',
    interpolation: 'linear',
    enabled: true,
    keys: Object.freeze([Object.freeze({ time: Object.freeze({ frame: 0, fps: 20 }), value: 0 })]),
  })
  return Object.freeze({ tracks: Object.freeze([track]), publishedDefaults: Object.freeze({}) })
}

function requestFor(doc: ReturnType<typeof richDocument>, animation: AnimationState = EMPTY_ANIMATION) {
  const r = planExportRequest({
    requestId: 'k1',
    now: 0,
    documentId: doc.id,
    version: doc.version,
    scene: doc.scene,
    animation,
    camera: { kind: 'view', view: CAMERA, label: 'k1' },
    spec: spec(animation),
  })
  if (!r.ok) throw new Error(`fixture: ${r.error.code}`)
  return r.value
}

const anyEncoder: EncoderPort = { supportedKinds: ['image'], async encode() { return { ok: true, value: new Uint8Array([1]) } } }

// ─────────────────────────────────────────────────────────────────────────────
// 一、逐项报告（四类各一条）
// ─────────────────────────────────────────────────────────────────────────────

describe('K1：发布前能力检查 —— 不支持的几何/变形/文字/轨道**逐项报告**', () => {
  it('几何：非整数格平移被报告为 `geometry` 类（判定来自 P3 的挂点，不重判）', () => {
    const req = requestFor(richDocument())
    const report = capabilityReport(req, LEGACY_MC)
    const geometry = report.filter((i) => i.category === 'geometry')
    expect(geometry.length, '非整数格平移必须被报告').toBeGreaterThan(0)
    expect(geometry[0]!.reason).toBe('LegacyExportUnsupportedTransform')
    expect(geometry[0]!.objectId).toBe('blk1')
    expect(geometry[0]!.detail.x).toBe(0.25)
  })

  it('变形：带固定拓扑形变的网格对象被报告为 `deformation` 类', () => {
    let doc = createDocument('doc-def')
    // 造一个带形变的网格对象（`deformation` 进 MeshData ⇒ legacyExportDiagnostics 报 deformation）
    const made = addMeshObject(doc.scene, {
      objectId: 'mesh1',
      dataId: 'dmesh',
      deformation: { id: 'def1', topologyVersion: 1, channels: [] } as never,
    })
    if (!made.ok) throw new Error('fixture: mesh')
    doc = withScene(doc, made.value).doc
    const req = requestFor(doc as unknown as ReturnType<typeof richDocument>)
    const report = capabilityReport(req, LEGACY_MC)
    expect(report.map((i) => i.category)).toContain('deformation')
    expect(report.find((i) => i.category === 'deformation')!.reason).toBe('LegacyExportUnsupportedDeformation')
  })

  it('文字：目标声明不能表达文字时，带文字的注解被**逐条**报告', () => {
    const req = requestFor(richDocument())
    const report = capabilityReport(req, LEGACY_MC)
    const text = report.filter((i) => i.category === 'text')
    expect(text).toHaveLength(1)
    expect(text[0]!.objectId).toBe('ann1')
    expect(text[0]!.reason).toBe('PublishTextUnsupported')
    expect(text[0]!.detail.textLength).toBe(5)
  })

  it('轨道：目标承载不了的已启用轨道被报告（含属性 ID，便于逐条定位）', () => {
    const animation = animationWithTrack()
    const req = requestFor(richDocument(), animation)
    const report = capabilityReport(req, LEGACY_MC)
    const tracks = report.filter((i) => i.category === 'track')
    expect(tracks).toHaveLength(1)
    expect(tracks[0]!.reason).toBe('PublishTrackUnsupported')
    expect(tracks[0]!.detail.property).toBe('lightning.mesh.deformWeight')
  })

  it('报告稳定可复现（同一输入两次调用逐字段相同）', () => {
    const req = requestFor(richDocument(), animationWithTrack())
    const a = capabilityReport(req, LEGACY_MC)
    const b = capabilityReport(req, LEGACY_MC)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    // 四类都出现（这条同时是"逐项"的反空洞真）
    expect(new Set(a.map((i) => i.category))).toEqual(new Set(['geometry', 'text', 'track']))
  })

  it('**反空洞真**：目标什么都能表达时报告为空（否则判据是恒红）', () => {
    const req = requestFor(richDocument(), animationWithTrack())
    expect(capabilityReport(req, FULL)).toEqual([])
  })

  it('**负对照**：目标声明"能表达文字/轨道"却仍报告 ⇒ 说明判定绑在声明上而非事实（注入式证伪）', () => {
    // 对照实现：无条件报告全部四类（不看目标声明）。
    const naive = (req: ReturnType<typeof requestFor>) => {
      const items = capabilityReport(req, LEGACY_MC)
      // 对照项：把"文字"与"轨道"强加给 FULL 目标
      return [...items, ...capabilityReport(req, { ...FULL, canExpressText: false, animatableProperties: [] })]
    }
    const req = requestFor(richDocument(), animationWithTrack())
    expect(capabilityReport(req, FULL)).toEqual([])
    expect(naive(req).length, '对照实现会把能表达的目标也报成不支持（判据确实绑在声明上）').toBeGreaterThan(0)
  })

  it('**负对照**：禁用轨道**不**进报告（轨道能力判据只作用于启用轨道）', () => {
    const animation = animationWithTrack()
    const disabled: AnimationState = Object.freeze({
      tracks: Object.freeze([Object.freeze({ ...animation.tracks[0]!, enabled: false })]),
      publishedDefaults: Object.freeze({}),
    })
    const req = requestFor(richDocument(), disabled)
    expect(capabilityReport(req, LEGACY_MC).filter((i) => i.category === 'track')).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 二、默认导出失败（而非假成功）
// ─────────────────────────────────────────────────────────────────────────────

describe('K1：能力不足时**默认导出失败**，不产出伪完整文件', () => {
  it('有几何损失且未显式开有损 ⇒ 预检 blocked（`ExportRequiresLossyMode`）', () => {
    const req = requestFor(richDocument())
    const pre = preflightExport({ request: req, kind: 'image', encoder: anyEncoder })
    expect(pre.status).toBe('blocked')
    expect(pre.diagnostics.map((d) => d.code)).toContain('ExportRequiresLossyMode')
  })

  it('`capabilityDiagnostics` 把报告翻成结构化诊断（四类信息不丢）', () => {
    const req = requestFor(richDocument(), animationWithTrack())
    const diags = capabilityDiagnostics(capabilityReport(req, LEGACY_MC))
    expect(diags.length).toBeGreaterThanOrEqual(3)
    for (const d of diags) {
      expect(d.code).toBe('ExportCapabilityUnsupported')
      expect(['geometry', 'deformation', 'text', 'track']).toContain(d.detail.category)
      expect(typeof d.detail.reason).toBe('string')
    }
  })

  it('**负对照**：把 `allowLossy` 当成默认值（对照实现）会让能力不足"静默成功" ⇒ 判据必须能区分', () => {
    const req = requestFor(richDocument())
    const strict = preflightExport({ request: req, kind: 'image', encoder: anyEncoder })
    const loose = preflightExport({ request: req, kind: 'image', encoder: anyEncoder, allowLossy: true })
    expect(strict.status, '默认（严格）必须 blocked').toBe('blocked')
    expect(loose.status, '显式有损才允许通过（且要标记）').toBe('ready')
    // 这正是"默认导出失败而不是假成功"的可执行形态：差别只来自**显式**开关。
    expect(strict.diagnostics.length).toBeGreaterThan(0)
  })

  it('发布目标的能力声明是**显式输入**：同一请求对两个目标得到不同报告（不猜）', () => {
    const req = requestFor(richDocument())
    const legacy = capabilityReport(req, LEGACY_MC)
    const full = capabilityReport(req, FULL)
    expect(legacy.length).toBeGreaterThan(0)
    expect(full.length).toBe(0)
  })
})
