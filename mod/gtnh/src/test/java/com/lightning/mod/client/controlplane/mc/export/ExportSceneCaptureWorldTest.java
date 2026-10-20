package com.lightning.mod.client.controlplane.mc.export;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.LinkedHashMap;
import java.util.Map;

import org.junit.Test;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.lightning.mod.core.session.CaptureWorldIdentity;
import com.lightning.mod.core.session.ExportSceneWriter;

/**
 * {@code export.scene} 的<b>录制世界身份校验</b>（Gitea #127 第 2 条）的离线那一半。
 *
 * <h2>为什么判定点抽成纯函数</h2>
 *
 * 动作本体需要客户端世界（真机才能跑），但「这几帧是不是同一个世界录的」「身份字段在不在」
 * 「provenance 写不写这个字段」全是纯逻辑：把它们放进 {@link ExportSceneSupport} 的静态方法后，
 * 判据可以在纯 JVM 下逐行锁死——而这正是实机最难观察的那一半（跨世界导出改造前是<b>静默成功</b>的）。
 */
public class ExportSceneCaptureWorldTest {

    private static String frameJson(String folder, int dim) {
        return "{\"geometryPhase\":\"scan\",\"copy\":{\"x\":1}," + "\"captureWorld\":{\"folder\":"
            + (folder == null ? "null" : "\"" + folder + "\"")
            + ",\"dimension\":"
            + dim
            + "}}";
    }

    private static Map<Integer, String> frames(String... bodies) {
        Map<Integer, String> m = new LinkedHashMap<Integer, String>();
        for (int i = 0; i < bodies.length; i++) {
            m.put(Integer.valueOf(i), bodies[i]);
        }
        return m;
    }

    // ------------------------------------------------------------ 多帧一致性 / 缺失

    /** 全部选中帧同一世界 ⇒ 一致，且身份可解析。 */
    @Test
    public void allFramesFromTheSameWorldPass() {
        ExportSceneSupport.CaptureWorldCheck check = ExportSceneSupport
            .captureWorldOf(frames(frameJson("cp_bake_A", 0), frameJson("cp_bake_A", 0)));
        assertNull("同一世界的多帧必须通过（否则判据会误伤正常用法）: " + check.problem, check.problem);
        assertNotNull(check.identity);
        assertEquals("cp_bake_A", check.identity.folder);
        assertEquals(0, check.identity.dimension);
        assertNotNull(check.toJson());
    }

    /** 选中帧来自不同世界 ⇒ 必须判红（跨世界拼帧不许进产物）。 */
    @Test
    public void framesFromDifferentWorldsAreRejected() {
        ExportSceneSupport.CaptureWorldCheck check = ExportSceneSupport
            .captureWorldOf(frames(frameJson("cp_bake_A", 0), frameJson("cp_bake_B", 0)));
        assertNotNull(check.problem);
        assertTrue(
            "原因必须点名两个世界: " + check.problem,
            check.problem.contains("cp_bake_A") && check.problem.contains("cp_bake_B"));
        assertEquals("出问题的帧号必须给出（定位用）", 1, check.problemFrame);
        assertNull("判红时不得给出一个可用的身份", check.toJson());
    }

    /** 缺少身份（本契约之前的缓冲 / 手工构造的帧）⇒ 判红，不猜。 */
    @Test
    public void frameWithoutIdentityIsRejected() {
        ExportSceneSupport.CaptureWorldCheck check = ExportSceneSupport
            .captureWorldOf(frames("{\"geometryPhase\":\"scan\"}"));
        assertNotNull("没有身份就不能保证产物忠实 ⇒ 必须显式失败", check.problem);
        assertEquals(0, check.problemFrame);
        assertTrue("原因必须点明缺的是哪个字段: " + check.problem, check.problem.contains(CaptureWorldIdentity.FIELD));
    }

    /** 形态坏掉的身份（不是对象 / folder 非字符串）同样判红。 */
    @Test
    public void malformedIdentityIsRejected() {
        assertNotNull(ExportSceneSupport.captureWorldOf(frames("{\"captureWorld\":\"cp_x\"}")).problem);
        assertNotNull(
            ExportSceneSupport.captureWorldOf(frames("{\"captureWorld\":{\"folder\":3,\"dimension\":0}}")).problem);
        assertNotNull(ExportSceneSupport.captureWorldOf(frames("{\"captureWorld\":{\"folder\":\"cp_x\"}}")).problem);
    }

    /** 逐帧取值（provenance 的逐帧副本用）：单帧 JSON 里读出来的就是那一帧的身份。 */
    @Test
    public void frameCaptureWorldReadsPerFrameIdentity() {
        CaptureWorldIdentity id = ExportSceneSupport.frameCaptureWorld(frameJson("cp_z", -1));
        assertNotNull(id);
        assertEquals("cp_z", id.folder);
        assertEquals(-1, id.dimension);
        assertNull("非 JSON 文本 ⇒ null（不抛）", ExportSceneSupport.frameCaptureWorld("not json"));
        assertNull(ExportSceneSupport.frameCaptureWorld(null));
        assertNull(ExportSceneSupport.frameCaptureWorld("[1,2,3]"));
    }

    // ------------------------------------------------------------ provenance 的可读性

    /** provenance 带 captureWorld ⇒ 产物内可读；不传 ⇒ 与既有产物逐字节一致（命令通道的前提）。 */
    @Test
    public void provenanceCarriesCaptureWorldOnlyWhenGiven() {
        JsonObject withWorld = ExportSceneWriter.provenance(
            "run#demo",
            "run",
            ExportSceneWriter.Shape.WORLD,
            3L,
            new int[] { 0 },
            new String[] { "abc" },
            true,
            null,
            CaptureWorldIdentity.of("cp_demo", 0)
                .toJson());
        assertTrue("provenance 必须记下录制世界身份", withWorld.has(CaptureWorldIdentity.FIELD));
        JsonObject cw = withWorld.getAsJsonObject(CaptureWorldIdentity.FIELD);
        assertEquals(
            "cp_demo",
            cw.get("folder")
                .getAsString());
        assertEquals(
            0,
            cw.get("dimension")
                .getAsInt());

        JsonObject withoutWorld = ExportSceneWriter.provenance(
            "run#demo",
            "run",
            ExportSceneWriter.Shape.WORLD,
            3L,
            new int[] { 0 },
            new String[] { "abc" },
            true,
            null);
        assertEquals(
            "旧 8 参重载（命令通道）不得凭空多出字段",
            withoutWorld.toString()
                .contains(CaptureWorldIdentity.FIELD),
            false);
    }

    /** 机读形状锁定：{@code provenance.captureWorld} 的键名与取值口径（消费方按此解析）。 */
    @Test
    public void captureWorldJsonShapeIsStable() {
        JsonObject o = new JsonParser().parse(
            CaptureWorldIdentity.of("cp_demo", 0)
                .toJson()
                .toString())
            .getAsJsonObject();
        assertEquals(
            2,
            o.entrySet()
                .size());
        assertTrue(o.has(CaptureWorldIdentity.FIELD_FOLDER));
        assertTrue(o.has(CaptureWorldIdentity.FIELD_DIMENSION));
        assertFalse(
            "维度必须是数值（字符串会被消费方当坏形态）",
            o.get(CaptureWorldIdentity.FIELD_DIMENSION)
                .getAsString()
                .isEmpty());
    }
}
