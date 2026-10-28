/**
 * 浏览器专用下载/剪贴板工具。仅在浏览器环境可用。
 */

/**
 * **谁写文件**：尾换行口径。
 *
 * ## 问题
 *
 * > 尾换行口径：`util/browser.ts:6` 的 `downloadJson` 补 `\n`，mod 侧不补
 * > ⇒「Plain 逐字节」在两个写出路径上口径不同，**必须先明确"谁写文件"**。
 *
 * ## 判定：两条路径**各自正确**，因为它们写的是不同的东西
 *
 * | 写出路径 | 谁写 | 尾换行 | 为什么 |
 * |---|---|---|---|
 * | **命令通道产物** | mod 侧 `ExportSceneWriter.serialize(raw=true)` | **无** | 逐字节判据的对象是**命令通道产物**；mod 侧是权威写出方，浏览器不能改写它的字节 |
 * | **浏览器下载** | 本文件的 `downloadJson` | **有** | 它是**人类下载**（另存为 .json 后用编辑器打开）：无尾换行会让 POSIX 工具把"无换行结尾"当异常，且 diff 会显示 `\ No newline at end of file` |
 *
 * 两者**不冲突**：判据只约束命令通道产物（`PLAIN_SERIALIZATION.trailingNewline: false`
 * 是那条路径的常量，见 `adapters/files/plainCodec`）。浏览器下载**不是**那条路径，
 * 它的产物**不参与**逐字节对账。
 *
 * ## 为什么这个区分必须**显式**（而不是"各写各的，看起来也没错"）
 *
 * 因为它此前是**隐含**的：两条路径都产出 `.json`，谁也没写"我这条要不要尾换行、
 * 为什么"。于是任何一方改动（例如为了过某个 lint 去掉 `\n`）都会**静默**改变
 * 一条路径的字节口径，而没人知道它是否属于逐字节判据面。
 * ⇒ 本常量把"浏览器下载写尾换行"变成**声明**，并由测试钉住
 * （见 `util/__tests__/downloadJsonNewline.test.ts`）。
 */
export const BROWSER_DOWNLOAD_TRAILING_NEWLINE = true

export function downloadJson(baseName: string, obj: unknown, pretty?: boolean): void {
  const body = pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj)
  // 见 `BROWSER_DOWNLOAD_TRAILING_NEWLINE`：浏览器下载路径**写**尾换行。
  const text = BROWSER_DOWNLOAD_TRAILING_NEWLINE ? `${body}\n` : body
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

/** 事件目标是否为可编辑元素（input/textarea/contenteditable） */
export function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target.isContentEditable
}

/**
 * Download a data URL as a PNG file.
 * Converts the data URL to a Blob and delegates to downloadBlob.
 */
export function downloadPng(dataUrl: string, filename: string): void {
  const name = filename.endsWith('.png') ? filename : `${filename}.png`
  downloadBlob(name, dataUrlToBlob(dataUrl))
}

function dataUrlToBlob(dataUrl: string): Blob {
  const parts = dataUrl.split(',')
  const mimeMatch = parts[0]?.match(/:(.*?);/)
  const mime = mimeMatch?.[1] ?? 'image/png'
  const raw = atob(parts[1] ?? '')
  const len = raw.length
  const buf = new ArrayBuffer(len)
  const view = new Uint8Array(buf)
  for (let i = 0; i < len; i++) view[i] = raw.charCodeAt(i)
  return new Blob([buf], { type: mime })
}

/** File System Access API 的 showSaveFilePicker（仅在安全上下文可用） */
export function getShowSaveFilePicker():
  | ((options: SaveFilePickerOptions) => Promise<FileSystemFileHandle>)
  | undefined {
  if (typeof window === 'undefined' || !window.isSecureContext) return undefined
  const w = window as Window & { showSaveFilePicker?: (o: SaveFilePickerOptions) => Promise<FileSystemFileHandle> }
  return typeof w.showSaveFilePicker === 'function' ? w.showSaveFilePicker : undefined
}
