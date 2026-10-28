package com.lightning.mod.client.multiblock;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.lightning.mod.client.export.SceneEnvelopeBuilder;

/**
 * 因子化编码器的离线驱动：把捕获数据集的变体几何（{@code variant_capture/run-NNNN/}）编码成契约产物
 * （多方块文档 + 既有 gzip+base64 信封），并落盘编码统计与"取值数 +1 / 通道数 +1"对照组。
 * <p>
 * 本类<b>零 MC 依赖</b>（只用 Gson + JDK + {@link SceneEnvelopeBuilder}），可以直接用
 * {@code java -cp <build/classes/java/main>;<gson.jar> com.lightning.mod.client.multiblock.MultiblockFactorizeTool <datasetDir> <outDir>}
 * 跑，不需要启动游戏；而核心的 {@link MultiblockFactorizer} 同时被全量导出的 {@code /sde multiblock} 复用。
 * <p>
 * 用法：
 *
 * <pre>
 *   MultiblockFactorizeTool &lt;datasetDir&gt; &lt;outDir&gt; [--only=slug1,slug2] [--control]
 * </pre>
 *
 * 产物：{@code <outDir>/<slug>.multiblock.json}（信封，生产形态）、
 * {@code <outDir>/<slug>.multiblock.body.json}（内层 body，便于人工阅读/逐行 diff）、
 * {@code <outDir>/factorization-report.json}（统计）、{@code <outDir>/control/*.json}（对照组）。
 */
public final class MultiblockFactorizeTool {

    private static final Gson PRETTY = new GsonBuilder().setPrettyPrinting()
        .disableHtmlEscaping()
        .create();

    private static File outDir;
    private static MultiblockDatasetCodec codec;
    private static JsonArray palette;
    private static JsonArray materialPalette;
    private static JsonArray textureBlobs;
    private static JsonArray tooltipPalette;
    private static String datasetLabel;
    private static JsonArray reportMachines;

