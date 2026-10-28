package com.lightning.mod.client.controlplane.mc.read;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.ArrayList;
import java.util.List;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionDescriptor;
import com.lightning.mod.client.controlplane.core.ActionRegistry;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.Tier;
import com.lightning.mod.client.controlplane.core.TimeSource;
import com.lightning.mod.client.controlplane.mc.ActionRegistrar;
import com.lightning.mod.client.controlplane.mc.capture.CaptureDiagAction;
import com.lightning.mod.client.controlplane.mc.capture.CaptureDiagSession;
import com.lightning.mod.client.meshcapture.CaptureChannel;
import com.lightning.mod.client.meshcapture.CaptureDiagnostics;

/**
 * {@code read.capture} / {@code capture.diag}（职责迁移）的<b>离线</b>单测。
 *
 * <h2>为什么这些必须离线锁死</h2>
 * 本改动的失败模式几乎全是<b>静默</b>的，实机看不出：
 * <ul>
 * <li><b>「没采」被读成「采到零流入」</b>（负对照的核心）：判错了读数依然是一份合法 JSON，
 * 只是含义相反——而下游判据会据此判绿；</li>
 * <li><b>撤防顺手清计数</b>：读数从「有证据」变成「全 0」，而调用方以为撤防只是关开关；</li>
 * <li><b>通道过滤静默失效</b>：笔误的通道名若回全通道，看起来像「这个通道确实是空的」；</li>
 * <li><b>drain 汇按格归属错位</b>：几何挂到别的格上，dump 出来「有几何」但位置全错；</li>
 * <li><b>自描述缺项</b>：D1/D3 判红的机读前提。</li>
 * </ul>
 * 实读路径（真世界、真渲染循环里的录窗）由 runClient 实机覆盖（见归档记录），
 * 本测试锁的是<b>纯逻辑</b>那一半。
 *
 * <h2>gson 纪律</h2>
 * 只用 2.2.4 兼容 API（{@code JsonObject.get}/{@code JsonArray.get}/{@code entrySet}），
 * 经 {@link Json} 包装取默认值。
 */
public class ReadCaptureOfflineTest {

    /** 注入给 {@code buildReadback} 的固定时钟：让「逐字节等价」这条判据确定性成立。 */
    private static final TimeSource FIXED_CLOCK = TimeSource
        .fixed("2026-10-08T00:00:00.123+08:00", "20261008-000000", 0L);

    /** 与之对应的 {@code readAt} 期望值（用于证明该字段真的来自注入的时钟）。 */
    private static final String FIXED_CLOCK_ISO = "2026-10-08T00:00:00.123+08:00";

    /** 另一个固定时钟：用于证明 {@code readAt} 不是常量（负对照）。 */
    private static final String OTHER_CLOCK_ISO = "2026-10-08T00:00:01.000+08:00";

    @Before
    public void setUp() {
        // 每个用例从「从未布防」起手：会话态是类级单例，不清会让用例互相污染
        CaptureDiagSession.resetForTesting();
        CaptureDiagnostics.resetForTesting(false);
    }

    @After
    public void tearDown() {
        CaptureDiagSession.resetForTesting();
        CaptureDiagnostics.resetForTesting(false);
    }

    // ------------------------------------------------------------ 负对照：未采集显式空态

    /**
     * 未采集 ⇒ 显式空态：{@code collectionState=not-collected} + 全 0 + note 明写「这是未采集」。
     *
     * <p>
     * 这是验收「负对照：未捕获/未注入状态下读回显式空态（不编造数据）」的离线那一半。
     */
    @Test
    public void notCollectedYieldsExplicitEmptyStateNotFabricatedData() {
        JsonObject diag = CaptureDiagnostics.toJson();
        JsonObject r = ReadCaptureAction.buildReadback(diag, false, false, null, true, 64);

        assertEquals(ReadCaptureAction.STATE_NOT_COLLECTED, str(r, "collectionState"));
        assertFalse(bool(r, "collected"));
        assertFalse(bool(r, "everCollected"));
        // 三通道全 0——但这是「没采」，不是「采到零流入」
        JsonObject channels = obj(r, "channels");
        assertEquals("四个通道一个都不能少（少一个 = 调用方看不出这条通道的存在）", 4, Json.size(channels));
        for (CaptureChannel ch : CaptureChannel.values()) {
            JsonObject c = obj(channels, ch.name());
            assertNotNull("缺通道 " + ch.name(), c);
            assertEquals(ch.name() + ".windows 未采集应为 0", 0, num(c, "windows"));
            assertEquals(ch.name() + ".quads 未采集应为 0", 0, num(c, "quads"));
            assertEquals(ch.name() + ".zeroFlowWindows 未采集应为 0", 0, num(c, "zeroFlowWindows"));
        }
        // note 必须显式区分两种 0（这是「不编造数据」的可读落点）
        String note = str(r, "note");
        assertNotNull("未采集态必须给 note（否则调用方无从区分两种 0）", note);
        assertTrue("note 未说明这是「未采集」: " + note, note.contains("未采集"));
        assertTrue("note 未点明与「采集到零流入」的区别: " + note, note.contains("零流入"));
        // 空表也要显式给（不给键 = 「这个字段我没读」，与「这个表是空的」含义相反）
        assertNotNull(r.get("quadsByAttr"));
        assertEquals(0, arr(r, "quadsByAttr").size());
        assertEquals(0, arr(r, "windowEvents").size());
        assertEquals(0, arr(r, "selfProofLines").size());
    }

    /** 采过又撤防 ⇒ 计数是已采到的真实证据（撤防不清计数）。 */
    @Test
    public void disarmedKeepsEvidenceAndSaysSo() {
        CaptureDiagnostics.resetForTesting(true);
        CaptureDiagnostics.noteWindowClosed(CaptureChannel.TESR, 65, 12, 64, "TileEntityChest", 7);
        CaptureDiagnostics.noteWindowClosed(CaptureChannel.TESR, 66, 12, 64, "TileEntityChest", 0);
        // 撤防（计数必须留住）
        CaptureDiagnostics.endSession();

        JsonObject r = ReadCaptureAction
            .buildReadback(CaptureDiagnostics.toJson(), CaptureDiagnostics.isSessionEnabled(), true, null, true, 64);
        assertEquals(ReadCaptureAction.STATE_DISARMED, str(r, "collectionState"));
        assertFalse("撤防后 collected 应为 false", bool(r, "collected"));
        assertTrue("撤防后 everCollected 应为 true", bool(r, "everCollected"));
        JsonObject tesr = obj(obj(r, "channels"), "TESR");
        assertEquals("撤防不得清计数：windows", 2, num(tesr, "windows"));
        assertEquals("撤防不得清计数：quads", 7, num(tesr, "quads"));
        assertEquals("撤防不得清计数：zeroFlowWindows", 1, num(tesr, "zeroFlowWindows"));
        String note = str(r, "note");
        assertTrue("撤防态 note 未说明证据保留: " + note, note.contains("真实证据"));
    }

