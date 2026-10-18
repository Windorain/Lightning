/**
 * M7-5 · **算子能力门**的判据（`OperatorType.requires` + 注册表结算）。
 *
 * ## 这条判据要钉的两件事
 *
 * 1. **能力缺席 ⇒ 结构化拒绝**：不是 `poll` 返回 false（菜单项悄悄消失），也不是
 *    `exec` 里 `return`（点了没反应）。用户看到的是底栏成句原因，机器读到的是
 *    `UnsupportedOperation` + `capability` + `opId`（SPEC §10.7/§10.10）。
 * 2. **能力在场 ⇒ 照常执行**：否则"拒绝"可能只是"整条路坏了"。
 *
 * ## 输入来自生产装配
 *
 * 能力集合不是手写数组，而是 `resolveComposition` 对**生产 profile 声明**的解析结果
 * （铁律⑦）。负对照的做法是**真的删掉一个模块**（`tools.transformManipulators`）——
 * 那是"删能力"这个动作本身，而不是换一个假 ctx 的字段。
 */
import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import type { Context } from '@/runtime/context'
import { Context as ContextClass } from '@/runtime/context'
import { CAPABILITY } from '@/composition/modules'
import { WORKBENCH_PROFILE } from '@/composition/profiles'
import { resolveComposition } from '@/composition/resolver'
import { createOperatorRegistry } from '@/operators/operatorRegistry'
import { SetToolSettingOperator } from '@/operators/builtin/miscOperators'
import { registerWorkbenchOperators } from '@/workbench/registerWorkbench'

/** 生产 profile 的解析结果（可选：删掉一部分模块 = 删能力）。 */
function assemblyOf(omit: readonly string[] = []) {
  const modules = WORKBENCH_PROFILE.modules.filter((m) => !omit.includes(m.id))
  const r = resolveComposition({ profileId: WORKBENCH_PROFILE.id, modules })
  if (!r.ok) throw new Error('生产 profile 解析失败：' + r.error.failures.map((f) => f.detail).join(' | '))
  return r.value
}

interface Logged { readonly source: string; readonly message: string; readonly detail: unknown }

/**
 * 造一个**真 `Context`**，只注入能力门这条路径需要的字段。
 *
 * ⚠️ 与 `p10fPanelTooltipWrite.test.ts` 同一手法（`Object.create` + 只注入宿主面），
 * 但**能力集合来自生产装配**而不是手写数组 —— 本文件要钉的正是"能力从哪里来"。
 */
function makeContext(capabilities: readonly string[]) {
  const entries: Logged[] = []
  const live: { message: string; origin: string | null }[] = []
  const push = (source: string, message: string, detail: unknown) => {
    entries.push({ source, message, detail })
    return { id: entries.length, time: '', level: 2, source, message, detail }
  }
  const ctx = Object.create(ContextClass.prototype) as Context
  Object.assign(ctx as unknown as Record<string, unknown>, {
    capabilities,
    main: { doc: ref(null), embedPublish: ref({}), contentRefreshTick: ref(0) },
    workbench: {},
    kernel: null,
    log: {
      info: (s: string, m: string, d?: unknown) => push(s, m, d),
      warn: (s: string, m: string, d?: unknown) => push(s, m, d),
      operator: (s: string, m: string, d?: unknown) => push(s, m, d),
      setLiveStatus: (message: string, _level?: number, _state?: string | null, origin?: string | null) => {
        live.push({ message, origin: origin ?? null })
      },
      clearRejectionStatus: () => {
        for (let i = live.length - 1; i >= 0; i--) if (live[i]!.origin === 'rejection') live.splice(i, 1)
      },
    },
    getShellSettings: () => ({ lang: ref('zh') }),
    getToolSettings: () => ({
      replaceBrush: ref(''),
      fillBrush: ref(''),
      generateType: ref(''),
      snapEnabled: ref(false),
      dragSensitivity: 1,
    }),
    hasLoadedDocument: () => false,
  })
  return { ctx, entries, live }
}

