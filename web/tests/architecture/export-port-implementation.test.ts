/**
 * **导出面端口实现的独立闸门**（判据 E1/E2 的结构面）。
 *
 * ## 为什么独立成文件（而不是扩 `export-purity.test.ts`）
 *
 * `export-purity.test.ts` 与主线有**共享文件**
 * 风险，故**不动**它。本文件承担这里需要的结构判据，与它并列走
 * `npm run test:arch`。
 *
 * ## 本文件判什么（两条，各自对应一条会假绿的形态）
 *
 * ### ① 「零生产实现」这个说法必须**可机械核对**
 *
 * `composition/seams.ts` 曾逐字登记「`OffscreenRenderPort` 与 `EncoderPort`
 * 均**零生产实现**」。实现它们之后，若"有实现"这件事没有任何机器判据，
 * 那么下一个人把实现删掉时**不会有人发现** —— 而 seams 的登记也就从
 * "现状清单"退化成了一句散文。
 *
 * 故本条要求三件事同时成立，且**各自有反空洞真**：
 *  - 两个端口的实现文件存在且非空；
 *  - `ExportJob` 在**生产**文件里有构造点（此前 11 处全在测试）；
 *  - 全链在**生产**侧可装配（`assembleSnapshotExportJob` 被导出且真被用）。
 *
 * ### ② 「读回像素」必须是**真的**在源码里
 *
 * `readRenderTargetPixels` 此前**全树 0 命中** —— 于是"离屏导出能读回像素"
 * 这句话当时没有载体。本条钉住它确实出现在生产实现里，且参数里带
 * **请求声明的宽高**（而不是某个魔法常数）。
 *
 * ## CRLF 纪律（铁律 6）
 *
 * 本文件所有源码读取都经 `readNorm`（读入口归一化行尾）：
 * 本仓 `core.autocrlf=true` ⇒ 新鲜检出是 CRLF，LF 树上写绿的切片断言会在检出时判红。
 * `web/tests/architecture/crlf-hygiene.test.ts` 会检查这一点。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildModuleGraph, SRC_ROOT } from './module-graph.mjs'

/** 读源码并**归一化行尾为 LF**（铁律 6 的治本处）。 */
function readNorm(absPath: string): string {
  return fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n')
}

/** 交付的两个端口实现（相对 `src/`）。 */
const PORT_IMPLEMENTATIONS = [
  'adapters/export/offscreenRenderPort.ts',
  'adapters/export/encoderPort.ts',
]

/** 全部导出面实现文件。 */
const EXPORT_PORT_FILES = [
  ...PORT_IMPLEMENTATIONS,
  'adapters/export/snapshotExportJob.ts',
  'adapters/export/renderDevice.ts',
  'adapters/export/pngEncoder.ts',
  'presentation/offscreenCamera.ts',
]

/** 只保留**代码**行（丢掉注释行）——与本目录其余闸门同一口径。 */
function codeOnlyLines(text: string): { line: string; no: number }[] {
  return text
    .split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => !/^\s*(\*|\/\/|\/\*)/.test(line))
}

/** 收集 `src/` 下的生产源文件（排除测试、声明文件、`__tests__`）。 */
function collectProductionFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(ts|tsx|mts|vue)$/.test(e.name)) continue
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name) || /\.d\.ts$/.test(e.name)) continue
      out.push(full)
    }
  }
  walk(dir)
  return out
}

/** 生产源文件清单（`src/` 相对路径；正斜杠）。 */
function productionRels(): string[] {
  return collectProductionFiles(SRC_ROOT)
    .map((abs) => path.relative(SRC_ROOT, abs).replace(/[\\/]+/g, '/'))
    .filter((rel) => !rel.startsWith('..'))
    .sort()
}

// ─────────────────────────────────────────────────────────────────────────────
// 一、两个端口**确实有**生产实现（"零生产实现"的说法必须可机械核对）
// ─────────────────────────────────────────────────────────────────────────────

