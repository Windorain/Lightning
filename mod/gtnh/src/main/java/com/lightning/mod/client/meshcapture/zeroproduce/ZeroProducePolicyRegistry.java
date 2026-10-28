package com.lightning.mod.client.meshcapture.zeroproduce;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import com.lightning.mod.client.meshcapture.zeroproduce.ZeroProducePolicy.Decision;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 零产出决策注册表：按 {@link ZeroProducePolicy#priority()} 升序找<strong>第一条</strong> {@code applies} 命中的策略，
 * 由它给出裁决。与主批次策略表同一套结构（{@link CopyOnWriteArrayList} + 优先级升序 + 逐条异常隔离）。
 * <p>
 * 内置三条（按优先级）：
 * <ul>
 * <li>{@link TesrOnlyBlockPlaceholderPolicy}（{@value TesrOnlyBlockPlaceholderPolicy#DEFAULT_PRIORITY}）——几何只可能来自
 * TESR、试过却没产出；</li>
 * <li>{@link DeclaredEmptyPolicy}（{@value DeclaredEmptyPolicy#DEFAULT_PRIORITY}）——命中"合法为空"名单；</li>
 * <li>{@link LastResortPlaceholderPolicy}（{@value LastResortPlaceholderPolicy#DEFAULT_PRIORITY}）——兜底。</li>
 * </ul>
 * <p>
 * <strong>本表永不返回空</strong>：一条策略都不命中时给出兜底占位裁决（原因 {@code no_policy_applied}）。
 * 策略抛错也只记日志并继续往下找——"没有裁决"会让这一格退回静默空气，那是本机制唯一不能产生的结局。
 * <p>
 * <strong>占位 = 兜底 + 明确降级显示，不是通用策略</strong>：本表只在某一格<strong>确实没有</strong>可用几何时给出一个
 * 显式的降级结果，让那一格在产物里仍可见、可数、可追。它不是"画不出来就拿方块顶上"的通用方案：
 * <ul>
 * <li>捕获策略的成功标准只有真几何；做不到就整体不参与，把这一格交回本表——见
 * {@link com.lightning.mod.client.meshcapture.postrender.MeshCaptureBlockPostRenderRegistry} 的同名约束；</li>
 * <li>占位落几何时，条目上必须留下 {@code renderMode} 与 {@code captureIssue}，读数里 {@code placeholderCells} 逐格摊开；
 * 只要还有一格是占位，它就是<strong>显性待还债务</strong>——不许算作已烘焙、不许调低或隐藏计数、不许用"看着像"结案；</li>
 * <li>本表只回答"这一格为什么没有几何、接下来怎么显示"，不回答"外观该长什么样"。</li>
 * </ul>
 */
@SideOnly(Side.CLIENT)
public final class ZeroProducePolicyRegistry {

    /** 没有任何策略命中时的原因（说明注册表配置有问题，但产物仍不得静默）。 */
    public static final String REASON_NO_POLICY_APPLIED = "no_policy_applied";

    private static final CopyOnWriteArrayList<ZeroProducePolicy> POLICIES = new CopyOnWriteArrayList<ZeroProducePolicy>();

    private static final List<ZeroProducePolicy> BUILT_IN_POLICIES;

    static {
        register(new TesrOnlyBlockPlaceholderPolicy());
        register(new DeclaredEmptyPolicy());
        register(new LastResortPlaceholderPolicy());
        BUILT_IN_POLICIES = Collections.unmodifiableList(new ArrayList<ZeroProducePolicy>(POLICIES));
    }

    private ZeroProducePolicyRegistry() {}

    /** 注册策略；集成模组在客户端 init 调用即可（{@code priority} 取更小值即更优先）。 */
    public static void register(ZeroProducePolicy policy) {
        if (policy != null) {
            POLICIES.add(policy);
        }
    }

    /**
     * 裁决这一格怎么处理。
     *
     * @return 永不为 {@code null}
     */
    public static Decision decide(ZeroProduceContext ctx) {
        if (ctx == null) {
            return Decision.placeholder(REASON_NO_POLICY_APPLIED);
        }
        List<ZeroProducePolicy> sorted = new ArrayList<ZeroProducePolicy>(POLICIES);
        sorted.sort(Comparator.comparingInt(ZeroProducePolicy::priority));
        for (ZeroProducePolicy p : sorted) {
            try {
                if (!p.applies(ctx)) {
                    continue;
                }
                Decision d = p.decide(ctx);
                if (d != null) {
                    return d;
                }
            } catch (Throwable t) {
                // 单条策略失败不得吞掉这一格：记一条并继续向下找兜底
                logWarn(
                    "[SDE][capture] 零产出策略 %s 失败（继续找下一条）：%s",
                    p.getClass()
                        .getName(),
                    String.valueOf(t));
            }
        }
        return Decision.placeholder(REASON_NO_POLICY_APPLIED);
    }

    /** 已注册策略数（诊断/自检用）。 */
    public static int policyCount() {
        return POLICIES.size();
    }

    /** 单测专用：把注册表复原成内置策略集合。 */
    public static void resetPoliciesForTesting() {
        POLICIES.clear();
        POLICIES.addAll(BUILT_IN_POLICIES);
    }

    private static void logWarn(String format, Object arg0, Object arg1) {
        try {
            FMLLog.warning(format, arg0, arg1);
        } catch (Throwable ignored) {
            // 非 FML 环境（纯 JVM 单测）：日志通道不可用
        }
    }
}
