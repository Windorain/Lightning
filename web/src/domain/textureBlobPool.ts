/**
 * `textureBlobs` 的**唯一形态归一化点**（原 `render/data/textureBlobPool.ts`，
 * 现归 `domain/`）。
 *
 * ## 为什么在 `domain/`（落点迁移的依据，实测驱动）
 *
 * 1. 这是**纯数据形状**（两种契约形态）＋**纯函数**（无 Vue/Three/DOM/IO、显式输入、不改输入）
 *    ⇒ 归属最内层 `domain/`（`LAYER_DESTINATIONS` 里 `domain` 是整层迁移、`corePurity`）；
 * 2. `tests/architecture/kernel-legacy-isolation.test.ts:269-279` 硬要求内核清单
 *    `KERNEL_FILES`（57 个文件，含 `adapters/files/*`）的**全部**导入不得指向 16 个旧层目录
 *    （含 `render`）：`:toEqual([])`、无登记/豁免机制、不看深度。当归一化点在 `render/` 时，
 *    内核消费者**无法合法引用**（实测：加了 `@/render/textureBlobPool` 后 `test:arch`
 *    由 225P/0F 变 223P/2F）。
 * 3. `domain/` 是**最内层**：所有层都可 import 它——内核文件 → `domain/` 不撞隔离闸门；
 *    旧层文件 → `domain/` 是"向内"，不是"旧→内核迁移边"（那条判据的判定面是 `KERNEL_FILES`）。
 *    ⇒ 落在这里**不产生任何跨层债**，也不需要登记。
 *
 * ## 这一处为什么必须存在
 *
 * `textureBlobs` 在生产里有**两种契约形态**（不是实现选择）：
 *
 * | 形态 | 谁产出 | 空洞表示 |
 * |---|---|---|
 * | 槽位键对象 `{"0": "<b64>", …}` | `composition/kernelProjection.ts:1406-1408`（**帧为主**文档的投影产物 = `plainForSave().plain`） | 键缺席 |
 * | 数组 `["<b64>", …]` | ① `composition/kernelPresentationInputs.ts:397-404`（内核材质面）；② `composition/kernelProjection.ts:1403-1405`（**多方块**，`docs/contracts/format-multiblock-doc.md` §3） | ①`undefined` 空洞；②`''` 占位 |
 *
 * 消费者曾经**各自解析**（`render/data/sceneDocumentMaterialHydrate.ts:31-32` 只认数组、
 * `render/data/bundleResolve.ts:77-84` 只认"数组且全密"、`workbench/export/bundleMaterialBaking.ts:58-59`
 * 的数组分支用 `.filter` 压紧）。后果是"同一语义三处实现"且**三处都错**：
 *
 *  - 只认数组 ⇒ 对象形态静默枚举 0 条（等轴 PNG 导出实测无贴图、且不报错）；
 *  - 只认"全密数组" ⇒ 稀疏/占位数组被判成"无池"，校验与判"可渲染"静默跳过；
 *  - `.filter` 压紧 ⇒ 空洞之后的槽位**整体前移**，`blobs[textureBlobIndex]` 取到**旁边槽位**
 *    的字节（静默错图）。实测 `['a', null, 'c']` 的 `blobs[2]` 由 `'c'` 变 `undefined`。
 *
 * ⇒ 归一化**只在本文件**发生（同一语义不得有第二处实现）；所有消费者走
 * {@link normalizeTextureBlobPool}，类型面用本文件的 {@link TextureBlobPool}
 * （`render/schema/types.ts` 只是把它**具名重出口**，见该文件注释）。
 *
 * ## 归一化契约（唯一）
 *
 * 返回**位置保持**的数组：`out[i]` ＝ 槽位 `i` 的字节；该槽位无字节时为 `''`。
 * 因此任何形态下 `out[textureBlobIndex]` 的语义都相同 —— "下标即槽位"，**永不压紧**。
 *
 * `''` 而不是 `undefined` 的理由：6 处既有取法（`workbench/export/bundleMeshAssembly.ts`
 * 的 `blobs[i]` 与真值判定）对二者同判"无字节"，用 `''` 可保持 `readonly string[]`
 * 这一既有类型面零改动；同时 `''` 不是合法 base64（内核 `payload !== null` 才写槽），
 * 故不会与真字节混淆。
 *
 * ## 同族落点登记表（**登记即待退出**，不是"已知并存"）
 *
 * | 落点 | 状态 | 退出条件 |
 * |---|---|---|
 * | `render/data/sceneDocumentMaterialHydrate.ts:42`、`render/data/bundleResolve.ts:103-112`、`workbench/export/bundleMaterialBaking.ts`（`extractTextureBlobs`） | **已收敛**（前批，判据 38 条已绿） | 已退出 |
 * | `runtime/presentationAdapter.ts:150`（`resourceDigestOf` 喂入口） | **已修**（先判形态再归一化；判据 6 条走生产解析 + 生产读取面） | 已退出（调用点） |
 * | `viewer/viewerFromDocument.ts:20` | **已修**（认两种形态 + 能红负对照 3 条） | 已退出 |
 * | `adapters/files/legacyFields.ts:111` | **已修**（内核文件改引本模块 ⇒ 不再撞内核隔离闸门） | 已退出 |
 * | `adapters/files/publishFormat.ts:175`（`hasNonEmptyArray` 只认数组） | **已修**（同上） | 已退出 |
 * | `runtime/context.ts:1231`（同族第 7 处） | **未收敛**：该文件当前不允许改动 | 该文件收敛时一并修：按形态归一化取池，或改读已归一化的呈现输入；届时删除本行 |
 * | `presentation/contentIdentity.ts#resourceDigestOf`（**本体**形态敏感） | **登记的地雷**：入参契约是 `unknown`，允许池与非池混用 | ① 身份函数入参收成规范形（类型面由编译器保证），**或** ② `render/` 移除。**在那之前任何调用方必须先规范化**（配方与负对照见 `runtime/presentationAdapter.ts#resourceIdentityInputOf` 的 docblock） |
 *
 * ⚠️ 与"取字节"型消费者不同，**摘要型**消费者**禁止盲归一化**（{@link normalizeTextureBlobPool}
 * 对非池值产出空表 ⇒ 不同内容会给出同一摘要 ⇒ 判据塌陷）。
 */

