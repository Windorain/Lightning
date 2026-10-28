# Web 编辑器内核契约

本文件定义 Web 编辑器内核的值类型与身份、读面、写面、所有权、命令结算与错误码。实现位于 `web/src/domain`、`web/src/application` 与 `web/src/runtime`。几何数学见[几何与坐标数学契约](web-kernel-geometry-contract.md)；场景与多方块格式见[场景文件格式契约](format-scene-file.md)与[多方块文档格式契约](format-multiblock-doc.md)。

## 1. 值类型与身份

对象与属性引用是值，不是裸对象指针。跨边界的引用必须可序列化、可比较，不含运行时句柄。

### 1.1 `EntityRef`

```ts
type EntityRef = Readonly<{
  kind: EntityOwnerKind
  id: string
  contentVersion?: number
}>
```

`EntityOwnerKind` 取 `document`、`scene`、`object`、`objectData`、`editContext`、`workspace`、`asset`、`evaluation`。

- `EntityRef` 不含对象实例、Vue ref、Three 对象或 DOM 节点。
- `id` 在文档生命周期内稳定；保存并重开后同一实体得到同一 `id`。
- `contentVersion` 用于判定引用是否过期；缺省表示不参与过期判定。
- `kind` 显式声明，不靠 `id` 前缀编码。

### 1.2 `ElementRef`

```ts
type ElementRef = Readonly<{
  elementId: string
  topologyVersion: number
}>
```

- 子元素寻址不得使用 GPU 索引或坐标。
- `topologyVersion` 改变后，过期的 `ElementRef` 的读/写返回 `StaleReference`，不静默匹配到同名或同位置元素。
- 顶点、边、面的标识由 `domain/geometry` 的 `VertexId` / `EdgeId` / `FaceId` 与 `elementRefOf` 构造。

### 1.3 `PropertyId` / `PropertyRef`

```ts
type PropertyId = string

type PropertyRef = Readonly<{
  owner: EntityRef
  property: PropertyId
  element?: ElementRef
  component?: number
}>
```

- `PropertyRef` 是可比较、可序列化的值，不含 setter 闭包。
- 同一 `PropertyRef` 在文档版本未变时，两次读取返回相等值。
- 多选场景中的一个 `PropertyRef` 表示一个目标；批量修改由命令承载，不把引用数组化。
- `component` 表示向量/四元数的分量下标，与标量属性共用同一寻址。

### 1.4 `Version` / `ChangeSummary`

```ts
type Version = Readonly<{
  documentVersion: number
  contentVersion?: number
}>

type ChangeSummary = Readonly<{
  changedProperties: readonly PropertyRef[]
  createdEntities: readonly EntityRef[]
  removedEntities: readonly EntityRef[]
  structurallyShared: boolean
}>
```

- `documentVersion` 只在内容变化时推进；播放动画、移动观察机位、选择对象、调整布局不推进。
- `contentVersion` 是内容身份摘要，可与保存基线比较相等；不能用单调提交计数代替。
- 仅创建新容器不等于内容变化。

### 1.5 位置、坐标与局部序号

身份由稳定标识与内容身份给出；位置编码不构成身份。

- **对象身份**：`EntityRef{kind, id}`。空间坐标、帧号、数组下标、GPU 批次序号都不得充当对象身份。
- **元素身份**：`ElementRef{elementId, topologyVersion}`。枚举顺序不产生元素身份。
- **局部序号**：`LocalOrdinal{batch, slot}` 是呈现侧的分批/绘制序号。取对象身份必须经 `GeometrySourceMap` 与 `resolveByOrdinal` 回表；局部序号不得出现在身份字段、拾取映射键、选择目标或动画轨道目标中。`buildGeometrySourceMap` 以 `Scene.order` 生成序号，反向索引只用于回表。
- **方块格身份**：`blockCellIdentityKey(data)` 只由 `registryId` 与 `blockStateId` 构成；格坐标是结构内的位置，不是对象身份。
- **材质身份**：由内容身份（locator 与内容版本）给出，不得使用调色板数组下标或 `帧号:槽号` 拼接。

