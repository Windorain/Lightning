package com.lightning.mod.client.meshcapture.parts.probe;

import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import net.minecraft.block.Block;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.world.World;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.client.meshcapture.parts.PartSource;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * P1.8 oracle 生成器 —— 把 {@link PartsAcceptanceBuilder} 的放置意图清单序列化为契约
 * {@code format-parts-contract.md} §11 的 oracle JSON（ground truth = 建造副产品）。
 *
 * <p>
 * 落点与拍板（契约缺口见各条注记，均上报登记）：
 * <ul>
 * <li>严格按 §11 形状：schema/structure/builtAtEpochMs/zones/cells[pos/host/expectFullCube/
 * parts[localId/typeKey/itemCount/boxTier/boxCount/boxProvenance]]/expectedCounts[typeKey/display/count]；</li>
 * <li><strong>幂等拍板</strong>：{@code builtAtEpochMs} 恒为 0（契约示例值）——验收自检要求
 * 「重复运行 oracle 字节一致」，真实时间戳会破坏字节幂等；运行时刻记录在 result 文件里；</li>
 * <li><strong>契约扩展（上报）</strong>：cells[] 追加 {@code "zone"} 与 {@code "grid":[zi,ri,ci]}，
 * root 追加 {@code "gridIndex"}（origin/尺寸/row 轴约定）——导出文件 finalize 后不含 worldGrid
 * （MeshCaptureService L707 移除），下游（P2.5/P3.1）需要 oracle 自带格映射才能定位
 * cellPartsGrid 下标；§11 未定义该映射通道；</li>
 * <li><strong>退化区变换</strong>（§11 末条：同一建造产物 + 期望档位变换）：被关族的格整格变换为
 * 兜底档期望——关 ae2 ⇒ 该格 1 个 {@code generic:0} 档 2 部件；全关 ⇒ 档 3 {@code inferred:*} 部件。
 * typeKey/itemCount 由建造器在世界内对宿主方块实算 drop 身份（与 generic/inferred 提供者同口径，
 * 确定性）；<strong>boxCount=-1 / boxProvenance="*" / localId="inferred:*" 为「不校验」哨兵</strong>
 * （§11 未定义哨兵语义，契约缺口上报）：退化档盒数/来源是被降级提供者的实现细节，
 * 静态不可预测，退化区验收点是「档位标记正确 + 静默降级 + 导出不中断」；</li>
 * <li>expectedCounts：按 typeKey 聚合（每格每部件 itemCount 累加），display 取建造时栈显示名。</li>
 * </ul>
 */
@SideOnly(Side.CLIENT)
final class PartsAcceptanceOracle {

    /** oracle 格映射的行轴约定：row 0 = 顶层（y = by+1），与 V2 cellGrid row0=顶 惯例一致。 */
    static final String GRID_ROW_AXIS = "y-top-first";

    private PartsAcceptanceOracle() {}

    /** 退化变换的「不校验」哨兵（契约缺口上报：§11 无哨兵语义）。 */
    static final int BOXCOUNT_UNCHECKED = -1;
    static final String PROVENANCE_UNCHECKED = "*";
    static final String LOCALID_INFERRED_WILDCARD = "inferred:*";

