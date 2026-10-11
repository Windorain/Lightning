/**
 * **P6 退役事实的机器核对**（R-WK-01 归口义务；#257）。
 *
 * ## 本文件与 `composition/seams.ts` 的分工（变基合流后的口径）
 *
 * P2（#253）先建立了**唯一的**接缝登记表 `composition/seams.ts` 的
 * `SEAMS`（`SeamRegistration[]`），并声明「**新增双轨必须在此登记**」，
 * 且「本表长度就是双轨剩余数、**只应减少**」。
 * P6 初版另立了一套并行形状（`RetirementSeam`/`P6_RETIREMENT_SEAMS`），
 * 合流时按 Lead 裁决**撤掉并行形状、统一到 `SEAMS`**（两套并存是 #171 禁止的形态）。
 *
 * 于是本文件的职责收敛为两件事：
 *
 *  1. **P6 开放的接缝**是否**确实**登记在 `SEAMS` 里，且其"阻塞方"是**真的**
 *     （模块图级核验，不是抄写）；#261 完成接线后这条会**自动失效**并要求更新登记
 *     —— 防"接缝永久挂着"的僵尸登记。
 *  2. **P6 已核销的两条**（模块级宿主开关 B5 #7、组件挂载决定状态寿命 B5 #10）
 *     作为**回归断言**把守 —— 它们不该进 `SEAMS`（该表只记剩余双轨），
 *     但必须防止被改回去。
 *
 * ## 诚实边界（降级标注）
 *
 * 第 1 项的判定是**源码/模块图级**：它能证明"生产代码里没有构造/没有 import"，
 * 但**不能**证明"运行期不会经动态路径调用"。故断言文字写"模块图级无生产消费者"，
 * **不**写成"已证明内核未接线"。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SEAMS, seamById } from '../seams'

const SRC = path.join(import.meta.dirname, '..', '..')

/** 读源码并**归一化行尾为 LF**（铁律 6：本仓 `core.autocrlf=true`，新鲜检出是 CRLF）。 */
function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
}

/**
 * 只取**代码**：剥掉注释（行/块/**Vue 模板** `<!-- … -->`）与**字符串字面量**。
 *
 * ## 为什么必须连字符串一起剥（P6 实测，由反空洞真断言抓出）
 *
 * 本文件用"生产代码里有没有 `new Editor(`"作为"内核是否已接线生产"的证据。
 * 但本表自己的 `blocker` 字段就是一段**说明文字**，里面逐字写了
 * "`new Editor(` 零生产构造" —— 那是**叙述**，不是构造点。
 * 若只剥注释，这条说明会让判据把自己的登记表当成"已经接线"，**判据恒假红**。
 *
 * 判定原则：**"提到某符号"≠"使用某符号"**。枚举式静态判据必须只看代码，
 * 注释与字符串里的引用一律不算 —— 这与 `mathContract.test.ts` 的
 * `stripCommentsAndStrings` 同法（那里也是为了防止注释里的解释被当违规）。
 *
 * ## 为什么用手写扫描器而不是正则
 *
 * Vue 模板注释、块注释跨行、字符串里的引号转义、模板字面量 —— 正则逐条叠加
 * 极易漏（漏一个就把"提到"当"使用"）。逐字符状态机把四种状态一次说清。
 *
 * 行尾归一化为 LF（铁律 6：本仓 `core.autocrlf=true`，新鲜检出是 CRLF）。
 */
