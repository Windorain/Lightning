package com.lightning.mod.client.controlplane.mc.read;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.TimeSource;
import com.lightning.mod.client.controlplane.mc.capture.CaptureDiagSession;
import com.lightning.mod.client.meshcapture.CaptureChannel;
import com.lightning.mod.client.meshcapture.CaptureDiagnostics;

/**
 * {@code read.capture}（observe，同步）：渲染几何捕获通道的自证诊断读数。
 *
 * <h2>为什么需要它（职责空白）</h2>
 * 「忠实复现捕获层」的核心承诺是<b>静默漏录不可接受</b>——录窗开着但零几何流入必须可检测。
 * 这份自证此前只由老设施 {@code CaptureChannelProbeAutomation} 承载（触发文件驱动、进程自毁退出），
 * 而 {@code CaptureDiagnostics} 在 {@code client/controlplane/} 下零对应物。删掉那个探针，
 * 「录窗通道到底录到了没有」就再没有可读的口径。此后它迁成读面动作：<b>数据源是
 * {@link CaptureDiagnostics#toJson()} 这一份唯一的落点</b>，本动作不新建第二套计数。
 *
 * <h2>它回答的四个问题（逐条对应老探针的断言）</h2>
 * <ol>
 * <li><b>三通道计数</b>：{@code channels.{BLOCK_COMPILE,TESR,FMP_DYNAMIC,LEGACY_PER_CELL}} 各自的
 * {@code windows/quads/zeroFlowWindows}（老探针判据 2/3/4：管格与箱格的 TESR 四边形数、BLOCK_COMPILE
 * 窗口数与四边形总数）；</li>
 * <li><b>zeroFlow</b>：{@code zeroFlowWindows} 逐通道 + 逐窗口事件的 {@code zeroFlow} 布尔
 * （窗口开着但零流入 = 静默漏录信号）；</li>
 * <li><b>directTessellatorHookActive</b>：{@code MixinDirectTessellatorCapture} 是否活着
 * （老探针判据 1；它证明的是 Mixin 生效，不是诊断在开——故本动作把「会话开没开」另列一字段，
 * 两者不可互替）；</li>
 * <li><b>按格归属</b>：{@code quadsByAttr}（通道 × 归属格）与 {@code quadsByBin}（质心分箱）——
 * 老探针的 {@code quadCountAt(diag, "TESR", x,y,z)} 读的就是这一份。</li>
 * </ol>
 *
 * <h2>为什么 {@code channel} 过滤是服务端做的</h2>
 * 老探针在探针侧对 {@code quadsByAttr} 做线性扫描取「通道 × 格」。把同一件事留给调用方，
 * 等于把「哪个通道」这条口径复制到每个调用点（读面存在的意义就是消掉这种复制）。
 *
 * <h2>负对照：未采集必须显式空态（不编造数据）</h2>
 * 全 0 有两种完全不同的含义：「没采过」与「采到了零流入」。本动作因此<b>不</b>只回计数，还回
 * {@code collected}（= 诊断会话是否开过）与 {@code collectionState} 显式枚举：
 * <ul>
 * <li>{@code "not-collected"}：从未布防过诊断会话 ⇒ 全部计数为 0，且 {@code note} 明写
 * 「这是未采集的空态，不是采集到零流入」；</li>
 * <li>{@code "collected-then-disarmed"}：采过并已撤防 ⇒ 计数是<b>已采到的真实证据</b>
 * （撤防不清计数，见 {@link CaptureDiagnostics#endSession()}）；</li>
 * <li>{@code "collecting"}：正在采。</li>
 * </ul>
 * 三者都不抛异常（未采集是合法状态，不是错误），但含义在读数里分得开——
 * 「空转绿」的反面不是「一律报错」，而是「如实说明这个 0 是什么」。
 *
 * <h2>只读性</h2>
 * 数据源 {@link CaptureDiagnostics#toJson()} 是纯内存聚合（同一临界区取全部计数）；
 * {@link CaptureDiagSession#status()} 只读布尔与计数。本动作<b>不</b>写世界、不布防、不清零、
 * 不落 run 产物（要布防走 {@code capture.diag}；要落盘产物走 {@code capture.diag} 的
 * {@code dump:true}）。因此可以在任何时刻自由轮询，包括捕获会话进行中。
 */
public final class ReadCaptureAction implements ControlAction {

    /** 动作名。 */
    public static final String NAME = "read.capture";

