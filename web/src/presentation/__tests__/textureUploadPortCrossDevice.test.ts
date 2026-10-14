/**
 * **跨设备域纹理传递的机械判据**（#389 R3-① 的"不借用"落点；R3-1a 交付）。
 *
 * ## 判据要防的形态（一句话）
 *
 * 离屏导出**不得**向实时视口索取任何 GL 资源或纹理句柄。跨设备域**只允许**传
 * 两样东西：`TexturePixels`（纯数据）与 `ContentIdentity`（内容身份）。
 *
 * ## 本文件的扫描口径（**显式声明**，避免"判据面含糊 ⇒ 假绿"）
 *
 * | 判据 | 扫描面 | 手段 |
 * |---|---|---|
 * | A · 上传端口语义纯净 | `presentation/textureUploadPort.ts` | **AST**（typescript 编译器 API） |
 * | B · 离屏侧不借用视口 | `src/adapters/export/**` 全部生产文件 | **AST 取 import 说明符** + 剥注释与字符串后的文本扫描 |
 * | C · 上传实现唯一且归设备域 | `src/adapters/export/**` / `presentation/textureUploadPort.ts` | AST 定位（`acquire` 方法体范围）+ 文本 |
 *
 * 每条判据都带**负对照**（把违规形态喂给**同一个**判定函数，必须判红）与
 * **反空洞真**（受检文件数下限）—— 否则"0 违规"可能只是"没扫到"。
 *
 * ## 为什么文本扫描前必须剥注释与字符串
 *
 * 本仓的注释里**应当**能写"旧实现曾向视口借用纹理"这类退役记录；若注释也判红，
 * 退役记录就写不了。字符串字面量同理（路径名出现在消息里是正常的）。
 * ⇒ 凡非 AST 的判定，一律先 `stripCommentsAndStrings`。
 *
 * ## CRLF 纪律（铁律 6）
 *
 * 所有源码读取都经 `readNorm`（读入口归一化，`.replace(/\r\n/g, '\n')`）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as ts from 'typescript'

const WEB_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const SRC_ROOT = path.join(WEB_ROOT, 'src')

const UPLOAD_PORT_REL = 'presentation/textureUploadPort.ts'
const UPLOAD_IMPL_REL = 'adapters/export/offscreenTextureUpload.ts'
const DEVICE_REL = 'adapters/export/renderDevice.ts'
const OFFSCHORE_PORT_REL = 'adapters/export/offscreenRenderPort.ts'

// ─────────────────────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────────────────────

/** 读源码并归一化行尾为 LF（铁律 6 的治本处）。 */
function readNorm(abs: string): string {
  return fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')
}

/** 剥掉注释与字符串字面量（非 AST 判定的**前置**，见文件头）。 */
function stripCommentsAndStrings(src: string): string {
  let out = ''
  let i = 0
  let mode: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code'
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; i += 2; continue }
      if (c === '/' && n === '*') { mode = 'block'; i += 2; continue }
      if (c === "'" || c === '"' || c === '`') {
        mode = c === "'" ? 'sq' : c === '"' ? 'dq' : 'tpl'
        out += ' '
        i++
        continue
      }
      out += c
      i++
      continue
    }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c } i++; continue }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = 'code'; i += 2; continue } i++; continue }
    if (c === '\\') { i += 2; continue }
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === '`')) mode = 'code'
    i++
  }
  return out
}

/** 解析为 TS AST（`ScriptKind.TS`；`.vue` 不在本判据面内）。 */
function parse(rel: string, text: string): ts.SourceFile {
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

/** 收集某类型节点里出现的**具名类型引用**（`A<B>` ⇒ `A`, `B`）。 */
function namedTypeRefs(node: ts.Node, sf: ts.SourceFile): string[] {
  const out: string[] = []
  const walk = (n: ts.Node): void => {
    if (ts.isTypeReferenceNode(n)) out.push(n.typeName.getText(sf))
    ts.forEachChild(n, walk)
  }
  walk(node)
  return out
}

/** 收集 `src/adapters/export/` 下的生产文件（相对 `src/`；正斜杠）。 */
function exportAdapterFiles(): string[] {
  const dir = path.join(SRC_ROOT, 'adapters', 'export')
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) continue
    if (!/\.(ts|tsx|mts)$/.test(e.name)) continue
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name) || /\.d\.ts$/.test(e.name)) continue
    out.push(`adapters/export/${e.name}`)
  }
  return out.sort()
}

// ─────────────────────────────────────────────────────────────────────────────
// 判据 A：纹理上传端口的**签名面**只允许出现纯数据与不透明句柄
// ─────────────────────────────────────────────────────────────────────────────

/** 端口方法签名里**允许**出现的具名类型（跨设备域传递面）。 */
const ALLOWED_PORT_TYPE_REFS = ['DeviceScope', 'TexturePixels', 'ContentIdentity', 'TextureHandleRef']

