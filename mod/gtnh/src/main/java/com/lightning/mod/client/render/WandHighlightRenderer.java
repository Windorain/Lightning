package com.lightning.mod.client.render;

import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.RenderGlobal;
import net.minecraft.client.renderer.entity.RenderManager;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.nbt.NBTTagCompound;
import net.minecraft.util.AxisAlignedBB;
import net.minecraftforge.client.event.RenderWorldLastEvent;

import org.lwjgl.opengl.GL11;

import com.lightning.mod.item.ItemSdeSelectionTool;

import cpw.mods.fml.common.eventhandler.SubscribeEvent;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

@SideOnly(Side.CLIENT)
public class WandHighlightRenderer {

    @SubscribeEvent
    public void onRenderWorldLast(RenderWorldLastEvent event) {
        Minecraft mc = Minecraft.getMinecraft();
        if (mc.thePlayer == null || mc.theWorld == null) return;
        ItemStack held = mc.thePlayer.getHeldItem();
        if (held == null) return;
        Item item = held.getItem();
        if (!(item instanceof ItemSdeSelectionTool)) return;

        NBTTagCompound tag = held.getTagCompound();
        if (tag == null) return;

        double rx = RenderManager.renderPosX;
        double ry = RenderManager.renderPosY;
        double rz = RenderManager.renderPosZ;

        int[] p1 = readPos(tag, "sde_pos1x", "sde_pos1y", "sde_pos1z");
        int[] p2 = readPos(tag, "sde_pos2x", "sde_pos2y", "sde_pos2z");

        GL11.glPushMatrix();
        GL11.glEnable(GL11.GL_BLEND);
        GL11.glBlendFunc(GL11.GL_SRC_ALPHA, GL11.GL_ONE_MINUS_SRC_ALPHA);
        GL11.glDisable(GL11.GL_TEXTURE_2D);
        GL11.glDepthMask(false);
        GL11.glLineWidth(2.0F);

        if (p1 != null) {
            AxisAlignedBB box = singleBlockBox(p1[0], p1[1], p1[2], rx, ry, rz);
            GL11.glColor4f(0.2F, 0.4F, 1.0F, 0.6F);
            RenderGlobal.drawOutlinedBoundingBox(box, 0x3366ff);
        }
        if (p2 != null) {
            AxisAlignedBB box = singleBlockBox(p2[0], p2[1], p2[2], rx, ry, rz);
            GL11.glColor4f(1.0F, 0.2F, 0.2F, 0.6F);
            RenderGlobal.drawOutlinedBoundingBox(box, 0xff3333);
        }
        if (p1 != null && p2 != null) {
            int minX = Math.min(p1[0], p2[0]);
            int minY = Math.min(p1[1], p2[1]);
            int minZ = Math.min(p1[2], p2[2]);
            int maxX = Math.max(p1[0], p2[0]);
            int maxY = Math.max(p1[1], p2[1]);
            int maxZ = Math.max(p1[2], p2[2]);
            AxisAlignedBB aabb = AxisAlignedBB
                .getBoundingBox(minX, minY, minZ, maxX + 1, maxY + 1, maxZ + 1)
                .offset(-rx, -ry, -rz);
            GL11.glColor4f(1.0F, 1.0F, 1.0F, 0.4F);
            RenderGlobal.drawOutlinedBoundingBox(aabb, 0xffffff);
        }

        GL11.glDepthMask(true);
        GL11.glEnable(GL11.GL_TEXTURE_2D);
        GL11.glDisable(GL11.GL_BLEND);
        GL11.glColor4f(1.0F, 1.0F, 1.0F, 1.0F);
        GL11.glPopMatrix();
    }

    private static int[] readPos(NBTTagCompound tag, String kx, String ky, String kz) {
        if (!tag.hasKey(kx) || !tag.hasKey(ky) || !tag.hasKey(kz)) return null;
        return new int[] { tag.getInteger(kx), tag.getInteger(ky), tag.getInteger(kz) };
    }

    private static AxisAlignedBB singleBlockBox(int x, int y, int z, double rx, double ry, double rz) {
        return AxisAlignedBB.getBoundingBox(x, y, z, x + 1, y + 1, z + 1).offset(-rx, -ry, -rz);
    }
}