    /**
     * 由建造意图生成 oracle JSON（{@code disabledFamilies} 为空 = 全量 oracle；非空 = 退化变换）。
     *
     * @param world 客户端世界（退化变换实算宿主 drop 身份用；全量 oracle 不用，可传 null）
     */
    static JsonObject generate(List<PartsAcceptanceBuilder.CellIntent> intents, int bx, int by, int bz,
        Set<String> disabledFamilies, World world, String structureName) {
        JsonObject root = new JsonObject();
        root.addProperty("schema", "lightning.parts-oracle/1");
        root.addProperty("structure", structureName);
        root.addProperty("builtAtEpochMs", Integer.valueOf(0)); // 幂等拍板（见类注释）

        Set<String> zones = new LinkedHashSet<String>();
        for (PartsAcceptanceBuilder.CellIntent c : intents) {
            zones.add(c.zone);
        }
        zones.add("degraded"); // 退化区恒在（同一建造产物的变换导出，不占世界格）
        JsonArray zonesArr = new JsonArray();
        for (String zn : zones) {
            zonesArr.add(new JsonPrimitive(zn));
        }
        root.add("zones", zonesArr);

        // 格映射扩展（契约缺口上报：§11 无 pos→grid 通道，导出文件不含 worldGrid）
        JsonObject gridIndex = new JsonObject();
        JsonArray origin = new JsonArray();
        origin.add(new JsonPrimitive(Integer.valueOf(bx + 1)));
        origin.add(new JsonPrimitive(Integer.valueOf(by)));
        origin.add(new JsonPrimitive(Integer.valueOf(bz)));
        gridIndex.add("origin", origin);
        JsonArray size = new JsonArray();
        size.add(new JsonPrimitive(Integer.valueOf(PartsAcceptanceBuilder.SIZE_X)));
        size.add(new JsonPrimitive(Integer.valueOf(PartsAcceptanceBuilder.SIZE_Y)));
        size.add(new JsonPrimitive(Integer.valueOf(PartsAcceptanceBuilder.SIZE_Z)));
        gridIndex.add("size", size);
        gridIndex.addProperty("rowAxis", GRID_ROW_AXIS);
        root.add("gridIndex", gridIndex);

        JsonArray cellsArr = new JsonArray();
        for (PartsAcceptanceBuilder.CellIntent c : intents) {
            cellsArr.add(cellJson(c, bx, by, bz, disabledFamilies, world));
        }
        root.add("cells", cellsArr);

        // expectedCounts：按 typeKey 聚合（每格每部件 itemCount 累加；display 取建造时显示名）。
        // 退化轮口径（契约缺口上报 #2 推论）：带哨兵的变换格（档 3 岛数/档 2 盒数静态不可预测）
        // 不进 expectedCounts —— countsScope=untransformed-cells-only，验证器对该 scope 做子集比对
        // （期望键精确，实际多出的键放行）；全量轮 countsScope=all-cells 双向精确。
        boolean degradedRun = disabledFamilies != null && !disabledFamilies.isEmpty();
        root.addProperty("countsScope", degradedRun ? "untransformed-cells-only" : "all-cells");
        Map<String, long[]> counts = new LinkedHashMap<String, long[]>();
        Map<String, String> displays = new LinkedHashMap<String, String>();
        for (int i = 0; i < cellsArr.size(); i++) {
            JsonObject cell = cellsArr.get(i)
                .getAsJsonObject();
            if (!cell.has("parts")) {
                continue;
            }
            JsonArray parts = cell.getAsJsonArray("parts");
            boolean sentinel = false;
            for (int j = 0; j < parts.size(); j++) {
                JsonObject p = parts.get(j)
                    .getAsJsonObject();
                if (p.get("boxCount")
                    .getAsInt() == BOXCOUNT_UNCHECKED || LOCALID_INFERRED_WILDCARD.equals(
                        p.get("localId")
                            .getAsString())) {
                    sentinel = true;
                    break;
                }
            }
            if (sentinel) {
                continue; // 变换格不计入 expectedCounts（见 countsScope 注记）
            }
            for (int j = 0; j < parts.size(); j++) {
                JsonObject p = parts.get(j)
                    .getAsJsonObject();
                String typeKey = p.get("typeKey")
                    .getAsString();
                int itemCount = p.get("itemCount")
                    .getAsInt();
                if (itemCount <= 0) {
                    continue;
                }
                long[] acc = counts.get(typeKey);
                if (acc == null) {
                    acc = new long[1];
                    counts.put(typeKey, acc);
                }
                acc[0] += itemCount;
                if (!displays.containsKey(typeKey)) {
                    displays.put(typeKey, displayOf(intents, typeKey));
                }
            }
        }
        JsonArray countsArr = new JsonArray();
        for (Map.Entry<String, long[]> e : counts.entrySet()) {
            JsonObject o = new JsonObject();
            o.addProperty("typeKey", e.getKey());
            String disp = displays.get(e.getKey());
            o.addProperty("display", disp == null ? e.getKey() : disp);
            o.addProperty("count", Long.valueOf(e.getValue()[0]));
            countsArr.add(o);
        }
        root.add("expectedCounts", countsArr);
        return root;
    }

