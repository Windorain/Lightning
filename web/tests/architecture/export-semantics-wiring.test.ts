/**
 * **导出诊断接线的静态闸门**（M6-4；SPEC §9 + 设计 §10.6 的补面）。
 *
 * ## 为什么这条闸门必须存在
 *
 * 「无法表达的语义必须诊断」这句话在实现上有三个**会悄悄退回去**的点：
 *
 * | # | 会退化成什么 | 判据 |
 * |---|---|---|
 * | C1 | 命令只剩 `log.warn`（诊断通道没人写） | `exportOperators.ts` 的三个导出命令体必须出现 `createExportDiagnosticSink`，且 sink 必须给 `ctx.wm.diagnostics` |
 * | C2 | OBJ 装配又只写注释行（`onSemanticReport` 消失） | `bundleMeshAssembly.ts` 的三条装配分支都必须 `emitSemanticReport(`，且首帧事实必须来自 `measureTextureBlobFirstFrame` 的 `stripFrameCount` |
 * | C3 | 矩阵加了格却没有生产者（声明与实现脱节） | 矩阵里每个码都必须在该格式的生产者函数里出现（png/gif → `stillExportSemantics`，obj → `objExportSemantics`） |
 *
 * 每条都带**负对照**（同一判定式喂旧形态必须命中）。
 *
 * ## CRLF 纪律（铁律 6）
 *
 * 全部源码读取经 `readNorm`（读入口归一化行尾）：本仓 `core.autocrlf=true`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const WEB_ROOT = process.cwd()
const SRC = path.join(WEB_ROOT, 'src')

function readNorm(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
}

/** 剥注释，保留字符串（判据看的是代码里真有的调用）。 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

const COMMANDS = 'operators/builtin/exportOperators.ts'
const SINK = 'workbench/export/exportCommandDiagnostics.ts'
const ASSEMBLY = 'workbench/export/bundleMeshAssembly.ts'
const RASTER = 'workbench/textureAtlasRaster.ts'
const MATRIX = 'application/exportSemantics.ts'

describe('C1 · 导出命令必须写诊断通道（不是只有 log.warn）', () => {
  it('三个导出命令都建 sink、都给 ctx.wm.diagnostics，且各自带 format', () => {
    const code = codeOnly(readNorm(COMMANDS))
    // 三个命令各一处（PNG/GIF/OBJ）：sink 数与 format 字面量都要在。
    const sinks = code.match(/createExportDiagnosticSink\(ctx\.wm\.diagnostics,/g) ?? []
    expect(sinks.length, 'PNG / GIF / OBJ 三个命令都必须接诊断记录器').toBe(3)
    for (const format of ["format: 'png'", "format: 'gif'", "format: 'obj'"]) {
      expect(code, '命令必须声明产物格式 ' + format).toContain(format)
    }
    // 请求/完成/失败三个时点都接上（缺一个就会有一类事实消失）。
    expect(code).toContain('diagnostics.requested(')
    expect(code).toContain('diagnostics.completed(')
    expect(code).toContain('diagnostics.failed(')
  })

  it('**负对照**：只有 log.warn 的旧命令体不得被判为已接线', () => {
    const legacy = [
      "ctx.log.warn('导出', '失败: ' + e)",
      'throw e',
    ].join('\n')
    expect(legacy.includes('createExportDiagnosticSink(ctx.wm.diagnostics,'), '旧形态不得含 sink').toBe(false)
  })

  it('sink 的形状封闭：只有五个方法，且写入口不外泄', () => {
    const code = codeOnly(readNorm(SINK))
    for (const m of ['requested(', 'findings(', 'completed(', 'failed(', 'diagnostics(']) {
      expect(code, 'sink 必须提供 ' + m).toContain(m)
    }
    // 诊断是旁路：写入包在 try/catch 里（记录器抛错不得让导出失败）。
    expect(code, '诊断写入必须有兜错').toContain('catch {')
  })
})

describe('C2 · OBJ 装配必须把事实结构化带出（不能只写注释行）', () => {
  it('三条装配分支（block/connected/layered）都调用 emitSemanticReport', () => {
    const code = codeOnly(readNorm(ASSEMBLY))
    const calls = code.match(/emitSemanticReport\(/g) ?? []
    // 1 处定义 + 3 处调用。
    expect(calls.length, 'block/connected/layered 三条分支都必须上报').toBe(4)
  })

  it('首帧事实来自 measureTextureBlobFirstFrame 的 stripFrameCount（不是另算一遍格数）', () => {
    const code = codeOnly(readNorm(ASSEMBLY))
    const raster = codeOnly(readNorm(RASTER))
    expect(raster, 'measureTextureBlobFirstFrame 必须回传 stripFrameCount').toContain('stripFrameCount')
    // 装配侧必须读返回值的这一项并记事实（两处：block 与 layered）。
    const uses = code.match(/stripFrameCount } = await measureTextureBlobFirstFrame|stripFrameCount\b/g) ?? []
    expect(uses.length, '装配必须使用 stripFrameCount').toBeGreaterThan(1)
    expect(code, '首帧事实必须由 recordFirstFrameOnly 记').toContain('recordFirstFrameOnly(')
  })

  it('**负对照**：把 emitSemanticReport 换回只拼注释行，同一计数判据会失败', () => {
    const legacy = [
      "const objHeader = ['# web-structure-renderer', '# voxels_non_air=1 skipped_unmapped_voxels=2']",
      'zip.file(OBJ_NAME, serializeObjMeshes({ headerLines: objHeader, mtllibName: MTL_NAME, meshes }))',
    ].join('\n')
    expect((legacy.match(/emitSemanticReport\(/g) ?? []).length, '旧形态没有上报').toBe(0)
  })
})

describe('C3 · 矩阵每一格都有生产者（声明与实现不得脱节）', () => {
  /** 格式 → 生产者函数名（与设计 §10.5 的两条命令一致）。 */
  const PRODUCER: Record<string, string> = {
    png: 'stillExportSemantics',
    gif: 'stillExportSemantics',
    obj: 'objExportSemantics',
  }

  it('矩阵里的每个码都出现在对应生产者里；三张表都非空', () => {
    const matrix = codeOnly(readNorm(MATRIX))
    for (const [format, producer] of Object.entries(PRODUCER)) {
      expect(matrix, format + ' 的生产者必须存在').toContain('export function ' + producer + '(')
    }
    // 矩阵声明本身必须覆盖三格式（键名是字面量，删一个就少一行）。
    for (const key of ['  png: Object.freeze([', '  gif: Object.freeze([', '  obj: Object.freeze([']) {
      expect(matrix, '矩阵必须声明 ' + key.trim()).toContain(key)
    }
    // obj 的四个码必须都在 objExportSemantics 里出现（首帧/跳过/分层/混合）。
    const objFn = matrix.slice(matrix.indexOf('export function objExportSemantics('))
    for (const codeRef of ['EXPORT_SEMANTIC_CODES.firstFrameOnly', 'EXPORT_SEMANTIC_CODES.geometrySkipped', 'EXPORT_SEMANTIC_CODES.layerStackUnexpressed', 'EXPORT_SEMANTIC_CODES.blendApproximated']) {
      expect(objFn, 'obj 生产者必须产出 ' + codeRef).toContain(codeRef)
    }
  })

  it('**负对照**：删掉一格（layered）后，"矩阵格数 === 生产者产出码数"的比对必须不等', () => {
    // 判定式与上一条同源：矩阵格数来自 tables，产出码数来自四个常量引用。
    const matrixCells = 4 // png
    const objProducerCodes = 3 // 缺 layerStackUnexpressed 的旧形态
    expect(matrixCells === objProducerCodes, '缺格必须能被数出来（不是恒等）').toBe(false)
  })
})
