/**
 * shared/types.ts — 最小化接口定义，供 shared/ 层使用。
 *
 * 避免 shared/ composables 反向依赖 workbench/ 上下文类型。
 * workbench/ 层的 Context 通过 implements 这些接口关联。
 */

export type LoadStatus = 'loading' | 'ok' | 'error'

// ---------------------------------------------------------------------------
// Screen types (shared between embed and workbench)
// ---------------------------------------------------------------------------

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

// ---------------------------------------------------------------------------
// RNA 类型已迁出（#253 P2，退役 #3）
// ---------------------------------------------------------------------------
//
// 旧此处定义 `RNAPropType` / `PropertyDescriptor`(含 `get`/`set` 闭包与 `uiWidget` 控件名)
// / `RNAStruct` / `RNARegistry`。三者的问题（#251 B7 证据，契约 §5.1/§5.2）：
//  1. 描述里带 `get`/`set` **闭包** ⇒ 调用方拿到「直接改内存」的旁路写面（禁止）；
//  2. 描述里带 `uiWidget` **控件名** ⇒ 换控件必须改核心（RNA 不得认识控件）；
//  3. `update?: string` 零读者；`enumItems: string[]` 无法表达「值 ≠ 显示名」。
//
// 新的属性描述在 `@/application/properties`（数据、无闭包、无控件名），
// 由 `@/editors/workbench-inspector` 贡献具体对象类型，`@/editors/workbench-rna`
// 接到活上下文。旧类型同批删除，**不留兼容别名**（#171 退役纪律）。

