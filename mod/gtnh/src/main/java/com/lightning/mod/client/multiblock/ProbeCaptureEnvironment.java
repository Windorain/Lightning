package com.lightning.mod.client.multiblock;

import net.minecraft.client.Minecraft;
import net.minecraft.entity.EntityLivingBase;
import net.minecraft.entity.player.EntityPlayer;
import net.minecraft.world.World;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 捕获期的「渲染环境对齐」句柄：把 <b>其它模组渲染代码会去查询的客户端会话状态</b>在捕获窗口内指向
 * <b>被捕获的那个世界</b>，结束后逐项还原。
 * <p>
 * <b>为什么必须有这一步（真实 BUG 的根因，见历史 UV 修复报告，原文见 issue #51 / git 历史）</b>：GT5U 的贴图渲染
 * {@code GTRenderedTexture#getExtendedFacing(x,y,z)} 查机器朝向时，用的世界是
 * <em>{@code GTMod.proxy.getThePlayer().getEntityWorld()}</em>（= {@code mc.thePlayer.worldObj}，
 * 即<b>会话玩家</b>所在世界），而不是正在渲染的那个世界的 {@code IBlockAccess}：
 *
 * <pre>
 * final EntityPlayer player = GTMod.proxy.getThePlayer();   // = mc.thePlayer
 * if (player == null) return ExtendedFacing.DEFAULT;        // 主菜单态：走这里
 * final World w = player.getEntityWorld();
 * final TileEntity te = w.getTileEntity(x, y, z);           // ← 用的是玩家世界，不是渲染世界
 * ...
 * if (alignment != null) return alignment.getExtendedFacing();  // 查到机器朝向
 * return null;                                                  // ← 「查不到」回退分支
 * </pre>
 *
 * 多方块探针把方块建在 {@link ProbeDummyWorld} 里，而客户端玩家在会话世界（管线世界 / 存档）里；
 * 探针坐标（控制器固定在 8,64,8 附近）在会话世界通常是空气 → {@code te == null} → {@code alignment == null}
 * → 走「查不到」回退分支 {@code getFlipped(side, null, icon)}：<b>NORTH 面 flipV、EAST/DOWN 面 flipU</b>。
 * 于是所有带 {@code .extFacing()} 的 GT 图标覆盖层（控制器正面图标 = 扳手、维护仓 OVERLAY_MAINTENANCE、
 * GT++ {@code iconsets/controllerFaces/*} 等）在 NORTH 面上被上下颠倒；而基础外壳/线圈贴图是
 * {@code TextureFactory.builder().addIcon(...)}（{@code useExtFacing=false}）会直接短路成
 * {@code ExtendedFacing.DEFAULT}（不翻转），所以<b>底层纹理不受影响</b>。
 * <p>
 * 对照事实（同一份捕获代码、同一份探针世界、同一批方块）：
 * <ul>
 * <li>T1.3 的 {@code variant_capture/run-0014}（<b>主菜单态</b>，{@code mc.thePlayer == null}）→ 函数在
 * {@code player == null} 处提前返回 {@code DEFAULT} → 覆盖层不翻转；</li>
 * <li>T1.5 管线运行（<b>会话世界内</b>，{@code mc.thePlayer != null}）→ 走到「查不到」回退分支 → 覆盖层被翻转。
 * 两者逐格比对（忽略亮度/颜色）：<b>只有</b> 8 条 {@code .extFacing()} 覆盖层条目的覆盖层四边形差值恰为
 * {@code v → 1-v}，其余 39 条（外壳/线圈/结构/标识）逐字节一致。</li>
 * </ul>
 * 因此正确的语义是：<b>捕获输出必须等于「该方块状态在那个世界里被游戏画出来的样子」</b> —— 朝向查询必须命中
 * <em>被渲染的那个 TE</em>。把会话玩家的 {@code worldObj} 在捕获窗口内指向被捕获世界即可：GT 会拿到真实
 * {@code IAlignment}（{@code IAlignment extends IAlignmentProvider}，多方块 MTE 均实现之）→ 走
 * {@code alignment != null} 分支 → 与游戏内/既有 {@code /sde export}（方块本就在 {@code mc.theWorld} 里、
 * 玩家世界即被渲染世界）完全一致。
 * <p>
 * <b>为什么改 {@code worldObj} 而不是换一个玩家对象</b>：1.7.10 的 {@code Minecraft.thePlayer} 声明类型是
 * {@code EntityClientPlayerMP}（构造需要 {@code NetHandlerPlayClient}），换成假玩家要么引入第 5 处反射、
 * 要么造一个 sendQueue 为 null 的客户端玩家（渲染期一旦有代码调 {@code sendChatMessage} 等即 NPE）。
 * 只把 {@code worldObj} 指向被捕获世界：类型安全、对象身份不变、无新增 NPE 面，且语义正好是
 * 「这个渲染环境里的玩家活在被渲染的世界里」。
 * <p>
 * <b>主菜单态（{@code mc.thePlayer == null}）</b>：没有会话玩家可对齐，GT 自己的
 * {@code player == null → ExtendedFacing.DEFAULT} 分支照旧生效（与 T1.3 的 run-0014 行为一致）。
 * 该分支与「查到真实朝向」是否等价，由 `run-0016`（主菜单态捕获）与修复后管线产物逐格比对回答：
 * 两者覆盖层手性一致 ⇒ 探针机器的 alignment 就是 {@code ExtendedFacing.DEFAULT}，两种环境同解。
 * <p>
 * 另一项既有处置保留：{@code TileEntityRendererDispatcher#cacheActiveRenderInfo} 会解引用
 * {@code mc.renderViewEntity}（1.7.10 实现读 prevRotationYaw 等），主菜单态为 null 会让 TESR 补画整条 NPE
 * 被吞掉，因此仍在为 null 时临时挂上探针假玩家。
 * <p>
 * <b>写范围隔离</b>：本类只被 {@code client/multiblock/} 的捕获入口（{@link VariantGeometryBakery}）使用
 * （原先的另一个使用者 {@code StateGeometryCapture} 已随 Gitea #104 按 V12 裁决删除）；
 * 既有 {@code /sde export} 路径（{@code MeshCaptureService#finalizeSingleStructure}）
 * 不引用本类、一字未动 —— 它捕获的方块本就在玩家的世界里，玩家的世界就是被渲染的世界，无需对齐。
 * <p>
 * <b>证伪方式</b>（证明验收手段真能检出该类镜像）：把本类 {@code begin(...)} 里
 * {@code sessionPlayer.worldObj = captureWorld} 一行临时注释掉重新编译运行，产物应精确退化为
 * 「NORTH 面 {@code .extFacing()} 覆盖层 {@code v → 1-v}」，且
 * {@code scripts/multiblock-pipeline/verify-uv-orientation.mjs --expect clean} 必须变红。
 */
@SideOnly(Side.CLIENT)
public final class ProbeCaptureEnvironment {

    private final Minecraft mc;
    private final EntityLivingBase previousViewEntity;
    /** 捕获窗口内被改过 {@code worldObj} 的会话玩家（null = 主菜单态，无可对齐对象）。 */
    private final EntityPlayer sessionPlayer;
    /** 会话玩家原来的世界（null = 未改动，无需还原）。 */
    private final World sessionPlayerWorld;

    private ProbeCaptureEnvironment(Minecraft mc, EntityLivingBase previousViewEntity, EntityPlayer sessionPlayer,
        World sessionPlayerWorld) {
        this.mc = mc;
        this.previousViewEntity = previousViewEntity;
        this.sessionPlayer = sessionPlayer;
        this.sessionPlayerWorld = sessionPlayerWorld;
    }

    /**
     * 进入捕获窗口：让渲染代码在查询「玩家 / 视角实体」时看到 {@code captureWorld}。
     *
     * @param captureWorld 正在被捕获的世界（探针世界）
     * @param actor        该世界里的探针假玩家（{@link ProbeFakePlayer}；仅供 {@code renderViewEntity} 兜底）
     */
    public static ProbeCaptureEnvironment begin(Minecraft mc, World captureWorld, EntityLivingBase actor) {
        EntityLivingBase previousViewEntity = mc.renderViewEntity;
        if (previousViewEntity == null && actor != null) {
            mc.renderViewEntity = actor;
        }

        EntityPlayer sessionPlayer = mc.thePlayer;
        World sessionPlayerWorld = null;
        if (sessionPlayer != null && captureWorld != null && sessionPlayer.worldObj != captureWorld) {
            sessionPlayerWorld = sessionPlayer.worldObj;
            sessionPlayer.worldObj = captureWorld;
        }
        return new ProbeCaptureEnvironment(mc, previousViewEntity, sessionPlayer, sessionPlayerWorld);
    }

    /** 还原捕获前的会话状态。必须放在 {@code finally} 里调用。 */
    public void end() {
        mc.renderViewEntity = previousViewEntity;
        if (sessionPlayer != null && sessionPlayerWorld != null) {
            sessionPlayer.worldObj = sessionPlayerWorld;
        }
    }
}
