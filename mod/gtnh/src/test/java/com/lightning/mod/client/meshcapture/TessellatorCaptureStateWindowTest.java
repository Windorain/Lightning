package com.lightning.mod.client.meshcapture;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.ArrayList;
import java.util.List;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedBlockInstance;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad;

/**
 * {@link TessellatorCaptureState} PR-1 录窗：计数 / zeroFlow / 嵌套拒绝 / 窗口 MV 基线 / 旧 API 兼容。
 * <p>
 * 本类只触达录窗层的纯 JVM 路径（不构造任何 MC 对象；beginBlock 的 Block 参数传 null）。
 * 静态全局 Frame 在类间共享，每个用例 try/finally 自清，@Before/@After 保证无窗口残留。
 */
public class TessellatorCaptureStateWindowTest {

    private static final int GL_QUADS = 7;

    @Before
    public void setUp() {
        TessellatorCaptureState.endWindow();
        TessellatorCaptureState.disarmWindowDrainSink();
        CaptureDiagnostics.resetForTesting(true);
    }

    @After
    public void tearDown() {
        TessellatorCaptureState.endWindow();
        TessellatorCaptureState.disarmWindowDrainSink();
        CaptureDiagnostics.resetForTesting(false);
    }

    /** 录 4 个顶点（GL_QUADS → 1 个四边形），世界坐标 (wx+local)，tessOffset 0。 */
    private static void recordOneQuad(double wx, double wy, double wz) {
        TessellatorCaptureState
            .onVertexRecorded(wx + 0.1, wy + 0.1, wz + 0.1, 0.0, 0.0, 0, 0xFFFFFFFF, 0, 0, 0, GL_QUADS);
        TessellatorCaptureState
            .onVertexRecorded(wx + 0.9, wy + 0.1, wz + 0.1, 1.0, 0.0, 0, 0xFFFFFFFF, 0, 0, 0, GL_QUADS);
        TessellatorCaptureState
            .onVertexRecorded(wx + 0.9, wy + 0.9, wz + 0.1, 1.0, 1.0, 0, 0xFFFFFFFF, 0, 0, 0, GL_QUADS);
        TessellatorCaptureState
            .onVertexRecorded(wx + 0.1, wy + 0.9, wz + 0.1, 0.0, 1.0, 0, 0xFFFFFFFF, 0, 0, 0, GL_QUADS);
    }

    @Test
    public void windowCountsQuadsAndTagsChannelAttrBin() {
        TessellatorCaptureState.beginWindow(CaptureChannel.BLOCK_COMPILE, 64, 0, 64, "chunk(4,4)");
        try {
            recordOneQuad(65.0, 1.0, 66.0);
            assertTrue(TessellatorCaptureState.isRecording());
        } finally {
            assertEquals(1, TessellatorCaptureState.endWindow());
        }
        assertFalse(TessellatorCaptureState.isRecording());

        com.google.gson.JsonObject diag = CaptureDiagnostics.toJson();
        com.google.gson.JsonObject ch = diag.getAsJsonObject("channels")
            .getAsJsonObject("BLOCK_COMPILE");
        assertEquals(
            1,
            ch.get("windows")
                .getAsInt());
        assertEquals(
            1,
            ch.get("quads")
                .getAsInt());
        assertEquals(
            0,
            ch.get("zeroFlowWindows")
                .getAsInt());
    }

    @Test
    public void zeroFlowDetectedWhenWindowClosesEmpty() {
        TessellatorCaptureState.beginWindow(CaptureChannel.TESR, 10, 64, -3, "TileEntityChest");
        int closed = TessellatorCaptureState.endWindow();
        assertEquals(0, closed);

        com.google.gson.JsonObject ch = CaptureDiagnostics.toJson()
            .getAsJsonObject("channels")
            .getAsJsonObject("TESR");
        assertEquals(
            1,
            ch.get("windows")
                .getAsInt());
        assertEquals(
            0,
            ch.get("quads")
                .getAsInt());
        assertEquals(
            1,
            ch.get("zeroFlowWindows")
                .getAsInt());
    }

    @Test
    public void nestedWindowIsRejectedWithExplicitException() {
        TessellatorCaptureState.beginWindow(CaptureChannel.BLOCK_COMPILE, 0, 0, 0, "first");
        try {
            TessellatorCaptureState.beginWindow(CaptureChannel.TESR, 1, 2, 3, "second");
            fail("嵌套开窗必须显式拒绝");
        } catch (IllegalStateException expected) {
            assertTrue(
                expected.getMessage()
                    .contains("嵌套"));
        } finally {
            // 第一个窗口状态未被破坏：仍能正常关闭
            assertEquals(0, TessellatorCaptureState.endWindow());
        }
    }

