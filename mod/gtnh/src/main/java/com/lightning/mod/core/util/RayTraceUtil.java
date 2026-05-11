package com.lightning.mod.core.util;

import net.minecraft.entity.player.EntityPlayer;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.util.MovingObjectPosition;
import net.minecraft.util.Vec3;

/**
 * 玩家视线与方块交点。{@link EntityLivingBase#rayTrace} 在 Forge 1.7.10 为客户端专用；服务端选区需自行从眼高发射，
 * 并与 {@link net.minecraft.client.renderer.EntityRenderer#getMouseOver} 所用距离一致（即
 * {@code ItemInWorldManager#getBlockReachDistance}，生存约 4.5、创造 5.0）。
 */
public final class RayTraceUtil {

    private static final double SURVIVAL_REACH = 4.5D;

    private RayTraceUtil() {}

    /**
     * 与准星/客户端拾取一致：从眼高沿视角射线，使用玩家当前游戏模式下的标准伸手距离；命中方块时返回
     * {@link MovingObjectPosition}，否则 null 或非 BLOCK。
     */
    public static MovingObjectPosition rayTraceBlock(EntityPlayer player) {
        return rayTraceBlock(player, blockReachFor(player));
    }

    /**
     * @param reach 最大射线长度（体素段内首块，一般与 {@link #blockReachFor} 相同即可对齐准星）
     */
    public static MovingObjectPosition rayTraceBlock(EntityPlayer player, double reach) {
        Vec3 start = Vec3.createVectorHelper(player.posX, player.posY + (double) player.getEyeHeight(), player.posZ);
        Vec3 look = player.getLook(1.0F);
        Vec3 end = start.addVector(look.xCoord * reach, look.yCoord * reach, look.zCoord * reach);
        // 与 net.minecraft.entity.EntityLivingBase#rayTrace 中 World#func_147447_a 参数一致
        return player.worldObj.func_147447_a(start, end, false, false, true);
    }

    public static double blockReachFor(EntityPlayer player) {
        if (player instanceof EntityPlayerMP) {
            return ((EntityPlayerMP) player).theItemInWorldManager.getBlockReachDistance();
        }
        return SURVIVAL_REACH;
    }

    public static boolean isBlockHit(MovingObjectPosition mop) {
        return mop != null && mop.typeOfHit == MovingObjectPosition.MovingObjectType.BLOCK;
    }
}
