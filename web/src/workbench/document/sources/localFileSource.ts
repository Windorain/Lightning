import type { DocumentLoadResult, DocumentSaveResult, DocumentSource } from '../types'

export const localFileSource: DocumentSource = {
  id: 'local-file',
  label: '本地文件',

  poll() {
    return true
  },

  async load(_ctx, props): Promise<DocumentLoadResult> {
    const file = props.file as File
    if (!file) throw new Error('未选择文件')
    const text = await file.text()
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (e) {
      throw new Error(`JSON 解析失败：${e}`)
    }
    return { raw, locator: file.name, displayName: file.name }
  },

  async save(_ctx, _props): Promise<DocumentSaveResult> {
    throw new Error('本地文件保存请使用 OPERATOR_SAVE_FILE')
  },
}
