package com.lightning.mod.client.multiblock;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

/**
 * T1.4 因子化编码器 —— 需求 C（结构性压缩）的本体。
 * <p>
 * 契约：{@code docs/plan/format-multiblock-doc.md}。输入 = T1.3 的变体几何数据集（内存模型），
 * 输出 = 契约 inner body（{@code multiblock} + 根级并集 {@code blockPalette} + {@code frames}）。
 * <p>
 * <b>为什么落在 Java 侧</b>：T1.5 的 {@code /sde multiblock} 在游戏内实时调用本类（数据来自
 * {@code VariantCaptureRunner} 的内存变体集合 + {@code GeometryPalette} 的并集调色板），
 * 故编码逻辑必须在 mod 侧；离线 Node 工具只承担<b>闭环验证</b>（用参考装配器复算）。
 * 本类<b>零 MC 依赖</b>（只用 Gson + JDK），因此既能在客户端跑，也能被离线驱动直接调用。
 * <p>
 * <b>编码算法</b>（对应计划 T1.4 硬约束）：
 * <ol>
 * <li><b>尺寸型通道定骨架阶</b>：按变体网格尺寸 + 尺寸通道有效值聚类 → {@code backbone.sizeSteps}；
 * 阶数恒等于尺寸通道域长度；每阶 {@code cellGrid} 只放"所有变体都不变"的格子（替换型/运行态位置写 0 = 空）。</li>
 * <li><b>逐位置依赖分类</b>：对每个格位置枚举候选键（≤1 条替换型通道 × {总 Tier, 运行态} 的幂集），
 * 取"帧分区最少 → 帧轴最少 → 键最小"的<b>精确键</b>；由此把位置分成常量组 / 单通道组 / 运行态组 / 等级组。
 * 快路径无解时（同一格的取值同时依赖 ≥2 条替换型通道 = 通道作用域相交）回退到
 * <b>多通道键 + guard 消歧规则组</b>（契约 §4.5.3）：{@code channels[0]} 仍走 {@code indexTable}，
 * 其余通道落 {@code guard.clauses} 的等值条件，帧只引用 guard 成立的规则。</li>
 * <li><b>规则只存一份</b>：同键同查表的位置集合合成一条规则（{@code fill} 的矩形分解 + 逐层坐标），
 * frame 只按 id 引用。</li>
 * <li><b>系统性替换</b>：单通道依赖走 {@code indexTable} 查表；调色板剪枝后的<b>重编号</b>走
 * {@code indexAliases}（旧下标 → 新下标整表批量替换，契约 §4.5.2 明文列出的用途）。</li>
 * <li><b>不丢变体</b>：输入多少变体就声明多少变体 + 每变体一帧。</li>
 * </ol>
 * <p>
 * <b>失败即失败</b>：任何无法表达的位置依赖、尺寸阶与域长度不符、通道 id 重复等一律抛
 * {@link FactorizeException}（带可定位原因），绝不静默降级（契约 §13.1.7）。
 */
public final class MultiblockFactorizer {

    /** 尺寸型通道的候选上限（契约 §4.6：本轮只允许一个骨架通道）。 */
    public static final int MAX_SIZE_CHANNELS = 1;

    public static final String PALETTE_RENUMBER_RULE_ID = "palette.renumber";

    // -----------------------------------------------------------------------
    // 输入模型（T1.5 直接复用：把 VariantCaptureRunner 的内存变体集合喂进来即可）
    // -----------------------------------------------------------------------

    /** 通道声明（T1.3 {@code machines/<slug>.json#channels[]} 的口径）。 */
    public static final class ChannelIn {

        /** GTStructureChannels 枚举名（可为 null = 非枚举通道）。 */
        public String enumName;
        public String id;
        public String key;
        /** 呈现名（UI 标签）—— T1.3 取枚举名（T0.4 §5.2）。 */
        public String name;
        /** {@code "replace"} | {@code "dimension"}（尺寸型） | {@code "hatch"}。 */
        public String kind = "replace";
        /** 有效取值上界（T1.3 {@code max}）。 */
        public int max = 1;
        /** 仅尺寸型：值 1 对应的尺寸（T1.3 {@code min}，语义与契约 min 不同）。 */
        public Integer dimensionAtMin;
        /** T1.3 {@code domain.max}（缺省 = {@code max}）。 */
        public Integer domainMax;
        public String domainSource;
        /** 数据集里的 valueSemantics（诊断用）。 */
        public String valueSemantics;
        /** 子集重编码时域被覆盖（此时 T1.3 的 effective 不再是本域的 oracle，跳过交叉校验）。 */
        public boolean subsetOverridden;
        /** 收窄前该通道的真实域上界（T1.5 抽样时数据集会写；缺省 = null = 未收窄）。 */
        public Integer trueDomainMax;
    }

    public static final class RunstateIn {

        public String id;
        public String name;
        public boolean materialSwap;
    }

    public static final class VariantIn {

        /** 契约 §5.1 主键（T1.3 已按同一规则派生）。 */
        public String key;
        public int totalTier;
        /** 每通道声明值（0 = 未设置）。 */
        public final Map<String, Integer> values = new LinkedHashMap<String, Integer>();
        /** T1.3 解析出的有效值 —— 用于交叉校验本类的 RESOLVE 实现（契约 §5.2）。 */
        public final Map<String, Integer> effectiveCrossCheck = new LinkedHashMap<String, Integer>();
        public String runstate;
        /** {@code [z][y][x]}，值为全局并集调色板下标（0 = air）。 */
        public int[][][] cellGrid;
    }

    /** 一台多方块的完整输入。 */
    public static final class MachineIn {

        public String id;
        public String displayName;
        public String sourceClass;
        public final List<ChannelIn> channels = new ArrayList<ChannelIn>();
        public int ttMin = 1;
        public int ttMax = 1;
        public int ttDefault = 1;
        public String ttSource = "probed";
        public final List<Integer> tierSample = new ArrayList<Integer>();
        public final List<RunstateIn> runstates = new ArrayList<RunstateIn>();
        public final List<VariantIn> variants = new ArrayList<VariantIn>();
        /** 全局并集调色板（含 air@0）—— 本类按机剪枝 + 重编号。 */
        public JsonArray palette;
        public JsonArray materialPalette;
        public JsonArray textureBlobs;
        public JsonArray tooltipPalette;
        /** 数据集来源（写进 notes，可追溯）。 */
        public String datasetSource = "";
        /** 数据集里的机器 slug（`machines/<slug>.json`），供闭环验证定位 ground-truth。 */
        public String sourceSlug = "";
        public String paletteSource = "union-all-variants";
        public String geometryEncoding = "bakedQuadsJsonV1";
        /** 额外软约束说明（原样进 {@code multiblock.notes}）。 */
        public final List<JsonObject> extraNotes = new ArrayList<JsonObject>();
        /**
         * 调色板重编号是否走 {@code indexAliases} 规则（默认 true，契约 §4.5.2 的"旧下标 → 新下标"批量替换）。
         * false = 骨架直接按剪枝后下标落盘、不生成重编号规则（体积对照用，见 T1.4 报告）。
         */
        public boolean paletteRenumberViaAliases = true;
    }

    /** 编码结果。 */
    public static final class Result {

        /** 契约 inner body。 */
        public JsonObject innerBody;
        /** 编码统计（体积 / 规则分布 / 剪枝 / 闭环自检所需数字）。 */
        public JsonObject stats;

        public Result(JsonObject innerBody, JsonObject stats) {
            this.innerBody = innerBody;
            this.stats = stats;
        }
    }

    /** 编码失败（带可定位原因，绝不静默降级）。 */
    public static final class FactorizeException extends RuntimeException {

        private static final long serialVersionUID = 1L;

        public FactorizeException(String message) {
            super(message);
        }
    }

    // -----------------------------------------------------------------------
    // 内部状态
    // -----------------------------------------------------------------------

    /**
     * 候选键：若干条替换型通道（升序下标）+ 可选的 (总 Tier, 运行态)。
     * <p>
     * 快路径只用「≤1 条通道」的键（与 T1.4 完全同构，保证既有机器产物逐字节不变）；
     * 只有当某位置的取值同时依赖 ≥2 条替换型通道（通道作用域相交，T0.4 记录的
     * {@code MTELapotronicSuperCapacitor} 型例外）时才回退到多通道键，并按契约 §4.5.3
     * 生成带 {@code guard} 的规则组（见 {@link #findGuardKey}）。
     */
    private static final class DepKey {

        /** 升序通道下标；空 = 不依赖通道。{@code channels[0]} = 查表通道（indexTable），其余 = guard 通道。 */
        final List<Integer> channels = new ArrayList<Integer>();
        boolean withTt;
        boolean withRs;

        int frameAxes() {
            return (withTt ? 1 : 0) + (withRs ? 1 : 0);
        }

        /** guard 通道数（= 通道数 − 1）；>0 表示本键需要 guard 消歧。 */
        int leadCount() {
            return Math.max(0, channels.size() - 1);
        }

        boolean needsGuard() {
            return leadCount() > 0;
        }

        @Override
        public String toString() {
            return "chans=" + channels + ",tt=" + withTt + ",rs=" + withRs;
        }
    }

