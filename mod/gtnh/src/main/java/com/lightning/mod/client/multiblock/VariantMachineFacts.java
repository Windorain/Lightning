package com.lightning.mod.client.multiblock;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 捕获数据集的<strong>输入事实层</strong>：读枚举事实层的 {@code multiblock_scan/run-NNNN/machines.json}，取出本任务需要的
 * 「通道清单 + 每通道取值上界 + 每取值对应的参照方块状态 + 总 Tier 域」。
 * <p>
 * 为什么要读它而不是自己再扫一遍结构定义：枚举事实层（{@code machines.json}）明确要求「捕获数据集应从 {@code machines.json} 读
 * {@code channels[]} 与 {@code totalTier}，不要自己再扫一遍结构定义」；而且它给的是<strong>独立一次探测</strong>的结论，
 * 正好可以做「真实构建结果 vs 独立探测预期」的机器断言（本任务的布局签名断言正需要这个正交性）。
 * <p>
 * 字段口径严格照枚举事实层：
 * <ul>
 * <li>{@code max} = <b>有效取值上界</b>（滑杆刻度；提示列表尾部的重复档位不计），</li>
 * <li>{@code min}（仅尺寸型）= 「值 1 对应的实际尺寸」，与 {@code max} 一起给出
 * {@code 值 k → 尺寸 min(k-1+min, min+max-1)}（1 基偏移语义），</li>
 * <li>{@code observedValues[]} = 每个取值上 {@code getBlocksToPlace} 给出的参照方块集合，
 * 形如 {@code [901:13]}（<b>物品 id : damage</b>，不是方块 id）。</li>
 * </ul>
 */
@SideOnly(Side.CLIENT)
public final class VariantMachineFacts {

    public static final class ObservedValue {

        public int value;
        public String blocksKey = "";
        public int blockCount;
    }

    public static final class ChannelFact {

        public String enumName = "";
        public String id = "";
        public String kind = "replace";
        public String discoverySource = "";
        public String domainSource = "";
        public int max;
        public Integer min;
        public int observedMax;
        public String registryAgreement = "";
        public final List<ObservedValue> observed = new ArrayList<ObservedValue>();
        public final List<String> notes = new ArrayList<String>();

        public ObservedValue observedAt(int value) {
            for (ObservedValue v : observed) {
                if (v.value == value) return v;
            }
            return null;
        }

        public String key() {
            return id;
        }
    }

    public static final class MachineFact {

        public String fqcn = "";
        public String simpleName = "";
        public String displayName = "";
        public int mteId = -1;
        public int maxTotalTier = 1;
        public String tierSource = "unknown";
        public final List<ChannelFact> channels = new ArrayList<ChannelFact>();
        public final List<String> notes = new ArrayList<String>();
    }

    private VariantMachineFacts() {}

    /** 在 {@code multiblock_scan/} 下找 run 号最大的 {@code machines.json}（= 枚举事实层最近一次扫描的事实层）。 */
    public static File findLatestFacts(File mcDataDir) {
        File base = new File(mcDataDir, MultiblockScanRunner.OUTPUT_DIR);
        if (!base.isDirectory()) return null;
        File best = null;
        int bestIndex = -1;
        File[] children = base.listFiles();
        if (children == null) return null;
        for (File c : children) {
            if (!c.isDirectory()) continue;
            String n = c.getName();
            if (!n.startsWith("run-")) continue;
            try {
                int idx = Integer.parseInt(n.substring(4));
                File f = new File(c, "machines.json");
                if (f.isFile() && idx > bestIndex) {
                    bestIndex = idx;
                    best = f;
                }
            } catch (NumberFormatException ignored) {
                // 非 run-NNNN 目录
            }
        }
        return best;
    }

