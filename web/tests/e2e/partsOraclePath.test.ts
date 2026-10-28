import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CANONICAL_ORACLE_FILES,
  PARTS_CANONICAL_ORACLE_REL,
  REPO_ROOT,
  resolveOraclePath,
  resolveOraclePathAt,
} from '../../e2e/helpers/parts/oraclePath'

/**
 * 部件 oracle 的**仓内基准**解析判据（离线，不启动浏览器）。
 *
 * 背景：canonical 目录曾指向已删除的 `scripts/parts-acceptance/oracle`。该目录不存在时，
 * 生产解析会退到归档副本；归档缺副本时才显式失败 —— 也就是说路径写错**不会立刻红**，
 * 而是悄悄换了权威来源。本文件把「基准位置」与三种解析分支一起钉住。
 *
 * 不读取三份 oracle 的内容，只用空占位文件验证目录选择；真实文件仅做存在性检查。
 */

const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function plant(dir: string, kind: keyof typeof CANONICAL_ORACLE_FILES): string {
  const file = path.join(dir, CANONICAL_ORACLE_FILES[kind])
  fs.writeFileSync(file, 'placeholder', 'utf8')
  return file
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('部件 oracle 仓内基准', () => {
  it('canonical 根是 test/expected/parts-acceptance，三份 oracle 齐备', () => {
    expect(PARTS_CANONICAL_ORACLE_REL).toBe(path.join('test', 'expected', 'parts-acceptance'))
    for (const file of Object.values(CANONICAL_ORACLE_FILES)) {
      const full = path.join(REPO_ROOT, PARTS_CANONICAL_ORACLE_REL, file)
      expect(fs.existsSync(full), `缺少仓内 oracle：${full}`).toBe(true)
      expect(fs.statSync(full).size).toBeGreaterThan(0)
    }
  })

  it('canonical 优先于归档副本', () => {
    const canonical = tempDir('parts-canonical-')
    const archive = tempDir('parts-archive-')
    const want = plant(canonical, 'full')
    plant(archive, 'full')

    expect(resolveOraclePathAt(canonical, archive, 'full')).toEqual({ path: want, source: 'canonical' })
  })

  it('canonical 缺失时回退归档副本', () => {
    const canonical = tempDir('parts-canonical-')
    const archive = tempDir('parts-archive-')
    const want = plant(archive, 'full')

    expect(resolveOraclePathAt(canonical, archive, 'full')).toEqual({ path: want, source: 'archive' })
  })

  it('两者皆缺 ⇒ 显式失败（不静默回退）', () => {
    const canonical = tempDir('parts-canonical-')
    const archive = tempDir('parts-archive-')

    expect(() => resolveOraclePathAt(canonical, archive, 'degradedAll')).toThrow(/oracle 缺失/)
    expect(() => resolveOraclePathAt(canonical, archive, 'degradedAll')).toThrow(
      new RegExp(CANONICAL_ORACLE_FILES.degradedAll),
    )
  })

  it('生产解析用仓内 canonical，而不是归档里的同名副本', () => {
    const archive = tempDir('parts-archive-')
    plant(archive, 'full')

    const got = resolveOraclePath(archive, 'full')
    expect(got.source).toBe('canonical')
    expect(got.path).toBe(
      path.join(REPO_ROOT, PARTS_CANONICAL_ORACLE_REL, CANONICAL_ORACLE_FILES.full),
    )
  })
})
