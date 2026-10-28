package com.lightning.mod.client.meshcapture.vanilla;

import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.OpenGlHelper;
import net.minecraft.client.renderer.tileentity.TileEntityRendererDispatcher;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.World;

import org.lwjgl.opengl.GL11;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 对照 {@code RenderGlobal#renderEntities} 中区块实体段前后的常见准备：dispatcher 缓存、光照与矩阵相关由调用方负责。
 * <p>
 * 参考源码：{@code TileEntityRendererDispatcher#cacheActiveRenderInfo}、{@code func_147543_a}、lightmap。
 */
@SideOnly(Side.CLIENT)
public final class VanillaTileEntityRenderEnvironment {

    private VanillaTileEntityRenderEnvironment() {}

    public static void cacheActiveRenderInfo(float partialTicks) {
        Minecraft mc = Minecraft.getMinecraft();
        TileEntityRendererDispatcher.instance.cacheActiveRenderInfo(
            mc.theWorld,
            mc.getTextureManager(),
            mc.fontRenderer,
            mc.renderViewEntity,
            partialTicks);
    }

    /** 与 {@link TileEntityRendererDispatcher#func_147543_a(World)} 一致的世界绑定。 */
    public static void bindDispatcherWorld(World world) {
        TileEntityRendererDispatcher.instance.func_147543_a(world);
    }

    public static void applyBlockLightmap(World world, TileEntity te) {
        int br = world.getLightBrightnessForSkyBlocks(te.xCoord, te.yCoord, te.zCoord, 0);
        int sl = br % 65536;
        int bl = br / 65536;
        OpenGlHelper.setLightmapTextureCoords(OpenGlHelper.lightmapTexUnit, sl / 1.0F, bl / 1.0F);
        GL11.glColor4f(1.0F, 1.0F, 1.0F, 1.0F);
    }
}