/** 生产算子注册表（工作台那一份：`registerWorkbenchOperators`）。 */
function registry() {
  const r = createOperatorRegistry()
  registerWorkbenchOperators(r)
  return r
}

describe('M7-5 · 算子能力门（能力缺席 ⇒ 结构化拒绝，不走"悄悄消失"）', () => {
  it('反空洞真：生产工作台装配**具备** tools.manipulators，且算子确实登记在册', () => {
    const asm = assemblyOf()
    expect(asm.capabilities, '工作台装配必须有 tools.manipulators（否则下面的正对照无区分力）').toContain(
      CAPABILITY.TOOLS_MANIPULATORS,
    )
    expect(registry().find(SetToolSettingOperator.id), '生产注册表必须登记该算子').toBeTruthy()
  })

  it('能力在场 ⇒ 算子照常执行（正对照）', async () => {
    const asm = assemblyOf()
    const { ctx, entries, live } = makeContext(asm.capabilities)
    const props: Record<string, unknown> = { key: 'snapEnabled', value: true }
    await registry().exec(ctx, SetToolSettingOperator.id, props)
    expect(live, '能力在场时不得出现拒绝文案').toEqual([])
    expect(
      entries.filter((e) => typeof e.detail === 'object' && e.detail !== null && (e.detail as { code?: string }).code === 'UnsupportedOperation'),
      '能力在场时不得有 UnsupportedOperation 记录',
    ).toEqual([])
  })

  it('**删能力** ⇒ exec 结构化拒绝（不是静默成功）', async () => {
    const asm = assemblyOf(['tools.transformManipulators'])
    expect(asm.capabilities, '负对照前提：该模块被删后能力确实不在').not.toContain(
      CAPABILITY.TOOLS_MANIPULATORS,
    )
    const { ctx, entries, live } = makeContext(asm.capabilities)
    await registry().exec(ctx, SetToolSettingOperator.id, { key: 'snapEnabled', value: true })

    const refusal = entries.find(
      (e) => typeof e.detail === 'object' && e.detail !== null && (e.detail as { code?: string }).code === 'UnsupportedOperation',
    )
    expect(refusal, '缺能力必须留下可查询的拒绝记录（否则"点了没反应"无法诊断）').toBeTruthy()
    const detail = refusal!.detail as { opId?: string; capability?: string }
    expect(detail.opId, '拒绝记录必须点名是哪个算子').toBe(SetToolSettingOperator.id)
    expect(detail.capability, '拒绝记录必须点名缺哪个能力').toBe(CAPABILITY.TOOLS_MANIPULATORS)
    expect(live.map((l) => l.origin), '拒绝必须写底栏 rejection 渠道（成句原因）').toContain('rejection')
    expect(live.some((l) => l.message.includes(CAPABILITY.TOOLS_MANIPULATORS)), '底栏原因必须点名缺少的能力').toBe(true)
  })

  it('**删能力** ⇒ invoke 也拒绝（两条入口同一个结算点；不是只挡 exec）', () => {
    const asm = assemblyOf(['tools.transformManipulators'])
    const { ctx, entries } = makeContext(asm.capabilities)
    const result = registry().invoke(ctx, SetToolSettingOperator.id, { key: 'snapEnabled', value: true })
    expect(result, '缺能力的 invoke 不得报 FINISHED（那是"假装成功"）').not.toBe('FINISHED')
    expect(
      entries.some((e) => (e.detail as { capability?: string } | undefined)?.capability === CAPABILITY.TOOLS_MANIPULATORS),
      'invoke 路径同样要留下能力名',
    ).toBe(true)
  })

  it('名字与常量一致：拒绝原因走成句文案（不是裸错误码）', async () => {
    const asm = assemblyOf(['tools.transformManipulators'])
    const { ctx, live } = makeContext(asm.capabilities)
    await registry().exec(ctx, SetToolSettingOperator.id, {})
    const text = live.find((l) => l.origin === 'rejection')?.message ?? ''
    expect(text, '成句原因必须说明"本外壳不具备该能力"').toContain('不具备该能力')
    expect(text, '不得把错误码原样贴给用户').not.toContain('UnsupportedOperation')
  })
})