    /** {@code windowEvents} 的默认条数上限。 */
    public static final int DEFAULT_MAX_EVENTS = 64;

    /** {@code windowEvents} 的条数上限的硬上界（事件表本身在采集侧有 512 条环形上限）。 */
    public static final int MAX_EVENTS_LIMIT = 512;

    /** 收集态：从未布防过。 */
    public static final String STATE_NOT_COLLECTED = "not-collected";

    /** 收集态：正在采。 */
    public static final String STATE_COLLECTING = "collecting";

    /** 收集态：采过并已撤防（计数是已采到的真实证据）。 */
    public static final String STATE_DISARMED = "collected-then-disarmed";

    @Override
    public JsonObject execute(ActionContext ctx) {
        String channelFilter = CaptureDiagSession.normalizeChannel(ctx.optString("channel", null));
        boolean includeEvents = ctx.optBool("events", true);
        int maxEvents = ctx.optInt("maxEvents", DEFAULT_MAX_EVENTS);
        if (maxEvents < 0 || maxEvents > MAX_EVENTS_LIMIT) {
            throw CpException.param("maxEvents 越界", "maxEvents", "须在 0.." + MAX_EVENTS_LIMIT + "，收到 " + maxEvents);
        }
        return buildReadback(
            CaptureDiagnostics.toJson(),
            CaptureDiagnostics.isSessionEnabled(),
            CaptureDiagSession.everArmed(),
            channelFilter,
            includeEvents,
            maxEvents);
    }

    /**
     * 由「一份诊断 JSON + 会话状态」渲染读面结果（<b>纯函数</b>，不碰 MC、不碰动作上下文）。
     *
     * <h2>为什么抽成静态纯函数</h2>
     * 「这个 0 是没采还是采到零」这条判定的失败模式是<b>静默</b>的——判错了读数依然是一份合法 JSON，
     * 只是含义相反。因此它必须能被离线逐值锁死（见 {@code ReadCaptureOfflineTest}），
     * 而不是只能靠实机观察。本方法也是「读数只此一处定义」的落点：
     * {@code capture.diag} 的即时回读与实机验收都引用它。
     *
     * <p>
     * 本重载把时间源固定为 {@link TimeSource#system()}（生产路径）。需要逐字段等价的离线判据
     * （例如「显式 all 与省略等价」）请用下面带 {@code clock} 的重载——{@code readAt} 是墙钟读数，
     * 两次调用天然不同，直接比较整份 JSON 会得到与实现无关的假红（实测）。
     *
     * @param diag           {@link CaptureDiagnostics#toJson()} 的产物
     * @param sessionEnabled 诊断会话当前是否开着
     * @param everArmed      是否曾被布防过（区分「从未采集」与「采集过又撤防」）
     * @param channelFilter  规范化后的通道过滤（null = 不过滤）
     * @param includeEvents  是否返回逐窗口事件表
     * @param maxEvents      事件表返回条数上限
     */
    static JsonObject buildReadback(JsonObject diag, boolean sessionEnabled, boolean everArmed, String channelFilter,
        boolean includeEvents, int maxEvents) {
        return buildReadback(
            diag,
            sessionEnabled,
            everArmed,
            channelFilter,
            includeEvents,
            maxEvents,
            TimeSource.system());
    }