describe('E1 · 导出面端口的生产实现**存在**', () => {
  it('反空洞真：闸门**确实在扫描**生产文件（否则下面的"存在"可能只是没扫到）', () => {
    const files = productionRels()
    expect(files.length, '必须扫描到生产文件').toBeGreaterThan(200)
    expect(files, '必须扫到 adapters/').toContain('adapters/export/pngEncoder.ts')
  })

  it('两个端口的实现文件存在、非空，且各自实现冻结接口的方法集合', () => {
    for (const rel of PORT_IMPLEMENTATIONS) {
      const abs = path.join(SRC_ROOT, rel)
      expect(fs.existsSync(abs), `${rel} 必须存在（交付面）`).toBe(true)
      expect(readNorm(abs).length, `${rel} 不得为空`).toBeGreaterThan(800)
    }

    // 离屏端口：类实现 + 三方法（与 `export-purity.test.ts` 锁定的接口集合一致）
    const offscreen = readNorm(path.join(SRC_ROOT, 'adapters/export/offscreenRenderPort.ts'))
    expect(offscreen, '必须真的实现 OffscreenRenderPort').toContain('implements OffscreenRenderPort')
    for (const m of ['acquire(', 'renderFrame(', 'release(']) {
      expect(offscreen, `离屏端口实现必须含 ${m}`).toContain(m)
    }

    // 编码端口：supportedKinds + encode
    const encoder = readNorm(path.join(SRC_ROOT, 'adapters/export/encoderPort.ts'))
    expect(encoder, '必须真的实现 EncoderPort').toContain('EncoderPort')
    expect(encoder).toContain('supportedKinds')
    expect(encoder).toContain('async encode(')
  })

  it('`ExportJob` 有**生产**构造点（此前 11 处全在测试）', () => {
    // 判定面是**生产**文件：`__tests__` 与 `*.test.ts` 已被 `collectProductionFiles` 排除。
    const hits: string[] = []
    for (const rel of productionRels()) {
      const code = codeOnlyLines(readNorm(path.join(SRC_ROOT, rel)))
        .map((l) => l.line)
        .join('\n')
      if (code.includes('new ExportJob(')) hits.push(rel)
    }
    expect(
      hits,
      `ExportJob 必须有生产构造点（否则"导出改由 ExportJob 承担"不可执行）：实得 ${JSON.stringify(hits)}`,
    ).toEqual(['adapters/export/snapshotExportJob.ts'])
  })

  it('**负对照**：判定面确实**排除**了测试文件（否则"恰好一个构造点"会被测试里的 11 处淹没）', () => {
    // 测试文件里确有构造点 —— 这证明"排除生效"不是空话。
    const testFile = path.join(SRC_ROOT, 'application/__tests__/snapshotExport.test.ts')
    expect(fs.existsSync(testFile), '前置：A29 测试必须存在').toBe(true)
    const testText = readNorm(testFile)
    expect(testCodeHits(testText), 'A29 测试里**确实**有 new ExportJob（故必须排除）').toBeGreaterThan(0)
    // 而它不在生产清单里
    expect(productionRels(), '测试文件不得进生产清单').not.toContain('application/__tests__/snapshotExport.test.ts')
  })

  it('全链**可装配**：装配入口导出且真的组装两个端口', () => {
    const rel = 'adapters/export/snapshotExportJob.ts'
    const text = readNorm(path.join(SRC_ROOT, rel))
    expect(text, '必须导出装配入口').toContain('export function assembleSnapshotExportJob')
    expect(text, '必须真的构造离屏端口').toContain('createSnapshotOffscreenRenderPort(')
    expect(text, '必须真的构造编码端口').toContain('createEncoderPort()')
    expect(text, '必须真的构造作业').toContain('new ExportJob(')
  })

  it('实现文件都在 `adapters/export/` 或 `presentation/`（不散落）', () => {
    for (const rel of EXPORT_PORT_FILES) {
      expect(
        rel.startsWith('adapters/export/') || rel.startsWith('presentation/'),
        `${rel} 必须落在已声明的层内`,
      ).toBe(true)
      expect(fs.existsSync(path.join(SRC_ROOT, rel)), `${rel} 必须存在`).toBe(true)
    }
  })
})

/** 数一段文本里 `new ExportJob(` 的出现次数（`codeOnlyLines` 同一口径）。 */
function testCodeHits(text: string): number {
  return codeOnlyLines(text).filter((l) => l.line.includes('new ExportJob(')).length
}

