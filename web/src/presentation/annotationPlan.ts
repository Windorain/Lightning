/**
 * `presentation/annotationPlan` —— **注解 → 呈现图元**（#289 P10d）。
 *
 * ## 本模块补什么（P10c 实测缺口）
 *
 * P10c（#286）对 `presentation/` 的实测结论：
 *
 * > `presentation/` 也**没有**注解/描边/拾取渲染（`annotationMeshProvider`、
 * > `SelectionOutlinePass`、`scenePick` 均零引用）。
 *
 * 而"注解渲染"在旧链里是 `render/mesh/annotationMeshProvider` 的 320 行实现
 * （5 种形状 × 各自的呈现参数）。内核取得注解几何承载后
 * （`domain/scene#AnnotationGeometry`），呈现层需要一条**纯数据**的通路，
 * 否则注解在新通道下依然画不出来。
 *
 * ## 判据：本模块只做**图元分解**，不做三角化
 *
 * 三角化（线宽、盒的 12 条棱、文字的位图排布）依赖具体后端与字体，属
 * "有副作用的 GPU 上传"那一侧。本模块产出的是**与后端无关的图元描述**
 * （{@link AnnotationPrimitive}），于是：
 *  - 5 种形状的**呈现参数解析**（哪些字段对哪种形状有意义）可在 vitest 里断言；
 *  - 三角化留在 `presentation/presenter`（那里已经会建 `BufferGeometry`）。
 *
 * ## 与 `domain/scene#AnnotationGeometry` 的分工（**不是**重复）
 *
 * | 层 | 回答什么 |
 * |---|---|
 * | `domain/` | 文件里**写了**什么（22 个可选字段，与 shape 解耦） |
 * | 本模块 | 按 shape **该读哪些**、缺省值是什么、合成出什么图元 |
 *
 * "缺省值"属**呈现政策**（改缺省值不改文档内容），故它在呈现层而不是领域层 ——
 * 这与 `domain/content` 把 `TextureAnimationSpec` 留在领域、而把采样规则放在
 * `domain/materials` 的同一分工逻辑（"声明 vs 怎么用"）。
 *
 * ## 纯度
 *
 * 不 import three、不碰 DOM、不读时钟（`presentation-purity` 闸门覆盖本文件）。
 */

import type { AnnotationGeometry } from '@/domain/scene'

/** 与文件格式一致的注解形状（`context/parsers` 的 `ANNOTATION_SHAPES` 同集合）。 */
export type AnnotationShape = 'box' | 'point' | 'line' | 'text' | 'face'

/** 一个注解的**呈现输入**（装配产物的对象 + 载荷）。 */
export interface AnnotationInput {
  readonly objectId: string
  readonly shape: AnnotationShape
  /** 语义文本（title + description 的合成；`''` = 无）。 */
  readonly text: string
  readonly visible: boolean
  /** 呈现几何参数；缺省 = 该注解无几何参数（不产出几何图元）。 */
  readonly geometry?: AnnotationGeometry
}

/**
 * 注解的**呈现图元**（与后端无关的纯描述）。
 *
 * `kind` 决定呈现侧用哪条三角化路径；`params` 是该路径的参数（各形状不同）。
 * 用判别式联合而不是一个宽结构：后者会让"一个 box 图元带着 `arrow` 字段"
 * 在类型上可表达，而那是无意义的组合。
 */
