/**
 * 外部真实夹具解析（GG 试点 + TESR 捕获占位 + IC2 裁列棘轮 + StructureData 真实信封）。
 *
 * ## 唯一真源
 *
 * - 环境变量：`LIGHTNING_REAL_FIXTURES_DIR`（**唯一**夹具根键）；
 * - 固定映射：
 *   - `ggCtmGlass` → `multiblock/gg-antimatter-casing-ctm-glass.json`
 *   - `tesrCaptureCtm` → `tesr/tesr-capture-placeholder.ctm.json`
 *   - `ic2StripRatchet` → `multiblock/ic2-nuclear-reactor-pair-postfix.json`
 *   - `structureDataExportedEnvelope` → `structuredata/structuredata-exported-envelope.json`
 *
 * ## 一个资产 → 多个消费方
 *
 * `consumers` 是权威结构（每个消费文件各自登记被门控的判据名）；顶层的
 * `consumer` / `gatedTests` 由它派生，单消费方时与旧字段逐字等价（GG 试点兼容）。
 *
 * 夹具**不进产品仓**：缺 env / 缺文件时抛出的错误必须同时包含键、期望相对路径与候选，
 * 让缺资产成为可诊断的显式门控，而不是静默回退到合成纹理。
 *
 * ## 路径语义
 *
 * - env 为绝对路径：直接拼接期望相对路径；
 * - env 为相对路径：依次相对 `process.cwd()` / `web/` / 仓库根解析，取首个存在者；
 * - 候选全部不存在 ⇒ 错误中逐条列出实际尝试的绝对路径。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { loadRootEnv, REPO_ROOT, ROOT_ENV_PATH } from './load-env.mjs'

export const REAL_FIXTURES_DIR_ENV = 'LIGHTNING_REAL_FIXTURES_DIR'
export const WEB_ROOT = path.join(REPO_ROOT, 'web')

const SPECS = Object.freeze({
  ggCtmGlass: Object.freeze({
    key: 'ggCtmGlass',
    relativePath: 'multiblock/gg-antimatter-casing-ctm-glass.json',
    consumers: Object.freeze([
      Object.freeze({
        consumer: 'web/src/render/mesh/__tests__/translucentNeighborCull.test.ts',
        gatedTests: Object.freeze([
          '① 共享面零四边形；两侧其余面完整；孤立 ACC 六面完整',
          '② 负对照：关掉剔除 ⇒ 共享面确实在导出件里（2 层 × 2 侧 = 4 片）',
          '④ ACC 的 alpha 类别是 binary，且 pass 状态 = cutout 等价（真实 PNG 解码 → 生产装配 → 挂载材质）',
        ]),
      }),
    ]),
    reason:
      'GG 真实导出件是生产装配的唯一输入；未配置夹具根或文件不存在时，依赖真实件的 3 条判据显式跳过，其余 7 条语义判据继续运行。',
  }),
  tesrCaptureCtm: Object.freeze({
    key: 'tesrCaptureCtm',
    relativePath: 'tesr/tesr-capture-placeholder.ctm.json',
    consumers: Object.freeze([
      Object.freeze({
        consumer: 'web/src/runtime/__tests__/capturePlaceholderPresentation.test.ts',
        gatedTests: Object.freeze([
          '① 生产装配后占位条目仍在，且 6 个四边形原样保留',
          '② 占位单独成组并带 opacity；其余材质组不带',
          '③ 邻面剔除：相邻两个占位格各 6 面全保留；同状态真几何仍剔除共享面（负对照）',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/domain/__tests__/exportIntegrity.test.ts',
        gatedTests: Object.freeze([
          '正对照：真实导出件 + 真实世界读数 ⇒ 绿（6 格 = 3 真实几何 + 1 占位 + 2 合法空）',
          '负对照：把真实几何格手工抠成空气 ⇒ 必红，并指出该格',
          '负对照：把占位格抠成空气同样红（占位不是"可以丢"的豁免）',
          '恒绿防线：把 captureStats.lostCells 自报成 0，逐格对账仍判红',
          '负对照：计数改大以"吸收"被抠掉的格 ⇒ 分项和不闭合，仍红',
          '不可判不等于通过：缺 captureStats / 缺 scanBounds 都判红',
          '世界方块落在导出网格外 ⇒ 红（不静默忽略）',
          '映射口径：row 0 = 结构顶（maxY - y），不是 y 升序',
        ]),
      }),
    ]),
    reason:
      'TESR 捕获占位真实导出件是呈现装配与 cell-not-lost 判据的唯一输入；未配置夹具根或文件不存在时，两个消费文件里依赖真实件的 11 条判据显式跳过（其余仍运行），e2e 侧 tesr-capture-placeholder.spec.ts 由入口产物门控整份排除。',
  }),
  ic2StripRatchet: Object.freeze({
    key: 'ic2StripRatchet',
    relativePath: 'multiblock/ic2-nuclear-reactor-pair-postfix.json',
    consumers: Object.freeze([
      Object.freeze({
        consumer: 'web/e2e/ic2-texture-strip-ratchet.spec.ts',
        gatedTests: Object.freeze([
          '① 产物内 IC2 面号材质 blob == 该面 sprite 格（32×32），不是整条带',
          '② web 真实装配回放：south/north 黄/黑像素计数与修后实机读数 ±1% 一致',
        ]),
      }),
    ]),
    reason:
      'IC2 裁列棘轮的真实导出件是两条裁列/像素判据的唯一输入；未配置夹具根或文件不存在时，本 spec 由入口产物门控整份排除（整份不跑，不是静默跳过），其余 Vitest 侧无消费方。',
  }),
  structureDataExportedEnvelope: Object.freeze({
    key: 'structureDataExportedEnvelope',
    relativePath: 'structuredata/structuredata-exported-envelope.json',
    // 下面登记真实读取入口：E2E spec 由 real-artifact-gate.ts 的 STRUCTUREDATA_GATED_SPECS
    // 整份门控；Vitest 消费文件按用例显式门控（缺件 ⇒ it.skip，纯语义/仓内 Plain 用例仍运行）。
    consumers: Object.freeze([
      Object.freeze({
        consumer: 'web/e2e/helpers/saveReopen.ts（fixturePath/readFixtureText/copyFixtureTo）',
        gatedTests: Object.freeze(['（经该入口读取的 spec 由入口产物门控整份排除）']),
      }),
      Object.freeze({
        consumer: 'web/e2e/helpers/areaLifetime.ts（openWorkbenchWithScene）',
        gatedTests: Object.freeze(['（经该入口读取的 spec 由入口产物门控整份排除）']),
      }),
      Object.freeze({
        consumer: 'web/e2e/helpers/multiblock/frameDoc.ts（frameFixturePath/frameExpectations）',
        gatedTests: Object.freeze(['（经该入口读取的 spec 由入口产物门控整份排除）']),
      }),
      Object.freeze({
        consumer: 'web/e2e/pages/embed-dual.ts（HTTP /e2e/fixtures/…）',
        gatedTests: Object.freeze(['（embed-dual 页面的 spec 由入口产物门控整份排除）']),
      }),
      Object.freeze({
        consumer: 'web/src/e2e/embed-mobile-main.ts（HTTP /e2e/fixtures/…）',
        gatedTests: Object.freeze(['（embed-mobile 页面的 spec 由入口产物门控整份排除）']),
      }),
      Object.freeze({
        consumer: 'web/src/context/__tests__/partsRoundtrip.test.ts',
        gatedTests: Object.freeze([
          'structuredata-exported-envelope.json（Envelope）：无 parts 进出不产生 cellPartsGrid',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/context/__tests__/multiblockParser.test.ts',
        gatedTests: Object.freeze([
          'Envelope：既有 gzip+base64 信封（structuredata-exported-envelope.json）仍走 Envelope 解析路径',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/context/__tests__/itemIndexRootField.test.ts',
        gatedTests: Object.freeze([
          'structuredata-exported-envelope.json（Envelope，无部件）：序列化输出与基线指纹逐字节一致',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/adapters/export/__tests__/exportPorts.test.ts',
        gatedTests: Object.freeze([
          '帧下标越界 ⇒ 结构化失败（**不**夹取到最后一帧）',
          '设备读回失败 ⇒ 结构化失败并冒泡（不产出空产物）',
          '交付面：设备**确实**被调用过 `renderAndRead`（反空洞真）',
          '正常路径：`completed` + 真实 PNG 字节 + `releasedFor` + `framesRendered` 正确',
          '多帧请求 + `kind:image` ⇒ **显式拒绝**（不静默只导首帧）',
          '多帧**渲染**链路本身是通的（帧数经设备真实驱动，不是恒 1）',
          'E6 负对照 ①：去掉 `finally` 释放的作业形态会让"释放一次"判红',
          'E6 负对照 ②：预检阻塞时作业**不得**分配离屏资源',
          'E6：取消 ⇒ `cancelled` 且资源**已释放**（不产出产物）',
          'E6：渲染失败 ⇒ `failed` + 诊断 + 资源已释放（`finally`）',
          'E6：`releasedFor` 与"实际分配"一致（不是恒 0 的装饰）',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/adapters/export/__tests__/exportWiring.test.ts',
        gatedTests: Object.freeze([
          'G1：设备自建的 TexturePort 透传进会话（构造期不传也不影响）',
          'G2：绑定条数 == 材质描述符条数（不是"绑定 > 0"的恒真断言）',
          '**负对照**：不给 textureResources ⇒ 采样为空（证明判据覆盖了真实缺口）',
          '转发 ⇒ 清单 assembled: true 且条目 == deriveAssetNeeds 的产物',
          '**负对照**：不转发 ⇒ 清单自报 assembled: false（不伪造"无需资源"）',
          '当刻已中止 ⇒ 作业 cancelled、零产物、releasedFor == 0（未分配即停）',
          '中途中止 ⇒ cancelled 且已分配的资源必被释放',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/adapters/files/__tests__/legacyFormatGuards.test.ts',
        gatedTests: Object.freeze([
          'Envelope 夹具的判别结果稳定（同一输入两次判别相同）',
          '真 Envelope 的材质索引全部合法（62 项 / 57 blob）',
          '真 Envelope 的成对材料自洽（16 个说明 / 7×6×19 网格，下标全部在界内）',
          '无部件 Envelope 夹具**不含** `hostItem` / `itemIndex`（B-14：仅含部件文档才写）',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/adapters/files/__tests__/plainEnvelopeFidelity.test.ts',
        gatedTests: Object.freeze([
          '反空洞真：外置 Envelope 真夹具存在且非空（>100KB）',
          '**负对照**：`decodePlain` 拒绝 Envelope 输入（不会"解出一份空文档"当成功）',
          '真 Envelope 夹具可解包；内层含发布所需的 geometry / palette / texture',
          '解包 → 打包 → 再解包：**语义摘要相等**（B-2 的判据载体）',
          '**负对照**：Envelope **禁止**逐字节 —— 同一内容两处 gzip MTIME 不同 ⇒ 字节不同但语义相等',
          '**负对照**：语义子树的**内容**不同则摘要不同（证明摘要不是恒等常量）',
          '未知 `payloadEncoding` **显式报错**（F-04），不静默退化',
          '**负对照**：`encodeEnvelope` 拒绝 Envelope 入参（不把信封塞进信封）',
          'P-07..P-10：真 Envelope 的格式判别 / 元数据读取 / 稳定 id 语义成立',
          '**负对照 a（端到端）**：真夹具里的未知字段若被丢弃，往返摘要必变',
          '基线声明的"无部件"性质在 structuredata-exported-envelope 上仍成立（无 `itemIndex` / 无 `hostItem` / 无 `cellPartsGrid`）',
          '**G-4 复算**：structuredata-exported-envelope 的 sha256 与字节数必须与夹具登记逐位一致',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/adapters/files/__tests__/publishFormat.test.ts',
        gatedTests: Object.freeze([
          '真 Envelope 夹具的 `playback` 情形：缺省时**不**造（`copyIfPresent` 语义）',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/domain/__tests__/blockGeometry.test.ts',
        gatedTests: Object.freeze([
          '真实夹具：**重名条目确实带不同几何**（本条把这个事实钉在测试里）',
          '**真实夹具逐条往返零 diff**（全部 68 条目）',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/presentation/__tests__/cellIdentity.test.ts',
        gatedTests: Object.freeze([
          'envelope：格表长度 == 三角形数 + 遍历序单调 + 格集合 == 有几何的格集合',
          '**负对照**：不同夹具的格表**不是**常数（证明上面的"一致"有区分力）',
          '**反空洞真**：正常输入下 `cell-map-shape-invalid` **一次都不出现**',
          'envelope：逐材质图元独立可拾取，且对象身份不被分组拆散',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/render/data/__tests__/isoExportTextureChain.test.ts',
        gatedTests: Object.freeze([
          'A 正：真投影产物是**对象形态**，相遇点枚举出 N>0 条且逐条字节 = 文件槽位真值',
          'B 正：同一份 plain 换成**等价数组** ⇒ 枚举结果逐条相同（相遇点形态无关）',
          'C 负对照（能红）：修复前"只认数组"的实现 ⇒ 同一份真 plain 枚举 **0** 条',
          'D 正：枚举到字节 ⇒ 材质库能给出材质（不抛 `纹理未预取`）',
          'D 负对照（能红）：修复前的空枚举 ⇒ 同一调用抛 `纹理未预取`（等轴导出静默失败的形态）',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/runtime/__tests__/drwKernelRenderSource.test.ts',
        gatedTests: Object.freeze([
          '① 旧源缺席 + 内核面在场 ⇒ 定义面/说明池由内核产出',
          '③ 帧下标越界 ⇒ 保留上一次结果（不改成空定义、不回落旧文档）',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/runtime/__tests__/frameChangeUnavailableDiagnostic.test.ts',
        gatedTests: Object.freeze([
          '② 生产链产出的渲染视图文档在场 ⇒ 零诊断，且换帧真的发生',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/workbench/export/__tests__/materialIndexEndToEnd.test.ts',
        gatedTests: Object.freeze([
          '段A：导出输入 plain 的调色板索引空间 ＝ 文件槽位（mismatch 0）',
          '段B：逐 piece 断言 def.materialPalette[piece.materialIndex] ＝ 文件槽位材质（2843 条，mismatch 0）',
          '段C：导出产物逐 quad 的贴图来源 ＝ 文件槽位材质的 blob 载荷（mismatch 0）',
          '段D：MTL 的 map_Kd ↔ zip 内 textures/*.png 一一对应',
          '负对照：调色板退回旧键（整串 localeCompare）⇒ 同一条判据判红',
          '负对照②（修复前形态）：blob 字节表不可读 ⇒ 段C 判红，共面簇侧不受影响',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/workbench/__tests__/inputPortKernelRouting.test.ts',
        gatedTests: Object.freeze([
          '装配成功 ⇒ 存在性/装配成功都为真，历史为空，文档**不脏**',
          '经生产端口改一格 ⇒ 内核有值、**载体**有值、恰好一条历史（防"假成功"）',
          '逐条负对照的反面：**另一格**不得被写（防"写到镜像的那一格"）',
          '改一格 → 撤销 ⇒ 内容回原状、历史清空、`kernelDirty()` 从 true 回 false',
          '重做经同一入口 ⇒ 内容回来、再次变脏（撤销/重做都不是"只改内核不投影"）',
          '分支④：四条 `QUEUED_ONLY` 逐条 ⇒ `effectfulCommandNotAcceptedByInputPort`',
          '分支⑤：**非联合**的旧算子 id 逐条 ⇒ `commandNotWiredToInputPort`',
          '旧旁路已移除：`submit()` 的票号**不得**是旧转发命名空间（具名 `unsupported:` 才是"没有排队通道"）',
          '`setProperty` 的 ref 形状不对 ⇒ 具名拒绝（不是"查不到控件就静默丢弃"）',
          '**逐条清单**：对 `Command` 联合**每一个**成员，端口都必须给出显式结算',
          '变异体 A（绕过内核、只写 legacy 载体）⇒ 判据①的断言器判红',
          '变异体 B（只在内核生效、不投影 ⇒ "假成功"）⇒ 判据①的断言器判红',
          '变异体 C（一次交互记两条历史）⇒ "恰好一条"的断言判红',
          '反面（防恒红）：**合规**的一次端口写在同一批断言器上判绿',
          '**提交仅一条历史**：一次 `draft.commit` 意图 ⇒ 恰好一条历史且投影可见',
          '**撤销也走真实通道**：`edit.undo` 意图 ⇒ 内容回原状、历史清空、脏语义回基线',
          '**两处观察看到同一事实**（A05「面板相同」的读面形态）：读面里没有 area/region 维度',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/composition/__tests__/cellContentCarriage.test.ts',
        gatedTests: Object.freeze([
          '**真实信封夹具**的 tooltip 池（16 条 / 7×6×19 网格）真的进了内核',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/composition/__tests__/documentLoadSpines.test.ts',
        gatedTests: Object.freeze([
          'structuredata-exported-envelope：文件选择器路径 ≡ DocumentSource 路径',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/composition/__tests__/exportCapture.test.ts',
        gatedTests: Object.freeze([
          'PNG 捕获：单帧、秒数来自 seconds、相机是四个值之一、清单与画面同源',
          'GIF 捕获：帧数与逐帧 holdMs **来自声明**（[50,100]），不是自算的均匀值',
          '端到端（受控设备）：GIF 产物里的逐帧 delay == 捕获声明的 [5,10]',
          '**负对照**：静态材质跑 GIF 捕获 ⇒ noAnimatedSequences；无文档 ⇒ exportCaptureNoKernelDocument',
          '器具捕获：显式机位 → 请求相机 = shotCameraSpecOf 的值，分辨率任意且非正方',
          '器具捕获：非法分辨率 / 退化落点 ⇒ 显式失败（不静默夹取）',
          '方向越界 ⇒ 显式失败（不静默夹取到 0）',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/composition/__tests__/kernelDefinitionFace.test.ts',
        gatedTests: Object.freeze([
          '① 生产装配 ⇒ 定义面直出：对象 id 来自装配面，定义面来自内核载荷',
          '③ 与旧 DRW 路径 parity（旧链路解析得出的形态）+ 变体判假（比较有区分力）',
          '④ 帧下标有效：两帧世界文档（两份真夹具拼帧）逐帧给出**不同**定义面',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/composition/__tests__/kernelPickAdapterProduction.test.ts',
        gatedTests: Object.freeze([
          '① 真实几何上射入 ⇒ 解出方格，且 ② `blockId` 与内核网格读面逐字一致',
          '④ **负对照**：同一命中但逐格身份缺席 ⇒ `no-cell`（不猜第 0 格）',
          '⑤ **负对照**：分层预览滤掉命中层 ⇒ `cell-is-air`（分层语义未退化）',
          '⑥ 轮换拾取：`pickAllAt` 给**多个**候选，且去重键与 legacy 同（同格只算一次）',
          '⑦ **负对照**：`pickAllAt` 与 `pickAt` 对**同一条射线**给出同一最近格（两链共用一条映射）',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/composition/__tests__/kernelPresentationInputs.test.ts',
        gatedTests: Object.freeze([
          'envelope：产出 key/geometry/primitives，且**不是**空产出',
          'envelope：每个材质图元的几何与渲染路径**逐位相同**，且各组并集不漏不重',
          'envelope：编译成功且**零跳过**（数据造出来但编译吃不下会是这一条的失败）',
          '**负对照**：真实夹具的三角形数**不是**常数（证明上一条不是恒真）',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/composition/__tests__/kernelRenderSourceFace.test.ts',
        gatedTests: Object.freeze([
          '① 真信封：frameCount / 定义面（逐 quad 槽位等价）/ 说明池集合 / 材质输入',
          '② 负对照：越界 / 无供源 ⇒ null（不回落旧文档、不造空定义）',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/composition/__tests__/kernelTextureResources.test.ts',
        gatedTests: Object.freeze([
          '真实规模（57 张）：坏 1 张 ⇒ 恰好 1 条 failed，其余全部 ready',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/composition/__tests__/materialIndexAlignment.test.ts',
        gatedTests: Object.freeze([
          '② 真信封（62 条材质）：逐 quad 断言位置索引＝文件槽位（mismatch 0）',
          '②负对照：规范化退回旧键（整串 localeCompare）⇒ 同一条逐 quad 判据判红',
          '③ 不变量：同一份真清单做合法置换 ⇒ 内容身份序列与清单摘要完全相同',
          '④ 绑定侧（爆炸半径）：`material:<mi>` 的位置解析落到**同一槽位**的那条资源',
          '⑤ 涟漪账（实测）：清单摘要不变；内容身份只在 ≥10 条材质上变',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/composition/__tests__/presenterSession.test.ts',
        gatedTests: Object.freeze([

        ]),
      }),
      Object.freeze({
        consumer: 'web/src/composition/__tests__/projectFormatProduction.test.ts',
        gatedTests: Object.freeze([
          '工程往返：`projectForSave` → `decodeProjectFile` → `adoptProject` 后业务语义逐项读回',
          '未知主版本 ⇒ `UnsupportedOperation`（**不**降级读取）',
          '未知字段按**文档身份**承载（既有口径）：不进核心、也不让整份被拒',
          '**负对照**：不 `adoptProject` ⇒ 业务语义**不得**等于原文档读数（证明 ① 有区分力）',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/composition/__tests__/projectionFidelity.test.ts',
        gatedTests: Object.freeze([
          '帧为主文档：帧数 = 网格对象数，且**每帧带** structure（两种形态语义不同）',
          '真实信封：tooltipPalette 与 cellTooltipGrid 必须写出，且**逐格文本**与源相同',
          'envelope：4 轮往返后字节数必须**收敛**（不膨胀、不失败）',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/composition/__tests__/projectionSize.test.ts',
        gatedTests: Object.freeze([
          '**带真实几何**的稀疏文档（真实信封挖空顶 3 行）同样保住声明尺寸',
          '**envelope**：产物维度就是源文件声明的维度（声明优先的可观测形态）',
          '**保存产物字节**（envelope）',
          'presenter 顶点 == "带声明"重算（逐位），且 **≠** "不带声明"重算',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/composition/__tests__/realEnvelopeRoundTrip.test.ts',
        gatedTests: Object.freeze([
          '装配后的基础事实与 R0 冻结读数一致（57 纹理 blob / 7×6×19 网格 / 18 个说明格）',
          '写格内容：`setCellContent` 的写入被**业务语义读面**读回',
          '写方块身份：`moveCells` 后目标格的真实身份（含命名空间）经读面读回，且源格消失',
          '写注解：真实信封**不含**注解（如实登记）⇒ 经内核命令新建/改/删并按语义读回',
          '改旧文档的格内容 / 注解后，内核读面读数**逐项不变**',
          '未提交命令 ⇒ 读面**不会**给出新值（若给出，说明读面读的不是内核文档）',
          '破坏内核写（只读源）⇒ 同一写命令被判红（证明"写通"不是恒真）',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/composition/__tests__/renderCutoverParity.test.ts',
        gatedTests: Object.freeze([
          '**完整内核链**：真实信封经 装配 → 投影 后仍是 4882 三角形且逐位相同',
          '几何承载那一段的隔离证明：原始几何 vs 类型化资产重编码**逐位相同**且三角形数非 0',
          '**负对照**：按 `name:meta` 合并调色板 ⇒ 三角形数**必然**变化（证明上面的"一致"不是恒真）',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/composition/__tests__/saveProjection.test.ts',
        gatedTests: Object.freeze([
          '**反向腐烂检查**：登记表里每一条都必须**真的被用到**（防止"登记了但早已不成立"）',
          '**边界幂等**：`plainRoot` 传信封根与传 `plainRootOf(raw)` 得到同一份保真记录',
          '**负对照**：绕过边界（直接喂 raw 给装配）⇒ 必然**污染 + 丢失**（证明边界承重）',
          '**多帧**：装配后装配面 = 装配产物的帧对象映射（逐项相同）',
          '**内核权威 ⇒ `source: "kernel"`**，且产物 = 内核投影',
          '**无会话 ⇒ 不再回落**：`plain: null` + `reason: "no-session"`（R1-β① C5 断言翻转）',
          '**键面**（envelope）：`onlyLegacy` 必须为空（空值缺席须机器核验），`onlyKernel` 必须在显式允许集里',
          '**字面量**（envelope）：`id`/`format_version`/`annotations`/`labels`/`meta`（除 `created_at_ms`）逐字相等',
          '**语义面**（envelope）：帧数/帧声明/形态/注解/标签/多方块声明相等',
          '**逐格说明**（envelope）：两侧逐格文案相同；legacy 有说明的格内核不得缺',
          '**材质表**（envelope）：同 `locator` 的语义字段与 blob 内容逐条相同',
          '**叶子登记**（envelope）：每个叶子差异都必须匹配一条登记规则',
          '**命名空间**（envelope）：产物调色板的 `registryId` 与 legacy **逐条相同**（真实命名空间未被改写）',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/composition/__tests__/textureUnificationProduction.test.ts',
        gatedTests: Object.freeze([
          '①e **合并批次**：真实信封（39 材质组 > 32 预算）⇒ 挂载材质数 = 编译材质数，且全部带 `map`',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/operators/__tests__/availabilityTestHost.ts（fixtureRaw：默认 ENVELOPE_FIXTURE 走 realFixtureText，其余公开夹具原读取）',
        gatedTests: Object.freeze([

        ]),
      }),
      Object.freeze({
        consumer: 'web/src/operators/__tests__/operatorAvailability.test.ts',
        gatedTests: Object.freeze([
          '能力缺口优先于 poll：`requires` 缺一项 ⇒ 不可用且点名能力（不再进 poll）',
          '未声明 `pollReason` ⇒ 通用原因（不 TypeError），且 exec/invoke 保持旧行为（只记 info）',
          'poll 求值次数：gate 只调一次 poll；pollReason 只在 false 时求值',
          '非 Wiki 载入文档（local-file 绑定）⇒ 不可用，原因指向"另存为 Wiki 结构"',
          '从未写过绑定的文档（sourceId 仍是 empty，OPERATOR_OPEN_SCENE 的真实形态）⇒ 同一句原因',
          'Wiki 载入但**无**可审计变更 ⇒ 不可用，原因说清"与基线一致"',
          '**直接入口**（Ctrl+S 同一条 `invoke`）⇒ 底栏成句拒绝，与菜单原因同源',
          '有可审计变更 ⇒ 可用（正对照）+ `invoke` 真的打开确认模态',
        ]),
      }),
      Object.freeze({
        consumer: 'web/src/workbench/document/__tests__/documentBindingTakeover.test.ts',
        gatedTests: Object.freeze([
          '真 OPEN_SCENE 打开本地 B：先证 B 接管，再证绑定重建且保存门关闭（零保存请求）',
          'NEW_SCENE：绑定整体清空（locator/baseline/revision 都为空）',
          'OPEN_PROJECT：绑定重建成本地工程来源，A 的 locator/revision 不再出现',
          'OPEN_PROJECT 失败：当前文档与绑定都保留（失败不破坏有效状态）',
          'OPEN_SCENE 失败：当前文档与绑定都保留（M6 负对照）',
          'LOAD_BUILTIN 成功重建 builtin 绑定；解析失败清空文档时绑定也清空',
          'SDE 加载/失败：绑定换成 sde-export 或清空，不保留 Wiki A',
          'LOAD_EMBED：宿主提供的文档没有外部身份 ⇒ 清空；解析失败不清（当前文档不变）',
          'SET_WORKSPACE_MODE resetDocument：清文档时绑定一起清空',
          'OPEN_SCENE 后本地保存只推进本地绑定的基线',
          'Wiki 绑定下本地保存不得把 Wiki 基线/revision 标成已保存（未写 Wiki 页）',
          'Wiki A 的确认草稿在装载/Reload 到 Wiki B 时清空（与本地接管一致）',
          '本地接管显式清掉 pendingSaveSummary（旧页草稿不得跟到新文档）',
          'SAVE_FILE：B1 clean、B2 仍 A、gate/丢弃确认仍脏；mock Wiki 保存成功后 clean',
          'SAVE_PROJECT：B1 clean、B2 仍 A、gate/丢弃确认仍脏；mock Wiki 保存成功后 clean',
          'Wiki A 的 plain 不含 undefined/NaN/Infinity（canonicalize 的 JSON 边界前提）',
          'dirty 可保存：正式保存推进 baseline/revision，随后 clean 的原因变成"没有可审计变更"',
          'Wiki 另存为换 locator；Reload 保持 locator 并刷新 revision/基线',
          '从本地文档另存为 Wiki：baseline 钉到刚写出的内容，换 locator 后仍干净',
          '恢复副本采纳：仍整体清空绑定（副本不携带源 locator）',
          'undo/redo 的写路径（documentSnapshot → restoreDocumentSnapshot）不碰绑定',
        ]),
      }),
    ]),
    reason:
      'StructureData 真实导出信封是 kernel / viewport / wiki 等 E2E 判据与 Vitest 判据的唯一真实输入；未配置夹具根或文件不存在时，E2E spec 由入口产物门控整份排除，Vitest 侧只显式跳过依赖真实件的用例（不是静默跳过）。',
  }),
})

/** 已知夹具键（供 global setup 遍历；GG 试点 + TESR 捕获占位 + IC2 裁列棘轮 + StructureData 真实信封）。 */
export const REAL_FIXTURE_KEYS = Object.freeze(Object.keys(SPECS))

