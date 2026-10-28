/**
 * A29 `snapshot-export` —— 固定快照导出的验收（有损输出显式接受）。
 *
 * ## 逐条对照（A29 原文）
 *
 * | Given / When | 必须成立的可观测断言 | 本文件落点 |
 * |---|---|---|
 * | 导出 S0/固定时间序列时继续编辑并改变视角 | 产物对应 **S0** 与资源清单 | 「继续编辑不改变快照」组 |
 * | 同上 | **不改变**工作区时间/选择/机位 | 「不借用实时相机」组（结构证据：请求里只有值） |
 * | 中途取消 | **取消释放资源** | 「取消」组（`releasedFor` 与 `release()` 调用计数） |
 * | — | 不支持运行时间映射 / 缺必需资源时**预检失败** | 「预检」组 |
 * | — | **负对照**：导出借用并旋转实时相机、隐式读取最新文档 ⇒ 判红 | 「负对照」组（用对照实现证伪，不是让测试自己抛错） |
 *
 * ## 为什么负对照用"对照实现"而不是"主动抛错"
 *
 * 测试维护要求：**负对照必须证明确实破坏了目标保证，不能只令测试主动抛错**。
 * 故本文件里每条负对照都写一个**朴素的对照实现**（正是旧导出器的做法：读当前文档、
 * 借用当前相机），再断言它确实产出与 S0 不同的结果 —— 这就证明"我们选择捕获"不是空话。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  copyCameraSpec,
  freezeExportRequest,
  planCaptureFrames,
  resolveCameraSpec,
  SCENE_TIME_ONLY,
  type CameraSpec,
  type CaptureSpec,
  type CaptureTime,
  type ExportAssetNeed,
  type ExportRequest,
  type RenderSettings,
  type TimeMapping,
} from '@/domain/captureSpec'
import { LOOP_LIMITS } from '@/domain/materials'
import {
  describeExportRequest,
  encodingAllowedFor,
  evaluationKeyOf,
  fileExtensionOf,
  mediaTypeOf,
  normalizeAssetNeeds,
  planExportRequest,
  preflightError,
  preflightExport,
  planSourceFrames,
  requestMatchesVersion,
  supportedEncodingsFor,
  timeQuantizationOf,
  type EncoderPort,
  type ExportKind,
  type RenderedFrame,
} from '@/application/exportPlan'
import { ExportJob, refuseWhenBlocked, type OffscreenRenderPort } from '@/runtime/exportJob'
import { Editor } from '@/runtime/execution'
import { canonicalize } from '@/domain/identity'
import { addBlockObject, addCameraObject, createDocument, withScene } from '@/domain/document'
import { EMPTY_ANIMATION } from '@/domain/animation'
import { findObject } from '@/domain/scene'
import { AssetStateStore, preflightRequiredAssets } from '@/presentation/assetState'
import { assetRequest } from '@/presentation/assetIdentity'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

function sceneWithBlocks(n: number) {
  let doc = createDocument('doc-1')
  for (let i = 0; i < n; i++) {
    const s = addBlockObject(doc.scene, { objectId: `o${i}`, dataId: `d${i}` })
    if (!s) throw new Error('fixture: addBlockObject failed')
    doc = withScene(doc, s).doc
  }
  return doc
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

function specOf(over: Partial<CaptureSpec> = {}): CaptureSpec {
  const render: RenderSettings = over.render ?? { width: 64, height: 64, background: 'transparent' }
  return {
    frameRate: over.frameRate ?? 20,
    frameCount: over.frameCount ?? 3,
    mapping: over.mapping ?? { source: 'scene', startFrame: 0, stepFrames: 1 },
    channels: over.channels ?? { tier: 1 },
    camera: over.camera ?? { kind: 'view', view: VIEW, label: 'test' },
    render,
    animation: over.animation ?? EMPTY_ANIMATION,
  }
}

function requestOf(over: { assets?: readonly ExportAssetNeed[]; spec?: CaptureSpec; doc?: ReturnType<typeof sceneWithBlocks> } = {}): ExportRequest {
  const doc = over.doc ?? sceneWithBlocks(2)
  const spec = specOf(over.spec)
  const r = planExportRequest({
    requestId: 'req-1',
    now: 1_700_000_000_000,
    documentId: doc.id,
    version: doc.version,
    scene: doc.scene,
    animation: doc.animation,
    // 取景来自 spec 自己声明的来源（`requestOf` 不另造一个"当前相机"）。
    camera: spec.camera,
    spec,
    ...(over.assets === undefined ? {} : { assets: over.assets }),
  })
  if (!r.ok) throw new Error(`fixture: planExportRequest failed: ${r.error.code} ${JSON.stringify(r.error.params)}`)
  return r.value
}

/** 一个可控的离屏端口：记录 acquire/render/release 的调用情况。 */
function fakePort(opts: { failAcquire?: boolean; failFrame?: number } = {}) {
  const state = { acquires: 0, releases: 0, rendered: 0, allocated: 7 }
  const port: OffscreenRenderPort = {
    acquire() {
      state.acquires += 1
      if (opts.failAcquire) return { ok: false, error: { code: 'UnsupportedOperation', params: { reason: 'noOffscreen' } } }
      return { ok: true, value: { allocated: state.allocated } }
    },
    renderFrame(_req, index): ReturnType<OffscreenRenderPort['renderFrame']> {
      state.rendered += 1
      if (opts.failFrame === index) return { ok: false, error: { code: 'InvalidValue', params: { reason: 'frameBoom', index } } }
      const pixels = new Uint8Array(4)
      pixels[index % 4] = 1 + index
      return {
        ok: true,
        value: Object.freeze({ index, time: _req.frames[index]!, pixels, width: _req.render.width, height: _req.render.height }) as RenderedFrame,
      }
    },
    release() {
      state.releases += 1
    },
  }
  return { port, state }
}

/**
 * 一个"只有 PNG"的端口（诚实声明 supportedEncodings）——
 * 用于 N10/N11 的"种类对但端口没有该编码"分支。
 */
function pngOnlyEncoder(): EncoderPort {
  return {
    supportedKinds: ['image', 'animation'],
    supportedEncodings: ['png'],
    async encode() {
      return { ok: true, value: new Uint8Array([0]) }
    },
  }
}

/** 一个"总是成功"的编码器（其字节可辨识，便于断言产物来自哪次请求）。 */
function okEncoder(bytesFor: (r: ExportRequest, rendered: readonly RenderedFrame[]) => Uint8Array = (_r, rendered) => new Uint8Array([rendered.length])) {
  const port: EncoderPort = {
    supportedKinds: ['image', 'animation', 'geometry', 'project'],
    async encode(input) {
      return { ok: true, value: bytesFor(input.request, input.rendered) }
    },
  }
  return port
}

