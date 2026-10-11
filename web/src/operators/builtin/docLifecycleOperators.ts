import type { OperatorType } from '@/operators/operatorType'
import { hydrateMainEmbedInitialViewFromDoc } from '@/context/embedInitialView'
import { RuntimeDocument } from '@/context/runtimeDocument'
import { getDevSceneDocument } from '@/dev/devScenes'
import { downloadJson } from '@/util/browser'
import { suggestedJsonBaseName } from '@/workbench/utils/fileNaming'
import { DEFAULT_PREVIEW_SCENE_ID } from '@/viewer/viewerSession'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { createDocument, withContent, withDocumentContent } from '@/domain/document'
import { openDocumentState } from '@/application/commands'
import { isEnvelopeDocument, normalizeEnvelopeToPlain } from '@/render/data/compactSceneDocument'

/**
 * **把一份已解析的旧文档装进内核会话**（#282 P10b：装配 → 生产接线）。
 *
 * ## 这一步在整条链上的位置
 *
 * ```
 * 文件 ──解析──▶ RuntimeDocument ──装配──▶ 内核 Scene + DocumentContent
 *                                              │
 *                                              ├─▶ KernelSession.adoptDocument（内核持有权威）
 *                                              └─▶ 帧声明由内核文档自己给出（不再从旧文档读）
 * ```
 *
 * ## 为什么装配失败**不**阻断加载（如实降级，不静默）
 *
 * `assembleKernelDocument` 对"不可识别形态"显式失败。此时**仍然**加载旧文档
 * （旧渲染路径照常工作），但把失败写进日志 —— 于是：
 *  - 用户不会因为内核装配层的局限而打不开一份文件（能力不回退）；
 *  - 而"这份文件内核装配不了"是一个**可见**的事实，不是静默的双轨。
 *
 * 这条取舍是 #171「阶段间暂存的未迁移路径必须有负责人和退出阶段」的落地：
 * 旧路径此刻仍是**兜底**，它的退出条件是"装配层覆盖全部形态"。
 *
 * ## 诊断不吞
 *
 * 装配产出的诊断（未知字段/不支持能力）逐条写日志。它们**同时**已进
 * `unknownFields`（供适配器层构造保真记录）—— 这里只是让它们在 UI 上可见。
 */
export function adoptDocumentIntoKernel(
  ctx: {
    readonly kernel: import('@/runtime/kernelSession').KernelSession | null
    log: { info(scope: string, message: string, detail?: unknown): void; warn(scope: string, message: string, detail?: unknown): void }
  },
  doc: RuntimeDocument,
  plainRoot: Readonly<Record<string, unknown>> | undefined,
  locator: string,
): void {
  const kernel = ctx.kernel
  if (kernel === null) {
    // 无会话（诊断/装配测试路径）：不装配，也不报错 —— 那是配置事实，不是缺陷。
    return
  }
  const assembled = assembleKernelDocument({ doc, plainRoot })
  if (!assembled.ok) {
    ctx.log.warn('场景加载', `内核装配未支持该文档形态（旧路径照常渲染）`, {
      locator,
      code: assembled.error.code,
      reason: assembled.error.params.reason,
    })
    return
  }
  const value = assembled.value
  // 组装内核 Document：装配产出的场景 + 内容三块。
  // 基线钉到内容本身（"刚打开 = 与保存基线相同"，与 `restoreProject` 同一口径）。
  const base = createDocument(kernel.documentId, { sceneId: value.scene.id, content: value.content })
  const withScene = withContent(base, value.scene, base.animation, value.content)
  const withBaseline = Object.freeze({ ...withScene.doc, saveBaseline: withScene.version })
  const adopted = withDocumentContent(withBaseline, value.content).doc
  kernel.adoptDocument(adopted, value.content)

  for (const d of value.diagnostics) {
    ctx.log.info('内核装配', `${d.code} @ ${d.path}`, { locator, detail: d.detail })
  }
  ctx.log.info('场景加载', '内核装配完成', {
    locator,
    objects: Object.keys(value.scene.objects).length,
    frames: value.frameObjects.length,
    resources: value.content.resources.length,
    multiblock: value.multiblock !== null,
    unknownFields: Object.keys(value.unknownFields).length,
    diagnostics: value.diagnostics.length,
  })
}

/** 未使用占位：保持 `openDocumentState` 可达（诊断脚本/装配测试用）。 */
export const __kernelOpenDocumentState = openDocumentState