    /** 正在采且真的采到零流入 ⇒ 与「没采」在读数上分得开（同一个 0，两种含义）。 */
    @Test
    public void collectingWithZeroFlowIsDistinguishableFromNotCollected() {
        CaptureDiagnostics.resetForTesting(true);
        JsonObject collecting = ReadCaptureAction
            .buildReadback(CaptureDiagnostics.toJson(), true, true, null, true, 64);
        JsonObject notCollected = ReadCaptureAction
            .buildReadback(CaptureDiagnostics.toJson(), false, false, null, true, 64);

        assertEquals(ReadCaptureAction.STATE_COLLECTING, str(collecting, "collectionState"));
        assertEquals(ReadCaptureAction.STATE_NOT_COLLECTED, str(notCollected, "collectionState"));
        assertTrue(bool(collecting, "collected"));
        assertFalse(bool(notCollected, "collected"));
        // 两者的通道计数逐字相同（都是 0）——区别只在 collectionState/collected/note，
        // 因此这三者是这条负对照的唯一判据，一个都不能省
        assertEquals(Json.toJson(obj(collecting, "channels")), Json.toJson(obj(notCollected, "channels")));
        assertFalse(
            "两种态的 note 必须不同（否则调用方只能靠猜）",
            str(collecting, "note") == null ? str(notCollected, "note") == null
                : str(collecting, "note").equals(str(notCollected, "note")));
    }

    // ------------------------------------------------------------ 三通道计数与 zeroFlow 读回

    /**
     * 三通道计数与 zeroFlow 逐字段读回（老探针判据 2/3/4 的读数口径）。
     *
     * <p>
     * 造的是「管格 TESR 有几何 + 箱格 TESR zeroFlow + 区块编译有流入 + 旧路径有流入」四种形态，
     * 覆盖验收里「读回计数与预期一致」的全部分支。
     */
    @Test
    public void threeChannelCountsAndZeroFlowReadBackExactly() {
        CaptureDiagnostics.resetForTesting(true);
        // 管格：TESR 有 6 个四边形（两次窗口）
        CaptureDiagnostics.noteWindowClosed(CaptureChannel.TESR, 64, 12, 64, "LogisticsTileGenericPipe", 4);
        CaptureDiagnostics.noteWindowClosed(CaptureChannel.TESR, 64, 12, 64, "LogisticsTileGenericPipe", 2);
        // 箱格：TESR 窗口开着但零流入（zeroFlow）
        CaptureDiagnostics.noteWindowClosed(CaptureChannel.TESR, 67, 12, 64, "TileEntityChest", 0);
        // 区块编译：两窗口、42 个四边形
        CaptureDiagnostics.noteWindowClosed(CaptureChannel.BLOCK_COMPILE, 64, 0, 64, "chunk(4,4)", 30);
        CaptureDiagnostics.noteWindowClosed(CaptureChannel.BLOCK_COMPILE, 80, 0, 64, "chunk(5,4)", 12);
        // 旧路径
        CaptureDiagnostics.noteWindowClosed(CaptureChannel.LEGACY_PER_CELL, 64, 12, 64, "minecraft:stone", 6);
        // 按格归属聚合（老探针 quadCountAt 的数据源）
        for (int i = 0; i < 4; i++) {
            CaptureDiagnostics.noteQuad(CaptureChannel.TESR, 64, 12, 64, 64, 12, 64, false);
        }
        for (int i = 0; i < 2; i++) {
            CaptureDiagnostics.noteQuad(CaptureChannel.TESR, 64, 12, 64, 65, 12, 64, true);
        }

        JsonObject r = ReadCaptureAction.buildReadback(CaptureDiagnostics.toJson(), true, true, null, true, 64);
        JsonObject ch = obj(r, "channels");

        JsonObject tesr = obj(ch, "TESR");
        assertEquals("TESR windows", 3, num(tesr, "windows"));
        assertEquals("TESR quads（4+2+0）", 6, num(tesr, "quads"));
        assertEquals("TESR zeroFlowWindows（箱格那次）", 1, num(tesr, "zeroFlowWindows"));

        JsonObject bc = obj(ch, "BLOCK_COMPILE");
        assertEquals("BLOCK_COMPILE windows", 2, num(bc, "windows"));
        assertEquals("BLOCK_COMPILE quads", 42, num(bc, "quads"));
        assertEquals("BLOCK_COMPILE zeroFlowWindows", 0, num(bc, "zeroFlowWindows"));

        JsonObject legacy = obj(ch, "LEGACY_PER_CELL");
        assertEquals("LEGACY_PER_CELL windows", 1, num(legacy, "windows"));
        assertEquals("LEGACY_PER_CELL quads", 6, num(legacy, "quads"));

        JsonObject fmp = obj(ch, "FMP_DYNAMIC");
        assertEquals("FMP_DYNAMIC 尚无开窗点：全 0 也要在读数里出现", 0, num(fmp, "windows"));

        // 按格归属：唯一键 (channel,attrX,attrY,attrZ) ⇒ 六次流入全挂在同一归属格上（一条记录）
        JsonArray byAttr = arr(r, "quadsByAttr");
        assertEquals("归属格是窗口开启时的 attr 三元组，六次流入同格 ⇒ 一条记录", 1, byAttr.size());
        JsonObject attr0 = byAttr.get(0)
            .getAsJsonObject();
        assertEquals("TESR", str(attr0, "channel"));
        assertEquals(64, num(attr0, "x"));
        assertEquals(12, num(attr0, "y"));
        assertEquals(64, num(attr0, "z"));
        assertEquals("归属格四边形数（老探针 quadCountAt 读的就是这个）", 6, num(attr0, "quads"));
        assertEquals("跨箱四边形必须被暴露（两次 crossBin=true）", 2, num(r, "crossBinQuads"));
        // 分箱与归属格是不同的量：其中两个四边形落在 (65,12,64) 这个分箱里
        JsonArray byBin = arr(r, "quadsByBin");
        assertEquals("分箱键 (channel,binX,binY,binZ) ⇒ 两条", 2, byBin.size());
        boolean sawOtherBin = false;
        for (int i = 0; i < byBin.size(); i++) {
            JsonObject b = byBin.get(i)
                .getAsJsonObject();
            if (num(b, "x") == 65) {
                sawOtherBin = true;
                assertEquals("跨到 (65,12,64) 分箱的两个四边形", 2, num(b, "quads"));
            }
        }
        assertTrue("分箱表必须包含与归属格不同的那个箱（否则 byBin 是 byAttr 的复制品）", sawOtherBin);
    }

