package com.lightning.mod.client.meshcapture.primary;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 主批次策略：按 {@link BlockPrimaryCaptureStrategy#priority()} 升序扫描，首个 {@code applies} 命中则执行并结束。
 */
@SideOnly(Side.CLIENT)
public final class BlockPrimaryCaptureRegistry {

    private static final CopyOnWriteArrayList<BlockPrimaryCaptureStrategy> STRATEGIES = new CopyOnWriteArrayList<>();

    static {
        register(new VanillaPrimaryBlockCaptureStrategy());
    }

    private BlockPrimaryCaptureRegistry() {}

    public static void register(BlockPrimaryCaptureStrategy strategy) {
        if (strategy != null) {
            STRATEGIES.add(strategy);
        }
    }

    public static void dispatch(BlockPrimaryCaptureContext ctx) {
        if (ctx == null) {
            return;
        }
        List<BlockPrimaryCaptureStrategy> sorted = new ArrayList<>(STRATEGIES);
        sorted.sort(Comparator.comparingInt(BlockPrimaryCaptureStrategy::priority));
        for (BlockPrimaryCaptureStrategy s : sorted) {
            try {
                if (s.applies(ctx)) {
                    s.renderPrimary(ctx);
                    return;
                }
            } catch (Throwable t) {
                FMLLog.warning(
                    "[SDE] BlockPrimaryCaptureRegistry: strategy %s failed: %s",
                    s.getClass()
                        .getName(),
                    t.getMessage());
            }
        }
    }
}
