# OBJ 导出 ZIP 损坏修复 & 异步错误吞噬修复

## 问题

Lightning Wiki 工作台导出 OBJ（连通模式）时出现两个现象：
1. **"无反应"**：点击导出按钮后看到"已导出"提示，但无文件下载
2. **ZIP 损坏**：下载下来的 ZIP 文件头为 `50 4B FD FD`（合法为 `50 4B 03 04`），Python zipfile 报 BadZipFile

## 根因

### 根因 1："无反应" —— 异步 Promise 未 await

**文件**: `web/src/workbench/components/ExportWorkspace.vue`

`downloadObjBlock/downloadObjConnected/downloadObjLayered/downloadIso` 四个函数调用 `ctx.getOperators().exec()` 但未 `await`。`exec()` 返回 Promise，内部异步链（纹理解码→atlas渲染→JSZip生成→Blob下载）中任何异常都被静默吞噬。`msg('已导出...')` 在异步完成前触发。

**修复**: 改为 `async function`，`await` 完成后才 `msg`，`catch` 可正确捕获异常。

### 根因 2：ZIP 损坏 —— MediaWiki 替换控制字符

**完整证据链**：

1. JSZip 的 `signature.js` 将 ZIP 结构签名定义为 literal 字符串：`LOCAL_FILE_HEADER = "PK\x03\x04"` 等 6 个常量
2. esbuild minifier 将 `\x03\x04` 折叠为 literal 字节 `03 04`
3. `wiki.py` 通过 `urlencode` 将 `\x03`→`%03`、`\x04`→`%04` 正确上传
4. **MediaWiki 存储时将 C0 控制字符（0x01–0x08、0x0B–0x1F，TAB/LF 除外）替换为 U+FFFD**
5. `action=raw` 以 UTF-8 返回 `PK\xEF\xBF\xBD\xEF\xBF\xBD`（U+FFFD ×2）
6. 浏览器解析 JS 得到 `PK\uFFFD\uFFFD`
7. JSZip 的 `stringToArrayLike` 通过 `charCodeAt(i) & 0xFF` 从 U+FFFD(0xFFFD) 提取低字节 `0xFD`
8. 产物 blob 字节 2-3 变为 `FD FD`

**验证方法**：在 Wiki 写入 `User:ChengMing/test-bytes` 含全部 C0 控制字符，拉回后逐字节对比，确认 0x01–0x08 全部变为 U+FFFD。

### 根因 3：首次推送失败 —— 嵌套引号语法错误

第一版修复将 `"PK\x03\x04"` 替换为 `atob("UEsDBA==")`，但双引号与外层 JS 字符串冲突：
```
r.LOCAL_FILE_HEADER="atob("UEsDBA==")"  ← 第二个 " 提前闭合
```
导致 JS 语法错误，Vue 无法挂载。修复为单引号 `atob('UEsDBA==')`，无外层引号。

## 修复

### 1. ExportWorkspace.vue（异步错误吞噬）

```diff
-function downloadObjConnected(): void {
+async function downloadObjConnected(): Promise<void> {
   try {
-    ctx.getOperators().exec('OPERATOR_EXPORT_OBJ', { connected: true })
+    await ctx.getOperators().exec('OPERATOR_EXPORT_OBJ', { connected: true })
     msg('已导出 OBJ (connected)')
   } catch (e) { msg(formatUnknownError(e)) }
 }
```

### 2. vite.wiki-workbench.config.ts（控制字符替换）

新增 `fixJszipSignaturesForWiki` Vite 插件，在 `closeBundle` 阶段扫描产物，将 6 个 JSZip 签名常量中的 literal 控制字符替换为 `atob('...')` 调用：

| 签名 | 搜索（含引号） | 替换 |
|------|---------------|------|
| LOCAL_FILE_HEADER | `"PK\x03\x04"` | `atob('UEsDBA==')` |
| CENTRAL_FILE_HEADER | `"PK\x01\x02"` | `atob('UEsBAg==')` |
| CENTRAL_DIRECTORY_END | `"PK\x05\x06"` | `atob('UEsFBg==')` |
| ZIP64_LOCATOR | `"PK\x06\x07"` | `atob('UEsGBw==')` |
| ZIP64_END | `"PK\x06\x06"` | `atob('UEsGBg==')` |
| DATA_DESCRIPTOR | `"PK\x07\b"` | `atob('UEsHCA==')` |

### 3. exportOperators.ts（运行时插桩）

在 `ExportObjOperator.exec()` 中 `downloadBlob` 前验证 blob 前 4 字节，异常时 `ctx.log.warn`。

## 经验总结

### 排查方法

1. **控制变量实验 > 推测**：在确认 MediaWiki 替换控制字符时，直接推了一条含所有 C0 控制字符的测试页（`User:ChengMing/test-bytes`），拉回后逐字节比对。铁证如山，无需猜测。
2. **全链路复现 > 局部测试**：Node.js 单元测试中 ZIP 一直正确，直到 Playwright 真实浏览器测试 + 真实 Wiki 推送后才复现问题。环境差异是关键。
3. **逐层排除**：先确认构建产物正确（本地字节检查），再确认推送正确（urlencode 验证），再确认 pull 结果异常（Wiki 存储已损坏），最后用测试页确认替换规律。
4. **esbuild 常量折叠是双刃剑**：源码用 `atob()` 构造签名 → esbuild 优化回 literal → 插件再次替换。需要理解构建管道每层的变换才能写出正确的后处理逻辑。
5. **嵌套引号陷阱**：替换字符串字面量时，必须同时处理外层引号，否则产生语法错误。`split/join` 操作中的搜索模式必须包含完整的外层定界符。

### 测试资产

- `web/e2e/obj-export.spec.ts`：Playwright E2E，真实浏览器 full pipeline（blob capture + UI click download）
- `web/src/workbench/export/__tests__/objExport.test.ts`：Vitest 单元测试，覆盖序列化、体素标记、几何采集、ZIP 组装

### 维护注意事项

- 若升级 esbuild，需验证 `fixJszipSignaturesForWiki` 插件的搜索模式是否仍匹配（minifier 行为可能变化）
- 若 JSZip 升级导致签名常量增减，需同步更新插件中的 sigMap
- Wiki 推送必须遵守 `gtnh-structure-render-push` Skill 的规则：构建→暂存→bundle→css→js 顺序推送
