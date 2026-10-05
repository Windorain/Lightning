package com.lightning.mod.client.controlplane.mc.capture;

import java.nio.FloatBuffer;

import org.lwjgl.BufferUtils;
import org.lwjgl.opengl.GL11;

/**
 * 渲染帧的投影矩阵覆写（contract.md §4.2.3/§4.2.4）。
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
 * <h2>投影偏移 tiling 的数学（为什么这就是「投影偏移」而不是「视口拼接」）</h2>
 * 设真实窗口为 {@code W0×H0}，本次渲染的 framebuffer 为 {@code Bw×Bh}，令
 * {@code s = Bw/W0}、{@code t = Bh/H0}（渲染几何在屏幕空间被缩放的比例）。tile 场景下
 * {@code t/s = nRows}（每 tile 只占整图 1/nRows 的高度），分辨率覆写场景下 {@code t = s}（各向同性放大）。
 *
 * <p>
 * 「往右/往上多看一点」在透视投影里等价于把 NDC 结果减去一个常量偏移：
 * 
 * <pre>
 * NDC' = (NDC - x0) / s
 * </pre>
 * 
 * 要实现它，只需把投影像素级地改成：
 * <ul>
 * <li>{@code m[0][0] /= s}、{@code m[1][1] /= t}（几何放大 1/s、1/t 倍）</li>
 * <li>{@code m[2][0] = (x0 - 1) / s}、{@code m[2][1] = (y0 + 1) / t}（把 x0/y0 平移到屏幕中心）</li>
 * </ul>
 * 其中 {@code x0 = 2c/nCols - 1}（第 {@code c} 列 tile 的左边界，1 起）、{@code y0 = t - 1 - 2r}（第
 * {@code r} 行 tile 的上边界）——{@code nCols = nRows·s}，因为正方形像素下「垂直放大 nRows 倍」与
 * 「水平放大 s 倍」是同一件事，所以列必须多取 {@code s} 倍。于是每个 tile 拿到的就是<b>整图里它那一块</b>，
 * 且分辨率与目标 tile 完全一致（分辨率覆写场景额外覆盖 {@code nCols=nRows=s}）。
 *
 * <p>
 * EntityRenderer 会把视口强制设成 {@code mc.displayWidth × displayHeight}（见 {@code renderWorld}
 * 里的 {@code GL11.glViewport}），所以 tile <b>不能</b>靠视口位置拼——那正是 contract §4.2.4 明令禁止的
 * 做法。本实现全程不搬视口，只改投影，因此 tile 之间天然无缝、无接缝错位。
 *
 * <h2>正交投影</h2>
 * 正交机位不用 {@code Project.gluPerspective}，而是用视角高 {@code orthoHeight}（方块）与画面宽高比
 * 自己算一个 {@code glOrtho} 等价矩阵，再走同一套像素级偏移。这样宽高比从画面尺寸推，而不是让调用方
 * 给宽——与契约「宽按画面宽高比推」一致。
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
    private static final float[] SCRATCH = new float[16];

    private ProjectionOverride() {}

    // ------------------------------------------------------------ 覆写状态（帧内有效）

    private static boolean armed;
    private static int type = TYPE_PERSPECTIVE;
    private static double fovDeg = 70.0d;
    private static double orthoHeight = 16.0d;
    private static int baseWidth;
    private static int baseHeight;
    private static int bufferWidth;
    private static int bufferHeight;
    private static int frameWidth = 1;
    private static int frameHeight = 1;
    /** 有效 tile 网格（{@link #resolveEffectiveGrid()} 解析；单轴放大时另一轴为 1）。 */
    private static int tileCols = 1;
    private static int tileRows = 1;
    private static int tileCol = 1;
    private static int tileRow = 1;
    private static double farPlane;

    /** 是否处于覆写态（mixin 每帧都要问一次，务必极轻）。 */
    public static boolean isArmed() {
        return armed;
    }

    /** 本次渲染的 framebuffer 宽度（覆写态外等于真实窗口宽）。 */
    public static int currentBufferWidth() {
        return armed ? bufferWidth : baseWidth;
    }

    /** 本次渲染的 framebuffer 高度。 */
    public static int currentBufferHeight() {
        return armed ? bufferHeight : baseHeight;
    }

    /**
     * 解析「有效 tile 网格」。
     *
     * <p>
     * 渲染分辨率与真实窗口的像素比在 x/y 上通常不同（窗口 854×480、目标图 1920×1080 时
     * {@code sx≈2.25}、{@code sy=2.25}；窗口 1024×768、目标图 1000×1000 时差异更明显）。
     * 要让像素保持正方形，只能用<b>一个</b>放大倍数；于是「多出来的那一轴」必须靠
     * <b>追加 tile 划分</b>吃掉：
     * <ul>
     * <li>{@code sy < sx}（垂直方向放大得少）⇒ 垂直视场装不下整图，需要沿列切分：
     * {@code cols=round(sx/sy)}、{@code rows=1}；</li>
     * <li>否则沿行切分：{@code rows=round(sy/sx)}、{@code cols=1}。</li>
     * </ul>
     * 分辨率覆写（无 tile 段）走同一段逻辑：目标分辨率与窗口宽高比一致时 {@code sx=sy}，网格退化为
     * 1×1（一次渲染出图，不拼接）；不一致时自动切分，产出的仍是与请求分辨率逐像素对齐的整图。
     */
    private static void resolveEffectiveGrid() {
        int[] g = resolveGrid(bufferWidth, bufferHeight, baseWidth, baseHeight);
        tileCols = g[0];
        tileRows = g[1];
        tileCol = Math.max(1, Math.min(tileCols, tileCol));
        tileRow = Math.max(1, Math.min(tileRows, tileRow));
    }

    /**
     * 解析有效分片网格——{@link #resolveEffectiveGrid} 与 {@code ShotExecutor} 的<b>唯一</b>口径。
     *
     * <p>
     * 渲染分辨率与真实窗口的像素比在 x/y 上通常不同（窗口 1024×768、目标图 1000×1000 时
     * {@code sx≈0.977}、{@code sy≈1.302}）。要让像素保持正方形，只能用<b>一个</b>放大倍数；
     * 于是「放大得不够的那一轴」必须靠<b>追加分片</b>补上：
     * <ul>
     * <li>{@code sy < sx}（垂直放大得少）⇒ 沿列切 {@code round(sx/sy)} 段、1 行；</li>
     * <li>{@code sx < sy} ⇒ 1 列、沿行切 {@code round(sy/sx)} 段；</li>
     * <li>相等 ⇒ 1×1（一次渲染出图，不需要拼接）。</li>
     * </ul>
     * 「单轴 n 段」这个形态同时保证子矩形可解（{@code a·n == buffer/frame}），因此透视与正交
     * 共用同一条 tiling 路径；执行器与投影覆写各自调用本方法拿到<b>同一个</b>网格，
     * 两边不可能再各算一套。
     *
     * @return {@code [cols, rows]}
     */
    public static int[] resolveGrid(int bufferW, int bufferH, int baseW, int baseH) {
        double sx = bufferW / (double) Math.max(1, baseW);
        double sy = bufferH / (double) Math.max(1, baseH);
        if (!(sx > 0.0d) || !(sy > 0.0d) || Double.isNaN(sx) || Double.isNaN(sy)) {
            return new int[] { 1, 1 };
        }
        if (sy < sx - 1.0e-9d) {
            return new int[] { (int) Math.max(1L, Math.round(sx / sy)), 1 };
        }
        if (sx < sy - 1.0e-9d) {
            return new int[] { 1, (int) Math.max(1L, Math.round(sy / sx)) };
        }
        return new int[] { 1, 1 };
    }

    /** 有效 tile 列数（{@link #arm} 后有效）。 */
    public static int effectiveTileCols() {
        return tileCols;
    }

    /** 有效 tile 行数。 */
    public static int effectiveTileRows() {
        return tileRows;
    }

    /** 有效网格是否与请求的机位 tile 网格一致（不一致说明实现按像素比例自动追加了划分）。 */
    public static boolean gridMatches(int cols, int rows) {
        return tileCols == Math.max(1, cols) && tileRows == Math.max(1, rows);
    }

    /**
     * 进入覆写态。
     *
     * <p>
     * 三个尺寸参数缺一不可：{@code base} 是真实窗口（决定像素缩放比）、{@code buffer} 是本次渲染的
     * framebuffer（同时是 GL 视口尺寸）、{@code frame} 是「整图」的逻辑尺寸（分辨率覆写时等于输出
     * 分辨率；tile 时等于该 tile 的格位尺寸）。有效 tile 网格由 {@link #effectiveTileCols()} /
     * {@link #effectiveTileRows()} 在 {@link #arm} 后给出——它们可能比入参大，见 {@link #scaleTranslate}。
     *
     * @param projectionType {@link #TYPE_PERSPECTIVE} 或 {@link #TYPE_ORTHO}
     * @param fov            透视 FOV（度）；正交机位忽略
     * @param orthoHeightV   正交视高（方块）；透视机位忽略
     * @param baseW          真实窗口宽（{@code mc.displayWidth}，未被覆写时的值）
     * @param baseH          真实窗口高
     * @param bufferW        本次渲染 framebuffer 宽（= GL 视口宽）
     * @param bufferH        本次渲染 framebuffer 高
     * @param frameW         整图逻辑宽
     * @param frameH         整图逻辑高
     * @param col            当前 tile 列（1 起）
     * @param row            当前 tile 行（1 起）
     * @param far            远裁剪面（{@code EntityRenderer.farPlaneDistance * 2}）
     */
    public static void arm(int projectionType, double fov, double orthoHeightV, int baseW, int baseH, int bufferW,
        int bufferH, int frameW, int frameH, int col, int row, double far) {
        armed = true;
        type = projectionType;
        fovDeg = fov;
        orthoHeight = orthoHeightV;
        baseWidth = Math.max(1, baseW);
        baseHeight = Math.max(1, baseH);
        bufferWidth = Math.max(1, bufferW);
        bufferHeight = Math.max(1, bufferH);
        frameWidth = Math.max(1, frameW);
        frameHeight = Math.max(1, frameH);
        tileCol = Math.max(1, col);
        tileRow = Math.max(1, row);
        farPlane = far > NEAR_PLANE ? far : 256.0d;
        resolveEffectiveGrid();
    }

    /** 退出覆写态（GL 状态随即由 EntityRenderer 的下一帧自己重置）。 */
    public static void disarm() {
        armed = false;
    }

    /** 覆写参数快照（{@code shot-meta} 留痕用）。 */
    public static String describe() {
        if (!armed) {
            return "none";
        }
        return "type=" + (type == TYPE_ORTHO ? "ortho" : "perspective")
            + " fov="
            + fovDeg
            + " orthoHeight="
            + orthoHeight
            + " base="
            + baseWidth
            + "x"
            + baseHeight
            + " buffer="
            + bufferWidth
            + "x"
            + bufferHeight
            + " frame="
            + frameWidth
            + "x"
            + frameHeight
            + " grid="
            + tileCols
            + "x"
            + tileRows
            + " at="
            + tileCol
            + ","
            + tileRow
            + " scale="
            + (frameWidth / (double) bufferWidth);
    }

    // ------------------------------------------------------------ 投影矩阵

    /**
     * 把当前覆写应用到 GL 投影栈顶（mixin 在 {@code setupCameraTransform} 返回点调用）。
     *
     * <p>
     * 做法：先从 GL 取回 EntityRenderer 刚算好的投影矩阵，按其类型做像素级改造，再整矩阵写回。
     * 用「读回 + 改写 + 写回」而不是「自己从零算一个」，是为了继承原版已经处理过的立体（anaglyph）
     * 与相机缩放（cameraZoom）平移量——那些在原版里是在投影栈上做的平移，重新算一遍只会更脆。
     */
    public static void applyToCurrentProjectionMatrix() {
        if (!armed) {
            return;
        }
        MATRIX.clear();
        GL11.glGetFloat(GL11.GL_PROJECTION_MATRIX, MATRIX);
        MATRIX.get(SCRATCH);
        scaleTranslate(SCRATCH);
        MATRIX.clear();
        MATRIX.put(SCRATCH);
        MATRIX.flip();
        GL11.glLoadMatrix(MATRIX);
    }

    /**
     * 对投影矩阵做「几何放大 + 平移」改造（见类注释的推导）。
     *
     * <p>
     * 放大倍数取 {@code s = 1/a}（{@code a = bufferW/frameW}）：{@code a} 是「framebuffer 比整图小
     * 多少倍」，也就是该 tile 占整图的比例。{@code a == 1} 即分辨率覆写（framebuffer 就是整图）；
     * {@code a == 1/nRows} 即 {@code nRows×1} 的 tile。
     *
     * <p>
     * 可解性由 {@link #resolveEffectiveGrid()} 保证：网格被解析成「单轴 {@code n}×1」形态后，
     * 由子矩形反解恒等（{@code a·n == bufferH/frameH}，因 {@code n = sy/sx} 且 {@code sy==1}）。
     */
    static void scaleTranslate(float[] m) {
        double a = bufferWidth / (double) frameWidth;
        if (!(a > 0.0d) || Double.isNaN(a) || Double.isInfinite(a)) {
            return;
        }
        lastN = scaleTranslatePure(m, a, tileCols, tileRows, tileCol, tileRow);
    }

    /**
     * {@link #scaleTranslate} 的纯函数形式（不依赖 GL 与任何静态状态）。
     *
     * <p>
     * 抽成纯函数只有一个理由：投影偏移的数值是本功能最容易错、也最难在无头环境里发现的部分
     * （错了以后只会得到「看着像但拼不上」的图）。它现在可以在纯 JVM 单测里逐项验证：
     * 平移量、放大比、以及「相邻分片首尾相接不重叠」这三条。
     *
     * @param a    本分片占整图的比例（{@code bufferW / frameW}）
     * @param cols 有效分片列数
     * @param rows 有效分片行数
     * @param col  当前列（1 起）
     * @param row  当前行（1 起）
     * @return 实际使用的放大倍数（{@code 1/a}）
     */
    public static double scaleTranslatePure(float[] m, double a, int cols, int rows, int col, int row) {
        double s = 1.0d / a;
        double c = Math.max(1, cols);
        double r = Math.max(1, rows);
        // 平移量取自「目标子矩形在整图中的左上角」：整图可见范围与 NDC 的换算见类注释。
        double x0 = c > 1 ? 2.0d * a * (col - 1) : 0.0d;
        double y0 = r > 1 ? 2.0d * a * (row - 1) : 0.0d;
        m[0] = (float) (m[0] / s);
        m[5] = (float) (m[5] / s);
        m[8] = (float) (x0 / s);
        m[9] = (float) (y0 / s);
        return s;
    }

    private static double lastN = 1.0d;

    /**
     * 构造正交投影矩阵（列主序，与 {@code glOrtho} 等价；w 维留 1，不做透视除法）。
     *
     * <p>
     * 视高 {@code orthoHeight} 沿屏幕竖轴，横向按 framebuffer 的宽高比推——即「宽按画面宽高比推」。
     * 之后 {@link #scaleTranslate} 仍会按同一套像素级规则做偏移，两种投影因此共用一条 tiling 路径。
     */
    static float[] orthoMatrix(double orthoHeightV, int width, int height, double near, double far) {
        float[] m = new float[16];
        double halfH = Math.max(1.0e-6d, orthoHeightV) / 2.0d;
        double aspect = height <= 0 ? 1.0d : width / (double) height;
        double halfW = halfH * aspect;
        m[0] = (float) (1.0d / halfW);
        m[5] = (float) (1.0d / halfH);
        m[10] = (float) (-2.0d / (far - near));
        m[14] = (float) (-(far + near) / (far - near));
        m[15] = 1.0f;
        return m;
    }

    /**
     * 正交覆写的完整矩阵（先建正交投影，再套像素级偏移）。
     *
     * <p>
     * 透视路径复用 EntityRenderer 已写进 GL 的矩阵；正交路径必须自己建，因为原版只会在
     * {@code setupOverlayRendering} 里为 GUI 建正交矩阵，世界渲染没有这条路径。
     */
    public static void writeOrthoMatrixToCurrentProjection() {
        if (!armed) {
            return;
        }
        float[] m = orthoMatrix(orthoHeight, bufferWidth, bufferHeight, NEAR_PLANE, farPlane);
        scaleTranslate(m);
        MATRIX.clear();
        MATRIX.put(m);
        MATRIX.flip();
        GL11.glLoadMatrix(MATRIX);
    }

    /** 当前是否正交覆写（mixin 据此决定走哪条矩阵路径）。 */
    public static boolean isOrtho() {
        return armed && type == TYPE_ORTHO;
    }

    /** FOV（度），仅日志与留痕用。 */
    public static double fov() {
        return fovDeg;
    }

    /** 正交视高（方块）。 */
    public static double orthoHeight() {
        return orthoHeight;
    }

    /** 真实窗口宽（覆写前的 {@code mc.displayWidth}）。 */
    public static int baseWidth() {
        return baseWidth;
    }

    /** 真实窗口高。 */
    public static int baseHeight() {
        return baseHeight;
    }

    /** framebuffer 宽。 */
    public static int bufferWidth() {
        return bufferWidth;
    }

    /** framebuffer 高。 */
    public static int bufferHeight() {
        return bufferHeight;
    }
}
