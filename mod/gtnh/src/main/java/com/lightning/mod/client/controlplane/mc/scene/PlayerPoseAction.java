package com.lightning.mod.client.controlplane.mc.scene;

import net.minecraft.client.Minecraft;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.CpLog;
import com.lightning.mod.client.controlplane.mc.WorldRuntime;

/**
 * {@code scene.player.pose}（scene，同步）：瞬时设定玩家位置与朝向。
 *
 * <h2>层归属（#96 §4.1 与 裁决 3，两义按层标注）</h2>
 * 本动作是 <b>L0 布景原语</b>：一次性把玩家<b>瞬移</b>到目标点、把朝向设为指定值，不产生任何位移过程。
 * 它与 #101 的 L1「真实移动/转向」（逐 tick 走位、产生真实速度与碰撞）<b>互补而不互替</b>：
 * <ul>
 * <li>要「玩家站在这里看那边」（构造观察条件、布景）→ 用本动作（L0，快、确定、无过程）；</li>
 * <li>要验证「走过去这件事本身」（寻路、碰撞、加速、潜行）→ 用 L1（#101）。L0 的产物不能当 L1 的证据。</li>
 * </ul>
 * 返回值里带 {@code layer:"L0"} 与 {@code semantics:"teleport"} 两个显式标注。
 *
 * <h2>为什么走 {@code setPositionAndUpdate} 而不是直接改 posX/posY/posZ</h2>
 * 1.7.10 里玩家位置是<b>客户端权威</b>的：服务端只接受客户端报上来的位置。直接改
 * {@code posX} 会被下一个 {@code C03PacketPlayer} 覆写回原位（表现为「设了但没动」）。
 * {@code EntityPlayerMP.setPositionAndUpdate} 走的是原版自己的传送出口
 * （{@code playerNetServerHandler.setPlayerLocation} → {@code S08PacketPlayerPosLook}），
 * 客户端收到后把自己的位置与朝向改成服务端给的值——这才是「瞬移生效」的原版路径。
 *
 * <p>
 * 朝向的语义与原版一致：{@code yaw} 是水平朝向（度，0=南/+Z，90=西/-X，180=北/-Z，270=东/+X）；
 * {@code pitch} 是俯仰（<b>正=俯视、负=仰视</b>，与 {@code shot.multi} 的 CameraSpec 同一口径，
 * 见 contract.md §4.1 的机制更正）。
 *
 * <h2>防坠亡</h2>
 * 托管世界是全虚空，瞬移到半空会直接坠向世界外。若 {@code allowFlying} 为真（默认），
 * 本动作顺带开通创造飞行并清零坠落距离——与 {@code WorldRuntime.stabilizePlayer} 的最小稳定化同口径。
 * 只动玩家实体，不进场景清单与哈希。
 */
public final class PlayerPoseAction implements ControlAction {

    /** y 的合法域：与 {@link EntitySpawnAction#checkPos} 同口径。 */
    public static final double MIN_Y = -64.0d;

    /** 见 {@link #MIN_Y}。 */
    public static final double MAX_Y = 320.0d;

