package com.lightning.mod.client.meshcapture.zeroproduce;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

import net.minecraft.tileentity.TileEntity;

import com.google.gson.JsonObject;
import com.lightning.mod.client.meshcapture.zeroproduce.ZeroProducePolicy.Decision;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 零产出的会话级记账与噪声控制：每格一行 WARN、每会话一条汇总 INFO、全部计数进导出件的 {@code captureStats}。
 * <p>
 * 为什么日志要折叠：大结构里"同一原因零产出"可能上千格，逐格刷屏会把真正要看的那几条冲走。因此
 * <strong>同一原因每会话最多 {@value #MAX_WARN_PER_REASON} 条</strong>，其余只计数；日志会滚，文件不会——
 * 完整读数落在导出件的 {@code captureStats}。
 * <p>
 * 开关（一次设定，不反复操纵）：{@code -Dsde.capturePlaceholder=log|placeholder|off}
 * <ul>
 * <li>{@code placeholder}（默认）：裁决为占位时把占位几何写进产物；</li>
 * <li>{@code log}：照常裁决并记账，但<strong>不</strong>落占位几何——需要先量一轮、人眼确认清单时用；</li>
 * <li>{@code off}：完全旧行为（0 产出 ⇒ 空气），不裁决、不记账、不记日志。</li>
 * </ul>
 */
@SideOnly(Side.CLIENT)
public final class ZeroProduceReport {

    /** 同一原因每会话最多打印的 WARN 条数。 */
    public static final int MAX_WARN_PER_REASON = 20;

    /** 开关属性名。 */
    public static final String MODE_PROPERTY = "sde.capturePlaceholder";

    /** 开关取值。 */
    public enum Mode {

        /** 只裁决与记账，不落占位几何。 */
        LOG,
        /** 落占位几何。 */
        PLACEHOLDER,
        /** 完全旧行为。 */
        OFF;

        /** 读出开关（默认 {@link #PLACEHOLDER}）；未知取值按默认处理并留一条日志。 */
        public static Mode current() {
            String raw = null;
            try {
                raw = System.getProperty(MODE_PROPERTY);
            } catch (Throwable ignored) {
                // 受限安全管理器：用默认值
            }
            return parse(raw);
        }

        /** 解析开关取值；空白/缺失 ⇒ {@link #PLACEHOLDER}，未知取值 ⇒ {@link #PLACEHOLDER}（并留一条日志）。 */
        public static Mode parse(String raw) {
            if (raw == null || raw.trim()
                .isEmpty()) {
                return PLACEHOLDER;
            }
            String v = raw.trim()
                .toLowerCase(Locale.ROOT);
            if ("log".equals(v)) {
                return LOG;
            }
            if ("placeholder".equals(v)) {
                return PLACEHOLDER;
            }
            if ("off".equals(v)) {
                return OFF;
            }
            logWarn("[SDE][capture] 未知的 %s=%s，按 placeholder 处理", MODE_PROPERTY, raw);
            return PLACEHOLDER;
        }

        /** 是否需要跑零产出裁决（{@code off} 直接保持旧行为）。 */
        public boolean evaluatesPolicies() {
            return this != OFF;
        }

        /** 是否可以把占位几何写进产物。 */
        public boolean placesGeometry() {
            return this == PLACEHOLDER;
        }
    }

    private static final Object LOCK = new Object();

    private static int placeholderCells;
    private static int declaredEmptyCells;
    private static int foldedWarnings;
    private static final Map<String, Integer> cellsByReason = new LinkedHashMap<String, Integer>();
    private static final Map<String, Integer> warningsByReason = new LinkedHashMap<String, Integer>();

    private ZeroProduceReport() {}

    /** 会话开始：清零。 */
    public static void beginSession() {
        synchronized (LOCK) {
            resetLocked();
        }
    }

    /** 单测专用：清零（与 {@link #beginSession()} 同义，名字表明用途）。 */
    public static void resetForTesting() {
        beginSession();
    }

    /**
     * 记一格零产出：计数 + 一行 WARN（同原因超限后折叠）。
     *
     * @param placed 这一格的占位几何是否<strong>真的</strong>写进了产物（测量模式为 false）
     */
    public static void record(ZeroProduceContext ctx, Decision decision, boolean placed) {
        if (ctx == null || decision == null) {
            return;
        }
        int issued;
        int fold;
        synchronized (LOCK) {
            if (decision.kind() == Decision.Kind.PLACEHOLDER) {
                placeholderCells++;
            } else {
                declaredEmptyCells++;
            }
            bump(cellsByReason, decision.reason());
            Integer already = warningsByReason.get(decision.reason());
            int count = already == null ? 0 : already.intValue();
            if (count < MAX_WARN_PER_REASON) {
                warningsByReason.put(decision.reason(), Integer.valueOf(count + 1));
                issued = count + 1;
                fold = -1;
            } else {
                foldedWarnings++;
                issued = -1;
                fold = foldedWarnings;
            }
        }
        if (issued > 0) {
            logWarn(
                "[SDE][capture] 零产出格 (%d,%d,%d) %s:%d 渲染器=%s 决策=%s 原因=%s 动作=%s（本会话该原因第 %d 条）",
                Integer.valueOf(ctx.worldX()),
                Integer.valueOf(ctx.worldY()),
                Integer.valueOf(ctx.worldZ()),
                String.valueOf(ctx.registryId()),
                Integer.valueOf(ctx.meta()),
                rendererName(ctx),
                decision.kind()
                    .name(),
                decision.reason(),
                placed ? "落占位" : "不落占位",
                Integer.valueOf(issued));
        } else if (fold > 0) {
            logWarn(
                "[SDE][capture] 零产出格 (%d,%d,%d) %s:%d 原因=%s 的本会话 WARN 已达上限 %d 条，后续只计数（累计折叠 %d 条）",
                Integer.valueOf(ctx.worldX()),
                Integer.valueOf(ctx.worldY()),
                Integer.valueOf(ctx.worldZ()),
                String.valueOf(ctx.registryId()),
                Integer.valueOf(ctx.meta()),
                decision.reason(),
                Integer.valueOf(MAX_WARN_PER_REASON),
                Integer.valueOf(fold));
        }
    }

    public static int placeholderCells() {
        synchronized (LOCK) {
            return placeholderCells;
        }
    }

    public static int declaredEmptyCells() {
        synchronized (LOCK) {
            return declaredEmptyCells;
        }
    }

    public static int foldedWarnings() {
        synchronized (LOCK) {
            return foldedWarnings;
        }
    }

    /**
     * 组装导出件根部的 {@code captureStats}。
     *
     * @param cellsWithBlock 本结构里"扫描身份非空气"的格数
     * @param bakedCells     <strong>真的</strong>烘出几何、且不是占位的格数（占位格单列在 {@code placeholderCells}）
     * @param channels       逐格几何来源计数（键由捕获侧给出，例如 {@code BLOCK}/{@code TESR}/{@code NONE}）
     */
    public static JsonObject toCaptureStats(int cellsWithBlock, int bakedCells, Map<String, Integer> channels) {
        int placeholders;
        int declaredEmpty;
        synchronized (LOCK) {
            placeholders = placeholderCells;
            declaredEmpty = declaredEmptyCells;
        }
        int lost = cellsWithBlock - bakedCells - placeholders - declaredEmpty;
        // 结构性不变式：每一格 0 产出都必须进三条路之一，故 lost 由构造为 0。
        // 测量模式（只记日志不落占位）下占位格没有几何，但它仍计入 placeholderCells，因此不变式与模式无关。
        // 若这里出现非 0，说明记账有漏（不是"世界里的块丢了"）——如实写出来，不静默夹紧成 0 假装没事。
        JsonObject stats = new JsonObject();
        stats.addProperty("cellsWithBlock", Integer.valueOf(cellsWithBlock));
        stats.addProperty("bakedCells", Integer.valueOf(bakedCells));
        stats.addProperty("placeholderCells", Integer.valueOf(placeholders));
        stats.addProperty("declaredEmptyCells", Integer.valueOf(declaredEmpty));
        stats.addProperty("lostCells", Integer.valueOf(lost));
        JsonObject channelJson = new JsonObject();
        if (channels != null) {
            for (Map.Entry<String, Integer> e : channels.entrySet()) {
                channelJson.addProperty(e.getKey(), e.getValue());
            }
        }
        stats.add("channels", channelJson);
        return stats;
    }

    /** 每会话一条汇总 INFO。 */
    public static void logSummary(int cellsWithBlock, int bakedCells, Mode mode) {
        int placeholders;
        int declaredEmpty;
        int folded;
        synchronized (LOCK) {
            placeholders = placeholderCells;
            declaredEmpty = declaredEmptyCells;
            folded = foldedWarnings;
        }
        int lost = cellsWithBlock - bakedCells - placeholders - declaredEmpty;
        logInfo(
            "[SDE][capture] 逐格捕获汇总：有方块=%d 已烘焙=%d 占位=%d 合法空=%d 丢失=%d；模式=%s；折叠告警=%d",
            Integer.valueOf(cellsWithBlock),
            Integer.valueOf(bakedCells),
            Integer.valueOf(placeholders),
            Integer.valueOf(declaredEmpty),
            Integer.valueOf(lost),
            mode != null ? mode.name() : "UNKNOWN",
            Integer.valueOf(folded));
    }

    private static String rendererName(ZeroProduceContext ctx) {
        TileEntity te = ctx.tileEntity();
        return te != null ? te.getClass()
            .getName() : "(no_tile_entity)";
    }

    private static void bump(Map<String, Integer> map, String key) {
        Integer current = map.get(key);
        map.put(key, Integer.valueOf(current == null ? 1 : current.intValue() + 1));
    }

    private static void resetLocked() {
        placeholderCells = 0;
        declaredEmptyCells = 0;
        foldedWarnings = 0;
        cellsByReason.clear();
        warningsByReason.clear();
    }

    private static void logWarn(String format, Object... args) {
        try {
            FMLLog.warning(format, args);
        } catch (Throwable ignored) {
            // 非 FML 环境（纯 JVM 单测）：日志通道不可用
        }
    }

    private static void logInfo(String format, Object... args) {
        try {
            FMLLog.info(format, args);
        } catch (Throwable ignored) {
            // 非 FML 环境（纯 JVM 单测）：日志通道不可用
        }
    }
}
