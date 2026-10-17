/**
 * 开发构建期收录的 `data/scenes/*.json`；键为不含扩展名的场景 id。
 *
 * ## 文件形态（与「打开场景」同一入口）
 *
 * 每份文件就是**旧格式的文档根**：裸 Plain 或 Envelope（`gzip+base64` / `base64(json)` 都行）。
 * `LoadBuiltinSceneOperator` 把它交给 `ctx.main.registries.parsers.detectAndParse` ——
 * 与文件选择器路径**同一份**解析/装配判据（见 `composition/documentLoad`）。
 *
 * ## 产品样例
 *
 * `builtin-multiblock-ebf` 是内置多方块样例（用户手测通道面板的入口）。它是
 * `scripts/multiblock-fixtures/make-builtin-sample.mjs` 从 ebf 夹具再生成的产品资产，
 * **不要手改**；产品语汇的名字在 {@link SCENE_DISPLAY_NAMES}。
 */

/**
 * `import: 'default'` 时，Vite 注入的值已是 JSON 根对象，不是 `{ default: ... }` 包装。
 */
const rawGlob = import.meta.glob('../../data/scenes/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>

function sceneIdFromPath(p: string): string {
  const seg = p.split(/[/\\]/).pop() ?? p
  return seg.replace(/\.json$/i, '')
}

const idToDoc = new Map<string, unknown>()
for (const [path, mod] of Object.entries(rawGlob)) {
  idToDoc.set(sceneIdFromPath(path), mod)
}

/**
 * 场景 id → 列表里的**呈现名**（产品语汇）。
 *
 * 为什么不是从文档 `meta.label` 自动读：文件里的 `label` 是文档元数据（可能是包名、
 * 导出工具给的临时名），而"内置示例"列表要的是**产品目录名**。两者是不同的东西，
 * 显式表让"列表里显示什么"可审、可测；未登记的 id 回落到 id 本身（不猜）。
 */
const SCENE_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'builtin-multiblock-ebf': '示例·电力高炉（多方块）',
  'builtin-animated-texture': '示例·动态贴图',
})

/** 内置示例在面板里的呈现名（未登记 ⇒ id 本身）。 */
export function displayNameOfScene(sceneId: string): string {
  return SCENE_DISPLAY_NAMES[sceneId] ?? sceneId
}

/** 排序后的场景 id（来自仓库 `data/scenes/*.json`） */
export function listDevSceneIds(): string[] {
  return [...idToDoc.keys()].sort((a, b) => a.localeCompare(b))
}

export function getDevSceneDocument(sceneId: string): unknown {
  const doc = idToDoc.get(sceneId)
  if (doc === undefined) {
    throw new Error(
      `未找到 dev 场景 "${sceneId}"（请将打包 JSON 放入 data/scenes/${sceneId}.json）。已知：${listDevSceneIds().join(', ') || '（无）'}`,
    )
  }
  return doc
}
