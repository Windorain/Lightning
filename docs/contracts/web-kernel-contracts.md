# Web 编辑器内核 · 冻结契约（v1.7）

> **地位**：本文件是 Web 编辑器内核重建（Gitea
> [#249](http://127.0.0.1:3300/Lightning/lightning/issues/249)）**跨批次契约的单一来源**。
> 后续批次（P1–P11 = #252–#262）只 **import 契约**，不各自重新定义。
> 与代码同生共死：`web/src/` 的实现必须与本文件一致，改实现必须同 PR 改本文件。
>
> **冻结状态**：由执行单 [#251](http://127.0.0.1:3300/Lightning/lightning/issues/251)（B3）冻结。
> 冻结后的**修订流程**见 §10 —— 发现缺口**回父立项
> [#250](http://127.0.0.1:3300/Lightning/lightning/issues/250) 说明理由并获确认，
> **不静默修改**。
>
> **本文件的边界**：它是**类型级契约文本**（语义签名、判别式、错误分类、所有权、失败行为），
> 不是现存可调用 API，也不是实现指南。目录布局见 §7；性能门槛见 #251 B2 附件（标定收口 #262）；
> 退役归属见 **#250** 附件 **asset id 1008**（B5 退役矩阵 **v3** 版）——**终订镜像**见
> **#262** 附件 **1909**（`49792e3-B5-retirement-matrix-final.md`）。辅助类型在本文件中省略，
> 其完整定义由 P1/P2 在 `web/src/` 落地时补齐 ——
> **补齐时不得改变本文件已冻结的语义**。

---

## 0. 如何读本文件

| 记号 | 含义 |
|---|---|
| `Readonly<{...}>` | 值语义的类型；调用方**不得**当作可变对象使用 |
| `Result<T>` | `{ ok: true; value: T } \| { ok: false; error: DomainError }` |
| **必须成立** | 验收断言（对应 #249 §14 A01–A36 的某一项） |
| **负对照** | 故意破坏该保证时测试必须判红的注入方式 |
| `#N` | Gitea issue 号 |

三类读者与各自关心的章节：

- **P1（文档状态域/执行协议，#252）**：§1 §2 §3 §4 §6
- **P2（RNA，#253）**：§1 §3 §5
- **P5–P11（呈现/装配/外壳/边界/导出/退役）**：§5 §6 §7 §8

---

## 1. 值类型（Value Types）

原则（#249 §5）：**对象和属性引用是值，不是裸对象指针**。任何跨边界的引用都必须是可序列化、
可比较、**不含运行时句柄**的纯数据。这条是"统一更新阶段 + 原子一致发布"（#249 §2.1）的前提 ——
如果引用里藏着对象指针，发布一致版本就无从谈起。

### 1.1 `EntityRef` —— 具名拥有者引用

```ts
type EntityRef = Readonly<{
  kind: EntityOwnerKind        // 'document' | 'objectData' | 'editContext' | 'workspace' | 'asset' | ...
  id: string                   // 稳定 ID，跨保存/重开不变
  /** 内容版本；用于判定引用是否过期（见 StaleReference） */
  contentVersion?: number
}>
```

**必须成立**
- `EntityRef` **不含**对象实例、Vue ref、Three 对象、DOM 节点。
- `id` 在文档生命周期内稳定；保存并重开后**同一实体得到同一 `id`**。
  - 依据：所有权表（§6）要求「文档内容…随打开文档存活」+「工程保存」；
    身份不稳定则保存/重开语义不成立。
  - 负对照：把当前空间坐标或 GPU 批次序号当 `id`（#249 §15「格坐标/批次序号兼任对象身份」）
    ⇒ 移动对象或重新分批后引用应失效的测试必须判红。

**选择理由**：`kind` 显式而非靠 ID 前缀编码 —— 编码前缀会在新增实体种类时产生"谁认识这个前缀"
的中心化分支，与 #249 §10「注册顺序不应产生隐藏覆盖结果」和
§13「扩展验证要求通过现有贡献接口新增类型，而非改核心 switch」相冲突。

### 1.2 `ElementRef` —— 稳定子元素身份

```ts
type ElementRef = Readonly<{
  elementId: string            // 顶点/边/面的局部稳定身份
  topologyVersion: number      // 该数据当前拓扑版本
}>
```

**必须成立**
- 子元素寻址**不得**使用 GPU 索引（#249 §3.2 明文："不得把 GPU 索引作为持久身份"）。
- `topologyVersion` 改变后，旧 `ElementRef` 的读/写必须返回 `StaleReference`，
  **不得静默猜配**（#249 §3.2："拓扑版本改变时必须使不再有效的引用显式失效…
  当前不静默猜配"）。
- 负对照：拓扑变化后用编号直接复用旧引用 ⇒ A07 的"取消/撤销恢复正确引用且无孤儿"必须判红。

**选择理由**：#249 §3.2 允许"局部稳定身份**或**由拓扑版本限定的等价稳定寻址"两种实现路径。
本契约只冻结**版本限定**这一必要成分（两种路径都需要它），把"顶点是否自带 ID"留给实现 —— 
避免在 P3 之前就把一种几何实现方式钉死。

### 1.3 `PropertyId` / `PropertyRef`

```ts
type PropertyId = string        // 注册于 RNA 的稳定属性 ID（见 §5.1）

type PropertyRef = Readonly<{
  owner: EntityRef             // 文档/数据/编辑上下文等具名拥有者
  property: PropertyId
  element?: ElementRef         // 稳定子元素身份及必要拓扑版本
  component?: number           // 向量/四元数的分量下标
}>
```

**必须成立（A08 `rna-contract`）**
- `PropertyRef` 是**值**：可比较、可序列化、不含 setter 闭包。
  - 依据 #249 §6："调用方不传任意 setter 闭包。"
- 同一 `PropertyRef` 在文档版本未变时，两次 `read` 返回相等值。
- 多选场景下 `PropertyRef` 表示**一个**目标；批量修改由命令承载（§3.4），
  不是让 `PropertyRef` 变成数组 —— 数组化会让"一个目标不可改则整体拒绝"
  这条原子性判据失去唯一落点。
- 负对照：绕过控件对只读属性直接写（#249 A08 负对照）必须被判红，
  即必须存在**唯一**写入口（§5），不存在第二条通路。

**选择理由**：把 `component` 放进 `PropertyRef` 而不是"另开一个 `ComponentRef` 类型"，
是为了让"向量分量动画"（#249 §7 要求连续数值/向量支持插值）与"标量动画"共用同一寻址与轨道目标，
避免 P4 为分量单开一套轨道表达。

### 1.4 `Version` / `ChangeSummary`

```ts
type Version = Readonly<{
  documentVersion: number      // 文档内容版本（单调、仅内容变化推进）
  /** 语义上等价但需要区分的其它版本位；见 §4 EvaluationKey */
  contentVersion?: number
}>

type ChangeSummary = Readonly<{
  /** 实际发生变化的属性/对象的最小充分描述；用于历史、脏标记与诊断 */
  changedProperties: readonly PropertyRef[]
  createdEntities: readonly EntityRef[]
  removedEntities: readonly EntityRef[]
  /** 结构共享提示：true 表示候选状态与前一版本共享未变子树 */
  structurallyShared: boolean
}>
```

**必须成立**
- `documentVersion` **只**因内容变化推进。播放动画、移动观察机位、单选对象、
  布局调尺寸**都不推进**它。
  - 依据 #249 §2.2 + §7："动画播放不增加文档版本或撤销条目"、§3.4
    "观察视角…不保存/不记历史"。
  - 负对照：`structEpoch`/`renderViewRevision` 这类非内容版本冒充内容版本
    （#249 §15 第 5 条"非内容版本不得冒充内容变化"）。
- 内容版本**不能**用单调提交计数代替（#249 §8："dirty 根据内容身份/内容版本相对保存基线判断，
  不使用仅单调增长的提交计数；撤销回实际保存内容必须干净"）。
  ⇒ `Version` 必须能与保存基线**比较相等**，不只是比较大小。
- 仅创建了新容器**不**等于内容变化（#249 §5 + A06 负对照："新建相同内容容器即记账"判红）。

### 1.5 `CommandTicket` / `JobId`

```ts
type CommandTicket = Readonly<{ ticketId: string; commandId: string }>
type JobId = string

type JobState =
  | { phase: 'queued' }
  | { phase: 'running'; progress?: number }
  | { phase: 'cancelRequested' }
  | { phase: 'succeeded'; result: unknown }
  | { phase: 'failed'; error: DomainError }
  | { phase: 'cancelled' }
```

**必须成立**
- `submit` **返回即不等于生效**（#249 §5："接收不等于已生效"）。
- 普通命令有**一次**结算；长效果另有 Job 状态。
- **调用超时不冒充取消**（#249 §5 明文 + §9"作业取消是协议，不把超时等同取消成功"）。
  `cancelRequested` 是独立相位，不等于 `cancelled`。
- 负对照：把超时直接置为 `cancelled`，或让普通命令结算两次。

---

## 2. `EditorClient` —— 唯一编辑入口

```ts
interface EditorClient {
  read(scope: ReadScope): ReadView                     // 捕获一致版本；无写能力
  submit(command: Command): CommandTicket              // 接收 ≠ 已生效
  executeNow(command: ImmediateCommand): CommandOutcome
  observe(query: QuerySpec, listener: (value: QueryValue) => void): Dispose
}
```

### 2.1 为什么是这四个方法（选择理由）

#249 §5 给出这四个方法是**必要且充分**的最小面：

| 方法 | 不可省的理由 |
|---|---|
| `read` | 语义查询必须能捕获**一致版本**；没有它，消费者只能东拼西凑字段，必然看到"新文档、旧选择、半更新历史"（§2.1 禁止的组合） |
| `submit` | 异步/长效果的唯一入口；与 `executeNow` **共用同一条逻辑更新入口**（§5 明文"不是第二写通路"） |
| `executeNow` | 无效果、可有界完成的命令需要一个同步结算面（否则 UI 无法在同批次内得到拒绝原因） |
| `observe` | 依赖自动维护的只读订阅；没有它，组件只能手动轮询或自建监听（§7"不要求属性声明附带 `refreshViewport()` 回调"） |

**必须成立**
- `read` **不导出**内部 `ApplicationState`、Vue Ref、文档实例字段或渲染对象
  （#249 §5 明文）。⇒ `ReadView` 的字段全部是查询方法，不是数据字段。
- `read` 对**缺失作用域**（`ReadScope` 指向不存在的文档/上下文）**抛异常**，**不**返回 `Result`
  —— 那是**调用方缺陷**，与**业务拒绝**的 `DomainError` **值形态**相区分（业务拒绝走
  `Result` / `CommandOutcome`）。签名保持非 `Result`（`read(scope): ReadView`）正是这个区分。
  - 依据：GF-4 裁决（#250 comment 4866）；落地见 `web/src/runtime/execution.ts` 的
    `Editor.read` 抛错路径（缺失作用域 ⇒ `throw`）。
  - 负对照：让 `read` 对缺失作用域返回 `{ ok: false, error }` ⇒ 与业务拒绝的值形态混淆，必须判红。
- `executeNow` 在以下情形返回 `WouldBlock` / `ReentrantCall`，**不越序、不阻塞等待**：
  执行器忙、发布订阅中重入、存在不兼容前序排队命令（#249 §5 明文）。
- `observe` 的回调**不能同栈重入写入**；新命令进入**下一合法更新批次**（#249 §5 明文）。
- **负对照**：允许订阅回调直接推进版本（#249 A03 负对照"允许回调直接推进版本"）必须判红。

### 2.2 `ReadView`

```ts
interface ReadView {
  readonly version: Version
  objects: ObjectQueries
  properties: PropertyQueries
  workspace: WorkspaceQueries
  interaction: InteractionQueries
}

interface PropertyQueries {
  describe(ref: PropertyRef): Result<PropertyDescriptor>
  read(ref: PropertyRef, mode: 'authored' | 'effective'): Result<PropertyValue>
  editability(ref: PropertyRef): Editability     // 带结构化原因
}
```

**必须成立**
- `read` 的 `mode` 必须是显式二选一，**不得**有隐含默认：
  - `'authored'` = 文档基础值/发布默认值（写面语义）
  - `'effective'` = 经动画/暂存覆盖后的有效值（呈现语义）
  - 依据 #249 §7「有效值优先级：文档基础值/发布默认值 → 编辑上下文手动预览值 →
    已启用轨道的时间采样 → 活动编辑操作的暂存覆盖」。
  - 选择理由：把它做成 `read(ref)` 单参 + 内部自动判断，会让"编辑被轨道驱动的属性"
    的拒绝逻辑失去可测试的输入（§7 要求该场景显式拒绝），因此必须让调用方声明意图。
- `editability` **返回结构化原因**，不是布尔。
  - 依据 #249 §6："动态可编辑性由当前状态和能力求值，不是静态 readonly 一个开关" +
    §19.9"属性只读原因"属诊断接口。
- **不变量**：`PropertyValue` 不得是可变底层 TypedArray 的引用（#249 §5 明文
  "不能暴露可变底层 TypedArray"）。大批量几何查询提供只读批量投影或明确借用契约。

### 2.3 文档装载状态读面（GF-15，P10f A′ 新增；B′ 补消费入口；**R1-α 修正**）

```ts
interface KernelSession {
  /** 内核当前是否承载**一份已装载的文档**（非"空文档"）。 */
  hasLoadedDocument(): boolean
}

interface Context {
  /**
   * **文档替换的唯一写入口**。
   *
   * ⚠️ **R1-α（v1.7）修正**：本方法的自描述原为「写 legacy 文档**并镜像**内核装载状态」。
   * 那句话把**一条内容事实的两个存储**写成设计，而 #249 §2.1 的判据是
   * 「每项事实只有一个权威拥有者」。修正为：**权威是内核 `Document`**；
   * legacy 文档是**渲染载体的投影**，不是第二份内容权威。
   * 回落（内核未装配时 legacy 仍是画面来源）由 GF-16 把守并**登记**（见 §8 GF-17）。
   */
  setDocument(next: RuntimeDocument | null): void
  /**
   * 装载状态的消费入口。
   *
   * ⚠️ **R1-α（v1.7）修正两处**：
   *  1. 内核缺席时的回落分支（原：「回落 `main.doc.value !== null`」）
   *     **不得**作为长期形态存在 —— 它是宿主装配事实的镜像，必须显式登记
   *     （§8 GF-17），不得静默保留；
   *  2. **不得**在本接口上新增**返回旧 `RuntimeDocument`** 的具名读面
   *     （`legacyDocumentModel()` / `legacyRenderSource()` / `legacyGridForEdit()` 一类）。
   *     已存在的三条是**待清算的第二权威读面**（各在 `composition/seams.ts` 登记退出条件），
   *     R1 及之后**只减不增**。判据口径：`legacyDocumentModel(` / `legacyRenderSource(` /
   *     `legacyGridForEdit(` 的**生产调用点**命中数只能下降（AST 扫描，测试文件不计；
   *     ⚠️ **不**用裸标识符 `grep` —— 注释、同名异物与**类型位置**导入会误判）。
   */
  hasLoadedDocument(): boolean
}
```

**`Context.hasLoadedDocument()` 的语义（B′ 冻结）**

它是 29 处 `ctx.getDoc().value !== null`（含 2 处 `.vue` 模板）的替代读面，**必须**与后者逐点同义。
同义不是"逐点核对出来的巧合"，而是**由唯一写者维护的结构不变量** —— 实测：

| 事实 | 机械证据 |
|---|---|
| 生产里写入 `main.doc.value` 的位置**只有一处** | `runtime/main.ts` 的 `replaceDoc`（全树赋值点扫描） |
| 而 `replaceDoc` 的调用点**只有一处** | `runtime/context.ts` 的 `setDocument` 本体（AST 白名单闸门） |

⇒ 镜像**必然**发生在每一次文档替换上 ⇒ 该同义在**任意读取点**成立（不只是 `setDocument` 的 21 个调用点）。
⇒ 这才使 29 处纯读点（组件、`poll()`）可以整批替换，而不必逐点论证。
两条事实均由 `runtime/__tests__/p10fExistenceReadFace.test.ts` 的 ① 组独立断言
（并已用"注入第二处写入点"实测该断言非空洞真）。

**内核缺席时回落 `main.doc`**：`ctx.kernel` 可空（构造参数默认 `null`），测试/诊断宿主不传它。
返回 `false` 会让那些宿主下"本该可选"的菜单项变灰、`poll()` 恒假 —— 那是行为变更。
回落表达式与替换前**逐字同义**；且刻意读 `this.main.doc` 而非 `this.getDoc()`，
以免本读面的引入**新增** `getDoc` 命中（B′ 的目标是下降，不是平移）。

**为什么需要它（缺口原文）**

内核会话在**构造时**就提交 `openDocument`，而 `reduceOpenDocument` **无条件**
`createDocument(...)` ⇒ `document()` 从构造起就恒为 `defined`（实测：已定义但
`scene.objects` 长度为 0）。于是 `document() !== undefined` **无法**表达
"用户打开了一份文档"这一事实 —— 而 legacy 侧 `getDoc().value` 确实会为 `null`
（6 处 `replaceDoc(null)`）。

⇒ 「空文档」与「无文档」在内核侧此前**不可区分**。本读面补上缺失的那一半。

**状态迁移（冻结）**

| 时刻 | `document()` | `hasLoadedDocument()` |
|---|---|---|
| `new KernelSession(...)` | defined（空） | **`false`** |
| 装载成功（文件选择器 / 内置示例 / 嵌入 / SDE×2 / wiki-data 与 DocumentSource 管线） | defined | **`true`** |
| `NewScene`（空**但存在**的场景） | defined | **`true`** |
| 打开失败 / 关文档 / 工作区重置（`setDocument(null)`） | defined | **`false`** |
| undo/redo 回放 | 由**传入值**派生（`null` ⇒ `false`） | 同上 |

**必须成立**

1. **与 legacy `getDoc().value !== null` 逐点对齐**：在全部文档替换调用点上
   `hasLoadedDocument() === (getDoc().value !== null)`。这是后续批次用本读面
   替换存在性判定的**前提**；不对齐则替换会静默改变行为。
2. **唯一写入口**：`Main.replaceDoc` 只允许被 `Context.setDocument` 调用
   （生产源码 `.replaceDoc(` 调用位白名单 = `runtime/context.ts`），
   由 `tests/architecture/boundary-scan.test.ts` 的 AST 闸门机械把守。
   绕过不会报错但会让本读面静默错位 ⇒ 必须判红。
3. **不声称内容时效**：`hasLoadedDocument()` 是**存在性**事实，不是**内容同步**事实。
   `adoptLoadedDocument` 对内核装配不支持的形态会如实降级（返回 `false`）而
   legacy 文档仍非 null ⇒ 此时本读面仍为 `true`（对齐口径）。
   内容一致性由内容身份判据另行回答，**不**由本读面承担。
4. **不复用 `closeDocument` 表达"未装载"**：`reduceCloseDocument` 会一并删除绑定该
   文档的 `contexts`/`leases`/`saveLedgers`，而工作区重置路径在后紧跟
   `seekFrame(0)`（走 `contextAndDoc`）⇒ 复用会让那次帧归零**静默失效**。
   故"未装载"由会话字段表达，内核文档 datablock 保持存在。
5. **写入口是单参数的"两段式"**（A′ 实现相对设计表的一处**已声明偏离**）：
   `setDocument(next)` 只做「legacy 写 + 存在性镜像」；**内容装配留在调用点**
   （`adoptLoadedDocument` / `adoptDocumentIntoKernel`），顺序为
   `setDocument` → `seekFrame(0)` → `adopt`，与加载路径既有顺序一致。
   ⇒ 消费方若只调 `setDocument` 而漏掉装配，后果是"存在性对、内核内容空" ——
   该形态由装载路径的 `objects > 0` 判据机械抓住（`p10fDocumentLifecycle.test.ts`）。

**迁移状态（如实登记）**

P10f **A′** 只建立读面并完成对齐，**不**改动消费面。
P10f **B′** 完成 **N1 的 29 处**替换（`ctx.hasLoadedDocument()`，含 2 处 `.vue` 模板），
并同步 registry 消费者清单（核销 5 个已不再命中的文件，相位仍 `pending`）。

**B′ 未做的两类（如实登记，各有机械理由）**

| 类别 | 为何本批不做 |
|---|---|
| **N3 网格读（14 处）** | 读面已做出且**逐格同义**（三类判据全绿），但接线实测出**两处语义面不同义**：① `moveTranslate.ts:313/330` 的 `grid.moveBlock(...)` 是**写**路径，而投影 `Grid` **每次新建**（实测 `gridOf(doc,0) !== gridOf(doc,0)`，经它写入后改动**丢失**）；② `NewScene`/`pushDocUndo`/模态取消等 6 条路径只调 `setDocument`、**不装配内核** ⇒ 内核读到**上一份文档**的网格（实测 legacy 0 格 vs 内核 2 格）。两者都需 **(a) 区分网格读/写面**、**(b) 内容同步** ⇒ 归 C′。 |
| **N6 帧轴（3 处）** | `#30`（`useKernelFrameLoop.ts`）是**死代码**，按裁决 (a) 删除（零行为变化）；`#32`（`useViewportRuntime.ts`）的 legacy 兜底生产不可达，替换为 `?? 0`；`#31`（`StatusBar.vue`）**暂缓** —— 装配失败时替换会让状态栏帧数 N→0（用户可见回归），随 D8/GF-16 修复批归 C′。 |

### 2.4 装配成功读面与帧声明（GF-16，P10f C′1 新增；**R1-α 修正**）

```ts
interface KernelSession {
  /** 内核承载的**就是**当前文档的装配产物吗（装配成功）。 */
  hasAdoptedContent(): boolean
  /** ⚠️ R1-α 新增：内核承载的**文档身份**（`contentVersion` 的权威来源）。 */
  document(): Document | undefined
}

interface Context {
  /** 装配成功读面的消费入口；内核缺席 ⇒ `false`（没有内核就没有装配）。 */
  hasAdoptedContent(): boolean
  /**
   * **帧声明的唯一读取面**（D8 修复的落点）。
   * 装配成功 ⇒ 内核帧轴；否则 ⇒ 回落 legacy。`source` 让"走了哪条分支"可观测。
   *
   * ⚠️ **R1-α（v1.7）修正**：这条回落**必须**登记（§8 GF-17）——
   * "读者可观测"不等于"有退出阶段"。
   */
  frameDeclarations(): {
    readonly count: number
    readonly durationsMs: readonly number[]
    readonly source: 'kernel' | 'legacy'
  }
  /** **文档身份**计数：只在换文档时变（窄信号；`contentRefreshTick` 是宽信号）。 */
  getDocumentRevision(): Ref<number>
}
```

**为什么 GF-16 不能由 GF-15 兼任（D8 的根因）**

| 读面 | 回答的问题 | 由谁置位 |
|---|---|---|
| `hasLoadedDocument()`（GF-15） | "用户**有**一份文档吗"（存在性） | `Context.setDocument`（写 legacy 时镜像） |
| `hasAdoptedContent()`（GF-16） | "内核里的**就是**那份文档吗"（装配成功） | `adoptDocument`（**仅**装配成功时） |

两者**不等价**，而 D8 正是那段缝：

```
setDocument(doc)     → GF-15 = true    （有文档）
adoptLoadedDocument  → 可能失败（内核不支持该形态，如实降级）
  成功 ⇒ GF-16 = true
  失败 ⇒ GF-16 = false，但 GF-15 仍 true
```

装配失败时内核文档是**构造期的空文档**；任何"读内核"的消费者读到**空**，
而 legacy 照常渲染、**不报错**。⇒ 两个事实必须有两个读面
（与 `domain/cellContent` 判据 3「字段缺席 ≠ 空值」同一口径）。

**必须成立**

1. **`markLoaded` 必须一并**清** GF-16**（C′1 实测更正；我第一版写反了）：
   `markLoaded` 表达"有了一份文档"，而"有"**不蕴含**"内核里的就是它"。
   `setDocument` 会调 `markLoaded` 而**不** adopt（`NewScene`、注解编辑等 13 条路径）
   ⇒ 若不清，所有"读内核"的面都返回**上一份**文档的注解/材质/帧轴。
   实测：装载 A → `setDocument(空文档)` ⇒ 读面仍给 A 的内容。
   顺序是语义的一部分：`adoptDocument` **先** `markLoaded`、**再** `markContentAdopted`。
2. **`markUnloaded` 同样清 GF-16**：卸载后"内核里的就是那份文档"不再成立。
3. **D8 的回落必须可被注入判据证明**：判据走**生产** `adoptLoadedDocument` 喂
   内核真的不支持的形态（`frames` 缺失且非多方块 ⇒ `UnsupportedOperation`），
   断言此时帧数**回落 legacy**（不是 0）。只断言"装配成功时读到 N"是**假绿** ——
   它无法区分"修好了"与"缺陷仍在"。
4. **判定提成纯函数**（`runtime/frameDeclarations#resolveFrameDeclarations`、
   `runtime/sideTableResolution#resolveSideTable`）：`Context` 只取事实。
   理由 —— 判据必须能注入装配失败，而 `Context` 需六件外壳才构造得起来。
5. **帧数的两个消费者必须读同一个函数**（`frameDeclarations()`）：D8 的原形态
   正是"帧循环问文档存在、状态栏直读 legacy"⇒ 两读数不一致（#249 §19.9）。
6. **侧表分流是**对称**的**（`kernelAnnotations()` / `kernelMaterials()`）：
   装配成功 ⇒ 内核为权威，否则 ⇒ **legacy 为权威**。
   ⚠️ "未装配 ⇒ 返回空表"是**缺陷**，不是诚实：注解编辑路径会清 GF-16，
   返回空表会让 `scenePick` 拿不到**原有**注解（用户新建一条后原有注解全部失去拾取），
   材质面板整片变空。实测：legacy 2 条 / 内核读面 0 条。
7. **`null` 与 `[]` 在分流输入上不可互换**：`null` = "没有可用来源"（⇒ 回落），
   `[]` = "这一侧确实空了"（⇒ 内核权威，空是真实答案）。把前者写成后者**就是** D8。
8. **测试宿主不得复刻被测算法**（C′1 两轮空转的教训）：判据必须执行**生产实现本体**。
   本批宿主用 `Object.create(Context.prototype)` 造真 `Context`（只注入 `main`/`kernel`）。
   仅"调用了同名纯函数"不够 —— 宿主自己调它时，`Context` 的调用点仍未被覆盖
   （实测：注入缺陷仍全绿）。

**三种通知信号不可互换（C′1 实测分派）**

| 信号 | 自增点 | 语义 | 消费者 |
|---|---|---|---|
| `getDocumentRevision()` | **仅** `replaceDoc` | "**换了一份文档**"（窄） | `EmbedViewport.vue`（换文档才重置相机自动初始化） |
| `getContentRefreshTick()` | `replaceDoc` **与** `requestContentRefresh` | "内容**可能**变了"（宽） | 材质/属性/注解/tooltip 面板（原地编辑也要刷新） |
| `hasLoadedDocument()` | `setDocument` 镜像 | "无 → 有"（**跃变**） | `WorkbenchViewport.vue`（只在该跃变时重装，避免与 DRW 订阅竞争） |

⚠️ 用宽信号替换窄信号会让"原地编辑时相机跳回"（用户可见回归）；
单调计数器**表达不出**跃变（R-WK-08 裁决点名此例）。

### 2.5 写面分类与共享存储上下文（**R1-α 新增，冻结**；#249 §11 / §3.4）

```ts
type WriteFace = 'document-content' | 'editor-session' | 'publish-default' | 'export-preview'

interface WriteFaceSpec {
  readonly face: WriteFace
  readonly owner: string                 // 契约 §6 所有权表的哪一行
  readonly sharesDocumentContext: boolean
  readonly entersDocumentHistory: boolean
  readonly advancesDocumentVersion: boolean
  readonly persistsToProject: boolean
  readonly persistsToRecovery: boolean
  readonly mayFork: boolean              // 是否允许"同一条事实有两个存储"
}

function writeFaceOf(command: Command): WriteFace   // 唯一分类点；按 kind 穷举
function writeIsEffectOnly(command: Command): boolean

interface SharedStorageContextReport {
  readonly cellContent: boolean
  readonly objectData: boolean
  readonly annotations: boolean
  readonly objectAttachments: boolean
  readonly allShared: boolean
}
function sharedStorageContextReport(): SharedStorageContextReport
```

**为什么需要本节（v1.6 的缺口）**

v1.6 全无"哪一类写与文档内容共用同一份存储"的口径 ⇒ 旧实现把格内容写在
`cellTooltipGrid`/`cellPartsGrid` 两个旁表、对象数据写在 `frames[].structure`、
注解写在 `annotations`、可恢复编辑数据写在 `_sde_workspace.json`、布局与偏好散在
若干 `localStorage` 键 —— **没有任何类型**在把守"它们该不该分叉"。R0-D② 实测的后果是
`Context#setDocument` 写 legacy 文档**并镜像**内核装载状态，而 `syncLegacyFromKernel`
又把内核投影回 legacy ⇒ 同一条内容事实有两个存储。

**四条写面（冻结）**

| 写面 | 权威拥有者 | 共享文档上下文 | 进文档历史 | 推进 `documentVersion` | 进工程 | 进恢复副本 | 允许分叉 |
|---|---|---|---|---|---|---|---|
| `document-content` | 文档状态域 | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `editor-session` | `EditContext` | ✅ | ❌ | ❌ | ✅ | ✅ | ❌ |
| `publish-default` | 文档状态域（`animation.publishedDefaults`） | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `export-preview` | 求值缓存 / 适配器 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

**必须成立**

1. **穷举**：`writeFaceOf` 对 `Command` 联合的**每一条**成员返回一个已登记的写面。
   依据是 `Command` 是封闭判别联合（§5.2）⇒ 可实现为穷举 `switch` 且**无 `default`**
   （新增命令忘了分类会**编译期**判红）。负对照：注入一条只在联合里、未分类的命令必须判红。
2. **在历史与在工程是两件不同的事**：`editor-session` **不**进文档历史（A06：
   「单选不得产生历史条目」）而**必须**进工程文件（#249 §12「可恢复的编辑数据」）。
   把两条压成一条（都进历史、或都不持久化）都会产生用户可见的错。
3. **`export-preview` 不得成为任何事实的存储**：它只消费求值产物、**可丢弃**、
   不保存为权威（§6 所有权表「求值场景、空间索引、统计 | 求值缓存 | 可丢弃 | 不保存为权威」）。
   ⇒ 它**不参与**共享存储上下文，且是唯一"不要求独占文档写权"的写面。
4. **`mayFork === false` 对四条写面全部成立**：第二份存储即缺陷。
   R1 的清算对象（legacy 镜像、`syncLegacyFromKernel`）正落在 `document-content` 上 ——
   那是一条被容忍的**临时**分叉，由 §8 的接缝登记与退出条件把守，不得成为设计。
5. **共享存储上下文的判据形态是"能力存在"，不是"扫描无命中"**：
   格内容 / 对象数据 / 注解三项必须用**可执行的写 → 读**证明（写入后经读面读回），
   并附负对照（不写就读不到）。`sharedStorageContextReport()` 的
   `objectAttachments` **今天恒 `false`**（未类型化承载）⇒ `allShared` 恒 `false`；
   该缺口按 §8 登记 GF（GF-18），由 R2 承接。**不得**用"扫描不到附件字段"报绿。

**β 的接线点（本节的用法）**

β 批接线时按本节确定"一条新写落在哪一面"，从而**机械决定**它是否进历史、进工程、
进恢复副本 —— 不逐条讨论。具体三处：① `workbenchCommandSink` → `editorCommandSink(editor)`
的端口切换（见 §2.7）；② 面板写端口从 `DocumentState.document: RuntimeDocument`
迁到内核寻址根（§2.5 判据 2 决定"选择/时间"不进历史）；③ 工程保存/重开
（已由 R1-α 接生产，见 §2.7）。

### 2.6 网格读面的落点（**R1-α 明确**；GF-13 的网格读面半边）

**落点：`runtime/gridRead` + 统一存储上下文，**不**是 `ReadView` 加 grid 组。**

```ts
// runtime/gridRead.ts —— 权威网格读面（GF-13 已交付形态）
interface KernelGridView {
  count(): number
  at(pos): KernelGridCellView | null
  blocks(): readonly KernelGridCellView[]
  partsAt(pos): readonly PartRecord[] | null
  tooltipAt(pos): string | undefined
  paletteEntryOf(pos): KernelPaletteEntryView | null
  geometryOf(pos): readonly BakedQuad[] | null
  centerWorld(pos): KernelGridPos
}
function kernelGridOf(doc: Document | undefined, frameIndex: number): KernelGridView | null
```

**业务理由（为什么不是 `ReadView.objects` 里加一个 grid 组）**

1. **网格是"对象数据载荷的形状"，不是对象集合的查询**。`ReadView.objects` 回答
   "这份文档有哪些对象/数据"；而逐格读取要回答"第 N 帧的 `blockGrid` 载荷里某格是什么" ——
   它是**载荷内的迭代**，不是对象级查询。把它塞进 `objects` 会让"一次对象查询"变成
   一次可能遍历 W×H×D 的扫描（性能与语义都不对）。
2. **帧轴是它的输入**：`kernelGridOf(doc, frameIndex)` 的第二个参数是"哪一帧"，
   而 `ReadView` 捕获的是**一致版本**（版本里没有"当前帧"这一维 —— 帧由 `EditContext.time`
   派生）。把帧维度塞进 `ReadView` 会让同一个 `ReadView` 对"哪一帧"失去定义。
3. **读面每次新建**（GF-13 实测：`gridOf(doc,0) === gridOf(doc,0)` → `false`）
   ⇒ **在它上面写会静默丢失**。故写路径**不得**走它：已有 `applySetRange` 三条具名命令
   （`setCellTooltip`/`setCellContent`/`moveCells`）承接写；`runtime/gridRead` 的
   `LegacyGridLike`（带 `moveBlock` 的旧编辑句柄）是**待清算**的第二权威写面
   （退出条件见 `composition/seams.ts` 的 `legacy-grid-edit-handle`）。

⚠️ **`KernelSession.gridOf` 不再是权威读面**（R0-D 裁决）：它没有帧维度、
且在未装配时回落旧 `Grid`。"权威"的判据是**它读的是内核文档载荷**（`kernelGridOf`），
而不是它挂在哪一个对象上。

### 2.7 工程格式的生产入口（**R1-α 新增**）

**落点：`composition/projectIo`（装配接线）+ `adapters/projectFile`（边界读写口）。**

```ts
// composition/projectIo.ts —— 装配接线（与 composition/documentLoad 同层同性质）
interface ProjectHost {                 // 结构端口：接线真正需要的两件事
  readonly kernel: KernelSession | null
  setDocument(next: RuntimeDocument | null): void
}
function projectForSave(host: ProjectHost): Result<ProjectFile>
function adoptProject(host: ProjectHost, decoded: DecodedProject): Result<boolean>
function decodeProjectFile(raw: unknown): Result<DecodedProject>

// adapters/projectFile.ts —— 适配器层的**深度 2 公共出口**（实现留在 adapters/files/）
function projectFileOf(input: { doc; context; assets? }): Result<ProjectFile>
function readProjectFile(raw: unknown): Result<OpenedProjectFile>
function restoreProjectFile(decoded: DecodedProject): { doc; context }
```

**⚠️ 为什么入口不在 `Context` 上（R1-α 第一版被闸门判红后更正）**

第一版把这三个方法加在 `Context`（`runtime/context.ts`）上 ⇒ 闸门判红
**三条新的旧层→内核边**（`runtime/context.ts → adapters/files/projectFormat` /
`→ domain/errors` / `→ domain/editing`）。判红是对的：`runtime/context.ts` 是
**待清算**的旧层文件（多条接缝指着它），把新能力加进正在退场的宿主，
正是 #171 禁止的"新门面包旧核心保活"。⇒ 落点改为 `composition/projectIo`
（与 `composition/documentLoad` 同层同性质：那是装载脊柱的接线，这是工程往返的接线），
宿主面用结构端口表达，于是装配层**不依赖** `Context` 这个旧类型。

**⚠️ 层级归属与搬迁决定（R1-α 复核打回 3 的答复，可追溯）**

| 问题 | 结论 |
|---|---|
| `projectFormat.ts` 按**职责**属哪一层？ | **属 `adapters/files/`** —— 它与 `plainCodec`（plain 形状）/`envelopeCodec`（信封传输编码）/`publishFormat`（发布产物）/`documentBinding`（工作环境绑定）是**同一族文件编解码器**。目录分组是读者的第一层导航。 |
| 那深度 3 怎么被新层消费？ | **走深度 2 的公共出口** `adapters/projectFile.ts`（契约 §7.3 规则 2）。先例是既有的 `adapters/plainRoot.ts`（对 `files/envelopeCodec` + `files/plainCodec` 做同一件事）。 |
| 第一版"把实现搬到深度 2"是什么？ | **形状服从规则**（让目录分组迁就一条检查）—— **已回退**。搬迁与否由职责决定，不由闸门决定。 |
| 出口为什么必须**定义函数**而不能 `export … from`？ | `gate/no-barrel-smuggling` 把跨目录 `export-from`（**含类型位置**）判红。出口必须自己定义该层对外承诺的操作 —— 本工程不承认"经转出口偷渡"。 |

**必须成立**

1. **两个保存入口，一个权威**：`plainForSave()`（旧 plain/信封形状）与
   `projectForSave()`（工程形状）是**同一份内核 `Document`** 的两种外部编码，
   不是两个权威。两者都从 `kernel.document()` 取值；**未装配时 `projectForSave` 显式失败**
   （返回 `UnsupportedOperation`），**不**用旧文档填工程负载（那正是第二权威的入口）。
2. **工程负载必须直接编码内核 `Document` 的内容本体**：`scene` + `animation` +
   `content`（`DocumentContent`：元数据 / 帧时长轴 / 资源内容）。
   ⚠️ **R1-α 实测**：只编码 `scene`+`animation`+`assets`（清单）会让重开丢失
   资源内容（纹理字节 / 呈现参数 / 纹理序列）、文档元数据与帧轴
   —— 实测资源清单 62 条而 `resources === []`，**清单判据区分不出这次丢失**。
   ⇒ `ProjectRoundTripReport` 必须含 `documentContentPreserved`，且判据必须**逐项**
   钉住内容本体（`resources[*].payload` / `blend` / 纹理序列规格与 `frameAxis` 时长），
   只比"身份列表"（`assetId@contentVersion`）**不算**覆盖本判据。
3. **重开的顺序是语义的一部分**：`setDocument` → `seekFrame(0)` → `adoptDocument`
   （与装载脊柱同序）。反过来会让 GF-16 被清掉（`setDocument` 会 `markLoaded` 并清装配标记）。
4. **未知主版本显式拒绝**（`UnsupportedOperation`，**不**降级读取）；
   未知**顶层键**按**文档身份**承载（GF-14 口径）—— 不进核心负载、也不静默丢弃。
5. **字段映射属边界**：内核 `ContentResource.ref` → 文件 `ProjectAssetRef`
   （`{assetId, contentVersion, url}` → `{assetId, contentVersion, locator}`）
   在 `adapters/projectFile` 内完成。装配层**不得**知道文件格式的字段名
   （否则"外部文件只在边界编解码"就破了）。


---

## 3. `CommandOutcome` 与错误分类

### 3.1 `CommandOutcome`

```ts
type CommandOutcome =
  | { status: 'applied';   version: Version; changes: ChangeSummary }
  | { status: 'unchanged'; version: Version }
  | { status: 'rejected';  error: DomainError }
```

**必须成立**
- 三分支**互斥且穷尽**。拒绝**不得**同时报告 `applied`
  （#249 §5 明文："不能拒绝后仍报告 applied"）。
- **不能用默认值掩盖缺失**（#249 §5 明文）：目标不存在时返回 `MissingTarget`，
  不是"用默认值"当成功。
- `unchanged` 必须**保持未改分支的身份**（结构共享），但不因"创建了新容器"就判 `applied`
  （#249 §5 明文）。

### 3.2 错误分类（八项，冻结）

```ts
type DomainError =
  | InvalidValueError        // InvalidValue
  | ReadOnlyError            // ReadOnly
  | MissingTargetError       // MissingTarget
  | StaleReferenceError      // StaleReference
  | DocumentBusyError        // DocumentBusy
  | VersionConflictError     // VersionConflict
  | UnsupportedOperationError// UnsupportedOperation
  | WouldBlockError          // WouldBlock

interface ErrorBase {
  code: DomainErrorCode      // 稳定错误码（不随语言变化，§19.7）
  /** 结构化参数（供 UI 本地化与诊断关联），不是拼好的自然语言 */
  params: Readonly<Record<string, string | number>>
  /** 诊断关联身份（#249 §19.9） */
  commandId?: string
  jobId?: string
  objectId?: string
  version?: Version
}
```

| 码 | 语义（**冻结**） | 触发条件 | 严禁的替代做法 |
|---|---|---|---|
| `InvalidValue` | 值本身不合法 | 越界、枚举非法、类型不符、多通道耦合约束失败 | 悄悄夹取并宣称目标已实现（§7 明文禁止） |
| `ReadOnly` | 目标存在但本上下文无写权 | 多方块生成物、只读核心、轨道驱动的属性被普通写 | 用「静默忽略」当成功；或用文档级单一布尔代替按拥有者判定（§3.3） |
| `MissingTarget` | 目标不存在 | 对象/属性/元素已不在文档中 | 用默认值冒充成功（§5 明文） |
| `StaleReference` | 引用存在但版本已过期 | `topologyVersion` 变化、内容版本不匹配 | 静默猜配到"同名对象"或"相同坐标的新对象"（§19.2 明文禁止） |
| `DocumentBusy` | 同文档已被另一上下文持有修改租约 | 跨工作区同时修改 | 静默排队等未来场景（§3.4 明文） |
| `VersionConflict` | 提交所依据的版本已不是当前版本 | 起点版本校验失败、保存竞态 | 越序应用；或仅忽略旧响应而让旧请求最后覆盖远端（A16 负对照） |
| `UnsupportedOperation` | 能力不存在于本 profile/构建 | 查看器构建收到内容编辑命令、未实现特性 | 只隐藏按钮但仍导入编辑模块（A15 负对照）；假成功控件 |
| `WouldBlock` | 现在不能执行，但条件可能变化 | 执行器忙、发布订阅中重入、不兼容前序排队命令 | 阻塞等待；或越序执行（§5 明文） |

**必须成立（A08 / A23 / A15 相关）**
- 错误码**稳定**，不因语言改变而改变命令逻辑或测试断言（#249 §19.7 明文）。
- `UnsupportedOperation` 与"模块被裁剪"必须可由**运行时**拒绝，不只靠 UI 隐藏按钮。
  - 依据 #249 A15 负对照："只隐藏按钮仍导入编辑模块"必须判红。
- **负对照**：把 `ReadOnly` 退化成一个文档级布尔（#249 §3.3："不使用整份文档一个布尔值粗略代替"）
  ⇒ 同文档内"可编辑对象 + 只读多方块"共存时，可编辑对象必须仍可写。

**选择理由（为什么恰好八个）**：#249 §5 用"至少包括"冻结了这八个。本契约**不增不减**：
- 不再增：新增错误码会让 P1–P11 各自发明"本地错误"再映射，破坏"错误码稳定"；
- 不再减：每一个都对应一条已批准的验收负对照，删掉即失去该负对照的落点。
- `ReentrantCall` 在 #249 §5 与 `WouldBlock` 并列提及，但未列入"至少包括"清单。
  **本契约的处理**：不作为第九个顶层码，而作为 `WouldBlockError.params.reason`
  的一个取值（`'reentrant'`）。理由：重入与忙是**同一恢复策略**（下一批次重试），
  分成两个码会让调用方的重试分支重复；同时保留 `reason` 以支撑 A03 的精确断言。
  **这是一处需要 P1 确认的取舍，登记于 §8 缺口 GF-1。**

### 3.3 多选原子性

**必须成立**
- 多选属性修改是**一个原子批次**；默认一个目标不可改即**整体拒绝**并列明原因，
  **不静默部分成功**（#249 §5 明文）。
- 负对照：让 3 个目标中的 1 个成功、2 个失败但仍返回 `applied'。

---

## 4. `EvaluationKey` —— 求值缓存身份

```ts
type EvaluationKey = Readonly<{
  documentVersion: number
  scene: SceneId
  time: TimeValue
  parameterVersion: number       // 通道取值/动画参数版本
  stagedTransactionVersion?: number  // 活动编辑事务的暂存版本
  contentResourceVersions: Readonly<Record<AssetId, string>>  // 内容资源版本/哈希
  /** 视图投影键：只影响机位/局部显示，不影响结构 */
  viewProjection?: Readonly<{ camera: string; localDisplay: string }>
}>
```

**必须成立（A11 `evaluation-invalidation`）**
- 至少区分：#249 §7 明列的六项 —— 文档版本、场景、时间、参数版本、
  暂存事务版本、内容资源版本。
- **摄像机/局部显示若不影响结构，只进入 `viewProjection`**，避免机位变化使几何重算。
  - 依据 #249 §7 明文。
  - 负对照：A11 要求"只改注解描述、机位、一个几何数据"三者中，
    **前两者方块几何重建数必须为 0**。把机位混进主键会使其重建数 > 0，判红。
- **失效自动传播**：依赖图根据版本化输入和查询/节点依赖失效，**不要求**属性声明附带
  `refreshViewport()` 回调（#249 §6 明文；A11 负对照"无调用方手动 refresh"）。
- **动态集合依赖必须包含集合成员变化**，不能只跟踪现存成员（#249 §7 明文）。
- **过期结果不得覆盖新结果**；已获取资源必须回收（#249 §7 明文；A12 负对照
  "无版本检查接纳旧结果"）。
- 路径：资源**URL 仅为获取位置**，缓存必须按**内容身份/版本**而非 URL
  （#249 §19.3 明文；A28 负对照"按 URL 而不按内容版本缓存"）。
- 时间来源的全部影响项必须进入键：场景时间、运行时间、资源版本、相位覆盖
  （#249 §7："所有影响输出的时间来源与参数进入相应求值键，不能只缓存场景时间"）。
- **无帧混合声明时权重恒为 0**（#249 §19.3 `TextureSample.mix` 注释 + A27
  负对照"默认淡入淡出"）。

**选择理由（为什么用扁平结构而不嵌套）**：缓存查找是热路径，且诊断需要按任一维度分组
（#249 §19.9"求值节点失效来源和耗时"）。扁平且每项可序列化的键让"哪个维度变了"
可以直接计算，无需遍历嵌套对象。

---

## 5. RNA —— 属性描述与唯一写路由

### 5.1 `PropertyDescriptor`（类型描述）

```ts
type PropertyDescriptor = Readonly<{
  id: PropertyId
  valueType: PropertyValueType      // 'number' | 'vec3' | 'quat' | 'string' | 'enum' | 'boolean' | 'color' | 'reference' | ...
  unit?: UnitSpec
  domain?: ValueDomain              // 合法域（范围/枚举/引用类型/多通道耦合约束）
  referenceType?: EntityOwnerKind
  animatable: boolean
  /** 基础显示说明：翻译键 + 单位 + 可选回退文字（§19.7） */
  display: Readonly<{ labelKey: string; fallback?: string; decimals?: number }>
}>
```

**必须成立**
- 描述包括：#249 §6 明列的"属性 ID、值类型、单位、合法域、引用类型、动画资格、基础显示说明"。
- 描述保留**翻译键**，不保留已翻译字符串（#249 §19.7："RNA 描述保留翻译键、单位及可选回退文字，
  实例呈现决定语言与格式"）。
- **RNA 不导入组件名**（#249 §6 明文）：控件注册与面板布局由
  `editors/` + `composition/` 贡献。⇒ `PropertyDescriptor` 里**不得**出现控件类型名。

### 5.2 唯一写路由

```ts
/** 通用属性写；仅适用于合法的属性写 */
type SetPropertyCommand = Readonly<{
  kind: 'setProperty'
  refs: readonly PropertyRef[]      // 多选 = 原子批次
  value: PropertyValue | 'mixed'    // 显式表达混合值，不用 null 兼表
}>

function applySetProperty(
  state: Readonly<ApplicationState>,
  command: SetPropertyCommand,
  env: Readonly<ExecutionInputs>,
): Transition
```

**必须成立（A08）**
- **不存在第二条属性写通路**：没有 JS Proxy 隐式截获赋值，没有 setter 旁路，
  没有暴露任意字段 patch 的通用命令。
  - 依据 #249 §6："不能通过暴露任意字段 patch 绕过跨属性不变量" +
    §1.1 已批准方向 12："不使用 JS Proxy 隐式截获赋值"。
  - 负对照：注册一个 Proxy setter 能够改属性值 ⇒ A08 必须判红。
- 通用 `SetProperty` **仅**适用于合法的属性写。移动多个对象、删除对象、插入关键帧等
  **保持具名命令**（#249 §6 明文）。
- **混合值**用显式判别（`'mixed'`），不用 `null` 兼表 —— `null` 兼表会使
  "值是 null"与"多选值不同"不可区分（#249 §19.3 对资源状态有同一要求：
  "null 同时代表加载中/缺失/失败"是 A36 负对照）。
- **有效值优先级**（#249 §7）必须在本函数内实现，且**编辑被轨道驱动的属性时默认显式拒绝普通基础值写入**
  ，要求使用关键帧命令或禁用轨道（A10 负对照："silently 写入不可见基础值"必须判红）。

**`Command` 联合的逐格/元数据具名写（R1-α 新增三员；GF-13 最小集全落地）**

```ts
type SetCellContentCommand = Readonly<{
  kind: 'setCellContent'
  contextId: string
  cells: readonly CellPosition[]           // 世界坐标键；行序翻转不进命令面
  content: CellContent | null              // null = 删键；{} = 有键无内容；两者可区分
  expectedVersion?: Version
}>

type MoveCellsCommand = Readonly<{
  kind: 'moveCells'
  contextId: string
  objectId: string                         // 在**哪个**网格里移动（身份写是逐帧字段）
  moves: readonly { from: CellPosition; to: CellPosition }[]
  expectedVersion?: Version
}>

type SetDocumentMetaCommand = Readonly<{
  kind: 'setDocumentMeta'
  contextId: string
  patch: Partial<DocumentMetadata>         // 具名字段；undefined = 不改（缺席 ≠ 置空）
  expectedVersion?: Version
}>
```

**必须成立**

1. **`moveCells` 的领域语义（R1-α 裁定，U-1 的落点）**：
   ① 移动的是**整格** —— `cells`/`cellContent`/`cellGeometry`/`cellPalette`/
   `cellPaletteIndex` **五项同键**一起迁移（消灭"平行网格下标必须对齐"这条无类型把守的约定）；
   ② 方块身份**随格迁移且不被重算** —— 命名空间经 `cellPalette` 的**条目内容键**原样保留，
   杜绝 GF-7 更正记录的历史事故（投影实测 68 条调色板里 66 条被写成 `minecraft:`）；
   ③ 目标是**替换**不是**交换**（swap 需另立具名命令：它是一条不同的不变量）；
   ④ 一次命令内多个移动是**同时**的（先快照全部源 → 写目标 → 删只作源的键），
   链式必须写两条命令 —— `moves` 是集合，命令内顺序不是它能表达的语义。
   ⚠️ **不得**由 `Grid.moveBlock(from, to)` 的既有签名决定本命令的形状。
2. **三态可区分**（与 §2.6 的 `domain/cellContent` 判据 3 同一口径）：
   `content: null`（删键）/ `{}`（有键、两类内容都缺席）/ `{ tooltip: '' }`（显式空说明）
   必须各自可表达、可往返。三者并成两者是 A36 类错误。
3. **`setDocumentMeta` 只接受具名字段**：`patch` 是 `Partial<DocumentMetadata>`，
   不是 `Record<string, unknown>`。未知 `meta` 键走 `adapters/files/fidelityRecord`
   （按**文档身份**承载；GF-14 口径）。若本命令接受任意键，
   "哪些字段真的没人懂"就永远查不出来（`domain/content` 文件头判据 3）。
4. **幂等**：三条命令同值/同态重写 ⇒ `unchanged`（不推进版本、不进历史）。
   判据用**内容级等价**（`domain/cellContent#sameCellContent` 的 `canonicalize` 比较，
   不是 `JSON.stringify` 键序比较，也不是 32 位摘要 —— 摘要碰撞会让一次真实写入被吞掉）。
5. **拒绝可归因**：重复格 ⇒ `InvalidValue{reason:'duplicateCells'}`；
   孤儿格 ⇒ `MissingTarget{objectId:'cell@x,y,z'}`；
   越界（声明尺寸之外）⇒ `InvalidValue{reason:'outsideDeclaredGrid'}`（**不**扩展尺寸：
   越界的目标格在文件格式里写不出来，静默丢弃会造出"命令 applied 但方块不见了"）；
   只读源 ⇒ `ReadOnly`；版本不符 ⇒ `VersionConflict`；空 patch ⇒ `InvalidValue{reason:'emptyMetadataPatch'}`。

### 5.3 纯函数签名（由执行器调用）

```ts
function reduceCommand(
  state: Readonly<ApplicationState>,
  command: Command,
  env: Readonly<ExecutionInputs>,
): Transition

function evaluateScene(
  source: SceneReadView,
  context: EvaluationContext,
): Result<EvaluatedScene>
```

**必须成立（A02 `pure-domain`）**
- **不改输入**、不读取全局时钟/随机数/DOM/Vue 状态/网络/可变单例，
  不隐式发事件、不记日志、不写文件（#249 §2.1 明文）。
- 需要时间、身份分配、能力、随机种子时，**作为输入或状态传入**（`ExecutionInputs`）。
- 允许函数内部使用**不逃逸的临时可变结构**（#249 §2.1 明文："纯不等于每一步都深复制"）。
- 负对照（#249 A02）：注入全局时间读取或输入写入必须判红。

---

## 6. 所有权表（#249 §3.4 落地）

**每项事实只有一个权威拥有者**（#249 §2.1）。本表逐行落地 §3.4，并补出**契约层面的可检查含义**。

| 状态 | 权威拥有者 | 共享与寿命 | 保存/历史 | 契约含义（可检查） |
|---|---|---|---|---|
| 文档内容、对象与数据、动画 | 文档状态域 | 随打开文档存活 | 工程保存、文档历史 | 只有文档状态域能推进 `documentVersion` |
| 历史与保存基线 | 文档状态域 | 同文档各工作区共用 | 基线运行期；历史默认不写工程 | 撤销栈与保存基线随**文档**而非工作区存活 |
| 选择、活动对象、时间、通道取值、活动工具 | `EditContext` | 同工作区默认共享 | 工作环境可恢复；**点选不记文档历史** | 单选**不得**产生历史条目（A06） |
| 活动交互、暂存改动 | `EditContext`，引用文档起点 | 同上下文所有 Area 可见 | 未提交不保存、不入历史 | 一次 `update` 不记历史；暂存须被**同上下文的两个视口**读到（A05） |
| Area 分割树、编辑器类型与固定目标 | `Workspace` | **组件卸载不销毁** | 独立工作环境存储 | 关闭 Area 后实例/监听/作业回基线，但保留状态**不靠隐藏组件存活**（A13） |
| 观察视角、局部显示 | 3D 编辑器实例 | 各实例独立、切回保留 | 工作环境存储 | 机位**不进** `EvaluationKey` 主键（§4） |
| 悬停、焦点、输入捕获 | 编辑器/交互状态域 | 指针与实例作用域 | 不保存、不记历史 | 同一事件不得启动两次模态操作（A22） |
| 求值场景、空间索引、统计 | 求值缓存 | 按求值键复用，**可丢弃** | 不保存为权威 | 派生索引可重建且**非权威**（#249 §15 第 4 条） |
| GPU 缓冲、纹理、DOM、Worker 句柄 | 适配器/呈现器 | 显式获取、引用计数或独占释放 | 不进模型 | 归属资源 acquire/release 平衡（A19） |

### 6.1 文档级修改租约

**必须成立**
- 多个工作区默认各有 `EditContext`，可绑定同一文档并看到提交结果；暂存交互**仅**在其所属上下文共享。
- 为避免多个上下文同时修改同一文档，采用**文档级修改租约**：其他上下文**仍可观察**，
  但修改返回 `DocumentBusy`，**不静默排队等待未来场景**（#249 §3.4 明文）。
- 可**显式**绑定同一 `EditContext` 进行联动。
- 切文档、切场景、撤销、替换发起操作的编辑器或启动另一修改操作时，
  **先明确取消当前交互再执行**；**不因**布局调尺寸或观察移动取消（#249 §8 明文）。
- 文档关闭也释放租约、取消归属作业。**资源加载回调不能重新激活已关闭的交互**（§8 明文）。
- 负对照：关闭文档后，迟到的资源加载回调重新激活交互 ⇒ 必须判红（A12/A30 相关）。

### 6.2 写权按拥有者/内容来源判断

**必须成立**
- 多方块生成对象**可查询和拾取**，但写能力为**只读**，不因通用对象模型而变得可编辑（#249 §3.3）。
- 若它与可编辑对象同文档出现，**写权按拥有者/内容来源判断**，不使用整份文档一个布尔值
  粗略代替（#249 §3.3 明文）。

---

## 7. 模块装配：`provides` / `requires` / `contributes`

```ts
interface ModuleDecl {
  id: ModuleId
  provides: readonly CapabilityId[]
  requires?: readonly CapabilityId[]
  contributes?: Readonly<{
    objectTypes?: readonly ObjectTypeContribution[]
    evaluationNodes?: readonly EvaluationNodeContribution[]
    commands?: readonly CommandContribution[]
    editors?: readonly EditorContribution[]
    controls?: readonly ControlContribution[]
    hostPorts?: readonly HostPortContribution[]
    shellLayouts?: readonly ShellLayoutContribution[]
  }>
  /** 必需能力缺失则启动失败；可选落点被裁剪并记录原因 */
  optionalRequires?: readonly CapabilityId[]
}
```

**必须成立（A14 `assembly-profiles`）**
- 装配解析检测：**重复 ID、循环依赖、缺失服务、非法落点、能力冲突**（#249 §10 明文）。
- **必需能力缺失则启动失败**；**可选落点被裁剪并记录原因**（#249 §10 明文）。
- **注册顺序不应产生隐藏覆盖结果**（#249 §10 明文）。
  ⇒ 解析结果对 `provides` 集合的输入顺序**不敏感**；冲突必须报错而非后者胜出。
  - 负对照：A14 要求"重复 ID、缺端口、循环依赖"判红。
- **模块角色不归并成万能服务定位器**（#249 §10 明文）：上表七类贡献**分别**贡献，
  不得合成一个 `services: Record<string, unknown>`。
- 应用 profile 本身可作为组合模块引用其他模块；**运行实例由解析结果创建**（#249 §10）。
- **功能模块不得反向依赖 profile 或宿主名**（#249 §4 规则 5）；
  **组件不得询问宿主名称**（#249 §10 明文）。
- 本次**静态装配为主**。未来热插件需要独立生命周期与版本契约，**本次不冒充已经支持**（#249 §10）。

**选择理由（为什么把贡献分成七类而非一个泛化注册表）**：#249 §4 规则 7 明确警告
"不能重新养出无归属 `shared` 仓库"，§2.3 禁止万能 `Manager`/`Context`。
七类分别对应七种**生命周期与所有权不同**的东西（对象类型持久进文档；宿主端口实现不进模型；
外壳布局进工作环境存储 —— 见 §6 表）。合成一个注册表就等于放弃所有权表。

### 7.1 导入规则（边界检查的执行面）

以下为 #249 §4 的导入规则，**由 `web/tests/architecture/` 的 AST 扫描设施检查**
（见 §7.2）：

1. `domain` 不依赖其他上述层；跨领域依赖必须**单向**，跨域编排**上移** `application`。
2. `application` 仅依赖领域与自身契约，**不依赖** Vue/Three/DOM/运行实例实现。
   跨业务不变量在这里纯组合，**不进入** `runtime`。
3. `runtime` 调用纯函数、提供执行能力；`editors` 经**公开客户端接口**接入，不获取私有状态。
   `presentation` 只消费求值契约及渲染参数。
4. `adapters` 实现端口，格式解码也可使用自身纯辅助函数；**不得在格式映射时夹带编辑业务规则**。
5. `composition/modules` 是装配根，可以引用实现并注册；功能模块不得反向依赖 profile 或宿主名。
6. **类型导入同样计入边界检查**。禁止经 **barrel 转出口**偷偷跨层；**Vue/Three 类型也不得泄入纯核心**。
7. 可通用的数学工具仅在出现**真实复用后**提取到具名模块，不能重新养出无归属 `shared` 仓库。

**必须成立（A01 `architecture-boundaries`）**
- 枚举生产 import/export 图；`domain`/`application` 无 Vue/Three/DOM/IO/runtime 实现依赖；
  无私有跨模块导入。
- **负对照**：注入**一条违规类型导入**（`import type { Ref } from 'vue'` 进入 `domain/`）
  也**必须失败**。

### 7.2 边界扫描设施与空洞真

设施位置：`web/tests/architecture/`
（`module-graph.mjs` AST 抽取 · `boundary-rules.mjs` 判据 · `scan-boundaries.mjs` 入口）。

**本批（P0）的诚实状态**：#249 §4 明确"目录是目标职责分区，**不意味着本轮创建空目录**"，
故 `domain/`、`application/` 等新分层**尚不存在**，闸门规则的执行面为 0 ——
其"绿"是**空洞真**，不构成"边界已生效"的证据。扫描器**必须显式报告**该状态
（`vacuous: true` + 摘要说明），不得冒充通过（#251「未实现的测试名称不得报告通过」）。

另一处必须显式说清的陷阱：`web/src/runtime/` **当前已存在但是旧实现**
（`renderEngine.ts`/`sessionStore.ts`/`chromeBinder.ts`，见 #249 §17 抽查点），
`presentation/` 对应旧 `render/`+`shared/`，`editors/` 对应旧 `workbench/`。
⇒ **不得**用"目录存在"推断"新层已建成"；扫描器以 `LAYER_DESTINATIONS.legacySources`
排除该情形（详见 `boundary-rules.mjs` 文件头）。

---

### 7.3 目录骨架与公共出口规则（本批确立）

**建目录纪律**：#249 §4「目录是目标职责分区，不意味着本轮创建空目录」。
⇒ **只在本批（或本批次）有真实消费者时创建目录与文件**；禁止为"占位"建空目录或空接口
（#249 §13：「不允许暴露会假成功的按钮或空接口」）。本批（P0）因此**只新建**：

| 新建路径 | 本批的消费者 |
|---|---|
| `docs/contracts/web-kernel-contracts.md` | 本文件；P1–P11 的契约来源 |
| `web/tests/architecture/` | A01 设施本体 + 负对照（本批交付） |
| `web/scripts/run-e2e-tree.mjs` | e2e 端口隔离入口（本批交付） |
| `web/e2e/{tree-identity.ts,global-setup.ts}` | 服务身份核验（本批交付） |

**公共出口规则**（适用于 P1 之后的所有新分层）：

1. **每层有且只有明确出口**。层的公共出口是该层目录根下的具名模块
   （`domain/scene.ts`、`application/commands.ts`），**不是**一个 `index.ts` 通配 barrel。
   - 依据 #249 §4：「各模块只从明确的公共出口被引用，禁止消费者跨目录导入私有实现」
     + 规则 6「禁止经 barrel 转出口偷偷跨层」。
   - 选择理由：`index.ts` 通配转出口会把"层内哪些实现是公共的"这个问题从代码结构里抹掉，
     使边界扫描退化为"检查某个巨大的 re-export 列表"—— 这正是 #249 §15 要退役的
     「UI getter/setter/Proxy/owner 绑定分派」那类中心化分派的同构问题。
2. **最大公共出口深度 = 2**（`domain/scene.ts`）。更深路径
   （`domain/scene/internal/x.ts`）视为私有实现，跨层导入判红。
   - 由 `web/tests/architecture/boundary-rules.mjs` 的 `MAX_PUBLIC_EXPORT_DEPTH` 执行。
3. **类型导入计入**（规则 6）。`import type` 不得用来绕过边界。
4. **层不得反向依赖**：`domain` 不依赖任何其他层；`application` 只依赖 `domain` 与自身契约；
   功能模块不依赖 profile 或宿主名（规则 1/2/5）。
5. **新增公共出口需登记**：若确需一个转出口，登记进
   `web/tests/architecture/boundary-rules.mjs` 的 `APPROVED_BARRELS`（含理由），
   同 PR 修改 —— 不登记即判红。本批 `APPROVED_BARRELS` **为空**。

**为什么本批不预先建层目录**：预先建 `domain/`…`entries/` 会立刻制造两个问题 ——
(a) 闸门扫描从"空洞真"变成"看着有内容"，而内容其实是空目录，制造假绿；
(b) 迫使 P1 在接管目录所有权前就要处理"目录已存在但归属未定"的冲突
（#250「共享瓶颈文件…由 P0/P1/P11 按阶段拥有」）。
故本批只交付**规则与设施**，层目录由各自负责批次在其批次内创建。

---

## 8. 契约缺口处理流程（**冻结**）

**原则：回父立项修订，不静默改。**（#250「契约先行…契约变更须回本单说明理由并获确认，不静默修改」；
#251 B3「后续批次发现缺口的处理流程写明（回父立项修订）」）

P1–P11 执行者遇到本文件未覆盖或无法满足之处，按下列步骤处理 ——
**不得**在自己批次内私自扩展契约：

1. **就地记录，不就地实现**。在批次交付说明里登记缺口，格式：
   `GF-<n>`（全局序号）· 发现批次 · 契约条目（章节号）· 现象 · 影响面 ·
   建议处置（补契约 / 改契约 / 标记为不实现）。
2. **在 Gitea 父立项
   [#385](http://127.0.0.1:3300/Lightning/lightning/issues/385)
   追加评论**，写明上列字段与最小复现（若有）。这是**唯一**的裁决入口。
   - ⚠️ **R1-α（v1.7）变更**：本条的入口原为 [#250](http://127.0.0.1:3300/Lightning/lightning/issues/250)。
     依 **#385 评论 6910**（GF 缺口裁决入口自 #250 迁至 #385），本文件自 v1.7 起
     裁决入口是 **#385**；#250 保留为历史证据层（旧 GF 的裁决评论仍在其中，只读引用）。
   - ⚠️ **禁止「先删登记后删旧机制」**（#385 评论 6930 的机械判据）：删除登记必须与
     删除机制**同一提交**，并在提交信息里给出**全量命中数**。登记滞后于代码
     （机制还在而登记已说"已兑现"）**同样**是违规 —— R1-α 同批更正了三处此类滞后。
3. **不阻塞其它工作**：缺口若只影响本批次某条验收，**该条报"未通过"并注明缺口编号**，
   其余条目照常交付。**不得**为让判据变绿而自行放宽或用近似实现顶替
   （#251「验收未满足不得修改判据或省略字段报绿」）。
4. **裁决后同 PR 改本文件**：获得确认后，修改本文件 + 实现 + 受影响的验收断言，
   **同一提交**完成；在文件头 `## 修订记录` 追加一行（版本、日期、条目、依据）。
5. **裁决前任何实现都不得依赖未冻结语义**：若必须临时占位，
   以 `UnsupportedOperation` 显式拒绝，**不**用"看起来能跑"的近似语义。

**已登记缺口**（本批发现，待 #250 裁决）：

| 编号 | 发现批次 | 条目 | 现象 | 建议处置 |
|---|---|---|---|---|
| GF-1 | P0 (#251) | §3.2 错误分类 | #249 §5 在正文并列提及 `WouldBlock`/`ReentrantCall`，但"至少包括"清单只有八个码 | 采纳本契取舍：`ReentrantCall` 作为 `WouldBlockError.params.reason='reentrant'`；请 P1 确认或改回第九码 |
| GF-2 | P0 (#251) | §7 `ModuleDecl` | #249 §10 只说"provides/requires/contributes"，未给 `contributes` 的子类清单 | 本契约按 §10 段落列举出七类；若 P8/P9 需要第八类，回 #250 补 |
| GF-3 | P0 (#251) | §4 `EvaluationKey` | #249 §7 说"至少区分"六项但未给字段名与类型 | 本契约命名之；`time` 的 `TimeValue` 表示法（有理帧率）待 P4 落地时确认，若需改动条目结构回 #250 |
| GF-4 | P1 (#252) | §2 `EditorClient.read` | `read(scope): ReadView` 是非 `Result` 签名，`ReadScope` 指向不存在的文档/上下文时没有错误表达形态 | **裁决**：批准 P1 处置——`read()` 对缺失作用域**抛异常**（视为调用方缺陷，与业务拒绝的 `DomainError` 值形态区分），并以测试钉住；`Result` 形态保留给业务拒绝。**最终状态：已落地**（`web/src/runtime/execution.ts` 的 `Editor.read` 抛错路径）；**契约 §2.1 正文已同批补记该语义**（v1.5.1，P11-B3）—— 表与正文不再分叉（#250 comment 4866） |
| GF-5 | P2 (#253)（P1 就地登记时占用 GF-4 号，经裁决改号） | §2/§3/§5 属性写通路 | P1 已合入的 `application/commands.ts` 自建属性写面（`reduceSetProperty` + 内联白名单 + 自有 `PropertyValue`），与 P2 的 RNA 写路由同名并存于 `application/`；全树一度有**三处** `PropertyValue` 定义 | **裁决（方案 A，方案 B「双通路+桥」即 #171/#249 §2.1 禁止的门面，否决）**：P1 的 `reduceCommand`/`ApplicationState` 为唯一更新入口；属性语义（描述/handler/动态可编辑性/值类型/草稿解析）由 P2 的 RNA 注册表承担；删 P1 侧内联白名单与重复类型定义。五项冻结：限定式属性 ID / `owner.kind` 词汇以 §1.1 实体种类为准 / `WouldBlockReason` camelCase / `null` 写仅在描述符声明 `nullable` 时合法 / 多选整体拒绝 + 逐目标原因。**最终状态：已落地**（P2 批内收敛，HEAD `99a7d3a`；PR #267 合流 `96b2e3b`）（#250 comment 4898、4899、4979、4984、4999） |
| GF-6 | P9 (#260) | §7.3 公共出口最大深度 2 | 「公共出口最大深度 2」是否作用于测试目录未明；职责子目录（`application/export/`、`application/recovery/`）是否为违规 | **裁决**：批准澄清——深度约束只作用于**生产模块**；测试可位于 `<出口>/__tests__/` 不计深度。理由：职责子目录是 #249 §4 目录表的明文结构，深度规则的意图是防「钻进私有实现」，不是压平职责分区。**最终状态：已落地**（`web/tests/architecture/boundary-rules.mjs:226` 遍历时跳过 `__tests__`，`MAX_PUBLIC_EXPORT_DEPTH` 只计生产路径）（#250 comment 5111） |
| GF-7 | P10b (#282)（就地编号 GF-4 撞号后改号） | blockGrid 单元格编码（适配层§7 外部格式边界） | 旧格式 `blockGrid` 的单元格键/值编码无契约口径 | **裁决**：批准适配层口径——键 `"x,y,z"`、值 `minecraft:<name>:<meta>`（与生产 `BlockRef.block_state_id` 同源）。**后续更正（D2 裁决）**：`kernelProjection.ts:276` 用 `minecraft:${name}` 拼接会**丢命名空间**（而 `typed` 手里有真 registryId）⇒ 判据夹具输入改 `plainRootOf(raw)`（与生产同口径），已修。**最终状态：已落地**（`web/src/domain/cellPosition.ts:56` 的 `cellContentKeyOf` = `cellPositionKey`，键与 `cells` 同一套）（#250 comment 5443、6125） |
| GF-8 | P10b (#282)（就地编号 GF-5 撞号后改号） | `meta.embed_initial_view` 归属 | 旧格式 `meta.embed_initial_view`（yaw/elevation/distance）应归文档还是宿主/编辑器实例未定 | **裁决**：批准——它是**观察视角**，归 3D 编辑器实例/宿主初始视图状态，**不**伪造进文档 camera 投影参数（#249 §3.4 边界）。**最终状态：已按裁决保持**（`web/src/context/embedInitialView.ts` + `context/captureEmbedInitialView.ts`）；仍经 `legacyDocumentModel()` 取本体原地写，该双击轨已登记为 `legacy-document-in-place-edit`（`composition/seams.ts`，owner P11/#262）（#250 comment 5443） |
| GF-9 | P10b (#282)（就地编号 GF-6 撞号后改号） | 适配器资源身份（旧格式无稳定资源 ID） | 旧格式没有稳定资源 ID ⇒ 装配 `assetId` 与内容版本载体无命名口径 | **裁决**：批准适配器赋名——`material:<下标>` 为装配 assetId、`legacy:<locator>` 为内容版本载体，推导规则写入适配器注释；新格式工程（P9 `ProjectPayload`）必须有真稳定 ID。**最终状态：已落地**（`web/src/render/materials/kernelTextureResources.ts:192` 的 `MATERIAL_ID_PREFIX = 'material:'`；`adapters/files/projectFormat.ts` 的 `ProjectAssetRef` 以 `assetId`+`contentVersion` 参与身份、`locator` 不参与）（#250 comment 5443） |
| GF-10 | —（**编号空缺**） | — | 无缺口登记 | **处置：登记为编号空缺，不引入空洞条目**。机械证据（2026-10-13 实测）：#250 全 **69** 条评论全文扫描 `GF-10` **零命中**（`GF-9` 之后直接进入 `GF-11`）；#251–#262、#286、#289、#299、#301 的评论亦零命中 ⇒ 该号**从未被分配**，非回填遗漏（#262 P11-B2） |
| GF-11 | P10d (#289) | `ObjectDataPayload` 类型化内容面 | 内核 `ObjectDataPayload` 的内容面不足以承载旧文档内容（几何/部件/逐格说明/注解），需扩展类型化变体 | **裁决**：批准 P10d 的落地形态——`cellContent`/`geometry`/`cellGeometry`/`cellPalette`/`AnnotationGeometry`。**最终状态：已落地**（`web/src/domain/scene.ts:169` 的 `ObjectDataPayload` 联合 + `AnnotationGeometry`；P10d #289 合流 `fe847d0`）（#250 comment 5583） |
| GF-12 | P10d (#289) | 多方块声明的类型化承载面 | 多方块声明缺类型化承载；`MultiblockContent.source` 以原始 JSON 回显冒充承载 | **裁决**：批准 `multiblockDocument` + `KernelTypedDeclaration`（逐元素编码规则）；`MultiblockContent.source` 原始 JSON 回显**已退役**。**最终状态：已落地**（`web/src/composition/kernelProjection.ts:649` 的 `KernelTypedDeclaration` + `:672` 的 `declaration` 主来源；P10d 合流 `fe847d0`）（#250 comment 5583） |
| GF-13 | 登记 P10e (#299) / 执行 P10f (#301) | §2/§3 `Command` 封闭联合 + 网格读面 | 内核 `Command` 联合**无**块身份/格内容写命令（`setCellTooltip` 只写说明）、无网格读面 ⇒ 113 处 `getDoc()` 消费中 75 处（66%）无法机械替换，硬迁只能造门面 | **裁决（R-WK-07）**：授权扩展 `Command` 封闭联合（子批 C 最小集 `setCellTooltip`/`setCellContent`/`moveCells`/`setDocumentMeta` + 注解字段映射）与网格读面扩展（子批 B）；契约须同批更新。**最终状态（v1.7 / R1-α `6fa0ea75` 实测）：最小集四条**全部落地**——① 网格读面**已落地**，兑现形态是 `Context#kernelGrid` → `runtime/gridRead`（**非** `ReadView` 加 grid 组；落点与业务理由见 §2.6）；② `setCellTooltip` 已落地（P10f D0）；③ `setCellContent`/`moveCells`/`setDocumentMeta` **R1-α 落地**（`application/commands.ts`，联合 **24 → 27**；领域语义（含 `moveCells` 的 U-1 裁定）见 §5.2）；④ 注解字段映射的**写面**仍未兑现（只迁 `title`）⇒ 三条相关接缝仍在 `composition/seams.ts` 登记（`property-write-legacy-document-model`/`legacy-grid-edit-handle`/`legacy-document-in-place-edit`）——其中前两条的**能力前置已消除**，只剩**消费者迁移**（各 `exitCondition` 已按"登记条件 + 消费者迁移数=0"两子句改写）（#250 comment 5699、5605、5731、5773、5844、5861、5880、5987、6015；#385） |
| GF-14 | P10f (#301) | G-6 (b) 持久化键口径 | 保真记录的键是**游离方案**（`lk.fidelity.v1.<文档ID>.record`）：缺 scope/instance 段、返回裸 `string`、无解析器、版本硬编码、空 id 静默回落、不被分类器识别 | **裁决**：未知字段按**文档身份**承载；键并入 recovery/save 家族，消除裸 `string` 与空 id 静默回落。**最终状态：已落地，但口径与登记文有差（如实登记）**——实测 `web/src/application/recovery.ts` 的 `fidelityStoreKey(identity, documentId)` = `lightning.recovery.fidelity.v1.<scope>.<instanceId>.<documentId>`（**6 段、含 instance 段**），并有 `parseFidelityStoreKey` + `artifactKindOfKey` 识别、版本取具名 `FIDELITY_SCHEMA_VERSION`；**文档身份在末段**（与裁决一致），但登记文写的「走 `saveStoreKey` 形态、**无 instance 段**」与代码现实**不一致**（代码取与 `recoveryStoreKey` 同形的 6 段）⇒ 以代码为准（#250 comment 5699、6263） |
| GF-15 | P10f (#301) | §2.3 文档装载状态 | 内核 `document()` 恒 defined（`openDocument` 无条件建文档）⇒ 「空文档」与「无文档」不可区分；而 legacy `getDoc().value` 6 处可为 null | 新增 `KernelSession.hasLoadedDocument()` 读面 + `Context.setDocument` 唯一写入口；本批只建读面并对齐，消费面替换归 B′ |
| GF-16 | P10f (#301) | §2.4 装配成功读面 | 「有文档」（GF-15）与「内核里的就是那份文档」（装配成功）是**两个**事实，而 D8 把两者当成了一件事：帧源守卫测"文档存在"（恒真）⇒ 装配失败时读到**空帧轴（0）**，而注释声称的 legacy 回落**从未生效** | 新增 `KernelSession.hasAdoptedContent()` + `Context.frameDeclarations()` 唯一读取面（判定在纯函数 `runtime/frameDeclarations`）；D8 同批修复，判据含**装配失败注入** |
| GF-17 | R1-α (#387) | §2.3 / §2.4 `Context` 的 legacy 回落分支与具名取值口 | R0-D②/D④ 实测：`Context` 上存在三条**返回旧 `RuntimeDocument`** 的具名读面（`legacyDocumentModel()`/`legacyRenderSource()`/`legacyGridForEdit()`）+ 两处**静默回落**（`documentLoad.ts:187-194` 装配失败仅 `warn` + `return false`；`context.ts:450-454` `plainForSave` 的 `source:'legacy'`）。它们**不是错误**（#171「能力不回退」），但"读者可观测"不等于"有退出阶段" | **登记（不就地实现）**：三条读面各在 `composition/seams.ts` 具名登记（`property-write-legacy-document-model`/`legacy-render-source-document`/`legacy-grid-edit-handle`，含**两子句**退出条件：登记条件 + 消费者迁移数=0）；两处静默回落由 §2.3/§2.4 的修正条文禁止**新增**，且已存在的两条按同上口径登记。裁决入口 #385 |
| GF-18 | R1-α (#387) | §2.5 共享存储上下文 | #249 §11 要求「格内容、对象附件、对象数据、注解**共享同一存储上下文**」，而内核 `ObjectDataPayload` 的变体表里**没有**"对象附件"这一类 —— 今天的等价物是旧文档根级 `itemIndex`/`partIconTextures`/`statsTemplate`，**不在**内核 `DocumentContent` 里 | **登记为缺口（R1-α 不就地实现）**：`application/writeFaces#sharedStorageContextReport()` 的 `objectAttachments` 恒 `false`、`allShared` 恒 `false`（缺口**可见**，不以"扫描无命中"报绿）。承接：**R2**（多方块/部件面）。裁决入口 #385 |

> **回填说明（#262 P11-B2，2026-10-13，基线 `49792e3`）**：GF-4…GF-14 已按 #250 裁决回填本表（10 条裁决 + 1 条编号空缺登记，逐条注明来源评论 id 与最终状态）。其中 **GF-10 为编号空缺**（机械证据见该行）。GF-13/GF-14 的最终落点已按 `web/src/` 实测核对，与登记文不一致处如实登记于对应行。

---

## 9. 性能预算（标定登记，P11-C）

> #249 §14：「未标定的性能预算不得报告通过」。本节是**标定的登记点**：
> 数字是**测量结果**，不是判据；**不进入任何退出码**（Lead 裁决 #262 comment 6678）。

### 9.1 口径（D5 用户裁决）

标定 = **本机 + Playwright 锁定浏览器**（版本随 `package-lock.json` 钉死）。
每条读数登记**三件套**：机器 + 浏览器版本 + 日期；**不冒充跨环境常数**。

- 标定表全文：Gitea **#262 附件 2056**（`1ffa63b2-p11c-calibration-table.md`，基线提交 `1ffa63b2`）；
- 三件套：Ryzen 9 7945HX ×32 / 31.7 GiB / Win11 26200 · Chromium 148.0.7778.96（Playwright 1.60.0，修订 1223）· GPU 硬件后端（ANGLE/D3D11，RTX 4070 Laptop）· 2026-10-12/13 安静窗口；
- 夹具生成器入树可复算：`web/tests/perf/fixtures/generate.mjs`（S/M/L 三档，同提交重复生成 sha256 逐字节一致实测）；浏览器侧设施 `web/tests/perf/e2e/`（专用 `playwright.perf.config.ts`，与常规收集面隔离）。

### 9.2 建议预算线（软告警口径）

安全系数**由实测漂移推出**（纯函数侧最大多轮中位漂移 ×1.97 ⇒ ×3；浏览器侧 ×3.00 ⇒ ×4.5；
初稿 ×2.0 被否决——那会压在噪声包络之下，硬登记等于必然假红）。

| 标定点（L 档 = 102825 实格） | 实测 median | 建议预算线 | 口径 |
|---|---|---|---|
| `load.adopt`（装载脊柱全集，纯） | 1716 ms | **5148 ms** | 超线软告警 |
| `load.total`（浏览器，硬件 GPU） | 1893 ms | **8518 ms** | 超线软告警 |
| `frame.rafGap`（RAF 间隔） | 16.70 ms | **75.15 ms** | 超线软告警 |

⚠️ 浏览器 `performance.now()` 有 0.1 ms 量化 ⇒ **< 0.1 ms 的浏览器读数不得设预算线**。
分层口径下唯一硬判据仍是 **L2 墙钟预算**（#332）；本表只登记、只告警。

### 9.3 未覆盖轴（如实登记，**不得记通过**）

B2 §4.1/§4.2/§4.5/§4.6 与注解/多方块/纹理序列规模轴**未标定**（§4.5 十段分段计时需生产仪表化，
超出"标定不改产品"边界，归后续批次）；B2 §3.2 的 L 档「≈40 MB」是定义期估计（实测 0.63 MB），
以实测为准、历史数字不回改。逐条清单见标定表 §7。

---

## 10. 修订记录

| 版本 | 日期 | 条目 | 依据 |
|---|---|---|---|
| v1 | 2026-10-10 | 首次冻结：`PropertyRef`/`EditorClient`/`CommandOutcome`/八项错误分类/`EvaluationKey`/模块声明/所有权表/缺口流程 | #249 §3–§7 §10 §14 §19；#250；#251 B3 |
| v1.1 | 2026-10-12 | 新增 §2.3 文档装载状态读面（GF-15）：`KernelSession.hasLoadedDocument()` + `Context.setDocument` 唯一写入口 + 状态迁移表 + 与 `closeDocument` 的关系 | #250 comment 5731（R-WK-08 重切）；#301（P10f A′） |
| v1.2 | 2026-10-12 | §2.3 补 `Context.hasLoadedDocument()` 消费入口（唯一写者不变量的机械证据）；登记 N1 29 处已替换、N3/N6 未做的机械理由 | #250 comment 5775（B′ 四项裁决）；#301（P10f B′） |
| v1.3 | 2026-10-12 | 新增 §2.4 装配成功读面（GF-16）：`hasAdoptedContent()` + `frameDeclarations()` 唯一读取面 + 三种通知信号的不可互换表 + D8 修复的注入判据要求 | #250 comment 5861（R-WK-09 四项裁决）；#301（P10f C′1） |
| v1.4 | 2026-10-12 | §2.4 补侧表读面（`kernelAnnotations`/`kernelMaterials`）的对称分流与 8 条"必须成立"；**更正 v1.3 的第 1 条**（`markLoaded` 必须清 GF-16，第一版写反了） | #250 comment 5880（N4 采 (a)）；#301（P10f C′1 尾段） |
| v1.5 | 2026-10-13 | §8 缺口登记表**回填 GF-4…GF-14**（10 条裁决 + GF-10 编号空缺登记，共 11 行），逐条注明来源评论 id 与最终状态（已落地→文件/读面，或如实登记与代码现实的差异）；移除「GF-4…GF-14 未回填」维护备注（改为回填说明）；文档版本字样同步 v1.5 | #250 评论 4866、4898、4899、4979、4984、4999、5111、5443、5583、5605、5699、5731、6125、6263；#262（P11-B2） |
| v1.5.1 | 2026-10-13 | **引用更正**：文件头「退役归属见 #251 B5 附件」是**事实性错误**（#251 的旧 B5 附件 id 984 已删除，镜像 v3 挂在 #250 的 asset id 1008）⇒ 改为「#250 附件 asset 1008（v3）+ 终订镜像 #262 附件 1909」；**GF-4 正文补记**：§2.1「必须成立」补 `read()` 缺失作用域 ⇒ 抛异常（调用方缺陷）、与业务拒绝的 `DomainError` 值形态区分 + 负对照，并移除 GF-4 行尾的「⚠️ 契约 §2 正文未补记，以本表为准」注记（表与正文分叉消除） | #262 comment 6408②（Lead 裁决 2026-10-13，P11-B3） |
| v1.6 | 2026-10-13 | 新增 **§9 性能预算（标定登记）**：标定口径（D5）+ 建议预算线（软告警）+ 未覆盖轴登记；原 §9 修订记录顺延为 §10（§0 的交叉引用同步） | #262 comment 6669（P11-C 完工报）+ comment 6678（Lead 裁决①） |
| v1.7 | 2026-10-13 | **R1-α（#387）契约更新，四组**：① **§2.3/§2.4 修正**——`Context.setDocument` 的自描述从「写 legacy 文档**并镜像**内核装载状态」改为"权威是内核 `Document`，legacy 是渲染载体投影"，并**明令禁止**新增返回旧 `RuntimeDocument` 的具名读面（只减不增），两处静默回落改为必须登记；② **新增 §2.5 写面分类与共享存储上下文**（#249 §11 落地：四条写面 + `mayFork` 全 `false` + 共享上下文的"能力存在"判据形态）；③ **新增 §2.6 网格读面落点**（`runtime/gridRead` + 统一存储上下文，附三条业务理由；明确 `KernelSession.gridOf` 不再是权威读面）与 **§2.7 工程格式生产入口**（两入口一权威 / 内容本体必须进负载 / 重开顺序 / 未知版本拒绝）；④ **§5.2 补 `Command` 联合三员**（`setCellContent`/`moveCells`/`setDocumentMeta`）+ `moveCells` 的领域裁定（U-1）+ 三态可区分/幂等/拒绝码；⑤ **§8**：裁决入口自 #250 **迁至 #385**（含"禁止先删登记后删旧机制"），GF-13 **最终状态改为最小集四条全落地**，新增 **GF-17**（legacy 具名读面与静默回落的登记）与 **GF-18**（对象附件未类型化承载） | #385（立项/入口）、#387（R1 执行单）、#385 评论 6910（入口迁移）与 6930（禁止先删登记后删机制）、#386 附件 2300/2301（R0-D③④ 契约草案与裁决）、#250 R-WK-07（GF-13 授权）；实现提交 `6fa0ea75`/`75122922`/`cf9feda2` |

---

## 附：与 #249 章节的对照索引

| 本文件 | #249 出处 |
|---|---|
| §1 值类型 | §5（对象和属性引用是值）；§3.2（顶点身份） |
| §2 `EditorClient` | §5（核心 API 契约草案）；§2.1（权威） |
| §3 `CommandOutcome` + 错误分类 | §5（错误类型至少包括…）；§3.3（写权按拥有者） |
| §4 `EvaluationKey` | §7（EvaluationKey 至少区分…）；§19.3（纹理时间）；§19.4（导出时间映射） |
| §5 RNA + 唯一写路由 | §6（RNA、纯规则与 UI）；§7（有效值优先级） |
| §6 所有权表 | §3.4（所有权表）；§3.3；§8（租约与取消） |
| §7 模块装配 + 导入规则 | §10（Area、功能模块与装配）；§4（导入规则 1–7） |
| §8 缺口流程 | #250（契约先行）；#251 B3 |
| §7.2 扫描设施 | §14 A01；§14 测试维护要求；#251 B4 |
