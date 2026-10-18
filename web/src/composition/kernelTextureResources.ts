/**
 * `composition/kernelTextureResources` —— **文档资源 → `TextureResource[]`（五态）**（#289 P10d D3a）。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | `buildMaterialLibrary(plainDoc)` 用 `Promise.all` + 逐项 `throw` 解码全部纹理 | `render/data/buildMaterialLibrary.ts`（**M8-5 已删除**） | 逐资源**五态**（`unrequested`/`loading`/`ready`/`missing`/`failed`），坏一张只坏那一张；**本模块是该字节解码的唯一生产链** |
 *
 * ## 为什么必须做（本批实测抓出的真缺陷）
 *
 * `buildMaterialLibrary` 的失败模式是**整库 reject**：
 *
 * ```ts
 * const textures = await Promise.all(fetchList.map(async (...) => { try { ... } catch (e) { throw ... } }))
 * ```
 *
 * 而调用方 `drwMeshPipeline:221-227` 捕获后把 `textureCache = null`。实测后果：
 * **57 张纹理里坏 1 张 ⇒ 整个视口无贴图**（`ALL-GOOD` 与 `ONE-BAD` 给出同一条错误）。
 * 那不是"这张缺了"，而是"全部缺了" —— 且**用户看不出是哪张、也不知道坏在哪**。
 *
 * D1 已交付 `textureBinding` 的五态模型与 `missingRequiredAssets()`，**正是**为这个缺口
 * 准备的（#249 §19.3 逐字要求区分"未请求/加载中/可用/缺失/失败"），但它**零生产接线**。
 * 本模块就是那条缺失的接线：产出五态资源表，让"缺哪一张"成为**可查询的事实**。
 *
 * ## 与 `TextureBinding` 的分工
 *
 * | 类型 | 回答 |
 * |---|---|
 * | `TextureResource`（本模块产出） | 这份资源**现在**什么状态、字节在不在 |
 * | `TextureBinding`（`bindTexture` 产出） | 这份**材质**配哪张纹理（内容身份，不含 locator） |
 *
 * ## 分层
 *
 * `adapters/files/plainCodec` 的一族（深度 3）**不能**从这里导入（`gate/no-private-cross-layer`：
 * 公共出口深度 ≤ 2）。故本模块只依赖 `domain/`（纯类型）与 `presentation/`（身份与端口契约）
 * —— 这正是"新实现不钻旧层私有实现"的落法。
 */

import type { ContentResource } from '@/domain/content'
import {
  contentVersionOfBytes,
  type AssetLocator,
  type ContentIdentity,
} from '@/presentation/assetIdentity'
import { bindTexture } from '@/presentation/textureBinding'
import type { TextureBinding, TexturePixels, TextureResource, TextureSampling, TextureState } from '@/presentation/textureBinding'
import { textureAnimationOf, type TextureAnimationBinding } from '@/domain/textureAnimation'

/** 五态的**声明式**取值（不是本模块发明 —— 逐字来自 #249 §19.3）。 */
export const TEXTURE_STATES: readonly TextureState[] = Object.freeze([
  'unrequested',
  'loading',
  'ready',
  'missing',
  'failed',
])

/**
 * 一条资源的**解码输入**（把"取字节"与"解码"分离）。
 *
 * ## 为什么解码是**注入**的（而不是本模块自带 PNG 解码器）
 *
 * 解码要用 `Image`（DOM）或 `sharp`（Node）—— 两者都**不能**进本模块：
 *  - 本模块要能在 vitest（无 GPU、无 DOM）里断言**状态机**，那是它最有价值的部分；
 *  - 真正的字节解码由**适配层**（可碰 DOM）实现，在浏览器里跑。
 *
 * 这使"状态判定"与"像素解码"各自可独立验证 —— 前者是业务规则（纯），后者是端口实现。
 * 注入还让"坏一张 ⇒ 只坏那一张"这条判据**可测**（注入一个对特定输入抛错的解码器即可）。
 */
