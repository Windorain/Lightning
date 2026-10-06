package com.lightning.mod.client.controlplane.mc.scene;

import net.minecraft.client.Minecraft;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.WorldServer;
import net.minecraft.world.storage.WorldInfo;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.CpLog;
import com.lightning.mod.client.controlplane.mc.WorldRuntime;

/**
 * {@code scene.weather.time}（scene，同步）：设定世界的权威时刻与天气。
 *
 * <h2>与 {@code shot.multi} 的 {@code worldTime} 的区别（任务单明写，两义不互替）</h2>
 * <ul>
 * <li>{@code shot.multi.worldTime} 是<b>拍摄光照基准</b>：它是取证参数，作用域是那一次拍摄，
 * 语义是「拍这张图时按这个时刻布光」；</li>
 * <li>本动作是<b>改世界权威状态</b>：写的是服务端 {@link WorldInfo} 的 {@code worldTime}，
 * 会被原版的 S03 时间同步广播给客户端并<b>持续生效</b>（{@code doDaylightCycle} 开着时还会继续走）。
 * 后续任何读面（{@code world.info} 的 {@code worldTime}）与任何拍摄都能观察到它。</li>
 * </ul>
 * 二者写的是同一个字段，但<b>意图与作用域不同</b>：要「这一张图亮一点」用前者；要「这个世界现在是白天」
 * 用后者。同时用不冲突——拍摄基准会在拍摄前再设一次。
 *
 * <h2>天气为什么要连 {@code rainTime}/{@code thunderTime} 一起写</h2>
 * 1.7.10 的天气是<b>倒计时驱动</b>的（{@code World.updateWeatherBody}）：每个 tick 递减
 * {@code rainTime}，归零时<b>翻转</b> {@code raining}。只写 {@code setRaining(true)} 而不写倒计时，
 * 天气会在原倒计时到点的那一刻自己翻回去——「设了天气但过几秒就变了」。
 * 因此本动作在设天气时同时把对应倒计时重置为 {@code duration}（默认 12000 tick = 10 分钟），
 * 让「设定的天气」在整个布景/拍摄窗口内稳定成立。
 *
 * <p>
 * 另外，纯客户端 {@code mc.theWorld.setRainStrength()} 对权威世界无效（客户端是被同步方），
 * 所以这里只写服务端：原版 {@code WorldServer.updateWeather} 会把
 * {@code rainingStrength}/{@code thunderingStrength} 经 {@code S2BPacketChangeGameState(7/8)}
 * 广播给客户端，客户端自己渐入。
 */
public final class WeatherTimeAction implements ControlAction {

    /** 天气默认持续时间（tick；1.7.10 一天 24000 tick）。 */
    public static final int DEFAULT_DURATION_TICKS = 12000;

    @Override
    public JsonObject execute(ActionContext ctx) {
        Minecraft mc = WorldRuntime.mc();
        WorldServer world = L0Session.requireServerWorld(ctx, "scene.weather.time");

        if (!ctx.has("worldTime") && !ctx.has("weather") && !ctx.has("doDaylightCycle")) {
            throw CpException.param(
                "没有可写字段",
                "worldTime|weather|doDaylightCycle",
                "至少给一个：worldTime（0..23999 tick 或别名）| weather（clear|rain|thunder）| doDaylightCycle");
        }

        JsonObject before = snapshot(world);
        JsonObject applied = new JsonObject();

        if (ctx.has("worldTime")) {
            long t = resolveWorldTime(ctx);
            world.setWorldTime(t);
            applied.addProperty("worldTime", Long.valueOf(world.getWorldTime()));
            applied.addProperty("worldTimeRequested", Long.valueOf(t));
        }
        if (ctx.has("weather")) {
            String weather = ctx.optString("weather", null);
            int duration = ctx.optInt("duration", DEFAULT_DURATION_TICKS);
            if (duration < 1) {
                throw CpException.param("duration 非法", "duration", "须 ≥ 1 tick，收到 " + duration);
            }
            applyWeather(world, weather, duration, applied);
        }
        if (ctx.has("doDaylightCycle")) {
            boolean cycle = ctx.optBool("doDaylightCycle", true);
            try {
                world.getGameRules()
                    .setOrCreateGameRule("doDaylightCycle", cycle ? "true" : "false");
            } catch (Throwable t) {
                throw new CpException(
                    com.lightning.mod.client.controlplane.core.ErrorCodes.EXEC_FAILED,
                    "设置 doDaylightCycle 失败: " + t,
                    Json.object("doDaylightCycle", Boolean.valueOf(cycle)));
            }
            applied.addProperty(
                "doDaylightCycle",
                world.getGameRules()
                    .getGameRuleStringValue("doDaylightCycle"));
        }

        JsonObject after = snapshot(world);
        JsonObject o = new JsonObject();
        o.addProperty("layer", "L0");
        o.addProperty(
            "semanticsNote",
            "改世界权威状态（服务端 WorldInfo）；与 shot.multi 的 worldTime 拍摄基准是两义：" + "后者只影响那一次拍摄的光照基准，本动作改变世界本身并持续生效");
        o.add("applied", applied);
        o.add("before", before);
        o.add("after", after);
        // 客户端侧的可观察值：world.info 的 worldTime 读的就是客户端世界，故一并给出（同步需若干 tick）
        o.add("clientView", clientSnapshot(mc));
        ctx.emit(
            EventStream.LEVEL_INFO,
            EventStream.Kinds.CASE_SEGMENT,
            "scene.weather.time：" + Json.toJson(applied),
            applied);
        return L0Session.decorated("scene.weather.time", o, world, mc);
    }

    // ------------------------------------------------------------ 各项

