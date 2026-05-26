package com.lightning.mod.mixin.mixins.early.minecraft.accessors;

import net.minecraftforge.client.ForgeHooksClient;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

import com.lightning.mod.client.meshcapture.ForgeWorldRenderPassUtil;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState;

/**
 * 在 SDE 离屏捕获期间覆盖 {@link ForgeHooksClient#getWorldRenderPass()} 的返回值。
 * <p>
 * Angelica 的 {@code @Overwrite} 将此方法委托到 {@code RenderPassHelper}，后者在主线程读字段、
 * 在工作线程读 ThreadLocal——SDE 的反射设字段无法影响 ThreadLocal。
 * 此 inject 在 HEAD 处拦截：若 SDE 正在录制且 {@link ForgeWorldRenderPassUtil} 记录过期望 pass，
 * 则直接返回该值，跳过 Angelica 的转发逻辑。
 */
@Mixin(value = ForgeHooksClient.class, remap = false)
public class MixinForgeHooksClient_WorldRenderPass {

    @Inject(method = "getWorldRenderPass", at = @At("HEAD"), cancellable = true, require = 0)
    private static void sde$overrideWorldRenderPassDuringCapture(CallbackInfoReturnable<Integer> cir) {
        if (!TessellatorCaptureState.isRecording()) return;
        int wanted = ForgeWorldRenderPassUtil.getLastSetPass();
        if (wanted >= 0) {
            cir.setReturnValue(wanted);
        }
    }
}
