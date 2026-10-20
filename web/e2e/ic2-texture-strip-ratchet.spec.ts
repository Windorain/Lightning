/**
 * #9 棘轮 · **IC2 横向多面子图带「按面号裁列」的回归闸门**（标准 E2E 套件，永久在册）。
 *
 * ## 这是「棘轮」而不是普通用例
 *
 * 用户裁决（#9 修复批收尾）：「把这个场景加入到 E2E 标准场景里面作为棘轮」。四条口径：
 *
 * 1. **产物永远在**：修后导出件**入仓**（`e2e/fixtures/ic2-nuclear-reactor-pair-postfix.json`，
 *    来源与 runId 见同目录同名 `.provenance.md`）⇒ 产物门控（`e2e/real-artifact-gate.ts`）**永不排除**本 spec；
 * 2. **在则必跑必过**：本 spec 不设 `skip`、不读环境变量、不回落 —— 用例要么真跑，要么红；
 * 3. **改坏必红**：把 `TextureStripCrop`/嵌入链改回「整条带」、或删掉/替换本场景与产物，
 *    下面的判据立刻变红（负对照读数见 PR；开发期把 fixture 换成修前 384×32 件实测过红）；
 * 4. **只许收紧**：判据的期望值是 #9 修复批的**实机读数**（硬编码在本文件，不读被测实现）；
 *    改判据只能改得更严（加断言、缩窄容差），不得放宽。
 *
 * ## 两条判据（都机械可判）
 *
 * | # | 判据 | 观测点 |
 * |---|---|---|
 * | ① | 产物内 IC2「面号材质」的 blob **尺寸 == 该面 sprite 格（32×32）**，不得是 384×32 / 192×32 整条带 | 直接读 JSON + PNG IHDR（不起浏览器） |
 * | ② | 经 web **真实装配**回放该产物，两个正交机位的「黄/黑」像素计数与修后实机读数**在 ±1% 内一致** | 生产拖放入口 `OPERATOR_OPEN_SCENE` + 生产出图算子 `OPERATOR_EXPORT_SHOT_PNG` 的下载 PNG 逐像素统计 |
 *
 * 判据 ②「为什么用颜色类计数而不是逐像素 MAE」：#9 已实测（`temp/pb-ic2-fix/evidence/16-mae-same-rect.json`）
 * web 无光照、游戏有平滑光照与渐变天空，**修后与修前的 MAE 同量级** ⇒ MAE 不能当判据。
 * 黄/黑正是「横带被压扁到一个面」的特征色：修前 south 黄 2318（修后/实机 3408），north 4636（6816），
 * 偏离 30%+；修后与实机对齐到 1% 以内。
 *
 * ## 产物与场景（入仓件身份）
 *
 * - 文件：`e2e/fixtures/ic2-nuclear-reactor-pair-postfix.json`（Envelope，gzip+base64）
 * - `sha256(LF)` = `370c50e2569142f39d5b3edb1926651a6bb23e04a5ca7ca49ee118df3b8f200f`（20732 B）
 * - 游戏内 runId `20261021-034525-export-scene-10`（#9 修复后实机导出，32×32 已逐像素对过运行时 jar）
 * - 世界：1× IC2 核反应堆 + 1× 核反应仓 + fire；4 条 IC2 面号材质 + 3 条对照材质
 *
 * ## 负对照怎么跑（**开发期验证，不留在套件里**）
 *
 * 套件永远只读上面的入仓路径（**没有**可被环境变量改指向的开关，杜绝「指到别处就悄悄换判据」）。
 * 开发期做负对照：用修前产物（384×32，`temp/pb-ic2-fix/prefix/cp-ic2-strip-prefix-final.json`）
 * **就地覆盖**该 fixture → 定向跑本 spec ⇒ 必须红 → `git checkout -- <fixture>` 恢复 ⇒ 必须绿。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { expect, test } from '@playwright/test'

import {
  gotoWorkbench,
  injectSceneDocumentOk,
  readContentMesh,
  waitForDocLoaded,
  waitForRenderedGrid,
  waitForViewportMounted,
} from './helpers/multiblock'
import { IC2_STRIP_RATCHET_PRODUCT_PATH } from './real-artifact-gate'

/** 入仓产物（唯一读取路径；无 env 覆盖）。 */
const PRODUCT = IC2_STRIP_RATCHET_PRODUCT_PATH

