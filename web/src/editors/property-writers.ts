/**
 * #253 P2 · **受控属性写的纯业务端** —— RNA 唯一写路由的业务实现。
 *
 * 本文件是 `editors/workbench-inspector.ts` 的**接线分离件**：声明与布局留在
 * `workbench-inspector.ts`（它们只依赖 RNA 契约），而**真正改文档/壳状态的纯函数**放在
 * 这里 —— 因为它们必须认识**当前运行时文档形态**（`context/runtimeDocument`）。
 *
 * ## 为什么这个分离是必要的（而不是文件太大了）
 *
 * #249 §4 导入规则 1 要求 `application` 不依赖旧实现；`editors` 是接线层，
 * 允许认识适配器/运行时形态，但**不应把「认识运行时文档」这件事混进声明与布局**：
 * 声明与布局是纯数据 + 纯函数（可被 P6/P7 直接复用与裁剪），
 * 而写入函数是**迁移期桥接**（P1 的 `ApplicationState` 合流后由其取代，见下）。
 *
 * 换句话说：`editors/workbench-inspector.ts` 定义「什么属性、怎么排」，
 * `editors/property-writers.ts` 定义「写下去落到哪里」。前者长期有效，
 * 后者的底座（`RuntimeDocument`）是 P9 要替换的对象（退役 #2），
 * 因此把替换点收敛到一个文件里，比散在声明文件里可审计得多。
 *
 * ## `DocumentState` 与 P1 的关系（**已登记的集成点**）
 *
 * `DocumentState` 是 P2 在 P1 尚未交付时使用的最小投影：
 * `{ version, document: RuntimeDocument, shell }`。P1 的 `ApplicationState` 落地后，
 * 装配层把 `DocumentState` 换成它（或让它成为其字段），**写入函数签名不变**
 * （`PropertyWriteHandler<S>` 对 `S` 泛型），因此无需改本文件以外的任何东西。
 *
 * ## 不改输入
 *
 * 每个写入函数都返回新状态；`RuntimeDocument` 一律先 `clone()`。
 * 壳设置走浅拷贝（它不是文档内容，且不进文档历史 —— 契约 §6.4）。
 */

import {
  type DomainError,
  type PropertyRef,
  type Result,
  type Version,
  domainError,
  err,
  ok,
} from '@/application/contracts'
import {
  type PropertyDescriptor,
  type PropertyValue,
} from '@/application/properties'
import {
  type PropertyWriteEnv,
  type PropertyWritePorts,
  createPropertyWritePorts,
} from '@/application/property-commands'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import { OBJECT_TYPE } from './workbench-inspector'

/** 文档状态（本批用到的最小投影；P1 的 `ApplicationState` 合流时由其取代）。 */
export type DocumentState = Readonly<{
  /** 文档内容版本（写面据此判脏与并发）。 */
  version: Version
  /** 文档对象（P1 落地后由类型化文档取代；本批用运行时文档的 clone 语义）。 */
  document: RuntimeDocument
  /** 非文档的壳设置（发布配置、工具参数）—— 与文档分开，**不进文档历史**。 */
  shell: Readonly<Record<string, unknown>>
}>

/**
 * 属性 ID → 对象类型内的**局部** ID（实现唯一在 `application/contracts`）。
 *
 * 这里 `import` 而非 `export { … } from`：写入函数体里要用它，
 * 而 re-export **不**在当前模块建立本地绑定（`TS2304: Cannot find name`）。
 *
 * 必须传 `objectTypeId`：属性 ID 形如 `lightning.block.pos`，而对象类型 ID **自带点**，
 * 「取第一个点之后」会得到 `block.pos`（错，正确是 `pos`）。
 */
import { localPropertyOf } from '@/application/contracts'

export { localPropertyOf }

/** 拥有者 ID（`x,y,z`）→ 位置。 */
export function parsePos(id: string): { x: number; y: number; z: number } {
  const [x, y, z] = id.split(',').map(Number)
  return { x: x ?? 0, y: y ?? 0, z: z ?? 0 }
}

