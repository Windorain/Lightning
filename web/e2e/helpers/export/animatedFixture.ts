/**
 * **动画文档派生器（M5-4）**：从仓库既有 `minimal-v2.json` 派生一份"两帧、不等帧时长"的文档。
 *
 * ## 为什么派生而不是新增一份大 JSON
 *
 * `minimal-v2.json` 的几何/文本块/纹理池形态已被 `e2e/input-routing.spec.ts` 证明
 * 能被生产解析器直接注入；本判据要改的**只有**材质声明与一张竖条贴图。
 *
 * ## 键名必须是 camelCase（易错点，写错会**静默**退化）
 *
 * plain 文档里的 `materialPalette[].animation` 只经两条生产路径读：
 *  - `composition/kernelAssembly#readAnimationSpec`（只认 `defaultFrametimeTicks` /
 *    `frameSequence[].index|timeTicks` / `interpolate`）；
 *  - `render/materials/simpleMaterialLibrary#materialEntryToParsedMcmeta`（同形状翻译）。
 *
 * mcmeta 的 snake_case 形态（`frametime` / `frames[].time`）只被
 * `render/assets/textureStripAnimation#parseMcmetaJson` 认，而该函数**零生产消费者**
 * ⇒ 写成 snake_case 不会报错，只会静默退化成"1 tick/帧"，判据随之退化成 `[5,5]`。
 *
 * ## 期望时长（**不从被测实现推导**，写进 spec 常量）
 *
 * `frameSequence: [{index:0}, {index:1, timeTicks:2}]` + `defaultFrametimeTicks:1`
 * ⇒ 帧 0 = 1 tick = 50 ms，帧 1 = 2 tick = 100 ms ⇒ GIF `delayCs [5, 10]`、`totalMs 150`。
 */

/** 4×8 竖条 PNG：上 4×4 纯红 `#ff0000`、下 4×4 纯蓝 `#0000ff`，全不透明。 */
export const TWO_FRAME_STRIP_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAICAYAAADeM14FAAAAFklEQVR4nGP4z8DwHxkzkCGAxidHAADQmD/BvPNxagAAAABJRU5ErkJggg=='

/** 声明侧的期望（spec 里与 UI 文本/解码字节对账，**不**从被测实现读）。 */
export const ANIMATED_FIXTURE_EXPECTATION = Object.freeze({
  frameCount: 2,
  totalMs: 150,
  delayCs: [5, 10] as readonly number[],
})

export interface AnimatedFixtureOptions {
  /** `false` ⇒ 去掉 `animation` 字段（静态材质），用于负对照。 */
  readonly animated?: boolean
}

/**
 * 从 `minimal-v2.json` 派生文档（**只改内存副本**，仓库原件一字不动）。
 *
 * @param base 已 `JSON.parse` 的 minimal-v2 文档（调用方负责读文件）
 */
export function deriveAnimatedDocument(
  base: Record<string, unknown>,
  options: AnimatedFixtureOptions = {},
): Record<string, unknown> {
  const doc = JSON.parse(JSON.stringify(base)) as Record<string, unknown>

  const palette = (doc.materialPalette as Record<string, unknown>[] | undefined) ?? []
  if (palette.length === 0) throw new Error('派生失败：minimal-v2.json 没有 materialPalette')
  // ⚠️ 负对照要**真的静态**：必须同时 `kind: 'static16'`。
  // 只删 `animation` 但保留 `kind: 'animated'` 仍会动画 —— `simpleMaterialLibrary`
  // 的 `materialEntryToParsedMcmeta` 对 `kind==='animated' && frameCount>=2` 会**合成**
  // 一份 `{defaultFrametimeTicks:1, frameSequence:[]}`（1 tick/帧）的声明。
  // 实测踩过：只删 animation 时 GIF 照常产出（2 帧、[5,5]），负对照不会红。
  const entry: Record<string, unknown> = {
    textureBlobIndex: 0,
    blend: 'opaque',
    kind: options.animated === false ? 'static16' : 'animated',
  }
  if (options.animated !== false) {
    // camelCase：唯一读入点见文件头。
    entry.animation = {
      defaultFrametimeTicks: 1,
      frameSequence: [{ index: 0 }, { index: 1, timeTicks: 2 }],
    }
  }
  palette[0] = entry
  doc.materialPalette = palette

  // ⚠️ 纹理池用**槽位键对象**（`{"0": "<base64>"}`），不是 `minimal-v2.json` 里的
  // `{id,mime,dataBase64}[]` 对象数组：装配层读的是 `textureBlobs[String(idx)]` 且要求
  // 值是**字符串字节**（`composition/kernelAssembly#resourcesFromLegacy`）。
  // 传对象数组 ⇒ payload 恒 null ⇒ 投影里连 `textureBlobs` 都不出现 ⇒
  // 烘焙时 `getMaterialForBatch` 抛"纹理未预取"（实测踩过，别退回对象数组）。
  doc.textureBlobs = { '0': TWO_FRAME_STRIP_PNG_BASE64 }
  return doc
}
