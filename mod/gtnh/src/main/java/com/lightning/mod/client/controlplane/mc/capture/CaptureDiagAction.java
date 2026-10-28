package com.lightning.mod.client.controlplane.mc.capture;

import java.util.List;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ArtifactStore;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.Tier;
import com.lightning.mod.client.controlplane.core.TimeSource;

/**
 * {@code capture.diag}（observe，同步）：捕获通道自证诊断的<b>布防/撤防与 drain-dump</b> 入口
 * （职责迁移）。
 *
 * <h2>为什么这一半必须是「动作」而不是「读面」</h2>
 * 读面 {@code read.capture} 只读；而「让录窗真的开始记」这件事有<b>副作用</b>——它翻转录窗总开关、
 * 开诊断会话、布防 TESR drain 汇。把它塞进读面会让「读面调用前后世界不变」这条纪律失去意义
 * （读面在 B1 验收里靠的正是「无副作用」）。因此拆成两个动作：
 * <ul>
 * <li>{@code read.capture}：只读读数（可自由轮询，包括采集进行中）；</li>
 * <li>{@code capture.diag}（本动作）：布防/撤防 + 把 drain 到的实录几何装配成 V2 场景文档落 run。</li>
 * </ul>
 *
 * <h2>权限级：为什么是 OBSERVE（而不是 SCENE/FORENSIC）</h2>
 * 老探针的诊断布防<b>不改世界、不改渲染结果</b>：它只让录窗层开始计数（几何仍然关闭即丢，除非显式
 * 要 drain-dump）。{@link Tier#OBSERVE} 是「只读观察」，本动作的副作用面全部落在<b>观察条件</b>上——
 * 这正是「诊断」的定义。相对地，{@code shot.multi} 是 forensic（它真的驱动渲染、落图）。
 * 若把它提到 SCENE，则「采集诊断」这件事会被迫带上 {@code confirm:true}，而它在无人值守流程里
 * 恰恰是<b>排障第一步</b>——排障工具不该比被测对象更难拿。
 *
 * <h2>与 {@code capture.begin} 的区别（两者不是同一件事）</h2>
 * {@code capture.begin}/{@code capture.end} 是<b>世界写封锁</b>（取证期间世界不得漂移）；
 * 本动作是<b>观察条件布防</b>（录窗与诊断会话）。两者正交：可以只开诊断不封锁世界
 * （排障场景），也可以只封锁世界不采诊断（既有 {@code case.run} capture 段）。
 * 因此本动作<b>不</b>碰 {@code CaptureSession}，也不被它拦。
 *
 * <h2>三种调用形态（同一动作，按参数分支）</h2>
 * <ol>
 * <li>{@code {"arm":true}}（默认）：布防——录窗 + 诊断会话（{@code reset} 决定是否清零）；</li>
 * <li>{@code {"arm":false}}：撤防——关会话 + 撤汇 + 撤录窗（<b>不清计数、不清汇</b>，
 * 已采到的证据必须仍可读、可 dump）；</li>
 * <li>{@code {"arm":true,"dump":true}} 或 {@code {"dump":true}}：在布防态下把 drain 汇里的实录几何
 * 装配成 web 可加载的 V2 场景文档并落 run 目录（{@code capture/diag-dump.json}，登记哈希进清单）。
 * 这一步是唯一产生产物的一步（产物显式）。</li>
 * </ol>
 *
 * <h2>忠实边界（与老探针逐字同源，既有禁条）</h2>
 * dump 的几何<b>唯一</b>来源是 {@code TessellatorCaptureState.endWindowAndDrain} 交出的窗口四边形；
 * 录不到的格留空（cellGrid = air）并进 {@code missing}，<b>绝不</b>从静态数据/物品渲染兜底。
 * {@code staticFallback} 恒为 false 且写进产物。
 */
public final class CaptureDiagAction implements ControlAction {

    /** 动作名。 */
    public static final String NAME = "capture.diag";

    /** dump 产物角色（run 清单里的 role 标签）。 */
    public static final String DUMP_ROLE = "capture-diag-dump";

    /** 周边空气外扩格数的默认值（与老探针的 DUMP_MARGIN 同值）。 */
    public static final int DEFAULT_DUMP_MARGIN = 1;

    /** 会话处置：布防。 */
    public static final String SESSION_ARM = "arm";

    /** 会话处置：撤防。 */
    public static final String SESSION_DISARM = "disarm";

    /** 会话处置：<b>不动</b>（纯 dump 的缺省——只读已采到的证据，不碰观察条件）。 */
    public static final String SESSION_UNCHANGED = "unchanged";

