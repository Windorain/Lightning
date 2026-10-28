package com.lightning.mod.network.packet;

import com.lightning.mod.core.session.SelectionSnapshot;

import cpw.mods.fml.common.network.simpleimpl.IMessage;
import io.netty.buffer.ByteBuf;

public class PacketSyncSelection implements IMessage {

    public boolean inSession;
    public boolean complete;
    public int minX;
    public int minY;
    public int minZ;
    public int maxX;
    public int maxY;
    public int maxZ;

    public PacketSyncSelection() {}

    public PacketSyncSelection(SelectionSnapshot s) {
        this.inSession = s.inSession;
        this.complete = s.complete;
        this.minX = s.minX;
        this.minY = s.minY;
        this.minZ = s.minZ;
        this.maxX = s.maxX;
        this.maxY = s.maxY;
        this.maxZ = s.maxZ;
    }

    @Override
    public void fromBytes(ByteBuf buf) {
        inSession = buf.readBoolean();
        complete = buf.readBoolean();
        minX = buf.readInt();
        minY = buf.readInt();
        minZ = buf.readInt();
        maxX = buf.readInt();
        maxY = buf.readInt();
        maxZ = buf.readInt();
    }

    @Override
    public void toBytes(ByteBuf buf) {
        buf.writeBoolean(inSession);
        buf.writeBoolean(complete);
        buf.writeInt(minX);
        buf.writeInt(minY);
        buf.writeInt(minZ);
        buf.writeInt(maxX);
        buf.writeInt(maxY);
        buf.writeInt(maxZ);
    }
}
