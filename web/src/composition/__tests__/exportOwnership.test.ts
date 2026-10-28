/**
 * **S5：导出命令的归属判据 + D-8 决策的机械把守**（反转）。
 *
 * ## 这份判据的**反转**（不是放宽）
 *
 * 切链前，本文件把"等轴 PNG **未**切 `ExportJob`"当作**要钉住的现状**（依据是 seam
 * `isometric-export-legacy-bake`）。把导出切到同一条呈现链并把旧烘焙链整文件删除，
 * 于是那两条断言必然变红 —— 它们是**当前态**断言，切链时必须**反转**：
 *
 * | 组 | 切链前 | 切链后（本文件） |
 * |---|---|---|
 * | ① | 五条命令都经 `plainForSave()` | 三条产 JSON/ZIP 的命令经它；等轴 PNG / 场景 GIF 改经内核快照（**不再读旧文档**） |
 * | ② | 仍走 `bakeIsometricStructurePngDataUrl` 且**不**含 `assembleSnapshotExportJob` | **必须**经 `runIsoExport` → `assembleSnapshotExportJob`，且旧入口**不得复活**；旧 seam 必须已退出 |
 * | ③ | `textures` 缺省 ⇒ 材质走中性色（"切过去会丢贴图"） | 端口**真的**绑纹理（设备纹理透传 + `bindTextures`）；"缺省即中性色"保留为**端口形状**的事实 |
 * | ④ | `artifact-host` 四断言仍成立 | 不变（Plain/Envelope/OBJ 仍在 `workbench/export/*`） |
 *
 * ⚠️ ① 的计数从 5 变 3 是**切链的必然结果**（等轴 PNG/GIF 不再取 plain 文档），不是
 * "顺手把计数改小"：`exec` 是 6 = **5 个产品命令**（切链一个没少）+ **1 个验收器具命令**
 * （`OPERATOR_EXPORT_SHOT_PNG`，合入 main 的 Web 内核后按新内核算子形态重接；它同样经
 * `runShotExport` → 同一条捕获/作业链，见 `tests/architecture/export-chain.test.ts` C1）。
 * 下面几条断言一起看才说明这件事。
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

describe('D3/S5 ① 产字节归属：三条 JSON/ZIP 命令仍经 `plainForSave`', () => {
  const commands = 'operators/builtin/exportOperators.ts'

  it('Plain / Envelope / OBJ 三处经 `plainForSave()`；等轴 PNG / 场景 GIF **不再**读旧文档', () => {
    const code = codeOnly(readSrc(commands))
    const hits = code.split('\n').filter((l) => l.includes('plainForSave()')).length
    expect(
      hits,
      'M6-3：等轴 PNG 与场景 GIF 的内容改由内核呈现快照给出 ⇒ 只剩三条命令取 plain 文档（切链前为五条）',
    ).toBe(3)
  })

  it('**反空洞真**：该文件确实还有六处 `exec`（命令一个没少，判据不是对着空文件跑）', () => {
    const code = codeOnly(readSrc(commands))
    const execs = code.split('\n').filter((l) => /exec\(ctx/.test(l)).length
    // Plain / Envelope / OBJ / 等轴 PNG / 场景 GIF = 5 个产品命令（切链不减少命令）
    // + 验收器具 OPERATOR_EXPORT_SHOT_PNG = 6 处（它也经 runShotExport → 同一条作业链）。
    expect(execs).toBe(6)
  })

  it('**旧路径不得复活**：该文件对旧读取入口零命中（真代码口径）', () => {
    expect(
      codeOnly(readSrc(commands)),
      '`getDoc()` 已终删 ⇒ 该文件不得再有真代码调用',
    ).not.toContain('.getDoc(')
  })
})

describe('D3/S5 ② 等轴 PNG 的归属：**已切同链**（原"未切"断言在此反转）', () => {
  it('`ExportIsoPngOperator` 经 `runIsoExport` → `assembleSnapshotExportJob`（旧烘焙入口不得复活）', () => {
    const code = codeOnly(readSrc('operators/builtin/exportOperators.ts'))
    expect(code, '作业入口必须在（M6-3 反转：切链前这里断言的是"不含"）').toContain('runIsoExport')
    expect(code, '旧烘焙入口必须彻底消失').not.toContain('bakeIsometric')
    expect(code, '旧 dataURL 转换入口必须彻底消失').not.toContain('dataUrlToPngBlob')
    // 反空洞真：作业装配确实被执行入口调用（否则"经作业"只是一句源码里的话）
    const runner = codeOnly(readSrc('workbench/export/isoExportJob.ts'))
    expect(runner, '执行入口必须真的调 `assembleSnapshotExportJob`').toContain('assembleSnapshotExportJob')
    expect(runner, '执行入口必须真的跑作业').toContain('.job.run()')
    expect(runner, '捕获必须来自同一个求值点（不是自拼）').toContain('captureExportSnapshot')
  })

  it('该事实**已核销**：旧 seam 不在表里，旧烘焙三文件不在树上（同批退役）', () => {
    expect(seamById('isometric-export-legacy-bake'), '切链完成 ⇒ 登记必须退出（留着会让"双轨剩余数"失真）').toBeUndefined()
    for (const rel of [
      'workbench/exportIsometricImage.ts',
      'workbench/exportAnimatedGif.ts',
      'workbench/animatedGifEncoder.ts',
    ]) {
      expect(fs.existsSync(path.join(WEB_ROOT, 'src', rel)), rel + ' 必须已删除').toBe(false)
    }
  })

  it('替代面**已交付且可核对**（新轨不是空话）', () => {
    expect(fs.existsSync(path.join(WEB_ROOT, 'src', 'adapters', 'export', 'snapshotExportJob.ts'))).toBe(true)
    expect(fs.existsSync(path.join(WEB_ROOT, 'src', 'composition', 'exportCapture.ts'))).toBe(true)
    expect(fs.existsSync(path.join(WEB_ROOT, 'src', 'presentation', 'isoExportCamera.ts'))).toBe(true)
  })

  it('**负对照**：判据能抓到"删了文件却把命令留着"（同一条抓法）', () => {
    // 判定式：命令经作业 **且** 旧文件已删。缺任一半都是违规 ——
    // 前者是能力停摆（禁止的半成品替换），后者是双轨未退（本 seam 的存在理由）。
    const consistent = (commandOnJob: boolean, legacyFilesGone: boolean): boolean => commandOnJob && legacyFilesGone
    expect(consistent(false, true), '旧文件删了但命令没切 ⇒ 违规（能力停摆）').toBe(false)
    expect(consistent(true, false), '命令切了但旧文件还在 ⇒ 违规（双轨未退）').toBe(false)
    expect(consistent(true, true), '切了且删了 ⇒ 合规').toBe(true)
  })
})

describe('D3/S5 ③ 纹理域：端口**真的**绑纹理（反转）', () => {
  it('`SnapshotOffscreenRenderPort` 把捕获期资源绑给会话（设备自建纹理域优先）', () => {
    const code = readSrc('adapters/export/offscreenRenderPort.ts')
    expect(
      /textures\?:\s*TexturePort/.test(code),
      '`textures` 仍是可选（受控设备/测试替身没有纹理域）—— 那是**端口形状**，不是"生产可以不给"',
    ).toBe(true)
    expect(code, '设备自建的纹理域必须优先（G1）').toContain('acquired.value.textures')
    expect(code, '必须真的调用唯一绑定生产点（G2）').toContain('session.bindTextures(')
    expect(code, '绑定必须延迟到首次真重建之后（早于它会绑 0 条）').toContain('this.boundTextureResources')
    // 反空洞真：判据不是对着空文件跑
    expect(code.length, '文件不得为空').toBeGreaterThan(2000)
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

  it('导出路径**不得**再 import 旧材质库/网格构建（贴图改走五态链）', () => {
    // 旧判据断言"现路径确实建了材质库" —— 那正是切链要退役的东西。反转后：
    // 导出路径只允许经 `TextureResource[]` + `bindTextures` 拿贴图。
    const exportFiles = [
      'composition/exportCapture.ts',
      'workbench/export/isoExportJob.ts',
      'adapters/export/offscreenRenderPort.ts',
      'adapters/export/snapshotExportJob.ts',
    ]
    for (const rel of exportFiles) {
      const code = codeOnly(readSrc(rel))
      for (const banned of ['buildMaterialLibrary', 'materialLibraryFromTextures', 'buildBlockMesh', 'simpleMaterialLibrary', 'resolveRenderBundle']) {
        expect(code, rel + ' 不得 import 旧材质/网格入口 ' + banned).not.toContain(banned)
      }
    }
    // 反空洞真：这四条路径确实存在且非空（否则上面是空转）
    for (const rel of exportFiles) expect(readSrc(rel).length).toBeGreaterThan(500)
  })
})

describe('D3/S5 ④ `artifact-host` 四断言的成立条件（任务书预计要改，实测不改）', () => {
  it('Plain/Envelope/OBJ 仍产出 ZIP/JSON ⇒ `bundleMeshAssembly`（jszip 消费者）仍在生产链上', () => {
    const code = codeOnly(readSrc('operators/builtin/exportOperators.ts'))
    // OBJ 走 `buildStructureBundleZip`（zip ⇒ jszip）；Envelope 走 `buildEnvelopePackage`。
    expect(code, 'OBJ 仍打 zip ⇒ jszip 消费者仍在').toContain('buildStructureBundleZip')
    expect(code).toContain('buildEnvelopePackage')
  })

  it('`artifact-host` 的四条断言此刻**仍成立**（故本次不改它们）', () => {
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
    for (const id of ids) expect(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id), id + ' 必须是 kebab-case').toBe(true)
  })

  it('**核销的接缝不得复活**：`side-table-write-legacy-track` 已不在表里，其剩余半边换了名', () => {
    expect(seamById('side-table-write-legacy-track'), '已核销的旧名不得留在表里').toBeUndefined()
    expect(seamById('annotation-wide-field-face'), '剩余半边必须以新名在案').toBeDefined()
  })

  /**
   * R1-β① C3 核销：四条登记的两个退出子句都已同时成立 ⇒ 登记退出。
   *
   * ⚠️ 这些是**回归断言**：核销项**不得**复活回 `SEAMS`（该表语义是"双轨剩余数、
   * 只应减少"）。从"本次保留清单"里移除一项**不是**放宽断言，而是登记退出的机械对账。
   */
  it('**核销的接缝不得复活**：R1-β① C3 核销的四条不在表里', () => {
    for (const id of [
      'legacy-document-in-place-edit',
      'property-write-legacy-document-model',
      'kernel-property-write-dual-track',
      'legacy-grid-edit-handle',
    ]) {
      expect(seamById(id), id + ' 已核销 ⇒ 不得复活').toBeUndefined()
    }
    // 正面半边：核销的**能力**必须有新落点（"删掉了事"不算退出）。
    expect(seamById('annotation-wide-field-face'), '注解宽字段面仍在案（只兑现了一部分）').toBeDefined()
    expect(seamById('legacy-render-source-document'), '定义/图标面与最后 1 处消费者仍在旧文档上 ⇒ 该条仍在案').toBeDefined()
  })

  /**
   * **C8 核销的接缝**（同族的回归断言）。
   */
  it('**C8 核销的接缝不得复活**：`presenter-surface-dual-track` 不在表里', () => {
    expect(seamById('presenter-surface-dual-track'), 'C8 已核销 ⇒ 不得复活').toBeUndefined()
  })

  /**
   * **核销**：`isometric-export-legacy-bake` 随旧烘焙链删除而退出（六条可机检条件
   * 同时成立，逐条证据写在 `seams.ts` 的同名核销注释处）。
   */
  it('**已核销的接缝不得复活**：`isometric-export-legacy-bake` 不在表里', () => {
    expect(seamById('isometric-export-legacy-bake'), 'M6-3 已核销 ⇒ 不得复活').toBeUndefined()
  })

  it('本次保留的接缝都在（终删暴露的欠账可数）', () => {
    for (const id of [
      'legacy-render-source-document',
      'annotation-wide-field-face',
      'export-borrows-live-viewport-dual-track',
      'export-asset-manifest-unwired',
    ]) {
      expect(seamById(id), id + ' 必须在案').toBeDefined()
    }
  })
})
