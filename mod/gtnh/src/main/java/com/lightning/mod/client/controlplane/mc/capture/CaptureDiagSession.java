package com.lightning.mod.client.controlplane.mc.capture;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.block.Block;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.texture.TextureMap;
import net.minecraft.tileentity.TileEntity;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.ModReflect;
import com.lightning.mod.client.meshcapture.CaptureChannel;
import com.lightning.mod.client.meshcapture.CaptureDiagnostics;
import com.lightning.mod.client.meshcapture.CaptureDumpAssembler;
import com.lightning.mod.client.meshcapture.MeshCaptureService;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedBlockInstance;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad;

/**
 * 捕获通道诊断的<b>会话与 drain 汇状态</b>（Gitea #114，V4 职责迁移的落点）。
 *
 * <h2>它替代了什么</h2>
 * 老设施 {@code CaptureChannelProbeAutomation}（#104 删除）是「渲染几何捕获通道自证」的唯一承载：
 * 它自己开录窗（{@code armWindows()}）、开诊断会话（{@link CaptureDiagnostics#beginSession()}）、
 * 布防 TESR drain 汇（{@link TessellatorCaptureState#armWindowDrainSink}）、把 drain 到的实录几何
 * 装配成 web 可加载的 V2 场景文档。本类把这三件<b>状态</b>搬进控制面（动作 {@code capture.diag} 驱动，
 * 读面 {@code read.capture} 读取），从而「删探针 ⇒ 诊断能力真空」不再成立。
 *
 * <h2>为什么状态独立成类（而不是塞进动作里）</h2>
 * 三个动作面共享同一份状态：{@code capture.diag} 写、{@code read.capture} 读、{@code shot.multi}
 * 期间被动累积。若把状态挂在动作实例上，一次 {@code capture.diag} 结束（作业销毁动作实例）就会
 * 把布防状态一起丢掉，而布防恰恰必须<b>跨作业存活</b>到拍摄结束。故状态是类级单例，
 * 与 {@link TessellatorCaptureState} 的录窗状态同一生命周期口径。
 *
 * <h2>线程</h2>
 * 只在客户端 tick 线程读写（动作在 tick 线程排空，渲染也同线程，见 contract.md §4.3.5）。
 * {@link WindowDrainCollector#onWindowDrained} 由渲染循环在关窗时调用，因此汇内部用
 * {@code synchronized} 保护自己的容器——这与 {@link TessellatorCaptureState} 的窗口锁不同锁，
 * 不存在锁序反转（汇从不反向调用录窗层）。
 *
 * <h2>纯观察论证</h2>
 * 本类不驱动任何渲染器、不改方块/世界状态：布防只翻转录窗层的观察开关；drain 只<b>接住</b>
 * 录窗层本来就要丢弃的四边形（{@link TessellatorCaptureState#endWindow()} 未布防时几何关闭即丢）。
 * 装配阶段只读客户端世界（{@code getBlock}/{@code getBlockMetadata}/{@code getTileEntity}）。
 */
public final class CaptureDiagSession {

    /** 诊断会话 schema（结果与产物的自述标识）。 */
    public static final String SCHEMA = "lightning.cp-capture-diag/1";

    /** drain-dump 产物的 run 目录内相对路径。 */
    public static final String DUMP_RELATIVE_PATH = "capture/diag-dump.json";

    /** 一次 dump 允许的格数上限（逐格装配是 CPU + 内存开销，放开会让一次调用变成一次全场景烘焙）。 */
    public static final int MAX_DUMP_CELLS = 512;

    /** 周边空气外扩格数的上限。 */
    public static final int MAX_DUMP_MARGIN = 8;

    // ------------------------------------------------------------------ 会话状态

    /** 是否有会话被布防过（撤防后仍为 true：用来区分「从未采集」与「采集过又撤防」）。 */
    private static boolean everArmed;

