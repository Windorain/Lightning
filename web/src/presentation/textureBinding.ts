/**
 * `presentation/textureBinding` —— **材质 → 纹理映射的纯数据契约**（#289 P10d）。
 *
 * ## 本模块补什么（P10c 实测缺口）
 *
 * P10c（#286）对 `presentation/` 的实测结论：
 *
 * > `presentation/`（P5 交付、本应成为渲染输入的那一层）**完全不处理纹理**：
 * > `presenter.ts:524` 的 `createMaterial` 只设 `vertexColors`/`color`/`transparent`/
 * > `alphaTest` —— **没有 `map`**。全层零 `Texture` 使用。
 *
 * 后果是 `presentation/` 通道下的方块**没有贴图**（只有顶点色与整型 tint），
 * 而旧渲染链（`simpleMaterialLibrary`）是有贴图的 —— 于是"呈现层消费"这一条
 * 在切换后会让画面**变平**（能力回退）。
 *
 * ## 判据：`map` 必须由**内容身份**决定，不由 URL 决定
 *
 * #249 §19.3 与 A28 的负对照都是「按 URL 而不按内容版本缓存」。故本模块产出的
 * 绑定是 {@link TextureBinding}：`(assetId, contentVersion)` → 材质身份，
 * 而**取纹理的地址**（`AssetLocator`）不进它 —— 与 `presentation/assetIdentity`
 * 的同一判据（那里已有逐字说明，本模块不重述）。
 *
 * ## 为什么是**纯数据**而不在这里建 `THREE.Texture`
 *
 * 与 `presentation/compileScene` 的分工逐字一致（§11「纯数据投影与有副作用的 GPU 上传
 * 分开」）：本模块只回答"哪个材质绑哪份纹理内容"，建 GPU 句柄由
 * `presentation/presenter` 的 `apply()` 做。于是 A28/G4 的**结构**部分能在 vitest
 * 里断言（无 GPU），真实 GPU 数字由 e2e 提供。
 *
 * ## 纯度
 *
 * 不 import three、不碰 DOM、不读时钟（`presentation-purity` 闸门覆盖本文件）。
 */

import { contentIdentityKey, type AssetId, type AssetLocator, type ContentIdentity } from './assetIdentity'
import { texturePhaseKeyOf, type MaterialDescriptor, type TexturePhaseBinding } from './evaluationKey'
import {
  sampleTextureInstance,
  sampleTextureSequence,
  type TextureSample,
  type TextureSequence,
} from '@/domain/materials'
import { sequenceKey, type TextureAnimationBinding } from '@/domain/textureAnimation'
import type { Result } from '@/domain/errors'

/**
 * 一份纹理资源的**解析结果**（呈现侧的读面）。
 *
 * `pixels` 是**已解码**的字节（或 `null` = 尚未解码/不可用）。分离"绑定"与"像素"
 * 使绑定可以在纹理还没解码时就算出来 —— 那是 A36/G4 要求的"状态可查询"：
 * 呈现层要能回答"这个材质需要哪份资源、它现在什么状态"，而不是等纹理到位才知道。
 */
export interface TextureResource {
  readonly identity: ContentIdentity
  /** 获取位置（**不参与身份**，仅用于取字节；见 `assetIdentity` 的文件头）。 */
  readonly locator: AssetLocator
  /**
   * 呈现状态（#249 §19.3：「状态区分**未请求、加载中、可用、缺失、失败**」）。
   *
   * 五个成员**一个不少**：把其中任意两个并成一个（例如"缺失"并进"失败"）会让
   * "这个纹理从没被请求过"与"请求了但服务端 404"不可区分，
   * 而后者需要提示用户、前者只需要发起请求。
   */
  readonly state: TextureState
  /** 已解码像素（`state === 'ready'` 时非 `null`）。 */
  readonly pixels: TexturePixels | null
  /** 失败原因（`state === 'failed'` 时非空）。 */
  readonly failure?: string
  /**
   * 纹理序列（声明 + 竖条格数）。**缺席 = 静态贴图**。
   *
   * 它是 `ContentResource.animation` 与解码像素尺寸的**派生**
   * （`domain/textureAnimation#textureAnimationOf`），不是第二个权威。
   * 只在 `state === 'ready'` 时可能出现 —— 没有像素就没有格数可推。
   */
  readonly animation?: TextureAnimationBinding
}

