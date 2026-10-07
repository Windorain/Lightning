# `test/cases/` —— 固定程序

## 1. 用途

存放**固定请求序列**：一份用例文件就是一份可重放的固定程序（`lightning.case/1`，
格式见 `docs/control-plane/case-file.md`）。本目录是控制面用例的**唯一入库位**（#103 G1 裁决）。

## 2. 命名规范

- 目录名与文件名一律 **kebab-case**（`^[a-z0-9]+(-[a-z0-9]+)*$`）；
- 文件名**逐字等于**顶层 `id`（`expected/<caseId>/` 的目录名靠它反查）；
- 允许**两级**（族目录 / 用例文件），族目录只是索引分组，**不参与用例 `id`**，不再加深。

| 族目录 | 收什么 |
|---|---|
| `anchor/` | 锚点族：**双轨判据齐备**（TE 运行期态 + 图像轨），可视特性回归 |
| `read-surface/` | 读面族：`read` 段产物进判据（读面能力面） |
| `smoke/` | 冒烟族：能力面最小连通（跑得快，用于「设施还活着吗」） |
| `regression/` | 常规回归：L0/L1 编排、逐步断言（`action` 段的能力面） |

## 3. 入库门槛检查单（逐条可判定）

> **机械保障**：`mod/gtnh/src/test/java/.../TestAssetLibraryTest.java` 把下面每一条接进 `gradle test`。
> 勾选是给人看的，**构建才是判据**。

- [ ] **① 固定请求序列**：用例自包含（无 `include`/`ref`/`extends`——v1 无 include 机制，`CaseParser.TOP_LEVEL_FIELDS` 严格模式拒绝未知顶层字段）
- [ ] **② 固定世界重建参数**：`world` 段存在、`void:true`、`seed` 显式、`folder` 以 `cp_` 开头；`world` 是**第一个世界写动作**（hermetic 纪律，case-file.md §8.8）
- [ ] **③ 期望产物**：`criteria` 非空（≥1 条**决定性**判据）+ `evidence.expect` 非空 + `variants` 非空（负对照）
- [ ] **决定性判据**：至少一条对**值**的断言（不是只有 `artifact-exists`/`artifact-nonempty`）
- [ ] **负对照精确**：每条 `variants[i].expectCriteriaRed` 指向本用例里真实存在的判据 id；补丁只打 `/criteria` `/read` `/action`
- [ ] 命名 kebab-case；文件名 == `id`
- [ ] `case.validate` 无 error（warning 可接受，但要在索引行里说明）
- [ ] 本目录的 `README.md` §4 清单行已补（层 / 用途 / 重放方式 / 期望产物四列齐）
- [ ] `test/README.md §1.1` 索引行已补
- [ ] 实机跑过一次并留证据（run 记录 + 红绿表）；证据按 AGENTS.md 铁律 5 **当场落 Gitea**
- [ ] **A3**：同一程序执行两次，产物按 `docs/control-plane/case-file.md §10` 的比较模式一致（附两个 `runId` 与比对记录）

**`action` 段专有**（v1.6 起可用）：

- [ ] 编排步骤的动作名**已注册且是同步动作**（步进动作在执行期被拒：本段在单次 `advance` 里逐条跑完）
- [ ] **不含收尾原语** `core.shutdown`（`CaseValidator.ACTION_FORBIDDEN`）
- [ ] `expect` 非空时，指针形态正确（`/` 开头或空串）；**不写空对象**（空断言集恒绿）
- [ ] 分层标注：本用例的**结论**取自哪一层（L0/L1）已写进索引行；L0 的产物不当 L1 的证据

**双轨专有**（含可视特性的锚点用例）：

- [ ] 每个 `te-state-equals` 有同目标的图像轨判据（id 前缀 `te-`/`img-` + 第二段逐字相同，配对口径见 `anchor-checks.ps1::Test-AnchorPairing`）

## 4. 本类资产清单

| 资产 | 层 | 用途（一句话） | 重放方式 | 期望产物 |
|---|---|---|---|---|
| `anchor/lp-pipe-row.json` | L0 | LP 四管三种连接形态的可视回归（双轨判据） | `caller.mjs case.run '{"file":"<abs>/test/cases/anchor/lp-pipe-row.json"}' --tier forensic --sync --timeoutMs 600000` | 18 条判据全绿 + 2 张 1280×720 PNG + `world/scene-manifest.json` |
| `anchor/ae2-parts.json` | L0 | AE2 缆块/部件形态 + K1 距离门对照 | 同上，换文件 | 22 条判据全绿 + 4 张 PNG + TE 运行期读数 |
| `read-surface/read-surface.json` | L0 | 7 个读面动作的产物可被判据直接引用 | 同上，换文件（tier 可用 scene） | 7 份 `read/*.json` + 25 条判据全绿 |
| `smoke/cp-smoke-basic.json` | L0 | 能力面最小连通（3 石 + 1 箱 + TE 补全） | 同上，换文件 | 4 条判据全绿 |
| `smoke/cp-smoke-shots.json` | L0 | 三机位取证拍摄最小样本 | 同上，换文件 | 3 张 PNG + 8 条判据全绿 |
| `regression/l1-orchestration.json` | **L1** | L2 编排：L0 布景 + L1 玩家操作（走→转身→放置→挖掉），逐步断言 | 同上，换文件 | 6 份 `action/*.json` + 2 份 `read/*.json` + 16 条判据全绿 |

**注**：`smoke-basic` 的判据较薄（4 条），按 taxonomy 草案 §8-3 的成熟度分档**暂不建 `expected/` 基准**
（基准会是空壳）。它入 `cases/` 是因为三件套齐备且是「设施还活着吗」的最快探针。

## 5. 已知边界

- **`build` 段不承担 L0/L1 编排**：它只有四种构建 op（clear/block/te/wait）。要调任意 cp 动作
  （`scene.*` / `player.*` / `read.*`）请用 **`action` 段**（v1.6，case-file.md §3.2）。
- **`read` 段与 `action` 段共享同一 run 目录**：两段的 `path` 不得重名（`CaseValidator` 判跨段冲突）。
- **`cameras` 段非空时**：`case.run` 按内容升格为 `forensic` 级（不足即 `CP-AUTH-002`）。
