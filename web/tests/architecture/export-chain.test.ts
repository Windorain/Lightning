/**
 * **导出链闸门（M6-3）**：命令**必须经作业**，且导出层不得绕道旧材质/网格入口。
 *
 * ## 为什么这条闸门必须在 seam 删除的同一批入库
 *
 * `isometric-export-legacy-bake` 的核销条件之一（$8.5 第 6 条）就是"新判据接棒"。
 * 删掉登记却没有判据 = 下一次有人把命令改回自建渲染器时**没有任何东西会响**
 * （"没做某事"与"做了又退回去"在无判据时不可区分）。
 *
 * ## 四条判据（每条都自带负对照）
 *
 * | # | 判据 | 负对照（同一判定式喂旧形态必须命中） |
 * |---|---|---|
 * | C1 | 两个导出命令**经作业入口**（`runIsoExport`），且命令体**不含** `bakeIsometric` | 旧命令体（调 `bakeIsometricStructurePngDataUrl`） |
 * | C2 | 作业入口真的装配并运行（`assembleSnapshotExportJob` + `.job.run()`） | 一个"只捕获不运行"的空壳 |
 * | C3 | 导出层**不得** import 旧材质库/网格构建（`simpleMaterialLibrary` / `buildMaterialLibrary` / `buildBlockMesh`） | 注入一条 import |
 * | C4 | 逐帧时延**不得**自算（`*` 5 形式的 ticks→厘秒），必须经 `delayCsOf`/`planSequenceLoop` | 旧表达式 `(defaultFrametimeTicks ?? 1) * 5` |
 * | C5 | 导出边长只有**一个来源**（`EXPORT_PIXEL_SIZE`），调用点不写字面量；夹取只在命令侧一处 | 旧形态 `pixelSize: 480` / `pixelSize: 320`（Q1 的 480/320 分叉） |
 *
 * ## C4 为什么必须存在（判定迁移，不是新判据）
 *
 * 材质卡 GIF 的 `materialGifPerFrameDelay.test.ts` 随被测文件（`materialOperators` 的
 * `ExportGifOperator`）一起退役。它判的是"逐帧时延来自声明、不得 ticks*5 自算"——
 * 那条判定现在落在**唯一的 GIF 入口**（场景 GIF）上，故必须以静态判据的形态存活。
 *
 * ## 读源码一律归一化行尾（铁律 6：`core.autocrlf=true`）
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const WEB_ROOT = path.join(process.cwd())
const SRC = path.join(WEB_ROOT, 'src')

function readSource(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
}

/** 剥注释（行/块），保留字符串：C4 要看的表达式在代码里。 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
}

/** 两个导出命令的文件与作业执行入口（**唯一**允许出现装配调用的那两处）。 */
const COMMANDS = 'operators/builtin/exportOperators.ts'
const RUNNER = 'workbench/export/isoExportJob.ts'

/** 导出层：只要落在这些路径，就受 C3/C4 约束。 */
const EXPORT_LAYER_FILES = [
  'adapters/export/snapshotExportJob.ts',
  'adapters/export/offscreenRenderPort.ts',
  'adapters/export/encoderPort.ts',
  'adapters/export/gifEncoderPort.ts',
  'adapters/export/gifEncoder.ts',
  'adapters/export/abortBridge.ts',
  'application/exportPlan.ts',
  'application/captureInput.ts',
  'composition/exportCapture.ts',
  RUNNER,
  COMMANDS,
  // M6-4：导出**语义矩阵**与它的命令侧接线同样属于"导出实现"——
  // 漏掉它们等于给新文件一张"不得 import 旧材质库 / 不得自算 ticks"的免查券。
  'application/exportSemantics.ts',
  'workbench/export/exportCommandDiagnostics.ts',
  // M6-4：OBJ 装配/栅格化在本批**不入 C3**（Q4 裁决：OBJ 不同批切链，只登记缺口）。
  // 它们保留对旧网格/材质入口的既有依赖（`bundleMaterialBaking` 的
  // `BuildBlockMeshOptions` 是**类型**依赖），强行纳入 C3 只会逼出一个假绿豁免。
  // ⇒ 只把它们纳入 C4（不得自算逐帧时延）—— 那条与"哪个格式"无关。
]

