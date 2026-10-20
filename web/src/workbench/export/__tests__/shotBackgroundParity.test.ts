/**
 * **器具底色 ↔ 判据底色** 的同值判据（#87 出图器具）。
 *
 * ## 为什么需要它
 *
 * 器具命令用 `SHOT_PNG_BACKGROUND`（0x9ec6e8）铺不透明天空底，而像素判据
 * （`e2e/shot-ortho.spec.ts` 的"非底色包围盒/面积占比"）按**字面三元组**
 * `[0x9e, 0xc6, 0xe8]` 识别底色。两者一旦漂移，判据会把整幅天空当成内容 ⇒
 * 包围盒变成整帧、"非空白"恒绿（**假绿**），而 e2e 仍会通过。
 *
 * 故把"同一个颜色"变成机械判据：读两处源码，断言字面三元组由常量逐字节派生。
 * 读源码一律先归一化行尾（`core.autocrlf=true`，铁律 6）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { SHOT_PNG_BACKGROUND } from '@/workbench/export/isoExportJob'

const WEB_ROOT = process.cwd()

function readNormalized(rel: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}

/** `0xRRGGBB` → `[0xrr, 0xgg, 0xbb]` 的字面三元组写法（判据里就是这么写的）。 */
function tripleOf(color: number): string {
  const r = ((color >> 16) & 0xff).toString(16)
  const g = ((color >> 8) & 0xff).toString(16)
  const b = (color & 0xff).toString(16)
  return `[0x${r}, 0x${g}, 0x${b}]`
}

describe('SHOT_PNG_BACKGROUND 与器具判据同值', () => {
  it('常量就是 #87 的天空蓝', () => {
    expect(SHOT_PNG_BACKGROUND).toBe(0x9ec6e8)
  })

  it('e2e 判据的底色三元组由该常量派生（漂移 ⇒ 判红）', () => {
    const spec = readNormalized('e2e/shot-ortho.spec.ts')
    expect(spec, '判据必须按同一个天空蓝识别底色').toContain(`const sky = ${tripleOf(SHOT_PNG_BACKGROUND)}`)
  })
})