## 2. 读面

### 2.1 读面清单

| 读面 | 回答 | 权威与回落 |
|---|---|---|
| `hasLoadedDocument()` | 是否存在已装载文档 | 内核在场读内核装载标记；内核缺席回落 `main.doc !== null` |
| `hasAdoptedContent()` | 内核是否承载当前文档的装配产物 | 仅内核；无内核为 `false` |
| `frameDeclarations()` | 帧数、每帧时长、每帧标签与来源 | 装配成功读内核帧轴，否则回落 legacy；两者都无为 `count: 0` |
| `documentMetadata()` | 名称、作者、描述、标签、原点、创建时间、格式版本、GTNH 版本与来源 | 装配成功读内核元数据，否则回落 legacy |
| `kernelAnnotations()` | 注解行 | 装配成功读内核，否则回落 legacy |
| `kernelMaterials()` | 材质行 | 装配成功读内核，否则回落 legacy |
| `cellTooltips()` | `tooltipPalette` 与 `cellTooltipGrid` 及来源 | 装配成功读内核，否则回落 legacy；`null` 表示两侧都没有这对字段 |
| `kernelGrid(frameIndex)` | 第 N 帧的网格视图 | 装配成功读内核 `blockGrid`；未装配用 legacy `Grid` 归一到同一形状；内核装配但该帧无网格时返回 `null`，不回落 |
| `kernelGridObjectId(frameIndex)` | 第 N 帧网格对象的 `objectId` | 装配面优先，否则按 `scene.order` 中 `blockGrid` 的出现序推导；未装配或该帧无网格返回 `null` |
| `plainForSave()` | 保存/导出用的 plain 与来源 | 仅内核投影；`plain === null` 时给出 `reason`（`no-session` / `not-adopted` / `unreadable`），不回落 legacy |
| `kernelSaveView()` | 保存投影 | 内核；失败给出结构化原因 |
| `kernelSourceRoot()` | 装配时解析器看到的源 plain 根 | 内核会话；`null` 表示未采集 |
| `kernelMultiblockBody()` | 多方块内层 body 承运 | 内核会话；`null` 表示无多方块声明或未装配 |
| `kernelMultiblockDeclaration()` | 多方块声明 | 内核 `content.multiblock`；`null` 表示无声明 |
| `kernelWriteAuthority(objectId)` | 对象写权 | 内核对象数据来源；未装配或无对象返回 `missing` |
| `kernelCellIdentityRef(frameIndex, pos, name, meta)` | 某格的调色板内容键 | 仅精确命中时返回文档中的真实命名空间；未装配、该格无方块或无相符条目返回 `null` |
| `documentSnapshot()` | 撤销快照令牌 | `RuntimeDocument` 载体的不透明令牌；`null` 表示当时无文档 |
| `restoreDocumentSnapshot(token)` | 回到快照 | 经 `setDocument` 唯一写入口；未知令牌抛错 |
| `frozenDocumentValue()` | 当前文档的冻结副本 | `RuntimeDocument` 载体；供替换式写路径，不作为保存基线 |
| `kernelUndoState()` | `canUndo` / `canRedo` / 标签 | 内核装配；未装配返回 `null` |
| `kernelDirty()` | 内容相对保存基线是否已变 | 内核装配；未装配返回 `null` |

读面只提供查询，不暴露内部 `ApplicationState`、Vue Ref、文档实例字段或渲染对象。

### 2.2 存在性与装配成功

`hasLoadedDocument()` 与 `hasAdoptedContent()` 回答两个不同问题：

```
setDocument(doc)      → 有文档 = true
adoptDocument         → 可能失败（内核不支持该形态）
  成功 ⇒ 已装配 = true
  失败 ⇒ 已装配 = false，但有文档仍为 true
```

- `markLoaded` 清装配成功标记：有文档不蕴含内核承载的就是它。
- `adoptDocument` 先 `markLoaded`，再 `markContentAdopted`。
- `markUnloaded` 同样清装配成功标记。
- 装配失败时读内核内容得到空文档；消费方据 `hasAdoptedContent()` 回落 legacy。

