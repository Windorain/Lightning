package com.lightning.mod.network.packet;

import com.lightning.mod.LightningMod;

import cpw.mods.fml.common.network.simpleimpl.IMessage;
import cpw.mods.fml.common.network.simpleimpl.IMessageHandler;
import cpw.mods.fml.common.network.simpleimpl.MessageContext;

public class PacketSyncSelectionHandler implements IMessageHandler<PacketSyncSelection, IMessage> {

    @Override
    public IMessage onMessage(PacketSyncSelection message, MessageContext ctx) {
        LightningMod.proxy.applySelectionSync(message);
        return null;
    }
}
