package com.lightning.mod.client.meshcapture.parts;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import net.minecraft.block.Block;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 导出集成器 —— 把 {@link PartCapturePipeline} 的逐格结果按契约
 * {@code format-parts-contract.md} §2 落盘为结构根 {@code cellPartsGrid} + {@code partLists}，
 * 并在文档级补齐 {@code statsTemplate} 默认值与部件物品图标（{@code partIconTextures}）。
 *
 * <p>
 * 契约落点：
 * <ul>
 * <li>{@code cellPartsGrid} 与 {@code cellGrid} 同形同下标 {@code [z][row][column]}，值 = 本结构
 * {@code partLists} 下标，{@link #PARTS_GRID_NONE} = -1 表示该格无部件（满方块格必为 -1，§2）；</li>
 * <li>{@code partLists} 内容签名去重（§2.1）：签名输入 = local id 序列 + 类型键 + 盒 + 物品身份
 * （displayName/tooltip/properties 不参与签名——盒是快照，签名天然区分邻居形态）；</li>
 * <li>说明链（§8）：部件物品说明由提供者在导出时生成完毕；本类只补<strong>宿主回退</strong>档——
 * 部件说明仍为空时落宿主方块 tooltip + 部件定位后缀（任何情况有话说）；displayName 缺省回退
 * 宿主显示名 + 定位后缀（尊重游戏内显示名，硬约束）；</li>
 * <li>{@code statsTemplate}（文档级默认，camelCase 落盘权威）：{@code {mode:"auto",groups:[],
 * showOthers:true}} = 部件物品清单视图；<strong>仅当文档含部件数据时写入</strong>（无部件文件
 * 字节级干净，既有口径）；</li>
 * <li>部件图标：{@code partIconTextures} = {@code iconKey → base64 PNG}（iconKey =
 * {@link PartItem#iconKey()} 物品身份键，与 web 统计栏通道 1 纹理源约定一致；
 * <strong>契约留白登记</strong>：部件图标落盘字段名契约未定，本类拍板此形状并上报）；</li>
 * <li>物品索引表（契约 §9）：本类只负责<strong>逐格采集贡献</strong>（
 * {@link ItemIndexIntegrator.Sink}：层①部件主物品 + 层②宿主格候选，含说明行与归属），
 * 文档根 {@code itemIndex} 的按键去重/跨帧合并/落盘由 {@code MeshCaptureService} 收尾段调用
 * {@link ItemIndexIntegrator#buildDocumentIndex(java.util.List)} 完成；</li>
 * <li><strong>字节干净硬约束</strong>：无部件 ⇒ {@code cellPartsGrid}/{@code partLists}/
 * {@code statsTemplate}/{@code partIconTextures}/{@code itemIndex} 五字段完全不产出，
 * {@code blockPalette} 条目亦不附 {@code hostItem}，其余字节零改动。</li>
 * </ul>
 */
@SideOnly(Side.CLIENT)
public final class PartExportIntegrator {

    /** {@code cellPartsGrid} 空值（契约 §2：-1 = 该格无部件）。 */
    public static final int PARTS_GRID_NONE = -1;

    /**
     * 探针 A/B 开关（默认 true 生产路径恒定开启）：false 时 {@code MeshCaptureService} 完全跳过
     * 逐格 {@code collectParts} 调用 —— 用于「满方块-only 结构导出与基线字节一致」的对照实验
     * （enabled-but-no-parts vs disabled 哈希对证据）。生产代码不得触碰。
     */
    private static volatile boolean enabled = true;

    private PartExportIntegrator() {}

    public static boolean isEnabled() {
        return enabled;
    }

    /** 探针专用（parts/probe 验证分支）；生产路径不得调用。 */
    public static void setEnabledForProbe(boolean value) {
        enabled = value;
    }

    // ------------------------------------------------------------------ 结构级汇聚

    /** 一个结构的部件落盘汇聚器（cellPartsGrid + partLists 池 + 唯一物品身份收集 + 物品索引贡献）。 */
    public static final class StructureSink {

        private final int[][][] grid;
        private final JsonArray partLists = new JsonArray();
        private final Map<String, Integer> sigToIndex = new HashMap<String, Integer>();
        /** iconKey → PartItem（首次出现），供文档级图标嵌入；LinkedHashMap 保序 = 幂等。 */
        private final Map<String, PartItem> uniqueItems = new LinkedHashMap<String, PartItem>();
        private final Set<String> providerFailures = new LinkedHashSet<String>();
        /** 物品索引表（契约 §9）本结构的贡献；文档级按键去重/跨帧合并在 MeshCaptureService 收尾。 */
        private final ItemIndexIntegrator.Sink itemIndex;
        private int cellsWithParts;

        private StructureSink(int frameIndex, int sizeZ, int sizeRow, int sizeCol) {
            itemIndex = new ItemIndexIntegrator.Sink(frameIndex);
            grid = new int[sizeZ][sizeRow][sizeCol];
            for (int zi = 0; zi < sizeZ; zi++) {
                for (int ri = 0; ri < sizeRow; ri++) {
                    for (int ci = 0; ci < sizeCol; ci++) {
                        grid[zi][ri][ci] = PARTS_GRID_NONE;
                    }
                }
            }
        }

        /**
         * 逐格入口（{@code MeshCaptureService} 捕获循环内一次性调用）：
         * 满方块/零产出格不动（grid 保持 -1）；非满有产出格 ⇒ 补说明链回退、收集物品身份、
         * 采集物品索引贡献（契约 §9 层①②）、签名去重入池、写 grid 下标。任何异常向上抛由调用方
         * 容错（流水线本身绝不抛出）。
         */
        public void addCell(int zi, int ri, int ci, PartCaptureResult r, List<String> hostTooltip, Block hostBlock,
            int hostMeta) {
            if (r == null) {
                return;
            }
            providerFailures.addAll(r.providerFailures);
            if (r.hostFullCube || r.parts.isEmpty()) {
                return;
            }
            // 层② 宿主级物品身份（契约 §9）：该格宿主方块的自身物品身份 → 该格归属候选
            itemIndex.addHostCell(zi, ri, ci, hostBlock, hostMeta);
            for (PartRecord p : r.parts) {
                // 物品级说明（层①）取宿主回退之前的物品 tooltip（§8 第一优先级），
                // 与 PartRecord.tooltip 同源生成、各自保留（不做口径合并）
                List<String> itemTooltipBeforeChain = new ArrayList<String>(p.tooltip);
                applyTooltipChain(p, hostTooltip, hostBlock, hostMeta);
                itemIndex.addPart(zi, ri, ci, p, itemTooltipBeforeChain);
                for (PartItem it : p.items) {
                    if (it != null && !uniqueItems.containsKey(it.iconKey())) {
                        uniqueItems.put(it.iconKey(), it);
                    }
                }
            }
            String sig = partListSignature(r.parts);
            Integer idx = sigToIndex.get(sig);
            if (idx == null) {
                idx = Integer.valueOf(partLists.size());
                sigToIndex.put(sig, idx);
                JsonArray list = new JsonArray();
                for (PartRecord p : r.parts) {
                    list.add(p.toJson());
                }
                partLists.add(list);
            }
            grid[zi][ri][ci] = idx.intValue();
            cellsWithParts++;
        }

        public boolean hasParts() {
            return cellsWithParts > 0;
        }

        public Map<String, PartItem> uniquePartItems() {
            return uniqueItems;
        }

        /** 物品索引表（契约 §9）本结构的贡献（文档级合并由收尾段完成）。 */
        public ItemIndexIntegrator.Sink itemIndexSink() {
            return itemIndex;
        }

        /** 有部件 ⇒ 写 {@code cellPartsGrid} + {@code partLists}；无部件 ⇒ 两字段完全不产出（字节干净）。 */
        public void writeInto(JsonObject structure) {
            if (!hasParts() || structure == null) {
                return;
            }
            JsonArray gridJson = new JsonArray();
            for (int zi = 0; zi < grid.length; zi++) {
                JsonArray rows = new JsonArray();
                for (int ri = 0; ri < grid[zi].length; ri++) {
                    JsonArray cols = new JsonArray();
                    for (int ci = 0; ci < grid[zi][ri].length; ci++) {
                        cols.add(new JsonPrimitive(Integer.valueOf(grid[zi][ri][ci])));
                    }
                    rows.add(cols);
                }
                gridJson.add(rows);
            }
            structure.add("cellPartsGrid", gridJson);
            structure.add("partLists", partLists);
            for (String f : providerFailures) {
                FMLLog.warning("[SDE] 部件导出：提供者失败留痕 %s", f);
            }
        }

        /**
         * 说明链（§8）的宿主回退档：部件物品说明（提供者已生成）为空 ⇒ 宿主方块 tooltip +
         * 部件定位后缀；displayName 缺省 ⇒ 宿主显示名 + 定位后缀。任何情况有话说。
         */
        private static void applyTooltipChain(PartRecord p, List<String> hostTooltip, Block hostBlock, int hostMeta) {
            if (p.displayName == null || p.displayName.isEmpty()) {
                p.displayName = hostDisplayName(hostBlock, hostMeta) + " (" + p.localId + ")";
            }
            if (p.tooltip.isEmpty()) {
                if (hostTooltip != null && !hostTooltip.isEmpty()) {
                    for (int i = 0; i < hostTooltip.size(); i++) {
                        String line = hostTooltip.get(i);
                        p.tooltip.add(i == 0 ? line + " [" + p.localId + "]" : line);
                    }
                } else {
                    p.tooltip.add(p.displayName);
                }
            }
        }

        private static String hostDisplayName(Block hostBlock, int hostMeta) {
            try {
                ItemStack stack = new ItemStack(hostBlock, 1, hostMeta);
                return stack.getDisplayName();
            } catch (Throwable t) {
                return "<unknown>";
            }
        }

        /** partLists 内容签名（§2.1）：local id 序列 + 类型键 + 盒 + 物品身份。 */
        private static String partListSignature(List<PartRecord> parts) {
            JsonArray sig = new JsonArray();
            for (PartRecord p : parts) {
                JsonObject s = new JsonObject();
                s.addProperty("localId", p.localId);
                s.addProperty("typeKey", p.typeKey);
                JsonArray bs = new JsonArray();
                for (PartBox b : p.boxes) {
                    bs.add(b.toJson());
                }
                s.add("boxes", bs);
                JsonArray is = new JsonArray();
                for (PartItem it : p.items) {
                    is.add(it.toJson());
                }
                s.add("items", is);
                sig.add(s);
            }
            return sig.toString();
        }
    }

    /**
     * @param frameIndex 该结构所属帧下标（单文件文档 = 0；World 文档 = 帧 index）——
     *                   物品索引表归属条目按帧定位（契约 §9 跨帧不重复）
     */
    public static StructureSink newStructureSink(int frameIndex, int sizeZ, int sizeRow, int sizeCol) {
        return new StructureSink(frameIndex, sizeZ, sizeRow, sizeCol);
    }

    /** 单文件文档便捷入口（帧下标 = 0）。 */
    public static StructureSink newStructureSink(int sizeZ, int sizeRow, int sizeCol) {
        return new StructureSink(0, sizeZ, sizeRow, sizeCol);
    }

    // ------------------------------------------------------------------ 文档级收尾

    /**
     * 文档根 {@code statsTemplate} 默认值（文档级默认，camelCase 落盘权威）：部件物品清单视图
     * （typeKey 分组计数）。<strong>仅当文档含部件数据时由调用方写入</strong>。
     */
    public static JsonObject defaultStatsTemplate() {
        JsonObject o = new JsonObject();
        o.addProperty("mode", "auto");
        o.add("groups", new JsonArray());
        o.addProperty("showOthers", Boolean.TRUE);
        return o;
    }

    /**
     * 部件物品图标嵌入（{@code partIconTextures}：iconKey → base64 PNG）。
     * 物品栈由身份键重建（{@code ItemStack(item, 1, damage)}）——NBT 级变体（如 FMP 材料）
     * 的图标为基础物品图标（已知限制，登记上报）；单键渲染失败静默跳过（web 端走回退链）。
     * 一个图标都渲染不出 ⇒ 字段不产出。
     */
    public static void embedPartIcons(JsonObject documentRoot, Map<String, PartItem> items) {
        if (documentRoot == null || items == null || items.isEmpty()) {
            return;
        }
        JsonObject icons = new JsonObject();
        for (Map.Entry<String, PartItem> e : items.entrySet()) {
            try {
                PartItem it = e.getValue();
                Item item = (Item) Item.itemRegistry.getObject(it.registry);
                if (item == null) {
                    continue;
                }
                String b64 = PartIconRenderer.renderToBase64PNG(new ItemStack(item, 1, it.damage));
                if (b64 != null && !b64.isEmpty()) {
                    icons.addProperty(e.getKey(), b64);
                }
            } catch (Throwable ignored) {
                // 单键失败不中断导出（web 端回退链兜底）
            }
        }
        if (icons.entrySet()
            .size() > 0) {
            documentRoot.add("partIconTextures", icons);
        }
    }
}
