/**
 * pure/deepCopy.ts — 纯 JSON 形数据的深拷贝（Proxy 安全）。
 *
 * 背景（P2.5 E2E 实证的生产 bug）：`runtime/main.ts` 把 RuntimeDocument 放进 Vue **深响应式**
 * `ref`，其内部数组/对象经 Proxy 访问时是 reactive proxy；`structuredClone()` 不能克隆 Proxy
 * （DataCloneError），导致含部件文档在 serialize/clone/undo/导出全部生产表面崩溃。
 * 单测盲区：测试手工 new RuntimeDocument 未经响应式 ref。
 *
 * 本函数手写递归拷贝：读取可以穿过 Proxy（取值不触发克隆限制），产物是纯裸对象。
 * 仅支持 JSON 形数据（primitive / 数组 / 裸对象）；不接受 Map/Set/类实例/函数（调用方纪律）。
 *
 * No side effects: no Vue refs, no DOM, no I/O, no mutation of arguments.
 */

/** 深拷贝纯 JSON 形数据（Proxy 安全；产物为裸对象/数组）。 */
export function deepCopyPlain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length)
    for (let i = 0; i < value.length; i++) out[i] = deepCopyPlain(value[i])
    return out as T
  }
  const src = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(src)) out[key] = deepCopyPlain(src[key])
  return out as T
}
