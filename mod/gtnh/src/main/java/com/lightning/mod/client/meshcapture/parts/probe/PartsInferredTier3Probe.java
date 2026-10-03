package com.lightning.mod.client.meshcapture.parts.probe;

import java.util.Collections;
import java.util.List;

import net.minecraft.client.Minecraft;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad;
import com.lightning.mod.client.meshcapture.parts.PartBox;
import com.lightning.mod.client.meshcapture.parts.PartCapturePipeline;
import com.lightning.mod.client.meshcapture.parts.PartCaptureResult;
import com.lightning.mod.client.meshcapture.parts.PartRecord;
import com.lightning.mod.client.meshcapture.parts.PartSource;
import com.lightning.mod.client.meshcapture.parts.inferred.CellQuadBaker;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * P1.6 几何推断兜底（档 3，{@code InferredGeometryPartProvider}）的运行级验证探针
 * （触发文件 {@code "inferredTier3":true} 时启用，默认关闭；启用时隐含 {@code singleBox} 放置）。
 *
 * <p>
 * 验收三案（任务书 P1.6 验证要求）：
 * <ol>
 * <li><strong>案 a</strong>：火把（地面 meta5 + 挂墙 meta1）⇒ 档 3 产出 inferred 部件，
 * 全岛盒并集 ≈ 小柱（地面 ≈ [0.4,0,0.4→0.6,0.6,0.6] 量级，容差判定），来源标记
 * {@code family=inferred / fallback=true / tier=3 / boxProvenance=visual-only}，
 * 挂墙朝向进 {@code properties.facing=meta<N>}；</li>
 * <li><strong>案 b</strong>：档 1/档 2 有结果的格（AE2 格 / EnderIO 束 / FMP 格 / slab/栅栏/箱）
 * ⇒ <strong>绝不出现 inferred 部件</strong>（推断永不当主来源，§7.2）；</li>
 * <li><strong>案 c</strong>：无几何可得（注入空四边形快照）⇒ 整格 {@code degenerate} 盒兜底
 * （档 3 永远有结果，§7.1）。</li>
 * </ol>
 *
 * <p>
 * 断言失败的细节落 {@code checks[]}，聚合 {@code pass} 门控探针退出码（false ⇒ exitCode 2）。
 */
@SideOnly(Side.CLIENT)
final class PartsInferredTier3Probe {

    private PartsInferredTier3Probe() {}

    static JsonObject run(Minecraft mc, List<PartsProbePlacement.Placed> placed) {
        JsonObject out = new JsonObject();
        out.addProperty("schema", "lightning.parts-inferred-tier3-probe/1");
        out.addProperty("task", "P1.6 几何推断兜底（档 3）运行级验证 a/b/c");
        JsonArray cells = new JsonArray();
        int failed = 0;
        PartsProbePlacement.Placed torchFloor = null;
        for (PartsProbePlacement.Placed p : placed) {
            if (p.label != null && p.label.startsWith("torch-floor")) {
                torchFloor = p;
            }
            JsonObject cell = probeCell(mc, p);
            cells.add(cell);
            if (!cell.get("pass")
                .getAsBoolean()) {
                failed++;
            }
        }
        out.add("cells", cells);

        // 案 c：无几何可得 ⇒ 整格 degenerate 盒兜底（注入空四边形快照模拟"连可用几何都没有"）
        JsonObject deg = probeDegenerate(mc, torchFloor);
        out.add("degenerateNoGeometry", deg);
        if (!deg.get("pass")
            .getAsBoolean()) {
            failed++;
        }

        out.addProperty("pass", Boolean.valueOf(failed == 0));
        FMLLog.info(
            "[SDE][P1.6] 档 3 几何推断探针完成 pass=%s failedCells=%d",
            Boolean.valueOf(failed == 0),
            Integer.valueOf(failed));
        return out;
    }

    // ------------------------------------------------------------------ 逐格（案 a/b）

