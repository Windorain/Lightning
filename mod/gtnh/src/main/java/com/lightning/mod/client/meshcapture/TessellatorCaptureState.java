package com.lightning.mod.client.meshcapture;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.block.Block;
import net.minecraft.client.renderer.Tessellator;
import net.minecraft.util.ResourceLocation;

import org.lwjgl.opengl.GL11;

import com.lightning.mod.client.meshcapture.finish.BlockCaptureFinishContext;
import com.lightning.mod.client.meshcapture.finish.BlockCaptureFinishRegistry;

import cpw.mods.fml.common.FMLLog;

/**
 * 录制 {@link Tessellator#addVertex}：按当前 {@link Tessellator} draw mode 组批——{@code GL_QUADS} 每 4 顶点一面；
 * {@code GL_TRIANGLES} 每 3 顶点一面，并展开为 Wiki 兼容的伪四边形 {@code (v0,v1,v2,v2)}。
 * <p>
 * <strong>导出契约（与 Wiki 一致）</strong>：{@link #endBlock} 写入的顶点为<strong>块局部</strong>，相对当前方块最小角
 * [0,1]³。变换两步：
 * <ol>
 * <li>减 Tessellator {@code setTranslation}：缓冲内 xyz = addVertex 入参 + (xOffset,yOffset,zOffset)（见 MCP Tessellator）。</li>
 * <li>按 {@link CaptureCoordinatePolicy}：默认路径下<strong>每个四边形</strong>在两种原点下对 {@code [0,1]³} 的贴近程度选原点：对该 quad 的顶点（已去
 * Tessellator
 * offset）分别尝试减 {@code (0,0,0)} 与减世界角 {@code (wx,wy,wz)}，取使「到单位立方惩罚和」更小者；平票时取 {@code (0,0,0)}。</li>
 * </ol>
 * 使用<strong>全局</strong> {@link Frame} 而非 {@link ThreadLocal}，以便 GTNH Angelica 等
 * {@code @ThreadSafeISBRH(perThread = true)} 在<strong>工作线程</strong>写入 Tessellator 时仍能命中录制状态。
 * <p>
 * <strong>「忠实复现捕获层」PR-1 录窗扩展</strong>：新增 {@link CaptureChannel} 通道录窗
 * （{@link #beginWindow}/{@link #endWindow}），供真实渲染循环内的纯观察钩子使用
 * （区块编译 {@code WorldRenderer.updateRenderer}、TESR 逐帧 {@code renderTileEntity}）。
 * 每个窗口维护开启时的归属键、流入四边形计数与零流入（zeroFlow）检测；顶点闭合四边形时打
 * 通道、窗口归属键、质心分箱（{@link CaptureBinning}）与跨箱告警。窗口不允许嵌套/排队——
 * 已有活动窗口时 {@link #beginWindow} 显式抛 {@link IllegalStateException}。
 * 旧 API {@link #beginBlock}/{@link #endBlock} 签名与语义不变，内部记为
 * {@link CaptureChannel#LEGACY_PER_CELL} 窗口，兼容期内零行为变化。
 */
public final class TessellatorCaptureState {

    private static final Frame CAPTURE = new Frame();

    static {
        // 触发 CaptureDiagnostics 初始化：注册 sde.captureDiag.file 的退出落盘钩子
        CaptureDiagnostics.touch();
    }

    /**
     * 录窗总开关（「一次设定、不反复操纵」）：未打开时新通道 Mixin 不开窗、零开销零行为。
     * 旧 LEGACY_PER_CELL 路径（beginBlock/endBlock）不受本开关影响——它由 MeshCaptureService 自行驱动。
     */
    private static volatile boolean windowsArmed;

    /**
     * 「撤防请求待生效」：{@link #disarmWindows()} 撞上在飞窗口时置位，由该窗口关闭时兑现。
     *
     * <p>
     * 为什么需要它：两个开窗 Mixin 的 {@code RETURN} 注入点都以
     * {@link #areWindowsArmed()} 为门（未布防即提前返回）。若在窗口<b>开着</b>的时候把开关就地置假，
     * 那次关闭会被跳过，{@code CAPTURE.active} 永远为真，此后每一次 {@link #beginWindow} 都抛
     * 「录窗嵌套/排队被拒绝」——一次撤防把整条录窗通道打死，且现场只留下一条看不出因果的异常。
     * 故撤防必须等窗口自然关闭后再兑现。
     */
    private static volatile boolean windowsDisarmPending;

    /** P0 惯例：坐标系一次性自证日志（首 BLOCK_COMPILE 窗口开启 / 首顶点），每会话各打一次。 */
    private static boolean blockCompileSelfProofWindowLogged;

    private static boolean blockCompileSelfProofVertexLogged;

    /** {@link net.minecraft.client.model.ModelRenderer#render} 当前 scale 参数，供 glCallList 内联路径使用 */
    private static volatile float activeModelRendererScale = 0.0625F;

    private static final double BOUNDS_ASSERT_LO = -0.06;

    private static final double BOUNDS_ASSERT_HI = 1.06;

    private static final boolean ASSERT_BLOCK_LOCAL_BOUNDS = Boolean
        .parseBoolean(System.getProperty("sde.assertBlockLocalBounds", "false"));

    private TessellatorCaptureState() {}

