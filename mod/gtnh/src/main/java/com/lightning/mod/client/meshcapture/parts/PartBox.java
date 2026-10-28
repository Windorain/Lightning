package com.lightning.mod.client.meshcapture.parts;

import net.minecraft.util.AxisAlignedBB;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 部件空间盒（契约 {@code format-parts-contract.md} §3 的 {@code boxes} 行、§6）。
 *
 * <p>
 * 坐标系：<strong>0–1 方块局部、MC 标准朝向（Y-up）</strong>（§6.1）。允许超出 [0,1]³，
 * 如实记录不裁剪（§6.3，实测：栅栏碰撞盒 maxY=1.5）。盒只用于 web 端悬停命中与统计，
 * 不进渲染网格。
 */
@SideOnly(Side.CLIENT)
public final class PartBox {

    /** 盒类别：视觉/选择盒（{@code getSelectedBoundingBoxFromPool} 来源）。 */
    public static final String KIND_VISUAL = "visual";
    /** 盒类别：碰撞盒（{@code getCollisionBoundingBoxFromPool}/{@code addCollisionBoxesToList} 来源）。 */
    public static final String KIND_COLLISION = "collision";

    public final double[] min;
    public final double[] max;
    public final String kind;

    public PartBox(double[] min, double[] max, String kind) {
        this.min = min;
        this.max = max;
        this.kind = kind;
    }

    public PartBox(double minX, double minY, double minZ, double maxX, double maxY, double maxZ, String kind) {
        this(new double[] { minX, minY, minZ }, new double[] { maxX, maxY, maxZ }, kind);
    }

    /**
     * 原版世界坐标盒 → 0–1 方块局部（减格坐标归一化，实测口径；不裁剪，契约 §6.3）。
     */
    public static PartBox fromWorld(AxisAlignedBB worldBox, int x, int y, int z, String kind) {
        return new PartBox(
            worldBox.minX - x,
            worldBox.minY - y,
            worldBox.minZ - z,
            worldBox.maxX - x,
            worldBox.maxY - y,
            worldBox.maxZ - z,
            kind);
    }

    /** 分量级近似相等（盒数值是快照浮点，判定用容差）。 */
    public boolean equalsBox(PartBox other, double eps) {
        if (other == null) {
            return false;
        }
        for (int i = 0; i < 3; i++) {
            if (Math.abs(min[i] - other.min[i]) >= eps || Math.abs(max[i] - other.max[i]) >= eps) {
                return false;
            }
        }
        return true;
    }

    /** 是否为完整整格盒 [0,0,0 → 1,1,1]（0–1 方块局部，容差判定）。 */
    public boolean isFullCell(double eps) {
        return Math.abs(min[0]) < eps && Math.abs(min[1]) < eps
            && Math.abs(min[2]) < eps
            && Math.abs(max[0] - 1.0) < eps
            && Math.abs(max[1] - 1.0) < eps
            && Math.abs(max[2] - 1.0) < eps;
    }

    /** 契约 §3 的 {@code boxes} 行 JSON 形态：{@code {"min":[x,y,z],"max":[x,y,z],"kind":"visual"}}。 */
    public JsonObject toJson() {
        JsonObject o = new JsonObject();
        o.add("min", doubles(min));
        o.add("max", doubles(max));
        o.addProperty("kind", kind);
        return o;
    }

    private static JsonArray doubles(double[] v) {
        JsonArray a = new JsonArray();
        for (double d : v) {
            a.add(new JsonPrimitive(Double.valueOf(round6(d))));
        }
        return a;
    }

    private static double round6(double d) {
        return Math.round(d * 1000000.0) / 1000000.0;
    }
}
