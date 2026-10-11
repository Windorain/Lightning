/**
 * `jszip/lib/signature` 的类型声明（**仅测试用**）。
 *
 * ## 为什么需要它
 *
 * `adapters/host/__tests__/artifactTransport.test.ts` 里有一条**探针**用例：
 * 改写 JSZip 的签名常量，以**观察**"未补丁产物在受损宿主下产出 `50 4B FD FD`"
 * 这一现象，从而与字节级判据互证。
 *
 * 该模块是 JSZip 的**内部**文件布局（`jszip` 的 `package.json` 未导出它，
 * 也没有随包类型）。故在此显式声明它的形状 —— 这比在测试里写 `any` 好：
 *  - `any` 会让"探针写错了键名"变成静默的 `undefined`（断言可能假通过）；
 *  - 显式声明后，键名拼错是**编译错误**。
 *
 * ## 边界（测试文件的注释里同样写明）
 *
 * 这只是**探针结论**的依据，**不是**正式判据。正式判据走字节级口径
 * （`charCodeAt(i) & 0xFF`，与 JSZip `utils.js` 的 `stringToArrayLike` 同构），
 * 不依赖本文件的内部路径。若 JSZip 升级导致该路径变化，**修的是探针**，
 * 不是放松字节级判据。
 *
 * 与 `omggif.d.ts` 同一手法：为无类型的第三方模块补齐最小声明。
 */
declare module 'jszip/lib/signature' {
  /** 6 个 ZIP 签名字符串常量（JSZip `signature.js` 的导出）。 */
  const signature: {
    LOCAL_FILE_HEADER: string
    CENTRAL_FILE_HEADER: string
    CENTRAL_DIRECTORY_END: string
    ZIP64_CENTRAL_DIRECTORY_LOCATOR: string
    ZIP64_CENTRAL_DIRECTORY_END: string
    DATA_DESCRIPTOR: string
  }
  export = signature
}
