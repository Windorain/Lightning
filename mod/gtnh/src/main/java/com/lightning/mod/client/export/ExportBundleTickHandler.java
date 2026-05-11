package com.lightning.mod.client.export;

import net.minecraft.client.Minecraft;

import com.lightning.mod.client.meshcapture.MeshCaptureClient;

import cpw.mods.fml.common.eventhandler.SubscribeEvent;
import cpw.mods.fml.common.gameevent.TickEvent;
import cpw.mods.fml.relauncher.Side;

/** 每 tick 检查 {@code pending_dump.json}（服务端落盘），无自定义网络包。 */
public final class ExportBundleTickHandler {

    @SubscribeEvent
    public void onClientTick(TickEvent.ClientTickEvent e) {
        if (e.side == Side.CLIENT && e.phase == TickEvent.Phase.END) {
            ExportBundleClient.tickConsumePendingDumpIfAny(Minecraft.getMinecraft());
            MeshCaptureClient.tickConsumeOne();
        }
    }
}
