package com.lightning.mod.core.session;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.junit.Test;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.lightning.mod.core.export.PackVersionProbe;

/**
 * 两条版本事实的<b>装配判据</b>：值是怎么一路走到产物里的（不是「纯函数算得对」而已）。
 *
 * <h2>为什么要走到装配</h2>
 *
 * <p>
 * 只测 {@link PackVersionProbe} 的纯函数会恒绿：字段算得再对，只要某条导出装配路径忘了把它填进
 * {@code meta}，消费方照样读不到。本测试因此用<b>生产装配</b>（{@link ExportSceneWriter#buildDocument}
 * 建文档 → {@link ExportSceneWriter#serialize} 出字节 → 解 Envelope 读 {@code meta}）来验：
 *
 * <ol>
 * <li>两条版本事实都随产物走（世界文档根 + Envelope 的 {@code meta}）；</li>
 * <li>dreamcraft 缺席时 {@code meta.gtnhVersion} 是<b>空串</b>，GT 版本只出现在 {@code meta.gtVersion}
 * ——这正是「同一字段名两种语义」缺陷的复现口径；</li>
 * <li><b>源码级棘轮</b>：main 里每个 {@code new ExportSceneWriter.Meta()} 装配点都必须同时赋值
 * {@code gtnhVersion} 与 {@code gtVersion}，新增一条装配路径却漏填字段会被判红。</li>
 * </ol>
 */
public class ExportVersionFieldsTest {

    private static final String PACK_VERSION = "2.8.142";
    private static final String GT_VERSION = "5.09.54.194";

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

    /** 按生产口径装配 Meta：两条版本事实都来自同一次探测。 */
    private static ExportSceneWriter.Meta metaFrom(PackVersionProbe.Versions versions) {
        ExportSceneWriter.Meta meta = new ExportSceneWriter.Meta();
        meta.structureId = "structuredata.exported";
        meta.label = "structuredata.exported";
        meta.author = "tester";
        meta.gtnhVersion = versions.packVersion;
        meta.gtVersion = versions.gtVersion;
        meta.description = null;
        return meta;
    }

    private static Map<Integer, String> oneFrame() {
        Map<Integer, String> frames = new TreeMap<Integer, String>();
        frames.put(Integer.valueOf(0), "{\"geometryPhase\":\"scan\",\"id\":\"s0\",\"cellGrid\":[[[0]]]}");
        return frames;
    }

    private static JsonObject envelopeOf(JsonObject document) {
        byte[] bytes = ExportSceneWriter.serialize(document, false);
        return new JsonParser().parse(new String(bytes, StandardCharsets.UTF_8))
            .getAsJsonObject();
    }

    /** 世界文档：根上与 Envelope 的 meta 都必须带两条版本事实，且互不串台。 */
    @Test
    public void worldDocumentCarriesBothVersionFieldsIntoEnvelopeMeta() {
        ExportSceneWriter.Meta meta = metaFrom(
            PackVersionProbe
                .of(lookup(PackVersionProbe.MOD_DREAMCRAFT, PACK_VERSION, PackVersionProbe.MOD_GREGTECH, GT_VERSION)));
        JsonObject doc = ExportSceneWriter.buildDocument(meta, oneFrame(), ExportSceneWriter.Shape.WORLD, null, null);

        assertEquals(
            "世界文档根必须写整合包版本",
            PACK_VERSION,
            doc.get("gtnhVersion")
                .getAsString());
        assertEquals(
            "世界文档根必须写 GT 版本",
            GT_VERSION,
            doc.get("gtVersion")
                .getAsString());

        JsonObject metaObj = envelopeOf(doc).getAsJsonObject("meta");
        assertEquals(
            PACK_VERSION,
            metaObj.get("gtnhVersion")
                .getAsString());
        assertEquals(
            "Envelope 的 meta 必须搬运 gtVersion（否则消费方只能读 payload）",
            GT_VERSION,
            metaObj.get("gtVersion")
                .getAsString());
    }

