package com.lightning.mod.client.controlplane.mc;

import net.minecraft.item.ItemStack;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * GregTech 机器的<b>运行期状态描述器</b>（族名 {@code gt-machine}，与
 * {@link GtMachineCompleter} 同名注册）。
 *
 * <h2>它要回答的第一个问题：这是「可运行的机器」还是「setBlock 直铺的空壳」</h2>
 * 场景清单的哈希只覆盖 {@code {blocks:[{pos,blockId,meta}], tileEntities:[{pos,class}]}}，而空壳与
 * 真机器的 {@code blockId}/{@code meta}/{@code class} <b>完全相同</b>（都是
 * {@code gt.blockmachines} + 扳手等级 meta + {@code gregtech.api.metatileentity.BaseMetaTileEntity}）。
 * 也就是说 <b>{@code world-hash-equals} 对「GT 机器有没有 MetaTileEntity」是盲的</b>。
 * 唯一能分辨的读数是 {@code IGregTechTileEntity.getMetaTileID()} 与 {@code getMetaTileEntity()}：
 * <ul>
 * <li><b>空壳（{@code setBlock} 直铺）</b>：{@code metaTileId = 0}、
 * {@code metaTileClass = null}、{@code shell = true}（GT 会把该 TE 锁死：
 * {@code CommonBaseMetaTileEntity.java:62-65} 打印 {@code "MetaID 0 not loadable => locking TileEntity!"}）；</li>
 * <li><b>本通道放置</b>：{@code metaTileId = 421}（LV 化学反应釜）、
 * {@code metaTileClass = gregtech.api.metatileentity.implementations.MTEBasicMachineWithRecipe}、
 * {@code shell = false}。</li>
 * </ul>
 * 因此本描述器是 #117 段二负对照的<b>唯一有效判据</b>（见 {@code temp/cp-gt-machine/live-verify-plan.md}）。
 *
 * <h2>输出（只读；{@code te-state-equals} 的 {@code key} 指向这棵树）</h2>
 * 
 * <pre>
 * {
 *   "te": "gregtech.api.metatileentity.BaseMetaTileEntity",
 *   "metaTileId": 421, "metaTilePresent": true, "shell": false,
 *   "metaTileClass": "gregtech.api.metatileentity.implementations.MTEBasicMachineWithRecipe",
 *   "metaTileName": "basicmachine.chemicalreactor.tier.01",
 *   "storedEU": 0, "euCapacity": 2048, "inputVoltage": 32, "inputTier": 1,
 *   "progressTime": 0, "maxProgressTime": 0, "running": false, "errorDisplayId": 0,
 *   "frontFacing": "NORTH", "active": false,
 *   "inventory": {
 *     "size": 10, "truncated": false,
 *     "batterySlot": 1, "dechargerSlotCount": 1, "rechargerSlotCount": 0,
 *     "inputSlot": 5, "outputSlot": 7,
 *     "slots": [ {"slot":0,"empty":true},
 *                {"slot":1,"empty":false,"id":"gregtech:gt.metaitem.01@32518","meta":32518,"count":1,
 *                 "charge":100000,"maxCharge":100000,"chargeFull":true,"electricTier":1}, ... ]
 *   }
 * }
 * </pre>
 *
 * <h2>为什么读「充电槽」而不只是「槽里有什么」</h2>
 * GT 的机器充电槽是<b>条件生效</b>的：{@code MTEBasicMachine.onPostTick} 每 tick 重算
 * {@code mDecharge = storedEU < capacity/3}、{@code mCharge = storedEU/2 > capacity/3}
 * （{@code MTEBasicMachine.java:558-560}），而 {@code BaseMetaTileEntity} 只在
 * {@code dechargerSlotCount() > 0}（即 EU 低于 1/3）时把槽里的电池放电进机器缓冲
 * （{@code BaseMetaTileEntity.java:330-331, 559-602}）。**中间带（1/3…2/3）里充电槽是惰性的**——
 * 只看「槽里有电池」会得出「已经通上电了」的假结论，因此把两个 count 一起读出来。
 *
 * <p>
 * <b>只读</b>：只调 GT 的 public getter，不调任何写方法（{@code markForUpdate}/{@code setEUVar}/
 * {@code setInventorySlotContents} 都不碰），也不读 NBT 猜状态（{@link TeDescriber} 的实现纪律）。
 */