describe('C1 · 导出命令**必须经作业**（自建烘焙入口不得复活）', () => {
  it('两个命令都调作业入口，且命令体不含 `bakeIsometric*`', () => {
    const code = codeOnly(readSource(COMMANDS))
    expect(code, '等轴 PNG 命令必须经作业入口').toContain("kind: 'image'")
    expect(code, '场景 GIF 命令必须经作业入口').toContain("kind: 'animation'")
    expect(code, '两个命令都必须调 runIsoExport').toContain('runIsoExport(ctx')
    for (const banned of ['bakeIsometricStructurePngDataUrl', 'bakeIsometricGifBlob', 'dataUrlToPngBlob', 'openIsometricStage']) {
      expect(code, '命令不得再出现旧烘焙入口 ' + banned).not.toContain(banned)
    }
  })

  it('**负对照**：旧命令体喂给同一判定必须命中', () => {
    const legacy = [
      "const directionIndex = resolveIsoDirection(_props.direction)",
      'const dataUrl = await bakeIsometricStructurePngDataUrl(doc, directionIndex, { seconds })',
      'const blob = dataUrlToPngBlob(dataUrl)',
    ].join('\n')
    expect(legacy.includes('bakeIsometricStructurePngDataUrl'), '负对照：旧形态必须命中').toBe(true)
    expect(legacy.includes('runIsoExport(ctx'), '负对照：旧形态**不**含作业入口（证明上面的断言不是恒真）').toBe(false)
  })
})

describe('C2 · 作业入口真的装配并运行（不是"捕获完就丢"）', () => {
  it('执行入口含 `assembleSnapshotExportJob` 与 `.job.run()`，且两者与捕获同处一条链', () => {
    const code = codeOnly(readSource(RUNNER))
    expect(code, '必须装配冻结作业').toContain('assembleSnapshotExportJob(')
    expect(code, '必须真的运行').toContain('const outcome = await handlers.job.run()')
    expect(code, '捕获必须来自同一个求值点').toContain('captureExportSnapshot(')
    // 顺序：捕获在装配之前（反过来就不可能把捕获值喂进请求）
    expect(code.indexOf('captureExportSnapshot('), '捕获必须在装配之前').toBeLessThan(code.indexOf('assembleSnapshotExportJob('))
    // 失败/取消不得产出字节（取消路径的判据在同目录的 exportWiring 里）
    expect(code, '取消必须显式失败').toContain("outcome.status === 'cancelled'")
  })

  it('**负对照**：只捕获不运行的实现会被上面两条抓到', () => {
    const shell = 'const capture = await captureExportSnapshot(source, options)\nreturn ok({ capture })'
    expect(shell.includes('assembleSnapshotExportJob('), '负对照：空壳不含装配').toBe(false)
    expect(shell.includes('.job.run()'), '负对照：空壳不含运行').toBe(false)
  })
})

describe('C3 · 导出层不得 import 旧材质库/网格构建（不借道旧几何语义）', () => {
  const BANNED = ['render/materials/simpleMaterialLibrary', 'render/data/buildMaterialLibrary', 'render/mesh/blockMesh']

  it('导出层文件对这些模块零命中（真代码口径）', () => {
    const hits: string[] = []
    for (const rel of EXPORT_LAYER_FILES) {
      const code = codeOnly(readSource(rel))
      for (const banned of BANNED) if (code.includes(banned)) hits.push(rel + ' → ' + banned)
    }
    expect(hits, '导出层绕道旧材质/网格入口:\n' + hits.join('\n')).toEqual([])
  })

  it('**反空洞真**：这些文件确实存在且非空；**负对照**注入一条 import 必须命中', () => {
    for (const rel of EXPORT_LAYER_FILES) expect(readSource(rel).length).toBeGreaterThan(200)
    const injected = "import { buildMaterialLibrary } from '@/render/data/buildMaterialLibrary'"
    expect(BANNED.some((b) => injected.includes(b)), '负对照：注入的旧 import 必须命中判定').toBe(true)
  })
})

/**
 * **C4 的判定面 = 全树生产源码**（M6-5 收口；设计 §10.6「全树不得再有 ticks*5 自算」）。
 *
 * 原先 C4 只扫两张**手列**清单（`EXPORT_LAYER_FILES` + OBJ 的三个额外文件）。
 * 手列清单的漏项就是免查券：新文件只要没被列进去，自算 tick 就全绿 —— 而
 * "逐帧时延必须来自声明"与**哪个文件**无关，它属于整棵生产树（Q2 之后材质卡的
 * 自算入口已随 `materialOperators` 退役，判定更不能只盯着导出目录）。
 * 故判定面改为 `src/**` 全量（排除 `__tests__` 与 `*.test.*`/`*.spec.*`）。
 */
function productionSources(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { walk(full); continue }
      if (!/\.(ts|tsx|mts|vue)$/.test(e.name) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name)) continue
      out.push(path.relative(SRC, full).replace(/\\/g, '/'))
    }
  }
  walk(SRC)
  return out
}