    /**
     * 同 {@link #buildReadback(JsonObject, boolean, boolean, String, boolean, int)}，但时间戳取自传入的时间源。
     *
     * <h2>为什么时间源是可注入的</h2>
     * {@code readAt} 是<b>墙钟</b>：两次调用必然取到不同的值（实测差异仅此一处）。于是
     * 「两次读数必须逐字段相同」这类判据若直接比较整份 JSON，就会在毫秒/微秒边界上随机变红——
     * 这是<b>与实现无关的假红</b>，会把「全量测试」这道闸门变成不可判定。
     *
     * <p>
     * 两条退路都不能接受：① 在测试里把 {@code readAt} 剔除再比——那样连「字段消失了」都测不出；
     * ② 放宽判据——那正是本仓明令禁止的「为了让结果好看而放宽口径」。正解是把时间源变成参数：
     * 判据可以要求<b>逐字节相同</b>（含 {@code readAt} 等于注入的固定值），同时生产路径行为逐字节不变。
     *
     * @param clock 产生 {@code readAt} 的时间源；生产路径传 {@link TimeSource#system()}
     */
    static JsonObject buildReadback(JsonObject diag, boolean sessionEnabled, boolean everArmed, String channelFilter,
        boolean includeEvents, int maxEvents, TimeSource clock) {
        String state = sessionEnabled ? STATE_COLLECTING : everArmed ? STATE_DISARMED : STATE_NOT_COLLECTED;

        JsonObject o = new JsonObject();
        o.addProperty("schema", "lightning.cp-read-capture/1");
        o.addProperty("action", NAME);
        o.addProperty("diagnosticsSchema", CaptureDiagnostics.SCHEMA);
        o.addProperty("collected", Boolean.valueOf(sessionEnabled));
        o.addProperty("everCollected", Boolean.valueOf(everArmed));
        o.addProperty("collectionState", state);
        o.addProperty("channelFilter", channelFilter == null ? "all" : channelFilter);
        o.add("session", CaptureDiagSession.status());

        // 三通道计数（老探针判据 2/3/4 的读数）
        JsonObject channels = new JsonObject();
        JsonObject diagChannels = Json.optObject(diag, "channels");
        for (CaptureChannel ch : CaptureChannel.values()) {
            if (channelFilter != null && !channelFilter.equals(ch.name())) {
                continue;
            }
            JsonObject src = diagChannels == null ? null : Json.optObject(diagChannels, ch.name());
            JsonObject c = new JsonObject();
            c.addProperty("windows", Integer.valueOf(Json.optInt(src, "windows", 0)));
            c.addProperty("quads", Integer.valueOf(Json.optInt(src, "quads", 0)));
            c.addProperty("zeroFlowWindows", Integer.valueOf(Json.optInt(src, "zeroFlowWindows", 0)));
            channels.add(ch.name(), c);
        }
        o.add("channels", channels);
        o.add("channelsReturned", channelsReturnedJson(channels));
        o.addProperty("channelFilterApplied", Boolean.valueOf(channelFilter != null));
        o.addProperty(
            "channelsScope",
            "通道全集（未过滤时全给）：BLOCK_COMPILE=区块编译窗口（归属键=渲染器 16³ 段角）、"
                + "TESR=TESR 逐帧窗口（归属键=TE 坐标）、FMP_DYNAMIC=预留给 FMP 动态通道（尚无开窗点）、"
                + "LEGACY_PER_CELL=旧逐格驱动路径（MeshCaptureService）。zeroFlowWindows = 关窗时四边形数 == 0 的窗口数");

        // 钩子自检与其它全局量（老探针判据 1/5）
        o.addProperty("directTessellatorHookActive", Json.optBool(diag, "directTessellatorHookActive", false));
        o.addProperty(
            "directTessellatorVertexCount",
            Long.valueOf(Json.optLong(diag, "directTessellatorVertexCount", 0L)));
        o.addProperty("hookZeroFlowWarningIssued", Json.optBool(diag, "hookZeroFlowWarningIssued", false));
        o.addProperty("crossBinQuads", Long.valueOf(Json.optLong(diag, "crossBinQuads", 0L)));
        o.addProperty("droppedWindowEvents", Long.valueOf(Json.optLong(diag, "droppedWindowEvents", 0L)));
        o.addProperty(
            "hookScope",
            "directTessellatorHookActive = MixinDirectTessellatorCapture 是否见过任何一个 DirectTessellator 顶点"
                + "（录窗外也置位——它证明的是 Mixin 活着，不是诊断在开）。无 DirectTessellator 流量的会话（如纯方块场景）"
                + "保持 false 是正确行为，不是缺陷；硬判据只在「本会话确实制造了 LP 管等 DirectTessellator 流量」的场景成立。"
                + "directTessellatorVertexCount 只统计采集期内的顶点（未开诊断会话时为 0）");

        // 按格归属聚合（老探针 quadCountAt 的数据源）
        JsonArray byAttr = filterByChannel(Json.optArray(diag, "quadsByAttr"), channelFilter);
        o.add("quadsByAttr", byAttr);
        o.addProperty("quadsByAttrCount", byAttr.size());
        JsonArray byBin = filterByChannel(Json.optArray(diag, "quadsByBin"), channelFilter);
        o.add("quadsByBin", byBin);
        o.addProperty("quadsByBinCount", byBin.size());
        o.addProperty(
            "byAttrScope",
            "quadsByAttr 逐条 {channel,x,y,z,quads}：通道 × 窗口归属格的四边形数（唯一键）。"
                + "quadsByBin 逐条 {channel,x,y,z,quads}：质心分箱（去 Tessellator offset 后 floor）——"
                + "与归属格不同的量（跨箱四边形在两者里落在不同的格）");

        // 自证日志（老探针判据 5）
        JsonArray proofs = Json.optArray(diag, "selfProofLines");
        JsonArray proofOut = new JsonArray();
        if (proofs != null) {
            for (int i = 0; i < proofs.size(); i++) {
                proofOut.add(proofs.get(i));
            }
        }
        o.add("selfProofLines", proofOut);
        o.addProperty("selfProofLineCount", proofOut.size());

        // 逐窗口事件（zeroFlow 的逐条证据；条数受限，超出显式标注）
        if (includeEvents) {
            JsonArray events = Json.optArray(diag, "windowEvents");
            JsonArray out = new JsonArray();
            int total = events == null ? 0 : events.size();
            int matched = 0;
            for (int i = 0; i < total; i++) {
                JsonObject e = events.get(i)
                    .getAsJsonObject();
                if (channelFilter != null && !channelFilter.equals(Json.optString(e, "channel", null))) {
                    continue;
                }
                matched++;
                if (out.size() < maxEvents) {
                    out.add(Json.copyObject(e));
                }
            }
            o.add("windowEvents", out);
            o.addProperty("windowEventsReturned", out.size());
            o.addProperty("windowEventsAvailable", total);
            o.addProperty("windowEventsMatched", matched);
            o.addProperty("windowEventsLimit", maxEvents);
            o.addProperty("windowEventsTruncated", Boolean.valueOf(out.size() < matched));
            o.addProperty(
                "windowEventsScope",
                "逐窗口 {seq,channel,attrX,attrY,attrZ,tag,quadCount,zeroFlow}；本表在采集侧有 512 条环形上限，"
                    + "超出部分只计入 droppedWindowEvents。maxEvents 是本读面的返回条数上限（0 = 不要事件表，只要聚合计数）；"
                    + "windowEventsMatched 是过滤后命中的总数，windowEventsTruncated 说明返回条数是否被 maxEvents 截断");
        } else {
            o.addProperty("windowEventsOmitted", Boolean.TRUE);
        }

        if (STATE_NOT_COLLECTED.equals(state)) {
            o.addProperty(
                "note",
                "显式空态：从未布防过捕获诊断会话，因此全部计数为 0——这是「未采集」，不是「采集到零流入」。"
                    + "要采集：capture.diag {arm:true} 布防（可选 drainDump:true 布防 TESR drain 汇），"
                    + "让世界真实渲染（shot.multi 或 case.run 的 cameras 段），再调本动作读回");
        } else if (STATE_DISARMED.equals(state)) {
            o.addProperty(
                "note",
                "已撤防（capture.diag {arm:false}）：计数是撤防前采到的真实证据，撤防不清计数。"
                    + "要重新采一轮：capture.diag {arm:true,reset:true}（reset 清零）");
        } else if (!Json.optBool(diag, "directTessellatorHookActive", false)) {
            o.addProperty(
                "note",
                "正在采集但 directTessellatorHookActive=false：若本会话确实有 DirectTessellator 流量"
                    + "（如 LP 管 VBO 编译），这表示 MixinDirectTessellatorCapture 未生效（静默漏录）；"
                    + "若本会话只有方块/TESR 几何（无 DirectTessellator 流量），false 是正确行为——见 hookScope");
        }

        o.addProperty("readAt", clock.isoNow());
        return o;
    }

    /** 通道名清单（过滤结果的自述：调用方不必猜过滤到底命中了几条通道）。 */
    private static JsonArray channelsReturnedJson(JsonObject channels) {
        JsonArray a = new JsonArray();
        for (String k : Json.keys(channels)) {
            Json.add(a, k);
        }
        return a;
    }

    /** 按通道过滤逐条聚合表（{@code channel} 是每条的第一个字段）。 */
    private static JsonArray filterByChannel(JsonArray src, String channelFilter) {
        JsonArray out = new JsonArray();
        if (src == null) {
            return out;
        }
        for (int i = 0; i < src.size(); i++) {
            JsonObject o = src.get(i)
                .getAsJsonObject();
            if (channelFilter != null && !channelFilter.equals(Json.optString(o, "channel", null))) {
                continue;
            }
            out.add(Json.copyObject(o));
        }
        return out;
    }
}