export interface TextureDecoder {
  /**
   * 解码一份内嵌字节（data URL 或 base64）为像素。
   *
   * **必须**对"坏字节"抛错或返回 `null`（两者都映射成五态之一），
   * 而不是返回一张空白图 —— 后者会让"解不出来"与"解出来是空白"不可区分。
   */
  decode(payload: string): Promise<TexturePixels | null>
}

/**
 * 解码的**有界并发窗口**（#399 缺陷 A / B1）。
 *
 * ## 为什么原来那么慢（不是"慢在解码器"，而是慢在**排队**）
 *
 * 旧实现是 for 循环里逐张 await decoder.decode(...) —— 62 张严格串行。
 * 单张的成本不止 CPU：createImageBitmap 是一次**异步往返**，串行即 N 次往返排队；
 * 同一批字节在旧链（`render/data/buildMaterialLibrary` 的 `Promise.all`，M8-5 已删除）实测 <0.7 s，
 * 而本链实测 6.77 s（#399 分诊 §1.2 + 本批 e2e 白模期墙钟）。
 *
 * ## 为什么是"有界"而不是 Promise.all
 *
 * 无界并发会把**大图**同时展开：每张的 RGBA 是整幅内存（W×H×4），真实工程里几十张大图
 * 同时解码会顶到内存峰值。窗口 6–8 在本批夹具（16×16 级、少数 ~19 KB PNG）上已足以
 * 把异步往返重叠掉，同时把峰值钉在"窗口 × 单张 RGBA"。
 *
 * ## 不变量（改动此处必须保住的判据）
 *
 * 1. **输出下标对齐**：textureBindingsOf 按 resources[paletteIndex] 消费资源
 *    （见 :228 一带），故乱序完成必须写回**自己的槽**，不得按完成顺序 push；
 * 2. **逐项独立失败**：一张抛错只坏它自己（decodeOne 的 try/catch）；
 * 3. **进度单调**：done 只在某一项**结算后** +1，故 n 单调不减、终态计数与 out 逐项一致。
 *
 * 三条都有单测（kernelTextureResources.test.ts 的「有界并发」用例：乱序完成 + 第 3 张抛错）。
 */
export const TEXTURE_DECODE_CONCURRENCY = 8

/**
 * 一次进度事实（逐项结算后回调；`state === 'loading'` 期间）。
 *
 * `done` 含 `unrequested` 项：外链资源"不必再等"，也应计入已结算，
 * 否则进度永远停在 `(total - 外链数)/total`，读起来像卡住。
 *
 * ## 为什么这里**没有** `missing`
 *
 * 本模块从不产出 `missing`（只有 `ready`/`failed`/`unrequested`：内嵌字节要么解出来、
 * 要么失败）。"缺失"是**必需性**事实 —— 由 `textureBindingsOf`/`bindTexture` 的
 * `missingRequired` 回答（`presentation/textureBinding.ts:190`）。
 * 在这里补一个恒为 0 的 `missing` 字段就是"看起来完备的假分支"，
 * 故终态只报 `ready`/`failed`，缺失由绑定层汇总（SPEC §7.4：由实际请求与绑定事实推导）。
 */
export interface TextureResourcesProgress {
  /** `'loading'` = 还在解；终态为 `'ready'`（全解出来）或 `'failed'`（至少一张失败）。 */
  readonly state: 'loading' | 'ready' | 'failed'
  /** 已结算条数（含 `unrequested`）。 */
  readonly done: number
  readonly total: number
  readonly ready: number
  readonly unrequested: number
  readonly failed: number
}

/** 进度报告的接收面（**旁路**：它抛错不得影响解码结果，见 `textureResourcesOf`）。 */
export type TextureProgressSink = (progress: TextureResourcesProgress) => void

/**
 * 单条资源的**解码 + 五态判定**（`textureResourcesOf` 的最小工作单元）。
 *
 * 逐条独立 try/catch 是"坏一张只坏一张"的落点 —— 它**不**依赖调用方的调度方式，
 * 故并发化不会改变失败语义。
 */
