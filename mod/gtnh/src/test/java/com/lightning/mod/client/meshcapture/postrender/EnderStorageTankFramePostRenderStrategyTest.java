package com.lightning.mod.client.meshcapture.postrender;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import com.lightning.mod.client.meshcapture.env.ModelAccessPresence;

/**
 * {@link EnderStorageTankFramePostRenderStrategy} 的参与判据与注册契约。
 * <p>
 * 判据被抽成纯函数 {@code decisionApplies}，四条合取项逐条钉住：身份（注册名 + meta + TE 类）与事实
 * （{@link ModelAccessPresence#PRESENT}）。这四条的任一条单独成立都不够——"事实是 PRESENT 但这一格不是储罐"与
 * "是储罐但模型数据取不到"都必须不参与，前者会写错格、后者会写出半份几何。
 */
public class EnderStorageTankFramePostRenderStrategyTest {

    @Test
    public void priorityAndNullContextContract() {
        EnderStorageTankFramePostRenderStrategy strategy = new EnderStorageTankFramePostRenderStrategy();
        assertEquals(1500, strategy.priority());
        assertFalse("空上下文不参与", strategy.applies(null));
        assertEquals("EnderStorage:enderChest", EnderStorageTankFramePostRenderStrategy.BLOCK_ID);
        assertEquals(1, EnderStorageTankFramePostRenderStrategy.TANK_META);
        assertEquals(
            "codechicken.enderstorage.storage.liquid.TileEnderTank",
            EnderStorageTankFramePostRenderStrategy.TANK_TILE_CLASS);
    }

    @Test
    public void participatesOnlyWhenIdentityAndFactAllHold() {
        assertTrue(decision(ModelAccessPresence.PRESENT, 1, "EnderStorage:enderChest", tile()));
    }

    @Test
    public void factMustBePresent() {
        assertFalse(decision(ModelAccessPresence.ABSENT, 1, "EnderStorage:enderChest", tile()));
        assertFalse(decision(ModelAccessPresence.UNKNOWN, 1, "EnderStorage:enderChest", tile()));
    }

    @Test
    public void metaMustBeTheTankMeta() {
        assertFalse(decision(ModelAccessPresence.PRESENT, 0, "EnderStorage:enderChest", tile()));
    }

    @Test
    public void blockMustBeTheEnderStorageBlock() {
        assertFalse(decision(ModelAccessPresence.PRESENT, 1, "EnderStorage:enderChestFake", tile()));
        assertFalse(decision(ModelAccessPresence.PRESENT, 1, null, tile()));
    }

    @Test
    public void tileMustBeTheTankTileItself() {
        assertFalse(
            decision(
                ModelAccessPresence.PRESENT,
                1,
                "EnderStorage:enderChest",
                "codechicken.enderstorage.storage.item.TileEnderChest"));
        assertFalse(decision(ModelAccessPresence.PRESENT, 1, "EnderStorage:enderChest", null));
    }

    private static boolean decision(ModelAccessPresence presence, int meta, String blockId, String tileClass) {
        return EnderStorageTankFramePostRenderStrategy.decisionApplies(blockId, meta, tileClass, presence);
    }

    private static String tile() {
        return EnderStorageTankFramePostRenderStrategy.TANK_TILE_CLASS;
    }
}
