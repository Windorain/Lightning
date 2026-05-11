package com.lightning.mod.client;

import com.lightning.mod.core.session.SelectionSnapshot;
import com.lightning.mod.network.packet.PacketSyncSelection;

/** 客户端选区线框：原子替换快照，避免网络线程与渲染线程撕裂读。 */
public final class SelectionClientState {

    public static volatile SelectionSnapshot snapshot = SelectionSnapshot.empty(false);

    private SelectionClientState() {}

    public static void apply(PacketSyncSelection p) {
        snapshot = new SelectionSnapshot(p.inSession, p.complete, p.minX, p.minY, p.minZ, p.maxX, p.maxY, p.maxZ);
    }

    public static boolean shouldDrawBox() {
        SelectionSnapshot s = snapshot;
        return s.inSession && s.complete;
    }
}
