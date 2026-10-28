# `test/criteria/` —— 端到端断言集

本目录存放与用例正交的端到端断言集：判的是设施自身的行为（重放前置、读面只读性、权限门、证据齐全、幂等、负对照精度），不是某一份用例的场景内容。

## 1. 权威与形态

判据集是驱动断言的**声明式镜像**，不是独立的可执行判据。求值由驱动脚本承担：`scripts/control-plane/run-smoke.ps1`、`run-shots.ps1`、`run-read-surface.ps1`、`run-anchor.ps1`，以及纯判定模块 `scripts/control-plane/anchor-checks.ps1`。由此：

- 本目录**没有判据求值器，也没有独立的重放入口**；判据集自身不能单独运行出结论。
- 两边不一致时以驱动为准，本目录当场向驱动对齐。
- 用例不得引用判据集：`criteria` 段没有 `include` / `ref` / `extends`，一份判据的判定逻辑只有一个定义点。

## 2. 结构与清单

```jsonc
{
  "schema": "lightning.cp-criteria-set/1",
  "id": "preflight",              // 等于文件名
  "kind": "preflight",
  "title": "重放前置：服务发现、契约版本、token、动作自描述存在性",
  "requiresCase": null,           // 绑定用例 id；null = 不绑定（判设施能不能跑）
  "inputContract": {
    "reads": ["<mcDataDir>/controlplane/server.json -> port/bind/contractVersion"],
    "produces": "机读断言表（本文件 id 逐条）+ 人读表",
    "order": "严格按 assertions[] 顺序"
  },
  "assertions": [
    { "id": "...", "target": "...", "expr": "...", "expect": "...", "failSemantics": "...", "source": "..." }
  ],
  "falsification": { "kind": "synthetic-fixture", "how": "改坏方式", "record": "登记位置" }
}
```

每条断言的六个字段都必填：

- `target` / `expr` / `expect`：断言对象、判定表达式与期望值。
- `failSemantics`：区分断言失败（判据不满足）与设施错误（连判据都无法求值）。两类根因混在一起会让自动化无法自诊断。
- `source`：抽取母本（哪份驱动的哪条断言），用于复核语义未改。

| 判据集 | 判什么 | `requiresCase` |
|---|---|---|
| `assertions/preflight.json` | 端口发现、契约版本、三级 token、动作自描述与所需动作齐备 | `null` |
| `assertions/readonly.json` | 读面调用前后世界清单哈希不变；读面无写接口调用点；读面产物在场 | `read-surface` |
| `assertions/permissions.json` | confirm 门、observe 级 token 的写拒绝、`cameras` 段升格、捕获会话门控 | `smoke-shots` |
| `assertions/evidence-completeness.json` | `evidence.overall=green` 且 `expect` 逐条在场、清单与磁盘 sha256 一致 | `lp-pipe-row` |
| `assertions/idempotence.json` | 同参两次重建的场景哈希相等、世界清单逐字节一致、A3 产物结构一致 | `lp-pipe-row` |
| `assertions/variant-precision.json` | `expectCriteriaRed` 全部判为失败且其余判据全部通过；补丁非空转 | `lp-pipe-row` |
| `criteria-types.json` | 判据类型自描述的快照（三方对账的一侧） | —— |

`requiresCase` 非空的判据集通过所绑定用例获得 hermetic 世界保证；判据集本身不新建世界。

## 3. 负对照

每个判据集的 `falsification` 段写明把断言改为失败的方式（合成夹具形态）。改法只允许作用于判据集声明的对象，不得放宽已有断言。由于求值在驱动侧，本目录不保存执行结论；可离线复核的证伪只有两处，均为可重复执行的命令：

```powershell
# 判据类型对账：无漂移退出码 0；有漂移逐条指名并退出码 2
node test/criteria/check-criteria-types.mjs --check test/criteria/criteria-types.json

# A3 比对器自检（幂等断言消费同一个比对器）
node test/expected/compare-runs.mjs --selftest
```

## 4. 判据类型对账

`criteria-types.json` 是判据类型自描述的导出快照。唯一权威是 `case.validate` 的 `result.criteriaTypes`（数据源 `CriteriaEngine.typeCatalog()`）；契约文档 `docs/control-plane/case-file.md` §5 / §5.1 的两张表向它对齐。快照当前含 9 条类型，逐条给出 `type` / `since` / `params`。

| 命令 | 作用 | 退出码 |
|---|---|---|
| `node test/criteria/check-criteria-types.mjs --print` | 从实机端点取快照并打印（需客户端在跑） | 同下 |
| `node test/criteria/check-criteria-types.mjs --check test/criteria/criteria-types.json` | 快照与契约文档离线对账 | 0 一致 / 2 有漂移 / 3 设施错误 |
| `node test/criteria/check-criteria-types.mjs --check test/criteria/criteria-types.json --live` | 追加实机端点，三方对账 | 同上 |

刷新快照用 `--print` 重定向覆盖本文件；`params` 列必须与自描述端点逐字一致。

## 5. 边界

- `requiresCase: null` 的判据集（`preflight`）判「设施能不能跑」，因此不绑定用例；其期望产物由 `assertions[]` 的逐条 `expect` 承担。
- 需要世界的断言只能经 `requiresCase` 间接获得 hermetic 保证。
- 本目录不改驱动：抽取是声明式镜像，驱动侧改造不在本目录范围内。

## 6. 比对与豁免的落点

产物比对的口径与豁免字段表只有一处定义：[docs/control-plane/case-file.md §10](../../docs/control-plane/case-file.md)，其可执行形态是 `test/expected/compare-runs.mjs`（豁免表与文档同源，新增豁免必须同时改两侧）。判据集的幂等断言消费同一比对器，因此比对器的证伪记录即本目录 §3 的第二条命令；基准清单与 A3 记录见 [test/expected/](../expected/README.md)。
