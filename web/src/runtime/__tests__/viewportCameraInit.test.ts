/**
 * 视口相机**初始机位施加纪律**的判据（M1 缺陷修复的单元层）。
 *
 * ## 它钉住的事实（缺陷形态逐条）
 *
 * 用户实测：工作台里**第一次编辑一格说明**（或第一次移动方块）⇒ 视口机位被复位回
 * "装载后自动框选"的机位。运行期探针（`zz-camera-rootcause.spec.ts`）给出的链条是：
 * 内容投影让 `drw.textureCache`（`materialLibrary`）瞬时变 null ⇒ 宿主
 * `RenderEngineHost` 卸载重挂 ⇒ `@ready` 再触发 ⇒ `attachViewport` 无条件
 * `OPERATOR_INIT_VIEWPORT_CAMERA` ⇒ 重新 fit。
 *
 * 故本文件的判据是本模块的**唯一出口** `shouldApplyInitialViewportCamera`：
 *
 * | 场景 | 期望 | 为什么 |
 * |---|---|---|
 * | 首次装载（无相机状态） | **施加** | "首次装载的自动框选必须保留" |
 * | 同一文档内的内容投影（编辑/移动后宿主重挂） | **不施加** | 用户机位必须跨内容投影存活 |
 * | 换了一份文档（`documentRevision` 变） | **施加** | 新文档要有自己的初始机位 |
 * | 相机状态被归零（装载路径 `resetAllViewportCameras`） | **施加** | 否则视口会停在"没有机位" |
 * | **呈现卸载后重挂**（工作区切走再切回；`unregister`/`reset`） | **不施加** | SPEC §7.3-b③：承载重建要恢复逻辑机位，不得重新框选（M7-2 / D1；G1/G2 先红实测） |
 *
 * ## 负对照（本文件必须能判红的那一条）
 *
 * 第三组用例把**改动前的口径**（"每一次 attach 都施加" = 恒 `true`）作为对照实现，
 * 断言它在"同一文档内的内容投影"这一行上与正解**不同** —— 即"判据能区分错误行为"，
 * 而不是恒绿。CRLF 口径：本文件不读源码文件，无该风险。
 */

import { describe, expect, it } from 'vitest'
import {
  createViewportCameraInitLedger,
  shouldApplyInitialViewportCamera,
} from '../viewportCameraInit'
import { createViewportManager } from '../viewportManager'

const REGION = 'r-viewport'

describe('初始机位施加纪律：纯函数判定', () => {
  it('首次装载（还没有相机状态）⇒ 施加（自动框选是需要的）', () => {
    expect(
      shouldApplyInitialViewportCamera({
        documentRevision: 1,
        lastAppliedDocumentRevision: null,
        hasCameraState: false,
      }),
    ).toBe(true)
  })

  it('⚠️ 同一份文档内的内容投影 ⇒ **不施加**（用户已调整的机位不得被重新框选）', () => {
    expect(
      shouldApplyInitialViewportCamera({
        documentRevision: 1,
        lastAppliedDocumentRevision: 1,
        hasCameraState: true,
      }),
      '这正是缺陷形态：编辑一格说明 / 移动方块（内容投影）后宿主重挂，不得重新 fit',
    ).toBe(false)
  })

  it('⚠️ 呈现卸载后重挂（同一份文档、机位仍在）⇒ **不施加**', () => {
    // M7-2 / D1：台账若在 `unregister`/`reset` 时被清空，重挂会被误判成"首装"。
    // 本行的输入就是重挂时的实际输入：机位跨组件存活（hasCameraState=true），
    // 台标记着**同一份文档**的施加记录（lastAppliedDocumentRevision=1）。
    expect(
      shouldApplyInitialViewportCamera({
        documentRevision: 1,
        lastAppliedDocumentRevision: 1,
        hasCameraState: true,
      }),
      '承载重建不得重新框选（否则用户机位被 fit 覆盖 —— G1/G2 的缺陷形态）',
    ).toBe(false)
  })

  it('换了一份文档（窄信号 documentRevision 变）⇒ 施加', () => {
    expect(
      shouldApplyInitialViewportCamera({
        documentRevision: 2,
        lastAppliedDocumentRevision: 1,
        hasCameraState: true,
      }),
    ).toBe(true)
  })

  it('相机状态被归零（装载路径 `resetAllViewportCameras`）⇒ 施加（不许停在"没有机位"）', () => {
    expect(
      shouldApplyInitialViewportCamera({
        documentRevision: 1,
        lastAppliedDocumentRevision: 1,
        hasCameraState: false,
      }),
    ).toBe(true)
  })
})

