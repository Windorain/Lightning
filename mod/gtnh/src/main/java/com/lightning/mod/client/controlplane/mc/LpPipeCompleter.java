package com.lightning.mod.client.controlplane.mc;

import java.lang.reflect.Method;

import net.minecraft.block.Block;
import net.minecraft.item.Item;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;

import cpw.mods.fml.common.registry.GameRegistry;

/**
 * LogisticsPipes 通用管道补全器（族名 {@code lp-pipe}）——经 <b>LP 自己的放置 API</b> 放管。
 *
 * <h2>params 是「放置输入」，不是 NBT 回填（contract.md §6.5）</h2>
 * LP 的通用管块（{@code LogisticsPipes.LogisticsPipeBlock}）在 {@code setBlock} 之后只是一个
 * <b>空壳</b>：管型、连接、container 都要靠 {@code LogisticsTileGenericPipe.initialize(pipe)} 建立。
 * 因此本补全器的 {@code params} 声明的是<b>要放什么</b>（管物品、可选的管块与 meta），而不是
 * 「TE 的哪个字段该是什么值」——逐字段回填那些字段正被契约 §6.4 禁止（会制造「看起来对、实际从未
 * 经过模组序列化路径」的假象）。{@code params} 里<b>没有</b>任何 TE 字段名。
 *
 * <h2>权威调用链（源码实证，本树依赖 LP 1.5.28-GTNH）</h2>
 * <ol>
 * <li>{@code GameRegistry.findItem(modid, name)} 解析管物品（回落 {@code Item.itemRegistry.getObject}）；</li>
 * <li>{@code LogisticsBlockGenericPipe.pipes}（{@link Item} → 管实现类的权威映射，LP 自己
 * {@code registerPipe} 填的表）判定「这个物品是不是管道」并取管类 —— 不经此表就不是 LP 管；</li>
 * <li>{@code LogisticsBlockGenericPipe.createPipe(Item)}（{@code LogisticsBlockGenericPipe.java:903}）
 * 构造管实例（{@code pipe.getConstructor(Item.class).newInstance(key)}）；</li>
 * <li>{@code LogisticsBlockGenericPipe.placePipe(pipe, world, x, y, z, block, meta)}
 * （同文件 {@code :918}）一条龙：{@code world.setBlock(..., 2)} →
 * {@code LogisticsTileGenericPipe.initialize(pipe)}（{@code :745}，内含
 * {@code bindPipe()} + {@code computeConnections()} + {@code scheduleRenderUpdate()}，
 * 并让邻管 {@code scheduleNeighborChange()}）→ {@code sendUpdateToClient()}（S35 description packet）
 * → {@code world.notifyBlockChange(...)}；</li>
 * <li>本补全器再补一次 {@code world.markBlockForUpdate(x,y,z)}（契约 §6.4 要求的权威同步路径留痕）。</li>
 * </ol>
 *
 * <h2>幂等语义（「te 步自带清场」）</h2>
 * <ul>
 * <li>目标位置<b>已是同型 LP 管</b>（TE 是 {@code LogisticsTileGenericPipe} 且其 {@code pipe} 类 ==
 * 该物品对应的管类）→ <b>不重复放置</b>，只 {@code markBlockForUpdate} 并返回 true；
 * 重复执行同一用例因此逐字节收敛（放置路径不会二次构造管实例）；</li>
 * <li>目标位置<b>有其它方块</b>（或异型 LP 管）→ 先 {@code setBlockToAir} 清场再放，保证「同一用例
 * 跑两次」的场景哈希一致——清场是 te 步自己的职责，不依赖用例里的 {@code clear} 步；</li>
 * <li>管物品不是 LP 已注册管道、或 LP 不在运行期 classpath → {@code CP-VALID-002}，{@code context.fields}
 * 给出收到的注册名（用例作者一次改对）。</li>
 * </ul>
 *
 * <h2>为什么全反射</h2>
 * LP 在本树只是 {@code runtimeOnlyNonPublishable} 依赖，编译期没有 LP 类型可 import（见
 * {@link ModReflect} 的类注释）；注册与探测由 {@link ModTeFamilies} 负责，本类只在被调用时触达 LP。
 */
public final class LpPipeCompleter implements TeCompleter {

    /** 注册名（{@code build[i].completer} 的取值，契约 §6.5 的 v1.2 注册表）。 */
    public static final String NAME = "lp-pipe";

