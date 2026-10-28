package com.lightning.mod.client.multiblock;

import java.util.LinkedHashMap;
import java.util.Map;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

/**
 * {@code structuralCompression=false} 时的**组合展开**写出器（诊断/体积对照用，非生产形态）。
 * <p>
 * 形态：每帧**内联完整 {@code cellGrid}**、{@code multiblock.rules} 为空、骨架只作尺寸语义标注。
 * 这正是契约 §5.3 明令禁止的"把规则放进 frame"的写法（场景不得携带内联 ops），也是校验器的硬失败形态
 * （{@code frames[].cellGrid} / 空规则表 / 未被引用的调色板条目都可能触发）—— 因此本产物
 * **不通过契约校验器**，只用于回答"不压缩会有多大"以及排查编码器与真实网格的分歧。
 * <p>
 * 为什么仍然落在同一个 {@link MultiblockFactorizer.MachineIn} 上：展开写出器与因子化编码器吃的
 * 是同一份输入（同一 {@link MultiblockDatasetCodec} 读取结果），所以两者的差异**只**来自编码策略，
 * 不来自输入口径不同 —— 这是体积曲线对照组可用的前提。
 */
final class MultiblockExpandedWriter {

    static final class Out {

        final JsonObject innerBody;
        final JsonObject stats;

        Out(JsonObject innerBody, JsonObject stats) {
            this.innerBody = innerBody;
            this.stats = stats;
        }
    }

    private MultiblockExpandedWriter() {}

