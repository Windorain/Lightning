/**
 * **G1 判据② · 内核旧形态字段的「字段理由清单」**。
 *
 * ## 这是什么形态，为什么不是"判零"
 *
 * 内核（`src/domain/**` 为整层迁移的新内核）里有若干**字段**，其存在理由**不是**
 * 内核自身的业务概念，而是"外部格式的表达手段"或"旧消费点的键口径"。删掉它们会立刻
 * 造成行为变更（例如投影下标不可移植、格式版本号显示错），故**不能**判零；
 * 正确形态与本仓 `APPROVED_LEGACY_TO_KERNEL_EDGES` 同族：
 *
 *  - **逐条登记**：每条写全 `字段 / 存在理由 / 旧消费点 / 退出归属 / 负责人`；
 *  - **未登记即红**：机械检测臂扫出的旧形态字段若不在清单里 ⇒ 判红；
 *  - **条目数不得增**：`KERNEL_LEGACY_SHAPE_FIELDS.length === BASELINE_ITEMS`（5）。
 *
 * 清单与被测判据**同目录**（`web/tests/architecture/`）：本仓纪律要求过程性材料不进仓，
 * 但"字段理由清单"**是判据的一部分**（判据依赖它的字段名与理由），与
 * `boundary-rules.mjs` 的登记表同性质，故随判据入仓。
 *
 * ## 与既有计数的口径差异（以判据本尊的扫描口径实测）
 *
 * 既有读数为"**5 处**"，并逐条列出 5 项（其第 2 项含 `cellPalette`/`cellGeometry`
 * **两个**字段声明）⇒ **条目 = 5，字段声明 = 7**。本清单按此落地：
 * 条目数基线 `5`，字段声明读数基线 `7`，两个数都由 `kernel-legacy-shape-fields.test.ts`
 * 的校准自检按本文件的实际内容数出来（不是手写常量）。
 */

/**
 * **旧形态标记词表（封闭集）** —— 机械检测臂 A 的判据词表。
 *
 * ## 为什么是这几个词，而不是"任何提到旧字样的注释"
 *
 * 词表必须**精确**：判据要判红的是"字段的存在理由被明文写成旧机制"，
 * 而本仓注释里"旧"字样遍布（解释历史、解释替代关系），宽词表会把纯解释性注释
 * 误判成旧形态字段（实测：`domain/scene.ts:228 sizeColumn` 的 JSDoc 里有
 * "缺省（旧形态/未声明）"，但它承载的是**文件声明的尺寸事实**，缺省只是兼容情形，
 * 不是"为旧机制保留的形态"）。
 *
 * ⇒ 词表只收**在语义上不可歧义**的表述：
 *  - `legacy \`SlotBlock` / `SlotBlock.paletteIndex`：直接点名旧类型与旧字段；
 *  - `旧编辑期文档`：直接点名"旧文档形态"这一缺省语义的来源；
 *  - `恒取旧文档`：直接点名"旧读取路径"（`Context#documentMetadata` 恒取旧文档）;
 *  - `旧解析器默认`：直接点名旧解析器。
 *
 * 实测命中（本词表扫 `src/domain/**`）：4 个字段声明，
 * 全部在本清单内 ⇒ 判绿；见测试里的**校准自检**（词表非空转 + 命中集 ⊆ 清单）。
 */
export const LEGACY_MARKER_VOCABULARY = Object.freeze([
  'legacy `SlotBlock',
  'SlotBlock.paletteIndex',
  '旧编辑期文档',
  '恒取旧文档',
  '旧解析器默认',
])

/**
 * 逐条登记必须写全的列（判据会机械拒绝缺列）。
 * 与 `APPROVED_LEGACY_TO_KERNEL_EDGES` 的 `reason`/`exitStage` 同义，另加本判据特有的
 * `legacyConsumers`（旧消费点 —— 缺了它就无法判断"这条登记什么时候能退出"）。
 */
export const REQUIRED_COLUMNS = Object.freeze(['field', 'reason', 'legacyConsumers', 'exitStage', 'owner'])

