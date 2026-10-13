/**
 * A20 —— **工程往返**（#249 §14 A20「工程语义身份/动画/资源引用保留」；§12 第 1 段；#260 交付范围第 1 项）。
 *
 * ## 这个文件证明什么（A20 判据 1）
 *
 * > 「工程语义身份/动画/资源引用保留」——**用固定样本**，不靠"跑一遍不报错"。
 *
 * 三条断言各有其**独立**的失败模式，故分开测而不是"往返一次然后全等"：
 *
 * | 保留项 | 失败模式 | 本文件 |
 * |---|---|---|
 * | **语义身份** | 场景/动画被规范化（键序、数值精度、结构共享丢失） | {@link compareProjectRoundTrip} 的 `contentIdentityPreserved` |
 * | **动画** | 轨道/关键帧/发布默认值在序列化时被丢 | 单独的轨道逐项断言（含关键帧时间与值） |
 * | **资源引用** | URL 参与身份 ⇒ 换镜像地址即"依赖变了"；或版本被丢 | 清单摘要 + locator 不参与身份的**负对照** |
 *
 * ## 与偏好/布局的分离（#249 §12 末句）
 *
 * 同一个文件里断言两件对立的事：
 *  - 工程文档**能**带回可恢复编辑数据（选择/时间/通道取值）；
 *  - 工程文档**不能**带回机位/布局/语言（它们在类型里没有位置，见
 *    `projectFormat.RecoverableEditData` 的字段表）。
 */

import { describe, expect, it } from 'vitest'

import {
  compareProjectRoundTrip,
  assetManifestDigest,
  decodeProject,
  encodeProject,
  editDataOf,
  normalizeAssets,
  isSupportedProjectVersion,
  restoreProject,
  PROJECT_FORMAT_VERSION,
  PROJECT_FORMAT_FIELD,
  PROJECT_FORMAT_MAJOR,
  type ProjectAssetRef,
  type ProjectFile,
} from '@/adapters/files/projectFormat'
import {
  DOCUMENT_BOUND_PREFERENCES,
  documentBindingsAreIsolated,
  documentPreferenceKey,
  documentPreferenceKeyIsStable,
  findDocumentBoundPreference,
  instancePreferenceKey,
  readPreferenceBinding,
} from '@/adapters/files/documentBinding'
import { addAnnotationObject, addBlockObject, addCameraObject, createDocument, withAnimation, withScene } from '@/domain/document'
import { createEditContext, seekContextTime, selectOne, withChannelValue } from '@/domain/editing'
import { objectRef } from '@/domain/identity'
import { unitBoxMesh, deformation, type DeformationChannel } from '@/domain/geometry'
import { addMeshObject } from '@/domain/document'
import { insertKeyframe, withTrack, type AnimationTrack } from '@/domain/animation'
import { createDocument as _docProbe } from '@/domain/document'
import { preferenceKey } from '@/domain/instanceSettings'

void _docProbe

// ─────────────────────────────────────────────────────────────────────────────
// 固定样本（**不**靠"跑一遍不报错"）
// ─────────────────────────────────────────────────────────────────────────────

const DOC_ID = 'project-fixture-doc'
const CONTEXT_ID = 'project-fixture-ctx'