    /** 逐窗口事件表的 zeroFlow 布尔逐条可读（zeroFlow 的逐条证据，不只聚合计数）。 */
    @Test
    public void windowEventsCarryPerWindowZeroFlow() {
        CaptureDiagnostics.resetForTesting(true);
        CaptureDiagnostics.noteWindowClosed(CaptureChannel.TESR, 10, 64, -3, "TileEntityChest", 0);
        CaptureDiagnostics.noteWindowClosed(CaptureChannel.TESR, 10, 64, -3, "TileEntityChest", 7);

        JsonObject r = ReadCaptureAction.buildReadback(CaptureDiagnostics.toJson(), true, true, null, true, 64);
        JsonArray events = arr(r, "windowEvents");
        assertEquals(2, events.size());
        JsonObject e0 = events.get(0)
            .getAsJsonObject();
        assertTrue("首个窗口零流入，zeroFlow 必须为 true", bool(e0, "zeroFlow"));
        assertEquals(0, num(e0, "quadCount"));
        assertEquals(-3, num(e0, "attrZ"));
        assertFalse(
            "第二个窗口有流入，zeroFlow 必须为 false",
            bool(
                events.get(1)
                    .getAsJsonObject(),
                "zeroFlow"));
        assertEquals(2, num(r, "windowEventsAvailable"));
        assertEquals(2, num(r, "windowEventsMatched"));
        assertFalse(bool(r, "windowEventsTruncated"));
    }

    /** {@code maxEvents} 截断必须显式（不静默丢事件）。 */
    @Test
    public void maxEventsTruncationIsExplicit() {
        CaptureDiagnostics.resetForTesting(true);
        for (int i = 0; i < 10; i++) {
            CaptureDiagnostics.noteWindowClosed(CaptureChannel.TESR, i, 12, 64, "te", 1);
        }
        JsonObject r = ReadCaptureAction.buildReadback(CaptureDiagnostics.toJson(), true, true, null, true, 3);
        assertEquals(3, arr(r, "windowEvents").size());
        assertEquals("命中总数不因截断而少报", 10, num(r, "windowEventsMatched"));
        assertTrue("截断必须显式", bool(r, "windowEventsTruncated"));
        assertEquals(3, num(r, "windowEventsLimit"));

        // maxEvents=0 ⇒ 不要事件表，但聚合计数照给
        JsonObject zero = ReadCaptureAction.buildReadback(CaptureDiagnostics.toJson(), true, true, null, true, 0);
        assertEquals(0, arr(zero, "windowEvents").size());
        assertTrue(bool(zero, "windowEventsTruncated"));
        assertEquals(10, num(obj(zero, "channels").getAsJsonObject("TESR"), "windows"));

        // events=false ⇒ 显式标注省略（不是「恰好没有事件」）
        JsonObject omitted = ReadCaptureAction.buildReadback(CaptureDiagnostics.toJson(), true, true, null, false, 64);
        assertTrue(bool(omitted, "windowEventsOmitted"));
        assertNull("省略时不该给一个看起来像「零条事件」的空表", omitted.get("windowEvents"));
    }

    /** {@code directTessellatorHookActive} 与会话态是两件事（一个证明 Mixin 活着，一个说明采没采）。 */
    @Test
    public void hookActiveIsIndependentOfCollectionState() {
        // 未开诊断会话，但 Mixin 见过顶点（录窗外也置位）
        CaptureDiagnostics.resetForTesting(false);
        CaptureDiagnostics.noteDirectTessellatorVertex();
        JsonObject r = ReadCaptureAction.buildReadback(CaptureDiagnostics.toJson(), false, false, null, true, 64);
        assertTrue("钩子自检位不受启用态影响（它证明的是 Mixin 活着）", bool(r, "directTessellatorHookActive"));
        assertEquals("顶点计数只在采集期内累加", 0, num(r, "directTessellatorVertexCount"));
        assertEquals(ReadCaptureAction.STATE_NOT_COLLECTED, str(r, "collectionState"));

        // 开了会话但无 DirectTessellator 流量：false 是正确行为，且 note 必须解释
        CaptureDiagnostics.resetForTesting(true);
        JsonObject r2 = ReadCaptureAction.buildReadback(CaptureDiagnostics.toJson(), true, true, null, true, 64);
        assertFalse(bool(r2, "directTessellatorHookActive"));
        assertNotNull("false 必须带解释（否则会被误读成缺陷）", str(r2, "hookScope"));
        assertTrue("note 必须区分「Mixin 坏了」与「本会话本来就没这条流量」", str(r2, "note").contains("正确行为"));
    }

    // ------------------------------------------------------------ 通道过滤

    /** 通道过滤：只回该通道，且聚合表与事件表都按同一口径过滤。 */
    @Test
    public void channelFilterNarrowsCountsAggregatesAndEvents() {
        CaptureDiagnostics.resetForTesting(true);
        CaptureDiagnostics.noteWindowClosed(CaptureChannel.TESR, 64, 12, 64, "pipe", 4);
        CaptureDiagnostics.noteWindowClosed(CaptureChannel.BLOCK_COMPILE, 64, 0, 64, "chunk(4,4)", 30);
        CaptureDiagnostics.noteQuad(CaptureChannel.TESR, 64, 12, 64, 64, 12, 64, false);
        CaptureDiagnostics.noteQuad(CaptureChannel.BLOCK_COMPILE, 64, 0, 64, 64, 0, 64, false);

        JsonObject r = ReadCaptureAction.buildReadback(CaptureDiagnostics.toJson(), true, true, "TESR", true, 64);
        assertEquals("TESR", str(r, "channelFilter"));
        assertTrue(bool(r, "channelFilterApplied"));
        assertEquals("过滤后只剩一个通道", 1, Json.size(obj(r, "channels")));
        assertNotNull(obj(r, "channels").get("TESR"));
        assertNull("被过滤掉的通道不该出现在 channels 里", obj(r, "channels").get("BLOCK_COMPILE"));
        assertEquals(1, arr(r, "channelsReturned").size());
        // 聚合表同口径过滤
        JsonArray byAttr = arr(r, "quadsByAttr");
        assertEquals(1, byAttr.size());
        assertEquals(
            "TESR",
            str(
                byAttr.get(0)
                    .getAsJsonObject(),
                "channel"));
        // 事件表同口径过滤
        assertEquals(1, arr(r, "windowEvents").size());
        assertEquals("命中总数是过滤后的数（不是全表数）", 1, num(r, "windowEventsMatched"));
        assertEquals("available 是全表数，便于调用方知道过滤掉了多少", 2, num(r, "windowEventsAvailable"));
    }

    /** 通道名规范化：大小写不敏感、all/* 表示不过滤。 */
    @Test
    public void channelNameNormalization() {
        assertNull("null = 不过滤", CaptureDiagSession.normalizeChannel(null));
        assertNull("空串 = 不过滤", CaptureDiagSession.normalizeChannel("  "));
        assertNull("all = 不过滤", CaptureDiagSession.normalizeChannel("all"));
        assertNull("* = 不过滤", CaptureDiagSession.normalizeChannel("*"));
        assertEquals("TESR", CaptureDiagSession.normalizeChannel("tesr"));
        assertEquals("BLOCK_COMPILE", CaptureDiagSession.normalizeChannel(" block_compile "));
        assertEquals("LEGACY_PER_CELL", CaptureDiagSession.normalizeChannel("Legacy_Per_Cell"));
        // 未知通道名必须报错，不静默回全通道（否则笔误看起来像「这个通道确实是空的」）
        try {
            CaptureDiagSession.normalizeChannel("TESR2");
            fail("未知通道名必须抛 CP-VALID-002");
        } catch (CpException e) {
            assertEquals("CP-VALID-002", e.code());
            assertNotNull("必须带逐字段说明", e.context());
        }
    }

