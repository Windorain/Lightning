import { shallowRef, type ShallowRef } from 'vue'
import type { DocumentBinding, DocumentSourceId } from './types'

export function createEmptyBinding(): DocumentBinding {
  return {
    sourceId: 'empty',
    locator: '',
    remoteRevisionId: null,
    saveBaseline: null,
  }
}

export function createDocumentBindingRef(): ShallowRef<DocumentBinding> {
  return shallowRef(createEmptyBinding())
}

export function applyDocumentBinding(
  ref: ShallowRef<DocumentBinding>,
  patch: Partial<DocumentBinding> & { sourceId: DocumentSourceId; locator: string },
): void {
  ref.value = {
    ...ref.value,
    ...patch,
    remoteRevisionId: patch.remoteRevisionId ?? ref.value.remoteRevisionId,
    saveBaseline: patch.saveBaseline ?? ref.value.saveBaseline,
  }
}
