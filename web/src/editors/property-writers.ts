/**
 * **受控属性写的纯业务端** —— RNA 唯一写路由的**壳设置**实现。
 *
 * ## 本文件的"文档内容写"半边**已退役**
 *
 * 本文件曾同时承载面板的**文档内容**写（方块身份/逐格说明/注解字段/场景元数据）与
 * **壳设置**写。前者在 `DocumentState.document: RuntimeDocument` 上原地 clone + 写，
 * 曾是 `composition/seams.ts` 的 `property-write-legacy-document-model` 登记的那条双轨，
 * 也是 `Context#legacyDocumentModel()` 的最后一个生产消费者。
 *
 * ⚠️ **那条登记已核销**：写模型取值口
 * `legacyDocumentModel()` 与 `DocumentState.document` 均已删除，`seams.ts` 不再含该 id，
 * `tests/architecture/boundary-scan.test.ts` 把守"不得复活"。
 *
 * 文档内容写**全部改走内核命令**（接线在 `editors/workbench-rna#submitPropertyWrite`）：
 *
 * | 面板属性 | 内核命令 | 领域语义 |
 * |---|---|---|
 * | 方块身份 `id` | `setCellIdentity` | 「`cells` 值 + `cellPalette` 内容键」二元组，**不**反拼命名空间（命名空间防线） |
 * | 逐格说明 `tooltip`/`cellTooltip` | `setCellTooltip` | 成对写（避免悬空下标），空串 ⇒ `null`（删除） |
 * | 注解字段（`title`/`description`/`color`/`locked`/`min`/`max`/`pos`/`renderStyle`/`text`/`visible`/…） | `setProperty` | 目标解析 + 值域校验都在内核注册表（`application/kernel-properties`） |
 * | 场景元数据（`name`/`author`/`description`/`tags`/`origin`） | `setDocumentMeta` | 只接受**具名**字段（未知键走保真记录） |
 *
 * ⇒ 本文件**只剩**壳设置（发布配置、工具参数）：它们**不是**文档内容、不进文档历史
 * 故仍是纯转移。这条保留**不是**"第二条属性写通路"——
 * 落点（`state.shell`）、校验（同一个 RNA 注册表）、入口（同一个 `submitPropertyWrite`）
 * 都与其他面共用，只是**保存政策**不同（不同保存政策 ≠ 不同写入通路）。
 *
 * ## 不改输入
 *
 * 壳设置走浅拷贝（它不是文档内容，且不进文档历史）。
 */

import {
  type DomainError,
  type PropertyRef,
  type Result,
  type Version,
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
import { OBJECT_TYPE } from './workbench-inspector'

/** 文档状态（**只剩壳设置** —— 文档内容写已全部改走内核命令）。 */
export type DocumentState = Readonly<{
  /** 文档内容版本（写面据此判脏与并发）。 */
  version: Version
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

/**
 * `minecraft:<name>[:<meta>]` → `{ name, meta }`。
 *
 * 与 `context/queries.ts:164` 的构造式**互逆**：那里是
 * `` `minecraft:${block.name}:${block.meta}` ``，故这里是它的解析端。
 * 前缀缺省时按 `minecraft` 处理；非法（空名 / meta 非整数）返回 `null` 让上层拒绝 ——
 * **不静默兜底成 0**（旧实现 `sceneMeta.origin` 的 split + `?? 0` 正是这种静默，
 * 判据要求按类型校验）。
 *
 * ⚠️ 本函数只做"**显示形态 → `(name, meta)`**"的解析，
 * **不得**用它反拼 `cellPalette` 的内容键 —— `SlotBlock.name` 是**已截去
 * `minecraft:` 前缀**的注册名（`pure/gridTypes.ts:18`），真命名空间的权威在
 * 文档调色板（`composition/kernelProjection.ts:511` 的精确三元组命中）。
 * 按 `` `minecraft:${name}` `` 反拼会把 `ae2:` 之类改写成 `minecraft:`
 * —— 命名空间被改写的写侧成因。身份写因此走 `Context#kernelCellIdentityRef` 读真实内容键。
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

/**
 * 壳设置写入（发布配置 / 工具参数）：**不进文档历史**（布局与个人偏好单独保存）。
 *
 * 仍走同一写路由与同一份校验 ——「不同保存政策」不等于「不同写入通路」
 * （不存在第二条属性写通路）。
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
  return ok({ version: state.version, shell })
}

/** 造一个注册了本模块纯函数的写入端口表（**只剩壳设置**；文档内容写在内核命令里）。 */
export function createWorkbenchWritePorts(): PropertyWritePorts<DocumentState> {
  const ports = createPropertyWritePorts<DocumentState>()
  ports.write(OBJECT_TYPE.publishConfig, writeShellProperty)
  ports.write(OBJECT_TYPE.toolSettings, writeShellProperty)
    // ⚠️ 文档内容的写端口**已删除**：方块身份/逐格说明/注解字段/场景元数据
  // 全部改走内核命令（接线在 `editors/workbench-rna#submitPropertyWrite`）。
  // 若将来有人在这里**新增**文档内容的写端口，那就是复活本节文件头点名的那条双轨。
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
