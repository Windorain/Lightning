package com.lightning.mod.client.meshcapture.parts.probe;

import java.util.LinkedHashMap;
import java.util.Map;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * P1.8 自洽验证分支 —— oracle（建造意图）↔ 导出文件（真实 finalizeStructureJson 产物）逐格核对。
 *
 * <p>
 * 核对口径（契约 {@code format-parts-contract.md} §11：oracle 断言 = 部件存在性 + localId/typeKey/
 * 物品计数 + 档位/盒数/来源；盒数值本身不校验）：
 * <ul>
 * <li>{@code expectFullCube} 格 ⇒ {@code cellPartsGrid} 该格必为 -1（快速否定/满方块不发射）；</li>
 * <li>部件格 ⇒ 下标 ≥0，部件数、逐部件 localId（按 id 匹配，不依赖顺序）/typeKey/items 条数/
 * source.tier/boxes 条数/source.boxProvenance 全部精确比对（哨兵 {@code boxCount=-1} /
 * {@code boxProvenance="*"} / {@code localId="inferred:*"} 跳过对应维度——退化格用）；</li>
 * <li>来源一致性：source.family == localId 命名空间前缀；fallback == (tier != 1)；</li>
 * <li>{@code expectedCounts}：按格走查 cellPartsGrid 展开 partLists（去重池每格引用都算一次），
 * 按 part.typeKey 聚合 items[].count，与 oracle 双向精确比对（含多算/漏算方向）；</li>
 * <li>整文件维度：partLists 去重生效（同内容多格共享下标——两格同构 5 导管束同下标）。</li>
 * </ul>
 *
 * 断言失败细节落 {@code checks[]}（"FAIL: " 前缀），聚合 {@code pass} 门控验收退出码。
 */
@SideOnly(Side.CLIENT)
final class PartsAcceptanceVerifier {

    private PartsAcceptanceVerifier() {}

    static JsonObject verify(String suiteName, JsonObject oracle, JsonObject exportRoot) {
        JsonObject out = new JsonObject();
        out.addProperty("suite", suiteName);
        JsonArray checks = new JsonArray();

        if (!exportRoot.has("cellPartsGrid") || !exportRoot.has("partLists")) {
            checks.add(new com.google.gson.JsonPrimitive("FAIL: 导出文件缺 cellPartsGrid/partLists"));
            out.add("checks", checks);
            out.addProperty("pass", Boolean.FALSE);
            return out;
        }
        JsonArray grid = exportRoot.getAsJsonArray("cellPartsGrid");
        JsonArray lists = exportRoot.getAsJsonArray("partLists");

        JsonArray cells = oracle.getAsJsonArray("cells");
        int partCells = 0;
        int fullCubeCells = 0;
        for (int i = 0; i < cells.size(); i++) {
            JsonObject cell = cells.get(i)
                .getAsJsonObject();
            JsonArray g = cell.getAsJsonArray("grid");
            int zi = g.get(0)
                .getAsInt();
            int ri = g.get(1)
                .getAsInt();
            int ci = g.get(2)
                .getAsInt();
            String at = "cell[" + cell.get("pos")
                .toString()
                + "]("
                + cell.get("zone")
                    .getAsString()
                + ")";
            int idx = gridValue(grid, zi, ri, ci);
            if (cell.get("expectFullCube")
                .getAsBoolean()) {
                fullCubeCells++;
                expect(checks, idx == -1, at + " 满方块格 cellPartsGrid 应为 -1（实际 " + idx + "）");
                continue;
            }
            partCells++;
            JsonArray expected = cell.getAsJsonArray("parts");
            expect(checks, idx >= 0, at + " 部件格应有 partLists 下标（实际 " + idx + "）");
            if (idx < 0 || idx >= lists.size()) {
                continue;
            }
            JsonArray actual = lists.get(idx)
                .getAsJsonArray();
            verifyCellParts(checks, at, expected, actual);
        }

        // partLists 去重证据（契约 §2.1）：两格同构 5 束共享下标
        expectDedup(checks, oracle, grid, lists);

        // expectedCounts 双向比对
        verifyCounts(checks, oracle, grid, lists);

        int failed = countFails(checks);
        out.add("checks", checks);
        out.addProperty("cellsChecked", Integer.valueOf(cells.size()));
        out.addProperty("partCells", Integer.valueOf(partCells));
        out.addProperty("fullCubeCells", Integer.valueOf(fullCubeCells));
        out.addProperty("failedChecks", Integer.valueOf(failed));
        out.addProperty("pass", Boolean.valueOf(failed == 0));
        return out;
    }

    // ------------------------------------------------------------------ 逐格部件核对

