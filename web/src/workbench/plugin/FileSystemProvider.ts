// web/src/workbench/plugin/FileSystemProvider.ts

export interface SceneStorageProvider {
  readonly kind: 'local-file' | 'sde' | 'remote' | 'wiki-data' | 'builtin'
  load(): Promise<unknown>
  save(json: string, opts?: { suggestedName?: string }): Promise<void>
}

/** Local File API provider — wraps browser File + FileSystemFileHandle */
export function createLocalFileProvider(): SceneStorageProvider {
  return {
    kind: 'local-file',
    load: async () => { throw new Error('load() should be handled by file picker, not provider') },
    save: async (_json, _opts) => { /* delegate to existing downloadJson / fileHandle logic */ },
  }
}

/** Builtin scene provider — reads from static dev scenes */
export function createBuiltinProvider(sceneId: string): SceneStorageProvider {
  return {
    kind: 'builtin',
    load: async () => {
      const { getDevSceneDocument } = await import('@/dev/devScenes')
      return getDevSceneDocument(sceneId)
    },
    save: async () => { throw new Error('Builtin scenes are read-only') },
  }
}