    private static JsonObject probeCell(Minecraft mc, PartsProbePlacement.Placed p) {
        JsonObject cell = new JsonObject();
        cell.addProperty("label", p.label);
        JsonArray pos = new JsonArray();
        pos.add(new JsonPrimitive(Integer.valueOf(p.x)));
        pos.add(new JsonPrimitive(Integer.valueOf(p.y)));
        pos.add(new JsonPrimitive(Integer.valueOf(p.z)));
        cell.add("pos", pos);

        // bakedQuads = null ⇒ 档 3 由 CellQuadBaker 现场烘焙（探针无捕获产物路径）
        PartCaptureResult r = PartCapturePipeline.collectParts(mc.theWorld, p.x, p.y, p.z);
        cell.add("result", r.toJson());

        // 火把格：附带原始烘焙四边形顶点 dump（档 3 岛扩组输入的诊断证据）
        // + 直渲染对照组（绕过 renderBlockByRenderType 调度层，定位捕获链扭曲注入点）
        List<CapturedQuad> rawQuads = null;
        if (p.label != null && p.label.startsWith("torch-")) {
            rawQuads = bakeQuads(mc, p);
            cell.add("rawQuads", dumpQuads(rawQuads));
            cell.add("directTorchQuads", dumpQuads(directTorchQuads(mc, p)));
        }

        JsonArray checks = new JsonArray();
        if (p.label != null && p.label.startsWith("stone-control")) {
            expect(checks, r.hostFullCube, "stone 应快速否定为满方块");
            expect(checks, r.parts.isEmpty(), "stone 应零部件");
        } else if (p.label != null && p.label.startsWith("torch-")) {
            checkTorch(checks, p.label, r, rawQuads);
        } else if ("ae2".equals(p.family) || "enderio".equals(p.family) || "fmp".equals(p.family)) {
            // 案 b（档 1）：族权威格 ⇒ tier 1 且绝无 inferred
            expect(checks, !r.hostFullCube, p.label + " 应判为非满");
            expect(checks, !r.parts.isEmpty(), p.label + " 档 1 应有部件产出");
            expect(checks, r.tier == PartSource.TIER_FAMILY, p.label + " 应落档 1（实际 tier=" + r.tier + "）");
            expectNoInferred(checks, p.label, r);
        } else {
            // 案 b（档 2）：slab/栅栏/箱 ⇒ tier 2 且绝无 inferred
            expect(checks, !r.hostFullCube, p.label + " 应判为非满");
            expect(checks, !r.parts.isEmpty(), p.label + " 档 2 应有部件产出");
            expect(checks, r.tier == PartSource.TIER_GENERIC, p.label + " 应落档 2（实际 tier=" + r.tier + "）");
            expectNoInferred(checks, p.label, r);
        }
        cell.add("checks", checks);
        cell.addProperty("pass", Boolean.valueOf(!hasFail(checks)));
        return cell;
    }