    // ------------------------------------------------------------------ PR-1 录窗 API

    /** 打开录窗总开关（诊断会话/探针启动时调用一次）。 */
    public static void armWindows() {
        windowsDisarmPending = false;
        windowsArmed = true;
    }

    /**
     * 撤防录窗总开关（控制面 {@code capture.diag} 的 {@code arm:false} 走这里）。
     *
     * <p>
     * <b>不在飞窗口上就地撤防</b>：{@code CAPTURE.active} 为真时只挂「待兑现」标记，
     * 由该窗口关闭时（{@link #endWindowInternal}）兑现——理由见 {@link #windowsDisarmPending}。
     * 无在飞窗口时立即置假。
     *
     * @return 是否已经生效（false = 有在飞窗口，撤防已排定但尚未兑现）
     */
    public static boolean disarmWindows() {
        synchronized (CAPTURE) {
            if (CAPTURE.active) {
                windowsDisarmPending = true;
                return false;
            }
            windowsDisarmPending = false;
            windowsArmed = false;
            return true;
        }
    }

    /** 是否有撤防请求尚未兑现（在飞窗口关闭时自动兑现）。 */
    public static boolean isWindowDisarmPending() {
        return windowsDisarmPending;
    }

    /** 新通道 Mixin 的开窗前检查：未打开时不产生任何录窗行为。 */
    public static boolean areWindowsArmed() {
        return windowsArmed;
    }

    /**
     * 开启一个通道录窗。窗口嵌套/排队被拒绝：已有活动窗口时显式抛 {@link IllegalStateException}
     * （静默叠窗会让 zeroFlow 与归属键失真）。{@link CaptureChannel#LEGACY_PER_CELL} 不允许走本 API
     * （旧路径用 {@link #beginBlock}）。
     *
     * @param attrX/Y/Z 窗口归属键（BLOCK_COMPILE = 渲染器 posX/Y/Z；TESR = TE 坐标）
     * @param tag       诊断用自由文本（如 chunk 坐标 / TE 类名）
     */
    public static void beginWindow(CaptureChannel channel, int attrX, int attrY, int attrZ, String tag) {
        if (channel == null) {
            throw new IllegalArgumentException("channel == null");
        }
        if (channel == CaptureChannel.LEGACY_PER_CELL) {
            throw new IllegalArgumentException("LEGACY_PER_CELL 窗口由 beginBlock 开启，不走 beginWindow");
        }
        synchronized (CAPTURE) {
            Frame f = CAPTURE;
            if (f.active) {
                throw new IllegalStateException(
                    "录窗嵌套/排队被拒绝：已有活动窗口 channel=" + f.channel
                        + " attr=("
                        + f.attrX
                        + ","
                        + f.attrY
                        + ","
                        + f.attrZ
                        + ") tag="
                        + f.windowTag
                        + "；新窗口 channel="
                        + channel
                        + " attr=("
                        + attrX
                        + ","
                        + attrY
                        + ","
                        + attrZ
                        + ") tag="
                        + tag);
            }
            openWindowLocked(f, channel, attrX, attrY, attrZ, tag);
            if (channel == CaptureChannel.BLOCK_COMPILE && !blockCompileSelfProofWindowLogged) {
                blockCompileSelfProofWindowLogged = true;
                String line = "[SDE][capture] BLOCK_COMPILE 首窗口开启 attr=(" + attrX
                    + ","
                    + attrY
                    + ","
                    + attrZ
                    + ") tag="
                    + f.windowTag;
                logSelfProofBestEffort(line);
            }
        }
    }

    /**
     * 关闭当前通道录窗并丢弃已录四边形（PR-1 默认不驻留几何，只计数）。
     * <p>
     * {@link #armWindowDrainSink} 已布防时，<strong>TESR</strong> 窗口的关闭改走
     * {@link #endWindowAndDrain(List)} 并把「窗口归属键 + 四边形」交给汇（drain-dump）；未布防（默认）时
     * 逐字节保持原语义。
     *
     * @return 本窗口流入四边形数；当前无新通道窗口时返回 -1（容忍多余调用，不抛——渲染循环异常路径兜底）
     */
    public static int endWindow() {
        WindowDrainSink sink = windowDrainSink;
        if (sink == null) {
            return endWindowInternal(null);
        }
        // 监视器可重入（同线程）：此处持锁只为「读通道 + 关窗」原子，endWindowAndDrain 内部再取一次不构成死锁
        synchronized (CAPTURE) {
            Frame f = CAPTURE;
            if (!f.active || f.channel != CaptureChannel.TESR) {
                return endWindowInternal(null);
            }
            int attrX = f.attrX;
            int attrY = f.attrY;
            int attrZ = f.attrZ;
            String tag = f.windowTag;
            List<CapturedQuad> drained = new ArrayList<>();
            int count = endWindowAndDrain(drained);
            try {
                sink.onWindowDrained(CaptureChannel.TESR, attrX, attrY, attrZ, tag, drained);
            } catch (Throwable t) {
                // 汇（探针侧）抛错绝不能影响渲染循环：吞掉并尽力留痕
                logDrainSinkFailure(t);
            }
            return count;
        }
    }

