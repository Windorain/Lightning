/**
 * **P9 新层隔离与导出纯净性**闸门（#260；#249 §4 导入规则、§19.4、§15 第 13 条）。
 *
 * ## 为什么需要它，且为什么**不**改 `boundary-rules.mjs`
 *
 * `boundary-rules.mjs` 的 `GATE_RULES` 判的是「新层内部的导入形状」，它的执行面由
 * `LAYER_DESTINATIONS[*].activeSubpaths` 决定 —— 本批新增的层路径已在**同一提交**里
 * 登记进 `LAYER_DESTINATIONS`（`adapters` 的 `activeSubpaths`），因此
 * `core-no-vue-three` / `no-private-cross-layer` / `no-barrel-smuggling` 三条规则
 * 已经覆盖它们。Lead 裁决：**不碰 GATE_RULES 本体**。
 *
 * 但本批有两条**GATE_RULES 判不了**的判据，必须独立成闸门（与
 * `kernel-legacy-isolation.test.ts`、`presentation-purity.test.ts` 并列）：
 *
 * 1. **导出路径不得自驱时间**：`#249` §19.4 把导出定义为"固定快照"，
 *    若导出作业里出现 `Date.now()` / `performance.now()` / `requestAnimationFrame`，
 *    那么"导出期间继续编辑不影响快照"与"运行时间必须显式映射"就都成了空话
 *    （时间会在导出中途变）。`presentation-purity.test.ts` 只扫 `src/presentation/`，
 *    不覆盖 `application/export` / `runtime/exportJob` / `domain/captureSpec`。
 * 2. **导出不得借用实时视口**：A29 的负对照。可静态判定的部分是：导出层
 *    **不得 import** `runtime/context`、`runtime/viewportCamera`、`runtime/mainCameras`、
 *    `runtime/viewportManager` 等"实时视口/相机"实现。这条比"接口里没有相机方法"
 *    更强 —— 它连"绕道拿一个"都堵住。
 *
 * 另加一条**退役证据**：A29 的交付面（固定快照导出）必须**真实存在且可加载**，
 * 否则"已退役 #13"只是文档里的一句话。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildModuleGraph, SRC_ROOT, WEB_ROOT } from './module-graph.mjs'

// ─────────────────────────────────────────────────────────────────────────────
// 判据面
// ─────────────────────────────────────────────────────────────────────────────

/** 本批（P9）新建的导出/持久化实现路径（相对 `src/`，正斜杠）。 */
const P9_EXPORT_FILES = [
  'domain/captureSpec.ts',
  'application/exportPlan.ts',
  'runtime/exportJob.ts',
  // M6-2：编码适配器（GIF 字节核心 / 动画编码端口 / 离屏端口）同样属于"导出实现"，
  // 不得自驱时间、不得借用实时视口。**漏掉它们**等于给新文件一张免查券。
  'adapters/export/gifEncoder.ts',
  'adapters/export/gifEncoderPort.ts',
  'adapters/export/encoderPort.ts',
  'adapters/export/offscreenRenderPort.ts',
  // M6-3：**整个 `adapters/export/**` 都是导出实现**（§10.6 的补面）。漏掉新文件
  // 等于给它们一张"不得自驱时间/不得借用实时视口"的免查券 —— 而这类判据正是
  // 切链后最容易悄悄失守的地方。
  'adapters/export/snapshotExportJob.ts',
  'adapters/export/renderDevice.ts',
  'adapters/export/pngEncoder.ts',
  'adapters/export/abortBridge.ts',
  'adapters/export/offscreenTextureUpload.ts',
  'adapters/export/offscreenTextureDomain.ts',
]

/** 本批新建的适配器路径（跨层导入纪律由 `boundary-rules.mjs` 判；此处只做时间/借用面）。 */
const P9_ADAPTER_FILES = [
  'adapters/saveTarget/coordinator.ts',
]

