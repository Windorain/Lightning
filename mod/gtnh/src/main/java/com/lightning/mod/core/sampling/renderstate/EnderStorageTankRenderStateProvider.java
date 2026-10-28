package com.lightning.mod.core.sampling.renderstate;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;

import net.minecraft.nbt.CompressedStreamTools;
import net.minecraft.nbt.NBTTagCompound;
import net.minecraft.tileentity.TileEntity;
import net.minecraftforge.fluids.FluidStack;

/**
 * 末影储罐族的渲染状态承载：液面与阀门角（{@link TileRenderStateProvider} 的第二个实现）。
 *
 * <h2>为什么需要</h2>
 * 储罐的这两样外观状态<b>都不进 NBT</b>：{@code TileEnderTank.writeToNBT} 只写频率、归属、朝向与红石反相，而
 * {@code liquid_state.c_liquid}/{@code s_liquid} 与 {@code pressure_state.a_pressure} 只走模组自己的客户端同步包与
 * 描述包。逐格捕获按扫描 NBT 造副本 TE（活动 TE 全程零写入），副本因此拿到的是构造期默认值——液面为空、阀门角为 0。
 * 真渲染器对空流体直接返回（{@code shouldRenderFluid} 要求 {@code amount > 0}），于是<b>满罐与空罐在产物里逐字相同</b>。
 *
 * <h2>口径：客户端本该收到的那个包</h2>
 * 扫描侧取活动 TE 的<b>同步权威值</b>（优先读模组自己的存储读口 {@code getStorage().getFluid()}，它与服务端每 tick
 * 刷新的 {@code s_liquid} 同源，且不受"注入与扫描之间隔了几 tick"影响；读口不可用时退回 {@code s_liquid}）与压力位
 * {@code a_pressure}；
 * 回填侧照客户端收到同步包之后的摄取语义写副本：{@code c_liquid} 与 {@code s_liquid} 都写（同步器内部状态比较<b>两个
 * 都读</b>，只写一个会留下自相矛盾的副本），阀门角取模组自己的 {@code approachRotate()} 并把 {@code a_rotate} 与
 * {@code b_rotate} 写成同一个当前值（静态导出不插值，两值相等即渲染当前角）。
 * <p>
 * 这不是"从静态数据推算外观"：流的量、流的种类与压力位全部来自快照时刻的活动 TE；本类只做一次序列化/反序列化。
 *
 * <h2>形态</h2>
 * 一个压缩 NBT：{@code pressure}（boolean）+ 可选 {@code liquid}（{@code FluidStack.writeToNBT} 的子标签）。没有流体时
 * 整块不写，回填侧因此保持副本的默认空流体——空储罐的副本本来就是这个状态。
 */
public final class EnderStorageTankRenderStateProvider implements TileRenderStateProvider {

    /** 状态格式标识（含版本：液面/压力的载体若换了布局，应升版而不是静默误读）。 */
    public static final String FORMAT = "enderstorage.tank-render-state/v1";

    /** 储罐 TE 类名（只按名字比对，不在本类里静态依赖那个模组）。 */
    public static final String TILE_CLASS = "codechicken.enderstorage.storage.liquid.TileEnderTank";

    private static final String FIELD_LIQUID_STATE = "liquid_state";
    private static final String FIELD_PRESSURE_STATE = "pressure_state";
    private static final String FIELD_CLIENT_LIQUID = "c_liquid";
    private static final String FIELD_SYNCED_LIQUID = "s_liquid";
    private static final String FIELD_PRESSURE = "a_pressure";
    private static final String FIELD_PREVIOUS_ROTATE = "b_rotate";
    private static final String FIELD_CURRENT_ROTATE = "a_rotate";
    private static final String METHOD_APPROACH_ROTATE = "approachRotate";
    private static final String TAG_LIQUID = "liquid";
    private static final String TAG_PRESSURE = "pressure";

    private final String tileClassName;

    public EnderStorageTankRenderStateProvider() {
        this(TILE_CLASS);
    }

    /** 单测用：换目标类名（生产路径只用无参构造）。 */
    EnderStorageTankRenderStateProvider(String tileClassName) {
        this.tileClassName = tileClassName;
    }

    @Override
    public String format() {
        return FORMAT;
    }

    @Override
    public boolean matches(TileEntity te, String registryId) {
        return te != null && tileClassName.equals(
            te.getClass()
                .getName());
    }

