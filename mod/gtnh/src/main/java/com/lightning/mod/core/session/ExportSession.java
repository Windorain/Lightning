package com.lightning.mod.core.session;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.TreeMap;

import net.minecraft.entity.player.EntityPlayerMP;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.lightning.mod.client.controlplane.core.Hashing;
import com.lightning.mod.core.export.PackVersionProbe;
import com.lightning.mod.core.export.PendingDumpFiles;
import com.lightning.mod.core.registry.GregTechMetaTileRegistry;
import com.lightning.mod.core.sampling.IBlockSampler;
import com.lightning.mod.core.sampling.PolicyBackedBlockSampler;
import com.lightning.mod.core.scan.StructureScan;

/**
 * 会话状态、选区、多帧缓冲与落盘（单向：世界 → 内存 JSON 串 → export 写文件）。
 * 默认 {@link IBlockSampler} 为 {@link PolicyBackedBlockSampler}；扫描产物 {@code cellTypes[].meta} 对
 * {@code gregtech:gt.blockmachines} 为 mID，见 {@link GregTechMetaTileRegistry}。
 * <p>
 * 写出文件时：<strong>单帧</strong>为 {@link StructureScan} 的中间态（{@code geometryPhase=scan}，须再经客户端
 * finalize）；<strong>多帧</strong>为 Wiki
 * {@code World} 文档（不写顶层 {@code schemaVersion}）。
 *
 * <h2>线程语义与互斥口径</h2>
 *
 * 本单例是<b>进程级</b>的（{@link #INSTANCE}），在 1.7.10 集成服里被<b>至少三条线程</b>同时触碰：
 *
 * <ul>
 * <li><b>{@code Server thread}</b>：{@code /sde} 命令（{@code CommandSde#processCommand}）与
 * {@link com.lightning.mod.server.SdeServerRecordScheduler} 的服务端 tick 连录/cycle；</li>
 * <li><b>{@code Client thread}</b>：控制面动作（{@code ActionSteppingExecutor} 在
 * {@code TickEvent.ClientTickEvent} Phase.END 排空）、{@code ItemSde*} 工具物品、{@code PacketSaveCellNoteHandler}；
 * 以及 cp 的只读快照动作 {@code export.session}（同样是客户端 tick 线程）；</li>
 * <li><b>HTTP thread</b>：不直接触碰本类——cp 动作经作业队列在客户端 tick 线程执行
 * （contract.md §8 第 1 条「HTTP 线程绝不触碰 MC 状态」）。{@code cmd.exec} 也遵守这条：入队的是「在服务端线程
 * 执行命令」这件事，HTTP 线程只挂任务、阻塞等回包。</li>
 * </ul>
 *
 * <b>互斥口径（唯一锁）</b>：全部<b>公共</b>读写路径都在<b>同一个</b>监视器上同步——
 * {@link #LOCK}（本类的私有静态终态对象，{@code synchronized (LOCK)}），<b>不</b>用 {@code synchronized} 方法或
 * {@code synchronized(this)}。理由有三：
 *
 * <ol>
 * <li><b>一把锁覆盖双方</b>：命令路径（{@code CommandSde}）与 cp 路径（本类与 cp 动作）走的是同一批公共方法，
 * 锁在方法体内 ⇒ 两侧自动互斥，调用方无需各自加锁，也就不存在「谁忘了加锁」的缺口；</li>
 * <li><b>锁对象私有</b>：外部拿不到 {@link #LOCK}，无法与本类争抢同一监视器造成意外嵌套；
 * 用 {@code synchronized(this)} 则任何持有 {@code ExportSession.get()} 引用的代码都能自行
 * {@code synchronized (s)}，反而扩大争用面；</li>
 * <li><b>不跨对象加锁</b>：{@link #exportToFile()} / {@link #requestRegistryDump()} 的内部调用是
 * <b>可重入</b>的（同一线程重入 {@link #LOCK} 计数递增），因此无需拆成「私有无锁版 + 公共加锁版」两套实现，
 * 也就不会出现两条路径只有一条加了锁的漂移。</li>
 * </ol>
 *
 * <b>覆盖范围（判据：凡是读或写本例字段的公共路径一律覆盖）</b>：
 *
 * <table>
 * <caption>字段 → 公共路径 → 锁</caption>
 * <tr>
 * <td>{@code inSession}</td>
 * <td>{@link #startSession()} / {@link #endSession()} / {@link #isInSession()} /
 * {@link #getSelectionSnapshot()} / {@link #statusLine()}</td>
 * <td>LOCK</td>
 * </tr>
 * <tr>
 * <td>{@code pos1*} / {@code pos2*} / {@code selectionMode}</td>
 * <td>{@link #setPos1Block} /
 * {@link #setPos2Block} / {@link #getSelectionMode} / {@link #setSelectionMode} / {@link #hasCompleteSelection()} /
 * {@link #getSelectionSnapshot()} / {@link #statusLine()} / {@link #scanToStructureJsonOnly}</td>
 * <td>LOCK</td>
 * </tr>
 * <tr>
 * <td>{@code outputName} / {@code structureId}</td>
 * <td>getter/setter 对</td>
 * <td>LOCK</td>
 * </tr>
 * <tr>
 * <td>{@code activeFrame}</td>
 * <td>{@link #setActiveFrame} / {@link #getActiveFrame} / {@link #record} /
 * {@link #statusLine()}</td>
 * <td>LOCK</td>
 * </tr>
 * <tr>
 * <td>{@code frameJson}（TreeMap）</td>
 * <td>{@link #recordIntoFrame} / {@link #commitScanToFrame} /
 * {@link #getBufferedFrameCount} / {@link #exportToFile} / {@link #statusLine}</td>
 * <td>LOCK</td>
 * </tr>
 * <tr>
 * <td>{@code cellNotesByFrame}（HashMap）</td>
 * <td>{@link #getCellNote} / {@link #setCellNote} /
 * {@link #applyCellNotesToScanJson}（及其私有调用者）</td>
 * <td>LOCK</td>
 * </tr>
 * <tr>
 * <td>{@code sampler} / {@code lastAuthor} / {@code lastGtnhVersion} / {@code lastGtVersion}</td>
 * <td>{@link #setSampler} /
 * {@link #commitScanToFrame}（写）/ {@link #exportToFile}（读）</td>
 * <td>LOCK</td>
 * </tr>
 * </table>
 *
 * <b>故意不覆盖的两条</b>（都有明确理由，不是遗漏）：
 *
 * <ol>
 * <li>{@link #scanToStructureJsonOnly(EntityPlayerMP)} 的<b>世界扫描</b>只把「读走选区六值」这一步放进锁
 * （见方法注释）：扫描本身按区块遍历世界、可能耗时数百毫秒，若整段持锁，服务端线程的连录与客户端 tick 的
 * 只读快照都会被堵住——而扫描用的是<b>已经拷贝出来的局部坐标</b>，与单例后续写入不冲突。
 * 这是「锁状态、不锁重活」的口径，也是 <b>cmd.exec 不产生与 cp 读面死锁</b>的关键。</li>
 * <li>{@code jsonStringForScanCompare(JsonObject)} 只序列化<b>调用方传入</b>的局部对象，不读本例字段
 * ⇒ 无共享可变状态，无需加锁（加锁只会平白增加争用）。</li>
 * </ol>
 *
 * <b>为什么「一把粗锁」就够（而不是细粒度拆分）</b>：本类的共享状态是一个<b>一致性单元</b>——
 * 「选区 + 活动帧 + 帧缓冲 + 备注」必须彼此一致才有意义（例如 {@code commitScanToFrame} 同时读选区、
 * 写 {@code frameJson} 与 {@code cellNotesByFrame}）。细粒度锁无法在「帧写入」与「选区变更」之间保持这一
 * 不变式，反而可能让 export 读到「帧属于旧选区、选区已是新值」的撕裂组合。操作都是内存级短临界区
 * （序列化与扫描已被移出），单锁的吞吐代价可忽略。
 */
