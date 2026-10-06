package com.lightning.mod.client.controlplane.mc.capture;

import java.nio.FloatBuffer;

import org.lwjgl.BufferUtils;
import org.lwjgl.opengl.GL11;

import com.lightning.mod.client.controlplane.mc.CpLog;

/**
 * 渲染帧的投影矩阵覆写（contract.md §4.3.3/§4.3.4）。
 *
 * <h2>谁在什么时候用它</h2>
 * <ol>
 * <li>{@link ShotExecutor} 在按快门前把本机位/本 tile 的覆写参数写进本类（{@link #arm}）；</li>
 * <li>mixin 在 {@code EntityRenderer.setupCameraTransform} 的 {@code RETURN} 点调用
 * {@link #applyToCurrentProjectionMatrix()}——此时 EntityRenderer 刚把
 * {@code Project.glPerspective} 的透视矩阵写进 GL 投影栈，我们把它替换成目标矩阵；</li>
 * <li>帧渲染（{@code renderWorld}）跑完后 {@link #disarm()}，GL 状态回到「未被我们改过」。</li>
 * </ol>
 *
 * <h2>网格从哪来（r3 事故的修法）</h2>
 * 本类<b>不</b>再自己解析 tile 网格：{@link #arm} 直接接收 {@link TilePlan}（全链路唯一的网格定义点，
 * 由 {@link ShotExecutor} 在 {@code onBegin} 捕获真实窗口尺寸后算一次）。旧实现里本类拿
 * 「本片 buffer 960×540 ÷ 真实窗口 854×480」自己算了一遍网格——那得到的是<b>像素比追加</b>那一份
 * （{@code 1×1}），而执行器算的是「请求网格 2×2 × 追加 1×1 = 2×2」，两边必然分叉，
 * 于是自检把 persp-tiled 判成渲染故障。现在两边共用同一个 {@link TilePlan} 实例，自检退化为
 * 纯粹的防御性断言（输入同源后恒成立），但仍保留：它挡的是「将来有人又在某一侧重算网格」这类回归。
 *
 * <h2>数值在哪（本类只做 GL 与状态）</h2>
 * 「这一片该看整图哪一块」的矩阵改写全部在 {@link TileProjection}（纯函数、可无头单测，推导与 r3
 * 数值自检见其类注释；透视走 {@link TileProjection#applyPerspectiveTile}、正交走
 * {@link TileProjection#applyOrthoTile}——两者位移写进不同的矩阵元素）。本类只负责：读回原版已算好的
 * 矩阵（或自建正交矩阵）→ 交给纯函数改写 → 写回 GL。
 *
 * <h2>禁止视口拼接</h2>
 * {@code EntityRenderer.renderWorld} 每帧强制 {@code glViewport(0,0,displayWidth,displayHeight)}，
 * 视口拼接会被它改回去、接缝必然错位（contract §4.3.4 明令禁止）。本实现全程不搬视口：tiling 只改
 * 投影矩阵（放大 + 视锥平移），因此 {@code cols×rows} 片天然无缝。
 *
 * <h2>线程</h2>
 * 只在客户端主线程（1.7.10 单机里 tick 线程 == 渲染线程）读写；写入点在按快门前，读取点在
 * {@code setupCameraTransform} 内，都在同一线程、同一帧内。
 */
public final class ProjectionOverride {

    /** 透视投影。 */
    public static final int TYPE_PERSPECTIVE = 0;

    /** 正交投影。 */
    public static final int TYPE_ORTHO = 1;

    /** 近裁剪面（与原版 {@code Project.gluPerspective(..., 0.05F, ...)} 一致）。 */
    public static final double NEAR_PLANE = 0.05d;

    private static final FloatBuffer MATRIX = BufferUtils.createFloatBuffer(16);
    /** 自证日志用的投影矩阵暂存（只在 {@link #loadProjection} 里用）。 */
    private static final FloatBuffer PROBE = BufferUtils.createFloatBuffer(16);
    private static final float[] SCRATCH = new float[16];

    private ProjectionOverride() {}

    // ------------------------------------------------------------ 覆写状态（帧内有效）

