package com.lightning.mod.client.controlplane.mc;

import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.Tier;

/**
 * {@code world.resync}（scene，同步）：把区域内 TE 的状态<b>重新下发</b>给客户端。
 *
 * <p>
 * 为什么需要它：托管世界是靠直接写服务端世界搭出来的，客户端的 TE 状态只能靠模组自己的同步包到达。
 * 依赖「邻居变化才重算、算出才下发」的模组（典型：LP 管道——连接矩阵在服务端
 * {@code computeConnections()} 之后经 {@code sendUpdateToClient()} 下发）一旦在客户端真正
 * watch 该区块之前完成过同步，之后没有新的变化事件，客户端会<b>永久停在空状态</b>：实测客户端
 * {@code renderState.pipeConnectionMatrix} 全为 false，而服务端同坐标的 {@code renderStateConnections}
 * 是 {@code EAST:true}；捕获侧表现就是导出里管道只有管体、没有连接臂与 {@code -status}/{@code -inactive} 贴图层。
 *
 * <p>
 * 本动作只做「重发方块更新包」（{@link WorldServer#markBlockForUpdate}），不重算、不改任何模组状态，
 * 也不派发邻居事件（后者会在服务端 tick 迭代里触发 TE 增删，实测直接崩服）。它不修改世界，因此
 * <b>不受捕获会话写动作门禁</b>限制。包投递发生在下一 tick，调用方须在其后至少隔一个 tick 再录制。
 *
 * <p>
 * 参数：{@code from}/{@code to}（区域两角，体积 ≤ 4096）。
 */
public final class WorldResyncAction implements ControlAction {

    public static final String NAME = "world.resync";

    private static final int MAX_VOLUME = 4096;

    @Override
    public JsonObject execute(ActionContext ctx) {
        WorldServer world = WorldRuntime.serverWorld();
        if (world == null) {
            throw new CpException(ErrorCodes.STATE, "服务端权威世界不可用（未进入世界）");
        }
        int[] from = coords(ctx, "from");
        int[] to = coords(ctx, "to");
        long volume = (long) (Math.abs(to[0] - from[0]) + 1) * (Math.abs(to[1] - from[1]) + 1)
            * (Math.abs(to[2] - from[2]) + 1);
        if (volume > MAX_VOLUME) {
            throw CpException.param("区域过大", "from/to", "体积 " + volume + " 超过上限 " + MAX_VOLUME);
        }
        int x0 = Math.min(from[0], to[0]), x1 = Math.max(from[0], to[0]);
        int y0 = Math.min(from[1], to[1]), y1 = Math.max(from[1], to[1]);
        int z0 = Math.min(from[2], to[2]), z1 = Math.max(from[2], to[2]);
        int teCount = 0;
        int marked = 0;
        int resynced = 0;
        for (int x = x0; x <= x1; x++) {
            for (int y = y0; y <= y1; y++) {
                for (int z = z0; z <= z1; z++) {
                    TileEntity te = world.getTileEntity(x, y, z);
                    if (te == null) {
                        continue;
                    }
                    teCount++;
                    world.markBlockForUpdate(x, y, z);
                    marked++;
                    // 说明包不够用时补一次「模组自己的重算入口」：LP 管道把连接矩阵放在
                    // onNeighborBlockChange → scheduleNeighborChange（置 blockNeighborChange）之后算，
                    // 由服务端 tick 重算并 sendUpdateToClient() 下发。只触碰 TE 自身状态，不动世界。
                    if (scheduleNeighborChange(te)) {
                        resynced++;
                    }
                }
            }
        }
        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            "TE 状态重发：" + marked + " 个方块更新包",
            Json.object("teCount", Integer.valueOf(teCount)));
        JsonObject o = new JsonObject();
        o.addProperty("schema", "lightning.cp-world-resync/1");
        o.addProperty("action", NAME);
        o.addProperty("tier", Tier.SCENE.id());
        o.addProperty("teCount", teCount);
        o.addProperty("marked", marked);
        o.addProperty("resynced", resynced);
        JsonArray f = new JsonArray();
        JsonArray l = new JsonArray();
        for (int i = 0; i < 3; i++) {
            // gson 2.2.4（运行期实载）没有 JsonArray.add(Number)，只能用 JsonPrimitive
            f.add(new com.google.gson.JsonPrimitive(Integer.valueOf(from[i])));
            l.add(new com.google.gson.JsonPrimitive(Integer.valueOf(to[i])));
        }
        o.add("from", f);
        o.add("to", l);
        return o;
    }

    /** 反射调用模组的「重算并下发」入口（当前只有 LP 管道有）；不存在的 TE 返回 false。 */
    private static boolean scheduleNeighborChange(TileEntity te) {
        try {
            te.getClass()
                .getMethod("scheduleNeighborChange")
                .invoke(te);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    private static int[] coords(ActionContext ctx, String name) {
        JsonArray a = ctx.optArray(name);
        if (a == null || a.size() != 3) {
            throw CpException.param("缺少或非法的位置参数", name, "需要 [x,y,z]，收到: " + a);
        }
        int[] out = new int[3];
        for (int i = 0; i < 3; i++) {
            try {
                double v = a.get(i)
                    .getAsDouble();
                if (v != Math.rint(v)) {
                    throw CpException.param("坐标必须是整数", name, "第 " + i + " 项: " + a.get(i));
                }
                out[i] = (int) Math.rint(v);
            } catch (CpException e) {
                throw e;
            } catch (RuntimeException e) {
                throw CpException.param("坐标必须是整数", name, "第 " + i + " 项: " + a.get(i));
            }
        }
        return out;
    }
}