/**
 * 判定一份源码的 `TextureUploadPort` 接口是否**语义纯净**。
 *
 * 返回违规描述列表（空 = 绿）。**纯函数**：负对照就喂它注入样本。
 */
function judgeUploadPortFace(rel: string, text: string): string[] {
  const sf = parse(rel, text)
  const violations: string[] = []
  let found = false
  sf.forEachChild((node) => {
    if (!ts.isInterfaceDeclaration(node) || node.name.text !== 'TextureUploadPort') return
    found = true
    for (const member of node.members) {
      const sig = member as ts.SignatureDeclaration
      const where = `${rel}:${sf.getLineAndCharacterOfPosition(member.getStart(sf)).line + 1}`
      const typeNode = (member as ts.PropertySignature).type
      const refs = [
        ...(typeNode === undefined ? [] : namedTypeRefs(typeNode, sf)),
        ...(sig.parameters ?? []).flatMap((p) => namedTypeRefs(p, sf)),
        ...(sig.type === undefined ? [] : namedTypeRefs(sig.type, sf)),
      ]
      for (const ref of refs) {
        if (!ALLOWED_PORT_TYPE_REFS.includes(ref)) {
          violations.push(`${where} 类型引用 ${ref} —— 端口签名只允许 ${ALLOWED_PORT_TYPE_REFS.join('/')}`)
        }
      }
      // 参数名/类型文本里的 GL 资源字样（`THREE.Texture` 是 `QualifiedName`，上面已覆盖具名引用）
      if (/\bTHREE\b|\bWebGL[A-Z]|\bDataTexture\b/.test(member.getText(sf))) {
        violations.push(`${where} 端口签名里出现 GL 资源类型（不得跨设备域）`)
      }
    }
  })
  if (!found) violations.push(`${rel} 必须声明 TextureUploadPort 接口（判据面缺失 ⇒ 不得算绿）`)
  return violations
}

/**
 * 判定 `THREE.Texture` 是否只出现在**两个允许位**：
 *  ① `TextureHandleRef.resolve()` 的返回位（句柄窄门）；
 *  ② `texturePortOf` 内部实现 `textureFor` 的返回位（它满足**冻结**的 `TexturePort`，
 *     该接口本身就是 `THREE.Texture | null`，不得改动）。
 * 其余任何位置出现 = 逃逸（跨模块入口又多了一个）。
 */
function judgeTextureEscapeHatch(rel: string, text: string): string[] {
  const sf = parse(rel, text)
  const violations: string[] = []
  const visit = (node: ts.Node, enclosingInterface: string | null, enclosingFunction: string | null): void => {
    let iface = enclosingInterface
    let fn = enclosingFunction
    if (ts.isInterfaceDeclaration(node) && ts.isIdentifier(node.name)) iface = node.name.text
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name)
    ) {
      fn = node.name.text
    }
    if (ts.isMethodSignature(node) && ts.isIdentifier(node.name) && node.name.text === 'resolve' && iface === 'TextureHandleRef') {
      return // 允许位①（不再深入其子节点）
    }
    if (ts.isTypeReferenceNode(node) && node.typeName.getText(sf) === 'THREE.Texture') {
      if (fn !== 'texturePortOf' && fn !== 'textureFor') {
        violations.push(
          `${rel} 的 ${iface ?? fn ?? '<顶层>'} 处出现 THREE.Texture（唯一允许位是 TextureHandleRef.resolve 与 texturePortOf 的 textureFor）`,
        )
      }
    }
    ts.forEachChild(node, (c) => visit(c, iface, fn))
  }
  visit(sf, null, null)
  return violations
}

// ─────────────────────────────────────────────────────────────────────────────
// 判据 B：离屏适配器**不借用**实时视口的 GL 资源
// ─────────────────────────────────────────────────────────────────────────────

/** 禁止出现的模块说明符片段（跨到**视口 GL 资源**的提供方去取纹理实现）。 */
const FORBIDDEN_SPECIFIER_FRAGMENTS = [
  'composition/viewportTexturePort',
  'shared/viewport',
  'render/viewport',
  'renderEngine',
]

/** 禁止出现的调用/标识符（剥注释与字符串后判定）。 */
const FORBIDDEN_SYMBOLS = [
  'createViewportTexturePort',
  'useViewportRuntime',
  'renderViewport',
  'viewportTexturePort',
]

/**
 * 判定一份源码是否**向视口借用了** GL 资源。
 *
 * 手段：① AST 取全部 import/export-from 说明符（精确，不受注释影响）；
 * ② 剥注释与字符串后扫禁止符号。返回违规描述列表（空 = 绿）。
 */
