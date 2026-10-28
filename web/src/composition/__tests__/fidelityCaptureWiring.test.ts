/**
 * **保真字段的采集接线**（G-6a）。
 *
 * ## 要证明什么
 *
 * 1. **接线生效**：装载后会话**持有**源文件的未知顶层字段（原先只被计数、随即丢弃）；
 * 2. **不是空转**：字段表内容真的来自 `unknownFields`（而非恒空）；
 * 3. **`null` ≠ `{}`**（三态）：未采集 / 采集到空 / 采集到有内容，三者可区分；
 * 4. **不串档**：卸载后回到"未采集"，下一次装载不会带上上一份文档的字段；
 * 5. **单一实现**：`adapters/fidelityCapture` 的结果与**直调** `captureFidelity` 逐字段一致
 *    —— 钉住"扁平模块里没有藏第二份采集逻辑"（注入缺陷式判据）。
 *
 * ## 为什么 3 是核心
 *
 * `null`（未采集）与 `{}`（确实没有）压成同一个值，会让保存侧**理直气壮地丢掉**字段
 * ——"我不知道"冒充"没有"，正是要消灭的形态。
 *
 * ## 为什么 5 用"与直调逐字段比对"而不是结构断言
 *
 * 结构断言（"函数体只有一次 `captureFidelity` 调用"）太脆：任何等价重构都会误判。
 * 而"扁平模块的产物 === 直调权威实现的产物"直接钉**语义**：
 * 若扁平模块里藏了第二份逻辑（哪怕只改一个字段值），两份产物就会不等 ⇒ 判红。
 */

import { describe, it, expect } from 'vitest'
import { captureFidelity, CORE_EXTRA_BAG_KEY } from '@/adapters/files/fidelityRecord'
import { captureFidelityFieldMap } from '@/adapters/fidelityCapture'
import { KERNEL_CONTEXT_ID, KERNEL_DOCUMENT_ID, KernelSession } from '@/runtime/kernelSession'
import { ALL_CAPABILITIES } from '@/application/commands'
import { adoptLoadedDocument } from '@/composition/documentLoad'
import { RuntimeDocument, RuntimeFrame, Grid } from '@/context/runtimeDocument'

/** 一帧 × 一格的极小合法文档（装配得起来，才能走到采集那一步）。 */
function minimalDoc(id: string): RuntimeDocument {
  const cells = [[[{ name: 'stone', meta: 0 }]]]
  return new RuntimeDocument({
    id,
    frames: [new RuntimeFrame(0, undefined, new Grid(1, 1, 1, cells))],
  })
}

function session(): KernelSession {
  return new KernelSession({
    documentId: KERNEL_DOCUMENT_ID,
    contextId: KERNEL_CONTEXT_ID,
    capabilities: ALL_CAPABILITIES,
  })
}

const NOOP_LOG = { info: () => {}, warn: () => {} }

/**
 * 带**未知顶层字段**的 plainRoot（装配的输入）。
 *
 * `format_version`/`frames`/`cellGrid` 等是已知键（会被跳过），
 * 故这里放两个明确不属于已知键的字段 + 一个 `meta.` 前缀的未知元数据键。
 */
function plainRootWithUnknown(): Record<string, unknown> {
  return {
    // 明文不属于 KNOWN_ROOT_KEYS 的三个 —— 应全部进 `unknownFields`
    myAddonFlag: 'keep-me',
    futureBlockFormat: { version: 3, note: '未知结构' },
    'meta.customAuthorNote': '保留我',
    // ⚠️ `_extra` 是旧机制的名字，**必须被排除**（`captureFidelity` 的纪律 1）
    [CORE_EXTRA_BAG_KEY]: { legacy: true },
  }
}