/** 导出路径**不得**出现的自驱时间来源（与 `presentation-purity` 同一张表的口径）。 */
const FORBIDDEN_TIME = [
  { needle: 'requestAnimationFrame', why: '导出作业不得自驱（快照时间必须来自固定采样序列）' },
  { needle: 'setTimeout', why: '导出不得自建定时器' },
  { needle: 'setInterval', why: '导出不得自建周期推进' },
  { needle: 'Date.now', why: '导出不得读全局时钟（#249 §19.4：不读执行当刻墙钟）' },
  { needle: 'performance.now', why: '导出不得读全局时钟' },
]

/**
 * 导出层**不得 import** 的实时视口/相机实现（A29 负对照「借用并旋转实时相机」的静态面）。
 *
 * 这些路径都是"正在被操作的相机/视口"的宿主实现。导出要取景，只能拿**值**
 * （`CameraSpec`）；import 它们意味着"有办法拿到实时对象"。
 */
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

/** 只保留代码行（丢掉注释行）——与 P1/P5 同类闸门同一口径。 */
function codeOnlyLines(text) {
  return text
    .split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => !/^\s*(\*|\/\/|\/\*)/.test(line))
}

/**
 * 读源码并**归一化行尾为 LF**（铁律 6：本仓 `core.autocrlf=true`，新鲜检出是 CRLF）。
 *
 * 本文件当下的断言（`includes` / 逐行包含）恰不依赖 `\n` 字面量，但"恰好安全"不是判据 ——
 * 统一走本入口使"读到的文本恒为 LF"成为文件级前提（同 `kernel-legacy-isolation.test.ts`）。
 */