export type TextureState = 'unrequested' | 'loading' | 'ready' | 'missing' | 'failed'

/** 解码后的像素（纯数据；**不是** `THREE.Texture`）。 */
export interface TexturePixels {
  readonly width: number
  readonly height: number
  /** RGBA8，长度 = `width * height * 4`。 */
  readonly rgba: Uint8Array
}

/**
 * 一份材质的**纹理绑定**（呈现编译的产出）。
 *
 * ## 为什么 `map` 是可选的（而不是"总有 map"）
 *
 * 顶点色路径下有真实的"无贴图材质"（纯色/线框）；把无贴图表达成"绑到一张全白纹理"
 * 会让"这个材质本来就没有贴图"与"贴图丢了"不可区分。
 * ⇒ 字段缺席 = 该材质无贴图（**显式**），与 `domain/cellContent` 判据 3 同一口径。
 */
export interface TextureBinding {
  readonly materialId: MaterialDescriptor['id']
  readonly materialVersion: string
  /** 该材质的纹理（缺席 = 该材质无贴图）。 */
  readonly map?: ContentIdentity
  /**
   * 纹理序列（声明 + 竖条格数）。缺席 = 单帧贴图：**不采样、不写 offset/repeat**。
   *
   * ## 它为什么不进 `ContentIdentity` / `materialIdentityOf`
   *
   * 动画声明不是字节：进内容身份会让"改播放速度"变成"换资源"（A28 的反向错误）；
   * 进材质身份会让每帧采样参数变化触发**重编**（而形状/几何/批次完全没变）。
   * ⇒ 它只进 {@link textureBindingKey}（"绑定值"的稳定键）与资源同步去重键，
   * 呈现器换绑定后由 `setTextureBindings` 卸载重挂并立即重采样。
   */
  readonly animation?: TextureAnimationBinding
  /**
   * 该材质的纹理**相位**绑定（G7 / #388 R2-①）。
   *
   * 三态语义见 `evaluationKey#TexturePhaseBinding`：**缺席 = 无相位动画**（不参与相位），
   * 显式 `{ phaseOffset: 0, phaseScale: 1 }` = 第 0 相位。两者**不等价**，且本字段进
   * {@link textureBindingKey} ⇒ 相位不同的材质不共享绑定缓存条目。
   *
   * 它是 `MaterialDescriptor` 相位字段的**派生**（`bindTexture` 逐字复制），不是第二个权威。
   */
  readonly texturePhase?: TexturePhaseBinding
  /**
   * 采样设置（呈现契约的一部分；#249 §19.3「纹理采样设置」）。
   *
   * 这些是**呈现参数**而不是资源内容：同一份像素配不同采样得到不同画面，
   * 但它不改变资源身份（故不进 `ContentIdentity`）。
   */
  readonly sampling: TextureSampling
  /**
   * 缺少必需资源时的显式失败（G4 / A36：「必需资源未就绪不得假装完整」）。
   *
   * `map` 在场而 `missingRequired === true` ⇒ 该材质**必须**走占位路径并在状态里标注；
   * 不得静默用一个默认纹理顶上（那正是"假装完整"）。
   */
  readonly missingRequired: boolean
}

export interface TextureSampling {
  /** `nearest` = MC 体素风格（不插值）；`linear` = 平滑。 */
  readonly filter: 'nearest' | 'linear'
  readonly wrap: 'clamp' | 'repeat'
  readonly flipY: boolean
  /** 是否使用 mipmap（`filter === 'nearest'` 时通常关闭）。 */
  readonly mipmaps: boolean
  /** 各向异性过滤上限（`0` = 不启用）。 */
  readonly anisotropy: number
}

/** MC 体素贴图的默认采样（与旧渲染链 `simpleMaterialLibrary` 的语义一致）。 */
export const VOXEL_SAMPLING: TextureSampling = Object.freeze({
  filter: 'nearest',
  wrap: 'clamp',
  flipY: false,
  mipmaps: false,
  anisotropy: 0,
})

