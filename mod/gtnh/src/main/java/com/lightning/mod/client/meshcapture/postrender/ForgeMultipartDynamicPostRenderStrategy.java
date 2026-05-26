package com.lightning.mod.client.meshcapture.postrender;

import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.FloatBuffer;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import net.minecraft.client.renderer.Tessellator;
import net.minecraft.tileentity.TileEntity;

import org.lwjgl.BufferUtils;
import org.lwjgl.opengl.GL11;
import org.lwjgl.util.vector.Matrix4f;

import com.lightning.mod.client.meshcapture.TessellatorCaptureState;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 补捕获 {@code TileMultipart.renderDynamic}（与 {@code MultipartRenderer} TESR 一致，只遍历 {@code dynamicCache}）。
 * <p>
 * <strong>前提</strong>：须在<strong>无外层 {@code Tessellator} 绘制中</strong>调用本策略。
 * {@link com.lightning.mod.client.meshcapture.MeshCaptureService} 已在 {@code dispatch} 前对静态批次执行
 * {@code tess.draw()}，否则 PR/FMP 内 {@code CCRenderState#startDrawingInstance} 会触发
 * {@code IllegalStateException: Already tesselating}，与 ClassLoader / Vector3 反射细节无关。
 * <p>
 * 仍用反射：按候选 {@code renderDynamic} 的<strong>第一个参数类型</strong>构造 {@code Vector3}（double/float 构造），以兼容
 * FML 下形参类型与 SDE 可见的 {@code Vector3} 非同一 {@code Class} 的情况。
 */
@SideOnly(Side.CLIENT)
public final class ForgeMultipartDynamicPostRenderStrategy implements MeshCaptureBlockPostRenderStrategy {

    public static final int DEFAULT_PRIORITY = 1000;

    private static final String TILE_MULTIPART = "codechicken.multipart.TileMultipart";
    private static final String CC_RENDER_STATE = "codechicken.lib.render.CCRenderState";

    private static volatile boolean resolved;
    private static Class<?> tileMultipartClass;

    @Override
    public int priority() {
        return DEFAULT_PRIORITY;
    }

    @Override
    public boolean applies(MeshCaptureBlockPostRenderContext ctx) {
        resolve();
        if (tileMultipartClass == null) {
            return false;
        }
        TileEntity te = ctx.getTileEntity();
        return te != null && tileMultipartClass.isInstance(te);
    }

    @Override
    public void renderPostMainBlock(MeshCaptureBlockPostRenderContext ctx) {
        renderDynamicPartsIfMultipart(ctx);
    }

    /** 供更高优先级策略委托：在静态批次已结束后调用。 */
    public static void renderDynamicPartsIfMultipart(MeshCaptureBlockPostRenderContext ctx) {
        resolve();
        if (tileMultipartClass == null) {
            return;
        }
        TileEntity te = ctx.getTileEntity();
        if (te == null || !tileMultipartClass.isInstance(te)) {
            return;
        }
        int wx = ctx.getWx();
        int wy = ctx.getWy();
        int wz = ctx.getWz();
        float frame = ctx.getPartialTicks();

        prepareMultipartDynamicEnvironment(te);
        tryUpdateRenderCache(te);

        Tessellator.instance.setTranslation(0.0, 0.0, 0.0);

        armDynamicPassModelViewBaselineFromCurrentMatrix();

        TessellatorCaptureState.beginDynamicExtensionVertexPhase();
        try {
            if (invokeAnyRenderDynamic3(te, collectRenderDynamic3Methods(te.getClass()), wx, wy, wz, frame, 0)) {
                return;
            }

            boolean anyPart = false;
            for (Object part : iterableParts(te)) {
                if (part == null) {
                    continue;
                }
                anyPart |= invokeAnyRenderDynamic3(
                    part,
                    collectRenderDynamic3Methods(part.getClass()),
                    wx,
                    wy,
                    wz,
                    frame,
                    0);
            }
            if (!anyPart) {
                FMLLog.warning("[SDE] ForgeMultipartDynamic: no renderDynamic succeeded (tile + parts)");
            }
        } finally {
            TessellatorCaptureState.endDynamicExtensionVertexPhase();
        }
    }

    /**
     * 对齐 {@link com.lightning.mod.client.meshcapture.postrender.TileEntitySpecialRendererPostRenderStrategy}：
     * 读取当前 MODELVIEW 并计算逆矩阵作为基线，供 mixin 做 {@code inv(M0) * M_now * v} 变换。
     */
    private static void armDynamicPassModelViewBaselineFromCurrentMatrix() {
        FloatBuffer mv0 = BufferUtils.createFloatBuffer(16);
        GL11.glGetFloat(GL11.GL_MODELVIEW_MATRIX, mv0);
        mv0.rewind();
        Matrix4f mAtEntry = new Matrix4f();
        mAtEntry.load(mv0);
        Matrix4f invEntry = new Matrix4f();
        if (Matrix4f.invert(mAtEntry, invEntry) != null) {
            FloatBuffer invBuf = BufferUtils.createFloatBuffer(16);
            invEntry.store(invBuf);
            invBuf.rewind();
            float[] snapInv = new float[16];
            invBuf.get(snapInv);
            TessellatorCaptureState.armDynamicPassModelViewBaselineInverse(snapInv);
        }
    }

    private static void prepareMultipartDynamicEnvironment(TileEntity te) {
        Class<?> ccrClass = loadClass(
            CC_RENDER_STATE,
            te.getClass()
                .getClassLoader());
        if (ccrClass == null) {
            ccrClass = loadClass(
                CC_RENDER_STATE,
                Thread.currentThread()
                    .getContextClassLoader());
        }
        if (ccrClass == null) {
            ccrClass = loadClass(CC_RENDER_STATE, ForgeMultipartDynamicPostRenderStrategy.class.getClassLoader());
        }
        if (ccrClass == null) {
            FMLLog.warning("[SDE] ForgeMultipartDynamic: CCRenderState class not found");
            return;
        }
        try {
            Object inst = ccrClass.getMethod("instance")
                .invoke(null);
            ccrClass.getMethod("resetInstance")
                .invoke(inst);
            ccrClass.getMethod("pullLightmapInstance")
                .invoke(inst);
            java.lang.reflect.Field useNormals = ccrClass.getField("useNormals");
            useNormals.setBoolean(inst, true);
        } catch (Throwable t) {
            FMLLog.warning("[SDE] ForgeMultipartDynamic: CCRenderState prep failed: %s", t.getMessage());
        }
    }

    private static Class<?> loadClass(String name, ClassLoader cl) {
        if (cl == null) {
            return null;
        }
        try {
            return Class.forName(name, false, cl);
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static void tryUpdateRenderCache(TileEntity te) {
        try {
            Method m = te.getClass()
                .getMethod("updateRenderCache");
            m.invoke(te);
        } catch (Throwable t1) {
            try {
                Method m = te.getClass()
                    .getDeclaredMethod("updateRenderCache");
                m.setAccessible(true);
                m.invoke(te);
            } catch (Throwable ignored) {
                /* */
            }
        }
    }

    private static boolean isRenderDynamic3(Method m) {
        return "renderDynamic".equals(m.getName()) && m.getParameterTypes().length == 3;
    }

    /** 继承链 declared + public 方法，按参数类型签名去重。 */
    private static List<Method> collectRenderDynamic3Methods(Class<?> leaf) {
        Set<String> seen = new LinkedHashSet<>();
        List<Method> out = new ArrayList<>();
        for (Class<?> c = leaf; c != null && c != Object.class; c = c.getSuperclass()) {
            for (Method m : c.getDeclaredMethods()) {
                if (!isRenderDynamic3(m)) {
                    continue;
                }
                m.setAccessible(true);
                String key = renderDynamic3ParamKey(m);
                if (seen.add(key)) {
                    out.add(m);
                }
            }
        }
        for (Method m : leaf.getMethods()) {
            if (!isRenderDynamic3(m)) {
                continue;
            }
            try {
                m.setAccessible(true);
            } catch (Throwable ignored) {
                /* */
            }
            if (seen.add(renderDynamic3ParamKey(m))) {
                out.add(m);
            }
        }
        return out;
    }

    private static String renderDynamic3ParamKey(Method m) {
        Class<?>[] p = m.getParameterTypes();
        StringBuilder sb = new StringBuilder();
        for (Class<?> t : p) {
            sb.append(t.getName())
                .append(';');
        }
        return sb.toString();
    }

    private static boolean invokeAnyRenderDynamic3(Object target, List<Method> methods, int wx, int wy, int wz,
        float frame, int pass) {
        for (Method m : methods) {
            if (tryInvokeRenderDynamic3(m, target, wx, wy, wz, frame, pass)) {
                return true;
            }
        }
        return false;
    }

    private static boolean tryInvokeRenderDynamic3(Method m, Object target, int wx, int wy, int wz, float frame,
        int pass) {
        Class<?>[] p = m.getParameterTypes();
        Object vec = tryNewVector3ForParamType(p[0], wx, wy, wz);
        if (vec == null) {
            return false;
        }
        try {
            Object a1 = coerceSecondArg(frame, p[1]);
            Object a2 = coerceThirdArg(pass, p[2]);
            m.invoke(target, vec, a1, a2);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static Object tryNewVector3ForParamType(Class<?> vecType, int wx, int wy, int wz) {
        double dx = wx;
        double dy = wy;
        double dz = wz;
        try {
            Constructor<?> ctor = vecType.getConstructor(double.class, double.class, double.class);
            return ctor.newInstance(dx, dy, dz);
        } catch (Throwable ignored) {
            /* */
        }
        try {
            Constructor<?> ctor = vecType.getConstructor(float.class, float.class, float.class);
            return ctor.newInstance((float) dx, (float) dy, (float) dz);
        } catch (Throwable ignored) {
            /* */
        }
        return null;
    }

    private static Object coerceSecondArg(float frame, Class<?> type) {
        if (type == float.class || type == Float.class) {
            return frame;
        }
        if (type == double.class || type == Double.class) {
            return (double) frame;
        }
        return Float.valueOf(frame);
    }

    private static Object coerceThirdArg(int pass, Class<?> type) {
        if (type == int.class || type == Integer.class) {
            return pass;
        }
        return Integer.valueOf(pass);
    }

    private static void resolve() {
        if (resolved) {
            return;
        }
        synchronized (ForgeMultipartDynamicPostRenderStrategy.class) {
            if (resolved) {
                return;
            }
            ClassLoader[] loaders = new ClassLoader[] { Thread.currentThread()
                .getContextClassLoader(), ForgeMultipartDynamicPostRenderStrategy.class.getClassLoader(), };
            for (ClassLoader cl : loaders) {
                if (cl == null) {
                    continue;
                }
                try {
                    tileMultipartClass = Class.forName(TILE_MULTIPART, false, cl);
                    break;
                } catch (Throwable ignored) {
                    /* */
                }
            }
            resolved = true;
        }
    }

    private static Iterable<Object> iterableParts(TileEntity te) {
        List<Object> out = new ArrayList<>();
        try {
            Object fromJava = tryInvokeNoArgs(te, "jPartList");
            if (fromJava != null) {
                addAllFromUnknownCollection(out, fromJava);
                if (!out.isEmpty()) {
                    return out;
                }
            }
            Object partList = tryInvokeNoArgs(te, "partList");
            if (partList != null) {
                if (partList instanceof Iterable) {
                    for (Object o : (Iterable<?>) partList) {
                        out.add(o);
                    }
                } else {
                    addAllFromScalaSeq(out, partList);
                }
            }
        } catch (Throwable t) {
            FMLLog.warning("[SDE] ForgeMultipartDynamic: enumerate parts failed: %s", t.getMessage());
        }
        return out;
    }

    private static void addAllFromUnknownCollection(List<Object> out, Object col) {
        if (col instanceof Iterable) {
            for (Object o : (Iterable<?>) col) {
                out.add(o);
            }
            return;
        }
        if (col instanceof Iterator) {
            Iterator<?> it = (Iterator<?>) col;
            while (it.hasNext()) {
                out.add(it.next());
            }
        }
    }

    private static void addAllFromScalaSeq(List<Object> out, Object seq) {
        try {
            Method sizeM = seq.getClass()
                .getMethod("size");
            int n = ((Number) sizeM.invoke(seq)).intValue();
            Method applyM = null;
            for (Method m : seq.getClass()
                .getMethods()) {
                if (!"apply".equals(m.getName()) || m.getParameterTypes().length != 1) {
                    continue;
                }
                Class<?> p = m.getParameterTypes()[0];
                if (p == int.class || p == Integer.class) {
                    applyM = m;
                    break;
                }
            }
            if (applyM == null) {
                return;
            }
            for (int i = 0; i < n; i++) {
                out.add(applyM.invoke(seq, i));
            }
        } catch (Throwable ignored) {
            /* */
        }
    }

    private static Object tryInvokeNoArgs(Object target, String name) {
        try {
            Method m = target.getClass()
                .getMethod(name);
            return m.invoke(target);
        } catch (Throwable ignored) {
            return null;
        }
    }
}
