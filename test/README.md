# `test/` —— 控制面资产库

> 本目录是**可重放资产**的唯一归集处，与代码同 PR 演进、可 git 追溯（#96 §7 / #103 任务 3）。
> 入库门槛见 §「可重放三件套」；命名一律 kebab-case。
>
> **为什么需要它**：验证设施的价值在于「同参同世界、结论可复算」，而这件事的物质基础是
> **固定程序能被重放**。把固定程序、判据集、教程复现程序、期望基准放进仓库（而不是留在某个
> `temp/` 或某次会话的记忆里），它们才随代码一起被评审、被 diff、被回归——这就是「资产」二字。

## 1. 资产索引

> 「用途」一列是**这一份资产能证明什么**；「重放方式」一列是可复制粘贴的命令；
> 「期望产物」一列是**跑绿之后应该看到什么**——三列齐备才叫「可发现」。

### 1.1 `cases/` —— 固定程序

| 资产 | 层 | 用途（一句话） | 重放方式 | 期望产物 |
|---|---|---|---|---|
| `cases/anchor/lp-pipe-row.json` | L0 | LP 四管三种连接形态的可视回归（**双轨判据**：TE 运行期态 + 图像） | `node scripts/control-plane/caller.mjs case.run '{"file":"<abs>/test/cases/anchor/lp-pipe-row.json"}' --tier forensic --sync --timeoutMs 600000` | `criteria.json` 全绿（18 条）+ 2 张 1280×720 PNG + `world/scene-manifest.json` |
| `cases/anchor/ae2-parts.json` | L0 | AE2 缆块/部件形态 + **K1 距离门对照**（门内渲染 / 门外被剔除） | 同上，文件换成 `ae2-parts.json` | `criteria.json` 全绿（22 条）+ 4 张 PNG + TE 运行期读数 |
| `cases/read-surface/read-surface.json` | L0 | 7 个读面动作的产物**可被判据直接引用**（`read` 段 → `json-field`） | 同上，文件换成 `read-surface.json`（tier 可用 scene） | 7 份 `read/*.json` + 25 条判据全绿 |
| `cases/smoke/cp-smoke-basic.json` | L0 | 能力面最小连通（虚空世界 + 3 石 + 1 箱 + TE 补全） | 同上，文件换成 `cp-smoke-basic.json`（tier 可用 scene） | 4 条判据全绿 |
| `cases/smoke/cp-smoke-shots.json` | L0 | 三机位取证拍摄最小样本（透视 / 正交 / 超分拼接） | 同上，文件换成 `cp-smoke-shots.json` | 3 张 PNG + 8 条判据全绿 |
| `cases/regression/l1-orchestration.json` | **L1** | **L2 编排能力本体**：L0 布景 + L1 玩家操作（走→转身→放置→挖掉），**逐步断言**，结论取自 L1 层 | 同上，文件换成 `l1-orchestration.json`（tier 可用 scene） | 6 份 `action/*.json` + 2 份 `read/*.json` + 16 条判据全绿 |

**分层标注（#96 §4.2）**：`l1-orchestration` 的**结论**取自 L1（`player.*` 的 `observed`/`destroyed`/`blockAppeared`），
而布景走 L0（`scene.player.pose` / `scene.inventory.write`）——L0 的产物**不构成** L1 的证据，
两层的结论不互替。这正是「L2 = L0/L1 的有序编排」在资产里的形态。

### 1.2 `criteria/` —— 判据集

| 资产 | 用途（一句话） | 重放方式 | 期望产物 |
|---|---|---|---|
| `criteria/assertions/preflight.json` | 重放前置：端口发现、契约版本、token、动作自描述存在性 | 驱动读取后逐条求值（见 `criteria/README.md §4`） | 机读断言表（逐条 green/red） |
| `criteria/assertions/readonly.json` | 读面只读性：调用前后世界清单哈希不变 | 同上 | 两侧哈希 + 逐格 diff |
| `criteria/assertions/permissions.json` | 权限门：confirm 门 / 捕获会话门控 / 按内容升格 | 同上（每条都是一次**预期失败**的调用） | 每次拒绝的完整错误信封 |
| `criteria/assertions/evidence-completeness.json` | 证据齐全：`evidence.overall=green` 且 `expect` 逐条在场 | 同上 | 缺失产物清单 |
| `criteria/assertions/idempotence.json` | 幂等：同参两次重建哈希相等 + **A3 产物结构一致** | 同上 | 两侧哈希 + 比对器结论 |
| `criteria/assertions/variant-precision.json` | 负对照精确命中：`expectCriteriaRed` 全红且其余保持绿 | 同上 | 逐条 verdict 映射 |
| `criteria/criteria-types.json` | 判据类型自描述的导出快照（三方对账的第三方） | `node test/criteria/check-criteria-types.mjs --check test/criteria/criteria-types.json` | 「无漂移」结论（逐条 type/since/params） |

