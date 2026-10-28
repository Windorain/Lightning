/**
 * 架构边界扫描 —— **AST / 模块图级**设施（A01 的设施本体）。
 *
 * ## 为什么是 AST 而不是关键词计数
 *
 * A01 的原文要求：「枚举生产 import/export 图；domain/application 无 Vue/Three/DOM/IO/runtime
 * 实现依赖；无私有跨模块导入」，且 §14「测试维护要求」明确：**静态边界扫描为 AST/模块图级；
 * 关键词计数只能作补充**。
 *
 * 理由：`// import vue` 这样的注释、字符串里的 `from 'vue'`、以及**类型导入**
 * （`import type { Ref } from 'vue'`）在纯文本 grep 下无法区分。本文件用 TypeScript 编译器 API
 * 解析每个源文件，只取真正的 `ImportDeclaration` / `ExportDeclaration` 节点及其
 * `importKind`，因此：
 *  - 注释与字符串**不会**误报；
 *  - `import type` **会被计入**（导入规则 6：「类型导入同样计入边界检查」）；
 *  - `export * from '...'` / `export { x } from '...'` **会被计入**
 *    （导入规则 6：「禁止经 barrel 转出口偷偷跨层」）。
 *
 * ## 覆盖面（诚实说明）
 *
 * AST 能证明的：**模块依赖图的形状**（谁 import 谁、导入语句的类别）。
 * AST **不能**证明的：JavaScript 的运行时纯性（`globalThis.x` 间接读取、动态 `await import()`
 * 里的模板拼接、通过依赖注入偷偷塞进 DOM 句柄）。A01 已就此要求「纯性同时使用导入限制、
 * 能力隔离和行为测试，不宣称静态扫描能证明全部 JavaScript 纯性」——本设施只承担**导入限制**
 * 那一半；能力隔离与行为测试属于后续工作。
 *
 * 动态 `import()` 表达式**会**被扫描（`CallExpression` + `ImportKeyword`），
 * 但只有其参数是**静态字符串字面量**时才能判定去向；模板字面量/变量参数的动态导入
 * 作为 `dynamic-unresolvable` 事实记录，不判红（避免误伤），由能力隔离测试补足。
 *
 * ## 类型位置的 `import('x').T`（补齐的洞）
 *
 * 上文"AST 不能证明的"清单**不含**它 —— 它是**能**证明的模块依赖，此前只是没采集。
 * `ImportTypeNode` 与 `ImportDeclaration`/`CallExpression+ImportKeyword` 都不同节点，
 * 四条旧分支全不匹配 ⇒ 只在**类型位置**出现的依赖会被静默漏过。
 * 实测漏网：`src/operators/builtin/docLifecycleOperators.ts:32` 的
 * `readonly kernel: import('@/runtime/kernelSession').KernelSession | null`。
 * 导入规则 6「类型导入同计」要求它进图，故现已采集（`kind: 'import-type'`）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/** `web/`（本文件在 `web/tests/architecture/`）。 */
export const WEB_ROOT = path.resolve(import.meta.dirname, '..', '..')
/** `web/src/` —— 生产代码根。 */
export const SRC_ROOT = path.join(WEB_ROOT, 'src')

/**
 * 一层是否算「生产代码」。
 *
 * 测试文件（`__tests__/`、`*.test.ts`、`*.spec.ts`、`*.dom.test.ts`）**不属于生产模块图**：
 * 它们可以为了断言而 import three/vue（例如 `pure/__tests__/partMask.test.ts` 用 three 做
 * 数值对照）。把它们计进边界会让「不要用 three 类型」这类规则产生大量假红。
 * 但**测试本身的边界**是可检查的（见 `TEST_ONLY_ALLOWED_*`），不在本次范围。
 */
export function isProductionFile(absPath) {
  const rel = path.relative(SRC_ROOT, absPath).replace(/[\\/]+/g, '/')
  if (rel.startsWith('..')) return false
  const parts = rel.split('/')
  if (parts.slice(0, -1).includes('__tests__')) return false
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)) return false
  if (/\.d\.ts$/.test(rel)) return false
  return true
}

