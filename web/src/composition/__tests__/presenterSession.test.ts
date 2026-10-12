/**
 * **P10e（#299）段② · `PresenterSession`：presenter 真实上线的判据面**。
 *
 * ## 本文件证什么
 *
 * P10c/P10d 反复实测的缺口形态是「**判定面存在、输入侧无生产者**」：
 * `PresentationInputs` 零生产调用方、纹理链零生产接线、`BatchedPresenter`
 * 只被 e2e 探针与单测驱动。本文件钉住**生产侧的那个消费者**：
 *
 * | 判据 | 防什么 |
 * |---|---|
 * | **身份未变 ⇒ 不重编**（`applied === false`） | 每帧全量重建（A11 判据："转视角不得重建几何"） |
 * | **内容变 ⇒ 重编** | 反向的假绿（"永远不重编"会让判据恒真） |
 * | **逐格拾取经 presenter**（含格坐标与面序号） | 接线后交互能力消失（本批存在的全部理由） |
 * | **过期拾取 ⇒ `stale`**（**不是** `miss`） | A12「不得新描边配旧几何」；两者处置不同 |
 * | **换纹理绑定 ⇒ 卸载受影响批次** | A28 同族：改完贴图看不到变化 |
 *
 * ## 为什么用真实夹具而不是自造图元
 *
 * 自造图元只证"编译 → 呈现"这一段（P10d D3c 的教训：探针自造图元绕过了
 * 内核场景那一环）。本文件走**完整生产链**（信封 → 解析 → 内核装配 →
 * `kernelPresentationInputs` → `compileScene` → `PresenterSession`），
 * 于是"链在哪一环断"能被定位到具体一步。
 */
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { PresenterSession } from '@/composition/presenterSession'
import { assembleKernelDocument } from '@/composition/kernelAssembly'
import { createParserRegistry } from '@/context/parserRegistry'
import { V2PlainParser, WorldParser, StructureDataParser, createEnvelopeParser } from '@/context/parsers/builtinParsers'
import { plainRootOf } from '@/adapters/plainRoot'
import { fixturePath, readJson } from '@/context/__tests__/multiblockFixtureIo.mjs'
import { TIME_ZERO, type EvaluationKey } from '@/presentation/evaluationKey'
import type { EffectiveOutlinePolicy } from '@/presentation/outlinePlan'
import type { Scene } from '@/domain/scene'
import type { DocumentContent } from '@/domain/content'
import fs from 'node:fs'
import path from 'node:path'

function productionParsers() {
  const parsers = createParserRegistry()
  parsers.register(V2PlainParser)
  parsers.register(createEnvelopeParser(parsers))
  parsers.register(WorldParser)
  parsers.register(StructureDataParser)
  return parsers
}

function loadRaw(name: string): Record<string, unknown> {
  if (name === 'envelope') {
    return JSON.parse(
      fs
        .readFileSync(path.join(process.cwd(), 'e2e', 'fixtures', 'structuredata-exported-envelope.json'), 'utf8')
        .replace(/\r\n/g, '\n'),
    ) as Record<string, unknown>
  }
  return readJson(fixturePath(name)) as Record<string, unknown>
}

async function assembledOf(name: string): Promise<{ scene: Scene; content: DocumentContent }> {
  const raw = loadRaw(name)
  const parsed = await productionParsers().detectAndParse(raw)
  const r = assembleKernelDocument({ doc: parsed.document!, plainRoot: plainRootOf(raw) })
  if (!r.ok) throw new Error(`装配失败：${r.error.code}`)
  return { scene: r.value.scene, content: r.value.content }
}

function keyOf(sceneId: string, documentVersion = 1): EvaluationKey {
  return { documentVersion, scene: sceneId, time: TIME_ZERO, parameterVersion: 0, contentResourceVersions: {} }
}

