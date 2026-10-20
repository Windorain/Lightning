/**
 * R3-2 —— **资源清单随产物同行**（`export-asset-manifest-unwired`）的判据。
 *
 * ## 三条交付轴各测什么
 *
 * | 轴 | 判据 | 负对照 |
 * |---|---|---|
 * | ① 需求反推真实可算（不伪造） | 未装配 ⇒ 空清单**带原因**；已装配 ⇒ 由 `compileScene` 产出非空清单 | 已装配却推不出 ⇒ 请求**不可构造**（不落成空清单请求） |
 * | ② 清单随产物同行 | 单文件字节**逐字节不变**、多文件走包内条目、JSON 走附加字段 | 处理不了的 ZIP 形态 ⇒ 结构化失败 + 如实回落（不静默降级） |
 * | ③ 判据（喂生产值 + 负对照） | 产物内规范串摘要 == `assetManifestDigest` | **删一条 required** ⇒ 摘要改变 **且** 预检返回 `ExportAssetNotReady` |
 *
 * ## 为什么③的负对照不能只断言"摘要变了"
 *
 * 摘要只是**对账**手段：删一条必然改变摘要（这条恒真、无区分力）。真正要证的是
 * 「**少一条必需资源没能混过去**」—— 即预检对权威清单判 `ExportAssetNotReady`，
 * 同时产物内那份"少了货"的清单与权威摘要**不一致**（机械对账当场发现）。
 * 两条一起成立才算判据有区分力。
 *
 * ## 载体口径（与 `application/exportAssetCarrier` 的三形态一致）
 *
 * `image/png` ⇒ sidecar（字节不变）；`application/json` ⇒ embedded-field；
 * `application/zip` ⇒ in-package-entry。生产装配侧的对应证据在
 * `e2e/export-asset-manifest.spec.ts`（真实浏览器作业 + Playwright 下载事件）。
 */

import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import {
  ASSET_NEEDS_NOT_ASSEMBLED,
  assetManifestCanonicalText,
  assetManifestDigest,
  deriveAssetNeeds,
  exportAssetManifest,
  planExportRequest,
  preflightExport,
  type EncoderPort,
} from '@/application/exportPlan'
import {
  EXPORT_ASSET_MANIFEST_ENTRY,
  appendStoredZipEntry,
  crc32,
  manifestJsonText,
  packageExportArtifact,
} from '@/application/exportAssetCarrier'
import { EMPTY_ANIMATION } from '@/domain/animation'
import type { CameraSpec, CaptureSpec, ExportAssetNeed as Need } from '@/domain/captureSpec'
import { addBlockObject, createDocument, withScene } from '@/domain/document'
import { ok } from '@/domain/errors'
import type { PresentationInputs } from '@/presentation/evaluationKey'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具（走生产文档构造器，不手搓 Scene 形状）
// ─────────────────────────────────────────────────────────────────────────────

function sceneWithBlocks(n: number) {
  let doc = createDocument('doc-1')
  for (let i = 0; i < n; i++) {
    const s = addBlockObject(doc.scene, { objectId: `o${i}`, dataId: `d${i}` })
    if (!s) throw new Error('fixture: addBlockObject failed')
    doc = withScene(doc, s).doc
  }
  return doc.scene
}

const VIEW: CameraSpec = {
  projection: 'perspective',
  position: { x: 3, y: 4, z: 5 },
  target: { x: 0, y: 0, z: 0 },
  up: { x: 0, y: 1, z: 0 },
  fovDegrees: 50,
  near: 0.1,
  far: 1000,
}

const SPEC: CaptureSpec = {
  frameRate: 20,
  frameCount: 1,
  mapping: { source: 'scene', startFrame: 0, stepFrames: 1 },
  channels: {},
  camera: { kind: 'view', view: VIEW, label: 'r3-2' },
  render: { width: 32, height: 32, background: 'transparent' },
  animation: EMPTY_ANIMATION,
}

