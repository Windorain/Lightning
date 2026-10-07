package com.lightning.mod.client.controlplane.mc.scene;

import net.minecraft.client.Minecraft;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.WorldServer;
import net.minecraftforge.common.util.ForgeDirection;
import net.minecraftforge.fluids.Fluid;
import net.minecraftforge.fluids.FluidStack;
import net.minecraftforge.fluids.FluidTankInfo;
import net.minecraftforge.fluids.IFluidHandler;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.CpLog;
import com.lightning.mod.client.controlplane.mc.GtFluids;
import com.lightning.mod.client.controlplane.mc.ModReflect;
import com.lightning.mod.client.controlplane.mc.WorldRuntime;

/**
 * {@code scene.tank.fill}（scene，同步，契约 1.6）：向指定位置的机器/储罐注入流体。
 *
 * <h2>它补的是哪一块（#122 的问题本体）</h2>
 * {@code scene.inventory.write} 只碰 {@code IInventory}，而 GT 机器的流体口是<b>内部储罐</b>
 * （{@code MTEBasicTank.mFluid}，经 {@code IFluidHandler} 注入）——槽位表里根本没有「流体槽」
 * （{@code MTEBasicMachineWithRecipeBuilder.setFluidSlots(true,true)} 建的是 GUI 上的
 * {@code FluidSlotWidget}，即储罐控件）。因此三氯硅烷配方
 * （Si dust + 2 Empty Cell + HCl 3000 mB，GT5U {@code loaders/postload/recipes/ChemicalRecipes.java:4235-4242}）
 * 在缺本动作时无法端到端跑通：物品输入能投，流体输入投不进去。
 *
 * <h2>注入走的是「模组/原版自身的 API」</h2>
 * 一律经 {@link IFluidHandler#fill(ForgeDirection, FluidStack, boolean)} ——
 * 1.7.10 的流体交互标准入口，GT 的 {@code BaseMetaTileEntity} 自己实现它
 * （{@code IGregTechTileEntity extends IFluidHandler}，GT5U
 * {@code api/interfaces/tileentity/IGregTechTileEntity.java:32}；实现见
 * {@code BaseMetaTileEntity.java:1875-1882}，其中转调
 * {@code mMetaTileEntity.fill(side, fluid, doFill)}）。
 * <b>不</b>直接写 {@code MTEBasicTank.mFluid} 字段——那是逐字段回填（契约 §6.4 的既有禁令），
 * 与「给机器供电必须把电池写进充电槽而不是改 EU 缓冲」同一条纪律
 * （见 contract.md §6.5 第 5 条末段）。走 {@code fill} 的额外好处是 GT 自己的门槛全都照常生效：
 * 机器是否已 tick 起来（{@code mTickTimer > 5}）、输入面是否合法
 * （{@code mMetaTileEntity.isLiquidInput(side)}）、该流体是否被这台机器的配方表接受
 * （{@code MTEBasicMachine.isFluidInputAllowed} → {@code getRecipeMap().containsInput(aFluid)}）、
 * 容量与既有流体是否同种——这些判定<b>全部由 GT 做</b>，本动作只如实报告它返回的数字。
 *
 * <h2>「失败显式」怎么落（本动作最要紧的一处）</h2>
 * {@code fill} 的返回语义是<b>实际注入了多少 mB</b>，0 与「部分注入」都是正常返回值而不是异常。
 * 静默接受它们会让调用方把「一点没进去」当成成功（假绿），因此本动作按四类分别处理：
 * <ol>
 * <li><b>该位置没有方块实体</b> → {@code CP-STATE-001}（带该格的 blockId）；</li>
 * <li><b>方块实体不是流体处理器</b>（未实现 {@link IFluidHandler}）→ {@code CP-STATE-001}，
 * 并在上下文里写明它是什么类——「不是储罐」与「储罐满了」是两件事，必须分开说；</li>
 * <li><b>未知流体</b> → {@code CP-VALID-002}（{@code GtFluids} 解析，带已注册名样本）；</li>
 * <li><b>注入量为 0</b> → {@code CP-EXEC-001}，message 里带上「为什么可能是 0」的候选
 * （未 tick 起 / 该面不可注入 / 配方表不收该流体 / 储罐已满），并附注入前后的储罐读数。
 * <b>部分注入（0 &lt; filled &lt; amount）不是错误</b>：如实返回 {@code filled}、
 * {@code requested}、{@code partial:true} 与 {@code notFilled}，因为「容量不足」是正常场景，
 * 把它判红会让调用方无法用本动作做「尽量灌满」。</li>
 * </ol>
 *
 * <h2>读回验证</h2>
 * 返回值自带注入前后的储罐读数（{@code before}/{@code after}，取自 {@code getTankInfo} 与
 * {@code getFluid}/{@code getFluidAmount}），并额外做一次 {@code fill(…, false)}
 * 的<b>干跑</b>（{@code doFill=false}）交叉核对「还能再进多少」——
 * 干跑不改状态，却能把「返回 0 到底是因为满了还是因为不收」区分开。
 * 用例侧的读回走 {@code read.te} 的 {@code tanks[]}（{@link com.lightning.mod.client.controlplane.mc.GtMachineDescriber}
 * 的储罐字段），与 {@code te-state-equals} 判据同一棵树。
 *
 * <h2>层归属</h2>
 * 与 {@code scene.inventory.write} 同为 <b>L0</b> 布景原语（#96 §4.1）：直接设定状态、用于构造输入。
 * 返回值带 {@code layer:"L0"} 与 {@code semantics:"fill"}。它是「机器里有没有这个流体」的证据，
 * <b>不是</b>「玩家/管道把流体运进来了」的证据——后者属 L1/L2，两层结论不互替（#96 §4.2）。
 */
