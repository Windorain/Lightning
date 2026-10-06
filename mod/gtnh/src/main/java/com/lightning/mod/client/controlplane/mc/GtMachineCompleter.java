package com.lightning.mod.client.controlplane.mc;

import java.lang.reflect.Method;

import net.minecraft.block.Block;
import net.minecraft.entity.player.EntityPlayer;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.World;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;

import cpw.mods.fml.common.registry.GameRegistry;

/**
 * GregTech 机器补全器（族名 {@code gt-machine}）——经 <b>GT 自己的放置路径</b>
 * {@code gregtech.common.blocks.ItemMachines#placeBlockAt} 放下<b>可运行</b>的 MetaTileEntity。
 *
 * <h2>为什么 {@code world.setBlock} 不够（issue #117 的问题本体）</h2>
 * GT 的机器方块（{@code gregtech:gt.blockmachines}）在 {@code setBlock} 之后只是一个
 * {@code BaseMetaTileEntity} <b>空壳</b>：{@code mID == 0}，{@code getMetaTileEntity() == null}。
 * 真正创建 MetaTileEntity 的是 {@code ItemBlock} 的放置路径：
 * {@code ItemMachines.placeBlockAt} → {@code setBlock(..., getTileEntityBaseType(), 3)} →
 * {@code IGregTechTileEntity.setInitialValuesAsNBT(stackNBT, tDamage)} →
 * {@code createNewMetatileEntity(mID)} →{@code METATILEENTITIES[mID].newMetaEntity(this)}
 * （GT5U {@code gregtech/common/blocks/ItemMachines.java:239-289}；
 * {@code gregtech/api/metatileentity/BaseMetaTileEntity.java:165-169}；
 * {@code gregtech/api/metatileentity/CommonBaseMetaTileEntity.java:62-79}）。
 * {@code setBlock} 直接铺出来的壳连 tick 都不跑（{@code createNewMetatileEntity} 拒绝 {@code aID <= 0}
 * 并打印 {@code "MetaID x not loadable => locking TileEntity!"}）。
 *
 * <h2>权威调用链（源码实证，本树运行期 GT5-Unofficial 5.09.52.283）</h2>
 * <ol>
 * <li>{@link GtItemList} 取物品栈（{@code machine} 形式）或由 {@code item}+{@code meta} 构造（显式形式）；</li>
 * <li>方块身份校验：物品对应的方块必须是 {@code gregtech.common.blocks.BlockMachines}
 * ——挡住「拿别的方块冒充 GT 机器」；</li>
 * <li>MetaTileEntity 存在性校验：{@code GregTechAPI.METATILEENTITIES[metaTileId] != null}
 * （空位会被 {@code createNewMetatileEntity} 拒绝并锁 TE）；</li>
 * <li><b>幂等</b>：该位置已是同 id 的活动 MetaTileEntity → 只补一次 {@code markBlockForUpdate} 返回；</li>
 * <li>否则先清场（{@code setBlockToAir}），保证 {@code setBlock} 一定重建 TE——与 LP 补全器的
 * 「te 步自带清场」同一口径（{@link LpPipeCompleter}）；</li>
 * <li>{@code ItemMachines.placeBlockAt(stack, player, world, x, y, z, side, .5, 1, .5, 0)}——一次调用
 * 完成 setBlock + TE 创建 + {@code initDefaultModes} + {@code onBlockPlacedBy}/{@code onPostBlockPlaced}；</li>
 * <li><b>读回验证</b>：{@code getMetaTileID() == metaTileId} 且 {@code getMetaTileEntity() != null}，
 * 否则 {@code CP-EXEC-001}（这正是「空壳」与「可运行机器」的分界，也是段二负对照的判据）；</li>
 * <li>{@code world.markBlockForUpdate(x,y,z)}（契约 §6.4 的权威同步路径留痕）。</li>
 * </ol>
 *
 * <h2>params 是「放置输入」，不是 NBT 回填（contract.md §6.5）</h2>
 * 见 {@link GtMachineParams}：只接受「放哪台机器（ItemList 常量或 item+meta）」与「放哪一面」；
 * <b>没有</b>任何 TE 字段名，也不收 {@code nbt}——机器初始状态由 GT 自己的
 * {@code createNewMetatileEntity} + {@code initDefaultModes} 产生（等价于玩家手持新机器放下）。
 *
 * <h2>与 {@code block} 步的关系</h2>
 * 本补全器<b>自带放置</b>，用例无需（也不该）先用 {@code block} 步铺 GT 机器方块：那样只会先铺一个
 * 空壳、再被本步清掉重放。若用例确实先铺了，本步的幂等判定会发现「不是同 id 的活动机器」并重建，
 * 结果一致（幂等重建）。
 *
 * <h2>为什么全反射</h2>
 * GT 在本树是 {@code compileOnly} 依赖、运行期由整合包提供（见 {@code dependencies.gradle}）；
 * 与 LP/AE2 族同一口径（{@link ModReflect} 的类注释）：硬 import 会在 GT 缺席时于类加载期抛
 * {@link NoClassDefFoundError}，连控制面自身都起不来。缺席由 {@link ModTeFamilies} 探测并跳过注册。
 */
