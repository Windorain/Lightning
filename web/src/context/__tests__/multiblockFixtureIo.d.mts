/**
 * `multiblockFixtureIo.mjs` 的类型声明（TS 侧只依赖这里，不依赖 `@types/node`）。
 */

/** `web/src/context/__tests__/fixtures` */
export declare const FIXTURE_DIR: string
/** 校验器 `--verify-grids` 的落盘目录 */
export declare const REF_DIR: string

export declare function fixturePath(name: string): string
export declare function refPath(name: string, variantKey: string): string
export declare function exists(path: string): boolean
export declare function readJson<T = any>(path: string): T
export declare function listReferenceFiles(): string[]
export declare function writeReference(name: string, variantKey: string, payload: unknown): void
export declare function loadInnerDocument(name: string): any
export declare function loadReferenceLib(): Promise<any>