    /**
     * 会话处置的缺省规则（<b>纯函数</b>，可离线逐值锁死）。
     *
     * <p>
     * 三态而不是布尔，因为「dump 时该怎么办」有第三种正确答案：{@code {"dump":true}} 的字面意图是
     * 「把已采到的几何落盘」——它既不该顺手重新布防（会因 reset 缺省为 true 而清零，把刚采到的
     * 现场抹掉），也不该顺手撤防（会把正在进行的采集停掉）。故：
     * <ul>
     * <li>调用方显式给了 {@code arm} ⇒ 按显式值 {@link #SESSION_ARM}/{@link #SESSION_DISARM}；</li>
     * <li>纯 dump（{@code dump:true} 且未给 {@code arm}）⇒ {@link #SESSION_UNCHANGED}；</li>
     * <li>其余 ⇒ {@link #SESSION_ARM}（布防是默认形态）。</li>
     * </ul>
     *
     * @param armGiven 调用方是否显式给了 {@code arm}
     * @param armValue 显式值（{@code armGiven} 为 false 时忽略）
     * @param dump     是否 dump
     */
    public static String resolveSessionMode(boolean armGiven, boolean armValue, boolean dump) {
        if (armGiven) {
            return armValue ? SESSION_ARM : SESSION_DISARM;
        }
        return dump ? SESSION_UNCHANGED : SESSION_ARM;
    }

    /**
     * {@code reset} 的缺省规则（<b>纯函数</b>，可离线逐值锁死）。
     *
     * <p>
     * 清零只在真正布防时有意义：撤防本就<b>不清</b>计数，不动会话更不该清；报 {@code true} 只会让
     * 调用方以为撤防/导出会清零。
     *
     * @param resetGiven 调用方是否显式给了 {@code reset}
     * @param resetValue 显式值（{@code resetGiven} 为 false 时忽略）
     * @param mode       实际生效的会话处置（{@link #resolveSessionMode} 的产物）
     */
    public static boolean resolveResetDefault(boolean resetGiven, boolean resetValue, String mode) {
        if (resetGiven) {
            return resetValue;
        }
        return SESSION_ARM.equals(mode);
    }

    @Override
    public JsonObject execute(ActionContext ctx) {
        boolean dump = ctx.optBool("dump", false);
        boolean drainDump = ctx.optBool("drainDump", false);
        boolean latestWindowOnly = ctx.optBool("latestWindowOnly", false);
        String mode = resolveSessionMode(ctx.has("arm"), ctx.optBool("arm", true), dump);
        boolean arm = SESSION_ARM.equals(mode);
        boolean reset = resolveResetDefault(ctx.has("reset"), ctx.optBool("reset", true), mode);
        int margin = ctx.optInt("margin", DEFAULT_DUMP_MARGIN);
        if (margin < 0 || margin > CaptureDiagSession.MAX_DUMP_MARGIN) {
            throw CpException
                .param("margin 越界", "margin", "须在 0.." + CaptureDiagSession.MAX_DUMP_MARGIN + "，收到 " + margin);
        }
        // 前置校验：dump 形态下的参数错误必须在动观察条件之前报出来（否则一次参数笔误会顺带改观察条件）
        JsonArray at = ctx.optArray("at");
        List<CaptureDiagSession.DumpCell> cells = null;
        if (dump) {
            cells = CaptureDiagSession.resolveDumpCells(at);
        }

        JsonObject o = new JsonObject();
        o.addProperty("schema", CaptureDiagSession.SCHEMA);
        o.addProperty("action", NAME);
        o.addProperty("requiredTier", Tier.OBSERVE.id());
        o.addProperty("sessionMode", mode);
        o.addProperty("resetRequested", Boolean.valueOf(reset));
        o.addProperty(
            "defaultRule",
            "会话处置缺省：dump:true 且未显式给 arm ⇒ unchanged（既不重新布防也不撤防——纯导出不动观察条件）；"
                + "其余 ⇒ arm。reset 缺省：显式值优先，否则 = (会话处置 == arm)（撤防与 unchanged 都不清零）");

        JsonObject sessionBefore;
        if (SESSION_ARM.equals(mode)) {
            sessionBefore = CaptureDiagSession.arm(
                reset,
                drainDump,
                latestWindowOnly,
                TimeSource.system()
                    .isoNow());
        } else if (SESSION_DISARM.equals(mode)) {
            sessionBefore = CaptureDiagSession.disarm();
        } else {
            // unchanged：只取快照，不碰录窗开关、不开/关诊断会话、不动 drain 汇
            sessionBefore = CaptureDiagSession.status();
        }
        o.addProperty("armed", Boolean.valueOf(CaptureDiagSession.isArmed()));
        o.addProperty("sessionTouched", Boolean.valueOf(!SESSION_UNCHANGED.equals(mode)));
        o.addProperty("reset", Boolean.valueOf(reset));
        o.addProperty("drainDumpRequested", Boolean.valueOf(drainDump));
        o.add("sessionBefore", sessionBefore);
        o.add("session", CaptureDiagSession.status());

        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            SESSION_ARM.equals(mode) ? "捕获诊断会话布防（录窗 + 诊断计数" + (drainDump ? " + TESR drain 汇" : "") + "）"
                : SESSION_DISARM.equals(mode) ? "捕获诊断会话撤防（计数与 drain 汇保留）" : "捕获诊断会话未改动（纯 dump）",
            Json.object(
                "sessionMode",
                mode,
                "reset",
                Boolean.valueOf(reset),
                "drainDump",
                Boolean.valueOf(drainDump),
                "latestWindowOnly",
                Boolean.valueOf(latestWindowOnly),
                "session",
                CaptureDiagSession.status()));