public final class GtMachineCompleter implements TeCompleter {

    /** 注册名（{@code build[i].completer} 的取值，契约 §6.5 注册表）。 */
    public static final String NAME = "gt-machine";

    /** GT 的机器 ItemBlock（放置路径的宿主）。 */
    static final String GT_ITEM_MACHINES_CLASS = "gregtech.common.blocks.ItemMachines";

    /** GT 的机器方块类（身份校验用）。 */
    static final String GT_BLOCK_MACHINES_CLASS = "gregtech.common.blocks.BlockMachines";

    /** GT 的方块实体接口（「这里到底有没有 MetaTileEntity」的权威判据）。 */
    static final String GT_TILE_INTERFACE = "gregtech.api.interfaces.tileentity.IGregTechTileEntity";

    /** MetaTileEntity 原型表（id → 原型）。 */
    static final String GT_API_CLASS = "gregtech.api.GregTechAPI";

    @Override
    public String name() {
        return NAME;
    }

    @Override
    public boolean complete(WorldServer world, int x, int y, int z, JsonObject params) {
        if (world == null) {
            return false;
        }
        Class<?> itemMachines = ModReflect.load(GT_ITEM_MACHINES_CLASS);
        Class<?> gtTile = ModReflect.cls(GT_TILE_INTERFACE);
        if (itemMachines == null || gtTile == null) {
            throw CpException.param(
                "GregTech 不在运行期 classpath 上，无法放置 GT 机器",
                "params." + GtMachineParams.PARAM_MACHINE,
                "缺少 " + GT_ITEM_MACHINES_CLASS + " 或 " + GT_TILE_INTERFACE);
        }

        GtMachineParams.Spec spec = GtMachineParams.parse(params, GtItemList.lookup());
        ItemStack stack = stackOf(spec);
        int metaTileId = stack.getItemDamage();
        if (metaTileId <= 0) {
            throw CpException.param(
                "该物品不是一台机器（damage=0）",
                "params." + (spec.byItemList() ? GtMachineParams.PARAM_MACHINE : GtMachineParams.PARAM_META),
                "MetaTileEntity id 必须 > 0；0 只会铺出一个没有 MetaTileEntity 的空壳（GT ItemMachines.java:244）");
        }

        Block block = blockOf(stack);
        Class<?> blockMachines = ModReflect.cls(GT_BLOCK_MACHINES_CLASS);
        if (block == null || blockMachines == null || !blockMachines.isInstance(block)) {
            throw CpException.param(
                "不是 GT 机器方块",
                "params." + (spec.byItemList() ? GtMachineParams.PARAM_MACHINE : GtMachineParams.PARAM_ITEM),
                "物品 " + ModReflect.itemId(stack)
                    + " 对应的方块不是 "
                    + GT_BLOCK_MACHINES_CLASS
                    + "（GT 的机器只能经 "
                    + GtMachineParams.GT_MACHINE_BLOCK
                    + " 放置）");
        }

        if (metaTilePrototype(metaTileId) == null) {
            throw CpException.param(
                "该 MetaTileEntity id 未注册",
                "params." + (spec.byItemList() ? GtMachineParams.PARAM_MACHINE : GtMachineParams.PARAM_META),
                "GregTechAPI.METATILEENTITIES[" + metaTileId
                    + "] == null（当前 GT 版本/配置下不存在这台机器；createNewMetatileEntity 会拒绝并锁死该 TE）");
        }

        // 幂等：已是同 id 的活动 MetaTileEntity → 只补一次权威同步
        TileEntity existing = world.getTileEntity(x, y, z);
        if (isSameMachine(existing, gtTile, metaTileId)) {
            world.markBlockForUpdate(x, y, z);
            return true;
        }
        // 清场（空壳 / 别的机器 / 别的方块）：te 步自带清场，保证 setBlock 一定重建 TE，
        // 同用例重复执行因此逐字节收敛（与 LpPipeCompleter 的清场口径一致）
        if (!world.isAirBlock(x, y, z)) {
            world.setBlockToAir(x, y, z);
        }

        place(world, x, y, z, itemMachines, gtTile, stack, spec, metaTileId);
        world.markBlockForUpdate(x, y, z);
        CpLog.info(
            "gt-machine 补全 @ %d,%d,%d：MetaTileEntity id=%d（%s）",
            Integer.valueOf(x),
            Integer.valueOf(y),
            Integer.valueOf(z),
            Integer.valueOf(metaTileId),
            spec.describe());
        return true;
    }

