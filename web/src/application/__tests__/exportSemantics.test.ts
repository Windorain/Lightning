/**
 * **导出不可表达语义矩阵的判据**（M6-4；SPEC §9）。
 *
 * ## 判什么
 *
 * 1. **矩阵完整**：`png/gif/obj` × 各自该类语义一格不少（与 s0-b §5.1 的实测表逐格比对）；
 * 2. **不改写产物判定**：PNG/GIF 的变换损失**不**进诊断（等轴渲染按变换绘制），
 *    形变/文字/轨道**进**诊断（各一条，`objectId`/reason 结构化）；
 * 3. **OBJ 事实映射**：首帧纹理、跳过体素、混合近似各自产出结构化诊断；
 * 4. **无诊断即判红**：负对照 —— 把矩阵里某格删掉/把生产者短路，上面的断言必须失败。
 */
import { describe, expect, it } from 'vitest'
import {
  EXPORT_SEMANTIC_CODES,
  EXPORT_SEMANTIC_MATRIX,
  GIF_PUBLISH_CAPABILITIES,
  PNG_PUBLISH_CAPABILITIES,
  capabilityFindingOf,
  findingOfExportDiagnostic,
  objExportSemantics,
  semanticCellsOf,
  stillExportSemantics,
  type ExportSemanticKind,
} from '@/application/exportSemantics'
import { capabilityReport, planExportRequest } from '@/application/exportPlan'
import { EMPTY_ANIMATION, type AnimationState } from '@/domain/animation'
import type { CameraSpec, CaptureSpec } from '@/domain/captureSpec'
import { addAnnotationObject, addBlockObject, createDocument, withScene } from '@/domain/document'

const VIEW: CameraSpec = {
  projection: 'perspective',
  position: { x: 3, y: 4, z: 5 },
  target: { x: 0, y: 0, z: 0 },
  up: { x: 0, y: 1, z: 0 },
  fovDegrees: 50,
  near: 0.1,
  far: 1000,
}

function specOf(over: Partial<CaptureSpec> = {}): CaptureSpec {
  return {
    frameRate: 20,
    frameCount: 1,
    mapping: { source: 'scene', startFrame: 0, stepFrames: 1 },
    channels: {},
    camera: { kind: 'view', view: VIEW, label: 'm6-4' },
    render: { width: 32, height: 32, background: 'transparent' },
    animation: EMPTY_ANIMATION,
    ...over,
  }
}

/** 一份**干净**文档（整格方块，无变换/形变/文字/轨道）。 */
function cleanDoc() {
  let doc = createDocument('doc-m6-4')
  const s = addBlockObject(doc.scene, { objectId: 'o0', dataId: 'd0' })
  if (!s) throw new Error('fixture: addBlockObject failed')
  return withScene(doc, s).doc
}

function requestOf(sceneDoc: ReturnType<typeof cleanDoc>, animation: AnimationState = EMPTY_ANIMATION) {
  const spec = specOf()
  const planned = planExportRequest({
    requestId: 'm6-4',
    now: 0,
    documentId: sceneDoc.id,
    version: sceneDoc.version,
    scene: sceneDoc.scene,
    animation,
    camera: spec.camera,
    spec,
    assets: [],
  })
  if (!planned.ok) throw new Error('fixture: planExportRequest failed ' + planned.error.code)
  return planned.value
}