    static Out build(MultiblockFactorizer.MachineIn in) {
        long t0 = System.currentTimeMillis();
        JsonArray palette = prunePalette(in);
        // 全局下标 → 本文档下标
        Map<Integer, Integer> alias = new LinkedHashMap<Integer, Integer>();
        for (int i = 0; i < palette.size(); i++) alias.put(Integer.valueOf(i), Integer.valueOf(i));

        JsonObject mb = new JsonObject();
        mb.addProperty("id", in.id);
        mb.addProperty("displayName", in.displayName);
        if (in.sourceClass != null) mb.addProperty("sourceClass", in.sourceClass);
        mb.addProperty("hasScopeOverlap", Boolean.FALSE);
        JsonObject tt = new JsonObject();
        tt.addProperty("min", Integer.valueOf(in.ttMin));
        tt.addProperty("max", Integer.valueOf(in.ttMax));
        tt.addProperty("default", Integer.valueOf(in.ttDefault));
        tt.addProperty("source", in.ttSource);
        mb.add("totalTierDomain", tt);
        JsonArray sample = new JsonArray();
        for (Integer t : in.tierSample) sample.add(new JsonPrimitive(t));
        mb.add("tierSample", sample);
        mb.add("channels", buildChannels(in));
        JsonArray runstates = new JsonArray();
        for (MultiblockFactorizer.RunstateIn r : in.runstates) {
            JsonObject o = new JsonObject();
            o.addProperty("id", r.id);
            o.addProperty("name", r.name);
            o.addProperty("materialSwap", Boolean.valueOf(r.materialSwap));
            runstates.add(o);
        }
        mb.add("runstates", runstates);
        mb.addProperty("couplingMode", "none");
        mb.add("couplings", new JsonArray());
        JsonArray notes = new JsonArray();
        JsonObject n = new JsonObject();
        n.addProperty("kind", "note");
        n.addProperty(
            "text",
            "structuralCompression=false（全量导出配置面）：本产物是**组合展开形态**——每帧内联完整 cellGrid、"
                + "无差异规则表，仅供体积对照/诊断，**不通过契约校验器**（frames[].cellGrid 是硬失败项）。");
        n.addProperty("source", "导出范围配置面（契约见 docs/contracts/format-multiblock-doc.md）");
        notes.add(n);
        mb.add("notes", notes);
        JsonObject vs = new JsonObject();
        vs.addProperty("frameIsVariant", Boolean.TRUE);
        vs.addProperty("playback", "variant-frames");
        vs.addProperty("layerPreview", "supported");
        JsonObject cov = new JsonObject();
        cov.addProperty("kind", "texture-material-swap");
        cov.addProperty("geometryDelta", Boolean.FALSE);
        cov.addProperty("tesr", "not-covered");
        vs.add("runstateCoverage", cov);
        mb.add("viewerSemantics", vs);
        mb.addProperty("paletteSource", in.paletteSource);
        mb.addProperty("geometryEncoding", in.geometryEncoding);
        mb.add("opsLegend", new JsonObject());
        mb.add("rules", new JsonArray());
        mb.add("backbone", buildBackbone(in));

        JsonArray variants = new JsonArray();
        for (MultiblockFactorizer.VariantIn v : in.variants) {
            JsonObject o = new JsonObject();
            o.addProperty("key", v.key);
            o.addProperty("totalTier", Integer.valueOf(v.totalTier));
            JsonObject values = new JsonObject();
            for (MultiblockFactorizer.ChannelIn c : in.channels) {
                Integer raw = v.values.get(c.key);
                values.addProperty(c.key, Integer.valueOf(raw == null ? 0 : raw.intValue()));
            }
            o.add("values", values);
            o.addProperty("runstate", v.runstate);
            variants.add(o);
        }
        mb.add("variants", variants);

        JsonArray frames = new JsonArray();
        for (int i = 0; i < in.variants.size(); i++) {
            MultiblockFactorizer.VariantIn v = in.variants.get(i);
            JsonObject f = new JsonObject();
            f.addProperty("index", Integer.valueOf(i));
            f.addProperty("variant", v.key);
            f.addProperty("runstate", v.runstate);
            f.addProperty("stepIndex", Integer.valueOf(0));
            f.add("rules", new JsonArray());
            f.add("cellGrid", MultiblockDatasetCodec.toJsonArray(v.cellGrid));
            frames.add(f);
        }

        JsonObject inner = new JsonObject();
        inner.addProperty("schemaVersion", Integer.valueOf(1));
        inner.addProperty("multiblockCount", Integer.valueOf(1));
        inner.add("multiblock", mb);
        inner.add("blockPalette", palette);
        if (in.materialPalette != null) inner.add("materialPalette", in.materialPalette);
        if (in.textureBlobs != null) inner.add("textureBlobs", in.textureBlobs);
        if (in.tooltipPalette != null) inner.add("tooltipPalette", in.tooltipPalette);
        inner.add("frames", frames);

        JsonObject stats = new JsonObject();
        stats.addProperty("machine", in.id);
        stats.addProperty("mode", "expanded(no-structural-compression)");
        stats.addProperty("variants", Integer.valueOf(in.variants.size()));
        stats.addProperty("frames", Integer.valueOf(frames.size()));
        stats.addProperty("rules", Integer.valueOf(0));
        JsonObject vol = new JsonObject();
        long gridBytes = 0;
        for (MultiblockFactorizer.VariantIn v : in.variants) {
            gridBytes += MultiblockFactorizer
                .utf8(MultiblockFactorizer.compact(MultiblockDatasetCodec.toJsonArray(v.cellGrid))).length;
        }
        byte[] innerBytes = MultiblockFactorizer.utf8(MultiblockFactorizer.compact(inner));
        vol.addProperty("innerJsonBytes", Integer.valueOf(innerBytes.length));
        vol.addProperty("variantGridBytesTotal", Integer.valueOf((int) gridBytes));
        vol.addProperty(
            "paletteJsonBytes",
            Integer.valueOf(MultiblockFactorizer.utf8(MultiblockFactorizer.compact(palette)).length));
        vol.addProperty(
            "V_expandedContract",
            Long.valueOf(MultiblockFactorizer.utf8(MultiblockFactorizer.compact(palette)).length + gridBytes));
        stats.add("volume", vol);
        stats.addProperty("innerSha256", MultiblockFactorizer.sha256(innerBytes));
        stats.addProperty("elapsedMs", Long.valueOf(System.currentTimeMillis() - t0));
        return new Out(inner, stats);
    }

