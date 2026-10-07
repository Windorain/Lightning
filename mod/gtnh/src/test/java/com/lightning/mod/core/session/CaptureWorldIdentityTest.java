package com.lightning.mod.core.session;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.client.multiblock.ProbeDummyWorld;
import com.lightning.mod.core.sampling.DefaultBlockSampler;
import com.lightning.mod.core.scan.StructureScan;

/**
 * 「录制时所在世界」的身份与比对判据（Gitea #127 第 2 条）的<b>离线</b>单测。
 *
 * <h2>为什么必须离线锁死</h2>
 *
 * 本单的失败模式是<b>静默</b>的：改造前跨世界导出会得到「内容不同、{@code frameSha256} 一字不变」的产物，
 * 判据（C2/C3）与调用方都无从察觉。因此「记了什么身份」「怎么比」「比不过报什么」必须在纯 JVM 下逐行钉死，
 * 而不是靠实机跑一次「看起来是对的」。
 *
 * <p>
 * 覆盖三层：① 录制时刻真的把身份写进帧（用 {@link ProbeDummyWorld} 这个假世界走真实
 * {@link StructureScan#scanToStructureJson}）；② 序列化/解析往返与坏形态；③ 比对判据的每一行。
 */
public class CaptureWorldIdentityTest {

    // ------------------------------------------------------------ ① 录制时刻写入帧

    /**
     * 录制时刻就把身份写进 scan 根（本单第 2 条的<b>前提</b>）。
     *
     * <p>
     * 用真实实现（{@link StructureScan}）而不是自己拼 JSON：判据要落在「动作会写出这个字段」上，
     * 而不是落在测试自己的构造上。
     */
    @Test
    public void structureScanRecordsTheCaptureWorldIntoTheFrame() {
        ProbeDummyWorld world = new ProbeDummyWorld();
        JsonObject scan = StructureScan
            .scanToStructureJson(world, 64, 12, 64, 64, 12, 64, "unit.structure", new DefaultBlockSampler(), null);

        assertTrue("scan 根必须记下录制世界身份（缺了它，导出侧无从校验）", scan.has(CaptureWorldIdentity.FIELD));
        CaptureWorldIdentity id = CaptureWorldIdentity.parse(scan.get(CaptureWorldIdentity.FIELD));
        assertNotNull("captureWorld 形态必须是 {folder, dimension}", id);
        assertEquals("folder 取自世界自己的存档目录名", "LightningProbeDummy", id.folder);
        assertEquals("dimension 取自世界 provider", Integer.MAX_VALUE, id.dimension);
        assertTrue("该身份必须可用于校验", id.resolvable());
        // 与「从同一个世界对象再读一次」一致：写入侧没有另造一份规则
        assertEquals(CaptureWorldIdentity.ofWorld(world), id);
    }

    // ------------------------------------------------------------ ② 序列化 / 解析

    /** JSON 往返：{@code {folder, dimension}}；folder 为 null 时如实写 null（不编造）。 */
    @Test
    public void jsonRoundTripKeepsFolderAndDimension() {
        CaptureWorldIdentity id = CaptureWorldIdentity.of("cp_demo", 0);
        JsonObject o = id.toJson();
        assertEquals(
            "cp_demo",
            o.get("folder")
                .getAsString());
        assertEquals(
            0,
            o.get("dimension")
                .getAsInt());
        assertEquals(id, CaptureWorldIdentity.parse(o));
        assertTrue(
            o.get("folder")
                .isJsonPrimitive());

        CaptureWorldIdentity unknownFolder = CaptureWorldIdentity.of(null, 7);
        JsonObject u = unknownFolder.toJson();
        assertTrue(
            "拿不到目录名时如实写 null，不编造一个假目录",
            u.get("folder")
                .isJsonNull());
        assertFalse(
            "不可解析 ≠ 可用于校验",
            CaptureWorldIdentity.parse(u)
                .resolvable());
    }