    // ------------------------------------------------------------ 放置

    /** 调 GT 自己的放置路径，并在放置后<b>读回验证</b> MetaTileEntity 真的建起来了。 */
    private static void place(WorldServer world, int x, int y, int z, Class<?> itemMachines, Class<?> gtTile,
        ItemStack stack, GtMachineParams.Spec spec, int metaTileId) {
        Method placeBlockAt = ModReflect.method(
            itemMachines,
            "placeBlockAt",
            ItemStack.class,
            EntityPlayer.class,
            World.class,
            int.class,
            int.class,
            int.class,
            int.class,
            float.class,
            float.class,
            float.class,
            int.class);
        if (placeBlockAt == null) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "找不到可用的 ItemMachines.placeBlockAt(ItemStack, EntityPlayer, World, int, int, int, int, float, float, float, int)"
                    + " —— GT 版本不符（期望 gregtech.common.blocks.ItemMachines）");
        }
        // 放置者：服务端玩家（GT 用它记 owner 并按玩家朝向定正面）。没有玩家时传 null——
        // GT 对该参数处处判空（ItemMachines.java:263/273），BlockMachines.onBlockPlacedBy 经
        // GTUtility.getSideFromPlayerFacing(null) 回落到第一个合法朝向，不会抛。
        EntityPlayer player = WorldRuntime.serverPlayer();
        Object placed;
        try {
            placed = placeBlockAt.invoke(
                null,
                stack,
                player,
                world,
                Integer.valueOf(x),
                Integer.valueOf(y),
                Integer.valueOf(z),
                Integer.valueOf(spec.sideOrdinal),
                Float.valueOf(0.5F),
                Float.valueOf(1.0F),
                Float.valueOf(0.5F),
                Integer.valueOf(0));
        } catch (Throwable t) {
            Throwable real = ModReflect.unwrap(t);
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "GT 放置失败（" + spec.describe() + " @ " + x + "," + y + "," + z + "）: " + ModReflect.describe(real),
                Json.object("metaTileId", Integer.valueOf(metaTileId), "side", spec.sideName()),
                real);
        }
        if (!Boolean.TRUE.equals(placed)) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "ItemMachines.placeBlockAt 返回 false（" + spec
                    .describe() + " @ " + x + "," + y + "," + z + "）：GT 侧拒绝了这次放置（该 id 未注册或方块写入失败）",
                Json.object("metaTileId", Integer.valueOf(metaTileId)));
        }
        verify(world, x, y, z, gtTile, spec, metaTileId);
    }

    /**
     * 放置后读回验证：{@code mID} 与 {@code MetaTileEntity} 都在位才算成功。
     *
     * <p>
     * 这一步是 {@code gt-machine} 族存在的<b>理由本身</b>：{@code world.setBlock} 直铺同样能让
     * {@code getTileEntity} 返回一个 {@code BaseMetaTileEntity}，但那个壳的 {@code mID == 0}、
     * {@code getMetaTileEntity() == null}，永远不会 tick。把这条判据放在补全器里（而不是留给用例），
     * 意味着「te 步返回 true」与「世界上真有一台可 tick 的机器」等价。
     */
    private static void verify(WorldServer world, int x, int y, int z, Class<?> gtTile, GtMachineParams.Spec spec,
        int metaTileId) {
        TileEntity te = world.getTileEntity(x, y, z);
        if (te == null || !gtTile.isInstance(te)) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "放置后该位置没有 GT 方块实体（" + x + "," + y + "," + z + " 实际 " + ModReflect.nameOf(te) + "）",
                Json.object("expected", GT_TILE_INTERFACE, "actual", ModReflect.nameOf(te)));
        }
        int liveId = asInt(ModReflect.call(te, "getMetaTileID"), -1);
        Object metaTile = ModReflect.call(te, "getMetaTileEntity");
        if (liveId != metaTileId || metaTile == null) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "放置后 MetaTileEntity 未创建（" + spec.describe()
                    + "）：读回 mID="
                    + liveId
                    + "，期望 "
                    + metaTileId
                    + "，getMetaTileEntity()="
                    + ModReflect.nameOf(metaTile)
                    + "——这正是 setBlock 直铺空壳的症状（空壳 mID==0），说明权威放置路径没有生效",
                Json.object(
                    "expectedMetaTileId",
                    Integer.valueOf(metaTileId),
                    "actualMetaTileId",
                    Integer.valueOf(liveId),
                    "metaTileEntity",
                    ModReflect.nameOf(metaTile)));
        }
    }

    // ------------------------------------------------------------ 解析

    /** 取物品栈：ItemList 形式走 GT 自己的清单，显式形式按注册名构造。 */
    private static ItemStack stackOf(GtMachineParams.Spec spec) {
        if (spec.byItemList()) {
            return GtItemList.get(spec.machine, 1L);
        }
        Item item = resolveItem(spec.item);
        if (item == null) {
            throw CpException.param("物品不存在", "params." + GtMachineParams.PARAM_ITEM, "物品注册表里没有该物品: " + spec.item);
        }
        // stackSize=1：GT 的电力物品条款与机器放置都按单件处理
        return new ItemStack(item, 1, spec.meta);
    }

    /** 物品对应的方块；不可判定返回 null。 */
    private static Block blockOf(ItemStack stack) {
        try {
            return Block.getBlockFromItem(stack.getItem());
        } catch (Throwable t) {
            CpLog.warn("Block.getBlockFromItem 失败: %s", ModReflect.describe(t));
            return null;
        }
    }

    /**
     * MetaTileEntity 原型：{@code GregTechAPI.METATILEENTITIES[id]}。
     *
     * <p>
     * 该数组是 GT 的公开注册表（{@code GregTechAPI.java:84}），id 即物品 damage
     * （{@code ItemMachines.getMetaTileEntity(ItemStack)} 同样按 damage 直接索引，见同文件 :68-73）。
     */
    private static Object metaTilePrototype(int id) {
        Object arr = ModReflect.staticField(GT_API_CLASS, "METATILEENTITIES");
        if (!(arr instanceof Object[])) {
            return null;
        }
        Object[] all = (Object[]) arr;
        return id > 0 && id < all.length ? all[id] : null;
    }

    /** 该位置的 TE 是否已是<b>同 id 的活动</b> GT 机器（幂等判定的唯一依据）。 */
    static boolean isSameMachine(TileEntity te, Class<?> gtTile, int metaTileId) {
        if (te == null || gtTile == null || !gtTile.isInstance(te)) {
            return false;
        }
        if (asInt(ModReflect.call(te, "getMetaTileID"), -1) != metaTileId) {
            return false;
        }
        return ModReflect.call(te, "getMetaTileEntity") != null;
    }

    /** 注册名解析：{@code GameRegistry.findItem} 优先，回落 {@code Item.itemRegistry}。 */
    static Item resolveItem(String id) {
        String modId = "minecraft";
        String name = id;
        int colon = id.indexOf(':');
        if (colon > 0) {
            modId = id.substring(0, colon);
            name = id.substring(colon + 1);
        }
        try {
            Item it = GameRegistry.findItem(modId, name);
            if (it != null) {
                return it;
            }
        } catch (Throwable t) {
            CpLog.warn("GameRegistry.findItem(%s,%s) 失败: %s", modId, name, ModReflect.describe(t));
        }
        try {
            Object o = Item.itemRegistry.getObject(id);
            return o instanceof Item ? (Item) o : null;
        } catch (Throwable t) {
            return null;
        }
    }

    private static int asInt(Object v, int def) {
        return v instanceof Number ? ((Number) v).intValue() : def;
    }
}
