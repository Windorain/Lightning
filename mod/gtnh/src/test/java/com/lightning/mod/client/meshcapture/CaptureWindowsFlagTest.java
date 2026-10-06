package com.lightning.mod.client.meshcapture;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * {@link CaptureWindowsFlag#isOn(String)}：录窗布防属性的取值口径。
 * 纯函数单测（零 MC 依赖）；布防副作用（armWindows/beginSession）在 ClientProxy 挂点上，不在此测。
 */
public class CaptureWindowsFlagTest {

    @Test
    public void onEnablesArmingCaseInsensitively() {
        assertTrue(CaptureWindowsFlag.isOn("on"));
        assertTrue(CaptureWindowsFlag.isOn("ON"));
        assertTrue(CaptureWindowsFlag.isOn("On"));
        assertTrue(CaptureWindowsFlag.isOn("  on  "));
    }

    @Test
    public void missingOrBlankValueKeepsCurrentBehavior() {
        // 缺省 = 完全现状（不布防）
        assertFalse(CaptureWindowsFlag.isOn(null));
        assertFalse(CaptureWindowsFlag.isOn(""));
        assertFalse(CaptureWindowsFlag.isOn("   "));
    }

    @Test
    public void unrecognizedValuesStayOff() {
        assertFalse(CaptureWindowsFlag.isOn("off"));
        assertFalse(CaptureWindowsFlag.isOn("OFF"));
        assertFalse(CaptureWindowsFlag.isOn("true"));
        assertFalse(CaptureWindowsFlag.isOn("1"));
        assertFalse(CaptureWindowsFlag.isOn("yes"));
        assertFalse(CaptureWindowsFlag.isOn("onn"));
        assertFalse(CaptureWindowsFlag.isOn("on!"));
        assertFalse(CaptureWindowsFlag.isOn("on off"));
    }
}
