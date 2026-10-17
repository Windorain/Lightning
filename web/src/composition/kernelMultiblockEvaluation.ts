/**
 * `composition/kernelMultiblockEvaluation` —— **多方块「按当前取值再装配」的唯一求值点**（M5-2）。
 *
 * ## 本模块替代什么（断点②）
 *
 * M5-1 之前，画面（DRW 定义面 + 呈现会话几何）读的是**装载期装配**：
 * `assembleKernelDocument` 用 `initialSelection`（全通道 0、tt=default）装出来的
 * 内核场景。通道取值（包括非尺寸通道 coil/glass）**从不写回那个场景**，于是
 * "滑杆动了，画面不动"（s0-a §2.5-6 的断点②）。
 *
 * 本模块把「声明 + body + 当前取值 → 派生场景」做成**一个纯函数**，派生场景
 * **不写回内核文档**（Lead 裁决：不能"通道一变就改写内核文档里的网格"），
 * 而是作为**求值产物**交给两个画面消费者：
 *
 * | 消费者 | 吃哪一部分 |
 * |---|---|
 * | DRW 定义面（`Context#kernelRenderSourceFace`） | 派生场景的 `blockGrid` 载荷 |
 * | 呈现会话（`PresenterSession#applyKernelDocument`） | 派生场景 + 原内容 |
 *
 * ## 为什么不是"再装配结果写回内核场景"（甲路线否决理由）
 *
 * 写回会让内核文档的 `scene` 由**取值**而非**命令**改变：文档版本/历史/保存
 * 投影会与"这次求值"纠缠，且同一份内核内容在不同取值下有多份"内容事实"。
 * `composition/kernelRenderView` 文件头已登记同一条裁决。派生场景**每次现算、
 * 不落任何存储**，故"求值场景 = 派生"在结构上成立。
 *
 * ## 纯度
 *
 * 显式输入、不改输入、不读 I/O/时钟/DOM。同一输入两次调用 ⇒ 网格与身份逐项相等
 * （身份来自 `evaluationIdentityOf`：声明内容 + 取值 + 帧下标，**不含机位**）。
 *
 * ## 失败不伪造
 *
 * 再装配失败（文档缺陷：缺 stepIndex / 越界 / 无 body 承运）⇒ `failed: true` +
 * `assembly: null` + 一条诊断，**不**回落装载期场景。调用方（Context 读面）
 * 据此返回 `null`，画面保留上一次可渲染结果 —— 而不是静默画回旧取值。
 */

import type { Document } from '@/domain/document'
import type { DocumentContent } from '@/domain/content'
import type { Grid } from '@/context/grid'
import type { AssemblyResult } from '@/context/multiblock'
import type { MultiblockBody, MultiblockDeclaration } from '@/domain/multiblockDocument'
import type { MultiblockSelectionState } from '@/domain/multiblockSelection'
import { objectData, withUpdatedData, type Scene } from '@/domain/scene'
import { assembleMultiblockKernelFace } from '@/composition/kernelAssembly'
import type { KernelDeclarationProjection } from '@/composition/kernelProjection'
import { evaluationIdentityOf } from '@/presentation/multiblockEvaluation'

/** 一次再装配的可观察产物（面板尺寸/变体键 + 派生场景的来源）。 */
export interface MultiblockAssemblyFacts {
  /** 网格对象 id（与装载期装配**逐字相同**：`structure:multiblock`）。 */
  readonly objectId: string
  /** 网格对象数据 id（逐字相同）。 */
  readonly dataId: string
  /** 装配出的网格（`Grid`；呈现/投影/定义面同一份）。 */
  readonly grid: Grid
  /** 装配报告（尺寸/变体键/夹取/警告）。 */
  readonly report: AssemblyResult['report']
}

/**
 * **求值产物**（派生场景 + 身份 + 诊断）。
 *
 * `scene` 在 `failed` 时为**未求值**的原场景 —— 消费方必须以 `failed` 为门，
 * 不得把它当结果读（这就是"旧通路复活"的判据面：`failed` 时读面返回 `null`）。
 */
export interface MultiblockEvaluation {
  readonly scene: Scene
  readonly content: DocumentContent
  readonly frameObjects: readonly string[]
  readonly multiblockDeclaration: KernelDeclarationProjection | null
  readonly selection: MultiblockSelectionState
  /** 求值身份（`e:<hash>`）；帧为主文档为 `''`（与切换前逐字相同）。 */
  readonly identity: string
  /** 再装配产物；`null` = 帧为主文档（无多方块）**或**再装配失败（见 `failed`）。 */
  readonly assembly: MultiblockAssemblyFacts | null
  /** 失败标记：`true` ⇒ 调用方必须保留上一次可渲染结果。 */
  readonly failed: boolean
  readonly diagnostics: readonly string[]
}

