/**
 * Vitest 侧的**真实夹具门控** helper（类型安全；不整文件 exclude）。
 *
 * 契约：
 *  - 夹具可用 ⇒ 正常注册该 `it`；
 *  - 夹具缺失 ⇒ 显式 `it.skip`（依赖真实件的判据**不计入通过**）；
 *  - 返回 `void`，避免把 `it` / `it.skip` 的联合塞进条件表达式后丢失调用签名。
 *
 * 只门控**真正消费该件**的用例：纯语义判据与仓内 Plain 夹具用例始终运行。
 */
/// <reference path="./real-fixtures.d.ts" />
import { it } from 'vitest'
import type { RealFixtureKey } from './real-fixtures.mjs'
import { realFixtureAvailable } from './real-fixtures.mjs'

/** 惰性读件（CRLF→LF）的类型安全 re-export，消费方无需重复引用 .d.ts。 */
export { realFixtureText } from './real-fixtures.mjs'

export function withRealFixture(
  key: RealFixtureKey,
  name: string,
  fn: () => void | Promise<void>,
): void {
  if (realFixtureAvailable(key)) it(name, fn)
  else it.skip(name, fn)
}
