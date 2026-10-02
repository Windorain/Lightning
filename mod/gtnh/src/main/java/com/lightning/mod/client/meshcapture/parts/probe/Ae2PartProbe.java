package com.lightning.mod.client.meshcapture.parts.probe;

import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;

import net.minecraft.client.Minecraft;
import net.minecraft.entity.Entity;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.util.AxisAlignedBB;
import net.minecraft.world.World;
import net.minecraftforge.common.util.ForgeDirection;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * P0.2 AE2 族探针（纯运行时反射，不引用 appeng 任何编译期类型）。
 *
 * <p>
 * 验证的反射调用链（逐跳见 {@code docs/plan/probe-family-apis.md}）：
 *
 * <pre>
 * mc.theWorld.getTileEntity(x,y,z)                     → appeng.tile.networking.TileCableBus(TESR)
 * tile.getPart(ForgeDirection) × 7（6 面 + UNKNOWN）    → appeng.api.parts.IPart（枚举，含中心线缆）
 * part.getBoxes(IPartCollisionHelper)                  → 盒（经 appeng.parts.BusCollisionHelper：
 *                                                        输入 0–16 像素挂载面局部，输出 0–1 方块局部）
 * part.getItemStack(PartItemStack.World)               → ItemStack（物品身份）
 * tile.getSelectedBoundingBoxesFromPool(w,x,y,z,e,vis) → 整格盒（ICustomCollision，对照用）
 * </pre>
 *
 * <p>
 * 关键设计：盒获取用 {@code java.lang.reflect.Proxy} 实现 {@code IPartCollisionHelper}，把
 * {@code addBox} 的<strong>原始 0–16 像素参数</strong>先记录下来，再委托给一个真实的
 * {@code BusCollisionHelper}（公开构造器）拿<strong>归一化后的 0–1 方块局部盒</strong> —— 一次调用
 * 同时拿到「原始坐标系」与「归一化坐标系」两份实测值，坐标系换算参数由此直接坐实。
 * {@code visual=true/false} 各跑一遍 ⇒ 视觉盒与碰撞盒分别落盘。
 */
@SideOnly(Side.CLIENT)
final class Ae2PartProbe {

    private Ae2PartProbe() {}

