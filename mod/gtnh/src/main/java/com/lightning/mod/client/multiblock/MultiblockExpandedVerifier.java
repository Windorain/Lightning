package com.lightning.mod.client.multiblock;

import java.io.File;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.config.SdeMultiblockPipelineConfig;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * T1.6 **展开形态校验文件**（ground-truth cellGrid）写出器 —— 留白 #10 的拍板实现，
 * T3.3「web 装配 vs mod 导出逐格自动比对」的基准来源。
 *
 * <h2>产物形态（与 web 侧 T2.6/T3.3 的 diff 工具对齐）</h2>
 * 每个抽样组合一份 {@code <产物目录>/expanded/<slug>.multiblock__<variantKey 里 |/: → _>.json}：
 *
 * <pre>
 * { "schema": "lightning.multiblock.expanded/1",
 *   "variant": "coil:0|tt:1|runstate:idle",          // 同 referenceGrids.ReferenceGridFile.variant
 *   "dims": { "w": 3, "h": 4, "d": 3 },              // 同 referenceGrids.Dims
 *   "cellGrid": [ [ [ 0,0,0 ], ... ] ],              // [z][row][x]；row 0 = 结构顶部；不翻转不转置
 *   "palette": { "indexSpace": "global-union",
 *                "signatures": { "464": "{...canonicalJson(entry)...}" },   // 本网格用到的下标
 *                "labels":     { "464": "gt.blockmachines@1000" } } }
 * </pre>
 *
 * <b>坐标朝向口径</b>（与 {@code web/e2e/helpers/multiblock/referenceGrids.ts} 文件头一字不差）：
 * {@code cellGrid[z][row][x]}，{@code row 0 = 结构顶部}，世界 Y = {@code height-1-row}（
 * {@code @/pure/vec#structureRowToWorldY}）；**两边同一口径，不做任何翻转或转置**。
 * 这正是 {@code MultiblockDatasetCodec} 读出的 {@code variants[].grid.cellGrid} 与
 * {@code scripts/multiblock-fixtures/lib.mjs#assembleVariant} 的 {@code cellGrid} 的原生朝向。
 *
 * <b>调色板下标口径</b>：{@code cellGrid} 里的值是**全局并集调色板**下标（{@code palette.json#blockPalette}，
 * 0 = air）；而 web 侧渲染/装配的下标空间是**按机剪枝 + 重编号**后的产物 {@code blockPalette}。
 * 两边下标空间不同，因此逐格比对只能走**内容签名**（{@code canonicalJson(entry)}，对象键排序、
 * 数组保序 —— 与 {@code lib.mjs#entrySignature} 同口径）；每个文件内联「用到的下标 → 签名」映射，
 * 使 T3.3 不必读 13 MB 级并集调色板就能完成对齐（见 {@code scripts/multiblock-pipeline/verify-expanded.mjs}）。
 *
 * <h2>抽样清单（写进 {@code expanded/_manifest.json} 与管线结果文件）</h2>
 * 对每台验收多方块，按确定性规则取（同一输入两次运行得到**同一清单、同一文件字节**）：
 * <ol>
 * <li>每条具名通道的**最小取值**（0 = 未设置）与**最大取值**（{@code domain.max}）；</li>
 * <li>每个**运行态**一例（其余通道取未设置 + 最小总 Tier）；</li>
 * <li>N 组**伪随机组合**（自定义 LCG，种子 = slug 的 FNV-1a，跨 JVM/平台确定）；</li>
 * </ol>
 * 每条抽样都记录 {@code why}（含「是否精确命中目标」与命中的实际取值），因此「抽样是否覆盖了
 * 每通道最小/最大 + 两个运行态」可以机器核对，而不是靠人看。
 *
 * <h2>为什么不是「再构建一次」</h2>
 * 展开网格直接取自本轮 **T1.3 变体数据集的 ground-truth** {@code variants[].grid.cellGrid}
 * （与因子化编码器同一份输入），不做任何合成、不重新烘焙几何 —— 这正是「mod 导出的展开完整结构」
 * 的忠实含义，也保证它与产物共用同一份调色板与同一套引用下标。
 */
@SideOnly(Side.CLIENT)
public final class MultiblockExpandedVerifier {

    private MultiblockExpandedVerifier() {}

    /** 一次抽样。 */
    static final class Sample {

        final MultiblockFactorizer.VariantIn variant;
        final List<String> why = new ArrayList<String>();

        Sample(MultiblockFactorizer.VariantIn variant) {
            this.variant = variant;
        }
    }

    /**
     * 写出全部抽样组合的展开校验文件 + 抽样清单。
     *
     * @param outDir        产物目录（{@code <mcDataDir>/<outputDirName>}）
     * @param exportReport  T1.5 的 {@code export-report.json}（取 {@code products[]} 与 {@code datasetDir}）
     * @param randomSamples 每台额外抽的随机组合数
     * @return 摘要（写进管线结果文件的 {@code expanded} 段）
     */
    static JsonObject write(File outDir, JsonObject exportReport, int randomSamples) throws Exception {
        long t0 = System.currentTimeMillis();
        File expandedDir = new File(outDir, SdeMultiblockPipelineConfig.EXPANDED_SUBDIR);
        if (!expandedDir.isDirectory() && !expandedDir.mkdirs()) {
            throw new IllegalStateException("无法创建展开校验目录: " + expandedDir.getAbsolutePath());
        }
        JsonArray products = exportReport.getAsJsonArray("products");
        if (products == null) products = new JsonArray();
        if (products.size() == 0) {
            // 本轮无产物（范围里的机器全部失败，或范围本身为空）：这里**不是**管线失败（逐台原因已在
            // export-report.json.failures[] 里），只是没有可抽样的 ground-truth —— 写一份空清单 + 警告。
            return emptySummary(outDir, expandedDir, exportReport, t0);
        }
        String datasetDirPath = MultiblockExportRunner.str(exportReport, "datasetDir");
        if (datasetDirPath.isEmpty())
            throw new IllegalStateException("export-report.json 缺 datasetDir，无法定位 ground-truth 数据集");
        File datasetDir = new File(datasetDirPath);
        MultiblockDatasetCodec codec = new MultiblockDatasetCodec(datasetDir);
        File paletteFile = new File(datasetDir, "palette.json");
        if (!paletteFile.isFile())
            throw new IllegalStateException("数据集缺 palette.json: " + paletteFile.getAbsolutePath());

        JsonArray machineRows = new JsonArray();
        List<JsonObject> allFiles = new ArrayList<JsonObject>();
        int totalSamples = 0;

        for (JsonElement pe : products) {
            JsonObject p = pe.getAsJsonObject();
            String slug = MultiblockExportRunner.str(p, "sourceSlug");
            if (slug.isEmpty()) slug = MultiblockExportRunner.str(p, "machine");
            File mf = new File(new File(datasetDir, "machines"), slug + ".json");
            if (!mf.isFile()) {
                throw new IllegalStateException("数据集里找不到 " + slug + " 的 ground-truth：" + mf.getAbsolutePath());
            }
            MultiblockFactorizer.MachineIn mi = codec.readMachine(mf, slug);

            JsonObject machineRow = new JsonObject();
            machineRow.addProperty("slug", slug);
            machineRow.addProperty("machine", mi.id);
            machineRow.addProperty("displayName", mi.displayName);
            machineRow.addProperty("sourceClass", mi.sourceClass);
            machineRow.addProperty("productFile", slug + ".multiblock.json");
            machineRow.addProperty("variantTotal", Integer.valueOf(mi.variants.size()));
            machineRow.add("channels", channelsJson(mi));
            JsonArray runstates = new JsonArray();
            for (MultiblockFactorizer.RunstateIn rs : mi.runstates) runstates.add(new JsonPrimitive(rs.id));
            machineRow.add("runstates", runstates);
            JsonArray tierSample = new JsonArray();
            for (Integer t : mi.tierSample) tierSample.add(new JsonPrimitive(t));
            machineRow.add("tierSample", tierSample);
            machineRow.add(
                "samplingPolicy",
                new JsonPrimitive(
                    "每条具名通道的最小取值(0=未设置)与最大取值(domain.max) + 每个运行态一例 + " + randomSamples
                        + " 组确定性伪随机组合；每条抽样的 why 记录了命中的实际取值与是否精确命中"));

            List<Sample> samples = sample(mi, randomSamples);
            JsonArray sampleRows = new JsonArray();
            for (Sample s : samples) {
                String fileName = sampleFileBase(slug, s.variant.key);
                File f = new File(expandedDir, fileName);
                JsonObject doc = buildSampleDoc(mi, s, codec);
                MultiblockExportRunner.writeJson(f, doc);
                JsonObject row = new JsonObject();
                row.addProperty("variant", s.variant.key);
                row.addProperty("file", SdeMultiblockPipelineConfig.EXPANDED_SUBDIR + "/" + fileName);
                row.add("why", strings(s.why));
                JsonObject dims = doc.getAsJsonObject("dims");
                row.add("dims", dims);
                row.addProperty(
                    "cells",
                    Integer.valueOf(
                        dims.get("w")
                            .getAsInt()
                            * dims.get("h")
                                .getAsInt()
                            * dims.get("d")
                                .getAsInt()));
                row.addProperty("totalTier", Integer.valueOf(s.variant.totalTier));
                row.addProperty("runstate", s.variant.runstate);
                JsonObject values = new JsonObject();
                for (MultiblockFactorizer.ChannelIn c : mi.channels) {
                    Integer v = s.variant.values.get(c.key);
                    values.addProperty(c.key, Integer.valueOf(v == null ? 0 : v.intValue()));
                }
                row.add("values", values);
                sampleRows.add(row);
                totalSamples++;

                JsonObject fileRow = new JsonObject();
                fileRow.addProperty("file", SdeMultiblockPipelineConfig.EXPANDED_SUBDIR + "/" + fileName);
                fileRow.addProperty("slug", slug);
                fileRow.addProperty("bytes", Long.valueOf(f.length()));
                fileRow.addProperty("sha256", VariantCaptureRunner.sha256Hex(MultiblockExportRunner.readText(f)));
                allFiles.add(fileRow);
            }
            machineRow.add("samples", sampleRows);
            machineRows.add(machineRow);
        }

        // ---- 清单（抽样清单本身也是交付物之一） ----
        JsonObject manifest = new JsonObject();
        manifest.addProperty("schema", SdeMultiblockPipelineConfig.EXPANDED_SCHEMA);
        manifest.addProperty("task", "T1.6 展开形态校验文件（ground-truth cellGrid，供 T3.3 与 web 装配逐格 diff）");
        manifest.addProperty("generatedAtEpochMs", Long.valueOf(System.currentTimeMillis()));
        manifest.addProperty(
            "coordinateConvention",
            "cellGrid[z][row][x]；row 0 = 结构顶部；世界 Y = height-1-row；不翻转不转置"
                + "（与 web/e2e/helpers/multiblock/referenceGrids.ts 文件头同口径）");
        manifest.addProperty(
            "signatureConvention",
            "canonicalJson(entry)：对象键排序、数组保序（与 scripts/multiblock-fixtures/lib.mjs#entrySignature 同口径）；"
                + "cellGrid 下标空间 = 全局并集调色板（0 = air），用 signatures 映射即可与产物按机剪枝/重编号后的下标空间对齐");
        JsonObject pal = new JsonObject();
        pal.addProperty("indexSpace", "global-union");
        pal.addProperty("ref", relative(outDir, paletteFile));
        pal.addProperty("refAbs", paletteFile.getAbsolutePath());
        pal.addProperty("refSha256", VariantCaptureRunner.sha256Hex(MultiblockExportRunner.readText(paletteFile)));
        pal.addProperty(
            "blockPaletteEntries",
            Integer.valueOf(
                codec.palette()
                    .size()));
        manifest.add("palette", pal);
        manifest.addProperty("sourceDataset", datasetDir.getAbsolutePath());
        manifest.addProperty("productDir", outDir.getAbsolutePath());
        manifest.add("machines", machineRows);
        JsonObject totals = new JsonObject();
        totals.addProperty("machines", Integer.valueOf(machineRows.size()));
        totals.addProperty("samples", Integer.valueOf(totalSamples));
        totals.addProperty("files", Integer.valueOf(allFiles.size()));
        manifest.add("totals", totals);
        MultiblockExportRunner
            .writeJson(new File(expandedDir, SdeMultiblockPipelineConfig.EXPANDED_MANIFEST), manifest);

        JsonObject summary = new JsonObject();
        summary.addProperty("dir", expandedDir.getAbsolutePath());
        summary.addProperty(
            "manifest",
            expandedDir.getAbsolutePath() + File.separator + SdeMultiblockPipelineConfig.EXPANDED_MANIFEST);
        summary.addProperty("machines", Integer.valueOf(machineRows.size()));
        summary.addProperty("samples", Integer.valueOf(totalSamples));
        summary.addProperty("files", Integer.valueOf(allFiles.size()));
        summary.addProperty("randomSamplesPerMachine", Integer.valueOf(randomSamples));
        summary.add("sampleList", machineRows);
        JsonArray filesJson = new JsonArray();
        for (JsonObject f : allFiles) filesJson.add(f);
        summary.add("filesSha256", filesJson);
        summary.addProperty("elapsedMs", Long.valueOf(System.currentTimeMillis() - t0));
        return summary;
    }

    // ------------------------------------------------------------------ 空产物兜底

    /** 本轮 0 产物时的展开清单：写一份**明确说明为什么没有基准**的 manifest，而不是静默不写。 */
    private static JsonObject emptySummary(File outDir, File expandedDir, JsonObject exportReport, long t0)
        throws Exception {
        JsonObject manifest = new JsonObject();
        manifest.addProperty("schema", SdeMultiblockPipelineConfig.EXPANDED_SCHEMA);
        manifest.addProperty("generatedAtEpochMs", Long.valueOf(System.currentTimeMillis()));
        manifest.addProperty("task", "T1.6 展开形态校验文件（本轮 0 产物，无 ground-truth 可抽）");
        manifest.addProperty(
            "emptyReason",
            "本轮 T1.5 导出 0 份产物（范围里的机器全部失败，或请求范围为空）——逐台原因见 export-report.json.failures[]；" + "这不是展开写出失败，而是没有可抽样的输入。");
        manifest.addProperty("sourceDataset", MultiblockExportRunner.str(exportReport, "datasetDir"));
        manifest.add("machines", new JsonArray());
        JsonObject totals = new JsonObject();
        totals.addProperty("machines", Integer.valueOf(0));
        totals.addProperty("samples", Integer.valueOf(0));
        totals.addProperty("files", Integer.valueOf(0));
        manifest.add("totals", totals);
        MultiblockExportRunner
            .writeJson(new File(expandedDir, SdeMultiblockPipelineConfig.EXPANDED_MANIFEST), manifest);

        JsonObject summary = new JsonObject();
        summary.addProperty("dir", expandedDir.getAbsolutePath());
        summary.addProperty(
            "manifest",
            expandedDir.getAbsolutePath() + File.separator + SdeMultiblockPipelineConfig.EXPANDED_MANIFEST);
        summary.addProperty("machines", Integer.valueOf(0));
        summary.addProperty("samples", Integer.valueOf(0));
        summary.addProperty("files", Integer.valueOf(0));
        summary.addProperty("randomSamplesPerMachine", Integer.valueOf(0));
        summary.addProperty("empty", Boolean.TRUE);
        summary.add("sampleList", new JsonArray());
        summary.add("filesSha256", new JsonArray());
        summary.addProperty("elapsedMs", Long.valueOf(System.currentTimeMillis() - t0));
        return summary;
    }

    // ------------------------------------------------------------------ 单份展开文件

    private static JsonObject buildSampleDoc(MultiblockFactorizer.MachineIn mi, Sample s,
        MultiblockDatasetCodec codec) {
        int[][][] grid = s.variant.cellGrid;
        int d = grid.length;
        int h = d == 0 ? 0 : grid[0].length;
        int w = h == 0 ? 0 : grid[0][0].length;

        JsonObject doc = new JsonObject();
        doc.addProperty("schema", SdeMultiblockPipelineConfig.EXPANDED_SCHEMA);
        doc.addProperty("variant", s.variant.key);
        JsonObject dims = new JsonObject();
        dims.addProperty("w", Integer.valueOf(w));
        dims.addProperty("h", Integer.valueOf(h));
        dims.addProperty("d", Integer.valueOf(d));
        doc.add("dims", dims);
        doc.add("cellGrid", MultiblockDatasetCodec.toJsonArray(grid));

        JsonObject machine = new JsonObject();
        machine.addProperty("slug", mi.sourceSlug);
        machine.addProperty("id", mi.id);
        machine.addProperty("displayName", mi.displayName);
        machine.addProperty("sourceClass", mi.sourceClass);
        machine.addProperty("indexSpaceSource", mi.paletteSource);
        doc.add("machine", machine);

        JsonObject values = new JsonObject();
        for (MultiblockFactorizer.ChannelIn c : mi.channels) {
            Integer v = s.variant.values.get(c.key);
            values.addProperty(c.key, Integer.valueOf(v == null ? 0 : v.intValue()));
        }
        doc.add("values", values);
        doc.addProperty("totalTier", Integer.valueOf(s.variant.totalTier));
        doc.addProperty("runstate", s.variant.runstate);
        doc.add("why", strings(s.why));
        doc.addProperty("coordinateConvention", "cellGrid[z][row][x]；row 0 = 结构顶部；世界 Y = height-1-row；不翻转不转置");

        // 全局并集调色板：只内联本网格**用到的**下标 → 内容签名（自洽，读文件即可对齐，不必读 13 MB 级并集调色板）
        Set<Integer> used = new TreeSet<Integer>();
        for (int z = 0; z < grid.length; z++) {
            for (int y = 0; y < grid[z].length; y++) {
                for (int x = 0; x < grid[z][y].length; x++) used.add(Integer.valueOf(grid[z][y][x]));
            }
        }
        JsonArray global = codec.palette();
        JsonObject signatures = new JsonObject();
        JsonObject labels = new JsonObject();
        for (Integer idx : used) {
            int i = idx.intValue();
            if (i < 0 || i >= global.size()) {
                throw new IllegalStateException(
                    "展开网格出现越界全局下标 " + i + "（并集调色板长度 " + global.size() + "，变体 " + s.variant.key + "）");
            }
            JsonElement entry = global.get(i);
            signatures.addProperty(String.valueOf(i), canonical(entry));
            labels.addProperty(String.valueOf(i), label(entry));
        }
        JsonObject palette = new JsonObject();
        palette.addProperty("indexSpace", "global-union");
        // ⚠️ 这里**刻意不写** palette.json 的路径：数据集目录名带 run-NNNN，会把"两次运行产物逐字节一致"
        // 这条幂等判据毁掉（自检 1）。逐份文件自带用到的下标 → 签名，自洽可校验；
        // 「数据集中立来源 + palette 哈希」写在 expanded/_manifest.json 里（清单本就带时间戳，不参与字节比对）。
        palette.addProperty("entryCount", Integer.valueOf(global.size()));
        palette.add("signatures", signatures);
        palette.add("labels", labels);
        doc.add("palette", palette);
        return doc;
    }

    /** T2.6/T3.3 的参考文件命名规则（一字不差）：{@code <fixture 去 .json>__<variantKey 里 |/: → _>.json}。 */
    static String sampleFileBase(String slug, String variantKey) {
        return (slug + ".multiblock") + "__"
            + variantKey.replace('|', '_')
                .replace(':', '_')
            + ".json";
    }

    // ------------------------------------------------------------------ 抽样

    /**
     * 抽样清单（确定性）：每通道最小/最大取值 + 每个运行态 + N 组伪随机组合。
     * 取值选择用「目标越近越好」的最小代价搜索（并列取变体表里靠前者），因此**不依赖**域与
     * tierSample 的具体形状：被 T1.5 自动/显式收窄过的机器同样能选出真实存在的组合，
     * 且 {@code why} 会如实记录「命中的是哪个实际取值」。
     */
    static List<Sample> sample(MultiblockFactorizer.MachineIn mi, int randomSamples) {
        Map<String, Sample> out = new LinkedHashMap<String, Sample>();
        List<MultiblockFactorizer.ChannelIn> chs = new ArrayList<MultiblockFactorizer.ChannelIn>();
        for (MultiblockFactorizer.ChannelIn c : mi.channels) {
            if (!"hatch".equals(c.kind)) chs.add(c);
        }
        int baseTier = mi.tierSample.isEmpty() ? mi.ttMin
            : mi.tierSample.get(0)
                .intValue();

        for (MultiblockFactorizer.ChannelIn c : chs) {
            int hi = c.domainMax == null ? c.max : c.domainMax.intValue();
            addSample(
                out,
                mi,
                chs,
                "channel:" + c.key + "=min",
                c.key,
                0,
                VariantCaptureRunner.RUNSTATE_IDLE,
                baseTier);
            addSample(
                out,
                mi,
                chs,
                "channel:" + c.key + "=max(domain.max=" + hi + ")",
                c.key,
                hi,
                VariantCaptureRunner.RUNSTATE_IDLE,
                baseTier);
        }
        for (MultiblockFactorizer.RunstateIn rs : mi.runstates) {
            addRunstateSample(out, mi, chs, rs.id, baseTier);
        }

        // 确定性伪随机：LCG（Numerical Recipes 常数），种子 = slug 的 FNV-1a —— 跨 JVM/平台恒定。
        long seed = fnv1a(mi.sourceSlug);
        long state = seed == 0 ? 0x9E3779B97F4A7C15L : seed;
        int n = mi.variants.size();
        for (int k = 0; k < randomSamples && n > 0; k++) {
            state = state * 6364136223846793005L + 1442695040888963407L;
            int idx = (int) ((state >>> 1) % n);
            MultiblockFactorizer.VariantIn v = mi.variants.get(idx);
            Sample s = out.get(v.key);
            if (s == null) {
                s = new Sample(v);
                out.put(v.key, s);
            }
            s.why.add("random#" + (k + 1) + "(seed=" + seed + ", variantIndex=" + idx + ")");
        }
        return new ArrayList<Sample>(out.values());
    }

    private static void addSample(Map<String, Sample> out, MultiblockFactorizer.MachineIn mi,
        List<MultiblockFactorizer.ChannelIn> chs, String why, String channel, int target, String runstate, int tier) {
        MultiblockFactorizer.VariantIn best = null;
        int bestScore = Integer.MAX_VALUE;
        String bestDetail = "";
        for (MultiblockFactorizer.VariantIn v : mi.variants) {
            int score = 0;
            StringBuilder detail = new StringBuilder();
            for (MultiblockFactorizer.ChannelIn c : chs) {
                Integer raw = v.values.get(c.key);
                int value = raw == null ? 0 : raw.intValue();
                if (c.key.equals(channel)) {
                    if (value != target) score += 10000 + Math.abs(value - target);
                } else if (value != 0) {
                    score += 100 * value;
                }
            }
            detail.append("hit=")
                .append(channel)
                .append(':')
                .append(v.values.get(channel));
            if (!runstate.equals(v.runstate)) score += 5000;
            else detail.append(", runstate=")
                .append(v.runstate);
            if (v.totalTier != tier) score += 10 * Math.abs(v.totalTier - tier);
            else detail.append(", tt=")
                .append(v.totalTier);
            if (score < bestScore) {
                bestScore = score;
                best = v;
                bestDetail = detail.toString();
            }
        }
        if (best == null) return;
        Sample s = out.get(best.key);
        if (s == null) {
            s = new Sample(best);
            out.put(best.key, s);
        }
        s.why.add(
            why + " → "
                + best.key
                + " ["
                + bestDetail
                + (bestScore == 0 ? ", 精确命中]" : ", 就近匹配(score=" + bestScore + ")]"));
    }

    private static void addRunstateSample(Map<String, Sample> out, MultiblockFactorizer.MachineIn mi,
        List<MultiblockFactorizer.ChannelIn> chs, String runstate, int tier) {
        MultiblockFactorizer.VariantIn best = null;
        int bestScore = Integer.MAX_VALUE;
        StringBuilder detail = new StringBuilder();
        for (MultiblockFactorizer.VariantIn v : mi.variants) {
            int score = 0;
            int sum = 0;
            for (MultiblockFactorizer.ChannelIn c : chs) {
                Integer raw = v.values.get(c.key);
                sum += raw == null ? 0 : raw.intValue();
            }
            score += 100 * sum;
            if (!runstate.equals(v.runstate)) score += 100000;
            if (v.totalTier != tier) score += 10 * Math.abs(v.totalTier - tier);
            if (score < bestScore) {
                bestScore = score;
                best = v;
                detail.setLength(0);
                detail.append("runstate=")
                    .append(v.runstate)
                    .append(", tt=")
                    .append(v.totalTier)
                    .append(", values=")
                    .append(v.values);
            }
        }
        if (best == null) return;
        Sample s = out.get(best.key);
        if (s == null) {
            s = new Sample(best);
            out.put(best.key, s);
        }
        s.why.add(
            "runstate:" + runstate
                + " → "
                + best.key
                + " ["
                + detail
                + (bestScore == 0 ? ", 精确命中]" : ", 就近匹配(score=" + bestScore + ")]"));
    }

    private static long fnv1a(String s) {
        long h = 0xcbf29ce484222325L;
        for (int i = 0; i < s.length(); i++) {
            h ^= s.charAt(i);
            h *= 0x100000001b3L;
        }
        return h;
    }

    // ------------------------------------------------------------------ 调色板签名（与 lib.mjs 同口径）

    /**
     * 规范化 JSON：**对象键排序、数组保序**，与 {@code scripts/multiblock-fixtures/lib.mjs#canonicalJson}
     * 逐字符对齐（含字符串转义：只转义 {@code " \ } 与控制字符，不做 HTML 转义 ——
     * Gson 的 {@code JsonPrimitive#toString} 会 HTML 转义，故**不能**直接用）。
     */
    static String canonical(JsonElement e) {
        StringBuilder sb = new StringBuilder();
        canonical(e, sb);
        return sb.toString();
    }

    private static void canonical(JsonElement e, StringBuilder sb) {
        if (e == null || e.isJsonNull()) {
            sb.append("null");
            return;
        }
        if (e.isJsonArray()) {
            sb.append('[');
            JsonArray a = e.getAsJsonArray();
            for (int i = 0; i < a.size(); i++) {
                if (i > 0) sb.append(',');
                canonical(a.get(i), sb);
            }
            sb.append(']');
            return;
        }
        if (e.isJsonObject()) {
            JsonObject o = e.getAsJsonObject();
            Map<String, JsonElement> sorted = new TreeMap<String, JsonElement>();
            for (Map.Entry<String, JsonElement> me : o.entrySet()) sorted.put(me.getKey(), me.getValue());
            sb.append('{');
            boolean first = true;
            for (Map.Entry<String, JsonElement> me : sorted.entrySet()) {
                if (!first) sb.append(',');
                first = false;
                jsonString(me.getKey(), sb);
                sb.append(':');
                canonical(me.getValue(), sb);
            }
            sb.append('}');
            return;
        }
        JsonPrimitive p = e.getAsJsonPrimitive();
        if (p.isBoolean()) {
            sb.append(p.getAsBoolean() ? "true" : "false");
        } else if (p.isNumber()) {
            sb.append(numberLiteral(p));
        } else {
            jsonString(p.getAsString(), sb);
        }
    }

    /**
     * 数字字面量：**必须与 JS {@code JSON.stringify(number)} 的输出一致**（否则两边的内容签名对不上，
     * 逐格 diff 会整片假红）。
     * <p>
     * 实测踩坑：数据集调色板里写的是 {@code "u":1.0}，Gson 的 {@code LazilyParsedNumber.toString()} 原样
     * 返回 {@code "1.0"}，而 JS 解析成 1 后 stringify 成 {@code "1"} —— 4189 vs 3949 字节的签名差异全部
     * 来自这里。因此改为「解析成 double → 按 JS 的 Number→String 规则输出」：整数去掉 {@code .0}、
     * 指数形式转普通十进制、{@code -0} → {@code 0}、NaN/Infinity → {@code null}。
     * <p>
     * 已知边界（本数据不会出现，若出现需另行对齐）：{@code |x| ≥ 1e21} 时 JS 用 {@code 1e+21} 形式，
     * 本实现给全展开的十进制。
     */
    static String numberLiteral(JsonPrimitive p) {
        double d = p.getAsDouble();
        if (Double.isNaN(d) || Double.isInfinite(d)) return "null";
        if (d == 0.0d) return "0";
        if (d == Math.rint(d) && Math.abs(d) < 1e15d) return Long.toString((long) d);
        String s = Double.toString(d);
        if (s.indexOf('E') >= 0 || s.indexOf('e') >= 0) {
            try {
                return new BigDecimal(s).stripTrailingZeros()
                    .toPlainString();
            } catch (Throwable ignored) {
                return s;
            }
        }
        return s;
    }

    private static void jsonString(String s, StringBuilder sb) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\b':
                    sb.append("\\b");
                    break;
                case '\f':
                    sb.append("\\f");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\t':
                    sb.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", Integer.valueOf(c)));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }

    /** 人读标签 {@code name@meta}（与 {@code referenceGrids.paletteLabels} 同口径：去掉 namespaced 前缀）。 */
    static String label(JsonElement entry) {
        if (entry == null || !entry.isJsonObject()) return "?";
        JsonObject o = entry.getAsJsonObject();
        String rid = o.has("registryId") && !o.get("registryId")
            .isJsonNull() ? o.get("registryId")
                .getAsString() : "";
        int colon = rid.indexOf(':');
        String name = colon >= 0 ? rid.substring(colon + 1) : rid;
        int meta = o.has("meta") && !o.get("meta")
            .isJsonNull() ? o.get("meta")
                .getAsInt() : 0;
        return name + "@" + meta;
    }

    // ------------------------------------------------------------------ 小工具

    private static JsonArray channelsJson(MultiblockFactorizer.MachineIn mi) {
        JsonArray out = new JsonArray();
        for (MultiblockFactorizer.ChannelIn c : mi.channels) {
            JsonObject o = new JsonObject();
            o.addProperty("key", c.key);
            o.addProperty("id", c.id);
            o.addProperty("kind", c.kind);
            o.addProperty("enum", c.enumName);
            int hi = c.domainMax == null ? c.max : c.domainMax.intValue();
            o.addProperty("domainMin", Integer.valueOf(0));
            o.addProperty("domainMax", Integer.valueOf(hi));
            o.addProperty("trueDomainMax", c.trueDomainMax);
            o.addProperty("subsetOverridden", Boolean.valueOf(c.subsetOverridden));
            out.add(o);
        }
        return out;
    }

    private static JsonArray strings(List<String> in) {
        JsonArray a = new JsonArray();
        for (String s : in) a.add(new JsonPrimitive(s));
        return a;
    }

    /** 相对路径（同盘符可用时），否则退化为绝对路径。 */
    private static String relative(File baseDir, File target) {
        try {
            String rel = baseDir.toURI()
                .relativize(target.toURI())
                .getPath();
            if (!rel.isEmpty()) return rel;
        } catch (Throwable ignored) {
            // 跨盘符/不同 root：退化
        }
        return target.getAbsolutePath();
    }
}