public final class ExportSession {

    private static final ExportSession INSTANCE = new ExportSession();
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting()
        .create();

    /**
     * 本单例唯一互斥锁（见类注释「线程语义与互斥口径」）。
     *
     * <p>
     * 私有静态终态：外部无法取得该对象，因此无法在本类之外与本类争抢同一监视器；
     * 本类全部公共读写路径的同步均针对它，命令路径（{@code Server thread}）与 cp 路径
     * （{@code Client thread}）因此天然互斥。
     */
    private static final Object LOCK = new Object();

    public static ExportSession get() {
        return INSTANCE;
    }

    private boolean inSession;
    private Integer pos1x;
    private Integer pos1y;
    private Integer pos1z;
    private Integer pos2x;
    private Integer pos2y;
    private Integer pos2z;
    private String outputName = "export";
    private String structureId = "structuredata.exported";
    private int activeFrame;
    private final Map<Integer, String> frameJson = new TreeMap<>();
    /**
     * 活动帧 / 各帧内体素备注：键为 {@link SdeCellCoords#cellKey(int, int, int)}，供 Wiki {@code sdeCellNotes} → 烘焙后
     * {@code tooltipPalette}/{@code cellTooltipGrid}。
     */
    private final Map<Integer, Map<String, String>> cellNotesByFrame = new HashMap<>();
    private IBlockSampler sampler = new PolicyBackedBlockSampler();
    private String lastAuthor = "server";
    /**
     * 最近一次 {@code record} 时的 <b>GTNH 整合包版本</b>（只来自 dreamcraft；缺席为空串）。
     *
     * <p>
     * 语义固定：它<b>不</b>会回退成 GregTech 版本（那会让同一个字段名在不同环境下读到两种语义）。
     * GregTech 版本走 {@link #lastGtVersion}。
     */
    private String lastGtnhVersion = "";
    /** 最近一次 {@code record} 时的 <b>GregTech 版本</b>；gregtech 缺席为空串。 */
    private String lastGtVersion = "";
    private SdeSelectionMode selectionMode = SdeSelectionMode.CUBOID;
    /**
     * 帧缓冲世代号：每次 {@link #frameJson} 或 {@link #cellNotesByFrame} 发生结构性变化
     * （写入帧 / 清空缓冲）时递增。
     *
     * <p>
     * <b>用途（只增不改）</b>：供 {@code export.session} 的 {@code bufferGeneration} 字段
     * 暴露，让调用方能用「世代号是否变化」判断缓冲有没有动过，而不必逐个比对帧哈希。
     * 这是「同会话同缓冲」机械判据的一部分（跨会话拼接产物判红）。
     *
     * <p>
     * <b>纯只读增量</b>：本字段<b>不</b>改变任何命令态行为——它只在既有的写入点顺手自增，
     * 不引入隐式清缓冲、不改变任何子命令语义（只增不改）。
     */
    private long bufferGeneration;