    /** 当前是否处于布防态（录窗 + 诊断会话）。 */
    private static boolean armed;

    /** 本次布防是否同时布防了 TESR drain 汇。 */
    private static boolean drainDumpArmed;

    /** drain 汇的「每格只留最后一个非空窗口」开关（与老探针的 dumpLatestWindowOnly 同义）。 */
    private static boolean latestWindowOnly;

    /** 布防时刻（ISO-8601，留痕）。 */
    private static String armedAt;

    private CaptureDiagSession() {}

    // ------------------------------------------------------------------ drain 汇状态

    /**
     * TESR 录窗 drain 汇：按归属键（TE 世界格）汇集实录四边形。
     *
     * <p>
     * 忠实边界（与老探针逐字同源）：几何的唯一来源是
     * {@link TessellatorCaptureState#endWindowAndDrain} 交出的四边形；空窗口（zeroFlow）
     * 只计窗口数、不产生几何；录不到的格留空并进 {@code missing}，<b>绝不</b>从静态数据/物品渲染兜底。
     */
    public static final class WindowDrainCollector implements TessellatorCaptureState.WindowDrainSink {

        private final Map<String, List<CapturedQuad>> byCell = new LinkedHashMap<String, List<CapturedQuad>>();
        private int windows;
        private int windowsWithFlow;
        private int quads;

        @Override
        public void onWindowDrained(CaptureChannel channel, int attrX, int attrY, int attrZ, String tag,
            List<CapturedQuad> drained) {
            if (channel != CaptureChannel.TESR) {
                return;
            }
            synchronized (this) {
                windows++;
                if (drained == null || drained.isEmpty()) {
                    return;
                }
                quads += drained.size();
                windowsWithFlow++;
                String key = cellKey(attrX, attrY, attrZ);
                List<CapturedQuad> bucket = byCell.get(key);
                if (bucket == null) {
                    bucket = new ArrayList<CapturedQuad>();
                    byCell.put(key, bucket);
                }
                if (latestWindowOnly) {
                    // 后窗覆盖前窗：一个窗口 = 一次完整 renderTileEntity ⇒ 最后一个非空窗口即当前渲染几何
                    bucket.clear();
                }
                bucket.addAll(drained);
            }
        }

        /** 见过的 TESR 窗口数（含 zeroFlow 窗口）。 */
        public synchronized int windows() {
            return windows;
        }

        /** 有几何流入的窗口数（大于 1 说明该会话里几何被多次重建/重复流入）。 */
        public synchronized int windowsWithFlow() {
            return windowsWithFlow;
        }

        /** drain 到的四边形总数（累计，按窗口到来顺序）。 */
        public synchronized int quadCount() {
            return quads;
        }

        /** 有几何的归属格数。 */
        public synchronized int cellCount() {
            return byCell.size();
        }

        /** 归属格键快照（{@code x,y,z}，按首次出现顺序）。 */
        public synchronized List<String> cellKeys() {
            return new ArrayList<String>(byCell.keySet());
        }

        /** 某格的实录四边形（无则空表；返回副本，调用方改写不污染原始记录）。 */
        public synchronized List<CapturedQuad> quadsAt(int x, int y, int z) {
            List<CapturedQuad> bucket = byCell.get(cellKey(x, y, z));
            return bucket == null ? new ArrayList<CapturedQuad>() : new ArrayList<CapturedQuad>(bucket);
        }

        /** 逐格四边形数（{@code "x,y,z" → 条数}，确定序）。 */
        public synchronized JsonObject perCellQuadCounts() {
            JsonObject o = new JsonObject();
            for (Map.Entry<String, List<CapturedQuad>> e : byCell.entrySet()) {
                o.addProperty(
                    e.getKey(),
                    Integer.valueOf(
                        e.getValue()
                            .size()));
            }
            return o;
        }

