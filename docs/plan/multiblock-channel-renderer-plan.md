# Lightning 多方块接入 + 渲染器多通道 — 执行计划

> **读者**：下游调度者代理。你负责并发调度子代理执行编码任务、把控全局质量与验收。
> **依据**：《Lightning 需求与设计方向说明书 — GTNH 多方块接入 + 渲染器多通道特性》（下称《需求书》）。本计划不重复《需求书》的论证，只将其翻译为可执行任务、依赖关系与自检标准。
> **铁律**：凡《需求书》标记【硬约束】的条目，调度者把关时**逐条核对，不得妥协**；标记【留白】的条目由执行方拍板，但**必须在代码或文档中留下决策记录**。

---

## 0. 交付总览与完成定义

| # | 交付 | 完成定义（实现侧自检标准） |
|---|------|---------------------------|
| A | `/sde multiblock` 导出指令 | 一条命令全量导出 GT 多方块；**每个多方块恰好一份文件**；覆盖全部通道 × 全部取值 × 两个运行态；与既有 `/sde export` 互不干扰 |
| B | 多方块为主的场景文件 | 文件含文档级形态枚举（与"帧为主"互斥）；能声明多方块名、通道清单、总 Tier 域、变体帧↔取值组合映射、运行态清单；几何零重复 |
| C | 结构性压缩 | 导出体积随**各通道取值数之和 + 差异规则条数**增长，不随组合数连乘增长（有体积剖析数据佐证）；不靠丢弃变体换体积 |
| D | web 多通道渲染 | 视口下方栏呈现 Tier 滑杆 + 每通道一条滑杆；装配零游戏逻辑（查表 + 索引）；同文件同取值 → 与 mod 导出同几何；既有帧播放/分层预览语义不变 |
| E | **自动化验收管线**（本计划新增，用户明确要求） | **一条命令无人值守跑通全闭环**：mod 自动进世界 → 自动执行 `/sde multiblock` → 文件落盘 → web 无头加载渲染 → 自动断言 → 产出机器可读验收报告（JSON + 截图 + 体积曲线）。过程中**零人工交互** |

> **E 是验收方式，不是附属工具。** Phase 3 的全部验证（T3.1–T3.4）都由该管线驱动，禁止以"人工看过了"作为通过依据。验收目标必须明确、完备、可机器判定。

**验收口径说明**：《需求书》第 7 节声明"本轮不出验收口径"。上表是实现侧的**完成自检线**；最终验收口径以用户后续指令为准，调度者届时需补齐并**转化为管线断言**。

---

## 1. 阶段划分与依赖图

```
Phase 0 探针与契约（串行为主，决定全局）
  T0.1 体积剖析基线 ─┐
  T0.2 依赖路线决策 ─┼─→ T0.5 文件格式契约定稿 ──→ 契约样例文件（fixture）
  T0.3 运行态探针   ─┤                              │
  T0.4 通道语义调研 ─┘                              │
                                                    ▼
Phase 1 mod 侧                    Phase 2 web 侧（与 Phase 1 并行，靠 fixture 解耦）
  T1.1 假世界基础设施               T2.1 多方块解析器 + 文档形态判别
  T1.2 多方块枚举+通道探测          T2.2 装配器（查表装配 Grid）
   ↓         ↓                     T2.3 RuntimeDocument 模型扩展
  T1.3 变体构建+几何捕获            T2.4 通道 UI（视口下方栏）
  T1.4 因子化编码实现               T2.5 Embed/Workbench 接线
   ↓         ↘                     T2.6 无头渲染断言管线（Playwright）
  T1.5 /sde multiblock 命令+配置面    ↘
  T1.6 游戏内自动导出管线 ───────────→│
       └────────────┬───────────────┘
                    ▼
Phase 3 集成与验收（串行，全部由 E 管线驱动，零人工）
  T3.1 端到端自动化验收（真实导出 → 真实渲染 → 自动断言）
  T3.2 体积增长曲线自动验证（需求 C 的机器证明）
  T3.3 web 装配 vs mod 导出逐格自动比对
  T3.4 既有路径自动回归
  产出：机器可读验收报告 acceptance-report.json + 截图证据 + 体积曲线数据
```

**并发关键**：T0.5 定稿后必须产出**契约样例文件**（可手工构造或从探针截获），Phase 2 全部基于 fixture 开发，不等待 Phase 1 完成。这是两条工作流解耦的枢纽。

**自动化双线并行**：T1.6（游戏内自动导出）与 T2.6（无头渲染断言）也互相解耦 —— T2.6 先基于 fixture 建好断言骨架，T1.6 先保证"自动进世界 + 自动导出"可重复；两者在 Phase 3 对接成全闭环。

---

## 2. Phase 0：探针与契约（阻断性，先行）

### T0.1 体积剖析基线

