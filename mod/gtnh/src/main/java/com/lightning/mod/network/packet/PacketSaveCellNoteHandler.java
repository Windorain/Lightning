package com.lightning.mod.network.packet;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.util.ChatComponentText;

import com.lightning.mod.core.session.ExportSession;
import com.lightning.mod.server.SdePermissions;

import cpw.mods.fml.common.network.simpleimpl.IMessage;
import cpw.mods.fml.common.network.simpleimpl.IMessageHandler;
import cpw.mods.fml.common.network.simpleimpl.MessageContext;

public class PacketSaveCellNoteHandler implements IMessageHandler<PacketSaveCellNote, IMessage> {

    @Override
    public IMessage onMessage(PacketSaveCellNote m, MessageContext ctx) {
        EntityPlayerMP p = ctx.getServerHandler().playerEntity;
        if (p == null) {
            return null;
        }
        if (!SdePermissions.canUseSde(p)) {
            p.addChatMessage(new ChatComponentText("SDE: 需要 OP 权限"));
            return null;
        }
        if (!ExportSession.get()
            .isInSession()) {
            p.addChatMessage(new ChatComponentText("SDE: 请先 /sde start"));
            return null;
        }
        String t = m.text;
        if (t != null && t.length() > 8000) {
            t = t.substring(0, 8000);
        }
        int frame = ExportSession.get()
            .getActiveFrame();
        ExportSession.get()
            .setCellNote(frame, m.zSlice, m.row, m.column, t);
        p.addChatMessage(new ChatComponentText("SDE: 已保存当前帧体素备注"));
        return null;
    }
}