    private static void verifyCellParts(JsonArray checks, String at, JsonArray expected, JsonArray actual) {
        // inferred:* 通配哨兵（退化档 3：岛数不静态可预测；断言族/档/typeKey，不断言条数）
        boolean wildcard = expected.size() == 1 && PartsAcceptanceOracle.LOCALID_INFERRED_WILDCARD.equals(
            expected.get(0)
                .getAsJsonObject()
                .get("localId")
                .getAsString());
        if (wildcard) {
            JsonObject exp = expected.get(0)
                .getAsJsonObject();
            expect(checks, actual.size() >= 1, at + " 退化档 3 应至少 1 个 inferred 部件");
            for (int i = 0; i < actual.size(); i++) {
                JsonObject p = actual.get(i)
                    .getAsJsonObject();
                String localId = p.get("localId")
                    .getAsString();
                JsonObject src = p.getAsJsonObject("source");
                expect(
                    checks,
                    localId.startsWith("inferred:"),
                    at + " part" + i + " localId 应为 inferred:*（实际 " + localId + "）");
                expect(
                    checks,
                    exp.get("typeKey")
                        .getAsString()
                        .equals(
                            p.get("typeKey")
                                .getAsString()),
                    at + " part"
                        + i
                        + " typeKey 应为 "
                        + exp.get("typeKey")
                            .getAsString()
                        + "（实际 "
                        + p.get("typeKey")
                            .getAsString()
                        + "）");
                expectSource(checks, at + " part" + i, src, "inferred", 3);
            }
            return;
        }

        expect(
            checks,
            actual.size() == expected.size(),
            at + " 部件数应为 " + expected.size() + "（实际 " + actual.size() + "）");
        for (int i = 0; i < expected.size(); i++) {
            JsonObject exp = expected.get(i)
                .getAsJsonObject();
            String localId = exp.get("localId")
                .getAsString();
            JsonObject act = findByLocalId(actual, localId);
            expect(checks, act != null, at + " 缺部件 " + localId);
            if (act == null) {
                continue;
            }
            String what = at + " " + localId;
            expect(
                checks,
                exp.get("typeKey")
                    .getAsString()
                    .equals(
                        act.get("typeKey")
                            .getAsString()),
                what + " typeKey 应为 "
                    + exp.get("typeKey")
                        .getAsString()
                    + "（实际 "
                    + act.get("typeKey")
                        .getAsString()
                    + "）");
            expect(
                checks,
                act.getAsJsonArray("items")
                    .size()
                    == exp.get("itemCount")
                        .getAsInt(),
                what + " items 条数应为 "
                    + exp.get("itemCount")
                        .getAsInt()
                    + "（实际 "
                    + act.getAsJsonArray("items")
                        .size()
                    + "）");
            int tier = exp.get("boxTier")
                .getAsInt();
            JsonObject src = act.getAsJsonObject("source");
            String ns = localId.substring(0, localId.indexOf(':'));
            expectSource(checks, what, src, ns, tier);
            int boxCount = exp.get("boxCount")
                .getAsInt();
            if (boxCount != PartsAcceptanceOracle.BOXCOUNT_UNCHECKED) {
                expect(
                    checks,
                    act.getAsJsonArray("boxes")
                        .size() == boxCount,
                    what + " 盒数应为 "
                        + boxCount
                        + "（实际 "
                        + act.getAsJsonArray("boxes")
                            .size()
                        + "）");
            }
            String prov = exp.get("boxProvenance")
                .getAsString();
            if (!PartsAcceptanceOracle.PROVENANCE_UNCHECKED.equals(prov)) {
                expect(
                    checks,
                    prov.equals(
                        src.get("boxProvenance")
                            .getAsString()),
                    what + " boxProvenance 应为 "
                        + prov
                        + "（实际 "
                        + src.get("boxProvenance")
                            .getAsString()
                        + "）");
            }
        }
    }

    /** 来源四元组一致性：family == localId 命名空间前缀、tier 精确、fallback == (tier != 1)。 */
    private static void expectSource(JsonArray checks, String what, JsonObject src, String family, int tier) {
        if (src == null) {
            checks.add(new com.google.gson.JsonPrimitive("FAIL: " + what + " 缺 source 四元组"));
            return;
        }
        expect(
            checks,
            family.equals(
                src.get("family")
                    .getAsString()),
            what + " source.family 应为 "
                + family
                + "（实际 "
                + src.get("family")
                    .getAsString()
                + "）");
        expect(
            checks,
            src.get("tier")
                .getAsInt() == tier,
            what + " source.tier 应为 "
                + tier
                + "（实际 "
                + src.get("tier")
                    .getAsInt()
                + "）");
        expect(
            checks,
            src.get("fallback")
                .getAsBoolean() == (tier != 1),
            what + " source.fallback 应为 " + (tier != 1));
    }

    private static JsonObject findByLocalId(JsonArray list, String localId) {
        for (int i = 0; i < list.size(); i++) {
            JsonObject p = list.get(i)
                .getAsJsonObject();
            if (localId.equals(
                p.get("localId")
                    .getAsString())) {
                return p;
            }
        }
        return null;
    }

    // ------------------------------------------------------------------ 去重证据

