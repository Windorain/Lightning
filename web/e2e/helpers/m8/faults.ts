/**
 * M8-1 · **故障恢复判据的共用原语**（S2/S3/S4 共用；纯读面 + 真实注入面）。
 *
 * ## 纪律（计划 §6-5 判据纪律）
 *
 * - **输入来自生产路径**：装载 = 生产算子 OPERATOR_OPEN_SCENE（File，与拖放同路）；
 *   挪机位 = 生产相机权威 main.ensureCamera(region)（M7 同口径的"制造非默认值"手法）；
 *   改时间 = 生产算子 OPERATOR_SET_FRAME_PLAYBACK（播放/停止，时间由帧时钟经
 *   advancePlayback 命令推进）；选择 = 生产选择 API ctx.getSelection().select()。
 * - **观测只用生产读面**：window.__vm__（WorkbenchRoot 显式声明的测试观测面）、
 *   ctx.viewports.get(rid)（相机/画布/呈现会话槽位）、ctx.getDiagnostics()、
 *   真实 DOM（.sb-root 的 data-texture-state）。
 * - **注入面是"对产品画布调用浏览器能力"**，不是产品钩子：本文件用
 *   canvas.getContext('webgl2').getExtension('WEBGL_lose_context') —— 与浏览器
 *   回收上下文是同一条规范路径（S0-A §4.4 判定可行，本文件把判定变成实测）。
 *   src/ 一行不改。
 * - **CRLF 归一化**：本文件不读源码文本，文本读数仍统一 replace(/\r\n/g, '\n')。
 *
 * ## 为什么读面要一次性打包成 ViewportFacts
 *
 * S2 的判据是"四个保留面逐字段不变"。若分多次 page.evaluate 读，两次读之间帧循环
 * 仍在推进（时间/机位可能被正常路径改），失败时无法区分"被设备事件改了"与"两次读
 * 之间他处改了"。打包成一次读 = 同一时刻的快照，比对才有分辨力。
 */

import { expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

/** 工作台根视口的 region（src/runtime/regionIds.ts 的 REGION.WORKBENCH_VIEWPORT）。 */
export const VIEWPORT_REGION = 'r-viewport'
/** 状态栏根（StatusBar.vue；data-texture-state 宿主）。 */
export const STATUS_BAR = '.sb-root'

/** 归属账读数（presentation/ownership#ledger 的形状 + M8 裁决②要求的 abandoned 记账）。 */
export interface LedgerFacts {
  acquireTotal: number
  releaseTotal: number
  disposeTotal: number
  zeroCrossings: number
  activeCount: number
  balanced: boolean
  /** M8 调度者裁决②：abandonAll 必须记账（单列，不混进 releaseTotal）。 */
  abandonedTotal: number | null
  lastAbandonReason: string | null
  /** 仍在服役的**份额**数（守恒式的 live 项；共享条目 > activeCount）。 */
  liveRefs: number | null
  /** 活跃计数回基线（A19 的旧读面；丢失/服役期与 balanced 故意不同）。 */
  atBaseline: boolean | null
}

export interface CameraEngineFacts {
  m: number[] | null
  zoom: number | null
  frustum: (number | null)[]
}

/** 一个视口在**同一时刻**的全部判据读数。 */
export interface ViewportFacts {
  canvas: { present: boolean; marked: boolean; width: number; height: number; isLost: boolean | null }
  slot: { camera: boolean; dom: boolean; definition: boolean }
  camera: { logical: unknown; engine: CameraEngineFacts }
  selection: { items: string[]; active: string | null; mode: string }
  time: { seconds: number; frameIndex: number; frame: number; fps: Record<string, number> | string | null }
  content: { digest: string; documentId: string | null; annotations: number }
  presenter: {
    generation: string | null
    pendingRebuild: boolean | null
    ledger: LedgerFacts | null
    mountedBatches: number | null
    /** 设备代次读面（M8-3 落地；不存在时如实读作 null，不冒充 0）。 */
    deviceGeneration: number | null
    /** 设备相位（M8-3：ready/lost/recovering/failed；读面缺席 ⇒ null）。 */
    devicePhase: string | null
    /** 丢失期暂停提交（M8-3 读面；缺席 ⇒ null）。 */
    deviceReady: boolean | null
    /** 上次**实际应用**的内容身份（§7.5:264「从当前有效状态重建」的机检面）。 */
    appliedContentIdentity: string | null
    /** 注解/描边子树的实时对象数（"新内容进画面"的结构读数）。 */
    overlay: { annotations: number; outlines: number } | null
  }
  texture: { state: string | null; loadingSeen: string | null }
  dom: { viewportCount: number; canvasCount: number }
}

/**
 * 一次读取该视口的全部判据事实。
 *
 * mark 由调用方给：第一次读时写进画布元素（__m8CanvasMark），之后每次读都回报
 * "当前 DOM 里的画布是否就是那个被标记过的元素" —— 这是"宿主没有重挂/画布没有换"
 * 的身份证人（.vc-viewport canvas 的数量相等不足以证明是同一个元素）。
 */
export async function readViewportFacts(page: Page, rid: string = VIEWPORT_REGION): Promise<ViewportFacts> {
  return (await page.evaluate(async (regionId: string) => {
    const vm = (window as any).__vm__
    const norm = (s: string | null | undefined): string => (s ?? '').replace(/\r\n/g, '\n')
    void norm
    const slot = vm?.viewports?.get(regionId) ?? null
    const canvas = (slot?.domElement?.value ?? null) as HTMLCanvasElement | null
    const surface = slot?.presenterSurface ?? null

    // 画布身份标记（首次读时写入；之后读回同一属性即为同一元素）
    let marked = false
    if (canvas) {
      const anyCanvas = canvas as unknown as { __m8CanvasMark?: string }
      if (anyCanvas.__m8CanvasMark === undefined) anyCanvas.__m8CanvasMark = regionId + ':m8'
      marked = anyCanvas.__m8CanvasMark === regionId + ':m8'
    }

    // 骨架上下文是否 lost（真实浏览器事实；不可得时为 null，不冒充 false）
    let isLost: boolean | null = null
    try {
      const gl = (canvas?.getContext('webgl2') ?? canvas?.getContext('webgl')) as WebGLRenderingContext | null
      isLost = gl ? gl.isContextLost() : null
    } catch {
      isLost = null
    }

    const cam = (slot?.camera?.value ?? null) as any
    if (cam?.updateMatrixWorld) cam.updateMatrixWorld()

    // 呈现会话读数（presenterSurface 是生产读面：runtime/host.ts 的描边端口就用它）
    let ledger: any = null
    try {
      const l = surface?.ledger?.()
      if (l) {
        ledger = {
          acquireTotal: Number(l.acquireTotal),
          releaseTotal: Number(l.releaseTotal),
          disposeTotal: Number(l.disposeTotal),
          zeroCrossings: Number(l.zeroCrossings),
          activeCount: Number(l.activeCount),
          balanced: Boolean(l.balanced),
          // 裁决② 要求的 abandoned 记账：ledger() 若没有该字段，读面如实报 null
          abandonedTotal: typeof l.abandonedTotal === 'number' ? l.abandonedTotal : null,
          lastAbandonReason: typeof l.lastAbandonReason === 'string' ? l.lastAbandonReason : null,
          liveRefs: typeof l.liveRefs === 'number' ? l.liveRefs : null,
          atBaseline: typeof l.atBaseline === 'boolean' ? l.atBaseline : null,
        }
      }
    } catch {
      ledger = null
    }

    let stats: any = null
    try {
      stats = surface?.statsSnapshot?.() ?? null
    } catch {
      stats = null
    }

    // 内容身份：产物 plain 的 sha256（页面内算，避免把 200KB 搬回 Node）
    let digest = ''
    let documentId: string | null = null
    let annotations = 0
    try {
      const plain = vm.plainForSave().plain ?? null
      const text = JSON.stringify(plain)
      const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
      digest = [...new Uint8Array(d)].map((v) => v.toString(16).padStart(2, '0')).join('')
      documentId = (vm.kernelPresentationDocument?.()?.id ?? plain?.id ?? null) as string | null
      const ann = vm.kernelAnnotations?.() ?? []
      annotations = Array.isArray(ann) ? ann.length : 0
    } catch {
      digest = ''
    }

    const sel = vm?.getSelection?.() ?? null
    const items = sel ? [...sel.items.value] : []
    const pb = vm?.kernel?.playback?.() ?? null
    const rawTime = pb?.time ?? null
    const time = {
      seconds: Number(vm?.getSceneSeconds?.() ?? 0),
      frameIndex: Number(vm?.getFrameIndex?.() ?? 0),
      // 权威时间值的原始读数：fps 无效时 seconds 恒 0（sceneClockOf 的早退分支），
      // 故"时间真的动了吗"必须以 frame 为主读数，否则会把"动了"误判成"没动"。
      frame: Number(rawTime?.frame ?? 0),
      fps: rawTime?.fps === undefined || rawTime?.fps === null ? null : JSON.parse(JSON.stringify(rawTime.fps)),
    }

    return {
      canvas: {
        present: canvas !== null,
        marked,
        width: canvas?.width ?? 0,
        height: canvas?.height ?? 0,
        isLost,
      },
      slot: {
        camera: Boolean(slot?.camera?.value),
        dom: Boolean(slot?.domElement?.value),
        definition: Boolean(slot?.definition?.value),
      },
      camera: {
        logical: vm?.main?.cameras?.[regionId]?.value
          ? JSON.parse(JSON.stringify(vm.main.cameras[regionId].value))
          : null,
        engine: {
          m: cam?.matrixWorld?.elements ? Array.from(cam.matrixWorld.elements as number[]) : null,
          zoom: typeof cam?.zoom === 'number' ? cam.zoom : null,
          frustum: [cam?.left ?? null, cam?.right ?? null, cam?.top ?? null, cam?.bottom ?? null],
        },
      },
      selection: {
        items: items.map((e: unknown) => JSON.stringify(e)).sort(),
        active: sel?.active?.value === null || sel?.active?.value === undefined ? null : JSON.stringify(sel.active.value),
        mode: String(sel?.mode?.value ?? ''),
      },
      time,
      content: { digest, documentId, annotations },
      presenter: {
        generation: (surface?.generation ?? null) as string | null,
        pendingRebuild: typeof surface?.pendingRebuild === 'boolean' ? surface.pendingRebuild : null,
        ledger,
        // ⚠️ 统计面的字段名是 `batchObjects`（`presentation/presenter#statsSnapshot`），
        // 不是 `batches` —— 读错字段会让"画面还在吗"恒读成 null（M8-5 实测：
        // D3 的前提断言因它超时）。两个名字都认，只为一个原因：将来改名不会
        // 把"页面无批次"和"读面读错"混成同一件事。
        mountedBatches:
          stats === null
            ? null
            : typeof stats.batchObjects === 'number'
              ? stats.batchObjects
              : typeof stats.batches === 'number'
                ? stats.batches
                : null,
        devicePhase: typeof surface?.devicePhase === 'string' ? surface.devicePhase : null,
        deviceReady: typeof surface?.deviceReady === 'boolean' ? surface.deviceReady : null,
        appliedContentIdentity:
          typeof surface?.appliedContentIdentity === 'string' ? surface.appliedContentIdentity : null,
        overlay: (() => {
          try {
            const o = surface?.overlayStatsSnapshot?.() ?? null
            return o === null
              ? null
              : { annotations: Number(o.annotationObjects), outlines: Number(o.outlineObjects) }
          } catch {
            return null
          }
        })(),
        // M8-3 前置：设备代次读面。当前不存在 ⇒ 如实读作 null（不是"代次为 0"）
        deviceGeneration:
          typeof surface?.deviceGeneration === 'number'
            ? surface.deviceGeneration
            : typeof ledger?.deviceGeneration === 'number'
              ? ledger.deviceGeneration
              : null,
      },
      texture: {
        state: document.querySelector('.sb-root')?.getAttribute('data-texture-state') ?? null,
        loadingSeen: document.querySelector('.sb-root')?.getAttribute('data-texture-loading-seen') ?? null,
      },
      dom: {
        viewportCount: document.querySelectorAll('.vc-viewport').length,
        canvasCount: document.querySelectorAll('.vc-viewport canvas').length,
      },
    } as unknown as ViewportFacts
  }, rid)) as ViewportFacts
}

/** 一条诊断记录（ctx.getDiagnostics() 的只读投影；只取判据需要的字段）。 */
export interface DiagnosticFacts {
  seq: number
  code: string
  channel: string
  params: Record<string, string | number | boolean>
  correlation: Record<string, string | number>
}

/** 读全部诊断记录（Context#getDiagnostics() —— 生产读面，e2e 经 __vm__ 取证）。 */
export async function readDiagnostics(page: Page): Promise<DiagnosticFacts[]> {
  return (await page.evaluate(() => {
    const vm = (window as any).__vm__
    const d = vm?.getDiagnostics?.()
    if (!d) return []
    return d.all().map((r: any) => ({
      seq: Number(r.seq),
      code: String(r.code),
      channel: String(r.channel),
      params: { ...(r.params ?? {}) },
      correlation: { ...(r.correlation ?? {}) },
    }))
  })) as DiagnosticFacts[]
}

/** 注入面的安装结果（ok === false 时 reason 说明**为什么判据无从成立**）。 */
export interface LossHookHandle {
  ok: boolean
  reason: string | null
  /** 画布实际用哪个上下文类型（webgl2/webgl/none）。 */
  contextType: string
  hadLoseExtension: boolean
  canvasTag: string
}

/**
 * 在**产品画布**上安装设备丢失注入面（不触发任何事件）。
 *
 * 步骤（全部是浏览器规范动作，不是产品钩子）：
 *  1. 取产品画布：ctx.viewports.get(rid).domElement.value（attachViewport 写进去的就是它）；
 *  2. 取**已存在**的 GL 上下文（getContext 同类型调用返回同一个对象，属性被忽略）；
 *  3. 取 WEBGL_lose_context 扩展；
 *  4. 先挂 webglcontextlost/restored 计数监听（事件在画布上派发），再返回句柄。
 */
export async function installLossHooks(page: Page, rid: string = VIEWPORT_REGION): Promise<LossHookHandle> {
  return (await page.evaluate((regionId: string) => {
    const vm = (window as any).__vm__
    const canvas = (vm?.viewports?.get(regionId)?.domElement?.value ?? null) as HTMLCanvasElement | null
    if (!canvas || canvas.tagName !== 'CANVAS') {
      return { ok: false, reason: '视口画布不存在（视口未挂载）', contextType: 'none', hadLoseExtension: false, canvasTag: canvas?.tagName ?? 'null' }
    }
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null
    if (!gl) {
      return { ok: false, reason: '产品画布上取不到已存在的 GL 上下文', contextType: 'none', hadLoseExtension: false, canvasTag: canvas.tagName }
    }
    const contextType = typeof (window as any).WebGL2RenderingContext !== 'undefined' && gl instanceof (window as any).WebGL2RenderingContext ? 'webgl2' : 'webgl'
    const ext = gl.getExtension('WEBGL_lose_context') as { loseContext(): void; restoreContext(): void } | null
    const w = window as unknown as { __m8_device__?: any }
    w.__m8_device__ = {
      canvas,
      gl,
      ext,
      lost: 0,
      restored: 0,
      contextType,
    }
    canvas.addEventListener('webglcontextlost', () => { w.__m8_device__.lost += 1 }, false)
    canvas.addEventListener('webglcontextrestored', () => { w.__m8_device__.restored += 1 }, false)
    return { ok: ext !== null, reason: ext === null ? '产品画布拿不到 WEBGL_lose_context 扩展' : null, contextType, hadLoseExtension: ext !== null, canvasTag: canvas.tagName }
  }, rid)) as LossHookHandle
}

/** 触发**真实**上下文丢失，并等到浏览器真的派发 webglcontextlost（isContextLost() 为证）。 */
export async function loseProductContext(page: Page, timeout = 15_000): Promise<{ lostEvents: number; isLost: boolean }> {
  await page.evaluate(() => {
    const d = (window as any).__m8_device__
    if (!d?.ext) throw new Error('M8：丢失注入面未安装（先调 installLossHooks）')
    d.ext.loseContext()
  })
  const deadline = Date.now() + timeout
  for (;;) {
    const state = await page.evaluate(() => {
      const d = (window as any).__m8_device__
      let isLost = null
      try {
        isLost = d?.gl ? d.gl.isContextLost() : null
      } catch {
        isLost = null
      }
      return { lostEvents: Number(d?.lost ?? 0), isLost }
    })
    if (state.lostEvents > 0 && state.isLost === true) return { lostEvents: state.lostEvents, isLost: true }
    if (Date.now() > deadline) {
      throw new Error('M8：等待 webglcontextlost 超时（events=' + state.lostEvents + ' isContextLost=' + String(state.isLost) + '）')
    }
    await page.waitForTimeout(30)
  }
}

/** 触发**真实**上下文恢复，并等到 webglcontextrestored 落地（isContextLost() 转 false）。 */
export async function restoreProductContext(page: Page, timeout = 20_000): Promise<{ restoredEvents: number; isLost: boolean }> {
  await page.evaluate(() => {
    const d = (window as any).__m8_device__
    if (!d?.ext) throw new Error('M8：丢失注入面未安装（先调 installLossHooks）')
    d.ext.restoreContext()
  })
  const deadline = Date.now() + timeout
  for (;;) {
    const state = await page.evaluate(() => {
      const d = (window as any).__m8_device__
      let isLost = null
      try {
        isLost = d?.gl ? d.gl.isContextLost() : null
      } catch {
        isLost = null
      }
      return { restoredEvents: Number(d?.restored ?? 0), isLost }
    })
    if (state.restoredEvents > 0 && state.isLost === false) return { restoredEvents: state.restoredEvents, isLost: false }
    if (Date.now() > deadline) {
      throw new Error('M8：等待 webglcontextrestored 超时（events=' + state.restoredEvents + ' isContextLost=' + String(state.isLost) + '）')
    }
    await page.waitForTimeout(30)
  }
}

/**
 * 等呈现会话**稳定**（连续两次读数的结构世代与"实际应用的内容身份"都相同）。
 *
 * ## 为什么需要它（本批 e2e 实测）
 *
 * "恢复后结构世代回到同一值"这条判据要求基线读数是**稳定态**：编辑（逐格说明）之后
 * 编译是异步落地的（帧时钟驱动），若基线读在落地之前，读到的世代是上一份内容的 ——
 * 于是恢复后（用**新**内容重建）的世代必然与它不同，判据会假红。
 *
 * 判据本身不放宽：稳定态基线 + 恢复后同值，仍然证明"内容没变的恢复回到同一世代"。
 */
export async function settlePresenter(
  page: Page,
  rid: string = VIEWPORT_REGION,
  timeout = 15_000,
): Promise<ViewportFacts> {
  const deadline = Date.now() + timeout
  let prev = await readViewportFacts(page, rid)
  for (;;) {
    await page.waitForTimeout(400)
    const now = await readViewportFacts(page, rid)
    const stable =
      now.presenter.generation === prev.presenter.generation &&
      now.presenter.appliedContentIdentity === prev.presenter.appliedContentIdentity &&
      now.presenter.generation !== null
    if (stable) return now
    if (Date.now() > deadline) return now
    prev = now
  }
}

/** 把 main.cameras[rid] 挪到**显著非默认**机位（前提设置，不是观测；M7 同口径）。 */
export async function setCameraPose(
  page: Page,
  rid: string,
  pose: { target: { x: number; y: number; z: number }; yawDeg: number; elevationDeg: number; distance: number; zoom: number },
): Promise<void> {
  await page.evaluate(({ r, p }: any) => {
    const vm = (window as any).__vm__
    vm.main.ensureCamera(r).value = {
      target: { x: p.target.x, y: p.target.y, z: p.target.z },
      yawDeg: p.yawDeg,
      elevationDeg: p.elevationDeg,
      distance: p.distance,
      zoom: p.zoom,
    }
  }, { r: rid, p: pose })
  await page.waitForTimeout(900)
}

/** 非默认机位（与自动框选显著不同；取值沿用 M7-1 的 POSE_A）。 */
export const POSE_A = { target: { x: 9, y: 1, z: 5 }, yawDeg: 35, elevationDeg: 20, distance: 6, zoom: 2.4 }

export interface TimeReading {
  /** 权威时间值（内核 `EditContext.time` 的投影；`fps` 无效时 seconds 恒 0，故 frame 才是主读数）。 */
  frame: number
  fps: Record<string, number> | string | null
  seconds: number
  playing: boolean
  rate: number
}

/** 读权威时间（`__vm__.kernel.playback()` —— 内核会话的播放读面，不另算一遍）。 */
export async function readTime(page: Page): Promise<TimeReading> {
  return (await page.evaluate(() => {
    const vm = (window as any).__vm__
    const pb = vm?.kernel?.playback?.() ?? null
    const time = pb?.time ?? null
    return {
      frame: Number(time?.frame ?? 0),
      fps: time?.fps === undefined || time?.fps === null ? null : JSON.parse(JSON.stringify(time.fps)),
      seconds: Number(vm?.getSceneSeconds?.() ?? 0),
      playing: Boolean(pb?.playing),
      rate: Number(pb?.rate ?? 0),
    }
  })) as TimeReading
}

/** 时间的可比较签名（frame 为主；fps 变化也算"时间轴变了"）。 */
export function timeSignature(t: TimeReading): string {
  return 'frame=' + String(t.frame) + ';fps=' + JSON.stringify(t.fps)
}

/**
 * 把**场景时间**挪离默认值（生产路径：真播放 → 等时间推进 → 真停止）。
 *
 * 为什么不用 OPERATOR_SET_FRAME_INDEX：本仓 e2e 夹具是**多方块**文档（无帧轴），
 * KernelSession#seekFrame 对 frameSource.count() <= 1 的文档恒定位到 0
 * （kernelSession.ts:902-911）⇒ 帧下标读面对这类文档没有区分力。
 * 播放走的是 advancePlayback 命令（domain/editing.ts:544），时间按
 * frame += deltaSeconds * fps 推进（domain/animation.ts:268-270）。
 *
 * 判定口径：以 `time.frame` 为主读数（seconds 由 sceneClockOf 派生，fps 无效时恒 0，
 * 会把"时间真的动了"误读成"没动"）。前提不成立时抛出**带读数**的错误，
 * 让失败信息能区分"没在播放"与"播放了但时间不动"。
 *
 * 注意 OPERATOR_SET_FRAME_PLAYBACK 的 poll 对单帧文档为 false（UI 不给入口）；
 * 这里显式 exec 它在语义上等于"用户在多帧场景按播放"，只作**前提设置**，
 * 不作观测 —— 与 setCameraPose 同一定位。
 */
export async function advanceSceneTimeOffDefault(page: Page, minSeconds = 0.05): Promise<TimeReading & { via: string }> {
  const before = await readTime(page)
  // 第一步走**生产算子**（UI 的播放入口）。它对单帧文档的 poll 为 false
  // （miscOperators.ts:64-67），故这一步在多方块夹具上会被算子层按设计取消。
  await page.evaluate(async () => {
    const vm = (window as any).__vm__
    await vm.getOperators().exec('OPERATOR_SET_FRAME_PLAYBACK', { playing: true })
  })
  let via = 'operator'
  let started = await readTime(page)
  if (!started.playing) {
    // 第二步：经内核会话端口置播放（**前提设置**，不是观测）。
    // 语义依据：播放状态属 EditContext（§3.3），advancePlayback 本身没有时长钳制；
    // 单帧文档只是"UI 不给播放入口"（poll=false），不是"时间轴不可推进"。
    // 这里与 setCameraPose 同一定位：只负责把被测状态挪离默认值。
    via = 'kernel-session'
    await page.evaluate(() => {
      const vm = (window as any).__vm__
      vm.kernel.setPlaying(true)
    })
    started = await readTime(page)
  }
  const deadline = Date.now() + 20_000
  let now = started
  const samples: string[] = []
  for (;;) {
    now = await readTime(page)
    samples.push(now.playing + '/' + now.frame + '/' + now.seconds)
    if (now.frame > before.frame || now.seconds - before.seconds >= minSeconds) break
    if (Date.now() > deadline) {
      await page.evaluate(() => {
        const vm = (window as any).__vm__
        if (vm?.kernel?.setPlaying) vm.kernel.setPlaying(false)
      })
      throw new Error(
        'M8：场景时间未离开默认值 —— 时间面判据无从成立。before=' +
          JSON.stringify(before) + ' via=' + via + ' tries=' + JSON.stringify(samples.slice(0, 6)),
      )
    }
    await page.waitForTimeout(50)
  }
  await page.evaluate(() => {
    const vm = (window as any).__vm__
    if (vm?.kernel?.setPlaying) vm.kernel.setPlaying(false)
  })
  await page.waitForTimeout(300)
  return { ...(await readTime(page)), via }
}

/** 生产选择入口（ctx.getSelection().select；与 OPERATOR_SELECT 同一条写路径）。 */
export async function selectFirstAnnotatedCell(page: Page): Promise<{ pos: [number, number, number]; text: string }> {
  const picked = (await page.evaluate(() => {
    const vm = (window as any).__vm__
    const grid = vm.kernelGrid(0)
    if (!grid) return null
    for (let z = 0; z < grid.depth; z++) {
      for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
          const t = grid.tooltipAt({ x, y, z })
          if (typeof t === 'string' && t.length > 0) return { pos: [x, y, z], text: t }
        }
      }
    }
    return null
  })) as { pos: [number, number, number]; text: string } | null
  expect(picked, '前提：夹具里必须至少有一格逐格说明（否则"选择"面无从挪离默认值）').not.toBeNull()

  await page.evaluate(({ p }: any) => {
    const vm = (window as any).__vm__
    const plain = vm.plainForSave().plain
    const [x, y, z] = p
    const height = plain.cellGrid[0].length
    const row = height - 1 - y
    const entry = plain.blockPalette[Number(plain.cellGrid[z][row][x] ?? 0)]
    vm.getSelection().select({ pos: { x, y, z }, block_state_id: String(entry?.registryId ?? '') })
  }, { p: picked!.pos })
  await page.waitForTimeout(500)
  expect(
    await page.evaluate(() => document.querySelector('[data-property="lightning.block.pos"] .ux-field-readonly')?.textContent?.trim() ?? null),
    '前提：生产选择必须让右栏显示坐标（否则选择面没有真的挪动）',
  ).not.toBeNull()
  return picked!
}

