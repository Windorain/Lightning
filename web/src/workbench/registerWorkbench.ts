import type { OperatorType } from '@/operators/operatorType'
import type { OperatorRegistry } from '@/operators/operatorRegistry'
import {
  blockInspectorPanel, toolShelfPanel,
  transformPanel, sceneInfoPanel,
  menuBarPanel, blockStatsPanel,
  annotationPanel, wikiConfigPanel,
  tooltipEditorPanel,
} from '@/workbench/ux/panels'
import { SelectOperator, SelectByTypeOperator, SelectAllOperator } from '@/operators/builtin/selectOperator'
import { MoveOperator } from '@/operators/builtin/moveTranslate'
import {
  ViewRotateOperator, ViewPanOperator, ViewZoomOperator, ViewResetOperator,
  InitViewportCameraOperator,
} from '@/operators/builtin/viewOperators'
import { TooltipEditOperator } from '@/operators/builtin/metaEditOperators'
import { NewSceneOperator, OpenSceneOperator, SaveFileOperator, LoadBuiltinSceneOperator, SaveProjectOperator, OpenProjectOperator } from '@/operators/builtin/docLifecycleOperators'
import { SDEConnectOperator, SDELoadExportOperator, SDELoadWorkspaceOperator, SDEPushOperator } from '@/operators/builtin/sdeOperators'
import { ExportPlainOperator, ExportEnvelopeOperator, ExportObjOperator, ExportIsoPngOperator, ExportSceneGifOperator, ExportShotPngOperator } from '@/operators/builtin/exportOperators'
import { AnnotationCreateOperator, AnnotationUpdateOperator, AnnotationDeleteOperator } from '@/operators/builtin/annotationOperators'
import {
  SetFrameIndexOperator, ToggleFramePlaybackOperator, SetFramePlaybackOperator, SetHoveredBlockOperator, SetHoveredAnnotationOperator,
  ThemeToggleOperator, SetLanguageOperator, SetToolSettingOperator, SetRegionSettingOperator, UndoOperator, RedoOperator,
  SetWorkspaceModeOperator, ResetLayoutOperator, SetWikiConfigOperator, ApplySettingsOperator, SetLayerYOperator,
} from '@/operators/builtin/miscOperators'
import { ExportTextureOperator, CopyMaterialLocatorOperator } from '@/operators/builtin/materialOperators'
import {
  HydrateEmbedInitialViewOperator,
  SyncEmbedInitialViewOperator,
} from '@/operators/builtin/embedInitialViewOperators'
import {
  DocumentLoadOperator,
  DocumentSaveOperator,
  WikiReloadOperator,
  WikiPreviewSaveOperator,
} from '@/operators/builtin/documentIoOperators'
import {
  WikiPickAndLoadOperator,
  WikiSaveConfirmOperator,
  WikiSaveAsOperator,
  CopyWikiEmbedOperator,
} from '@/operators/builtin/wikiOperators'
import { CAPABILITY } from '@/composition/modules'
import { RecoveryAdoptOperator, RecoveryDiscardOperator } from '@/operators/builtin/recoveryOperators'
import { RetryResourcesOperator } from '@/operators/builtin/resourceOperators'
import { AREA_OPERATORS } from '@/operators/builtin/areaOperators'
import { selectTool, moveTool } from '@/workbench/tools/toolDefs'
import { MoveGizmo } from '@/workbench/tools/gizmos'
import { boxTool, boxFullTool, BoxGizmo, AnnotationBoxCommitOperator, AnnotationBoxResetOperator } from '@/workbench/tools/boxTool'
import { pointTool, PointGizmo } from '@/workbench/tools/pointTool'
import { lineTool, LineGizmo } from '@/workbench/tools/lineTool'
import { textTool, TextGizmo } from '@/workbench/tools/textTool'
import { faceTool, FaceGizmo } from '@/workbench/tools/faceTool'
import type { ToolRegistry } from '@/workbench/tools/registry'
import { unhandledWritableTypes } from '@/editors/workbench-rna'
import type { PanelDeclaration } from '@/workbench/ux/types/panel'
import type { ToolSettings } from '@/runtime/contextAccess'

export const WORKBENCH_PANELS = {
  toolShelf: [toolShelfPanel] as PanelDeclaration[],
  header: [menuBarPanel] as PanelDeclaration[],
  properties: [
    blockInspectorPanel, transformPanel, sceneInfoPanel, blockStatsPanel,
    annotationPanel, wikiConfigPanel, tooltipEditorPanel,
  ] as PanelDeclaration[],
}

