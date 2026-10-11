/**
 * A25 `input-focus-drafts` / I1 / I3 —— **文本草稿三态机**
 * （#249 §14 A25、§19.1；#258 验收 I1/I3；P7 = #258）。
 *
 * ## A25 要证的三条（本节逐条）
 *
 * | A25 断言 | 落点 |
 * |---|---|
 * | IME 不触发场景操作 | `composing === true` 时效果序列里**没有** `commit` |
 * | 非法中间草稿不写文档 | `intermediate`/`invalid` 只产出 `retain` + `notice` |
 * | 文本局部撤销不误撤文档 | `Ctrl+Z` ⇒ `draftChanged`，**无** `commit`、无历史效果 |
 *
 * ## 三条负对照（#249 §14「负对照必须判红」）
 *
 * 1. **忽略 composition 状态**：`compositionend` 之后紧跟一次 `input` + `Enter`
 *    （浏览器真实序列）。若在 `compositionend` 里就提交，就会**双重提交**。
 *    本文件的断言正是"两次事件之后恰有一次 commit"。
 * 2. **草稿直写属性**：效果类型里**不存在**"写属性"的形状 ——
 *    `commit` 是唯一触碰领域的形状，且需要 `parse.status === 'complete'`。
 *    本文件用"非法草稿一路输入到底，效果序列里 commit 计数恒为 0"来判红这个形态。
 * 3. **双重消费**：同一 token 的 Enter / Escape 第二次进入 ⇒ `duplicate` 且空效果。
 *
 * ## I1「领域提交只有一次事务边界」
 *
 * `commit` 效果携带 `transaction: 'single'`，且每次结算**至多**产出一个 `commit`。
 * 本文件用"多控件切换焦点"的序列断言：N 次焦点切换最多产生 N 个 commit（不多不少）。
 */

import { describe, expect, it } from 'vitest'
import {
  applyCompositionEnd,
  applyCompositionStart,
  applyCompositionUpdate,
  applyDraftInput,
  applyDraftKey,
  blurControl,
  createTextLayerState,
  draftProjection,
  draftUndo,
  focusControl,
  isSubmittable,
  parseDraft,
  parseNumberDraft,
  parseTextDraft,
  type DraftParse,
  type RegisterControlInput,
  type TextDraftEffect,
  type TextLayerState,
} from '@/domain/textDraft'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

let tokenSeed = 7000
function tok(): number {
  tokenSeed += 1
  return tokenSeed
}

const NAME_CONTROL: RegisterControlInput = {
  controlId: 'ctl-name',
  kind: 'text',
  displayValue: '旧名称',
  commitOn: 'enter-or-blur',
}

const WIDTH_CONTROL: RegisterControlInput = {
  controlId: 'ctl-width',
  kind: 'number',
  displayValue: '16',
  min: 1,
  max: 256,
}

function effectsOf(r: { status: string; effects: readonly TextDraftEffect[] }): readonly TextDraftEffect[] {
  return r.effects
}

function commits(effects: readonly TextDraftEffect[]): readonly TextDraftEffect[] {
  return effects.filter((e) => e.kind === 'commit')
}