    /**
     * 自述声明的 {@code channel} 缺省值（{@code "all"}）必须与「省略」**逐字段等价**（F6）。
     *
     * <p>
     * 这是给 D3 补 default 的**风险对价**：自述一旦声明 {@code default:"all"}，按自述物化 default 的调用方
     * （本仓 {@code caller.mjs} 规则 3）会把 {@code channel:"all"} 真的塞进请求体。若实现把「显式 all」
     * 与「省略」分开对待（例如 {@code channelFilterApplied} 变 true、或 channels 表少一个通道），
     * 那这次「补上机读默认值」就等于悄悄改了一次行为。本用例把两者钉成同一份读数。
     *
     * <h2>为什么必须注入时钟</h2>
     * 本用例此前直接比较整份 JSON，而 {@code readAt} 是墙钟读数 ⇒ 两次调用必然取到不同值。
     * 该假红的形状：两份读数**只差 readAt**，
     * {@code expected:<...T00:36:21.09[49049]+08:00> but was:<...T00:36:21.09[5911]+08:00>}；
     * 同一份代码在另一次构建里却全绿
     * ⇒ 该判据的成败取决于**测试 JVM 的墙钟精度**，与实现无关，是**环境相关的假红**。
     * 注入固定时钟后本判据变成确定性的、且更强：连 {@code readAt} 一起要求逐字节相同。
     */
    @Test
    public void explicitAllChannelIsIndistinguishableFromOmitted() {
        CaptureDiagnostics.resetForTesting(true);
        CaptureDiagnostics.noteWindowClosed(CaptureChannel.TESR, 64, 12, 64, "pipe", 4);
        CaptureDiagnostics.noteWindowClosed(CaptureChannel.BLOCK_COMPILE, 64, 0, 64, "chunk(4,4)", 30);
        CaptureDiagnostics.noteQuad(CaptureChannel.TESR, 64, 12, 64, 64, 12, 64, false);

        JsonObject diag = CaptureDiagnostics.toJson();
        // 省略 channel ⇒ 动作侧取到的就是 null（见 ReadCaptureAction：ctx.optString("channel", null)）
        JsonObject omitted = ReadCaptureAction.buildReadback(diag, true, true, null, true, 64, FIXED_CLOCK);
        // 显式 "all" ⇒ 经 normalizeChannel 折成 null 后走同一条路
        JsonObject explicitAll = ReadCaptureAction
            .buildReadback(diag, true, true, CaptureDiagSession.normalizeChannel("all"), true, 64, FIXED_CLOCK);

        assertNull("显式 all 必须与省略一样折成「不过滤」", CaptureDiagSession.normalizeChannel("all"));
        assertEquals(
            "显式 all 与省略的读数必须<b>逐字节</b>相同（含 readAt——固定时钟下它是确定值）",
            Json.toJson(omitted),
            Json.toJson(explicitAll));
        assertEquals("all", str(explicitAll, "channelFilter"));
        assertFalse("不过滤时 channelFilterApplied 必须是 false", bool(explicitAll, "channelFilterApplied"));
        assertEquals("四通道一个都不少", 4, Json.size(obj(explicitAll, "channels")));

        // ---- 负对照 1：readAt 必须真的来自注入的时钟（不是被剔掉、也不是常量） ----
        assertEquals("readAt 必须等于注入时钟的值", FIXED_CLOCK_ISO, str(explicitAll, "readAt"));
        JsonObject otherClock = ReadCaptureAction.buildReadback(
            diag,
            true,
            true,
            null,
            true,
            64,
            TimeSource.fixed(OTHER_CLOCK_ISO, "20261008-000001", 1000L));
        assertEquals("换时钟后 readAt 必须跟着变", OTHER_CLOCK_ISO, str(otherClock, "readAt"));

        // ---- 负对照 2：本比较不是恒绿的——把「过滤生效」的读数拿来比，必须不相等 ----
        JsonObject filtered = ReadCaptureAction.buildReadback(diag, true, true, "TESR", true, 64, FIXED_CLOCK);
        assertFalse(
            "本比较必须能抓到真实差异（否则这条判据是空转的）",
            Json.toJson(omitted)
                .equals(Json.toJson(filtered)));
    }

    // ------------------------------------------------------------ 会话布防/撤防

    /** 布防：录窗开、会话开、drain 汇按需挂上；状态快照如实回报。 */
    @Test
    public void armTurnsOnWindowsSessionAndDrainSink() {
        JsonObject before = CaptureDiagSession.arm(true, true, false, "2026-10-07T00:00:00Z");
        assertFalse("布防前不该是布防态", bool(before, "armed"));

        assertTrue(CaptureDiagSession.isArmed());
        assertTrue(CaptureDiagSession.everArmed());
        assertTrue("布防必须开录窗总开关", com.lightning.mod.client.meshcapture.TessellatorCaptureState.areWindowsArmed());
        assertTrue("布防必须开诊断会话", CaptureDiagnostics.isSessionEnabled());
        assertTrue("drainDump:true 必须真的挂上汇", CaptureDiagSession.isDrainSinkAttached());
        assertNotNull(CaptureDiagSession.collector());
        assertEquals("2026-10-07T00:00:00Z", CaptureDiagSession.armedAt());

        JsonObject st = CaptureDiagSession.status();
        assertTrue(bool(st, "armed"));
        assertTrue(bool(st, "windowsArmed"));
        assertTrue(bool(st, "drainDumpArmed"));
        assertTrue(bool(st, "drainSinkAttached"));
        assertTrue(bool(st, "diagnosticsSessionEnabled"));
    }

    /** 撤防：三个开关都关，但计数与汇必须留住（否则「撤防」会销毁刚采到的现场）。 */
    @Test
    public void disarmKeepsCountsAndCollector() {
        CaptureDiagSession.arm(true, true, false, "t0");
        CaptureDiagnostics.noteWindowClosed(CaptureChannel.TESR, 64, 12, 64, "pipe", 4);
        CaptureDiagSession.collector()
            .onWindowDrained(CaptureChannel.TESR, 64, 12, 64, "pipe", oneQuad());

        JsonObject before = CaptureDiagSession.disarm();
        assertTrue("撤防前快照应记录布防态", bool(before, "armed"));
        assertFalse(CaptureDiagSession.isArmed());
        assertTrue("everArmed 必须留住（区分「从未采集」与「采集过又撤防」）", CaptureDiagSession.everArmed());
        assertFalse(CaptureDiagnostics.isSessionEnabled());
        assertFalse("撤防必须撤录窗总开关", com.lightning.mod.client.meshcapture.TessellatorCaptureState.areWindowsArmed());
        assertFalse("撤防必须撤 drain 汇", CaptureDiagSession.isDrainSinkAttached());
        assertNotNull("汇本体不得被丢弃（撤防后还要能 dump）", CaptureDiagSession.collector());
        assertEquals(
            "汇里的几何不得被丢弃",
            1,
            CaptureDiagSession.collector()
                .quadCount());
        JsonObject st = CaptureDiagSession.status();
        assertEquals("撤防不得清 drain 汇窗口数", 1, num(st, "drainWindows"));
        assertEquals("撤防不得清 drain 汇四边形数", 1, num(st, "drainQuads"));
        // 计数仍在 CaptureDiagnostics 里（read.capture 撤防后仍读得到）
        JsonObject r = ReadCaptureAction.buildReadback(
            CaptureDiagnostics.toJson(),
            CaptureDiagnostics.isSessionEnabled(),
            CaptureDiagSession.everArmed(),
            null,
            true,
            64);
        assertEquals(ReadCaptureAction.STATE_DISARMED, str(r, "collectionState"));
        assertEquals("撤防后 read.capture 仍必须读得到已采到的窗口数", 1, num(obj(obj(r, "channels"), "TESR"), "windows"));
        assertEquals("撤防后 read.capture 仍必须读得到已采到的四边形数", 4, num(obj(obj(r, "channels"), "TESR"), "quads"));
    }

