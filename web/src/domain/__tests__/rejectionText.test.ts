/**
 * M4-3 R1 · 拒绝原因成句映射的判据。
 *
 * ## 这三组断言各自防什么
 *
 * 1. **每个已知条目一条断言** —— 防「加了码却忘了文案」（否则用户看到兜底句）。
 *    清单从模块自己的 `REJECTION_REASON_KEYS` 取：新增条目若没写断言，下面的
 *    「逐条对照」会因集合差集判红（不是靠人记得补测试）。
 * 2. **兜底不吞** —— 已知码 + 未知原因、未知码，句子都必须带原文本。
 * 3. **成句形态** —— 字段级与底栏共用同一句；句首随操作变化（「移动被拒」）。
 */
import { describe, expect, it } from 'vitest'
import type { DomainError, DomainErrorCode } from '../errors'
import { REJECTION_REASON_KEYS, rejectionReason, rejectionSentence } from '../rejectionText'

/** 构造结构化错误（纯值；不引 `application/contracts` —— 域层测试不得依赖应用层）。 */
function domainError(code: DomainErrorCode, params: Record<string, string | number> = {}): DomainError {
  return { code, params }
}

/** 键 → 一个能触发的 `DomainError`（参数取该条目的真实携带形状）。 */
const CASES: Readonly<Record<string, DomainError>> = {
  'InvalidValue:malformed-block-id': domainError('InvalidValue', { reason: 'malformed-block-id', hintKey: 'validation.locator' }),
  'InvalidValue:malformed-cell-owner-id': domainError('InvalidValue', { reason: 'malformed-cell-owner-id' }),
  'InvalidValue:duplicateCells': domainError('InvalidValue', { reason: 'duplicateCells', count: 2 }),
  'InvalidValue:emptyBlockName': domainError('InvalidValue', { reason: 'emptyBlockName', count: 1 }),
  'InvalidValue:emptyPaletteRef': domainError('InvalidValue', { reason: 'emptyPaletteRef', count: 1 }),
  'InvalidValue:outsideDeclaredGrid': domainError('InvalidValue', { reason: 'outsideDeclaredGrid', x: 1, y: 2, z: 3 }),
  'InvalidValue:mixedHasNoConcreteValue': domainError('InvalidValue', { reason: 'mixedHasNoConcreteValue' }),
  'InvalidValue:noTargets': domainError('InvalidValue', { reason: 'noTargets' }),
  'InvalidValue:emptyMetadataPatch': domainError('InvalidValue', { reason: 'emptyMetadataPatch' }),
  'InvalidValue:interactionAlreadyActive': domainError('InvalidValue', { reason: 'interactionAlreadyActive', tool: 'move' }),
  'InvalidValue:notFinite': domainError('InvalidValue', { reason: 'notFinite', channel: 'rotation', value: 'NaN' }),
  'ReadOnly:declared-read-only': domainError('ReadOnly', { reason: 'declared-read-only', property: 'lightning.block.id' }),
  'ReadOnly:generated-owner': domainError('ReadOnly', { reason: 'generated-owner', objectId: 'cell@1,2,3' }),
  'ReadOnly:animation-driven': domainError('ReadOnly', { reason: 'animation-driven', property: 'lightning.annotation.pos' }),
  'ReadOnly:locked': domainError('ReadOnly', { reason: 'locked', objectId: 'annotation:a1' }),
  'ReadOnly:no-modification-lease': domainError('ReadOnly', { reason: 'no-modification-lease', objectId: 'annotation:a1' }),
  'MissingTarget:no-document': domainError('MissingTarget', { reason: 'no-document' }),
  'MissingTarget:no-targets': domainError('MissingTarget', { reason: 'no-targets' }),
  'MissingTarget:no-selection': domainError('MissingTarget', { reason: 'no-selection', property: 'lightning.block.id' }),
  'MissingTarget:property-not-registered': domainError('MissingTarget', { reason: 'property-not-registered', property: 'lightning.x.y' }),
  'MissingTarget:unknownPropertyControl': domainError('MissingTarget', { reason: 'unknownPropertyControl', property: 'field:x' }),
  'MissingTarget:target-missing': domainError('MissingTarget', { reason: 'target-missing', objectId: 'cell@0,0,0' }),
  'UnsupportedOperation:identity-not-in-palette': domainError('UnsupportedOperation', { reason: 'identity-not-in-palette', property: 'lightning.block.id', objectId: 'cell@1,2,3' }),
  'UnsupportedOperation:no-write-path': domainError('UnsupportedOperation', { reason: 'no-write-path', property: 'lightning.scene.foo' }),
  'UnsupportedOperation:kernel-not-adopted': domainError('UnsupportedOperation', { reason: 'kernel-not-adopted', property: 'lightning.block.id' }),
  'UnsupportedOperation:capability-missing': domainError('UnsupportedOperation', { reason: 'capability-missing', capability: 'property.write' }),
  'UnsupportedOperation:kernel-registry-invalid': domainError('UnsupportedOperation', { reason: 'kernel-registry-invalid', detail: 'dup' }),
  'UnsupportedOperation:propertyNotAnimatable': domainError('UnsupportedOperation', { reason: 'propertyNotAnimatable', property: 'lightning.block.id' }),
  'DocumentBusy:unknown': domainError('DocumentBusy', { documentId: 'd1', holder: 'ctx-a', requester: 'ctx-b' }),
  'VersionConflict:unknown': domainError('VersionConflict', { expected: 3, actual: 4 }),
  'StaleReference:unknown': domainError('StaleReference', { elementId: 'v12', expected: 2, actual: 3 }),
  'WouldBlock:busy': domainError('WouldBlock', { reason: 'busy' }),
  'WouldBlock:reentrant': domainError('WouldBlock', { reason: 'reentrant' }),
  'WouldBlock:incompatibleQueued': domainError('WouldBlock', { reason: 'incompatibleQueued' }),
}

