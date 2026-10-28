package com.lightning.mod.network;

import net.minecraft.entity.player.EntityPlayerMP;

import com.lightning.mod.core.session.ExportSession;
import com.lightning.mod.core.session.SelectionSnapshot;
import com.lightning.mod.network.packet.PacketEnrichExportedScene;
import com.lightning.mod.network.packet.PacketEnrichExportedSceneHandler;
import com.lightning.mod.network.packet.PacketOpenCellNote;
import com.lightning.mod.network.packet.PacketOpenCellNoteHandler;
import com.lightning.mod.network.packet.PacketSaveCellNote;
import com.lightning.mod.network.packet.PacketSaveCellNoteHandler;
import com.lightning.mod.network.packet.PacketSyncSelection;
import com.lightning.mod.network.packet.PacketSyncSelectionHandler;

import cpw.mods.fml.common.network.simpleimpl.SimpleNetworkWrapper;
import cpw.mods.fml.relauncher.Side;

/**
 * 服务端向客户端同步选区线框。
 * <p>
 * 通道名须短：GTNH 的 Hodgepodge 等对 {@code S3FPacketCustomPayload} 通道字符串有 ≤20 字符校验。
 */
public final class SdeNetwork {

    /** 与 modid 无关；仅用于 FML SimpleNetworkWrapper 注册名 */
    private static final String NETWORK_CHANNEL = "sde";

    private static SimpleNetworkWrapper channel;
    private static boolean initialized;

    private SdeNetwork() {}

    public static void init() {
        if (initialized) {
            return;
        }
        initialized = true;
        channel = new SimpleNetworkWrapper(NETWORK_CHANNEL);
        channel.registerMessage(PacketSyncSelectionHandler.class, PacketSyncSelection.class, 0, Side.CLIENT);
        channel
            .registerMessage(PacketEnrichExportedSceneHandler.class, PacketEnrichExportedScene.class, 1, Side.CLIENT);
        channel.registerMessage(PacketOpenCellNoteHandler.class, PacketOpenCellNote.class, 2, Side.CLIENT);
        channel.registerMessage(PacketSaveCellNoteHandler.class, PacketSaveCellNote.class, 3, Side.SERVER);
    }

    public static boolean isReady() {
        return channel != null;
    }

    public static void sendOpenCellNote(EntityPlayerMP player, int frame, int zSlice, int row, int col,
        String initial) {
        if (channel == null) {
            return;
        }
        channel.sendTo(new PacketOpenCellNote(frame, zSlice, row, col, initial), player);
    }

    public static void sendSaveCellNoteToServer(PacketSaveCellNote packet) {
        if (channel == null) {
            return;
        }
        channel.sendToServer(packet);
    }

    public static void sendSelectionSync(EntityPlayerMP player) {
        if (channel == null) {
            return;
        }
        SelectionSnapshot snap = ExportSession.get()
            .getSelectionSnapshot();
        channel.sendTo(new PacketSyncSelection(snap), player);
    }

    public static void sendSelectionToPlayer(EntityPlayerMP player) {
        sendSelectionSync(player);
    }

    /**
     * 将场景 JSON 全文发给执行导出的玩家，由客户端捕获网格后写入本地 {@code structure_exports} 目录下对应文件名。
     */
    public static void sendEnrichExportedScene(EntityPlayerMP player, String fileName, byte[] utf8Json,
        boolean writeRaw) {
        if (channel == null || fileName == null || fileName.isEmpty() || utf8Json == null || utf8Json.length == 0) {
            return;
        }
        channel.sendTo(new PacketEnrichExportedScene(fileName, utf8Json, writeRaw), player);
    }
}
