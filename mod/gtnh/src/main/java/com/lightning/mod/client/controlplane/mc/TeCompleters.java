package com.lightning.mod.client.controlplane.mc;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * TE 补全器注册表（按族名查表）。
 *
 * <p>
 * v1 只注册 {@code vanilla}；{@code lp-pipe}/{@code ae2-part} 随锚点场景在 PR-3 交付。
 * 调用方（{@link SceneBuilder}）在查不到时报 {@code CP-VALID-002}，并把可用族名放进
 * {@code context.fields}，让用例作者一次改对。
 */
public final class TeCompleters {

    private static final Map<String, TeCompleter> REGISTRY = new LinkedHashMap<String, TeCompleter>();

    static {
        register(new TeCompleter.VanillaTeCompleter());
    }

    private TeCompleters() {}

    /** 注册补全器（同名覆盖，便于 PR-3 增强默认实现）。 */
    public static synchronized void register(TeCompleter completer) {
        if (completer == null || completer.name() == null
            || completer.name()
                .isEmpty()) {
            throw new IllegalArgumentException("补全器与族名都不能为空");
        }
        REGISTRY.put(completer.name(), completer);
    }

    /** 查补全器；不存在返回 null。 */
    public static synchronized TeCompleter get(String name) {
        return name == null ? null : REGISTRY.get(name);
    }

    /** 是否已注册。 */
    public static synchronized boolean contains(String name) {
        return name != null && REGISTRY.containsKey(name);
    }

    /** 已注册族名（按注册顺序）。 */
    public static synchronized List<String> names() {
        return new ArrayList<String>(REGISTRY.keySet());
    }

    /** 只读视图（诊断用）。 */
    public static synchronized Map<String, TeCompleter> all() {
        return Collections.unmodifiableMap(new LinkedHashMap<String, TeCompleter>(REGISTRY));
    }
}
