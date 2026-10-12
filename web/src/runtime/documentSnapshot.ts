/**
 * `runtime/documentSnapshot` —— **文档快照令牌**（#301 P10f D3；R-WK-09 裁决 3 的"受控双轨"）。
 *
 * ## 它替代的旧机制
 *
 * | 旧机制 | 位置 | 本模块的替代 |
 * |---|---|---|
 * | `ctx.getDoc().value?.clone() ?? null` —— 撤销路径直取旧文档的可写句柄 | `operators/operatorRegistry.ts`（6 处）、`operators/modalOperatorWrapper.ts`（1）、`operators/pushDocUndo.ts` | 不透明令牌：**不返回 `Ref`、不返回 `RuntimeDocument`**，撤销/重做只把令牌交回 `Context#restoreDocumentSnapshot` |
 *
 * ## 为什么"收成具名读面"还不够，必须是**不透明**令牌
 *
 * R-WK-09 裁决 3 的原文是「`getDoc().value?.clone()` 在撤销路径**存续**
 * （`before=null` 表达"撤销到无文档"，内核 `pushHistory` 只记同文档内 scene
 * 前后态、结构性表达不了）；登记 seams 双轨」。
 *
 * 裁决要的是**能力存续**（撤销能回到"无文档"，这是内核历史表达不了的），
 * 而**不是**"再给一个拿得到 `RuntimeDocument` 的入口"。若新面返回
 * `RuntimeDocument | null`，那就只是把 `getDoc()` 改了个名
 * —— 而 #171 明文禁止"新门面包旧核心保活"。
 *
 * ⇒ 令牌是**不透明**的：
 *  - 类型上没有任何可读字段（品牌符号只用于类型区分，运行期不存在）；
 *  - 文档本体存在**模块私有** `WeakMap` 里，键是令牌对象；
 *  - 取回只有一条路：`Context#restoreDocumentSnapshot(token)`（经**同一个**
 *    唯一写者 `setDocument`）。
 *
 * ## 为什么用 `WeakMap` 而不是类私有字段
 *
 * 两者在**静态**闸门下等价（都无可读属性名），但 `WeakMap` 还保证：
 * 令牌被丢弃后文档可回收（撤销栈有上限，旧令牌必然被淘汰）。
 *
 * ## `null` 的语义
 *
 * 本模块**不**把 `null` 编码成"空令牌"：`null` 令牌直接就是
 * **"当时没有文档"**（R-WK-09 的 `before=null`）。让"无文档"在类型上
 * 与"有文档"同形，是撤销回到错误状态的那类缺陷的温床。
 */

import type { RuntimeDocument } from '@/context/runtimeDocument'

declare const documentSnapshotBrand: unique symbol

/**
 * **不透明快照令牌**。
 *
 * ⚠️ 品牌字段是 `unique symbol` 键且 `declare` 出来 ⇒ **运行期不存在**，
 * 故 `Object.keys(token)` 恒为空 —— 令牌确实不携带可读载荷。
 */
export interface DocumentSnapshot {
  readonly [documentSnapshotBrand]: 'runtime/documentSnapshot'
}

/** 令牌 → 文档本体（模块私有；**唯一**取值口是 {@link documentOfSnapshot}）。 */
const SNAPSHOTS = new WeakMap<DocumentSnapshot, RuntimeDocument>()

/**
 * 捕获当前文档的快照令牌。
 *
 * @param doc 当前旧文档；`null` ⇒ 返回 `null`（= "当时没有文档"，见文件头）。
 */
export function snapshotOf(doc: RuntimeDocument | null): DocumentSnapshot | null {
  if (doc === null) return null
  const token = Object.freeze({}) as unknown as DocumentSnapshot
  // 与 `RuntimeDocument#clone()` 同语义：令牌持的是**当时**的副本，
  // 之后对原文档的原地修改不影响它（撤销必须回到"那一刻"）。
  SNAPSHOTS.set(token, doc.clone())
  return token
}

/**
 * 取回令牌承载的文档。
 *
 * ⚠️ **只应由 `runtime/context.ts` 调用**（它是唯一有权把旧文档交回写者的地方）。
 * 导出它是为了 `Context` 不必认识 `WeakMap` —— 而不是给消费面用的。
 */
export function documentOfSnapshot(token: DocumentSnapshot): RuntimeDocument | undefined {
  return SNAPSHOTS.get(token)
}