- **目标**：建立可复用的体积剖析方法，回答"几何 / 纹理 / 网格 / 变体规则各占多少字节"。
- **做法**：对既有 `/sde export` 产物做分桶统计（blockPalette 几何、textureBlobs、cellGrid、其余），输出一份剖析报告 + 可重复运行的剖析脚本/工具方法。
- **产出**：`docs/plan/volume-profile-baseline.md` + 剖析工具（位置由执行方定，需可重复运行）。
- **写范围**：`docs/plan/`、工具代码所在目录（自报）。
- **自检**：报告中每个字节桶可追溯到具体 JSON 字段；对同一份文件重复剖析结果一致。

### T0.2 依赖路线决策（compileOnly vs 反射）

- **背景**：`mod/gtnh/dependencies.gradle` 中 StructureLib / GT5U / NEI 均为 `runtimeOnlyNonPublishable`，无编译期 API；现有 GT 代码走反射（`GregTechBlockReflection`、`GregTechMetaTileRegistry`）。
- **目标**：论证并拍板 —— 加 `compileOnly` 依赖拿编译期 API，还是沿用反射。
- **必须权衡**：① 通道探测需要 StructureLib 的 `IStructureChannels` / 构造接口（`IConstructable` / `ISurvivalConstructable` / `IConstructableProvider`）；② 运行态进入需要 GT 内部状态机（风险最高处）；③ 维护成本（GT5U 版本升级时反射断裂面 vs 编译期断裂面）。
- **产出**：决策记录 `docs/plan/decision-deps-route.md`（含理由与回退方案），并按决策改 `mod/gtnh/dependencies.gradle`（若选 compileOnly）。
- **写范围**：`mod/gtnh/dependencies.gradle`、`docs/plan/`。
- **自检**：决策后 `npm run build:mod:gtnh` 通过；运行环境（runClient）行为不变。

### T0.3 运行态可达性探针

- **目标**：回答《需求书》风险 1 —— 能否在假世界中让 GT 多方块**真实进入"运行中"态**（活动纹理 / TESR 活动表现 / 部件展开）。
- **参考锚点**：`BlockRenderer6343` 的 `client/world/ObserverWorld.java`（`holo.stackSize = tier + 1` 循环）、`integration/gregtech/GTGuiMultiblockHandler.java`（`ItemStack.onItemUse` + `FAKE_PLAYER`、`INEIPreviewModifier`）。
- **做法**：选 1–2 台有活动态表现的多方块（建议含 TESR 的机器），在假世界构建后尝试驱动其进入运行态，捕获并对比两态几何。
- **产出**：`docs/plan/probe-run-state.md`：可达 / 部分可达（哪些表现拿不到）/ 不可达 + 证据（捕获到的几何差异）。
- **写范围**：探针代码（临时性质，位置自报）、`docs/plan/`。
- **自检**：结论有两态几何对比证据支撑，不是推测。
- **⚠️ 若结论为"不可达"**：调度者**立即上报用户**，"运行态"轴是否降级由用户裁决，不得自行砍需求。

### T0.4 通道语义调研（作用域 + 耦合）

- **目标**：回答《需求书》风险 2、3 —— 通道作用域是否不相交（因子化成立的物理依据）；耦合约束（等级一致性 / 大小关系）从哪里来。
- **参考锚点**：`GT5-Unofficial/src/main/java/gregtech/common/misc/GTStructureChannels.java`（通道定义全集，27 条）；`BlockRenderer6343/integration/nei/StructureHacks.java`（`ofBlocksTiered` / `withChannel` / `LazyStructureElement`）；`client/utils/ConstructableData.java`（`channelMaxTierMap` / `maxTotalTier`）。
- **必须覆盖的已核实事实**：
  - **通道 id 重名**：`"casing"` 在枚举中出现 **3 次**（`METAL_MACHINE_CASING` / `TIER_CASING` / `ALCHEMICAL_CASING`）。文件格式的通道标识必须能消歧（建议：枚举名 + id 双键，或按多方块实例消歧），这是 T0.5 的输入。
  - 通道分两类：**替换型**（coil/glass/casing…换方块）与**尺寸型**（height/length 改结构尺寸），`gt_hatch` 为舱口布局类。
- **产出**：`docs/plan/probe-channels.md`：通道分类表、作用域相交性结论（含验证方法）、耦合约束来源（代码位置）、重名消歧建议。
- **写范围**：`docs/plan/`。
- **自检**：每条结论有代码位置佐证。

### T0.5 文件格式契约定稿（核心留白，本阶段拍板）

