package com.lightning.mod.client.controlplane.mc;

import net.minecraft.client.Minecraft;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * {@code /cp/v1/about} 用到的「与 MC 状态有关」的字段快照。
 *
 * <p>
 * <b>为什么需要它</b>：契约 §1.8 规定 HTTP 线程绝不触碰 MC 状态，而 {@code about} 是在 HTTP 线程上
 * 组装的。因此不能在那里读 {@code mc.theWorld}/{@code mc.thePlayer}/触发文件；改由 tick 线程周期性地
 * 刷新本快照，HTTP 线程只读这几个 volatile 字段。
 *
 * <p>
 * 刷新频率约每秒一次（tick 处理器每 {@value #REFRESH_INTERVAL_TICKS} tick 刷新一次），
 * 另在每次动作排空后刷新一次，保证 about 的「忙闲/世界」信息够新。
 */
public final class CpAboutSnapshot {

    /** 刷新间隔（tick）。 */
    public static final int REFRESH_INTERVAL_TICKS = 20;

    private static volatile boolean refreshed;
    private static volatile String probe;
    private static volatile boolean worldLoaded;
    private static volatile boolean managedWorld;
    private static volatile String worldFolder;
    private static volatile boolean busy;
    private static volatile long refreshedAtMillis;

    private CpAboutSnapshot() {}

    /** tick 线程调用：重新采集快照。 */
    public static void refresh(Minecraft mc) {
        String active = ProbeActivity.firstActive(mc);
        JsonObject w = WorldDescriber.describe(mc);
        probe = active;
        worldLoaded = Json.optBool(w, "loaded", false);
        managedWorld = Json.optBool(w, "managed", false);
        worldFolder = Json.optString(w, "folder", null);
        ControlPlaneRuntime rt = ControlPlaneBootstrap.runtime();
        busy = rt != null && rt.busy();
        refreshedAtMillis = System.currentTimeMillis();
        refreshed = true;
    }

    /** HTTP 线程调用：把快照字段补进 about 对象。 */
    public static void contribute(JsonObject about) {
        about.addProperty("probeActive", probe != null);
        about.addProperty("probe", probe);
        about.addProperty("worldLoaded", worldLoaded);
        about.addProperty("managedWorld", managedWorld);
        about.addProperty("worldFolder", worldFolder);
        about.addProperty("busy", busy);
        about.addProperty("snapshotFresh", refreshed);
        about.addProperty(
            "snapshotAgeMs",
            refreshed ? Long.valueOf(System.currentTimeMillis() - refreshedAtMillis) : null);
    }

    /** 是否已经采集过。 */
    public static boolean isRefreshed() {
        return refreshed;
    }
}
