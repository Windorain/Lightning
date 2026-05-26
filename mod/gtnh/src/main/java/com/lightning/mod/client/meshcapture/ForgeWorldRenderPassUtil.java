package com.lightning.mod.client.meshcapture;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 离屏 {@link net.minecraft.client.renderer.RenderBlocks} 捕获时 Forge 的 world pass 多为 0，而部分方块在
 * pass 1 才画齐：例如 GT5U {@code GTRenderedTexture} 的 overlay；AE2 {@code BlockCableBus} 在开启 AlphaPass 时
 * {@code getRenderBlockPass() == 1} 且 {@code canRenderInPass} 依赖当前 pass。
 * <p>
 * 在 GTNH 下 Angelica 的 {@code @Overwrite getWorldRenderPass()} 委托到 {@code RenderPassHelper}，
 * 后者在主线程读 {@code ForgeHooksClient.worldRenderPass} 字段，在离主线程读 {@code ThreadLocal}。
 * 因此仅反射设置字段可能无效——必须优先使用 {@code RenderPassHelper.setWorldRenderPass()}（若可用），
 * 否则回退到直接字段反射。同时记录最后一次写入的 pass 供 Mixin 拦截使用。
 *
 * @see com.lightning.mod.mixin.mixins.early.minecraft.accessors.MixinForgeHooksClient_WorldRenderPass
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
    /** 记录最后一次通过 {@link #setPass} 写入的值，供 {@link #getLastSetPass} 返回；初始为 -1 表示「从未设置」 */
    private static int lastSetPass = -1;

    // Angelica RenderPassHelper reflection cache
    private static boolean angelicaResolved;
    private static Method angelicaSetMethod;
    private static Method angelicaGetMethod;

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

    private static void resolveAngelica() {
        if (angelicaResolved) {
            return;
        }
        angelicaResolved = true;
        try {
            Class<?> rph = Class.forName("com.gtnewhorizons.angelica.rendering.celeritas.threading.RenderPassHelper");
            angelicaSetMethod = rph.getMethod("setWorldRenderPass", int.class);
            angelicaGetMethod = rph.getMethod("getWorldRenderPass");
        } catch (Throwable ignored) {
            /* Angelica 未安装 */
        }
    }

    public static int getPass() {
        resolve();
        resolveAngelica();
        // Angelica path: RenderPassHelper.getWorldRenderPass() 是权威来源（同时处理主线程字段和 ThreadLocal）
        if (angelicaGetMethod != null) {
            try {
                return (int) angelicaGetMethod.invoke(null);
            } catch (Throwable ignored) {
                /* fall through */
            }
        }
        // Fallback: 直接字段反射
        if (passField == null) {
            return 0;
        }
        try {
            return passField.getInt(null);
        } catch (Throwable ignored) {
            return 0;
        }
    }

    /**
     * 返回 SDE 记录的最后写入的 pass 值（不做反射读）。
     * 供 {@code MixinForgeHooksClient_WorldRenderPass} 在 Angelica 覆写下返回正确值。
     *
     * @return 最后一次 {@link #setPass} 写入的值；-1 表示从未调用过 setPass
     */
    public static int getLastSetPass() {
        return lastSetPass;
    }

    public static void setPass(int pass) {
        resolve();
        resolveAngelica();
        lastSetPass = pass;
        // Angelica path: RenderPassHelper.setWorldRenderPass() 同时更新主线程字段和工作线程 ThreadLocal
        if (angelicaSetMethod != null) {
            try {
                angelicaSetMethod.invoke(null, pass);
                return;
            } catch (Throwable ignored) {
                /* fall through to field reflection */
            }
        }
        // Fallback: 直接字段反射
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
