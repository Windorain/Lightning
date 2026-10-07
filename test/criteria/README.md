# `test/criteria/` —— 判据集

## 1. 用途

存放**与用例正交的端到端断言集**：它们判的是「设施本身对不对」（权限门、只读性、证据齐全、
幂等、负对照精度），而不是某一份用例的场景对不对。这些断言原先内联在四份驱动脚本里、
彼此大量重复（前置断言 P1–P3 在 `run-shots.ps1`/`run-anchor.ps1`/`run-read-surface.ps1` 各写一份）。
本目录把它们**抽取成声明式资产**——语义不改、口径不新造（#103 裁决 7）。

## 2. 命名规范

- 目录名与文件名一律 **kebab-case**；
- 允许**两级**（类别 / 判据集文件）：`assertions/` 放端到端断言集，将来可加 `image/` 等；
- 判据集的 `id` 等于文件名（`preflight.json` → `id: "preflight"`）。

## 3. 入库门槛检查单（逐条可判定）

- [ ] **① 固定请求序列**：判据集**不自建序列**，它声明**适用对象**（`requiresCase`）、
      **输入契约**（读哪些字段/产物路径）与**求值顺序**（`inputContract.order`）
- [ ] **② 固定世界重建参数**：**不适用**——替代物是 `requiresCase` 指向的用例（它在 `test/cases/` 里且 `world.void:true`）
- [ ] **③ 期望产物**：判据集自身就是一份可判定的 JSON，且**必须自带负对照**（见下）
- [ ] 逐条断言带 `id` / `target` / `expr` / `expect` / `failSemantics` 五件
- [ ] **`failSemantics` 必须区分「判红」与「设施错误」**：结论红（判据不满足）与设施坏
      （连判据都求不了值）是两类根因，混在一起会让自动化无法自诊断
- [ ] 每条断言有 `source`（指向它从哪份驱动的哪条断言抽取而来，便于复核「语义未改」）
- [ ] `falsification` 段写明**怎么把它改红**，并指向本文档 §6 的负对照记录

## 4. 复用机制（v1，**不做 include**）

**裁决（#103 G6）**：`criteria` 段**不做** `include`/`ref`/`extends` 机制。理由是「判据的判定逻辑
必须有唯一定义点」——允许用例引用外部判据集，就会让「这条判据到底怎么算的」分散到两个文件里，
而漂移一旦发生，判据会静默变成另一个东西。

因此 v1 的复用形态是**驱动侧消费的断言表**：

```
用例（cases/）           只管自己的判据（内联 criteria 段）
判据集（criteria/）      声明 requiresCase + 输入契约 + 逐条断言（驱动消费）
驱动脚本（scripts/）      读判据集 → 逐条求值 → 出断言表
```

**本单只做抽取与引用，不改造驱动行为**（#103 裁决 7）：`scripts/control-plane/*.ps1` 的改造/删除归 #104。
在 #104 完成之前，驱动脚本里的断言**仍是权威实现**，本目录是它们的**声明式镜像**——
两边不一致时，以驱动为准并当场改本目录（抽取的原则是「语义不改」，不是「另立一套」）。

## 5. 本类资产清单