describe('台账：按 region 记"上次是哪份文档时框选的"', () => {
  it('同一 region、同一文档：取一次之后就拒绝（"只施加一次"不是空话）', () => {
    const ledger = createViewportCameraInitLedger()
    expect(ledger.claim(REGION, 1, true), '第一次取许可').toBe(true)
    expect(ledger.appliedRevisionOf(REGION)).toBe(1)
    expect(ledger.claim(REGION, 1, true), '同一份文档的第二次（宿主重挂）必须被拒').toBe(false)
    expect(ledger.claim(REGION, 1, true), '第三次同样被拒').toBe(false)
  })

  it('换文档 ⇒ 再取一次许可；不同 region 互不影响', () => {
    const ledger = createViewportCameraInitLedger()
    expect(ledger.claim(REGION, 1, true)).toBe(true)
    expect(ledger.claim('r-viewport-2', 1, false), '另一个视口首装要自己框选').toBe(true)
    expect(ledger.claim(REGION, 2, true), '换文档后可再施加').toBe(true)
    expect(ledger.appliedRevisionOf(REGION)).toBe(2)
  })
})

describe('台账挂在视口管理器上：**呈现卸载不改变台账**（M7-2 / D1）', () => {
  it('`reset` / `unregister`（槽位归零/注销）后重挂**不得**重新框选', () => {
    const vp = createViewportManager()
    vp.register(REGION)
    expect(vp.claimInitialViewportCamera(REGION, 1, true)).toBe(true)
    expect(vp.claimInitialViewportCamera(REGION, 1, true)).toBe(false)
    expect(vp.initialViewportCameraRevisionOf(REGION)).toBe(1)

    // 工作区切走：组件卸载 → 槽位归零/注销。机位（Main.cameras）**仍存活**。
    vp.reset(REGION)
    expect(vp.initialViewportCameraRevisionOf(REGION), 'presentation 卸载不得抹掉文档记号').toBe(1)
    expect(
      vp.claimInitialViewportCamera(REGION, 1, true),
      '重挂时同一份文档 + 机位仍在 ⇒ 不施加初始机位（否则覆盖用户机位）',
    ).toBe(false)

    vp.unregister(REGION)
    expect(vp.initialViewportCameraRevisionOf(REGION), 'unregister 同样只结束呈现，不清台账').toBe(1)
    expect(vp.claimInitialViewportCamera(REGION, 1, true), '重挂仍不得重新框选').toBe(false)

    // 对照：换文档（窄信号变）⇒ 仍可再施加 —— 本判据不是"恒不施加"。
    expect(vp.claimInitialViewportCamera(REGION, 2, true), '换文档必须重新取景').toBe(true)
  })

  it('首装（无相机状态）仍施加；`register` 幂等不误伤', () => {
    const vp = createViewportManager()
    vp.register(REGION)
    expect(vp.claimInitialViewportCamera(REGION, 1, false), '首次装载无状态 ⇒ 自动框选').toBe(true)
    expect(vp.register(REGION).id, 'register 幂等').toBe(REGION)
  })
})

describe('**负对照**：判据必须能区分"每次 attach 都施加"这一错误口径', () => {
  /** 改动前的口径：`attachViewport` 无条件 `exec('OPERATOR_INIT_VIEWPORT_CAMERA')`。 */
  const legacyAlwaysApply = (): boolean => true

  it('同一文档内的内容投影：旧口径判"施加"，正解判"不施加"（判据不是恒真/恒假）', () => {
    const projection = { documentRevision: 1, lastAppliedDocumentRevision: 1, hasCameraState: true }
    expect(legacyAlwaysApply(), '旧口径在该行必然施加 —— 这就是缺陷').toBe(true)
    expect(
      shouldApplyInitialViewportCamera(projection),
      '正解在该行必须不施加；若它也返回 true，则本批修复没有生效（判据会恒绿）',
    ).toBe(false)
  })

  it('首次装载：两种口径都施加（证明正解不是"恒不施加"的另一半空洞真）', () => {
    const firstLoad = { documentRevision: 1, lastAppliedDocumentRevision: null, hasCameraState: false }
    expect(legacyAlwaysApply()).toBe(true)
    expect(shouldApplyInitialViewportCamera(firstLoad)).toBe(true)
  })
})