    private ExportSession() {}

    public void startSession() {
        synchronized (LOCK) {
            inSession = true;
        }
    }

    public void endSession() {
        synchronized (LOCK) {
            inSession = false;
        }
    }

    public boolean isInSession() {
        synchronized (LOCK) {
            return inSession;
        }
    }

    public SdeSelectionMode getSelectionMode() {
        synchronized (LOCK) {
            return selectionMode;
        }
    }

    public void setSelectionMode(SdeSelectionMode mode) {
        synchronized (LOCK) {
            this.selectionMode = mode != null ? mode : SdeSelectionMode.CUBOID;
        }
    }

    /**
     * 选区角点一；可由 {@code /sde pos1}（脚下方块，对齐 WorldEdit {@code //pos1}）、{@code /sde hpos1} 或选区工具左键等设置。
     * <p>
     * {@link SdeSelectionMode#EXTEND}：与 WorldEdit 扩展长方体类似，在已有 AABB 上并入驻入点；首次无选区时记为 1×1×1 角点。
     */
    public void setPos1Block(int x, int y, int z) {
        synchronized (LOCK) {
            if (selectionMode == SdeSelectionMode.EXTEND) {
                applyExtendPoint(x, y, z);
            } else {
                pos1x = x;
                pos1y = y;
                pos1z = z;
            }
        }
    }

    /**
     * 选区角点二；可由 {@code /sde pos2}、{@code /sde hpos2} 或选区工具右键等设置。
     * <p>
     * {@link SdeSelectionMode#EXTEND} 下语义与 pos1 相同，均为向当前选区并入该方块坐标。
     */
    public void setPos2Block(int x, int y, int z) {
        synchronized (LOCK) {
            if (selectionMode == SdeSelectionMode.EXTEND) {
                applyExtendPoint(x, y, z);
            } else {
                pos2x = x;
                pos2y = y;
                pos2z = z;
            }
        }
    }

    /**
     * WorldEdit 式 extend：新点并入选区长方体，结果存为 min→pos1、max→pos2。
     */
    private void applyExtendPoint(int x, int y, int z) {
        if (pos1x == null) {
            pos1x = x;
            pos1y = y;
            pos1z = z;
            pos2x = x;
            pos2y = y;
            pos2z = z;
            return;
        }
        if (pos2x == null) {
            pos2x = x;
            pos2y = y;
            pos2z = z;
            return;
        }
        expandAabbToInclude(x, y, z);
    }

    private void expandAabbToInclude(int x, int y, int z) {
        int mix = Math.min(pos1x, pos2x);
        int miy = Math.min(pos1y, pos2y);
        int miz = Math.min(pos1z, pos2z);
        int mxx = Math.max(pos1x, pos2x);
        int mxy = Math.max(pos1y, pos2y);
        int mxz = Math.max(pos1z, pos2z);
        mix = Math.min(mix, x);
        miy = Math.min(miy, y);
        miz = Math.min(miz, z);
        mxx = Math.max(mxx, x);
        mxy = Math.max(mxy, y);
        mxz = Math.max(mxz, z);
        pos1x = mix;
        pos1y = miy;
        pos1z = miz;
        pos2x = mxx;
        pos2y = mxy;
        pos2z = mxz;
    }

    public boolean hasCompleteSelection() {
        synchronized (LOCK) {
            return pos1x != null && pos1y != null && pos1z != null && pos2x != null && pos2y != null && pos2z != null;
        }
    }

    /** 供网络同步与客户端线框；未完成选区时 {@link SelectionSnapshot#complete} 为 false。 */
    public SelectionSnapshot getSelectionSnapshot() {
        synchronized (LOCK) {
            if (!hasCompleteSelection()) {
                return SelectionSnapshot.empty(this.inSession);
            }
            int minX = Math.min(pos1x, pos2x);
            int minY = Math.min(pos1y, pos2y);
            int minZ = Math.min(pos1z, pos2z);
            int maxX = Math.max(pos1x, pos2x);
            int maxY = Math.max(pos1y, pos2y);
            int maxZ = Math.max(pos1z, pos2z);
            return new SelectionSnapshot(inSession, true, minX, minY, minZ, maxX, maxY, maxZ);
        }
    }

    public void setOutputName(String name) {
        synchronized (LOCK) {
            if (name != null && !name.isEmpty()) outputName = name;
        }
    }

    public String getOutputName() {
        synchronized (LOCK) {
            return outputName;
        }
    }

    public void setStructureId(String id) {
        synchronized (LOCK) {
            if (id != null && !id.isEmpty()) structureId = id;
        }
    }

    public String getStructureId() {
        synchronized (LOCK) {
            return structureId;
        }
    }

    public void setActiveFrame(int n) {
        synchronized (LOCK) {
            if (n >= 0) activeFrame = n;
        }
    }