    @Override
    public JsonObject execute(ActionContext ctx) {
        Minecraft mc = WorldRuntime.mc();
        WorldServer world = L0Session.requireServerWorld(ctx, "scene.player.pose");
        EntityPlayerMP player = WorldRuntime.serverPlayer();
        if (player == null) {
            throw new CpException(ErrorCodes.STATE, "scene.player.pose：服务端没有玩家实体（集成服玩家未就位）——先 world.rebuild 进入托管世界");
        }

        if (!ctx.has("pos") && !ctx.has("yaw") && !ctx.has("pitch")) {
            throw CpException.param("没有可写字段", "pos|yaw|pitch", "至少给一个：pos[x,y,z] | yaw | pitch");
        }

        double[] beforePos = { player.posX, player.posY, player.posZ };
        float beforeYaw = player.rotationYaw;
        float beforePitch = player.rotationPitch;

        double[] pos = ctx.has("pos") ? EntitySpawnAction.optPos(ctx, "pos") : null;
        if (pos != null) {
            EntitySpawnAction.checkPos(pos, "pos");
        } else if (ctx.has("pos")) {
            throw CpException.param("pos 参数非法", "pos", "须为 [x,y,z] 三个数");
        }
        float yaw = player.rotationYaw;
        float pitch = player.rotationPitch;
        if (ctx.has("yaw")) {
            yaw = (float) ctx.optLong("yaw", (long) player.rotationYaw);
            if (ctx.param("yaw")
                .isJsonPrimitive()
                && ctx.param("yaw")
                    .getAsJsonPrimitive()
                    .isNumber()) {
                yaw = ctx.param("yaw")
                    .getAsFloat();
            }
        }
        if (ctx.has("pitch")) {
            pitch = (float) ctx.optLong("pitch", (long) player.rotationPitch);
            if (ctx.param("pitch")
                .isJsonPrimitive()
                && ctx.param("pitch")
                    .getAsJsonPrimitive()
                    .isNumber()) {
                pitch = ctx.param("pitch")
                    .getAsFloat();
            }
            if (pitch < -90.0f || pitch > 90.0f) {
                throw CpException.param("pitch 越界", "pitch", "须在 -90..90（正=俯视、负=仰视），收到 " + pitch);
            }
        }

        // 服务端侧先落位（对齐 posX/posY/posZ 与朝向，供同 tick 后续读面使用）……
        double tx = pos == null ? player.posX : pos[0];
        double ty = pos == null ? player.posY : pos[1];
        double tz = pos == null ? player.posZ : pos[2];
        player.setPositionAndUpdate(tx, ty, tz);
        player.rotationYaw = yaw;
        player.rotationPitch = pitch;
        player.prevRotationYaw = yaw;
        player.prevRotationPitch = pitch;
        // ……然后再走一次原版传送出口，把「位置 + 朝向」一起交给客户端
        // （setPositionAndUpdate 内部用的是调用时刻的 rotationYaw/rotationPitch，故顺序不能反）
        player.setPositionAndUpdate(tx, ty, tz);

        boolean flying = ctx.optBool("allowFlying", true);
        if (flying) {
            try {
                player.capabilities.allowFlying = true;
                player.capabilities.isFlying = true;
                player.fallDistance = 0.0f;
                player.sendPlayerAbilities();
            } catch (Throwable t) {
                // 稳定化失败不该让「位置已设」这件事变成失败——如实留痕
                CpLog.warn("飞行稳定化失败（位置已设，不影响本动作结论）: %s", String.valueOf(t));
            }
        }

        JsonObject o = new JsonObject();
        o.addProperty("layer", "L0");
        o.addProperty("semantics", "teleport");
        o.addProperty("layerNote", "瞬时传送/转向（L0 布景原语），不产生位移过程；真实移动/转向属 L1（#101），两层结论不互替");
        JsonObject before = new JsonObject();
        before.add("pos", dbl(beforePos));
        before.addProperty("yaw", Float.valueOf(beforeYaw));
        before.addProperty("pitch", Float.valueOf(beforePitch));
        JsonObject after = new JsonObject();
        after.add("pos", dbl(new double[] { player.posX, player.posY, player.posZ }));
        after.addProperty("yaw", Float.valueOf(player.rotationYaw));
        after.addProperty("pitch", Float.valueOf(player.rotationPitch));
        after.addProperty("allowFlying", Boolean.valueOf(player.capabilities.allowFlying));
        after.addProperty("isFlying", Boolean.valueOf(player.capabilities.isFlying));
        o.add("before", before);
        o.add("after", after);
        o.addProperty("playerName", player.getCommandSenderName());
        // 客户端侧的可观察值：S08PacketPlayerPosLook 后客户端会收敛到同一位置（同步需若干 tick）
        o.add("clientView", clientView(mc));
        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            "scene.player.pose：pos=" + Json.toJson(dbl(new double[] { player.posX, player.posY, player.posZ }))
                + " yaw="
                + player.rotationYaw
                + " pitch="
                + player.rotationPitch,
            Json.object(
                "player",
                player.getCommandSenderName(),
                "pos",
                dbl(new double[] { player.posX, player.posY, player.posZ })));
        return L0Session.decorated("scene.player.pose", o, world, mc);
    }

    private static JsonObject clientView(Minecraft mc) {
        JsonObject o = new JsonObject();
        if (mc == null || mc.thePlayer == null) {
            o.addProperty("available", false);
            return o;
        }
        o.addProperty("available", true);
        o.add("pos", dbl(new double[] { mc.thePlayer.posX, mc.thePlayer.posY, mc.thePlayer.posZ }));
        o.addProperty("yaw", Float.valueOf(mc.thePlayer.rotationYaw));
        o.addProperty("pitch", Float.valueOf(mc.thePlayer.rotationPitch));
        o.addProperty("playerName", mc.thePlayer.getCommandSenderName());
        return o;
    }

    private static JsonArray dbl(double[] v) {
        JsonArray a = new JsonArray();
        for (double d : v) {
            Json.add(a, Double.valueOf(Math.round(d * 1000.0d) / 1000.0d));
        }
        return a;
    }
}
