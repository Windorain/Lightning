import type { OperatorType } from '@/operators/operatorType'
import { hydrateMainEmbedInitialViewFromDoc } from '@/context/embedInitialView'
import { RuntimeDocument } from '@/context/runtimeDocument'
import { getDevSceneDocument } from '@/dev/devScenes'
import { downloadJson } from '@/util/browser'
import { suggestedJsonBaseName } from '@/workbench/utils/fileNaming'
import { DEFAULT_PREVIEW_SCENE_ID } from '@/viewer/viewerSession'
// #289 P10d（D1）：装配与信封解包判据**移出本文件**，落在 `composition/documentLoad`
// —— 于是文件选择器路径与 `workbench/document/pipeline.ts` 的 `DocumentSource` 路径
// （wiki-data / SDE / 本地抽屉）共用**同一份**判据，而不是各写一份并必然漂移。
import { adoptLoadedDocument, type KernelLoadHost } from '@/composition/documentLoad'
import {
  adoptProject,
  decodeProjectFile,
  projectForSave,
  type ProjectHost,
} from '@/composition/projectIo'
import { plainRootOf } from '@/adapters/plainRoot'

/**
 * **把一份已解析的旧文档装进内核会话**（#282 P10b 建立；#289 P10d（D1）改为**转发**）。
 *
 * ## 为什么现在只是一层转发
 *
 * 实现已移到 `composition/documentLoad`。理由是实测的**最高价值缺口**：
 * 本文件所在的文件选择器路径会装配内核，而 `workbench/document/pipeline.ts` 的
 * `DocumentSource` 路径（**wiki-data** / SDE / 本地文件抽屉）**从不**装配 ——
 * 于是内核文档只在文件选择器路径被填充，而 wiki-data 是最高价值路径。
 *
 * 两条路径必须共用**同一份**装配判据，否则"装进内核的到底是什么"有两个答案并必然漂移。
 * `composition/` 是它们唯一的共同祖先（见 `composition/documentLoad` 的文件头）。
 *
 * 保留本函数名与签名（而非让调用点直接 import 新模块）的理由：它与 `operators` 层的
 * `ctx` 形状一致，调用点读起来仍是"本算子装配了内核"；而**判据**只有一处。
 */
export function adoptDocumentIntoKernel(
  ctx: KernelLoadHost,
  doc: RuntimeDocument,
  plainRoot: Readonly<Record<string, unknown>> | undefined,
  locator: string,
): void {
  adoptLoadedDocument(ctx, doc, plainRoot, locator)
}

/**
 * `Context` → 工程接线的**宿主面**（结构端口）。
 *
 * `composition/projectIo` 只认识 {@link ProjectHost} 的三件事（内核会话 +
 * 换 legacy 载体），于是它**不依赖** `Context` 这个旧类型 —— 这是"依赖方向"
 * 的结构保证：算子层（旧）→ `composition/`（新装配层），
 * 而后者到 `adapters/`/`domain/` 的边是**新层内部**的（不产生新的旧→新边）。
 */
/**
 * `Context` → 工程接线的**宿主面**（结构端口）。
 *
 * ## 为什么这里**不**写 `import('@/runtime/kernelSession').KernelSession`
 *
 * 那正是 R1-α 段二**删除**过的那条边（
 * `docLifecycleOperators.ts:32` 的类型位置导入，R0-3 点名的闸门漏网实例）——
 * 在这里重新写一遍就是把它请回来。宿主面的类型由 `composition/projectIo`
 * 的 {@link ProjectHost} 给出，本函数的参数由**调用点**的 `ctx`（算子签名里的
 * `Context`）推断 ⇒ 不需要在这里点名任何内核类型。
 *
 * ⚠️ 参数用 `Pick<...>` 式的结构标注而非 `Context`：本文件已 import
 * `RuntimeDocument`（旧层内部），而 `Context` 类型由算子签名给出 ——
 * 手写一个只含两项的结构类型让"本函数需要什么"**显式**，也避免把
 * `Context` 的完整形状耦合进来。
 */