    private static boolean armed;
    private static int type = TYPE_PERSPECTIVE;
    private static double fovDeg = 70.0d;
    private static double orthoHeight = 16.0d;
    private static int bufferWidth = 1;
    private static int bufferHeight = 1;
    private static double farPlane;
    /** 本帧消费的网格（由 {@link ShotExecutor} 传入；本类不重算、不修改）。 */
    private static TilePlan plan;
    private static int tileCol = 1;
    private static int tileRow = 1;
    /** 本帧实际使用的放大倍数（{@link TileProjection} 两个入口的返回值；1.0 = 未放大）。 */
    private static double magnification = 1.0d;

    /** 是否处于覆写态（mixin 每帧都要问一次，务必极轻）。 */
    public static boolean isArmed() {
        return armed;
    }

    /** 本次渲染的 framebuffer 宽度（覆写态外为 1）。 */
    public static int currentBufferWidth() {
        return bufferWidth;
    }

    /** 本次渲染的 framebuffer 高度。 */
    public static int currentBufferHeight() {
        return bufferHeight;
    }

    /** 有效 tile 列数（{@link #arm} 后有效，直接来自 {@link TilePlan}）。 */
    public static int effectiveTileCols() {
        return plan == null ? 1 : plan.cols();
    }

    /** 有效 tile 行数。 */
    public static int effectiveTileRows() {
        return plan == null ? 1 : plan.rows();
    }

    /** 有效网格是否与请求的机位 tile 网格一致（不一致说明实现按像素比例追加了划分）。 */
    public static boolean gridMatches(int cols, int rows) {
        return effectiveTileCols() == Math.max(1, cols) && effectiveTileRows() == Math.max(1, rows);
    }

    /**
     * 进入覆写态。
     *
     * <p>
     * 两个尺寸参数缺一不可：{@code buffer} 是本次渲染的 framebuffer（同时是 GL 视口尺寸，由
     * {@link TilePlan} 的格位推出），{@code plan} 是本机位的有效网格（决定本片看整图的哪一块）。
     * 网格与格位都<b>只</b>来自入参：本类没有任何「自己解析网格」的路径，因此不存在
     * 「执行器 2×2 vs 投影覆写 1×1」这类两侧分叉。
     *
     * @param projectionType {@link #TYPE_PERSPECTIVE} 或 {@link #TYPE_ORTHO}
     * @param fov            透视 FOV（度）；正交机位忽略
     * @param orthoHeightV   正交视高（方块）；透视机位忽略
     * @param bufferW        本次渲染 framebuffer 宽（= GL 视口宽 = 本片格位宽）
     * @param bufferH        本次渲染 framebuffer 高
     * @param tilePlan       本机位的有效网格（唯一网格定义点；不得为 null）
     * @param col            当前 tile 列（1 起）
     * @param row            当前 tile 行（1 起，1 = 顶行）
     * @param far            远裁剪面（{@code EntityRenderer.farPlaneDistance * 2}）
     */
    public static void arm(int projectionType, double fov, double orthoHeightV, int bufferW, int bufferH,
        TilePlan tilePlan, int col, int row, double far) {
        if (tilePlan == null) {
            throw new IllegalArgumentException("ProjectionOverride.arm 必须收到 TilePlan（网格唯一来源）");
        }
        armed = true;
        type = projectionType;
        fovDeg = fov;
        orthoHeight = orthoHeightV;
        bufferWidth = Math.max(1, bufferW);
        bufferHeight = Math.max(1, bufferH);
        plan = tilePlan;
        tileCol = Math.max(1, Math.min(tilePlan.cols(), col));
        tileRow = Math.max(1, Math.min(tilePlan.rows(), row));
        farPlane = far > NEAR_PLANE ? far : 256.0d;
        magnification = tilePlan.tiled() ? tilePlan.targetHeight() / (double) tilePlan.spanY(tileRow) : 1.0d;
        probed = false;
    }

