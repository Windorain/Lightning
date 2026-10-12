/**
 * `adapters/export/renderDevice` —— **离屏 GL 设备端口及其 Three 实现**（#301 P10f/E）。
 *
 * ## 为什么在"离屏渲染端口"之下还要再有一层设备端口
 *
 * 本仓的 `gl@8.1.6`（headless-gl，devDependency）是 **WebGL 1.0**，而锁定的
 * `three ^0.174.0` 硬编码请求 **`webgl2`**（`three.module.js` 构造时无条件调
 * `texImage3D`）⇒ **无头环境下 `new THREE.WebGLRenderer` 必然抛**
 * （本批实测：`TypeError: gl.texImage3D is not a function`）。
 * `package.json` 属本批硬边界（不可换依赖），故"真实 GL 填充"这一段
 * **不可能**在 vitest 里跑通。
 *
 * 于是问题变成：**除了真 GL，其余每一环能不能被证明？**
 * 若把"建渲染器 + 建目标 + 读回"整段写死在离屏端口里，答案就是**不能** ——
 * vitest 只能断言源码字符串（结构指纹），"像素有没有真读回来""释放幂等不幂等"
 * 全都无从判起。
 *
 * ⇒ 把**设备**抽成端口（`#249` §4 规则 4「适配器实现端口」）：
 *
 * | 关注点 | 归属 |
 * |---|---|
 * | 取景政策（`CameraSpec`→相机）、求值/合批、逐帧调度、资源记账、释放 | **离屏渲染端口**（生产逻辑，vitest 全可跑） |
 * | 建渲染器/建渲染目标/`readRenderTargetPixels`/`dispose` | **本端口**（真 GL 那一层） |
 *
 * 判据因此分成两半，**两半都真跑**：
 *  - vitest：注入**受控设备**（记录调用序列、返回确定性像素），验证除 GL 驱动外的全链；
 *  - e2e：注入**本文件的 Three 实现**，在真浏览器里验证真实像素（A29 的像素面）。
 *
 * ## 本文件**只做 GL 驱动**，不做任何判定
 *
 * 它不决定"画什么""取哪个时间""材质用不用贴图"——那些都在离屏端口与呈现层。
 * 一条可核对的边界：**本文件不含 `request`/`frame`/`CameraSpec` 之类的词**，
 * 它的入参只有"已装配的呈现根 + 已构造的相机 + 渲染设置"。
 */

import * as THREE from 'three'
import { err, ok, unsupportedOperation, type Result } from '@/domain/errors'
import type { RenderSettings } from '@/domain/captureSpec'

/**
 * 一个已分配的离屏设备。
 *
 * 三件事：把**已装配**的呈现根渲染进渲染目标、读回逐像素 RGBA、释放。
 * `dispose` **必须幂等**（离屏端口在"取消/失败/完成"四条路径上都会释放它）。
 */
export interface OffscreenDevice {
  /**
   * 渲染一次并读回 RGBA 像素（行主序；原点在**左下** —— WebGL 口径，
   * 由编码器的 `flipY` 负责翻转成 PNG 的自上而下）。
   *
   * 读回失败必须是**结构化失败**（`Result` 的失败侧），不是抛异常。
   */
  renderAndRead(root: THREE.Object3D, camera: THREE.Camera): Result<Uint8Array>
  /** 释放渲染器与渲染目标。**幂等**。 */
  dispose(): void
}

/** 离屏设备工厂（装配层注入；e2e 用 {@link createThreeOffscreenDevice}，测试用受控实现）。 */
export interface OffscreenDeviceFactory {
  /** 按渲染设置分配一个设备；分配失败是结构化失败。 */
  acquire(render: RenderSettings): Result<{ readonly device: OffscreenDevice; readonly allocated: number }>
}

/**
 * **真实 GL 的 Three 实现**（e2e 用；vitest 里构造必然抛，见文件头）。
 *
 * `allocated: 2` = 渲染器 + 渲染目标 两个句柄 —— 它进 `ExportJob` 的
 * `releasedFor`，使"分配了几个、释放了几个"成为可断言的事实。
 */
