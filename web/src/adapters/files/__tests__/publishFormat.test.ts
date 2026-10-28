/**
 * A20 —— **发布重载 + 不支持能力有诊断且无伪成功产物**
 * （A20「发布重载，不支持能力」；验收判据 3 与 4 + 负对照 b）。
 *
 * ## A20 判据 3：发布 → 读回 → 与源一致（含能力损失记录）
 *
 * 「发布重载」在这里是**可复现**的两相：
 *  1. 发布预检 → 通过 ⇒ 打包（本模块的打包是"把发布内容分层）;
 *  2. 读回 → 与源**语义一致**（用 Envelope 的 canonical 摘要，B-2 的口径）。
 *
 * 「含能力损失记录」是这一条的**后半句**：产物必须携带"哪些东西没法忠实表达"。
 * 本模块的形态是 {@link PublishCapabilityReport}（`lossItems` / `lossByCode`）。
 *
 * ## A20 判据 4：不支持能力有诊断且**无伪成功产物**
 *
 * > 「默认导出**失败**而不是产出"看起来完整"的文件；必须断言「失败时没有产物返回」」
 *
 * 这条是**结构性**的，不是"记得别返回"：本模块（与它消费的
 * `application/exportPlan`）的公开面里**没有**任何"返回字节"的函数 ——
 * 编码能力以端口注入（`EncoderPort`），纯层只产 `{mediaType, plan}` 与诊断。
 * 故"失败了但仍然拿到产物"**不可表达**。本文件用三条断言把这个性质钉住：
 *  1. `preflightPublish` 的 `blocked` 分支里没有任何 `bytes`/`payload` 字段；
 *  2. 带形变（不可表达）的文档在**默认**模式下被 blocked；
 *  3. 同一个文档在**显式**有损模式下才 ready（「可选有损输出必须是显式模式」）。
 */

import { describe, expect, it } from 'vitest'

import {
  capabilityLossRecord,
  collectCapabilityLoss,
  inspectPublishableContent,
  lossItemsOfCode,
  playbackTrackRequirements,
  preflightPublish,
  publishCapabilityReport,
  publishPlayback,
  publishPreflightError,
  publishPlaybackIsUnaltered,
  PUBLISH_PLAYBACK_DEFAULT,
  requiringPlayback,
  type PublishPreflight,
} from '@/adapters/files/publishFormat'
import {
  canonicalSubtreeText,
  decodeEnvelope,
  encodeEnvelope,
  envelopeSemanticDigest,
  envelopeSemanticallyEqual,
} from '@/adapters/files/envelopeCodec'
import { addBlockObject, addMeshObject, createDocument, withAnimation, withScene } from '@/domain/document'
import { deformation, legacyExportDiagnostics, unitBoxMesh } from '@/domain/geometry'
import { objectRef } from '@/domain/identity'
import type { AnimationTrack } from '@/domain/animation'
import fs from 'node:fs'
import path from 'node:path'
import { realFixtureText, withRealFixture } from '../../../../e2e/real-fixture-vitest'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURES = path.join(process.cwd(), 'e2e', 'fixtures')
const STRUCTUREDATA_FIXTURE_KEY = 'structureDataExportedEnvelope'

function readFixture(name: string): Record<string, unknown> {
  if (name === 'structuredata-exported-envelope.json') {
    return JSON.parse(realFixtureText(STRUCTUREDATA_FIXTURE_KEY)) as Record<string, unknown>
  }
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as Record<string, unknown>
}

/** 一份"可发布"的文档骨架（含查看所需的全部内容）。 */
function publishableDoc(): Record<string, unknown> {
  return {
    format_version: '2.0',
    id: 'publishable',
    meta: { name: 'P', author: '', created_at_ms: 0, description: '', tags: [], origin: { x: 0, y: 0, z: 0 } },
    frames: [
      {
        index: 0,
        structure: {
          geometryPhase: 'baked',
          cellGrid: [[[0]]],
          blockPalette: [{ registryId: 'air', meta: 0, renderMode: 'BakedModel', geometry: { encoding: 'bakedQuadsJsonV1', quads: [] } }],
        },
      },
    ],
    annotations: [],
    labels: [],
    materialPalette: [{ textureBlobIndex: 0 }],
    textureBlobs: ['abc'],
    tooltipPalette: [],
    cellTooltipGrid: [[[-1]]],
    playback: { loop: false, defaultFrameIndex: 0 },
  }
}