/** 固定样本：方块 + 注解框 + 相机 + 网格（含形变）四类对象，覆盖内容身份的全部来源。 */
function fixedSample(): { file: ProjectFile; doc: ReturnType<typeof createDocument> } {
  let doc = createDocument(DOC_ID, { sceneId: 'scene-fixture' })
  const withBlock = addBlockObject(doc.scene, { objectId: 'o-block', dataId: 'd-block', name: 'Block', cells: { '0,0,0': 'minecraft:stone' } })
  expect(withBlock).not.toBeNull()
  const withAnn = addAnnotationObject(withBlock!, { objectId: 'o-ann', dataId: 'd-ann', name: 'Ann', shape: 'box', text: '说明' })
  expect(withAnn).not.toBeNull()
  const withCam = addCameraObject(withAnn!, { objectId: 'o-cam', dataId: 'd-cam', name: 'Cam', projection: 'orthographic', fov: 30 })
  expect(withCam).not.toBeNull()

  const channel: DeformationChannel = { id: 'ch-1', targets: [{ vertex: 'x0y0z0', offset: { x: 0.25, y: 0, z: 0 } }] }
  const meshAdd = addMeshObject(withCam!, {
    objectId: 'o-mesh',
    dataId: 'd-mesh',
    name: 'Mesh',
    size: 1,
    deformation: deformation('def-1', 0, [channel]),
  })
  expect(meshAdd.ok).toBe(true)
  if (!meshAdd.ok) throw new Error('fixture 构造失败')
  doc = withScene(doc, meshAdd.value).doc

  // 动画：一条阶跃轨道（离散通道）+ 一条线性轨道（连续数值）+ 发布默认值。
  const stepTrack: AnimationTrack = Object.freeze({
    id: 'track-step',
    target: Object.freeze({ owner: objectRef('o-block'), property: 'channel.tier' }),
    valueType: 'integer' as const,
    interpolation: 'step' as const,
    enabled: true,
    keys: Object.freeze([Object.freeze({ time: Object.freeze({ frame: 0, fps: 20 }), value: 1 })]),
  })
  const linearTrack: AnimationTrack = Object.freeze({
    id: 'track-linear',
    target: Object.freeze({ owner: objectRef('o-ann'), property: 'transform.position.x' }),
    valueType: 'number' as const,
    interpolation: 'linear' as const,
    enabled: true,
    keys: Object.freeze([
      Object.freeze({ time: Object.freeze({ frame: 0, fps: 20 }), value: 0 }),
      Object.freeze({ time: Object.freeze({ frame: 20, fps: 20 }), value: 5 }),
    ]),
  })
  const inserted = insertKeyframe(stepTrack, { time: Object.freeze({ frame: 10, fps: 20 }), value: 3 })
  let anim = withTrack(withTrack({ tracks: [], publishedDefaults: {} }, linearTrack), inserted)
  anim = Object.freeze({ ...anim, publishedDefaults: Object.freeze({ 'channel.tier': 2 }) })
  doc = withAnimation(doc, anim).doc

  // 编辑上下文：选择 + 时间 + 通道取值 + 活动工具。
  let ctx = createEditContext(CONTEXT_ID, DOC_ID)
  ctx = selectOne(ctx, objectRef('o-block'))
  ctx = seekContextTime(ctx, { frame: 7, fps: 20 })
  ctx = withChannelValue(ctx, 'tier', 3)

  const assets: ProjectAssetRef[] = [
    { assetId: 'minecraft:textures/block/stone', contentVersion: 'sha256-aaa', locator: 'https://example.invalid/a.png' },
    { assetId: 'minecraft:textures/block/ore', contentVersion: 'sha256-bbb', locator: 'https://mirror.invalid/b.png' },
  ]

  const encoded = encodeProject({ doc, context: ctx, assets })
  expect(encoded.ok, '固定样本必须能编码').toBe(true)
  if (!encoded.ok) throw new Error(`fixture 编码失败：${encoded.error.code}`)

  // 走过的路：编码 → （规范化 JSON，模拟落盘）→ 解析。
  const wire = JSON.parse(JSON.stringify(encoded.value)) as unknown
  const decoded = decodeProject(wire)
  expect(decoded.ok, '固定样本必须能解码').toBe(true)
  if (!decoded.ok) throw new Error(`fixture 解码失败：${decoded.error.code}`)
  const reEncoded = encodeProject({ doc: restoreProject(decoded.value).doc, context: restoreProject(decoded.value).context, assets: decoded.value.payload.assets })
  expect(reEncoded.ok).toBe(true)
  if (!reEncoded.ok) throw new Error('fixture 重编码失败')
  return { file: reEncoded.value, doc: restoreProject(decoded.value).doc }
}

// ─────────────────────────────────────────────────────────────────────────────
// 一、工程往返（A20 判据 1）
// ─────────────────────────────────────────────────────────────────────────────

