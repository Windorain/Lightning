/**
 * **图标烘焙独立上下文的丢失守卫**。
 *
 * ## 它防的是什么（具体到像素）
 *
 * `BlockIconCache` 自建一个 `THREE.WebGLRenderer`（不占视口画布）。该上下文丢失时
 * three 的 `render()` **静默 return**，随后 `ctx.drawImage(renderer.domElement)` 会把一张
 * 空画布拷进缓存并标成 `ready` ⇒ 图标永久空白，直到缓存失效，且**没有任何报错**
 * （SPEC §10.7:309 明文禁止的静默失败）。
 *
 * ## 判据分层（环境限制如实登记）
 *
 * vitest 里没有 WebGL 上下文（`new THREE.WebGLRenderer` 必然抛），故：
 *  1. **纯函数判据**：`iconBakeContextLost` 对 null/抛错/已丢失一律答"不可用"
 *     （不拿空白冒充图标 —— "不知道"必须按"不可用"处理）；
 *  2. **接线判据**：烘焙路径必须在 `render()` 前后各查一次，且失败原因用稳定串
 *     `ICON_BAKE_CONTEXT_LOST`（`bakeOne` 据此落 `status: 'error'`，可见可重试）。
 * 两者合起来等价于"丢失期不缓存空白图标"；真实像素由 e2e 注入路径覆盖。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ICON_BAKE_CONTEXT_LOST, iconBakeContextLost } from '@/render/interaction/blockIconCache'

describe('D10 图标缓存：丢失期不得缓存空白图标', () => {
  it('纯函数：null / 已丢失 / 取上下文抛错 一律答"不可用"（不冒充可用）', () => {
    expect(iconBakeContextLost(null), '没有上下文 ⇒ 不可用').toBe(true)
    expect(iconBakeContextLost(undefined), 'undefined ⇒ 不可用').toBe(true)
    expect(iconBakeContextLost({ isContextLost: () => true }), '已丢失 ⇒ 不可用').toBe(true)
    expect(
      iconBakeContextLost({
        isContextLost: () => {
          throw new Error('context gone')
        },
      }),
      '查询本身抛错 ⇒ 按不可用处理（宁可重试，不缓存空白）',
    ).toBe(true)
    // 反空洞真：正常上下文必须答"可用"（否则守卫恒真、烘焙永远失败）
    expect(iconBakeContextLost({ isContextLost: () => false })).toBe(false)
  })

  it('接线：烘焙路径在 render 前后各查一次，并用稳定原因串落失败', () => {
    const file = path.join(process.cwd(), 'src', 'render', 'interaction', 'blockIconCache.ts');
    // 铁律 6：文本判据必须 CRLF 归一化后再断言
    const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    const renderAt = src.indexOf('renderer.render(scene, cam)');
    expect(renderAt, '前提：烘焙路径必须仍有 render 调用').toBeGreaterThan(0);
    const guardAt = src.indexOf('iconBakeContextLost(renderer.getContext())');
    expect(guardAt, '烘焙路径必须查上下文（否则空白会被当图标缓存）').toBeGreaterThan(0);
    expect(guardAt, '守卫必须在 render 之前先查一次（丢失期不必渲染）').toBeLessThan(renderAt);
    expect(
      src.indexOf('iconBakeContextLost(renderer.getContext())', renderAt),
      'render 之后必须再查一次（渲染中途丢失 ⇒ render 静默返回、缓冲区为空）',
    ).toBeGreaterThan(renderAt);
    expect(src, '失败原因必须是稳定串（bakeOne 据此落 error、恢复后可重试）').toContain(ICON_BAKE_CONTEXT_LOST);
    // 丢失事件必须置位/复位（否则守卫只看得到瞬时状态）
    expect(src, '必须监听 webglcontextlost').toContain("'webglcontextlost'");
    expect(src, '必须监听 webglcontextrestored（恢复后重试）').toContain("'webglcontextrestored'");
  })
})