    /** LP 通用管块类（含 {@code createPipe}/{@code placePipe} 两个静态入口）。 */
    static final String LP_BLOCK_CLASS = "logisticspipes.pipes.basic.LogisticsBlockGenericPipe";

    /** LP 管道 TE 类。 */
    static final String LP_TILE_CLASS = "logisticspipes.pipes.basic.LogisticsTileGenericPipe";

    /** LP 模组门面类（静态方块字段 {@code LogisticsPipeBlock} 挂在这里）。 */
    static final String LP_FACADE_CLASS = "logisticspipes.LogisticsPipes";

    /** {@code build[i].params.pipe} 的字段名。 */
    public static final String PARAM_PIPE = "pipe";

    @Override
    public String name() {
        return NAME;
    }

    @Override
    public boolean complete(WorldServer world, int x, int y, int z, JsonObject params) {
        if (world == null) {
            return false;
        }
        JsonObject p = params == null ? new JsonObject() : params;
        Class<?> blockClass = ModReflect.load(LP_BLOCK_CLASS);
        if (blockClass == null) {
            throw CpException
                .param("LogisticsPipes 不在运行期 classpath 上，无法放置管道", "params." + PARAM_PIPE, "缺少 " + LP_BLOCK_CLASS);
        }
        String pipeId = Json.optString(p, PARAM_PIPE, null);
        if (pipeId == null || pipeId.trim()
            .isEmpty()) {
            throw CpException.param("缺少管道物品", "params." + PARAM_PIPE, "必填：LP 管道物品注册名，如 logisticspipes:pipe_basic");
        }
        pipeId = pipeId.trim();
        Item item = resolveItem(pipeId);
        if (item == null) {
            throw CpException.param(
                "管道物品不存在",
                "params." + PARAM_PIPE,
                "物品注册表里没有该物品: " + pipeId + "（GameRegistry.findItem 与 Item.itemRegistry 都没找到）");
        }
        Class<?> pipeClass = pipeClassOf(item);
        if (pipeClass == null) {
            throw CpException.param(
                "不是 LP 已注册的管道物品",
                "params." + PARAM_PIPE,
                "注册名 " + pipeId + " 不在 LogisticsBlockGenericPipe.pipes 映射表里（LP 只认自己 registerPipe 注册的管道物品）");
        }
        Block block = resolveBlock(p, pipeId);
        int meta = Json.optInt(p, "meta", 0);

        // 幂等：位置已是同型 LP 管 → 不重复放置，只补一次权威同步
        TileEntity existing = world.getTileEntity(x, y, z);
        if (isSamePipe(existing, pipeClass)) {
            world.markBlockForUpdate(x, y, z);
            return true;
        }
        // 清场（异型管或其它方块）：te 步自带清场，保证同用例重复执行收敛到同一场景
        if (!world.isAirBlock(x, y, z)) {
            world.setBlockToAir(x, y, z);
        }
        Object pipe = ModReflect.callStatic(blockClass, "createPipe", new Class<?>[] { Item.class }, item);
        if (pipe == null) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "LogisticsBlockGenericPipe.createPipe 返回 null（物品 " + pipeId + "，管类 " + pipeClass.getName() + "）");
        }
        Method placePipe = ModReflect.methodAssignableFirst(
            blockClass,
            "placePipe",
            pipe.getClass(),
            net.minecraft.world.World.class,
            int.class,
            int.class,
            int.class,
            Block.class,
            int.class);
        if (placePipe == null) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "找不到可用的 LogisticsBlockGenericPipe.placePipe(CoreUnroutedPipe, World, int, int, int, Block, int) 重载");
        }
        Object placed;
        try {
            placed = placePipe.invoke(
                null,
                pipe,
                world,
                Integer.valueOf(x),
                Integer.valueOf(y),
                Integer.valueOf(z),
                block,
                Integer.valueOf(meta));
        } catch (Throwable t) {
            Throwable real = ModReflect.unwrap(t);
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "LP 放置失败（" + pipeId + " @ " + x + "," + y + "," + z + "）: " + ModReflect.describe(real),
                null,
                real);
        }
        if (!Boolean.TRUE.equals(placed)) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "LogisticsBlockGenericPipe.placePipe 返回 false（" + pipeId + " @ " + x + "," + y + "," + z + "）");
        }
        world.markBlockForUpdate(x, y, z);
        return true;
    }

    // ------------------------------------------------------------ 解析

    /** 解析物品：{@code GameRegistry.findItem} 优先，回落 {@code Item.itemRegistry.getObject}。 */
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
            CpLog.warn("GameRegistry.findItem(%s,%s) 失败: %s", modId, name, String.valueOf(t));
        }
        try {
            Object o = Item.itemRegistry.getObject(id);
            return o instanceof Item ? (Item) o : null;
        } catch (Throwable t) {
            return null;
        }
    }

    /** 物品对应的管类（LP 权威映射表 {@code LogisticsBlockGenericPipe.pipes}）；不是管道物品返回 null。 */
    static Class<?> pipeClassOf(Item item) {
        Object pipes = ModReflect.staticField(LP_BLOCK_CLASS, "pipes");
        if (!(pipes instanceof java.util.Map)) {
            return null;
        }
        Object v = ((java.util.Map<?, ?>) pipes).get(item);
        return v instanceof Class ? (Class<?>) v : null;
    }

    /** 解析管块：{@code params.block} 优先，缺省用 LP 自己的通用管块。 */
    private static Block resolveBlock(JsonObject params, String pipeId) {
        String id = Json.optString(params, "block", null);
        boolean explicit = id != null && !id.trim()
            .isEmpty();
        Block b = explicit ? resolveBlockById(id.trim()) : lpPipeBlock();
        if (b == null) {
            throw CpException.param(
                explicit ? "管块不存在" : "找不到 LP 通用管块",
                explicit ? "params.block" : "params.block",
                explicit ? "方块注册表里没有该方块: " + id : "LP 的 LogisticsPipes.LogisticsPipeBlock 静态字段解析失败（LP 未完成注册？）");
        }
        Class<?> blockClass = ModReflect.cls(LP_BLOCK_CLASS);
        if (blockClass != null && !blockClass.isInstance(b)) {
            throw CpException.param(
                "params.block 不是 LP 通用管块",
                "params.block",
                "期望 " + LP_BLOCK_CLASS
                    + " 的实例，实际 "
                    + b.getClass()
                        .getName()
                    + "（管块必须由 LP 自己放置，不能换成别的方块）");
        }
        return b;
    }

    private static Block resolveBlockById(String id) {
        String modId = "minecraft";
        String name = id;
        int colon = id.indexOf(':');
        if (colon > 0) {
            modId = id.substring(0, colon);
            name = id.substring(colon + 1);
        }
        Block b = null;
        try {
            b = GameRegistry.findBlock(modId, name);
        } catch (Throwable t) {
            CpLog.warn("GameRegistry.findBlock(%s,%s) 失败: %s", modId, name, String.valueOf(t));
        }
        if (b == null) {
            try {
                b = Block.getBlockFromName(id);
            } catch (Throwable t) {
                CpLog.warn("Block.getBlockFromName(%s) 失败: %s", id, String.valueOf(t));
            }
        }
        return b;
    }

    /**
     * LP 通用管块实例：{@code logisticspipes.LogisticsPipes} 的静态字段（实测 1.5.28 是
     * {@code LogisticsPipeBlock}）。字段名跨版本可能变，故先按名字试，再按<b>类型</b>扫一遍静态字段。
     */
    static Block lpPipeBlock() {
        Object byName = ModReflect.staticField(LP_FACADE_CLASS, "LogisticsPipeBlock");
        if (byName instanceof Block) {
            return (Block) byName;
        }
        Class<?> facade = ModReflect.load(LP_FACADE_CLASS);
        Class<?> blockClass = ModReflect.cls(LP_BLOCK_CLASS);
        if (facade == null || blockClass == null) {
            return null;
        }
        for (java.lang.reflect.Field f : facade.getFields()) {
            if (!Block.class.isAssignableFrom(f.getType()) || !blockClass.isAssignableFrom(f.getType())) {
                continue;
            }
            try {
                Object v = f.get(null);
                if (v instanceof Block) {
                    return (Block) v;
                }
            } catch (Throwable ignored) {
                // 试下一个字段
            }
        }
        return null;
    }

    /** 该位置的 TE 是否已是<b>同型</b> LP 管（幂等判定的唯一依据：管类相同）。 */
    static boolean isSamePipe(TileEntity te, Class<?> pipeClass) {
        if (te == null || pipeClass == null) {
            return false;
        }
        if (!LP_TILE_CLASS.equals(
            te.getClass()
                .getName())) {
            return false;
        }
        Object pipe = ModReflect.field(te, "pipe");
        return pipe != null && pipe.getClass() == pipeClass;
    }
}
