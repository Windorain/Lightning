# `test/expected/parts-acceptance/` —— 部件导出 oracle 基准（#104 / V9 / V10 迁入）

## 这是什么

老部件验收器具（`PartsAcceptanceOracle`，游戏内生成）产出的**逐格期望基准**的 tracked 副本。
#104（收口T7：老设施整体删除）删除了 `PartsAcceptanceAutomation` / `PartsAcceptanceBuilder` /
`PartsAcceptanceOracle` / `PartsAcceptanceVerifier` 与 `scripts/parts-acceptance/` 编排层，
但这些基准**本身是与实现无关的期望值**（按 `docs/contracts/format-parts-contract.md` 原文规则
用 MC 原语独立复算出来的「应该是什么」），因此在删除前按 V9 裁决**迁入本目录**，
而不是随器具一起消失。

- 迁移前路径：`scripts/parts-acceptance/oracle/*.json`（#104 已删除该路径）
- 迁移方式：逐字节复制，未改写内容（sha256 与迁移前一致，见下表）
- 迁移时点：Gitea #104 执行轮（分支 `feat/cp-retire`，基线 `integration/cp-consolidation@a788c81`）

## 文件

| 文件 | 档位 | 含义 |
|---|---|---|
| `sde_parts_acceptance_oracle_full.json` | full | 三族部件（AE2 / EnderIO / FMP）全档可用的期望逐格结果 |
| `sde_parts_acceptance_oracle_degraded_ae2.json` | degraded_ae2 | AE2 通道降级时的期望逐格结果 |
| `sde_parts_acceptance_oracle_degraded_all.json` | degraded_all | 三族全降级的期望逐格结果 |

## 迁移校验（sha256，迁移前 = 迁移后）

| 文件 | 字节 | sha256 |
|---|---|---|
| `sde_parts_acceptance_oracle_full.json` | 51489 | `8dbe1ec1b99cc1a01ecbea1b2204d0caee81e249e3aca7369192e40deaf3fa3b` |
| `sde_parts_acceptance_oracle_degraded_ae2.json` | 43930 | `5e0ba22343b700b15505c5d5edb11db42540c96e327c3bad29277b570edb7bc3` |
| `sde_parts_acceptance_oracle_degraded_all.json` | 34508 | `4c603b2abfd80b39943e25b5e6bf5a501827d4c78e1c89bf7679e3e69853cb70` |

## 与 `expected/` 既有约定的关系（**读之前先看这条**）

本目录**不是** `test/expected/<caseId>/` 那种「用例基准集」：它没有 `manifest.json`，
也没有 `{caseId, caseSha256}` 引用，因为它的原用例（`PartsAcceptanceAutomation` 的八分区建造场景）
**已随 #104 删除**，在控制面侧尚无等价用例。

因此：

- `TestAssetLibraryTest` 的门禁（四类目录齐备 / 每类 README / `cases/` 三件套）**不覆盖本目录**，
  它只对本目录的存在与否无要求；本目录不会让门禁红；
- 这些基准是**已迁入但暂无可执行消费方**的资产（V10 的「迁不进去的判据不得静默丢」：
  基准保住了，等价核对用例待跟进单承载）。

## 已知缺口（必须与基准一起读）

V10 裁决要求「以 `case.run` 的 build/read/export + `json-field`/`te-state-equals` 判据表达等价核对」。
本次执行只完成了**基准迁入**；等价用例尚未编写，原因：

1. 控制面侧**没有部件导出动作**（`case.run` 的 `export` 段目前只认 `export.scene` / `export.registry` /
   `export.multiblock`），无法产出与 oracle 同形的 `sde_parts_acceptance_export_*.json`；
2. `te` 步的补全器只覆盖 `vanilla` / `lp-pipe` / `ae2-part` / `gt-machine`，EnderIO / FMP 两族
   在控制面**不可构建**（V13，已归 #116）。

⇒ 已登记为**跟进单建议**（见 #104 执行报告「已知缺口与新单建议」节），不要在本目录里补造用例：
在补全器到位之前写出来的用例只会是空转绿。
