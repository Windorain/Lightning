# 部件验收（P3.1–P3.4）—— 一条命令跑通全闭环

> 契约：`docs/contracts/format-parts-contract.md`（判据与口径真源；过程性计划已按 #51 裁决删除，原文见 issue #51 / git 历史）

## 1. 一条命令

```powershell
npm run acceptance:parts
# 等价：pwsh -NoProfile -File scripts/parts-acceptance/run-parts-acceptance.ps1 -Label <label>
```

常用变体（全部零人工交互）：

```powershell
npm run acceptance:parts -- -DryRun                       # 只做前置检查 + 打印阶段计划
npm run acceptance:parts -- -Runs 2                       # **连续两次完整运行** + 产物字节一致性比对
npm run acceptance:parts -- -OnlyStages l2-real-render -L1From <既有 L1 归档>   # 分段验证
npm run acceptance:parts -- -SkipBuild -L1From scripts/parts-acceptance/.out/p18-release-r1  # 秒级冒烟
npm run acceptance:parts:l1                               # 只跑 L1（游戏内建造→导出→oracle）
```

## 2. 阶段划分与退出码

| # | 阶段 id | 内容 | 产物 |
|---|---------|------|------|
| 1 | `preflight` | gradlew / CoFH conf / node / playwright / canonical oracle 三件 / 验收工具 / L2 spec | `stages/preflight.json` |
| 2 | `build-mod-gtnh` | `cd mod/gtnh && gradlew build` | `logs/build-mod-gtnh.log` |
| 3 | `l1-export-oracle` | **L1**：`run-acceptance.ps1 -Runs <L1Runs>`（游戏内建造 → 全量导出 ×2 → 退化导出 ×2 → oracle ×3 → oracle↔导出逐格核对 → 归档）。**默认 `-L1Runs 1`**（跨会话 FMP stale-tile 累积见 findings F3；单轮内双导出仍提供字节级幂等证据） | `l1/<label>-l1[-rN]/` |
| 4 | `l1-verify-oracle` | **脚本侧独立复算**：`verify-oracle.mjs` × 三个产物（full / degraded_ae2 / degraded_all） | `verify/oracle-*.json` |
| 5 | `degradation-static` | **P3.3 判据**：推断永不当主来源 / 三档降级 / 满方块-only 字节干净 / 旧格式兼容 / web 不重算盒 / proto 契约字段 | `static-checks.json` |
| 6 | `reference-fake-provider` | **P3.4 引用**：P1.1 expB 必抛假提供者（导出完成 + 降级记录落盘 + 结果与基线一致） | `falsification/fake-provider.json` |
| 7 | `regression-vitest` | `cd web && npx vitest run` | `logs/regression-vitest.log` |
| 8 | `build-web` | `npm run build:web` | `logs/build-web.log` |
| 9 | `regression-parts-fixtures` | **P2.5 断言包**（fixture：悬停/统计/图标/回归 + 证伪） | `web/parts-fixtures.json` |
| 10 | `regression-multiblock-cross` | **P3.2 多方块交叉**：`multiblock-channel-traversal.spec.ts -g 尺寸变化方向` 单用例（加载 + 通道切换） | `web/multiblock-cross.json` |
| 11 | `l2-real-render` | **P3.1 L2**：`parts-real-export.spec.ts`（对**真实导出**的渲染/悬停/统计断言） | `web/l2-real-export.json` + `web/l2-observations.json` |
| 12 | `falsify-negative` | **P3.4**：5 条负对照（篡改必红）+ 正对照（未篡改必绿） | `falsification/falsification.json` |
| 13 | `idempotency` | 跨轮产物字节一致性（`-Runs 2` 时逐文件 sha256；时间戳字段除外） | `idempotency.json` |
| 14 | `report` | `build-parts-report.mjs`：§6 清单逐条机器判定 + 举证 | `acceptance-report.json` / `.md` |

**退出码**（优先级从上到下，第一个命中的即最终退出码）：

