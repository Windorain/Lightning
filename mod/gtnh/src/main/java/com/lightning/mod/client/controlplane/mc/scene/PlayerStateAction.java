package com.lightning.mod.client.controlplane.mc.scene;

import net.minecraft.client.Minecraft;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.potion.Potion;
import net.minecraft.potion.PotionEffect;
import net.minecraft.world.WorldServer;
import net.minecraft.world.WorldSettings;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.CpLog;
import com.lightning.mod.client.controlplane.mc.WorldRuntime;

/**
 * {@code scene.player.state}（scene，同步）：设定服务端权威玩家的游戏模式 / 生命 / 经验 / 药水效果。
 *
 * <h2>层归属（本动作是 L0）</h2>
 * 直接把状态<b>写进玩家实体</b>，不经玩家行为路径。用于「构造输入」（例如「玩家处于生存模式且血量 1」
 * 这种前置条件），不是「玩家做了什么」的证据。
 *
 * <h2>服务端权威 + 原版同步路径</h2>
 * 与 {@link L0Session} 共同的纪律：只改 {@code MinecraftServer} 侧的 {@link EntityPlayerMP}，
 * 然后走原版自己的同步出口——客户端侧由这些包自然收敛，不需要也不允许自造同步：
 * <table border="1">
 * <caption>写入点 → 同步出口</caption>
 * <tr>
 * <th>字段</th>
 * <th>服务端写入</th>
 * <th>客户端可见性</th>
 * </tr>
 * <tr>
 * <td>游戏模式</td>
 * <td>{@code player.setGameType(WorldSettings.GameType)}</td>
 * <td>内部发 {@code S2BPacketChangeGameState(3, id)}（{@code EntityPlayerMP.setGameType}）</td>
 * </tr>
 * <tr>
 * <td>生命</td>
 * <td>{@code player.setHealth(f)} + {@code setPlayerHealthUpdated()}</td>
 * <td>后者把 {@code lastHealth} 打回哨兵值，令 {@code onUpdate} 立刻发 {@code S06PacketUpdateHealth}</td>
 * </tr>
 * <tr>
 * <td>经验</td>
 * <td>写 {@code experienceLevel}/{@code experienceTotal}/{@code experience}</td>
 * <td>{@code onUpdate} 发现 {@code experienceTotal != lastExperience} 即发 {@code S1FPacketSetExperience}</td>
 * </tr>
 * <tr>
 * <td>药水效果</td>
 * <td>{@code player.addPotionEffect(PotionEffect)}</td>
 * <td>{@code EntityPlayerMP.onNewPotionEffect} 发 {@code S1DPacketEntityEffect}</td>
 * </tr>
 * </table>
 * 这些出口都是原版自己的路径，不是本项目另加的回填（契约 §10 第 6 条禁止「逐字段从静态数据推算回填」）。
 *
 * <h2>生命值域</h2>
 * 生命上限取玩家自身的 {@code getMaxHealth()}（GTNH 的药水/装备可改它），上界钳到
 * {@code maxHealth}，下界 1.0——<b>不允许设为 0</b>：那会立刻触发死亡流程，无人值守场景随即卡在
 * 死亡界面。想造「濒死」输入用 {@code 1.0}；真想杀玩家请显式用别的动作（本期不提供）。
 */
public final class PlayerStateAction implements ControlAction {

    /** 生命下限（见类注释：0 = 死亡流程，本动作不提供）。 */
    public static final float MIN_HEALTH = 1.0f;

    /** 药水效果条数上限。 */
    public static final int MAX_EFFECTS = 32;