    /**
     * 本次 {@link #arm} 是否已输出过「投影覆写自证」日志（{@link #loadProjection} 里消费）。
     *
     * <p>
     * 存在的理由：投影覆写<b>是否真的落到 GL 的投影栈</b>这件事，曾经在两轮真机验收里都是靠推理
     * 判断的，而实际答案是「没落到」（矩阵模式写错，真机事故 B2）。留一条日志，让下一个人一眼看到
     * 「改前/改后的投影矩阵」和「写的时候当前栈是哪个」，不必再猜。
     *
     * <p>
     * 节流口径：<b>每次 {@link #arm}（= 每机位每 tile）一条</b>。一次三机位取证最多 机位×片数 条
     * （当前用例 1+1+4=6 条），不会刷屏，而每片的位移量（{@code m8/m9}）恰好各不相同，逐片留痕
     * 才看得出「四片真的不是同一张图」。
     */
    private static boolean probed;

    /** 退出覆写态（GL 状态随即由 EntityRenderer 的下一帧自己重置）。 */
    public static void disarm() {
        armed = false;
    }

    /** 覆写参数快照（{@code shot-meta} 留痕用；<b>必须在 disarm 前取</b>）。 */
    public static String describe() {
        if (!armed || plan == null) {
            return "none";
        }
        return "type=" + (type == TYPE_ORTHO ? "ortho" : "perspective")
            + " fov="
            + fovDeg
            + " orthoHeight="
            + orthoHeight
            + " grid="
            + plan.describe()
            + " requested="
            + plan.requestedCols()
            + "x"
            + plan.requestedRows()
            + " at="
            + tileCol
            + ","
            + tileRow
            + " buffer="
            + bufferWidth
            + "x"
            + bufferHeight
            + " target="
            + plan.targetWidth()
            + "x"
            + plan.targetHeight()
            + " mag="
            + magnification
            + " method=projection-offset";
    }

    // ------------------------------------------------------------ 投影矩阵

    /**
     * 把当前覆写应用到 GL 投影栈顶（mixin 在 {@code setupCameraTransform} 返回点调用）。
     *
     * <p>
     * 做法：先从 GL 取回 EntityRenderer 刚算好的投影矩阵，做像素级改造，再整矩阵写回。用
     * 「读回 + 改写 + 写回」而不是「自己从零算一个」，是为了继承原版已经处理过的立体（anaglyph）
     * 与相机缩放（cameraZoom）项；tiling 只改写 {@code m[0]/m[5]/m[8]/m[9]} 四个元素，
     * 其余元素原样保留（1×1 时四个元素都不变，即分辨率覆写路径与本覆写无关）。
     *
     * <h2>为什么写回前必须显式切到 {@code GL_PROJECTION}（真机事故）</h2>
     * {@code glLoadMatrix} 作用于<b>当前矩阵栈</b>，而注入点（{@code setupCameraTransform} 的
     * {@code RETURN}）处当前栈是 {@code GL_MODELVIEW}——反编译源 {@code EntityRenderer.java:658-682}：
     * 该方法先把矩阵模式切成 {@code GL_PROJECTION} 写完透视矩阵，随后的
     * {@code GL11.glMatrixMode(GL11.GL_MODELVIEW)}（:682）交给 {@code orientCamera} 摆相机，
     * 到 {@code RETURN} 时模式仍是 MODELVIEW。裸 {@code glLoadMatrix} 因此（a）改了模型视图而不是投影
     * （真机实测：覆写前后投影矩阵逐位相同，正交机位也仍是透视矩阵），（b）把「投影矩阵」写进了
     * 模型视图，摧毁世界段的相机变换——症状是画面里只剩天空/雾色与第一人称手持物（{@code renderHand}
     * 自己重建两个矩阵，所以它反而正常），而所有机位、所有 tile 长得一模一样。
     */
    public static void applyToCurrentProjectionMatrix() {
        if (!armed) {
            return;
        }
        MATRIX.clear();
        GL11.glGetFloat(GL11.GL_PROJECTION_MATRIX, MATRIX);
        MATRIX.get(SCRATCH);
        magnification = TileProjection.applyPerspectiveTile(SCRATCH, plan, tileCol, tileRow, bufferWidth, bufferHeight);
        loadProjection(SCRATCH);
    }

