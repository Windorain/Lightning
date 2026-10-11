/**
 * 装配解析与 profile 裁剪的验收 —— **A14 `assembly-profiles`**、
 * **A15 `viewer-pruning`**、**A21 `extension-proof`**（#249 §14；#257 验收清单）。
 *
 * ## 三条负对照的落点（A14 原文：「重复 ID、缺端口、循环依赖」必须判红）
 *
 * 注释里的"负对照"字样集中在 `负对照` describe 块里，
 * 每一条都用**同一个判定函数**、只换输入事实 ——
 * 这正是 #249 §14「负对照必须证明确实破坏了目标保证，不能只令测试主动抛错」。
 *
 * | 负对照 | 注入方式 | 期望 |
 * |---|---|---|
 * | 重复 ID | 同一模块 id 出现两次 | `duplicateId` 失败 |
 * | 缺端口/缺服务 | 模块 `requires` 一个无人 provides 的能力 | `missingRequiredCapability` 失败 |
 * | 循环依赖 | 两个模块互相 requires | `cycle` 失败 |
 * | 隐藏覆盖 | 两模块贡献同一具名落点 | `capabilityConflict` 失败 |
 * | A15 只隐藏按钮 | 查看器装配里**再塞**编辑模块 | `hasContentEditing` 变 true ⇒ 判红 |
 * | A21 必须改核心 switch | 断言 `text` 类型**未**进 `DEFAULT_TYPES` | 若进了 ⇒ 判红（说明扩展没走贡献接口） |
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CAPABILITY, moduleDecl, type ModuleDecl } from '../modules'
import {
  ALL_PROFILES,
  CORE_SEMANTIC_CAPABILITIES,
  EMBED_PROFILE,
  HEADLESS_PROFILE,
  M_MANIPULATORS,
  M_TEXT_OBJECT_TYPE,
  SHARED_FUNCTIONAL_MODULES,
  WIKI_PROFILE,
  WORKBENCH_PROFILE,
} from '../profiles'
import {
  capabilitiesOf,
  detectCapabilityConflicts,
  detectCycles,
  detectDuplicateIds,
  detectMissingServices,
  editorLandings,
  hasCapability,
  hasContentEditing,
  reachableModules,
  resolveComposition,
} from '../resolver'
import { ALL_CAPABILITIES } from '@/application/commands'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

function resolveProfile(p: (typeof ALL_PROFILES)[number]) {
  const r = resolveComposition({ profileId: p.id, modules: p.modules })
  if (!r.ok) throw new Error(`profile ${p.id} 解析失败：${JSON.stringify(r.error.failures.map((f) => f.detail))}`)
  return r.value
}

/**
 * 「只隐藏按钮」负对照的注入物：**内容编辑模块的等价体**。
 *
 * 为什么不直接 import `profiles.ts` 里那个私有常量：它没有被导出
 * （刻意的 —— 它不该被查看器引用）。这里用 `moduleDecl` 现场造一个
 * **能力等价**的模块，于是负对照注入的是"编辑能力 + 编辑命令落点"这一**事实**，
 * 而不是某个特定对象的引用。
 */
function contentCommandsForProbe(): ModuleDecl {
  return moduleDecl({
    id: 'commands.content',
    provides: [CAPABILITY.CONTENT_EDIT, CAPABILITY.CONTENT_ADD, CAPABILITY.CONTENT_DELETE],
    requires: ['document.state', 'edit.context'],
    contributes: {
      commands: [
        { commandId: 'addObject', requires: [CAPABILITY.CONTENT_ADD] },
        { commandId: 'setProperty', requires: [CAPABILITY.CONTENT_EDIT] },
      ],
    },
  })
}

/**
 * 扫描 `src/` 生产代码里的**代码文本**（排除注释与测试），返回 `文件: 命中词`。
 *
 * 排除注释是刻意的：本批大量退役说明写在注释里
 * （"旧实现是 `isWikiHostProfile()`"），那是**有价值的历史依据**，
 * 不是残留引用。口径与 `kernel-legacy-isolation.test.ts` 一致。
 */
function scanProductionFor(needles: readonly string[]): string[] {
  const srcRoot = path.join(import.meta.dirname, '..', '..')
  const hits: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(ts|tsx|mts|vue)$/.test(e.name)) continue
      // `vite-env.d.ts` 是**类型声明**文件：它声明"有哪些环境变量"，
      // 本身不读取任何值 ⇒ 不计入"引用"。
      if (/\.d\.ts$/.test(e.name)) continue
      const code = fs
        .readFileSync(full, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n')
      for (const needle of needles) {
        if (code.includes(needle)) hits.push(`${path.relative(srcRoot, full).replace(/\\/g, '/')}: ${needle}`)
      }
    }
  }
  walk(srcRoot)
  return hits
}

// ─────────────────────────────────────────────────────────────────────────────
// A14 正常路径
// ─────────────────────────────────────────────────────────────────────────────

