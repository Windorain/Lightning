package com.lightning.mod.client.controlplane.mc;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import net.minecraft.client.Minecraft;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.Contract;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.CriteriaEngine;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;

import cpw.mods.fml.common.FMLCommonHandler;

/**
 * {@code core.shutdown}（scene，同步）：<b>无人值守收尾原语</b>——跑完固定程序后把结论落成
 * 进程退出码，然后结束客户端。
 *
 * <h2>为什么需要它（职责空白）</h2>
 * 老批处理设施（{@code MultiblockPipelineAutomation} 等，已删除）把「跑完 → 落结果文件 → 以退出码结束进程」
 * 做成一件事，外层脚本据此判红绿。那些设施整体删除后，控制面成了唯一入口，而
 * {@code grep mc.shutdown|exitJava|exitCode} 在 {@code client/controlplane/} 里<b>零命中</b>
 * ——无人值守编排拿不到任何稳定的进程级信号，只能靠轮询 HTTP 猜「跑完了没、绿没绿」。
 * 本动作补上这一格。
 *
 * <h2>退出码约定（与 {@code evidence.overall} 对齐，0/2/3）</h2>
 * <table>
 * <tr>
 * <td>{@code 0}</td>
 * <td>判据全绿（{@code evidence.overall == "green"}）——这一次固定程序过了</td>
 * </tr>
 * <tr>
 * <td>{@code 2}</td>
 * <td>有红（{@code evidence.overall != "green"}）——跑完了但结论不满足</td>
 * </tr>
 * <tr>
 * <td>{@code 3}</td>
 * <td>设施错误——连「绿没绿」都读不出来（run 目录/evidence.json 缺失、
 * 非法 JSON、runId 未知、显式传了 3）</td>
 * </tr>
 * </table>
 * 这三个值与老设施逐字相同（外层脚本可以不改），语义也刻意保持「0=绿、2=红、3=读不出来」这一条
 * 分界——把「结论红」与「设施坏」混成一个非零码，是让自动化无法自诊断的最快方式。
 *
 * <h2>退出纪律（无人值守的硬要求，照抄已实测的口径）</h2>
 * FML 装了 {@code FMLSecurityManager}，它把非 {@code cpw.mods.fml.*} 发起的 {@code exitVM} 权限请求
 * 直接抛 {@code ExitTrappedException}——自定义类里调 {@code Runtime.getRuntime().halt(code)} 会被
 * <b>静默拦掉</b>（实测：日志里一句 {@code FMLSecurityManager$ExitTrappedException}，进程仍以 0 退出，
 * 外层脚本因此把一次红跑读成绿跑）。唯一稳的路子是
 * {@link FMLCommonHandler#exitJava(int, boolean)}（它从 {@code cpw.mods.fml.common} 发起，在放行名单内）。
 * 因此本动作：
 * <ul>
 * <li>{@code code == 0}：走 {@link Minecraft#shutdown()} 的正常收尾（世界落盘，main 返回 0）；
 * 但如果世界还开着，先离图——离图会阻塞数秒到数十秒（契约 §10 第 12 条），故它放在<b>延迟线程</b>里；</li>
 * <li>{@code code != 0}：直接 {@code exitJava(code, false)}（结果文件已 flush；托管世界是抛容器，
 * 不落盘不影响任何产物）；</li>
 * <li>两条路都先挂一个安全网线程：{@link #EXIT_WATCHDOG_MS} 后 {@code exitJava(code, true)}
 * （hardExit = 真正 halt），保证无人值守下绝不挂死外层编排；</li>
 * <li><b>绝不用</b> {@code Runtime.halt} / {@code System.exit}。</li>
 * </ul>
 *
 * <h2>为什么要延迟，而不是就地退出</h2>
 * 本动作是 HTTP 动作：作业结果要经 {@code POST /cp/v1/actions/core.shutdown} 的响应体回给调用方，
 * 而响应是在动作返回<b>之后</b>才写的。就地退出会把调用方吊死在一个永远不来的响应上
 * （而它正是要靠这个响应知道退出码）。因此实际退出跑在延迟 {@link #DEFAULT_DELAY_MS} 的守护线程里，
 * 结果 JSON 里如实给出 {@code exitScheduledInMs}。老设施不需要这一步是因为它们的触发不走 HTTP。
 *
 * <h2>可判定性：{@code dryRun}</h2>
 * {@code dryRun:true} 只做「读 run → 定码 → 报告」，<b>不</b>排定退出。它是本动作唯一的自证手段：
 * 「退出码与 evidence.overall 对齐」这条口径可以在不杀进程的前提下逐条核对
 * （实机证据见归档记录）。交互模式下也应当先用它看清码再决定退不退。
 *
 * <h2>不许编入固定程序</h2>
 * 本动作<b>不得</b>出现在用例的 {@code action} 段里（{@code CaseValidator.ACTION_FORBIDDEN}）：
 * 它会让本作业后续段不再执行。收尾由驱动在整跑结束后单独发起。
 */