/** @param {string} key */
export function realFixtureSpec(key) {
  const spec = SPECS[key]
  if (spec === undefined) {
    throw new Error(`未知真实夹具键：${key}（已知：${REAL_FIXTURE_KEYS.join(', ')}）`)
  }
  return spec
}

function samePath(a, b) {
  return process.platform === 'win32'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b)
}

function uniquePaths(paths) {
  const out = []
  for (const p of paths) if (!out.some((q) => samePath(p, q))) out.push(p)
  return out
}

function envDirOf() {
  const raw = process.env[REAL_FIXTURES_DIR_ENV]
  if (raw === undefined || raw.trim() === '') return null
  return raw.trim()
}

function candidateDirsOf(envDir) {
  if (path.isAbsolute(envDir)) return [envDir]
  return uniquePaths([process.cwd(), WEB_ROOT, REPO_ROOT].map((root) => path.resolve(root, envDir)))
}

/**
 * @typedef {object} RealFixtureConsumer
 * @property {string} consumer 消费文件（仓库相对路径）
 * @property {readonly string[]} gatedTests 该文件里依赖真实件的判据名
 */

/**
 * @typedef {object} RealFixtureStatus
 * @property {string} key
 * @property {string} expectedRelativePath
 * @property {readonly RealFixtureConsumer[]} consumers 消费方（权威）
 * @property {string} consumer 派生的消费方串（单消费方时与旧字段逐字相同）
 * @property {readonly string[]} gatedTests 派生的被门控判据并集
 * @property {string} envKey
 * @property {string | null} envDir
 * @property {readonly string[]} candidates
 * @property {string | null} path
 * @property {boolean} available
 * @property {'env' | 'file' | null} missingKind
 * @property {string} reason
 */

