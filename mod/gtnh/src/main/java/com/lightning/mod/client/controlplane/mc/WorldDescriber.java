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
 *
 * <h2>元数据取服务端世界，客户端字段取客户端世界（实测修正）</h2>
 * 1.7.10 集成服里 {@code mc.theWorld} 是 {@code WorldClient}：它的 saveHandler 是
 * {@code SaveHandlerMP}（目录名 {@code "none"}）、{@code WorldInfo} 是占位的
 * {@code "MpServer"}／空 {@code generatorOptions}／{@code seed 0}。真机冒烟实测该视图把刚重建的
 * <b>托管</b>虚空世界描述成 {@code folder:"none" / managed:false / markerPresent:false /
 * generatorOptions:"" / seed:0}（世界明明有 {@code cp_world.json}，build 段也确实放了方块）。
 * 因此{@code folder/marker/displayName/generatorOptions/terrainType/seed/gameType/spawn…} 一律读
 * <b>服务端权威世界</b>（{@link WorldRuntime#serverWorld()}，即
 * {@code MinecraftServer.getServer().worldServers[0]}，其 saveHandler 的 world directory name 与
 * {@code WorldInfo} 才是真实存档）；玩家位置/名称、世界时间等客户端侧字段仍读 {@code mc.theWorld}。
 *
 * <p>
 * 线程边界：调用点都在客户端 tick 线程的动作执行里（与 {@code WorldRuntime} 的既有口径一致），
 * 读服务端世界对象在此是既有事实口径；取不到服务端世界（未开集成服／纯远程联机）时回落到客户端
 * 世界，并在结果里以 {@code metaSource} 标明来源。
 */
public final class WorldDescriber {

    /** {@code metaSource} 取值：元数据来自服务端权威世界。 */
    public static final String META_SERVER = "server";

    /** {@code metaSource} 取值：无服务端世界，元数据只能来自客户端世界。 */
    public static final String META_CLIENT = "client";

    private WorldDescriber() {}

    /** 描述当前世界；未加载时返回 {@code {loaded:false}} 加客户端状态摘要。 */
    public static JsonObject describe(Minecraft mc) {
        JsonObject o = new JsonObject();
        if (mc == null || mc.theWorld == null) {
            o.addProperty("loaded", false);
            return o;
        }
        World client = mc.theWorld;
        // 元数据来源：服务端权威世界优先（见类注释）；客户端侧字段一律仍读 client
        World server = WorldRuntime.serverWorld();
        World meta = server == null ? client : server;
        WorldInfo info = meta.getWorldInfo();
        String folder = folderOf(meta);
        Path dir = folder == null ? null : ManagedWorld.worldDir(mc.mcDataDir, folder);
        boolean managed = ManagedWorld.isManaged(dir);
        JsonObject marker = managed ? ManagedWorld.readMarker(dir) : null;

        o.addProperty("loaded", true);
        o.addProperty("folder", folder);
        o.addProperty("displayName", info == null ? null : info.getWorldName());
        o.addProperty("dimension", client.provider == null ? 0 : client.provider.dimensionId);
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
        o.addProperty("worldTime", client.getWorldTime());
        o.addProperty("totalTime", client.getTotalWorldTime());
        o.addProperty("raining", client.isRaining());
        o.addProperty("thundering", client.isThundering());
        JsonArray spawn = new JsonArray();
        if (info != null) {
            Json.add(spawn, Integer.valueOf(info.getSpawnX()));
            Json.add(spawn, Integer.valueOf(info.getSpawnY()));
            Json.add(spawn, Integer.valueOf(info.getSpawnZ()));
        }
        o.add("spawn", spawn);
        o.addProperty("void", isVoid(info, marker));
        o.addProperty("markerVoid", marker != null && Json.optBool(marker, "void", false));
        // #123：managed/markerPresent 回答「是不是托管目录」，markerComplete 回答「构建完成了没有」。
        // 三者分开是因为语义不同（contract.md §6.1）：失败残留是 managed=true / markerPresent=true /
        // markerComplete=false——它可以删可以重建，但不可当成品复用。旧标记（无 complete 键）
        // 按 true 读（ManagedWorld.markerComplete 的向后兼容口径）。
        o.addProperty("markerComplete", ManagedWorld.markerComplete(marker));
        o.addProperty("metaSource", server == null ? META_CLIENT : META_SERVER);
        if (mc.thePlayer != null) {
            o.add("playerPos", posArray(mc.thePlayer.posX, mc.thePlayer.posY, mc.thePlayer.posZ));
            o.addProperty("playerName", mc.thePlayer.getCommandSenderName());
        }
        o.addProperty("serverWorldAvailable", server != null);
        return o;
    }

    /**
     * 当前所在世界的存档目录名（<b>服务端权威优先</b>；未加载世界时返回 null）。
     *
     * <p>
     * 需要「当前在哪个托管世界」时用本方法，不要用 {@link #folderOf(World)} 直接喂
     * {@code mc.theWorld}：客户端 {@code WorldClient} 的 saveHandler 是占位实现，
     * 目录名只会得到 {@code "none"}（见类注释）。
     */
    public static String currentFolder(Minecraft mc) {
        if (mc == null) {
            return null;
        }
        World server = WorldRuntime.serverWorld();
        if (server != null) {
            String f = folderOf(server);
            if (f != null && !f.isEmpty()) {
                return f;
            }
        }
        return folderOf(mc.theWorld);
    }

    /**
     * 单个世界对象的存档目录名；取不到时返回 null。
     *
     * <p>
     * 对服务端世界返回真实目录名；对客户端 {@code WorldClient} 会返回占位名（{@code "none"} 或
     * {@code "MpServer"}）——调用方要「当前世界」请用 {@link #currentFolder(Minecraft)}。
     */
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
        Json.add(a, Double.valueOf(round(x)));
        Json.add(a, Double.valueOf(round(y)));
        Json.add(a, Double.valueOf(round(z)));
        return a;
    }

    private static double round(double v) {
        return Math.round(v * 1000.0d) / 1000.0d;
    }
}