public final class GtMachineDescriber implements TeDescriber {

    /** 注册名（与 {@link GtMachineCompleter#NAME} 一致）。 */
    public static final String NAME = GtMachineCompleter.NAME;

    /** 单次最多逐槽列出的槽位数（大机器不该把读数撑爆）。 */
    static final int MAX_SLOTS = 128;

    @Override
    public String name() {
        return NAME;
    }

    @Override
    public JsonObject describe(WorldServer world, int x, int y, int z) {
        Class<?> gtTile = ModReflect.cls(GtMachineCompleter.GT_TILE_INTERFACE);
        if (gtTile == null || world == null) {
            return null; // GT 缺席：本描述器不认领任何 TE
        }
        TileEntity te = world.getTileEntity(x, y, z);
        if (te == null || !gtTile.isInstance(te)) {
            return null;
        }
        Object metaTile = ModReflect.call(te, "getMetaTileEntity");
        int metaTileId = integer(ModReflect.call(te, "getMetaTileID"));

        JsonObject o = new JsonObject();
        o.addProperty(
            "te",
            te.getClass()
                .getName());
        o.addProperty("metaTileId", Integer.valueOf(metaTileId));
        o.addProperty("metaTilePresent", Boolean.valueOf(metaTile != null));
        // 空壳标记：GT 的 setBlock 直铺壳恒为 mID==0 且没有 MetaTileEntity。
        // 单独给一个布尔字段，是因为判据里写 "shell": false 比写两个字段的交集更不容易写错。
        o.addProperty("shell", Boolean.valueOf(metaTileId == 0 || metaTile == null));
        o.addProperty(
            "metaTileClass",
            metaTile == null ? null
                : metaTile.getClass()
                    .getName());
        o.addProperty("metaTileName", metaTile == null ? null : string(ModReflect.call(metaTile, "getMetaName")));

        // 能量与进度（读法是 GT 自己的 public getter）
        o.addProperty("storedEU", number(ModReflect.call(te, "getStoredEU")));
        o.addProperty("euCapacity", number(ModReflect.call(te, "getEUCapacity")));
        o.addProperty("inputVoltage", number(ModReflect.call(te, "getInputVoltage")));
        o.addProperty("inputTier", metaTile == null ? null : number(ModReflect.call(metaTile, "getInputTier")));
        o.addProperty("maxEUStore", metaTile == null ? null : number(ModReflect.call(metaTile, "maxEUStore")));
        o.addProperty(
            "minimumStoredEU",
            metaTile == null ? null : number(ModReflect.call(metaTile, "getMinimumStoredEU")));
        int progress = integer(ModReflect.call(metaTile, "getProgresstime"));
        int maxProgress = integer(ModReflect.call(metaTile, "maxProgresstime"));
        o.addProperty("progressTime", Integer.valueOf(progress));
        o.addProperty("maxProgressTime", Integer.valueOf(maxProgress));
        o.addProperty("running", Boolean.valueOf(maxProgress > 0));
        o.addProperty(
            "errorDisplayId",
            metaTile == null ? null : Integer.valueOf(integer(ModReflect.call(metaTile, "getErrorDisplayID"))));
        o.addProperty("frontFacing", string(ModReflect.call(te, "getFrontFacing")));
        o.addProperty("active", bool(ModReflect.call(te, "isActive")));
        o.add("inventory", inventory(te, metaTile));
        return o;
    }

    // ------------------------------------------------------------ 库存

