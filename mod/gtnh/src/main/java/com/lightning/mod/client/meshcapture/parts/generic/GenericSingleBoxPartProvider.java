package com.lightning.mod.client.meshcapture.parts.generic;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.block.Block;
import net.minecraft.client.Minecraft;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.util.AxisAlignedBB;
import net.minecraft.world.World;

import com.lightning.mod.client.meshcapture.parts.PartBox;
import com.lightning.mod.client.meshcapture.parts.PartItem;
import com.lightning.mod.client.meshcapture.parts.PartProvider;
import com.lightning.mod.client.meshcapture.parts.PartProviderContext;
import com.lightning.mod.client.meshcapture.parts.PartRecord;
import com.lightning.mod.client.meshcapture.parts.PartSource;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 单盒通用提供者 —— 三档兜底流水线的<strong>档 2</strong>（契约
 * {@code format-parts-contract.md} §7）：{@code family=generic, tier=2, fallback=true}。
 *
 * <p>
 * 对<strong>任何</strong>非满方块用原版 API 取盒（视觉盒 + 碰撞单盒 + 碰撞多盒），
 * <strong>零 mod 特定代码</strong>。满方块已被 {@code PartCapturePipeline} 快速否定拦截，
 * 不会到达本提供者。
 *
 * <p>
 * 契约落点：
 * <ul>
 * <li>取盒纪律（§6.2）：每次取盒前显式 {@code setBlockBoundsBasedOnState(world,x,y,z)}
 * （1.7.10 基类取盒内部不调，直接读共享单例 bounds，实测踩坑）；</li>
 * <li>坐标系（§6.1/§6.3）：世界坐标减格坐标归一化为 0–1 方块局部 Y-up；越界盒如实记录不裁剪
 * （栅栏碰撞盒 maxY=1.5）；</li>
 * <li>碰撞多盒 mask 放宽到整格上方 +1（否则栅栏 1.5 高的盒被过滤）；</li>
 * <li>退化情形（§7）：{@code renderAsNormalBlock()=false} 且选择盒 == 整格且
 * 碰撞 null/空（火把类）⇒ <strong>不产出</strong>，交档 3 几何推断；</li>
 * <li>物品身份 = drop 身份（§5：{@code getItemDropped} registry + {@code damageDropped}，
 * 不是方块 meta——上/下半 slab 同为 {@code stone_slab:0}，朝向 meta 坍缩；石头→cobblestone
 * 特例即由此而来）；显示名取物品显示名；</li>
 * <li>{@code localId = "generic:0"}（§4：单盒通用档一格一个部件）；
 * {@code typeKey = <drop registry>:<damageDropped>}。</li>
 * </ul>
 */
@SideOnly(Side.CLIENT)
public final class GenericSingleBoxPartProvider implements PartProvider {

    public static final int DEFAULT_PRIORITY = 2000;

    private static final double EPS = 1.0E-4;
    private static final String LOCAL_ID = "generic:0";

    @Override
    public int priority() {
        return DEFAULT_PRIORITY;
    }

    @Override
    public int tier() {
        return PartSource.TIER_GENERIC;
    }

    @Override
    public String family() {
        return PartSource.FAMILY_GENERIC;
    }

