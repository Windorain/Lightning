/**
 * 部件物品图标通道（blockIconCache 扩展）单元测试。
 *
 * 覆盖（键控通道 + 回退链）：
 *  - `partItemKeyToBlockIdCandidates`：物品身份键 → 宿主方块键候选（回退通道 2 的键映射）；
 *  - `ensurePartIcons`：部件键登记/排队/订阅通知；与宿主键同表不撞名；
 *  - `setPartIconTextureSource`：通道 1 纹理源以物品身份键被调用；更换纹理源 ⇒ 部件条目重烘；
 *  - `setRevisionKey`：整表失效同时清空部件键登记。
 *
 * node 环境无 DOM/WebGL：任何烘焙路径都确定性失败 ⇒ 条目落 `error`（占位形态），
 * 借此断言回退链"走到底、不悬挂"；真实纹理/WebGL 产出由产物与 E2E 验证。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  BlockIconCache,
  partItemKeyToBlockIdCandidates,
} from '@/render/interaction/blockIconCache'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import type { StructureDefinition } from '@/render/schema/types'

import singleboxFixture from '../../../../e2e/fixtures/parts-singlebox-mix.v2.json'

/** 图标缓存的材质库在烘焙失败路径上不可达（node 无 WebGL）；仅满足构造签名 */
const stubLibrary = { tick() {}, isDisposed: () => false } as unknown as MaterialLibraryApi

type Doc = { frames: Array<{ structure: unknown }> }

function defOf(doc: unknown): StructureDefinition {
  return (doc as Doc).frames[0]!.structure as StructureDefinition
}

/** 等串行烘焙队列沉降（node 环境每条都确定性失败 → error 占位） */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 5))
}

describe('partItemKeyToBlockIdCandidates（物品身份键 → 宿主键候选）', () => {
  it('damage=0 先 registry 后 registry@0（宿主键省略 @0）', () => {
    expect(partItemKeyToBlockIdCandidates('minecraft:stone_slab:0')).toEqual([
      'minecraft:stone_slab',
      'minecraft:stone_slab@0',
    ])
  })

  it('damage>0 先 registry@damage 后 registry', () => {
    expect(partItemKeyToBlockIdCandidates('appliedenergistics2:item.ItemMultiPart:220')).toEqual([
      'appliedenergistics2:item.ItemMultiPart@220',
      'appliedenergistics2:item.ItemMultiPart',
    ])
  })

  it('#nbt 判别被剥离（FMP 材料串不进键映射）', () => {
    expect(partItemKeyToBlockIdCandidates('fmp:microblock:1#mat=stone')).toEqual([
      'fmp:microblock@1',
      'fmp:microblock',
    ])
  })

  it('无 damage 段 / 非数字段：原样单候选', () => {
    expect(partItemKeyToBlockIdCandidates('minecraft:stone')).toEqual(['minecraft:stone'])
    expect(partItemKeyToBlockIdCandidates('mod:item:abc')).toEqual(['mod:item:abc'])
  })
})

describe('BlockIconCache 部件物品图标通道', () => {
  it('ensurePartIcons：登记部件键、排队烘焙、失败落 error 占位并通知订阅者', async () => {
    const cache = new BlockIconCache(stubLibrary, undefined, defOf(singleboxFixture))
    // 有宿主调色板候选的键：烘焙跨 await ⇒ 先入 pending
    const slabKey = 'minecraft:stone_slab:0'
    cache.ensurePartIcons([slabKey, slabKey]) // 去重：同键只排一次
    expect(cache.get(slabKey).status).toBe('pending')
    // 无同名宿主的 AE2 物品键：全链同步落空 ⇒ 立即 error 占位（不悬挂）
    const ae2Key = 'appliedenergistics2:item.ItemMultiPart:220'
    const onReady = vi.fn()
    cache.subscribe(ae2Key, onReady)
    cache.ensurePartIcons([ae2Key])
    await settle()
    for (const key of [slabKey, ae2Key]) {
      const entry = cache.get(key)
      expect(entry.status).toBe('error') // 通道 3 占位
      expect(entry.error?.message).toContain(key)
    }
    expect(onReady).toHaveBeenCalled()
    cache.dispose()
  })

  it('通道 1：纹理源以物品身份键被调用；node 无 Image ⇒ 继续走回退链到底', async () => {
    const cache = new BlockIconCache(stubLibrary, undefined, defOf(singleboxFixture))
    const source = vi.fn(() => 'aGVsbG8=') // 任意 base64；node 无 Image 必解码失败
    cache.setPartIconTextureSource(source)
    const key = 'minecraft:stone_slab:0'
    cache.ensurePartIcons([key])
    await settle()
    expect(source).toHaveBeenCalledWith(key) // 键控通道：以物品身份键查询纹理体系
    expect(cache.get(key).status).toBe('error') // node 环境确定性占位（回退链走到底）
    cache.dispose()
  })

  it('更换纹理源 ⇒ 已烘部件条目作废重烘（宿主条目不受影响）', async () => {
    const cache = new BlockIconCache(stubLibrary, undefined, defOf(singleboxFixture))
    const partKey = 'minecraft:stone_slab:0'
    cache.ensurePartIcons([partKey])
    cache.ensure(['minecraft:stone']) // 宿主键同表共存
    await settle()
    expect(cache.get(partKey).status).toBe('error')
    cache.setPartIconTextureSource(() => null) // 新源（无纹理）⇒ 部件条目重烘
    expect(cache.get(partKey).status).toBe('pending')
    expect(cache.get('minecraft:stone').status).toBe('error') // 宿主条目不重烘
    await settle()
    cache.dispose()
  })

  it('setRevisionKey：整表失效同时清空部件键登记（结构切换语义不变）', async () => {
    const cache = new BlockIconCache(stubLibrary, undefined, defOf(singleboxFixture))
    const key = 'minecraft:fence:0'
    cache.ensurePartIcons([key])
    await settle()
    cache.setRevisionKey('rev-2')
    expect(cache.get(key).status).toBe('idle')
    cache.dispose()
  })

  it('宿主路径行为不变：未注册键 ⇒ error；palette 键 ⇒ 烘焙尝试（node 失败占位）', async () => {
    const cache = new BlockIconCache(stubLibrary, undefined, defOf(singleboxFixture))
    cache.ensure(['minecraft:nope', 'minecraft:stone_slab'])
    await settle()
    expect(cache.get('minecraft:nope').error?.message).toContain('方块未注册')
    expect(cache.get('minecraft:stone_slab').status).toBe('error') // WebGL 不可用 ⇒ 占位，不悬挂
    cache.dispose()
  })
})
