package com.lightning.mod.client.meshcapture.parts.probe;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.util.AxisAlignedBB;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * P0.2 三族部件探针的反射/JSON 小工具。全部运行时反射，不引用任何目标 mod 的编译期类型。
 * 探针专用：每一步失败都以异常文本形式落入探针输出的 {@code errors[]}，绝不静默吞掉。
 */
@SideOnly(Side.CLIENT)
final class PartsProbeReflect {

    private PartsProbeReflect() {}

    /** 剥掉 {@link InvocationTargetException} 包装，便于日志/落盘定位真实原因。 */
    static String describe(Throwable t) {
        Throwable c = t;
        while (c instanceof InvocationTargetException && c.getCause() != null) {
            c = c.getCause();
        }
        StringBuilder sb = new StringBuilder();
        sb.append(
            c.getClass()
                .getName());
        if (c.getMessage() != null) {
            sb.append(": ")
                .append(c.getMessage());
        }
        StackTraceElement[] st = c.getStackTrace();
        for (int i = 0; i < Math.min(4, st.length); i++) {
            sb.append(" @ ")
                .append(st[i].toString());
        }
        return sb.toString();
    }

    static Class<?> cls(String name) throws ClassNotFoundException {
        return Class.forName(name);
    }

    static Method method(Class<?> c, String name, Class<?>... params) throws NoSuchMethodException {
        return c.getMethod(name, params);
    }

    static Object invoke(Object target, String methodName, Class<?>[] paramTypes, Object... args) throws Exception {
        Method m = target.getClass()
            .getMethod(methodName, paramTypes);
        return m.invoke(target, args);
    }

    /** 读取 public 字段（目标 mod 的数据类大多是 public final 字段）。 */
    static Object field(Object target, String name) throws Exception {
        Field f = target.getClass()
            .getField(name);
        return f.get(target);
    }

    static double num(Object o) {
        return ((Number) o).doubleValue();
    }

    // ------------------------------------------------------------------ JSON 序列化

    /** Minecraft 的 AxisAlignedBB → [minX,minY,minZ,maxX,maxY,maxZ]（原样输出，不做单位变换）。 */
    static JsonArray aabb(AxisAlignedBB bb) {
        JsonArray a = new JsonArray();
        a.add(new com.google.gson.JsonPrimitive(round6(bb.minX)));
        a.add(new com.google.gson.JsonPrimitive(round6(bb.minY)));
        a.add(new com.google.gson.JsonPrimitive(round6(bb.minZ)));
        a.add(new com.google.gson.JsonPrimitive(round6(bb.maxX)));
        a.add(new com.google.gson.JsonPrimitive(round6(bb.maxY)));
        a.add(new com.google.gson.JsonPrimitive(round6(bb.maxZ)));
        return a;
    }

    static JsonArray doubles(double[] v) {
        JsonArray a = new JsonArray();
        for (double d : v) {
            a.add(new com.google.gson.JsonPrimitive(round6(d)));
        }
        return a;
    }

    private static double round6(double d) {
        return Math.round(d * 1_000_000.0) / 1_000_000.0;
    }

    /** 部件物品身份：registry 名 + meta/damage + 显示名 + NBT 摘要（FMP 微方块材料在 NBT 里）。 */
    static JsonObject stackIdentity(ItemStack stack) {
        JsonObject o = new JsonObject();
        if (stack == null || stack.getItem() == null) {
            o.addProperty("missing", Boolean.TRUE);
            return o;
        }
        String reg = Item.itemRegistry.getNameForObject(stack.getItem());
        o.addProperty("registry", reg == null ? "<unregistered>" : reg);
        o.addProperty("damage", Integer.valueOf(stack.getItemDamage()));
        o.addProperty("unlocalized", stack.getUnlocalizedName());
        try {
            o.addProperty("display", stack.getDisplayName());
        } catch (Throwable t) {
            o.addProperty("displayError", describe(t));
        }
        if (stack.hasTagCompound()) {
            o.addProperty(
                "nbt",
                stack.getTagCompound()
                    .toString());
        }
        return o;
    }

    static Constructor<?> ctor(Class<?> c, Class<?>... params) throws NoSuchMethodException {
        return c.getConstructor(params);
    }
}
