package com.lightning.mod.client.controlplane.mc.read;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.entity.Entity;
import net.minecraft.server.MinecraftServer;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.WorldServer;
import net.minecraft.world.chunk.Chunk;
import net.minecraft.world.chunk.IChunkProvider;
import net.minecraft.world.storage.WorldInfo;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.TimeSource;

/**
 * {@code read.overview}（observe，同步）：世界概览。
 *
 * <p>
 * 维度、时间、天气、已加载区块、实体计数。<b>数据源是服务端权威世界</b>——
 * 客户端 {@code WorldClient} 的实体列表只含「下发给客户端的那部分」，拿它数实体会少报
 * （需求书 §5 的判据：「凡是 Agent 必须读源码或靠猜才能得知的状态，都算缺口」，少报比不报更糟）。
 *
 * <p>
 * {@code world.info}（既有动作）回答的是「我在哪个世界、是不是托管世界」；
 * 本动作回答「这个世界现在长什么样」。两者字段有交集（维度、时刻），但服务的问题不同：
 * {@code world.info} 用于决定要不要重建，本动作用于判据引用与现场描述。因此不合并。
 */
public final class ReadOverviewAction implements ControlAction {

    /** 动作名。 */
    public static final String NAME = "read.overview";

    /** {@code chunkRange} 的区块数上限（逐块探测是读盘操作）。 */
    public static final int MAX_CHUNK_RANGE = 4096;

    @Override
    public JsonObject execute(ActionContext ctx) {
        WorldServer world = ReadSupport.requireServerWorld(NAME);
        boolean entities = ctx.optBool("entities", true);
        int topEntityTypes = ctx.optInt("topEntityTypes", 10);

        JsonObject o = new JsonObject();
        o.addProperty("schema", "lightning.cp-read-overview/1");
        o.addProperty("action", NAME);

        // 世界身份字段与 world.info 同源（WorldDescriber）：folder/managed/void 等只有一个定义点
        o.add(
            "world",
            com.lightning.mod.client.controlplane.mc.WorldDescriber
                .describe(com.lightning.mod.client.controlplane.mc.WorldRuntime.mc()));

        JsonObject time = new JsonObject();
        time.addProperty("worldTime", world.getWorldTime());
        time.addProperty("totalWorldTime", world.getTotalWorldTime());
        // 一天 24000 tick：换算成人读的「第几天 + 当天时刻」便于判据引用
        time.addProperty("day", Long.valueOf(world.getWorldTime() / 24000L));
        time.addProperty("timeOfDay", Long.valueOf(world.getWorldTime() % 24000L));
        o.add("time", time);

        JsonObject weather = new JsonObject();
        weather.addProperty("raining", world.isRaining());
        weather.addProperty("thundering", world.isThundering());
        weather.addProperty("rainStrength", Float.valueOf(world.getRainStrength(1.0F)));
        weather.addProperty("thunderStrength", Float.valueOf(getWeightedThunderStrength(world, 1.0F)));
        JsonObject wi = weatherInfo(world);
        if (wi != null) {
            weather.addProperty("rainTime", Integer.valueOf(Json.optInt(wi, "rainTime", -1)));
            weather.addProperty("thunderTime", Integer.valueOf(Json.optInt(wi, "thunderTime", -1)));
            weather.addProperty("rainingScheduled", Json.optBool(wi, "raining", false));
            weather.addProperty("thunderingScheduled", Json.optBool(wi, "thundering", false));
        }
        o.add("weather", weather);

        JsonObject chunks = new JsonObject();
        chunks.addProperty("loaded", loadedChunkCount(world));
        chunks.addProperty("source", "服务端 WorldServer 的 chunkProvider.getLoadedChunkCount()");
        int[] chunkRange = chunkRangeOf(ctx);
        JsonArray list = loadedChunkList(world, chunkRange);
        chunks.addProperty("listed", list.size());
        if (chunkRange != null) {
            JsonArray r = new JsonArray();
            for (int v : chunkRange) {
                Json.add(r, Integer.valueOf(v));
            }
            chunks.add("chunkRange", r);
            chunks.addProperty("chunkRangeNote", "provideChunk 对未加载区块会触发加载（读盘），故本字段只在显式给出 chunkRange 时才逐块列举");
        }
        chunks.add("chunks", list);
        o.add("chunks", chunks);

        if (entities) {
            o.add("entities", entitySummary(world, topEntityTypes));
            o.add("tileEntities", tileEntitySummary(world, topEntityTypes));
        }

        JsonObject players = new JsonObject();
        MinecraftServer server = com.lightning.mod.client.controlplane.mc.WorldRuntime.server();
        List<?> playerList = server == null || server.getConfigurationManager() == null ? null
            : server.getConfigurationManager().playerEntityList;
        players.addProperty("count", playerList == null ? 0 : playerList.size());
        JsonArray names = new JsonArray();
        if (playerList != null) {
            for (Object p : playerList) {
                if (p instanceof net.minecraft.entity.player.EntityPlayerMP) {
                    Json.add(names, ((net.minecraft.entity.player.EntityPlayerMP) p).getCommandSenderName());
                }
            }
        }
        players.add("names", names);
        o.add("players", players);

        JsonObject chunkProvider = new JsonObject();
        IChunkProvider provider = world.getChunkProvider();
        chunkProvider.addProperty(
            "class",
            provider == null ? null
                : provider.getClass()
                    .getName());
        chunkProvider.addProperty("serverWorldAvailable", true);
        o.add("chunkProvider", chunkProvider);

        o.addProperty(
            "readAt",
            TimeSource.system()
                .isoNow());
        return o;
    }

