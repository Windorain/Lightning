package com.lightning.mod.client.meshcapture.zeroproduce;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 兜底：任何"世界里存在非空气方块 + 本格 0 四边形"的格一律落占位。
 * <p>
 * 为什么默认判占位而不是判空：把"看不见"变成"看得见的占位"是可回退的（产物里能区分、能计数、能人眼过一遍），
 * 把"丢了"变成"静默空气"是不可发现的。所以"合法为空"只能由声明给出（见 {@link DeclaredEmptyPolicy}），
 * 不能由兜底猜。
 * <p>
 * 它同时保证一条结构性不变式：<strong>不存在静默 air</strong>——每一格 0 产出都必须走完三选一
 * （占位 / 合法空 / 兜底占位），于是 {@code captureStats.lostCells} 由构造保持为 0。
 */
@SideOnly(Side.CLIENT)
public final class LastResortPlaceholderPolicy implements ZeroProducePolicy {

    public static final int DEFAULT_PRIORITY = 9000;

    /** 原因枚举：没有更具体的解释可用，只知道"这一格没有产出"。 */
    public static final String REASON = "zero_produce";

    @Override
    public int priority() {
        return DEFAULT_PRIORITY;
    }

    @Override
    public boolean applies(ZeroProduceContext ctx) {
        if (ctx == null || ctx.quadCount() > 0) {
            return false;
        }
        // 扫描身份就是空气：不是丢块，也不是要占位的格（调用方本就不会走到这里）
        return ctx.registryId() != null && !"air".equals(ctx.registryId());
    }

    @Override
    public Decision decide(ZeroProduceContext ctx) {
        return Decision.placeholder(REASON);
    }
}