export type AnnotationPrimitive =
  | {
      readonly kind: 'box'
      readonly objectId: string
      readonly min: readonly [number, number, number]
      readonly max: readonly [number, number, number]
      readonly renderStyle: 'wireframe' | 'boxFrame' | 'translucent'
      readonly color: string
      readonly opacity: number
      readonly fillOpacity: number
      /** `boxFrame` 的框杆厚度（缺省见 `DEFAULT_BOX_FRAME_THICKNESS`）。 */
      readonly frameThickness: number
      /**
       * `wireframe` / `translucent` 的**杆厚** —— 与 legacy 硬编码 `0.02` 一致。
       *
       * ## 为什么需要这个字段（本批 #289 D3b 抓出的**表达力缺口**）
       *
       * legacy 在 `annotationMeshProvider:102`/`:113` 把杆厚**硬编码**成 `0.02`
       * （它没有参数名，故旧模型的 `BoxAnnotation` 类型里也没有这个字段）。
       * 若规划器不表达它，"规划器 → 呈现"这条路就**无法**画出与 legacy
       * 逐像素一致的 wireframe（呈现侧只能猜一个数）。
       *
       * ⇒ 补一个显式字段。这不是"新增视觉政策"，而是**把 legacy 已有的行为
       * 纳入类型**（值取 legacy 的 `0.02`，见 `DEFAULT_BOX_WIREFRAME_THICKNESS`）。
       */
      readonly wireframeThickness: number
      /** `true` = 画在覆盖层（不写深度），`false` = 参与世界深度（见旧实现的同一判据）。 */
      readonly overlay: boolean
    }
  | {
      readonly kind: 'point'
      readonly objectId: string
      readonly pos: readonly [number, number, number]
      readonly icon: 'diamond' | 'circle' | 'square' | 'cross'
      readonly size: number
      readonly color: string
      readonly opacity: number
      readonly overlay: boolean
    }
  | {
      readonly kind: 'line'
      readonly objectId: string
      readonly points: readonly (readonly [number, number, number])[]
      readonly thickness: number
      readonly arrow: 'none' | 'start' | 'end' | 'both'
      readonly showPoints: boolean
      readonly color: string
      readonly opacity: number
      readonly overlay: boolean
    }
  | {
      readonly kind: 'text'
      readonly objectId: string
      readonly anchor: readonly [number, number, number]
      readonly text: string
      readonly fontSize: number
      readonly backgroundAlpha: number
      readonly color: string
      readonly opacity: number
      readonly overlay: boolean
    }
  | {
      readonly kind: 'face'
      readonly objectId: string
      readonly blockPos: readonly [number, number, number]
      readonly quadIndex: number
      readonly color: string
      readonly opacity: number
      readonly overlay: boolean
    }

/** 一次注解编译的产物。 */
export interface AnnotationCompiled {
  readonly primitives: readonly AnnotationPrimitive[]
  /**
   * **被跳过**的注解（几何不可用或不满足该形状的必需参数）—— 显式报告，不静默丢
   * （A36/G4：「必需资源未就绪不得假装完整」的同族要求：少画一个注解必须是可见事实）。
   */
  readonly skipped: readonly { readonly objectId: string; readonly reason: AnnotationSkipReason; readonly detail: string }[]
}

export type AnnotationSkipReason =
  /** 该注解不可见（`visible === false`）—— 正常的跳过，不是缺陷。 */
  | 'invisible'
  /** 无几何参数（内核只承载了语义数据）。 */
  | 'noGeometry'
  /** 该形状的**必需**参数缺失（例如 box 缺 `min`/`max`）。 */
  | 'incompleteGeometry'
  /** 坐标含非有限分量（几何契约 §1：非有限值不参与几何）。 */
  | 'nonFinite'
  /**
   * 该形状的**呈现尺寸**缺失（当前只有 point 的 `size`）。
   *
   * ## 为什么它是独立原因（而不是并进 `incompleteGeometry`）
   *
   * 两者的处置不同：`incompleteGeometry` 是"该形状**画不出来**"（缺 min/max ⇒ 没有盒），
   * 而本项是"形状齐了、**尺寸没给**"。把它并进去会让诊断说不出"缺的是尺寸"
   * —— 而本项的存在理由正是**精确**：见下方 `point` 分支的说明（#289 P10d D3b 裁决 D4-a）。
   */
  | 'missingSize'

// ─────────────────────────────────────────────────────────────────────────────
// 呈现缺省（政策，不是文档内容）
// ─────────────────────────────────────────────────────────────────────────────

/** 未声明颜色时的呈现缺省（与旧 `annotationMeshProvider` 的调用方缺省一致）。 */
export const DEFAULT_ANNOTATION_COLOR = '#ffffff'
export const DEFAULT_BOX_OPACITY = 1
export const DEFAULT_BOX_FILL_OPACITY = 0.15
/**
 * box 框杆缺省厚度 —— **与 legacy 逐位一致**（`annotationMeshProvider:125`
 * 的 `(a.frameThickness ?? 0.04) / 2`，legacy 实测值 `0.04`）。
 *
 * 本值第一版误写为 `0.03`（本批 #289 D3b 侦察实测抓出的分歧之一）。
 * 按 Lead 裁决「以 legacy 为准」改回 —— **逐像素一致是终切的硬判据**，
 * 视觉政策的"顺手修正"不属于架构迁移的范围（要有意的视觉变更须作为独立决定提出）。
 * ⇒ **改这个值需要独立裁决**，不得夹在架构迁移里。
 */