| 码 | 含义 |
|----|------|
| 3 | 前置检查致命（缺 CoFH conf / gradlew / playwright / canonical oracle / 工具脚本） |
| 4 | mod 半环红（构建 / L1 建造导出 / 脚本侧逐格核对 / 降级静态判据 / 假提供者引用） |
| 5 | web 半环红（vitest / build:web / P2.5 断言包 / 多方块交叉 / L2 真实导出断言） |
| 6 | 证伪红（负对照未如期变红 / 正对照未绿） |
| 7 | 报告未产出（`acceptance-report.json`） |
| 2 | 验收不完整（有阶段 `not-run`：被开关跳过 / 假提供者证据缺失 / 失败即停的后续阶段） |
| 8 | 幂等不一致（`-Runs 2` 的逐条判定或产物字节） |
| 9 | 阶段全绿但 §6 把关清单判红 |
| 0 | 全绿 |

**失败即停**：默认任一阶段红即停（后续阶段记 `not-run` 并进报告）；`-ContinueOnFailure` 关闭该行为（跑完全部再汇总）。

## 3. `acceptance-report.json`（报告结构）

```
schema            lightning.acceptance.parts/1
verdict           { status, counts{pass,fail,na,notRun,total}, redChecks[], naChecks[], deviations[], note }
stages[]          14 个阶段片段（gates/artifacts/evidence/data/notes）
checks[]          **计划 §6 把关清单逐条机器判定**（id/group/label/status/detail/**evidence[]**）
checklistGroups[] 按 A/B/C/D/工程纪律五组汇总
l1 / l2 / regression / degradation / falsification / idempotency   各半环的机读证据
findings[]        实现偏差 / 测量观察登记（F1/F2 偏差、M1 零厚度盒、M2 族名、M3 动画图标）
openItems[] / adjudications[]   开放项与拍板登记（含本轮新增）
evidenceLayout    运行目录/阶段/日志/L1/verify/静态/证伪/web 的路径索引
```

§6 清单共 **22 条**（A 文件表达 4 / B 悬停 3 / C 计数 4 / D 架构 6 / 工程纪律 5），
每条判据只读阶段产物（工具 JSON / playwright 报告 / 原始导出文件），**依赖阶段未运行 ⇒ 记 `not-run`（不计为通过）**。

## 4. 各任务的接线方式（P3.1–P3.4）

### P3.1 全链路自动验收（L1 + L2）

- **L1**（mod 半环）：阶段 3 复用 P1.8 资产 `run-acceptance.ps1`（建造 → 导出 → oracle → 内嵌验证器逐格核对），
  产物收进 `<run>/l1/`；阶段 4 用**脚本侧独立实现**（`verify-oracle.mjs`）对同一产物复算一遍
  ⇒ 两份**独立实现**的逐格结论必须一致（L1 内嵌 verifier 在游戏内跑，脚本侧在 Node 里跑）。
- **L2**（web 半环）：阶段 11 跑 `web/e2e/parts-real-export.spec.ts`，
  输入 = `<run>/l1/<label>-l1/`（`PARTS_ACCEPTANCE_DIR`）+ canonical oracle。覆盖点：
  真实加载渲染（mesh/三角形数 + `DataCloneError` 级 console 断言）、解析级逐格与 oracle 一致
  （`grid:[zi,ri,ci]` 格映射通道）、**单盒区（slab/栅栏/箱子）悬停到部件**、
  **AE2 区同格多部件各得各的 tooltip**、满方块格回归（`part=null`）、
  **统计默认视图行与 oracle `expectedCounts` 精确比对（21 条 / 61 件）**、
  来源徽标 + 图标键 = 物品身份键、**退化导出（degraded_all）**档位与统计子集。
  真实产物的坐标/几何与 fixture 不同 ⇒ 探针点从**导出文件自己的部件盒**派生（见
  `web/e2e/helpers/parts/realExport.ts`），不是硬编码。

### P3.2 回归

| 项 | 接线 | 证据 |
|----|------|------|
| vitest 全绿 | 阶段 7 | `logs/regression-vitest.log` + `stages/regression-vitest.json` |
| `npm run build:web` | 阶段 8 | `logs/build-web.log` |
| `gradlew build` | 阶段 2 | `logs/build-mod-gtnh.log` |
| 旧格式文件（无部件）行为与基线一致 | 阶段 9（P2.5 的 `minimal-v2` 悬停/侧栏回归用例）+ 阶段 5（旧格式 fixture 无部件字段静态判据） | `web/parts-fixtures.json`、`static-checks.json` |
| 满方块-only 字节干净 | **引用 L1 结论**（`fullCubeByteClean.pass` = 开启 vs 关闭部件链路 sha256 相等）+ 阶段 5 的"满方块-only 产物无部件字段"静态判据 | `l1/*/…_result.json`、`static-checks.json` |
| 多方块加载 + 通道切换不回归 | 阶段 10：`multiblock-channel-traversal.spec.ts -g 尺寸变化方向`（驱动 height 1→5 / Tier 1→3 滑杆 + 逐格参考比对，单用例；不跑 `real-acceptance` 全套 ~12 min） | `web/multiblock-cross.json` |

