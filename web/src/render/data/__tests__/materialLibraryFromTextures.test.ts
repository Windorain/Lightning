/**
 * M8-5 · **图标材质库由已解码像素装配**（第二解码链退役后的判据）。
 *
 * ## 本文件证什么
 *
 * 旧 `render/data/buildMaterialLibrary` 的失败模式是**整库 reject**（`Promise.all` +
 * 逐项 `throw`）：57 张里坏 1 张 ⇒ 材质库建不起来 ⇒ 装载失败 ⇒ 整个视口不挂载
 * （S0-B D2）。新实现 `buildMaterialLibraryFromTextures` 只接收**已解码像素**：
 *
 *  1. 缺一张 ⇒ **不抛**，其余材质照常有贴图（坏一张只坏那一张）；
 *  2. 全缺 ⇒ **不抛**，材质库仍然建出来（图标走占位，而不是整块消失）—— 这是 Q1
 *     "资源失败不夺视口"在图标面上的同一取舍；
 *  3. **零解码**：本模块不得 import 任何解码器/`TextureLoader`（否则第二解码链复活）。
 */

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { buildMaterialLibraryFromTextures } from '@/render/data/materialLibraryFromTextures'

/**
 * 一份最小的 baked StructureData 形状（`listPaletteTextureDataUrls` 认的两种形态之一）。
 *
 * `blend` **显式给出**：缺 blend 时 `hydratePalette` 会调
 * `inferMaterialBlendModeFromTexture`（要 2D canvas）—— 那是**既有**行为，
 * 与本模块无关（旧 `buildMaterialLibrary` 同一条路径），故本文件不覆盖它。
 */
function plainDoc(textureBlobCount: number): Record<string, unknown> {
  return {
    geometryPhase: 'baked',
    materialPalette: Array.from({ length: textureBlobCount }, (_, i) => ({ textureBlobIndex: i, blend: 'opaque' })),
    textureBlobs: Array.from({ length: textureBlobCount }, (_, i) => `AAAA${i}`),
  }
}

function texture(): THREE.Texture {
  const t = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat)
  t.needsUpdate = true
  return t
}

describe('M8-5 · 已解码像素 → 图标材质库', () => {
  it('全部就绪 ⇒ 每个材质槽都有 preloaded 纹理', async () => {
    const lib = buildMaterialLibraryFromTextures(plainDoc(3), () => texture())
    const mat = await lib.getMaterialForBatch({
      materialId: '0', blend: 'opaque', tint: new THREE.Color(0xffffff), useVertexColor: true,
    })
    expect(mat.map, '就绪的材质必须带 map').not.toBeNull()
    lib.dispose()
  })

  it('**坏一张只坏一张**：缺一张 ⇒ 不抛；缺的那槽无 map，其余照常有（负对照：整库 reject 会让本用例抛）', async () => {
    const lib = buildMaterialLibraryFromTextures(plainDoc(3), (id) => (id === '1' ? null : texture()))
    const desc = (id: string) => ({
      materialId: id, blend: 'opaque' as const, tint: new THREE.Color(0xffffff), useVertexColor: true,
    })
    expect((await lib.getMaterialForBatch(desc('0'))).map, '好槽必须有贴图').not.toBeNull()
    expect((await lib.getMaterialForBatch(desc('2'))).map, '好槽必须有贴图').not.toBeNull()
    await expect(lib.getMaterialForBatch(desc('1')), '缺槽必须显式失败（该材质的图标落占位），而不是绑一张假图').rejects.toThrow()
    lib.dispose()
  })

  it('**全缺**（全部资源失败）⇒ 仍然建出材质库、不抛（Q1：不夺视口；图标降级）', () => {
    expect(() => {
      const lib = buildMaterialLibraryFromTextures(plainDoc(4), () => null)
      lib.dispose()
    }).not.toThrow()
  })

  it('**零解码**：本模块不得出现解码入口（第二解码链不得复活）', () => {
    // **只扫代码**：注释里提到旧链的名字是历史说明，不是解码入口（否则判据会把
    // "解释被退役的东西"当成"那东西还在"—— 与 CRLF 归一化同族的假红）。
    const src = fs
      .readFileSync(path.join(import.meta.dirname, '..', 'materialLibraryFromTextures.ts'), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    for (const banned of ['TextureLoader', 'createImageBitmap', 'loadTextureDataUrl', 'decode(']) {
      expect(src.includes(banned), '不得出现解码入口：' + banned).toBe(false)
    }
    // 反空洞真：确实读到了源文件
    expect(src.length).toBeGreaterThan(500)
  })

  /**
   * **退役审计（#171）**：旧链的**文件**与**生产引用**都必须归零。
   *
   * 为什么要有这条常驻判据（而不是只在交付报告里写一句"已删除"）：
   * "第二解码链"最容易的回归形态不是有人重写它，而是**有人把旧文件恢复回来接上**
   * （复制粘贴、冲突解错、或者 `git checkout` 一把把删除抹掉 —— 本包实测发生过一次）。
   * 那条路径不会让任何行为判据变红（新链还在跑），却让"解码只有一处"重新变成假的。
   */
  it('**退役审计**：旧链文件已删除，且生产代码里对它的 import 归零', () => {
    const legacy = path.join(import.meta.dirname, '..', 'buildMaterialLibrary.ts')
    expect(fs.existsSync(legacy), '旧链文件 buildMaterialLibrary.ts 不得复活').toBe(false)

    // 扫生产源码（排除 __tests__）：任何 `.../buildMaterialLibrary'` 形态的导入都必须为零。
    // 只扫"导入形态"而不是裸名 —— 注释里解释旧链是**允许且必要**的（历史说明）。
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === '__tests__' || e.name === 'node_modules') continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.(ts|tsx|vue)$/.test(e.name)) continue
        const code = fs
          .readFileSync(full, 'utf8')
          .replace(/\r\n/g, '\n')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n')
          .filter((line) => !line.trim().startsWith('//'))
          .join('\n')
        if (/from\s+['"][^'"]*buildMaterialLibrary['"]/.test(code)) {
          hits.push(path.relative(path.join(process.cwd(), 'src'), full))
        }
      }
    }
    walk(path.join(process.cwd(), 'src'))
    expect(hits, '生产代码不得再 import 旧链（第二解码链）：' + hits.join(', ')).toEqual([])
  })
})