    /** drain 汇：只接 TESR、按格归属、zeroFlow 窗口只计数不产几何、latestWindowOnly 覆盖语义。 */
    @Test
    public void drainCollectorBucketsTesrByCellAndSkipsZeroFlow() {
        CaptureDiagSession.WindowDrainCollector c = new CaptureDiagSession.WindowDrainCollector();
        c.onWindowDrained(CaptureChannel.TESR, 64, 12, 64, "pipe", oneQuad());
        c.onWindowDrained(CaptureChannel.TESR, 64, 12, 64, "pipe", oneQuad());
        // zeroFlow 窗口：只计窗口数，不产几何
        c.onWindowDrained(
            CaptureChannel.TESR,
            67,
            12,
            64,
            "chest",
            new ArrayList<com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad>());
        // 非 TESR 通道必须被忽略（BLOCK_COMPILE 窗口数在实测会话里是 3 万+量级）
        c.onWindowDrained(CaptureChannel.BLOCK_COMPILE, 64, 0, 64, "chunk", oneQuad());

        assertEquals("TESR 窗口数（含 zeroFlow）", 3, c.windows());
        assertEquals("有流入的窗口数", 2, c.windowsWithFlow());
        assertEquals("四边形总数", 2, c.quadCount());
        assertEquals("归属格数（箱格零流入不进表）", 1, c.cellCount());
        assertEquals(
            1,
            c.cellKeys()
                .size());
        assertEquals(
            2,
            c.quadsAt(64, 12, 64)
                .size());
        assertEquals(
            "没采到的格返回空表而不是 null",
            0,
            c.quadsAt(9, 9, 9)
                .size());
        assertEquals(2, num(c.perCellQuadCounts(), "64,12,64"));

        // 格键往返（dump 装配靠它把键解回坐标）
        int[] pos = CaptureDiagSession.WindowDrainCollector.parseCellKey("64,12,-3");
        assertNotNull(pos);
        assertEquals(64, pos[0]);
        assertEquals(12, pos[1]);
        assertEquals(-3, pos[2]);
        assertNull("形态不符必须返回 null（不猜）", CaptureDiagSession.WindowDrainCollector.parseCellKey("64,12"));
        assertNull(CaptureDiagSession.WindowDrainCollector.parseCellKey("a,b,c"));
    }

    /** {@code latestWindowOnly}：每格只留最后一个非空窗口（一个窗口 = 一次完整 renderTileEntity）。 */
    @Test
    public void latestWindowOnlyKeepsLastNonEmptyWindowPerCell() {
        CaptureDiagSession.arm(true, true, true, "t0");
        CaptureDiagSession.WindowDrainCollector attached = CaptureDiagSession.collector();
        attached.onWindowDrained(CaptureChannel.TESR, 64, 12, 64, "pipe", twoQuads());
        attached.onWindowDrained(CaptureChannel.TESR, 64, 12, 64, "pipe", oneQuad());
        // 空窗口不得把已有几何清掉（它是 zeroFlow，不是「这一格没几何」）
        attached.onWindowDrained(
            CaptureChannel.TESR,
            64,
            12,
            64,
            "pipe",
            new ArrayList<com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad>());

        assertEquals(
            "latestWindowOnly=true ⇒ 每格只留最后一个非空窗口",
            1,
            attached.quadsAt(64, 12, 64)
                .size());
        assertEquals("窗口计数仍累计（含空窗口）", 3, attached.windows());
        assertEquals("有流入的窗口数", 2, attached.windowsWithFlow());
    }

    /** 重新布防（reset:true）必须清计数与汇——否则「第二轮」里混着上一轮的数。 */
    @Test
    public void rearmWithResetClearsCountsAndCollector() {
        CaptureDiagSession.arm(true, true, false, "t0");
        CaptureDiagnostics.noteWindowClosed(CaptureChannel.TESR, 64, 12, 64, "pipe", 4);
        CaptureDiagSession.collector()
            .onWindowDrained(CaptureChannel.TESR, 64, 12, 64, "pipe", oneQuad());
        assertEquals(
            1,
            CaptureDiagSession.collector()
                .quadCount());

        CaptureDiagSession.arm(true, true, false, "t1");
        assertEquals(
            "reset:true ⇒ 汇清零",
            0,
            CaptureDiagSession.collector()
                .quadCount());
        assertEquals(
            "reset:true ⇒ 诊断计数清零",
            0,
            num(
                obj(
                    obj(
                        ReadCaptureAction.buildReadback(CaptureDiagnostics.toJson(), true, true, null, true, 0),
                        "channels"),
                    "TESR"),
                "windows"));
        assertEquals("t1", CaptureDiagSession.armedAt());
    }

    /** 重复布防不抛错（无人值守脚本重跑是常态），reset:false 时不清计数。 */
    @Test
    public void rearmWithoutResetKeepsCounts() {
        CaptureDiagSession.arm(true, true, false, "t0");
        CaptureDiagnostics.noteWindowClosed(CaptureChannel.TESR, 64, 12, 64, "pipe", 4);
        CaptureDiagSession.arm(false, false, false, "t1");
        assertEquals(
            "reset:false ⇒ 计数留住（脚本重跑不该把上一轮抹掉）",
            1,
            num(
                obj(
                    obj(
                        ReadCaptureAction.buildReadback(CaptureDiagnostics.toJson(), true, true, null, true, 0),
                        "channels"),
                    "TESR"),
                "windows"));
        assertFalse("drainDump:false 的那次布防不该留着汇布防态", CaptureDiagSession.isDrainSinkAttached());
    }

    // ------------------------------------------------------------ dump 格清单解析（纯逻辑部分）

    /** {@code at} 显式格清单：含录不到的格（这是「判漏录」的唯一表达方式）。 */
    @Test
    public void resolveDumpCellsKeepsCellsWithoutGeometry() {
        CaptureDiagSession.arm(true, true, false, "t0");
        CaptureDiagSession.collector()
            .onWindowDrained(CaptureChannel.TESR, 64, 12, 64, "pipe", oneQuad());

        JsonArray at = new JsonArray();
        at.add(pos(64, 12, 64));
        at.add(pos(65, 12, 64)); // 这一格没采到几何——必须仍在清单里
        List<CaptureDiagSession.DumpCell> cells = CaptureDiagSession.resolveDumpCells(at);
        assertEquals("显式清单里的格一个都不能少", 2, cells.size());
        assertEquals(64, cells.get(0).x);
        assertEquals(1, cells.get(0).quads.size());
        assertEquals("录不到的格照样在清单里（quads 为空）", 0, cells.get(1).quads.size());
        assertEquals(65, cells.get(1).x);
    }

