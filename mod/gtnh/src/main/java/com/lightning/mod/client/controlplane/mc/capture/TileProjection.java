package com.lightning.mod.client.controlplane.mc.capture;

/**
 * 投影偏移 tiling 的<b>纯数值</b>部分：给定基准投影矩阵与一片的格位，算出「这一片该看整图的哪一块」。
 *
 * <p>
 * 抽成纯函数（不碰 GL、不读静态状态）的理由与 {@code scaleTranslatePure} 当初一样，但它还必须真的能被
 * 无头单测加载：投影偏移的数值是这个功能最容易错、也最难在无头环境里发现的部分——错了只会得到
 * 「看着像但拼不上」「四片都一样」或「随景深斜切」的图。{@link ProjectionOverride} 只负责 GL 读写与
 * 状态，数值全在这里，故 {@code TilePlanTest} 可以直接按几何定义验证。
 *
 * <h2>推导（image-NDC 记作 u/v ∈ [-1,1]，覆盖整图）</h2>
 * <ol>
 * <li>基准投影矩阵的<b>竖直</b>视场 = 机位 fov = <b>整图</b>的竖直视场（原版把 fov 用在竖轴上，
 * 正交路径自己建的矩阵同口径：竖直视高 = 机位 {@code orthoHeight}）；</li>
 * <li>基准投影的<b>水平</b>视场由 buffer 宽高比推，而渲染期的 buffer 就是本片
 * （{@link ShotExecutor} 在按快门前把 {@code mc.displayWidth/Height} 指向本片尺寸、GL 视口同尺寸）
 * ⇒ 基准画面只覆盖整图<b>中间</b> {@code ax/ay} 那一竖条
 * （{@code ax = spanW/targetW}、{@code ay = spanH/targetH}）；</li>
 * <li>于是「把整图第 (col,row) 格铺满视口」= 各向均匀放大 {@code 1/ay}，再把视锥平移到该格中心：
 * {@code m00 *= 1/ay}、{@code m11 *= 1/ay}，位移量取
 * {@code offX = u_c/ax = (2·offXpx + spanW - targetW)/spanW}、
 * {@code offY = v_c/ay = (targetH - 2·offYpx - spanH)/spanH}（{@code u_c/v_c} = 格中心在整图 NDC
 * 的坐标；行号向下而 GL 的 y 轴向上，故 y 的分子形式与 x 相反但同源）。</li>
 * </ol>
 *
 * <p>
 * <b>为什么只用一个放大倍数（{@code 1/ay}）就够</b>：分片 framebuffer 保留了本片的宽高比，因此水平
 * 方向「缺的那一截」正好等于竖直方向的比例修正——两轴同乘 {@code 1/ay} 后，视锥恰好覆盖
 * {@code [u_c-ax, u_c+ax] × [v_c-ay, v_c+ay]}，就是这一格的像窗，相邻格首尾相接、无缝无叠。
 *
 * <h2>位移写进哪个矩阵元素（透视与正交不同，踩过）</h2>
 * GL 的 x 输出为 {@code clip.x = m[0]·x + m[4]·y + m[8]·z + m[12]·w}：
 * <ul>
 * <li><b>透视</b>：{@code w = -z}，除以 w 后 {@code m[8]·z / (-z)} 是<b>常量</b>位移 ⇒ 位移写
 * {@code m[8]}/{@code m[9]}（NDC = {@code m00·x/d - m[8]}）；</li>
 * <li><b>正交</b>：{@code w ≡ 1}，{@code m[8]·z} 会变成<b>随景深线性增大的斜切</b>（画面被剪成
 * 梯形）⇒ 位移必须写 {@code m[12]}/{@code m[13]}，且符号相反（NDC = {@code m00·x + m[12]}）。</li>
 * </ul>
 * 旧实现两条路径都写 {@code m[8]}/{@code m[9]}：拼接正交机位会得到随景深斜切的错图（1×1 时位移为 0，
 * 故一直没暴露）。两个入口 {@link #applyPerspectiveTile} / {@link #applyOrthoTile} 因此分开。
 *
 * <h2>数值自检（r3 输入）</h2>
 * 真实窗口 854×480、整图 1920×1080、有效网格 2×2 ⇒ 每片 960×540、{@code ay = 0.5} ⇒ 放大 2 倍；
 * 左上片 (1,1)：{@code offX = (0+960-1920)/960 = -1}、{@code offY = (1080-0-540)/540 = +1}
 * ⇒ 透视 {@code NDC = 2·base - (-1, +1)}，正好把整图左上四分之一（u∈[-1,0]、v∈[0,1]）铺满视口。
 * 1×1 时 {@code ax = ay = 1}、{@code offX = offY = 0} ⇒ 矩阵<b>不变</b>，分辨率覆写路径
 * （不拼接的机位）因此完全不受本改造影响。
 *
 * <p>
 * 已知口径偏差（不影响取证出图）：基准水平视场按「buffer 宽高比」推导；若某些帧里
 * {@code updateDisplay()} 把 {@code mc.displayWidth} 刷回真实窗口，两者宽高比差异也只有 0.08%
 * （854/480 vs 960/540），远小于半像素。
 *
 * <h2>历史坑（写在类型上，避免再犯）</h2>
 * 改造前这里是 {@code m[0] /= s}（{@code s = 1/a}）＋「平移量取 2a(col-1)」：放大倍数方向相反
 * （该乘却除，画面反而拉远），平移量也缺了整图中心那一半。它之所以长期没被发现，是因为唯一会走到
 * 它的 tiling 路径在真机上被网格自检挡在门外；数值自检（{@code TilePlanTest}）现在把这条路径钉死。
 */
