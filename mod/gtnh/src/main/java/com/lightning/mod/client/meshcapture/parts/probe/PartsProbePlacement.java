package com.lightning.mod.client.meshcapture.parts.probe;

import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

import net.minecraft.block.Block;
import net.minecraft.entity.player.EntityPlayer;
import net.minecraft.init.Blocks;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.server.MinecraftServer;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.World;
import net.minecraft.world.WorldServer;
import net.minecraftforge.common.util.ForgeDirection;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * P0.2 探针的「真实放置」半环：在<strong>服务端世界</strong>（integrated server）里用各族自己的真实
 * 添加路径把测试部件组合放出来，让数据经正常的「服务端 → 客户端同步」通道到达客户端世界，
 * 探针再从 {@code mc.theWorld} 读取 —— 与真实游玩/真实导出看到的数据路径完全一致。
 *
 * <ul>
 * <li>AE2：{@code world.setBlock(cableBusBlock)} → {@code TileCableBus#addPart(ItemStack, ForgeDirection, player)}
 * （这就是 {@code PartPlacement.place} 服务端半环最终调用的方法）；</li>
 * <li>EnderIO：{@code world.setBlock(blockConduitBundle)} → {@code item.createConduit(stack, player)} +
 * {@code TileConduitBundle#addConduit(IConduit)}（{@code AbstractItemConduit#onItemUse} 的服务端半环，
 * 其 {@code if (!world.isRemote)} 分支内联后正是这两步）；</li>
 * <li>FMP：{@code CommonMicroClass#create(false, materialId)} + {@code Microblock#setShape(size, slot)} +
 * {@code TileMultipart.addPart(world, pos, part)}（其内部 {@code MultipartGenerator.addPart} 负责
 * 放容器方块、造 Tile、发同步包，连方块本身都不用手动放）。</li>
 * </ul>
 */
@SideOnly(Side.CLIENT)
final class PartsProbePlacement {

    /** 一个已放置的探针方块（格）。 */
    static final class Placed {

        final String family;
        final String label;
        final int x;
        final int y;
        final int z;

        Placed(String family, String label, int x, int y, int z) {
            this.family = family;
            this.label = label;
            this.x = x;
            this.y = y;
            this.z = z;
        }

        JsonObject posJson() {
            JsonObject o = new JsonObject();
            o.addProperty("family", family);
            o.addProperty("label", label);
            JsonArray p = new JsonArray();
            p.add(new JsonPrimitive(Integer.valueOf(x)));
            p.add(new JsonPrimitive(Integer.valueOf(y)));
            p.add(new JsonPrimitive(Integer.valueOf(z)));
            o.add("pos", p);
            return o;
        }
    }

    final List<Placed> placed = new ArrayList<Placed>();
    final JsonArray placementLog = new JsonArray();
    final JsonArray errors = new JsonArray();

    // ------------------------------------------------------------------ 入口

    /**
     * 在 {@code base} 附近放置三族探针组合。每个族独立 try/catch：一族失败不拖垮其它族，失败详情进 {@link #errors}。
     */
    void placeAll(MinecraftServer server, WorldServer world, EntityPlayer player, int bx, int by, int bz) {
        clearColumn(world, bx + 2, by, bz);
        clearColumn(world, bx + 3, by, bz);
        clearColumn(world, bx + 4, by, bz);
        clearColumn(world, bx + 5, by, bz);
        clearColumn(world, bx + 6, by, bz);
        clearColumn(world, bx + 7, by, bz);
        try {
            placeAe2(world, bx + 2, by, bz);
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("ae2/place: " + PartsProbeReflect.describe(t)));
        }
        try {
            placeEnderIo(world, player, bx + 4, by, bz);
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("enderio/place: " + PartsProbeReflect.describe(t)));
        }
        try {
            placeFmp(world, bx + 7, by, bz);
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("fmp/place: " + PartsProbeReflect.describe(t)));
        }
    }

    private static void clearColumn(World world, int x, int y, int z) {
        for (int dy = 0; dy < 4; dy++) {
            world.setBlockToAir(x, y + dy, z);
        }
    }

    // ------------------------------------------------------------------ P0.3 单盒（原版方块）

    /**
     * P0.3 单盒通用路径探针的放置半环：纯原版方块，{@code world.setBlock(x,y,z,block,meta,3)} 即可，
     * 无需任何 mod 特定入口。共 11 个探针格（触发文件 {@code "singleBox":true} 时才放置）：
     *
     * <pre>
     * 行 A (z=base+3)：石头（满方块对照）| 下半 slab(meta 0) | 上半 slab(meta 8)
     *                | 地面火把(meta 5，垫脚石在 y-1) | 挂墙火把(meta 1，附在西侧石柱)
     * 行 F (z=base+6)：孤立栅栏 | 东西三连栅栏（探中间格）| 四向十字栅栏（探中心格）
     * 行 C (z=base+10)：单箱(meta 2) | 相邻同向双箱(meta 2，探两格)
     * </pre>
     *
     * 邻居影响证据场景：栅栏 3 形态、箱子单/双——盒随邻居变化 ⇒ 「盒 = 导出时快照」的论据。
     */
    void placeSingleBox(WorldServer world, int bx, int by, int bz) {
        // 清场：专用世界幂等复用，先把区域扫成空气（含垫脚石所在层）
        for (int x = bx + 1; x <= bx + 12; x++) {
            for (int z = bz + 2; z <= bz + 12; z++) {
                for (int y = by - 2; y <= by + 6; y++) {
                    world.setBlockToAir(x, y, z);
                }
            }
        }

        int za = bz + 3;
        world.setBlock(bx + 2, by, za, Blocks.stone, 0, 3);
        world.setBlock(bx + 4, by, za, Blocks.stone_slab, 0, 3); // 下半
        world.setBlock(bx + 5, by, za, Blocks.stone_slab, 8, 3); // 上半
        world.setBlock(bx + 7, by - 1, za, Blocks.stone, 0, 3); // 火把垫脚石
        world.setBlock(bx + 7, by, za, Blocks.torch, 5, 3); // 地面火把
        world.setBlock(bx + 9, by, za, Blocks.stone, 0, 3); // 挂墙火把的承载柱
        world.setBlock(bx + 10, by, za, Blocks.torch, 1, 3); // 挂墙火把（附 x-1 即承载柱）

        int zf = bz + 6;
        world.setBlock(bx + 2, by, zf, Blocks.fence, 0, 3); // 孤立
        world.setBlock(bx + 4, by, zf, Blocks.fence, 0, 3); // 东西三连
        world.setBlock(bx + 5, by, zf, Blocks.fence, 0, 3);
        world.setBlock(bx + 6, by, zf, Blocks.fence, 0, 3);
        world.setBlock(bx + 9, by, zf, Blocks.fence, 0, 3); // 四向十字（中心）
        world.setBlock(bx + 8, by, zf, Blocks.fence, 0, 3);
        world.setBlock(bx + 10, by, zf, Blocks.fence, 0, 3);
        world.setBlock(bx + 9, by, zf - 1, Blocks.fence, 0, 3);
        world.setBlock(bx + 9, by, zf + 1, Blocks.fence, 0, 3);

        int zc = bz + 10;
        world.setBlock(bx + 2, by, zc, Blocks.chest, 2, 3); // 单箱
        world.setBlock(bx + 5, by, zc, Blocks.chest, 2, 3); // 双箱（西）
        world.setBlock(bx + 6, by, zc, Blocks.chest, 2, 3); // 双箱（东）

        placed.add(new Placed("singlebox", "stone-control(full-cube)", bx + 2, by, za));
        placed.add(new Placed("singlebox", "slab-bottom(meta0)", bx + 4, by, za));
        placed.add(new Placed("singlebox", "slab-top(meta8)", bx + 5, by, za));
        placed.add(new Placed("singlebox", "torch-floor(meta5)", bx + 7, by, za));
        placed.add(new Placed("singlebox", "torch-wall(meta1)", bx + 10, by, za));
        placed.add(new Placed("singlebox", "fence-isolated", bx + 2, by, zf));
        placed.add(new Placed("singlebox", "fence-ew-connected(middle-of-3)", bx + 5, by, zf));
        placed.add(new Placed("singlebox", "fence-plus-connected(center)", bx + 9, by, zf));
        placed.add(new Placed("singlebox", "chest-single", bx + 2, by, zc));
        placed.add(new Placed("singlebox", "chest-double-west", bx + 5, by, zc));
        placed.add(new Placed("singlebox", "chest-double-east", bx + 6, by, zc));
    }

    // ------------------------------------------------------------------ AE2

    /**
     * 一格「玻璃线缆 + 切換总线(NORTH) + 存储总线(UP)」，再加一格相邻纯线缆（EAST）制造连接段盒。
     * 部件 ItemStack 经 {@code AEApi.instance().definitions().parts()} 取得（真实注册表路径）。
     */
    private void placeAe2(World world, int x, int y, int z) throws Exception {
        Class<?> aeApiClass = PartsProbeReflect.cls("appeng.api.AEApi");
        Object api = aeApiClass.getMethod("instance")
            .invoke(null);
        Object defs = PartsProbeReflect.invoke(api, "definitions", new Class<?>[0]);
        Object parts = PartsProbeReflect.invoke(defs, "parts", new Class<?>[0]);

        ItemStack cable = ae2ColoredStack(parts, "cableGlass", "Transparent");
        ItemStack toggle = ae2MaybeStack(parts, "toggleBus");
        ItemStack storageBus = ae2MaybeStack(parts, "storageBus");

        Block cableBusBlock = findBlockByClass("appeng.block.networking.BlockCableBus");
        world.setBlock(x, y, z, cableBusBlock, 0, 3);
        world.setBlock(x + 1, y, z, cableBusBlock, 0, 3);
        TileEntity te = world.getTileEntity(x, y, z);
        TileEntity te2 = world.getTileEntity(x + 1, y, z);
        if (te == null || !te.getClass()
            .getName()
            .contains("TileCableBus")) {
            throw new IllegalStateException(
                "AE2 tile 未按预期生成: " + (te == null ? "null"
                    : te.getClass()
                        .getName()));
        }
        Method addPart = te.getClass()
            .getMethod("addPart", ItemStack.class, ForgeDirection.class, EntityPlayer.class);
        Object r1 = addPart.invoke(te, cable, ForgeDirection.UNKNOWN, null);
        Object r2 = addPart.invoke(te, toggle, ForgeDirection.NORTH, null);
        Object r3 = addPart.invoke(te, storageBus, ForgeDirection.UP, null);
        Object r4 = addPart.invoke(te2, cable.copy(), ForgeDirection.UNKNOWN, null);
        world.markBlockForUpdate(x, y, z);
        world.markBlockForUpdate(x + 1, y, z);

        placed.add(new Placed("ae2", "cable+toggleBus(N)+storageBus(U)", x, y, z));
        placed.add(new Placed("ae2", "neighbor-cable(E-connection)", x + 1, y, z));
        logPlacedStack("ae2/cableGlass", cable, String.valueOf(r1));
        logPlacedStack("ae2/toggleBus", toggle, String.valueOf(r2));
        logPlacedStack("ae2/storageBus", storageBus, String.valueOf(r3));
        logPlacedStack("ae2/neighborCable", cable, String.valueOf(r4));
    }

    private static ItemStack ae2ColoredStack(Object parts, String defName, String color) throws Exception {
        Object def = PartsProbeReflect.invoke(parts, defName, new Class<?>[0]);
        Class<?> aeColorClass = PartsProbeReflect.cls("appeng.api.util.AEColor");
        @SuppressWarnings({ "unchecked", "rawtypes" })
        Object colorEnum = Enum.valueOf((Class<? extends Enum>) aeColorClass, color);
        Object stack = def.getClass()
            .getMethod("stack", aeColorClass, int.class)
            .invoke(def, colorEnum, 1);
        return (ItemStack) stack;
    }

    private static ItemStack ae2MaybeStack(Object parts, String defName) throws Exception {
        Object def = PartsProbeReflect.invoke(parts, defName, new Class<?>[0]);
        Object opt = def.getClass()
            .getMethod("maybeStack", int.class)
            .invoke(def, 1);
        // 注意：AE2 的 maybeStack 返回 Guava Optional（com.google.common.base.Optional），
        // 其实现类 Present 是 package-private —— 反射调用必须打在公共抽象类 Optional 上，
        // 直接对运行时类 getMethod("isPresent") 会抛 IllegalAccessException（实测踩中）。
        Class<?> optionalClass = PartsProbeReflect.cls("com.google.common.base.Optional");
        Boolean present = (Boolean) optionalClass.getMethod("isPresent")
            .invoke(opt);
        if (!present.booleanValue()) {
            throw new IllegalStateException("AE2 definition 无 stack: " + defName);
        }
        return (ItemStack) optionalClass.getMethod("get")
            .invoke(opt);
    }

    // ------------------------------------------------------------------ EnderIO

    /**
     * 一格五种导管束（能量/物品/流体/红石/ME），相邻再放一格（能量+物品）制造连接段。
     * 导管物品取 {@code crazypants.enderio.EnderIO} 的公开静态字段（真实注册路径）。
     */
    private void placeEnderIo(World world, EntityPlayer player, int x, int y, int z) throws Exception {
        Class<?> eioClass = PartsProbeReflect.cls("crazypants.enderio.EnderIO");
        Class<?> conduitIface = PartsProbeReflect.cls("crazypants.enderio.conduit.IConduit");
        Block bundleBlock = findBlockByClass("crazypants.enderio.conduit.BlockConduitBundle");

        String[] first = { "itemPowerConduit", "itemItemConduit", "itemLiquidConduit", "itemRedstoneConduit",
            "itemMEConduit" };
        world.setBlock(x, y, z, bundleBlock, 0, 3);
        world.setBlock(x + 1, y, z, bundleBlock, 0, 3);
        TileEntity te = world.getTileEntity(x, y, z);
        TileEntity te2 = world.getTileEntity(x + 1, y, z);
        if (te == null || !te.getClass()
            .getName()
            .contains("TileConduitBundle")) {
            throw new IllegalStateException(
                "EnderIO tile 未按预期生成: " + (te == null ? "null"
                    : te.getClass()
                        .getName()));
        }
        Method addConduit = te.getClass()
            .getMethod("addConduit", conduitIface);
        for (String fieldName : first) {
            Item item = (Item) eioClass.getField(fieldName)
                .get(null);
            if (item == null) {
                errors.add(new JsonPrimitive("enderio/place: 静态物品字段为 null: " + fieldName));
                continue;
            }
            Object conduit = createConduit(item, player);
            addConduit.invoke(te, conduit);
            logPlacedStack(
                "enderio/" + fieldName,
                new ItemStack(item, 1, 0),
                conduit.getClass()
                    .getName());
        }
        // 相邻格：能量+物品，与第一格形成连接段（dir != UNKNOWN 的 CollidableComponent）
        Object power = createConduit(
            (Item) eioClass.getField("itemPowerConduit")
                .get(null),
            player);
        Object item2 = createConduit(
            (Item) eioClass.getField("itemItemConduit")
                .get(null),
            player);
        addConduit.invoke(te2, power);
        addConduit.invoke(te2, item2);
        world.markBlockForUpdate(x, y, z);
        world.markBlockForUpdate(x + 1, y, z);

        placed.add(new Placed("enderio", "bundle-5-conduits", x, y, z));
        placed.add(new Placed("enderio", "neighbor-bundle(power+item)", x + 1, y, z));
    }

    private static Object createConduit(Item item, EntityPlayer player) throws Exception {
        ItemStack stack = new ItemStack(item, 1, 0);
        Method m = item.getClass()
            .getMethod("createConduit", ItemStack.class, EntityPlayer.class);
        Object conduit = m.invoke(item, stack, player);
        if (conduit == null) {
            throw new IllegalStateException("createConduit 返回 null: " + item.getUnlocalizedName());
        }
        return conduit;
    }

    // ------------------------------------------------------------------ FMP

    /**
     * 一格两个微方块：底半台阶（face 类 size=4 slot=0，材料 stone）+ 顶面板（face 类 size=2 slot=1，
     * 另一种材料），展示「一格多部件事 + 两种物品身份」。经
     * {@code TileMultipart.addPart(world, pos, part)}（companion object 静态入口，内部走
     * {@code MultipartGenerator.addPart}：放容器方块 + 造 Tile + 发同步包）。
     */
    private void placeFmp(World world, int x, int y, int z) throws Exception {
        Class<?> mmrClass = PartsProbeReflect.cls("codechicken.microblock.MicroMaterialRegistry$");
        Object mmr = mmrClass.getField("MODULE$")
            .get(null);
        int stone = fmpMaterialId(mmrClass, mmr, "stone");
        int alt = fmpAltMaterialId(mmrClass, mmr, stone);

        Class<?> cmcClass = PartsProbeReflect.cls("codechicken.microblock.CommonMicroClass$");
        Object cmc = cmcClass.getField("MODULE$")
            .get(null);
        Object[] classes = (Object[]) cmcClass.getMethod("classes")
            .invoke(cmc);
        Object faceClass = classes[0]; // FaceMicroClass.register(0)（DefaultContent.scala）
        if (faceClass == null) {
            throw new IllegalStateException("FMP face 微方块类未注册（CommonMicroClass.classes[0] == null）");
        }

        Class<?> tmpClass = PartsProbeReflect.cls("codechicken.multipart.TileMultipart$");
        Object tmp = tmpClass.getField("MODULE$")
            .get(null);
        Class<?> blockCoordClass = PartsProbeReflect.cls("codechicken.lib.vec.BlockCoord");
        Class<?> tMultiPartClass = PartsProbeReflect.cls("codechicken.multipart.TMultiPart");
        Constructor<?> posCtor = blockCoordClass.getConstructor(int.class, int.class, int.class);
        Method addPart = tmpClass.getMethod("addPart", World.class, blockCoordClass, tMultiPartClass);
        Method create = faceClass.getClass()
            .getMethod("create", boolean.class, int.class);

        Object pos = posCtor.newInstance(Integer.valueOf(x), Integer.valueOf(y), Integer.valueOf(z));

        Object slab = create.invoke(faceClass, Boolean.FALSE, Integer.valueOf(stone));
        slab.getClass()
            .getMethod("setShape", int.class, int.class)
            .invoke(slab, 4, 0); // 底半台阶
        Object t1 = addPart.invoke(tmp, world, pos, slab);

        Object panel = create.invoke(faceClass, Boolean.FALSE, Integer.valueOf(alt));
        panel.getClass()
            .getMethod("setShape", int.class, int.class)
            .invoke(panel, 2, 1); // 顶面板
        Object t2 = addPart.invoke(tmp, world, pos, panel);

        placed.add(
            new Placed(
                "fmp",
                "slab(4,0," + fmpMaterialName(mmrClass, mmr, stone)
                    + ")+panel(2,1,"
                    + fmpMaterialName(mmrClass, mmr, alt)
                    + ")",
                x,
                y,
                z));
        JsonObject log = new JsonObject();
        log.addProperty("step", "fmp/addPart");
        log.addProperty(
            "faceClass",
            faceClass.getClass()
                .getMethod("getName")
                .invoke(faceClass)
                .toString());
        log.addProperty(
            "tileAfterSlab",
            t1 == null ? "null"
                : t1.getClass()
                    .getName());
        log.addProperty(
            "tileAfterPanel",
            t2 == null ? "null"
                : t2.getClass()
                    .getName());
        placementLog.add(log);
    }

    private static int fmpMaterialId(Class<?> mmrClass, Object mmr, String name) throws Exception {
        Object id = mmrClass.getMethod("materialID", String.class)
            .invoke(mmr, name);
        return ((Number) id).intValue();
    }

    private static String fmpMaterialName(Class<?> mmrClass, Object mmr, int id) {
        try {
            return String.valueOf(
                mmrClass.getMethod("materialName", int.class)
                    .invoke(mmr, Integer.valueOf(id)));
        } catch (Throwable t) {
            return "<id " + id + ">";
        }
    }

    /** 挑一个与 stone 不同的材料作第二部件（优先名字含 glass 的，展示跨材料物品身份）。 */
    private static int fmpAltMaterialId(Class<?> mmrClass, Object mmr, int stoneId) throws Exception {
        Object idMap = mmrClass.getMethod("getIdMap")
            .invoke(mmr);
        Object[] tuples = (Object[]) idMap;
        int fallback = -1;
        for (int i = 0; i < tuples.length; i++) {
            if (i == stoneId) {
                continue;
            }
            String name = String.valueOf(
                tuples[i].getClass()
                    .getMethod("_1")
                    .invoke(tuples[i]));
            if (fallback < 0) {
                fallback = i;
            }
            if (name.toLowerCase()
                .contains("glass")) {
                return i;
            }
        }
        return fallback >= 0 ? fallback : stoneId;
    }

    // ------------------------------------------------------------------ 小工具

    /** 按运行时类名在方块注册表里找方块（不依赖注册名拼写，注册名各版本可能不同）。 */
    private static Block findBlockByClass(String className) {
        for (Object key : Block.blockRegistry.getKeys()) {
            Block b = (Block) Block.blockRegistry.getObject(key);
            if (b != null && b.getClass()
                .getName()
                .equals(className)) {
                return b;
            }
        }
        throw new IllegalStateException("注册表里找不到方块类: " + className);
    }

    private void logPlacedStack(String step, ItemStack stack, String result) {
        JsonObject log = new JsonObject();
        log.addProperty("step", step);
        log.add("stack", PartsProbeReflect.stackIdentity(stack));
        log.addProperty("result", result);
        placementLog.add(log);
    }
}