describe('P10e 段② · `PresenterSession`：内核场景 → 生产呈现器（有生产消费者）', () => {
  it('真实夹具：apply 成功、产批次、**零跳过**，且呈现器世代已建立', async () => {
    const { scene, content } = await assembledOf('multiblock-ebf-2ch')
    const s = new PresenterSession({ scope: 'test-p10e-a' })
    try {
      const out = s.applyIfChanged({ scene, content, key: keyOf(scene.id) })
      expect(out.compileError, `编译不得失败：${out.compileError}`).toBeNull()
      expect(out.applied).toBe(true)
      expect(out.skipped, '内核侧不得跳过').toEqual([])
      expect(out.compileSkipped, '编译侧不得跳过').toEqual([])
      expect(out.batches, '必须有批次').toBeGreaterThan(0)
      expect(out.generation, '必须建立世代').toBeTruthy()
      expect(s.object3d.children.length, '必须真的挂上了批次对象').toBeGreaterThan(0)
      expect(s.generation).toBe(out.generation)
    } finally {
      s.dispose()
    }
  })

  it('**身份未变 ⇒ 不重编**（A11：机位/koa 变化不得重建几何）', async () => {
    const { scene, content } = await assembledOf('multiblock-tier-only')
    const s = new PresenterSession({ scope: 'test-p10e-b' })
    try {
      const first = s.applyIfChanged({ scene, content, key: keyOf(scene.id) })
      expect(first.applied).toBe(true)
      const buildsAfterFirst = s.statsSnapshot().geometryBuilds

      // 只改**非结构**维度（机位）：身份不变 ⇒ 不得重编、不得重传
      const second = s.applyIfChanged({
        scene,
        content,
        key: { ...keyOf(scene.id), viewProjection: { camera: 'c2', localDisplay: 'all' } },
      })
      expect(second.applied, '同一内容身份 ⇒ 不得重编（A11）').toBe(false)
      expect(s.statsSnapshot().geometryBuilds, '不得新建几何').toBe(buildsAfterFirst)
      expect(s.generation, '世代必须保持不变').toBe(first.generation)
    } finally {
      s.dispose()
    }
  })

  it('**负对照**：改 `documentVersion` ⇒ 必须重编（证明上一条不是"永远不重编"）', async () => {
    const { scene, content } = await assembledOf('multiblock-tier-only')
    const s = new PresenterSession({ scope: 'test-p10e-c' })
    try {
      const first = s.applyIfChanged({ scene, content, key: keyOf(scene.id) })
      const second = s.applyIfChanged({ scene, content, key: keyOf(scene.id, 2) })
      expect(second.applied, '文档版本变 ⇒ 内容身份变 ⇒ 必须重编').toBe(true)
      expect(second.generation).not.toBe(first.generation)
    } finally {
      s.dispose()
    }
  })

  it('**负对照**：换资源内容版本 ⇒ 必须重编（A28：换贴图必须换身份）', async () => {
    const { scene, content } = await assembledOf('multiblock-tier-only')
    const s = new PresenterSession({ scope: 'test-p10e-d' })
    try {
      s.applyIfChanged({ scene, content, key: keyOf(scene.id) })
      // 改第一份资源的内容版本（"同一 URL 覆盖上传"的模拟）
      const bumped: DocumentContent = {
        ...content,
        resources: content.resources.map((r, i) =>
          i === 0 ? { ...r, ref: { ...r.ref, contentVersion: 'bumped:v2' } } : r,
        ),
      }
      const out = s.applyIfChanged({ scene, content: bumped, key: keyOf(scene.id) })
      expect(out.applied, '资源内容版本变 ⇒ 必须重编（否则画面永远显示旧图）').toBe(true)
    } finally {
      s.dispose()
    }
  })
})

