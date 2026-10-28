package com.lightning.mod.proxy;

import com.lightning.mod.network.SdeNetwork;
import com.lightning.mod.network.packet.PacketSyncSelection;

public class CommonProxy implements IProxy {

    @Override
    public void initNetwork() {
        SdeNetwork.init();
    }

    @Override
    public void applySelectionSync(PacketSyncSelection packet) {
        // 服务端无客户端缓存
    }

    @Override
    public void enqueueMeshCapturePayload(String fileName, byte[] utf8Json, boolean writeRaw) {
        // 仅客户端处理
    }

    @Override
    public void openCellNoteEditor(int frameIndex, int zSlice, int row, int column, String initialText) {
        // 仅客户端
    }
}