/**
 * 解析一个夹具的可用性（不抛异常；缺失原因结构化返回）。
 *
 * @param {string} key
 * @returns {RealFixtureStatus}
 */
export function realFixtureStatus(key) {
  loadRootEnv()
  const spec = realFixtureSpec(key)
  const envDir = envDirOf()
  const base = {
    key: spec.key,
    expectedRelativePath: spec.relativePath,
    consumers: spec.consumers,
    // 派生字段：保持 GG 试点期的读法（单消费方 ⇒ 与旧值逐字相同）。
    consumer: spec.consumers.map((c) => c.consumer).join(', '),
    gatedTests: spec.consumers.flatMap((c) => c.gatedTests),
    envKey: REAL_FIXTURES_DIR_ENV,
    envDir,
  }

  if (envDir === null) {
    return {
      ...base,
      candidates: [
        `${ROOT_ENV_PATH} 中的 ${REAL_FIXTURES_DIR_ENV}`,
        `<${REAL_FIXTURES_DIR_ENV}>/${spec.relativePath}`,
      ],
      path: null,
      available: false,
      missingKind: 'env',
      reason: `未设置 ${REAL_FIXTURES_DIR_ENV}（根 .env 不存在该键）`,
    }
  }

  const candidates = candidateDirsOf(envDir).map((dir) => path.join(dir, spec.relativePath))
  const found = candidates.find((candidate) => existsSync(candidate)) ?? null
  if (found !== null) {
    return { ...base, candidates, path: found, available: true, missingKind: null, reason: `已找到 ${found}` }
  }
  return {
    ...base,
    candidates,
    path: null,
    available: false,
    missingKind: 'file',
    reason: `已设置 ${REAL_FIXTURES_DIR_ENV}=${envDir}，但候选路径下都不存在 ${spec.relativePath}`,
  }
}

