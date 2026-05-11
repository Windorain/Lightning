package com.lightning.mod.proxy;

import net.minecraft.client.Minecraft;
import net.minecraftforge.common.MinecraftForge;

import com.lightning.mod.client.SelectionClientState;
import com.lightning.mod.client.automation.SdeClientAutomationTickHandler;
import com.lightning.mod.client.export.ExportBundleTickHandler;
import com.lightning.mod.client.gui.GuiSdeCellNote;
import com.lightning.mod.client.meshcapture.MeshCaptureClient;
import com.lightning.mod.client.render.SelectionBoxRenderer;
import com.lightning.mod.network.packet.PacketSyncSelection;

import cpw.mods.fml.common.FMLCommonHandler;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

@SideOnly(Side.CLIENT)
public class ClientProxy extends CommonProxy {

    @Override
    public void initNetwork() {
        super.initNetwork();
        MinecraftForge.EVENT_BUS.register(new SelectionBoxRenderer());
        // ClientTickEvent（1.7.10）由 FML 总线派发，勿注册到 MinecraftForge.EVENT_BUS。
        FMLCommonHandler.instance()
            .bus()
            .register(new ExportBundleTickHandler());
        FMLCommonHandler.instance()
            .bus()
            .register(new SdeClientAutomationTickHandler());
    }

    @Override
    public void applySelectionSync(PacketSyncSelection packet) {
        SelectionClientState.apply(packet);
    }

    @Override
    public void enqueueMeshCapturePayload(String fileName, byte[] utf8Json, boolean writeRaw) {
        MeshCaptureClient.enqueuePayload(fileName, utf8Json, writeRaw);
    }

    @Override
    public void openCellNoteEditor(int frameIndex, int zSlice, int row, int column, String initialText) {
        Minecraft.getMinecraft()
            .displayGuiScreen(new GuiSdeCellNote(frameIndex, zSlice, row, column, initialText));
    }
}