/**
 * 取"解析器看到的 plain 形状"（信封解包 + meta 合并的产物）。
 *
 * ## 为什么必须有这一步（实测的有损中间层）
 *
 * `RuntimeDocument.fromV2Plain` 的 `known` 集合列了 `label`/`author`/`description`
 * 等根级键却从不读、也排除在 `_extra` 外 ⇒ 它们从 `RuntimeDocument` **无法恢复**
 * （实测：真实多方块产物的展示名 `plain.label` 有值，而
 * `doc.serialize().label === undefined`）。装配层要吃**未经损失的源**。
 *
 * ## 为什么是 `async`，以及为什么它值得一次重复解包
 *
 * 信封解包可能 gunzip，故必须 `await`。这确实让同一份文件被解包两次
 * （解析器一次、这里一次）。接受这个代价的理由：
 *
 *  - 另一条路是让解析器把 plain 形状随结果一起返回，那要改 `parserRegistry` 的
 *    `ParseResult` 形状 —— 那是**文件面**（P9/#260 的领地），本批不擅自扩；
 *  - 而"元数据静默丢失"是**已经在真实夹具上实测到**的缺陷（三份夹具全部空标题），
 *    它的修复优先于一次解包开销；
 *  - 解包是纯函数（同一输入同一输出），故两次结果必然一致 —— 不存在"两次读到
 *    不同内容"的风险。
 *
 * 非信封文档的输入**就是** plain 形状，故直接返回它（零额外成本）。
 * 根治（解析器随结果返回 plain）登记为遗留缺口（见汇报）。
 */
async function plainRootOf(raw: unknown): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  if (!isEnvelopeDocument(raw)) return raw as Record<string, unknown>
  // 解包逻辑**不**在这里重写：交给既有的 `normalizeEnvelopeToPlain`
  // （它已处理 `base64(json)` 与 `base64(gzip(json))` 两种载荷）。判据不复制。
  const plain = await normalizeEnvelopeToPlain(raw)
  return plain === null || typeof plain !== 'object' || Array.isArray(plain) ? undefined : (plain as Record<string, unknown>)
}

/**
 * Open a native file picker for .json files.
 *
 * NOTE: The window focus + setTimeout(300) hack below is needed because
 * there is no standard callback for "user cancelled the file picker".
 * The 'focus' event fires when the user closes the picker without
 * selecting a file (tab returns to the window). A short delay lets
 * the browser populate input.files before we check it.
 */
function pickFile(): Promise<File | undefined> {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = () => {
      cleanup()
      resolve(input.files?.[0])
    }
    const onFocus = () => {
      setTimeout(() => {
        if (!input.files?.length) {
          cleanup()
          resolve(undefined)
        }
      }, 300)
    }
    const cleanup = () => window.removeEventListener('focus', onFocus)
    window.addEventListener('focus', onFocus)
    input.click()
  })
}

export const NewSceneOperator: OperatorType = {
  id: 'OPERATOR_NEW_SCENE',
  label: '新建场景',
  description: '创建空白新场景',

  poll(_ctx) {
    return true
  },

  async exec(ctx, _props) {
    if (ctx.getEditHistory().canUndo.value) {
      const confirmFn = ctx.getToolSettings().confirmDirty ?? window.confirm
      if (!confirmFn('当前场景有未保存的修改，是否保存？')) return
      await ctx.getOperators().exec('OPERATOR_SAVE_FILE')
    }
    ctx.getSelection().clear()
    ctx.getEditHistory().clear()
    const doc = RuntimeDocument.empty()
    ctx.main.replaceDoc(doc)
    ctx.main.embedInitialView.value = null
    ctx.viewports.resetAllViewportCameras(ctx.main.cameras)
  },
}