    public static MachineFact load(File machinesJson, String simpleName) throws Exception {
        if (machinesJson == null || !machinesJson.isFile()) return null;
        StringBuilder sb = new StringBuilder();
        try (InputStreamReader r = new InputStreamReader(new FileInputStream(machinesJson), StandardCharsets.UTF_8)) {
            char[] buf = new char[8192];
            int n;
            while ((n = r.read(buf)) > 0) {
                sb.append(buf, 0, n);
            }
        }
        JsonObject root = new JsonParser().parse(sb.toString())
            .getAsJsonObject();
        JsonArray machines = root.getAsJsonArray("machines");
        if (machines == null) return null;
        for (JsonElement me : machines) {
            JsonObject m = me.getAsJsonObject();
            String sn = m.has("simpleName") ? m.get("simpleName")
                .getAsString() : "";
            if (!simpleName.equals(sn)) continue;
            MachineFact f = new MachineFact();
            f.simpleName = sn;
            f.fqcn = str(m, "fqcn");
            f.displayName = str(m, "displayName");
            f.mteId = m.has("mteId") ? m.get("mteId")
                .getAsInt() : -1;
            if (m.has("totalTier") && m.get("totalTier")
                .isJsonObject()) {
                JsonObject tt = m.getAsJsonObject("totalTier");
                f.maxTotalTier = tt.has("maxTotalTier") ? tt.get("maxTotalTier")
                    .getAsInt() : 1;
                f.tierSource = str(tt, "tierSource");
            }
            if (m.has("channels") && m.get("channels")
                .isJsonArray()) {
                for (JsonElement ce : m.getAsJsonArray("channels")) {
                    JsonObject c = ce.getAsJsonObject();
                    ChannelFact cf = new ChannelFact();
                    cf.enumName = str(c, "enumName");
                    cf.id = str(c, "id");
                    cf.kind = str(c, "kind");
                    cf.discoverySource = str(c, "discoverySource");
                    cf.domainSource = str(c, "domainSource");
                    cf.max = c.has("max") && !c.get("max")
                        .isJsonNull() ? c.get("max")
                            .getAsInt() : 0;
                    cf.min = c.has("min") && !c.get("min")
                        .isJsonNull() ? Integer.valueOf(
                            c.get("min")
                                .getAsInt())
                            : null;
                    cf.observedMax = c.has("observedMax") ? c.get("observedMax")
                        .getAsInt() : cf.max;
                    cf.registryAgreement = str(c, "registryAgreement");
                    if (c.has("observedValues") && c.get("observedValues")
                        .isJsonArray()) {
                        for (JsonElement oe : c.getAsJsonArray("observedValues")) {
                            JsonObject o = oe.getAsJsonObject();
                            ObservedValue ov = new ObservedValue();
                            ov.value = o.get("value")
                                .getAsInt();
                            ov.blocksKey = str(o, "blocksKey");
                            ov.blockCount = o.has("blockCount") ? o.get("blockCount")
                                .getAsInt() : 0;
                            cf.observed.add(ov);
                        }
                    }
                    if (c.has("notes") && c.get("notes")
                        .isJsonArray()) {
                        for (JsonElement ne : c.getAsJsonArray("notes")) {
                            cf.notes.add(ne.getAsString());
                        }
                    }
                    f.channels.add(cf);
                }
            }
            if (m.has("notes") && m.get("notes")
                .isJsonArray()) {
                for (JsonElement ne : m.getAsJsonArray("notes")) {
                    f.notes.add(ne.getAsString());
                }
            }
            return f;
        }
        return null;
    }

    /** 尺寸型通道的尺寸上界：{@code getValueClamped(trigger, min, max)} 的第二个实参 = {@code min + max - 1}。 */
    public static int sizeCeiling(ChannelFact c) {
        int min = c.min == null ? 1 : c.min.intValue();
        return min + c.max - 1;
    }

    /** 尺寸型通道在取值 k（已按契约解析成有效值，k ≥ 1）上应有的结构尺寸。 */
    public static int expectedSizeFor(ChannelFact c, int k) {
        int min = c.min == null ? 1 : c.min.intValue();
        return Math.min(sizeCeiling(c), k + min - 1);
    }

    private static String str(JsonObject o, String key) {
        if (!o.has(key) || o.get(key)
            .isJsonNull()) return "";
        return o.get(key)
            .getAsString();
    }
}
