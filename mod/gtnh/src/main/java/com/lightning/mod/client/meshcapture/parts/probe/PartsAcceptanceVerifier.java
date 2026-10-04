package com.lightning.mod.client.meshcapture.parts.probe;

import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

import net.minecraft.block.Block;
import net.minecraft.item.Item;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

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

        // 契约 §2.2 扩展（#39 阶段一）：物品索引表 + 宿主级物品身份
        verifyItemIndex(checks, oracle, exportRoot);
        verifyHostItems(checks, oracle, exportRoot);

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

    // ------------------------------------------------------------------ 契约 §2.2：物品索引表

    /**
     * 物品索引表核对（契约 §2.2；口径与脚本侧 `verifyItemIndex` 同源、独立实现）：
     * 文件自洽（display 非空 / 说明行非空 / `source` = 首条归属来源 / 归属按权威度分组且不重复）
     * + oracle 逐键比对（键集、display、source、归属逐条；`inferred:*` 通配；退化轮多出的归属
     * 只允许落在 oracle 哨兵格）。
     */
    private static void verifyItemIndex(JsonArray checks, JsonObject oracle, JsonObject exportRoot) {
        JsonObject expected = oracle.has("itemIndex") && oracle.get("itemIndex")
            .isJsonObject() ? oracle.getAsJsonObject("itemIndex") : null;
        JsonObject actual = exportRoot.has("itemIndex") && exportRoot.get("itemIndex")
            .isJsonObject() ? exportRoot.getAsJsonObject("itemIndex") : null;
        String scope = oracle.has("itemIndexScope") ? oracle.get("itemIndexScope")
            .getAsString() : "exact";
        boolean subset = "untransformed-cells-only".equals(scope);
        if (expected == null) {
            checks.add(new JsonPrimitive("FAIL: oracle 缺 itemIndex 期望（契约 §2.2 扩展；#39 阶段一）"));
            return;
        }
        if (actual == null) {
            checks.add(new JsonPrimitive("FAIL: 导出文件缺 itemIndex（含部件文档必须落盘，契约 §2.2）"));
            return;
        }
        Set<String> sentinels = sentinelGrids(oracle);

        // 键集：exact 双向精确；退化轮在册键必在（变换格多出放行）
        for (String key : expected.keySet()) {
            expect(checks, actual.has(key), "itemIndex 缺期望键 " + key);
        }
        if (!subset) {
            for (String key : actual.keySet()) {
                expect(checks, expected.has(key), "itemIndex 多出未登记键 " + key);
            }
        }

        // A. 文件自洽
        for (Map.Entry<String, JsonElement> en : actual.entrySet()) {
            String at = "itemIndex[" + en.getKey() + "]";
            JsonObject e = en.getValue()
                .isJsonObject()
                    ? en.getValue()
                        .getAsJsonObject()
                    : null;
            if (e == null) {
                checks.add(new JsonPrimitive("FAIL: " + at + " 必须是对象"));
                continue;
            }
            expect(
                checks,
                e.has("display") && e.get("display")
                    .isJsonPrimitive()
                    && e.get("display")
                        .getAsString()
                        .length() > 0,
                at + " display 必须为非空字符串（缺省兜底 = 键本身）");
            expect(
                checks,
                e.has("tooltip") && e.get("tooltip")
                    .isJsonArray()
                    && e.getAsJsonArray("tooltip")
                        .size() > 0,
                at + " tooltip 必须非空（空值语义：至少 display 一行）");
            JsonArray attrs = e.has("attribution") && e.get("attribution")
                .isJsonArray() ? e.getAsJsonArray("attribution") : null;
            if (attrs == null) {
                checks.add(new JsonPrimitive("FAIL: " + at + " attribution 必须是数组（空数组 = 显式\"无对应\"）"));
                continue;
            }
            String wantSource = attrs.size() == 0 ? "none"
                : attrs.get(0)
                    .getAsJsonObject()
                    .get("source")
                    .getAsString();
            expect(
                checks,
                e.has("source") && wantSource.equals(
                    e.get("source")
                        .getAsString()),
                at + " source 必须 = attribution 首条来源（期望 " + wantSource + "）");
            int prevRank = -1;
            boolean orderOk = true;
            Set<String> seen = new HashSet<String>();
            for (int i = 0; i < attrs.size(); i++) {
                JsonObject a = attrs.get(i)
                    .getAsJsonObject();
                String aat = at + ".attribution[" + i + "]";
                String src = a.has("source") ? a.get("source")
                    .getAsString() : "";
                expect(
                    checks,
                    "part".equals(src) || "host".equals(src) || "family".equals(src),
                    aat + " source 非法：" + src);
                expect(
                    checks,
                    a.has("frame") && a.get("frame")
                        .getAsInt() >= 0,
                    aat + " frame 必须为非负整数");
                expect(
                    checks,
                    a.has("grid") && a.get("grid")
                        .isJsonArray()
                        && a.getAsJsonArray("grid")
                            .size() == 3,
                    aat + " grid 必须是长度 3 的整数数组（[zSlice,row,column]）");
                if ("part".equals(src)) {
                    expect(
                        checks,
                        a.has("localId") && a.get("localId")
                            .getAsString()
                            .length() > 0,
                        aat + " source=part 必须带 localId（部件级定位）");
                }
                int rank = "part".equals(src) ? 0 : ("host".equals(src) ? 1 : ("family".equals(src) ? 2 : -1));
                if (rank >= 0) {
                    if (rank < prevRank) {
                        orderOk = false;
                    }
                    prevRank = Math.max(prevRank, rank);
                }
                String id = attrKey(a);
                expect(checks, seen.add(id), aat + " 归属重复（" + id + "）");
            }
            expect(checks, orderOk, at + " attribution 必须按来源权威度分组（part → host → family）");
        }

        // B. oracle 逐键比对
        for (Map.Entry<String, JsonElement> en : expected.entrySet()) {
            String key = en.getKey();
            String at = "itemIndex[" + key + "]";
            if (!actual.has(key)) {
                continue;
            }
            JsonObject exp = en.getValue()
                .getAsJsonObject();
            JsonObject act = actual.getAsJsonObject(key);
            boolean displayChecked = !exp.has("displayChecked") || exp.get("displayChecked")
                .getAsBoolean();
            if (displayChecked) {
                String want = exp.has("display") && exp.get("display")
                    .isJsonPrimitive() ? exp.get("display")
                        .getAsString() : null;
                String got = act.has("display") ? act.get("display")
                    .getAsString() : null;
                expect(checks, want != null && want.equals(got), at + " display 应为 " + want + "（实际 " + got + "）");
            }
            String wantSource = exp.has("source") ? exp.get("source")
                .getAsString() : "part";
            expect(
                checks,
                act.has("source") && wantSource.equals(
                    act.get("source")
                        .getAsString()),
                at + " source 应为 " + wantSource);
            JsonArray attrs = act.has("attribution") && act.get("attribution")
                .isJsonArray() ? act.getAsJsonArray("attribution") : new JsonArray();
            boolean[] used = new boolean[attrs.size()];
            JsonArray wantAttrs = exp.has("attribution") && exp.get("attribution")
                .isJsonArray() ? exp.getAsJsonArray("attribution") : new JsonArray();
            for (int i = 0; i < wantAttrs.size(); i++) {
                JsonObject want = wantAttrs.get(i)
                    .getAsJsonObject();
                boolean wildcard = want.has("localId") && PartsAcceptanceOracle.LOCALID_INFERRED_WILDCARD.equals(
                    want.get("localId")
                        .getAsString());
                if (wildcard) {
                    boolean hit = false;
                    for (int j = 0; j < attrs.size(); j++) {
                        if (matchesWildcard(
                            attrs.get(j)
                                .getAsJsonObject(),
                            want)) {
                            hit = true;
                            break;
                        }
                    }
                    expect(
                        checks,
                        hit,
                        at + " 期望格 "
                            + want.get("grid")
                            + " 至少一条 inferred:* 的 "
                            + want.get("source")
                            + " 归属（退化档岛序号不可预测）");
                    continue;
                }
                int idx = -1;
                for (int j = 0; j < attrs.size(); j++) {
                    if (!used[j] && sameAttribution(
                        attrs.get(j)
                            .getAsJsonObject(),
                        want)) {
                        idx = j;
                        break;
                    }
                }
                expect(checks, idx >= 0, at + " 缺期望归属 " + want);
                if (idx >= 0) {
                    used[idx] = true;
                }
            }
            for (int j = 0; j < attrs.size(); j++) {
                if (used[j]) {
                    continue;
                }
                JsonObject a = attrs.get(j)
                    .getAsJsonObject();
                JsonArray g = a.getAsJsonArray("grid");
                String gk = g.get(0) + "," + g.get(1) + "," + g.get(2);
                if (subset && sentinels.contains(gk)) {
                    checks.add(new JsonPrimitive("ok: " + at + " 多出变换格归属 " + attrKey(a) + "（退化轮口径放行）"));
                } else {
                    checks.add(new JsonPrimitive("FAIL: " + at + " 多出未登记归属 " + attrKey(a)));
                }
            }
        }
    }

    /** 归属条目身份（与脚本侧 `attrKey` 同口径）。 */
    private static String attrKey(JsonObject a) {
        JsonArray g = a.getAsJsonArray("grid");
        return (a.has("source") ? a.get("source")
            .getAsString() : "") + '|'
            + (a.has("frame") ? a.get("frame")
                .getAsInt() : -1)
            + '|'
            + g.get(0)
            + ","
            + g.get(1)
            + ","
            + g.get(2)
            + '|'
            + (a.has("localId") ? a.get("localId")
                .getAsString() : "");
    }

    private static boolean sameAttribution(JsonObject got, JsonObject want) {
        if (!sameGrid(got, want)) {
            return false;
        }
        if (!str(got, "source").equals(str(want, "source"))) {
            return false;
        }
        if (got.has("frame") && got.get("frame")
            .getAsInt()
            != want.get("frame")
                .getAsInt()) {
            return false;
        }
        return str(got, "localId").equals(str(want, "localId"));
    }

    private static boolean matchesWildcard(JsonObject got, JsonObject want) {
        if (!sameGrid(got, want) || !str(got, "source").equals(str(want, "source"))) {
            return false;
        }
        return got.has("frame") && want.has("frame")
            && got.get("frame")
                .getAsInt()
                == want.get("frame")
                    .getAsInt()
            && str(got, "localId").startsWith("inferred:");
    }

    private static boolean sameGrid(JsonObject a, JsonObject b) {
        JsonArray ga = a.has("grid") && a.get("grid")
            .isJsonArray() ? a.getAsJsonArray("grid") : null;
        JsonArray gb = b.has("grid") && b.get("grid")
            .isJsonArray() ? b.getAsJsonArray("grid") : null;
        if (ga == null || gb == null || ga.size() != 3 || gb.size() != 3) {
            return false;
        }
        for (int i = 0; i < 3; i++) {
            if (ga.get(i)
                .getAsInt()
                != gb.get(i)
                    .getAsInt()) {
                return false;
            }
        }
        return true;
    }

    private static String str(JsonObject o, String field) {
        return o.has(field) && o.get(field)
            .isJsonPrimitive() ? o.get(field)
                .getAsString() : "";
    }

    /** oracle 里带哨兵的格（退化档 3 岛序号/盒数不可静态预测）。 */
    private static Set<String> sentinelGrids(JsonObject oracle) {
        Set<String> out = new HashSet<String>();
        if (!oracle.has("cells") || !oracle.get("cells")
            .isJsonArray()) {
            return out;
        }
        JsonArray cells = oracle.getAsJsonArray("cells");
        for (int i = 0; i < cells.size(); i++) {
            JsonObject cell = cells.get(i)
                .getAsJsonObject();
            JsonArray parts = cell.has("parts") ? cell.getAsJsonArray("parts") : new JsonArray();
            boolean wild = parts.size() == 1 && parts.get(0)
                .getAsJsonObject()
                .has("localId")
                && PartsAcceptanceOracle.LOCALID_INFERRED_WILDCARD.equals(
                    parts.get(0)
                        .getAsJsonObject()
                        .get("localId")
                        .getAsString());
            for (int j = 0; j < parts.size() && !wild; j++) {
                wild = parts.get(j)
                    .getAsJsonObject()
                    .get("boxCount")
                    .getAsInt() == PartsAcceptanceOracle.BOXCOUNT_UNCHECKED;
            }
            if (wild) {
                JsonArray g = cell.getAsJsonArray("grid");
                out.add(g.get(0) + "," + g.get(1) + "," + g.get(2));
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ 契约 §2.2：宿主级物品身份

    /**
     * `blockPalette[].hostItem` 核对（契约 §2.2 层②）：oracle `expect` 字面值精确、
     * `absent` 必缺席（无物品形态）、`derive` 在**游戏内**用 MC 原语独立复算（Item.getItemFromBlock
     * 的注册名）后比对、未登记宿主判红；恒定口径 = `hostItem.damage == 条目 meta`。
     */
    private static void verifyHostItems(JsonArray checks, JsonObject oracle, JsonObject exportRoot) {
        JsonObject spec = oracle.has("hostItems") && oracle.get("hostItems")
            .isJsonObject() ? oracle.getAsJsonObject("hostItems") : null;
        if (spec == null) {
            checks.add(new JsonPrimitive("FAIL: oracle 缺 hostItems 期望（契约 §2.2 层② 扩展；#39 阶段一）"));
            return;
        }
        if (!exportRoot.has("blockPalette") || !exportRoot.get("blockPalette")
            .isJsonArray()) {
            checks.add(new JsonPrimitive("FAIL: 导出文件缺 blockPalette（契约 §2）"));
            return;
        }
        JsonObject expect = spec.has("expect") ? spec.getAsJsonObject("expect") : new JsonObject();
        Set<String> absent = strSet(spec, "absent");
        Set<String> derive = strSet(spec, "derive");
        JsonArray palette = exportRoot.getAsJsonArray("blockPalette");
        for (int i = 0; i < palette.size(); i++) {
            JsonObject e = palette.get(i)
                .getAsJsonObject();
            String registryId = e.has("registryId") ? e.get("registryId")
                .getAsString() : "";
            if (registryId.isEmpty() || "air".equals(registryId) || "minecraft:air".equals(registryId)) {
                continue;
            }
            int meta = e.get("meta")
                .getAsInt();
            String key = registryId + ":" + meta;
            boolean has = e.has("hostItem") && e.get("hostItem")
                .isJsonObject();
            if (has) {
                expect(
                    checks,
                    e.getAsJsonObject("hostItem")
                        .get("damage")
                        .getAsInt() == meta,
                    "blockPalette[" + i + "] hostItem.damage 必须 = 条目 meta=" + meta + "（契约 §2.2 层②）");
            }
            if (expect.has(key)) {
                JsonObject want = expect.getAsJsonObject(key);
                expect(checks, has, "blockPalette[" + i + "] 宿主 " + key + " 必须带 hostItem（契约 §2.2 层②）");
                if (has) {
                    JsonObject got = e.getAsJsonObject("hostItem");
                    expect(
                        checks,
                        want.get("registry")
                            .getAsString()
                            .equals(
                                got.get("registry")
                                    .getAsString()),
                        "blockPalette[" + i
                            + "] 宿主 "
                            + key
                            + " hostItem.registry 应为 "
                            + want.get("registry")
                                .getAsString());
                    expect(
                        checks,
                        want.get("damage")
                            .getAsInt()
                            == got.get("damage")
                                .getAsInt(),
                        "blockPalette[" + i
                            + "] 宿主 "
                            + key
                            + " hostItem.damage 应为 "
                            + want.get("damage")
                                .getAsInt());
                }
            } else if (absent.contains(key)) {
                expect(checks, !has, "blockPalette[" + i + "] 宿主 " + key + " 无物品形态 ⇒ hostItem 必须缺席（不猜）");
            } else if (derive.contains(key)) {
                // 游戏内独立复算（契约 §2.2 层②原文规则：Item.getItemFromBlock + 物品注册名）
                Block b = Block.getBlockFromName(registryId);
                Item item = b == null ? null : Item.getItemFromBlock(b);
                String itemRegistry = item == null ? null : Item.itemRegistry.getNameForObject(item);
                if (itemRegistry == null) {
                    expect(checks, !has, "blockPalette[" + i + "] 宿主 " + key + " 无物品形态 ⇒ hostItem 必须缺席");
                } else if (has) {
                    expect(
                        checks,
                        itemRegistry.equals(
                            e.getAsJsonObject("hostItem")
                                .get("registry")
                                .getAsString()),
                        "blockPalette[" + i
                            + "] 宿主 "
                            + key
                            + " hostItem.registry 应为 Item.getItemFromBlock 的注册名 "
                            + itemRegistry);
                } else {
                    checks.add(
                        new JsonPrimitive(
                            "FAIL: blockPalette[" + i + "] 宿主 " + key + " 有物品形态（" + itemRegistry + "）但 hostItem 缺席"));
                }
            } else {
                checks.add(new JsonPrimitive("FAIL: blockPalette[" + i + "] 宿主 " + key + " 未在 oracle hostItems 登记"));
            }
        }
    }

    private static Set<String> strSet(JsonObject o, String field) {
        Set<String> out = new HashSet<String>();
        if (o.has(field) && o.get(field)
            .isJsonArray()) {
            JsonArray arr = o.getAsJsonArray(field);
            for (int i = 0; i < arr.size(); i++) {
                out.add(
                    arr.get(i)
                        .getAsString());
            }
        }
        return out;
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