    @Test
    public void legacyChannelRejectedFromBeginWindow() {
        try {
            TessellatorCaptureState.beginWindow(CaptureChannel.LEGACY_PER_CELL, 0, 0, 0, "x");
            fail("LEGACY_PER_CELL 不允许走 beginWindow");
        } catch (IllegalArgumentException expected) {
            // 预期
        }
    }

    @Test
    public void endWindowWithoutWindowIsTolerated() {
        assertEquals(-1, TessellatorCaptureState.endWindow());
    }

    @Test
    public void drainVariantHandsOverQuads() {
        TessellatorCaptureState.beginWindow(CaptureChannel.BLOCK_COMPILE, 0, 0, 0, "drain");
        recordOneQuad(1.0, 1.0, 1.0);
        List<CapturedQuad> out = new ArrayList<>();
        assertEquals(1, TessellatorCaptureState.endWindowAndDrain(out));
        assertEquals(1, out.size());
        CapturedQuad q = out.get(0);
        assertEquals(CaptureChannel.BLOCK_COMPILE, q.channel);
        assertEquals(0, q.attribX);
        assertEquals(1, q.binX);
        assertEquals(1, q.binY);
        assertEquals(1, q.binZ);
        assertFalse(q.crossBin);
    }

    @Test
    public void crossBinFlagSetWhenQuadSpansBins() {
        TessellatorCaptureState.beginWindow(CaptureChannel.BLOCK_COMPILE, 0, 0, 0, "cross");
        // 四个顶点跨 x=4/5 两格（质心 x=4.5 → bin 4）
        TessellatorCaptureState.onVertexRecorded(3.9, 0.1, 0.1, 0, 0, 0, 0xFFFFFFFF, 0, 0, 0, GL_QUADS);
        TessellatorCaptureState.onVertexRecorded(5.1, 0.1, 0.1, 0, 0, 0, 0xFFFFFFFF, 0, 0, 0, GL_QUADS);
        TessellatorCaptureState.onVertexRecorded(5.1, 0.9, 0.1, 0, 0, 0, 0xFFFFFFFF, 0, 0, 0, GL_QUADS);
        TessellatorCaptureState.onVertexRecorded(3.9, 0.9, 0.1, 0, 0, 0, 0xFFFFFFFF, 0, 0, 0, GL_QUADS);
        List<CapturedQuad> out = new ArrayList<>();
        TessellatorCaptureState.endWindowAndDrain(out);
        assertEquals(1, out.size());
        assertTrue(out.get(0).crossBin);
        assertEquals(4, out.get(0).binX);
        assertEquals(
            1,
            CaptureDiagnostics.toJson()
                .get("crossBinQuads")
                .getAsInt());
    }

    @Test
    public void windowModelViewBaselineLifecycle() {
        float[] identity = new float[16];
        identity[0] = 1.0F;
        identity[5] = 1.0F;
        identity[10] = 1.0F;
        identity[15] = 1.0F;
        TessellatorCaptureState.beginWindow(CaptureChannel.TESR, 1, 2, 3, "mv");
        assertFalse(TessellatorCaptureState.isModelViewTransformArmed());
        TessellatorCaptureState.armWindowModelViewBaselineInverse(identity);
        assertTrue(TessellatorCaptureState.isModelViewTransformArmed());
        assertTrue(TessellatorCaptureState.hasActiveModelViewBaseline());
        float[] out = new float[16];
        TessellatorCaptureState.copyActiveModelViewBaselineInverse(out);
        assertEquals(1.0F, out[0], 0.0F);
        assertEquals(1.0F, out[15], 0.0F);
        TessellatorCaptureState.endWindow();
        assertFalse(TessellatorCaptureState.isModelViewTransformArmed());
    }

    @Test
    public void legacyBeginEndBlockUnchangedAndTaggedLegacy() {
        // 旧路径：beginBlock/endBlock 语义不变（顶点归一化到块局部 [0,1]³），内部记 LEGACY_PER_CELL 窗口
        TessellatorCaptureState.beginBlock(0, 0, 0, "label", 65, 1, 66, null, 0, 0, "minecraft:stone");
        assertTrue(TessellatorCaptureState.isLegacyPerCellCapture());
        recordOneQuad(65.0, 1.0, 66.0);
        assertEquals(1, TessellatorCaptureState.currentBlockRecordedQuadCount());
        CapturedBlockInstance target = new CapturedBlockInstance();
        TessellatorCaptureState.endBlock(target);
        assertFalse(TessellatorCaptureState.isRecording());
        assertEquals(1, target.quads.size());
        CapturedQuad q = target.quads.get(0);
        assertEquals(CaptureChannel.LEGACY_PER_CELL, q.channel);
        assertEquals(65, q.attribX);
        assertEquals(1, q.attribY);
        assertEquals(66, q.attribZ);
        assertEquals(65, q.binX);
        // 归一化契约仍在：顶点落在块局部 [0,1]
        assertEquals(0.1, q.vertices.get(0).x, 1e-6);
        assertEquals(0.9, q.vertices.get(1).x, 1e-6);

        com.google.gson.JsonObject ch = CaptureDiagnostics.toJson()
            .getAsJsonObject("channels")
            .getAsJsonObject("LEGACY_PER_CELL");
        assertEquals(
            1,
            ch.get("windows")
                .getAsInt());
        assertEquals(
            1,
            ch.get("quads")
                .getAsInt());
    }