- **前置**：T0.1–T0.4 全部完成。
- **目标**：定义"多方块为主"文档格式，落为协议草案文档 + **契约样例文件（fixture）**。
- **必须满足**（对应《需求书》§4、§5 硬约束，逐条核对）：
  1. 文档级枚举量区分"帧为主" / "多方块为主"，互斥；不破坏既有格式与解析。
  2. Frame 仍是唯一变体存储原语；一个变体 = 一帧；等级/运行态差别只在命名与元数据。
  3. 能声明：多方块显示名、通道清单（id + 呈现名 + 取值域含"未设置"）、总 Tier 域、变体帧 ↔ （通道取值组合 + 运行态）映射、运行态清单与呈现名、通道耦合约束。
  4. **禁止组合展开**：存"骨干布局 + 按通道分解的差异规则"，组合在装配时求值；差异规则必须支持"旧下标 → 新下标"的批量替换表达。
  5. 调色板为所有变体并集、全局去重（复用 `MeshCaptureService.liftBlockPaletteToRoot` 的既有机制，见 §5 锚点）。
  6. 与既有 gzip+base64 信封（`SceneEnvelopeBuilder`）兼容 —— 因子化在信封**之前**，信封机制不重做。
  7. 是否扩展 `protocol/`（protobuf）由执行方定；**若改动 proto，必须同步 `npm run protocol:gen` 并检查两端生成代码**。
- **同时产出**：至少 2 份手工构造的 fixture 文件（一台多通道多方块 + 一台仅总 Tier 无具名通道的多方块），覆盖"Not set"取值，供 Phase 2 开发。
- **产出**：`docs/plan/format-multiblock-doc.md` + fixture 文件（建议 `web/src/context/__tests__/fixtures/` 或自报位置）。
- **写范围**：`docs/plan/`、fixture 目录、（可选）`protocol/`。
- **自检**：用《需求书》§4.4、§5.3 逐条打勾；fixture 被 T2.1 解析通过后方可宣布定稿。

---

## 3. Phase 1：mod 侧

> 全部任务完成后须 `npm run build:mod:gtnh` 通过。

### T1.1 假世界基础设施

- **目标**：在 mod 客户端侧建立假世界（DummyWorld + FakePlayer），能承载 GT 多方块的真实构建。
- **参考锚点**：`BlockRenderer6343` 的 `client/world/ObserverWorld.java`、`DummyWorld.java`、`TrackedDummyWorld.java`、`ClientFakePlayer.java`、`api/utils/world/DummyChunkProvider.java`、`DummySaveHandler.java`。
- **建议位置**：`mod/gtnh/src/main/java/com/lightning/mod/client/multiblock/`（新包，执行方可调整）。
- **写范围**：上述新包。
- **自检**：能在假世界放置/读取方块；不触碰真实存档。

### T1.2 多方块枚举 + 通道/等级探测

- **目标**：枚举全部 GT 多方块（`IConstructable`），探测每台的总 Tier 域、通道清单、每通道最大取值。
- **参考锚点**：`integration/gregtech/GTConstructableScan.java`、`integration/nei/StructureHacks.java`、`client/utils/ConstructableData.java`（`channelMaxTierMap` / `maxTotalTier` / `itemTiers`）、`ObserverWorld.estimateTier`。
- **依赖路线**：按 T0.2 的决策实现（compileOnly API 或反射）。
- **写范围**：同 T1.1 新包。
- **自检**：枚举数量与 BlockRenderer6343 扫描结果同量级；探测结果含 T0.4 的重名消歧处理。

### T1.3 变体构建 + 几何捕获

- **目标**：按「通道取值 / 总 Tier / 运行态」驱动假世界构建，逐变体捕获烘焙几何。
- **硬约束核对清单**（调度者逐条验）：
  - 几何真实可达：任何变体在假世界真实构建后捕获，**不得凭空合成**；
  - 调色板 = 所有变体并集，按内容签名去重（复用 `MeshCaptureService` L743–776 的签名机制）；
  - 同一方块状态的烘焙几何全文件只存一份；
  - 运行态：按 T0.3 探针结论驱动机器真实进入该状态后捕获。
- **复用点**：`MeshCaptureService`（几何捕获、调色板提升、纹理嵌入 `TextureBlobEmbedder`）。
- **依赖**：T1.1、T1.2、T0.3。
- **写范围**：同新包 + 对 `MeshCaptureService` 的少量扩展（如需）。
- **自检**：对同一变体重复捕获，几何内容签名一致。

### T1.4 因子化编码实现（需求 C 本体）

- **目标**：把变体集合编码为 T0.5 定稿的因子化格式。
- **硬约束核对清单**：
  - **组合不展开**：骨干布局 + 按通道分解的差异规则；
  - 系统性替换表达为规则（"旧下标 → 新下标"批量规则），不是逐格数据；
  - 尺寸型通道先定骨干，替换型通道叠加，运行态作为叠加层（装配顺序：`尺寸型 → 骨干 → 替换型 → 运行态`）；
  - 建议叠加跨变体差分（N+1 级是 N 级外扩时），但**忠实度优先**；
  - **不得靠丢弃变体换体积**。