public final class ShutdownAction implements ControlAction {

    /** 动作名。 */
    public static final String NAME = "core.shutdown";

    /** 退出码：判据全绿。 */
    public static final int EXIT_OK = 0;

    /** 退出码：有红（跑完了但结论不满足）。 */
    public static final int EXIT_RED = 2;

    /** 退出码：设施错误（连结论都读不出来）。 */
    public static final int EXIT_FACILITY = 3;

    /** 结果文件（run 目录内相对路径）：退出码的对齐依据之一。 */
    public static final String EVIDENCE_PATH = "evidence.json";

    /**
     * 结果文件（run 目录内相对路径）：退出码的<b>另一个</b>对齐依据。
     *
     * <p>
     * 两份都读——它们的语义不同（判据结论 vs 期望证据核对），任一非绿即红。
     * 只读其一是实机擒获的缺陷（见 {@link #readOverall}）。
     */
    public static final String CRITERIA_PATH = "criteria.json";

    /** 默认延迟（毫秒）：留足时间让 HTTP 响应写回调用方。 */
    public static final long DEFAULT_DELAY_MS = 1500L;

    /** 退出安全网：请求退出后若 JVM 仍未结束，用 {@code exitJava(code, true)} 强制结束。 */
    public static final long EXIT_WATCHDOG_MS = 120000L;

    /** 已排定的退出码（进程内可见；未排定或 dryRun 时为 null）。 */
    private static volatile Integer requestedExitCode;

    @Override
    public JsonObject execute(ActionContext ctx) {
        boolean dryRun = ctx.optBool("dryRun", false);
        Integer explicit = ctx.has("code") ? Integer.valueOf(ctx.optInt("code", -1)) : null;
        checkCode(explicit, "code");
        String runId = ctx.optString("runId", null);
        String caseId = ctx.optString("caseId", null);
        long delayMs = ctx.optLong("delayMs", DEFAULT_DELAY_MS);
        String reason = ctx.optString("reason", null);

        Verdict v = resolveVerdict(ctx, explicit, runId, caseId);

        JsonObject o = new JsonObject();
        o.addProperty("schema", "lightning.cp-shutdown/1");
        o.addProperty("action", NAME);
        o.addProperty("contractVersion", Contract.VERSION);
        o.addProperty("code", Integer.valueOf(v.code));
        o.addProperty("codeMeaning", meaning(v.code));
        o.addProperty("source", v.source);
        o.addProperty("runOverall", v.overall);
        o.addProperty("criteriaOverall", v.criteriaOverall);
        o.addProperty("evidenceOverall", v.evidenceOverall);
        o.addProperty("runId", v.runId);
        o.addProperty("caseId", v.caseId);
        o.addProperty("evidencePath", v.evidencePath);
        if (v.detail != null) {
            o.addProperty("detail", v.detail);
        }
        if (reason != null) {
            o.addProperty("reason", reason);
        }
        o.addProperty("exitCodeConvention", "0=判据全绿 / 2=有红 / 3=设施错误（与 evidence.overall 对齐）");
        o.addProperty("dryRun", Boolean.valueOf(dryRun));

        if (dryRun) {
            o.addProperty("exitScheduled", false);
            o.addProperty("note", "dryRun：只定码与报告，不排定退出（用它可以不杀进程地核对码与 evidence.overall 的对齐）");
            ctx.emit(
                EventStream.LEVEL_INFO,
                EventStream.Kinds.CASE_SEGMENT,
                NAME + " dryRun：退出码 " + v.code + "（" + meaning(v.code) + "）",
                Json.object("code", Integer.valueOf(v.code), "source", v.source, "runId", v.runId));
            return o;
        }

        long delay = delayMs < 0 ? DEFAULT_DELAY_MS : delayMs;
        scheduleExit(delay, v.code);
        o.addProperty("exitScheduled", true);
        o.addProperty("exitScheduledInMs", Long.valueOf(delay));
        o.addProperty("watchdogMs", Long.valueOf(EXIT_WATCHDOG_MS));
        o.addProperty(
            "exitPath",
            v.code == EXIT_OK ? "Minecraft.shutdown()（正常收尾，世界落盘）"
                : "FMLCommonHandler.exitJava(code, false)（绝不 Runtime.halt：FMLSecurityManager 会静默拦掉它，进程仍以 0 退出）");
        ctx.emit(
            EventStream.LEVEL_WARN,
            EventStream.Kinds.CASE_SEGMENT,
            NAME + "：已排定退出，码 " + v.code + "（" + meaning(v.code) + "），" + delay + "ms 后执行",
            Json.object(
                "code",
                Integer.valueOf(v.code),
                "source",
                v.source,
                "runId",
                v.runId,
                "delayMs",
                Long.valueOf(delay)));
        return o;
    }

