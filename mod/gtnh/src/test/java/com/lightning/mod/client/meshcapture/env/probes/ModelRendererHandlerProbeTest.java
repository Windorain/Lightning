package com.lightning.mod.client.meshcapture.env.probes;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * {@link ModelRendererHandlerProbe} 的外部处理器判据。
 * <p>
 * 这条判据只服务日志：它必须把<strong>本仓自己的</strong>处理器排除掉，否则读数"这个点上还有谁"就永远分不清
 * （注入器生成的方法名里带着本仓前缀）。它不是身份判据，也不参与任何兜底决定。
 */
public class ModelRendererHandlerProbeTest {

    @Test
    public void ownHandlersAreNotReportedAsExternal() {
        assertFalse(ModelRendererHandlerProbe.isExternalHandlerName("handler$zzh000$lightning$sde$head"));
        assertFalse(
            ModelRendererHandlerProbe
                .isExternalHandlerName("redirect$zzh000$lightning$sde$inlineModelDuringTesrCapture"));
        assertFalse(
            ModelRendererHandlerProbe
                .isExternalHandlerName("handler$zzh000$lightning$sde$emptyCompileDuringTesrCapture"));
    }

    @Test
    public void foreignHandlersAreReported() {
        assertTrue(ModelRendererHandlerProbe.isExternalHandlerName("angelica$batchPart"));
        assertTrue(ModelRendererHandlerProbe.isExternalHandlerName("handler$abc123$othermod$wrapCallList"));
    }

    @Test
    public void mixinExtrasBridgesAreNotReportedAsExternal() {
        assertFalse(
            ModelRendererHandlerProbe
                .isExternalHandlerName("mixinextras$bridge$redirect$zgf000$angelica$batchPart$20"));
        assertTrue(
            "被包的真正处理器仍然要列出来",
            ModelRendererHandlerProbe.isExternalHandlerName("redirect$zgf000$angelica$batchPart"));
    }

    @Test
    public void plainMethodsAndNullsAreNotHandlers() {
        assertFalse(ModelRendererHandlerProbe.isExternalHandlerName("render"));
        assertFalse(ModelRendererHandlerProbe.isExternalHandlerName("compileDisplayList"));
        assertFalse(ModelRendererHandlerProbe.isExternalHandlerName(null));
    }
}
