package com.lightning.mod.client.controlplane.mc.player;

import net.minecraft.client.entity.EntityClientPlayerMP;
import net.minecraft.client.multiplayer.PlayerControllerMP;
import net.minecraft.client.network.NetHandlerPlayClient;
import net.minecraft.entity.player.EntityPlayerMP;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * {@code player.move}（scene，同步）：<b>经玩家移动路径</b>把玩家移动到目标位置。
 *
 * <h2>为什么这不是「瞬移」（裁决 3）</h2>
 * L0 的 {@code scene.player.pose} 走 {@code EntityPlayerMP.setPositionAndUpdate}
 * （S08PacketPlayerPosLook）——服务端直接把玩家<b>摆</b>到目标位置，中间没有位移过程，
 * 客户端也只是被动接收新坐标。本动作走的是另一条路：
 * <ol>
 * <li>用原版的 {@code AABB} 碰撞推进（每一小步都过 {@code World.getCollidingBoundingBoxes}），
 * 撞墙就停、落空就下落——这与客户端 {@code Entity.moveEntity} 同一套判定；</li>
 * <li>移动后调 {@link EntityClientPlayerMP#sendMotionUpdates()}，让原版客户端把
 * <b>它自己算出来的</b> C03 位置包发给服务端；</li>
 * <li>服务端在 {@code NetHandlerPlayServer.processPlayer} 里做它一贯的校验
 * （非法姿态 / moved too quickly / moved wrongly / floating），必要时用 S08 把玩家<b>拽回来</b>——
 * 拽回是这条路径的真实后果，本动作如实回读并报告，不掩盖。</li>
 * </ol>
 * 因此「走过去了」在本动作里是玩家路径的产物；{@code scene.player.pose} 的位移不是。
 * 两层结论不互替（#96 §4.2）。
 *
 * <h2>to 与 distance 两种形态</h2>
 * <ul>
 * <li>{@code to:[x,y,z]}：朝该点走，逐 tick 推进直到到达容差内、被卡住、或走完 {@code maxTicks}；</li>
 * <li>{@code distance}（配 {@code direction}）：沿给定方向走固定距离。{@code direction} 默认
 * {@code forward}（按玩家当前 yaw 的前方），也接受 {@code back}/{@code left}/{@code right}。</li>
 * </ul>
 * 两种形态都<b>逐 tick</b>推进（本动作注册为步进动作）：一次 {@code move} 的位移就是
 * 「玩家持续按着方向键若干 tick」的等价物，而不是一帧内插值到终点。
 *
 * <h2>为什么逐 tick 而不是一帧算完</h2>
 * 服务端的 {@code moved too quickly}（位移平方 &gt; 100）与 {@code moved wrongly}（落点与包不符）
 * 判定是按 tick 看的：一帧内瞬移 10 格会被服务端拽回，逐 tick 每步 ≤1 格才是玩家真能做到的速度。
 * 本动作把这一点写进实现而不是写进文档——「便宜试错」要求失败是<b>可解释</b>的。
 */
public final class PlayerMoveAction implements ControlAction {

    /** 动作名。 */
    public static final String NAME = "player.move";

    /** 每 tick 最多推进的格数（原版玩家冲刺约 0.13 格/tick，取 0.5 留足余量且不触发 moved-too-quickly）。 */
    public static final double STEP_PER_TICK = 0.5D;

    /** 到达容差（格）。 */
    public static final double ARRIVE_EPSILON = 0.15D;

    /** 默认最大 tick 数。 */
    public static final int DEFAULT_MAX_TICKS = 200;

    @Override
    public JsonObject execute(ActionContext ctx) {
        EntityClientPlayerMP client = PlayerSession.requireClientPlayer(ctx, NAME);
        PlayerControllerMP controller = PlayerSession.requireController(client, NAME);
        NetHandlerPlayClient handler = PlayerSession.requireNetHandler(client, NAME);

        double[] to = optPos(ctx, "to");
        Double distance = ctx.has("distance") ? PlayerSession.optNumberPublic(ctx, "distance") : null;
        String direction = ctx.optString("direction", "forward");
        if (to == null && distance == null) {
            throw CpException.param("缺少目标", "to", "给 to:[x,y,z] 或 distance（配 direction），二者必居其一");
        }
        if (to != null && distance != null) {
            throw CpException.param("参数冲突", "distance", "to 与 distance 互斥，只能给一个");
        }
        int maxTicks = ctx.optInt("maxTicks", DEFAULT_MAX_TICKS);
        if (maxTicks < 1 || maxTicks > 12000) {
            throw CpException.param("maxTicks 非法", "maxTicks", "须在 1..12000，收到 " + maxTicks);
        }
        boolean allowFlying = ctx.optBool("allowFlying", false);

        EntityPlayerMP server = PlayerSession.serverPlayer();
        if (server == null) {
            throw new CpException(
                ErrorCodes.STATE,
                NAME + "：服务端玩家实体不可用（未进入世界或玩家尚未加入集成服）",
                Json.object("action", NAME, "hint", "先进世界：world.rebuild 或 case.run 的 world 段"));
        }

        if (allowFlying && !client.capabilities.allowFlying) {
            client.capabilities.allowFlying = true;
            client.sendPlayerAbilities();
        }

        JsonArray before = PlayerSession.doubleArray(client.posX, client.posY, client.posZ);
        JsonArray serverBefore = PlayerSession.doubleArray(server.posX, server.posY, server.posZ);

        // 终点：to 直接给；distance 形态按方向与当前 yaw 推
        double targetX;
        double targetY;
        double targetZ;
        if (to != null) {
            targetX = to[0];
            targetY = to[1];
            targetZ = to[2];
        } else {
            double[] dir = directionVector(client, direction);
            targetX = client.posX + dir[0] * distance.doubleValue();
            targetY = client.posY + dir[1] * distance.doubleValue();
            targetZ = client.posZ + dir[2] * distance.doubleValue();
        }

        // 逐 tick 推进：每一 tick 走一小步，然后让原版客户端把位置发给服务端
        int steps = 0;
        int blockedTicks = 0;
        boolean arrived = false;
        for (int i = 0; i < maxTicks; i++) {
            double dx = targetX - client.posX;
            double dy = targetY - client.posY;
            double dz = targetZ - client.posZ;
            double remaining = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (remaining <= ARRIVE_EPSILON) {
                arrived = true;
                break;
            }
            double moved;
            try {
                // 移动原语只有一处实现（PlayerSession.stepToward）：本动作与 player.pickup 共用，
                // 免得两份「走一小步」各自演化出不同缺陷（首轮实测 pickup 那份就是坏的）。
                // stepTowardServer 会做「服务端空间 y → 客户端空间 y」的换算（1.7.10 的 S08 差 1.62，
                // 见 PlayerSession.clientYOffset）：漏了它，目标 y 会凭空多出向下分量，
                // 客户端的 arrived 也永远到不了容差（首轮实测 arrived=false 而 arrivedServer=true）。
                moved = PlayerSession.stepTowardServer(client, server, targetX, targetY, targetZ, STEP_PER_TICK);
            } catch (Throwable t) {
                throw new CpException(
                    ErrorCodes.EXEC_FAILED,
                    NAME + "：移动推进失败（第 " + (i + 1) + " tick）: " + t,
                    Json.object(
                        "action",
                        NAME,
                        "tick",
                        Integer.valueOf(i + 1),
                        "from",
                        PlayerSession.doubleArray(client.posX, client.posY, client.posZ)),
                    t);
            }
            steps++;
            if (moved < 1.0E-4D) {
                blockedTicks++;
            } else {
                blockedTicks = 0;
            }
            if (blockedTicks >= 5) {
                // 连续 5 tick 推不动：被方块挡住了。如实停手（不硬穿墙）。
                break;
            }
        }
        // 集成服在自己线程上按 50ms 一拍处理 C03；不等这一拍，下面的服务端回读会读到旧值，
        // observed 会系统性假红（首轮实机实测踩到）。见 PlayerSession.awaitServerTicks 的注释。
        long serverSyncWaitedMs = PlayerSession.completeClientRequest(handler);

        double endX = client.posX;
        double endY = client.posY;
        double endZ = client.posZ;
        double dxT = targetX - endX;
        double dyT = targetY - endY;
        double dzT = targetZ - endZ;
        double remaining = Math.sqrt(dxT * dxT + dyT * dyT + dzT * dzT);

        JsonObject o = new JsonObject();
        o.addProperty("mode", to != null ? "to" : "distance");
        o.add("target", PlayerSession.doubleArray(targetX, targetY, targetZ));
        if (distance != null) {
            o.addProperty("distance", distance);
            o.addProperty("direction", direction);
        }
        o.add("before", before);
        o.add("serverBefore", serverBefore);
        o.addProperty("ticks", Integer.valueOf(steps));
        o.addProperty("maxTicks", Integer.valueOf(maxTicks));
        o.addProperty("arrived", Boolean.valueOf(arrived || remaining <= ARRIVE_EPSILON));
        o.addProperty("remaining", Double.valueOf(Math.round(remaining * 1000000.0D) / 1000000.0D));
        o.addProperty("blocked", Boolean.valueOf(!arrived && blockedTicks >= 5));
        o.add("clientAfter", PlayerSession.doubleArray(endX, endY, endZ));
        // 服务端读回：真走了多少要看权威侧（客户端预测在撞墙/被拽回时会分叉）
        EntityPlayerMP srv = PlayerSession.serverPlayer();
        o.add("serverAfter", srv == null ? null : PlayerSession.doubleArray(srv.posX, srv.posY, srv.posZ));
        double movedClient = dist(before, endX, endY, endZ);
        double movedServer = srv == null ? -1.0D : dist(serverBefore, srv.posX, srv.posY, srv.posZ);
        double serverRemaining = srv == null ? -1.0D : distTo(targetX, targetY, targetZ, srv.posX, srv.posY, srv.posZ);
        o.addProperty(
            "arrivedServer",
            Boolean.valueOf(serverRemaining >= 0.0D && serverRemaining <= ARRIVE_EPSILON * 4.0D));
        o.addProperty("serverRemaining", Double.valueOf(round(serverRemaining)));
        o.addProperty("movedClientBlocks", Double.valueOf(round(movedClient)));
        o.addProperty("movedServerBlocks", Double.valueOf(round(movedServer)));
        o.addProperty("serverSyncWaitedMs", Long.valueOf(serverSyncWaitedMs));
        // observed 只看服务端权威侧：客户端预测动了而服务端没动（被拽回/被拒）不算观察到
        o.addProperty("observed", Boolean.valueOf(movedServer > 0.01D || (movedClient > 0.01D && srv == null)));
        o.addProperty(
            "pathNote",
            "本动作逐 tick 走原版碰撞推进 + EntityClientPlayerMP.sendMotionUpdates()（C03 家族），"
                + "服务端在 NetHandlerPlayServer.processPlayer 里照常校验（姿态/moved too quickly/moved wrongly/floating）；"
                + "被服务端拽回时 serverAfter 会停在原位而 clientAfter 已前移——那是这条路径的真实后果，不是本动作的缺陷");
        if (!o.get("observed")
            .getAsBoolean() && movedClient > 0.01D) {
            o.addProperty("notObservedReason", "客户端已前移但服务端权威位置未变：多为被服务端拽回（姿态/速度判定）或区块未加载；" + "错误上下文见 context 字段");
            o.add(
                "context",
                Json.object(
                    "movedClientBlocks",
                    Double.valueOf(round(movedClient)),
                    "movedServerBlocks",
                    Double.valueOf(round(movedServer))));
        }
        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            NAME + "：走 " + steps + " tick，客户端位移 " + round(movedClient) + " 格，服务端 " + round(movedServer) + " 格",
            Json.object(
                "ticks",
                Integer.valueOf(steps),
                "arrived",
                Boolean.valueOf(arrived),
                "movedServerBlocks",
                Double.valueOf(round(movedServer))));
        return PlayerSession.decorated(NAME, "walk", o, srv);
    }

    /** 方向单位向量（yaw 语义与 {@code scene.player.pose} 一致：0=南/+Z、90=西/-X）。 */
    private static double[] directionVector(EntityClientPlayerMP client, String direction) {
        String d = direction == null ? "forward"
            : direction.trim()
                .toLowerCase(java.util.Locale.ROOT);
        float yaw = client.rotationYaw;
        double fx = -Math.sin(Math.toRadians(yaw));
        double fz = Math.cos(Math.toRadians(yaw));
        switch (d) {
            case "forward":
                return new double[] { fx, 0.0D, fz };
            case "back":
                return new double[] { -fx, 0.0D, -fz };
            case "left":
                return new double[] { -Math.cos(Math.toRadians(yaw)), 0.0D, -Math.sin(Math.toRadians(yaw)) };
            case "right":
                return new double[] { Math.cos(Math.toRadians(yaw)), 0.0D, Math.sin(Math.toRadians(yaw)) };
            case "up":
                return new double[] { 0.0D, 1.0D, 0.0D };
            case "down":
                return new double[] { 0.0D, -1.0D, 0.0D };
            default:
                throw CpException.param(
                    "direction 非法",
                    "direction",
                    "只允许 forward | back | left | right | up | down，收到: " + direction);
        }
    }

    private static double[] optPos(ActionContext ctx, String name) {
        JsonArray a = ctx.optArray(name);
        if (a == null) {
            return null;
        }
        if (a.size() != 3) {
            throw CpException.param("坐标非法", name, "须为 [x,y,z] 三个数");
        }
        double[] out = new double[3];
        for (int i = 0; i < 3; i++) {
            try {
                out[i] = a.get(i)
                    .getAsDouble();
            } catch (RuntimeException e) {
                throw CpException.param("坐标分量非法", name + "[" + i + "]", "须为数字");
            }
        }
        return out;
    }

    private static double dist(JsonArray from, double x, double y, double z) {
        double dx = from.get(0)
            .getAsDouble() - x;
        double dy = from.get(1)
            .getAsDouble() - y;
        double dz = from.get(2)
            .getAsDouble() - z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    private static double distTo(double x, double y, double z, double x2, double y2, double z2) {
        double dx = x - x2;
        double dy = y - y2;
        double dz = z - z2;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    private static double round(double v) {
        return Math.round(v * 1000.0D) / 1000.0D;
    }
}
