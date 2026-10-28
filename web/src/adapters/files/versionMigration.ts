/**
 * `adapters/files/versionMigration` —— **旧格式版本迁移**。
 *
 * ## 本模块替代的旧机制
 *
 * 旧 `render/data/versionMigration.ts`（28 行）做两件事：`detectVersion`（看
 * `format_version` 前缀）与 `migrateV1ToV2`（把 v1 字段拼进 v2 形状）。
 * 它的**文件头注释**是唯一记录迁移口径的地方：
 *
 * > `// V2 = V1 原样继承 + 注解 + 标签。V1 字段名/类型全保留，迁移零转换。`
 *
 * 「零转换」这四个字是既有事实，但它**没有可执行形式**：
 * 没有人能断言"这次迁移确实没有转换字段"。本模块把它变成一条**可测**的性质：
 *
 * - {@link migrateV1ToV2} 的返回里，**除** `format_version` / `meta` / `annotations` /
 *   `labels` 四个 **v2 新增**键之外，其余每个键与输入**逐位相同**（`===`）；
 * - 该性质由 {@link migratedKeysAreUntouched} 直接检查，并被测试逐键断言。
 *
 * 判据值得这样写，因为"零转换"的**反面**（静默改名/改类型）恰恰是最难发现的失真：
 * 迁移后文档看起来完全正常，只有某个下游消费方在几天后拿到 `undefined`。
 *
 * ## 与旧实现的一处**有意**差异（必须说明，不得静默）
 *
 * 旧 `migrateV1ToV2` 用 `{ format_version: '2.0', ...v1, meta: {...} }` 的展开顺序
 * 构造结果：**v1 的字段能覆盖 `format_version`** —— 若输入带 `format_version: '1.9'`，
 * 输出会是 `'1.9'`（因为展开在后），于是"迁移到 v2"产出一份声明自己是 1.9 的文档。
 * 本模块把 `format_version` 放在**展开之后**，保证迁移结果恒声明 `'2.0'`。
 * 这不是"顺手修的 bug"，而是"迁移的**后置条件**"：`migrateV1ToV2` 的输出必须能被
 * `classifyShape` 判成 `v2plain`，否则调用方会拿着它去走 v1 解析路径。
 */

import { invalidValue, type Result, ok, err } from '@/domain/errors'

/** V2 文档声明的版本串。 */
export const V2_FORMAT_VERSION = '2.0'

/**
 * v2 **新增**的顶层键（迁移时唯一允许不同的四个）。
 *
 * 常量化让"零转换"的判据只有一处定义：迁移实现与它的断言引用同一份清单，
 * 不会出现"实现改了清单没改"。
 */
export const V2_ADDED_ROOT_KEYS: readonly string[] = Object.freeze(['format_version', 'meta', 'annotations', 'labels'])

/** 版本判别（`format_version` 以 `2.` 开头即 v2，否则 v1）。 */
export function detectVersion(doc: unknown): '1' | '2' {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return '1'
  const v = (doc as Record<string, unknown>).format_version
  return typeof v === 'string' && v.startsWith('2.') ? '2' : '1'
}

/**
 * v1 → v2 迁移（**零转换**，既有事实）。
 *
 * 迁移动作只有四条，且都对应 v2 新增字段：
 *  1. `format_version = '2.0'`；
 *  2. `meta = { name, author, created_at_ms: 0, description, tags: [], origin: {0,0,0} }`
 *     —— **来源**逐项取自 v1 的 `label`/`id`、`author`、`description`（旧
 *     `versionMigration.ts:18-23` 的映射，逐字保留）；
 *  3. `annotations` 缺省补齐为 `[]`（v2 新增容器）；
 *  4. `labels` 缺省补齐为 `[]`。
 *
 * `created_at_ms: 0` 是**有意**的常量而非"读当前时间"：纯函数纪律禁止读时钟，
 * 而 v1 文件里没有这个字段的任何来源 —— 用墙钟填一个"迁移时刻"会造出一个
 * **不可复现**的字段（同一份 v1 文件两次迁移得到不同 v2 文件）。
 */
export function migrateV1ToV2(v1: unknown): Result<Record<string, unknown>> {
  if (v1 === null || typeof v1 !== 'object' || Array.isArray(v1)) {
    return err(invalidValue({ reason: 'migrationSourceNotObject' }))
  }
  const src = v1 as Record<string, unknown>
  if (detectVersion(src) === '2') {
    // 已经是 v2：**不**重复迁移（迁移是幂等的：第二次调用应得到语义相同的文档）。
    // 但仍返回一份新的冻结副本，使"调用方不会改到入参"成立。
    return ok(Object.freeze({ ...src }))
  }

  const meta = Object.freeze({
    name: String(src.label ?? src.id ?? ''),
    author: String(src.author ?? ''),
    created_at_ms: 0,
    description: String(src.description ?? ''),
    tags: Object.freeze([]) as readonly string[],
    origin: Object.freeze({ x: 0, y: 0, z: 0 }),
  })

  const out: Record<string, unknown> = { ...src }
  out.meta = meta
  if (!Array.isArray(out.annotations)) out.annotations = Object.freeze([])
  if (!Array.isArray(out.labels)) out.labels = Object.freeze([])
  // **放在最后**：见文件头「有意差异」—— 迁移的后置条件是"结果声明自己是 v2"。
  out.format_version = V2_FORMAT_VERSION
  return ok(Object.freeze(out))
}

/**
 * 「零转换」的可执行判据：除 `V2_ADDED_ROOT_KEYS` 外，每个键与输入**逐位相同**。
 *
 * 用 `Object.is` 而不是 `===`：`Object.is` 区分 `+0`/`-0` 与 `NaN`。对"零转换"这个
 * 判据来说，`-0` 变成 `+0` **是**一次改动（浮点比较的下游可能看出来），
 * `NaN` 变 `NaN` **不是**。`===` 对这两件相反的事给出同一个答案，故不用它。
 *
 * 返回**不同的键名**（不是布尔）—— 失败时要能直接指出是哪个字段被动了，
 * 一个 `false` 只会让人从头查一遍。
 */
export function migratedKeysAreUntouched(v1: unknown, v2: unknown): readonly string[] {
  if (v1 === null || typeof v1 !== 'object' || v2 === null || typeof v2 !== 'object') {
    return Object.freeze(['<notObject>'])
  }
  const a = v1 as Record<string, unknown>
  const b = v2 as Record<string, unknown>
  const skip = new Set(V2_ADDED_ROOT_KEYS)
  const changed: string[] = []
  for (const key of Object.keys(a)) {
    if (skip.has(key)) continue
    if (!Object.prototype.hasOwnProperty.call(b, key)) {
      changed.push(`${key}:missing`)
      continue
    }
    if (!Object.is(a[key], b[key])) changed.push(key)
  }
  return Object.freeze(changed.sort())
}

/**
 * 迁移的**后置条件**：结果必须被判成 v2plain。
 *
 * 这条把"迁移产出的文档能被后续判别接走"变成断言。缺它的话，一个
 * "忘了写 `format_version`"的迁移实现会产出文档，而下游 `classifyShape`
 * 把这份带 `frames` 的文档判成 `world` —— 于是注解与标签被静默忽略。
 */
export function migratedDocIsV2(v2: unknown): boolean {
  if (v2 === null || typeof v2 !== 'object' || Array.isArray(v2)) return false
  const o = v2 as Record<string, unknown>
  return o.format_version === V2_FORMAT_VERSION
}