    static JsonObject probeBlock(Minecraft mc, int x, int y, int z) {
        JsonObject out = new JsonObject();
        JsonArray errors = new JsonArray();
        out.add("errors", errors);
        try {
            World world = mc.theWorld;
            TileEntity te = world.getTileEntity(x, y, z);
            if (te == null || !te.getClass()
                .getName()
                .contains("TileCableBus")) {
                errors.add(
                    new JsonPrimitive(
                        "tile 缺失或类型不符: " + (te == null ? "null"
                            : te.getClass()
                                .getName())));
                return out;
            }
            out.addProperty(
                "tileClass",
                te.getClass()
                    .getName());

            Class<?> helperIface = PartsProbeReflect.cls("appeng.api.parts.IPartCollisionHelper");
            Class<?> bchClass = PartsProbeReflect.cls("appeng.parts.BusCollisionHelper");
            Constructor<?> bchCtor = bchClass
                .getConstructor(List.class, ForgeDirection.class, Entity.class, boolean.class);
            Class<?> partItemStackEnum = PartsProbeReflect.cls("appeng.api.parts.PartItemStack");
            @SuppressWarnings({ "unchecked", "rawtypes" })
            Object worldStackType = Enum.valueOf((Class<? extends Enum>) partItemStackEnum, "World");

            JsonArray parts = new JsonArray();
            for (ForgeDirection side : ForgeDirection.values()) {
                Object part;
                try {
                    part = te.getClass()
                        .getMethod("getPart", ForgeDirection.class)
                        .invoke(te, side);
                } catch (Throwable t) {
                    errors.add(new JsonPrimitive("getPart(" + side + "): " + PartsProbeReflect.describe(t)));
                    continue;
                }
                if (part == null) {
                    continue;
                }
                parts.add(probePart(part, side, helperIface, bchCtor, partItemStackEnum, worldStackType, errors));
            }
            out.add("parts", parts);
            out.addProperty("partCount", Integer.valueOf(parts.size()));

            // 对照：整格 ICustomCollision 路径（AEBaseBlock 高亮/碰撞用的就是这条，含 facade）
            JsonObject whole = new JsonObject();
            try {
                Method wholeM = te.getClass()
                    .getMethod(
                        "getSelectedBoundingBoxesFromPool",
                        World.class,
                        int.class,
                        int.class,
                        int.class,
                        Entity.class,
                        boolean.class);
                whole.add("visual", toBoxArray((Iterable<?>) wholeM.invoke(te, world, x, y, z, null, Boolean.TRUE)));
                whole
                    .add("collision", toBoxArray((Iterable<?>) wholeM.invoke(te, world, x, y, z, null, Boolean.FALSE)));
            } catch (Throwable t) {
                whole.addProperty("error", PartsProbeReflect.describe(t));
            }
            out.add("wholeTileBoxes", whole);
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("probeBlock: " + PartsProbeReflect.describe(t)));
        }
        return out;
    }

    private static JsonObject probePart(Object part, ForgeDirection side, Class<?> helperIface, Constructor<?> bchCtor,
        Class<?> partItemStackEnum, Object worldStackType, JsonArray errors) {
        JsonObject o = new JsonObject();
        o.addProperty("slot", side.name());
        o.addProperty("slotMeaning", side == ForgeDirection.UNKNOWN ? "center cable" : "mounted on " + side);
        o.addProperty(
            "partClass",
            part.getClass()
                .getName());

        // ---- 盒：视觉 + 碰撞，两份（原始像素 + 归一化 0-1）
        o.add("visual", boxes(part, side, helperIface, bchCtor, true, errors));
        o.add("collision", boxes(part, side, helperIface, bchCtor, false, errors));

        // ---- 物品身份
        try {
            Object stack = part.getClass()
                .getMethod("getItemStack", partItemStackEnum)
                .invoke(part, worldStackType);
            o.add("item", PartsProbeReflect.stackIdentity((net.minecraft.item.ItemStack) stack));
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("getItemStack(" + side + "): " + PartsProbeReflect.describe(t)));
        }
        return o;
    }

    /**
     * 一次 {@code part.getBoxes} 调用同时拿两份盒：代理先记录原始 0–16 像素参数（含挂载面局部坐标系
     * 的世界轴映射 getWorldX/Y/Z），再委托真实 {@code BusCollisionHelper} 输出归一化 0–1 方块局部盒。
     */
    private static JsonObject boxes(Object part, ForgeDirection side, Class<?> helperIface, Constructor<?> bchCtor,
        boolean visual, JsonArray errors) {
        JsonObject o = new JsonObject();
        o.addProperty("space", visual ? "visual" : "collision");
        try {
            final List<double[]> rawPixels = new ArrayList<double[]>();
            final List<AxisAlignedBB> normalized = new ArrayList<AxisAlignedBB>();
            final Object real = bchCtor.newInstance(normalized, side, null, Boolean.valueOf(visual));
            Object proxy = Proxy.newProxyInstance(
                helperIface.getClassLoader(),
                new Class<?>[] { helperIface },
                new InvocationHandler() {

                    @Override
                    public Object invoke(Object p, Method m, Object[] args) throws Throwable {
                        if ("addBox".equals(m.getName()) && args != null && args.length == 6) {
                            rawPixels.add(
                                new double[] { PartsProbeReflect.num(args[0]), PartsProbeReflect.num(args[1]),
                                    PartsProbeReflect.num(args[2]), PartsProbeReflect.num(args[3]),
                                    PartsProbeReflect.num(args[4]), PartsProbeReflect.num(args[5]) });
                        }
                        return m.invoke(real, args);
                    }
                });
            part.getClass()
                .getMethod("getBoxes", helperIface)
                .invoke(part, proxy);

            JsonArray raw = new JsonArray();
            for (double[] px : rawPixels) {
                raw.add(PartsProbeReflect.doubles(px));
            }
            o.add("rawPixelBoxes", raw);
            JsonArray norm = new JsonArray();
            for (AxisAlignedBB bb : normalized) {
                norm.add(PartsProbeReflect.aabb(bb));
            }
            o.add("blockLocalBoxes", norm);

            // 坐标系实测：挂载面局部轴 → 世界轴（来自真实 BusCollisionHelper）
            JsonObject axes = new JsonObject();
            axes.addProperty("localX→", String.valueOf(PartsProbeReflect.invoke(real, "getWorldX", new Class<?>[0])));
            axes.addProperty("localY→", String.valueOf(PartsProbeReflect.invoke(real, "getWorldY", new Class<?>[0])));
            axes.addProperty("localZ→", String.valueOf(PartsProbeReflect.invoke(real, "getWorldZ", new Class<?>[0])));
            axes.addProperty(
                "isBBCollision",
                String.valueOf(PartsProbeReflect.invoke(real, "isBBCollision", new Class<?>[0])));
            o.add("localFrameAxes", axes);
        } catch (Throwable t) {
            errors.add(
                new JsonPrimitive(
                    "getBoxes(" + side
                        + ","
                        + (visual ? "visual" : "collision")
                        + "): "
                        + PartsProbeReflect.describe(t)));
            o.addProperty("error", PartsProbeReflect.describe(t));
        }
        return o;
    }

    private static JsonArray toBoxArray(Iterable<?> boxes) {
        JsonArray a = new JsonArray();
        if (boxes != null) {
            for (Object b : boxes) {
                a.add(PartsProbeReflect.aabb((AxisAlignedBB) b));
            }
        }
        return a;
    }
}