/** 已装配的图元清单：`scene` 键非空但**零图元**（编译会成功、批次为空）。 */
const ASSEMBLED_EMPTY: PresentationInputs = {
  key: { documentVersion: 1, scene: 'doc-1', time: { seconds: 0, numerator: 0, denominator: 1 }, parameterVersion: 0, contentResourceVersions: {} },
  geometry: { versionOf: () => undefined, attributesOf: () => undefined },
  primitives: [],
}

/** `scene` 键为空 ⇒ `compileScene` 必然失败（装配坏掉的形态）。 */
const ASSEMBLED_BROKEN: PresentationInputs = {
  ...ASSEMBLED_EMPTY,
  key: { ...ASSEMBLED_EMPTY.key, scene: '' },
}

const ENCODER: EncoderPort = {
  supportedKinds: ['image', 'geometry', 'project'],
  encode: async () => ok(new Uint8Array([1])),
}

const NEEDS: readonly Need[] = Object.freeze([
  Object.freeze({ assetId: 'tex/a', contentVersion: 'v1', required: true, locator: '' }),
  Object.freeze({ assetId: 'tex/b', contentVersion: 'v1', required: false, locator: '' }),
])

// ─────────────────────────────────────────────────────────────────────────────
// ① 需求反推真实可算（不伪造）
// ─────────────────────────────────────────────────────────────────────────────