async function decodeOne(r: ContentResource, decoder: TextureDecoder): Promise<TextureResource> {
  const identity: ContentIdentity = Object.freeze({
    id: r.ref.assetId,
    // 用文档声明的版本（构造期由字节派生）；空串 ⇒ 按字节现算兜底。
    version: r.ref.contentVersion !== '' ? r.ref.contentVersion : contentVersionOfBytes(r.payload ?? ''),
  })
  const locator = locatorOf(r)

  // ① 外链 ⇒ `unrequested`（取回是宿主端口的职责，不在这里假装）。
  if (r.payload === null) return freezeResource(identity, locator, 'unrequested', null)
  // ② 内嵌 ⇒ 解码（**按条**兜错：一处失败只坏这一条）
  try {
    const pixels = await decoder.decode(r.payload)
    if (pixels === null) {
      return freezeResource(identity, locator, 'failed', null, undefined, '解码返回 null（字节不是可解码图像）')
    }
    // ③ 就绪 ⇒ 由「声明 + 像素尺寸」派生纹理序列（#M5-3）。
    // 未解码/失败 ⇒ 缺席（没有像素就没有格数可推，**不猜**帧数）。
    // 派生是纯的；归一化后的非法序列会显式抛出（实现缺陷），由本处的逐条兜错落成
    // 这一条的 `failed` —— 不让它把整批解码拖垮（"坏一张只坏一张"不变）。
    const animation = textureAnimationOf({
      id: identity.id,
      resource: r.ref,
      kind: r.kind,
      animation: r.animation,
      width: pixels.width,
      height: pixels.height,
    })
    return freezeResource(identity, locator, 'ready', pixels, animation ?? undefined)
  } catch (e) {
    return freezeResource(identity, locator, 'failed', null, undefined, formatReason(e))
  }
}

/**
 * `DocumentContent.resources` → `TextureResource[]`（**逐资源五态**）。
 *
 * ## 状态判定（每一条都有对应断言）
 *
 * `domain/content` 的 `ResourceKind` 只有 `'static16' | 'animated'` —— **两者都是纹理**
 * （本模块第一版写了一个"非纹理族 ⇒ missing"的分支，那是**死代码**：
 * 该类型没有非纹理成员。已删，不留"看起来完备"的假分支）。
 *
 * | 输入情形 | `state` | 依据 |
 * |---|---|---|
 * | `payload === null`（外链资源） | `'unrequested'` | 本函数**不**取远端字节（那是宿主端口的职责）；"还没请求"≠"缺失" |
 * | `payload` 非空且解码成功 | `'ready'` | `pixels` 非 `null` |
 * | `payload` 非空但解码失败/抛错 | `'failed'` | 唯一的失败态 |
 *
 * ## ⚠️ 「坏一张 ⇒ 只坏那一张」是本模块的**核心判据**
 *
 * 旧实现 `Promise.all` 一处 throw 即整库失败（实测：57 张里坏 1 张 ⇒ 整视口无贴图）。
 * 本函数**逐条** `try/catch`，故 57 张里坏 1 张 ⇒ 恰好 **1 条 `failed` + 56 条 `ready`**。
 *
 * ## 取字节的方式为什么用 `contentVersionOfBytes`
 *
 * 内嵌资源没有后端修订号，故版本由**字节**派生（该函数逐字为此设计）。
 * ⇒ "同一 URL 换了内容"必然换身份（A28 的前提）。
 *
 * 注：`ContentResource.ref.contentVersion` 已由 `domain/content` 的
 * `contentResource()` **机械派生**（"改了字节却写旧版本"在构造上不可能）。
 * 故本函数**直接用**它，不重算 —— 重算会让"版本从哪来"出现两个答案。
 *
 * ## 并发与进度（#399）
 *
 * 逐条解码改为**有界并发**（窗口 = `TEXTURE_DECODE_CONCURRENCY`），并可经可选的第三参
 * `onProgress` 报出"已结算 n/total"与终态计数（**旁路**：上报抛错不影响解码结果）。
 * 输出**下标对齐**与"坏一张只坏一张"两条既有判据不变；它们是并发化最容易被改坏的地方，
 * 故逐条列在常量注释里并由单测钉住。
 */