/** 基线条目数（任务书"5 处"⇒ 5 条；每条可覆盖多个字段声明）。 */
export const BASELINE_ITEMS = 5
/** 基线字段声明数（5 条展开为 7 个 `readonly` 字段声明）。 */
export const BASELINE_FIELD_DECLARATIONS = 7

/**
 * **字段理由清单** —— 逐条登记内核里的旧形态字段。
 *
 * 每条的列：
 *  - `id`：稳定标识（判据报错时引用它，不靠行号）；
 *  - `field`：`{ file, type, name }`（`file` 相对 `src/`；`type` 是拥有该字段的接口/类型名）；
 *  - `reason`：**存在理由**（为什么不能删）；
 *  - `legacyConsumers`：**旧消费点**（谁按旧口径在用它）;
 *  - `exitStage`：**退出归属**（哪个退役区能核销）；
 *  - `owner`：**负责人**；
 *  - `arms`：本条目受哪些机械臂把守（见测试文件头）——
 *    `markers`（臂 A：注释里必须仍写明该旧关系）、
 *    `optional`（臂 C：必须仍是可选 `?`，否则"缺省降级"语义静默消失）、
 *    `identityKey`（臂 B：必须仍参与身份键 `Pick<>`）、
 *    `metadataDefault`（臂 D：必须在 `EMPTY_METADATA` / `documentMetadata()` 里显式给缺省）。
 */