export const OpenSceneOperator: OperatorType = {
  id: 'OPERATOR_OPEN_SCENE',
  label: '打开场景',
  description: '从文件加载场景',

  poll(_ctx) {
    return true
  },

  async exec(ctx, _props) {
    let file = _props.file as File | undefined
    if (!file) {
      file = await pickFile()
      if (!file) return
    }
    if (ctx.getEditHistory().canUndo.value) {
      const confirmFn = ctx.getToolSettings().confirmDirty ?? window.confirm
      if (!confirmFn('当前场景有未保存的修改，是否保存？')) return
      await ctx.getOperators().exec('OPERATOR_SAVE_FILE')
    }
    ctx.getSelection().clear()
    ctx.getEditHistory().clear()
    const text = await file.text()
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch (e) {
      throw new Error(`JSON 解析失败：${e}`)
    }
    const result = await ctx.main.registries.parsers.detectAndParse(data)
    if (result.document) {
      ctx.main.replaceDoc(result.document)
      ctx.viewports.resetAllViewportCameras(ctx.main.cameras)
      hydrateMainEmbedInitialViewFromDoc(ctx.main)
      ctx.requireKernelSession().seekFrame(0)
      // #282 P10b：装配进内核（权威迁到内核；失败时旧路径兜底并记日志）。
      // `plainRoot` 用**解析器看到的形状**（信封解包后的 plain），不是
      // `result.document.serialize()` —— 后者是有损的（见 kernelAssembly 的实测说明）。
      adoptDocumentIntoKernel(ctx, result.document, await plainRootOf(data), file.name)
      const totalBlocks = result.document.frames.reduce((sum, f) => sum + (f.grid?.count() ?? 0), 0)
      ctx.log.info('场景加载', file.name, { fileName: file.name, frames: result.document.frameCount, blocks: totalBlocks })
    } else {
      ctx.main.replaceDoc(null)
      ctx.main.embedInitialView.value = null
      ctx.viewports.resetAllViewportCameras(ctx.main.cameras)
      ctx.log.error('场景加载', result.error ?? '未知错误', { fileName: file.name, error: result.error })
    }
    ctx.getLocalFileName().value = file.name
    await ctx.getOperators().exec('OPERATOR_SET_WORKSPACE_MODE', { mode: 'local-file' })
  },
}

export const SaveFileOperator: OperatorType = {
  id: 'OPERATOR_SAVE_FILE',
  label: '保存到文件',
  description: '将当前场景保存到本地文件',

  poll(ctx) {
    return ctx.getDoc().value !== null
  },

  exec(ctx, _props) {
    const doc = ctx.getDoc().value?.serialize()
    if (!doc) return
    const baseName = suggestedJsonBaseName(ctx.getLocalFileName().value, 'structure-export')
    downloadJson(baseName, doc, true)
  },
}

export const LoadBuiltinSceneOperator: OperatorType = {
  id: 'OPERATOR_LOAD_BUILTIN',
  label: '加载内置示例',
  description: '加载内置示例场景',

  poll(_ctx) {
    return true
  },

  async exec(ctx, _props) {
    const sceneId = _props.sceneId as string | undefined
    const id = sceneId && sceneId.length > 0 ? sceneId : DEFAULT_PREVIEW_SCENE_ID
    const raw = getDevSceneDocument(id)
    ctx.getSelection().clear()
    ctx.getEditHistory().clear()
    const result = await ctx.main.registries.parsers.detectAndParse(raw)
    if (result.document) {
      ctx.main.replaceDoc(result.document)
      ctx.viewports.resetAllViewportCameras(ctx.main.cameras)
      hydrateMainEmbedInitialViewFromDoc(ctx.main)
      ctx.requireKernelSession().seekFrame(0)
      const totalBlocks = result.document.frames.reduce((sum, f) => sum + (f.grid?.count() ?? 0), 0)
      ctx.log.info('场景加载', `示例 · ${id}.json`, { fileName: `示例 · ${id}.json`, frames: result.document.frameCount, blocks: totalBlocks })
    } else {
      ctx.main.replaceDoc(null)
      ctx.main.embedInitialView.value = null
      ctx.viewports.resetAllViewportCameras(ctx.main.cameras)
      ctx.log.error('场景加载', result.error ?? '未知错误', { fileName: `示例 · ${id}.json`, error: result.error })
    }
    await ctx.getOperators().exec('OPERATOR_SET_WORKSPACE_MODE', { mode: 'local-bundle' })
    ctx.getLocalFileName().value = `示例 · ${id}.json`
  },
}

export const LoadEmbedDocumentOperator: OperatorType = {
  id: 'OPERATOR_LOAD_EMBED_DOCUMENT',
  label: '加载嵌入文档',
  poll: () => true,
  async exec(ctx, props) {
    const raw = props.document
    const result = await ctx.main.registries.parsers.detectAndParse(raw)
    if (!result.document) throw new Error('无法加载结构数据')
    ctx.main.replaceDoc(result.document)
    ctx.viewports.resetAllViewportCameras(ctx.main.cameras)
    hydrateMainEmbedInitialViewFromDoc(ctx.main)
  },
}