    @Test
    public void legacyZeroFlowAlsoRecorded() {
        TessellatorCaptureState.beginBlock(0, 0, 0, "empty", 1, 2, 3, null, 0, 0, "minecraft:glass");
        TessellatorCaptureState.endBlock(new CapturedBlockInstance());
        com.google.gson.JsonObject ch = CaptureDiagnostics.toJson()
            .getAsJsonObject("channels")
            .getAsJsonObject("LEGACY_PER_CELL");
        assertEquals(
            1,
            ch.get("zeroFlowWindows")
                .getAsInt());
    }

    // ---------------------------------------------------------------- drain 汇（drain-dump 路由）

    /** 测试汇：记录每次回调的通道/归属键/四边形。 */
    private static final class RecordingSink implements TessellatorCaptureState.WindowDrainSink {

        private final List<String> calls = new ArrayList<>();
        private final List<CapturedQuad> lastQuads = new ArrayList<>();

        @Override
        public void onWindowDrained(CaptureChannel channel, int attrX, int attrY, int attrZ, String tag,
            List<CapturedQuad> quads) {
            calls.add(channel + "@" + attrX + "," + attrY + "," + attrZ + "#" + tag);
            lastQuads.clear();
            lastQuads.addAll(quads);
        }
    }

    @Test
    public void armWindowDrainSinkRoutesTesrWindowsThroughEndWindowAndDrain() {
        RecordingSink sink = new RecordingSink();
        TessellatorCaptureState.armWindowDrainSink(sink);
        assertTrue(TessellatorCaptureState.isWindowDrainArmed());
        TessellatorCaptureState.beginWindow(CaptureChannel.TESR, 65, 12, 64, "TileEntityLogisticsPipe");
        recordOneQuad(65.0, 12.0, 64.0);
        assertEquals(1, TessellatorCaptureState.endWindow());
        assertEquals(1, sink.calls.size());
        assertEquals("TESR@65,12,64#TileEntityLogisticsPipe", sink.calls.get(0));
        assertEquals(1, sink.lastQuads.size());
        assertEquals(CaptureChannel.TESR, sink.lastQuads.get(0).channel);
        assertEquals(65, sink.lastQuads.get(0).attribX);
        // 关窗语义不变：窗口计数与几何都已交出
        assertFalse(TessellatorCaptureState.isRecording());
        assertEquals(
            1,
            CaptureDiagnostics.toJson()
                .getAsJsonObject("channels")
                .getAsJsonObject("TESR")
                .get("quads")
                .getAsInt());
    }

    @Test
    public void armedSinkIgnoresBlockCompileAndLegacyWindows() {
        RecordingSink sink = new RecordingSink();
        TessellatorCaptureState.armWindowDrainSink(sink);
        TessellatorCaptureState.beginWindow(CaptureChannel.BLOCK_COMPILE, 64, 0, 64, "chunk(4,4)");
        recordOneQuad(65.0, 1.0, 66.0);
        assertEquals(1, TessellatorCaptureState.endWindow());
        TessellatorCaptureState.beginBlock(0, 0, 0, "legacy", 65, 1, 66, null, 0, 0, "minecraft:stone");
        recordOneQuad(65.0, 1.0, 66.0);
        TessellatorCaptureState.endBlock(new CapturedBlockInstance());
        assertEquals(0, sink.calls.size());
    }

    @Test
    public void zeroFlowTesrWindowStillReportsEmptyQuadList() {
        RecordingSink sink = new RecordingSink();
        TessellatorCaptureState.armWindowDrainSink(sink);
        TessellatorCaptureState.beginWindow(CaptureChannel.TESR, 10, 64, -3, "TileEntityChest");
        assertEquals(0, TessellatorCaptureState.endWindow());
        assertEquals(1, sink.calls.size());
        assertEquals(0, sink.lastQuads.size());
    }

    @Test
    public void disarmedSinkLeavesEndWindowSemanticsUntouched() {
        RecordingSink sink = new RecordingSink();
        TessellatorCaptureState.armWindowDrainSink(sink);
        TessellatorCaptureState.disarmWindowDrainSink();
        assertFalse(TessellatorCaptureState.isWindowDrainArmed());
        TessellatorCaptureState.beginWindow(CaptureChannel.TESR, 1, 2, 3, "mv");
        recordOneQuad(1.0, 2.0, 3.0);
        assertEquals(1, TessellatorCaptureState.endWindow());
        assertEquals(0, sink.calls.size());
    }
}
