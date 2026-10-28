import fs from 'node:fs'
import path from 'node:path'

/**
 * 部件验收 oracle 的**解析路径**（无浏览器依赖，供 helper 与离线单测共用）。
 *
 * ## 权威来源
 *
 * canonical = 仓内基准 `test/expected/parts-acceptance/`（三份 oracle JSON 直接位于该目录，
 * 没有额外的 `oracle/` 子层）。归档目录（`PARTS_ACCEPTANCE_DIR`）里也可能带同名副本；
 * **canonical 优先**，缺失时才回退归档副本，两者皆缺 ⇒ 显式失败（不静默跳过）。
 *
 * 旧常量曾指向已删除的 `scripts/parts-acceptance/oracle/`。该路径不存在时解析会悄悄退到
 * 归档副本 —— 这正是 `tests/e2e/partsOraclePath.test.ts` 要用三种分支钉住的原因。
 */

/** `web/` 的上四级 = 仓库根（本文件位于 `web/e2e/helpers/parts/`）。 */
export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')

/** canonical oracle 目录（相对仓库根）。 */
export const PARTS_CANONICAL_ORACLE_REL = path.join('test', 'expected', 'parts-acceptance')

/** 三份 oracle 的文件名（与归档副本同名）。 */
export const CANONICAL_ORACLE_FILES = {
  full: 'sde_parts_acceptance_oracle_full.json',
  degradedAe2: 'sde_parts_acceptance_oracle_degraded_ae2.json',
  degradedAll: 'sde_parts_acceptance_oracle_degraded_all.json',
} as const

/** 产物缺失时给出的确切生成命令（不是"跳过"）。 */
export const REAL_EXPORT_COMMAND =
  '在 GTNH 客户端完成部件验收导出（建造 → 导出 → oracle），并用 PARTS_ACCEPTANCE_DIR 指定归档'

/**
 * 在给定目录上执行三分支解析（canonical → 归档 → 显式失败）。
 *
 * 目录显式传入，让离线判据可以分别验证三种分支而不碰仓内基准。
 */
export function resolveOraclePathAt(
  canonicalDir: string,
  archiveDir: string,
  kind: keyof typeof CANONICAL_ORACLE_FILES,
): { path: string; source: 'canonical' | 'archive' } {
  const canonical = path.join(canonicalDir, CANONICAL_ORACLE_FILES[kind])
  if (fs.existsSync(canonical)) return { path: canonical, source: 'canonical' }
  const archived = path.join(archiveDir, CANONICAL_ORACLE_FILES[kind])
  if (fs.existsSync(archived)) return { path: archived, source: 'archive' }
  throw new Error(
    `部件验收：oracle 缺失（canonical=${canonical} / archive=${archived}）—— 显式失败。生成：${REAL_EXPORT_COMMAND}`,
  )
}

/** 生产读路径：canonical 根固定为仓库内基准。 */
export function resolveOraclePath(
  dir: string,
  kind: keyof typeof CANONICAL_ORACLE_FILES,
): { path: string; source: 'canonical' | 'archive' } {
  return resolveOraclePathAt(path.join(REPO_ROOT, PARTS_CANONICAL_ORACLE_REL), dir, kind)
}