/**
 * `minecraft:<name>[:<meta>]` → `{ name, meta }`。
 *
 * 与 `context/queries.ts:164` 的构造式**互逆**：那里是
 * `` `minecraft:${block.name}:${block.meta}` ``，故这里是它的解析端。
 * 前缀缺省时按 `minecraft` 处理；非法（空名 / meta 非整数）返回 `null` 让上层拒绝 ——
 * **不静默兜底成 0**（旧实现 `sceneMeta.origin` 的 split + `?? 0` 正是这种静默，
 * #251 B7 的 D1.3 #10 要求按类型校验）。
 */
export function parseBlockStateId(id: string): { name: string; meta: number } | null {
  if (id.length === 0) return null
  const parts = id.split(':')
  let name: string
  let metaPart: string | undefined
  if (parts.length === 1) {
    name = parts[0]!
  } else if (parts.length === 2) {
    name = parts[1]!
  } else {
    // `namespace:path:meta` —— 第三段起是 meta（本项目格式中路径本身不含 `:`）。
    name = parts[1]!
    metaPart = parts[2]!
  }
  if (name.length === 0) return null
  if (metaPart === undefined) return { name, meta: 0 }
  const meta = Number(metaPart)
  if (!Number.isInteger(meta) || meta < 0) return null
  return { name, meta }
}

function withDocument(state: DocumentState, document: RuntimeDocument): DocumentState {
  return {
    version: { ...state.version, documentVersion: state.version.documentVersion + 1 },
    document,
    shell: state.shell,
  }
}

/**
 * 方块属性写入（**纯**）：返回新的 `DocumentState`。
 *
 * - `id` ⇒ 改该格的方块类型（写进 `SlotBlock.name`/`meta`，与查询面同一口径）；
 * - `tooltip`/`cellTooltip` ⇒ 成对写 `tooltipPalette` + `cellTooltipGrid`
 *   （沿用 `OPERATOR_TOOLTIP_EDIT` 的成对语义 —— 避免 #80 那种「悬空下标」）；
 * - `pos` 只读 ⇒ 到不了这里（可编辑性已拒，见 `BLOCK_DECL` 的 `readOnly`）。
 *
 * **不改输入**：全程 `doc.clone()`。
 */