/** 入仓件的身份指纹（**CRLF 归一化后**的 sha256；见工作区铁律 6）。 */
const PRODUCT_SHA256_LF = '370c50e2569142f39d5b3edb1926651a6bb23e04a5ca7ca49ee118df3b8f200f'

/** 该产物在游戏内的 runId / exportId（与同名 .provenance.md 一致）。 */
const RUN_ID = '20261021-034525-export-scene-10'
const EXPORT_ID = '20261021-034525-export-scene-10#cp-ic2-strip-postfix'

/** IC2「横向多面子图带」的 sprite 格边长（IC2 注册的是 32px sprite；列数 = 带宽 / 32）。 */
const IC2_SPRITE_CELL_PX = 32

/**
 * 场景里的 4 条 IC2 面号材质（locator 形如 `<命名空间>:<路径>:<面号>`）+ 它们的原带宽。
 * 原带宽度只用于**失败信息**里说明「本来是多少列」——判据是裁后尺寸，不是带宽。
 */
const IC2_FACE_MATERIALS = [
  { locator: 'ic2:generator/blockNuclearReactor:4', faceIndex: 4, stripWidthPx: 384 },
  { locator: 'ic2:generator/blockRTGenerator:10', faceIndex: 10, stripWidthPx: 384 },
  { locator: 'ic2:machine/blockLathe:0', faceIndex: 0, stripWidthPx: 384 },
  { locator: 'ic2:machine/blockMiner:7', faceIndex: 7, stripWidthPx: 384 },
] as const

/** 对照材质：裁列只该动「面号材质」，动画/普通材质必须**原样**（防过度裁切）。 */
const CONTROL_MATERIALS = [
  { locator: 'stone', width: 16, height: 16 },
  { locator: 'lava_still', width: 16, height: 16 },
  { locator: 'lava_flow', width: 32, height: 32 },
] as const

/** 修前（整条带压扁）会出现的形态：判据里显式点名，失败信息才可读。 */
const FORBIDDEN_STRIP_SHAPES = [
  { width: 384, height: 32 },
  { width: 192, height: 32 },
] as const

/**
 * 判据 ② 的参考读数（#9 修复批实测，web 修后出图；游戏实拍为 3432/3256 与 6864/6512）。
 * 机位与机位参数逐字取自 `temp/pb-ic2-fix/postfix/shots/ortho-{south,north}.meta.json`。
 */
const REPLAY_CAMERAS = [
  {
    name: 'ortho-south',
    pos: [66, 12.5, 72.5] as [number, number, number],
    yaw: 180,
    pitch: 0,
    orthoHeight: 6,
    width: 1280,
    height: 720,
    expected: { yellow: 3408, dark: 3256 },
  },
  {
    name: 'ortho-north',
    pos: [66, 12.5, 56.5] as [number, number, number],
    yaw: 0,
    pitch: 0,
    orthoHeight: 6,
    width: 1280,
    height: 720,
    expected: { yellow: 6816, dark: 6512 },
  },
] as const

/** 容差：±1%（#9 PR 口径；修前偏离 30%+，故 1% 既抓得住回归也不因抗锯齿抖动误红）。 */
const COLOR_TOLERANCE = 0.01

/**
 * 回放用的**结构中心**（MC 世界坐标）—— 这是 #9 那组读数的**测量条件之一**，故钉死在这里。
 *
 * 为什么不用 `structureCenterFromScanBounds()` 现算：该 helper 对同一结构给的是
 * `(66, 13.5, 65.5)`（`maxY + 1 − h/2`），与 #9 出图时用的 `(66, 12.5, 65.5)`（`maxY − h/2`）
 * **相差 1 格**。两者的差别只是正交窗口上下移一格（会多/少露出底部一窄条熔岩），
 * 但**读数必须同源才可比**：实测用 `(66,12.5,65.5)` 出图，south/north 的黄/黑计数
 * 与 #9 公布值**逐值相同**（3408/3256、6816/6512，偏差 0%）。
 *
 * ⇒ 棘轮钉的是"能复现 #9 读数的那一个测量条件"，不在这里现算一个"更正确"的中心把基线漂走。
 * 若将来要换口径，必须同时换期望值并在 PR 说明（"只许收紧"，不许悄悄漂基线）。
 */
const REPLAY_CENTER: [number, number, number] = [66, 12.5, 65.5]

/** 图片证据落点（`web/e2e/screenshots/` 在 .gitignore 内，可再生）。 */
const OUT_DIR = path.join(import.meta.dirname, 'screenshots', 'ic2-strip-ratchet')

