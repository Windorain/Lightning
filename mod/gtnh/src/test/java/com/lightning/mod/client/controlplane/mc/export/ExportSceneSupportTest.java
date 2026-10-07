package com.lightning.mod.client.controlplane.mc.export;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.Map;
import java.util.TreeMap;

import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;

/**
 * 导出族的参数/预算/帧集校验（Gitea #102 的 C3 与 C6）。
 *
 * <p>
 * 这两条验收判据的判定点在 {@link ExportSceneSupport} 的纯函数里（不依赖 MC），因此可以在纯 JVM
 * 下钉死——这正是「把判定从动作实现里抽出来」的理由：{@code export.scene} 的 {@code advance} 需要
 * 客户端世界，但「预算怎么算、超限报什么码、expectFrames 怎么比」不需要。
 */
public class ExportSceneSupportTest {

    // ------------------------------------------------------------ 文件名净化

    /** 净化而不是报错：中文/空格展示名也能导出，但结果与产物路径如实反映净化后的值。 */
    @Test
    public void safeNameSanitizesInsteadOfFailing() {
        assertEquals("demo", ExportSceneSupport.safeName("demo"));
        assertEquals("my-export", ExportSceneSupport.safeName("my export"));
        assertEquals("--", ExportSceneSupport.safeName("中文"));
        assertEquals("export", ExportSceneSupport.safeName(null));
        assertEquals("export", ExportSceneSupport.safeName("   "));
        assertEquals("a-b", ExportSceneSupport.safeName("a/b"));
        assertFalse(
            "不得保留路径分隔符",
            ExportSceneSupport.safeName("a/b\\c")
                .contains("/"));
        assertFalse(
            "不得保留 ..",
            ExportSceneSupport.safeName("../etc/passwd")
                .contains(".."));
        assertTrue(
            "长度必须受限",
            ExportSceneSupport.safeName(repeat('a', 500))
                .length() <= ExportSceneSupport.MAX_NAME_LENGTH);
    }

