/**
 * R1-β① C6 · **画面贴图可见**（真实浏览器 + 真实工作台 + 真实夹具）。
 *
 * ## 为什么这条判据必须存在（而不是只报"端口被调用 / 字段被赋值"）
 *
 * C5 已把材质统一的基础设施做完（`TexturePort` 生产实现 + 每帧接线 + 解码器），
 * 但**画面仍无贴图**：`kernelPresentationInputs` 对每个 `blockGrid` 只产一个图元、
 * 材质 id 恒 `'structure'`，而绑定键约定是 `material:<下标>`
 * （`kernelTextureResources#MATERIAL_ID_PREFIX`）⇒ `createMaterial` 永不设 `params.map`。
 *
 * 本判据的观测面是**真实 GL 上挂着的材质**（遍历 `presenterSurface.object3d` 读
 * `MeshBasicMaterial.map`）——它区分于"端口被调用"与"绑定表非空"：
 * 那两者在本批之前**都是绿的**，而画面一张贴图都没有。
 *
 * ## 层级声明（本判据证明到哪一层）
 *
 * | 层 | 本文件是否覆盖 |
 * |---|---|
 * | 纯函数（编译产物 / 绑定表 / 材质描述符） | 覆盖（但**不**作为主证据） |
 * | 真实浏览器 + 真实工作台 UI + 生产装配 | **主证据**：`gotoWorkbench` → 注入真实夹具 → 帧循环 apply |
 * | 真实 WebGL 上传与采样 | 覆盖（材质由真实渲染器创建，`map` 指向已上传纹理） |
 * | 画面**像素**能看出某张贴图（纹理内容比对） | ⚠️ **不覆盖**：截图为"画面非空 + 材质带图"的旁证，不做逐像素纹理比对 |
 *
 * 负对照：把绑定表清空（等价于"没接材质统一"）⇒ 同一观测面必须答 `withMap === 0`
 * ——否则"带贴图"这个观测是恒真的。
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { gotoWorkbench, injectSceneDocumentOk, readFixture, waitForViewportMounted } from './helpers/multiblock'
import { expectNotBlank, readPixelSignature } from './helpers/multiblock/pixels'

const SHOT_DIR = path.join(import.meta.dirname, 'screenshots', 'c6-texture')

interface TextureObservation {
  readonly hasSurface: boolean
  readonly meshes: number
  readonly materials: number
  readonly withMap: number
  readonly distinctMaps: number
  /** 编译产物声明的材质 id（用于断"符不符 `material:<下标>` 约定"）。 */
  readonly declaredIds: readonly string[]
}

/**
 * 遍历**真实挂载树**数"带 `map` 的材质"。
 *
 * 为什么遍历 `object3d` 而不是读 `materialDescriptors()`：后者是**编译产物**的清单
 * （"应该有哪几个材质"），前者是**真的挂上了什么**。C5 的缺口正是"清单对、画面无图"。
 */
async function readTextureObservation(page: import('@playwright/test').Page): Promise<TextureObservation> {
  return (await page.evaluate(() => {
    const ctx = (window as any).__vm__
    const slots = ctx?.viewports
    const blank = {
      hasSurface: false, meshes: 0, materials: 0, withMap: 0, distinctMaps: 0, declaredIds: [] as string[],
    }
    if (slots === undefined) return blank
    const candidates: any[] = []
    const active = slots.active?.value
    if (active) candidates.push(active)
    for (const id of ['r-viewport', 'r-wiki-preview', 'r-workbench-viewport', 'r-embed']) {
      const s = slots.get?.(id)
      if (s) candidates.push(s)
    }
    const hit = candidates.find((s) => s?.presenterSurface != null)
    if (hit === undefined) return blank

    let meshes = 0
    let materials = 0
    let withMap = 0
    const mapUuids = new Set<string>()
    hit.presenterSurface.object3d.traverse((o: any) => {
      if (o?.isMesh !== true && o?.isInstancedMesh !== true) return
      meshes += 1
      const m = Array.isArray(o.material) ? undefined : o.material
      if (m === undefined || m === null) return
      materials += 1
      if (m.map !== null && m.map !== undefined) {
        withMap += 1
        if (m.map.uuid !== undefined) mapUuids.add(String(m.map.uuid))
      }
    })
    const declaredIds = (hit.presenterSurface.materialDescriptors?.() ?? []).map((m: any) => String(m.id))
    return { hasSurface: true, meshes, materials, withMap, distinctMaps: mapUuids.size, declaredIds }
  })) as TextureObservation
}

