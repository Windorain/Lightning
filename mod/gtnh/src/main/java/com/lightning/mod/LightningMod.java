package com.lightning.mod;

import com.lightning.mod.config.SdeControlPlaneConfig;
import com.lightning.mod.item.SdeItems;
import com.lightning.mod.proxy.IProxy;
import com.lightning.mod.server.SdeServerRecordTickHandler;
import com.lightning.mod.server.command.CommandSde;

import cpw.mods.fml.common.FMLCommonHandler;
import cpw.mods.fml.common.Mod;
import cpw.mods.fml.common.SidedProxy;
import cpw.mods.fml.common.event.FMLInitializationEvent;
import cpw.mods.fml.common.event.FMLPreInitializationEvent;
import cpw.mods.fml.common.event.FMLServerStartingEvent;

@Mod(modid = LightningMod.MODID, version = LightningMod.VERSION)
public class LightningMod {

    public static final String MODID = "lightning";
    public static final String VERSION = "0.2";

    /** 1.7.10 集成服下 FML init 的 Side 可能仅有 CLIENT，tick 监听器在 {@link FMLServerStartingEvent} 注册。 */
    private static boolean sdeServerRecordTickHandlerRegistered;

    @SidedProxy(clientSide = "com.lightning.mod.proxy.ClientProxy", serverSide = "com.lightning.mod.proxy.CommonProxy")
    public static IProxy proxy;

    @Mod.EventHandler
    public void preInit(FMLPreInitializationEvent event) {
        // 老批处理设施（触发文件驱动的自动化链与其 SdeAutomationConfig）已整体删除，
        // 故不再装载 sde_automation.cfg；控制面配置是唯一的自动化配置面。
        // 控制面配置（contract.md §1 第 1 条）：默认关闭；-Dsde.controlPlane=on 可覆盖（见 SdeControlPlaneConfig）
        SdeControlPlaneConfig.load(event);
        SdeItems.register();
    }

    @Mod.EventHandler
    public void init(FMLInitializationEvent event) {
        proxy.initNetwork();
    }

    @Mod.EventHandler
    public void onServerStarting(FMLServerStartingEvent event) {
        if (!sdeServerRecordTickHandlerRegistered) {
            FMLCommonHandler.instance()
                .bus()
                .register(new SdeServerRecordTickHandler());
            // 命令通道的服务端 tick 排空器：必须在服务端启动时注册——
            // 1.7.10 集成服下 ServerTickEvent 只在此之后才被派发，而事件总线只投给已注册的监听器。
            // 惰性注册（首次执行命令时）会让命令入队后永远无人排空 ⇒ 每次调用 CP-EXEC-002 超时。
            // 实现见 client/controlplane/mc/cmd/ServerCommandInvoker#ensureRegistered（含实机教训）。
            com.lightning.mod.client.controlplane.mc.cmd.ServerCommandInvoker.ensureRegistered();
            sdeServerRecordTickHandlerRegistered = true;
        }
        event.registerServerCommand(new CommandSde());
    }
}