    public int getActiveFrame() {
        synchronized (LOCK) {
            return activeFrame;
        }
    }

    /** 调试用：当前已 record 的帧数 */
    public int getBufferedFrameCount() {
        synchronized (LOCK) {
            return frameJson.size();
        }
    }

    /** 当前帧、体素格备注；无则空串 */
    public String getCellNote(int frameIndex, int zSlice, int row, int column) {
        synchronized (LOCK) {
            Map<String, String> m = cellNotesByFrame.get(frameIndex);
            if (m == null) {
                return "";
            }
            String k = SdeCellCoords.cellKey(zSlice, row, column);
            String v = m.get(k);
            return v != null ? v : "";
        }
    }

    /** 保存或清除（text 空白则删） */
    public void setCellNote(int frameIndex, int zSlice, int row, int column, String text) {
        synchronized (LOCK) {
            Map<String, String> m = cellNotesByFrame.get(frameIndex);
            if (m == null) {
                m = new HashMap<>();
                cellNotesByFrame.put(frameIndex, m);
            }
            String k = SdeCellCoords.cellKey(zSlice, row, column);
            if (text == null || text.trim()
                .isEmpty()) {
                m.remove(k);
            } else {
                m.put(k, text);
            }
        }
    }

    /**
     * 将内存中的备注写入 scan 根对象（字段名 {@code sdeCellNotes}），与 {@code cellGrid} 同形语义；供客户端烘焙或再次导出。
     */
    public void applyCellNotesToScanJson(JsonObject root, int frameIndex) {
        synchronized (LOCK) {
            applyCellNotesToScanJsonLocked(root, frameIndex);
        }
    }

    /** {@link #applyCellNotesToScanJson} 的锁内实现（调用方已持 {@link #LOCK}）。 */
    private void applyCellNotesToScanJsonLocked(JsonObject root, int frameIndex) {
        if (root == null) {
            return;
        }
        if (!root.has("cellGrid")) {
            return;
        }
        int[] dim = readScanCellGridDimensions(root.getAsJsonArray("cellGrid"));
        if (dim == null) {
            return;
        }
        int sizeZ = dim[0], sizeRow = dim[1], sizeCol = dim[2];
        Map<String, String> m = cellNotesByFrame.get(frameIndex);
        JsonObject noteObj = new JsonObject();
        if (m != null) {
            for (Map.Entry<String, String> e : m.entrySet()) {
                int[] zrc = SdeCellCoords.tryParseCellKey(e.getKey());
                if (zrc == null) {
                    continue;
                }
                if (zrc[0] < 0 || zrc[0] >= sizeZ
                    || zrc[1] < 0
                    || zrc[1] >= sizeRow
                    || zrc[2] < 0
                    || zrc[2] >= sizeCol) {
                    continue;
                }
                String t = e.getValue();
                if (t == null || t.isEmpty()) {
                    continue;
                }
                noteObj.addProperty(e.getKey(), t);
            }
        }
        if (noteObj.entrySet()
            .isEmpty()) {
            root.remove("sdeCellNotes");
        } else {
            root.add("sdeCellNotes", noteObj);
        }
    }

    private static int[] readScanCellGridDimensions(JsonArray cellGrid) {
        if (cellGrid == null || cellGrid.size() == 0) {
            return null;
        }
        try {
            int sizeZ = cellGrid.size();
            JsonArray row0 = cellGrid.get(0)
                .getAsJsonArray();
            int sizeRow = row0.size();
            int sizeCol = row0.get(0)
                .getAsJsonArray()
                .size();
            return new int[] { sizeZ, sizeRow, sizeCol };
        } catch (Exception e) {
            return null;
        }
    }

    public void setSampler(IBlockSampler sampler) {
        synchronized (LOCK) {
            if (sampler != null) this.sampler = sampler;
        }
    }

    public String statusLine() {
        synchronized (LOCK) {
            return String.format(
                "session=%s sel=%s pos1=%s pos2=%s activeFrame=%d recordedFrames=%s",
                inSession,
                selectionMode,
                posStr(pos1x, pos1y, pos1z),
                posStr(pos2x, pos2y, pos2z),
                activeFrame,
                frameJson.keySet());
        }
    }

    /**
     * 单例态一致性快照（只读读面的数据源）。
     *
     * <p>
     * <b>为什么需要单独一个快照方法</b>：cp 的 {@code export.session} 动作要一次性读走
     * 「会话/选区/活动帧/已录帧/输出名/structureId」六类状态。<b>逐</b>调 getter 会拿到<b>互相矛盾</b>的组合
     * ——每个 getter 各自持锁释放，两次调用之间服务端线程可能刚写完 {@code record}，于是出现
     * 「选区已变、帧列表还是旧的」这类撕裂读数。快照在<b>同一临界区</b>内取全部字段，调用方拿到的一定是
     * 某个真实存在过的时刻的一致状态。
     *
     * <p>
     * 返回的 {@link Snapshot} 是<b>不可变值对象</b>（字段 final、{@code recordedFrames} 为已拷贝的 int 数组的
     * 只读视图），调用方在锁外读它不会与写入方竞争，也不会看到「读一半被改」的状态。
     */
    public Snapshot snapshot() {
        synchronized (LOCK) {
            int[] frames = new int[frameJson.size()];
            String[] hashes = new String[frameJson.size()];
            int i = 0;
            for (Map.Entry<Integer, String> e : frameJson.entrySet()) {
                frames[i] = e.getKey() == null ? 0 : e.getKey();
                // 帧内容 sha256：「同会话同缓冲」机械判据用。
                // 在锁内算：必须与 frames 数组取的是同一时刻的内容，否则世代与哈希会错配。
                hashes[i] = Hashing.sha256HexUtf8(e.getValue());
                i++;
            }
            return new Snapshot(
                inSession,
                selectionMode,
                pos1x,
                pos1y,
                pos1z,
                pos2x,
                pos2y,
                pos2z,
                activeFrame,
                frames,
                hashes,
                bufferGeneration,
                outputName,
                structureId,
                lastAuthor,
                lastGtnhVersion,
                lastGtVersion);
        }
    }

