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
 * 只取**代码**：剥掉行注释、块注释与 **Vue 模板注释** `<!-- … -->`。
 *
 * Vue 模板注释必须一起剥：`WorkbenchRoot.vue` 的退役说明里逐字引用了
 * 旧的 `v-show` 模板行（那是**有价值的历史依据**），若算作残留就会
 * 把"已退役"误判成"未退役"（P6 首跑实测到的假红）。
 */
function codeOf(rel: string): string {
  const raw = read(rel)
  const withoutTemplateComments = raw.replace(/<!--[\s\S]*?-->/g, '')
  return withoutTemplateComments
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n')
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

  it('阻塞方「内核未接线生产」**为真**（模块图级核验；见文件头诚实边界）', () => {
    // 四条独立证据，全部是"模块图级无生产消费者"，不宣称运行期证明。
    const files = productionFiles()

    // ① 生产代码里没有 `new Editor(`（内核执行器零生产构造）
    const editorCtor = files.filter((rel) => codeOf(rel).includes('new Editor('))
    expect(
      editorCtor,
      `内核执行器不得已有生产构造者（若已有，说明接线完成、本条应重新评估）：${editorCtor.join(', ')}`,
    ).toEqual([])

    // ② `runtime/evaluation.ts`（P4 的求值接线）零导入者
    const evalImporters = files.filter(
      (rel) => rel !== 'runtime/evaluation.ts' && /from\s+['"]@\/runtime\/evaluation['"]/.test(codeOf(rel)),
    )
    expect(evalImporters, `runtime/evaluation 不得已有生产导入者：${evalImporters.join(', ')}`).toEqual([])

    // ③ 没有任何生产调用方推进 EditContext 时间
    const timeAdvancers = files.filter(
      (rel) => !['domain/editing.ts', 'domain/animation.ts'].includes(rel) && /advanceContextTime\s*\(/.test(codeOf(rel)),
    )
    expect(timeAdvancers, `不得已有生产调用方推进上下文时间：${timeAdvancers.join(', ')}`).toEqual([])

    // ④ 生产入口不直连内核实现（装配/接线层 composition、editors 除外）
    const entryFiles = ['workbench/WorkbenchRoot.vue', 'dev/DevApp.vue', 'runtime/host/workbenchHost.ts']
    const kernelImports: string[] = []
    for (const rel of entryFiles) {
      if (!fs.existsSync(path.join(SRC, rel))) continue
      for (const m of codeOf(rel).matchAll(/from\s+['"](@\/[^'"]+)['"]/g)) {
        const spec = m[1].replace('@/', '')
        if (/^(domain|application)\//.test(spec) || /^runtime\/(execution|scheduling|effects|evaluation|lifecycle)\.ts$/.test(spec)) {
          kernelImports.push(`${rel} → ${spec}`)
        }
      }
    }
    expect(
      kernelImports,
      `生产入口不得已直连内核实现（接线归 #261）：\n${kernelImports.join('\n')}`,
    ).toEqual([])
  })

  it('**反空洞真**：上述阻塞判据不是恒真 —— 注入构造点即被同一判据抓到', () => {
    // 与 ① 同一个判定式，只换事实来源
    const injected = 'const e = new Editor()'
    expect(injected.includes('new Editor('), '注入的内核构造必须能被抓到').toBe(true)
    const hit = [injected].filter((src) => src.includes('new Editor('))
    expect(hit.length).toBe(1)
    // 而真实生产文件里没有它（上一条已断言为空）
    expect(productionFiles().filter((rel) => codeOf(rel).includes('new Editor('))).toEqual([])
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
    const code = codeOf('workbench/WorkbenchRoot.vue')
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
    const hits: string[] = []
    for (const rel of productionFiles()) {
      if (codeOf(rel).includes('VITE_HOST_PROFILE')) hits.push(rel)
    }
    expect(
      hits,
      `旧环境变量名只允许出现在 composition/shell.ts 的已登记迁移窗口：\n${hits.join('\n')}`,
    ).toEqual(['composition/shell.ts'])
    const shell = codeOf('composition/shell.ts')
    expect(
      [...shell.matchAll(/VITE_HOST_PROFILE/g)].length,
      '迁移窗口取值恰好一处（退出条件：vite wiki 配置改注入 VITE_SHELL_PROFILE）',
    ).toBe(1)
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
