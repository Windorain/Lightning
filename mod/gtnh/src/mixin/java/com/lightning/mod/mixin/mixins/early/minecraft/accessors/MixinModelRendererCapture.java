package com.lightning.mod.mixin.mixins.early.minecraft.accessors;

import java.util.List;

import net.minecraft.client.model.ModelBox;
import net.minecraft.client.model.ModelRenderer;
import net.minecraft.client.renderer.GLAllocation;
import net.minecraft.client.renderer.Tessellator;

import org.lwjgl.opengl.GL11;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.Redirect;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import com.lightning.mod.client.meshcapture.TessellatorCaptureState;

/**
 * 非 TESR：编译后仅 glCallList 时强制失效 display list，使顶点重新进入 Tessellator（库存/其它路径）。
 * <p>
 * 动态扩展（{@link TessellatorCaptureState#isDynamicExtensionVertexRecording()}）：{@link ModelRenderer#render} 在方法开头就
 * {@link ModelRenderer#compileDisplayList}，此时尚未应用 rotationPoint/旋转；若在此时录顶点，箱盖/箱体/锁扣会共用一个错误的局部原点而重合。处理方式：跳过真实编译（生成空
 * display list）、在 {@code glCallList} 处以当前矩阵内联
 * {@link ModelBox#render}，并由 {@link MixinTessellatorCapture} 做 {@code inv(M0)*M_now} 顶点变换以对齐块烘焙。
 */
@Mixin(ModelRenderer.class)
public abstract class MixinModelRendererCapture {

    @Shadow
    private boolean compiled;

    @Shadow
    private int displayList;

    @Shadow
    public List<ModelBox> cubeList;

    @Inject(method = { "render", "renderWithRotation" }, at = @At("HEAD"))
    private void sde$head(float scale, CallbackInfo ci) {
        if (!TessellatorCaptureState.isRecording()) {
            return;
        }
        if (TessellatorCaptureState.isDynamicExtensionVertexRecording()) {
            TessellatorCaptureState.setActiveModelRendererScale(scale);
            return;
        }
        if (this.compiled && this.displayList != 0) {
            GLAllocation.deleteDisplayLists(this.displayList);
            this.displayList = 0;
        }
        this.compiled = false;
    }

    @Inject(method = "compileDisplayList", at = @At("HEAD"), cancellable = true)
    private void sde$emptyCompileDuringTesrCapture(float scale, CallbackInfo ci) {
        if (!TessellatorCaptureState.isRecording() || !TessellatorCaptureState.isDynamicExtensionVertexRecording()) {
            return;
        }
        this.displayList = GLAllocation.generateDisplayLists(1);
        GL11.glNewList(this.displayList, GL11.GL_COMPILE);
        GL11.glEndList();
        this.compiled = true;
        ci.cancel();
    }

    @Redirect(
        method = { "render", "renderWithRotation" },
        at = @At(value = "INVOKE", target = "Lorg/lwjgl/opengl/GL11;glCallList(I)V", remap = false))
    private void sde$inlineModelDuringTesrCapture(int list) {
        if (!TessellatorCaptureState.isRecording() || !TessellatorCaptureState.isDynamicExtensionVertexRecording()) {
            GL11.glCallList(list);
            return;
        }
        ModelRenderer self = (ModelRenderer) (Object) this;
        float sc = TessellatorCaptureState.getActiveModelRendererScale();
        Tessellator tess = Tessellator.instance;
        for (int i = 0; i < self.cubeList.size(); ++i) {
            self.cubeList.get(i)
                .render(tess, sc);
        }
    }
}
