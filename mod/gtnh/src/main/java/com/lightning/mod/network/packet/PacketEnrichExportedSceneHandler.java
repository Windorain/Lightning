package com.lightning.mod.network.packet;

import com.lightning.mod.LightningMod;

import cpw.mods.fml.common.network.simpleimpl.IMessage;
import cpw.mods.fml.common.network.simpleimpl.IMessageHandler;
import cpw.mods.fml.common.network.simpleimpl.MessageContext;

public class PacketEnrichExportedSceneHandler implements IMessageHandler<PacketEnrichExportedScene, IMessage> {

    @Override
    public IMessage onMessage(PacketEnrichExportedScene message, MessageContext ctx) {
        if (message.fileName != null && !message.fileName.isEmpty()
            && message.utf8Json != null
            && message.utf8Json.length > 0) {
            LightningMod.proxy
                .enqueueMeshCapturePayload(message.fileName, message.utf8Json, message.writeRaw);
        }
        return null;
    }
}
