/**
 * 浏览器专用下载/剪贴板工具。仅在浏览器环境可用。
 */

export function downloadJson(baseName: string, obj: unknown, pretty?: boolean): void {
  const text = `${pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj)}\n`
  downloadBlob(`${baseName}.json`, new Blob([text], { type: 'application/json' }))
}

export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, 100)
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  document.execCommand('copy')
  document.body.removeChild(ta)
}

type SaveFilePickerOptions = {
  suggestedName?: string
  types?: Array<{ description: string; accept: Record<string, string[]> }>
}

/** File System Access API 的 showSaveFilePicker（仅在安全上下文可用） */
export function getShowSaveFilePicker():
  | ((options: SaveFilePickerOptions) => Promise<FileSystemFileHandle>)
  | undefined {
  if (typeof window === 'undefined' || !window.isSecureContext) return undefined
  const w = window as Window & { showSaveFilePicker?: (o: SaveFilePickerOptions) => Promise<FileSystemFileHandle> }
  return typeof w.showSaveFilePicker === 'function' ? w.showSaveFilePicker : undefined
}
