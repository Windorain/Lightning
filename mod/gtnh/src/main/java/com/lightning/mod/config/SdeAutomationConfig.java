package com.lightning.mod.config;

import java.io.File;

import net.minecraftforge.common.config.Configuration;

import cpw.mods.fml.common.event.FMLPreInitializationEvent;

/** 客户端自动化：主菜单进首存档、指令文件、执行完退出（见 {@code SdeClientAutomationTickHandler}）。 */
public final class SdeAutomationConfig {

    public static boolean autoLoadFirstSingleplayerWorld;
    public static String automationCommandFile;
    public static int commandDelayTicks;
    public static boolean exitGameAfterCommands;
    public static boolean cleanupCommandFileAfterRun;

    private SdeAutomationConfig() {}

    public static void load(FMLPreInitializationEvent event) {
        File cfgFile = event.getSuggestedConfigurationFile();
        Configuration cfg = new Configuration(cfgFile);
        cfg.load();
        autoLoadFirstSingleplayerWorld = cfg.getBoolean(
            "autoLoadFirstSingleplayerWorld",
            "automation",
            false,
            "为 true 时：在主菜单（GuiMainMenu）自动加载存档列表中的第一个世界（与选世界界面排序一致）。");
        automationCommandFile = cfg.getString(
            "automationCommandFile",
            "automation",
            "sde_automation_commands.txt",
            "相对 Minecraft mcDataDir 的指令文件路径；每行一条聊天命令（可写 sde status 或 /sde status）。空行与 # 开头行为注释。");
        commandDelayTicks = cfg.getInt("commandDelayTicks", "automation", 20, 0, 600, "两条自动指令之间的间隔（tick）。");
        exitGameAfterCommands = cfg
            .getBoolean("exitGameAfterCommands", "automation", true, "指令队列全部执行完后是否调用 Minecraft.shutdown() 退出游戏。");
        cleanupCommandFileAfterRun = cfg
            .getBoolean("cleanupCommandFileAfterRun", "automation", true, "执行完后是否删除指令文件，避免下次误触发。");
        if (cfg.hasChanged()) {
            cfg.save();
        }
    }
}