interface EnvelopeLike {
  documentFormat: string
  payloadEncoding: string
  meta: Record<string, unknown>
  payload: string
}

interface InnerDoc {
  frames: Array<{ structure: Record<string, unknown> }>
  materialPalette: Array<{ locator: string; kind: string; textureBlobIndex: number }>
  textureBlobs: string[]
  blockPalette: Array<{ registryId: string; meta: number }>
}

/**
 * 读入仓产物：**先归一化 CRLF**，再算指纹、再解析。
 *
 * 归一化不是形式主义：本仓 `core.autocrlf=true`，新鲜检出是 CRLF 而工作树常是 LF；
 * 不归一化的指纹判据只在其中一种形态下成立（工作区铁律 6，字节级断言同罪）。
 */
function readProduct(): { text: string; sha256: string; envelope: EnvelopeLike } {
  const text = fs.readFileSync(PRODUCT, 'utf8').replace(/\r\n/g, '\n')
  const sha256 = crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
  return { text, sha256, envelope: JSON.parse(text) as EnvelopeLike }
}

/** gzip+base64 信封 → 内层文档（与生产解析同口径；也接受未压缩 base64）。 */
function decodeEnvelope(envelope: EnvelopeLike): InnerDoc {
  const buf = Buffer.from(envelope.payload.replace(/\s+/g, ''), 'base64')
  const text = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8')
  return JSON.parse(text) as InnerDoc
}

/** 只读 PNG IHDR（不解码像素）：返回宽高与魔数是否成立。 */
function readPngHeader(b64: string): { ok: boolean; width: number; height: number; bytes: number } {
  const buf = Buffer.from(b64, 'base64')
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const ok =
    buf.length >= 24 &&
    signature.every((b, i) => buf[i] === b) &&
    buf.subarray(12, 16).toString('latin1') === 'IHDR'
  return { ok, width: ok ? buf.readUInt32BE(16) : -1, height: ok ? buf.readUInt32BE(20) : -1, bytes: buf.length }
}