    @Override
    public byte[] write(TileEntity te) {
        if (!matches(te, null)) {
            return null;
        }
        Object liquidState = readField(te, FIELD_LIQUID_STATE);
        Object pressureState = readField(te, FIELD_PRESSURE_STATE);
        if (liquidState == null || pressureState == null) {
            return null;
        }
        NBTTagCompound tag = new NBTTagCompound();
        tag.setBoolean(TAG_PRESSURE, readBoolean(pressureState, FIELD_PRESSURE));
        FluidStack liquid = authoritativeLiquid(te, liquidState);
        if (liquid != null && liquid.amount > 0 && liquid.getFluid() != null) {
            NBTTagCompound liquidTag = new NBTTagCompound();
            liquid.writeToNBT(liquidTag);
            tag.setTag(TAG_LIQUID, liquidTag);
        }
        try {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            DataOutputStream out = new DataOutputStream(bytes);
            CompressedStreamTools.write(tag, out);
            out.flush();
            return bytes.toByteArray();
        } catch (Exception e) {
            throw new IllegalStateException("末影储罐渲染状态序列化失败", e);
        }
    }

    @Override
    public boolean apply(TileEntity te, byte[] state) {
        if (!matches(te, null) || state == null || state.length == 0) {
            return false;
        }
        NBTTagCompound tag;
        try {
            tag = CompressedStreamTools.read(new DataInputStream(new ByteArrayInputStream(state)));
        } catch (Exception e) {
            return false;
        }
        if (tag == null) {
            return false;
        }
        Object liquidState = readField(te, FIELD_LIQUID_STATE);
        Object pressureState = readField(te, FIELD_PRESSURE_STATE);
        if (liquidState == null || pressureState == null) {
            return false;
        }
        if (tag.hasKey(TAG_LIQUID)) {
            FluidStack liquid = FluidStack.loadFluidStackFromNBT(tag.getCompoundTag(TAG_LIQUID));
            if (liquid == null) {
                return false;
            }
            // 同步器内部状态比较同时读这两个字段，只写一个会留下自相矛盾的副本
            writeField(liquidState, FIELD_CLIENT_LIQUID, liquid);
            writeField(liquidState, FIELD_SYNCED_LIQUID, liquid);
        }
        boolean pressure = tag.getBoolean(TAG_PRESSURE);
        writeField(pressureState, FIELD_PRESSURE, Boolean.valueOf(pressure));
        double angle = approachRotate(pressureState);
        writeField(pressureState, FIELD_CURRENT_ROTATE, Double.valueOf(angle));
        writeField(pressureState, FIELD_PREVIOUS_ROTATE, Double.valueOf(angle));
        return true;
    }

    /**
     * 该格液体的权威值：优先走模组自己的存储读口（{@code getStorage().getFluid()}），它正是同步字段的来源，
     * 且不受"注入与扫描之间是否隔着一次服务端 tick"影响；读口不可用（存储尚未建立）时退回同步字段。
     * <p>
     * 两个入口读的是同一个值——服务端每 tick 把 {@code s_liquid} 刷成存储里的量；这里只是把"等价"换成
     * "不必依赖时序"。
     */
    private static FluidStack authoritativeLiquid(TileEntity te, Object liquidState) {
        FluidStack stored = storedFluid(te);
        if (stored != null) {
            return stored;
        }
        Object synced = readField(liquidState, FIELD_SYNCED_LIQUID);
        return synced instanceof FluidStack ? (FluidStack) synced : null;
    }

    /** 模组自己的存储读口（公有 API：{@code getStorage()}）；任何一步不可用都返回 null 交给上层退回。 */
    private static FluidStack storedFluid(TileEntity te) {
        try {
            Object storage = te.getClass()
                .getMethod("getStorage")
                .invoke(te);
            if (storage == null) {
                return null;
            }
            Object fluid = storage.getClass()
                .getMethod("getFluid")
                .invoke(storage);
            return fluid instanceof FluidStack ? (FluidStack) fluid : null;
        } catch (Throwable t) {
            return null;
        }
    }

    /** 模组自己的静止角公式（{@code a_pressure ? -90 : 90}）；调不到就退回 0（= 不转，与空状态一致）。 */
    private static double approachRotate(Object pressureState) {
        try {
            Method m = pressureState.getClass()
                .getMethod(METHOD_APPROACH_ROTATE);
            Object value = m.invoke(pressureState);
            return value instanceof Number ? ((Number) value).doubleValue() : 0.0;
        } catch (Throwable t) {
            return 0.0;
        }
    }

    private static Object readField(Object target, String name) {
        try {
            Field f = target.getClass()
                .getField(name);
            return f.get(target);
        } catch (Throwable t) {
            return null;
        }
    }

    private static boolean readBoolean(Object target, String name) {
        Object value = readField(target, name);
        return value instanceof Boolean && ((Boolean) value).booleanValue();
    }

    private static void writeField(Object target, String name, Object value) {
        try {
            target.getClass()
                .getField(name)
                .set(target, value);
        } catch (Throwable t) {
            throw new IllegalStateException("末影储罐渲染状态回填失败：" + name, t);
        }
    }
}
