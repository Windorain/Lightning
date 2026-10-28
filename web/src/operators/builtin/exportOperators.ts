import type { OperatorType } from '@/operators/operatorType'
import { buildEnvelopePackage } from '@/render/data/sceneExport'
import { loadStructureOrWorld } from '@/render/data/bundleResolve'
import { downloadBlob, downloadJson } from '@/util/browser'
import { buildStructureBundleZip } from '@/workbench/export/bundleMeshAssembly'
import { normalizeIsoSeconds } from '@/application/captureInput'
import {
  EXPORT_PIXEL_SIZE,
  SCENE_GIF_PIXEL_SIZE_RANGE,
  SHOT_PNG_BACKGROUND,
  blobOf,
  exportErrorText,
  runIsoExport,
  runShotExport,
} from '@/workbench/export/isoExportJob'
import { mcSpecToShotCamera, type McCameraSpec } from '@/pure/mcShotCamera'
import { createExportDiagnosticSink } from '@/workbench/export/exportCommandDiagnostics'
import { objExportSemantics } from '@/application/exportSemantics'
import { createDomTextureDecoder } from '@/adapters/textureDecode'
import { sceneStableStringIdFromDocument } from '@/render/data/compactSceneDocument'

const ISO_DIRECTION_MAP: Record<string, number> = {
  nw: 0,
  ne: 1,
  sw: 2,
  se: 3,
}

/**
 * 把 `direction` 归一成 **0..3**（等轴四向的渲染下标）。
 *
 * ## 为什么必须有这个**唯一**入口
 *
 * 修复前 `ExportIsoPngOperator.exec` 里有两处**各自**解释 `props.direction`：
 *
 *  - 渲染下标：`ISO_DIRECTION_MAP[direction] ?? 0` —— 而 `direction` 取成 `string`
 *    （`(_props.direction as string) ?? 'nw'`），调用方 `ExportWorkspace.vue:54` 传的却是
 *    **number**（`{ direction: isoDir.value }`）⇒ number 键入 string 表**恒 miss** ⇒ 恒 0；
 *  - 文件名：`` `iso-${direction}.png` `` —— 插值的是**原始 props 值**（number 2 得 `iso-2.png`）。
 *
 * 于是两者的口径可以分叉，而分叉的表现是**名实不符**：下载名为 `iso-2.png`，
 * 内容却是方向 0 的图；四个方向下载出**同一张**图（实测证据）。
 *
 * ⇒ 归一化收成一处，**渲染下标与文件名同源**。分叉在结构上不再可表达：
 * 两处都只能引用本函数的返回值。
 *
 * ## 口径（宽进严出，但不虚构能力）
 *
 * | 输入 | 结果 |
 * |---|---|
 * | `number`（含小数/负数/越界） | `((floor(n) % 4) + 4) % 4` ⇒ `-1→3`、`4→0`、`2.7→2` |
 * | `string`（`'nw'`/`'ne'`/`'sw'`/`'se'`） | 查 {@link ISO_DIRECTION_MAP}（**文档化的字符串口径**，保留） |
 * | 其余字符串 / `NaN` / `Infinity` / 其他类型 | `0`（与修复前的回落一致，不抛） |
 *
 * 返回值恒在 `0..3`：调用方拿它去索引四向表**不可能越界**。
 */
export function resolveIsoDirection(raw: unknown): number {
  if (typeof raw === 'number') {
    // `NaN`/`Infinity` 走回落分支：`Math.floor(NaN)` 是 NaN，取模仍是 NaN，
    // 会让下标悄悄变成 `NaN` 并索引出 `undefined` 方向（静默坏画面）。
    if (!Number.isFinite(raw)) return 0
    return ((Math.floor(raw) % 4) + 4) % 4
  }
  if (typeof raw === 'string') return ISO_DIRECTION_MAP[raw] ?? 0
  return 0
}

export const ExportPlainOperator: OperatorType = {
  id: 'OPERATOR_EXPORT_PLAIN',
  label: '导出 Plain JSON',
  description: '下载完整明文 JSON',

  poll(ctx) {
    return ctx.hasLoadedDocument()
  },

  exec(ctx, _props) {
      // 产物改由**内核投影**给出（未装配自动回落旧文档）。
    const doc = (ctx.plainForSave().plain ?? null) as Record<string, unknown> | null
    if (!doc) return
    const baseName = sceneStableStringIdFromDocument(doc)
    downloadJson(`${baseName}-plain`, doc, true)
  },
}