export const DEFAULT_BOX_FRAME_THICKNESS = 0.04
/**
 * wireframe / translucent 的**杆厚** —— 与 legacy 硬编码 `0.02` 一致
 * （`annotationMeshProvider:102`/`:113` 的 `_buildWireframeBars(..., 0.02, ...)`）。
 *
 * legacy 把这两个数**硬编码**在调用点，故该参数在旧模型里没有名字、也没有类型字段；
 * 本批（#289 D3b）为它补一个**显式字段**：否则"规划器 → 呈现"这条路
 * **无法表达** legacy 的 wireframe 杆厚（表达力缺口，不是数值分歧）。
 * 加字段不需要 #250 契约流程 —— `annotationPlan` 是本批（#289）自己的交付物。
 */
export const DEFAULT_BOX_WIREFRAME_THICKNESS = 0.02
// ⚠️ 这里**曾**有 `DEFAULT_POINT_SIZE = 0.3`，本批（#289 D3b 裁决 D4-a）**删除**。
//
// 删除理由不是"没人用了"，而是**留着它会邀请错误的默认行为回来**：
// legacy 的 `_buildPoint` 对 `size` **没有兜底**（`annotationMeshProvider:195`
// 直接 `a.size * 0.1`），故缺 `size` ⇒ NaN 几何 ⇒ 屏幕上无输出；而 0.3 会画出
// 一个可见的点。法是"跳过 + 诊断"（见 `compileAnnotations` 的 point 分支）。
// 保留一个用不到的常量，下一个人会以为"缺省就该是 0.3"。
export const DEFAULT_LINE_THICKNESS = 0.05
export const DEFAULT_TEXT_FONT_SIZE = 14
/**
 * 文字背景透明度缺省 —— **与 legacy 逐位一致**（`annotationMeshProvider:231` 的
 * `(a.backgroundAlpha ?? 0xCC) / 255`，即 `204 / 255 ≈ 0.8`）。
 *
 * 本值第一版误写为 `0.6`（D3b 侦察实测抓出的分歧之一），按「以 legacy 为准」改回。
 * **改这个值需要独立裁决。**
 */
export const DEFAULT_TEXT_BACKGROUND_ALPHA = 0xcc / 255
export const DEFAULT_FACE_OPACITY = 0.55

// ─────────────────────────────────────────────────────────────────────────────
// 编译
// ─────────────────────────────────────────────────────────────────────────────

function finiteTriple(v: { readonly x: number; readonly y: number; readonly z: number } | undefined): [number, number, number] | null {
  if (v === undefined) return null
  if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) return null
  return [v.x, v.y, v.z]
}

/** 各形状的必需参数（缺失 ⇒ `incompleteGeometry`，**不**用缺省值糊过去）。 */
const REQUIRED: Readonly<Record<AnnotationShape, readonly string[]>> = Object.freeze({
  box: Object.freeze(['min', 'max']),
  point: Object.freeze(['pos']),
  // 线至少两个点才是一条线；一个点退化成一个点图元（那是 point 的职责，不是 line 的）
  line: Object.freeze(['points']),
  text: Object.freeze(['pos']),
  face: Object.freeze(['blockPos']),
})

/**
 * 编译一批注解为呈现图元（**纯函数**）。
 *
 * 顺序 = 输入顺序（注解的绘制顺序影响半透明重叠结果，故不排序）。
 */