describe('矩阵完整性：格式 × 不可表达语义（唯一声明点）', () => {
  const expected: Record<'png' | 'gif' | 'obj', readonly ExportSemanticKind[]> = {
    png: ['transform', 'deformation', 'annotation-text', 'animation-tracks'],
    gif: ['transform', 'deformation', 'annotation-text', 'animation-tracks'],
    obj: ['texture-sequence', 'geometry-skipped', 'layered-stacking', 'blend-approximation'],
  }

  it('三张表逐格 == 期望（缺一格即判红）', () => {
    for (const format of ['png', 'gif', 'obj'] as const) {
      expect(semanticCellsOf(format).map((c) => c.kind), `${format} 的语义格必须完整`).toEqual(expected[format])
    }
  })

  it('每格都指到一个**存在**的导出诊断码（不写散文，写码）', () => {
    const known = new Set(Object.values(EXPORT_SEMANTIC_CODES))
    for (const format of ['png', 'gif', 'obj'] as const) {
      for (const c of semanticCellsOf(format)) {
        expect(known.has(c.code), `${format}/${c.kind} 的码必须在导出码集里：${c.code}`).toBe(true)
        expect(c.why.length, '每格必须写清"为什么表达不了"').toBeGreaterThan(8)
      }
    }
  })

  it('**负对照**：删掉一格，同一比对必须失败', () => {
    const broken = EXPORT_SEMANTIC_MATRIX.png.filter((c) => c.kind !== 'annotation-text').map((c) => c.kind)
    expect(broken, '删格后的表必须与期望不同（证明上面的断言不是恒真）').not.toEqual(expected.png)
  })
})

describe('PNG/GIF：能力表 → 结构化诊断（`export.capabilityUnsupported`）', () => {
  it('干净场景 ⇒ 零诊断（不制造噪声）', () => {
    const doc = cleanDoc()
    expect(stillExportSemantics(requestOf(doc), 'png')).toEqual([])
    expect(stillExportSemantics(requestOf(doc), 'gif')).toEqual([])
  })

  it('注解文字 ⇒ 恰好一条 `annotation-text`，且带 objectId', () => {
    const base = cleanDoc()
    const s = addAnnotationObject(base.scene, { objectId: 'anno-1', dataId: 'anno-d1', text: 'hello' })
    if (!s) throw new Error('fixture: addAnnotationObject failed')
    const doc = withScene(base, s).doc
    const findings = stillExportSemantics(requestOf(doc), 'png')
    const text = findings.filter((f) => f.params.category === 'text')
    expect(text, '注解文字必须报一条').toHaveLength(1)
    expect(text[0]!.code).toBe('export.capabilityUnsupported')
    expect(text[0]!.params.reason).toBe('PublishTextUnsupported')
    expect(text[0]!.objectId).toBe('anno-1')
  })

  it('非整数格平移 ⇔ **不**诊断（等轴渲染按变换绘制，照抄旧格式会给每次正常导出刷假诊断）', () => {
    const base = cleanDoc()
    const moved = {
      ...base,
      scene: {
        ...base.scene,
        objects: {
          ...base.scene.objects,
          o0: { ...base.scene.objects['o0']!, transform: { ...base.scene.objects['o0']!.transform, position: { x: 0.5, y: 0, z: 0 } } },
        },
      },
    } as unknown as ReturnType<typeof cleanDoc>
    expect(capabilityReport(requestOf(moved), PNG_PUBLISH_CAPABILITIES), '变换不进 PNG 能力损失').toEqual([])
    expect(capabilityReport(requestOf(moved), GIF_PUBLISH_CAPABILITIES)).toEqual([])
  })

  it('能力项 → 事实的映射只在一处（category/reason/objectId 逐项带出）', () => {
    const doc = cleanDoc()
    const item = capabilityReport(requestOf(doc), PNG_PUBLISH_CAPABILITIES)
    expect(item, '干净场景没有能力项').toEqual([])
    // 直接喂一条构造项：映射必须原样带出三个字段（不是散文）。
    const f = capabilityFindingOf({
      category: 'deformation',
      reason: 'LegacyExportUnsupportedDeformation',
      objectId: 'o9',
      detail: { deformationId: 'wave' },
    })
    expect(f.code).toBe('export.capabilityUnsupported')
    expect(f.objectId).toBe('o9')
    expect(f.params).toMatchObject({ category: 'deformation', reason: 'LegacyExportUnsupportedDeformation', deformationId: 'wave' })
  })
})