/** 递归收集 `src/` 下的源文件（`.ts` / `.tsx` / `.vue` / `.mts`）。 */
export function collectSourceFiles(root = SRC_ROOT) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue
        walk(full)
      } else if (/\.(ts|tsx|mts|vue)$/.test(e.name)) {
        out.push(full)
      }
    }
  }
  walk(root)
  return out.sort()
}

/** 单条导入事实。 */
export class ImportFact {
  constructor({ fromFile, specifier, kind, isTypeOnly, line, column, syntax, root = WEB_ROOT }) {
    /** 发起导入的文件（绝对路径）。 */
    this.fromFile = fromFile
    /** 原始说明符文本（如 `vue`、`@/pure/vec`、`./x`）。 */
    this.specifier = specifier
    /** `import` | `export-from` | `dynamic-import` | `require` | `import-equals`。 */
    this.kind = kind
    /** 是否 `import type` / `export type`（导入规则 6：类型导入同样计入）。 */
    this.isTypeOnly = isTypeOnly
    /** 1-based 行号。 */
    this.line = line
    /** 1-based 列号。 */
    this.column = column
    /** 语句形态摘要（用于证据可读性）。 */
    this.syntax = syntax
    /** 用于计算 `fromRel` 的根（默认 `web/`；临时树可覆盖）。 */
    this.root = root
  }

  /** 相对 `web/`（或构造时给的 root）的路径，正斜杠。 */
  get fromRel() {
    return path.relative(this.root, this.fromFile).replace(/[\\/]+/g, '/')
  }

  /** 相对 `src/` 的路径 —— 层判定用这个（`domain/scene.ts`）。 */
  get fromSrcRel() {
    return path.relative(path.join(this.root, 'src'), this.fromFile).replace(/[\\/]+/g, '/')
  }
}

/**
 * 用 TypeScript 编译器 API 解析单个文件，抽取所有模块依赖事实。
 *
 * `.vue` 文件先剥出 `<script>` / `<script setup>` 块再解析 —— 因为 tsc 不认 SFC；
 * 剥离后的行号与原文**一致**（用等长空行占位），证据仍能对到真实行号。
 */