    private static String repeat(char c, int n) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < n; i++) {
            sb.append(c);
        }
        return sb.toString();
    }

    // ------------------------------------------------------------ 预算 context（C6）

    /** 帧数超限的 context 必须给出「超了多少」与「怎么算出来的」（可复算）。 */
    @Test
    public void budgetContextExplainsHowTheNumberWasComputed() {
        JsonObject c = ExportSceneSupport.budgetContext("frames", 100, 64, 8L, 800L, 2_000_000L);
        assertEquals(
            "frames",
            c.get("action")
                .getAsString());
        assertEquals(
            100,
            c.get("frames")
                .getAsInt());
        assertEquals(
            64,
            c.get("maxFrames")
                .getAsInt());
        assertEquals(
            8L,
            c.get("volumePerFrame")
                .getAsLong());
        assertEquals(
            800L,
            c.get("volumeTotal")
                .getAsLong());
        assertNotNull(
            "必须写清算式（可复算）",
            c.get("computed")
                .getAsString());
        JsonArray fields = c.getAsJsonArray("fields");
        assertTrue("必须逐字段说明", fields.size() >= 1);
        boolean mentionsFrames = false;
        for (int i = 0; i < fields.size(); i++) {
            if ("frames".equals(
                fields.get(i)
                    .getAsJsonObject()
                    .get("field")
                    .getAsString())) {
                mentionsFrames = true;
                assertTrue(
                    "必须写明不静默截断",
                    fields.get(i)
                        .getAsJsonObject()
                        .get("reason")
                        .getAsString()
                        .contains("不静默截断"));
            }
        }
        assertTrue(mentionsFrames);
    }

    /** 体素超限（单帧与总量两种）都要有对应字段说明。 */
    @Test
    public void budgetContextCoversBothPerFrameAndTotalCellOverflow() {
        JsonObject perFrame = ExportSceneSupport.budgetContext("maxCells", 1, 64, 5_000_000L, 5_000_000L, 2_000_000L);
        JsonArray f1 = perFrame.getAsJsonArray("fields");
        assertTrue("单帧超限必须被指出", containsField(f1, "maxCells"));

        JsonObject total = ExportSceneSupport.budgetContext("maxCells", 8, 64, 1_000_000L, 8_000_000L, 2_000_000L);
        JsonArray f2 = total.getAsJsonArray("fields");
        assertTrue("总量超限必须被指出", containsField(f2, "maxCells"));
        assertEquals(
            8_000_000L,
            total.get("volumeTotal")
                .getAsLong());
    }

    private static boolean containsField(JsonArray fields, String name) {
        for (int i = 0; i < fields.size(); i++) {
            if (name.equals(
                fields.get(i)
                    .getAsJsonObject()
                    .get("field")
                    .getAsString())) {
                return true;
            }
        }
        return false;
    }

    // ------------------------------------------------------------ expectFrames（C3）

    /** expectFrames 相符时静默通过（不抛）。 */
    @Test
    public void expectFramesPassesWhenFrameSetsMatch() {
        Map<Integer, String> selected = new TreeMap<Integer, String>();
        selected.put(Integer.valueOf(0), "{}");
        selected.put(Integer.valueOf(1), "{}");
        selected.put(Integer.valueOf(2), "{}");
        ExportSceneSupport.assertExpectFrames(parse("{\"frames\":[0,1,2]}"), selected);
        // 顺序无关（集合语义）
        ExportSceneSupport.assertExpectFrames(parse("{\"frames\":[2,0,1]}"), selected);
    }

    /**
     * expectFrames 不符时判红（C3 的核心判据）：这是「跨会话拼接」被拦下的地方。
     *
     * <p>
     * 场景：动作 A 录了 F0..F2，动作 B 又录了 F9；B 导出时缓冲里是 F0..F2+F9。若调用方声明
     * {@code [0,1,2]}，这次导出必须<b>当场判红</b>，而不是静默产出一份拼接物。
     */
    @Test
    public void expectFramesCatchesCrossSessionAppend() {
        Map<Integer, String> selected = new TreeMap<Integer, String>();
        selected.put(Integer.valueOf(0), "{}");
        selected.put(Integer.valueOf(1), "{}");
        selected.put(Integer.valueOf(2), "{}");
        selected.put(Integer.valueOf(9), "{}"); // B 动作追加的那一帧
        try {
            ExportSceneSupport.assertExpectFrames(parse("{\"frames\":[0,1,2]}"), selected);
            fail("帧集与 expectFrames 不符时必须抛 CP-STATE-001");
        } catch (CpException e) {
            assertEquals("C3 判红必须用前置状态码", ErrorCodes.STATE, e.code());
            JsonObject ctx = e.context();
            assertNotNull(ctx);
            assertEquals(
                "必须给出 extra（多出来的帧）",
                9,
                ctx.getAsJsonArray("extra")
                    .get(0)
                    .getAsInt());
            assertEquals(
                "必须给出 actual",
                4,
                ctx.getAsJsonArray("actual")
                    .size());
            assertNotNull(
                "必须给出可行出路",
                ctx.get("hint")
                    .getAsString());
        }
    }

    /** 缺帧（声明的帧不在缓冲里）也要判红，并指出缺了哪一帧。 */
    @Test
    public void expectFramesCatchesMissingFrame() {
        Map<Integer, String> selected = new TreeMap<Integer, String>();
        selected.put(Integer.valueOf(0), "{}");
        try {
            ExportSceneSupport.assertExpectFrames(parse("{\"frames\":[0,1]}"), selected);
            fail("缺帧时必须抛 CP-STATE-001");
        } catch (CpException e) {
            assertEquals(ErrorCodes.STATE, e.code());
            assertEquals(
                1,
                e.context()
                    .getAsJsonArray("missing")
                    .get(0)
                    .getAsInt());
        }
    }

    /** 形态非法（非对象/非数组）报 CP-VALID-002，不静默忽略。 */
    @Test
    public void expectFramesRejectsMalformedShape() {
        Map<Integer, String> selected = new TreeMap<Integer, String>();
        selected.put(Integer.valueOf(0), "{}");
        try {
            ExportSceneSupport.assertExpectFrames(parse("{\"frames\":\"all\"}"), selected);
            fail("形态非法必须抛 CP-VALID-002");
        } catch (CpException e) {
            assertEquals(ErrorCodes.VALID_PARAM, e.code());
        }
        try {
            ExportSceneSupport.assertExpectFrames(parse("{\"frames\":[\"x\"]}"), selected);
            fail("元素类型非法必须抛 CP-VALID-002");
        } catch (CpException e) {
            assertEquals(ErrorCodes.VALID_PARAM, e.code());
        }
    }

    /** 未给 expectFrames（空对象）时不校验——它是可选判据，不是必填。 */
    @Test
    public void expectFramesIsOptional() {
        Map<Integer, String> selected = new TreeMap<Integer, String>();
        selected.put(Integer.valueOf(5), "{}");
        ExportSceneSupport.assertExpectFrames(null, selected);
        ExportSceneSupport.assertExpectFrames(new JsonObject(), selected);
    }

    // ------------------------------------------------------------ 序列化口径

    /** 帧号数组与哈希对象：只保留选中帧，且与 export.session 同源。 */
    @Test
    public void hashArrayOnlyCoversSelectedFrames() {
        Map<Integer, String> selected = new TreeMap<Integer, String>();
        selected.put(Integer.valueOf(1), "{}");
        JsonObject o = ExportSceneSupport.hashArray(null, selected);
        assertEquals(
            "快照为 null 时给空对象（不抛）",
            0,
            o.entrySet()
                .size());
        assertEquals(
            0,
            ExportSceneSupport.frameList((Map<Integer, String>) null)
                .size());
    }

    /** 选区序列化：不完整时只给 complete:false（不假造 0 坐标——「没设过」与「设在原点」必须可区分）。 */
    @Test
    public void selectionJsonKeepsNullWhenIncomplete() {
        JsonObject sel = ExportSceneSupport.selectionJson(null);
        assertFalse(
            sel.get("complete")
                .getAsBoolean());
        assertEquals(
            1,
            sel.entrySet()
                .size());
    }

    private static JsonObject parse(String text) {
        return new JsonParser().parse(text)
            .getAsJsonObject();
    }
}