    // ------------------------------------------------------------ 定码

    /** 一次定码的结论。 */
    static final class Verdict {

        int code;
        String source;
        String overall;
        String criteriaOverall;
        String evidenceOverall;
        String runId;
        String caseId;
        String evidencePath;
        String detail;
    }

    /**
     * 定码：显式 {@code code} 优先；否则按 {@code runId}/{@code caseId} 读 run 的 {@code evidence.json}
     * 的 {@code overall}；读不出来即 {@link #EXIT_FACILITY}（绝不猜成绿）。
     */
    private static Verdict resolveVerdict(ActionContext ctx, Integer explicit, String runId, String caseId) {
        Path runsRoot = ctx.run() == null || ctx.run()
            .dir() == null ? null
                : ctx.run()
                    .dir()
                    .getParent();
        if (runsRoot == null) {
            // 没有活动 run 时用 mcDataDir 推（HTTP 动作通常没有 run，这是常态而不是异常）
            Minecraft mc = WorldRuntime.mc();
            runsRoot = mc == null || mc.mcDataDir == null ? null : CpPaths.runsRoot(mc.mcDataDir);
        }
        return resolveVerdictIn(runsRoot, explicit, runId, caseId);
    }

    /**
     * 定码的<b>纯函数</b>形态（runsRoot 由调用方给出，因此可脱离 MC 单测）。
     *
     * <p>
     * 「退出码与 evidence.overall 对齐」这条口径是本动作的全部价值所在，而它必须能被离线核对——
     * 否则「0=绿」这句话只能靠实机杀进程去试。因此定码逻辑与 MC 状态解耦：
     * {@link #resolveVerdict} 只负责「runsRoot 从哪来」，本方法负责「怎么定码」。
     */
    static Verdict resolveVerdictIn(Path runsRoot, Integer explicit, String runId, String caseId) {
        Verdict v = new Verdict();
        v.runId = runId;
        v.caseId = caseId;
        if (explicit != null) {
            v.code = explicit.intValue();
            v.source = "explicit";
            if (v.code != EXIT_OK && v.code != EXIT_RED && v.code != EXIT_FACILITY) {
                // 非约定码不拦（外层可能有自己的码），但如实标注来源，避免被当成约定码读
                v.detail = "显式码不在约定集合 {0,2,3} 内——按调用方自己的口径解释，不要当成本动作的约定码";
            }
            return v;
        }

        String resolvedRun = runId;
        if (resolvedRun == null && caseId != null && runsRoot != null) {
            resolvedRun = latestRunOfCase(runsRoot, caseId);
            v.runId = resolvedRun;
            if (resolvedRun == null) {
                v.code = EXIT_FACILITY;
                v.source = "caseId-lookup";
                v.detail = "该 caseId 下找不到任何 run 目录（runsRoot=" + runsRoot + "）";
                return v;
            }
        }
        if (resolvedRun == null) {
            v.code = EXIT_FACILITY;
            v.source = "none";
            v.detail = "没有可读的 run：给 runId 或 caseId，或显式给 code（本动作不猜结论——猜成绿是最坏的失败模式）";
            return v;
        }
        if (runsRoot == null) {
            v.code = EXIT_FACILITY;
            v.source = "runs-root";
            v.detail = "runsRoot 不可用（mcDataDir 未装配）";
            return v;
        }

        Path runDir = runsRoot.resolve(resolvedRun);
        v.evidencePath = runDir.resolve(EVIDENCE_PATH)
            .toString();
        v.source = "run-overall";

        // 合并结论 = criteria.json 与 evidence.json 的「任一非绿即红」
        // （与 CaseRunAction.overall() 同一规则；两份文件的语义不同，见下）。
        String criteriaOverall = readOverall(runDir.resolve(CRITERIA_PATH), "criteria.json", v);
        if (v.code == EXIT_FACILITY) {
            return v;
        }
        String evidenceOverall = readOverall(runDir.resolve(EVIDENCE_PATH), "evidence.json", v);
        if (v.code == EXIT_FACILITY) {
            return v;
        }
        v.criteriaOverall = criteriaOverall;
        v.evidenceOverall = evidenceOverall;
        if (criteriaOverall == null && evidenceOverall == null) {
            v.code = EXIT_FACILITY;
            v.detail = "run 里既无 criteria.json 也无 evidence.json（" + runDir
                + "）：这两份文件是 run 结论的唯一落点，都读不出来即设施错误——本动作绝不因此判绿";
            return v;
        }
        boolean red = false;
        if (criteriaOverall != null && !CriteriaEngine.Verdicts.GREEN.equals(criteriaOverall)) {
            red = true;
        }
        if (evidenceOverall != null && !CriteriaEngine.Verdicts.GREEN.equals(evidenceOverall)) {
            red = true;
        }
        v.overall = red ? CriteriaEngine.Verdicts.RED : CriteriaEngine.Verdicts.GREEN;
        v.code = red ? EXIT_RED : EXIT_OK;
        return v;
    }