    /**
     * 关闭当前通道录窗并把已录四边形移入 {@code out}（PR-2 编排层接口：MeshCaptureService 切换编排时
     * 从录窗层取走窗口几何；PR-1 由 {@link #endWindow()} 的 drain 路由与验收探针调用）。
     */
    public static int endWindowAndDrain(List<CapturedQuad> out) {
        if (out == null) {
            throw new IllegalArgumentException("out == null");
        }
        return endWindowInternal(out);
    }

    /**
     * TESR 录窗 drain 汇（控制面 {@code capture.diag} 的 {@code drainDump:true} 走这里，
     * 见 {@code client/controlplane/mc/capture/CaptureDiagAction}）。
     * <p>
     * 布防语义：布防后 TESR 录窗关闭走 {@link #endWindowAndDrain(List)}，把<strong>窗口归属键（TE 世界坐标）</strong>
     * 与该窗口实录四边形交给汇；未布防时 {@link #endWindow()} 与 PR-1 原行为完全一致（几何关闭即丢，只计数）。
     * 只对 {@link CaptureChannel#TESR} 生效：BLOCK_COMPILE 窗口数在实测会话里是 3 万+量级，驻留其四边形既无必要
     * 也会给渲染线程添负担。
     */
    public interface WindowDrainSink {

        void onWindowDrained(CaptureChannel channel, int attrX, int attrY, int attrZ, String tag,
            List<CapturedQuad> quads);
    }

    /** 当前 drain 汇；{@code null} = 未布防（默认，零行为变化）。 */
    private static volatile WindowDrainSink windowDrainSink;

    /** 布防 TESR 录窗 drain 汇；{@code null} 等价于 {@link #disarmWindowDrainSink()}。 */
    public static void armWindowDrainSink(WindowDrainSink sink) {
        windowDrainSink = sink;
    }

    /** 撤防 drain 汇（回到「关窗即丢几何」的 PR-1 默认行为）。 */
    public static void disarmWindowDrainSink() {
        windowDrainSink = null;
    }

    public static boolean isWindowDrainArmed() {
        return windowDrainSink != null;
    }

    private static void logDrainSinkFailure(Throwable t) {
        try {
            FMLLog.warning("[SDE][capture] 窗口 drain 汇抛错（渲染循环不受影响）: %s", String.valueOf(t));
        } catch (Throwable ignored) {
            // 非 FML 环境（纯 JVM 单测）：日志通道不可用
        }
    }

    private static int endWindowInternal(List<CapturedQuad> drainTo) {
        synchronized (CAPTURE) {
            Frame f = CAPTURE;
            if (!f.active || f.channel == null || f.channel == CaptureChannel.LEGACY_PER_CELL) {
                return -1;
            }
            flushPartialQuad(f);
            int count = f.windowQuadCount;
            CaptureDiagnostics.noteWindowClosed(f.channel, f.attrX, f.attrY, f.attrZ, f.windowTag, count);
            if (drainTo != null) {
                drainTo.addAll(f.quadsForBlock);
            }
            f.quadsForBlock.clear();
            f.active = false;
            f.channel = null;
            f.windowMvBaselineValid = false;
            // 撤防兑现点：disarmWindows() 撞上在飞窗口时挂的标记在此消费（见 windowsDisarmPending）
            if (windowsDisarmPending) {
                windowsDisarmPending = false;
                windowsArmed = false;
            }
            return count;
        }
    }

    /**
     * TESR 录窗开启处（{@code MixinTesrDispatcherWindow}）快照的 {@code inv(GL_MODELVIEW)}（列主序 16 项）。
     * 与旧动态扩展基线同一份机制，只是改由录窗生命周期接入；<strong>不</strong>开启旧动态扩展相位
     * （否则会触发 ModelRenderer display-list 改写路径，违反纯观察）。
     */
    public static void armWindowModelViewBaselineInverse(float[] inverseColumnMajor16) {
        synchronized (CAPTURE) {
            if (CAPTURE.active && inverseColumnMajor16 != null && inverseColumnMajor16.length >= 16) {
                System.arraycopy(inverseColumnMajor16, 0, CAPTURE.windowMvBaselineInverse, 0, 16);
                CAPTURE.windowMvBaselineValid = true;
            }
        }
    }

    /** 录制路径的 MODELVIEW 变换总门：旧动态扩展相位 或 窗口基线已布防（两路径互斥，不会同时为真）。 */
    public static boolean isModelViewTransformArmed() {
        synchronized (CAPTURE) {
            return CAPTURE.active && (CAPTURE.dynamicExtensionVertexRecording || CAPTURE.windowMvBaselineValid);
        }
    }

    /** 是否有可用基线逆（旧动态扩展基线优先，其次窗口基线）。 */
    public static boolean hasActiveModelViewBaseline() {
        synchronized (CAPTURE) {
            return CAPTURE.active
                && (CAPTURE.dynamicExtensionInverseMvAtRenderStartValid || CAPTURE.windowMvBaselineValid);
        }
    }

    /** 拷贝当前生效的基线逆（列主序 16 项；旧动态扩展基线优先，其次窗口基线）。 */
    public static void copyActiveModelViewBaselineInverse(float[] outColumnMajor16) {
        synchronized (CAPTURE) {
            if (CAPTURE.dynamicExtensionInverseMvAtRenderStartValid) {
                System.arraycopy(CAPTURE.dynamicExtensionInverseMvAtRenderStart, 0, outColumnMajor16, 0, 16);
            } else {
                System.arraycopy(CAPTURE.windowMvBaselineInverse, 0, outColumnMajor16, 0, 16);
            }
        }
    }