        /** 清空（重新布防时用）。 */
        public synchronized void clear() {
            byCell.clear();
            windows = 0;
            windowsWithFlow = 0;
            quads = 0;
        }

        /**
         * 格键 → 世界格坐标。dump 装配时用（{@code cellKey} 是唯一格式定义点，
         * 避免「写的时候一种拼法、读的时候另一种」）。
         */
        public static int[] parseCellKey(String key) {
            if (key == null) {
                return null;
            }
            String[] parts = key.split(",");
            if (parts.length != 3) {
                return null;
            }
            try {
                return new int[] { Integer.parseInt(parts[0].trim()), Integer.parseInt(parts[1].trim()),
                    Integer.parseInt(parts[2].trim()) };
            } catch (NumberFormatException e) {
                return null;
            }
        }
    }

    /** 当前 drain 汇（null = 未布防）。 */
    private static volatile WindowDrainCollector collector;

    /** 格键（唯一格式定义点）。 */
    static String cellKey(int x, int y, int z) {
        return x + "," + y + "," + z;
    }

    // ------------------------------------------------------------------ 布防 / 撤防

    /** 是否处于布防态。 */
    public static boolean isArmed() {
        return armed;
    }

    /** 是否曾被布防过（区分「从未采集」与「采集过又撤防」）。 */
    public static boolean everArmed() {
        return everArmed;
    }

    /** 本次布防是否带 drain 汇。 */
    public static boolean isDrainDumpArmed() {
        return drainDumpArmed;
    }

    /** drain 汇是否真的挂在录窗层上。 */
    public static boolean isDrainSinkAttached() {
        return TessellatorCaptureState.isWindowDrainArmed();
    }

    /** 布防时刻（ISO-8601；从未布防返回 null）。 */
    public static String armedAt() {
        return armedAt;
    }

    /** 当前汇（未布防返回 null）。 */
    public static WindowDrainCollector collector() {
        return collector;
    }

    /**
     * 布防：开录窗总开关 + 开诊断会话（可选清零计数）+ 可选布防 TESR drain 汇。
     *
     * <p>
     * <b>幂等</b>：重复布防不抛错，但<b>会</b>按 {@code reset} 决定是否清零——「重复布防」在无人值守
     * 流程里是常态（脚本重跑），抛错会让重跑变成一次需要人工介入的失败。
     *
     * @param reset            是否清零诊断计数（true = 从零开始采本轮）
     * @param withDrainDump    是否布防 TESR drain 汇
     * @param latestWindowOnly drain 汇的「每格只留最后一个非空窗口」开关
     * @param at               ISO-8601 布防时刻
     * @return 布防前的状态快照（留痕用）
     */
    public static JsonObject arm(boolean reset, boolean withDrainDump, boolean latestWindowOnly, String at) {
        JsonObject before = status();
        TessellatorCaptureState.armWindows();
        if (reset) {
            CaptureDiagnostics.beginSession();
        } else if (!CaptureDiagnostics.isSessionEnabled()) {
            // 不清零但会话没开：仍然要开，否则后续计数一个也进不来（「布防了却什么都没记」最难查）
            CaptureDiagnostics.beginSession();
        }
        CaptureDiagSession.latestWindowOnly = latestWindowOnly;
        if (withDrainDump) {
            WindowDrainCollector c = collector;
            if (c == null) {
                c = new WindowDrainCollector();
                collector = c;
            } else if (reset) {
                c.clear();
            }
            TessellatorCaptureState.armWindowDrainSink(c);
        } else {
            // 布防是「观察条件的完整声明」：drainDump:false 必须同时撤掉此前挂上的汇。
            // 只加不减会让 drainDumpArmed 字段与实际挂载状态分叉——那个字段正是调用方判断
            // 「现在 dump 得不得得到几何」的依据，说谎比没有更糟（本单实测擒获）。
            TessellatorCaptureState.disarmWindowDrainSink();
        }
        armed = true;
        everArmed = true;
        drainDumpArmed = withDrainDump;
        armedAt = at;
        return before;
    }

