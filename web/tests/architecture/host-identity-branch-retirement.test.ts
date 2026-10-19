/**
 * M7-5 · **宿主身份判断的退役判据**：生产源码里 `isEmbed(` 归零（不是"少了几处"）。
 *
 * ## 判据（三条，各自可判红）
 *
 * | # | 判据 | 负对照 |
 * |---|---|---|
 * | ① **归零**：`src/` 全部生产文件（含组件、**含注释**）里 `isEmbed(` 命中 0 | 往样本注入 `if (ctx.isEmbed())` ⇒ 同一判定函数必须命中；同族名字（`isEmbedTouchScreenPointer`）不得误报 |
 * | ② **差异确实改成了能力/装配**：五个消费面各自查一项**已声明**的能力（屏上手势 / 工具面 / 内容编辑 / 工作台外壳），且 `OperatorType.requires` 有 ≥6 个生产算子在用 | （由 ③ 的注入负对照覆盖能力名漂移） |
 * | ③ **没有死门**：生产里出现的每个 `CAPABILITY.X` 都至少被一个 profile 提供 | 注入一个未声明的能力 ⇒ 同一判定判红 |
 *
 * ## 为什么连注释一起算
 *
 * 判据 ① 的口径是**整个 `src/` 的原始文本**（不做注释剥离）：M7-5 的目标是"这个 API
 * 不再存在"，一句仍写着 `ctx.isEmbed()` 的注释会让下一个人以为它还能调用。
 * 历史解释保留，但用中性描述（见 `composition/modules` 的 M7-5 注释）。
 * 这比 M7-4 的计数口径（剔除注释行）**更严**：剔除注释会放过"定义删了、注释还在"。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CAPABILITY } from '@/composition/modules'
import { ALL_PROFILES } from '@/composition/profiles'
import { resolveComposition } from '@/composition/resolver'

const WEB_ROOT = path.join(import.meta.dirname, '..', '..')
const SRC_ROOT = path.join(WEB_ROOT, 'src')

function readNorm(abs: string): string {
  return fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')
}

/** 生产源码文件（剥掉测试与 node_modules；与同目录其它判据同口径）。 */
function productionFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { walk(full); continue }
      if (!/\.(ts|vue)$/.test(e.name)) continue
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name) || e.name.endsWith('.d.ts')) continue
      out.push(path.relative(WEB_ROOT, full).replace(/\\/g, '/'))
    }
  }
  walk(SRC_ROOT)
  return out.sort()
}

