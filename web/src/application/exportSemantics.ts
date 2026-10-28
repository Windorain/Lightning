/**
 * **导出不可表达语义的矩阵与纯生产者**（SPEC §9「无法表达的语义必须诊断，不静默丢弃」）。
 *
 * ## 为什么要有**一张声明表**
 *
 * 判据要求"每个格式 × 每类不可表达语义 ⇒ 结构化诊断"。若每个格式各写一段
 * `if (… ) log.warn(…)`，那么"哪些语义在哪个格式里表达不了"就只存在于散落的
 * 分支里 —— 删掉一个分支不会有任何东西响。本文件把那张表**显式列出**：
 *
 * | 格式 | 声明不了的语义 | 诊断码 |
 * |---|---|---|
 * | png | 变换 / 形变 / 注解文字 / 动画轨道 | `export.capabilityUnsupported`（逐项） |
 * | gif | 同上 | 同上 |
 * | obj | 竖条动画纹理（只取首帧） | `export.firstFrameOnly` |
 * | obj | 无几何体素（被跳过） | `export.geometrySkipped` |
 * | obj | 混合模式（MTL `d`/`illum` 近似） | `export.blendApproximated` |
 *
 * 依据：对 OBJ ①②④ 与 PNG/GIF 能力检查的逐行实测，以及设计 §10.5「两个命令在 preflight 前用
 * `request.capabilityLoss` + `PublishCapabilities`（PNG/GIF 各一张表）产出诊断」。
 *
 * ## 明确**不在**本表的三行（登记为遗留，不是遗忘）
 *
 * OBJ 的"注解/文字、相机、动画轨道、驱动纹理时间戳"**完全不被
 * OBJ 表达**，但检出面需要旧文档的注解/相机字段，而 OBJ 暂不切入该链路、
 * 只登记缺口。⇒ 本次**不**为这三类造检出面（造了也只能读到半份事实），
 * 由矩阵判据的"期望表"显式留空并登记为遗留 —— 不写"已覆盖"。
 *
 * ## 纯度
 *
 * 纯函数 + 常量；不读时钟、不碰 DOM/Three、不持有记录器（写诊断在
 * `runtime/exportDiagnostics`）。
 */

import type { DiagnosticReasonCode } from '@/application/diagnostics'
import {
  capabilityReport,
  type CapabilityReportItem,
  type ExportDiagnostic,
  type PublishCapabilities,
} from '@/application/exportPlan'
import type { ExportRequest } from '@/domain/captureSpec'

// ─────────────────────────────────────────────────────────────────────────────
// 稳定码（**与诊断码表同一份**：这里的类型就是 DiagnosticReasonCode 的子集）
// ─────────────────────────────────────────────────────────────────────────────

/** 矩阵里会产出的诊断码（每一个都必须是 `DiagnosticReasonCode` 的成员）。 */
export const EXPORT_SEMANTIC_CODES = Object.freeze({
  capabilityUnsupported: 'export.capabilityUnsupported',
  firstFrameOnly: 'export.firstFrameOnly',
  geometrySkipped: 'export.geometrySkipped',
  layerStackUnexpressed: 'export.layerStackUnexpressed',
  blendApproximated: 'export.blendApproximated',
} as const satisfies Readonly<Record<string, DiagnosticReasonCode>>)

export type ExportSemanticCode = (typeof EXPORT_SEMANTIC_CODES)[keyof typeof EXPORT_SEMANTIC_CODES]

/**
 * 导出通道的**全部**码（`DiagnosticReasonCode` 的 `export.*` 子集）。
 *
 * 事实的码不限于矩阵那四个：预检/作业的阻塞项（资源未就绪、缺编码器…）也走同一通道，
 * 于是"一次导出的全部结构化结论"读一个 `channel === 'export'` 就够了。
 */
export type ExportDiagnosticCode = Extract<DiagnosticReasonCode, `export.${string}`>