export const ExportEnvelopeOperator: OperatorType = {
  id: 'OPERATOR_EXPORT_ENVELOPE',
  label: '导出 Envelope JSON',
  description: '下载 gzip+Base64 信封格式',

  poll(ctx) {
    return ctx.hasLoadedDocument()
  },

  exec(ctx, _props) {
      // 产物改由**内核投影**给出（未装配自动回落旧文档）。
    const doc = (ctx.plainForSave().plain ?? null) as Record<string, unknown> | null
    if (!doc) return
    const baseName = sceneStableStringIdFromDocument(doc)
    downloadJson(`${baseName}-envelope`, buildEnvelopePackage(doc), true)
  },
}

export const ExportObjOperator: OperatorType = {
  id: 'OPERATOR_EXPORT_OBJ',
  label: '导出 OBJ',
  description: '导出 Wavefront OBJ+MTL 打包为 zip',

  poll(ctx) {
    return ctx.hasLoadedDocument()
  },

  async exec(ctx, _props) {
      // 产物改由**内核投影**给出（未装配自动回落旧文档）。
    const doc = ctx.plainForSave().plain
    if (!doc) return
    const explicit = (_props.mode as string | undefined)
    const connected = (_props.connected as boolean) ?? false
    const mode = explicit ?? (connected ? 'connected' : 'block')
    const baseName = sceneStableStringIdFromDocument(doc)
    const def = loadStructureOrWorld(doc, undefined)
      // OBJ 的不可表达语义（首帧纹理 / 跳过体素 / 分层叠化 / 混合近似）。
      // 此前这些事实只写在产物的注释行里，机器与用户都读不到。
    const diagnostics = createExportDiagnosticSink(ctx.wm.diagnostics, {
      commandId: 'OPERATOR_EXPORT_OBJ',
      format: 'obj',
    })
    diagnostics.requested({ mode })
    const blob = await buildStructureBundleZip(def, doc, {
      mode: mode as any,
      onSemanticReport: (report) => { diagnostics.findings(objExportSemantics(report)) },
    })
    // 插桩：验证 ZIP 文件头
    const sigBytes = new Uint8Array(await blob.slice(0, 4).arrayBuffer())
    const sigHex = Array.from(sigBytes).map(b => b.toString(16).padStart(2, '0')).join('')
    if (sigHex !== '504b0304') {
      // 文件头异常是**产物损坏**（不是语义损失）：结构化记一条，日志照旧。
      diagnostics.failed({ code: 'UnsupportedOperation', params: { reason: 'zipSignatureInvalid', expected: '504b0304', actual: sigHex, size: blob.size } })
      ctx.log.warn('导出', `ZIP 文件头异常: 期望 504b0304, 实际 ${sigHex}, 大小 ${blob.size}`)
    }
    downloadBlob(`${baseName}-${mode}.zip`, blob)
  },
}

export const ExportIsoPngOperator: OperatorType = {
  id: 'OPERATOR_EXPORT_ISO_PNG',
  label: '导出等轴 PNG',
  description: '将等轴方向渲染输出为 PNG',

  poll(ctx) {
    return ctx.hasLoadedDocument()
  },

  async exec(ctx, _props) {
      // 渲染下标与文件名**同源**（都取自 `directionIndex`）。
    const directionIndex = resolveIsoDirection(_props.direction)
    // 显式时间（缺省 0）；非法值在这里就拒（唯一归一入口），不落进 try 被压成一条 warn。
    const seconds = normalizeIsoSeconds(_props.seconds)
    if (!ctx.hasLoadedDocument()) return
      // 命令接**结构化诊断**（此前只有 UI 文案与 log.warn）。
    const diagnostics = createExportDiagnosticSink(ctx.wm.diagnostics, {
      commandId: 'OPERATOR_EXPORT_ISO_PNG',
      format: 'png',
    })
    diagnostics.requested({ direction: directionIndex, seconds })
    // **已记过**的失败不再记第二遍：`export.failed` 必须一条事实一条记录
    // （否则同一次失败在环形缓冲里出现两次不同的 code —— `MissingTarget` 与 `Thrown`）。
    let recorded = false
    try {
        // 产物 = **与屏上同一条呈现链**（捕获派生场景 → 冻结作业 → 导出作业）。
      const result = await runIsoExport(ctx, {
        kind: 'image',
        directionIndex,
          // 与旧烘焙同一个边长（480）；场景 GIF 一并统一到**同一个常量**。
        pixelSize: EXPORT_PIXEL_SIZE,
        seconds,
        decoder: createDomTextureDecoder(),
        now: Date.now(),
        // 捕获后、作业前的不可表达语义（能力损失/文字/轨道）逐项进诊断通道。
        onSemantics: (findings) => { diagnostics.findings(findings) },
      })
      if (!result.ok) {
        // 结构化失败：先按 **DomainError** 记诊断（保留 code + params），再转成人读错误抛出。
        recorded = true
        diagnostics.failed(result.error)
        throw new Error(exportErrorText(result.error))
      }
      // 作业完成的非阻塞项（如 GIF 厘秒量化）与完成事实一并报出。
      diagnostics.diagnostics(result.value.outcome.diagnostics)
      diagnostics.completed(result.value)
      downloadBlob(result.value.fileName, new Blob([result.value.bytes as unknown as BlobPart], { type: result.value.mediaType }))
    } catch (e) {
      // DomainError 已在上面记过；这里只补"其它抛出"（一次失败只留一条事实）。
      if (!recorded) diagnostics.failed(e)
      ctx.log.warn('导出', `等轴 PNG 导出失败: ${e}`)
        // **再抛**：log.warn 只留诊断，可见性由调用方（UI）承担。吞掉它正是要修的形态。
      throw e
    }
  },
}

