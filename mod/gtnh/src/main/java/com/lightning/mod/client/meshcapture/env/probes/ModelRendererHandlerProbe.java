package com.lightning.mod.client.meshcapture.env.probes;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import net.minecraft.client.model.ModelRenderer;

import com.lightning.mod.client.meshcapture.env.CaptureEnvironmentFacts;
import com.lightning.mod.client.meshcapture.env.CaptureEnvironmentProbe;
import com.lightning.mod.client.meshcapture.env.CaptureProbeContext;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 诊断标签：{@code ModelRenderer} 类上现在已经有哪些外部处理器方法。
 * <p>
 * 只读反射已加载的 {@link ModelRenderer} 类（变换后的结果，能列出被合并进来的处理器方法），<strong>不参与任何行为</strong>：
 * 方法名集合只用来在日志里说清"这个调用点上现在有谁"。名字里带美元符号是注入器生成处理器的通用命名形态；
 * 本仓自己的处理器会被排除，MixinExtras 为包裹调用点生成的 {@code mixinextras$bridge$...} 桥方法也会被排除
 * （它们是包裹器的实现细节，不是这个调用点上的处理器）。
 * <p>
 * 为什么排除规则是"名字里含本仓前缀"而不是"以本仓前缀开头"：注入器生成的方法名形如
 * {@code handler$<哈希>$<混入配置名>$<前缀>...}，本仓前缀出现在名字中间。按"开头"认会把本仓自己的处理器
 * 当成外部处理器列出来，读数就再也分不清"这个点上还有谁"。
 * <p>
 * 明确的能力边界：本标签<strong>不是</strong>身份判据。它可能混入与该调用点无关的注入方法，也可能因为某个模组
 * 用了别的命名而漏掉——所以任何"按名字决定要不要兜底"的写法都是错的。
 */
@SideOnly(Side.CLIENT)
public final class ModelRendererHandlerProbe implements CaptureEnvironmentProbe {

    public static final int DEFAULT_PRIORITY = 400;

    /** 注入器生成方法名里的分隔符。 */
    private static final String HANDLER_SEPARATOR = String.valueOf((char) 36);

    /** 本仓注入处理器的标记（名字中含它即视为本仓自己的，不算外部处理器）。 */
    private static final String OWN_HANDLER_MARKER = "sde" + HANDLER_SEPARATOR;

    /**
     * MixinExtras 为"包住被 redirect 的调用点"生成的桥方法前缀。它们是包裹器自身的实现细节（真正被包的
     * {@code redirect$...} 方法另有其名），列出来只会让"这个调用点上现在有谁"多出一串自造的噪声。
     */
    private static final String MIXIN_EXTRAS_BRIDGE_PREFIX = "mixinextras" + HANDLER_SEPARATOR
        + "bridge"
        + HANDLER_SEPARATOR;

    @Override
    public int priority() {
        return DEFAULT_PRIORITY;
    }

    @Override
    public boolean applies(CaptureProbeContext ctx) {
        return ctx != null;
    }

    @Override
    public void probe(CaptureProbeContext ctx, CaptureEnvironmentFacts out) {
        try {
            Method[] declared = ModelRenderer.class.getDeclaredMethods();
            List<String> external = new ArrayList<String>();
            for (Method m : declared) {
                String name = m.getName();
                if (!isExternalHandlerName(name)) {
                    continue;
                }
                external.add(name);
            }
            Collections.sort(external);
            out.setHandlers(external);
            out.note("model_renderer_handlers: " + external.size() + " external handler(s)");
        } catch (Throwable t) {
            // 写不出就保持"未采集"（null），与"采集到空集"区分开
            out.note("model_renderer_handlers: failed (" + t + ")");
        }
    }

    /**
     * 这个名字算不算"外部处理器"：不带注入器分隔符的普通方法不算；带分隔符但含本仓标记的也不算。
     * 单测直接打这条判据（纯 JVM 环境里拿不到被变换过的方法名）。
     */
    static boolean isExternalHandlerName(String name) {
        if (name == null || !name.contains(HANDLER_SEPARATOR)) {
            return false;
        }
        if (name.startsWith(MIXIN_EXTRAS_BRIDGE_PREFIX)) {
            return false;
        }
        return !name.contains(OWN_HANDLER_MARKER);
    }
}
