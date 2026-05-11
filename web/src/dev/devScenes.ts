/**
 * 开发构建期收录的 `data/scenes/*.json`；键为不含扩展名的场景 id。
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