    /**
     * 旧逐格捕获（{@code MeshCaptureService}）语义判据：录制激活且通道为 {@link CaptureChannel#LEGACY_PER_CELL}。
     * 新通道录窗期间本判据为 false——依赖它的 Mixin（ModelRenderer display-list 改写、渲染 pass 覆盖）
     * 在新窗口里保持纯观察。
     */
    public static boolean isLegacyPerCellCapture() {
        synchronized (CAPTURE) {
            return CAPTURE.active && CAPTURE.channel == CaptureChannel.LEGACY_PER_CELL;
        }
    }

    private static void openWindowLocked(Frame f, CaptureChannel channel, int attrX, int attrY, int attrZ, String tag) {
        f.channel = channel;
        f.attrX = attrX;
        f.attrY = attrY;
        f.attrZ = attrZ;
        f.windowTag = tag != null ? tag : "";
        f.windowQuadCount = 0;
        f.windowMvBaselineValid = false;
        f.lastBoundTextureKey = "";
        f.quadsForBlock.clear();
        f.currentQuadVerts.clear();
        f.dynamicExtensionVertexRecording = false;
        f.dynamicExtensionInverseMvAtRenderStartValid = false;
        f.active = true;
    }

    // ------------------------------------------------------------------ 旧 LEGACY_PER_CELL API（语义不变）

    public static boolean isRecording() {
        return CAPTURE.active;
    }

    /**
     * @param blockX/Y/Z      结构索引格（与 cellGrid 一致）
     * @param worldBlockX/Y/Z 该格对应的世界方块角坐标（整数）
     * @param captureBlock    当前烘焙的方块（可为 null，则策略仅依赖 registryKey/renderType）
     * @param registryKey     与 palette 一致，如 {@code minecraft:stone}
     */
    public static void beginBlock(int blockX, int blockY, int blockZ, String instanceLabel, int worldBlockX,
        int worldBlockY, int worldBlockZ, Block captureBlock, int blockMeta, int renderType, String registryKey) {
        synchronized (CAPTURE) {
            Frame f = CAPTURE;
            f.blockX = blockX;
            f.blockY = blockY;
            f.blockZ = blockZ;
            f.instanceLabel = instanceLabel;
            f.worldBlockX = worldBlockX;
            f.worldBlockY = worldBlockY;
            f.worldBlockZ = worldBlockZ;
            f.captureBlock = captureBlock;
            f.blockMeta = blockMeta;
            f.renderType = renderType;
            f.registryKey = registryKey != null ? registryKey : "";
            f.lastBoundTextureKey = "";
            f.quadsForBlock.clear();
            f.currentQuadVerts.clear();
            f.dynamicExtensionVertexRecording = false;
            f.dynamicExtensionInverseMvAtRenderStartValid = false;
            // PR-1：旧路径内部记为 LEGACY_PER_CELL 窗口（归属键 = 世界方块角，tag = registryKey）。
            // 注意：本方法故意不在 active 时抛异常——旧语义是静默重置帧（兼容期零行为变化）。
            f.channel = CaptureChannel.LEGACY_PER_CELL;
            f.attrX = worldBlockX;
            f.attrY = worldBlockY;
            f.attrZ = worldBlockZ;
            f.windowTag = f.registryKey;
            f.windowQuadCount = 0;
            f.windowMvBaselineValid = false;
            f.active = true;
        }
    }

    /**
     * 由 {@code TextureManager#bindTexture} mixin 在捕获激活时更新「当前 bind」；每个顶点在 {@link #onVertexRecorded} 时复制到
     * {@link CapturedVertex#textureBindHintAtVertex}，闭合四边形时再聚合为 {@link CapturedQuad#bindTextureHint}。
     */
    public static void noteTextureBind(ResourceLocation loc) {
        synchronized (CAPTURE) {
            if (!CAPTURE.active || loc == null) {
                return;
            }
            String dom = loc.getResourceDomain();
            if (dom == null || dom.isEmpty()) {
                dom = "minecraft";
            }
            String path = loc.getResourcePath();
            if (path == null) {
                path = "";
            }
            CAPTURE.lastBoundTextureKey = dom + ":" + MaterialKeyResolver.normalizeMaterialKey(path);
        }
    }

    /**
     * 仅在本帧 {@link #beginBlock} 激活且正在执行动态扩展顶点录制（如 {@code renderTileEntityAt}）时为 true。
     */
    public static void beginDynamicExtensionVertexPhase() {
        synchronized (CAPTURE) {
            if (CAPTURE.active) {
                CAPTURE.dynamicExtensionVertexRecording = true;
            }
        }
    }

    public static void endDynamicExtensionVertexPhase() {
        synchronized (CAPTURE) {
            CAPTURE.dynamicExtensionVertexRecording = false;
            CAPTURE.dynamicExtensionInverseMvAtRenderStartValid = false;
        }
    }

