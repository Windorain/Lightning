package com.lightning.mod.client.multiblock;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * 变体几何数据集（捕获数据集的落盘形态；{@code variant_capture/run-NNNN/} 或
 * {@code sde_multiblock_exports/_dataset/run-NNNN/}）的**唯一读取器**。
 * <p>
 * 抽出它的原因：离线驱动（{@link MultiblockFactorizeTool}）与游戏内 {@code /sde multiblock}
 * 必须吃同一套读取语义 —— 若各写一份，「离线闭环全绿」就不能推出「游戏内产物也全绿」。
 * 两份产物布局本来就一致（{@code palette.json} + {@code machines/<slug>.json}），故读取器共用。
 * <p>
 * 零 MC 依赖（只用 Gson + JDK），因此既能在客户端跑，也能被 {@code java -cp} 离线驱动直接调用。
 */
public final class MultiblockDatasetCodec {

    /** 子集重编码规格：覆盖通道域上界 / 覆盖 tierSample / 保留哪些通道（因子化编码器对照组用）。 */
    public static final class Override {

        public final Map<String, Integer> channelMax = new LinkedHashMap<String, Integer>();
        public List<Integer> tierSample;
        public List<String> keepChannels;

        public Override() {}

        public Override(Map<String, Integer> channelMax, List<Integer> tierSample) {
            if (channelMax != null) this.channelMax.putAll(channelMax);
            this.tierSample = tierSample;
        }

        public Override(Map<String, Integer> channelMax, List<Integer> tierSample, List<String> keepChannels) {
            this(channelMax, tierSample);
            this.keepChannels = keepChannels;
        }
    }

    private final File datasetDir;
    private final JsonArray palette;
    private final JsonArray materialPalette;
    private final JsonArray textureBlobs;
    private final JsonArray tooltipPalette;

    public MultiblockDatasetCodec(File datasetDir) throws Exception {
        this.datasetDir = datasetDir;
        JsonObject pal = readObject(new File(datasetDir, "palette.json"));
        this.palette = pal.getAsJsonArray("blockPalette");
        this.materialPalette = pal.getAsJsonArray("materialPalette");
        this.textureBlobs = pal.getAsJsonArray("textureBlobs");
        this.tooltipPalette = pal.getAsJsonArray("tooltipPalette");
        if (palette == null) throw new IllegalStateException("palette.json 缺 blockPalette: " + datasetDir);
    }

    public File datasetDir() {
        return datasetDir;
    }

    public String datasetLabel() {
        return datasetDir.getName();
    }

    public JsonArray palette() {
        return palette;
    }

    public JsonArray materialPalette() {
        return materialPalette;
    }

    public JsonArray textureBlobs() {
        return textureBlobs;
    }

    public JsonArray tooltipPalette() {
        return tooltipPalette;
    }

    public MultiblockFactorizer.MachineIn readMachine(File f, String slug) throws Exception {
        return readMachine(f, slug, null);
    }

