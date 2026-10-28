package com.lightning.mod.core.registry;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import com.lightning.mod.core.registry.gt.GtBlockClassWorldPolicy;
import com.lightning.mod.core.registry.gt.GtGregtechRegistryPolicyOrder;

/**
 * GT 本体链 + GT 生态 addon（BartWorks 等）世界策略；顺序须与 {@link
 * com.lightning.mod.client.registry.BlockRegistryPolicies} 中 dump 策略一致。
 */
public final class AddonModsRegistryPolicyOrder {

    /** BartWorks 硼玻璃等：{@code bartworks.common.blocks.BWBlocksGlass} */
    public static final GtBlockClassWorldPolicy BARTWORKS_GLASS_WORLD = new GtBlockClassWorldPolicy(
        "bartworks.common.blocks.BWBlocksGlass");

    /** BartWorks：{@code bartworks.common.blocks.BWBlocksGlass2} */
    public static final GtBlockClassWorldPolicy BARTWORKS_GLASS2_WORLD = new GtBlockClassWorldPolicy(
        "bartworks.common.blocks.BWBlocksGlass2");

    private static final List<BlockRegistryWorldPolicy> ORDERED_WORLD;

    static {
        List<BlockRegistryWorldPolicy> m = new ArrayList<>(GtGregtechRegistryPolicyOrder.orderedWorldPolicies());
        m.add(BARTWORKS_GLASS_WORLD);
        m.add(BARTWORKS_GLASS2_WORLD);
        ORDERED_WORLD = Collections.unmodifiableList(m);
    }

    private AddonModsRegistryPolicyOrder() {}

    /**
     * 与客户端 {@code BlockRegistryPolicies} 顺序相同，供
     * {@link com.lightning.mod.core.sampling.PolicyBackedBlockSampler} 使用。
     */
    public static List<BlockRegistryWorldPolicy> orderedWorldPolicies() {
        return ORDERED_WORLD;
    }
}