    /**
     * 一个帧轴元组（总 Tier / 运行态 / guard 通道有效取值）。
     * <p>
     * {@code lead*} 只对多通道键非空，长度 = {@code key.leadCount()}：它决定该规则组的
     * {@code guard.clauses}，并进入 {@link #toString()}（因此规则 id 唯一）。
     */
    private static final class FrameTuple {

        int tt;
        String rs; // null = 不区分
        /** guard 通道在 {@link #replaceChannels} 里的下标。 */
        int[] leadChannels = new int[0];
        /** 与 {@link #leadChannels} 对齐的有效取值。 */
        int[] leadValues = new int[0];

        @Override
        public String toString() {
            StringBuilder sb = new StringBuilder();
            if (rs != null) sb.append(rs);
            if (tt > 0) {
                if (sb.length() > 0) sb.append('.');
                sb.append("tt")
                    .append(tt);
            }
            for (int i = 0; i < leadChannels.length; i++) {
                if (sb.length() > 0) sb.append('.');
                sb.append('g')
                    .append(leadChannels[i])
                    .append('v')
                    .append(leadValues[i]);
            }
            return sb.length() == 0 ? "all" : sb.toString();
        }
    }

    /** 同一 (键, 查表内容) 的位置集合 = 一组共享规则的格子。 */
    private static final class PositionGroup {

        DepKey key;
        final List<FrameTuple> tuples = new ArrayList<FrameTuple>();
        /** 与 {@link #tuples} 一一对应：有通道时 = eff → 下标（表长 = 域长），否则长度 1 的常量。 */
        final List<int[]> tables = new ArrayList<int[]>();
        final List<int[]> positions = new ArrayList<int[]>();
    }

    private static final class StepInfo {

        int stepIndex;
        int w;
        int h;
        int d;
        final List<VariantIn> variants = new ArrayList<VariantIn>();
        final List<Map<String, Integer>> effective = new ArrayList<Map<String, Integer>>();
        int[][][] skeleton;
        boolean[] varying;
        final List<PositionGroup> groups = new ArrayList<PositionGroup>();
        int constCells;
        int varyingCells;
        int rectCount;
    }

    private static final class RuleRef {

        String id;
        int stepIndex;
        boolean withTt;
        int tt;
        boolean withRs;
        String rs;
        /** guard 通道下标（与 {@link #guardValues} 对齐）；空 = 无 guard。 */
        int[] guardChannels = new int[0];
        int[] guardValues = new int[0];
    }

    private final MachineIn in;
    private final List<ChannelIn> replaceChannels = new ArrayList<ChannelIn>();
    private final List<ChannelIn> sizeChannels = new ArrayList<ChannelIn>();
    private final List<ChannelIn> hatchChannels = new ArrayList<ChannelIn>();
    private final List<StepInfo> steps = new ArrayList<StepInfo>();
    private final JsonArray prunedPalette = new JsonArray();
    private final LinkedHashMap<Integer, Integer> aliases = new LinkedHashMap<Integer, Integer>();
    private final List<JsonObject> rules = new ArrayList<JsonObject>();
    private final List<RuleRef> ruleRefs = new ArrayList<RuleRef>();
    /** 变体键 → 契约 §5.2 的有效取值（guard 通道的帧引用过滤要用）。 */
    private final Map<String, Map<String, Integer>> effectiveByVariantKey = new LinkedHashMap<String, Map<String, Integer>>();
    private int tableGapFills;
    private int sizeEffectiveMismatch;
    /** 需要 guard 消歧的位置数（>0 ⇒ 文档标 {@code hasScopeOverlap:true}）。 */
    private int guardPositions;
    /** 生成的 guard 规则条数。 */
    private int guardRules;
    /** 多通道相交的位置按「哪几条通道相交」聚合的诊断计数。 */
    private final TreeMap<String, Integer> guardKeyHistogram = new TreeMap<String, Integer>();
    /** 同一聚合下的样例位置（最多 3 个/组合），供 {@code scopeOverlapNote} 指明是哪片区域。 */
    private final TreeMap<String, List<String>> guardKeyExamples = new TreeMap<String, List<String>>();

    private ChannelIn channelByKey(String key) {
        for (ChannelIn c : in.channels) {
            if (c.key.equals(key)) return c;
        }
        return null;
    }

    private MultiblockFactorizer(MachineIn in) {
        this.in = in;
    }

    // -----------------------------------------------------------------------
    // 入口
    // -----------------------------------------------------------------------

    public static Result factorize(MachineIn in) {
        return new MultiblockFactorizer(in).run();
    }

    private Result run() {
        classifyChannels();
        List<Map<String, Integer>> effectiveByVariant = resolveAll();
        for (int i = 0; i < in.variants.size(); i++) {
            effectiveByVariantKey.put(in.variants.get(i).key, effectiveByVariant.get(i));
        }
        buildSteps(effectiveByVariant);
        prunePalette();
        for (StepInfo si : steps) classifyStep(si);
        emitPaletteRenumberRule();
        JsonArray frames = buildFrames();
        JsonObject inner = buildInnerBody(frames);
        return result(inner, frames);
    }

    // -----------------------------------------------------------------------
    // 1. 通道清单
    // -----------------------------------------------------------------------

    private void classifyChannels() {
        TreeSet<String> ids = new TreeSet<String>();
        TreeSet<String> keys = new TreeSet<String>();
        for (ChannelIn c : in.channels) {
            if (c.key == null || c.key.isEmpty()) throw new FactorizeException("通道缺 key: " + c.id);
            if (!keys.add(c.key)) throw new FactorizeException("通道 key 重复: " + c.key + "（契约 §4.2）");
            if (c.id != null && !ids.add(c.id)) {
                throw new FactorizeException("同一多方块内通道 id 重复: " + c.id + "（契约 §4.2 规则 3：导出必须失败，不得静默改名）");
            }
            String kind = c.kind == null ? "replace" : c.kind;
            if ("dimension".equals(kind) || "size".equals(kind)) {
                sizeChannels.add(c);
            } else if ("hatch".equals(kind)) {
                hatchChannels.add(c);
            } else if ("replace".equals(kind)) {
                replaceChannels.add(c);
            } else {
                throw new FactorizeException("通道 " + c.key + " 的 kind 非法: " + c.kind);
            }
        }
        if (sizeChannels.size() > MAX_SIZE_CHANNELS) {
            throw new FactorizeException(
                "本文档有 " + sizeChannels.size()
                    + " 条尺寸型通道，超过契约 §4.6 的上限 "
                    + MAX_SIZE_CHANNELS
                    + "（多尺寸轴会让 sizeSteps 退化成笛卡尔积 = 组合展开）");
        }
    }

    /** 尺寸通道的契约 min（有效取值下界）。 */
    private static int contractSizeMin(ChannelIn c) {
        return 1;
    }

    private int domainMaxOf(ChannelIn c) {
        if (c.domainMax != null) return Math.max(c.domainMax, 0);
        return Math.max(c.max, 0);
    }

    // -----------------------------------------------------------------------
    // 2. 取值解析（契约 §5.2；与 T1.3 的 effective 交叉校验）
    // -----------------------------------------------------------------------

    private List<Map<String, Integer>> resolveAll() {
        List<Map<String, Integer>> out = new ArrayList<Map<String, Integer>>();
        for (VariantIn v : in.variants) {
            int tt = v.totalTier;
            if (tt < in.ttMin) tt = in.ttMin;
            if (tt > in.ttMax) tt = in.ttMax;
            Map<String, Integer> eff = new LinkedHashMap<String, Integer>();
            for (ChannelIn c : in.channels) {
                Integer rawBoxed = v.values.get(c.key);
                int raw = rawBoxed == null ? 0 : rawBoxed.intValue();
                int value = raw > 0 ? raw : tt;
                int lo = sizeChannels.contains(c) ? contractSizeMin(c) : 0;
                int hi = domainMaxOf(c);
                if (hi < lo) hi = lo;
                if (value < lo) value = lo;
                if (value > hi) value = hi;
                eff.put(c.key, Integer.valueOf(value));
            }
            for (Map.Entry<String, Integer> e : v.effectiveCrossCheck.entrySet()) {
                Integer mine = eff.get(e.getKey());
                if (mine == null || mine.equals(e.getValue())) continue;
                ChannelIn c = channelByKey(e.getKey());
                if (c != null && c.subsetOverridden) continue;
                if (c != null && sizeChannels.contains(c)) {
                    // T1.3 的 `effective` 对尺寸型通道记的是「按 getValueClamped 的**尺寸**下界夹取后的值」
                    // （min=值 1 对应的尺寸），既没有 1 基偏移也不是通道取值；真实尺寸由网格本身给出。
                    // 故尺寸型通道不做严格交叉校验，只计数（见 stats.sizeEffectiveFieldMismatch）。
                    sizeEffectiveMismatch++;
                    continue;
                }
                throw new FactorizeException(
                    "取值解析与 T1.3 effective 不一致：变体 " + v.key
                        + " 通道 "
                        + e.getKey()
                        + " 本实现="
                        + mine
                        + " T1.3="
                        + e.getValue()
                        + "（契约 §5.2 RESOLVE 实现有分歧）");
            }
            out.add(eff);
        }
        return out;
    }

    // -----------------------------------------------------------------------
    // 3. 骨架阶（尺寸型 → 骨干）
    // -----------------------------------------------------------------------