### P3.3 降级与兜底档（接线为主）

- **L1 退化套件结果引用**：阶段 3 的 `suites[]` 里 `degraded_ae2`（关 ae2 ⇒ 档 2 通用盒）与
  `degraded_all`（全关 ⇒ 档 3 inferred）必须 `pass`，且 `disabledFamilies` 非空 ⇒ **提供者开关真的被行使**
  （`check-static.mjs` 的 `l1ResultReference`）。
- **"推断永不当主来源"静态检查**（阶段 5，脚本侧新脚本，不动 mod 代码）：
  三个产物里（a）任何 `family=inferred` 部件的 `tier` 必须为 3；（b）**格级**：任一格只要含 tier 1/2 部件，
  就不得含 `inferred` 部件；（c）退化档位映射（full 有 tier1 `ae2` / 火把落 tier3；degraded_ae2 的 AE2 区
  不再有 ae2 族且落 tier2 generic、未关族仍 tier1；degraded_all 全 tier3 且部件格数不减）。
- **L2 侧**：阶段 11 的 `degraded_all` 用例断言全格 `tier=3/family=inferred/fallback=true`（含 oracle 哨兵语义）、
  统计行全部来自退化 oracle 的 inferred 部件、`countsScope=untransformed-cells-only` 子集精确（torch 12 件）、
  `items:[]` 显式"无"走"未计入清单"提示行。

### P3.4 证伪

| 负对照 | 注入方式 | 期望 |
|--------|----------|------|
| `oracle-tamper-count` | 复制 canonical oracle → 改一个 `expectedCounts[].count`（+1） | 验证器**非零退出**（`expectedCounts[…]` 出现在失败信息里） |
| `oracle-tamper-localid` | 改一个格的部件 `localId` | 非零退出（身份维度） |
| `export-drop-parts` | **"敲掉测试结构一个部件重导出"的等价注入**：在真实导出副本里删掉多部件格的部件条目 | 非零退出（`部件数应为`） |
| `export-drop-cell` | 把某非满格 `cellPartsGrid` 置 -1（整格部件消失） | 非零退出（`应有 partLists 下标`） |
| `export-tamper-count` | 改一个部件 `items[0].count`（1→2） | 非零退出（计数维度） |
| `positive-control` | **不篡改** (canonical oracle, 归档导出) | 退出码 **0**（否则负对照无判定力） |
| `fake-provider-tolerance`（引用） | P1.1 expB 探针归档：11 格中 10 个非满格逐格记录 `providerFailures`，且结果与无该提供者的 expC 基线**逐格一致** | 导出完成 + 静默降级 + 记录落盘 |

所有篡改都发生在 `<run>/falsification/tmp/<control>/` 的**临时副本**上，`oracle/` 与归档导出只读。

## 5. 幂等

- **L1 内部**：同轮双导出 sha256 相等（`idempotencyFull`，字节级）是每轮都有的证据；
  L1 脚本的**跨会话**比对（`-Runs ≥2`）默认改为 1 —— 跨会话 FMP stale-tile 累积（findings F3）
  会让第二次会话偶发翻倍，`-Runs 2` 因此不是可靠的幂等证据来源（它反而是 F3 的探测器）。
- **编排级**（`-Runs 2`）：连续两次**完整**运行（`pass1/` 与 `pass2/`，各自一次客户端会话），
  逐文件比对数据产物（`l1/**/*.json`、`verify/*.json`、`static-checks.json`），并把 pass1 报告与
  pass2 报告**逐条判定**比对（`idempotency.verdictsMatch`）⇒ 写 `<run>/idempotency.json`，
  判定不一致或产物字节不一致 → 退出码 8。
  实测（`p3-idem7`）：两轮 13 个阶段全绿 + **13 个数据产物逐字节一致**。
- **世界基线（`-SnapshotWorld`，默认开）**：第 1 轮前把验收世界快照到 `<run>/world-baseline/`，
  之后每轮开跑前还原（旧的活世界移进本轮目录，不删除）⇒ 各轮起点**逐字节相同**，
  把 F3（跨会话累积）从变量里剔除，让比对测的是**管线**而不是世界状态漂移。