- **验证前置**：T1.4 完成前必须先跑 T0.1 的剖析工具，确认字节分布符合预期。
- **依赖**：T0.5、T1.3。
- **写范围**：同新包。
- **自检**：用同一多方块构造"取值数 +1"与"通道数 +1"两组对照导出，体积增量近似常数（为 T3.2 的正式证明备料）。

### T1.5 `/sde multiblock` 命令 + 配置面

- **目标**：在 `CommandSde`（`mod/gtnh/src/main/java/com/lightning/mod/server/command/CommandSde.java`）新增 `multiblock` 子命令。
- **要求**：
  - 一条命令全量导出，每个多方块恰好一份文件；产物与 `/sde export` 完全独立（输出目录建议区分）；
  - 权限沿用 `SdePermissions`；tab 补全同步更新；
  - 配置面（开关 + 上限）：结构性压缩开关、通道取值数/变体数/导出范围上限、是否只导出结构性组合；**默认全量不裁剪**，上限仅安全兜底（配置读写位置参照 `mod/gtnh/src/main/java/com/lightning/mod/config/` 既有约定）。
- **依赖**：T1.4。
- **写范围**：`CommandSde.java`、`config/`、导出新包。
- **自检**：`/sde multiblock` 一次运行产出 N 个文件（N=枚举到的多方块数）；`/sde export` 行为不变。

### T1.6 游戏内自动导出管线（E 管线的 mod 半环）

- **目标**：实现**无人值守的游戏内自动导出**：启动客户端 → 自动进入世界 → 自动执行 `/sde multiblock` → 等待导出完成 → 文件落盘到约定目录 → 输出结构化结果（成功/失败、文件清单、耗时、警告），进程退出码反映成败。
- **既有基础**：`mod/gtnh/src/main/java/com/lightning/mod/client/automation/`（SDE 自动化 tick 已有先例）；`SdeServerRecordScheduler`（tick 调度先例）。自动进世界的实现方式（启动参数直进存档 / 主菜单自动建图 / tick 驱动状态机）由执行方论证决定，**但必须可重复、幂等**（同一世界多次导出结果一致）。
- **要求**：
  - 全程零人工交互：从进程启动到导出落盘不需要任何人输入；GUI 可显示，但不得需要点击；
  - 支持**范围参数**（全量 / 指定多方块子集），供 Phase 3 用小子集快速迭代、用全量做终验；
  - 导出完成后自动退出（或有明确的完成信号文件），供外层脚本（npm script / gradle task）编排；
  - 失败可诊断：失败时落盘原因（哪台多方块、哪个取值、异常栈），不得静默跳过 —— **静默跳过 = 管线失败**。
- **同时产出**：**展开形态校验文件** —— 对每台验收多方块、若干抽样取值组合，mod 侧额外导出该组合的**展开完整结构**（ground-truth cellGrid），供 T3.3 与 web 装配结果自动 diff。这是"web 装配 = mod 导出"的机器判据来源。
- **依赖**：T1.5。
- **写范围**：`mod/gtnh/src/main/java/com/lightning/mod/client/automation/`（或新子包）、外层编排脚本。
- **自检**：同一台机器连续两次无人值守导出，产物字节一致；故意制造一次失败（如移除依赖），退出码非零且原因落盘。

---

## 4. Phase 2：web 侧

> 全部任务完成后须 `cd web && npx vitest run` 与 `npm run build:web` 通过。

### T2.1 多方块解析器 + 文档形态判别

- **目标**：新增 parser，识别"多方块为主"文档（含 Envelope 包装形态），解析为运行时模型。
- **锚点**：`web/src/context/parserRegistry.ts`、`web/src/context/parsers/builtinParsers.ts`、`web/src/render/data/compactSceneDocument.ts`（信封判定）。
- **硬约束**：文档级枚举判别互斥；既有四类 parser（V2Plain / Envelope / World / StructureData）行为不变。
- **依赖**：T0.5 fixture。
- **写范围**：`web/src/context/parsers/`、`web/src/render/data/`（如需）。
- **自检**：fixture 解析通过；既有 `roundtrip.test.ts` 不红。

### T2.2 装配器（查表装配，零求值）

- **目标**：实现"当前（通道取值 + 运行态）→ cellGrid → Grid"的纯查表装配：尺寸型定骨干 → 叠加替换型规则 → 叠加运行态层。
- **硬约束**：**不含任何游戏逻辑/函数求值**，只有查表 + 索引 + 规则应用；输出接入既有 `Grid`（Y-up，`web/src/context/grid.ts`）。
- **依赖**：T2.1。
- **写范围**：装配器新文件（建议 `web/src/context/multiblock/` 或自报）。
- **自检**：对 fixture 的所有合法取值组合装配不出错；非法组合（违反耦合约束）被规则拒绝或夹取（行为需在格式文档中定义）。

### T2.3 RuntimeDocument 模型扩展