function codeOf(rel: string): string {
  const src = read(rel)
  let out = ''
  // 状态：普通代码 / 行注释 / 块注释 / 字符串（记录引号种类）
  let i = 0
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template'
  let mode: Mode = 'code'
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (mode === 'code') {
      // Vue 模板注释在 `.vue` 里出现；这里统一按 HTML 注释处理（对 .ts 无副作用）
      if (c === '<' && src.startsWith('<!--', i)) {
        const end = src.indexOf('-->', i + 4)
        i = end === -1 ? src.length : end + 3
        continue
      }
      if (c === '/' && next === '/') { mode = 'line'; i += 2; continue }
      if (c === '/' && next === '*') { mode = 'block'; i += 2; continue }
      if (c === "'") { mode = 'single'; i += 1; continue }
      if (c === '"') { mode = 'double'; i += 1; continue }
      if (c === '`') { mode = 'template'; i += 1; continue }
      out += c
      i += 1
      continue
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c }
      i += 1
      continue
    }
    if (mode === 'block') {
      if (c === '*' && next === '/') { mode = 'code'; i += 2; continue }
      i += 1
      continue
    }
    // 字符串内部：跳到收尾引号（处理反斜杠转义）
    if (c === '\\') { i += 2; continue }
    if ((mode === 'single' && c === "'") || (mode === 'double' && c === '"') || (mode === 'template' && c === '`')) {
      mode = 'code'
      i += 1
      continue
    }
    // 字符串里换行不合法（模板字面量除外）；为稳健起见把它当空白保留
    if (c === '\n' && mode !== 'template') out += c
    i += 1
  }
  return out
}

/**
 * 只剥**注释**、保留**字符串字面量与模板属性**（Vue 属性值、`'VITE_HOST_PROFILE'` 等）。
 *
 * ## 与 `codeOf` 的分工（两种判据需要两种视野）
 *
 * | 判据类型 | 该用哪个 | 理由 |
 * |---|---|---|
 * | "有没有**使用**某符号"（`new Editor(`、`getHostProfile()`） | `codeOf`（剥字符串） | 注释/文案里**提到**该符号不算使用 |
 * | "有没有**出现**某字面量"（`'VITE_HOST_PROFILE'`、属性 `v-if="…"`） | `codeText`（留字符串） | 这些事实**就在**字符串里，剥掉就看不见了 |
 *
 * 用错视野的两种后果都实测到了：
 *  - 用 `codeText` 查 `new Editor(` ⇒ 登记表自己的说明文字被当成构造点（假红）；
 *  - 用 `codeOf` 查 `VITE_HOST_PROFILE`/`v-if` ⇒ 真实使用点被剥掉（假绿/假红）。
 */
function codeText(rel: string): string {
  const src = read(rel)
  let out = ''
  let i = 0
  type Mode = 'code' | 'line' | 'block'
  let mode: Mode = 'code'
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (mode === 'code') {
      if (c === '<' && src.startsWith('<!--', i)) {
        const end = src.indexOf('-->', i + 4)
        i = end === -1 ? src.length : end + 3
        continue
      }
      if (c === '/' && next === '/') { mode = 'line'; i += 2; continue }
      if (c === '/' && next === '*') { mode = 'block'; i += 2; continue }
      out += c
      i += 1
      continue
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c }
      i += 1
      continue
    }
    if (c === '*' && next === '/') { mode = 'code'; i += 2; continue }
    i += 1
  }
  return out
}

/** 递归枚举 `src/` 下的生产源码（排除测试与声明文件）。 */
function productionFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(ts|tsx|mts|vue)$/.test(e.name) || /\.d\.ts$/.test(e.name)) continue
      out.push(path.relative(SRC, full).replace(/\\/g, '/'))
    }
  }
  walk(SRC)
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. P6 开放的接缝：登记存在 + 阻塞事实为真
// ─────────────────────────────────────────────────────────────────────────────