export function createThreeOffscreenDevice(): OffscreenDeviceFactory {
  return {
    acquire(render: RenderSettings): Result<{ readonly device: OffscreenDevice; readonly allocated: number }> {
      const width = render.width
      const height = render.height
      if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
        return err(unsupportedOperation({ reason: 'offscreenRenderSizeInvalid', width, height }))
      }

      const transparent = render.background === 'transparent'
      let renderer: THREE.WebGLRenderer
      let target: THREE.WebGLRenderTarget
      try {
        renderer = new THREE.WebGLRenderer({ antialias: false, alpha: transparent })
        renderer.setPixelRatio(1)
        renderer.setSize(width, height, false)
        renderer.outputColorSpace = THREE.SRGBColorSpace
        target = new THREE.WebGLRenderTarget(width, height, {
          format: THREE.RGBAFormat,
          type: THREE.UnsignedByteType,
        })
      } catch (e) {
        // 无头/无 WebGL2 环境（本仓 vitest 即此情形）：**结构化失败**而不是让异常穿透 ——
        // 穿透会让"环境不支持"与"实现崩了"压成同一个结果（调用方无从区分该报缺能力还是该重试）。
        return err(unsupportedOperation({ reason: 'offscreenDeviceUnavailable', detail: String(e) }))
      }

      if (transparent) renderer.setClearColor(0x000000, 0)
      else renderer.setClearColor(render.background, 1)

      const scene = new THREE.Scene()
      scene.background = transparent ? null : new THREE.Color(render.background)
      // 呈现层用 `MeshBasicMaterial`（见 `presentation/presenter#createMaterial`），
      // 故**不需要**光源；加了反而会成为"画面亮度从哪来"的第二个来源。

      let disposed = false
      return ok({
        allocated: 2,
        device: {
          renderAndRead(root: THREE.Object3D, camera: THREE.Camera): Result<Uint8Array> {
            if (disposed) return err(unsupportedOperation({ reason: 'offscreenDeviceDisposed' }))
            /**
             * ## 为什么渲染前要**记住并还原**原父节点（A29 的"不改用户视口"）
             *
             * `THREE.Scene.add(root)` 会把 `root` 从它**原来的**父节点上**摘下来**
             * （Three 的 `add` 隐含 `removeFromParent`）。若渲染后只调 `scene.remove(root)`，
             * 那个 `root` 会**永久离开**它原本所在的场景树 —— 即一次导出把
             * **用户正在看的视口**改坏了（画面变空），而且**不报错**。
             *
             * 当下生产形态里呈现根**没有**父节点（`composition/presenterSession` 的根对象
             * 是"平行路径"，不挂进视口的内容组 —— 见 `presenter-surface-dual-track` 接缝），
             * 故 `add`/`remove` 恰好平衡。但那是**当下的巧合**，不是本文件可以依赖的性质：
             * 一旦将来把呈现根挂进视口（正是该接缝的退出方向），这里就会静默改坏用户画面。
             *
             * ⇒ 显式保存原父节点并在 `finally` 里还原。这使"导出不改变用户视口"
             * 由**结构**保证，而不是靠"它现在恰好没有父节点"。
             */
            const previousParent = root.parent
            try {
              scene.add(root)
              // 呈现根不被实时渲染循环驱动 ⇒ 世界矩阵必须**显式**刷新，
              // 否则读到的是构造时的单位矩阵（静默错位）。
              root.updateMatrixWorld(true)
              camera.updateMatrixWorld(true)

              renderer.setRenderTarget(target)
              renderer.render(scene, camera)
              renderer.setRenderTarget(null)

              const pixels = new Uint8Array(width * height * 4)
              renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels)
              return ok(pixels)
            } catch (e) {
              return err(unsupportedOperation({ reason: 'offscreenReadbackFailed', detail: String(e) }))
            } finally {
              // 还原到原父节点（如上：`add` 已经把 root 摘下来了）。
              if (previousParent === null || previousParent === undefined) scene.remove(root)
              else previousParent.add(root)
            }
          },
          dispose(): void {
            if (disposed) return // 幂等（离屏端口在四条路径上都会调它）
            disposed = true
            target.dispose()
            renderer.dispose()
          },
        },
      })
    },
  }
}