    /** 为 true 时 {@link net.minecraft.client.model.ModelRenderer} 走内联绘制，且 Tessellator 顶点做相对 MODELVIEW 变换。 */
    public static boolean isDynamicExtensionVertexRecording() {
        synchronized (CAPTURE) {
            return CAPTURE.active && CAPTURE.dynamicExtensionVertexRecording;
        }
    }

    /**
     * 动态扩展入口处的 {@code inv(GL_MODELVIEW)}（列主序 16 项），用于 {@code inv(M0) * M_now * v}。
     */
    public static void armDynamicPassModelViewBaselineInverse(float[] inverseColumnMajor16) {
        synchronized (CAPTURE) {
            if (CAPTURE.active && inverseColumnMajor16 != null && inverseColumnMajor16.length >= 16) {
                System.arraycopy(inverseColumnMajor16, 0, CAPTURE.dynamicExtensionInverseMvAtRenderStart, 0, 16);
                CAPTURE.dynamicExtensionInverseMvAtRenderStartValid = true;
            }
        }
    }

    public static boolean hasDynamicPassModelViewBaseline() {
        synchronized (CAPTURE) {
            return CAPTURE.active && CAPTURE.dynamicExtensionInverseMvAtRenderStartValid;
        }
    }

    public static void copyDynamicPassModelViewBaselineInverse(float[] outColumnMajor16) {
        synchronized (CAPTURE) {
            System.arraycopy(CAPTURE.dynamicExtensionInverseMvAtRenderStart, 0, outColumnMajor16, 0, 16);
        }
    }

    /** @deprecated 使用 {@link #beginDynamicExtensionVertexPhase()} */
    @Deprecated
    public static void beginTesrPostVertexPhase() {
        beginDynamicExtensionVertexPhase();
    }

    /** @deprecated 使用 {@link #endDynamicExtensionVertexPhase()} */
    @Deprecated
    public static void endTesrPostVertexPhase() {
        endDynamicExtensionVertexPhase();
    }

    /** @deprecated 使用 {@link #isDynamicExtensionVertexRecording()} */
    @Deprecated
    public static boolean isTesrPostRecording() {
        return isDynamicExtensionVertexRecording();
    }

    /** @deprecated 使用 {@link #armDynamicPassModelViewBaselineInverse(float[])} */
    @Deprecated
    public static void armTesrModelViewBaselineInverse(float[] inverseColumnMajor16) {
        armDynamicPassModelViewBaselineInverse(inverseColumnMajor16);
    }

    /** @deprecated 使用 {@link #hasDynamicPassModelViewBaseline()} */
    @Deprecated
    public static boolean hasTesrModelViewBaseline() {
        return hasDynamicPassModelViewBaseline();
    }

    /** @deprecated 使用 {@link #copyDynamicPassModelViewBaselineInverse(float[])} */
    @Deprecated
    public static void copyTesrModelViewBaselineInverse(float[] outColumnMajor16) {
        copyDynamicPassModelViewBaselineInverse(outColumnMajor16);
    }

    public static void setActiveModelRendererScale(float scale) {
        activeModelRendererScale = scale;
    }

    public static float getActiveModelRendererScale() {
        return activeModelRendererScale;
    }

    public static int currentBlockRecordedQuadCount() {
        synchronized (CAPTURE) {
            if (!CAPTURE.active) {
                return 0;
            }
            return CAPTURE.quadsForBlock.size();
        }
    }

    public static void endBlock(CapturedBlockInstance target) {
        synchronized (CAPTURE) {
            Frame f = CAPTURE;
            flushPartialQuad(f);
            BlockCaptureFinishRegistry.runAll(
                new BlockCaptureFinishContext(
                    f.registryKey,
                    f.captureBlock,
                    f.blockMeta,
                    f.renderType,
                    f.quadsForBlock));
            // PR-1：旧路径窗口事件（zeroFlow 检测与诊断聚合；finish registry 之前的流入计数）
            CaptureDiagnostics.noteWindowClosed(
                CaptureChannel.LEGACY_PER_CELL,
                f.attrX,
                f.attrY,
                f.attrZ,
                f.windowTag,
                f.windowQuadCount);
            normalizeVerticesToBlockContract(f);
            f.active = false;
            target.x = f.blockX;
            target.y = f.blockY;
            target.z = f.blockZ;
            target.label = f.instanceLabel;
            target.quads.addAll(f.quadsForBlock);
            f.quadsForBlock.clear();
        }
    }

