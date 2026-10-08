package com.lightning.mod.core.session;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.TreeMap;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.lightning.mod.client.export.SceneEnvelopeBuilder;

/**
 * 场景文件（{@code StructureData} / {@code World}）的<b>唯一</b>合并与序列化实现（Gitea #102 收口T5）。
 *
 * <h2>为什么必须有它（D2 的机械保证）</h2>
 *
 * 搬迁前「把内存帧写成场景文件」这件事只有一处实现：{@link ExportSession#exportToFile()}。
 * #102 要让两条通道都能写出场景文件——
 *
 * <ul>
 * <li><b>命令通道</b>：{@code cmd.exec {command:"/sde export"}} → 服务端线程 → 写
 * {@code structure_exports/<name>.json}（既有行为，逐字节不变）；</li>
 * <li><b>API 通道</b>：{@code export.scene} → 客户端 tick 线程 → 写 run 目录
 * {@code export/<name>.json} 并登记哈希清单。</li>
 * </ul>
 *
 * 「同语义经 API 与经命令执行结果一致」（#96 §10-D2）若靠两份实现去对齐，就退化成约定而不是事实。
 * 因此本类把「帧集合 → 文档对象」与「文档对象 → 磁盘字节」两段抽成唯一实现，两条通道都调它，
 * 差别只有 {@code outDir} 与 {@link Shape} 两个入参。
 *
 * <h2>{@link Shape}：R1-3 形态分叉的显式化（派发裁决 5）</h2>
 *
 * 搬迁前 {@code exportToFile()} 的形态判据是<b>帧号的隐函数</b>：
 * {@code frameJson.size()==1 && containsKey(0)} 才写「纯 scan 中间态」（单结构文档），否则写
 * {@code {id,mode,frames[],playback}}（World 多帧文档）。后果是「{@code /sde setframe 5} 之后 record 一次」
 * 会产出多帧文档形态——调用方<b>无法从参数预知</b>产物是哪种文件，C1（单场景文件）与 C2（多帧）
 * 各自绿却可能不是同一种文件（假绿）。
 *
 * <p>
 * 本类把形态做成<b>显式枚举</b>，并规定各通道的口径：
 *
 * <table>
 * <caption>形态口径</caption>
 * <tr>
 * <th>{@link Shape}</th>
 * <th>规则</th>
 * <th>谁用</th>
 * </tr>
 * <tr>
 * <td>{@link Shape#AUTO}</td>
 * <td>既有隐函数（{@code {0}} → 单结构；否则 World）</td>
 * <td><b>仅</b>命令通道 {@code /sde export}，用于逐字节保留既有行为（#104 处置老入口）</td>
 * </tr>
 * <tr>
 * <td>{@link Shape#WORLD}</td>
 * <td>恒 {@code {id,mode,frames[],playback}}，<b>单帧即 N=1 的多帧文档</b></td>
 * <td>cp 通道 {@code export.scene} 的<b>默认</b>——C1 与 C2 因此是同一种文件</td>
 * </tr>
 * <tr>
 * <td>{@link Shape#STRUCTURE}</td>
 * <td>恒裸单结构文档（该帧的 scan/baked 根）</td>
 * <td>cp 通道显式指定 {@code shape:"structure"}（需要裸 {@code StructureData} 的消费方）</td>
 * </tr>
 * </table>
 *
 * <p>
 * <b>两态的实质差异（自述里必须写清，不能只写「形态不同」）</b>：World 分支在客户端烘焙阶段会做
 * {@code liftBlockPaletteToRoot}（跨帧调色板全局去重、{@code cellGrid} 重映射为全局下标、帧内
 * {@code blockPalette} 被移除），而单结构分支不做。因此 {@code shape:"structure"} 的产物
 * <b>不做</b>跨帧调色板提升——它是「只有一帧时的裸形态」，与 World 形态不可互替。
 *
 * <h2>确定性（产物可复算）</h2>
 *
 * 本类不写任何时间戳、绝对路径或 runId 进产物<b>正文</b>；{@code provenance} 只在调用方显式传入时
 * 出现（cp 通道传，命令通道不传 → 既有产物逐字节不变）。帧序恒按帧号升序（{@code TreeMap} 语义），
 * 与录制顺序无关。
 */
public final class ExportSceneWriter {

    /** 单结构文档的默认 mode（与既有 {@code StructureScan} 一致）。 */
    public static final String MODE_MULTIBLOCK = "multiblock";

