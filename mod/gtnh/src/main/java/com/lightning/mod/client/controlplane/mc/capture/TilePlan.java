package com.lightning.mod.client.controlplane.mc.capture;

/**
 * 单个机位的投影偏移分片网格（tiling 的<b>唯一</b>定义点）。
 *
 * <h2>为什么必须是唯一的定义点</h2>
 * 投影偏移法要求「每片的渲染像素恰好等于它在整图里的格位」：网格一变，执行器的分片尺寸/落点、
 * 投影覆写的视锥、拼接的贴图位置三者必须同时跟着变。任何「两边各算一遍网格」的写法都会在某个输入下
 * 悄悄分叉——r3 真机事故就是这一类：执行器算出 2×2、投影覆写自己又算了一遍算出 1×1，自检当场判失败
 * （{@code CP-EXEC-001: tile 网格自检失败：执行器 2x2 vs 投影覆写 1x1}）。
 * 故本类是全链路唯一的网格算法：{@link ShotExecutor}（谁渲染哪一片）与
 * {@link ProjectionOverride}（这一片该看哪块视锥）都只<b>消费</b>它的结果，谁也不重算。
 *
 * <h2>两种网格：请求网格 × 像素比追加</h2>
 * <ul>
 * <li><b>请求网格</b>是机位声明的 {@code tile{cols,rows}}（{@code 1×1} 即「分辨率覆写、不拼接」）；
 * 它决定每片的渲染尺寸 {@code pieceW = targetW / cols}、{@code pieceH = targetH / rows}；</li>
 * <li><b>像素比追加</b>：分片渲染时视口宽高比 == 分片宽高比，而目标图宽高比是另一回事，「每片的
 * 像素放大倍数」在 x/y 两轴上一般不同（非正方像素）。要保住正方像素只能用<b>一个</b>放大倍数，
 * 于是多出来的那一轴要再切 {@link #extraSplit} 份——见该方法注释（含 r3 输入为什么不追加）。</li>
 * </ul>
 * 最终网格 {@code cols × rows} 供全链路使用；{@code requested*} 保留声明值，供
 * {@code shot-meta} 留痕对比（事后一眼看出有没有被自动追加）。
 *
 * <h2>尺寸口径（余数归末列/末行）</h2>
 * {@code targetW/H} <b>不能</b>被网格整除时，前 {@code cols-1} 列各取 {@code targetW/cols}（整除），
 * 余数全部留给最后一列；行同理。这样「各片跨度之和 == target」恒成立，拼接不会丢像素。
 *
 * <h2>线程与依赖</h2>
 * 不可变、纯计算：不碰 GL/MC/gson，可在纯 JVM 单测里直接钉死（见 {@code TilePlanTest}）。
 */
public final class TilePlan {

    /** 目标整图宽（= 机位声明的 resolution[0]）。 */
    private final int targetWidth;

    /** 目标整图高。 */
    private final int targetHeight;

    /** 机位声明的列数（≥1，未追加前的值）。 */
    private final int requestedCols;

    /** 机位声明的行数（≥1，未追加前的值）。 */
    private final int requestedRows;

    /** 有效列数（= 请求列数 × 像素比追加列数）。 */
    private final int cols;

    /** 有效行数。 */
    private final int rows;

    /** 单片渲染宽（前 cols-1 列的值）。 */
    private final int pieceWidth;

    /** 单片渲染高（前 rows-1 行的值）。 */
    private final int pieceHeight;

    /** 末列多出的像素（0..cols-1）。 */
    private final int extraWidth;

    /** 末行多出的像素（0..rows-1）。 */
    private final int extraHeight;

    private TilePlan(int targetWidth, int targetHeight, int requestedCols, int requestedRows, int cols, int rows) {
        this.targetWidth = targetWidth;
        this.targetHeight = targetHeight;
        this.requestedCols = requestedCols;
        this.requestedRows = requestedRows;
        this.cols = cols;
        this.rows = rows;
        this.pieceWidth = targetWidth / cols;
        this.pieceHeight = targetHeight / rows;
        this.extraWidth = targetWidth - pieceWidth * cols;
        this.extraHeight = targetHeight - pieceHeight * rows;
    }

    /**
     * 按机位声明 + 真实窗口尺寸解析有效网格（生产路径的唯一入口）。
     *
     * @param targetWidth   目标整图宽（{@code spec.width()}）
     * @param targetHeight  目标整图高（{@code spec.height()}）
     * @param requestedCols 机位声明的 tile 列数（{@code spec.tileCols()}）
     * @param requestedRows 机位声明的 tile 行数（{@code spec.tileRows()}）
     * @param baseWidth     <b>onBegin 捕获的</b>真实窗口宽（不是覆写后的 {@code mc.displayWidth}）
     * @param baseHeight    真实窗口高
     */
    public static TilePlan of(int targetWidth, int targetHeight, int requestedCols, int requestedRows, int baseWidth,
        int baseHeight) {
        int tw = Math.max(1, targetWidth);
        int th = Math.max(1, targetHeight);
        int rc = Math.max(1, requestedCols);
        int rr = Math.max(1, requestedRows);
        // 声明网格下的单片渲染尺寸（整图按请求网格切）
        int renderW = Math.max(1, tw / rc);
        int renderH = Math.max(1, th / rr);
        int[] extra = extraSplit(renderW, renderH, baseWidth, baseHeight);
        return new TilePlan(tw, th, rc, rr, rc * Math.max(1, extra[0]), rr * Math.max(1, extra[1]));
    }