export function writeBlockProperty(
  state: DocumentState,
  ref: PropertyRef,
  value: PropertyValue,
  _context: Readonly<{ descriptor: PropertyDescriptor; env: PropertyWriteEnv }>,
): Result<DocumentState> {
  const frameIndex = 0
  const frame = state.document.frame(frameIndex)
  if (!frame?.grid) {
    return err(domainError('MissingTarget', { reason: 'no-frame', objectId: ref.owner.id }))
  }
  const pos = parsePos(ref.owner.id)
  const block = frame.grid.at(pos)
  if (!block) {
    return err(domainError('MissingTarget', { reason: 'block-absent', objectId: ref.owner.id }))
  }
  const doc = state.document.clone()

  switch (localPropertyOf(ref.property, _context.descriptor.objectTypeId)) {
    // ───────────────────────────────────────────────────────────────────────
    // 退役（R1-β① C3）：`id`（方块身份）的旧写点**已删除**
    // ───────────────────────────────────────────────────────────────────────
    //
    // 这里原先是 `doc.frame(0)!.grid!.setBlock(pos, { ...block, name, meta })`
    // —— 把面板给的名字直接写进 `SlotBlock.name`。该字段按 `pure/gridTypes.ts:18`
    // 是**已截去 `minecraft:` 前缀**的注册名，而显示侧 `context/queries.ts:164`
    // 再按 `` `minecraft:${name}` `` 拼回 ⇒ 非 `minecraft` 命名空间在"读出→写回"
    // 一个来回后被改写（GF-7 投影侧实测 68 条调色板里 **66 条**被改写）。
    //
    // 身份写现在走内核命令 `setCellIdentity`（取值是「`cells` 值 + `cellPalette`
    // 内容键」的**二元组**，没有从名字反拼命名空间的环节），拦截点在
    // `editors/workbench-rna` 的 `submitPropertyWrite` —— 那里持有 `Context`，
    // 因而能发命令；本函数是**纯**转移、拿不到 `ctx`，故**不**在此实现身份写。
    //
    // ⚠️ 到达这里说明是**混合属性批次**（同一次提交里既改身份又改别的）：
    // 拦截条件要求"全部 ref 都是 `id`"才拦截，混合批次整批落到这里。
    // 此时**如实拒绝**，**不**回落旧写（那会让内核与 legacy 就同一格给出两个身份，
    // 正是本批要消除的双轨）。
    case 'id': {
      return err(
        domainError('UnsupportedOperation', {
          reason: 'kernel-routed-block-identity',
          property: ref.property,
          objectId: ref.owner.id,
        }),
      )
    }
    case 'tooltip':
    case 'cellTooltip': {
      const mutable = doc as unknown as { tooltipPalette?: string[]; cellTooltipGrid?: number[][][] }
      const palette = (mutable.tooltipPalette ??= [])
      const grid = (mutable.cellTooltipGrid ??= [])
      const text = String(value)
      let at = text ? palette.indexOf(text) : -1
      if (at === -1 && text) {
        at = palette.length
        palette.push(text)
      }
      if (!grid[pos.z]) grid[pos.z] = []
      if (!grid[pos.z][pos.y]) grid[pos.z][pos.y] = []
      grid[pos.z][pos.y][pos.x] = text ? at : -1
      return ok(withDocument(state, doc))
    }
    default:
      return err(
        domainError('UnsupportedOperation', { reason: 'no-write-path', property: ref.property, objectId: ref.owner.id }),
      )
  }
}

/** 注解属性写入（纯）：改 clone 出来的注解记录。支持 `component` 分量写（其余分量保持）。 */
export function writeAnnotationProperty(
  state: DocumentState,
  ref: PropertyRef,
  value: PropertyValue,
  _context: Readonly<{ descriptor: PropertyDescriptor; env: PropertyWriteEnv }>,
): Result<DocumentState> {
  const doc = state.document.clone()
  const list = doc.annotations as unknown as { id?: string }[]
  const at = list.findIndex((a) => a.id === ref.owner.id)
  if (at === -1) return err(domainError('MissingTarget', { reason: 'annotation-absent', objectId: ref.owner.id }))
  const local = localPropertyOf(ref.property, _context.descriptor.objectTypeId)
  const next: Record<string, unknown> = { ...(list[at] as unknown as Record<string, unknown>) }
  if (ref.component !== undefined) {
    const name = ['x', 'y', 'z', 'w'][ref.component]
    if (!name) return err(domainError('InvalidValue', { reason: 'component-out-of-range', component: ref.component }))
    const cur = next[local]
    if (typeof cur !== 'object' || cur === null) {
      return err(domainError('InvalidValue', { reason: 'component-on-non-vector', property: ref.property }))
    }
    if (typeof value !== 'number') {
      return err(domainError('InvalidValue', { reason: 'component-requires-number', property: ref.property }))
    }
    next[local] = { ...(cur as Record<string, number>), [name]: value }
  } else {
    next[local] = value
  }
  next.updated_at = state.version.documentVersion
  list[at] = next as { id?: string }
  return ok(withDocument(state, doc))
}