    /**
     * 通用档对任何非满方块都适用（零 mod 特定代码的兜底语义）；满方块快速否定在流水线层完成。
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
        World world = ctx.world;
        Block block = ctx.block;
        int x = ctx.x;
        int y = ctx.y;
        int z = ctx.z;

        // ① 视觉盒（§6.2 纪律：先显式 setBlockBoundsBasedOnState）
        block.setBlockBoundsBasedOnState(world, x, y, z);
        AxisAlignedBB selWorld = block.getSelectedBoundingBoxFromPool(world, x, y, z);
        PartBox visual = selWorld == null ? null : PartBox.fromWorld(selWorld, x, y, z, PartBox.KIND_VISUAL);

        // ② 碰撞单盒（同纪律；火把类返回 null = 无碰撞）
        block.setBlockBoundsBasedOnState(world, x, y, z);
        AxisAlignedBB colSingleWorld = block.getCollisionBoundingBoxFromPool(world, x, y, z);

        // ③ 碰撞多盒（mask 放宽到整格上方 +1，收齐栅栏 1.5 高的盒；实测口径）
        List<AxisAlignedBB> multiWorld = new ArrayList<AxisAlignedBB>();
        try {
            AxisAlignedBB mask = AxisAlignedBB.getBoundingBox(x, y, z, x + 1, y + 2, z + 1);
            block.addCollisionBoxesToList(world, x, y, z, mask, multiWorld, null);
        } catch (Throwable ignored) {
            // 个别方块多盒枚举失败 ⇒ 按空多盒处理，退化判定与单盒兜底仍能给出正确结果
        }

        // 退化情形（§7）：renderAsNormalBlock=false 且选择盒==整格且 碰撞 null/空（火把类）
        // ⇒ 不产出，交档 3（其"通用盒"= 整格既无信息又误导；真实小柱几何只在渲染代码里）。
        boolean collisionEmpty = colSingleWorld == null && multiWorld.isEmpty();
        if (!block.renderAsNormalBlock() && visual != null && visual.isFullCell(EPS) && collisionEmpty) {
            return out;
        }

        PartRecord rec = new PartRecord(
            LOCAL_ID,
            typeKey(ctx),
            new PartSource(
                PartSource.FAMILY_GENERIC,
                true,
                provenance(visual, colSingleWorld, multiWorld),
                PartSource.TIER_GENERIC));
        if (visual != null) {
            rec.boxes.add(visual);
        }
        // 碰撞盒：多盒是权威碰撞形态（四向栅栏 2 根杆）；多盒空则回退单盒
        if (!multiWorld.isEmpty()) {
            for (AxisAlignedBB bb : multiWorld) {
                rec.boxes.add(PartBox.fromWorld(bb, x, y, z, PartBox.KIND_COLLISION));
            }
        } else if (colSingleWorld != null) {
            rec.boxes.add(PartBox.fromWorld(colSingleWorld, x, y, z, PartBox.KIND_COLLISION));
        }

        // 物品身份 = drop 身份（§5）；显示名/说明取物品（§3 的 {@code displayName}/{@code tooltip} 行、§8 第一优先级 = 物品说明）
        ItemStack dropStack = dropStack(ctx);
        if (dropStack != null) {
            rec.items.add(PartItem.fromStack(dropStack));
            rec.displayName = safeDisplayName(dropStack);
            fillTooltip(rec, dropStack);
        } else {
            // 无对应可合成物品 ⇒ 显式标"无"（items 留空数组，§3）；typeKey 已回退宿主身份
            rec.displayName = safeDisplayName(hostStack(ctx));
        }
        out.add(rec);
        return out;
    }

    /**
     * drop 身份栈：{@code getItemDropped(meta) + damageDropped(meta)}（§5）。
     * 返回 null 表示该方块无掉落物品（{@code getItemDropped} 返回 null）。
     */
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

    /** 宿主方块物品栈（typeKey/显示名的回退来源）。 */
    private static ItemStack hostStack(PartProviderContext ctx) {
        try {
            return new ItemStack(ctx.block, 1, ctx.meta);
        } catch (Throwable t) {
            return null;
        }
    }

    /** typeKey = drop 身份（§5）；无掉落时回退宿主方块身份（registry:meta），保证五要素不缺。 */
    private static String typeKey(PartProviderContext ctx) {
        ItemStack drop = dropStack(ctx);
        if (drop != null && drop.getItem() != null) {
            String reg = Item.itemRegistry.getNameForObject(drop.getItem());
            return (reg == null ? "<unregistered>" : reg) + ":" + drop.getItemDamage();
        }
        String hostReg = Block.blockRegistry.getNameForObject(ctx.block);
        return (hostReg == null ? "<unregistered>" : hostReg) + ":" + ctx.meta;
    }

    private static String provenance(PartBox visual, AxisAlignedBB colSingle, List<AxisAlignedBB> multi) {
        boolean hasVisual = visual != null;
        boolean hasCollision = colSingle != null || !multi.isEmpty();
        if (hasVisual && hasCollision) {
            return PartSource.PROVENANCE_BOTH;
        }
        if (hasVisual) {
            return PartSource.PROVENANCE_VISUAL_ONLY;
        }
        return PartSource.PROVENANCE_COLLISION_ONLY;
    }

    private static String safeDisplayName(ItemStack stack) {
        // 与 InferredGeometryPartProvider 同款守卫（实测）：无物品形态宿主方块
        // （ItemStack.item == null）时两个取名路径都 NPE，必须兜底保「导出绝不中断」。
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

    /** 说明 = 物品 tooltip（§8 第一优先级；复用 MeshCaptureService L426–446 同款调用与静默容错）。 */
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