        if (dump) {
            o.add("dump", writeDump(ctx, cells, margin, latestWindowOnly));
        }

        // 采集侧读数一并回给调用方：布防完立刻知道「现在采到多少」，不必再调一次 read.capture
        o.add("diagnostics", readBack());
        o.addProperty(
            "readBackHint",
            "读数与 read.capture 同源（同一份 CaptureDiagnostics.toJson()）；要完整读数（含逐窗口事件表）请调 read.capture");
        o.addProperty(
            "readAt",
            TimeSource.system()
                .isoNow());
        return o;
    }

    /** 采集侧的即时读数（与 {@code read.capture} 同一数据源，这里只给聚合量）。 */
    private static JsonObject readBack() {
        JsonObject o = new JsonObject();
        com.lightning.mod.client.meshcapture.CaptureDiagnostics.touch();
        JsonObject diag = com.lightning.mod.client.meshcapture.CaptureDiagnostics.toJson();
        o.addProperty("directTessellatorHookActive", Json.optBool(diag, "directTessellatorHookActive", false));
        o.addProperty(
            "directTessellatorVertexCount",
            Long.valueOf(Json.optLong(diag, "directTessellatorVertexCount", 0L)));
        JsonObject channels = Json.optObject(diag, "channels");
        if (channels != null) {
            o.add("channels", Json.copyObject(channels));
        }
        o.addProperty("note", "全 0 且 session.armed=false 时为「未采集」；session.armed=true 时的全 0 才是「采集到零流入」");
        return o;
    }

    /**
     * 装配并落盘 drain-dump 产物。
     *
     * <p>
     * 产物落<b>本次调用开的 run 目录</b>（{@code capture/diag-dump.json}）并登记 sha256 进
     * {@code manifest.json}——这是「产物显式」的落地：产物必须可发现、可核对、可下载，
     * 而不是老探针那样写在 {@code <mcDataDir>/sde_capture_channel_probe_export.json}（run 清单外，
     * 归档工作树即消失）。
     */
    private static JsonObject writeDump(ActionContext ctx, List<CaptureDiagSession.DumpCell> cells, int margin,
        boolean latestWindowOnly) {
        ArtifactStore store = ctx.artifacts();
        if (store == null) {
            throw new CpException(ErrorCodes.STATE, "产物仓库未装配，无法落 drain-dump 产物");
        }
        ArtifactStore.Run run = ctx.beginRun("capture-diag");
        if (run == null) {
            throw new CpException(ErrorCodes.STATE, "无法创建 run 目录，drain-dump 产物无处可落");
        }
        JsonObject assembled = CaptureDiagSession.assembleDump(cells, margin, run.runId());
        byte[] bytes = Json.toPretty(assembled.get("document"))
            .getBytes(java.nio.charset.StandardCharsets.UTF_8);
        ArtifactStore.Artifact a = store.writeArtifact(run, CaptureDiagSession.DUMP_RELATIVE_PATH, bytes, DUMP_ROLE);

        JsonObject dump = new JsonObject();
        dump.addProperty("runId", run.runId());
        dump.addProperty("path", CaptureDiagSession.DUMP_RELATIVE_PATH);
        dump.addProperty("role", DUMP_ROLE);
        dump.addProperty("bytes", Long.valueOf(a.bytes()));
        dump.addProperty("sha256", a.sha256());
        dump.addProperty("latestWindowOnly", Boolean.valueOf(latestWindowOnly));
        dump.addProperty("margin", Integer.valueOf(margin));
        dump.addProperty("cellCount", Integer.valueOf(cells.size()));
        dump.add("assembly", assembled.get("assembly"));
        dump.add("cellSources", assembled.get("cellSources"));
        dump.add("warnings", assembled.get("warnings"));
        dump.addProperty("format", "web V2 场景文档（format_version 2.0；materialPalette + textureBlobs 在根级，与现行导出同层级）");
        dump.addProperty(
            "fidelity",
            "几何唯一来源 = TessellatorCaptureState.endWindowAndDrain 的窗口四边形；staticFallback=false；"
                + "录不到的格留空（cellGrid=air）并进 assembly.missing");
        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            "drain-dump 已落 run：" + CaptureDiagSession.DUMP_RELATIVE_PATH,
            Json.object(
                "runId",
                run.runId(),
                "path",
                CaptureDiagSession.DUMP_RELATIVE_PATH,
                "sha256",
                a.sha256(),
                "bytes",
                Long.valueOf(a.bytes()),
                "cells",
                Integer.valueOf(cells.size())));
        return dump;
    }
}
