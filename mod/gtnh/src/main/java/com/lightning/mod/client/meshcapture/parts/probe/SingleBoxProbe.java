package com.lightning.mod.client.meshcapture.parts.probe;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.block.Block;
import net.minecraft.client.Minecraft;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.util.AxisAlignedBB;
import net.minecraft.world.World;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * P0.3 单盒通用路径探针 —— 验证「盒 ≠ 整格」判定 + 原版 API 在<strong>零 mod 特定代码</strong>下
 * 覆盖 slab（上/下半）、火把、箱子、栅栏的盒、说明、计数。全部走原版编译期 API（探针目标就是原版方块，
 * 不存在反射可达性问题；读取侧与真实导出一样是客户端世界 {@code mc.theWorld}）。
 *
 * <p>
 * 三个原版盒锚点（MC1.7.10）：
 * <ul>
 * <li>{@code Block#getSelectedBoundingBoxFromPool(World,x,y,z)} —— 视觉/选择盒（世界坐标）；</li>
 * <li>{@code Block#getCollisionBoundingBoxFromPool(World,x,y,z)} —— 碰撞单盒（世界坐标；火把等返回 null）；</li>
 * <li>{@code Block#addCollisionBoxesToList(World,x,y,z,AABB,List,Entity)} —— 碰撞多盒（栅栏多盒在此；
 * mask 用整格+1 格高的世界盒以收齐超出格顶的盒）。</li>
 * </ul>
 *
 * <p>
 * <strong>MC1.7.10 实测纪律（p03-run-1 踩坑结论）</strong>：{@code getSelectedBoundingBoxFromPool} 与
 * {@code getCollisionBoundingBoxFromPool}（基类版）内部<strong>不</strong>调
 * {@code setBlockBoundsBasedOnState}，直接读 Block 单例当前 bounds 字段——bounds 是全类共享的可变状态，
 * 不先显式调 {@code setBlockBoundsBasedOnState(world,x,y,z)} 就会拿到上一次任何位置留下的陈旧值
 * （游戏内 drawSelectionBox 正是先调它再取盒）。本探针所有取盒入口统一走
 * {@link #selectedBox}/{@link #collisionBox} 封装以保证该纪律。
 *
 * <p>
 * 判定函数（§6 契约候选，终版）：{@code renderAsNormalBlock()} <strong>且</strong>选择盒 == 整格
 * <strong>且</strong>碰撞盒 == 整格 ⇒ 满方块（快速否定路径）。两个更松的变体都有实测反例：
 * 1.7.10 的火把选择盒 = 整格（BlockTorch 不设 bounds，仅靠选择盒会误判）；四向连接栅栏的
 * bounds/碰撞单盒都撑满整格（选择盒+碰撞盒仍误判）。输出坐标同时记录「世界原值」与
 * 「减格坐标归一化的 0–1 方块局部」两份。
 */
@SideOnly(Side.CLIENT)
final class SingleBoxProbe {

    private static final double EPS = 1.0E-4;

    private SingleBoxProbe() {}

    /**
     * P0.3 判定函数本体（终版）：{@code renderAsNormalBlock()} <strong>且</strong>选择盒 == 整格
     * <strong>且</strong>碰撞盒 == 整格 ⇒ 满方块（快速否定路径）。
     * 三条件的排除作用各有实测依据（p03-run-2）：
     * <ul>
     * <li>仅选择盒：火把被误判（1.7.10 BlockTorch 不设 bounds，选择盒 = 整格）；</li>
     * <li>选择盒+碰撞盒：四向连接栅栏被误判（其 bounds 撑满整格，碰撞单盒 = 整格）；</li>
     * <li>{@code renderAsNormalBlock}：补上这两类（且不会误伤玻璃/荧石等透明满方块——它们该条件为 true）。</li>
     * </ul>
     */
    static boolean isFullCube(Block block, World world, int x, int y, int z) {
        return block.renderAsNormalBlock() && isFull(selectedBox(block, world, x, y, z), x, y, z)
            && isFull(collisionBox(block, world, x, y, z), x, y, z);
    }

    /** 对照变体 A（仅选择盒）：火把被误判为整格（实测）。 */
    static boolean isFullCubeBySelectedOnly(Block block, World world, int x, int y, int z) {
        return isFull(selectedBox(block, world, x, y, z), x, y, z);
    }

    /** 对照变体 B（选择盒+碰撞盒）：四向连接栅栏被误判为整格（实测）。 */
    static boolean isFullCubeByBoxesOnly(Block block, World world, int x, int y, int z) {
        return isFull(selectedBox(block, world, x, y, z), x, y, z)
            && isFull(collisionBox(block, world, x, y, z), x, y, z);
    }

    private static boolean isFull(AxisAlignedBB bb, int x, int y, int z) {
        return bb != null && eq(bb.minX, x)
            && eq(bb.minY, y)
            && eq(bb.minZ, z)
            && eq(bb.maxX, x + 1)
            && eq(bb.maxY, y + 1)
            && eq(bb.maxZ, z + 1);
    }

    private static boolean eq(double a, double b) {
        return Math.abs(a - b) < EPS;
    }

    /** 取视觉盒：先显式 {@code setBlockBoundsBasedOnState}（见类注释的 1.7.10 纪律）。 */
    private static AxisAlignedBB selectedBox(Block block, World world, int x, int y, int z) {
        block.setBlockBoundsBasedOnState(world, x, y, z);
        return block.getSelectedBoundingBoxFromPool(world, x, y, z);
    }

    /** 取碰撞单盒：先显式 {@code setBlockBoundsBasedOnState}（见类注释的 1.7.10 纪律）。 */
    private static AxisAlignedBB collisionBox(Block block, World world, int x, int y, int z) {
        block.setBlockBoundsBasedOnState(world, x, y, z);
        return block.getCollisionBoundingBoxFromPool(world, x, y, z);
    }

    /**
     * 读取一格的三种盒 + 判定结果 + 物品身份。失败不抛出：细节进 {@code errors[]}。
     * {@code partCount} 供 Automation 成败判据复用：非满方块记 1，满方块（快速否定）记 0。
     */
    static JsonObject probeBlock(Minecraft mc, int x, int y, int z) {
        JsonObject o = new JsonObject();
        JsonArray errors = new JsonArray();
        o.add("errors", errors);
        try {
            World world = mc.theWorld;
            if (world == null) {
                errors.add(new JsonPrimitive("client world is null"));
                o.addProperty("partCount", Integer.valueOf(0));
                return o;
            }
            if (!world.blockExists(x, y, z)) {
                errors.add(new JsonPrimitive("chunk not loaded at probe position"));
                o.addProperty("partCount", Integer.valueOf(0));
                return o;
            }
            Block block = world.getBlock(x, y, z);
            int meta = world.getBlockMetadata(x, y, z);
            o.addProperty("registryName", Block.blockRegistry.getNameForObject(block));
            o.addProperty(
                "blockClass",
                block.getClass()
                    .getName());
            o.addProperty("meta", Integer.valueOf(meta));

            // 判定辅助信号（供契约比较：盒判定 vs 渲染标志判定）
            o.addProperty("isOpaqueCube", Boolean.valueOf(block.isOpaqueCube()));
            o.addProperty("renderAsNormalBlock", Boolean.valueOf(block.renderAsNormalBlock()));
            try {
                o.addProperty("isNormalCube", Boolean.valueOf(block.isNormalCube(world, x, y, z)));
            } catch (Throwable t) {
                errors.add(new JsonPrimitive("isNormalCube: " + PartsProbeReflect.describe(t)));
            }

            // ① 视觉盒（先显式 setBlockBoundsBasedOnState；世界坐标 → 归一化）
            AxisAlignedBB sel = selectedBox(block, world, x, y, z);
            if (sel == null) {
                errors.add(new JsonPrimitive("getSelectedBoundingBoxFromPool returned null"));
            } else {
                o.add("selectedBoxWorld", PartsProbeReflect.aabb(sel));
                o.add("selectedBoxLocal", PartsProbeReflect.aabb(normalize(sel, x, y, z)));
            }

            // ② 碰撞单盒（先显式 setBlockBoundsBasedOnState；火把类返回 null = 无碰撞）
            AxisAlignedBB col = collisionBox(block, world, x, y, z);
            if (col == null) {
                o.addProperty("collisionBoxSingle", "null (no collision)");
            } else {
                o.add("collisionBoxSingleWorld", PartsProbeReflect.aabb(col));
                o.add("collisionBoxSingleLocal", PartsProbeReflect.aabb(normalize(col, x, y, z)));
            }

            // ③ 碰撞多盒（mask 放宽到整格上方+1，栅栏 1.5 高的盒也能收齐）
            List<AxisAlignedBB> boxes = new ArrayList<AxisAlignedBB>();
            AxisAlignedBB mask = AxisAlignedBB.getBoundingBox(x, y, z, x + 1, y + 2, z + 1);
            block.addCollisionBoxesToList(world, x, y, z, mask, boxes, null);
            JsonArray multi = new JsonArray();
            for (AxisAlignedBB bb : boxes) {
                multi.add(PartsProbeReflect.aabb(normalize(bb, x, y, z)));
            }
            o.add("collisionBoxesMultiLocal", multi);
            o.addProperty("collisionBoxesMultiCount", Integer.valueOf(boxes.size()));

            // setBlockBoundsBasedOnState 之后的方块局部 bounds 字段（原版取盒的内部状态，0–1 方块局部）
            try {
                block.setBlockBoundsBasedOnState(world, x, y, z);
                o.add(
                    "blockBoundsLocal",
                    PartsProbeReflect.doubles(
                        new double[] { block.getBlockBoundsMinX(), block.getBlockBoundsMinY(),
                            block.getBlockBoundsMinZ(), block.getBlockBoundsMaxX(), block.getBlockBoundsMaxY(),
                            block.getBlockBoundsMaxZ() }));
            } catch (Throwable t) {
                errors.add(new JsonPrimitive("boundsFields: " + PartsProbeReflect.describe(t)));
            }

            // 判定函数结论（终版用于 partCount；两个对照变体仅记录）
            boolean full = isFullCube(block, world, x, y, z);
            o.addProperty("judgedFullCube", Boolean.valueOf(full));
            o.addProperty(
                "judgedFullCubeBySelectedOnly",
                Boolean.valueOf(isFullCubeBySelectedOnly(block, world, x, y, z)));
            o.addProperty("judgedFullCubeByBoxesOnly", Boolean.valueOf(isFullCubeByBoxesOnly(block, world, x, y, z)));
            o.addProperty("partCount", Integer.valueOf(full ? 0 : 1));

            // ④ 物品身份：方块物品本身（计数口径 = 可合成物品）
            try {
                o.add("itemByMeta", PartsProbeReflect.stackIdentity(new ItemStack(block, 1, meta)));
            } catch (Throwable t) {
                errors.add(new JsonPrimitive("itemByMeta: " + PartsProbeReflect.describe(t)));
            }
            try {
                Item drop = block.getItemDropped(meta, world.rand, 0);
                int dropMeta = block.damageDropped(meta);
                o.add(
                    "itemDropped",
                    PartsProbeReflect.stackIdentity(drop == null ? null : new ItemStack(drop, 1, dropMeta)));
            } catch (Throwable t) {
                errors.add(new JsonPrimitive("itemDropped: " + PartsProbeReflect.describe(t)));
            }
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("fatal: " + PartsProbeReflect.describe(t)));
            o.addProperty("partCount", Integer.valueOf(0));
        }
        return o;
    }

    /** 世界坐标盒 → 0–1 方块局部（减格坐标；不裁剪，>1 的值如实保留，如栅栏 1.5 高碰撞盒）。 */
    private static AxisAlignedBB normalize(AxisAlignedBB bb, int x, int y, int z) {
        return AxisAlignedBB
            .getBoundingBox(bb.minX - x, bb.minY - y, bb.minZ - z, bb.maxX - x, bb.maxY - y, bb.maxZ - z);
    }
}