    /**
     * 正交覆写的完整矩阵（先建正交投影，再套同一套像素级偏移）。
     *
     * <p>
     * 透视路径复用 EntityRenderer 已写进 GL 的矩阵；正交路径必须自己建，因为原版只会在
     * {@code setupOverlayRendering} 里为 GUI 建正交矩阵，世界渲染没有这条路径。
     */
    public static void writeOrthoMatrixToCurrentProjection() {
        if (!armed) {
            return;
        }
        float[] m = TileProjection.orthoMatrix(orthoHeight, bufferWidth, bufferHeight, NEAR_PLANE, farPlane);
        magnification = TileProjection.applyOrthoTile(m, plan, tileCol, tileRow, bufferWidth, bufferHeight);
        loadProjection(m);
    }

    /**
     * 把矩阵写进投影栈，并把矩阵模式还原成 {@code GL_MODELVIEW}（调用点的后续渲染依赖它）。
     *
     * <p>
     * 模式必须<b>进出成对</b>：进入时显式切到 {@code GL_PROJECTION}（否则写的是当前栈，见
     * {@link #applyToCurrentProjectionMatrix} 的说明），写完立刻切回 {@code GL_MODELVIEW}——
     * {@code EntityRenderer.renderWorld} 紧接着就用模型视图画天空/地形/实体。
     *
     * <p>
     * 每次 {@link #arm} 的<b>第一次</b>写入顺带输出一条自证日志（改前/改后的投影矩阵 + 写入前后的
     * 当前栈），见 {@link #probed}。
     */
    private static void loadProjection(float[] m) {
        boolean probe = !probed;
        probed = true;
        int modeBefore = 0;
        float m0Before = 0.0f;
        float m5Before = 0.0f;
        if (probe) {
            modeBefore = GL11.glGetInteger(GL11.GL_MATRIX_MODE);
            PROBE.clear();
            GL11.glGetFloat(GL11.GL_PROJECTION_MATRIX, PROBE);
            m0Before = PROBE.get(0);
            m5Before = PROBE.get(5);
        }
        GL11.glMatrixMode(GL11.GL_PROJECTION);
        MATRIX.clear();
        MATRIX.put(m);
        MATRIX.flip();
        GL11.glLoadMatrix(MATRIX);
        int modeAfterLoad = GL11.glGetInteger(GL11.GL_MATRIX_MODE);
        GL11.glMatrixMode(GL11.GL_MODELVIEW);
        if (probe) {
            PROBE.clear();
            GL11.glGetFloat(GL11.GL_PROJECTION_MATRIX, PROBE);
            CpLog.info(
                "投影覆写自证（一次性）：%s | 写入时矩阵模式=%s（写入后=%s，随后切回 MODELVIEW）| GL 投影矩阵 m0 %.5f→%.5f m5 %.5f→%.5f",
                describe(),
                matrixModeName(modeBefore),
                matrixModeName(modeAfterLoad),
                Double.valueOf(m0Before),
                Double.valueOf(PROBE.get(0)),
                Double.valueOf(m5Before),
                Double.valueOf(PROBE.get(5)));
        }
    }

    /** GL 矩阵模式的日志用名（{@code GL_MODELVIEW}/{@code GL_PROJECTION}/其它值）。 */
    private static String matrixModeName(int mode) {
        if (mode == GL11.GL_MODELVIEW) {
            return "GL_MODELVIEW";
        }
        if (mode == GL11.GL_PROJECTION) {
            return "GL_PROJECTION";
        }
        return "mode#" + mode;
    }

    /** 当前是否正交覆写（mixin 据此决定走哪条矩阵路径）。 */
    public static boolean isOrtho() {
        return armed && type == TYPE_ORTHO;
    }

    /** framebuffer 宽。 */
    public static int bufferWidth() {
        return bufferWidth;
    }

    /** framebuffer 高。 */
    public static int bufferHeight() {
        return bufferHeight;
    }

    /** 本帧实际使用的放大倍数（留痕用）。 */
    public static double magnification() {
        return magnification;
    }
}