    private static void normalizeVerticesToBlockContract(Frame f) {
        if (f.quadsForBlock.isEmpty()) {
            return;
        }
        CaptureCoordinatePolicy.Kind kind = CaptureCoordinatePolicy
            .resolve(f.captureBlock, f.blockMeta, f.renderType, f.registryKey);

        List<CapturedQuad> rebuilt = new ArrayList<>(f.quadsForBlock.size());
        for (CapturedQuad q : f.quadsForBlock) {
            double[] origin = resolveOriginForQuad(q, f, kind);
            double ox = origin[0];
            double oy = origin[1];
            double oz = origin[2];
            List<CapturedVertex> nv = new ArrayList<>(4);
            for (CapturedVertex v : q.vertices) {
                double x0 = v.x - v.tessOffsetX;
                double y0 = v.y - v.tessOffsetY;
                double z0 = v.z - v.tessOffsetZ;
                double xf = x0 - ox;
                double yf = y0 - oy;
                double zf = z0 - oz;
                if (ASSERT_BLOCK_LOCAL_BOUNDS) {
                    assertBlockLocalVertex(f.registryKey, f.renderType, kind, xf, yf, zf);
                }
                nv.add(
                    new CapturedVertex(
                        xf,
                        yf,
                        zf,
                        v.u,
                        v.v,
                        v.brightness,
                        v.colorArgb,
                        0.0,
                        0.0,
                        0.0,
                        v.textureBindHintAtVertex));
            }
            CapturedQuad nq = new CapturedQuad(nv);
            nq.materialKey = q.materialKey;
            nq.samplerIndex = q.samplerIndex;
            nq.bindTextureHint = q.bindTextureHint;
            nq.materialAtlasKind = q.materialAtlasKind;
            nq.materialUsesStandaloneTexture = q.materialUsesStandaloneTexture;
            nq.fromDynamicExtensionPass = q.fromDynamicExtensionPass;
            nq.channel = q.channel;
            nq.attribX = q.attribX;
            nq.attribY = q.attribY;
            nq.attribZ = q.attribZ;
            nq.binX = q.binX;
            nq.binY = q.binY;
            nq.binZ = q.binZ;
            nq.crossBin = q.crossBin;
            rebuilt.add(nq);
        }
        f.quadsForBlock.clear();
        f.quadsForBlock.addAll(rebuilt);
    }

    /**
     * 坐标落在 {@code [0,1]} 内代价为 0，否则为到该区间边界的平方距离（可微、对称，便于比较两种原点）。
     */
    private static double unitIntervalPenalty(double t) {
        if (t < 0.0) {
            return t * t;
        }
        if (t > 1.0) {
            double e = t - 1.0;
            return e * e;
        }
        return 0.0;
    }

    /**
     * 对该 quad 各顶点在减 {@code (ox,oy,oz)} 后，累计到 {@code [0,1]³} 的偏离惩罚（越小越贴近块局部契约）。
     */
    private static double closenessCostToUnitCube(List<CapturedVertex> verts, double ox, double oy, double oz) {
        double cost = 0.0;
        for (CapturedVertex v : verts) {
            double x = v.x - v.tessOffsetX - ox;
            double y = v.y - v.tessOffsetY - oy;
            double z = v.z - v.tessOffsetZ - oz;
            cost += unitIntervalPenalty(x) + unitIntervalPenalty(y) + unitIntervalPenalty(z);
        }
        return cost;
    }

    /**
     * 为单个四边形选择减去的原点：在 {@code (0,0,0)} 与 {@code (wx,wy,wz)} 间取使 {@link #closenessCostToUnitCube} 更小者；平票取零原点。
     */
    private static double[] resolveOriginForQuad(CapturedQuad q, Frame f, CaptureCoordinatePolicy.Kind kind) {
        if (kind == CaptureCoordinatePolicy.Kind.ALREADY_BLOCK_LOCAL) {
            return new double[] { 0.0, 0.0, 0.0 };
        }
        double wx = f.worldBlockX;
        double wy = f.worldBlockY;
        double wz = f.worldBlockZ;
        double c0 = closenessCostToUnitCube(q.vertices, 0.0, 0.0, 0.0);
        double cw = closenessCostToUnitCube(q.vertices, wx, wy, wz);
        if (cw < c0) {
            return new double[] { wx, wy, wz };
        }
        return new double[] { 0.0, 0.0, 0.0 };
    }

    /**
     * 各顶点在 {@link #onVertexRecorded} 时快照的 bind；闭合四边形时聚合成 {@link CapturedQuad#bindTextureHint}（多数票，平票取顶点顺序先出现者）。
     */
    private static String aggregateBindHintsForQuad(List<CapturedVertex> verts) {
        if (verts.isEmpty()) {
            return "";
        }
        List<String> hints = new ArrayList<>(verts.size());
        for (CapturedVertex v : verts) {
            String h = v.textureBindHintAtVertex;
            hints.add(h != null ? h : "");
        }
        String h0 = hints.get(0);
        boolean allSame = true;
        for (String h : hints) {
            if (!h0.equals(h)) {
                allSame = false;
                break;
            }
        }
        if (allSame) {
            return h0;
        }
        Map<String, Integer> counts = new HashMap<>();
        for (String h : hints) {
            if (h.isEmpty()) {
                continue;
            }
            Integer n = counts.get(h);
            counts.put(h, n == null ? 1 : n + 1);
        }
        if (counts.isEmpty()) {
            return "";
        }
        int max = 0;
        for (int c : counts.values()) {
            max = Math.max(max, c);
        }
        for (String h : hints) {
            if (!h.isEmpty() && counts.get(h) == max) {
                return h;
            }
        }
        return "";
    }

    private static void assertBlockLocalVertex(String registryKey, int renderType, CaptureCoordinatePolicy.Kind kind,
        double x, double y, double z) {
        if (x < BOUNDS_ASSERT_LO || y < BOUNDS_ASSERT_LO
            || z < BOUNDS_ASSERT_LO
            || x > BOUNDS_ASSERT_HI
            || y > BOUNDS_ASSERT_HI
            || z > BOUNDS_ASSERT_HI) {
            FMLLog.warning(
                "[SDE] assertBlockLocalBounds: vertex (" + x
                    + ","
                    + y
                    + ","
                    + z
                    + ") outside [0,1] for "
                    + registryKey
                    + " renderType="
                    + renderType
                    + " kind="
                    + kind);
        }
    }