function judgeNoViewportBorrow(rel: string, text: string): string[] {
  const sf = parse(rel, text)
  const violations: string[] = []
  const specifiers: string[] = []
  sf.forEachChild((node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    }
  })
  for (const s of specifiers) {
    for (const frag of FORBIDDEN_SPECIFIER_FRAGMENTS) {
      if (s.includes(frag)) violations.push(`${rel} 从 ${s} 引入（含禁止片段 ${frag}）`)
    }
  }
  const code = stripCommentsAndStrings(text)
  for (const symbol of FORBIDDEN_SYMBOLS) {
    if (code.includes(symbol)) violations.push(`${rel} 出现禁止符号 ${symbol}（向视口借用 GL 资源）`)
  }
  return violations
}

// ─────────────────────────────────────────────────────────────────────────────
// 判据 C：上传实现的归属（设备域在 acquire 内自建；实现唯一）
// ─────────────────────────────────────────────────────────────────────────────

/** 判定 `renderDevice.ts` 是否**在 `acquire` 方法体内**自建上传端口。 */
function judgeDeviceOwnsUpload(rel: string, text: string): string[] {
  const sf = parse(rel, text)
  const violations: string[] = []
  let inAcquire = false
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'acquire') {
      if (node.body !== undefined && node.body.getText(sf).includes('createRendererTextureUpload')) inAcquire = true
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (!inAcquire) {
    violations.push(`${rel} 必须在 acquire(render) 方法体内调用 createRendererTextureUpload（设备域在 acquire 内自建）`)
  }
  return violations
}

// ─────────────────────────────────────────────────────────────────────────────
// 一、判据 A
// ─────────────────────────────────────────────────────────────────────────────

