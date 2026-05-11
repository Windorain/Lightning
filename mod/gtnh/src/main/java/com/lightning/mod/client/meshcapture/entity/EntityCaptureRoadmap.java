package com.lightning.mod.client.meshcapture.entity;

import com.lightning.mod.client.meshcapture.CaptureCoordinatePolicy;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState;
import com.lightning.mod.client.meshcapture.vanilla.VanillaTileEntityRenderEnvironment;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * <p>
 * <strong>路线图（未实现）</strong>：实体网格捕获应与单格 {@link TessellatorCaptureState#beginBlock} / {@code [0,1]³}
 * 块管线<strong>分轨</strong>。
 * </p>
 * <ul>
 * <li>入口：{@code Entity + partialTicks + 可选相机}，而非 world方块角坐标。</li>
 * <li>对齐原版：{@code RenderManager#cacheActiveRenderInfo}、{@code renderEntitySimple}（及静态实体 display list 路径），参见
 * {@code RenderGlobal#renderEntities} 中 {@code RenderManager} 段；勿与 {@link VanillaTileEntityRenderEnvironment} 的 TE
 * 段混用同一 session。</li>
 * <li>可复用：Tessellator mixin录制、{@link com.lightning.mod.client.meshcapture.MaterialKeyResolver}、动态扩展
 * MODELVIEW 基线思想。</li>
 * <li>不可复用：{@link CaptureCoordinatePolicy} 的块体素契约；实体输出需独立归一化或世界空间策略。</li>
 * </ul>
 */
@SideOnly(Side.CLIENT)
public final class EntityCaptureRoadmap {

    private EntityCaptureRoadmap() {}
}