/** 场景元数据写入（纯）：改 `doc.meta` 的 clone。 */
export function writeSceneMetadataProperty(
  state: DocumentState,
  ref: PropertyRef,
  value: PropertyValue,
  _context: Readonly<{ descriptor: PropertyDescriptor; env: PropertyWriteEnv }>,
): Result<DocumentState> {
  const doc = state.document.clone()
  const local = localPropertyOf(ref.property, _context.descriptor.objectTypeId)
  const meta = doc.meta as Record<string, unknown>
  switch (local) {
    case 'name':
    case 'author':
    case 'description':
      meta[local] = String(value)
      break
    case 'tags':
      if (!Array.isArray(value)) {
        return err(domainError('InvalidValue', { reason: 'tags-require-list', property: ref.property }))
      }
      meta.tags = [...value]
      break
    case 'origin':
      if (typeof value !== 'object' || value === null) {
        return err(domainError('InvalidValue', { reason: 'origin-requires-vector', property: ref.property }))
      }
      meta.origin = { ...(value as Record<string, number>) }
      break
    default:
      return err(domainError('UnsupportedOperation', { reason: 'no-write-path', property: ref.property }))
  }
  return ok(withDocument(state, doc))
}

/**
 * 壳设置写入（发布配置 / 工具参数）：**不进文档历史**（契约 §6.4：布局与个人偏好单独保存）。
 *
 * 仍走同一写路由与同一份校验 ——「不同保存政策」不等于「不同写入通路」
 * （契约 §5.2：不存在第二条属性写通路）。
 */
export function writeShellProperty(
  state: DocumentState,
  ref: PropertyRef,
  value: PropertyValue,
  context: Readonly<{ descriptor: PropertyDescriptor; env: PropertyWriteEnv }>,
): Result<DocumentState> {
  // `context` **不是可选**的：局部属性名必须靠 `descriptor.objectTypeId` 剥离前缀，
  // 缺了就只剩「按最后一个点切」的猜测。把可选参数写成必填，让「忘了传」在类型上失败，
  // 而不是让属性名静默解错（`lightning.publishConfig.viewWidth` → `publishConfig.viewWidth`）。
  const local = localPropertyOf(ref.property, context.descriptor.objectTypeId)
  const shell = { ...state.shell }
  const current = (shell[ref.owner.kind] ?? {}) as Record<string, unknown>
  shell[ref.owner.kind] = { ...current, [local]: value }
  // 壳设置变化**不**推进文档内容版本（它不是文档内容）。
  return ok({ version: state.version, document: state.document, shell })
}

/** 造一个注册了本批纯函数的写入端口表。 */
export function createWorkbenchWritePorts(): PropertyWritePorts<DocumentState> {
  const ports = createPropertyWritePorts<DocumentState>()
  ports.write(OBJECT_TYPE.block, writeBlockProperty)
  ports.write(OBJECT_TYPE.annotationBox, writeAnnotationProperty)
  ports.write(OBJECT_TYPE.annotationPoint, writeAnnotationProperty)
  ports.write(OBJECT_TYPE.annotationLine, writeAnnotationProperty)
  ports.write(OBJECT_TYPE.annotationText, writeAnnotationProperty)
  ports.write(OBJECT_TYPE.annotationFace, writeAnnotationProperty)
  ports.write(OBJECT_TYPE.sceneMetadata, writeSceneMetadataProperty)
  ports.write(OBJECT_TYPE.publishConfig, writeShellProperty)
  ports.write(OBJECT_TYPE.toolSettings, writeShellProperty)
  // 材质查询面**没有**写入端口：它是只读查询，写入被可编辑性拒绝（声明级 readonly）。
  return ports
}

/** 未装配写入端口的对象类型清单（诊断：启动期即可发现「声明了可写但没人接」）。 */
export function unhandledWritableObjectTypes(ports: PropertyWritePorts<DocumentState>): readonly string[] {
  const handled = new Set(ports.objectTypeIds())
  return Object.values(OBJECT_TYPE).filter((id) => !handled.has(id) && id !== OBJECT_TYPE.materialView)
}

/** 写面失败原因 → 稳定诊断键（与 `application/properties` 的口径一致，避免两处各写一份）。 */
export function writeErrorKey(error: DomainError): string {
  const reason = error.params.reason
  return reason === undefined ? error.code : `${error.code}:${String(reason)}`
}
