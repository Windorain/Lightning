package com.lightning.mod.client.meshcapture.zeroproduce;

import com.lightning.mod.client.meshcapture.env.Capability;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 首选的占位策略：这一格的几何<strong>只可能</strong>来自特殊渲染器，而该渲染器确实被调用过、却没有产出任何顶点。
 * <p>
 * 命中条件（全部成立）：**有 TE 且该 TE 有特殊渲染器**、补捕获策略对**这一格**确实求值过、本格仍是 0 四边形。
 * <p>
 * 为什么<strong>不</strong>以 {@code getRenderType() == -1} 作为"几何只可能来自 TESR"的判据：那个取值不是可靠标记——
 * 原版箱子就是"没有静态几何、却仍报告 0（标准方块渲染类型）"的方块，用它做门槛会把最典型的 TESR 方块挡在门外，
 * 让它们掉进兜底、只留下一个更含糊的原因。实测读数见验收记录：箱子格正是这样被漏掉的。
 * 真正的判据是"静态批次与补捕获都没有产出顶点"（{@code quadCount == 0} 已覆盖），加上"该格确实有 TESR 并被尝试过"。
 * <p>
 * 为什么值得单列（而不是让兜底策略直接处理）：这条路径上的"零产出"有明确的成因——
 * 几何在模组自编的显示列表或直接 GL 调用里，Java 侧没有可读顶点源（储罐族的典型形态）。
 * 单独给它一个原因（{@code no_observable_geometry}），日志与产物才不会把"读不到"和"根本没渲染"混为一谈。
 * <p>
 * 环境事实的用法（已收窄）：全局事实"模型几何这次确实能录到"（{@link Capability#CAN_CAPTURE}）只说明
 * {@code ModelRenderer} 这条机制可用，<strong>不能</strong>推出"这一格的渲染器一定经过它"——例如另一套渲染层
 * 可能把整个模型绘制换成缓存网格，一个顶点都不会进录制缓冲。因此让位只发生在一种更窄的情形：
 * 本格动态相位<strong>确实收到过顶点</strong>（{@link ZeroProduceContext#dynamicVertexCount()} &gt; 0）
 * 却没有闭合出四边形——那才是"几何进来过但没产出"的匿名异常，交给兜底策略给 {@code zero_produce}。
 * 完全无观测（0 顶点，几何只存在于显示列表/缓存网格）仍由本策略给出 {@code no_observable_geometry}。
 * 事实为 {@link Capability#UNKNOWN} 时不推断，照常裁决（保守：宁可给一个看得见的占位，也不留一个看不见的空气）。
 */
@SideOnly(Side.CLIENT)
public final class TesrOnlyBlockPlaceholderPolicy implements ZeroProducePolicy {

    public static final int DEFAULT_PRIORITY = 1000;

    /** 原因枚举：几何存在但观测不到（显示列表/直接 GL 绘制），Java 侧没有可读顶点源。 */
    public static final String REASON = "no_observable_geometry";

    @Override
    public int priority() {
        return DEFAULT_PRIORITY;
    }

    @Override
    public boolean applies(ZeroProduceContext ctx) {
        if (ctx == null || ctx.quadCount() > 0) {
            return false;
        }
        // 副本 TE 的存在性由捕获侧保证：{@code specialRendererPresent} 与 {@code tesrStrategyAttempted}
        // 只可能在该格确实有 TE 时置位，因此策略层不重复判断 TE 是否为 null（裁决因此可在无客户端环境里单测）
        if (!ctx.specialRendererPresent()) {
            return false;
        }
        if (!ctx.tesrStrategyAttempted()) {
            return false;
        }
        if (ctx.environment()
            .modelRendererGeometry() == Capability.CAN_CAPTURE && ctx.dynamicVertexCount() > 0) {
            return false;
        }
        return true;
    }

    @Override
    public Decision decide(ZeroProduceContext ctx) {
        return Decision.placeholder(REASON);
    }
}
