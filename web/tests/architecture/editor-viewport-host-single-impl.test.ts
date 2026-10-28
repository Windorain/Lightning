/**
 * **单一视口宿主**的常驻判据（D7 退役验收）。
 *
 * ## 判据（四条，各自可判红）
 *
 * | # | 判据 | 负对照 |
 * |---|---|---|
 * | ① 唯一实现有 **import 证据** | 两个壳的源码里都有 `EditorViewportHost` 的 import 声明，且宿主文件里确实 `useViewportRuntime`/`attachViewport`/`viewports.unregister` | 把壳的 import 改成旧路径 ⇒ 计数 0 |
 * | ② 旧粘合**不残留**在两个壳里 | 两个壳都不再直接调用 `useViewportRuntime(` / `host.attachViewport(` / `viewports.unregister(` / `createViewportPresenter(` | 把任意一行旧粘合注入壳文本 ⇒ 同一判定式判红 |
 * | ③ 槽位归零**只有一个生产落点** | 全 `src/` 里 `.viewports.unregister(` 的生产命中恰好是宿主文件 | 注入第二个落点 ⇒ 判红 |
 * | ④ 宿主内**没有宿主名分支** | 宿主与两个壳的代码里都没有 `isEmbed` / `profileId ===` / `工作台|嵌入` 的宿主判别 | 注入 `if (ctx.isEmbed())` ⇒ 判红 |
 *
 * ## 口径（与 `shared-viewport-upward-import-closure.test.ts` 一致）
 *
 * 读源码后 **CRLF 归一化**（铁律 6），把行注释/块注释置换为空白，再按**行首** import
 * 声明与标识符匹配 —— 于是本文件头里出现的这些字样不会被算成命中。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const WEB_ROOT = path.join(import.meta.dirname, '..', '..')
const SRC_ROOT = path.join(WEB_ROOT, 'src')

/** 宿主（唯一实现）与两个壳（薄包装）。 */
const HOST_REL = 'src/shared/viewport/EditorViewportHost.vue'
const SHELLS = [
  'src/workbench/components/WorkbenchViewport.vue',
  'src/shared/viewport/EmbedViewport.vue',
]

function readNorm(rel: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}

/** 把注释置换为等长空白（保留换行与字符串字面量；与同目录另一判据同口径）。 */
function maskComments(src: string): string {
  const text = src.replace(/\r\n/g, '\n')
  let out = ''
  let i = 0
  let mode: 'code' | 'line' | 'block' | 'str' = 'code'
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; out += '  '; i += 2; continue }
      if (c === '/' && n === '*') { mode = 'block'; out += '  '; i += 2; continue }
      if (c === "'" || c === '"' || c === '`') { mode = 'str'; out += c; i++; continue }
      out += c; i++; continue
    }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c } else out += ' '; i++; continue }
    if (mode === 'block') {
      if (c === '*' && n === '/') { mode = 'code'; out += '  '; i += 2; continue }
      out += c === '\n' ? c : ' '; i++; continue
    }
    if (c === '\\') { out += c + (n ?? ''); i += 2; continue }
    out += c
    if (c === "'" || c === '"' || c === '`') mode = 'code'
    i++
  }
  return out
}

/** 该文件是否 import 了宿主（值导入，行首锚定）。 */
function importsHost(rel: string): boolean {
  const code = maskComments(readNorm(rel))
  return /^[ \t]*import[ \t]+(?!type\b)[\s\S]*?from[ \t]*['"]@\/shared\/viewport\/EditorViewportHost\.vue['"]/m.test(code)
}

/** 旧粘合的标志性调用（这些**只应**出现在宿主里）。 */
const OLD_GLUE = [
  'useViewportRuntime(',
  'attachViewport(',
  'createViewportPresenter(',
  'viewports.unregister(',
]

function oldGlueHits(rel: string): string[] {
  const code = maskComments(readNorm(rel))
  return OLD_GLUE.filter((needle) => code.includes(needle))
}

/** 生产源码里的全部文件（剥掉测试与 node_modules）。 */
function productionFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { walk(full); continue }
      if (!/\.(ts|vue)$/.test(e.name)) continue
      out.push(path.relative(WEB_ROOT, full).replace(/\\/g, '/'))
    }
  }
  walk(SRC_ROOT)
  return out.sort()
}

