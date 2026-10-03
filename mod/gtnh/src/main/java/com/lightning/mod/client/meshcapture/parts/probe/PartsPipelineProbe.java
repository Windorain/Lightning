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
import com.lightning.mod.client.meshcapture.parts.PartProvider;
import com.lightning.mod.client.meshcapture.parts.PartProviderContext;
import com.lightning.mod.client.meshcapture.parts.PartProviderRegistry;
import com.lightning.mod.client.meshcapture.parts.PartRecord;
import com.lightning.mod.client.meshcapture.parts.PartSource;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * P1.1/P1.2 部件提供者框架 + 单盒通用提供者的运行级验证探针（触发文件
 * {@code "partsPipeline":true} 时启用，默认关闭；启用时隐含 {@code singleBox} 放置）。
 *
 * <p>
 * 对 P0.3 的 11 个单盒场景格跑 {@link PartCapturePipeline#collectParts}，三组实验：
 * <ol>
 * <li><strong>expA 空注册表</strong>：{@link PartProviderRegistry#snapshotAndClearForProbe} 清空后
 * 逐格跑流水线——期望：石头快速否定、其余格零产出零失败（与无框架行为一致），事后恢复；</li>
 * <li><strong>expB 必抛异常的假提供者</strong>：注册 {@link ThrowingFakeProvider}（tier-1、恒命中、
 * 恒抛）后逐格跑流水线——期望：流程照常完成、档 2 结果与 expC 一致、每格 providerFailures 有记录
 * （容错非摆设），事后注销；</li>
 * <li><strong>expC 正常注册表（P1.2 基准）</strong>：逐格核对盒数值 / typeKey / localId / 来源四元组
 * 与 {@code docs/plan/probe-single-box.md} §2.3 实测基准一致；火把 ×2 ⇒ 档 2 不产出（§7.3 退化），
 * 落档 3 几何推断（P1.6 已实现 ⇒ inferred 部件，盒数值容差断言由 PartsInferredTier3Probe 案 a 承担）。</li>
 * </ol>
 *
 * <p>
 * 断言失败的细节落 {@code checks[]}，聚合 {@code pass} 门控探针退出码（false ⇒ exitCode 2）。
 */
@SideOnly(Side.CLIENT)
final class PartsPipelineProbe {

    private static final double EPS = 1.0E-4;

    private PartsPipelineProbe() {}

    /** P1.1 自检 b：必抛异常的假提供者（tier-1、恒命中、恒抛——容错注入）。 */
    static final class ThrowingFakeProvider implements PartProvider {

        @Override
        public int priority() {
            return 100;
        }

        @Override
        public int tier() {
            return PartSource.TIER_FAMILY;
        }

        @Override
        public String family() {
            return "probe-bomb";
        }

        @Override
        public boolean applies(PartProviderContext ctx) {
            return true;
        }

        @Override
        public List<PartRecord> collectParts(PartProviderContext ctx) {
            throw new RuntimeException("P1.1 probe-injected provider failure (expected; tolerance test)");
        }
    }

    static JsonObject runExperiments(Minecraft mc, List<PartsProbePlacement.Placed> placed) {
        JsonObject out = new JsonObject();
        out.addProperty("schema", "lightning.parts-pipeline-probe/1");
        out.addProperty("task", "P1.1 提供者框架 + P1.2 单盒通用提供者 运行级自检");
        List<PartsProbePlacement.Placed> cells = new ArrayList<PartsProbePlacement.Placed>();
        for (PartsProbePlacement.Placed p : placed) {
            if ("singlebox".equals(p.family)) {
                cells.add(p);
            }
        }

        // expA：空提供者注册 ⇒ 行为与无框架一致
        List<PartProvider> snapshot = PartProviderRegistry.snapshotAndClearForProbe();
        JsonObject expA;
        try {
            expA = runSuite(mc, cells, "expA-emptyRegistry", false, true);
        } finally {
            PartProviderRegistry.restoreForProbe(snapshot);
        }
        out.add("expA-emptyRegistry", expA);

        // expB：必抛异常的假提供者 ⇒ 流程照常完成且失败有记录
        ThrowingFakeProvider bomb = new ThrowingFakeProvider();
        PartProviderRegistry.register(bomb);
        JsonObject expB;
        try {
            expB = runSuite(mc, cells, "expB-throwingProvider", true, false);
        } finally {
            PartProviderRegistry.unregister(bomb);
        }
        out.add("expB-throwingProvider", expB);

        // expC：正常注册表 ⇒ P0.3 §2.3 数值基准逐格核对
        JsonObject expC = runSuite(mc, cells, "expC-genericBaseline", false, false);
        out.add("expC-genericBaseline", expC);

        boolean pass = expA.get("pass")
            .getAsBoolean()
            && expB.get("pass")
                .getAsBoolean()
            && expC.get("pass")
                .getAsBoolean();
        out.addProperty("pass", Boolean.valueOf(pass));
        FMLLog.info(
            "[SDE][P1.1] 部件流水线探针完成 pass=%s (expA=%s expB=%s expC=%s)",
            Boolean.valueOf(pass),
            expA.get("pass"),
            expB.get("pass"),
            expC.get("pass"));
        return out;
    }

    private static JsonObject runSuite(Minecraft mc, List<PartsProbePlacement.Placed> cells, String name,
        boolean requireFailurePerNonFullCell, boolean expectEmptyEverywhere) {
        JsonObject suite = new JsonObject();
        suite.addProperty("suite", name);
        JsonArray arr = new JsonArray();
        int failedChecks = 0;
        for (PartsProbePlacement.Placed cell : cells) {
            PartCaptureResult r = PartCapturePipeline.collectParts(mc.theWorld, cell.x, cell.y, cell.z);
            JsonObject cellJson = new JsonObject();
            cellJson.addProperty("label", cell.label);
            JsonArray pos = new JsonArray();
            pos.add(new JsonPrimitive(Integer.valueOf(cell.x)));
            pos.add(new JsonPrimitive(Integer.valueOf(cell.y)));
            pos.add(new JsonPrimitive(Integer.valueOf(cell.z)));
            cellJson.add("pos", pos);
            cellJson.add("result", r.toJson());

            JsonArray checks = new JsonArray();
            if (expectEmptyEverywhere) {
                checkEmptyRegistryCell(checks, cell.label, r);
            } else {
                checkBaselineCell(checks, cell.label, r);
                if (requireFailurePerNonFullCell) {
                    if (!r.hostFullCube && r.providerFailures.isEmpty()) {
                        checks.add(new JsonPrimitive("FAIL: 非满格应有注入提供者的失败记录（容错留痕）"));
                    }
                    if (r.hostFullCube && !r.providerFailures.isEmpty()) {
                        checks.add(new JsonPrimitive("FAIL: 满方块格不应触发任何提供者"));
                    }
                }
            }
            cellJson.add("checks", checks);
            int fails = 0;
            for (int i = 0; i < checks.size(); i++) {
                if (checks.get(i)
                    .getAsString()
                    .startsWith("FAIL")) {
                    fails++;
                }
            }
            cellJson.addProperty("pass", Boolean.valueOf(fails == 0));
            failedChecks += fails;
            arr.add(cellJson);
        }
        suite.add("cells", arr);
        suite.addProperty("failedChecks", Integer.valueOf(failedChecks));
        suite.addProperty("pass", Boolean.valueOf(failedChecks == 0));
        return suite;
    }

    // ------------------------------------------------------------------ expA 期望

    /** 空注册表：石头快速否定；其余格零产出、零失败（与无框架行为一致）。 */
    private static void checkEmptyRegistryCell(JsonArray checks, String label, PartCaptureResult r) {
        if (label.startsWith("stone-control")) {
            expect(checks, r.hostFullCube, "stone 应快速否定为满方块");
            expect(checks, r.parts.isEmpty(), "stone 应零部件");
        } else {
            expect(checks, !r.hostFullCube, label + " 应判为非满");
            expect(checks, r.parts.isEmpty(), label + " 空注册表应零产出");
            expect(checks, r.tier == 0, label + " 空注册表档位应为 0");
        }
        expect(checks, r.providerFailures.isEmpty(), label + " 空注册表不应有提供者失败");
    }

    // ------------------------------------------------------------------ expC 期望（P0.3 §2.3 基准）

    private static void checkBaselineCell(JsonArray checks, String label, PartCaptureResult r) {
        if (label.startsWith("stone-control")) {
            expect(checks, r.hostFullCube, "stone 应快速否定为满方块（零开销路径）");
            expect(checks, r.parts.isEmpty(), "stone 应零部件");
            return;
        }
        expect(checks, !r.hostFullCube, label + " 应判为非满");

        if (label.startsWith("torch-")) {
            // 火把退化（§7.3）：档 2 不产出，落档 3 几何推断（P1.6 已实现 ⇒ inferred 部件永远有结果；
            // 盒数值与 properties.facing 的容差断言见 PartsInferredTier3Probe 案 a）
            expect(checks, r.tier == PartSource.TIER_INFERRED, label + " 火把应落档 3（P1.6 几何推断）");
            expect(checks, !r.parts.isEmpty(), label + " 火把档 3 应永远有结果");
            for (PartRecord part : r.parts) {
                expect(
                    checks,
                    part.source != null && PartSource.FAMILY_INFERRED.equals(part.source.family),
                    label + " 部件 family 应为 inferred");
                expect(
                    checks,
                    part.source != null && part.source.fallback && part.source.tier == PartSource.TIER_INFERRED,
                    label + " 部件应为 fallback=true / tier=3");
            }
            return;
        }

        // 其余格：档 2 单盒通用提供者产出恰 1 个部件
        expect(checks, r.tier == PartSource.TIER_GENERIC, label + " 应落档 2");
        expect(checks, r.parts.size() == 1, label + " 应恰 1 个部件（generic:0）");
        if (r.parts.size() != 1) {
            return;
        }
        PartRecord p = r.parts.get(0);
        expect(checks, "generic:0".equals(p.localId), label + " localId 应为 generic:0");
        expect(
            checks,
            p.source != null && PartSource.FAMILY_GENERIC.equals(p.source.family),
            label + " source.family 应为 generic");
        expect(checks, p.source != null && p.source.fallback, label + " source.fallback 应为 true");
        expect(checks, p.source != null && p.source.tier == PartSource.TIER_GENERIC, label + " source.tier 应为 2");
        expect(
            checks,
            p.source != null && PartSource.PROVENANCE_BOTH.equals(p.source.boxProvenance),
            label + " source.boxProvenance 应为 both");
        expect(checks, p.displayName != null && !p.displayName.isEmpty(), label + " 应有显示名");
        expect(checks, !p.tooltip.isEmpty(), label + " 应有说明行");
        expect(checks, p.items.size() == 1, label + " 应恰 1 条物品身份");
        if (p.items.size() == 1) {
            expect(checks, p.items.get(0).count == 1, label + " 物品 count 应为 1");
        }

        if (label.startsWith("slab-bottom")) {
            expectTypeKey(checks, label, p, "minecraft:stone_slab:0");
            expectBox(checks, label, visual(p), 0, 0, 0, 1, 0.5, 1, "视觉盒");
            expect(checks, collisionCount(p) == 1, label + " 碰撞盒应为 1 个");
            expectBox(checks, label, collision(p, 0), 0, 0, 0, 1, 0.5, 1, "碰撞盒[0]");
        } else if (label.startsWith("slab-top")) {
            expectTypeKey(checks, label, p, "minecraft:stone_slab:0");
            expectBox(checks, label, visual(p), 0, 0.5, 0, 1, 1, 1, "视觉盒");
            expect(checks, collisionCount(p) == 1, label + " 碰撞盒应为 1 个");
            expectBox(checks, label, collision(p, 0), 0, 0.5, 0, 1, 1, 1, "碰撞盒[0]");
        } else if (label.startsWith("fence-isolated")) {
            expectTypeKey(checks, label, p, "minecraft:fence:0");
            expectBox(checks, label, visual(p), 0.375, 0, 0.375, 0.625, 1, 0.625, "视觉盒");
            expect(checks, collisionCount(p) == 1, label + " 碰撞多盒应为 1 个");
            expectBox(checks, label, collision(p, 0), 0.375, 0, 0.375, 0.625, 1.5, 0.625, "碰撞盒[0](1.5 越界)");
        } else if (label.startsWith("fence-ew-connected")) {
            expectTypeKey(checks, label, p, "minecraft:fence:0");
            expectBox(checks, label, visual(p), 0, 0, 0.375, 1, 1, 0.625, "视觉盒");
            expect(checks, collisionCount(p) == 1, label + " 碰撞多盒应为 1 个");
            expectBox(checks, label, collision(p, 0), 0, 0, 0.375, 1, 1.5, 0.625, "碰撞盒[0](1.5 越界)");
        } else if (label.startsWith("fence-plus-connected")) {
            expectTypeKey(checks, label, p, "minecraft:fence:0");
            expectBox(checks, label, visual(p), 0, 0, 0, 1, 1, 1, "视觉盒(整格)");
            expect(checks, collisionCount(p) == 2, label + " 碰撞多盒应为 2 根杆");
        } else if (label.startsWith("chest-single")) {
            expectTypeKey(checks, label, p, "minecraft:chest:0");
            expectBox(checks, label, visual(p), 0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375, "视觉盒");
            expect(checks, collisionCount(p) == 1, label + " 碰撞盒应为 1 个");
            expectBox(checks, label, collision(p, 0), 0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375, "碰撞盒[0]");
        } else if (label.startsWith("chest-double-west")) {
            expectTypeKey(checks, label, p, "minecraft:chest:0");
            expectBox(checks, label, visual(p), 0.0625, 0, 0.0625, 1, 0.875, 0.9375, "视觉盒(双箱西)");
        } else if (label.startsWith("chest-double-east")) {
            expectTypeKey(checks, label, p, "minecraft:chest:0");
            expectBox(checks, label, visual(p), 0, 0, 0.0625, 0.9375, 0.875, 0.9375, "视觉盒(双箱东)");
        }
    }

    // ------------------------------------------------------------------ 断言小工具

    private static void expect(JsonArray checks, boolean ok, String what) {
        checks.add(new JsonPrimitive((ok ? "ok: " : "FAIL: ") + what));
    }

    private static void expectTypeKey(JsonArray checks, String label, PartRecord p, String typeKey) {
        expect(checks, typeKey.equals(p.typeKey), label + " typeKey 应为 " + typeKey + "（实际 " + p.typeKey + "）");
    }

    private static PartBox visual(PartRecord p) {
        for (PartBox b : p.boxes) {
            if (PartBox.KIND_VISUAL.equals(b.kind)) {
                return b;
            }
        }
        return null;
    }

    private static int collisionCount(PartRecord p) {
        int n = 0;
        for (PartBox b : p.boxes) {
            if (PartBox.KIND_COLLISION.equals(b.kind)) {
                n++;
            }
        }
        return n;
    }

    private static PartBox collision(PartRecord p, int index) {
        int n = 0;
        for (PartBox b : p.boxes) {
            if (PartBox.KIND_COLLISION.equals(b.kind)) {
                if (n == index) {
                    return b;
                }
                n++;
            }
        }
        return null;
    }

    private static void expectBox(JsonArray checks, String label, PartBox actual, double minX, double minY, double minZ,
        double maxX, double maxY, double maxZ, String what) {
        if (actual == null) {
            checks.add(new JsonPrimitive("FAIL: " + label + " " + what + " 缺失"));
            return;
        }
        PartBox want = new PartBox(minX, minY, minZ, maxX, maxY, maxZ, actual.kind);
        boolean ok = actual.equalsBox(want, EPS);
        checks.add(
            new JsonPrimitive(
                (ok ? "ok: " : "FAIL: ") + label
                    + " "
                    + what
                    + (ok ? ""
                        : (" 期望 [" + minX
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
                            + "] 实际 "
                            + actual.toJson()))));
    }
}
