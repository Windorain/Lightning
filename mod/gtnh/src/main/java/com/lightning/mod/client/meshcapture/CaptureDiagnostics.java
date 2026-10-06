package com.lightning.mod.client.meshcapture;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import cpw.mods.fml.common.FMLLog;

/**
 * 「忠实复现捕获层」PR-1 的旁车诊断收集器：把本次会话全部录窗事件（通道、归属、四边形计数、
 * zeroFlow、DirectTessellator 钩子自检、坐标系自证日志要点）聚合成一份 JSON。
 * <p>
 * 为什么存在：设计基线（#55）要求「静默漏录不可接受」——录窗开着但零几何流入必须可检测。
 * 本类是 zeroFlow 事件与钩子自检标志的唯一落点；探针（{@code CaptureChannelProbeAutomation}）
 * 与人工排障都读这份 JSON。
 * <p>
 * 纯观察论证：只读录窗层上报的计数，不触碰任何游戏/渲染状态；未启用时每个 {@code note*} 入口
 * 只付一次布尔判断（{@link #noteDirectTessellatorVertex} 额外置一个静态位，那是自检语义本身）。
 * <p>
 * 启用方式（任选其一，都是「一次设定」）：① JVM 属性 {@code sde.captureDiag.file=<路径>}（进程退出时自动落盘）；
 * ② 探针调用 {@link #beginSession()} 开启程序化会话并自行 {@link #write(Path)}。
 * <p>
 * gson 铁律：运行期 FML 实载 gson 2.2.4，本类只用手工 {@link JsonObject}/{@link JsonArray}（无 2.3+ API）。
 */
public final class CaptureDiagnostics {

    /** 诊断 JSON schema 版本。 */
    public static final String SCHEMA = "lightning.capture-diagnostics/1";

    private static final int MAX_WINDOW_EVENTS = 512;
    private static final int MAX_SELF_PROOF_LINES = 64;

    private static final String DIAG_FILE = System.getProperty("sde.captureDiag.file", "")
        .trim();

    private static final Object LOCK = new Object();

    /** 一次性自检：首个 DirectTessellator 顶点到达即置位（录窗外也置——它证明的是 Mixin 活着）。 */
    private static volatile boolean hookEverSeen;

    private static boolean sessionEnabled;
    private static boolean enabledForTesting;
    private static boolean hookZeroFlowWarningIssued;

    private static long seqCounter;
    private static long directTessellatorVertexCount;
    private static long crossBinQuadCount;
    private static long droppedWindowEvents;
    private static final long[] windowsClosed = new long[CaptureChannel.values().length];
    private static final long[] windowQuadSum = new long[CaptureChannel.values().length];
    private static final long[] zeroFlowWindows = new long[CaptureChannel.values().length];
    private static final List<WindowEvent> windowEvents = new ArrayList<>();
    private static final Map<String, Long> quadsByAttr = new LinkedHashMap<>();
    private static final Map<String, Long> quadsByBin = new LinkedHashMap<>();
    private static final List<String> selfProofLines = new ArrayList<>();

    static {
        if (!DIAG_FILE.isEmpty()) {
            Runtime.getRuntime()
                .addShutdownHook(new Thread(new Runnable() {

                    @Override
                    public void run() {
                        try {
                            write(Paths.get(DIAG_FILE));
                        } catch (Throwable ignored) {
                            // 退出路径上的诊断落盘失败不影响游戏
                        }
                    }
                }, "sde-capture-diag-writer"));
        }
    }

    private CaptureDiagnostics() {}

    /** 触发本类初始化（注册 {@code sde.captureDiag.file} 的退出落盘钩子）。 */
    public static void touch() {}

    public static boolean isEnabled() {
        return !DIAG_FILE.isEmpty() || sessionEnabled || enabledForTesting;
    }

    /**
     * 是否给定了落盘目标 {@code -Dsde.captureDiag.file=<路径>}（本类静态初始化时已注册退出落盘钩子）。
     * 与 {@link #isEnabled()} 的区别：本方法只看属性，不受程序化会话（{@link #beginSession()}）影响——
     * 挂点（{@code ClientProxy.initNetwork()}）用它决定是否额外开一次会话，而不用把属性名抄第二份。
     */
    public static boolean hasFileTarget() {
        return !DIAG_FILE.isEmpty();
    }

    /** 探针程序化会话：清空计数、开启收集（一次设定，不反复操纵）。 */
    public static void beginSession() {
        synchronized (LOCK) {
            resetAllLocked();
            sessionEnabled = true;
        }
    }

    public static boolean isDirectTessellatorHookEverSeen() {
        return hookEverSeen;
    }