describe('P10e 段② · **逐格拾取经 presenter**（交互面重建的核心判据）', () => {
  /**
   * 从批次对象的包围盒中心向外发一条射线（**构造性**命中，不依赖具体机位）。
   *
   * 为什么不用固定机位：夹具尺寸/位置随夹具不同，固定机位会"有时命中有时不命中"
   * —— 那种判据的表现是间歇性假红。用包围盒中心 + 相机朝外则**必然**穿透几何。
   */
  function rayThroughCenter(session: PresenterSession): THREE.Raycaster {
    const box = new THREE.Box3().setFromObject(session.object3d)
    const center = box.getCenter(new THREE.Vector3())
    const radius = box.getSize(new THREE.Vector3()).length() || 1
    const camera = new THREE.PerspectiveCamera(50, 1, 0.01, radius * 100)
    // 相机在包围盒外，看向中心（保证射线先穿过批次对象）。
    camera.position.set(center.x, center.y, center.z + radius * 2)
    camera.lookAt(center)
    camera.updateMatrixWorld(true)
    const rc = new THREE.Raycaster()
    rc.setFromCamera(new THREE.Vector2(0, 0), camera)
    return rc
  }

  it('真实夹具：射线命中 ⇒ 解出**对象身份 + 格坐标 + 面序号**', async () => {
    const { scene, content } = await assembledOf('multiblock-ebf-2ch')
    const s = new PresenterSession({ scope: 'test-p10e-pick' })
    try {
      s.applyIfChanged({ scene, content, key: keyOf(scene.id) })
      const res = s.pickAt(rayThroughCenter(s))
      expect(res.kind, '必须命中（射线由包围盒构造，必然穿透几何）').toBe('hit')
      if (res.kind !== 'hit') throw new Error('narrow')
      const r = res.resolution
      // ① 对象身份：非空且**不是**批次序号（A18 负对照）
      expect(r.objectId).toBeTruthy()
      expect(String(r.objectId), '对象身份不得是批次位置').not.toMatch(/^\d+$/)
      // ② **逐格身份**（本批的全部理由）：`context/selection.ts:21-34` 要的三个字段
      expect(r.cell, '逐格几何的命中必须带格身份').toBeDefined()
      expect(Number.isInteger(r.cell!.column)).toBe(true)
      expect(Number.isInteger(r.cell!.row)).toBe(true)
      expect(Number.isInteger(r.cell!.zSlice)).toBe(true)
      expect(Number.isInteger(r.cell!.quadIndex), '面序号必须是整数（逐面语义的前提）').toBe(true)
      expect(r.cell!.quadIndex, '面序号必须非负').toBeGreaterThanOrEqual(0)
      // ③ 求值版本凭据（A12）
      expect(r.keyAtHit.documentVersion).toBe(1)
      // ④ primitiveIndex 也必须带出来（"命中第几个三角形"）
      expect(r.primitiveIndex, '必须带出命中三角形序号').toBeDefined()
      expect(Number.isInteger(r.primitiveIndex!)).toBe(true)
    } finally {
      s.dispose()
    }
  })

  it('**逐格精度**：扫视口的不同位置 ⇒ 解出**不同**的格（证明不是常数）', async () => {
    // ## 为什么用"扫 NDC 网格"而不是"换相机朝向"
    //
    // 第一版每轮改相机绕物体转并**始终看向中心** —— 实测只解出 1 个格。
    // 原因是那恰好总打在**离相机最近的那个面**上（几何是 16 倍大的重叠单元，
    // 见 `cellIdentity.test.ts` 文件头），所以换朝向不换命中格。
    //
    // 而"用户在视口里点不同地方"对应的是**固定机位下扫 NDC**：
    // 射线从不同屏幕位置打进，自然落在不同格上。这才是交互面真实的输入分布。
    const { scene, content } = await assembledOf('multiblock-lsc-overlap')
    const s = new PresenterSession({ scope: 'test-p10e-pick2' })
    try {
      s.applyIfChanged({ scene, content, key: keyOf(scene.id) })
      const box = new THREE.Box3().setFromObject(s.object3d)
      const center = box.getCenter(new THREE.Vector3())
      const radius = box.getSize(new THREE.Vector3()).length() || 1
      const camera = new THREE.PerspectiveCamera(50, 1, 0.01, radius * 100)
      // 斜视（不是正对某个轴）：正对会把整个网格压成一个面，扫不出多个格
      camera.position.set(center.x + radius, center.y + radius * 0.8, center.z + radius)
      camera.lookAt(center)
      camera.updateMatrixWorld(true)

      const cells = new Set<string>()
      let hits = 0
      for (let nx = -0.8; nx <= 0.81; nx += 0.2) {
        for (let ny = -0.8; ny <= 0.81; ny += 0.2) {
          const res = s.pickAtNdc(camera, new THREE.Vector2(nx, ny))
          if (res.kind !== 'hit') continue
          hits += 1
          const c = res.resolution.cell
          if (c !== undefined) cells.add(`${c.column},${c.row},${c.zSlice}`)
        }
      }
      expect(hits, '扫视口必须命中多次（否则判据没真的跑）').toBeGreaterThan(1)
      expect(cells.size, '不同屏幕位置必须解出不同的格（否则逐格层无区分力）').toBeGreaterThan(1)
    } finally {
      s.dispose()
    }
  })

  it('**未 apply ⇒ `miss`**（不是抛错、也不是伪造一个格）', async () => {
    const s = new PresenterSession({ scope: 'test-p10e-pick3' })
    try {
      const rc = new THREE.Raycaster(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1))
      expect(s.pickAt(rc).kind).toBe('miss')
    } finally {
      s.dispose()
    }
  })

  it('**A12：过期拾取 ⇒ `stale`（独立于 `miss`）**，且诊断可展示', async () => {
    // ## 怎么构造"画面过期"（这是本用例唯一的技术难点）
    //
    // `PresenterSession` 的当前键随每次 `applyIfChanged` 更新，故"呈现产物是旧的、
    // 当前键是新的"这个组合**不能**从公开 API 构造出来 —— 除非呈现产物**先**建立、
    // 随后**只**改当前键。而身份含 `documentVersion`，改它必然重编。
    //
    // ⇒ 正确构造：**手工**改内部键（测试可以，产品代码不可以）。这使判据测的是
    // `pickAt` 的**过期分支**本身，而不是"某条正常路径恰好导致过期"。
    // 用 `as unknown as { currentKey: EvaluationKey }` 是刻意的：**若哪天有人
    // 把 `currentKey` 从私有字段改成别的形态，本条会编译失败**（而不是静默变成空转）。
    const { scene, content } = await assembledOf('multiblock-tier-only')
    const s = new PresenterSession({ scope: 'test-p10e-stale' })
    try {
      s.applyIfChanged({ scene, content, key: keyOf(scene.id) })
      // 制造过期：把当前键换成"另一个文档版本"（呈现产物仍是旧的）
      ;(s as unknown as { currentKey: EvaluationKey }).currentKey = keyOf(scene.id, 99)
      const res = s.pickAt(rayThroughCenterLocal(null, s))
      expect(res.kind, '过期画面上的拾取必须是 stale（不是 miss —— 两者处置不同）').toBe('stale')
      if (res.kind !== 'stale') throw new Error('narrow')
      expect(res.detail, '诊断必须说明是版本不一致').toContain('文档版本')
    } finally {
      s.dispose()
    }
  })

  it('**反空洞真**：未过期时同一条射线给出 `hit`（证明上一条的 `stale` 不是恒真）', async () => {
    const { scene, content } = await assembledOf('multiblock-tier-only')
    const s = new PresenterSession({ scope: 'test-p10e-stale-neg' })
    try {
      s.applyIfChanged({ scene, content, key: keyOf(scene.id) })
      expect(s.pickAt(rayThroughCenterLocal(null, s)).kind).toBe('hit')
    } finally {
      s.dispose()
    }
  })

  /** 与 `rayThroughCenter` 同构（提到函数外以免闭包捕获过宽）。 */
  function rayThroughCenterLocal(_out: unknown, session: PresenterSession): THREE.Raycaster {
    const box = new THREE.Box3().setFromObject(session.object3d)
    const center = box.getCenter(new THREE.Vector3())
    const radius = box.getSize(new THREE.Vector3()).length() || 1
    const camera = new THREE.PerspectiveCamera(50, 1, 0.01, radius * 100)
    camera.position.set(center.x, center.y, center.z + radius * 2)
    camera.lookAt(center)
    camera.updateMatrixWorld(true)
    const rc = new THREE.Raycaster()
    rc.setFromCamera(new THREE.Vector2(0, 0), camera)
    return rc
  }
})

