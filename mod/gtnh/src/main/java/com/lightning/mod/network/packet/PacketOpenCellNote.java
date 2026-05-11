package com.lightning.mod.network.packet;

import cpw.mods.fml.common.network.ByteBufUtils;
import cpw.mods.fml.common.network.simpleimpl.IMessage;
import io.netty.buffer.ByteBuf;

/**
 * 服务端 → 客户端：打开体素备注编辑（默认文案为当前格已存内容）。
 */
public class PacketOpenCellNote implements IMessage {

    public int frameIndex;
    public int zSlice;
    public int row;
    public int column;
    public String initialText = "";

    public PacketOpenCellNote() {}

    public PacketOpenCellNote(int frameIndex, int zSlice, int row, int column, String initialText) {
        this.frameIndex = frameIndex;
        this.zSlice = zSlice;
        this.row = row;
        this.column = column;
        this.initialText = initialText != null ? initialText : "";
    }

    @Override
    public void fromBytes(ByteBuf buf) {
        frameIndex = buf.readInt();
        zSlice = buf.readInt();
        row = buf.readInt();
        column = buf.readInt();
        initialText = ByteBufUtils.readUTF8String(buf);
    }

    @Override
    public void toBytes(ByteBuf buf) {
        buf.writeInt(frameIndex);
        buf.writeInt(zSlice);
        buf.writeInt(row);
        buf.writeInt(column);
        ByteBufUtils.writeUTF8String(buf, initialText);
    }
}
