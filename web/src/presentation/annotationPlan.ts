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
      readonly frameThickness: number
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

// ─────────────────────────────────────────────────────────────────────────────
// 呈现缺省（政策，不是文档内容）
// ─────────────────────────────────────────────────────────────────────────────

/** 未声明颜色时的呈现缺省（与旧 `annotationMeshProvider` 的调用方缺省一致）。 */
export const DEFAULT_ANNOTATION_COLOR = '#ffffff'
export const DEFAULT_BOX_OPACITY = 1
export const DEFAULT_BOX_FILL_OPACITY = 0.15
export const DEFAULT_BOX_FRAME_THICKNESS = 0.03
export const DEFAULT_POINT_SIZE = 0.3
export const DEFAULT_LINE_THICKNESS = 0.05
export const DEFAULT_TEXT_FONT_SIZE = 14
export const DEFAULT_TEXT_BACKGROUND_ALPHA = 0.6
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
      primitives.push(
        Object.freeze({
          kind: 'point' as const,
          objectId: a.objectId,
          pos: Object.freeze(pos) as readonly [number, number, number],
          icon: g.icon ?? 'diamond',
          size: typeof g.size === 'number' && Number.isFinite(g.size) ? g.size : DEFAULT_POINT_SIZE,
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