- **目标**：`RuntimeDocument`（`web/src/context/runtimeDocument.ts`）承载多方块元数据（通道清单、Tier 域、运行态、变体映射），Frame 语义保持为唯一变体原语。
- **硬约束**：帧为主文档的序列化/反序列化 round-trip 不回归（`_extra` 兜底机制保持）。
- **依赖**：T2.1。
- **写范围**：`web/src/context/runtimeDocument.ts` 及配套测试。
- **自检**：新增 round-trip 测试覆盖多方块文档；既有测试不红。

### T2.4 通道 UI（视口下方栏）

- **目标**：在 `ViewportFrameLayerDock.vue` 新增"通道"面板（tab），承载：
  - **总 Tier 滑杆**：标签 "Tier"，范围 1..最大总等级；
  - **每通道一条滑杆**：标签 = 通道 id 首字母大写（如 Coil / Glass / Casing），范围 0..最大取值，0 显示 **"Not set"**；
  - 运行态切换（呈现名来自文件声明）；
  - 调整取值 → 触发装配 → 结构刷新（等级越高结构越大）。
- **参考**：`BlockRenderer6343/integration/nei/GuiMultiblockHandler.java` L128–204（两件套滑杆模式）；注意其另有 Layer 滑杆，与既有「分层预览」对应，**不要重复造**。
- **硬约束**：忠实展示文件声明，不做特殊业务逻辑、不猜测语义；与"帧控制/分层预览" tab 互不干扰。
- **依赖**：T2.2、T2.3。
- **写范围**：`web/src/shared/viewport/`（新组件 + Dock 改造）。
- **自检**：fixture 加载后通道面板出现且条数 = 文件声明条数；无具名通道的 fixture 只显示 Tier 滑杆。

### T2.5 Embed / Workbench 两端接线

- **目标**：`EmbedViewport.vue`（L299 附近）与 `WorkbenchViewport.vue`（L213 附近）接线通道面板的状态流（当前取值 → 装配 → 当前帧网格）。
- **硬约束**：Embed 只读查看器同样可用通道切换；帧为主文档加载时通道 tab 不出现。
- **依赖**：T2.4。
- **写范围**：上述两个文件。
- **自检**：两端各加载一次多方块 fixture，通道切换后结构变化。

### T2.6 无头渲染断言管线（E 管线的 web 半环）

- **目标**：建立 **Playwright 无头验收管线**：启动真实 Workbench/Embed → 注入场景文件 → 驱动通道滑杆 → 截图 + 读取公开观测点 → 自动断言。这是 CLAUDE.md 中"黑盒测试（Playwright，待建）"的首次落地，**必须遵守其零替身原则**：
  1. 入口挂载 —— 完整 `WorkbenchRoot`（或 `EmbedRoot`）启动，不挂测试壳；
  2. DOM 事件注入 —— Playwright → PointerEvent/KeyboardEvent → EventDispatcher，不直接调内部函数；
  3. IO 接管 —— 场景数据由测试注入（fixture 或 T1.6 真实导出文件）；
  4. 公开观测 —— 断言只走公开接口（ctx / queries / DOM / 截图），不戳私有状态；
  5. 零替身 —— 全部生产类实例，无 Mock/Fake/Stub。
- **必须内建的断言能力**（Phase 3 直接复用）：
  - 加载文件后读取通道清单，断言通道面板条数/标签/取值域与文件声明一致；
  - 遍历取值组合：驱动滑杆 → 等待装配 → 断言网格尺寸变化方向正确（Tier/尺寸型通道增大 → 结构变大）；
  - 导出当前装配网格（通过公开观测点），供与 mod 展开校验文件逐格 diff（T3.3）；
  - 每组合截图存档（证据链），截图不得全黑/全空（基础像素断言）；
  - 帧为主文档回归断言（T3.4 复用）。
- **依赖**：T2.4、T2.5（先用 fixture 开发，不等 T1.6）。
- **写范围**：`web/` 下测试目录（Playwright 配置与测试代码，位置自报并在 `web/package.json` 注册 npm script）。
- **自检**：对 fixture 全组合自动遍历通过；故意篡改 fixture 一个格子，管线变红 —— 证明断言有效而非恒绿。

---

## 5. Phase 3：集成与验收（串行，E 管线驱动，调度者亲自把关）

> **总入口**：Phase 3 收敛为**一条命令**（如 `npm run acceptance:multiblock`，具体名由执行方定）编排：T1.6 游戏内自动导出 → T2.6 无头渲染断言 → 汇总 `acceptance-report.json`。**调度者跑命令、读报告、按 §6 清单逐项核对；报告全绿 + 抽查证据链 = 通过。** 任何环节需要人工介入，即视为管线缺陷，打回修复。

### T3.1 端到端自动化验收（真实导出 → 真实渲染）