/**
 * 一份材质的**资源需求**（不依赖任何已加载资源；G4 的预检输入）。
 *
 * 与 {@link TextureBinding} 的区别：绑定是"编译后的结果"（资源可能还没到位），
 * 需求是"编译**前**要说清我需要什么" —— 导出预检（P9 的 `preflightRequiredAssets`）
 * 用后者：它必须在**开始**渲染前就能列出缺什么。
 */
export interface TextureRequirement {
  readonly materialId: string
  readonly materialVersion: string
  readonly required: readonly ContentIdentity[]
}

/**
 * 材质描述符 → 纹理绑定（**唯一**的绑定构造点）。
 *
 * ## 判据顺序（各自都在测试里有对应断言）
 *
 *  1. **材质身份含内容版本** ⇒ 换纹理后身份变，故绑定跟着变（A36「版本替换」）；
 *  2. **提取位置不进身份** ⇒ 同一份内容换 URL 仍是同一个绑定（A28 正面对照）；
 *  3. **必需 vs 可选**由 `resources` 的 `required` 决定，不由材质决定 ——
 *     同一个材质在不同文档里可以是必需或可选（例如导出 vs 预览）。
 *
 * ## 为什么 `tint` 不进绑定
 *
 * `tint` 已经在 `MaterialDescriptor` 里（它是材质身份的一部分），而本函数回答的是
 * "这份材质配哪张纹理"。把 `tint` 再抄一遍会让"哪一处是权威"出现两个答案。
 */
export function bindTexture(
  material: MaterialDescriptor,
  resource: {
    readonly identity: ContentIdentity
    readonly required: boolean
    readonly state: TextureState
    /** 资源派生出的纹理序列（缺席 = 静态贴图；见 `textureAnimationOf`）。 */
    readonly animation?: TextureAnimationBinding
  } | null,
  sampling: TextureSampling = VOXEL_SAMPLING,
): TextureBinding {
  if (resource === null) {
    // 无贴图材质（顶点色纯色/线框）：**显式**不绑，而不是绑一张默认图。
    // 无资源 ⇒ 无像素 ⇒ 无格数 ⇒ **不产** animation（不猜帧数）。
    return Object.freeze({
      materialId: material.id,
      materialVersion: material.version,
      sampling,
      missingRequired: false,
      ...phaseOf(material),
    })
  }
  return Object.freeze({
    materialId: material.id,
    materialVersion: material.version,
    map: resource.identity,
    sampling,
    // 「必需且未就绪」⇒ 显式标缺（G4）。`missing` 与 `failed` 都算未就绪；
    // `unrequested`/`loading` 是**进行中**，不标缺（否则每帧都在报"缺资源"）。
    missingRequired: resource.required && (resource.state === 'missing' || resource.state === 'failed'),
    // 缺席就是缺席（与 phaseOf 同一形状纪律）：静态贴图不得写出 `animation: undefined`。
    ...(resource.animation === undefined ? {} : { animation: resource.animation }),
    ...phaseOf(material),
  })
}

/**
 * 相位字段的条件展开（**缺席就是缺席**）。
 *
 * 不用 `texturePhase: material.texturePhase`（那会写出值 `undefined` 的**在场**字段）：
 * 本模块的判据口径是"字段缺席 = 无相位动画"，而"在场但为 `undefined`"是同一份数据的
 * 另一种形状 —— 保留两种形状会让 `Object.keys`/`toStrictEqual` 类断言与键之外的口径分叉。
 * 这也是"缺省不得用 `0` 冒充第 0 帧"在**形状层**的对应：无相位 ⇒ 无该字段。
 */
function phaseOf(material: MaterialDescriptor): { readonly texturePhase?: TexturePhaseBinding } {
  return material.texturePhase === undefined ? {} : { texturePhase: material.texturePhase }
}

/**
 * 绑定的稳定键（缓存查找用；含材质身份、纹理内容身份、**纹理序列**与**相位**，**不含** locator）。
 *
 * 序列必须进键：两个只有动画声明不同的绑定是**不同的呈现输入**（同一张图、不同的
 * 帧时长/帧序 ⇒ 同一时刻不同样本）。它**不**进 `ContentIdentity`/`materialIdentityOf`
 * —— 见 `TextureBinding#animation` 的说明。
 */