/**
 * 人类可读的错误正文（键 / 期望相对路径 / 候选 / 处置）。
 * @param {RealFixtureStatus} status
 */
export function realFixtureErrorMessage(status) {
  const lines = [
    `真实夹具不可用：${status.key}`,
    `  期望相对路径：${status.expectedRelativePath}`,
    `  环境变量：${status.envKey}${status.envDir === null ? '（未设置）' : `=${status.envDir}`}`,
    `  原因：${status.reason}`,
  ]
  if (status.candidates.length > 0) {
    lines.push('  候选：', ...status.candidates.map((candidate) => `    - ${candidate}`))
  }
  lines.push(`  处置：在仓库根 .env 写 ${REAL_FIXTURES_DIR_ENV}=<真实夹具根>（布局见 .env.example）`)
  return lines.join('\n')
}

/** @param {string} key */
export function realFixtureAvailable(key) {
  return realFixtureStatus(key).available
}

/**
 * 返回真实件绝对路径；缺 env / 缺文件时抛出带诊断的错误。
 * @param {string} key
 */
export function realFixturePath(key) {
  const status = realFixtureStatus(key)
  if (status.path === null) throw new Error(realFixtureErrorMessage(status))
  return status.path
}

/**
 * 读取真实件文本，并把 CRLF 归一化为 LF（铁律 6：外部件经 Windows 复制后仍可能是 CRLF）。
 * 惰性读取：只在真正消费该件的用例体内调用，缺件时抛 {@link realFixtureErrorMessage}。
 * @param {string} key
 */
export function realFixtureText(key) {
  return readFileSync(realFixturePath(key), 'utf8').replace(/\r\n/g, '\n')
}
