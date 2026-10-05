package com.lightning.mod.client.meshcapture.parts.probe;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.client.Minecraft;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.client.meshcapture.parts.PartBox;
import com.lightning.mod.client.meshcapture.parts.PartCapturePipeline;
import com.lightning.mod.client.meshcapture.parts.PartCaptureResult;
import com.lightning.mod.client.meshcapture.parts.PartItem;
import com.lightning.mod.client.meshcapture.parts.PartProvider;
import com.lightning.mod.client.meshcapture.parts.PartProviderContext;
import com.lightning.mod.client.meshcapture.parts.PartProviderRegistry;
import com.lightning.mod.client.meshcapture.parts.PartRecord;
import com.lightning.mod.client.meshcapture.parts.PartSource;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * P1.3/P1.4/P1.5 三族权威提供者的运行级验证探针（触发文件 {@code "familyProviders":true} 时启用，
 * 默认关闭；启用时 PartsProbeAutomation 追加 FMP 格清场 + AE2 facade 格放置）。
 *
 * <p>
 * 对 P0.2 同款探针结构逐格跑 {@link PartCapturePipeline#collectParts}（已注册三族 tier-1 提供者），
 * 导出的部件清单与历史族 API 探针记录（§1.6/§2.6/§3.6，p02-run-2；原文见 issue #51 / git 历史）
 * 逐格核对 localId / typeKey / 盒 / 物品身份 / 来源四元组：
 *
 * <ol>
 * <li>AE2 3 部件格：ae2:UNKNOWN(:16 'ME Glass Cable - Fluix') / ae2:NORTH(:80) / ae2:UP(:220)，
 * 盒含 p02 实测基准值；</li>
 * <li>AE2 facade 格（本轮新增）：ae2:UNKNOWN + ae2:facade:EAST（facade 物品身份 + 两盒）；</li>
 * <li>EnderIO 5 导管束格：5 个 eio:&lt;接口简单名&gt; 部件，typeKey=EnderIO:item*Conduit:0，
 * boxProvenance=collision-derived-visual，能量导管 1 芯 + 连接段多子盒；</li>
 * <li>FMP slab+panel 格（已清场防跨轮堆积）：fmp:slot0（microblock:4#mat=大理石）+
 * fmp:slot1（microblock:2#mat=玻璃），两盒俱全；</li>
 * <li>合并实验（同格多族合并验证）：在 FMP 格上注册一个探针级 tier-1 提供者（probemerge 前缀），
 * 断言框架合并后 localId 不冲突、两来源部件俱在；另断言各族 applies 互不串格（隔离性）。</li>
 * </ol>
 *
 * <p>
 * 断言失败细节落 {@code cells[].checks[]} / {@code mergeExperiment.checks[]}，聚合 {@code pass}
 * 门控探针退出码（false ⇒ exitCode 2）。
 */
@SideOnly(Side.CLIENT)
final class PartsFamilyProviderProbe {

    private static final double EPS = 1.0E-4;
    /** EnderIO 盒是 float 源，数值点断言用更宽容差。 */
    private static final double EPS_FLOAT = 2.0E-2;

    private PartsFamilyProviderProbe() {}

    /** 合并实验用的探针级 tier-1 提供者：只命中指定格，产出一个 probemerge 前缀部件。 */
    static final class MergeProbeProvider implements PartProvider {

        private final int x;
        private final int y;
        private final int z;

        MergeProbeProvider(int x, int y, int z) {
            this.x = x;
            this.y = y;
            this.z = z;
        }

        @Override
        public int priority() {
            return 50;
        }

        @Override
        public int tier() {
            return PartSource.TIER_FAMILY;
        }

        @Override
        public String family() {
            return "probemerge";
        }

        @Override
        public boolean applies(PartProviderContext ctx) {
            return ctx != null && ctx.x == x && ctx.y == y && ctx.z == z;
        }

        @Override
        public List<PartRecord> collectParts(PartProviderContext ctx) {
            List<PartRecord> out = new ArrayList<PartRecord>();
            PartRecord rec = new PartRecord(
                "probemerge:0",
                "probemerge:test:0",
                new PartSource("probemerge", false, PartSource.PROVENANCE_BOTH, PartSource.TIER_FAMILY));
            rec.boxes.add(new PartBox(0, 0, 0, 1, 1, 1, PartBox.KIND_VISUAL));
            rec.displayName = "Probe Merge Marker";
            rec.tooltip.add(rec.displayName);
            out.add(rec);
            return out;
        }
    }

    static JsonObject run(Minecraft mc, List<PartsProbePlacement.Placed> placed) {
        JsonObject out = new JsonObject();
        out.addProperty("schema", "lightning.parts-family-probe/1");
        out.addProperty("task", "P1.3/P1.4/P1.5 三族权威提供者 运行级验证（对 P0.2 p02-run-2 基准）");
        JsonArray cells = new JsonArray();
        int failedChecks = 0;
        PartsProbePlacement.Placed fmpCell = null;
        PartsProbePlacement.Placed eioBundleCell = null;
        PartsProbePlacement.Placed ae2MainCell = null;
        for (PartsProbePlacement.Placed p : placed) {
            JsonObject cellJson = null;
            if ("ae2".equals(p.family) && p.label.startsWith("cable+toggleBus")) {
                cellJson = checkAe2Main(mc, p);
                ae2MainCell = p;
            } else if ("ae2".equals(p.family) && p.label.startsWith("neighbor-cable")) {
                cellJson = checkAe2Neighbor(mc, p);
            } else if ("ae2".equals(p.family) && p.label.startsWith("cable+facade")) {
                cellJson = checkAe2Facade(mc, p);
            } else if ("enderio".equals(p.family) && p.label.startsWith("bundle-5-conduits")) {
                cellJson = checkEnderIoBundle(mc, p);
                eioBundleCell = p;
            } else if ("enderio".equals(p.family) && p.label.startsWith("neighbor-bundle")) {
                cellJson = checkEnderIoNeighbor(mc, p);
            } else if ("fmp".equals(p.family) && p.label.startsWith("slab(4,0")) {
                cellJson = checkFmp(mc, p);
                fmpCell = p;
            }
            if (cellJson != null) {
                cells.add(cellJson);
                failedChecks += cellJson.get("failedChecks")
                    .getAsInt();
            }
        }
        out.add("cells", cells);

        // 合并实验（同格多族合并验证）+ 隔离性断言
        JsonObject merge = mergeExperiment(mc, fmpCell, ae2MainCell, eioBundleCell);
        out.add("mergeExperiment", merge);
        failedChecks += merge.get("failedChecks")
            .getAsInt();

        boolean pass = failedChecks == 0 && fmpCell != null && eioBundleCell != null && ae2MainCell != null;
        if (fmpCell == null || eioBundleCell == null || ae2MainCell == null) {
            out.addProperty("missingCells", "未找到关键探针格（放置阶段失败？见 placementErrors）");
        }
        out.addProperty("failedChecks", Integer.valueOf(failedChecks));
        out.addProperty("pass", Boolean.valueOf(pass));
        FMLLog.info(
            "[SDE][P1.3-1.5] 族提供者验证探针完成 pass=%s failedChecks=%d",
            Boolean.valueOf(pass),
            Integer.valueOf(failedChecks));
        return out;
    }

    // ------------------------------------------------------------------ 逐格核对

    /** AE2 3 部件格（P0.2 §1.6 基准：线缆 :16 + 切換总线 NORTH :80 + 存储总线 UP :220）。 */
    private static JsonObject checkAe2Main(Minecraft mc, PartsProbePlacement.Placed cell) {
        JsonArray checks = new JsonArray();
        PartCaptureResult r = PartCapturePipeline.collectParts(mc.theWorld, cell.x, cell.y, cell.z);
        expect(checks, !r.hostFullCube, "ae2 主格应判为非满");
        expect(checks, r.tier == PartSource.TIER_FAMILY, "ae2 主格应落档 1");
        expect(checks, r.parts.size() == 3, "ae2 主格应恰 3 部件（实际 " + r.parts.size() + "）");

        PartRecord unknown = findPart(r, "ae2:UNKNOWN");
        PartRecord north = findPart(r, "ae2:NORTH");
        PartRecord up = findPart(r, "ae2:UP");
        expect(checks, unknown != null, "应有 ae2:UNKNOWN（中心线缆）");
        expect(checks, north != null, "应有 ae2:NORTH（切換总线）");
        expect(checks, up != null, "应有 ae2:UP（存储总线）");
        if (unknown != null) {
            expectPartCommon(
                checks,
                "ae2:UNKNOWN",
                unknown,
                "appliedenergistics2:item.ItemMultiPart:16",
                "ME Glass Cable - Fluix");
            // p02 基准：线缆芯盒 [0.375,0.375,0.375 → 0.625,0.625,0.625]（视觉/碰撞同款）
            expectBoxPresent(
                checks,
                "ae2:UNKNOWN",
                unknown,
                PartBox.KIND_VISUAL,
                0.375,
                0.375,
                0.375,
                0.625,
                0.625,
                0.625,
                EPS,
                "芯盒(visual)");
            expectBoxPresent(
                checks,
                "ae2:UNKNOWN",
                unknown,
                PartBox.KIND_COLLISION,
                0.375,
                0.375,
                0.375,
                0.625,
                0.625,
                0.625,
                EPS,
                "芯盒(collision)");
        }
        if (north != null) {
            expectPartCommon(checks, "ae2:NORTH", north, "appliedenergistics2:item.ItemMultiPart:80", "ME Toggle Bus");
            // p02 基准：NORTH 盒 [0.375,0.375,0 → 0.625,0.625,0.3125]
            expectBoxPresent(
                checks,
                "ae2:NORTH",
                north,
                PartBox.KIND_VISUAL,
                0.375,
                0.375,
                0,
                0.625,
                0.625,
                0.3125,
                EPS,
                "视觉盒");
        }
        if (up != null) {
            expectPartCommon(checks, "ae2:UP", up, "appliedenergistics2:item.ItemMultiPart:220", "ME Storage Bus");
            // p02 基准：UP 视觉盒 3 个，首盒 [0.1875,0.9375,0.1875 → 0.8125,1.0,0.8125]
            expectBoxPresent(
                checks,
                "ae2:UP",
                up,
                PartBox.KIND_VISUAL,
                0.1875,
                0.9375,
                0.1875,
                0.8125,
                1.0,
                0.8125,
                EPS,
                "视觉盒(顶面)");
        }
        expectOnlyFamilies(checks, "ae2 主格", r, new String[] { "ae2:" });
        return cellJson(cell, r, checks);
    }

    /** AE2 相邻纯线缆格：至少 ae2:UNKNOWN(:16)。 */
    private static JsonObject checkAe2Neighbor(Minecraft mc, PartsProbePlacement.Placed cell) {
        JsonArray checks = new JsonArray();
        PartCaptureResult r = PartCapturePipeline.collectParts(mc.theWorld, cell.x, cell.y, cell.z);
        expect(checks, !r.hostFullCube, "ae2 邻格应判为非满");
        expect(checks, r.tier == PartSource.TIER_FAMILY, "ae2 邻格应落档 1");
        PartRecord unknown = findPart(r, "ae2:UNKNOWN");
        expect(checks, unknown != null, "ae2 邻格应有 ae2:UNKNOWN");
        if (unknown != null) {
            expect(
                checks,
                "appliedenergistics2:item.ItemMultiPart:16".equals(unknown.typeKey),
                "ae2 邻格线缆 typeKey 应为 :16（实际 " + unknown.typeKey + "）");
        }
        return cellJson(cell, r, checks);
    }

    /** AE2 facade 格（本轮新增场景）：ae2:UNKNOWN + ae2:facade:EAST（facade 另走 IFacadeContainer）。 */
    private static JsonObject checkAe2Facade(Minecraft mc, PartsProbePlacement.Placed cell) {
        JsonArray checks = new JsonArray();
        PartCaptureResult r = PartCapturePipeline.collectParts(mc.theWorld, cell.x, cell.y, cell.z);
        expect(checks, !r.hostFullCube, "facade 格应判为非满");
        expect(checks, r.tier == PartSource.TIER_FAMILY, "facade 格应落档 1");
        expect(checks, r.parts.size() == 2, "facade 格应恰 2 部件（实际 " + r.parts.size() + "）");
        PartRecord unknown = findPart(r, "ae2:UNKNOWN");
        expect(checks, unknown != null, "facade 格应有 ae2:UNKNOWN");
        PartRecord facade = findPart(r, "ae2:facade:EAST");
        expect(checks, facade != null, "facade 格应有 ae2:facade:EAST（IFacadeContainer 环）");
        if (facade != null) {
            expect(
                checks,
                facade.typeKey != null && facade.typeKey.contains("ItemFacade"),
                "facade typeKey 应含 ItemFacade（实际 " + facade.typeKey + "）");
            expect(checks, facade.items.size() == 1, "facade 应恰 1 条物品身份");
            if (facade.items.size() == 1) {
                expect(
                    checks,
                    facade.items.get(0).registry.contains("ItemFacade"),
                    "facade 物品 registry 应含 ItemFacade（实际 " + facade.items.get(0).registry + "）");
            }
            expect(checks, facade.displayName != null && !facade.displayName.isEmpty(), "facade 应有显示名");
            expect(checks, !facade.tooltip.isEmpty(), "facade 应有说明行");
            expect(checks, boxCount(facade, PartBox.KIND_VISUAL) >= 1, "facade 应有视觉盒");
            expect(checks, boxCount(facade, PartBox.KIND_COLLISION) >= 1, "facade 应有碰撞盒");
            expect(
                checks,
                facade.source != null && facade.source.tier == 1
                    && !facade.source.fallback
                    && PartSource.FAMILY_AE2.equals(facade.source.family)
                    && PartSource.PROVENANCE_BOTH.equals(facade.source.boxProvenance),
                "facade 来源四元组应为 ae2/false/both/1");
            // facade 贴东面（x→1），厚度 2px ≈ 0.125（FacadePart#getBoxes: [0,0,14→16,16,15.9]px）
            PartBox vis = firstBox(facade, PartBox.KIND_VISUAL);
            if (vis != null) {
                expect(
                    checks,
                    vis.max[0] >= 0.9 && (vis.max[0] - vis.min[0]) <= 0.2,
                    "facade 视觉盒应贴 EAST 面且薄（实际 " + vis.toJson() + "）");
            }
        }
        return cellJson(cell, r, checks);
    }

    /** EnderIO 5 导管束格（P0.2 §2.6 基准）。 */
    private static JsonObject checkEnderIoBundle(Minecraft mc, PartsProbePlacement.Placed cell) {
        JsonArray checks = new JsonArray();
        PartCaptureResult r = PartCapturePipeline.collectParts(mc.theWorld, cell.x, cell.y, cell.z);
        expect(checks, !r.hostFullCube, "eio 束格应判为非满");
        expect(checks, r.tier == PartSource.TIER_FAMILY, "eio 束格应落档 1");
        expect(checks, r.parts.size() == 5, "eio 束格应恰 5 部件（实际 " + r.parts.size() + "）");

        String[][] expect5 = { { "eio:IPowerConduit", "EnderIO:itemPowerConduit:0", "Energy Conduit" },
            { "eio:IItemConduit", "EnderIO:itemItemConduit:0", "Item Conduit" },
            { "eio:ILiquidConduit", "EnderIO:itemLiquidConduit:0", "Fluid Conduit" },
            { "eio:IRedstoneConduit", "EnderIO:itemRedstoneConduit:0", "Redstone Conduit" },
            { "eio:IMEConduit", "EnderIO:itemMEConduit:0", "ME Conduit" } };
        for (String[] e : expect5) {
            PartRecord p = findPart(r, e[0]);
            expect(checks, p != null, "应有 " + e[0]);
            if (p == null) {
                continue;
            }
            expect(checks, e[1].equals(p.typeKey), e[0] + " typeKey 应为 " + e[1] + "（实际 " + p.typeKey + "）");
            expect(checks, e[2].equals(p.displayName), e[0] + " 显示名应为 " + e[2] + "（实际 " + p.displayName + "）");
            expect(
                checks,
                p.source != null && p.source.tier == 1
                    && !p.source.fallback
                    && PartSource.FAMILY_ENDERIO.equals(p.source.family)
                    && PartSource.PROVENANCE_COLLISION_DERIVED_VISUAL.equals(p.source.boxProvenance),
                e[0] + " 来源四元组应为 eio/false/collision-derived-visual/1");
            expect(checks, p.items.size() == 1, e[0] + " 应恰 1 条物品身份");
            expect(checks, boxCount(p, PartBox.KIND_COLLISION) >= 1, e[0] + " 应有 ≥1 碰撞盒（芯）");
            expect(
                checks,
                boxCount(p, PartBox.KIND_VISUAL) == boxCount(p, PartBox.KIND_COLLISION),
                e[0] + " 视觉盒数应 == 碰撞盒数（单一几何源推导）");
        }
        // 能量导管：1 芯 + 邻格连接段（p02 基准：芯 [0.41,0.23,0.41 → 0.59,0.41,0.59] + EAST 臂）
        PartRecord power = findPart(r, "eio:IPowerConduit");
        if (power != null) {
            expect(
                checks,
                boxCount(power, PartBox.KIND_COLLISION) >= 2,
                "eio:IPowerConduit 应有 ≥2 碰撞盒（芯+连接段，实际 " + boxCount(power, PartBox.KIND_COLLISION) + "）");
            expectBoxPresent(
                checks,
                "eio:IPowerConduit",
                power,
                PartBox.KIND_COLLISION,
                0.41,
                0.23,
                0.41,
                0.59,
                0.41,
                0.59,
                EPS_FLOAT,
                "芯盒");
        }
        // 连接器（conduitType==null）不得成为部件（§5/§2.5）：恰 5 部件即隐含，再显式核对无空物品部件
        for (PartRecord p : r.parts) {
            expect(checks, !p.items.isEmpty(), p.localId + " 应有物品身份（连接器不得发射为部件）");
        }
        expectOnlyFamilies(checks, "eio 束格", r, new String[] { "eio:" });
        return cellJson(cell, r, checks);
    }

    /** EnderIO 相邻束格（power+item）：2 部件。 */
    private static JsonObject checkEnderIoNeighbor(Minecraft mc, PartsProbePlacement.Placed cell) {
        JsonArray checks = new JsonArray();
        PartCaptureResult r = PartCapturePipeline.collectParts(mc.theWorld, cell.x, cell.y, cell.z);
        expect(checks, !r.hostFullCube, "eio 邻格应判为非满");
        expect(checks, r.tier == PartSource.TIER_FAMILY, "eio 邻格应落档 1");
        expect(checks, r.parts.size() == 2, "eio 邻格应恰 2 部件（实际 " + r.parts.size() + "）");
        expect(checks, findPart(r, "eio:IPowerConduit") != null, "eio 邻格应有 eio:IPowerConduit");
        expect(checks, findPart(r, "eio:IItemConduit") != null, "eio 邻格应有 eio:IItemConduit");
        return cellJson(cell, r, checks);
    }

    /** FMP slab+panel 格（P0.2 §3.6 基准；本轮已清场防跨轮堆积）。 */
    private static JsonObject checkFmp(Minecraft mc, PartsProbePlacement.Placed cell) {
        JsonArray checks = new JsonArray();
        PartCaptureResult r = PartCapturePipeline.collectParts(mc.theWorld, cell.x, cell.y, cell.z);
        expect(checks, !r.hostFullCube, "fmp 格应判为非满");
        expect(checks, r.tier == PartSource.TIER_FAMILY, "fmp 格应落档 1");
        expect(checks, r.parts.size() == 2, "fmp 格应恰 2 部件（跨轮堆积应已清场；实际 " + r.parts.size() + "）");

        PartRecord slab = findPart(r, "fmp:slot0");
        PartRecord panel = findPart(r, "fmp:slot1");
        expect(checks, slab != null, "应有 fmp:slot0（底半台阶）");
        expect(checks, panel != null, "应有 fmp:slot1（顶面板）");
        if (slab != null) {
            expect(
                checks,
                "ForgeMicroblock:microblock:4#mat=ProjRed|Exploration:projectred.exploration.stone"
                    .equals(slab.typeKey),
                "fmp:slot0 typeKey 应为 microblock:4#mat=<大理石串>（实际 " + slab.typeKey + "）");
            expect(
                checks,
                "Marble Slab".equals(slab.displayName),
                "fmp:slot0 显示名应为 Marble Slab（实际 " + slab.displayName + "）");
            expect(checks, slab.items.size() >= 1, "fmp:slot0 应 ≥1 条物品身份（getDrops 可多件）");
            if (!slab.items.isEmpty()) {
                expect(
                    checks,
                    slab.items.get(0).registry.equals("ForgeMicroblock:microblock") && slab.items.get(0).damage == 4
                        && "ProjRed|Exploration:projectred.exploration.stone"
                            .equals(slab.items.get(0).nbtDiscriminator),
                    "fmp:slot0 物品身份应为 microblock:4 + mat 串（实际 " + slab.items.get(0)
                        .toJson() + "）");
            }
            expectBoxPresent(checks, "fmp:slot0", slab, PartBox.KIND_VISUAL, 0, 0, 0, 1, 0.5, 1, EPS, "视觉盒");
            expectBoxPresent(checks, "fmp:slot0", slab, PartBox.KIND_COLLISION, 0, 0, 0, 1, 0.5, 1, EPS, "碰撞盒");
            expect(
                checks,
                slab.source != null && slab.source.tier == 1
                    && !slab.source.fallback
                    && PartSource.FAMILY_FMP.equals(slab.source.family)
                    && PartSource.PROVENANCE_BOTH.equals(slab.source.boxProvenance),
                "fmp:slot0 来源四元组应为 fmp/false/both/1");
        }
        if (panel != null) {
            expect(
                checks,
                "ForgeMicroblock:microblock:2#mat=TConstruct:GlassBlock".equals(panel.typeKey),
                "fmp:slot1 typeKey 应为 microblock:2#mat=TConstruct:GlassBlock（实际 " + panel.typeKey + "）");
            expect(
                checks,
                "Clear Glass Panel".equals(panel.displayName),
                "fmp:slot1 显示名应为 Clear Glass Panel（实际 " + panel.displayName + "）");
            expectBoxPresent(checks, "fmp:slot1", panel, PartBox.KIND_VISUAL, 0, 0.75, 0, 1, 1, 1, EPS, "视觉盒");
            expectBoxPresent(checks, "fmp:slot1", panel, PartBox.KIND_COLLISION, 0, 0.75, 0, 1, 1, 1, EPS, "碰撞盒");
        }
        expectOnlyFamilies(checks, "fmp 格", r, new String[] { "fmp:" });
        return cellJson(cell, r, checks);
    }

    // ------------------------------------------------------------------ 合并实验（同格多族合并验证）

    /**
     * 在 FMP 格上注册探针级 tier-1 提供者（probemerge 前缀）后跑流水线：
     * 断言框架合并后 fmp:slot0 / fmp:slot1 / probemerge:0 俱在、localId 无冲突、仍落档 1。
     * 另做隔离性断言：eio 束格 / ae2 主格不被其他族串入（命名空间隔离，§4）。
     *
     * <p>
     * 注（契约缺口登记）：GTNH 中三族 tile 互斥寄宿——EnderIO 束经 Immibis 微方块共存（本族范围外）、
     * AE2 线缆总线可被 FMP 转换为 CableBusPart（此时格属 fmp 族）。真实「同格两族」在三族间不存在，
     * 故此实验用「真实 fmp 提供者 + 探针提供者」验证框架合并语义本身。
     */
    private static JsonObject mergeExperiment(Minecraft mc, PartsProbePlacement.Placed fmpCell,
        PartsProbePlacement.Placed ae2MainCell, PartsProbePlacement.Placed eioBundleCell) {
        JsonObject out = new JsonObject();
        out.addProperty("suite", "mergeExperiment");
        JsonArray checks = new JsonArray();
        int failedChecks = 0;

        if (fmpCell == null) {
            checks.add(new JsonPrimitive("FAIL: 未找到 fmp 格，合并实验跳过"));
        } else {
            MergeProbeProvider probe = new MergeProbeProvider(fmpCell.x, fmpCell.y, fmpCell.z);
            PartProviderRegistry.register(probe);
            PartCaptureResult r;
            try {
                r = PartCapturePipeline.collectParts(mc.theWorld, fmpCell.x, fmpCell.y, fmpCell.z);
            } finally {
                PartProviderRegistry.unregister(probe);
            }
            out.add("result", r.toJson());
            expect(checks, r.tier == PartSource.TIER_FAMILY, "合并格应落档 1");
            expect(checks, findPart(r, "fmp:slot0") != null, "合并后应有 fmp:slot0（真实 fmp 提供者）");
            expect(checks, findPart(r, "fmp:slot1") != null, "合并后应有 fmp:slot1（真实 fmp 提供者）");
            expect(checks, findPart(r, "probemerge:0") != null, "合并后应有 probemerge:0（探针提供者）");
            expect(checks, r.parts.size() == 3, "合并格应恰 3 部件（实际 " + r.parts.size() + "）");
            // localId 命名空间隔离 ⇒ 不冲突（§4）
            List<String> ids = new ArrayList<String>();
            boolean distinct = true;
            for (PartRecord p : r.parts) {
                if (ids.contains(p.localId)) {
                    distinct = false;
                }
                ids.add(p.localId);
            }
            expect(checks, distinct, "合并后 localId 应全部不冲突（" + ids + "）");
            expect(checks, r.providerFailures.isEmpty(), "合并格不应有提供者失败");
        }
        // 隔离性：真实三族格互不串族
        if (ae2MainCell != null) {
            PartCaptureResult r = PartCapturePipeline
                .collectParts(mc.theWorld, ae2MainCell.x, ae2MainCell.y, ae2MainCell.z);
            expectOnlyFamilies(checks, "隔离性-ae2 主格", r, new String[] { "ae2:" });
        }
        if (eioBundleCell != null) {
            PartCaptureResult r = PartCapturePipeline
                .collectParts(mc.theWorld, eioBundleCell.x, eioBundleCell.y, eioBundleCell.z);
            expectOnlyFamilies(checks, "隔离性-eio 束格", r, new String[] { "eio:" });
        }

        out.add("checks", checks);
        for (int i = 0; i < checks.size(); i++) {
            if (checks.get(i)
                .getAsString()
                .startsWith("FAIL")) {
                failedChecks++;
            }
        }
        out.addProperty("failedChecks", Integer.valueOf(failedChecks));
        out.addProperty("pass", Boolean.valueOf(failedChecks == 0));
        return out;
    }

    // ------------------------------------------------------------------ 断言小工具

    private static JsonObject cellJson(PartsProbePlacement.Placed cell, PartCaptureResult r, JsonArray checks) {
        JsonObject o = new JsonObject();
        o.addProperty("label", cell.label);
        JsonArray pos = new JsonArray();
        pos.add(new JsonPrimitive(Integer.valueOf(cell.x)));
        pos.add(new JsonPrimitive(Integer.valueOf(cell.y)));
        pos.add(new JsonPrimitive(Integer.valueOf(cell.z)));
        o.add("pos", pos);
        o.add("result", r.toJson());
        o.add("checks", checks);
        int fails = 0;
        for (int i = 0; i < checks.size(); i++) {
            if (checks.get(i)
                .getAsString()
                .startsWith("FAIL")) {
                fails++;
            }
        }
        o.addProperty("failedChecks", Integer.valueOf(fails));
        o.addProperty("pass", Boolean.valueOf(fails == 0));
        return o;
    }

    private static PartRecord findPart(PartCaptureResult r, String localId) {
        for (PartRecord p : r.parts) {
            if (localId.equals(p.localId)) {
                return p;
            }
        }
        return null;
    }

    /** AE2 部件五要素 + 来源四元组公共核对。 */
    private static void expectPartCommon(JsonArray checks, String id, PartRecord p, String typeKey, String display) {
        expect(checks, typeKey.equals(p.typeKey), id + " typeKey 应为 " + typeKey + "（实际 " + p.typeKey + "）");
        expect(checks, display.equals(p.displayName), id + " 显示名应为 " + display + "（实际 " + p.displayName + "）");
        expect(
            checks,
            p.source != null && p.source.tier == 1
                && !p.source.fallback
                && PartSource.FAMILY_AE2.equals(p.source.family)
                && PartSource.PROVENANCE_BOTH.equals(p.source.boxProvenance),
            id + " 来源四元组应为 ae2/false/both/1");
        expect(checks, p.items.size() == 1, id + " 应恰 1 条物品身份");
        if (p.items.size() == 1) {
            PartItem it = p.items.get(0);
            expect(
                checks,
                typeKey.equals(it.registry + ":" + it.damage),
                id + " 物品身份应与 typeKey 一致（实际 " + it.toJson() + "）");
        }
        expect(checks, boxCount(p, PartBox.KIND_VISUAL) >= 1, id + " 应有 ≥1 视觉盒");
        expect(checks, boxCount(p, PartBox.KIND_COLLISION) >= 1, id + " 应有 ≥1 碰撞盒");
        expect(checks, !p.tooltip.isEmpty(), id + " 应有说明行");
    }

    private static void expectOnlyFamilies(JsonArray checks, String label, PartCaptureResult r, String[] prefixes) {
        for (PartRecord p : r.parts) {
            boolean ok = false;
            for (String prefix : prefixes) {
                if (p.localId.startsWith(prefix)) {
                    ok = true;
                }
            }
            expect(checks, ok, label + " 部件 localId 应属命名空间 " + String.join("|", prefixes) + "（实际 " + p.localId + "）");
        }
    }

    private static int boxCount(PartRecord p, String kind) {
        int n = 0;
        for (PartBox b : p.boxes) {
            if (kind.equals(b.kind)) {
                n++;
            }
        }
        return n;
    }

    private static PartBox firstBox(PartRecord p, String kind) {
        for (PartBox b : p.boxes) {
            if (kind.equals(b.kind)) {
                return b;
            }
        }
        return null;
    }

    private static void expectBoxPresent(JsonArray checks, String id, PartRecord p, String kind, double minX,
        double minY, double minZ, double maxX, double maxY, double maxZ, double eps, String what) {
        PartBox want = new PartBox(minX, minY, minZ, maxX, maxY, maxZ, kind);
        boolean found = false;
        for (PartBox b : p.boxes) {
            if (kind.equals(b.kind) && b.equalsBox(want, eps)) {
                found = true;
                break;
            }
        }
        checks.add(
            new JsonPrimitive(
                (found ? "ok: " : "FAIL: ") + id
                    + " 应含 "
                    + what
                    + " ["
                    + minX
                    + ","
                    + minY
                    + ","
                    + minZ
                    + " → "
                    + maxX
                    + ","
                    + maxY
                    + ","
                    + maxZ
                    + "]("
                    + kind
                    + ")"));
    }

    private static void expect(JsonArray checks, boolean ok, String what) {
        checks.add(new JsonPrimitive((ok ? "ok: " : "FAIL: ") + what));
    }
}