    /** 读一台机器 → {@link MultiblockFactorizer.MachineIn}（数据集布局，契约 §5.1 的键派生在此完成）。 */
    public MultiblockFactorizer.MachineIn readMachine(File f, String slug, Override subset) throws Exception {
        JsonObject src = readObject(f);
        JsonObject m = src.getAsJsonObject("machine");
        MultiblockFactorizer.MachineIn mi = new MultiblockFactorizer.MachineIn();
        String fqcn = str(m, "fqcn");
        String simple = str(m, "simpleName");
        mi.id = machineId(fqcn, simple);
        mi.displayName = str(m, "displayName");
        mi.sourceClass = fqcn;
        mi.sourceSlug = slug;
        mi.datasetSource = datasetLabel() + "/machines/" + slug + ".json";

        List<String> keep = subset == null ? null : subset.keepChannels;
        for (JsonElement ce : src.getAsJsonArray("channels")) {
            JsonObject c = ce.getAsJsonObject();
            String key = str(c, "key");
            if (keep != null && !keep.contains(key)) continue;
            MultiblockFactorizer.ChannelIn ch = new MultiblockFactorizer.ChannelIn();
            ch.enumName = c.has("enum") && !c.get("enum")
                .isJsonNull() ? c.get("enum")
                    .getAsString() : null;
            ch.id = str(c, "id");
            ch.key = key;
            ch.name = str(c, "name");
            ch.kind = str(c, "kind");
            ch.max = c.has("max") ? c.get("max")
                .getAsInt() : 1;
            if (c.has("min") && !c.get("min")
                .isJsonNull())
                ch.dimensionAtMin = Integer.valueOf(
                    c.get("min")
                        .getAsInt());
            int domainMax = ch.max;
            if (c.has("domain") && c.getAsJsonObject("domain")
                .has("max")) {
                domainMax = c.getAsJsonObject("domain")
                    .get("max")
                    .getAsInt();
            }
            if (c.has("subsetOverridden") && c.get("subsetOverridden")
                .getAsBoolean()) {
                // 全量导出的域收窄：产物声明的域**不是**真实域，捕获数据集的 effective 不再是本域的 oracle。
                ch.subsetOverridden = true;
                if (c.has("trueDomainMax") && !c.get("trueDomainMax")
                    .isJsonNull()) {
                    ch.trueDomainMax = Integer.valueOf(
                        c.get("trueDomainMax")
                            .getAsInt());
                }
            }
            if (subset != null && subset.channelMax != null && subset.channelMax.containsKey(key)) {
                domainMax = subset.channelMax.get(key)
                    .intValue();
                ch.max = domainMax;
                ch.subsetOverridden = true;
            }
            ch.domainMax = Integer.valueOf(domainMax);
            ch.domainSource = str(c, "domainSource");
            ch.valueSemantics = str(c, "valueSemantics");
            mi.channels.add(ch);
            if ("dimension".equals(ch.kind) || "size".equals(ch.kind)) {
                JsonObject note = new JsonObject();
                note.addProperty("kind", "note");
                note.addProperty(
                    "text",
                    "尺寸型通道 " + ch.key
                        + "：数据集的 min="
                        + ch.dimensionAtMin
                        + " 是「值 1 对应的实际尺寸」，与契约 §4.2 的 min（有效取值下界 = 1）语义不同；"
                        + "本文档按契约写 min=1 / max="
                        + domainMax
                        + "，二者满足 阶数 = max − min + 1。");
                note.addProperty("source", "docs/contracts/format-multiblock-doc.md §4.4");
                mi.extraNotes.add(note);
            }
        }
        JsonObject tt = src.getAsJsonObject("totalTierDomain");
        mi.ttMin = tt.get("min")
            .getAsInt();
        mi.ttMax = tt.get("max")
            .getAsInt();
        mi.ttDefault = tt.has("default") ? tt.get("default")
            .getAsInt() : mi.ttMin;
        mi.ttSource = tt.has("source") ? tt.get("source")
            .getAsString() : "probed";
        if (subset != null && subset.tierSample != null) {
            mi.tierSample.addAll(subset.tierSample);
        } else if (src.has("tierSample")) {
            for (JsonElement te : src.getAsJsonArray("tierSample")) mi.tierSample.add(Integer.valueOf(te.getAsInt()));
        } else {
            for (int t = mi.ttMin; t <= mi.ttMax; t++) mi.tierSample.add(Integer.valueOf(t));
        }
        if (src.has("runstates")) {
            for (JsonElement re : src.getAsJsonArray("runstates")) {
                JsonObject r = re.getAsJsonObject();
                MultiblockFactorizer.RunstateIn rs = new MultiblockFactorizer.RunstateIn();
                rs.id = str(r, "id");
                rs.name = str(r, "name");
                rs.materialSwap = r.has("materialSwap") && r.get("materialSwap")
                    .getAsBoolean();
                mi.runstates.add(rs);
            }
        }
        if (mi.runstates.isEmpty()) {
            MultiblockFactorizer.RunstateIn rs = new MultiblockFactorizer.RunstateIn();
            rs.id = VariantCaptureRunner.RUNSTATE_IDLE;
            rs.name = "Idle";
            mi.runstates.add(rs);
        }

        for (JsonElement ve : src.getAsJsonArray("variants")) {
            JsonObject v = ve.getAsJsonObject();
            int totalTier = v.get("totalTier")
                .getAsInt();
            String runstate = str(v, "runstate");
            if (!mi.tierSample.contains(Integer.valueOf(totalTier))) continue;
            JsonObject values = v.has("values") ? v.getAsJsonObject("values") : new JsonObject();
            // 子集过滤：被丢弃的通道必须为 0（未设置）；保留通道的取值必须落在覆盖后的域内
            boolean ok = true;
            for (Map.Entry<String, JsonElement> e : values.entrySet()) {
                String k = e.getKey();
                boolean kept = false;
                for (MultiblockFactorizer.ChannelIn c : mi.channels) {
                    if (c.key.equals(k)) {
                        kept = true;
                        if (e.getValue()
                            .getAsInt() > c.domainMax.intValue()) ok = false;
                        break;
                    }
                }
                if (!kept && e.getValue()
                    .getAsInt() != 0) ok = false;
            }
            if (!ok) continue;
            MultiblockFactorizer.VariantIn vi = new MultiblockFactorizer.VariantIn();
            vi.totalTier = totalTier;
            vi.runstate = runstate;
            for (MultiblockFactorizer.ChannelIn c : mi.channels) {
                int raw = values.has(c.key) ? values.get(c.key)
                    .getAsInt() : 0;
                vi.values.put(c.key, Integer.valueOf(raw));
            }
            vi.key = variantKey(mi.channels, vi.values, runstate, totalTier);
            if (v.has("effective")) {
                JsonObject eff = v.getAsJsonObject("effective");
                for (MultiblockFactorizer.ChannelIn c : mi.channels) {
                    if (eff.has(c.key)) vi.effectiveCrossCheck.put(
                        c.key,
                        Integer.valueOf(
                            eff.get(c.key)
                                .getAsInt()));
                }
            }
            JsonObject grid = v.getAsJsonObject("grid");
            vi.cellGrid = toGrid(grid.getAsJsonArray("cellGrid"));
            mi.variants.add(vi);
        }
        mi.palette = palette;
        mi.materialPalette = materialPalette;
        mi.textureBlobs = textureBlobs;
        mi.tooltipPalette = tooltipPalette;
        return mi;
    }