    /**
     * 撤防：关诊断会话 + 撤 drain 汇 + 撤录窗总开关。
     *
     * <p>
     * <b>不清计数、不清 drain 汇</b>——撤防之后已采到的证据必须仍然可读、可 dump；
     * 否则「撤防」会顺手销毁刚采到的现场（老探针正是在收尾时才产出 dump，先清就永远拿不到几何）。
     *
     * @return 撤防前的状态快照（留痕用）
     */
    public static JsonObject disarm() {
        JsonObject before = status();
        CaptureDiagnostics.endSession();
        TessellatorCaptureState.disarmWindowDrainSink();
        TessellatorCaptureState.disarmWindows();
        armed = false;
        drainDumpArmed = false;
        return before;
    }

    /** 会话与汇的状态快照（读面、动作结果与事件留痕共用同一份）。 */
    public static JsonObject status() {
        JsonObject o = new JsonObject();
        o.addProperty("armed", armed);
        o.addProperty("everArmed", everArmed);
        o.addProperty("armedAt", armedAt);
        o.addProperty("diagnosticsSessionEnabled", CaptureDiagnostics.isSessionEnabled());
        o.addProperty("diagnosticsFileTarget", CaptureDiagnostics.hasFileTarget());
        o.addProperty("windowsArmed", TessellatorCaptureState.areWindowsArmed());
        o.addProperty("windowsDisarmPending", TessellatorCaptureState.isWindowDisarmPending());
        o.addProperty("drainDumpArmed", drainDumpArmed);
        o.addProperty("drainSinkAttached", TessellatorCaptureState.isWindowDrainArmed());
        o.addProperty("latestWindowOnly", latestWindowOnly);
        WindowDrainCollector c = collector;
        o.addProperty("drainWindows", c == null ? 0 : c.windows());
        o.addProperty("drainWindowsWithFlow", c == null ? 0 : c.windowsWithFlow());
        o.addProperty("drainQuads", c == null ? 0 : c.quadCount());
        o.addProperty("drainCells", c == null ? 0 : c.cellCount());
        return o;
    }

    /**
     * 把会话与汇全部清回「从未布防」。
     *
     * <p>
     * 公开而非包私有：会话态是<b>类级单例</b>（跨动作、跨作业存活），单测分布在多个包里，
     * 每个用例都必须能从「从未布防」起手，否则用例互相污染（一个用例的布防会让另一个用例的
     * 「未采集空态」断言假红）。这不是「为测试开后门」——它等价于重启进程，不改变任何生产语义。
     */
    public static void resetForTesting() {
        CaptureDiagnostics.endSession();
        TessellatorCaptureState.disarmWindowDrainSink();
        TessellatorCaptureState.disarmWindows();
        armed = false;
        everArmed = false;
        drainDumpArmed = false;
        latestWindowOnly = false;
        armedAt = null;
        collector = null;
    }

    // ------------------------------------------------------------------ 读数（read.capture 的数据源）

    /** 通道枚举名（读面的 {@code channel} 过滤取值与自描述共用同一份）。 */
    public static List<String> channelNames() {
        List<String> out = new ArrayList<String>();
        for (CaptureChannel c : CaptureChannel.values()) {
            out.add(c.name());
        }
        return out;
    }

    /**
     * 规范化通道过滤取值。
     *
     * @param raw 原始取值（null/空 = all；大小写不敏感）
     * @return {@code null} 表示「不过滤（all）」，否则为规范化后的通道名
     * @throws com.lightning.mod.client.controlplane.core.CpException CP-VALID-002：未知通道名
     */
    public static String normalizeChannel(String raw) {
        if (raw == null || raw.trim()
            .isEmpty()) {
            return null;
        }
        String v = raw.trim();
        if ("all".equalsIgnoreCase(v) || "*".equals(v)) {
            return null;
        }
        for (CaptureChannel c : CaptureChannel.values()) {
            if (c.name()
                .equalsIgnoreCase(v)) {
                return c.name();
            }
        }
        throw com.lightning.mod.client.controlplane.core.CpException
            .param("未知的捕获通道", "channel", "取值须为 all 或 " + channelNames() + " 之一，收到: " + raw);
    }

