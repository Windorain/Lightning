# `test/expected/parts-acceptance/` —— 部件导出 oracle

三档部件验收 oracle 的仓内副本：按 [docs/contracts/format-parts-contract.md](../../../docs/contracts/format-parts-contract.md) 的规则、用 Minecraft 原语独立复算出的逐格期望值，不是当前实现输出的同源副本。

## 文件

| 文件 | 档位 | 内容 |
|---|---|---|
| `sde_parts_acceptance_oracle_full.json` | full | 三族部件（AE2 / EnderIO / FMP）全档可用时的逐格期望结果 |
| `sde_parts_acceptance_oracle_degraded_ae2.json` | degraded_ae2 | AE2 通道降级时的逐格期望结果 |
| `sde_parts_acceptance_oracle_degraded_all.json` | degraded_all | 三族全降级时的逐格期望结果 |

## 校验值

| 文件 | 字节 | sha256 |
|---|---|---|
| `sde_parts_acceptance_oracle_full.json` | 51489 | `8dbe1ec1b99cc1a01ecbea1b2204d0caee81e249e3aca7369192e40deaf3fa3b` |
| `sde_parts_acceptance_oracle_degraded_ae2.json` | 43930 | `5e0ba22343b700b15505c5d5edb11db42540c96e327c3bad29277b570edb7bc3` |
| `sde_parts_acceptance_oracle_degraded_all.json` | 34508 | `4c603b2abfd80b39943e25b5e6bf5a501827d4c78e1c89bf7679e3e69853cb70` |

复核方式：对三份文件重算 sha256 并与上表比对（`Get-FileHash -Algorithm SHA256`）。

## 与 `expected/<caseId>/` 的差别

本目录不是用例基准集：没有 `manifest.json`，也没有 `{caseId, caseSha256}` 引用，因此 `TestAssetLibraryTest` 的基准门禁不覆盖它。它的期望值来自部件契约的独立复算，用途是作为浏览器侧验收的受控 oracle。

## 解析顺序与消费方

oracle 的读取实现是 `web/e2e/helpers/parts/oraclePath.ts`，顺序固定：

1. 仓内 canonical 路径（本目录，三份文件直属于该目录）；
2. 归档副本：`PARTS_ACCEPTANCE_DIR` 指向的目录里的同名文件；
3. 两者皆缺即抛错（显式失败，不静默跳过）。

消费方：

- `web/e2e/parts-real-export.spec.ts`：经 `loadOracle` 读 `full` 与 `degradedAll`，断言解析级逐格结果、统计行集（`expectedCounts`）、`itemIndex` 逐键与 `blockPalette[].hostItem` 逐条。
- `web/e2e/parts-real-export-evidence.spec.ts`：直接读本目录的 `full` 作为受控 oracle，断言 FMP 行键与归属（`itemIndex[].attribution`）与描边 / 点选通道。
- 离线复核解析顺序本身：`cd web && npm run test:e2e:unit`（`tests/e2e/partsOraclePath.test.ts` 钉住三个分支）。

两个消费方都需要真实产物归档。仓内没有 `scripts/parts-acceptance/.out/`，因此通常必须用 `PARTS_ACCEPTANCE_DIR` 指向既有归档；未设置时解析器会尝试该缺省根下最近的目录，但该根不存在，实际等价于缺件失败。归档缺失时这两份 spec 由 `web/e2e/real-artifact-gate.ts` 从本次收集排除，并在 `web/test-results/e2e-exclusions.json` 登记。

## 当前限制

仓内没有部件验收导出的产出端：不存在产出 `sde_parts_acceptance_export_*.json` 的编排脚本，控制面也没有部件导出动作；`te` 步的补全器不覆盖 EnderIO 与 FMP 两族。因此本目录的三份 oracle 只作为只读期望基准，无法在仓内重新生成同形产物。
