package com.lightning.mod.core.sampling;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import org.junit.Test;

/**
 * 渲染状态参与 palette 去重的回归（Gitea #410 方向 A）。
 *
 * <p>
 * 失效后果是「静默画错」：一排同型管道的 NBT 逐字节相同，只有连接状态不同；一旦渲染状态不进
 * {@link VoxelSample#cellTypeDedupeKey()}，扫描会把它们折叠成一个 cellType，回填后整排管子都用
 * 第一种连接形状——导出件本身完全看不出异常。
 */
public class VoxelSampleTest {

    @Test
    public void renderStateBytesParticipateInCellTypeDedupeKey() {
        byte[] eastWest = { 0, 3, 0 };
        byte[] eastOnly = { 0, 1, 0 };
        VoxelSample a = new VoxelSample("logisticspipes:pipe", 0, null, null, null, eastWest, "lp/v1");
        VoxelSample b = new VoxelSample("logisticspipes:pipe", 0, null, null, null, eastOnly, "lp/v1");
        VoxelSample aAgain = new VoxelSample("logisticspipes:pipe", 0, null, null, null, eastWest.clone(), "lp/v1");

        assertFalse(
            "连接状态不同的两根管不得折叠成同一 cellType",
            a.cellTypeDedupeKey()
                .equals(b.cellTypeDedupeKey()));
        assertEquals("同样的渲染状态必须仍然去重（否则快照会无谓膨胀）", a.cellTypeDedupeKey(), aAgain.cellTypeDedupeKey());
    }

    @Test
    public void samplesWithoutRenderStateKeepTheirOldKey() {
        VoxelSample noState = new VoxelSample("minecraft:chest", 3);
        VoxelSample withState = new VoxelSample("minecraft:chest", 3, null, null, null, new byte[] { 1 }, "lp/v1");

        assertEquals(
            "无渲染状态的样本键必须与修复前同形（不含 rs: 段）",
            new VoxelSample("minecraft:chest", 3).cellTypeDedupeKey(),
            noState.cellTypeDedupeKey());
        assertFalse(
            "带了渲染状态的样本不得与无状态的样本去重",
            noState.cellTypeDedupeKey()
                .equals(withState.cellTypeDedupeKey()));
    }
}
