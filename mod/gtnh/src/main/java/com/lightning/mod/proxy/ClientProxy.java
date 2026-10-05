package com.lightning.mod.proxy;

import net.minecraft.client.Minecraft;
import net.minecraftforge.common.MinecraftForge;

import org.apache.logging.log4j.Level;

import com.lightning.mod.client.SelectionClientState;
import com.lightning.mod.client.automation.SdeClientAutomationTickHandler;
import com.lightning.mod.client.controlplane.mc.ControlPlaneBootstrap;
import com.lightning.mod.client.export.ExportBundleTickHandler;
import com.lightning.mod.client.gui.GuiSdeCellNote;
import com.lightning.mod.client.meshcapture.MeshCaptureClient;
import com.lightning.mod.client.render.SelectionBoxRenderer;
import com.lightning.mod.client.render.WandHighlightRenderer;
import com.lightning.mod.config.SdeControlPlaneConfig;
import com.lightning.mod.network.packet.PacketSyncSelection;

import cpw.mods.fml.common.FMLCommonHandler;
import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

@SideOnly(Side.CLIENT)
public class ClientProxy extends CommonProxy {

    @Override
    public void initNetwork() {
        super.initNetwork();
        MinecraftForge.EVENT_BUS.register(new SelectionBoxRenderer());
        MinecraftForge.EVENT_BUS.register(new WandHighlightRenderer());
        // ClientTickEvent（1.7.10）由 FML 总线派发，勿注册到 MinecraftForge.EVENT_BUS。
        FMLCommonHandler.instance()
            .bus()
            .register(new ExportBundleTickHandler());
        FMLCommonHandler.instance()
            .bus()
            .register(new SdeClientAutomationTickHandler());
        // 控制面（contract.md §9）：默认关闭；启用时装配 HTTP 服务并注册自己的 tick 排空器。
        // 启动失败只记日志，不影响客户端其余初始化。
        if (SdeControlPlaneConfig.isEnabled()) {
            try {
                ControlPlaneBootstrap.start(Minecraft.getMinecraft());
            } catch (Throwable t) {
                FMLLog.log(Level.ERROR, t, "[SDE][CP] 控制面启动异常（已吞掉，游戏继续）");
            }
        } else {
            FMLLog.info("[SDE][CP] 控制面未启用（controlplane.enabled=false 且未设 -Dsde.controlPlane=on）");
        }
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
