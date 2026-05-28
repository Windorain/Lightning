package com.lightning.mod.client.export;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.Base64;

import javax.imageio.ImageIO;

import net.minecraft.block.Block;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.entity.RenderItem;
import net.minecraft.client.shader.Framebuffer;
import net.minecraft.init.Blocks;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;

import org.lwjgl.opengl.GL11;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

@SideOnly(Side.CLIENT)
public final class BlockThumbnailRenderer {

    private static final int THUMB_SIZE = 64;
    /**
     * {@link RenderItem} laid out for a 16×16 GUI cell; scale up around canvas center so the model uses ~most of
     * {@link #THUMB_SIZE} without typical clipping.
     */
    private static final float THUMB_DRAW_SCALE = 3.25F;
    private static Framebuffer thumbnailFbo;

    /**
     * Matches inventory / NEI: {@link RenderItem#renderItemAndEffectIntoGUI} → {@link RenderItem#renderItemIntoGUI},
     * including {@code GL_ALPHA_TEST} / blend setup and the vanilla 3D block matrix for {@code renderBlockAsItem}.
     * NEI wraps that in {@code GuiContainerManager#enable3DRender} (lighting + depth).
     * <p>
     * With {@code glOrtho(..., 1000, 3000)} the model-view stack must include the same
     * {@code glTranslatef(0, 0, -2000)} as {@code GuiScreen} before item draws; otherwise 3D
     * quads fall outside the depth range and the FBO stays cleared (fully transparent PNG).
     * <p>
     * Off the main framebuffer, multi-texture lightmap may not be bound or may retain dim coordinates
     * from world rendering, which darkens {@code renderBlockAsItem}. Match inventory brightness by
     * enabling the lightmap and setting coords to full (240/240) before drawing.
     */
    public static String renderToBase64PNG(Block block, int meta) {
        if (block == null || block == Blocks.air) {
            return null;
        }
        Item item = Item.getItemFromBlock(block);
        if (item == null) {
            return null;
        }
        ItemStack stack = new ItemStack(item, 1, meta);
        try {
            Framebuffer fbo = getOrCreateFbo();
            Framebuffer prevFbo = Minecraft.getMinecraft()
                .getFramebuffer();
            Minecraft mc = Minecraft.getMinecraft();

            ByteArrayOutputStream baos = new ByteArrayOutputStream();

            GL11.glPushAttrib(GL11.GL_ALL_ATTRIB_BITS);
            try {
                fbo.bindFramebuffer(true);
                GL11.glViewport(0, 0, THUMB_SIZE, THUMB_SIZE);
                GL11.glClearColor(0, 0, 0, 0);
                GL11.glClear(GL11.GL_COLOR_BUFFER_BIT | GL11.GL_DEPTH_BUFFER_BIT);

                GL11.glMatrixMode(GL11.GL_PROJECTION);
                GL11.glPushMatrix();
                GL11.glLoadIdentity();
                GL11.glOrtho(0, THUMB_SIZE, THUMB_SIZE, 0, 1000, 3000);
                GL11.glMatrixMode(GL11.GL_MODELVIEW);
                GL11.glPushMatrix();
                GL11.glLoadIdentity();
                GL11.glTranslatef(0.0F, 0.0F, -2000.0F);

                float cx = THUMB_SIZE * 0.5F;
                float cy = THUMB_SIZE * 0.5F;
                GL11.glTranslatef(cx, cy, 0.0F);
                GL11.glScalef(THUMB_DRAW_SCALE, THUMB_DRAW_SCALE, THUMB_DRAW_SCALE);
                GL11.glTranslatef(-cx, -cy, 0.0F);

                GL11.glColor4f(1.0F, 1.0F, 1.0F, 1.0F);
                GL11.glEnable(GL11.GL_DEPTH_TEST);
                GL11.glDisable(GL11.GL_LIGHTING);

                RenderItem renderItem = new RenderItem();
                renderItem.zLevel = 0.0F;
                renderItem.renderWithColor = true;
                int slotX = (THUMB_SIZE - 16) / 2;
                int slotY = (THUMB_SIZE - 16) / 2;
                renderItem.renderItemAndEffectIntoGUI(mc.fontRenderer, mc.renderEngine, stack, slotX, slotY);

                GL11.glMatrixMode(GL11.GL_PROJECTION);
                GL11.glPopMatrix();
                GL11.glMatrixMode(GL11.GL_MODELVIEW);
                GL11.glPopMatrix();

                ByteBuffer pixels = ByteBuffer.allocateDirect(THUMB_SIZE * THUMB_SIZE * 4);
                GL11.glReadPixels(0, 0, THUMB_SIZE, THUMB_SIZE, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, pixels);
                pixels.rewind();

                BufferedImage img = new BufferedImage(THUMB_SIZE, THUMB_SIZE, BufferedImage.TYPE_INT_ARGB);
                for (int y = 0; y < THUMB_SIZE; y++) {
                    for (int x = 0; x < THUMB_SIZE; x++) {
                        int idx = (y * THUMB_SIZE + x) * 4;
                        int r = pixels.get(idx) & 0xFF;
                        int g = pixels.get(idx + 1) & 0xFF;
                        int b = pixels.get(idx + 2) & 0xFF;
                        int a = pixels.get(idx + 3) & 0xFF;
                        img.setRGB(x, THUMB_SIZE - 1 - y, (a << 24) | (r << 16) | (g << 8) | b);
                    }
                }
                ImageIO.write(img, "PNG", baos);

                if (prevFbo != null) {
                    prevFbo.bindFramebuffer(true);
                }
            } finally {
                GL11.glPopAttrib();
            }

            return Base64.getEncoder()
                .encodeToString(baos.toByteArray());
        } catch (Exception e) {
            e.printStackTrace();
            return null;
        }
    }

    private static Framebuffer getOrCreateFbo() {
        if (thumbnailFbo == null) {
            thumbnailFbo = new Framebuffer(THUMB_SIZE, THUMB_SIZE, true);
        }
        return thumbnailFbo;
    }

    public static void dispose() {
        if (thumbnailFbo != null) {
            thumbnailFbo.deleteFramebuffer();
            thumbnailFbo = null;
        }
    }
}
