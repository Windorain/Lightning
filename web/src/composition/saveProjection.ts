/**
 * `composition/saveProjection` —— **保存/导出用的内核投影视图**（#301 P10f D2）。
 *
 * ## 本模块替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | `ctx.getDoc().value?.serialize()` —— 从**旧文档**取产物字节 | `docLifecycleOperators`（保存到文件）/ `sdeOperators`（SDE 导出）/ `wikiOperators`（wiki 信封）/ `wikiDataPageSource`（wiki 页保存）/ `exportOperators`（四个导出）/ `queries.getDocument` / `WorkbenchRoot.vue` | 从**内核文档 + 装配面**投影出同形状的 plain |
 *
 * ## 为什么需要它（而不是直接调 `projectKernelDocument`）
 *
 * 投影要 6 样输入，其中 4 样**只有会话知道**：
 *
 * | 输入 | 来源 |
 * |---|---|
 * | `scene` / `content` | `session.document()`（内核权威） |
 * | `frameObjects` | `session.assemblyFaceOf()`（装配期才知道；帧下标 → 对象 id） |
 * | `multiblockDeclaration` | 同上（多方块类型化投影面） |
 * | `fidelityFields` | `session.fidelityFieldMapOf()`（D1 采集） |
 * | `annotationRows` | `projectAnnotationsToLegacy`（**全保真**；见下） |
 *
 * ⇒ 本模块是"会话 → 投影入参"的**唯一**装配点。若让每个调用点自己拼，
 * 那么漏掉任何一样都会**静默**产出错误产物（漏 `fidelityFields` = 丢未知字段、
 * 漏 `annotationRows` = 丢注解字段、漏 `frameObjects` = 帧错位）。
 *
 * ## ⚠️ 两条"如实降级"（不伪造产物）
 *
 * | 情形 | 返回 | 理由 |
 * |---|---|---|
 * | 无会话 / 未装配成功（GF-16） | `null` | 内核不是权威 ⇒ 调用方回落 legacy（**能力不回退**） |
 * | 投影产物读不回（`fromV2Plain` 返回 `null`） | `null` + 诊断 | 那是**实现缺陷**，不是业务失败；调用方回落 legacy 并记诊断 |
 *
 * ⇒ **绝不**返回一份"看起来能用"的空产物：那会让用户存下一个空文件而不是旧内容
 *（比报错更糟 —— 与 `kernelProjection` 文件头的判据 2 同一口径）。
 *
 * ## 为什么注解行用**全保真**那份
 *
 * `projectKernelDocument` 默认就地合成**渲染态**注解（`id`/`type`/`visible`/`title`/`description`
 * —— "够画即可"）。保存用途下那会**静默丢掉** `locked`（"锁定即只读"的判定依据！）、
 * `created_at`/`updated_at`、几何 `min`/`max`/`pos`/`points`、`color`/`renderStyle`。
 * 实测：`locked`/`frameIndex`/`created_at`/`min`/`max` 经渲染态投影后**全部变 `null`**。
 * ⇒ 本模块传 `annotationRows: projectAnnotationsToLegacy(session.document())`
 *（C′2 为写回写的全保真反向，含"字段顺序固定"与"缺席 ≠ 空"两条纪律）。
 */

import type { KernelSession } from '@/runtime/kernelSession'
import { projectAnnotationsToLegacy } from '@/runtime/annotationRead'
import { projectToRuntimeDocument, type KernelDeclarationProjection } from '@/composition/kernelProjection'

/** 投影结果（`plain` 与旧 `serialize()` 同形状 —— 消费方无需改形状假设）。 */
export interface SaveProjectionResult {
  readonly ok: true
  readonly plain: Readonly<Record<string, unknown>>
  /** 投影期诊断（非空**不代表失败**：例如"某帧对象缺失"会如实记录）。 */
  readonly diagnostics: readonly { readonly code: string; readonly path: string; readonly detail: string }[]
}

export interface SaveProjectionFailure {
  readonly ok: false
  /** 失败原因（可诊断；调用方据此决定记什么日志）。 */
  readonly reason: 'no-session' | 'not-adopted' | 'unreadable'
  readonly detail: string
}

export type SaveProjection = SaveProjectionResult | SaveProjectionFailure

/**
 * 会话已装配的**装配面** → 投影入参的多方块声明。
 *
 * ## 为什么在这里做类型收窄（而不是让会话存强类型）
 *
 * `KernelSession` 在内核侧，不得 import 装配根（`composition/`）的类型 ——
 * 方向会反（装配根依赖各层）。故它只保管**不透明** `unknown`，
 * 由本模块（`composition/` 侧）收窄。见 `KernelSession#assemblyFace` 的说明。
 *
 * ⚠️ 收窄**失败**（形状不是预期的那个对象）⇒ 返回 `null` 并**由调用方诊断**，
 * 不静默当作"帧为主文档"（那会让多方块文档被投影成帧为主形态 = 产物形态错）。
 */