    /** 不给 {@code at} 时取汇里实际有几何的格；汇为空时报 CP-STATE-001 而不是返回空产物。 */
    @Test
    public void resolveDumpCellsFallsBackToCollectorAndFailsLoudlyWhenEmpty() {
        CaptureDiagSession.arm(true, true, false, "t0");
        try {
            CaptureDiagSession.resolveDumpCells(null);
            fail("汇为空且未给 at ⇒ 必须 CP-STATE-001（返回空产物 = 空转绿）");
        } catch (CpException e) {
            assertEquals("CP-STATE-001", e.code());
            assertNotNull("必须带 drain 汇状态与补救提示", e.context());
            assertNotNull(str(e.context(), "hint"));
        }
        CaptureDiagSession.collector()
            .onWindowDrained(CaptureChannel.TESR, 64, 12, 64, "pipe", oneQuad());
        List<CaptureDiagSession.DumpCell> cells = CaptureDiagSession.resolveDumpCells(null);
        assertEquals(1, cells.size());
        assertEquals(64, cells.get(0).x);
        assertEquals(12, cells.get(0).y);
        assertEquals(64, cells.get(0).z);
    }

    /** {@code at} 形态非法（空数组 / 重复格 / 非三元组）必须 CP-VALID-002 逐字段说明。 */
    @Test
    public void resolveDumpCellsRejectsBadShapesWithFieldContext() {
        CaptureDiagSession.arm(true, true, false, "t0");
        try {
            CaptureDiagSession.resolveDumpCells(new JsonArray());
            fail("空数组必须报错（它与「不给 at」含义不同）");
        } catch (CpException e) {
            assertEquals("CP-VALID-002", e.code());
        }

        JsonArray dup = new JsonArray();
        dup.add(pos(64, 12, 64));
        dup.add(pos(64, 12, 64));
        try {
            CaptureDiagSession.resolveDumpCells(dup);
            fail("重复格必须报错");
        } catch (CpException e) {
            assertEquals("CP-VALID-002", e.code());
            assertTrue(
                "必须逐字段说明",
                Json.toJson(e.context())
                    .contains("at[1]"));
        }

        JsonArray bad = new JsonArray();
        JsonArray twoOnly = new JsonArray();
        twoOnly.add(new com.google.gson.JsonPrimitive(64));
        twoOnly.add(new com.google.gson.JsonPrimitive(12));
        bad.add(twoOnly);
        try {
            CaptureDiagSession.resolveDumpCells(bad);
            fail("非三元组必须报错");
        } catch (CpException e) {
            assertEquals("CP-VALID-002", e.code());
        }
    }

    /**
     * dump 的 cell 标签不得自带坐标。
     *
     * <p>
     * 实机擒获：装配器在 {@code missing} 里自行追加 {@code @x,y,z}，若标签再带坐标就成了
     * {@code cell@515,4,-647@515,4,-647}。标签用 registryId（回答「这一格本该是什么」）即可。
     * 这里锁的是「标签里不出现坐标」这条不变量。
     */
    @Test
    public void dumpLabelsMustNotEmbedCoordinates() {
        CaptureDiagSession.arm(true, true, false, "t0");
        JsonArray at = new JsonArray();
        at.add(pos(515, 4, -647));
        List<CaptureDiagSession.DumpCell> cells = CaptureDiagSession.resolveDumpCells(at);
        assertEquals(1, cells.size());
        // DumpCell 不带 label（标签在装配时按 registryId 生成）；这里锁「装配输入不含坐标标签」的形态：
        // registryId 由世界实读，测试里只能验形态——真正的不变量在实机 dump 的 cellSources.label 上，
        // 见 evidence/I1-dump.json
        assertEquals("DumpCell 只承载坐标与几何，不带自造标签", 515, cells.get(0).x);
        assertEquals(4, cells.get(0).y);
        assertEquals(-647, cells.get(0).z);
    }

    // ------------------------------------------------------------ reset 缺省规则（实机擒获的缺陷）

    /**
     * 纯 dump 形态不得顺手重新布防、也不得顺手撤防、更不得清零计数（三态缺省规则）。
     *
     * <p>
     * 实机擒获的缺陷：{@code {"dump":true}} 若沿用 {@code arm:true,reset:true} 的缺省，会「顺手清零计数
     * 并重新布防」——调用方以为只是把已采到的几何落盘，实际把刚采到的现场抹了。反过来把缺省改成
     * {@code arm:false} 同样错：那会把<b>正在进行的采集停掉</b>。故缺省必须是第三态「不动」。
     * 断言直接打在动作的 {@code resolveSessionMode}/{@code resolveResetDefault} 上
     * （不另抄一份规则，抄一份等于只测自己的副本）。
     */
    @Test
    public void pureDumpMustLeaveSessionUntouchedByDefault() {
        // 会话处置缺省：dump 形态「不动」，其余「布防」；显式值一律优先
        assertEquals(
            "纯 dump 且未给 arm ⇒ 必须「不动」（既不重新布防也不撤防）",
            CaptureDiagAction.SESSION_UNCHANGED,
            CaptureDiagAction.resolveSessionMode(false, true, true));
        assertEquals(
            "非 dump ⇒ 布防是默认形态",
            CaptureDiagAction.SESSION_ARM,
            CaptureDiagAction.resolveSessionMode(false, true, false));
        assertEquals(
            "显式 arm:false 必须生效",
            CaptureDiagAction.SESSION_DISARM,
            CaptureDiagAction.resolveSessionMode(true, false, false));
        assertEquals(
            "显式 arm:true 在 dump 形态必须生效",
            CaptureDiagAction.SESSION_ARM,
            CaptureDiagAction.resolveSessionMode(true, true, true));

        // reset 缺省：只在真正布防时为 true
        assertTrue("布防形态缺省清零", CaptureDiagAction.resolveResetDefault(false, true, CaptureDiagAction.SESSION_ARM));
        assertFalse(
            "纯 dump（unchanged）⇒ 缺省不清零——否则导出会抹掉刚采到的现场",
            CaptureDiagAction.resolveResetDefault(false, true, CaptureDiagAction.SESSION_UNCHANGED));
        assertFalse(
            "撤防 ⇒ 缺省不清零（撤防本就保留计数）",
            CaptureDiagAction.resolveResetDefault(false, true, CaptureDiagAction.SESSION_DISARM));
        // 显式给了 reset 就以显式值为准
        assertFalse(
            "显式 reset:false 在布防形态必须生效",
            CaptureDiagAction.resolveResetDefault(true, false, CaptureDiagAction.SESSION_ARM));
        assertTrue(
            "显式 reset:true 必须生效（调用方要清零就清零）",
            CaptureDiagAction.resolveResetDefault(true, true, CaptureDiagAction.SESSION_UNCHANGED));
    }

