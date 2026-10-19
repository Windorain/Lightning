/**
 * **尾换行口径的机器证据**（P10 #261 收口 P9 G-2）。
 *
 * ## 本文件钉住什么
 *
 * P9 登记的缺口原文：
 *
 * > 尾换行口径：`util/browser.ts:6` 的 `downloadJson` 补 `\n`，mod 侧不补
 * > ⇒ B-1「Plain 逐字节」在两个写出路径上口径不同。**需 P10 明确"谁写文件"**。
 *
 * 裁决（见 `util/browser.ts` 的 `BROWSER_DOWNLOAD_TRAILING_NEWLINE`）：
 * 两条路径**各自正确**，因为它们写的是**不同的东西** ——
 * 判据只约束**命令通道产物**（mod 侧写出，逐字节对账对象），
 * 而浏览器下载是**人类下载**（另存为后用编辑器打开）。
 *
 * ## 为什么"两条都写/都不写"都是错的（判据不是风格偏好）
 *
 *  - 若浏览器下载**不**写：POSIX 工具把"无换行结尾"当异常，diff 显示
 *    `\ No newline at end of file` —— 而这不是任何判据要求的；
 *  - 若命令通道产物**写**：B-1 的逐字节对账会红（mod 侧是权威写出方，
 *    浏览器不能改写它的字节）。
 *
 * ⇒ 两者必须**显式不同**，且这个不同必须有**声明**（否则任何一方"顺手统一"
 * 都会静默改变一条路径的字节口径）。本文件断言声明与实现一致。
 */

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BROWSER_DOWNLOAD_TRAILING_NEWLINE } from '@/util/browser'
import { PLAIN_SERIALIZATION } from '@/adapters/files/plainCodec'

/** `web/` 根（本文件在 `web/src/util/__tests__/`，故上溯三层）。 */
const WEB_ROOT = path.join(import.meta.dirname, '..', '..', '..')

/** 读源码并**归一化行尾为 LF**（铁律 6：本仓 `core.autocrlf=true`）。 */
function readSource(rel: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}

describe('尾换行口径：两条写出路径各自显式声明（G-2）', () => {
  it('浏览器下载路径：**写**尾换行，且由常量声明', () => {
    expect(BROWSER_DOWNLOAD_TRAILING_NEWLINE, '浏览器下载必须写尾换行').toBe(true)
    const src = readSource('src/util/browser.ts')
    // 声明必须**真的被用**（否则常量只是装饰，实现仍可漂移）
    expect(
      /BROWSER_DOWNLOAD_TRAILING_NEWLINE\s*\?\s*`\$\{body\}\\n`\s*:\s*body/.test(src),
      '`downloadJson` 必须按常量决定是否补 `\\n`（声明与实现同源）',
    ).toBe(true)
  })

  it('命令通道产物：**不写**尾换行（B-1 逐字节判据的对象）', () => {
    expect(
      PLAIN_SERIALIZATION.trailingNewline,
      '命令通道产物不得有尾换行（mod 侧是权威写出方）',
    ).toBe(false)
    expect(PLAIN_SERIALIZATION.indent, '命令通道产物是紧凑形态').toBeUndefined()
  })

  it('**两条口径确实不同**（若有人"顺手统一"，本条判红）', () => {
    // 两个常量都是字面量类型（`true` / `false`），故 TS 会把 `===` 判为
    // "类型无重叠" —— 那**正是**本条要断言的事实。用 `as boolean` 让比较
    // 在运行期进行（类型层面的"永不相等"本身就是结论，但断言仍要跑）。
    const browserWrites = BROWSER_DOWNLOAD_TRAILING_NEWLINE as boolean
    const channelWrites = PLAIN_SERIALIZATION.trailingNewline as boolean
    expect(
      browserWrites === channelWrites,
      '两条写出路径的尾换行口径必须**显式不同**：判据只约束命令通道产物，'
        + '而人类下载需要尾换行（否则 POSIX 工具/diff 会把它当异常）。'
        + '把它们统一（无论统一到哪一边）都会静默改变一条路径的字节口径。',
    ).toBe(false)
  })

  it('**负对照**：判据能抓到"实现与声明不一致"', () => {
    // 模拟"声明说 true、实现硬编码不加 \n"的形态 —— 上面第 1 条的判定式必须判红。
    const drifted = 'const text = `${body}`'
    expect(
      /BROWSER_DOWNLOAD_TRAILING_NEWLINE\s*\?\s*`\$\{body\}\\n`\s*:\s*body/.test(drifted),
      '实现漂移（忽略声明）必须被同一条判定式抓到',
    ).toBe(false)
    // 且判定式**不是恒假**：合规写法必须为真
    const compliant = 'const text = BROWSER_DOWNLOAD_TRAILING_NEWLINE ? `${body}\\n` : body'
    expect(
      /BROWSER_DOWNLOAD_TRAILING_NEWLINE\s*\?\s*`\$\{body\}\\n`\s*:\s*body/.test(compliant),
      '合规写法必须为真（证明上一条不是空转）',
    ).toBe(true)
  })
})
