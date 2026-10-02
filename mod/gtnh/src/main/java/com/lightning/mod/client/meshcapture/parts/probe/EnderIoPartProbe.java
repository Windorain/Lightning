package com.lightning.mod.client.meshcapture.parts.probe;

import java.lang.reflect.Field;
import java.util.Collection;

import net.minecraft.client.Minecraft;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.World;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * P0.2 EnderIO 族探针（纯运行时反射，不引用 crazypants 任何编译期类型）。
 *
 * <p>
 * 验证的反射调用链：
 *
 * <pre>
 * mc.theWorld.getTileEntity(x,y,z)              → crazypants.enderio.conduit.TileConduitBundle
 * tile.getConduits()                            → Collection&lt;IConduit&gt;（枚举）
 * conduit.getBaseConduitType()                  → Class（类型键）
 * conduit.createItem()                          → ItemStack（物品身份）
 * conduit.getCollidableComponents()             → Collection&lt;CollidableComponent&gt;
 *   .conduitType / .bound / .dir / .data        → 类型 / 0–1 方块局部盒 / 方向（UNKNOWN=芯，面=连接段）/ 附加数据
 * tile.getCollidableComponents()                → 整格（各导管段 + 连接器），碰撞与选择高亮共用此几何源
 * </pre>
 *
 * <p>
 * 视觉/碰撞盒结论的探针证据：EnderIO <strong>只有一个几何源</strong> ——
 * {@code BlockConduitBundle#addCollisionBoxesToList} 直接用 {@code CollidableComponent#bound} 作碰撞盒；
 * {@code #getSelectedBoundingBoxFromPool}（选择高亮，视觉盒）对 raytrace 命中的同一个 {@code bound}
 * 做 {@code scale(1.09)}（连接器段则平移 0.0125 + 按轴放大 0.7）。因此「视觉盒」可从碰撞盒确定性推导，
 * 不存在独立存储的第二套盒。
 */
@SideOnly(Side.CLIENT)
final class EnderIoPartProbe {

    private EnderIoPartProbe() {}

    static JsonObject probeBlock(Minecraft mc, int x, int y, int z) {
        JsonObject out = new JsonObject();
        JsonArray errors = new JsonArray();
        out.add("errors", errors);
        try {
            World world = mc.theWorld;
            TileEntity te = world.getTileEntity(x, y, z);
            if (te == null || !te.getClass()
                .getName()
                .contains("TileConduitBundle")) {
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

            Collection<?> conduits = (Collection<?>) te.getClass()
                .getMethod("getConduits")
                .invoke(te);
            JsonArray parts = new JsonArray();
            for (Object conduit : conduits) {
                parts.add(probeConduit(conduit, errors));
            }
            out.add("parts", parts);
            out.addProperty("partCount", Integer.valueOf(parts.size()));

            // 整格几何源（碰撞与选择高亮共用）：各导管段 + 连接器
            try {
                Object all = te.getClass()
                    .getMethod("getCollidableComponents")
                    .invoke(te);
                out.add("wholeTileCollidableComponents", toComponentArray((Collection<?>) all));
            } catch (Throwable t) {
                errors.add(new JsonPrimitive("tile.getCollidableComponents: " + PartsProbeReflect.describe(t)));
            }
            try {
                Object conns = te.getClass()
                    .getMethod("getConnectors")
                    .invoke(te);
                out.add("wholeTileConnectors", toComponentArray((Collection<?>) conns));
            } catch (Throwable t) {
                errors.add(new JsonPrimitive("tile.getConnectors: " + PartsProbeReflect.describe(t)));
            }
            Object facade = te.getClass()
                .getMethod("getFacadeId")
                .invoke(te);
            out.addProperty(
                "facadeId",
                facade == null ? "none"
                    : facade.getClass()
                        .getName());
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("probeBlock: " + PartsProbeReflect.describe(t)));
        }
        return out;
    }

    private static JsonObject probeConduit(Object conduit, JsonArray errors) {
        JsonObject o = new JsonObject();
        o.addProperty(
            "conduitClass",
            conduit.getClass()
                .getName());
        try {
            Object baseType = conduit.getClass()
                .getMethod("getBaseConduitType")
                .invoke(conduit);
            o.addProperty("baseConduitType", ((Class<?>) baseType).getName());
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("getBaseConduitType: " + PartsProbeReflect.describe(t)));
        }
        try {
            Object stack = conduit.getClass()
                .getMethod("createItem")
                .invoke(conduit);
            o.add("item", PartsProbeReflect.stackIdentity((net.minecraft.item.ItemStack) stack));
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("createItem: " + PartsProbeReflect.describe(t)));
        }
        try {
            Object comps = conduit.getClass()
                .getMethod("getCollidableComponents")
                .invoke(conduit);
            o.add("collidableComponents", toComponentArray((Collection<?>) comps));
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("getCollidableComponents: " + PartsProbeReflect.describe(t)));
        }
        return o;
    }

    private static JsonArray toComponentArray(Collection<?> comps) {
        JsonArray a = new JsonArray();
        if (comps == null) {
            return a;
        }
        for (Object comp : comps) {
            JsonObject c = new JsonObject();
            try {
                Object conduitType = PartsProbeReflect.field(comp, "conduitType");
                c.addProperty(
                    "conduitType",
                    conduitType == null ? "null(connector)" : ((Class<?>) conduitType).getName());
                Object bound = PartsProbeReflect.field(comp, "bound");
                c.add("bound", boundingBox(bound));
                Object dir = PartsProbeReflect.field(comp, "dir");
                c.addProperty("dir", String.valueOf(dir));
                Object data = PartsProbeReflect.field(comp, "data");
                c.addProperty(
                    "data",
                    data == null ? "null"
                        : data.getClass()
                            .getName() + ":"
                            + data);
            } catch (Throwable t) {
                c.addProperty("error", PartsProbeReflect.describe(t));
            }
            a.add(c);
        }
        return a;
    }

    /** com.enderio.core.client.render.BoundingBox：public final float minX..maxZ，0–1 方块局部。 */
    private static JsonArray boundingBox(Object bound) throws Exception {
        JsonArray a = new JsonArray();
        String[] names = { "minX", "minY", "minZ", "maxX", "maxY", "maxZ" };
        for (String n : names) {
            Field f = bound.getClass()
                .getField(n);
            a.add(new JsonPrimitive(Double.valueOf(((Number) f.get(bound)).doubleValue())));
        }
        return a;
    }
}