    /**
     * dreamcraft 缺席（只装 GT 的环境）：{@code gtnhVersion} 必须空串，GT 版本只出现在 {@code gtVersion}。
     *
     * <p>
     * 这就是缺陷的复现口径：改造前同一份环境会把 5.09.54.194 写进 {@code gtnhVersion}。
     */
    @Test
    public void absentDreamcraftLeavesGtnhVersionEmptyAndGtVersionIndependent() {
        ExportSceneWriter.Meta meta = metaFrom(PackVersionProbe.of(lookup(PackVersionProbe.MOD_GREGTECH, GT_VERSION)));
        JsonObject doc = ExportSceneWriter.buildDocument(meta, oneFrame(), ExportSceneWriter.Shape.WORLD, null, null);

        assertEquals(
            "整合包版本缺席 ⇒ 空串，不得用 GT 版本冒充",
            "",
            doc.get("gtnhVersion")
                .getAsString());
        assertEquals(
            GT_VERSION,
            doc.get("gtVersion")
                .getAsString());

        JsonObject metaObj = envelopeOf(doc).getAsJsonObject("meta");
        assertEquals(
            "",
            metaObj.get("gtnhVersion")
                .getAsString());
        assertEquals(
            GT_VERSION,
            metaObj.get("gtVersion")
                .getAsString());
        assertFalse(
            "meta.gtnhVersion 绝不能等于 GT 版本（同一字段名两种语义的回归哨）",
            GT_VERSION.equals(
                metaObj.get("gtnhVersion")
                    .getAsString()));
    }

    /** 裸单结构形态：帧根上的两条版本事实同样要经 Envelope 搬进 meta。 */
    @Test
    public void structureShapeCarriesBothVersionFieldsIntoSingleEnvelope() {
        JsonObject root = new JsonParser()
            .parse(
                "{\"geometryPhase\":\"baked\",\"mode\":\"multiblock\",\"id\":\"s\",\"label\":\"s\","
                    + "\"author\":\"tester\",\"gtnhVersion\":\""
                    + PACK_VERSION
                    + "\",\"gtVersion\":\""
                    + GT_VERSION
                    + "\","
                    + "\"description\":null,\"cellGrid\":[[[0]]],\"blockPalette\":[]}")
            .getAsJsonObject();
        JsonObject metaObj = envelopeOf(root).getAsJsonObject("meta");
        assertEquals(
            PACK_VERSION,
            metaObj.get("gtnhVersion")
                .getAsString());
        assertEquals(
            "裸单结构形态也必须搬运 gtVersion",
            GT_VERSION,
            metaObj.get("gtVersion")
                .getAsString());
    }

    // ------------------------------------------------------------------ 源码级棘轮

    private static Path modSourceRoot() {
        Path dir = Paths.get("")
            .toAbsolutePath()
            .normalize();
        for (int i = 0; i < 8 && dir != null; i++) {
            Path candidate = dir.resolve("src")
                .resolve("main")
                .resolve("java");
            if (Files.isDirectory(candidate)) {
                return candidate;
            }
            dir = dir.getParent();
        }
        fail(
            "找不到 mod 的 src/main/java（从 " + Paths.get("")
                .toAbsolutePath() + " 向上 8 层）");
        return null;
    }

    private static List<Path> javaFilesUnder(Path root) throws IOException {
        List<Path> out = new ArrayList<Path>();
        Files.walk(root)
            .filter(
                p -> p.toString()
                    .endsWith(".java"))
            .forEach(out::add);
        return out;
    }

    /** 读源码并归一化换行（本仓 core.autocrlf=true，新鲜检出是 CRLF）。 */
    private static String readNormalized(Path p) throws IOException {
        return new String(Files.readAllBytes(p), StandardCharsets.UTF_8).replace("\r\n", "\n");
    }

    private static int countOf(String haystack, String needle) {
        int count = 0;
        int from = 0;
        while (true) {
            int at = haystack.indexOf(needle, from);
            if (at < 0) {
                return count;
            }
            count++;
            from = at + needle.length();
        }
    }

