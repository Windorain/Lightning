/**
 * 仓库根 `.env` 的唯一加载入口（真实夹具试点）。
 *
 * 契约：
 *  - 只加载**仓库根** `.env`；文件不存在 ⇒ 什么都不做；
 *  - 使用 Node 内建 `process.loadEnvFile`（Node >= 20.12；本仓库 engines >= 22.13）；
 *  - 不覆盖已存在的环境变量（`process.loadEnvFile` 的既有语义：shell / CI 注入优先）；
 *  - 幂等：同一进程内重复 import / 调用只加载一次。
 *
 * 夹具根的键与目录布局见 `real-fixtures.mjs` 与根 `.env.example`。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'

const ROOT_ENV_LOADED = Symbol.for('lightning.realFixtures.rootEnvLoaded')

/**
 * 从 cwd 向上找仓库根。
 * 兼容 worktree：`.git` 可能是目录，也可能是文件（gitdir 指针）。
 */
export function findRepoRoot(start = process.cwd()) {
  let dir = path.resolve(start)
  for (;;) {
    if (existsSync(path.join(dir, '.git')) && existsSync(path.join(dir, 'web', 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return path.resolve(start)
    dir = parent
  }
}

export const REPO_ROOT = findRepoRoot()
export const ROOT_ENV_PATH = path.join(REPO_ROOT, '.env')

/**
 * 加载根 `.env`。返回实际结果，便于 global setup 记录证据。
 *
 * @returns {{ loaded: boolean, path: string, reason: 'loaded' | 'missing' | 'already-loaded' }}
 */
export function loadRootEnv() {
  if (globalThis[ROOT_ENV_LOADED] === true) {
    return { loaded: false, path: ROOT_ENV_PATH, reason: 'already-loaded' }
  }
  if (!existsSync(ROOT_ENV_PATH)) {
    globalThis[ROOT_ENV_LOADED] = true
    return { loaded: false, path: ROOT_ENV_PATH, reason: 'missing' }
  }
  process.loadEnvFile(ROOT_ENV_PATH)
  globalThis[ROOT_ENV_LOADED] = true
  return { loaded: true, path: ROOT_ENV_PATH, reason: 'loaded' }
}

loadRootEnv()