    // ------------------------------------------------------------------ drain-dump 装配

    /** 一格 dump 输入（装配前的规范化形态）。 */
    public static final class DumpCell {

        /** 世界格坐标。 */
        public final int x;
        /** 见 {@link #x}。 */
        public final int y;
        /** 见 {@link #x}。 */
        public final int z;
        /** 该格 drain 到的实录四边形（可为空 = 该格录不到几何）。 */
        public final List<CapturedQuad> quads;

        DumpCell(int x, int y, int z, List<CapturedQuad> quads) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.quads = quads == null ? new ArrayList<CapturedQuad>() : quads;
        }
    }

    /**
     * 解析要 dump 的格清单。
     *
     * <p>
     * 两种来源：① 显式 {@code at:[[x,y,z],…]}（调用方指定受控格，含<b>录不到</b>的格——它们会如实进
     * {@code missing}）；② 不给 {@code at} 时取 drain 汇里<b>实际有几何</b>的格。两者语义不同：
     * ① 能表达「这一格本该有几何却没有」，② 只能说「这些格采到了几何」。调用方要判「漏录」必须用 ①。
     *
     * @param explicit 显式格清单（{@code [[x,y,z],…]}），可为 null
     * @return 规范化的格清单
     * @throws com.lightning.mod.client.controlplane.core.CpException CP-VALID-002：形态非法或超上限
     */
    public static List<DumpCell> resolveDumpCells(JsonArray explicit) {
        List<DumpCell> out = new ArrayList<DumpCell>();
        WindowDrainCollector c = collector;
        if (explicit != null) {
            if (explicit.size() == 0) {
                throw com.lightning.mod.client.controlplane.core.CpException
                    .param("at 为空数组", "at", "须给出至少一格 [x,y,z]（空数组与「不给」含义不同：前者是「零个受控格」，后者是「用 drain 到的格」）");
            }
            if (explicit.size() > MAX_DUMP_CELLS) {
                throw com.lightning.mod.client.controlplane.core.CpException
                    .param("at 过大", "at", explicit.size() + " 格 > 上限 " + MAX_DUMP_CELLS + "（逐格装配是 CPU + 内存开销）");
            }
            com.lightning.mod.client.controlplane.core.Fields fields = new com.lightning.mod.client.controlplane.core.Fields();
            java.util.Set<String> seen = new java.util.LinkedHashSet<String>();
            for (int i = 0; i < explicit.size(); i++) {
                int[] pos;
                try {
                    pos = com.lightning.mod.client.controlplane.mc.read.ReadSupport
                        .coords(explicit.get(i), "at[" + i + "]");
                } catch (RuntimeException e) {
                    fields.add("at[" + i + "]", e.getMessage());
                    continue;
                }
                com.lightning.mod.client.controlplane.mc.read.ReadSupport.checkBounds(pos, "at[" + i + "]", fields);
                if (!seen.add(cellKey(pos[0], pos[1], pos[2]))) {
                    fields.add("at[" + i + "]", "重复的格坐标 " + cellKey(pos[0], pos[1], pos[2]));
                    continue;
                }
                out.add(new DumpCell(pos[0], pos[1], pos[2], c == null ? null : c.quadsAt(pos[0], pos[1], pos[2])));
            }
            fields.throwIfAny("dump 格清单非法（" + fields.size() + " 处）");
            return out;
        }
        if (c == null || c.cellCount() == 0) {
            throw new com.lightning.mod.client.controlplane.core.CpException(
                com.lightning.mod.client.controlplane.core.ErrorCodes.STATE,
                "没有可 dump 的格：drain 汇未布防或未采到任何几何",
                Json.object(
                    "action",
                    CaptureDiagAction.NAME,
                    "drainDumpArmed",
                    Boolean.valueOf(drainDumpArmed),
                    "drainSinkAttached",
                    Boolean.valueOf(TessellatorCaptureState.isWindowDrainArmed()),
                    "drainWindows",
                    Integer.valueOf(c == null ? 0 : c.windows()),
                    "hint",
                    "先 capture.diag {arm:true,drainDump:true,confirm:true} 布防，再让世界真实渲染（shot.multi 或"
                        + " case.run 的 cameras 段），最后再 dump；或显式给 at:[[x,y,z],…] 指定受控格（含录不到的格）"));
        }
        if (c.cellCount() > MAX_DUMP_CELLS) {
            throw com.lightning.mod.client.controlplane.core.CpException
                .param("drain 到的格过多", "at", c.cellCount() + " 格 > 上限 " + MAX_DUMP_CELLS + "；请显式给 at 缩小范围");
        }
        for (String key : c.cellKeys()) {
            int[] pos = WindowDrainCollector.parseCellKey(key);
            if (pos == null) {
                continue;
            }
            out.add(new DumpCell(pos[0], pos[1], pos[2], c.quadsAt(pos[0], pos[1], pos[2])));
        }
        return out;
    }

    /**
     * 把格清单装配成 web 可加载的 V2 场景文档（与老探针的 dump 产物同形）。
     *
     * <p>
     * 唯一的 MC 触点是「逐格问客户端世界要 registryId/meta」（{@code getBlock}/{@code getBlockMetadata}）
     * 与材质表/纹理嵌入（{@link MeshCaptureService.CaptureToolkit} + {@code TextureBlobEmbedder}）——
     * 都是<b>只读</b>调用。装配器 {@link CaptureDumpAssembler} 是纯函数（块局部归一化 + 调色板去重 +
     * cellGrid），与老探针逐字复用同一份实现，因此产物形态不因迁移而变。
     *
     * @param cells  格清单（{@link #resolveDumpCells} 的产物）
     * @param margin 最小包围盒外扩的格数（「周边空气」）
     * @param label  产物标签（进 id/meta，便于区分多次 dump）
     * @return {@code {document, assembly, cellSources, warnings}}；
     *         {@code document} 为 V2 根对象，{@code assembly} 为装配统计
     * @throws com.lightning.mod.client.controlplane.core.CpException CP-STATE-001：客户端世界不可用
     */
    public static JsonObject assembleDump(List<DumpCell> cells, int margin, String label) {
        Minecraft mc = Minecraft.getMinecraft();
        if (mc == null || mc.theWorld == null) {
            throw new com.lightning.mod.client.controlplane.core.CpException(
                com.lightning.mod.client.controlplane.core.ErrorCodes.STATE,
                "客户端世界不可用，无法读 dump 各格的方块身份（registryId/meta 只能问客户端世界）",
                Json.object(
                    "action",
                    CaptureDiagAction.NAME,
                    "hint",
                    "先进世界（world.rebuild {folder:\"cp_…\",seed:<整数>,void:true,confirm:true}）再 dump"));
        }
        if (cells == null || cells.isEmpty()) {
            throw com.lightning.mod.client.controlplane.core.CpException
                .param("dump 格清单为空", "at", "没有任何格可装配（空清单不产产物：空转绿比报错更糟）");
        }
        if (margin < 0 || margin > MAX_DUMP_MARGIN) {
            throw com.lightning.mod.client.controlplane.core.CpException
                .param("margin 越界", "margin", "须在 0.." + MAX_DUMP_MARGIN + "，收到 " + margin);
        }

        JsonArray warnings = new JsonArray();
        JsonArray cellSources = new JsonArray();
        List<CaptureDumpAssembler.CellInput> inputs = new ArrayList<CaptureDumpAssembler.CellInput>();
        TextureMap textureMap = mc.getTextureMapBlocks();
        MeshCaptureService.CaptureToolkit.MaterialTable materialTable = new MeshCaptureService.CaptureToolkit.MaterialTable();

        for (DumpCell c : cells) {
            Block block = mc.theWorld.getBlock(c.x, c.y, c.z);
            int meta = mc.theWorld.getBlockMetadata(c.x, c.y, c.z);
            TileEntity te = mc.theWorld.getTileEntity(c.x, c.y, c.z);
            String registryId = "unknown";
            if (block != null) {
                String reg = Block.blockRegistry.getNameForObject(block);
                if (reg != null && !reg.isEmpty()) {
                    registryId = reg;
                }
            } else {
                warnings.add(
                    new com.google.gson.JsonPrimitive(
                        "dump：客户端该格方块为 null，registryId 记为 unknown @" + cellKey(c.x, c.y, c.z)));
            }
            JsonObject src = new JsonObject();
            src.addProperty("label", "cell@" + cellKey(c.x, c.y, c.z));
            src.addProperty("x", Integer.valueOf(c.x));
            src.addProperty("y", Integer.valueOf(c.y));
            src.addProperty("z", Integer.valueOf(c.z));
            src.addProperty("registryId", registryId);
            src.addProperty("meta", Integer.valueOf(meta));
            src.addProperty(
                "clientTeClass",
                te == null ? null
                    : te.getClass()
                        .getName());
            src.addProperty("drainedQuads", Integer.valueOf(c.quads.size()));
            cellSources.add(src);

            // 四边形外壳先复制：attachQuadMaterials 会就地重写顶点 UV（不可逆），
            // 不许污染 drain 汇里的原始记录（老探针同款纪律）
            CapturedBlockInstance inst = new CapturedBlockInstance();
            for (CapturedQuad q : c.quads) {
                inst.quads.add(CaptureDumpAssembler.copyQuad(q));
            }
            if (!inst.quads.isEmpty()) {
                MeshCaptureService.CaptureToolkit.attachQuadMaterials(inst, textureMap, materialTable);
            }
            // 标签口径：老探针用受控放置的 label（pipe-1/chest-1），控制面没有「放置计划」这一层，
            // 故用世界格坐标作标签——它是 dump 格清单里唯一稳定且不依赖调用方命名的身份
            inputs.add(
                new CaptureDumpAssembler.CellInput(
                    "cell@" + cellKey(c.x, c.y, c.z),
                    registryId,
                    meta,
                    c.x,
                    c.y,
                    c.z,
                    inst.quads));
        }

        // 装配器对空 cells 抛 IllegalArgumentException（契约是「不产空产物」）；
        // 这里已在上面显式拦过，兜底再包一层，保证失败是 CpException 而不是裸异常（D4 失败显式）
        CaptureDumpAssembler.Assembly assembly;
        try {
            assembly = CaptureDumpAssembler.assemble(inputs, margin);
        } catch (RuntimeException e) {
            throw new com.lightning.mod.client.controlplane.core.CpException(
                com.lightning.mod.client.controlplane.core.ErrorCodes.EXEC_FAILED,
                "dump 装配失败: " + ModReflect.describe(e),
                Json.object("action", CaptureDiagAction.NAME, "cells", Integer.valueOf(inputs.size())),
                e);
        }

        JsonObject root = new JsonObject();
        root.addProperty("format_version", "2.0");
        root.addProperty("id", "sde-cp-capture-diag/" + (label == null ? "capture-diag" : label));
        JsonObject metaJson = new JsonObject();
        metaJson.addProperty("name", "SDE cp capture diag dump (" + (label == null ? "capture-diag" : label) + ")");
        metaJson.addProperty("author", "");
        metaJson.addProperty("created_at_ms", Long.valueOf(System.currentTimeMillis()));
        metaJson.addProperty(
            "description",
            "TESR 录窗实录几何（drain-dump；cellGrid 覆盖受控格 + " + margin
                + " 格周边空气）。"
                + "几何唯一来源是 TessellatorCaptureState.endWindowAndDrain 交出的窗口四边形，不从静态数据兜底。");
        metaJson.add("tags", new JsonArray());
        JsonObject origin = new JsonObject();
        origin.addProperty("x", Integer.valueOf(assembly.minX));
        origin.addProperty("y", Integer.valueOf(assembly.minY));
        origin.addProperty("z", Integer.valueOf(assembly.minZ));
        metaJson.add("origin", origin);
        root.add("meta", metaJson);
        JsonArray frames = new JsonArray();
        JsonObject frame0 = new JsonObject();
        frame0.addProperty("index", Integer.valueOf(0));
        frame0.add("structure", assembly.structure);
        frames.add(frame0);
        root.add("frames", frames);
        root.add("annotations", new JsonArray());
        root.add("labels", new JsonArray());
        root.add("materialPalette", materialTable.toMaterialPalette());
        String textureBlobError = null;
        try {
            // 与现行导出/web fixture 同层级：根级 textureBlobs（base64 PNG）
            com.lightning.mod.client.export.TextureBlobEmbedder.embedIntoDocument(root);
        } catch (Throwable t) {
            textureBlobError = ModReflect.describe(t);
            warnings.add(new com.google.gson.JsonPrimitive("dump：textureBlobs 嵌入失败（几何仍写出）: " + textureBlobError));
        }

        JsonObject stats = new JsonObject();
        stats.addProperty("paletteEntries", Integer.valueOf(assembly.paletteEntries));
        stats.addProperty("duplicateQuads", Integer.valueOf(assembly.duplicateQuads));
        stats.add("perCellQuads", assembly.perCellQuads);
        stats.add("missing", toJsonArray(assembly.missing));
        stats.addProperty("missingCount", Integer.valueOf(assembly.missing.size()));
        stats.addProperty("status", assembly.missing.isEmpty() ? "ok" : "partial-missing-cells");
        stats.addProperty("materialPaletteEntries", Integer.valueOf(materialTable.size()));
        stats.addProperty(
            "textureBlobs",
            Integer.valueOf(
                root.has("textureBlobs") ? root.getAsJsonArray("textureBlobs")
                    .size() : 0));
        if (textureBlobError != null) {
            stats.addProperty("textureBlobError", textureBlobError);
        }
        JsonObject grid = new JsonObject();
        grid.addProperty("sizeX", Integer.valueOf(assembly.sizeX));
        grid.addProperty("sizeY", Integer.valueOf(assembly.sizeY));
        grid.addProperty("sizeZ", Integer.valueOf(assembly.sizeZ));
        grid.addProperty("minX", Integer.valueOf(assembly.minX));
        grid.addProperty("minY", Integer.valueOf(assembly.minY));
        grid.addProperty("minZ", Integer.valueOf(assembly.minZ));
        grid.addProperty("rowZeroIsTopY", Boolean.TRUE);
        stats.add("cellGrid", grid);
        stats.addProperty("geometrySource", "tesr-window-drain-only");
        stats.addProperty("staticFallback", Boolean.FALSE);
        stats.addProperty("cells", Integer.valueOf(inputs.size()));

        JsonObject out = new JsonObject();
        out.add("document", root);
        out.add("assembly", stats);
        out.add("cellSources", cellSources);
        out.add("warnings", warnings);
        return out;
    }

    private static JsonArray toJsonArray(List<String> list) {
        JsonArray a = new JsonArray();
        if (list != null) {
            for (String s : list) {
                a.add(new com.google.gson.JsonPrimitive(s));
            }
        }
        return a;
    }
}
