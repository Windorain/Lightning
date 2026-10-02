package com.lightning.mod.config;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * T1.6 游戏内自动导出管线的**默认参数 + 环境前置检查**（留白 #7/#8/#10 的拍板落点，
 * 见 {@code docs/plan/probe-export-pipeline.md}）。
 * <p>
 * 本类刻意**零 MC 依赖、零 client 依赖**（纯 JDK 文件系统 + 常量），因此：
 * <ul>
 * <li>外层编排脚本（{@code scripts/multiblock-pipeline/run-pipeline.ps1}）能用同口径做**启动前**前置检查 ——
 * 这是「CoFH 卡死」唯一能在进程启动前拦住的地方；</li>
 * <li>common 侧（命令/配置）不因引用它而加载任何 {@code @SideOnly(CLIENT)} 类。</li>
 * </ul>
 *
 * <h2>留白 #7（自动进世界方式）</h2>
 * 专用干净世界（{@link #DEDICATED_WORLD_FOLDER}）：不存在则以「超平坦 + 创造 + 允许命令」新建，存在则复用；
 * 两者都幂等。**绝不加载玩家存档** —— T0.3 §4.4(2) 实证：进含缺失模组的存档会与 FML {@code StartupQuery}
 * 确认框互锁（两侧线程互等）并改写该存档，且就算应答了还会因缺失 dimension provider 崩溃。
 *
 * <h2>留白 #8（外层编排）</h2>
 * 两层薄封装：gradle task {@code runClientSdePipeline}（注入 {@code -Dfml.queryResult=confirm}）
 * + 根 {@code package.json} 的 {@code multiblock:export} / {@code multiblock:selfcheck}。
 *
 * <h2>留白 #10（展开形态校验文件）</h2>
 * 见 {@code MultiblockExpandedVerifier}：每台跑一遍抽样清单（每通道最小/最大取值 + 每个运行态 + N 组随机组合），
 * 每个组合落一份 {@code {variant, dims, cellGrid}} —— 与 {@code web/e2e/helpers/multiblock/referenceGrids.ts}
 * 的 {@code ReferenceGridFile} **同字段同口径**（{@code cellGrid[z][row][x]}，row 0 = 结构顶部，不翻转不转置），
 * 并额外带「全局并集调色板下标 + 条目内容签名」以支持跨下标空间的逐格 diff。
 */
public final class SdeMultiblockPipelineConfig {

    // ------------------------------------------------------------------ 触发与产物

    /** 触发文件（相对 {@code mcDataDir}）。存在即接管客户端 tick，跑完自行退出。 */
    public static final String TRIGGER_FILE = "sde_multiblock_pipeline.json";
    /** 结构化结果文件（相对 {@code mcDataDir}）——外层脚本只认这一个稳定路径。 */
    public static final String RESULT_FILE = "sde_multiblock_pipeline_result.json";
    /** 结构化结果文件在产物目录里的同内容副本（便于与产物一起归档）。 */
    public static final String RESULT_FILE_IN_OUTDIR = "pipeline-result.json";
    /** 展开形态校验文件子目录（相对产物目录）。 */
    public static final String EXPANDED_SUBDIR = "expanded";
    public static final String EXPANDED_MANIFEST = "_manifest.json";
    /** schema 标识。 */
    public static final String SCHEMA = "lightning.multiblock.pipeline/1";
    public static final String EXPANDED_SCHEMA = "lightning.multiblock.expanded/1";

    // ------------------------------------------------------------------ 默认验收子集（风险 7 裁决）

    /**
     * 管线**默认子集** = T1.5 实测「可无损编码且零失败」的代表机集合（风险 7 的裁决，见计划 §3.5 与
     * T1.5 报告开放项 1、2）：
     * <ul>
     * <li>{@code MTEElectricBlastFurnace} —— 替换型通道（coil 15 档）+ 双运行态（run A 420 变体 / 0 失败）；</li>
     * <li>{@code MTEDistillationTower} —— 尺寸型通道（height 11 档，骨架阶 10；run A 220 变体 / 0 失败）；</li>
     * <li>{@code MTEBrickedBlastFurnace} —— **仅总 Tier**（无通道；run A 2 变体 / 0 失败）；</li>
     * <li>{@code MTEQuantumForceTransformer} —— 两条替换型通道（manipulator/shielding；run B 200 变体 / 0 失败）；</li>
     * <li>{@code MTEAdvEBF} —— 第二条替换型通道机 + 更大结构（run B 420 变体 / 0 失败）。</li>
     * </ul>
     * 为什么**不**默认放进 {@code MTENetworkSwitchAdv}（16 阶尺寸型，run B 也验证过）：它在 run B 里带
     * 128 条 {@code ServerBranchNotExecuted} + 1 条 {@code MachineAssertionFailed}（T1.5 开放项 6 的
     * 变体级断言噪声），会让 T1.5 口径的 {@code status} 变成 {@code has-failures}。子集验收要的是
     * 「机器判据干净」，全量留给用户裁定后的终验。
     * <p>
     * 全量（{@code all}）不做默认：T1.5 实测全量 221 台 = 413,754 变体（默认上限）≈ 32 h，
     * 不裁剪 = 5,551,258 变体 ≈ 431 h —— 单次运行不可行，**必须由用户裁定分片/子集**。
     */
    public static final List<String> DEFAULT_SUBSET = Collections.unmodifiableList(
        Arrays.asList(
            "MTEElectricBlastFurnace",
            "MTEDistillationTower",
            "MTEBrickedBlastFurnace",
            "MTEQuantumForceTransformer",
            "MTEAdvEBF"));

    // ------------------------------------------------------------------ 专用干净世界

    /** 专用世界存档目录名（{@code <mcDataDir>/saves/<该值>}）。 */
    public static final String DEDICATED_WORLD_FOLDER = "sde_pipeline_world";
    public static final String DEDICATED_WORLD_DISPLAY = "SDE Pipeline World";
    /** 固定种子（幂等：同一世界同一范围两次运行的可比性不依赖世界内容，但仍固定以免引入变量）。 */
    public static final long DEDICATED_WORLD_SEED = 20260101L;

    // ------------------------------------------------------------------ 展开形态校验文件

    /** 每台额外抽的随机组合数（在「每通道最小/最大 + 每个运行态」之上）。 */
    public static final int DEFAULT_EXPANDED_RANDOM_SAMPLES = 5;

    // ------------------------------------------------------------------ 预算

    /** 单阶段超时（进世界 / 等命令被消费 / 等产物落盘）；含客户端启动 + 专用世界加载的余量。 */
    public static final long DEFAULT_PHASE_TIMEOUT_MS = 30L * 60_000L;
    /** 整轮超时（含导出本身；T1.5 的 globalBudgetMs 另算）。 */
    public static final long DEFAULT_TOTAL_TIMEOUT_MS = 6L * 60L * 60_000L;
    /** 退出安全网：请求退出后若 JVM 仍未结束，用 {@code exitJava(code, hardExit=true)} 强制结束。 */
    public static final long EXIT_WATCHDOG_MS = 120_000L;

    // ------------------------------------------------------------------ 退出码

    /** 全绿。 */
    public static final int EXIT_OK = 0;
    /** 导出报告有失败（含「某台没产出产物」）。 */
    public static final int EXIT_HAS_FAILURES = 2;
    /** 管线级致命：环境前置检查失败 / 进世界失败 / 等命令或产物超时 / 报告缺失。 */
    public static final int EXIT_PIPELINE_FAILED = 3;

    private SdeMultiblockPipelineConfig() {}

    // ------------------------------------------------------------------ CoFH 前置检查

    /** CoFH conf 前置检查结果（T0.3 §4.4 坑 1）。 */
    public static final class ConfCheck {

        /** 候选路径里是否存在可用的 MCP conf 目录。 */
        public final boolean ok;
        /** 命中的目录（ok=false 时为空串）。 */
        public final String found;
        /** 全部候选路径（无论存在与否，用于报告里给出「查过哪些地方」）。 */
        public final List<String> candidates = new ArrayList<String>();
        /** 存在的目录中**不含** .srg 的那些（存在但内容不对 = 另一种失败，必须区别对待）。 */
        public final List<String> emptyCandidates = new ArrayList<String>();
        /** 人读的处置建议。 */
        public final String hint;

        ConfCheck(boolean ok, String found, String hint) {
            this.ok = ok;
            this.found = found == null ? "" : found;
            this.hint = hint == null ? "" : hint;
        }
    }

    /** MC / Forge 版本串（与 {@code mod/gtnh/gradle.properties} 锁步；只用于拼候选路径）。 */
    private static final String MC_VERSION = "1.7.10";
    private static final String FORGE_VERSION = "10.13.4.1614";

    /**
     * CoFH ASM 在找不到 MCP conf 时会 {@code JFileChooser.showDialog} 弹 Swing 目录选择框 →
     * 无人值守会**在启动阶段静默挂住且日志无输出**（T0.3 §4.4(1) 的线程 dump 实证）。
     * 因此把「候选路径里至少有一个可用的 conf 目录」做成**进程启动前**的硬前置。
     * <p>
     * 判据不是「目录存在」而是「目录里真有 {@code .srg}」—— 只建了空目录同样会让 CoFH 走进弹框分支。
     */
    public static ConfCheck checkCohfConf() {
        List<String> roots = new ArrayList<String>();
        String home = System.getProperty("user.home", "");
        if (!home.isEmpty()) roots.add(new File(home, ".gradle").getAbsolutePath());
        String guh = System.getenv("GRADLE_USER_HOME");
        if (guh != null && !guh.trim()
            .isEmpty()) roots.add(new File(guh.trim()).getAbsolutePath());

        List<String> candidates = new ArrayList<String>();
        List<String> empty = new ArrayList<String>();
        String found = "";
        for (String root : roots) {
            File forgeDir = new File(new File(new File(root, "caches"), "minecraft"), "net/minecraftforge/forge");
            File[] versions = forgeDir.listFiles();
            if (versions == null) {
                candidates.add(forgeDir.getAbsolutePath() + "（目录不存在）");
                continue;
            }
            Arrays.sort(versions);
            for (File v : versions) {
                if (!v.isDirectory()) continue;
                File conf = new File(new File(v, "unpacked"), "conf");
                candidates.add(conf.getAbsolutePath());
                if (!conf.isDirectory()) continue;
                if (hasSrg(conf)) {
                    if (found.isEmpty()) found = conf.getAbsolutePath();
                } else {
                    empty.add(conf.getAbsolutePath());
                }
            }
        }

        String hint = "在 %USERPROFILE%\\.gradle（或 %GRADLE_USER_HOME%）下建目录联接："
            + "  <home>/.gradle/caches/minecraft/net/minecraftforge/forge/"
            + MC_VERSION
            + "-"
            + FORGE_VERSION
            + "-"
            + MC_VERSION
            + "/unpacked"
            + "  ->  <GRADLE_USER_HOME>/caches/minecraft/net/minecraftforge/forge/"
            + MC_VERSION
            + "-"
            + FORGE_VERSION
            + "-"
            + MC_VERSION
            + "/unpacked"
            + "（T0.3 §4.4(1)：CoFH 找不到 MCP conf 会弹 Swing 目录选择框，进程静默挂住且日志无输出）";
        ConfCheck out = new ConfCheck(!found.isEmpty(), found, hint);
        out.candidates.addAll(candidates);
        out.emptyCandidates.addAll(empty);
        return out;
    }

    private static boolean hasSrg(File confDir) {
        File[] files = confDir.listFiles();
        if (files == null) return false;
        for (File f : files) {
            if (f.isFile() && f.getName()
                .endsWith(".srg")) return true;
        }
        return false;
    }
}
