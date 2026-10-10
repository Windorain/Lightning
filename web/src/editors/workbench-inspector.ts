/**
 * #253 P2 · 面板贡献 —— **对象类型的属性声明、布局与写入纯函数**（editors 层）。
 *
 * 依据：#249 §6（「基础 Inspector 由 RNA 生成控件；完整属性编辑器可专门布局」）、
 * §10（「功能模块以独立贡献文件注册」）、§19.7（翻译键/单位/回退文字）；
 * 契约 §5.1/§5.2/§7.2；#253 执行范围（「各贡献文件独立」是冲突隔离设施）。
 *
 * ## 为什么这是一个**独立贡献文件**（而不是编辑共享注册表）
 *
 * #250「共享瓶颈文件」约定：装配根与共享注册表由 P0/P1/P11 拥有；功能模块
 * **以独立贡献文件注册**。本文件就是 P2 的贡献文件 —— 它**只**导出数据与纯函数，
 * 不改 `registerWorkbench.ts` 的注册表结构（该文件由装配阶段更新，
 * 且 `registerWorkbenchRna` 的名字会在同一批里被替换掉，见本批的退役 #3）。
 *
 * ## 覆盖面（对照 #251 B7 的 A.1 登记表 50 条）
 *
 * 旧登记表的 **11 条「登记但 UI 永不实例化」**（`block.tooltip`/`block.cellTooltip`、
 * `toolsettings.*` 5 条、`material.*` 4 条）在生成式 Inspector 下**自动可达** ——
 * 不再需要有人记得把它们写进布局（这正是 B7 的 E-6「死属性」的根治）；
 * `annotation.description` 也不再需要面板自建 `textarea` 绕过 RNA。
 *
 * ## 只读与可编辑的**动态**性（#253「非静态 readonly」）
 *
 * 这里只声明**声明级**只读（`created_at`/`format_version`/`block.pos` 只读、
 * `annotation.type`/`id` 身份、`material.*` 只读查询面）；
 * 「当前能不能改」全部由 `evaluateEditability` 依状态（生成物 / 被轨道驱动 / 锁定 /
 * 租约）求值 —— 静态声明只是其中一项输入。
 */

import {
  type DomainError,
  type EntityOwnerKind,
  type EntityRef,
  type PropertyRef,
  type Result,
  type Version,
  domainError,
} from '@/application/contracts'
import {
  type CapabilityId,
  type Editability,
  type ObjectTypeDecl,
  type PropertyAccess,
  type PropertyDecl,
  type PropertyRegistry,
  type PropertyValue,
  type TargetFacts,
  type ValueDomain,
  CAP_PROPERTY_WRITE,
  evaluateEditability,
} from '@/application/properties'
import {
  type InspectorLayoutSpec,
  type InspectorLayoutRegistry,
  type InspectorModel,
  type InspectorTargets,
  buildInspectorModel,
  createInspectorLayoutRegistry,
} from './inspector'
import {
  type ControlRegistry,
  type FieldEditState,
  type ControlModel,
  modelFor,
} from './property-controls'
import {
  type PropertyWritePorts,
  type SetPropertyCommand,
  applySetProperty,
} from '@/application/property-commands'

// ─────────────────────────────────────────────────────────────────────────────
// 0. 拥有者种类与对象类型 ID
// ─────────────────────────────────────────────────────────────────────────────

/** 本批登记的对象类型 ID（各贡献方自有命名；不集中到一个枚举里）。 */
export const OBJECT_TYPE = {
  block: 'lightning.block',
  annotationBox: 'lightning.annotation.box',
  annotationPoint: 'lightning.annotation.point',
  annotationLine: 'lightning.annotation.line',
  annotationText: 'lightning.annotation.text',
  annotationFace: 'lightning.annotation.face',
  sceneMetadata: 'lightning.sceneMetadata',
  publishConfig: 'lightning.publishConfig',
  toolSettings: 'lightning.toolSettings',
  materialView: 'lightning.materialView',
} as const

export type ObjectTypeId = (typeof OBJECT_TYPE)[keyof typeof OBJECT_TYPE]

/**
 * 场景对象**种类**（`'block'` / `'annotation'`）—— 由 objectTypeId 推导，**不是** owner.kind。
 *
 * ## 冻结 #2 的落地（#250）
 *
 * 契约 §1.1 的 `EntityOwnerKind` 是**实体种类**的清单（`document`/`scene`/`object`/
 * `objectData`/`editContext`/`workspace`/`asset`/`evaluation`）。方块和注解都是**场景对象**，
 * 故它们的 `owner.kind` 一律是 `'object'`。
 *
 * 「这是方块还是注解」是**对象类型**（objectType）的差别，由物体自己的
 * `objectTypeId`（`lightning.block` vs `lightning.annotation.box`）表达。把 `'block'`
 * 塞进 `owner.kind` 曾让 `EntityOwnerKind` 变成开放联合（`| (string & {})`），
 * 于是「实体种类」这个契约概念失去可检查含义 —— 这正是冻结 #2 要修掉的。
 *
 * 本函数只回答"**是不是场景对象、是哪种**"，返回 `null` 表示不是场景对象
 * （文档元数据、壳设置、工具参数等）。要取契约 §1.1 的 owner kind 时用
 * {@link contractKindOf} —— 两件事不要混在一处判。
 */
export function sceneKindOf(objectTypeId: string): 'block' | 'annotation' | null {
  if (objectTypeId === OBJECT_TYPE.block) return 'block'
  return objectTypeId.startsWith('lightning.annotation.') ? 'annotation' : null
}