    /**
     * {@link #snapshot()} 的返回值：某一时刻单例态的一致副本（不可变）。
     *
     * <p>
     * 坐标类字段可为 {@code null}（未设置），与 {@link ExportSession#hasCompleteSelection()} 的语义一致；
     * cp 动作把它序列化成 JSON 的 {@code null} 而不是 0——「没设过」与「设在原点」必须可区分。
     */
    public static final class Snapshot {

        private final boolean inSession;
        private final SdeSelectionMode selectionMode;
        private final Integer pos1x;
        private final Integer pos1y;
        private final Integer pos1z;
        private final Integer pos2x;
        private final Integer pos2y;
        private final Integer pos2z;
        private final int activeFrame;
        private final int[] recordedFrames;
        private final String[] frameSha256;
        private final long bufferGeneration;
        private final String outputName;
        private final String structureId;
        private final String lastAuthor;
        private final String lastGtnhVersion;
        private final String lastGtVersion;

        Snapshot(boolean inSession, SdeSelectionMode selectionMode, Integer pos1x, Integer pos1y, Integer pos1z,
            Integer pos2x, Integer pos2y, Integer pos2z, int activeFrame, int[] recordedFrames, String[] frameSha256,
            long bufferGeneration, String outputName, String structureId, String lastAuthor, String lastGtnhVersion,
            String lastGtVersion) {
            this.inSession = inSession;
            this.selectionMode = selectionMode;
            this.pos1x = pos1x;
            this.pos1y = pos1y;
            this.pos1z = pos1z;
            this.pos2x = pos2x;
            this.pos2y = pos2y;
            this.pos2z = pos2z;
            this.activeFrame = activeFrame;
            this.recordedFrames = recordedFrames == null ? new int[0] : recordedFrames;
            this.frameSha256 = frameSha256 == null ? new String[0] : frameSha256;
            this.bufferGeneration = bufferGeneration;
            this.outputName = outputName;
            this.structureId = structureId;
            this.lastAuthor = lastAuthor;
            this.lastGtnhVersion = lastGtnhVersion;
            this.lastGtVersion = lastGtVersion;
        }

        /** 是否在会话中。 */
        public boolean inSession() {
            return inSession;
        }

        /** 选区模式。 */
        public SdeSelectionMode selectionMode() {
            return selectionMode;
        }

        /** 角点一坐标分量；未设置时为 null。 */
        public Integer pos1x() {
            return pos1x;
        }

        /** 见 {@link #pos1x()}。 */
        public Integer pos1y() {
            return pos1y;
        }

        /** 见 {@link #pos1x()}。 */
        public Integer pos1z() {
            return pos1z;
        }

        /** 角点二坐标分量；未设置时为 null。 */
        public Integer pos2x() {
            return pos2x;
        }

        /** 见 {@link #pos2x()}。 */
        public Integer pos2y() {
            return pos2y;
        }

        /** 见 {@link #pos2x()}。 */
        public Integer pos2z() {
            return pos2z;
        }

        /** 选区是否完整（两角点均已设置）。 */
        public boolean selectionComplete() {
            return pos1x != null && pos1y != null && pos1z != null && pos2x != null && pos2y != null && pos2z != null;
        }

        /** 活动帧。 */
        public int activeFrame() {
            return activeFrame;
        }

        /** 已录帧号（升序副本）；空数组表示尚未 record。 */
        public int[] recordedFrames() {
            int[] copy = new int[recordedFrames.length];
            System.arraycopy(recordedFrames, 0, copy, 0, recordedFrames.length);
            return copy;
        }

        /** 已录帧数。 */
        public int recordedFrameCount() {
            return recordedFrames.length;
        }

        /**
         * 逐帧内容 sha256（与 {@link #recordedFrames()} **同序**一一对应）；空数组表示尚未 record。
         *
         * <p>
         * 哈希口径：该帧<b>存进缓冲的那一刻</b>的 JSON 文本的 UTF-8 字节（{@code Hashing.sha256HexUtf8}），
         * 与 {@code observation-record.md} §2 第 1 条「对字节内容计算」一致。注意它哈希的是<b>缓冲内</b>的
         * scan 中间态，不是落盘后经客户端 enrich 的信封——两者形态不同（见 {@code exportToFile} 注释）。
         *
         * <p>
         * 用途（只增不改）：「同会话同缓冲」机械判据。跨会话拼接的产物其帧哈希
         * 会落在不同世代/不同缓冲里，可据此判红。
         */
        public String[] frameSha256() {
            String[] copy = new String[frameSha256.length];
            System.arraycopy(frameSha256, 0, copy, 0, frameSha256.length);
            return copy;
        }