- **排除项（时间戳/路径字段，报告中显式标注）**：`acceptance-report.json#generatedAt`、
  `stages/*.json#startedAt/endedAt/durationMs`、`l1/*/…_result.json#startedAtEpochMs/finishedAtEpochMs`、
  `falsification.json#evidence.*`（含运行目录路径）、`logs/*.log`；
  **JSON 产物里的本轮绝对/相对路径**（`pass1/` vs `pass2/`）先替换成 `<PATH>` 再比字节
  （否则 `verify/*.json`、`static-checks.json` 会把"同一份数据"判成不一致）。
- **报告自幂等**：`reportStable`（同一运行目录重复汇总，逐条判定必须一致）。
- **环境偶发（不静默）**：F3/F5 会让**某一次**客户端会话产出缺失/重复的格，此时 L1 与
  跨轮比对**照实报红**（退出码 4/8）并给出逐格 FAIL 明细 —— 这是判定力，不是噪声。
  多次运行的会话级成功率实测约 70%（13 次会话中 2 次命中 F5、2 次命中 F3）。

## 6. 实现偏差 / 测量观察登记（findings）

| id | 级别 | 内容 |
|----|------|------|
| F1 | **resolved** | 【已修复闭环】StructureDataParser 不透传文档根级 `statsTemplate`/`statsOverride`/`partIconTextures` ⇒ 已加入根级透传白名单（`builtinParsers.ts`），`structureDataRootFields.test.ts` 6 用例锁定；L2 正向锁判徽标=`document-default`。fixture（V2Plain `_extra`）本不受影响。 |
| F2 | **resolved** | 【已修复闭环】`partIconTextures` 无消费接线 ⇒ `EmbedViewport.vue` 新增 computed + `:part-icon-textures` prop 接线（注入沿用 BlockStatsSidebar 既有 watch）；L2 正向锁新增消费级断言"iconKey ∈ 纹理表的部件行全部渲染出 canvas"。 |
| F2b | **resolved** | 【已修复闭环】FMP 行图标键（typeKey，带 `mat=` 前缀）与嵌入纹理键（`PartItem.iconKey()`，裸材料串）错位 ⇒ mod 侧 `nbtDiscriminator` 改存 `mat=<材料串>` 键值串（契约 §10.2 同形），iconKey()==typeKey；web 侧既有测试本就按带前缀形状编写，无需改。 |
| F3 | deviation | **跨会话 FMP stale-tile 累积**（本轮 P3.1 实测擒获，两轮各现一次）：同一验收世界的第二次客户端会话里，overlay 区 FMP 格由 3 部件（`fmp:slot0/1/2`）变成 6 部件（追加 `fmp:slot0#2/slot1#2/slot2#2`），L1 内嵌验证器 4 条判据红、退出码 2；随后单会话运行又恢复正常 ⇒ **时序相关、偶发**（与计划 §9 已登记的探针开放项同源）。**处置**：编排默认每轮从 `world-baseline/` 还原世界（各轮起点逐字节相同）；**判定式照实报红（非静默通过）**；mod 侧属写范围外 ⇒ 只登记。 |
| F5 | deviation | **AE2 伪装板格偶发整格缺失**（本轮实测 1/8 会话）：`cellPartsGrid[12][1][3]`（世界 [68,12,76]，facade+线缆）三套件同报 `FAIL: 部件格应有 partLists 下标（实际 -1）`，计数 `ItemMultiPart:16` 5→4 / `ItemFacade:0` 2→1；下一轮同位置完全正常。mod 侧（建造/捕获时序）⇒ 只登记。 |
| M1 | measurement | AE2 平面类部件（成形/破坏面板）碰撞盒在某轴零厚度（`ae2:SOUTH/collision` y/z 两轴 0 厚度）——平面语义的**如实快照**，非契约违例；L1/L2 盒判据按"逐轴 min≤max + 非全轴退化"判定。 |
| M2 | contract-text | 契约 §3 示例把 EnderIO 族写作 `enderio`，实现统一用 `eio`（localId 前缀 = `source.family` = 开关族名，三者自洽）。 |
| M3 | known-limitation | 动画纹理物品图标的跨进程不确定性（EnderIO 导管 `.mcmeta`）；验收会话已把图集动画精灵复位帧 0，长期方案待定。 |
| M4 | measurement | **从零生成的验收世界导出无效**：清掉验收世界后重建，建造 0 错误但客户端在 `WAIT_SYNC`（60 tick）窗口内收不到新方块 ⇒ `measured` 全格 `hostFullCube=true`、导出无 `cellPartsGrid`。⇒ `-ResetWorld` **默认关闭**（复用既有世界，自动化自带 `resetWorld` 清场 + 重建）。 |