export async function textureResourcesOf(
  resources: readonly ContentResource[],
  decoder: TextureDecoder,
  onProgress?: TextureProgressSink,
): Promise<readonly TextureResource[]> {
  const total = resources.length
  // 定长槽位：乱序完成写回自己的下标（见 `TEXTURE_DECODE_CONCURRENCY` 的不变量 1）。
  const out: (TextureResource | undefined)[] = new Array(total)
  let done = 0
  let ready = 0
  let unrequested = 0
  let failed = 0

  const report = (state: TextureResourcesProgress['state']): void => {
    if (onProgress === undefined) return
    try {
      onProgress(Object.freeze({ state, done, total, ready, unrequested, failed }))
    } catch {
      // 进度上报是**旁路**：它抛错不得把一批已解码的纹理伪装成"全部失败"。
      // （那会让"报表坏了"看起来像"资源坏了" —— 两种事实必须可区分。）
    }
  }

  const settle = (index: number, resource: TextureResource): void => {
    out[index] = resource
    done += 1
    if (resource.state === 'ready') ready += 1
    else if (resource.state === 'unrequested') unrequested += 1
    else failed += 1
    report('loading')
  }

  // 起点事实（调用方不必自己拼"0/total"；也保证 0 条时终态仍被报出）。
  report('loading')

  let next = 0
  /**
   * 一个工作槽：反复取下一个下标，直到取完。
   *
   * 窗口由**并发 worker 数**限定（不是"分批 Promise.all"）：某张慢时别的槽继续推进，
   * 不像分批那样被最慢的一张卡整批。下标分配与写回都在同步段内完成 ⇒ 不会两槽抢同一下标。
   */
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= total) return
      settle(index, await decodeOne(resources[index]!, decoder))
    }
  }
  await Promise.all(Array.from({ length: Math.min(TEXTURE_DECODE_CONCURRENCY, total) }, () => worker()))

  // 每个槽都已在 return 前写入（worker 覆盖全部下标才退出）⇒ 此处收窄是结构事实，不是断言猜测。
  const filled = out as readonly TextureResource[]
  report(failed > 0 ? 'failed' : 'ready')
  return Object.freeze(filled)
}

/** 取回位置（**不参与身份**）：有内嵌字节 ⇒ 内嵌，否则外部。 */
function locatorOf(r: ContentResource): AssetLocator {
  if (r.payload !== null) return Object.freeze({ kind: 'inline' as const, url: r.ref.url })
  return Object.freeze({ kind: 'external' as const, url: r.ref.url })
}

/**
 * 冻结一条五态资源。
 *
 * `animation` **只在有值时展开**（与 `phaseOf` 的"缺席就是缺席"同一纪律）：
 * 静态贴图不得写出 `animation: undefined` 的在场字段 —— 保留两种形状会让
 * `Object.keys`/`toStrictEqual` 类断言与"缺席 = 静态"的口径分叉。
 */
function freezeResource(
  identity: ContentIdentity,
  locator: AssetLocator,
  state: TextureState,
  pixels: TexturePixels | null,
  animation?: TextureAnimationBinding,
  failure?: string,
): TextureResource {
  return Object.freeze({
    identity,
    locator,
    state,
    pixels,
    ...(animation === undefined ? {} : { animation }),
    ...(failure === undefined ? {} : { failure }),
  }) as TextureResource
}