    // ------------------------------------------------------------ 各项

    /**
     * 解析 {@code chunkRange:[minX,maxX,minZ,maxZ]}（区块坐标，闭区间）；未给返回 null。
     *
     * <p>
     * 上限 {@link #MAX_CHUNK_RANGE} 个区块：逐块探测是读盘操作，放开会让一次读面变成一次世界扫描。
     */
    static int[] chunkRangeOf(ActionContext ctx) {
        com.google.gson.JsonArray a = ctx.optArray("chunkRange");
        if (a == null) {
            return null;
        }
        if (a.size() != 4) {
            throw com.lightning.mod.client.controlplane.core.CpException
                .param("chunkRange 形态非法", "chunkRange", "须为 [minX,maxX,minZ,maxZ] 四个整数（区块坐标）");
        }
        int[] out = new int[4];
        for (int i = 0; i < 4; i++) {
            com.google.gson.JsonElement e = a.get(i);
            if (e == null || !e.isJsonPrimitive()
                || !e.getAsJsonPrimitive()
                    .isNumber()) {
                throw com.lightning.mod.client.controlplane.core.CpException
                    .param("chunkRange 分量非法", "chunkRange[" + i + "]", "须为整数");
            }
            out[i] = e.getAsInt();
        }
        if (out[0] > out[1] || out[2] > out[3]) {
            throw com.lightning.mod.client.controlplane.core.CpException
                .param("chunkRange 非法", "chunkRange", "minX ≤ maxX 且 minZ ≤ maxZ");
        }
        long count = ((long) out[1] - out[0] + 1L) * ((long) out[3] - out[2] + 1L);
        if (count > MAX_CHUNK_RANGE) {
            throw com.lightning.mod.client.controlplane.core.CpException
                .param("chunkRange 过大", "chunkRange", count + " 个区块 > 上限 " + MAX_CHUNK_RANGE + "（逐块探测会读盘）");
        }
        return out;
    }

    private static int loadedChunkCount(WorldServer world) {
        IChunkProvider provider = world.getChunkProvider();
        if (provider == null) {
            return -1;
        }
        try {
            return provider.getLoadedChunkCount();
        } catch (Throwable t) {
            return -1;
        }
    }

    /**
     * 雷暴强度（{@code getWeightedThunderStrength}）。
     *
     * <p>
     * 1.7.10 只有 {@code getWeightedThunderStrength(float)}（{@code World.java:1700} 附近），
     * 没有 {@code getThunderStrength}；前者按 tick 加权的雷暴强度正是渲染器用的那一份。
     */
    private static float getWeightedThunderStrength(WorldServer world, float partialTicks) {
        try {
            return world.getWeightedThunderStrength(partialTicks);
        } catch (Throwable t) {
            return 0.0F;
        }
    }

    /**
     * 已加载区块清单（默认关）。
     *
     * <p>
     * 默认关的理由：大型场景下会有几千个区块，逐条列出会淹没响应。默认只给计数，
     * 需要逐块（例如核对「世界重建后哪些区块还在」）时显式开。
     *
     * <p>
     * 逐块列举走 {@code world.getChunkProvider().provideChunk(x,z)} 的<b>存在性探测</b>：
     * 1.7.10 的 {@code WorldServer} 没有公开的「已加载区块 map」，而
     * {@code provideChunk} 对已加载区块返回既有实例、对未加载区块会尝试加载（有副作用地读盘）。
     * 因此本字段只在显式给出 {@code chunkRange} 时按矩形范围逐个探测，且
     * <b>探测本身可能触发区块加载</b>——这一点写进自描述，不作为默认行为。
     */
    private static JsonArray loadedChunkList(WorldServer world, int[] range) {
        JsonArray out = new JsonArray();
        if (range == null) {
            return out;
        }
        for (int x = range[0]; x <= range[1]; x++) {
            for (int z = range[2]; z <= range[3]; z++) {
                Chunk c = null;
                try {
                    c = world.getChunkProvider()
                        .provideChunk(x, z);
                } catch (Throwable t) {
                    // 单个区块探测失败不升级成整次读面失败
                }
                if (c == null) {
                    continue;
                }
                JsonObject o = new JsonObject();
                o.addProperty("x", c.xPosition);
                o.addProperty("z", c.zPosition);
                o.addProperty("terrainPopulated", c.isTerrainPopulated);
                o.addProperty("lightPopulated", c.isLightPopulated);
                o.addProperty("modified", c.isModified);
                out.add(o);
            }
        }
        return out;
    }

