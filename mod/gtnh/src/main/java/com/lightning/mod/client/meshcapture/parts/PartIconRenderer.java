package com.lightning.mod.client.meshcapture.parts;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.Base64;

import javax.imageio.ImageIO;

import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.entity.RenderItem;
import net.minecraft.client.shader.Framebuffer;
import net.minecraft.item.ItemStack;

import org.lwjgl.opengl.GL11;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 部件物品图标离屏渲染器（{@code itemKey → base64 PNG}），供
 * {@link PartExportIntegrator} 把部件物品图标嵌入导出文档（web 统计栏通道 1 纹理源，
 * 键 = 物品身份键 {@code registry:damage[#nbt]}，与 web iconKey 约定一致）。
 *
 * <p>
 * GL 布局与 {@code BlockThumbnailRenderer} 完全一致（同一套 FBO + 正交投影 + RenderItem GUI
 * 路径），差异仅在入口：本类直接接受任意 {@link ItemStack}（AE2 部件物品、导管物品、
 * 微方块物品、drop 身份栈等），不限于方块物品。两个渲染器各持自己的 FBO，互不影响；
 * 本类独立存在于 parts/ 是为了不改动 {@code BlockThumbnailRenderer}（写范围约束）。
 *
 * <p>
 * 绝不抛出：任何渲染失败返回 {@code null}（调用方跳过该键，web 端走回退链）。
 */
@SideOnly(Side.CLIENT)
public final class PartIconRenderer {

    private static final int THUMB_SIZE = 64;
    /** 同 BlockThumbnailRenderer：16×16 GUI 格放大到占满画布。 */
    private static final float THUMB_DRAW_SCALE = 3.25F;
    private static Framebuffer partIconFbo;

    private PartIconRenderer() {}

    /** 渲染物品图标为 base64 PNG；失败返回 null（不中断导出）。 */
    public static String renderToBase64PNG(ItemStack stack) {
        if (stack == null || stack.getItem() == null) {
            return null;
        }
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
        } catch (Throwable t) {
            return null;
        }
    }

    private static Framebuffer getOrCreateFbo() {
        if (partIconFbo == null) {
            partIconFbo = new Framebuffer(THUMB_SIZE, THUMB_SIZE, true);
        }
        return partIconFbo;
    }

    public static void dispose() {
        if (partIconFbo != null) {
            partIconFbo.deleteFramebuffer();
            partIconFbo = null;
        }
    }
}