export interface MultiblockEvaluationInput {
  /** 内核文档的场景（装载期装配产物；**作为派生基底**，不被修改）。 */
  readonly scene: Scene
  readonly content: DocumentContent
  /** 帧下标 → 内核对象 id（装配面）。 */
  readonly frameObjects: readonly string[]
  /** 类型化声明投影（重建内层 body 的键；帧为主为 `null`）。 */
  readonly multiblockDeclaration: KernelDeclarationProjection | null
  /** 多方块内层 body 的内核承运；`null` = 帧为主文档。 */
  readonly body: MultiblockBody | null
  /** 当前通道取值（已投影成选择；来自 `domain/multiblockSelection`）。 */
  readonly selection: MultiblockSelectionState
  /** 当前帧下标（决定哪一帧带网格；多方块恒 0）。 */
  readonly frameIndex: number
}

/**
 * **按当前取值求值多方块**（生产唯一求值点）。
 *
 * 帧为主文档（`body === null`）原样返回内核场景 ⇒ 该路径行为零变化。
 */
export function evaluateMultiblockPresentation(input: MultiblockEvaluationInput): MultiblockEvaluation {
  const base = {
    content: input.content,
    frameObjects: input.frameObjects,
    multiblockDeclaration: input.multiblockDeclaration,
    selection: input.selection,
  } as const

  if (input.body === null) {
    return Object.freeze({
      ...base,
      scene: input.scene,
      identity: '',
      assembly: null,
      failed: false,
      diagnostics: Object.freeze([]) as readonly string[],
    })
  }

  const identity = evaluationIdentityOf({
    sceneId: input.scene.id,
    declarationContent: input.multiblockDeclaration?.declRaw ?? null,
    selection: input.selection,
    frameIndex: input.frameIndex,
  })

  const assembled = assembleMultiblockKernelFace({
    body: input.body,
    selection: input.selection,
  })
  if (!assembled.ok) {
    const reason =
      typeof assembled.error.params.reason === 'string'
        ? assembled.error.params.reason
        : assembled.error.code
    return Object.freeze({
      ...base,
      scene: input.scene,
      identity,
      assembly: null,
      failed: true,
      diagnostics: Object.freeze([
        `多方块再装配未产出（${reason}）—— 保留上一次可渲染结果（不静默回落到装载期场景）`,
      ]) as readonly string[],
    })
  }

  // 网格以**载荷**形式进派生场景（`projectKernelDocument` 的 renderView 模式与
  // DRW 定义面都从场景的帧对象载荷取网格）。`source: 'content'` 与装载期创建该对象
  // 时的口径**逐字相同**（kernelAssembly.ts:1858）—— 生成物仍只读。
  const scene = withUpdatedData(
    input.scene,
    objectData(assembled.value.dataId, assembled.value.payload, 'content'),
  )
  return Object.freeze({
    ...base,
    scene,
    identity,
    assembly: Object.freeze({
      objectId: assembled.value.objectId,
      dataId: assembled.value.dataId,
      grid: assembled.value.grid,
      report: assembled.value.report,
    }),
    failed: false,
    diagnostics: Object.freeze([]) as readonly string[],
  })
}

/**
 * **派生呈现文档**：同 id / 同版本 / 同历史，**只**把场景换成求值场景。
 *
 * 它**不是**第二份文档权威：不落存储、不进历史、不参与保存（保存投影只带声明，
 * 生成网格不进保存内容 —— `composition/kernelProjection#renderView` 的既有边界）。
 * 呈现会话的求值键含 `documentVersion` **且**逐对象载荷 `contentVersion`
 * （`composition/presenterSession#contentIdentityOf`）；派生载荷的内容版本由
 * `objectData` 按载荷摘要推进 ⇒ "取值变 ⇒ 必然重编"，不依赖调用方自觉。
 */
export function derivedPresentationDocument(document: Document, evaluation: MultiblockEvaluation): Document {
  if (evaluation.assembly === null || evaluation.failed) return document
  return Object.freeze({ ...document, scene: evaluation.scene })
}

/** 声明事实（供调用方投影选择；无声明时为 `null`）。 */
export function declarationFactsOf(content: DocumentContent): MultiblockDeclaration | null {
  const decl = content.multiblock
  return decl.multiblockCount === 0 ? null : decl
}
