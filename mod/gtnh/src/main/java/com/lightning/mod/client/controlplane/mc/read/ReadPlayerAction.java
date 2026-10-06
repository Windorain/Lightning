package com.lightning.mod.client.controlplane.mc.read;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.item.ItemStack;
import net.minecraft.potion.Potion;
import net.minecraft.potion.PotionEffect;
import net.minecraft.util.FoodStats;
import net.minecraft.world.WorldSettings;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.TimeSource;

/**
 * {@code read.player}（observe，同步）：玩家状态。
 *
 * <p>
 * 位置、朝向、生命、游戏模式、效果、手持物品。<b>数据源是服务端玩家实体</b>
 * （{@code MinecraftServer} 的 {@code playerEntityList}）——与 {@code WorldRuntime} 的既有口径一致：
 * 1.7.10 集成服里客户端那个 {@code EntityClientPlayerMP} 只是本地视图，
 * 它的 {@code capabilities}/{@code experienceLevel} 会被服务端下发覆盖，读它得到的不是权威值。
 *
 * <p>
 * 位置同时给出服务端与客户端两份（{@code serverPos}/{@code clientPos}）：注入式相机
 * （{@code shot.multi}）与「门控位置分离」判据（contract §4.3.2）需要分别断言两者，
 * 而本动作只读不判——判据在 criteria 段里写。
 */
public final class ReadPlayerAction implements ControlAction {

    /** 动作名。 */
    public static final String NAME = "read.player";

    @Override
    public JsonObject execute(ActionContext ctx) {
        // 世界先判（未进世界时 player 也必为空；先报世界缺失更贴近调用方的实际缺失）
        ReadSupport.requireServerWorld(NAME);
        EntityPlayerMP player = com.lightning.mod.client.controlplane.mc.WorldRuntime.serverPlayer();
        if (player == null) {
            throw new CpException(
                ErrorCodes.STATE,
                "服务端玩家实体不可用（未进入世界或玩家尚未加入集成服）",
                Json.object(
                    "action",
                    NAME,
                    "hint",
                    "先进世界；无人值守下 world.rebuild/case.run 的 world 段会把玩家传送并开通飞行（WorldRuntime.stabilizePlayer）"));
        }

        JsonObject o = new JsonObject();
        o.addProperty("schema", "lightning.cp-read-player/1");
        o.addProperty("action", NAME);
        o.addProperty("name", player.getCommandSenderName());
        o.addProperty("uuid", safeUuid(player));
        o.addProperty("entityId", Integer.valueOf(player.getEntityId()));
        o.addProperty("dimension", Integer.valueOf(player.dimension));
        o.addProperty("source", "服务端 EntityPlayerMP（权威侧）");

        JsonObject pos = new JsonObject();
        pos.add("server", vec3(player.posX, player.posY, player.posZ));
        pos.add("eye", vec3(player.posX, player.posY + player.getEyeHeight(), player.posZ));
        net.minecraft.client.Minecraft mc = com.lightning.mod.client.controlplane.mc.WorldRuntime.mc();
        if (mc != null && mc.thePlayer != null) {
            pos.add("client", vec3(mc.thePlayer.posX, mc.thePlayer.posY, mc.thePlayer.posZ));
            pos.addProperty("clientName", mc.thePlayer.getCommandSenderName());
        }
        o.add("pos", pos);

        JsonObject rotation = new JsonObject();
        rotation.addProperty("yaw", Float.valueOf(player.rotationYaw));
        rotation.addProperty("pitch", Float.valueOf(player.rotationPitch));
        rotation.addProperty("headYaw", Float.valueOf(player.rotationYawHead));
        rotation.addProperty("facing", ReadSupport.facingOf(player.rotationYaw));
        rotation.addProperty(
            "lookScope",
            "视线方向按 1.7.10 的 getLook 口径：d = (-sin(yaw)cos(pitch), -sin(pitch), cos(yaw)cos(pitch))；" + "正 pitch 是俯视");
        JsonArray look = new JsonArray();
        Json.add(
            look,
            Double.valueOf(
                round(-Math.sin(Math.toRadians(player.rotationYaw)) * Math.cos(Math.toRadians(player.rotationPitch)))));
        Json.add(look, Double.valueOf(round(-Math.sin(Math.toRadians(player.rotationPitch)))));
        Json.add(
            look,
            Double.valueOf(
                round(Math.cos(Math.toRadians(player.rotationYaw)) * Math.cos(Math.toRadians(player.rotationPitch)))));
        rotation.add("look", look);
        o.add("rotation", rotation);

        JsonObject health = new JsonObject();
        health.addProperty("health", Float.valueOf(player.getHealth()));
        health.addProperty("maxHealth", Float.valueOf(player.getMaxHealth()));
        health.addProperty("absorption", Float.valueOf(player.getAbsorptionAmount()));
        health.addProperty("armor", Integer.valueOf(player.getTotalArmorValue()));
        health.addProperty("dead", Boolean.valueOf(player.isDead));
        health.addProperty("alive", Boolean.valueOf(player.isEntityAlive()));
        health.addProperty("onGround", Boolean.valueOf(player.onGround));
        health.addProperty("fallDistance", Float.valueOf(player.fallDistance));
        // Entity.fire 是 private；用公开的 isBurning()（同一状态的可读口径）
        health.addProperty("burning", Boolean.valueOf(player.isBurning()));
        health.addProperty("wet", Boolean.valueOf(player.isWet()));
        health.addProperty("inWater", Boolean.valueOf(player.isInWater()));
        health.addProperty("air", Integer.valueOf(player.getAir()));
        health.addProperty("maxAir", Integer.valueOf(300));
        o.add("health", health);

        JsonObject food = new JsonObject();
        FoodStats fs = player.getFoodStats();
        if (fs != null) {
            food.addProperty("foodLevel", Integer.valueOf(fs.getFoodLevel()));
            food.addProperty("saturationLevel", Float.valueOf(fs.getSaturationLevel()));
            food.addProperty("needsFood", Boolean.valueOf(fs.needFood()));
        } else {
            food.addProperty("available", false);
        }
        o.add("food", food);

        JsonObject game = new JsonObject();
        WorldSettings.GameType gameType = player.theItemInWorldManager == null ? null
            : player.theItemInWorldManager.getGameType();
        game.addProperty("gameType", gameType == null ? null : gameType.getName());
        game.addProperty("gameTypeId", gameType == null ? null : Integer.valueOf(gameType.getID()));
        game.addProperty("isCreative", gameType != null && gameType.isCreative());
        game.addProperty("isAdventure", gameType != null && gameType.isAdventure());
        game.addProperty("allowFlying", Boolean.valueOf(player.capabilities.allowFlying));
        game.addProperty("isFlying", Boolean.valueOf(player.capabilities.isFlying));
        game.addProperty("isCreativeMode", Boolean.valueOf(player.capabilities.isCreativeMode));
        game.addProperty("disableDamage", Boolean.valueOf(player.capabilities.disableDamage));
        game.addProperty("walkSpeed", Float.valueOf(player.capabilities.getWalkSpeed()));
        o.add("gameMode", game);

        JsonObject experience = new JsonObject();
        experience.addProperty("level", Integer.valueOf(player.experienceLevel));
        experience.addProperty("total", Integer.valueOf(player.experienceTotal));
        experience.addProperty("progress", Float.valueOf(player.experience));
        o.add("experience", experience);

        o.add("effects", effects(player.getActivePotionEffects()));

        JsonObject held = new JsonObject();
        held.addProperty("slot", Integer.valueOf(player.inventory.currentItem));
        held.add("main", ReadSupport.readSlot(null, player.inventory.currentItem, player.getHeldItem()));
        JsonObject cursor = new JsonObject();
        try {
            cursor.add("item", ReadSupport.readSlot(null, -1, player.inventory.getItemStack()));
        } catch (Throwable t) {
            cursor.addProperty("available", false);
        }
        held.add("cursor", cursor);
        o.add("held", held);

        o.addProperty("ping", Integer.valueOf(player.ping));
        o.addProperty(
            "readAt",
            TimeSource.system()
                .isoNow());
        return o;
    }