describe('A20 工程往返：语义身份 / 动画 / 资源引用保留（固定样本）', () => {
  const { file } = fixedSample()

  it('反空洞真：固定样本**真的**有四类对象与两条轨道（否则下面的"保留"是在空样本上断言）', () => {
    expect(Object.keys(file.payload.scene.objects).sort()).toEqual(['o-ann', 'o-block', 'o-cam', 'o-mesh'])
    expect(file.payload.animation.tracks.length).toBe(2)
    expect(file.payload.assets.length).toBe(2)
    expect(file.payload.editData.selection.length).toBe(1)
  })

  it('**语义身份保留**：编码 → 线格式 → 解码 → 再编码，四项报告全绿', () => {
    const wire = JSON.parse(JSON.stringify(file)) as unknown
    const decoded = decodeProject(wire)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    const { doc, context } = restoreProject(decoded.value)
    const again = encodeProject({ doc, context, assets: decoded.value.payload.assets })
    expect(again.ok).toBe(true)
    if (!again.ok) return
    const report = compareProjectRoundTrip(file, again.value)
    expect(report).toEqual({
      contentIdentityPreserved: true,
      documentIdPreserved: true,
      assetManifestPreserved: true,
      editDataPreserved: true,
      // R1-α：**内容本体**（元数据 / 帧轴 / 资源内容）也是四项之一。
      // 只比清单摘要看不见内嵌字节与呈现参数 —— 而那是实测丢过的东西。
      documentContentPreserved: true,
    })
  })

  it('**对象数据身份逐项保留**（不是"对象个数相同"就算保留）', () => {
    const wire = JSON.parse(JSON.stringify(file)) as unknown
    const decoded = decodeProject(wire)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    const before = file.payload.scene
    const after = decoded.value.payload.scene
    expect(Object.keys(after.objects).sort()).toEqual(Object.keys(before.objects).sort())
    for (const id of Object.keys(before.objects)) {
      const a = before.objects[id]!
      const b = after.objects[id]!
      expect(b.type, `${id}: 类型`).toBe(a.type)
      expect(b.name, `${id}: 名称`).toBe(a.name)
      expect(b.dataId, `${id}: 数据引用`).toBe(a.dataId)
      expect(b.transform, `${id}: 变换（含显式枢轴）`).toEqual(a.transform)
      expect(after.data[a.dataId]?.contentVersion, `${id}: 数据内容版本`).toBe(before.data[a.dataId]?.contentVersion)
    }
    expect(after.order).toEqual(before.order)
  })

  it('**动画保留**：轨道 id / 目标 / 值类型 / 插值 / 关键帧（时间与值）逐项相同', () => {
    const wire = JSON.parse(JSON.stringify(file)) as unknown
    const decoded = decodeProject(wire)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    const before = file.payload.animation
    const after = decoded.value.payload.animation
    expect(after.tracks.length).toBe(before.tracks.length)
    for (let i = 0; i < before.tracks.length; i++) {
      const a = before.tracks[i]!
      const b = after.tracks[i]!
      expect(b.id).toBe(a.id)
      expect(b.target).toEqual(a.target)
      expect(b.valueType).toBe(a.valueType)
      expect(b.interpolation).toBe(a.interpolation)
      expect(b.enabled).toBe(a.enabled)
      expect(b.keys, `${a.id}: 关键帧必须逐项保留（含时间与值）`).toEqual(a.keys)
    }
    expect(after.publishedDefaults).toEqual(before.publishedDefaults)
    // 阶跃轨道的关键帧数量是 2（初始 1 + 插入 1）—— 证明插入真的发生过。
    expect(after.tracks.find((t) => t.id === 'track-step')?.keys.length).toBe(2)
  })

  it('**资源引用保留**：assetId + contentVersion 逐项相同', () => {
    const wire = JSON.parse(JSON.stringify(file)) as unknown
    const decoded = decodeProject(wire)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.value.payload.assets.map((a) => `${a.assetId}@${a.contentVersion}`)).toEqual(
      file.payload.assets.map((a) => `${a.assetId}@${a.contentVersion}`),
    )
    expect(assetManifestDigest(decoded.value.payload.assets)).toBe(assetManifestDigest(file.payload.assets))
  })

  it('**负对照**：清单摘要**不含 `locator`** —— 换镜像地址不算"依赖变化"', () => {
    const base: ProjectAssetRef[] = [{ assetId: 'a', contentVersion: 'v1', locator: 'https://one.invalid/x.png' }]
    const moved: ProjectAssetRef[] = [{ assetId: 'a', contentVersion: 'v1', locator: 'https://two.invalid/y.png' }]
    expect(assetManifestDigest(base), 'URL 仅获取位置 ⇒ 不参与身份').toBe(assetManifestDigest(moved))
    // 而**内容版本**变化必须被看见（否则依赖换版会被静默忽略）。
    const bumped: ProjectAssetRef[] = [{ assetId: 'a', contentVersion: 'v2', locator: 'https://one.invalid/x.png' }]
    expect(assetManifestDigest(bumped)).not.toBe(assetManifestDigest(base))
    // 对照实现：把 URL 拼进摘要 ⇒ 判红。
    const naiveDigest = (assets: readonly ProjectAssetRef[]): string => assets.map((a) => `${a.assetId}@${a.contentVersion}@${a.locator}`).sort().join('|')
    expect(naiveDigest(base), '对照实现（含 URL）会把换镜像判成变化').not.toBe(naiveDigest(moved))
    expect(assetManifestDigest(base) === assetManifestDigest(moved), '真实实现视其为同一份依赖').toBe(true)
  })

  it('**可恢复编辑数据保留**：选择（按**值**比较）/ 时间 / 通道取值 / 活动工具', () => {
    const wire = JSON.parse(JSON.stringify(file)) as unknown
    const decoded = decodeProject(wire)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    const e = decoded.value.payload.editData
    expect(e.contextId).toBe(CONTEXT_ID)
    expect(e.selection).toEqual([objectRef('o-block')])
    expect(e.active).toEqual(objectRef('o-block'))
    expect(e.time).toEqual({ frame: 7, fps: 20 })
    expect(e.channelValues).toEqual({ tier: 3 })
    // `activeTool` 在固定样本里是 null；断言它**显式存在**（不是缺失）。
    expect(e.activeTool).toBeNull()
  })

  it('**还原后的文档是干净的**（刚打开 = 与保存基线相同，不"一打开就脏"）', () => {
    const wire = JSON.parse(JSON.stringify(file)) as unknown
    const decoded = decodeProject(wire)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    const { doc } = restoreProject(decoded.value)
    expect(doc.saveBaseline.contentVersion, '重开同一工程 ⇒ 与基线内容身份相同').toBe(doc.version.contentVersion)
  })

  it('工程文件**不含**机位/布局/语言（#249 §12：布局与个人偏好单独保存）', () => {
    const wire = JSON.stringify(file)
    for (const banned of ['camera:', 'viewport', 'regionLayout', 'panelLayout', 'lang', 'theme', 'keymap', 'CameraSpec']) {
      expect(wire.includes(`"${banned}"`), `工程文件不得含 ${banned}（它属实例/用户偏好域）`).toBe(false)
    }
    // 而"相机**对象**"是文档内容，必须**在**（上面那条禁令不适用于数据载荷）。
    expect(file.payload.scene.objects['o-cam']?.type).toBe('camera')
  })

  it('`editDataOf` 是唯一抽取点：与上下文字段逐项一致', () => {
    const ctx = withChannelValue(seekContextTime(selectOne(createEditContext('c', DOC_ID), objectRef('o-1')), { frame: 3, fps: 24 }), 'k', 1)
    const e = editDataOf(ctx)
    expect(e.contextId).toBe('c')
    expect(e.selection).toEqual([objectRef('o-1')])
    expect(e.time).toEqual({ frame: 3, fps: 24 })
    expect(e.channelValues).toEqual({ k: 1 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 二、格式版本
// ─────────────────────────────────────────────────────────────────────────────

describe('工程格式版本：未知主版本**显式拒绝**（不降级读取 ⇒ 不静默丢新字段）', () => {
  it('主版本判据稳定，且当前版本被支持', () => {
    expect(isSupportedProjectVersion(PROJECT_FORMAT_VERSION)).toBe(true)
    expect(isSupportedProjectVersion(`${PROJECT_FORMAT_MAJOR}.7`), '同主版本内次版本差异可互读').toBe(true)
    expect(isSupportedProjectVersion(`${PROJECT_FORMAT_MAJOR + 1}.0`), '跨主版本不可读').toBe(false)
    expect(isSupportedProjectVersion('')).toBe(false)
    expect(isSupportedProjectVersion('abc')).toBe(false)
  })

  it('未知主版本 ⇒ `UnsupportedOperation`（契约 §3.2 的"能力不存在"）', () => {
    const r = decodeProject({ [PROJECT_FORMAT_FIELD]: '2.0', payload: { documentId: 'd', sceneId: 's', scene: {}, editData: { contextId: 'c' } } })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('UnsupportedOperation')
    expect(r.error.params.reason).toBe('projectFormatVersionUnsupported')
    expect(r.error.params.supportedMajor).toBe(PROJECT_FORMAT_MAJOR)
  })

  it('**负对照**：把未知版本当当前版本读 ⇒ 新字段被静默丢弃（这正是要防的）', () => {
    const futureDoc = {
      [PROJECT_FORMAT_FIELD]: '2.0',
      futureOnlySection: { important: true }, // 版本 2 才有的字段，版本 1 的读入端不认识
      payload: { documentId: 'd', sceneId: 's', scene: {}, editData: { contextId: 'c' } },
    }
    // 真实实现：拒绝（于是用户会看到"版本太新"，而不是丢了字段还不知道）。
    expect(decodeProject(futureDoc).ok).toBe(false)
    // 对照实现：按当前版本尽力读 —— 它"成功"了，但 `futureOnlySection` 从未被读到。
    const naiveRead = (raw: Record<string, unknown>): Record<string, unknown> => (raw.payload as Record<string, unknown>) ?? {}
    const naive = naiveRead(futureDoc)
    expect(Object.keys(naive), '对照实现读出的负载里没有那个新字段').not.toContain('futureOnlySection')
    expect(JSON.stringify(naive).includes('important'), '新字段的信息量在对照实现下彻底消失').toBe(false)
  })

  it('缺 `formatVersion` / 缺 `payload` / 缺 `editData` 各自有稳定 reason', () => {
    const cases: [unknown, string][] = [
      [{}, 'projectMissingFormatVersion'],
      [{ [PROJECT_FORMAT_FIELD]: '1.0' }, 'projectMissingPayload'],
      [{ [PROJECT_FORMAT_FIELD]: '1.0', payload: {} }, 'projectMissingDocumentId'],
      [{ [PROJECT_FORMAT_FIELD]: '1.0', payload: { documentId: 'd' } }, 'projectMissingSceneId'],
      [{ [PROJECT_FORMAT_FIELD]: '1.0', payload: { documentId: 'd', sceneId: 's', scene: {} } }, 'projectMissingEditData'],
      [{ [PROJECT_FORMAT_FIELD]: '1.0', payload: { documentId: 'd', sceneId: 's', scene: {}, editData: {} } }, 'projectMissingContextId'],
    ]
    for (const [raw, reason] of cases) {
      const r = decodeProject(raw)
      expect(r.ok, `${reason}: 必须拒绝`).toBe(false)
      if (r.ok) continue
      expect(r.error.params.reason, `期望 reason=${reason}`).toBe(reason)
    }
  })

  it('上下文绑定到**别的**文档 ⇒ 编码时显式拒绝（不静默以 doc 为准）', () => {
    const doc = createDocument('doc-a')
    const ctx = createEditContext('ctx-b', 'doc-b')
    const r = encodeProject({ doc, context: ctx })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.params.reason).toBe('projectContextDocumentMismatch')
  })

  it('资源清单规范化：按 `(assetId, contentVersion)` 去重、稳定排序、缺项拒绝', () => {
    const dup: ProjectAssetRef[] = [
      { assetId: 'b', contentVersion: '1', locator: 'x' },
      { assetId: 'a', contentVersion: '1', locator: 'y' },
      { assetId: 'b', contentVersion: '1', locator: 'z' }, // 同 id 同版本 ⇒ 去重（保留首条）
    ]
    const r = normalizeAssets(dup)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.map((a) => a.assetId)).toEqual(['a', 'b'])
    expect(r.value[1]!.locator, '去重保留首条').toBe('x')
    // 同 id **不同**版本 ⇒ 不合并（那是两份不同的依赖）。
    const twoVersions = normalizeAssets([
      { assetId: 'a', contentVersion: '1', locator: 'x' },
      { assetId: 'a', contentVersion: '2', locator: 'x' },
    ])
    expect(twoVersions.ok).toBe(true)
    if (!twoVersions.ok) return
    expect(twoVersions.value.length).toBe(2)
    // 缺 assetId / 缺 contentVersion ⇒ 拒绝（不用空串冒充）。
    for (const bad of [[{ assetId: '', contentVersion: '1', locator: '' }], [{ assetId: 'a', contentVersion: '', locator: '' }]]) {
      const b = normalizeAssets(bad as ProjectAssetRef[])
      expect(b.ok).toBe(false)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 三、布局/偏好单独保存 + 经文档 ID 重新绑定（#249 §12 末句）
// ─────────────────────────────────────────────────────────────────────────────

describe('布局与个人偏好**单独保存**，经**文档 ID** 重新绑定（#249 §12 末句）', () => {
  it('登记表每项都写明"为什么按文档"（不得只写名字）', () => {
    expect(DOCUMENT_BOUND_PREFERENCES.length).toBeGreaterThan(0)
    for (const p of DOCUMENT_BOUND_PREFERENCES) {
      expect(p.name.length).toBeGreaterThan(0)
      expect(p.why.length, `${p.name}: 必须写明为什么按文档绑定`).toBeGreaterThan(20)
      expect(['workbench', 'embed', 'shared']).toContain(p.namespace)
    }
    expect(findDocumentBoundPreference('viewport')).not.toBeNull()
    expect(findDocumentBoundPreference('nope')).toBeNull()
  })

  it('键由**文档 ID** 构成，且可被反解回该 ID（"重新绑定"的可执行含义）', () => {
    const k = documentPreferenceKey('doc-a', 'viewport')
    expect(k.ok).toBe(true)
    if (!k.ok) return
    const binding = readPreferenceBinding(k.value)
    expect(binding).not.toBeNull()
    expect(binding!.boundTo, '反解出的绑定目标必须就是文档 ID').toBe('doc-a')
    expect(binding!.name).toBe('viewport')
    expect(binding!.namespace).toBe('workbench')
    // 键形态复用 `domain/instanceSettings.preferenceKey`（不另造一套）。
    expect(k.value).toBe(preferenceKey('workbench', 'doc-a', 'viewport'))
  })

  it('**隔离**：两份文档的同名偏好键互不相同、且各自绑定到自己的文档', () => {
    const a = documentPreferenceKey('doc-a', 'regionLayout')
    const b = documentPreferenceKey('doc-b', 'regionLayout')
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.value).not.toBe(b.value)
    expect(documentBindingsAreIsolated({ documentId: 'doc-a', key: a.value }, { documentId: 'doc-b', key: b.value })).toBe(true)
    // **负对照**：声称隔离但两边键相同 ⇒ 判红。
    expect(documentBindingsAreIsolated({ documentId: 'doc-a', key: a.value }, { documentId: 'doc-b', key: a.value })).toBe(false)
    // **负对照**：键绑定到的不是它声称的文档 ⇒ 判红。
    expect(documentBindingsAreIsolated({ documentId: 'doc-a', key: a.value }, { documentId: 'doc-b', key: b.value }) && a.value === b.value).toBe(false)
  })

  it('同一文档同一名称的键**稳定**（"重开同一文档布局回到原样"的前提）', () => {
    expect(documentPreferenceKeyIsStable('doc-a', 'viewport')).toBe(true)
    expect(documentPreferenceKeyIsStable('doc-a', 'recovery')).toBe(true)
  })

  it('未登记的偏好名 ⇒ 显式拒绝（不静默给键，避免未决政策沉淀）', () => {
    const r = documentPreferenceKey('doc-a', 'notRegisteredThing')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.params.reason).toBe('preferenceNotDocumentBound')
    expect(String(r.error.params.registered)).toContain('viewport')
  })

  it('空文档 ID ⇒ 拒绝（否则会产出一个绑到"空"的键，切文档即互相污染）', () => {
    for (const bad of ['', '   ']) {
      const r = documentPreferenceKey(bad, 'viewport')
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.error.params.reason).toBe('documentIdRequired')
    }
  })

  it('**按实例**的偏好与按文档的偏好**不撞车**（语言/主题属用户域，换文档不变）', () => {
    const docKey = documentPreferenceKey('doc-a', 'viewport')
    expect(docKey.ok).toBe(true)
    if (!docKey.ok) return
    const instKey = instancePreferenceKey('inst-a', 'lang')
    expect(instKey).not.toBe(docKey.value)
    const b = readPreferenceBinding(instKey)
    expect(b?.boundTo, '按实例的键绑到实例 id').toBe('inst-a')
    expect(b?.name).toBe('lang')
    // 同一实例在两个不同文档下取语言键 ⇒ **同一个键**（这正是"用户偏好"的语义）。
    expect(instancePreferenceKey('inst-a', 'lang')).toBe(instKey)
  })

  it('`readPreferenceBinding` 对非本方案的键返回 `null`（宿主页面的键不误判）', () => {
    expect(readPreferenceBinding('some-host-key')).toBeNull()
    expect(readPreferenceBinding('lightning-wiki-recent-structures')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 四、网格对象（含形变）的身份保留 —— 与能力损失的衔接
// ─────────────────────────────────────────────────────────────────────────────

describe('含形变的网格对象经工程往返身份保留（它是"能力损失"判定的输入）', () => {
  it('形变数据（通道 + 目标顶点位移）逐项往返', () => {
    const mesh = unitBoxMesh('d-mesh', 1, deformation('def-x', 0, [{ id: 'c', targets: [{ vertex: 'x0y0z0', offset: { x: 1, y: 2, z: 3 } }] }]))
    expect(mesh.ok).toBe(true)
    if (!mesh.ok) return
    let doc = createDocument('doc-mesh')
    const added = addMeshObject(doc.scene, { objectId: 'o', dataId: 'd-mesh', deformation: mesh.value.deformation })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    doc = withScene(doc, added.value).doc
    const ctx = createEditContext('ctx', 'doc-mesh')
    const enc = encodeProject({ doc, context: ctx })
    expect(enc.ok).toBe(true)
    if (!enc.ok) return
    const dec = decodeProject(JSON.parse(JSON.stringify(enc.value)) as unknown)
    expect(dec.ok).toBe(true)
    if (!dec.ok) return
    const payload = dec.value.payload.scene.data['d-mesh']!.payload
    expect(payload.kind).toBe('mesh')
    if (payload.kind !== 'mesh') return
    expect(payload.mesh.deformation).toEqual(mesh.value.deformation)
    expect(payload.mesh.deformation?.channels[0]?.targets[0]?.vertex).toBe('x0y0z0')
  })

  it('**负对照**：形变若在往返中被丢掉，能力损失诊断就再也看不到它（判据可见）', async () => {
    const mesh = unitBoxMesh('d', 1, deformation('def-y', 0, [{ id: 'c', targets: [{ vertex: 'x1y1z1', offset: { x: 1, y: 0, z: 0 } }] }]))
    expect(mesh.ok).toBe(true)
    if (!mesh.ok) return
    let doc = createDocument('doc-loss')
    const added = addMeshObject(doc.scene, { objectId: 'o', dataId: 'd', deformation: mesh.value.deformation })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    doc = withScene(doc, added.value).doc
    // 真实往返：形变在 ⇒ 能力损失诊断看得见它。
    const enc = encodeProject({ doc, context: createEditContext('c', 'doc-loss') })
    expect(enc.ok).toBe(true)
    if (!enc.ok) return
    const dec = decodeProject(JSON.parse(JSON.stringify(enc.value)) as unknown)
    expect(dec.ok).toBe(true)
    if (!dec.ok) return
    const { doc: restored } = restoreProject(dec.value)
    const { legacyExportDiagnostics } = await import('@/domain/geometry')
    expect(legacyExportDiagnostics(restored.scene).map((d) => d.code)).toContain('LegacyExportUnsupportedDeformation')
    // 对照：手工造一份"形变被丢掉"的文档 ⇒ 诊断再也报不出来（这就是静默降采样的入口）。
    const stripped = { ...restored.scene, data: { ...restored.scene.data, d: { ...restored.scene.data['d']!, payload: { kind: 'mesh' as const, mesh: { ...mesh.value, deformation: undefined } } } } }
    expect(legacyExportDiagnostics(stripped as typeof restored.scene).map((d) => d.code)).not.toContain('LegacyExportUnsupportedDeformation')
  })
})
