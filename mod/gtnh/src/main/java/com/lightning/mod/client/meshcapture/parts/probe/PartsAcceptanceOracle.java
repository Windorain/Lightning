package com.lightning.mod.client.meshcapture.parts.probe;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

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

        // 契约 §2.2 扩展（#39 阶段一）：物品索引表期望 + 宿主级物品身份期望。
        // 口径来源 = 契约 §2.2 原文规则 + 建造意图（**不是**读实现输出）：
        // - 键 = 物品身份键（部件 typeKey 与 items[0].iconKey() 按契约 §5 同形）；
        // - 归属层①part = 该格该部件（grid + localId）；层②host = 宿主方块自身物品身份
        // （Item.getItemFromBlock + damage=方块 meta，契约 §2.2 层②**原文规则**，用 MC 原语独立复算）；
        // - 层③family 本轮不实现（注册表恒空）⇒ 不产出；
        // - display：建造意图带显示名则用（AE2/EIO 的真实 ItemStack），否则由物品身份键重建
        // ItemStack 取显示名；带 `#nbt` 判别键的（FMP 材料变体）显示名依赖 NBT ⇒ displayChecked=false（不猜）。
        boolean degradedRun = disabledFamilies != null && !disabledFamilies.isEmpty();
        buildItemIndex(intents, disabledFamilies, world, degradedRun, root, bx, by, bz);
        buildHostItems(intents, root);

        // expectedCounts：按 typeKey 聚合（每格每部件 itemCount 累加；display 取建造时显示名）。
        // 退化轮口径（契约缺口上报 #2 推论）：带哨兵的变换格（档 3 岛数/档 2 盒数静态不可预测）
        // 不进 expectedCounts —— countsScope=untransformed-cells-only，验证器对该 scope 做子集比对
        // （期望键精确，实际多出的键放行）；全量轮 countsScope=all-cells 双向精确。
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
        for (PartSpec p : effectiveParts(c, disabledFamilies, world)) {
            JsonObject o2 = new JsonObject();
            o2.addProperty("localId", p.localId);
            o2.addProperty("typeKey", p.typeKey);
            o2.addProperty("itemCount", Integer.valueOf(p.itemCount));
            o2.addProperty("boxTier", Integer.valueOf(p.boxTier));
            o2.addProperty("boxCount", Integer.valueOf(p.boxCount));
            o2.addProperty("boxProvenance", p.boxProvenance);
            parts.add(o2);
        }
        o.add("parts", parts);
        return o;
    }

    /** 变换后的一格部件期望（供 cells[] 序列化与 itemIndex 期望共用同一份推导，杜绝两处口径漂移）。 */
    private static final class PartSpec {

        final String localId;
        final String typeKey;
        final int itemCount;
        final int boxTier;
        final int boxCount;
        final String boxProvenance;

        PartSpec(String localId, String typeKey, int itemCount, int boxTier, int boxCount, String boxProvenance) {
            this.localId = localId;
            this.typeKey = typeKey;
            this.itemCount = itemCount;
            this.boxTier = boxTier;
            this.boxCount = boxCount;
            this.boxProvenance = boxProvenance;
        }
    }

    /**
     * 一格的**有效部件期望**（含退化档位变换）：未变换 ⇒ 建造意图逐条；变换 ⇒ 档 2 单盒
     * {@code generic:0} 或档 3 {@code inferred:*}（typeKey/itemCount = 宿主 drop 身份实算）。
     */
    private static List<PartSpec> effectiveParts(PartsAcceptanceBuilder.CellIntent c, Set<String> disabledFamilies,
        World world) {
        List<PartSpec> out = new ArrayList<PartSpec>();
        if (c.expectFullCube) {
            return out;
        }
        if (!isFamilyCellDisabled(c, disabledFamilies)) {
            for (PartsAcceptanceBuilder.ExpectedPart p : c.parts) {
                out.add(new PartSpec(p.localId, p.typeKey, p.itemCount, p.boxTier, p.boxCount, p.boxProvenance));
            }
            return out;
        }
        DropIdentity drop = dropIdentity(world, c);
        if (allFamilyProvidersDisabled(disabledFamilies)) {
            out.add(
                new PartSpec(
                    LOCALID_INFERRED_WILDCARD,
                    drop.typeKey,
                    drop.itemCount,
                    PartSource.TIER_INFERRED,
                    BOXCOUNT_UNCHECKED,
                    PROVENANCE_UNCHECKED));
        } else {
            out.add(
                new PartSpec(
                    "generic:0",
                    drop.typeKey,
                    drop.itemCount,
                    PartSource.TIER_GENERIC,
                    BOXCOUNT_UNCHECKED,
                    PROVENANCE_UNCHECKED));
        }
        return out;
    }

    // ------------------------------------------------------------------ 契约 §2.2 扩展（#39 阶段一）

    /** 一个物品身份键的期望条目（part 归属先于 host 归属，= 契约 §2.2 权威度顺序）。 */
    private static final class IndexEntry {

        String display;
        boolean displayChecked = true;
        final List<JsonObject> partAttrs = new ArrayList<JsonObject>();
        final List<JsonObject> hostAttrs = new ArrayList<JsonObject>();
    }

    /** 归属条目 JSON（{@code source}/{@code frame}/{@code grid:[zi,ri,ci]}/{@code localId?}，契约 §2.2）。 */
    private static JsonObject attribution(String source, int zi, int ri, int ci, String localId) {
        JsonObject a = new JsonObject();
        a.addProperty("source", source);
        a.addProperty("frame", Integer.valueOf(0));
        JsonArray grid = new JsonArray();
        grid.add(new JsonPrimitive(Integer.valueOf(zi)));
        grid.add(new JsonPrimitive(Integer.valueOf(ri)));
        grid.add(new JsonPrimitive(Integer.valueOf(ci)));
        a.add("grid", grid);
        if (localId != null) {
            a.addProperty("localId", localId);
        }
        return a;
    }

    /**
     * 物品索引表期望（契约 §2.2）：
     * <ul>
     * <li>键集 = 全部部件的物品身份键（{@code itemCount>0} 者；{@code itemCount=0} = {@code items:[]}
     * 显式"无" ⇒ 该部件不产生键，与导出侧 {@code addPart} 的 early-return 同口径）；</li>
     * <li>层① {@code part} 归属逐格逐部件；层② {@code host} 归属 = 宿主方块自身物品身份键命中的格
     * （契约 §2.2 层②原文：只对层①已建键枚举）—— 用 MC 原语独立复算，不读实现产物；</li>
     * <li>{@code source} = 首条归属来源（part 先入 ⇒ 非空归属的键恒为 {@code part}；本结构无
     * {@code items[i>0]} 附加条目 ⇒ 无 {@code none} 条目）；</li>
     * <li>{@code itemIndexScope}：全量轮 {@code exact}（键集双向精确）/ 退化轮
     * {@code untransformed-cells-only}（在册键必在；变换格多出的键与归属放行 —— 与 {@code countsScope}
     * 同口径）。</li>
     * </ul>
     */
    private static void buildItemIndex(List<PartsAcceptanceBuilder.CellIntent> intents, Set<String> disabledFamilies,
        World world, boolean degradedRun, JsonObject root, int bx, int by, int bz) {
        Map<String, IndexEntry> byKey = new TreeMap<String, IndexEntry>();
        List<String> hostHits = new ArrayList<String>();
        for (PartsAcceptanceBuilder.CellIntent c : intents) {
            List<PartSpec> specs = effectiveParts(c, disabledFamilies, world);
            if (specs.isEmpty()) {
                continue;
            }
            // 格下标（与 cellJson 的 grid 扩展字段同一算式：zi = z-bz；ri = (by+1)-y；ci = x-(bx+1)）
            int zi = c.z - bz;
            int ri = (by + 1) - c.y;
            int ci = c.x - (bx + 1);
            // 层② 宿主身份候选（最终只并入已建键，见契约 §2.2 层②）
            String hostKey = hostItemKeyOf(c.host);
            if (hostKey != null) {
                hostHits.add(hostKey + "@" + zi + "," + ri + "," + ci);
            }
            for (PartSpec p : specs) {
                if (p.itemCount <= 0) {
                    continue; // items:[] 显式"无" ⇒ 不建键（与导出侧 addPart 同口径）
                }
                IndexEntry e = byKey.get(p.typeKey);
                if (e == null) {
                    e = new IndexEntry();
                    e.display = displayFor(c, p);
                    e.displayChecked = p.typeKey.indexOf('#') < 0;
                    byKey.put(p.typeKey, e);
                }
                e.partAttrs.add(attribution("part", zi, ri, ci, p.localId));
            }
        }
        // 层②：宿主键命中已建键 ⇒ 追加 host 归属（权威度低于 part ⇒ 落在 part 之后）
        for (String hk : hostHits) {
            int at = hk.lastIndexOf('@');
            String key = hk.substring(0, at);
            IndexEntry e = byKey.get(key);
            if (e == null) {
                continue;
            }
            String[] g = hk.substring(at + 1)
                .split(",");
            e.hostAttrs
                .add(attribution("host", Integer.parseInt(g[0]), Integer.parseInt(g[1]), Integer.parseInt(g[2]), null));
        }

        JsonObject index = new JsonObject();
        for (Map.Entry<String, IndexEntry> en : byKey.entrySet()) {
            IndexEntry e = en.getValue();
            JsonObject o = new JsonObject();
            if (e.displayChecked && e.display != null) {
                o.addProperty("display", e.display);
            } else {
                o.add("display", com.google.gson.JsonNull.INSTANCE);
            }
            o.addProperty("displayChecked", Boolean.valueOf(e.displayChecked));
            o.addProperty("tooltipNonEmpty", Boolean.TRUE);
            o.addProperty("source", e.partAttrs.isEmpty() ? (e.hostAttrs.isEmpty() ? "none" : "host") : "part");
            JsonArray attrs = new JsonArray();
            for (JsonObject a : e.partAttrs) {
                attrs.add(a);
            }
            for (JsonObject a : e.hostAttrs) {
                attrs.add(a);
            }
            o.add("attribution", attrs);
            index.add(en.getKey(), o);
        }
        root.add("itemIndex", index);
        root.addProperty("itemIndexScope", degradedRun ? "untransformed-cells-only" : "exact");
        JsonObject rules = new JsonObject();
        rules.addProperty("keySet", "exact: 文件键集 = 本表键集（双向）；untransformed-cells-only: 在册键必在，变换格多出放行");
        rules.addProperty("displayFallback", "displayChecked=false ⇒ 只断言非空（NBT 变体：FMP 材料串显示名依赖 NBT，静态不可复算）");
        rules.addProperty("tooltipFallback", "tooltip 非空，空 ⇒ 至少 display 一行（契约 §2.2 空值语义）");
        rules.addProperty("sourceDerivation", "source = attribution 首条来源；空数组 ⇒ none");
        rules.addProperty("attributionOrder", "part → host → family 分组；组内集合比对（同来源内顺序未规定）");
        rules.addProperty("localIdWildcard", "inferred:* = 档 3 岛序号不可静态预测（退化哨兵）");
        rules.addProperty("familyLayer", "层③族特有本轮不实现（规则注册表恒空）⇒ 不产出 family 归属");
        root.add("itemIndexRules", rules);
    }

    /** 期望显示名：建造意图带显示名则用（真实 ItemStack），否则由物品身份键重建 ItemStack 取名。 */
    private static String displayFor(PartsAcceptanceBuilder.CellIntent c, PartSpec p) {
        for (PartsAcceptanceBuilder.ExpectedPart ep : c.parts) {
            if (ep.localId.equals(p.localId) && ep.display != null && !ep.display.isEmpty()) {
                return ep.display;
            }
        }
        return displayForKey(p.typeKey);
    }

    /**
     * 由物品身份键 {@code registry:damage[#nbt]} 重建显示名（契约 §3④ 尊重游戏内显示名）。
     * 不可重建（注册名不在册 / 无该物品 / 抛错）⇒ 回退键本身（消费侧同一兜底口径）。
     */
    private static String displayForKey(String key) {
        try {
            int hash = key.indexOf('#');
            String bare = hash < 0 ? key : key.substring(0, hash);
            int colon = bare.lastIndexOf(':');
            if (colon <= 0) {
                return key;
            }
            String registry = bare.substring(0, colon);
            int damage = Integer.parseInt(bare.substring(colon + 1));
            Object item = Item.itemRegistry.getObject(registry);
            if (!(item instanceof Item)) {
                return key;
            }
            return new ItemStack((Item) item, 1, damage).getDisplayName();
        } catch (Throwable t) {
            return key;
        }
    }

    /** 宿主身份键（契约 §2.2 层②原文：{@code Item.getItemFromBlock(block)} 的注册名 + ":" + meta）。 */
    private static String hostItemKeyOf(String host) {
        try {
            int colon = host.lastIndexOf(':');
            if (colon <= 0) {
                return null;
            }
            String registry = host.substring(0, colon);
            int meta = Integer.parseInt(host.substring(colon + 1));
            Block b = Block.getBlockFromName(registry);
            if (b == null) {
                return null;
            }
            Item item = Item.getItemFromBlock(b);
            if (item == null) {
                return null; // 无物品形态（不猜）
            }
            String itemRegistry = Item.itemRegistry.getNameForObject(item);
            if (itemRegistry == null) {
                return null;
            }
            return itemRegistry + ":" + meta;
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * 宿主级物品身份期望（契约 §2.2 层②，落盘 {@code blockPalette[].hostItem}）：
     * <ul>
     * <li>{@code expect[宿主 registry:meta]} = {@code {registry, damage}} 字面值（
     * 用 MC 原语按契约原文规则独立复算，与导出侧 {@code ItemIndexIntegrator} 是两条路径）；</li>
     * <li>{@code absent} = 无物品形态的宿主（如 FMP BlockMultipart 无 ItemBlock，P1.8 实证）⇒ 字段缺席；</li>
     * <li>{@code derive} = 运行时/静态都推不出字面值（注册名不可得）⇒ 验证器只断言
     * "若在则 damage = 条目 meta"，并把实测值登记进 note（不猜）。</li>
     * </ul>
     */
    private static void buildHostItems(List<PartsAcceptanceBuilder.CellIntent> intents, JsonObject root) {
        JsonObject spec = new JsonObject();
        spec.addProperty(
            "rule",
            "契约 §2.2 层②：blockPalette[j].hostItem = { registry: Item.getItemFromBlock(宿主方块) 的注册名, damage: 该条目 meta }；无物品形态 ⇒ 字段缺席（不猜）");
        spec.addProperty("damageEqualsMeta", Boolean.TRUE);
        Map<String, JsonObject> expect = new TreeMap<String, JsonObject>();
        List<String> absent = new ArrayList<String>();
        List<String> derive = new ArrayList<String>();
        Set<String> seen = new LinkedHashSet<String>();
        for (PartsAcceptanceBuilder.CellIntent c : intents) {
            if (c.host == null || c.host.isEmpty() || !seen.add(c.host)) {
                continue;
            }
            int colon = c.host.lastIndexOf(':');
            String registry = colon > 0 ? c.host.substring(0, colon) : c.host;
            int meta = colon > 0 ? Integer.parseInt(c.host.substring(colon + 1)) : 0;
            Block b = Block.getBlockFromName(registry);
            if (b == null) {
                derive.add(c.host);
                continue;
            }
            Item item = Item.getItemFromBlock(b);
            if (item == null) {
                absent.add(c.host);
                continue;
            }
            String itemRegistry = Item.itemRegistry.getNameForObject(item);
            if (itemRegistry == null) {
                derive.add(c.host);
                continue;
            }
            JsonObject h = new JsonObject();
            h.addProperty("registry", itemRegistry);
            h.addProperty("damage", Integer.valueOf(meta));
            expect.put(c.host, h);
        }
        JsonObject expectObj = new JsonObject();
        for (Map.Entry<String, JsonObject> e : expect.entrySet()) {
            expectObj.add(e.getKey(), e.getValue());
        }
        spec.add("expect", expectObj);
        JsonArray absentArr = new JsonArray();
        for (String s : absent) {
            absentArr.add(new JsonPrimitive(s));
        }
        spec.add("absent", absentArr);
        JsonArray deriveArr = new JsonArray();
        for (String s : derive) {
            deriveArr.add(new JsonPrimitive(s));
        }
        spec.add("derive", deriveArr);
        root.add("hostItems", spec);
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
