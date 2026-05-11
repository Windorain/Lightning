package com.lightning.mod.client.meshcapture;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 离屏 {@link net.minecraft.client.renderer.RenderBlocks} 捕获时 Forge的 world pass 多为 0，而部分方块在
 * pass 1 才画齐：例如 GT5U {@code GTRenderedTexture} 的 overlay；AE2 {@code BlockCableBus} 在开启 AlphaPass 时
 * {@code getRenderBlockPass() == 1}且 {@code canRenderInPass} 依赖当前 pass。通过反射读写 Forge 静态字段
 * {@code worldRenderPass}（与 {@code ForgeHooksClient#getWorldRenderPass()} 一致；勿与 {@code renderPass}/
 * {@code setRenderPass} 混淆），可在同一次 Tessellator 批次内先后补画 pass 0 与 1。
 */
@SideOnly(Side.CLIENT)
public final class ForgeWorldRenderPassUtil {

    private enum ResolveState {
        UNRESOLVED,
        ABSENT,
        PRESENT
    }

    /**
     * 必须与 {@code ForgeHooksClient#getWorldRenderPass()} 读写的字段一致（1.7.10 Forge 为 {@code worldRenderPass}）。
     * 不能优先匹配 {@code renderPass}：该字段由 {@code setRenderPass} 使用，与区块多 pass 无关。
     */
    private static final String[] FIELD_CANDIDATES = { "worldRenderPass", "forgeBlockRenderPass", "forgeRenderPass" };

    private static ResolveState state = ResolveState.UNRESOLVED;
    private static Field passField;

    private ForgeWorldRenderPassUtil() {}

    public static boolean canSetPass() {
        resolve();
        return state == ResolveState.PRESENT;
    }

    private static void resolve() {
        if (state != ResolveState.UNRESOLVED) {
            return;
        }
        state = ResolveState.ABSENT;
        try {
            Class<?> fh = Class.forName(
                "net.minecraftforge.client.ForgeHooksClient",
                false,
                ForgeWorldRenderPassUtil.class.getClassLoader());
            for (String n : FIELD_CANDIDATES) {
                Field f = fh.getDeclaredField(n);
                if (Modifier.isStatic(f.getModifiers()) && f.getType() == int.class) {
                    f.setAccessible(true);
                    passField = f;
                    state = ResolveState.PRESENT;
                    return;
                }
            }
        } catch (Throwable ignored) {
            /* 非 Forge 环境或字段更名 */
        }
    }

    public static int getPass() {
        resolve();
        if (passField == null) {
            return 0;
        }
        try {
            return passField.getInt(null);
        } catch (Throwable ignored) {
            return 0;
        }
    }

    public static void setPass(int pass) {
        resolve();
        if (passField == null) {
            return;
        }
        try {
            passField.setInt(null, pass);
        } catch (Throwable ignored) {
            /* ignore */
        }
    }
}