/**
 * 对象类型 → 契约 §1.1 的 owner kind（**唯一**映射点）。
 *
 * 为什么需要它：`sceneKindOf` 只区分场景对象的两种；而壳设置/工具参数/文档元数据
 * 不是场景对象，它们各自的 owner kind 必须落在 §1.1 清单内 —— 按契约 §6 所有权表：
 *  - 发布配置（视口尺寸 / 背景 / 特征开关）属**工作区**面（Area 与固定目标）⇒ `workspace`；
 *  - 工具会话参数（画笔 / 吸附 / 拖拽灵敏度）属**活动工具**面 ⇒ `editContext`；
 *  - 文档元数据 ⇒ `document`；材质视图是资源查询面 ⇒ `asset`。
 *
 * 早先把它们写成 `'shellSettings'`/`'toolSettings'` 是**自造种类**：既不在 §1.1 里，
 * 又逼 `EntityOwnerKind` 开逃生口（`contracts.ts` 里那份开放联合即由此而来）。
 */
export function contractKindOf(objectTypeId: string): EntityOwnerKind {
  if (sceneKindOf(objectTypeId) !== null) return 'object'
  if (objectTypeId === OBJECT_TYPE.sceneMetadata) return 'document'
  if (objectTypeId === OBJECT_TYPE.publishConfig) return 'workspace'
  if (objectTypeId === OBJECT_TYPE.toolSettings) return 'editContext'
  return 'asset'
}

