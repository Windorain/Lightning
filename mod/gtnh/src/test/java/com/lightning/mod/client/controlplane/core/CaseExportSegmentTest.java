package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * {@code export} 段的解析/校验（v1.6）：「导出件与实拍/观测同 run」的框架面。
 *
 * <h2>为什么这一段必须是框架的一部分</h2>
 *
 * 导出件、实拍、观测记录、世界清单哈希<b>同一 run</b>，且该 run 内世界清单哈希唯一。
 * 若导出只能在用例之外单独调 {@code export.scene}，它必然落在<b>另一个</b> run 里 ——
 * 那么「同一 run 内世界清单哈希唯一」这条判据对导出件就永远不成立。
 * 因此导出必须是用例的一段。
 *
 * <p>
 * 本测试锁三件事：
 *
 * <ol>
 * <li><b>段位</b>：{@code export} 在 {@code read} 之后、{@code cameras} 之前（先读世界、再固化产物、
 * 最后拍摄 —— 拍摄会覆写投影/光照，不该影响导出件反映的世界状态）；</li>
 * <li><b>前缀限制</b>：段里只接受 {@code export.*} 动作（与 {@code read} 段限 {@code read.*} 同一思路：
 * 段语义靠前缀静态可查）；</li>
 * <li><b>不声明落点</b>：导出产物的相对路径由动作自己决定，段里<b>不</b>接受 {@code path}/{@code role}
 * ——声明落点会与动作实现产生第二处真相（实测过的形态：声明一个落点而动作写到别处）。</li>
 * </ol>
 */
public class CaseExportSegmentTest {

    private static JsonObject baseCase() {
        JsonObject c = new JsonObject();
        c.addProperty("schema", Contract.SCHEMA_CASE);
        c.addProperty("id", "export-segment");
        JsonObject world = new JsonObject();
        world.addProperty("folder", "cp_export_segment");
        world.addProperty("seed", 11L);
        world.addProperty("void", true);
        JsonArray base = new JsonArray();
        base.add(64);
        base.add(12);
        base.add(64);
        world.add("base", base);
        c.add("world", world);
        JsonObject crit = new JsonObject();
        crit.addProperty("id", "c1");
        crit.addProperty("type", "artifact-exists");
        JsonObject cp = new JsonObject();
        cp.addProperty("path", "manifest.json");
        crit.add("params", cp);
        JsonArray criteria = new JsonArray();
        criteria.add(crit);
        c.add("criteria", criteria);
        // evidence 是必填段（case-file.md §7）；缺它会在解析期先报错，掩盖本测试真正要断言的东西
        JsonObject evidence = new JsonObject();
        JsonArray expect = new JsonArray();
        JsonObject e0 = new JsonObject();
        e0.addProperty("path", "manifest.json");
        expect.add(e0);
        evidence.add("expect", expect);
        c.add("evidence", evidence);
        return c;
    }

    private static JsonObject step(String action) {
        JsonObject s = new JsonObject();
        s.addProperty("action", action);
        JsonObject p = new JsonObject();
        p.addProperty("confirm", true);
        s.add("params", p);
        return s;
    }

    private static JsonObject plan(JsonObject c) {
        return new CaseValidator().plan(new CaseParser().parse(c, null));
    }

    /** 段位：export 在 read 之后、cameras 之前。 */
    @Test
    public void exportSegmentSitsBetweenReadAndCameras() {
        JsonObject plan = plan(baseCase());
        JsonArray segs = plan.getAsJsonArray("segments");
        int read = indexOf(segs, "read");
        int export = indexOf(segs, "export");
        int cameras = indexOf(segs, "cameras");
        assertTrue("三段都必须在", read >= 0 && export >= 0 && cameras >= 0);
        assertTrue("export 必须在 read 之后（读世界 → 固化产物）", export > read);
        assertTrue("export 必须在 cameras 之前（拍摄会覆写投影/光照，不该影响导出件）", export < cameras);
        assertTrue("export 段必须进规范化计划", plan.has("export"));
    }