    /** {@code playback.loop} 的既定事实值：本期恒 false（#96 §6.1 明写不作为本期缺陷）。 */
    public static final boolean PLAYBACK_LOOP = false;

    /** {@code playback.defaultFrameIndex} 的既定值。 */
    public static final int PLAYBACK_DEFAULT_FRAME_INDEX = 0;

    /** provenance 的 schema 标识。 */
    public static final String SCHEMA_PROVENANCE = "lightning.scene-export-provenance/1";

    /** provenance 在产物里的键名（World 形态进 meta，单结构形态进根）。 */
    public static final String FIELD_PROVENANCE = "provenance";

    /** 逐帧来源标识的键名（供 C3 判据检测跨次拼接）。 */
    public static final String FIELD_EXPORT_ID = "exportId";

    private static final Gson GSON = new GsonBuilder().setPrettyPrinting()
        .create();

    private static final Gson COMPACT = new Gson();

    private ExportSceneWriter() {}

    /** 产物形态（见类注释）。 */
    public enum Shape {

        /** 既有隐函数（仅命令通道用于逐字节兼容）。 */
        AUTO("auto"),
        /** 恒 World 多帧文档（cp 通道默认）。 */
        WORLD("world"),
        /** 恒裸单结构文档。 */
        STRUCTURE("structure");

        private final String id;

        Shape(String id) {
            this.id = id;
        }

        /** 自述/结果里的稳定字符串。 */
        public String id() {
            return id;
        }

        /** 解析形态名；未知返回 null（调用方负责报 CP-VALID-002）。 */
        public static Shape parse(String s) {
            if (s == null) {
                return null;
            }
            String v = s.trim()
                .toLowerCase(java.util.Locale.ROOT);
            for (Shape x : values()) {
                if (x.id.equals(v)) {
                    return x;
                }
            }
            return null;
        }

        /** 全部合法取值（自述用）。 */
        public static String choices() {
            StringBuilder sb = new StringBuilder();
            for (Shape x : values()) {
                if (sb.length() > 0) {
                    sb.append(" | ");
                }
                sb.append(x.id);
            }
            return sb.toString();
        }
    }

    /** 一次合并的元数据（文档根上的身份字段）。 */
    public static final class Meta {

        /** {@code id}。 */
        public String structureId = "structuredata.exported";
        /** {@code label}。 */
        public String label;
        /** {@code author}。 */
        public String author = "server";
        /** {@code gtnhVersion}。 */
        public String gtnhVersion = "";
        /** {@code description}（null → 产物里是 JSON null，与既有行为一致）。 */
        public String description;
    }