        /**
         * 帧缓冲世代号：缓冲每发生一次结构性变化（写入帧 / 清空）就递增。
         *
         * <p>
         * 用途：调用方用「世代号是否变化」判断缓冲有没有动过。它是 {@code frameSha256[]} 的
         * 廉价伴随物——想判断「有没有动过」比哈希数组更省事，想判断「动成了什么」才需要哈希。
         */
        public long bufferGeneration() {
            return bufferGeneration;
        }

        /** 输出文件名（无后缀）。 */
        public String outputName() {
            return outputName;
        }

        /** structureId。 */
        public String structureId() {
            return structureId;
        }

        /** 最近一次 record 的作者；从未 record 时为 "server"。 */
        public String lastAuthor() {
            return lastAuthor;
        }

        /** 最近一次 record 时的 <b>GTNH 整合包版本</b>串（只来自 dreamcraft）；从未 record 或该模组缺席时为空串。 */
        public String lastGtnhVersion() {
            return lastGtnhVersion;
        }

        /** 最近一次 record 时的 <b>GregTech 版本</b>串；从未 record 或 gregtech 缺席时为空串。 */
        public String lastGtVersion() {
            return lastGtVersion;
        }
    }

    private static String posStr(Integer x, Integer y, Integer z) {
        if (x == null || y == null || z == null) return "null";
        return x + "," + y + "," + z;
    }

    /**
     * 将选区扫入 {@code frameJson[targetFrame]}；与活动帧解耦，不修改 {@link #activeFrame}。备注、{@code sdeCellNotes} 按
     * {@code targetFrame} 与 {@link #cellNotesByFrame} 关联。
     */
    public void recordIntoFrame(int targetFrame, EntityPlayerMP player) {
        commitScanToFrame(targetFrame, scanToStructureJsonOnly(player), player);
    }

    /**
     * 将已得到的 scan 根对象（无备注）写入指定帧；用于 cycle 等避免重复扫描。
     */
    public void commitScanToFrame(int targetFrame, JsonObject scanRoot, EntityPlayerMP player) {
        synchronized (LOCK) {
            if (!hasCompleteSelection()) {
                throw new IllegalStateException("请先 /sde pos1 与 /sde pos2（或 hpos/选区工具）");
            }
            lastAuthor = player.getCommandSenderName();
            // 两条版本事实取自**同一次**探测：不出现「整合包版本是这一秒的、GT 版本是下一秒的」
            PackVersionProbe.Versions versions = PackVersionProbe.tryVersions();
            lastGtnhVersion = versions.packVersion;
            lastGtVersion = versions.gtVersion;
            applyCellNotesToScanJsonLocked(scanRoot, targetFrame);
            frameJson.put(targetFrame, GSON.toJson(scanRoot));
            // 帧缓冲世代号自增：纯只读增量，不改变命令态行为
            bufferGeneration++;
        }
    }

    /**
     * 对当前选区做 scan 中间态，供 cycle 等比较用（在写入备注前）。不修改 {@link #frameJson}。
     *
     * <p>
     * <b>锁口径（见类注释「故意不覆盖的两条」）</b>：只把「读走选区六值 + 采样口径 + 结构 id」这一步放进
     * {@link #LOCK}；世界扫描本身在锁外执行。扫描按区块遍历世界，耗时可达数百毫秒，若整段持锁，会把服务端
     * 线程的连录与客户端 tick 的只读快照一起堵住（验收要求「命令执行期间 cp 读面与世界动作不死锁」）。
     * 扫描只用拷贝出来的局部坐标，与单例后续写入无共享状态，故锁外执行是安全的。
     */
    public JsonObject scanToStructureJsonOnly(EntityPlayerMP player) {
        final int x1, y1, z1, x2, y2, z2;
        final String id;
        final IBlockSampler samplerSnapshot;
        synchronized (LOCK) {
            if (!hasCompleteSelection()) {
                throw new IllegalStateException("请先 /sde pos1 与 /sde pos2（或 hpos/选区工具）");
            }
            x1 = pos1x;
            y1 = pos1y;
            z1 = pos1z;
            x2 = pos2x;
            y2 = pos2y;
            z2 = pos2z;
            id = structureId;
            samplerSnapshot = sampler;
        }
        return StructureScan.scanToStructureJson(player.worldObj, x1, y1, z1, x2, y2, z2, id, samplerSnapshot, player);
    }

    /**
     * 与 {@code GSON.toJson} 对 scan 根对象序列化，供 cycle 与首帧 {@code equals} 比较（在写入
     * sdeCellNotes 前对同一套 Gson 的字符串）。
     *
     * <p>
     * 本方法只序列化<b>调用方传入</b>的局部对象，不读本例任何字段 ⇒ 无共享可变状态，不加锁（见类注释）。
     */
    public String jsonStringForScanCompare(JsonObject scanRoot) {
        return GSON.toJson(scanRoot);
    }

