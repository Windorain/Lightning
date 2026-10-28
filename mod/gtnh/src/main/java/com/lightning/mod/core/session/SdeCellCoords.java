package com.lightning.mod.core.session;

/**
 * 选区 AABB 内世界坐标 → 与 {@code cellGrid[z][row][column]} 一致的下标（与
 * {@link com.lightning.mod.core.scan.StructureScan} 中嵌套顺序一致）。
 */
public final class SdeCellCoords {

    private SdeCellCoords() {}

    public static String cellKey(int zSlice, int row, int col) {
        return zSlice + "," + row + "," + col;
    }

    /** 解析 "z,row,column"；失败返回 null */
    public static int[] tryParseCellKey(String key) {
        if (key == null) {
            return null;
        }
        String[] p = key.split(",");
        if (p.length != 3) {
            return null;
        }
        try {
            return new int[] { Integer.parseInt(p[0].trim()), Integer.parseInt(p[1].trim()),
                Integer.parseInt(p[2].trim()) };
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /**
     * 世界方块 (wx,wy,wz) 若落在 [min..max] 选区内，则写入体素下标 (zi,ri,ci)，与 {@code cellGrid[zi][ri][ci]} 一致（行 0 为
     * 最高 y）。
     */
    public static boolean tryWorldToCell(int wx, int wy, int wz, int minX, int minY, int minZ, int maxX, int maxY,
        int maxZ, int[] outZrc) {
        if (outZrc == null || outZrc.length < 3) {
            return false;
        }
        int ax = Math.min(minX, maxX);
        int bx = Math.max(minX, maxX);
        int ay = Math.min(minY, maxY);
        int by = Math.max(minY, maxY);
        int az = Math.min(minZ, maxZ);
        int bz = Math.max(minZ, maxZ);
        if (wx < ax || wx > bx || wy < ay || wy > by || wz < az || wz > bz) {
            return false;
        }
        int sizeZ = bz - az + 1;
        int sizeRow = by - ay + 1;
        int sizeCol = bx - ax + 1;
        int zi = wz - az;
        int ri = by - wy;
        int ci = wx - ax;
        if (zi < 0 || zi >= sizeZ || ri < 0 || ri >= sizeRow || ci < 0 || ci >= sizeCol) {
            return false;
        }
        outZrc[0] = zi;
        outZrc[1] = ri;
        outZrc[2] = ci;
        return true;
    }
}