function formatReason(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

// ─────────────────────────────────────────────────────────────────────────────
// 资源表 → 纹理绑定（`bindTexture` 的**唯一**生产接线点）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 材质 id 的**约定**：`material:<调色板下标>`。
 *
 * ## 为什么把这条约定写在这里（而不是散在调用方）
 *
 * 纹理要真的贴上 GPU，绑定键必须与**资源表**和**几何的材质下标**三者对齐：
 *
 * | 环节 | 键 |
 * |---|---|
 * | 几何四边形的 `materialIndex` | `0`、`1`、…（`domain/blockGeometry` 的 `BlockGeometryAsset.quads`） |
 * | 资源/材质调色板 | 下标即位置（`kernelProjection` 的 ③ 写入 `textureBlobIndex: i`） |
 * | 材质描述符 id（`MaterialDescriptor.id`） | **必须**是 `material:<下标>`，否则贴不上 |
 *
 * 本批实测真实夹具（`multiblock-ebf-2ch`）：4 条资源（`material:0..3`，均带字节），
 * 几何四边形的 `materialIndex` 取值集合 = `[0, 1]`。
 *
 * ⇒ 这条约定**必须只有一处**：两个地方各写一遍就会漂移，而漂移的后果是
 * **静默贴错纹理**（比"没有纹理"难查得多）。
 */
export const MATERIAL_ID_PREFIX = 'material:'

/** 材质 id → 调色板下标（`null` = 该 id 不符合约定）。 */
export function materialIndexFromId(materialId: string): number | null {
  if (!materialId.startsWith(MATERIAL_ID_PREFIX)) return null
  const tail = materialId.slice(MATERIAL_ID_PREFIX.length)
  if (tail === '') return null
  const n = Number(tail)
  return Number.isInteger(n) && n >= 0 ? n : null
}

/**
 * 材质描述符 + 资源表 → `TextureBinding[]`（**唯一**的绑定生产点）。
 *
 * ## 逐条判据
 *
 * 1. **材质身份 → 调色板下标 → 资源**：`material:<n>` ⇒ `resources[n]`。
 *    下标越界 ⇒ 该材质**无贴图**（显式不绑，而不是绑错一张）。
 * 2. **`required` 由调用方给**（不由材质给）：同一个材质在预览里可选、在导出里必需 ——
 *    这是 `bindTexture` 明文的分工（"必需 vs 可选由 `resources` 决定，不由材质决定"）。
 * 3. **未就绪的资源仍进绑定**：`missingRequired` 由 `bindTexture` 按状态算出 ——
 *    这正是"缺哪张可查询"的落点（G4/A36）。
 */
export function textureBindingsOf(input: {
  /** 材质描述符（**完整**形状 —— `bindTexture` 的类型要求它，见下方 `MaterialDescriptor`）。 */
  readonly materials: readonly MaterialDescriptor[]
  readonly resources: readonly TextureResource[]
  /** 哪些资源是必需的（按调色板下标）。缺省 = 全部必需（导出/验收口径）。 */
  readonly requiredIndexes?: readonly number[]
  /** 采样策略（缺省走 `bindTexture` 的 `VOXEL_SAMPLING`）。 */
  readonly sampling?: TextureSampling
}): readonly TextureBinding[] {
  const needed = input.requiredIndexes === undefined ? null : new Set(input.requiredIndexes)
  const out: TextureBinding[] = []
  for (const m of input.materials) {
    const index = materialIndexFromId(m.id)
    const resource = index === null ? undefined : input.resources[index]
    if (resource === undefined) {
      // 下标越界或 id 不符约定 ⇒ 显式"无贴图"（不绑错一张，也不绑默认图）。
      out.push(bindTexture(m, null, input.sampling))
      continue
    }
    const bound = bindTexture(
      m,
      {
        identity: resource.identity,
        required: needed === null ? true : needed.has(index as number),
        state: resource.state,
        // 序列只在就绪时派生（见 `decodeOne`）；缺席 ⇒ 绑定不带 animation。
        ...(resource.animation === undefined ? {} : { animation: resource.animation }),
      },
      input.sampling,
    )
    out.push(bound)
  }
  return Object.freeze(out)
}

/**
 * 材质描述符：取 `bindTexture` 的入参形状（**完整** `MaterialDescriptor`）。
 *
 * ## 为什么不裁成 `Pick<…, 'id' | 'version'>`（第一版那样写，类型当场判红）
 *
 * `bindTexture` 的签名要求完整描述符（含 `blend`/`tint`/`useVertexColor`），
 * 即使它的函数体只读 `id`/`version`。裁窄入参会**强迫调用方写类型断言**
 * （把不完整对象 `as` 成完整的）—— 那正是"接口比需要更窄 ⇒ 调用方用断言补洞"。
 * ⇒ 照它的形状要求，由 `compileScene` 的产出（`MaterialDescriptor`）满足。
 */
type MaterialDescriptor = Parameters<typeof bindTexture>[0]