public final class TankFillAction implements ControlAction {

    /** 动作名。 */
    public static final String NAME = "scene.tank.fill";

    /** GT 的方块实体接口（判定「这是不是一台 GT 机器」，用于给零注入的报错补上更准的原因）。 */
    static final String GT_TILE_INTERFACE = "gregtech.api.interfaces.tileentity.IGregTechTileEntity";

    @Override
    public JsonObject execute(ActionContext ctx) {
        Minecraft mc = WorldRuntime.mc();
        WorldServer world = L0Session.requireServerWorld(ctx, NAME);

        double[] at = EntitySpawnAction.optPos(ctx, TankFillSpec.PARAM_AT);
        if (at == null) {
            throw CpException.param("缺少目标坐标", TankFillSpec.PARAM_AT, "必填 [x,y,z]（机器/储罐所在格）");
        }
        EntitySpawnAction.checkPos(at, TankFillSpec.PARAM_AT);
        TankFillSpec.Spec spec = TankFillSpec.parse(ctx.params());

        int x = (int) Math.floor(at[0]);
        int y = (int) Math.floor(at[1]);
        int z = (int) Math.floor(at[2]);

        Fluid fluid = GtFluids.resolve(spec.fluid, TankFillSpec.PARAM_FLUID);
        String registryName = GtFluids.registryName(fluid);
        FluidStack wanted = new FluidStack(fluid, spec.amount);

        TileEntity te = world.getTileEntity(x, y, z);
        if (te == null) {
            throw new CpException(
                ErrorCodes.STATE,
                "该位置没有方块实体（不是储罐/机器）",
                Json.object(
                    "at",
                    EntitySpawnAction.dblArray(at),
                    "block",
                    blockIdAt(world, x, y, z),
                    "hint",
                    "先用 world.rebuild 的 te 步放一台机器（completer=gt-machine），再对它注入"));
        }
        if (!(te instanceof IFluidHandler)) {
            throw new CpException(
                ErrorCodes.STATE,
                "该位置的方块实体不是流体处理器（未实现 net.minecraftforge.fluids.IFluidHandler）",
                Json.object(
                    "at",
                    EntitySpawnAction.dblArray(at),
                    "block",
                    blockIdAt(world, x, y, z),
                    "teClass",
                    te.getClass()
                        .getName(),
                    "hint",
                    "本动作只注入流体处理器；往容器里放物品用 scene.inventory.write"));
        }

        IFluidHandler handler = (IFluidHandler) te;
        ForgeDirection side = ForgeDirection.getOrientation(spec.sideOrdinal);

        JsonObject before = tankReadback(handler, side, te);
        // 干跑（doFill=false）：不改状态，回答「现在还能再进多少」。它把「返回 0」的两种原因分开：
        // 干跑 >0 而实注 0 ⇒ 不是容量/流体种类的问题（是 GT 的输入门/配方表/未 tick 起）；
        // 干跑 0 ⇒ 容量不足或流体种类不符。
        int dryRun = safeFill(handler, side, new FluidStack(fluid, spec.amount), false);
        int filled = safeFill(handler, side, wanted, true);
        JsonObject after = tankReadback(handler, side, te);

        JsonObject o = new JsonObject();
        o.addProperty("layer", "L0");
        o.addProperty("semantics", "fill");
        o.addProperty("layerNote", "L0 直接经 IFluidHandler 注入，不是「玩家/管道把流体运进来」的证据（后者属 L1/L2）；两层结论不互替（#96 §4.2）");
        JsonObject target = new JsonObject();
        target.addProperty("at", Json.toJson(EntitySpawnAction.dblArray(at)));
        target.addProperty(
            "teClass",
            te.getClass()
                .getName());
        target.addProperty("block", blockIdAt(world, x, y, z));
        target.addProperty("fluidHandler", Boolean.TRUE);
        target.addProperty("gtMachine", Boolean.valueOf(isGtMachine(te)));
        target.addProperty("side", spec.sideName());
        o.add("target", target);

        JsonObject requested = new JsonObject();
        requested.addProperty("fluid", registryName);
        requested.addProperty("fluidRequested", spec.fluid);
        requested.addProperty("amount", Integer.valueOf(spec.amount));
        requested.addProperty("localizedName", localizedName(fluid));
        o.add("requested", requested);

        o.addProperty("filled", Integer.valueOf(filled));
        o.addProperty("dryRunFillable", Integer.valueOf(dryRun));
        o.addProperty("notFilled", Integer.valueOf(Math.max(0, spec.amount - filled)));
        o.addProperty("complete", Boolean.valueOf(filled == spec.amount));
        o.addProperty("partial", Boolean.valueOf(filled > 0 && filled < spec.amount));
        o.add("before", before);
        o.add("after", after);

        if (filled <= 0) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "注入量为 0：GT/原版拒绝了这次注入（" + spec.describe()
                    + " @ "
                    + x
                    + ","
                    + y
                    + ","
                    + z
                    + "）。"
                    + "候选原因："
                    + zeroFillReason(dryRun, te)
                    + "。"
                    + "注入前后储罐读数见 context（before/after）",
                Json.object(
                    "at",
                    EntitySpawnAction.dblArray(at),
                    "teClass",
                    te.getClass()
                        .getName(),
                    "side",
                    spec.sideName(),
                    "requested",
                    requested,
                    "dryRunFillable",
                    Integer.valueOf(dryRun),
                    "before",
                    before,
                    "after",
                    after));
        }

        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            NAME + "：" + filled + "/" + spec.amount + " mB " + registryName + " @ " + x + "," + y + "," + z,
            Json.object(
                "at",
                EntitySpawnAction.dblArray(at),
                "fluid",
                registryName,
                "filled",
                Integer.valueOf(filled),
                "requested",
                Integer.valueOf(spec.amount),
                "partial",
                Boolean.valueOf(filled < spec.amount)));
        return L0Session.decorated(NAME, o, world, mc);
    }

    // ------------------------------------------------------------ 注入

    /**
     * 调 {@link IFluidHandler#fill} 并把模组抛出的异常<b>原样</b>带出去。
     *
     * <p>
     * 不用 {@link ModReflect#call}：它会吞掉异常并返回 null，而「GT 自己的注入路径抛错」必须可见
     * （失败显式）。与 {@code GtItemList.invokeGet} 同一口径。
     */
    private static int safeFill(IFluidHandler handler, ForgeDirection side, FluidStack stack, boolean doFill) {
        try {
            return handler.fill(side, stack, doFill);
        } catch (Throwable t) {
            Throwable real = ModReflect.unwrap(t);
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "IFluidHandler.fill 抛出: " + ModReflect.describe(real),
                Json.object(
                    "teClass",
                    handler.getClass()
                        .getName(),
                    "side",
                    side == null ? null : side.name(),
                    "doFill",
                    Boolean.valueOf(doFill)),
                real);
        }
    }

    /**
     * 零注入的原因候选（<b>只做解释，不假装确定</b>）。
     *
     * <p>
     * 本动作无法从外部权威地判定 GT 内部是哪一条门挡住的（那是 {@code fill} 内部的短路），
     * 因此这里给的是「按干跑结果分支的候选清单」，并把机器自己的状态读数一并带出，
     * 让调用方拿 {@code read.te} 去核实。给一个猜出来的单一原因才是更坏的做法。
     */
    private static String zeroFillReason(int dryRun, TileEntity te) {
        if (dryRun > 0) {
            return "干跑可注入 " + dryRun
                + " mB，说明容量与流体种类都不是瓶颈，实际注入被 GT 的运行期门挡住"
                + "（常见：机器还没 tick 起来 mTickTimer<=5 / 该面被 isLiquidInput 排除（正面与输出面）/ "
                + "这台机器的配方表不收该流体 isFluidInputAllowed / 机器的输入被 mInputDisabled 关掉）";
        }
        return "干跑也是 0，说明瓶颈在容量或流体种类" + "（常见：储罐已满、或罐里已有另一种流体——GT 的 MTEBasicTank.fill 对非同种流体直接返回 0）";
    }

    // ------------------------------------------------------------ 读回

    /**
     * 储罐读数（注入前后各取一次）：逐罐 {@code {index,fluid,amount,capacity,empty}}，
     * 外加 {@code fluid}/{@code fluidAmount} 两个 GT 侧的单值读数。
     *
     * <p>
     * 两个来源都读是有理由的：{@code getTankInfo} 是 Forge 的标准面（原版/模组通用），
     * 而 GT 的 {@code MTEBasicMachine} 覆写了它（{@code MTEBasicMachineWithRecipe.java:487-498}，
     * 只列「有输入/输出流体槽」的那些罐），因此它<b>未必</b>等于 {@code getFluid} 那个「主罐」。
     * 把两者并列，读回就不会因为「取哪个罐」这个选择而失真。
     */
    private static JsonObject tankReadback(IFluidHandler handler, ForgeDirection side, TileEntity te) {
        JsonObject o = new JsonObject();
        JsonArray tanks = new JsonArray();
        try {
            FluidTankInfo[] infos = handler.getTankInfo(side);
            if (infos != null) {
                for (int i = 0; i < infos.length; i++) {
                    tanks.add(tankEntry(i, infos[i]));
                }
            }
        } catch (Throwable t) {
            o.addProperty("tankInfoError", ModReflect.describe(t));
        }
        o.add("tanks", tanks);
        o.addProperty("tankCount", Integer.valueOf(tanks.size()));

        // GT 侧单值读数（经 GT 的 public getter；非 GT 方块实体时为显式 null）
        Object fluid = ModReflect.call(te, "getFluid");
        if (fluid instanceof FluidStack) {
            FluidStack fs = (FluidStack) fluid;
            o.addProperty("fluid", GtFluids.registryName(fs.getFluid()));
            o.addProperty("fluidAmount", Integer.valueOf(fs.amount));
        } else {
            o.addProperty("fluid", (String) null);
            o.addProperty("fluidAmount", Integer.valueOf(0));
        }
        Object amt = ModReflect.call(te, "getFluidAmount");
        o.addProperty("fluidAmountGetter", amt instanceof Number ? Integer.valueOf(((Number) amt).intValue()) : null);
        Object cap = ModReflect.call(te, "getCapacity");
        o.addProperty("capacity", cap instanceof Number ? Integer.valueOf(((Number) cap).intValue()) : null);
        return o;
    }

    private static JsonObject tankEntry(int index, FluidTankInfo info) {
        JsonObject t = new JsonObject();
        t.addProperty("index", Integer.valueOf(index));
        if (info == null) {
            t.addProperty("present", Boolean.FALSE);
            return t;
        }
        t.addProperty("present", Boolean.TRUE);
        t.addProperty("capacity", Integer.valueOf(info.capacity));
        FluidStack fs = info.fluid;
        if (fs == null || fs.getFluid() == null) {
            t.addProperty("empty", Boolean.TRUE);
            t.addProperty("amount", Integer.valueOf(0));
            t.addProperty("fluid", (String) null);
            return t;
        }
        t.addProperty("empty", Boolean.FALSE);
        t.addProperty("fluid", GtFluids.registryName(fs.getFluid()));
        t.addProperty("amount", Integer.valueOf(fs.amount));
        t.addProperty("localizedName", localizedName(fs.getFluid()));
        return t;
    }

    // ------------------------------------------------------------ 工具

    private static boolean isGtMachine(TileEntity te) {
        Class<?> gtTile = ModReflect.cls(GT_TILE_INTERFACE);
        return gtTile != null && gtTile.isInstance(te);
    }

    private static String localizedName(Fluid fluid) {
        if (fluid == null) {
            return null;
        }
        try {
            return fluid.getLocalizedName();
        } catch (Throwable t) {
            return null;
        }
    }

    private static String blockIdAt(WorldServer world, int x, int y, int z) {
        try {
            net.minecraft.block.Block b = world.getBlock(x, y, z);
            return b == null ? null
                : net.minecraft.block.Block.blockRegistry.getNameForObject(b) + ":" + world.getBlockMetadata(x, y, z);
        } catch (Throwable t) {
            CpLog.warn(
                "读方块 id 失败 @ %d,%d,%d: %s",
                Integer.valueOf(x),
                Integer.valueOf(y),
                Integer.valueOf(z),
                ModReflect.describe(t));
            return null;
        }
    }
}
