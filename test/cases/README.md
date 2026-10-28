# `test/cases/` —— 控制面用例

本目录是控制面用例文件的唯一入库位。一份用例就是一份固定的请求序列（`lightning.case/1`），格式、段语义与判据词汇见 [docs/control-plane/case-file.md](../../docs/control-plane/case-file.md)。

## 命名与目录

- 目录名与文件名一律 kebab-case（`^[a-z0-9]+(-[a-z0-9]+)*$`）。
- 文件名逐字等于用例顶层 `id`；`expected/<caseId>/` 的目录名靠它反查。
- 固定两级：族目录 / 用例文件。族目录只做索引分组，不参与用例 `id`。

| 族目录 | 收录范围 |
|---|---|
| `anchor/` | 双轨判据（TE 运行期态 + 图像）齐备的可视特性锚点 |
| `read-surface/` | `read` 段产物直接进判据的用例 |
| `smoke/` | 能力面最小连通与最小取证拍摄 |
| `regression/` | L0 布景 + L1 编排的逐步断言用例 |

## 入库门槛

下列条件由 `TestAssetLibraryTest` 接进 `gradle test`，逐条可判；任一不满足即构建失败。

- 用例自包含：不含 `include` / `ref` / `extends`，顶层字段限于 `CaseParser.TOP_LEVEL_FIELDS`。
- `world` 段存在且 `void: true`、`seed` 显式、`folder` 以 `cp_` 开头；`world` 是本用例的第一个世界写动作。
- `criteria` 非空，且至少一条判据对值断言——只含 `artifact-exists` / `artifact-nonempty` 不构成期望产物。
- `evidence.expect` 非空。
- `variants` 非空；每条 `variants[i].expectCriteriaRed` 指向本用例真实存在的判据 id，补丁只作用于 `/criteria` `/read` `/action`。
- `id` 与文件名一致，目录与文件名符合 kebab-case。
- 判据结论的分层在索引行标注：`build` 段（L0）的产物不作为 `action` 段（L1）的证据。

`action` 段专有（v1.6）：

- 编排的动作名已注册且为同步动作（步进动作在执行期被拒，本段在单次 `advance` 内逐条执行）。
- 不含收尾原语 `core.shutdown`（`CaseValidator.ACTION_FORBIDDEN`）。
- 写了 `expect` 时指针形态正确（`/` 开头或空串）；不写空对象，空断言集对任何输入都通过。

锚点用例（含可视特性）专有：

- 每条 `te-state-equals` 有同目标的图像轨判据；`te-` / `img-` 前缀后第二段逐字相同，配对口径见 `scripts/control-plane/anchor-checks.ps1` 的 `Test-AnchorPairing`。

## 用例清单

| 文件 | 覆盖能力面 | 段结构 | 判据 | 变体 |
|---|---|---|---:|---:|
| `anchor/lp-pipe-row.json` | LP 四管横排的三种连接形态，双轨判据 | `build` `capture` `cameras` `criteria` `variants` `evidence` | 18 | 1 |
| `anchor/ae2-parts.json` | AE2 缆块与部件形态，K1 距离门内外对照 | 同上 | 22 | 1 |
| `read-surface/read-surface.json` | 7 个读面动作的产物经 `json-field` 进判据 | `build` `read` `criteria` `variants` `evidence` | 25 | 4 |
| `smoke/cp-smoke-basic.json` | 虚空世界 + 3 石 + 1 箱（TE 补全）的最小连通 | `build` `criteria` `variants` `evidence` | 4 | 1 |
| `smoke/cp-smoke-shots.json` | 三机位取证拍摄的最小样本（透视 / 正交 / 超分拼接） | `build` `capture` `cameras` `criteria` `variants` `evidence` | 8 | 1 |
| `regression/l1-orchestration.json` | L0 布景 + L1 玩家操作 9 步（走、转身、放置、挖掉）逐步断言 | `build` `action` `criteria` `variants` `evidence` | 16 | 3 |

各用例的期望产物基准与 A3 比对记录见 [test/expected/](../expected/README.md)；重放命令与前置条件见 [scripts/control-plane/README.md](../../scripts/control-plane/README.md)。

## 执行约束

- `build` 段只承担四种构建 op（`clear` / `block` / `te` / `wait`）；调用任意控制面动作（`scene.*` / `player.*` / `read.*` / `export.*`）用 `action` 段或对应专段。
- `read` 段与 `action` 段共享同一 run 目录，两段的 `path` 不得重名（`CaseValidator` 判跨段冲突）。
- 含 `cameras` 段的用例按内容升格为 `forensic` 级调用（`case-file.md` §4）。
- 用例 `file` 参数一律传绝对路径；`<mcDataDir>/controlplane/cases/` 只保留尚未入库的运行期专用用例。