function notices(effects: readonly TextDraftEffect[]): readonly TextDraftEffect[] {
  return effects.filter((e) => e.kind === 'notice')
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 纯解析：完整 / 中间态 / 非法（#249 §19.1 逐项）
// ─────────────────────────────────────────────────────────────────────────────

describe('纯解析三态：完整 / 中间态 / 非法及原因（#249 §19.1 明文列举的四种中间态）', () => {
  it('空串 → intermediate/empty（用户刚聚焦，不是错误）', () => {
    expect(parseNumberDraft('')).toEqual<DraftParse>({ status: 'intermediate', reason: 'empty' })
    expect(parseNumberDraft('   ')).toEqual<DraftParse>({ status: 'intermediate', reason: 'empty' })
  })

  it('负号 `-` / 正号 `+` → intermediate/signOnly', () => {
    expect(parseNumberDraft('-')).toEqual<DraftParse>({ status: 'intermediate', reason: 'signOnly' })
    expect(parseNumberDraft('+')).toEqual<DraftParse>({ status: 'intermediate', reason: 'signOnly' })
  })

  it('小数点 `.` / `-.` → intermediate/decimalPointOnly', () => {
    expect(parseNumberDraft('.')).toEqual<DraftParse>({ status: 'intermediate', reason: 'decimalPointOnly' })
    expect(parseNumberDraft('-.' )).toEqual<DraftParse>({ status: 'intermediate', reason: 'decimalPointOnly' })
  })

  it('`1.` → intermediate/trailingDecimalPoint（正打小数位）', () => {
    expect(parseNumberDraft('1.')).toEqual<DraftParse>({ status: 'intermediate', reason: 'trailingDecimalPoint' })
  })

  it('`1e` / `1e-` → intermediate/exponentIncomplete', () => {
    expect(parseNumberDraft('1e')).toEqual<DraftParse>({ status: 'intermediate', reason: 'exponentIncomplete' })
    expect(parseNumberDraft('1e-')).toEqual<DraftParse>({ status: 'intermediate', reason: 'exponentIncomplete' })
  })

  it('完整数值 → complete 且值正确（含负数与小数）', () => {
    expect(parseNumberDraft('-1.5')).toEqual<DraftParse>({ status: 'complete', value: -1.5 })
    expect(parseNumberDraft('0')).toEqual<DraftParse>({ status: 'complete', value: 0 })
    expect(parseNumberDraft('1e3')).toEqual<DraftParse>({ status: 'complete', value: 1000 })
  })

  it('畸形输入 → invalid/malformed（不夹取、不静默转换）', () => {
    expect(parseNumberDraft('1.2.3')).toEqual<DraftParse>({ status: 'invalid', reason: 'malformed', detail: '1.2.3' })
    expect(parseNumberDraft('abc')).toEqual<DraftParse>({ status: 'invalid', reason: 'malformed', detail: 'abc' })
    expect(parseNumberDraft('1 2')).toEqual<DraftParse>({ status: 'invalid', reason: 'malformed', detail: '1 2' })
  })

  it('超出 double 表示范围 → invalid/notFinite（不是 complete 的 Infinity）', () => {
    const r = parseNumberDraft('1e999')
    expect(r.status).toBe('invalid')
    expect(r.status === 'invalid' && r.reason).toBe('notFinite')
  })

  it('越界 → invalid/outOfRange（**不夹取** —— 契约 §3.2 明文禁止"悄悄夹取并宣称已实现"）', () => {
    const r = parseNumberDraft('999', { min: 1, max: 256 })
    expect(r.status).toBe('invalid')
    expect(r.status === 'invalid' && r.reason).toBe('outOfRange')
    expect(r.status === 'invalid' && r.detail).toBe('max=256')
    // 关键：不得返回 256（那才是"夹取"）
    expect(r.status).not.toBe('complete')
  })

  it('中文 IME 组合中间态（拼音串）在**文本**控件里始终合法 —— 它不是数字的中间态', () => {
    // 设计取舍：`parseTextDraft` 没有 invalid 分支（§19.6 的转义是呈现边界的事）。
    // 拼音串作为文本是完整值；作为**数字**控件则走 `malformed`。
    expect(parseTextDraft('zhong')).toEqual<DraftParse>({ status: 'complete', value: 'zhong' })
    expect(parseDraft('text', '中文名称')).toEqual<DraftParse>({ status: 'complete', value: '中文名称' })
  })

  it('`required` 文本控件的空串 → intermediate/empty（还没填完，不是非法）', () => {
    expect(parseTextDraft('', { required: true })).toEqual<DraftParse>({ status: 'intermediate', reason: 'empty' })
    expect(parseTextDraft('', { required: false })).toEqual<DraftParse>({ status: 'complete', value: '' })
  })

  it('`isSubmittable` 只认 complete', () => {
    expect(isSubmittable({ status: 'complete', value: 1 })).toBe(true)
    expect(isSubmittable({ status: 'intermediate', reason: 'empty' })).toBe(false)
    expect(isSubmittable({ status: 'invalid', reason: 'malformed' })).toBe(false)
  })

  /**
   * 属性自身的域约束（`pattern` / `maxLength`）必须下传到**这一个**解析器。
   *
   * ## 为什么这条是必需的（P7 合流实测到的缺陷）
   *
   * 属性描述自带 `domain: { kind: 'pattern', source: '^\\S+$' }`。合流初版
   * `parseTextDraft` 不认识它，于是 `block.id` 输入 `bad value` 被判 `complete`
   * —— 界面显示"可提交"，提交却被唯一写路由拒绝。用户看到的是"输入没反应"，
   * 而 #249 §19.1 要求的是"非法草稿保留**并提示**"。
   *
   * 修法是把域**下传**（判定仍只有这一个来源），而不是在呈现层再加一次判定。
   */
  it('`pattern` 域下传：不匹配 ⇒ invalid/malformed（不是"看起来合法"）', () => {
    const opts = { pattern: '^\\S+$', patternReason: 'namespace:path' }
    expect(parseTextDraft('bad value', opts)).toEqual<DraftParse>({
      status: 'invalid',
      reason: 'malformed',
      detail: 'namespace:path',
    })
    // 匹配 ⇒ 完整
    expect(parseTextDraft('minecraft:stone', opts)).toEqual<DraftParse>({
      status: 'complete',
      value: 'minecraft:stone',
    })
  })

  it('`pattern` 是**正则源串**（元字符生效，不是字面量匹配）', () => {
    // `^[a-z]+$` 必须拒绝大写与数字 —— 若实现按字面量比对，这三条会全过
    expect(parseTextDraft('ABC', { pattern: '^[a-z]+$' }).status).toBe('invalid')
    expect(parseTextDraft('a1', { pattern: '^[a-z]+$' }).status).toBe('invalid')
    expect(parseTextDraft('abc', { pattern: '^[a-z]+$' }).status).toBe('complete')
  })

  it('非法正则源串 ⇒ 按"不约束"处理（不因描述写错而卡死输入）', () => {
    // `[` 是未闭合字符组：`new RegExp` 抛错 ⇒ 退化为不约束
    expect(parseTextDraft('anything', { pattern: '[' }).status).toBe('complete')
  })

  it('`required` 与 `pattern` 同时存在：空串是**中间态**（先于 pattern 判定）', () => {
    // 顺序有意义：用户刚聚焦/清空时不该立刻报"格式非法"
    expect(parseTextDraft('', { required: true, pattern: '^\\S+$' })).toEqual<DraftParse>({
      status: 'intermediate',
      reason: 'empty',
    })
  })

  it('`maxLength` 超限 ⇒ invalid/malformed', () => {
    expect(parseTextDraft('abc', { maxLength: 3 }).status).toBe('complete')
    expect(parseTextDraft('abcd', { maxLength: 3 })).toEqual<DraftParse>({
      status: 'invalid',
      reason: 'malformed',
      detail: 'tooLong',
    })
  })

  it('**负对照**：不下传 pattern ⇒ 同样的文本被判 complete（证明判据有差异，不是恒绿）', () => {
    // 这条把"必须下传"变成可执行判据：若哪天有人把 pattern 从 options 里去掉，
    // 上一条会立刻变红 —— 而这里记录的是"去掉之后会怎样"。
    expect(parseTextDraft('bad value').status).toBe('complete')
    expect(parseTextDraft('bad value', { pattern: '^\\S+$' }).status).toBe('invalid')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. A25 / I3：非法中间草稿**不写文档**
// ─────────────────────────────────────────────────────────────────────────────

describe('A25 / I3 负对照「草稿直写属性」：非法/中间态草稿一路输入到底，commit 计数恒为 0', () => {
  it('数字控件逐字符输入 `-` → complete 之前**不产生任何 commit**', () => {
    // 用一个**无域约束**的数字控件：本用例要证的是"中间态不提交"，
    // 而不是"越界不提交"（后者由下一条专门覆盖）。
    const plain: RegisterControlInput = { controlId: 'ctl-plain', kind: 'number', displayValue: '1' }
    let s = createTextLayerState()
    let r = focusControl(s, plain, tok())
    s = r.state
    expect(commits(effectsOf(r)), '聚焦本身不提交').toHaveLength(0)

    for (const text of ['-', '-1', '-1.', '-1.5']) {
      r = applyDraftInput(s, 'ctl-plain', text, tok())
      s = r.state
      expect(commits(effectsOf(r)), `输入 "${text}" 不得写文档`).toHaveLength(0)
    }
    // 只有解析为 complete 的那一步在**结算**时才会提交（此处尚未结算）
    expect(draftProjection(s.controls['ctl-plain']!).status).toBe('complete')
  })

  it('**负对照本体**：若在 `input` 上直接提交，`-` 会被写成 NaN —— 本实现的效果序列里没有这条路径', () => {
    let s = createTextLayerState()
    s = focusControl(s, WIDTH_CONTROL, tok()).state
    const r = applyDraftInput(s, 'ctl-width', '-', tok())
    const allKinds = effectsOf(r).map((e) => e.kind)
    expect(allKinds).toContain('draftChanged')
    expect(allKinds, 'A25 负对照「草稿直写属性」的判红点：input 事件不得产生 commit').not.toContain('commit')
    expect(r.state.controls['ctl-width']!.parse.status, '`-` 是中间态，不是错误也不是完整值').toBe('intermediate')
  })

  it('Enter 在中间态 ⇒ `retain` + `notice`（保留草稿并提示），**不是** commit、**不是**静默丢弃', () => {
    let s = createTextLayerState()
    s = focusControl(s, WIDTH_CONTROL, tok()).state
    s = applyDraftInput(s, 'ctl-width', '-', tok()).state
    const r = applyDraftKey(s, 'ctl-width', 'Enter', tok())
    expect(commits(effectsOf(r))).toHaveLength(0)
    expect(effectsOf(r).some((e) => e.kind === 'retain')).toBe(true)
    const n = notices(effectsOf(r))
    expect(n, '必须提示而不是静默').toHaveLength(1)
    expect(n[0]!.kind === 'notice' && n[0]!.code).toBe('draftIncomplete')
    // 草稿**保留**（用户接着打 `1` 就能继续）
    expect(r.state.controls['ctl-width']!.text).toBe('-')
  })

  it('Enter 在非法态（`1.2.3`）⇒ notice 的 code 是 `draftInvalid` 且草稿保留', () => {
    let s = createTextLayerState()
    s = focusControl(s, WIDTH_CONTROL, tok()).state
    s = applyDraftInput(s, 'ctl-width', '1.2.3', tok()).state
    const r = applyDraftKey(s, 'ctl-width', 'Enter', tok())
    expect(commits(effectsOf(r))).toHaveLength(0)
    const n = notices(effectsOf(r))
    expect(n[0]!.kind === 'notice' && n[0]!.code).toBe('draftInvalid')
    expect(r.state.controls['ctl-width']!.text).toBe('1.2.3')
  })

  it('越界值（`999` 对 max=256）**不夹取**：既不提交也不写 256', () => {
    let s = createTextLayerState()
    s = focusControl(s, WIDTH_CONTROL, tok()).state
    s = applyDraftInput(s, 'ctl-width', '999', tok()).state
    const r = applyDraftKey(s, 'ctl-width', 'Enter', tok())
    expect(commits(effectsOf(r))).toHaveLength(0)
    expect(r.state.controls['ctl-width']!.text, '草稿原样保留 999').toBe('999')
    expect(r.state.controls['ctl-width']!.parse.status).toBe('invalid')
  })

  it('完整合法草稿 Enter ⇒ **恰一次** commit，且 `transaction: single`（I1）', () => {
    let s = createTextLayerState()
    s = focusControl(s, WIDTH_CONTROL, tok()).state
    s = applyDraftInput(s, 'ctl-width', '64', tok()).state
    const r = applyDraftKey(s, 'ctl-width', 'Enter', tok())
    const c = commits(effectsOf(r))
    expect(c).toHaveLength(1)
    expect(c[0]!.kind === 'commit' && c[0]!.value).toBe(64)
    expect(c[0]!.kind === 'commit' && c[0]!.transaction, 'I1：领域提交只有一次事务边界').toBe('single')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. A25：IME 组合未结束不提交场景操作
// ─────────────────────────────────────────────────────────────────────────────

describe('A25 负对照「忽略 composition 状态」：组合期间/组合确认键都不得提交', () => {
  it('compositionstart → compositionupdate → 期间的 input/Enter 都**不提交**', () => {
    let s = createTextLayerState()
    s = focusControl(s, NAME_CONTROL, tok()).state
    s = applyCompositionStart(s, 'ctl-name', tok()).state
    expect(s.controls['ctl-name']!.composing).toBe(true)

    // 组合期间浏览器也会派发 input（data 是拼音串）
    const during = applyDraftInput(s, 'ctl-name', 'zhong', tok())
    expect(commits(effectsOf(during)), 'IME 组合未结束不得提交场景操作').toHaveLength(0)

    // IME 的确认 Enter（composing 仍为 true）只结束组合
    const enter = applyDraftKey(s, 'ctl-name', 'Enter', tok())
    expect(commits(effectsOf(enter)), 'IME 确认键不得被当成"提交"').toHaveLength(0)
    expect(enter.state.controls['ctl-name']!.composing, '确认 Enter 结束组合态').toBe(false)
  })

  it('**负对照本体（双重提交）**：真实浏览器序列 compositionend → input → Enter 后**恰有 1 次** commit', () => {
    let s = createTextLayerState()
    s = focusControl(s, NAME_CONTROL, tok()).state
    s = applyCompositionStart(s, 'ctl-name', tok()).state
    s = applyCompositionUpdate(s, 'ctl-name', '中文', tok()).state

    // ① compositionend：只解除 composing，**不提交**（若在此提交 ⇒ 会双重提交）
    const end = applyCompositionEnd(s, 'ctl-name', '中文', tok())
    expect(commits(effectsOf(end)), 'compositionend 不得提交（否则与随后的 input/Enter 双重消费）').toHaveLength(0)
    s = end.state
    expect(s.controls['ctl-name']!.composing).toBe(false)

    // ② 随后的 input（浏览器保证派发）
    const input = applyDraftInput(s, 'ctl-name', '中文', tok())
    expect(commits(effectsOf(input)), 'input 事件本身不提交').toHaveLength(0)
    s = input.state

    // ③ 提交时刻：Enter
    const enter = applyDraftKey(s, 'ctl-name', 'Enter', tok())
    expect(commits(effectsOf(enter)), '整条真实序列后恰有一次 commit').toHaveLength(1)
    expect(enter.state.controls['ctl-name']!.text).toBe('中文')
  })

  it('组合期间失焦 ⇒ `retain`（reason = composition-active），**不提交**', () => {
    let s = createTextLayerState()
    s = focusControl(s, NAME_CONTROL, tok()).state
    s = applyCompositionStart(s, 'ctl-name', tok()).state
    s = applyCompositionUpdate(s, 'ctl-name', 'zhong', tok()).state
    const r = blurControl(s, 'ctl-name', 'blur', tok())
    expect(commits(effectsOf(r))).toHaveLength(0)
    const retain = effectsOf(r).find((e) => e.kind === 'retain')
    expect(retain && retain.kind === 'retain' && retain.reason).toBe('composition-active')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. A25：Enter/Escape 不重复消费
// ─────────────────────────────────────────────────────────────────────────────

describe('A25 / 负对照「双重消费」：同一 token 第二次进入 ⇒ duplicate 且空效果', () => {
  it('同一 token 的 Enter 第二次 ⇒ duplicate，commit 只发生一次', () => {
    let s = createTextLayerState()
    s = focusControl(s, WIDTH_CONTROL, tok()).state
    s = applyDraftInput(s, 'ctl-width', '32', tok()).state

    const t = tok()
    const first = applyDraftKey(s, 'ctl-width', 'Enter', t)
    expect(commits(effectsOf(first))).toHaveLength(1)
    const second = applyDraftKey(first.state, 'ctl-width', 'Enter', t)
    expect(second.status).toBe('duplicate')
    expect(effectsOf(second), 'A25：Enter 不重复消费').toHaveLength(0)
  })

  it('同一 token 的 Escape 第二次 ⇒ duplicate（不二次取消）', () => {
    let s = createTextLayerState()
    s = focusControl(s, NAME_CONTROL, tok()).state
    s = applyDraftInput(s, 'ctl-name', 'x', tok()).state
    const t = tok()
    const first = applyDraftKey(s, 'ctl-name', 'Escape', t)
    expect(first.status).toBe('applied')
    expect(effectsOf(first).some((e) => e.kind === 'cancel')).toBe(true)
    const second = applyDraftKey(first.state, 'ctl-name', 'Escape', t)
    expect(second.status).toBe('duplicate')
    expect(effectsOf(second)).toHaveLength(0)
  })

  it('同一 token 的 input 第二次 ⇒ duplicate（不重复写草稿历史）', () => {
    let s = createTextLayerState()
    s = focusControl(s, NAME_CONTROL, tok()).state
    const t = tok()
    const a = applyDraftInput(s, 'ctl-name', 'abc', t)
    const b = applyDraftInput(a.state, 'ctl-name', 'abcd', t)
    expect(b.status).toBe('duplicate')
    expect(b.state.controls['ctl-name']!.text, '第二次不得改草稿').toBe('abc')
  })

  it('token=0 表示"不参与去重"（供纯内部推进使用），不产生 duplicate', () => {
    let s = createTextLayerState()
    s = focusControl(s, NAME_CONTROL, 0).state
    const a = applyDraftInput(s, 'ctl-name', 'a', 0)
    const b = applyDraftInput(a.state, 'ctl-name', 'ab', 0)
    expect(a.status).toBe('applied')
    expect(b.status).toBe('applied')
    expect(b.state.controls['ctl-name']!.text).toBe('ab')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. A25 / I3：文本局部撤销**不**误撤文档
// ─────────────────────────────────────────────────────────────────────────────

describe('A25 / I3「文本局部撤销不误撤文档」：Ctrl+Z 只见草稿', () => {
  it('草稿撤销 ⇒ 只产出 `draftChanged`，**没有** commit、没有历史效果', () => {
    let s = createTextLayerState()
    s = focusControl(s, NAME_CONTROL, tok()).state
    s = applyDraftInput(s, 'ctl-name', 'a', tok()).state
    s = applyDraftInput(s, 'ctl-name', 'ab', tok()).state

    const r = draftUndo(s, 'ctl-name')
    expect(commits(effectsOf(r)), 'A25 负对照「文本局部撤销误撤文档」的判红点').toHaveLength(0)
    expect(effectsOf(r).map((e) => e.kind)).toEqual(['draftChanged'])
    expect(r.state.controls['ctl-name']!.text, '回退到上一个草稿文本').toBe('a')
  })

  it('经键路由的 Ctrl+Z 走的也是草稿路径（`draft.key` 与 `draft.undo` 同效）', () => {
    let s = createTextLayerState()
    s = focusControl(s, NAME_CONTROL, tok()).state
    s = applyDraftInput(s, 'ctl-name', 'a', tok()).state
    s = applyDraftInput(s, 'ctl-name', 'ab', tok()).state
    // 路由层把 Ctrl+Z 映射成 `draft.undo` 意图；驱动层用 `applyDraftKey('Ctrl+Z')` 执行
    const r = applyDraftKey(s, 'ctl-name', 'Ctrl+Z', tok())
    expect(commits(effectsOf(r))).toHaveLength(0)
    expect(r.state.controls['ctl-name']!.text).toBe('a')
  })

  it('**负对照本体**：若不区分草稿历史与文档历史，`Ctrl+Z` 会产出 `edit.undo`（文档撤销）', () => {
    // 本模块的**效果类型**里不存在 `edit.undo` / `history` 形状 ——
    // 故"误撤文档"在这里不可表达。断言效果种类的全集以钉住这一点。
    let s = createTextLayerState()
    s = focusControl(s, NAME_CONTROL, tok()).state
    s = applyDraftInput(s, 'ctl-name', 'a', tok()).state
    s = applyDraftInput(s, 'ctl-name', 'ab', tok()).state
    const r = applyDraftKey(s, 'ctl-name', 'Ctrl+Z', tok())
    const kinds = new Set(r.effects.map((e) => e.kind))
    expect([...kinds].sort()).toEqual(['draftChanged'])
    for (const forbidden of ['history', 'edit.undo', 'undo', 'commit']) {
      expect(kinds.has(forbidden as never)).toBe(false)
    }
  })

  it('草稿重做与撤销对称（撤销后能恢复），且同样不见文档', () => {
    let s = createTextLayerState()
    s = focusControl(s, NAME_CONTROL, tok()).state
    s = applyDraftInput(s, 'ctl-name', 'a', tok()).state
    s = applyDraftInput(s, 'ctl-name', 'ab', tok()).state
    s = draftUndo(s, 'ctl-name').state
    expect(s.controls['ctl-name']!.text).toBe('a')
    const redo = applyDraftKey(s, 'ctl-name', 'Ctrl+Shift+Z', tok())
    expect(commits(effectsOf(redo))).toHaveLength(0)
    expect(redo.state.controls['ctl-name']!.text).toBe('ab')
  })

  it('Escape **取消**草稿（回到显示值），不提交、不写文档', () => {
    let s = createTextLayerState()
    s = focusControl(s, NAME_CONTROL, tok()).state
    s = applyDraftInput(s, 'ctl-name', '改了但不要', tok()).state
    const r = applyDraftKey(s, 'ctl-name', 'Escape', tok())
    expect(commits(effectsOf(r))).toHaveLength(0)
    expect(effectsOf(r).map((e) => e.kind)).toEqual(['cancel'])
    expect(r.state.controls['ctl-name']!.text).toBe('旧名称')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. 焦点切换：合法提交 / 非法保留（#249 §19.1 明文）
// ─────────────────────────────────────────────────────────────────────────────

describe('焦点切换：完整合法草稿按控件声明提交；非法草稿保留并提示（不暗中强制转换）', () => {
  it('合法草稿切走 ⇒ commit（一次）；非法草稿切走 ⇒ retain + notice，草稿仍在', () => {
    // ① 合法
    let s = createTextLayerState()
    s = focusControl(s, WIDTH_CONTROL, tok()).state
    s = applyDraftInput(s, 'ctl-width', '64', tok()).state
    const okSwitch = focusControl(s, NAME_CONTROL, tok())
    expect(commits(effectsOf(okSwitch)), '合法草稿按控件声明提交').toHaveLength(1)
    expect(okSwitch.state.controls['ctl-width']!.text).toBe('64')

    // ② 非法
    let s2 = createTextLayerState()
    s2 = focusControl(s2, WIDTH_CONTROL, tok()).state
    s2 = applyDraftInput(s2, 'ctl-width', '1.2.3', tok()).state
    const badSwitch = focusControl(s2, NAME_CONTROL, tok())
    expect(commits(effectsOf(badSwitch)), '非法草稿不得提交').toHaveLength(0)
    expect(effectsOf(badSwitch).some((e) => e.kind === 'retain')).toBe(true)
    expect(notices(effectsOf(badSwitch))).toHaveLength(1)
    // 草稿**保留**（切回来还在），未被强制转换成旧值
    expect(badSwitch.state.controls['ctl-width']!.text).toBe('1.2.3')
  })

  it('无改动的失焦**不**产生 commit（防幽灵事务）', () => {
    let s = createTextLayerState()
    s = focusControl(s, NAME_CONTROL, tok()).state
    const r = blurControl(s, 'ctl-name', 'blur', tok())
    expect(commits(effectsOf(r)), '没改过就不该提交').toHaveLength(0)
  })

  it('`explicit` 声明的控件（搜索框一类）失焦**不**提交', () => {
    const search: RegisterControlInput = { controlId: 'ctl-search', kind: 'text', displayValue: '', commitOn: 'explicit' }
    let s = createTextLayerState()
    s = focusControl(s, search, tok()).state
    s = applyDraftInput(s, 'ctl-search', 'abc', tok()).state
    const r = blurControl(s, 'ctl-search', 'blur', tok())
    expect(commits(effectsOf(r))).toHaveLength(0)
  })

  it('控件关闭（`close`）⇒ 取消草稿且**不**提交（目标已不存在，提交没有落点）', () => {
    let s = createTextLayerState()
    s = focusControl(s, NAME_CONTROL, tok()).state
    s = applyDraftInput(s, 'ctl-name', '未保存的名字', tok()).state
    const r = blurControl(s, 'ctl-name', 'close', tok())
    expect(commits(effectsOf(r))).toHaveLength(0)
    expect(effectsOf(r).map((e) => e.kind)).toContain('cancel')
    expect(r.state.controls['ctl-name']!.text).toBe('旧名称')
  })

  it('目标失效（`target-invalid`）⇒ 同样取消，不提交', () => {
    let s = createTextLayerState()
    s = focusControl(s, WIDTH_CONTROL, tok()).state
    s = applyDraftInput(s, 'ctl-width', '64', tok()).state
    const r = blurControl(s, 'ctl-width', 'target-invalid', tok())
    expect(commits(effectsOf(r)), '目标没了 ⇒ 提交会打到别处').toHaveLength(0)
  })

  it('I1：N 次焦点切换最多产出 N 个 commit（一次事务边界，不多不少）', () => {
    let s = createTextLayerState()
    let commitCount = 0
    const controls = [WIDTH_CONTROL, { ...WIDTH_CONTROL, controlId: 'ctl-h' }, { ...WIDTH_CONTROL, controlId: 'ctl-d' }]
    for (const c of controls) {
      const focused = focusControl(s, c, tok())
      commitCount += commits(effectsOf(focused)).length
      s = focused.state
      s = applyDraftInput(s, c.controlId, '8', tok()).state
    }
    // 切走时各提交一次（最后一个未切走 ⇒ 不提交）
    expect(commitCount).toBe(2)
    // 每个 commit 都是 single
    expect(commitCount).toBeLessThanOrEqual(controls.length)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. 只读投影（呈现面）
// ─────────────────────────────────────────────────────────────────────────────

describe('只读投影：三态同时可读（呈现与诊断用，不暴露可变结构）', () => {
  it('同时给出显示值 / 草稿 / 可提交值 / 状态 / 原因 / 组合态', () => {
    let s = createTextLayerState()
    s = focusControl(s, WIDTH_CONTROL, tok()).state
    s = applyDraftInput(s, 'ctl-width', '-', tok()).state
    const p = draftProjection(s.controls['ctl-width']!)
    expect(p.displayValue, '显示值 = 文档当前值').toBe('16')
    expect(p.draft, '编辑草稿 = 用户输入').toBe('-')
    expect(p.submittable, '可提交值 = null（中间态）').toBeNull()
    expect(p.status).toBe('intermediate')
    expect(p.reason).toBe('signOnly')
    expect(p.composing).toBe(false)
  })

  it('complete 时 `submittable` 给出解析后的领域值（数字控件给出 number）', () => {
    let s = createTextLayerState()
    s = focusControl(s, WIDTH_CONTROL, tok()).state
    s = applyDraftInput(s, 'ctl-width', '64', tok()).state
    const p = draftProjection(s.controls['ctl-width']!)
    expect(p.submittable).toBe(64)
    expect(typeof p.submittable).toBe('number')
  })

  it('投影是冻结值（呈现层改不动内核状态）', () => {
    let s = createTextLayerState()
    s = focusControl(s, NAME_CONTROL, tok()).state
    const p = draftProjection(s.controls['ctl-name']!)
    expect(Object.isFrozen(p)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. 无宿主的可重放性（A02/A04 口径）
// ─────────────────────────────────────────────────────────────────────────────

describe('纯性：相同输入序列 ⇒ 相同状态与效果序列（无 DOM、无时钟、无随机）', () => {
  it('同一 token/文本序列重跑两遍，逐项一致', () => {
    const run = (): { state: TextLayerState; effects: string[] } => {
      let s = createTextLayerState()
      const effects: string[] = []
      const r0 = focusControl(s, WIDTH_CONTROL, 8001)
      s = r0.state
      effects.push(...r0.effects.map((e) => e.kind))
      for (const [i, text] of ['1', '12', '123'].entries()) {
        const r = applyDraftInput(s, 'ctl-width', text, 8010 + i)
        s = r.state
        effects.push(...r.effects.map((e) => e.kind))
      }
      const rk = applyDraftKey(s, 'ctl-width', 'Enter', 8099)
      s = rk.state
      effects.push(...rk.effects.map((e) => e.kind))
      return { state: s, effects }
    }
    const a = run()
    const b = run()
    expect(a.effects).toEqual(b.effects)
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state))
  })
})
