/**
 * `runtime/annotationRead` —— **内核侧表的读取面**（#301 P10f C′1；N4 的字段完备部分）。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | `doc.annotations` / `doc.materialPalette` / `doc.textureBlobs` | `context/queries.ts:31`、`:204` | {@link kernelAnnotationsOf} / {@link kernelMaterialsOf} |
 *
 * ## ⚠️ 范畴声明（哪些字段**已**承载、哪些**没有**）—— 这是本批的边界
 *
 * 实测内核承载面的**真实**字段集（`domain/scene#AnnotationGeometry` +
 * `composition/kernelAssembly#annotationGeometryFromLegacy`）：
 *
 * | 旧字段 | 内核承载 | 证据 |
 * |---|---|---|
 * | `min`/`max`/`pos`/`points`/`blockPos`/`quadIndex` | ✅ | `AnnotationGeometry` |
 * | `color`/`renderStyle`/`renderOpacity`/`fillOpacity`/`frameThickness` | ✅ | 同上 |
 * | `overlay`/`icon`/`size`/`thickness`/`arrow`/`showPoints`/`fontSize`/`backgroundAlpha` | ✅ | 同上 |
 * | **`locked`** / **`frameIndex`** / **`created_at`** / **`updated_at`** | ✅ | 同上（`locked`/`frameIndex`/`createdAt`/`updatedAt`） |
 * | `title`/`description` | ✅（合成 `text`） | `annotationObjects` 的合成规则 |
 * | `id`/`type`/`visible` | ✅ | 对象身份与 `visible` |
 *
 * ⇒ **注解侧表在字段层面是完备的**（与我在中段汇报里的初判**不同** —— 那次我看的是
 * `ReadView.objects` 的投影面，而投影面比**承载面**窄。承载面才是真相；
 * 这条更正已如实回报）。
 *
 * ## 为什么读面在 `runtime/` 而不是 `composition/`
 *
 * 与 `kernelGridRead`（B′ 的网格读面）**不同**：那份产物需要 `projectToLegacyGrid`
 * （在 `composition/`），故必须落在装配根。本模块只做**字段改名与形状适配**
 * （`created_at` → `createdAt`、`min/max` 封装），**不依赖任何 composition 模块**
 * ⇒ 落在 `runtime/`，于是 `runtime/kernelSession` 可以直接用它
 * （`KERNEL_FILES` 约束：内核文件不得 import 装配根）。
 *
 * ⚠️ 但它**不**放进 `kernelSession.ts` 本身：那是内核会话的职责面（时间/订阅/装载），
 * 而侧表读取是一类**查询**。分开使"会话"与"查询面"各自演进。
 */
import type { Document } from '@/domain/document'
import type { AnnotationGeometry, ObjectDataPayload } from '@/domain/scene'

/** 一条注解的**读面形状**（与 legacy `Annotation` 的消费字段对齐）。 */
export interface KernelAnnotationView {
  readonly id: string
  readonly type: string
  readonly visible: boolean
  readonly title: string
  readonly description: string
  /** 呈现几何与逐条事实（字段名按 legacy 口径；`undefined` = 源里没有）。 */
  readonly min?: { x: number; y: number; z: number }
  readonly max?: { x: number; y: number; z: number }
  readonly pos?: { x: number; y: number; z: number }
  readonly points?: readonly { x: number; y: number; z: number }[]
  readonly color?: string
  readonly renderStyle?: string
  readonly locked?: boolean
  readonly frameIndex?: number
  readonly createdAt?: number
  readonly updatedAt?: number
}

/** 一条材质资源的读面形状（与 legacy `materialPalette` 条目对齐）。 */
export interface KernelMaterialView {
  readonly materialId: string
  readonly kind: string
  readonly blend: unknown
  readonly locator: unknown
  readonly emissive: unknown
  readonly animation: unknown
  readonly textureDataUrl: string | null
  readonly atlas: unknown
  readonly linear: unknown
  readonly useMipmaps: unknown
}

/** 注解对象 id 的前缀（与 `kernelAssembly#annotationObjects` 的建法一致）。 */
const ANNOTATION_ID_PREFIX = 'annotation:'

/** 把 `text` 反向拆回 `title` / `description`（正向合成的逆）。 */
function splitAnnotationText(text: string): { title: string; description: string } {
  const [title, ...rest] = text.split('\n\n')
  return { title: title ?? '', description: rest.join('\n\n') }
}

function annotationPayloadOf(doc: Document, objectId: string): Extract<ObjectDataPayload, { kind: 'annotation' }> | null {
  const obj = doc.scene.objects[objectId]
  if (obj === undefined || obj.type !== 'annotation') return null
  const data = doc.scene.data[obj.dataId]
  if (data === undefined || data.payload.kind !== 'annotation') return null
  return data.payload
}