    /**
     * 解析 {@code worldTime}：接受 0..23999 的 tick，或别名
     * {@code day}/{@code noon}/{@code sunset}/{@code night}/{@code midnight}。
     */
    private static long resolveWorldTime(ActionContext ctx) {
        com.google.gson.JsonElement e = ctx.param("worldTime");
        if (e == null) {
            throw CpException.param("worldTime 缺失", "worldTime", "必填");
        }
        if (e.isJsonPrimitive() && e.getAsJsonPrimitive()
            .isString()) {
            String s = e.getAsString()
                .trim()
                .toLowerCase(java.util.Locale.ROOT);
            Long alias = aliasOf(s);
            if (alias == null) {
                throw CpException.param(
                    "未知时刻别名",
                    "worldTime",
                    "合法别名 day(1000) | noon(6000) | sunset(12000) | night(13000) | midnight(18000)，收到: " + s);
            }
            return alias.longValue();
        }
        long t = ctx.optLong("worldTime", Long.MIN_VALUE);
        if (t == Long.MIN_VALUE) {
            throw CpException.param("worldTime 非法", "worldTime", "须为整数 tick 或时刻别名");
        }
        if (t < 0 || t > 23999) {
            throw CpException.param("worldTime 越界", "worldTime", "1.7.10 一天 0..23999 tick，收到 " + t);
        }
        return t;
    }

    private static Long aliasOf(String s) {
        if ("day".equals(s) || "morning".equals(s)) {
            return Long.valueOf(1000L);
        }
        if ("noon".equals(s)) {
            return Long.valueOf(6000L);
        }
        if ("sunset".equals(s) || "dusk".equals(s)) {
            return Long.valueOf(12000L);
        }
        if ("night".equals(s)) {
            return Long.valueOf(13000L);
        }
        if ("midnight".equals(s)) {
            return Long.valueOf(18000L);
        }
        return null;
    }

    private static void applyWeather(WorldServer world, String raw, int duration, JsonObject applied) {
        String weather = raw == null ? null
            : raw.trim()
                .toLowerCase(java.util.Locale.ROOT);
        WorldInfo info = world.getWorldInfo();
        if ("clear".equals(weather) || "sunny".equals(weather)) {
            info.setRaining(false);
            info.setThundering(false);
            info.setRainTime(duration);
            info.setThunderTime(duration);
        } else if ("rain".equals(weather)) {
            info.setRaining(true);
            info.setThundering(false);
            info.setRainTime(duration);
            info.setThunderTime(duration);
        } else if ("thunder".equals(weather) || "storm".equals(weather)) {
            info.setRaining(true);
            info.setThundering(true);
            info.setRainTime(duration);
            info.setThunderTime(duration);
        } else {
            throw CpException.param("未知天气", "weather", "只允许 clear | rain | thunder，收到: " + raw);
        }
        applied.addProperty("weather", weather);
        applied.addProperty("duration", Integer.valueOf(duration));
        applied.addProperty("raining", Boolean.valueOf(info.isRaining()));
        applied.addProperty("thundering", Boolean.valueOf(info.isThundering()));
        applied.addProperty("rainTime", Integer.valueOf(info.getRainTime()));
        applied.addProperty("thunderTime", Integer.valueOf(info.getThunderTime()));
    }

    // ------------------------------------------------------------ 快照

    /** 服务端权威世界的天气/时刻/强度（写前写后各读一次）。 */
    static JsonObject snapshot(WorldServer world) {
        WorldInfo info = world.getWorldInfo();
        JsonObject o = new JsonObject();
        o.addProperty("worldTime", Long.valueOf(world.getWorldTime()));
        o.addProperty("totalWorldTime", Long.valueOf(world.getTotalWorldTime()));
        o.addProperty("raining", Boolean.valueOf(info.isRaining()));
        o.addProperty("thundering", Boolean.valueOf(info.isThundering()));
        o.addProperty("rainTime", Integer.valueOf(info.getRainTime()));
        o.addProperty("thunderTime", Integer.valueOf(info.getThunderTime()));
        o.addProperty("rainingStrength", Float.valueOf(world.rainingStrength));
        o.addProperty("thunderingStrength", Float.valueOf(world.thunderingStrength));
        o.addProperty("daylightCycle", safeGamerule(world, "doDaylightCycle"));
        o.addProperty("weatherCycle", safeGamerule(world, "doWeatherCycle"));
        return o;
    }

    /** 客户端世界的可观察值（同步落点；读面未就绪时这是「变化被观察到」的兜底证据）。 */
    private static JsonObject clientSnapshot(Minecraft mc) {
        JsonObject o = new JsonObject();
        if (mc == null || mc.theWorld == null) {
            o.addProperty("loaded", false);
            return o;
        }
        o.addProperty("loaded", true);
        o.addProperty("worldTime", Long.valueOf(mc.theWorld.getWorldTime()));
        o.addProperty("raining", Boolean.valueOf(mc.theWorld.isRaining()));
        o.addProperty("thundering", Boolean.valueOf(mc.theWorld.isThundering()));
        o.addProperty("rainingStrength", Float.valueOf(mc.theWorld.rainingStrength));
        return o;
    }

    private static String safeGamerule(WorldServer world, String rule) {
        try {
            if (!world.getGameRules()
                .hasRule(rule)) {
                return null;
            }
            return world.getGameRules()
                .getGameRuleStringValue(rule);
        } catch (Throwable t) {
            CpLog.warn("读取游戏规则 %s 失败: %s", rule, String.valueOf(t));
            return null;
        }
    }

    /** 集成服是否在位（留痕用）。 */
    static boolean serverPresent() {
        MinecraftServer s = WorldRuntime.server();
        return s != null;
    }
}