### 2.3 帧声明与时间轴

- `frameDeclarations()` 是帧数、时长与标签的唯一读取面；两个消费者读同一函数，读数不一致在结构上不可能发生。
- `count: 0` 是内核或 legacy 的真实声明；`null` 只出现在内部判定参数中，表示没有可用来源。
- 多方块文档的 `DocumentContent.frameAxis` 恒为空（`frameCount() === 0`），场景清单不进入时间轴；见[多方块文档格式契约](format-multiblock-doc.md) §5.3。

### 2.4 网格

`kernelGrid(frameIndex)` 返回只读网格视图（尺寸、格、部件、调色板条目、几何、逐格说明）。视图每次调用新建，不得在其上写入；写入走 `setCellTooltip`、`setCellContent`、`setCellIdentity`、`moveCells` 等命令。

`kernelGridObjectId(frameIndex)` 只回答网格对象的具名目标，不读内容；调用方不得自行拼 `structure:frame-<i>` 这类命名。

### 2.5 通知信号

| 信号 | 自增点 | 语义 | 区分 |
|---|---|---|---|
| `getDocumentRevision()` | 仅文档替换 | 换了一份文档（窄信号） | 只在换文档时变 |
| `getContentRefreshTick()` | 文档替换与内容重读请求 | 内容可能变了（宽信号） | 原地编辑也自增 |
| `hasLoadedDocument()` 的 `false → true` | `setDocument` 镜像 | 无文档到有文档（跃变） | 只在跃变时变化 |

三种信号不可互换。用宽信号替换窄信号会让原地编辑时机位跳回；单调计数器表达不出跃变。

## 3. 写面与所有权

### 3.1 写面

`WriteFace` 有四个取值：

| 写面 | 权威拥有者 | 共享文档上下文 | 进文档历史 | 推进 `documentVersion` | 进工程 | 进恢复副本 | 允许分叉 |
|---|---|---|---|---|---|---|---|
| `document-content` | 文档状态域 | 是 | 是 | 是 | 是 | 是 | 否 |
| `editor-session` | `EditContext` | 是 | 否 | 否 | 是 | 是 | 否 |
| `publish-default` | 文档状态域（`animation.publishedDefaults`） | 是 | 是 | 是 | 是 | 是 | 否 |
| `export-preview` | 求值缓存/适配器 | 否 | 否 | 否 | 否 | 否 | 否 |

- `writeFaceOf(command)` 按 `Command` 联合的 `kind` 穷举，每条命令恰好落一个写面；新增命令未分类会在编译期失败。
- `writeIsEffectOnly(command)` 为真当且仅当写面是 `export-preview`：该面不拥有事实，不要求独占文档写权。
- `export-preview` 只消费求值产物，可丢弃，不保存为权威。

### 3.2 所有权

| 状态 | 权威拥有者 | 共享与寿命 | 保存/历史 |
|---|---|---|---|
| 文档内容、对象与数据、动画 | 文档状态域 | 随打开文档存活 | 工程保存、文档历史 |
| 历史与保存基线 | 文档状态域 | 同文档各工作区共用 | 基线运行期；历史默认不写工程 |
| 选择、活动对象、时间、通道取值、活动工具 | `EditContext` | 同工作区默认共享 | 工作环境可恢复；点选不记文档历史 |
| 活动交互、暂存改动 | `EditContext`，引用文档起点 | 同上下文所有 Area 可见 | 未提交不保存、不入历史 |
| Area 分割树、编辑器类型与固定目标 | `Workspace` | 组件卸载不销毁 | 独立工作环境存储 |
| 观察视角、局部显示 | 3D 编辑器实例 | 各实例独立，切回保留 | 工作环境存储 |
| 悬停、焦点、输入捕获 | 编辑器/交互状态域 | 指针与实例作用域 | 不保存、不记历史 |
| 求值场景、空间索引、统计 | 求值缓存 | 按求值键复用，可丢弃 | 不保存为权威 |
| GPU 缓冲、纹理、DOM、Worker 句柄 | 适配器/呈现器 | 显式获取、引用计数或独占释放 | 不进模型 |