| 资产 | 判什么 | 来源（抽取母本） | 负对照形态 |
|---|---|---|---|
| `assertions/preflight.json` | 端口发现 / 契约版本 / token / 动作自描述存在性 | `run-read-surface.ps1` P1–P3；`run-smoke.ps1` P1–P3；`run-shots.ps1` P1–P3；`run-anchor.ps1` P1–P3 | 改坏 `server.json`/`tokens.json` |
| `assertions/readonly.json` | 读面调用前后世界清单哈希不变（#96 §10 B1） | `run-read-surface.ps1` B1.0/B1.x/B1.99 | 两次取哈希之间写一格 |
| `assertions/permissions.json` | confirm 门 / 捕获会话门控 / 按内容升格 | `run-smoke.ps1` A9；`run-shots.ps1` B4/B5 | 换 token 级 / 去掉 confirm |
| `assertions/evidence-completeness.json` | `evidence.overall=green` 且 `expect` 逐条在场 | `anchor-checks.ps1::Test-EvidenceComplete`；`read.run` 的磁盘一致性 | 删一个 expect 声明的产物 |
| `assertions/idempotence.json` | 同参两次重建哈希相等 + A3 产物结构一致 | `anchor-checks.ps1::Test-IdempotentManifest`；`run-anchor.ps1` C5 | 改第二次 run 的清单 |
| `assertions/variant-precision.json` | `expectCriteriaRed` 全红且其余保持绿 | `anchor-checks.ps1::Test-VariantPrecision`；`run-shots.ps1` B3d | 把 expectCriteriaRed 换成不受影响的判据 |
| `criteria-types.json` | 判据类型自描述的导出快照（三方对账第三方） | `case.validate` 的 `criteriaTypes` | 改一个 `since` ⇒ `check-criteria-types.mjs` 报漂移 |

## 6. 负对照记录（判据集不恒绿）

**判据集专有的第三件是「负对照」**：只证明该绿是不够的（恒绿是最常见的失效模式）。
每条断言集的 `falsification` 段写明改法，本节记录**已执行过**的证伪。

### 6.1 `criteria-types.json` 的三方对账（**已执行，本单内**）

| 项 | 值 |
|---|---|
| 命令 | `node test/criteria/check-criteria-types.mjs --check test/criteria/criteria-types.json` |
| 好数据 | `[GREEN] 无漂移（逐条 type/since/params 一致）`，退出码 0 |
| 改坏 | 把快照里 5 条的 `since` 从 `1.0` 改成 `9.9` |
| 改坏结果 | 5 条逐条指名（`artifact-exists 的 since 不同：快照=9.9 文档=1.0` …），退出码 2 |
| 证据 | `temp/cp-assets/evidence/criteria-types-falsification.txt` |

### 6.2 A3 比对器的证伪（**已执行，本单内**）

| 项 | 值 |
|---|---|
| 命令 | `node test/expected/compare-runs.mjs --selftest` |
| 结果 | **8/8 通过**：好数据全绿；改判据结论必红；改世界清单必红；改结构必红；缺产物必红；图像内容变化仍绿（presence-only 口径）；空文件必红；baseline 声明的产物清单被尊重 |
| 证据 | `temp/cp-assets/evidence/compare-runs-selftest.txt` |

### 6.3 待补的负对照（如实标注）

下面这些断言集的负对照是**合成夹具形态**（改坏输入 → 目标断言变红），本单内**未实机执行**——
它们要么需要实机（权限门、会话门控），要么需要两次完整整跑（幂等）。
实机证据见 `temp/cp-assets/evidence/`，缺失的项在本节如实留白，不写成「已验」：

| 断言集 | 负对照状态 |
|---|---|
| `preflight.json` | 未实机执行（合成夹具形态已写明） |
| `readonly.json` | 未实机执行（需实机写一格） |
| `permissions.json` | 未实机执行（需实机换 token 级） |
| `evidence-completeness.json` | 未实机执行（合成夹具形态已写明） |
| `idempotence.json` | **已由 A3 两次整跑覆盖**（见 `test/expected/read-surface/a3-two-runs.json`） |
| `variant-precision.json` | 未实机执行（需实机跑变体） |

## 7. 已知边界

- **`requiresCase: null` 的判据集**（`preflight.json`）：它判的是「设施能不能跑」，
  因此不绑定用例——但它的③（期望产物）仍由 `assertions[]` 的逐条 `expect` 承担。
- **判据集不新建世界**：需要世界的断言必须通过 `requiresCase` 间接获得 hermetic 保证。
- **本目录不改驱动**：抽取是「声明式镜像」，改造归 #104。
