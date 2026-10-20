/**
 * png.test.mjs —— 自写 PNG 解码器的判据（零依赖，node --test）
 * ============================================================================
 * 只验三件事：像素读得对、判型需要的统计量算得对、坏输入明确报错而不是猜。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { PngError, decodePng, encodePng, pngStats } from './png.mjs'
import { goodTexture, placeholder16, strip } from './fixtures.mjs'

test('encodePng -> decodePng 像素往返一致', () => {
  const image = {
    width: 2,
    height: 2,
    pixels: Uint8Array.from([
      255, 0, 255, 255,
      0, 0, 0, 255,
      10, 20, 30, 255,
      40, 50, 60, 128,
    ]),
  }
  const decoded = decodePng(encodePng(image))
  assert.equal(decoded.width, 2)
  assert.equal(decoded.height, 2)
  assert.deepEqual([...decoded.data], [
    255, 0, 255,
    0, 0, 0,
    10, 20, 30,
    40, 50, 60,
  ])
})

test('#87 占位图统计：16x16、2 色、洋红/纯黑各 50%', () => {
  const stats = pngStats(encodePng(placeholder16()))
  assert.equal(stats.width, 16)
  assert.equal(stats.height, 16)
  assert.equal(stats.uniqueColors, 2)
  assert.equal(stats.magentaRatio, 0.5)
  assert.equal(stats.blackRatio, 0.5)
})

test('负对照：渐变贴图颜色数远大于 4', () => {
  const stats = pngStats(encodePng(goodTexture()))
  assert.equal(stats.uniqueColors, 256)
  assert.ok(stats.magentaRatio < 0.1)
})

test('横向带尺寸读得出来（384x32）', () => {
  const stats = pngStats(encodePng(strip(12)))
  assert.deepEqual([stats.width, stats.height], [384, 32])
  assert.equal(stats.uniqueColors, 12)
})

test('非 PNG 输入抛 PngError(PNG-SIGNATURE)，不静默返回空统计', () => {
  assert.throws(
    () => decodePng(Buffer.from('not a png at all')),
    (error) => error instanceof PngError && error.code === 'PNG-SIGNATURE',
  )
})