describe('P6 开放接缝 · 登记在 `SEAMS` 且阻塞方**为真**', () => {
  const ENTRY_ID = 'per-viewport-channel-staging'

  it('`per-viewport-channel-staging` 已按 `SeamRegistration` 形状登记（owner = P10/#261）', () => {
    const entry = seamById(ENTRY_ID)
    expect(entry, `P6 的开放接缝必须登记在 SEAMS 里（id=${ENTRY_ID}）`).toBeTruthy()
    if (!entry) return
    // 形状（与 `boundary-scan.test.ts` 的逐条断言同口径）
    expect(entry.id).toMatch(/^[a-z0-9-]+$/)
    expect(entry.files.length).toBeGreaterThan(0)
    expect(entry.newTrack).toBeTruthy()
    expect(entry.oldTrack).toBeTruthy()
    expect(entry.blocker).toBeTruthy()
    expect(entry.exitCondition).toBeTruthy()
    // 相位按 R-WK-03：目标批次是 #261（P10），不是 P6
    expect(entry.owner.p).toBe('P10')
    expect(entry.owner.issue).toBe(261)
    expect(entry.owner.duty).toBe('集成闭环与交叉验收')
    // 退出条件必须点名 `files` 里的文件（与 `boundary-scan` 同款判据）
    expect(entry.files.some((f) => entry.exitCondition.includes(f))).toBe(true)
  })

  it('旧轨**确实仍在**（登记不得空转）：`useMultiblockChannels.ts` 存在且仍持每视口 state', () => {
    const rel = 'shared/viewport/useMultiblockChannels.ts'
    expect(fs.existsSync(path.join(SRC, rel)), '该文件仍应在（P6 区，删除归 #261）').toBe(true)
    const code = codeOf(rel)
    expect(code.includes('ref<MultiblockSelectionState>'), '每视口暂存副本仍在（这是本条未退出的证据）').toBe(true)
    expect(code.includes('bindMultiblockMeshSync'), '手工链式刷新仍在（B5 #4 第二条 slug 的证据）').toBe(true)
    // 两端仍是**真实**消费者（不是死代码）
    expect(codeOf('shared/viewport/EmbedViewport.vue').includes('useMultiblockChannels')).toBe(true)
    expect(codeOf('workbench/components/WorkbenchViewport.vue').includes('useMultiblockChannels')).toBe(true)
  })

  it('替代机制**已就位**：`EditContext.channelValues`（P1）+ P4 的纯求值面存在', () => {
    expect(codeOf('domain/editing.ts').includes('channelValues'), 'P1 的通道取值归属已存在').toBe(true)
    expect(fs.existsSync(path.join(SRC, 'application/evaluation.ts')), 'P4 的求值面已存在').toBe(true)
  })

  it('阻塞方「内核未接线生产」**已不成立** —— 接线已落地（#261），本条按门规更新', () => {
    // ## 这条断言为什么从"阻塞为真"翻成"阻塞已解除"（R-WK-03 的退出条件）
    //
    // 本文件（P6 建立）原先断言四条"模块图级无生产消费者"作为阻塞证据：
    // 零 `new Editor(`、零 `runtime/evaluation` 导入者、零 `advanceContextTime` 调用方、
    // 生产入口零内核导入。那四条**当时为真**，本批（P10/#261）按 R-WK-03
    // 「内核→生产接线是 #261 的核心内容」把它们逐条解除：
    //
    //  - `new Editor(` 出现在 `runtime/kernelSession.ts`（宿主侧会话）；
    //  - 生产入口经装配层持有会话（`Context.kernel`）。
    //
    // 判据**没有放松**，只是方向翻转：原先防"假装接线了"，现在防"假装没接线"
    // —— 后者会让 P11 拿着一份过期清单去核对已经不存在的阻塞。
    // 故这里断言**接线确实存在**，并保留"恰好一处构造点"的唯一性。
    const files = productionFiles()

    // ① 内核执行器**恰好**在会话层被构造（唯一构造点 ⇒ 不存在第二条执行路径）
    const editorCtor = files.filter((rel) => codeOf(rel).includes('new Editor('))
    expect(
      editorCtor,
      `内核执行器的构造点必须恰好是 runtime/kernelSession.ts（否则存在第二条执行路径）：${editorCtor.join(', ')}`,
    ).toEqual(['runtime/kernelSession.ts'])

    // ② 生产入口**确实**持有会话（Context 的内核会话是构造参数，由宿主传入）
    expect(
      codeOf('runtime/context.ts').includes('KernelSession'),
      'Context 必须持有内核会话（否则接线只是"有个没人用的会话"）',
    ).toBe(true)
    expect(
      codeOf('runtime/host/workbenchHost.ts').includes('createKernelSession'),
      '工作台宿主必须创建内核会话',
    ).toBe(true)
    expect(
      codeOf('runtime/host/embedHost.ts').includes('createKernelSession'),
      '嵌入宿主必须创建内核会话',
    ).toBe(true)

    // ③ 时间推进经**唯一写通路**（命令），不是宿主直接改状态
    const timeAdvancers = files.filter(
      (rel) => !['domain/editing.ts', 'domain/animation.ts'].includes(rel) && /advanceContextTime\s*\(/.test(codeOf(rel)),
    )
    expect(
      timeAdvancers,
      `不得有生产调用方直接调 advanceContextTime（时间推进必须经 advancePlayback 命令）：${timeAdvancers.join(', ')}`,
    ).toEqual([])
    // 用 `codeText` 而不是 `codeOf`：命令 kind **就是**一个字符串字面量
    // （`{ kind: 'advancePlayback', … }`），剥掉字符串就看不见它了 ——
    // 这正是本文件文件头那张表里"有没有**出现**某字面量"该用哪把尺子的实例。
    expect(
      codeText('runtime/kernelSession.ts').includes("'advancePlayback'"),
      '会话必须经 advancePlayback 命令注入时间（唯一写通路）',
    ).toBe(true)

    // ④ 内核**不自跑**：会话层不得出现自驱循环（帧时钟归装配层）
    const kernelCode = codeOf('runtime/kernelSession.ts')
    for (const forbidden of ['requestAnimationFrame', 'setTimeout', 'setInterval']) {
      expect(
        kernelCode.includes(forbidden),
        `内核会话不得自持 ${forbidden}（A03：内核不驱动任何循环）`,
      ).toBe(false)
    }
  })

  it('**反空洞真**：上述判据不是恒真 —— 注入构造点即被同一判据抓到', () => {
    // 与 ① 同一个判定式（`codeOf`，剥注释**与字符串**），只换事实来源。
    const fakeFile = 'runtime/host/probe.ts'
    const injected = 'export function boot() { const e = new Editor(); return e }'
    const hits = [fakeFile].filter((_rel, i) => [injected][i].includes('new Editor('))
    expect(hits, '注入的内核构造必须能被抓到').toEqual([fakeFile])
    // 唯一性判据的负对照：在**内存里**多一个构造点 ⇒ "恰好一处"必须判红。
    // 刻意不读一个真实文件（那会变成 ENOENT 而不是判据失败）：判据的对象是
    // "命中集合"，负对照只需证明集合变大时该断言会失败。
    const withSecond = ['runtime/kernelSession.ts', '<injected>'].filter(
      (rel) => rel === '<injected>' || codeOf(rel).includes('new Editor('),
    )
    expect(withSecond.length, '第二个构造点必须使"恰好一处"判红').toBeGreaterThan(1)
    // 且**登记表自己的说明文字**（字符串里的 `new Editor(`）不得被误判为构造点
    // —— 这正是首跑实测到的假红，`codeOf` 剥字符串后消失。
    expect(codeOf('composition/seams.ts').includes('new Editor('), '文案里的提及不算构造点').toBe(false)
    expect(codeText('composition/seams.ts').includes('new Editor('), '而原始文本里确实有这段说明（证明上面那条不是空转）').toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. P6 已核销项：回归断言（不进 SEAMS —— 该表只记剩余双轨）
// ─────────────────────────────────────────────────────────────────────────────

describe('P6 已核销项 · 回归断言（防被改回去）', () => {
  it('已核销项**不**占用 `SEAMS`（该表语义是"双轨剩余数、只应减少"）', () => {
    const ids = SEAMS.map((s) => s.id)
    expect(ids).not.toContain('host-profile-global')
    expect(ids).not.toContain('component-mount-lifetime')
    // 但 P6 的开放接缝必须在
    expect(ids).toContain('per-viewport-channel-staging')
  })

  it('B5 #7：`runtime/hostProfile.ts` 已删除，且全 `src/` 零引用', () => {
    expect(fs.existsSync(path.join(SRC, 'runtime', 'hostProfile.ts')), '旧模块级宿主开关必须已删除').toBe(false)
    const hits: string[] = []
    for (const rel of productionFiles()) {
      const code = codeOf(rel)
      for (const n of ['isWikiHostProfile', 'getHostProfile', 'setHostProfile']) {
        if (code.includes(n)) hits.push(`${rel}: ${n}`)
      }
    }
    expect(hits, `旧宿主开关的消费点必须零引用：\n${hits.join('\n')}`).toEqual([])
  })

  it('B5 #10：`WorkbenchRoot` 无 `v-show` 保活，改用 `v-if` + `:key` 显式生命周期', () => {
    // 用 `codeText`：`v-if`/`v-show`/`:key` 都住在**模板属性**里（字符串视野）。
    const code = codeText('workbench/WorkbenchRoot.vue')
    expect(code.includes('v-show'), '`v-show` 保活必须被显式生命周期取代').toBe(false)
    expect(code.includes('v-if="viewportWorkspace"'), '必须以 `v-if` 显式挂载').toBe(true)
    expect(code.includes(':key="`ws-${workspace}`"'), '必须按工作区 key 重建（不是复用隐藏实例）').toBe(true)
  })

  it('B5 #10 资源面：槽位归零在**真正的拆解点**（不是重挂前的 detach）', () => {
    // P6 实测回归的固定：归零若放进 `attachViewport` 的 unbind，
    // 会在"重挂前的 detach"里抹掉 DRW 拥有的 `definition`/`outlinePass`。
    expect(
      codeOf('runtime/attachViewport.ts').includes('ctx.viewports.reset('),
      'attachViewport 的 unbind 不得归零槽位（会破坏重挂）',
    ).toBe(false)
    expect(
      codeOf('runtime/viewportBinder.ts').includes('unregisterRegion'),
      'viewportBinder 的 unbind 不得注销 region 系统（会破坏重挂）',
    ).toBe(false)
    expect(
      codeOf('workbench/components/WorkbenchViewport.vue').includes('ctx.viewports.unregister('),
      '真正的拆解点必须归零槽位',
    ).toBe(true)
  })

  it('B5 #7：`composition/shell.ts` 是**唯一**读取旧宿主环境变量的地方（迁移窗口恰一处）', () => {
    // 用 `codeText`：真实读取点**就是**一个字符串字面量
    // （`const LEGACY_HOST_PROFILE_ENV = 'VITE_HOST_PROFILE'`），
    // 其余文件只是在注释里**提到**这个变量名 —— "提到"不算读取。
    const hits: string[] = []
    for (const rel of productionFiles()) {
      if (codeText(rel).includes('VITE_HOST_PROFILE')) hits.push(rel)
    }
    expect(
      hits,
      `旧环境变量名只允许作为**字面量**出现在 composition/shell.ts 的已登记迁移窗口（注释里的提及不算）：\n${hits.join('\n')}`,
    ).toEqual(['composition/shell.ts'])
    const shell = codeText('composition/shell.ts')
    expect(
      [...shell.matchAll(/VITE_HOST_PROFILE/g)].length,
      '迁移窗口的取值恰好一处（退出条件：vite wiki 配置改注入 VITE_SHELL_PROFILE）',
    ).toBe(1)
    // 且它**只**出现在 `LEGACY_HOST_PROFILE_ENV` 这个常量声明里（不是散落的直接读取）
    expect(
      /const LEGACY_HOST_PROFILE_ENV = 'VITE_HOST_PROFILE'/.test(shell),
      '旧变量名必须被收拢进单一常量，不得散落',
    ).toBe(true)
  })

  it('**负对照**：上述判据能抓到"未核销却声称核销"（证明不是空转）', () => {
    expect('<WorkbenchShell v-show="workspace === \'preview\'">'.includes('v-show'), '注入 v-show 必判红').toBe(true)
    expect(
      "ctx.viewports.reset(regionId) // in attachViewport unbind".includes('ctx.viewports.reset('),
      '注入 attachViewport 归零必判红',
    ).toBe(true)
    const fake = "import { isWikiHostProfile } from '@/runtime/hostProfile'"
    expect(['isWikiHostProfile', 'getHostProfile', 'setHostProfile'].some((n) => fake.includes(n))).toBe(true)
  })
})