    /**
     * DirectTessellator 顶点到达（{@code MixinDirectTessellatorCapture} 每次 addVertex 都调用，无论是否在录窗内）。
     * 自检语义：只在有 DirectTessellator 流量的会话里判活——无流量会话 {@code hookEverSeen} 保持 false，
     * 由探针（它确实制造了 LP 流量）负责把它升级为失败判据，本类不在无流量会话误报。
     */
    public static void noteDirectTessellatorVertex() {
        hookEverSeen = true;
        if (!isEnabled()) {
            return;
        }
        synchronized (LOCK) {
            directTessellatorVertexCount++;
        }
    }

    /** 窗口关闭事件（含 zeroFlow 判定：{@code quadCount == 0}）。 */
    public static void noteWindowClosed(CaptureChannel channel, int attrX, int attrY, int attrZ, String tag,
        int quadCount) {
        if (!isEnabled() || channel == null) {
            return;
        }
        boolean zeroFlow = quadCount == 0;
        synchronized (LOCK) {
            int ci = channel.ordinal();
            windowsClosed[ci]++;
            windowQuadSum[ci] += quadCount;
            if (zeroFlow) {
                zeroFlowWindows[ci]++;
            }
            if (windowEvents.size() < MAX_WINDOW_EVENTS) {
                windowEvents.add(new WindowEvent(++seqCounter, channel, attrX, attrY, attrZ, tag, quadCount, zeroFlow));
            } else {
                droppedWindowEvents++;
            }
            maybeWarnHookInactiveLocked(channel, zeroFlow);
        }
    }

    /**
     * TESR 录窗零流入且 DirectTessellator 钩子从未见活：若本会话存在 LP 管等 DirectTessellator 流量，
     * 这意味着 {@code MixinDirectTessellatorCapture} 未生效（静默漏录），每会话只告警一次。
     * 无 DirectTessellator 流量的会话也可能触发本告警（display-list/VBO 重放本来零流入），故措辞为条件式，
     * 硬判据只在探针里（探针确实放置了 LP 管）。
     */
    private static void maybeWarnHookInactiveLocked(CaptureChannel channel, boolean zeroFlow) {
        if (!zeroFlow || channel != CaptureChannel.TESR || hookEverSeen || hookZeroFlowWarningIssued) {
            return;
        }
        hookZeroFlowWarningIssued = true;
        try {
            FMLLog.warning(
                "[SDE][capture] TESR 录窗零流入且 directTessellatorHookActive=false——若本会话存在"
                    + " DirectTessellator 流量（如 LP 管 VBO 编译），说明 MixinDirectTessellatorCapture 未生效");
        } catch (Throwable ignored) {
            // 诊断告警通道失败不得影响游戏
        }
    }

    /** 单个闭合四边形的归属聚合（窗口归属键 + 质心分箱）。 */
    public static void noteQuad(CaptureChannel channel, int attrX, int attrY, int attrZ, int binX, int binY, int binZ,
        boolean crossBin) {
        if (!isEnabled() || channel == null) {
            return;
        }
        synchronized (LOCK) {
            bump(quadsByAttr, channel.name() + "|" + attrX + "," + attrY + "," + attrZ);
            bump(quadsByBin, channel.name() + "|" + binX + "," + binY + "," + binZ);
            if (crossBin) {
                crossBinQuadCount++;
            }
        }
    }

    /** 坐标系自证日志要点（P0 惯例：首窗口开启 / 首顶点原始坐标 / 推导世界坐标 / Tessellator offset）。 */
    public static void noteSelfProof(String line) {
        if (!isEnabled() || line == null) {
            return;
        }
        synchronized (LOCK) {
            if (selfProofLines.size() < MAX_SELF_PROOF_LINES) {
                selfProofLines.add(line);
            }
        }
    }

    private static void bump(Map<String, Long> map, String key) {
        Long v = map.get(key);
        map.put(key, Long.valueOf(v == null ? 1L : v.longValue() + 1L));
    }