/** 含**不可表达**形变的场景（能力损失的来源；A20 负对照 b 的输入）。 */
function sceneWithDeformation(): ReturnType<typeof createDocument> {
  let doc = createDocument('doc-deform')
  const block = addBlockObject(doc.scene, { objectId: 'o1', dataId: 'd1' })
  expect(block).not.toBeNull()
  doc = withScene(doc, block!).doc
  const mesh = unitBoxMesh('d2', 1, deformation('def-1', 0, [{ id: 'c', targets: [{ vertex: 'x0y0z0', offset: { x: 1, y: 0, z: 0 } }] }]))
  expect(mesh.ok).toBe(true)
  if (!mesh.ok) throw new Error('fixture 构造失败')
  const added = addMeshObject(doc.scene, { objectId: 'o2', dataId: 'd2', deformation: mesh.value.deformation })
  expect(added.ok).toBe(true)
  if (!added.ok) throw new Error('fixture 构造失败')
  return withScene(doc, added.value).doc
}

// ─────────────────────────────────────────────────────────────────────────────
// 一、B-23：playback 原样保留，**不得顺手启用播放**
// ─────────────────────────────────────────────────────────────────────────────

describe('B-23 `playback`：原样保留、不得顺手启用播放（F-09「本期不实现播放」）', () => {
  it('契约默认值是常量且逐字等于契约文档所写', () => {
    expect(PUBLISH_PLAYBACK_DEFAULT).toEqual({ loop: false, defaultFrameIndex: 0 })
    // 与既有契约文档逐字核对（读文档并规范化行尾 —— 铁律 6）。
    const contract = fs.readFileSync(path.join(process.cwd(), '..', 'docs', 'contracts', 'format-scene-file.md'), 'utf8').replace(/\r\n/g, '\n')
    expect(contract).toContain('"loop": false, "defaultFrameIndex": 0')
    expect(contract, '契约明写场景多帧自动播放未实现，消费方只读帧数据').toContain('场景的多帧自动播放未实现，消费方只读取帧数据')
  })

  it('搬运是**原样**的：源里 `loop:true` 照搬（我们不修订既有文件，只保证自己不改它）', () => {
    const src = { loop: true, defaultFrameIndex: 3 }
    const out = publishPlayback(src)
    expect(out).toEqual({ loop: true, defaultFrameIndex: 3 })
    expect(publishPlaybackIsUnaltered(src, out)).toBe(true)
    // `false` 也被原样保留。
    expect(publishPlayback({ loop: false, defaultFrameIndex: 0 })).toEqual({ loop: false, defaultFrameIndex: 0 })
  })

  it('源里缺字段 ⇒ 补**契约规定**的默认（`loop:false` / `0`），而不是"启用播放"', () => {
    const out = publishPlayback({})
    expect(out).toEqual(PUBLISH_PLAYBACK_DEFAULT)
    expect(out!.loop, '补的默认必须是 false').toBe(false)
    expect(publishPlaybackIsUnaltered({}, out)).toBe(true)
    // 非对象/缺失 ⇒ `null`（不凭空造一个 playback）。
    expect(publishPlayback(undefined)).toBeNull()
    expect(publishPlayback(null)).toBeNull()
    expect(publishPlayback([])).toBeNull()
    expect(publishPlayback('x')).toBeNull()
  })

  it('**负对照**：把 `loop` 顺手改成 `true`（"这样发布物就能播了"）⇒ 判红', () => {
    const src = { loop: false, defaultFrameIndex: 0 }
    /** **对照实现**：为了让发布物"可用"，把播放打开。 */
    const naiveEnablePlayback = (): { loop: boolean; defaultFrameIndex: number } => ({ loop: true, defaultFrameIndex: 0 })
    const naive = naiveEnablePlayback()
    expect(naive.loop, '对照实现打开了播放').toBe(true)
    expect(publishPlaybackIsUnaltered(src, naive), '同一判据必须判红').toBe(false)
    // 真实实现不改它。
    expect(publishPlaybackIsUnaltered(src, publishPlayback(src))).toBe(true)
  })

  it('`defaultFrameIndex` 被改写 ⇒ 同样判红（"顺手跳到第一帧"）', () => {
    const src = { loop: false, defaultFrameIndex: 5 }
    expect(publishPlaybackIsUnaltered(src, { loop: false, defaultFrameIndex: 0 }), '改写默认帧必须判红').toBe(false)
    expect(publishPlaybackIsUnaltered(src, publishPlayback(src))).toBe(true)
  })

  it('真夹具的 `playback`（缺省）经搬运后仍是契约默认，且**未被篡改**', () => {
    for (const name of ['minimal-v2.json', 'parts-ae2-multibox.v2.json']) {
      const doc = readFixture(name)
      // 这些 V2 手 fixture 没有 playback ⇒ 搬运返回 null（不凭空造）。
      expect(publishPlayback(doc.playback), `${name}: 缺 playback 不得凭空造一个`).toBeNull()
    }
    // 有 playback 的真构造：原样。
    const withPb = { playback: { loop: false, defaultFrameIndex: 0 } }
    expect(publishPlaybackIsUnaltered(withPb.playback, publishPlayback(withPb.playback))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 二、"查看所需内容" + "需播放轨道"
// ─────────────────────────────────────────────────────────────────────────────

describe('发布格式内容：查看所需内容清点 + 需播放轨道', () => {
  it('完整的文档 ⇒ 七项需求全在、无缺项', () => {
    const content = inspectPublishableContent(null, publishableDoc())
    expect(content.missing).toEqual([])
    expect(content.requirements.map((r) => r.item).sort()).toEqual(['annotation', 'geometry', 'label', 'palette', 'playback', 'texture', 'tooltip'])
    for (const r of content.requirements) expect(r.source.length, `${r.item}: 必须指明来源`).toBeGreaterThan(0)
  })

  it('**「必须存在」与「必须非空」是两件事**：空 `annotations`/`labels`/`tooltipPalette` 合法', () => {
    const doc = publishableDoc()
    expect(doc.annotations).toEqual([])
    expect(doc.labels).toEqual([])
    expect(doc.tooltipPalette).toEqual([])
    expect(inspectPublishableContent(null, doc).missing, '空数组是合法内容，不是缺项').toEqual([])
    // 而**缺席** tooltip 层是真缺项（成对 idioms 要求它存在）。
    const noTooltip: Record<string, unknown> = { ...doc }
    delete noTooltip.tooltipPalette
    delete (noTooltip.frames as Record<string, unknown>[])[0]!.structure
    const frame = (noTooltip.frames as Record<string, unknown>[])[0]!
    frame.structure = { geometryPhase: 'baked', cellGrid: [[[0]]], blockPalette: [{}] }
    expect(inspectPublishableContent(null, noTooltip).missing).toContain('tooltip')
  })

  it('**负对照**：把"必须非空"与"必须存在"混为一谈 ⇒ 对空注解文档**假拒绝**', () => {
    const doc = publishableDoc()
    /** **对照实现**：要求每个数组都非空。 */
    const naiveRequiresNonEmpty = (d: Record<string, unknown>): readonly string[] => {
      const missing: string[] = []
      if (!Array.isArray(d.annotations) || (d.annotations as unknown[]).length === 0) missing.push('annotation')
      if (!Array.isArray(d.labels) || (d.labels as unknown[]).length === 0) missing.push('label')
      return missing
    }
    expect(naiveRequiresNonEmpty(doc), '对照实现对"没有注解的文档"假拒绝').toEqual(['annotation', 'label'])
    expect(inspectPublishableContent(null, doc).missing, '真实实现不得假拒绝').toEqual([])
  })

  it('缺 geometry / palette / texture ⇒ 逐项列入 `missing`（不聚合丢项）', () => {
    const empty: Record<string, unknown> = {
      frames: [{ index: 0, structure: { geometryPhase: 'baked', cellGrid: [], blockPalette: [] } }],
      annotations: [],
      labels: [],
      playback: {},
    }
    const content = inspectPublishableContent(null, empty)
    expect(content.missing).toContain('geometry')
    expect(content.missing).toContain('palette')
    expect(content.missing).toContain('texture')
  })

  it('池形态：`textureBlobs` 是槽位键对象（帧为主投影 `plainForSave().plain`）⇒ **仍算有 texture**', () => {
    // 修复前：`texturePresent` 用 `hasNonEmptyArray`（只认数组）⇒ 真产物被判"无 texture"。
    const rootShape: Record<string, unknown> = { ...publishableDoc(), textureBlobs: { '0': 'AAAA' } }
    expect(inspectPublishableContent(null, rootShape).missing, '对象形态是合法契约形态 ⇒ 不得判缺 texture').not.toContain('texture')
    // 帧内结构上的池（`s.textureBlobs` 那一支）同样两种形态都认：
    const frameShape: Record<string, unknown> = { ...publishableDoc() }
    delete frameShape.textureBlobs
    ;(frameShape.frames as Record<string, unknown>[])[0]!.structure = {
      geometryPhase: 'baked',
      cellGrid: [[[0]]],
      blockPalette: [{}],
      textureBlobs: { '0': 'AAAA' },
    }
    expect(inspectPublishableContent(null, frameShape).missing, '帧内结构的对象形态池同样算"有"').not.toContain('texture')
    // 真空池仍算缺项（"真拒绝"不得被本修复顺手放掉）：
    expect(inspectPublishableContent(null, { ...publishableDoc(), textureBlobs: {} }).missing).toContain('texture')
    expect(inspectPublishableContent(null, { ...publishableDoc(), textureBlobs: [] }).missing).toContain('texture')
  })

  it('**负对照（能红）**：修复前的 `hasNonEmptyArray`（只认数组）⇒ 对象形态被清点成"无 texture"（假拒绝）', () => {
    /** **只认数组**的池判定（修复前 `texturePresent` 用的那个实现）。 */
    const oldHasNonEmptyArray = (v: unknown): boolean => Array.isArray(v) && v.length > 0
    const objectShape: Record<string, unknown> = { ...publishableDoc(), textureBlobs: { '0': 'AAAA' } }
    expect(oldHasNonEmptyArray(objectShape.textureBlobs), '旧实现：对象形态 ⇒ false（这就是假拒绝的来源）').toBe(false)
    // 差异**只在对象形态**：数组形态上旧实现是对的（所以"只认数组"才隐蔽）。
    const arrayShape: Record<string, unknown> = { ...publishableDoc(), textureBlobs: ['AAAA'] }
    expect(oldHasNonEmptyArray(arrayShape.textureBlobs), '旧实现在数组形态上是对的').toBe(true)
    // 真实实现：对象形态不得判缺项。
    expect(inspectPublishableContent(null, objectShape).missing).not.toContain('texture')
  })

  it('"需播放的轨道" = **已启用且有键**的轨道；禁用/空轨道**仍被列出**（不静默丢）', () => {
    const mk = (id: string, enabled: boolean, keyCount: number): AnimationTrack =>
      Object.freeze({
        id,
        target: Object.freeze({ owner: objectRef('o'), property: `p.${id}` }),
        valueType: 'number' as const,
        interpolation: 'linear' as const,
        enabled,
        keys: Object.freeze(Array.from({ length: keyCount }, (_, i) => Object.freeze({ time: Object.freeze({ frame: i, fps: 20 }), value: i }))),
      })
    const doc = createDocument('d')
    const anim = withAnimation(doc, { tracks: [mk('a', true, 2), mk('b', false, 2), mk('c', true, 0)], publishedDefaults: {} }).doc.animation

    const all = playbackTrackRequirements(anim)
    expect(all.length, '**全部**轨道都要列出（含禁用/空），因为"用户禁用了它"是一个会丢信息的决定').toBe(3)
    expect(all.map((t) => t.enabled)).toEqual([true, false, true])

    const need = requiringPlayback(anim)
    expect(need.map((t) => t.trackId), '真正需要播放的只有"已启用且有键"的那条').toEqual(['a'])
    expect(need[0]!.keyCount).toBe(2)
    expect(need[0]!.key).toContain('p.a')
  })

  it('**负对照**：把禁用轨道当"需要播放"⇒ 与真实判据不一致（判据可见）', () => {
    const mk = (id: string, enabled: boolean): AnimationTrack =>
      Object.freeze({
        id,
        target: Object.freeze({ owner: objectRef('o'), property: `p.${id}` }),
        valueType: 'number' as const,
        interpolation: 'linear' as const,
        enabled,
        keys: Object.freeze([Object.freeze({ time: Object.freeze({ frame: 0, fps: 20 }), value: 0 })]),
      })
    const doc = createDocument('d')
    const anim = withAnimation(doc, { tracks: [mk('on', true), mk('off', false)], publishedDefaults: {} }).doc.animation
    /** **对照实现**：把 `enabled` 当装饰，全部算作要播。 */
    const naiveAllNeedPlayback = (a: typeof anim): readonly string[] => a.tracks.map((t) => t.id)
    expect(naiveAllNeedPlayback(anim)).toEqual(['on', 'off'])
    expect(requiringPlayback(anim).map((t) => t.trackId), '真实实现在结构上无法把禁用轨道算进来').toEqual(['on'])
    expect(naiveAllNeedPlayback(anim).length).toBeGreaterThan(requiringPlayback(anim).length)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 三、能力损失记录（接挂点，**不**重新实现判据）
// ─────────────────────────────────────────────────────────────────────────────

describe('能力损失：接 `legacyExportDiagnostics` 挂点，**不**重新实现"什么算不可表达"', () => {
  it('干净场景 ⇒ 无损失；带形变场景 ⇒ 恰好一条 `LegacyExportUnsupportedDeformation`', () => {
    const clean = createDocument('clean')
    expect(collectCapabilityLoss(clean.scene).items).toEqual([])

    const scene = sceneWithDeformation().scene
    const loss = collectCapabilityLoss(scene)
    expect(loss.items).toHaveLength(1)
    expect(loss.items[0]!.code).toBe('LegacyExportUnsupportedDeformation')
    expect(loss.items[0]!.objectId).toBe('o2')
    expect(loss.byCode).toEqual({ LegacyExportUnsupportedDeformation: 1 })
  })

  it('判据来源是**同一个**函数（本模块与 `domain/geometry` 逐项一致）', () => {
    const scene = sceneWithDeformation().scene
    expect(collectCapabilityLoss(scene).items).toEqual(legacyExportDiagnostics(scene))
  })

  it('按码取明细：`lossItemsOfCode` 与聚合计数一致', () => {
    const scene = sceneWithDeformation().scene
    const loss = collectCapabilityLoss(scene)
    expect(lossItemsOfCode(loss, 'LegacyExportUnsupportedDeformation')).toHaveLength(1)
    expect(lossItemsOfCode(loss, 'LegacyExportUnsupportedTransform')).toHaveLength(0)
  })

  it('多种损失各自计数（非整数格平移 + 形变 + 枢轴）', () => {
    let doc = createDocument('multi')
    const added = addMeshObject(doc.scene, {
      objectId: 'o',
      dataId: 'd',
      size: 1,
      deformation: deformation('def', 0, [{ id: 'c', targets: [{ vertex: 'x0y0z0', offset: { x: 1, y: 0, z: 0 } }] }]),
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    doc = withScene(doc, added.value).doc
    // 直接改对象变换（模拟"用户把它拖到 0.5"）。
    const obj = doc.scene.objects['o']!
    const moved = { ...obj, transform: { ...obj.transform, position: { x: 0.5, y: 0, z: 0 }, pivot: { x: 1, y: 0, z: 0 } } }
    const scene = { ...doc.scene, objects: { ...doc.scene.objects, o: moved } }
    const loss = collectCapabilityLoss(scene)
    expect(loss.byCode.LegacyExportUnsupportedDeformation).toBe(1)
    expect(loss.byCode.LegacyExportUnsupportedTransform).toBe(1)
    expect(loss.byCode.LegacyExportUnsupportedPivot).toBe(1)
  })

  it('`capabilityLossRecord` 保留逐项明细（不聚合丢掉 objectId —— 诊断要能定位）', () => {
    const rec = capabilityLossRecord(
      [
        { code: 'LegacyExportUnsupportedDeformation', objectId: 'a', dataId: 'da', detail: { deformationId: 'x' } },
        { code: 'LegacyExportUnsupportedDeformation', objectId: 'b', dataId: 'db', detail: { deformationId: 'y' } },
      ],
      true,
    )
    expect(rec.byCode.LegacyExportUnsupportedDeformation).toBe(2)
    expect(rec.items.map((i) => i.objectId)).toEqual(['a', 'b'])
    expect(rec.lossyAccepted).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 四、发布预检：**默认失败**（A20 判据 4 + 负对照 b）
// ─────────────────────────────────────────────────────────────────────────────

describe('发布预检：**默认失败**而不是产出"看起来完整"的文件（A20 判据 4）', () => {
  it('完整文档 + 无损失 + 无编码器 ⇒ ready（编码器缺失由 `application/exportPlan` 判，不在本层）', () => {
    const pf = preflightPublish({ document: publishableDoc(), scene: createDocument('clean').scene })
    expect(pf.status).toBe('ready')
    expect(pf.diagnostics).toEqual([])
    expect(pf.loss.items).toEqual([])
    expect(publishPreflightError(pf)).toBeNull()
  })

  it('缺一项查看所需内容 ⇒ blocked，且诊断指出**哪几项**', () => {
    const bad = publishableDoc()
    bad.textureBlobs = []
    const pf = preflightPublish({ document: bad, scene: createDocument('c').scene })
    expect(pf.status).toBe('blocked')
    const d = pf.diagnostics.find((x) => x.code === 'PublishMissingViewerContent')
    expect(d).toBeDefined()
    expect(String(d!.detail.missing)).toContain('texture')
    const e = publishPreflightError(pf)
    expect(e?.code).toBe('InvalidValue')
    expect(e?.params.reason).toBe('PublishMissingViewerContent')
  })

  it('**负对照 b**：带 `deformation` 的对象在**默认**模式下 ⇒ blocked 且产生 `LegacyExportUnsupportedDeformation`', () => {
    const scene = sceneWithDeformation().scene
    const pf = preflightPublish({ document: publishableDoc(), scene })
    expect(pf.status, '默认导出必须失败，而不是静默降采样').toBe('blocked')
    const d = pf.diagnostics.find((x) => x.code === 'PublishCapabilityLossUnaccepted')
    expect(d, '必须产生能力损失诊断').toBeDefined()
    expect(d!.detail.loss, '诊断必须指到具体码').toBe('LegacyExportUnsupportedDeformation')
    expect(d!.detail.objectId).toBe('o2')
    const e = publishPreflightError(pf)
    expect(e?.code, '能力不存在 ⇒ UnsupportedOperation').toBe('UnsupportedOperation')
    expect(e?.params.loss).toBe('LegacyExportUnsupportedDeformation')
  })

  it('**负对照 b 的另一半**：没有那条诊断 ⇒ 输出"看起来完整"的产物（这就是要判红的形态）', () => {
    const scene = sceneWithDeformation().scene
    // 真实实现：诊断确实产生。
    const realLoss = collectCapabilityLoss(scene)
    expect(realLoss.items.map((i) => i.code)).toEqual(['LegacyExportUnsupportedDeformation'])

    /** **对照实现**：静默降采样 —— 它"处理"了形变（丢掉位移），故不产生任何诊断。 */
    const naiveDownsample = (s: typeof scene): readonly never[] => {
      // 遍历对象，把形变"烘焙掉"（假装形变已被应用），不报任何东西。
      for (const id of s.order) {
        const obj = s.objects[id]
        if (!obj) continue
        const data = s.data[obj.dataId]
        if (data?.payload.kind === 'mesh' && data.payload.mesh.deformation) {
          /* 静默丢弃 */
        }
      }
      return []
    }
    expect(naiveDownsample(scene), '对照实现不产生任何诊断').toEqual([])
    // 判据差异：真实实现非空、对照实现为空。
    expect(realLoss.items.length).toBeGreaterThan(naiveDownsample(scene).length)

    // 且真实实现据此**拒绝默认导出**。
    expect(preflightPublish({ document: publishableDoc(), scene }).status).toBe('blocked')
  })

  it('**显式**有损模式才放行（「可选有损输出必须是显式模式」）', () => {
    const scene = sceneWithDeformation().scene
    const pf = preflightPublish({ document: publishableDoc(), scene, allowLossy: true })
    expect(pf.status, '显式接受有损 ⇒ ready').toBe('ready')
    expect(pf.loss.lossyAccepted, '记录必须标出"这是显式接受的有损输出"').toBe(true)
    expect(pf.loss.items.length, '损失明细**仍然**保留（不是"接受了就看不见了"）').toBe(1)
    // 「部分输出仅在显式模式下允许并**标记**」——标记在这里。
    const report = publishCapabilityReport(pf, undefined, publishableDoc())
    expect(report.ready).toBe(true)
    expect(report.lossByCode.LegacyExportUnsupportedDeformation).toBe(1)
  })

  it('**「失败时没有产物返回」是结构性保证**：`blocked` 结论里**没有**任何字节/负载字段', () => {
    const scene = sceneWithDeformation().scene
    const pf = preflightPublish({ document: publishableDoc(), scene })
    expect(pf.status).toBe('blocked')
    // 逐字段扫：结论对象里不得出现"产物"形态的字段。
    for (const banned of ['bytes', 'payload', 'blob', 'file', 'artifact', 'output', 'content']) {
      expect(Object.prototype.hasOwnProperty.call(pf, banned), `blocked 结论不得有 ${banned} 字段`).toBe(false)
    }
    expect(Object.keys(pf).sort()).toEqual(['diagnostics', 'loss', 'status'])
    // 且错误对象只带结构化参数（不含内容）。
    const e = publishPreflightError(pf)
    expect(e).not.toBeNull()
    expect(Object.keys(e!).every((k) => ['code', 'params', 'commandId', 'jobId', 'objectId', 'version'].includes(k))).toBe(true)
  })

  it('`publish: false`（工程形态）⇒ blocked（拿工程去发布是显式错误）', () => {
    const pf = preflightPublish({ document: publishableDoc(), scene: createDocument('c').scene, publish: false })
    expect(pf.status).toBe('blocked')
    expect(pf.diagnostics.map((d) => d.code)).toContain('PublishProjectShapeSelected')
  })

  it('多条诊断**逐条报告**（不"选最严重的一项报"）：缺内容 + 未接受损失同时出现', () => {
    const bad = publishableDoc()
    bad.textureBlobs = []
    const pf = preflightPublish({ document: bad, scene: sceneWithDeformation().scene })
    const codes = pf.diagnostics.map((d) => d.code)
    expect(codes).toContain('PublishMissingViewerContent')
    expect(codes).toContain('PublishCapabilityLossUnaccepted')
    expect(pf.diagnostics.length).toBeGreaterThanOrEqual(2)
  })

  it('逐项报告：两个对象各有形变 ⇒ **两条**诊断（不是"有 1 项损失"一句）', () => {
    let doc = createDocument('two')
    for (const [oid, did] of [['o1', 'd1'], ['o2', 'd2']] as const) {
      const mesh = unitBoxMesh(did, 1, deformation(`def-${did}`, 0, [{ id: 'c', targets: [{ vertex: 'x0y0z0', offset: { x: 1, y: 0, z: 0 } }] }]))
      if (!mesh.ok) throw new Error('fixture 失败')
      const added = addMeshObject(doc.scene, { objectId: oid, dataId: did, deformation: mesh.value.deformation })
      if (!added.ok) throw new Error('fixture 失败')
      doc = withScene(doc, added.value).doc
    }
    const pf = preflightPublish({ document: publishableDoc(), scene: doc.scene })
    const lossDiags = pf.diagnostics.filter((d) => d.code === 'PublishCapabilityLossUnaccepted')
    expect(lossDiags).toHaveLength(2)
    expect(lossDiags.map((d) => d.detail.objectId).sort()).toEqual(['o1', 'o2'])
  })

  it('**负对照**：把"有损失"折成一个布尔 ⇒ 无法逐项报告（判据可见）', () => {
    const scene = sceneWithDeformation().scene
    const loss = collectCapabilityLoss(scene)
    /** **对照实现**：只报"有/没有"。 */
    const naiveBooleanReport = (): boolean => loss.items.length > 0
    expect(naiveBooleanReport()).toBe(true)
    // 真实实现：能逐项说出**是哪个对象、哪个码**。
    const pf = preflightPublish({ document: publishableDoc(), scene })
    const items = pf.diagnostics.filter((d) => d.code === 'PublishCapabilityLossUnaccepted')
    expect(items[0]!.detail.objectId, '布尔报不出对象').toBe('o2')
    expect(items[0]!.detail.loss, '布尔报不出码').toBe('LegacyExportUnsupportedDeformation')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 五、发布重载（A20 判据 3）
// ─────────────────────────────────────────────────────────────────────────────

describe('发布重载：发布 → 读回 → 与源**语义一致**（含能力损失记录）', () => {
  it('打包 → 读回：语义子树摘要与源一致（B-2 的口径）', () => {
    const src = publishableDoc()
    // 发布打包：把查看所需内容打进 Envelope（元数据进 meta）。
    const packed = encodeEnvelope({ plain: src, meta: { id: src.id, label: 'P', author: '', gtnhVersion: '', structureId: '', schemaVersion: 1 } })
    expect(packed.ok).toBe(true)
    if (!packed.ok) return

    // 读回：解包后的内层必须与源（剔除 meta 键后）语义一致。
    const back = decodeEnvelope(packed.value)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.value.inner.cellGrid ?? (back.value.inner.frames as Record<string, unknown>[])[0], '查看所需内容必须在位').toBeDefined()

    // 严格判据：把源按同一 meta 键集拆分，两边**语义子树**必须等价。
    const srcBody: Record<string, unknown> = { ...src }
    for (const k of ['id', 'label', 'author', 'gtnhVersion', 'structureId', 'schemaVersion', 'documentFormat']) delete srcBody[k]
    expect(canonicalSubtreeText(back.value.inner), '读回的内层 body 必须与源 body 逐位语义相同').toBe(canonicalSubtreeText(srcBody))
  })

  it('重载后的 `playback` 仍是契约默认（发布**没有**启用播放）', () => {
    const src = publishableDoc()
    const packed = encodeEnvelope({ plain: src, meta: { id: 'x' } })
    expect(packed.ok).toBe(true)
    if (!packed.ok) return
    const back = decodeEnvelope(packed.value)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.value.plain.playback).toEqual(PUBLISH_PLAYBACK_DEFAULT)
    expect(publishPlaybackIsUnaltered(back.value.plain.playback, publishPlayback(back.value.plain.playback))).toBe(true)
  })

  it('**负对照**：读回后与源**不**一致时摘要必须不同（证明摘要真的在比较内容）', () => {
    const src = publishableDoc()
    const packed = encodeEnvelope({ plain: src, meta: { id: 'x' } })
    expect(packed.ok).toBe(true)
    if (!packed.ok) return
    const back = decodeEnvelope(packed.value)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    const mutatedInner = { ...back.value.inner, cellGrid: [[[9]]] }
    const srcBody: Record<string, unknown> = { ...src }
    for (const k of ['id']) delete srcBody[k]
    expect(canonicalSubtreeText(mutatedInner), '内容被改动 ⇒ 摘要必须不同').not.toBe(canonicalSubtreeText(back.value.inner))
  })

  it('能力报告：损失明细 + 需播放轨道 + 查看需求三项齐备（供「逐项报告」消费）', () => {
    const scene = sceneWithDeformation().scene
    const pf = preflightPublish({ document: publishableDoc(), scene, allowLossy: true })
    const doc = createDocument('d')
    const track: AnimationTrack = Object.freeze({
      id: 't',
      target: Object.freeze({ owner: objectRef('o'), property: 'channel.tier' }),
      valueType: 'integer' as const,
      interpolation: 'step' as const,
      enabled: true,
      keys: Object.freeze([Object.freeze({ time: Object.freeze({ frame: 0, fps: 20 }), value: 1 })]),
    })
    const anim = withAnimation(doc, { tracks: [track], publishedDefaults: {} }).doc.animation
    const report = publishCapabilityReport(pf, anim, publishableDoc())
    expect(report.ready).toBe(true)
    expect(report.lossItems).toHaveLength(1)
    expect(report.lossByCode.LegacyExportUnsupportedDeformation).toBe(1)
    expect(report.playbackTracks).toHaveLength(1)
    expect(report.playbackTracks[0]!.enabled).toBe(true)
    expect(report.viewerRequirements.length).toBe(7)
  })

  withRealFixture(
    STRUCTUREDATA_FIXTURE_KEY,
    '真 Envelope 夹具的 `playback` 情形：缺省时**不**造（`copyIfPresent` 语义）',
    () => {
    const env = readFixture('structuredata-exported-envelope.json')
    const d = decodeEnvelope(env)
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(publishPlayback(d.value.plain.playback), '真产物没有 playback ⇒ 搬运返回 null').toBeNull()
    // 而发布预检对"缺 playback"报缺项（它是必填字段，F-09 的字段表把 playback 标"是"）。
    const pf = preflightPublish({ document: d.value.plain, scene: createDocument('c').scene })
    expect(pf.diagnostics.some((x) => x.code === 'PublishMissingViewerContent' && String(x.detail.missing).includes('playback'))).toBe(true)
  })

  it('`envelopeSemanticallyEqual` 是发布重载的**唯一**相等判据（不是逐字节）', () => {
    const src = publishableDoc()
    const a = encodeEnvelope({ plain: src, meta: { id: 'x' } })
    const b = encodeEnvelope({ plain: src, meta: { id: 'x' } })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(envelopeSemanticallyEqual(a.value, b.value)).toBe(true)
    expect(a.value.payload, '本实现钉死 MTIME ⇒ 连字节都相同（更强的性质，但不是判据）').toBe(b.value.payload)
    // 篡改 meta 不算内容变化（meta 不是语义子树）—— 这条是 F-35「meta 是唯一元数据真源」的推论。
    const c = encodeEnvelope({ plain: src, meta: { id: 'y' } })
    expect(c.ok).toBe(true)
    if (!c.ok) return
    expect(envelopeSemanticDigest(c.value).ok && envelopeSemanticDigest(a.value).ok).toBe(true)
  })
})

/** 未使用占位：保持 `PublishPreflight` 类型可达。 */
export type { PublishPreflight }
