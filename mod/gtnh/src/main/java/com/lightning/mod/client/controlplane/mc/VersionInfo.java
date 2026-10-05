package com.lightning.mod.client.controlplane.mc;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.LightningMod;

import cpw.mods.fml.common.Loader;
import cpw.mods.fml.common.ModContainer;

/**
 * 版本采集（observation-record.md §1 的 {@code versions}、{@code /cp/v1/about} 的 {@code versions}）。
 *
 * <p>
 * A10 要求「仅据观测记录即可解释一次观测」，因此版本必须可复算：本类只用
 * {@link Loader#instance()} 的模组列表与 {@link Loader#MC_VERSION}，不做任何猜测性解析，
 * 取不到就给 {@code "unknown"} 而不是空串（空串会让人误以为版本就是空）。
 *
 * <p>
 * {@code mods} 只列「与场景相关」的模组（文档口径），另外单独给出加载模组总数，
 * 免得把整个整合包几百条塞进每条观测记录。
 */
public final class VersionInfo {

    /** 取不到版本时的占位值。 */
    public static final String UNKNOWN = "unknown";

    /** 观测记录里视为「与场景相关」的模组 id（小写精确匹配）。 */
    private static final Set<String> SCENE_MOD_IDS = Collections.unmodifiableSet(
        new HashSet<String>(
            Arrays.asList(
                "lightning",
                "minecraft",
                "forge",
                "logisticspipes",
                "gregtech",
                "appliedenergistics2",
                "ic2",
                "structurelib",
                "gtnhlib",
                "notenoughitems",
                "codechickencore",
                "dreamcraft",
                "endlessids",
                "notenoughids")));

    private VersionInfo() {}

    /** 本模组版本（{@code LightningMod.VERSION}）。 */
    public static String modVersion() {
        try {
            String v = LightningMod.VERSION;
            return v == null || v.isEmpty() ? UNKNOWN : v;
        } catch (Throwable t) {
            return UNKNOWN;
        }
    }

    /** Minecraft 版本（{@link Loader#MC_VERSION}）。 */
    public static String minecraftVersion() {
        try {
            String v = Loader.MC_VERSION;
            return v == null || v.isEmpty() ? UNKNOWN : v;
        } catch (Throwable t) {
            return UNKNOWN;
        }
    }

    /**
     * Forge 版本。
     *
     * <p>
     * 取值顺序：Forge 自己的 {@link ModContainer} 版本（1.7.10 里 {@code ForgeModContainer}
     * 以 {@code modId=Forge} 注册，{@code getVersion()} 即 Forge 版本）→ {@link Loader} 的
     * FML 版本串 → {@code unknown}。
     */
    public static String forgeVersion() {
        try {
            Loader loader = Loader.instance();
            if (loader != null) {
                for (ModContainer mc : loader.getModList()) {
                    if (mc != null && "forge".equalsIgnoreCase(mc.getModId())) {
                        String v = mc.getVersion();
                        if (v != null && !v.isEmpty()) {
                            return v;
                        }
                    }
                }
                String fml = loader.getFMLVersionString();
                if (fml != null && !fml.isEmpty()) {
                    return fml;
                }
            }
        } catch (Throwable t) {
            CpLog.warn("读取 Forge 版本失败: %s", String.valueOf(t));
        }
        return UNKNOWN;
    }

    /** 已加载模组总数（取不到时为 0）。 */
    public static int modCount() {
        try {
            Loader loader = Loader.instance();
            if (loader == null || loader.getModList() == null) {
                return 0;
            }
            return loader.getModList()
                .size();
        } catch (Throwable t) {
            return 0;
        }
    }

    /** 与场景相关的模组 {@code [{id, version, name}]}（按 id 排序）。 */
    public static JsonArray sceneMods() {
        List<ModContainer> picked = new ArrayList<ModContainer>();
        try {
            Loader loader = Loader.instance();
            if (loader != null && loader.getModList() != null) {
                for (ModContainer mc : loader.getModList()) {
                    if (mc == null || mc.getModId() == null) {
                        continue;
                    }
                    if (SCENE_MOD_IDS.contains(
                        mc.getModId()
                            .toLowerCase(Locale.ROOT))) {
                        picked.add(mc);
                    }
                }
            }
        } catch (Throwable t) {
            CpLog.warn("读取模组列表失败: %s", String.valueOf(t));
        }
        Collections.sort(
            picked,
            (a, b) -> a.getModId()
                .compareToIgnoreCase(b.getModId()));
        JsonArray arr = new JsonArray();
        for (ModContainer mc : picked) {
            JsonObject o = new JsonObject();
            o.addProperty("id", mc.getModId());
            String v = mc.getVersion();
            o.addProperty("version", v == null || v.isEmpty() ? UNKNOWN : v);
            String name = mc.getName();
            if (name != null && !name.isEmpty()) {
                o.addProperty("name", name);
            }
            arr.add(o);
        }
        return arr;
    }

    /** observation-record.md §1 的 {@code versions} 对象。 */
    public static JsonObject observationVersions() {
        JsonObject o = new JsonObject();
        o.addProperty("mod", modVersion());
        o.addProperty("minecraft", minecraftVersion());
        o.addProperty("forge", forgeVersion());
        o.add("mods", sceneMods());
        o.addProperty("modsTotal", modCount());
        return o;
    }

    /** {@code /cp/v1/about} 里的 {@code versions} 字段。 */
    public static JsonObject aboutVersions() {
        JsonObject o = new JsonObject();
        o.addProperty("mod", modVersion());
        o.addProperty("minecraft", minecraftVersion());
        o.addProperty("forge", forgeVersion());
        o.addProperty("modsTotal", modCount());
        return o;
    }
}