    /**
     * 三态缺省规则的<b>端到端</b>后果：armed 时纯 dump 必须让 armed 保持真、计数一格不动。
     *
     * <p>
     * 上一次只锁了纯函数；纯函数对而调用点接错照样是缺陷，故这里再验一次「动作层真的照这个规则走」：
     * 在 armed 状态下取 {@code status()} 快照 → 模拟 unchanged 分支 → 断言状态逐字未变。
     */
    @Test
    public void realDumpDoesNotDisturbRecordingSession() {
        CaptureDiagSession.arm(true, true, false, "t0");
        CaptureDiagnostics.noteWindowClosed(CaptureChannel.TESR, 64, 12, 64, "pipe", 5);
        JsonObject before = CaptureDiagSession.status();
        JsonObject diagBefore = CaptureDiagnostics.toJson();

        // unchanged 分支的实际动作：只取快照，不碰任何开关（与 CaptureDiagAction.execute 逐字一致）
        assertEquals(
            "纯 dump 的缺省会话处置必须是 unchanged",
            CaptureDiagAction.SESSION_UNCHANGED,
            CaptureDiagAction.resolveSessionMode(false, true, true));
        JsonObject snapshot = CaptureDiagSession.status();

        assertTrue("unchanged 后必须仍是布防态", CaptureDiagSession.isArmed());
        assertTrue("unchanged 后录窗仍开着", com.lightning.mod.client.meshcapture.TessellatorCaptureState.areWindowsArmed());
        assertTrue("unchanged 后诊断会话仍开着", CaptureDiagnostics.isSessionEnabled());
        assertEquals("unchanged 不得改动会话状态快照", Json.toJson(before), Json.toJson(snapshot));
        // 逐计数比对，不比整份 JSON：诊断 JSON 里有采集时刻戳（epochMs），两次调用必然差几毫秒——
        // 比整份会把「时间在走」误判成「计数被改了」（本用例在整套跑时正是这样假红过一次）
        assertEquals("unchanged 不得动窗口计数", 1, num(obj(obj(diagBefore, "channels"), "TESR"), "windows"));
        assertEquals(
            "unchanged 后诊断通道计数逐字段不变",
            Json.toJson(Json.optObject(diagBefore, "channels")),
            Json.toJson(Json.optObject(CaptureDiagnostics.toJson(), "channels")));
        assertEquals(
            "unchanged 后按格归属表不变",
            Json.toJson(Json.optArray(diagBefore, "quadsByAttr")),
            Json.toJson(Json.optArray(CaptureDiagnostics.toJson(), "quadsByAttr")));
        assertEquals(
            "unchanged 后自证日志不变",
            Json.toJson(Json.optArray(diagBefore, "selfProofLines")),
            Json.toJson(Json.optArray(CaptureDiagnostics.toJson(), "selfProofLines")));

        // 对照：disarm 分支确实会改状态（证明上面的断言不是恒真）
        CaptureDiagSession.disarm();
        assertFalse(CaptureDiagSession.isArmed());
        assertFalse(CaptureDiagnostics.isSessionEnabled());
    }

    // ------------------------------------------------------------ 自描述（D1/D3 的机读前提）

    /** 两个新动作的自描述六要素齐备，且 since 与权限级正确。 */
    @Test
    public void captureDiagDescriptorsAreComplete() {
        ActionRegistry registry = new ActionRegistry();
        ActionRegistrar.registerAll(null, registry);

        for (String name : new String[] { ReadCaptureAction.NAME, CaptureDiagAction.NAME }) {
            ActionDescriptor d = registry.descriptor(name);
            assertNotNull("动作必须已注册: " + name, d);
            assertEquals(name + " 必须是 observe 级（诊断不改世界、不驱动渲染）", Tier.OBSERVE, d.tier());
            assertFalse(name + " observe 级不该要求 confirm", d.writable());
            assertNotNull(name + " 缺 description", d.description());
            assertFalse(
                name + " description 为空",
                d.description()
                    .trim()
                    .isEmpty());
            assertNotNull(name + " 缺 returns", d.returns());
            assertFalse(
                name + " returns 为空",
                d.returns()
                    .trim()
                    .isEmpty());
            assertEquals(name + " since 应为 1.7（本单引入版本）", "1.7", d.since());
            assertTrue(
                name + " 至少给一条可复制示例",
                d.examples()
                    .size() > 0);
            for (int i = 0; i < d.examples()
                .size(); i++) {
                // 示例必须是可解析的 JSON 对象（示例是「无先验知识调用方」的唯一素材，写错等于没有）
                Json.parseStrictObject(
                    Json.toJson(
                        d.examples()
                            .get(i)));
            }
            for (ActionDescriptor.Param p : d.params()) {
                assertNotNull(name + "." + p.name() + " 缺参数名", p.name());
                assertNotNull(name + "." + p.name() + " 缺参数类型", p.type());
                assertNotNull(name + "." + p.name() + " 缺参数说明", p.description());
                assertFalse(
                    name + "." + p.name() + " 参数说明为空",
                    p.description()
                        .trim()
                        .isEmpty());
            }
        }
    }

    /** D3：默认值必须以机读的 {@code default} 字段出现，且与实现取值一致。 */
    @Test
    public void captureDiagDefaultsAreMachineReadableAndMatchImplementation() {
        ActionRegistry registry = new ActionRegistry();
        ActionRegistrar.registerAll(null, registry);

        assertDefault(registry, ReadCaptureAction.NAME, "events", Boolean.TRUE);
        assertDefault(
            registry,
            ReadCaptureAction.NAME,
            "maxEvents",
            Integer.valueOf(ReadCaptureAction.DEFAULT_MAX_EVENTS));
        // channel 的缺省是「不过滤」，且它**不**取决于调用形态 ⇒ 必须机读可见（F6：
        // 此前只有说明文字写了「省略 = 不过滤」，default 字段缺席 ⇒ D3「默认值机读可见」判红，
        // 而 contract.md §7.2（读面动作）已经写了「默认 all」）。
        // 「all」与「省略」在实现里走同一条路（normalizeChannel 把 all/*/空都折成 null），
        // 因此声明的 default 不会改变行为——下面的 allEqualsOmitted 用例把这一点也钉住。
        assertDefault(registry, ReadCaptureAction.NAME, "channel", "all");
        assertDefault(registry, CaptureDiagAction.NAME, "drainDump", Boolean.FALSE);
        assertDefault(registry, CaptureDiagAction.NAME, "latestWindowOnly", Boolean.FALSE);
        assertDefault(registry, CaptureDiagAction.NAME, "dump", Boolean.FALSE);
        assertDefault(
            registry,
            CaptureDiagAction.NAME,
            "margin",
            Integer.valueOf(CaptureDiagAction.DEFAULT_DUMP_MARGIN));
        // 无默认值的可选参数（at）不得凭空写 default
        assertNull(
            "at 是「不传即取 drain 到的格」，不该有 default 值",
            findParam(registry, CaptureDiagAction.NAME, "at").defaultValue());
        // arm/reset 的缺省**取决于调用形态**，任何单一 JSON 值都是谎话。
        // 更要紧的是：客户端会按自述把 default 物化进请求体（本仓 caller.mjs:311-312），
        // 写死 default:true 会让「纯导出」被当成「显式布防」——实机正是这样把三态逻辑架空的。
        assertNull(
            "arm 的缺省取决于调用形态，不得声明单一 default（会被客户端物化而架空三态语义）",
            findParam(registry, CaptureDiagAction.NAME, "arm").defaultValue());
        assertNull(
            "reset 的缺省取决于调用形态，不得声明单一 default",
            findParam(registry, CaptureDiagAction.NAME, "reset").defaultValue());
    }

