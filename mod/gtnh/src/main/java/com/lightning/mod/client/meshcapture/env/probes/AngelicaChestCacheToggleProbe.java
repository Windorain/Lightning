package com.lightning.mod.client.meshcapture.env.probes;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;

import com.lightning.mod.client.meshcapture.env.CaptureEnvironmentFacts;
import com.lightning.mod.client.meshcapture.env.CaptureEnvironmentProbe;
import com.lightning.mod.client.meshcapture.env.CaptureProbeContext;
import com.lightning.mod.client.meshcapture.env.TogglePresence;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 事实：批处理渲染层的"原版箱子 TESR 网格缓存"开关是否可拨动（PRESENT/ABSENT/UNKNOWN）。
 * <p>
 * 为什么需要这条事实：该层缓存开启时会把原版箱子的模型绘制整段换成缓存网格，根本不经过
 * {@code ModelRenderer.render}——捕获窗口里的 {@code @WrapOperation} 因此没有可包的对象。捕获期可以把开关
 * 临时拨到 false、让缓存路径回落到原版模型渲染；但这一步只能在"开关确实在场"时做。
 * <p>
 * 只读反射：不初始化目标类（{@code initialize=false}）、不写字段；真正拨动发生在捕获窗口边界，
 * 且由 {@link com.lightning.mod.client.meshcapture.compat.AngelicaChestCacheToggle} 统一做与还原。
 */
@SideOnly(Side.CLIENT)
public final class AngelicaChestCacheToggleProbe implements CaptureEnvironmentProbe {

    public static final int DEFAULT_PRIORITY = 650;

    public static final String TARGET_CLASS = "com.gtnewhorizons.angelica.config.AngelicaConfig";

    public static final String TARGET_FIELD = "enableTESRChestCache";

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
        Class<?> target;
        try {
            target = Class.forName(TARGET_CLASS, false, AngelicaChestCacheToggleProbe.class.getClassLoader());
        } catch (ClassNotFoundException e) {
            out.setChestCacheToggle(TogglePresence.ABSENT);
            out.note("angelica_chest_cache_toggle: class absent");
            return;
        } catch (Throwable t) {
            out.setChestCacheToggle(TogglePresence.UNKNOWN);
            out.note("angelica_chest_cache_toggle: unreadable (" + t + ")");
            return;
        }
        try {
            Field f = target.getField(TARGET_FIELD);
            boolean usable = Modifier.isStatic(f.getModifiers()) && f.getType() == boolean.class;
            out.setChestCacheToggle(usable ? TogglePresence.PRESENT : TogglePresence.ABSENT);
            out.note("angelica_chest_cache_toggle: " + (usable ? "present" : "signature unusable"));
        } catch (NoSuchFieldException e) {
            out.setChestCacheToggle(TogglePresence.ABSENT);
            out.note("angelica_chest_cache_toggle: field absent");
        } catch (Throwable t) {
            out.setChestCacheToggle(TogglePresence.UNKNOWN);
            out.note("angelica_chest_cache_toggle: unreadable (" + t + ")");
        }
    }
}