    /** 全量 oracle（无退化变换）。 */
    static JsonObject generateFull(List<PartsAcceptanceBuilder.CellIntent> intents, int bx, int by, int bz) {
        return generate(intents, bx, by, bz, new LinkedHashSet<String>(), null, "parts-acceptance");
    }

    /** 退化 oracle：同一建造产物 + 期望档位变换（§11 末条）。 */
    static JsonObject generateDegraded(List<PartsAcceptanceBuilder.CellIntent> intents, int bx, int by, int bz,
        Set<String> disabledFamilies, World world) {
        return generate(intents, bx, by, bz, disabledFamilies, world, "parts-acceptance-degraded");
    }

    // ------------------------------------------------------------------ 逐格序列化与退化变换

    private static JsonObject cellJson(PartsAcceptanceBuilder.CellIntent c, int bx, int by, int bz,
        Set<String> disabledFamilies, World world) {
        JsonObject o = new JsonObject();
        JsonArray pos = new JsonArray();
        pos.add(new JsonPrimitive(Integer.valueOf(c.x)));
        pos.add(new JsonPrimitive(Integer.valueOf(c.y)));
        pos.add(new JsonPrimitive(Integer.valueOf(c.z)));
        o.add("pos", pos);
        // 扩展字段（契约缺口上报）：zone + grid 下标（zi = z-bz；ri = (by+1)-y；ci = x-(bx+1)）
        o.addProperty("zone", c.zone);
        JsonArray grid = new JsonArray();
        grid.add(new JsonPrimitive(Integer.valueOf(c.z - bz)));
        grid.add(new JsonPrimitive(Integer.valueOf((by + 1) - c.y)));
        grid.add(new JsonPrimitive(Integer.valueOf(c.x - (bx + 1))));
        o.add("grid", grid);
        o.addProperty("host", c.host);
        o.addProperty("expectFullCube", Boolean.valueOf(c.expectFullCube));

        JsonArray parts = new JsonArray();
        if (!c.expectFullCube) {
            boolean degraded = isFamilyCellDisabled(c, disabledFamilies);
            if (!degraded) {
                for (PartsAcceptanceBuilder.ExpectedPart p : c.parts) {
                    parts.add(partJson(p));
                }
            } else if (allFamilyProvidersDisabled(disabledFamilies)) {
                // 全关 ⇒ 档 3 inferred：typeKey/itemCount = 宿主 drop 身份（与 inferred 提供者同口径，实算）；
                // localId 岛序号不静态可预测 ⇒ 通配哨兵；盒数/来源 ⇒ 不校验哨兵
                DropIdentity drop = dropIdentity(world, c);
                JsonObject p = new JsonObject();
                p.addProperty("localId", LOCALID_INFERRED_WILDCARD);
                p.addProperty("typeKey", drop.typeKey);
                p.addProperty("itemCount", Integer.valueOf(drop.itemCount));
                p.addProperty("boxTier", Integer.valueOf(PartSource.TIER_INFERRED));
                p.addProperty("boxCount", Integer.valueOf(BOXCOUNT_UNCHECKED));
                p.addProperty("boxProvenance", PROVENANCE_UNCHECKED);
                parts.add(p);
            } else {
                // 部分关（如关 ae2）⇒ 档 2 通用盒：一格一个 generic:0（§4），typeKey = 宿主 drop 身份
                DropIdentity drop = dropIdentity(world, c);
                JsonObject p = new JsonObject();
                p.addProperty("localId", "generic:0");
                p.addProperty("typeKey", drop.typeKey);
                p.addProperty("itemCount", Integer.valueOf(drop.itemCount));
                p.addProperty("boxTier", Integer.valueOf(PartSource.TIER_GENERIC));
                p.addProperty("boxCount", Integer.valueOf(BOXCOUNT_UNCHECKED));
                p.addProperty("boxProvenance", PROVENANCE_UNCHECKED);
                parts.add(p);
            }
        }
        o.add("parts", parts);
        return o;
    }