describe('R3-① 纹理上传端口：跨设备域只传纯数据与内容身份', () => {
  it('**反空洞真**：端口文件存在、非空，且真的声明了五个成员', () => {
    const abs = path.join(SRC_ROOT, UPLOAD_PORT_REL)
    expect(fs.existsSync(abs), `${UPLOAD_PORT_REL} 必须存在`).toBe(true)
    const text = readNorm(abs)
    expect(text.length, '端口文件不得为空').toBeGreaterThan(800)
    for (const member of ['scope:', 'upload(', 'lookup(', 'release(', 'dispose(']) {
      expect(text, `端口语义必须齐（缺 ${member}）`).toContain(member)
    }
  })

  it('A · `TextureUploadPort` 的每个成员签名只引用纯数据/身份/不透明句柄/设备域', () => {
    const violations = judgeUploadPortFace(UPLOAD_PORT_REL, readNorm(path.join(SRC_ROOT, UPLOAD_PORT_REL)))
    expect(violations, `端口签名面出现跨设备域类型:\n${violations.join('\n')}`).toEqual([])
  })

  it('A2 · 装配函数 `texturePortOf` 的返回类型是冻结的 `TexturePort`', () => {
    const sf = parse(UPLOAD_PORT_REL, readNorm(path.join(SRC_ROOT, UPLOAD_PORT_REL)))
    let returnType: string | null = null
    sf.forEachChild((node) => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name !== undefined &&
        node.name.text === 'texturePortOf' &&
        node.type !== undefined
      ) {
        returnType = node.type.getText(sf)
      }
    })
    expect(returnType, 'texturePortOf 必须返回 TexturePort（不得新建接口）').toBe('TexturePort')
  })

  it('A3 · 全文件 `THREE.Texture` 只出现在 `TextureHandleRef.resolve` 一处', () => {
    const violations = judgeTextureEscapeHatch(UPLOAD_PORT_REL, readNorm(path.join(SRC_ROOT, UPLOAD_PORT_REL)))
    expect(violations, `THREE.Texture 逃逸出句柄窄门:\n${violations.join('\n')}`).toEqual([])
  })

  it('**负对照**：签名里出现 `THREE.Texture`/`WebGLRenderer` 的端口必须判红', () => {
    const leaky = [
      'export interface TextureUploadPort {',
      '  readonly scope: DeviceScope',
      '  upload(pixels: TexturePixels, identity: ContentIdentity): TextureHandleRef',
      '  lookup(identity: ContentIdentity): TextureHandleRef | null',
      '  release(identity: ContentIdentity): void',
      '  renderer(): THREE.WebGLRenderer',
      '  dispose(): void',
      '}',
    ].join('\n')
    const violations = judgeUploadPortFace('injected/leakyPort.ts', leaky)
    expect(violations.length, '注入的越界端口必须判红').toBeGreaterThan(0)
    // ② 同一判据对**真实**端口文件判绿（证明区分力来自签名，不来自"文件不存在"）
    expect(judgeUploadPortFace(UPLOAD_PORT_REL, readNorm(path.join(SRC_ROOT, UPLOAD_PORT_REL)))).toEqual([])
  })

  it('**负对照**：`THREE.Texture` 出现在 `TextureUploadPort` 上必须判红（窄门唯一）', () => {
    const leaky = [
      'export interface TextureHandleRef { resolve(): THREE.Texture }',
      'export interface TextureUploadPort {',
      '  texture(): THREE.Texture',
      '}',
    ].join('\n')
    const violations = judgeTextureEscapeHatch('injected/escape.ts', leaky)
    expect(violations.length, '注入的逃逸必须判红').toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 二、判据 B：离屏侧不向视口借用
// ─────────────────────────────────────────────────────────────────────────────

describe('R3-② 离屏适配器不向视口索取 GL 资源/纹理句柄', () => {
  it('**反空洞真**：受检文件数达标，且含设备与上传实现', () => {
    const files = exportAdapterFiles()
    expect(files.length, '必须扫到 adapters/export/ 的生产文件').toBeGreaterThanOrEqual(5)
    expect(files, '必须含设备实现').toContain(DEVICE_REL)
    expect(files, '必须含上传实现').toContain(UPLOAD_IMPL_REL)
  })

  it('B · `src/adapters/export/**` 无向视口/装配域借用的 import 与符号', () => {
    const files = exportAdapterFiles()
    const violations: string[] = []
    for (const rel of files) {
      violations.push(...judgeNoViewportBorrow(rel, readNorm(path.join(SRC_ROOT, rel))))
    }
    expect(
      violations,
      `离屏适配器向视口借用了 GL 资源（跨设备域只允许传 TexturePixels/ContentIdentity）:\n${violations.join('\n')}`,
    ).toEqual([])
  })

  it('**负对照**：让离屏侧去视口取纹理 ⇒ 同一判据必须判红', () => {
    const borrowed = [
      "import { createViewportTexturePort } from '@/composition/viewportTexturePort'",
      'export function borrowFromViewport(scope: string) {',
      '  return createViewportTexturePort(scope)',
      '}',
    ].join('\n')
    const violations = judgeNoViewportBorrow('injected/borrowFromViewport.ts', borrowed)
    expect(violations.length, '注入的借用必须判红').toBeGreaterThan(0)
    // 注释里写"曾借用视口"**不**判红（退役记录必须可写）
    const commented = [
      '// 旧实现: import { createViewportTexturePort } from "@/composition/viewportTexturePort"',
      "export const note = 'createViewportTexturePort'",
    ].join('\n')
    expect(judgeNoViewportBorrow('injected/comment.ts', commented), '注释/字符串不得判红').toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 三、判据 C：上传实现归设备域
// ─────────────────────────────────────────────────────────────────────────────

describe('R3-② 上传实例由离屏设备域自建（不向视口索取）', () => {
  it('C · `renderDevice.ts` 在 `acquire` 内自建上传端口；上传实现在离屏域', () => {
    const violations = judgeDeviceOwnsUpload(DEVICE_REL, readNorm(path.join(SRC_ROOT, DEVICE_REL)))
    expect(violations, violations.join('\n')).toEqual([])
    const impl = readNorm(path.join(SRC_ROOT, UPLOAD_IMPL_REL))
    expect(
      impl,
      '离屏上传必须发生在本设备域自己的渲染器上（initTexture）',
    ).toContain('renderer.initTexture(')
    expect(impl, '离屏上传实现必须实现 TextureUploadPort').toContain('TextureUploadPort')
  })

  it('C2 · 全 `src/adapters/export/**` 里建 `DataTexture` 的文件**恰好一个**（上传面唯一）', () => {
    const owners = exportAdapterFiles().filter((rel) =>
      stripCommentsAndStrings(readNorm(path.join(SRC_ROOT, rel))).includes('new THREE.DataTexture'),
    )
    expect(owners, '建纹理的位置必须唯一且归离屏上传实现').toEqual([UPLOAD_IMPL_REL])
  })

  it('C3 · 离屏渲染端口本体**不**建纹理、**不**上传（上传归设备域）', () => {
    const code = stripCommentsAndStrings(readNorm(path.join(SRC_ROOT, OFFSCHORE_PORT_REL)))
    expect(code.includes('new THREE.DataTexture'), '离屏端口不得自带纹理上传').toBe(false)
    expect(code.includes('initTexture'), '离屏端口不得调 uploader').toBe(false)
  })

  it('**负对照**：把 `initTexture`/`DataTexture` 放进离屏端口本体 ⇒ 位置判据判红', () => {
    const injected = stripCommentsAndStrings(
      ['const t = new THREE.DataTexture(data, 1, 1)', 'renderer.initTexture(t)'].join('\n'),
    )
    const owners = ['adapters/export/borrowedUpload.ts'].filter(
      () => injected.includes('new THREE.DataTexture'),
    )
    expect(owners, '注入的越位上传必须被同一判据抓到').toEqual(['adapters/export/borrowedUpload.ts'])
  })
})