/** 归一化实例身份（application/recovery#instanceIdentity 的同一算法：[.\\/\s]+ → -）。 */
export function normalizeInstanceId(instanceId: string): string {
  const cleaned = instanceId.trim().replace(/[.\\/\s]+/g, '-')
  return cleaned === '' ? 'default' : cleaned
}

/** 恢复副本键族的前缀（application/recovery#recoveryStoreKey：lk.recovery.v<版本>.<范围>.<实例>.<文档>）。 */
export const RECOVERY_KEY_PREFIX = 'lk.recovery.v1.'
/** 正式保存键族的前缀（application/recovery#saveStoreKey：lk.save.v<版本>.<范围>.<文档>）。 */
export const FORMAL_SAVE_KEY_PREFIX = 'lk.save.v1.'
/** RecoveryScope 的三个取值（domain/instanceSettings#PreferenceNamespace）。 */
export const RECOVERY_SCOPES = ['workbench', 'embed', 'shared'] as const

/** 本页存储里所有匹配前缀的键（按字典序，读的是**存储介质**本身，不是内部函数）。 */
export async function storageKeys(page: Page, prefix: string): Promise<string[]> {
  return (await page.evaluate((p: string) => {
    const out: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k !== null && k.startsWith(p)) out.push(k)
    }
    return out.sort()
  }, prefix)) as string[]
}

/** 读一条存储值的原始字符串（不存在 ⇒ null）。 */
export async function storageValue(page: Page, key: string): Promise<string | null> {
  return (await page.evaluate((k: string) => localStorage.getItem(k), key)) as string | null
}
// ─────────────────────────────────────────────────────────────────────────────
// 产物目录（下载件/输入副本；铁律 1：仓库树零未跟踪文件）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 本批 e2e 产物的落盘目录：默认 <工作区根>/temp/m8/e2e/<用例>-<project>/。
 *
 * 隔离理由与 M1 P3 相同（saveReopen#caseDir）：同一 spec 会在 desktop-chrome 与
 * mobile-chrome 两个 project 上各跑一遍，可能**并行**；两条用例写同一个下载路径会读到
 * 写到一半的文件。故按「用例 × project」分目录。
 *
 * 可用 M8_OUT_DIR 覆盖（调度者集中归档时用）。
 */
export function m8CaseDir(caseId: string, projectName: string): string {
  const base =
    process.env.M8_OUT_DIR ??
    path.resolve(import.meta.dirname, '../../../../../../temp/m8/e2e')
  const dir = path.join(base, caseId + '-' + projectName)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}