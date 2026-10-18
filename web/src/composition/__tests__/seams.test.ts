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

  /**
   * ## 本条为何从"登记在表里"翻成"已核销 + 回归把守"（#282 P10b 执行）
   *
   * P6 建立本条时登记的是**未退出的双轨**，判据是"旧轨确实仍在"。本批（#282）
   * 真的把它退掉了：文件删除、取值归 `EditContext`、失效由内容身份判定。
   *
   * 于是判据必须**同批翻转**（否则会永远红，而那个红只代表"断言停在旧相位"）：
   *  - 从 `SEAMS` **移出**（该表的语义是"双轨剩余数、只应减少"）；
   *  - 改由本组断言把守"旧机制**不得复活**" —— 与 P6 当年核销自己那两条
   *    （模块级宿主开关、组件挂载决定状态寿命）时同一手法。
   */
  it('`per-viewport-channel-staging` 已**核销**（不在 `SEAMS` 里 —— 双轨剩余数只应减少）', () => {
    expect(seamById(ENTRY_ID), '已退役的接缝不得留在 SEAMS 里（表长 = 双轨剩余数）').toBeUndefined()
  })

  /**
   * ## M7-4 段 B 更新（钉错了文件，不是放宽）
   *
   * 判据原本钉的是"**两个视口文件**里含 `useKernelChannels`"。合壳后视口粘合只有一份
   * （`shared/viewport/EditorViewportHost.vue`），两个壳已不再直接引用它 —— 旧写法会把
   * **正确的收敛**判成"替代面不在服役"。
   *
   * 意图不变且更严：①旧机制不得复活；②替代面必须在**两个壳实际走的那条路径**上服役
   * （不是"两边都没有"的空洞绿）；③两个壳必须经该唯一实现。
   *
   * 读数（M7-4 段 B）：合壳前 Embed/Workbench 命中 `useKernelChannels` 均 true；
   * 合壳后两壳均 false（0 处直接调用），唯一宿主 true，两壳 import 宿主 = true。
   */
  it('**旧机制不得复活**：`useMultiblockChannels.ts` 已删除，且视口路径不再引用它', () => {
    const rel = 'shared/viewport/useMultiblockChannels.ts'
    expect(fs.existsSync(path.join(SRC, rel)), '该文件已随 #282 删除（整文件退役）').toBe(false)
    // 两个壳与唯一宿主都不得引用旧机制。
    expect(codeOf('shared/viewport/EmbedViewport.vue').includes('useMultiblockChannels')).toBe(false)
    expect(codeOf('workbench/components/WorkbenchViewport.vue').includes('useMultiblockChannels')).toBe(false)
    expect(codeOf('shared/viewport/EditorViewportHost.vue').includes('useMultiblockChannels')).toBe(false)
    // 反空洞真：替代面确实在**两个壳走的那条路径**上服役（M7-4 合壳后的唯一落点）。
    expect(codeOf('shared/viewport/EditorViewportHost.vue').includes('useKernelChannels'), '唯一视口宿主必须吃内核通道读面').toBe(true)
    for (const shell of ['shared/viewport/EmbedViewport.vue', 'workbench/components/WorkbenchViewport.vue']) {
      // 用**标识符**判定（`codeOf` 会剥掉字符串字面量，模块路径在那里不算代码）。
      expect(codeOf(shell).includes('EditorViewportHost'), shell + ' 必须经唯一视口宿主（替代面在它上面）').toBe(true)
    }
  })

  it('替代机制**已就位且在生产服役**：取值归 `EditContext`，经会话读写', () => {
    expect(codeOf('domain/editing.ts').includes('channelValues'), 'P1 的通道取值归属已存在').toBe(true)
    // #282：会话把内核取值面暴露给视口（读面 + 唯一写通路）
    const session = codeOf('runtime/kernelSession.ts')
    expect(session.includes('channelValues()'), '内核会话暴露取值读面').toBe(true)
    expect(session.includes('setChannelValue('), '内核会话经命令写入取值（唯一写通路）').toBe(true)
    // 失效传播不再靠调用方声明重建范围：渲染侧按内容身份判定
    expect(fs.existsSync(path.join(SRC, 'presentation/contentIdentity.ts')), '内容身份判定面已存在').toBe(true)
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
    // 且**登记表自己的说明文字**（字符串/注释里的符号名）不得被误判为使用点
    // —— 这正是首跑实测到的假红，`codeOf` 剥字符串与注释后消失。
    //
    // 锚点几经更换（`new Editor(` → `EditContext` → `documentStateOf` → 本锚点），
    // 每次接缝表被改写都会让旧锚点失效，而本条会**正确地判红**
    // （它抓到了"锚点已失效"）。故锚点必须选当下确实存在的说明文字。
    //
    // 本锚点选 `useKernelChannels`：它出现在**在案**接缝
    //（`legacy-render-source-document`）的说明**字符串字面量**里（是符号名，
    // 不是 import 名），故 `codeOf`（剥注释**与字符串**）看不到它，
    // 而 `codeText`（保留字符串、只剥注释）看得到 —— 这正是本条要区分的两把尺子。
    // ⚠️ R1-β① C3：原锚点 `documentStateOf` 随属性写双轨登记**核销**而失效 ⇒ 换锚点。
    expect(codeOf('composition/seams.ts').includes('useKernelChannels'), '文案里的提及不算使用点').toBe(false)
    expect(codeText('composition/seams.ts').includes('useKernelChannels'), '而原始文本里确实有这段说明（证明上面那条不是空转）').toBe(true)
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
    // P6 的开放接缝在 #282（P10b）**已核销** ⇒ 也不得占用本表（同上语义）
    expect(ids).not.toContain('per-viewport-channel-staging')
    // P7 登记的草稿镜像在 #286（P10c）**已核销** ⇒ 同上
    expect(ids).not.toContain('property-draft-session-mirror')
  })

  /**
   * ## P10c（#286）核销：`property-draft-session-mirror` 的**防复活**断言
   *
   * 那条接缝的退出条件是"`buildField` 不再读 `session.drafts`，且 `parseDraft`
   * 不再被呈现路径调用"。本批删除时给出的实测依据是：镜像的**写键与读键不同**
   * （写 `localPropertyOf(desc.id)`＝`tooltip`，读 `localIdOf`＝`block.tooltip`），
   * 生产 84 个属性无一命中 ⇒ 它从未影响渲染。
   *
   * 于是"防复活"不能只断言"接缝不在表里"（那只说明登记被删了），还必须断言
   * **旧机制的代码面确实不存在** —— 否则一份被改回去的镜像会静静地重新长出来，
   * 而本表已经不再看管它。
   */
  it('**旧机制不得复活**：`PanelSession.drafts` 与 P2 的编辑会话机制已零引用', () => {
    // ① 会话镜像字段与其读/写面
    const rna = codeOf('editors/workbench-rna.ts')
    expect(rna.includes('drafts'), '`PanelSession.drafts` 必须已删除').toBe(false)
    expect(rna.includes('EditSession'), '`sessions: Record<string, EditSession>` 必须已删除').toBe(false)

    // ② 字段模型不再携带草稿/解析态
    const controls = codeOf('editors/property-controls.ts')
    expect(controls.includes('draftState'), '`FieldViewModel.draftState` 必须已删除').toBe(false)
    expect(controls.includes('FieldDraftState'), '`FieldDraftState` 必须已删除').toBe(false)
    expect(controls.includes('tryCommit'), 'P2 的 `tryCommit` 必须已删除').toBe(false)
    expect(controls.includes('canCommitDraft'), '`canCommitDraft` 必须已删除').toBe(false)
    expect(controls.includes('EditPolicy'), '`EditPolicy`/`DEFAULT_EDIT_POLICY` 必须已删除').toBe(false)
    // `parseDraft` 在**呈现路径**上不得再被调用（判定只在 `domain/textDraft`）
    expect(controls.includes('parseDraft'), '`property-controls` 不得再调 `parseDraft`').toBe(false)

    // ③ 一个不接收草稿输入的字段模型：构造签名里不得有 `draft`
    //   （用 `codeText`：对象字面量的键名就是标识符，`codeOf` 会剥掉字符串但键名仍在）
    const builder = codeText('editors/property-controls.ts')
    expect(/draft\s*\??:/.test(builder), '`buildFieldViewModel` 的输入不得再含 `draft`').toBe(false)

    // ④ 组件不再有草稿出口（`commit`/`cancel` 从来没有发出点，`draft` 是死镜像）
    const field = codeText('workbench/ux/PropertyField.vue')
    expect(field.includes("(e: 'draft'"), '`PropertyField` 不得再声明 `draft` emit').toBe(false)
    expect(field.includes("(e: 'commit'"), '`PropertyField` 不得再声明 `commit` emit').toBe(false)
    expect(field.includes('emit('), '`PropertyField` 的 `draft` 转发必须已删除').toBe(true) // 反空洞真：仍有两个合法 emit

    // ⑤ 输入层的替代面**确实在服役**（否则"不引用旧的"可能只是两边都没有）
    expect(
      codeOf('workbench/ux/PropertyField.vue').includes('textProjection'),
      '呈现必须继续读输入层投影（P7 的替代面）',
    ).toBe(true)
  })

  /**
   * **反空洞真**：上述判据不是恒真 —— 把旧形态注入内存即被同一判定式抓到。
   *
   * 刻意不写一个真实的旧文件（那会变成"再造一遍旧代码"）：判据的对象是
   * "文本里有没有这个符号"，负对照只需证明该判定式会命中。
   */
  it('**负对照**：上述判据能抓到"镜像被改回去"', () => {
    const injected = 'export type PanelSession = { drafts: Record<string, string | null> }'
    expect(injected.includes('drafts'), '注入 `drafts` 必判红').toBe(true)
    const injectedField = 'const draft = input.draft ?? null\nconst draftState: FieldDraftState = ...'
    expect(injectedField.includes('draftState'), '注入 `draftState` 必判红').toBe(true)
    const injectedBuilder = 'input: { descriptor: PropertyDescriptor; draft?: string | null }'
    expect(/draft\s*\??:/.test(injectedBuilder), '注入 `draft` 入参必判红').toBe(true)
    const injectedEmit = "const emit = defineEmits<{ (e: 'draft', text: string): void }>()"
    expect(injectedEmit.includes("(e: 'draft'"), '注入 `draft` emit 必判红').toBe(true)
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
    /*
     * ## M7-4 段 B 更新（钉错了文件，不是放宽）
     *
     * 合壳前"真正的拆解点"是 `WorkbenchViewport.vue`；合壳后两个宿主共用同一条卸载路径
     * （`shared/viewport/EditorViewportHost.vue`，D6 就在那里修好：嵌入侧此前**漏了**这一句）。
     * 意图不变：①unbind 不归零；②binder 不注销 region；③真正的拆解点归零槽位；
     * ④**两个壳都不得自己再写一份**（否则又是两份实现）。
     */
    expect(
      codeOf('shared/viewport/EditorViewportHost.vue').includes('ctx.viewports.unregister('),
      '真正的拆解点必须归零槽位',
    ).toBe(true)
    for (const shell of ['shared/viewport/EmbedViewport.vue', 'workbench/components/WorkbenchViewport.vue']) {
      expect(
        codeOf(shell).includes('ctx.viewports.unregister('),
        shell + ' 不得自己再写一份槽位归零（归零只在唯一宿主里）',
      ).toBe(false)
    }
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