function projectHostOf(ctx: {
  readonly kernel: ProjectHost['kernel']
  setDocument(next: RuntimeDocument | null): void
}): ProjectHost {
  return { kernel: ctx.kernel, setDocument: (next) => ctx.setDocument(next) }
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
    // #301 A′：经**唯一写入口**（它同时镜像内核的装载状态）。
    // NewScene 的语义是"空**但存在**"——与"无文档"不同，故走 `setDocument(doc)`
    // 而非 `setDocument(null)`（后者会让内核侧读到"未装载"）。
    ctx.setDocument(doc)
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
      // #301 A′：经唯一写入口（存在性镜像），随后 `adoptDocumentIntoKernel` 装配内容。
      ctx.setDocument(result.document)
      ctx.viewports.resetAllViewportCameras(ctx.main.cameras)
      hydrateMainEmbedInitialViewFromDoc(ctx.main)
      ctx.requireKernelSession().seekFrame(0)
      // #282 P10b：装配进内核（权威迁到内核；失败时旧路径兜底并记日志）。
      // `plainRoot` 用**解析器看到的形状**（信封解包后的 plain），不是
      // `result.document.serialize()` —— 后者是有损的（见 kernelAssembly 的实测说明）。
      adoptDocumentIntoKernel(ctx, result.document, plainRootOf(data), file.name)
      const totalBlocks = result.document.frames.reduce((sum, f) => sum + (f.grid?.count() ?? 0), 0)
      ctx.log.info('场景加载', file.name, { fileName: file.name, frames: result.document.frameCount, blocks: totalBlocks })
    } else {
      ctx.setDocument(null)
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
    return ctx.hasLoadedDocument()
  },

  exec(ctx, _props) {
    // #301 P10f D2：产物改由**内核投影**给出（`plainForSave` 是唯一分流点；
    // 未装配时自动回落旧文档 —— 能力不回退）。
    const doc = ctx.plainForSave().plain
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
      ctx.setDocument(result.document)
      ctx.viewports.resetAllViewportCameras(ctx.main.cameras)
      hydrateMainEmbedInitialViewFromDoc(ctx.main)
      ctx.requireKernelSession().seekFrame(0)
      // #301 A′：**本路径此前从不装配内核**（P10e 侦察点名的 9 条未装配路径之一）。
      // 不装配的后果是"改读内核"会在这条路径上读到**空内核文档** —— 静默能力回退。
      // `plainRoot` 用 `raw`（`getDevSceneDocument(id)` 的产物，即解析器看到的源）；
      // `plainRootOf` 是**同步**函数（非 Promise），故不 await（P10e 统一口径）。
      adoptDocumentIntoKernel(ctx, result.document, plainRootOf(raw), `示例 · ${id}.json`)
      const totalBlocks = result.document.frames.reduce((sum, f) => sum + (f.grid?.count() ?? 0), 0)
      ctx.log.info('场景加载', `示例 · ${id}.json`, { fileName: `示例 · ${id}.json`, frames: result.document.frameCount, blocks: totalBlocks })
    } else {
      ctx.setDocument(null)
      ctx.main.embedInitialView.value = null
      ctx.viewports.resetAllViewportCameras(ctx.main.cameras)
      ctx.log.error('场景加载', result.error ?? '未知错误', { fileName: `示例 · ${id}.json`, error: result.error })
    }
    await ctx.getOperators().exec('OPERATOR_SET_WORKSPACE_MODE', { mode: 'local-bundle' })
    ctx.getLocalFileName().value = `示例 · ${id}.json`
  },
}

/**
 * **保存工程**（`OPERATOR_SAVE_PROJECT`；R1-α 接通 `adapters/files/projectFormat`）。
 *
 * ## 为什么需要第二个"保存"算子（它不是 `OPERATOR_SAVE_FILE` 的重复）
 *
 * 两个算子写**同一份权威**（内核 `Document`）的**两种外部形状**：
 *
 * | 算子 | 产物 | 编码器 | 用途 |
 * |---|---|---|---|
 * | `OPERATOR_SAVE_FILE` | 旧 plain/信封 | `Context#plainForSave()` → `RuntimeDocument.serialize()` | 与既有场景格式互操作（导出/交给 MC 侧） |
 * | `OPERATOR_SAVE_PROJECT`（本算子） | 工程文件 | `adapters/files/projectFormat#encodeProject` | **继续编辑**：带资源身份 + 可恢复编辑数据 + 显式 `formatVersion` |
 *
 * R0-D④ 实测：`encodeProject` 此前**零生产调用者** ⇒ 工程格式只是一条
 * 测试里的性质，产品里**没有**"保存工程"这件事。本算子 + `OPERATOR_OPEN_PROJECT`
 * 是那个缺口的落点（#249 §12 明文要求工程格式保存"类型化文档、版本、资源清单与
 * 可恢复编辑数据"）。
 *
 * ## 失败是**显式**的（不回落旧 plain）
 *
 * `projectForSave()` 在内核非权威时返回 `err`（无会话 / 未装配 / 无文档）。
 * 本算子把它翻成用户可见的错误，**不**改写成"那就存一份旧 plain 吧" ——
 * 那会让"工程文件里其实是旧格式"这件事静默发生（打开时才发现丢了资源身份）。
 */