/** 槽位归零的生产落点（`.viewports.unregister(` 的调用者）。 */
function slotUnregisterCallers(): string[] {
  return productionFiles().filter((rel) => maskComments(readNorm(rel)).includes('.viewports.unregister('))
}

/** 宿主名判别（组件/宿主里不得出现）。 */
function hostNameBranches(rel: string): string[] {
  const code = maskComments(readNorm(rel))
  return ['isEmbed', 'profileId ===', "profileId==="].filter((needle) => code.includes(needle))
}

describe('单一视口宿主（唯一实现 + 旧粘合不残留）', () => {
  it('**反空洞真**：宿主文件在场且持有全部粘合（否则下面的"壳里没有"是空转）', () => {
    const host = readNorm(HOST_REL)
    expect(host.length, '宿主文件必须存在且非空').toBeGreaterThan(2000)
    expect(new Set(oldGlueHits(HOST_REL)), '宿主必须持有全部粘合调用（含槽位归零）').toEqual(new Set(OLD_GLUE))
    expect(importsHost(HOST_REL), '宿主不 import 自己（判据口径自检）').toBe(false)
  })

  it('① 唯一实现的 **import 证据**：两个壳都 import 了 EditorViewportHost', () => {
    for (const rel of SHELLS) {
      expect(importsHost(rel), rel + ' 必须 import 单一视口宿主（旧粘合不得以复制形式复活）').toBe(true)
    }
    // 负对照：把 import 换成旧的直挂写法 ⇒ 同一判定式判红
    const downgraded = readNorm(SHELLS[0]).replace(
      /^([ \t]*import[ \t]+EditorViewportHost[\s\S]*?from[ \t]*['"])@\/shared\/viewport\/EditorViewportHost\.vue(['"])/m,
      "$1@/shared/viewport/embedPreview$2",
    )
    expect(importsHost(SHELLS[0])).toBe(true)
    expect(/^[ \t]*import[ \t]+(?!type\b)[\s\S]*?from[ \t]*['"]@\/shared\/viewport\/EditorViewportHost\.vue['"]/m.test(maskComments(downgraded))).toBe(false)
  })

  it('② 旧粘合**不残留**在两个壳里（含 attachViewport / useViewportRuntime / 槽位归零）', () => {
    for (const rel of SHELLS) {
      expect(oldGlueHits(rel), rel + ' 不得再直接写视口粘合（应经 EditorViewportHost）').toEqual([])
    }
    // 负对照：把一行旧粘合注入壳文本 ⇒ 同一个判定式判红
    const injected = readNorm(SHELLS[0]) + '\nconst probe = () => ctx.viewports.unregister(regionId)\n'
    expect(oldGlueHits(SHELLS[0])).toEqual([])
    expect(
      OLD_GLUE.filter((n) => maskComments(injected).includes(n)),
      '注入旧粘合必须被同一判定式抓到',
    ).toContain('viewports.unregister(')
  })

  it('③ 槽位归零**只有一个生产落点**（D6 的修复点，也是唯一的一条释放路径）', () => {
    expect(slotUnregisterCallers(), '槽位归零必须且只能由视口宿主做').toEqual([HOST_REL])
  })

  it('④ 宿主与壳里**没有宿主名判别**（差异走能力/策略，不写 if-宿主）', () => {
    for (const rel of [HOST_REL, ...SHELLS]) {
      expect(hostNameBranches(rel), rel + ' 不得按宿主名分支（SPEC §4.1）').toEqual([])
    }
    // 负对照：注入一句宿主判别 ⇒ 同一判定式判红
    const injected = readNorm(HOST_REL).replace('const props = defineProps', 'if (ctx.isEmbed()) {}\nconst props = defineProps')
    expect(hostNameBranches(HOST_REL)).toEqual([])
    expect(
      ['isEmbed'].filter((n) => maskComments(injected).includes(n)),
      '注入的宿主判别必须被抓到',
    ).toContain('isEmbed')
  })
})