const WORKBENCH_OPERATORS: OperatorType[] = [
  SelectOperator, SelectByTypeOperator, SelectAllOperator, MoveOperator,
  UndoOperator, RedoOperator,
  ViewRotateOperator, ViewPanOperator, ViewZoomOperator, ViewResetOperator,
  InitViewportCameraOperator,
  TooltipEditOperator,
  NewSceneOperator, OpenSceneOperator, SaveFileOperator, LoadBuiltinSceneOperator,
  // 工程格式的生产开/存入口（实测 `adapters/files/projectFormat`
  // 此前零生产调用者 ⇒ "保存/重开一份工程"在产品里没有入口）。
  SaveProjectOperator, OpenProjectOperator,
  SetFrameIndexOperator, ToggleFramePlaybackOperator, SetFramePlaybackOperator, SetToolSettingOperator, SetRegionSettingOperator, SetHoveredBlockOperator, SetHoveredAnnotationOperator, SetLayerYOperator, ApplySettingsOperator, SetWikiConfigOperator,
  SetWorkspaceModeOperator, ResetLayoutOperator,
  SDEConnectOperator, SDELoadExportOperator, SDELoadWorkspaceOperator, SDEPushOperator,
  ExportPlainOperator, ExportEnvelopeOperator, ExportObjOperator, ExportIsoPngOperator, ExportSceneGifOperator,
  // 验收器具：指定正交机位出图（MC 控制面 CameraSpec 口径；走同一条捕获/作业链）。
  // 不在产品面板展示 —— 由 e2e / 脚本以 operator id 直接调。
  ExportShotPngOperator,
  ThemeToggleOperator, SetLanguageOperator,
  AnnotationCreateOperator, AnnotationUpdateOperator, AnnotationDeleteOperator,
  AnnotationBoxCommitOperator, AnnotationBoxResetOperator,
  ExportTextureOperator, CopyMaterialLocatorOperator,
  HydrateEmbedInitialViewOperator,
  SyncEmbedInitialViewOperator,
  DocumentLoadOperator,
  DocumentSaveOperator,
  WikiReloadOperator,
  WikiPreviewSaveOperator,
  WikiPickAndLoadOperator,
  WikiSaveConfirmOperator,
  WikiSaveAsOperator,
  CopyWikiEmbedOperator,
  // 恢复副本的显式采纳/放弃（底栏按钮与命令共用同一条入口；
  // **没有**"读到就自动采纳"的路径）。
  RecoveryAdoptOperator,
  RecoveryDiscardOperator,
  // 资源失败的手动重试入口（底栏按钮与命令共用同一条入口）。
  RetryResourcesOperator,
  // Area 布局编辑命令的 operator 入口（分割/合并/切类型/调比例）。
  // `poll` 读"是否有 Area 会话"（装配结果）⇒ 嵌入外壳里天然不可用。
  ...AREA_OPERATORS,
]

/**
 * 把 SDE 相关 operator 的 `poll` 收窄到"本外壳**没有** Wiki 上传能力"时才可用。
 *
 * 旧实现是 `if (isWikiHostProfile()) return false`（模块级宿主反查）。
 * 现在问的是能力 —— SDE（外部 JAR 连接）与 Wiki 上传是两条互斥的文档来源，
 * 这个互斥是**装配**的后果，不是"宿主叫什么"的后果。
 */
function disableOnWikiProfile(op: OperatorType): OperatorType {
  if (!op.poll) return op
  const origPoll = op.poll.bind(op)
  return {
    ...op,
    poll(ctx) {
      if (ctx.hasCapability(CAPABILITY.WIKI_UPLOAD)) return false
      return origPoll(ctx)
    },
  }
}

const SDE_OPERATOR_IDS = new Set([
  'OPERATOR_SDE_CONNECT',
  'OPERATOR_SDE_LOAD',
  'OPERATOR_SDE_LOAD_WORKSPACE',
  'OPERATOR_SDE_PUSH',
])

export function registerWorkbenchOperators(registry: OperatorRegistry): void {
  for (const op of WORKBENCH_OPERATORS) {
    const toRegister = SDE_OPERATOR_IDS.has(op.id) ? disableOnWikiProfile(op) : op
    if (!registry.find(toRegister.id)) registry.register(toRegister)
  }
}

/**
 * RNA 注册。
 *
 * 旧实现 `registerWorkbenchRna(main)` 造一个 `RNAStruct` 注册表并塞进 `main.registries.rna`；
 * 那份描述自带 `get`/`set` 闭包与 `uiWidget` 控件名（禁止）。
 *
 * 新形态：属性描述由 `@/editors/workbench-rna` 的 `workbenchRegistry()` **按需构造**
 * （对象类型声明是数据，不是往 `Main` 上挂的可变注册表），因此 `main.registries.rna`
 * 与 `context.getRna()` 一并不再需要。本函数保留为**装配期的自检入口**：
 * 校验「声明的可写对象类型都有写入端口」——即启动期就能发现装配缺陷，
 * 而不是等到用户点某个控件时才发现 `UnsupportedOperation`。
 */
export function validateWorkbenchRna(): readonly string[] {
  return unhandledWritableTypes()
}

/**
 * 注册工作台工具与其 gizmo **工厂**（gizmo 按 region 归属）。
 *
 * ## 为什么这里不再造实例、也不再往 `'r-viewport'` 槽位写
 *
 * 旧实现造**一个** `MoveGizmo` 并塞进根视口槽位 ⇒ 第二区没有 gizmo（旧缺口），
 * 而两区共用同一个 `Object3D` 在结构上也不可能（一个节点只有一个父）。
 *
 * 现在注册的是**工厂**：每个视口在 `ready` 时向注册表要**本区**的实例
 * （`ToolRegistry#gizmoOf(toolId, regionId)`），并挂到本区的
 * `toolsOverlayGroup`。注册期因此不需要知道"未来会分割出哪些 region"。
 */
export function registerWorkbenchTools(
  toolRegistry: ToolRegistry,
  _tool: ToolSettings,
): void {
  toolRegistry.register(selectTool)
  toolRegistry.register(moveTool, () => new MoveGizmo())
  toolRegistry.register(boxTool, () => new BoxGizmo())
  toolRegistry.register(boxFullTool, () => new BoxGizmo())
  toolRegistry.register(pointTool, () => new PointGizmo())
  toolRegistry.register(lineTool, () => new LineGizmo())
  toolRegistry.register(textTool, () => new TextGizmo())
  toolRegistry.register(faceTool, () => new FaceGizmo())
  toolRegistry.activate('select')
}
