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
 * <h2>视点数学：为什么 {@code yOffset} 必须是 1.62，而不是 0</h2>
 * 1.7.10 的视点由 {@code EntityRenderer.orientCamera} 的这几句 GL 变换决定（反编译源
 * {@code mod/gtnh/build/rfg/minecraft-src/java/net/minecraft/client/renderer/EntityRenderer.java}）：
 *
 * <pre>
 * f1 = entitylivingbase.yOffset - 1.62F; // :555
 * d1 = posY - f1; // :557（:647 对 f1/d1 再算一遍，供雾与云用）
 * GL11.glTranslatef(0, 0, -0.1F); // :636 非第三人称、非睡眠分支
 * GL11.glRotatef(pitch, 1, 0, 0); // :641
 * GL11.glRotatef(yaw + 180, 0, 1, 0); // :642
 * GL11.glTranslatef(0, f1, 0); // :645
 * </pre>
 *
 * <p>
 * 场景几何的坐标是「世界坐标 − renderPos」（{@code WorldRenderer}/{@code RenderManager} 各自减掉），
 * 因此视点就是「在 renderPos 相对坐标里映射到相机原点」的那个点，解
 * {@code T(0,0,-0.1)·Rx(pitch)·Ry(yaw+180)·T(0,f1,0)·g = 0} 得：
 *
 * <pre>
 * g = R⁻¹·(0,0,0.1) − (0, f1, 0)   ⇒   g_y = posY − f1 = posY − (yOffset − 1.62)
 * </pre>
 *
 * <p>
 * 于是：{@code yOffset = 0} 时视点比声明 {@code pos} <b>高 1.62 格</b>（旧注释把这段读成
 * 「视点 = posY + yOffset」并据此把 yOffset 归零，漏掉了 {@code orientCamera} 的 −1.62 常数项，
 * 结论正好相反——机位留痕的 {@code camera.pos} 与实际取景差 1.62 格）；
 * {@code yOffset = 1.62} 时 {@code f1 = 0}，<b>视点 y == 声明 pos.y</b>。
 * 换用 1.62 后残留的只有原版第一人称相机也有的 0.1 常量（世界 −Z 方向的
 * {@code glTranslatef(0,0,-0.1F)}，进相机系后等价于「沿视线后退 0.1 格」，玩家镜头同样如此）：
 * 它与机位声明无关、不随 {@code pos} 变化，故留痕口径以声明 {@code pos} 为准
 * （{@code shots/<name>.meta.json} 的 {@code effectiveEyePos}）。
 *
 * <h2>关键的三个覆写</h2>
 * <ul>
 * <li>{@link #getEyeHeight()} 返回 <b>0</b>：{@code pos} 本身已经是眼位（上面的 yOffset=1.62 抵消了
 * {@code orientCamera} 的 −1.62 常数项），所以「相对 pos 的眼高」必须是 0；否则任何走
 * {@code posY + getEyeHeight()} 的路径（如 {@code EntityRenderer.getMouseOver} 的射线原点）
 * 会把视点再抬高一次。两条路径各管各的：{@code orientCamera} 只读 {@code yOffset} 字段，
 * 从不读 {@code getEyeHeight()}。</li>
 * <li>{@link #onEntityUpdate()} 空实现：替身不进世界 tick，不会位移、不会掉血、不会发声音；</li>
 * <li>{@link #canBeCollidedWith()} / {@code isEntityAlive()} 给渲染器一个「无害实体」的语义。</li>
 * </ul>
 *
 * <p>
 * 旁注：{@code renderWorld} 里的 {@code ActiveRenderInfo.updateRenderInfo(mc.thePlayer, ...)}
 * （{@code EntityRenderer.java:1235}）不参与视点计算——它拿 {@code gluUnProject} 从当前 GL 矩阵反解
 * 视线在近平面上的世界坐标（{@code objectX/Y/Z}），因此自动跟随注入相机；它只从真实玩家取 rotation
 * （影响粒子/公告板的朝向，不影响机位取景）。
 *
 * <p>
 * 已知副作用：{@code Entity.setPosition}（{@code Entity.java:345-352}）把 {@code yOffset} 从 boundingBox
 * 的 y 里减掉，所以替身的包围盒落在 {@code pos − (0, 1.62, 0)}。替身从不加入世界、不被任何实体渲染
 * 路径遍历（它不在 {@code world.loadedEntityList} 里），这份包围盒没有消费方；记在这里只是免得下次
 * 有人动 yOffset 时被它吓到。
 *
 * <h2>prev 值必须与当前值一致</h2>
 * {@code orientCamera} 会对 {@code prevPosX..posX}、{@code prevRotationYaw..rotationYaw} 做
 * 插值（{@code partialTicks}）。替身没有历史帧，若 prev 值留在 0，机位会被插值拉回原点——
 * 实测症状是「图里什么都没有」。因此 {@link #place} 每次把 prev 与当前值一起写。
 */
public final class VirtualCamera extends EntityLivingBase {

    /**
     * 替身的 {@code yOffset}：正好抵消 {@code orientCamera} 的 {@code -1.62F} 常数项。
     *
     * <p>
     * 数值就是玩家眼高（{@code EntityPlayer.getEyeHeight() = 1.62F}）。改这个值等于整体平移所有机位
     * 的取景（每改 1.0 就是 1 格），改之前先读类注释的「视点数学」。
     */
    public static final float ENTITY_Y_OFFSET = 1.62F;

    /** 相机位置（渲染期有效）。 */
    private double camX;
    private double camY;
    private double camZ;

    /**
     * @param world 客户端世界（只用于满足 {@code Entity} 的构造约束；本实体从不加入世界、从不 tick）
     */
    public VirtualCamera(World world) {
        super(world);
        // yOffset = 1.62F ⇒ orientCamera 的 f1 = yOffset - 1.62F = 0 ⇒ 视点 == 声明 pos
        // （旧实现把 yOffset 归零，等于让视点比声明 pos 高 1.62 格；见类注释「视点数学」）
        this.yOffset = ENTITY_Y_OFFSET;
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
     * @param y     视点 y（{@code pos} 即眼位，见类注释「视点数学」）
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

    /**
     * 相对 {@code pos} 的眼高为 0：{@code pos} 本身即眼位（见类注释「视点数学」与「关键的三个覆写」）。
     */
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