export const SaveProjectOperator: OperatorType = {
  id: 'OPERATOR_SAVE_PROJECT',
  label: '保存工程',
  description: '将当前文档保存为工程文件（含资源清单与可恢复编辑数据）',

  poll(ctx) {
    return ctx.hasAdoptedContent()
  },

  exec(ctx) {
    const result = projectForSave(projectHostOf(ctx))
    if (!result.ok) {
      ctx.log.error('保存工程', '内核不是权威，无法编码工程文件', { reason: result.error.params })
      return
    }
    const baseName = suggestedJsonBaseName(ctx.getLocalFileName().value, 'project')
    // 工程文件是**边界产物**：`encodeProject` 已给出类型化负载，这里只负责写盘。
    downloadJson(baseName, result.value as unknown as Record<string, unknown>, true)
  },
}

/**
 * **打开工程**（`OPERATOR_OPEN_PROJECT`；`SaveProjectOperator` 的对偶）。
 *
 * ## 顺序与"唯一写入口"纪律
 *
 * 解码在**边界**（`Context#decodeProjectFile` → `adapters/files/projectFormat#decodeProject`），
 * 落地在 `Context#adoptProject`（`setDocument` → `seekFrame(0)` → `adoptDocument`，
 * 与装载脊柱同序，理由见 `adoptProject` 的说明）。
 *
 * 本算子**不**自己解析工程形状、也**不**自己构造 `Document` —— 那是边界与
 * `restoreProject` 的职责。算子只做三件事：取文件、交给它、报结果。
 */
export const OpenProjectOperator: OperatorType = {
  id: 'OPERATOR_OPEN_PROJECT',
  label: '打开工程',
  description: '从工程文件恢复文档与可恢复编辑数据',

  poll: () => true,

  async exec(ctx, _props) {
    let file = _props.file as File | undefined
    if (!file) {
      file = await pickFile()
      if (!file) return
    }
    const text = await file.text()
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (e) {
      throw new Error(`JSON 解析失败：${e}`)
    }
    const decoded = decodeProjectFile(raw)
    if (!decoded.ok) {
      // 显式失败：未知主版本 ⇒ `UnsupportedOperation`（**不**降级读取，
      // 见 `projectFormat` 文件头判据 1）。
      ctx.log.error('打开工程', '工程文件不被支持', {
        fileName: file.name,
        reason: decoded.error.code,
        params: decoded.error.params,
      })
      return
    }
    const adopted = adoptProject(projectHostOf(ctx), decoded.value)
    if (!adopted.ok) {
      ctx.log.error('打开工程', '宿主未装配内核，工程无法落地', { fileName: file.name, reason: adopted.error.params })
      return
    }
    ctx.viewports.resetAllViewportCameras(ctx.main.cameras)
    ctx.getLocalFileName().value = file.name
    ctx.log.info('打开工程', file.name, {
      fileName: file.name,
      documentId: decoded.value.payload.documentId,
      assets: decoded.value.payload.assets.length,
    })
    await ctx.getOperators().exec('OPERATOR_SET_WORKSPACE_MODE', { mode: 'local-file' })
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
    ctx.setDocument(result.document)
    ctx.viewports.resetAllViewportCameras(ctx.main.cameras)
    hydrateMainEmbedInitialViewFromDoc(ctx.main)
    // #301 A′：**本路径此前从不装配内核**（9 条未装配路径之一）。
    // `props.document` 是 `EmbedData.document`（`embedContract.ts:11-14` 声明为
    // 「SDE 打包后的 StructureData 或 World（根级含 `textureBlobs`）」）—— 即
    // **解析器输入本身的 plain 形状**，与 OpenScene 的 `data`、pipeline 的
    // `loadResult.raw` 同类，故 `plainRootOf` 对它是正确输入。
    adoptDocumentIntoKernel(ctx, result.document, plainRootOf(raw), 'embed')
  },
}