**`criteria/` 的第三件是「负对照」而不是「期望值」**（taxonomy 草案 §4.2）：判据集的产出是**结论**，
不是产物；它的「正确」只能由「该绿的绿、该红的红」共同定义。只证明该绿是不够的——恒绿是最常见的失效模式。

### 1.3 `tutorials/` —— 教程复现程序

| 资产 | 用途（一句话） | 重放方式 | 期望产物 |
|---|---|---|---|
| `tutorials/README.md` | **骨架与门槛**（本单只建骨架；首个真实样本由 #106 F2 交付） | —— | 门槛检查单 |

### 1.4 `expected/` —— 期望产物基准

| 资产 | 用途（一句话） | 重放方式 | 期望产物 |
|---|---|---|---|
| `expected/compare-runs.mjs` | A3 比对器：逐产物按声明模式比较两次 run（**口径的唯一实现点**） | `node test/expected/compare-runs.mjs --a <runA> --b <runB>` | 退出码 0=全一致 / 2=有差异 / 3=设施错误 |
| `expected/compare-runs.mjs --selftest` | 比对器的**证伪**：改坏必红、好数据必绿 | `node test/expected/compare-runs.mjs --selftest` | 18/18 通过 |
| `expected/read-surface/manifest.json` | `read-surface` 的期望产物基准（逐产物比较模式 + 稳定值） | `node test/expected/compare-runs.mjs --run <runDir> --baseline test/expected/read-surface/manifest.json` | 逐产物一致/差异（实测 20/20） |
| `expected/read-surface/a3-two-runs.json` | **A3 证据**：同一程序两次 run 的比对记录 | 同上（两侧 runId 见文件） | `overall: green`（21/21） |
| `expected/l1-orchestration/manifest.json` | L1 行为证据的期望产物基准（走/放/挖逐条） | 同上，换目录 | 逐产物一致/差异（实测 22/22） |
| `expected/l1-orchestration/a3-two-runs.json` | **A3 证据**：L1 用例**两对**（4 次）run + 首轮红跑根因 | 见文件内字段 | `overall: green`（23/23 × 2 对） |
| `expected/cp-smoke-basic/a3-two-runs.json` | **A3 证据**：冒烟用例两次 run（最快的一条 A3 证据） | 见文件内字段 | `overall: green`（14/14） |

### 1.5 不入库但被索引的资产（留原处 + 交叉引用）

| 资产 | 位置 | 为什么留原处 |
|---|---|---|
| 判据实现的参考母本 | `scripts/control-plane/anchor-checks.ps1` | 它是**驱动的组成部分**（不是数据资产）；搬迁会拆散驱动，#104 还要改它 |
| 重放通道 | `scripts/control-plane/caller.mjs` | 是运行器不是资产；「无先验知识调用方」的验收锚 |
| 无人值守窗口前置 | `scripts/control-plane/drive-session.ps1` | 钉 `pauseOnLostFocus=false` 的唯一入口（见 §3） |
| 契约文档 | `docs/control-plane/*.md` | 与代码同生共死；`test/` **引用而不复制**（#105：技能 = 使用法权威，docs 只留契约） |
| 部件管线的 oracle / 证伪器 | `scripts/parts-acceptance/oracle/`、`falsification.mjs` | 对象是部件管线（不是 cp）；**形态可借鉴**（基准 JSON + 独立复算器 + 证伪脚本三件套） |
| web 端真实导出固件 | `web/e2e/fixtures/` | 消费方是 playwright，不是 cp |
| A3 比对器的口径来源 | `scripts/multiblock-pipeline/compare-runs.mjs` | 对象是 `pipeline-result.json`，不认 cp run 形态；**口径可迁移，代码不可复用** |
| 代码单测 | `mod/gtnh/src/test/**` | 是代码单测（无世界、无产物），不是可重放固定程序 |

## 2. 可重放三件套（入库门槛）

任一份资产必须同时具备：**① 固定请求序列 ② 固定世界重建参数 ③ 期望产物**。
逐类具体化（每一条都能指到一个具体字段或文件，不做原则性表述）：

| 类 | ① 固定请求序列 | ② 固定世界重建参数 | ③ 期望产物 |
|---|---|---|---|
| `cases/` | 用例文件本身**自包含**（v1 无 `include`/`ref`/`extends`）；段序由契约固定 | `world` 段必填、`void:true`、`seed` 显式；`world` 是第一个世界写动作 | `criteria` 非空（≥1 条**决定性**判据）+ `evidence.expect` 非空 + `variants` 非空（负对照） |
| `criteria/` | 断言集声明 `requiresCase` + 输入契约 + 求值顺序 | **不适用**（替代物 = `requiresCase` 指向的用例是 hermetic 的） | 逐条断言带 `id/target/expr/expect/failSemantics` + **附负对照** |
| `tutorials/` | `program.json` + `SOURCE.md` + `frames.md` | 同 `cases/`；逐帧前置逐条写死 | 场景文件 + 关键帧读面记录（实跑交付归 #106 F2） |
| `expected/` | 基准引用 `{caseId, caseSha256}`（用例一改即失效） | 记录生成条件（`world` 段 + `runId` + 版本 + 客户端配置） | `manifest.json` 逐产物声明比较模式 + 比对器在位 + **证伪记录** |