    /**
     * 读一份结论文件的 {@code overall}。
     *
     * <h2>为什么必须读<b>两份</b>（实机擒获的缺陷）</h2>
     * 两份文件的语义不同，<b>不可互替</b>：
     * <ul>
     * <li>{@code criteria.json.overall} = <b>用例声明的判据</b>的结论（跑绿了没）；</li>
     * <li>{@code evidence.json.overall} = {@code evidence} 段的<b>期望证据核对</b>结论（该在场的产物在不在）。</li>
     * </ul>
     * 首版只读 {@code evidence.json}——实机当场照出它的后果：一次 {@code l1-orchestration} 的
     * {@code criteria.overall=red}（2 条判据红）而 {@code evidence.overall=green}（12 项期望产物齐备），
     * 于是本动作会返回 <b>0「判据全绿」</b>——正是要防的「把一次红跑读成绿跑」。
     *
     * <p>
     * 合并规则与 {@code CaseRunAction.overall()} <b>逐字同源</b>：任一非绿即红。
     * 本方法不重造那条规则，只是把它应用到磁盘上的两份文件（run 目录里没有持久化「合并结论」的字段，
     * job result 里的 {@code overall} 只活在内存与响应里）。
     *
     * @return {@code overall} 的值；文件不存在返回 null（不是错误——另一份可能就够）；
     *         文件在但读不了/形态不符 ⇒ 置 {@code v.code = EXIT_FACILITY} 并返回 null
     */
    private static String readOverall(Path path, String label, Verdict v) {
        if (!Files.isRegularFile(path)) {
            return null;
        }
        JsonObject doc;
        try {
            doc = Json.parseStrictObject(new String(Files.readAllBytes(path), StandardCharsets.UTF_8));
        } catch (IOException e) {
            v.code = EXIT_FACILITY;
            v.detail = "读取 " + label + " 失败: " + e.getMessage();
            return null;
        } catch (RuntimeException e) {
            v.code = EXIT_FACILITY;
            v.detail = label + " 不是合法 JSON: " + e.getMessage();
            return null;
        }
        String overall = Json.optString(doc, "overall", null);
        if (overall == null) {
            v.code = EXIT_FACILITY;
            v.detail = label + " 没有 overall 字段（形态不符）: " + path;
            return null;
        }
        return overall;
    }

    /** runs 根下该 caseId 最新的 run 目录名（按名称排序，即时间序）；没有返回 null。 */
    static String latestRunOfCase(Path runsRoot, String caseId) {
        if (runsRoot == null || caseId == null || !Files.isDirectory(runsRoot)) {
            return null;
        }
        String found = null;
        try {
            for (Path p : Files.newDirectoryStream(runsRoot)) {
                if (!Files.isDirectory(p)) {
                    continue;
                }
                String name = p.getFileName()
                    .toString();
                // runId 形态 <yyyyMMdd-HHmmss>-<caseId>[-<jobSeq>[-n]]：按 caseId 段精确匹配，
                // 不用 contains——否则 cp-a 会命中 cp-ab（这类假命中会让「读错 run」静默发生）
                if (matchesCase(name, caseId) && (found == null || name.compareTo(found) > 0)) {
                    found = name;
                }
            }
        } catch (IOException e) {
            CpLog.warn("枚举 run 目录失败: %s", String.valueOf(e));
            return null;
        }
        return found;
    }

