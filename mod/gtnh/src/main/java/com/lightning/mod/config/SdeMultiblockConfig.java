package com.lightning.mod.config;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

import net.minecraftforge.common.config.Configuration;

/**
 * T1.5 {@code /sde multiblock} 的配置面（计划 §T1.5、留白登记 §9 第 6 条）。
 * <p>
 * <b>默认全量不裁剪</b>：下面的上限都只是**安全兜底**，只在单机组合积大到无法在一次运行里
 * 完成时才生效；一旦生效，产物 {@code notes} 与被收窄通道的 {@code notes} 都会如实记录
 * 「真实域 / 被排除的取值」。
 * <p>
 * <b>为什么在本类里懒加载</b>：既有 {@link SdeAutomationConfig} 由 {@code LightningMod} 在
 * {@code preInit} 用 {@code event.getSuggestedConfigurationFile()} 装载；T1.5 的写范围不含
 * {@code LightningMod}，故改为**首次使用时按显式路径装载**（客户端侧调用者手上有
 * {@code mc.mcDataDir}），避免在 common 侧猜数据目录。
 * <p>
 * <b>默认值（留白 #6 拍板）与理由</b>：
 *
 * <table border="1">
 * <tr>
 * <th>配置</th>
 * <th>默认</th>
 * <th>理由</th>
 * </tr>
 * <tr>
 * <td>{@code structuralCompression}</td>
 * <td>{@code true}</td>
 * <td>需求 C 的本体：骨干 + 共享差异规则表。关闭时产物退化为「每帧内联 cellGrid」的组合展开形态，
 * 仅供体积对照/诊断，**不通过契约校验器**（{@code frames[].cellGrid} 是校验器的硬失败项）。</td>
 * </tr>
 * <tr>
 * <td>{@code maxChannelValues}</td>
 * <td>{@code 0}（不限制）</td>
 * <td>通道取值数上限：0 = 用 T1.2 事实层的全量域。收窄域会牺牲忠实度，故不默认开启。</td>
 * </tr>
 * <tr>
 * <td>{@code maxVariantsPerMachine}</td>
 * <td>{@code 20000}</td>
 * <td>变体数上限（安全兜底）。实测 221 台全量组合积 = 5,571,418 个变体（T1.2 枚举 × 域 × 2 运行态），
 * 单机最大 MTEMultiAutoclave 1,898,100 / MTELapotronicSuperCapacitor 1,886,016。20000 让 203/221 台
 * **零裁剪**（合计 119,410 变体），只对 18 台超大组合积机器收窄（含 LSC 与 MultiAutoclave）。</td>
 * </tr>
 * <tr>
 * <td>{@code maxExportMachines}</td>
 * <td>{@code 0}（全部）</td>
 * <td>导出范围上限（单次导出的多方块台数）：0 = 不限制，全量 221 台。上限只用于分片/试跑。</td>
 * </tr>
 * <tr>
 * <td>{@code structuralOnly}</td>
 * <td>{@code false}</td>
 * <td>只导出结构性组合：true 时跳过 active 运行态（变体数减半、产物只声明 idle 一态）。
 * 默认 false = 结构轴 + 运行态轴都覆盖。</td>
 * </tr>
 * <tr>
 * <td>{@code globalBudgetMs}</td>
 * <td>{@code 4 h}</td>
 * <td>整轮时间预算（安全兜底）：超时后剩余机器不执行并写入失败清单（不静默跳过）。</td>
 * </tr>
 * </table>
 */
public final class SdeMultiblockConfig {

    // ------------------------------------------------------------------ 配置项

    /** 结构性压缩开关（需求 C）：false = 组合展开形态（诊断/体积对照用，非生产）。 */
    public static boolean structuralCompression = true;
    /** 通道取值数上限：>0 时把每条替换型/尺寸型通道的域收到 0..min(该值, 真实域上界)；0 = 不限制。 */
    public static int maxChannelValues = 0;
    /** 单台变体数上限（安全兜底，见类注释）。 */
    public static int maxVariantsPerMachine = 20000;
    /** 导出范围上限（单次导出的多方块台数）；0 = 全部。 */
    public static int maxExportMachines = 0;
    /** 是否只导出结构性组合（跳过 active 运行态）。 */
    public static boolean structuralOnly = false;
    /** 产物目录名（相对 mcDataDir）；与 `/sde export` 的 structure_exports 完全分开。 */
    public static String outputDirName = "sde_multiblock_exports";
    /** 整轮时间预算（ms，安全兜底）。 */
    public static long globalBudgetMs = 4L * 60L * 60L * 1000L;
    /** 是否在调色板里嵌缩略图（体积换诊断）。 */
    public static boolean includeThumbnails = true;
    /** 是否嵌纹理 blob（既有机制）。 */
    public static boolean embedTextures = true;
    /** 每轮的中间数据集是否保留（false = 编码完删除，只留产物）。 */
    public static boolean keepDataset = true;

