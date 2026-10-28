package com.lightning.mod.client.controlplane.mc;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.world.WorldServer;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.CriteriaEngine;

/**
 * TE 描述器注册表（按族名查表）——{@link TeCompleters} 的对偶，与它并列而非合并。
 *
 * <p>
 * 两个注册表分开的理由是<b>职责不同、可用性也不同</b>：补全器只在场景构建期用（写），描述器在判据段
 * 与观测采集期用（读）；将来可能出现「只有描述器、没有补全器」的族（只观察不构建）。族名是两者的接缝，
 * 因此同名约定由 {@link TeDescriber#name()} 的 javadoc 固定。
 *
 * <p>
 * 注册顺序即探测顺序（{@link #describe} 返回第一个认领该 TE 的描述器）——LP/AE2 两族的 TE 类互不相同，
 * 顺序不影响结果，但保持确定性以便复现。
 */
public final class TeDescribers {

    private static final Map<String, TeDescriber> REGISTRY = new LinkedHashMap<String, TeDescriber>();

    private TeDescribers() {}

    /** 注册描述器（同名覆盖）。 */
    public static synchronized void register(TeDescriber describer) {
        if (describer == null || describer.name() == null
            || describer.name()
                .isEmpty()) {
            throw new IllegalArgumentException("描述器与族名都不能为空");
        }
        REGISTRY.put(describer.name(), describer);
    }

    /** 查描述器；不存在返回 null。 */
    public static synchronized TeDescriber get(String name) {
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
    public static synchronized Map<String, TeDescriber> all() {
        return Collections.unmodifiableMap(new LinkedHashMap<String, TeDescriber>(REGISTRY));
    }

    /**
     * 探测式描述：问每个已注册描述器，返回第一个认领该 TE 的结果。
     *
     * <p>
     * 单个描述器抛出异常（模组版本漂移、字段消失）只跳过它并打 WARN，不让整个判据段崩掉——
     * 描述器是观察设施，它的失败不该升级成「用例执行失败」。
     *
     * @return {@code {family, state}}；没有任何描述器认领（或该位置没有 TE）时返回 null
     */
    public static CriteriaEngine.RuntimeTeSource.TeState describe(WorldServer world, int x, int y, int z) {
        for (Map.Entry<String, TeDescriber> e : all().entrySet()) {
            TeDescriber d = e.getValue();
            try {
                JsonObject state = d.describe(world, x, y, z);
                if (state != null) {
                    return new CriteriaEngine.RuntimeTeSource.TeState(d.name(), state);
                }
            } catch (Throwable t) {
                CpLog.warn("TE 描述器 %s 在 %d,%d,%d 上抛错（已跳过）: %s", d.name(), x, y, z, ModReflect.describe(t));
            }
        }
        return null;
    }

    /**
     * 按族名描述（不做探测）：观测记录的场景清单按 {@code te} 步声明的族名取状态。
     *
     * @return 状态对象；该族未注册、位置不是该族 TE 或描述器抛错时返回 null
     */
    public static JsonObject describeByFamily(String family, WorldServer world, int x, int y, int z) {
        TeDescriber d = get(family);
        if (d == null || world == null) {
            return null;
        }
        try {
            return d.describe(world, x, y, z);
        } catch (Throwable t) {
            CpLog.warn("TE 描述器 %s 在 %d,%d,%d 上抛错: %s", family, x, y, z, ModReflect.describe(t));
            return null;
        }
    }
}