    /**
     * 帧集合 → 文档对象（<b>唯一</b>实现；调用方给出的帧 JSON 必须已并入逐格备注）。
     *
     * @param meta       文档身份字段
     * @param frames     帧号 → 该帧 JSON 文本（升序语义由调用方保证；本方法按 {@code TreeMap} 迭代）
     * @param shape      形态（{@link Shape#AUTO} 保留既有隐函数）
     * @param provenance 溯源对象；null = 不写（命令通道走这条 ⇒ 既有产物逐字节不变）
     * @param exportId   写进每个 {@code frames[i]} 的来源标识；null = 不写（命令通道）
     * @return 文档对象（尚未烘焙、尚未信封化）
     * @throws IllegalArgumentException 帧集为空，或 {@link Shape#STRUCTURE} 但帧数 ≠ 1
     */
    public static JsonObject buildDocument(Meta meta, Map<Integer, String> frames, Shape shape, JsonObject provenance,
        String exportId) {
        if (frames == null || frames.isEmpty()) {
            throw new IllegalArgumentException("无缓冲数据，请先 record");
        }
        Meta m = meta == null ? new Meta() : meta;
        Shape s = shape == null ? Shape.AUTO : shape;
        Map<Integer, String> ordered = new TreeMap<Integer, String>(frames);

        if (s == Shape.AUTO) {
            s = ordered.size() == 1 && ordered.containsKey(Integer.valueOf(0)) ? Shape.STRUCTURE : Shape.WORLD;
        }

        if (s == Shape.STRUCTURE) {
            if (ordered.size() != 1) {
                throw new IllegalArgumentException(
                    "shape=structure 要求恰好一帧（当前 " + ordered.size() + " 帧）；多帧请用 shape=world");
            }
            Map.Entry<Integer, String> only = ordered.entrySet()
                .iterator()
                .next();
            JsonObject root = parseOrThrow(only.getValue());
            if (provenance != null) {
                root.add(FIELD_PROVENANCE, provenance);
            }
            if (exportId != null) {
                root.addProperty(FIELD_EXPORT_ID, exportId);
            }
            return root;
        }

        // ---- World 多帧文档 ----
        JsonObject world = new JsonObject();
        world.addProperty("id", m.structureId);
        world.addProperty("mode", MODE_MULTIBLOCK);
        world.addProperty("label", m.label != null ? m.label : m.structureId);
        world.addProperty("author", m.author);
        world.addProperty("gtnhVersion", m.gtnhVersion);
        world.add(
            "description",
            m.description == null ? JsonNull.INSTANCE : new com.google.gson.JsonPrimitive(m.description));
        world.add("tooltipPalette", new JsonArray());

        JsonArray out = new JsonArray();
        JsonParser parser = new JsonParser();
        for (Map.Entry<Integer, String> e : ordered.entrySet()) {
            JsonObject fr = new JsonObject();
            fr.addProperty("index", e.getKey());
            fr.add(
                "structure",
                parser.parse(e.getValue())
                    .getAsJsonObject());
            if (exportId != null) {
                fr.addProperty(FIELD_EXPORT_ID, exportId);
            }
            out.add(fr);
        }
        world.add("frames", out);

        JsonObject playback = new JsonObject();
        playback.addProperty("loop", PLAYBACK_LOOP);
        playback.addProperty("defaultFrameIndex", PLAYBACK_DEFAULT_FRAME_INDEX);
        world.add("playback", playback);

        if (provenance != null) {
            world.add(FIELD_PROVENANCE, provenance);
        }
        if (exportId != null) {
            // 根级 exportId：Envelope 化时它会进 meta（SceneEnvelopeBuilder 的 frames 分支），
            // 因此消费方解包后仍能读到「这份产物是哪一次导出写的」——帧内那份用于逐帧配对。
            world.addProperty(FIELD_EXPORT_ID, exportId);
        }
        return world;
    }

    /**
     * 文档对象 → 磁盘字节（<b>唯一</b>实现）。
     *
     * @param document 已烘焙的终态文档（World 或裸 StructureData）
     * @param raw      true = 明文 {@code documentFormat:Plain}；false = gzip+base64 {@code Envelope}
     * @return 要写盘的 UTF-8 字节
     */
    public static byte[] serialize(JsonObject document, boolean raw) {
        if (document == null) {
            throw new IllegalArgumentException("document 不能为 null");
        }
        if (raw) {
            JsonObject plain = document;
            plain.addProperty("documentFormat", "Plain");
            return GSON.toJson(plain)
                .getBytes(StandardCharsets.UTF_8);
        }
        JsonObject envelope = SceneEnvelopeBuilder.toEnvelope(document);
        return COMPACT.toJson(envelope)
            .getBytes(StandardCharsets.UTF_8);
    }

    /**
     * 写盘（不登记；登记是 cp 侧 {@code ArtifactStore} 的职责）。
     *
     * @param outDir        产物目录（调用方给出：命令通道传 {@code structure_exports}，cp 传 run 目录内子目录）
     * @param fileNameNoExt 文件名（无后缀）
     * @param bytes         内容
     * @return 实际写出的文件绝对路径
     * @throws IOException 目录创建或写入失败
     */
    public static File writeTo(File outDir, String fileNameNoExt, byte[] bytes) throws IOException {
        if (outDir == null) {
            throw new IOException("产物目录为 null");
        }
        if (!outDir.exists() && !outDir.mkdirs()) {
            throw new IOException("无法创建目录: " + outDir.getAbsolutePath());
        }
        File out = new File(outDir, fileNameNoExt + ".json");
        try (FileOutputStream fos = new FileOutputStream(out)) {
            fos.write(bytes == null ? new byte[0] : bytes);
        }
        return out;
    }

    /** 写 UTF-8 文本（既有 {@code ExportSession.writeUtf8} 的同口径实现）。 */
    public static File writeTextTo(File outDir, String fileNameNoExt, String text) throws IOException {
        if (outDir == null) {
            throw new IOException("产物目录为 null");
        }
        if (!outDir.exists() && !outDir.mkdirs()) {
            throw new IOException("无法创建目录: " + outDir.getAbsolutePath());
        }
        File out = new File(outDir, fileNameNoExt + ".json");
        try (OutputStreamWriter w = new OutputStreamWriter(new FileOutputStream(out), StandardCharsets.UTF_8)) {
            w.write(text == null ? "" : text);
        }
        return out;
    }