**「决定性判据」的最低要求**（防「存在即绿」）：
- 图像类：阈值必须是「场景实测值与同机位纯天空实测值的**中值**，两侧留 ≥25% 余量」，标定过程写进索引行；
- 运行期类：≥1 条 `te-state-equals` 必须落在**该场景独有**的字段上（不能是「所有场景都 true」的字段）；
- **禁止**只写 `artifact-exists` / `artifact-nonempty` 充当期望产物。

**机械保障**：`mod/gtnh/src/test/java/.../TestAssetLibraryTest.java` 把上表接进 `gradle test`——
资产一坏，构建当场红，且错误指向具体文件与具体那一件。**门槛不只写在 README 里。**

## 3. 重放前置（缺一不可）

1. **客户端已起、cp 服务已绑**：读 `<mcDataDir>/controlplane/server.json` 拿 `port`；
2. **三级 token 就位**：`<mcDataDir>/controlplane/tokens.json`；
3. **`runClient` 是独占资源**（Gradle 锁 + 端口 + 世界存档）——**先申请窗口**（AGENTS.md 四步纪律）；
4. **无人值守窗口必须先钉 `pauseOnLostFocus=false`**：
   ```powershell
   pwsh -File scripts/control-plane/drive-session.ps1 -PinOnly
   ```
   不钉的后果是实测过的：失焦 ⇒ 自动弹暂停菜单 ⇒ 不 tick ⇒ 自动化产物永不落盘（表现为驱动超时）。
   **禁止「抢焦点 + 周期 ESC」**——那等于跟用户抢键盘鼠标。

**用例文件怎么被 `case.run` 找到**（#103 G1 裁决）：`test/cases/` 是资产的**唯一入库位**；
`case.run` 的 `file` 参数运行期**一律传绝对路径**（既有能力，零契约变更），
`<mcDataDir>/controlplane/cases/` 维持运行期缓存语义。`scripts/control-plane/*.ps1` 里
那批 `Join-Path $scriptDir 'cases\...'` 是驱动默认值，随 #104 改造。

## 4. 命名规范（kebab-case）

| 对象 | 规范 | 强制来源 |
|---|---|---|
| 目录名 / 资产文件名 | `^[a-z0-9]+(-[a-z0-9]+)*$` | 本 README + `TestAssetLibraryTest` |
| 用例文件 | `<id>.json`，文件名**逐字等于**顶层 `id` | 同上（`expected/<caseId>/` 的目录名靠它） |
| `expected/` 子目录 | 逐字等于被引用用例的 `id` | 同上 |
| 用例内 `world.folder` | `cp_` 前缀 + 下划线 | **已有**（contract.md §6.1）；**不适用** kebab-case（它是用例内部字段，不是资产文件名） |
| 判据 / 变体的 `id` | 建议 `<轨前缀>-<目标>[-<面\|机位>]` | 已有约定（双轨配对靠它） |

**反例（勿用）**：`SmokeBasic.json`、`lp_pipe_row.json`、`test_cases/`、`new-case-2.json`（序号无意义）。

## 5. 复算方式（他人可复核）

```powershell
# ① 资产库门槛（离线，不需要客户端）——与 gradle test 同一份判定
cd mod/gtnh; ./gradlew test --tests '*TestAssetLibraryTest*'

# ② 判据类型三方对账（离线）
node test/criteria/check-criteria-types.mjs --check test/criteria/criteria-types.json

# ③ A3 比对器自检（离线，证伪）
node test/expected/compare-runs.mjs --selftest

# ④ 实机重放一份用例（需客户端在跑；见 §3）
node scripts/control-plane/caller.mjs case.run '{"file":"D:\Workspace\Lightning\branches\feat\cp-assets\test\cases\smoke\cp-smoke-basic.json"}' --sync --timeoutMs 600000

# ⑤ A3：同一程序跑两次并比对（实机）
node test/expected/compare-runs.mjs --a <run1> --b <run2> --json-out a3.json
```

## 6. 边界（不属本资产库）

| 项 | 归属 | 边界说明 |
|---|---|---|
| L1 玩家操作动作的**实现** | #101（已合流） | `test/` 只**用**它（`l1-orchestration`），不实现 |
| 导出/多帧/帧预算 | #102 | `tutorials/` 只建骨架；多帧教程程序的实跑交付在 #106 F2 |
| 驱动脚本改造 / 老设施删除 | #104 | `test/` 的判据集**只抽取引用**，不改驱动行为（见 `criteria/README.md §4`） |
| 技能成稿（使用法权威） | #105 | 本 README 只写「这份资产怎么重放」，**不写「控制面怎么用」** |
| 部件管线 / web e2e 的资产 | 各自管线 | 见 §1.5；消费方与运行环境不同，不统一归集 |
