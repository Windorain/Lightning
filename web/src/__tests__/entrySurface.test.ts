/**
 * **库入口的公共面契约**（P10 #261 收口 P9 G-5）。
 *
 * ## P9 登记的缺口原文
 *
 * > G-5 | `main.ts` 的 15 个公共导出未接线（能力已实现） | #261（entries 重写）
 *
 * ## "未接线"的准确含义（本文件把它变成可执行的判据）
 *
 * `src/main.ts` 是**嵌入库（IIFE）的公共入口** —— 它的导出是**对外契约**：
 * 灰机 Wiki gadget / 宿主页 `require` 之后拿到的就是这些名字。P9 登记的不是
 * "这些函数没实现"（它们都实现了，且各有单测），而是**入口面本身没有守卫**：
 *
 *  1. 没有任何测试断言这些名字**仍可导出**（改名/漏导出会静默破坏对外契约）；
 *  2. 没有任何测试断言它们是**真实现**而不是占位（#249 §13 禁止空接口）；
 *  3. 没有任何测试断言入口**不泄漏**内部实现（把 `RuntimeDocument`、
 *     `EditorClient` 一类核心类型挂到公共面上，会让外部消费者绕过受控边界）。
 *
 * 三条都是"能力已实现但未接线到证据"的形态 —— 与 #249 §13「不允许暴露
 * 假成功控件或空接口」同一族。本文件把入口面钉成契约。
 *
 * ## 为什么断言的是**名字集合**而不是逐个调用
 *
 * 逐个调用需要 Three/WebGL/DOM（`mount()` 要挂 DOM、`resolveRenderBundle` 要真文档）。
 * 那会让本文件变成 e2e 的劣化复制品。而 G-5 的缺口是**契约面**（谁在公共面上），
 * 不是"每个函数的运行时行为"（那由各自单测与 e2e 覆盖）。
 * ⇒ 本文件断言"公共面恰好是这些名字"，并**抽查**几个可安全调用的纯函数
 * 证明它们不是占位。
 */

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import * as entry from '@/main'

/** `web/` 根。 */
const WEB_ROOT = path.join(import.meta.dirname, '..', '..')

/** 读源码并**归一化行尾为 LF**（铁律 6）。 */
function readSource(rel: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}

/**
 * 库入口的**公共面**（对外契约；改名/删除即破坏宿主集成）。
 *
 * 这份清单是 P9 G-5 的"15 个公共导出"在**当前实现**上的准确形态
 * （实测 `Object.keys(await import('@/main'))`，20 个名字，含 2 个类型出口
 * 不在此列 —— 类型出口不进运行期名字表）。
 */
const PUBLIC_SURFACE = [
  'COMPACT_PAYLOAD_ENCODING',
  'ENVELOPE_META_KEYS',
  'EmbedViewport',
  'MOUNT_SELECTOR',
  'ROOT_META_FORM_KEYS',
  'buildEnvelopePackage',
  'buildMaterialRegistryFromSceneDocument',
  'copyTextToClipboard',
  'documentLooksPreviewable',
  'downloadJson',
  'isEnvelopeDocument',
  'loadPreviewSessionFromDocument',
  'mount',
  'patchSceneMetadataRoot',
  'readDocumentFormat',
  'readSceneMetaField',
  'resolveRenderBundle',
  'sceneStableStringIdFromDocument',
  'validatePackedSceneDocument',
  'validateRenderBundle',
] as const

