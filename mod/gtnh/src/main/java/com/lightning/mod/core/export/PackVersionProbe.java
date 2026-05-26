package com.lightning.mod.core.export;

import cpw.mods.fml.common.Loader;
import cpw.mods.fml.common.ModContainer;

/**
 * 探测当前加载的整合/模组版本字符串，供场景元数据 {@code gtnhVersion} 等字段使用。
 */
public final class PackVersionProbe {

    private PackVersionProbe() {}

    /**
     * 优先返回 GTNH 整合包版本（dreamcraft），其次 GregTech 模组版本；皆无则空串。
     */
    public static String tryPackVersionString() {
        try {
            Loader loader = Loader.instance();
            if (loader == null) {
                return "";
            }
            String dreamcraft = versionOfMod(loader, "dreamcraft");
            if (!dreamcraft.isEmpty()) {
                return dreamcraft;
            }
            return versionOfMod(loader, "gregtech");
        } catch (Throwable ignored) {
            /* ignore */
        }
        return "";
    }

    private static String versionOfMod(Loader loader, String modId) {
        for (ModContainer mc : loader.getModList()) {
            if (modId.equals(mc.getModId())) {
                String v = mc.getVersion();
                if (v != null && !v.isEmpty()) {
                    return v;
                }
            }
        }
        return "";
    }
}
