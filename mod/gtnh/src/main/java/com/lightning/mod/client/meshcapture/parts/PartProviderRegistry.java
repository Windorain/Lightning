package com.lightning.mod.client.meshcapture.parts;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import com.lightning.mod.client.meshcapture.parts.generic.GenericSingleBoxPartProvider;

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
 * <li>{@link GenericSingleBoxPartProvider} — 档 2 通用盒（P1.2），priority
 * {@value GenericSingleBoxPartProvider#DEFAULT_PRIORITY}。</li>
 * </ul>
 * 族权威提供者（P1.3–P1.5，档 1）与几何推断（P1.6，档 3）在各自任务内 {@link #register}。
 */
@SideOnly(Side.CLIENT)
public final class PartProviderRegistry {

    private static final CopyOnWriteArrayList<PartProvider> PROVIDERS = new CopyOnWriteArrayList<>();

    static {
        register(new GenericSingleBoxPartProvider());
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
                if (p.tier() == tier && p.applies(ctx)) {
                    List<PartRecord> produced = p.collectParts(ctx);
                    if (produced != null) {
                        merged.addAll(produced);
                    }
                }
            } catch (Throwable t) {
                String failure = p.getClass()
                    .getName() + ": "
                    + t;
                FMLLog.warning(
                    "[SDE] PartProviderRegistry: provider %s failed: %s",
                    p.getClass()
                        .getName(),
                    String.valueOf(t));
                failures.add(failure);
            }
        }
        return new DispatchOutcome(merged, failures);
    }
}
