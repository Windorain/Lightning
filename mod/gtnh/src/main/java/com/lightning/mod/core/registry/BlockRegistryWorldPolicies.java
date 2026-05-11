package com.lightning.mod.core.registry;

import java.util.List;

/**
 * 有序手工策略列表（世界采样）；与 {@link com.lightning.mod.client.registry.BlockRegistryPolicies} 顺序须一致
 * （GT：{@link com.lightning.mod.core.registry.gt.GtGregtechRegistryPolicyOrder}；含
 * addon：{@link AddonModsRegistryPolicyOrder}）。
 */
public final class BlockRegistryWorldPolicies {

    private static final List<BlockRegistryWorldPolicy> ALL = AddonModsRegistryPolicyOrder.orderedWorldPolicies();

    private BlockRegistryWorldPolicies() {}

    public static List<BlockRegistryWorldPolicy> all() {
        return ALL;
    }
}