export function textureBindingKey(binding: TextureBinding): string {
  const map = binding.map === undefined ? '-' : contentIdentityKey(binding.map)
  const animation = binding.animation === undefined ? '-' : sequenceKey(binding.animation.sequence)
  return `${binding.materialId}@${binding.materialVersion}|${map}|an:${animation}|ph:${texturePhaseKeyOf(binding.texturePhase)}`
}

/**
 * 在给定**场景时间**上采样该绑定对应的纹理序列 —— `sampleTextureInstance` 的**生产消费者**。
 *
 * ## 为什么必须是**分支**而不是"一律走 `sampleTextureInstance`"
 *
 * 相位三态里**缺席 ≠ 第 0 相位**（见 `evaluationKey#TexturePhaseBinding`）。若本函数把缺席
 * 归一成 `DEFAULT_INSTANCE_BINDING`（`{0,1}`），就恰好犯下本轴要防的错误："用 `0` 冒充第 0 帧"
 * —— `{0,1}` 的 `phaseScale=1` 会打开一条**乘 1** 的相位路径，而缺席意味着**根本没有相位
 * 绑定**。故缺席 ⇒ 直接 `sampleTextureSequence(sequence, baseSeconds)`（零相位变换），
 * 显式 ⇒ 交给 `sampleTextureInstance`（相位语义**只在** domain 里有一份实现）。
 *
 * ## 返回值
 *
 * 与两个采样器一样是 `Result`：非法时间/非法序列由 domain 显式判错，**不得**用默认帧顶替
 * （A36 同族的"不得假装完整"）。
 *
 * ⚠️ 本函数是 **presenter 每帧消费的唯一采样入口**（`BatchedPresenter#applySceneTime`）。
 * 签名固定为 `(binding, sequence, baseSeconds)`：**不得**加 `deltaSeconds` 之类的累积参数
 * —— 累积量没有"倒退"通路，跳帧/倒放会与连续播放给出不同样本（A27 的判据形态）。
 */
export function sampleBoundTexture(
  binding: TextureBinding,
  sequence: TextureSequence,
  baseSeconds: number,
): Result<TextureSample> {
  const phase = binding.texturePhase
  return phase === undefined
    ? sampleTextureSequence(sequence, baseSeconds)
    : sampleTextureInstance(sequence, phase, baseSeconds)
}

/**
 * 资源需求清单（从编译产物**反推**；`presentation/compileScene#requiredAssetIds` 的对偶）。
 *
 * 与 `requiredAssetIds` 的分工：那个只给 `AssetId`（要哪些**资源**），
 * 本函数给出**内容版本**（要哪个**版本**）—— 后者是"同一 URL 换了内容"可判定的前提（A28）。
 */
export function textureRequirementsOf(
  bindings: readonly TextureBinding[],
  resources: readonly TextureResource[],
): readonly TextureRequirement[] {
  const byKey = new Map<string, TextureResource>()
  for (const r of resources) byKey.set(contentIdentityKey(r.identity), r)
  const out: TextureRequirement[] = []
  for (const b of bindings) {
    if (b.map === undefined) continue
    const r = byKey.get(contentIdentityKey(b.map))
    if (r === undefined) continue
    out.push(
      Object.freeze({
        materialId: b.materialId,
        materialVersion: b.materialVersion,
        required: Object.freeze([r.identity]),
      }),
    )
  }
  return Object.freeze(out)
}

/**
 * **必需资源未就绪**的显式清单（G4/A36 的判据面）。
 *
 * 返回空数组 = 可以完整呈现；非空 = 调用方**必须**把它作为结构化诊断报出，
 * 不得"渲染出一个缺贴图的画面却宣称成功"。
 */
export function missingRequiredAssets(
  bindings: readonly TextureBinding[],
): readonly { readonly materialId: string; readonly assetId: AssetId }[] {
  const out: { materialId: string; assetId: AssetId }[] = []
  for (const b of bindings) {
    if (!b.missingRequired || b.map === undefined) continue
    out.push(Object.freeze({ materialId: b.materialId, assetId: b.map.id }))
  }
  return Object.freeze(out)
}
