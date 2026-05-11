package com.lightning.mod.client.meshcapture.finish;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 按 {@link BlockCaptureFinishStrategy#priority()} 升序，对全部 {@code applies} 为 true 的策略依次
 * {@link BlockCaptureFinishStrategy#finish}。
 */
@SideOnly(Side.CLIENT)
public final class BlockCaptureFinishRegistry {

    private static final CopyOnWriteArrayList<BlockCaptureFinishStrategy> STRATEGIES = new CopyOnWriteArrayList<>();

    private BlockCaptureFinishRegistry() {}

    public static void register(BlockCaptureFinishStrategy strategy) {
        if (strategy != null) {
            STRATEGIES.add(strategy);
        }
    }

    public static void runAll(BlockCaptureFinishContext ctx) {
        if (ctx == null) {
            return;
        }
        List<BlockCaptureFinishStrategy> sorted = new ArrayList<>(STRATEGIES);
        sorted.sort(Comparator.comparingInt(BlockCaptureFinishStrategy::priority));
        for (BlockCaptureFinishStrategy s : sorted) {
            try {
                if (s.applies(ctx)) {
                    s.finish(ctx);
                }
            } catch (Throwable t) {
                FMLLog.warning(
                    "[SDE] BlockCaptureFinishRegistry: strategy %s failed: %s",
                    s.getClass()
                        .getName(),
                    t.getMessage());
            }
        }
    }
}