export function extractImports(absPath, root = WEB_ROOT) {
  const raw = fs.readFileSync(absPath, 'utf8')
  const isVue = absPath.endsWith('.vue')
  const code = isVue ? extractVueScript(raw) : raw
  const scriptKind = absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(absPath, code, ts.ScriptTarget.ES2022, true, scriptKind)

  const facts = []
  const lineOf = (node) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    return { line: line + 1, column: character + 1 }
  }

  const visit = (node) => {
    // import ... from 'x'   /   import type ... from 'x'
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const { line, column } = lineOf(node)
      facts.push(
        new ImportFact({
          fromFile: absPath,
          root,
          specifier: node.moduleSpecifier.text,
          kind: 'import',
          isTypeOnly: node.importClause?.isTypeOnly === true,
          line,
          column,
          syntax: node.getText(sf).split('\n')[0].trim(),
        }),
      )
    }
    // export ... from 'x'   /   export * from 'x'   ← barrel 转出口偷渡
    else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const { line, column } = lineOf(node)
      facts.push(
        new ImportFact({
          fromFile: absPath,
          root,
          specifier: node.moduleSpecifier.text,
          kind: 'export-from',
          isTypeOnly: node.isTypeOnly === true,
          line,
          column,
          syntax: node.getText(sf).split('\n')[0].trim(),
        }),
      )
    }
    // import x = require('y')
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expr = node.moduleReference.expression
      if (ts.isStringLiteral(expr)) {
        const { line, column } = lineOf(node)
        facts.push(
          new ImportFact({
            fromFile: absPath,
          root,
            specifier: expr.text,
            kind: 'import-equals',
            isTypeOnly: node.isTypeOnly === true,
            line,
            column,
            syntax: node.getText(sf).split('\n')[0].trim(),
          }),
        )
      }
    }
    // import('x') —— **类型位置**（`import('x').T` 作为类型引用）。
    //
    // ## 为什么要单独采集它（实测：不采集就是闸门的洞）
    //
    // `import('x').T` 在 AST 里**不是** `ImportDeclaration`，也**不是**
    // `CallExpression + ImportKeyword`（那是动态 import 表达式）——它是
    // `ImportTypeNode`。本扫描器原先四条分支全都不匹配它 ⇒ 只出现在**类型位置**
    // 的旧权威边会被**静默漏过**，闸门对该边判绿。
    //
    // 实测漏网实例：`web/src/operators/builtin/docLifecycleOperators.ts:32` 的
    // `readonly kernel: import('@/runtime/kernelSession').KernelSession | null`
    // ——旧层（`operators/`）→ 内核层（`runtime/`）的生产边，既未被边闸门判红，
    // 也未被登记进 `APPROVED_LEGACY_TO_KERNEL_EDGES`。
    //
    // 语义上它**就是**一条模块依赖：类型位置的导入同样让该模块在编译期被解析，
    // 且在 `isolatedModules` 之外与值位置导入产生同样的耦合。把它排除在采集之外
    // 等于"用类型标注绕过架构闸门"——正是导入规则 6「类型导入同计」要求的。
    //
    // ⚠️ `isTypeOnly: true`：它是**类型位置**的事实，供规则区分"值依赖"与"类型依赖"；
    // 是否判红由规则决定（本扫描器只提供事实，不自行放行）。
    else if (ts.isImportTypeNode(node)) {
      const arg = node.argument
      if (arg && ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal)) {
        const { line, column } = lineOf(node)
        facts.push(
          new ImportFact({
            fromFile: absPath,
            root,
            specifier: arg.literal.text,
            kind: 'import-type',
            isTypeOnly: true,
            line,
            column,
            syntax: node.getText(sf).split('\n')[0].trim(),
          }),
        )
      }
    }
    // import('x')  /  require('x')
    else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if (isDynamicImport || isRequire) {
        const { line, column } = lineOf(node)
        const arg = node.arguments[0]
        const literal = arg && ts.isStringLiteral(arg) ? arg.text : null
        facts.push(
          new ImportFact({
            fromFile: absPath,
          root,
            // 非字面量参数无法静态判定去向：保留原始文本作为事实，交给规则决定是否判红。
            specifier: literal ?? `«dynamic:${arg ? arg.getText(sf) : 'no-arg'}»`,
            kind: isDynamicImport ? 'dynamic-import' : 'require',
            isTypeOnly: false,
            line,
            column,
            syntax: node.getText(sf).split('\n')[0].trim(),
          }),
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return facts
}

/** 剥离 `.vue` 的 script 块，其余字符替换为等长空白以保持行号/列号不变。 */
export function extractVueScript(source) {
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi
  const ranges = []
  let m
  while ((m = re.exec(source)) !== null) {
    // m.index + m[0].indexOf(m[1]) 给出脚本内容起点
    const start = m.index + m[0].indexOf(m[1])
    ranges.push([start, start + m[1].length])
  }
  if (ranges.length === 0) return source.replace(/[^\n]/g, ' ')
  const chars = source.split('')
  const keep = new Set()
  for (const [s, e] of ranges) for (let i = s; i < e; i++) keep.add(i)
  return chars.map((c, i) => (keep.has(i) ? c : c === '\n' ? '\n' : ' ')).join('')
}

/**
 * 抽取一个文件里对**自由标识符**（未在本文件声明即被引用的名字）的引用。
 *
 * 这**不是关键词计数**：它走 AST，只匹配 `Identifier` 节点，并排除
 *  - 属性访问的**属性名**（`a.document` 里的 `document`）；
 *  - 对象字面量的键名（`{ document: 1 }`）；
 *  - 声明位置（`const document = 1`、函数/参数的声明名）；
 *  - 字符串与注释（AST 里根本不存在）。
 *
 * 诚实边界：无法识别 `globalThis['doc'+'ument']` 这类间接引用，也**不**做作用域解析
 * （局部变量重名会误报）。它只用来把"纯核心层有没有直接摸 DOM"变成一个可复核的事实，
 * 不宣称能证明运行时纯性（A01）。
 */
export function extractGlobalRefs(absPath) {
  const raw = fs.readFileSync(absPath, 'utf8')
  const isVue = absPath.endsWith('.vue')
  const code = isVue ? extractVueScript(raw) : raw
  const scriptKind = absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(absPath, code, ts.ScriptTarget.ES2022, true, scriptKind)

  const declared = new Set()
  const refs = []

  const recordDeclarations = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declared.add(node.name.text)
    else if (ts.isParameter(node) && ts.isIdentifier(node.name)) declared.add(node.name.text)
    else if (ts.isFunctionDeclaration(node) && node.name) declared.add(node.name.text)
    else if (ts.isClassDeclaration(node) && node.name) declared.add(node.name.text)
    else if (ts.isImportClause(node) && node.name) declared.add(node.name.text)
    else if (ts.isImportSpecifier(node)) declared.add(node.name.text)
    else if (ts.isNamespaceImport(node)) declared.add(node.name.text)
    else if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) declared.add(node.name.text)
    ts.forEachChild(node, recordDeclarations)
  }
  recordDeclarations(sf)

  const isMemberName = (node) => {
    const p = node.parent
    if (!p) return false
    if (ts.isPropertyAccessExpression(p) && p.name === node) return true
    if (ts.isPropertyAssignment(p) && p.name === node) return true
    if (ts.isQualifiedName(p) && p.right === node) return true
    return false
  }

  /**
   * 该 `Identifier` 是否是**声明位置的名字**（而非对自由变量的引用）。
   *
   * 补充：一个接口/类型字面量里的**成员名**也是声明，不是引用 ——
   * `readonly document: () => Result<T>` 里的 `document` 只是在描述一个成员，
   * 读它不会碰 DOM。此前只排除了属性访问与对象字面量键，于是 **新建的
   * `application/queries.ts` 被自己的 DOM 闸门判红**（`workspace.document()` 的签名）。
   * 那条 finding 是**假红**：声明位置不可能读 `document` 全局。
   *
   * 判定必须精确到"名字位"，否则会把真正危险的形态一起漏掉 ——
   * `document.body`（属性访问的**对象**侧）与裸 `document` 仍会被抓到，
   * 见 `boundary-scan-negative-control.test.ts` 的对照用例。
   */
  const isDeclaredName = (node) => {
    const p = node.parent
    if (!p) return false
    if (ts.isPropertySignature(p) && p.name === node) return true
    if (ts.isMethodSignature(p) && p.name === node) return true
    if (ts.isPropertyDeclaration(p) && p.name === node) return true
    if (ts.isMethodDeclaration(p) && p.name === node) return true
    if (ts.isGetAccessorDeclaration(p) && p.name === node) return true
    if (ts.isSetAccessorDeclaration(p) && p.name === node) return true
    if (ts.isEnumMember(p) && p.name === node) return true
    if (ts.isImportSpecifier(p) && p.propertyName === node) return true
    if (ts.isExportSpecifier(p) && (p.propertyName === node || p.name === node)) return true
    // 接口/类/类型别名的**名字**本身（`interface Document {}`）也不是引用
    if (ts.isInterfaceDeclaration(p) && p.name === node) return true
    if (ts.isTypeAliasDeclaration(p) && p.name === node) return true
    return false
  }

  const visit = (node) => {
    if (ts.isIdentifier(node) && !declared.has(node.text) && !isMemberName(node) && !isDeclaredName(node)) {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
      const p = node.parent
      refs.push({
        name: node.text,
        line: line + 1,
        column: character + 1,
        isShorthandPropertyName: !!p && ts.isShorthandPropertyAssignment(p),
        syntax: p ? p.getText(sf).split('\n')[0].trim().slice(0, 120) : node.text,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return refs
}

/** 为边界规则构建 AST 索引（当前只含自由标识符引用）。 */
export function buildAstIndex(files, webRoot = WEB_ROOT) {
  const out = []
  for (const f of files) {
    try {
      out.push({
        abs: f,
        rel: path.relative(path.join(webRoot, 'src'), f).replace(/[\\/]+/g, '/'),
        globalRefs: extractGlobalRefs(f),
      })
    } catch {
      out.push({ abs: f, rel: path.relative(path.join(webRoot, 'src'), f).replace(/[\\/]+/g, '/'), globalRefs: [] })
    }
  }
  return out
}

/**
 * 抽出某文件里对**指定方法名**的调用位（`<recv>.<method>(...)`）—— AST 级。
 *
 * ## 为什么加这个（A′）
 *
 * A′ 把 21 处裸调 `ctx.main.replaceDoc(...)` 收口成 `Context.setDocument`，
 * 并要求闸门**机械拒绝绕过**。而"绕过"的判据是"生产里还有谁调 `.replaceDoc(`"，
 * 那是一个**调用位**事实 —— `extractImports`/`extractGlobalRefs` 都答不了。
 *
 * ## 为什么必须 AST 而不是正则（本仓已两次实测的教训）
 *
 * 正则版要么把**注释里**的记录算成调用（实测：`documentLoad.ts:15`、
 * `contentIdentity.ts:6`、`invalidationPlan.ts:7` 三处文档注释提到
 * `Main.replaceDoc()`，还有 `context.ts` 自己解释本设计的注释），
 * 要么被字符串绕开。本文件已有的 `extractGlobalRefs` 逐字记录了同一取舍：
 * 「关键词计数只能作补充」。
 *
 * ## 判据口径
 *
 * 只认 `PropertyAccessExpression` 且 `name.text === methodName` 的**调用**
 * （即 `.method(` 形态）。因此：
 *  - 定义位（`replaceDoc(doc): void {}`，无点号）**不**命中 —— 那是类成员声明；
 *  - 注释与字符串**不**命中；
 *  - `this.ctx.main.replaceDoc(x)` 与 `ctx.main.replaceDoc(x)` 都命中（接收者不限）。
 *
 * @returns `{ line, text }[]`（`line` 为 1 基）；`.vue` 只扫 `<script>` 段。
 */
export function extractMethodCallSites(absPath, methodName) {
  const raw = fs.readFileSync(absPath, 'utf8')
  const isVue = absPath.endsWith('.vue')
  const code = isVue ? extractVueScript(raw) : raw
  const scriptKind = absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(absPath, code, ts.ScriptTarget.ES2022, true, scriptKind)
  const out = []
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === methodName
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
      out.push({ line: line + 1, text: code.split('\n')[line].trim() })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** 扫描整个 `src/`，返回导入事实与文件清单。 */
export function buildModuleGraph(root = SRC_ROOT) {  const files = collectSourceFiles(root)
  // `fromRel` 以**扫描根的上一级**（即 `web/`）为基准，于是临时树与真实树
  // 产出同形的相对路径（`src/domain/scene.ts`），规则与测试可共用。
  const webRoot = path.dirname(root)
  const facts = []
  for (const f of files) {
    try {
      facts.push(...extractImports(f, webRoot))
    } catch (err) {
      facts.push(
        new ImportFact({
          fromFile: f,
          root: webRoot,
          specifier: `«parse-error:${err && err.message}»`,
          kind: 'parse-error',
          isTypeOnly: false,
          line: 0,
          column: 0,
          syntax: '(parse failed)',
        }),
      )
    }
  }
  return { files, facts }
}
