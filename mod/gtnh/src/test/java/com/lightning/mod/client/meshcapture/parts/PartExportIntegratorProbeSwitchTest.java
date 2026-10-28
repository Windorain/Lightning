package com.lightning.mod.client.meshcapture.parts;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;

import org.junit.Test;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * {@code PartExportIntegrator.setEnabledForProbe(false) vs true} 的「字节一致」判据 —— <b>离线单测</b>。
 *
 * <h2>这条判据的来历</h2>
 *
 * 老部件验收器具用一对实验证明「部件采集对无部件结构逐字节无副作用」：
 * 同一结构分别在探针开关 {@code false}（{@code MeshCaptureService} 完全跳过逐格
 * {@code collectParts}）与 {@code true}（照常逐格采集，但结构里只有满方块/零产出格）
 * 下导出，两份文档必须**逐字节相同**。这是老设施删除时要保住的一条<b>已成立的不变量</b>：
 * 探针开关的<b>唯一</b>合法语义是「跳过采集」，它绝不允许改变任何一份产物的字节。
 *
 * <p>
 * 该判据在游戏内的承载已全部删除（{@code PartsAcceptanceAutomation} 的 A/B 段、
 * {@code PartsExportProbe}、以及调用 {@code setEnabledForProbe} 的唯一两个调用点），
 * 但按既有裁决<b>保留开关口本身</b>（{@code PartExportIntegrator} 仍被生产路径
 * {@code MeshCaptureService} 使用），并把判据<b>降级为本离线单测</b>。
 *
 * <h2>为什么放在离线单测里（而不是留一个游戏内探针）</h2>
 *
 * 判据的实质是 {@code StructureSink} 在「无部件」输入下的<b>落盘行为</b>：{@code hasParts()} 为假 ⇒
 * {@code writeInto} 一个字段都不写。这一段是纯 Java（{@code JsonObject} + 集合），不需要 MC 运行时、
 * 不需要世界、不需要渲染 —— 把它做进 {@code gradle test} 之后，unbiased 的门禁每跑一次就复验一次，
 * 而留在游戏内则只有人手点火才会跑到（旧入口删除后已无任何自动入口）。
 *
 * <h2>非空性（判据不恒绿）</h2>
 *
 * {@link #realPartBreaksTheEquality()} 是负对照：同一个 sink 只要真的收到一个部件，
 * 文档必须**变**（多出 {@code cellPartsGrid} / {@code partLists}）。没有这一条，
 * 「一致」可以靠「两边都不写」蒙过去。
 */
public class PartExportIntegratorProbeSwitchTest {

    /** sink 会写入文档的两个字段（无部件 ⇒ 两者都不产出）。 */
    private static final String[] SINK_OWNED_FIELDS = { "cellPartsGrid", "partLists" };

    private static final Gson CANONICAL = new GsonBuilder().setPrettyPrinting()
        .disableHtmlEscaping()
        .create();

    /** 稳定序列化（Gson 的 JsonObject 保插入序 ⇒ 同一写入顺序必得同一字节）。 */
    private static String canonical(JsonObject o) {
        return CANONICAL.toJson(o);
    }

    /**
     * 一份「无部件的结构文档」基线：形态取自 {@code MeshCaptureService} 的产出骨架
     * （{@code schemaVersion} + {@code structure.blockPalette}）。
     *
     * <p>
     * 刻意包含一个非空气的方块条目：判据要证明的正是「哪怕结构里有方块，只要没有部件，
     * 采集开关也不改变字节」。
     */
    private static JsonObject baselineDocument() {
        JsonObject doc = new JsonObject();
        doc.addProperty("schemaVersion", Integer.valueOf(1));

        JsonObject structure = new JsonObject();
        structure.addProperty("sizeX", Integer.valueOf(2));
        structure.addProperty("sizeY", Integer.valueOf(1));
        structure.addProperty("sizeZ", Integer.valueOf(2));

        JsonArray palette = new JsonArray();
        JsonObject air = new JsonObject();
        air.addProperty("index", Integer.valueOf(0));
        air.addProperty("registryId", "minecraft:air");
        palette.add(air);
        JsonObject stone = new JsonObject();
        stone.addProperty("index", Integer.valueOf(1));
        stone.addProperty("registryId", "minecraft:stone");
        stone.addProperty("meta", Integer.valueOf(0));
        palette.add(stone);
        structure.add("blockPalette", palette);

        doc.add("structure", structure);
        return doc;
    }

    /** 一个真实的部件记录（不经任何 MC 原语构造，故离线可用）。 */
    private static PartRecord realPart() {
        PartRecord p = new PartRecord(
            "ae2:cable",
            "appliedenergistics2:item.ItemMultiPart:16",
            new PartSource(PartSource.FAMILY_AE2, false, PartSource.PROVENANCE_BOTH, PartSource.TIER_FAMILY));
        p.displayName = "ME Glass Cable";
        p.tooltip.add("ME Glass Cable");
        return p;
    }

    /** 满方块格的采集结果（{@code hostFullCube=true} ⇒ 该格零部件数据）。 */
    private static PartCaptureResult fullCubeCell() {
        return PartCaptureResult.fullCube();
    }

    /** 非满方块但三档全空的采集结果（{@code parts} 为空 ⇒ 同样零部件数据）。 */
    private static PartCaptureResult emptyCell() {
        return PartCaptureResult.of(new ArrayList<PartRecord>(), 0, new ArrayList<String>(), new ArrayList<String>());
    }

    /** 生产路径的默认值必须是「开」——关掉它是探针 A/B 的专用动作。 */
    @Test
    public void probeSwitchDefaultsToEnabled() {
        assertEquals("生产路径必须默认开启部件采集", true, PartExportIntegrator.isEnabled());
    }

    /** 开关的读回：设 false 读 false，设 true 读 true（这就是「保留开关口」的本体）。 */
    @Test
    public void probeSwitchIsReadableBack() {
        boolean original = PartExportIntegrator.isEnabled();
        try {
            PartExportIntegrator.setEnabledForProbe(false);
            assertFalse(PartExportIntegrator.isEnabled());
            PartExportIntegrator.setEnabledForProbe(true);
            assertTrue(PartExportIntegrator.isEnabled());
        } finally {
            PartExportIntegrator.setEnabledForProbe(original);
        }
    }

    /**
     * <b>核心判据</b>：无部件结构在 {@code setEnabledForProbe(false)} 与 {@code true} 下逐字节相同。
     *
     * <p>
     * 两个分支各自的语义：
     * <ul>
     * <li>{@code false} ⇒ {@code MeshCaptureService} 不调用 {@code addCell}，sink 收不到任何格；</li>
     * <li>{@code true} ⇒ 逐格调用 {@code addCell}，但结构里只有满方块/零产出格。</li>
     * </ul>
     */
    @Test
    public void fullCubeOnlyStructureIsByteIdenticalWithAndWithoutProbeSwitch() {
        boolean original = PartExportIntegrator.isEnabled();
        try {
            // A) 开关关：采集整段被跳过
            PartExportIntegrator.setEnabledForProbe(false);
            JsonObject disabledDoc = baselineDocument();
            PartExportIntegrator.StructureSink disabledSink = PartExportIntegrator.newStructureSink(2, 1, 2);
            disabledSink.writeInto(disabledDoc);
            assertFalse("开关关时 sink 不该有任何部件", disabledSink.hasParts());

            // B) 开关开：逐格采集，但每格都是满方块或零产出
            PartExportIntegrator.setEnabledForProbe(true);
            JsonObject enabledDoc = baselineDocument();
            PartExportIntegrator.StructureSink enabledSink = PartExportIntegrator.newStructureSink(2, 1, 2);
            enabledSink.addCell(0, 0, 0, fullCubeCell(), null, null, 0);
            enabledSink.addCell(0, 0, 1, emptyCell(), null, null, 0);
            enabledSink.addCell(1, 0, 1, null, null, null, 0);
            enabledSink.writeInto(enabledDoc);
            assertFalse("无部件输入下 sink 不该产出部件数据", enabledSink.hasParts());

            assertEquals("无部件结构：探针开关不得改变产物字节", canonical(disabledDoc), canonical(enabledDoc));
            assertEquals("两份文档都不得出现 sink 自有字段", canonical(baselineDocument()), canonical(enabledDoc));
        } finally {
            PartExportIntegrator.setEnabledForProbe(original);
        }
    }

    /** sink 自有字段（{@code cellPartsGrid} / {@code partLists}）在无部件时完全不产出。 */
    @Test
    public void sinkWritesNoFieldWithoutParts() {
        JsonObject doc = baselineDocument();
        PartExportIntegrator.StructureSink sink = PartExportIntegrator.newStructureSink(1, 1, 1);
        sink.addCell(0, 0, 0, fullCubeCell(), null, null, 0);
        sink.writeInto(doc);
        for (String field : SINK_OWNED_FIELDS) {
            assertFalse("无部件时不得产出 " + field, doc.has(field));
        }
    }

    /**
     * 负对照：同一个 sink 只要真的收到一个部件，文档必须变（判据不得恒绿）。
     */
    @Test
    public void realPartBreaksTheEquality() {
        boolean original = PartExportIntegrator.isEnabled();
        try {
            PartExportIntegrator.setEnabledForProbe(true);

            JsonObject withPart = baselineDocument();
            PartExportIntegrator.StructureSink sink = PartExportIntegrator.newStructureSink(1, 1, 1);
            List<PartRecord> parts = new ArrayList<PartRecord>();
            parts.add(realPart());
            sink.addCell(
                0,
                0,
                0,
                PartCaptureResult.of(parts, PartSource.TIER_FAMILY, new ArrayList<String>(), new ArrayList<String>()),
                null,
                null,
                0);
            sink.writeInto(withPart);

            assertTrue("有部件时 sink 必须报告 hasParts", sink.hasParts());
            for (String field : SINK_OWNED_FIELDS) {
                assertTrue("有部件时必须产出 " + field, withPart.has(field));
                assertNotNull(withPart.get(field));
            }
            assertFalse(
                "负对照：有部件的文档绝不能与无部件的基线字节相同（否则核心判据是恒绿的）",
                canonical(baselineDocument()).equals(canonical(withPart)));

            // 网格下标必须指向 partLists[0]（无部件格恒为 -1）
            JsonArray grid = withPart.getAsJsonArray("cellPartsGrid");
            assertEquals(1, grid.size());
            assertEquals(
                0,
                grid.get(0)
                    .getAsJsonArray()
                    .get(0)
                    .getAsJsonArray()
                    .get(0)
                    .getAsInt());
            assertEquals(
                1,
                withPart.getAsJsonArray("partLists")
                    .size());
        } finally {
            PartExportIntegrator.setEnabledForProbe(original);
        }
    }
}
