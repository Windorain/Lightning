package com.lightning.mod.network.packet;

import cpw.mods.fml.common.network.ByteBufUtils;
import cpw.mods.fml.common.network.simpleimpl.IMessage;
import io.netty.buffer.ByteBuf;

/**
 * 客户端 → 服务端：保存体素备注。
 */
public class PacketSaveCellNote implements IMessage {

    public int frameIndex;
    public int zSlice;
    public int row;
    public int column;
    public String text = "";

    public PacketSaveCellNote() {}

    public PacketSaveCellNote(int frameIndex, int zSlice, int row, int column, String text) {
        this.frameIndex = frameIndex;
        this.zSlice = zSlice;
        this.row = row;
        this.column = column;
        this.text = text != null ? text : "";
    }

    @Override
    public void fromBytes(ByteBuf buf) {
        frameIndex = buf.readInt();
        zSlice = buf.readInt();
        row = buf.readInt();
        column = buf.readInt();
        text = ByteBufUtils.readUTF8String(buf);
    }

    @Override
    public void toBytes(ByteBuf buf) {
        buf.writeInt(frameIndex);
        buf.writeInt(zSlice);
        buf.writeInt(row);
        buf.writeInt(column);
        ByteBufUtils.writeUTF8String(buf, text);
    }
}
