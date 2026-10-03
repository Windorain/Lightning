package com.lightning.mod.client.meshcapture.parts.probe;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.GZIPInputStream;

import net.minecraft.block.Block;
import net.minecraft.client.Minecraft;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.client.export.SceneEnvelopeBuilder;
import com.lightning.mod.client.meshcapture.MeshCaptureService;
import com.lightning.mod.client.meshcapture.parts.PartExportIntegrator;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * P1.7 导出集成的运行级验证探针（触发文件 {@code "partsExport":true} 时启用，默认关闭；
 * 启用时隐含 {@code singleBox} 放置——火把/slab/石头与三族格是导出来源）。
 *
 * <p>
 * 走<strong>真实导出路径</strong>：按服务端 scan 产物的形状合成
 * {@code geometryPhase=scan} 文档（cellTypes/cellGrid/worldGrid，worldGrid 指向探针世界
 * 真实放置格），调 {@link MeshCaptureService#finalizeStructureJson} 完成烘焙 + 部件落盘，
 * 再经 {@link SceneEnvelopeBuilder#toEnvelope} 验证信封透传。验证项：
 * <ol>
 * <li><strong>落盘形状（契约 §2/§3/§9）</strong>：cellPartsGrid 与 cellGrid 同形；partLists
 * 去重（同一 slab 格两列引用 ⇒ 同一下标）；五要素 + 来源四元组逐列核对（石头 -1 / slab 档 2 /
 * 火把档 3 inferred + facing / 三族格档 1）；statsTemplate={mode:auto,groups:[],showOthers:true}
 * 仅在含部件时写入；partIconTextures 键 = 物品身份键；</li>
 * <li><strong>字节干净（硬约束）</strong>：满方块-only 结构在「部件采集开启 vs
 * {@link PartExportIntegrator#setEnabledForProbe}(false)」两次导出<strong>字节一致</strong>
 * （哈希对证据），且 enabled 产物无任何部件字段；</li>
 * <li><strong>幂等</strong>：同一含部件结构重复导出（两次独立 scan→baked）字节一致；</li>
 * <li><strong>信封透传</strong>：Envelope payload 解压后含 cellPartsGrid/partLists/
 * statsTemplate/partIconTextures 四字段。</li>
 * </ol>
 *
 * <p>
 * 导出产物同时写 {@code sde_parts_export_probe_*.json}（外层脚本归档），断言失败细节落
 * {@code checks[]}，聚合 {@code pass} 门控探针退出码（false ⇒ exitCode 2）。
 */
@SideOnly(Side.CLIENT)
final class PartsExportProbe {

    private static final Gson PRETTY = new GsonBuilder().setPrettyPrinting()
        .create();

    private PartsExportProbe() {}

    static JsonObject run(Minecraft mc, List<PartsProbePlacement.Placed> placed) {
        JsonObject out = new JsonObject();
        out.addProperty("schema", "lightning.parts-export-probe/1");
        out.addProperty("task", "P1.7 导出集成运行级验证（真实 finalizeStructureJson 路径）");
        JsonArray checks = new JsonArray();
        int failed = 0;

        try {
            // ---------------- 含部件结构：air + 石头 + slab×3 + 火把×2 + 三族格 ----------------
            List<PartsProbePlacement.Placed> cols = new ArrayList<PartsProbePlacement.Placed>();
            PartsProbePlacement.Placed stone = find(placed, "stone-control");
            PartsProbePlacement.Placed slabBottom = find(placed, "slab-bottom");
            PartsProbePlacement.Placed slabTop = find(placed, "slab-top");
            PartsProbePlacement.Placed torchFloor = find(placed, "torch-floor");
            PartsProbePlacement.Placed torchWall = find(placed, "torch-wall");
            PartsProbePlacement.Placed ae2 = findFamily(placed, "ae2");
            PartsProbePlacement.Placed eio = findFamily(placed, "enderio");
            PartsProbePlacement.Placed fmp = findFamily(placed, "fmp");
            expect(checks, stone != null && slabBottom != null && slabTop != null, "单盒锚点格齐全");
            expect(checks, torchFloor != null && torchWall != null, "火把锚点格齐全");
            expect(checks, ae2 != null && eio != null && fmp != null, "三族锚点格齐全");
            if (stone == null || slabBottom == null
                || slabTop == null
                || torchFloor == null
                || torchWall == null
                || ae2 == null
                || eio == null
                || fmp == null) {
                out.add("checks", checks);
                out.addProperty("pass", Boolean.FALSE);
                return out;
            }
            cols.add(null); // col0 = air
            cols.add(stone); // col1 = 满方块对照
            cols.add(slabBottom); // col2 = 档 2
            cols.add(slabBottom); // col3 = 与 col2 同格 ⇒ partLists 去重证据
            cols.add(slabTop); // col4 = 档 2（上半）
            cols.add(torchFloor); // col5 = 档 3 inferred
            cols.add(torchWall); // col6 = 档 3 inferred（挂墙）
            cols.add(ae2); // col7 = 档 1 ae2
            cols.add(eio); // col8 = 档 1 eio
            cols.add(fmp); // col9 = 档 1 fmp

            // 两次独立导出（幂等对）
            byte[] runA = exportPretty(mc, cols);
            byte[] runB = exportPretty(mc, cols);
            String shaA = sha256Hex(runA);
            String shaB = sha256Hex(runB);
            JsonObject idem = new JsonObject();
            idem.addProperty("runASha256", shaA);
            idem.addProperty("runBSha256", shaB);
            idem.addProperty("identical", Boolean.valueOf(shaA.equals(shaB)));
            out.add("idempotency", idem);
            expect(checks, shaA.equals(shaB), "同一结构重复导出应字节一致（幂等）");

            JsonObject rootA = new JsonParser().parse(new String(runA, StandardCharsets.UTF_8))
                .getAsJsonObject();
            checkPartsDocument(checks, rootA);
            checkEnvelope(checks, rootA);
            out.add("partsExcerpt", excerpt(rootA));

            // ---------------- 满方块-only 结构：enabled vs disabled 字节对 ----------------
            List<PartsProbePlacement.Placed> fullCols = new ArrayList<PartsProbePlacement.Placed>();
            fullCols.add(stone);
            fullCols.add(stone); // 同格两列（调色板去重）
            byte[] enabledBytes = exportPretty(mc, fullCols);
            JsonObject enabledRoot = new JsonParser().parse(new String(enabledBytes, StandardCharsets.UTF_8))
                .getAsJsonObject();
            expect(
                checks,
                !enabledRoot.has("cellPartsGrid") && !enabledRoot.has("partLists")
                    && !enabledRoot.has("statsTemplate")
                    && !enabledRoot.has("partIconTextures"),
                "满方块-only 导出不应有任何部件字段（cellPartsGrid/partLists/statsTemplate/partIconTextures）");

            PartExportIntegrator.setEnabledForProbe(false);
            byte[] disabledBytes;
            try {
                disabledBytes = exportPretty(mc, fullCols);
            } finally {
                PartExportIntegrator.setEnabledForProbe(true);
            }
            String shaEnabled = sha256Hex(enabledBytes);
            String shaDisabled = sha256Hex(disabledBytes);
            JsonObject bytePair = new JsonObject();
            bytePair.addProperty("partsEnabledSha256", shaEnabled);
            bytePair.addProperty("partsDisabledSha256", shaDisabled);
            bytePair.addProperty("identical", Boolean.valueOf(shaEnabled.equals(shaDisabled)));
            out.add("fullCubeBytePair", bytePair);
            expect(checks, shaEnabled.equals(shaDisabled), "满方块-only 结构导出 enabled/disabled 应字节一致（基线干净哈希对）");

            writeArtifact(mc, "sde_parts_export_probe_runA.json", runA);
            writeArtifact(mc, "sde_parts_export_probe_baseline_enabled.json", enabledBytes);
            writeArtifact(mc, "sde_parts_export_probe_baseline_disabled.json", disabledBytes);
        } catch (Throwable t) {
            checks.add(new JsonPrimitive("FAIL: 探针异常 " + PartsProbeReflect.describe(t)));
        }

        for (int i = 0; i < checks.size(); i++) {
            if (checks.get(i)
                .getAsString()
                .startsWith("FAIL")) {
                failed++;
            }
        }
        out.add("checks", checks);
        out.addProperty("failedChecks", Integer.valueOf(failed));
        out.addProperty("pass", Boolean.valueOf(failed == 0));
        FMLLog.info(
            "[SDE][P1.7] 导出集成探针完成 pass=%s failedChecks=%d",
            Boolean.valueOf(failed == 0),
            Integer.valueOf(failed));
        return out;
    }

    // ------------------------------------------------------------------ 导出驱动

    /** 合成 scan 文档（形状 = 服务端 scan 产物）并跑真实 finalizeStructureJson，返回 pretty 字节。 */
    private static byte[] exportPretty(Minecraft mc, List<PartsProbePlacement.Placed> cols) throws Exception {
        JsonObject root = buildScanDocument(mc, cols);
        MeshCaptureService.finalizeStructureJson(root);
        return PRETTY.toJson(root)
            .getBytes(StandardCharsets.UTF_8);
    }

    /**
     * 合成 {@code geometryPhase=scan} 单结构文档：cellTypes（0=air + 逐列方块采样）/
     * cellGrid（1×1×N）/ worldGrid（指向探针世界真实格，air 列 = null）。
     */
    private static JsonObject buildScanDocument(Minecraft mc, List<PartsProbePlacement.Placed> cols) {
        JsonArray cellTypes = new JsonArray();
        JsonObject air = new JsonObject();
        air.addProperty("registryId", "air");
        air.addProperty("meta", Integer.valueOf(0));
        cellTypes.add(air);
        Map<String, Integer> typeIndex = new LinkedHashMap<String, Integer>();
        JsonArray rows = new JsonArray();
        JsonArray colArr = new JsonArray();
        JsonArray wRows = new JsonArray();
        JsonArray wColArr = new JsonArray();
        for (PartsProbePlacement.Placed p : cols) {
            if (p == null) {
                colArr.add(new JsonPrimitive(Integer.valueOf(0)));
                wColArr.add(com.google.gson.JsonNull.INSTANCE);
                continue;
            }
            Block b = mc.theWorld.getBlock(p.x, p.y, p.z);
            int meta = mc.theWorld.getBlockMetadata(p.x, p.y, p.z);
            String reg = net.minecraft.block.Block.blockRegistry.getNameForObject(b);
            String key = reg + ":" + meta;
            Integer ti = typeIndex.get(key);
            if (ti == null) {
                ti = Integer.valueOf(cellTypes.size());
                typeIndex.put(key, ti);
                JsonObject t = new JsonObject();
                t.addProperty("registryId", reg);
                t.addProperty("meta", Integer.valueOf(meta));
                cellTypes.add(t);
            }
            colArr.add(new JsonPrimitive(ti));
            JsonObject w = new JsonObject();
            w.addProperty("x", Integer.valueOf(p.x));
            w.addProperty("y", Integer.valueOf(p.y));
            w.addProperty("z", Integer.valueOf(p.z));
            wColArr.add(w);
        }
        rows.add(colArr);
        wRows.add(wColArr);
        JsonArray cellGrid = new JsonArray();
        cellGrid.add(rows);
        JsonArray worldGrid = new JsonArray();
        worldGrid.add(wRows);

        JsonObject root = new JsonObject();
        root.addProperty("geometryPhase", "scan");
        root.add("cellTypes", cellTypes);
        root.add("cellGrid", cellGrid);
        root.add("worldGrid", worldGrid);
        return root;
    }

    // ------------------------------------------------------------------ 断言

    /** 落盘形状核对（契约 §2/§3/§9）：网格同形、去重、逐列来源、五要素、statsTemplate、图标键。 */
    private static void checkPartsDocument(JsonArray checks, JsonObject root) {
        expect(checks, root.has("cellPartsGrid"), "含部件文档应有 cellPartsGrid");
        expect(checks, root.has("partLists"), "含部件文档应有 partLists");
        expect(checks, root.has("statsTemplate"), "含部件文档应有 statsTemplate");
        expect(checks, root.has("partIconTextures"), "含部件文档应有 partIconTextures");
        if (!root.has("cellPartsGrid") || !root.has("partLists")) {
            return;
        }
        JsonArray grid = root.getAsJsonArray("cellPartsGrid");
        JsonArray lists = root.getAsJsonArray("partLists");
        JsonArray cellGrid = root.getAsJsonArray("cellGrid");
        expect(
            checks,
            grid.size() == cellGrid.size() && grid.get(0)
                .getAsJsonArray()
                .size()
                == cellGrid.get(0)
                    .getAsJsonArray()
                    .size()
                && grid.get(0)
                    .getAsJsonArray()
                    .get(0)
                    .getAsJsonArray()
                    .size()
                    == cellGrid.get(0)
                        .getAsJsonArray()
                        .get(0)
                        .getAsJsonArray()
                        .size(),
            "cellPartsGrid 应与 cellGrid 同形");

        JsonArray row = grid.get(0)
            .getAsJsonArray()
            .get(0)
            .getAsJsonArray();
        // col0 air / col1 stone ⇒ -1
        expect(
            checks,
            row.get(0)
                .getAsInt() == -1,
            "air 列应为 -1");
        expect(
            checks,
            row.get(1)
                .getAsInt() == -1,
            "石头列应为 -1（满方块）");
        // col2/col3 同一 slab 格 ⇒ 同一下标（去重生效）
        int i2 = row.get(2)
            .getAsInt();
        int i3 = row.get(3)
            .getAsInt();
        expect(checks, i2 >= 0, "slab-bottom 列应有部件");
        expect(checks, i2 == i3, "同一 slab 格两列应去重到同一 partLists 下标（" + i2 + " vs " + i3 + "）");

        // partLists 条数应少于有部件列数（去重生效的全局证据）
        int colsWithParts = 0;
        for (int i = 0; i < row.size(); i++) {
            if (row.get(i)
                .getAsInt() >= 0) {
                colsWithParts++;
            }
        }
        expect(
            checks,
            lists.size() < colsWithParts,
            "partLists 去重应生效（池 " + lists.size() + " < 有部件列 " + colsWithParts + "）");

        // 逐列来源四元组
        checkColSource(checks, row, lists, 2, "generic", 2);
        checkColSource(checks, row, lists, 4, "generic", 2);
        checkColSource(checks, row, lists, 5, "inferred", 3);
        checkColSource(checks, row, lists, 6, "inferred", 3);
        checkColSource(checks, row, lists, 7, "ae2", 1);
        checkColSource(checks, row, lists, 8, "eio", 1);
        checkColSource(checks, row, lists, 9, "fmp", 1);

        // 火把列：facing 进 properties（§7.3）
        JsonObject torchFloorPart = firstPart(row, lists, 5);
        if (torchFloorPart != null) {
            expect(
                checks,
                torchFloorPart.has("properties") && "meta5".equals(
                    torchFloorPart.getAsJsonObject("properties")
                        .get("facing")
                        .getAsString()),
                "地面火把 properties.facing 应为 meta5");
        }
        JsonObject torchWallPart = firstPart(row, lists, 6);
        if (torchWallPart != null) {
            expect(
                checks,
                torchWallPart.has("properties") && "meta1".equals(
                    torchWallPart.getAsJsonObject("properties")
                        .get("facing")
                        .getAsString()),
                "挂墙火把 properties.facing 应为 meta1");
        }

        // 五要素齐全（逐 part）
        int checked = 0;
        for (int li = 0; li < lists.size(); li++) {
            JsonArray list = lists.get(li)
                .getAsJsonArray();
            for (int pi = 0; pi < list.size(); pi++) {
                JsonObject part = list.get(pi)
                    .getAsJsonObject();
                expect(checks, part.has("localId"), "part[" + li + ":" + pi + "] 缺 localId");
                expect(checks, part.has("typeKey"), "part[" + li + ":" + pi + "] 缺 typeKey");
                expect(
                    checks,
                    part.has("boxes") && part.getAsJsonArray("boxes")
                        .size() > 0,
                    "part[" + li + ":" + pi + "] 缺 boxes");
                expect(
                    checks,
                    part.has("displayName") && !part.get("displayName")
                        .getAsString()
                        .isEmpty(),
                    "part[" + li + ":" + pi + "] 缺 displayName");
                expect(
                    checks,
                    part.has("tooltip") && part.getAsJsonArray("tooltip")
                        .size() > 0,
                    "part[" + li + ":" + pi + "] 缺 tooltip（§8 任何情况有话说）");
                expect(checks, part.has("items"), "part[" + li + ":" + pi + "] 缺 items");
                JsonObject src = part.has("source") ? part.getAsJsonObject("source") : null;
                expect(
                    checks,
                    src != null && src.has("family")
                        && src.has("fallback")
                        && src.has("boxProvenance")
                        && src.has("tier"),
                    "part[" + li + ":" + pi + "] 来源四元组不齐");
                checked++;
            }
        }
        expect(checks, checked > 0, "partLists 应非空");

        // statsTemplate 默认值（§9，camelCase）
        if (root.has("statsTemplate")) {
            JsonObject st = root.getAsJsonObject("statsTemplate");
            expect(
                checks,
                st.has("mode") && "auto".equals(
                    st.get("mode")
                        .getAsString())
                    && st.has("groups")
                    && st.getAsJsonArray("groups")
                        .size() == 0
                    && st.has("showOthers")
                    && st.get("showOthers")
                        .getAsBoolean(),
                "statsTemplate 应为 {mode:auto,groups:[],showOthers:true}（实际 " + st + "）");
        }

        // partIconTextures 键 = 物品身份键（覆盖 partLists 全部 items）
        if (root.has("partIconTextures")) {
            JsonObject icons = root.getAsJsonObject("partIconTextures");
            int missing = 0;
            for (int li = 0; li < lists.size(); li++) {
                JsonArray list = lists.get(li)
                    .getAsJsonArray();
                for (int pi = 0; pi < list.size(); pi++) {
                    JsonArray items = list.get(pi)
                        .getAsJsonObject()
                        .getAsJsonArray("items");
                    for (int ii = 0; ii < items.size(); ii++) {
                        JsonObject it = items.get(ii)
                            .getAsJsonObject();
                        String key = it.get("registry")
                            .getAsString() + ":"
                            + it.get("damage")
                                .getAsInt()
                            + (it.has("nbtDiscriminator") ? "#" + it.get("nbtDiscriminator")
                                .getAsString() : "");
                        if (!icons.has(key)) {
                            missing++;
                        }
                    }
                }
            }
            expect(checks, missing == 0, "partIconTextures 应覆盖全部物品身份键（缺 " + missing + "）");
        }
    }

    /** 信封透传：payload 解压后四字段俱在（SceneEnvelopeBuilder copyIfPresent）。 */
    private static void checkEnvelope(JsonArray checks, JsonObject rootA) {
        try {
            JsonObject env = SceneEnvelopeBuilder.toEnvelope(rootA);
            String b64 = env.get("payload")
                .getAsString();
            byte[] gz = Base64.getDecoder()
                .decode(b64);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            GZIPInputStream gin = new GZIPInputStream(new ByteArrayInputStream(gz));
            byte[] buf = new byte[8192];
            int n;
            while ((n = gin.read(buf)) != -1) {
                bos.write(buf, 0, n);
            }
            gin.close();
            JsonObject inner = new JsonParser().parse(new String(bos.toByteArray(), StandardCharsets.UTF_8))
                .getAsJsonObject();
            expect(checks, inner.has("cellPartsGrid"), "信封 payload 应有 cellPartsGrid");
            expect(checks, inner.has("partLists"), "信封 payload 应有 partLists");
            expect(checks, inner.has("statsTemplate"), "信封 payload 应有 statsTemplate");
            expect(checks, inner.has("partIconTextures"), "信封 payload 应有 partIconTextures");
        } catch (Throwable t) {
            checks.add(new JsonPrimitive("FAIL: 信封透传校验异常 " + PartsProbeReflect.describe(t)));
        }
    }

    private static void checkColSource(JsonArray checks, JsonArray row, JsonArray lists, int col, String family,
        int tier) {
        int idx = row.get(col)
            .getAsInt();
        expect(checks, idx >= 0, "col" + col + " 应有部件（family=" + family + "）");
        if (idx < 0 || idx >= lists.size()) {
            return;
        }
        JsonArray list = lists.get(idx)
            .getAsJsonArray();
        expect(checks, list.size() > 0, "col" + col + " 部件列表应非空");
        for (int i = 0; i < list.size(); i++) {
            JsonObject part = list.get(i)
                .getAsJsonObject();
            JsonObject src = part.getAsJsonObject("source");
            expect(
                checks,
                family.equals(
                    src.get("family")
                        .getAsString()),
                "col" + col
                    + " part"
                    + i
                    + " family 应为 "
                    + family
                    + "（实际 "
                    + src.get("family")
                        .getAsString()
                    + "）");
            expect(
                checks,
                src.get("tier")
                    .getAsInt() == tier,
                "col" + col + " part" + i + " tier 应为 " + tier);
            expect(
                checks,
                tier == 1 ? !src.get("fallback")
                    .getAsBoolean()
                    : src.get("fallback")
                        .getAsBoolean(),
                "col" + col + " part" + i + " fallback 标记错误");
            expect(
                checks,
                part.get("localId")
                    .getAsString()
                    .startsWith(family + ":"),
                "col" + col
                    + " part"
                    + i
                    + " localId 命名空间应为 "
                    + family
                    + ":（实际 "
                    + part.get("localId")
                        .getAsString()
                    + "）");
        }
    }

    private static JsonObject firstPart(JsonArray row, JsonArray lists, int col) {
        int idx = row.get(col)
            .getAsInt();
        if (idx < 0 || idx >= lists.size()) {
            return null;
        }
        JsonArray list = lists.get(idx)
            .getAsJsonArray();
        if (list.size() == 0) {
            return null;
        }
        return list.get(0)
            .getAsJsonObject();
    }

    // ------------------------------------------------------------------ 小工具

    private static JsonObject excerpt(JsonObject root) {
        JsonObject o = new JsonObject();
        if (root.has("cellPartsGrid")) {
            o.add("cellPartsGrid", root.get("cellPartsGrid"));
        }
        if (root.has("partLists")) {
            o.add("partLists", root.get("partLists"));
        }
        if (root.has("statsTemplate")) {
            o.add("statsTemplate", root.get("statsTemplate"));
        }
        if (root.has("partIconTextures")) {
            JsonArray keys = new JsonArray();
            for (Map.Entry<String, com.google.gson.JsonElement> e : root.getAsJsonObject("partIconTextures")
                .entrySet()) {
                keys.add(new JsonPrimitive(e.getKey()));
            }
            o.add("partIconTextureKeys", keys);
        }
        return o;
    }

    private static PartsProbePlacement.Placed find(List<PartsProbePlacement.Placed> placed, String labelPrefix) {
        for (PartsProbePlacement.Placed p : placed) {
            if (p.label != null && p.label.startsWith(labelPrefix)) {
                return p;
            }
        }
        return null;
    }

    private static PartsProbePlacement.Placed findFamily(List<PartsProbePlacement.Placed> placed, String family) {
        for (PartsProbePlacement.Placed p : placed) {
            if (family.equals(p.family)) {
                return p;
            }
        }
        return null;
    }

    private static void expect(JsonArray checks, boolean ok, String what) {
        checks.add(new JsonPrimitive((ok ? "ok: " : "FAIL: ") + what));
    }

    private static String sha256Hex(byte[] data) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(data);
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) {
                sb.append(String.format("%02x", b & 0xff));
            }
            return sb.toString();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static void writeArtifact(Minecraft mc, String name, byte[] bytes) {
        try {
            Files.write(new File(mc.mcDataDir, name).toPath(), bytes);
        } catch (Throwable t) {
            FMLLog.warning("[SDE][P1.7] 导出产物写出失败 %s: %s", name, String.valueOf(t));
        }
    }
}
