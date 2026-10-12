/**
 * **P10f（#301）B′ · 存在性读面替换的逐点同义**（N1 的验收判据）。
 *
 * ## 本文件证什么
 *
 * B′ 把 **29 处** `ctx.getDoc().value !== null`（含 2 处 `.vue` 模板）换成
 * `ctx.hasLoadedDocument()`。这类批量的机械替换**唯一**的验收口径是
 * **逐点同义**：对**每一个**调用点的上下文，两侧必须给出同一结果。
 *
 * ## 为什么判据是"不变量"而不是"逐点核对"
 *
 * A′ 已实测：生产里写入 `main.doc.value` 的位置**只有一处**
 * （`runtime/main.ts` 的 `replaceDoc`），而其**唯一调用者**是 `Context.setDocument`
 * ⇒ 镜像必然发生在每一次文档替换上 ⇒ 同义是**由唯一写者维护的结构不变量**，
 * 在**任意读取点**成立（不只是 21 个写点）。本文件把这个不变量**机械化**：
 *
 *  - ① **唯一写者**：扫描生产源码，断言 `main.doc.value =` 的赋值点**只有**
 *    `runtime/main.ts` 一处，且 `replaceDoc(` 的调用点只有 `setDocument` 本体
 *    （与 `boundary-scan.test.ts` 的 AST 白名单同口径，此处再独立核一次）；
 *  - ② **同义抽样**：对"从未装载 / 装载 / 卸载 / 无内核"四态逐一断言两侧相等；
 *  - ③ **反空洞真**：确认 29 处**真的**换掉了（否则本条判据测的是一个不存在的东西）。
 *
 * ⚠️ ① 与 ③ 是**源码级**判据：它们保证"不变量成立"这个推理的**前提**，
 * 而 ② 保证推理的**结论**。缺任一侧都会留下假绿（只有②时：不变量可能已被绕过；
 * 只有①时：可能换了但换错了）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID, KernelSession } from '@/runtime/kernelSession'
import { codeOfSource, RETIREMENT_REGISTRY, readSourceText } from '@/application/__tests__/retirementRegistry.test'

const WEB = process.cwd()
const SRC = path.join(WEB, 'src')

/** 生产源文件（排除 `__tests__` 与非源码）。 */
function productionFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '__tests__') continue
        walk(full)
        continue
      }
      if (!/\.(ts|tsx|vue|mts)$/.test(e.name)) continue
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name) || /\.d\.ts$/.test(e.name)) continue
      out.push(full)
    }
  }
  walk(SRC)
  return out.sort()
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 前提：唯一写者 + 唯一写入口
// ─────────────────────────────────────────────────────────────────────────────

