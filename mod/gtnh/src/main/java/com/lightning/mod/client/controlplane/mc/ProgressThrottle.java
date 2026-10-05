package com.lightning.mod.client.controlplane.mc;

/**
 * 进度上报节流器。
 *
 * <p>
 * 步进动作每 tick 都会推进进度，而 {@code ActionContext.progress} 会同时更新作业进度并写一条
 * {@code action-progress} 事件——逐 tick 上报会把事件流水灌满（一次 60 秒的动作就是上千条）。
 * 因此按「进度增量 ≥ {@link #MIN_DELTA} 或距上次上报 ≥ {@link #MIN_INTERVAL_MS}」放行，
 * 并且<b>终值 1.0 永远放行</b>（调用方靠它确认收尾）。
 *
 * <p>
 * 非线程安全：只在 tick 线程内使用。
 */
public final class ProgressThrottle {

    /** 放行的最小进度增量。 */
    public static final double MIN_DELTA = 0.05d;

    /** 放行的最大静默时长（毫秒）。 */
    public static final long MIN_INTERVAL_MS = 3000L;

    private double lastFraction = -1.0d;
    private long lastMillis;

    /** 本次是否应当上报。 */
    public boolean shouldReport(double fraction) {
        long now = System.currentTimeMillis();
        if (fraction >= 1.0d) {
            lastFraction = fraction;
            lastMillis = now;
            return true;
        }
        boolean first = lastFraction < 0.0d;
        boolean advanced = fraction - lastFraction >= MIN_DELTA;
        boolean stale = now - lastMillis >= MIN_INTERVAL_MS;
        if (first || advanced || stale) {
            lastFraction = fraction;
            lastMillis = now;
            return true;
        }
        return false;
    }
}