    /**
     * 构造溯源对象（cp 通道用；命令通道不传 ⇒ 产物正文逐字节不变）。
     *
     * <p>
     * 用途是 C3「同会话同缓冲」的<b>机械判据</b>：同一个产物内全部帧的 {@code exportId} 必须一致，
     * {@code recordedFrames[]} 与 {@code frameSha256[]} 必须同长同序、且来自同一个 {@code bufferGeneration}
     * 快照。跨会话/跨次动作拼接出的产物会在这些字段上自相矛盾（见
     * {@code docs/contracts/format-scene-file.md} §6）。
     *
     * @param exportId         本次导出的稳定标识（{@code <runId>#<name>}）
     * @param runId            cp run 标识（命令通道为 null）
     * @param shape            产物形态
     * @param bufferGeneration 取快照时的缓冲世代号
     * @param recordedFrames   帧号（升序）
     * @param frameSha256      与 recordedFrames 同序的逐帧内容 sha256（口径见 {@code export.session}）
     * @param inSession        快照时的会话开关
     * @param selection        选区对象（可为 null）
     */
    public static JsonObject provenance(String exportId, String runId, Shape shape, long bufferGeneration,
        int[] recordedFrames, String[] frameSha256, boolean inSession, JsonObject selection) {
        return provenance(
            exportId,
            runId,
            shape,
            bufferGeneration,
            recordedFrames,
            frameSha256,
            inSession,
            selection,
            null);
    }

    /**
     * 构造溯源对象（含<b>录制世界身份</b>，Gitea #127）。
     *
     * <p>
     * {@code captureWorld} 是 {@code {folder, dimension}}：帧缓冲里每帧的录制世界身份（见
     * {@link CaptureWorldIdentity}）。它让「这份产物是哪一帧在哪个世界录的」与哈希一样成为
     * <b>产物内可读的事实</b>——改造前 {@code frameSha256} 只哈希缓冲内的 scan 文本，
     * 产物内容随导出时刻的世界变化而哈希不变，消费方无从察觉。
     *
     * @param captureWorld 录制世界身份对象（{@code {folder, dimension}}）；null = 不写（命令通道与
     *                     既有单测走这条 ⇒ 产物正文逐字节不变）
     */
    public static JsonObject provenance(String exportId, String runId, Shape shape, long bufferGeneration,
        int[] recordedFrames, String[] frameSha256, boolean inSession, JsonObject selection, JsonObject captureWorld) {
        JsonObject o = new JsonObject();
        o.addProperty("schema", SCHEMA_PROVENANCE);
        o.addProperty("exportId", exportId);
        o.addProperty("runId", runId);
        o.addProperty("shape", shape == null ? Shape.AUTO.id() : shape.id());
        o.addProperty("bufferGeneration", bufferGeneration);
        o.addProperty("inSession", inSession);
        JsonArray fr = new JsonArray();
        if (recordedFrames != null) {
            for (int f : recordedFrames) {
                fr.add(new com.google.gson.JsonPrimitive(Integer.valueOf(f)));
            }
        }
        o.add("recordedFrames", fr);
        JsonObject hashes = new JsonObject();
        if (recordedFrames != null && frameSha256 != null) {
            int n = Math.min(recordedFrames.length, frameSha256.length);
            for (int i = 0; i < n; i++) {
                hashes.addProperty(Integer.toString(recordedFrames[i]), frameSha256[i]);
            }
        }
        o.add("frameSha256", hashes);
        if (selection != null) {
            o.add("selection", selection);
        }
        if (captureWorld != null) {
            // #127：录制世界身份进 provenance（产物内可读，不依赖日志）
            o.add(CaptureWorldIdentity.FIELD, captureWorld);
        }
        return o;
    }

    /** 深拷贝（避免把已入库的对象交给下游继续改写）。 */
    public static JsonObject copy(JsonObject src) {
        return new JsonParser().parse(src.toString())
            .getAsJsonObject();
    }

    /** 紧凑序列化（供结果字段与日志；不做缩进）。 */
    public static String compact(JsonElement e) {
        return COMPACT.toJson(e);
    }

    private static JsonObject parseOrThrow(String text) {
        try {
            return new JsonParser().parse(text)
                .getAsJsonObject();
        } catch (RuntimeException e) {
            throw new IllegalArgumentException("帧 JSON 不是对象: " + e, e);
        }
    }
}