export const KERNEL_LEGACY_SHAPE_FIELDS = Object.freeze([
  Object.freeze({
    id: 'legacy-slot-index',
    field: Object.freeze({ file: 'domain/scene.ts', type: 'ObjectDataPayload', name: 'cellPaletteIndex' }),
    reason:
      '逐格承载**文件里的调色板槽位**（legacy `SlotBlock.paletteIndex`）。内核侧的 `palette` 是按"非空气格首次出现序"'
      + '**重新编号**的（0 保留给 air）⇒ 内核侧数组位置 ≠ 文件槽位，槽位**推不出来**，只能承载。'
      + 'R-WK-09 明文：「投影下标跨网格不可移植为实测事实；改下游键口径 = 行为变更不做」。'
      + '⚠️ 它**不是**身份 —— 条目身份由 `cellPalette` 的内容键给出，本字段只是投影期的压缩手段。',
    legacyConsumers: Object.freeze([
      'context/queries#getMaterialUsageCounts（按槽位分组计数）',
      'context/queries#getBlockPaletteEntry（旧实现经 PaletteCache.get("#" + paletteIndex) 取条目）',
      'context/queries#getBlockGeometry（同上，取逐格几何）',
    ]),
    exitStage:
      '文档状态区：三个旧消费点全部改吃内核 `palette` 的内容键（`blockPaletteEntryKey`）之后核销本字段；'
      + '在此之前不得改下游键口径（行为变更）',
    owner: 'G1',
    arms: Object.freeze({ markers: Object.freeze(['legacy `SlotBlock', 'SlotBlock.paletteIndex']), optional: true }),
  }),
  Object.freeze({
    id: 'legacy-default-degrade',
    field: Object.freeze({ file: 'domain/scene.ts', type: 'ObjectDataPayload', name: 'cellPalette' }),
    extraFields: Object.freeze([Object.freeze({ file: 'domain/scene.ts', type: 'ObjectDataPayload', name: 'cellGeometry' })]),
    reason:
      '两个字段的**缺省语义**就是为旧形态保留的显式降级通道：`cellPalette` 缺省 ⇒ 投影侧走名称/几何匹配的降级；'
      + '`cellGeometry` 缺省 ⇒ 该网格无几何资产（旧编辑期文档 `renderMode: \'BlockModel\'`，几何由生产代码按方块身份现算）。'
      + '**缺省不是"空"** —— 那是两种不同的能力状态（与 `cellContent` 的"缺席 ≠ 空"同口径），'
      + '故字段必须可缺省，降级分支才存在。',
    legacyConsumers: Object.freeze([
      'composition/kernelProjection#projectGridCells（缺省时走名称/几何匹配降级）',
      'runtime/gridRead（读面缺省时回落包围盒/现算几何）',
      '旧编辑期文档（`renderMode: \'BlockModel\'`，无 `cellGeometry`）',
    ]),
    exitStage:
      '文档状态区：适配器侧对旧文档形态的判别（`adapters/files/legacyShape`）把"缺省"在上游消解成显式事实后，'
      + '本降级通道可核销；届时字段可改为非可选或直接删除',
    owner: 'G1',
    arms: Object.freeze({ optional: true }),
  }),
  Object.freeze({
    id: 'legacy-identity-key',
    field: Object.freeze({ file: 'domain/blockGeometry.ts', type: 'BlockPaletteEntry', name: 'renderMode' }),
    reason:
      '`renderMode` 是**旧渲染语义**的承载（`BlockRenderMode`：方块模型/平面/None 等旧呈现模式），'
      + '且它**参与条目身份键** —— `blockPaletteEntryKey`（`domain/blockGeometry.ts:647` 的 `Pick<>` 成员列表）'
      + '把它算进内容键 ⇒ "同几何不同 renderMode"的两格**不会**被合并。'
      + '删掉它 = 分区判据变松 = 渲染结果与切换前不一致（能力回退）。',
    legacyConsumers: Object.freeze([
      'domain/blockGeometry#blockPaletteEntryKey（身份键成员）',
      'render/mesh/structureGeometryCore（按 renderMode 选几何来源）',
      'adapters/files/*（旧文件里每个条目的 renderMode 声明 → 内核条目）',
    ]),
    exitStage:
      '呈现区：渲染链不再区分旧呈现模式、且旧文件的 renderMode 由适配器在入场时消解成内核呈现语义后核销；'
      + '核销**必须**同时证明身份键未变松（`blockPaletteEntryKey` 的去重读数不变）',
    owner: 'G1',
    arms: Object.freeze({ identityKey: Object.freeze({ fn: 'blockPaletteEntryKey' }) }),
  }),
  Object.freeze({
    id: 'external-format-version',
    field: Object.freeze({ file: 'domain/content.ts', type: 'DocumentMetadata', name: 'formatVersion' }),
    extraFields: Object.freeze([Object.freeze({ file: 'domain/content.ts', type: 'DocumentMetadata', name: 'gtnhVersion' })]),
    reason:
      '两个字段是**外部格式的事实**（源文件的 `format_version` 与 `gtnhVersion` 声明），有**产品职责**：'
      + '属性面板显示"格式版本"、嵌入预览的元信息提示显示版本号。'
      + '它们曾由 `Context#documentMetadata` **恒取旧文档**的声明（`doc.formatVersion`），'
      + '现由内核元数据承载 ⇒ 消费方不再回头读旧文档根。'
      + '⚠️ 与装配面的 `schemaVersion`（多方块声明编号）**不是同一个编号**，不得互相冒充。',
    legacyConsumers: Object.freeze([
      '属性面板（`formatVersion` 显示）',
      'shared/viewport/useEmbedTooltip（元信息提示的版本号一行）',
      'adapters/files/envelopeCodec（源文件声明 → 内核元数据）',
    ]),
    exitStage:
      '**永久保留**（它是文档自身的元数据这一业务职责，不是过渡形态）；'
      + '要核销的是旧的读取路径（`Context#documentMetadata` 恒取旧文档），那条已兑现',
    owner: 'G1',
    arms: Object.freeze({
      markers: Object.freeze(['恒取旧文档', '旧解析器默认']),
      metadataDefault: true,
    }),
  }),
  Object.freeze({
    id: 'external-format-origin',
    field: Object.freeze({ file: 'domain/content.ts', type: 'DocumentMetadata', name: 'origin' }),
    reason:
      '场景原点（MC 世界坐标 → 场景坐标的平移量）是**外部格式的事实**，由源文件声明；'
      + '内核不重算它 —— 重算会引入"同一文件两次打开得到不同原点"这类不稳定（与 `createdAtMs` 不为 `Date.now()` 同一条纪律）。',
    legacyConsumers: Object.freeze([
      'adapters/files/plainCodec + envelopeCodec（源文件 origin → 内核元数据）',
      '场景渲染（世界坐标 → 场景坐标的平移基准）',
    ]),
    exitStage: '**永久保留**（外部格式事实，有产品职责）；它不是过渡形态，无核销计划',
    owner: 'G1',
    arms: Object.freeze({ metadataDefault: true }),
  }),
])
