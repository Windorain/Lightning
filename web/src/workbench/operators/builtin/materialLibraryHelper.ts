import type { RuntimeDocument } from '@/workbench/context/runtimeDocument'
import type { MaterialLibraryApi } from '@/render/materials/simpleMaterialLibrary'
import { view3DConfigFromDocument } from '@/preview/previewFromDocument'

/** 共享工具：从 RuntimeDocument 构建 materialLibrary */
export async function buildMaterialLibrary(doc: RuntimeDocument): Promise<MaterialLibraryApi | null> {
  try {
    const raw = doc.toRaw() as Record<string, unknown>
    const cfg = await view3DConfigFromDocument({ ...raw })
    return cfg.materialLibrary
  } catch { return null }
}