test.describe('#9 棘轮 · IC2 横向多面子图带按面号裁列', () => {
  test('① 产物内 IC2 面号材质 blob == 该面 sprite 格（32×32），不是整条带', { tag: '@smoke' }, async () => {
    const { sha256, envelope } = readProduct()

    // ── 入仓件身份：换掉/改坏产物 ⇒ 立刻红（「产物永远在」的机械落点）──
    expect.soft(sha256, '入仓产物指纹不符：有人改过/替换了棘轮产物（' + PRODUCT + '）').toBe(PRODUCT_SHA256_LF)
    expect.soft(envelope.documentFormat, '入仓件必须是 Envelope（与生产导出同形态）').toBe('Envelope')

    const doc = decodeEnvelope(envelope)

    // ── 场景身份：这是 #9 的那个 IC2 反应堆 + 反应仓世界（不是随便一份 32×32 文档）──
    const meta = envelope.meta as {
      id?: string
      mode?: string
      provenance?: {
        runId?: string
        exportId?: string
        selection?: { sizeX?: number; sizeY?: number; sizeZ?: number }
      }
    }
    expect.soft(meta.id, '文档 id 不是棘轮场景').toBe('ic2-nuclear-reactor-pair')
    expect.soft(meta.provenance?.runId, '产物 runId 不是 #9 修复批的实机导出').toBe(RUN_ID)
    expect.soft(meta.provenance?.exportId, '产物 exportId 不是 #9 修复批的实机导出').toBe(EXPORT_ID)
    expect.soft(meta.provenance?.selection).toMatchObject({ sizeX: 6, sizeY: 3, sizeZ: 5 })

    const structure = doc.frames[0]!.structure as {
      scanBounds: { minX: number; maxY: number; minZ: number }
      cellGrid: number[][][]
    }
    expect.soft(structure.cellGrid.length, 'cellGrid 形状不再是 5×3×6').toBe(5)
    expect.soft(
      structure.cellGrid.map((slice) => slice.length),
      'cellGrid 形状不再是 5×3×6',
    ).toEqual([3, 3, 3, 3, 3])
    expect.soft(
      structure.cellGrid[0]!.map((row) => row.length),
      'cellGrid 形状不再是 5×3×6',
    ).toEqual([6, 6, 6])
    expect.soft(
      structure.cellGrid.flat(2).filter((v) => v !== 0),
      '场景格数不再是 6（反应堆 + 反应仓 + fire）',
    ).toHaveLength(6)
    expect.soft(structure.scanBounds).toEqual({ minX: 63, maxY: 14, minZ: 63 })
    expect.soft(
      doc.blockPalette.map((b) => b.registryId),
      '方块调色板里已没有 IC2 反应堆/反应仓（场景被换掉了）',
    ).toEqual(expect.arrayContaining(['IC2:blockGenerator', 'IC2:blockReactorChamber']))

    // ── 判据本体：IC2 面号材质必须**按面号裁成一格** ──
    const faceMaterials = doc.materialPalette.filter((m) => /^ic2:/i.test(m.locator) && /:\d+$/.test(m.locator))
    expect.soft(
      faceMaterials.map((m) => m.locator),
      'IC2 面号材质清单变了：棘轮场景的核心材料必须还在（删材料 = 改坏）',
    ).toEqual(IC2_FACE_MATERIALS.map((m) => m.locator))

    for (const expected of IC2_FACE_MATERIALS) {
      const material = faceMaterials.find((m) => m.locator === expected.locator)!
      const blob = doc.textureBlobs[material.textureBlobIndex]
      expect.soft(
        blob,
        expected.locator + '：materialPalette 指向的 textureBlobs[' + material.textureBlobIndex + '] 不存在',
      ).toBeTruthy()
      if (!blob) continue

      const png = readPngHeader(blob)
      expect.soft(png.ok, expected.locator + '：blob 不是合法 PNG（' + png.bytes + ' B）').toBe(true)

      // 显式点名「整条带」（修前形态）：失败信息直接指出被压扁的形态
      for (const forbidden of FORBIDDEN_STRIP_SHAPES) {
        expect.soft(
          [png.width, png.height],
          expected.locator +
            '：blob 是 ' +
            forbidden.width +
            '×' +
            forbidden.height +
            ' 整条带（面 ' +
            expected.faceIndex +
            ' 的横带未被裁列 / 裁列逻辑被改坏）',
        ).not.toEqual([forbidden.width, forbidden.height])
      }

      expect.soft(
        [png.width, png.height],
        expected.locator +
          '：blob 必须是该面 sprite 自己的 ' +
          IC2_SPRITE_CELL_PX +
          '×' +
          IC2_SPRITE_CELL_PX +
          ' 一格（原带 ' +
          expected.stripWidthPx +
          '×32 = ' +
          expected.stripWidthPx / IC2_SPRITE_CELL_PX +
          ' 列；面号 ' +
          expected.faceIndex +
          '）',
      ).toEqual([IC2_SPRITE_CELL_PX, IC2_SPRITE_CELL_PX])
    }

    // ── 对照：裁列只该动「面号材质」，普通/动画材质原样 ──
    for (const control of CONTROL_MATERIALS) {
      const material = doc.materialPalette.find((m) => m.locator === control.locator)
      expect.soft(material, '对照材质 ' + control.locator + ' 不在产物里（场景被换掉了）').toBeTruthy()
      const png = readPngHeader(doc.textureBlobs[material!.textureBlobIndex]!)
      expect.soft(png.ok, '对照材质 ' + control.locator + '：blob 不是合法 PNG').toBe(true)
      expect.soft(
        [png.width, png.height],
        '对照材质 ' + control.locator + ' 的 blob 被改动了（裁列只该作用于 IC2 面号材质）',
      ).toEqual([control.width, control.height])
    }

    // 证据行：判据结论落进报告（不需要看日志也能对账）
    console.log(
      '[#9 棘轮 ①] 产物 sha256(LF)=' +
        sha256 +
        '；IC2 面号材质 ' +
        IC2_FACE_MATERIALS.map((m) => m.locator + '⇒32×32').join(' / ') +
        '；对照 ' +
        CONTROL_MATERIALS.map((c) => c.locator + '⇒' + c.width + '×' + c.height).join(' / '),
    )
  })

  test(
    '② web 真实装配回放：south/north 黄/黑像素计数与修后实机读数 ±1% 一致',
    { tag: '@smoke' },
    async ({ page }, testInfo) => {
      const { envelope } = readProduct()
      const center = REPLAY_CENTER

      fs.mkdirSync(OUT_DIR, { recursive: true })

      await gotoWorkbench(page)

      // 生产拖放入口：与用户把文件拖进视口同一条 operator
      const injected = await injectSceneDocumentOk(page, envelope, path.basename(PRODUCT))
      expect(injected.docLoaded, '场景注入失败：' + injected.parseError).toBe(true)
      await waitForDocLoaded(page)
      await waitForViewportMounted(page)
      await waitForRenderedGrid(page)
      expect(injected.isMultiblock, '本产物是帧为主的世界文档，不应被判为「多方块为主」').toBe(false)

      // 等挂载期 mesh 世代稳定（两次连读一致；照 shot-ortho.spec.ts）
      let uuid = (await readContentMesh(page)).uuid
      for (let i = 0; i < 120; i++) {
        await page.waitForTimeout(50)
        const cur = (await readContentMesh(page)).uuid
        if (cur !== null && cur === uuid) break
        uuid = cur
      }
      expect(uuid, '内容 mesh 未落地（世代 uuid 为空）').not.toBeNull()

      for (const camera of REPLAY_CAMERAS) {
        const target = path.join(OUT_DIR, camera.name + '.png')
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 120_000 }),
          page.evaluate(
            async ({ cam, c }: { cam: Record<string, unknown>; c: [number, number, number] }) => {
              const ctx = (window as any).__vm__
              await ctx.getOperators().exec('OPERATOR_EXPORT_SHOT_PNG', { ...cam, center: c })
            },
            {
              cam: {
                name: camera.name,
                pos: camera.pos,
                yaw: camera.yaw,
                pitch: camera.pitch,
                orthoHeight: camera.orthoHeight,
                width: camera.width,
                height: camera.height,
              },
              c: center,
            },
          ),
        ])
        await download.saveAs(target)

        const bytes = fs.readFileSync(target)
        expect(bytes.length, camera.name + '：出图 0 字节').toBeGreaterThan(0)
        const header = readPngHeader(bytes.toString('base64'))
        expect.soft(
          [header.width, header.height],
          camera.name + '：出图尺寸不是 ' + camera.width + '×' + camera.height,
        ).toEqual([camera.width, camera.height])

        // 颜色类计数在页面内解码（Node 侧无 PNG 解码依赖；与 shot-ortho 同口径）
        const counts = await page.evaluate(async (b64: string) => {
          const img = new Image()
          img.src = 'data:image/png;base64,' + b64
          await img.decode()
          const canvas = document.createElement('canvas')
          canvas.width = img.naturalWidth
          canvas.height = img.naturalHeight
          const ctx = canvas.getContext('2d')
          if (!ctx) throw new Error('2D context 不可用，无法校验出图像素')
          ctx.drawImage(img, 0, 0)
          const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
          let yellow = 0
          let dark = 0
          let red = 0
          let green = 0
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i]!
            const g = data[i + 1]!
            const b = data[i + 2]!
            // 与 #9 分析同一阈值（temp/pb-ic2-fix/yellowcheck.py）
            if (r > 140 && g > 140 && b < 110) yellow++
            if (r < 40 && g < 40 && b < 40) dark++
            if (r > 150 && g < 70 && b < 70) red++
            if (g > 120 && r < 80 && b < 80) green++
          }
          return { yellow, dark, red, green, width: canvas.width, height: canvas.height }
        }, bytes.toString('base64'))

        for (const key of ['yellow', 'dark'] as const) {
          const expected = camera.expected[key]
          const actual = counts[key]
          const deviation = Math.abs(actual - expected) / expected
          expect.soft(
            deviation,
            camera.name +
              '：' +
              key +
              ' 像素计数 ' +
              actual +
              ' 偏离修后实机读数 ' +
              expected +
              ' 达 ' +
              (deviation * 100).toFixed(2) +
              '%（容差 ±' +
              (COLOR_TOLERANCE * 100).toFixed(0) +
              '%；修前形态为 ' +
              (camera.name === 'ortho-south' ? '2318/2199' : '4636/4392') +
              ' ⇒ 横带被压扁）',
          ).toBeLessThanOrEqual(COLOR_TOLERANCE)
        }

        testInfo.annotations.push({
          type: 'replay',
          description:
            camera.name +
            ' yellow=' +
            counts.yellow +
            '/' +
            camera.expected.yellow +
            ' dark=' +
            counts.dark +
            '/' +
            camera.expected.dark +
            ' red=' +
            counts.red +
            ' green=' +
            counts.green +
            ' → ' +
            target,
        })
        console.log(
          '[#9 棘轮 ②] ' +
            camera.name +
            ' yellow=' +
            counts.yellow +
            '（参考 ' +
            camera.expected.yellow +
            '） dark=' +
            counts.dark +
            '（参考 ' +
            camera.expected.dark +
            '） red=' +
            counts.red +
            ' green=' +
            counts.green +
            ' → ' +
            target,
        )
      }
    },
  )
})