// ─────────────────────────────────────────────────────────────────────────────
// 二、读回像素**确实**在源码里（此前全树 0 命中）
// ─────────────────────────────────────────────────────────────────────────────

describe('E2 · 离屏像素读回**确实**存在于生产实现', () => {
  it('反空洞真：`readRenderTargetPixels` 此前全树 0 命中 —— 故下面的断言有真实对象', () => {
    // 只在**新增的实现文件**里找；其余生产文件的命中数应当是 0
    // （这正是"能力此前不存在"的机械证据）。
    const ours = new Set(EXPORT_PORT_FILES.map((r) => path.join(SRC_ROOT, r)))
    const others: string[] = []
    for (const rel of productionRels()) {
      const abs = path.join(SRC_ROOT, rel)
      if (ours.has(abs)) continue
      if (readNorm(abs).includes('readRenderTargetPixels')) others.push(rel)
    }
    expect(
      others,
      `除本次实现外，其余生产文件不得出现 readRenderTargetPixels（证明这是新能力）：${others.join(', ')}`,
    ).toEqual([])
  })

  it('生产实现里确有 `readRenderTargetPixels` 调用（本次交付的载体）', () => {
    const rel = 'adapters/export/renderDevice.ts'
    const code = codeOnlyLines(readNorm(path.join(SRC_ROOT, rel)))
      .map((l) => l.line)
      .join('\n')
    expect(code, '设备端口必须真的读回像素').toContain('readRenderTargetPixels(')
  })

  it('读回参数带**请求声明的宽高**（不是魔法常数）', () => {
    const code = codeOnlyLines(readNorm(path.join(SRC_ROOT, 'adapters/export/renderDevice.ts')))
      .map((l) => l.line)
      .join('\n')
    // 形如 `readRenderTargetPixels(target, 0, 0, width, height, pixels)`
    const call = /readRenderTargetPixels\(([^)]*)\)/.exec(code)
    expect(call, '必须能取到读回调用').not.toBeNull()
    const args = call![1]!
    expect(args, '读回必须带 width（来自渲染设置）').toContain('width')
    expect(args, '读回必须带 height（来自渲染设置）').toContain('height')
    // 且不得写死数字尺寸
    expect(/\breadRenderTargetPixels\([^)]*\b(64|128|256|480|512|1024)\b/.test(code), '不得写死尺寸').toBe(false)
  })

  it('**负对照**：注入一个"不读回像素"的实现会被上一条判据抓到', () => {
    // 与上一条**同一个**判定式，只换事实来源。
    const shell = 'this.renderer.setRenderTarget(target)\nthis.renderer.render(scene, camera)\nreturn ok(new Uint8Array(width * height * 4))'
    expect(shell.includes('readRenderTargetPixels('), '空壳（不读回）不得被判为有读回').toBe(false)
    const real = 'renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels)'
    expect(real.includes('readRenderTargetPixels('), '真实现必须被判为有读回').toBe(true)
  })

  it('设备端口的**方法集合封闭**：不得长出 `camera`/`viewport`/`editor` 式方法（A29 负对照）', () => {
    const text = readNorm(path.join(SRC_ROOT, 'adapters/export/renderDevice.ts'))
    const start = text.indexOf('export interface OffscreenDevice')
    expect(start, '`OffscreenDevice` 必须在本文件声明').toBeGreaterThan(-1)
    const block = text.slice(start, text.indexOf('\n}', start))
    const methods = [...block.matchAll(/^\s{2}(\w+)\(/gm)].map((m) => m[1])
    expect(methods.sort(), '设备端口只允许"渲染读回 + 释放"').toEqual(['dispose', 'renderAndRead'])
  })

  it('设备**还原原父节点**（否则一次导出会把用户视口的呈现根永久摘走）', () => {
    // ## 这条判据防的是"导出改坏用户视口"（A29 明文禁止）
    //
    // `THREE.Scene.add(root)` **隐含** `root.removeFromParent()`。若渲染后只调
    // `scene.remove(root)`，那个根对象会**永久离开**它原本所在的场景树 ——
    // 一次导出把用户正在看的视口改坏（画面变空），且**不报错**。
    //
    // 当下生产形态里呈现根没有父节点（`composition/presenterSession` 的根是平行路径，
    // 不挂进视口内容组），故 `add`/`remove` 恰好平衡 —— 但那是**巧合**，不是可依赖的性质：
    // 该接缝（`presenter-surface-dual-track`）的退出方向正是"把呈现根接上画面"，
    // 那天这里就会静默改坏用户画面。⇒ 由结构保证：保存并还原原父节点。
    const code = codeOnlyLines(readNorm(path.join(SRC_ROOT, 'adapters/export/renderDevice.ts')))
      .map((l) => l.line)
      .join('\n')
    expect(code, '必须保存原父节点').toContain('root.parent')
    expect(code, '必须存在还原路径（previousParent.add）').toContain('previousParent.add(')
    expect(code, '还原必须在 finally 里（覆盖抛错与提前返回）').toContain('finally {')
  })

  it('**负对照**：只 `scene.remove(root)` 的形态会被上一条判据抓到', () => {
    const legacy = [
      'scene.add(root)',
      'renderer.render(scene, camera)',
      'scene.remove(root)',
      'return ok(pixels)',
    ].join('\n')
    expect(legacy.includes('root.parent'), '旧形态不得含原父节点保存').toBe(false)
    expect(legacy.includes('previousParent.add('), '旧形态不得含还原').toBe(false)
    const fixed = 'const previousParent = root.parent\n/* … */ finally { previousParent.add(root) }'
    expect(fixed.includes('root.parent') && fixed.includes('previousParent.add(')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 三、实现不得把"实时视口/相机"绕道拿进来（A29 负对照的静态面延伸）
// ─────────────────────────────────────────────────────────────────────────────

describe('E2b · 导出面实现不得依赖实时视口/相机实现', () => {
  /** 与 `export-purity.test.ts` 同一张表的口径（那张表只含三个文件；本判据延伸到自己交付的面）。 */
  const FORBIDDEN_LIVE_VIEWPORT = [
    'runtime/viewportCamera',
    'runtime/viewportCameraApply',
    'runtime/mainCameras',
    'runtime/viewportManager',
    'runtime/viewportBinder',
    'runtime/context',
    'runtime/contextAccess',
    'shared/viewport',
  ]

  it('导出面实现**零**导入实时视口/相机实现', () => {
    const { facts } = buildModuleGraph()
    const ours = new Set(EXPORT_PORT_FILES.map((rel) => path.join(SRC_ROOT, rel)))
    const violations: string[] = []
    for (const f of facts) {
      if (!ours.has(f.fromFile)) continue
      for (const banned of FORBIDDEN_LIVE_VIEWPORT) {
        if (f.specifier.includes(banned)) {
          violations.push(`${path.relative(SRC_ROOT, f.fromFile).replace(/[\\/]+/g, '/')}:${f.line} → ${f.specifier}`)
        }
      }
    }
    expect(violations, `导出面实现导入了实时视口/相机（A29 负对照）：\n${violations.join('\n')}`).toEqual([])
  })

  it('反空洞真：实现**确实**有内部导入（否则上一条是空转）', () => {
    const { facts } = buildModuleGraph()
    const ours = new Set(EXPORT_PORT_FILES.map((rel) => path.join(SRC_ROOT, rel)))
    const imports = facts.filter((f) => ours.has(f.fromFile) && (f.specifier.startsWith('@/') || f.specifier.startsWith('.')))
    expect(imports.length, '实现之间必须有真实导入（否则断言器空转）').toBeGreaterThan(5)
  })

  it('**负对照**：注入一条 `@/runtime/viewportCamera` 导入会被同一判据抓到', () => {
    const injected = [{ fromFile: path.join(SRC_ROOT, 'adapters/export/offscreenRenderPort.ts'), specifier: '@/runtime/viewportCamera', line: 1 }]
    const hits = injected.filter((f) => FORBIDDEN_LIVE_VIEWPORT.some((b) => f.specifier.includes(b)))
    expect(hits, '借用实时相机的导入必须判红').toHaveLength(1)
  })
})