每项事实只有一个权威拥有者。

### 3.3 文档级修改租约

- 多个工作区默认各有 `EditContext`，可绑定同一文档并看到提交结果；暂存交互只在所属上下文共享。
- 同一文档同时只允许一个修改租约；其他上下文可观察，修改返回 `DocumentBusy`，不静默排队。
- 可显式绑定同一 `EditContext` 进行联动。
- 切文档、切场景、撤销、替换发起操作的编辑器或启动另一修改操作时，先取消当前交互再执行；布局调尺寸与观察移动不取消交互。
- 文档关闭释放租约并取消归属作业；资源加载回调不得重新激活已关闭的交互。

### 3.4 写权

- 多方块生成对象可查询、可拾取，但写权为只读。
- 写权按对象/内容来源判定：`ObjectData.source === 'content'` 为只读，其余可写。不使用整份文档一个布尔值。
- `kernelWriteAuthority(objectId)` 返回 `writable` / `readOnly` / `missing`；未装配或无对象不猜为可写。

## 4. 命令结算与错误码

### 4.1 `CommandOutcome`

```ts
type CommandOutcome =
  | { status: 'applied'; version: Version; changes: ChangeSummary }
  | { status: 'unchanged'; version: Version }
  | { status: 'rejected'; error: DomainError }
```

- 三分支互斥且穷尽；拒绝不同时报告 `applied`。
- 目标不存在返回 `MissingTarget`，不用默认值冒充成功。
- `unchanged` 保持未改分支的身份与结构共享，不因新建容器判为 `applied`。

### 4.2 错误码

```ts
type DomainErrorCode =
  | 'InvalidValue'
  | 'ReadOnly'
  | 'MissingTarget'
  | 'StaleReference'
  | 'DocumentBusy'
  | 'VersionConflict'
  | 'UnsupportedOperation'
  | 'WouldBlock'

interface DomainError {
  code: DomainErrorCode
  params: Readonly<Record<string, string | number>>
  commandId?: string
  jobId?: string
  objectId?: string
  version?: Version
}
```

| 码 | 语义 | 触发条件 | 禁止的替代做法 |
|---|---|---|---|
| `InvalidValue` | 值本身不合法 | 越界、枚举非法、类型不符、多通道耦合约束失败 | 悄悄夹取并宣称成功 |
| `ReadOnly` | 目标存在但本上下文无写权 | 生成内容、只读核心、轨道驱动的属性被普通写 | 静默忽略；或用文档级布尔代替按拥有者判定 |
| `MissingTarget` | 目标不存在 | 对象/属性/元素已不在文档中 | 用默认值冒充成功 |
| `StaleReference` | 引用存在但版本已过期 | `topologyVersion` 变化、内容版本不匹配 | 静默匹配同名对象或同坐标的新对象 |
| `DocumentBusy` | 同文档已被另一上下文持有修改租约 | 跨工作区同时修改 | 静默排队 |
| `VersionConflict` | 提交依据的版本已不是当前版本 | 起点版本校验失败、保存竞态 | 越序应用；让过期响应覆盖远端 |
| `UnsupportedOperation` | 能力不存在于当前 profile/构建 | 查看器收到编辑命令、未实现特性 | 只隐藏按钮但仍导入编辑模块；假成功控件 |
| `WouldBlock` | 现在不能执行，条件可能变化 | 执行器忙、发布订阅中重入、存在不兼容前序命令 | 阻塞等待；越序执行 |

错误码不随语言变化。`params` 是结构化参数，不是拼好的自然语言。`WouldBlock` 的 `reason` 取 `busy`、`reentrant` 或 `incompatibleQueued`；重入不另立第九码。

`UnsupportedOperation` 必须可由运行时拒绝，不能只靠界面隐藏。

### 4.3 多选原子性

- 多选属性修改是一个原子批次；一个目标不可改即整体拒绝，并列明原因。
- 不静默部分成功：不允许 3 个目标中 1 个成功、2 个失败却返回 `applied`。
