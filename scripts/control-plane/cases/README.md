# `scripts/control-plane/cases/` —— 已迁出（指针）

> **本目录的用例已迁入 `test/cases/`（仓库根的资产库），这里是历史位置，只留指针。**

## 为什么留着

本目录是四份驱动脚本（`run-smoke.ps1` / `run-shots.ps1` / `run-anchor.ps1` / `run-read-surface.ps1`）
的**默认用例路径**——它们用 `Join-Path $scriptDir 'cases\...'` 硬编码到这里
（`run-smoke.ps1:84`、`run-shots.ps1:99`、`run-anchor.ps1:110-111`、`run-read-surface.ps1:30`）。

**#103 裁决 7（与 #104 的共同触点）**：本单只做**断言集抽取与引用**，**不改造驱动行为**——
驱动脚本的改造/删除归 **#104**。因此本目录的 5 份用例**原样保留**，等 #104 把驱动改成指向
`test/cases/` 之后再一并删除。**在那之前两份是同一份内容的副本**，改动任一份都必须同步另一份
（以 `test/cases/` 为准：那是**唯一入库位**，#103 裁决 1）。

## 迁移对照

| 原处（本目录） | 新位（唯一入库位） |
|---|---|
| `smoke-basic.json` | `test/cases/smoke/cp-smoke-basic.json` |
| `smoke-shots.json` | `test/cases/smoke/cp-smoke-shots.json` |
| `read-surface.json` | `test/cases/read-surface/read-surface.json` |
| `lp-pipe-row.json` | `test/cases/anchor/lp-pipe-row.json` |
| `ae2-parts.json` | `test/cases/anchor/ae2-parts.json` |

**注意两处改名**：冒烟族的两份文件名由 `<简名>.json` 改为 `<id>.json`
（`smoke-basic.json` → `cp-smoke-basic.json`），因为资产库的硬要求是
**文件名逐字等于用例 `id`**（`test/cases/README.md §2`），而这两份的 `id` 带 `cp-` 前缀。
`read-surface` / `lp-pipe-row` / `ae2-parts` 三份的 `id` 与文件名本来就一致，故未改名。

## 索引

- 资产总索引：`test/README.md`
- 固定程序索引与入库门槛：`test/cases/README.md`
