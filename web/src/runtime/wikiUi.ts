import { ref, type Ref } from 'vue'

export type WikiModalKind =
  | 'picker'
  | 'save-confirm'
  | 'save-as'
  | 'save-preview'
  | null

export interface WikiSaveConfirmState {
  defaultSummary: string
  planPartCount: number
  planMode: 'single' | 'multipart'
}

export interface WikiUiState {
  modal: Ref<WikiModalKind>
  saveConfirm: Ref<WikiSaveConfirmState | null>
  savePreviewMessage: Ref<string | null>
  conflictMessage: Ref<string | null>
  /** mw 登录可用（驱动菜单栏 Wiki 文件项刷新） */
  mwReady: Ref<boolean>
}

export function createWikiUiState(): WikiUiState {
  return {
    modal: ref<WikiModalKind>(null),
    saveConfirm: ref<WikiSaveConfirmState | null>(null),
    savePreviewMessage: ref<string | null>(null),
    conflictMessage: ref<string | null>(null),
    mwReady: ref(false),
  }
}
