package com.lightning.mod.client.meshcapture;

/**
 * 「忠实复现捕获层」1.0 的录窗通道标识。
 * <p>
 * 为什么存在：现行捕获只有一个录制挂点（{@code Tessellator.addVertex} 基类注入），实证存在三个缺口
 * （GTNHLib {@code DirectTessellator} 覆写 addVertex 致基类注入不触发、LP 管几何 TESR-only、区块编译窗口无钩子）。
 * 通道枚举让每个流入的四边形都能回答「它从哪条渲染路径来」，是静默漏录检测（zeroFlow）与按通道聚合诊断的前提。
 * <p>
 * 纯观察论证：本枚举只是标签，不参与任何渲染决策；通道取值由录窗开启点（Mixin 注入处）如实记录。
 */
public enum CaptureChannel {

    /** 区块编译窗口：{@code WorldRenderer.updateRenderer} 内的静态几何（归属键 = 渲染器 16³ 段角 posX/Y/Z）。 */
    BLOCK_COMPILE,
    /** TESR 逐帧窗口：{@code TileEntityRendererDispatcher.renderTileEntity} 内的动态几何（归属键 = TE 坐标）。 */
    TESR,
    /** FMP（ForgeMultipart）动态通道：1.0 仅保留枚举位，尚无开窗点（留给 1.1/后续）。 */
    FMP_DYNAMIC,
    /** 旧逐格驱动路径（{@code MeshCaptureService} 的 beginBlock/endBlock），兼容期内语义不变。 */
    LEGACY_PER_CELL
}
