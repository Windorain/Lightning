package com.lightning.mod.client.controlplane.mc.capture;

import net.minecraft.entity.EntityLivingBase;
import net.minecraft.item.ItemStack;
import net.minecraft.nbt.NBTTagCompound;
import net.minecraft.world.World;

/**
 * 虚拟相机实体（contract.md §4.2.1）：渲染期替换 {@code mc.renderViewEntity} 的替身。
 *
 * <h2>为什么用「注入相机」而不是「挪玩家」</h2>
 * 被拍对象的可见性由<b>相机位置</b>决定，而 1.7.10 里这个位置来自 {@code mc.renderViewEntity}。
 * 挪玩家（冻结分支 #17 的路线）要求客户端与服务端两侧一起钉位置、且每次都改真实玩家状态；
 * 注入一个替身则完全不动玩家，同时得到同一份门控位置——例如 AE2 电缆的渲染距离门
 * （{@code TileCableBus.getMaxRenderDistanceSquared()=900.0}，30 方块）是拿相机坐标算的，
 * 相机在 30 格内就渲染，在 30 格外就不渲染，与玩家在哪无关。
 *
 * <h2>关键的三个覆写</h2>
 * <ul>
 * <li>{@link #getEyeHeight()} 返回 <b>0</b>：{@code EntityRenderer.orientCamera} 里
 * {@code f1 = yOffset - 1.62F} 之后把 {@code -f1} 加到视点 y 上，等价于「视点 = posY + yOffset」。
 * yOffset 归零后，相机视点精确等于我们给的 {@code pos}，不需要再猜整合包的怪眼高
 * （冻结分支实测本包 {@code getEyeHeight()=0.12}），也不会引入半格偏差。
 * 后文 {@code renderWorld} 里 {@code ActiveRenderInfo.updateRenderInfo} 还会把玩家眼高加回投影原点，
 * 但相机在副本上渲染、玩家原体不动，两者互不影响。</li>
 * <li>{@link #onEntityUpdate()} 空实现：替身不进世界 tick，不会位移、不会掉血、不会发声音；</li>
 * <li>{@link #canBeCollidedWith()} / {@code isEntityAlive()} 给渲染器一个「无害实体」的语义。</li>
 * </ul>
 *
 * <h2>prev 值必须与当前值一致</h2>
 * {@code orientCamera} 会对 {@code prevPosX..posX}、{@code prevRotationYaw..rotationYaw} 做
 * 插值（{@code partialTicks}）。替身没有历史帧，若 prev 值留在 0，机位会被插值拉回原点——
 * 实测症状是「图里什么都没有」。因此 {@link #place} 每次把 prev 与当前值一起写。
 */
public final class VirtualCamera extends EntityLivingBase {

    /** 相机位置（渲染期有效）。 */
    private double camX;
    private double camY;
    private double camZ;

    /**
     * @param world 客户端世界（只用于满足 {@code Entity} 的构造约束；本实体从不加入世界、从不 tick）
     */
    public VirtualCamera(World world) {
        super(world);
        // yOffset=0 ⇒ orientCamera 的 (yOffset - 1.62F) 修正后视点 == 我们给的 pos
        this.yOffset = 0.0F;
        this.setSize(0.0F, 0.0F);
        this.noClip = true;
        // 渲染期不需要碰撞/重力/下落
        this.onGround = false;
        this.fallDistance = 0.0F;
        this.motionX = 0.0d;
        this.motionY = 0.0d;
        this.motionZ = 0.0d;
    }

    /**
     * 把相机放到指定位置与朝向（位置/朝向/prev 值一并写）。
     *
     * @param x     世界坐标 x
     * @param y     视点 y（相机位置即视点，因为 yOffset=0）
     * @param z     世界坐标 z
     * @param yaw   偏航角（度）
     * @param pitch 俯仰角（度）
     */
    public void place(double x, double y, double z, double yaw, double pitch) {
        this.camX = x;
        this.camY = y;
        this.camZ = z;
        setPosition(x, y, z);
        this.prevPosX = x;
        this.prevPosY = y;
        this.prevPosZ = z;
        this.lastTickPosX = x;
        this.lastTickPosY = y;
        this.lastTickPosZ = z;
        this.rotationYaw = (float) yaw;
        this.rotationPitch = (float) pitch;
        this.prevRotationYaw = (float) yaw;
        this.prevRotationPitch = (float) pitch;
        this.renderYawOffset = (float) yaw;
        this.prevRenderYawOffset = (float) yaw;
        this.rotationYawHead = (float) yaw;
        this.prevRotationYawHead = (float) yaw;
        this.motionX = 0.0d;
        this.motionY = 0.0d;
        this.motionZ = 0.0d;
        this.fallDistance = 0.0F;
    }

    /** 相机视点 x（= {@link #place} 给的 x）。 */
    public double cameraX() {
        return camX;
    }

    /** 相机视点 y。 */
    public double cameraY() {
        return camY;
    }

    /** 相机视点 z。 */
    public double cameraZ() {
        return camZ;
    }

    /** 替身不进世界 tick（见类注释）。 */
    @Override
    public void onEntityUpdate() {
        // 故意为空：本实体只在渲染期存在，任何世界 tick 副作用（位移、饥饿、AI、音效）都不该发生
    }

    /** 视点高度为 0：相机位置即视点（见类注释）。 */
    @Override
    public float getEyeHeight() {
        return 0.0F;
    }

    /** 不参与碰撞。 */
    @Override
    public boolean canBeCollidedWith() {
        return false;
    }

    /** 渲染器读到这个值时不应把相机当成「已死」而跳过。 */
    @Override
    public boolean isEntityAlive() {
        return true;
    }

    /** 不参与「是否玩家」的分支（第三人称、睡觉镜头等）。 */
    @Override
    public boolean isPlayerSleeping() {
        return false;
    }

    // ------------------------------------------------------------ Entity 抽象方法

    @Override
    protected void entityInit() {
        // 无可同步的数据监视器字段
    }

    @Override
    public void readEntityFromNBT(NBTTagCompound tag) {
        // 不进存档
    }

    @Override
    public void writeEntityToNBT(NBTTagCompound tag) {
        // 不进存档
    }

    @Override
    public ItemStack getHeldItem() {
        return null;
    }

    @Override
    public ItemStack getEquipmentInSlot(int slot) {
        return null;
    }

    @Override
    public void setCurrentItemOrArmor(int slot, ItemStack stack) {
        // 无装备栏
    }

    @Override
    public ItemStack[] getLastActiveItems() {
        return new ItemStack[0];
    }
}