public final class TileProjection {

    private TileProjection() {}

    /**
     * 构造正交投影矩阵（列主序，与 {@code glOrtho} 等价；w 维留 1，不做透视除法）。
     *
     * <p>
     * 视高沿屏幕竖轴、横向按 buffer 宽高比推——与透视路径同构（原版世界渲染没有正交矩阵，必须自己建）。
     * 之后的 {@link #applyOrthoTile} 按同一套像素级规则做放大与平移。
     *
     * @param orthoHeight 整图竖直视高（方块）
     * @param width       本片 framebuffer 宽
     * @param height      本片 framebuffer 高
     * @param near        近裁剪面
     * @param far         远裁剪面
     */
    public static float[] orthoMatrix(double orthoHeight, int width, int height, double near, double far) {
        float[] m = new float[16];
        double halfH = Math.max(1.0e-6d, orthoHeight) / 2.0d;
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
     * 透视路径：把 {@code plan} 的 (col,row) 格位写进「读回自 GL 的原版投影矩阵」（原地改写）。
     *
     * <p>
     * 只改四个元素：{@code m[0]}/{@code m[5]}（放大）与 {@code m[8]}/{@code m[9]}（视锥平移）。
     * 其余元素（近远裁剪面、立体/相机缩放项）保持原值，故与原版管线兼容。
     *
     * @param m       列主序 4x4 透视投影矩阵（原地修改）
     * @param plan    有效网格（{@link TilePlan}，全链路唯一定义点）
     * @param col     本片列号（<b>1 起</b>）
     * @param row     本片行号（<b>1 起</b>，1 = 顶行）
     * @param bufferW 本片 framebuffer 宽（= GL 视口宽）
     * @param bufferH 本片 framebuffer 高
     * @return 实际使用的放大倍数（{@code 1/ay}）；1.0 表示仅有位移或矩阵未变
     */
    public static double applyPerspectiveTile(float[] m, TilePlan plan, int col, int row, int bufferW, int bufferH) {
        double[] w = window(plan, col, row, bufferW, bufferH);
        m[0] = (float) (m[0] * w[0]);
        m[5] = (float) (m[5] * w[0]);
        m[8] = (float) w[1];
        m[9] = (float) w[2];
        return w[0];
    }

    /**
     * 正交路径：把 {@code plan} 的 (col,row) 格位写进一个自建的正交投影矩阵（原地改写）。
     *
     * <p>
     * 放大与透视同规则；位移写 {@code m[12]}/{@code m[13]}（{@code w ≡ 1}，写 {@code m[8]}/{@code m[9]}
     * 会变成随景深的斜切），符号与透视相反，推导见类注释。
     *
     * @param m       列主序 4x4 正交投影矩阵（通常来自 {@link #orthoMatrix}；原地修改）
     * @param plan    有效网格
     * @param col     本片列号（1 起）
     * @param row     本片行号（1 起，1 = 顶行）
     * @param bufferW 本片 framebuffer 宽
     * @param bufferH 本片 framebuffer 高
     * @return 实际使用的放大倍数（{@code 1/ay}）
     */
    public static double applyOrthoTile(float[] m, TilePlan plan, int col, int row, int bufferW, int bufferH) {
        double[] w = window(plan, col, row, bufferW, bufferH);
        m[0] = (float) (m[0] * w[0]);
        m[5] = (float) (m[5] * w[0]);
        m[12] = (float) (-w[1]);
        m[13] = (float) (-w[2]);
        return w[0];
    }

    /**
     * 解析本片的像窗参数：{@code [放大倍数, 透视位移X, 透视位移Y]}。
     *
     * <p>
     * 位移按<b>透视</b>口径给出（NDC = {@code m00·x/d - shift}）；正交路径取负号并写进 w 列
     * （见 {@link #applyOrthoTile}）。同时做「格位 == framebuffer 尺寸」的一致性校验：不一致说明
     * 「网格 → 渲染尺寸 → 投影」这条链在某一环被改过，此时任何投影数值都只会产出错图，宁可当场失败。
     */
    private static double[] window(TilePlan plan, int col, int row, int bufferW, int bufferH) {
        if (plan == null) {
            throw new IllegalArgumentException("TileProjection 必须收到 TilePlan（网格唯一来源）");
        }
        int c = Math.max(1, Math.min(plan.cols(), col));
        int r = Math.max(1, Math.min(plan.rows(), row));
        int spanW = plan.spanX(c);
        int spanH = plan.spanY(r);
        if (spanW != bufferW || spanH != bufferH) {
            throw new IllegalStateException(
                "tile 格位与 framebuffer 尺寸不符: grid=" + plan.describe()
                    + " at="
                    + c
                    + ","
                    + r
                    + " 格位="
                    + spanW
                    + "x"
                    + spanH
                    + " buffer="
                    + bufferW
                    + "x"
                    + bufferH);
        }
        int targetW = plan.targetWidth();
        int targetH = plan.targetHeight();
        double ax = spanW / (double) targetW;
        double ay = spanH / (double) targetH;
        if (!(ax > 0.0d) || !(ay > 0.0d) || Double.isNaN(ax) || Double.isNaN(ay)) {
            return new double[] { 1.0d, 0.0d, 0.0d };
        }
        double mag = 1.0d / ay;
        double shiftX = (2.0d * plan.offsetX(c) + spanW - targetW) / (double) spanW;
        double shiftY = (targetH - 2.0d * plan.offsetY(r) - spanH) / (double) spanH;
        return new double[] { mag, shiftX, shiftY };
    }
}
