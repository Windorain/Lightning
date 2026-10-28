package com.lightning.mod.client.meshcapture.compat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.lang.reflect.Field;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import com.lightning.mod.client.meshcapture.env.TogglePresence;

/**
 * 捕获期"箱子 TESR 网格缓存开关"的拨动纪律：只有事实 PRESENT 才碰字段；缺失/改名/签名不符一律降级为
 * 不拨动且不抛；拨动与还原成对，动作抛异常也要在 finally 里还原。
 * <p>
 * 用例不加载批处理渲染层：用一个本地静态 boolean 字段做替身，反射路径与真实运行一致。
 */
public class AngelicaChestCacheToggleTest {

    @Before
    public void setUp() {
        AngelicaChestCacheToggle.resetForTesting();
        FakeConfig.enableTESRChestCache = true;
    }

    @After
    public void tearDown() {
        AngelicaChestCacheToggle.resetForTesting();
        FakeConfig.enableTESRChestCache = true;
    }

    @Test
    public void absentFactNeverTouchesTheFieldAndStillRunsTheAction() {
        FakeConfig.enableTESRChestCache = true;
        AngelicaChestCacheToggle.runWithCacheDisabled(TogglePresence.ABSENT, new Runnable() {

            @Override
            public void run() {
                FakeConfig.enableTESRChestCache = false;
            }
        });
        assertFalse("动作必须照常执行", FakeConfig.enableTESRChestCache);
    }

    @Test
    public void unknownFactNeverTouchesTheField() {
        assertNull(AngelicaChestCacheToggle.disableForCapture(TogglePresence.UNKNOWN));
        assertTrue(FakeConfig.enableTESRChestCache);
    }

    @Test
    public void missingClassDegradesToNoOp() {
        assertNull(AngelicaChestCacheToggle.resolveField("does.not.Exist", "enableTESRChestCache"));
        // 真实目标类不在测试 classpath：事实为 PRESENT 也只能降级为不拨动，绝不抛
        assertNull(AngelicaChestCacheToggle.disableForCapture(TogglePresence.PRESENT));
    }

    @Test
    public void renamedFieldDegradesToNoOp() {
        assertNull(AngelicaChestCacheToggle.resolveField(FakeConfig.class.getName(), "renamedEnableTESRChestCache"));
    }

    @Test
    public void nonBooleanFieldIsRejected() {
        assertNull(AngelicaChestCacheToggle.resolveField(FakeConfig.class.getName(), "notABoolean"));
    }

    @Test
    public void presentToggleDisablesAndRestoresAsAPair() throws Exception {
        Field f = FakeConfig.class.getField("enableTESRChestCache");
        AngelicaChestCacheToggle.setFieldForTesting(f);

        Boolean previous = AngelicaChestCacheToggle.disableForCapture(TogglePresence.PRESENT);
        assertEquals(Boolean.TRUE, previous);
        assertFalse("捕获窗口内必须处于关闭态", FakeConfig.enableTESRChestCache);

        AngelicaChestCacheToggle.restore(previous);
        assertTrue("窗口结束必须还原", FakeConfig.enableTESRChestCache);
    }

    @Test
    public void alreadyDisabledFieldIsNotForciblyReEnabled() throws Exception {
        FakeConfig.enableTESRChestCache = false;
        Field f = FakeConfig.class.getField("enableTESRChestCache");
        AngelicaChestCacheToggle.setFieldForTesting(f);

        Boolean previous = AngelicaChestCacheToggle.disableForCapture(TogglePresence.PRESENT);
        assertEquals(Boolean.FALSE, previous);
        AngelicaChestCacheToggle.restore(previous);
        assertFalse("本来就是关的，还原不得擅自打开", FakeConfig.enableTESRChestCache);
    }

    @Test
    public void exceptionPathStillRestoresInFinally() throws Exception {
        Field f = FakeConfig.class.getField("enableTESRChestCache");
        AngelicaChestCacheToggle.setFieldForTesting(f);
        try {
            AngelicaChestCacheToggle.runWithCacheDisabled(TogglePresence.PRESENT, new Runnable() {

                @Override
                public void run() {
                    throw new IllegalStateException("render blew up on purpose");
                }
            });
            fail("expected the action exception to propagate after finally");
        } catch (IllegalStateException expected) {
            // 预期：动作异常照常抛出，但字段已还原
        }
        assertTrue("异常路径必须在 finally 里还原", FakeConfig.enableTESRChestCache);
    }

    /** 字段替身：公有静态 boolean，和真实开关的签名一致。 */
    public static final class FakeConfig {

        public static boolean enableTESRChestCache = true;

        public static int notABoolean = 0;
    }
}
