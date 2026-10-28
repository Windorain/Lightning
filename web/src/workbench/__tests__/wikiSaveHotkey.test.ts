/**
 * **Wiki 内嵌工作台的物理 Ctrl+S 接到既有保存确认入口**（键位/路由层判据）。
 *
 * ## 为什么需要单测（而不是只有 e2e）
 *
 * e2e 能证明"真实按键确实打开了确认模态"，但它不容易逐条钉住下面三件**结构性**事实：
 *
 * | # | 判据 | 失败形态（本文件要拦的） |
 * |---|---|---|
 * | ① | **键位声明单源** | `keymap` 里是 `Ctrl+S`，热键表却写成别的键/另一个算子 ⇒ 菜单与按键静默分叉 |
 * | ② | **能力 guard** | 普通工作台也登记了 Ctrl+S ⇒ 按一下就弹"Wiki 不可用"（必须禁止） |
 * | ③ | **同一算子入口 + 既有文本/IME 优先** | 热键直调保存函数（第二条写路径），或文本焦点/IME 组合期仍触发场景保存 |
 *
 * ## 为什么路由用**生产**函数
 *
 * `routeKeyboardKey`（`domain/input`）是文本层优先、IME、preventDefault 政策的唯一
 * 实现。本文件不复制一套判定，而是把生产返回的**键表**喂给同一个路由函数 ——
 * 若将来有人把文本层/IME 的优先级改坏，这里会先红。
 */

import { describe, expect, it } from 'vitest'
import { CAPABILITY } from '@/composition/modules'
import { createInputRoutingState, routeKeyboardKey, withTextFocus, type KeyFact } from '@/domain/input'
import { DEFAULT_KEYMAP, WIKI_SAVE_CONFIRM_KEY, WIKI_SAVE_CONFIRM_OP_ID } from '@/keymap'
import { WikiSaveConfirmOperator } from '@/operators/builtin/wikiOperators'
import type { Context } from '@/runtime/context'
import {
  WIKI_SAVE_CONFIRM_COMMAND_ID,
  WIKI_SAVE_CONFIRM_HOTKEY,
  WORKBENCH_APP_HOTKEYS,
  deriveWikiSaveHotkey,
  workbenchAppHotkeys,
  workbenchInputHotkeys,
} from '@/workbench/inputHotkeys'

interface FakeCtxOptions {
  readonly wikiUpload: boolean
  readonly onInvoke?: (id: string) => void
}

/** 只满足本文件调用面的 Context（不冒充生产：路由与键表都由生产函数给出）。 */
function fakeCtx(opts: FakeCtxOptions): Context {
  return {
    hasCapability: (capability: string) => capability === CAPABILITY.WIKI_UPLOAD && opts.wikiUpload,
    getOperators: () => ({
      invoke: (id: string) => {
        opts.onInvoke?.(id)
        return 'FINISHED'
      },
      exec: () => Promise.resolve(),
    }),
  } as unknown as Context
}

function keyFact(overrides: Partial<KeyFact> = {}): KeyFact {
  return {
    token: 1,
    kind: 'keydown',
    key: 's',
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
    repeat: false,
    composing: false,
    targetEditable: false,
    hitModalScopeId: null,
    defaultPrevented: false,
    ...overrides,
  }
}