    private static JsonObject partJson(PartsAcceptanceBuilder.ExpectedPart p) {
        JsonObject o = new JsonObject();
        o.addProperty("localId", p.localId);
        o.addProperty("typeKey", p.typeKey);
        o.addProperty("itemCount", Integer.valueOf(p.itemCount));
        o.addProperty("boxTier", Integer.valueOf(p.boxTier));
        o.addProperty("boxCount", Integer.valueOf(p.boxCount));
        o.addProperty("boxProvenance", p.boxProvenance);
        return o;
    }

    /** 该格是否属于被关族（格内全部部件的 localId 命名空间都在 disabledFamilies 里）。 */
    private static boolean isFamilyCellDisabled(PartsAcceptanceBuilder.CellIntent c, Set<String> disabledFamilies) {
        if (disabledFamilies == null || disabledFamilies.isEmpty() || c.parts.isEmpty()) {
            return false;
        }
        for (PartsAcceptanceBuilder.ExpectedPart p : c.parts) {
            int colon = p.localId.indexOf(':');
            String ns = colon > 0 ? p.localId.substring(0, colon) : p.localId;
            if (!disabledFamilies.contains(ns)) {
                return false;
            }
        }
        return true;
    }

    /**
     * 「全关」判定（⇒ 退化落档 3 inferred）：三族 + 通用盒档全部关闭（只关三族会落档 2 通用盒，
     * P3.3「落几何推断档」要求档 2 也关闭——拍板：degraded-all 集 = {ae2, eio, fmp, generic}）。
     */
    private static boolean allFamilyProvidersDisabled(Set<String> disabledFamilies) {
        return disabledFamilies != null && disabledFamilies.contains(PartSource.FAMILY_AE2)
            && disabledFamilies.contains(PartSource.FAMILY_ENDERIO)
            && disabledFamilies.contains(PartSource.FAMILY_FMP)
            && disabledFamilies.contains(PartSource.FAMILY_GENERIC);
    }

    /** 宿主 drop 身份（generic/inferred 提供者同口径：getItemDropped + damageDropped；无掉落回退宿主身份）。 */
    private static DropIdentity dropIdentity(World world, PartsAcceptanceBuilder.CellIntent c) {
        DropIdentity id = new DropIdentity();
        try {
            Block b = world.getBlock(c.x, c.y, c.z);
            int meta = world.getBlockMetadata(c.x, c.y, c.z);
            Item drop = b.getItemDropped(meta, world.rand, 0);
            if (drop != null) {
                String reg = Item.itemRegistry.getNameForObject(drop);
                id.typeKey = (reg == null ? "<unregistered>" : reg) + ":" + b.damageDropped(meta);
                id.itemCount = 1;
                id.display = safeDropDisplay(drop, b.damageDropped(meta));
                return id;
            }
            String hostReg = Block.blockRegistry.getNameForObject(b);
            id.typeKey = (hostReg == null ? "<unregistered>" : hostReg) + ":" + meta;
            id.itemCount = 0;
            id.display = id.typeKey;
            return id;
        } catch (Throwable t) {
            id.typeKey = "<drop identity failed>";
            id.itemCount = 0;
            id.display = id.typeKey;
            return id;
        }
    }

    private static String safeDropDisplay(Item drop, int damage) {
        try {
            return new ItemStack(drop, 1, damage).getDisplayName();
        } catch (Throwable t) {
            return drop.getUnlocalizedName();
        }
    }

    private static final class DropIdentity {

        String typeKey;
        int itemCount;
        String display;
    }

    private static String displayOf(List<PartsAcceptanceBuilder.CellIntent> intents, String typeKey) {
        for (PartsAcceptanceBuilder.CellIntent c : intents) {
            for (PartsAcceptanceBuilder.ExpectedPart p : c.parts) {
                if (typeKey.equals(p.typeKey)) {
                    return p.display != null ? p.display : typeKey;
                }
            }
        }
        return typeKey;
    }
}