    /** 配置文件路径（装载后在 `/sde multiblock` 的回报里显示，便于用户确认读的是哪一份）。 */
    private static String loadedFrom = "";

    private SdeMultiblockConfig() {}

    public static String loadedFrom() {
        return loadedFrom;
    }

    /** 按显式路径装载（幂等：重复装载会重新读取磁盘）。调用方负责给出正确路径。 */
    public static synchronized void load(File cfgFile) {
        if (cfgFile == null) return;
        try {
            Configuration cfg = new Configuration(cfgFile);
            cfg.load();
            structuralCompression = cfg.getBoolean(
                "structuralCompression",
                "multiblock",
                true,
                "结构性压缩开关（需求 C：骨干布局 + 共享差异规则表）。false = 每帧内联 cellGrid 的组合展开形态，" + "仅供体积对照/诊断，不通过契约校验器。");
            maxChannelValues = cfg.getInt(
                "maxChannelValues",
                "multiblock",
                0,
                0,
                1 << 20,
                "通道取值数上限（安全兜底）：>0 时把每条通道的域收窄到 0..min(该值, 真实域上界)。0 = 不限制（全量默认）。" + "收窄会牺牲忠实度，产物 notes 会记录真实域。");
            maxVariantsPerMachine = cfg.getInt(
                "maxVariantsPerMachine",
                "multiblock",
                20000,
                2,
                50_000_000,
                "单台变体数上限（安全兜底）。0/负数按 2 处理。超限时按契约 tierSample 语义抽样 + 必要时收窄通道域，" + "并在产物 notes 与失败/警告清单里如实记录。");
            maxExportMachines = cfg
                .getInt("maxExportMachines", "multiblock", 0, 0, 100000, "导出范围上限（单次导出的多方块台数）：0 = 不限制（全量）。上限只用于分片与试跑。");
            structuralOnly = cfg.getBoolean(
                "structuralOnly",
                "multiblock",
                false,
                "是否只导出结构性组合：true 时跳过 active 运行态（变体数减半、产物只声明 idle 一态）。");
            outputDirName = cfg.getString(
                "outputDirName",
                "multiblock",
                "sde_multiblock_exports",
                "产物目录名（相对 mcDataDir）；与 /sde export 的 structure_exports 完全独立。");
            globalBudgetMs = cfg.getInt(
                "globalBudgetMs",
                "multiblock",
                4 * 60 * 60 * 1000,
                1000,
                Integer.MAX_VALUE,
                "整轮时间预算（ms，安全兜底）；超时后剩余机器不执行并写入失败清单。");
            includeThumbnails = cfg.getBoolean("includeThumbnails", "multiblock", true, "是否在调色板条目里嵌缩略图（体积换诊断）。");
            embedTextures = cfg.getBoolean("embedTextures", "multiblock", true, "是否嵌纹理 blob（既有机制）。");
            keepDataset = cfg
                .getBoolean("keepDataset", "multiblock", true, "是否保留每轮的中间数据集（variant_capture 形态，供离线复算/闭环验证）。");
            if (cfg.hasChanged()) cfg.save();
            loadedFrom = cfgFile.getAbsolutePath();
        } catch (Throwable t) {
            loadedFrom = cfgFile.getAbsolutePath() + " (装载失败，用默认值: " + t + ")";
        }
    }

    // ------------------------------------------------------------------ 与客户端 tick 的交接

    /** {@code /sde multiblock} 的一次请求（命令跑在服务端线程，导出跑在客户端 tick）。 */
    public static final class Request {

        public final String scope;
        public final String requestedBy;
        public final long atEpochMs;

        Request(String scope, String requestedBy) {
            this.scope = scope;
            this.requestedBy = requestedBy;
            this.atEpochMs = System.currentTimeMillis();
        }
    }

    private static volatile Request pending;

    /**
     * 请求一次导出（幂等：已有未消费请求时返回 false，避免重复触发）。
     * <p>
     * 本类刻意**不引用任何 {@code @SideOnly(CLIENT)} 类**：命令侧与 config 侧都是 common，
     * 客户端 tick 只做 {@link #consumePending()} 轮询。
     */
    public static synchronized boolean requestExport(String scope, String requestedBy) {
        if (pending != null) return false;
        pending = new Request(
            scope == null || scope.trim()
                .isEmpty() ? "all" : scope.trim(),
            requestedBy);
        return true;
    }

    public static boolean hasPendingExport() {
        return pending != null;
    }

    public static synchronized Request consumePending() {
        Request r = pending;
        pending = null;
        return r;
    }

    public static synchronized void clearPending() {
        pending = null;
    }

    /** 把逗号/空格分隔的范围串拆成清单（空 = 空清单，由调用方决定"全部"语义）。 */
    public static List<String> parseScope(String scope) {
        List<String> out = new ArrayList<String>();
        if (scope == null) return out;
        for (String part : scope.split("[,\\s]+")) {
            String s = part.trim();
            if (!s.isEmpty()) out.add(s);
        }
        return out;
    }
}
