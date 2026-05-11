package com.lightning.mod.client.meshcapture;

import java.lang.reflect.Method;
import java.util.Collections;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import net.minecraft.nbt.NBTTagCompound;
import net.minecraft.nbt.NBTTagList;
import net.minecraft.tileentity.TileEntity;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * TileMultipart 未覆写 {@code readFromNBT}，直接调 {@code te.readFromNBT(nbt)} 不会更新
 * parts 的状态（含 facing/orientation）。本工具通过反射迭代 {@code partList}，对每个 part
 * 调用 {@code load(NBTTagCompound)}，再触发 {@code updateRenderCache()} 重建静态/动态缓存。
 * <p>
 * 同时提供 {@link #diagnoseReadFromNbtOverride(TileEntity)}：运行时检测 TE 类是否覆写了
 * {@code readFromNBT}；未覆写的类会有与 TileMultipart 相同的 swap 静默失效风险，
 * 每个类名仅警告一次。
 */
@SideOnly(Side.CLIENT)
public final class MultipartNbtStateUtil {

    private static final String TILE_MULTIPART = "codechicken.multipart.TileMultipart";

    private static volatile boolean resolved;
    private static Class<?> tileMultipartClass;

    /** 已警告过 "readFromNBT 未覆写" 的 TE 类名。 */
    private static final Set<String> DIAGNOSED_READ_NBT_NOT_OVERRIDDEN = Collections
        .newSetFromMap(new ConcurrentHashMap<String, Boolean>());

    private MultipartNbtStateUtil() {}

    public static boolean isTileMultipart(TileEntity te) {
        resolve();
        return tileMultipartClass != null && tileMultipartClass.isInstance(te);
    }

    /**
     * 用 {@code nbt} 中的 parts 数据更新 TE 各 part 的内部状态。
     * {@code te.readFromNBT(nbt)} 已由调用方执行（设置 x/y/z 等基础字段）。
     */
    public static void loadPartStatesFromNbt(TileEntity te, NBTTagCompound nbt) {
        NBTTagList partTags = nbt.getTagList("parts", 10);
        if (partTags == null || partTags.tagCount() == 0) {
            return;
        }
        try {
            Object partList = getPartList(te);
            if (partList == null) {
                return;
            }
            int partCount = seqSize(partList);
            if (partCount == 0) {
                return;
            }
            int limit = Math.min(partCount, partTags.tagCount());
            for (int i = 0; i < limit; i++) {
                Object part = seqApply(partList, i);
                if (part == null) {
                    continue;
                }
                NBTTagCompound partTag = partTags.getCompoundTagAt(i);
                String nbtType = partTag.getString("id");
                String partType = getPartType(part);
                if (partType != null && partType.equals(nbtType)) {
                    invokePartLoad(part, partTag);
                }
            }
            invokeUpdateRenderCache(te);
        } catch (Throwable ignored) {
            /* best-effort */
        }
    }

    /**
     * 检测 {@code te} 的类层级是否覆写了 {@code readFromNBT(NBTTagCompound)}。
     * 若声明类仍为 {@link TileEntity} 本身，说明没有任何子类覆写 —— 此时 swap
     * 与 TileMultipart 为同一模式：{@code readFromNBT} 只写 x/y/z，TE 真实内部态
     * 不会被更新。每个类名仅警告一次。
     */
    public static void diagnoseReadFromNbtOverride(TileEntity te) {
        if (te == null) return;
        String className = te.getClass()
            .getName();
        if (!DIAGNOSED_READ_NBT_NOT_OVERRIDDEN.add(className)) {
            return; // Already diagnosed
        }
        try {
            Method m = te.getClass()
                .getMethod("readFromNBT", NBTTagCompound.class);
            if (m.getDeclaringClass() == TileEntity.class) {
                FMLLog.warning(
                    "[SDE] TE %s does NOT override readFromNBT(NBTTagCompound). "
                        + "TE state swap during mesh capture may be ineffective. "
                        + "If rendering appears stuck on current world state, "
                        + "this TE needs a dedicated state-swap strategy (see MultipartNbtStateUtil pattern).",
                    className);
            }
        } catch (NoSuchMethodException ignored) {
            /* TileEntity always has readFromNBT; shouldn't happen */
        }
    }

    // ---- reflective accessors ----

    private static Object getPartList(TileEntity te) {
        try {
            Method m = te.getClass()
                .getMethod("partList");
            return m.invoke(te);
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static int seqSize(Object seq) {
        try {
            Method m = seq.getClass()
                .getMethod("size");
            return ((Number) m.invoke(seq)).intValue();
        } catch (Throwable ignored) {
            return 0;
        }
    }

    private static Object seqApply(Object seq, int idx) {
        try {
            for (Method m : seq.getClass()
                .getMethods()) {
                if ("apply".equals(m.getName()) && m.getParameterTypes().length == 1) {
                    Class<?> pt = m.getParameterTypes()[0];
                    if (pt == int.class || pt == Integer.class || pt == Object.class) {
                        return m.invoke(seq, Integer.valueOf(idx));
                    }
                }
            }
        } catch (Throwable ignored) {
            /* */
        }
        return null;
    }

    private static String getPartType(Object part) {
        try {
            Method m = part.getClass()
                .getMethod("getType");
            return (String) m.invoke(part);
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static void invokePartLoad(Object part, NBTTagCompound tag) {
        try {
            Method m = findMethodInHierarchy(part.getClass(), "load", NBTTagCompound.class);
            if (m != null) {
                m.invoke(part, tag);
            }
        } catch (Throwable ignored) {
            /* */
        }
    }

    private static void invokeUpdateRenderCache(TileEntity te) {
        try {
            Method m = te.getClass()
                .getMethod("updateRenderCache");
            m.invoke(te);
        } catch (Throwable ignored) {
            /* */
        }
    }

    private static Method findMethodInHierarchy(Class<?> leaf, String name, Class<?>... paramTypes) {
        for (Class<?> c = leaf; c != null && c != Object.class; c = c.getSuperclass()) {
            try {
                Method m = c.getDeclaredMethod(name, paramTypes);
                m.setAccessible(true);
                return m;
            } catch (NoSuchMethodException ignored) {
                /* continue */
            }
        }
        try {
            return leaf.getMethod(name, paramTypes);
        } catch (NoSuchMethodException ignored) {
            return null;
        }
    }

    private static void resolve() {
        if (resolved) {
            return;
        }
        synchronized (MultipartNbtStateUtil.class) {
            if (resolved) {
                return;
            }
            for (ClassLoader cl : new ClassLoader[] { Thread.currentThread()
                .getContextClassLoader(), MultipartNbtStateUtil.class.getClassLoader() }) {
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
}
