/**
 * `real-fixtures.mjs` 的类型声明。
 *
 * tsconfig 的 include 不含 `e2e/`，因此消费方（测试）用
 * `/// <reference path=".../real-fixtures.d.ts" />` 把本声明纳入程序；
 * 模块名用通配，以匹配消费方的相对导入说明符。
 */
declare module '*real-fixtures.mjs' {
  /** 一个消费文件及其被门控的判据名。 */
  export interface RealFixtureConsumer {
    readonly consumer: string
    readonly gatedTests: readonly string[]
  }

  export interface RealFixtureStatus {
    readonly key: string
    readonly expectedRelativePath: string
    /** 权威字段：一个资产可以有多个消费文件。 */
    readonly consumers: readonly RealFixtureConsumer[]
    /** 派生：消费文件串（单消费方时与旧字段逐字相同）。 */
    readonly consumer: string
    /** 派生：被门控判据的并集。 */
    readonly gatedTests: readonly string[]
    readonly envKey: string
    readonly envDir: string | null
    readonly candidates: readonly string[]
    readonly path: string | null
    readonly available: boolean
    readonly missingKind: 'env' | 'file' | null
    readonly reason: string
  }

  /** 已知真实夹具键（与 `REAL_FIXTURE_KEYS` 同集）。 */
  export type RealFixtureKey =
    | 'ggCtmGlass'
    | 'tesrCaptureCtm'
    | 'ic2StripRatchet'
    | 'structureDataExportedEnvelope'

  export const REAL_FIXTURES_DIR_ENV: string
  export const REAL_FIXTURE_KEYS: readonly RealFixtureKey[]

  export function realFixtureAvailable(key: RealFixtureKey): boolean
  export function realFixturePath(key: RealFixtureKey): string
  /** 读取真实件文本并把 CRLF 归一化为 LF（惰性；缺件时抛出带诊断的错误）。 */
  export function realFixtureText(key: RealFixtureKey): string
  export function realFixtureStatus(key: RealFixtureKey): RealFixtureStatus
  export function realFixtureErrorMessage(status: RealFixtureStatus): string
}
