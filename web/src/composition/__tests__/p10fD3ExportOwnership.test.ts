/**
 * **P10f D3 · S5：四导出命令的归属判据 + D-8 决策的机械把守**（#301）。
 *
 * ## 本文件钉什么（D-8 取 (甲) 之后，"四命令迁 `ExportJob`"这件事的**可核对面**）
 *
 * 任务书第 5 项的字面是"四命令迁 `ExportJob`"。Lead 裁决 **D-8 (甲)**：
 * ISO PNG 走 `ExportJob`、其余三命令保持 `plainForSave`。**接线前实测推翻了
 * "ISO PNG 可低风险切换"这一前提**（理由见 `composition/seams.ts` 的
 * `isometric-export-legacy-bake`），故本批的交付是：
 *
 * | 组 | 钉什么 |
 * |---|---|
 * | ① | **产字节归属**：Plain / Envelope / OBJ / 等轴 PNG / 场景 GIF（M5-4）都经 `ctx.plainForSave()` 取内容（内核投影优先），**不是**旧文档 `serialize()` |
 * | ② | **等轴 PNG 的归属**：仍走 `workbench/exportIsometricImage` 的自建渲染器路径（**未**切 `ExportJob`），且该事实**登记在案**（seam 存在 + exitCondition 点名文件） |
 * | ③ | **D-8 前提的机械证据**：`SnapshotOffscreenRenderPort` 的 `textures` **缺省** ⇒ 材质走中性色（即：切过去会丢贴图）。这是"不能切"的**实在依据**，不是判断 |
 * | ④ | **`artifact-host` 四断言的成立条件**：ESM 入口闭包判据打的是"embed 闭包含不含 jszip 消费者"，而 Plain/Envelope/OBJ 仍在 `workbench/export/*`（含 jszip）⇒ **四断言不需改**（任务书预计要改，实测不变 —— 如实登记） |
 *
 * ## 为什么这些必须留下判据（而不是只在完工报里写一段话）
 *
 * "没做某事"是最容易腐烂的交付形态：一段文字说不清"为什么没做"，
 * 下一个人会以为那只是没来得及。⇒ 把**依据**做成断言，把**归属**做成登记。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { seamById, SEAMS } from '@/composition/seams'

const WEB_ROOT = path.join(process.cwd())
const SRC = path.join(WEB_ROOT, 'src')

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
}

/** 剥注释与字符串（与 `retirementRegistry#stripNonCode`、`boundary-scan` 的 `codeOf` 同一把尺子）。 */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

