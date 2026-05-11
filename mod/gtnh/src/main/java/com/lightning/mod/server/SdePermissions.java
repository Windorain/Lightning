package com.lightning.mod.server;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.server.MinecraftServer;

/** 与 {@code /sde} 命令一致：权限等级 2（OP）。 */
public final class SdePermissions {

    private SdePermissions() {}

    public static boolean canUseSde(EntityPlayerMP player) {
        MinecraftServer server = MinecraftServer.getServer();
        if (server == null) {
            return false;
        }
        return server.getConfigurationManager()
            .func_152596_g(player.getGameProfile());
    }
}