    /**
     * 案 a：火把 ⇒ 档 3 inferred 部件 + 朝向进 properties + <strong>alpha 收紧后的视觉真实盒</strong>。
     *
     * <p>
     * 两组断言：① 盒形状 = 细柱（原版火把侧立面是撑满整格的 alpha 斜面，p16 实证——
     * {@code AlphaTightener} 收紧到可见纹素区域后才是契约 §7.3 的"真实小柱几何"；1.7.10 火把
     * 图标只有棍身纹素，火焰是粒子 ⇒ 视觉真实盒 = 棍柱，高 ≈0.625）；② 单向忠实度：岛盒并集
     * ⊆ 原始烘焙四边形并集外扩 ±0.05（收紧只能缩小、不得超出原始几何超过厚度）。
     */
    private static void checkTorch(JsonArray checks, String label, PartCaptureResult r, List<CapturedQuad> rawQuads) {
        boolean wall = label.startsWith("torch-wall");
        expect(checks, !r.hostFullCube, label + " 应判为非满");
        expect(checks, r.tier == PartSource.TIER_INFERRED, label + " 应落档 3（实际 tier=" + r.tier + "）");
        expect(checks, !r.parts.isEmpty(), label + " 档 3 应有部件产出");
        if (r.parts.isEmpty()) {
            return;
        }
        String wantFacing = wall ? "meta1" : "meta5";

        double minX = Double.POSITIVE_INFINITY, minY = Double.POSITIVE_INFINITY, minZ = Double.POSITIVE_INFINITY;
        double maxX = Double.NEGATIVE_INFINITY, maxY = Double.NEGATIVE_INFINITY, maxZ = Double.NEGATIVE_INFINITY;
        boolean sawFacing = false;
        for (PartRecord part : r.parts) {
            expect(
                checks,
                part.source != null && PartSource.FAMILY_INFERRED.equals(part.source.family),
                label + " source.family 应为 inferred");
            expect(checks, part.source != null && part.source.fallback, label + " source.fallback 应为 true");
            expect(
                checks,
                part.source != null && part.source.tier == PartSource.TIER_INFERRED,
                label + " source.tier 应为 3");
            expect(
                checks,
                part.source != null && PartSource.PROVENANCE_VISUAL_ONLY.equals(part.source.boxProvenance),
                label + " boxProvenance 应为 visual-only（实际 "
                    + (part.source == null ? "null" : part.source.boxProvenance)
                    + "）");
            expect(
                checks,
                part.localId != null && part.localId.startsWith("inferred:"),
                label + " localId 应为 inferred:<岛序号>（实际 " + part.localId + "）");
            expect(
                checks,
                "minecraft:torch:0".equals(part.typeKey),
                label + " typeKey 应为 minecraft:torch:0（实际 " + part.typeKey + "）");
            expect(checks, part.displayName != null && !part.displayName.isEmpty(), label + " 应有显示名");
            expect(checks, !part.tooltip.isEmpty(), label + " 应有说明行");
            expect(checks, part.items.size() == 1, label + " 应恰 1 条物品身份（drop 身份）");
            expect(checks, !part.boxes.isEmpty(), label + " 应有盒");
            if (wantFacing.equals(part.properties.get("facing"))) {
                sawFacing = true;
            }
            for (PartBox b : part.boxes) {
                minX = Math.min(minX, b.min[0]);
                minY = Math.min(minY, b.min[1]);
                minZ = Math.min(minZ, b.min[2]);
                maxX = Math.max(maxX, b.max[0]);
                maxY = Math.max(maxY, b.max[1]);
                maxZ = Math.max(maxZ, b.max[2]);
            }
        }
        expect(checks, sawFacing, label + " properties 应有 facing=" + wantFacing + "（§7.3 挂墙朝向）");

        // 盒形状：alpha 收紧后的"视觉真实盒"（原版火把侧立面 = 撑满整格的 alpha 斜面，
        // 收紧 ⇒ 细柱；1.7.10 火把图标只有棍身纹素 ⇒ 高 ≈0.625。契约 §7.3 的"真实小柱几何"即此语义）
        String union = "[" + r3(
            minX) + "," + r3(minY) + "," + r3(minZ) + " → " + r3(maxX) + "," + r3(maxY) + "," + r3(maxZ) + "]";
        if (wall) {
            boolean touchesWall = minX < 0.3 || maxX > 0.7 || minZ < 0.3 || maxZ > 0.7;
            expect(checks, touchesWall, label + " 挂墙盒并集应贴墙面（实际并集 " + union + "）");
            double thinXZ = Math.min(maxX - minX, maxZ - minZ);
            expect(checks, thinXZ <= 0.45, label + " 挂墙盒水平至少一轴应为细柱（实际并集 " + union + "）");
            expect(checks, minY >= 0.0 && minY <= 0.4, label + " 挂墙盒 minY 应在柱底邻域（实际 " + union + "）");
            expect(checks, maxY >= 0.7 && maxY <= 1.0, label + " 挂墙盒 maxY 应为斜柱高（实际 " + union + "）");
        } else {
            expect(checks, minX >= 0.25 && maxX <= 0.75, label + " 地面火把并集 X 应在中心柱范围（实际 " + union + "）");
            expect(checks, minZ >= 0.25 && maxZ <= 0.75, label + " 地面火把并集 Z 应在中心柱范围（实际 " + union + "）");
            expect(
                checks,
                (maxX - minX) <= 0.35 && (maxZ - minZ) <= 0.35,
                label + " 地面火把并集应为细柱（alpha 收紧生效；实际 " + union + "）");
            expect(checks, minY >= -0.1 && minY <= 0.15, label + " 并集 minY 应≈0（实际 " + union + "）");
            expect(checks, maxY >= 0.5 && maxY <= 0.9, label + " 并集 maxY 应为小柱高（实际 " + union + "）");
        }

        // 忠实度（单向）：岛盒并集 ⊆ 原始烘焙四边形并集外扩 ±0.05（ensureMinThickness）——
        // 收紧只能缩小盒，任何方向都不得超出原始几何超过厚度
        if (rawQuads != null && !rawQuads.isEmpty()) {
            double[] rawMin = { Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY };
            double[] rawMax = { Double.NEGATIVE_INFINITY, Double.NEGATIVE_INFINITY, Double.NEGATIVE_INFINITY };
            for (CapturedQuad q : rawQuads) {
                for (com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedVertex v : q.vertices) {
                    if (v.x < rawMin[0]) rawMin[0] = v.x;
                    if (v.y < rawMin[1]) rawMin[1] = v.y;
                    if (v.z < rawMin[2]) rawMin[2] = v.z;
                    if (v.x > rawMax[0]) rawMax[0] = v.x;
                    if (v.y > rawMax[1]) rawMax[1] = v.y;
                    if (v.z > rawMax[2]) rawMax[2] = v.z;
                }
            }
            double[] islMin = { minX, minY, minZ };
            double[] islMax = { maxX, maxY, maxZ };
            double tol = 0.051;
            for (int a = 0; a < 3; a++) {
                expect(
                    checks,
                    islMin[a] >= rawMin[a] - tol,
                    label + " 岛盒并集 min[" + a + "] 不得小于原始几何超过厚度（raw " + r3(rawMin[a]) + " vs 岛 " + r3(islMin[a]) + "）");
                expect(
                    checks,
                    islMax[a] <= rawMax[a] + tol,
                    label + " 岛盒并集 max[" + a + "] 不得大于原始几何超过厚度（raw " + r3(rawMax[a]) + " vs 岛 " + r3(islMax[a]) + "）");
            }
        } else {
            expect(checks, false, label + " 原始烘焙四边形为空，无法做忠实度断言");
        }
    }