describe('① `deriveAssetNeeds`：未装配**显式报告**，绝不冒充"无需资源"', () => {
  it('未给装配清单 ⇒ `not-assembled` + 原因 + 空清单（两义性在类型上不可表达）', () => {
    const d = deriveAssetNeeds({ scene: sceneWithBlocks(2), animation: EMPTY_ANIMATION, frames: [], spec: SPEC })
    expect(d.status).toBe('not-assembled')
    expect(d.assembled).toBe(false)
    expect(d.reason).toBe(ASSET_NEEDS_NOT_ASSEMBLED)
    expect(d.assets).toEqual([])
  })

  it('装配坏掉（`compileScene` 失败）⇒ `compile-failed` + 原因，不得回落成"空清单"', () => {
    const d = deriveAssetNeeds({
      scene: sceneWithBlocks(2),
      animation: EMPTY_ANIMATION,
      frames: [],
      spec: SPEC,
      presentation: ASSEMBLED_BROKEN,
    })
    expect(d.status).toBe('compile-failed')
    expect(d.assembled).toBe(true)
    expect(d.reason).toContain('compile-failed')
    expect(d.assets).toEqual([])
  })

  it('已装配、编译成功但**零批次** ⇒ 报 `compiled-no-payloads`（不是"不需要资源"）', () => {
    const d = deriveAssetNeeds({
      scene: sceneWithBlocks(2),
      animation: EMPTY_ANIMATION,
      frames: [],
      spec: SPEC,
      presentation: ASSEMBLED_EMPTY,
    })
    expect(d.status).toBe('compile-failed')
    expect(d.reason).toBe('compiled-no-payloads')
    expect(d.assets).toEqual([])
  })

  it('负对照：给了装配清单却推不出 ⇒ **请求不可构造**（不落成"清单为空"的请求）', () => {
    const r = planExportRequest({
      requestId: 'r3-2-neg',
      now: 0,
      documentId: 'doc-1',
      version: { documentVersion: 1, contentVersion: 1 },
      scene: sceneWithBlocks(2),
      animation: EMPTY_ANIMATION,
      camera: SPEC.camera,
      spec: SPEC,
      presentation: ASSEMBLED_EMPTY,
    })
    expect(r.ok, '推不出资源需求时**不得**产出一份 assets 为空的请求（那就是假绿入口）').toBe(false)
    if (!r.ok) expect(r.error.params.reason).toBe('compiled-no-payloads')
  })

  it('未给装配清单且未给显式清单 ⇒ 保持既有口径（空清单，且**不**抛错）', () => {
    const r = planExportRequest({
      requestId: 'r3-2-legacy',
      now: 0,
      documentId: 'doc-1',
      version: { documentVersion: 1, contentVersion: 1 },
      scene: sceneWithBlocks(2),
      animation: EMPTY_ANIMATION,
      camera: SPEC.camera,
      spec: SPEC,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.assets).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ② 清单随产物同行
// ─────────────────────────────────────────────────────────────────────────────

const MANIFEST = exportAssetManifest(NEEDS, { status: 'derived', assembled: true, reason: null, assets: NEEDS })

describe('② 清单随产物同行（单文件字节不变；多文件走包内条目）', () => {
  it('`image/png`（单文件）⇒ sidecar：产物字节**逐字节不变**（同一引用）', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
    const p = packageExportArtifact({ mediaType: 'image/png', bytes: png, manifest: MANIFEST })
    expect(p.carrier).toBe('sidecar')
    expect(p.bytes).toBe(png)
    expect(p.manifestLocation).toBe('asset-manifest.json')
    expect(p.canonical).toBe(assetManifestCanonicalText(NEEDS))
    expect(p.digest).toBe(assetManifestDigest(NEEDS))
  })

  it('`application/json`（自有格式）⇒ embedded-field，字段可机械读取且与清单本体一致', () => {
    const json = new TextEncoder().encode('{"documentId":"doc-1"}\n')
    const p = packageExportArtifact({ mediaType: 'application/json', bytes: json, manifest: MANIFEST })
    expect(p.carrier).toBe('embedded-field')
    const parsed = JSON.parse(new TextDecoder().decode(p.bytes)) as { documentId: string; assetManifest: { canonical: string; digest: number } }
    expect(parsed.documentId, '附加字段不得挤掉原有字段').toBe('doc-1')
    expect(parsed.assetManifest.canonical).toBe(assetManifestCanonicalText(NEEDS))
    expect(parsed.assetManifest.digest).toBe(assetManifestDigest(NEEDS))
  })

  it('`application/zip`（多文件）⇒ 包内条目：**真能解出**，且原有条目逐字节保留', async () => {
    const zip = new JSZip()
    zip.file('mesh/part-a.obj', 'v 0 0 0\n')
    zip.file('mesh/part-b.obj', 'v 1 1 1\n')
    const base = await zip.generateAsync({ type: 'uint8array' })

    const p = packageExportArtifact({ mediaType: 'application/zip', bytes: base, manifest: MANIFEST })
    expect(p.carrier).toBe('in-package-entry')
    expect(p.fallbackReason).toBeNull()

    const back = await JSZip.loadAsync(p.bytes)
    expect(await back.file(EXPORT_ASSET_MANIFEST_ENTRY)!.async('string')).toBe(manifestJsonText(MANIFEST))
    expect(await back.file('mesh/part-a.obj')!.async('string'), '原条目必须逐字节保留').toBe('v 0 0 0\n')
    expect(await back.file('mesh/part-b.obj')!.async('string')).toBe('v 1 1 1\n')
    expect(Object.keys(back.files).filter((k) => !k.endsWith('/')).length, '原两条 + 清单一条 = 三条**文件**条目').toBe(3)
  })

  it('确定性：同输入两次调用产物字节**逐位相同**（可对账的前提）', async () => {
    const zip = new JSZip()
    zip.file('mesh/part-a.obj', 'v 0 0 0\n')
    const base = await zip.generateAsync({ type: 'uint8array' })
    const a = packageExportArtifact({ mediaType: 'application/zip', bytes: base, manifest: MANIFEST })
    const b = packageExportArtifact({ mediaType: 'application/zip', bytes: base, manifest: MANIFEST })
    expect([...a.bytes]).toEqual([...b.bytes])
  })

  it('负对照：处理不了的 ZIP 形态 ⇒ **结构化失败**并如实回落（不假装进包了）', () => {
    expect(appendStoredZipEntry(new Uint8Array([1, 2, 3]), 'a', new Uint8Array([1]))).toEqual({
      ok: false,
      reason: 'zipEocdNotFound',
    })
    const p = packageExportArtifact({ mediaType: 'application/zip', bytes: new Uint8Array([1, 2, 3]), manifest: MANIFEST })
    expect(p.carrier).toBe('sidecar')
    expect(p.fallbackReason).toBe('in-package-entry:zipEocdNotFound')
  })

  it('CRC-32 与标准检定向量一致（载体的正确性不靠自证）', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('`exportAssetManifest`：未拿到推导记录 ⇒ `assembled:false` + 原因（不看"清单空不空"猜）', () => {
    const m = exportAssetManifest(NEEDS)
    expect(m.assembled).toBe(false)
    expect(m.reason).toBe('asset-needs-derivation-absent')
    expect(m.entries.length).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ③ 判据（喂生产值 + 负对照）
// ─────────────────────────────────────────────────────────────────────────────

describe('③ 判据：摘要对账 + 负对照（删一条 required）', () => {
  function requestOf(assets: readonly Need[]) {
    const r = planExportRequest({
      requestId: 'r3-2',
      now: 0,
      documentId: 'doc-1',
      version: { documentVersion: 1, contentVersion: 1 },
      scene: sceneWithBlocks(2),
      animation: EMPTY_ANIMATION,
      camera: SPEC.camera,
      spec: SPEC,
      assets,
    })
    if (!r.ok) throw new Error(`fixture: planExportRequest failed (${r.error.code})`)
    return r.value
  }

  it('正对照：产物内规范串摘要 == `assetManifestDigest(assets)`（喂生产请求里的清单）', () => {
    const request = requestOf(NEEDS)
    const manifest = exportAssetManifest(request.assets, { status: 'derived', assembled: true, reason: null, assets: request.assets })
    const p = packageExportArtifact({ mediaType: 'application/json', bytes: new TextEncoder().encode('{}\n'), manifest })
    const inArtifact = JSON.parse(new TextDecoder().decode(p.bytes)) as { assetManifest: { canonical: string } }
    expect(assetManifestDigest(request.assets)).toBe(manifest.digest)
    expect(inArtifact.assetManifest.canonical).toBe(assetManifestCanonicalText(request.assets))
  })

  it('**负对照**：删一条 `required` ⇒ 摘要改变 **且** 预检返回 `ExportAssetNotReady`', () => {
    const request = requestOf(NEEDS)
    const reduced = request.assets.filter((a) => a.assetId !== 'tex/a')

    // (a) 对账当场发现差异
    expect(assetManifestDigest(reduced), '少一条必需资源必须改变摘要').not.toBe(assetManifestDigest(request.assets))

    // (b) 且"少一条"不可能混过预检：无资源状态面 ⇒ 逐条 `ExportAssetNotReady`
    const pre = preflightExport({ request, kind: 'image', encoding: 'png', encoder: ENCODER })
    expect(pre.status).toBe('blocked')
    const codes = pre.diagnostics.map((d) => d.code)
    expect(codes).toContain('ExportAssetNotReady')
    expect(pre.diagnostics.filter((d) => d.code === 'ExportAssetNotReady').map((d) => d.detail.assetId)).toEqual(['tex/a'])
  })

  it('负对照的**方向性**：删掉的是 `optional` ⇒ 摘要仍改变，但预检**不**因此阻塞（可选缺失只降级）', () => {
    const request = requestOf(NEEDS)
    const withoutOptional = request.assets.filter((a) => a.assetId !== 'tex/b')
    expect(assetManifestDigest(withoutOptional)).not.toBe(assetManifestDigest(request.assets))
    const pre = preflightExport({ request, kind: 'image', encoding: 'png', encoder: ENCODER })
    expect(pre.diagnostics.filter((d) => d.code === 'ExportAssetNotReady').map((d) => d.detail.assetId)).not.toContain('tex/b')
  })
})
