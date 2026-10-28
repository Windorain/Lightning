package com.lightning.mod.mixin.mixins.early.minecraft.accessors;

import java.util.List;

import net.minecraft.client.model.ModelBox;
import net.minecraft.client.model.ModelRenderer;
import net.minecraft.client.renderer.GLAllocation;

import org.lwjgl.opengl.GL11;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import com.lightning.mod.client.meshcapture.ModelRendererInlineCapture;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState;
import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;

/**
 * 非 TESR：编译后仅 glCallList 时强制失效 display list，使顶点重新进入 Tessellator（库存/其它路径）。
 * <p>
 * 动态扩展（{@link TessellatorCaptureState#isDynamicExtensionVertexRecording()}）：{@link ModelRenderer#render} 在方法开头就
 * {@link ModelRenderer#compileDisplayList}，此时尚未应用 rotationPoint/旋转；若在此时录顶点，箱盖/箱体/锁扣会共用一个错误的局部原点而重合。处理方式：跳过真实编译（生成空
 * display list）、在 {@code glCallList} 处以当前矩阵内联
 * {@link ModelBox#render}，并由 {@link MixinTessellatorCapture} 做 {@code inv(M0)*M_now} 顶点变换以对齐块烘焙。
 * <p>
 * 1.0 纯观察门控：display-list 失效/改写路径只服务旧逐格捕获（{@link TessellatorCaptureState#isLegacyPerCellCapture()}）。
 * 新通道录窗（BLOCK_COMPILE/TESR）期间本 Mixin 完全惰性——真实渲染循环里删 display list 会强制逐帧重编译、
 * 内联路径会把顶点写进未在绘制态的 Tessellator.instance，二者都违反「只记录、不改变渲染行为/状态/路径」。
 * <p>
 * <strong>调用点包裹（为什么不是 {@code @Redirect}）</strong>：本类用 MixinExtras 的 {@link WrapOperation} 包住
 * vanilla 的 {@code GL11.glCallList} 调用点，而不是自己去抢 {@code @Redirect}。{@code @WrapOperation} 是后置注入器：
 * 它看到的是"所有常规注入应用完之后"的调用点——如果别的模组（例如批处理渲染层）已用 {@code @Redirect} 接管了这一句，
 * 它包住的是<strong>那个接管者</strong>，接管者追加的局部变量参数由 MixinExtras 绑进 {@link Operation} 的闭包；
 * 如果没人接管，它包住的就是 vanilla 调用。窗口外一律 {@code original.call(list)} 原样放行，窗口内才改为
 * {@link ModelRendererInlineCapture#emit} 写顶点、不产生真实绘制。{@code require = 0}：调用点被别的模组整段重写时
 * 不炸启动——环境事实层会把模型几何能力报成读不到，零产出裁决接手，而不是在启动期崩溃。
 * <p>
 * 同一处旧的 {@code @Redirect} 已随本改动退役：两者共存只会在同一调用点上互相竞争，且在被更高优先级接管时
 * 多留一条 {@code Skipping} 日志。
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
        if (!TessellatorCaptureState.isLegacyPerCellCapture()) {
            // 1.0 新通道录窗：纯观察，不动 display list
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

    @WrapOperation(
        method = { "render", "renderWithRotation" },
        at = @At(value = "INVOKE", target = "Lorg/lwjgl/opengl/GL11;glCallList(I)V", remap = false),
        require = 0)
    private void sde$wrapCallList(int list, Operation<Void> original) {
        if (TessellatorCaptureState.isRecording() && TessellatorCaptureState.isDynamicExtensionVertexRecording()) {
            ModelRendererInlineCapture
                .emit((ModelRenderer) (Object) this, TessellatorCaptureState.getActiveModelRendererScale());
            return;
        }
        original.call(list);
    }
}
