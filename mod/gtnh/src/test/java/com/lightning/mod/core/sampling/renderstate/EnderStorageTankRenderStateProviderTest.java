package com.lightning.mod.core.sampling.renderstate;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import net.minecraft.tileentity.TileEntity;
import net.minecraftforge.fluids.FluidStack;

import org.junit.Test;

/**
 * {@link EnderStorageTankRenderStateProvider}：目标判定、序列化往返与"回填到副本"的语义。
 * <p>
 * 用例用同名形状的夹具代替真模组 TE，因此不依赖测试 classpath 上有没有那个模组；真实液面的读数由实机验收给出
 * （{@code FluidStack} 的构造需要流体注册表，纯 JVM 单测里只覆盖压力位与"没有流体时不动副本"这两条）。
 */
public class EnderStorageTankRenderStateProviderTest {

    private static final String FIXTURE_CLASS = FixtureTank.class.getName();

    @Test
    public void formatAndTargetClassContract() {
        assertEquals("enderstorage.tank-render-state/v1", EnderStorageTankRenderStateProvider.FORMAT);
        assertEquals(
            "codechicken.enderstorage.storage.liquid.TileEnderTank",
            EnderStorageTankRenderStateProvider.TILE_CLASS);
        EnderStorageTankRenderStateProvider provider = new EnderStorageTankRenderStateProvider();
        assertEquals(EnderStorageTankRenderStateProvider.FORMAT, provider.format());
    }

    @Test
    public void matchesOnlyTheTargetTileClass() {
        EnderStorageTankRenderStateProvider provider = new EnderStorageTankRenderStateProvider(FIXTURE_CLASS);
        assertTrue(provider.matches(new FixtureTank(), "EnderStorage:enderChest"));
        assertFalse("null 不匹配", provider.matches(null, "EnderStorage:enderChest"));
        assertFalse(
            "生产目标名与本夹具不同类",
            new EnderStorageTankRenderStateProvider().matches(new FixtureTank(), "EnderStorage:enderChest"));
    }

    @Test
    public void writeIsNullForNonTargetAndForNonTargetTile() {
        assertNull(new EnderStorageTankRenderStateProvider().write(new FixtureTank()));
        EnderStorageTankRenderStateProvider provider = new EnderStorageTankRenderStateProvider(FIXTURE_CLASS);
        assertNotNull("压力位是必写项：即使没有流体也要留下状态", provider.write(new FixtureTank()));
    }

    @Test
    public void applyWritesTheCurrentAndPreviousValveAngleAsOneValue() {
        EnderStorageTankRenderStateProvider provider = new EnderStorageTankRenderStateProvider(FIXTURE_CLASS);
        FixtureTank source = new FixtureTank();
        source.pressure_state.a_pressure = true;
        byte[] state = provider.write(source);

        FixtureTank copy = new FixtureTank();
        copy.pressure_state.a_rotate = 12.5;
        copy.pressure_state.b_rotate = 7.5;
        assertTrue(provider.apply(copy, state));
        assertTrue(copy.pressure_state.a_pressure);
        assertEquals("静态导出不插值：两值相等即当前角", -90.0, copy.pressure_state.a_rotate, 1e-9);
        assertEquals(-90.0, copy.pressure_state.b_rotate, 1e-9);
    }

    @Test
    public void missingLiquidLeavesTheCopyDefaultsAlone() {
        EnderStorageTankRenderStateProvider provider = new EnderStorageTankRenderStateProvider(FIXTURE_CLASS);
        byte[] state = provider.write(new FixtureTank());
        FixtureTank copy = new FixtureTank();
        assertTrue(provider.apply(copy, state));
        assertNull("快照里没有流体时不得凭空造一个", copy.liquid_state.c_liquid);
        assertNull(copy.liquid_state.s_liquid);
        assertFalse(copy.pressure_state.a_pressure);
        assertEquals(90.0, copy.pressure_state.a_rotate, 1e-9);
    }

    @Test
    public void applyRejectsGarbageAndNonTargets() {
        EnderStorageTankRenderStateProvider provider = new EnderStorageTankRenderStateProvider(FIXTURE_CLASS);
        assertFalse(provider.apply(new FixtureTank(), new byte[] { 1, 2, 3 }));
        assertFalse(provider.apply(new FixtureTank(), null));
        assertFalse(provider.apply(new FixtureTank(), new byte[0]));
        assertFalse(new EnderStorageTankRenderStateProvider().apply(new FixtureTank(), new byte[] { 1 }));
    }

    /** 与储罐 TE 同形状：液体状态 + 压力状态。 */
    public static final class FixtureTank extends TileEntity {

        public FixtureLiquidState liquid_state = new FixtureLiquidState();
        public FixturePressureState pressure_state = new FixturePressureState();
    }

    public static final class FixtureLiquidState {

        public FluidStack c_liquid;
        public FluidStack s_liquid;
    }

    public static final class FixturePressureState {

        public boolean a_pressure;
        public boolean b_pressure;
        public double a_rotate;
        public double b_rotate;

        public double approachRotate() {
            return a_pressure ? -90 : 90;
        }
    }
}