describe('① 采集接线生效（原先只被计数）', () => {
  it('装载后会话持有未知顶层字段（含 `meta.` 前缀键；`_extra` 被排除）', () => {
    const s = session()
    try {
      const ok = adoptLoadedDocument(
        { kernel: s, log: NOOP_LOG },
        minimalDoc('probe'),
        plainRootWithUnknown(),
        'probe.json',
      )
      expect(ok, '前提：装配必须成功（否则不会走到采集）').toBe(true)

      const fields = s.fidelityFieldMapOf()
      expect(fields, '装载后必须持有字段表（不是 null）').not.toBeNull()
      expect(fields!.myAddonFlag, '未知顶层字段必须被保住').toBe('keep-me')
      expect(fields!.futureBlockFormat).toEqual({ version: 3, note: '未知结构' })
      expect(fields!['meta.customAuthorNote'], '`meta.` 前缀键必须被保住').toBe('保留我')
      // 纪律 1：`_extra` **不得**进记录（否则等于把旧机制换个地方复活）
      expect(fields!, '`_extra` 必须被排除').not.toHaveProperty(CORE_EXTRA_BAG_KEY)
    } finally {
      s.dispose()
    }
  })

  it('**反空洞**：没有未知字段时是 `{}`（"确实没有"），不是 `null`（"不知道"）', () => {
    const s = session()
    try {
      const ok = adoptLoadedDocument({ kernel: s, log: NOOP_LOG }, minimalDoc('clean'), undefined, 'clean.json')
      expect(ok).toBe(true)
      const fields = s.fidelityFieldMapOf()
      expect(fields, '采集过 ⇒ 不得是 null').not.toBeNull()
      // 允许有装配自产的键（如 format_version 等已知键**不**进），故只断言"是个对象"。
      // ⚠️ 关键区别：`{}` 与 `null` 不同 —— 前者是"知道且为空"。
      expect(typeof fields).toBe('object')
      // 反向：不得把**已知**键也收进来（那会让"哪些字段没人懂"永远查不出来）
      expect(fields).not.toHaveProperty('frames')
      expect(fields).not.toHaveProperty('id')
    } finally {
      s.dispose()
    }
  })
})

describe('② 三态：未采集 / 空 / 有内容', () => {
  it('**未装载 ⇒ `null`**（未采集，不是"没有"）', () => {
    const s = session()
    try {
      expect(s.fidelityFieldMapOf(), '刚构造的会话必须是"未采集"').toBeNull()
    } finally {
      s.dispose()
    }
  })

  it('**卸载 ⇒ 回到 `null`**（不串档：下一份文档不得带上上一份的字段）', () => {
    const s = session()
    try {
      adoptLoadedDocument({ kernel: s, log: NOOP_LOG }, minimalDoc('first'), plainRootWithUnknown(), 'first.json')
      expect(s.fidelityFieldMapOf(), '前提：第一份装上了').not.toBeNull()

      s.markUnloaded()
      expect(s.fidelityFieldMapOf(), '卸载后必须是「未采集」，**不得**留着上一份的字段').toBeNull()
    } finally {
      s.dispose()
    }
  })

  it('**换文档**：第二份的字段**完全替换**第一份（不合并、不残留）', () => {
    const s = session()
    try {
      adoptLoadedDocument({ kernel: s, log: NOOP_LOG }, minimalDoc('first'), plainRootWithUnknown(), 'first.json')
      adoptLoadedDocument(
        { kernel: s, log: NOOP_LOG },
        minimalDoc('second'),
        { onlyThisKey: 'second-value' },
        'second.json',
      )
      const fields = s.fidelityFieldMapOf()!
      expect(fields.onlyThisKey, '第二份的字段必须在').toBe('second-value')
      expect(fields, '第一份的字段**不得**残留（否则保存会写进别的文档的事实）').not.toHaveProperty('myAddonFlag')
    } finally {
      s.dispose()
    }
  })
})

describe('③ 单一实现：扁平模块 === 直调权威实现（注入缺陷式判据）', () => {
  it('`captureFidelityFieldMap` 的产物与直调 `captureFidelity().value.fields` **逐字段**相同', () => {
    const unknown = plainRootWithUnknown()
    const viaFlat = captureFidelityFieldMap({
      sourceFormat: 'V2Plain',
      sourceVersion: '2.0',
      unknownFields: unknown,
    })
    const direct = captureFidelity({
      sourceFormat: 'V2Plain',
      sourceVersion: '2.0',
      raw: unknown,
      knownKeys: [],
    })
    expect(direct.ok, '直调必须成功（否则本判据的前提不成立）').toBe(true)
    // 逐字段比对（含 `_extra` 排除规则的结果）—— 若扁平模块藏了第二份逻辑，这里会不等
    expect(viaFlat).toEqual(direct.ok ? direct.value.fields : undefined)
    // 且"非空"是前提：若两边都是 `{}`，上面的相等是**平凡**的（判据空转）
    expect(Object.keys(viaFlat).length, '两边都空会让相等断言空转 ⇒ 必须非空').toBeGreaterThan(0)
  })
})