    /** 并集调色板剪枝：只保留被引用的条目（与因子化编码器同口径，便于体积对照）。 */
    private static JsonArray prunePalette(MultiblockFactorizer.MachineIn in) {
        JsonArray global = in.palette;
        boolean[] used = new boolean[global.size()];
        used[0] = true;
        for (MultiblockFactorizer.VariantIn v : in.variants) {
            for (int z = 0; z < v.cellGrid.length; z++) {
                for (int y = 0; y < v.cellGrid[z].length; y++) {
                    for (int x = 0; x < v.cellGrid[z][y].length; x++) used[v.cellGrid[z][y][x]] = true;
                }
            }
        }
        JsonArray out = new JsonArray();
        for (int i = 0; i < global.size(); i++) {
            if (used[i]) out.add(global.get(i));
        }
        return out;
    }

    private static JsonArray buildChannels(MultiblockFactorizer.MachineIn in) {
        JsonArray out = new JsonArray();
        for (MultiblockFactorizer.ChannelIn c : in.channels) {
            JsonObject o = new JsonObject();
            if (c.enumName == null) o.add("enum", com.google.gson.JsonNull.INSTANCE);
            else o.addProperty("enum", c.enumName);
            o.addProperty("id", c.id);
            o.addProperty("key", c.key);
            o.addProperty("name", c.name);
            String kind = "dimension".equals(c.kind) || "size".equals(c.kind) ? "size"
                : ("hatch".equals(c.kind) ? "hatch" : "replace");
            o.addProperty("kind", kind);
            int hi = c.domainMax == null ? c.max : c.domainMax.intValue();
            if ("size".equals(kind)) {
                o.addProperty("min", Integer.valueOf(1));
                o.addProperty("max", Integer.valueOf(hi));
                o.addProperty("axis", "y");
                o.addProperty("unit", "layers");
                o.addProperty("valueSemantics", "clamped-offset");
            } else if ("replace".equals(kind)) {
                o.addProperty("min", Integer.valueOf(Math.min(1, hi)));
                o.addProperty("max", Integer.valueOf(hi));
            }
            o.addProperty("domainSource", c.domainSource == null ? "probed" : c.domainSource);
            JsonObject dom = new JsonObject();
            if ("size".equals(kind)) dom.addProperty("min", Integer.valueOf(1));
            dom.addProperty("max", Integer.valueOf(hi));
            o.add("domain", dom);
            out.add(o);
        }
        return out;
    }

    private static JsonObject buildBackbone(MultiblockFactorizer.MachineIn in) {
        JsonObject bb = new JsonObject();
        bb.addProperty("kind", "sizeSteps");
        bb.addProperty("sizeChannel", "totalTier");
        JsonArray steps = new JsonArray();
        // 展开形态下"骨架"只作语义标注：用第一个变体的网格作为参考，逐个不同尺寸列一阶。
        Map<String, JsonObject> byDims = new LinkedHashMap<String, JsonObject>();
        for (MultiblockFactorizer.VariantIn v : in.variants) {
            int d = v.cellGrid.length;
            int h = d == 0 ? 0 : v.cellGrid[0].length;
            int w = h == 0 ? 0 : v.cellGrid[0][0].length;
            String k = w + "x" + h + "x" + d;
            if (byDims.containsKey(k)) continue;
            JsonObject s = new JsonObject();
            s.addProperty("channel", "totalTier");
            s.addProperty("layers", Integer.valueOf(h));
            s.addProperty("w", Integer.valueOf(w));
            s.addProperty("hh", Integer.valueOf(h));
            s.addProperty("d", Integer.valueOf(d));
            s.add("roles", new JsonObject());
            s.add("cellGrid", MultiblockDatasetCodec.toJsonArray(v.cellGrid));
            byDims.put(k, s);
            steps.add(s);
        }
        bb.add("sizeSteps", steps);
        return bb;
    }
}
