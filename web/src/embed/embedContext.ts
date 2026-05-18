/**
 * Embed BContext 工厂 — 创建精简版 BContext 供嵌入场景使用。
 *
 * 只带 viewport/config/eventDispatcher/operators，
 * 其余字段 stub null，嵌入场景不需要它们。
 *
 * 操作符通过 poll() 检查所需字段是否存在（如 bctx.viewport.camera），
 * 不存在则 poll 返回 false，操作符不可用。
 */
import { ref, shallowRef } from 'vue'
import type { BContext } from '@/workbench/context/bContext'
import { provideBContext } from '@/workbench/context/bContext'
import type { View3DConfig } from '@/preview/previewConfig'
import { globalOperators } from '@/workbench/operators/operatorRegistry'
import { eventDispatcher } from '@/workbench/eventDispatcher'

export function createEmbedBContext(config: View3DConfig): BContext {
  const ctx: BContext = {
    config: shallowRef(config),
    viewport: {
      camera: ref(null),
      contentGroup: ref(null),
      domElement: ref(null),
      definition: ref(null),
      layerPreview: ref(null),
      gizmo: ref(null),
      overlayGroup: ref(null),
      wireframe: ref(null),
      orbitTarget: ref(null),
    },
    operators: {
      exec: (id, props) => globalOperators.exec(ctx as any, id, props),
      invoke: (id, props, event, regionId) =>
        globalOperators.invoke(ctx as any, id, props, event as any, regionId),
      find: (id) => { const o = globalOperators.find(id); return o ? { id: o.id, label: o.label } : undefined },
      all: () => globalOperators.all().map(o => ({ id: o.id, label: o.label })),
      register: (op) => globalOperators.register(op),
    },
    eventDispatcher,
    // —— stub：embed 场景不使用 ——
    scene: null as any,
    selection: null as any,
    editHistory: null as any,
    toolRegistry: null as any,
    connection: null as any,
    queries: null as any,
    settings: null as any,
    log: {
      entries: { value: [] },
      lastDisplayable: { value: null },
      debug: () => undefined as unknown,
      info: () => undefined as unknown,
      operator: () => undefined as unknown,
      warn: () => undefined as unknown,
      error: () => undefined as unknown,
      clear: () => {},
      contains: () => false,
      recent: () => [],
    } as any,
    wikiConfig: null as any,
    statusMessage: { value: '' },
    wm: { windows: [], activeWindow: null },
    screen: null,
    area: null,
    region: null,
    rna: null as any,
    ui: null as any,
  }
  return ctx
}

export { provideBContext as provideEmbedBContext }