    private MultiblockFactorizeTool() {}

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("用法: MultiblockFactorizeTool <datasetDir> <outDir> [--only=slug,...] [--control]");
            System.exit(2);
        }
        File datasetDir = new File(args[0]);
        outDir = new File(args[1]);
        List<String> only = new ArrayList<String>();
        boolean control = false;
        for (int i = 2; i < args.length; i++) {
            if (args[i].startsWith("--only=")) {
                for (String s : args[i].substring("--only=".length())
                    .split(",")) {
                    if (!s.trim()
                        .isEmpty()) only.add(s.trim());
                }
            } else if ("--control".equals(args[i])) {
                control = true;
            }
        }
        if (!datasetDir.isDirectory()) {
            System.err.println("数据集目录不存在: " + datasetDir.getAbsolutePath());
            System.exit(2);
        }
        if (!outDir.isDirectory() && !outDir.mkdirs()) {
            System.err.println("无法创建输出目录: " + outDir.getAbsolutePath());
            System.exit(2);
        }

        File paletteFile = new File(datasetDir, "palette.json");
        codec = new MultiblockDatasetCodec(datasetDir);
        palette = codec.palette();
        materialPalette = codec.materialPalette();
        textureBlobs = codec.textureBlobs();
        tooltipPalette = codec.tooltipPalette();
        datasetLabel = codec.datasetLabel();

        File machinesDir = new File(datasetDir, "machines");
        File[] files = machinesDir.listFiles();
        Arrays.sort(files == null ? new File[0] : files);
        reportMachines = new JsonArray();
        long t0 = System.currentTimeMillis();

        for (File f : files) {
            if (!f.isFile() || !f.getName()
                .endsWith(".json")) continue;
            String slug = f.getName()
                .substring(
                    0,
                    f.getName()
                        .length() - 5);
            if (!only.isEmpty() && !only.contains(slug)) continue;
            MultiblockFactorizer.MachineIn mi = readMachine(f, slug, null);
            emit(mi, slug, false);
        }

        if (control) {
            File ctlDir = new File(outDir, "control");
            if (!ctlDir.isDirectory() && !ctlDir.mkdirs()) throw new IllegalStateException("无法创建 " + ctlDir);
            File save = outDir;
            outDir = ctlDir;
            try {
                runControls(machinesDir);
            } finally {
                outDir = save;
            }
        }

        JsonObject report = new JsonObject();
        report.addProperty("tool", "MultiblockFactorizeTool（因子化编码）");
        report.addProperty("dataset", datasetDir.getAbsolutePath());
        report.addProperty("paletteSource", paletteFile.getAbsolutePath());
        report.addProperty("outDir", outDir.getAbsolutePath());
        report.addProperty("elapsedMs", Long.valueOf(System.currentTimeMillis() - t0));
        JsonObject palStats = new JsonObject();
        palStats.addProperty("paletteEntries", palette.size());
        palStats.addProperty("materialEntries", materialPalette == null ? 0 : materialPalette.size());
        palStats.addProperty("textureBlobs", textureBlobs == null ? 0 : textureBlobs.size());
        Gson compact = new Gson();
        int poolBytes = 0;
        if (materialPalette != null) poolBytes += compact.toJson(materialPalette)
            .getBytes(StandardCharsets.UTF_8).length;
        if (textureBlobs != null) poolBytes += compact.toJson(textureBlobs)
            .getBytes(StandardCharsets.UTF_8).length;
        if (tooltipPalette != null) poolBytes += compact.toJson(tooltipPalette)
            .getBytes(StandardCharsets.UTF_8).length;
        palStats.addProperty("materialPoolJsonBytes", Integer.valueOf(poolBytes));
        report.add("palette", palStats);
        report.add("documents", reportMachines);
        writeJson(new File(outDir, "factorization-report.json"), report);
        System.out.println(
            "[因子化编码] 编码完成：" + reportMachines
                .size() + " 份文档，耗时 " + (System.currentTimeMillis() - t0) + " ms → " + outDir.getAbsolutePath());
    }

    // -----------------------------------------------------------------------
    // 对照组（编码端自检：取值数 +1 / 通道数 +1）
    // -----------------------------------------------------------------------

    private static void runControls(File machinesDir) throws Exception {
        File ebf = new File(machinesDir, "mteelectricblastfurnace.json");
        File qft = new File(machinesDir, "mtequantumforcetransformer.json");
        // ---- A. 取值数 +1（EBF coil 域 12 → 13 → 14 → 15 个取值；tierSample 固定 [1,2] 以隔离"取值轴"）----
        // 为什么不用全量 tierSample：契约 §5.2 的"未设置 → 回落总 Tier"会在 tt > 域上界时被域夹取，
        // 而数据集的 ground-truth 网格是真实构建结果（回落到真实 Tier）→ 那样的子集在契约语义下不可无损编码。
        // 这是"域夹取 vs 真实回落"的边界，不是编码器缺陷（见报告开放项）。
        if (ebf.isFile()) {
            List<Integer> tt12 = Arrays.asList(Integer.valueOf(1), Integer.valueOf(2));
            int[] maxes = { 11, 12, 13, 14 };
            for (int k = 0; k < maxes.length; k++) {
                Map<String, Integer> cap = new LinkedHashMap<String, Integer>();
                cap.put("coil", Integer.valueOf(maxes[k]));
                MultiblockFactorizer.MachineIn mi = readMachine(ebf, "mteelectricblastfurnace", new Subset(cap, tt12));
                emit(mi, "ctl-values-" + (maxes[k] + 1) + "values", true);
            }
        }
        // ---- B. 通道数 +1（QFT；tierSample=[1] 使未声明通道的回落值为常数，隔离"通道轴"本身）----
        if (qft.isFile()) {
            List<Integer> tt1 = Arrays.asList(Integer.valueOf(1));
            List<String> shieldOnly = Arrays.asList("shielding");
            List<String> manipOnly = Arrays.asList("manipulator");
            List<String> bothCh = Arrays.asList("shielding", "manipulator");
            emit(
                readMachine(qft, "mtequantumforcetransformer", new Subset(null, tt1, shieldOnly)),
                "ctl-chan-1-shielding",
                true);
            emit(
                readMachine(qft, "mtequantumforcetransformer", new Subset(null, tt1, manipOnly)),
                "ctl-chan-1-manipulator",
                true);
            emit(
                readMachine(qft, "mtequantumforcetransformer", new Subset(null, tt1, bothCh)),
                "ctl-chan-2-both",
                true);
            Map<String, Integer> deg = new LinkedHashMap<String, Integer>();
            deg.put("manipulator", Integer.valueOf(0));
            emit(
                readMachine(qft, "mtequantumforcetransformer", new Subset(deg, tt1, bothCh)),
                "ctl-chan-2-degenerate",
                true);
            // ---- C. 等级（总 Tier）叠加自检：未声明通道的回落值随 Tier 变 → 必须走 tier 规则 ----
            List<Integer> tt4 = Arrays
                .asList(Integer.valueOf(1), Integer.valueOf(2), Integer.valueOf(3), Integer.valueOf(4));
            emit(
                readMachine(qft, "mtequantumforcetransformer", new Subset(null, tt4, shieldOnly)),
                "ctl-tier-overlay-shielding",
                true);
        }
        // ---- D. 调色板重编号两种实现对照（indexAliases 规则 vs 编码期直接换下标）----
        if (ebf.isFile()) {
            MultiblockFactorizer.MachineIn direct = readMachine(ebf, "mteelectricblastfurnace", null);
            direct.paletteRenumberViaAliases = false;
            emit(direct, "ctl-renumber-direct-ebf", true);
        }
    }

    /** 子集重编码规格：覆盖通道域上界 / 覆盖 tierSample / 保留哪些通道。 */
    private static final class Subset {

        final Map<String, Integer> channelMax;
        final List<Integer> tierSample;
        final List<String> keepChannels;

        Subset(Map<String, Integer> channelMax, List<Integer> tierSample) {
            this(channelMax, tierSample, null);
        }

        Subset(Map<String, Integer> channelMax, List<Integer> tierSample, List<String> keepChannels) {
            this.channelMax = channelMax;
            this.tierSample = tierSample;
            this.keepChannels = keepChannels;
        }
    }

    // -----------------------------------------------------------------------
    // 读取（唯一读取器 = MultiblockDatasetCodec，与游戏内 /sde multiblock 共用）
    // -----------------------------------------------------------------------

    private static MultiblockFactorizer.MachineIn readMachine(File f, String slug, Subset subset) throws Exception {
        MultiblockDatasetCodec.Override ov = subset == null ? null
            : new MultiblockDatasetCodec.Override(subset.channelMax, subset.tierSample, subset.keepChannels);
        return codec.readMachine(f, slug, ov);
    }

    // -----------------------------------------------------------------------
    // 落盘
    // -----------------------------------------------------------------------

    private static void emit(MultiblockFactorizer.MachineIn mi, String name, boolean control) throws Exception {
        long t0 = System.currentTimeMillis();
        MultiblockFactorizer.Result res = MultiblockFactorizer.factorize(mi);
        long elapsed = System.currentTimeMillis() - t0;
        JsonObject inner = res.innerBody;

        // ---- 信封（既有机制，不重做；因子化在信封之前）----
        JsonObject rawFinal = new JsonObject();
        rawFinal.addProperty("id", mi.id);
        rawFinal.addProperty("mode", "multiblock");
        rawFinal.addProperty("label", mi.displayName);
        rawFinal.addProperty("author", "Lightning factorizer（因子化编码）");
        rawFinal.addProperty("description", "多方块为主文档（一份文件 = 一台多方块）：尺寸型定骨架 + 共享差异规则表 + 每变体一帧。");
        rawFinal.addProperty("modSource", "lightning.multiblock.factorizer");
        rawFinal.addProperty("schemaVersion", Integer.valueOf(1));
        rawFinal.addProperty("documentShape", "multiblock");
        for (Map.Entry<String, JsonElement> e : inner.entrySet()) rawFinal.add(e.getKey(), e.getValue());
        JsonObject envelope = SceneEnvelopeBuilder.toEnvelope(rawFinal);

        File envFile = new File(outDir, name + ".multiblock.json");
        File bodyFile = new File(outDir, name + ".multiblock.body.json");
        writeJson(envFile, envelope);
        writeJson(bodyFile, inner);
        if (control) {
            // 对照组是数据集子集重编码：把**输入**（=ground-truth cellGrid）原样落盘，
            // 供闭环验证器逐格 diff（验证器还会与数据集本体交叉核对，见 verify-encoded.mjs）。
            JsonObject gt = new JsonObject();
            gt.addProperty("machine", mi.id);
            gt.addProperty("sourceSlug", mi.sourceSlug);
            gt.addProperty("datasetSource", mi.datasetSource);
            JsonArray vs = new JsonArray();
            for (MultiblockFactorizer.VariantIn v : mi.variants) {
                JsonObject o = new JsonObject();
                o.addProperty("key", v.key);
                o.addProperty("totalTier", Integer.valueOf(v.totalTier));
                o.addProperty("runstate", v.runstate);
                JsonObject values = new JsonObject();
                for (Map.Entry<String, Integer> e : v.values.entrySet()) {
                    values.addProperty(e.getKey(), e.getValue());
                }
                o.add("values", values);
                o.add("cellGrid", toJsonArray(v.cellGrid));
                vs.add(o);
            }
            gt.add("variants", vs);
            writeJson(new File(outDir, name + ".groundtruth.json"), gt);
        }

        // ---- 统计 ----
        JsonObject st = res.stats;
        st.addProperty("name", name);
        st.addProperty("control", Boolean.valueOf(control));
        st.addProperty("elapsedMs", Long.valueOf(elapsed));
        st.addProperty("envelopeBytes", Long.valueOf(envFile.length()));
        st.addProperty("bodyFileBytes", Long.valueOf(bodyFile.length()));
        String payload = envelope.get("payload")
            .getAsString();
        st.addProperty("payloadBase64Chars", Integer.valueOf(payload.length()));
        st.addProperty(
            "payloadGzipBytes",
            Integer.valueOf(
                (int) (payload.length() / 4 * 3) - (payload.endsWith("==") ? 2 : (payload.endsWith("=") ? 1 : 0))));
        JsonObject vol = st.getAsJsonObject("volume");
        long innerBytes = vol.get("innerJsonBytes")
            .getAsLong();
        long gridTotal = vol.get("variantGridBytesTotal")
            .getAsLong();
        int n = st.get("variants")
            .getAsInt();
        long V = vol.get("V_expandedContract")
            .getAsLong();
        // 校验器口径（诚实展开）：把 inner 里那一份骨架换成"每变体一份完整网格"
        long honestExpanded = innerBytes - (gridTotal / Math.max(n, 1)) + gridTotal;
        vol.addProperty("honestExpandedBytes", Long.valueOf(honestExpanded));
        vol.addProperty("kappaContract", Double.valueOf(V / (double) Math.max(envFile.length(), 1)));
        vol.addProperty("kappaValidator", Double.valueOf(honestExpanded / (double) Math.max(envFile.length(), 1)));
        reportMachines.add(st);
        System.out.println(
            "[因子化编码] " + name
                + "：N="
                + n
                + " 阶="
                + st.get("steps")
                    .getAsInt()
                + " 规则="
                + st.getAsJsonObject("rules")
                    .get("total")
                    .getAsInt()
                + " 信封="
                + envFile.length()
                + "B κ="
                + String.format("%.2f", Double.valueOf(V / (double) Math.max(envFile.length(), 1))));
    }

    // -----------------------------------------------------------------------
    // 工具
    // -----------------------------------------------------------------------

    private static JsonObject readObject(File f) throws Exception {
        InputStreamReader r = new InputStreamReader(new FileInputStream(f), StandardCharsets.UTF_8);
        try {
            return new JsonParser().parse(r)
                .getAsJsonObject();
        } finally {
            r.close();
        }
    }

    private static void writeJson(File f, JsonElement e) throws Exception {
        File parent = f.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IllegalStateException("mkdir " + parent);
        }
        OutputStreamWriter w = new OutputStreamWriter(new FileOutputStream(f), StandardCharsets.UTF_8);
        try {
            w.write(PRETTY.toJson(e));
            w.write('\n');
        } finally {
            w.close();
        }
    }

    private static JsonArray toJsonArray(int[][][] grid) {
        JsonArray arr = new JsonArray();
        for (int z = 0; z < grid.length; z++) {
            JsonArray slice = new JsonArray();
            for (int y = 0; y < grid[z].length; y++) {
                JsonArray row = new JsonArray();
                for (int x = 0; x < grid[z][y].length; x++) row.add(new com.google.gson.JsonPrimitive(grid[z][y][x]));
                slice.add(row);
            }
            arr.add(slice);
        }
        return arr;
    }

    private static String str(JsonObject o, String key) {
        return o.has(key) && !o.get(key)
            .isJsonNull() ? o.get(key)
                .getAsString() : "";
    }

    private static String lowerFirst(String s) {
        if (s.isEmpty()) return s;
        return Character.toLowerCase(s.charAt(0)) + s.substring(1);
    }
}