describe('C5 · 离屏读回必须做**线性 → sRGB**（M6-3 色彩回归的静态把守）', () => {
  /**
   * 这条守卫的是 M6-3 修复环的根因：three 渲染到 render target 时输出恒为线性
   * （`outputColorSpace` 只在渲染到 canvas 时生效）⇒ 少了编码这一跳，导出整体偏暗约 2×。
   *
   * 行为面由 `e2e/export-color-parity.spec.ts` 判（导出亮度 vs 视口）；本处只钉
   * "**那一段代码还在、且位于读回与返回之间**"——防它被顺手删掉而没有任何东西会响。
   */
  it('`renderDevice` 在 readRenderTargetPixels 之后、返回之前调用 encodeLinearRgbaToSrgb', () => {
    const code = codeOnly(readSource('adapters/export/renderDevice.ts'))
    const readAt = code.indexOf('readRenderTargetPixels(')
    const encAt = code.indexOf('encodeLinearRgbaToSrgb(')
    const retAt = code.indexOf('return ok(pixels)')
    expect(readAt, '读回点必须在').toBeGreaterThan(-1)
    expect(encAt, '编码点必须在（否则导出按线性值写出 ⇒ 整体偏暗）').toBeGreaterThan(readAt)
    expect(retAt, '返回点必须在').toBeGreaterThan(encAt)
  })

  it('编码实现是纯函数（无 GL/DOM/three import）—— 故它能在 vitest 里逐值断言', () => {
    const code = readSource('adapters/export/srgbEncode.ts')
    expect(code, '不得 import three（编码是标量数学，不是渲染）').not.toContain("from 'three'")
    expect(code, '不得碰 DOM').not.toContain('document.')
    expect(code, '必须导出查表入口（判据用同一张表，避免自算一份）').toContain('srgbEncodeTable')
    expect(code.length, '文件不得为空').toBeGreaterThan(800)
  })

  it('**负对照**：把编码调用删掉（= 修复前的形态）会被上面第一条抓到', () => {
    const broken = readSource('adapters/export/renderDevice.ts').replace(/encodeLinearRgbaToSrgb\(pixels\)/g, 'void encodeLinearRgbaToSrgb')
    const code = codeOnly(broken)
    const readAt = code.indexOf('readRenderTargetPixels(')
    const encAt = code.indexOf('encodeLinearRgbaToSrgb(')
    // 判定式与上面逐字相同：缺了"调用"（只剩 import 的标识符）必然判红。
    const ok = encAt > readAt && /encodeLinearRgbaToSrgb\(pixels\)/.test(broken)
    expect(ok, '负对照：删掉调用必须判红').toBe(false)
  })
})
describe('C4 · 逐帧时延**不得**自算（M6-2 判定的迁移形态）', () => {
  /**
   * 旧形态：`(m.animation?.defaultFrametimeTicks ?? 1) * 5` —— 它把"1 tick = 5 厘秒"
   * 硬编码在调用点，忽略 `frameSequence[].timeTicks` ⇒ 不等帧时长被压成同一个值。
   */
  function selfComputedDelays(code: string): string[] {
    const out: string[] = []
    for (const line of code.split('\n')) {
      if (!/\*\s*5\b/.test(line)) continue
      if (!/(ticks|delay|delayCs)/i.test(line)) continue
      out.push(line.trim())
    }
    return out
  }

  it('全树生产源码没有任何 `* 5` 形式的 ticks→厘秒自算', () => {
    const files = productionSources()
    // 反空洞真：判定面必须真的扫到整棵树（否则"0 违规"可能只是没扫到）。
    expect(files.length, '判定面必须覆盖整棵生产树').toBeGreaterThan(200)
    expect(files, '判定面必须含导出层与旧 OBJ 装配（不靠手列清单）').toEqual(
      expect.arrayContaining([
        COMMANDS,
        RUNNER,
        'workbench/export/bundleMeshAssembly.ts',
        'workbench/textureAtlasRaster.ts',
      ]),
    )
    const hits: string[] = []
    for (const rel of files) {
      const code = codeOnly(readSource(rel))
      for (const line of selfComputedDelays(code)) hits.push(rel + ': ' + line)
    }
    expect(hits, '逐帧时延必须经 delayCsOf/planSequenceLoop（自算式:\n' + hits.join('\n') + '）').toEqual([])
  })

  it('时延的唯一换算点在 domain（`delayCsOf`），导出层只调用它', () => {
    const gifPort = codeOnly(readSource('adapters/export/gifEncoderPort.ts'))
    expect(gifPort, 'GIF 端口必须调唯一换算点').toContain('delayCsOf(')
    const capture = codeOnly(readSource('composition/exportCapture.ts'))
    expect(capture, '捕获期的时间计划必须来自 planSequenceLoop').toContain('planSequenceLoop(')
  })

  it('**负对照**：旧表达式喂给同一判定必须命中', () => {
    const legacy = [
      'const delay = (m.animation?.defaultFrametimeTicks ?? 1) * 5',
      'const delayCs = durations.map((t) => t * 5)',
    ].join('\n')
    expect(selfComputedDelays(legacy), '负对照：旧自算式必须被命中').toHaveLength(2)
    // 而合法形态（`delayCsOf` 的调用、`totalMs` 之类）不得被误判
    expect(selfComputedDelays('const delays = delayCsOf(holds)'), '合法形态不得误判').toEqual([])
  })
})