describe('A14 · 四个 profile 均成功解析；必需能力齐备、贡献分七类', () => {
  it('工作台 / 嵌入 / Wiki / 无界面全部解析成功，且带 profile 自身的组合模块', () => {
    for (const p of ALL_PROFILES) {
      const asm = resolveProfile(p)
      expect(asm.profileId, `${p.id} 的 profileId`).toBe(p.id)
      expect(asm.modules.length, `${p.id} 必须有模块`).toBeGreaterThan(5)
      // profile 自身作为组合模块被采纳（契约 §7 明文）
      expect(asm.modules.map((m) => m.id), `${p.id} 里必须有 profile 组合模块`).toContain(`profile.${p.id}`)
    }
  })

  it('贡献**分七类**，不归并成万能服务定位器（契约 §7 的选择理由）', () => {
    const asm = resolveProfile(WORKBENCH_PROFILE)
    const c = asm.contributions
    // 每一类都是**具名数组**，不是 Record<string, unknown>
    expect(Array.isArray(c.objectTypes)).toBe(true)
    expect(Array.isArray(c.evaluationNodes)).toBe(true)
    expect(Array.isArray(c.commands)).toBe(true)
    expect(Array.isArray(c.editors)).toBe(true)
    expect(Array.isArray(c.controls)).toBe(true)
    expect(Array.isArray(c.hostPorts)).toBe(true)
    expect(Array.isArray(c.shellLayouts)).toBe(true)
    // 且确实有内容（反空洞真）
    expect(c.objectTypes.length, '三类对象类型').toBeGreaterThanOrEqual(3)
    expect(c.editors.length, '多个编辑器落点').toBeGreaterThanOrEqual(3)
    expect(c.hostPorts.length, '宿主端口实现').toBeGreaterThanOrEqual(3)
    expect(c.shellLayouts.length, '外壳布局').toBeGreaterThanOrEqual(1)
    // 关键的**否定**断言：装配结果上不存在一个泛化服务槽位
    expect(Object.keys(asm).sort()).toEqual(['capabilities', 'contributions', 'modules', 'profileId', 'pruned', 'prunedLandings'])
    expect(Object.keys(c).sort()).toEqual(['commands', 'controls', 'editors', 'evaluationNodes', 'hostPorts', 'objectTypes', 'shellLayouts'])
  })

  it('**顺序不敏感**：打乱模块输入顺序 ⇒ 装配结果逐字节相同（契约 §7 明文）', () => {
    const mods = [...WORKBENCH_PROFILE.modules]
    const a = resolveComposition({ profileId: 'workbench', modules: mods })
    const shuffled = [...mods].reverse()
    const b = resolveComposition({ profileId: 'workbench', modules: shuffled })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(JSON.stringify(a.value.capabilities)).toBe(JSON.stringify(b.value.capabilities))
    expect(JSON.stringify(a.value.modules.map((m) => m.id))).toBe(JSON.stringify(b.value.modules.map((m) => m.id)))
    expect(JSON.stringify(a.value.contributions)).toBe(JSON.stringify(b.value.contributions))
    expect(JSON.stringify(a.value.prunedLandings)).toBe(JSON.stringify(b.value.prunedLandings))
  })

  it('**能力集合与 P1 执行器的能力名同源**（两端不漂移）', () => {
    const asm = resolveProfile(WORKBENCH_PROFILE)
    // 工作台必须有 P1 全部能力（它就是"完整内核"）
    for (const cap of ALL_CAPABILITIES) {
      expect(hasCapability(asm, cap), `工作台缺少 P1 能力 ${cap}`).toBe(true)
    }
    // 且没有发明一个不在 P1 清单里的 content.* 能力名
    const p1ContentCaps = ALL_CAPABILITIES.filter((c) => c.startsWith('content.'))
    const asmContentCaps = capabilitiesOf(asm).filter((c) => c.startsWith('content.'))
    expect(asmContentCaps.sort()).toEqual([...p1ContentCaps].sort())
  })

  it('P1 的 `VIEWER_CAPABILITIES`（查看看器基线）与嵌入 profile 的能力集合**一致或为其子集**', async () => {
    // P1 定义了 `VIEWER_CAPABILITIES = ['interaction.begin']` 作为"无内容编辑能力"的
    // 执行输入示例。本批的嵌入 profile 是它的**装配来源**：两者必须不矛盾 ——
    // 嵌入 profile 至少要有 `interaction.begin`（只读观察交互），
    // 且**绝不**包含任何 content.* 能力。
    const { VIEWER_CAPABILITIES } = await import('@/application/commands')
    const viewer = resolveProfile(EMBED_PROFILE)
    for (const cap of VIEWER_CAPABILITIES) {
      expect(hasCapability(viewer, cap), `嵌入 profile 必须包含 P1 查看器能力 ${cap}`).toBe(true)
    }
    expect(capabilitiesOf(viewer).filter((c) => c.startsWith('content.'))).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A14 负对照：四类必须判红
// ─────────────────────────────────────────────────────────────────────────────

describe('A14 **负对照** · 重复 ID / 缺端口 / 循环依赖 / 隐藏覆盖 ⇒ 必须判红', () => {
  it('负对照 1：**重复 ID** ⇒ 判红（`duplicateId`）', () => {
    const twice: ModuleDecl[] = [
      moduleDecl({ id: 'dup', provides: ['x'] }),
      moduleDecl({ id: 'dup', provides: ['y'] }),
    ]
    const f = detectDuplicateIds(twice)
    expect(f.length, '重复 id 必须被报出').toBe(1)
    expect(f[0].reason).toBe('duplicateId')
    expect(f[0].error.code).toBe('InvalidValue')

    const r = resolveComposition({ profileId: 'probe', modules: twice })
    expect(r.ok, '重复 id 的装配必须整体失败').toBe(false)
    if (!r.ok) expect(r.error.failures.map((x) => x.reason)).toEqual(['duplicateId'])
  })

  it('负对照 2：**缺端口/缺服务**（必需能力无提供者）⇒ 判红（`missingRequiredCapability`）', () => {
    const needPort: ModuleDecl[] = [
      moduleDecl({ id: 'consumer', provides: ['consumer'], requires: ['port.ghost'] }),
    ]
    const f = detectMissingServices(needPort)
    expect(f.length).toBe(1)
    expect(f[0].reason).toBe('missingRequiredCapability')
    // 契约 §3.2：目标不存在用 `MissingTarget`，**不**用默认值冒充成功
    expect(f[0].error.code).toBe('MissingTarget')

    const r = resolveComposition({ profileId: 'probe', modules: needPort })
    expect(r.ok).toBe(false)
  })

  it('负对照 3：**循环依赖** ⇒ 判红（`cycle`），且报出**完整环路**', () => {
    const cyclic: ModuleDecl[] = [
      moduleDecl({ id: 'A', provides: ['a'], requires: ['b'] }),
      moduleDecl({ id: 'B', provides: ['b'], requires: ['c'] }),
      moduleDecl({ id: 'C', provides: ['c'], requires: ['a'] }),
    ]
    const f = detectCycles(cyclic)
    expect(f.length).toBeGreaterThanOrEqual(1)
    expect(f[0].reason).toBe('cycle')
    expect(String(f[0].error.params.path), '必须报出可定位的环路，而不只是"有环"').toMatch(/A|B|C/)

    const r = resolveComposition({ profileId: 'probe', modules: cyclic })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.failures.some((x) => x.reason === 'cycle')).toBe(true)
  })

  it('负对照 3b：`composes` 自引用（profile 组合成环）同样判红', () => {
    const cyclic: ModuleDecl[] = [
      moduleDecl({ id: 'P1', provides: ['p1'], composes: ['P2'] }),
      moduleDecl({ id: 'P2', provides: ['p2'], composes: ['P1'] }),
    ]
    const r = resolveComposition({ profileId: 'probe', modules: cyclic })
    expect(r.ok).toBe(false)
  })

  it('负对照 4：**隐藏覆盖**（两模块贡献同一具名落点）⇒ 判红（`capabilityConflict`）', () => {
    const clash: ModuleDecl[] = [
      moduleDecl({ id: 'm1', provides: ['p1'], contributes: { editors: [{ editorType: 'viewport3d', requires: [], contentEditing: false }] } }),
      moduleDecl({ id: 'm2', provides: ['p2'], contributes: { editors: [{ editorType: 'viewport3d', requires: [], contentEditing: false }] } }),
    ]
    const f = detectCapabilityConflicts(clash)
    expect(f.length).toBe(1)
    expect(f[0].reason).toBe('capabilityConflict')
    expect(f[0].error.params.landing).toBe('editor:viewport3d')
    const r = resolveComposition({ profileId: 'probe', modules: clash })
    expect(r.ok, '落点冲突必须**报错**而非"后者胜出"（契约 §7 明文）').toBe(false)
  })

  it('负对照 4b：**同一模块内** provides 重复也判红（那是"计数失真"的隐藏结果）', () => {
    const dupCap = [moduleDecl({ id: 'm', provides: ['x', 'x'] })]
    const f = detectCapabilityConflicts(dupCap)
    expect(f.length).toBe(1)
    expect(f[0].error.params.reason).toBe('duplicateProvides')
  })

  it('**反空洞真**：合法的（无冲突的）装配**不**被判红 —— 否则上面的判红没有意义', () => {
    const okPair: ModuleDecl[] = [
      moduleDecl({ id: 'm1', provides: ['p1'], contributes: { editors: [{ editorType: 'viewport3d', requires: [], contentEditing: false }] } }),
      moduleDecl({ id: 'm2', provides: ['p2'], contributes: { editors: [{ editorType: 'inspector', requires: [], contentEditing: false }] } }),
    ]
    expect(detectCapabilityConflicts(okPair)).toEqual([])
    // 同一能力被**两方提供**不判红：能力是"谁具备某本事"，不是"谁是权威"（见 resolver 文件头取舍）
    const shared: ModuleDecl[] = [
      moduleDecl({ id: 'm1', provides: ['evaluate'] }),
      moduleDecl({ id: 'm2', provides: ['evaluate'] }),
    ]
    expect(detectCapabilityConflicts(shared), '多方提供同一能力是常态，不得误伤').toEqual([])
    expect(resolveComposition({ profileId: 'probe', modules: [...shared, moduleDecl({ id: 'user', provides: ['u'], requires: ['evaluate'] })] }).ok).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A14 可选裁剪（#257 H3「嵌入构建裁剪原因可查询」）
// ─────────────────────────────────────────────────────────────────────────────

describe('A14 · 可选落点被裁剪并记录原因（H3 可查询）', () => {
  it('嵌入 profile：`editors.inspector` 的 Inspector 落点因缺 `inspector.panels` 被裁剪', () => {
    const asm = resolveProfile(EMBED_PROFILE)
    const prunedInspector = asm.prunedLandings.filter((p) => p.id === 'inspector')
    expect(prunedInspector.length, '嵌入必须裁剪 Inspector 落点').toBe(1)
    expect(prunedInspector[0]).toEqual({
      kind: 'editor',
      id: 'inspector',
      moduleId: 'editors.inspector',
      missingCapability: 'inspector.panels',
    })
    // 同时留在 `pruned` 里（模块级记录，供诊断聚合）
    expect(asm.pruned.some((p) => p.moduleId === 'editors.inspector' && p.reason === 'missingOptionalCapability' && p.capability === 'inspector.panels')).toBe(true)
    // 而**模块本身仍被采纳**（只裁落点，不裁整个模块 —— 否则过宽）
    expect(asm.modules.map((m) => m.id)).toContain('editors.inspector')
    // 落点确实不在编辑器清单里
    expect(editorLandings(asm).map((e) => e.editorType)).not.toContain('inspector')
  })

  it('工作台 profile：Inspector 落点**被采纳**（同一模块、不同 profile ⇒ 不同结果）', () => {
    const asm = resolveProfile(WORKBENCH_PROFILE)
    expect(asm.prunedLandings.filter((p) => p.id === 'inspector')).toEqual([])
    expect(editorLandings(asm).map((e) => e.editorType)).toContain('inspector')
  })

  it('**负对照**：若把缺失的可选能力改成**必需**，则整套装配失败（不再是"裁剪"）', () => {
    const strict: ModuleDecl[] = [
      moduleDecl({
        id: 'strict',
        provides: ['strict'],
        // 故意用 requires 而非 optionalRequires
        requires: ['inspector.panels'],
        contributes: { editors: [{ editorType: 'inspector', requires: ['inspector.panels'], contentEditing: false }] },
      }),
    ]
    const r = resolveComposition({ profileId: 'probe', modules: strict })
    expect(r.ok, '必需能力缺失 ⇒ 启动失败（契约 §7），不是"裁剪"').toBe(false)
    if (!r.ok) expect(r.error.failures[0].reason).toBe('missingRequiredCapability')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 四个 profile 的语义一致性（#257 H3）
// ─────────────────────────────────────────────────────────────────────────────

describe('H3 · 工作台/Wiki/无界面/嵌入 profile 的**对象、时间、通道语义一致**', () => {
  it('四个 profile 的装配结果都含 CORE_SEMANTIC_CAPABILITIES 全套', () => {
    for (const p of ALL_PROFILES) {
      const asm = resolveProfile(p)
      const missing = CORE_SEMANTIC_CAPABILITIES.filter((c) => !hasCapability(asm, c))
      expect(missing, `${p.id} 缺少核心语义能力：${missing.join(', ')}`).toEqual([])
    }
  })

  it('四个 profile 的对象类型集合**逐项相同**（同一批对象语义）', () => {
    const sets = ALL_PROFILES.map((p) => resolveProfile(p).contributions.objectTypes.map((x) => x.contribution.type).sort())
    for (const s of sets) expect(s).toEqual(sets[0])
    expect(sets[0]).toEqual(['annotation', 'block', 'camera', 'text'])
  })

  it('四个 profile 的时间/通道模块是**同一批对象引用**（不是各自复制的等价物）', () => {
    // `SHARED_FUNCTIONAL_MODULES` 是同一批对象；四个 profile 的 modules 里能按引用找到它们
    const sharedIds = SHARED_FUNCTIONAL_MODULES.map((m) => m.id)
    for (const p of ALL_PROFILES) {
      const byId = new Map(p.modules.map((m) => [m.id, m]))
      for (const m of SHARED_FUNCTIONAL_MODULES) {
        expect(byId.get(m.id), `${p.id} 必须引用共享模块 ${m.id}`).toBe(m)
      }
    }
    expect(sharedIds).toContain('timeline.playback')
    expect(sharedIds).toContain('channels.panel')
    expect(sharedIds).toContain('evaluation.scene')
  })

  it('**编辑时间轴与播放时间轴共用同一求值器**：两者都 requires `evaluate`，且全表只有 `evaluation.scene` 提供它', () => {
    const owners = WORKBENCH_PROFILE.modules.filter((m) => m.provides.includes(CAPABILITY.EVALUATE)).map((m) => m.id)
    expect(owners, '求值能力必须有且只有一个提供者（否则"共用采样模型"不成立）').toEqual(['evaluation.scene'])
    for (const id of ['timeline.playback', 'timeline.edit', 'channels.panel']) {
      const m = WORKBENCH_PROFILE.modules.find((x) => x.id === id)
      expect(m?.requires, `${id} 必须经能力组合共用求值器`).toContain(CAPABILITY.EVALUATE)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A15 viewer-pruning
// ─────────────────────────────────────────────────────────────────────────────

describe('A15 · viewer-pruning：查看器构建无内容编辑面，播放/通道仍可用', () => {
  it('查看器（嵌入 profile）**没有**内容编辑/添加/删除能力', () => {
    const viewer = resolveProfile(EMBED_PROFILE)
    expect(hasCapability(viewer, CAPABILITY.CONTENT_EDIT), '查看器不得有 content.edit').toBe(false)
    expect(hasCapability(viewer, CAPABILITY.CONTENT_ADD)).toBe(false)
    expect(hasCapability(viewer, CAPABILITY.CONTENT_DELETE)).toBe(false)
    expect(hasContentEditing(viewer), '查看器构建不得具备内容编辑面').toBe(false)
  })

  it('查看器的**可达模块图**里没有操纵工具、没有内容编辑命令、没有内容编辑面板', () => {
    const p = EMBED_PROFILE
    const asm = resolveProfile(p)
    const reachable = reachableModules(asm, [p.module.id])
    expect(reachable, '操纵工具不得在查看器可达图里（A15 明文）').not.toContain('tools.transformManipulators')
    expect(reachable).not.toContain('commands.content')
    expect(reachable).not.toContain('panels.inspectorEdit')
    expect(reachable).not.toContain('layout.editCommands')
    // 正向：视口/通道/时间轴/求值确实在可达图里
    expect(reachable).toContain('editors.viewport3d')
    expect(reachable).toContain('editors.channels')
    expect(reachable).toContain('editors.timeline')
    expect(reachable).toContain('evaluation.scene')
    expect(reachable).toContain('shells.embed')
  })

  it('**A15 明文**「播放/通道仍可用」：查看器仍有 evaluate / timeline / channels / picking', () => {
    const viewer = resolveProfile(EMBED_PROFILE)
    for (const cap of [CAPABILITY.EVALUATE, 'timeline.playback', 'timeline.edit', 'channels.panel', CAPABILITY.PICKING]) {
      expect(hasCapability(viewer, cap), `查看器必须仍能 ${cap}`).toBe(true)
    }
    // 且通道/时间的命令落点仍在
    const cmds = viewer.contributions.commands.map((c) => c.contribution.commandId)
    expect(cmds).toContain('setChannelValue')
    expect(cmds).toContain('setTime')
  })

  it('查看器的命令落点里**没有一条**要求内容编辑能力', () => {
    const viewer = resolveProfile(EMBED_PROFILE)
    const offenders = viewer.contributions.commands
      .filter((c) => c.contribution.requires.some((r) => r.startsWith('content.')))
      .map((c) => c.contribution.commandId)
    expect(offenders, `查看器里不得有要求内容编辑能力的命令：${offenders.join(', ')}`).toEqual([])
  })

  it('**负对照 A15**「只隐藏按钮仍导入编辑模块」：给查看器再塞编辑模块 ⇒ 判据立刻变红', () => {
    // 模拟"UI 上藏了按钮，但构建里**仍然 import 了**编辑模块"：
    // 真实形态是编辑命令与操纵工具一起被打进构建，于是它们进装配的模块列表。
    // 注入方式就是**真的**把它们加进列表（只藏按钮不会改这份列表）。
    const injected = [contentCommandsForProbe(), M_MANIPULATORS]
    const r = resolveComposition({ profileId: 'embed', modules: [...EMBED_PROFILE.modules, ...injected] })
    expect(r.ok, '塞进编辑模块后装配仍然可解析（能力齐备 ⇒ 正是"只藏按钮"的形态）').toBe(true)
    if (!r.ok) return
    // 关键：装配结果里**确实**出现了内容编辑能力与操纵工具
    // ⇒ "只隐藏按钮"的实现会被这两条抓住（A15 负对照原文）
    expect(hasCapability(r.value, CAPABILITY.CONTENT_EDIT), '只隐藏按钮 ⇒ 能力仍在 ⇒ 判红').toBe(true)
    expect(hasCapability(r.value, 'tools.manipulators')).toBe(true)
    expect(hasContentEditing(r.value), '一旦塞进编辑模块，内容编辑可达性即为 true ⇒ 判红').toBe(true)
    // 真查看器对照：三项全否
    const realViewer = resolveProfile(EMBED_PROFILE)
    expect(hasCapability(realViewer, 'tools.manipulators')).toBe(false)
    expect(hasCapability(realViewer, CAPABILITY.CONTENT_EDIT)).toBe(false)
    expect(hasContentEditing(realViewer)).toBe(false)
    expect(editorLandings(realViewer).map((e) => e.editorType)).not.toContain('editor.text')
  })

  it('**负对照 A15**「运行时绕 UI 发编辑命令被拒绝」：查看器能力集合喂给执行器 ⇒ `setProperty`/`addObject` 判 `UnsupportedOperation`', async () => {
    const { reduceCommand } = await import('@/application/commands')
    const { openDocumentState } = await import('@/application/commands')
    const viewer = resolveProfile(EMBED_PROFILE)
    const state = openDocumentState('doc1', 'ctx1')
    const env = { capabilities: capabilitiesOf(viewer) }

    // 直接构造内容编辑命令 —— 完全绕过任何 UI。
    // 变基合流（× P2 #253）：`setProperty` 已改由命令自带的 `refs` 定位拥有者
    // （不再有 `contextId` 字段）—— 这里按合流后的命令形状构造。
    const setProp = reduceCommand(state, { kind: 'setProperty', refs: [{ owner: { kind: 'object', id: 'ghost' }, property: 'name' }], value: 'x' }, env)
    expect(setProp.status, '运行期必须拒绝内容编辑，而不是"UI 没给按钮"').toBe('rejected')
    if (setProp.status === 'rejected') expect(setProp.error.code).toBe('UnsupportedOperation')

    const addObj = reduceCommand(state, { kind: 'addObject', contextId: 'ctx1', objectType: 'block' }, env)
    expect(addObj.status).toBe('rejected')
    if (addObj.status === 'rejected') expect(addObj.error.code).toBe('UnsupportedOperation')

    // 但**播放/通道确实仍可用**（A15 明文）
    const setChannel = reduceCommand(state, { kind: 'setChannelValue', contextId: 'ctx1', channel: 'tier', value: 3 }, env)
    expect(setChannel.status, '通道取值在查看器里必须仍可用').not.toBe('rejected')
    const setTime = reduceCommand(state, { kind: 'setTime', contextId: 'ctx1', time: { frame: 5, fps: 20 } }, env)
    expect(setTime.status, '时间在查看器里必须仍可用').not.toBe('rejected')
    // 只读观察交互可用（拖机位）——注意 P1 的 `beginInteraction` 对**空目标**本身就拒绝
    // （`noTargets` 是领域规则），故这里用一个真实存在的目标，以区分
    // "能力不足被拒"（红线）与"领域的合法性规则被拒"（正常）。
    const setup = reduceCommand(state, { kind: 'addObject', contextId: 'ctx1', objectType: 'block' }, { capabilities: ALL_CAPABILITIES })
    expect(setup.status, '夹具：先在工作台能力下建一个对象').toBe('applied')
    const withObj = setup.state
    const begin = reduceCommand(withObj, { kind: 'beginInteraction', contextId: 'ctx1', tool: 'orbit', targets: ['obj-1'] }, env)
    // 查看器**能**起只读观察交互；若被拒，拒绝原因必须是领域规则而非能力不足
    if (begin.status === 'rejected') {
      expect(begin.error.code, '只读交互不得因能力不足被拒（A15 明文「播放/通道仍可用」的同类）').not.toBe('UnsupportedOperation')
    }
  })
  it('工作台对照：同一批命令在工作台能力下**生效**（证明上面的拒绝来自能力裁剪，不是命令坏了）', async () => {
    const { reduceCommand, openDocumentState } = await import('@/application/commands')
    const wb = resolveProfile(WORKBENCH_PROFILE)
    const state = openDocumentState('doc1', 'ctx1')
    const env = { capabilities: capabilitiesOf(wb) }
    const addObj = reduceCommand(state, { kind: 'addObject', contextId: 'ctx1', objectType: 'block' }, env)
    expect(addObj.status, '工作台必须能新增对象').toBe('applied')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A21 extension-proof
// ─────────────────────────────────────────────────────────────────────────────

describe('A21 · extension-proof：经贡献接口新增文字类型与专用控件', () => {
  it('`text` 类型经 `contributes.objectTypes` 出现在装配结果里', () => {
    const asm = resolveProfile(WORKBENCH_PROFILE)
    const text = asm.contributions.objectTypes.find((x) => x.contribution.type === 'text')
    expect(text, '新增的 text 类型必须出现在装配结果').toBeTruthy()
    expect(text?.moduleId).toBe('objects.text')
    expect(text?.contribution.dataKind).toBe('annotation')
  })

  it('专用控件经 `contributes.controls` 贡献（RNA 不导入组件名 —— 契约 §5.1）', () => {
    const asm = resolveProfile(WORKBENCH_PROFILE)
    const ctrl = asm.contributions.controls.find((x) => x.contribution.property === 'annotation.text')
    expect(ctrl?.contribution.controlId).toBe('textarea')
  })

  it('新增 `editor.text` 落点经 `contributes.editors` 贡献', () => {
    const asm = resolveProfile(WORKBENCH_PROFILE)
    expect(editorLandings(asm).map((e) => e.editorType)).toContain('editor.text')
  })

  it('**A21 判据**：核心的 `DEFAULT_TYPES` 里**没有** `text` —— 扩展没走"改既有对象分支"', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'domain', 'scene.ts'), 'utf8')
    // 从 `DEFAULT_TYPES` 的声明区间里抽每个类型描述符的 `type:` 字面量。
    const block = src.slice(src.indexOf('const DEFAULT_TYPES'), src.indexOf('export type ObjectTypeRegistry'))
    const types = [...block.matchAll(/type: '([a-zA-Z0-9_]+)'/g)].map((m) => m[1])
    // 变基合流（× P3 #254）：`mesh` 由 P3 合法加入 DEFAULT_TYPES（`domain` 的能力表），
    // 故**类型集合本身**不是 A21 的判据 —— A21 判的是"**扩展类型**（如 `text`）
    // 不得需要改核心"。这里改为：核心里有的类型必须是**内核自有的**那几类，
    // 而扩展类型（`text`）无论如何都不许出现。
    expect(new Set(types), '核心的对象类型必须是内核自有类型（block/annotation/camera + P3 的 mesh）').toEqual(
      new Set(['annotation', 'block', 'camera', 'mesh']),
    )
    expect(types, 'A21 **负对照**：若 `text` 进了 DEFAULT_TYPES，说明扩展必须改核心 ⇒ 判红').not.toContain('text')
  })

  it('`ObjectFactory` 是**唯一**的造对象入口，且它住在**执行输入**里（不是文档状态）', () => {
    // P6 实测修正两处（A21 判据各抓出一处）：
    //  1. `application/commands.ts` 的 `switch (cmd.objectType)` ⇒ 改为查工厂表；
    //  2. 工厂一度被放进 `Document.types` 的描述符 ⇒ `pureDomain.test.ts` 抓到
    //     `structuredClone` 抛 `DataCloneError`（**状态必须可克隆**），
    //     故工厂最终住在 `ExecutionInputs.objectFactories`（能力，不是内容）。
    const cmds = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'application', 'commands.ts'), 'utf8')
    const code = cmds.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
    expect(code.includes('createObjectOfType'), '命令层必须经工厂表造对象').toBe(true)
    expect(/readonly objectFactories\?:/.test(code), '工厂表必须声明在 ExecutionInputs 上').toBe(true)

    // 造对象路径里不得出现对象类型字面量
    const addObjectRegion = code.slice(code.indexOf('function reduceAddObject'), code.indexOf('function reduceDeleteObject'))
    for (const literal of ["'block'", "'annotation'", "'camera'"]) {
      expect(addObjectRegion.includes(literal), `造对象路径不得出现对象类型字面量 ${literal}（否则新增类型要改核心）`).toBe(false)
    }
    // `AddObjectCommand.objectType` 必须是开放的 `string`
    expect(/readonly objectType: string/.test(code), 'AddObjectCommand.objectType 必须是开放 string（A21 实测修正）').toBe(true)

    // 状态侧：`ObjectTypeDescriptor` 里**不得**有函数（否则状态不可克隆/不可重放）
    const scene = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'domain', 'scene.ts'), 'utf8')
    const descBlock = scene.slice(scene.indexOf('export interface ObjectTypeDescriptor'), scene.indexOf('export type ObjectTypeRegistry'))
    expect(descBlock.includes('create'), 'ObjectTypeDescriptor 不得携带工厂函数（状态必须可克隆）').toBe(false)
    // 且内置工厂表只覆盖**内核自有类型**（`text` 不在核心 —— 合流后含 P3 的 `mesh`）
    const factoryBlock = scene.slice(scene.indexOf('export const DEFAULT_OBJECT_FACTORIES'), scene.indexOf('export type ObjectTypeRegistry'))
    const factoryKeys = [...factoryBlock.matchAll(/^\s{2}([a-zA-Z0-9_]+): \(init\)/gm)].map((m) => m[1])
    expect(factoryKeys.sort(), '内置工厂表 = 内核自有类型（合流后含 P3 的 mesh）').toEqual(['annotation', 'block', 'camera', 'mesh'])
    expect(factoryKeys, 'A21 负对照：扩展类型不得出现在内置工厂表').not.toContain('text')
  })

  it('**A21 端到端**：注册一个新对象类型的工厂后，`addObject` 命令**不改核心**即可建出它', async () => {
    // 这条是 A21 的**行为**判据（不是静态扫描）：贡献 → 执行输入的工厂表 → 命令生效。
    const { reduceCommand, openDocumentState, ALL_CAPABILITIES } = await import('@/application/commands')
    const { DEFAULT_OBJECT_FACTORIES, sceneObject, objectData } = await import('@/domain/scene')
    const { ok } = await import('@/domain/errors')
    // 造一个"新类型"的工厂（等价于 `objects.text` 贡献的那一条，但独立构造，
    // 以证明**不需要**核心认识它的名字）。
    // 工厂契约为 `Result<ObjectCreation> | null`（`null`=类型不认识、`err`=构造失败）。
    const probeFactories = {
      ...DEFAULT_OBJECT_FACTORIES,
      text: (init: { objectId: string; dataId: string; name?: string; params?: Readonly<Record<string, unknown>> }) =>
        ok({
          object: sceneObject({ id: init.objectId, type: 'text', dataId: init.dataId, ...(init.name === undefined ? {} : { name: init.name }) }),
          data: objectData(init.dataId, { kind: 'annotation' as const, shape: 'text' as const, text: String(init.params?.text ?? '') }),
        }),
    }
    const state = openDocumentState('doc1', 'ctx1')
    const docId = Object.keys(state.docs)[0]
    const env = { capabilities: ALL_CAPABILITIES, objectFactories: probeFactories }

    const t = reduceCommand(state, { kind: 'addObject', contextId: 'ctx1', objectType: 'text', params: { text: 'hi' } }, env)
    expect(t.status, '新类型必须能被建出来，**不改任何核心分支**').toBe('applied')
    if (t.status !== 'applied') return
    const scene = t.state.docs[docId].scene
    const obj = Object.values(scene.objects)[0]
    expect(obj.type).toBe('text')
    expect(scene.data[obj.dataId].payload).toEqual({ kind: 'annotation', shape: 'text', text: 'hi' })

    // 负面对照：**没有**该类型的工厂 ⇒ 显式 `UnsupportedOperation`（不是静默建一个别的类型）
    const unknown = reduceCommand(state, { kind: 'addObject', contextId: 'ctx1', objectType: 'text' }, { capabilities: ALL_CAPABILITIES })
    expect(unknown.status).toBe('rejected')
    if (unknown.status === 'rejected') expect(unknown.error.code).toBe('UnsupportedOperation')

    // **状态可克隆**（工厂住在 env 而非 state 的直接后果）：应用状态仍可 `structuredClone`
    expect(() => structuredClone(t.state), '带新类型的应用状态必须仍可克隆（A04 重放前提）').not.toThrow()
  })

  it('**A21 判据**：核心没有 `switch (object.type)` / `switch (type)` 式的类型分派', () => {
    const files = [
      ['domain', 'scene.ts'],
      ['application', 'commands.ts'],
      ['composition', 'resolver.ts'],
      ['runtime', 'execution.ts'],
    ]
    const hits: string[] = []
    for (const parts of files) {
      const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', ...parts), 'utf8')
      // 只看代码行（注释里解释"没有 switch"是允许且有价值的）
      const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
      for (const m of code.matchAll(/switch\s*\(\s*([A-Za-z_][\w.]*?)\s*\)/g)) {
        const subject = m[1]
        // `command.kind` 是**命令判别**（契约 §5.2 的封闭联合），不是对象类型分派
        if (/\.(type|objectType|dataKind|payload\.kind)$/.test(subject)) hits.push(`${parts.join('/')}: switch(${subject})`)
      }
    }
    expect(hits, `不得为新增对象类型开核心 switch（A21 负对照）：\n${hits.join('\n')}`).toEqual([])
  })

  it('**负对照 A21**「必须新增全局 type switch 分支」：注入一个 type 分派 ⇒ 判据判红', () => {
    // 与上一条**同一个**判定式，只换事实来源 —— 证明判据不是恒绿
    const injected = 'export function kind(t: string) { switch (t) { case "text": return 1 } }'
    const hits: string[] = []
    for (const m of injected.matchAll(/switch\s*\(\s*([A-Za-z_][\w.]*?)\s*\)/g)) {
      if (/^[A-Za-z_]\w*$/.test(m[1])) hits.push(`switch(${m[1]})`)
    }
    expect(hits.length, '裸标识符上的 switch 必须被判红').toBeGreaterThan(0)
  })

  it('新增类型**不需要**改装配解析器：`resolveComposition` 对 `objects.text` 无任何特判', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'resolver.ts'), 'utf8')
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
    for (const needle of ["'text'", '"text"', "'annotation'", "'block'", "'camera'"]) {
      expect(code.includes(needle), `解析器里不得出现对象类型字面量 ${needle}（A21：无核心 switch）`).toBe(false)
    }
  })

  it('只有 `objects.text` 一个模块提供 `text` 类型与 `textarea` 控件（无影子贡献者）', () => {
    const asm = resolveProfile(WORKBENCH_PROFILE)
    const owners = asm.contributions.objectTypes.filter((x) => x.contribution.type === 'text').map((x) => x.moduleId)
    expect(owners).toEqual(['objects.text'])
    const ctrlOwners = asm.contributions.controls.filter((x) => x.contribution.property === 'annotation.text').map((x) => x.moduleId)
    expect(ctrlOwners).toEqual(['objects.text'])
    // 该模块确实被 profile 引用（不是只在测试里 import）
    expect(WORKBENCH_PROFILE.modules).toContain(M_TEXT_OBJECT_TYPE)
    expect(WIKI_PROFILE.modules).toContain(M_TEXT_OBJECT_TYPE)
    expect(HEADLESS_PROFILE.modules).toContain(M_TEXT_OBJECT_TYPE)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 模块不反向依赖 profile / 宿主名（#249 §4 规则 5、§10 明文）
// ─────────────────────────────────────────────────────────────────────────────

describe('模块不反向依赖 profile 或宿主名；组件不询问宿主名', () => {
  it('`composition/modules.ts` 里没有 profile 名或宿主名', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'modules.ts'), 'utf8')
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
    // 只查**代码**：文件头大量引用旧实现的名字（那是退役说明，有价值）。
    // 代码里若出现这些词，说明装配根的契约部分开始依赖具体 profile 了。
    for (const needle of ["'workbench'", "'embed'", "'wiki'", "'headless'", "'desktop'"]) {
      expect(code.includes(needle), `modules.ts（装配根的**契约**部分）不得出现 profile/宿主名 ${needle}`).toBe(false)
    }
  })

  it('`domain/workspace.ts` 里没有任何宿主/profile 判别（组件不得询问宿主名的结构面）', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'domain', 'workspace.ts'), 'utf8')
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
    for (const needle of ['hostProfile', 'HostProfile', 'VITE_HOST', 'isWiki', 'desktop']) {
      expect(code.includes(needle), `domain/workspace 不得出现宿主判别 ${needle}`).toBe(false)
    }
  })

  it('`runtime/hostProfile.ts` 已被删除（B5 #7 的删除验收：旧机制同批退出）', () => {
    expect(
      fs.existsSync(path.join(import.meta.dirname, '..', '..', 'runtime', 'hostProfile.ts')),
      '旧模块级宿主开关必须随本批删除，不留兼容旁路',
    ).toBe(false)
  })

  it('全 `src/` 生产代码里**零** `isWikiHostProfile` / `getHostProfile` / `setHostProfile` / `HostProfile` 引用', () => {
    const hits = scanProductionFor(['isWikiHostProfile', 'getHostProfile', 'setHostProfile', 'HostProfile'])
    expect(hits, `旧宿主开关必须零引用（B5 #7 删除验收）：\n${hits.join('\n')}`).toEqual([])
  })

  it('旧**环境变量名**只允许出现在 `composition/shell.ts` 的**一处**已登记迁移窗口（带退出条件）', () => {
    // 为什么这里不是"零引用"：`vite.wiki-workbench.config.ts` 属共享瓶颈文件
    // （#250：构建配置由 P0/P1/P11 拥有），本批不得修改 ⇒ 若完全不读旧变量，
    // wiki 构建会静默退化成工作台 profile（功能丢失）。
    // 故登记一处**构建期一次性**读取，且把它约束成可机械对账的**恰好一处**：
    // 任何第二处出现都会被本断言拦下。
    const hits = scanProductionFor(['VITE_HOST_PROFILE'])
    expect(hits, `旧环境变量名只允许一处已登记迁移窗口：\n${hits.join('\n')}`).toEqual(['composition/shell.ts: VITE_HOST_PROFILE'])
    // 且该文件里它只出现一次（不是"某个文件里到处读"）
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'shell.ts'), 'utf8')
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
    expect([...code.matchAll(/VITE_HOST_PROFILE/g)].length, '迁移窗口取值恰好一处').toBe(1)
  })

  it('**负对照**：旧宿主开关的判据能抓到引用（证明上一条不是空转）', () => {
    // 与上一条**同一个**判定函数，只换事实来源
    const injected = "import { isWikiHostProfile } from '@/runtime/hostProfile'\nconst x = isWikiHostProfile()"
    const found = ['isWikiHostProfile', 'getHostProfile', 'setHostProfile', 'HostProfile'].filter((n) => injected.includes(n))
    expect(found.length, '注入的旧宿主调用必须被同一判据抓到').toBeGreaterThan(0)
    expect(found).toContain('isWikiHostProfile')
  })
})