    /**
     * 直接指定有效网格（已定网格的调用方/单测用；不做像素比追加）。
     */
    public static TilePlan ofGrid(int targetWidth, int targetHeight, int cols, int rows) {
        int rc = Math.max(1, cols);
        int rr = Math.max(1, rows);
        return new TilePlan(Math.max(1, targetWidth), Math.max(1, targetHeight), rc, rr, rc, rr);
    }

    /**
     * 像素比追加：按「单片像素 : 真实窗口像素」的两轴比值决定还需切几份。
     *
     * <p>
     * 单片渲染时视口与 framebuffer 都是「这一片」的尺寸，投影的竖直视场仍是机位 fov、水平视场由
     * 分片宽高比推；要让像素保持正方，只能取<b>一个</b>放大倍数，于是「放大得不够的那一轴」必须靠
     * 追加分片补上：
     * <ul>
     * <li>{@code sy < sx}（竖直放大得少）⇒ 沿列切 {@code round(sx/sy)} 段、1 行；</li>
     * <li>{@code sx < sy} ⇒ 1 列、沿行切 {@code round(sy/sx)} 段；</li>
     * <li>相等（或差异远小于半片）⇒ 1×1，不追加。</li>
     * </ul>
     * 「单轴 n 段」这个形态保证子矩形可解，故透视与正交共用同一条 tiling 路径。
     *
     * <p>
     * <b>r3 输入为什么落在「不追加」</b>（真机日志：真实窗口 854×480、机位 persp-tiled 声明
     * resolution 1920×1080、tile 2×2 ⇒ 单片 960×540）：
     * {@code sx = 960/854 = 1.12412}、{@code sy = 540/480 = 1.125} ⇒ 走第二分支（{@code sx < sy}），
     * 但 {@code round(sy/sx) = round(1.00078) = 1} ⇒ 追加 1 份 = <b>不追加</b>，网格就是声明的 2×2。
     * 也就是说「单轴追加」的判定分支被进入，但两轴放大差只有 0.08%，远不到「切一片」所需的 ~50%
     * （{@code round} 到 1 的区间是 [0.5, 1.5)），因此这座机位的 4 片各 960×540、拼起来恰好
     * 1920×1080——这正是 {@link TilePlan#of} 与自检都期望的 2×2。
     *
     * @param pieceW 声明网格下的单片渲染宽
     * @param pieceH 声明网格下的单片渲染高
     * @param baseW  真实窗口宽
     * @param baseH  真实窗口高
     * @return {@code [追加列数, 追加行数]}（各 ≥1）
     */
    public static int[] extraSplit(int pieceW, int pieceH, int baseW, int baseH) {
        double sx = pieceW / (double) Math.max(1, baseW);
        double sy = pieceH / (double) Math.max(1, baseH);
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

    /** 有效列数。 */
    public int cols() {
        return cols;
    }

    /** 有效行数。 */
    public int rows() {
        return rows;
    }

    /** 机位声明的列数。 */
    public int requestedCols() {
        return requestedCols;
    }

    /** 机位声明的行数。 */
    public int requestedRows() {
        return requestedRows;
    }

    /** 目标整图宽。 */
    public int targetWidth() {
        return targetWidth;
    }

    /** 目标整图高。 */
    public int targetHeight() {
        return targetHeight;
    }

    /** 单片渲染宽（前 cols-1 列）。 */
    public int pieceWidth() {
        return pieceWidth;
    }

    /** 单片渲染高（前 rows-1 行）。 */
    public int pieceHeight() {
        return pieceHeight;
    }

    /** 分片总数。 */
    public int tileCount() {
        return cols * rows;
    }

    /** 是否需要拼接（有效网格 &gt; 1×1）。 */
    public boolean tiled() {
        return cols > 1 || rows > 1;
    }

    /** 第 {@code col} 列（<b>1 起</b>）的分片渲染宽：余数归末列。 */
    public int spanX(int col) {
        return col >= cols ? pieceWidth + extraWidth : pieceWidth;
    }

    /** 第 {@code row} 行（<b>1 起</b>）的分片渲染高：余数归末行。 */
    public int spanY(int row) {
        return row >= rows ? pieceHeight + extraHeight : pieceHeight;
    }

    /** 第 {@code col} 列（<b>1 起</b>）在整图里的像素起点。 */
    public int offsetX(int col) {
        return pieceWidth * (col - 1);
    }

    /** 第 {@code row} 行（<b>1 起</b>）在整图里的像素起点。 */
    public int offsetY(int row) {
        return pieceHeight * (row - 1);
    }

    /** 有效网格是否等于给定网格（执行器的防御性自检用）。 */
    public boolean matches(int otherCols, int otherRows) {
        return cols == Math.max(1, otherCols) && rows == Math.max(1, otherRows);
    }

    /** 留痕文本。 */
    public String describe() {
        return cols + "x" + rows + (tiled() ? "" : " (single)");
    }

    @Override
    public String toString() {
        return describe() + " target=" + targetWidth + "x" + targetHeight + " piece=" + pieceWidth + "x" + pieceHeight;
    }
}
