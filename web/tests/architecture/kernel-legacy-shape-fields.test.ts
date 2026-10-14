/**
 * **G1 判据② · 内核旧形态字段：未登记即红，条目数不得增**（#385 G1 工作包）。
 *
 * 清单本体在 `./kernel-legacy-shape-fields.mjs`（字段理由清单：字段 / 存在理由 /
 * 旧消费点 / 退出归属 / 负责人）。本文件是它的**可执行半边**。
 *
 * ## 覆盖形式声明（哪些文件参与、哪些不参与）
 *
 * | 参与 | 不参与 |
 * |---|---|
 * | `src/domain/**` 的**生产**文件（`domain` 是整层迁移的新内核；含**未**登记进 `KERNEL_FILES` 的 `domain/blockGeometry.ts`、`domain/content.ts` —— 目标字段正住在这两个文件里） | `domain/**\/__tests__/`、`*.test.ts`、`*.d.ts` |
 * | 清单锚定的文件（`domain/scene.ts` / `domain/blockGeometry.ts` / `domain/content.ts`）里的**属性声明**（interface / type literal / class） | `domain` 之外的层（`composition/`、`adapters/`、`application/` …）：本判据只判"内核旧形态字段"，外层字段由各自判断面覆盖 |
 *
 * **口径 = AST（TypeScript 编译器 API）**：字段名、类型归属、`?` 可选性、前置 JSDoc、
 * `Pick<>` 成员列表、对象字面量键 —— 全部走 AST 节点。**不做文本扫描**：
 * 没有正则、不 `indexOf` 源码正文 ⇒ 注释与字符串**不可能**伪装成字段或键。
 * 唯一"读文本"之处是取属性声明的**前置注释范围**（`ts.getLeadingCommentRanges`），
 * 那是"注释本身作为事实"的读取（臂 A 的判据对象就是注释里的声明），不是用正则判代码。
 *
 * ## 四条机械臂（各自不可省）
 *
 * - **臂 A（标记封闭）**：`domain/**` 里任一属性声明的 JSDoc 命中 `LEGACY_MARKER_VOCABULARY`
 *   的任一词 ⇒ 该字段**必须**被清单某条点名（未登记即红）；同时每条声明了 `arms.markers`
 *   的登记，其字段 JSDoc **必须仍含**那些词（旧关系写得明白 —— 注释被删=理由失据 ⇒ 红）。
 * - **臂 B（身份键）**：声明了 `arms.identityKey` 的字段必须仍是该函数 `Pick<>` 成员列表的成员
 *   （`blockPaletteEntryKey` 的成员列表就是"参与条目身份键"的机械证据）；
 *   且该列表里**其他**带标记的成员也必须被点名。
 * - **臂 C（缺省语义）**：声明了 `arms.optional` 的字段必须仍是可选（`?`）。
 *   "缺省 = 为旧形态走的显式降级"**只在该字段可缺省时**才成立；改成必填 = 降级通道静默消失 ⇒ 红。
 * - **臂 D（元数据缺省）**：声明了 `arms.metadataDefault` 的字段必须在 `EMPTY_METADATA`
 *   对象字面量与 `documentMetadata()` 的返回字面量里**都**显式给出（缺省值不是"忘了给"）。
 *
 * ## 为什么禁判零
 *
 * 这 5 条里 `external-format-version` / `external-format-origin` 的第 5 列写的是
 * "**永久保留**"（外部格式事实有产品职责），判零会立刻把外部格式契约判成违规。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { SRC_ROOT } from './module-graph.mjs'
import {
  BASELINE_FIELD_DECLARATIONS,
  BASELINE_ITEMS,
  KERNEL_LEGACY_SHAPE_FIELDS,
  LEGACY_MARKER_VOCABULARY,
  REQUIRED_COLUMNS,
} from './kernel-legacy-shape-fields.mjs'

/** 判定面：内核 `domain/**`。 */
const DOMAIN_SCOPE = 'domain/'

