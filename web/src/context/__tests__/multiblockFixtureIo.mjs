/**
 * 装配测试的 Node 侧 IO 适配层（**测试期专用**，生产代码不引用）。
 *
 * 为什么单独一个 `.mjs`：`web/tsconfig.json` 未安装 `@types/node`，测试 `.ts` 里直接
 * `import 'node:fs'` 会让 `npm run typecheck` 新增报错。把 Node 能力收敛到这个纯 JS 模块
 * （不进 tsconfig 的 `include`），TS 侧只看到一个类型声明文件。
 *
 * 路径解析基准：`web/src/context/__tests__/` → 仓库根 = `../../../..`。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..', '..')

/** `web/src/context/__tests__/fixtures` */
export const FIXTURE_DIR = join(HERE, 'fixtures')
/** 校验器 `--verify-grids` 的落盘目录（`.gitignore` 内，可再生） */
export const REF_DIR = join(REPO, 'scripts', 'multiblock-fixtures', '.out', 'expanded-fixtures')

export function fixturePath(name) {
  return join(FIXTURE_DIR, `${name}.json`)
}

/** 参考网格文件名：与校验器 `--verify-grids` 的命名逐字一致。 */
export function refPath(name, variantKey) {
  return join(REF_DIR, `${name}__${variantKey.replace(/[|:]/g, '_')}.json`)
}

export function exists(path) {
  return existsSync(path)
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function listReferenceFiles() {
  return existsSync(REF_DIR) ? readdirSync(REF_DIR) : []
}

export function writeReference(name, variantKey, payload) {
  mkdirSync(REF_DIR, { recursive: true })
  writeFileSync(refPath(name, variantKey), JSON.stringify(payload), 'utf8')
}

/**
 * 读取 fixture 的**内层 body**（`docs/protocol.md` 的 Envelope「编码」的两种载荷：`base64(json)` / `base64(gzip(json))`）。
 * 与 `scripts/multiblock-fixtures/lib.mjs` 的 `readFixtureDocument` 同口径；这里刻意只做
 * "解包 + 合并 meta"，不引入任何解析器代码。
 */
export function loadInnerDocument(name) {
  const raw = readJson(fixturePath(name))
  if (typeof raw.payload === 'string' && raw.meta && typeof raw.meta === 'object') {
    const bytes = Buffer.from(raw.payload, 'base64')
    let body
    try {
      body = JSON.parse(bytes.toString('utf8'))
    } catch {
      body = JSON.parse(gunzipSync(bytes).toString('utf8'))
    }
    return { ...raw.meta, ...body }
  }
  return raw
}

/** 动态载入冻结蓝本 `scripts/multiblock-fixtures/lib.mjs`（仅在参考网格缺失时使用）。 */
export function loadReferenceLib() {
  return import(/* @vite-ignore */ pathToFileURL(join(REPO, 'scripts', 'multiblock-fixtures', 'lib.mjs')).href)
}
