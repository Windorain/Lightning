/**
 * `runtime/host/recoveryHost` —— **恢复副本会话的宿主实现**（M8-4）。
 *
 * ## 为什么它在 `runtime/host/`（装配宿主层）而不是 `composition/`
 *
 * `composition/recoverySession` 表达的是**政策**（何时写、写几份、如何检测/采纳/放弃），
 * 它按架构闸门（`tests/architecture/composition-legacy-binding`）**不得** import 旧层
 * （`runtime/`、`logging/`）。而「把采纳结果装进装载序列」必须动 `Context` / `KernelSession`
 * —— 那正是**宿主**的职责（与 `createWorkbenchHost` 里其它装配边同一身份）。
 * ⇒ 政策留在 composition（可注入端口、可单测），旧层动作留在这里并经端口注入。
 *
 * ## 采纳的装载序列（与 `composition/projectIo#adoptProject` **同序**）
 *
 *     setDocument(旧格式载体)        ← 画面 + 存在性镜像（markLoaded）
 *       → kernel.seekFrame(0)
 *       → kernel.adoptDocument(恢复出来的文档)   ← 内核权威（内容 = 副本；基线 = 空内容基线）
 *       → 装配面/装配期事实（副本只有内容权威）
 *       → syncLegacyFromKernel()                 ← 全保真注解/逐格说明/网格投影回载体
 *
 * ⚠️ 与 `adoptProject` 的**唯一**差别：本路径**不**把 `saveBaseline` 钉到内容
 * （那是「刚打开 = 干净」的工程语义）。恢复副本保的是**未保存**内容 ⇒ 采纳后仍脏，
 * 这正是 SPEC §9:299「采纳 ≠ 保存」与判据 S5-b 的落点。
 */

import { LOG_LEVEL } from '@/logging/LogCenter'
import type { Context } from '@/runtime/context'
import { assemblyFaceOfDocument } from '@/composition/documentLoad'
import type {
  RecoveryHostPort,
  RecoveryHostSnapshot,
  RecoveryInstallInput,
} from '@/composition/recoverySession'

/** 语义级别 → `LogCenter` 的位级别（端口只表达「想让用户看到哪一级」）。 */
function levelOf(level: 'info' | 'warn' | 'error'): number {
  if (level === 'error') return LOG_LEVEL.ERROR
  if (level === 'warn') return LOG_LEVEL.WARN
  return LOG_LEVEL.INFO
}export function createRecoveryHost(ctx: Context): RecoveryHostPort {
  return {
    instanceId: ctx.instanceId,
    diagnostics: ctx.wm.diagnostics,

    live(message: string, level: 'info' | 'warn' | 'error', state: string): void {
      // 渠道固定为 'recovery'（M8-4 新增的第四个写入方；与 texture/rejection/device 并列）。
      ctx.log.setLiveStatus(message, levelOf(level) as never, state, 'recovery')
    },

    captureCurrent(): RecoveryHostSnapshot | null {
      const kernel = ctx.kernel
      if (kernel === null || !kernel.hasAdoptedContent()) return null
      const doc = kernel.document()
      if (doc === undefined) return null
      const dirty = ctx.kernelDirty() ?? false
      return {
        documentId: doc.id,
        dirty,
        // 结构上就是 `RecoverySourceSnapshot`（id/scene/animation/content/version）——
        // 本层不 import `application/recovery`（那会是「旧层→内核」的新边），故按形状给出。
        snapshot: {
          id: doc.id,
          scene: doc.scene,
          animation: doc.animation,
          content: doc.content,
          version: doc.version,
        },
        assets: doc.content.resources.map((r) => r.ref),
      }
    },

    installRestored(input: RecoveryInstallInput): boolean {
      const kernel = ctx.kernel
      if (kernel === null) return false
      // 类型收窄在这里做（composition 交来的是 `unknown`：它不 import 旧层类型）。
      const projected = input.projected as unknown as Parameters<Context['setDocument']>[0]
      const restored = input.restored as never
      const content = input.content as never
      const face = assemblyFaceOfDocument(input.restored as never)

      // ① 旧格式载体 + 存在性镜像（与 `adoptProject` 同序）。
      ctx.getSelection().clear()
      ctx.setDocument(projected)
      kernel.seekFrame(0)
      // ② 内核权威：内容 = 恢复副本；基线 = 空内容基线 ⇒ **仍脏**（不推进正式基线）。
      kernel.adoptDocument(restored, content)
      // ③ 装配期事实：副本只带内容权威，没有装载期保真字段/源根/内层 body 承运。
      kernel.setFidelityFieldMap(null)
      kernel.setAssemblySourceRoot(null)
      kernel.setMultiblockBody(
        input.declaration === null
          ? null
          : Object.freeze({ declaration: input.payload.content.multiblock, sceneGridEvidence: Object.freeze([]) }),
      )
      kernel.setAssemblyFace(Object.freeze({ frameObjects: face.frameObjects, multiblock: input.declaration as never }))
      // ④ 绑定重置：副本不携带源 locator（载荷只有内容身份）⇒ 不能伪装成原绑定。
      ctx.getDocumentBinding().value = { sourceId: 'empty', locator: '', remoteRevisionId: null, saveBaseline: null }
      ctx.getLocalFileName().value = null
      // ⑤ 全保真注解/逐格说明/网格投影回载体（生产上每次编辑都走的同一条）。
      ctx.syncLegacyFromKernel()
      return true
    },

    currentDocumentId(): string | null {
      const kernel = ctx.kernel
      if (kernel === null || !kernel.hasAdoptedContent()) return null
      return kernel.document()?.id ?? null
    },
  }
}