describe('M4-3 R1 · 拒绝原因成句映射', () => {
  it('已知条目清单与断言表**逐条**对齐（新增条目必须同时补断言）', () => {
    const missing = REJECTION_REASON_KEYS.filter((k) => CASES[k] === undefined)
    const extra = Object.keys(CASES).filter((k) => !REJECTION_REASON_KEYS.includes(k))
    expect(missing, `这些已知条目没有断言（会被兜底句覆盖，等于没翻译）：\n${missing.join('\n')}`).toEqual([])
    expect(extra, `这些断言指向的条目已不存在（改名后测试会空转）：\n${extra.join('\n')}`).toEqual([])
  })

  /** 每条已知原因：中文句必须与兜底句**不同**（证明真命中了条目，不是"恰好也能看"）。 */
  for (const key of REJECTION_REASON_KEYS) {
    it(`${key}：命中专门条目且两种语言都有文本`, () => {
      const error = CASES[key]!
      const zh = rejectionReason(error, 'zh')
      const en = rejectionReason(error, 'en')
      const fallbackZh = rejectionReason(domainError(error.code, { reason: 'unknown-reason-probe' }), 'zh')
      expect(zh.length, `${key} 的中文原因不得为空`).toBeGreaterThan(0)
      expect(en.length, `${key} 的英文原因不得为空`).toBeGreaterThan(0)
      expect(en, `${key} 的英文不得等于中文（两种语言都要有真实文本）`).not.toBe(zh)
      // 兜底句会带上原始 reason 文本；命中的条目不该出现它。
      expect(zh, `${key} 命中兜底句（说明条目未被使用）`).not.toBe(fallbackZh)
    })
  }

  it('已知码 + 未知原因 ⇒ 兜底句保留原 reason 文本（不吞）', () => {
    const e = domainError('InvalidValue', { reason: 'brand-new-reason' })
    const zh = rejectionReason(e, 'zh')
    expect(zh, '未知原因的原文本必须出现（否则用户只看到一句泛化文案）').toContain('brand-new-reason')
    expect(rejectionReason(e, 'en')).toContain('brand-new-reason')
  })

  it('未知码 ⇒ 兜底句保留原码文本（运行期防御，不许吞）', () => {
    const e = { code: 'TotallyNewCode', params: { reason: 'x' } } as unknown as DomainError
    const zh = rejectionReason(e, 'zh')
    expect(zh, '未知码必须出现在句子里').toContain('TotallyNewCode')
    expect(rejectionReason(e, 'en')).toContain('TotallyNewCode')
  })

  it('八码全集都有码级兜底（新增码不会掉进"空文案"）', () => {
    const codes = ['InvalidValue', 'ReadOnly', 'MissingTarget', 'StaleReference', 'DocumentBusy', 'VersionConflict', 'UnsupportedOperation', 'WouldBlock'] as const
    for (const code of codes) {
      const text = rejectionReason(domainError(code, {}), 'zh')
      expect(text.length, `${code} 的码级兜底不得为空`).toBeGreaterThan(0)
    }
  })

  it('成句：字段级=「<字段名>写入被拒：…」；移动=「移动被拒：…」', () => {
    const e = domainError('UnsupportedOperation', { reason: 'identity-not-in-palette' })
    expect(rejectionSentence(e, 'zh', 'propertyWrite', '方块标识')).toMatch(/^方块标识写入被拒：.+$/)
    expect(rejectionSentence(e, 'zh', 'propertyWrite')).toMatch(/^属性写入被拒：.+$/)
    expect(rejectionSentence(e, 'zh', 'move')).toMatch(/^移动被拒：.+$/)
    expect(rejectionSentence(e, 'en', 'move')).toMatch(/^Move rejected: .+$/)
  })

  it('成句带参数事实：越界句子点名具体坐标（可据以行动）', () => {
    const e = domainError('InvalidValue', { reason: 'outsideDeclaredGrid', x: 9, y: 1, z: 4 })
    expect(rejectionSentence(e, 'zh', 'move')).toContain('(9, 1, 4)')
  })
})