function readSource(absPath) {
  return fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// 一、导出纯净性
// ─────────────────────────────────────────────────────────────────────────────

describe('P9 导出纯净性：快照时间只能来自固定采样序列（#249 §19.4；A29）', () => {
  it('反空洞真：导出实现文件确实存在且非空（否则下面"0 违规"可能只是没扫到）', () => {
    for (const rel of P9_EXPORT_FILES) {
      const p = path.join(SRC_ROOT, rel)
      expect(fs.existsSync(p), `${rel} 必须存在（本批交付面）`).toBe(true)
      expect(readSource(p).length, `${rel} 不得为空`).toBeGreaterThan(500)
    }
  })

  it('导出实现里不含任何自驱时间来源', () => {
    const hits = []
    for (const rel of [...P9_EXPORT_FILES, ...P9_ADAPTER_FILES]) {
      const text = readSource(path.join(SRC_ROOT, rel))
      for (const { line, no } of codeOnlyLines(text)) {
        for (const { needle, why } of FORBIDDEN_TIME) {
          if (line.includes(needle)) hits.push(`${rel}:${no} 出现 ${needle} —— ${why}`)
        }
      }
    }
    expect(hits, `导出/保存适配路径出现自驱时间来源:\n${hits.join('\n')}`).toEqual([])
  })

  it('**负对照**：把 `Date.now()` 放进同一判据会被抓到（证明上一条不是空转）', () => {
    const sample = 'const t = Date.now()\nreq.createdAt = t'
    const found = codeOnlyLines(sample).flatMap(({ line }) => FORBIDDEN_TIME.filter(({ needle }) => line.includes(needle)))
    expect(found.map((f) => f.needle)).toEqual(['Date.now'])
    // 注释里的提及**不**判红（退役记录必须可写）
    const comment = '// 旧导出器用 Date.now() 决定导哪一帧；已退役'
    expect(codeOnlyLines(comment).flatMap(({ line }) => FORBIDDEN_TIME.filter(({ needle }) => line.includes(needle)))).toEqual([])
  })

  it('导出层**不得** import 实时视口/相机实现（A29 负对照的静态面）', () => {
    const { facts } = buildModuleGraph()
    const exportAbs = new Set(P9_EXPORT_FILES.map((rel) => path.join(SRC_ROOT, rel)))
    const violations = []
    for (const f of facts) {
      if (!exportAbs.has(f.fromFile)) continue
      const spec = f.specifier
      for (const banned of FORBIDDEN_LIVE_VIEWPORT) {
        if (spec.includes(banned)) {
          violations.push(`${path.relative(SRC_ROOT, f.fromFile).replace(/[\\/]+/g, '/')}:${f.line} → ${spec}（禁止导入实时视口/相机）`)
        }
      }
    }
    expect(violations, `导出路径导入了实时视口/相机实现（A29 负对照「借用并旋转实时相机」）:\n${violations.join('\n')}`).toEqual([])
  })

  it('**负对照**：注入一条 `@/runtime/viewportCamera` 导入会被同一判据抓到', () => {
    const injected = [{ fromFile: path.join(SRC_ROOT, 'runtime', 'exportJob.ts'), specifier: '@/runtime/viewportCamera', line: 1 }]
    const hits = injected.filter((f) => FORBIDDEN_LIVE_VIEWPORT.some((b) => f.specifier.includes(b)))
    expect(hits, '借用实时相机的导入必须判红').toHaveLength(1)
  })

  it('导出请求的取景是**值**：`captureSpec` 里没有"当前/实时相机"这类字段名', () => {
    const text = readSource(path.join(SRC_ROOT, 'domain/captureSpec.ts'))
    const code = codeOnlyLines(text)
      .map((l) => l.line)
      .join('\n')
    // 允许出现 `CameraSpec`/`CameraSource`（都是值类型）；禁止的是"活着的东西"。
    for (const banned of ['THREE.Camera', 'THREE.PerspectiveCamera', 'from three', 'CurrentCamera', 'liveCamera', 'activeCamera']) {
      expect(code.includes(banned), `captureSpec 不得出现 ${banned}（取景必须是复制出来的值）`).toBe(false)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 二、导出层与新内核的依赖方向
// ─────────────────────────────────────────────────────────────────────────────

describe('P9 依赖方向：导出/保存适配只依赖新层，不反向钻旧实现', () => {
  const OLD_LAYERS = ['pure', 'context', 'operators', 'handlers', 'events', 'render', 'workbench', 'viewer', 'embed', 'wiki', 'shared']

  /** 旧层判定：目标落在旧目录，且**不是**本批登记的内核新文件。 */
  function isOldTarget(rel) {
    return OLD_LAYERS.some((layer) => rel === layer || rel.startsWith(`${layer}/`))
  }

  function resolveTarget(f) {
    const spec = f.specifier
    if (spec.startsWith('«') || (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('@/'))) return null
    const abs = spec.startsWith('@/') ? path.join(SRC_ROOT, spec.slice(2)) : path.resolve(path.dirname(f.fromFile), spec)
    const rel = path.relative(SRC_ROOT, abs).replace(/[\\/]+/g, '/')
    if (rel.startsWith('..')) return null
    return rel.replace(/\.(ts|tsx|mts|vue|js)$/, '')
  }

  it('导出/保存适配文件的内部导入都落在新层内（无一条指向旧目录）', () => {
    const { facts } = buildModuleGraph()
    const ours = new Set([...P9_EXPORT_FILES, ...P9_ADAPTER_FILES].map((rel) => path.join(SRC_ROOT, rel)))
    const violations = []
    for (const f of facts) {
      if (!ours.has(f.fromFile)) continue
      const t = resolveTarget(f)
      if (t === null) continue
      if (isOldTarget(t)) {
        violations.push(`${path.relative(SRC_ROOT, f.fromFile).replace(/[\\/]+/g, '/')}:${f.line} → ${f.specifier}（旧层 ${t.split('/')[0]}）`)
      }
    }
    expect(violations, `P9 实现出现指向旧层的导入:\n${violations.join('\n')}`).toEqual([])
  })

  it('反空洞真：P9 实现确实有内部导入（否则上一条是空转）', () => {
    const { facts } = buildModuleGraph()
    const ours = new Set([...P9_EXPORT_FILES, ...P9_ADAPTER_FILES].map((rel) => path.join(SRC_ROOT, rel)))
    const internal = facts.filter((f) => ours.has(f.fromFile)).map(resolveTarget).filter((t) => t !== null)
    expect(internal.length).toBeGreaterThan(4)
    expect(internal.some((t) => t.startsWith('domain/'))).toBe(true)
    expect(internal.some((t) => t.startsWith('presentation/') || t.startsWith('application/'))).toBe(true)
  })

  it('导出层不 import 旧导出器（`workbench/export*` / `render/mesh`）—— 不借道旧几何语义', () => {
    const { facts } = buildModuleGraph()
    const ours = new Set(P9_EXPORT_FILES.map((rel) => path.join(SRC_ROOT, rel)))
    const banned = ['workbench/export', 'workbench/exportIsometricImage', 'render/mesh', 'render/data']
    const hits = []
    for (const f of facts) {
      if (!ours.has(f.fromFile)) continue
      if (banned.some((b) => f.specifier.includes(b))) hits.push(`${f.fromRel}:${f.line} → ${f.specifier}`)
    }
    expect(hits, `#249 §19.4：不能绕道旧文件获得另一份几何语义:\n${hits.join('\n')}`).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 三、退役证据（#15 第 13 条：固定快照导出作业的真实交付面）
// ─────────────────────────────────────────────────────────────────────────────

describe('P9 退役证据（#249 §15 第 13 条）：固定快照导出作业真实存在', () => {
  it('导出作业导出 `ExportJob` 且其端口接口**没有**实时视口/相机方法', () => {
    const text = readSource(path.join(SRC_ROOT, 'runtime/exportJob.ts'))
    expect(text).toContain('export class ExportJob')
    // 端口接口的方法集合（静态断言：不许偷偷长出一个"取实时相机"的方法）
    const start = text.indexOf('export interface OffscreenRenderPort')
    expect(start, 'OffscreenRenderPort 必须定义在 exportJob.ts').toBeGreaterThan(-1)
    const block = text.slice(start, text.indexOf('\n}', start))
    const methods = [...block.matchAll(/^\s{2}(\w+)\(/gm)].map((m) => m[1])
    expect(methods.sort()).toEqual(['acquire', 'release', 'renderFrame'])
    for (const banned of ['camera', 'viewport', 'editor', 'context', 'current']) {
      expect(methods, `离屏端口不得出现 \`${banned}\` 式方法`).not.toContain(banned)
    }
  })

  it('导出请求的捕获入口只接受**值**（`planExportRequest` 的输入形态里没有回调/句柄）', () => {
    const text = readSource(path.join(SRC_ROOT, 'application/exportPlan.ts'))
    const start = text.indexOf('export interface CaptureInput')
    expect(start).toBeGreaterThan(-1)
    const block = text.slice(start, text.indexOf('\n}', start))
    // 逐字段列出的字段名里不得出现"惰性取值"形态
    for (const banned of ['getScene', 'getDocument', '() =>', 'editor', 'client', 'viewport']) {
      expect(block.includes(banned), `CaptureInput 不得含 ${banned}（隐式读取最新文档的入口）`).toBe(false)
    }
    expect(block).toContain('readonly scene: Scene')
    expect(block).toContain('readonly version: Version')
  })

  it('A29 验收测试文件存在且覆盖四条判据名（防"只在汇报里声称通过"）', () => {
    const testPath = path.join(SRC_ROOT, 'application/__tests__/snapshotExport.test.ts')
    expect(fs.existsSync(testPath), 'A29 测试必须存在').toBe(true)
    const text = readSource(testPath)
    for (const needle of ['继续编辑不改变本次快照', '不借用实时相机', '取消', '预检']) {
      expect(text.includes(needle), `A29 测试必须覆盖「${needle}」`).toBe(true)
    }
    expect(text.includes('负对照'), 'A29 测试必须含负对照').toBe(true)
  })
})

/** 未使用占位：保持 `WEB_ROOT` 可达（便于诊断相对路径）。 */
void WEB_ROOT