    /** 合法声明：export.scene 被接受并进规范化计划。 */
    @Test
    public void exportSceneStepIsAccepted() {
        JsonObject c = baseCase();
        JsonArray arr = new JsonArray();
        arr.add(step("export.scene"));
        c.add("export", arr);
        JsonObject plan = plan(c);
        JsonArray out = plan.getAsJsonArray("export");
        assertNotNull(out);
        assertEquals(1, out.size());
        assertEquals(
            "export.scene",
            out.get(0)
                .getAsJsonObject()
                .get("action")
                .getAsString());
        assertEquals(
            "step 必须带 index（段记录与判据引用要对得上）",
            0,
            out.get(0)
                .getAsJsonObject()
                .get("index")
                .getAsInt());
    }

    /** 前缀限制：非 export.* 动作被拒（读面动作不能塞进导出段）。 */
    @Test
    public void nonExportActionInExportSegmentIsRejected() {
        JsonObject c = baseCase();
        JsonArray arr = new JsonArray();
        arr.add(step("read.blocks"));
        c.add("export", arr);
        try {
            plan(c);
            org.junit.Assert.fail("export 段里的 read.blocks 必须被判 CP-VALID-002");
        } catch (CpException e) {
            assertEquals(ErrorCodes.VALID_PARAM, e.code());
            assertTrue(
                "错误必须指向 export[0].action 并说明前缀限制",
                e.getMessage()
                    .contains("export[0].action"));
            assertTrue(
                e.getMessage(),
                e.getMessage()
                    .contains("export."));
        }
    }

    /** 不声明落点：path/role 是未知字段（严格模式报错）。 */
    @Test
    public void exportStepRejectsDeclaredPath() {
        JsonObject c = baseCase();
        JsonArray arr = new JsonArray();
        JsonObject s = step("export.scene");
        s.addProperty("path", "export/mine.json");
        arr.add(s);
        c.add("export", arr);
        try {
            plan(c);
            org.junit.Assert.fail("export 段里声明 path 必须被判 CP-VALID-002（落点由动作决定）");
        } catch (CpException e) {
            assertEquals(ErrorCodes.VALID_PARAM, e.code());
            assertTrue(
                "错误必须指向 export[0].path",
                e.getMessage()
                    .contains("export[0].path"));
        }
    }

    /** 形态非法：export 不是数组时报错并指向该字段。 */
    @Test
    public void exportSegmentMustBeArray() {
        JsonObject c = baseCase();
        c.addProperty("export", "not-an-array");
        try {
            plan(c);
            org.junit.Assert.fail("export 非数组必须被判 CP-VALID-002");
        } catch (CpException e) {
            assertEquals(ErrorCodes.VALID_PARAM, e.code());
            assertTrue(
                e.getMessage(),
                e.getMessage()
                    .contains("export"));
        }
    }

    /** 空 export 段：警告（不是错误）——不是每个用例都要产导出件。 */
    @Test
    public void emptyExportSegmentYieldsWarningNotError() {
        JsonObject plan = plan(baseCase());
        JsonArray warns = plan.getAsJsonArray("warnings");
        boolean mentioned = false;
        for (int i = 0; i < warns.size(); i++) {
            String w = warns.get(i)
                .getAsString();
            if (w.contains("export 段为空")) {
                mentioned = true;
                assertTrue("警告必须写明 C4 的后果", w.contains("C4"));
            }
        }
        assertTrue("空 export 段必须有警告（否则 C4 的缺口无人提醒）: " + warns, mentioned);
    }

    /** 段模型自述：{@code case.validate} 的 plan.segments 必须含 export（D1 自描述无缺项）。 */
    @Test
    public void segmentsSelfDescriptionIncludesExport() {
        assertTrue("CaseValidator.SEGMENTS 必须含 export", CaseValidator.SEGMENTS.contains("export"));
        assertFalse(
            "export 不得排在 capture 之前（capture 包住 build 之后的区间）",
            CaseValidator.SEGMENTS.indexOf("export") < CaseValidator.SEGMENTS.indexOf("capture"));
    }

    private static int indexOf(JsonArray segs, String name) {
        for (int i = 0; i < segs.size(); i++) {
            if (name.equals(
                segs.get(i)
                    .getAsString())) {
                return i;
            }
        }
        return -1;
    }
}
