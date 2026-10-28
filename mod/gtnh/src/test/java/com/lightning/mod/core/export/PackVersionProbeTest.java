package com.lightning.mod.core.export;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;

import java.util.HashMap;
import java.util.Map;

import org.junit.Test;

/**
 * 两条版本事实的语义判据（`gtnhVersion` = 整合包版本；`gtVersion` = GregTech 版本）。
 *
 * <p>
 * 这里的核心不是「版本串读得到」，而是<b>不许互相冒充</b>：整合包版本只认 dreamcraft，缺席就空串。
 * 改造前的实现会在取不到 dreamcraft 时回退去取 gregtech 版本，于是同一个字段名在不同环境下带两种语义
 * （装了 NHCM 的环境读到整合包版本、只装 GT 的环境读到 GregTech 版本），消费方无从分辨。
 *
 * <p>
 * 判定是纯函数 {@link PackVersionProbe#of}：本测试用「modId → 版本串」的读取口喂四种在场组合，
 * 不需要 FML 运行期，因此每次 `gradlew test` 都会复验一遍。
 */
public class PackVersionProbeTest {

    private static PackVersionProbe.VersionLookup lookup(final String... pairs) {
        final Map<String, String> m = new HashMap<String, String>();
        for (int i = 0; i + 1 < pairs.length; i += 2) {
            m.put(pairs[i], pairs[i + 1]);
        }
        return new PackVersionProbe.VersionLookup() {

            @Override
            public String versionOf(String modId) {
                String v = m.get(modId);
                return v == null ? "" : v;
            }
        };
    }

    /** 两个模组都在场：整合包版本取 dreamcraft，GT 版本独立取 gregtech——互不串台。 */
    @Test
    public void bothPresentAreReadIndependently() {
        PackVersionProbe.Versions v = PackVersionProbe
            .of(lookup(PackVersionProbe.MOD_DREAMCRAFT, "2.8.142", PackVersionProbe.MOD_GREGTECH, "5.09.54.194"));
        assertEquals("2.8.142", v.packVersion);
        assertEquals("5.09.54.194", v.gtVersion);
    }

    /** dreamcraft 缺席（只装 GT 的环境）：gtnhVersion **必须**空串——不许拿 GT 版本顶替。 */
    @Test
    public void gregtechNeverImpersonatesThePackVersion() {
        PackVersionProbe.Versions v = PackVersionProbe.of(lookup(PackVersionProbe.MOD_GREGTECH, "5.09.54.194"));
        assertEquals("dreamcraft 缺席 ⇒ 整合包版本未知，只能是空串", "", v.packVersion);
        assertEquals("GT 版本在自己的字段里照旧可读", "5.09.54.194", v.gtVersion);
    }

    /** dreamcraft 在场、gregtech 缺席：两条事实各自如实表达（一个是版本串、另一个是空串）。 */
    @Test
    public void packVersionPresentWithGtAbsent() {
        PackVersionProbe.Versions v = PackVersionProbe.of(lookup(PackVersionProbe.MOD_DREAMCRAFT, "2.8.142"));
        assertEquals("2.8.142", v.packVersion);
        assertEquals("", v.gtVersion);
    }

    /** 都不在场：两条都是空串（「未知」如实表达，不是错误、不猜）。 */
    @Test
    public void bothAbsentYieldEmptyStrings() {
        PackVersionProbe.Versions v = PackVersionProbe.of(lookup());
        assertEquals("", v.packVersion);
        assertEquals("", v.gtVersion);
    }

    /** dreamcraft 在场但版本串为空（模组元数据缺失）：仍是空串，不回退到 gregtech。 */
    @Test
    public void blankDreamcraftVersionIsStillEmptyAndDoesNotFallBack() {
        PackVersionProbe.Versions v = PackVersionProbe
            .of(lookup(PackVersionProbe.MOD_DREAMCRAFT, "", PackVersionProbe.MOD_GREGTECH, "5.09.54.194"));
        assertEquals("", v.packVersion);
        assertEquals("5.09.54.194", v.gtVersion);
    }

    /** 读取口为 null 或抛错：两条都空串，且**不抛异常**（探测失败不该打断导出）。 */
    @Test
    public void brokenLookupDegradesToEmptyWithoutThrowing() {
        PackVersionProbe.Versions nullLookup = PackVersionProbe.of(null);
        assertEquals("", nullLookup.packVersion);
        assertEquals("", nullLookup.gtVersion);

        PackVersionProbe.Versions throwing = PackVersionProbe.of(new PackVersionProbe.VersionLookup() {

            @Override
            public String versionOf(String modId) {
                throw new IllegalStateException("boom");
            }
        });
        assertEquals("", throwing.packVersion);
        assertEquals("", throwing.gtVersion);
    }

    /**
     * 生产入口在无 FML 运行期（纯 JVM 单测）下同样安全：如实返回空串，不抛异常。
     *
     * <p>
     * 这条不是「版本都读不到」的借口，而是<b>降级行为</b>的判据：导出不能被版本探测拖垮；
     * 真实读数由上面几条纯函数判据覆盖。
     */
    @Test
    public void productionProbeDegradesQuietlyOutsideAFmlRuntime() {
        PackVersionProbe.Versions v = PackVersionProbe.tryVersions();
        assertNotNull(v);
        assertNotNull(v.packVersion);
        assertNotNull(v.gtVersion);
        assertEquals(v.packVersion, PackVersionProbe.tryPackVersionString());
        assertEquals(v.gtVersion, PackVersionProbe.tryGtVersionString());
    }

    /**
     * 常量必须与 FML 注册的 id 一致——用<b>字面量</b>喂读取口来验这条。
     *
     * <p>
     * 读取口里只有字面量 {@code "dreamcraft"} / {@code "gregtech"} 挂着版本；若 {@code MOD_DREAMCRAFT} /
     * {@code MOD_GREGTECH} 写错（拼写、大小写、前缀），{@link PackVersionProbe#of} 一条都取不到 ⇒ 本用例判红。
     * 这比「拿常量与同一个字面量自比」有信息：那条无论常量对不对都恒绿。
     */
    @Test
    public void literalRegisteredModIdsAreWhatTheProbeConsults() {
        PackVersionProbe.Versions v = PackVersionProbe.of(
            lookup(
                "dreamcraft",
                "2.8.142",
                "gregtech",
                "5.09.54.194",
                "DreamCraft",
                "9.9.9",
                "NewHorizonsCoreMod",
                "2.0.0",
                "gregtech_old",
                "5.09.0.0",
                "gregtechpp",
                "5.10.0.0"));
        assertEquals("整合包版本必须按字面量 \"dreamcraft\" 命中（常量写错 ⇒ 这里读到空串）", "2.8.142", v.packVersion);
        assertEquals("GT 版本必须按字面量 \"gregtech\" 命中（常量写错 ⇒ 这里读到空串）", "5.09.54.194", v.gtVersion);
        assertFalse("大小写不同的键不得被命中（读取口是精确 id 匹配，不做大小写归一）", "9.9.9".equals(v.packVersion));
        assertFalse("旧名/带后缀的 id 不得被命中", "5.09.0.0".equals(v.gtVersion) || "5.10.0.0".equals(v.gtVersion));
    }
}
