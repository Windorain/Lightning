package com.lightning.mod.config;

import java.io.File;

import net.minecraftforge.common.config.Configuration;

import cpw.mods.fml.common.event.FMLPreInitializationEvent;

/**
 * 控制面（lightning.controlplane）配置：{@code lightning.cfg} 的 {@code controlplane} 段。
 *
 * <p>
 * 契约见 {@code docs/control-plane/contract.md} §1（第 1–4 条）：
 * <ul>
 * <li><b>默认关闭</b>是硬边界（正式游戏环境不得默认开启）；</li>
 * <li>启用通道有两条，任一即可：配置 {@code controlplane.enabled=true}，或 JVM 属性
 * {@code -Dsde.controlPlane=on}（属性优先，因为外层编排在命令行注入它）；</li>
 * <li>监听默认仅绑回环 {@code 127.0.0.1}，端口默认 23057（工作区的端口分配文件
 * 本树条目已登记）。</li>
 * </ul>
 *
 * <p>
 * 属性取值口径：{@code on/true/1} 强制开启，{@code off/false/0} 强制关闭，其它值（含未设置）
 * 回落到配置项。这样「属性覆盖配置」在两个方向上都成立，且不设置属性时行为完全由 cfg 决定。
 */
public final class SdeControlPlaneConfig {

    /** 配置段名。 */
    public static final String SECTION = "controlplane";

    /** 启用控制面的 JVM 属性名。 */
    public static final String JVM_PROPERTY = "sde.controlPlane";

    /** 契约默认端口（与 {@code core.Contract.DEFAULT_PORT} 同值；此处独立声明避免 config 依赖 core）。 */
    public static final int DEFAULT_PORT = 23057;

    /** 契约默认绑定地址。 */
    public static final String DEFAULT_BIND = "127.0.0.1";

    /** 配置项：是否启用（默认 false）。 */
    public static boolean enabled;

    /** 配置项：首选监听端口（默认 23057）。 */
    public static int port;

    /** 配置项：绑定地址（默认 127.0.0.1）。 */
    public static String bind;

    private SdeControlPlaneConfig() {}

    /** 在 {@code LightningMod.preInit} 调用。 */
    public static void load(FMLPreInitializationEvent event) {
        File cfgFile = event.getSuggestedConfigurationFile();
        Configuration cfg = new Configuration(cfgFile);
        cfg.load();
        enabled = cfg.getBoolean(
            "enabled",
            SECTION,
            false,
            "是否启用常驻 HTTP 控制面（默认关闭；契约 §1 第 1 条要求正式游戏环境不得默认开启）。" + "JVM 属性 -Dsde.controlPlane=on 可覆盖本项。");
        port = cfg.getInt(
            "port",
            SECTION,
            DEFAULT_PORT,
            1,
            65535,
            "控制面首选监听端口（默认 23057）。被占用时按 preferred+1… 回退，上限 128 次；" + "实际绑定端口写入 <mcDataDir>/controlplane/server.json。");
        bind = cfg.getString("bind", SECTION, DEFAULT_BIND, "控制面绑定地址（默认仅回环 127.0.0.1）。绑非回环地址会在启动日志打 WARN（契约 §1 第 3 条）。");
        if (bind == null || bind.trim()
            .isEmpty()) {
            bind = DEFAULT_BIND;
        }
        if (cfg.hasChanged()) {
            cfg.save();
        }
    }

    /**
     * 是否启用（配置 + JVM 属性合并后的结论）。
     *
     * <p>
     * 启动路径必须用本方法判定，不能直读 {@link #enabled}。
     */
    public static boolean isEnabled() {
        Boolean forced = jvmOverride();
        return forced != null ? forced.booleanValue() : enabled;
    }

    /** JVM 属性强制值；未设置或取值不可识别时返回 null（表示「按配置」）。 */
    public static Boolean jvmOverride() {
        String raw = System.getProperty(JVM_PROPERTY);
        if (raw == null) {
            return null;
        }
        String v = raw.trim()
            .toLowerCase(java.util.Locale.ROOT);
        if (v.isEmpty()) {
            return null;
        }
        if ("on".equals(v) || "true".equals(v) || "1".equals(v) || "yes".equals(v)) {
            return Boolean.TRUE;
        }
        if ("off".equals(v) || "false".equals(v) || "0".equals(v) || "no".equals(v)) {
            return Boolean.FALSE;
        }
        return null;
    }

    /** 端口（越界时回落默认值，避免把非法值交给 HttpServer）。 */
    public static int port() {
        return port >= 1 && port <= 65535 ? port : DEFAULT_PORT;
    }

    /** 绑定地址（空值回落回环）。 */
    public static String bind() {
        return bind == null || bind.trim()
            .isEmpty() ? DEFAULT_BIND : bind.trim();
    }
}
