# `test/expected/` —— run 产物基准与比对器

本目录存放 run 产物的期望基准，以及执行比对的唯一脚本 `compare-runs.mjs`。比较模式、豁免字段与比较对象的成文口径在 [docs/control-plane/case-file.md §10](../../docs/control-plane/case-file.md)（下文简称 §10），本目录只消费该口径，不另立定义。

## 目录与命名

- 基准目录名逐字等于被引用用例的 `id`（`expected/read-surface/` ↔ `cases/read-surface/read-surface.json`）。
- 固定两级：`<caseId>/` / 基准文件，文件名 kebab-case。
- 例外：`parts-acceptance/` 不是用例基准集（无 `manifest.json`、无 `caseSha256`），见 [parts-acceptance/README.md](parts-acceptance/README.md)。

## 基准引用用例的登记口径

`manifest.json` 与 A3 比对记录都登记 `{caseId, caseSha256}`。`caseSha256` 的唯一实现是 `Hashing#sha256HexUtf8Lf`：用例文本按 UTF-8 解码、把 CRLF 归一为 LF 后取 sha256，结果为 64 位小写十六进制。归并在哈希之前完成，因此在 LF 与 CRLF 检出上得到同一个值；登记值不得取检出平台的原始字节。运行期 `CaseParser` 使用同一实现，`TestAssetLibraryTest#registeredCaseSha256MatchesCanonicalCaseText` 逐份重算并比对登记值——用例一改，基准立即失效。

## 清单

| 文件 | 内容 | 规模 |
|---|---|---|
| `read-surface/manifest.json` | `read-surface` 的逐产物基准：比较模式 + `expect` 子集 + 生成条件 | 20 个产物 |
| `read-surface/a3-two-runs.json` | 同一用例两次 run 的 A3 比对记录（两侧结论 + 比对器退出码） | 20 产物对 |
| `l1-orchestration/manifest.json` | `l1-orchestration` 的逐产物基准 | 22 个产物 |
| `l1-orchestration/a3-two-runs.json` | 同一用例两次 run 的 A3 比对记录 | 22 产物对 |
| `cp-smoke-basic/a3-two-runs.json` | `cp-smoke-basic` 两次 run 的 A3 比对记录（该用例判据较少，不建 `manifest.json`：基准会是空壳） | —— |
| `parts-acceptance/*.json` | 部件导出的三档 oracle（独立期望基准，非用例基准集） | 3 份 |

`manifest.json` 的 `generatedFrom` 记录生成条件（`world` 段、契约/mod/MC/Forge 版本）；带时间戳的 run 目录名不作为基准内容。

## 比对器用法

```powershell
# 两次 run 互比（A3 的标准形态：比两侧文件）
node test/expected/compare-runs.mjs --a <runDirA> --b <runDirB> [--json-out a3.json] [--quiet]

# 单 run 对基准（只核基准声明的产物与 expect 子集）
node test/expected/compare-runs.mjs --run <runDir> --baseline test/expected/read-surface/manifest.json

# 自检：确认正例判一致、篡改输入判差异
node test/expected/compare-runs.mjs --selftest
```

退出码：`0` = 全一致 / `2` = 有差异（逐产物指名）/ `3` = 设施错误（参数错误、目录或基准不存在、基准不是合法 JSON）。

基准文件按 `artifacts[]` 逐条声明 `path`、`mode` 与可选的 `expect`：

- `mode` 必须是 §10.1 的四种模式之一；未声明的产物按默认表取模式。
- `expect` 是 RFC 6901 指针到期望值的子集断言（可写 `/counts/green` 或简写 `counts/green`）。
- 未写 `expect` 的产物只核「在场且是合法 JSON」；`artifacts[]` 为空的基准直接判为失败（空基准对任何输入都通过，不构成断言）。
- 单 run 模式下 `byte-equal` 不可用（基准侧没有第二份字节），声明它会判为失败；字节比对用两次 run 互比。

## 边界

- 基准是提炼后的声明式清单，不是 run 目录的副本；run 目录含 `runId` / 时间戳 / 耗时，且体量随产物增长。
- 图像类产物只按 `presence-only` 参与比对；尺寸与像素特征由判据（`image-size-equals` / `image-not-uniform` / `image-uniform`）承担。
- 比较模式要与资产性质匹配：`world/scene-manifest.json` 的哈希只覆盖 `blocks` 与 `tileEntities`（口径见 `case-file.md` §8），机器运行期状态不由该哈希回答，需由 `te-state-equals` 或 `read/*.json` 判据承担。
- 新增豁免字段必须同时改 §10.2 与 `compare-runs.mjs` 的豁免表；只改一侧会让豁免失去出处。