    /**
     * 机读可判定性（D3 的强化）：缺省取决于形态的参数，其<b>实际生效值</b>必须出现在返回值自述里。
     *
     * <p>
     * 这是「不声明 default」这一让步的补偿：调用方失去了从 default 字段预判的能力，
     * 就必须能从结果里读到实际发生了什么。否则「不声明 default」会退化成「不可判定」。
     */
    @Test
    public void formDependentDefaultsAreMachineReadableInResult() {
        ActionRegistry registry = new ActionRegistry();
        ActionRegistrar.registerAll(null, registry);
        String returns = registry.descriptor(CaptureDiagAction.NAME)
            .returns();
        for (String field : new String[] { "sessionMode", "sessionTouched", "resetRequested", "reset", "armed",
            "defaultRule" }) {
            assertTrue("返回值自述里必须列出 " + field + "（缺省取决于形态 ⇒ 实际值必须机读可判定）", returns.contains(field));
        }
        // sessionMode 的三个取值必须可枚举（调用方要能穷举判定）
        String desc = registry.descriptor(CaptureDiagAction.NAME)
            .description();
        for (String mode : new String[] { CaptureDiagAction.SESSION_ARM, CaptureDiagAction.SESSION_DISARM,
            CaptureDiagAction.SESSION_UNCHANGED }) {
            assertTrue("动作说明或返回值自述里必须能查到 sessionMode 取值 " + mode, desc.contains(mode) || returns.contains(mode));
        }
    }

    /** 动作数口径：契约注释里的数字必须与实注册数一致（D3 漂移防线）。 */
    @Test
    public void registeredActionCountMatchesDocumentedNumber() {
        ActionRegistry registry = new ActionRegistry();
        ActionRegistrar.registerAll(null, registry);
        assertEquals("契约 1.8 的动作数（ActionRegistrar/contract.md 的注释写的是 48，三处必须一致）", 48, registry.size());
    }

    /** 契约版本必须 ≥ 任一动作的 since（否则自述端点会给出自相矛盾的目录，D1/D3 判红）。 */
    @Test
    public void contractVersionCoversEveryActionSince() {
        ActionRegistry registry = new ActionRegistry();
        ActionRegistrar.registerAll(null, registry);
        for (String name : registry.names()) {
            ActionDescriptor d = registry.descriptor(name);
            assertTrue(
                name + " 的 since=" + d.since() + " 高于契约版本 " + registry.contractVersion(),
                compareVersions(registry.contractVersion(), d.since()) >= 0);
        }
    }

    // ------------------------------------------------------------ 工具

    private static List<com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad> oneQuad() {
        List<com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad> l = new ArrayList<com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad>();
        l.add(quad());
        return l;
    }

    private static List<com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad> twoQuads() {
        List<com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad> l = new ArrayList<com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad>();
        l.add(quad());
        l.add(quad());
        return l;
    }

    private static com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad quad() {
        List<com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedVertex> verts = new ArrayList<com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedVertex>();
        for (int i = 0; i < 4; i++) {
            verts.add(
                new com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedVertex(
                    i % 2,
                    i / 2,
                    1.0,
                    0.0,
                    0.0,
                    240,
                    0xFFFFFFFF,
                    64.0,
                    12.0,
                    64.0,
                    "minecraft:atlas/blocks"));
        }
        return new com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad(verts);
    }

    private static JsonArray pos(int x, int y, int z) {
        JsonArray a = new JsonArray();
        a.add(new com.google.gson.JsonPrimitive(x));
        a.add(new com.google.gson.JsonPrimitive(y));
        a.add(new com.google.gson.JsonPrimitive(z));
        return a;
    }

    private static JsonObject obj(JsonObject o, String key) {
        JsonObject v = Json.optObject(o, key);
        assertNotNull("缺对象成员 " + key + "（在 " + Json.toJson(o) + "）", v);
        return v;
    }

    private static JsonArray arr(JsonObject o, String key) {
        JsonArray v = Json.optArray(o, key);
        assertNotNull("缺数组成员 " + key, v);
        return v;
    }

    private static String str(JsonObject o, String key) {
        return Json.optString(o, key, null);
    }

    private static boolean bool(JsonObject o, String key) {
        com.google.gson.JsonElement e = Json.get(o, key);
        assertNotNull("缺布尔成员 " + key, e);
        return e.getAsBoolean();
    }

    private static int num(JsonObject o, String key) {
        com.google.gson.JsonElement e = Json.get(o, key);
        assertNotNull("缺数值成员 " + key + "（在 " + Json.toJson(o) + "）", e);
        return e.getAsInt();
    }

    private static ActionDescriptor.Param findParam(ActionRegistry registry, String action, String param) {
        ActionDescriptor d = registry.descriptor(action);
        assertNotNull("动作未注册: " + action, d);
        for (ActionDescriptor.Param p : d.params()) {
            if (param.equals(p.name())) {
                return p;
            }
        }
        fail(action + " 缺参数 " + param);
        return null;
    }

    private static void assertDefault(ActionRegistry registry, String action, String param, Object expected) {
        ActionDescriptor.Param found = findParam(registry, action, param);
        assertNotNull(action + "." + param + " 缺 default（D3：默认值必须可见）", found.defaultValue());
        com.google.gson.JsonElement want;
        if (expected instanceof Boolean) {
            want = new com.google.gson.JsonPrimitive((Boolean) expected);
        } else if (expected instanceof Number) {
            want = new com.google.gson.JsonPrimitive((Number) expected);
        } else {
            want = new com.google.gson.JsonPrimitive(String.valueOf(expected));
        }
        assertEquals(
            action + "." + param + " 的 default 与实现取值不一致（期望 " + Json.toJson(want) + "）",
            want,
            found.defaultValue());
    }

    /** 比较 {@code a.b.c} 形态的版本号；{@code a >= b} 时返回 ≥0。 */
    private static int compareVersions(String a, String b) {
        String[] pa = a.split("\\.");
        String[] pb = b.split("\\.");
        for (int i = 0; i < Math.max(pa.length, pb.length); i++) {
            int va = i < pa.length ? Integer.parseInt(pa[i]) : 0;
            int vb = i < pb.length ? Integer.parseInt(pb[i]) : 0;
            if (va != vb) {
                return va - vb;
            }
        }
        return 0;
    }
}