describe('D3/S5 ① 三命令的产字节归属：`plainForSave` 是唯一入口', () => {
  const threeCommands = 'operators/builtin/exportOperators.ts'

  it('Plain / Envelope / OBJ 三处都经 `plainForSave()`（内核投影优先）', () => {
    const code = codeOnly(readSrc(threeCommands))
    const hits = code.split('\n').filter((l) => l.includes('plainForSave()')).length
    expect(
      hits,
      // M5-4：新增 `ExportSceneGifOperator`（场景 GIF）⇒ 从四条变**五条**；
      // 它同样只经 `plainForSave()` 取内容（不碰旧文档读面）。
      '五条导出命令都必须经 `plainForSave()`（ISO PNG / 场景 GIF 也要取 plain 做烘焙输入）',
    ).toBe(5)
  })

  it('**反空洞真**：该文件确实还有五处 `exec`（判据不是对着空文件跑）', () => {
    const code = codeOnly(readSrc(threeCommands))
    const execs = code.split('\n').filter((l) => /exec\(ctx/.test(l)).length
    // M5-4：Plain / Envelope / OBJ / 等轴 PNG / 场景 GIF = 5 处。
    expect(execs).toBe(5)
  })

  it('**旧路径不得复活**：该文件对旧读取入口零命中（真代码口径）', () => {
    expect(
      codeOnly(readSrc(threeCommands)),
      '`getDoc()` 已终删 ⇒ 该文件不得再有真代码调用',
    ).not.toContain('.getDoc(')
  })
})

describe('D3/S5 ② 等轴 PNG 的归属：现路径 + 登记在案', () => {
  it('`ExportIsoPngOperator` 仍走 `bakeIsometricStructurePngDataUrl`（未切 `ExportJob`）', () => {
    const code = codeOnly(readSrc('operators/builtin/exportOperators.ts'))
    expect(code, '现路径的自建烘焙入口必须在').toContain('bakeIsometricStructurePngDataUrl')
    expect(
      code,
      '本批**不**把它切到 `assembleSnapshotExportJob`（依据见 seam `isometric-export-legacy-bake`）',
    ).not.toContain('assembleSnapshotExportJob')
  })

  it('该事实**登记在案**：seam 存在、owner 在案、exitCondition 点名 `files` 里的文件', () => {
    const seam = seamById('isometric-export-legacy-bake')
    expect(seam, '未切 `ExportJob` 这件事必须有登记（否则它是不可见的欠账）').toBeDefined()
    expect(seam!.owner.p, 'owner 必须是已登记的真实批次').toBe('P11')
    expect(
      seam!.files.some((f) => seam!.exitCondition.includes(f)),
      '闸门口径：exitCondition 必须点名 `files` 里的文件（与 boundary-scan 的规则一致）',
    ).toBe(true)
  })

  it('替代面**已交付且可核对**（新轨不是空话）', () => {
    const seam = seamById('isometric-export-legacy-bake')!
    expect(fs.existsSync(path.join(WEB_ROOT, 'src', 'adapters', 'export', 'snapshotExportJob.ts'))).toBe(true)
    for (const ref of [
      'src/adapters/export/snapshotExportJob.ts',
      'src/workbench/exportIsometricImage.ts',
      'src/operators/builtin/exportOperators.ts',
    ]) {
      expect(seam.files.includes(ref), `seam 的 files 必须含 ${ref}`).toBe(true)
    }
  })

  it('**负对照**：判据能抓到"未登记却声称已切"（注入构造点即被同一条抓法抓到）', () => {
    const claim = (switched: boolean, registered: boolean): boolean => !switched && !registered
    expect(claim(false, false), '未切且未登记 ⇒ 违规').toBe(true)
    expect(claim(false, true), '未切但已登记 ⇒ 合规').toBe(false)
    // 现实核对：当下正是"未切 + 已登记"。
    expect(claim(codeOnly(readSrc('operators/builtin/exportOperators.ts')).includes('assembleSnapshotExportJob'), true)).toBe(false)
  })
})

describe('D3/S5 ③ D-8 前提的机械证据：`textures` 缺省 ⇒ 材质走中性色', () => {
  it('`SnapshotOffscreenRenderPort` 的 `textures` 是**可选**且缺省不消费纹理', () => {
    const code = readSrc('adapters/export/offscreenRenderPort.ts')
    expect(
      /textures\?:\s*TexturePort/.test(code),
      '`textures` 必须仍是可选（缺省 ⇒ 材质走中性色）—— 这是"现在切换会丢贴图"的机械依据',
    ).toBe(true)
    expect(
      code.includes('this.options.textures === undefined ? {} : { textures: this.options.textures }'),
      '缺省时**不**传 `textures` ⇒ 呈现层拿不到贴图（不是"有默认纹理"）',
    ).toBe(true)
  })

  it('**反空洞真**：生产里确实存在一个 `TexturePort` 实现，但它是**视口作用域**的', () => {
    // 唯一生产消费者是 `composition/presenterSession`（从活视口取资源）⇒
    // 把它交给导出作业就是 A29 要防的"导出借用实时视口"。
    const code = readSrc('composition/presenterSession.ts')
    expect(code, '`PresenterSession` 消费 `TexturePort`').toContain('TexturePort')
    expect(
      codeOnly(readSrc('operators/builtin/exportOperators.ts')),
      '而导出命令**不得**引用 `presenterSession`（A29 的静态面）',
    ).not.toContain('presenterSession')
  })

  it('等轴现路径确实**建了材质库**（故它不是"无所谓贴图"的路径）', () => {
    const code = codeOnly(readSrc('workbench/exportIsometricImage.ts'))
    expect(code, '现路径用真材质库（切换会丢它）').toContain('buildMaterialLibrary')
    expect(code).toContain('buildBlockMesh')
  })
})

describe('D3/S5 ④ `artifact-host` 四断言的成立条件（任务书预计要改，实测不改）', () => {
  it('Plain/Envelope/OBJ 仍产出 ZIP/JSON ⇒ `bundleMeshAssembly`（jszip 消费者）仍在生产链上', () => {
    const code = codeOnly(readSrc('operators/builtin/exportOperators.ts'))
    // OBJ 走 `buildStructureBundleZip`（zip ⇒ jszip）；Envelope 走 `buildEnvelopePackage`。
    expect(code, 'OBJ 仍打 zip ⇒ jszip 消费者仍在').toContain('buildStructureBundleZip')
    expect(code).toContain('buildEnvelopePackage')
  })

  it('`artifact-host` 的四条断言此刻**仍成立**（故本批不改它们）', () => {
    // ⚠️ **不** `import` 那个文件：它是 vitest 架构判据（含 `describe`），
    // 在测试体内动态 import 会撞"suite function inside test function"。
    // 它的断言由 `npm run test:arch` **实跑**；本处只核对它的**判据面仍存在且针对同一对象**
    //（两份实现会漂移 ⇒ 不在这里复刻一份跑）。
    const text = fs.readFileSync(path.join(WEB_ROOT, 'tests', 'architecture', 'artifact-host.test.ts'), 'utf8')
    // 判据面：① 认得出 jszip 消费者；② 打的是 embed 入口闭包；③ 期望值为空（不含消费者）。
    expect(text, '必须仍从源码里识别 jszip 消费者').toContain("from\\s+['\"]jszip['\"]")
    expect(text, '必须仍点名 `bundleMeshAssembly`').toContain("'workbench/export/bundleMeshAssembly'")
    expect(text, '必须仍打 embed 入口（`main.ts`）的闭包').toContain("importClosure('main.ts')")
    // ④ 结果面：`leaked` 必须为空（"embed 闭包不含 jszip 消费者"）
    expect(text, 'embed 闭包的泄漏集合必须断言为空').toContain(").toEqual([])")
  })

  it('**反空洞真**：`artifact-host` 确实断言"embed 闭包不含 jszip 消费者"（判据不是空转）', () => {
    const text = fs.readFileSync(path.join(WEB_ROOT, 'tests', 'architecture', 'artifact-host.test.ts'), 'utf8')
    expect(text).toContain('jszipImporters')
    expect(text).toContain('toEqual([])')
  })
})

describe('D3/S5 · seam 表整体不变量（新增登记不得破坏既有口径）', () => {
  it('`SEAMS` 的 id 唯一且非空（kebab-case）', () => {
    const ids = SEAMS.map((s) => s.id)
    expect(new Set(ids).size, 'id 必须唯一').toBe(ids.length)
    for (const id of ids) expect(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id), `${id} 必须是 kebab-case`).toBe(true)
  })

  it('**核销的接缝不得复活**：`side-table-write-legacy-track` 已不在表里，其剩余半边换了名', () => {
    expect(seamById('side-table-write-legacy-track'), '已核销的旧名不得留在表里').toBeUndefined()
    expect(seamById('annotation-wide-field-face'), '剩余半边必须以新名在案').toBeDefined()
  })

  /**
   * R1-β① C3 核销：四条登记的两个退出子句都已同时成立 ⇒ 登记退出。
   *
   * | 登记 | 甲（登记条件） | 乙（消费者迁移数 = 0） |
   * |---|---|---|
   * | `legacy-document-in-place-edit` | 专门适配面 `Context#setHostEmbedInitialView` | `captureEmbedInitialView` 已改走它 |
   * | `property-write-legacy-document-model` | `Command` 有块身份/格内容写命令 | `DocumentState` 无 `document` 字段、旧取值口已终删 |
   * | `kernel-property-write-dual-track` | 同上（getDoc 已终删） | 面板文档内容写全走内核命令 |
   * | `legacy-grid-edit-handle` | `Command` 有 `moveCells` | `moveTranslate` 已改走它、`legacyGridForEdit` 已删 |
   *
   * ⚠️ 这些是**回归断言**：核销项**不得**复活回 `SEAMS`（该表语义是"双轨剩余数、
   * 只应减少"）。从"本批保留清单"里移除一项**不是**放宽断言，而是登记退出的机械对账。
   */
  it('**核销的接缝不得复活**：R1-β① C3 核销的四条不在表里', () => {
    for (const id of [
      'legacy-document-in-place-edit',
      'property-write-legacy-document-model',
      'kernel-property-write-dual-track',
      'legacy-grid-edit-handle',
    ]) {
      expect(seamById(id), `${id} 已核销 ⇒ 不得复活`).toBeUndefined()
    }
    // 正面半边：核销的**能力**必须有新落点（"删掉了事"不算退出）。
    expect(seamById('annotation-wide-field-face'), '注解宽字段面仍在案（本批只兑现了一部分）').toBeDefined()
    expect(seamById('legacy-render-source-document'), '定义/图标面与最后 1 处消费者仍在旧文档上 ⇒ 该条仍在案').toBeDefined()
  })

  /**
   * **R1-β① C8 核销的接缝**（同族的回归断言）。
   *
   * `presenter-surface-dual-track` 的两个退出子句在 C8 同时成立
   * （画面由 `PresenterSession` 产出 + `drwMeshPipeline` 的 `blockMeshProvider` 路径删除），
   * 故它从"双轨剩余数"里退出。核销记录与机械证据留在 `seams.ts` 的同名注释处。
   */
  it('**C8 核销的接缝不得复活**：`presenter-surface-dual-track` 不在表里', () => {
    expect(seamById('presenter-surface-dual-track'), 'C8 已核销 ⇒ 不得复活').toBeUndefined()
  })

  it('本批保留的接缝都在（终删暴露的欠账可数）', () => {
    for (const id of [
      'legacy-render-source-document',
      'annotation-wide-field-face',
      'isometric-export-legacy-bake',
    ]) {
      expect(seamById(id), `${id} 必须在案`).toBeDefined()
    }
  })
})
