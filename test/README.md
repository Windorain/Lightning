# `test/` —— 控制面可重放资产

本目录存放控制面用例、判据集、run 产物基准与教程复现程序骨架。文件形态、命名与入库门槛由 `TestAssetLibraryTest` 在 `gradle test` 中判定：门槛不满足时构建失败，并指向具体文件。

## 目录

| 目录 | 内容 | 索引 |
|---|---|---|
| `cases/` | `lightning.case/1` 用例文件，控制面用例的唯一入库位 | [cases/README.md](cases/README.md) |
| `criteria/` | 与用例正交的端到端断言集（驱动断言的声明式镜像） | [criteria/README.md](criteria/README.md) |
| `expected/` | run 产物基准、A3 比对记录与部件导出 oracle | [expected/README.md](expected/README.md) |
| `tutorials/` | 教程复现程序的骨架与新增约束 | [tutorials/README.md](tutorials/README.md) |

用例格式、判据词汇、变体、证据与 run 目录口径见 [docs/control-plane/case-file.md](../docs/control-plane/case-file.md)。用例的执行入口（调用器、驱动脚本、前置条件与 token）见 [scripts/control-plane/README.md](../scripts/control-plane/README.md)。

## 离线复核

下列命令不需要启动客户端。判定依据是命令输出与退出码。

```powershell
# 资产门槛：目录齐备、每类 README 在位、用例自包含、criteria/evidence/variants 非空、
# 负对照指向真实判据、caseSha256 登记值与用例文本一致
cd mod/gtnh; .\gradlew.bat test --tests "*TestAssetLibraryTest*"

# 判据类型对账：快照与契约文档逐条比对（加 --live 时追加实机端点）
node test/criteria/check-criteria-types.mjs --check test/criteria/criteria-types.json

# A3 比对器自检：覆盖正例与篡改输入两类判定
node test/expected/compare-runs.mjs --selftest
```

`--selftest` 的正例是结构一致的两份 run；篡改输入包括改判据结论、改世界清单与结构、删产物、替换成空文件，以及基准声明的产物集合，均需判为差异。

需要世界与客户端的复核（`case.run` 重放、两次 run 互比）依赖处于运行状态的控制面，见各子目录 README 与 `scripts/control-plane/README.md`。
