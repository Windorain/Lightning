# `test/expected/` —— 期望产物基准

## 1. 用途

存放**期望产物基准**：一次「跑绿」的 run 被**提炼**成声明式清单（不是整目录复制），
配合比对器即可回答 A3 的问题——「同一固定程序执行两次，产物结构一致吗」。

口径来源：`docs/control-plane/case-file.md §10`（四种比较模式 + 豁免字段表 + 比较对象）。
本目录的 `compare-runs.mjs` 是那条口径的**唯一实现点**。

## 2. 命名规范

- 目录名逐字等于被引用用例的 `id`（`expected/read-surface/` ↔ `cases/read-surface/read-surface.json`）；
- 固定**两级**（`<caseId>/` / 基准文件），不再加深；
- 文件名 kebab-case。

## 3. 入库门槛检查单（逐条可判定）

- [ ] **① 固定请求序列**：基准引用一份用例 `{caseId, caseSha256}`。
      **`caseSha256` 与当前用例不一致即基准失效**（用例一改，基准必须重生成）
- [ ] **② 固定世界重建参数**：基准记录生成它的那次 run 的 `world` 段快照 + `runId` + 版本 + 客户端配置
      （即「这份基准是在什么条件下产出的」必须可离线解释）
- [ ] **③ 期望产物**：基准文件自身（逐产物带 `mode` 与期望值）+ **比对器在位** + **证伪记录**
- [ ] `comparison.md` 逐产物声明比较模式（§10.1 四选一）
- [ ] 比对器对「改坏」有变红记录（见 `compare-runs.mjs --selftest`）

**三条硬线**（taxonomy 草案 §4.4）：

1. **不得把「机器生成的 run 目录」整体入库**——run 目录含 `generatedAt`/`runId`/`durationMs`/时间戳，
   且体量大（一次绿 run = 20 个产物，含 51 KB 的 `read/blocks.json`）。基准要**提炼**成声明式清单；
2. **基准必须附比对器**（脚本或判据集），否则「基准」只是死文件；
3. **基准必须能被证伪**——比对器要有一份「改坏必红」的记录。

## 4. 本类资产清单

| 资产 | 用途（一句话） | 重放方式 | 期望产物 |
|---|---|---|---|
| `compare-runs.mjs` | A3 比对器（逐产物按声明模式比较两次 run） | `node test/expected/compare-runs.mjs --a <runA> --b <runB>` | 退出码 0/2/3 + 机读 JSON |
| `compare-runs.mjs --selftest` | 比对器的证伪：改坏必红、好数据必绿 | `node test/expected/compare-runs.mjs --selftest` | **18/18 通过** |
| `read-surface/manifest.json` | `read-surface` 的期望产物基准（逐产物比较模式 + 稳定值 + 生成条件） | `node test/expected/compare-runs.mjs --run <runDir> --baseline test/expected/read-surface/manifest.json` | 逐产物一致/差异（实测 20/20） |
| `read-surface/a3-two-runs.json` | **A3 证据**：`read-surface` 两次 run 的比对记录 | 见文件内的 `a`/`b` 字段 | `overall: green`（21/21） |
| `l1-orchestration/manifest.json` | `l1-orchestration` 的期望产物基准（L1 行为证据逐条） | 同上，换目录 | 逐产物一致/差异（实测 22/22） |
| `l1-orchestration/a3-two-runs.json` | **A3 证据**：`l1-orchestration` **两对**（4 次）run 的比对记录 + 首轮红跑的根因 | 见文件内字段 | `overall: green`（23/23 × 2 对） |
| `cp-smoke-basic/a3-two-runs.json` | **A3 证据**：冒烟用例两次 run 的比对记录（最快的一条 A3 证据） | 见文件内字段 | `overall: green`（14/14） |

## 5. 比对流程（可执行）

```bash
# ① 两次 run 互比（A3 的标准形态）
node test/expected/compare-runs.mjs --a <runDirA> --b <runDirB> --json-out a3.json

# ② 与基准清单比（expected/ 的形态：只比基准声明的那批产物）
node test/expected/compare-runs.mjs --run <runDir> --baseline test/expected/read-surface/manifest.json

# ③ 自检（证伪：确认比对器不是恒绿）
node test/expected/compare-runs.mjs --selftest
```

**退出码**（与 `core.shutdown` 同一约定）：`0`=全一致 / `2`=有差异（逐产物指名）/ `3`=设施错误。

## 6. 比较模式速查

| 模式 | 语义 | 适用产物 |
|---|---|---|
| `byte-equal` | 逐字节相同 | `world/scene-manifest.json` 的 `blocks`/`tileEntities` 段、导出件正文 |
| `canonical-hash-equal` | 规范化 JSON（键排序、无空白）的 sha256 相同 | `criteria.json` 的判据结论集、`read/*.json`、`action/*.json` |
| `structural-equal` | 结构相同（键集合 + 类型 + 数组长度 + 豁免归一后的值） | `observation.json`、`segments/*.json`、`evidence.json` |
| `presence-only` | 只要求存在且非空 | `shots/*.png`、`logs/*` |

**豁免字段表**见 `case-file.md §10.2`（逐条给契约或机理出处——**豁免要能被审**）。
比对器里的 `EXEMPT_FIELDS` 与那张表**同源**：新增豁免必须同时改文档与脚本。

## 7. 已知边界

- **图像不入基准**（taxonomy 草案 §8-4）：像素内容会话易失（#59 VBO 事件），
  只做 `presence-only`；尺寸与主色占比由**判据**（`image-size-equals` 等）承担，不由比对器承担。
- **`smoke-*` 暂不建基准**（taxonomy 草案 §8-3）：其判据太弱，基准会是空壳。
- **`world-hash-equals` 对 GT 机器是盲的**（#117 发现）：它只覆盖 `{blocks,tileEntities}`，
  而 GT 机器的运行期状态（配方进度、能量）不在其中。**基准比较模式的选择要匹配资产性质**——
  机器类资产的基准不能只靠世界清单哈希，必须同时有 TE/读面判据。