    /** 案 b 通用断言：结果中绝不出现 inferred 部件（推断永不当主来源，§7.2）。 */
    private static void expectNoInferred(JsonArray checks, String label, PartCaptureResult r) {
        int inferred = 0;
        for (PartRecord part : r.parts) {
            if (part.source != null && PartSource.FAMILY_INFERRED.equals(part.source.family)) {
                inferred++;
            }
        }
        expect(checks, inferred == 0, label + " 绝不出现 inferred 部件（实际 " + inferred + " 个）");
    }

    // ------------------------------------------------------------------ 案 c：无几何退化兜底

    private static JsonObject probeDegenerate(Minecraft mc, PartsProbePlacement.Placed torchFloor) {
        JsonObject deg = new JsonObject();
        deg.addProperty("case", "c-no-geometry");
        JsonArray checks = new JsonArray();
        if (torchFloor == null) {
            expect(checks, false, "缺少 torch-floor 放置格，无法执行退化案");
        } else {
            deg.addProperty("label", torchFloor.label);
            // 空四边形快照 ⇒ 档 3 无任何可用几何 ⇒ 整格 degenerate 盒兜底（永远有结果，§7.1）
            PartCaptureResult r = PartCapturePipeline.collectParts(
                mc.theWorld,
                torchFloor.x,
                torchFloor.y,
                torchFloor.z,
                Collections.<CapturedQuad>emptyList());
            deg.add("result", r.toJson());
            expect(checks, r.tier == PartSource.TIER_INFERRED, "退化案应落档 3（实际 tier=" + r.tier + "）");
            expect(checks, r.parts.size() == 1, "退化案应恰 1 个部件（实际 " + r.parts.size() + "）");
            if (r.parts.size() == 1) {
                PartRecord part = r.parts.get(0);
                expect(
                    checks,
                    part.source != null && PartSource.FAMILY_INFERRED.equals(part.source.family),
                    "退化案 family 应为 inferred");
                expect(
                    checks,
                    part.source != null && PartSource.PROVENANCE_DEGENERATE.equals(part.source.boxProvenance),
                    "退化案 boxProvenance 应为 degenerate（实际 " + (part.source == null ? "null" : part.source.boxProvenance)
                        + "）");
                expect(checks, "inferred:0".equals(part.localId), "退化案 localId 应为 inferred:0（实际 " + part.localId + "）");
                expect(checks, part.boxes.size() == 1, "退化案应恰 1 个盒");
                if (part.boxes.size() == 1) {
                    PartBox b = part.boxes.get(0);
                    boolean full = Math.abs(b.min[0]) < 1.0E-4 && Math.abs(b.min[1]) < 1.0E-4
                        && Math.abs(b.min[2]) < 1.0E-4
                        && Math.abs(b.max[0] - 1.0) < 1.0E-4
                        && Math.abs(b.max[1] - 1.0) < 1.0E-4
                        && Math.abs(b.max[2] - 1.0) < 1.0E-4;
                    expect(checks, full, "退化案盒应为整格 [0,0,0 → 1,1,1]（实际 " + b.toJson() + "）");
                }
                expect(checks, !part.items.isEmpty(), "退化案仍应有物品身份（宿主 drop 身份）");
            }
        }
        deg.add("checks", checks);
        deg.addProperty("pass", Boolean.valueOf(!hasFail(checks)));
        return deg;
    }