/** 归一化结果：位置保持（下标 = 槽位），无字节的槽位为 `''`。 */
export type NormalizedTextureBlobPool = readonly string[]

/** 形态判别的最小面：数组，或"键为数值下标的对象"。 */
export type TextureBlobPoolLike = readonly unknown[] | Readonly<Record<string, unknown>>

/**
 * 根级/帧级 `textureBlobs` 的**契约类型**（两种形态，见本文件头的表）。
 *
 * 原定义在 `render/schema/types.ts`（迁移时随唯一实现一起来到 `domain/`，
 * 该文件改为**具名重出口**以保持既有 import 面不变）。
 *
 * 用途：让"直接按下标取 `blobs[i]` 而不归一化"的类型误用在**编译期**暴露 ——
 * 文档根（`StructureDataBaked#textureBlobs`）与帧（`Frame#textureBlobs`）都用它。
 * **任何形态解析只许发生在** {@link normalizeTextureBlobPool}（统一实现）。
 */
export type TextureBlobPool = readonly string[] | Readonly<Record<string, string>>

/**
 * **唯一的** `textureBlobs` 形态归一化：任意形态（数组 / 槽位键对象 / 缺席 / 非法）→ 位置保持数组。
 *
 * 数组形态**不压紧**：非字符串槽位（空洞 / `null` / 嵌套对象）写 `''` 占位，长度与入参一致。
 * 对象形态**按数值键稠密落位**（`{"0":"a","2":"c"}` → `["a","","c"]`，下标即槽位；长度 = 最大键 + 1），
 * 非数值键与非字符串值一律丢弃（不当成槽位）。
 *
 * 「无字节」的表示**两形一致**：都是 `''`（从不留 `undefined` 空洞）—— 这是"同一逻辑内容的
 * 两种形态归一化后必须相等"的前提，也是 `readonly string[]` 返回类型成立的前提。
 *
 * 已经规范（全 `string` 的密数组）时返回**入参本身**，避免渲染帧循环里的无谓拷贝。
 */
