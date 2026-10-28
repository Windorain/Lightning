package com.lightning.mod.client.meshcapture.parts.inferred;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.block.Block;
import net.minecraft.block.BlockTorch;
import net.minecraft.client.Minecraft;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;

import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad;
import com.lightning.mod.client.meshcapture.parts.PartBox;
import com.lightning.mod.client.meshcapture.parts.PartItem;
import com.lightning.mod.client.meshcapture.parts.PartProvider;
import com.lightning.mod.client.meshcapture.parts.PartProviderContext;
import com.lightning.mod.client.meshcapture.parts.PartRecord;
import com.lightning.mod.client.meshcapture.parts.PartSource;
import com.lightning.mod.client.meshcapture.parts.inferred.GeometryIslands.Island;
import com.lightning.mod.client.meshcapture.parts.inferred.GeometryIslands.QuadGeom;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 几何推断兜底提供者 —— 三档兜底流水线的<strong>档 3</strong>（契约
 * {@code format-parts-contract.md} §7）：{@code family=inferred, tier=3, fallback=true}。
 *
 * <p>
 * 输入 = 该格<strong>客户端烘焙四边形集合</strong>（捕获产物快照，块局部 [0,1]³；
 * 真实导出来源 = {@code MeshCaptureService} 逐格捕获的 {@code CapturedBlockInstance}，
 * 经 {@link PartProviderContext#bakedQuads} 传入；探针等无产物路径由 {@link CellQuadBaker}
 * 现场烘焙——挂点口径见 CellQuadBaker 类注释）。岛扩组 =
 * {@code web/src/pure/aabb.ts} 思路的 mod 侧移植（{@link GeometryIslands}：标准四边形共享边
 * 单跳扩组 / 非标共点 BFS 整岛 / 零法线退化剔除 / 每岛 AABB + ensureMinThickness 0.1）。
 *
 * <p>
 * 契约落点：
 * <ul>
 * <li><strong>推断永不当主来源</strong>（§7）：档 1/档 2 有结果时本提供者不会被执行
 * （流水线结构保证，本类只需正确声明 {@link #tier()} = 3）；</li>
 * <li>{@code localId = "inferred:<岛序号>"}（§4，岛序号 = 四边形输入顺序的确定性分区序号）；</li>
 * <li>物品身份 / typeKey = <strong>宿主 drop 身份</strong>（§5 inferred 行：推断档无更细信息，
 * {@code getItemDropped} registry + {@code damageDropped}，与 generic 档同口径）；</li>
 * <li>{@code boxProvenance = visual-only}（拍板：盒推断自视觉烘焙几何，无碰撞盒来源；
 * 无几何退化为整格盒时标 {@code degenerate}）；盒 kind = {@code visual}；</li>
 * <li>退化情形（§7）：火把类挂墙朝向等状态信息进 {@code properties}（{@code facing=meta<N>}）；</li>
 * <li><strong>永远有结果</strong>（§7）：连可用几何都没有 ⇒ 产一个整格推断盒
 * （{@code degenerate}），不让流水线落空；</li>
 * <li><strong>已知误判（交付声明）</strong>：贴合部件并一——凡共享顶点（≤0.01）的四边形会被
 * 并成同一岛；纯几何无语义（岛与"线缆/面板"等部件概念无对应）。</li>
 * </ul>
 */
@SideOnly(Side.CLIENT)
public final class InferredGeometryPartProvider implements PartProvider {

    public static final int DEFAULT_PRIORITY = 3000;

    @Override
    public int priority() {
        return DEFAULT_PRIORITY;
    }

    @Override
    public int tier() {
        return PartSource.TIER_INFERRED;
    }

    @Override
    public String family() {
        return PartSource.FAMILY_INFERRED;
    }

    /**
     * 档 3 对任何到达本档的非满方块都适用（永远降级的最后兜底语义）；满方块快速否定与
     * 档 1/档 2 短路均在流水线层完成。
     */
    @Override
    public boolean applies(PartProviderContext ctx) {
        return ctx != null && ctx.block != null;
    }

    @Override
    public List<PartRecord> collectParts(PartProviderContext ctx) {
        List<PartRecord> out = new ArrayList<PartRecord>();
        if (ctx == null || ctx.world == null || ctx.block == null) {
            return out;
        }

        List<CapturedQuad> quads = ctx.bakedQuads;
        if (quads == null) {
            quads = CellQuadBaker.bake(ctx.world, ctx.x, ctx.y, ctx.z, ctx.block, ctx.meta);
        }

        List<QuadGeom> geoms = new ArrayList<QuadGeom>();
        for (CapturedQuad q : quads) {
            if (q == null || q.vertices == null || q.vertices.isEmpty()) {
                continue;
            }
            geoms.add(GeometryIslands.fromCaptured(q));
        }

        List<Island> islands = GeometryIslands.partition(geoms);
        if (islands.isEmpty()) {
            // 永远有结果（§7）：无可用几何 ⇒ 整格推断盒，provenance=degenerate 如实标记
            PartRecord rec = newRecord(ctx, "inferred:0", PartSource.PROVENANCE_DEGENERATE);
            rec.boxes.add(new PartBox(0.0, 0.0, 0.0, 1.0, 1.0, 1.0, PartBox.KIND_VISUAL));
            fillIdentity(rec, ctx);
            out.add(rec);
            return out;
        }

        for (int i = 0; i < islands.size(); i++) {
            Island island = islands.get(i);
            PartRecord rec = newRecord(ctx, "inferred:" + i, PartSource.PROVENANCE_VISUAL_ONLY);
            rec.boxes.add(GeometryIslands.ensureMinThickness(island.computeBox(geoms)));
            fillIdentity(rec, ctx);
            out.add(rec);
        }
        return out;
    }

    private static PartRecord newRecord(PartProviderContext ctx, String localId, String provenance) {
        PartRecord rec = new PartRecord(
            localId,
            typeKey(ctx),
            new PartSource(PartSource.FAMILY_INFERRED, true, provenance, PartSource.TIER_INFERRED));
        // 退化情形（§7）：火把类挂墙朝向进 properties（如 facing=meta1）
        if (ctx.block instanceof BlockTorch) {
            rec.properties.put("facing", "meta" + ctx.meta);
        }
        return rec;
    }

    /** 物品身份/typeKey = 宿主 drop 身份（§5 inferred 行）；显示名/说明取 drop 物品。 */
    private static void fillIdentity(PartRecord rec, PartProviderContext ctx) {
        ItemStack drop = dropStack(ctx);
        if (drop != null) {
            rec.items.add(PartItem.fromStack(drop));
            rec.displayName = safeDisplayName(drop);
            fillTooltip(rec, drop);
        } else {
            rec.displayName = safeDisplayName(hostStack(ctx));
            if (rec.tooltip.isEmpty() && rec.displayName != null) {
                rec.tooltip.add(rec.displayName);
            }
        }
    }

    private static ItemStack dropStack(PartProviderContext ctx) {
        try {
            Item drop = ctx.block.getItemDropped(ctx.meta, ctx.world.rand, 0);
            if (drop == null) {
                return null;
            }
            return new ItemStack(drop, 1, ctx.block.damageDropped(ctx.meta));
        } catch (Throwable t) {
            return null;
        }
    }

    private static ItemStack hostStack(PartProviderContext ctx) {
        try {
            return new ItemStack(ctx.block, 1, ctx.meta);
        } catch (Throwable t) {
            return null;
        }
    }

    private static String typeKey(PartProviderContext ctx) {
        ItemStack drop = dropStack(ctx);
        if (drop != null && drop.getItem() != null) {
            String reg = Item.itemRegistry.getNameForObject(drop.getItem());
            return (reg == null ? "<unregistered>" : reg) + ":" + drop.getItemDamage();
        }
        String hostReg = Block.blockRegistry.getNameForObject(ctx.block);
        return (hostReg == null ? "<unregistered>" : hostReg) + ":" + ctx.meta;
    }

    private static String safeDisplayName(ItemStack stack) {
        // 验收实证修复（degraded-all 轮）：无物品形态的宿主方块（如 FMP BlockMultipart 无
        // ItemBlock）⇒ ItemStack.item == null ⇒ getDisplayName 与 getUnlocalizedName 双双 NPE，
        // 异常逃出 collectParts 导致档 3「永远有结果」（§7）被击穿（该格部件整格缺失）。
        if (stack == null || stack.getItem() == null) {
            return "<unknown>";
        }
        try {
            return stack.getDisplayName();
        } catch (Throwable t) {
            try {
                return stack.getUnlocalizedName();
            } catch (Throwable t2) {
                return "<unknown>";
            }
        }
    }

    /** 说明 = 物品 tooltip（§8 第一优先级；与 GenericSingleBoxPartProvider 同款调用与静默容错）。 */
    private static void fillTooltip(PartRecord rec, ItemStack stack) {
        try {
            Minecraft mc = Minecraft.getMinecraft();
            if (mc.thePlayer != null) {
                @SuppressWarnings("unchecked")
                List<String> lines = stack.getTooltip(mc.thePlayer, mc.gameSettings.advancedItemTooltips);
                if (lines != null) {
                    rec.tooltip.addAll(lines);
                }
            }
        } catch (Throwable ignored) {
            // Tooltip generation failure shouldn't block export
        }
        if (rec.tooltip.isEmpty() && rec.displayName != null) {
            rec.tooltip.add(rec.displayName);
        }
    }
}
