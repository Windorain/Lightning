package com.lightning.mod.server;

import java.util.List;
import java.util.UUID;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.server.MinecraftServer;
import net.minecraft.util.ChatComponentText;

import com.google.gson.JsonObject;
import com.lightning.mod.core.session.ExportSession;

/**
 * 服务端 tick 驱动的连录与 cycle 调度；唯一写入经 {@link ExportSession#commitScanToFrame} /
 * {@link ExportSession#recordIntoFrame}。
 */
public final class SdeServerRecordScheduler {

    private static final SdeServerRecordScheduler INSTANCE = new SdeServerRecordScheduler();

    /** 与 cycle 的「最多 256 tick」上界一致。 */
    public static final int MAX_CONSECUTIVE_RECORD_TICKS = 256;
    public static final int MAX_CYCLE_ATTEMPTS = 256;

    public static SdeServerRecordScheduler get() {
        return INSTANCE;
    }

    private enum Mode {
        IDLE,
        TICK_BATCH,
        CYCLE
    }

    private Mode mode = Mode.IDLE;
    private UUID playerId;

    private int tickF0;
    private int tickTotal;
    private int tickIndex;

    private String cycleBaselineJson;
    private int cycleF0;
    private int cycleWriteIndex;
    private int cycleRunCount;

    private SdeServerRecordScheduler() {}

    public boolean isBusy() {
        return mode != Mode.IDLE;
    }

    public void clear() {
        mode = Mode.IDLE;
        playerId = null;
    }

    /**
     * 从下一服务端 tick 起，连续 N 个 tick 分别写入 {@code f0}..{@code f0 + N - 1}。
     */
    public boolean tryStartTickBatch(EntityPlayerMP player, int f0, int n) {
        if (mode != Mode.IDLE) {
            return false;
        }
        if (n <= 0 || n > MAX_CONSECUTIVE_RECORD_TICKS) {
            return false;
        }
        mode = Mode.TICK_BATCH;
        playerId = player.getUniqueID();
        tickF0 = f0;
        tickTotal = n;
        tickIndex = 0;
        return true;
    }

    /**
     * 当前 tick 内已完成首帧 F0 与 baseline 写入后调用；自下一 tick 起每 tick 比较 scan 与 baseline 直至相等或超次。
     */
    public boolean tryStartCycleFromNextTick(EntityPlayerMP player, int f0, String baselineJson) {
        if (mode != Mode.IDLE) {
            return false;
        }
        mode = Mode.CYCLE;
        playerId = player.getUniqueID();
        cycleF0 = f0;
        cycleBaselineJson = baselineJson;
        cycleWriteIndex = 0;
        cycleRunCount = 0;
        return true;
    }

    public void onServerTick() {
        if (mode == Mode.IDLE) {
            return;
        }
        EntityPlayerMP p = findServerPlayer(playerId);
        if (p == null) {
            clear();
            return;
        }
        ExportSession s = ExportSession.get();
        if (!s.isInSession() || !SdePermissions.canUseSde(p)) {
            clear();
            return;
        }
        if (!s.getSelectionSnapshot().complete) {
            clear();
            p.addChatMessage(new ChatComponentText("SDE: 选区已失效，已中止连录/ cycle"));
            return;
        }
        try {
            switch (mode) {
                case TICK_BATCH:
                    onTickBatch(p, s);
                    break;
                case CYCLE:
                    onTickCycle(p, s);
                    break;
                default:
                    break;
            }
        } catch (Exception e) {
            p.addChatMessage(new ChatComponentText("SDE: 调度已中止: " + e.getMessage()));
            clear();
        }
    }

    private void onTickBatch(EntityPlayerMP p, ExportSession s) {
        int target = tickF0 + tickIndex;
        s.recordIntoFrame(target, p);
        tickIndex++;
        if (tickIndex >= tickTotal) {
            p.addChatMessage(
                new ChatComponentText(
                    "SDE: 连录完成 " + tickTotal + " 帧（F" + tickF0 + "–" + (tickF0 + tickTotal - 1) + "，未落盘）"));
            clear();
        }
    }

    private void onTickCycle(EntityPlayerMP p, ExportSession s) {
        cycleRunCount++;
        if (cycleRunCount > MAX_CYCLE_ATTEMPTS) {
            p.addChatMessage(new ChatComponentText("SDE: cycle 已超时（" + MAX_CYCLE_ATTEMPTS + " tick 内未与首帧结构一致，未落盘）"));
            clear();
            return;
        }
        JsonObject cur = s.scanToStructureJsonOnly(p);
        if (s.jsonStringForScanCompare(cur)
            .equals(cycleBaselineJson)) {
            p.addChatMessage(new ChatComponentText("SDE: cycle 已闭合（与首帧 scan 一致，" + cycleRunCount + " tick，未落盘）"));
            clear();
            return;
        }
        int target = cycleF0 + 1 + cycleWriteIndex;
        s.commitScanToFrame(target, cur, p);
        cycleWriteIndex++;
    }

    private static EntityPlayerMP findServerPlayer(UUID id) {
        if (id == null) {
            return null;
        }
        MinecraftServer sv = MinecraftServer.getServer();
        if (sv == null) {
            return null;
        }
        @SuppressWarnings("rawtypes")
        List list = sv.getConfigurationManager().playerEntityList;
        for (int i = 0; i < list.size(); i++) {
            Object o = list.get(i);
            if (o instanceof EntityPlayerMP) {
                EntityPlayerMP p = (EntityPlayerMP) o;
                if (id.equals(p.getUniqueID())) {
                    return p;
                }
            }
        }
        return null;
    }
}