/**
 * **读全部注解**（类型 / 可见性 / 标题 / 描述 / 几何）。
 *
 * 顺序与 `scene.order` 一致（装配产物的顺序即源顺序）—— 顺序是消费者的语义
 * （面板按源序显示），故不排序。
 */
export function kernelAnnotationsOf(doc: Document | undefined): readonly KernelAnnotationView[] {
  if (doc === undefined) return EMPTY_ANNOTATIONS
  const out: KernelAnnotationView[] = []
  for (const objectId of doc.scene.order) {
    const payload = annotationPayloadOf(doc, objectId)
    if (payload === null) continue
    const obj = doc.scene.objects[objectId]!
    const { title, description } = splitAnnotationText(payload.text ?? '')
    const g = payload.geometry
    out.push(
      Object.freeze({
        id: objectId.startsWith(ANNOTATION_ID_PREFIX) ? objectId.slice(ANNOTATION_ID_PREFIX.length) : objectId,
        type: payload.shape,
        visible: obj.visible,
        title,
        description,
        ...(g === undefined ? {} : geometryFieldsOf(g)),
      }),
    )
  }
  return Object.freeze(out)
}

/**
 * 把 `AnnotationGeometry` 摊成读面字段。
 *
 * ⚠️ 逐字段显式转发（不整体展开）：`AnnotationGeometry` 是**封闭**形状，
 * 将来加字段时"读面是否也要暴露"应当是一个**决定**，而不是自动跟随。
 * 这条与 `adapters/files/fidelityRecord` 的 `_extra` 口径同源：
 * 自动带出去的字段没有人为它负责。
 */
function geometryFieldsOf(g: AnnotationGeometry): Partial<KernelAnnotationView> {
  const out: Record<string, unknown> = {}
  for (const key of ['min', 'max', 'pos'] as const) {
    const v = g[key]
    if (v !== undefined) out[key] = v
  }
  if (g.points !== undefined) out.points = g.points
  for (const key of ['color', 'renderStyle'] as const) {
    const v = g[key]
    if (v !== undefined) out[key] = v
  }
  if (g.locked !== undefined) out.locked = g.locked
  if (g.frameIndex !== undefined) out.frameIndex = g.frameIndex
  if (g.createdAt !== undefined) out.createdAt = g.createdAt
  if (g.updatedAt !== undefined) out.updatedAt = g.updatedAt
  return out as Partial<KernelAnnotationView>
}

const EMPTY_ANNOTATIONS: readonly KernelAnnotationView[] = Object.freeze([])

/**
 * **读全部材质资源**（与 legacy `materialPalette` 条目对齐）。
 *
 * ## 两处字段适配（各自有**机械**依据，不是"看着像"）
 *
 *  1. **`textureBlobIndex` → `payload`**：legacy 用"调色板条目里的下标"去
 *     `textureBlobs` 表取 base64；内核把字节**内联在资源上**（`payload`）——
 *     即"下标 + 旁表"这条间接层在内核侧不存在。读面因此直接给出 data URL。
 *  2. **`locator` → `ref.url`**：legacy 的 `locator` 是"资源位置"，内核叫 `url`
 *     （`ResourceRef` 明说它"**仅**用于取回，不参与身份"——语义相同）。
 *
 * ## `textureDataUrl` 的两种形态（与 legacy 逐字同口径）
 *
 * legacy 的 `getBlob` 对"已是 `data:` 的串"原样返回，否则补 `data:image/png;base64,`
 * 前缀。本函数保持**同一**规则（复制那段判断而不是"统一补前缀"——
 * 后者会把已是 data URL 的串二次加前缀，产出坏 URL）。
 */
export function kernelMaterialsOf(doc: Document | undefined): readonly KernelMaterialView[] {
  if (doc === undefined) return EMPTY_MATERIALS
  return Object.freeze(
    doc.content.resources.map((r, i) =>
      Object.freeze({
        materialId: String(i),
        kind: r.kind,
        blend: r.blend,
        locator: r.ref.url,
        emissive: r.emissive,
        animation: r.animation,
        textureDataUrl: dataUrlOf(r.payload),
        atlas: r.atlas,
        linear: r.linear,
        useMipmaps: r.useMipmaps,
      }),
    ),
  )
}

/** 与 legacy `listMaterials` 的 `getBlob` 逐字同规则。 */
function dataUrlOf(payload: string | null): string | null {
  if (payload === null) return null
  const t = payload.trim()
  if (t.startsWith('data:')) return t
  return `data:image/png;base64,${t}`
}

const EMPTY_MATERIALS: readonly KernelMaterialView[] = Object.freeze([])