    public void record(EntityPlayerMP player) {
        // 先取活动帧快照再扫（扫描不持锁，见 scanToStructureJsonOnly）；帧号在扫描期间被改写属预期竞态，
        // 与「命令逐条串行执行」的既有语义一致（/sde record 与 /sde setframe 不会同 tick 并发发出）。
        recordIntoFrame(getActiveFrame(), player);
    }

    /**
     * 帧缓冲的一次一致性读取：既给 {@code export.session} 用的元数据，也给导出用的
     * <b>帧体</b>（已并入逐格备注）。
     *
     * <h2>为什么必须与 {@link #snapshot()} 分开一个方法</h2>
     *
     * {@code snapshot()} 刻意<b>不含帧体</b>（帧体可达数十 MB，读面不该背它）。但 cp 的
     * {@code export.scene} 动作需要帧体，且必须在<b>同一临界区</b>内同时取走「帧体 + 帧号 + 逐帧哈希 +
     * 世代号 + 选区 + 身份字段」——分两次取会拿到互相矛盾的组合（动作跑到一半、命令刚 record 完一帧，
     * 于是产物的 {@code frames[]} 与 {@code provenance.frameSha256} 对不上，这正是竞态窗口）。
     *
     * <p>
     * 本方法因此是 cp 导出路径的<b>唯一</b>入口：一次持锁取走全部所需状态，返回不可变值对象。
     * 逐帧哈希口径与 {@code snapshot()} 逐字一致（缓冲内<b>原始</b>文本的 UTF-8 sha256，不是备注并入后的），
     * 否则 {@code export.session.frameSha256} 与产物溯源会对不上。
     */
    public Buffer bufferSnapshot() {
        synchronized (LOCK) {
            int[] frames = new int[frameJson.size()];
            String[] hashes = new String[frameJson.size()];
            Map<Integer, String> bodies = new TreeMap<>();
            int i = 0;
            for (Map.Entry<Integer, String> e : frameJson.entrySet()) {
                int idx = e.getKey() == null ? 0 : e.getKey();
                frames[i] = idx;
                hashes[i] = Hashing.sha256HexUtf8(e.getValue());
                bodies.put(idx, patchFrameJsonForExportLocked(idx, e.getValue()));
                i++;
            }
            Snapshot snap = new Snapshot(
                inSession,
                selectionMode,
                pos1x,
                pos1y,
                pos1z,
                pos2x,
                pos2y,
                pos2z,
                activeFrame,
                frames,
                hashes,
                bufferGeneration,
                outputName,
                structureId,
                lastAuthor,
                lastGtnhVersion,
                lastGtVersion);
            return new Buffer(snap, bodies);
        }
    }

    /**
     * {@link #bufferSnapshot()} 的返回值：元数据快照 + 帧体（均不可变副本）。
     *
     * <p>
     * {@code framesJson} 的键是帧号（升序，{@code TreeMap} 语义），值是<b>已并入该帧逐格备注</b>的
     * JSON 文本（与 {@code exportToFile} 写出的正文同源）——导出侧因此不必再持锁重算备注。
     */
    public static final class Buffer {

        private final Snapshot snapshot;
        private final Map<Integer, String> framesJson;

        Buffer(Snapshot snapshot, Map<Integer, String> framesJson) {
            this.snapshot = snapshot;
            this.framesJson = java.util.Collections.unmodifiableMap(new TreeMap<>(framesJson));
        }

        /** 元数据快照（选区/活动帧/帧号/哈希/世代/身份字段）。 */
        public Snapshot snapshot() {
            return snapshot;
        }

        /** 帧号 → 已并入备注的帧 JSON 文本（升序）。 */
        public Map<Integer, String> framesJson() {
            return framesJson;
        }

        /** 帧数。 */
        public int size() {
            return framesJson.size();
        }
    }

    /**
     * 写出结构 JSON 到 {@code structure_exports}（仅场景数据；注册表请用 {@link #requestRegistryDump()}）。
     *
     * <p>
     * <b>产物路径事实</b>：这里是<b>CWD 相对路径</b>
     * {@code structure_exports/}，而 {@code runClient} 下进程 CWD 恰等于 {@code mcDataDir}，
     * 于是它与客户端 enrich 写的 {@code new File(mcDataDir,"structure_exports")}（{@code MeshCaptureService}）
     * <b>指向同一目录、同一文件</b>——服务端先写、客户端随后覆盖。
     *
     * <p>
     * <b>本版改动（口径）</b>：本方法现在把「帧集合 → 文档」与「文档 → 字节」两段交给
     * {@link ExportSceneWriter}（<b>唯一</b>实现），并用 {@link ExportSceneWriter.Shape#AUTO} 形态，
     * 使本命令通道的行为<b>逐字节不变</b>——{@code AUTO} 就是原来的隐函数
     * （{@code frameJson.size()==1 && containsKey(0)} → 单结构；否则 World 多帧）。
     * cp 通道（{@code export.scene}）走同一个写入器，但形态恒 {@code world}（形态统一），
     * 且落点是它自己的 run 目录、带哈希登记（单一归属）。
     *
     * <p>
     * 老路径 {@code structure_exports/} 目前<b>只服务尚未搬迁的命令通道</b>，其删除另行安排。
     */
    public String exportToFile() throws IOException {
        synchronized (LOCK) {
            File dir = new File("structure_exports");
            if (!dir.exists() && !dir.mkdirs()) {
                throw new IOException("无法创建目录: " + dir.getAbsolutePath());
            }
            if (frameJson.isEmpty()) {
                throw new IllegalStateException("无缓冲数据，请先 record");
            }
            ExportSceneWriter.Meta meta = new ExportSceneWriter.Meta();
            meta.structureId = structureId;
            meta.label = structureId;
            meta.author = lastAuthor;
            meta.gtnhVersion = lastGtnhVersion;
            meta.gtVersion = lastGtVersion;
            meta.description = null;

            Map<Integer, String> bodies = new TreeMap<>();
            for (Map.Entry<Integer, String> e : frameJson.entrySet()) {
                bodies.put(e.getKey(), patchFrameJsonForExportLocked(e.getKey(), e.getValue()));
            }
            // 命令通道：不传 provenance/exportId ⇒ 产物正文与搬迁前逐字节一致（有单测锁这一点）
            JsonObject doc = ExportSceneWriter.buildDocument(meta, bodies, ExportSceneWriter.Shape.AUTO, null, null);
            String json = GSON.toJson(doc);
            File out = ExportSceneWriter.writeTextTo(dir, outputName, json);
            return out.getAbsolutePath();
        }
    }

