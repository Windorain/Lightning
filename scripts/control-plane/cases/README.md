# `scripts/control-plane/cases/`

本目录存放随驱动一起使用的运行期专用用例。可重放用例资产的入库位是仓库根的 [test/cases/](../../../test/cases/README.md)；本目录的文件不作为资产库索引的一部分，也不复制资产库文件。

| 文件 | 用例 id | 内容 | 消费方 |
|---|---|---|---|
| `capture-diag.json` | `capture-diag` | 捕获通道诊断：TESR 管格与箱格，2 条判据 | 无驱动缺省值；经 `caller.mjs` 调 `case.run` 执行 |
| `export-c4.json` | `cp-export-c4` | 导出件 + 实拍 + 观测记录 + 世界清单哈希同一 run：5 条判据、9 个 export 步、1 个 read 步、1 个机位 | `export-acceptance.mjs`（C4，以 `inline` 读入并指定 `segments`） |
| `gg-antimatter-casing.json` | `gg-antimatter-casing` | GoodGenerator 反物质约束外壳的 CTM 连通/孤立形态与同 mod 对照：8 个 build 步、6 个机位、14 条判据、1 个负对照变体 | 无驱动缺省值；经 `caller.mjs` 调 `case.run` 执行（含 `cameras` 段，需 `forensic` 级） |
| `gt-machine-live.json` | `gt-machine-live` | LV 化学反应釜经 `gt-machine` 补全器权威放置：2 个 build 步、8 条判据、1 个负对照变体（`setBlock` 直铺空壳必须失败） | 无驱动缺省值；经 `caller.mjs` 调 `case.run` 执行 |
| `input-multitick.json` | `input-multitick` | 输入手段族跨帧固定程序：5 个 `action` 步（含 `holdTicks`）、5 条判据 | `run-input-acceptance.ps1` 的 `g1` 段（`-CaseFile` 缺省值）与 `input-acceptance-checks.ps1` 的 G1 判定 |
| `tank-fill-live.json` | `tank-fill-live` | `scene.tank.fill` 注入 HCl 3000 mB 到 LV 化学反应釜并 `read.te` 读回：2 个 build 步、1 个 read 步、8 条判据、1 个负对照变体 | 无驱动缺省值；配方级联证经 `caller.mjs` 调 `case.run` 整跑并由 `read.te` 采样承担 |

用例文件的格式、段序、判据类型与变体语义见 [case-file.md](../../../docs/control-plane/case-file.md)。