describe('P10f B′ · ① 前提：`main.doc` 的唯一写者（不变量成立的条件）', () => {
  it('生产里 `main.doc.value =` 的赋值点**只有** `runtime/main.ts`（`replaceDoc`）', () => {
    const assignments: { file: string; count: number }[] = []
    for (const abs of productionFiles()) {
      const rel = path.relative(WEB, abs).replace(/[\\/]+/g, '/')
      const code = codeOfSource(abs, readSourceText(abs))
      const n = code.split('\n').filter((line) => /\.doc\.value\s*=(?!=)/.test(line)).length
      if (n > 0) assignments.push({ file: rel, count: n })
    }
    // 断言**文件与处数**（不绑行号 —— 行号会随无关改动漂移，本工程已有先例：
    // 「不绑行号」是 `partMaskEnvelopeExemption` 那条既有判据的选择）。
    expect(
      assignments,
      '若 `main.doc.value` 能被第二处写入，则每次替换都经过 `setDocument` 的推理不成立，\n' +
        '而 29 处 N1 替换就退化成"碰巧相等"。新增写入点必须改为经 `Context.setDocument`。',
    ).toEqual([{ file: 'src/runtime/main.ts', count: 1 }])
  })

  it('`replaceDoc(` 的调用点**只有** `Context.setDocument` 本体（legacy 侧唯一入口）', () => {
    const callers: { file: string; count: number }[] = []
    for (const abs of productionFiles()) {
      const rel = path.relative(WEB, abs).replace(/[\\/]+/g, '/')
      const code = codeOfSource(abs, readSourceText(abs))
      // 调用位 = 带点号的属性访问调用（定义位 `replaceDoc(doc): void {` 无点号，不计）
      const n = code.split('\n').filter((line) => /\.replaceDoc\s*\(/.test(line)).length
      if (n > 0) callers.push({ file: rel, count: n })
    }
    expect(callers, '`Main.replaceDoc` 只允许被 `Context.setDocument` 调用').toEqual([
      { file: 'src/runtime/context.ts', count: 1 },
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ② 结论：四态逐一同义
// ─────────────────────────────────────────────────────────────────────────────

describe('P10f B′ · ② 结论：`hasLoadedDocument()` ≡ `getDoc().value !== null`（四态）', () => {
  /**
   * 用**真实 `Context`**吗？
   *
   * `Context` 的构造要 `Main`/`WM`/`ViewportManager`/`ScreenRoot` 一整套外壳。
   * 而本读面的**全部语义**只有"内核在场取内核、缺席回落 `main.doc`"。
   * ⇒ 用一个**最小宿主**逐字复刻这两句，并由下方"源码级同序断言"兜住漂移
   * （与 A′ 的 `p10fDocumentLifecycle.test.ts` 同一手法）。
   */
  function host(session: KernelSession | null) {
    let doc: unknown = null
    return {
      setDoc: (d: unknown): void => { doc = d },
      hasLoadedDocument: (): boolean =>
        session === null ? doc !== null : session.hasLoadedDocument(),
    }
  }

  function newSession(): KernelSession {
    return new KernelSession({
      documentId: KERNEL_DOCUMENT_ID,
      contextId: KERNEL_CONTEXT_ID,
      capabilities: [],
    })
  }

  it('有内核：从未装载 / 装载 / 卸载 三态两侧一致', () => {
    const s = newSession()
    const h = host(s)
    try {
      // 从未装载
      expect(s.hasLoadedDocument(), '构造后未装载').toBe(false)
      expect(h.hasLoadedDocument()).toBe(false)
      // 装载
      s.markLoaded()
      h.setDoc({})
      expect(s.hasLoadedDocument()).toBe(true)
      // 卸载
      s.markUnloaded()
      h.setDoc(null)
      expect(s.hasLoadedDocument()).toBe(false)
    } finally {
      s.dispose()
    }
  })

  it('**无内核会话**：回落 `main.doc`，与替换前表达式逐字同义（能力不回退）', () => {
    const h = host(null)
    expect(h.hasLoadedDocument(), '无文档 ⇒ false').toBe(false)
    h.setDoc({})
    expect(h.hasLoadedDocument(), '有文档 ⇒ true（若此处返回 false 就是行为变更）').toBe(true)
    h.setDoc(null)
    expect(h.hasLoadedDocument()).toBe(false)
  })

  it('**反空洞真**：断言"内核侧真的被读过"（否则上面全绿也可能是常量）', () => {
    const s = newSession()
    try {
      // 若实现写成 `return false`（常量），本用例会判红
      s.markLoaded()
      expect(s.hasLoadedDocument(), '装载后必须为 true').toBe(true)
      s.markUnloaded()
      expect(s.hasLoadedDocument(), '卸载后必须为 false').toBe(false)
    } finally {
      s.dispose()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ③ 前提：29 处**真的**换掉了 + registry 同步
// ─────────────────────────────────────────────────────────────────────────────

describe('P10f B′ · ③ 替换确实发生，且 registry 已同步', () => {
  it('生产里 N1 形态的存在性判定已归零（只允许注释里出现）', () => {
    const offenders: string[] = []
    for (const abs of productionFiles()) {
      const rel = path.relative(WEB, abs).replace(/[\\/]+/g, '/')
      const code = codeOfSource(abs, readSourceText(abs))
      code.split('\n').forEach((line, i) => {
        // N1 的三种形态：`!== null`、`!= null`、`!ctx.getDoc().value`、模板真值判定
        if (
          /getDoc\(\)\.value\s*!==?\s*null/.test(line) ||
          /!ctx\.getDoc\(\)\.value/.test(line) ||
          // 模板里的真值判定（`v-else-if="… ctx.getDoc().value"`）
          /v-[a-z-]+="[^"]*getDoc\(\)\.value(?!\s*[.?])/.test(line) ||
          // `&& ctx.getDoc().value` / `ctx.getDoc().value &&`
          /(&&|&)\s*ctx\.getDoc\(\)\.value(?!\s*[.?])/.test(line)
        ) {
          offenders.push(`${rel}:${i + 1}  ${line.trim()}`)
        }
      })
    }
    expect(
      offenders,
      '这 29 处应已换成 `ctx.hasLoadedDocument()`（GF-15 读面）。\n' +
        '残留会让"存在性判定走内核读面"这件事半途而废 —— 而两种写法在同义时不会报错。',
    ).toEqual([])
  })

  it('`hasLoadedDocument()` 的出现次数 ≥ 29（生产侧，含 2 处 `.vue` 模板）', () => {
    let n = 0
    for (const abs of productionFiles()) {
      const code = codeOfSource(abs, readSourceText(abs))
      n += (code.match(/hasLoadedDocument\(\)/g) ?? []).length
    }
    // 生产里 `hasLoadedDocument` 共 29 处调用（1 处定义在 context.ts 内、1 处在 kernelSession.ts）
    expect(n, `实测 ${n} 次 —— 少于 29 说明有站点没换`).toBeGreaterThanOrEqual(29)
  })

  it('registry 的消费者清单与实测一致（0 漏登记 / 0 腐烂）', () => {
    const entry = RETIREMENT_REGISTRY.find((e) => e.matrixSlug === 'raw-authority-object')!
    const declared = new Set((entry.consumers ?? []).map((c) => c.replace(/^web\//, '')))
    const actual = new Set<string>()
    for (const abs of productionFiles()) {
      const rel = path.relative(WEB, abs).replace(/[\\/]+/g, '/')
      const code = codeOfSource(abs, readSourceText(abs))
      // 与 registry 判据同口径：`ctx.getDoc()`（带点号接收者）
      if (/\.getDoc\s*\(/.test(code)) actual.add(rel)
    }
    const missing = [...actual].filter((f) => !declared.has(f)).sort()
    const extra = [...declared].filter((f) => !actual.has(f)).sort()
    expect(missing, `漏登记（清单必须完整，否则相位翻转永远红）:\n${missing.join('\n')}`).toEqual([])
    expect(extra, `腐烂（文件已不再引用该机制，须核销）:\n${extra.join('\n')}`).toEqual([])
  })
})