describe('Wiki Ctrl+S：键位声明 → 应用键表 → 同一 OPERATOR_WIKI_SAVE_CONFIRM', () => {
  it('① 键位声明只有一个来源，且算子 id 与算子定义同源', () => {
    // 「Ctrl+S → OPERATOR_WIKI_SAVE_CONFIRM」在 DEFAULT_KEYMAP 里**恰好一条**。
    const declared = DEFAULT_KEYMAP.filter(
      (b) => b.type === 'KEY' && b.key === 's' && b.ctrl === true && b.opId === WIKI_SAVE_CONFIRM_OP_ID,
    )
    expect(declared, '键位表必须有且只有一条 Ctrl+S → 保存到 Wiki').toEqual([WIKI_SAVE_CONFIRM_KEY])

    // 键位声明里的 opId 就是算子自己注册的 id（改一处漏一处 ⇒ 这里先红）。
    expect(WIKI_SAVE_CONFIRM_KEY.opId).toBe(WikiSaveConfirmOperator.id)
    expect(WIKI_SAVE_CONFIRM_OP_ID).toBe(WikiSaveConfirmOperator.id)

    // 应用热键的键/**全部修饰键**派生自同一对象，不是另一份字面量。
    expect(WIKI_SAVE_CONFIRM_HOTKEY).toMatchObject({
      key: WIKI_SAVE_CONFIRM_KEY.key,
      ctrl: WIKI_SAVE_CONFIRM_KEY.ctrl,
      shift: WIKI_SAVE_CONFIRM_KEY.shift ?? false,
      alt: WIKI_SAVE_CONFIRM_KEY.alt ?? false,
      commandId: WIKI_SAVE_CONFIRM_COMMAND_ID,
      preventDefault: true,
    })

    // 判据：**任一**修饰键变化都必须传到热键（防"下次加 shift/alt 只改声明不改派生"）。
    expect(
      deriveWikiSaveHotkey({ key: 's', ctrl: true, shift: true, alt: true }),
      'Ctrl+Shift+Alt+S 的声明变化必须逐项出现在热键上',
    ).toMatchObject({ key: 's', ctrl: true, shift: true, alt: true })
  })

  it('② 能力 guard：普通工作台不登记 Ctrl+S；Wiki 外壳才追加同一条热键', () => {
    const normal = workbenchAppHotkeys(fakeCtx({ wikiUpload: false }))
    expect(normal, '普通工作台的按键表必须与改动前逐字一致').toBe(WORKBENCH_APP_HOTKEYS)
    expect(normal.some((h) => h.commandId === WIKI_SAVE_CONFIRM_COMMAND_ID), '普通工作台不得出现 Wiki 保存热键').toBe(false)

    const wiki = workbenchAppHotkeys(fakeCtx({ wikiUpload: true }))
    expect(wiki.filter((h) => h.commandId === WIKI_SAVE_CONFIRM_COMMAND_ID)).toEqual([WIKI_SAVE_CONFIRM_HOTKEY])
    expect(wiki.slice(0, WORKBENCH_APP_HOTKEYS.length), '追加不得改变既有 undo/redo 顺序').toEqual([...WORKBENCH_APP_HOTKEYS])

    // 局部动作与热键**同一 guard**：非 Wiki 外壳既不按键也不登记处理器（不会留下没人认领的动作）。
    const normalActions = workbenchInputHotkeys(fakeCtx({ wikiUpload: false })).localActions
    expect(normalActions[WIKI_SAVE_CONFIRM_COMMAND_ID], '普通工作台不得登记 Wiki 保存动作').toBeUndefined()
    const wikiActions = workbenchInputHotkeys(fakeCtx({ wikiUpload: true })).localActions
    expect(typeof wikiActions[WIKI_SAVE_CONFIRM_COMMAND_ID], 'Wiki 外壳必须登记同一动作').toBe('function')
  })

  it('③ 局部动作调用的是菜单同一条算子入口（恰一次，且不新增写函数）', () => {
    const calls: string[] = []
    const hotkeys = workbenchInputHotkeys(fakeCtx({ wikiUpload: true, onInvoke: (id) => calls.push(id) }))
    hotkeys.localActions[WIKI_SAVE_CONFIRM_COMMAND_ID]!()
    expect(calls, '一次热键只允许调用一次同一个算子').toEqual([WIKI_SAVE_CONFIRM_OP_ID])
  })

  it('④ 生产路由：Wiki 外壳 Ctrl+S 命中 app 且 preventDefault；普通工作台不抢键', () => {
    const wikiState = createInputRoutingState({ appHotkeys: workbenchAppHotkeys(fakeCtx({ wikiUpload: true })) })
    const wiki = routeKeyboardKey(wikiState, keyFact({ ctrl: true })).decision
    expect(wiki.level).toBe('app')
    expect(wiki.intent?.commandId).toBe(WIKI_SAVE_CONFIRM_COMMAND_ID)
    expect(wiki.preventDefault, '已注册的组合键必须阻止浏览器默认"保存网页"').toBe(true)

    const normalState = createInputRoutingState({ appHotkeys: workbenchAppHotkeys(fakeCtx({ wikiUpload: false })) })
    const normal = routeKeyboardKey(normalState, keyFact({ ctrl: true })).decision
    expect(normal.level, '普通工作台：Ctrl+S 仍是未注册键').toBe('none')
    expect(normal.intent).toBeNull()
    expect(normal.preventDefault, '未处理时不得抢浏览器默认行为').toBe(false)
  })

  it('⑤ 文本焦点/IME 优先：真实焦点状态下 Ctrl+S 不产生场景保存意图', () => {
    const wikiApp = workbenchAppHotkeys(fakeCtx({ wikiUpload: true }))

    const textState = withTextFocus(createInputRoutingState({ appHotkeys: wikiApp }), {
      controlId: 'lightning.block.tooltip',
      composing: false,
    })
    const text = routeKeyboardKey(textState, keyFact({ ctrl: true, targetEditable: true })).decision
    expect(text.level).toBe('text')
    expect(text.intent, '文本输入里的 Ctrl+S 不得落到保存').toBeNull()
    expect(text.reason).toBe('text-native-editing')
    expect(text.preventDefault, '文本输入要保留浏览器/输入法原生行为').toBe(false)

    const imeState = withTextFocus(createInputRoutingState({ appHotkeys: wikiApp }), {
      controlId: 'lightning.block.tooltip',
      composing: true,
    })
    const ime = routeKeyboardKey(imeState, keyFact({ ctrl: true, targetEditable: true })).decision
    expect(ime.level).toBe('text')
    expect(ime.intent, 'IME 组合期任何键都不得产生场景保存').toBeNull()
    expect(ime.reason).toBe('ime-composing')
    expect(ime.preventDefault).toBe(false)
  })
})
