package com.lightning.mod.server;

import cpw.mods.fml.common.eventhandler.SubscribeEvent;
import cpw.mods.fml.common.gameevent.TickEvent;

/**
 * 在 {@link TickEvent.ServerTickEvent#Phase#END} 驱动 {@link SdeServerRecordScheduler}。
 */
public final class SdeServerRecordTickHandler {

    @SubscribeEvent
    public void onServerTick(TickEvent.ServerTickEvent e) {
        if (e.phase != TickEvent.Phase.END) {
            return;
        }
        SdeServerRecordScheduler.get()
            .onServerTick();
    }
}
