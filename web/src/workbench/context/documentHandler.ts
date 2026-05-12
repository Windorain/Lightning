/**
 * 文档格式分发中心 — 对标 Blender 的文件格式 handler（OBJ/FBX/glTF → Main 数据库）。
 *
 * 所有格式统一转为 V2PlainSceneDocument。不可转换的返回 null + 错误信息。
 * 加载时入口统一调用，预览和操作符只消费 V2Plain。
 */
import type { V2PlainSceneDocument } from '@/render/data/sceneDocumentV2'

export interface DocumentHandler {
  /** 优先级: 越小越先匹配 (V2=10, World=20, StructureData=30) */
  priority: number
  formatName: string
  detect(doc: unknown): boolean
  /** 转为可编辑的 V2PlainSceneDocument；不能转换返回 null */
  toEditable(doc: unknown): V2PlainSceneDocument | null
}

export interface NormalizeResult {
  document: V2PlainSceneDocument | null
  handler: DocumentHandler | null
  error?: string
}

class DocumentFormatDispatcher {
  private handlers: DocumentHandler[] = []

  register(h: DocumentHandler): void {
    this.handlers.push(h)
    this.handlers.sort((a, b) => a.priority - b.priority)
  }

  normalize(raw: unknown): NormalizeResult {
    for (const h of this.handlers) {
      if (h.detect(raw)) {
        const v2 = h.toEditable(raw)
        if (v2) {
          return { document: v2, handler: h }
        }
        return { document: null, handler: h, error: `无法将 ${h.formatName} 转为可编辑格式` }
      }
    }
    return { document: null, handler: null, error: '未知文档格式' }
  }
}

export const formatDispatcher = new DocumentFormatDispatcher()