    /**
     * runId 是否属于该 caseId。
     *
     * <p>
     * runId 的形态是 {@code <yyyyMMdd>-<HHmmss>-<caseId>[-<jobSeq>[-n]]}（{@link ArtifactStore#createRun}），
     * 因此要<b>先剥掉前两段时间戳</b>再比 caseId。判定是「剩余部分逐字等于 caseId，或以
     * {@code <caseId>-} 开头」——<b>不是</b> contains：{@code cp-a} 用 contains 会命中
     * {@code cp-ab} 的 run，而「读错 run」在这里会静默变成错的退出码（本动作最不该犯的错）。
     */
    static boolean matchesCase(String runId, String caseId) {
        if (runId == null || caseId == null) {
            return false;
        }
        int first = runId.indexOf('-');
        if (first < 0) {
            return false;
        }
        int second = runId.indexOf('-', first + 1);
        if (second < 0) {
            return false;
        }
        String rest = runId.substring(second + 1);
        return rest.equals(caseId) || rest.startsWith(caseId + "-");
    }

    /** 退出码的人读含义。 */
    static String meaning(int code) {
        if (code == EXIT_OK) {
            return "判据全绿";
        }
        if (code == EXIT_RED) {
            return "有红";
        }
        if (code == EXIT_FACILITY) {
            return "设施错误";
        }
        return "调用方自定义码（不在 0/2/3 约定内）";
    }

    /** 已排定的退出码；未排定或 dryRun 时为 null（诊断/单测用）。 */
    public static Integer requestedExitCode() {
        return requestedExitCode;
    }

    /** 仅供单测：清掉排定状态。 */
    static void resetForTest() {
        requestedExitCode = null;
    }

    // ------------------------------------------------------------ 退出

    /**
     * 排定退出：守护线程延迟 {@code delayMs} 后按纪律退出，并先挂安全网。
     *
     * <p>
     * 守护线程而非 tick 计数：本动作跑在客户端 tick 线程，而延迟必须让 HTTP 响应先写回
     * （响应在动作返回之后才生成）。守护线程不持有任何 MC 状态，只是「等一会儿再退」。
     * 若这段时间里进程因别的原因结束，守护线程随 JVM 一起消失（{@code setDaemon(true)}）。
     */
    static void scheduleExit(final long delayMs, final int code) {
        requestedExitCode = Integer.valueOf(code);
        Thread watchdog = new Thread(new Runnable() {

            @Override
            public void run() {
                try {
                    Thread.sleep(EXIT_WATCHDOG_MS);
                } catch (InterruptedException ignored) {
                    return; // 正常退出时本线程随 JVM 一起结束
                }
                CpLog.warn(
                    "%s 退出安全网触发（%d ms 内未结束），强制 exitJava(%d, hardExit=true)",
                    NAME,
                    Long.valueOf(EXIT_WATCHDOG_MS),
                    Integer.valueOf(code));
                FMLCommonHandler.instance()
                    .exitJava(code, true);
            }
        }, "sde-cp-exit-watchdog");
        watchdog.setDaemon(true);
        watchdog.start();

        Thread closer = new Thread(new Runnable() {

            @Override
            public void run() {
                if (delayMs > 0) {
                    try {
                        Thread.sleep(delayMs);
                    } catch (InterruptedException ignored) {
                        Thread.currentThread()
                            .interrupt();
                    }
                }
                CpLog.info("%s 请求退出游戏，退出码 %d（%s）", NAME, Integer.valueOf(code), meaning(code));
                try {
                    if (code == EXIT_OK) {
                        Minecraft mc = WorldRuntime.mc();
                        if (mc != null) {
                            mc.shutdown();
                            return;
                        }
                    }
                } catch (Throwable t) {
                    CpLog.warn("%s 正常收尾失败（转 exitJava）: %s", NAME, String.valueOf(t));
                }
                FMLCommonHandler.instance()
                    .exitJava(code, false);
            }
        }, "sde-cp-shutdown");
        closer.setDaemon(true);
        closer.start();
    }

    /** 参数校验兜底（错误码口径与其它可写动作一致）。 */
    static void checkCode(Integer code, String field) {
        if (code == null) {
            return;
        }
        if (code.intValue() < 0 || code.intValue() > 127) {
            throw CpException.param("退出码越界", field, "须在 0..127（进程退出码是 8 位无符号），收到 " + code);
        }
    }
}
