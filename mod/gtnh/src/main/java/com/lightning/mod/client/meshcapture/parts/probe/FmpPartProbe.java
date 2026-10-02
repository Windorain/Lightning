package com.lightning.mod.client.meshcapture.parts.probe;

import java.lang.reflect.Field;
import java.util.List;

import net.minecraft.client.Minecraft;
import net.minecraft.item.ItemStack;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.World;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * P0.2 FMP 族探针（纯运行时反射，不引用 codechicken 任何编译期类型；注意 FMP 是 Scala 编译产物，
 * 探针同时记录了「源码推断的 JVM 方法名是否真实存在」这一反射可达性事实本身）。
 *
 * <p>
 * 验证的反射调用链：
 *
 * <pre>
 * mc.theWorld.getTileEntity(x,y,z)          → codechicken.multipart.TileMultipartClient（生成的 mixin 子类）
 * tile.jPartList()                          → java.util.List&lt;TMultiPart&gt;（枚举）
 * part.getType() / getSlot()                → 类型键（如 mcr_face）/ PartMap 27 规范槽位（0–26）
 * part.getSubParts()                        → Iterable&lt;IndexedCuboid6&gt;（视觉/高亮盒，0–1 方块局部）
 * part.getCollisionBoxes()                  → Iterable&lt;Cuboid6&gt;（碰撞盒，0–1 方块局部）
 * part.getDrops()                           → Iterable&lt;ItemStack&gt;（物品身份）
 * part.getMaterial()/getSize()/getShape()   → 微方块材料/尺寸/形状（物品 damage = size | classId&lt;&lt;8）
 * </pre>
 *
 * <p>
 * 视觉/碰撞盒结论的探针证据：{@code BlockMultipart#addCollisionBoxesToList} 用 {@code getCollisionBoxes}；
 * 高亮（drawHighlight）经 raytrace 命中 {@code getSubParts} 的 {@code IndexedCuboid6}。两者分开存储、
 * 都要取。对 {@code TCuboidPart}（微方块）默认实现两者同源（{@code getBounds}），但接口层允许不同。
 */
@SideOnly(Side.CLIENT)
final class FmpPartProbe {

    private FmpPartProbe() {}

    static JsonObject probeBlock(Minecraft mc, int x, int y, int z) {
        JsonObject out = new JsonObject();
        JsonArray errors = new JsonArray();
        out.add("errors", errors);
        try {
            World world = mc.theWorld;
            TileEntity te = world.getTileEntity(x, y, z);
            if (te == null || !te.getClass()
                .getName()
                .contains("TileMultipart")) {
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

            List<?> partList = (List<?>) te.getClass()
                .getMethod("jPartList")
                .invoke(te);
            JsonArray parts = new JsonArray();
            for (int i = 0; i < partList.size(); i++) {
                parts.add(probePart(partList.get(i), i, errors));
            }
            out.add("parts", parts);
            out.addProperty("partCount", Integer.valueOf(parts.size()));
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("probeBlock: " + PartsProbeReflect.describe(t)));
        }
        return out;
    }

    private static JsonObject probePart(Object part, int index, JsonArray errors) {
        JsonObject o = new JsonObject();
        o.addProperty("index", Integer.valueOf(index));
        o.addProperty(
            "partClass",
            part.getClass()
                .getName());
        try {
            o.addProperty(
                "type",
                String.valueOf(
                    part.getClass()
                        .getMethod("getType")
                        .invoke(part)));
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("getType: " + PartsProbeReflect.describe(t)));
        }
        // 槽位（TSlottedPart#getSlot）→ PartMap 27 规范槽位名
        try {
            Object slot = part.getClass()
                .getMethod("getSlot")
                .invoke(part);
            int s = ((Number) slot).intValue();
            o.addProperty("slot", Integer.valueOf(s));
            o.addProperty("slotName", slotName(s));
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("getSlot: " + PartsProbeReflect.describe(t)));
        }
        // 微方块身份要素：材料 / 尺寸 / 形状（→ 物品 damage 编码）
        try {
            Object mat = part.getClass()
                .getMethod("getMaterial")
                .invoke(part);
            o.addProperty("materialId", ((Number) mat).intValue());
            o.addProperty("materialName", materialName(((Number) mat).intValue()));
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("getMaterial: " + PartsProbeReflect.describe(t)));
        }
        try {
            Object size = part.getClass()
                .getMethod("getSize")
                .invoke(part);
            Object shape = part.getClass()
                .getMethod("getShape")
                .invoke(part);
            o.addProperty("size", ((Number) size).intValue());
            o.addProperty("shape", ((Number) shape).intValue());
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("getSize/getShape: " + PartsProbeReflect.describe(t)));
        }
        // 视觉盒（getSubParts → IndexedCuboid6，含 data 命中索引）
        try {
            Object sub = part.getClass()
                .getMethod("getSubParts")
                .invoke(part);
            o.add("subParts(visual)", toCuboidArray((Iterable<?>) sub, true));
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("getSubParts: " + PartsProbeReflect.describe(t)));
        }
        // 碰撞盒（getCollisionBoxes → Cuboid6）
        try {
            Object coll = part.getClass()
                .getMethod("getCollisionBoxes")
                .invoke(part);
            o.add("collisionBoxes", toCuboidArray((Iterable<?>) coll, false));
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("getCollisionBoxes: " + PartsProbeReflect.describe(t)));
        }
        // 渲染总盒（对照）
        try {
            Object rb = part.getClass()
                .getMethod("getRenderBounds")
                .invoke(part);
            JsonArray a = new JsonArray();
            a.add(cuboid(rb, null));
            o.add("renderBounds", a);
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("getRenderBounds: " + PartsProbeReflect.describe(t)));
        }
        // 物品身份（getDrops；尺寸>1 的微方块会拆成 4/2/1 多件，正是「一部件≠一物品」的实证）
        try {
            Object drops = part.getClass()
                .getMethod("getDrops")
                .invoke(part);
            JsonArray items = new JsonArray();
            for (Object d : (Iterable<?>) drops) {
                items.add(PartsProbeReflect.stackIdentity((ItemStack) d));
            }
            o.add("drops", items);
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("getDrops: " + PartsProbeReflect.describe(t)));
        }
        return o;
    }

    private static JsonArray toCuboidArray(Iterable<?> cuboids, boolean indexed) {
        JsonArray a = new JsonArray();
        if (cuboids == null) {
            return a;
        }
        for (Object c : cuboids) {
            Object data = null;
            if (indexed) {
                try {
                    data = PartsProbeReflect.field(c, "data");
                } catch (Throwable ignored) {
                    // IndexedCuboid6.data 不存在时忽略
                }
            }
            try {
                a.add(cuboid(c, data));
            } catch (Throwable t) {
                JsonObject err = new JsonObject();
                err.addProperty("error", PartsProbeReflect.describe(t));
                a.add(err);
            }
        }
        return a;
    }

    /** codechicken.lib.vec.Cuboid6：public Vector3 min/max（double x/y/z），0–1 方块局部。 */
    private static JsonObject cuboid(Object cuboid6, Object data) throws Exception {
        JsonObject o = new JsonObject();
        Object min = PartsProbeReflect.field(cuboid6, "min");
        Object max = PartsProbeReflect.field(cuboid6, "max");
        JsonArray box = new JsonArray();
        box.add(new JsonPrimitive(Double.valueOf(vec(min, "x"))));
        box.add(new JsonPrimitive(Double.valueOf(vec(min, "y"))));
        box.add(new JsonPrimitive(Double.valueOf(vec(min, "z"))));
        box.add(new JsonPrimitive(Double.valueOf(vec(max, "x"))));
        box.add(new JsonPrimitive(Double.valueOf(vec(max, "y"))));
        box.add(new JsonPrimitive(Double.valueOf(vec(max, "z"))));
        o.add("box", box);
        if (data != null) {
            o.addProperty("data", String.valueOf(data));
        }
        return o;
    }

    private static double vec(Object vector3, String axis) throws Exception {
        Field f = vector3.getClass()
            .getField(axis);
        return ((Number) f.get(vector3)).doubleValue();
    }

    private static String materialName(int id) {
        try {
            Class<?> mmrClass = PartsProbeReflect.cls("codechicken.microblock.MicroMaterialRegistry$");
            Object mmr = mmrClass.getField("MODULE$")
                .get(null);
            return String.valueOf(
                mmrClass.getMethod("materialName", int.class)
                    .invoke(mmr, Integer.valueOf(id)));
        } catch (Throwable t) {
            return "<id " + id
                + ": "
                + t.getClass()
                    .getSimpleName()
                + ">";
        }
    }

    /** PartMap.java 的 27 规范槽位：0–5 面，6 中心，7–14 角，15–26 边。 */
    private static String slotName(int slot) {
        try {
            Class<?> partMap = PartsProbeReflect.cls("codechicken.multipart.PartMap");
            Object[] values = (Object[]) partMap.getMethod("values")
                .invoke(null);
            if (slot >= 0 && slot < values.length) {
                return ((Enum<?>) values[slot]).name();
            }
        } catch (Throwable ignored) {
            // fallthrough
        }
        return "slot_" + slot;
    }
}