    /** 逐槽读数 + 充电槽索引与「充电槽此刻是否生效」（见类注释）。 */
    private static JsonObject inventory(TileEntity te, Object metaTile) {
        JsonObject o = new JsonObject();
        int size = integer(ModReflect.call(te, "getSizeInventory"));
        o.addProperty("size", Integer.valueOf(size));
        o.addProperty("batterySlot", metaTile == null ? null : index(metaTile, "dechargerSlotStartIndex"));
        o.addProperty("dechargerSlotStartIndex", metaTile == null ? null : index(metaTile, "dechargerSlotStartIndex"));
        o.addProperty("rechargerSlotStartIndex", metaTile == null ? null : index(metaTile, "rechargerSlotStartIndex"));
        o.addProperty("dechargerSlotCount", metaTile == null ? null : index(metaTile, "dechargerSlotCount"));
        o.addProperty("rechargerSlotCount", metaTile == null ? null : index(metaTile, "rechargerSlotCount"));
        o.addProperty("inputSlot", metaTile == null ? null : index(metaTile, "getInputSlot"));
        o.addProperty("outputSlot", metaTile == null ? null : index(metaTile, "getOutputSlot"));

        JsonArray slots = new JsonArray();
        int limit = Math.min(Math.max(size, 0), MAX_SLOTS);
        for (int i = 0; i < limit; i++) {
            slots.add(slot(te, i));
        }
        o.add("slots", slots);
        o.addProperty("truncated", Boolean.valueOf(size > limit));
        return o;
    }

    /** 单个槽位；空槽写显式 {@code empty:true}（与 AE2 描述器的「缺席用显式 null」同一纪律）。 */
    private static JsonObject slot(TileEntity te, int index) {
        JsonObject o = new JsonObject();
        o.addProperty("slot", Integer.valueOf(index));
        Object raw = ModReflect.call(te, "getStackInSlot", new Class<?>[] { int.class }, Integer.valueOf(index));
        ItemStack stack = raw instanceof ItemStack ? (ItemStack) raw : null;
        if (stack == null || stack.getItem() == null) {
            o.addProperty("empty", Boolean.TRUE);
            return o;
        }
        o.addProperty("empty", Boolean.FALSE);
        o.addProperty("id", ModReflect.itemId(stack));
        o.addProperty("meta", Integer.valueOf(stack.getItemDamage()));
        o.addProperty("count", Integer.valueOf(stack.stackSize));
        // 电力物品的充放读数：#117 的供电布景就是往充电槽里写满充电池，这里如实读回
        Long charge = ElectricItems.chargeOf(stack);
        Long max = ElectricItems.maxCharge(stack);
        o.addProperty("charge", charge);
        o.addProperty("maxCharge", max);
        o.addProperty(
            "chargeFull",
            Boolean.valueOf(
                charge != null && max != null && max.longValue() > 0L && charge.longValue() >= max.longValue()));
        o.addProperty("electricTier", ElectricItems.tier(stack));
        return o;
    }

    // ------------------------------------------------------------ 工具

    /** 调 MTE 的无参 int 方法（缺失/抛错时返回 null，读数显式缺席而不是填 0）。 */
    private static Integer index(Object metaTile, String method) {
        Object v = ModReflect.call(metaTile, method);
        return v instanceof Number ? Integer.valueOf(((Number) v).intValue()) : null;
    }

    private static int integer(Object v) {
        return v instanceof Number ? ((Number) v).intValue() : 0;
    }

    /** 包装成可空数字（JSON 里写显式 null 表示「这个读数不可用」）。 */
    private static Long number(Object v) {
        return v instanceof Number ? Long.valueOf(((Number) v).longValue()) : null;
    }

    private static String string(Object v) {
        return v == null ? null : String.valueOf(v);
    }

    private static Boolean bool(Object v) {
        return v instanceof Boolean ? (Boolean) v : null;
    }
}
