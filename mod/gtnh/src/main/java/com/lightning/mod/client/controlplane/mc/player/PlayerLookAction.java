package com.lightning.mod.client.controlplane.mc.player;

import net.minecraft.client.entity.EntityClientPlayerMP;
import net.minecraft.client.network.NetHandlerPlayClient;
import net.minecraft.entity.player.EntityPlayerMP;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * {@code player.look}（scene，同步）：<b>经玩家转向路径</b>改变玩家朝向（含看向某个点/某个实体）。
 *
 * <h2>与 {@code scene.player.pose} 的两义（裁决 3）</h2>
 * L0 的 {@code scene.player.pose} 直接写服务端玩家的 {@code rotationYaw/rotationPitch} 并走 S08
 * ——那是「把玩家的朝向<b>摆</b>成某个值」。本动作走的是玩家路径：
 * <ol>
 * <li>按原版鼠标输入的口径<b>分步转动</b>（{@code MouseHelper} 的 delta 语义：
 * 每步 yaw -= dx*0.15、pitch += dy*0.15，见 {@code Entity.setAngles}）；
 * 两步之间调 {@link EntityClientPlayerMP#sendMotionUpdates()}，让客户端把 C03/C05 朝向包发出去；</li>
 * <li>服务端在 {@code NetHandlerPlayServer.processPlayer} 里接收并写进 {@code EntityPlayerMP.rotationYaw/Pitch}。</li>
 * </ol>
 * 因此「看过去了」在这里是玩家路径的产物；{@code scene.player.pose} 的转向不是。两层结论不互替。
 *
 * <h2>三种形态</h2>
 * <ul>
 * <li>{@code yaw}/{@code pitch}：直接给绝对角度（仍然分步转到）；</li>
 * <li>{@code lookAt:[x,y,z]}：看向世界坐标点，角度由眼睛→目标算出；</li>
 * <li>{@code entityId}：看向某个实体（眼睛→实体眼睛高度）。</li>
 * </ul>
 * 三者互斥（都缺即 {@code CP-VALID-002}）。
 *
 * <h2>为什么分步（{@code steps&gt;1}）</h2>
 * 一次 180° 的朝向突变在服务端表现为单 tick 的 C03 look 包——那不是玩家能做到的。
 * 分步让「转过去」这件事有过程，也让 yaw 的插值口径与「鼠标移动了 N 像素」一致。
 * {@code steps} 默认 1（够用且最便宜）；要演示「真实转身」给 {@code steps:8..20}。
 */
public final class PlayerLookAction implements ControlAction {

    /** 动作名。 */
    public static final String NAME = "player.look";

    /** 每步最多转过的角度（度）——原版一次鼠标移动的常见量级。 */
    public static final float MAX_DEGREES_PER_STEP = 15.0F;

    @Override
    public JsonObject execute(ActionContext ctx) {
        EntityClientPlayerMP client = PlayerSession.requireClientPlayer(ctx, NAME);
        NetHandlerPlayClient handler = PlayerSession.requireNetHandler(client, NAME);
        EntityPlayerMP server = PlayerSession.serverPlayer();
        if (server == null) {
            throw new CpException(
                ErrorCodes.STATE,
                NAME + "：服务端玩家实体不可用（未进入世界或玩家尚未加入集成服）",
                Json.object("action", NAME, "hint", "先进世界：world.rebuild 或 case.run 的 world 段"));
        }

        Double yawParam = PlayerSession.optNumberPublic(ctx, "yaw");
        Double pitchParam = PlayerSession.optNumberPublic(ctx, "pitch");
        double[] lookAt = optPos(ctx, "lookAt");
        Double entityIdParam = PlayerSession.optNumberPublic(ctx, "entityId");

        int given = 0;
        if (yawParam != null || pitchParam != null) {
            given++;
        }
        if (lookAt != null) {
            given++;
        }
        if (entityIdParam != null) {
            given++;
        }
        if (given == 0) {
            throw new CpException(
                ErrorCodes.VALID_PARAM,
                "缺少朝向目标（三种形态必居其一）",
                Json.object(
                    "fields",
                    Json.object(
                        "yaw",
                        "给 yaw（可配 pitch）",
                        "lookAt",
                        "或 lookAt:[x,y,z]",
                        "entityId",
                        "或 entityId（看向实体）")));
        }
        if (given > 1) {
            throw new CpException(
                ErrorCodes.VALID_PARAM,
                "朝向参数冲突（yaw/pitch、lookAt、entityId 互斥）",
                Json.object(
                    "fields",
                    Json.object(
                        "yaw",
                        yawParam == null ? "未给" : "已给",
                        "lookAt",
                        lookAt == null ? "未给" : "已给",
                        "entityId",
                        entityIdParam == null ? "未给" : "已给")));
        }

        float targetYaw;
        float targetPitch;
        String mode;
        if (lookAt != null) {
            double eyeX = server.posX;
            double eyeY = server.posY + server.getEyeHeight();
            double eyeZ = server.posZ;
            double dx = lookAt[0] - eyeX;
            double dy = lookAt[1] - eyeY;
            double dz = lookAt[2] - eyeZ;
            if (dx * dx + dy * dy + dz * dz < 1.0E-8D) {
                throw CpException.param("lookAt 与玩家眼睛重合", "lookAt", "无法确定朝向，请给一个不同的点");
            }
            double horiz = Math.sqrt(dx * dx + dz * dz);
            // 与 getLook 同口径反解：dx=-sin(yaw)cos(pitch), dy=-sin(pitch), dz=cos(yaw)cos(pitch)
            targetYaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
            targetPitch = (float) Math.toDegrees(-Math.atan2(dy, horiz));
            mode = "lookAt";
        } else if (entityIdParam != null) {
            net.minecraft.entity.Entity target = findEntity(server, entityIdParam.intValue());
            if (target == null) {
                throw new CpException(
                    ErrorCodes.VALID_PARAM,
                    "找不到该实体 id",
                    Json.object(
                        "field",
                        "entityId",
                        "requested",
                        Integer.valueOf(entityIdParam.intValue()),
                        "hint",
                        "用 read.overview 或 scene.entity.spawn 的返回值核对实体 id"));
            }
            double dx = target.posX - server.posX;
            double dy = target.posY + target.getEyeHeight() - (server.posY + server.getEyeHeight());
            double dz = target.posZ - server.posZ;
            double horiz = Math.sqrt(dx * dx + dz * dz);
            targetYaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
            targetPitch = (float) Math.toDegrees(-Math.atan2(dy, horiz));
            mode = "entity";
        } else {
            targetYaw = yawParam == null ? server.rotationYaw : yawParam.floatValue();
            targetPitch = pitchParam == null ? server.rotationPitch : pitchParam.floatValue();
            mode = "angles";
        }
        if (targetPitch < -90.0F) {
            targetPitch = -90.0F;
        }
        if (targetPitch > 90.0F) {
            targetPitch = 90.0F;
        }

        int steps = ctx.optInt("steps", 1);
        if (steps < 1 || steps > 200) {
            throw CpException.param("steps 非法", "steps", "须在 1..200，收到 " + steps);
        }

        JsonObject before = PlayerSession.poseRead(server);
        float startYaw = server.rotationYaw;
        float startPitch = server.rotationPitch;
        float deltaYaw = wrapDegrees(targetYaw - startYaw);
        float deltaPitch = targetPitch - startPitch;

        // 分步转动：每步都过原版客户端的「把朝向发给服务端」出口
        for (int i = 1; i <= steps; i++) {
            float f = (float) i / (float) steps;
            client.rotationYaw = startYaw + deltaYaw * f;
            client.rotationPitch = startPitch + deltaPitch * f;
            client.prevRotationYaw = client.rotationYaw;
            client.prevRotationPitch = client.rotationPitch;
            try {
                client.sendMotionUpdates();
            } catch (Throwable t) {
                throw new CpException(
                    ErrorCodes.EXEC_FAILED,
                    NAME + "：客户端朝向包发送失败（第 " + i + " 步）: " + t,
                    Json.object("action", NAME, "step", Integer.valueOf(i)));
            }
        }
        long serverSyncWaitedMs = PlayerSession.completeClientRequest(handler);

        // 服务端权威侧读回（朝向要等服务端 processPlayer 处理后才是权威值；
        // 本地链路下这一步在同一 tick 内完成，但包处理失败时这里会如实停在旧值）
        EntityPlayerMP srv = PlayerSession.serverPlayer();
        JsonObject after = PlayerSession.poseRead(srv);
        float achievedDelta = 0.0F;
        if (srv != null) {
            achievedDelta = Math.abs(wrapDegrees(srv.rotationYaw - startYaw));
        }
        float wantedDelta = Math.abs(deltaYaw);
        boolean observed = srv != null && (wantedDelta < 1.0E-3F || achievedDelta >= wantedDelta * 0.9F);

        JsonObject o = new JsonObject();
        o.addProperty("mode", mode);
        o.add("target", PlayerSession.doubleArray(targetYaw, targetPitch));
        o.add("before", before);
        o.add("after", after);
        PlayerSession.addFinite(o, "startYaw", startYaw);
        PlayerSession.addFinite(o, "startPitch", startPitch);
        PlayerSession.addFinite(o, "deltaYaw", deltaYaw);
        PlayerSession.addFinite(o, "deltaPitch", deltaPitch);
        o.addProperty("steps", Integer.valueOf(steps));
        PlayerSession.addFinite(o, "achievedYawDelta", achievedDelta);
        PlayerSession.addFinite(o, "tolerance", Math.max(1.0D, Math.abs((double) wantedDelta) * 0.1D));
        o.addProperty("serverSyncWaitedMs", Long.valueOf(serverSyncWaitedMs));
        o.addProperty("observed", Boolean.valueOf(observed));
        if (!observed) {
            o.addProperty(
                "notObservedReason",
                "服务端权威朝向未达成目标：多为包未被处理（链路未就绪）或服务端把玩家拽回了原朝向；" + "服务端当前 yaw="
                    + (srv == null ? "无服务端玩家" : Float.toString(srv.rotationYaw))
                    + "，起始 yaw="
                    + startYaw);
        }
        o.addProperty(
            "pathNote",
            "本动作在客户端玩家对象上分步设置 rotationYaw/Pitch 并经 EntityClientPlayerMP.sendMotionUpdates() 发送"
                + "（C03PacketPlayer.C05PacketPlayerLook），服务端在 NetHandlerPlayServer.processPlayer 接收；"
                + "与 scene.player.pose 的直接写服务端朝向 + S08 是两条路，结论不互替");
        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            NAME + "：转 " + steps + " 步，yaw " + startYaw + " → " + (srv == null ? "?" : srv.rotationYaw),
            Json.object("steps", Integer.valueOf(steps), "observed", Boolean.valueOf(observed)));
        return PlayerSession.decorated(NAME, "turn", o, srv);
    }

    /** 按实体 id 在服务端世界里找实体。 */
    private static net.minecraft.entity.Entity findEntity(EntityPlayerMP player, int entityId) {
        try {
            if (player.worldObj == null) {
                return null;
            }
            java.util.List<?> list = player.worldObj.loadedEntityList;
            if (list != null) {
                for (Object o : list) {
                    if (o instanceof net.minecraft.entity.Entity
                        && ((net.minecraft.entity.Entity) o).getEntityId() == entityId) {
                        return (net.minecraft.entity.Entity) o;
                    }
                }
            }
        } catch (Throwable ignored) {
            // 找不到就是找不到，由调用方报参数错误
        }
        return null;
    }

    /** 把角度差归一化到 (-180, 180]，避免绕远路。 */
    private static float wrapDegrees(float v) {
        float r = v % 360.0F;
        if (r >= 180.0F) {
            r -= 360.0F;
        }
        if (r < -180.0F) {
            r += 360.0F;
        }
        return r;
    }

    private static double[] optPos(ActionContext ctx, String name) {
        com.google.gson.JsonArray a = ctx.optArray(name);
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
}
