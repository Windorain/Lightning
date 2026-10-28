/** 单页 edit 安全上限（字节），低于 Wiki 2048 KiB */
export const PAGE_LIMIT_BYTES = 1900 * 1024
/** 浏览器侧允许选择的整文件上限 */
export const MAX_UPLOAD_FILE_BYTES = 10 * 1024 * 1024
/** 分片正文页数量上限（不含索引页） */
export const MAX_PART_COUNT = 6
export const MULTIPART = 'Envelope/multipart'
export const PART = 'Envelope/part'