- **流程**（全自动，对应原"代表样例目视比对"的自动化升级）：
  1. T1.6 管线对至少 3 台代表性多方块执行真实导出：
     a. 一台**多通道**多方块（如含 coil + glass 的 EBF 类）；
     b. 一台**含尺寸型通道**（height/length）的多方块；
     c. 一台**仅总 Tier** 的多方块；
  2. T2.6 管线加载真实导出文件，自动遍历**全部合法取值组合**（含运行态两态）：驱动滑杆 → 装配 → 截图 → 网格导出；
  3. 自动断言：通道面板与文件声明一致；非法组合被约束拒绝/夹取；每组合截图非空且相邻等级截图有差异（证明结构真的变了）。
- **通过标准**：3 台多方块 × 全组合断言全绿，截图证据链完整存档。
- **补充人工环节（可选，不阻断）**：报告通过后，人可抽查截图与 BlockRenderer6343 NEI 预览对比外观 —— 这是加分项，不是通过条件。

### T3.2 体积增长曲线自动验证（需求 C 的机器证明）

- **流程**：管线驱动 T1.6 对同一多方块做多组对照导出（某通道取值数递增 / 通道数递增），用 T0.1 的剖析工具自动分桶统计，生成体积增长数据与曲线图。
- **通过标准（机器判定）**：体积随**各通道取值数之和**近似线性增长 —— 具体判定式由执行方在 T0.5 定稿时定义（建议：取值数翻倍时体积增长倍数 < 取值数增长倍数 × 安全系数），写入 `acceptance-report.json`；数据归档 `docs/plan/volume-profile-result.md`。
- 同时自动核对：调色板并集体量占文件比例（《需求书》风险 4），超标即报告中标红。

### T3.3 web 装配 vs mod 导出逐格自动比对

- **流程**：T1.6 产出的**展开形态校验文件**（ground-truth cellGrid）与 T2.6 装配导出的网格，由管线逐格 diff。
- **通过标准（机器判定）**：所有抽样组合 **diff = 0**。任何一格不一致 → 报告标红并给出坐标、两边各自的下标与调色板条目。
- 抽样策略：每台验收多方块至少覆盖 每个通道的最小/最大取值 + 两个运行态 + 若干随机组合，抽样清单写入报告。

### T3.4 既有路径自动回归

- **流程**（全部自动）：
  - `cd web && npx vitest run` 全绿；`npm run build:web`、`npm run build:mod:gtnh` 通过；
  - T2.6 管线加载**帧为主**文档，断言帧播放与分层预览语义不变；
  - T1.6 管线同世界内先后执行 `/sde export` 与 `/sde multiblock`，断言两者产物互不影响、`/sde export` 产物与基线一致。
- **通过标准**：全部自动断言绿；无人工"过一遍"环节。

---

## 6. 调度者把关清单（硬约束汇总）

以下条目在验收时**逐条核对**，任何一条不满足即打回：

**数据真实性**
- [ ] 所有变体（含运行中态）在假世界真实构建后捕获，无凭空合成几何
- [ ] 调色板 = 所有变体并集；同一方块状态烘焙几何全文件只存一份
- [ ] 捕获几何按内容签名去重、跨变体共享

**压缩（需求 C 核心）**
- [ ] 文件内无组合展开（抽查：文件大小 ≪ 组合数 × 单变体大小）
- [ ] 体积剖析数据证明"随相加而非相乘增长"
- [ ] 未靠丢弃变体/牺牲忠实度换体积；上限仅安全兜底、默认不裁剪
- [ ] gzip+base64 信封机制复用未重做；因子化发生在信封之前

**格式与兼容**
- [ ] 文档级枚举互斥判别；帧为主既有格式/解析/播放语义不变
- [ ] Frame 仍是唯一变体存储原语，无新概念抽象层
- [ ] 通道命名尊重游戏内 id；重名 id（`casing` ×3）已消歧
- [ ] 通道耦合约束有表达或明确的缺省行为定义

**web 渲染**
- [ ] 装配路径零游戏逻辑（查表 + 索引）
- [ ] 同文件同取值 → web 装配与 mod 导出逐格一致
- [ ] 通道 UI 忠实反映文件声明；滑杆标签/范围/"Not set" 符合命名约定
- [ ] 与帧播放/分层预览互不干扰；Embed 与 Workbench 两端均可用

**工程纪律**
- [ ] `npm run build:mod:gtnh` / `npm run build:web` / `cd web && npx vitest run` 通过
- [ ] 未引入除「通道」「运行态」外的第三个轴
- [ ] 未在 web 端重放 GT/StructureLib 逻辑

**自动化验收（交付 E）**
- [ ] 一条命令跑通全闭环：自动进世界 → 自动导出 → 无头渲染 → 自动断言，**零人工交互**
- [ ] `acceptance-report.json` 产出且全绿；截图证据链与体积曲线数据随报告归档
- [ ] 管线幂等：同环境连续两次运行结果一致（导出产物字节一致）
- [ ] 断言有效性已证伪测试：故意注入错误（篡改一格 / 篡改文件声明）管线变红
- [ ] Phase 3 无任何"人工过一遍"作为通过依据的环节