/**
 * 场景 GIF：把**模型画面**在"纹理序列一个循环"内逐帧渲染成 GIF89a。
 *
 * 本命令导出的是**模型画面**（3D）；材质卡那条"导出贴图条本身"的入口已退出
 * （`materialOperators` 的 `ExportGifOperator` 与 `workbench/animatedGifEncoder` 一并删除），
 * 故"把某张材质的动画单独导出成 GIF"**不再有入口**（静态纹理 PNG 仍可导出）。
 *
 * 与等轴 PNG **同一条**呈现链、同一台相机：两者的差别只有"取一帧"与"取一个循环"。
 *
 * 时间来自 `domain/materials#planSequenceLoop` 的冻结计划（声明时长 → 逐帧厘秒），
 * 不读墙钟、不自算 tick、不截断超限循环（超限是**显式失败**）。
 */
export const ExportSceneGifOperator: OperatorType = {
  id: 'OPERATOR_EXPORT_SCENE_GIF',
  label: '导出动画 GIF',
  description: '把纹理序列的一个循环逐帧渲染成 GIF（与等轴 PNG 同一台相机）',

  poll(ctx) {
    return ctx.hasLoadedDocument()
  },

  async exec(ctx, _props) {
    const directionIndex = resolveIsoDirection(_props.direction)
    const rawSize = _props.pixelSize
    /**
     * 边长**缺省与夹取都有唯一来源**：
     *  - 缺省 `EXPORT_PIXEL_SIZE`（480）= 卡片预览/下载与等轴 PNG 的同一值；
     *  - 区间 `SCENE_GIF_PIXEL_SIZE_RANGE`（64..512）= 本命令的既有政策值。
     * 卡片侧（`ExportWorkspace.vue` 的预览/下载）引用**同一个常量**，故
     * "预览 480 / 下载 320"这条分叉在结构上不再可表达。
     * 夹取只在本处发生：捕获器与作业只搬运形参，不做第二次解释。
     */
    const pixelSize = typeof rawSize === 'number' && Number.isFinite(rawSize)
      ? Math.max(SCENE_GIF_PIXEL_SIZE_RANGE.min, Math.min(SCENE_GIF_PIXEL_SIZE_RANGE.max, Math.floor(rawSize)))
      : EXPORT_PIXEL_SIZE
    if (!ctx.hasLoadedDocument()) return
      // 与等轴 PNG 同一套诊断接线（同一通道、同一形状）。
    const diagnostics = createExportDiagnosticSink(ctx.wm.diagnostics, {
      commandId: 'OPERATOR_EXPORT_SCENE_GIF',
      format: 'gif',
    })
    diagnostics.requested({ direction: directionIndex, pixelSize })
    try {
        // 与等轴 PNG **同一条**呈现链（同相机/同内容/同资源表）。
      const result = await runIsoExport(ctx, {
        kind: 'animation',
        directionIndex,
        pixelSize,
        decoder: createDomTextureDecoder(),
        now: Date.now(),
        onSemantics: (findings) => { diagnostics.findings(findings) },
      })
      if (!result.ok) {
        diagnostics.failed(result.error)
        throw new Error(exportErrorText(result.error))
      }
      diagnostics.diagnostics(result.value.outcome.diagnostics)
      diagnostics.completed(result.value)
      downloadBlob(result.value.fileName, new Blob([result.value.bytes as unknown as BlobPart], { type: result.value.mediaType }))
    } catch (e) {
      if (!(e instanceof Error && /\.code=/.test(e.message))) diagnostics.failed(e)
      ctx.log.warn('导出', `场景 GIF 导出失败: ${e}`)
      // 同轴等轴 PNG：日志只留诊断，可见性由调用方承担。
      throw e
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
  // 验收器具：指定正交机位出图（OPERATOR_EXPORT_SHOT_PNG）
// ─────────────────────────────────────────────────────────────────────────────

function shotVec3(value: unknown, field: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`${field} 必须是长度 3 的数组，实际 ${JSON.stringify(value)}`)
  }
  const out = value.map((v) => Number(v))
  for (const v of out) {
    if (!Number.isFinite(v)) throw new Error(`${field} 含非有限分量：${JSON.stringify(value)}`)
  }
  return [out[0]!, out[1]!, out[2]!]
}

function shotFiniteNumber(value: unknown, field: string): number {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`${field} 必须是有限数，实际 ${JSON.stringify(value)}`)
  return n
}