function declarationOf(face: unknown): KernelDeclarationProjection | null | undefined {
  if (face === null) return null
  if (typeof face !== 'object') return undefined
  const f = face as Record<string, unknown>
  if (typeof f.id !== 'string' || typeof f.displayName !== 'string') return undefined
  return {
    id: f.id,
    displayName: f.displayName,
    declaration: f.declaration as KernelDeclarationProjection['declaration'],
    declRaw: (f.declRaw ?? {}) as Readonly<Record<string, unknown>>,
    blockPalette: (f.blockPalette ?? []) as KernelDeclarationProjection['blockPalette'],
    assets: (f.assets ?? {}) as KernelDeclarationProjection['assets'],
    frames: (f.frames ?? []) as KernelDeclarationProjection['frames'],
    schemaVersion: (f.schemaVersion ?? null) as number | null,
    multiblockCount: (f.multiblockCount ?? 1) as number,
  }
}

/**
 * **保存/导出视图**：内核会话 → 旧格式 plain（与 `RuntimeDocument.serialize()` 同形状）。
 *
 * ## 纯函数式的边界
 *
 * 本函数**不写**任何东西、**不改**输入；它只读会话的事实。
 * `null` 的语义是"**内核不是权威**（或投影坏掉了）⇒ 请回落 legacy"，
 * 而**不是**"没有内容" —— 后者会返回一份合法的空 plain。
 */
export function projectKernelSaveView(session: KernelSession | null): SaveProjection {
  if (session === null) {
    return Object.freeze({ ok: false, reason: 'no-session', detail: '无内核会话（该宿主未创建会话）' })
  }
  // GF-16：装配成功才以内核为权威。未装配 ⇒ 回落（与 C′1 的镜像回落同一口径：
  // 删早了会在"未装配"时丢能力，见 #171）。
  if (!session.hasAdoptedContent()) {
    return Object.freeze({
      ok: false,
      reason: 'not-adopted',
      detail: '内核未承载装配产物（该文档形态不被内核支持，或尚未装配）',
    })
  }
  const doc = session.document()
  if (doc === undefined) {
    return Object.freeze({ ok: false, reason: 'not-adopted', detail: '内核文档不存在' })
  }
  const face = session.assemblyFaceOf()
  const declaration = face === null ? null : declarationOf(face.multiblock)
  if (declaration === undefined) {
    // 装配面在场但形状不可解释 ⇒ 不猜（猜错会把多方块文档投影成帧为主形态）。
    return Object.freeze({
      ok: false,
      reason: 'unreadable',
      detail: '装配面的多方块投影面形状不可解释 —— 这是实现缺陷（投影与装配的契约漂移）',
    })
  }
  const fidelity = session.fidelityFieldMapOf()
  const projected = projectToRuntimeDocument({
    scene: doc.scene,
    content: doc.content,
    // ⚠️ `face === null`（未采集）⇒ **不传** `frameObjects`，让投影按 `scene.order`
    // 的既定缺省推导（与装配产物同序）。传 `[]` 会**改变语义**（会被当成"零帧"）。
    ...(face === null ? {} : { frameObjects: face.frameObjects }),
    multiblockDeclaration: declaration,
    // 同三态口径：`null`（未采集）⇒ 不传（投影按"无保真字段"处理）；
    // `{}`（确实没有）⇒ 传空表（语义相同，但显式）。
    ...(fidelity === null ? {} : { fidelityFields: fidelity }),
    // **全保真**注解行（见文件头"为什么注解行用全保真那份"）。
    annotationRows: projectAnnotationsToLegacy(doc),
  })
  // ── ⚠️ **必须**再经 `serialize()`，不能直接交 `projected.plain` ─────────────
  //
  // 这是本批**实测抓到**的一处关键差异（本文件的等价判据当场判红）：
  // 投影的 `plain` 与 `RuntimeDocument.serialize()` 的形状**不同** ——
  // 例如 legacy 的 `serialize()` 会把**首帧展开副本**写到产物根
  //（`cellGrid`/`blockPalette`/`geometryPhase`；契约 §2 的既有形态），
  // 而投影把网格写在 `frames[i].structure` 里。
  //
  // 实测（envelope）：仅 legacy 有 `cellGrid,blockPalette,geometryPhase`；
  //          仅投影有 `label,payload,payloadEncoding,documentFormat`。
  //
  // ⇒ 若保存路径直接写投影 `plain`，**产物形状就变了** —— 那会打断所有
  // 按根级 `cellGrid` 读的既有消费者（"静默的数据变化"，比报错更难发现）。
  // 正解：走 `projectToRuntimeDocument`（投影 + `fromV2Plain` 读回）再 `serialize()`
  // —— 即**与 legacy 保存路径同一个归一化终点**，形状因此逐字节等价。
  const plain = projected.doc.serialize() as Record<string, unknown>
  return Object.freeze({
    ok: true,
    plain,
    diagnostics: Object.freeze(
      projected.diagnostics.map((d) => Object.freeze({ code: d.code, path: d.path, detail: d.detail })),
    ),
  })
}
