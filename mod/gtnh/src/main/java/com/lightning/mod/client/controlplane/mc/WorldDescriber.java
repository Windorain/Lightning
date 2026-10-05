package com.lightning.mod.client.controlplane.mc;

import java.nio.file.Files;
import java.nio.file.Path;

import net.minecraft.client.Minecraft;
import net.minecraft.world.World;
import net.minecraft.world.storage.WorldInfo;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.Contract;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * 当前世界描述（contract.md §4 的 {@code world.info}，同时供 {@code core.status}、世界动作返回值
 * 与观测记录复用）。
 *
 * <p>
 * 「是否托管」严格按契约 §6.1 判定：存档目录名以 {@code cp_} 开头<b>且</b>目录内含
 * {@code cp_world.json}。「是否虚空」优先取托管标记的 {@code void} 字段，其次按
 * {@link VoidWorldPreset#isVoid(String)} 解析世界自己的 {@code generatorOptions}——
 * 后者让非托管的手工世界也能被正确描述（但描述为虚空 ≠ 可写，写操作仍然只认托管标记）。
 */
public final class WorldDescriber {

    private WorldDescriber() {}

    /** 描述当前世界；未加载时返回 {@code {loaded:false}} 加客户端状态摘要。 */
    public static JsonObject describe(Minecraft mc) {
        JsonObject o = new JsonObject();
        if (mc == null || mc.theWorld == null) {
            o.addProperty("loaded", false);
            return o;
        }
        World world = mc.theWorld;
        WorldInfo info = world.getWorldInfo();
        String folder = folderOf(world);
        Path dir = folder == null ? null : ManagedWorld.worldDir(mc.mcDataDir, folder);
        boolean managed = ManagedWorld.isManaged(dir);
        JsonObject marker = managed ? ManagedWorld.readMarker(dir) : null;

        o.addProperty("loaded", true);
        o.addProperty("folder", folder);
        o.addProperty("displayName", info == null ? null : info.getWorldName());
        o.addProperty("dimension", world.provider == null ? 0 : world.provider.dimensionId);
        o.addProperty("managed", managed);
        o.addProperty("managedPrefix", Contract.MANAGED_WORLD_PREFIX);
        o.addProperty("markerPresent", ManagedWorld.hasMarker(dir));
        o.addProperty(
            "markerPath",
            dir == null ? null
                : dir.resolve(ManagedWorld.MARKER)
                    .toString());
        o.addProperty("generatorOptions", info == null ? null : info.getGeneratorOptions());
        o.addProperty(
            "terrainType",
            info == null || info.getTerrainType() == null ? null
                : info.getTerrainType()
                    .getWorldTypeName());
        o.addProperty("mapFeatures", info != null && info.isMapFeaturesEnabled());
        o.addProperty("seed", info == null ? 0L : info.getSeed());
        o.addProperty("hardcore", info != null && info.isHardcoreModeEnabled());
        o.addProperty(
            "gameType",
            info == null || info.getGameType() == null ? null
                : info.getGameType()
                    .getName());
        o.addProperty("worldTime", world.getWorldTime());
        o.addProperty("totalTime", world.getTotalWorldTime());
        o.addProperty("raining", world.isRaining());
        o.addProperty("thundering", world.isThundering());
        JsonArray spawn = new JsonArray();
        if (info != null) {
            spawn.add(info.getSpawnX());
            spawn.add(info.getSpawnY());
            spawn.add(info.getSpawnZ());
        }
        o.add("spawn", spawn);
        o.addProperty("void", isVoid(info, marker));
        o.addProperty("markerVoid", marker != null && Json.optBool(marker, "void", false));
        if (mc.thePlayer != null) {
            o.add("playerPos", posArray(mc.thePlayer.posX, mc.thePlayer.posY, mc.thePlayer.posZ));
            o.addProperty("playerName", mc.thePlayer.getCommandSenderName());
        }
        o.addProperty("serverWorldAvailable", WorldRuntime.serverWorld() != null);
        return o;
    }

    /** 当前世界的存档目录名；取不到时返回 null。 */
    public static String folderOf(World world) {
        if (world == null) {
            return null;
        }
        try {
            if (world.getSaveHandler() != null && world.getSaveHandler()
                .getWorldDirectoryName() != null) {
                return world.getSaveHandler()
                    .getWorldDirectoryName();
            }
        } catch (Throwable t) {
            CpLog.warn("读取存档目录名失败: %s", String.valueOf(t));
        }
        try {
            WorldInfo info = world.getWorldInfo();
            return info == null ? null : info.getWorldName();
        } catch (Throwable t) {
            return null;
        }
    }

    /** 目录是否托管（按存档目录名解析）。 */
    public static boolean isManagedFolder(Minecraft mc, String folder) {
        if (mc == null || folder == null || !ManagedWorld.isManagedFolderName(folder)) {
            return false;
        }
        return ManagedWorld.isManaged(ManagedWorld.worldDir(mc.mcDataDir, folder));
    }

    /** 目录是否有 level.dat（即是不是一个真实存在的存档）。 */
    public static boolean hasLevelDat(Minecraft mc, String folder) {
        if (mc == null || folder == null) {
            return false;
        }
        return Files.isRegularFile(
            ManagedWorld.worldDir(mc.mcDataDir, folder)
                .resolve("level.dat"));
    }

    private static boolean isVoid(WorldInfo info, JsonObject marker) {
        if (marker != null && Json.optBool(marker, "void", false)) {
            return true;
        }
        return info != null && VoidWorldPreset.isVoid(info.getGeneratorOptions());
    }

    private static JsonArray posArray(double x, double y, double z) {
        JsonArray a = new JsonArray();
        a.add(round(x));
        a.add(round(y));
        a.add(round(z));
        return a;
    }

    private static double round(double v) {
        return Math.round(v * 1000.0d) / 1000.0d;
    }
}