/** 判据 ①：一段文本里的宿主身份调用形状（**不剥注释**）。 */
function hostIdentityCalls(text: string): number {
  return [...text.matchAll(/isEmbed\s*\(/g)].length
}

/** 判据 ③：生产里出现的 `CAPABILITY.<KEY>` 的**取值**集合（未知 key 忽略）。 */
function usedCapabilityIds(files: readonly string[]): Set<string> {
  const ids = new Set<string>()
  for (const rel of files) {
    for (const m of readNorm(path.join(WEB_ROOT, rel)).matchAll(/CAPABILITY\.([A-Z_]+)/g)) {
      const id = (CAPABILITY as Record<string, string>)[m[1] as string]
      if (typeof id === 'string') ids.add(id)
    }
  }
  return ids
}

/** 全部 profile 提供的能力并集（经**生产解析器**算出来，不读文本、不手写数组）。 */
function providedCapabilityIds(): Set<string> {
  const ids = new Set<string>()
  for (const p of ALL_PROFILES) {
    const r = resolveComposition({ profileId: p.id, modules: p.modules })
    if (!r.ok) throw new Error('生产 profile 解析失败：' + p.id)
    for (const id of r.value.capabilities) ids.add(id)
  }
  return ids
}

/** 某生产文件是否出现给定能力的查询形状。 */
function queriesCapability(rel: string, capability: string): boolean {
  const key = Object.entries(CAPABILITY).find(([, v]) => v === capability)?.[0]
  if (key === undefined) return false
  return readNorm(path.join(WEB_ROOT, rel)).includes('CAPABILITY.' + key)
}

describe('M7-5 · 宿主身份判断退役（生产 isEmbed 归零 + 差异改能力/装配）', () => {
  it('① 生产源码里 `isEmbed(` 命中 **0**（含注释、含组件）', () => {
    const files = productionFiles()
    expect(files.length, '反空洞真：必须真的扫到了生产文件').toBeGreaterThan(100)
    const hits = files
      .map((rel) => ({ rel, n: hostIdentityCalls(readNorm(path.join(WEB_ROOT, rel))) }))
      .filter((x) => x.n > 0)
    expect(
      hits,
      '宿主身份判断必须归零（差异改走能力/装配，SPEC §4.1 / §10.10）:\n' + hits.map((h) => h.rel + ' ×' + h.n).join('\n'),
    ).toEqual([])
  })

  it('① 负对照：同一判定函数能抓到注入的调用形状（同族名字不误报）', () => {
    const sample = 'const props = defineProps({})\nexport function f(ctx) { if (ctx.isEmbed()) return }\n'
    expect(hostIdentityCalls(sample), '注入的宿主身份判断必须被抓到（否则上一条是空转）').toBe(1)
    expect(hostIdentityCalls('const x = isEmbedTouchScreenPointer(e)'), '同族名字（屏幕指针判定）不得误报').toBe(0)
  })

  it('② 各消费面查的是**已声明**的能力（不是换名字的第二宿主判别）', () => {
    expect(queriesCapability('src/runtime/attachViewport.ts', CAPABILITY.SCREEN_GESTURES), '视口绑定必须问屏上手势能力').toBe(true)
    expect(queriesCapability('src/handlers/keymapHandler.ts', CAPABILITY.TOOLS_MANIPULATORS), '键位必须问工具面能力').toBe(true)
    expect(queriesCapability('src/handlers/keymapHandler.ts', CAPABILITY.SCREEN_GESTURES), '键位必须问手势面能力').toBe(true)
    expect(queriesCapability('src/handlers/keymapHandler.ts', CAPABILITY.SHELL_WORKBENCH), '键位必须问工作台外壳能力').toBe(true)
    expect(queriesCapability('src/editors/workbench-rna.ts', CAPABILITY.CONTENT_EDIT), '属性写能力必须由 content.edit 决定').toBe(true)
    expect(queriesCapability('src/logging/LogCenter.ts', CAPABILITY.SHELL_WORKBENCH), '诊断摘要的选择读面必须问工作台外壳能力').toBe(true)
    expect(queriesCapability('src/runtime/context.ts', CAPABILITY.SHELL_WORKBENCH), '工作台会话读面必须问工作台外壳能力').toBe(true)
  })

  it('② 算子能力门是**声明式**的，且生产里确有算子在用（反空洞）', () => {
    const files = productionFiles()
    // 只数**算子**里的声明：`src/operators/` 与非算子模块（`composition/profiles`）的
    // `requires` 是模块装配声明，不是算子门（两种 requires 语义不同，不能混算）。
    const operatorDecls = files
      .filter((rel) => rel.startsWith('src/operators/'))
      .flatMap((rel) => [...readNorm(path.join(WEB_ROOT, rel)).matchAll(/^\s*requires:\s*\[/gm)])
    expect(operatorDecls.length, '必须有生产算子声明 requires（否则能力门是空壳）').toBeGreaterThanOrEqual(6)
    const typeText = readNorm(path.join(WEB_ROOT, 'src/operators/operatorType.ts'))
    expect(/requires\?:\s*readonly CapabilityId\[\]/.test(typeText), 'requires 必须是 OperatorType 的声明字段').toBe(true)
    const registry = readNorm(path.join(WEB_ROOT, 'src/operators/operatorRegistry.ts'))
    expect(registry.includes('missingCapabilityOf('), '能力的结算点必须在注册表（两条入口同一处）').toBe(true)
  })

  it('③ 没有"死门"：生产里用到的每个能力都至少被一个 profile 提供', () => {
    const used = [...usedCapabilityIds(productionFiles())]
    expect(used.length, '反空洞真：必须真的扫到了能力查询').toBeGreaterThan(5)
    const provided = providedCapabilityIds()
    const dead = used.filter((id) => !provided.has(id))
    expect(
      dead,
      '这些能力被生产代码查询，却没有任何 profile 提供 ⇒ 对应功能永远不可用（与"能力缺席"同形但无人发现）',
    ).toEqual([])
  })

  it('③ 负对照：未声明的能力会被同一判定抓到', () => {
    const provided = providedCapabilityIds()
    const used = ['tools.manipulators', 'not.declared.anywhere']
    expect(used.filter((id) => !provided.has(id)), '未声明的能力必须被抓到').toEqual(['not.declared.anywhere'])
  })
})