export function compileAnnotations(inputs: readonly AnnotationInput[]): AnnotationCompiled {
  const primitives: AnnotationPrimitive[] = []
  const skipped: { objectId: string; reason: AnnotationSkipReason; detail: string }[] = []
  for (const a of inputs) {
    if (!a.visible) {
      skipped.push({ objectId: a.objectId, reason: 'invisible', detail: '注解不可见（正常跳过）' })
      continue
    }
    const g = a.geometry
    if (g === undefined) {
      skipped.push({ objectId: a.objectId, reason: 'noGeometry', detail: '该注解无呈现几何参数（内核只承载语义数据）' })
      continue
    }
    // box 的 `renderStyle: 'hidden'` 是**显式隐藏**（旧实现的 `_buildBox` 首行同判据）。
    if (a.shape === 'box' && g.renderStyle === 'hidden') {
      skipped.push({ objectId: a.objectId, reason: 'invisible', detail: 'renderStyle = hidden（显式隐藏）' })
      continue
    }
    const missing = REQUIRED[a.shape].filter((k) => (g as Record<string, unknown>)[k] === undefined)
    if (missing.length > 0) {
      skipped.push({
        objectId: a.objectId,
        reason: 'incompleteGeometry',
        detail: `${a.shape} 注解缺必需几何参数：${missing.join('、')}`,
      })
      continue
    }

    const color = typeof g.color === 'string' && g.color !== '' ? g.color : DEFAULT_ANNOTATION_COLOR
    const overlay = g.overlay === true
    const opacity = typeof g.renderOpacity === 'number' && Number.isFinite(g.renderOpacity) ? g.renderOpacity : 1

    if (a.shape === 'box') {
      const min = finiteTriple(g.min)
      const max = finiteTriple(g.max)
      if (min === null || max === null) {
        skipped.push({ objectId: a.objectId, reason: 'nonFinite', detail: 'box 的 min/max 含非有限分量' })
        continue
      }
      const style = g.renderStyle ?? 'boxFrame'
      primitives.push(
        Object.freeze({
          kind: 'box' as const,
          objectId: a.objectId,
          min: Object.freeze(min) as readonly [number, number, number],
          max: Object.freeze(max) as readonly [number, number, number],
          // `hidden` 已在上面短路，故这里的联合不含它 —— 呈现侧因此**不可能**
          // 收到一个"隐藏的盒"（少一个需要下游重复判断的分支）。
          renderStyle: (style === 'wireframe' || style === 'translucent' ? style : 'boxFrame') as 'wireframe' | 'boxFrame' | 'translucent',
          color,
          opacity,
          fillOpacity: typeof g.fillOpacity === 'number' && Number.isFinite(g.fillOpacity) ? g.fillOpacity : DEFAULT_BOX_FILL_OPACITY,
          frameThickness: typeof g.frameThickness === 'number' && Number.isFinite(g.frameThickness) ? g.frameThickness : DEFAULT_BOX_FRAME_THICKNESS,
          // wireframe 杆厚：legacy 硬编码 0.02，无输入字段可读 ⇒ 恒取该缺省
          // （加字段是为了**表达**它，不是为了让它可配 —— 可配会成为新的视觉政策）。
          wireframeThickness: DEFAULT_BOX_WIREFRAME_THICKNESS,
          overlay,
        }),
      )
      continue
    }

    if (a.shape === 'point') {
      const pos = finiteTriple(g.pos)
      if (pos === null) {
        skipped.push({ objectId: a.objectId, reason: 'nonFinite', detail: 'point 的 pos 含非有限分量' })
        continue
      }
      // ## 缺 `size` ⇒ **跳过 + 结构化诊断**（#289 P10d D3b 裁决 D4-a）
      //
      // ### 为什么不是"给个默认值"
      //
      // legacy 的 `_buildPoint`（`annotationMeshProvider:195`）**没有兜底**：
      // 它直接取 `a.size * 0.1`。故 `size` 缺失时渲染出的是 **`NaN` 几何**
      // —— 在屏幕上等于**什么都没画**。
      //
      // 第一版这里回落到 `DEFAULT_POINT_SIZE = 0.3`，那会让它**画出一个可见的点**。
      // 两种行为在屏幕上不同（无输出 vs 有点），故"给默认值"是**偷渡视觉变更**，
      // 而"有没有东西"比样式差异更重（不能夹在架构迁移里）。
      //
      // ### 为什么也不是"把 legacy 的 NaN 照搬"
      //
      // 照搬会把缺陷**固化成判据**，且向 `Float32Array` 写 `NaN` 是隐雷
      // （NaN 会污染下游的包围盒/拾取计算，表现为"某处莫名不工作"）。
      //
      // ### 取第三条：**都不画，但把原因说出来**
      //
      // 跳过 ⇒ 屏幕结果与 legacy **逐像素一致**（都是无输出）；
      // 结构化诊断 ⇒ 缺陷**可见**（不静默）。判据因此是精确的
      // （"缺 size ⇒ 无输出 + 诊断在位"），不是"例外清单"。
      //
      // 将来若有人想给 point 补默认值，那是**独立的视觉政策裁决**，不在本批范围。
      const size = g.size
      if (typeof size !== 'number' || !Number.isFinite(size)) {
        skipped.push({
          objectId: a.objectId,
          reason: 'missingSize',
          detail: 'point 缺 `size`（或非有限）⇒ 不产出图元；legacy 同输入渲染 NaN 几何（屏幕上亦无输出）',
        })
        continue
      }
      primitives.push(
        Object.freeze({
          kind: 'point' as const,
          objectId: a.objectId,
          pos: Object.freeze(pos) as readonly [number, number, number],
          icon: g.icon ?? 'diamond',
          size,
          color,
          opacity,
          overlay,
        }),
      )
      continue
    }

    if (a.shape === 'line') {
      const raw = g.points ?? []
      const pts: [number, number, number][] = []
      let bad = false
      for (const p of raw) {
        const t = finiteTriple(p)
        if (t === null) {
          bad = true
          break
        }
        pts.push(t)
      }
      if (bad || pts.length < 2) {
        skipped.push({
          objectId: a.objectId,
          reason: bad ? 'nonFinite' : 'incompleteGeometry',
          detail: bad ? 'line 的 points 含非有限分量' : `line 只有 ${pts.length} 个有效点（至少 2）`,
        })
        continue
      }
      primitives.push(
        Object.freeze({
          kind: 'line' as const,
          objectId: a.objectId,
          points: Object.freeze(pts.map((p) => Object.freeze(p) as readonly [number, number, number])),
          thickness: typeof g.thickness === 'number' && Number.isFinite(g.thickness) ? g.thickness : DEFAULT_LINE_THICKNESS,
          arrow: g.arrow ?? 'none',
          showPoints: g.showPoints === true,
          color,
          opacity,
          overlay,
        }),
      )
      continue
    }

    if (a.shape === 'text') {
      const anchor = finiteTriple(g.pos)
      if (anchor === null) {
        skipped.push({ objectId: a.objectId, reason: 'nonFinite', detail: 'text 的锚点含非有限分量' })
        continue
      }
      primitives.push(
        Object.freeze({
          kind: 'text' as const,
          objectId: a.objectId,
          anchor: Object.freeze(anchor) as readonly [number, number, number],
          // 文本的**语义**来源是载荷的 `text`（title+description 合成）；`geometry` 里没有文本。
          text: a.text,
          fontSize: typeof g.fontSize === 'number' && Number.isFinite(g.fontSize) ? g.fontSize : DEFAULT_TEXT_FONT_SIZE,
          backgroundAlpha:
            typeof g.backgroundAlpha === 'number' && Number.isFinite(g.backgroundAlpha)
              ? g.backgroundAlpha
              : DEFAULT_TEXT_BACKGROUND_ALPHA,
          color,
          opacity,
          overlay,
        }),
      )
      continue
    }

    // face
    const blockPos = finiteTriple(g.blockPos)
    if (blockPos === null) {
      skipped.push({ objectId: a.objectId, reason: 'nonFinite', detail: 'face 的 blockPos 含非有限分量' })
      continue
    }
    primitives.push(
      Object.freeze({
        kind: 'face' as const,
        objectId: a.objectId,
        blockPos: Object.freeze(blockPos) as readonly [number, number, number],
        quadIndex: typeof g.quadIndex === 'number' && Number.isFinite(g.quadIndex) ? g.quadIndex : 0,
        color,
        opacity: typeof g.renderOpacity === 'number' && Number.isFinite(g.renderOpacity) ? g.renderOpacity : DEFAULT_FACE_OPACITY,
        overlay,
      }),
    )
  }
  return Object.freeze({ primitives: Object.freeze(primitives), skipped: Object.freeze(skipped) })
}

/**
 * 覆盖层 / 世界层分组（旧 `partitionAnnotationsForRender` 的语义）。
 *
 * ## 为什么分组是**呈现**问题而不是领域问题
 *
 * 分组的判据是「这个注解要不要参与深度测试」（`overlay: true` ⇒ `depthTest: false`
 * + `renderOrder: 999`，见旧实现的 `_buildBox`）。那是**怎么画**，不是"文件里写了什么"。
 * ⇒ 归呈现层，且与 `compileAnnotations` 分开：分组可以在编译**后**做
 * （图元已经带上 `overlay` 字段）。
 */
export function partitionAnnotationPrimitives(
  primitives: readonly AnnotationPrimitive[],
): Readonly<{ world: readonly AnnotationPrimitive[]; overlay: readonly AnnotationPrimitive[] }> {
  const world: AnnotationPrimitive[] = []
  const overlay: AnnotationPrimitive[] = []
  for (const p of primitives) (p.overlay ? overlay : world).push(p)
  return Object.freeze({ world: Object.freeze(world), overlay: Object.freeze(overlay) })
}

/** 覆盖层的绘制顺序常量（与旧实现 `renderOrder = 999` 同一口径）。 */
export const ANNOTATION_OVERLAY_RENDER_ORDER = 999