**F1/F2 已由 L2 的"正向锁"用例闭环**（`web/e2e/parts-real-export.spec.ts` 的修复锁用例：断言修复后的正确行为——徽标=document-default、定义根两字段与文件逐值一致、图标 canvas 逐行渲染；回退接线则必红，证伪实证见当轮记录）。F3/F5 仍为开放项（mod 侧时序偶发，编排有确定性规避）。

## 7. 资产与运行位置

- **L1 游戏内产物**（归档前）：`mod/gtnh/run/client/sde_parts_acceptance_*.json`
- **canonical oracle**（留白 #9）：`scripts/parts-acceptance/oracle/`（每轮第 1 轮刷新；`builtAtEpochMs=0`）
- **运行目录**：`scripts/parts-acceptance/.out/parts-acceptance-<label>/`
  （`stages/` `logs/` `l1/` `verify/` `web/` `falsification/` `static-checks.json` `idempotency.json` `acceptance-report.json`）
- **L1 单独入口**：`npm run acceptance:parts:l1`（= 本目录 `run-acceptance.ps1`，可 `-OutRoot` 收进外层运行目录）

## 8. 选型与拍板登记（本轮）

1. **L2 直接消费 L1 归档产物**（编排内新鲜产出，canonical oracle 权威），不另跑"只导出"一轮
   —— 遵守"一次一个 MC 客户端"纪律（计划 §5 P3.1 允许"验收编排内重新导出"）。
2. **P3.4「敲掉一个部件重导出」用导出侧等价注入**（删部件条目 / 整格置 -1），ground truth 不动
   —— 与"少放一部件后重导出"对验证器是同一类缺陷；不改 mod 建造意图（写范围禁止）。
3. **P3.2 多方块交叉选单用例** `multiblock-channel-traversal.spec.ts -g 尺寸变化方向`
   （驱动 height 1→5 与 Tier 1→3 滑杆 + 逐格参考比对），不跑 real-acceptance 全套（~12 min）。
4. **P3.3「推断永不当主来源」= 静态文件判据**（三产物格级检查），scripts 侧实现，不动 mod 代码。
5. **proto 同步以"契约字段在册"静态判据替代跑 `npm run protocol:gen`**（契约 §10.1 拍板：proto 作契约文档 +
   两侧手写对齐；`buf` CLI 非本仓库构建前置）。
6. **L1 默认单会话（`-L1Runs 1`）+ 不清场验收世界（`-ResetWorld` 默认关闭）**：
   F3（跨会话 FMP 累积，偶发）使 L1 内部多轮不可靠；M4（干净世界同步窗口不足）使"清场重生成"产出无效。
   跨轮幂等改由**编排级 `-Runs 2`**（两轮各一次客户端会话 + 逐文件 sha256）承担。

## 9. 历史登记（L1 轮，保留）

- **oracle 格映射通道**：oracle 每格带 `zone` + `grid:[zi,ri,ci]`、root 带 `gridIndex{origin,size,rowAxis}`；
  导出文件 finalize 后不含 worldGrid ⇒ 下游据此定位 `cellPartsGrid` 下标（建议契约 §11 吸收）。
  **注意**：`grid` 的行号是 `rowAxis=y-top-first`（自上而下），而 `Grid.partsAt` 的 `y` 是 Y-up
  ⇒ 页面侧格坐标需 `y = height - 1 - row`（P3.1 L2 实测擒获，helper 已封装 `gridApiPosOf`）。
- **退化格哨兵语义**：`localId=inferred:*` / `boxCount=-1` / `boxProvenance=*` ⇒ 验证器跳过对应维度，
  且**部件条数亦不可预测**（判定为"≥1 且逐部件族/档位/typeKey/物品件数精确"）；`expectedCounts` 只覆盖
  `countsScope=untransformed-cells-only`。
- **动画纹理图标复位帧 0**：验收会话在 EXPORT 阶段起始复位图集动画精灵（视觉-only 副作用）。
