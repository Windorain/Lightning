package com.lightning.mod.client.multiblock;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiMainMenu;
import net.minecraft.world.WorldSettings;
import net.minecraft.world.WorldType;

import org.apache.logging.log4j.Level;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.config.SdeMultiblockConfig;
import com.lightning.mod.config.SdeMultiblockPipelineConfig;

import cpw.mods.fml.common.FMLCommonHandler;
import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * T1.6 **游戏内自动导出管线（E 管线的 mod 半环）** —— 一条命令、零人工交互的全闭环。
 *
 * <pre>
 * gradlew runClientSdePipeline（注入 -Dfml.queryResult=confirm）
 *  → 本类接管客户端 tick：
 *     ① 前置检查（CoFH MCP conf，见 SdeMultiblockPipelineConfig#checkCohfConf）
 *     ② 自动进**专用干净世界**：不存在则以「超平坦 + 创造 + 允许命令」新建，存在则复用（幂等）
 *     ③ 世界就绪后在聊天栏真实执行 `/sde multiblock &lt;范围&gt;`（走 CommandSde → SdeMultiblockConfig 请求）
 *     ④ 客户端 tick 消费请求 → MultiblockExportAutomation.tick → 同步跑完 T1.5 全链路
 *     ⑤ 读 export-report.json + 逐份产物哈希 + 写展开形态校验文件（MultiblockExpandedVerifier）
 *     ⑥ 落结构化结果 sde_multiblock_pipeline_result.json → 以退出码反映成败 → Minecraft.shutdown()
 * </pre>
 *
 * <h2>留白 #7（自动进世界方式的拍板）</h2>
 * 专用干净世界，**不加载玩家存档**。理由（T0.3 §4.4(2) 实证）：玩家存档含缺失模组时，
 * FML {@code StartupQuery} 确认框与 {@code Minecraft.launchIntegratedServer} 的
 * {@code Thread.sleep} 等世界两侧互等死锁，且答完还会改写该存档、再因缺失 dimension provider 崩溃。
 * 「新建 or 复用同一个专用世界」两条路都幂等：导出本身在 {@code ProbeDummyWorld} 里构建（T1.3），
 * 世界内容不参与导出，因此同一世界同一范围两次运行的产物字节一致（见报告 §自检 1）。
 *
 * <h2>退出码</h2>
 * {@code 0} = 全绿；{@code 2} = 与本次范围相关的导出失败（含「某台没产出产物」）；{@code 3} = 管线级致命
 * （前置检查失败 / 进世界失败 / 超时 / 报告缺失 / 展开校验写出失败）。
 * 落定走 {@link FMLCommonHandler#exitJava(int, boolean)} —— **不能**用 {@code Runtime.halt}：
 * FML 的 {@code FMLSecurityManager} 会把非 FML 类发起的 {@code exitVM} 请求拦成
 * {@code ExitTrappedException}（实测被静默拦掉、进程仍以 0 退出）。另加 120 s 安全网线程
 * （{@code hardExit=true}），无人值守下绝不挂死。
 */
@SideOnly(Side.CLIENT)
public final class MultiblockPipelineAutomation {

    /** 状态机阶段。 */
    private enum Phase {
        INIT,
        JOIN,
        WAIT_WORLD,
        COMMAND,
        WAIT_PENDING,
        EXPORT,
        FINALIZE,
        DONE
    }

    // ------------------------------------------------------------------ 静态状态（一次一个管线）

    private static boolean active;
    private static boolean finalized;
    private static Phase phase = Phase.INIT;
    private static long startedMs;
    private static long phaseStartedMs;
    private static int phaseTicks;

    // 触发配置
    private static String label = "run";
    private static final List<String> scope = new ArrayList<String>();
    private static boolean scopeIsAll;
    private static int limit = -1;
    private static String worldFolder = SdeMultiblockPipelineConfig.DEDICATED_WORLD_FOLDER;
    private static String worldDisplay = SdeMultiblockPipelineConfig.DEDICATED_WORLD_DISPLAY;
    private static boolean expandedEnabled = true;
    private static int expandedRandom = SdeMultiblockPipelineConfig.DEFAULT_EXPANDED_RANDOM_SAMPLES;
    private static long totalTimeoutMs = SdeMultiblockPipelineConfig.DEFAULT_TOTAL_TIMEOUT_MS;
    private static long phaseTimeoutMs = SdeMultiblockPipelineConfig.DEFAULT_PHASE_TIMEOUT_MS;
    private static String requestedBy = "t1.6-pipeline";
    private static boolean cleanupTrigger = true;

    // 运行观测
    private static String worldAction = "";
    private static String commandLine = "";
    private static long commandSentMs;
    private static long reportMtimeBefore = -1L;
    private static int resendTicks = -1;
    private static boolean fallbackUsed;
    private static int exportAttempts;
    private static long joinStartMs;
    private static long worldReadyMs;

    private static final List<String> warnings = new ArrayList<String>();
    private static final List<JsonObject> pipelineFailures = new ArrayList<JsonObject>();
    private static final List<String> chatLines = new ArrayList<String>();
    private static JsonObject expandedSummary;
    private static int exitCode = SdeMultiblockPipelineConfig.EXIT_PIPELINE_FAILED;

    private MultiblockPipelineAutomation() {}
    // ------------------------------------------------------------------ 触发

    public static File triggerFile(Minecraft mc) {
        return new File(mc.mcDataDir, SdeMultiblockPipelineConfig.TRIGGER_FILE);
    }

    public static File resultFile(Minecraft mc) {
        return new File(mc.mcDataDir, SdeMultiblockPipelineConfig.RESULT_FILE);
    }

    /** 触发文件存在（或管线已在跑）时接管客户端 tick；不存在时**零行为变化**。 */
    public static boolean isRequested(Minecraft mc) {
        if (mc == null) return false;
        if (finalized) return false;
        if (active) return true;
        if (triggerFile(mc).isFile()) {
            active = true;
            // JVM 参数兜底：gradle task 会注入 -Dfml.queryResult=confirm，但 runClient 若不是 JavaExec
            // （或换了启动方式）就没有它 —— 而 StartupQuery 是**读 System.getProperty** 的，
            // 所以在第一次接管 tick 时补上等价于命令行注入（专用干净世界本就无缺失模组，这里是双保险）。
            if (System.getProperty("fml.queryResult") == null) {
                System.setProperty("fml.queryResult", "confirm");
                FMLLog.info("[SDE][T1.6] 已补设 -Dfml.queryResult=confirm（JVM 参数缺失时的进程内兜底）");
            }
            return true;
        }
        return false;
    }

    /** 服务端聊天回包（只在管线跑的时候记录），用于诊断「命令为什么没生效」（如权限不足）。 */
    public static void onChat(String text) {
        if (!active || finalized || text == null) return;
        synchronized (chatLines) {
            chatLines.add(text);
            while (chatLines.size() > 40) chatLines.remove(0);
        }
    }

    // ------------------------------------------------------------------ 主 tick

    public static void tick(Minecraft mc) {
        if (finalized || phase == Phase.DONE) return;
        try {
            long now = System.currentTimeMillis();
            if (phase != Phase.INIT) {
                if (now - startedMs > totalTimeoutMs) {
                    fatal(mc, "TotalTimeout", "整轮超时 " + (now - startedMs) + " ms（上限 " + totalTimeoutMs + "）", null);
                    return;
                }
                if (now - phaseStartedMs > phaseTimeoutMs) {
                    fatal(
                        mc,
                        "PhaseTimeout",
                        "阶段 " + phase + " 超时 " + (now - phaseStartedMs) + " ms（上限 " + phaseTimeoutMs + "）",
                        null);
                    return;
                }
            }
            switch (phase) {
                case INIT:
                    init(mc);
                    break;
                case JOIN:
                    join(mc);
                    break;
                case WAIT_WORLD:
                    waitWorld(mc);
                    break;
                case COMMAND:
                    sendCommand(mc);
                    break;
                case WAIT_PENDING:
                    waitPending(mc);
                    break;
                case EXPORT:
                    runExport(mc);
                    break;
                case FINALIZE:
                    finalizeRun(mc);
                    break;
                default:
                    break;
            }
        } catch (Throwable t) {
            fatal(mc, "Unexpected", MultiblockScanAutomation.describeChain(t), t);
        }
    }

    // ------------------------------------------------------------------ ① 初始化

    private static void init(Minecraft mc) {
        startedMs = System.currentTimeMillis();
        phaseStartedMs = startedMs;
        long t0 = startedMs;
        File trigger = triggerFile(mc);
        try {
            JsonObject o = new JsonParser().parse(MultiblockExportRunner.readText(trigger))
                .getAsJsonObject();
            if (o.has("label")) label = o.get("label")
                .getAsString();
            if (o.has("requestedBy")) requestedBy = o.get("requestedBy")
                .getAsString();
            if (o.has("world")) worldFolder = o.get("world")
                .getAsString();
            if (o.has("worldDisplay")) worldDisplay = o.get("worldDisplay")
                .getAsString();
            if (o.has("cleanupTrigger")) cleanupTrigger = o.get("cleanupTrigger")
                .getAsBoolean();
            if (o.has("totalTimeoutMs")) totalTimeoutMs = o.get("totalTimeoutMs")
                .getAsLong();
            if (o.has("phaseTimeoutMs")) phaseTimeoutMs = o.get("phaseTimeoutMs")
                .getAsLong();
            if (o.has("limit")) limit = o.get("limit")
                .getAsInt();
            if (o.has("expanded") && o.get("expanded")
                .isJsonObject()) {
                JsonObject ex = o.getAsJsonObject("expanded");
                if (ex.has("enabled")) expandedEnabled = ex.get("enabled")
                    .getAsBoolean();
                if (ex.has("randomSamples")) expandedRandom = ex.get("randomSamples")
                    .getAsInt();
            }
            if (o.has("scope")) {
                JsonElement s = o.get("scope");
                if (s.isJsonArray()) {
                    for (JsonElement e : s.getAsJsonArray()) addScope(e.getAsString());
                } else {
                    for (String part : SdeMultiblockConfig.parseScope(s.getAsString())) addScope(part);
                }
            }
        } catch (Throwable t) {
            fatal(mc, "TriggerUnreadable", "触发文件解析失败: " + t, t);
            return;
        }
        if (scope.isEmpty()) {
            scope.addAll(SdeMultiblockPipelineConfig.DEFAULT_SUBSET);
            warnings.add(
                "触发文件未给范围：采用管线默认验收子集（风险 7 裁决）" + SdeMultiblockPipelineConfig.DEFAULT_SUBSET + "；全量（all）留给用户裁定后的终验。");
        }
        if (scope.size() == 1 && "all".equalsIgnoreCase(scope.get(0))) scopeIsAll = true;

        SdeMultiblockConfig.load(new File(new File(mc.mcDataDir, "config"), "sde_multiblock.cfg"));

        SdeMultiblockPipelineConfig.ConfCheck cc = SdeMultiblockPipelineConfig.checkCohfConf();
        if (!cc.ok) {
            warnings.add(
                "CoFH MCP conf 前置检查未命中（" + cc.emptyCandidates.size()
                    + " 个候选目录存在但无 .srg）：本次能跑到这里说明 CoFH 没卡住，但无人值守仍应先按 hint 修好目录联接。");
        }

        FMLLog.info(
            "[SDE][T1.6] 管线启动 label=%s 范围=%s（%d 台）专用世界=%s 展开校验=%s",
            label,
            scopeIsAll ? "all" : scope.toString(),
            Integer.valueOf(scope.size()),
            worldFolder,
            expandedEnabled ? ("on/随机 " + expandedRandom + " 组") : "off");
        FMLLog.info(
            "[SDE][T1.6] CoFH conf 检查: ok=%s found=%s 候选=%d",
            Boolean.valueOf(cc.ok),
            cc.found,
            Integer.valueOf(cc.candidates.size()));
        toPhase(Phase.JOIN);
        joinStartMs = System.currentTimeMillis();
        FMLLog.info("[SDE][T1.6] 初始化耗时 %d ms", Long.valueOf(System.currentTimeMillis() - t0));
    }

    private static void addScope(String s) {
        String t = s == null ? "" : s.trim();
        if (!t.isEmpty()) scope.add(t);
    }

    // ------------------------------------------------------------------ ② 进世界（留白 #7）

    private static void join(Minecraft mc) {
        if (mc.theWorld != null) {
            toPhase(Phase.WAIT_WORLD);
            return;
        }
        if (!(mc.currentScreen instanceof GuiMainMenu)) {
            // 还没有到主菜单（仍在加载）：等下一 tick
            return;
        }
        File levelDat = new File(new File(mc.mcDataDir, "saves"), worldFolder + File.separator + "level.dat");
        boolean exists = levelDat.isFile();
        worldAction = exists ? "reused" : "created";
        mc.displayGuiScreen(null);
        if (exists) {
            FMLLog.info("[SDE][T1.6] 复用专用世界 folder=%s", worldFolder);
            mc.launchIntegratedServer(worldFolder, worldDisplay, null);
        } else {
            FMLLog.info("[SDE][T1.6] 新建专用世界 folder=%s（超平坦 + 创造 + 允许命令）", worldFolder);
            WorldSettings ws = new WorldSettings(
                SdeMultiblockPipelineConfig.DEDICATED_WORLD_SEED,
                WorldSettings.GameType.CREATIVE,
                false,
                false,
                WorldType.FLAT);
            ws.enableCommands();
            mc.launchIntegratedServer(worldFolder, worldDisplay, ws);
        }
        toPhase(Phase.WAIT_WORLD);
    }

    private static void waitWorld(Minecraft mc) {
        if (mc.theWorld == null || mc.thePlayer == null || mc.currentScreen != null) return;
        phaseTicks++;
        // 世界刚起来时区块/注册表还在活动，静置 40 tick（约 2 s）再发命令，避免命令被吞。
        if (phaseTicks < 40) return;
        worldReadyMs = System.currentTimeMillis();
        FMLLog.info(
            "[SDE][T1.6] 已进入世界（%s）: %s，进世界耗时 %d ms",
            worldAction,
            String.valueOf(
                mc.theWorld.getWorldInfo() == null ? "?"
                    : mc.theWorld.getWorldInfo()
                        .getWorldName()),
            Long.valueOf(worldReadyMs - joinStartMs));
        toPhase(Phase.COMMAND);
    }

    // ------------------------------------------------------------------ ③ 执行 /sde multiblock

    private static void sendCommand(Minecraft mc) {
        String scopeArg = scopeIsAll ? "all" : joinStrings(scope, ",");
        commandLine = "/sde multiblock " + scopeArg;
        if (limit > 0) commandLine += " limit=" + limit;
        reportMtimeBefore = reportFile(mc).isFile() ? reportFile(mc).lastModified() : -1L;
        FMLLog.info("[SDE][T1.6] 发送命令: %s", commandLine);
        mc.thePlayer.sendChatMessage(commandLine);
        commandSentMs = System.currentTimeMillis();
        toPhase(Phase.WAIT_PENDING);
    }

    /** 命令是否已被服务端受理（SdeMultiblockConfig 出现待执行请求）。 */
    private static void waitPending(Minecraft mc) {
        if (SdeMultiblockConfig.hasPendingExport()) {
            FMLLog.info("[SDE][T1.6] 命令已被受理，待执行导出请求已登记");
            toPhase(Phase.EXPORT);
            return;
        }
        phaseTicks++;
        if (resendTicks < 0 && phaseTicks >= 60) {
            resendTicks = phaseTicks;
            FMLLog.warning("[SDE][T1.6] 命令 60 tick 未被受理，重发一次: %s", commandLine);
            mc.thePlayer.sendChatMessage(commandLine);
            return;
        }
        if (!fallbackUsed && phaseTicks >= 120) {
            fallbackUsed = true;
            warnings.add(
                "聊天命令 " + commandLine
                    + " 在 120 tick 内没有产生待执行请求（最近聊天："
                    + recentChat()
                    + "）；已回退到直接 SdeMultiblockConfig.requestExport —— 命令路径与权限需复核（很可能不是 OP）。");
            FMLLog.warning("[SDE][T1.6] %s", warnings.get(warnings.size() - 1));
            SdeMultiblockConfig.requestExport(scopeIsAll ? "" : joinStrings(scope, ","), "pipeline-fallback");
            if (limit > 0) SdeMultiblockConfig.maxExportMachines = limit;
            return;
        }
        if (phaseTicks >= 400) {
            fatal(
                mc,
                "CommandNotAccepted",
                "命令 " + commandLine + " 在 400 tick 内未产生待执行请求（最近聊天：" + recentChat() + "）",
                null);
        }
    }

    // ------------------------------------------------------------------ ④ 跑导出

    private static void runExport(Minecraft mc) {
        if (SdeMultiblockConfig.hasPendingExport()) {
            exportAttempts++;
            long t0 = System.currentTimeMillis();
            FMLLog.info("[SDE][T1.6] 开始执行导出（第 %d 次尝试）", Integer.valueOf(exportAttempts));
            MultiblockExportAutomation.tick(mc);
            FMLLog.info("[SDE][T1.6] 导出执行返回，耗时 %d ms", Long.valueOf(System.currentTimeMillis() - t0));
        }
        phaseTicks++;
        if (exportObserved(mc)) {
            toPhase(Phase.FINALIZE);
            return;
        }
        // 导出可能因屏幕状态被推迟：给它 30 tick 的宽限，之后按失败落盘（不静默跳过）。
        if (phaseTicks < 30) return;
        File failed = latestFailureFile(mc);
        if (failed != null) {
            fatal(mc, "ExportThrew", "导出未刷新报告，落盘失败文件: " + failed.getName() + " → " + readQuiet(failed), null);
            return;
        }
        if (SdeMultiblockConfig.hasPendingExport()) {
            if (exportAttempts < 3) {
                phaseTicks = 0;
                return;
            }
            fatal(mc, "ExportNeverRan", "待执行请求仍未被消费（尝试 " + exportAttempts + " 次）", null);
            return;
        }
        fatal(mc, "ExportReportNotRefreshed", "导出既没有刷新 " + MultiblockExportRunner.REPORT_FILE + "，也没有落失败文件", null);
    }

    /** 报告是否已由**本次**导出刷新（时间戳 + finishedAtEpochMs 双重判据）。 */
    private static boolean exportObserved(Minecraft mc) {
        File rf = reportFile(mc);
        if (!rf.isFile()) return false;
        if (reportMtimeBefore >= 0 && rf.lastModified() == reportMtimeBefore) return false;
        try {
            JsonObject o = new JsonParser().parse(MultiblockExportRunner.readText(rf))
                .getAsJsonObject();
            long fin = o.has("finishedAtEpochMs") ? o.get("finishedAtEpochMs")
                .getAsLong() : 0L;
            return fin >= commandSentMs;
        } catch (Throwable t) {
            return false;
        }
    }

    // ------------------------------------------------------------------ ⑤⑥ 收尾：结果 + 退出码

    private static void finalizeRun(Minecraft mc) {
        if (finalized) return;
        finalized = true;
        long t0 = System.currentTimeMillis();
        File outDir = outDir(mc);
        JsonObject report = readExportReport(mc);
        // 「本次到底有没有跑过导出」的判据：命令发出去过、且导出阶段真的驱动过一次。
        // 否则报告可能是**上一轮的遗留**，绝不能拿它当本轮成败依据（那才是静默通过）。
        if (commandSentMs == 0 || exportAttempts == 0) {
            pipelineFailures.add(
                pipelineFailure(
                    "pipeline/" + phase,
                    "ExportNotAttempted",
                    "本轮从未真正驱动过导出（commandSentMs=" + commandSentMs
                        + ", exportAttempts="
                        + exportAttempts
                        + "）：产物目录里若存在 export-report.json 那是上一轮遗留，不作为本轮结果。",
                    null));
            report = null;
        }

        // ---- 产物清单 + 哈希（以报告为准；目录里多出来的产物记警告） ----
        JsonArray products = new JsonArray();
        Map<String, String> productHashes = new LinkedHashMap<String, String>();
        List<String> productNames = new ArrayList<String>();
        if (report != null && report.has("products")) {
            for (JsonElement pe : report.getAsJsonArray("products")) {
                JsonObject p = pe.getAsJsonObject();
                String name = MultiblockExportRunner.str(p, "productFile");
                if (name.isEmpty()) {
                    name = MultiblockExportRunner.str(p, "sourceSlug") + ".multiblock.json";
                }
                File f = new File(outDir, name);
                JsonObject row = new JsonObject();
                row.addProperty("file", name);
                row.addProperty("slug", MultiblockExportRunner.str(p, "sourceSlug"));
                row.addProperty("machine", MultiblockExportRunner.str(p, "machine"));
                row.addProperty(
                    "variants",
                    p.has("variants") ? p.get("variants")
                        .getAsInt() : -1);
                row.addProperty("bytes", Long.valueOf(f.isFile() ? f.length() : -1L));
                String sha = f.isFile() ? sha256(f) : "";
                row.addProperty("sha256", sha);
                productHashes.put(name, sha);
                productNames.add(name);
                products.add(row);
            }
        }
        List<String> extra = new ArrayList<String>();
        File[] dirFiles = outDir.listFiles();
        if (dirFiles != null) {
            Arrays.sort(dirFiles);
            for (File f : dirFiles) {
                if (!f.isFile()) continue;
                String n = f.getName();
                if (!n.endsWith(".multiblock.json")) continue;
                if (!productNames.contains(n)) extra.add(n);
            }
        }
        if (!extra.isEmpty()) {
            warnings.add("产物目录里存在**本轮报告之外**的 " + extra.size() + " 份 .multiblock.json（上一轮或其它范围的遗留，未纳入本轮哈希清单）：" + extra);
        }

        // ---- 展开形态校验文件（留白 #10） ----
        if (expandedEnabled && report != null) {
            try {
                expandedSummary = MultiblockExpandedVerifier.write(outDir, report, expandedRandom);
                FMLLog.info(
                    "[SDE][T1.6] 展开形态校验文件已写出：%d 台 / %d 组合 / %d 文件 → %s",
                    Integer.valueOf(
                        expandedSummary.get("machines")
                            .getAsInt()),
                    Integer.valueOf(
                        expandedSummary.get("samples")
                            .getAsInt()),
                    Integer.valueOf(
                        expandedSummary.get("files")
                            .getAsInt()),
                    expandedSummary.get("dir")
                        .getAsString());
            } catch (Throwable t) {
                pipelineFailures.add(
                    pipelineFailure(
                        "expanded",
                        "ExpandedWriteFailed",
                        "展开形态校验文件写出失败（T3.3 的 ground-truth 缺失 = 管线失败）: " + t,
                        t));
            }
        } else if (!expandedEnabled) {
            warnings.add("触发文件关闭了展开形态校验文件（expanded.enabled=false）：T3.3 无 ground-truth 可用，非验收形态。");
        }

        // ---- 产物数与请求数的交叉核对（只记警告：T1.5 已为每台缺失产物落 failures[]） ----
        if (report != null) {
            int requested = report.has("requestedMachines") ? report.get("requestedMachines")
                .getAsInt() : -1;
            int exported = report.has("exportedProducts") ? report.get("exportedProducts")
                .getAsInt() : -1;
            if (requested > 0 && exported < requested) {
                warnings.add(
                    "请求 " + requested + " 台但产物只有 " + exported + " 份：逐台原因见 export-report.json.failures[]（管线不静默跳过）。");
            }
        }

        // ---- 变体级告警分列（T1.5 开放项 6：只做只读聚合，不改 T1.5 语义） ----
        JsonObject variantWarnings = new JsonObject();
        if (report != null && report.has("failures")) {
            for (JsonElement fe : report.getAsJsonArray("failures")) {
                String kind = MultiblockExportRunner.str(fe.getAsJsonObject(), "kind");
                variantWarnings.addProperty(
                    kind,
                    Integer.valueOf(
                        variantWarnings.has(kind) ? variantWarnings.get(kind)
                            .getAsInt() + 1 : 1));
            }
        }

        // ---- 失败的「与本次范围是否相关」分类（决定性：退出码只看与本次范围相关的失败） ----
        // 背景（实测）：T1.5 的 readEnumeration 在**读枚举**阶段就会为 T1.2 的两对重名 simpleName 落
        // `scope/DuplicateSlug` 失败（T1.5 开放项 5），**与请求范围无关** —— 只要跑就必落 2 条。
        // 若把它算进退出码，任何子集都会永远非零，管线就失去了「机器判定成败」的能力。
        // 处置：**一条都不隐藏**（failures[] 原样保留全部条目，export-report.json 也不动），
        // 只是额外分列 inScopeFailures / outOfScopeFailures，并把判定口径写在结果文件里。
        JsonArray inScopeFailures = new JsonArray();
        JsonArray outOfScopeFailures = new JsonArray();
        JsonObject outOfScopeByKind = new JsonObject();
        if (report != null && report.has("failures")) {
            for (JsonElement fe : report.getAsJsonArray("failures")) {
                JsonObject f = fe.getAsJsonObject();
                if (failureRelevantToScope(f)) {
                    inScopeFailures.add(f);
                } else {
                    outOfScopeFailures.add(f);
                    String kind = MultiblockExportRunner.str(f, "kind");
                    outOfScopeByKind.addProperty(
                        kind,
                        Integer.valueOf(
                            outOfScopeByKind.has(kind) ? outOfScopeByKind.get(kind)
                                .getAsInt() + 1 : 1));
                }
            }
        }
        if (outOfScopeFailures.size() > 0) {
            warnings.add(
                "有 " + outOfScopeFailures.size()
                    + " 条失败**与本次请求范围无关**（"
                    + outOfScopeByKind
                    + "）：它们是 T1.2 枚举层的既有缺陷（重名 simpleName 的 slug 碰撞，T1.5 开放项 5），"
                    + "T1.5 的 readEnumeration 在读枚举时就落，与 scope 无关 —— 相关机器不在本次范围内。"
                    + "它们**完整保留**在 failures[] 与 export-report.json 里，只是不计入退出码判定；"
                    + "T1.2 修好 slug 消歧后这一项会自然消失。");
        }
        int gatingFailures = inScopeFailures.size() + pipelineFailures.size();

        // ---- 状态与退出码 ----
        String status;
        int code;
        if (!pipelineFailures.isEmpty()) {
            status = "failed";
            code = SdeMultiblockPipelineConfig.EXIT_PIPELINE_FAILED;
        } else if (report == null) {
            pipelineFailures.add(
                pipelineFailure(
                    "pipeline",
                    "ExportReportMissing",
                    "找不到可读的 " + MultiblockExportRunner.REPORT_FILE,
                    null));
            gatingFailures = pipelineFailures.size();
            status = "failed";
            code = SdeMultiblockPipelineConfig.EXIT_PIPELINE_FAILED;
        } else if (gatingFailures != 0) {
            status = "has-failures";
            code = SdeMultiblockPipelineConfig.EXIT_HAS_FAILURES;
        } else {
            status = "ok";
            code = SdeMultiblockPipelineConfig.EXIT_OK;
        }
        if (status.equals("ok") && products.size() == 0) {
            pipelineFailures.add(pipelineFailure("pipeline", "NoProducts", "导出报告无失败但产物为 0 份（不可能，视为管线缺陷）", null));
            status = "failed";
            code = SdeMultiblockPipelineConfig.EXIT_PIPELINE_FAILED;
        }

        // ---- 结构化结果 ----
        JsonObject result = new JsonObject();
        result.addProperty("schema", SdeMultiblockPipelineConfig.SCHEMA);
        result.addProperty("task", "T1.6 游戏内自动导出管线（E 管线的 mod 半环）");
        result.addProperty("label", label);
        result.addProperty("status", status);
        result.addProperty("exitCode", Integer.valueOf(code));
        result.addProperty("requestedBy", requestedBy);
        result.addProperty("startedAtEpochMs", Long.valueOf(startedMs));
        result.addProperty("finishedAtEpochMs", Long.valueOf(System.currentTimeMillis()));
        result.add("environment", environmentJson(mc, outDir));
        result.add("scope", scopeJson());
        JsonObject timing = new JsonObject();
        timing.addProperty("totalMs", Long.valueOf(System.currentTimeMillis() - startedMs));
        timing.addProperty(
            "joinWorldMs",
            Long.valueOf(worldReadyMs > 0 ? worldReadyMs - joinStartMs : (System.currentTimeMillis() - joinStartMs)));
        timing.addProperty(
            "commandToFinishMs",
            Long.valueOf(commandSentMs > 0 ? System.currentTimeMillis() - commandSentMs : -1L));
        timing.addProperty("finalizeMs", Long.valueOf(System.currentTimeMillis() - t0));
        if (report != null && report.has("timing")) {
            timing.add("exportReport", report.getAsJsonObject("timing"));
        }
        if (report != null && report.has("captureTotals")) {
            timing.add("captureTotals", report.getAsJsonObject("captureTotals"));
        }
        result.add("timing", timing);
        result.add("products", products);
        result.addProperty(
            "variantsTested",
            report != null && report.has("captureTotals") ? report.getAsJsonObject("captureTotals")
                .get("variants")
                .getAsInt() : -1);
        result.add("productHashes", stringMap(productHashes));
        JsonObject exp = new JsonObject();
        exp.addProperty("enabled", Boolean.valueOf(expandedEnabled));
        exp.addProperty("randomSamplesPerMachine", Integer.valueOf(expandedRandom));
        if (expandedSummary != null) {
            exp.addProperty("dir", MultiblockExportRunner.str(expandedSummary, "dir"));
            exp.addProperty("manifest", MultiblockExportRunner.str(expandedSummary, "manifest"));
            exp.add("machines", expandedSummary.get("machines"));
            exp.add("samples", expandedSummary.get("samples"));
            exp.add("files", expandedSummary.get("files"));
            exp.add("sampleList", expandedSummary.getAsJsonArray("sampleList"));
            exp.add("filesSha256", expandedSummary.getAsJsonArray("filesSha256"));
        }
        result.add("expanded", exp);
        JsonArray failures = new JsonArray();
        if (report != null && report.has("failures")) {
            for (JsonElement fe : report.getAsJsonArray("failures")) failures.add(fe);
        }
        for (JsonObject f : pipelineFailures) failures.add(f);
        result.add("failures", failures);
        result.addProperty("failureCount", Integer.valueOf(failures.size()));
        result.add("inScopeFailures", inScopeFailures);
        result.addProperty("inScopeFailureCount", Integer.valueOf(inScopeFailures.size() + pipelineFailures.size()));
        result.add("outOfScopeFailures", outOfScopeFailures);
        result.addProperty("outOfScopeFailureCount", Integer.valueOf(outOfScopeFailures.size()));
        result.add("outOfScopeFailuresByKind", outOfScopeByKind);
        result.addProperty(
            "exitCodePolicy",
            "退出码只看「与本次请求范围相关的失败」+「管线级失败」：" + "inScopeFailures[]（machine 命中请求范围，或 scope/UnknownMachine 这类「请求了但不存在」）"
                + " + pipeline 级失败 → 非零。与范围无关的既有失败（T1.2 枚举 slug 碰撞，T1.5 开放项 5）"
                + "完整保留在 failures[] 与 outOfScopeFailures[]，不计入退出码 —— 一条都不隐藏。"
                + "范围判定规则见 failureRelevantToScope：all → 全部相关；scope/UnknownMachine 或 machine 为 '-' → 相关；"
                + "否则 machine 需与请求范围里某项（simpleName/fqcn 尾段/slug，忽略大小写）相等。");
        result.add("variantWarnings", variantWarnings);
        result.add("warnings", stringArray(warnings));
        if (report != null) {
            JsonObject er = new JsonObject();
            er.addProperty("path", new File(outDir, MultiblockExportRunner.REPORT_FILE).getAbsolutePath());
            er.addProperty("status", MultiblockExportRunner.str(report, "status"));
            er.addProperty(
                "requestedMachines",
                report.has("requestedMachines") ? report.get("requestedMachines")
                    .getAsInt() : -1);
            er.addProperty(
                "exportedProducts",
                report.has("exportedProducts") ? report.get("exportedProducts")
                    .getAsInt() : -1);
            er.addProperty(
                "failureCount",
                report.has("failureCount") ? report.get("failureCount")
                    .getAsInt() : -1);
            er.addProperty("datasetDir", MultiblockExportRunner.str(report, "datasetDir"));
            er.addProperty("outputDir", MultiblockExportRunner.str(report, "outputDir"));
            er.add(
                "samplingPlan",
                report.has("samplingPlan") ? report.getAsJsonArray("samplingPlan") : new JsonArray());
            er.add("notes", report.has("notes") ? report.getAsJsonArray("notes") : new JsonArray());
            result.add("exportReport", er);
        }
        if (!chatLines.isEmpty()) {
            JsonArray cl = new JsonArray();
            synchronized (chatLines) {
                for (String s : chatLines) cl.add(new JsonPrimitive(s));
            }
            result.add("chatLines", cl);
        }

        try {
            File canonical = resultFile(mc);
            MultiblockExportRunner.writeJson(canonical, result);
            MultiblockExportRunner
                .writeJson(new File(outDir, SdeMultiblockPipelineConfig.RESULT_FILE_IN_OUTDIR), result);
            MultiblockExportRunner.writeJson(new File(outDir, "latest-pipeline-result.json"), result);
            FMLLog.info("[SDE][T1.6] 结构化结果落盘: %s", canonical.getAbsolutePath());
        } catch (Throwable t) {
            FMLLog.log(Level.ERROR, t, "[SDE][T1.6] 结果文件写出失败");
            code = SdeMultiblockPipelineConfig.EXIT_PIPELINE_FAILED;
            status = "failed";
        }

        FMLLog.info(
            "[SDE][T1.6] 管线结束：status=%s exitCode=%d 产物=%d 份 失败=%s 警告=%d 总耗时=%d ms",
            status,
            Integer.valueOf(code),
            Integer.valueOf(products.size()),
            result.get("failureCount"),
            Integer.valueOf(warnings.size()),
            Long.valueOf(System.currentTimeMillis() - startedMs));
        for (JsonElement fe : result.getAsJsonArray("failures")) {
            JsonObject f = fe.getAsJsonObject();
            FMLLog.warning(
                "[SDE][T1.6] 失败: %s / %s / %s / %s",
                MultiblockExportRunner.str(f, "machine"),
                MultiblockExportRunner.str(f, "stage"),
                MultiblockExportRunner.str(f, "kind"),
                MultiblockExportRunner.str(f, "message"));
        }

        if (cleanupTrigger) {
            File trig = triggerFile(mc);
            if (trig.isFile() && !trig.delete()) {
                FMLLog.warning("[SDE][T1.6] 未能删除触发文件: %s", trig.getAbsolutePath());
            }
        }
        requestExit(mc, code);
        phase = Phase.DONE;
    }

    // ------------------------------------------------------------------ 失败与退出

    private static void fatal(Minecraft mc, String kind, String message, Throwable t) {
        if (finalized) return;
        FMLLog.log(Level.ERROR, t, "[SDE][T1.6] 管线致命失败 [%s] %s", kind, message);
        pipelineFailures.add(pipelineFailure("pipeline/" + phase, kind, message, t));
        finalizeRun(mc);
    }

    /**
     * 退出与**退出码落定**（实测踩坑，见报告 §退出码）：
     * <p>
     * FML 装了 {@code FMLSecurityManager}，它把非 {@code cpw.mods.fml.*} / 非 {@code Minecraft} 自身发起的
     * {@code exitVM} 权限请求直接抛 {@code ExitTrappedException} —— 自定义类里调
     * {@code Runtime.getRuntime().halt(code)} 会被**静默拦掉**（实测：日志里一句
     * {@code FMLSecurityManager$ExitTrappedException}，进程仍以 0 退出）。唯一稳的路子是
     * {@link FMLCommonHandler#exitJava(int, boolean)}：它从 {@code cpw.mods.fml.common} 发起，
     * 在放行名单内。
     * <p>
     * 因此：
     * <ul>
     * <li>{@code code == 0}：走 {@code Minecraft.shutdown()} 的正常收尾（世界落盘，main 返回 0）；</li>
     * <li>{@code code != 0}：直接 {@code exitJava(code, false)}（结果文件已 flush；专用世界是抛容器，
     * 不落盘不影响任何产物）；</li>
     * <li>两条路都挂一个安全网线程：{@code EXIT_WATCHDOG_MS} 后 {@code exitJava(code, true)}
     * （hardExit = 真正 halt），无人值守下绝不挂死外层编排。</li>
     * </ul>
     */
    private static void requestExit(Minecraft mc, final int code) {
        exitCode = code;
        Thread watchdog = new Thread(new Runnable() {

            @Override
            public void run() {
                try {
                    Thread.sleep(SdeMultiblockPipelineConfig.EXIT_WATCHDOG_MS);
                } catch (InterruptedException ignored) {
                    return; // 正常退出时本线程随 JVM 一起结束
                }
                FMLLog.warning(
                    "[SDE][T1.6] 退出安全网触发（%d ms 内未结束），强制 exitJava(%d, hardExit=true)",
                    Long.valueOf(SdeMultiblockPipelineConfig.EXIT_WATCHDOG_MS),
                    Integer.valueOf(code));
                FMLCommonHandler.instance()
                    .exitJava(code, true);
            }
        }, "sde-pipeline-exit-watchdog");
        watchdog.setDaemon(true);
        watchdog.start();

        FMLLog.info("[SDE][T1.6] 请求退出游戏，退出码 %d", Integer.valueOf(code));
        if (code == SdeMultiblockPipelineConfig.EXIT_OK) {
            mc.shutdown();
        } else {
            FMLCommonHandler.instance()
                .exitJava(code, false);
        }
    }

    // ------------------------------------------------------------------ 小工具

    private static void toPhase(Phase next) {
        FMLLog.info("[SDE][T1.6] 阶段 %s → %s", phase, next);
        phase = next;
        phaseStartedMs = System.currentTimeMillis();
        phaseTicks = 0;
    }

    private static String joinStrings(List<String> list, String sep) {
        StringBuilder sb = new StringBuilder();
        for (String s : list) {
            if (sb.length() > 0) sb.append(sep);
            sb.append(s);
        }
        return sb.toString();
    }

    private static File outDir(Minecraft mc) {
        String name = SdeMultiblockConfig.outputDirName == null || SdeMultiblockConfig.outputDirName.trim()
            .isEmpty() ? "sde_multiblock_exports" : SdeMultiblockConfig.outputDirName.trim();
        return new File(mc.mcDataDir, name);
    }

    private static File reportFile(Minecraft mc) {
        return new File(outDir(mc), MultiblockExportRunner.REPORT_FILE);
    }

    private static JsonObject readExportReport(Minecraft mc) {
        File rf = reportFile(mc);
        if (!rf.isFile()) return null;
        try {
            return new JsonParser().parse(MultiblockExportRunner.readText(rf))
                .getAsJsonObject();
        } catch (Throwable t) {
            FMLLog.log(Level.WARN, t, "[SDE][T1.6] 读 export-report.json 失败");
            return null;
        }
    }

    /** 最新的 {@code failure-*.json}（T1.5 在「run 抛异常、报告没写成」时落的那种）。 */
    private static File latestFailureFile(Minecraft mc) {
        File dir = outDir(mc);
        File[] files = dir.listFiles();
        if (files == null) return null;
        File best = null;
        for (File f : files) {
            String n = f.getName();
            if (!f.isFile() || !n.startsWith("failure-") || !n.endsWith(".json")) continue;
            if (f.lastModified() < commandSentMs) continue;
            if (best == null || f.lastModified() > best.lastModified()) best = f;
        }
        return best;
    }

    private static String readQuiet(File f) {
        try {
            return MultiblockExportRunner.readText(f);
        } catch (Throwable t) {
            return "<读取失败: " + t + ">";
        }
    }

    private static String sha256(File f) {
        try {
            return VariantCaptureRunner.sha256Hex(MultiblockExportRunner.readText(f));
        } catch (Throwable t) {
            return "sha256-error:" + t;
        }
    }

    private static String recentChat() {
        synchronized (chatLines) {
            if (chatLines.isEmpty()) return "<无服务端聊天回包>";
            int from = Math.max(0, chatLines.size() - 3);
            StringBuilder sb = new StringBuilder();
            for (int i = from; i < chatLines.size(); i++) {
                if (sb.length() > 0) sb.append(" | ");
                sb.append(chatLines.get(i));
            }
            return sb.toString();
        }
    }

    /**
     * 一条失败是否**与本次请求范围相关**（退出码的判定口径，见结果文件 {@code exitCodePolicy}）。
     * <ul>
     * <li>{@code all}：一切都是相关的（严格）；</li>
     * <li>{@code scope/UnknownMachine}：请求了但枚举里不存在的名字 —— **正是要诊断的失败**，当然相关；</li>
     * <li>machine 字段为 {@code -}（全局阶段，如数据集不可读）：相关；</li>
     * <li>其余：machine 命中请求范围的名字（不区分大小写、simpleName/fqcn/slug 任一形态）才算相关。</li>
     * </ul>
     */
    static boolean failureRelevantToScope(JsonObject failure) {
        if (scopeIsAll) return true;
        String machine = MultiblockExportRunner.str(failure, "machine");
        String stage = MultiblockExportRunner.str(failure, "stage");
        String kind = MultiblockExportRunner.str(failure, "kind");
        if (machine.isEmpty() || "-".equals(machine)) return true;
        if ("scope".equals(stage) && "UnknownMachine".equals(kind)) return true;
        String m = machine.toLowerCase();
        for (String s : scope) {
            String t = s.toLowerCase();
            if (t.equals(m)) return true;
            // fqcn / slug 形态：以请求串的尾段与失败里的 simpleName 互相包含判定
            int dot = t.lastIndexOf('.');
            if (dot >= 0 && t.substring(dot + 1)
                .equals(m)) return true;
        }
        return false;
    }

    private static JsonObject pipelineFailure(String stage, String kind, String message, Throwable t) {
        JsonObject o = new JsonObject();
        o.addProperty("machine", "-");
        o.addProperty("stage", stage);
        o.addProperty("kind", kind);
        o.addProperty("message", message == null ? "" : message);
        if (t != null) o.addProperty("failure", MultiblockScanAutomation.describeChain(t));
        o.addProperty("atEpochMs", Long.valueOf(System.currentTimeMillis()));
        return o;
    }

    private static JsonObject scopeJson() {
        JsonObject o = new JsonObject();
        JsonArray a = new JsonArray();
        for (String s : scope) a.add(new JsonPrimitive(s));
        o.add("requested", a);
        o.addProperty("all", Boolean.valueOf(scopeIsAll));
        o.addProperty("limit", Integer.valueOf(limit));
        o.addProperty("channel", fallbackUsed ? "direct-request(fallback)" : "chat-command");
        o.addProperty("commandLine", commandLine);
        o.addProperty(
            "defaultSubsetUsed",
            Boolean.valueOf(
                scope.size() == SdeMultiblockPipelineConfig.DEFAULT_SUBSET.size()
                    && scope.containsAll(SdeMultiblockPipelineConfig.DEFAULT_SUBSET)));
        return o;
    }

    private static JsonObject environmentJson(Minecraft mc, File outDir) {
        JsonObject o = new JsonObject();
        o.addProperty("mcDataDir", mc.mcDataDir.getAbsolutePath());
        o.addProperty("outputDir", outDir.getAbsolutePath());
        o.addProperty(
            "os",
            System.getProperty("os.name") + " "
                + System.getProperty("os.version")
                + " / java "
                + System.getProperty("java.version"));
        o.addProperty("userHome", System.getProperty("user.home", ""));
        String qr = System.getProperty("fml.queryResult");
        o.addProperty("fmlQueryResult", qr == null ? "<未设置>" : qr);
        if (qr == null) {
            warnings.add("JVM 未设置 -Dfml.queryResult=confirm：进含缺失模组的存档时会与 FML 确认框互锁（本次用专用干净世界规避）。");
        }
        SdeMultiblockPipelineConfig.ConfCheck cc = SdeMultiblockPipelineConfig.checkCohfConf();
        JsonObject c = new JsonObject();
        c.addProperty("ok", Boolean.valueOf(cc.ok));
        c.addProperty("found", cc.found);
        c.addProperty("hint", cc.hint);
        JsonArray cand = new JsonArray();
        for (String s : cc.candidates) cand.add(new JsonPrimitive(s));
        c.add("candidates", cand);
        JsonArray empty = new JsonArray();
        for (String s : cc.emptyCandidates) empty.add(new JsonPrimitive(s));
        c.add("candidatesWithoutSrg", empty);
        o.add("cofhConfCheck", c);
        JsonObject w = new JsonObject();
        w.addProperty("mode", "dedicated-clean-world");
        w.addProperty("folder", worldFolder);
        w.addProperty("displayName", worldDisplay);
        w.addProperty("action", worldAction);
        w.addProperty("worldType", "FLAT");
        w.addProperty("gameType", "CREATIVE");
        w.addProperty("commandsAllowed", Boolean.TRUE);
        w.addProperty("seed", Long.valueOf(SdeMultiblockPipelineConfig.DEDICATED_WORLD_SEED));
        w.addProperty("saveDir", new File(new File(mc.mcDataDir, "saves"), worldFolder).getAbsolutePath());
        w.addProperty("note", "留白 #7 拍板：专用干净世界（不存在则新建 / 存在则复用），绝不加载玩家存档（T0.3 §4.4(2)）");
        o.add("world", w);
        JsonObject cfg = new JsonObject();
        cfg.addProperty("structuralCompression", Boolean.valueOf(SdeMultiblockConfig.structuralCompression));
        cfg.addProperty("maxVariantsPerMachine", Integer.valueOf(SdeMultiblockConfig.maxVariantsPerMachine));
        cfg.addProperty("maxChannelValues", Integer.valueOf(SdeMultiblockConfig.maxChannelValues));
        cfg.addProperty("maxExportMachines", Integer.valueOf(SdeMultiblockConfig.maxExportMachines));
        cfg.addProperty("structuralOnly", Boolean.valueOf(SdeMultiblockConfig.structuralOnly));
        cfg.addProperty("outputDirName", SdeMultiblockConfig.outputDirName);
        cfg.addProperty("globalBudgetMs", Long.valueOf(SdeMultiblockConfig.globalBudgetMs));
        cfg.addProperty("loadedFrom", SdeMultiblockConfig.loadedFrom());
        o.add("sdeMultiblockConfig", cfg);
        return o;
    }

    private static JsonObject stringMap(Map<String, String> in) {
        JsonObject o = new JsonObject();
        for (Map.Entry<String, String> e : in.entrySet()) o.addProperty(e.getKey(), e.getValue());
        return o;
    }

    private static JsonArray stringArray(List<String> in) {
        JsonArray a = new JsonArray();
        for (String s : in) a.add(new JsonPrimitive(s));
        return a;
    }
}