    private void buildSteps(List<Map<String, Integer>> effectiveByVariant) {
        ChannelIn sizeCh = sizeChannels.isEmpty() ? null : sizeChannels.get(0);
        int expectedSteps = sizeCh == null ? 1 : (domainMaxOf(sizeCh) - contractSizeMin(sizeCh) + 1);
        if (expectedSteps <= 0) expectedSteps = 1;

        Map<Integer, StepInfo> byStep = new TreeMap<Integer, StepInfo>();
        for (int i = 0; i < in.variants.size(); i++) {
            VariantIn v = in.variants.get(i);
            Map<String, Integer> eff = effectiveByVariant.get(i);
            int stepIndex = 0;
            if (sizeCh != null) {
                int value = eff.get(sizeCh.key)
                    .intValue();
                stepIndex = value - contractSizeMin(sizeCh);
                if (stepIndex < 0) stepIndex = 0;
                if (stepIndex >= expectedSteps) stepIndex = expectedSteps - 1;
            }
            int[] dims = dimsOf(v);
            StepInfo si = byStep.get(Integer.valueOf(stepIndex));
            if (si == null) {
                si = new StepInfo();
                si.stepIndex = stepIndex;
                si.w = dims[0];
                si.h = dims[1];
                si.d = dims[2];
                byStep.put(Integer.valueOf(stepIndex), si);
            } else if (si.w != dims[0] || si.h != dims[1] || si.d != dims[2]) {
                throw new FactorizeException(
                    "同一骨架阶 " + stepIndex
                        + " 内出现两种尺寸：["
                        + si.w
                        + ","
                        + si.h
                        + ","
                        + si.d
                        + "] 与 ["
                        + dims[0]
                        + ","
                        + dims[1]
                        + ","
                        + dims[2]
                        + "]（变体 "
                        + v.key
                        + "）；尺寸型通道定阶的假设不成立");
            }
            si.variants.add(v);
            si.effective.add(eff);
        }
        if (byStep.size() != expectedSteps) {
            throw new FactorizeException(
                "骨架阶数 " + byStep.size()
                    + " ≠ 尺寸通道域长度 "
                    + expectedSteps
                    + "（契约 §4.4：阶数必须 = max − min + 1；数据集未覆盖某个有效取值 = 无法无损编码）");
        }
        TreeSet<String> dimSet = new TreeSet<String>();
        for (StepInfo si : byStep.values()) {
            String k = si.w + "x" + si.h + "x" + si.d;
            if (!dimSet.add(k)) {
                throw new FactorizeException("两个不同骨架阶的尺寸相同（" + k + "）：sizeSteps 无法区分，契约 §4.4 的阶语义不成立");
            }
        }
        for (int k = 0; k < expectedSteps; k++) {
            StepInfo si = byStep.get(Integer.valueOf(k));
            if (si == null) throw new FactorizeException("骨架阶 " + k + " 缺变体");
            steps.add(si);
        }
        TreeSet<String> keys = new TreeSet<String>();
        for (VariantIn v : in.variants) {
            if (!keys.add(v.key)) throw new FactorizeException("变体键重复：" + v.key);
        }
    }

    private static int[] dimsOf(VariantIn v) {
        int[][][] g = v.cellGrid;
        int d = g.length;
        int h = d == 0 ? 0 : g[0].length;
        int w = h == 0 ? 0 : g[0][0].length;
        for (int z = 0; z < d; z++) {
            if (g[z].length != h) {
                throw new FactorizeException("变体 " + v.key + " 的 cellGrid 非长方体（z=" + z + " 行数不一致）");
            }
            for (int y = 0; y < h; y++) {
                if (g[z][y].length != w) {
                    throw new FactorizeException("变体 " + v.key + " 的 cellGrid 非长方体（z=" + z + ",y=" + y + " 列数不一致）");
                }
            }
        }
        return new int[] { w, h, d };
    }

    // -----------------------------------------------------------------------
    // 4. 调色板剪枝 + 重编号（契约 §6.1 / §4.5.2）
    // -----------------------------------------------------------------------

    private void prunePalette() {
        JsonArray global = in.palette;
        if (global == null || global.size() == 0) throw new FactorizeException("缺少并集调色板（palette.json）");
        if (!isAir(global.get(0))) throw new FactorizeException("blockPalette[0] 必须是 air（契约 §6.1 第 2 条）");
        TreeSet<Integer> used = new TreeSet<Integer>();
        for (VariantIn v : in.variants) {
            for (int z = 0; z < v.cellGrid.length; z++) {
                for (int y = 0; y < v.cellGrid[z].length; y++) {
                    for (int x = 0; x < v.cellGrid[z][y].length; x++) {
                        int value = v.cellGrid[z][y][x];
                        if (value < 0 || value >= global.size()) {
                            throw new FactorizeException(
                                "变体 " + v.key + " 的网格含越界调色板下标 " + value + "（调色板长度 " + global.size() + "）");
                        }
                        used.add(Integer.valueOf(value));
                    }
                }
            }
        }
        prunedPalette.add(global.get(0));
        aliases.put(Integer.valueOf(0), Integer.valueOf(0));
        int next = 1;
        for (int i = 1; i < global.size(); i++) {
            if (!used.contains(Integer.valueOf(i))) continue;
            prunedPalette.add(global.get(i));
            aliases.put(Integer.valueOf(i), Integer.valueOf(next++));
        }
    }

    private static boolean isAir(JsonElement e) {
        if (!e.isJsonObject()) return false;
        JsonElement rid = e.getAsJsonObject()
            .get("registryId");
        return rid != null && rid.isJsonPrimitive() && "air".equals(rid.getAsString());
    }

    // -----------------------------------------------------------------------
    // 5. 逐阶：位置分类 → 分组 → 规则
    // -----------------------------------------------------------------------

