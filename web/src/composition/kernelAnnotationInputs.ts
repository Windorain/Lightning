/**
 * `composition/kernelAnnotationInputs` —— **内核注解 → 呈现规划输入**（#289 P10d D3b）。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | `render/mesh/annotationMeshProvider` 直接读 legacy `Annotation[]` 造 `THREE.Group` | `render/mesh/annotationMeshProvider.ts` | 内核 `ObjectDataPayload{kind:'annotation'}` → `AnnotationInput[]` → `compileAnnotations`（**已交付、此前零生产消费者**） |
 *
 * ## 为什么必须有它（实测的接线缺口）
 *
 * 侦察实测：`presentation/annotationPlan` 的生产消费者是 **0**
 * （唯一消费者是它自己的测试 `annotationOutlinePlan.test.ts`）。
 * 即 D1 交付了**规划器**（纯、有判据）却**没有接线** —— 与 D3a 的纹理链同构。
 *
 * 本模块是那条接线：把内核承载的注解翻译成规划器的入参。
 *
 * ## 为什么这里能读内核（分层）
 *
 * `composition/` 是**装配根**（`#249 §4`：允许 import 全部层），故它可以同时碰
 * `domain/scene`（内核类型）与 `presentation/annotationPlan`（规划器）。
 * 反向不行 —— 那会让 `presentation/` 依赖内核遗留类型（正是 §15 要退役的）。
 *
 * ## 纯性
 *
 * 无 IO、无 three、无时钟：输入内核场景、输出纯数据。
 */

import type { Scene, ObjectDataPayload } from '@/domain/scene'
import type { AnnotationGeometry } from '@/domain/scene'
import type { AnnotationInput, AnnotationShape } from '@/presentation/annotationPlan'

/** 内核注解载荷支持的形状（与 `ObjectDataPayload.annotation.shape` **同一联合**）。 */
const ANNOTATION_SHAPES: readonly AnnotationShape[] = Object.freeze(['box', 'point', 'line', 'text', 'face'])

/**
 * 内核场景 → `AnnotationInput[]`（呈现规划器的入参）。
 *
 * ## 逐字段映射
 *
 * | 规划器要的 | 内核给的 | 说明 |
 * |---|---|---|
 * | `objectId` | 场景里的对象 id | 规划器用它做 `objectId` 归属（拾取/诊断） |
 * | `shape` | `payload.shape` | 类型同源（两边都是 `'box'｜'point'｜'line'｜'text'｜'face'`） |
 * | `text` | `payload.text ?? ''` | 规划器约定 `''` = 无文本 |
 * | `visible` | **恒 `true`** | 见下 |
 * | `geometry` | `payload.geometry` | 缺省 = 该注解无几何参数（规划器**不**产出几何图元） |
 *
 * ## `visible` 为什么恒 `true`（而不是从内核读）
 *
 * 内核 `ObjectDataPayload.annotation` **没有** `visible` 字段 —— 可见性是**视口状态**
 * （哪个视口、什么分层预览下显示），不是文档内容。旧模型的 `visible` 挂在注解上
 * 正是"视口状态混进文档内容"的一例。
 *
 * ⇒ 本函数如实填 `true`（"内容层面没有隐藏这一说"），把"该不该显示"留给
 * **调用方按视口状态过滤**。这与 #249 §3.3「声明与取值是输入、呈现是产物」一致：
 * 可见性属呈现决策，不属文档声明。
 *
 * ## 哪些对象被跳过（**显式**报告）
 *
 * 非 `annotation` 载荷（`blockGrid`/`camera`/`mesh`）由各自的呈现路径负责，
 * 故这里跳过并**报出原因** —— 不静默。
 */
export function kernelAnnotationInputs(scene: Scene): {
  readonly inputs: readonly AnnotationInput[]
  readonly skipped: readonly { readonly objectId: string; readonly reason: string }[]
} {
  const inputs: AnnotationInput[] = []
  const skipped: { objectId: string; reason: string }[] = []

  for (const objectId of scene.order) {
    const obj = scene.objects[objectId]
    if (obj === undefined) continue
    const data = scene.data[obj.dataId]
    if (data === undefined) {
      skipped.push({ objectId, reason: 'data-missing' })
      continue
    }
    const payload: ObjectDataPayload = data.payload
    if (payload.kind !== 'annotation') {
      skipped.push({ objectId, reason: `not-annotation:${payload.kind}` })
      continue
    }
    if (!ANNOTATION_SHAPES.includes(payload.shape)) {
      // 类型上不可达，但**留一条**运行期守卫：内核载荷可能来自手写 JSON（解析期未校验），
      // 而"形状不认识"若静默当 box 处理会画出错的东西。
      skipped.push({ objectId, reason: `unsupported-shape:${String(payload.shape)}` })
      continue
    }
    inputs.push(
      Object.freeze({
        objectId,
        shape: payload.shape,
        text: payload.text ?? '',
        visible: true,
        ...(payload.geometry === undefined ? {} : { geometry: payload.geometry as AnnotationGeometry }),
      }),
    )
  }
  return { inputs: Object.freeze(inputs), skipped: Object.freeze(skipped) }
}