    @Override
    public JsonObject execute(ActionContext ctx) {
        Minecraft mc = WorldRuntime.mc();
        WorldServer world = L0Session.requireServerWorld(ctx, "scene.player.state");
        EntityPlayerMP player = WorldRuntime.serverPlayer();
        if (player == null) {
            throw new CpException(
                com.lightning.mod.client.controlplane.core.ErrorCodes.STATE,
                "scene.player.state：服务端没有玩家实体（集成服玩家未就位）——先 world.rebuild 进入托管世界");
        }

        JsonObject before = snapshot(player);
        JsonArray applied = new JsonArray();

        applyGameType(ctx, player, applied);
        applyHealth(ctx, player, applied);
        applyExperience(ctx, player, applied);
        applyEffects(ctx, player, applied);

        // 一项都没写 = 调用方参数写错了：可写动作不许空转绿（契约 §7.5 共同口径第 4 条「失败显式」）
        if (applied.size() == 0) {
            throw CpException.param(
                "没有可写字段",
                "gameType|health|experienceLevel|experienceTotal|experience|effects",
                "至少给一个（本动作不提供只读路径；读面见 read.* 动作）");
        }

        // 背包/手持在改完之后统一刷一次容器同步：经验包只带经验、生命包只带血量，
        // 而容器槽位（含手持）走 Container.detectAndSendChanges 的 S2FPacketSetSlot。
        try {
            player.openContainer.detectAndSendChanges();
        } catch (Throwable t) {
            CpLog.warn("玩家容器同步失败（客户端槽位可能滞后一 tick）: %s", String.valueOf(t));
        }

        JsonObject after = snapshot(player);
        JsonObject o = new JsonObject();
        o.add("applied", applied);
        o.add("before", before);
        o.add("after", after);
        o.addProperty("playerName", player.getCommandSenderName());
        o.addProperty(
            "dimension",
            Integer.valueOf(
                player.worldObj != null && player.worldObj.provider != null ? player.worldObj.provider.dimensionId
                    : 0));
        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            "scene.player.state：写入 " + applied.size() + " 项",
            Json.object("applied", applied, "player", player.getCommandSenderName()));
        return L0Session.decorated("scene.player.state", o, world, mc);
    }

    // ------------------------------------------------------------ 各项写入

    private void applyGameType(ActionContext ctx, EntityPlayerMP player, JsonArray applied) {
        if (!ctx.has("gameType")) {
            return;
        }
        String raw = ctx.optString("gameType", null);
        WorldSettings.GameType type = parseGameType(raw);
        player.setGameType(type);
        JsonObject a = new JsonObject();
        a.addProperty("field", "gameType");
        a.addProperty("value", type.getName());
        // 实读回验：theItemInWorldManager 是服务端权威侧的当前模式
        a.addProperty(
            "readBack",
            player.theItemInWorldManager.getGameType()
                .getName());
        applied.add(a);
    }

    private void applyHealth(ActionContext ctx, EntityPlayerMP player, JsonArray applied) {
        if (!ctx.has("health")) {
            return;
        }
        float want = (float) L0Session.optNumber(ctx, "health", 0.0d);
        float max = player.getMaxHealth();
        if (want < MIN_HEALTH) {
            throw CpException.param("生命值非法", "health", "须 ≥ " + MIN_HEALTH + "（0 会触发死亡流程，无人值守场景会卡在死亡界面），收到 " + want);
        }
        float clamped = Math.min(want, max);
        player.setHealth(clamped);
        // 原版同步出口：把 lastHealth 打回哨兵值，令本 tick 的 onUpdate 立即发 S06PacketUpdateHealth
        player.setPlayerHealthUpdated();
        JsonObject a = new JsonObject();
        a.addProperty("field", "health");
        a.addProperty("value", Float.valueOf(clamped));
        a.addProperty("requested", Float.valueOf(want));
        a.addProperty("clamped", Boolean.valueOf(clamped != want));
        a.addProperty("maxHealth", Float.valueOf(max));
        a.addProperty("readBack", Float.valueOf(player.getHealth()));
        applied.add(a);
    }

    private void applyExperience(ActionContext ctx, EntityPlayerMP player, JsonArray applied) {
        // 三个经验字段里任一单独给出都必须被接受。首轮 D4 负对照暴露的缺陷：这里原本漏判
        // experience（经验条进度），于是「只给 experience」被误判成「没有任何可写字段」——
        // 自述声明了该参数却用不了（D1/D4 都会判红）。
        if (!ctx.has("experienceLevel") && !ctx.has("experienceTotal") && !ctx.has("experience")) {
            return;
        }
        JsonObject a = new JsonObject();
        a.addProperty("field", "experience");
        if (ctx.has("experienceLevel")) {
            int lvl = ctx.optInt("experienceLevel", player.experienceLevel);
            if (lvl < 0 || lvl > 21863) {
                throw CpException.param("经验等级非法", "experienceLevel", "须在 0..21863（原版上限），收到 " + lvl);
            }
            player.experienceLevel = lvl;
            a.addProperty("experienceLevel", Integer.valueOf(lvl));
        }
        if (ctx.has("experienceTotal")) {
            int total = ctx.optInt("experienceTotal", player.experienceTotal);
            if (total < 0) {
                throw CpException.param("经验总量非法", "experienceTotal", "不得为负，收到 " + total);
            }
            player.experienceTotal = total;
            a.addProperty("experienceTotal", Integer.valueOf(total));
        }
        if (ctx.has("experience")) {
            float frac = (float) L0Session.optNumber(ctx, "experience", 0.0d);
            if (frac < 0.0f || frac >= 1.0f) {
                throw CpException.param("经验条进度非法", "experience", "须在 [0,1)（原版经验条语义），收到 " + frac);
            }
            player.experience = frac;
            a.addProperty("experience", Float.valueOf(frac));
        }
        a.addProperty("readBackLevel", Integer.valueOf(player.experienceLevel));
        a.addProperty("readBackTotal", Integer.valueOf(player.experienceTotal));
        a.addProperty("readBackBar", Float.valueOf(player.experience));
        applied.add(a);
    }

    private void applyEffects(ActionContext ctx, EntityPlayerMP player, JsonArray applied) {
        JsonArray effects = ctx.optArray("effects");
        if (effects == null) {
            return;
        }
        if (effects.size() > MAX_EFFECTS) {
            throw CpException.param("药水效果过多", "effects", "最多 " + MAX_EFFECTS + " 条，收到 " + effects.size());
        }
        if (ctx.optBool("clearExisting", false)) {
            player.clearActivePotions();
        }
        for (int i = 0; i < effects.size(); i++) {
            JsonElement e = effects.get(i);
            if (e == null || !e.isJsonObject()) {
                throw CpException.param("药水效果条目非法", "effects[" + i + "]", "须为 object");
            }
            JsonObject spec = e.getAsJsonObject();
            String id = Json.optString(spec, "id", Json.optString(spec, "potion", null));
            if (id == null || id.trim()
                .isEmpty()) {
                throw CpException.param("缺少药水 id", "effects[" + i + "].id", "必填（效果名或 1..31 的数字 id）");
            }
            Potion potion = resolvePotion(id.trim(), "effects[" + i + "].id");
            int duration = Json.optInt(spec, "duration", 600);
            int amplifier = Json.optInt(spec, "amplifier", 0);
            boolean ambient = Json.optBool(spec, "ambient", false);
            if (duration < 1) {
                throw CpException.param("duration 非法", "effects[" + i + "].duration", "须 ≥ 1 tick，收到 " + duration);
            }
            if (amplifier < 0 || amplifier > 255) {
                throw CpException.param("amplifier 非法", "effects[" + i + "].amplifier", "须在 0..255，收到 " + amplifier);
            }
            PotionEffect effect = new PotionEffect(potion.getId(), duration, amplifier, ambient);
            player.addPotionEffect(effect);
            JsonObject a = new JsonObject();
            a.addProperty("field", "potion");
            // 回填的是**稳定名**（Potion.getName()，如 potion.nightVision）而不是调用方原样输入：
            // 别名/数字 id 都能被解析，但返回值必须能唯一指回那个效果
            a.addProperty("id", RegistryNames.potionNameOf(potion));
            a.addProperty("requested", id);
            a.addProperty("potionId", Integer.valueOf(potion.getId()));
            a.addProperty("duration", Integer.valueOf(duration));
            a.addProperty("amplifier", Integer.valueOf(amplifier));
            a.addProperty("ambient", Boolean.valueOf(ambient));
            PotionEffect live = player.getActivePotionEffect(potion);
            a.addProperty("readBackApplied", Boolean.valueOf(live != null));
            if (live != null) {
                a.addProperty("readBackDuration", Integer.valueOf(live.getDuration()));
                a.addProperty("readBackAmplifier", Integer.valueOf(live.getAmplifier()));
            }
            applied.add(a);
        }
    }

    // ------------------------------------------------------------ 解析

    /**
     * 解析游戏模式：{@code survival}/{@code creative}/{@code adventure}（大小写不敏感，也接受
     * {@code 0}/{@code 1}/{@code 2}）。
     */
    static WorldSettings.GameType parseGameType(String raw) {
        if (raw == null || raw.trim()
            .isEmpty()) {
            throw CpException.param("gameType 缺失", "gameType", "须为 survival | creative | adventure");
        }
        String s = raw.trim()
            .toLowerCase(java.util.Locale.ROOT);
        for (WorldSettings.GameType t : WorldSettings.GameType.values()) {
            if (t.getName()
                .equals(s)) {
                return t;
            }
        }
        try {
            int id = Integer.parseInt(s);
            for (WorldSettings.GameType t : WorldSettings.GameType.values()) {
                if (t.getID() == id) {
                    return t;
                }
            }
        } catch (NumberFormatException ignored) {
            // 落到下面的统一报错
        }
        throw CpException.param("未知游戏模式", "gameType", "合法取值 survival | creative | adventure（或 0|1|2），收到: " + raw);
    }

    /**
     * 解析药水：先按 1..31 数字 id，再按名字。
     *
     * <p>
     * <b>名字口径（首轮实机修正）</b>：原版绝大多数效果是<b>匿名内部类</b>
     * （{@code new Potion(16, ...)}），{@code getClass().getSimpleName()} 是空串——按类名解析
     * 必然失败（首轮 {@code night_vision} 即因此被判未知）。稳定可用的名字是
     * {@code Potion.getName()}（{@code setPotionName("potion.nightVision")} 存下的串）。
     * 解析与容错细节见 {@link RegistryNames#resolvePotion}。
     */
    static Potion resolvePotion(String raw, String field) {
        return RegistryNames.resolvePotion(raw, field);
    }

    // ------------------------------------------------------------ 快照

    /** 玩家状态实读（写前/写后各读一次，供逐项对照）。 */
    private static JsonObject snapshot(EntityPlayerMP player) {
        JsonObject o = new JsonObject();
        o.addProperty(
            "gameType",
            player.theItemInWorldManager.getGameType()
                .getName());
        o.addProperty("health", Float.valueOf(player.getHealth()));
        o.addProperty("maxHealth", Float.valueOf(player.getMaxHealth()));
        o.addProperty("absorption", Float.valueOf(player.getAbsorptionAmount()));
        o.addProperty("experienceLevel", Integer.valueOf(player.experienceLevel));
        o.addProperty("experienceTotal", Integer.valueOf(player.experienceTotal));
        o.addProperty("experience", Float.valueOf(player.experience));
        JsonArray effects = new JsonArray();
        for (Object obj : player.getActivePotionEffects()) {
            PotionEffect e = (PotionEffect) obj;
            JsonObject eo = new JsonObject();
            eo.addProperty("potionId", Integer.valueOf(e.getPotionID()));
            Potion p = e.getPotionID() >= 0 && e.getPotionID() < Potion.potionTypes.length
                ? Potion.potionTypes[e.getPotionID()]
                : null;
            if (p != null) {
                eo.addProperty("id", RegistryNames.potionNameOf(p));
            }
            eo.addProperty("duration", Integer.valueOf(e.getDuration()));
            eo.addProperty("amplifier", Integer.valueOf(e.getAmplifier()));
            effects.add(eo);
        }
        o.add("effects", effects);
        JsonArray pos = new JsonArray();
        Json.add(pos, Double.valueOf(Math.round(player.posX * 1000.0d) / 1000.0d));
        Json.add(pos, Double.valueOf(Math.round(player.posY * 1000.0d) / 1000.0d));
        Json.add(pos, Double.valueOf(Math.round(player.posZ * 1000.0d) / 1000.0d));
        o.add("pos", pos);
        o.addProperty("yaw", Float.valueOf(player.rotationYaw));
        o.addProperty("pitch", Float.valueOf(player.rotationPitch));
        return o;
    }
}
