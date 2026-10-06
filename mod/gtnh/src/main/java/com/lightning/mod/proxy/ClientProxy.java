package com.lightning.mod.proxy;

import net.minecraft.client.Minecraft;
import net.minecraftforge.common.MinecraftForge;

import org.apache.logging.log4j.Level;

import com.lightning.mod.client.SelectionClientState;
import com.lightning.mod.client.automation.SdeClientAutomationTickHandler;
import com.lightning.mod.client.controlplane.mc.ControlPlaneBootstrap;
import com.lightning.mod.client.export.ExportBundleTickHandler;
import com.lightning.mod.client.gui.GuiSdeCellNote;
import com.lightning.mod.client.meshcapture.CaptureDiagnostics;
import com.lightning.mod.client.meshcapture.CaptureWindowsFlag;
import com.lightning.mod.client.meshcapture.MeshCaptureClient;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState;
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
        // 诊断会话布防口（系统属性入口，客户端 init 链上最早的客户端专属挂点）：
        // -Dsde.captureWindows=on → TessellatorCaptureState.armWindows()（录窗总开关）
        // -Dsde.captureDiag.file=<路径>（同给）→ 再 CaptureDiagnostics.beginSession()（退出钩子落盘）
        // 这不是导出管线的组成部分：PR-1 交付的只是「录窗底座」，本口供非探针会话（控制面驱动
        // renderWorld 的场景）按需布防、一次性设定；PR-2 编排切换（MeshCaptureService 从录窗层取走
        // 窗口几何）落地后，布防才成为常开路径，届时由编排层驱动而非属性。属性缺省 = 完全现状：
        // 判定为关时连捕获层类都不初始化，零行为、零开销。
        armCaptureWindowsFromSystemProperties();
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

    /**
     * {@link #initNetwork()} 注释里那个布防口的实现：解析（纯函数 {@link CaptureWindowsFlag#isOn(String)}）
     * 与副作用分开，解析口径见 {@link CaptureWindowsFlag}。属性为关（含未设置）时直接返回，不触碰捕获层。
     */
    private static void armCaptureWindowsFromSystemProperties() {
        if (!CaptureWindowsFlag.isOn(System.getProperty(CaptureWindowsFlag.PROPERTY))) {
            return;
        }
        TessellatorCaptureState.armWindows();
        FMLLog.info("[SDE][capture] 录窗总开关已布防（-D" + CaptureWindowsFlag.PROPERTY + "=on）；" + "几何驻留仍关，PR-1 只计数");
        if (CaptureDiagnostics.hasFileTarget()) {
            CaptureDiagnostics.beginSession();
            FMLLog.info("[SDE][capture] 诊断会话已开启（sde.captureDiag.file 已给定，进程退出时落盘）");
        }
    }
}