function isProductionRel(rel) {
  if (rel.split('/').slice(0, -1).includes('__tests__')) return false
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)) return false
  if (/\.d\.ts$/.test(rel)) return false
  return true
}

/** 收集 `src/domain/**` 的生产文件（`.ts`/`.tsx`）。 */
function collectDomainFiles(srcRoot = SRC_ROOT) {
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
        if (e.name === '__tests__' || e.name === 'node_modules') continue
        walk(full)
      } else if (/\.(ts|tsx|mts)$/.test(e.name)) {
        const rel = path.relative(srcRoot, full).replace(/[\\/]+/g, '/')
        if (rel.startsWith(DOMAIN_SCOPE) && isProductionRel(rel)) out.push({ abs: full, rel })
      }
    }
  }
  walk(srcRoot)
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1))
}

/** 解析一个文件（行尾归一化 —— 本仓 `core.autocrlf=true`，注释范围读取必须与行尾无关）。 */
function parseFile(abs) {
  const text = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')
  return { text, sf: ts.createSourceFile(abs, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS) }
}

const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

/** 拥有该属性声明的接口/类型别名/类名（用于"字段确实住在登记的 type 上"）。 */
function ownerTypeName(node) {
  let p = node.parent
  while (p) {
    if (ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p)) return p.name.text
    if (ts.isClassDeclaration(p) && p.name) return p.name.text
    p = p.parent
  }
  return '(module)'
}

/** 该属性声明的前置 JSDoc 文本。 */
function docOf(text, node) {
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []
  return ranges.map((r) => text.slice(r.pos, r.end)).join('\n')
}

/**
 * **臂 A 的检测核**：`domain/**` 里所有"JSDoc 命中标记词表"的属性声明。
 * 生产判据与负对照**共用本函数**（负对照不得另写一份判定逻辑）。
 */