describe('库入口公共面（G-5）：对外契约被守卫，且不是占位', () => {
  it('公共面**恰好**是登记的那些名字（改名/漏导出即判红）', () => {
    const actual = Object.keys(entry).sort()
    expect(
      actual,
      '库入口的公共面变化必须同批更新本清单 —— 它是宿主（Wiki gadget）的对外契约',
    ).toEqual([...PUBLIC_SURFACE].sort())
  })

  it('**反空洞真**：公共面非空且每个名字都有真实值（不是 `undefined` 占位）', () => {
    expect(PUBLIC_SURFACE.length, '公共面不得为空（否则上一条是空转）').toBeGreaterThan(10)
    for (const name of PUBLIC_SURFACE) {
      const value = (entry as Record<string, unknown>)[name]
      expect(value, `${name} 不得是 undefined（#249 §13 禁止空接口）`).toBeDefined()
      expect(value, `${name} 不得是 null`).not.toBeNull()
      // 必须是函数或非空常量（既不是空对象也不是空串）
      if (typeof value === 'object') {
        expect(Object.keys(value as object).length, `${name} 不得是空对象`).toBeGreaterThan(0)
      } else if (typeof value === 'string') {
        expect((value as string).length, `${name} 不得是空串`).toBeGreaterThan(0)
      }
    }
  })

  it('**抽查真实现**：几个可安全调用的纯函数确实工作（不是 `() => {}`）', () => {
    // 形态判别：对一份明显的 Plain 文档给出确定结论
    expect(entry.readDocumentFormat({ documentFormat: 'Plain' })).toBe('Plain')
    expect(entry.isEnvelopeDocument({ documentFormat: 'Envelope' }), 'Envelope 文档必须被判为 Envelope').toBe(true)
    expect(entry.isEnvelopeDocument({ documentFormat: 'Plain' }), 'Plain 文档不得被判为 Envelope').toBe(false)
    // 常量出口有确定形态
    expect(typeof entry.COMPACT_PAYLOAD_ENCODING).toBe('string')
    expect(Array.isArray(entry.ENVELOPE_META_KEYS), '信封 meta 键清单必须是数组').toBe(true)
    expect(Array.isArray(entry.ROOT_META_FORM_KEYS), '根级形态键清单必须是数组').toBe(true)
    expect(typeof entry.MOUNT_SELECTOR, '挂载点选择器必须是字符串').toBe('string')
  })

  it('**不泄漏内部实现**：核心类型/实现不出现在公共面上', () => {
    const names = Object.keys(entry)
    // 这些是内核内部名 —— 挂到对外面上会让宿主绕过受控边界
    const INTERNAL_LEAKS = [
      'Editor',
      'EditorClient',
      'ApplicationState',
      'RuntimeDocument',
      'EditContext',
      'KernelSession',
      'Context',
      'Main',
    ]
    const leaked = INTERNAL_LEAKS.filter((n) => names.includes(n))
    expect(
      leaked,
      `库入口不得导出内核内部名（宿主会绕过受控边界）：${leaked.join(', ')}`,
    ).toEqual([])
    // 反空洞真：确实在检查一个非空名字表
    expect(names.length).toBeGreaterThan(10)
  })

  it('入口源码**不 import 工作台整站**（库产物不得含 SDE Workbench）', () => {
    const src = readSource('src/main.ts')
    // 只看**导入/导出语句**，不看散文：入口文件头的说明里**提到**
    // `WorkbenchRoot`（"不包含 SDE Workbench 整站（WorkbenchRoot 等）"）——
    // 那是解释，不是引用。"提到 ≠ 使用"是本工程已确立的判定原则
    // （见 `composition/__tests__/seams.test.ts` 的 `codeOf`/`codeText` 分工）。
    const statements = src
      .split(/\r?\n/)
      .filter((l) => /^\s*(import|export)\b/.test(l))
      .join('\n')
    for (const forbidden of ['WorkbenchRoot', 'workbench/WorkbenchRoot', 'dev/DevApp']) {
      expect(
        statements.includes(forbidden),
        `库入口的导入/导出语句不得引用 ${forbidden}（那是 main-workbench.ts 的职责）`,
      ).toBe(false)
    }
    // 反空洞真：确实抽到了导出语句（否则上面的"不含"是空转）
    expect(statements.includes('export'), '入口必须有导出语句').toBe(true)
    expect(statements.length, '抽到的语句应有实质长度').toBeGreaterThan(100)
  })
})
