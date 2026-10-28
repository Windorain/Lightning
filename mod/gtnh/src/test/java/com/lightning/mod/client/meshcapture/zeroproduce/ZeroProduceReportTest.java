package com.lightning.mod.client.meshcapture.zeroproduce;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.lightning.mod.client.meshcapture.env.CaptureEnvironment;
import com.lightning.mod.client.meshcapture.zeroproduce.ZeroProducePolicy.Decision;
import com.lightning.mod.client.meshcapture.zeroproduce.ZeroProduceReport.Mode;

/**
 * {@link ZeroProduceReport}：会话级记账与 {@code captureStats} 口径。
 * <p>
 * 关键不变式：<strong>每一格 0 产出都必须进三条路之一</strong>（占位 / 合法空 / 兜底占位），
 * 于是 {@code lostCells} 由构造为 0。这条不变式与开关模式无关——测量模式（只记日志不落占位）下
 * 占位格没有几何，但它仍计入 {@code placeholderCells}。
 */
public class ZeroProduceReportTest {

    @Before
    public void setUp() {
        ZeroProduceReport.resetForTesting();
    }

    @After
    public void tearDown() {
        ZeroProduceReport.resetForTesting();
    }

    @Test
    public void statsAccountForEveryZeroProduceCell() {
        ZeroProduceReport.record(ctx(1, 2, 3), Decision.placeholder("no_observable_geometry"), true);
        ZeroProduceReport.record(ctx(4, 5, 6), Decision.declaredEmpty("declared_empty_x"), false);

        Map<String, Integer> channels = new LinkedHashMap<String, Integer>();
        channels.put("BLOCK", Integer.valueOf(2));
        channels.put("TESR", Integer.valueOf(1));
        JsonObject stats = ZeroProduceReport.toCaptureStats(4, 2, channels);

        assertEquals(
            4,
            stats.get("cellsWithBlock")
                .getAsInt());
        assertEquals(
            2,
            stats.get("bakedCells")
                .getAsInt());
        assertEquals(
            1,
            stats.get("placeholderCells")
                .getAsInt());
        assertEquals(
            1,
            stats.get("declaredEmptyCells")
                .getAsInt());
        assertEquals(
            "有方块 = 已烘焙 + 占位 + 合法空（丢失必须是 0）",
            0,
            stats.get("lostCells")
                .getAsInt());
        assertEquals(
            2,
            stats.getAsJsonObject("channels")
                .get("BLOCK")
                .getAsInt());
        assertEquals(
            1,
            stats.getAsJsonObject("channels")
                .get("TESR")
                .getAsInt());
    }

    @Test
    public void placeholderCountedEvenWhenGeometryIsNotPlaced() {
        // 测量模式：裁决为占位但不落几何（产物里这一格仍是空的），计数照写
        ZeroProduceReport.record(ctx(0, 0, 0), Decision.placeholder("zero_produce"), false);
        JsonObject stats = ZeroProduceReport.toCaptureStats(1, 0, Collections.<String, Integer>emptyMap());
        assertEquals(
            1,
            stats.get("placeholderCells")
                .getAsInt());
        assertEquals(
            0,
            stats.get("bakedCells")
                .getAsInt());
        assertEquals(
            0,
            stats.get("lostCells")
                .getAsInt());
    }

    @Test
    public void unaccountedCellsSurfaceAsLostInsteadOfBeingClamped() {
        JsonObject stats = ZeroProduceReport.toCaptureStats(3, 1, Collections.<String, Integer>emptyMap());
        assertEquals(
            "记账有漏必须如实写出来，不能夹紧成 0 假装没事",
            2,
            stats.get("lostCells")
                .getAsInt());
    }

    @Test
    public void warningsFoldPerReason() {
        for (int i = 0; i < ZeroProduceReport.MAX_WARN_PER_REASON + 5; i++) {
            ZeroProduceReport.record(ctx(i, 0, 0), Decision.placeholder("zero_produce"), false);
        }
        assertEquals(ZeroProduceReport.MAX_WARN_PER_REASON + 5, ZeroProduceReport.placeholderCells());
        assertEquals("超出上限的只计数、折叠记录", 5, ZeroProduceReport.foldedWarnings());
    }

    @Test
    public void modeParsingDefaultsToPlaceholderAndRejectsUnknownValues() {
        assertEquals(Mode.PLACEHOLDER, Mode.parse(null));
        assertEquals(Mode.PLACEHOLDER, Mode.parse("   "));
        assertEquals(Mode.LOG, Mode.parse(" log "));
        assertEquals(Mode.PLACEHOLDER, Mode.parse("PLACEHOLDER"));
        assertEquals(Mode.OFF, Mode.parse("off"));
        assertEquals("未知取值按默认（落占位）处理，不得静默回到旧行为", Mode.PLACEHOLDER, Mode.parse("bogus"));
        assertTrue(Mode.PLACEHOLDER.evaluatesPolicies());
        assertTrue(Mode.PLACEHOLDER.placesGeometry());
        assertTrue(Mode.LOG.evaluatesPolicies());
        assertFalse(Mode.LOG.placesGeometry());
        assertFalse(Mode.OFF.evaluatesPolicies());
    }

    @Test
    public void statsRoundTripThroughGson() {
        ZeroProduceReport.record(ctx(7, 8, 9), Decision.placeholder("zero_produce"), false);
        JsonObject stats = ZeroProduceReport.toCaptureStats(2, 1, Collections.<String, Integer>emptyMap());
        JsonObject parsed = new JsonParser().parse(stats.toString())
            .getAsJsonObject();
        assertEquals(
            "lightning 捕获统计的字段名是产物契约的一部分",
            1,
            parsed.get("placeholderCells")
                .getAsInt());
    }

    private static ZeroProduceContext ctx(int wx, int wy, int wz) {
        return new ZeroProduceContext(
            0,
            0,
            0,
            wx,
            wy,
            wz,
            null,
            0,
            "minecraft:chest",
            0,
            null,
            0,
            Collections.<String, Integer>emptyMap(),
            false,
            false,
            CaptureEnvironment.allUnknown("test"));
    }
}
