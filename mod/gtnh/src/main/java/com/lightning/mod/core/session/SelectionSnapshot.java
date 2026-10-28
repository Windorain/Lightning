package com.lightning.mod.core.session;

/** 供网络与客户端渲染读取的选区快照（无行为）。 */
public final class SelectionSnapshot {

    public final boolean inSession;
    /** 两角点均已设 */
    public final boolean complete;
    public final int minX;
    public final int minY;
    public final int minZ;
    public final int maxX;
    public final int maxY;
    public final int maxZ;

    public SelectionSnapshot(boolean inSession, boolean complete, int minX, int minY, int minZ, int maxX, int maxY,
        int maxZ) {
        this.inSession = inSession;
        this.complete = complete;
        this.minX = minX;
        this.minY = minY;
        this.minZ = minZ;
        this.maxX = maxX;
        this.maxY = maxY;
        this.maxZ = maxZ;
    }

    public static SelectionSnapshot empty(boolean inSession) {
        return new SelectionSnapshot(inSession, false, 0, 0, 0, 0, 0, 0);
    }
}
