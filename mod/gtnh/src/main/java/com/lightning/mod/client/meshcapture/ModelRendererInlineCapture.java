package com.lightning.mod.client.meshcapture;

import java.util.List;

import net.minecraft.client.model.ModelBox;
import net.minecraft.client.model.ModelRenderer;
import net.minecraft.client.renderer.Tessellator;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 把 {@link ModelRenderer} 的 {@code cubeList} 逐盒写进当前 {@link Tessellator} 的唯一实现。
 * <p>
 * 为什么单独成类：捕获期需要"不画显示列表、而是把模型几何发射到录制缓冲"这一段动作，而环境事实层还要回答
 * "模型几何这次到底能不能录到"。把发射动作集中到本类，探针与运行时走的是同一段代码，测量的才是真正会发生的事。
 * <p>
 * 捕获期的调用点拦截（{@code MixinModelRendererCapture} 的 {@code @WrapOperation}）在窗口内调用 {@link #emit}；
 * 环境事实探针也走同一段代码，"探针测到的"与"运行时真正发生的"因此是同一件事。
 * <p>
 * <strong>约束</strong>：本方法只写顶点，不动 GL 状态、不动矩阵、不发起 {@code draw}——调用方负责把 MODELVIEW
 * 摆到与真实渲染一致的位置，并在窗口外决定是否真的绘制。{@code scale} 必须由调用方按当前渲染的缩放原样传入。
 */
@SideOnly(Side.CLIENT)
public final class ModelRendererInlineCapture {

    private ModelRendererInlineCapture() {}

    /**
     * 逐 {@link ModelBox} 发射几何。
     *
     * @param renderer 模型部件；{@code null} 或 {@code cubeList} 为空时什么都不做
     * @param scale    当前渲染缩放（{@code ModelRenderer.render} 的入参）
     */
    public static void emit(ModelRenderer renderer, float scale) {
        if (renderer == null) {
            return;
        }
        List<ModelBox> boxes = renderer.cubeList;
        if (boxes == null || boxes.isEmpty()) {
            return;
        }
        Tessellator tess = Tessellator.instance;
        for (int i = 0; i < boxes.size(); i++) {
            ModelBox box = boxes.get(i);
            if (box != null) {
                box.render(tess, scale);
            }
        }
    }
}