/** 清空绑定（等价于"没接材质统一"）—— 负对照用的**唯一**变量。 */
async function clearBindings(page: import('@playwright/test').Page): Promise<boolean> {
  return (await page.evaluate(() => {
    const ctx = (window as any).__vm__
    const slots = ctx?.viewports
    if (slots === undefined) return false
    const candidates: any[] = []
    const active = slots.active?.value
    if (active) candidates.push(active)
    for (const id of ['r-viewport', 'r-wiki-preview', 'r-workbench-viewport', 'r-embed']) {
      const s = slots.get?.(id)
      if (s) candidates.push(s)
    }
    const hit = candidates.find((s) => s?.presenterSurface != null)
    if (hit === undefined) return false
    hit.presenterSurface.setTextureBindings(new Map())
    return true
  })) as boolean
}

test.describe('R1-β① C6 · 画面贴图可见（真实浏览器 / 真实工作台 / 生产装配）', () => {
  test('真实夹具：挂载材质真的带 `map`，且材质 id 符 `material:<下标>` 约定', async ({ page }, testInfo) => {
    const file = 'multiblock-ebf-2ch.json'
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    await gotoWorkbench(page)
    const fx = readFixture(file)
    await injectSceneDocumentOk(page, fx.envelope, file)
    await waitForViewportMounted(page)
    // 帧循环几拍：资源五态 → 端口上传 → bindTextures → 重挂材质
    await page.waitForTimeout(2000)

    const obs = await readTextureObservation(page)
    console.log('[C6·画面贴图] ' + JSON.stringify({ file, ...obs }))

    // ① 真的有呈现会话与挂载网格（不是"测了个空场景"）
    expect(obs.hasSurface, '视口必须装配呈现会话').toBe(true)
    expect(obs.meshes, '必须有挂载的网格').toBeGreaterThan(0)
    expect(obs.materials, '网格必须挂材质').toBeGreaterThan(0)
    // ② **主判据**：至少一个挂载材质的 `map` 非空 —— 贴图真的到了材质上
    expect(
      obs.withMap,
      'C6 起挂载材质必须带 `map`（否则"材质统一"仍未交付 —— C5 的缺口正是"清单对、画面无图"）',
    ).toBeGreaterThan(0)
    // ③ 多材质夹具 ⇒ 不止一张贴图（证明不是"一张图贴满"的假象）
    expect(obs.distinctMaps, '多材质夹具必须用到多于一张纹理').toBeGreaterThan(1)
    // ④ 材质 id 必须符绑定约定（这正是 C5 缺口的那一环）
    expect(obs.declaredIds.length, '编译产物必须有材质声明').toBeGreaterThan(0)
    for (const id of obs.declaredIds) {
      expect(id, `材质 id 必须符 material:<下标> 约定，实得 ${id}`).toMatch(/^material:\d+$/)
    }

    // ⑥ 画面取证：截图 + 非空像素签名（旁证；不做纹理内容比对）
    const png = await page.screenshot({ fullPage: false })
    const shot = path.join(SHOT_DIR, `c6-texture-${testInfo.project.name}.png`)
    fs.writeFileSync(shot, png)
    const sig = await readPixelSignature(page, png)
    expectNotBlank(sig, 'C6 视口画面')

    // ⑦ 负对照：清空绑定 ⇒ **同一观测面**必须答 0 张
    expect(await clearBindings(page), '必须取到呈现会话才能做负对照').toBe(true)
    await page.waitForTimeout(500)
    const after = await readTextureObservation(page)
    console.log('[C6·画面贴图·负对照] ' + JSON.stringify(after))
    expect(
      after.withMap,
      '清空绑定 ⇒ 挂载材质必须全部无 `map`（否则上一条是恒真的，无区分力）',
    ).toBe(0)
    expect(after.meshes, '负对照仍应挂着网格（只是无图）').toBeGreaterThan(0)
  })
})