    /** 聚合成 JSON（手工 {@link JsonObject}/{@link JsonArray}，gson 2.2.4 兼容）。 */
    public static JsonObject toJson() {
        synchronized (LOCK) {
            JsonObject root = new JsonObject();
            root.addProperty("schema", SCHEMA);
            root.addProperty("writtenAtEpochMs", Long.valueOf(System.currentTimeMillis()));
            root.addProperty("directTessellatorHookActive", Boolean.valueOf(hookEverSeen));
            root.addProperty("directTessellatorVertexCount", Long.valueOf(directTessellatorVertexCount));
            root.addProperty("hookZeroFlowWarningIssued", Boolean.valueOf(hookZeroFlowWarningIssued));
            root.addProperty("crossBinQuads", Long.valueOf(crossBinQuadCount));
            root.addProperty("droppedWindowEvents", Long.valueOf(droppedWindowEvents));

            JsonObject channels = new JsonObject();
            for (CaptureChannel ch : CaptureChannel.values()) {
                JsonObject c = new JsonObject();
                c.addProperty("windows", Long.valueOf(windowsClosed[ch.ordinal()]));
                c.addProperty("quads", Long.valueOf(windowQuadSum[ch.ordinal()]));
                c.addProperty("zeroFlowWindows", Long.valueOf(zeroFlowWindows[ch.ordinal()]));
                channels.add(ch.name(), c);
            }
            root.add("channels", channels);

            root.add("quadsByAttr", countMapToJson(quadsByAttr));
            root.add("quadsByBin", countMapToJson(quadsByBin));

            JsonArray events = new JsonArray();
            for (WindowEvent e : windowEvents) {
                JsonObject o = new JsonObject();
                o.addProperty("seq", Long.valueOf(e.seq));
                o.addProperty("channel", e.channel.name());
                o.addProperty("attrX", Integer.valueOf(e.attrX));
                o.addProperty("attrY", Integer.valueOf(e.attrY));
                o.addProperty("attrZ", Integer.valueOf(e.attrZ));
                o.addProperty("tag", e.tag);
                o.addProperty("quadCount", Integer.valueOf(e.quadCount));
                o.addProperty("zeroFlow", Boolean.valueOf(e.zeroFlow));
                events.add(o);
            }
            root.add("windowEvents", events);

            JsonArray proofs = new JsonArray();
            for (String line : selfProofLines) {
                proofs.add(new com.google.gson.JsonPrimitive(line));
            }
            root.add("selfProofLines", proofs);
            return root;
        }
    }

    private static JsonArray countMapToJson(Map<String, Long> map) {
        JsonArray arr = new JsonArray();
        for (Map.Entry<String, Long> e : map.entrySet()) {
            String key = e.getKey();
            int sep = key.indexOf('|');
            String channel = sep < 0 ? key : key.substring(0, sep);
            String coords = sep < 0 ? "" : key.substring(sep + 1);
            String[] parts = coords.split(",");
            JsonObject o = new JsonObject();
            o.addProperty("channel", channel);
            if (parts.length == 3) {
                o.addProperty("x", Integer.valueOf(Integer.parseInt(parts[0])));
                o.addProperty("y", Integer.valueOf(Integer.parseInt(parts[1])));
                o.addProperty("z", Integer.valueOf(Integer.parseInt(parts[2])));
            }
            o.addProperty("quads", e.getValue());
            arr.add(o);
        }
        return arr;
    }

    /** 落盘（UTF-8）。显式调用，与是否启用无关；写失败抛 {@link RuntimeException} 由调用方处理。 */
    public static void write(Path path) {
        try {
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
            Files.write(
                path,
                toJson().toString()
                    .getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new RuntimeException("CaptureDiagnostics 落盘失败: " + path, e);
        }
    }

    private static void resetAllLocked() {
        seqCounter = 0L;
        directTessellatorVertexCount = 0L;
        crossBinQuadCount = 0L;
        droppedWindowEvents = 0L;
        hookZeroFlowWarningIssued = false;
        for (int i = 0; i < windowsClosed.length; i++) {
            windowsClosed[i] = 0L;
            windowQuadSum[i] = 0L;
            zeroFlowWindows[i] = 0L;
        }
        windowEvents.clear();
        quadsByAttr.clear();
        quadsByBin.clear();
        selfProofLines.clear();
    }

    /** 单测专用：重置全部计数（含 hook 自检位）并显式开关启用态。 */
    public static void resetForTesting(boolean enabled) {
        synchronized (LOCK) {
            resetAllLocked();
            hookEverSeen = false;
            sessionEnabled = false;
            enabledForTesting = enabled;
        }
    }

    private static final class WindowEvent {

        final long seq;
        final CaptureChannel channel;
        final int attrX;
        final int attrY;
        final int attrZ;
        final String tag;
        final int quadCount;
        final boolean zeroFlow;

        WindowEvent(long seq, CaptureChannel channel, int attrX, int attrY, int attrZ, String tag, int quadCount,
            boolean zeroFlow) {
            this.seq = seq;
            this.channel = channel;
            this.attrX = attrX;
            this.attrY = attrY;
            this.attrZ = attrZ;
            this.tag = tag != null ? tag : "";
            this.quadCount = quadCount;
            this.zeroFlow = zeroFlow;
        }
    }
}
