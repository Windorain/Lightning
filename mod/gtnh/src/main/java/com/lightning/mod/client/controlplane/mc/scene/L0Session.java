package com.lightning.mod.client.controlplane.mc.scene;

import net.minecraft.client.Minecraft;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.CpLog;
import com.lightning.mod.client.controlplane.mc.SceneManifest;
import com.lightning.mod.client.controlplane.mc.SceneManifestStore;
import com.lightning.mod.client.controlplane.mc.WorldDescriber;
import com.lightning.mod.client.controlplane.mc.WorldRuntime;
import com.lightning.mod.client.controlplane.mc.capture.CaptureControl;

/**
 * L0 布景原语的公共前置（#99）：写入门控 + 服务端权威世界句柄 + 场景清单回读。
 *
 * <h2>为什么这五组原语全都走「服务端权威世界」</h2>
 * 1.7.10 集成服里 {@code mc.theWorld} 是 {@code WorldClient}——它是权威世界的<b>只读投影</b>：
 * 直接往它身上写（方块、实体、时间、天气）会被下一个 S3x 包覆写，或干脆不产生任何服务端效果。
 * 因此 {@code world.rebuild} 的场景构建、{@code world.info} 的元数据、{@code shot.multi} 的
 * 光照基准都取 {@code MinecraftServer.getServer().worldServers[0]}（见 {@code WorldRuntime} 与
 * {@code WorldDescriber} 的实证注释）。L0 原语沿用同一口径：<b>只在服务端世界上施加状态变更</b>，
 * 客户端侧由原版同步路径（S2B/S1D/S06/S1F/S2F…）自然收敛。
 *
 * <h2>写入门控</h2>
 * 五组原语都是世界写动作，因此开场一律过 {@link CaptureControl#assertWorldWriteAllowed}：
 * 捕获会话期间被别的作业调用即 {@code CP-STATE-001}（契约 §4.1 的既有口径，不是新增规则）。
 *
 * <h2>「世界是不是还跟场景清单一致」怎么答</h2>
 * L0 原语<b>只</b>作用于清单登记的位置集合之外（实体、玩家、背包、时间、天气），或者作用于
 * 清单登记的位置之上（{@code scene.block.set} / {@code scene.clear}）。
 * 因此本类提供 {@link #manifestReadback}：按当前世界内最新场景清单的<b>位置集合</b>实读回读并重算哈希。
 * 调用方（动作）把它放进返回值，读面未就绪时也能自证「这次写发生了哪些可观察变化」。
 * 口径与 {@code world-hash-equals} 判据、{@code SceneManifest.rebuildFromWorld} 完全同源。
 */
public final class L0Session {

    private L0Session() {}

    /**
     * 公共前置：门控 + 取服务端权威世界。
     *
     * @param ctx  动作上下文（用于捕获会话门控的作业归属判定）
     * @param what 动作名（错误信息用）
     * @return 服务端权威世界（非 null）
     * @throws CpException CP-STATE-001：捕获会话期间由别的作业发起；或未进入世界/集成服未起
     */
    public static WorldServer requireServerWorld(ActionContext ctx, String what) {
        CaptureControl.assertWorldWriteAllowed(ctx);
        Minecraft mc = WorldRuntime.mc();
        if (mc == null) {
            throw new CpException(ErrorCodes.STATE, what + "：Minecraft 实例不可用");
        }
        WorldServer world = WorldRuntime.serverWorld();
        if (world == null) {
            throw new CpException(
                ErrorCodes.STATE,
                what + "：服务端权威世界不可用（未进入世界或集成服未起）——先 world.rebuild 进入托管世界",
                Json.object("mcDataDir", mc.mcDataDir == null ? null : mc.mcDataDir.toString()));
        }
        return world;
    }

    /** 集成服实例（供需要玩家表/难度等的原语使用）；未起时 null。 */
    public static MinecraftServer server() {
        return WorldRuntime.server();
    }

    /**
     * 读回当前世界内最新场景清单的位置集合，产出规范化哈希。
     *
     * <p>
     * 清单来源是 {@code SceneManifestStore}（{@code world.rebuild} / {@code case.run} 写进存档目录的那份）。
     * <b>没有清单不算错误</b>：世界可能从未跑过构建段，此时返回 {@code {present:false}} + 原因，
     * 让调用方自己决定（L0 原语不该要求「必须先 world.rebuild」——那会把纪律写死在能力里）。
     *
     * @return {@code {present, sha256?, blockCount?, teCount?, source?}}；无清单时 {@code present=false}
     */
    public static JsonObject manifestReadback(WorldServer world, Minecraft mc) {
        JsonObject out = new JsonObject();
        if (world == null) {
            out.addProperty("present", false);
            out.addProperty("reason", "服务端世界不可用");
            return out;
        }
        JsonObject stored = null;
        try {
            String folder = WorldDescriber.currentFolder(mc);
            stored = SceneManifestStore.read(mc == null ? null : mc.mcDataDir, folder);
        } catch (Throwable t) {
            CpLog.warn("读取场景清单失败（读回哈希将缺失）: %s", String.valueOf(t));
        }
        if (stored == null) {
            out.addProperty("present", false);
            out.addProperty("reason", "当前世界没有场景清单（未跑过 world.rebuild 的构建段或 case.run 的 build 段）");
            return out;
        }
        out.addProperty("present", true);
        out.addProperty("source", "scene-manifest@" + SceneManifest.FILE_NAME);
        JsonObject subset = SceneManifest.readBack(world, stored);
        String sha = SceneManifest.hashOfSubset(subset);
        out.addProperty("sha256", sha);
        out.addProperty("blockCount", size(Json.optArray(subset, "blocks")));
        out.addProperty("teCount", size(Json.optArray(subset, "tileEntities")));
        out.addProperty("storedSha256", Json.optString(stored, "sha256", null));
        out.addProperty("matchesStored", sha.equals(Json.optString(stored, "sha256", null)));
        return out;
    }

    /** 通用收尾：给结果对象补上 {@code sceneReadback}、动作名与契约留痕字段。 */
    public static JsonObject decorated(String action, JsonObject result, WorldServer world, Minecraft mc) {
        result.addProperty("action", action);
        result.add("sceneReadback", manifestReadback(world, mc));
        return result;
    }

    private static int size(com.google.gson.JsonArray a) {
        return a == null ? 0 : a.size();
    }
}