    /** 契约 §5.1 的键派生（与 lib.mjs 的 {@code variantKey} 同口径）。 */
    public static String variantKey(List<MultiblockFactorizer.ChannelIn> channels, Map<String, Integer> values,
        String runstate, int totalTier) {
        StringBuilder sb = new StringBuilder();
        for (MultiblockFactorizer.ChannelIn c : channels) {
            if (sb.length() > 0) sb.append('|');
            Integer raw = values.get(c.key);
            sb.append(c.key)
                .append(':')
                .append(raw == null ? 0 : raw.intValue());
        }
        if (sb.length() > 0) sb.append('|');
        sb.append("tt:")
            .append(totalTier)
            .append("|runstate:")
            .append(runstate);
        return sb.toString();
    }

    /** 契约 §4.1 的文档 id（与因子化编码器工具同口径：命名空间由 fqcn 前缀决定）。 */
    public static String machineId(String fqcn, String simpleName) {
        String ns = fqcn.startsWith("gtPlusPlus") ? "gtpp" : (fqcn.startsWith("gregtech") ? "gregtech" : "lightning");
        String body = simpleName.startsWith("MTE") ? simpleName.substring(3) : simpleName;
        return ns + ":metaTileEntity_" + lowerFirst(body);
    }

    public static int[][][] toGrid(JsonArray cg) {
        int[][][] g = new int[cg.size()][][];
        for (int z = 0; z < cg.size(); z++) {
            JsonArray slice = cg.get(z)
                .getAsJsonArray();
            g[z] = new int[slice.size()][];
            for (int y = 0; y < slice.size(); y++) {
                JsonArray row = slice.get(y)
                    .getAsJsonArray();
                g[z][y] = new int[row.size()];
                for (int x = 0; x < row.size(); x++) g[z][y][x] = row.get(x)
                    .getAsInt();
            }
        }
        return g;
    }

    public static JsonObject readObject(File f) throws Exception {
        InputStreamReader r = new InputStreamReader(new FileInputStream(f), StandardCharsets.UTF_8);
        try {
            return new JsonParser().parse(r)
                .getAsJsonObject();
        } finally {
            r.close();
        }
    }

    public static JsonArray toJsonArray(int[][][] grid) {
        JsonArray arr = new JsonArray();
        for (int z = 0; z < grid.length; z++) {
            JsonArray slice = new JsonArray();
            for (int y = 0; y < grid[z].length; y++) {
                JsonArray row = new JsonArray();
                for (int x = 0; x < grid[z][y].length; x++) {
                    row.add(new com.google.gson.JsonPrimitive(Integer.valueOf(grid[z][y][x])));
                }
                slice.add(row);
            }
            arr.add(slice);
        }
        return arr;
    }

    static String str(JsonObject o, String key) {
        return o.has(key) && !o.get(key)
            .isJsonNull() ? o.get(key)
                .getAsString() : "";
    }

    static String lowerFirst(String s) {
        if (s.isEmpty()) return s;
        return Character.toLowerCase(s.charAt(0)) + s.substring(1);
    }
}
