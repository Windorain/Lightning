package com.lightning.mod.core.export;

import java.util.HashMap;
import java.util.Map;

import cpw.mods.fml.common.Loader;
import cpw.mods.fml.common.ModContainer;

/**
 * 探测「GTNH 整合包版本」与「GregTech 版本」两条<b>互不冒充</b>的版本事实，供场景元数据使用。
 *
 * <h2>两条事实必须分开（字段语义固定）</h2>
 *
 * <p>
 * 场景文件的 {@code gtnhVersion} 字段的语义是<b>GTNH 整合包版本串</b>，可由整合包提供方（dreamcraft /
 * New Horizons Core Mod）声明；GregTech 的版本是<b>另一个事实</b>，写在 {@code gtVersion}。
 *
 * <p>
 * 改造前这里只有一个「整合包版本」入口，取不到 dreamcraft 时<b>回退去取 gregtech 版本</b>：于是同一个
 * 字段名在不同环境下读到两种语义（装了 NHCM 的环境读到整合包版本，只装 GT 的环境读到 GregTech 版本），
 * 消费方无法可靠解读，也无法分辨「整合包版本未知」与「这是 GregTech 版本」。
 *
 * <p>
 * 现在的规则：{@code gtnhVersion} <b>只</b>来自 dreamcraft；缺席即空串（「未知」如实表达），
 * <b>绝不</b>拿 GregTech 版本顶替。GregTech 版本只经 {@code gtVersion} 出口。
 *
 * <h2>可离线复算</h2>
 *
 * <p>
 * 判定是纯函数：{@link #of(VersionLookup)} 只吃一张「modId → 版本串」的读取口，单测可以完全离线地
 * 复算「dreamcraft 在场 / 缺席 + GT 独立读数」的全部分支，不需要 FML 运行期。生产路径用
 * {@link #tryVersions()} 把 FML 的模组表包装成同一个读取口。
 */
public final class PackVersionProbe {

    /** GTNH 整合包版本的承载模组。 */
    public static final String MOD_DREAMCRAFT = "dreamcraft";

    /** GregTech 的模组 id。 */
    public static final String MOD_GREGTECH = "gregtech";

    private PackVersionProbe() {}

    /** 版本读取口：给定 modId 返回其版本串（未安装返回 {@code null} 或空串）。 */
    public interface VersionLookup {

        /** @param modId 模组 id（小写，与 FML 的 {@code ModContainer#getModId()} 同口径） */
        String versionOf(String modId);
    }

    /**
     * 一次探测得到的两条版本事实。
     *
     * <p>
     * 两条都取自<b>同一次</b>探测：调用方拿到的 {@code packVersion} 与 {@code gtVersion} 不会来自两个不同
     * 时刻的模组表。空串一律表示「未知 / 未安装」，不是错误。
     */
    public static final class Versions {

        /** GTNH 整合包版本（dreamcraft）；缺席为 {@code ""}。 */
        public final String packVersion;

        /** GregTech 版本；缺席为 {@code ""}。 */
        public final String gtVersion;

        Versions(String packVersion, String gtVersion) {
            this.packVersion = packVersion == null ? "" : packVersion;
            this.gtVersion = gtVersion == null ? "" : gtVersion;
        }

        /** 供 {@code toString} / 日志用的紧凑描述（不含任何本地路径）。 */
        @Override
        public String toString() {
            return "Versions[pack=" + packVersion + ", gt=" + gtVersion + "]";
        }
    }

    /**
     * 纯函数：按读取口给出的模组版本，产出两条版本事实。
     *
     * <p>
     * {@code gtnhVersion} <b>只</b>认 {@link #MOD_DREAMCRAFT}；读取口为 {@code null} 或抛错时两条都取空串
     * （「探测不到」如实表达，不猜、不回退到别的模组）。
     */
    public static Versions of(VersionLookup lookup) {
        if (lookup == null) {
            return new Versions("", "");
        }
        return new Versions(readQuietly(lookup, MOD_DREAMCRAFT), readQuietly(lookup, MOD_GREGTECH));
    }

    /** 生产入口：把 FML 的模组表包成读取口后取两条版本事实。 */
    public static Versions tryVersions() {
        try {
            Loader loader = Loader.instance();
            if (loader == null) {
                return new Versions("", "");
            }
            Map<String, String> versions = new HashMap<String, String>();
            for (ModContainer mc : loader.getModList()) {
                String id = mc.getModId();
                if (id == null || versions.containsKey(id)) {
                    continue;
                }
                String v = mc.getVersion();
                versions.put(id, v == null ? "" : v);
            }
            return of(new MapLookup(versions));
        } catch (Throwable ignored) {
            /* 运行期不可用时如实返回「探测不到」，不影响导出 */
        }
        return new Versions("", "");
    }

    /**
     * GTNH 整合包版本串（{@code gtnhVersion} 的唯一来源）。
     *
     * <p>
     * dreamcraft 缺席时为 {@code ""}——<b>不</b>回退 GregTech 版本（见类注释）。
     */
    public static String tryPackVersionString() {
        return tryVersions().packVersion;
    }

    /** GregTech 版本串（{@code gtVersion} 的唯一来源）；gregtech 缺席时为 {@code ""}。 */
    public static String tryGtVersionString() {
        return tryVersions().gtVersion;
    }

    private static String readQuietly(VersionLookup lookup, String modId) {
        try {
            String v = lookup.versionOf(modId);
            return v == null ? "" : v;
        } catch (Throwable ignored) {
            return "";
        }
    }

    /** 读取口的最简实现：一张 modId → 版本串的 map。 */
    static final class MapLookup implements VersionLookup {

        private final Map<String, String> versions;

        MapLookup(Map<String, String> versions) {
            this.versions = versions == null ? new HashMap<String, String>() : versions;
        }

        @Override
        public String versionOf(String modId) {
            String v = versions.get(modId);
            return v == null ? "" : v;
        }
    }
}
