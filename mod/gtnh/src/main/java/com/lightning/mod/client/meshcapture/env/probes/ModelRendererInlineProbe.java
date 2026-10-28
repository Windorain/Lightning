package com.lightning.mod.client.meshcapture.env.probes;

import net.minecraft.client.model.ModelBase;
import net.minecraft.client.model.ModelRenderer;

import org.lwjgl.opengl.GL11;

import com.lightning.mod.client.meshcapture.ModelRendererInlineCapture;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedBlockInstance;
import com.lightning.mod.client.meshcapture.env.Capability;
import com.lightning.mod.client.meshcapture.env.CaptureEnvironmentFacts;
import com.lightning.mod.client.meshcapture.env.CaptureEnvironmentFacts.Fact;
import com.lightning.mod.client.meshcapture.env.CaptureEnvironmentProbe;
import com.lightning.mod.client.meshcapture.env.CaptureProbeContext;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 行为自证：{@code ModelRenderer} 的模型几何能不能在捕获窗口里被录到。
 * <p>
 * 做法：在<strong>丢弃窗口</strong>里创建一个合成模型（单个盒），走<strong>真实的渲染入口</strong>
 * {@link ModelRenderer#render(float)} 并数四边形。几何最终由与 {@link ModelRendererInlineCapture#emit}
 * 同一段发射逻辑产生（当前拦截仍是原地内联的等价实现），所以本探针回答的是"这条路径这次确实能产出几何"，
 * 而不是"某个注入器存在"。
 * <p>
 * <strong>模型缩放取 0</strong>（{@link #PROBE_MODEL_SCALE}）：万一捕获期内联没有生效，实际发生的是一次退化到
 * 零尺寸的显示列表绘制（不可见），不会在画面上闪一个方块。<strong>不要把它改成 1/16</strong>。
 * <p>
 * 读数为 0 ⇒ {@link Capability#CANNOT_CAPTURE}：该走兜底。这是"族 A"（几何在模型的 {@code cubeList} 里、
 * 绘制入口是显示列表）能否被救回来的唯一判据。
 */
@SideOnly(Side.CLIENT)
public final class ModelRendererInlineProbe implements CaptureEnvironmentProbe {

    public static final int DEFAULT_PRIORITY = 300;

    /** 探针模型缩放：0 = 内联失效时零尺寸不可见。改这个值会让探针在失效时闪一个方块。 */
    private static final float PROBE_MODEL_SCALE = 0.0F;

    private static final String WINDOW_TAG = "capture-env:model-renderer-geometry";

    @Override
    public int priority() {
        return DEFAULT_PRIORITY;
    }

    @Override
    public boolean applies(CaptureProbeContext ctx) {
        return ctx != null;
    }

    @Override
    public void probe(CaptureProbeContext ctx, CaptureEnvironmentFacts out) {
        if (!ctx.glContextAvailable()) {
            out.setCapability(Fact.MODEL_RENDERER_GEOMETRY, Capability.UNKNOWN);
            out.note("model_renderer_geometry: skipped (gl_context_unavailable:" + ctx.unavailableReason() + ")");
            return;
        }
        int quads = countProbeModelInDiscardWindow();
        out.setCapability(Fact.MODEL_RENDERER_GEOMETRY, quads > 0 ? Capability.CAN_CAPTURE : Capability.CANNOT_CAPTURE);
        out.note("model_renderer_geometry: quads=" + quads);
    }

    /** 在丢弃窗口里渲染一次合成模型，返回录到的四边形数。 */
    private static int countProbeModelInDiscardWindow() {
        ModelRenderer model = newProbeModel();
        CapturedBlockInstance discard = new CapturedBlockInstance();
        TessellatorCaptureState.beginBlock(0, 0, 0, WINDOW_TAG, 0, 0, 0, null, -1, -1, WINDOW_TAG);
        TessellatorCaptureState.beginDynamicExtensionVertexPhase();
        try {
            GL11.glPushMatrix();
            try {
                model.render(PROBE_MODEL_SCALE);
            } finally {
                GL11.glPopMatrix();
            }
        } finally {
            TessellatorCaptureState.endDynamicExtensionVertexPhase();
            TessellatorCaptureState.endBlock(discard);
        }
        return countFrom(discard);
    }

    /**
     * 数本次窗口的四边形。{@link TessellatorCaptureState#endBlock} 已把几何写进 {@code discard}；
     * 单盒模型 6 个四边形，读数为 0 即"内联没有产出"。
     */
    private static int countFrom(CapturedBlockInstance discard) {
        return discard.quads.size();
    }

    /**
     * 合成模型：不依赖任何模组与贴图，单个 2×2×2 的盒。<strong>缩放由调用方以 0 传入</strong>，
     * 因此盒子的绝对尺寸无关紧要，只用来产生 6 个面。
     */
    private static ModelRenderer newProbeModel() {
        ModelBase base = new ModelBase() {};
        base.textureWidth = 64;
        base.textureHeight = 64;
        ModelRenderer model = new ModelRenderer(base, 0, 0);
        model.setTextureSize(64, 64);
        model.addBox(-1.0F, -1.0F, -1.0F, 2, 2, 2);
        return model;
    }
}