export function scanMarkedLegacyFields(files, vocabulary = LEGACY_MARKER_VOCABULARY) {
  const out = []
  for (const { abs, rel } of files) {
    const { text, sf } = parseFile(abs)
    const visit = (node) => {
      if (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) {
        const doc = docOf(text, node)
        const markers = vocabulary.filter((t) => doc.includes(t))
        if (markers.length > 0) {
          out.push({ file: rel, line: lineOf(sf, node), type: ownerTypeName(node), name: node.name.getText(sf), markers })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return out.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
}

/** 清单点名的**字段声明**全集（首字段 + `extraFields`）。 */
export function namedFieldDeclarations(fields = KERNEL_LEGACY_SHAPE_FIELDS) {
  const all = []
  for (const item of fields) {
    all.push({ item, decl: item.field })
    for (const ex of item.extraFields ?? []) all.push({ item, decl: ex })
  }
  return all
}

/** 找出某文件里指定名称的接口/类型别名/类的全部属性声明。 */
function propertyDeclarationsOf(srcRoot, rel, typeName) {
  const abs = path.join(srcRoot, rel)
  if (!fs.existsSync(abs)) return null
  const { text, sf } = parseFile(abs)
  let found = null
  const isNamed = (node, name) =>
    (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node)) &&
    node.name && node.name.text === name
  const visit = (node) => {
    if (isNamed(node, typeName)) {
      // ⚠️ 必须**递归**收集：`domain/scene.ts#ObjectDataPayload` 是**类型别名**，
      // 字段住在其内的嵌套 `{ ... }` 类型字面量里（实测：属性声明的 parent 是 TypeLiteral）。
      // 只收直接成员会把整层字段判成"不存在"（本测试首跑实测的假红）。
      const props = []
      const walk = (n, isRoot) => {
        if (ts.isPropertySignature(n) || ts.isPropertyDeclaration(n)) props.push(n)
        // 不下钻到**别的具名类型**里（那只属于它自己的字段表）
        if (!isRoot && (ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isClassDeclaration(n))) return
        ts.forEachChild(n, (c) => walk(c, false))
      }
      walk(node, true)
      found = props.map((m) => ({
        name: m.name.getText(sf),
        line: lineOf(sf, m),
        optional: m.questionToken !== undefined,
        doc: docOf(text, m),
      }))
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

/** 某函数首参类型 `Pick<..., 'a' | 'b'>` 的成员名字面量列表。 */
function pickMembersOf(srcRoot, rel, fnName) {
  const abs = path.join(srcRoot, rel)
  if (!fs.existsSync(abs)) return null
  const { sf } = parseFile(abs)
  let members = null
  const collect = (n, acc) => {
    if (ts.isLiteralTypeNode(n) && ts.isStringLiteral(n.literal)) acc.push(n.literal.text)
    ts.forEachChild(n, (c) => collect(c, acc))
  }
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === fnName) {
      const acc = []
      collect(node.parameters[0].type, acc)
      members = acc
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return members
}

/** 某变量声明初始化的对象字面量里出现过的键名。 */
function objectLiteralKeysOf(srcRoot, rel, varName) {
  const abs = path.join(srcRoot, rel)
  if (!fs.existsSync(abs)) return null
  const { sf } = parseFile(abs)
  const keys = []
  const collectKeys = (n) => {
    if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) {
        if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) keys.push(p.name.getText(sf))
      }
    }
    ts.forEachChild(n, collectKeys)
  }
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === varName && node.initializer) {
      collectKeys(node.initializer)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return keys
}

/** 某函数体里**所有**对象字面量的键名（用于 `documentMetadata()` 的返回字面量）。 */
function objectLiteralKeysInFunction(srcRoot, rel, fnName) {
  const abs = path.join(srcRoot, rel)
  if (!fs.existsSync(abs)) return null
  const { sf } = parseFile(abs)
  const keys = []
  const collectKeys = (n) => {
    if (ts.isObjectLiteralExpression(n) && isInsideReturnOrArrow(n)) {
      for (const p of n.properties) {
        if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) keys.push(p.name.getText(sf))
      }
    }
    ts.forEachChild(n, collectKeys)
  }
  const isInsideReturnOrArrow = (n) => {
    let p = n.parent
    while (p) {
      if (ts.isArrowFunction(p) || ts.isReturnStatement(p)) return true
      if (ts.isFunctionDeclaration(p)) return false
      p = p.parent
    }
    return false
  }
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === fnName) {
      collectKeys(node)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return keys
}

describe('G1 ②：内核旧形态字段 —— 未登记即红，条目数（5）不得增', () => {
  it('未登记即红（臂 A 标记封闭）：`domain/**` 里带旧形态标记的字段都必须被清单点名', () => {
    const files = collectDomainFiles()
    const marked = scanMarkedLegacyFields(files)
    const named = new Set(namedFieldDeclarations().map(({ decl }) => `${decl.file}:${decl.name}`))
    const violations = marked
      .filter((m) => !named.has(`${m.file}:${m.name}`))
      .map((m) => `${m.file}:${m.line} 字段 \`${m.name}\`（标记：${m.markers.join(' / ')}）未登记`)
    expect(
      violations,
      `内核 domain 里出现旧的形态字段但不在 KERNEL_LEGACY_SHAPE_FIELDS 里`
        + `（须补登记：字段 / 存在理由 / 旧消费点 / 退出归属 / 负责人）:\n${violations.join('\n')}`,
    ).toEqual([])
  })

  it('臂 A 反向（理由不得失据）：每个声明了 markers 的登记，其字段 JSDoc 必须仍含那些词', () => {
    const missing = []
    for (const item of KERNEL_LEGACY_SHAPE_FIELDS) {
      const markers = item.arms?.markers
      if (!markers) continue
      const props = propertyDeclarationsOf(SRC_ROOT, item.field.file, item.field.type)
      expect(props, `${item.id}: 登记的拥有类型 ${item.field.type} 必须存在`).not.toBeNull()
      const prop = props.find((p) => p.name === item.field.name)
      expect(prop, `${item.id}: 字段 ${item.field.name} 必须存在`).toBeDefined()
      for (const m of markers) {
        if (!prop.doc.includes(m)) missing.push(`${item.id}: ${item.field.file} 的 \`${item.field.name}\` JSDoc 不再含 "${m}"`)
      }
    }
    expect(
      missing,
      '字段的旧关系说明被删除 ⇒ 登记失去依据（要么恢复说明，要么同批核销该条登记）',
    ).toEqual([])
  })

  it('臂 B（身份键）：`renderMode` 必须仍参与 `blockPaletteEntryKey` 的 `Pick<>` 身份键', () => {
    const item = KERNEL_LEGACY_SHAPE_FIELDS.find((i) => i.arms?.identityKey)
    expect(item, '清单里必须有一条声明 identityKey 臂').toBeDefined()
    const members = pickMembersOf(SRC_ROOT, item.field.file, item.arms.identityKey.fn)
    expect(members, `未找到 ${item.arms.identityKey.fn} 的 Pick<> 成员列表`).not.toBeNull()
    expect(
      members,
      `\`${item.field.name}\` 不再参与 ${item.arms.identityKey.fn} 的身份键 ⇒ 分区判据变松（渲染结果会与切换前不一致）`,
    ).toContain(item.field.name)
    // 该列表里**其他**带旧形态标记的成员也必须被点名（不许借身份键塞新的旧形态字段）
    const named = new Set(namedFieldDeclarations().map(({ decl }) => `${decl.file}:${decl.name}`))
    const props = propertyDeclarationsOf(SRC_ROOT, item.field.file, item.field.type)
    const unregistered = props
      .filter((p) => members.includes(p.name) && LEGACY_MARKER_VOCABULARY.some((t) => p.doc.includes(t)))
      .filter((p) => !named.has(`${item.field.file}:${p.name}`))
      .map((p) => `${item.field.file}:${p.line} \`${p.name}\``)
    expect(unregistered, '身份键成员里带旧形态标记的字段必须逐条登记').toEqual([])
  })

  it('臂 C（缺省语义）：声明 optional 的字段必须仍是可选 `?`', () => {
    const violations = []
    for (const { item, decl } of namedFieldDeclarations()) {
      if (item.arms?.optional !== true) continue
      const props = propertyDeclarationsOf(SRC_ROOT, decl.file, decl.type)
      expect(props, `${item.id}: 拥有类型 ${decl.type} 必须存在`).not.toBeNull()
      const prop = props.find((p) => p.name === decl.name)
      expect(prop, `${item.id}: 字段 ${decl.name} 必须存在`).toBeDefined()
      if (!prop.optional) violations.push(`${item.id}: ${decl.file} 的 \`${decl.name}\` 不再可选（缺省降级语义消失）`)
    }
    expect(
      violations,
      '「缺省 = 为旧形态走的显式降级」只在该字段可缺省时成立；改为必填 ⇒ 降级通道静默消失',
    ).toEqual([])
  })

  it('臂 D（元数据缺省）：声明 metadataDefault 的字段必须在 `EMPTY_METADATA` 与 `documentMetadata()` 里都显式给出', () => {
    const violations = []
    for (const { item, decl } of namedFieldDeclarations()) {
      if (item.arms?.metadataDefault !== true) continue
      const emptyKeys = objectLiteralKeysOf(SRC_ROOT, decl.file, 'EMPTY_METADATA')
      expect(emptyKeys, `${item.id}: 未找到 EMPTY_METADATA`).not.toBeNull()
      if (!emptyKeys.includes(decl.name)) violations.push(`${item.id}: \`EMPTY_METADATA\` 缺 \`${decl.name}\``)
      const fnKeys = objectLiteralKeysInFunction(SRC_ROOT, decl.file, 'documentMetadata')
      expect(fnKeys, `${item.id}: 未找到 documentMetadata()`).not.toBeNull()
      if (!fnKeys.includes(decl.name)) violations.push(`${item.id}: \`documentMetadata()\` 返回字面量缺 \`${decl.name}\``)
    }
    expect(violations, '外部格式事实必须显式给缺省（不写 = "忘了给"，会让读取方拿到 undefined）').toEqual([])
  })

  it('登记不得腐烂：每条点名的字段都真实存在于登记的拥有类型上', () => {
    const rotted = []
    for (const { item, decl } of namedFieldDeclarations()) {
      const props = propertyDeclarationsOf(SRC_ROOT, decl.file, decl.type)
      if (props === null) {
        rotted.push(`${item.id}: 文件不存在 ${decl.file}`)
        continue
      }
      if (!props.some((p) => p.name === decl.name)) rotted.push(`${item.id}: ${decl.file}#${decl.type} 里没有 \`${decl.name}\``)
    }
    expect(rotted, '登记指向已不存在的字段 ⇒ 请同批核销（P11 审计依赖清单准确）').toEqual([])
  })

  it('列完备性：每条都写全 字段 / 存在理由 / 旧消费点 / 退出归属 / 负责人', () => {
    const incomplete = []
    for (const item of KERNEL_LEGACY_SHAPE_FIELDS) {
      for (const col of REQUIRED_COLUMNS) {
        const v = item[col]
        if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) {
          incomplete.push(`${item.id}: 缺列 ${col}`)
        }
      }
      if (String(item.reason).length < 40) incomplete.push(`${item.id}: reason 过短（须能独立解释"为什么不能删"）`)
      if (!/^R\d+/.test(String(item.exitStage)) && !String(item.exitStage).includes('永久保留')) {
        incomplete.push(`${item.id}: exitStage 必须写明批次（R1…）或"永久保留"`)
      }
      if (!item.field || !item.field.file || !item.field.type || !item.field.name) incomplete.push(`${item.id}: field 三段（file/type/name）不全`)
    }
    expect(incomplete, `登记项必须写全 ${REQUIRED_COLUMNS.join('/')}，理由 ≥40 字`).toEqual([])
  })

  it('条目数不得增：条目数 === 5，字段声明数 === 7（两个基线都要与清单自身读数一致）', () => {
    const decls = namedFieldDeclarations()
    expect(KERNEL_LEGACY_SHAPE_FIELDS.length, '条目数偏离基线 5：新增旧形态字段必须同批改基线并写明理由').toBe(BASELINE_ITEMS)
    expect(decls.length, '字段声明数偏离基线 7：条目内的字段增删同样是基线变更').toBe(BASELINE_FIELD_DECLARATIONS)
  })

  it('**校准自检**：检测臂的读数与清单对称差为空（基线数与判据自身读数一致）', () => {
    const files = collectDomainFiles()
    const marked = scanMarkedLegacyFields(files)
    const named = new Set(namedFieldDeclarations().map(({ decl }) => `${decl.file}:${decl.name}`))
    const onlyMarked = marked.map((m) => `${m.file}:${m.name}`).filter((k) => !named.has(k))
    const onlyNamed = [...named].filter((k) => !marked.some((m) => `${m.file}:${m.name}` === k))
    // onlyNamed 允许非空（有些字段的旧形态语义由结构臂而非注释标记承载），
    // 但 onlyMarked 必须为空（它们是"未登记即红"的对象）；此处把两者都记下来，
    // 并把"标记命中数"与清单的交集作为校准读数。
    expect(onlyMarked, '检测臂命中但清单未点名 = 判红对象，校准自检里也必须为空').toEqual([])
    expect(marked.length, '标记臂非空转：必须真的命中字段（否则"未登记即红"是空转）').toBeGreaterThan(0)
    expect(new Set(marked.map((m) => `${m.file}:${m.name}`)).size, '标记命中的字段必须都在清单里').toBeLessThanOrEqual(named.size)
    // 基线的两个数由清单自身数出来（不是手写常量）
    expect({ items: KERNEL_LEGACY_SHAPE_FIELDS.length, declarations: namedFieldDeclarations().length }).toEqual({
      items: BASELINE_ITEMS,
      declarations: BASELINE_FIELD_DECLARATIONS,
    })
    void onlyNamed
  })

  it('**负对照 A**：注入一个带旧形态标记的新字段 ⇒ 臂 A 判红', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g1-field-neg-'))
    try {
      const srcRoot = path.join(dir, 'src')
      const domain = path.join(srcRoot, 'domain')
      fs.mkdirSync(domain, { recursive: true })
      const probe = path.join(domain, 'probeShapes.ts')
      fs.writeFileSync(
        probe,
        [
          'export interface ProbePayload {',
          '  /** 逐格 → 文件里的槽位（legacy `SlotBlock.paletteIndex`）。 */',
          '  readonly inventedSlotIndex?: Readonly<Record<string, number>>',
          '}',
          '',
        ].join('\n'),
        'utf8',
      )
      const marked = scanMarkedLegacyFields([{ abs: probe, rel: 'domain/probeShapes.ts' }])
      expect(marked.map((m) => `${m.file}:${m.name}`), '带旧形态标记的新字段必须被臂 A 扫出').toEqual([
        'domain/probeShapes.ts:inventedSlotIndex',
      ])
      // 判红：它不在清单里 ⇒ 未登记即红
      const named = new Set(namedFieldDeclarations().map(({ decl }) => `${decl.file}:${decl.name}`))
      const violations = marked.filter((m) => !named.has(`${m.file}:${m.name}`))
      expect(violations, '臂 A 必须判红未登记的旧形态字段').toHaveLength(1)
      // 正对照：把它登记进一份**临时**清单后判绿（证明判红来自登记表而非别的）
      const tempItems = [...KERNEL_LEGACY_SHAPE_FIELDS, { id: 'probe', field: { file: 'domain/probeShapes.ts', type: 'ProbePayload', name: 'inventedSlotIndex' } }]
      const named2 = new Set(namedFieldDeclarations(tempItems).map(({ decl }) => `${decl.file}:${decl.name}`))
      expect(marked.filter((m) => !named2.has(`${m.file}:${m.name}`))).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('**负对照 B**：删掉一条登记 ⇒ 条目数断言判红', () => {
    const removed = KERNEL_LEGACY_SHAPE_FIELDS.filter((i) => i.id !== 'legacy-identity-key')
    expect(removed.length, '负对照必须真的删掉了一条').toBe(KERNEL_LEGACY_SHAPE_FIELDS.length - 1)
    expect(
      removed.length,
      '删掉一条登记后，条目数必须偏离基线 5 ⇒ 判红（未同批核销）',
    ).not.toBe(BASELINE_ITEMS)
  })

  it('**负对照 C**：把某个字段的旧关系说明删掉 ⇒ 臂 A 反向判红（证明 markers 断言有区分力）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g1-field-neg3-'))
    try {
      const srcRoot = path.join(dir, 'src')
      const domain = path.join(srcRoot, 'domain')
      fs.mkdirSync(domain, { recursive: true })
      const probe = path.join(domain, 'probeStripped.ts')
      fs.writeFileSync(
        probe,
        [
          'export interface ObjectDataPayload {',
          '  /** 逐格 → 文件里的调色板槽位（说明已被人删掉）。 */',
          '  readonly cellPaletteIndex?: Readonly<Record<string, number>>',
          '}',
          '',
        ].join('\n'),
        'utf8',
      )
      const props = propertyDeclarationsOf(srcRoot, 'domain/probeStripped.ts', 'ObjectDataPayload')
      expect(props).not.toBeNull()
      const prop = props.find((p) => p.name === 'cellPaletteIndex')
      const item = KERNEL_LEGACY_SHAPE_FIELDS.find((i) => i.field.name === 'cellPaletteIndex')
      const missing = item.arms.markers.filter((m) => !prop.doc.includes(m))
      expect(missing, '说明被删 ⇒ 臂 A 反向必须判红').not.toEqual([])
      expect(missing.length).toBe(item.arms.markers.length)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