    private void classifyStep(StepInfo si) {
        int w = si.w;
        int h = si.h;
        int d = si.d;
        int cells = w * h * d;
        int n = si.variants.size();
        if (n == 0) throw new FactorizeException("骨架阶 " + si.stepIndex + " 没有变体");

        int[][] values = new int[cells][n];
        for (int i = 0; i < n; i++) {
            int[][][] g = si.variants.get(i).cellGrid;
            for (int z = 0; z < d; z++) {
                for (int y = 0; y < h; y++) {
                    for (int x = 0; x < w; x++) {
                        values[idx(x, y, z, w, h)][i] = g[z][y][x];
                    }
                }
            }
        }

        List<DepKey> candidates = new ArrayList<DepKey>();
        for (int ci = -1; ci < replaceChannels.size(); ci++) {
            for (int flags = 0; flags < 4; flags++) {
                DepKey k = new DepKey();
                if (ci >= 0) k.channels.add(Integer.valueOf(ci));
                k.withTt = (flags & 1) != 0;
                k.withRs = (flags & 2) != 0;
                candidates.add(k);
            }
        }

        si.skeleton = new int[d][h][w];
        si.varying = new boolean[cells];
        Map<String, PositionGroup> groups = new LinkedHashMap<String, PositionGroup>();
        int constCells = 0;
        int varyingCells = 0;

        for (int z = 0; z < d; z++) {
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    int c = idx(x, y, z, w, h);
                    DepKey best = null;
                    int bestTuples = Integer.MAX_VALUE;
                    int bestAxes = Integer.MAX_VALUE;
                    for (int ci = 0; ci < candidates.size(); ci++) {
                        DepKey k = candidates.get(ci);
                        int tuples = exactTuples(si, values[c], k);
                        if (tuples < 0) continue;
                        int axes = k.frameAxes();
                        if (best == null || tuples < bestTuples
                            || (tuples == bestTuples && axes < bestAxes)
                            || (tuples == bestTuples && axes == bestAxes && orderOf(k) < orderOf(best))) {
                            best = k;
                            bestTuples = tuples;
                            bestAxes = axes;
                        }
                    }
                    if (best == null) {
                        // 多通道作用域相交（T0.4 记录的例外机）：快路径只覆盖「≤1 条替换型通道」，
                        // 此处按契约 §4.5.3 回退到「多通道键 + guard 消歧规则组」。
                        best = findGuardKey(si, values[c]);
                        if (best != null) {
                            guardPositions++;
                            String histKey = guardKeyLabel(best);
                            Integer prev = guardKeyHistogram.get(histKey);
                            guardKeyHistogram.put(histKey, Integer.valueOf(prev == null ? 1 : prev.intValue() + 1));
                            List<String> ex = guardKeyExamples.get(histKey);
                            if (ex == null) {
                                ex = new ArrayList<String>();
                                guardKeyExamples.put(histKey, ex);
                            }
                            if (ex.size() < 3) {
                                ex.add(si.stepIndex + ":(" + x + "," + y + "," + z + ")");
                            }
                        }
                    }
                    if (best == null) {
                        throw new FactorizeException(
                            "位置 (" + x
                                + ","
                                + y
                                + ","
                                + z
                                + ") 在骨架阶 "
                                + si.stepIndex
                                + " 上的取值无法表达：即使取「全部替换型通道 + 总 Tier + 运行态」的完整键也不是精确键"
                                + "（同一有效取值元组上出现两个不同值 —— 契约 §5.2 的有效值语义无法区分它们）");
                    }
                    if (best.channels.isEmpty() && !best.withTt && !best.withRs) {
                        si.skeleton[z][y][x] = values[c][0];
                        constCells++;
                        continue;
                    }
                    varyingCells++;
                    si.varying[c] = true;
                    PositionGroup pg = buildGroup(si, best, values[c]);
                    String sig = signatureOf(pg);
                    PositionGroup shared = groups.get(sig);
                    if (shared == null) {
                        groups.put(sig, pg);
                        si.groups.add(pg);
                        shared = pg;
                    }
                    shared.positions.add(new int[] { x, y, z });
                }
            }
        }
        si.constCells = constCells;
        si.varyingCells = varyingCells;

        for (int gi = 0; gi < si.groups.size(); gi++) {
            PositionGroup pg = si.groups.get(gi);
            List<JsonObject> rects = rectangles(pg.positions, w, h, d);
            si.rectCount += rects.size();
            ChannelIn tableCh = tableChannelOf(pg.key);
            for (int ti = 0; ti < pg.tuples.size(); ti++) {
                FrameTuple t = pg.tuples.get(ti);
                int[] table = pg.tables.get(ti);
                for (int ri = 0; ri < rects.size(); ri++) {
                    JsonObject rule = new JsonObject();
                    String id = "r.s" + si.stepIndex
                        + ".g"
                        + gi
                        + ".r"
                        + ri
                        + ((pg.key.frameAxes() > 0 || pg.key.needsGuard()) ? "." + t.toString() : "");
                    rule.addProperty("id", id);
                    rule.addProperty("phase", pg.key.withRs ? "runstate" : "replace");
                    JsonObject guard = guardOf(pg.key, t);
                    if (guard != null) {
                        rule.add("guard", guard);
                        guardRules++;
                    }
                    if (tableCh != null) {
                        rule.addProperty("legend", pg.key.needsGuard() ? "channel.guard" : "channel.replace");
                        rule.addProperty("channel", tableCh.key);
                        rule.add("indexTable", prunedTable(table));
                    } else {
                        rule.addProperty("legend", pg.key.withTt ? "tier.overlay" : "runstate.overlay");
                        rule.addProperty("index", Integer.valueOf(pruned(table[0])));
                    }
                    addRect(rule, rects.get(ri), w, h, d);
                    rules.add(rule);
                    RuleRef ref = new RuleRef();
                    ref.id = id;
                    ref.stepIndex = si.stepIndex;
                    ref.withTt = pg.key.withTt;
                    ref.tt = t.tt;
                    ref.withRs = pg.key.withRs;
                    ref.rs = t.rs;
                    ref.guardChannels = t.leadChannels;
                    ref.guardValues = t.leadValues;
                    ruleRefs.add(ref);
                }
            }
        }
    }

    /** 查表通道（{@code channels[0]}）；无通道键返回 null。 */
    private ChannelIn tableChannelOf(DepKey k) {
        if (k.channels.isEmpty()) return null;
        return replaceChannels.get(
            k.channels.get(0)
                .intValue());
    }

    /** guard 通道的（枚举下标 → 该通道 key）标签，仅用于诊断直方图。 */
    private String guardKeyLabel(DepKey k) {
        StringBuilder sb = new StringBuilder();
        for (int i = 1; i < k.channels.size(); i++) {
            if (sb.length() > 0) sb.append('+');
            sb.append(
                replaceChannels.get(
                    k.channels.get(i)
                        .intValue()).key);
        }
        return sb.toString();
    }

    /** 多通道键的 guard：{@code clauses} 之间 AND，每条 = 一个 guard 通道的有效取值等于（契约 §4.5.3）。 */
    private JsonObject guardOf(DepKey k, FrameTuple t) {
        if (t.leadChannels.length == 0) return null;
        JsonObject guard = new JsonObject();
        JsonArray clauses = new JsonArray();
        for (int i = 0; i < t.leadChannels.length; i++) {
            JsonObject cl = new JsonObject();
            cl.addProperty("channel", replaceChannels.get(t.leadChannels[i]).key);
            cl.addProperty("value", Integer.valueOf(t.leadValues[i]));
            clauses.add(cl);
        }
        guard.add("clauses", clauses);
        return guard;
    }

    /**
     * 多通道相交的回退搜索：变量集 = 全部替换型通道 + (总 Tier, 运行态)。
     * <p>
     * 精确性是**单调**的（键更细 ⇒ 分组更小 ⇒ 不可能引入冲突），故从全集出发逐个尝试消去
     * （先 tt、再 rs、再通道按下标从大到小）得到的是<b>不可约</b>精确键 —— 确定性地最小化
     * 规则组划分。返回 null 表示连完整键都不精确（契约 §5.2 的有效值语义下不可无损编码）。
     */
    private DepKey findGuardKey(StepInfo si, int[] cellValues) {
        boolean[] use = new boolean[replaceChannels.size()];
        for (int i = 0; i < use.length; i++) use[i] = true;
        boolean withTt = true;
        boolean withRs = true;
        if (exactTuples(si, cellValues, keyOf(use, false, true)) >= 0) withTt = false;
        if (exactTuples(si, cellValues, keyOf(use, withTt, false)) >= 0) withRs = false;
        for (int ci = use.length - 1; ci >= 0; ci--) {
            use[ci] = false;
            if (exactTuples(si, cellValues, keyOf(use, withTt, withRs)) < 0) use[ci] = true;
        }
        DepKey k = keyOf(use, withTt, withRs);
        if (k.channels.size() < 2) return null;
        if (exactTuples(si, cellValues, k) < 0) return null;
        return k;
    }

    private static DepKey keyOf(boolean[] use, boolean withTt, boolean withRs) {
        DepKey k = new DepKey();
        for (int i = 0; i < use.length; i++) {
            if (use[i]) k.channels.add(Integer.valueOf(i));
        }
        k.withTt = withTt;
        k.withRs = withRs;
        return k;
    }

    private static int orderOf(DepKey k) {
        int first = k.channels.isEmpty() ? -1
            : k.channels.get(0)
                .intValue();
        return (first + 1) * 4 + (k.withTt ? 1 : 0) * 2 + (k.withRs ? 1 : 0);
    }

    /**
     * 全局（数据集）下标 → 本文档剪枝后的下标。
     * <p>
     * 骨架 {@code cellGrid} 保持**全局下标**，由 {@code palette.renumber} 规则（{@code indexAliases}）
     * 在装配期整表重编号；而规则写入的内容是**最终（剪枝后）下标** —— 两者相位不同：
     * renumber 在 {@code phase:"backbone"}（最先），内容规则在 replace/runstate，后写者胜（契约 §5.4）。
     */
    private int pruned(int globalIndex) {
        Integer p = aliases.get(Integer.valueOf(globalIndex));
        if (p == null) throw new FactorizeException("下标 " + globalIndex + " 不在本机并集调色板里，无法重编号");
        return p.intValue();
    }

    private JsonArray prunedTable(int[] table) {
        JsonArray a = new JsonArray();
        for (int i = 0; i < table.length; i++) a.add(new JsonPrimitive(Integer.valueOf(pruned(table[i]))));
        return a;
    }

    /** 键 K 在观测上的<b>不同元组数</b>；不精确（同一元组两个值）则返回 -1。 */
    private int exactTuples(StepInfo si, int[] cellValues, DepKey k) {
        if (k.channels.isEmpty()) return exactTuplesOf(si, cellValues, null, k);
        int[] idx = new int[k.channels.size()];
        for (int i = 0; i < idx.length; i++) {
            idx[i] = k.channels.get(i)
                .intValue();
            if (idx[i] >= replaceChannels.size()) return -1;
        }
        return exactTuplesOf(si, cellValues, idx, k);
    }

    private int exactTuplesOf(StepInfo si, int[] cellValues, int[] channelIdx, DepKey k) {
        LinkedHashMap<String, Integer> seen = new LinkedHashMap<String, Integer>();
        for (int i = 0; i < si.variants.size(); i++) {
            VariantIn v = si.variants.get(i);
            StringBuilder tb = new StringBuilder();
            if (k.withTt) tb.append(v.totalTier);
            tb.append('|');
            if (k.withRs) tb.append(v.runstate);
            tb.append('|');
            if (channelIdx != null) {
                Map<String, Integer> eff = si.effective.get(i);
                for (int j = 0; j < channelIdx.length; j++) {
                    tb.append(eff.get(replaceChannels.get(channelIdx[j]).key))
                        .append(',');
                }
            }
            String key = tb.toString();
            Integer prev = seen.get(key);
            if (prev != null && prev.intValue() != cellValues[i]) return -1;
            seen.put(key, Integer.valueOf(cellValues[i]));
        }
        return seen.size();
    }

    /**
     * 把一个位置在键 K 下的值整理成「帧轴元组 → 查表」：
     * 无通道时表长 1（常量）；有通道时表长 = {@code channels[0]} 的域长（下标 = 该通道有效取值），
     * 缺失档用最近观测档补齐（档 0 = "未设置"分支，契约 §6.2）。
     * 多通道键的元组额外带 guard 通道取值（契约 §4.5.3），表按元组分别建。
     */
    private PositionGroup buildGroup(StepInfo si, DepKey k, int[] cellValues) {
        PositionGroup pg = new PositionGroup();
        pg.key = k;
        ChannelIn ch = tableChannelOf(k);
        int[] leadIdx = new int[k.leadCount()];
        for (int i = 0; i < leadIdx.length; i++) {
            leadIdx[i] = k.channels.get(i + 1)
                .intValue();
        }
        int tableLen = ch == null ? 1 : (domainMaxOf(ch) + 1);
        TreeMap<String, FrameTuple> tuples = new TreeMap<String, FrameTuple>();
        for (int i = 0; i < si.variants.size(); i++) {
            VariantIn v = si.variants.get(i);
            FrameTuple t = tupleOf(si, i, k, leadIdx);
            tuples.put(t.toString(), t);
        }
        for (FrameTuple t : tuples.values()) {
            int[] table = new int[tableLen];
            boolean[] filled = new boolean[tableLen];
            for (int i = 0; i < si.variants.size(); i++) {
                VariantIn v = si.variants.get(i);
                if (k.withTt && v.totalTier != t.tt) continue;
                if (k.withRs && !v.runstate.equals(t.rs)) continue;
                if (!leadMatches(si, i, t)) continue;
                int slot = ch == null ? 0
                    : si.effective.get(i)
                        .get(ch.key)
                        .intValue();
                if (slot >= tableLen) slot = tableLen - 1;
                if (filled[slot] && table[slot] != cellValues[i]) {
                    throw new FactorizeException(
                        "内部不一致：位置查表在第 " + slot + " 档上出现两个值（" + table[slot] + " / " + cellValues[i] + "）");
                }
                table[slot] = cellValues[i];
                filled[slot] = true;
            }
            for (int s = 0; s < tableLen; s++) {
                if (filled[s]) continue;
                int found = -1;
                for (int q = s - 1; q >= 0; q--) {
                    if (filled[q]) {
                        found = q;
                        break;
                    }
                }
                if (found < 0) {
                    for (int q = s + 1; q < tableLen; q++) {
                        if (filled[q]) {
                            found = q;
                            break;
                        }
                    }
                }
                if (found < 0) throw new FactorizeException("位置查表第 " + s + " 档无任何观测值可补齐");
                table[s] = table[found];
                tableGapFills++;
            }
            pg.tuples.add(t);
            pg.tables.add(table);
        }
        return pg;
    }

    private FrameTuple tupleOf(StepInfo si, int variantIndex, DepKey k, int[] leadIdx) {
        VariantIn v = si.variants.get(variantIndex);
        FrameTuple t = new FrameTuple();
        t.tt = k.withTt ? v.totalTier : 0;
        t.rs = k.withRs ? v.runstate : null;
        t.leadChannels = leadIdx;
        t.leadValues = new int[leadIdx.length];
        Map<String, Integer> eff = si.effective.get(variantIndex);
        for (int j = 0; j < leadIdx.length; j++) {
            t.leadValues[j] = eff.get(replaceChannels.get(leadIdx[j]).key)
                .intValue();
        }
        return t;
    }

    /** 该变体是否落在元组 t 的 guard 条件下（guard 通道有效取值全等）。 */
    private boolean leadMatches(StepInfo si, int variantIndex, FrameTuple t) {
        if (t.leadChannels.length == 0) return true;
        Map<String, Integer> eff = si.effective.get(variantIndex);
        for (int j = 0; j < t.leadChannels.length; j++) {
            if (eff.get(replaceChannels.get(t.leadChannels[j]).key)
                .intValue() != t.leadValues[j]) return false;
        }
        return true;
    }

    private String signatureOf(PositionGroup pg) {
        StringBuilder sb = new StringBuilder();
        sb.append(pg.key.channels)
            .append('/')
            .append(pg.key.withTt)
            .append('/')
            .append(pg.key.withRs);
        for (int i = 0; i < pg.tuples.size(); i++) {
            sb.append('|')
                .append(
                    pg.tuples.get(i)
                        .toString())
                .append('=');
            int[] t = pg.tables.get(i);
            for (int j = 0; j < t.length; j++) {
                if (j > 0) sb.append(',');
                sb.append(t[j]);
            }
        }
        return sb.toString();
    }

    // -----------------------------------------------------------------------
    // 6. 矩形分解（fill 的 sel 语义，契约 §4.5.1）
    // -----------------------------------------------------------------------

    /** 一组位置 → 覆盖它的"逐层笛卡尔积"矩形（fill 的 sel 表达力边界内的精确划分，无重叠）。 */
    private static List<JsonObject> rectangles(List<int[]> positions, int w, int h, int d) {
        TreeMap<Integer, TreeMap<Integer, List<Integer>>> perY = new TreeMap<Integer, TreeMap<Integer, List<Integer>>>();
        for (int i = 0; i < positions.size(); i++) {
            int[] p = positions.get(i);
            TreeMap<Integer, List<Integer>> byZ = perY.get(Integer.valueOf(p[1]));
            if (byZ == null) {
                byZ = new TreeMap<Integer, List<Integer>>();
                perY.put(Integer.valueOf(p[1]), byZ);
            }
            List<Integer> xs = byZ.get(Integer.valueOf(p[2]));
            if (xs == null) {
                xs = new ArrayList<Integer>();
                byZ.put(Integer.valueOf(p[2]), xs);
            }
            xs.add(Integer.valueOf(p[0]));
        }
        TreeMap<String, List<Integer>> merged = new TreeMap<String, List<Integer>>();
        TreeMap<String, int[][]> specs = new TreeMap<String, int[][]>();
        for (Map.Entry<Integer, TreeMap<Integer, List<Integer>>> ye : perY.entrySet()) {
            TreeMap<String, List<Integer>> byXList = new TreeMap<String, List<Integer>>();
            for (Map.Entry<Integer, List<Integer>> ze : ye.getValue()
                .entrySet()) {
                List<Integer> xs = ze.getValue();
                Collections.sort(xs);
                String k = xs.toString();
                List<Integer> zs = byXList.get(k);
                if (zs == null) {
                    zs = new ArrayList<Integer>();
                    byXList.put(k, zs);
                }
                zs.add(ze.getKey());
            }
            for (Map.Entry<String, List<Integer>> ge : byXList.entrySet()) {
                List<Integer> zs = ge.getValue();
                Collections.sort(zs);
                String key = ge.getKey() + "|" + zs.toString();
                List<Integer> ys = merged.get(key);
                if (ys == null) {
                    ys = new ArrayList<Integer>();
                    merged.put(key, ys);
                    specs.put(key, new int[][] { toArray(ge.getKey()), toArray(zs.toString()) });
                }
                ys.add(ye.getKey());
            }
        }
        List<JsonObject> out = new ArrayList<JsonObject>();
        for (Map.Entry<String, List<Integer>> me : merged.entrySet()) {
            int[][] spec = specs.get(me.getKey());
            int[] xs = spec[0];
            int[] zs = spec[1];
            List<Integer> ys = me.getValue();
            Collections.sort(ys);
            JsonObject sel = new JsonObject();
            if (!isFull(xs, w)) sel.add("x", axis(xs));
            if (!isFull(ys, h)) sel.add("y", axis(ys));
            if (!isFull(zs, d)) sel.add("z", axis(zs));
            out.add(sel);
        }
        return out;
    }

    private static boolean isFull(List<Integer> list, int size) {
        if (list.size() != size) return false;
        for (int i = 0; i < size; i++) {
            if (list.get(i)
                .intValue() != i) return false;
        }
        return true;
    }

    private static boolean isFull(int[] list, int size) {
        if (list.length != size) return false;
        for (int i = 0; i < size; i++) {
            if (list[i] != i) return false;
        }
        return true;
    }

    private static JsonElement axis(List<Integer> list) {
        if (list.size() == 1) return new JsonPrimitive(list.get(0));
        JsonArray a = new JsonArray();
        for (int i = 0; i < list.size(); i++) a.add(new JsonPrimitive(list.get(i)));
        return a;
    }

    private static JsonElement axis(int[] list) {
        if (list.length == 1) return new JsonPrimitive(Integer.valueOf(list[0]));
        JsonArray a = new JsonArray();
        for (int i = 0; i < list.length; i++) a.add(new JsonPrimitive(Integer.valueOf(list[i])));
        return a;
    }

    private static int[] toArray(String list) {
        String s = list.substring(1, list.length() - 1)
            .trim();
        if (s.isEmpty()) return new int[0];
        String[] parts = s.split(",");
        int[] out = new int[parts.length];
        for (int i = 0; i < parts.length; i++) out[i] = Integer.parseInt(parts[i].trim());
        return out;
    }

    /** 把矩形写成规则：单格 → {@code setCell}，否则 → {@code fill}。 */
    private static void addRect(JsonObject rule, JsonObject sel, int w, int h, int d) {
        int nx = sel.has("x") ? countAxis(sel.get("x")) : w;
        int ny = sel.has("y") ? countAxis(sel.get("y")) : h;
        int nz = sel.has("z") ? countAxis(sel.get("z")) : d;
        if (nx * ny * nz == 1) {
            rule.addProperty("kind", "setCell");
            rule.addProperty("x", Integer.valueOf(sel.has("x") ? firstAxis(sel.get("x")) : 0));
            rule.addProperty("y", Integer.valueOf(sel.has("y") ? firstAxis(sel.get("y")) : 0));
            rule.addProperty("z", Integer.valueOf(sel.has("z") ? firstAxis(sel.get("z")) : 0));
        } else {
            rule.addProperty("kind", "fill");
            rule.add("sel", sel);
        }
    }

    private static int countAxis(JsonElement e) {
        return e.isJsonArray() ? e.getAsJsonArray()
            .size() : 1;
    }

    private static int firstAxis(JsonElement e) {
        return e.isJsonArray() ? e.getAsJsonArray()
            .get(0)
            .getAsInt() : e.getAsInt();
    }

    // -----------------------------------------------------------------------
    // 7. 调色板重编号规则（契约 §4.5.2：旧下标 → 新下标整表批量替换）
    // -----------------------------------------------------------------------

    private void emitPaletteRenumberRule() {
        if (!in.paletteRenumberViaAliases) return;
        JsonObject aliasJson = new JsonObject();
        for (Map.Entry<Integer, Integer> e : aliases.entrySet()) {
            aliasJson.addProperty(String.valueOf(e.getKey()), e.getValue());
        }
        int[] anchor = pickAnchor();
        JsonObject rule = new JsonObject();
        rule.addProperty("id", PALETTE_RENUMBER_RULE_ID);
        rule.addProperty("phase", "backbone");
        rule.addProperty("legend", "palette.renumber");
        rule.addProperty("kind", "setCell");
        rule.addProperty("x", Integer.valueOf(anchor[0]));
        rule.addProperty("y", Integer.valueOf(anchor[1]));
        rule.addProperty("z", Integer.valueOf(anchor[2]));
        rule.addProperty("index", Integer.valueOf(0));
        rule.add("indexAliases", aliasJson);
        rules.add(0, rule);
        RuleRef ref = new RuleRef();
        ref.id = PALETTE_RENUMBER_RULE_ID;
        ref.stepIndex = -1;
        ruleRefs.add(0, ref);
    }

    /**
     * 锚点格：契约 §4.5 要求规则必须能确定写入内容，故"纯重编号"规则也需要一个写入目标 ——
     * 选一个**写入不改变任何变体结果**的格子：
     * ① 所有阶都是 const-air 的格子（写 0 = 无操作）；
     * ② 否则一个在所有阶上都"非常量"的格子（骨架里是 0，随后必被内容规则覆盖）；
     * ③ 否则坐标越界（{@code x = -1}，装配器按契约跳过该写入）。
     */
    private int[] pickAnchor() {
        TreeSet<String> constAirAll = null;
        TreeSet<String> varyingAll = null;
        for (StepInfo si : steps) {
            TreeSet<String> constAir = new TreeSet<String>();
            TreeSet<String> varying = new TreeSet<String>();
            for (int z = 0; z < si.d; z++) {
                for (int y = 0; y < si.h; y++) {
                    for (int x = 0; x < si.w; x++) {
                        String k = pad(x) + "," + pad(y) + "," + pad(z);
                        int c = idx(x, y, z, si.w, si.h);
                        if (!si.varying[c] && si.skeleton[z][y][x] == 0) constAir.add(k);
                        else if (si.varying[c]) varying.add(k);
                    }
                }
            }
            constAirAll = constAirAll == null ? constAir : intersect(constAirAll, constAir);
            varyingAll = varyingAll == null ? varying : intersect(varyingAll, varying);
        }
        if (constAirAll != null && !constAirAll.isEmpty()) return parseAnchor(constAirAll.first());
        if (varyingAll != null && !varyingAll.isEmpty()) return parseAnchor(varyingAll.first());
        return new int[] { -1, 0, 0 };
    }

    private static String pad(int v) {
        return v < 10 ? "0" + v : String.valueOf(v);
    }

    private static TreeSet<String> intersect(TreeSet<String> a, TreeSet<String> b) {
        TreeSet<String> out = new TreeSet<String>();
        for (String s : a) {
            if (b.contains(s)) out.add(s);
        }
        return out;
    }

    private static int[] parseAnchor(String key) {
        String[] p = key.split(",");
        return new int[] { Integer.parseInt(p[0]), Integer.parseInt(p[1]), Integer.parseInt(p[2]) };
    }

    // -----------------------------------------------------------------------
    // 8. frames / inner body
    // -----------------------------------------------------------------------

    private JsonArray buildFrames() {
        JsonArray frames = new JsonArray();
        int index = 0;
        for (StepInfo si : steps) {
            for (int i = 0; i < si.variants.size(); i++) {
                VariantIn v = si.variants.get(i);
                JsonObject f = new JsonObject();
                f.addProperty("index", Integer.valueOf(index++));
                f.addProperty("variant", v.key);
                f.addProperty("runstate", v.runstate);
                f.addProperty("stepIndex", Integer.valueOf(si.stepIndex));
                JsonArray refs = new JsonArray();
                if (in.paletteRenumberViaAliases) refs.add(new JsonPrimitive(PALETTE_RENUMBER_RULE_ID));
                Map<String, Integer> eff = effectiveByVariantKey.get(v.key);
                for (RuleRef r : ruleRefs) {
                    if (r.stepIndex < 0) continue;
                    if (r.stepIndex != si.stepIndex) continue;
                    if (r.withTt && r.tt != v.totalTier) continue;
                    if (r.withRs && !r.rs.equals(v.runstate)) continue;
                    if (!guardRefMatches(r, eff)) continue;
                    refs.add(new JsonPrimitive(r.id));
                }
                f.add("rules", refs);
                frames.add(f);
            }
        }
        return frames;
    }

    /**
     * 帧是否引用该 guard 规则：guard 通道有效取值必须全部相等。
     * <p>
     * 帧的引用列表只挑「本变体落在其 guard 条件内」的规则（更省字节），装配器**仍**按契约 §5.4
     * 对每条被引用规则求值 guard —— 两条路径对同一文档得出相同结果。
     */
    private boolean guardRefMatches(RuleRef r, Map<String, Integer> eff) {
        if (r.guardChannels.length == 0) return true;
        if (eff == null) return false;
        for (int i = 0; i < r.guardChannels.length; i++) {
            Integer v = eff.get(replaceChannels.get(r.guardChannels[i]).key);
            if (v == null || v.intValue() != r.guardValues[i]) return false;
        }
        return true;
    }

    private JsonObject buildInnerBody(JsonArray frames) {
        JsonObject inner = new JsonObject();
        inner.addProperty("schemaVersion", Integer.valueOf(1));
        inner.addProperty("multiblockCount", Integer.valueOf(1));
        inner.add("multiblock", buildMultiblock());
        inner.add("blockPalette", prunedPalette);
        if (in.materialPalette != null) inner.add("materialPalette", in.materialPalette);
        if (in.textureBlobs != null) inner.add("textureBlobs", in.textureBlobs);
        if (in.tooltipPalette != null) inner.add("tooltipPalette", in.tooltipPalette);
        inner.add("frames", frames);
        return inner;
    }

    private JsonObject buildMultiblock() {
        JsonObject mb = new JsonObject();
        mb.addProperty("id", in.id);
        mb.addProperty("displayName", in.displayName);
        if (in.sourceClass != null) mb.addProperty("sourceClass", in.sourceClass);
        mb.addProperty("hasScopeOverlap", Boolean.valueOf(guardPositions > 0));
        if (guardPositions > 0) {
            // 契约 §4.1：hasScopeOverlap=true 时 scopeOverlapNote 必填（说明是哪片区域）。
            mb.addProperty("scopeOverlapNote", scopeOverlapNote());
        }
        JsonObject tt = new JsonObject();
        tt.addProperty("min", Integer.valueOf(in.ttMin));
        tt.addProperty("max", Integer.valueOf(in.ttMax));
        tt.addProperty("default", Integer.valueOf(in.ttDefault));
        tt.addProperty("source", in.ttSource);
        mb.add("totalTierDomain", tt);
        JsonArray sample = new JsonArray();
        for (Integer t : in.tierSample) sample.add(new JsonPrimitive(t));
        mb.add("tierSample", sample);
        mb.add("channels", buildChannels());
        JsonArray runstates = new JsonArray();
        for (RunstateIn r : in.runstates) {
            JsonObject o = new JsonObject();
            o.addProperty("id", r.id);
            o.addProperty("name", r.name);
            o.addProperty("materialSwap", Boolean.valueOf(r.materialSwap));
            runstates.add(o);
        }
        mb.add("runstates", runstates);
        mb.addProperty("couplingMode", "none");
        mb.add("couplings", new JsonArray());
        mb.add("notes", buildNotes());
        JsonObject vs = new JsonObject();
        vs.addProperty("frameIsVariant", Boolean.TRUE);
        vs.addProperty("playback", "variant-frames");
        vs.addProperty("layerPreview", "supported");
        JsonObject cov = new JsonObject();
        cov.addProperty("kind", "texture-material-swap");
        cov.addProperty("geometryDelta", Boolean.FALSE);
        cov.addProperty("tesr", "not-covered");
        vs.add("runstateCoverage", cov);
        mb.add("viewerSemantics", vs);
        mb.addProperty("paletteSource", in.paletteSource);
        mb.addProperty("geometryEncoding", in.geometryEncoding);
        mb.add("opsLegend", buildLegend());
        mb.add("backbone", buildBackbone());
        JsonArray ruleArr = new JsonArray();
        for (JsonObject r : rules) ruleArr.add(r);
        mb.add("rules", ruleArr);
        JsonArray variants = new JsonArray();
        for (VariantIn v : in.variants) {
            JsonObject o = new JsonObject();
            o.addProperty("key", v.key);
            o.addProperty("totalTier", Integer.valueOf(v.totalTier));
            JsonObject values = new JsonObject();
            for (ChannelIn c : in.channels) {
                Integer raw = v.values.get(c.key);
                values.addProperty(c.key, Integer.valueOf(raw == null ? 0 : raw.intValue()));
            }
            o.add("values", values);
            o.addProperty("runstate", v.runstate);
            variants.add(o);
        }
        mb.add("variants", variants);
        return mb;
    }

    private JsonArray buildChannels() {
        JsonArray out = new JsonArray();
        for (ChannelIn c : in.channels) {
            JsonObject o = new JsonObject();
            if (c.enumName == null) o.add("enum", JsonNull.INSTANCE);
            else o.addProperty("enum", c.enumName);
            o.addProperty("id", c.id);
            o.addProperty("key", c.key);
            o.addProperty("name", c.name);
            String kind;
            if (sizeChannels.contains(c)) kind = "size";
            else if (hatchChannels.contains(c)) kind = "hatch";
            else kind = "replace";
            o.addProperty("kind", kind);
            int hi = domainMaxOf(c);
            if ("size".equals(kind)) {
                o.addProperty("min", Integer.valueOf(contractSizeMin(c)));
                o.addProperty("max", Integer.valueOf(hi));
                o.addProperty("axis", "y");
                o.addProperty("unit", "layers");
                o.addProperty("valueSemantics", "clamped-offset");
            } else if ("replace".equals(kind)) {
                int lo = Math.min(1, hi);
                o.addProperty("min", Integer.valueOf(lo));
                o.addProperty("max", Integer.valueOf(hi));
            }
            String src = c.domainSource == null ? "probed" : c.domainSource;
            o.addProperty("domainSource", "probed".equals(src) ? "probed" : "game-lang");
            JsonObject dom = new JsonObject();
            if ("size".equals(kind)) dom.addProperty("min", Integer.valueOf(contractSizeMin(c)));
            dom.addProperty("max", Integer.valueOf(hi));
            o.add("domain", dom);
            if ("hatch".equals(kind)) o.addProperty("slider", Boolean.FALSE);
            out.add(o);
        }
        return out;
    }

    private JsonArray buildNotes() {
        JsonArray notes = new JsonArray();
        if (in.datasetSource != null && !in.datasetSource.isEmpty()) {
            JsonObject n = new JsonObject();
            n.addProperty("kind", "note");
            n.addProperty(
                "text",
                "数据来源（T1.3 变体几何数据集）：" + in.datasetSource
                    + "；调色板已按本机变体并集剪枝，并用 palette.renumber 规则整表重编号（契约 §6.1 第 4 条、§4.5.2）。");
            n.addProperty("source", "probe-variant-capture.md §9.2");
            notes.add(n);
        }
        if (guardPositions > 0) {
            JsonObject n = new JsonObject();
            n.addProperty("kind", "note");
            n.addProperty(
                "text",
                "通道作用域相交（T0.4 记录的例外）：本机有 " + guardPositions
                    + " 个格的取值同时依赖 ≥2 条替换型通道，已按契约 §4.5.3 生成 "
                    + guardRules
                    + " 条带 guard 的多组差异规则，文档标 hasScopeOverlap: true；相交通道组合（guard 通道）计数："
                    + guardKeyHistogram);
            n.addProperty("source", "format-multiblock-doc.md §4.5.3 / probe-channels.md §2");
            notes.add(n);
        }
        // 忠实度声明（硬约束「不得靠丢弃变体换体积」的边界）：域收窄 / 总 Tier 抽样必须写进产物本身。
        for (ChannelIn c : in.channels) {
            if (!c.subsetOverridden) continue;
            JsonObject n = new JsonObject();
            n.addProperty("kind", "note");
            n.addProperty(
                "text",
                "通道 " + c.key
                    + " 的声明域为 0.."
                    + domainMaxOf(c)
                    + "，小于真实域上界 "
                    + (c.trueDomainMax == null ? "（未知，见数据集 subsetNote）" : String.valueOf(c.trueDomainMax))
                    + "：本产物只覆盖声明域内的取值，被排除取值在真实机器上存在但本文件不代表其几何。"
                    + "收窄来源 = T1.5 的安全上限/显式抽样（组合积过大时的兜底），非编码器丢弃变体。");
            n.addProperty("source", "multiblock-channel-renderer-plan.md §T1.5 / §7 风险 7");
            notes.add(n);
        }
        int ttSpan = in.ttMax - in.ttMin + 1;
        if (!in.tierSample.isEmpty() && in.tierSample.size() < ttSpan) {
            JsonObject n = new JsonObject();
            n.addProperty("kind", "note");
            n.addProperty(
                "text",
                "总 Tier 抽样 = " + in.tierSample
                    + "（完整域 "
                    + in.ttMin
                    + ".."
                    + in.ttMax
                    + "，共 "
                    + ttSpan
                    + " 档）：未覆盖的 Tier 在真实机器上存在，本产物不代表它们的几何（按契约 §9.4 的 tierSample 语义抽样）。");
            n.addProperty("source", "format-multiblock-doc.md §4.1 tierSample");
            notes.add(n);
        }
        for (JsonObject extra : in.extraNotes) notes.add(extra);
        JsonObject n2 = new JsonObject();
        n2.addProperty("kind", "note");
        n2.addProperty("text", "未探测到通道间约束 → couplings: [] + couplingMode: \"none\"：不拒绝任何组合，装配按各通道独立生效（契约 §7.3 缺省行为）。");
        n2.addProperty("source", "format-multiblock-doc.md §7.3");
        notes.add(n2);
        JsonObject n3 = new JsonObject();
        n3.addProperty("kind", "note");
        n3.addProperty("text", "运行态轴只承诺纹理/材质层两态差异；TESR（shader/VAO）活动几何与运行中才生成的附属渲染方块本轮显式不覆盖，不得作为验收条件。");
        n3.addProperty("source", "probe-run-state.md §3.2 / §5");
        notes.add(n3);
        return notes;
    }

    private JsonObject buildLegend() {
        JsonObject legend = new JsonObject();
        legend.addProperty("palette.renumber", "调色板重编号：本机并集剪枝后把骨架里的旧（全局）下标整表换成新下标。旧下标 → 新下标，与出现次数无关（契约 §4.5.2）。");
        legend.addProperty(
            "channel.replace",
            "替换型通道：indexTable 按该通道有效取值查表（档 0 = 未设置分支，实际由装配第 0 步回落到总 Tier）（契约 §4.2/§6.2）。");
        if (guardRules > 0) {
            legend.addProperty(
                "channel.guard",
                "通道作用域相交（同一格的取值同时依赖 ≥2 条替换型通道）：indexTable 仍按 channels[0] 的取值查表，"
                    + "但该规则只在 guard.clauses 全真时生效 —— 每条 clause 是另一条通道的有效取值等值条件（契约 §4.5.3）。");
        }
        legend.addProperty("runstate.overlay", "运行态叠加层：同位姿在 idle / running 两态取不同下标（本轮只落材质层，几何不变）。");
        legend.addProperty("tier.overlay", "总 Tier 叠加层：该位置的内容随总 Tier 变化（按帧引用不同规则，不做算术）。");
        return legend;
    }

    private JsonObject buildBackbone() {
        JsonObject bb = new JsonObject();
        bb.addProperty("kind", "sizeSteps");
        ChannelIn sizeCh = sizeChannels.isEmpty() ? null : sizeChannels.get(0);
        String sizeChannel = sizeCh == null ? "totalTier" : sizeCh.key;
        bb.addProperty("sizeChannel", sizeChannel);
        JsonArray arr = new JsonArray();
        for (StepInfo si : steps) {
            JsonObject s = new JsonObject();
            s.addProperty("channel", sizeChannel);
            s.addProperty("layers", Integer.valueOf(sizeCh == null ? si.h : si.stepIndex + contractSizeMin(sizeCh)));
            s.addProperty("w", Integer.valueOf(si.w));
            s.addProperty("hh", Integer.valueOf(si.h));
            s.addProperty("d", Integer.valueOf(si.d));
            s.add("roles", stepRoles(si));
            JsonArray grid = new JsonArray();
            for (int z = 0; z < si.d; z++) {
                JsonArray slice = new JsonArray();
                for (int y = 0; y < si.h; y++) {
                    JsonArray row = new JsonArray();
                    for (int x = 0; x < si.w; x++) {
                        int v = si.skeleton[z][y][x];
                        // 走 indexAliases 重编号时骨架保持全局下标（由 palette.renumber 规则整表换）；
                        // 否则在编码期直接落到最终下标。
                        row.add(new JsonPrimitive(Integer.valueOf(in.paletteRenumberViaAliases ? v : pruned(v))));
                    }
                    slice.add(row);
                }
                grid.add(slice);
            }
            s.add("cellGrid", grid);
            arr.add(s);
        }
        bb.add("sizeSteps", arr);
        return bb;
    }

    /** 骨架角色：casing = 骨架里最常出现的非空下标（其余角色不猜，避免凭空造语义）。 */
    private JsonObject stepRoles(StepInfo si) {
        JsonObject roles = new JsonObject();
        Map<Integer, Integer> hist = new TreeMap<Integer, Integer>();
        for (int z = 0; z < si.d; z++) {
            for (int y = 0; y < si.h; y++) {
                for (int x = 0; x < si.w; x++) {
                    int v = si.skeleton[z][y][x];
                    if (v == 0) continue;
                    Integer k = Integer.valueOf(v);
                    Integer c = hist.get(k);
                    hist.put(k, Integer.valueOf(c == null ? 1 : c.intValue() + 1));
                }
            }
        }
        int best = -1;
        int bestCount = 0;
        for (Map.Entry<Integer, Integer> e : hist.entrySet()) {
            if (e.getValue()
                .intValue() > bestCount) {
                best = e.getKey()
                    .intValue();
                bestCount = e.getValue()
                    .intValue();
            }
        }
        if (best >= 0) roles.addProperty("casing", Integer.valueOf(pruned(best)));
        return roles;
    }

    // -----------------------------------------------------------------------
    // 9. 统计
    // -----------------------------------------------------------------------

    private Result result(JsonObject inner, JsonArray frames) {
        JsonObject stats = new JsonObject();
        stats.addProperty("machine", in.id);
        stats.addProperty("variants", Integer.valueOf(in.variants.size()));
        stats.addProperty("frames", Integer.valueOf(frames.size()));
        stats.addProperty("steps", Integer.valueOf(steps.size()));
        int rects = 0;
        int constCells = 0;
        int varyingCells = 0;
        JsonArray stepArr = new JsonArray();
        for (StepInfo si : steps) {
            rects += si.rectCount;
            constCells += si.constCells;
            varyingCells += si.varyingCells;
            JsonObject s = new JsonObject();
            s.addProperty("stepIndex", Integer.valueOf(si.stepIndex));
            s.addProperty("dims", si.w + "x" + si.h + "x" + si.d);
            s.addProperty("variants", Integer.valueOf(si.variants.size()));
            s.addProperty("constCells", Integer.valueOf(si.constCells));
            s.addProperty("varyingCells", Integer.valueOf(si.varyingCells));
            s.addProperty("groups", Integer.valueOf(si.groups.size()));
            s.addProperty("rectangles", Integer.valueOf(si.rectCount));
            stepArr.add(s);
        }
        stats.add("stepDetail", stepArr);
        stats.addProperty("sizeEffectiveFieldMismatch", Integer.valueOf(sizeEffectiveMismatch));
        if (!sizeChannels.isEmpty()) {
            JsonObject sizeMap = new JsonObject();
            ChannelIn sizeCh = sizeChannels.get(0);
            for (StepInfo si : steps) {
                sizeMap.addProperty(
                    String.valueOf(si.stepIndex + contractSizeMin(sizeCh)),
                    si.w + "x" + si.h + "x" + si.d);
            }
            stats.add("sizeValueToDims", sizeMap);
        }
        stats.addProperty("constCells", Integer.valueOf(constCells));
        stats.addProperty("varyingCells", Integer.valueOf(varyingCells));
        stats.addProperty("rectangles", Integer.valueOf(rects));
        stats.addProperty("hasScopeOverlap", Boolean.valueOf(guardPositions > 0));
        stats.addProperty("guardPositions", Integer.valueOf(guardPositions));
        stats.addProperty("guardRules", Integer.valueOf(guardRules));
        stats.add("guardKeyHistogram", guardHistogramJson());
        JsonObject byPhase = new JsonObject();
        JsonObject byKind = new JsonObject();
        JsonObject byLegend = new JsonObject();
        int aliasRules = 0;
        int tableRules = 0;
        int constRules = 0;
        for (JsonObject r : rules) {
            bump(
                byPhase,
                r.get("phase")
                    .getAsString());
            bump(
                byKind,
                r.get("kind")
                    .getAsString());
            if (r.has("legend")) bump(
                byLegend,
                r.get("legend")
                    .getAsString());
            if (r.has("indexAliases")) aliasRules++;
            else if (r.has("indexTable")) tableRules++;
            else constRules++;
        }
        JsonObject ruleStats = new JsonObject();
        ruleStats.addProperty("total", Integer.valueOf(rules.size()));
        ruleStats.add("byPhase", byPhase);
        ruleStats.add("byKind", byKind);
        ruleStats.add("byLegend", byLegend);
        ruleStats.addProperty("indexTable", Integer.valueOf(tableRules));
        ruleStats.addProperty("constant", Integer.valueOf(constRules));
        ruleStats.addProperty("indexAliases", Integer.valueOf(aliasRules));
        ruleStats.addProperty("tableGapFillsPerPosition", Integer.valueOf(tableGapFills));
        ruleStats.addProperty("guardRules", Integer.valueOf(guardRules));
        ruleStats.addProperty("paletteRenumberViaAliases", Boolean.valueOf(in.paletteRenumberViaAliases));
        int refs = 0;
        for (RuleRef r : ruleRefs) {
            if (r.stepIndex < 0) continue;
            refs++;
        }
        ruleStats.addProperty("contentRules", Integer.valueOf(refs));
        stats.add("rules", ruleStats);
        JsonObject pal = new JsonObject();
        pal.addProperty("globalEntries", Integer.valueOf(in.palette == null ? 0 : in.palette.size()));
        pal.addProperty("prunedEntries", Integer.valueOf(prunedPalette.size()));
        pal.addProperty(
            "droppedEntries",
            Integer.valueOf((in.palette == null ? 0 : in.palette.size()) - prunedPalette.size()));
        pal.addProperty("aliasMapSize", Integer.valueOf(aliases.size()));
        stats.add("palette", pal);
        JsonObject vol = new JsonObject();
        long gridBytes = 0;
        for (VariantIn v : in.variants) {
            gridBytes += utf8(compact(toJsonArray(v.cellGrid))).length;
        }
        long paletteBytes = utf8(compact(prunedPalette)).length;
        byte[] innerBytes = utf8(compact(inner));
        vol.addProperty("innerJsonBytes", Integer.valueOf(innerBytes.length));
        vol.addProperty("paletteJsonBytes", Integer.valueOf((int) paletteBytes));
        vol.addProperty("variantGridBytesTotal", Integer.valueOf((int) gridBytes));
        vol.addProperty("V_expandedContract", Long.valueOf(paletteBytes + gridBytes));
        stats.add("volume", vol);
        stats.addProperty("innerSha256", sha256(innerBytes));
        return new Result(inner, stats);
    }

    /**
     * 契约 §4.1：{@code hasScopeOverlap=true} 时必填，说明"是哪片区域"。
     * 逐交通道组合给出格数与样例位置（骨架阶:坐标），不猜语义、不做归因。
     */
    private String scopeOverlapNote() {
        StringBuilder sb = new StringBuilder();
        sb.append("通道作用域相交区域：");
        for (Map.Entry<String, Integer> e : guardKeyHistogram.entrySet()) {
            if (sb.charAt(sb.length() - 1) != '：') sb.append("；");
            sb.append("guard 通道 [")
                .append(e.getKey())
                .append("] 参与决定的格 ")
                .append(e.getValue())
                .append(" 个，样例位置（骨架阶:x,y,z）= ")
                .append(guardKeyExamples.get(e.getKey()));
        }
        sb.append("。这些格整体落入差异规则表（多组规则 + guard.clauses），不进入骨架；")
            .append("规则由本编码器按「guard 通道取值精确等值 + 查表通道 indexTable」生成（契约 §4.5.3）。");
        return sb.toString();
    }

    private JsonObject guardHistogramJson() {
        JsonObject o = new JsonObject();
        for (Map.Entry<String, Integer> e : guardKeyHistogram.entrySet()) {
            o.addProperty(e.getKey(), e.getValue());
        }
        return o;
    }

    private static void bump(JsonObject o, String key) {
        int c = o.has(key) ? o.get(key)
            .getAsInt() : 0;
        o.addProperty(key, Integer.valueOf(c + 1));
    }

    private static JsonArray toJsonArray(int[][][] grid) {
        JsonArray arr = new JsonArray();
        for (int z = 0; z < grid.length; z++) {
            JsonArray slice = new JsonArray();
            for (int y = 0; y < grid[z].length; y++) {
                JsonArray row = new JsonArray();
                for (int x = 0; x < grid[z][y].length; x++) row.add(new JsonPrimitive(Integer.valueOf(grid[z][y][x])));
                slice.add(row);
            }
            arr.add(slice);
        }
        return arr;
    }

    private static int idx(int x, int y, int z, int w, int h) {
        return (z * h + y) * w + x;
    }

    private static JsonArray intArray(int[] v) {
        JsonArray a = new JsonArray();
        for (int i = 0; i < v.length; i++) a.add(new JsonPrimitive(Integer.valueOf(v[i])));
        return a;
    }

    static String compact(JsonElement e) {
        return new Gson().toJson(e);
    }

    static byte[] utf8(String s) {
        try {
            return s.getBytes("UTF-8");
        } catch (java.io.UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }

    static String sha256(byte[] data) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] h = md.digest(data);
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < h.length; i++) {
                sb.append(Character.forDigit((h[i] >> 4) & 0xF, 16));
                sb.append(Character.forDigit(h[i] & 0xF, 16));
            }
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
