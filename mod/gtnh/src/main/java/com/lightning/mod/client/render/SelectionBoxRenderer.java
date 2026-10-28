package com.lightning.mod.client.render;

import net.minecraft.client.renderer.RenderGlobal;
import net.minecraft.client.renderer.entity.RenderManager;
import net.minecraft.util.AxisAlignedBB;
import net.minecraftforge.client.event.RenderWorldLastEvent;

import org.lwjgl.opengl.GL11;

import com.lightning.mod.client.SelectionClientState;
import com.lightning.mod.core.session.SelectionSnapshot;

import cpw.mods.fml.common.eventhandler.SubscribeEvent;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

@SideOnly(Side.CLIENT)
public class SelectionBoxRenderer {

    @SubscribeEvent
    public void onRenderWorldLast(RenderWorldLastEvent event) {
        if (!SelectionClientState.shouldDrawBox()) {
            return;
        }
        SelectionSnapshot s = SelectionClientState.snapshot;
        double rx = RenderManager.renderPosX;
        double ry = RenderManager.renderPosY;
        double rz = RenderManager.renderPosZ;

        AxisAlignedBB aabb = AxisAlignedBB.getBoundingBox(s.minX, s.minY, s.minZ, s.maxX + 1, s.maxY + 1, s.maxZ + 1)
            .offset(-rx, -ry, -rz);

        GL11.glPushMatrix();
        GL11.glEnable(GL11.GL_BLEND);
        GL11.glBlendFunc(GL11.GL_SRC_ALPHA, GL11.GL_ONE_MINUS_SRC_ALPHA);
        GL11.glDisable(GL11.GL_TEXTURE_2D);
        GL11.glDepthMask(false);
        GL11.glColor4f(1.0F, 1.0F, 1.0F, 0.4F);
        GL11.glLineWidth(2.0F);

        RenderGlobal.drawOutlinedBoundingBox(aabb, 0xffffff);

        GL11.glDepthMask(true);
        GL11.glEnable(GL11.GL_TEXTURE_2D);
        GL11.glDisable(GL11.GL_BLEND);
        GL11.glColor4f(1.0F, 1.0F, 1.0F, 1.0F);
        GL11.glPopMatrix();
    }
}
