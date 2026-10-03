package com.lightning.mod.client.meshcapture.parts;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

import com.lightning.mod.client.meshcapture.parts.ae2.Ae2PartProvider;
import com.lightning.mod.client.meshcapture.parts.enderio.EnderIoPartProvider;
import com.lightning.mod.client.meshcapture.parts.fmp.FmpPartProvider;
import com.lightning.mod.client.meshcapture.parts.generic.GenericSingleBoxPartProvider;
import com.lightning.mod.client.meshcapture.parts.inferred.InferredGeometryPartProvider;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 部件提供者注册表（契约 {@code format-parts-contract.md} §7 留白 #1：postrender 式合并语义）。
 *
 * <p>
 * 照抄既有三套 {@code *Registry} 的形状（{@code CopyOnWriteArrayList} + priority 升序 +
 * 逐提供者 try-catch 容错），语义按契约 §7.2：<strong>同档内所有 {@code applies} 命中的提供者
 * 全部执行、结果合并</strong>（多族同格，localId 命名空间隔离，§4）。任何提供者抛异常/反射失败
 * ⇒ 捕获、记日志（{@link FMLLog} + 落进 {@link DispatchOutcome#failures}）、静默跳过该提供者，
 * 导出绝不中断。
 *
 * <p>
 * 内置提供者：
 * <ul>
 * <li>{@link Ae2PartProvider} — 档 1 AE2 族权威（P1.3），priority
 * {@value Ae2PartProvider#DEFAULT_PRIORITY}；</li>
 * <li>{@link EnderIoPartProvider} — 档 1 EnderIO 族权威（P1.4），priority
 * {@value EnderIoPartProvider#DEFAULT_PRIORITY}；</li>
 * <li>{@link FmpPartProvider} — 档 1 FMP 族权威（P1.5），priority
 * {@value FmpPartProvider#DEFAULT_PRIORITY}；</li>
 * <li>{@link GenericSingleBoxPartProvider} — 档 2 通用盒（P1.2），priority
 * {@value GenericSingleBoxPartProvider#DEFAULT_PRIORITY}；</li>
 * <li>{@link InferredGeometryPartProvider} — 档 3 几何推断（P1.6，永不当主来源），priority
 * {@value InferredGeometryPartProvider#DEFAULT_PRIORITY}。</li>
 * </ul>
 * 族提供者构造零反射（引导延迟到 collectParts 内逐环 try-catch），注册本身不会失败；
 * 目标 mod 缺失时 applies 不命中、零开销。
 */
@SideOnly(Side.CLIENT)
public final class PartProviderRegistry {

    private static final CopyOnWriteArrayList<PartProvider> PROVIDERS = new CopyOnWriteArrayList<>();

    /**
     * P1.8 按族提供者开关（P3.3 退化验证依赖）：族名（{@link PartProvider#family()}，如
     * {@code "ae2"}/{@code "eio"}/{@code "fmp"}）在本集合中 ⇒ {@link #dispatch} 跳过该族提供者。
     * <strong>默认空 = 全开，生产行为不变</strong>；仅供验收/探针通道（触发文件驱动）调用，
     * 生产代码不得触碰。开关只影响调度，不注销提供者（恢复 = {@link #clearFamilySwitchesForProbe}）。
     */
    private static final Set<String> DISABLED_FAMILIES_FOR_PROBE = ConcurrentHashMap.newKeySet();

    static {
        register(new Ae2PartProvider());
        register(new EnderIoPartProvider());
        register(new FmpPartProvider());
        register(new GenericSingleBoxPartProvider());
        register(new InferredGeometryPartProvider());
    }

    private PartProviderRegistry() {}

    /** 一次档内调度的结果：合并后的部件列表 + 逐提供者失败记录（容错留痕，契约 §7.2）。 */
    public static final class DispatchOutcome {

        public final List<PartRecord> parts;
        /** 元素形态：{@code <提供者类名>: <异常描述>}；空列表 = 无失败。 */
        public final List<String> failures;

        DispatchOutcome(List<PartRecord> parts, List<String> failures) {
            this.parts = parts;
            this.failures = failures;
        }
    }

    /** 注册提供者；族集成在客户端 init 调用一次即可。 */
    public static void register(PartProvider provider) {
        if (provider != null) {
            PROVIDERS.add(provider);
        }
    }

    /** 注销提供者（降级开关 / 探针注入清理用）。 */
    public static void unregister(PartProvider provider) {
        if (provider != null) {
            PROVIDERS.remove(provider);
        }
    }

    /**
     * 探针/测试专用：清空注册表并返回快照，事后必须 {@link #restoreForProbe} 恢复。
     * 生产路径不得调用（用于"空提供者注册 ⇒ 行为与无框架一致"的验证）。
     */
    public static List<PartProvider> snapshotAndClearForProbe() {
        List<PartProvider> snapshot = new ArrayList<>(PROVIDERS);
        PROVIDERS.clear();
        return snapshot;
    }

    /** 探针/测试专用：恢复 {@link #snapshotAndClearForProbe} 之前的注册表。 */
    public static void restoreForProbe(List<PartProvider> snapshot) {
        PROVIDERS.clear();
        if (snapshot != null) {
            PROVIDERS.addAll(snapshot);
        }
    }

    // ------------------------------------------------------------------ P1.8 按族开关（探针/验收专用）

    /**
     * 探针/验收专用（P1.8/P3.3 退化验证）：开/关指定族的提供者调度。族名 =
     * {@link PartProvider#family()}（{@code ae2|eio|fmp|generic|inferred}）。默认全开。
     */
    public static void setFamilyEnabledForProbe(String family, boolean enabled) {
        if (family == null || family.isEmpty()) {
            return;
        }
        if (enabled) {
            DISABLED_FAMILIES_FOR_PROBE.remove(family);
        } else {
            DISABLED_FAMILIES_FOR_PROBE.add(family);
        }
    }

    /** 探针/验收专用：恢复全部族为开启（默认生产态）。 */
    public static void clearFamilySwitchesForProbe() {
        DISABLED_FAMILIES_FOR_PROBE.clear();
    }

    /** 该族当前是否参与调度（默认 true）。 */
    public static boolean isFamilyEnabled(String family) {
        return family != null && !DISABLED_FAMILIES_FOR_PROBE.contains(family);
    }

    /**
     * 按 {@code tier} 过滤、priority 升序，对<strong>所有</strong> {@code applies} 为 true 的提供者
     * 依次执行 {@link PartProvider#collectParts} 并合并结果（postrender 式语义）。
     * 单提供者失败不中断：记日志 + 落 {@link DispatchOutcome#failures}，继续下一个。
     */
    public static DispatchOutcome dispatch(PartProviderContext ctx, int tier) {
        List<PartRecord> merged = new ArrayList<>();
        List<String> failures = new ArrayList<>();
        if (ctx == null) {
            return new DispatchOutcome(merged, failures);
        }
        List<PartProvider> sorted = new ArrayList<>(PROVIDERS);
        sorted.sort(Comparator.comparingInt(PartProvider::priority));
        for (PartProvider p : sorted) {
            try {
                // P1.8 按族开关（探针/验收专用，默认全开）：被关族直接跳过 ⇒ 格落下一档兜底
                if (!isFamilyEnabled(p.family())) {
                    continue;
                }
                if (p.tier() == tier && p.applies(ctx)) {
                    List<PartRecord> produced = p.collectParts(ctx);
                    if (produced != null) {
                        merged.addAll(produced);
                    }
                }
            } catch (Throwable t) {
                String failure = p.getClass()
                    .getName() + ": "
                    + describeFailure(t);
                FMLLog.warning(
                    "[SDE] PartProviderRegistry: provider %s failed: %s",
                    p.getClass()
                        .getName(),
                    describeFailure(t));
                failures.add(failure);
            }
        }
        return new DispatchOutcome(merged, failures);
    }

    /**
     * 失败描述（P1.8 验收定位需要）：剥 InvocationTargetException 包装 + 前 4 帧堆栈。
     * 只影响 {@link DispatchOutcome#failures} 的诊断文本（该列表本来就只断言空/非空）。
     */
    private static String describeFailure(Throwable t) {
        Throwable c = t;
        while (c instanceof java.lang.reflect.InvocationTargetException && c.getCause() != null) {
            c = c.getCause();
        }
        StringBuilder sb = new StringBuilder();
        sb.append(
            c.getClass()
                .getName());
        if (c.getMessage() != null) {
            sb.append(": ")
                .append(c.getMessage());
        }
        StackTraceElement[] st = c.getStackTrace();
        for (int i = 0; i < Math.min(4, st.length); i++) {
            sb.append(" @ ")
                .append(st[i].toString());
        }
        return sb.toString();
    }
}
