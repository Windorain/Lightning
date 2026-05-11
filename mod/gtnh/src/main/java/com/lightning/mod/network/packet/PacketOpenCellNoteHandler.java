package com.lightning.mod.network.packet;

import com.lightning.mod.LightningMod;

import cpw.mods.fml.common.network.simpleimpl.IMessage;
import cpw.mods.fml.common.network.simpleimpl.IMessageHandler;
import cpw.mods.fml.common.network.simpleimpl.MessageContext;

public class PacketOpenCellNoteHandler implements IMessageHandler<PacketOpenCellNote, IMessage> {

    @Override
    public IMessage onMessage(PacketOpenCellNote m, MessageContext ctx) {
        LightningMod.proxy.openCellNoteEditor(m.frameIndex, m.zSlice, m.row, m.column, m.initialText);
        return null;
    }
}