export function normalizeTextureBlobPool(raw: unknown): NormalizedTextureBlobPool {
  if (Array.isArray(raw)) {
    // 先判"已规范"：密数组 + 全字符串 ⇒ 原样返回（新数组会破坏上游的引用记忆）。
    let needsWork = false
    for (let i = 0; i < raw.length; i++) {
      const v = raw[i]
      if (typeof v !== 'string') {
        needsWork = true
        break
      }
    }
    if (!needsWork) return raw as readonly string[]
    const out: string[] = new Array(raw.length)
    for (let i = 0; i < raw.length; i++) {
      const v = raw[i]
      out[i] = typeof v === 'string' ? v : ''
    }
    return out
  }
  if (raw !== null && typeof raw === 'object') {
    // 对象形态：键 = 槽位下标（`String(i)`），键缺席 = 该槽位无字节。
    // ⚠️ 必须**稠密填充**：`out[idx] = v` 在空数组上会留**空洞**（`undefined`），
    // 与数组分支的 `''` 占位不一致 —— 于是"同一逻辑内容两种形态"归一化后不 deep-equal
    // （`{'0':'A','2':'C'}` ⇒ `['A', <hole>, 'C']` vs `['A','','C']`），
    // 且 `as string[]` 的返回类型不成立（实测判据 `textureBlobPool.shapeContract.test.ts`
    // 「两种形态在同一逻辑内容下产出同一标准化结果」当场判红）。
    const record = raw as Record<string, unknown>
    let maxIdx = -1
    const slots: Array<readonly [number, string]> = []
    for (const [k, v] of Object.entries(record)) {
      if (typeof v !== 'string') continue
      if (!/^\d+$/.test(k)) continue // 非数值下标 ⇒ 不是槽位（与 `isTextureBlobPoolShaped` 同口径）
      const idx = Number(k)
      if (!Number.isSafeInteger(idx)) continue
      slots.push([idx, v])
      if (idx > maxIdx) maxIdx = idx
    }
    if (maxIdx < 0) return []
    const out: string[] = new Array(maxIdx + 1).fill('')
    for (const [idx, v] of slots) out[idx] = v
    return out
  }
  return []
}

/**
 * 槽位 `slot` 是否有字节（消费者统一的"存在性"判定）。
 *
 * 提供它的理由：消费者若自己写 `typeof blobs[i] === 'string'`，就会把归一化后的
 * `''` 占位误判成"有字节"（去解码空串 ⇒ 解码失败报错）；「无字节」的判定与「形态」
 * 的判定同属这一处语义，故一并收在此处。
 */
export function hasTextureBlobAt(blobs: NormalizedTextureBlobPool, slot: number): boolean {
  if (!Number.isFinite(slot)) return false
  const i = Math.floor(slot)
  if (i < 0 || i >= blobs.length) return false
  const v = blobs[i]
  return typeof v === 'string' && v.length > 0
}

/**
 * 从文档根取 `textureBlobs` 并归一化（消费者最常用的一步）。
 *
 * @param doc 任意文档根（`textureBlobs` 可缺席 / 形态非法）
 */
export function textureBlobPoolOf(doc: unknown): NormalizedTextureBlobPool {
  if (doc === null || typeof doc !== 'object') return []
  return normalizeTextureBlobPool((doc as { textureBlobs?: unknown }).textureBlobs)
}

/**
 * 某值**是不是** `textureBlobs` 的契约形态（strict 版本）。
 *
 * 为什么需要它：`normalizeTextureBlobPool` 对**非池**值（键不是数值下标的对象、
 * 元素不是字符串的数组）会产出空表 —— 对"取字节"是对的（那些键本来就不是槽位），
 * 但对"取**内容摘要**"是**数据丢失**：`resourceDigestOf({stone:'AAAA'})` 与
 * `({stone:'BBBB'})` 都会归一成 `[]` ⇒ 摘要相同 ⇒ "同键不同内容"判据失效。
 *
 * **实测口径（勿再引用旧说法）**：盲归一化的受害面只在**调用点层** ——
 * `presentation/__tests__/contentIdentity.test.ts` 两条（纯函数层）会判红，而
 * `presentation/__tests__/contentSignal.test.ts` **仍绿**（它用 `contentIdentityOf` +
 * `resourceDigestOf` 直接构造身份，**不经过** `runtime/presentationAdapter.ts` 的喂入点）。
 * ⇒ 调用点层的判据在 `runtime/__tests__/presentationAdapterResourceShape.test.ts`。
 *
 * ⇒ 摘要类消费者必须**先判形态**：是池 ⇒ 归一化后取摘要（形态无关）；不是池 ⇒ 按原值取摘要。
 * 判定与归一化同处一地（统一实现），消费者不许自己写这个判别。
 */
export function isTextureBlobPoolShaped(raw: unknown): boolean {
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i++) {
      const v = raw[i]
      if (v === undefined) continue // 空洞 = 无字节槽位
      if (typeof v !== 'string') return false
    }
    return true
  }
  if (raw === null || typeof raw !== 'object') return false
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') return false
    if (!/^\d+$/.test(k)) return false // 非数值下标 ⇒ 不是槽位表
  }
  return true
}