    /**
     * 在 {@code structure_exports} 下落盘 {@link PendingDumpFiles#FILE_NAME}，供客户端下一 tick 起生成全量注册表 JSON。
     */
    public String requestRegistryDump() throws IOException {
        synchronized (LOCK) {
            File dir = new File("structure_exports");
            if (!dir.exists() && !dir.mkdirs()) {
                throw new IOException("无法创建目录: " + dir.getAbsolutePath());
            }
            JsonObject pendingDump = new JsonObject();
            pendingDump.addProperty("schemaVersion", PendingDumpFiles.SCHEMA_VERSION);
            pendingDump.addProperty("exportRoot", dir.getAbsolutePath());
            writeUtf8(new File(dir, PendingDumpFiles.FILE_NAME), GSON.toJson(pendingDump));
            return dir.getAbsolutePath();
        }
    }

    private static void writeUtf8(File file, String content) throws IOException {
        try (OutputStreamWriter w = new OutputStreamWriter(new FileOutputStream(file), StandardCharsets.UTF_8)) {
            w.write(content);
        }
    }

    /** 锁内实现（调用方已持 {@link #LOCK}）：把帧 JSON 解出、并入备注、重新序列化。 */
    private String patchFrameJsonForExportLocked(int frameIndex, String rawJson) {
        try {
            JsonObject root = new JsonParser().parse(rawJson)
                .getAsJsonObject();
            applyCellNotesToScanJsonLocked(root, frameIndex);
            return GSON.toJson(root);
        } catch (Exception e) {
            return rawJson;
        }
    }

    // ------------------------------------------------------ 测试钩子（包可见）

    /**
     * <b>仅供单测</b>：以给定的帧号与 JSON 文本写入帧缓冲，等效于 {@link #commitScanToFrame} 的最后一步
     * 而不需要 {@link EntityPlayerMP} 与世界。
     *
     * <p>
     * 存在的理由：{@link #commitScanToFrame} 需要真实玩家（取作者名）并调用 {@code PackVersionProbe}
     * （读模组元数据），这两点使并发单测无法在纯 JVM 下构造。但并发缺陷恰恰只与
     * 「{@code frameJson} 被多线程写」有关，与作者名从哪来无关。因此本钩子把<b>写入点</b>暴露出来，
     * 让单测能直接压测承重的那一处；它与公共写入路径共用同一把 {@link #LOCK}，
     * 所以单测覆盖的锁语义与生产路径完全相同。
     *
     * <p>
     * 包可见（非 public）：不构成对外的第二条写入通道，也就不会成为「无隐藏通道」意义上的「隐藏路径」。
     *
     * <p>
     * <b>必须与生产写入点逐项一致</b>：除了 {@code frameJson.put} 与同一把 {@link #LOCK}，
     * 这里同样自增 {@link #bufferGeneration}——本版的 {@code bufferGenerationIncrementsOnEachFrameWrite}
     * 单测正是靠这一点才在纯 JVM 下成立。若这里漏掉自增，单测覆盖的就不再是生产语义
     * （该缺陷在自测中被捕获过一次）。
     */
    void registerFrameForTest(int targetFrame, String frameJsonText) {
        synchronized (LOCK) {
            frameJson.put(targetFrame, frameJsonText);
            bufferGeneration++;
        }
    }

    /**
     * <b>仅供单测</b>：清空帧缓冲与备注（单例跨测试方法存活，必须能复位）。
     *
     * <p>
     * 不对外开放 clear 口是有意的：生产路径上「清空已录帧」应当表现为 {@code /sde start} 开新会话
     * （状态转换由请求驱动），而不是一个可被随手调用的清理函数。单测需要它只是为了隔离。
     */
    void clearFramesForTest() {
        synchronized (LOCK) {
            frameJson.clear();
            cellNotesByFrame.clear();
            bufferGeneration++;
        }
    }

    /** <b>仅供单测</b>：读取某帧的原始 JSON 文本；缺帧返回 null。 */
    String frameJsonForTest(int targetFrame) {
        synchronized (LOCK) {
            return frameJson.get(targetFrame);
        }
    }
}