/** 一条"这个格式表达不了这件事"的结构化事实（诊断通道的输入）。 */
export interface ExportSemanticFinding {
  readonly code: ExportDiagnosticCode
  /** 稳定参数（只允许标量；与 `DiagnosticParams` 同形状）。 */
  readonly params: Readonly<Record<string, string | number | boolean>>
  /** 归属对象（无对象语义留空；进 `DiagnosticCorrelation#objectId`）。 */
  readonly objectId?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// 矩阵（唯一声明点）
// ─────────────────────────────────────────────────────────────────────────────

/** 本矩阵覆盖的产物格式（`jpeg` 走的仍是 `image` 能力表，故不单列）。 */
export type ExportSemanticFormat = 'png' | 'gif' | 'obj'

/** 语义类别（稳定名；判据按它核对矩阵是否漏格）。 */
export type ExportSemanticKind =
  | 'transform'
  | 'deformation'
  | 'annotation-text'
  | 'animation-tracks'
  | 'texture-sequence'
  | 'geometry-skipped'
  | 'layered-stacking'
  | 'blend-approximation'

export interface ExportSemanticCell {
  readonly kind: ExportSemanticKind
  readonly code: ExportSemanticCode
  /** 为什么表达不了（人读；判据只读 `kind`/`code`）。 */
  readonly why: string
}

/**
 * **格式 × 不可表达语义**（唯一声明点）。
 *
 * 判据（`exportSemantics.test.ts`）把本表与"按实测列出的期望表"逐格比对：
 * 删掉一格 ⇒ 判红；加一格却没生产者 ⇒ 判红（生产者断言在同一文件里）。
 */
function cell(kind: ExportSemanticKind, code: ExportSemanticCode, why: string): ExportSemanticCell {
  return Object.freeze({ kind, code, why })
}

export const EXPORT_SEMANTIC_MATRIX: Readonly<Record<ExportSemanticFormat, readonly ExportSemanticCell[]>> = Object.freeze({
  png: Object.freeze([
    cell('transform', EXPORT_SEMANTIC_CODES.capabilityUnsupported, '位图不含对象身份/变换字段；非整数格平移只能以像素近似'),
    cell('deformation', EXPORT_SEMANTIC_CODES.capabilityUnsupported, '固定拓扑形变没有可写回的表示'),
    cell('annotation-text', EXPORT_SEMANTIC_CODES.capabilityUnsupported, '注解文字不参与等轴渲染，位图里没有文本语义'),
    cell('animation-tracks', EXPORT_SEMANTIC_CODES.capabilityUnsupported, '静止图只有单帧；轨道在捕获时刻被冻结'),
  ]),
  gif: Object.freeze([
    cell('transform', EXPORT_SEMANTIC_CODES.capabilityUnsupported, 'GIF 的每一帧都只有像素，没有对象身份/变换字段可写回'),
    cell('deformation', EXPORT_SEMANTIC_CODES.capabilityUnsupported, '固定拓扑形变在任何单帧像素里都没有可复原的表示'),
    cell('annotation-text', EXPORT_SEMANTIC_CODES.capabilityUnsupported, '注解文字不参与等轴渲染，逐帧像素里没有文本语义'),
    cell('animation-tracks', EXPORT_SEMANTIC_CODES.capabilityUnsupported, 'GIF 只逐帧记录纹理序列的一个共同循环；轨道值不随时间写回'),
  ]),
  obj: Object.freeze([
    cell('texture-sequence', EXPORT_SEMANTIC_CODES.firstFrameOnly, 'OBJ 的 UV 映射到单张贴图；竖条多帧只能取首帧'),
    cell('geometry-skipped', EXPORT_SEMANTIC_CODES.geometrySkipped, '无几何/解码失败的体素没有面可写（此前只写注释行）'),
    cell('layered-stacking', EXPORT_SEMANTIC_CODES.layerStackUnexpressed, 'layered 模式的叠化顺序只在文件名与注释里；OBJ/MTL 没有合成规则'),
    cell('blend-approximation', EXPORT_SEMANTIC_CODES.blendApproximated, 'MTL 只有 d/illum，cutout 与 translucent 都只能近似'),
  ]),
})

/** 矩阵里某一格式的格（供判据与诊断两侧读同一份声明）。 */
export function semanticCellsOf(format: ExportSemanticFormat): readonly ExportSemanticCell[] {
  return EXPORT_SEMANTIC_MATRIX[format]
}

// ─────────────────────────────────────────────────────────────────────────────
// PNG / GIF：发布能力表（设计 §10.5：两个命令各一张表）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 等轴 PNG 的能力声明。
 *
 * - `canExpressTransformExtras: true`：等轴渲染**按变换绘制**（任意位置/旋转都进画面），
 *   故 `LegacyExportUnsupportedTransform/Pivot` 对 PNG **不是**损失 —— 若照抄
 *   "旧格式表达不了"会给每一次正常导出刷假诊断；
 * - `deformations: ['none']`：内核呈现不消费固定拓扑形变 ⇒ 形变确实表达不了；
 * - `canExpressText: false`：注解文字不在渲染链里；
 * - `animatableProperties: []`：静止图没有时间维。
 */
export const PNG_PUBLISH_CAPABILITIES: PublishCapabilities = Object.freeze({
  geometry: Object.freeze(['baked-quads']),
  deformations: Object.freeze(['none']),
  canExpressText: false,
  canExpressTransformExtras: true,
  animatableProperties: Object.freeze([]) as readonly string[],
})

/** 场景 GIF 的能力声明（与 PNG 同一张语义表：GIF 只是多帧像素）。 */
export const GIF_PUBLISH_CAPABILITIES: PublishCapabilities = Object.freeze({
  geometry: Object.freeze(['baked-quads']),
  deformations: Object.freeze(['none']),
  canExpressText: false,
  canExpressTransformExtras: true,
  animatableProperties: Object.freeze([]) as readonly string[],
})

/** 能力项 → 诊断事实（**唯一**映射点；类别/原因/对象逐项带出）。 */
export function capabilityFindingOf(item: CapabilityReportItem): ExportSemanticFinding {
  return Object.freeze({
    code: EXPORT_SEMANTIC_CODES.capabilityUnsupported,
    // `objectId` 同时进 **params**（诊断数据自带归属）与 correlation（可按下标查）：
    // SPEC §9 要求"逐项报告"，而 `objectId` 与 `reason` 是那一条的**结构化**主键。
    params: Object.freeze({ category: item.category, reason: item.reason, objectId: item.objectId, ...item.detail }),
    objectId: item.objectId,
  })
}

/**
 * **静止/GIF 导出**的不可表达语义（捕获后、预检前调用）。
 *
 * 空数组 = 这次快照被目标格式**完全表达**（可以正常导出）。
 */
export function stillExportSemantics(
  request: ExportRequest,
  format: 'png' | 'gif',
): readonly ExportSemanticFinding[] {
  const table = format === 'png' ? PNG_PUBLISH_CAPABILITIES : GIF_PUBLISH_CAPABILITIES
  return Object.freeze(capabilityReport(request, table).map(capabilityFindingOf))
}

// ─────────────────────────────────────────────────────────────────────────────
// OBJ：装配期事实（`workbench/export/bundleMeshAssembly` 产出，本文件只映射）
// ─────────────────────────────────────────────────────────────────────────────

/** 一个"竖条动画纹理只用了首帧"的 blob（按图集槽位归并）。 */
export interface BundleTextureFirstFrameFact {
  readonly blobIndex: number
  /** 该 blob 的竖条格数（`height / width`）。 */
  readonly frameCount: number
  /** 指向该 blob 的材质下标（结构化归属；空数组 = 推不出来）。 */
  readonly materialIndices: readonly number[]
}

/** 一个"被跳过的体素族"（registry 键 + 原因 + 体素数）。 */
export interface BundleSkippedVoxelFact {
  readonly registryKey: string
  readonly reason: string
  readonly voxelCount: number
}

/** 一处"混合模式只能近似"的材质。 */
export interface BundleBlendApproximationFact {
  readonly materialName: string
  readonly blend: string
}

/** layered 模式的叠化层数（OBJ/MTL 没有合成规则，只能交回调用方）。 */
export interface BundleLayeredFact {
  readonly layerCount: number
}

/**
 * OBJ 装配期的**不可表达事实**（结构化、纯数据）。
 *
 * 它是"注释行"的替代物：`# skipped_unmapped_voxels=…` 这类信息以前只在产物字节里，
 * 机器与用户都读不到；现在一并产出这份报告，由命令写进诊断通道。
 */
export interface BundleSemanticReport {
  readonly firstFrameOnly: readonly BundleTextureFirstFrameFact[]
  readonly skippedUnmappedVoxels: number
  readonly skippedVoxels: readonly BundleSkippedVoxelFact[]
  /** 非空 = 本次是 layered 模式（多层 PNG 共享 UV，叠化规则不在产物里）。 */
  readonly layered: BundleLayeredFact | null
  readonly blendApproximations: readonly BundleBlendApproximationFact[]
}

/** 空报告（格式合法、事实为零——**不是**"没收集"，收集与否由报告是否被回调区分）。 */
export const EMPTY_BUNDLE_SEMANTIC_REPORT: BundleSemanticReport = Object.freeze({
  firstFrameOnly: Object.freeze([]),
  skippedUnmappedVoxels: 0,
  skippedVoxels: Object.freeze([]),
  layered: null,
  blendApproximations: Object.freeze([]),
})

/**
 * OBJ 报告 → 诊断事实（逐条结构化）。
 *
 * 顺序稳定：先首帧、再跳过体素（按 registry 键排序）、最后混合近似 —— 使同一份
 * 文档两次导出的诊断序列可对账（与 `capabilityReport` 的稳定排序同一动机）。
 */
export function objExportSemantics(report: BundleSemanticReport): readonly ExportSemanticFinding[] {
  // 顺序：首帧 → 跳过体素 → 分层 → 混合近似（稳定；同一次导出两次跑给同一序列）。
  const out: ExportSemanticFinding[] = []
  for (const t of report.firstFrameOnly) {
    out.push(
      Object.freeze({
        code: EXPORT_SEMANTIC_CODES.firstFrameOnly,
        params: Object.freeze({
          blobIndex: t.blobIndex,
          frameCount: t.frameCount,
          materials: t.materialIndices.join(','),
        }),
      }),
    )
  }
  if (report.skippedVoxels.length === 0 && report.skippedUnmappedVoxels > 0) {
    // 计数在但没有明细：仍然报（"有体素被丢"这件事不得因为明细缺失而消失）。
    out.push(
      Object.freeze({
        code: EXPORT_SEMANTIC_CODES.geometrySkipped,
        params: Object.freeze({ voxelCount: report.skippedUnmappedVoxels }),
      }),
    )
  }
  for (const s of [...report.skippedVoxels].sort((a, b) => a.registryKey.localeCompare(b.registryKey))) {
    out.push(
      Object.freeze({
        code: EXPORT_SEMANTIC_CODES.geometrySkipped,
        params: Object.freeze({ registryKey: s.registryKey, reason: s.reason, voxelCount: s.voxelCount }),
      }),
    )
  }
  if (report.layered !== null) {
    out.push(
      Object.freeze({
        code: EXPORT_SEMANTIC_CODES.layerStackUnexpressed,
        params: Object.freeze({ layerCount: report.layered.layerCount, compose: 'caller' }),
      }),
    )
  }
  for (const b of report.blendApproximations) {
    out.push(
      Object.freeze({
        code: EXPORT_SEMANTIC_CODES.blendApproximated,
        params: Object.freeze({ material: b.materialName, blend: b.blend, approximation: 'd+illum' }),
      }),
    )
  }
  return Object.freeze(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// 预检诊断 → 导出诊断事实
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 预检/作业的诊断项 → 导出通道的码。
 *
 * 未列出的码**不静默丢弃**：落到 `export.failed` 并保留原码作为 `params.reason`，
 * 于是"新加的预检码忘了映射"表现为一条可查的诊断，而不是一条消失的事实。
 */
export function findingOfExportDiagnostic(d: ExportDiagnostic): ExportSemanticFinding {
  const params: Record<string, string | number | boolean> = { ...d.detail, preflight: d.code }
  switch (d.code) {
    case 'ExportAssetNotReady':
      return Object.freeze({ code: 'export.assetNotReady' as const, params: Object.freeze(params) })
    case 'ExportCapabilityUnsupported':
      return Object.freeze({ code: EXPORT_SEMANTIC_CODES.capabilityUnsupported, params: Object.freeze(params) })
    case 'ExportKindUnsupported':
    case 'ExportEncodingNotConfigured':
      return Object.freeze({ code: 'export.encodingNotConfigured' as const, params: Object.freeze(params) })
    case 'ExportRequiresLossyMode':
      return Object.freeze({ code: 'export.requiresLossyMode' as const, params: Object.freeze(params) })
    case 'ExportTimeQuantized':
      return Object.freeze({ code: 'export.timeQuantized' as const, params: Object.freeze(params) })
    case 'ExportEmptyScene':
      return Object.freeze({ code: 'export.emptyScene' as const, params: Object.freeze(params) })
    default:
      return Object.freeze({ code: 'export.failed' as const, params: Object.freeze({ ...params, reason: d.code }) })
  }
}
