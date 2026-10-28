package com.lightning.mod.client.meshcapture.compat;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;

import com.lightning.mod.client.meshcapture.env.TogglePresence;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 捕获窗口内临时拨动批处理渲染层的"原版箱子 TESR 网格缓存"开关。
 * <p>
 * 为什么需要：该层在缓存开启时把原版箱子的模型绘制整段换成缓存网格（{@code VanillaModelMeshes} →
 * {@code AngelicaTesrMeshCache.renderCached}），根本不经过 {@code ModelRenderer.render}——捕获窗口里的
 * {@code @WrapOperation} 因此没有可包的对象。把开关在窗口内拨到 false，缓存路径回落到原版
 * {@code modelchest.render(...)}，几何重新进入 Java/Tessellator 路径；窗口结束（含异常）必须还原。
 * <p>
 * <strong>只在环境事实为 {@link TogglePresence#PRESENT} 时拨动</strong>；{@link TogglePresence#ABSENT} /
 * {@link TogglePresence#UNKNOWN} 一律不碰（一行 INFO 留痕），捕获流程照常走。反射失败、字段改名等情况
 * 同样只降级为"不拨动"，绝不抛异常扩大捕获的失败面。
 * <p>
 * 与 legacy 捕获期删除 display list 同族：只在"录制窗口"这一局部时间把渲染逼回 Java 几何路径，
 * 不改变窗口外的常态渲染。
 */
@SideOnly(Side.CLIENT)
public final class AngelicaChestCacheToggle {

    public static final String TARGET_CLASS = "com.gtnewhorizons.angelica.config.AngelicaConfig";

    public static final String TARGET_FIELD = "enableTESRChestCache";

    private static volatile Field field;

    private static volatile boolean resolved;

    private static volatile boolean skipLogged;

    private static volatile boolean failureLogged;

    private AngelicaChestCacheToggle() {}

    /**
     * 事实允许且开关在场时把它拨到 {@code false}。
     *
     * @return 拨动前是否为 {@code true}（{@code null} = 没有拨动；{@code FALSE} = 本来就是关的，无需还原）
     */
    public static Boolean disableForCapture(TogglePresence presence) {
        if (presence != TogglePresence.PRESENT) {
            logSkipOnce(presence);
            return null;
        }
        Field f = field();
        if (f == null) {
            logFailureOnce("field unavailable");
            return null;
        }
        try {
            boolean wasEnabled = f.getBoolean(null);
            if (!wasEnabled) {
                return Boolean.FALSE;
            }
            f.setBoolean(null, false);
            return Boolean.TRUE;
        } catch (Throwable t) {
            logFailureOnce(String.valueOf(t));
            return null;
        }
    }

    /** 还原 {@link #disableForCapture(TogglePresence)} 的结果；{@code null}/{@code FALSE} 都是 no-op。 */
    public static void restore(Boolean previous) {
        if (previous == null || !previous.booleanValue()) {
            return;
        }
        Field f = field();
        if (f == null) {
            return;
        }
        try {
            f.setBoolean(null, true);
        } catch (Throwable t) {
            logFailureOnce(String.valueOf(t));
        }
    }

    /**
     * 在"关闭缓存"的作用域里执行一段动作：进入时拨动、退出时（含动作抛异常）在 finally 里还原。
     * 单测直接打这条：字段缺失时动作照常执行且不崩；动作抛异常时字段仍被还原。
     */
    public static void runWithCacheDisabled(TogglePresence presence, Runnable action) {
        Boolean previous = disableForCapture(presence);
        try {
            if (action != null) {
                action.run();
            }
        } finally {
            restore(previous);
        }
    }

    private static Field field() {
        if (!resolved) {
            field = resolveField(TARGET_CLASS, TARGET_FIELD);
            resolved = true;
        }
        return field;
    }

    /** 解析一个"公有静态 boolean"字段；类/字段缺失或签名不符一律返回 {@code null}（降级），不抛。 */
    static Field resolveField(String className, String fieldName) {
        try {
            Class<?> target = Class.forName(className, false, AngelicaChestCacheToggle.class.getClassLoader());
            Field f = target.getField(fieldName);
            boolean usable = Modifier.isStatic(f.getModifiers()) && f.getType() == boolean.class;
            if (!usable) {
                return null;
            }
            f.setAccessible(true);
            return f;
        } catch (Throwable t) {
            return null;
        }
    }

    /** 单测专用：注入一个可观察的字段替身。 */
    static void setFieldForTesting(Field f) {
        field = f;
        resolved = true;
    }

    /** 单测专用：回到"从未解析"的状态。 */
    static void resetForTesting() {
        field = null;
        resolved = false;
        skipLogged = false;
        failureLogged = false;
    }

    private static void logSkipOnce(TogglePresence presence) {
        if (skipLogged) {
            return;
        }
        skipLogged = true;
        logInfo(String.format("[SDE][capture] 箱子 TESR 缓存开关不可用（%s），捕获期不做临时拨动", presence));
    }

    private static void logFailureOnce(String detail) {
        if (failureLogged) {
            return;
        }
        failureLogged = true;
        logInfo(String.format("[SDE][capture] 箱子 TESR 缓存开关拨动失败（%s），按不拨动处理", detail));
    }

    private static void logInfo(String line) {
        try {
            FMLLog.info(line);
        } catch (Throwable ignored) {
            // 非 FML 环境（纯 JVM 单测）：日志通道不可用
        }
    }
}