    public static void onVertexRecorded(double x, double y, double z, double u, double v, int brightness, int colorArgb,
        double tessOffsetX, double tessOffsetY, double tessOffsetZ, int tessellatorDrawMode) {
        synchronized (CAPTURE) {
            Frame fr = CAPTURE;
            if (!fr.active) {
                return;
            }
            if (fr.channel == CaptureChannel.BLOCK_COMPILE && !blockCompileSelfProofVertexLogged) {
                blockCompileSelfProofVertexLogged = true;
                String line = "[SDE][capture] BLOCK_COMPILE 首顶点自证 window=(" + fr.attrX
                    + ","
                    + fr.attrY
                    + ","
                    + fr.attrZ
                    + ") raw=("
                    + x
                    + ","
                    + y
                    + ","
                    + z
                    + ") derivedWorld=("
                    + (x - tessOffsetX)
                    + ","
                    + (y - tessOffsetY)
                    + ","
                    + (z - tessOffsetZ)
                    + ") tessOffset=("
                    + tessOffsetX
                    + ","
                    + tessOffsetY
                    + ","
                    + tessOffsetZ
                    + ")";
                logSelfProofBestEffort(line);
            }
            String bindSnap = fr.lastBoundTextureKey != null ? fr.lastBoundTextureKey : "";
            CapturedVertex cv = new CapturedVertex(
                x,
                y,
                z,
                u,
                v,
                brightness,
                colorArgb,
                tessOffsetX,
                tessOffsetY,
                tessOffsetZ,
                bindSnap);
            fr.currentQuadVerts.add(cv);
            boolean triangleMode = tessellatorDrawMode == GL11.GL_TRIANGLES;
            int need = triangleMode ? 3 : 4;
            if (fr.currentQuadVerts.size() == need) {
                List<CapturedVertex> forQuad = new ArrayList<>(fr.currentQuadVerts);
                if (triangleMode) {
                    CapturedVertex c2 = forQuad.get(2);
                    forQuad.add(
                        new CapturedVertex(
                            c2.x,
                            c2.y,
                            c2.z,
                            c2.u,
                            c2.v,
                            c2.brightness,
                            c2.colorArgb,
                            c2.tessOffsetX,
                            c2.tessOffsetY,
                            c2.tessOffsetZ,
                            c2.textureBindHintAtVertex));
                }
                CapturedQuad cq = new CapturedQuad(forQuad);
                cq.bindTextureHint = aggregateBindHintsForQuad(forQuad);
                cq.fromDynamicExtensionPass = fr.dynamicExtensionVertexRecording;
                tagQuadChannelAndBin(fr, cq, forQuad);
                fr.quadsForBlock.add(cq);
                fr.currentQuadVerts.clear();
            }
        }
    }

    /**
     * PR-1：给闭合四边形打通道、窗口归属键、质心分箱与跨箱告警，并计入窗口计数与诊断聚合。
     * 分箱坐标 = 顶点去 Tessellator offset 后的输入坐标（区块编译期即世界坐标，见
     * {@code WorldRenderer.updateRenderer} 的 {@code setTranslation(-posX,-posY,-posZ)} 实证）。
     */
    private static void tagQuadChannelAndBin(Frame fr, CapturedQuad cq, List<CapturedVertex> forQuad) {
        cq.channel = fr.channel != null ? fr.channel : CaptureChannel.LEGACY_PER_CELL;
        cq.attribX = fr.attrX;
        cq.attribY = fr.attrY;
        cq.attribZ = fr.attrZ;
        int n = forQuad.size();
        double[] xs = new double[n];
        double[] ys = new double[n];
        double[] zs = new double[n];
        for (int i = 0; i < n; i++) {
            CapturedVertex cv = forQuad.get(i);
            xs[i] = cv.x - cv.tessOffsetX;
            ys[i] = cv.y - cv.tessOffsetY;
            zs[i] = cv.z - cv.tessOffsetZ;
        }
        CaptureBinning.Bin centroid = CaptureBinning.centroidBin(xs, ys, zs);
        cq.binX = centroid.x;
        cq.binY = centroid.y;
        cq.binZ = centroid.z;
        cq.crossBin = CaptureBinning.spansMultipleBins(xs, ys, zs);
        fr.windowQuadCount++;
        CaptureDiagnostics
            .noteQuad(cq.channel, cq.attribX, cq.attribY, cq.attribZ, cq.binX, cq.binY, cq.binZ, cq.crossBin);
    }

    /**
     * 自证日志：诊断 JSON 是耐久落点，FMLLog 只是尽力镜像——纯 JVM 环境（单测）里
     * {@code FMLRelaunchLog.side} 未初始化会 NPE，必须吞掉（诊断通道失败不得影响宿主）。
     */
    private static void logSelfProofBestEffort(String line) {
        try {
            FMLLog.info(line);
        } catch (Throwable ignored) {
            // 非 FML 环境（纯 JVM 单测）：日志通道不可用，诊断 JSON 仍记录
        }
        CaptureDiagnostics.noteSelfProof(line);
    }