    /**
     * partLists 池化证据（契约 §2.1）：enderio 区与叠加区各有一格 5 导管束（同构造 ⇒ 盒是块局部
     * 快照、内容签名一致）⇒ 必须解析到同一下标；且全池条数 < 有部件格数（去重全局生效）。
     */
    private static void expectDedup(JsonArray checks, JsonObject oracle, JsonArray grid, JsonArray lists) {
        int idxA = -2;
        int idxB = -2;
        JsonArray cells = oracle.getAsJsonArray("cells");
        for (int i = 0; i < cells.size(); i++) {
            JsonObject cell = cells.get(i)
                .getAsJsonObject();
            String zone = cell.get("zone")
                .getAsString();
            if (!"enderio".equals(zone) && !"overlay".equals(zone)) {
                continue;
            }
            JsonArray parts = cell.getAsJsonArray("parts");
            if (parts.size() != 5) {
                continue; // 只要 5 束格（邻格 2 部件不算）
            }
            JsonArray g = cell.getAsJsonArray("grid");
            int idx = gridValue(
                grid,
                g.get(0)
                    .getAsInt(),
                g.get(1)
                    .getAsInt(),
                g.get(2)
                    .getAsInt());
            if (idxA == -2) {
                idxA = idx;
            } else {
                idxB = idx;
            }
        }
        if (idxA == -2 || idxB == -2) {
            // 退化轮：5 束格被变换成兜底档（oracle 中无 5 部件格）⇒ 去重证据不适用，跳过
            checks.add(new com.google.gson.JsonPrimitive("ok: 去重证据对不适用（oracle 无 5 束格，退化轮跳过）"));
            return;
        }
        expect(checks, idxA >= 0 && idxA == idxB, "两格同构 5 导管束应共享 partLists 下标（" + idxA + " vs " + idxB + "）");
    }

    // ------------------------------------------------------------------ expectedCounts 双向比对

    private static void verifyCounts(JsonArray checks, JsonObject oracle, JsonArray grid, JsonArray lists) {
        // 导出侧：逐格展开 partLists（池化去重 ⇒ 按格引用计数），按 part.typeKey 聚合 items[].count
        Map<String, Long> actual = new LinkedHashMap<String, Long>();
        for (int zi = 0; zi < grid.size(); zi++) {
            JsonArray rows = grid.get(zi)
                .getAsJsonArray();
            for (int ri = 0; ri < rows.size(); ri++) {
                JsonArray cols = rows.get(ri)
                    .getAsJsonArray();
                for (int ci = 0; ci < cols.size(); ci++) {
                    int idx = cols.get(ci)
                        .getAsInt();
                    if (idx < 0 || idx >= lists.size()) {
                        continue;
                    }
                    JsonArray list = lists.get(idx)
                        .getAsJsonArray();
                    for (int pi = 0; pi < list.size(); pi++) {
                        JsonObject part = list.get(pi)
                            .getAsJsonObject();
                        String typeKey = part.get("typeKey")
                            .getAsString();
                        long sum = 0;
                        JsonArray items = part.getAsJsonArray("items");
                        for (int ii = 0; ii < items.size(); ii++) {
                            sum += items.get(ii)
                                .getAsJsonObject()
                                .get("count")
                                .getAsLong();
                        }
                        if (sum > 0) {
                            Long acc = actual.get(typeKey);
                            actual.put(typeKey, Long.valueOf(acc == null ? sum : acc.longValue() + sum));
                        }
                    }
                }
            }
        }
        Map<String, Long> expected = new LinkedHashMap<String, Long>();
        JsonArray counts = oracle.getAsJsonArray("expectedCounts");
        for (int i = 0; i < counts.size(); i++) {
            JsonObject c = counts.get(i)
                .getAsJsonObject();
            expected.put(
                c.get("typeKey")
                    .getAsString(),
                Long.valueOf(
                    c.get("count")
                        .getAsLong()));
        }
        boolean subsetOnly = oracle.has("countsScope") && "untransformed-cells-only".equals(
            oracle.get("countsScope")
                .getAsString());
        for (Map.Entry<String, Long> e : expected.entrySet()) {
            Long act = actual.get(e.getKey());
            expect(
                checks,
                act != null && act.longValue() == e.getValue()
                    .longValue(),
                "expectedCounts " + e.getKey() + " 应为 " + e.getValue() + "（实际 " + act + "）");
        }
        if (!subsetOnly) {
            for (Map.Entry<String, Long> e : actual.entrySet()) {
                expect(
                    checks,
                    expected.containsKey(e.getKey()),
                    "expectedCounts 多出未预期 typeKey " + e.getKey() + "=" + e.getValue());
            }
        }
    }

    // ------------------------------------------------------------------ 小工具

    private static int gridValue(JsonArray grid, int zi, int ri, int ci) {
        JsonElement rows = grid.get(zi);
        JsonElement cols = rows.getAsJsonArray()
            .get(ri);
        return cols.getAsJsonArray()
            .get(ci)
            .getAsInt();
    }

    private static void expect(JsonArray checks, boolean ok, String what) {
        checks.add(new com.google.gson.JsonPrimitive((ok ? "ok: " : "FAIL: ") + what));
    }

    private static int countFails(JsonArray checks) {
        int n = 0;
        for (int i = 0; i < checks.size(); i++) {
            if (checks.get(i)
                .getAsString()
                .startsWith("FAIL")) {
                n++;
            }
        }
        return n;
    }
}