    // ------------------------------------------------------------ 工具

    /** 药水效果数组（逐个展开 id/名称/时长/等级；顺序按 id 升序，保证可复算）。 */
    static JsonArray effects(Collection<?> raw) {
        JsonArray out = new JsonArray();
        if (raw == null) {
            return out;
        }
        List<PotionEffect> list = new ArrayList<PotionEffect>();
        for (Object o : raw) {
            if (o instanceof PotionEffect) {
                list.add((PotionEffect) o);
            }
        }
        list.sort((a, b) -> Integer.compare(a.getPotionID(), b.getPotionID()));
        for (PotionEffect e : list) {
            JsonObject o = new JsonObject();
            o.addProperty("id", Integer.valueOf(e.getPotionID()));
            o.addProperty("name", potionName(e.getPotionID()));
            o.addProperty("amplifier", Integer.valueOf(e.getAmplifier()));
            o.addProperty("duration", Integer.valueOf(e.getDuration()));
            o.addProperty("ambient", Boolean.valueOf(e.getIsAmbient()));
            out.add(o);
        }
        return out;
    }

    /** 药水 id → 1.7.10 的语言键名（如 {@code potion.moveSpeed}）；越界返回 null。 */
    static String potionName(int id) {
        try {
            if (id < 0 || id >= Potion.potionTypes.length) {
                return null;
            }
            Potion p = Potion.potionTypes[id];
            return p == null ? null : p.getName();
        } catch (Throwable t) {
            return null;
        }
    }

    private static JsonArray vec3(double x, double y, double z) {
        JsonArray a = new JsonArray();
        Json.add(a, Double.valueOf(round(x)));
        Json.add(a, Double.valueOf(round(y)));
        Json.add(a, Double.valueOf(round(z)));
        return a;
    }

    private static double round(double v) {
        return Math.round(v * 1000.0d) / 1000.0d;
    }

    private static String safeUuid(EntityPlayerMP player) {
        try {
            return player.getUniqueID() == null ? null
                : player.getUniqueID()
                    .toString();
        } catch (Throwable t) {
            return null;
        }
    }

    /** 手持物品栈（供 {@code inv.read} 与判据复用）。 */
    static JsonObject heldStack(EntityPlayerMP player) {
        ItemStack stack = player.getHeldItem();
        return ReadSupport.readSlot(null, player.inventory.currentItem, stack);
    }
}
