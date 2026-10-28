package com.lightning.mod.client.controlplane.mc;

import net.minecraft.client.Minecraft;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.WorldServer;
import net.minecraft.world.storage.WorldInfo;

/**
 * 服务端权威侧访问口：集成服世界、服务端玩家，以及无人值守下的「玩家稳定化」。
 *
 * <p>
 * 场景构建（contract.md §10 第 5 条）必须作用在服务端世界
 * （{@code MinecraftServer.getServer().worldServers[0]}），而不是客户端 {@code WorldClient}——
 * 只有前者是权威侧，TE 补全的 S35 摄取也只在服务端世界成立。
 *
 * <p>
 * 沿用既有探针（{@code LpTeRoundTripAutomation#place}，已删除）的调用约定：在客户端 tick 线程内直接触碰
 * 服务端世界对象。1.7.10 的集成服里这是既有事实口径，代价是跨线程访问——因此每次访问都先判空、
 * 每次动作后都留静置 tick，让服务端线程收敛。
 */
public final class WorldRuntime {

    /** 进入世界后「稳定玩家」的 tick 数（重设位置与飞行状态，避免虚空里坠落）。 */
    public static final int STABILIZE_TICKS = 3;

    private WorldRuntime() {}

    /** 客户端实例（可能为 null）。 */
    public static Minecraft mc() {
        try {
            return Minecraft.getMinecraft();
        } catch (Throwable t) {
            return null;
        }
    }

    /** 集成服实例；未起来时为 null。 */
    public static MinecraftServer server() {
        try {
            return MinecraftServer.getServer();
        } catch (Throwable t) {
            return null;
        }
    }

    /** 服务端权威世界（维度 0）；不可用时为 null。 */
    public static WorldServer serverWorld() {
        MinecraftServer s = server();
        if (s == null) {
            return null;
        }
        WorldServer[] worlds = s.worldServers;
        if (worlds == null) {
            return null;
        }
        for (WorldServer w : worlds) {
            if (w != null) {
                return w;
            }
        }
        return null;
    }

    /** 服务端首位玩家；没有时为 null。 */
    public static EntityPlayerMP serverPlayer() {
        MinecraftServer s = server();
        if (s == null || s.getConfigurationManager() == null) {
            return null;
        }
        try {
            java.util.List<?> players = s.getConfigurationManager().playerEntityList;
            if (players == null || players.isEmpty()) {
                return null;
            }
            Object o = players.get(0);
            return o instanceof EntityPlayerMP ? (EntityPlayerMP) o : null;
        } catch (Throwable t) {
            return null;
        }
    }

    /** 场景可用性：客户端世界 + 服务端世界 + 服务端玩家都在位。 */
    public static boolean sceneReady(Minecraft mc) {
        return mc != null && mc.theWorld != null && serverWorld() != null && serverPlayer() != null;
    }

    /**
     * 玩家稳定化（可重复调用，幂等）。
     *
     * <p>
     * 为什么必须有这一步：托管世界是<b>全虚空</b>（无基岩无土层），世界出生点在空中学，
     * 玩家会直接坠向世界外并在 y&lt;-64 处死亡——无人值守流程随即卡在死亡界面上。
     * 因此进世界后把玩家移到构建基点上方（未给基点则用世界出生点上方），并开通创造飞行；
     * 只动玩家实体，<b>不</b>往世界里加任何方块，故不影响场景清单哈希与幂等判据。
     *
     * @param base 构建基点 {@code [x,y,z]}；为 null 时用世界出生点
     * @return 是否已找到服务端玩家并施加稳定化
     */
    public static boolean stabilizePlayer(int[] base) {
        EntityPlayerMP player = serverPlayer();
        WorldServer world = serverWorld();
        if (player == null || world == null) {
            return false;
        }
        double x;
        double y;
        double z;
        if (base != null && base.length == 3) {
            x = base[0] + 0.5d;
            y = base[1] + 1.0d;
            z = base[2] + 0.5d;
        } else {
            WorldInfo info = world.getWorldInfo();
            int sy = info.getSpawnY();
            if (sy <= 0) {
                sy = 64;
            }
            x = info.getSpawnX() + 0.5d;
            y = sy + 1.0d;
            z = info.getSpawnZ() + 0.5d;
        }
        try {
            player.setPositionAndUpdate(x, y, z);
            player.capabilities.allowFlying = true;
            player.capabilities.isFlying = true;
            player.fallDistance = 0.0F;
            player.sendPlayerAbilities();
            return true;
        } catch (Throwable t) {
            CpLog.warn("玩家稳定化失败（不影响世界构建）: %s", String.valueOf(t));
            return false;
        }
    }
}