/**
 * **C5 · 导出边长只有一个来源**（M6-5 / Q1 的静态面）。
 *
 * e2e 证明"预览 == 下载"（`export-scene-gif.spec.ts` 的 C7b），但那条判据只能看见
 * **一条**命令的端到端。静态面要回答的是另一个问题：**有没有第二个数字**。
 * Q1 的原缺陷正是两个缺省各自漂移（480 / 320）—— 只要允许调用点写字面量，
 * 下一次"顺手改一个"就会重新长出一条分叉，而 e2e 要到尺寸对不上才会响。
 */
describe('C5 · 导出边长只有一个来源（Q1 的静态面）', () => {
  /** 命令与卡片（**调用点**：这两处曾经各写一个数）。 */
  const CALL_SITES = ['operators/builtin/exportOperators.ts', 'workbench/components/ExportWorkspace.vue']

  /** 调用点把边长写成数字字面量的行（`pixelSize: 480`）。 */
  function literalPixelSize(code: string): string[] {
    return code
      .split('\n')
      .filter((line) => /pixelSize\s*:\s*\d/.test(line))
      .map((line) => line.trim())
  }

  it('命令与卡片只引用常量，不写字面量', () => {
    const hits: string[] = []
    for (const rel of CALL_SITES) {
      for (const line of literalPixelSize(codeOnly(readSource(rel)))) hits.push(rel + ': ' + line)
    }
    expect(hits, '导出边长必须引用 EXPORT_PIXEL_SIZE（Q1：两个缺省必然漂移）:\n' + hits.join('\n')).toEqual([])
  })

  it('常量确实定义在唯一位点上，且夹取只在命令侧一处', () => {
    const runner = codeOnly(readSource(RUNNER))
    expect(runner, '边长的唯一来源必须在生产执行入口定义').toContain('export const EXPORT_PIXEL_SIZE')
    expect(runner, '夹取区间也必须定义在唯一位点上').toContain('export const SCENE_GIF_PIXEL_SIZE_RANGE')
    /**
     * 夹取**策略**只有一个解释点：区间常量的消费方（定义处之外）必须恰好是命令。
     * 这比"找 `Math.min`"精确 —— 后者可以被任意重写绕过，而常量消费方是**名称**
     * 层面的事实：谁解释这个区间，谁就得 import 它。
     */
    const consumers = [...EXPORT_LAYER_FILES, RUNNER, ...productionSources()]
      .filter((rel, i, all) => all.indexOf(rel) === i)
      .filter((rel) => rel !== RUNNER)
      .filter((rel) => codeOnly(readSource(rel)).includes('SCENE_GIF_PIXEL_SIZE_RANGE'))
    expect(consumers, '夹取区间只允许命令侧解释（捕获/作业只搬运形参）').toEqual([COMMANDS])
    // 反空洞真：命令侧**真的**用 Math.max/Math.min 夹取（不是只 import 了个名字）
    const commandCode = codeOnly(readSource(COMMANDS))
    expect(/Math\.max\(SCENE_GIF_PIXEL_SIZE_RANGE\.min/.test(commandCode), '命令侧必须真的夹下界').toBe(true)
    expect(/Math\.min\(SCENE_GIF_PIXEL_SIZE_RANGE\.max/.test(commandCode), '命令侧必须真的夹上界').toBe(true)
  })

  it('**负对照**：旧的 480/320 双缺省形态喂给同一判定必须命中', () => {
    const legacy = [
      'const r = await runIsoExport(ctx, { kind: "animation", pixelSize: 480 })',
      'const r = await runIsoExport(ctx, { kind: "animation", pixelSize: 320 })',
    ].join('\n')
    expect(literalPixelSize(legacy), '负对照：Q1 的两个缺省都必须被命中').toHaveLength(2)
    expect(literalPixelSize('const r = await runIsoExport(ctx, { pixelSize: EXPORT_PIXEL_SIZE })'), '合法形态不得误判').toEqual([])
  })
})
