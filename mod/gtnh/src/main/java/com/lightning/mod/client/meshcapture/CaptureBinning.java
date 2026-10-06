package com.lightning.mod.client.meshcapture;

/**
 * 「忠实复现捕获层」PR-1 的世界坐标分箱（binning）纯函数。
 * <p>
 * 为什么存在：新通道（BLOCK_COMPILE / TESR）的几何以世界坐标（或窗口局部坐标）流入，录窗层需要精确回答
 * 「这个四边形归属哪一格」，而不是沿用旧路径的 closeness 启发式（{@code normalizeVerticesToBlockContract} /
 * {@code resolveOriginForQuad}——旧路径仍在用，不删）。本类零 MC 依赖，可纯 JVM 单测。
 * <p>
 * 纯观察论证：只读顶点坐标做数学推导，不回写任何渲染状态。
 * <p>
 * 约定：格 = 以 {@code floor} 划分的世界整数方块格（负坐标按数学 floor，即 -0.5 → -1，不是截断）。
 */
public final class CaptureBinning {

    private CaptureBinning() {}

    /** 世界坐标 → 格坐标（数学 floor；负坐标正确下取整）。 */
    public static int binOf(double worldCoord) {
        return (int) Math.floor(worldCoord);
    }

    /** 世界坐标 → 块局部坐标（顶点 − 格角点），值域 {@code [0,1)}。 */
    public static double blockLocal(double worldCoord) {
        return worldCoord - binOf(worldCoord);
    }

    /** 单点分箱。 */
    public static Bin binOfPoint(double x, double y, double z) {
        return new Bin(binOf(x), binOf(y), binOf(z));
    }

    /**
     * 质心分箱：先求各顶点坐标算术平均，再对质心做 {@link #binOfPoint}。
     *
     * @param xs/ys/zs 等长（≥1）的顶点坐标分量
     */
    public static Bin centroidBin(double[] xs, double[] ys, double[] zs) {
        checkLengths(xs, ys, zs);
        double cx = 0.0;
        double cy = 0.0;
        double cz = 0.0;
        for (int i = 0; i < xs.length; i++) {
            cx += xs[i];
            cy += ys[i];
            cz += zs[i];
        }
        double n = xs.length;
        return binOfPoint(cx / n, cy / n, cz / n);
    }

    /**
     * 跨箱判定：任一顶点所在格与其余顶点不同即为跨箱（逐分量比较各自 floor 结果）。
     * 单顶点（或全同格）返回 false。
     */
    public static boolean spansMultipleBins(double[] xs, double[] ys, double[] zs) {
        checkLengths(xs, ys, zs);
        int bx = binOf(xs[0]);
        int by = binOf(ys[0]);
        int bz = binOf(zs[0]);
        for (int i = 1; i < xs.length; i++) {
            if (binOf(xs[i]) != bx || binOf(ys[i]) != by || binOf(zs[i]) != bz) {
                return true;
            }
        }
        return false;
    }

    private static void checkLengths(double[] xs, double[] ys, double[] zs) {
        if (xs == null || ys == null || zs == null) {
            throw new IllegalArgumentException("coordinate arrays must be non-null");
        }
        if (xs.length == 0 || ys.length != xs.length || zs.length != xs.length) {
            throw new IllegalArgumentException(
                "coordinate arrays must be same non-zero length, got " + xs.length + "/" + ys.length + "/" + zs.length);
        }
    }

    /** 格坐标三元组（值类型）。 */
    public static final class Bin {

        public final int x;
        public final int y;
        public final int z;

        public Bin(int x, int y, int z) {
            this.x = x;
            this.y = y;
            this.z = z;
        }

        @Override
        public boolean equals(Object o) {
            if (this == o) {
                return true;
            }
            if (!(o instanceof Bin)) {
                return false;
            }
            Bin b = (Bin) o;
            return x == b.x && y == b.y && z == b.z;
        }

        @Override
        public int hashCode() {
            int h = x;
            h = h * 31 + y;
            h = h * 31 + z;
            return h;
        }

        @Override
        public String toString() {
            return x + "," + y + "," + z;
        }
    }
}
