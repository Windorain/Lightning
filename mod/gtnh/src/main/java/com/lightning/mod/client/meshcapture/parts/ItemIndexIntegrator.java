package com.lightning.mod.client.meshcapture.parts;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

import net.minecraft.block.Block;
import net.minecraft.item.Item;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 物品索引表（契约 §2.2，{@code itemIndex}）—— 物品级说明与归属的<strong>单一数据源</strong>。
 *
 * <p>
 * 键 = 物品身份键 {@code registry:damage[#nbtDiscriminator]}（{@link PartItem#iconKey()}，与左栏行、
 * {@code partIconTextures} 同键）。文档根级共享（World 文档跨帧一份）、按键去重、跨帧不重复；
 * <strong>仅当文档含部件数据时写入</strong>（无部件文件字节干净，硬约束）。
 *
 * <p>
 * 落盘形状（本节由实现拍板，已回填契约 §2.2）：
 *
 * <pre>
 * "itemIndex": {
 *   "minecraft:torch:0": {
 *     "display": "Torch",                  // 必填；缺省兜底 = 物品身份键本身
 *     "tooltip": ["Torch", "..."],         // 说明行；空 ⇒ 至少 display 一行（可读兜底）
 *     "source": "part",                    // 归属来源：part | host | family | none
 *     "attribution": [                     // 归属定位；空数组 + source=none = 显式"无对应"
 *       { "source": "part", "frame": 0, "grid": [zi, ri, ci], "localId": "generic:0" },
 *       { "source": "host", "frame": 0, "grid": [zi, ri, ci] }
 *     ]
 *   }
 * }
 * </pre>
 *
 * <ul>
 * <li><strong>归属分层</strong>（权威度由高到低，契约 §2.2）：① 部件级 = {@code PartRecord.items[0]}
 * 命中 ⇒ 条目带 {@code localId} 的部件定位；② 宿主级 = 该格宿主方块的自身物品身份
 * （{@link #hostItemIdentity(Block, int)}，同一身份同时落盘到 {@code blockPalette} 条目的
 * {@link #HOST_ITEM_FIELD}）；③ 族特有 = 本轮<strong>只留扩展接口</strong>
 * （{@link AttributionRule}，无规则注册 ⇒ 零副作用）；④ 兜底 = 无任何规则命中 ⇒
 * {@code attribution: []} + {@code source: "none"}（显式，不猜）；</li>
 * <li><strong>attribution 顺序即权威度</strong>：part 命中全部在前，其后 host，再后 family；
 * {@code source} = 首个归属条目的来源（空数组 ⇒ {@code none}），两者同源生成不手工改写；</li>
 * <li><strong>说明行</strong>：主物品（{@code items[0]}）在<strong>宿主回退之前</strong>的说明
 * （= 提供者按 §8 第一优先级生成的物品 tooltip）第一见生效；同一键跨格/跨帧只保留一份文案
 * （"同一物品两套文案"硬约束）。与 {@code PartRecord.tooltip} 各自保留、同源生成，不做口径合并；</li>
 * <li><strong>本轮不做</strong>附加物品条目（{@code items[i>0]}）的独立说明与对应 ⇒ 这些键仍建条目
 * （左栏可能出行），但只带 display 兜底并显式 {@code none}，留待层③族规则补全；</li>
 * <li><strong>去重</strong>：键去重（{@link TreeMap} 字典序，跨帧稳定）；归属条目按
 * {@code source|frame|grid|localId} 去重（同一格跨帧重复出现不重复计入）。</li>
 * </ul>
 */
@SideOnly(Side.CLIENT)
public final class ItemIndexIntegrator {

    /** 文档根字段名（契约 §2.2）。 */
    public static final String FIELD = "itemIndex";

    /** {@code blockPalette} 条目上的宿主级物品身份字段名（层②，契约 §2.2）。 */
    public static final String HOST_ITEM_FIELD = "hostItem";

    /** 归属来源：部件级（{@code PartRecord.items[0]}）。 */
    public static final String SOURCE_PART = "part";
    /** 归属来源：宿主级（宿主方块自身物品身份）。 */
    public static final String SOURCE_HOST = "host";
    /** 归属来源：族特有（本轮不实现，仅扩展接口预留）。 */
    public static final String SOURCE_FAMILY = "family";
    /** 归属来源：无规则命中（显式"无对应"）。 */
    public static final String SOURCE_NONE = "none";

    /** 层③ 族特有规则的扩展接口注册表——本轮恒空（不实现族规则，只留接口）。 */
    private static final List<AttributionRule> RULES = new ArrayList<AttributionRule>();

    private ItemIndexIntegrator() {}

    // ------------------------------------------------------------------ 层② 宿主级物品身份

    /**
     * 宿主级物品身份（契约 §2.2 层②）：{@code Item.getItemFromBlock(block)} + damage。
     * damage 取方块 meta —— 与既有 tooltip 循环的 {@code new ItemStack(b, 1, vs.meta)} 同构造
     * （契约 §2.2 原文"顺手取"）。无物品形态（如 fire/water）或取键失败 ⇒ {@code null}
     * （该格无宿主身份，不猜）。
     */
    public static JsonObject hostItemIdentity(Block block, int meta) {
        String registry = hostItemRegistry(block);
        if (registry == null) {
            return null;
        }
        JsonObject o = new JsonObject();
        o.addProperty("registry", registry);
        o.addProperty("damage", Integer.valueOf(meta));
        return o;
    }

    /**
     * 宿主级物品身份键 {@code registry:damage}（与 {@link PartItem#iconKey()} 同形；宿主身份无 NBT
     * 判别键 ⇒ 无 {@code #nbt} 段）。无物品形态 ⇒ {@code null}。
     */
    public static String hostItemKey(Block block, int meta) {
        String registry = hostItemRegistry(block);
        return registry == null ? null : registry + ":" + meta;
    }

    private static String hostItemRegistry(Block block) {
        if (block == null) {
            return null;
        }
        try {
            Item item = Item.getItemFromBlock(block);
            if (item == null) {
                return null;
            }
            return Item.itemRegistry.getNameForObject(item);
        } catch (Throwable t) {
            // 方块无物品形态或注册名不可得：该格无层②身份（如实缺席，绝不猜）
            return null;
        }
    }

    // ------------------------------------------------------------------ 层③ 扩展接口

    /**
     * 族特有归属规则（契约 §2.2 层③：AE2 伪装板存被伪装方块 / GT 机器 / FMP 材料）。
     *
     * <p>
     * <strong>本轮不实现</strong>：注册表恒空，导出行为与"没有层③"完全一致；族规则落地时在此注册，
     * 文件格式与键/来源标记不变（只增来源值 {@link #SOURCE_FAMILY} 的归属条目）。
     * 规则抛异常被吞掉并跳过（导出绝不中断，契约 §7.2 同口径）。
     */
    public interface AttributionRule {

        /** 规则标识（日志/探针留痕用，如 {@code "ae2-facade"}）。 */
        String family();

        /**
         * 为（物品键, 主物品, 部件, 格）追加族特有归属。
         *
         * @param out      该结构的物品索引汇聚器（可补条目/补归属）
         * @param itemKey  主物品身份键
         * @param primary  部件主物品（{@code items[0]}）
         * @param part     部件记录
         * @param zi/ri/ci 格下标（与 {@code cellGrid}/{@code cellPartsGrid} 同下标）
         */
        void attribute(Sink out, String itemKey, PartItem primary, PartRecord part, int zi, int ri, int ci);
    }

    /** 层③ 扩展点注册（本轮无生产调用方；族规则分支落地时调用）。 */
    public static void registerRule(AttributionRule rule) {
        if (rule != null && !RULES.contains(rule)) {
            RULES.add(rule);
        }
    }

    /** 探针/测试专用：清空族规则注册表。生产路径不得调用。 */
    public static void clearRulesForProbe() {
        RULES.clear();
    }

    /** 已注册族规则数（探针断言用）。 */
    public static int ruleCount() {
        return RULES.size();
    }

    // ------------------------------------------------------------------ 一条索引条目

    /** 一个物品身份键的条目（display/tooltip 首见生效；attribution 去重保序）。 */
    public static final class Entry {

        public final String key;
        private String display;
        private final List<String> tooltip = new ArrayList<String>();
        private final List<JsonObject> attribution = new ArrayList<JsonObject>();
        private final Set<String> attributionKeys = new HashSet<String>();

        private Entry(String key) {
            this.key = key;
        }

        /** 归属的最终来源（权威度最高者）；无归属 ⇒ {@code none}（与 attribution 同源生成）。 */
        public String source() {
            return attribution.isEmpty() ? SOURCE_NONE
                : attribution.get(0)
                    .get("source")
                    .getAsString();
        }

        private void ensureDisplayAndTooltip(String fallbackDisplay, List<String> lines) {
            if (display == null) {
                display = (fallbackDisplay != null && !fallbackDisplay.isEmpty()) ? fallbackDisplay : key;
            }
            if (tooltip.isEmpty()) {
                if (lines != null && !lines.isEmpty()) {
                    tooltip.addAll(lines);
                } else {
                    tooltip.add(display); // 空值语义：至少 display 一行（可读兜底）
                }
            }
        }

        /**
         * 追加归属条目（按 {@code source|frame|grid|localId} 去重保序）。
         * 因 part 阶段先于 host/family 阶段执行，先入者权威度更高，故 {@link #source()} 取首条。
         */
        private void addAttribution(String source, int frameIndex, int zi, int ri, int ci, String localId) {
            String dedup = source + '|'
                + frameIndex
                + '|'
                + zi
                + '|'
                + ri
                + '|'
                + ci
                + '|'
                + (localId == null ? "" : localId);
            if (!attributionKeys.add(dedup)) {
                return;
            }
            JsonObject a = new JsonObject();
            a.addProperty("source", source);
            a.addProperty("frame", Integer.valueOf(frameIndex));
            JsonArray grid = new JsonArray();
            grid.add(new JsonPrimitive(Integer.valueOf(zi)));
            grid.add(new JsonPrimitive(Integer.valueOf(ri)));
            grid.add(new JsonPrimitive(Integer.valueOf(ci)));
            a.add("grid", grid);
            if (localId != null) {
                a.addProperty("localId", localId);
            }
            attribution.add(a);
        }

        /** 合并另一结构的同名条目（说明首见生效，归属去重追加；跨帧不重复）。 */
        private void mergeFrom(Entry other) {
            if (display == null) {
                display = other.display;
            }
            if (tooltip.isEmpty() && !other.tooltip.isEmpty()) {
                tooltip.addAll(other.tooltip);
            }
            for (JsonObject a : other.attribution) {
                addAttributionJson(a);
            }
        }

        /** 归属条目入列（与 {@link #addAttribution} 同一去重口径；层③ 规则产出的条目走此口）。 */
        private void addAttributionJson(JsonObject a) {
            JsonArray grid = a.getAsJsonArray("grid");
            addAttribution(
                a.get("source")
                    .getAsString(),
                a.get("frame")
                    .getAsInt(),
                grid.get(0)
                    .getAsInt(),
                grid.get(1)
                    .getAsInt(),
                grid.get(2)
                    .getAsInt(),
                a.has("localId") ? a.get("localId")
                    .getAsString() : null);
        }

        public JsonObject toJson() {
            JsonObject o = new JsonObject();
            o.addProperty("display", display != null ? display : key);
            JsonArray tt = new JsonArray();
            if (tooltip.isEmpty()) {
                tt.add(new JsonPrimitive(display != null ? display : key));
            } else {
                for (String line : tooltip) {
                    tt.add(new JsonPrimitive(line));
                }
            }
            o.add("tooltip", tt);
            o.addProperty("source", source());
            JsonArray attrs = new JsonArray();
            for (JsonObject a : attribution) {
                attrs.add(a);
            }
            o.add("attribution", attrs);
            return o;
        }
    }

    // ------------------------------------------------------------------ 结构级汇聚

    /** 层② 宿主格候选（键 + 格下标）。 */
    private static final class HostHit {

        private final String key;
        private final int zi;
        private final int ri;
        private final int ci;

        private HostHit(String key, int zi, int ri, int ci) {
            this.key = key;
            this.zi = zi;
            this.ri = ri;
            this.ci = ci;
        }
    }

    /** 层③ 族规则产出的归属（延后到 host 阶段之后落盘，保证 attribution 顺序 = 权威度顺序）。 */
    private static final class FamilyHit {

        private final String key;
        private final JsonObject attribution;

        private FamilyHit(String key, JsonObject attribution) {
            this.key = key;
            this.attribution = attribution;
        }
    }

    /**
     * 一个结构（单文件文档 = 唯一结构；World 文档 = 一帧）的物品索引汇聚器。
     * 逐格调用（{@code PartExportIntegrator.StructureSink#addCell} 内），文档级合并由
     * {@link #buildDocumentIndex(List)} 完成。
     */
    public static final class Sink {

        private final int frameIndex;
        private final Map<String, Entry> entries = new LinkedHashMap<String, Entry>();
        private final List<HostHit> hostHits = new ArrayList<HostHit>();
        private final List<FamilyHit> familyHits = new ArrayList<FamilyHit>();

        public Sink(int frameIndex) {
            this.frameIndex = frameIndex;
        }

        public int frameIndex() {
            return frameIndex;
        }

        /** 取/建条目（键去重；首见者保留 display/tooltip）。 */
        public Entry entry(String key) {
            Entry e = entries.get(key);
            if (e == null) {
                e = new Entry(key);
                entries.put(key, e);
            }
            return e;
        }

        /**
         * 层① —— 一个部件的物品身份贡献：主物品（{@code items[0]}）建条目 + 归属到该部件
         * （格 + localId）；附加条目（{@code items[i>0]}）本轮只建显式 {@code none} 条目。
         *
         * @param itemTooltipBeforeChain 宿主回退（{@code applyTooltipChain}）<strong>之前</strong>的
         *                               部件说明行 = 物品 tooltip（§8 第一优先级）；空则由调用方
         *                               链后说明兜底
         */
        public void addPart(int zi, int ri, int ci, PartRecord part, List<String> itemTooltipBeforeChain) {
            if (part == null || part.items.isEmpty()) {
                return;
            }
            PartItem primary = part.items.get(0);
            if (primary == null) {
                return;
            }
            String key = primary.iconKey();
            Entry e = entry(key);
            List<String> lines = (itemTooltipBeforeChain != null && !itemTooltipBeforeChain.isEmpty())
                ? itemTooltipBeforeChain
                : part.tooltip;
            e.ensureDisplayAndTooltip(part.displayName, lines);
            e.addAttribution(SOURCE_PART, frameIndex, zi, ri, ci, part.localId);

            // 层③ 族特有规则（本轮注册表恒空 ⇒ 零副作用）；异常吞掉，导出不中断
            for (AttributionRule rule : RULES) {
                try {
                    rule.attribute(this, key, primary, part, zi, ri, ci);
                } catch (Throwable t) {
                    // 规则失败静默跳过（契约 §7.2 同口径）
                }
            }

            // 附加物品条目（items[i>0]）：本轮不做独立说明与对应 ⇒ 显式 none（左栏可能出行的键）；
            // display/tooltip 首见生效，故此处对已由主物品建立的键是无副作用兜底
            for (int i = 1; i < part.items.size(); i++) {
                PartItem extra = part.items.get(i);
                if (extra == null) {
                    continue;
                }
                entry(extra.iconKey()).ensureDisplayAndTooltip(extra.iconKey(), null);
            }
        }

        /**
         * 层② —— 该格宿主方块的自身物品身份（候选）。最终只并入层①已建立索引项的键
         * （无部件产出的方块身份不进 {@code itemIndex} 键集，仅经 {@code blockPalette.hostItem}
         * 映射暴露）。
         */
        public void addHostCell(int zi, int ri, int ci, Block hostBlock, int hostMeta) {
            String key = hostItemKey(hostBlock, hostMeta);
            if (key == null) {
                return;
            }
            hostHits.add(new HostHit(key, zi, ri, ci));
        }

        /** 层③ 规则回调入口：补一条族特有归属（{@link #SOURCE_FAMILY}）。 */
        public void addFamilyAttribution(String itemKey, int zi, int ri, int ci, String localId) {
            if (itemKey == null) {
                return;
            }
            JsonObject a = new JsonObject();
            a.addProperty("source", SOURCE_FAMILY);
            a.addProperty("frame", Integer.valueOf(frameIndex));
            JsonArray grid = new JsonArray();
            grid.add(new JsonPrimitive(Integer.valueOf(zi)));
            grid.add(new JsonPrimitive(Integer.valueOf(ri)));
            grid.add(new JsonPrimitive(Integer.valueOf(ci)));
            a.add("grid", grid);
            if (localId != null) {
                a.addProperty("localId", localId);
            }
            familyHits.add(new FamilyHit(itemKey, a));
        }
    }

    // ------------------------------------------------------------------ 文档级合并

    /**
     * 跨结构（跨帧）合并为文档根 {@code itemIndex}：按键去重、跨帧不重复、键字典序稳定；
     * part 归属 → host 归属 → family 归属三段落盘（attribution 顺序 = 权威度由高到低）。
     *
     * @return 无任何条目 ⇒ {@code null}（调用方据此完全不产出该字段，字节干净）
     */
    public static JsonObject buildDocumentIndex(List<Sink> sinks) {
        if (sinks == null || sinks.isEmpty()) {
            return null;
        }
        TreeMap<String, Entry> byKey = new TreeMap<String, Entry>();
        for (Sink s : sinks) {
            if (s == null) {
                continue;
            }
            for (Entry e : s.entries.values()) {
                Entry t = byKey.get(e.key);
                if (t == null) {
                    byKey.put(e.key, e);
                } else {
                    t.mergeFrom(e);
                }
            }
        }
        for (Sink s : sinks) {
            if (s == null) {
                continue;
            }
            for (HostHit h : s.hostHits) {
                Entry t = byKey.get(h.key);
                if (t != null) {
                    t.addAttribution(SOURCE_HOST, s.frameIndex, h.zi, h.ri, h.ci, null);
                }
            }
        }
        for (Sink s : sinks) {
            if (s == null) {
                continue;
            }
            for (FamilyHit f : s.familyHits) {
                Entry t = byKey.get(f.key);
                if (t != null) {
                    t.addAttributionJson(f.attribution);
                }
            }
        }
        if (byKey.isEmpty()) {
            return null;
        }
        JsonObject out = new JsonObject();
        for (Map.Entry<String, Entry> e : byKey.entrySet()) {
            out.add(
                e.getKey(),
                e.getValue()
                    .toJson());
        }
        return out;
    }
}