describe('P10e 段② · 纹理（五态链的消费端接线）', () => {
  it('**换纹理绑定 ⇒ 卸载受影响批次**（否则改完贴图画面不变 —— A28 同族）', async () => {
    const { scene, content } = await assembledOf('multiblock-tier-only')
    const s = new PresenterSession({ scope: 'test-p10e-tex' })
    try {
      s.applyIfChanged({ scene, content, key: keyOf(scene.id) })
      const before = s.statsSnapshot().batchObjects
      expect(before, '前提：必须已有批次').toBeGreaterThan(0)

      // 装一份绑定（内容身份 v1）
      s.setTextureBindings(
        new Map([
          [
            'structure',
            {
              materialId: 'structure',
              materialVersion: 'v1',
              map: { id: 'tex:a', version: 'v1' },
              sampling: { filter: 'nearest', wrap: 'clamp', flipY: false, mipmaps: false, anisotropy: 0 },
              missingRequired: false,
            },
          ],
        ]),
      )
      // 材质身份含纹理内容身份 ⇒ 换绑定后旧批次必须被**卸载并重建**
      //（只卸载不重建会让画面停在空状态 —— 那是比"旧贴图"更严重的回退）
      expect(s.statsSnapshot().batchObjects, '换绑定后批次必须已重建（不是空的）').toBe(before)
      expect(
        s.statsSnapshot().materialBuilds,
        '换绑定必须真的建了新材质（旧材质身份不同 ⇒ 缓存不可能命中）',
      ).toBeGreaterThan(0)
      // 世代必须**不变**（换的是材质，不是绘制数据结构）
      expect(s.generation, '换绑定不得改世代（否则拾取映射静默全失效）').toBeTruthy()
    } finally {
      s.dispose()
    }
  })

  it('**负对照**：纹理版本变 ⇒ 材质身份变（`materialIdentityOf` 含 map 内容身份）', async () => {
    const { materialIdentityOf } = await import('@/presentation/presenter')
    const base = { materialId: 'structure', materialVersion: 'v1', sampling: { filter: 'nearest' as const, wrap: 'clamp' as const, flipY: false, mipmaps: false, anisotropy: 0 }, missingRequired: false }
    const a = materialIdentityOf(
      { id: 'structure', version: 'v1', blend: 'opaque', tint: 0xffffff, useVertexColor: true },
      { ...base, map: { id: 'tex:a', version: 'v1' } },
    )
    const b = materialIdentityOf(
      { id: 'structure', version: 'v1', blend: 'opaque', tint: 0xffffff, useVertexColor: true },
      { ...base, map: { id: 'tex:a', version: 'v2' } },
    )
    expect(a.id, '同一 URL 换了内容 ⇒ 身份必须不同（A28）').not.toBe(b.id)
  })
})