    /** 装配点识别口径：{@code new ExportSceneWriter.Meta(} 容忍空白与换行。 */
    private static final Pattern META_ASSEMBLY_SITE = Pattern.compile("new\\s+ExportSceneWriter\\.Meta\\s*\\(");

    /** 每个装配点只在自己的窗口里找赋值：窗口 = 该装配点到下一个装配点之间，且最长 {@value #SITE_WINDOW_CHARS} 字符。 */
    private static final int SITE_WINDOW_CHARS = 1500;

    /**
     * <b>每个</b> {@code new ExportSceneWriter.Meta(...)} 装配点都必须在<b>自己的窗口里</b>同时赋值两条版本字段。
     *
     * <p>
     * 这条锁的是「所有生产导出装配路径一致」：新增一条装配路径而漏填 {@code gtVersion}（或漏填
     * {@code gtnhVersion}）会立即可见——产物的字段是否齐全不再取决于谁记得填。
     *
     * <p>
     * 窗口级（而不是文件级计数）是刻意的：文件级计数下，一个装配点写两遍、另一个不写，总数仍然相等，
     * 漏填的那条就藏起来了。
     */
    @Test
    public void everyMetaAssemblySiteFillsBothVersionFieldsInItsOwnWindow() throws IOException {
        Path root = modSourceRoot();
        List<String> offenders = new ArrayList<String>();
        int sites = 0;
        for (Path file : javaFilesUnder(root)) {
            String src = readNormalized(file);
            Matcher m = META_ASSEMBLY_SITE.matcher(src);
            List<Integer> starts = new ArrayList<Integer>();
            while (m.find()) {
                starts.add(Integer.valueOf(m.start()));
            }
            if (starts.isEmpty()) {
                continue;
            }
            sites += starts.size();
            for (int i = 0; i < starts.size(); i++) {
                int from = starts.get(i)
                    .intValue();
                int to = i + 1 < starts.size() ? starts.get(i + 1)
                    .intValue() : src.length();
                to = Math.min(to, from + SITE_WINDOW_CHARS);
                String window = src.substring(from, to);
                boolean hasGtnh = window.contains(".gtnhVersion =");
                boolean hasGt = window.contains(".gtVersion =");
                if (!hasGtnh || !hasGt) {
                    offenders.add(
                        file.getFileName() + " 第 ~"
                            + lineOf(src, from)
                            + " 行的 Meta 装配点缺少赋值："
                            + (hasGtnh ? "" : "gtnhVersion ")
                            + (hasGt ? "" : "gtVersion"));
                }
            }
        }
        assertTrue("棘轮自身失效：一个 Meta 装配点都没扫到（口径或目录结构变了）", sites >= 3);
        assertTrue("以下装配点漏填版本字段：\n" + String.join("\n", offenders), offenders.isEmpty());
    }

    /** 字符偏移 → 行号（诊断可读性用；1 起）。 */
    private static int lineOf(String src, int offset) {
        int line = 1;
        for (int i = 0; i < offset && i < src.length(); i++) {
            if (src.charAt(i) == '\n') {
                line++;
            }
        }
        return line;
    }

    /** {@code SceneEnvelopeBuilder} 的两条分支都必须成对搬运两条版本字段（漏一条就有一半产物读不到）。 */
    @Test
    public void envelopeBuilderCopiesBothVersionFieldsInEveryBranch() throws IOException {
        Path target = modSourceRoot().resolve("com/lightning/mod/client/export/SceneEnvelopeBuilder.java");
        assertTrue("找不到 SceneEnvelopeBuilder.java: " + target, Files.isRegularFile(target));
        String src = readNormalized(target);
        int gtnh = countOf(src, "copyIfPresent(rawFinal, meta, \"gtnhVersion\");");
        int gt = countOf(src, "copyIfPresent(rawFinal, meta, \"gtVersion\");");
        assertEquals("两条版本字段必须成对搬运（分支数不一致 ⇒ 有一半产物读不到 gtVersion）", gtnh, gt);
        assertEquals("Envelope 只有两条形态分支", 2, gtnh);
    }
}
