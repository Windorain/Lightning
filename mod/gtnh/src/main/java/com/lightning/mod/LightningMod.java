package com.lightning.mod;

import com.lightning.mod.config.SdeAutomationConfig;
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

    @SidedProxy(
        clientSide = "com.lightning.mod.proxy.ClientProxy",
        serverSide = "com.lightning.mod.proxy.CommonProxy")
    public static IProxy proxy;

    @Mod.EventHandler
    public void preInit(FMLPreInitializationEvent event) {
        SdeAutomationConfig.load(event);
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
            sdeServerRecordTickHandlerRegistered = true;
        }
        event.registerServerCommand(new CommandSde());
    }
}