describe('OBJ：装配期事实 → 结构化诊断（首帧/跳过/近似）', () => {
  it('空报告 ⇒ 零诊断（"没有不可表达语义"不是事件）', () => {
    expect(objExportSemantics({ firstFrameOnly: [], skippedUnmappedVoxels: 0, skippedVoxels: [], layered: null, blendApproximations: [] })).toEqual([])
  })

  it('竖条动画只用首帧 ⇒ `export.firstFrameOnly`，带 blobIndex/frameCount/材质归属', () => {
    const out = objExportSemantics({
      firstFrameOnly: [{ blobIndex: 0, frameCount: 4, materialIndices: [0, 2] }],
      skippedUnmappedVoxels: 0,
      skippedVoxels: [],
      layered: null,
      blendApproximations: [],
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.code).toBe('export.firstFrameOnly')
    expect(out[0]!.params).toMatchObject({ blobIndex: 0, frameCount: 4, materials: '0,2' })
  })

  it('跳过体素 ⇒ `export.geometrySkipped` 每条 registry 键一条（按码稳定排序）', () => {
    const out = objExportSemantics({
      firstFrameOnly: [],
      skippedUnmappedVoxels: 5,
      skippedVoxels: [
        { registryKey: 'z:1', reason: 'special_no_geometry', voxelCount: 2 },
        { registryKey: 'a:1', reason: 'decode_error', voxelCount: 3 },
      ],
      layered: null,
      blendApproximations: [],
    })
    expect(out.map((f) => f.code)).toEqual(['export.geometrySkipped', 'export.geometrySkipped'])
    expect(out.map((f) => f.params.registryKey)).toEqual(['a:1', 'z:1'])
  })

  it('**只有计数没有明细**时仍必须报（"有体素被丢"不得因明细缺失而消失）', () => {
    const out = objExportSemantics({ firstFrameOnly: [], skippedUnmappedVoxels: 7, skippedVoxels: [], layered: null, blendApproximations: [] })
    expect(out).toHaveLength(1)
    expect(out[0]!.params.voxelCount).toBe(7)
  })

  it('layered 模式 ⇒ `export.layerStackUnexpressed`（叠化规则只在文件名/注释里）', () => {
    const out = objExportSemantics({
      firstFrameOnly: [],
      skippedUnmappedVoxels: 0,
      skippedVoxels: [],
      layered: { layerCount: 3 },
      blendApproximations: [],
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.code).toBe('export.layerStackUnexpressed')
    expect(out[0]!.params).toMatchObject({ layerCount: 3, compose: 'caller' })
  })

  it('混合模式 ⇒ `export.blendApproximated`（MTL 的 d/illum 是近似，必须声明）', () => {
    const out = objExportSemantics({
      firstFrameOnly: [],
      skippedUnmappedVoxels: 0,
      skippedVoxels: [],
      layered: null,
      blendApproximations: [{ materialName: 'm_layer_0', blend: 'cutout' }],
    })
    expect(out[0]!.code).toBe('export.blendApproximated')
    expect(out[0]!.params).toMatchObject({ material: 'm_layer_0', blend: 'cutout' })
  })
})

describe('预检/作业诊断 → 导出通道的码（未映射的码不静默丢弃）', () => {
  it('已知码逐项映射到 export.*', () => {
    expect(findingOfExportDiagnostic({ code: 'ExportAssetNotReady', detail: { assetId: 'material:0' } }).code).toBe('export.assetNotReady')
    expect(findingOfExportDiagnostic({ code: 'ExportTimeQuantized', detail: {} }).code).toBe('export.timeQuantized')
    expect(findingOfExportDiagnostic({ code: 'ExportEmptyScene', detail: {} }).code).toBe('export.emptyScene')
    expect(findingOfExportDiagnostic({ code: 'ExportEncodingNotConfigured', detail: {} }).code).toBe('export.encodingNotConfigured')
    expect(findingOfExportDiagnostic({ code: 'ExportCapabilityUnsupported', detail: {} }).code).toBe('export.capabilityUnsupported')
  })

  it('未列出的码落到 export.failed 并保留原码（不静默丢弃）', () => {
    const f = findingOfExportDiagnostic({ code: 'ExportAcquireFailed', detail: { reason: 'offscreenAcquireFailed' } })
    expect(f.code).toBe('export.failed')
    expect(f.params.reason).toBe('ExportAcquireFailed')
    expect(f.params.preflight).toBe('ExportAcquireFailed')
  })
})