---

## 7. 风险登记与上报协议

| # | 风险 | 探针/验证 | 触发上报的条件 |
|---|------|-----------|----------------|
| 1 | 运行态假世界可达性 | T0.3 | 结论为"不可达"或关键机器类别部分不可达 → **立即上报用户**，等待裁决 |
| 2 | 通道作用域相交 | T0.4 | 发现相交实例 → 格式需为该机记录例外规则；若系统性相交 → 上报用户 |
| 3 | 通道耦合约束 | T0.4 + T3.1 | 无法在导出期获取约束 → 记录缺省行为并在交付说明中声明 |
| 4 | 调色板并集体量 | T3.2 | 并集导致体积预算超标 → 上报用户附剖析数据 |
| 5 | GT5U/StructureLib 版本升级 | T0.2 | 依赖路线决策中记录断裂面与回退方案 |
| 6 | 自动进世界的稳定性 | T1.6 | MC 客户端自动进世界在目标运行环境（本地/CI）不稳定（如时序竞争导致偶发失败率 > 0）→ 不得用"重试到绿"掩盖，须修复根因；无法根治 → 上报用户 |
| 7 | 全量导出耗时 | T1.6 + T3.1 | 全量导出时长超出可接受验收周期（执行方在 T1.6 实测并给出数字）→ 上报用户裁定验收范围（子集验收 / 分片并行） |

**上报协议**：子代理卡在同一问题超过 2 轮、或触及上表触发条件、或需要违背任何【硬约束】才能推进时，调度者**停下该线并上报用户**，不得自行变通硬约束。

**进度汇报**：每个 Phase 结束、每个决策点（T0.2/T0.5）拍板后，向用户汇报一次（含决策摘要 + 依据链接）。

---

## 8. 代码锚点速查

**本仓库（D:\Projects\Lightning）**

| 用途 | 位置 |
|------|------|
| `/sde` 命令 | `mod/gtnh/src/main/java/com/lightning/mod/server/command/CommandSde.java` |
| 信封构建（gzip+base64） | `mod/gtnh/src/main/java/com/lightning/mod/client/export/SceneEnvelopeBuilder.java` |
| 调色板全局去重 | `mod/gtnh/src/main/java/com/lightning/mod/client/meshcapture/MeshCaptureService.java` L160–226 |
| 调色板条目/签名 | 同上 L580–624 / L743–776 |
| cellGrid 现状 | `mod/gtnh/src/main/java/com/lightning/mod/core/scan/StructureScan.java` L111–140 |
| 反射先例 | `mod/gtnh/src/main/java/com/lightning/mod/core/registry/gt/GregTechBlockReflection.java` |
| 依赖现状 | `mod/gtnh/dependencies.gradle` |
| 视口下方栏 | `web/src/shared/viewport/ViewportFrameLayerDock.vue` |
| 两端视口接线 | `web/src/shared/viewport/EmbedViewport.vue` L299、`web/src/workbench/components/WorkbenchViewport.vue` L213 |
| 运行时文档模型 | `web/src/context/runtimeDocument.ts` |
| parser 注册 | `web/src/context/parserRegistry.ts`、`web/src/context/parsers/builtinParsers.ts` |
| 信封判定/解压 | `web/src/render/data/compactSceneDocument.ts` |
| SDE 自动化 tick 先例（T1.6 基础） | `mod/gtnh/src/main/java/com/lightning/mod/client/automation/` |
| 服务端 tick 调度先例（T1.6 基础） | `mod/gtnh/src/main/java/com/lightning/mod/server/SdeServerRecordScheduler.java` |

**参考实现（D:\Github\GTNH\BlockRenderer6343）**

| 用途 | 位置 |
|------|------|
| GT 多方块枚举 | `integration/gregtech/GTConstructableScan.java` |
| 容器扫描（StructureEvent 插桩） | `integration/structurelib/MultiblockInfoContainerScan.java` |
| 通道/等级探测 hack | `integration/nei/StructureHacks.java` |
| 通道→最大取值 | `client/utils/ConstructableData.java` |
| 假世界+逐级构建 | `client/world/ObserverWorld.java`、`DummyWorld.java`、`TrackedDummyWorld.java` |
| GT 真实构造钩子 | `integration/gregtech/GTGuiMultiblockHandler.java` |
| 滑杆两件套（呈现模式） | `integration/nei/GuiMultiblockHandler.java` L128–204 |

**GT5-Unofficial（D:\Github\GTNH\GT5-Unofficial）**

| 用途 | 位置 |
|------|------|
| 通道定义全集（27 条，含重名 `casing` ×3） | `src/main/java/gregtech/common/misc/GTStructureChannels.java` |

---

## 9. 留白决策登记处

以下留白在执行中拍板后，**必须**把决策与理由追加到本文件对应条目下（或链接到 `docs/plan/decision-*.md`）：