    private static void flushPartialQuad(Frame f) {
        if (!f.currentQuadVerts.isEmpty()) {
            f.currentQuadVerts.clear();
        }
    }

    private static final class Frame {

        volatile boolean active;
        int blockX;
        int blockY;
        int blockZ;
        int worldBlockX;
        int worldBlockY;
        int worldBlockZ;
        String instanceLabel = "";
        Block captureBlock;
        int blockMeta;
        int renderType;
        String registryKey = "";
        /** 最近一次 {@link #noteTextureBind}；顶点录制时写入 {@link CapturedVertex#textureBindHintAtVertex} */
        String lastBoundTextureKey = "";
        /** {@link #beginDynamicExtensionVertexPhase} 与当前 {@link #beginBlock} 捕获块对齐 */
        boolean dynamicExtensionVertexRecording;
        final float[] dynamicExtensionInverseMvAtRenderStart = new float[16];
        boolean dynamicExtensionInverseMvAtRenderStartValid;
        final List<CapturedQuad> quadsForBlock = new ArrayList<>();
        final List<CapturedVertex> currentQuadVerts = new ArrayList<>();
        /** PR-1：当前录窗通道；{@code null} = 从未开窗（active 必为 false） */
        CaptureChannel channel;
        /** PR-1：窗口归属键（BLOCK_COMPILE = 渲染器段角；TESR = TE 坐标；LEGACY = 世界方块角） */
        int attrX;
        int attrY;
        int attrZ;
        String windowTag = "";
        /** PR-1：本窗口已闭合四边形数（zeroFlow = 关窗时 == 0） */
        int windowQuadCount;
        /** PR-1：窗口级 MODELVIEW 基线逆（列主序），TESR 录窗开启时布防 */
        final float[] windowMvBaselineInverse = new float[16];
        boolean windowMvBaselineValid;
    }

    public static final class CapturedVertex {

        public final double x;
        public final double y;
        public final double z;
        public final double u;
        public final double v;
        public final int brightness;
        /** 与 MC 1.7.10 Tessellator 小端一致：{@code alpha<<24|blue<<16|green<<8|red}（非 0xAARRGGBB 直观顺序） */
        public final int colorArgb;
        /** 录制该顶点时 Tessellator 的 x/y/zOffset；缓冲内坐标 = addVertex 入参 + offset */
        public final double tessOffsetX;
        public final double tessOffsetY;
        public final double tessOffsetZ;
        /**
         * 该顶点调用 {@link Tessellator#addVertex} 时，由 {@link #noteTextureBind} 记录下的最近一次 bind（与四边形
         * {@link CapturedQuad#bindTextureHint} 的聚合来源一致）。
         */
        public final String textureBindHintAtVertex;

        public CapturedVertex(double x, double y, double z, double u, double v, int brightness, int colorArgb,
            double tessOffsetX, double tessOffsetY, double tessOffsetZ, String textureBindHintAtVertex) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.u = u;
            this.v = v;
            this.brightness = brightness;
            this.colorArgb = colorArgb;
            this.tessOffsetX = tessOffsetX;
            this.tessOffsetY = tessOffsetY;
            this.tessOffsetZ = tessOffsetZ;
            this.textureBindHintAtVertex = textureBindHintAtVertex != null ? textureBindHintAtVertex : "";
        }
    }

    public static final class CapturedQuad {

        public final List<CapturedVertex> vertices;
        public String materialKey = "unknown";
        public int samplerIndex;
        /**
         * 由四顶点 {@link CapturedVertex#textureBindHintAtVertex} 聚合（多数票）；domain:path，path 已 normalize。
         */
        public String bindTextureHint = "";
        /**
         * 图集材质：与 {@code materialPalette[].atlas} 一致（{@code blocks} / {@code items}）；独立贴图时由采样器写
         * {@code atlas:null}，本字段可忽略。
         */
        public String materialAtlasKind = "blocks";
        /** {@link MaterialKeyResolver#applySpriteLocalToQuad}：材质来自非图集 bind，采样器不写 blocks 图集 */
        public boolean materialUsesStandaloneTexture;
        /** 四边形闭合时处于动态扩展顶点录制（{@link Frame#dynamicExtensionVertexRecording}） */
        public boolean fromDynamicExtensionPass;
        /** PR-1：流入通道（旧路径固定 {@link CaptureChannel#LEGACY_PER_CELL}） */
        public CaptureChannel channel = CaptureChannel.LEGACY_PER_CELL;
        /** PR-1：窗口归属键（开启窗口时的 attr 三元组） */
        public int attribX;
        public int attribY;
        public int attribZ;
        /** PR-1：质心分箱（去 Tessellator offset 后按 floor 分箱，负坐标正确下取整） */
        public int binX;
        public int binY;
        public int binZ;
        /** PR-1：跨箱告警——顶点跨多个格时为 true（归属按质心格，见 binX/Y/Z） */
        public boolean crossBin;

        public CapturedQuad(List<CapturedVertex> vertices) {
            this.vertices = vertices;
        }
    }

    public static final class CapturedBlockInstance {

        public int x;
        public int y;
        public int z;
        public String label;
        public final List<CapturedQuad> quads = new ArrayList<>();
    }
}