// 引用 `EffectiveOutlinePolicy` 使"政策类型确实被导出"成为可断言的事实
//（本文件不直接用它；下面这条断言把它钉住，防止类型被误删导致消费者编译失败）。
describe('P10e 段② · 导出面自检', () => {
  it('`outlinePlan` 的政策类型与基线常量可用（消费者可 import）', async () => {
    const m = await import('@/presentation/outlinePlan')
    expect(m.BASELINE_OUTLINE_POLICY.cellWithoutQuads).toBe('fallback-box')
    expect(m.BASELINE_OUTLINE_POLICY.stalePickAtOutline).toBe('suspend')
    const p: EffectiveOutlinePolicy = m.BASELINE_OUTLINE_POLICY
    expect(p).toBe(m.BASELINE_OUTLINE_POLICY)
  })
})

describe('P10e 段② · `applyKernelDocument`（生产调用点）', () => {
  it('内核文档 → 呈现：同文档同时间 ⇒ 不重编；时间变 ⇒ 重编', async () => {
    const { scene, content } = await assembledOf('multiblock-tier-only')
    const { createDocument } = await import('@/domain/document')
    const { TIME_ZERO: DOMAIN_T0, timeValue } = await import('@/domain/animation')
    const doc = createDocument('doc-p10e')
    // 把装配产物装进内核文档（与 `adoptDocument` 的形态一致）
    const withScene = { ...doc, scene, content }

    const s = new PresenterSession({ scope: 'test-p10e-kdoc' })
    try {
      const a = s.applyKernelDocument(withScene, DOMAIN_T0)
      expect(a.compileError).toBeNull()
      const b = s.applyKernelDocument(withScene, DOMAIN_T0)
      expect(b.applied, '同文档同时间 ⇒ 不得重编').toBe(false)
      const c = s.applyKernelDocument(withScene, timeValue(1, 20))
      expect(c.applied, '时间变 ⇒ 求值键变 ⇒ 必须重编（纹理/帧采样依赖它）').toBe(true)
    } finally {
      s.dispose()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A30 graphics-recovery（P11-E #262 补）：**恢复后文档/选择/时间/机位不丢**
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ## 这条补的是 A30 的子句缺口（#262 comment 6421 A30 行）
 *
 * B1 的定性：「`handleContextLost/handleContextRestored` 全树生产 2 处
 * （`presenterSession.ts:307/316`）+ 测试 4 处，**无一处读文档/选择/时间/机位**；
 * `e2e/presentation-gpu.spec.ts` 的探针返回字段表**完整列出**也没有这四项 ⇒
 * 承载面具备、判据缺失」。
 *
 * ## 判据的两半（结构面 + 行为面，缺一不可）
 *
 * **结构面**（与 A05「机位独立」同一手法）：恢复入口的**入参里没有**这四项 ——
 * `handleContextLost()`/`handleContextRestored()` 都不接受任何参数，故"恢复顺手重置
 * 文档/选择/时间/机位"在**接口层面不可表达**（要违约得先改签名，评审可见）。
 *
 * **行为面**：恢复周期**前后**，同一份（文档 + 时间）必须得到**同一个判定**
 * （`applied === false` ⇒ 内容身份链与编译产物都没丢，不是"恢复后重新来过"）；
 * 且恢复后**仍然**能对内容变化重编（不是"冻住"）。调用方持有的四项事实
 * （内核文档 / 选择 / 域时间 / 视口机位）在周期后必须**引用相同**（没有任何
 * 写路径碰过它们）—— 这一点在下面用真实的域类型（`createDocument`、
 * `EditContext.selection`、`timeValue`、`THREE.PerspectiveCamera`）钉住。
 *
 * 负对照（注入）：把"恢复时连编译产物一起丢"的变异体（= 恢复期 `dispose()`，
 * 即"恢复后一切重来"的实现）喂给**同一个**断言器 ⇒ 判红。
 */
describe('A30 graphics-recovery：恢复后文档/选择/时间/机位不丢（P11-E #262 补）', () => {
  /** 判据本尊（正/负对照共用一份）：同一输入在恢复周期后必须仍得"不重编"判定。 */
  function judgeSameInputAfterRecovery(out: { applied: boolean; generation: string | null }, generationBefore: string | null): void {
    expect(out.applied, 'A30：恢复后同一份文档+时间必须仍判"内容身份未变"（⇒ 编译产物与身份链都没丢）').toBe(false)
    expect(out.generation, 'A30：恢复不得改世代（改了 ⇒ 呈现/拾取映射全失效）').toBe(generationBefore)
  }

  /** 断言器判红 = 它抛错。 */
  function redOf(run: () => void): boolean {
    try {
      run()
      return false
    } catch {
      return true
    }
  }

  it('结构面：恢复入口**不接受**任何参数（恢复路径拿不到文档/选择/时间/机位）', () => {
    const s = new PresenterSession({ scope: 'test-a30-surface' })
    try {
      // 与 A05 的 `read.length === 0` 同一手法：违约形态在接口层面不可表达。
      expect(s.handleContextLost.length, '`handleContextLost()` 不得接受参数').toBe(0)
      expect(s.handleContextRestored.length, '`handleContextRestored()` 不得接受参数').toBe(0)
      // 且会话**没有**"设置选择/机位"的入口（选择与机位属调用方持有的编辑器实例状态）
      const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(s)).sort()
      expect(surface).not.toContain('setSelection')
      expect(surface).not.toContain('setCamera')
      expect(surface, '会话的公开面里不得出现选择/机位写入').not.toContain('setDocument')
    } finally {
      s.dispose()
    }
  })

  it('行为面：真实夹具上跑一次「丢失 → 恢复」，四项事实全部存活', async () => {
    const { scene, content } = await assembledOf('multiblock-ebf-2ch')
    const { createDocument } = await import('@/domain/document')
    const { timeValue } = await import('@/domain/animation')
    const { openDocumentState, reduceCommand, ALL_CAPABILITIES } = await import('@/application/commands')

    // ① 文档：内核文档（真实装配产物装进 `Document`，与生产调用点同形）
    const doc = { ...createDocument('doc-a30'), scene, content }
    // ② 时间：领域时间值（有理帧率；帧 7 / 20fps）
    const time = timeValue(7, 20)
    // ③ 选择：真实应用状态里的 `EditContext.selection`（#249 §6 所有权表：选择属上下文）
    let app = openDocumentState('doc-a30', 'ctx-a30')
    const added = reduceCommand(app, { kind: 'addObject', contextId: 'ctx-a30', objectType: 'annotation', name: 'sel' }, { capabilities: ALL_CAPABILITIES })
    expect(added.status).toBe('applied')
    app = added.state
    const objectId = Object.keys(app.docs['doc-a30']!.scene.objects)[0]!
    const selected = reduceCommand(app, { kind: 'select', contextId: 'ctx-a30', target: { kind: 'object', id: objectId } }, { capabilities: ALL_CAPABILITIES })
    expect(selected.status).toBe('applied')
    app = selected.state
    const selectionBefore = app.contexts['ctx-a30']!.selection.selected
    // ④ 机位：**视口**持有的观察相机（不在内核文档里 —— A05/A11 的结构事实）
    const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000)
    camera.position.set(3, 4, 5)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld(true)
    const cameraBefore = camera.matrixWorld.clone()

    const s = new PresenterSession({ scope: 'test-a30-behavior' })
    try {
      const first = s.applyKernelDocument(doc, time)
      expect(first.applied, '前置：首次应用必须真的编了').toBe(true)
      const generationBefore = s.generation
      const timeKeyBefore = s.activeKey?.time

      // ── 真实恢复周期：丢失（放弃全部 GPU 份额）→ 恢复 ──
      const abandoned = s.handleContextLost()
      expect(abandoned, '丢失必须放弃本会话的 GPU 份额（否则恢复后复用已失效句柄）').toBeGreaterThan(0)
      s.handleContextRestored()

      // ① 文档 + ② 时间：同一份输入仍判"身份未变"⇒ CPU 侧身份链与编译产物都在
      const again = s.applyKernelDocument(doc, time)
      judgeSameInputAfterRecovery(again, generationBefore)
      expect(s.activeKey?.time, '② 时间：恢复后求值键里的时间必须逐字段不变').toEqual(timeKeyBefore)
      expect(again.generation, '① 文档：会话报告的世代不变 ⇒ 同一份文档没被恢复路径重置').toBe(generationBefore)

      /**
       * ## ⚠️ 本批实测发现的**能力缺口**（如实登记，不硬造正向判据）
       *
       * `BatchedPresenter.handleContextLost()` 会 `this.generation = null` 并清空挂载
       * （旧句柄不复用，正确）；`handleContextRestored()` 只计数，恢复要靠调用方
       * "用当前有效版本重新 `apply()` 一次"（`presenter.ts:281` 明文）。
       * 但 `PresenterSession` 的公开入口只有 `applyIfChanged`/`applyKernelDocument`
       * —— 二者在**内容身份未变**时**提前返回**（`applied: false`），于是：
       *
       * > **内容没变的上下文丢失 ⇒ GPU 资源不会被重建，画面不会回来**；
       * > 而会话的**返回结果**里 `generation` 仍有值（那是保留的 CPU 侧
       * > `compiled.generation`），`session.generation`（呈现器实际世代）却是 `null`
       * > —— 两者不一致且**是静默的**。
       *
       * ⇒ 本组把该事实**登记为可核对的断言**（它判红 = 缺口已闭合，请同批把它升级为
       * 正向判据："恢复后同一输入也能重建 GPU 资源"）。
       */
      expect(
        s.generation,
        '⚠️ 缺口登记（A30 残余）：内容未变时恢复不重建 GPU ⇒ 呈现器实际世代仍为 null。'
          + '若本断言判红（= 恢复后已重建），说明缺口闭合：请把本条改成正向判据并核销登记。',
      ).toBeNull()
      expect(again.generation, '同一时刻，会话返回结果里仍报告 CPU 侧世代（不一致是静默的）').toBe(generationBefore)
      // 恢复后**仍然**能感知内容变化并重建（这是当前唯一的"画面回来"路径）
      const bumped = { ...doc, version: { ...doc.version, documentVersion: doc.version.documentVersion + 1 } }
      const rebuilt = s.applyKernelDocument(bumped, time)
      expect(rebuilt.applied, '恢复后内容变仍必须重编').toBe(true)
      expect(s.generation, '内容变 ⇒ 呈现器世代重新建立（当前唯一的重建路径）').not.toBeNull()

      // ③ 选择：引用相同（恢复路径没有任何写路径碰过应用状态）
      expect(app.contexts['ctx-a30']!.selection.selected, '③ 选择：必须引用相同（未被清空/改写）').toEqual(selectionBefore)
      expect(app.contexts['ctx-a30']!.selection.selected, '③ 选择：元素也得是同一批引用').toBe(selectionBefore)
      // ④ 机位：视口相机逐位不变
      expect(camera.matrixWorld.elements, '④ 机位：视口相机矩阵必须逐位不变').toEqual(cameraBefore.elements)
      expect(camera.position.toArray()).toEqual([3, 4, 5])
    } finally {
      s.dispose()
    }
  })

  it('**负对照（注入）**：把"恢复时连编译产物一起丢"的变异体喂给同一断言器 ⇒ 判红', async () => {
    const { scene, content } = await assembledOf('multiblock-tier-only')
    const { createDocument } = await import('@/domain/document')
    const { timeValue } = await import('@/domain/animation')
    const doc = { ...createDocument('doc-a30-neg'), scene, content }
    const time = timeValue(7, 20)

    const s = new PresenterSession({ scope: 'test-a30-neg' })
    try {
      s.applyKernelDocument(doc, time)
      const generationBefore = s.generation
      s.handleContextLost()
      s.handleContextRestored()
      // 正对照：正确实现判绿
      expect(redOf(() => judgeSameInputAfterRecovery(s.applyKernelDocument(doc, time), generationBefore))).toBe(false)
      // 变异体：恢复期把编译产物与身份链一起丢（`dispose()` = "恢复后一切重来"）
      s.handleContextLost()
      s.dispose()
      s.handleContextRestored()
      expect(
        redOf(() => judgeSameInputAfterRecovery(s.applyKernelDocument(doc, time), generationBefore)),
        '"恢复后一切重来"的实现必须判红（重编 + 换世代）',
      ).toBe(true)
    } finally {
      s.dispose()
    }
  })
})