1. 依赖路线（compileOnly vs 反射）→ T0.2 产出
2. 压缩编码与文件格式细节 → T0.5 产出
3. 是否扩展 `protocol/`（protobuf）→ T0.5 产出
4. UI 组件改造方式（新 tab vs 复用现有 tab 容器）→ T2.4 拍板
5. mod 侧新包命名与模块边界 → T1.1 拍板
6. 上限默认值（组合数/帧数/文件数）→ T1.5 拍板，需在交付说明中声明
7. 自动进世界的实现方式（启动参数直进存档 / 自动建图 / tick 状态机）→ T1.6 拍板
8. 验收总入口命令名与编排方式（npm script / gradle task / 外壳脚本）→ T1.6 + T2.6 对接时拍板
9. 体积增长的机器判定式（线性拟合容差 / 安全系数取值）→ T0.5 定稿时定义，T3.2 执行
10. 展开形态校验文件的格式与抽样清单 → T1.6 拍板（须与 T2.6 的 diff 工具对齐）

---

## 10. 勘误与决策回写（Phase 0 核实修正）

**留白决策登记**（§9 对应条目）：
1. 依赖路线 → **已拍板：compileOnly 为主 + 4 处受控反射内核**（无公开访问器的成员：`val$channel`、`LazyStructureElement`、`HatchElementBuilder#mHint`、匿名类 `this$0`）。决策与回退方案见 [decision-deps-route.md](decision-deps-route.md)。
2-10. 待定稿后回写。

**事实勘误**（以探针实测为准，下游任务按新口径执行）：
- §T0.4 / §8「通道定义全集 27 条」→ 实测 **30 条枚举常量 / 28 个不同 id**（27 替换型 + 2 尺寸型 + 1 舱口布局型）。重名 id 仅 `casing` ×3，无其他。证据：[probe-channels.md](probe-channels.md) §1.2、§2。
- §T0.4「玻璃等级 ≤ 线圈等级」类耦合的假设 → 全库不存在；主导模式是「玻璃 ≥ 能量仓等级」，其一方为可变结构内容而非通道，格式中记为软约束 note，不参与装配夹取。证据：[probe-channels.md](probe-channels.md) §4.3。
- §1 表格/§8 锚点 `core/registry/gt/GregTechMetaTileRegistry` → 实际位于 `core/registry/GregTechMetaTileRegistry.java`。
- §T0.2 背景隐含「IStructureChannels 属 StructureLib」→ 实际在 **GT5U**（`gregtech/api/structure/`）；编译期依赖必须同时覆盖 GT5U 与 StructureLib。
- §T0.2「运行态进入需要 GT 内部状态机（风险最高处）」→ 经 pinned jar `javap` 核实，`MTEMultiBlockBase` 运行态字段（`mMachine`/`mProgresstime`/`mMaxProgresstime`/`mRuntime`）**全部 public**，活动态为派生量（`setActive(mMaxProgresstime > 0)`），风险等级下修；可达性仍以 T0.3 实测为准。
- §T0.4 建议「UI 标签 = 通道 id 首字母大写」→ 修正为 **UI 呈现名取枚举名**（`capitalize(id)` 会继承 `casing` ×3 歧义，是参考实现的已知缺陷）；文件格式通道标识用 `{enumName, id}` 双键。证据：[probe-channels.md](probe-channels.md) §5。

**T0.3 探针结论与运行态轴裁决**（证据：[probe-run-state.md](probe-run-state.md)）：
- **可达**：假世界满足 `onPostTick` 服务端门槛，活动态由真实状态机从 `mMaxProgresstime` 派生；两态烘焙几何差异已捕获（EBF 差异 4 quad，材质差异恰好为活动纹理切换），三次运行签名一致。
- **调度者临时裁决（待用户确认）**：文件格式的「运行态」轴本轮只承诺**纹理/材质层**两态差异。依据：该层差异是真实状态机驱动、真实捕获、可重复的；超出此范围需要新捕获机制与真实配方运行，属独立工作量。
- **【用户裁决开放项 · 不阻塞流程】**：① shader/VAO 型 TESR 活动表现（GT5U 唯一 `IMTERenderer` 多方块 MTEExoFoundry）几何不经 Tessellator，捕获需新增非 Tessellator 捕获策略；② 部件展开（虫洞/激光/黑洞/纳米锻炉等附属渲染方块）仅真实配方运行中才存在；③ `mMachine=true`（结构成形校验通过）未达成，`checkMachine` 失败点已缩小至 `checkPiece` 未定位到具体格。用户可裁决：接受上述范围排除 / 追加投入攻克哪一项。
- 留白 #5（mod 侧新包命名）→ 已由 T0.3 确立：`com.lightning.mod.client.multiblock/`（假世界/构建/捕获设施齐备，T1.1 直接复用，不再另立）。