function shotPositiveInt(value: unknown, field: string): number {
  const n = shotFiniteNumber(value, field)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${field} 必须是正整数，实际 ${n}`)
  return n
}

/**
 * 指定正交机位出图（「三对齐」验收器具）。
 *
 * 与 `OPERATOR_EXPORT_ISO_PNG` 的区别：机位（落点 / 方位 / 俯仰 / 正交全高 / 分辨率）
 * **全部由调用方给定**，不做等轴四向、不做 AABB 自动贴合；`pos` / `yaw` / `pitch` 走
 * **MC 控制面口径**，经 `pure/mcShotCamera` 换算成"相对内容包围盒中心"的落点后交给
 * `runShotExport` —— 后者走与产品命令**同一条**捕获/作业链（内核呈现快照 + 冻结作业），
 * 因此器具不会变成第二条渲染链，也不会借用用户视口。
 *
 * props（MC 口径）：
 *  - `pos: [x,y,z]`  MC 世界坐标相机落点
 *  - `yaw` / `pitch`  MC 偏航 / 俯仰（度，pitch 正 = 俯视）
 *  - `orthoHeight`    正交竖直全高（方块数）
 *  - `width` / `height` 输出分辨率（任意，不 clamp）
 *  - `center: [x,y,z]` **结构中心的 MC 世界坐标（必传）**——世界锚点在内核解析链上
 *                      丢失，只能由调用方从 SDE `scanBounds` + `cellGrid` 尺寸复原
 *                      （见 `structureCenterFromScanBounds`）
 *  - `name?`          文件名（`shot-<name||'unnamed'>.png`）
 *
 * `yaw` / `pitch` 在本器具里的角色与旧器具**一致**：它们是 MC 机位的**声明**，用于校验
 * 入参完备性与换算口径（落点方向由 `pos − center` 表达，镜头恒看结构中心 —— 调用方按
 * "瞄准结构中心"构造机位，六个机位即如此）。换算结果里 `yawDeg`/`elevationDeg` 是
 * 诊断字段，不参与出图。
 *
 * 仅支持**普通（非多方块）文档**：多方块文档的网格是装配产物、无单一世界锚点，本器具不服务。
 */
export const ExportShotPngOperator: OperatorType = {
  id: 'OPERATOR_EXPORT_SHOT_PNG',
  label: '导出指定机位 PNG',
  description: '按 MC 控制面 CameraSpec（指定落点/方位/俯仰/正交全高/分辨率）渲染 PNG',

  poll(ctx) {
    return ctx.hasLoadedDocument()
  },

  async exec(ctx, props) {
    if (!ctx.hasLoadedDocument()) return
    if (ctx.kernelMultiblockBody() !== null) {
      throw new Error(
        'OPERATOR_EXPORT_SHOT_PNG：不支持「多方块为主」文档（网格为装配产物、无单一世界锚点）；本器具当前只服务单结构验收',
      )
    }

    const mc: McCameraSpec = {
      pos: shotVec3(props.pos, 'pos'),
      yaw: shotFiniteNumber(props.yaw, 'yaw'),
      pitch: shotFiniteNumber(props.pitch, 'pitch'),
      orthoHeight: shotFiniteNumber(props.orthoHeight, 'orthoHeight'),
      width: shotPositiveInt(props.width, 'width'),
      height: shotPositiveInt(props.height, 'height'),
    }
    if (mc.orthoHeight <= 0) {
      throw new Error(`orthoHeight 必须为正，实际 ${mc.orthoHeight}`)
    }
    const center = shotVec3(props.center, 'center')
    const name = typeof props.name === 'string' && props.name.length > 0 ? props.name : 'unnamed'

    // MC 口径 → 相对内容包围盒中心的落点（web 口径的唯一换算点）。
    const web = mcSpecToShotCamera(mc, center)
    const result = await runShotExport(ctx, {
      shot: {
        offset: [web.pos.x, web.pos.y, web.pos.z],
        orthoHeight: web.orthoHeight,
        width: web.width,
        height: web.height,
        // 像素级判据（非空白/包围盒）需要区分"空"与"内容"：透明底解码后两者 RGB 都是 0。
        background: SHOT_PNG_BACKGROUND,
      },
      fileName: `shot-${name}.png`,
      decoder: createDomTextureDecoder(),
      now: Date.now(),
    })
    if (!result.ok) throw new Error(exportErrorText(result.error))
    downloadBlob(result.value.fileName, blobOf(result.value))
  },
}