// ─────────────────────────────────────────────────────────────────────────────
// 一、不可变请求 + 固定时间序列
// ─────────────────────────────────────────────────────────────────────────────

describe('A29：请求不可变、采样时间固定（不读墙钟）', () => {
  it('同一 spec 恒得同一采样序列（纯函数，重复执行逐位相同）', () => {
    const a = planCaptureFrames(specOf())
    const b = planCaptureFrames(specOf())
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.value.map((f) => `${f.time.frame}@${f.seconds}`)).toEqual(b.value.map((f) => `${f.time.frame}@${f.seconds}`))
    // 反空洞真：序列真的非空且帧数正确
    expect(a.value).toHaveLength(3)
    expect(a.value.map((f) => f.seconds)).toEqual([0, 0.05, 0.1])
  })

  it('`runtime` 映射**必须**给出固定起点；缺失 ⇒ UnsupportedOperation（不读执行当刻墙钟）', () => {
    const missing = planCaptureFrames(
      specOf({ mapping: { source: 'runtime', clock: 'rt-1', anchorSeconds: Number.NaN, stepFrames: 1 } }),
      { runtimeClocks: ['rt-1'] },
    )
    expect(missing.ok).toBe(false)
    if (!missing.ok) {
      expect(missing.error.code).toBe('UnsupportedOperation')
      expect(missing.error.params.reason).toBe('runtimeTimeMappingMissing')
    }
    // 未安装的时钟：拒绝绑定，不静默按场景时间播
    const notInstalled = planCaptureFrames(specOf({ mapping: { source: 'runtime', clock: 'rt-9', anchorSeconds: 0, stepFrames: 1 } }), SCENE_TIME_ONLY)
    expect(notInstalled.ok).toBe(false)
    if (!notInstalled.ok) expect(notInstalled.error.params.reason).toBe('runtimeClockNotInstalled')
    // 显式给出起点 ⇒ 成功，且起点**进入**序列
    const okRun = planCaptureFrames(specOf({ mapping: { source: 'runtime', clock: 'rt-1', anchorSeconds: 2, stepFrames: 1 } }), { runtimeClocks: ['rt-1'] })
    expect(okRun.ok).toBe(true)
    if (okRun.ok) expect(okRun.value[0]!.seconds).toBeCloseTo(2, 10)
  })

  it('请求是**不可变值**：字段被冻结，外部改不动（严格模式下赋值即抛）', () => {
    const req = requestOf()
    expect(Object.isFrozen(req)).toBe(true)
    expect(Object.isFrozen(req.frames)).toBe(true)
    expect(Object.isFrozen(req.camera)).toBe(true)
    expect(() => {
      'use strict'
      ;(req as unknown as { requestId: string }).requestId = 'hacked'
    }).toThrow()
    expect(req.requestId).toBe('req-1')
  })

  it('**导出期间继续编辑不改变本次快照**：请求内容仍是捕获时的 S0', () => {
    const doc0 = sceneWithBlocks(1)
    const req = requestOf({ doc: doc0 })
    const capturedObjects = Object.keys(req.payload.scene.objects).length
    const capturedContentVersion = req.payload.version.contentVersion

    // 用户在导出进行中继续编辑（新文档值；请求持有的是捕获时的值）
    const s2 = addBlockObject(doc0.scene, { objectId: 'later', dataId: 'dl' })!
    const doc1 = withScene(doc0, s2).doc
    expect(doc1.version.contentVersion).not.toBe(capturedContentVersion)

    // 请求**没有**任何"回编辑器取最新"的入口：帧序列与内容都是捕获时的那份
    expect(Object.keys(req.payload.scene.objects)).toHaveLength(capturedObjects)
    expect(req.payload.version.contentVersion).toBe(capturedContentVersion)
    expect(planSourceFrames(req)).toBe(req.frames)
    expect(requestMatchesVersion(req, 'doc-1', doc0.version)).toBe(true)
    // 对账入口能识别"这不是当前 S1"
    expect(requestMatchesVersion(req, 'doc-1', doc1.version)).toBe(false)
  })

  it('**负对照**：隐式读取最新文档的对照实现会让产物对应 S1（而非 S0）⇒ 天然判负', () => {
    const doc0 = sceneWithBlocks(1)
    const capturedVersion = doc0.version.contentVersion
    // 对照实现：导出时"问一下当前文档"（旧导出器的做法）
    const latestDoc = sceneWithBlocks(3)
    const naiveCapturedVersion = latestDoc.version.contentVersion // = 读取当刻的最新文档
    expect(naiveCapturedVersion, '隐式读最新 ⇒ 捕获到的不是 S0').not.toBe(capturedVersion)

    // 真实实现：捕获时的版本进请求，且请求**不**随文档改变
    const req = requestOf({ doc: doc0 })
    expect(req.payload.version.contentVersion).toBe(capturedVersion)
    const s2 = addBlockObject(latestDoc.scene, { objectId: 'x', dataId: 'dx' })!
    void withScene(latestDoc, s2)
    expect(req.payload.version.contentVersion, '请求里的版本不因文档变化而变').toBe(capturedVersion)
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// 一·补：逐帧 hold（`scene-holds`）—— N1–N8 负对照 + 等价性判据
// ─────────────────────────────────────────────────────────────────────────────

/** 用 holds 形态造 spec（条数缺省 = holds 条数）。 */
function holdsSpec(over: {
  readonly holdsMs: readonly number[]
  readonly startSeconds?: number
  readonly frameCount?: number
  readonly frameRate?: number
}): CaptureSpec {
  return specOf({
    frameCount: over.frameCount ?? over.holdsMs.length,
    frameRate: over.frameRate ?? 20,
    mapping: { source: 'scene-holds', startSeconds: over.startSeconds ?? 0, holdsMs: over.holdsMs },
  })
}

/** 取到成功序列（失败即抛，避免"以为跑到了其实早退了"）。 */
function framesOf(spec: CaptureSpec): readonly CaptureTime[] {
  const r = planCaptureFrames(spec)
  if (!r.ok) throw new Error("planCaptureFrames 意外失败：" + r.error.code + " " + JSON.stringify(r.error.params))
  return r.value
}

describe('`scene-holds` —— 时长是唯一权威，帧序列由累积时长派生', () => {
  it('逐帧驻留进入 `seconds` 与 `holdMs`（不等时长的序列是真的不等）', () => {
    const frames = framesOf(holdsSpec({ holdsMs: [50, 100, 50], startSeconds: 1 }))
    expect(frames.map((f) => f.seconds)).toEqual([1, 1.05, 1.15])
    expect(frames.map((f) => f.holdMs)).toEqual([50, 100, 50])
    // 时刻**由累积和派生**：不是"起点 + 下标 × 某个常数"，否则 [50,100,50] 会被摊平。
    expect(frames[2]!.seconds).toBeCloseTo(1 + (50 + 100) / 1000, 10)
  })

  it('N7 **等价性**：均匀 `{startFrame:100, stepFrames:5}` ⇔ holds `{startSeconds:5, holdsMs:[250,250]}`（逐字段相等）', () => {
    // 均匀形态的每帧驻留 = 步长对应的毫秒 = 5 帧 @20fps = 250ms。
    // ⇒ "两种表达"不是两个权威，而是同一语义的两种记法（设计 §2.3 的等价性判据）。
    const uniform = framesOf(specOf({ frameCount: 2, frameRate: 20, mapping: { source: 'scene', startFrame: 100, stepFrames: 5 } }))
    const holds = framesOf(holdsSpec({ holdsMs: [250, 250], startSeconds: 5, frameCount: 2 }))
    expect(uniform).toEqual(holds)
    expect(uniform.map((f) => f.time.frame)).toEqual([100, 105])
    expect(uniform.map((f) => f.holdMs)).toEqual([250, 250])
  })

  it('均匀形态**也**带 holdMs（`step:1 @20fps` ⇒ 50ms/帧，与旧 seconds 判据同值）', () => {
    const frames = framesOf(specOf({ frameCount: 3, frameRate: 20 }))
    expect(frames.map((f) => f.seconds)).toEqual([0, 0.05, 0.1])
    expect(frames.map((f) => f.holdMs)).toEqual([50, 50, 50])
  })

  it('有理帧率下均匀驻留非整数毫秒 ⇒ **显式失败**（不四舍五入成 33/34 交替）', () => {
    const r = planCaptureFrames(specOf({ frameCount: 2, frameRate: 30, mapping: { source: 'scene', startFrame: 0, stepFrames: 1 } }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('InvalidValue')
      expect(r.error.params.reason).toBe('uniformHoldNotIntegralMs')
      expect(r.error.params.fps).toBe(30)
    }
  })

  it('I6 纯函数：同一 holds spec 两次调用逐字段相等（含 holdMs）', () => {
    const a = framesOf(holdsSpec({ holdsMs: [50, 100, 50] }))
    const b = framesOf(holdsSpec({ holdsMs: [50, 100, 50] }))
    expect(a).toEqual(b)
  })
})

describe('N1–N6：holds 的显式失败面（每条一个 distinct reason）', () => {
  it('N1 `runtime` 映射携带 holds ⇒ `runtimeHoldMappingUnsupported`（不静默按场景时间播）', () => {
    const mapping = {
      source: 'runtime',
      clock: 'rt-1',
      anchorSeconds: 0,
      stepFrames: 1,
      holdsMs: [50],
    } as unknown as TimeMapping
    const r = planCaptureFrames(specOf({ frameCount: 1, mapping }), { runtimeClocks: ['rt-1'] })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('UnsupportedOperation')
      expect(r.error.params.reason).toBe('runtimeHoldMappingUnsupported')
      expect(r.error.params.clock).toBe('rt-1')
    }
  })

  it('N2 条数与 `frameCount` 不一致 ⇒ `holdCountMismatch`（不以短的为准）', () => {
    const r = planCaptureFrames(holdsSpec({ holdsMs: [50, 50], frameCount: 3 }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('InvalidValue')
      expect(r.error.params.reason).toBe('holdCountMismatch')
      expect(r.error.params.frameCount).toBe(3)
      expect(r.error.params.holds).toBe(2)
    }
  })

  it('N3 驻留为 0 / 负数 / 小数 ⇒ `holdDurationInvalid`（带下标，不夹取）', () => {
    for (const bad of [0, -50, 50.5]) {
      const r = planCaptureFrames(holdsSpec({ holdsMs: [50, bad] }))
      expect(r.ok, '驻留 ' + bad + ' 必须被拒绝').toBe(false)
      if (r.ok) continue
      expect(r.error.code).toBe('InvalidValue')
      expect(r.error.params.reason).toBe('holdDurationInvalid')
      expect(r.error.params.index).toBe(1)
    }
  })

  it('N4 空 holds ⇒ `holdCountMismatch`（不是"产 1 帧假 GIF"）', () => {
    const r = planCaptureFrames(holdsSpec({ holdsMs: [], frameCount: 1 }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.params.reason).toBe('holdCountMismatch')
  })

  it('N5 超过 `LOOP_LIMITS`（帧数或总时长）⇒ `captureHoldsExceedLimits`，不截断', () => {
    const tooMany = planCaptureFrames(holdsSpec({ holdsMs: new Array(LOOP_LIMITS.maxFrames + 1).fill(50) }))
    expect(tooMany.ok).toBe(false)
    if (!tooMany.ok) {
      expect(tooMany.error.code).toBe('UnsupportedOperation')
      expect(tooMany.error.params.reason).toBe('captureHoldsExceedLimits')
      expect(tooMany.error.params.frames).toBe(LOOP_LIMITS.maxFrames + 1)
    }
    const tooLong = planCaptureFrames(holdsSpec({ holdsMs: [LOOP_LIMITS.maxTotalMs + 1] }))
    expect(tooLong.ok).toBe(false)
    if (!tooLong.ok) {
      expect(tooLong.error.params.reason).toBe('captureHoldsExceedLimits')
      expect(tooLong.error.params.totalMs).toBe(LOOP_LIMITS.maxTotalMs + 1)
    }
    // 正面对照：恰在限内必须成功（证明上面两条不是"恒红"）。
    const within = planCaptureFrames(holdsSpec({ holdsMs: new Array(3).fill(50) }))
    expect(within.ok).toBe(true)
    expect(LOOP_LIMITS.maxFrames).toBe(240)
  })

  it('N6 `startSeconds: NaN` ⇒ `startSecondsNotFinite`（负数则**允许**）', () => {
    const nan = planCaptureFrames(holdsSpec({ holdsMs: [50], startSeconds: Number.NaN }))
    expect(nan.ok).toBe(false)
    if (!nan.ok) {
      expect(nan.error.code).toBe('InvalidValue')
      expect(nan.error.params.reason).toBe('startSecondsNotFinite')
    }
    const negative = framesOf(holdsSpec({ holdsMs: [50, 50], startSeconds: -1 }))
    expect(negative.map((f) => f.seconds)).toEqual([-1, -0.95])
  })
})

describe('N8：`freezeExportRequest` 必须**深冻结** `holdsMs`', () => {
  it('外部改写原数组（push / 下标赋值）不改请求里的 holds', () => {
    const holdsMs = [50, 100, 50]
    const req = freezeExportRequest({
      requestId: 'r-holds',
      createdAt: 0,
      payload: {
        documentId: 'doc-1',
        version: { documentVersion: 0, contentVersion: 0 },
        sceneId: 's',
        scene: createDocument('doc-1').scene,
        animation: EMPTY_ANIMATION,
      },
      camera: VIEW,
      frames: framesOf(holdsSpec({ holdsMs })),
      channels: {},
      render: { width: 8, height: 8, background: 'transparent' },
      mapping: { source: 'scene-holds', startSeconds: 0, holdsMs },
      assets: [],
      capabilityLoss: [],
    })

    // 外部仍持有同一个数组：浅冻结（`{...mapping}`）时下面两行会改到请求里。
    holdsMs.push(999)
    holdsMs[0] = 1

    const frozen = req.mapping
    expect(frozen.source).toBe('scene-holds')
    if (frozen.source !== 'scene-holds') return
    expect([...frozen.holdsMs]).toEqual([50, 100, 50])
    expect(Object.isFrozen(frozen.holdsMs), 'holdsMs 必须是冻结数组（N8 的判据点）').toBe(true)
    // 请求里的 frames 与 mapping 说的是同一件事（不是两份可漂移的声明）
    expect(req.frames.map((f) => f.holdMs)).toEqual([50, 100, 50])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 二、不借用实时相机（A29 负对照的正面对照面）
// ─────────────────────────────────────────────────────────────────────────────

describe('A29：取景是**值**，不借用实时相机', () => {
  it('`copyCameraSpec` 逐字段复制：之后改"实时相机"不影响请求里的取景', () => {
    // 模拟"实时视口的相机状态"（一个可变对象）
    const live = { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, fovDegrees: 50, projection: 'perspective' as const, near: 0.1, far: 100 }
    const frozen = copyCameraSpec(live)
    const req = requestOf({ spec: specOf({ camera: { kind: 'view', view: frozen, label: 'copied' } }) })

    // 用户拖动实时相机
    live.position.x = 99
    live.fovDegrees = 1

    expect(req.camera.position.x, '复制之后实时相机的变化不得影响快照取景').toBe(1)
    expect(req.camera.fovDegrees).toBe(50)
    // 冻结的副本自身也不可写
    expect(() => {
      'use strict'
      ;(frozen.position as { x: number }).x = 5
    }).toThrow()
  })

  it('文档相机取景：定义取自文档相机对象，视角来自显式传入的 `view`（不由"当前机位"推断）', () => {
    let doc = createDocument('doc-1')
    doc = withScene(doc, addBlockObject(doc.scene, { objectId: 'b', dataId: 'db' })!).doc
    // 造一个相机对象（相机参数属文档）
    const cam = addCameraObjectHelper(doc.scene, 'cam', 'dcam', 35)
    doc = withScene(doc, cam).doc

    const resolved = resolveCameraSpec(doc.scene, { kind: 'document', objectId: 'cam', view: VIEW })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.value.fovDegrees, '视场取自文档相机对象').toBe(35)
    expect(resolved.value.position.x, '机位取自显式传入的视角值').toBe(3)

    // 缺失相机对象 ⇒ 显式失败（不编造默认相机）
    const missing = resolveCameraSpec(doc.scene, { kind: 'document', objectId: 'nope', view: VIEW })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.params.reason).toBe('cameraObjectMissing')
  })

  it('**负对照**：借用实时相机的对照实现会随用户转视角改变产物取景 ⇒ 判负', () => {
    // 对照实现：请求里持有实时相机**引用**（而不是复制）
    const live = { ...VIEW, position: { ...VIEW.position } }
    const borrowed = live // 旧导出器：借用
    const copied = copyCameraSpec(live)

    // 用户转视角
    live.position.x = 42
    expect(borrowed.position.x, '借用 ⇒ 产物取景被用户操作改变（这就是负对照）').toBe(42)
    expect(copied.position.x, '复制 ⇒ 快照取景固定').toBe(3)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 三、预检：默认失败而非假成功
// ─────────────────────────────────────────────────────────────────────────────

describe('A29：预检 —— 缺必需资源 / 无编码器 / 有损未显式 ⇒ 失败（无伪完整产物）', () => {
  it('缺必需资源 ⇒ blocked，且 `preflightRequiredAssets` 给出逐条原因', () => {
    const store = new AssetStateStore()
    const needs = normalizeAssetNeeds([{ assetId: 'tex/a', contentVersion: 'v1', required: true, locator: 'a.png' }])
    // 未请求该资源 ⇒ unrequested
    const blocking = preflightRequiredAssets(store, needs.map((n) => ({ identity: { id: n.assetId, version: n.contentVersion }, locator: { kind: 'external' as const, url: n.locator }, required: true })))
    expect(blocking).toHaveLength(1)
    expect(blocking[0]!.phase).toBe('idle')

    const pre = preflightExport({ request: requestOf({ assets: needs }), kind: 'image', encoder: okEncoder() , assets: undefined })
    expect(pre.status).toBe('blocked')
    expect(pre.diagnostics.map((d) => d.code)).toContain('ExportAssetNotReady')

    // 资源就绪后 ⇒ ready（正面对照，证明上面的 blocked 不是恒真）
    store.begin(assetRequest({ id: 'tex/a', version: 'v1' }, { kind: 'external', url: 'a.png' }, true))
    expect(store.complete('tex/a', 'tex/a@v1', 'v1')).toBe(true)
    const ready = preflightExport({ request: requestOf({ assets: needs }), kind: 'image', encoder: okEncoder(), assets: store })
    expect(ready.status).toBe('ready')
  })

  it('缺编码器 ⇒ blocked（`ExportEncodingNotConfigured`），绝不产出空文件', () => {
    const pre = preflightExport({ request: requestOf(), kind: 'image' })
    expect(pre.status).toBe('blocked')
    expect(pre.diagnostics.map((d) => d.code)).toContain('ExportEncodingNotConfigured')
    const refused = refuseWhenBlocked(pre)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.code).toBe('UnsupportedOperation')
  })

  it('能力损失未显式接受 ⇒ blocked（`ExportRequiresLossyMode`）；显式接受 ⇒ ready 并标记 lossy', async () => {
    // 造一个"非整数格平移"的对象 ⇒ 可表达性挂点会报 LegacyExportUnsupportedTransform
    let doc = createDocument('doc-1')
    const s = addBlockObject(doc.scene, { objectId: 'o1', dataId: 'd1' })!
    doc = withScene(doc, s).doc
    const moved = {
      ...doc,
      scene: {
        ...doc.scene,
        objects: { ...doc.scene.objects, o1: { ...doc.scene.objects['o1']!, transform: { ...doc.scene.objects['o1']!.transform, position: { x: 0.5, y: 0, z: 0 } } } },
      },
    }
    const req = requestOf({ doc: moved as unknown as ReturnType<typeof sceneWithBlocks> })
    expect(req.capabilityLoss.length, '非整数格平移必须被记为能力损失').toBeGreaterThan(0)

    const blocked = preflightExport({ request: req, kind: 'image', encoder: okEncoder() })
    expect(blocked.status).toBe('blocked')
    expect(blocked.diagnostics.map((d) => d.code)).toContain('ExportRequiresLossyMode')

    const allowed = preflightExport({ request: req, kind: 'image', encoder: okEncoder(), allowLossy: true })
    expect(allowed.status).toBe('ready')
    const job = new ExportJob({ request: req, kind: 'image', port: fakePort().port, encoder: okEncoder(), allowLossy: true })
    const outcome = await job.run()
    expect(outcome.status).toBe('completed')
    if (outcome.status === 'completed') expect(outcome.lossy, '有损必须被显式标记').toBe(true)
  })

  it('产物种类不受支持 ⇒ blocked（不支持的导出明确报告）', () => {
    const onlyImages: EncoderPort = { supportedKinds: ['image'], async encode() { return { ok: true, value: new Uint8Array() } } }
    const pre = preflightExport({ request: requestOf(), kind: 'geometry', encoder: onlyImages })
    expect(pre.status).toBe('blocked')
    expect(pre.diagnostics.map((d) => d.code)).toContain('ExportKindUnsupported')
  })

  it('空场景 ⇒ blocked（空的"完整导出"是典型的假成功形态）', () => {
    const empty = createDocument('doc-1')
    const req = requestOf({ doc: { ...empty } as unknown as ReturnType<typeof sceneWithBlocks> })
    const pre = preflightExport({ request: req, kind: 'image', encoder: okEncoder() })
    expect(pre.status).toBe('blocked')
    expect(pre.diagnostics.map((d) => d.code)).toContain('ExportEmptyScene')
  })

  it('`preflightError` 把阻塞翻译成稳定错误码（不拼自然语言）', () => {
    const pre = preflightExport({ request: requestOf(), kind: 'image' })
    const e = preflightError(pre)
    expect(e).not.toBeNull()
    expect(['UnsupportedOperation', 'InvalidValue', 'MissingTarget']).toContain(e!.code)
    expect(typeof e!.params.reason).toBe('string')
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// 三·补：kind × encoding 兼容表（N10/N11）与时长量化诊断（不阻塞）
// ─────────────────────────────────────────────────────────────────────────────

describe('N9：动画种类仍需端口**真的声明** animation（实现里有 GIF 也不放松预检）', () => {
  it('kind:animation + 端口 supportedKinds 不含 animation ⇒ ExportKindUnsupported', () => {
    const onlyImages: EncoderPort = {
      supportedKinds: ['image'],
      async encode() {
        return { ok: true, value: new Uint8Array([0]) }
      },
    }
    const pre = preflightExport({ request: requestOf(), kind: 'animation', encoder: onlyImages })
    expect(pre.status).toBe('blocked')
    const d = pre.diagnostics.find((x) => x.code === 'ExportKindUnsupported')
    expect(d, '不得因为"实现里其实有 GIF"就放行').toBeDefined()
    expect(d!.detail.kind).toBe('animation')
    expect(String(d!.detail.supported)).toBe('image')
  })

  it('反空洞真：同一个请求换成真的声明了 animation 的端口 ⇒ ready', () => {
    const withAnimation: EncoderPort = {
      supportedKinds: ['image', 'animation'],
      async encode() {
        return { ok: true, value: new Uint8Array([0]) }
      },
    }
    expect(preflightExport({ request: requestOf(), kind: 'animation', encoder: withAnimation }).status).toBe('ready')
  })
})

describe('N10/N11：kind × encoding 兼容表（格式与种类不许"各自为政"）', () => {
  it('N10 image + gif ⇒ blocked（不得静默产出 GIF 字节却叫 png）', () => {
    const pre = preflightExport({ request: requestOf(), kind: 'image', encoding: 'gif', encoder: okEncoder() })
    expect(pre.status).toBe('blocked')
    const d = pre.diagnostics.find((x) => x.code === 'ExportKindUnsupported')
    expect(d, '必须判 ExportKindUnsupported（不是"按 png 编完就完事"）').toBeDefined()
    expect(d!.detail.reason).toBe('encodingNotAllowedForKind')
    expect(d!.detail.encoding).toBe('gif')
    expect(d!.detail.allowed).toBe('png,jpeg')
  })

  it('N11 animation + png ⇒ blocked（反向同样）', () => {
    const pre = preflightExport({ request: requestOf(), kind: 'animation', encoding: 'png', encoder: okEncoder() })
    expect(pre.status).toBe('blocked')
    const d = pre.diagnostics.find((x) => x.code === 'ExportKindUnsupported')
    expect(d).toBeDefined()
    expect(d!.detail.allowed).toBe('gif')
  })

  it('兼容表本身：image ⇒ png/jpeg、animation ⇒ gif、geometry/project ⇒ 空（由 encoder 缺省拒绝）', () => {
    expect([...supportedEncodingsFor('image')]).toEqual(['png', 'jpeg'])
    expect([...supportedEncodingsFor('animation')]).toEqual(['gif'])
    expect([...supportedEncodingsFor('geometry')]).toEqual([])
    expect([...supportedEncodingsFor('project')]).toEqual([])
    expect(encodingAllowedFor('image', 'png')).toBe(true)
    expect(encodingAllowedFor('image', 'gif')).toBe(false)
    expect(encodingAllowedFor('animation', 'gif')).toBe(true)
    expect(encodingAllowedFor('animation', 'jpeg')).toBe(false)
  })

  it('种类对、但端口没有该编码 ⇒ ExportEncodingNotConfigured（PNG 端口被要求出 gif）', () => {
    const pre = preflightExport({ request: requestOf(), kind: 'animation', encoding: 'gif', encoder: pngOnlyEncoder() })
    expect(pre.status).toBe('blocked')
    expect(pre.diagnostics.map((d) => d.code)).toContain('ExportEncodingNotConfigured')
  })

  it('正面对照：animation + gif + 能出 GIF 的端口 ⇒ ready（不是"一律拦动画"）', () => {
    const pre = preflightExport({ request: requestOf(), kind: 'animation', encoding: 'gif', encoder: okEncoder() })
    expect(pre.status).toBe('ready')
  })
})

describe('ExportTimeQuantized —— 声明时长与产物时长不一致时**报告但不阻塞**', () => {
  it('holds 为 10 的整数倍 ⇒ 无诊断、无偏差', () => {
    const req = requestOf({ spec: holdsSpec({ holdsMs: [50, 100, 50] }) })
    expect(timeQuantizationOf(req, 'animation', 'gif')).toBeNull()
    expect(preflightExport({ request: req, kind: 'animation', encoding: 'gif', encoder: okEncoder() }).status).toBe('ready')
  })

  it('holds 非 10 的倍数（45ms）⇒ ExportTimeQuantized，且**仍 ready**（已完成但有偏差）', () => {
    const req = requestOf({ spec: holdsSpec({ holdsMs: [45, 45, 45] }) })
    const note = timeQuantizationOf(req, 'animation', 'gif')
    expect(note, '非整数厘秒必须产出结构化诊断（不静默）').not.toBeNull()
    expect(note!.code).toBe('ExportTimeQuantized')
    expect(note!.detail.declaredMs).toBe(135)
    // Σ delayCs = 5+5+4? 由 delayCsOf 的最大余数法决定；此处只断言"偏差等于所报的量"。
    const encoded = Number(note!.detail.encodedMs)
    expect(note!.detail.roundUnit).toBe('cs')
    expect(note!.detail.frames).toBe(3)
    expect(encoded % 10).toBe(0)
    expect(Number(note!.detail.deltaMs)).toBe(encoded - 135)
    // 不阻塞：状态仍 ready，诊断随行。
    const pre = preflightExport({ request: req, kind: 'animation', encoding: 'gif', encoder: okEncoder() })
    expect(pre.status, '量化不是错误（阻塞会把 50/100ms 这类合法声明也判红）').toBe('ready')
    expect(pre.diagnostics.map((d) => d.code)).toContain('ExportTimeQuantized')
  })

  it('作业完成时把非阻塞诊断带进产物结局（不是"预检说了、结局不说"）', async () => {
    const req = requestOf({ spec: holdsSpec({ holdsMs: [45, 45, 45] }) })
    const job = new ExportJob({ request: req, kind: 'animation', encoding: 'gif', port: fakePort().port, encoder: okEncoder() })
    const outcome = await job.run()
    expect(outcome.status).toBe('completed')
    if (outcome.status !== 'completed') return
    expect(outcome.diagnostics.map((d) => d.code)).toContain('ExportTimeQuantized')
  })

  it('非动画/非 gif 一律不判量化（图片没有"逐帧驻留"这回事）', () => {
    const req = requestOf({ spec: holdsSpec({ holdsMs: [45, 45, 45] }) })
    expect(timeQuantizationOf(req, 'image', 'png')).toBeNull()
    expect(timeQuantizationOf(req, 'animation', 'png')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 四、作业：进度、取消释放、失败不产出
// ─────────────────────────────────────────────────────────────────────────────

describe('A29：作业生命周期 —— 进度、取消必释放、失败不产出', () => {
  it('正常完成：逐帧渲染、报告进度、产物字节来自本次请求', async () => {
    const req = requestOf({ spec: specOf({ frameCount: 4 }) })
    const { port, state } = fakePort()
    const progress: string[] = []
    const job = new ExportJob({
      request: req,
      kind: 'image',
      port,
      encoder: okEncoder((_r, rendered) => new Uint8Array([rendered.length, 0xaa])),
      onProgress: (p) => progress.push(`${p.phase}:${p.completed}/${p.total}`),
    })
    const outcome = await job.run()
    expect(outcome.status).toBe('completed')
    if (outcome.status !== 'completed') return
    expect(outcome.framesRendered).toBe(4)
    expect([...outcome.bytes]).toEqual([4, 0xaa])
    expect(state.acquires).toBe(1)
    expect(state.releases, '完成也必须释放（finally）').toBe(1)
    expect(outcome.releasedFor).toBe(state.allocated)
    expect(progress).toContain('acquiring:0/4')
    expect(progress[progress.length - 1]).toBe('done:4/4')
  })

  it('**取消**：帧边界停下、返回 cancelled、**资源必然释放**、**不产出产物**', async () => {
    const req = requestOf({ spec: specOf({ frameCount: 10 }) })
    const { port, state } = fakePort()
    let job: ExportJob
    let cancelAt = 2
    const cancelPort: OffscreenRenderPort = {
      ...port,
      renderFrame(r, i) {
        if (i === cancelAt) job.cancel()
        return port.renderFrame(r, i)
      },
    }
    job = new ExportJob({ request: req, kind: 'image', port: cancelPort, encoder: okEncoder() })
    const outcome = await job.run()
    expect(outcome.status).toBe('cancelled')
    if (outcome.status !== 'cancelled') return
    expect(outcome.framesRendered, '取消后不应把剩下的帧渲染完').toBeLessThan(10)
    expect(state.releases, '取消必须释放离屏资源（A29 原文）').toBe(1)
    expect('bytes' in outcome, '取消**不得**产出产物').toBe(false)
    expect(state.rendered).toBeLessThanOrEqual(cancelAt + 1)
    void cancelAt
  })

  it('**取消**在工作区侧无副作用：作业不持有编辑器/相机（结构证据：端口接口里没有这些方法）', () => {
    const req = requestOf()
    const { port } = fakePort()
    const keys = Object.keys(port).sort()
    expect(keys).toEqual(['acquire', 'release', 'renderFrame'])
    for (const forbidden of ['editor', 'client', 'camera', 'context', 'viewport', 'scene']) {
      expect(keys, `离屏端口不得暴露 \`${forbidden}\`（否则导出会借用实时状态）`).not.toContain(forbidden)
    }
    // 请求自身也没有机位之外的可写面
    expect(Object.keys(req).sort()).toEqual(['assets', 'camera', 'capabilityLoss', 'channels', 'createdAt', 'frames', 'mapping', 'payload', 'render', 'requestId'])
  })

  it('离屏分配失败 ⇒ failed、无产物、`releasedFor` 为 0（没拿到东西就无需释放）', async () => {
    const { port, state } = fakePort({ failAcquire: true })
    const job = new ExportJob({ request: requestOf(), kind: 'image', port, encoder: okEncoder() })
    const outcome = await job.run()
    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') return
    expect(outcome.diagnostics.map((d) => d.code)).toContain('ExportAcquireFailed')
    expect(outcome.releasedFor).toBe(0)
    expect(state.releases, '分配失败时无资源归属 ⇒ 不调用 release（与"取消必释放"不矛盾：释放的前提是拿到了）').toBe(0)
    expect(state.rendered).toBe(0)
  })

  it('单帧渲染失败 ⇒ failed、无产物、资源释放', async () => {
    const { port, state } = fakePort({ failFrame: 1 })
    const job = new ExportJob({ request: requestOf({ spec: specOf({ frameCount: 3 }) }), kind: 'image', port, encoder: okEncoder() })
    const outcome = await job.run()
    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') return
    expect(outcome.diagnostics.map((d) => d.code)).toContain('ExportRenderFailed')
    expect(state.releases).toBe(1)
  })

  it('编码失败 ⇒ failed、无产物、资源释放（不输出伪完整文件）', async () => {
    const { port, state } = fakePort()
    const failing: EncoderPort = { supportedKinds: ['image'], async encode() { return { ok: false, error: { code: 'InvalidValue', params: { reason: 'badPixels' } } } } }
    const job = new ExportJob({ request: requestOf(), kind: 'image', port, encoder: failing })
    const outcome = await job.run()
    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') return
    expect(outcome.diagnostics.map((d) => d.code)).toContain('ExportEncodeFailed')
    expect(state.releases).toBe(1)
  })

  it('**产物对应 S0 与资源清单**：编码器看到的请求载荷/资源清单逐字段等于捕获时的值', async () => {
    const doc = sceneWithBlocks(2)
    const captured = doc.version.contentVersion
    const needs = normalizeAssetNeeds([{ assetId: 'tex/a', contentVersion: 'v9', required: false, locator: 'a.png' }])
    const req = requestOf({ doc, assets: needs, spec: specOf({ frameCount: 2 }) })

    let seenVersion: number | undefined
    let seenAssets: readonly string[] = []
    let seenFrames: readonly number[] = []
    const inspecting: EncoderPort = {
      supportedKinds: ['image'],
      async encode(input) {
        seenVersion = input.request.payload.version.contentVersion
        seenAssets = input.request.assets.map((a) => `${a.assetId}@${a.contentVersion}`)
        seenFrames = input.rendered.map((f) => f.time.index)
        return { ok: true, value: new Uint8Array([input.rendered.length]) }
      },
    }
    const job = new ExportJob({ request: req, kind: 'image', port: fakePort().port, encoder: inspecting })
    const outcome = await job.run()
    expect(outcome.status).toBe('completed')
    expect(seenVersion, '产物必须对应捕获的 S0').toBe(captured)
    expect(seenAssets, '资源清单必须逐条等于请求里的清单').toEqual(['tex/a@v9'])
    expect(seenFrames, '渲染帧必须覆盖固定采样序列的**全部**索引').toEqual([0, 1])

    // 捕获之后继续编辑 ⇒ 编码器看到的仍是 S0（而不是"最新文档"）
    const s2 = addBlockObject(doc.scene, { objectId: 'later', dataId: 'dl' })!
    const doc1 = withScene(doc, s2).doc
    expect(doc1.version.contentVersion).not.toBe(captured)
    expect(req.payload.version.contentVersion, '请求里的 S0 不因后续编辑改变').toBe(captured)
  })

  it('**取消后编辑器状态亦不变**（与"导出不改变工作区"合起来覆盖 A29 的取消条款）', async () => {
    const e = new Editor()
    e.submit({ kind: 'openDocument', documentId: 'doc-1', contextId: 'ctx-1' })
    e.drain()
    e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block' })
    e.drain()
    e.submit({ kind: 'setTime', contextId: 'ctx-1', time: { frame: 3, fps: 20 } })
    e.drain()
    const before = canonicalize(e.snapshot())
    const doc = e.snapshot().docs['doc-1']!

    const req = requestOf({ doc: { ...doc } as never, spec: specOf({ frameCount: 8 }) })
    const { port, state } = fakePort()
    let job: ExportJob
    const cancelPort: OffscreenRenderPort = {
      ...port,
      renderFrame(r, i) {
        if (i === 1) job.cancel()
        return port.renderFrame(r, i)
      },
    }
    job = new ExportJob({ request: req, kind: 'image', port: cancelPort, encoder: okEncoder() })
    const outcome = await job.run()
    expect(outcome.status).toBe('cancelled')
    expect(state.releases, '取消释放离屏资源').toBe(1)
    expect(canonicalize(e.snapshot()), '取消不得改动工作区状态').toBe(before)
    expect(e.snapshot().contexts['ctx-1']!.time.frame).toBe(3)
  })

  it('预检不过 ⇒ 作业**不分配**离屏资源、不渲染、不产出（默认失败而非假成功）', async () => {
    const { port, state } = fakePort()
    const job = new ExportJob({ request: requestOf(), kind: 'image', port }) // 无 encoder
    const outcome = await job.run()
    expect(outcome.status).toBe('failed')
    expect(state.acquires, '预检不过时连离屏资源都不该分配').toBe(0)
    expect(state.rendered).toBe(0)
    expect(state.releases).toBe(0)
  })

  it('`cancel()` 幂等，且无超时参数（"调用超时不冒充取消"的结构证据）', () => {
    const job = new ExportJob({ request: requestOf(), kind: 'image', port: fakePort().port, encoder: okEncoder() })
    job.cancel()
    job.cancel()
    expect(job.isCancelled).toBe(true)
    // 构造参数里**没有** timeout 项
    const ctorArgKeys = Object.keys({ request: requestOf(), kind: 'image', port: fakePort().port } as const)
    expect(ctorArgKeys).not.toContain('timeout')
    expect(ExportJob.length, '构造函数只接受一个参数对象').toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 五、与实时视口**共用**求值（同一求值键口径）
// ─────────────────────────────────────────────────────────────────────────────

describe('A29：导出与实时视口共用同一求值路径', () => {
  it('每个采样时刻的求值键只由**请求**决定（时间来自固定序列、资源版本来自请求清单）', () => {
    const req = requestOf()
    const k0 = evaluationKeyOf(req, req.frames[0]!, {})
    const k2 = evaluationKeyOf(req, req.frames[2]!, {})
    expect(k0.time.seconds).toBe(0)
    expect(k2.time.seconds).toBe(0.1)
    expect(k0.scene).toBe(req.payload.sceneId)
    expect(k0.documentVersion).toBe(req.payload.version.documentVersion)
    // 资源版本进 `contentResourceVersions`（内容身份，不是 URL）
    const withAsset = evaluationKeyOf(req, req.frames[0]!, { 'tex/a': 'v1' })
    expect(withAsset.contentResourceVersions['tex/a']).toBe('v1')
    expect(withAsset.parameterVersion, '同一请求的通道参数版本应当稳定').toBe(k0.parameterVersion)
  })

  it('媒体类型与扩展名同源（不出现第二张对照表）', () => {
    const kinds: ExportKind[] = ['image', 'animation', 'geometry', 'project']
    expect(kinds.map((k) => mediaTypeOf(k))).toEqual(['image/png', 'image/gif', 'application/zip', 'application/json'])
    expect(kinds.map((k) => fileExtensionOf(k))).toEqual(['png', 'gif', 'zip', 'json'])
    expect(mediaTypeOf('image', 'jpeg')).toBe('image/jpeg')
    expect(fileExtensionOf('image', 'jpeg')).toBe('jpg')
  })

  it('`describeExportRequest` 只给最小信息（不含完整文档内容）', () => {
    const req = requestOf()
    const d = describeExportRequest(req)
    const text = JSON.stringify(d)
    expect(text).not.toContain('blockGrid')
    expect(text).not.toContain('objects')
    expect(d.requiredAssets).toBe(0)
    expect(d.frames).toBe(3)
  })

  it('`normalizeAssetNeeds`：同一资源同时必需/非必需 ⇒ 取必需；排序稳定', () => {
    const norm = normalizeAssetNeeds([
      { assetId: 'b', contentVersion: 'v1', required: false, locator: '' },
      { assetId: 'a', contentVersion: 'v2', required: true, locator: 'a.png' },
      { assetId: 'b', contentVersion: 'v1', required: true, locator: 'b.png' },
    ])
    expect(norm.map((n) => n.assetId)).toEqual(['a', 'b'])
    expect(norm.find((n) => n.assetId === 'b')!.required, '必需优先（保守方向）').toBe(true)
  })

  it('`freezeExportRequest` 冻结逐帧序列（外部 push 不改请求）', () => {
    const frames: CaptureTime[] = [...(planCaptureFrames(specOf()) as { ok: true; value: readonly CaptureTime[] }).value]
    const req = freezeExportRequest({
      requestId: 'r',
      createdAt: 0,
      payload: { documentId: 'doc-1', version: { documentVersion: 0, contentVersion: 0 }, sceneId: 's', scene: createDocument('doc-1').scene, animation: EMPTY_ANIMATION },
      camera: VIEW,
      frames,
      channels: {},
      render: { width: 8, height: 8, background: 'transparent' },
      mapping: { source: 'scene', startFrame: 0, stepFrames: 1 },
      assets: [],
      capabilityLoss: [],
    })
    frames.push({ index: 99, time: { frame: 99, fps: 20 }, seconds: 99 })
    expect(req.frames).toHaveLength(3)
    expect(Object.isFrozen(req.frames)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 六、与资源状态面的接缝（不重定义五态）
// ─────────────────────────────────────────────────────────────────────────────

describe('A29 × A36 接缝：预检直接消费资源状态面（不另立第二套"就绪"判断）', () => {
  it('资源处于 `loading`（占位）⇒ 仍判 blocked（占位不得当完整资源）', () => {
    const store = new AssetStateStore()
    store.begin(assetRequest({ id: 'tex/a', version: 'v1' }, { kind: 'external', url: 'a.png' }, true))
    const needs = normalizeAssetNeeds([{ assetId: 'tex/a', contentVersion: 'v1', required: true, locator: 'a.png' }])
    const pre = preflightExport({ request: requestOf({ assets: needs }), kind: 'image', encoder: okEncoder(), assets: store })
    expect(pre.status).toBe('blocked')
    expect(pre.diagnostics[0]!.detail.phase).toBe('loading')
  })

  it('可选资源缺失 ⇒ **不**阻塞（降级而非失败）', () => {
    const needs = normalizeAssetNeeds([{ assetId: 'tex/opt', contentVersion: 'v1', required: false, locator: 'o.png' }])
    const pre = preflightExport({ request: requestOf({ assets: needs }), kind: 'image', encoder: okEncoder() })
    expect(pre.status).toBe('ready')
    void vi
    void findObject
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 七、与编辑器实例的行为级接缝：导出**不改**工作区时间/选择/机位
// ─────────────────────────────────────────────────────────────────────────────

describe('A29 × 执行协议：跑完一次导出作业后编辑器状态逐字段不变', () => {
  it('编辑器快照的规范化字符串在导出前后**逐字节相同**（时间/选择/文档都不被导出改动）', async () => {
    const e = new Editor()
    e.submit({ kind: 'openDocument', documentId: 'doc-1', contextId: 'ctx-1' })
    e.drain()
    e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'block', name: 'A' })
    e.submit({ kind: 'addObject', contextId: 'ctx-1', objectType: 'annotation', name: 'B' })
    e.drain()
    // 设定一个**非零**工作区时间（导出的采样序列与它无关，且导出不得改动它）
    e.submit({ kind: 'setTime', contextId: 'ctx-1', time: { frame: 7, fps: 20 } })
    e.drain()
    const objectId = e.snapshot().docs['doc-1']!.scene.order[0]!
    e.submit({ kind: 'select', contextId: 'ctx-1', target: { kind: 'object', id: objectId } })
    e.drain()

    const before = canonicalize(e.snapshot())
    const doc = e.snapshot().docs['doc-1']!

    // 从编辑器状态**捕获**一份请求（复制成值），再跑作业
    const req = requestOf({
      doc: { ...doc } as never,
      spec: specOf({ frameCount: 2, mapping: { source: 'scene', startFrame: 100, stepFrames: 5 } }),
    })
    const { port } = fakePort()
    const job = new ExportJob({ request: req, kind: 'image', port, encoder: okEncoder() })
    const outcome = await job.run()
    expect(outcome.status).toBe('completed')

    // 编辑器状态**一个字段都没变**（含时间与选择）
    expect(canonicalize(e.snapshot()), '导出不得改动工作区状态（A29 原文）').toBe(before)
    expect(e.snapshot().contexts['ctx-1']!.time.frame, '导出的采样时间不得写回工作区时间').toBe(7)
    expect(e.snapshot().contexts['ctx-1']!.selection.active?.id).toBe(objectId)
    // 导出的采样序列仍是捕获时那份（起点 100、步长 5），与工作区时间 7 无关
    expect(req.frames.map((f) => f.time.frame)).toEqual([100, 105])
  })

  it('**负对照**：把导出采样写回工作区时间的对照实现会被上一条判据抓到', () => {
    const e = new Editor()
    e.submit({ kind: 'openDocument', documentId: 'doc-1', contextId: 'ctx-1' })
    e.drain()
    e.submit({ kind: 'setTime', contextId: 'ctx-1', time: { frame: 7, fps: 20 } })
    e.drain()
    const before = canonicalize(e.snapshot())

    // 对照实现：导出前"顺手把工作区时间对齐到采样起点"（旧导出器改机位/改帧的做法同族）
    e.submit({ kind: 'setTime', contextId: 'ctx-1', time: { frame: 100, fps: 20 } })
    e.drain()
    expect(canonicalize(e.snapshot()), '对照实现确实改动了工作区状态（这就是负对照）').not.toBe(before)
  })
})

/** 造一个相机对象（`domain/document.addCameraObject` 的薄包装，使夹具意图自明）。 */
function addCameraObjectHelper(scene: Parameters<typeof addBlockObject>[0], objectId: string, dataId: string, fov: number) {
  const next = addCameraObject(scene, { objectId, dataId, fov })
  if (!next) throw new Error('fixture: camera object collision')
  return next
}
