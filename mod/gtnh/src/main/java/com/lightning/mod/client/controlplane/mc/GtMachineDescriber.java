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
 * 因此本描述器是该负对照的<b>唯一有效判据</b>。
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
 *   },
 *   "tanks": {
 *     "present": true, "count": 2, "capacity": 16000,
 *     "tanks": [ {"index":0,"present":true,"capacity":16000,"empty":false,
 *                 "fluid":"hydrochloricacid_gt5u","amount":3000,"localizedName":"Hydrochloric Acid"},
 *                {"index":1,"present":true,"capacity":16000,"empty":true,"amount":0,"fluid":null} ],
 *     "drainableFluid": null, "drainableFluidAmount": 0, "metaTileCapacity": 16000
 *   }
 * }
 * </pre>
 *
 * <h2>储罐读回：为什么必须有它</h2>
 * {@code scene.tank.fill} 把流体注入 {@code MTEBasicTank.mFluid}（经 {@code IFluidHandler}），
 * 那份状态<b>不在槽位表里</b>——只看 {@code inventory} 无法判定「注入到底进没进去」。
 * 因此本描述器把 {@code getTankInfo}（Forge 标准面，逐罐 {@code {fluid,amount,capacity}}）与
 * GT 侧单值读数一起暴露，且两处都读：{@code MTEBasicMachine} 覆写了 {@code getTankInfo}
 * （{@code MTEBasicMachineWithRecipe.java:487-498}），只列「有输入/输出流体槽」的那些罐，
 * 未必等于 {@code getFluid} 返回的那个罐。并列之后，
 * {@code te-state-equals} 的 {@code key} 可以直接指到 {@code /tanks/tanks/0/amount} 断言注入量，
 * 与 {@code scene.tank.fill} 的返回值出自<b>同一个读取口</b>（分叉是这类设施最贵的一类缺陷）。
 *
 * <p>
 * <b>输入侧请断言 {@code /tanks/tanks/<i>N</i>/amount}，不要断言 {@code /tanks/drainableFluid*}：
 * 后者是「可排出/输出」那一侧</b>（见 {@code tanks} 方法的说明）。
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
        o.add("tanks", tanks(te, metaTile));
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
        // 电力物品的充放读数：供电布景就是往充电槽里写满充电池，这里如实读回
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

    // ------------------------------------------------------------ 储罐

    /**
     * 储罐读数：逐罐（{@code getTankInfo}）+ GT 侧单值读数（{@code getFluid}/{@code getFluidAmount}/
     * {@code getCapacity}）。
     *
     * <h2>为什么两处都读（不是冗余）</h2>
     * {@code MTEBasicMachine} 覆写了 {@code getTankInfo}（{@code MTEBasicMachineWithRecipe.java:487-498}），
     * 只列「有输入/输出流体槽」的罐；而 {@code getFluid} 返回的是 {@code getDrainableStack()}
     * （{@code MTEBasicMachine.java:455-457} 覆写为 {@code mFluidOut}，即<b>输出</b>罐）。
     * 因此「主罐」这个词在 GT 机器上是有歧义的，两个来源都读才不至于因为取哪个罐而失真。
     *
     * <h2>⚠ 单值读数必须从 <b>MetaTileEntity</b> 读，不能从方块实体读（实机证伪的缺陷）</h2>
     * 三个 getter 的宿主是 <b>MTE</b> 而不是 TE：
     * <ul>
     * <li>{@code getFluid()}/{@code getFluidAmount()} 只在
     * {@code MTEBasicTank}（{@code MTEBasicTank.java:195,200}）上——方块实体没有它们；</li>
     * <li>{@code BaseMetaTileEntity.getCapacity()} <b>确实存在</b>，但它返回的是
     * {@code (int) min(MAX, getEUCapacity())}（{@code BaseMetaTileEntity.java:1997-1999}）——
     * 即 <b>EU 缓冲容量（LV 机器 = 2048）而不是储罐容量（16000）</b>。</li>
     * </ul>
     * 从方块实体读的后果是：{@code fluid}/{@code fluidAmount} 恒为显式 null，
     * 而 {@code capacityGetter} 报出一个「看起来像储罐容量、实际是 EU 容量」的 2048——
     * 后者尤其坏，它<b>静默给出一个错的数字</b>而不是缺席（实机首轮实测到）。
     * 故单值读数一律从 {@code getMetaTileEntity()} 取；MTE 不在位（空壳）时给显式 null。
     *
     * <h2>只读纪律</h2>
     * 只调 GT/Forge 的 public getter（{@code getTankInfo}/{@code getFluid}/{@code getFluidAmount}/
     * {@code getCapacity}），<b>不</b>调 {@code fill}/{@code drain}、不读 NBT 猜状态
     * （见类注释与 {@link TeDescriber} 的实现纪律）。
     *
     * <h2>非 GT 的 {@code IFluidHandler}</h2>
     * {@code getTankInfo} 是 Forge 的标准面，任何 {@code IFluidHandler} 都有；GT 侧的单值读数则可能
     * 全为显式 null（该 TE 不是 GT 机器时 {@code getMetaTileEntity()} 为 null）。
     * 这两件事分开表达：{@code present} 说「有没有储罐读数」，单值字段的 null 说「GT 侧有没有」。
     */
    private static JsonObject tanks(TileEntity te, Object metaTile) {
        JsonObject o = new JsonObject();
        JsonArray tanks = new JsonArray();
        int capacity = 0;
        boolean anyCapacity = false;
        String presentError = null;
        // 用 ForgeDirection.UNKNOWN（-1）读：GT 的 getTankInfo 对 UNKNOWN 不做「面」过滤
        // （BaseMetaTileEntity.java:1928-1934），因此它给出的是「这台机器有几个罐」的完整视图。
        Object infos;
        try {
            infos = te instanceof net.minecraftforge.fluids.IFluidHandler
                ? ((net.minecraftforge.fluids.IFluidHandler) te)
                    .getTankInfo(net.minecraftforge.common.util.ForgeDirection.UNKNOWN)
                : null;
        } catch (Throwable t) {
            presentError = ModReflect.describe(t);
            infos = null;
        }
        if (infos instanceof net.minecraftforge.fluids.FluidTankInfo[]) {
            net.minecraftforge.fluids.FluidTankInfo[] arr = (net.minecraftforge.fluids.FluidTankInfo[]) infos;
            for (int i = 0; i < arr.length; i++) {
                net.minecraftforge.fluids.FluidTankInfo info = arr[i];
                JsonObject t = new JsonObject();
                t.addProperty("index", Integer.valueOf(i));
                if (info == null) {
                    t.addProperty("present", Boolean.FALSE);
                    tanks.add(t);
                    continue;
                }
                t.addProperty("present", Boolean.TRUE);
                t.addProperty("capacity", Integer.valueOf(info.capacity));
                if (info.capacity > 0 && !anyCapacity) {
                    capacity = info.capacity;
                    anyCapacity = true;
                }
                net.minecraftforge.fluids.FluidStack fs = info.fluid;
                if (fs == null || fs.getFluid() == null) {
                    t.addProperty("empty", Boolean.TRUE);
                    t.addProperty("amount", Integer.valueOf(0));
                    t.addProperty("fluid", (String) null);
                } else {
                    t.addProperty("empty", Boolean.FALSE);
                    t.addProperty(
                        "fluid",
                        com.lightning.mod.client.controlplane.mc.GtFluids.registryName(fs.getFluid()));
                    t.addProperty("amount", Integer.valueOf(fs.amount));
                    t.addProperty("localizedName", localizedName(fs.getFluid()));
                }
                tanks.add(t);
            }
        }
        // 用 size() > 0 而不是 isEmpty()：JsonArray.isEmpty() 是 gson 2.8+ API，
        // 运行期 FML 实载 2.2.4，编译期 classpath 是 2.8.9——写成 isEmpty() 编译能过、
        // 运行期 NoSuchMethodError（本仓已三次同族事故，见 mod-dev 技能的 gson 陷阱条）。
        o.addProperty("present", Boolean.valueOf(tanks.size() > 0));
        if (presentError != null) {
            o.addProperty("tankInfoError", presentError);
        }
        o.addProperty("count", Integer.valueOf(tanks.size()));
        o.addProperty("capacity", anyCapacity ? Integer.valueOf(capacity) : null);
        o.add("tanks", tanks);

        // GT 侧单值读数：宿主是 MTE（见方法注释），非 GT/空壳 → 显式 null。
        //
        // ⚠ 命名口实（实机第二轮证伪的「我的期望本身是错的」那一处）：
        // MTEBasicMachine 覆写 getDrainableStack() 返回 mFluidOut（:455-457），
        // 而 MTEBasicTank.getFluid() 就是 getDrainableStack()（:195-197）⇒
        // **MTEBasicMachine 的 getFluid/getFluidAmount 指的是「可排出/输出」那一侧，不是输入储罐**。
        // 实机实测：注完 HCl 3000 后这两个读数是 null/0（输入罐在 tanks[0]，输出罐确实是空的）；
        // 配方跑完后变成 trichlorosilane/1000。故字段名必须带 drainable 前缀——
        // 叫 fluid 会让下游把「输入罐已注入」误读成「没注进去」。
        // **输入侧的唯一权威读数是逐罐的 tanks[]（来自 getTankInfo）。**
        Object fluid = ModReflect.call(metaTile, "getFluid");
        if (fluid instanceof net.minecraftforge.fluids.FluidStack) {
            net.minecraftforge.fluids.FluidStack fs = (net.minecraftforge.fluids.FluidStack) fluid;
            o.addProperty(
                "drainableFluid",
                com.lightning.mod.client.controlplane.mc.GtFluids.registryName(fs.getFluid()));
            o.addProperty("drainableFluidAmount", Integer.valueOf(fs.amount));
        } else {
            o.addProperty("drainableFluid", (String) null);
            o.addProperty("drainableFluidAmount", Integer.valueOf(0));
        }
        Object amount = ModReflect.call(metaTile, "getFluidAmount");
        o.addProperty(
            "drainableFluidAmountGetter",
            amount instanceof Number ? Integer.valueOf(((Number) amount).intValue()) : null);
        // getCapacity() 在 MTE 上才是储罐容量（MTEBasicMachineWithRecipe.java:482-484 返回 mTankCapacity）；
        // 在方块实体上它返回 EU 容量（2048），是单值读数取自方块实体的后果。
        Object cap = ModReflect.call(metaTile, "getCapacity");
        o.addProperty("metaTileCapacity", cap instanceof Number ? Integer.valueOf(((Number) cap).intValue()) : null);
        return o;
    }

    private static String localizedName(net.minecraftforge.fluids.Fluid fluid) {
        try {
            return fluid.getLocalizedName();
        } catch (Throwable t) {
            return null;
        }
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