    /** 形态坏掉一律返回 null（调用方据此显式失败，不猜「大概是同一个世界」）。 */
    @Test
    public void malformedIdentityIsRejectedNotGuessed() {
        assertNull(CaptureWorldIdentity.parse(null));
        assertNull(CaptureWorldIdentity.parse(new JsonPrimitive("cp_demo")));
        JsonObject noDim = new JsonObject();
        noDim.addProperty("folder", "cp_demo");
        assertNull("缺 dimension ⇒ 不可用", CaptureWorldIdentity.parse(noDim));
        JsonObject dimAsString = new JsonObject();
        dimAsString.addProperty("folder", "cp_demo");
        dimAsString.addProperty("dimension", "0");
        assertNull("dimension 是字符串 ⇒ 不可用（不做隐式转换）", CaptureWorldIdentity.parse(dimAsString));
        JsonObject folderAsNumber = new JsonObject();
        folderAsNumber.addProperty("folder", 3);
        folderAsNumber.addProperty("dimension", 0);
        assertNull(CaptureWorldIdentity.parse(folderAsNumber));
    }

    // ------------------------------------------------------------ ③ 比对判据（三态复现的核心）

    /** 一致 ⇒ 放行；同一目录不同维度 / 不同目录 ⇒ 报错并说清是哪一个字段不同。 */
    @Test
    public void mismatchReasonCoversTheThreeStateReproduction() {
        CaptureWorldIdentity a = CaptureWorldIdentity.of("cp_bake_A", 0);
        CaptureWorldIdentity sameWorld = CaptureWorldIdentity.of("cp_bake_A", 0);
        CaptureWorldIdentity otherWorld = CaptureWorldIdentity.of("cp_bake_B", 0);
        CaptureWorldIdentity otherDim = CaptureWorldIdentity.of("cp_bake_A", -1);

        assertNull("同一世界的同维度 ⇒ 可导出", CaptureWorldIdentity.mismatchReason(a, sameWorld));
        String otherFolder = CaptureWorldIdentity.mismatchReason(a, otherWorld);
        assertNotNull("#127 三态复现：换到另一个文件夹必须报错", otherFolder);
        assertTrue(
            "错误必须点名两个世界（expected/actual 的人读版）: " + otherFolder,
            otherFolder.contains("cp_bake_A") && otherFolder.contains("cp_bake_B"));
        assertNotNull("同目录换维度同样必须报错", CaptureWorldIdentity.mismatchReason(a, otherDim));

        // 「不知道」也必须是失败，不许放行：放行等于把判据变成盲区
        assertNotNull("帧没记身份 ⇒ 失败", CaptureWorldIdentity.mismatchReason(null, sameWorld));
        assertNotNull(
            "录制侧身份不可解析 ⇒ 失败",
            CaptureWorldIdentity.mismatchReason(CaptureWorldIdentity.of(null, 0), sameWorld));
        assertNotNull("导出侧读不到世界 ⇒ 失败", CaptureWorldIdentity.mismatchReason(a, null));
        assertNotNull(
            "导出侧身份不可解析（如拿到客户端占位目录名）⇒ 失败",
            CaptureWorldIdentity.mismatchReason(a, CaptureWorldIdentity.of(null, 0)));
    }

    /** equals/hashCode：身份是值对象（多帧一致性比对靠它）。 */
    @Test
    public void identityIsAValueObject() {
        assertEquals(CaptureWorldIdentity.of("cp_x", 3), CaptureWorldIdentity.of("cp_x", 3));
        assertFalse(
            CaptureWorldIdentity.of("cp_x", 3)
                .equals(CaptureWorldIdentity.of("cp_x", 4)));
        assertFalse(
            CaptureWorldIdentity.of("cp_x", 3)
                .equals(CaptureWorldIdentity.of("cp_y", 3)));
        assertEquals(
            CaptureWorldIdentity.of("cp_x", 3)
                .hashCode(),
            CaptureWorldIdentity.of("cp_x", 3)
                .hashCode());
    }

    /** 帧 JSON 里的身份是「可选的、可能缺失的」——解析只能按对象形态读，不认其它形态。 */
    @Test
    public void parseOnlyAcceptsTheDeclaredShape() {
        JsonObject frame = new JsonParser()
            .parse("{\"geometryPhase\":\"scan\",\"captureWorld\":{\"folder\":\"cp_z\",\"dimension\":-1}}")
            .getAsJsonObject();
        CaptureWorldIdentity id = CaptureWorldIdentity.parse(frame.get(CaptureWorldIdentity.FIELD));
        assertNotNull(id);
        assertEquals("cp_z", id.folder);
        assertEquals(-1, id.dimension);
        assertNull("帧里没有该字段 ⇒ null（调用方必须显式失败）", CaptureWorldIdentity.parse(frame.get("nope")));
    }
}