    // ------------------------------------------------------------------ 小工具

    /** 火把格原始烘焙四边形（经 CellQuadBaker 探针通道，与档 3 内部烘焙同一链）。 */
    private static List<CapturedQuad> bakeQuads(Minecraft mc, PartsProbePlacement.Placed p) {
        net.minecraft.block.Block b = mc.theWorld.getBlock(p.x, p.y, p.z);
        int meta = mc.theWorld.getBlockMetadata(p.x, p.y, p.z);
        return CellQuadBaker.bakeForProbe(mc.theWorld, p.x, p.y, p.z, b, meta);
    }

    /** 直渲染对照组：绕过 renderBlockByRenderType 调度层直接 renderBlockTorch。 */
    private static List<CapturedQuad> directTorchQuads(Minecraft mc, PartsProbePlacement.Placed p) {
        net.minecraft.block.Block b = mc.theWorld.getBlock(p.x, p.y, p.z);
        int meta = mc.theWorld.getBlockMetadata(p.x, p.y, p.z);
        return CellQuadBaker.bakeTorchDirectForProbe(mc.theWorld, p.x, p.y, p.z, b, meta);
    }

    /** 四边形顶点 dump（诊断岛扩组输入）。 */
    private static JsonArray dumpQuads(List<CapturedQuad> quads) {
        JsonArray arr = new JsonArray();
        for (int qi = 0; qi < quads.size(); qi++) {
            CapturedQuad q = quads.get(qi);
            JsonObject qj = new JsonObject();
            qj.addProperty("quad", Integer.valueOf(qi));
            JsonArray vs = new JsonArray();
            for (com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedVertex v : q.vertices) {
                JsonArray one = new JsonArray();
                one.add(new JsonPrimitive(Double.valueOf(r6(v.x))));
                one.add(new JsonPrimitive(Double.valueOf(r6(v.y))));
                one.add(new JsonPrimitive(Double.valueOf(r6(v.z))));
                vs.add(one);
            }
            qj.add("verts", vs);
            arr.add(qj);
        }
        return arr;
    }

    private static double r6(double d) {
        return Math.round(d * 1000000.0) / 1000000.0;
    }

    private static void expect(JsonArray checks, boolean ok, String what) {
        checks.add(new JsonPrimitive((ok ? "ok: " : "FAIL: ") + what));
    }

    private static boolean hasFail(JsonArray checks) {
        for (int i = 0; i < checks.size(); i++) {
            if (checks.get(i)
                .getAsString()
                .startsWith("FAIL")) {
                return true;
            }
        }
        return false;
    }

    private static String r3(double d) {
        return String.format(java.util.Locale.ROOT, "%.3f", Double.valueOf(d));
    }
}