    /** 服务端 WorldInfo 的天气调度字段（取不到返回 null）。 */
    private static JsonObject weatherInfo(WorldServer world) {
        WorldInfo info = world.getWorldInfo();
        if (info == null) {
            return null;
        }
        JsonObject o = new JsonObject();
        try {
            o.addProperty("rainTime", info.getRainTime());
        } catch (Throwable t) {
            // 字段缺失不写假值
        }
        try {
            o.addProperty("thunderTime", info.getThunderTime());
        } catch (Throwable t) {
            // 同上
        }
        try {
            o.addProperty("raining", info.isRaining());
        } catch (Throwable t) {
            // 同上
        }
        try {
            o.addProperty("thundering", info.isThundering());
        } catch (Throwable t) {
            // 同上
        }
        return o;
    }

    /**
     * 实体计数与按类型分组（取前 {@code topN} 类）。
     *
     * <p>
     * 类型名取实体类的<b>注册名不可得</b>（1.7.10 的 {@code EntityList} 是反向映射），
     * 因此用「实体类全名」作身份——它是稳定且不依赖模组的观测口径（判据可断言它）。
     */
    private static JsonObject entitySummary(WorldServer world, int topN) {
        List<Entity> list = safeEntityList(world);
        Map<String, Integer> byType = new HashMap<String, Integer>();
        for (Entity e : list) {
            if (e == null) {
                continue;
            }
            String key = e.getClass()
                .getName();
            Integer prev = byType.get(key);
            byType.put(key, Integer.valueOf(prev == null ? 1 : prev.intValue() + 1));
        }
        JsonObject o = new JsonObject();
        o.addProperty("count", list.size());
        o.addProperty("typeCount", byType.size());
        o.add("byType", topEntries(byType, topN));
        o.addProperty("truncatedTypes", Math.max(0, byType.size() - Math.max(0, topN)));
        o.addProperty("source", "服务端 WorldServer.loadedEntityList");
        return o;
    }

    /** 方块实体计数与按类型分组。 */
    private static JsonObject tileEntitySummary(WorldServer world, int topN) {
        List<TileEntity> list = safeTileEntityList(world);
        Map<String, Integer> byType = new HashMap<String, Integer>();
        for (TileEntity te : list) {
            if (te == null) {
                continue;
            }
            String key = te.getClass()
                .getName();
            Integer prev = byType.get(key);
            byType.put(key, Integer.valueOf(prev == null ? 1 : prev.intValue() + 1));
        }
        JsonObject o = new JsonObject();
        o.addProperty("count", list.size());
        o.addProperty("typeCount", byType.size());
        o.add("byType", topEntries(byType, topN));
        o.addProperty("truncatedTypes", Math.max(0, byType.size() - Math.max(0, topN)));
        o.addProperty("source", "服务端 WorldServer.loadedTileEntityList");
        return o;
    }

    private static List<Entity> safeEntityList(WorldServer world) {
        try {
            List<Entity> l = world.loadedEntityList;
            return l == null ? java.util.Collections.<Entity>emptyList() : l;
        } catch (Throwable t) {
            return java.util.Collections.<Entity>emptyList();
        }
    }

    private static List<TileEntity> safeTileEntityList(WorldServer world) {
        try {
            List<TileEntity> l = world.loadedTileEntityList;
            return l == null ? java.util.Collections.<TileEntity>emptyList() : l;
        } catch (Throwable t) {
            return java.util.Collections.<TileEntity>emptyList();
        }
    }

    /** 取计数前 {@code topN} 名（降序；同数按键名升序，保证确定序）。 */
    private static JsonArray topEntries(Map<String, Integer> counts, int topN) {
        JsonArray out = new JsonArray();
        if (topN <= 0) {
            return out;
        }
        List<Map.Entry<String, Integer>> entries = new java.util.ArrayList<Map.Entry<String, Integer>>(
            counts.entrySet());
        entries.sort((a, b) -> {
            int c = b.getValue()
                .compareTo(a.getValue());
            return c != 0 ? c
                : a.getKey()
                    .compareTo(b.getKey());
        });
        for (int i = 0; i < entries.size() && i < topN; i++) {
            Map.Entry<String, Integer> e = entries.get(i);
            JsonObject o = new JsonObject();
            o.addProperty("type", e.getKey());
            o.addProperty("count", e.getValue());
            out.add(o);
        }
        return out;
    }
}