/** 拥有者种类 → 实体引用（面板与命令共用同一构造口径）。 */
export function documentOwner(): EntityRef {
  return { kind: 'document', id: 'document' }
}
/** 方块对象引用（冻结 #2：场景对象 owner.kind 一律 `'object'`）。 */
export function blockOwner(pos: { x: number; y: number; z: number }): EntityRef {
  return { kind: 'object', id: `${pos.x},${pos.y},${pos.z}` }
}
/** 注解对象引用（冻结 #2：同上；注解 ID 是稳定 ID）。 */
export function annotationOwner(id: string): EntityRef {
  return { kind: 'object', id }
}
export function globalOwner(kind: EntityOwnerKind, id: string): EntityRef {
  return { kind, id }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 声明构造的小工具（减少重复，但不引入「万能注册器」）
// ─────────────────────────────────────────────────────────────────────────────

function decl(p: PropertyDecl): PropertyDecl {
  return p
}

function numberRange(min: number, max: number, hard: boolean, step?: number): ValueDomain {
  return { kind: 'number', min, max, hard, ...(step !== undefined ? { step } : {}) }
}

function enumDomain(items: readonly string[]): ValueDomain {
  return {
    kind: 'enum',
    items: items.map((v) => ({ value: v, display: { labelKey: `enum.${v}`, fallback: v } })),
  }
}

const HEX_PATTERN: ValueDomain = {
  kind: 'pattern',
  source: '^#[0-9a-fA-F]{6}$',
  hintKey: 'validation.hexColor',
  hintFallback: '#RRGGBB',
}

const PX = { kind: 'pixels' as const, symbolKey: 'unit.px', symbolFallback: 'px' }
const RATIO = { kind: 'ratio' as const }

// ─────────────────────────────────────────────────────────────────────────────
// 2. 对象类型声明
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **方块**（`lightning.block`）。
 *
 * 与旧 `blockRNA` 的关键差别：
 *  - `pos` 声明为**只读**（契约 §7.1：位置是**派生视图**，自 `blockOwner(pos)` 而来，
 *    经**具名移动命令**改，不经属性写）—— 旧实现允许 `descriptor.set` 直接改 `owner.pos`，
 *    而 owner 是选区快照，改了不落文档（#251 B7 的 C-02/C-03 实测）。
 *  - `tooltip`/`cellTooltip` **不再是死属性**：生成式 Inspector 自动可达，
 *    且写入经 `OPERATOR_TOOLTIP_EDIT` 的同一语义（成对写 tooltipPalette + cellTooltipGrid）。
 */
export const BLOCK_DECL: ObjectTypeDecl = {
  id: OBJECT_TYPE.block,
  ownerKind: 'object',
  display: { labelKey: 'objectType.block', fallback: '方块' },
  properties: [
    decl({
      id: 'id',
      valueType: 'string',
      animatable: false,
      display: { labelKey: 'block.id', fallback: '方块标识', descriptionKey: 'block.id.desc', descriptionFallback: '方块类型标识符' },
      domain: { kind: 'pattern', source: '^[^\\s]+$', hintKey: 'validation.locator', hintFallback: 'namespace:path' },
    }),
    decl({
      id: 'pos',
      valueType: 'vec3',
      unit: { kind: 'length', symbolKey: 'unit.block', symbolFallback: '' },
      animatable: true,
      defaultSamplingStrategy: 'vector-linear',
      readOnly: true,
      readOnlyReason: 'derived-position',
      display: { labelKey: 'block.pos', fallback: '坐标', descriptionKey: 'block.pos.desc', descriptionFallback: '方块在世界中的位置（移动经具名命令）' },
      domain: numberRange(0, 4096, false, 1),
    }),
    decl({
      id: 'tooltip',
      valueType: 'string',
      animatable: false,
      display: { labelKey: 'block.tooltip', fallback: 'Tooltip', descriptionKey: 'block.tooltip.desc', descriptionFallback: '方块的悬浮提示文本' },
      domain: { kind: 'text', multiline: false },
    }),
    decl({
      id: 'cellTooltip',
      valueType: 'string',
      animatable: false,
      display: { labelKey: 'block.cellTooltip', fallback: '单元格 Tooltip', descriptionKey: 'block.cellTooltip.desc', descriptionFallback: '方块单元格级 Tooltip' },
      domain: { kind: 'text', multiline: false },
    }),
  ],
}

/** 注解的**共用**属性（每种注解类型各自拥有声明，避免「一个万能 annotation 类型」）。 */
function annotationCommon(): PropertyDecl[] {
  return [
    decl({
      id: 'id',
      valueType: 'string',
      animatable: false,
      readOnly: true,
      readOnlyReason: 'identity',
      display: { labelKey: 'annotation.id', fallback: '标识' },
    }),
    decl({
      id: 'type',
      valueType: 'enum',
      animatable: false,
      readOnly: true,
      readOnlyReason: 'identity',
      display: { labelKey: 'annotation.type', fallback: '类型' },
      domain: enumDomain(['box', 'point', 'line', 'text', 'face']),
    }),
    decl({
      id: 'description',
      valueType: 'string',
      animatable: false,
      display: { labelKey: 'annotation.description', fallback: '描述' },
      domain: { kind: 'text', multiline: true },
    }),
    decl({
      id: 'color',
      valueType: 'color',
      animatable: true,
      display: { labelKey: 'annotation.color', fallback: '颜色', decimals: 0 },
      domain: HEX_PATTERN,
    }),
    decl({
      id: 'visible',
      valueType: 'boolean',
      animatable: true,
      display: { labelKey: 'annotation.visible', fallback: '可见' },
    }),
    decl({
      id: 'locked',
      valueType: 'boolean',
      animatable: false,
      display: { labelKey: 'annotation.locked', fallback: '锁定', descriptionFallback: '锁定后不可在视口中编辑' },
    }),
    decl({
      id: 'created_at',
      valueType: 'string',
      animatable: false,
      readOnly: true,
      readOnlyReason: 'timestamp',
      display: { labelKey: 'annotation.createdAt', fallback: '创建时间' },
    }),
  ]
}

export const ANNOTATION_BOX_DECL: ObjectTypeDecl = {
  id: OBJECT_TYPE.annotationBox,
  ownerKind: 'object',
  display: { labelKey: 'objectType.annotation.box', fallback: '包围盒注解' },
  properties: [
    ...annotationCommon(),
    decl({ id: 'min', valueType: 'vec3', animatable: true, defaultSamplingStrategy: 'vector-linear', display: { labelKey: 'annotation.min', fallback: '最小坐标' } }),
    decl({ id: 'max', valueType: 'vec3', animatable: true, defaultSamplingStrategy: 'vector-linear', display: { labelKey: 'annotation.max', fallback: '最大坐标' } }),
    decl({
      id: 'renderStyle',
      valueType: 'enum',
      animatable: true,
      display: { labelKey: 'annotation.renderStyle', fallback: '渲染样式' },
      domain: enumDomain(['wireframe', 'boxFrame', 'translucent', 'hidden']),
    }),
    decl({ id: 'renderOpacity', valueType: 'number', animatable: true, unit: RATIO, display: { labelKey: 'annotation.renderOpacity', fallback: '不透明度', decimals: 2 }, domain: numberRange(0, 1, true, 0.01) }),
    decl({ id: 'fillOpacity', valueType: 'number', animatable: true, unit: RATIO, display: { labelKey: 'annotation.fillOpacity', fallback: '填充不透明度', decimals: 2 }, domain: numberRange(0, 1, true, 0.01) }),
    decl({ id: 'frameThickness', valueType: 'number', animatable: false, unit: RATIO, display: { labelKey: 'annotation.frameThickness', fallback: '边框厚度', decimals: 3 }, domain: numberRange(0.01, 0.2, true, 0.005) }),
    decl({ id: 'overlay', valueType: 'boolean', animatable: false, display: { labelKey: 'annotation.overlay', fallback: '覆盖层' } }),
  ],
}

export const ANNOTATION_POINT_DECL: ObjectTypeDecl = {
  id: OBJECT_TYPE.annotationPoint,
  ownerKind: 'object',
  display: { labelKey: 'objectType.annotation.point', fallback: '标记点注解' },
  properties: [
    ...annotationCommon(),
    decl({ id: 'pos', valueType: 'vec3', animatable: true, defaultSamplingStrategy: 'vector-linear', display: { labelKey: 'annotation.pos', fallback: '位置' } }),
    decl({ id: 'icon', valueType: 'enum', animatable: false, display: { labelKey: 'annotation.icon', fallback: '图标' }, domain: enumDomain(['diamond', 'circle', 'square', 'cross']) }),
    decl({ id: 'size', valueType: 'number', animatable: true, display: { labelKey: 'annotation.size', fallback: '大小', decimals: 2 }, domain: numberRange(0.1, 5, true, 0.1) }),
  ],
}

export const ANNOTATION_LINE_DECL: ObjectTypeDecl = {
  id: OBJECT_TYPE.annotationLine,
  ownerKind: 'object',
  display: { labelKey: 'objectType.annotation.line', fallback: '线段注解' },
  properties: [
    ...annotationCommon(),
    decl({ id: 'thickness', valueType: 'number', animatable: false, display: { labelKey: 'annotation.thickness', fallback: '粗细', decimals: 2 }, domain: numberRange(0.1, 10, true, 0.1) }),
    decl({ id: 'arrow', valueType: 'enum', animatable: false, display: { labelKey: 'annotation.arrow', fallback: '箭头' }, domain: enumDomain(['none', 'start', 'end', 'both']) }),
    decl({ id: 'showPoints', valueType: 'boolean', animatable: false, display: { labelKey: 'annotation.showPoints', fallback: '显示控制点' } }),
  ],
}

export const ANNOTATION_TEXT_DECL: ObjectTypeDecl = {
  id: OBJECT_TYPE.annotationText,
  ownerKind: 'object',
  display: { labelKey: 'objectType.annotation.text', fallback: '文本注解' },
  properties: [
    ...annotationCommon(),
    decl({ id: 'anchorPos', valueType: 'vec3', animatable: true, defaultSamplingStrategy: 'vector-linear', display: { labelKey: 'annotation.anchorPos', fallback: '锚点' } }),
    decl({ id: 'text', valueType: 'string', animatable: false, display: { labelKey: 'annotation.text', fallback: '内容' }, domain: { kind: 'text', multiline: true } }),
    decl({ id: 'fontSize', valueType: 'number', animatable: false, unit: PX, display: { labelKey: 'annotation.fontSize', fallback: '字号', decimals: 0 }, domain: numberRange(8, 72, true, 1) }),
    decl({ id: 'backgroundAlpha', valueType: 'number', animatable: false, display: { labelKey: 'annotation.backgroundAlpha', fallback: '背景透明度', decimals: 0 }, domain: numberRange(0, 255, true, 1) }),
    decl({
      id: 'linkedAnnotationId',
      valueType: 'reference',
      animatable: false,
      referenceType: 'object',
      display: { labelKey: 'annotation.linked', fallback: '关联注解', descriptionFallback: '未解析时显示为缺失引用' },
      domain: { kind: 'reference', ownerKind: 'object' },
    }),
  ],
}

export const ANNOTATION_FACE_DECL: ObjectTypeDecl = {
  id: OBJECT_TYPE.annotationFace,
  ownerKind: 'object',
  display: { labelKey: 'objectType.annotation.face', fallback: '选面注解' },
  properties: [
    ...annotationCommon(),
    decl({ id: 'blockPos', valueType: 'vec3', animatable: false, display: { labelKey: 'annotation.blockPos', fallback: '方块坐标' } }),
    decl({ id: 'quadIndex', valueType: 'number', animatable: false, display: { labelKey: 'annotation.quadIndex', fallback: '面索引', decimals: 0 }, domain: numberRange(0, 63, true, 1) }),
  ],
}

/**
 * **场景元数据**（`lightning.sceneMetadata`）—— 挂在 `document` 拥有者上。
 *
 * `origin` 从「逗号字符串」升级为 `vec3`（旧实现把 `(x, y, z)` 塞进 string 再 split，
 * 且解析失败静默用 0；#251 B7 的 D1.3 #10 明确要求按类型校验的文本或结构化值）。
 * `tags` 用 `string-list` 域（分隔符声明在前，核心不把逗号字符串当类型）。
 */
export const SCENE_METADATA_DECL: ObjectTypeDecl = {
  id: OBJECT_TYPE.sceneMetadata,
  ownerKind: 'document',
  display: { labelKey: 'objectType.sceneMetadata', fallback: '场景元数据' },
  properties: [
    decl({ id: 'name', valueType: 'string', animatable: false, display: { labelKey: 'scene.name', fallback: '场景名称' }, domain: { kind: 'text', multiline: false } }),
    decl({ id: 'author', valueType: 'string', animatable: false, display: { labelKey: 'scene.author', fallback: '作者' }, domain: { kind: 'text', multiline: false } }),
    decl({ id: 'description', valueType: 'string', animatable: false, display: { labelKey: 'scene.description', fallback: '描述' }, domain: { kind: 'text', multiline: true } }),
    decl({ id: 'tags', valueType: 'string-list', animatable: false, display: { labelKey: 'scene.tags', fallback: '标签' }, domain: { kind: 'string-list', separator: ',' } }),
    decl({ id: 'origin', valueType: 'vec3', unit: { kind: 'length', symbolKey: 'unit.block', symbolFallback: '' }, animatable: false, display: { labelKey: 'scene.origin', fallback: '原点' } }),
    decl({ id: 'created_at', valueType: 'string', animatable: false, readOnly: true, readOnlyReason: 'timestamp', display: { labelKey: 'scene.createdAt', fallback: '创建时间' } }),
    decl({ id: 'format_version', valueType: 'string', animatable: false, readOnly: true, readOnlyReason: 'format-version', display: { labelKey: 'scene.formatVersion', fallback: '格式版本' } }),
  ],
}

/**
 * **发布配置**（`lightning.publishConfig`）—— 挂在 `shellSettings` 拥有者上。
 *
 * 旧实现的写入经 `RNAWidget` 的**字符串前缀** `wikiconfig.` 分派到
 * `OPERATOR_SET_WIKI_CONFIG`（#251 B7 的 B.3 第 1 条）。新形态下前缀分派**不存在**：
 * 写入是 `publishConfig.viewWidth` 这个属性 ID 上的注册纯函数。
 */
export const PUBLISH_CONFIG_DECL: ObjectTypeDecl = {
  id: OBJECT_TYPE.publishConfig,
  ownerKind: 'workspace',
  display: { labelKey: 'objectType.publishConfig', fallback: '发布配置' },
  properties: [
    decl({ id: 'viewWidth', valueType: 'number', unit: PX, animatable: false, display: { labelKey: 'publish.viewWidth', fallback: '视口宽度', decimals: 0 }, domain: numberRange(200, 2000, true, 10) }),
    decl({ id: 'viewHeight', valueType: 'number', unit: PX, animatable: false, display: { labelKey: 'publish.viewHeight', fallback: '视口高度', decimals: 0 }, domain: numberRange(150, 1500, true, 10) }),
    decl({ id: 'sceneBackgroundHex', valueType: 'color', animatable: false, display: { labelKey: 'publish.background', fallback: '背景色' }, domain: HEX_PATTERN }),
    decl({ id: 'showStats', valueType: 'boolean', animatable: false, display: { labelKey: 'publish.showStats', fallback: '方块统计栏' } }),
    decl({ id: 'showLayerBar', valueType: 'boolean', animatable: false, display: { labelKey: 'publish.showLayerBar', fallback: '分层预览条' } }),
    decl({ id: 'showFrameControls', valueType: 'boolean', animatable: false, display: { labelKey: 'publish.showFrameControls', fallback: '帧控制' } }),
    decl({ id: 'showTitle', valueType: 'boolean', animatable: false, display: { labelKey: 'publish.showTitle', fallback: '标题栏' } }),
    decl({ id: 'showDebugStatus', valueType: 'boolean', animatable: false, display: { labelKey: 'publish.showDebugStatus', fallback: '调试状态栏' } }),
    decl({ id: 'showAxesGizmo', valueType: 'boolean', animatable: false, display: { labelKey: 'publish.showAxesGizmo', fallback: '坐标轴' } }),
  ],
}

/**
 * **工具会话参数**（`lightning.toolSettings`）。
 *
 * 旧 `toolSettingsRNA` 的 `set` 是**空函数 + 注释**（「经 OPERATOR_SET_TOOL_SETTING」），
 * 写入靠 `RNAWidget` 的 `toolsettings.` 前缀分派。新形态：注册纯函数写 `ToolSettings`，
 * 前缀分派删除。
 */
export const TOOL_SETTINGS_DECL: ObjectTypeDecl = {
  id: OBJECT_TYPE.toolSettings,
  ownerKind: 'editContext',
  display: { labelKey: 'objectType.toolSettings', fallback: '工具设置' },
  properties: [
    decl({ id: 'generateType', valueType: 'string', animatable: false, display: { labelKey: 'tool.generateType', fallback: '生成类型' }, domain: { kind: 'text', multiline: false } }),
    decl({ id: 'replaceBrush', valueType: 'string', animatable: false, display: { labelKey: 'tool.replaceBrush', fallback: '替换画笔' }, domain: { kind: 'text', multiline: false } }),
    decl({ id: 'fillBrush', valueType: 'string', animatable: false, display: { labelKey: 'tool.fillBrush', fallback: '填充画笔' }, domain: { kind: 'text', multiline: false } }),
    decl({ id: 'snapEnabled', valueType: 'boolean', animatable: false, display: { labelKey: 'tool.snap', fallback: '吸附' } }),
    decl({ id: 'dragSensitivity', valueType: 'number', animatable: false, unit: RATIO, display: { labelKey: 'tool.dragSensitivity', fallback: '拖拽灵敏度', decimals: 2 }, domain: numberRange(0.01, 1, true, 0.01) }),
  ],
}

/**
 * **材质查询面**（`lightning.materialView`）—— 全部**只读**（材质库查询结果不是文档写入目标）。
 *
 * 旧 `materialRNA` 的 `set` 全是空函数（静默吞输入）。新形态：声明级只读
 * ⇒ 控件是 `readonly-text`/禁用态，**且写入被结构性拒绝**（`ReadOnly` 带原因），
 * 而不是「能输入但没反应」。
 */
export const MATERIAL_VIEW_DECL: ObjectTypeDecl = {
  id: OBJECT_TYPE.materialView,
  ownerKind: 'asset',
  display: { labelKey: 'objectType.materialView', fallback: '材质（查询）' },
  properties: [
    decl({ id: 'kind', valueType: 'enum', animatable: false, readOnly: true, readOnlyReason: 'query-result', display: { labelKey: 'material.kind', fallback: '类型' }, domain: enumDomain(['static16', 'animated']) }),
    decl({ id: 'blend', valueType: 'enum', animatable: false, readOnly: true, readOnlyReason: 'query-result', display: { labelKey: 'material.blend', fallback: '混合模式' }, domain: enumDomain(['opaque', 'cutout', 'translucent']) }),
    decl({ id: 'emissive', valueType: 'number', animatable: false, readOnly: true, readOnlyReason: 'query-result', display: { labelKey: 'material.emissive', fallback: '自发光', decimals: 0 }, domain: numberRange(0, 15, true, 1) }),
    decl({ id: 'locator', valueType: 'string', animatable: false, readOnly: true, readOnlyReason: 'query-result', display: { labelKey: 'material.locator', fallback: '资源定位符' } }),
  ],
}

/** 本批登记的**全部**对象类型（装配层据此一次性注册）。 */
export const PROPERTY_OBJECT_TYPES: readonly ObjectTypeDecl[] = [
  BLOCK_DECL,
  ANNOTATION_BOX_DECL,
  ANNOTATION_POINT_DECL,
  ANNOTATION_LINE_DECL,
  ANNOTATION_TEXT_DECL,
  ANNOTATION_FACE_DECL,
  SCENE_METADATA_DECL,
  PUBLISH_CONFIG_DECL,
  TOOL_SETTINGS_DECL,
  MATERIAL_VIEW_DECL,
]

// ─────────────────────────────────────────────────────────────────────────────
// 3. Inspector 布局规格（分节；生成式补齐剩余属性）
// ─────────────────────────────────────────────────────────────────────────────

/** 注解的**共用**节（身份/外观）；各注解类型再追加自己的节。 */
function annotationIdentitySections(typeId: string): InspectorLayoutSpec['sections'] {
  return [
    {
      id: `${typeId}.identity`,
      display: { labelKey: 'inspector.section.identity', fallback: '标识' },
      properties: ['id', 'type', 'description'],
    },
    {
      id: `${typeId}.appearance`,
      display: { labelKey: 'inspector.section.appearance', fallback: '外观' },
      properties: ['color', 'visible', 'locked'],
    },
  ]
}

export const PUBLISH_LAYOUT: InspectorLayoutSpec = {
  objectTypeId: OBJECT_TYPE.publishConfig,
  sections: [
    {
      id: 'publish.viewport',
      display: { labelKey: 'inspector.section.viewport', fallback: '视口' },
      properties: ['viewWidth', 'viewHeight', 'sceneBackgroundHex'],
    },
    {
      id: 'publish.features',
      display: { labelKey: 'inspector.section.features', fallback: '界面元素' },
      properties: ['showStats', 'showLayerBar', 'showFrameControls', 'showTitle', 'showDebugStatus', 'showAxesGizmo'],
    },
  ],
}

export const SCENE_METADATA_LAYOUT: InspectorLayoutSpec = {
  objectTypeId: OBJECT_TYPE.sceneMetadata,
  sections: [
    {
      id: 'scene.basic',
      display: { labelKey: 'inspector.section.basic', fallback: '基本信息' },
      properties: ['name', 'author', 'description', 'tags', 'origin'],
    },
    {
      id: 'scene.file',
      display: { labelKey: 'inspector.section.file', fallback: '文件' },
      properties: ['created_at', 'format_version'],
    },
  ],
}

export const BLOCK_LAYOUT: InspectorLayoutSpec = {
  objectTypeId: OBJECT_TYPE.block,
  sections: [
    { id: 'block.identity', display: { labelKey: 'inspector.section.identity', fallback: '标识' }, properties: ['id', 'tooltip', 'cellTooltip'] },
    { id: 'block.transform', display: { labelKey: 'inspector.section.transform', fallback: '位置' }, properties: ['pos'] },
  ],
}

/** 本批登记的**全部**布局规格。 */
export const PROPERTY_INSPECTOR_LAYOUTS: readonly InspectorLayoutSpec[] = [
  BLOCK_LAYOUT,
  SCENE_METADATA_LAYOUT,
  PUBLISH_LAYOUT,
  { objectTypeId: OBJECT_TYPE.annotationBox, sections: [...annotationIdentitySections(OBJECT_TYPE.annotationBox), { id: 'anno.box.geometry', display: { labelKey: 'inspector.section.geometry', fallback: '几何' }, properties: ['min', 'max'] }, { id: 'anno.box.render', display: { labelKey: 'inspector.section.render', fallback: '渲染' }, properties: ['renderStyle', 'renderOpacity', 'fillOpacity', 'frameThickness', 'overlay'] }] },
  { objectTypeId: OBJECT_TYPE.annotationPoint, sections: [...annotationIdentitySections(OBJECT_TYPE.annotationPoint), { id: 'anno.point.geometry', display: { labelKey: 'inspector.section.geometry', fallback: '几何' }, properties: ['pos', 'icon', 'size'] }] },
  { objectTypeId: OBJECT_TYPE.annotationLine, sections: [...annotationIdentitySections(OBJECT_TYPE.annotationLine), { id: 'anno.line.render', display: { labelKey: 'inspector.section.render', fallback: '渲染' }, properties: ['thickness', 'arrow', 'showPoints'] }] },
  { objectTypeId: OBJECT_TYPE.annotationText, sections: [...annotationIdentitySections(OBJECT_TYPE.annotationText), { id: 'anno.text.content', display: { labelKey: 'inspector.section.content', fallback: '内容' }, properties: ['anchorPos', 'text', 'fontSize', 'backgroundAlpha', 'linkedAnnotationId'] }] },
  { objectTypeId: OBJECT_TYPE.annotationFace, sections: [...annotationIdentitySections(OBJECT_TYPE.annotationFace), { id: 'anno.face.geometry', display: { labelKey: 'inspector.section.geometry', fallback: '几何' }, properties: ['blockPos', 'quadIndex'] }] },
  { objectTypeId: OBJECT_TYPE.toolSettings, sections: [{ id: 'tool.all', display: { labelKey: 'inspector.section.tool', fallback: '工具参数' }, properties: ['generateType', 'replaceBrush', 'fillBrush', 'snapEnabled', 'dragSensitivity'] }] },
  { objectTypeId: OBJECT_TYPE.materialView, sections: [{ id: 'material.all', display: { labelKey: 'inspector.section.material', fallback: '材质' }, properties: ['kind', 'blend', 'emissive', 'locator'] }] },
]

/** 造一个注册了本批布局的注册表。 */
export function createWorkbenchInspectorLayouts(): InspectorLayoutRegistry {
  return createInspectorLayoutRegistry(PROPERTY_INSPECTOR_LAYOUTS)
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 面板目标解析（选中集 → 对象类型 + 目标）
// ─────────────────────────────────────────────────────────────────────────────

/** 面板可用的选中事实（由接线层从 `SelectionContext`/文档查得，显式传入）。 */
export type PanelSelection = Readonly<{
  /** 选中实体的种类与 id（方块用 `x,y,z`；注解用注解 id）。 */
  items: readonly Readonly<{ kind: 'block' | 'annotation'; id: string }>[]
  /** 唯一活跃项（方块用 `x,y,z`；注解为 id）。 */
  active: string | null
  /** 注解 id → 注解类型（决定用哪个对象类型声明）。 */
  annotationTypeOf: (id: string) => string | null
}>

/**
 * 面板 → Inspector 目标集（纯）。
 *
 * 规则：
 *  - 选中集非空 ⇒ 全部同类目标（**注解按类型分组**：不同类型的注解不混进同一个对象类型，
 *    否则「多选修改」会跨类型改字段）；
 *  - 选中集为空但活跃项存在 ⇒ 单个目标；
 *  - 都没有 ⇒ `emptyReason = no-selection`（面板显示「未选择」，**不**渲染空输入框）。
 */
export function resolveInspectorTargets(selection: PanelSelection): InspectorTargets {
  if (selection.items.length > 0) {
    const kinds = new Set(selection.items.map((i) => i.kind))
    if (kinds.size > 1) {
      return { objectTypeId: '', targets: [], emptyReason: domainError('UnsupportedOperation', { reason: 'mixed-selection-kinds', kinds: [...kinds].join(',') }) }
    }
    const kind = [...kinds][0]!
    if (kind === 'block') {
      return { objectTypeId: OBJECT_TYPE.block, targets: uniq(selection.items.map((i) => blockOwner(parsePos(i.id)))), emptyReason: null }
    }
    const types = new Set(selection.items.map((i) => selection.annotationTypeOf(i.id) ?? 'box'))
    if (types.size > 1) {
      return {
        objectTypeId: '',
        targets: [],
        emptyReason: domainError('UnsupportedOperation', {
          reason: 'mixed-annotation-types',
          types: [...types].join(','),
        }),
      }
    }
    const type = [...types][0]!
    return {
      objectTypeId: annotationObjectTypeId(type),
      targets: uniq(selection.items.map((i) => annotationOwner(i.id))),
      emptyReason: null,
    }
  }
  if (selection.active !== null) {
    // 活跃项既可能是注解 id 也可能是方块 `x,y,z`：由调用方给出的 `annotationTypeOf` 判定。
    const annoType = selection.annotationTypeOf(selection.active)
    if (annoType) {
      return { objectTypeId: annotationObjectTypeId(annoType), targets: [annotationOwner(selection.active)], emptyReason: null }
    }
    const pos = parsePos(selection.active)
    if (pos) return { objectTypeId: OBJECT_TYPE.block, targets: [blockOwner(pos)], emptyReason: null }
  }
  return { objectTypeId: OBJECT_TYPE.sceneMetadata, targets: [], emptyReason: null }
}

function uniq(refs: readonly EntityRef[]): readonly EntityRef[] {
  const out: EntityRef[] = []
  for (const r of refs) if (!out.some((o) => o.kind === r.kind && o.id === r.id)) out.push(r)
  return out
}

function parsePos(id: string): { x: number; y: number; z: number } {
  const [x, y, z] = id.split(',').map(Number)
  return { x: x ?? 0, y: y ?? 0, z: z ?? 0 }
}

/** 注解类型 → 对象类型 ID（未知类型回落到 box 声明会让字段错配，故显式返回 box 是**有意的**保守选择并留诊断口）。 */
export function annotationObjectTypeId(type: string): string {
  switch (type) {
    case 'box':
      return OBJECT_TYPE.annotationBox
    case 'point':
      return OBJECT_TYPE.annotationPoint
    case 'line':
      return OBJECT_TYPE.annotationLine
    case 'text':
      return OBJECT_TYPE.annotationText
    case 'face':
      return OBJECT_TYPE.annotationFace
    default:
      return OBJECT_TYPE.annotationBox
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. 控件选择（editors 层；RNA 描述里没有控件名）
// ─────────────────────────────────────────────────────────────────────────────

/** 本批的控件映射就是「内置映射」—— 不再有 `RNAWidget` 的第二份 `inferWidget`。 */
export function builtinControlFor(model: ControlModel): ControlModel {
  return model
}

/** 一个描述在本批会被渲染成什么控件（供测试与诊断断言，**与面板实际渲染同源**）。 */
export function controlKindOf(registry: PropertyRegistry, ctx: InspectorContextInputs, propertyId: string) {
  const desc = registry.descriptor(propertyId)
  if (!desc) return null
  return modelFor(desc, ctx.controls)
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Inspector 装配（面板调用一次的纯函数）
// ─────────────────────────────────────────────────────────────────────────────

/** Inspector 的显式输入（读面/可编辑性/草稿由接线层提供）。 */
export type InspectorContextInputs = Readonly<{
  registry: PropertyRegistry
  layouts: InspectorLayoutRegistry
  targets: InspectorTargets
  access: PropertyAccess
  /** 读多选混合值。 */
  readField: (refs: readonly PropertyRef[]) => import('@/application/property-commands').MultiReadResult
  drafts?: Readonly<Record<string, string | null>>
  rejections?: Readonly<Record<string, import('@/application/contracts').DomainError>>
  controls?: ControlRegistry
}>

/** 生成 Inspector 模型（把「选中集」一路接到「渲染模型」）。 */
export function buildWorkbenchInspector(inputs: InspectorContextInputs): InspectorModel {
  const { registry, layouts, targets, access } = inputs
  if (targets.emptyReason !== null || targets.targets.length === 0) {
    const objectTypeId = targets.objectTypeId || OBJECT_TYPE.sceneMetadata
    return {
      objectTypeId,
      targets: [],
      sections: [],
      generated: false,
      missing: [],
    }
  }
  return buildInspectorModel({
    registry,
    layouts,
    objectTypeId: targets.objectTypeId,
    targets: targets.targets,
    readField: (refs) => {
      const multi = inputs.readField(refs)
      return multiToFieldState(multi)
    },
    editField: (ref) => editStateOf(registry, ref, access),
    ...(inputs.drafts ? { drafts: inputs.drafts } : {}),
    ...(inputs.rejections ? { rejections: inputs.rejections } : {}),
    ...(inputs.controls ? { controls: inputs.controls } : {}),
  })
}

/** 多选读结果 → 字段读状态（混合值是显式分支）。 */
export function multiToFieldState(
  multi: import('@/application/property-commands').MultiReadResult,
): import('./property-controls').FieldValueState {
  switch (multi.kind) {
    case 'value':
      return { kind: 'value', value: multi.value }
    case 'mixed':
      return { kind: 'mixed', refs: multi.refs }
    case 'error':
      return { kind: 'error', error: multi.error }
  }
}

/** 可编辑性 → 字段编辑状态（结构化原因原样保留）。 */
export function editStateOf(registry: PropertyRegistry, ref: PropertyRef, access: PropertyAccess): FieldEditState {
  const e: Editability = evaluateEditability(registry, ref, access)
  if (e.editable) return { kind: 'editable' }
  return { kind: 'readOnly', reason: e.reason ?? domainError('ReadOnly', { reason: 'unknown' }) }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. 便利入口（面板接线用；**不是**第二写通路）
//
// 写入的**业务端**（落到文档/壳状态的纯函数）在 `property-writers.ts`：
// 那里是唯一需要认识运行时文档形态的地方（迁移期桥接，P1 的 `ApplicationState` 合流后
// 由其取代）。本文件只保留与契约同寿的部分 —— 声明、布局、以及唯一写路由的入口。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 提交一次 SetProperty（面板/脚本/命令搜索共用同一个入口）。
 *
 * 这是「唯一写路由」的**入口函数**：所有调用方（控件、脚本、命令搜索）都到这里，
 * 再进 `applySetProperty`（`application/property-commands`）。
 * `state` 对写入状态类型**泛型** —— P1 的 `ApplicationState` 合流时无需改本函数。
 */
export function submitSetProperty<S>(args: {
  registry: PropertyRegistry
  ports: PropertyWritePorts<S>
  state: Readonly<S>
  refs: readonly PropertyRef[]
  value: PropertyValue
  access: PropertyAccess
  baseVersion: Version
  commandId?: string
  command?: SetPropertyCommand
}) {
  const command: SetPropertyCommand =
    args.command ?? {
      kind: 'setProperty',
      refs: args.refs,
      value: args.value,
      ...(args.commandId ? { commandId: args.commandId } : {}),
    }
  return applySetProperty<S>({
    registry: args.registry,
    ports: args.ports,
    state: args.state,
    command,
    env: { baseVersion: args.baseVersion, currentVersion: args.access.version },
    access: args.access,
  })
}

/** 目标事实构造的便利函数（接线层查得事实后传入；**缺省即不可写**）。 */
export function factsOf(input: Partial<TargetFacts> & { exists?: boolean }): TargetFacts {
  return {
    exists: input.exists ?? false,
    generated: input.generated ?? false,
    drivenByTrack: input.drivenByTrack ?? false,
    locked: input.locked ?? false,
    holdsLease: input.holdsLease ?? true,
    ...(input.topologyVersion !== undefined ? { topologyVersion: input.topologyVersion } : {}),
    ...(input.contentVersion !== undefined ? { contentVersion: input.contentVersion } : {}),
  }
}

/** 一个「可写且已持有租约」的访问面（面板与测试共用；能力由调用方给）。 */
export function accessOf(args: {
  version: Version
  readRaw: (ref: PropertyRef) => Result<unknown>
  facts: (ref: PropertyRef) => TargetFacts
  capabilities?: ReadonlySet<CapabilityId>
  language?: 'zh' | 'en'
}): PropertyAccess {
  return {
    version: args.version,
    readRaw: args.readRaw,
    facts: args.facts,
    capabilities: args.capabilities ?? new Set<CapabilityId>([CAP_PROPERTY_WRITE]),
    language: args.language ?? 'zh',
  }
}

/** 写面拒绝时的**结构化**摘要（诊断/呈现共用；不含已翻译字符串）。 */
export function rejectionSummary(error: DomainError): string {
  const reason = error.params.reason
  return reason === undefined ? error.code : `${error.code}:${String(reason)}`
}

/**
 * 供 UI 显示「为什么不能改」的**声明级**诊断项（#249 §19.9：属性只读原因属诊断面）。
 *
 * 这里用占位 owner（不是真实目标）：目的是列出「按声明与能力就没有写面」的属性。
 * 需要「某具体目标此刻为何不可写」时应带真实 `EntityRef` 调 `evaluateEditability`。
 */
export function readOnlyDiagnostics(
  registry: PropertyRegistry,
  access: PropertyAccess,
): readonly { property: string; reason: string }[] {
  const out: { property: string; reason: string }[] = []
  for (const kind of [...new Set(registry.objectTypes().map((o) => o.ownerKind))]) {
    for (const desc of registry.describeOwnerKind(kind)) {
      const ref: PropertyRef = { owner: { kind: desc.objectTypeId, id: desc.objectTypeId }, property: desc.id }
      const e = evaluateEditability(registry, ref, access)
      if (!e.editable) {
        out.push({ property: desc.id, reason: rejectionSummary(e.reason ?? domainError('ReadOnly', {})) })
      }
    }
  }
  return out
}
